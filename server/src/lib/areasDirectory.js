// /districts/ and /settlements/ — deliberately the shallowest branches.
// Per the task brief: districts (121) and settlements (40) only carry a
// name + boundary geometry today, no addresses/streets attached to them
// in this dataset — so each still gets ONE flat list page plus a minimal
// one-line detail page, no letter/subgroup index, no pagination.
//
// findContaining() (added 2026-09-06, house-page-template.md §5) is the
// one exception: it doesn't build the "streets in this district"
// drill-down the original task brief explicitly deferred (still no such
// linkage in the data) — it answers a narrower, cheaper question, "which
// district/settlement polygon contains this ONE point", using geometry
// that was already sitting unused in these two tables. Good enough to
// show "Расположение: <район>" on a single house's own page without
// needing the broader linkage at all.
const db = require("../db");
const { createSlugAssigner } = require("./slugify");
const { pointInGeometry } = require("./geo");

const cache = new Map(); // 'districts' | 'settlements' -> rows[] (with parsed geometry)
function getAll(kind) {
  if (cache.has(kind)) return cache.get(kind);
  const table = kind === "districts" ? "districts" : "settlements";
  const rows = db.prepare(`SELECT id, name, lat, lon, geometry FROM ${table} WHERE name != '' ORDER BY name COLLATE NOCASE`).all();
  const assign = createSlugAssigner();
  const items = rows.map((r) => {
    let geom = null;
    try { geom = r.geometry ? JSON.parse(r.geometry) : null; } catch { geom = null; }
    return { id: r.id, name: r.name, lat: r.lat, lon: r.lon, geometry: geom, slug: assign(r.name, `${kind}-${r.id}`) };
  });
  cache.set(kind, items);
  return items;
}

function getBySlug(kind, slug) {
  return getAll(kind).find((r) => r.slug === slug) || null;
}

// Which district (checked first) or settlement polygon actually contains
// this point, if any — point-in-polygon, not "nearest centroid" (the
// nearest-centroid approach used elsewhere, e.g. streetsDirectory's
// disambiguation label, is a rough label for a whole street cluster;
// here we have one exact point — a building's own lat/lon — and an exact
// polygon to test it against, so there's no reason to fall back to an
// approximation). Districts and settlements don't tile the whole city
// (plenty of area — hillsides, industrial land, anything outside the
// mapped boundaries — falls outside every drawn polygon, same caveat
// already documented for street-cluster labelling in streetCluster.js),
// so a `null` result is expected and normal, not a bug — callers must not
// guess a district when this returns null.
function findContaining(lat, lon) {
  for (const kind of ["districts", "settlements"]) {
    for (const item of getAll(kind)) {
      if (item.geometry && pointInGeometry(lon, lat, item.geometry)) {
        return { ...item, kind };
      }
    }
  }
  return null;
}

module.exports = { getAll, getBySlug, findContaining };
