"""Open-Meteo live wind cache kept separate from ZETDC mast observations."""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .data import air_density_kg_m3
from .forecasting import power_from_wind
from .wind_energy import enrich_energy_reading, get_wind_energy_settings


CACHE_PATH = Path(__file__).resolve().parents[1] / "data" / "open_meteo_live_wind.json"
CAT = timezone(timedelta(hours=2))
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
HOURLY = "wind_speed_10m,wind_direction_10m,temperature_2m,relative_humidity_2m,surface_pressure"


def _today_key() -> str:
    return datetime.now(CAT).date().isoformat()


def _read_cache() -> dict | None:
    if not CACHE_PATH.exists():
        return None
    with CACHE_PATH.open(encoding="utf-8") as source:
        return json.load(source)


def _write_cache(payload: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CACHE_PATH.open("w", encoding="utf-8") as target:
        json.dump(payload, target, separators=(",", ":"))


def _fetch_open_meteo(turbines: list[dict]) -> dict:
    params = {
        "latitude": ",".join(str(asset["lat"]) for asset in turbines),
        "longitude": ",".join(str(asset["lon"]) for asset in turbines),
        "hourly": HOURLY,
        "forecast_days": "1",
        "timezone": "Africa/Harare",
        "wind_speed_unit": "ms",
        "models": "best_match",
    }
    url = f"{OPEN_METEO_URL}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=20) as response:
        raw = json.loads(response.read().decode("utf-8"))
    locations = raw if isinstance(raw, list) else [raw]
    return {
        "source": "open_meteo_live",
        "provider": "Open-Meteo",
        "provider_url": "https://open-meteo.com",
        "api_url": url,
        "collected_for": _today_key(),
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "variables": HOURLY.split(","),
        "locations": locations,
    }


def collect_open_meteo(turbines: list[dict], force: bool = False) -> dict:
    cached = _read_cache()
    if cached and not force and cached.get("collected_for") == _today_key():
        return cached
    try:
        payload = _fetch_open_meteo(turbines)
        _write_cache(payload)
        return payload
    except Exception as error:
        if cached:
            return {**cached, "stale": True, "refresh_error": str(error)}
        return {
            "source": "open_meteo_live",
            "provider": "Open-Meteo",
            "provider_url": "https://open-meteo.com",
            "collected_for": _today_key(),
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "variables": HOURLY.split(","),
            "locations": [],
            "available": False,
            "refresh_error": str(error),
        }


def cached_open_meteo(turbines: list[dict]) -> dict:
    cached = _read_cache()
    if cached:
        return cached
    return collect_open_meteo(turbines)


def live_readings(turbines: list[dict], capacity_by_id: dict[int, float]) -> list[dict]:
    payload = cached_open_meteo(turbines)
    readings = []
    settings = get_wind_energy_settings()
    for turbine, location in zip(turbines, payload.get("locations", [])):
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
            capacity_kw = capacity_by_id.get(int(turbine["id"]), 2500.0)
            power = power_from_wind(float(wind_speed), capacity_kw, density)
            reading = enrich_energy_reading(
                {
                    "turbine_id": turbine["id"],
                    "timestamp": datetime.fromisoformat(observed).replace(tzinfo=CAT).isoformat(),
                    "date": observed[:10],
                    "records": 1,
                    "wind_speed": round(float(wind_speed), 3),
                    "wind_direction": round(float(direction[index]), 2) if index < len(direction) and direction[index] is not None else 0.0,
                    "temperature": round(float(temperature_c), 2),
                    "humidity": round(float(humidity_pct), 2),
                    "air_pressure": round(float(pressure_hpa), 2),
                    "air_density": round(density or 0.0, 4),
                    "availability_pct": 100.0,
                    "capacity_factor_pct": round(power / capacity_kw * 100, 2) if capacity_kw else 0.0,
                    "data_quality_pct": 100.0,
                    "measurement_source": "open_meteo_live",
                    "revenue_source": f"derived at configured USD {settings['tariff_usd_per_mwh']}/MWh",
                },
                capacity_kw,
                interval_minutes=60.0,
                settings=settings,
            )
            readings.append(reading)
    return sorted(readings, key=lambda item: (item["timestamp"], item["turbine_id"]))


def live_stations(turbines: list[dict]) -> list[dict]:
    rows = live_readings(turbines, {int(asset["id"]): asset["capacity_kw"] for asset in turbines})
    now = datetime.now(CAT)
    latest_by_point: dict[int, dict] = {}
    for row in rows:
        turbine_id = int(row["turbine_id"])
        observed_at = datetime.fromisoformat(row["timestamp"])
        current = latest_by_point.get(turbine_id)
        if current is None or abs(observed_at - now) < abs(datetime.fromisoformat(current["timestamp"]) - now):
            latest_by_point[turbine_id] = row
    return [
        {
            **asset,
            "telemetry_source": "Open-Meteo live forecast",
            "measurement_source": "open_meteo_live",
            "latest_wind_speed": latest_by_point.get(asset["id"], {}).get("wind_speed", 0.0),
            "latest_power_output": latest_by_point.get(asset["id"], {}).get("power_output", 0.0),
            "latest_wind_direction": latest_by_point.get(asset["id"], {}).get("wind_direction", 0.0),
            "latest_temperature": latest_by_point.get(asset["id"], {}).get("temperature", 0.0),
            "latest_humidity": latest_by_point.get(asset["id"], {}).get("humidity", 0.0),
            "latest_air_pressure": latest_by_point.get(asset["id"], {}).get("air_pressure", 0.0),
            "latest_air_density": latest_by_point.get(asset["id"], {}).get("air_density", 0.0),
            "last_reading_at": latest_by_point.get(asset["id"], {}).get("timestamp", asset["last_reading_at"]),
        }
        for asset in turbines
    ]
