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

module.exports = { pointInGeometry, distanceMeters };
