// /rubrics/ branch: organizations.rubric (29 distinct values, up to ~4000
// organizations in the biggest one — "Прочее") -> paginated company lists.
const db = require("../db");
const { createSlugAssigner } = require("./slugify");
const { distanceMeters } = require("./geo");

const PAGE_SIZE = 200;
// Same radius the house page's "Организации" tier-3 fallback and
// "Транспорт рядом" both settled on (house-page-template.md §6/§12) —
// reused here for "Инфраструктура рядом" (§7) too, for one consistent
// "рядом" everywhere on the site rather than three different unexplained
// numbers. Callers may still override it via `?near=...&radius=...`.
const DEFAULT_NEARBY_RADIUS_M = 500;

let rubricListCache = null;
function listRubrics() {
  if (rubricListCache) return rubricListCache;
  const rows = db.prepare(`SELECT rubric AS name, COUNT(*) AS count FROM organizations WHERE rubric != '' GROUP BY rubric ORDER BY rubric COLLATE NOCASE`).all();
  const assign = createSlugAssigner();
  rubricListCache = rows.map((r) => ({ ...r, slug: assign(r.name), pageCount: Math.ceil(r.count / PAGE_SIZE) }));
  return rubricListCache;
}

function getRubricBySlug(slug) {
  return listRubrics().find((r) => r.slug === slug) || null;
}

const companiesCache = new Map(); // rubric name -> [{id,name,addr_street,housenumber,lat,lon,slug,phone,website,email,opening_hours,wheelchair}]
function getCompaniesForRubric(rubric) {
  if (companiesCache.has(rubric.name)) return companiesCache.get(rubric.name);
  // phone/website/email/opening_hours/wheelchair added 2026-09-07 (house-
  // page-template.md's organization-page adaptation, §9) — these columns
  // already existed in `organizations` and were never rendered anywhere;
  // fetched here (not a separate by-id query) so the organization detail
  // page reads them straight off the same cached row every list page
  // already builds, no second query needed.
  const rows = db.prepare(`
    SELECT id, name, addr_street, housenumber, lat, lon, phone, website, email, opening_hours, wheelchair FROM organizations
    WHERE rubric = @rubric ORDER BY name COLLATE NOCASE, id
  `).all({ rubric: rubric.name });
  const assign = createSlugAssigner();
  const companies = rows.map((r) => ({ ...r, slug: assign(r.name, `org-${r.id}`) }));
  companiesCache.set(rubric.name, companies);
  return companies;
}

function getCompanyPage(rubric, page) {
  const all = getCompaniesForRubric(rubric);
  const start = (page - 1) * PAGE_SIZE;
  return { items: all.slice(start, start + PAGE_SIZE), total: all.length, pageCount: Math.max(1, Math.ceil(all.length / PAGE_SIZE)) };
}

function findCompanyBySlug(rubric, slug) {
  return getCompaniesForRubric(rubric).find((c) => c.slug === slug) || null;
}

// Reverse lookup used by orgMatch.js (house page's "Организации" block):
// that module finds organizations by a geo query against the raw table, so
// it only has an id + a rubric NAME string in hand, not this module's own
// slug — which is only assigned once, deterministically, the first time
// getCompaniesForRubric() builds its cache for that rubric. Route through
// the same cache rather than assigning a second, inconsistent slug.
function getCompanyLink(rubricName, id) {
  const rubric = listRubrics().find((r) => r.name === rubricName);
  if (!rubric) return null; // no rubric (empty string) -> no /rubrics/ detail page exists for it
  const company = getCompaniesForRubric(rubric).find((c) => c.id === id);
  if (!company) return null;
  return { href: `/rubrics/${rubric.slug}/${company.slug}.html`, rubric };
}

// In-memory grid index (orgSpatialIndex.js) instead of a per-call SQL
// `WHERE lat BETWEEN ... AND lon BETWEEN ...` scan — organizations(lat,
// lon) has no index for SQLite to use, so this used to mean a full
// 20 699-row scan on every "Инфраструктура рядом" grid and every rubric
// "?near=" page; see that module's own comment for the street page
// timing that made this worth fixing.
const orgIndex = require("./orgSpatialIndex");
const NEARBY_BOX_PAD_DEG = 0.01; // >1km box; the real cutoff is the exact distance filter below

// "Инфраструктура рядом" grid (house-page-template.md §7) — which rubrics
// actually have something near this point, and how many, so the grid only
// links to categories that won't just land on an empty/irrelevant list.
// One raw query across all rubrics rather than looping listRubrics() and
// calling getCompaniesForRubric() 29 times (which would force-build every
// rubric's full companies cache, including "Прочее"'s ~4000 rows, just to
// answer "is anything here nearby") — cheaper and just as correct.
function getNearbyByRubric(lat, lon, radiusM = DEFAULT_NEARBY_RADIUS_M) {
  const rows = orgIndex
    .queryBox(lat - NEARBY_BOX_PAD_DEG, lat + NEARBY_BOX_PAD_DEG, lon - NEARBY_BOX_PAD_DEG, lon + NEARBY_BOX_PAD_DEG)
    .filter((r) => r.rubric !== "");
  const counts = new Map(); // rubric name -> count
  for (const r of rows) {
    if (distanceMeters(lat, lon, r.lat, r.lon) <= radiusM) counts.set(r.rubric, (counts.get(r.rubric) || 0) + 1);
  }
  return listRubrics()
    .map((r) => ({ ...r, nearbyCount: counts.get(r.name) || 0 }))
    .filter((r) => r.nearbyCount > 0)
    .sort((a, b) => b.nearbyCount - a.nearbyCount || a.name.localeCompare(b.name, "bg"));
}

// The actual "X рядом с этим домом" listing behind a rubric's `?near=`
// query (routes/pages.js) — filters/sorts that ONE rubric's already-cached
// company list by distance instead of building a separate index for it.
function getNearbyForRubric(rubric, lat, lon, radiusM = DEFAULT_NEARBY_RADIUS_M, limit = 200) {
  return getCompaniesForRubric(rubric)
    .map((c) => ({ ...c, distanceM: Math.round(distanceMeters(lat, lon, c.lat, c.lon)) }))
    .filter((c) => c.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

// ---- geometry-based "nearby" (street page's "Инфраструктура рядом"/
// "?nearStreet=") --------------------------------------------------------
// Same two functions as above, but distance is measured to a whole street
// cluster's geometry (every one of its segments) rather than to one point
// — house-page-template.md's street-page adaptation is explicit that a
// street's "рядом" can't honestly collapse a multi-hundred-metre road down
// to a single representative point ("«Инфраструктура рядом» — по геометрии
// улицы, а не по одной точке"). `segments` is a street cluster's own
// segment list (streetsDirectory.js#getClusterGeometry) and `bbox` its
// precomputed lat/lon envelope — both already paid for by that lookup, so
// these don't re-derive them.
function bboxPadForRadius(radiusM) {
  return (radiusM / 100000) * 1.3;
}
function getNearbyByRubricForGeometry(segments, bbox, distanceToClusterFn, radiusM = DEFAULT_NEARBY_RADIUS_M) {
  if (!bbox) return [];
  const pad = bboxPadForRadius(radiusM);
  const rows = orgIndex
    .queryBox(bbox.minLat - pad, bbox.maxLat + pad, bbox.minLon - pad, bbox.maxLon + pad)
    .filter((r) => r.rubric !== "");
  const counts = new Map();
  for (const r of rows) {
    if (distanceToClusterFn(r.lat, r.lon, segments) <= radiusM) counts.set(r.rubric, (counts.get(r.rubric) || 0) + 1);
  }
  return listRubrics()
    .map((r) => ({ ...r, nearbyCount: counts.get(r.name) || 0 }))
    .filter((r) => r.nearbyCount > 0)
    .sort((a, b) => b.nearbyCount - a.nearbyCount || a.name.localeCompare(b.name, "bg"));
}

function getNearbyForRubricByGeometry(rubric, segments, distanceToClusterFn, radiusM = DEFAULT_NEARBY_RADIUS_M, limit = 200) {
  return getCompaniesForRubric(rubric)
    .map((c) => ({ ...c, distanceM: Math.round(distanceToClusterFn(c.lat, c.lon, segments)) }))
    .filter((c) => c.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

module.exports = {
  listRubrics, getRubricBySlug, getCompanyPage, findCompanyBySlug, getCompanyLink,
  getNearbyByRubric, getNearbyForRubric, getNearbyByRubricForGeometry, getNearbyForRubricByGeometry,
  DEFAULT_NEARBY_RADIUS_M, PAGE_SIZE,
};
