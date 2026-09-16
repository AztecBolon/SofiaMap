#!/usr/bin/env python3
"""Exports the ENRICHED per-building house number (2026-09-15, map-display
follow-up, point 4: "номера домов должны появляться на 1-2 зума раньше").

pipeline/sofia-schema.yml's `building` layer reads `housenumber` straight
off the raw OSM `addr:housenumber` tag on the building way/relation itself —
only ~39,500 of 132,920 buildings in this extract carry that tag directly.
sofia.db's own `buildings.housenumber` column already has a MUCH fuller
answer: parse_full.py backfills it, for buildings the raw tag misses, from
three more address sources (in priority order — see
server/src/lib/housenumberProvenance.js for what each one is and how the
server already explains this to users elsewhere):

  1. `address_point`   — a standalone OSM node carrying addr:housenumber,
                          not on the building outline itself
  2. `address_sofia`   — Stolichna Community's own official address-point
                          registry (urbandata.sofia.bg)
  3. `nsi_sofiaplan`   — NSI/Sofiaplan census address points
  4. `tag`             — the same raw addr:housenumber tag the tile
                          pipeline already reads directly

Rather than re-source the whole `building` layer from sofia.db (which would
ALSO silently change extruded building heights for every building relying
on a type-based default — sofia.db's own `buildings.height` column uses a
different default-by-type table than web/js/map-style.js's
BUILDING_HEIGHT_EXPR, and the two have never been kept in sync since
nothing read the DB's computed height through the tile pipeline before
this), this exports ONLY the enriched housenumber, as its own small point
layer (`address_point` in sofia-schema.yml, fed by the `osm_addresses`
source this script's output plugs into) — see that source's own comment in
sofia-schema.yml for the full reasoning.

Uses each building's own centroid (`buildings.lat`/`lon`, already computed
in parse_full.py) rather than its polygon: only a label anchor point is
needed here, not a second copy of the building's shape.

Excludes `housenumber_src = 'tag'` rows (2026-09-15, same-day fix after a
live regression report — see the comment on the "address-labels"/
"address-labels-enriched" layer pair in web/js/map-style.js for the full
story): a `tag`-sourced number is, by definition, the exact same
`addr:housenumber` value the `building` layer's own tile attribute already
carries directly from OSM. The first version of this script exported EVERY
addressed building, including those — which was harmless on its own, but
meant that once the tileset is rebuilt, a building with a direct tag would
get its number drawn TWICE (once by "address-labels", once by
"address-labels-enriched"). Excluding `tag` rows here makes this export
purely the ADDITIONAL coverage beyond what the existing `building` layer
attribute already provides — the two client layers can never draw the same
building twice, no matter what order they're added/removed in.

Run from the repo root (same convention as smooth_lanes.py /
export_overlay_geojson.py), AFTER sofia.db has been built/rebuilt by
parse_full.py (this script only reads sofia.db — it does not touch it, and
does not re-run any OSM parsing itself):

    python pipeline/export_building_housenumbers.py

Then re-run Planetiler against the updated pipeline/sofia-schema.yml to get
an updated sofia-base.pmtiles (see README.md's pipeline section for the
exact Planetiler invocation already used for this project) and deploy that
file alongside the updated web/js/map-style.js.
"""
import json
import sqlite3

DB_PATH = "data/sofia.db"
OUT_PATH = "raw/sofia_building_housenumbers.geojson"

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

cur = conn.execute(
    "SELECT osm_id, osm_type, housenumber, housenumber_src, lat, lon "
    "FROM buildings "
    "WHERE housenumber IS NOT NULL AND housenumber != '' AND lat IS NOT NULL AND lon IS NOT NULL "
    "AND housenumber_src != 'tag'"
)
features = []
for r in cur:
    features.append({
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
        "properties": {
            # osm_id/osm_type/housenumber_src aren't read by the client
            # today (only "housenumber" is, in map-style.js's
            # "address-labels" layer) — kept out of the exported
            # attributes actually shipped to the tile pipeline (see
            # sofia-schema.yml's own attribute-trimming policy comment),
            # but left in THIS intermediate GeoJSON in case a future need
            # (dedup against the building layer, a provenance tooltip)
            # wants them without re-deriving from sofia.db again.
            "osm_id": r["osm_id"],
            "osm_type": r["osm_type"],
            "housenumber": r["housenumber"],
            "housenumber_src": r["housenumber_src"] or "",
        },
    })

with open(OUT_PATH, "w") as f:
    json.dump({"type": "FeatureCollection", "features": features}, f)

total_buildings = conn.execute("SELECT COUNT(*) FROM buildings").fetchone()[0]
direct_tag = conn.execute("SELECT COUNT(*) FROM buildings WHERE housenumber_src = 'tag'").fetchone()[0]
print(
    f"wrote {OUT_PATH}: {len(features)} ADDITIONAL addressed buildings (beyond the "
    f"{direct_tag} the 'building' layer's own addr:housenumber tag already covers), "
    f"out of {total_buildings} total buildings — backfilled from "
    f"address_point/address_sofia/nsi_sofiaplan"
)
conn.close()
