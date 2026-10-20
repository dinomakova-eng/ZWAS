"""Transparent wind forecasts trained from the imported mast observations."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from math import cos, pi, sin, sqrt

from .wind_energy import wind_power_kw


def power_from_wind(wind_speed: float, capacity_kw: float, air_density: float | None = None) -> float:
    """Calculate formula power in kW from wind speed, density, swept area, and Cp."""
    return wind_power_kw(wind_speed, air_density, capacity_kw)


def _daily_metric(readings: list[dict], metric: str) -> list[tuple[date, float]]:
    grouped = defaultdict(list)
    for reading in readings:
        value = reading.get(metric)
        if value is not None:
            grouped[datetime.fromisoformat(reading["timestamp"]).date()].append(float(value))
    return [(day, sum(values) / len(values)) for day, values in sorted(grouped.items())]


def _daily_wind(readings: list[dict]) -> list[tuple[date, float]]:
    return _daily_metric(readings, "wind_speed")


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _baseline_values(daily: list[tuple[date, float]], targets: list[date]) -> list[float]:
    recent = daily[-90:] or daily
    baseline = _mean([value for _, value in recent])
    weekday_values = defaultdict(list)
    for day, value in recent:
        weekday_values[day.weekday()].append(value)
    weekday_means = {weekday: _mean(values) for weekday, values in weekday_values.items()}
    early = _mean([value for _, value in recent[:14]])
    late = _mean([value for _, value in recent[-14:]])
    trend = max(-0.02, min(0.02, (late - early) / max(len(recent) - 14, 1)))
    return [
        max(0.0, baseline + (weekday_means.get(target.weekday(), baseline) - baseline) * 0.65 + trend * min(index + 1, 30))
        for index, target in enumerate(targets)
    ]


def _solve_ridge(features: list[list[float]], targets: list[float], penalty: float = 0.08) -> list[float] | None:
    """Solve a small ridge-regression system without adding a heavy ML dependency."""
    if not features or len(features) != len(targets):
        return None
    width = len(features[0])
    matrix = [[0.0 for _ in range(width + 1)] for _ in range(width)]
    for row, target in zip(features, targets):
        for left in range(width):
            matrix[left][width] += row[left] * target
            for right in range(width):
                matrix[left][right] += row[left] * row[right]
    for index in range(1, width):
        matrix[index][index] += penalty

    for column in range(width):
        pivot = max(range(column, width), key=lambda row: abs(matrix[row][column]))
        if abs(matrix[pivot][column]) < 1e-10:
            return None
        matrix[column], matrix[pivot] = matrix[pivot], matrix[column]
        divisor = matrix[column][column]
        matrix[column] = [value / divisor for value in matrix[column]]
        for row in range(width):
            if row == column:
                continue
            factor = matrix[row][column]
            matrix[row] = [value - factor * pivot_value for value, pivot_value in zip(matrix[row], matrix[column])]
    return [matrix[row][width] for row in range(width)]


def _regression_features(position: int, scale: int, forecast_date: date, values: list[float]) -> list[float]:
    weekday_angle = 2 * pi * forecast_date.weekday() / 7
    return [
        1.0,
        position / max(scale, 1),
        sin(weekday_angle),
        cos(weekday_angle),
        values[-1],
        _mean(values[-7:]),
    ]


def _fit_regression(daily: list[tuple[date, float]]) -> dict | None:
    if len(daily) < 21:
        return None
    values = [value for _, value in daily]
    scale = max(len(daily) - 1, 1)
    features = [
        _regression_features(index, scale, forecast_date, values[:index])
        for index, (forecast_date, _) in enumerate(daily)
        if index >= 7
    ]
    targets = [value for index, (_, value) in enumerate(daily) if index >= 7]
    coefficients = _solve_ridge(features, targets)
    if coefficients is None:
        return None
    recent = values[-90:]
    centre = _mean(recent)
    spread = sqrt(_mean([(value - centre) ** 2 for value in recent]))
    return {
        "coefficients": coefficients,
        "scale": scale,
        "floor": max(0.0, min(recent) - spread),
        "ceiling": max(recent) + max(0.5, spread),
    }


def _regression_values(daily: list[tuple[date, float]], targets: list[date]) -> list[float] | None:
    model = _fit_regression(daily)
    if model is None:
        return None
    history = [value for _, value in daily]
    predictions = []
    for forecast_date in targets:
        features = _regression_features(len(history), model["scale"], forecast_date, history)
        predicted = sum(coefficient * value for coefficient, value in zip(model["coefficients"], features))
        predicted = max(model["floor"], min(model["ceiling"], predicted))
        predictions.append(predicted)
        history.append(predicted)
    return predictions


def _select_model(daily: list[tuple[date, float]]) -> dict:
    if len(daily) < 26:
        return {
            "selected_model": "statistical_baseline",
            "selection_reason": "Insufficient history for regression validation",
            "baseline_mae": None,
            "regression_mae": None,
            "validation_days": 0,
            "training_days": len(daily),
        }
    validation_days = max(5, min(14, len(daily) // 5))
    validation = daily[-validation_days:]
    training_days = len(daily) - validation_days
    baseline_errors = []
    regression_errors = []
    for offset, (target_day, observed) in enumerate(validation):
        history = daily[:training_days + offset]
        baseline = _baseline_values(history, [target_day])[0]
        regression = _regression_values(history, [target_day])
        baseline_errors.append(abs(observed - baseline))
        if regression is not None:
            regression_errors.append(abs(observed - regression[0]))
    baseline_mae = _mean(baseline_errors)
    regression_mae = _mean(regression_errors) if len(regression_errors) == validation_days else None
    use_regression = regression_mae is not None and regression_mae <= baseline_mae
    return {
        "selected_model": "autoregressive_regression" if use_regression else "statistical_baseline",
        "selection_reason": "Lower rolling-validation MAE" if use_regression else "Baseline had lower rolling-validation MAE",
        "baseline_mae": round(baseline_mae, 3),
        "regression_mae": round(regression_mae, 3) if regression_mae is not None else None,
        "validation_days": validation_days,
        "training_days": training_days,
    }


def _series_forecast(readings: list[dict], start: date, days: int, capacity_kw: float) -> tuple[list[dict], float | None, int, dict]:
    daily = _daily_wind(readings)
    recent = daily[-90:] or daily
    targets = [start + timedelta(days=index) for index in range(days)]
    diagnostics = _select_model(daily)
    baseline_forecast = _baseline_values(daily, targets)
    regression_forecast = _regression_values(daily, targets)
    use_regression = diagnostics["selected_model"] == "autoregressive_regression" and regression_forecast is not None
    wind_forecast = regression_forecast if use_regression else baseline_forecast

    density_daily = _daily_metric(readings, "air_density")
    density_diagnostics = _select_model(density_daily)
    density_baseline = _baseline_values(density_daily, targets)
    density_regression = _regression_values(density_daily, targets)
    use_density_regression = density_diagnostics["selected_model"] == "autoregressive_regression" and density_regression is not None
    density_forecast = density_regression if use_density_regression else density_baseline
    diagnostics["metrics"] = {
        "wind_speed": dict(diagnostics),
        "air_density": density_diagnostics,
    }

    selected_mae = diagnostics["regression_mae"] if use_regression else diagnostics["baseline_mae"]
    mae = float(selected_mae) if selected_mae is not None else None
    recent_mean = _mean([value for _, value in recent])
    variance = _mean([(value - recent_mean) ** 2 for _, value in recent])
    uncertainty = max(0.25, mae or 0.0, sqrt(variance) * 0.55)

    result = []
    for index, forecast_date in enumerate(targets):
        wind = max(0.0, wind_forecast[index])
        lower = max(0.0, wind - uncertainty * 1.64)
        upper = wind + uncertainty * 1.64
        density = density_forecast[index]
        power = power_from_wind(wind, capacity_kw, density)
        result.append(
            {
                "date": forecast_date.isoformat(),
                "wind_speed": round(wind, 3),
                "power_output": round(power, 2),
                "energy_mwh": round(power * 24 / 1000, 4),
                "air_density": round(density, 4),
                "lower": round(lower, 3),
                "upper": round(upper, 3),
            }
        )
    return result, mae, len(daily), diagnostics


def build_forecast(turbines: list[dict], readings_by_turbine: dict[int, list[dict]], days: int) -> dict:
    dated_rows = [rows for rows in readings_by_turbine.values() if rows]
    if not dated_rows:
        return {
            "model_version": "validated-regression-baseline-2.0",
            "model_basis": "per-site autoregressive regression for wind speed and air density, selected against statistical baselines by rolling-validation MAE, with baseline fallback",
            "backtest_mae": None,
            "validation": {"strategy": "per-site rolling-origin validation", "regression_sites": 0, "baseline_sites": 0},
            "models_by_turbine": {},
            "training": {
                "latest_observation": None,
                "forecast_start": None,
                "daily_site_records": 0,
                "wind_points": len(turbines),
            },
            "data": [],
            "by_turbine": {str(turbine["id"]): [] for turbine in turbines},
        }
    latest = max(datetime.fromisoformat(rows[-1]["timestamp"]).date() for rows in dated_rows)
    start = date.today()
    by_turbine = {}
    maes = []
    daily_records = 0
    models_by_turbine = {}
    for turbine in turbines:
        if not readings_by_turbine[turbine["id"]]:
            by_turbine[str(turbine["id"])] = []
            continue
        rows, mae, count, diagnostics = _series_forecast(
            readings_by_turbine[turbine["id"]], start, days, turbine["capacity_kw"]
        )
        by_turbine[str(turbine["id"])] = rows
        models_by_turbine[str(turbine["id"])] = diagnostics
        if mae is not None:
            maes.append(mae)
        daily_records += count

    fleet = []
    for index in range(days):
        point_rows = [rows[index] for rows in by_turbine.values() if len(rows) > index]
        if not point_rows:
            continue
        fleet.append(
            {
                "date": point_rows[0]["date"],
                "wind_speed": round(_mean([row["wind_speed"] for row in point_rows]), 3),
                "power_output": round(sum(row["power_output"] for row in point_rows), 2),
                "energy_mwh": round(sum(row["energy_mwh"] for row in point_rows), 4),
                "air_density": round(_mean([row["air_density"] for row in point_rows]), 4),
                "lower": round(_mean([row["lower"] for row in point_rows]), 3),
                "upper": round(_mean([row["upper"] for row in point_rows]), 3),
            }
        )
    return {
        "model_version": "validated-regression-baseline-2.0",
        "model_basis": "per-site autoregressive regression for wind speed and air density, selected against statistical baselines by rolling-validation MAE, with baseline fallback",
        "backtest_mae": round(_mean(maes), 3) if maes else None,
        "validation": {
            "strategy": "per-site rolling-origin validation",
            "metric": "mean absolute error (m/s)",
            "regression_sites": sum(model["selected_model"] == "autoregressive_regression" for model in models_by_turbine.values()),
            "baseline_sites": sum(model["selected_model"] == "statistical_baseline" for model in models_by_turbine.values()),
        },
        "models_by_turbine": models_by_turbine,
        "training": {
            "latest_observation": latest.isoformat(),
            "forecast_start": start.isoformat(),
            "daily_site_records": daily_records,
            "wind_points": len(turbines),
        },
        "data": fleet,
        "by_turbine": by_turbine,
    }
