#!/usr/bin/env python3
"""Convert the supplied ZETDC polygon shapefiles to compact GeoJSON.

This intentionally uses only the Python standard library so the source GIS data
can be refreshed in a clean checkout without installing GDAL/GeoPandas.
"""

import argparse
import json
import struct
from pathlib import Path
from zipfile import ZipFile


LAYERS = {
    "regions": {
        "shp": "region & districts boundaries/zetdc regions.shp",
        "dbf": "region & districts boundaries/zetdc regions.dbf",
        "fields": ("gid", "province", "prov_code", "centre"),
    },
    "districts": {
        "shp": "region & districts boundaries/zetdc districts.shp",
        "dbf": "region & districts boundaries/zetdc districts.dbf",
        "fields": ("code", "parentcode", "name", "type"),
    },
}


def read_dbf(data):
    count = struct.unpack_from("<I", data, 4)[0]
    header_size, record_size = struct.unpack_from("<HH", data, 8)
    fields = []
    offset = 32
    while offset < header_size - 1 and data[offset] != 0x0D:
        name = data[offset:offset + 11].split(b"\0", 1)[0].decode("ascii")
        fields.append((name, data[offset + 16]))
        offset += 32
    rows = []
    for index in range(count):
        record = data[header_size + index * record_size:header_size + (index + 1) * record_size]
        cursor = 1
        row = {}
        for name, width in fields:
            row[name] = record[cursor:cursor + width].decode("latin1").strip()
            cursor += width
        rows.append(row)
    return rows


def signed_area(ring):
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:])) / 2


def point_in_ring(point, ring):
    x, y = point
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y):
            crossing = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < crossing:
                inside = not inside
    return inside


def polygon_geometry(rings):
    # ESRI outer rings are clockwise. Attach counter-clockwise holes to the
    # smallest containing outer ring; tolerate malformed winding as a fallback.
    outers = [ring for ring in rings if signed_area(ring) < 0]
    holes = [ring for ring in rings if signed_area(ring) >= 0]
    if not outers:
        outers, holes = rings, []
    polygons = [[outer] for outer in outers]
    for hole in holes:
        containers = [
            (abs(signed_area(outer)), index)
            for index, outer in enumerate(outers)
            if point_in_ring(hole[0], outer)
        ]
        if containers:
            polygons[min(containers)[1]].append(hole)
        else:
            polygons.append([hole])
    return {"type": "Polygon", "coordinates": polygons[0]} if len(polygons) == 1 else {"type": "MultiPolygon", "coordinates": polygons}


def read_shapes(data):
    if struct.unpack_from("<I", data, 32)[0] not in (5, 15, 25):
        raise ValueError("Only polygon shapefiles are supported")
    shapes = []
    offset = 100
    while offset + 8 <= len(data):
        content_words = struct.unpack_from(">I", data, offset + 4)[0]
        content = data[offset + 8:offset + 8 + content_words * 2]
        offset += 8 + content_words * 2
        shape_type = struct.unpack_from("<I", content, 0)[0]
        if shape_type == 0:
            shapes.append(None)
            continue
        part_count, point_count = struct.unpack_from("<II", content, 36)
        part_starts = list(struct.unpack_from(f"<{part_count}I", content, 44))
        points_offset = 44 + part_count * 4
        points = [
            list(struct.unpack_from("<dd", content, points_offset + index * 16))
            for index in range(point_count)
        ]
        ends = part_starts[1:] + [point_count]
        rings = [points[start:end] for start, end in zip(part_starts, ends)]
        for ring in rings:
            if ring and ring[0] != ring[-1]:
                ring.append(ring[0])
        shapes.append(polygon_geometry(rings))
    return shapes


def convert(archive_path, layer_name):
    definition = LAYERS[layer_name]
    with ZipFile(archive_path) as archive:
        rows = read_dbf(archive.read(definition["dbf"]))
        shapes = read_shapes(archive.read(definition["shp"]))
    features = []
    for row, geometry in zip(rows, shapes):
        if geometry is None:
            continue
        properties = {field: row.get(field, "") for field in definition["fields"]}
        features.append({"type": "Feature", "properties": properties, "geometry": geometry})
    return {"type": "FeatureCollection", "name": f"zetdc_{layer_name}", "features": features}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--frontend", type=Path, default=Path("frontend/public/gis"))
    parser.add_argument("--backend", type=Path, default=Path("backend/data/gis"))
    args = parser.parse_args()
    args.frontend.mkdir(parents=True, exist_ok=True)
    args.backend.mkdir(parents=True, exist_ok=True)
    for layer_name in LAYERS:
        collection = convert(args.archive, layer_name)
        payload = json.dumps(collection, separators=(",", ":"))
        (args.backend / f"zetdc-{layer_name}.geojson").write_text(payload)
        # Only regional geometry is rendered on the fleet map. District polygons
        # remain server-side for turbine drill-down assignment.
        if layer_name == "regions":
            (args.frontend / f"zetdc-{layer_name}.geojson").write_text(payload)
        print(f"{layer_name}: {len(collection['features'])} features")


if __name__ == "__main__":
    main()
