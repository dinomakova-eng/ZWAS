from app.data import latest_reported_month, monthly_history


def test_monthly_history_covers_archive_years_and_metrics():
    history = monthly_history()

    assert 2025 in history["years"]
    assert 2026 in history["years"]
    assert {metric["key"] for metric in history["metrics"]} == {
        "wind_speed", "wind_speed_min", "wind_speed_max", "wind_direction",
        "temperature", "humidity", "air_pressure", "air_density",
        "availability_pct", "data_quality_pct",
    }
    assert all(month["records"] > 0 for month in history["months"])
    assert all(month["wind_points"] > 0 for month in history["months"])
    assert all(month["points"] for month in history["months"])
    assert all(month["days"] for month in history["months"])
    assert all(day["records"] > 0 for month in history["months"] for day in month["days"])
    assert {point["turbine_id"] for point in history["wind_points"]} == set(range(1, 9))
    assert all(day["points"] for month in history["months"] for day in month["days"])
    assert all(
        sum(point["records"] for point in day["points"]) == day["records"]
        for month in history["months"] for day in month["days"]
    )


def test_latest_reported_month_uses_the_last_month_with_mast_records():
    latest = latest_reported_month()

    assert latest is not None
    assert latest["key"] == monthly_history()["months"][-1]["key"]
    assert latest["records"] > 0
