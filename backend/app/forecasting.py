"""Transparent wind forecasts trained from the imported mast observations."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from math import cos, pi, sin, sqrt

def _daily_metric(readings: list[dict], metric: str) -> list[tuple[date, float]]:
    grouped = defaultdict(list)
    for reading in readings:
        value = reading.get(metric)
        if value is not None:
            grouped[datetime.fromisoformat(reading["timestamp"]).date()].append(float(value))
    return [(day, sum(values) / len(values)) for day, values in sorted(grouped.items())]


def _daily_metric_stddev(readings: list[dict], metric: str) -> list[tuple[date, float]]:
    """Combine within-interval and between-interval population variance by day."""
    grouped = defaultdict(list)
    for reading in readings:
        value = reading.get(metric)
        if value is None:
            continue
        interval_stddev = reading.get(f"{metric}_stddev")
        grouped[datetime.fromisoformat(reading["timestamp"]).date()].append(
            (float(value), float(interval_stddev) if interval_stddev is not None else 0.0)
        )
    result = []
    for day, values in sorted(grouped.items()):
        centre = _mean([value for value, _ in values])
        variance = _mean([
            interval_stddev ** 2 + (value - centre) ** 2
            for value, interval_stddev in values
        ])
        result.append((day, sqrt(max(0.0, variance))))
    return result


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
    last_observation = daily[-1][0] if daily else targets[0]
    predictions = []
    for index, target in enumerate(targets):
        target_day = target.timetuple().tm_yday
        seasonal_values = []
        for observed_on, value in daily:
            observed_day = observed_on.timetuple().tm_yday
            distance = min(abs(target_day - observed_day), 366 - abs(target_day - observed_day))
            if distance <= 35:
                seasonal_values.append((value, 1.0 / (1.0 + distance)))
        seasonal = (
            sum(value * weight for value, weight in seasonal_values)
            / sum(weight for _, weight in seasonal_values)
            if seasonal_values else baseline
        )
        weekday_adjustment = weekday_means.get(target.weekday(), baseline) - baseline
        lead_days = max(index + 1, (target - last_observation).days)
        trend_adjustment = trend * min(lead_days, 45) * max(0.0, 1.0 - lead_days / 180.0)
        predictions.append(max(
            0.0,
            baseline * 0.50 + seasonal * 0.35 + (baseline + weekday_adjustment) * 0.15 + trend_adjustment,
        ))
    return predictions


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
    annual_angle = 2 * pi * forecast_date.timetuple().tm_yday / 365.25
    return [
        1.0,
        position / max(scale, 1),
        sin(weekday_angle),
        cos(weekday_angle),
        sin(annual_angle),
        cos(annual_angle),
        values[-1],
        _mean(values[-7:]),
        _mean(values[-30:]),
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


def _series_forecast(readings: list[dict], start: date, days: int) -> tuple[list[dict], float | None, int, dict]:
    daily = _daily_wind(readings)
    targets = [start + timedelta(days=index) for index in range(days)]
    diagnostics = _select_model(daily)
    baseline_forecast = _baseline_values(daily, targets)
    regression_forecast = _regression_values(daily, targets)
    use_regression = diagnostics["selected_model"] == "autoregressive_regression" and regression_forecast is not None
    wind_forecast = regression_forecast if use_regression else baseline_forecast

    variability_daily = _daily_metric_stddev(readings, "wind_speed")
    variability_diagnostics = _select_model(variability_daily)
    variability_baseline = _baseline_values(variability_daily, targets)
    variability_regression = _regression_values(variability_daily, targets)
    use_variability_regression = (
        variability_diagnostics["selected_model"] == "autoregressive_regression"
        and variability_regression is not None
    )
    variability_forecast = variability_regression if use_variability_regression else variability_baseline

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

    result = []
    for index, forecast_date in enumerate(targets):
        wind = max(0.0, wind_forecast[index])
        variability = max(0.0, variability_forecast[index])
        uncertainty = max(0.25, sqrt(variability ** 2 + (mae or 0.0) ** 2))
        lower = max(0.0, wind - uncertainty * 1.64)
        upper = wind + uncertainty * 1.64
        density = density_forecast[index]
        result.append(
            {
                "date": forecast_date.isoformat(),
                "wind_speed": round(wind, 3),
                "_wind_speed_stddev": round(variability, 3),
                "_forecast_uncertainty": round(uncertainty, 3),
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
            "model_version": "validated-regression-2.1",
            "model_basis": "per-site forecasts for mean wind and air density; models are selected against statistical baselines by rolling-validation MAE",
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
        rows, mae, count, diagnostics = _series_forecast(readings_by_turbine[turbine["id"]], start, days)
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
        fleet_wind = _mean([row["wind_speed"] for row in point_rows])
        fleet_uncertainty = sqrt(_mean([
            row["_forecast_uncertainty"] ** 2 + (row["wind_speed"] - fleet_wind) ** 2
            for row in point_rows
        ]))
        fleet.append(
            {
                "date": point_rows[0]["date"],
                "wind_speed": round(fleet_wind, 3),
                "air_density": round(_mean([row["air_density"] for row in point_rows]), 4),
                "lower": round(max(0.0, fleet_wind - fleet_uncertainty * 1.64), 3),
                "upper": round(fleet_wind + fleet_uncertainty * 1.64, 3),
            }
        )
    return {
        "model_version": "validated-regression-2.1",
        "model_basis": "per-site forecasts for mean wind and air density; models are selected against statistical baselines by rolling-validation MAE",
        "backtest_mae": round(_mean(maes), 3) if maes else None,
        "validation": {
            "strategy": "per-site rolling-origin validation",
            "metric": "mean absolute error (m/s)",
            "interval_basis": "uncertainty combines source-observation spread with validated mean-forecast MAE",
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
        "by_turbine": {
            turbine_id: [
                {key: value for key, value in row.items() if not key.startswith("_")}
                for row in rows
            ]
            for turbine_id, rows in by_turbine.items()
        },
    }


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    midpoint = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / 2


def _source_calibration(
    primary_readings: list[dict],
    live_readings: list[dict],
    metric: str,
) -> dict:
    """Estimate a robust local correction from overlapping daily records."""
    primary = dict(_daily_metric(primary_readings, metric))
    live = dict(_daily_metric(live_readings, metric))
    overlap = sorted(set(primary) & set(live))[-120:]
    if len(overlap) < 7:
        return {"bias": 0.0, "mae": None, "days": len(overlap)}
    limit = 3.0 if metric == "wind_speed" else 0.2
    bias = max(-limit, min(limit, _median([primary[day] - live[day] for day in overlap])))
    mae = _mean([abs(primary[day] - (live[day] + bias)) for day in overlap])
    return {"bias": bias, "mae": mae, "days": len(overlap)}


def _fleet_from_sites(by_turbine: dict[str, list[dict]], days: int) -> list[dict]:
    fleet = []
    for index in range(days):
        point_rows = [rows[index] for rows in by_turbine.values() if len(rows) > index]
        if not point_rows:
            continue
        fleet_wind = _mean([row["wind_speed"] for row in point_rows])
        point_uncertainties = [
            max(
                0.25,
                (row["upper"] - row["wind_speed"]) / 1.64,
                (row["wind_speed"] - row["lower"]) / 1.64,
            )
            for row in point_rows
        ]
        fleet_uncertainty = sqrt(_mean([
            uncertainty ** 2 + (row["wind_speed"] - fleet_wind) ** 2
            for row, uncertainty in zip(point_rows, point_uncertainties)
        ]))
        densities = [row["air_density"] for row in point_rows if row.get("air_density") is not None]
        fleet.append({
            "date": point_rows[0]["date"],
            "wind_speed": round(fleet_wind, 3),
            "air_density": round(_mean(densities), 4) if densities else None,
            "lower": round(max(0.0, fleet_wind - fleet_uncertainty * 1.64), 3),
            "upper": round(fleet_wind + fleet_uncertainty * 1.64, 3),
        })
    return fleet


def build_live_informed_forecast(
    turbines: list[dict],
    readings_by_turbine: dict[int, list[dict]],
    days: int,
    provider_by_turbine: dict[int, list[dict]],
    live_history_by_turbine: dict[int, list[dict]],
    source_mode: str,
) -> dict:
    """Blend direct live forecasts with locally validated adaptive forecasts.

    Live-map forecasts use Open-Meteo directly for its available horizon. Mast
    forecasts first correct that provider signal against overlapping ZETDC
    measurements. The adaptive model supplies a smooth seasonal extension once
    the provider horizon ends.
    """
    forecast = build_forecast(turbines, readings_by_turbine, days)
    if not any(provider_by_turbine.values()):
        return forecast

    hybrid_by_turbine: dict[str, list[dict]] = {}
    provider_sites = 0
    provider_day_counts = []
    calibration_maes = []
    calibration_days = []
    for turbine in turbines:
        turbine_id = turbine["id"]
        site_key = str(turbine_id)
        base_rows = [dict(row) for row in forecast["by_turbine"].get(site_key, [])]
        base_by_date = {row["date"]: row for row in base_rows}
        provider_rows = [
            row for row in provider_by_turbine.get(turbine_id, [])
            if row.get("date") in base_by_date
        ]
        if not provider_rows:
            hybrid_by_turbine[site_key] = base_rows
            continue

        provider_sites += 1
        provider_day_counts.append(len(provider_rows))
        if source_mode == "mast":
            wind_calibration = _source_calibration(
                readings_by_turbine.get(turbine_id, []),
                live_history_by_turbine.get(turbine_id, []),
                "wind_speed",
            )
            density_calibration = _source_calibration(
                readings_by_turbine.get(turbine_id, []),
                live_history_by_turbine.get(turbine_id, []),
                "air_density",
            )
        else:
            wind_calibration = {"bias": 0.0, "mae": None, "days": 0}
            density_calibration = {"bias": 0.0, "mae": None, "days": 0}

        if wind_calibration["mae"] is not None:
            calibration_maes.append(float(wind_calibration["mae"]))
        calibration_days.append(int(wind_calibration["days"]))
        direct_by_date = {}
        for provider_row in provider_rows:
            base = base_by_date[provider_row["date"]]
            wind = max(0.0, float(provider_row["wind_speed"]) + float(wind_calibration["bias"]))
            daily_minimum = max(0.0, float(provider_row.get("wind_speed_min", wind)) + float(wind_calibration["bias"]))
            daily_maximum = max(wind, float(provider_row.get("wind_speed_max", wind)) + float(wind_calibration["bias"]))
            uncertainty = max(
                0.25,
                float(provider_row.get("wind_speed_stddev") or 0.0),
                float(wind_calibration["mae"] or 0.0),
            )
            provider_density = provider_row.get("air_density")
            density = (
                float(provider_density) + float(density_calibration["bias"])
                if provider_density is not None else base.get("air_density")
            )
            direct_by_date[provider_row["date"]] = {
                "date": provider_row["date"],
                "wind_speed": round(wind, 3),
                "air_density": round(density, 4) if density is not None else None,
                "lower": round(max(0.0, min(daily_minimum, wind - uncertainty * 1.64)), 3),
                "upper": round(max(daily_maximum, wind + uncertainty * 1.64), 3),
            }

        last_provider_date = max(direct_by_date)
        last_direct = direct_by_date[last_provider_date]
        last_base = base_by_date[last_provider_date]
        wind_bridge = last_direct["wind_speed"] - last_base["wind_speed"]
        density_bridge = (
            last_direct["air_density"] - last_base["air_density"]
            if last_direct.get("air_density") is not None and last_base.get("air_density") is not None else 0.0
        )
        last_provider_day = date.fromisoformat(last_provider_date)
        hybrid_rows = []
        for base in base_rows:
            if base["date"] in direct_by_date:
                hybrid_rows.append(direct_by_date[base["date"]])
                continue
            lead_after_provider = (date.fromisoformat(base["date"]) - last_provider_day).days
            if lead_after_provider <= 0:
                hybrid_rows.append(base)
                continue
            bridge_weight = max(0.0, 1.0 - lead_after_provider / 30.0)
            shift = wind_bridge * bridge_weight
            density_shift = density_bridge * bridge_weight
            hybrid_rows.append({
                **base,
                "wind_speed": round(max(0.0, base["wind_speed"] + shift), 3),
                "air_density": round(base["air_density"] + density_shift, 4)
                if base.get("air_density") is not None else None,
                "lower": round(max(0.0, base["lower"] + shift), 3),
                "upper": round(max(0.0, base["upper"] + shift), 3),
            })
        hybrid_by_turbine[site_key] = hybrid_rows

        diagnostic = forecast["models_by_turbine"].setdefault(site_key, {})
        wind_diagnostic = {
            "forecast_method": "mast_live_calibrated" if source_mode == "mast" else "open_meteo_direct",
            "provider_days": len(provider_rows),
            "calibration_days": wind_calibration["days"],
            "live_bias_mps": round(float(wind_calibration["bias"]), 3),
            "provider_mae": round(float(wind_calibration["mae"]), 3)
            if wind_calibration["mae"] is not None else None,
        }
        density_diagnostic = {
            "forecast_method": "mast_live_calibrated" if source_mode == "mast" else "open_meteo_direct",
            "provider_days": len(provider_rows),
            "calibration_days": density_calibration["days"],
            "provider_mae": round(float(density_calibration["mae"]), 4)
            if density_calibration["mae"] is not None else None,
        }
        diagnostic.update(wind_diagnostic)
        diagnostic.setdefault("metrics", {}).setdefault("wind_speed", {}).update(wind_diagnostic)
        diagnostic["metrics"].setdefault("air_density", {}).update(density_diagnostic)

    forecast["by_turbine"] = hybrid_by_turbine
    forecast["data"] = _fleet_from_sites(hybrid_by_turbine, days)
    forecast["model_version"] = "live-informed-hybrid-3.0"
    forecast["forecast_method"] = (
        "Open-Meteo forecast calibrated with Wind Masts and seasonal extension"
        if source_mode == "mast"
        else "Open-Meteo direct forecast with seasonal adaptive extension"
    )
    forecast["model_basis"] = (
        "direct daily live forecasts are bias-corrected against overlapping Wind Masts observations; "
        "the validated seasonal model extends beyond the provider horizon"
        if source_mode == "mast"
        else "daily refreshed Open-Meteo forecasts are used directly for the provider horizon; "
        "the validated seasonal model extends longer planning horizons"
    )
    forecast["validation"]["provider_sites"] = provider_sites
    forecast["validation"]["calibration_days"] = max(calibration_days, default=0)
    forecast["training"]["provider_forecast_days"] = max(provider_day_counts, default=0)
    forecast["training"]["live_history_days"] = len({
        row["timestamp"][:10]
        for rows in live_history_by_turbine.values()
        for row in rows
    })
    if calibration_maes:
        forecast["backtest_mae"] = round(_mean(calibration_maes), 3)
    return forecast
