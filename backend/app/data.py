"""Measured wind-point data enriched with ZETDC GIS assignments."""

from __future__ import annotations

import gzip
import json
import math
from collections import defaultdict
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path

DATASET = Path(__file__).resolve().parents[1] / "data" / "wind_points.json.gz"
GIS_DIR = Path(__file__).resolve().parents[1] / "data" / "gis"

# The source archive previously contained formula-derived generation fields.
# Keep those implementation details out of the active wind-measurement model;
# the dormant formula itself remains in wind_energy.py for later use.
DERIVED_ENERGY_FIELDS = {
    "power_output",
    "energy_produced_mwh",
    "expected_energy_mwh",
    "estimated_revenue_usd",
    "capacity_factor_pct",
    "generation_source",
    "revenue_source",
    "energy_formula",
    "rotor_swept_area_m2",
}
DERIVED_ASSET_FIELDS = {"capacity_kw", "capacity_basis", "model", "generation_source"}


def wind_speed_stddev(values):
    """Return population standard deviation for the available wind samples."""
    present = [float(value) for value in values if value is not None]
    if not present:
        return None
    centre = sum(present) / len(present)
    return math.sqrt(sum((value - centre) ** 2 for value in present) / len(present))


def pooled_wind_speed_stddev(readings):
    """Pool optional interval variance with variance between interval means."""
    present = [reading for reading in readings if reading.get("wind_speed") is not None]
    if not present:
        return None
    centre = sum(float(reading["wind_speed"]) for reading in present) / len(present)
    variance = sum(
        float(reading.get("wind_speed_stddev") or 0.0) ** 2
        + (float(reading["wind_speed"]) - centre) ** 2
        for reading in present
    ) / len(present)
    return math.sqrt(max(0.0, variance))


def air_density_kg_m3(temperature_c, humidity_pct, air_pressure_hpa):
    """Calculate moist-air density from measured temperature, RH, and pressure."""
    if temperature_c is None or humidity_pct is None or air_pressure_hpa is None:
        return None
    temperature_k = float(temperature_c) + 273.15
    pressure_pa = float(air_pressure_hpa) * 100.0
    if temperature_k <= 0 or pressure_pa <= 0:
        return None
    relative_humidity = max(0.0, min(100.0, float(humidity_pct))) / 100.0
    saturation_vapor_pressure_pa = 6.112 * math.exp((17.67 * float(temperature_c)) / (float(temperature_c) + 243.5)) * 100.0
    vapor_pressure_pa = relative_humidity * saturation_vapor_pressure_pa
    dry_air_pressure_pa = pressure_pa - vapor_pressure_pa
    return dry_air_pressure_pa / (287.05 * temperature_k) + vapor_pressure_pa / (461.495 * temperature_k)


def _point_in_ring(point, ring):
    x, y = point
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y):
            crossing = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < crossing:
                inside = not inside
    return inside


def _point_in_geometry(point, geometry):
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return any(
        _point_in_ring(point, polygon[0])
        and not any(_point_in_ring(point, hole) for hole in polygon[1:])
        for polygon in polygons
    )


@lru_cache(maxsize=2)
def _gis_features(name):
    with (GIS_DIR / f"zetdc-{name}.geojson").open() as source:
        return json.load(source)["features"]


def _gis_name(value):
    acronyms = {"BYO", "HR"}
    return " ".join(word if word in acronyms else word.title() for word in value.split())


def _gis_assignment(longitude, latitude, regions, districts):
    point = (longitude, latitude)
    region = next((feature for feature in regions if _point_in_geometry(point, feature["geometry"])), None)
    district = next((feature for feature in districts if _point_in_geometry(point, feature["geometry"])), None)
    region_properties = region["properties"] if region else {}
    district_properties = district["properties"] if district else {}
    return {
        "region": _gis_name(region_properties.get("province", "UNASSIGNED REGION")),
        "region_code": region_properties.get("prov_code", ""),
        "region_centre": region_properties.get("centre", ""),
        "district": _gis_name(district_properties.get("name", "UNASSIGNED DISTRICT")),
        "district_code": district_properties.get("code", ""),
        "district_parent_code": district_properties.get("parentcode", ""),
    }


@lru_cache(maxsize=4096)
def gis_assignment(longitude: float, latitude: float) -> dict:
    """Return the ZETDC region and district containing a WGS84 point."""
    return _gis_assignment(
        float(longitude),
        float(latitude),
        _gis_features("regions"),
        _gis_features("districts"),
    )


def _load_dataset():
    if not DATASET.exists():
        raise RuntimeError(
            f"Measured wind dataset is missing: {DATASET}. "
            "Run tools/import_wind_archive.py with the supplied OneDrive archive."
        )
    with gzip.open(DATASET, "rt", encoding="utf-8") as source:
        dataset = json.load(source)
    readings_by_turbine = defaultdict(list)
    for reading in dataset["readings"]:
        for field in DERIVED_ENERGY_FIELDS:
            reading.pop(field, None)
        reading["air_density"] = round(
            air_density_kg_m3(reading.get("temperature"), reading.get("humidity"), reading.get("air_pressure")) or 0.0,
            4,
        )
        readings_by_turbine[reading["turbine_id"]].append(reading)
    regions = _gis_features("regions")
    districts = _gis_features("districts")
    assets = []
    for station in dataset["stations"]:
        rows = readings_by_turbine[station["id"]]
        latest = rows[-1]
        latest_at = datetime.fromisoformat(latest["timestamp"])
        recent = [row for row in rows if datetime.fromisoformat(row["timestamp"]) >= latest_at - timedelta(days=1)]
        recent_winds = [row.get("wind_speed") for row in recent]
        assets.append(
            {
                **{key: value for key, value in station.items() if key not in DERIVED_ASSET_FIELDS},
                **_gis_assignment(station["lon"], station["lat"], regions, districts),
                "average_wind_speed": round(sum(recent_winds) / len(recent_winds), 2),
                "wind_speed_stddev": round(pooled_wind_speed_stddev(recent) or 0.0, 2),
                "latest_wind_speed": latest["wind_speed"],
                "minimum_wind_speed": round(min(row.get("wind_speed_min", row["wind_speed"]) for row in recent), 2),
                "maximum_wind_speed": round(max(row.get("wind_speed_max", row["wind_speed"]) for row in recent), 2),
                "latest_wind_direction": latest["wind_direction"],
                "latest_temperature": latest["temperature"],
                "latest_humidity": latest["humidity"],
                "latest_air_pressure": latest["air_pressure"],
                "latest_air_density": latest["air_density"],
            }
        )
    return assets, dataset["readings"], dataset["source"]


TURBINES, ALL_READINGS, DATA_SOURCE = _load_dataset()
READINGS_BY_TURBINE = defaultdict(list)
for reading in ALL_READINGS:
    READINGS_BY_TURBINE[reading["turbine_id"]].append(reading)


def turbines():
    return [dict(asset) for asset in TURBINES]


def recent_readings(days: int):
    """Return each point's own latest N-day window.

    The supplied folders stop on different dates, so a single fleet-wide cutoff
    would incorrectly hide valid data from the points whose exports ended first.
    """
    window = timedelta(days=max(1, min(days, 90)))
    result = []
    for rows in READINGS_BY_TURBINE.values():
        latest = datetime.fromisoformat(rows[-1]["timestamp"])
        cutoff = latest - window
        result.extend(reading for reading in rows if datetime.fromisoformat(reading["timestamp"]) >= cutoff)
    return sorted(result, key=lambda item: (item["timestamp"], item["turbine_id"]))


def daily_summaries_for(readings_by_turbine, days: int):
    """Return compact per-point daily aggregates for interactive analytics.

    Sending raw 10-minute logger samples made the analytics screens download the
    entire archive. This keeps the same measured results while reducing
    the 90-day response from tens of thousands of rows to a few hundred.
    """
    average_fields = (
        "wind_speed", "temperature", "humidity", "air_pressure", "air_density",
        "availability_pct", "data_quality_pct",
    )
    result = []
    day_count = max(1, min(days, 90))
    for turbine_id, rows in readings_by_turbine.items():
        grouped = defaultdict(list)
        for reading in rows:
            grouped[reading["timestamp"][:10]].append(reading)
        for date_key in sorted(grouped)[-day_count:]:
            day_rows = grouped[date_key]
            minimums = [row.get("wind_speed_min", row.get("wind_speed")) for row in day_rows]
            maximums = [row.get("wind_speed_max", row.get("wind_speed")) for row in day_rows]
            directions = [row.get("wind_direction") for row in day_rows if row.get("wind_direction") is not None]
            direction_sin = sum(math.sin(math.radians(value)) for value in directions)
            direction_cos = sum(math.cos(math.radians(value)) for value in directions)
            item = {
                "turbine_id": turbine_id,
                "date": date_key,
                "records": len(day_rows),
                "wind_speed_stddev": round(pooled_wind_speed_stddev(day_rows) or 0.0, 6),
                "wind_speed_min": round(min(value for value in minimums if value is not None), 6),
                "wind_speed_max": round(max(value for value in maximums if value is not None), 6),
                "wind_direction": round(math.degrees(math.atan2(direction_sin, direction_cos)) % 360, 6) if directions else None,
            }
            for field in average_fields:
                values = [row[field] for row in day_rows if row.get(field) is not None]
                item[field] = round(sum(values) / len(values), 6) if values else None
            result.append(item)
    return sorted(result, key=lambda item: (item["date"], item["turbine_id"]))


@lru_cache(maxsize=4)
def daily_summaries(days: int):
    return daily_summaries_for(READINGS_BY_TURBINE, days)


def monthly_history_for(readings, turbine_assets):
    """Return compact full-archive monthly metrics for the History workspace."""
    metric_definitions = (
        ("wind_speed", "Average wind speed", "m/s", "mean"),
        ("wind_speed_min", "Minimum wind speed", "m/s", "min"),
        ("wind_speed_max", "Maximum wind speed", "m/s", "max"),
        ("wind_direction", "Wind direction", "°", "circular"),
        ("temperature", "Temperature", "°C", "mean"),
        ("humidity", "Humidity", "%", "mean"),
        ("air_pressure", "Air pressure", "hPa", "mean"),
        ("air_density", "Air density", "kg/m3", "mean"),
        ("availability_pct", "Availability", "%", "mean"),
        ("data_quality_pct", "Data quality", "%", "mean"),
    )
    metric_keys = tuple(item[0] for item in metric_definitions)
    metric_modes = {key: mode for key, _, _, mode in metric_definitions}
    month_totals = defaultdict(lambda: {key: [] for key in metric_keys})
    point_totals = defaultdict(lambda: {key: [] for key in metric_keys})
    day_totals = defaultdict(lambda: {key: [] for key in metric_keys})
    day_point_totals = defaultdict(lambda: {key: [] for key in metric_keys})
    month_records = defaultdict(int)
    point_records = defaultdict(int)
    day_records = defaultdict(int)
    day_point_records = defaultdict(int)
    month_points = defaultdict(set)
    day_points = defaultdict(set)
    month_range = {}

    for reading in readings:
        month_key = reading["timestamp"][:7]
        day_key = reading["timestamp"][:10]
        turbine_id = reading["turbine_id"]
        point_key = (month_key, turbine_id)
        day_point_key = (day_key, turbine_id)
        month_records[month_key] += 1
        point_records[point_key] += 1
        day_records[day_key] += 1
        day_point_records[day_point_key] += 1
        month_points[month_key].add(turbine_id)
        day_points[day_key].add(turbine_id)
        first, last = month_range.get(month_key, (reading["timestamp"], reading["timestamp"]))
        month_range[month_key] = (min(first, reading["timestamp"]), max(last, reading["timestamp"]))
        for metric in metric_keys:
            value = reading.get(metric)
            if value is None:
                continue
            month_totals[month_key][metric].append(value)
            point_totals[point_key][metric].append(value)
            day_totals[day_key][metric].append(value)
            day_point_totals[day_point_key][metric].append(value)

    names = {asset["id"]: asset["name"] for asset in turbine_assets}

    def averages(totals):
        result = {}
        for metric, values in totals.items():
            if not values:
                result[metric] = None
            elif metric_modes[metric] == "min":
                result[metric] = round(min(values), 4)
            elif metric_modes[metric] == "max":
                result[metric] = round(max(values), 4)
            elif metric_modes[metric] == "circular":
                sine = sum(math.sin(math.radians(value)) for value in values)
                cosine = sum(math.cos(math.radians(value)) for value in values)
                result[metric] = round(math.degrees(math.atan2(sine, cosine)) % 360, 4)
            else:
                result[metric] = round(sum(values) / len(values), 4)
        return result

    months = []
    for month_key in sorted(month_totals):
        year, month = (int(part) for part in month_key.split("-"))
        points = [
            {
                "turbine_id": turbine_id,
                "name": names[turbine_id],
                "records": point_records[(month_key, turbine_id)],
                "metrics": averages(point_totals[(month_key, turbine_id)]),
            }
            for turbine_id in sorted(month_points[month_key])
        ]
        days = [
            {
                "date": day_key,
                "day": int(day_key[-2:]),
                "records": day_records[day_key],
                "wind_points": len(day_points[day_key]),
                "metrics": averages(day_totals[day_key]),
                "points": [
                    {
                        "turbine_id": turbine_id,
                        "name": names[turbine_id],
                        "records": day_point_records[(day_key, turbine_id)],
                        "metrics": averages(day_point_totals[(day_key, turbine_id)]),
                    }
                    for turbine_id in sorted(day_points[day_key])
                ],
            }
            for day_key in sorted(day_totals)
            if day_key.startswith(month_key)
        ]
        months.append({
            "key": month_key,
            "year": year,
            "month": month,
            "records": month_records[month_key],
            "wind_points": len(month_points[month_key]),
            "first_reading_at": month_range[month_key][0],
            "last_reading_at": month_range[month_key][1],
            "metrics": averages(month_totals[month_key]),
            "points": points,
            "days": days,
        })

    return {
        "years": sorted({month["year"] for month in months}),
        "wind_points": [
            {"turbine_id": asset["id"], "name": asset["name"]}
            for asset in sorted(turbine_assets, key=lambda item: item["name"])
        ],
        "metrics": [
            {"key": key, "label": label, "unit": unit}
            for key, label, unit, _ in metric_definitions
        ],
        "months": months,
    }


@lru_cache(maxsize=1)
def monthly_history():
    return monthly_history_for(ALL_READINGS, TURBINES)


@lru_cache(maxsize=1)
def latest_reported_month():
    """Return the most recent month containing mast observations.

    Build only the latest month here. The complete History archive is much
    larger and should be assembled only when the History page requests it.
    """
    if not ALL_READINGS:
        return None
    latest_key = max(reading["timestamp"][:7] for reading in ALL_READINGS)
    months = monthly_history_for(
        (reading for reading in ALL_READINGS if reading["timestamp"].startswith(latest_key)),
        TURBINES,
    )["months"]
    return months[-1] if months else None
