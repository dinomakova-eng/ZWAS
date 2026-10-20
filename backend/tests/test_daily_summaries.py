from app.data import daily_summaries


def test_daily_summaries_are_compact_and_cover_all_points():
    rows = daily_summaries(90)

    assert len(rows) < 1000
    assert {row["turbine_id"] for row in rows} == set(range(1, 9))
    assert all(row["records"] > 0 for row in rows)
    assert all("wind_speed" in row and "energy_produced_mwh" in row for row in rows)
