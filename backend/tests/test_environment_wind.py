from datetime import date, timedelta

from app.data import turbines
from app.environment_wind import build_environment_wind_summary


def _live_window():
    start = date.today()
    daily = [
        {
            "date": (start + timedelta(days=index)).isoformat(),
            "average": 4.0 + index * 0.1,
            "minimum": 2.0 + index * 0.05,
            "maximum": 7.0 + index * 0.1,
            "samples": 24,
        }
        for index in range(7)
    ]
    return {
        "observed": {
            "average": 4.2,
            "minimum": 1.1,
            "maximum": 8.0,
            "start_date": (start - timedelta(days=7)).isoformat(),
            "end_date": (start - timedelta(days=1)).isoformat(),
            "days": 7,
            "samples": 168,
        },
        "observed_daily": [
            {
                "date": (start - timedelta(days=7 - index)).isoformat(),
                "average": 4.0 + index * 0.05,
                "minimum": 1.0 + index * 0.05,
                "maximum": 7.0 + index * 0.05,
                "samples": 24,
            }
            for index in range(7)
        ],
        "forecast": {
            "average": 4.3,
            "minimum": 2.0,
            "maximum": 7.6,
            "start_date": start.isoformat(),
            "end_date": (start + timedelta(days=6)).isoformat(),
            "days": 7,
            "samples": 168,
        },
        "forecast_daily": daily,
    }


def test_environment_summary_uses_closest_point_and_two_wind_sources():
    asset = turbines()[0]
    summary = build_environment_wind_summary(asset["lat"], asset["lon"], _live_window())

    assert summary["closest_wind_point"]["id"] == asset["id"]
    assert summary["closest_wind_point"]["distance_km"] == 0
    assert summary["point"]["region"] == asset["region"]
    assert summary["point"]["district"] == asset["district"]
    assert summary["observed"]["live"]["days"] == 7
    assert summary["observed"]["mast"]["days"] == 7
    assert len(summary["observed"]["live_daily"]) == 7
    assert len(summary["observed"]["mast_daily"]) == 7
    assert summary["forecast"]["live"]["days"] == 7
    assert summary["forecast"]["mast"]["days"] == 7
    assert summary["forecast"]["blended"]["days"] == 7
    assert len(summary["forecast"]["daily"]) == 7
    assert all(
        row["lower"] <= row["wind_speed"] <= row["upper"]
        for row in summary["forecast"]["daily"]
    )
    assert summary["method"]["live_weight_pct"] + summary["method"]["mast_weight_pct"] == 100


def test_environment_summary_falls_back_to_mast_forecast_without_live_data():
    asset = turbines()[0]
    summary = build_environment_wind_summary(asset["lat"], asset["lon"], {})

    assert summary["observed"]["live"] is None
    assert summary["forecast"]["live"] is None
    assert summary["forecast"]["blended"] == summary["forecast"]["mast"]
    assert summary["method"]["live_available"] is False
