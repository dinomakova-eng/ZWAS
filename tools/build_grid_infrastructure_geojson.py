from __future__ import annotations

import json
import math
import re
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "station": Path("/Users/itops/Desktop/ZETDC GIS/station/station.sql"),
    "transformer": Path("/Users/itops/Desktop/ZETDC GIS/transformer/transformer.sql"),
    "cable": Path("/Users/itops/Desktop/ZETDC GIS/cable/cable.sql"),
    "overhead": Path("/Users/itops/Desktop/ZETDC GIS/overhead/overhead.sql"),
}
OUT = ROOT / "frontend/public/gis/zesa-grid-infrastructure.geojson"
MAX_LINE_FEATURES = 300
MAX_TRANSFORMERS = 4500
DISTRIBUTION_VOLTAGES = {11.0, 33.0}
ZIMBABWE_BOUNDS = {"lat": (-23.2, -15.2), "lon": (25.0, 34.2)}


def split_sql_values(values: str) -> list[str]:
    values = values.strip().rstrip(";").strip()
    if values.startswith("(") and values.endswith(")"):
        values = values[1:-1]
    result: list[str] = []
    current: list[str] = []
    quoted = False
    index = 0
    while index < len(values):
        char = values[index]
        if char == "'":
            if quoted and index + 1 < len(values) and values[index + 1] == "'":
                current.append("'")
                index += 2
                continue
            quoted = not quoted
            index += 1
            continue
        if char == "," and not quoted:
            result.append("".join(current).strip())
            current = []
        else:
            current.append(char)
        index += 1
    result.append("".join(current).strip())
    return result


def sql_value(value: str):
    value = value.strip()
    if value.upper() == "NULL":
        return None
    if value in {"t", "f"}:
        return value == "t"
    return value


def number(value, default=None):
    if value in (None, ""):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def in_bounds(lat: float, lon: float) -> bool:
    return ZIMBABWE_BOUNDS["lat"][0] <= lat <= ZIMBABWE_BOUNDS["lat"][1] and ZIMBABWE_BOUNDS["lon"][0] <= lon <= ZIMBABWE_BOUNDS["lon"][1]


def mentions_meter(*values) -> bool:
    return any(re.search(r"\bmeter(?:ing)?\b", str(value or ""), re.I) for value in values)


class WkbReader:
    def __init__(self, hex_value: str):
        self.data = bytes.fromhex(hex_value)
        self.offset = 0
        self.endian = "<"

    def byte(self) -> int:
        value = self.data[self.offset]
        self.offset += 1
        return value

    def uint32(self) -> int:
        value = struct.unpack_from(self.endian + "I", self.data, self.offset)[0]
        self.offset += 4
        return value

    def double(self) -> float:
        value = struct.unpack_from(self.endian + "d", self.data, self.offset)[0]
        self.offset += 8
        return value

    def geometry(self):
        byte_order = self.byte()
        self.endian = "<" if byte_order == 1 else ">"
        geom_type = self.uint32()
        if geom_type & 0x20000000:
            geom_type &= ~0x20000000
            self.uint32()
        if geom_type == 1:
            lon, lat = self.double(), self.double()
            return {"type": "Point", "coordinates": [lon, lat]}
        if geom_type == 2:
            return {"type": "LineString", "coordinates": [self.point() for _ in range(self.uint32())]}
        if geom_type == 3:
            rings = []
            for _ in range(self.uint32()):
                rings.append([self.point() for _ in range(self.uint32())])
            return {"type": "Polygon", "coordinates": rings}
        if geom_type == 5:
            return {"type": "MultiLineString", "coordinates": [self.geometry()["coordinates"] for _ in range(self.uint32())]}
        if geom_type == 6:
            return {"type": "MultiPolygon", "coordinates": [self.geometry()["coordinates"] for _ in range(self.uint32())]}
        raise ValueError(f"Unsupported WKB geometry type {geom_type}")

    def point(self) -> list[float]:
        return [self.double(), self.double()]


def centroid(geometry: dict) -> tuple[float, float] | None:
    points: list[list[float]] = []
    if geometry["type"] == "Point":
        lon, lat = geometry["coordinates"]
        return lat, lon
    if geometry["type"] == "MultiLineString":
        points = [point for line in geometry["coordinates"] for point in line]
    elif geometry["type"] == "MultiPolygon":
        points = [point for polygon in geometry["coordinates"] for ring in polygon for point in ring]
    elif geometry["type"] == "Polygon":
        points = [point for ring in geometry["coordinates"] for point in ring]
    if not points:
        return None
    return sum(point[1] for point in points) / len(points), sum(point[0] for point in points) / len(points)


def statements(path: Path):
    buffer: list[str] = []
    with path.open(errors="ignore") as handle:
        for line in handle:
            if not buffer and not line.startswith('INSERT INTO "public".'):
                continue
            buffer.append(line.rstrip("\n"))
            if line.rstrip().endswith(";"):
                yield "\n".join(buffer)
                buffer = []


def parse_insert(statement: str) -> tuple[list[str], list]:
    columns_match = re.search(r"\((.*?)\)\s+VALUES", statement, re.S)
    if not columns_match:
        return [], []
    columns = [item.strip().strip('"') for item in columns_match.group(1).split(",")]
    values = split_sql_values(statement.split(" VALUES ", 1)[1])
    return columns, [sql_value(value) for value in values]


def feature(geometry: dict, properties: dict) -> dict:
    return {"type": "Feature", "geometry": geometry, "properties": properties}


def build_station_features() -> list[dict]:
    results = []
    for statement in statements(SOURCES["station"]):
        columns, values = parse_insert(statement)
        row = dict(zip(columns, values))
        try:
            geometry = WkbReader(row["wkb_geometry"]).geometry()
        except Exception:
            continue
        if mentions_meter(row.get("name"), row.get("code"), row.get("type"), row.get("classification")):
            continue
        center = centroid(geometry)
        if not center or not in_bounds(center[0], center[1]):
            continue
        results.append(feature(geometry, {
            "asset_type": "station",
            "label": row.get("name") or row.get("code") or "Station",
            "code": row.get("code"),
            "station_type": row.get("type") or row.get("classification") or "Station",
            "voltage_kv": row.get("voltage"),
            "capacity": row.get("capacity"),
            "status": row.get("status"),
            "region": row.get("region"),
            "measure_lat": round(center[0], 6),
            "measure_lon": round(center[1], 6),
        }))
    return results


def build_transformer_features() -> list[dict]:
    results = []
    for statement in statements(SOURCES["transformer"]):
        columns, values = parse_insert(statement)
        row = dict(zip(columns, values))
        high_voltage = number(row.get("highvoltage"), 0)
        capacity = number(row.get("capacity"), 0)
        lat, lon = number(row.get("lat")), number(row.get("lon"))
        if lat is None or lon is None or not in_bounds(lat, lon):
            continue
        if mentions_meter(row.get("name"), row.get("sscode"), row.get("systemno"), row.get("application")):
            continue
        if high_voltage < 88 and capacity < 10000:
            continue
        results.append(feature({"type": "Point", "coordinates": [lon, lat]}, {
            "asset_type": "transformer",
            "label": row.get("name") or row.get("sscode") or "Transformer",
            "code": row.get("sscode"),
            "voltage_kv": high_voltage,
            "capacity_kva": capacity,
            "status": row.get("status"),
            "region": row.get("region"),
            "measure_lat": round(lat, 6),
            "measure_lon": round(lon, 6),
        }))
        if len(results) >= MAX_TRANSFORMERS:
            break
    return results


def build_line_features(source: str) -> list[dict]:
    results = []
    for statement in statements(SOURCES[source]):
        columns, values = parse_insert(statement)
        row = dict(zip(columns, values))
        voltage = number(row.get("voltagelevel"), 0)
        conductor = str(row.get("conductortype") or "").lower()
        if voltage < 88 or "service" in conductor:
            continue
        if mentions_meter(row.get("feedercode"), row.get("conductortype"), row.get("comments")):
            continue
        try:
            geometry = WkbReader(row["wkb_geometry"]).geometry()
        except Exception:
            continue
        center = centroid(geometry)
        if not center or not in_bounds(center[0], center[1]):
            continue
        results.append(feature(geometry, {
            "asset_type": source,
            "label": row.get("feedercode") or f"{source.title()} line",
            "voltage_kv": voltage,
            "conductor_type": row.get("conductortype"),
            "length_km": number(row.get("length")),
            "status": row.get("status"),
            "region": row.get("region"),
            "measure_lat": round(center[0], 6),
            "measure_lon": round(center[1], 6),
        }))
        if len(results) >= MAX_LINE_FEATURES:
            break
    return results


def build_distribution_overhead_features() -> list[dict]:
    """Keep every 11 kV and 33 kV span while emitting one browser layer per voltage."""
    networks = {
        voltage: {"lines": [], "segments": 0, "points": 0, "lat_sum": 0.0, "lon_sum": 0.0}
        for voltage in DISTRIBUTION_VOLTAGES
    }
    for statement in statements(SOURCES["overhead"]):
        columns, values = parse_insert(statement)
        row = dict(zip(columns, values))
        voltage = number(row.get("voltagelevel"))
        if voltage not in DISTRIBUTION_VOLTAGES:
            continue
        try:
            geometry = WkbReader(row["wkb_geometry"]).geometry()
        except Exception:
            continue
        if geometry["type"] == "LineString":
            lines = [geometry["coordinates"]]
        elif geometry["type"] == "MultiLineString":
            lines = geometry["coordinates"]
        else:
            continue
        network = networks[voltage]
        for line in lines:
            valid_line = [
                [round(float(point[0]), 6), round(float(point[1]), 6)]
                for point in line
                if len(point) >= 2 and in_bounds(float(point[1]), float(point[0]))
            ]
            if len(valid_line) < 2:
                continue
            network["lines"].append(valid_line)
            network["segments"] += 1
            network["points"] += len(valid_line)
            network["lat_sum"] += sum(float(point[1]) for point in valid_line)
            network["lon_sum"] += sum(float(point[0]) for point in valid_line)

    results = []
    for voltage in sorted(networks):
        network = networks[voltage]
        if not network["lines"] or not network["points"]:
            continue
        results.append(feature({"type": "MultiLineString", "coordinates": network["lines"]}, {
            "asset_type": "overhead",
            "grid_class": "distribution",
            "label": f"{int(voltage)} kV overhead distribution network",
            "voltage_kv": voltage,
            "segment_count": network["segments"],
            "status": "Mapped",
            "region": "National",
            "source_table": "overhead.sql",
            "measure_lat": round(network["lat_sum"] / network["points"], 6),
            "measure_lon": round(network["lon_sum"] / network["points"], 6),
        }))
    return results


def main():
    features = []
    features.extend(build_station_features())
    features.extend(build_transformer_features())
    features.extend(build_line_features("overhead"))
    features.extend(build_distribution_overhead_features())
    features.extend(build_line_features("cable"))
    collection = {"type": "FeatureCollection", "features": features}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(collection, separators=(",", ":")))
    counts = {}
    for item in features:
        kind = item["properties"]["asset_type"]
        counts[kind] = counts.get(kind, 0) + 1
    distribution_segments = {
        str(int(item["properties"]["voltage_kv"])): item["properties"]["segment_count"]
        for item in features
        if item["properties"].get("grid_class") == "distribution"
    }
    print(json.dumps({"output": str(OUT), "features": len(features), "counts": counts, "distribution_overhead_segments": distribution_segments}, indent=2))


if __name__ == "__main__":
    main()
