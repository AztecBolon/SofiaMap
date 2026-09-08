// /stops/ branch: 3 193 stops total, heavily skewed towards bus_stop
// (2 652) and tram_stop (345) — those two get the same letter/subgroup
// alphabetical treatment as /streets/ (see alphaIndex.js); subway (163),
// rail (30) and bus_terminal (3) are small enough for one flat page each.
const db = require("../db");
const { createSlugAssigner } = require("./slugify");
const { buildAlphaIndex } = require("./alphaIndex");

const TYPE_LABELS = {
  bus_stop: "Автобусные остановки", tram_stop: "Трамвайные остановки",
  subway: "Станции метро", rail: "Ж/д платформы", bus_terminal: "Автовокзалы",
};
// Large enough that a flat list page would be unwieldy -> gets the
// alphabet-index treatment instead of one plain list.
const INDEXED_TYPES = new Set(["bus_stop", "tram_stop"]);

const cache = new Map(); // type -> { stops, alpha? }
function getType(type) {
  if (!TYPE_LABELS[type]) return null;
  if (cache.has(type)) return cache.get(type);

  const rows = db.prepare(`SELECT id, name, stop_type, network, lat, lon FROM stops WHERE stop_type = @type AND name != '' ORDER BY name COLLATE NOCASE, id`).all({ type });
  const assign = createSlugAssigner();
  const stops = rows.map((r) => ({ ...r, slug: assign(r.name, `stop-${r.id}`) }));

  const entry = { stops, alpha: INDEXED_TYPES.has(type) ? buildAlphaIndex(stops) : null };
  cache.set(type, entry);
  return entry;
}

function getStopBySlug(type, slug) {
  const t = getType(type);
  if (!t) return null;
  return t.stops.find((s) => s.slug === slug) || null;
}

// Reverse lookup (id -> directory entry with its slug) for building links
// FROM another page (a route's stop list) TO a stop's own page, without
// that other page needing to know slug-assignment details itself.
function getStopById(type, id) {
  const t = getType(type);
  if (!t) return null;
  return t.stops.find((s) => s.id === id) || null;
}

const getStopRoutesStmt = db.prepare(`
  SELECT rs.route_type, rs.route_id,
    CASE rs.route_type
      WHEN 'bus' THEN (SELECT ref FROM routes_bus WHERE id = rs.route_id)
      WHEN 'tram' THEN (SELECT ref FROM routes_tram WHERE id = rs.route_id)
      WHEN 'trolleybus' THEN (SELECT ref FROM routes_trolleybus WHERE id = rs.route_id)
      WHEN 'metro' THEN (SELECT ref FROM routes_metro WHERE id = rs.route_id)
    END AS ref,
    CASE rs.route_type
      WHEN 'bus' THEN (SELECT name FROM routes_bus WHERE id = rs.route_id)
      WHEN 'tram' THEN (SELECT name FROM routes_tram WHERE id = rs.route_id)
      WHEN 'trolleybus' THEN (SELECT name FROM routes_trolleybus WHERE id = rs.route_id)
      WHEN 'metro' THEN (SELECT name FROM routes_metro WHERE id = rs.route_id)
    END AS route_name
  FROM route_stops rs WHERE rs.stop_id = ?
  GROUP BY rs.route_type, rs.route_id
  ORDER BY rs.route_type, ref
`);
function getRoutesForStop(id) {
  return getStopRoutesStmt.all(id);
}

module.exports = { TYPE_LABELS, INDEXED_TYPES, getType, getStopBySlug, getStopById, getRoutesForStop };
