# ZETDC Wind Assessment System

Operational prototype for monitoring and analysing eight Zimbabwe wind-assessment points. The system combines imported ZETDC wind-mast observations with live Open-Meteo conditions, ZETDC GIS boundaries, grid infrastructure, reporting, and per-site forecasts.

The active system presents measured wind and environmental source metrics only. Formula-derived generation fields are not calculated or exposed. The former formula implementation is retained, dormant, in `backend/app/wind_energy.py` for possible later reactivation: `P = 0.5 × air density × swept area × wind speed³ × power coefficient × system efficiency`.

## Current capabilities

- Fleet overview with measured mean wind speed, minimum/maximum wind, wind direction, environmental, quality, and availability metrics.
- Interactive ZETDC region, wind-point, and electricity-infrastructure maps.
- Live 10 m Open-Meteo conditions alongside measured ZETDC mast data.
- Historical monthly and daily drill-downs for both mast measurements and the accumulated live-model archive, with CSV/Excel sharing tools.
- Filter-aware reports, advanced analytics, site comparisons, and PDF/CSV exports.
- One-to-180-day forecasts for mean wind speed and air density. The first 16 days use the daily-refreshed Open-Meteo forecast; ZETDC mast forecasts correct that signal against overlapping local measurements. A season-aware, rolling-validated regression or statistical baseline extends longer horizons, and 90% wind planning intervals include source variability and validation error.
- Administrator views for source data, wind points, forecast provenance, and users.

## Current data snapshot

`backend/data/wind_points.json.gz` contains 145,817 normalized observations from 1,098 CSV files across eight measured wind points. The combined archive runs from 18 August 2025 to 13 September 2026; each point has its own start and end date, so recent-data windows are calculated per point. Source wind speed is converted from centimetres per second to metres per second during import. The current normalized archive has interval mean/minimum/maximum wind but no interval variability channel. The backend derives wind variability internally for forecast planning ranges, and the importer retains a source variability channel when one is present in a future Windographer export.

The active points are Chivui, Dave, Dickson, Dotito, Mangwe, Mt Darwin, Plumtree, and Vungui. Coordinates come from `backend/data/wind_sites.csv`, and region/district assignments come from the supplied ZETDC boundary data.

Additional sources are kept distinct in the API and interface:

- `backend/data/open_meteo_live_wind.json`: cached hourly Open-Meteo weather for the eight wind-point locations plus a current-month-to-date comparison for Zimbabwe's 10 provinces. Each successful Harare-day refresh requests a rolling 92-day source window and the 16-day provider forecast, merges completed hours into a retained live History archive, excludes future hours from historical screens, and keeps the last successful cache if the provider is unavailable.
- `frontend/public/gis/zesa-grid-infrastructure.geojson`: 870 mapped grid features (401 stations, 252 transformers, 133 overhead features, and 84 cable features).
- IRENA Global Atlas/Vortex: on-demand long-term annual wind resource at 100 m.
- OpenStreetMap Nominatim: on-demand reverse-geocoded map location names.

## Run locally

Prerequisites are Python 3 with `venv`, Node.js/npm, and `curl`. From the project root run:

```sh
./start-system.sh
```

The launcher creates `backend/.venv` and installs frontend packages when they are missing, starts both services, waits for their health checks, and stops them together when you press Ctrl+C.

Open:

- Web interface: `http://localhost:5173`
- API: `http://localhost:8000`
- Interactive API documentation: `http://localhost:8000/docs`
- Health check: `http://localhost:8000/health`

Development-only accounts:

| Access | EC number or alias | Password |
| --- | --- | --- |
| Administrator | `ze9160517` or `admin@zetdc` | `ZETDC2026!` |
| Read only | `EC-01477` or `viewer@zetdc` | `ZETDC2026!` |

These credentials and the default JWT secret are not suitable for production. See `backend/SSO_INTEGRATION.md` for the identity-provider replacement point.

### Run the services separately

Prepare and start the API:

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cd backend
.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

In a second terminal, from the project root:

```sh
cd frontend
npm install
npm run dev
```

The Vite development server proxies `/api` to `http://127.0.0.1:8000`, so keep the API on port 8000 unless `frontend/vite.config.ts` is updated too. `FRONTEND_HOST` and `FRONTEND_PORT` may be supplied to `start-system.sh` when only the web listener needs to change.

## Validate changes

Run backend tests:

```sh
cd backend
.venv/bin/python -m pytest -q
```

Run the TypeScript check and production frontend build:

```sh
cd frontend
npm run build
```

## Refresh source data

### Wind archive

Rebuild the normalized runtime dataset from a source directory or archive:

```sh
python3 tools/import_wind_archive.py "/path/to/Wind_Data"
```

The importer accepts the `Wind data` and legacy `Zimbabwe RAW Wind Data` layouts and requires all eight source folders. Optional `--sites` and `--output` arguments override the coordinate CSV and generated dataset paths. The importer validates coordinate aliases before replacing the runtime dataset.

### ZETDC boundaries

Regenerate regional and district GeoJSON from an updated shapefile archive:

```sh
python3 tools/convert_zetdc_boundaries.py "/path/to/ZETDC region & districts boundaries.zip"
```

Regional geometry is written to both the backend and frontend. District geometry remains server-side and is used for wind-point assignments and report filters.

### Grid infrastructure

`tools/build_grid_infrastructure_geojson.py` builds the environment-map layer from ZETDC station, transformer, cable, and overhead SQL exports. Before running it, update the script's `SOURCES` paths to the local export locations, then run:

```sh
python3 tools/build_grid_infrastructure_geojson.py
```

## Configuration and operating notes

- `JWT_SECRET` sets the API signing secret. Always provide a strong value outside local development.
- `NOMINATIM_URL`, `NOMINATIM_USER_AGENT`, and `NOMINATIM_EMAIL` configure OpenStreetMap reverse geocoding.
- The dormant wind formula and its last settings are preserved in `backend/app/wind_energy.py` and `backend/data/wind_energy_settings.json`; neither is connected to active API responses or interface views.
- Open-Meteo, IRENA, and Nominatim features require outbound internet access; imported mast data and the cached map layers remain local.
- Opening an authenticated system session requests a global Open-Meteo refresh. The Live wind speed summary drill-down also provides a confirmed **Refresh live data** action; either path replaces the shared cache and reloads the active workspace so maps, summaries, analytics, reports, predictions, and History use the same snapshot.
- Saved reports and users created from the administrator interface are held in backend process memory and reset on restart.
- `docker-compose.yml` is development scaffolding for the services and TimescaleDB. The current prototype still reads its operational dataset from local files and does not persist application data to PostgreSQL.

## Project structure

- `frontend/`: React, TypeScript, Vite, Leaflet, and Recharts interface.
- `backend/app/`: FastAPI routes, authentication boundary, data services, metrics, environmental integrations, and forecasting.
- `backend/data/`: normalized mast data, live-weather cache, coordinates, and server-side GIS layers.
- `backend/tests/`: data, GIS, metric, history, environment, and forecasting tests.
- `backend/migrations/`: proposed PostgreSQL/TimescaleDB schema for a persistent deployment.
- `tools/`: wind-data, GIS, grid, and spreadsheet generation utilities.
- `system-screenshots/`: captured interface pages and packaged screenshots.
