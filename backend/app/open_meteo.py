"""Open-Meteo live wind cache kept separate from ZETDC mast observations."""

from __future__ import annotations

import json
import math
import tempfile
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from .data import air_density_kg_m3, wind_speed_stddev


CACHE_PATH = Path(__file__).resolve().parents[1] / "data" / "open_meteo_live_wind.json"
CAT = timezone(timedelta(hours=2))
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
HOURLY = "wind_speed_10m,wind_direction_10m,temperature_2m,relative_humidity_2m,surface_pressure"
LIVE_CACHE_VERSION = 2
LIVE_HISTORY_DAYS = 92
LIVE_FORECAST_DAYS = 16
LIVE_ARCHIVE_RETENTION_DAYS = 730

# Provincial capitals provide a stable, recognisable reference location for
# the national live-model comparison. These are deliberately separate from
# the eight mast coordinates so every administrative province is represented.
PROVINCE_LOCATIONS = (
    {"province": "Bulawayo", "location": "Bulawayo", "latitude": -20.1500, "longitude": 28.5833},
    {"province": "Harare", "location": "Harare", "latitude": -17.8292, "longitude": 31.0522},
    {"province": "Manicaland", "location": "Mutare", "latitude": -18.9707, "longitude": 32.6709},
    {"province": "Mashonaland Central", "location": "Bindura", "latitude": -17.3019, "longitude": 31.3306},
    {"province": "Mashonaland East", "location": "Marondera", "latitude": -18.1853, "longitude": 31.5519},
    {"province": "Mashonaland West", "location": "Chinhoyi", "latitude": -17.3667, "longitude": 30.2000},
    {"province": "Masvingo", "location": "Masvingo", "latitude": -20.0744, "longitude": 30.8328},
    {"province": "Matabeleland North", "location": "Lupane", "latitude": -18.9315, "longitude": 27.8070},
    {"province": "Matabeleland South", "location": "Gwanda", "latitude": -20.9362, "longitude": 29.0060},
    {"province": "Midlands", "location": "Gweru", "latitude": -19.4513, "longitude": 29.8167},
)


def _today_key() -> str:
    return datetime.now(CAT).date().isoformat()


def current_month_period() -> dict:
    """Return the current Harare calendar month through today."""
    today = datetime.now(CAT).date()
    return {
        "report_month": today.strftime("%Y-%m"),
        "start_date": today.replace(day=1).isoformat(),
        "end_date": today.isoformat(),
    }


@lru_cache(maxsize=2)
def _read_cache_version(path: str, modified_ns: int) -> dict:
    """Parse a cache version once instead of reparsing it for every API call."""
    del modified_ns
    with Path(path).open(encoding="utf-8") as source:
        return json.load(source)


def _read_cache() -> dict | None:
    if not CACHE_PATH.exists():
        return None
    return _read_cache_version(str(CACHE_PATH), CACHE_PATH.stat().st_mtime_ns)


def _write_cache(payload: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=CACHE_PATH.parent,
            prefix=f".{CACHE_PATH.name}.",
            suffix=".tmp",
            delete=False,
        ) as target:
            json.dump(payload, target, separators=(",", ":"))
            temporary_path = Path(target.name)
        temporary_path.replace(CACHE_PATH)
        _read_cache_version.cache_clear()
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def _fetch_open_meteo(turbines: list[dict]) -> dict:
    params = {
        "latitude": ",".join(str(asset["lat"]) for asset in turbines),
        "longitude": ",".join(str(asset["lon"]) for asset in turbines),
        "hourly": HOURLY,
        # The rolling archive provides enough recent variation for validation
        # and the full provider horizon avoids extrapolating a single live day.
        "past_days": str(LIVE_HISTORY_DAYS),
        "forecast_days": str(LIVE_FORECAST_DAYS),
        "timezone": "Africa/Harare",
        "wind_speed_unit": "ms",
        "models": "best_match",
    }
    url = f"{OPEN_METEO_URL}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "ZETDC-WTMS/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = json.loads(response.read().decode("utf-8"))
    locations = raw if isinstance(raw, list) else [raw]
    return {
        "cache_version": LIVE_CACHE_VERSION,
        "source": "open_meteo_live",
        "provider": "Open-Meteo",
        "provider_url": "https://open-meteo.com",
        "api_url": url,
        "collected_for": _today_key(),
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "variables": HOURLY.split(","),
        "history_days": LIVE_HISTORY_DAYS,
        "forecast_days": LIVE_FORECAST_DAYS,
        "locations": locations,
    }


def _payload_local_cutoff(payload: dict) -> datetime:
    collected_at = payload.get("collected_at")
    if collected_at:
        return datetime.fromisoformat(collected_at).astimezone(CAT).replace(tzinfo=None)
    return datetime.now(CAT).replace(tzinfo=None)


def _location_id(location: dict, index: int) -> int:
    return int(location.get("location_id", index))


def _completed_location(location: dict, cutoff: datetime, earliest: date | None = None) -> dict:
    """Copy only model hours that were available at collection time."""
    hourly = location.get("hourly", {})
    times = hourly.get("time", [])
    selected = [
        index
        for index, timestamp in enumerate(times)
        if datetime.fromisoformat(timestamp) <= cutoff
        and (earliest is None or timestamp[:10] >= earliest.isoformat())
    ]
    completed = {key: value for key, value in location.items() if key != "hourly"}
    completed["hourly"] = {
        key: [values[index] for index in selected if index < len(values)]
        for key, values in hourly.items()
        if isinstance(values, list)
    }
    return completed


def _merge_location_history(old: dict | None, fresh: dict, cutoff: datetime, earliest: date) -> dict:
    """Merge hourly samples by timestamp so each daily refresh grows History."""
    variables = HOURLY.split(",")
    samples: dict[str, dict[str, float | None]] = {}
    for location in (old, _completed_location(fresh, cutoff, earliest)):
        if not location:
            continue
        hourly = location.get("hourly", {})
        times = hourly.get("time", [])
        for index, timestamp in enumerate(times):
            if timestamp[:10] < earliest.isoformat() or datetime.fromisoformat(timestamp) > cutoff:
                continue
            sample = samples.setdefault(timestamp, {})
            for variable in variables:
                values = hourly.get(variable, [])
                if index < len(values):
                    sample[variable] = values[index]

    merged = {key: value for key, value in fresh.items() if key != "hourly"}
    ordered_times = sorted(samples)
    merged["hourly"] = {"time": ordered_times}
    for variable in variables:
        merged["hourly"][variable] = [samples[timestamp].get(variable) for timestamp in ordered_times]
    return merged


def _merge_live_history(cached: dict, fresh: dict) -> list[dict]:
    """Retain completed live-model hours across successful daily refreshes."""
    cutoff = _payload_local_cutoff(fresh)
    earliest = cutoff.date() - timedelta(days=LIVE_ARCHIVE_RETENTION_DAYS)
    old_locations = cached.get("history_locations")
    if not old_locations:
        old_locations = [
            _completed_location(location, _payload_local_cutoff(cached), earliest)
            for location in cached.get("locations", [])
        ]
    old_by_id = {
        _location_id(location, index): location
        for index, location in enumerate(old_locations)
    }
    return [
        _merge_location_history(old_by_id.get(_location_id(location, index)), location, cutoff, earliest)
        for index, location in enumerate(fresh.get("locations", []))
    ]


def _fetch_province_period(report_month: str, start_date: str, end_date: str) -> dict:
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    params = {
        "latitude": ",".join(str(item["latitude"]) for item in PROVINCE_LOCATIONS),
        "longitude": ",".join(str(item["longitude"]) for item in PROVINCE_LOCATIONS),
        "hourly": "wind_speed_10m,wind_direction_10m",
        "past_days": str(max(0, (end - start).days)),
        "forecast_days": "1",
        "timezone": "Africa/Harare",
        "wind_speed_unit": "ms",
        "models": "best_match",
    }
    url = f"{OPEN_METEO_URL}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "ZETDC-WTMS/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = json.loads(response.read().decode("utf-8"))
    return {
        "source": "open_meteo_live_month_to_date",
        "provider": "Open-Meteo",
        "api_url": url,
        "report_month": report_month,
        "start_date": start_date,
        "end_date": end_date,
        "collected_for": _today_key(),
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "locations": raw if isinstance(raw, list) else [raw],
    }


def _period_is_current(payload: dict, report_month: str, start_date: str, end_date: str) -> bool:
    period = payload.get("province_period") or {}
    return (
        period.get("report_month") == report_month
        and period.get("start_date") == start_date
        and period.get("end_date") == end_date
        and period.get("collected_for") == _today_key()
        and len(period.get("locations", [])) == len(PROVINCE_LOCATIONS)
    )


def collect_open_meteo(
    turbines: list[dict],
    report_period: dict | None = None,
    force: bool = False,
) -> dict:
    """Refresh today's point data and the reported-month province comparison.

    The scheduler calls this hourly. Successful data is reused for the rest of
    the Harare calendar day; a failed request is retried on the next pass.
    """
    cached = _read_cache() or {}
    payload = dict(cached)
    live_is_current = (
        cached.get("cache_version") == LIVE_CACHE_VERSION
        and cached.get("collected_for") == _today_key()
        and len(cached.get("locations", [])) == len(turbines)
        and len(cached.get("history_locations", [])) == len(turbines)
        and cached.get("forecast_days") == LIVE_FORECAST_DAYS
    )
    live_error = None
    if force or not live_is_current:
        try:
            fresh = _fetch_open_meteo(turbines)
            fresh["history_locations"] = _merge_live_history(cached, fresh)
            observed_times = [
                timestamp
                for location in fresh["history_locations"]
                for timestamp in location.get("hourly", {}).get("time", [])[-1:]
            ]
            fresh["observed_through"] = max(observed_times, default=None)
            province_period = payload.get("province_period")
            payload = fresh
            if province_period:
                payload["province_period"] = province_period
        except Exception as error:
            live_error = str(error)
            payload["stale"] = True
            payload["refresh_error"] = live_error

    if report_period:
        report_month = str(report_period["report_month"])
        start_date = str(report_period["start_date"])
        end_date = str(report_period["end_date"])
        if force or not _period_is_current(payload, report_month, start_date, end_date):
            try:
                payload["province_period"] = _fetch_province_period(report_month, start_date, end_date)
                payload.pop("province_refresh_error", None)
            except Exception as error:
                payload["province_refresh_error"] = str(error)

    if payload.get("locations") or payload.get("province_period"):
        _write_cache(payload)
        return payload
    return {
        "source": "open_meteo_live",
        "provider": "Open-Meteo",
        "provider_url": "https://open-meteo.com",
        "collected_for": _today_key(),
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "variables": HOURLY.split(","),
        "locations": [],
        "available": False,
        "refresh_error": live_error or payload.get("province_refresh_error", "Live wind data is unavailable"),
    }


def cached_open_meteo(turbines: list[dict]) -> dict:
    cached = _read_cache()
    if cached:
        return cached
    return collect_open_meteo(turbines)


def _circular_mean(values: list[float]) -> float | None:
    if not values:
        return None
    sine = sum(math.sin(math.radians(value)) for value in values)
    cosine = sum(math.cos(math.radians(value)) for value in values)
    return round(math.degrees(math.atan2(sine, cosine)) % 360, 1)


def summarize_province_period(payload: dict, report_month: str, start_date: str, end_date: str) -> dict:
    """Summarise cached current-month live readings for all 10 provinces."""
    period = payload.get("province_period") or {}
    matching_period = (
        period.get("report_month") == report_month
        and period.get("start_date") == start_date
        and period.get("end_date") == end_date
    )
    locations = period.get("locations", []) if matching_period else []
    locations_by_id = {
        int(location.get("location_id", index)): location
        for index, location in enumerate(locations)
    }
    all_speeds: list[float] = []
    all_directions: list[float] = []
    provinces = []
    for index, province in enumerate(PROVINCE_LOCATIONS):
        hourly = locations_by_id.get(index, {}).get("hourly", {})
        times = hourly.get("time", [])
        raw_speeds = hourly.get("wind_speed_10m", [])
        raw_directions = hourly.get("wind_direction_10m", [])
        collected_at = period.get("collected_at")
        cutoff = datetime.fromisoformat(collected_at).astimezone(CAT).replace(tzinfo=None) if collected_at else None
        selected_indices = [
            item_index
            for item_index, timestamp in enumerate(times)
            if start_date <= timestamp[:10] <= end_date
            and (cutoff is None or datetime.fromisoformat(timestamp) <= cutoff)
        ]
        speeds = [
            float(raw_speeds[item_index])
            for item_index in selected_indices
            if item_index < len(raw_speeds) and raw_speeds[item_index] is not None
        ]
        directions = [
            float(raw_directions[item_index])
            for item_index in selected_indices
            if item_index < len(raw_directions) and raw_directions[item_index] is not None
        ]
        all_speeds.extend(speeds)
        all_directions.extend(directions)
        provinces.append({
            **province,
            "status": "reporting" if speeds else "unavailable",
            "average_wind_speed": round(sum(speeds) / len(speeds), 2) if speeds else None,
            "minimum_wind_speed": round(min(speeds), 2) if speeds else None,
            "maximum_wind_speed": round(max(speeds), 2) if speeds else None,
            "average_wind_direction": _circular_mean(directions),
            "records": len(speeds),
        })
    return {
        "source": period.get("source", "open_meteo_live_month_to_date"),
        "provider": period.get("provider", "Open-Meteo"),
        "report_month": report_month,
        "start_date": start_date,
        "end_date": end_date,
        "collected_for": period.get("collected_for"),
        "collected_at": period.get("collected_at"),
        "available": bool(all_speeds),
        "average_wind_speed": round(sum(all_speeds) / len(all_speeds), 2) if all_speeds else None,
        "minimum_wind_speed": round(min(all_speeds), 2) if all_speeds else None,
        "maximum_wind_speed": round(max(all_speeds), 2) if all_speeds else None,
        "average_wind_direction": _circular_mean(all_directions),
        "records": len(all_speeds),
        "provinces": provinces,
    }


def live_readings(turbines: list[dict], payload: dict | None = None) -> list[dict]:
    """Return live wind and environmental observations."""
    payload = payload or cached_open_meteo(turbines)
    readings = []
    history_locations = payload.get("history_locations")
    if not history_locations:
        earliest = _payload_local_cutoff(payload).date() - timedelta(days=LIVE_ARCHIVE_RETENTION_DAYS)
        history_locations = [
            _completed_location(location, _payload_local_cutoff(payload), earliest)
            for location in payload.get("locations", [])
        ]
    locations_by_id = {
        _location_id(location, index): location
        for index, location in enumerate(history_locations)
    }
    for index, turbine in enumerate(turbines):
        location = locations_by_id.get(index)
        if location is None:
            continue
        hourly = location.get("hourly", {})
        times = hourly.get("time", [])
        wind = hourly.get("wind_speed_10m", [])
        direction = hourly.get("wind_direction_10m", [])
        temperature = hourly.get("temperature_2m", [])
        humidity = hourly.get("relative_humidity_2m", [])
        pressure = hourly.get("surface_pressure", [])
        for index, observed in enumerate(times):
            wind_speed = wind[index] if index < len(wind) and wind[index] is not None else 0.0
            temperature_c = temperature[index] if index < len(temperature) and temperature[index] is not None else 0.0
            humidity_pct = humidity[index] if index < len(humidity) and humidity[index] is not None else 0.0
            pressure_hpa = pressure[index] if index < len(pressure) and pressure[index] is not None else 0.0
            density = air_density_kg_m3(temperature_c, humidity_pct, pressure_hpa)
            reading = {
                "turbine_id": turbine["id"],
                "timestamp": datetime.fromisoformat(observed).replace(tzinfo=CAT).isoformat(),
                "date": observed[:10],
                "records": 1,
                "wind_speed": round(float(wind_speed), 3),
                "wind_speed_min": round(float(wind_speed), 3),
                "wind_speed_max": round(float(wind_speed), 3),
                "wind_direction": round(float(direction[index]), 2) if index < len(direction) and direction[index] is not None else 0.0,
                "temperature": round(float(temperature_c), 2),
                "humidity": round(float(humidity_pct), 2),
                "air_pressure": round(float(pressure_hpa), 2),
                "air_density": round(density or 0.0, 4),
                "availability_pct": 100.0,
                "data_quality_pct": 100.0,
                "measurement_source": "open_meteo_live",
            }
            readings.append(reading)
    return sorted(readings, key=lambda item: (item["timestamp"], item["turbine_id"]))


def live_forecast_days(turbines: list[dict], days: int = LIVE_FORECAST_DAYS) -> dict[int, list[dict]]:
    """Return the current Open-Meteo hourly forecast as per-site daily rows."""
    payload = cached_open_meteo(turbines)
    locations_by_id = {
        _location_id(location, index): location
        for index, location in enumerate(payload.get("locations", []))
    }
    start = date.fromisoformat(_today_key())
    end = start + timedelta(days=max(1, min(days, LIVE_FORECAST_DAYS)))
    result: dict[int, list[dict]] = {}
    for index, turbine in enumerate(turbines):
        location = locations_by_id.get(index, {})
        hourly = location.get("hourly", {})
        grouped: dict[str, list[dict]] = defaultdict(list)
        times = hourly.get("time", [])
        for row_index, timestamp in enumerate(times):
            observed_on = datetime.fromisoformat(timestamp).date()
            if not (start <= observed_on < end):
                continue
            wind_values = hourly.get("wind_speed_10m", [])
            if row_index >= len(wind_values) or wind_values[row_index] is None:
                continue
            temperature_values = hourly.get("temperature_2m", [])
            humidity_values = hourly.get("relative_humidity_2m", [])
            pressure_values = hourly.get("surface_pressure", [])
            temperature_c = temperature_values[row_index] if row_index < len(temperature_values) else None
            humidity_pct = humidity_values[row_index] if row_index < len(humidity_values) else None
            pressure_hpa = pressure_values[row_index] if row_index < len(pressure_values) else None
            grouped[observed_on.isoformat()].append({
                "wind_speed": float(wind_values[row_index]),
                "air_density": air_density_kg_m3(temperature_c, humidity_pct, pressure_hpa)
                if None not in (temperature_c, humidity_pct, pressure_hpa) else None,
            })
        daily = []
        for date_key, rows in sorted(grouped.items()):
            winds = [row["wind_speed"] for row in rows]
            densities = [row["air_density"] for row in rows if row["air_density"] is not None]
            daily.append({
                "date": date_key,
                "wind_speed": round(sum(winds) / len(winds), 3),
                "wind_speed_min": round(min(winds), 3),
                "wind_speed_max": round(max(winds), 3),
                "wind_speed_stddev": round(wind_speed_stddev(winds) or 0.0, 3),
                "air_density": round(sum(densities) / len(densities), 4) if densities else None,
                "samples": len(winds),
            })
        result[turbine["id"]] = daily
    return result


def live_stations(turbines: list[dict], payload: dict | None = None) -> list[dict]:
    rows = live_readings(turbines, payload)
    now = datetime.now(CAT)
    latest_by_point: dict[int, dict] = {}
    rows_by_point: dict[int, list[dict]] = {}
    for row in rows:
        turbine_id = int(row["turbine_id"])
        rows_by_point.setdefault(turbine_id, []).append(row)
        observed_at = datetime.fromisoformat(row["timestamp"])
        current = latest_by_point.get(turbine_id)
        if current is None or abs(observed_at - now) < abs(datetime.fromisoformat(current["timestamp"]) - now):
            latest_by_point[turbine_id] = row
    return [
        {
            **asset,
            "telemetry_source": "Open-Meteo live forecast",
            "measurement_source": "open_meteo_live",
            "average_wind_speed": round(
                sum(row["wind_speed"] for row in rows_by_point.get(asset["id"], []))
                / max(len(rows_by_point.get(asset["id"], [])), 1),
                2,
            ),
            "wind_speed_stddev": round(
                wind_speed_stddev(row["wind_speed"] for row in rows_by_point.get(asset["id"], [])) or 0.0,
                2,
            ),
            "minimum_wind_speed": round(
                min((row["wind_speed"] for row in rows_by_point.get(asset["id"], [])), default=0.0),
                2,
            ),
            "maximum_wind_speed": round(
                max((row["wind_speed"] for row in rows_by_point.get(asset["id"], [])), default=0.0),
                2,
            ),
            "latest_wind_speed": latest_by_point.get(asset["id"], {}).get("wind_speed", 0.0),
            "latest_wind_direction": latest_by_point.get(asset["id"], {}).get("wind_direction", 0.0),
            "latest_temperature": latest_by_point.get(asset["id"], {}).get("temperature", 0.0),
            "latest_humidity": latest_by_point.get(asset["id"], {}).get("humidity", 0.0),
            "latest_air_pressure": latest_by_point.get(asset["id"], {}).get("air_pressure", 0.0),
            "latest_air_density": latest_by_point.get(asset["id"], {}).get("air_density", 0.0),
            "last_reading_at": latest_by_point.get(asset["id"], {}).get("timestamp", asset["last_reading_at"]),
        }
        for asset in turbines
    ]


def _wind_window_summary(days: list[dict]) -> dict | None:
    if not days:
        return None
    return {
        "average": round(sum(day["average"] for day in days) / len(days), 3),
        "minimum": round(min(day["minimum"] for day in days), 3),
        "maximum": round(max(day["maximum"] for day in days), 3),
        "start_date": days[0]["date"],
        "end_date": days[-1]["date"],
        "days": len(days),
        "samples": sum(day["samples"] for day in days),
    }


def _daily_wind_window(times: list[str], speeds: list[float | None], start: date, end: date) -> list[dict]:
    grouped: dict[date, list[float]] = defaultdict(list)
    for timestamp, speed in zip(times, speeds):
        if speed is None:
            continue
        observed_on = datetime.fromisoformat(timestamp).date()
        if start <= observed_on < end:
            grouped[observed_on].append(float(speed))
    return [
        {
            "date": observed_on.isoformat(),
            "average": round(sum(values) / len(values), 3),
            "minimum": round(min(values), 3),
            "maximum": round(max(values), 3),
            "samples": len(values),
        }
        for observed_on, values in sorted(grouped.items())
        if values
    ]


@lru_cache(maxsize=128)
def _point_wind_window(latitude: float, longitude: float, today_key: str) -> dict:
    """Fetch a rolling observed/forecast wind window for an arbitrary map point."""
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": "wind_speed_10m",
        "past_days": 7,
        "forecast_days": 7,
        "timezone": "Africa/Harare",
        "wind_speed_unit": "ms",
        "models": "best_match",
        "cell_selection": "land",
    }
    url = f"{OPEN_METEO_URL}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "ZETDC-WTMS/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    hourly = payload.get("hourly", {})
    times = hourly.get("time", [])
    speeds = hourly.get("wind_speed_10m", [])
    today = date.fromisoformat(today_key)
    observed_daily = _daily_wind_window(times, speeds, today - timedelta(days=7), today)
    forecast_daily = _daily_wind_window(times, speeds, today, today + timedelta(days=7))
    return {
        "provider": "Open-Meteo",
        "model": "best_match",
        "height_m": 10,
        "observed": _wind_window_summary(observed_daily),
        "observed_daily": observed_daily,
        "forecast": _wind_window_summary(forecast_daily),
        "forecast_daily": forecast_daily,
    }


def point_wind_window(latitude: float, longitude: float) -> dict:
    """Return seven completed days and the next seven forecast days at a point."""
    return _point_wind_window(round(latitude, 4), round(longitude, 4), _today_key())
