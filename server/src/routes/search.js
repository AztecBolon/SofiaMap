const express = require("express");
const db = require("../db");
const { buildingKindLabel } = require("../lib/buildingKind");
const { withDesignation } = require("../lib/streetDesignation");
const { clusterStreetSegments, representativePoint, dedupeLabels } = require("../lib/streetCluster");

const router = express.Router();

const LABELS = {
  address: "Адрес / дом",
  street: "Улица",
  district: "Район",
  settlement: "Населённый пункт",
  metro: "Станция метро",
  stop: "Остановка",
  rail: "Ж/д платформа",
  terminal: "Автовокзал / аэропорт",
  route: "Маршрут транспорта",
  rubric: "Рубрика организаций",
  company: "Организация",
};

// filter name -> which sub-searches to run
//
// "all" used to be a hand-picked subset (address/street/district/
// settlement) rather than a real union of every sub-search — so "Всё"
// silently never found organizations or transport at all (2026-09-06 report:
// "должно искаться всё, включая организации и маршруты транспорта"). It's
// now literally every sub used by any other filter group below, so a new
// sub-search added to some other group later can't quietly fall out of
// "Всё" again the way this one did.
const FILTER_GROUPS = {
  all: ["address", "street", "district", "settlement", "company", "rubric", "metro_route", "metro_stop", "stop", "rail", "terminal", "route"],
  transport: ["metro_route", "metro_stop", "stop", "rail", "terminal", "route"],
  organizations: ["company", "rubric"],
  addresses: ["address"],
  streets: ["street"],
  areas: ["district"],
  cities: ["settlement"],
  metro: ["metro_route", "metro_stop"],
  stops: ["stop"],
  rail: ["rail"],
  terminals: ["terminal"],
  routes: ["route"],
  rubrics: ["rubric"],
};

const PER_SUB_LIMIT = 12;

function likeParams(q) {
  const needle = q.trim().toLowerCase();
  return { prefix: `${needle}%`, contains: `%${needle}%` };
}

function orderClause(col) {
  return `CASE WHEN lower_u(${col}) LIKE @prefix THEN 0 ELSE 1 END, length(${col}) ASC`;
}

// Relevance tier for one text field against the typed query. Plain
// substring matching (the `contains` LIKE every sub-search's WHERE clause
// still uses, to not under-match) treats "рпу" found anywhere inside
// "Корпус" (literally the letters after "ко-") as being just as good a hit
// as an actual word "РПУ" — reported 2026-09-06 ("корпус не отвечает
// запросу РПУ"): a search for the police-precinct abbreviation "РПУ"
// ranked several unrelated "Корпус N" (residential block) results ahead
// of/alongside real "РПУ" matches, purely because the letters happen to
// run together in the middle of "к-о-Р-П-У-с". Three tiers instead of two:
// 0 = the WHOLE field starts with the query (or equals it) — the strongest
// signal; 1 = some individual WORD inside the field starts with it (e.g.
// "МВР 01 РПУ-СДВР ..." has "РПУ" as its own token) — still a real,
// meaningful match, just not at the very front; 2 = the query only occurs
// as an arbitrary run of letters straddling word content ("корПУс" has no
// word starting with "рпу") — kept (not excluded outright, unlike the
// housenumber case) since a genuine partial-word search is sometimes what
// someone wants, but always ranked last. Splitting on anything that isn't
// a letter/digit (`\p{L}`/`\p{N}`, Unicode-aware) turns "МВР 01 РПУ-СДВР"
// into ["мвр","01","рпу","сдвр"] — hyphens, quotes and dots all count as
// word breaks, not just spaces.
function matchTier(text, needle) {
  const t = String(text || "").toLowerCase();
  if (!needle || !t) return 2;
  if (t === needle || t.startsWith(needle)) return 0;
  const words = t.split(/[^\p{L}\p{N}]+/u);
  if (words.some((w) => w.startsWith(needle))) return 1;
  return 2;
}

// Address search needs its own two-shape query, not the one-size @contains
// every other sub-search uses: an address query is (almost always) a street
// name plus a house number typed as one string ("Оборище 5"), and matching
// that whole raw string against `addr_street` AND separately against
// `housenumber` (the previous version of this query — bug found & fixed
// 2026-09-05) meant `housenumber LIKE '%Оборище 5%'` was being asked of a
// column that only ever holds something like "5": it could never match, so
// every address search with a house number silently returned nothing (only
// `OR lower_u(name) LIKE @contains` — matching a building's own name tag —
// ever hit). Splitting the query into a street part and a trailing number
// part before it reaches SQL fixes that.
function splitAddressQuery(q) {
  const trimmed = q.trim();
  // Trailing token that looks like a house/block number: digits, optionally
  // with one trailing letter (common Bulgarian suffix, e.g. "5А"). No match
  // -> treat the whole thing as a street name (or building name) query.
  const m = trimmed.match(/^(.+?)[,\s]+(\d+[a-zA-Zа-яА-Я]?)$/u);
  if (m) return { streetPart: m[1].trim(), numberPart: m[2].trim() };
  return { streetPart: trimmed, numberPart: null };
}

// Building a house-number match pattern isn't as simple as a plain LIKE
// substring — this dataset's housenumber values are messy (ranges "50-52",
// combos "50;56"/"51,49", letter suffixes "5А"/"51Б", block labels
// "бл. 42"...). The bug reported 2026-09-06 ("дом 15 не отвечает запросу
// 5"): the old query used `housenumber LIKE '%5%'`, a bare substring match,
// so searching "5" matched "15", "25", "35", "505А" — anything containing
// the digit "5" anywhere. What actually distinguishes "5" from "15"/"50" is
// whether the character right after the matched digits is itself another
// digit — "5" followed by "0" is the unrelated number 50, but "5" followed
// by "-", ",", a letter, or nothing at all is genuinely house number 5 (or
// "5А", "5-7", "5,12", ...). GLOB's `[^0-9]` character class expresses that
// boundary directly (SQL LIKE has no equivalent). If the typed number
// already carries its own trailing letter (splitAddressQuery only ever
// captures one, e.g. "5А"), that letter already disambiguates it from a
// same-prefix different number, so no extra boundary check is needed there.
function houseNumberGlob(numberPart) {
  const m = numberPart.match(/^(\d+)([a-zA-Zа-яА-Я]?)$/u);
  if (!m) return `${numberPart}*`;
  const [, digits, letter] = m;
  return letter ? `${digits}${letter}*` : `${digits}[^0-9]*`;
}

const ADDRESS_WITH_NUMBER = db.prepare(`
  SELECT id, name, addr_street, housenumber, building, lat, lon
  FROM buildings
  WHERE lower_u(addr_street) LIKE @streetContains
    AND (housenumber = @numberExact OR housenumber GLOB @numberGlob)
  ORDER BY
    CASE WHEN housenumber = @numberExact THEN 0 ELSE 1 END,
    length(housenumber) ASC
  LIMIT @limit
`);

// A plain street-name query (no house number) used to also surface every
// building the street_resolved backfill (pipeline/parse_full.py) attached
// to that street just for proximity — 58k+ buildings city-wide have neither
// a name nor a housenumber of their own, so they render as an anonymous
// "Здание" row that tells the searcher nothing and can't be told apart from
// its neighbours (2026-09-06, "простыня домов без адреса"). That backfilled
// addr_street is still worth keeping in the data for map-click hit-testing
// (coord.js) — this is only about not listing those buildings as their own
// search RESULT. A building with a real name or a real housenumber is a
// legitimate, distinguishable result and stays.
const ADDRESS_NO_NUMBER = db.prepare(`
  SELECT id, name, addr_street, housenumber, building, lat, lon
  FROM buildings
  WHERE (lower_u(addr_street) LIKE @contains OR lower_u(name) LIKE @contains)
    AND (name != '' OR housenumber != '')
  ORDER BY ${orderClause("coalesce(name, addr_street)")}
  LIMIT @limit
`);

// Street name -> distinct real streets. Kept as two steps rather than one
// GROUP BY: first find which distinct names match at all (cheap, bounded by
// @limit same as every other sub-search), then for each matched name pull
// every one of ITS segments so they can be clustered into physically
// distinct streets (see lib/streetCluster.js) — a name match alone doesn't
// mean "the same street", Sofia reuses names across unrelated districts.
const STREET_NAMES = db.prepare(`
  SELECT DISTINCT name FROM streets
  WHERE name != '' AND lower_u(name) LIKE @contains
  ORDER BY ${orderClause("name")}
  LIMIT @limit
`);
const STREET_SEGMENTS_BY_NAME = db.prepare(`
  SELECT osm_id AS id, name, highway, geometry FROM streets WHERE lower_u(name) = lower_u(@name)
`);
const nearestDistrict = db.prepare(`
  SELECT name, lat, lon,
    ((lat - @lat) * (lat - @lat) + (lon - @lon) * (lon - @lon)) AS d2
  FROM districts ORDER BY d2 ASC LIMIT 1
`);

const QUERIES = {
  district: db.prepare(`
    SELECT id, name, lat, lon FROM districts
    WHERE name != '' AND lower_u(name) LIKE @contains
    ORDER BY ${orderClause("name")}
    LIMIT @limit
  `),
  settlement: db.prepare(`
    SELECT id, name, lat, lon FROM settlements
    WHERE name != '' AND lower_u(name) LIKE @contains
    ORDER BY ${orderClause("name")}
    LIMIT @limit
  `),
  metro_route: db.prepare(`
    SELECT id, ref, name FROM routes_metro
    WHERE lower_u(name) LIKE @contains OR lower_u(ref) LIKE @contains
    ORDER BY ${orderClause("name")}
    LIMIT @limit
  `),
  metro_stop: db.prepare(`
    SELECT id, name, lat, lon FROM stops
    WHERE stop_type = 'subway' AND lower_u(name) LIKE @contains
    ORDER BY ${orderClause("name")}
    LIMIT @limit
  `),
  stop: db.prepare(`
    SELECT id, name, stop_type, lat, lon FROM stops
    WHERE stop_type IN ('bus_stop','tram_stop') AND lower_u(name) LIKE @contains
    ORDER BY ${orderClause("name")}
    LIMIT @limit
  `),
  rail: db.prepare(`
    SELECT id, name, lat, lon FROM stops
    WHERE stop_type = 'rail' AND lower_u(name) LIKE @contains
    ORDER BY ${orderClause("name")}
    LIMIT @limit
  `),
  terminal: db.prepare(`
    SELECT id, name, stop_type, lat, lon FROM stops
    WHERE stop_type IN ('airport','bus_terminal') AND lower_u(name) LIKE @contains
    ORDER BY ${orderClause("name")}
    LIMIT @limit
  `),
  route: db.prepare(`
    SELECT id, ref, name, 'bus' as rtype FROM routes_bus WHERE lower_u(name) LIKE @contains OR lower_u(ref) LIKE @contains
    UNION ALL
    SELECT id, ref, name, 'tram' as rtype FROM routes_tram WHERE lower_u(name) LIKE @contains OR lower_u(ref) LIKE @contains
    UNION ALL
    SELECT id, ref, name, 'trolleybus' as rtype FROM routes_trolleybus WHERE lower_u(name) LIKE @contains OR lower_u(ref) LIKE @contains
    LIMIT @limit
  `),
  rubric: db.prepare(`
    SELECT rubric AS name, COUNT(*) as cnt FROM organizations
    WHERE lower_u(rubric) LIKE @contains
    GROUP BY rubric
    ORDER BY cnt DESC
    LIMIT @limit
  `),
  company: db.prepare(`
    SELECT id, name, rubric, addr_street, housenumber, lat, lon FROM organizations
    WHERE lower_u(name) LIKE @contains
    ORDER BY ${orderClause("name")}
    LIMIT @limit
  `),
};

function toResult(type, row) {
  switch (type) {
    case "address": {
      // Same reasoning as coord.js's hit-test: a bare street name with no
      // housenumber isn't a real address, just the nearest named street —
      // fine as an informal "ул. X" for an ordinary unnumbered house, but
      // misleading as the displayed "name" of a large unnamed landmark
      // (stadium, school, …). Only build the "street number" fallback name
      // when there's a number to go with the street; otherwise say what
      // kind of building this is (see buildingKind.js).
      const fallbackName = row.housenumber
        ? `${withDesignation(row.addr_street)} ${row.housenumber}`.trim()
        : buildingKindLabel(row.building);
      return {
        id: row.id, type: "address", name: row.name || fallbackName,
        subtitle: [withDesignation(row.addr_street), row.housenumber].filter(Boolean).join(" "),
        lat: row.lat, lng: row.lon, map_key: `address:${row.id}`,
      };
    }
    case "district":
      return { id: row.id, type: "district", name: row.name, subtitle: LABELS.district, lat: row.lat, lng: row.lon, map_key: `district:${row.id}` };
    case "settlement":
      return { id: row.id, type: "settlement", name: row.name, subtitle: LABELS.settlement, lat: row.lat, lng: row.lon, map_key: `settlement:${row.id}` };
    case "metro_route":
      return { id: row.id, type: "route", name: row.name, subtitle: `Метро ${row.ref}`, lat: null, lng: null, map_key: `route-metro:${row.id}`, route_type: "metro" };
    case "metro_stop":
      return { id: row.id, type: "metro", name: row.name, subtitle: LABELS.metro, lat: row.lat, lng: row.lon, map_key: `stop:${row.id}` };
    case "stop":
      return { id: row.id, type: "stop", name: row.name, subtitle: LABELS.stop, lat: row.lat, lng: row.lon, map_key: `stop:${row.id}` };
    case "rail":
      return { id: row.id, type: "rail", name: row.name, subtitle: LABELS.rail, lat: row.lat, lng: row.lon, map_key: `stop:${row.id}` };
    case "terminal":
      return { id: row.id, type: "terminal", name: row.name, subtitle: LABELS.terminal, lat: row.lat, lng: row.lon, map_key: `stop:${row.id}` };
    case "route":
      return { id: row.id, type: "route", name: row.name || row.ref, subtitle: `Маршрут ${row.rtype}`, lat: null, lng: null, map_key: `route-${row.rtype}:${row.id}`, route_type: row.rtype };
    case "rubric":
      return { id: row.name, type: "rubric", name: row.name, subtitle: `${row.cnt} организаций`, lat: null, lng: null, map_key: `rubric:${encodeURIComponent(row.name)}` };
    case "company":
      return {
        id: row.id, type: "company", name: row.name, rubric: row.rubric,
        subtitle: [row.rubric, [withDesignation(row.addr_street), row.housenumber].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
        lat: row.lat, lng: row.lon, map_key: `company:${row.id}`,
      };
    default:
      return null;
  }
}

router.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  const type = String(req.query.type || "all");
  if (q.length < 2) return res.json({ items: [], meta: { total: 0, has_more: false } });

  const subGroups = FILTER_GROUPS[type] || FILTER_GROUPS.all;
  const { prefix, contains } = likeParams(q);
  const needle = q.trim().toLowerCase();
  const items = [];
  for (const sub of subGroups) {
    if (sub === "address") {
      const { streetPart, numberPart } = splitAddressQuery(q);
      const rows = numberPart
        ? ADDRESS_WITH_NUMBER.all({
            streetContains: `%${streetPart.toLowerCase()}%`,
            numberExact: numberPart,
            numberGlob: houseNumberGlob(numberPart),
            limit: PER_SUB_LIMIT,
          })
        : ADDRESS_NO_NUMBER.all({ contains, prefix, limit: PER_SUB_LIMIT });
      for (const row of rows) {
        const result = toResult(sub, row);
        if (!result) continue;
        result._tier = numberPart
          ? (row.housenumber === numberPart ? 0 : 1)
          : Math.min(matchTier(row.addr_street, needle), matchTier(row.name, needle));
        items.push(result);
      }
      continue;
    }
    if (sub === "street") {
      const names = STREET_NAMES.all({ contains, prefix, limit: PER_SUB_LIMIT }).map((r) => r.name);
      for (const name of names) {
        const segs = STREET_SEGMENTS_BY_NAME.all({ name }).map((r) => ({ ...r, geometry: JSON.parse(r.geometry) }));
        const clusters = clusterStreetSegments(segs);
        // Deterministic representative per cluster: lowest osm_id, so
        // repeated searches/reloads always pick the same segment (matters
        // for object.js's follow-up lookup by that id). Only bother
        // disambiguating with a district name when this name actually
        // resolved to more than one real street — the common case (one
        // name, one street) keeps the plain "Улица" subtitle.
        const entries = clusters.map((cluster) => {
          const rep = cluster.slice().sort((a, b) => a.id - b.id)[0];
          const point = representativePoint(rep.geometry);
          const district = clusters.length > 1 && point ? nearestDistrict.get({ lat: point[1], lon: point[0] }) : null;
          return { rep, point, district };
        });
        // Sofia's districts don't fully tile the city, so two clusters
        // genuinely kilometers apart can still share the same "nearest
        // district" label verbatim — a user spotted exactly this ("Улица ·
        // кв. Филиповци" twice) and reasonably read it as one street listed
        // twice. dedupeLabels numbers any labels that still collide after
        // the district hint (see its comment for why a compass bearing was
        // tried and rejected here).
        const rawSubtitles = entries.map((e) => (e.district ? `${LABELS.street} · ${e.district.name}` : LABELS.street));
        const subtitles = dedupeLabels(rawSubtitles);
        entries.forEach((e, i) => {
          items.push({
            id: e.rep.id, type: "street", name: withDesignation(e.rep.name), subtitle: subtitles[i],
            lat: e.point ? e.point[1] : null, lng: e.point ? e.point[0] : null,
            map_key: `street:${e.rep.id}`,
            _tier: matchTier(e.rep.name, needle),
          });
        });
      }
      continue;
    }
    const stmt = QUERIES[sub];
    if (!stmt) continue;
    const rows = stmt.all({ prefix, contains, limit: PER_SUB_LIMIT });
    for (const row of rows) {
      const result = toResult(sub, row);
      if (!result) continue;
      // Routes/metro lines are commonly searched by their number, not their
      // full descriptive name ("Автобус 305 Централна гара => ...") — a
      // match on `ref` counts the same as one on `name` so a query like
      // "305" ranks the actual route by how well "305" itself matches, not
      // buried under the unrelated tier of its own long description.
      result._tier = row.ref != null ? Math.min(matchTier(row.name, needle), matchTier(row.ref, needle)) : matchTier(row.name, needle);
      items.push(result);
    }
  }

  // Global, relevance-first ordering instead of "whichever sub-search ran
  // first wins" (2026-09-06: "надо настроить логичный приоритет" — a plain
  // "Янтра" search used to show address results before street results
  // purely because "address" is earlier in FILTER_GROUPS.all, regardless of
  // which rows actually matched better). Every result above got tagged with
  // a cheap three-level `_tier` (`matchTier` above: 0 = matched at the very
  // start of the field, 1 = matched at the start of some word inside it,
  // 2 = matched only as a substring straddling word content) as it was
  // built; sort on that first, so an exact/prefix match of ANY type
  // outranks a loose match of ANY OTHER type. TYPE_PRIORITY only breaks
  // ties WITHIN the same tier — a rough "how likely is this what they
  // meant" ordering (a concrete
  // address or street before a category-level rubric, transport last since
  // it's the most specialized filter) — never used to promote a worse match
  // over a better one. Array.sort is stable (spec'd since ES2019, and V8
  // implements it), so within one (tier, type) pair, each sub-search's own
  // SQL ORDER BY is preserved rather than reshuffled.
  const TYPE_PRIORITY = {
    address: 0, street: 1, company: 2, rubric: 3, district: 4, settlement: 5,
    metro: 6, stop: 7, rail: 8, terminal: 9, route: 10,
  };
  items.sort((a, b) => (a._tier - b._tier) || ((TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99)));
  for (const item of items) delete item._tier;

  res.json({ items, meta: { total: items.length, has_more: false } });
});

module.exports = router;
