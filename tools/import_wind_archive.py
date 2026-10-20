#!/usr/bin/env python3
"""Normalize the eight supplied wind-data folders for the WTMS API.

The source CSVs contain mast measurements but no GPS coordinates, turbine model,
or nameplate capacity. Those values therefore live in STATIONS below as explicit,
editable configuration. Measured values and derived values are labelled in the
generated dataset so the API does not imply that estimated generation is SCADA.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


CAT = timezone(timedelta(hours=2))
EXPECTED_FOLDERS = {
    "chivui",
    "Dave",
    "Dickson",
    "Dotito",
    "mangwe",
    "Mt Darwin",
    "Plumtree",
    "Vungui",
}

# Windographer exports have used both of these top-level folder names. Keep the
# accepted roots explicit so unrelated CSVs in an archive cannot be imported as
# telemetry by accident.
ARCHIVE_ROOTS = {"Zimbabwe RAW Wind Data", "Wind data"}

# The source archive has no spatial or nameplate metadata. Spatial coordinates
# come from backend/data/wind_sites.csv and are joined through these explicit
# aliases. Nameplate capacity remains a clearly-labelled assumption.
STATIONS = {
    "chivui": {
        "name": "Chivui Wind Point",
        "locality": "Chivhu (Marondamashanu)",
        "province": "Mashonaland East",
        "coordinate_name": "CHIVHU(MARONDAMASHANU)",
    },
    "Dave": {
        "name": "Dave Wind Point",
        "locality": "Guruve",
        "province": "Mashonaland Central",
        "coordinate_name": "GURUVE(DAVE)",
    },
    "Dickson": {
        "name": "Dickson Wind Point",
        "locality": "Guruve",
        "province": "Mashonaland Central",
        "coordinate_name": "GURUVE(DICKSON)",
    },
    "Dotito": {
        "name": "Dotito Wind Point",
        "locality": "Dotito",
        "province": "Mashonaland Central",
        "coordinate_name": "DOTITO",
    },
    "mangwe": {
        "name": "Mangwe Wind Point",
        "locality": "Mangwe",
        "province": "Matabeleland South",
        "coordinate_name": "MANGWE",
    },
    "Mt Darwin": {
        "name": "Mt Darwin Wind Point",
        "locality": "Chiswiti",
        "province": "Mashonaland Central",
        "coordinate_name": "CHISWITI",
    },
    "Plumtree": {
        "name": "Plumtree Wind Point",
        "locality": "Bulilima",
        "province": "Matabeleland South",
        "coordinate_name": "BULILIMA",
    },
    "Vungui": {
        "name": "Vungui Wind Point",
        "locality": "Vungu",
        "province": "Midlands",
        "coordinate_name": "VUNGU",
    },
}

CAPACITY_KW = 2500.0


def _number(value: str | None) -> float | None:
    if value is None:
        return None
    value = value.strip()
    if not value or value == "---":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _mean(values: list[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    return sum(present) / len(present) if present else None


def _circular_mean(values: list[float | None]) -> float | None:
    present = [math.radians(value) for value in values if value is not None]
    if not present:
        return None
    angle = math.degrees(math.atan2(sum(math.sin(v) for v in present), sum(math.cos(v) for v in present)))
    return angle % 360


def _power_curve(wind_speed: float) -> float:
    """Estimated output for the configured assessment turbine, in kW."""
    cut_in, rated, cut_out = 3.0, 12.0, 25.0
    if wind_speed < cut_in or wind_speed >= cut_out:
        return 0.0
    if wind_speed >= rated:
        return CAPACITY_KW
    fraction = (wind_speed**3 - cut_in**3) / (rated**3 - cut_in**3)
    return CAPACITY_KW * max(0.0, min(1.0, fraction))


def _air_density(temperature_c: float | None, humidity_pct: float | None, air_pressure_hpa: float | None) -> float | None:
    if temperature_c is None or humidity_pct is None or air_pressure_hpa is None:
        return None
    temperature_k = temperature_c + 273.15
    pressure_pa = air_pressure_hpa * 100.0
    if temperature_k <= 0 or pressure_pa <= 0:
        return None
    relative_humidity = max(0.0, min(100.0, humidity_pct)) / 100.0
    saturation_vapor_pressure_pa = 6.112 * math.exp((17.67 * temperature_c) / (temperature_c + 243.5)) * 100.0
    vapor_pressure_pa = relative_humidity * saturation_vapor_pressure_pa
    dry_air_pressure_pa = pressure_pa - vapor_pressure_pa
    return dry_air_pressure_pa / (287.05 * temperature_k) + vapor_pressure_pa / (461.495 * temperature_k)


def _logger_id(filename: str) -> str:
    return PurePosixPath(filename).name.split("_", 1)[0]


def _folder(filename: str) -> str | None:
    parts = PurePosixPath(filename).parts
    if len(parts) >= 3 and parts[0] in ARCHIVE_ROOTS and filename.lower().endswith(".csv"):
        return parts[1]
    return None


def _site_coordinates(site_path: Path) -> dict[str, tuple[float, float]]:
    with site_path.open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    coordinates = {
        row["Name"].strip().upper(): (float(row["X"]), float(row["Y"]))
        for row in rows
    }
    expected = {station["coordinate_name"] for station in STATIONS.values()}
    if set(coordinates) != expected:
        missing = sorted(expected - set(coordinates))
        unexpected = sorted(set(coordinates) - expected)
        raise ValueError(f"Coordinate file does not match the eight configured sites; missing={missing}, unexpected={unexpected}")
    return coordinates


def _reading(row: dict[str, str], turbine_id: int) -> dict | None:
    try:
        observed = datetime.strptime(row["Date/time"].strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=CAT)
    except (KeyError, ValueError):
        return None

    columns = [key for key in row if key is not None]
    wind_avg_columns = [key for key in columns if key.endswith(";wind_speed;Avg")]
    wind_min_columns = [key for key in columns if key.endswith(";wind_speed;Min")]
    wind_max_columns = [key for key in columns if key.endswith(";wind_speed;Max")]
    wind_count_columns = [key for key in columns if key.endswith(";wind_speed;Count")]
    direction_columns = [key for key in columns if key.endswith(";wind_direction;Avg")]
    temperature_columns = [key for key in columns if key.endswith(";temperature;Avg")]
    humidity_columns = [key for key in columns if key.endswith(";humidity;Avg")]
    pressure_columns = [key for key in columns if key.endswith(";air_pressure;Avg")]

    # Source values are recorded in centimetres per second; expose SI m/s.
    wind_values = [_number(row.get(key)) for key in wind_avg_columns]
    wind_speed_raw = _mean(wind_values)
    if wind_speed_raw is None:
        return None
    wind_speed = wind_speed_raw / 100.0
    minimums = [_number(row.get(key)) for key in wind_min_columns]
    maximums = [_number(row.get(key)) for key in wind_max_columns]
    sample_counts = [_number(row.get(key)) for key in wind_count_columns]
    quality = _mean([min(value / 600.0, 1.0) * 100 if value is not None else None for value in sample_counts]) or 0.0
    power_output = _power_curve(wind_speed)
    interval_energy = power_output / 1000.0 / 6.0
    temperature = _mean([_number(row.get(key)) for key in temperature_columns]) or 0.0
    humidity = _mean([_number(row.get(key)) for key in humidity_columns]) or 0.0
    air_pressure = _mean([_number(row.get(key)) for key in pressure_columns]) or 0.0

    return {
        "turbine_id": turbine_id,
        "timestamp": observed.isoformat(),
        "wind_speed": round(wind_speed, 3),
        "wind_speed_min": round(min(value for value in minimums if value is not None) / 100.0, 3) if any(value is not None for value in minimums) else None,
        "wind_speed_max": round(max(value for value in maximums if value is not None) / 100.0, 3) if any(value is not None for value in maximums) else None,
        "wind_direction": round(_circular_mean([_number(row.get(key)) for key in direction_columns]) or 0.0, 2),
        "temperature": round(temperature, 2),
        "humidity": round(humidity, 2),
        "air_pressure": round(air_pressure, 2),
        "air_density": round(_air_density(temperature, humidity, air_pressure) or 0.0, 4),
        "power_output": round(power_output, 2),
        "energy_produced_mwh": round(interval_energy, 6),
        "expected_energy_mwh": round(interval_energy, 6),
        "estimated_revenue_usd": round(interval_energy * 82.0, 4),
        "availability_pct": round(quality, 2),
        "capacity_factor_pct": round(power_output / CAPACITY_KW * 100, 2),
        "data_quality_pct": round(quality, 2),
        "measurement_source": "mast",
        "generation_source": "derived_power_curve",
        "revenue_source": "derived at configured USD 82/MWh",
    }


def import_archive(archive_path: Path, site_path: Path) -> dict:
    station_rows: dict[str, dict[str, dict]] = defaultdict(dict)
    loggers: dict[str, set[str]] = defaultdict(set)
    files: dict[str, int] = defaultdict(int)

    coordinates = _site_coordinates(site_path)
    with ZipFile(archive_path) as archive:
        csv_names = sorted(name for name in archive.namelist() if _folder(name))
        folders = {_folder(name) for name in csv_names}
        if folders != EXPECTED_FOLDERS:
            missing = sorted(EXPECTED_FOLDERS - folders)
            unexpected = sorted(folders - EXPECTED_FOLDERS)
            raise ValueError(f"Expected exactly the eight configured folders; missing={missing}, unexpected={unexpected}")

        station_ids = {folder: index for index, folder in enumerate(sorted(EXPECTED_FOLDERS, key=str.casefold), 1)}
        for name in csv_names:
            folder = _folder(name)
            assert folder is not None
            files[folder] += 1
            loggers[folder].add(_logger_id(name))
            with archive.open(name) as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
                for row in csv.DictReader(text):
                    reading = _reading(row, station_ids[folder])
                    if reading:
                        station_rows[folder][reading["timestamp"]] = reading

    stations = []
    readings = []
    for folder in sorted(EXPECTED_FOLDERS, key=str.casefold):
        turbine_id = station_ids[folder]
        rows = sorted(station_rows[folder].values(), key=lambda item: item["timestamp"])
        if not rows:
            raise ValueError(f"No valid readings found for {folder}")
        readings.extend(rows)
        configuration = STATIONS[folder]
        latitude, longitude = coordinates[configuration["coordinate_name"]]
        latest = rows[-1]
        status = "operational" if latest["data_quality_pct"] >= 80 else "maintenance"
        shared_loggers = sorted(
            other_folder
            for other_folder, other_loggers in loggers.items()
            if other_folder != folder and loggers[folder].intersection(other_loggers)
        )
        stations.append(
            {
                "id": turbine_id,
                "source_id": ", ".join(sorted(loggers[folder])),
                "source_folder": folder,
                "name": configuration["name"],
                "province": configuration["province"],
                "source_district": configuration["locality"],
                "locality": configuration["locality"],
                "lat": latitude,
                "lon": longitude,
                "location_basis": f"Supplied coordinate file: {site_path.name} ({configuration['coordinate_name']})",
                "capacity_kw": CAPACITY_KW,
                "capacity_basis": "Configured assessment-turbine assumption; not supplied by source",
                "model": "2.5 MW assessment turbine (assumed)",
                "status": status,
                "synthetic": False,
                "telemetry_source": "measured wind mast",
                "generation_source": "derived power curve",
                "first_reading_at": rows[0]["timestamp"],
                "last_reading_at": rows[-1]["timestamp"],
                "reading_count": len(rows),
                "source_file_count": files[folder],
                "shared_logger_folders": shared_loggers,
            }
        )

    readings.sort(key=lambda item: (item["timestamp"], item["turbine_id"]))
    checksum = hashlib.sha256()
    with archive_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    return {
        "source": {
            "archive": archive_path.name,
            "coordinate_file": site_path.name,
            "sha256": checksum.hexdigest(),
            "folder_count": len(stations),
            "csv_file_count": sum(files.values()),
            "wind_speed_conversion": "source centimetres/second divided by 100 to metres/second",
        },
        "stations": stations,
        "readings": readings,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument(
        "--sites",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "backend" / "data" / "wind_sites.csv",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "backend" / "data" / "wind_points.json.gz",
    )
    args = parser.parse_args()
    dataset = import_archive(args.archive, args.sites)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.output, "wt", encoding="utf-8", compresslevel=9) as target:
        json.dump(dataset, target, separators=(",", ":"), allow_nan=False)
    print(
        f"Imported {len(dataset['stations'])} points, {len(dataset['readings'])} readings, "
        f"and {dataset['source']['csv_file_count']} CSV files to {args.output}"
    )


if __name__ == "__main__":
    main()
