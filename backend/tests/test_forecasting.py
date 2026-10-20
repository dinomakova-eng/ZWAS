from datetime import date, timedelta

from app.data import READINGS_BY_TURBINE, turbines
from app.forecasting import _select_model, build_forecast


def test_forecast_is_trained_from_all_eight_measured_points():
    forecast = build_forecast(turbines(), READINGS_BY_TURBINE, 30)

    assert forecast["model_version"] == "validated-regression-baseline-2.0"
    assert forecast["training"]["wind_points"] == 8
    assert forecast["training"]["daily_site_records"] > 100
    assert len(forecast["data"]) == 30
    assert all("air_density" in row for row in forecast["data"])
    assert set(forecast["by_turbine"]) == {str(asset["id"]) for asset in turbines()}
    assert all(len(rows) == 30 for rows in forecast["by_turbine"].values())
    assert all("air_density" in row for rows in forecast["by_turbine"].values() for row in rows)
    assert forecast["training"]["forecast_start"] == date.today().isoformat()
    assert forecast["data"][0]["date"] == date.today().isoformat()
    assert set(forecast["models_by_turbine"]) == {str(asset["id"]) for asset in turbines()}
    assert forecast["validation"]["regression_sites"] + forecast["validation"]["baseline_sites"] == 8
    assert all(model["selected_model"] in {"autoregressive_regression", "statistical_baseline"} for model in forecast["models_by_turbine"].values())
    assert all(set(model["metrics"]) == {"wind_speed", "air_density"} for model in forecast["models_by_turbine"].values())


def test_regression_is_selected_when_it_beats_the_baseline():
    start = date(2026, 1, 1)
    daily = [(start + timedelta(days=index), 3.0 + index * 0.08) for index in range(70)]

    selection = _select_model(daily)

    assert selection["selected_model"] == "autoregressive_regression"
    assert selection["regression_mae"] < selection["baseline_mae"]


def test_short_history_uses_statistical_fallback():
    start = date(2026, 1, 1)
    selection = _select_model([(start + timedelta(days=index), 4.0) for index in range(10)])

    assert selection["selected_model"] == "statistical_baseline"
    assert selection["validation_days"] == 0
