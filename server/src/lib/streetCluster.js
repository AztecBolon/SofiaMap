// Sofia reuses street names across physically unrelated parts of the city —
// e.g. "Янтра" (a river name) is the name of at least 5 real, kilometers-
// apart streets in different neighbourhoods (ж.к. Яворов, кв. Требич, кв.
// Филиповци ×2, кв. Враждебна) — not a one-off, "Оборище" and "Витоша"
// (without "бул.") show the same pattern with 5 and 10 unrelated streets
// respectively. Grouping street-segment rows purely by name (the old
// `GROUP BY lower_u(name)` in search.js, and the old "all segments with
// this name" lookup in object.js) conflates all of them into one entity:
// search shows only one arbitrary representative (hiding the other real
// streets), and selecting it — or clicking the street's own label directly
// on the map — could draw/zoom to ALL of them at once as if they were one
// street. That's the "different streets glued together" bug a user
// spotted from the search results list (many indistinguishable "Янтра"
// rows whose map markers landed kilometers apart).
//
// This was checked against OSM's own data before reaching for a distance
// heuristic: none of these ways carry any distinguishing administrative
// tag (`addr:city`, `is_in`, ...) — just `highway`/`name` — and every one
// of them sits inside the same Stolichna Community boundary this whole
// extract is cropped to (verified directly, not just "should be" by
// construction). So there is no clean administrative signal to split on;
// this genuinely is the same city reusing the same street name in
// unrelated neighbourhoods, and has to be handled with a geometric
// workaround, not a data lookup.
//
// The workaround (agreed with the project owner 2026-09-06, after an
// earlier endpoint-touching version proved too strict — real segments of
// the same street don't always physically touch, e.g. across an
// intersection or a small OSM tagging gap): segments belong to the same
// real street if the CLOSEST pair of points between them is within
// SAME_STREET_MAX_GAP_M — single-linkage clustering, so a chain of several
// segments each within range of a neighbour still ends up as one cluster
// even if the two ends of the chain are far apart. 1km comfortably covers
// every real gap seen in this dataset's own same-named streets, while
// staying far below the multi-kilometer separation between the genuinely
// different "Янтра"/"Оборище"/"Витоша" streets — so the risk of wrongly
// merging two unrelated streets stays low. It can still, rarely, split one
// real street into two results if it has an unusually large gap under one
// name (a long boulevard interrupted by a park for over a km, say) — an
// accepted trade-off, not a claim of perfect topology.
const SAME_STREET_MAX_GAP_M = 1000;

// Sofia's whole extent is small enough that a single reference latitude for
// the equirectangular metre conversion is fine (same approach as
// pipeline/parse_full.py's project_geom()/to_local()) — no need for a true
// geodesic distance at this scale/precision.
const REF_LAT_RAD = (42.7 * Math.PI) / 180;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos(REF_LAT_RAD);

function distMeters(a, b) {
  const dx = (a[0] - b[0]) * M_PER_DEG_LON;
  const dy = (a[1] - b[1]) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

// The "nearest district" disambiguation (search.js, coord.js's
// /street-at) picks the closest NAMED locality centroid to a street
// cluster — but Sofia's 121 mapped districts don't tile the whole city
// (plenty of area, including both of "Янтра"'s two кв. Филиповци-area
// clusters here, falls outside every drawn district polygon), so two
// clusters genuinely ~2km apart can still share the same nearest label
// verbatim ("Улица · кв. Филиповци" twice) — a user spotted exactly this
// and reasonably read it as one street listed twice, when it's actually
// two real, unconnected ones. A compass bearing from that shared
// district's centroid was tried first and rejected: for this exact case
// the two points sit almost perfectly along the SAME line of sight from
// the district's centroid (bearings 266.56° vs 266.41° — a coincidence of
// this district's specific shape, not a rare fluke worth ignoring), so it
// would have printed two different-looking "з." labels that are actually
// identical, which is worse than no direction at all: it'd read as a
// meaningful distinction when there isn't one. Guaranteed, honest
// uniqueness instead: whatever label two entries in the same group end up
// with, number them once they're spotted colliding, rather than dress up
// a coincidence as geography.
function dedupeLabels(labels) {
  const counts = new Map();
  for (const l of labels) counts.set(l, (counts.get(l) || 0) + 1);
  const seen = new Map();
  return labels.map((l) => {
    if ((counts.get(l) || 0) <= 1) return l;
    const n = (seen.get(l) || 0) + 1;
    seen.set(l, n);
    return `${l} (${n})`;
  });
}

function allPoints(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return geometry.coordinates;
  if (geometry.type === "MultiLineString") return geometry.coordinates.flat();
  return [];
}

// Closest distance (metres) between any point of geometry A and any point
// of geometry B. Segments in this dataset carry at most a few dozen points
// each and a matched name rarely has more than a couple dozen segments, so
// the naive O(points_a * points_b) comparison is cheap enough — no spatial
// index needed at this scale.
function minDistanceBetween(geomA, geomB) {
  const ptsA = allPoints(geomA);
  const ptsB = allPoints(geomB);
  let best = Infinity;
  for (const a of ptsA) {
    for (const b of ptsB) {
      const d = distMeters(a, b);
      if (d < best) best = d;
    }
  }
  return best;
}

// segments: array of objects each carrying a parsed GeoJSON `.geometry`.
// Returns an array of clusters (each an array of a subset of the input
// segments) — segments within SAME_STREET_MAX_GAP_M of each other (directly
// or transitively through another segment) end up in the same cluster, via
// a simple union-find.
function clusterStreetSegments(segments) {
  const n = segments.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (minDistanceBetween(segments[i].geometry, segments[j].geometry) <= SAME_STREET_MAX_GAP_M) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(segments[i]);
  }
  return Array.from(groups.values());
}

// A single, stable-ish [lon, lat] point representative of a segment/cluster
// — the midpoint of the longest LineString involved. Good enough for a map
// preview marker and for a "nearest district" disambiguation lookup; not
// meant to be a precise geometric centroid.
function representativePoint(geometry) {
  if (!geometry) return null;
  const lines =
    geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.type === "MultiLineString"
      ? geometry.coordinates
      : [];
  if (!lines.length) return null;
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
  return longest[Math.floor(longest.length / 2)] || longest[0];
}

// Closest distance (metres) from a [lon, lat] point to a geometry — used to
// resolve "which real street was actually clicked/hovered" when several
// same-named clusters exist (see coord.js's /street-at).
function distancePointToGeometry(point, geometry) {
  const pts = allPoints(geometry);
  let best = Infinity;
  for (const p of pts) {
    const d = distMeters(point, p);
    if (d < best) best = d;
  }
  return best;
}

module.exports = {
  clusterStreetSegments,
  representativePoint,
  distancePointToGeometry,
  dedupeLabels,
  allPoints,
  SAME_STREET_MAX_GAP_M,
};
