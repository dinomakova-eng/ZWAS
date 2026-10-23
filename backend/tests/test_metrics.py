from app.metrics import calculate_metrics

def test_metrics_calculate_measured_wind_and_uptime():
    result = calculate_metrics([
        {"wind_speed": 5, "wind_speed_min": 3, "wind_speed_max": 7, "wind_direction": 350, "availability_pct": 100},
        {"wind_speed": 10, "wind_speed_min": 8, "wind_speed_max": 12, "wind_direction": 10, "availability_pct": 100},
    ])
    assert result["average_wind_speed"] == 7.5
    assert result["wind_speed_stddev"] == 2.5
    assert result["min_wind_speed"] == 3
    assert result["max_wind_speed"] == 12
    assert result["average_wind_direction"] in {0.0, 360.0}
    assert result["uptime"] == 100.0


def test_metrics_surface_measured_environment_and_quality():
    readings = [
        {"turbine_id": 1, "timestamp": "2026-01-01T00:00:00+02:00", "wind_speed": 4, "wind_speed_min": 3.5, "wind_speed_max": 4.5, "wind_direction": 80, "temperature": 20, "humidity": 60, "air_pressure": 900, "air_density": 1.0555, "data_quality_pct": 98, "availability_pct": 98},
        {"turbine_id": 1, "timestamp": "2026-01-01T00:10:00+02:00", "wind_speed": 5, "wind_speed_min": 4.5, "wind_speed_max": 5.5, "wind_direction": 100, "temperature": 22, "humidity": 64, "air_pressure": 902, "air_density": 1.0495, "data_quality_pct": 100, "availability_pct": 100},
    ]

    result = calculate_metrics(readings)

    assert result["average_wind_direction"] == 90
    assert result["average_temperature_c"] == 21
    assert result["average_humidity_pct"] == 62
    assert result["average_air_density_kg_m3"] == 1.0525
    assert result["data_quality_pct"] == 99


def test_metrics_pool_source_interval_standard_deviation():
    result = calculate_metrics([
        {"wind_speed": 5, "wind_speed_stddev": 1.0, "availability_pct": 100},
        {"wind_speed": 5, "wind_speed_stddev": 1.0, "availability_pct": 100},
    ])

    assert result["average_wind_speed"] == 5
    assert result["wind_speed_stddev"] == 1
