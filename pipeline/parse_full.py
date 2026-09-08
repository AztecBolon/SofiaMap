#!/usr/bin/env python3
"""
Parse sofia.osm.pbf into data/sofia.db (SQLite), reproducing the schema from
sofia-full-city-extraction-results.md / -plan.md, extended with `districts`
and `settlements` tables (2026-09-05 decision).

One pass over the PBF via pyosmium's SimpleHandler (area assembly for
buildings + admin boundaries happens automatically because an `area()`
callback is implemented — pyosmium then does the two-pass multipolygon
assembly internally).
"""
import json
import math
import sqlite3
import sys
import time

import osmium
import osmium.geom
from shapely import wkb as wkblib
from shapely.geometry import mapping
from shapely.strtree import STRtree

sys.path.insert(0, "/home/claude/sofiamap/pipeline")
from rubricator import classify, classify_stop

PBF = "/home/claude/sofiamap/raw/sofia.osm.pbf"
DB = "/home/claude/sofiamap/data/sofia.db"

wkbfab = osmium.geom.WKBFactory()

# Local equirectangular projection centered on Sofia, good enough for a
# ~60km-wide extent (documented limitation, same as the previous pass).
LAT0 = 42.7
M_PER_DEG_LAT = 111320.0
M_PER_DEG_LON = 111320.0 * math.cos(math.radians(LAT0))


def to_local(lon, lat):
    return ((lon) * M_PER_DEG_LON, (lat) * M_PER_DEG_LAT)


def project_geom(geom):
    from shapely.ops import transform
    return transform(lambda x, y, z=None: to_local(x, y), geom)


def parse_height(tags):
    def num(v):
        try:
            return float(str(v).replace("m", "").strip())
        except (ValueError, TypeError):
            return None

    h = num(tags.get("height"))
    if h:
        return h, "height_tag"
    levels = num(tags.get("building:levels"))
    if levels:
        return levels * 3.0, "levels*3"
    btype = tags.get("building", "")
    defaults = {
        "apartments": 15.0, "residential": 12.0, "house": 8.0, "detached": 8.0,
        "commercial": 9.0, "retail": 6.0, "industrial": 8.0, "warehouse": 8.0,
        "office": 15.0, "hotel": 18.0, "church": 20.0, "cathedral": 25.0,
        "school": 10.0, "university": 12.0, "hospital": 15.0, "civic": 10.0,
        "public": 10.0, "garage": 3.0, "garages": 3.0, "shed": 3.0,
    }
    return defaults.get(btype, 8.0), "default_by_type"


class Handler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.streets = []          # rows for `streets`
        self.buildings = []        # rows for `buildings`
        self.organizations = []    # rows for `organizations`
        self.stops_raw = []        # rows for `stops`
        self.districts = []        # rows for `districts` (admin_level=9)
        self.settlements = []      # rows for `settlements` (admin_level=8)
        self.routes = {"bus": [], "tram": [], "trolleybus": [], "metro": []}
        self.route_members = []    # (route_type, route_osm_id, [ (type,ref,role), ... ])
        self.other_counter = {}    # (key,value,osm_type) -> [count, [examples]]
        self.address_points = []   # standalone address nodes: (lat, lon, housenumber, street, city)
        self._t0 = time.time()
        self._counts = {"node": 0, "way": 0, "area": 0, "relation": 0}

    # ---- helpers -------------------------------------------------
    def _note_other(self, tags, osm_type):
        skip_keys = {"source", "note", "fixme", "created_by", "attribution",
                     "wikidata", "wikipedia", "check_date", "survey:date"}
        for k, v in tags:
            if k in skip_keys or k.startswith("addr:") or k.startswith("name"):
                continue
            key = (k, v, osm_type)
            entry = self.other_counter.get(key)
            if entry is None:
                self.other_counter[key] = [1, []]
            else:
                entry[0] += 1

    # ---- callbacks -------------------------------------------------
    def node(self, n):
        self._counts["node"] += 1
        tags = dict(n.tags)
        if not tags:
            return
        lat, lon = n.location.lat, n.location.lon
        if (tags.get("highway") == "bus_stop"
                or tags.get("public_transport") in ("platform", "stop_position")
                or tags.get("railway") in ("tram_stop", "station", "halt")
                or tags.get("station") == "subway"
                or tags.get("amenity") == "bus_station"
                or tags.get("aeroway") in ("aerodrome",)):
            stype = classify_stop(tags)
            self.stops_raw.append((n.id, "node", tags.get("name", ""), stype,
                                    tags.get("network", ""), lat, lon))
            return
        if tags.get("name") and any(k in tags for k in ("amenity", "shop", "office", "tourism", "leisure", "craft", "healthcare")):
            rubric, rk, rv = classify(tags)
            self.organizations.append((
                n.id, "node", tags.get("name", ""), tags.get("name:en", ""),
                rubric, rk, rv,
                tags.get("addr:housenumber", ""), tags.get("addr:street", ""), tags.get("addr:city", ""),
                tags.get("phone", tags.get("contact:phone", "")),
                tags.get("website", tags.get("contact:website", "")),
                tags.get("email", tags.get("contact:email", "")),
                tags.get("opening_hours", ""), tags.get("wheelchair", ""),
                lat, lon,
            ))
            return
        # Standalone address point: a node carrying addr:housenumber on its
        # own, not attached to any building outline (common OSM pattern —
        # the surveyor placed a point where the number plate is, without
        # also tracing the building). Used later to backfill buildings that
        # have no housenumber of their own at all.
        if tags.get("addr:housenumber"):
            self.address_points.append((
                lat, lon, tags.get("addr:housenumber", ""),
                tags.get("addr:street", ""), tags.get("addr:city", ""),
            ))
            return
        self._note_other(tags.items(), "node")

    def way(self, w):
        self._counts["way"] += 1
        tags = dict(w.tags)
        if not tags:
            return
        if "building" in tags:
            return  # handled in area()
        if "highway" in tags:
            try:
                wkb = wkbfab.create_linestring(w)
            except Exception:
                return
            geom = wkblib.loads(bytes.fromhex(wkb))
            self.streets.append((
                w.id, "way", tags.get("name", ""), tags.get("name:en", ""), tags["highway"],
                tags.get("ref", ""), tags.get("oneway", ""), tags.get("surface", ""),
                tags.get("lanes", ""), tags.get("maxspeed", ""),
                # lanes:forward / lanes:backward — an explicit, uneven lane
                # split for a two-way road (e.g. 3 total = 2 up + 1 down on a
                # climbing-lane hill). Present on a minority of tagged ways;
                # absent, the map-style lane renderer falls back to an even
                # floor/ceil split of the plain `lanes` total (see
                # web/js/map-style.js's lanes_fwd/lanes_bwd derivation).
                tags.get("lanes:forward", ""), tags.get("lanes:backward", ""),
                json.dumps(mapping(geom)), geom,
            ))
            return
        if tags.get("boundary") == "administrative":
            return  # rare as plain way; areas handled in area()
        self._note_other(tags.items(), "way")

    def area(self, a):
        self._counts["area"] += 1
        tags = dict(a.tags)
        if "building" in tags:
            try:
                wkb = wkbfab.create_multipolygon(a)
            except Exception:
                return
            geom = wkblib.loads(bytes.fromhex(wkb))
            c = geom.centroid
            height, height_src = parse_height(tags)
            self.buildings.append({
                "osm_id": a.orig_id(), "osm_type": "way" if a.from_way() else "relation",
                "building": tags.get("building", "yes"), "name": tags.get("name", ""),
                "housenumber": tags.get("addr:housenumber", ""), "street": tags.get("addr:street", ""),
                "city": tags.get("addr:city", ""), "postcode": tags.get("addr:postcode", ""),
                "levels": tags.get("building:levels", ""), "height": height, "height_src": height_src,
                "lat": c.y, "lon": c.x, "geom": geom,
            })
            return
        if tags.get("boundary") == "administrative":
            lvl = tags.get("admin_level")
            try:
                wkb = wkbfab.create_multipolygon(a)
            except Exception:
                return
            geom = wkblib.loads(bytes.fromhex(wkb))
            c = geom.centroid
            row = (a.orig_id(), tags.get("name", ""), tags.get("name:en", ""), lvl, c.y, c.x, json.dumps(mapping(geom)))
            if lvl == "9":
                self.districts.append(row)
            elif lvl == "8":
                self.settlements.append(row)

    def relation(self, r):
        self._counts["relation"] += 1
        tags = dict(r.tags)
        if tags.get("type") == "route" and tags.get("route") in ("bus", "tram", "trolleybus", "subway"):
            rtype = "metro" if tags["route"] == "subway" else tags["route"]
            members = [(m.type, m.ref, m.role) for m in r.members]
            self.routes[rtype].append((
                r.id, tags.get("ref", ""), tags.get("name", ""), tags.get("operator", ""),
                tags.get("network", ""), tags.get("from", ""), tags.get("to", ""),
            ))
            self.route_members.append((rtype, r.id, members))


def main():
    print("Parsing", PBF)
    h = Handler()
    t0 = time.time()
    h.apply_file(PBF, locations=True)
    print(f"apply_file done in {time.time()-t0:.1f}s -- primitive counts: {h._counts}")
    print(f"streets={len(h.streets)} buildings={len(h.buildings)} organizations={len(h.organizations)} "
          f"stops={len(h.stops_raw)} districts={len(h.districts)} settlements={len(h.settlements)} "
          f"routes bus/tram/trolleybus/metro={len(h.routes['bus'])}/{len(h.routes['tram'])}/"
          f"{len(h.routes['trolleybus'])}/{len(h.routes['metro'])}")

    # ---- street name index for building linkage ----
    print("Building street index for address linkage...")
    named_streets = [s for s in h.streets if s[2]]
    exact_index = {}
    for idx, s in enumerate(named_streets):
        key = s[2].strip().lower()
        exact_index.setdefault(key, idx)
    proj_geoms = [project_geom(s[13]) for s in named_streets]
    tree = STRtree(proj_geoms) if proj_geoms else None

    matched_exact = matched_nearest = matched_none = 0

    def resolve_street(building_street_tag, blat, blon):
        nonlocal matched_exact, matched_nearest, matched_none
        if building_street_tag:
            key = building_street_tag.strip().lower()
            idx = exact_index.get(key)
            if idx is not None:
                matched_exact += 1
                return named_streets[idx][0], named_streets[idx][2], "exact"
        if tree is not None:
            from shapely.geometry import Point
            p = Point(*to_local(blon, blat))
            nearest_idx = tree.nearest(p)
            if nearest_idx is not None:
                dist = p.distance(proj_geoms[nearest_idx])
                if dist <= 300:
                    matched_nearest += 1
                    s = named_streets[nearest_idx]
                    return s[0], s[2], "nearest"
        matched_none += 1
        return None, building_street_tag, "none"

    print("Linking buildings to streets (this scans all buildings)...")
    t0 = time.time()
    for b in h.buildings:
        street_id, street_name, match = resolve_street(b["street"], b["lat"], b["lon"])
        b["street_id"] = street_id
        b["street_resolved"] = street_name or ""
        b["street_match"] = match
    print(f"  done in {time.time()-t0:.1f}s: exact={matched_exact} nearest={matched_nearest} none={matched_none}")

    # ---- backfill 1: addr_street from the already-resolved nearest street ----
    # `street_resolved` above is computed for every building whose street
    # could be matched (exact tag OR nearest-line-within-300m), but until now
    # nothing downstream (server routes, map click, search) ever read it —
    # only the raw `addr:street` tag (`addr_street` column) was used. For a
    # building that has no addr:street tag of its own but WAS matched to a
    # nearby named street, that left addr_street empty and made the building
    # unfindable by street name even though we already knew its street.
    # Backfilling addr_street with street_resolved whenever the raw tag is
    # missing fixes every consumer (search, object card, click-to-search,
    # reverse geocode) at once, with no server code changes needed.
    backfilled_street = 0
    for b in h.buildings:
        if not b["street"] and b["street_resolved"]:
            b["street"] = b["street_resolved"]
            backfilled_street += 1
    print(f"  addr_street backfilled from street_resolved for {backfilled_street} buildings "
          f"(had a resolved street but no addr:street tag of their own)")

    for b in h.buildings:
        b["housenumber_src"] = "tag" if b["housenumber"] else ""

    def backfill_housenumbers(points, src_label, near_m=30):
        """points: iterable of (lat, lon, housenumber, street, city). Fills
        housenumber (and addr_street/city if those are also empty) on the
        nearest still-unaddressed building — containment first, else nearest
        centroid within `near_m` metres. Never overwrites existing data;
        buildings filled by an earlier call/source are skipped by later ones
        because `needs_number` is recomputed fresh each call.
        """
        needs_number = [b for b in h.buildings if not b["housenumber"]]
        points = list(points)
        print(f"Matching {len(points)} '{src_label}' address points against "
              f"{len(needs_number)} buildings still missing a housenumber...")
        t0 = time.time()
        if not (needs_number and points):
            print("  skipped (nothing to match)")
            return
        from shapely.geometry import Point
        cand_geoms = [b["geom"] for b in needs_number]
        cand_tree = STRtree(cand_geoms)
        proj_centroids = [project_geom(Point(b["lon"], b["lat"])) for b in needs_number]
        centroid_tree = STRtree(proj_centroids)

        matched_contains = matched_near = 0
        for (lat, lon, housenumber, street, city) in points:
            if not housenumber:
                continue
            p = Point(lon, lat)
            target = None
            for idx in cand_tree.query(p, predicate="intersects"):
                cb = needs_number[idx]
                if not cb["housenumber"] and cb["geom"].contains(p):
                    target = cb
                    break
            if target is None:
                pp = project_geom(p)
                nearest_idx = centroid_tree.nearest(pp)
                if nearest_idx is not None:
                    cb = needs_number[nearest_idx]
                    if not cb["housenumber"] and pp.distance(proj_centroids[nearest_idx]) <= near_m:
                        target = cb
            if target is None or target["housenumber"]:
                continue  # no match, or already filled by an earlier point this pass
            target["housenumber"] = housenumber
            target["housenumber_src"] = src_label
            if not target["street"] and street:
                target["street"] = street
            if not target.get("city") and city:
                target["city"] = city
            if target["geom"].contains(p):
                matched_contains += 1
            else:
                matched_near += 1
        print(f"  done in {time.time()-t0:.1f}s: {matched_contains} by containment, "
              f"{matched_near} by proximity (<= {near_m}m)")

    # ---- backfill 2: housenumber from standalone OSM address points ----
    # Buildings still missing a housenumber after the above: try to fill it
    # from a standalone address node (see node() above) that falls inside, or
    # very close to, the building's own outline. This only ever ADDS data
    # that's missing — an existing housenumber/addr_street is never
    # overwritten.
    backfill_housenumbers(h.address_points, "address_point")

    # ---- backfill 3: housenumber from Sofiaplan/NSI census address points ----
    # Official-ish source (Sofiaplan API, dataset "Административни адреси" —
    # geocoded 2011-census addresses from NSI, explicitly stated as freely
    # usable): https://api.sofiaplan.bg/datasets/218. Point-only, no polygon
    # geometry of its own, one point per residential building (occasionally
    # per entrance) — matched the same way as the OSM address points above.
    # Covers residential buildings only (it's census data), and only ones
    # that existed as of the 2011 census / this 2018 extract, so it can't
    # help with newer construction — but it's the single biggest source of
    # net-new housenumbers found so far, see claude/address-coverage.md.
    import os as _os
    nsi_path = "/home/claude/sofiamap/raw/nsi_sofiaplan_addresses.geojson"
    if _os.path.exists(nsi_path):
        print(f"Loading Sofiaplan/NSI address dataset from {nsi_path}...")
        with open(nsi_path, encoding="utf-8") as f:
            nsi_data = json.load(f)

        def normalize_nsi_street(name):
            name = (name or "").strip()
            prefixes = {
                "УЛ.": "", "БУЛ.": "бул. ", "ПЛ.": "пл. ",
                "Ж.": "", "КВ.": "", "В.": "", "МЕСТН.": "", "ОБЩ.": "",
            }
            for pfx, repl in prefixes.items():
                if name.startswith(pfx):
                    return (repl + name[len(pfx):].strip()).strip().title()
            return name.title()

        nsi_points = []
        for feat in nsi_data["features"]:
            props = feat["properties"]
            coords = feat["geometry"]["coordinates"]
            lon, lat = coords[0][0], coords[0][1]  # MultiPoint, one point each
            nsi_points.append((
                lat, lon, props.get("nnumber") or "",
                normalize_nsi_street(props.get("nstreetnam")), "",
            ))
        backfill_housenumbers(nsi_points, "nsi_sofiaplan")
    else:
        print(f"Sofiaplan/NSI address dataset not found at {nsi_path}, skipping backfill 3.")

    # ---- stop dedup by rounded coordinate ----
    print("Deduplicating stops...")
    stop_by_osm = {}
    dedup_stops = []
    seen_coord = {}
    for (osm_id, osm_type, name, stype, network, lat, lon) in h.stops_raw:
        key = (round(lat, 5), round(lon, 5), name)
        if key in seen_coord:
            row_id = seen_coord[key]
        else:
            row_id = len(dedup_stops) + 1
            dedup_stops.append((row_id, osm_id, osm_type, name, stype, network, lat, lon))
            seen_coord[key] = row_id
        stop_by_osm[osm_id] = row_id

    # ---- route_stops from route members ----
    print("Resolving route stop sequences...")
    route_stops_rows = []
    route_pk = {}  # (rtype, osm_id) -> assigned row id, filled after DB insert of routes

    # ---- write SQLite ----
    print("Writing", DB)
    import os
    os.makedirs("/home/claude/sofiamap/data", exist_ok=True)
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.executescript("""
    PRAGMA journal_mode=WAL;
    DROP TABLE IF EXISTS streets;
    DROP TABLE IF EXISTS buildings;
    DROP TABLE IF EXISTS organizations;
    DROP TABLE IF EXISTS stops;
    DROP TABLE IF EXISTS route_stops;
    DROP TABLE IF EXISTS routes_bus;
    DROP TABLE IF EXISTS routes_tram;
    DROP TABLE IF EXISTS routes_trolleybus;
    DROP TABLE IF EXISTS routes_metro;
    DROP TABLE IF EXISTS districts;
    DROP TABLE IF EXISTS settlements;
    DROP TABLE IF EXISTS other_entities;

    CREATE TABLE streets (
      id INTEGER PRIMARY KEY, osm_id INTEGER, osm_type TEXT, name TEXT, name_en TEXT,
      highway TEXT, ref TEXT, oneway TEXT, surface TEXT, lanes TEXT, maxspeed TEXT,
      lanes_forward TEXT, lanes_backward TEXT,
      geometry TEXT
    );
    CREATE TABLE buildings (
      id INTEGER PRIMARY KEY, osm_id INTEGER, osm_type TEXT, building TEXT, name TEXT,
      housenumber TEXT, housenumber_src TEXT, addr_street TEXT, city TEXT, postcode TEXT,
      levels TEXT, height REAL, height_src TEXT,
      street_id INTEGER, street_resolved TEXT, street_match TEXT,
      lat REAL, lon REAL, geometry TEXT
    );
    CREATE TABLE organizations (
      id INTEGER PRIMARY KEY, osm_id INTEGER, osm_type TEXT, name TEXT, name_en TEXT,
      rubric TEXT, raw_key TEXT, raw_value TEXT,
      housenumber TEXT, addr_street TEXT, city TEXT,
      phone TEXT, website TEXT, email TEXT, opening_hours TEXT, wheelchair TEXT,
      lat REAL, lon REAL
    );
    CREATE TABLE stops (
      id INTEGER PRIMARY KEY, osm_id INTEGER, osm_type TEXT, name TEXT, stop_type TEXT,
      network TEXT, lat REAL, lon REAL
    );
    CREATE TABLE route_stops (
      route_type TEXT, route_id INTEGER, stop_id INTEGER, seq INTEGER, role TEXT
    );
    CREATE TABLE routes_bus (id INTEGER PRIMARY KEY, osm_id INTEGER, ref TEXT, name TEXT, operator TEXT, network TEXT, from_name TEXT, to_name TEXT);
    CREATE TABLE routes_tram (id INTEGER PRIMARY KEY, osm_id INTEGER, ref TEXT, name TEXT, operator TEXT, network TEXT, from_name TEXT, to_name TEXT);
    CREATE TABLE routes_trolleybus (id INTEGER PRIMARY KEY, osm_id INTEGER, ref TEXT, name TEXT, operator TEXT, network TEXT, from_name TEXT, to_name TEXT);
    CREATE TABLE routes_metro (id INTEGER PRIMARY KEY, osm_id INTEGER, ref TEXT, name TEXT, operator TEXT, network TEXT, from_name TEXT, to_name TEXT);
    CREATE TABLE districts (id INTEGER PRIMARY KEY, osm_id INTEGER, name TEXT, name_en TEXT, admin_level TEXT, lat REAL, lon REAL, geometry TEXT);
    CREATE TABLE settlements (id INTEGER PRIMARY KEY, osm_id INTEGER, name TEXT, name_en TEXT, admin_level TEXT, lat REAL, lon REAL, geometry TEXT);
    CREATE TABLE other_entities (tag_key TEXT, tag_value TEXT, osm_type TEXT, count INTEGER);
    -- _applied_patches (server/src/lib/applyPatches.js) tracks which
    -- data/patches/*.json fixes have already been applied to THIS db file,
    -- by patch id — it's not one of this script's own tables, but a
    -- full rebuild here recreates buildings/streets/etc. from scratch,
    -- silently undoing whatever those patches changed (e.g. postcode
    -- backfills) while leaving their ids marked "already applied". Left
    -- alone, that combination makes the patches permanently skipped after
    -- the very rebuild that most needs them re-run. Dropping it here means
    -- a rebuilt db always starts with a clean slate, so every patch in
    -- data/patches/ reapplies fresh the next time the server starts.
    DROP TABLE IF EXISTS _applied_patches;
    """)

    # h.streets rows are (osm_id, osm_type, name, name_en, highway, ref, oneway, surface, lanes, maxspeed, lanes_forward, lanes_backward, geojson_str, shapely_geom)
    cur.executemany(
        "INSERT INTO streets (osm_id,osm_type,name,name_en,highway,ref,oneway,surface,lanes,maxspeed,lanes_forward,lanes_backward,geometry) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [s[:13] for s in h.streets],
    )
    conn.commit()

    cur.executemany(
        "INSERT INTO buildings (osm_id,osm_type,building,name,housenumber,housenumber_src,addr_street,city,postcode,levels,height,height_src,street_id,street_resolved,street_match,lat,lon,geometry) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(
            b["osm_id"], b["osm_type"], b["building"], b["name"], b["housenumber"], b["housenumber_src"], b["street"], b["city"],
            b["postcode"], b["levels"], b["height"], b["height_src"], b["street_id"], b["street_resolved"],
            b["street_match"], b["lat"], b["lon"], json.dumps(mapping(b["geom"])),
        ) for b in h.buildings],
    )
    conn.commit()

    cur.executemany(
        "INSERT INTO organizations (osm_id,osm_type,name,name_en,rubric,raw_key,raw_value,housenumber,addr_street,city,phone,website,email,opening_hours,wheelchair,lat,lon) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        h.organizations,
    )
    conn.commit()

    cur.executemany(
        "INSERT INTO stops (id,osm_id,osm_type,name,stop_type,network,lat,lon) VALUES (?,?,?,?,?,?,?,?)",
        dedup_stops,
    )
    conn.commit()

    route_id_map = {}
    for rtype, table in (("bus", "routes_bus"), ("tram", "routes_tram"), ("trolleybus", "routes_trolleybus"), ("metro", "routes_metro")):
        rows = h.routes[rtype]
        cur.executemany(f"INSERT INTO {table} (osm_id,ref,name,operator,network,from_name,to_name) VALUES (?,?,?,?,?,?,?)", rows)
        conn.commit()
        cur.execute(f"SELECT id, osm_id FROM {table}")
        for rid, osm_id in cur.fetchall():
            route_id_map[(rtype, osm_id)] = rid

    for rtype, osm_id, members in h.route_members:
        rid = route_id_map.get((rtype, osm_id))
        if rid is None:
            continue
        seq = 0
        for mtype, mref, mrole in members:
            if mtype != "n":
                continue
            stop_row = stop_by_osm.get(mref)
            if stop_row is None:
                continue
            seq += 1
            route_stops_rows.append((rtype, rid, stop_row, seq, mrole or ""))
    cur.executemany("INSERT INTO route_stops (route_type,route_id,stop_id,seq,role) VALUES (?,?,?,?,?)", route_stops_rows)
    conn.commit()

    cur.executemany(
        "INSERT INTO districts (osm_id,name,name_en,admin_level,lat,lon,geometry) VALUES (?,?,?,?,?,?,?)",
        h.districts,
    )
    cur.executemany(
        "INSERT INTO settlements (osm_id,name,name_en,admin_level,lat,lon,geometry) VALUES (?,?,?,?,?,?,?)",
        h.settlements,
    )
    conn.commit()

    other_rows = [(k[0], k[1], k[2], v[0]) for k, v in h.other_counter.items()]
    cur.executemany("INSERT INTO other_entities (tag_key,tag_value,osm_type,count) VALUES (?,?,?,?)", other_rows)
    conn.commit()

    for idx_sql in [
        "CREATE INDEX idx_buildings_street ON buildings(addr_street)",
        "CREATE INDEX idx_buildings_name ON buildings(name)",
        "CREATE INDEX idx_streets_name ON streets(name)",
        "CREATE INDEX idx_org_name ON organizations(name)",
        "CREATE INDEX idx_org_rubric ON organizations(rubric)",
        "CREATE INDEX idx_stops_name ON stops(name)",
        "CREATE INDEX idx_route_stops_route ON route_stops(route_type, route_id)",
        "CREATE INDEX idx_districts_name ON districts(name)",
        "CREATE INDEX idx_settlements_name ON settlements(name)",
    ]:
        cur.execute(idx_sql)
    conn.commit()

    print("\n=== row counts ===")
    for t in ["streets", "buildings", "organizations", "stops", "route_stops",
              "routes_bus", "routes_tram", "routes_trolleybus", "routes_metro",
              "districts", "settlements", "other_entities"]:
        cur.execute(f"SELECT COUNT(*) FROM {t}")
        print(f"  {t}: {cur.fetchone()[0]}")
    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
