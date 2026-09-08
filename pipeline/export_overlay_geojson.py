#!/usr/bin/env python3
"""Export organizations / stops / routes / districts / settlements from
sofia.db as GeoJSON feature collections, ready for Tippecanoe."""
import json
import sqlite3

DB = "/home/claude/sofiamap/data/sofia.db"
OUT = "/home/claude/sofiamap/raw"

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row


def write_fc(path, features):
    with open(path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    print(f"wrote {path}: {len(features)} features")


def point_feature(lon, lat, props):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": props}


# ---- organizations ----
cur = conn.execute("SELECT id, name, rubric, addr_street, housenumber, lat, lon FROM organizations WHERE lat IS NOT NULL AND lon IS NOT NULL")
feats = []
for r in cur:
    feats.append(point_feature(r["lon"], r["lat"], {
        "id": r["id"], "type": "company", "name": r["name"], "rubric": r["rubric"],
        "addr_street": r["addr_street"] or "", "housenumber": r["housenumber"] or "",
    }))
write_fc(f"{OUT}/overlay_organizations.geojson", feats)

# ---- stops / stations (2026-09-07: split into two files/Tippecanoe
# layers, not one) ----
# Rail/subway STATIONS get their own icon shown "на всех масштабах" (every
# zoom, per user request) with a name label — that needs `name` actually
# kept in the tiles (the original single-layer build below dropped it via
# `-x name`, since the old flat-dot style never read it) and a much lower
# tileset minzoom than surface stops. Splitting into a separate,
# low-cardinality (193 features citywide) vector layer keeps that low
# minzoom cheap and leaves the existing bus/tram stop layer's zoom
# gating/feature-dropping behavior (minzoom 14, `name` excluded) exactly as
# it was tuned in the 2026-09-05 optimization round.
cur = conn.execute("SELECT id, name, stop_type, network, lat, lon FROM stops")
station_feats, stop_feats = [], []
for r in cur:
    props = {"id": r["id"], "type": "stop", "stop_type": r["stop_type"], "name": r["name"], "network": r["network"] or ""}
    if r["stop_type"] in ("rail", "subway"):
        station_feats.append(point_feature(r["lon"], r["lat"], props))
    else:
        stop_feats.append(point_feature(r["lon"], r["lat"], props))
write_fc(f"{OUT}/overlay_stations.geojson", station_feats)
write_fc(f"{OUT}/overlay_stops.geojson", stop_feats)

# ---- routes (approximate polyline through ordered stops) ----
feats = []
for table, rtype in (("routes_bus", "bus"), ("routes_tram", "tram"), ("routes_trolleybus", "trolleybus"), ("routes_metro", "metro")):
    cur = conn.execute(f"SELECT id, ref, name, operator, from_name, to_name FROM {table}")
    routes = cur.fetchall()
    for r in routes:
        stops_cur = conn.execute(
            "SELECT s.lon, s.lat FROM route_stops rs JOIN stops s ON s.id = rs.stop_id "
            "WHERE rs.route_type=? AND rs.route_id=? ORDER BY rs.seq", (rtype, r["id"]))
        coords = [[row["lon"], row["lat"]] for row in stops_cur]
        if len(coords) < 2:
            continue
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "id": r["id"], "type": "route", "route_type": rtype, "ref": r["ref"] or "",
                "name": r["name"] or "", "operator": r["operator"] or "",
                "from_name": r["from_name"] or "", "to_name": r["to_name"] or "",
            },
        })
write_fc(f"{OUT}/overlay_routes.geojson", feats)

# ---- districts / settlements (polygons, already stored as GeoJSON geometry text) ----
for table, out_name, typ in (("districts", "overlay_districts.geojson", "district"), ("settlements", "overlay_settlements.geojson", "settlement")):
    cur = conn.execute(f"SELECT id, name, name_en, admin_level, lat, lon, geometry FROM {table}")
    feats = []
    for r in cur:
        try:
            geom = json.loads(r["geometry"])
        except (TypeError, ValueError):
            continue
        feats.append({
            "type": "Feature", "geometry": geom,
            "properties": {"id": r["id"], "type": typ, "name": r["name"], "name_en": r["name_en"] or "",
                            "admin_level": r["admin_level"], "lat": r["lat"], "lon": r["lon"]},
        })
    write_fc(f"{OUT}/{out_name}", feats)

conn.close()
