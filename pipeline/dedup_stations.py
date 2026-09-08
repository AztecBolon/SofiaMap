#!/usr/bin/env python3
"""Generate data/overlay_stations.geojson — one deduped point per physical
metro/rail station, straight from data/sofia.db's `stops` table (2026-09-07,
see claude/icon-redesign-plan.md for the full "why" writeup).

`stops` carries 2-3 raw OSM points per real station (the station node itself
plus stop_position/platform markers per direction) because the pipeline's
own dedup (parse_full.py) only collapses points that round to the same
(lat, lon, name) — these don't, they're metres apart. Re-importing with the
original OSM tags to pick a single canonical node isn't possible here (no
raw .pbf access — see the project doc's blocker writeup), so this works
from what `stops` already has: group by (stop_type, name) for stop_type IN
('subway','rail') — names are unique per physical station for these two
types (unlike bus/tram, where the same name legitimately repeats at many
different physical stops city-wide, confirmed via SQL, so this grouping is
NOT extended to those) — and use the centroid of each group's points as the
one map position.

2026-09-08: names are normalized through station_name_aliases.py before
grouping — 4 of the raw `stops` names turned out to be orphaned duplicate
spellings of another station's name (see that module's docstring for how
this was confirmed), which were otherwise producing a second, slightly
offset badge for an already-represented station. This is also what keeps
the station badges in exact agreement with the metro line drawn by
build_subway_lines.py, which keys off the same canonical names.

2026-09-08, same round: 6 more metro-tagged station NAMES (not the same
issue — these are real distinct names, not spelling variants of another
station) are dropped entirely: "Арена София", "Гео Милев", "СК ЦСКА",
"Ситняково", "Слатина", "Тракия". None of the 8 routes_metro route
relations ever mention them (route_stops has zero rows for any of these
names, checked directly), and — the tell — every raw `stops` row for these
6 has an EMPTY `network` field, while every other metro station (all 54
that ARE on a real route) has "Софийско метро" or "Градски транспорт
София". That correlation is exact across all 60 original names: emptiness
of `network` predicts absence from `route_stops` with zero exceptions
once the 4 alias cases above are accounted for. That pattern — tagged
station=subway, but no operator, no route relation, clustered together
geographically (all 6 sit in one part of the south-east city) — reads as
OSM nodes for a planned/not-yet-open metro extension, mapped ahead of
construction, rather than 6 real operating stations our classifier
mis-typed as something else. Rendering them as ordinary station badges
would misrepresent them as real, working stations, so they're filtered
out here rather than shown unconnected. If this reading is wrong (they
turn out to be real, already-open stations just missing from this OSM
route-relation extract), un-filtering them is a one-line change below —
worth revisiting if the user has other information.

`properties.id` is the smallest raw `stops.id` in the group, NOT a new
synthetic id — this matters: it's a real row in `stops`, so it resolves
correctly through the same object-detail lookup any other stop id does
(server/src/routes/object.js), even though its own lat/lon is one of the
2-3 raw points, not the centroid actually drawn on the map. That's fine —
they're all the same physical station, a few metres apart.

`properties.type` is "metro" or "rail" (not "stop") to match the type
strings search.js already returns for these — see TYPE_LABEL/TYPE_GROUP in
web/js/map-search.js. This lets the map's station click/hover popup skip
the /api/hit-test coordinate round-trip other stop types need (their tiles
carry no name/id at all): hit-test's ~20m match radius (coord.js
M2DEG2) is designed around real, un-deduped stop points, and several
merged stations here have raw points 40-90m from their own centroid (long
platforms) — well outside that radius, which would make hit-test
legitimately fail to find them from the centroid. Carrying name/id/type
directly in the GeoJSON sidesteps the radius question entirely.

Output: data/overlay_stations.geojson, loaded by web/js/map-style.js as
the `stationsGeo` source (plain GeoJSON, same pattern as cityBoundary/
subwayLinesGeo — small enough to fetch whole, no vector tiles needed).

2026-09-08 revision 10 ("сделай иконки цветом линии", round 2): each
single-line subway station also gets `properties.line_color` — see
station_lines()/pipeline/line_colors.py.

2026-09-08 revision 11 ("две ветки по одной линии... разделенная на два
цвета"): the 13 real two-line (M1+M4 shared-trunk) subway stations get
`properties.line_split = true` instead — see station_lines()'s docstring
and the comment right above where this is set in main().
"""
import json
import os
import sqlite3
from collections import defaultdict

from station_name_aliases import canonical_name
from line_colors import LINE_COLORS

DB_PATH = "data/sofia.db"
OUT_PATH = "data/overlay_stations.geojson"
TYPE_BY_STOP_TYPE = {"subway": "metro", "rail": "rail"}


def station_lines(conn):
    """{canonical station name: {M1, M2, ...}} for every subway station —
    which real line(s) actually stop there, from route_stops/routes_metro
    (2026-09-08 revision 10, "сделай иконки цветом линии" round 2). Checked
    directly: every multi-line result turned out to be M1+M4 (13 stations,
    all on their real shared physical trunk — see build_subway_lines.py's
    docstring — not a data gap or a real 3-line interchange), so a station
    with more than one line here is a deliberate, verified case, not
    something to silently pick one line out of."""
    cur = conn.cursor()
    cur.execute(
        "SELECT r.ref, s.name FROM route_stops rs "
        "JOIN stops s ON s.id = rs.stop_id "
        "JOIN routes_metro r ON r.id = rs.route_id "
        "WHERE rs.route_type = 'metro'"
    )
    lines = defaultdict(set)
    for ref, name in cur.fetchall():
        lines[canonical_name(name)].add(ref)
    return lines


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        "SELECT id, name, stop_type, network, lat, lon FROM stops "
        "WHERE stop_type IN ('subway','rail')"
    )
    rows = cur.fetchall()
    lines_by_station = station_lines(conn)

    groups = defaultdict(list)
    for row_id, name, stop_type, network, lat, lon in rows:
        name = canonical_name(name) if stop_type == "subway" else name
        groups[(stop_type, name)].append({"id": row_id, "network": network, "lat": lat, "lon": lon})

    # See the module docstring's 2026-09-08 note: a metro station group
    # where NONE of its raw points carry a network/operator tag reads as a
    # planned/not-yet-open station, not a real operating one — filtered
    # out rather than drawn as an ordinary badge. Never applies to rail:
    # ALL 30 real rail stations have an empty network tag too (checked —
    # that's just how this extract tags rail, not a "planned" signal
    # there), so this check is deliberately subway-only.
    unbuilt = []
    for (stop_type, name), pts in list(groups.items()):
        if stop_type == "subway" and not any(p["network"] for p in pts):
            unbuilt.append(name)
            del groups[(stop_type, name)]

    features = []
    for (stop_type, name), pts in sorted(groups.items()):
        clat = sum(p["lat"] for p in pts) / len(pts)
        clon = sum(p["lon"] for p in pts) / len(pts)
        rep_id = min(p["id"] for p in pts)
        network = next((p["network"] for p in pts if p["network"]), "")
        props = {
            "id": rep_id,
            "name": name,
            "stop_type": stop_type,
            "type": TYPE_BY_STOP_TYPE[stop_type],
            "network": network,
            "merged_from": len(pts),
        }
        # Single-line stations get that line's own color (map-style.js
        # falls back to the neutral shared SUBWAY_LINE_COLOR when this is
        # absent — every rail station, plus the 13 real M1/M4 shared-trunk
        # stations where "the" line color isn't a well-defined thing).
        # 2026-09-08 revision 11 ("две ветки по одной линии... иконка по
        # диагонали разделенная на два цвета"): those 13 two-line stations
        # instead get `line_split: true` — map-style.js reads this to draw
        # gen_stop_icons.py's baked "metro-badge-split" (a real, fixed M1/M4
        # diagonal split) instead of falling back to the old plain neutral
        # color, which didn't represent either line at all. Written as a
        # boolean flag, not the two colors themselves, because the split
        # badge is a flat pre-baked sprite (not per-feature-tinted like the
        # single-line case) — see gen_stop_icons.py's render_split()
        # comment for why a live per-feature mechanism isn't needed here.
        if stop_type == "subway":
            station_refs = lines_by_station.get(name, set())
            if len(station_refs) == 1:
                props["line_color"] = LINE_COLORS[next(iter(station_refs))]
            elif len(station_refs) > 1:
                props["line_split"] = True
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [clon, clat]},
            "properties": props,
        })

    fc = {"type": "FeatureCollection", "features": features}
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)

    by_type = defaultdict(int)
    for f in features:
        by_type[f["properties"]["stop_type"]] += 1
    print(f"stations before dedup: {len(rows)} -> after dedup: {len(features)} "
          f"({sum(1 for p in groups.values() if len(p) > 1)} merged from >1 point)")
    print(dict(by_type))
    print(f"dropped {len(unbuilt)} likely-unbuilt metro stations (no network tag, no route): {unbuilt}")
    print(f"wrote {OUT_PATH}: {os.path.getsize(OUT_PATH)} bytes")


if __name__ == "__main__":
    main()
