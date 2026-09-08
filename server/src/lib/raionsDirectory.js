// The 24 official administrative raions of Sofia Municipality —
// house-page-template.md §13.12. NOT the same thing as `districts`
// (areasDirectory.js): that table holds 121 OSM admin_level=9 quarters/
// housing estates (ж.к./кв./в.з.), none of which is an official raion
// boundary (only 3 of the 24 — Банкя, Нови Искър, Панчарево — happen to
// also exist as `settlements`, because they were once separate towns).
// For the other 21 raions our own extracted OSM data has no polygon at
// all, so district-administration and police-jurisdiction contacts
// (§13.6) can't be attached to a house via `areasDirectory` — they need
// the real raion boundary, which the user supplied directly (2026-09-06)
// after this sandbox's own network policy blocked downloading it
// (§13.12): "Административно-териториално деление на Столична община"
// (Софияплан / api.sofiaplan.bg/datasets/350), 24 polygons, current as
// of 2017-01-01 — raion boundaries change rarely enough that this is
// still the live administrative division.
const fs = require("fs");
const path = require("path");
const { pointInGeometry } = require("./geo");
const { createSlugAssigner } = require("./slugify");

const DATA_DIR = path.resolve(__dirname, "..", "..", "..", "data");
const GEOJSON_PATH = path.join(DATA_DIR, "external", "sofia_raions.geojson");

// "ЛОЗЕНЕЦ" -> "Лозенец", "НОВИ ИСКЪР" -> "Нови Искър" — the source file
// names every raion in all-caps (both `obns_cyr` and `obns_lat`); this is
// the only formatting the raw data needs before it's fit to show on a
// page next to normally-cased Cyrillic text.
function titleCase(s) {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

let cache = null;
function getAll() {
  if (cache) return cache;
  let items = [];
  try {
    const raw = fs.readFileSync(GEOJSON_PATH, "utf8");
    const geojson = JSON.parse(raw);
    const assign = createSlugAssigner();
    items = (geojson.features || []).map((f) => {
      const name = titleCase(f.properties.obns_cyr || "");
      return {
        id: f.properties.id,
        num: f.properties.obns_num,
        name,
        nameLat: f.properties.obns_lat,
        geometry: f.geometry,
        slug: assign(name, `raion-${f.properties.id}`),
      };
    });
  } catch (e) {
    // Missing/corrupt file shouldn't take the whole site down — it just
    // means this one feature (raion + everything keyed off it) quietly
    // stops appearing, same "don't show what we don't have" rule as
    // everywhere else, just triggered by a file-system problem instead of
    // a genuine data gap.
    console.error(`[raionsDirectory] could not load ${GEOJSON_PATH}:`, e.message);
    items = [];
  }
  cache = items;
  return cache;
}

function findRaion(lat, lon) {
  for (const r of getAll()) {
    if (r.geometry && pointInGeometry(lon, lat, r.geometry)) return r;
  }
  return null;
}

function getBySlug(slug) {
  return getAll().find((r) => r.slug === slug) || null;
}

module.exports = { getAll, findRaion, getBySlug };
