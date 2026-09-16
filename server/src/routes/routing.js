// "Как доехать/как дойти" (claude/next-steps-routing.md): proxies route
// requests to a local Motis server (see routing-proto.ps1's testing history
// in that doc for why Motis, not OTP2, was chosen -- plain REST/JSON,
// legGeometry + routeColor already in the response, built-in geocoding).
// Motis itself is NOT part of this repo -- it's a separate process, started
// independently on the same machine (see next-steps-routing.md "Что
// осталось" for the still-open question of exactly how it's supervised in
// prod) and reached over plain HTTP on localhost, same pattern as
// lib/meiliClient.js's relationship to the separate meilisearch.exe
// process. This route file only reshapes Motis's response into the shape
// web/js/map-search.js's route panel wants -- it does not calculate
// anything itself (explicitly out of scope, see the routing prompt this
// whole feature started from: "Алгоритм расчетов не делай сам").
const express = require("express");
const { decodePolyline } = require("../lib/polyline");

const router = express.Router();

const MOTIS_URL = (process.env.MOTIS_URL || "http://127.0.0.1:8081").replace(/\/$/, "");
// A few real transit modes Motis can return that Motis's own GTFS-derived
// routeColor is missing for (an agency's feed can leave route_color blank
// per-route) -- these are only a fallback for THAT gap, not a general
// palette; a leg with a real routeColor from Motis always keeps it as-is,
// unchanged, since that's the actual official line color (see
// pipeline/line_colors.py's own note on where the metro M1-M4 colors come
// from -- Motis's per-route color, when present, is more precise than any
// hardcoded mode-level fallback could be).
const MODE_FALLBACK_COLOR = {
  SUBWAY: "#3B3FA6",
  BUS: "#6a737d",
  TRAM: "#2f7a44",
  TROLLEYBUS: "#a8631a",
  RAIL: "#555555",
};

function fetchTimeout(ms) {
  return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

// Motis' stop/route ids are "<feed>_<real id>" (confirmed live: stops like
// "sofia-gtfs_M209", routes like "sofia-gtfs_M2") -- used as a last-resort
// display name for a transit leg whose response happens to omit
// routeShortName (not seen in the one live SUBWAY leg checked so far, kept
// here defensively rather than assumed away).
function shortRouteName(l) {
  if (l.routeShortName) return l.routeShortName;
  if (l.routeId) {
    const parts = String(l.routeId).split("_");
    return parts[parts.length - 1];
  }
  return null;
}

function mapLeg(l) {
  const geometry =
    l.legGeometry && l.legGeometry.points
      ? { type: "LineString", coordinates: decodePolyline(l.legGeometry.points, l.legGeometry.precision) }
      : null;
  const routeColorRaw = l.routeColor ? String(l.routeColor).replace(/^#/, "") : null;
  return {
    mode: l.mode || "WALK",
    duration: l.duration != null ? l.duration : null,
    distance: l.distance != null ? l.distance : null,
    startTime: l.startTime || null,
    endTime: l.endTime || null,
    from: { name: (l.from && l.from.name) || null, lat: l.from ? l.from.lat : null, lng: l.from ? l.from.lon : null },
    to: { name: (l.to && l.to.name) || null, lat: l.to ? l.to.lat : null, lng: l.to ? l.to.lon : null },
    routeName: l.mode && l.mode !== "WALK" ? shortRouteName(l) : null,
    routeColor: routeColorRaw ? `#${routeColorRaw}` : MODE_FALLBACK_COLOR[l.mode] || null,
    headsign: l.headsign || null,
    agencyName: l.agencyName || null,
    geometry,
  };
}

// An itinerary-shaped object (either from data.itineraries or data.direct,
// see below) -> the shape the client's route panel wants.
function mapItinerary(it) {
  return {
    duration: it.duration,
    startTime: it.startTime,
    endTime: it.endTime,
    transfers: it.transfers,
    legs: (it.legs || []).map(mapLeg),
  };
}

// GET /api/route-plan?fromLat=&fromLng=&toLat=&toLng=&time=&arriveBy=
// -> { itineraries: [{ duration, startTime, endTime, transfers, legs: [...] }] }
//
// 2026-09-16 (live reports -- "маршрут между этими точками не найден" for
// two addresses ~900m apart and again ~400m apart; then, separately, a
// transit itinerary shown when a walk would obviously have been quicker):
// a plain /api/v1/plan response's `itineraries` array only ever held
// transit connections here, never a walk-only one, even for pairs far too
// close for transit to make sense. Tried adding `directModes`/`modes`/
// `mode` (the v6 API's own name for asking for a direct/non-transit option
// alongside transit, per its current openapi.yaml -- this build only
// serves the older /api/v1/*, which apparently predates that parameter):
// all three came back byte-identical to a bare request on a pair /plan
// DOES find transit for, proving they're silently ignored here.
//
// Went looking for a separate direct-routing endpoint next and found
// /api/v1/one-to-many (`one`/`many`/`mode`/`max`/`maxMatchingDistance`) --
// confirmed live it returns a real duration/distance for the 400m pair
// /plan found nothing at all for. Wired that in, shipped it, then got a
// live report that the resulting walk option shows up in the panel but
// draws no line on the map ("маршрут не отображается") -- because
// one-to-many's response genuinely never carries any leg geometry, just
// {duration, distance}, confirmed against its actual response rather than
// assumed. A synthesized straight line between the two points was
// considered as a stand-in and explicitly rejected live ("прямая линия -
// не подходит, мы должны научиться рисовать честный маршрут").
//
// Looked closer at what /api/v1/plan itself actually returns and found the
// real fix: **its response already has a second top-level array, `direct`,
// separate from `itineraries`, holding exactly this -- a direct (non-
// transit) walking option with full turn-by-turn `legGeometry`** on every
// leg, same shape as a transit itinerary's own legs. It's there on a
// completely bare /plan call, no extra params needed at all -- earlier
// rounds only ever read `data.itineraries` and never looked at `data.direct`,
// so this was sitting in the response the whole time. Confirmed live on
// both the 400m pair (`direct: [{duration: 526, legs: [{mode: "WALK",
// legGeometry: {...}}]}]`, itineraries: []) and the ~900m Екзарх Антим pair
// (`direct` alongside 3 real tram itineraries). /api/v1/one-to-many is no
// longer used by this route at all.
router.get("/route-plan", async (req, res) => {
  const fromLat = parseFloat(req.query.fromLat);
  const fromLng = parseFloat(req.query.fromLng);
  const toLat = parseFloat(req.query.toLat);
  const toLng = parseFloat(req.query.toLng);
  if (![fromLat, fromLng, toLat, toLng].every((n) => Number.isFinite(n))) {
    return res.status(400).json({ error: "bad_coords" });
  }
  const time = req.query.time || new Date().toISOString();
  const arriveBy = req.query.arriveBy === "true" ? "true" : "false";

  const planParams = new URLSearchParams({ fromPlace: `${fromLat},${fromLng}`, toPlace: `${toLat},${toLng}`, time, arriveBy });

  let upstream;
  try {
    upstream = await fetch(`${MOTIS_URL}/api/v1/plan?${planParams.toString()}`, { signal: fetchTimeout(15000) });
  } catch (err) {
    // Motis not running / unreachable -- a distinct error code so the
    // frontend can say "маршрутный сервис недоступен" instead of a generic
    // failure (see map-search.js's route panel error handling).
    return res.status(502).json({ error: "routing_engine_unreachable", detail: String((err && err.message) || err) });
  }
  if (!upstream.ok) {
    let detail = null;
    try {
      detail = await upstream.text();
    } catch (_e) {
      /* best-effort only */
    }
    return res.status(502).json({ error: "routing_engine_error", status: upstream.status, detail });
  }

  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    return res.status(502).json({ error: "routing_engine_bad_response" });
  }

  // `direct` holds the non-transit (walking) option(s) -- same itinerary
  // shape as `itineraries`, see the big comment above for how this was
  // found. Merged into one list and re-sorted so the walk option lands
  // wherever it actually belongs (often first for close-by pairs) instead
  // of always trailing at the end regardless of how it compares.
  const itineraries = (data.itineraries || []).map(mapItinerary).concat((data.direct || []).map(mapItinerary));
  itineraries.sort((a, b) => (a.duration || 0) - (b.duration || 0));

  res.json({ itineraries });
});

// GET /api/route-geocode?text=... -> [{ name, lat, lng, type }] — thin proxy
// to Motis' own geocoder (indexed off the exact same OSM+GTFS data our map
// already shows), used by the route panel's "point A/Б по названию" search
// instead of building a second geocoder against our own DB.
router.get("/route-geocode", async (req, res) => {
  const text = String(req.query.text || "").trim();
  if (!text) return res.json([]);

  let upstream;
  try {
    upstream = await fetch(`${MOTIS_URL}/api/v1/geocode?text=${encodeURIComponent(text)}`, { signal: fetchTimeout(8000) });
  } catch (err) {
    return res.status(502).json({ error: "routing_engine_unreachable" });
  }
  if (!upstream.ok) return res.status(502).json({ error: "routing_engine_error" });

  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    return res.status(502).json({ error: "routing_engine_bad_response" });
  }
  res.json((Array.isArray(data) ? data : []).slice(0, 8).map((d) => ({ name: d.name, lat: d.lat, lng: d.lon, type: d.type })));
});

module.exports = router;
