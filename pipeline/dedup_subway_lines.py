#!/usr/bin/env python3
"""Extract a de-duplicated metro line GeoJSON straight from the existing
sofia-base.pmtiles (2026-09-07). Workaround for a specific complaint —
"Линии метро достаточно одной, не надо рисовать в две стороны" — that
turned out to be real in the data, not a rendering bug: every named metro
diameter in this extract is drawn as TWO separate OSM ways running the
same route a few metres apart (the two physical tracks, or one per
direction — the extract carries no tag that says which), both tagged
railway=subway with the same `name` and nothing else to tell them apart
(pipeline/sofia-schema.yml keeps only railway/name/service for line
features). Confirmed directly against the tile data, not guessed.

The "correct" fix is a fresh OSM extract + Planetiler re-run so the
tileset itself only carries one way per diameter (or gets a real
direction/track tag to filter on) — neither Planetiler nor a fresh
extract is available in this environment (see claude/icon-redesign-plan.md
for the full blocker writeup). This script sidesteps THAT specific gap by
reading the geometry the tileset already has, deduping it here, and
writing the result as a small static GeoJSON that web/js/map-style.js
loads as a plain source (`subwayLinesGeo`) instead of the vector tile
`railway` source-layer — same "one small file, fetched whole" pattern
already used for cityBoundary/stationsGeo.

## Method

1. Read every zoom-13 tile of `data/sofia-base.pmtiles` covering Sofia's
   bbox (zoom 13, not the tileset's max 14: at 14 a handful of tiles drop
   short main-line fragments entirely on this extract, apparently a
   Planetiler simplification/tile-boundary artifact — checked directly:
   z13 has complete coverage where z14 has real gaps in a few spots, and
   the underground line doesn't need finer-than-z13 precision anyway).
2. Keep only `railway=subway` features whose `service` is NOT one of
   yard/siding/spur/crossover — the same IS_MAIN filter map-style.js's
   `buildRailwayLayers()` already applies to the "subway" (main) layer.
   `subway-yard` (a separate layer, minzoom 16) is untouched by this
   script — depot/yard fan-out wasn't reported as doubled and is a small
   enough feature count to leave reading the tileset directly.
3. Per tile, group main-line fragments by `name` and `shapely.ops.
   linemerge` them into as few continuous pieces as possible (fragments
   only reconnect within a tile — merging across tile boundaries hits
   floating-point mismatches at the tile edges from independent
   simplification per tile, so cross-tile merging was dropped in favor of
   just emitting more, shorter LineString features; MapLibre renders
   adjoining short features just as continuously as one long one).
4. Within each (tile, name) group's merged pieces, pair up any two whose
   bounding boxes nearly coincide (sum of the 4 corner-coordinate
   differences below THRESH) — that's the twin-track signature: both
   directions run the same route, so their envelopes overlap almost
   exactly even though the actual paths differ by the track separation.
   Keep one of each matched pair, drop the other; keep any unmatched
   ("singleton") piece as-is — those are single-track sections, not
   duplicated in this data.
5. Write every surviving piece as one Feature (properties: railway,
   name) into data/subway_lines.geojson.

Verified (not just assumed) against the actual tile geometry, not the
route-relation table (`routes_metro` in sofia.db has exactly 8 rows — 4
diameters x 2 directions each — which independently confirms the "two of
everything" pattern, but relations don't carry geometry, so the real dedup
has to work from the ways' own coordinates, which is what this does).
Re-run this script (needs `pmtiles`, `mapbox_vector_tile`, `shapely` —
`pip install pmtiles mapbox-vector-tile shapely --break-system-packages`)
only if sofia-base.pmtiles is rebuilt; it does not touch parse_full.py or
any other pipeline stage.
"""
import gzip
import json
import math
import os
from collections import defaultdict

from pmtiles.reader import MmapSource, Reader
import mapbox_vector_tile
from shapely.geometry import LineString, MultiLineString, mapping
from shapely.ops import linemerge

PMTILES_PATH = "data/sofia-base.pmtiles"
OUT_PATH = "data/subway_lines.geojson"
ZOOM = 13
YARD_SERVICES = {"yard", "siding", "spur", "crossover"}
# Sum of |dminx|+|dminy|+|dmaxx|+|dmaxy| between two components' bounding
# boxes, in degrees, below which they're treated as the same route's twin
# track rather than two unrelated lines. Chosen from the observed data:
# genuine twin-track pairs differ by ~0.0001-0.0035 total; unrelated named
# diameters differ by whole city blocks or more in at least one corner.
BBOX_PAIR_THRESHOLD = 0.006


def deg2num(lat_deg, lon_deg, zoom):
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return xtile, ytile


def num2deg(xtile, ytile, zoom):
    n = 2.0 ** zoom
    lon_deg = xtile / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * ytile / n)))
    lat_deg = math.degrees(lat_rad)
    return lat_deg, lon_deg


def fetch_main_subway_fragments_by_tile(reader):
    """Returns {(x,y): [{"name": str|None, "coords": [(lon,lat),...]}]}
    for every zoom-13 tile intersecting Sofia's bbox, main-line only."""
    h = reader.header()
    min_lon, min_lat = h["min_lon_e7"] / 1e7, h["min_lat_e7"] / 1e7
    max_lon, max_lat = h["max_lon_e7"] / 1e7, h["max_lat_e7"] / 1e7
    x0, y0 = deg2num(max_lat, min_lon, ZOOM)
    x1, y1 = deg2num(min_lat, max_lon, ZOOM)

    by_tile = defaultdict(list)
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            raw = reader.get(ZOOM, x, y)
            if not raw:
                continue
            tile = mapbox_vector_tile.decode(gzip.decompress(raw))
            layer = tile.get("railway")
            if not layer:
                continue
            extent = layer.get("extent", 4096)
            lat0, lon0 = num2deg(x, y, ZOOM)
            lat1, lon1 = num2deg(x + 1, y + 1, ZOOM)
            for feat in layer["features"]:
                props = feat["properties"]
                if props.get("railway") != "subway" or props.get("service") in YARD_SERVICES:
                    continue
                geom = feat["geometry"]
                if geom["type"] not in ("LineString", "MultiLineString"):
                    continue
                lines = geom["coordinates"] if geom["type"] == "MultiLineString" else [geom["coordinates"]]
                for line in lines:
                    if len(line) < 2:
                        continue
                    coords = [
                        (lon0 + (px / extent) * (lon1 - lon0), lat0 + (py / extent) * (lat1 - lat0))
                        for px, py in line
                    ]
                    by_tile[(x, y)].append({"name": props.get("name"), "coords": coords})
    return by_tile


def merge_components(lines):
    if len(lines) == 1:
        return list(lines)
    merged = linemerge(lines)
    if isinstance(merged, LineString):
        return [merged]
    if isinstance(merged, MultiLineString):
        return list(merged.geoms)
    return []


def dedup_twin_tracks(components):
    """Greedily pairs components whose bboxes nearly coincide (the twin-
    track signature) and keeps one of each pair; unmatched components are
    kept as-is. Returns the surviving list of shapely geometries."""
    n = len(components)
    used = [False] * n
    kept = []
    for i in range(n):
        if used[i]:
            continue
        bi = components[i].bounds
        best_j, best_d = None, None
        for j in range(i + 1, n):
            if used[j]:
                continue
            bj = components[j].bounds
            d = sum(abs(a - b) for a, b in zip(bi, bj))
            if d < BBOX_PAIR_THRESHOLD and (best_d is None or d < best_d):
                best_d, best_j = d, j
        used[i] = True
        kept.append(components[i])
        if best_j is not None:
            used[best_j] = True
    return kept


def main():
    reader = Reader(MmapSource(open(PMTILES_PATH, "rb")))
    by_tile = fetch_main_subway_fragments_by_tile(reader)

    features = []
    kept_count, dropped_count = 0, 0
    for _tile_key, fragments in by_tile.items():
        by_name = defaultdict(list)
        for frag in fragments:
            by_name[frag["name"]].append(LineString(frag["coords"]))
        for name, lines in by_name.items():
            components = merge_components(lines)
            survivors = dedup_twin_tracks(components)
            dropped_count += len(components) - len(survivors)
            kept_count += len(survivors)
            for geom in survivors:
                features.append({
                    "type": "Feature",
                    "geometry": mapping(geom),
                    "properties": {"railway": "subway", "name": name or ""},
                })

    fc = {"type": "FeatureCollection", "features": features}
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)
    print(f"kept {kept_count} components, dropped {dropped_count} as twin-track duplicates")
    print(f"wrote {OUT_PATH}: {len(features)} features, {os.path.getsize(OUT_PATH)} bytes")


if __name__ == "__main__":
    main()
