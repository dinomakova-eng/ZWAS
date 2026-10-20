from app.metrics import calculate_metrics

def test_metrics_calculate_capacity_and_uptime():
    result = calculate_metrics([{"wind_speed": 5, "power_output": 50}, {"wind_speed": 10, "power_output": 100}], 100)
    assert result["average_wind_speed"] == 7.5
    assert result["capacity_factor"] == 75.0
    assert result["uptime"] == 100.0


def test_metrics_surface_measured_environment_and_current_power():
    readings = [
        {"turbine_id": 1, "timestamp": "2026-01-01T00:00:00+02:00", "wind_speed": 4, "power_output": 100, "temperature": 20, "humidity": 60, "air_pressure": 900, "air_density": 1.0555, "data_quality_pct": 98, "availability_pct": 98, "energy_produced_mwh": .02},
        {"turbine_id": 1, "timestamp": "2026-01-01T00:10:00+02:00", "wind_speed": 5, "power_output": 120, "temperature": 22, "humidity": 64, "air_pressure": 902, "air_density": 1.0495, "data_quality_pct": 100, "availability_pct": 100, "energy_produced_mwh": .02},
    ]

    result = calculate_metrics(readings, 2500)

    assert result["current_power_output_kw"] == 120
    assert result["energy_mwh"] == .04
    assert result["average_temperature_c"] == 21
    assert result["average_humidity_pct"] == 62
    assert result["average_air_density_kg_m3"] == 1.0525
    assert result["data_quality_pct"] == 99
