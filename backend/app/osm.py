"""Small, cached OpenStreetMap reverse-geocoding client for map inspections."""

from functools import lru_cache
import json
import os
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen


NOMINATIM_URL = os.getenv("NOMINATIM_URL", "https://nominatim.openstreetmap.org/reverse")
NOMINATIM_USER_AGENT = os.getenv(
    "NOMINATIM_USER_AGENT",
    "ZETDC-WTMS/1.0 (Zimbabwe environment map)",
)
NOMINATIM_EMAIL = os.getenv("NOMINATIM_EMAIL", "")

_request_lock = threading.Lock()
_last_request_at = 0.0

_LOCATION_KEYS = (
    "house_name",
    "amenity",
    "tourism",
    "historic",
    "natural",
    "man_made",
    "aeroway",
    "railway",
    "road",
    "neighbourhood",
    "suburb",
    "hamlet",
    "village",
    "town",
    "city",
    "municipality",
    "district",
    "county",
    "state",
)


def _best_location_name(payload: dict) -> str:
    if payload.get("name"):
        return str(payload["name"])
    address = payload.get("address") or {}
    for key in _LOCATION_KEYS:
        if address.get(key):
            return str(address[key])
    return str(payload.get("display_name", "Unknown location")).split(",", 1)[0]


@lru_cache(maxsize=4096)
def reverse_osm_location(latitude: float, longitude: float) -> dict:
    """Resolve one rounded coordinate while respecting Nominatim's public rate limit."""
    params = {
        "format": "jsonv2",
        "lat": f"{latitude:.5f}",
        "lon": f"{longitude:.5f}",
        "zoom": 18,
        "addressdetails": 1,
        "namedetails": 1,
        "accept-language": "en",
        "layer": "address,natural,manmade",
    }
    if NOMINATIM_EMAIL:
        params["email"] = NOMINATIM_EMAIL
    request = Request(
        f"{NOMINATIM_URL}?{urlencode(params)}",
        headers={"User-Agent": NOMINATIM_USER_AGENT, "Accept": "application/json"},
    )

    global _last_request_at
    with _request_lock:
        wait_seconds = 1.05 - (time.monotonic() - _last_request_at)
        if wait_seconds > 0:
            time.sleep(wait_seconds)
        try:
            with urlopen(request, timeout=12) as response:
                payload = json.load(response)
        finally:
            _last_request_at = time.monotonic()

    address = payload.get("address") or {}
    return {
        "name": _best_location_name(payload),
        "display_name": payload.get("display_name") or _best_location_name(payload),
        "feature_type": payload.get("type") or payload.get("category") or "place",
        "osm_type": payload.get("osm_type"),
        "osm_id": payload.get("osm_id"),
        "address": address,
        "source": "OpenStreetMap via Nominatim",
    }
