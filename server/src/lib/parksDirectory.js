// /parks/ — parks, gardens, forests and protected green areas
// (2026-09-15, "ветка группы страниц по паркам"). Same shape as
// areasDirectory.js's districts/settlements: a flat table with
// name+lat+lon+geometry, populated by a one-off pipeline pass rather than
// live from raw OSM at request time (see pipeline/export_parks.py for the
// extraction itself and why this table didn't exist before this wave —
// short version: the geometry+names were always sitting in
// raw/sofia.osm.pbf, already used to draw/label the map's own `landuse`
// layer; this just also puts them somewhere the Node server can query).
//
// Tag scope is WIDER than the map's own `landuse` layer (leisure=park,
// leisure=garden, landuse=forest, boundary=protected_area — user's choice,
// 2026-09-15) — a `tag_value` of "forest"/"protected_area" is real content
// here that isn't necessarily labelled on the live map itself (see
// export_parks.py's own comment). `TAG_LABELS` below is what turns that
// raw OSM tag into the human-facing "type" shown on the page — not a
// generic rubric system, just enough to tell a user why an entry titled
// "Врана" (a nature reserve) is filed next to "Южен парк" (an actual park).
const db = require("../db");
const { createSlugAssigner } = require("./slugify");

const TAG_LABELS = {
  park: "Парк",
  garden: "Сад / сквер",
  forest: "Лес",
  protected_area: "Охраняемая территория",
};

let cache = null;
function build() {
  const rows = db.prepare(`SELECT id, name, name_en, tag_key, tag_value, lat, lon, geometry FROM parks WHERE name != '' ORDER BY name COLLATE NOCASE`).all();
  const assign = createSlugAssigner();
  return rows.map((r) => {
    let geom = null;
    try { geom = r.geometry ? JSON.parse(r.geometry) : null; } catch { geom = null; }
    return {
      id: r.id, name: r.name, nameEn: r.name_en || "",
      tagKey: r.tag_key, tagValue: r.tag_value,
      typeLabel: TAG_LABELS[r.tag_value] || "Зелёная зона",
      lat: r.lat, lon: r.lon, geometry: geom,
      slug: assign(r.name, `park-${r.id}`),
    };
  });
}
function getAll() {
  if (!cache) cache = build();
  return cache;
}
function getBySlug(slug) {
  return getAll().find((p) => p.slug === slug) || null;
}
function getById(id) {
  return getAll().find((p) => String(p.id) === String(id)) || null;
}

module.exports = { getAll, getBySlug, getById, TAG_LABELS };
