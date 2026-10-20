def calculate_metrics(readings, capacity_kw):
    if not readings:
        return {"average_wind_speed": 0, "min_wind_speed": 0, "max_wind_speed": 0, "total_power_output": 0, "capacity_factor": 0, "uptime": 0, "anomalies": 0}
    winds = [r["wind_speed"] for r in readings]
    power = [r["power_output"] for r in readings]
    anomalies = sum(1 for a, b in zip(power, power[1:]) if a - b > capacity_kw * .55)
    energy_kwh = sum(r.get("energy_produced_mwh", 0) for r in readings) * 1000
    total_output = energy_kwh if energy_kwh else sum(power)
    availability = [r.get("availability_pct") for r in readings if r.get("availability_pct") is not None]
    uptime = sum(availability) / len(availability) if availability else sum(p > 0 for p in power) / len(power) * 100
    latest_by_point = {}
    for reading in readings:
        point_id = reading.get("turbine_id")
        if point_id is not None:
            latest_by_point[point_id] = reading
    environmental = lambda name: [r[name] for r in readings if r.get(name) is not None]
    quality = environmental("data_quality_pct")
    temperatures = environmental("temperature")
    humidity = environmental("humidity")
    pressure = environmental("air_pressure")
    density = environmental("air_density")
    energy_mwh = sum(r.get("energy_produced_mwh", 0) for r in readings)
    revenue = sum(r.get("estimated_revenue_usd", r.get("energy_produced_mwh", 0) * 82) for r in readings)
    return {
        "average_wind_speed": round(sum(winds)/len(winds), 2),
        "min_wind_speed": min(winds),
        "max_wind_speed": max(winds),
        "total_power_output": round(total_output, 1),
        "current_power_output_kw": round(sum(r["power_output"] for r in latest_by_point.values()) if latest_by_point else power[-1], 2),
        "energy_mwh": round(energy_mwh, 3),
        "estimated_revenue_usd": round(revenue, 2),
        "capacity_factor": round(sum(power)/(len(power)*capacity_kw)*100, 1) if capacity_kw else 0,
        "uptime": round(uptime, 1),
        "data_quality_pct": round(sum(quality) / len(quality), 2) if quality else 0,
        "average_temperature_c": round(sum(temperatures) / len(temperatures), 2) if temperatures else None,
        "average_humidity_pct": round(sum(humidity) / len(humidity), 2) if humidity else None,
        "average_air_pressure_hpa": round(sum(pressure) / len(pressure), 2) if pressure else None,
        "average_air_density_kg_m3": round(sum(density) / len(density), 4) if density else None,
        "reporting_points": len(latest_by_point) if latest_by_point else 1,
        "records": len(readings),
        "first_reading_at": readings[0].get("timestamp"),
        "last_reading_at": readings[-1].get("timestamp"),
        "anomalies": anomalies,
    }
