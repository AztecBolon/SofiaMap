#!/usr/bin/env python3
"""Corridor-based lane-count smoothing (2026-09-07 follow-up fix).

Root cause of the "hard lane-width drop" visual bug reported by the user
along бул. Витоша (and earlier бул. Патриарх Евтимий, partially fixed by
merge_line_strings): Sofia's OSM ways are digitized as many short segments
per physical street, and `lanes`/`lanes:forward`/`lanes:backward` are
tagged PER WAY, not per street. Along a single named corridor these values
routinely jitter way beyond any real lane change (бул. Витоша, one
carriageway, oneway=yes: 1,1,2,1,2,4,2,2,1,1,3,3,1,1 across consecutive
10-50m ways). merge_line_strings (see sofia-schema.yml) only merges
ADJACENT ways whose attributes are already IDENTICAL — it can't fix two
neighboring ways that both have real (but different, noisy) values.

Fix: read the already-parsed streets table from sofia.db (has geometry +
lanes/oneway/lanes:forward/lanes:backward per way), chain same-name ways
into corridors via shared endpoint coordinates, and replace each way's
forward/backward lane count with a LOCAL weighted median (weighted by way
length, window = ~120m of corridor in each direction) over its
neighborhood in that corridor graph. This smooths out short-run tagging
noise while leaving genuine, sustained lane changes (which persist over
many consecutive ways, not just one) intact.

Output: raw/sofia_lanes_smoothed.geojson — one LineString feature per way
in the lane-rendered highway classes, carrying (already smoothed)
`lanes`, `oneway`, `lanes_forward`, `lanes_backward` properties, consumed
by a new `osm_lanes` GeoJSON source in pipeline/sofia-schema.yml (the
three tiers that render lanes point at this instead of the raw `osm`
source; every other layer/tier is untouched).

Does NOT modify sofia.db, sofia.db's own `streets` table, or search/
address data — this only affects what the map draws for lanes.

2026-09-15 follow-up ("dead end" lane stubs): user-reported isolated
capsule-shaped lane bands sticking out at ramp/merge points (Tsarigradsko
shose interchanges and similar). Short, unnamed-or-differently-named link
ways never chain into a corridor above, so each is smoothed on its own vote
and drawn as its own abrupt multi-lane band with no taper into the road it
joins. See MIN_ISOLATED_LANE_LEN_M and its use in the output loop below for
the (user-approved, "cheap") fix: such ways just fall back to a plain line.
"""
import json
import math
import sqlite3
from collections import defaultdict

DB_PATH = "data/sofia.db"
OUT_PATH = "raw/sofia_lanes_smoothed.geojson"

# Same set map-style.js's LANE_CLASSES covers.
LANE_CLASSES = [
    "motorway", "trunk", "motorway_link", "trunk_link",
    "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link",
]

LAT0 = 42.7
M_PER_DEG_LAT = 111320.0
M_PER_DEG_LON = 111320.0 * math.cos(math.radians(LAT0))

WINDOW_M = 120.0  # how far along the corridor (each direction) to pool votes
MAX_HOPS = 40      # hard cap so a pathological huge component can't run away

# "Dead end" lane-stub suppression (2026-09-15 follow-up — user-reported
# capsule-shaped stubs sticking out at ramp/merge points, e.g. Tsarigradsko
# shose interchanges). A way only ever gets a corridor neighbor in
# `adjacency` below when another way shares its exact `name` and touches it
# end-to-end — motorway/trunk link ramps are frequently unnamed, or named
# differently from the road they join, so they are ALWAYS a singleton
# "corridor" of one, smoothed purely on their own vote. Drawn on their own by
# buildLaneLayers() (map-style.js), a short one renders as an isolated
# multi-lane "capsule" that starts and stops abruptly mid-air instead of
# tapering into the road it actually joins — MapLibre has no way to taper a
# line's width along its length, so there's no cheap way to draw the taper
# itself. Cheapest fix, approved by the user over reshaping the merge
# geometry: once a way is BOTH shorter than this threshold AND has no
# corridor neighbor to blend into, don't draw it as its own multi-lane band —
# see the suppression in the output loop below. 40m comfortably covers the
# ~10-30m ramp-taper stubs seen in the reports while sparing genuine short
# (but corridor-connected) urban blocks, which keep their real lane count.
MIN_ISOLATED_LANE_LEN_M = 40.0


def endpoint_key(lon, lat):
    return (round(lon, 7), round(lat, 7))


def way_length_m(coords):
    total = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:]):
        dx = (lon2 - lon1) * M_PER_DEG_LON
        dy = (lat2 - lat1) * M_PER_DEG_LAT
        total += math.hypot(dx, dy)
    return total


def own_fwd_bwd(lanes, oneway, lanes_forward, lanes_backward):
    """Replicates map-style.js's LANES_FWD/LANES_BWD case expressions.
    Returns (fwd, bwd, known) — known=False means there's no lane data at
    all on this way (so it shouldn't cast a vote in its neighborhood, only
    receive one)."""
    lanes_total = float(lanes) if lanes not in ("", None) else 0.0
    if lanes_forward not in ("", None):
        fwd = float(lanes_forward)
        bwd = float(lanes_backward) if lanes_backward not in ("", None) else max(lanes_total - fwd, 0.0)
        return fwd, bwd, True
    if lanes_backward not in ("", None):
        bwd = float(lanes_backward)
        fwd = max(lanes_total - bwd, 0.0)
        return fwd, bwd, True
    if oneway == "yes":
        return lanes_total, 0.0, lanes_total > 0
    if oneway == "-1":
        return 0.0, lanes_total, lanes_total > 0
    if lanes_total > 0:
        return math.ceil(lanes_total / 2), math.floor(lanes_total / 2), True
    return 0.0, 0.0, False


def chaikin_smooth(coords, iterations=1):
    """Corner-cutting curve smoothing (2026-09-07, "sharp corners on smooth
    turns" follow-up request). Sofia's OSM ways are digitized with only as
    many nodes as needed for the real curve, which at close zoom, drawn as
    a thick multi-lane band instead of a hairline, reads as a faceted
    polygon rather than a smooth bend — small angle changes invisible on a
    2px line become visible kinks at 20-30px of combined lane width.
    Chaikin's algorithm replaces each interior vertex with two points 1/4
    and 3/4 of the way along its neighboring segments, rounding every
    corner into a short arc. The FIRST and LAST coordinates are always
    kept exactly as-is (never moved) — those are the shared junction
    nodes this same script's own corridor-matching (and Planetiler's
    merge_line_strings) key off of; moving them would silently break both.
    A straight run of collinear points is unaffected (cutting a corner
    that isn't there does nothing), so this only visibly changes anything
    where the road actually bends.
    """
    pts = [tuple(c) for c in coords]
    for _ in range(iterations):
        if len(pts) < 3:
            break
        new_pts = [pts[0]]
        for i in range(len(pts) - 1):
            p0, p1 = pts[i], pts[i + 1]
            new_pts.append((p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25))
            new_pts.append((p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75))
        new_pts.append(pts[-1])
        pts = new_pts
    return [list(p) for p in pts]


def weighted_median(pairs):
    """pairs: list of (value, weight). Returns the weighted-median value
    (always one of the actual input values)."""
    if not pairs:
        return None
    pairs = sorted(pairs, key=lambda p: p[0])
    total = sum(w for _, w in pairs)
    if total <= 0:
        return pairs[len(pairs) // 2][0]
    cum = 0.0
    half = total / 2.0
    for val, w in pairs:
        cum += w
        if cum >= half:
            return val
    return pairs[-1][0]


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Schema-drift guard (2026-09-15, discovered while actually running this
    # script end-to-end for the first time against the live sofia.db — every
    # earlier session validated this file with py_compile only, never a real
    # run: see claude/implementation-log.md). parse_full.py's CREATE TABLE
    # streets has carried lanes_forward/lanes_backward columns since this
    # script's original 2026-09-07 wave, but the sofia.db actually deployed
    # here predates that — it was never regenerated by a fresh full OSM
    # parse since (that needs the raw OSM extract, a separate manual step —
    # see README's pipeline section). Rather than crash on the missing
    # columns, degrade to what own_fwd_bwd() already treats as "no explicit
    # split" (its own documented fallback: an even floor/ceil of the plain
    # `lanes` total) — exactly the behavior parse_full.py's own comment next
    # to `tags.get("lanes:forward", "")` describes for a way that simply
    # never had the tag. Once sofia.db is eventually rebuilt with these
    # columns populated, this script picks them up automatically — no code
    # change needed then.
    cur.execute("PRAGMA table_info(streets)")
    streets_cols = {row[1] for row in cur.fetchall()}
    has_lane_split = "lanes_forward" in streets_cols and "lanes_backward" in streets_cols
    if not has_lane_split:
        print(
            "NOTE: sofia.db's `streets` table has no lanes_forward/lanes_backward "
            "columns (stale schema, not yet re-parsed from OSM with the current "
            "parse_full.py) — proceeding with plain `lanes`+`oneway` only; every "
            "way falls back to an even forward/backward split, same as a way "
            "that was simply never tagged with an explicit split."
        )
    lf_select = "lanes_forward" if has_lane_split else "'' AS lanes_forward"
    lb_select = "lanes_backward" if has_lane_split else "'' AS lanes_backward"

    placeholders = ",".join("?" for _ in LANE_CLASSES)
    cur.execute(
        f"SELECT osm_id, name, highway, lanes, oneway, {lf_select}, {lb_select}, geometry "
        f"FROM streets WHERE highway IN ({placeholders})",
        LANE_CLASSES,
    )
    rows = cur.fetchall()
    print(f"Loaded {len(rows)} candidate ways.")

    ways = {}
    for osm_id, name, highway, lanes, oneway, lanes_forward, lanes_backward, geom_json in rows:
        geom = json.loads(geom_json)
        if geom.get("type") != "LineString":
            continue
        coords = geom["coordinates"]
        if len(coords) < 2:
            continue
        fwd, bwd, known = own_fwd_bwd(lanes, oneway, lanes_forward, lanes_backward)
        ways[osm_id] = {
            "osm_id": osm_id,
            "name": name or "",
            "highway": highway,
            "coords": coords,
            "length_m": way_length_m(coords),
            "own_fwd": fwd,
            "own_bwd": bwd,
            "known": known,
        }

    # Build endpoint adjacency, keyed by (name, endpoint) so different
    # streets that happen to touch at a node never get linked, and unnamed
    # ways never link to anything (each is its own singleton corridor).
    endpoint_index = defaultdict(list)  # (name, coord_key) -> [(osm_id, 'start'|'end')]
    for wid, w in ways.items():
        if not w["name"]:
            continue
        start = endpoint_key(*w["coords"][0])
        end = endpoint_key(*w["coords"][-1])
        endpoint_index[(w["name"], start)].append((wid, "start"))
        endpoint_index[(w["name"], end)].append((wid, "end"))

    # adjacency[wid] = list of (other_wid, same_orientation: bool)
    adjacency = defaultdict(list)
    for (_name, _key), touching in endpoint_index.items():
        if len(touching) < 2:
            continue
        for i in range(len(touching)):
            for j in range(len(touching)):
                if i == j:
                    continue
                wid_a, end_a = touching[i]
                wid_b, end_b = touching[j]
                # Same orientation if the ways connect "end-to-start" style
                # (a natural continuation); opposite if both wall the same
                # kind of end (start-start or end-end) at this junction.
                same_orientation = end_a != end_b
                adjacency[wid_a].append((wid_b, same_orientation))

    # BFS per connected component (by name-linked adjacency) to assign a
    # `flipped` parity to every way relative to an arbitrary root, so
    # "physical forward" means the same real-world direction for every way
    # in the corridor regardless of which way each individual way happens
    # to be digitized.
    flipped = {}
    visited = set()
    components = 0
    for start_wid in ways:
        if start_wid in visited:
            continue
        components += 1
        flipped[start_wid] = False
        visited.add(start_wid)
        queue = [start_wid]
        while queue:
            cur_wid = queue.pop()
            for nbr_wid, same_orientation in adjacency.get(cur_wid, []):
                if nbr_wid in visited:
                    continue
                flipped[nbr_wid] = flipped[cur_wid] if same_orientation else not flipped[cur_wid]
                visited.add(nbr_wid)
                queue.append(nbr_wid)

    print(f"{components} connected named corridors (plus unnamed singletons).")

    def physical(wid):
        w = ways[wid]
        if not w["known"]:
            return None, None
        if flipped.get(wid, False):
            return w["own_bwd"], w["own_fwd"]
        return w["own_fwd"], w["own_bwd"]

    # Local neighborhood smoothing: BFS out from each way along `adjacency`
    # up to WINDOW_M in each direction (capped at MAX_HOPS), collecting
    # (physical_fwd, physical_bwd, weight=length) votes, then take the
    # weighted median independently for fwd and bwd.
    smoothed_fwd = {}
    smoothed_bwd = {}
    for wid, w in ways.items():
        pf, pb = physical(wid)
        votes_fwd = []
        votes_bwd = []
        if pf is not None:
            votes_fwd.append((pf, w["length_m"] or 1.0))
        if pb is not None:
            votes_bwd.append((pb, w["length_m"] or 1.0))

        # BFS both directions along the corridor graph, tracking cumulative
        # distance traveled to know when to stop.
        seen = {wid}
        frontier = [(wid, 0.0)]
        hops = 0
        while frontier and hops < MAX_HOPS:
            hops += 1
            next_frontier = []
            for cur_wid, dist in frontier:
                for nbr_wid, _ in adjacency.get(cur_wid, []):
                    if nbr_wid in seen:
                        continue
                    nbr = ways[nbr_wid]
                    new_dist = dist + (nbr["length_m"] or 1.0)
                    if new_dist > WINDOW_M:
                        continue
                    seen.add(nbr_wid)
                    npf, npb = physical(nbr_wid)
                    if npf is not None:
                        votes_fwd.append((npf, nbr["length_m"] or 1.0))
                    if npb is not None:
                        votes_bwd.append((npb, nbr["length_m"] or 1.0))
                    next_frontier.append((nbr_wid, new_dist))
            frontier = next_frontier

        smoothed_fwd[wid] = weighted_median(votes_fwd)
        smoothed_bwd[wid] = weighted_median(votes_bwd)

    changed = 0
    isolated_suppressed = 0
    features = []
    for wid, w in ways.items():
        pf = smoothed_fwd[wid]
        pb = smoothed_bwd[wid]
        if pf is None and pb is None:
            fwd, bwd = 0.0, 0.0
        else:
            pf = pf or 0.0
            pb = pb or 0.0
            if flipped.get(wid, False):
                fwd, bwd = pb, pf
            else:
                fwd, bwd = pf, pb
        fwd_i, bwd_i = int(round(fwd)), int(round(bwd))
        if w["known"] and (fwd_i != int(round(w["own_fwd"])) or bwd_i != int(round(w["own_bwd"]))):
            changed += 1
        if (fwd_i > 0 or bwd_i > 0) and w["length_m"] < MIN_ISOLATED_LANE_LEN_M and not adjacency.get(wid):
            # Short + no corridor neighbor => isolated dead-end stub. Force
            # both to 0 so LANES_FWD/LANES_BWD (map-style.js) fall back to
            # the plain single "roads" line instead of a separate lane band —
            # the road itself keeps drawing, only its isolated multi-lane
            # capsule rendering is suppressed.
            fwd_i, bwd_i = 0, 0
            isolated_suppressed += 1
        oneway = "yes" if bwd_i == 0 and fwd_i > 0 else ("-1" if fwd_i == 0 and bwd_i > 0 else "")
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": chaikin_smooth(w["coords"], iterations=1)},
            "properties": {
                "highway": w["highway"],
                "name": w["name"],
                "lanes": str(fwd_i + bwd_i),
                "oneway": oneway,
                "lanes_forward": str(fwd_i),
                "lanes_backward": str(bwd_i),
            },
        })

    print(f"{changed} of {len(ways)} ways had their fwd/bwd lane count changed by smoothing.")
    print(
        f"{isolated_suppressed} of {len(ways)} ways were isolated dead-end lane "
        f"stubs (< {MIN_ISOLATED_LANE_LEN_M:.0f}m, no corridor neighbor) and had "
        f"their lane band suppressed (fall back to a plain line)."
    )

    with open(OUT_PATH, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    print(f"Wrote {len(features)} features to {OUT_PATH}")


if __name__ == "__main__":
    main()
