#!/usr/bin/env python3
"""Build data/subway_lines.geojson from the metro *route sequence* data
(routes_metro + route_stops), not from the vector tileset (2026-09-08).

Supersedes pipeline/dedup_subway_lines.py. That script pulled the metro
line geometry straight from data/sofia-base.pmtiles's `railway` vector
layer and deduped the doubled track it found there — which fixed the "two
lines" complaint, but the user's next bug report ("линии... не совпадают
со станциями") turned out to be real: the extracted geometry, especially
away from the city centre, sits anywhere from tens of metres to a few
kilometres from the real station points for a large share of the 60 metro
stations. Verified directly, not guessed: computed the point-to-line
distance from every deduped station centroid to the nearest point on the
extracted line —

  zoom 13 (what dedup_subway_lines.py used): median ~700m, worst ~2.7km
  zoom 14 (the tileset's own max zoom):       median ~390m, worst ~1.7km

— and confirmed the gap is already present in the RAW, un-deduped tile
data at both zooms, so it isn't something the twin-track dedup step
introduced; it's a property of the `railway=subway` way geometry in this
extract itself (most likely: real, precisely-surveyed alignment only near
the centre, coarser/placeholder-ish tracing further out — a source-data
limit, not a pipeline bug). Switching from the tileset's native,
cross-tile-continuous MapLibre rendering to a static per-tile GeoJSON
extraction (needed to drop the duplicate track, since MapLibre can't
filter one of two overlapping ways without a stable id, and this extract's
schema carries none — see pipeline/sofia-schema.yml) made the problem far
more visible than it would otherwise have been: per-tile-only linemerge
(deliberately not stitched across tiles, to dodge floating-point mismatch
at tile edges) left many short disconnected fragments, which at low
opacity read as a scattered dashed mess rather than a line the user could
recognize as "the metro line, drawn once."

This script sidesteps the vector-tile path entirely. `sofia.db` already
has exactly the data a schematic line needs: `routes_metro` (8 rows — 4
real lines, M1-M4, x2 directions each) and `route_stops` (each route's
ordered station sequence — same table/shape `coord.js`'s existing
`getRouteStops` already reads for bus/tram/trolleybus). For each of the 4
lines this takes ONE direction's stop sequence (checked: both directions
of a given line cover the identical station set, just reversed — e.g. M1
dir1 and dir3 are both 16 stops) and draws a LineString through each
stop's *deduped* station centroid, in order — the same centroid
pipeline/dedup_stations.py draws the badge at (computed inline here the
same way, both keyed through station_name_aliases.py so the two agree on
which raw `stops` rows belong to the same physical station).

This trades the real tunnel's curve for straight station-to-station
segments. For a layer that's already deliberately drawn translucent (see
map-style.js's comment on `subway`'s line-opacity: it's meant to read as
"there's a line here, underground," not as an accurate surface feature),
that's a fair trade — and the one property that actually matters for the
user's complaint is now true by construction: every vertex of the line
IS the station's own drawn position, so a station badge can never again
visibly disagree with the line passing through it. Shared-trunk stretches
(M1 and M4 share several stations, same as the real network) simply draw
as two overlapping lines, which is correct, not a duplicate-data bug.

`subway-yard` (depot/yard trackage, a separate layer in map-style.js,
minzoom 16) is untouched — still reads data/sofia-base.pmtiles's tileset
directly, same as before; yard fan-out was never part of this complaint
and has no equivalent in route_stops (depots aren't stations).

2026-09-08 revision 10 ("сделай иконки цветом линии", round 2 — each of
the 4 real lines its own color, not one shared subway color): each feature
now also carries `properties.color`, the real line's own official color
(pipeline/line_colors.py) — read by map-style.js's "subway" line layer.

Output: data/subway_lines.geojson — the same `subwayLinesGeo` GeoJSON
source map-style.js already reads, just built differently. Re-run this
(needs only sqlite3, stdlib) whenever sofia.db's routes_metro/route_stops/
stops tables change.
"""
import json
import os
import sqlite3
from collections import defaultdict

from station_name_aliases import canonical_name
from line_colors import LINE_COLORS

DB_PATH = "data/sofia.db"
OUT_PATH = "data/subway_lines.geojson"

# One direction's route_id per real line (M1-M4) — see this file's
# docstring: the reverse direction covers the identical station set.
# Picked by inspecting routes_metro directly (id, ref, from_name/to_name),
# not assumed — the lower id of each ref's pair, which happens to also be
# the "outbound" direction in every case here.
LINE_ROUTE_IDS = {
    "M1": 1,  # Бизнес парк София -> Сливница
    "M2": 2,  # Обеля -> Витоша
    "M3": 5,  # Ген. Владимир Вазов -> Горна баня
    "M4": 7,  # Летище София -> Сливница
}


def station_centroids(conn):
    """{canonical_name: (lon, lat)} for every subway station, same
    grouping as pipeline/dedup_stations.py (kept in sync via
    station_name_aliases.py)."""
    cur = conn.cursor()
    cur.execute("SELECT name, lat, lon FROM stops WHERE stop_type = 'subway'")
    groups = defaultdict(list)
    for name, lat, lon in cur.fetchall():
        groups[canonical_name(name)].append((lat, lon))
    return {
        name: (sum(lo for _, lo in pts) / len(pts), sum(la for la, _ in pts) / len(pts))
        for name, pts in groups.items()
    }


def main():
    conn = sqlite3.connect(DB_PATH)
    centroids = station_centroids(conn)

    cur = conn.cursor()
    features = []
    for ref, route_id in LINE_ROUTE_IDS.items():
        cur.execute(
            "SELECT s.name FROM route_stops rs JOIN stops s ON s.id = rs.stop_id "
            "WHERE rs.route_type = 'metro' AND rs.route_id = ? ORDER BY rs.seq",
            (route_id,),
        )
        names = [canonical_name(r[0]) for r in cur.fetchall()]
        missing = [n for n in names if n not in centroids]
        if missing:
            raise SystemExit(f"{ref}: no station centroid for {missing!r} — route_stops/stops out of sync?")

        coords = [centroids[n] for n in names]
        # Defensive: collapse accidental consecutive duplicate points (two
        # adjacent stops resolving to the same centroid) so MapLibre never
        # sees a zero-length segment.
        dedup_coords = [coords[0]]
        for c in coords[1:]:
            if c != dedup_coords[-1]:
                dedup_coords.append(c)

        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": dedup_coords},
            "properties": {
                "railway": "subway", "ref": ref, "name": ref, "stations": len(names),
                "color": LINE_COLORS[ref],
            },
        })

    fc = {"type": "FeatureCollection", "features": features}
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)

    for f in features:
        p = f["properties"]
        print(f"{p['ref']}: {p['stations']} stations, {len(f['geometry']['coordinates'])} line vertices")
    print(f"wrote {OUT_PATH}: {os.path.getsize(OUT_PATH)} bytes")


if __name__ == "__main__":
    main()
