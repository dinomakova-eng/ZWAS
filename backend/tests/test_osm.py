from app.osm import _best_location_name


def test_osm_location_prefers_exact_feature_name():
    payload = {
        "name": "Chiremba Road",
        "display_name": "Chiremba Road, Harare, Zimbabwe",
        "address": {"road": "Chiremba Road", "city": "Harare"},
    }
    assert _best_location_name(payload) == "Chiremba Road"


def test_osm_location_falls_back_to_most_specific_address_part():
    payload = {
        "display_name": "Dotito, Mount Darwin, Mashonaland Central, Zimbabwe",
        "address": {"village": "Dotito", "county": "Mount Darwin"},
    }
    assert _best_location_name(payload) == "Dotito"
