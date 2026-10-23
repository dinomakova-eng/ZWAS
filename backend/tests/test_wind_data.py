from app.data import DATA_SOURCE, recent_readings, turbines


def test_archive_populates_exactly_eight_measured_points():
    assets = turbines()

    assert DATA_SOURCE["folder_count"] == 8
    assert DATA_SOURCE["csv_file_count"] == 1098
    assert len(assets) == 8
    assert all(asset["reading_count"] > 0 for asset in assets)
    assert all(asset["last_reading_at"] for asset in assets)
    assert all(asset["wind_speed_stddev"] >= 0 for asset in assets)
    assert DATA_SOURCE["coordinate_file"] == "wind_sites.csv"
    assert {(asset["source_folder"], asset["lat"], asset["lon"]) for asset in assets} == {
        ("chivui", -18.95275, 30.95575),
        ("Dave", -16.513594, 30.65469),
        ("Dickson", -16.65000778, 30.81354367),
        ("Dotito", -16.5008172, 31.5447511),
        ("mangwe", -20.652067, 28.07175),
        ("Mt Darwin", -16.3207148, 31.680027),
        ("Plumtree", -20.40238535, 27.89082731),
        ("Vungui", -19.51669444, 29.46691667),
    }


def test_recent_window_keeps_every_point_visible():
    rows = recent_readings(1)

    assert {row["turbine_id"] for row in rows} == {asset["id"] for asset in turbines()}
    assert all(row["measurement_source"] == "mast" for row in rows)
    assert all(0 <= row["wind_speed"] < 25 for row in rows)
    assert all("energy_produced_mwh" not in row and "power_output" not in row for row in rows)
