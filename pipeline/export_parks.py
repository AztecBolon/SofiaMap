#!/usr/bin/env python3
"""Parks/green-space directory (2026-09-15, "ветка группы страниц по паркам").

Diagnosis that led to this script (see claude/next-steps-district-settlement-
park-pages.md for the full write-up, corrected mid-session after the user
pointed out the first version of that diagnosis overstated the effort): named
polygon geometry for parks was never missing from the project — it already
sits in `raw/sofia.osm.pbf` (the same extract Planetiler already reads
directly to draw+label the `landuse` layer on the live map, see
pipeline/sofia-schema.yml). What was missing is a SQL table in `sofia.db` a
directory page can query — this script fills exactly that gap, the same way
`parse_full.py` already fills `districts`/`settlements` from admin_level
polygons: one pyosmium `SimpleHandler` pass with an `area()` callback (two-
pass multipolygon assembly happens for free once that callback exists),
`osmium.geom.WKBFactory` to materialize the assembled ring(s), `shapely` for
the centroid + GeoJSON serialization. Same recipe, different tag filter.

Tag scope (user's choice, 2026-09-15): `leisure=park`, `leisure=garden`,
`landuse=forest`, `boundary=protected_area` — deliberately WIDER than the
`landuse` map layer's own filter (park/garden/pitch/stadium/playground,
sofia-schema.yml), which was chosen for what looks good at map-labelling
scale, not for what belongs in a "parks & green spaces" directory. That means
some rows this script exports (forest / protected-area polygons) will NOT be
labelled on the live map today — the map's own tag list is a separate,
narrower decision that this script does not change. A future session wanting
the map to label everything this directory lists would need to widen
sofia-schema.yml's `landuse` layer to match and rebuild sofia-base.pmtiles;
out of scope here.

Unnamed features are skipped entirely (no page can meaningfully exist for a
polygon with no name, and the raw OSM tag-count in `other_entities`
undercounts — it's frequency-of-tag, not distinct-named-object count — this
script's own printed summary is the first real count of what a `/parks/`
section would actually contain).

Run from the repo root, same convention as parse_full.py/smooth_lanes.py:

    python pipeline/export_parks.py

Writes directly into data/sofia.db's new `parks` table (drops+recreates it
each run, so the script is safe to re-run after a fresh sofia.osm.pbf
extract) — unlike export_building_housenumbers.py, this does not go through
the tile pipeline at all: nothing here touches raw/sofia.osm.pbf-derived
GeoJSON or sofia-schema.yml, because this data is read by the Node server
directly out of SQL, the same way districts/settlements already are.
"""
import json
import sqlite3
import sys

import osmium
import osmium.geom
from shapely import wkb as wkblib
from shapely.geometry import mapping

PBF = "raw/sofia.osm.pbf"
DB = "data/sofia.db"

wkbfab = osmium.geom.WKBFactory()

# (tag_key, tag_value) pairs that qualify as "park" for this directory —
# checked in this order so a feature matching more than one (shouldn't
# happen in practice — a way rarely carries both `leisure` and `landuse`
# meaningfully) is attributed to whichever is checked first, deterministically.
PARK_TAGS = [
    ("leisure", "park"),
    ("leisure", "garden"),
    ("landuse", "forest"),
    ("boundary", "protected_area"),
]


class ParkHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.parks = []  # rows for `parks`
        self.skipped_unnamed = 0
        self.seen = set()  # (osm_type, osm_id) — areas can be visited more
        # than once in some pyosmium versions' two-pass assembly; guard
        # against accidental double rows rather than trust that can't happen.

    def area(self, a):
        tags = dict(a.tags)
        match = None
        for key, value in PARK_TAGS:
            if tags.get(key) == value:
                match = (key, value)
                break
        if not match:
            return
        name = tags.get("name", "").strip()
        if not name:
            self.skipped_unnamed += 1
            return
        osm_type = "way" if a.from_way() else "relation"
        osm_id = a.orig_id()
        dedup_key = (osm_type, osm_id)
        if dedup_key in self.seen:
            return
        self.seen.add(dedup_key)
        try:
            wkb = wkbfab.create_multipolygon(a)
        except Exception:
            return
        geom = wkblib.loads(bytes.fromhex(wkb))
        c = geom.centroid
        self.parks.append((
            osm_id, osm_type, name, tags.get("name:en", ""),
            match[0], match[1], c.y, c.x, json.dumps(mapping(geom)),
        ))


def main():
    h = ParkHandler()
    t0_msg = f"Reading {PBF}..."
    print(t0_msg)
    h.apply_file(PBF, locations=True, idx="flex_mem")

    by_tag = {}
    for row in h.parks:
        by_tag[row[5]] = by_tag.get(row[5], 0) + 1

    conn = sqlite3.connect(DB)
    conn.execute("DROP TABLE IF EXISTS parks")
    conn.execute(
        """
        CREATE TABLE parks (
            id INTEGER PRIMARY KEY,
            osm_id INTEGER,
            osm_type TEXT,
            name TEXT,
            name_en TEXT,
            tag_key TEXT,
            tag_value TEXT,
            lat REAL,
            lon REAL,
            geometry TEXT
        )
        """
    )
    conn.executemany(
        "INSERT INTO parks (osm_id, osm_type, name, name_en, tag_key, tag_value, lat, lon, geometry) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        h.parks,
    )
    conn.commit()
    conn.close()

    print(f"wrote {len(h.parks)} named parks/green spaces into data/sofia.db's `parks` table")
    print(f"  by tag: {by_tag}")
    print(f"  skipped {h.skipped_unnamed} unnamed matching polygons (no page possible without a name)")


if __name__ == "__main__":
    sys.exit(main())
