// "Зона доступности" (claude/next-steps-walkability-isochrone.md): proxies
// isochrone requests to a local pyvalhalla-based service (routing-proto/
// valhalla/isochrone_server.py) — same "this route calculates nothing
// itself, just proxies to a real routing engine" pattern as routing.js's
// relationship to Motis. Valhalla itself is NOT part of this repo — it's a
// separate process, started independently on the same machine (see
// start-valhalla.bat) and reached over plain HTTP on localhost.
//
// Why pyvalhalla instead of the official Docker image (see
// claude/research-walkability-isochrone.md for the original recommendation,
// and next-steps-walkability-isochrone.md for how this was resolved with
// the user): lx15pro has no Docker/Docker Desktop installed, and installing
// it just for this would mean WSL2 + admin rights + likely a reboot on a
// machine that runs everything else (Motis, Meilisearch) as plain native
// Windows processes. pyvalhalla ships prebuilt Windows wheels and gives the
// same C++ Valhalla engine directly in Python — the project already uses
// Python for pipeline/*.py (osmium, shapely), so this isn't a new runtime,
// just another use of one already installed. The Python wrapper's own
// /isochrone endpoint deliberately mirrors Valhalla's real HTTP contract
// (https://valhalla.github.io/valhalla/api/isochrone/ — GET/POST with a
// `locations`/`costing`/`contours`/`polygons` JSON body) so migrating to a
// real self-hosted Valhalla later would only mean changing VALHALLA_URL,
// not this file's request/response shape.
const express = require("express");

const router = express.Router();

const VALHALLA_URL = (process.env.VALHALLA_URL || "http://127.0.0.1:8082").replace(/\/$/, "");

function fetchTimeout(ms) {
  return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

// Fixed set of contours for this first iteration (claude/next-steps-
// walkability-isochrone.md, decided with the user 2026-09-16: several
// bands at once — the familiar Walk Score/Zillow-style visual — pedestrian
// only, no per-request customization yet). Colors are a sequential
// ColorBrewer-style blue ramp, darkest/most saturated for the closest
// (5 min) band, lightest for the farthest (20 min) — sent to Valhalla and
// echoed straight back in each feature's own `color` property, so
// web/js/map-search.js's rendering never needs its own color logic to stay
// in sync with this list.
const CONTOURS = [
  { time: 5, color: "08519c" },
  { time: 10, color: "3182bd" },
  { time: 15, color: "6baed6" },
  { time: 20, color: "bdd7e7" },
];

// GET /api/isochrone?lat=&lng= -> Valhalla-shaped GeoJSON FeatureCollection,
// one Polygon feature per contour above, ordered largest-time-first (as
// Valhalla itself returns them — confirmed live against a real build of
// this project's raw/sofia.osm.pbf while preparing this route; the client
// re-sorts defensively anyway, see map-search.js's toggleIsochrone).
router.get("/isochrone", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (![lat, lng].every((n) => Number.isFinite(n))) {
    return res.status(400).json({ error: "bad_coords" });
  }

  const body = {
    locations: [{ lat, lon: lng }],
    costing: "pedestrian",
    contours: CONTOURS,
    polygons: true,
    denoise: 0.5,
    generalize: 15,
  };

  let upstream;
  try {
    upstream = await fetch(`${VALHALLA_URL}/isochrone?json=${encodeURIComponent(JSON.stringify(body))}`, {
      signal: fetchTimeout(20000),
    });
  } catch (err) {
    // Valhalla service not running / unreachable -- distinct error code so
    // the frontend can say so instead of a generic failure (see
    // map-search.js's apiIsochrone).
    return res.status(502).json({ error: "isochrone_engine_unreachable", detail: String((err && err.message) || err) });
  }
  if (!upstream.ok) {
    let detail = null;
    try {
      detail = await upstream.json();
    } catch (_e) {
      /* best-effort only */
    }
    return res.status(502).json({ error: "isochrone_engine_error", status: upstream.status, detail });
  }

  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    return res.status(502).json({ error: "isochrone_engine_bad_response" });
  }

  res.json(data);
});

module.exports = router;
