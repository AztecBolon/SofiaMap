// «Культурное наследие» block (house-page-template.md §13.2/§13.10/§17) —
// individually listed cultural monuments ("недвижими културни ценности"),
// from the two files the user supplied 2026-09-06 after the same sandbox
// network block documented in §13.12/§16 stopped a direct download:
// - single_monuments_of_culture.geojson: 1331 monuments, geometry is
//   already a building FOOTPRINT polygon (not a point, as §13.2 assumed
//   before actually opening the file) — name, act (декрет/година), type
//   (историческа/архитектурен/... — often combined), category (значение:
//   национално/местно/ансамблово/"за сведение").
// - territories_of_single_monuments_of_culture.geojson: 247 protection
//   zones (a SUBSET of the 1331 — most monuments don't have one), each
//   its own polygon, own `name`/`rn`/`region`/cadastral_numbers.
const fs = require("fs");
const path = require("path");
const { pointInGeometry, distanceMeters } = require("./geo");

const DATA_DIR = path.resolve(__dirname, "..", "..", "..", "data");
const MONUMENTS_PATH = path.join(DATA_DIR, "external", "single_monuments_of_culture.geojson");
const ZONES_PATH = path.join(DATA_DIR, "external", "territories_of_single_monuments_of_culture.geojson");

// Same "how close counts as the same building" question §15.1 answers for
// transit stops, asked here of two independent surveys (OSM vs the
// municipal cadastre) of the same real building. Calibrated 2026-09-06
// against our own `buildings` table: for all 1331 monuments, distance
// from the monument polygon's centroid to the nearest OSM building —
// median 3.8m, p75 6.7m, p90 16.8m, p95 34.4m (tight — these really are
// the same buildings, just digitized independently) — 30m sits just past
// p90, wide enough to absorb ordinary digitization drift without pulling
// in a genuinely different neighboring building.
const NEARBY_MAX_M = 30;
const BBOX_PAD_DEG = 0.002; // ~200m at Sofia's latitude, ample for the filter above

function ringCentroid(ring) {
  let x = 0, y = 0, n = 0;
  for (const [lon, lat] of ring) { x += lon; y += lat; n++; }
  return n ? [x / n, y / n] : null;
}
function polygonCentroid(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Polygon") return ringCentroid(geometry.coordinates[0]);
  if (geometry.type === "MultiPolygon") return ringCentroid(geometry.coordinates[0][0]);
  return null;
}

function loadFeatures(filePath, mapFn) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const geojson = JSON.parse(raw);
    return (geojson.features || []).map(mapFn).filter(Boolean);
  } catch (e) {
    console.error(`[culturalHeritage] could not load ${filePath}:`, e.message);
    return [];
  }
}

let monumentsCache = null;
function getMonuments() {
  if (!monumentsCache) {
    monumentsCache = loadFeatures(MONUMENTS_PATH, (f) => {
      const centroid = polygonCentroid(f.geometry);
      if (!centroid) return null;
      const p = f.properties || {};
      return {
        rn: p.rn,
        name: p.name,
        act: p.act || null,
        category: p.category || null,
        type: p.type || null,
        geometry: f.geometry,
        lon: centroid[0],
        lat: centroid[1],
      };
    });
  }
  return monumentsCache;
}

let zonesCache = null;
function getZones() {
  if (!zonesCache) {
    zonesCache = loadFeatures(ZONES_PATH, (f) => {
      const p = f.properties || {};
      return { rn: p.rn, name: p.name, region: p.region || null, geometry: f.geometry };
    });
  }
  return zonesCache;
}

// Tier 1: the monument's own footprint and the house's own footprint
// actually overlap (tested both directions — the monument centroid inside
// the house's polygon, or the house's own point inside the monument's
// polygon — since either survey's outline could be the less precise one).
// Tier 2: no polygon overlap, but the monument centroid is within
// NEARBY_MAX_M of the house's point — same "own tag / geometric
// containment / distance fallback" shape as orgMatch.js (§6), just with
// only two tiers since there's no "own tag" equivalent here.
function findMonumentForHouse(house) {
  if (house.lat == null || house.lon == null) return null;
  let houseGeom = null;
  if (house.geometryRaw) {
    try { houseGeom = JSON.parse(house.geometryRaw); } catch { houseGeom = null; }
  }
  let best = null;
  for (const m of getMonuments()) {
    if (Math.abs(m.lat - house.lat) > BBOX_PAD_DEG || Math.abs(m.lon - house.lon) > BBOX_PAD_DEG) continue;
    const contained =
      (houseGeom && pointInGeometry(m.lon, m.lat, houseGeom)) ||
      pointInGeometry(house.lon, house.lat, m.geometry);
    if (contained) return { ...m, tier: 1, exact: true };
    const d = distanceMeters(house.lat, house.lon, m.lat, m.lon);
    if (d <= NEARBY_MAX_M && (!best || d < best.distanceM)) best = { ...m, tier: 2, exact: false, distanceM: Math.round(d) };
  }
  return best;
}

// Protection zones are real drawn boundaries (not a footprint standing in
// for a point), so containment is the only test — no proximity fallback,
// same reasoning as district/raion point-in-polygon lookups elsewhere.
// Skips a zone that belongs to the monument `findMonumentForHouse` already
// found for this house (its own zone) — that would just repeat the same
// fact under a different heading, not add one.
function findProtectionZoneForHouse(house, { excludeRn } = {}) {
  if (house.lat == null || house.lon == null) return null;
  for (const z of getZones()) {
    if (excludeRn != null && z.rn === excludeRn) continue;
    if (pointInGeometry(house.lon, house.lat, z.geometry)) return z;
  }
  return null;
}

module.exports = { findMonumentForHouse, findProtectionZoneForHouse, NEARBY_MAX_M };
