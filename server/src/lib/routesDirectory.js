// /routes/ branch: transit lines (227 bus + 34 tram + 20 trolleybus + 8
// metro = 289 total) -> ordered stop list per route, rendered server-side.
// A JSON version of the stop list already exists for the SPA
// (coord.js's GET /api/route/:type/:id/stops) — this duplicates that one
// query rather than importing the route module, since that module is an
// Express router built around req/res, not a plain data function.
const db = require("../db");
const { createSlugAssigner } = require("./slugify");

const ROUTE_TABLES = { bus: "routes_bus", tram: "routes_tram", trolleybus: "routes_trolleybus", metro: "routes_metro" };
const TYPE_LABELS = { bus: "Автобусы", tram: "Трамваи", trolleybus: "Тролейбуси", metro: "Метро" };

const listCache = new Map(); // type -> routes[]
function listRoutes(type) {
  if (!ROUTE_TABLES[type]) return [];
  if (listCache.has(type)) return listCache.get(type);
  const rows = db.prepare(`SELECT id, ref, name, operator, from_name, to_name FROM ${ROUTE_TABLES[type]} ORDER BY ref COLLATE NOCASE, id`).all();
  const assign = createSlugAssigner();
  const routes = rows.map((r) => ({
    ...r,
    label: r.ref ? `${r.ref}${r.name ? " " + r.name : ""}` : r.name || `Маршрут ${r.id}`,
    slug: assign(`${r.ref || ""} ${r.name || r.from_name || ""} ${r.to_name || ""}`, `route-${type}-${r.id}`),
  }));
  listCache.set(type, routes);
  return routes;
}

function getRouteBySlug(type, slug) {
  return listRoutes(type).find((r) => r.slug === slug) || null;
}

// Reverse lookup (id -> slug) for linking TO a route FROM somewhere that
// only has a bare id — used by transportNearby.js (house page's "Транспорт
// рядом" block) the same way stopsDirectory.getStopById() is already used
// from routes/pages.js's own route-detail page.
function getRouteById(type, id) {
  return listRoutes(type).find((r) => r.id === id) || null;
}

const getRouteStopsStmt = db.prepare(`
  SELECT s.id, s.name, s.stop_type, s.lat, s.lon, rs.seq
  FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
  WHERE rs.route_type = ? AND rs.route_id = ?
  ORDER BY rs.seq
`);
function getRouteStops(type, id) {
  return getRouteStopsStmt.all(type, id);
}

module.exports = { ROUTE_TABLES, TYPE_LABELS, listRoutes, getRouteBySlug, getRouteById, getRouteStops };
