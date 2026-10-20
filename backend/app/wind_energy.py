"""Wind-energy formula settings and calculations."""

from __future__ import annotations

import json
import math
from pathlib import Path


SETTINGS_PATH = Path(__file__).resolve().parents[1] / "data" / "wind_energy_settings.json"
DEFAULT_SETTINGS = {
    "blade_radius_m": 30.0,
    "power_coefficient": 0.42,
    "system_efficiency": 0.92,
    "sample_interval_minutes": 10.0,
    "tariff_usd_per_mwh": 82.0,
    "cap_to_capacity": True,
}


def _number(value, fallback: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(number):
        return fallback
    return max(minimum, min(maximum, number))


def _normalise_settings(payload: dict | None) -> dict:
    payload = payload or {}
    return {
        "blade_radius_m": _number(payload.get("blade_radius_m"), DEFAULT_SETTINGS["blade_radius_m"], 0.1, 200.0),
        "power_coefficient": _number(payload.get("power_coefficient"), DEFAULT_SETTINGS["power_coefficient"], 0.0, 0.593),
        "system_efficiency": _number(payload.get("system_efficiency"), DEFAULT_SETTINGS["system_efficiency"], 0.0, 1.0),
        "sample_interval_minutes": _number(payload.get("sample_interval_minutes"), DEFAULT_SETTINGS["sample_interval_minutes"], 1.0, 1440.0),
        "tariff_usd_per_mwh": _number(payload.get("tariff_usd_per_mwh"), DEFAULT_SETTINGS["tariff_usd_per_mwh"], 0.0, 10000.0),
        "cap_to_capacity": bool(payload.get("cap_to_capacity", DEFAULT_SETTINGS["cap_to_capacity"])),
    }


def get_wind_energy_settings() -> dict:
    if not SETTINGS_PATH.exists():
        return dict(DEFAULT_SETTINGS)
    try:
        with SETTINGS_PATH.open(encoding="utf-8") as source:
            return _normalise_settings(json.load(source))
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULT_SETTINGS)


def save_wind_energy_settings(payload: dict) -> dict:
    settings = _normalise_settings(payload)
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with SETTINGS_PATH.open("w", encoding="utf-8") as target:
        json.dump(settings, target, indent=2)
    return settings


def swept_area_m2(settings: dict | None = None) -> float:
    active = _normalise_settings(settings or get_wind_energy_settings())
    return math.pi * active["blade_radius_m"] ** 2


def wind_power_kw(wind_speed, air_density=None, capacity_kw=None, settings: dict | None = None) -> float:
    active = _normalise_settings(settings or get_wind_energy_settings())
    try:
        speed = max(0.0, float(wind_speed))
        density = float(air_density) if air_density is not None else 1.225
    except (TypeError, ValueError):
        return 0.0
    if density <= 0 or speed <= 0:
        return 0.0
    watts = 0.5 * density * swept_area_m2(active) * speed**3 * active["power_coefficient"] * active["system_efficiency"]
    power_kw = watts / 1000.0
    if active["cap_to_capacity"] and capacity_kw:
        power_kw = min(power_kw, float(capacity_kw))
    return max(0.0, power_kw)


def enrich_energy_reading(reading: dict, capacity_kw: float, interval_minutes: float | None = None, settings: dict | None = None) -> dict:
    active = _normalise_settings(settings or get_wind_energy_settings())
    minutes = interval_minutes if interval_minutes is not None else active["sample_interval_minutes"]
    power_kw = wind_power_kw(reading.get("wind_speed"), reading.get("air_density"), capacity_kw, active)
    energy_mwh = power_kw * (float(minutes) / 60.0) / 1000.0
    tariff = active["tariff_usd_per_mwh"]
    reading["power_output"] = round(power_kw, 2)
    reading["energy_produced_mwh"] = round(energy_mwh, 6)
    reading["expected_energy_mwh"] = round(energy_mwh, 6)
    reading["estimated_revenue_usd"] = round(energy_mwh * tariff, 4)
    reading["capacity_factor_pct"] = round(power_kw / float(capacity_kw) * 100, 2) if capacity_kw else 0.0
    reading["generation_source"] = "wind_energy_formula"
    reading["energy_formula"] = "P=0.5*rho*pi*r^2*v^3*Cp*efficiency"
    reading["rotor_swept_area_m2"] = round(swept_area_m2(active), 3)
    return reading
