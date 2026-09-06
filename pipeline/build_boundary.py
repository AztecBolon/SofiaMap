#!/usr/bin/env python3
"""Reconstruct the Stolichna Community boundary polygon from a raw Overpass
`relation(...); out geom;` response (list of outer ways with inline geometry),
using the same approach as the previous session (shapely polygonize).
"""
import json
import sys
from shapely.geometry import LineString, mapping, shape
from shapely.ops import polygonize, unary_union

SRC = sys.argv[1] if len(sys.argv) > 1 else "/mnt/user-data/uploads/Downloads/sofia_stolichna_boundary.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/home/claude/sofiamap/raw/sofia_boundary.geojson"

data = json.load(open(SRC))
elements = data["elements"]
rel = next(e for e in elements if e["type"] == "relation")
print(f"relation {rel['id']}: {rel['tags'].get('name')}")

outer_lines = []
for m in rel.get("members", []):
    if m.get("type") == "way" and m.get("role") == "outer" and m.get("geometry"):
        coords = [(pt["lon"], pt["lat"]) for pt in m["geometry"]]
        if len(coords) >= 2:
            outer_lines.append(LineString(coords))

print(f"outer ways: {len(outer_lines)}")

merged = unary_union(outer_lines)
polygons = list(polygonize(merged))
print(f"polygons formed: {len(polygons)}")
if not polygons:
    print("ERROR: polygonize produced no rings — outer ways may not close into rings")
    sys.exit(1)

# Take the union of all closed rings (there may be a couple of small islands/exclaves)
boundary = unary_union(polygons)
areas = sorted((p.area, p) for p in (polygons if boundary.geom_type == "MultiPolygon" else [boundary]))
print(f"total area (deg^2, rough): {boundary.area:.4f}")

feature = {
    "type": "Feature",
    "properties": {"name": rel["tags"].get("name"), "osm_relation": rel["id"], "admin_level": rel["tags"].get("admin_level")},
    "geometry": mapping(boundary),
}
fc = {"type": "FeatureCollection", "features": [feature]}
with open(OUT, "w") as f:
    json.dump(fc, f)
print(f"wrote {OUT} ({boundary.geom_type}, bounds={boundary.bounds})")

# Also emit a heavily-simplified copy for map display: the raw Overpass
# geometry traces every cadastral bend (11k+ vertices for one polygon), way
# more precision than a background orientation outline needs. This is what
# web/js/map-style.js actually loads (as a plain GeoJSON source, not a
# vector tile) — trying to get "the city boundary" out of OSM's tagged
# admin_level relations instead (which is what the first version of this
# pipeline did) turned out to give 73 separate admin_level=8 polygons and
# 121 separate admin_level=9 polygons in this extract (neighbouring
# municipalities' sub-units, Sofia's raioni, etc.) — not one clean outline —
# which is what caused the dashed-line clutter reported on 2026-09-05.
SIMPLIFIED_OUT = sys.argv[3] if len(sys.argv) > 3 else "/home/claude/sofiamap/data/sofia-boundary.geojson"
simplified = boundary.simplify(0.001, preserve_topology=True)
simple_feature = {
    "type": "Feature",
    "properties": {"name": rel["tags"].get("name")},
    "geometry": mapping(simplified),
}
with open(SIMPLIFIED_OUT, "w") as f:
    json.dump({"type": "FeatureCollection", "features": [simple_feature]}, f)
print(f"wrote {SIMPLIFIED_OUT} (simplified, {len(simplified.exterior.coords)} vertices)")
