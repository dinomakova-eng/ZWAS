CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE provinces (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, geojson JSONB, region_size_rank SMALLINT);
CREATE TABLE turbines (id SERIAL PRIMARY KEY, name TEXT NOT NULL, province_id INTEGER REFERENCES provinces(id), lat DOUBLE PRECISION NOT NULL, lon DOUBLE PRECISION NOT NULL, install_date DATE, capacity_kw INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'operational', metadata JSONB DEFAULT '{}');
CREATE TABLE readings (turbine_id INTEGER REFERENCES turbines(id), timestamp TIMESTAMPTZ NOT NULL, wind_speed REAL NOT NULL, power_output REAL NOT NULL, rpm REAL, temperature REAL, PRIMARY KEY(turbine_id, timestamp));
SELECT create_hypertable('readings', by_range('timestamp'), if_not_exists => TRUE);
CREATE TABLE predictions (id BIGSERIAL PRIMARY KEY, turbine_id INTEGER REFERENCES turbines(id), generated_at TIMESTAMPTZ NOT NULL, forecast_date DATE NOT NULL, predicted_wind_speed REAL, predicted_power_output REAL, confidence_interval JSONB, model_version TEXT NOT NULL);
CREATE TABLE users (ec_number TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')), last_login TIMESTAMPTZ);
CREATE TABLE reports (id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, created_by TEXT REFERENCES users(ec_number), config JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
