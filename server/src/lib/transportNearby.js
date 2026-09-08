// "Как доехать" block on the house page (house-page-template.md §12) —
// adapted from moscowmap.ru's dedicated kak-proehat.html page, folded into
// the house page itself rather than a separate URL (user's explicit
// instruction, §12). First pass merged metro into one flat "nearest stops"
// list; the user pointed back at the reference and asked to adapt its
// actual shape more closely — so this now mirrors its two-part structure
// (a distinct "Ближайшее метро" box, then surface stops with their
// routes) instead of one undifferentiated list. Still deliberately missing
// what the reference has that needs a real routing engine — multi-leg
// transfer suggestions to distant stations, the "проложить маршрут"
// builder, the walk-shed isochrone (see §12.2 for why those stay out of
// scope) — this only ever answers "what's near this point", which is data
// we actually have, not "how do I get from A to B", which we don't.
const db = require("../db");
const { distanceMeters } = require("./geo");
const stopsDir = require("./stopsDirectory");
const routesDir = require("./routesDirectory");

const stopsInBox = db.prepare(`
  SELECT id, name, stop_type, lat, lon FROM stops
  WHERE lat BETWEEN @minLat AND @maxLat AND lon BETWEEN @minLon AND @maxLon AND name != ''
`);

const SURFACE_RADIUS_M = 500;
const SURFACE_LIMIT = 7;
// Sofia's metro is far sparser than Moscow's reference city (measured
// 2026-09-06: median distance from a random building to its nearest of
// 161 subway-type stops is ~1.4km, vs. the reference's own example
// showing 3 stations all under 320m) — a fixed "nearest 3, whatever the
// distance" copy of the reference would routinely surface a station 5-8km
// away and call it "nearest metro", which reads as broken, not helpful.
// 1500m (≈18-20 min walk) is close enough to still mean something as
// "within reach"; measured coverage at that radius is 46.3% of buildings
// (vs. 55.7% at 2000m) — picked the tighter, more honest radius. A house
// outside it simply gets no metro subsection, same "don't show a block
// with nothing worth showing" rule as everywhere else in this template.
const METRO_RADIUS_M = 1500;
const METRO_LIMIT = 3;

// "N остановок до метро" (§15.1): for a surface stop, how many stops
// forward — riding one of the routes that actually serves it, no transfer
// — until we're effectively standing at a metro station. This is the
// single-leg slice of the reference's "Наземным транспортом" cards
// (§12.1 item 6); the reference's full version chains transfers to reach
// ANY metro station from ANY point and needs a real routing engine (still
// out of scope, §12.2) — this only answers it for routes that already
// pass by a metro stop directly, which is data we actually have.
//
// Surface routes never reference a subway-typed stop directly (bus stops
// outside a metro entrance are their own separate stop record, not the
// station itself — confirmed 2026-09-06: zero subway-type rows appear in
// bus/tram/trolleybus route_stops), so "at the metro" is decided by
// proximity: measured distance from every surface stop to its nearest of
// 161 subway stations — p5=113m, p10=220m, p15=320m — 250m sits just
// inside that "obviously the same interchange" cluster without stretching
// to stops that just happen to be somewhat nearby.
const METRO_STOP_PROX_M = 250;
// Safety cap on how far along a route to keep scanning before giving up —
// a route that never gets near a metro station shouldn't cost a full
// linear scan to rule out.
const METRO_VIA_ROUTE_MAX_STOPS = 20;

let subwayStopsCache = null;
function getSubwayStops() {
  if (!subwayStopsCache) {
    subwayStopsCache = db.prepare(`SELECT id, name, lat, lon FROM stops WHERE stop_type = 'subway' AND name != ''`).all();
  }
  return subwayStopsCache;
}

function nearestSubwayTo(lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const m of getSubwayStops()) {
    const d = distanceMeters(lat, lon, m.lat, m.lon);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best ? { name: best.name, distanceM: bestD } : null;
}

// One specific route serving one specific stop: walk forward (the
// direction this route_id already encodes — Sofia's data stores each
// direction as its own route_id, e.g. "181 Кокаляне⇒Гео Милев" and
// "181 Гео Милев⇒Кокаляне" are different route_ids, so there is no
// separate "reverse" case to also check) and return the first stop that's
// within METRO_STOP_PROX_M of a metro station, or null if none within the
// scan cap.
function stopsToMetroViaRoute(stopId, routeType, routeId) {
  const ordered = routesDir.getRouteStops(routeType, routeId);
  const idx = ordered.findIndex((s) => s.id === stopId);
  if (idx === -1) return null;
  const limit = Math.min(ordered.length - 1, idx + METRO_VIA_ROUTE_MAX_STOPS);
  for (let i = idx + 1; i <= limit; i++) {
    const near = nearestSubwayTo(ordered[i].lat, ordered[i].lon);
    if (near && near.distanceM <= METRO_STOP_PROX_M) {
      return { stops: i - idx, metroName: near.name };
    }
  }
  return null;
}

function bboxStops(lat, lon, radiusM) {
  // Padding in degrees generous enough to contain radiusM at Sofia's
  // latitude before the exact distanceMeters() filter below narrows it.
  const pad = (radiusM / 100000) * 1.3;
  return stopsInBox.all({ minLat: lat - pad, maxLat: lat + pad, minLon: lon - pad, maxLon: lon + pad });
}

// Per-route "(до метро X)" annotation — reference screenshot (2026-09-06,
// user-supplied) shows this on the individual route CHIP, not as one
// summary line for the whole stop: the same physical stop can carry two
// direction-variants of the same ref (e.g. "м5 (до метро Достоевская)"
// and "м5 (до Стадиона Лужники)" both under one stop, per that
// screenshot), and only one of those directions actually heads toward a
// metro station — attaching it to the stop as a whole would be right only
// half the time. So this is computed per (stop, specific route_id), not
// once per stop.
function withRoutes(s) {
  const dirEntry = stopsDir.getStopById(s.stop_type, s.id);
  const isSurface = s.stop_type !== "subway";
  const routes = stopsDir
    .getRoutesForStop(s.id)
    .map((r) => {
      const route = routesDir.getRouteById(r.route_type, r.route_id);
      if (!route) return null;
      const toMetro = isSurface && r.route_type !== "metro" ? stopsToMetroViaRoute(s.id, r.route_type, r.route_id) : null;
      return { type: r.route_type, ref: r.ref, href: `/routes/${r.route_type}/${route.slug}.html`, toMetro };
    })
    .filter(Boolean);
  return {
    id: s.id,
    name: s.name,
    stopType: s.stop_type,
    typeLabel: stopsDir.TYPE_LABELS[s.stop_type] || s.stop_type,
    distanceM: Math.round(s.distanceM),
    href: dirEntry ? `/stops/${s.stop_type}/${dirEntry.slug}.html` : null,
    routes,
  };
}

function dedupeRoutes(stopsList) {
  const chips = new Map();
  for (const s of stopsList) for (const r of s.routes) {
    if (!r.ref) continue;
    const key = `${r.type}:${r.ref}`;
    if (!chips.has(key)) chips.set(key, r);
  }
  return [...chips.values()];
}

// Nearest metro stations (reference's own "Ближайшее метро" box) — its
// own radius/limit, separate from the surface-stop list below, mirroring
// how the reference gives metro its own subsection rather than mixing it
// into one undifferentiated stop list.
function getNearbyMetro(lat, lon, { radiusM = METRO_RADIUS_M, limit = METRO_LIMIT } = {}) {
  const withDist = bboxStops(lat, lon, radiusM)
    .filter((s) => s.stop_type === "subway")
    .map((s) => ({ ...s, distanceM: distanceMeters(lat, lon, s.lat, s.lon) }))
    .filter((s) => s.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
  return withDist.slice(0, limit).map(withRoutes);
}

// Surface stops (bus/tram/trolleybus) near a point — same shape as before,
// just no longer mixing in subway stops (those are getNearbyMetro's job
// now) so the two lists don't show the same station twice under two
// different headings.
function getNearbyStops(lat, lon, { radiusM = SURFACE_RADIUS_M, limit = SURFACE_LIMIT } = {}) {
  const withDist = bboxStops(lat, lon, radiusM)
    .filter((s) => s.stop_type !== "subway")
    .map((s) => ({ ...s, distanceM: distanceMeters(lat, lon, s.lat, s.lon) }))
    .filter((s) => s.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);

  const shown = withDist.slice(0, limit).map(withRoutes);
  return { stops: shown, total: withDist.length, radiusM };
}

// Combined "Как доехать" block: metro box + surface stops + one deduped
// route-chip row spanning BOTH (so a metro line doesn't get its own
// separate chip row when it's already named next to its station).
function getKakProehat(lat, lon) {
  const metro = getNearbyMetro(lat, lon);
  const surface = getNearbyStops(lat, lon);
  const routes = dedupeRoutes([...metro, ...surface.stops]);
  return { metro, surface, routes };
}

module.exports = { getNearbyStops, getNearbyMetro, getKakProehat, SURFACE_RADIUS_M, SURFACE_LIMIT, METRO_RADIUS_M, METRO_LIMIT };
