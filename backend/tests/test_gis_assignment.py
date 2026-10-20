from app.data import turbines


def test_every_turbine_is_assigned_to_authoritative_gis_areas():
    assets = turbines()

    assert len(assets) == 8
    assert all(asset["region"] != "Unassigned Region" for asset in assets)
    assert all(asset["district"] != "Unassigned District" for asset in assets)
    assert {asset["source_folder"] for asset in assets} == {
        "chivui", "Dave", "Dickson", "Dotito", "mangwe", "Mt Darwin", "Plumtree", "Vungui"
    }
    assert all(asset["synthetic"] is False for asset in assets)
    assert all(asset["telemetry_source"] == "measured wind mast" for asset in assets)
