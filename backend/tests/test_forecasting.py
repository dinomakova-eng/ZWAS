from datetime import date, timedelta

from app.data import READINGS_BY_TURBINE, turbines
from app.forecasting import _select_model, build_forecast, build_live_informed_forecast


def test_forecast_is_trained_from_all_eight_measured_points():
    forecast = build_forecast(turbines(), READINGS_BY_TURBINE, 30)

    assert forecast["model_version"] == "validated-regression-2.1"
    assert forecast["training"]["wind_points"] == 8
    assert forecast["training"]["daily_site_records"] > 100
    assert len(forecast["data"]) == 30
    assert all("air_density" in row for row in forecast["data"])
    assert all(row["lower"] <= row["wind_speed"] <= row["upper"] for row in forecast["data"])
    assert all("wind_speed_stddev" not in row and "forecast_uncertainty" not in row for row in forecast["data"])
    assert all("energy_mwh" not in row and "power_output" not in row for row in forecast["data"])
    assert set(forecast["by_turbine"]) == {str(asset["id"]) for asset in turbines()}
    assert all(len(rows) == 30 for rows in forecast["by_turbine"].values())
    assert all("air_density" in row for rows in forecast["by_turbine"].values() for row in rows)
    assert all("wind_speed_stddev" not in row and "forecast_uncertainty" not in row for rows in forecast["by_turbine"].values() for row in rows)
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


def test_live_informed_mast_forecast_uses_daily_provider_variation_and_local_bias():
    start = date.today() - timedelta(days=70)
    mast_rows = []
    live_rows = []
    for index in range(70):
        observed_on = start + timedelta(days=index)
        live_wind = 3.0 + (index % 5) * 0.2
        common = {
            "turbine_id": 1,
            "timestamp": f"{observed_on.isoformat()}T12:00:00+02:00",
            "wind_speed_stddev": 0.4,
        }
        live_rows.append({**common, "wind_speed": live_wind, "air_density": 1.1})
        mast_rows.append({**common, "wind_speed": live_wind + 1.0, "air_density": 1.2})

    provider = [{
        "date": (date.today() + timedelta(days=index)).isoformat(),
        "wind_speed": wind,
        "wind_speed_min": wind - 0.5,
        "wind_speed_max": wind + 0.5,
        "wind_speed_stddev": 0.4,
        "air_density": 1.1,
    } for index, wind in enumerate((3.0, 5.0, 4.0))]

    forecast = build_live_informed_forecast(
        [{"id": 1, "name": "Test mast"}],
        {1: mast_rows},
        10,
        {1: provider},
        {1: live_rows},
        "mast",
    )

    direct = forecast["by_turbine"]["1"][:3]
    assert [row["wind_speed"] for row in direct] == [4.0, 6.0, 5.0]
    assert len({row["wind_speed"] for row in direct}) == 3
    assert forecast["model_version"] == "live-informed-hybrid-3.0"
    assert forecast["training"]["provider_forecast_days"] == 3
    assert forecast["models_by_turbine"]["1"]["calibration_days"] == 70
    assert forecast["models_by_turbine"]["1"]["live_bias_mps"] == 1.0
    assert forecast["models_by_turbine"]["1"]["metrics"]["wind_speed"]["forecast_method"] == "mast_live_calibrated"
    assert forecast["models_by_turbine"]["1"]["metrics"]["air_density"]["provider_mae"] == 0.0
