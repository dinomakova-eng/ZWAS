import asyncio

from app import open_meteo
from app import main


def _location(times, winds):
    return {
        "latitude": -17.8,
        "longitude": 31.0,
        "hourly": {
            "time": times,
            "wind_speed_10m": winds,
            "wind_direction_10m": [90.0] * len(times),
            "temperature_2m": [20.0] * len(times),
            "relative_humidity_2m": [50.0] * len(times),
            "surface_pressure": [900.0] * len(times),
        },
    }


def test_live_readings_exclude_hours_after_the_refresh_time(monkeypatch):
    payload = {
        "collected_at": "2026-10-23T10:30:00+00:00",
        "locations": [_location(
            ["2026-10-23T11:00", "2026-10-23T12:00", "2026-10-23T13:00"],
            [2.0, 4.0, 20.0],
        )],
    }
    monkeypatch.setattr(open_meteo, "cached_open_meteo", lambda _assets: payload)

    rows = open_meteo.live_readings([{"id": 1}])

    assert [row["wind_speed"] for row in rows] == [2.0, 4.0]
    assert all(row["timestamp"] <= "2026-10-23T12:00:00+02:00" for row in rows)


def test_live_forecast_days_preserve_provider_day_to_day_variation(monkeypatch):
    payload = {
        "collected_at": "2026-10-23T10:30:00+00:00",
        "locations": [_location(
            [
                "2026-10-23T12:00", "2026-10-23T13:00",
                "2026-10-24T12:00", "2026-10-24T13:00",
            ],
            [2.0, 4.0, 7.0, 9.0],
        )],
    }
    monkeypatch.setattr(open_meteo, "cached_open_meteo", lambda _assets: payload)
    monkeypatch.setattr(open_meteo, "_today_key", lambda: "2026-10-23")

    rows = open_meteo.live_forecast_days([{"id": 1}], days=2)[1]

    assert [row["wind_speed"] for row in rows] == [3.0, 8.0]
    assert rows[0]["wind_speed_min"] == 2.0
    assert rows[1]["wind_speed_max"] == 9.0


def test_daily_refresh_merges_completed_hours_into_live_history():
    cached = {
        "collected_at": "2026-10-22T10:30:00+00:00",
        "history_locations": [_location(["2026-10-22T12:00"], [3.0])],
    }
    fresh = {
        "collected_at": "2026-10-23T10:30:00+00:00",
        "locations": [_location(
            ["2026-10-23T12:00", "2026-10-23T13:00"],
            [4.0, 20.0],
        )],
    }

    history = open_meteo._merge_live_history(cached, fresh)

    assert history[0]["hourly"]["time"] == ["2026-10-22T12:00", "2026-10-23T12:00"]
    assert history[0]["hourly"]["wind_speed_10m"] == [3.0, 4.0]


def test_global_refresh_endpoint_forces_one_shared_cache_update(monkeypatch):
    calls = []
    payload = {
        "provider": "Open-Meteo",
        "collected_for": "2026-10-23",
        "collected_at": "2026-10-23T12:30:00+00:00",
        "observed_through": "2026-10-23T14:00",
        "locations": [{}] * 8,
        "history_locations": [{}] * 8,
    }
    monkeypatch.setattr(main, "last_forced_live_refresh", None)
    monkeypatch.setattr(
        main,
        "collect_open_meteo",
        lambda assets, period, force: calls.append((len(assets), period, force)) or payload,
    )

    result = asyncio.run(main.refresh_live_wind(current={"sub": "test"}))

    assert calls[0][0] == 8
    assert calls[0][2] is True
    assert result == {
        "status": "refreshed",
        "global": True,
        "provider": "Open-Meteo",
        "collected_for": "2026-10-23",
        "collected_at": "2026-10-23T12:30:00+00:00",
        "observed_through": "2026-10-23T14:00",
        "sites": 8,
        "history_sites": 8,
    }


def test_live_wind_endpoint_is_compact_unless_history_is_requested(monkeypatch):
    payload = {
        "provider": "Open-Meteo",
        "collected_for": "2026-10-23",
        "collected_at": "2026-10-23T12:30:00+00:00",
        "observed_through": "2026-10-23T14:00",
        "locations": [_location(["2026-10-23T14:00"], [4.2])],
        "history_locations": [_location(["2026-10-23T14:00"], [4.2])],
    }
    assets = [{
        "id": 1,
        "name": "Test point",
        "lat": -17.8,
        "lon": 31.0,
        "last_reading_at": "2026-10-22T12:00:00+02:00",
    }]
    monkeypatch.setattr(main, "turbines", lambda: assets)
    monkeypatch.setattr(main, "cached_open_meteo", lambda _assets: payload)

    compact = main.live_wind(current={"sub": "test"})
    detailed = main.live_wind(include_readings=True, current={"sub": "test"})

    assert compact["metadata"] == {
        "provider": "Open-Meteo",
        "collected_for": "2026-10-23",
        "collected_at": "2026-10-23T12:30:00+00:00",
        "observed_through": "2026-10-23T14:00",
    }
    assert len(compact["stations"]) == 1
    assert "readings" not in compact
    assert detailed["readings"][0]["wind_speed"] == 4.2
