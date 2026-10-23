import pytest

from app.data import daily_summaries, daily_summaries_for


def test_daily_summaries_are_compact_and_cover_all_points():
    rows = daily_summaries(90)

    assert len(rows) < 1000
    assert {row["turbine_id"] for row in rows} == set(range(1, 9))
    assert all(row["records"] > 0 for row in rows)
    assert all({"wind_speed", "wind_speed_stddev", "wind_speed_min", "wind_speed_max", "wind_direction"} <= set(row) for row in rows)
    assert all(row["wind_speed_stddev"] >= 0 for row in rows)
    assert all("energy_produced_mwh" not in row and "power_output" not in row for row in rows)


def test_daily_summary_pools_interval_and_between_interval_variance():
    rows = daily_summaries_for({1: [
        {"turbine_id": 1, "timestamp": "2026-01-01T00:00:00+02:00", "wind_speed": 4, "wind_speed_stddev": 1, "wind_speed_min": 2, "wind_speed_max": 6},
        {"turbine_id": 1, "timestamp": "2026-01-01T00:10:00+02:00", "wind_speed": 6, "wind_speed_stddev": 1, "wind_speed_min": 4, "wind_speed_max": 8},
    ]}, 1)

    assert rows[0]["wind_speed"] == 5
    assert rows[0]["wind_speed_stddev"] == pytest.approx(2 ** 0.5, abs=1e-6)
