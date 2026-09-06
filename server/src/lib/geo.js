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

module.exports = { pointInGeometry };
