// Decodes a Google-style encoded polyline (the format Motis returns as
// leg.legGeometry.points -- confirmed live against a real /api/v1/plan
// response: {"points": "...", "precision": 7, "length": N}) into an array
// of [lng, lat] pairs, ready to drop straight into a GeoJSON LineString's
// `coordinates`. Standard decode algorithm (same one every "polyline" npm
// package implements) -- written by hand here rather than adding a
// dependency for ~20 lines of pure arithmetic with no other moving parts.
//
// `precision` is the number of decimal-degree digits the encoder divided
// by (Motis uses 7, not the classic Google Maps default of 5 -- passing
// the wrong precision silently produces coordinates off by orders of
// magnitude, so this always takes it from the response rather than
// hardcoding 5).
function decodePolyline(encoded, precision) {
  if (!encoded) return [];
  const factor = Math.pow(10, precision == null ? 5 : precision);
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates = [];
  const len = encoded.length;

  while (index < len) {
    let result = 1;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lng / factor, lat / factor]);
  }
  return coordinates;
}

module.exports = { decodePolyline };
