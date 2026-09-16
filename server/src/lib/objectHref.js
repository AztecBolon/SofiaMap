// Shared "row -> the object's real page URL" lookups.
//
// 2026-09-15 (live report, point 1: "В карточке объекта нужна ссылка на
// страницу объекта"): search.js has had this logic since 2026-09-09 (see its
// own history) so a search RESULT row can offer "Открыть страницу", but
// object.js's `/api/object/:type/:id` — the endpoint the MAP's "Объект на
// карте" card actually loads its data from, for both a map click
// (openObjectDetails) and a `?sel=type:id` deep link (selectFromUrl) — never
// had it at all, so that card had no link even for object types search
// results already link to just fine. Extracted out of search.js into this
// shared module (rather than duplicated into object.js) so the two can never
// quietly drift apart from each other or from the actual directory a slug
// comes from (streetsDirectory/rubricsDirectory/areasDirectory/
// stopsDirectory/routesDirectory) — every branch below defers to that
// directory's OWN lookup instead of re-deriving a slug, same reasoning
// search.js's original version already documented. `null` (never a guess)
// when no matching directory entry exists yet for that object.
const streetsDirectory = require("./streetsDirectory");
const rubricsDirectory = require("./rubricsDirectory");
const areasDirectory = require("./areasDirectory");
const stopsDirectory = require("./stopsDirectory");
const routesDirectory = require("./routesDirectory");
const raionsDirectory = require("./raionsDirectory");
const parksDirectory = require("./parksDirectory");

// 2026-09-14 (fourth wave, "Проблема A" — claude/search-results-plan.md
// §8.1/§9): returns the whole directory lookup, not just its `href`, so a
// caller can also read `found.house.variantOf` (housenumberProvenance.js) —
// search.js's dedup step needs that; object.js only ever reads `.href` off
// it, via `addressHref` below.
function addressLookup(row) {
  if (!row.addr_street) return null;
  return streetsDirectory.findHouseByBuildingId(row.addr_street, row.id);
}
function addressHref(row) {
  const found = addressLookup(row);
  return found ? `/streets/${found.entry.slug}/dom-${found.house.slug}.html` : null;
}
function districtHref(row) {
  const entry = areasDirectory.getAll("districts").find((d) => d.id === row.id);
  return entry ? `/districts/${entry.slug}.html` : null;
}
function settlementHref(row) {
  const entry = areasDirectory.getAll("settlements").find((s) => s.id === row.id);
  return entry ? `/settlements/${entry.slug}.html` : null;
}
// 2026-09-15 (/raions/, /parks/ — new public sections): same "defer to the
// directory's own lookup" rule as every branch above — `row.id` here is
// whatever object.js's own lookup already resolved (raionsDirectory's
// GeoJSON-sourced id / parksDirectory's sofia.db `parks.id`), not
// re-derived from scratch.
function raionHref(row) {
  const entry = raionsDirectory.getById(row.id);
  return entry ? `/raions/${entry.slug}.html` : null;
}
function parkHref(row) {
  const entry = parksDirectory.getById(row.id);
  return entry ? `/parks/${entry.slug}.html` : null;
}
function stopHref(stopType, id) {
  const entry = stopsDirectory.getStopById(stopType, id);
  return entry ? `/stops/${stopType}/${entry.slug}.html` : null;
}
function routeHref(routeType, id) {
  const entry = routesDirectory.getRouteById(routeType, id);
  return entry ? `/routes/${routeType}/${entry.slug}.html` : null;
}
function rubricHref(name) {
  const entry = rubricsDirectory.listRubrics().find((r) => r.name === name);
  return entry ? `/rubrics/${entry.slug}/` : null;
}
function companyHref(row) {
  const link = rubricsDirectory.getCompanyLink(row.rubric, row.id);
  return link ? link.href : null;
}

module.exports = { addressLookup, addressHref, districtHref, settlementHref, raionHref, parkHref, stopHref, routeHref, rubricHref, companyHref };
