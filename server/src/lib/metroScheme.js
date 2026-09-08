// /metro/ — schematic (Beck-style) diagram of the 4 Sofia metro lines, built
// from the same routes_metro/route_stops/stops data as /routes/metro/*.html
// and /stops/subway/*.html (routesDirectory.js, stopsDirectory.js) — this
// file adds nothing to the database, it only lays the same real stations out
// on a schematic grid and computes a routable graph over them.
//
// See claude/metro-scheme-plan.md for the full spec this implements, and
// claude/metro-scheme-build-notes.md (written alongside this file) for what
// changed versus that plan during the actual build (station count 60->50,
// where the coordinates came from, the two disclosed approximations).
const routesDir = require("./routesDirectory");
const stopsDir = require("./stopsDirectory");
const layout = require("./metroSchemeData.json");

const LINE_META = {
  M1: { routeId: 1, color: "#E4032E", label: "M1" },
  M2: { routeId: 2, color: "#0060A9", label: "M2" },
  M3: { routeId: 5, color: "#00A651", label: "M3" },
  M4: { routeId: 7, color: "#F7941D", label: "M4" },
};

// The one station OSM leaves unnamed (stop_id 2706, between "България" and
// "Овча купел" on M3) — sofia.db is read-only and the project never invents
// plausible-sounding names (see data-honesty-and-quirks.md), so this name
// was looked up externally (schedules.sofiatraffic.bg and gradskitransport.com
// both independently list "Красно село" in that exact position) and is
// applied only here in code, not written back into the database. Because its
// name is empty in sofia.db, stopsDirectory's subway list (which filters
// `name != ''`) never picked it up, so it has no /stops/subway/*.html page —
// the scheme shows the name but the popup/route text says so plainly instead
// of linking somewhere fake.
const UNVERIFIED_STATION_ID = 2706;
const UNVERIFIED_STATION_NAME = "Красно село";

let cached = null;

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function build() {
  if (cached) return cached;

  // Station -> its real /stops/subway/<slug>.html entry, straight from the
  // same directory module every other page on the site uses — this file
  // never computes a slug itself.
  const stations = {};
  for (const [idStr, s] of Object.entries(layout.stations)) {
    const id = Number(idStr);
    const stopEntry = id === UNVERIFIED_STATION_ID ? null : stopsDir.getStopById("subway", id);
    if (!stopEntry && id !== UNVERIFIED_STATION_ID) {
      // A station referenced by a metro route but missing from the /stops/
      // directory would be a real data problem, not something to paper over.
      throw new Error(`metroScheme: no /stops/subway/ entry for station id ${id} ("${s.name}") — check stopsDirectory`);
    }
    stations[id] = {
      ...s,
      href: stopEntry ? `/stops/subway/${stopEntry.slug}.html` : null,
      unverifiedName: id === UNVERIFIED_STATION_ID,
    };
  }

  // Cross-check the hand-built layout against the live DB on every server
  // start (per the plan's "fail loudly, don't silently drop a station" rule)
  // — if a future data refresh adds/removes/reorders a metro stop, this
  // throws with a clear message instead of quietly rendering a wrong diagram.
  const lineStops = {};
  for (const [ref, meta] of Object.entries(LINE_META)) {
    const stops = routesDir.getRouteStops("metro", meta.routeId).map((s) => s.id);
    lineStops[ref] = stops;
    for (const id of stops) {
      if (!stations[id]) throw new Error(`metroScheme: station id ${id} on line ${ref} has no scheme coordinate in metroSchemeData.json — layout is stale`);
    }
    const laidOut = layout.lines[ref] || [];
    if (laidOut.length !== stops.length || !laidOut.every((id, i) => id === stops[i])) {
      throw new Error(`metroScheme: line ${ref}'s stop order in sofia.db no longer matches metroSchemeData.json — layout needs regenerating`);
    }
  }

  // Graph edges: same-line consecutive stops (deduped — M1/M4 share 13
  // stations/12 segments) + the real transfer connectors (Сердика/Сердика
  // II, НДК/НДК II, СУ "Св. Климент Охридски"/Орлов мост — see
  // claude/metro-scheme-build-notes.md for how the third one was found).
  // Minutes are
  // estimated from real inter-station distance at an assumed ~40 km/h
  // average (sofia.db has no timetable/segment-time data) — flagged to the
  // user in the UI as an estimate, never presented as an official time.
  const edges = layout.edges.map((e) => ({ ...e }));

  const graph = new Map(); // id -> [{to, minutes, transfer}]
  for (const id of Object.keys(stations)) graph.set(Number(id), []);
  for (const e of edges) {
    graph.get(e.a).push({ to: e.b, minutes: e.minutes, transfer: e.transfer });
    graph.get(e.b).push({ to: e.a, minutes: e.minutes, transfer: e.transfer });
  }

  cached = {
    W: layout.W,
    H: layout.H,
    stations,
    lines: lineStops,
    lineMeta: LINE_META,
    lineMembership: layout.lineMembership,
    edges,
    graphForClient: Object.fromEntries(graph), // JSON-friendly adjacency for the browser's own Dijkstra
    transferPairs: layout.transferPairs,
    // Decorative only — a segment currently under construction (see the
    // comment in metroSchemeData.json for the source/date this was
    // verified). Deliberately not part of `edges`/`graph`: it must never be
    // usable by the route calculator until it's confirmed open.
    plannedLinks: layout.plannedLinks || [],
  };
  return cached;
}

module.exports = { build, LINE_META, UNVERIFIED_STATION_ID, UNVERIFIED_STATION_NAME };
