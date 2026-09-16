// Minimal point-in-polygon (ray casting) for GeoJSON Polygon/MultiPolygon,
// used by the hit-test endpoint. No external geometry library needed for
// this scale of data.

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(x, y, polygonCoords) {
  // polygonCoords: [ [ [lng,lat], ... ] outer, [hole], ... ]
  if (!polygonCoords.length) return false;
  if (!pointInRing(x, y, polygonCoords[0])) return false;
  for (let i = 1; i < polygonCoords.length; i++) {
    if (pointInRing(x, y, polygonCoords[i])) return false; // inside a hole
  }
  return true;
}

function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") {
    return pointInPolygonCoords(lon, lat, geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((poly) => pointInPolygonCoords(lon, lat, poly));
  }
  return false;
}

// Bounding box [minLon, minLat, maxLon, maxLat] of a Polygon/MultiPolygon —
// shared by every "organizations/streets inside this polygon" lookup
// (raions/districts/settlements/parks pages, 2026-09-15) as the cheap
// pre-filter before the exact pointInGeometry() test, same two-step shape
// orgMatch.js's tier-2/3 already use for a point+radius box.
function bboxOfGeometry(geometry) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  function visitRing(ring) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!geometry) return null;
  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) visitRing(ring);
  } else if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) for (const ring of poly) visitRing(ring);
  } else {
    return null;
  }
  return Number.isFinite(minLon) ? { minLon, minLat, maxLon, maxLat } : null;
}

// Area-weighted centroid of a Polygon/MultiPolygon's OUTER ring(s) only
// (holes ignored — a "where do we center the map/marker on this shape"
// point doesn't need to account for a doughnut-shaped park excluding its
// own lake, unlike pointInGeometry()'s exact containment test above, which
// does need holes). Standard shoelace-formula polygon centroid, applied per
// outer ring and combined by ring area for a MultiPolygon — the same thing
// pipeline/parse_full.py already gets for free from shapely's `.centroid`
// when districts/settlements are first parsed into sofia.db, reimplemented
// here in plain JS because raionsDirectory.js loads its GeoJSON directly at
// request time (no Python pass computes this ahead of time for raions, see
// that module's own comment on where its source file comes from).
function ringCentroidAndArea(ring) {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area /= 2;
  if (area === 0) {
    // Degenerate ring (collinear/zero-area) — fall back to a plain vertex
    // average rather than dividing by zero.
    const n = Math.max(ring.length - 1, 1);
    const sum = ring.slice(0, -1).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
    return { lon: sum[0] / n, lat: sum[1] / n, area: 0 };
  }
  return { lon: cx / (6 * area), lat: cy / (6 * area), area: Math.abs(area) };
}
function polygonCentroid(geometry) {
  if (!geometry) return null;
  const outerRings =
    geometry.type === "Polygon" ? [geometry.coordinates[0]] :
    geometry.type === "MultiPolygon" ? geometry.coordinates.map((poly) => poly[0]) :
    null;
  if (!outerRings || !outerRings.length) return null;
  const parts = outerRings.map(ringCentroidAndArea).filter((p) => p);
  const totalArea = parts.reduce((s, p) => s + p.area, 0);
  if (totalArea === 0) {
    // Every part degenerate — average whatever fallback points we got.
    const lon = parts.reduce((s, p) => s + p.lon, 0) / parts.length;
    const lat = parts.reduce((s, p) => s + p.lat, 0) / parts.length;
    return { lat, lon };
  }
  const lon = parts.reduce((s, p) => s + p.lon * p.area, 0) / totalArea;
  const lat = parts.reduce((s, p) => s + p.lat * p.area, 0) / totalArea;
  return { lat, lon };
}

// Equirectangular approximation, not true geodesic distance — same
// simplification streetCluster.js already makes (see its own comment):
// fine at Sofia's small extent (~20km across), and one reference latitude
// for the metre-per-degree conversion is close enough everywhere in the
// dataset. Shared here so every "nearest X to a point" feature (district
// lookup, organizations near a building, stops near a building) uses one
// consistent, cheap distance function instead of each re-deriving it.
const REF_LAT_RAD = (42.7 * Math.PI) / 180;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos(REF_LAT_RAD);
function distanceMeters(lat1, lon1, lat2, lon2) {
  const dx = (lon1 - lon2) * M_PER_DEG_LON;
  const dy = (lat1 - lat2) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

module.exports = { pointInGeometry, distanceMeters, bboxOfGeometry, polygonCentroid };
