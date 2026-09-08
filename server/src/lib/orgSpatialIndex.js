// Shared in-memory spatial index over `organizations` (20 699 rows) —
// built once at first use and kept for the process lifetime (same
// justification as streetsDirectory.js's eager cache: the DB is opened
// read-only and never changes, see db.js, so there's nothing to
// invalidate this with).
//
// Why this exists: orgMatch.js's tier-3 "nothing certain found — check
// what's within 50m" fallback and rubricsDirectory.js's "Инфраструктура
// рядом"/"?near=" queries were both hitting the DB with a
// `WHERE lat BETWEEN ... AND lon BETWEEN ...` prepared statement — cheap
// for ONE building/point (house-page-template.md's own house-page timing,
// §14/§16, measured whole-page renders around 70ms), but there's no index
// on `organizations(lat, lon)` for SQLite to use, so each call is a full
// 20 699-row scan. That's fine once per house page, but the street page's
// new "Организации" block (house-page-template.md's street-page
// adaptation, 2026-09-07) calls the equivalent of a house-page lookup
// once per house on the street — measured 3.8s for a 554-house boulevard
// before this index existed, almost entirely spent in repeated full-table
// scans for houses whose tier-3 fallback query came up empty (the common
// case). A simple uniform grid (bucket by 0.005°, ~550m×400m at Sofia's
// latitude — comfortably larger than every "nearby" radius used across
// the site, 50-1500m, so a query never spans more than a handful of
// buckets) turns each lookup into "the few dozen orgs in nearby buckets"
// instead of "all 20 699", which is what actually made the street page
// fast again (see routes/pages.js's regression notes for the after
// number).
const db = require("../db");

const CELL_DEG = 0.005;

let cellIndex = null; // "latCell:lonCell" -> org[]
let byHousenumber = null; // lowercased housenumber -> org[] (only rows with both housenumber AND addr_street)

function cellKey(lat, lon) {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
}

function build() {
  const rows = db.prepare(`SELECT id, name, rubric, addr_street, housenumber, lat, lon FROM organizations`).all();
  cellIndex = new Map();
  byHousenumber = new Map();
  for (const r of rows) {
    const key = cellKey(r.lat, r.lon);
    if (!cellIndex.has(key)) cellIndex.set(key, []);
    cellIndex.get(key).push(r);
    if (r.housenumber && r.addr_street) {
      const hn = String(r.housenumber).toLowerCase();
      if (!byHousenumber.has(hn)) byHousenumber.set(hn, []);
      byHousenumber.get(hn).push(r);
    }
  }
}

function ensure() {
  if (!cellIndex) build();
}

// Every organization whose grid cell overlaps the given box — a superset
// of the true box (cells are coarser than most query boxes), so callers
// still apply their own exact distance/containment test afterwards, same
// as they already did against the old SQL BETWEEN query.
function queryBox(minLat, maxLat, minLon, maxLon) {
  ensure();
  const out = [];
  const minLatCell = Math.floor(minLat / CELL_DEG);
  const maxLatCell = Math.floor(maxLat / CELL_DEG);
  const minLonCell = Math.floor(minLon / CELL_DEG);
  const maxLonCell = Math.floor(maxLon / CELL_DEG);
  for (let la = minLatCell; la <= maxLatCell; la++) {
    for (let lo = minLonCell; lo <= maxLonCell; lo++) {
      const bucket = cellIndex.get(`${la}:${lo}`);
      if (bucket) for (const r of bucket) out.push(r);
    }
  }
  return out;
}

function byHousenumberExact(hn) {
  ensure();
  return byHousenumber.get(String(hn == null ? "" : hn).toLowerCase()) || [];
}

module.exports = { queryBox, byHousenumberExact, CELL_DEG };
