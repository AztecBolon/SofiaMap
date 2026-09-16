// /stops/ branch: 3 193 stops total, heavily skewed towards bus_stop
// (2 652) and tram_stop (345) — those two get the same letter/subgroup
// alphabetical treatment as /streets/ (see alphaIndex.js); subway (163),
// rail (30) and bus_terminal (3) are small enough for one flat page each.
const db = require("../db");
const { createSlugAssigner } = require("./slugify");
const { buildAlphaIndex } = require("./alphaIndex");
const { distanceMeters } = require("./geo");

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

// Union of routes across every physical point of a cluster (2026-09-15,
// see getClusterForStop below) — a multi-platform stop's real "Маршруты
// через эту остановку" is what serves ANY of its platforms, not just
// whichever one id happens to be the cluster's representative. Deduped by
// (route_type, route_id) since the same line often calls at more than one
// platform of the same interchange.
function getRoutesForCluster(memberIds) {
  const seen = new Map();
  for (const id of memberIds) {
    for (const r of getRoutesForStop(id)) {
      const key = `${r.route_type}:${r.route_id}`;
      if (!seen.has(key)) seen.set(key, r);
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.route_type.localeCompare(b.route_type) || String(a.ref || "").localeCompare(String(b.ref || ""), "bg", { numeric: true })
  );
}

// 2026-09-15 live report ("нужна одна страница по этой сущности; на карте
// выводим все точки; при выдаче — только одна ссылка"; "если в кластер
// попала остановка удалённая по географии, она не должна попадать в
// кластер, но на неё должна быть отдельная ссылка"): a NAME match alone
// doesn't mean "one physical stop" — real bus/tram stops repeat their name
// across genuinely different, far-apart parts of the municipality just as
// often as street names do (measured directly against this dataset: 1 032
// stop names have more than one physical point sharing them, and 103 of
// those span over 300m — some (e.g. "Околовръстен път", "Кантона") up to
// 20-30 km apart, generic names reused at multiple real, unrelated stops).
// Group same-named points into ONE entity only when they're within
// CLUSTER_MAX_M of each other, transitively (single-linkage over the whole
// name group — three points where A-B and B-C are both close but A-C isn't
// still end up in one cluster, same as a real single interchange with bays
// strung along a curve) — the same "a name match isn't a location match"
// principle streetsDirectory's own namesake split already applies to
// streets, just using actual point distance instead of shared OSM way
// geometry (stops don't have connected geometry to lean on the way street
// segments do).
//
// 700m was picked by inspecting the real spread of same-named GENUINE
// single interchanges in this data: "Метростанция Горна баня" (8 points,
// ~508m — several bus bays + the metro entrance), "Бизнес парк София" (3
// points, ~592m), "Стадион Георги Аспарухов" (4 points, ~501m) — all
// comfortably under 700m and clearly meant to be treated as one place;
// every genuinely unrelated same-name duplicate found starts at multiple
// KILOMETERS apart, so there's a wide, safe gap on either side of any
// threshold from ~600m up to several km.
const CLUSTER_MAX_M = 700;

function clusterPoints(points, maxM) {
  const clusters = [];
  for (const p of points) {
    const matchIdx = [];
    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i].some((m) => distanceMeters(m.lat, m.lon, p.lat, p.lon) <= maxM)) matchIdx.push(i);
    }
    if (!matchIdx.length) {
      clusters.push([p]);
    } else {
      // A point can bridge two clusters that weren't close to EACH OTHER
      // directly (A-C both close to a new point B, but not to each other) —
      // merge every matched cluster into the first, not just append to it,
      // so single-linkage stays correct regardless of arrival order.
      const target = clusters[matchIdx[0]];
      target.push(p);
      for (let k = matchIdx.length - 1; k >= 1; k--) {
        target.push(...clusters[matchIdx[k]]);
        clusters.splice(matchIdx[k], 1);
      }
    }
  }
  return clusters;
}

// Built once at module load (same eager-index principle as
// streetsDirectory.js's buildingsByStreetIndex, 2026-09-14 wave 7 —
// avoids paying for this on the first live search/page request), keyed
// "type:id" -> the ONE shared cluster object every member of that cluster
// points to, so search.js and pages.js always agree on which id is the
// leader.
let clusterCache = null;
function buildClusterIndex() {
  const rows = db.prepare(`
    SELECT id, name, stop_type, lat, lon FROM stops
    WHERE stop_type IN ('bus_stop','tram_stop') AND name != ''
  `).all();
  const byName = new Map();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }
  const index = new Map();
  for (const points of byName.values()) {
    for (const cluster of clusterPoints(points, CLUSTER_MAX_M)) {
      cluster.sort((a, b) => a.id - b.id);
      const leader = cluster[0];
      const members = cluster.map((m) => ({ id: m.id, type: m.stop_type, lat: m.lat, lon: m.lon }));
      const entry = { leaderId: leader.id, leaderType: leader.stop_type, name: leader.name, members };
      for (const m of cluster) index.set(`${m.stop_type}:${m.id}`, entry);
    }
  }
  return index;
}

// Returns the shared cluster object for ANY member (leader or sibling) of a
// bus/tram stop's name-cluster: { leaderId, leaderType, name, members:
// [{id, type, lat, lon}, ...] }, sorted by id (members[0] is always the
// leader). `null` for a stop type this clustering doesn't apply to
// (subway/rail/terminal — see the "Что осталось" note this fix's log entry
// carries: same real anti-pattern likely exists there too, just out of
// scope for this report, which asked specifically about "остановки").
function getClusterForStop(type, id) {
  if (type !== "bus_stop" && type !== "tram_stop") return null;
  if (!clusterCache) clusterCache = buildClusterIndex();
  return clusterCache.get(`${type}:${id}`) || null;
}

// Same "pay the one-time cost at process start, not on the first live
// request" principle as streetsDirectory.js's own eager index (2026-09-14
// wave 7's whole point) — measured at ~100ms for this dataset, cheap enough
// not to matter for startup time, but exactly the kind of "first search
// after restart is slow" surprise that wave was about. Called once from
// pages.js's router-load warm-up, right next to streets.get()'s own.
function warmClusterIndex() {
  if (!clusterCache) clusterCache = buildClusterIndex();
}

module.exports = {
  TYPE_LABELS, INDEXED_TYPES, getType, getStopBySlug, getStopById, getRoutesForStop,
  getRoutesForCluster, getClusterForStop, warmClusterIndex,
};
