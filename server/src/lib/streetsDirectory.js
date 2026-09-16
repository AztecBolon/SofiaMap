// Builds the in-memory street-cluster index that the whole /streets/*
// static section is rendered from.
//
// Why this exists as its own module, separate from routes/search.js and
// routes/coord.js even though it reuses the exact same clustering code:
// those two build clusters PER QUERY, on demand, for whatever name was
// searched. A crawlable directory needs the opposite shape — the complete
// list of every real street in the city, upfront, so it can be organized
// into an alphabet. Benchmarked at ~70ms to cluster the whole city's 23k
// named segments into ~6.2k real street clusters (see the project doc
// "static-directory-pages.md" for the full writeup) — cheap enough to do
// once at server startup and keep in memory for the process lifetime (the
// DB is opened read-only and never changes, see db.js, so there is
// nothing to invalidate this cache with).
const db = require("../db");
const { clusterStreetSegments, representativePoint, dedupeLabels, distancePointToGeometry, allPoints } = require("./streetCluster");
const { createSlugAssigner } = require("./slugify");
const { buildAlphaIndex } = require("./alphaIndex");
const { splitDesignation } = require("./streetDesignation");
const { priorityRank, sourceLabel } = require("./housenumberProvenance");
const { pointInGeometry, bboxOfGeometry } = require("./geo");

// ---- street "type" classification (task requirement #4: document it) -----
//
// The moscowmap.ru reference filters streets into Улицы/Переулки/Проезды/
// Шоссе/Площади/Другое — categories that map onto how MOSCOW's own street
// naming works (a "переулок"/lane is a name suffix). Sofia's OSM data
// doesn't carry that convention at all: Bulgarian street names are mostly
// bare ("Лавандула", "Скакач") with the road's *administrative* type
// implied only by an occasional "бул." (boulevard), "пл." (square) or
// "алея" (alley) prefix baked into the name itself (see
// streetDesignation.js for the various spellings/casings this normalizes),
// plus the `highway=*` tag on its own segments. So this reuses the
// reference's five-or-so-buckets SHAPE with Sofia-appropriate categories
// instead of a literal translation:
//   - "bulevardi"  (Булеварди)         name is designated "бул."
//   - "ploshtadi"  (Площади)           name is designated "пл."
//   - "alei"       (Алеи)              name is designated "алея"
//   - "shosseta"   (Шосета и магистрали) highway is trunk/motorway(_link),
//                                       or the name itself says "шосе"/
//                                       "автомагистрала" (checked even for
//                                       a "бул."-designated name, e.g. "бул.
//                                       Симеоновско шосе" — see below)
//   - "ulitsi"     (Улици)             ordinary named road: either no
//                                       designator at all, or explicitly
//                                       "ул." (which is just the generic
//                                       "street" word, not its own
//                                       distinct category) — residential,
//                                       tertiary, secondary, primary,
//                                       unclassified, living_street
//   - "proezdi"    (Пътища)            service roads / tracks with no
//                                       designator of their own
//   - "drugi"      (Други)             everything else (footway, path,
//                                       steps, cycleway, pedestrian, ...)
// A recognized designator wins over the highway tag EXCEPT for "шосе"/
// "автомагистрала" in the name, which is checked first regardless of
// designator — the explicit exception the project owner flagged
// (2026-09-06): "бул. Симеоновско шосе" must classify as a highway
// ("шосета"), not get relabeled a plain boulevard just because it also
// carries a "бул." designation.
const TYPE_LABELS = {
  ulitsi: "Улици", bulevardi: "Булеварди", ploshtadi: "Площади", alei: "Алеи",
  shosseta: "Шосета и магистрали", proezdi: "Пътища", drugi: "Други",
};
// "pedestrian" belongs here too, not in the leftover "drugi" bucket —
// found 2026-09-06 via a real report ("Аксаков" showing up unlabeled
// under "Пътища и алеи"): a dedicated pedestrian-only street (Sofia's
// city-centre shopping streets are commonly like this — Граф Игнатиев is
// tagged highway=pedestrian on EVERY one of its segments, Аксаков/Иван
// Вазов/Пиротска/Цар Самуил and ~35 others mix pedestrian with ordinary
// residential segments) is still a normal, house-numbered, officially
// named УЛИЦА in Bulgarian addressing — being car-free doesn't make it a
// "path" or an "other" any more than a European pedestrianized city-centre
// street would be. Confirmed for this specific case against the Sofia
// municipal address registry and public sources (nag.sofia.bg,
// bg.wikipedia.org) — "Аксаков" really is "улица", not an alley, which is
// what the report actually needed fixed (not a missing "алея" designation
// — see static-directory-pages.md for the full writeup of that report).
const HIGHWAY_ULITSI = new Set(["residential", "living_street", "unclassified", "tertiary", "secondary", "primary", "tertiary_link", "secondary_link", "primary_link", "pedestrian"]);
const HIGHWAY_SHOSSETA = new Set(["trunk", "motorway", "trunk_link", "motorway_link"]);
const HIGHWAY_PROEZDI = new Set(["service", "track"]);
const DESIGNATION_TYPE = { "бул.": "bulevardi", "пл.": "ploshtadi", "алея": "alei" };

function classifyType(name, designation, dominantHighway) {
  const n = name.trim().toLowerCase();
  if (HIGHWAY_SHOSSETA.has(dominantHighway) || /шосе|автомагистрала/.test(n)) return "shosseta";
  if (designation && DESIGNATION_TYPE[designation]) return DESIGNATION_TYPE[designation];
  if (HIGHWAY_ULITSI.has(dominantHighway)) return "ulitsi";
  if (HIGHWAY_PROEZDI.has(dominantHighway)) return "proezdi";
  return "drugi";
}

function dominantHighway(segments) {
  const counts = new Map();
  for (const s of segments) counts.set(s.highway, (counts.get(s.highway) || 0) + 1);
  let best = null, bestN = -1;
  for (const [h, n] of counts) if (n > bestN) { best = h; bestN = n; }
  return best;
}

let cache = null;

// slug -> { segments, bbox, repPoint: [lon,lat]|null } — declared here (not
// next to getClusterGeometry further down) because build() below now
// populates it directly, computed once per cluster as part of the SAME
// pass that already clusters every name's segments — see that pass's own
// comment for why (2026-09-14, §12.5).
const clusterGeomCache = new Map();

function build() {
  const t0 = Date.now();
  const rows = db.prepare(`SELECT osm_id, name, highway, geometry FROM streets WHERE name != ''`).all();
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push({ ...r, geometry: JSON.parse(r.geometry) });
  }

  const nearestDistrict = db.prepare(`
    SELECT name, lat, lon, ((lat - @lat) * (lat - @lat) + (lon - @lon) * (lon - @lon)) AS d2
    FROM districts ORDER BY d2 ASC LIMIT 1
  `);

  const assignSlug = createSlugAssigner();
  const bySlug = new Map();
  const byRepId = new Map();
  // 2026-09-14 (search sandbox §12.5): name -> every directory entry for
  // that name, in the same deterministic (lowest-osm_id-first) order the
  // loop below builds them in. Added so routes/search.js's street
  // sub-search can look up an already-clustered, already-district-labelled
  // set of entries for a matched name in O(1), instead of re-running
  // clusterStreetSegments/representativePoint/nearestDistrict/dedupeLabels
  // from scratch on every single search request — this whole module exists
  // BECAUSE that clustering is worth doing once and keeping in memory (see
  // the file-top comment), but search.js wasn't actually reusing it, it
  // was redoing the same work per request. Measured cost of that
  // duplication: ~180-210ms added to any search whose matched street names
  // have several segments/clusters (e.g. "Витоша", ~10 real streets) —
  // confirmed via isolated `type=streets` timing before this fix existed.
  const entriesByName = new Map();
  const entries = [];

  // Deterministic order (sorted names, then lowest-osm_id-first clusters)
  // so slugs and any "-2"/"-3" collision suffixes come out the same on
  // every server restart, not just within one run.
  const names = [...byName.keys()].sort((a, b) => a.localeCompare(b, "bg"));
  for (const name of names) {
    const segs = byName.get(name);
    const clusters = clusterStreetSegments(segs).map((cluster) => ({
      cluster,
      rep: cluster.slice().sort((a, b) => a.osm_id - b.osm_id)[0],
    }));
    clusters.sort((a, b) => a.rep.osm_id - b.rep.osm_id);

    // Representative point per cluster, computed ONCE here and reused both
    // for the district-disambiguation lookup right below AND for
    // `clusterGeomCache` (populated in the forEach below) — see that
    // cache's own declaration comment for why (2026-09-14, §12.5): this
    // used to be computed a second time, independently, by
    // getClusterGeometry() on that entry's first live use, which for a
    // busy multi-cluster name (10 clusters for "Витоша") meant redoing the
    // same O(segments²) clustering work again — and doing so lazily, as a
    // multi-hundred-ms spike on whichever real user's search happened to
    // hit that name first, rather than once, here, at server startup.
    const points = clusters.map(({ rep }) => representativePoint(rep.geometry));
    const rawLabels = clusters.map(({ rep }, i) => {
      if (clusters.length <= 1) return null;
      const point = points[i];
      const d = point ? nearestDistrict.get({ lat: point[1], lon: point[0] }) : null;
      return d ? d.name : null;
    });
    const dedupedDistricts = dedupeLabels(rawLabels.map((l) => l || ""));

    // Computed once per NAME (not per cluster) — the designation is a
    // property of the name text, identical for every same-named cluster.
    const { designation, rest, displayName } = splitDesignation(name);

    clusters.forEach(({ cluster, rep }, i) => {
      const district = rawLabels[i] ? dedupedDistricts[i] : null;
      const type = classifyType(name, designation, dominantHighway(cluster));
      // Slugs and URLs are built from the untouched raw `name` (matching
      // what's already in the DB / used to already exist before this
      // normalization pass), NOT `displayName` — so fixing a casing typo
      // in how a name is DISPLAYED never reshuffles anyone's URL.
      const slug = assignSlug(district ? `${name} ${district}` : name, `ulitsa-${rep.osm_id}`);
      const entry = {
        id: rep.osm_id, name, displayName, district, type, slug,
        segmentCount: cluster.length,
        // Alphabetize/group by the name with its designator stripped
        // (task requirement: "бул. Симеоновско шосе" must file under "С",
        // not "Б") — falls back to the full name when there's no
        // recognized designator to strip.
        sortKey: designation ? rest : name,
      };
      bySlug.set(slug, entry);
      byRepId.set(rep.osm_id, entry);
      entries.push(entry);
      if (!entriesByName.has(name)) entriesByName.set(name, []);
      entriesByName.get(name).push(entry);

      // Populate clusterGeomCache directly from the geometry this pass
      // already has in hand (`cluster`'s own segments, `points[i]`) instead
      // of leaving getClusterGeometry() to re-derive it later — see the
      // cache's declaration comment and `points`' comment above for why.
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      for (const seg of cluster) {
        for (const [lon, lat] of allPoints(seg.geometry)) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
      }
      const bbox = Number.isFinite(minLat) ? { minLat, maxLat, minLon, maxLon } : null;
      clusterGeomCache.set(slug, { segments: cluster, bbox, repPoint: points[i] });
    });
  }

  const alpha = buildAlphaIndex(entries);
  console.log(`[streetsDirectory] indexed ${entries.length} street clusters from ${names.length} names in ${Date.now() - t0}ms`);
  return { entries, bySlug, byRepId, entriesByName, alpha };
}

function get() {
  if (!cache) cache = build();
  return cache;
}

// O(1) lookup of every already-clustered, already-district-labelled
// directory entry for one exact street name — see entriesByName's own
// comment in build() for why this exists (routes/search.js's street
// sub-search, avoiding a per-request re-cluster).
function getEntriesByName(name) {
  return get().entriesByName.get(name) || [];
}

// Type-filtered view of the same entries, re-indexed into its own
// letter/subgroup breakdown (task requirement — the reference's "Тип
// объекта" filter re-slices the WHOLE alphabet, not just one page of it,
// so a filtered letter can have a different split point / no split at
// all compared to the unfiltered one). Cheap to rebuild per type (6.2k
// entries, plain array filter + the same sub-70ms index build) and cached
// after first use.
const filteredCache = new Map(); // type ('all' or one of TYPE_LABELS keys) -> same shape as get()
function getForType(type) {
  if (!type || type === "all") return get();
  if (filteredCache.has(type)) return filteredCache.get(type);
  const base = get();
  const entries = base.entries.filter((e) => e.type === type);
  const alpha = buildAlphaIndex(entries);
  const bySlug = new Map(entries.map((e) => [e.slug, e]));
  const result = { entries, bySlug, byRepId: base.byRepId, alpha };
  filteredCache.set(type, result);
  return result;
}

function typeCounts() {
  const base = get();
  const counts = new Map(Object.keys(TYPE_LABELS).map((k) => [k, 0]));
  for (const e of base.entries) counts.set(e.type, (counts.get(e.type) || 0) + 1);
  return counts;
}

// ---- houses on one street cluster (lazy, cached per slug) ----------------
// Same "is this building actually near THIS physical cluster" logic as
// coord.js's /api/street/:id/houses (kept independent rather than
// imported, since that route is keyed by a bare osm_id with no notion of
// slugs or of the directory's own precomputed cluster list) — see that
// route's comment for why a plain `addr_street` match isn't enough here
// (street-name-collisions.md).
// building/geometry/levels/postcode added 2026-09-06 (house-page-template.md
// §5/§6/§12) — the house detail page needs the building's own point and
// footprint to resolve its district (point-in-polygon), match organizations
// sitting inside it, and find nearby transit stops; none of that was needed
// back when this page only rendered a bare "№ <housenumber>" line.
// postcode_src added 2026-09-07 (Находка №11/data-honesty) — the detail
// page needs to know not just the postcode but HOW it was obtained, so it
// can show a citation (official registry) or an honest disclaimer
// (computed/disputed) instead of presenting every value with equal,
// unearned authority — see lib/postcodeProvenance.js.
const streetsByName = db.prepare(`SELECT osm_id, name, geometry FROM streets WHERE lower_u(name) = lower_u(@name)`);
const HOUSE_STREET_MAX_M = 400;

function housenumberSortKey(hn) {
  const m = String(hn || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
}

// The one physical cluster of segments behind a street-directory entry —
// needed by more than just getHousesForEntry (below): the street page's
// "Основное" district lookup and its "Инфраструктура рядом"/"Организации"
// blocks (house-page-template.md's street-page adaptation, 2026-09-07) both
// need this same geometry (a representative point for point-in-polygon, and
// the full segment set for distance-to-street-not-to-one-point queries), so
// it's pulled out of getHousesForEntry into its own cached lookup rather
// than each caller re-deriving "which of this name's segments are actually
// THIS cluster" independently.
// 2026-09-14 (§12.5): build() above now populates clusterGeomCache directly
// for every entry it creates, as part of the SAME clustering pass — so the
// cache-hit path below is the only path any entry produced by get()/build()
// ever takes. The re-fetch-and-recluster logic that used to run here on a
// cache MISS is kept only as a defensive fallback for an entry that somehow
// didn't come from build() (there is currently no such caller) — it should
// never fire in normal operation, and if it ever does, it's no longer free:
// see build()'s own comment for why redoing this per-entry, lazily, used to
// mean a multi-hundred-ms-to-low-seconds spike on whichever request first
// touched a busy multi-cluster name.
function getClusterGeometry(entry) {
  if (clusterGeomCache.has(entry.slug)) return clusterGeomCache.get(entry.slug);

  const sameName = streetsByName.all({ name: entry.name }).map((r) => ({ ...r, geometry: JSON.parse(r.geometry) }));
  const clusters = clusterStreetSegments(sameName);
  const segments = clusters.find((c) => c.some((s) => s.osm_id === entry.id)) || sameName.filter((s) => s.osm_id === entry.id);

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const seg of segments) {
    for (const [lon, lat] of allPoints(seg.geometry)) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  const rep = segments.slice().sort((a, b) => a.osm_id - b.osm_id)[0];
  const repPoint = rep ? representativePoint(rep.geometry) : null;
  const bbox = Number.isFinite(minLat) ? { minLat, maxLat, minLon, maxLon } : null;

  const result = { segments, bbox, repPoint };
  clusterGeomCache.set(entry.slug, result);
  return result;
}

// Closest distance (metres) from a [lat,lon] point to the WHOLE street
// cluster's geometry (the minimum over every one of its segments) — used
// where "near this street" has to mean the street's actual shape, not one
// representative point (house-page-template.md's street-page adaptation:
// "«Инфраструктура рядом» — по геометрии улицы, а не по одной точке").
function distanceToCluster(lat, lon, segments) {
  let best = Infinity;
  for (const seg of segments) {
    const d = distancePointToGeometry([lon, lat], seg.geometry);
    if (d < best) best = d;
  }
  return best;
}

// 2026-09-14 (§12.5): this used to run a `lower_u(addr_street) =
// lower_u(@name)` SQL query, once per distinct street NAME, cached in a
// Map keyed by name (replacing an even earlier version that re-ran it once
// PER CLUSTER — a busy multi-cluster name like "Витоша", with 10 clusters,
// was paying the query 10 separate times on its first live search; caching
// per name instead of per cluster fixed that specific case).
//
// 2026-09-14 (§14.x, root cause of the persistent "slow first search"
// regression found after the 12→3 Meilisearch index consolidation):
// per-name caching only helps when the SAME name is searched again. It does
// nothing for a query whose matched addresses span many DIFFERENT,
// never-before-cached street names — e.g. a generic term like "улица" or
// "парк" — and every one of those still paid the underlying query in full.
// That query itself is the real problem: wrapping the column in `lower_u()`
// means SQLite can't use `idx_buildings_street` (confirmed via
// `EXPLAIN QUERY PLAN`: `SCAN buildings`, not a seek) — every call is a full
// scan of all 112k+ rows with a per-row UDF callback, ~150-175ms
// REGARDLESS of match count (benchmarked: "Витоша"/313 rows 174ms,
// "Оборище"/128 rows 165ms, a made-up street/0 rows 154ms — the cost is the
// scan, not the result set). That's exactly the shape of the reported
// regression (7-17s on the user's Windows machine for a search whose
// results touched several distinct streets, fast on any repeat search of
// the same term once everything it touched was cached).
//
// Fixed the same way every other per-request-recompute cost in this file
// already is (entriesByName, clusterGeomCache): one full table scan, once,
// up front, grouped into a plain JS Map keyed by the already-lowercased
// name. `lower_u()` IS just `String.toLowerCase()` (see db.js's UDF
// registration), so this is behaviour-identical to the old query — just
// index-able, because the "index" is now the Map itself.
function buildBuildingsByStreetIndex() {
  const t0 = Date.now();
  const rows = db
    .prepare(
      `SELECT id, name, addr_street, housenumber, housenumber_src, lat, lon, building, geometry, levels, postcode, postcode_src
       FROM buildings
       WHERE name != '' OR housenumber != ''`
    )
    .all();
  const index = new Map(); // lowercased addr_street -> raw building rows[]
  for (const row of rows) {
    const key = String(row.addr_street || "").toLowerCase();
    let list = index.get(key);
    if (!list) index.set(key, (list = []));
    list.push(row);
  }
  console.log(
    `[streetsDirectory] indexed ${rows.length} buildings by street name (${index.size} names) in ${Date.now() - t0}ms`
  );
  return index;
}
const buildingsByStreetIndex = buildBuildingsByStreetIndex();
function getBuildingsForName(name) {
  return buildingsByStreetIndex.get(String(name || "").toLowerCase()) || [];
}

const houseCache = new Map(); // slug -> houses[]

function getHousesForEntry(entry) {
  if (houseCache.has(entry.slug)) return houseCache.get(entry.slug);

  const { segments: myCluster } = getClusterGeometry(entry);

  const houseSlug = createSlugAssigner();

  const matched = getBuildingsForName(entry.name)
    .map((b) => ({ ...b, _d: distanceToCluster(b.lat, b.lon, myCluster) }))
    .filter((b) => b._d <= HOUSE_STREET_MAX_M)
    .sort(
      (a, b) =>
        housenumberSortKey(a.housenumber) - housenumberSortKey(b.housenumber) ||
        String(a.housenumber || "").localeCompare(String(b.housenumber || ""), "bg") ||
        // Same civic number, several building rows (see housenumberProvenance.js):
        // order them by the same priority the dedup step below uses to pick the
        // "main" one, so THAT one is also the first to claim the bare slug from
        // houseSlug() below — otherwise the demoted duplicate could end up with
        // the clean "dom-7.html" URL while the address shown as primary gets
        // stuck with "dom-7-2.html", which reads as backwards.
        priorityRank(a.housenumber_src) - priorityRank(b.housenumber_src) ||
        a.id - b.id
    );

  const houses = matched.map((b) => ({
    id: b.id,
    name: b.name || null,
    housenumber: b.housenumber || null,
    housenumber_src: b.housenumber_src || null,
    displayName: b.name || (b.housenumber ? `${entry.displayName} ${b.housenumber}` : entry.displayName),
    slug: houseSlug(b.housenumber || b.name, `dom-${b.id}`),
    // Raw building fields for the detail page's own blocks (see §3/§5/§6/§12
    // of house-page-template.md) — kept out of the LIST page's rendering,
    // only the single matched house on the detail route reads these.
    lat: b.lat,
    lon: b.lon,
    building: b.building || null,
    geometryRaw: b.geometry || null,
    levels: b.levels || null,
    postcode: b.postcode || null,
    postcode_src: b.postcode_src || null,
    addr_street: b.addr_street,
    // Filled in below when this civic number has more than one building row
    // (see housenumberProvenance.js) — `variants` lives on whichever row is
    // picked as the address's main entry, `variantOf` on every other row.
    variants: [],
    variantOf: null,
  }));

  // ---- collapse duplicate building rows for the same civic number --------
  // (2026-09-09 fix, reported live: "ул. Жамбилица 1" listed three times).
  // Only real, non-empty housenumbers are grouped — there's no address to
  // merge on for a nameless, numberless row, and grouping by empty string
  // would wrongly lump together unrelated buildings that just lack a number.
  const groups = new Map(); // housenumber -> house[]
  for (const h of houses) {
    const key = (h.housenumber || "").trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = group
      .slice()
      .sort((a, b) => priorityRank(a.housenumber_src) - priorityRank(b.housenumber_src) || a.id - b.id);
    const [primary, ...rest] = sorted;
    primary.variants = rest.map((v) => ({ id: v.id, slug: v.slug, housenumber_src: v.housenumber_src, sourceLabel: sourceLabel(v.housenumber_src) }));
    for (const v of rest) {
      v.variantOf = { slug: primary.slug, displayName: primary.displayName, housenumber_src: primary.housenumber_src, sourceLabel: sourceLabel(primary.housenumber_src) };
    }
  }

  houseCache.set(entry.slug, houses);
  return houses;
}

// Reverse lookup: a bare (street name, building id) pair — all
// /api/search's "address" sub-search has, straight off the `buildings`
// table — to that building's own house entry (slug + variants) on the
// matching street-directory entry, for linking search results to a real
// /streets/.../dom-....html page (2026-09-09, claude/search-results-plan.md).
// Same shape as rubricsDirectory.getCompanyLink()/stopsDirectory.getStopById()
// — the caller only ever has an id, not a directory slug. A name can
// resolve to more than one physical street cluster (streetCluster.js), so
// every candidate entry for that name is checked.
//
// Cached PER NAME (not a naive `entries.filter()` + `.find()` on every
// single call): a plain address search can return up to a dozen rows on
// the SAME street, and `/api/search` calls this once per row — without the
// cache that's a dozen full linear scans of every candidate cluster's WHOLE
// house list per request (measured: a busy street like "бул. Витоша" — 149
// houses — pushed one search past 400ms). Built once per name, first time
// any address on it needs a link, and kept for the process lifetime — same
// "DB is opened read-only and never changes" justification `get()`'s own
// cache already relies on.
const houseIndexByName = new Map(); // street name -> Map(buildingId -> {entry, house})
function houseIndexForName(streetName) {
  if (houseIndexByName.has(streetName)) return houseIndexByName.get(streetName);
  const index = new Map();
  for (const entry of get().entries.filter((e) => e.name === streetName)) {
    for (const house of getHousesForEntry(entry)) {
      if (!index.has(house.id)) index.set(house.id, { entry, house });
    }
  }
  houseIndexByName.set(streetName, index);
  return index;
}
function findHouseByBuildingId(streetName, buildingId) {
  if (!streetName) return null;
  return houseIndexForName(streetName).get(buildingId) || null;
}

function bboxesOverlap(a, b) {
  return a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

// 2026-09-15 (district/raion/settlement pages): "which streets run through
// this polygon" — tested against each cluster's already-cached
// representative point (getClusterGeometry(entry).repPoint, the same
// midpoint-of-longest-segment point streetsDirectory already keeps for the
// map preview/nearest-district lookup — see streetCluster.js's own comment
// on what it means and doesn't mean), not the street's full geometry. A
// long street can legitimately run through several districts; testing only
// its ONE representative point means a street gets attributed to whichever
// district that particular point happens to fall in, same single-point
// approximation this file already uses elsewhere (nearestDistrict in
// build()) — not "every district this street ever touches". Cheap bbox
// pre-filter first (~6.2k clusters city-wide — fine to bbox-check all of
// them, but skips the exact ray-casting test for the ones nowhere near this
// polygon).
function findStreetsInPolygon(geometry) {
  const polyBbox = bboxOfGeometry(geometry);
  if (!polyBbox) return [];
  const matched = [];
  for (const entry of get().entries) {
    const { bbox, repPoint } = getClusterGeometry(entry);
    if (!bbox || !repPoint) continue;
    const entryBbox = { minLon: bbox.minLon, minLat: bbox.minLat, maxLon: bbox.maxLon, maxLat: bbox.maxLat };
    if (!bboxesOverlap(polyBbox, entryBbox)) continue;
    if (pointInGeometry(repPoint[0], repPoint[1], geometry)) matched.push(entry);
  }
  return matched.sort((a, b) => (a.sortKey || a.name).localeCompare(b.sortKey || b.name, "bg"));
}

module.exports = {
  get, getForType, typeCounts, getHousesForEntry, getClusterGeometry, distanceToCluster, TYPE_LABELS, classifyType,
  findStreetsInPolygon,
  findHouseByBuildingId, getEntriesByName,
};
