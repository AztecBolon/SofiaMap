const express = require("express");
const db = require("../db");
const { pointInGeometry } = require("../lib/geo");
const { buildingKindLabel } = require("../lib/buildingKind");
const { withDesignation } = require("../lib/streetDesignation");
const {
  clusterStreetSegments,
  distancePointToGeometry,
  representativePoint,
  dedupeLabels,
} = require("../lib/streetCluster");
const { priorityRank } = require("../lib/housenumberProvenance");

const router = express.Router();

const ROUTE_TABLES = { bus: "routes_bus", tram: "routes_tram", trolleybus: "routes_trolleybus", metro: "routes_metro" };

const getRouteStops = db.prepare(`
  SELECT s.id, s.name, s.lat, s.lon, rs.seq
  FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
  WHERE rs.route_type = ? AND rs.route_id = ?
  ORDER BY rs.seq
`);

// GET /api/route/:type/:id/stops -> ordered stop list for a transit route
router.get("/route/:type/:id/stops", (req, res) => {
  const { type, id } = req.params;
  if (!ROUTE_TABLES[type]) return res.status(400).json({ error: "unknown_route_type" });
  const rows = getRouteStops.all(type, id);
  res.json(rows.map((r, i) => ({ num: i + 1, id: r.id, name: r.name, lat: r.lat, lng: r.lon })));
});

const buildingsInBox = db.prepare(`
  SELECT id, name, addr_street, housenumber, building, height, geometry, lat, lon
  FROM buildings
  WHERE lat BETWEEN @minLat AND @maxLat AND lon BETWEEN @minLon AND @maxLon
`);
const nearestStop = db.prepare(`
  SELECT id, name, stop_type, lat, lon,
    ((lat - @lat) * (lat - @lat) + (lon - @lon) * (lon - @lon)) AS d2
  FROM stops ORDER BY d2 ASC LIMIT 1
`);
const nearestCompany = db.prepare(`
  SELECT id, name, rubric, lat, lon,
    ((lat - @lat) * (lat - @lat) + (lon - @lon) * (lon - @lon)) AS d2
  FROM organizations ORDER BY d2 ASC LIMIT 1
`);

// GET /api/hit-test?lat=&lng= -> best-guess feature under a map click, used
// for the "click empty map spot" popup (analogous to /services/onmap-getdetails
// in the moscowmap reference).
router.get("/hit-test", (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: "bad_coords" });

  const pad = 0.0015; // ~150m box, then exact point-in-polygon test
  const candidates = buildingsInBox.all({ minLat: lat - pad, maxLat: lat + pad, minLon: lng - pad, maxLon: lng + pad });
  for (const b of candidates) {
    const geom = JSON.parse(b.geometry);
    if (pointInGeometry(lng, lat, geom)) {
      return res.json({
        type: "FeatureCollection",
        features: [{
          type: "Feature", geometry: geom,
          // A bare street name (no housenumber) isn't really this object's
          // "name" — it's fine as an informal address for an ordinary
          // unnumbered house ("ул. X"), but reads as a fabricated address
          // for a large unnamed landmark (a stadium, a school — see
          // buildingKind.js). Only fall back to the street when there's
          // also a housenumber to go with it; otherwise say what kind of
          // building this actually is.
          properties: {
            name: b.name || (b.housenumber && [withDesignation(b.addr_street), b.housenumber].filter(Boolean).join(" "))
              || buildingKindLabel(b.building),
            type: "address", url: null, id: b.id,
          },
        }],
      });
    }
  }

  const stopCandidate = nearestStop.get({ lat, lon: lng });
  const companyCandidate = nearestCompany.get({ lat, lon: lng });
  const M2DEG2 = 0.0002 * 0.0002; // ~20m radius, roughly
  const near = [stopCandidate, companyCandidate].filter((c) => c && c.d2 < M2DEG2);
  if (near.length) {
    const best = near.sort((a, b) => a.d2 - b.d2)[0];
    return res.json({
      type: "FeatureCollection",
      features: [{
        type: "Feature", geometry: { type: "Point", coordinates: [best.lon, best.lat] },
        properties: { name: best.name, type: best.stop_type ? "stop" : "company", url: null, id: best.id },
      }],
    });
  }

  res.json({ type: "FeatureCollection", features: [] });
});

const streetsByName = db.prepare(`SELECT osm_id, name, geometry FROM streets WHERE lower_u(name) = lower_u(@name)`);
const nearestDistrictToPoint = db.prepare(`
  SELECT name, lat, lon,
    ((lat - @lat) * (lat - @lat) + (lon - @lon) * (lon - @lon)) AS d2
  FROM districts ORDER BY d2 ASC LIMIT 1
`);

// GET /api/street-at?name=&lat=&lng= -> which SPECIFIC same-named street
// cluster (see lib/streetCluster.js) is actually at/near this point.
//
// Used by the "Найти на карте →" button on a road's hover popup on the map
// itself: the vector tile only ever carries a bare `name` for a road (see
// pipeline/sofia-schema.yml — no osm_id shipped, to keep tiles small), so
// the click handler used to just drop that name into the search box and
// run a plain text search — which, for a name shared by several unrelated
// real streets (see streetCluster.js), opened ALL of them at once instead
// of the one actually clicked. This endpoint uses the point the user
// actually clicked/hovered to disambiguate, the same way /api/hit-test
// already does for buildings.
router.get("/street-at", (req, res) => {
  const name = String(req.query.name || "").trim();
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!name || !isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: "bad_params" });

  const rows = streetsByName.all({ name });
  if (!rows.length) return res.json({ found: false });

  const parsed = rows.map((r) => ({ ...r, geometry: JSON.parse(r.geometry) }));
  const clusters = clusterStreetSegments(parsed);

  let bestCluster = clusters[0];
  let bestDist = Infinity;
  for (const cluster of clusters) {
    for (const seg of cluster) {
      const d = distancePointToGeometry([lng, lat], seg.geometry);
      if (d < bestDist) {
        bestDist = d;
        bestCluster = cluster;
      }
    }
  }
  const rep = bestCluster.slice().sort((a, b) => a.osm_id - b.osm_id)[0];

  // Same disambiguation rule as search.js's "street" sub-search: only add a
  // district hint when this name actually resolves to more than one real
  // street, deduped against every OTHER cluster of this same name so two
  // that share the same nearest-district label (Sofia's districts don't
  // fully tile the city) still end up distinguishable — see
  // streetCluster.js's dedupeLabels comment for why a compass bearing was
  // tried and rejected here.
  let districtLabel = null;
  if (clusters.length > 1) {
    const withDistrict = clusters.map((cluster) => {
      const r = cluster.slice().sort((a, b) => a.osm_id - b.osm_id)[0];
      const point = representativePoint(r.geometry);
      const district = point ? nearestDistrictToPoint.get({ lat: point[1], lon: point[0] }) : null;
      return { osmId: r.osm_id, district };
    });
    const labels = dedupeLabels(withDistrict.map((e) => (e.district ? e.district.name : "")));
    const mineIdx = withDistrict.findIndex((e) => e.osmId === rep.osm_id);
    districtLabel = withDistrict[mineIdx].district ? labels[mineIdx] : null;
  }
  res.json({ found: true, id: rep.osm_id, name: rep.name, district: districtLabel });
});

const streetById = db.prepare(`SELECT osm_id, name, geometry FROM streets WHERE osm_id = @id`);
const buildingsByStreetName = db.prepare(`
  SELECT id, name, addr_street, housenumber, housenumber_src, lat, lon
  FROM buildings
  WHERE lower_u(addr_street) = lower_u(@name)
    AND (name != '' OR housenumber != '')
`);
// Same 400m ballpark as pipeline/parse_full.py's street_resolved backfill
// (300m) plus some slack for the gap between a building's centroid and the
// street's own drawn line (a backfilled building was matched to the
// nearest NAMED street within 300m of *some point on it*, not of its
// centroid specifically) — not an exact replay of that pipeline step, just
// close enough that a house genuinely on this physical street doesn't get
// dropped here while one on a same-named street clustered elsewhere in the
// city (see streetCluster.js) reliably does.
const HOUSE_STREET_MAX_M = 400;
function housenumberSortKey(hn) {
  const m = String(hn || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
}
// Russian/Bulgarian-in-Russian-UI plural of "запись" (fem., -ь) for the
// duplicate-address subtitle below.
function recordsWord(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "запись";
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "записи";
  return "записей";
}

// GET /api/street/:id/houses -> houses actually on THIS specific street
// cluster (see lib/streetCluster.js), for the "select a street -> see its
// houses" drill-down (2026-09-06, modeled on the same-shaped "select a
// rubric -> see its organizations" flow rubric.js already had). Sofia
// reuses street names across unrelated neighbourhoods, so this can't just
// be "every building with this addr_street" (see coord.js's /street-at for
// the same problem on the map-click side) — it has to be every matching
// building that's actually physically near THIS street's own cluster of
// segments, not some other same-named street kilometers away. Buildings
// with neither a name nor a housenumber of their own (the street_resolved
// backfill's anonymous "Здание" placeholders — see search.js's
// ADDRESS_NO_NUMBER comment) are excluded for the same reason they're
// excluded from text search: they're not a distinguishable result.
router.get("/street/:id/houses", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  const first = streetById.get({ id });
  if (!first) return res.status(404).json({ error: "not_found" });

  const sameName = streetsByName.all({ name: first.name }).map((r) => ({ ...r, geometry: JSON.parse(r.geometry) }));
  const clusters = clusterStreetSegments(sameName);
  const myCluster = clusters.find((c) => c.some((s) => s.osm_id === id)) || sameName.filter((s) => s.osm_id === id);

  const matched = buildingsByStreetName
    .all({ name: first.name })
    .map((b) => {
      let best = Infinity;
      for (const seg of myCluster) {
        const d = distancePointToGeometry([b.lon, b.lat], seg.geometry);
        if (d < best) best = d;
      }
      return { ...b, _d: best };
    })
    .filter((b) => b._d <= HOUSE_STREET_MAX_M)
    .sort(
      (a, b) =>
        housenumberSortKey(a.housenumber) - housenumberSortKey(b.housenumber) ||
        String(a.housenumber).localeCompare(String(b.housenumber), "bg") ||
        // Same civic number, several building rows — see
        // lib/housenumberProvenance.js for why (different upstream imports
        // digitized the same real building more than once) and
        // streetsDirectory.js's getHousesForEntry, which this mirrors, for
        // the full writeup. Order the more directly-sourced row first so
        // it's the one that survives the collapse below.
        priorityRank(a.housenumber_src) - priorityRank(b.housenumber_src) ||
        a.id - b.id
    );

  // 2026-09-09 fix (reported live: map search's "Жамбилица" house list
  // showed "№ 1"/"№ 2"/etc. two-three times each) — collapse building rows
  // that share a real civic number down to one entry, same rule
  // streetsDirectory.js uses for the static street pages. A collapsed
  // entry's subtitle says how many other source records exist for it so
  // the count in `meta.total` (still the raw row count) isn't mysteriously
  // larger than the list — nothing is deleted, every row is still a real
  // point on the map.
  const collapsed = [];
  let i = 0;
  while (i < matched.length) {
    const key = (matched[i].housenumber || "").trim();
    let j = i + 1;
    if (key) while (j < matched.length && (matched[j].housenumber || "").trim() === key) j++;
    collapsed.push({ building: matched[i], extraCount: j - i - 1 });
    i = j;
  }

  const LIMIT = 300;
  const items = collapsed.slice(0, LIMIT).map(({ building: b, extraCount }) => ({
    id: b.id, type: "address",
    name: b.name || [withDesignation(first.name), b.housenumber].filter(Boolean).join(" "),
    subtitle: b.housenumber ? `№ ${b.housenumber}${extraCount ? ` · ещё ${extraCount} ${recordsWord(extraCount)} того же адреса в исходных данных` : ""}` : "",
    lat: b.lat, lng: b.lon, map_key: `address:${b.id}`,
  }));

  res.json({
    meta: { name: withDesignation(first.name), total: collapsed.length, returned: items.length, partial: collapsed.length > items.length },
    items,
  });
});

module.exports = router;
