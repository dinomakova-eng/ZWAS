import pytest

from app.open_meteo import PROVINCE_LOCATIONS, current_month_period, summarize_province_period


def _province_payload():
    locations = []
    for index, _province in enumerate(PROVINCE_LOCATIONS):
        locations.append({
            "location_id": index,
            "hourly": {
                "time": ["2026-09-01T00:00", "2026-09-01T01:00"],
                "wind_speed_10m": [index + 1.0, index + 3.0],
                "wind_direction_10m": [90.0, 90.0],
            },
        })
    return {
        "province_period": {
            "source": "open_meteo_historical_forecast",
            "provider": "Open-Meteo",
            "report_month": "2026-09",
            "start_date": "2026-09-01",
            "end_date": "2026-09-13",
            "collected_for": "2026-10-22",
            "locations": locations,
        },
    }


def test_province_period_summary_covers_all_zimbabwe_provinces():
    summary = summarize_province_period(
        _province_payload(), "2026-09", "2026-09-01", "2026-09-13"
    )

    assert summary["available"] is True
    assert summary["average_wind_speed"] == pytest.approx(6.5)
    assert summary["average_wind_direction"] == pytest.approx(90.0)
    assert summary["records"] == 20
    assert len(summary["provinces"]) == 10
    assert {item["province"] for item in summary["provinces"]} == {
        "Bulawayo", "Harare", "Manicaland", "Mashonaland Central",
        "Mashonaland East", "Mashonaland West", "Masvingo",
        "Matabeleland North", "Matabeleland South", "Midlands",
    }
    assert all(item["status"] == "reporting" for item in summary["provinces"])


def test_province_period_summary_keeps_ten_rows_when_live_data_is_unavailable():
    summary = summarize_province_period({}, "2026-09", "2026-09-01", "2026-09-13")

    assert summary["available"] is False
    assert summary["average_wind_speed"] is None
    assert len(summary["provinces"]) == 10
    assert all(item["status"] == "unavailable" for item in summary["provinces"])


def test_current_month_period_runs_from_first_of_month_through_today():
    period = current_month_period()

    assert period["start_date"] == f'{period["report_month"]}-01'
    assert period["end_date"].startswith(period["report_month"])


def test_current_month_summary_excludes_future_hours_from_today():
    period = current_month_period()
    payload = {
        "province_period": {
            "report_month": period["report_month"],
            "start_date": period["start_date"],
            "end_date": period["end_date"],
            "collected_at": f'{period["end_date"]}T07:30:00+00:00',
            "locations": [
                {
                    "location_id": index,
                    "hourly": {
                        "time": [f'{period["end_date"]}T09:00', f'{period["end_date"]}T10:00'],
                        "wind_speed_10m": [4.0, 20.0],
                        "wind_direction_10m": [90.0, 180.0],
                    },
                }
                for index, _province in enumerate(PROVINCE_LOCATIONS)
            ],
        },
    }

    summary = summarize_province_period(payload, **period)

    assert summary["records"] == 10
    assert summary["average_wind_speed"] == 4.0
