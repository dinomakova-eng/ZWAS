"""Compact observed and forecast wind context for arbitrary map locations."""

from __future__ import annotations

from collections import defaultdict
from math import asin, cos, radians, sin, sqrt

from .data import READINGS_BY_TURBINE, gis_assignment, turbines
from .forecasting import build_forecast
from .open_meteo import point_wind_window


def _distance_km(latitude: float, longitude: float, asset: dict) -> float:
    earth_radius_km = 6371.0088
    latitude_delta = radians(float(asset["lat"]) - latitude)
    longitude_delta = radians(float(asset["lon"]) - longitude)
    left = sin(latitude_delta / 2) ** 2
    right = cos(radians(latitude)) * cos(radians(float(asset["lat"]))) * sin(longitude_delta / 2) ** 2
    return earth_radius_km * 2 * asin(sqrt(left + right))


def _observed_stats(rows: list[dict]) -> dict | None:
    available = [row for row in rows if row.get("wind_speed") is not None]
    if not available:
        return None
    return {
        "average": round(sum(float(row["wind_speed"]) for row in available) / len(available), 3),
        "minimum": round(min(float(row.get("wind_speed_min", row["wind_speed"])) for row in available), 3),
        "maximum": round(max(float(row.get("wind_speed_max", row["wind_speed"])) for row in available), 3),
        "start_date": min(row["timestamp"][:10] for row in available),
        "end_date": max(row["timestamp"][:10] for row in available),
        "days": len({row["timestamp"][:10] for row in available}),
        "samples": len(available),
    }


def _daily_observed_stats(rows: list[dict]) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if row.get("wind_speed") is not None:
            grouped[row["timestamp"][:10]].append(row)
    return [
        {
            "date": observed_on,
            "average": round(sum(float(row["wind_speed"]) for row in day_rows) / len(day_rows), 3),
            "minimum": round(min(float(row.get("wind_speed_min", row["wind_speed"])) for row in day_rows), 3),
            "maximum": round(max(float(row.get("wind_speed_max", row["wind_speed"])) for row in day_rows), 3),
            "samples": len(day_rows),
        }
        for observed_on, day_rows in sorted(grouped.items())
        if day_rows
    ]


def _forecast_stats(rows: list[dict]) -> dict | None:
    if not rows:
        return None
    return {
        "average": round(sum(float(row["wind_speed"]) for row in rows) / len(rows), 3),
        "minimum": round(min(float(row["lower"]) for row in rows), 3),
        "maximum": round(max(float(row["upper"]) for row in rows), 3),
        "start_date": rows[0]["date"],
        "end_date": rows[-1]["date"],
        "days": len(rows),
    }


def _blend_forecasts(
    live_daily: list[dict],
    mast_daily: list[dict],
    live_observed: dict | None,
    mast_observed: dict | None,
    distance_km: float,
) -> tuple[list[dict], float, float]:
    if not live_daily:
        return [
            {
                "date": row["date"],
                "wind_speed": row["wind_speed"],
                "lower": row["lower"],
                "upper": row["upper"],
            }
            for row in mast_daily
        ], 0.0, 1.0

    # The numerical weather model is most useful for a seven-day horizon.
    # Nearby mast history contributes local calibration, with less influence as
    # the selected location moves farther from the measurement point.
    mast_weight = max(0.10, 0.25 - min(distance_km, 250.0) / 250.0 * 0.15)
    live_weight = 1.0 - mast_weight
    calibration = 1.0
    if live_observed and mast_observed and float(live_observed.get("average") or 0) > 0:
        ratio = float(mast_observed["average"]) / float(live_observed["average"])
        bounded_ratio = max(0.85, min(1.15, ratio))
        distance_strength = max(0.15, 1.0 - min(distance_km, 300.0) / 300.0)
        calibration += (bounded_ratio - 1.0) * distance_strength

    mast_by_date = {row["date"]: row for row in mast_daily}
    blended = []
    for index, live in enumerate(live_daily):
        mast = mast_by_date.get(live["date"])
        if mast is None and index < len(mast_daily):
            mast = mast_daily[index]
        calibrated_mean = float(live["average"]) * calibration
        calibrated_minimum = float(live["minimum"]) * calibration
        calibrated_maximum = float(live["maximum"]) * calibration
        if mast:
            mean = live_weight * calibrated_mean + mast_weight * float(mast["wind_speed"])
            lower = live_weight * calibrated_minimum + mast_weight * float(mast["lower"])
            upper = live_weight * calibrated_maximum + mast_weight * float(mast["upper"])
        else:
            mean, lower, upper = calibrated_mean, calibrated_minimum, calibrated_maximum
        blended.append({
            "date": live["date"],
            "wind_speed": round(max(0.0, mean), 3),
            "lower": round(max(0.0, min(lower, mean)), 3),
            "upper": round(max(mean, upper), 3),
        })
    return blended, live_weight, mast_weight


def build_environment_wind_summary(latitude: float, longitude: float, live_window: dict | None = None) -> dict:
    assets = turbines()
    nearest = min(assets, key=lambda asset: _distance_km(latitude, longitude, asset))
    distance_km = _distance_km(latitude, longitude, nearest)
    area = gis_assignment(longitude, latitude)

    all_mast_rows = READINGS_BY_TURBINE[nearest["id"]]
    latest_dates = sorted({row["timestamp"][:10] for row in all_mast_rows})[-7:]
    mast_rows = [row for row in all_mast_rows if row["timestamp"][:10] in latest_dates]
    mast_observed = _observed_stats(mast_rows)
    mast_prediction = build_forecast(
        [nearest],
        {nearest["id"]: READINGS_BY_TURBINE[nearest["id"]]},
        7,
    )
    mast_daily = mast_prediction["by_turbine"].get(str(nearest["id"]), [])
    mast_forecast = _forecast_stats(mast_daily)

    live_error = None
    if live_window is None:
        try:
            live_window = point_wind_window(latitude, longitude)
        except Exception as error:  # Preserve mast analysis when the live provider is unavailable.
            live_window = {}
            live_error = str(error)
    live_observed = live_window.get("observed")
    live_forecast = live_window.get("forecast")
    live_daily = live_window.get("forecast_daily") or []

    blended_daily, live_weight, mast_weight = _blend_forecasts(
        live_daily,
        mast_daily,
        live_observed,
        mast_observed,
        distance_km,
    )
    blended_forecast = _forecast_stats(blended_daily)

    return {
        "point": {
            "latitude": round(latitude, 5),
            "longitude": round(longitude, 5),
            "region": area["region"],
            "district": area["district"],
        },
        "closest_wind_point": {
            "id": nearest["id"],
            "name": nearest["name"],
            "latitude": nearest["lat"],
            "longitude": nearest["lon"],
            "distance_km": round(distance_km, 2),
            "region": nearest.get("region"),
            "district": nearest.get("district"),
        },
        "observed": {
            "live": live_observed,
            "mast": mast_observed,
            "live_daily": live_window.get("observed_daily") or [],
            "mast_daily": _daily_observed_stats(mast_rows),
        },
        "forecast": {
            "live": live_forecast,
            "mast": mast_forecast,
            "blended": blended_forecast,
            "daily": blended_daily,
        },
        "method": {
            "label": "Open-Meteo best-match forecast with nearest-mast calibration",
            "live_weight_pct": round(live_weight * 100),
            "mast_weight_pct": round(mast_weight * 100),
            "mast_model": mast_prediction["models_by_turbine"].get(str(nearest["id"]), {}).get("selected_model"),
            "mast_model_mae": mast_prediction["backtest_mae"],
            "live_available": bool(live_daily),
            "live_error": live_error,
        },
    }
