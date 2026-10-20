import asyncio
import json
import os
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import jwt
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from .identity import authenticate_ec_number
from .data import turbines, recent_readings, daily_summaries, daily_summaries_for, monthly_history, monthly_history_for, refresh_energy_calculations, DATA_SOURCE, READINGS_BY_TURBINE
from .forecasting import build_forecast
from .metrics import calculate_metrics
from .open_meteo import collect_open_meteo, cached_open_meteo, live_readings, live_stations
from .osm import reverse_osm_location
from .wind_energy import get_wind_energy_settings, save_wind_energy_settings, swept_area_m2

app = FastAPI(title="Zesa Wind Assessment System API")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_methods=["*"], allow_headers=["*"])
security = HTTPBearer()
SECRET = os.getenv("JWT_SECRET", "development-secret-change-me")
saved_reports = []
admin_users = [
    {"ec_number": "ze9160517", "name": "Farai Makova", "email": "farai.makova@zetdc.co.zw", "phone": "+263 77 200 0182", "department": "Renewables Operations", "position": "System Administrator", "company": "ZESA", "role": "System Administrator", "status": "Active", "last_login": "Today, 08:31", "created_date": "2025-01-12"},
    {"ec_number": "EC-01477", "name": "Rudo Ncube", "email": "rudo.ncube@zetdc.co.zw", "phone": "+263 77 200 1477", "department": "Asset Performance", "position": "Data Analyst", "company": "ZESA", "role": "Data Analyst", "status": "Active", "last_login": "Yesterday, 16:12", "created_date": "2025-06-24"},
]


def _source_meta(source: str):
    if source == "live":
        return {"source": "open_meteo_live", "label": "Live Wind Maps Data", "provider": "Open-Meteo"}
    return {"source": "zetdc_mast", "label": "ZETDC Wind Mast data", "provider": "ZETDC"}


def _capacity_by_id():
    return {int(asset["id"]): asset["capacity_kw"] for asset in turbines()}


def _live_rows():
    return live_readings(turbines(), _capacity_by_id())


def _live_by_turbine():
    grouped = defaultdict(list)
    for reading in _live_rows():
        grouped[reading["turbine_id"]].append(reading)
    return grouped


def _readings_for_source(source: str, days: int):
    if source == "live":
        return _live_rows()
    return recent_readings(days)


def _daily_for_source(source: str, days: int):
    if source == "live":
        return daily_summaries_for(_live_by_turbine(), days)
    return daily_summaries(days)


def _history_for_source(source: str):
    if source == "live":
        return monthly_history_for(_live_rows(), live_stations(turbines()))
    return monthly_history()


async def _daily_open_meteo_refresh():
    while True:
        try:
            await asyncio.to_thread(collect_open_meteo, turbines())
        except Exception:
            pass
        await asyncio.sleep(60 * 60 * 24)

class Login(BaseModel): ec_number: str; password: str
class Report(BaseModel): title: str; config: dict
class AdminUser(BaseModel):
    ec_number: str
    name: str
    email: str
    phone: str = ""
    department: str = ""
    position: str = ""
    company: str = "ZESA"
    role: str = "Guest"

class WindEnergySettings(BaseModel):
    blade_radius_m: float = 30.0
    power_coefficient: float = 0.42
    system_efficiency: float = 0.92
    sample_interval_minutes: float = 10.0
    tariff_usd_per_mwh: float = 82.0
    cap_to_capacity: bool = True

def _wind_energy_payload(settings: dict):
    return {
        **settings,
        "rotor_swept_area_m2": round(swept_area_m2(settings), 3),
        "formula": "P = 0.5 * rho * A * v^3 * Cp * efficiency",
        "energy_formula": "Energy MWh = power kW * interval hours / 1000",
        "source_note": "Formula constants are applied to ZETDC Wind Mast data, Live Wind Maps Data, reports, and predictions.",
    }

def user(token: HTTPAuthorizationCredentials = Depends(security)):
    try: return jwt.decode(token.credentials, SECRET, algorithms=["HS256"])
    except jwt.PyJWTError: raise HTTPException(401, "Invalid session")
def admin(current=Depends(user)):
    if current["role"] != "admin": raise HTTPException(403, "Administrator access required")
    return current
@app.on_event("startup")
async def start_open_meteo_collector():
    asyncio.create_task(_daily_open_meteo_refresh())
@app.get("/health")
def health(): return {"status": "healthy", "service": "Zesa Wind Assessment System"}
@app.post("/auth/login")
def login(payload: Login):
    identity = authenticate_ec_number(payload.ec_number, payload.password)
    if not identity: raise HTTPException(401, "Invalid EC number or password")
    claims = {"sub": identity.ec_number, "name": identity.name, "role": identity.role, "exp": datetime.now(timezone.utc) + timedelta(hours=8)}
    return {"token": jwt.encode(claims, SECRET, algorithm="HS256"), "user": {"ec_number": identity.ec_number, "name": identity.name, "role": identity.role}}
@app.get("/turbines")
def list_turbines(source: str = "zetdc", current=Depends(user)):
    return live_stations(turbines()) if source == "live" else turbines()
@app.get("/live-wind")
def live_wind(current=Depends(user)):
    payload = cached_open_meteo(turbines())
    return {"metadata": payload, "stations": live_stations(turbines()), "readings": _live_rows()}
@app.get("/metrics")
def metrics(source: str = "zetdc", current=Depends(user)):
    current_readings = _readings_for_source(source, 1)
    fleet = calculate_metrics(current_readings, sum(t["capacity_kw"] for t in turbines()))
    provinces = []
    for province in sorted(set(t["province"] for t in turbines())):
        turbine_ids = [t["id"] for t in turbines() if t["province"] == province]
        rs = [r for r in current_readings if r["turbine_id"] in turbine_ids]
        m = calculate_metrics(rs, sum(t["capacity_kw"] for t in turbines() if t["id"] in turbine_ids))
        provinces.append({"province": province, "turbines": len(turbine_ids), **m})
    regions = []
    for region in sorted(set(t["region"] for t in turbines())):
        turbine_ids = [t["id"] for t in turbines() if t["region"] == region]
        rs = [r for r in current_readings if r["turbine_id"] in turbine_ids]
        capacity = sum(t["capacity_kw"] for t in turbines() if t["id"] in turbine_ids)
        regions.append({"region": region, "turbines": len(turbine_ids), **calculate_metrics(rs, capacity)})
    return {"fleet": fleet, "regions": regions, "provinces": provinces, "source": DATA_SOURCE, "data_source": _source_meta(source)}
@app.get("/readings")
def get_readings(days: int = 7, source: str = "zetdc", current=Depends(user)):
    return _readings_for_source(source, days)
@app.get("/analytics/daily")
def analytics_daily(days: int = 90, source: str = "zetdc", current=Depends(user)):
    return _daily_for_source(source, days)
@app.get("/history")
def history(source: str = "zetdc", current=Depends(user)):
    return {**_history_for_source(source), "data_source": _source_meta(source)}
@app.get("/predictions")
def predictions(days: int = 30, source: str = "zetdc", current=Depends(user)):
    rows_by_turbine = _live_by_turbine() if source == "live" else READINGS_BY_TURBINE
    assets = live_stations(turbines()) if source == "live" else turbines()
    return {**build_forecast(assets, rows_by_turbine, min(max(days, 1), 180)), "data_source": _source_meta(source)}

@app.get("/environment/wind-resource")
def environment_wind_resource(lat: float, lon: float, current=Depends(user)):
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "Coordinates must be valid WGS84 latitude and longitude values")
    span = 0.04
    params = urlencode({
        "service": "WMS",
        "version": "1.1.1",
        "request": "GetFeatureInfo",
        "layers": "vortex:M.100.year",
        "query_layers": "vortex:M.100.year",
        "styles": "ku_wind_speed",
        "srs": "EPSG:4326",
        "bbox": f"{lon - span},{lat - span},{lon + span},{lat + span}",
        "width": 101,
        "height": 101,
        "x": 50,
        "y": 50,
        "info_format": "application/json",
        "feature_count": 1,
    })
    request = Request(
        f"https://irena-ga.azurewebsites.net/geoserver/wms?{params}",
        headers={"User-Agent": "ZETDC-WTMS/1.0"},
    )
    try:
        with urlopen(request, timeout=12) as response:
            payload = json.load(response)
        wind_speed = payload["features"][0]["properties"]["GRAY_INDEX"]
        return {
            "latitude": lat,
            "longitude": lon,
            "wind_speed_ms": round(float(wind_speed), 3),
            "height_m": 100,
            "period": "long-term annual average",
            "source": "IRENA Global Atlas / Vortex",
            "layer": "vortex:M.100.year",
        }
    except (OSError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(502, "IRENA wind resource value is temporarily unavailable") from error

@app.get("/environment/location")
def environment_location(lat: float, lon: float, current=Depends(user)):
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "Coordinates must be valid WGS84 latitude and longitude values")
    try:
        return {
            "latitude": lat,
            "longitude": lon,
            **reverse_osm_location(round(lat, 5), round(lon, 5)),
        }
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(502, "OpenStreetMap location is temporarily unavailable") from error

@app.get("/reports")
def reports(current=Depends(user)): return saved_reports
@app.post("/reports")
def save_report(report: Report, current=Depends(user)):
    item={"id":len(saved_reports)+1,"title":report.title,"config":report.config,"created_by":current["name"],"created_at":datetime.now(timezone.utc).isoformat()}; saved_reports.append(item); return item
@app.get("/admin/users")
def users(current=Depends(admin)): return admin_users
@app.post("/admin/users")
def create_user(payload: AdminUser, current=Depends(admin)):
    if any(item["ec_number"].lower() == payload.ec_number.lower() for item in admin_users):
        raise HTTPException(409, "Employee number already exists")
    item = {**payload.model_dump(), "status": "Active", "last_login": "Never", "created_date": datetime.now(timezone.utc).date().isoformat()}
    admin_users.append(item)
    return item

@app.get("/admin/wind-energy")
def wind_energy_settings(current=Depends(admin)):
    return _wind_energy_payload(get_wind_energy_settings())

@app.put("/admin/wind-energy")
def update_wind_energy_settings(payload: WindEnergySettings, current=Depends(admin)):
    settings = save_wind_energy_settings(payload.model_dump())
    refresh_energy_calculations()
    return _wind_energy_payload(settings)
