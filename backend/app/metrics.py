import math


def _circular_mean(values):
    if not values:
        return None
    sine = sum(math.sin(math.radians(value)) for value in values)
    cosine = sum(math.cos(math.radians(value)) for value in values)
    return math.degrees(math.atan2(sine, cosine)) % 360


def _population_stddev(values, interval_stddevs=None):
    if not values:
        return 0.0
    centre = sum(values) / len(values)
    interval_stddevs = interval_stddevs or [0.0 for _ in values]
    return math.sqrt(sum(
        interval_stddev ** 2 + (value - centre) ** 2
        for value, interval_stddev in zip(values, interval_stddevs)
    ) / len(values))


def calculate_metrics(readings):
    """Summarise measured wind and environmental telemetry."""
    if not readings:
        return {
            "average_wind_speed": 0,
            "wind_speed_stddev": 0,
            "min_wind_speed": 0,
            "max_wind_speed": 0,
            "average_wind_direction": None,
            "uptime": 0,
            "data_quality_pct": 0,
            "reporting_points": 0,
            "records": 0,
        }

    winds = [float(reading["wind_speed"]) for reading in readings]
    wind_stddevs = [float(reading.get("wind_speed_stddev") or 0.0) for reading in readings]
    minimums = [float(reading.get("wind_speed_min", reading["wind_speed"])) for reading in readings]
    maximums = [float(reading.get("wind_speed_max", reading["wind_speed"])) for reading in readings]
    directions = [float(reading["wind_direction"]) for reading in readings if reading.get("wind_direction") is not None]
    availability = [float(reading["availability_pct"]) for reading in readings if reading.get("availability_pct") is not None]
    quality = [float(reading["data_quality_pct"]) for reading in readings if reading.get("data_quality_pct") is not None]
    temperatures = [float(reading["temperature"]) for reading in readings if reading.get("temperature") is not None]
    humidity = [float(reading["humidity"]) for reading in readings if reading.get("humidity") is not None]
    pressure = [float(reading["air_pressure"]) for reading in readings if reading.get("air_pressure") is not None]
    density = [float(reading["air_density"]) for reading in readings if reading.get("air_density") is not None]
    latest_by_point = {
        reading["turbine_id"]: reading
        for reading in readings
        if reading.get("turbine_id") is not None
    }
    direction = _circular_mean(directions)

    return {
        "average_wind_speed": round(sum(winds) / len(winds), 2),
        "wind_speed_stddev": round(_population_stddev(winds, wind_stddevs), 2),
        "min_wind_speed": round(min(minimums), 2),
        "max_wind_speed": round(max(maximums), 2),
        "average_wind_direction": round(direction, 1) if direction is not None else None,
        "uptime": round(sum(availability) / len(availability), 1) if availability else 0,
        "data_quality_pct": round(sum(quality) / len(quality), 2) if quality else 0,
        "average_temperature_c": round(sum(temperatures) / len(temperatures), 2) if temperatures else None,
        "average_humidity_pct": round(sum(humidity) / len(humidity), 2) if humidity else None,
        "average_air_pressure_hpa": round(sum(pressure) / len(pressure), 2) if pressure else None,
        "average_air_density_kg_m3": round(sum(density) / len(density), 4) if density else None,
        "reporting_points": len(latest_by_point) if latest_by_point else 1,
        "records": len(readings),
        "first_reading_at": readings[0].get("timestamp"),
        "last_reading_at": readings[-1].get("timestamp"),
    }
