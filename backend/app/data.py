"""Measured wind-point data enriched with ZETDC GIS assignments."""

from __future__ import annotations

import gzip
import json
import math
from collections import defaultdict
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path

from .wind_energy import enrich_energy_reading, get_wind_energy_settings

DATASET = Path(__file__).resolve().parents[1] / "data" / "wind_points.json.gz"
GIS_DIR = Path(__file__).resolve().parents[1] / "data" / "gis"


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


def _load_dataset():
    if not DATASET.exists():
        raise RuntimeError(
            f"Measured wind dataset is missing: {DATASET}. "
            "Run tools/import_wind_archive.py with the supplied OneDrive archive."
        )
    with gzip.open(DATASET, "rt", encoding="utf-8") as source:
        dataset = json.load(source)
    readings_by_turbine = defaultdict(list)
    capacity_by_id = {station["id"]: station.get("capacity_kw", 2500.0) for station in dataset["stations"]}
    energy_settings = get_wind_energy_settings()
    for reading in dataset["readings"]:
        reading["air_density"] = round(
            air_density_kg_m3(reading.get("temperature"), reading.get("humidity"), reading.get("air_pressure")) or 0.0,
            4,
        )
        enrich_energy_reading(reading, capacity_by_id.get(reading["turbine_id"], 2500.0), settings=energy_settings)
        readings_by_turbine[reading["turbine_id"]].append(reading)
    regions = _gis_features("regions")
    districts = _gis_features("districts")
    assets = []
    for station in dataset["stations"]:
        rows = readings_by_turbine[station["id"]]
        latest = rows[-1]
        latest_at = datetime.fromisoformat(latest["timestamp"])
        recent = [row for row in rows if datetime.fromisoformat(row["timestamp"]) >= latest_at - timedelta(days=1)]
        assets.append(
            {
                **station,
                **_gis_assignment(station["lon"], station["lat"], regions, districts),
                "average_wind_speed": round(sum(row["wind_speed"] for row in recent) / len(recent), 2),
                "latest_wind_speed": latest["wind_speed"],
                "latest_power_output": latest["power_output"],
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


def refresh_energy_calculations():
    settings = get_wind_energy_settings()
    capacity_by_id = {asset["id"]: asset.get("capacity_kw", 2500.0) for asset in TURBINES}
    for reading in ALL_READINGS:
        enrich_energy_reading(reading, capacity_by_id.get(reading["turbine_id"], 2500.0), settings=settings)
    for asset in TURBINES:
        rows = READINGS_BY_TURBINE[asset["id"]]
        if rows:
            asset["latest_power_output"] = rows[-1]["power_output"]
    daily_summaries.cache_clear()
    monthly_history.cache_clear()


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
    entire archive. This keeps the same measured/derived results while reducing
    the 90-day response from tens of thousands of rows to a few hundred.
    """
    fields = (
        "wind_speed", "power_output", "temperature", "humidity", "air_pressure", "air_density",
        "availability_pct", "capacity_factor_pct", "data_quality_pct",
    )
    result = []
    day_count = max(1, min(days, 90))
    for turbine_id, rows in readings_by_turbine.items():
        grouped = defaultdict(list)
        for reading in rows:
            grouped[reading["timestamp"][:10]].append(reading)
        for date_key in sorted(grouped)[-day_count:]:
            day_rows = grouped[date_key]
            item = {
                "turbine_id": turbine_id,
                "date": date_key,
                "records": len(day_rows),
                "energy_produced_mwh": round(sum(row.get("energy_produced_mwh", 0) for row in day_rows), 6),
                "estimated_revenue_usd": round(sum(row.get("estimated_revenue_usd", 0) for row in day_rows), 4),
            }
            for field in fields:
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
        ("wind_speed", "Wind speed", "m/s"),
        ("temperature", "Temperature", "°C"),
        ("humidity", "Humidity", "%"),
        ("air_pressure", "Air pressure", "hPa"),
        ("air_density", "Air density", "kg/m3"),
        ("availability_pct", "Availability", "%"),
        ("data_quality_pct", "Data quality", "%"),
    )
    metric_keys = tuple(item[0] for item in metric_definitions)
    month_totals = defaultdict(lambda: {key: [0.0, 0] for key in metric_keys})
    point_totals = defaultdict(lambda: {key: [0.0, 0] for key in metric_keys})
    day_totals = defaultdict(lambda: {key: [0.0, 0] for key in metric_keys})
    day_point_totals = defaultdict(lambda: {key: [0.0, 0] for key in metric_keys})
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
            month_totals[month_key][metric][0] += value
            month_totals[month_key][metric][1] += 1
            point_totals[point_key][metric][0] += value
            point_totals[point_key][metric][1] += 1
            day_totals[day_key][metric][0] += value
            day_totals[day_key][metric][1] += 1
            day_point_totals[day_point_key][metric][0] += value
            day_point_totals[day_point_key][metric][1] += 1

    names = {asset["id"]: asset["name"] for asset in turbine_assets}

    def averages(totals):
        return {
            metric: round(total / count, 4) if count else None
            for metric, (total, count) in totals.items()
        }

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
            for key, label, unit in metric_definitions
        ],
        "months": months,
    }


@lru_cache(maxsize=1)
def monthly_history():
    return monthly_history_for(ALL_READINGS, TURBINES)
