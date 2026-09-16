// Matches organizations to a specific building — for the house page's
// "Организации" block (house-page-template.md §6).
//
// Why this exists at all: `organizations` has no foreign key to
// `buildings`, and only 17% of organizations carry their own addr_street/
// housenumber tags. The naive read of that ("83% have no address") was
// WRONG — verified directly (2026-09-06, see §6's write-up of that
// correction): most organizations are OSM point features that sit
// GEOMETRICALLY inside a building's footprint, and that building usually
// carries the address tag instead of the point. Real measured coverage:
// 83.5% of all organizations resolve to *some* address this way. Three
// tiers, most to least certain — never claim a precise address from a
// tier that didn't actually establish one:
//
//   1. OWN TAG — the organization's own addr_street/housenumber, text-
//      matched against this building's street name + housenumber (after
//      the same designator normalization streetDesignation.js already
//      applies to street names, so "ул. Х" and "Х" compare equal).
//   2. CONTAINMENT — the organization's point falls inside THIS
//      building's own polygon (pointInGeometry) and this building has a
//      housenumber. Not a distance threshold: a real geometric fact, so
//      it's treated as equally certain as tier 1, not as a fallback.
//   3. PROXIMITY — only reached when tiers 1-2 found nothing at all for
//      this building: organizations within ORG_NEARBY_MAX_M of the
//      building's point. Calibrated 2026-09-06 against 500 organizations'
//      distance-to-nearest-building (p50=7.4m, p75=14.9m, p90=31.5m,
//      p95=48.8m) — 50m covers ≥95% of cases while staying tight enough,
//      in Sofia's dense central blocks, not to credit a neighbouring
//      building's tenants to this one. Tier-3 results are marked
//      `exact: false` — callers MUST render these as "поблизости", never
//      as "по этому адресу": this tier is a real guess, not a resolved
//      address, and saying otherwise would fabricate precision tiers 1-2
//      actually have.
const { pointInGeometry, distanceMeters, bboxOfGeometry } = require("./geo");
const { splitDesignation } = require("./streetDesignation");
const rubrics = require("./rubricsDirectory");
// In-memory grid index (orgSpatialIndex.js) instead of a per-call SQL
// `WHERE lat BETWEEN ... AND lon BETWEEN ...` scan — see that module's own
// comment for why: the street page's "Организации" block (added
// 2026-09-07) calls this building-matching logic once per house on a
// street, and organizations(lat, lon) has no index for SQLite to use, so
// that used to mean one full 20 699-row scan per house.
const orgIndex = require("./orgSpatialIndex");

const ORG_NEARBY_MAX_M = 50;
// Bounding-box pre-filter padding in degrees before the exact point-in-
// polygon / distance check for tiers 2-3 — generous enough to comfortably
// contain any building footprint or the 50m proximity radius at Sofia's
// latitude (~0.0008° ≈ 65m north-south; a bit more east-west costs nothing).
const BBOX_PAD_DEG = 0.001;

function normalizeStreet(name) {
  const { rest, designation } = splitDesignation(String(name || "").trim());
  return (designation ? rest : name || "").trim().toLowerCase();
}
function normalizeHousenumber(hn) {
  return String(hn || "").trim().toLowerCase();
}

function bboxOrgs(lat, lon, pad) {
  return orgIndex.queryBox(lat - pad, lat + pad, lon - pad, lon + pad);
}

// `building`: { housenumber, addr_street (raw street name, e.g. entry.name
// from streetsDirectory), lat, lon, geometryRaw (raw GeoJSON string or
// null) }
function findOrganizationsForBuilding(building) {
  const results = new Map(); // org id -> { id, name, rubric, tier, exact, href }
  const add = (org, tier) => {
    if (results.has(org.id)) return; // keep the first (most certain) tier an org was found at
    const link = rubrics.getCompanyLink(org.rubric, org.id);
    results.set(org.id, { id: org.id, name: org.name, rubric: org.rubric, tier, exact: tier !== 3, href: link ? link.href : null });
  };

  // Tier 1: own tag, text-matched (housenumber first via the index's exact
  // hash lookup — cheap and very selective — then the street name
  // normalized in JS).
  if (building.housenumber) {
    const wantStreet = normalizeStreet(building.addr_street);
    for (const org of orgIndex.byHousenumberExact(building.housenumber)) {
      if (normalizeStreet(org.addr_street) === wantStreet) add(org, 1);
    }
  }

  // Tier 2: geometric containment in this building's own footprint.
  if (building.geometryRaw && building.housenumber) {
    let geom = null;
    try { geom = JSON.parse(building.geometryRaw); } catch { geom = null; }
    if (geom) {
      for (const org of bboxOrgs(building.lat, building.lon, BBOX_PAD_DEG)) {
        if (pointInGeometry(org.lon, org.lat, geom)) add(org, 2);
      }
    }
  }

  // Tier 3: proximity fallback, only if nothing certain was found at all.
  if (results.size === 0) {
    for (const org of bboxOrgs(building.lat, building.lon, BBOX_PAD_DEG)) {
      const d = distanceMeters(building.lat, building.lon, org.lat, org.lon);
      if (d <= ORG_NEARBY_MAX_M) add(org, 3);
    }
  }

  return [...results.values()].sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name, "bg"));
}

// Street page's "Организации" block (house-page-template.md's street-page
// adaptation, 2026-09-07): "по ВСЕМ домам улицы, а не одному" — runs the
// same calibrated per-house matching above for every house on the cluster
// and merges the results, rather than inventing a separate street-level
// heuristic. A org sitting inside two adjacent buildings' bounding boxes
// (shouldn't really happen — buildings don't overlap — but tier-3's radius
// fallback could in principle see the same org from two neighbouring
// houses) is deduped and keeps its best (lowest-tier) match, exactly like
// findOrganizationsForBuilding already dedupes within one building.
function findOrganizationsForStreet(houses, entryName) {
  const results = new Map(); // org id -> best match across all houses
  for (const house of houses) {
    // Same fallback the house page itself uses (routes/pages.js) when a
    // building's own addr_street tag is blank — the street entry's own
    // name, not an empty string (which would otherwise false-match every
    // OTHER untagged organization's own blank addr_street in tier 1).
    const found = findOrganizationsForBuilding({
      housenumber: house.housenumber,
      addr_street: house.addr_street || entryName,
      lat: house.lat,
      lon: house.lon,
      geometryRaw: house.geometryRaw,
    });
    for (const org of found) {
      const existing = results.get(org.id);
      if (!existing || org.tier < existing.tier) results.set(org.id, org);
    }
  }
  return [...results.values()].sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name, "bg"));
}

// Generic "organizations near this point" — no building/address tie at
// all, unlike the tiers above (which anchor to one specific house). Used
// where the page itself isn't a building: a stop's "Организации рядом"
// (house-page-template.md §9's stop adaptation) and an organization's own
// "Рядом" (other organizations nearby) — both just want "what's within
// walking distance", mixed rubrics, sorted by distance, nothing claimed
// about which building anything sits in.
const DEFAULT_NEARBY_M = 300;
const DEFAULT_NEARBY_LIMIT = 15;
function findNearbyOrganizations({ lat, lon, radiusM = DEFAULT_NEARBY_M, limit = DEFAULT_NEARBY_LIMIT, excludeId = null }) {
  const pad = (radiusM / 100000) * 1.3;
  const rows = bboxOrgs(lat, lon, pad);
  const withDist = rows
    .filter((o) => o.id !== excludeId)
    .map((o) => ({ ...o, distanceM: Math.round(distanceMeters(lat, lon, o.lat, o.lon)) }))
    .filter((o) => o.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
  return withDist.slice(0, limit).map((o) => {
    const link = rubrics.getCompanyLink(o.rubric, o.id);
    return { id: o.id, name: o.name, rubric: o.rubric, distanceM: o.distanceM, href: link ? link.href : null };
  });
}

// 2026-09-15 (district/raion/settlement/park pages): "which organizations
// sit inside this polygon" — a different question from every tier above,
// which all anchor to ONE building or ONE point. Exact containment
// (pointInGeometry), not a distance radius — a polygon this size makes
// "nearby" meaningless, but "inside" is a real geometric fact, same
// standing as tier-2 above. Reuses the exact pattern areasDirectory.js's
// own findContaining() already established (bbox pre-filter via
// orgIndex.queryBox, then an exact per-point test) — just the other
// direction: findContaining() asks "which polygon contains this point",
// this asks "which points does this ONE polygon contain".
//
// `limit` caps what's actually rendered inline on a page that could
// otherwise have to list a whole district's worth of organizations (a busy
// central district can hold several hundred) — `total` always reflects
// the real count so the page can say "показаны N из M" honestly instead of
// silently truncating.
const DEFAULT_POLYGON_LIMIT = 60;
function findOrganizationsInPolygon(geometry, { limit = DEFAULT_POLYGON_LIMIT } = {}) {
  const bbox = bboxOfGeometry(geometry);
  if (!bbox) return { items: [], total: 0 };
  const candidates = orgIndex.queryBox(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon);
  const matched = [];
  for (const org of candidates) {
    if (pointInGeometry(org.lon, org.lat, geometry)) matched.push(org);
  }
  matched.sort((a, b) => a.name.localeCompare(b.name, "bg"));
  const items = matched.slice(0, limit).map((org) => {
    const link = rubrics.getCompanyLink(org.rubric, org.id);
    return { id: org.id, name: org.name, rubric: org.rubric, href: link ? link.href : null };
  });
  return { items, total: matched.length };
}

module.exports = {
  findOrganizationsForBuilding, findOrganizationsForStreet, findNearbyOrganizations, findOrganizationsInPolygon,
  ORG_NEARBY_MAX_M, DEFAULT_NEARBY_M, DEFAULT_NEARBY_LIMIT, DEFAULT_POLYGON_LIMIT,
};
