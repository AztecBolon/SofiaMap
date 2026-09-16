const express = require("express");
const db = require("../db");
const { buildingKindLabel } = require("../lib/buildingKind");
const { withDesignation, splitDesignation } = require("../lib/streetDesignation");
const { clusterStreetSegments, representativePoint, dedupeLabels } = require("../lib/streetCluster");
// 2026-09-09 (claude/search-results-plan.md): every result type already has
// a real page somewhere on the site (built for the "typical pages" static
// section) — these are used directly below for a street's "Связанные
// объекты" preview and a stop/rubric's own cluster grouping. The href-only
// lookups (including districts/settlements/routes, which this file has no
// OTHER use for) moved to `lib/objectHref.js` — see the require just below
// `toResult()`.
const streetsDirectory = require("../lib/streetsDirectory");
const rubricsDirectory = require("../lib/rubricsDirectory");
const stopsDirectory = require("../lib/stopsDirectory");

// Hotfix (2026-09-15): server/src/index.js's startup sequence calls
// searchRoutes.warmUpMeiliIndexes() after the reindex step (to pre-open each
// Meilisearch index and avoid a slow first request). This file was restored
// to its pre-Meilisearch, pure-SQL form and never re-exported that function,
// which crashed startup with "searchRoutes.warmUpMeiliIndexes is not a
// function". This stub restores just the export index.js needs, without
// pulling this route back onto Meilisearch for actual query serving.
const meili = require("../lib/meiliClient");
const { GROUPS } = require("../scripts/reindexMeilisearch");

const router = express.Router();

// ---- "grязный" pasted text -> just the address part (2026-09-15, live
// report, point 3) --------------------------------------------------------
// People increasingly paste a whole business-card-style text block instead
// of typing a plain query — confirmed live with the exact example that
// prompted this: "ГР. СОФИЯ, [п.к 1407] ул.Козяк 17, бл.4\n
// a1003@expressone.bg\nПонеделник: 09:00 - 17:00". None of that noise (city
// name, postal code in brackets, email, opening hours) is itself
// searchable, and left in place it can drown out the one thing that
// actually matches something in the data — the address. `extractAddressQuery`
// runs on `q` BEFORE any of the matching logic below ever sees it, and picks
// the address-looking part out; everything else in this file is unaware
// this preprocessing exists at all.
//
// `looksMessy` gates the whole thing on purpose: an ordinary, short,
// single-line query (the overwhelming majority of real searches, and every
// case this file's extensive existing tuning was built and regression-
// checked against) is returned completely untouched — only text that
// actually contains a newline, an email, an hours-range, or a bracketed
// aside goes through the cleanup/line-scoring below at all. That keeps this
// feature strictly additive: it can only ever help a query shape nothing
// here previously handled, never change how an existing plain query behaves.
const EMAIL_TEST_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/iu;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/giu;
const DAY_NAMES =
  "(?:понеделник|понедельник|вторник|сряда|среда|четвъртък|четверг|петък|пятница|събота|суббота|неделя)";
const HOURS_TEST_RE = new RegExp(`${DAY_NAMES}?\\s*:?\\s*\\d{1,2}[:.]\\d{2}\\s*[-–]\\s*\\d{1,2}[:.]\\d{2}`, "iu");
const HOURS_RE = new RegExp(HOURS_TEST_RE.source, "giu");
const BRACKETED_TEST_RE = /[[(][^\])]*[\])]/u; // "[п.к 1407]" — postal code or any other bracketed aside
const BRACKETED_RE = /[[(][^\])]*[\])]/gu;
// A leading `\b` before a Cyrillic letter never actually fires: JS's `\b` is
// defined only in terms of ASCII `\w` ([A-Za-z0-9_]), so on either side of a
// Cyrillic letter it sees "non-word" — the SAME classification a space or
// bracket gets — and two "non-word" neighbors never make a boundary at all.
// (Same underlying gotcha `lower_u` in db.js already works around for
// case-folding, just hitting `\b` instead of `lower()` here.) Confirmed
// live, the hard way: every regex below originally used `\b` before its
// Cyrillic abbreviation and silently matched nothing. A lookbehind for
// "start of string, or one of the punctuation/space characters that can
// actually precede one of these abbreviations" replaces it everywhere.
const WORD_START = "(?<=^|[\\s,([])";
const POSTCODE_RE = new RegExp(`${WORD_START}п\\.?\\s*к\\.?\\s*\\d{3,5}\\b`, "giu"); // a bare "п.к 1407" outside brackets too
const CITY_PREFIX_RE = /^\s*гр\.?\s*[^\s,]+\s*,\s*/iu; // leading "ГР. София, " / "гр София, "
const ADDRESS_DESIGNATOR_RE = new RegExp(`${WORD_START}(ул\\.|бул\\.|пл\\.|алея|бл\\.|блок)`, "iu");

// See `splitAddressQuery`'s own "бл./блок" handling further down — same gap,
// just for whichever street-type abbreviation the raw text happens to use,
// and needed here first so the line-scoring below can even recognize
// "ул.Козяк" as carrying a designator at all. Safe to always apply: it only
// ever INSERTS a space right after one of these exact abbreviations,
// nothing else in the query is touched.
function normalizeAbbrevSpacing(text) {
  return text.replace(new RegExp(`${WORD_START}(ул|бул|пл|бл|блок)\\.(?=\\S)`, "giu"), "$1. ");
}

function looksMessy(text) {
  return text.includes("\n") || EMAIL_TEST_RE.test(text) || HOURS_TEST_RE.test(text) || BRACKETED_TEST_RE.test(text);
}

function extractAddressQuery(rawQ) {
  const normalized = normalizeAbbrevSpacing(rawQ);
  if (!looksMessy(normalized)) return normalized;

  const cleaned = normalized.replace(EMAIL_RE, " ").replace(HOURS_RE, " ").replace(BRACKETED_RE, " ");

  const lines = cleaned
    .split(/\n+/)
    .map((l) => l.replace(POSTCODE_RE, " ").replace(CITY_PREFIX_RE, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!lines.length) return normalized.trim();

  // Prefer a line carrying a recognizable street-type designator AND a
  // digit (a real house/block number) — the strongest signal this line IS
  // the address. Falls back to "has a designator" alone, then "has a digit"
  // alone, then just the longest remaining line, rather than silently
  // returning nothing for a paste shape this wasn't specifically tuned for.
  const scored = lines.map((line) => {
    const score = (ADDRESS_DESIGNATOR_RE.test(line) ? 2 : 0) + (/\d/.test(line) ? 1 : 0);
    return { line, score };
  });
  scored.sort((a, b) => b.score - a.score || b.line.length - a.line.length);
  return scored[0].line;
}

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

// Hoisted here (was previously declared right next to its one call site,
// further down) because the fourth wave's street-namesake grouping (see
// "B1" below, claude/search-results-plan.md §8.2/§9) needs the exact same
// preview size for a NAMESAKE street's own mini house list, not just the
// leader's — one shared constant, not two numbers that could quietly drift
// apart.
const RELATED_LIMIT = 3;

// Fourth wave, "Проблема B" (2026-09-14, claude/search-results-plan.md
// §8.2/§9, decision B1): a compact cap on how many namesake street entries
// ride along on the leader's `namesakes` array — same reasoning as
// `NAMESAKES_INLINE_LIMIT` in routes/pages.js's house-page note (some
// generic village-style names repeat 15-20+ times across the municipality;
// listing all of them here would stop being a "compact note" and become
// its own wall of rows, just one level deeper). `namesakes_total` on the
// leader always carries the real count even when the array itself is capped.
const NAMESAKES_LIMIT = 12;

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

  // 2026-09-15 (live report: "ул. Света Екатерина бл. 79" — the exact
  // address this app itself displays for the building — found nothing;
  // then, chasing the same fix, "ул.Козяк 17, бл.4" — a pasted address
  // carrying BOTH a plain housenumber AND a block number): an explicit
  // "бл./блок" (block) designator, wherever it appears, is the strongest,
  // most specific number signal available — it's what `housenumber` itself
  // sometimes stores verbatim (db.js's `norm_house`) — so it's checked
  // FIRST, ahead of the generic trailing-number regex below. Everything
  // between the street name and this designator (most often a separate
  // plain housenumber the same address also carries) is dropped from
  // `streetPart` entirely along with it: a digit can never appear inside a
  // real `addr_street` value, so leaving one in would only ever narrow the
  // LIKE match below, never help it. `Света Екатерина` has no such
  // in-between token at all (the optional group simply matches nothing) —
  // one pattern covers both shapes.
  const blockMatch = trimmed.match(/^(.+?)(?:[,\s]+\S*\d\S*)?[,\s]+(?:бл(?:ок)?|вх(?:од)?)\.?\s*(\d+[a-zA-Zа-яА-Я]?)\s*$/iu);
  if (blockMatch) return { streetPart: stripStreetDesignator(blockMatch[1]), numberPart: blockMatch[2].trim() };

  // No explicit block designator: trailing token that looks like a plain
  // house number — digits, optionally with one trailing letter (common
  // Bulgarian suffix, e.g. "5А"). No match -> treat the whole thing as a
  // street name (or building name) query.
  const m = trimmed.match(/^(.+?)[,\s]+(\d+[a-zA-Zа-яА-Я]?)$/u);
  if (!m) return { streetPart: stripStreetDesignator(trimmed), numberPart: null };
  return { streetPart: stripStreetDesignator(m[1]), numberPart: m[2].trim() };
}

// Leading street-type designator ("ул."/"бул."/"пл."/"алея") stripped from a
// user-typed query the same way streetDesignation.js's `splitDesignation`
// already strips it off a STORED name for display — `addr_street`/
// `streets.name` never carry it themselves (see that file's header), so a
// query that includes it (exactly what this app's own cards/subtitles show,
// via `withDesignation`) could never LIKE-match the raw column at all.
function stripStreetDesignator(text) {
  return splitDesignation(text).rest;
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

// JS-side mirror of db.js's `norm_house` SQL function, for scoring rows
// AFTER they've already come back from a query (see the address `_tier`
// scoring below) — kept as a literal copy rather than a shared import since
// db.js's version has to be a plain synchronous function anyway
// (`db.function`) and duplicating one three-line regex is cheaper than a
// cross-module dependency for it.
// Longer alternatives before their own prefixes — see db.js's `norm_house`
// comment (same regex, same bug once caught: "бл" listed before "блок"
// silently mangled "Блок 12" into "ок 12").
function normHouseJs(h) {
  return String(h || "")
    .replace(/^\s*(?:блок|бл|вход|вх)\.?\s*/iu, "")
    .trim();
}

// 2026-09-15 (Point 2, "адрес вместо организации" migration —
// claude/implementation-log.md): a building migrated into a real
// `organizations` row (organizations.source_building_id — see
// generate_org_migration.js's patch) must stop surfacing as its own
// address result WHEN THE MATCH IS ITS OWN BUSINESS NAME — that's now found
// as a `company` result instead (QUERIES.company below has the matching
// exclusion the other way around). This deliberately does NOT touch
// ADDRESS_WITH_NUMBER (a literal "street + house number" query, below): a
// numbered address should always be findable by its number regardless of
// which organization (if any) occupies the building, exactly like every one
// of the other 20 699 pre-existing real organizations' host buildings
// already behave today — searching a bank's street+number and searching the
// bank's name are two independently useful queries, not a duplicate to
// suppress.
const MIGRATED_BUILDING_NAME_EXCLUSION = `id NOT IN (SELECT source_building_id FROM organizations WHERE source_building_id IS NOT NULL)`;

// `norm_house(housenumber)` (db.js) rather than the raw column: see that
// function's comment — 4% of buildings store a "бл. 79"-style block number
// with the designator baked into the column itself, which a bare typed "79"
// (or the GLOB built from it) could never match against directly.
const ADDRESS_WITH_NUMBER = db.prepare(`
  SELECT id, name, addr_street, housenumber, building, lat, lon
  FROM buildings
  WHERE lower_u(addr_street) LIKE @streetContains
    AND (norm_house(housenumber) = @numberExact OR norm_house(housenumber) GLOB @numberGlob)
  ORDER BY
    CASE WHEN norm_house(housenumber) = @numberExact THEN 0 ELSE 1 END,
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
  WHERE (lower_u(addr_street) LIKE @contains OR (lower_u(name) LIKE @contains AND ${MIGRATED_BUILDING_NAME_EXCLUSION}))
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

// 2026-09-15 live report ("Остановки тоже можно сгруппировать в кластер"):
// same two-step shape as streets just above, for the same reason — a stop
// NAME match alone doesn't mean "one stop", real-world bus/tram stops come
// in pairs or small clusters sharing one name (opposite platforms across the
// road, or several bays at a terminus/interchange like "Автостанция Изток",
// which has 8). Before this, `QUERIES.stop` returned every matching PHYSICAL
// stop as its own top-level row, so a plain "авто" search listed "Автогара
// Юг" (etc.) twice, "Автостанция Изток" up to four times — read as
// duplicates, not distinct platforms. First find which distinct NAMES match
// at all (bounded by @limit, same as every other sub-search); then, for each
// matched name, pull EVERY physical stop sharing it (unbounded — otherwise a
// big interchange could silently lose platforms to `PER_SUB_LIMIT` being
// spent on other unrelated stop names).
const STOP_NAMES = db.prepare(`
  SELECT DISTINCT name FROM stops
  WHERE stop_type IN ('bus_stop','tram_stop') AND name != '' AND lower_u(name) LIKE @contains
  ORDER BY ${orderClause("name")}
  LIMIT @limit
`);
const STOPS_BY_NAME = db.prepare(`
  SELECT id, name, stop_type, lat, lon FROM stops
  WHERE stop_type IN ('bus_stop','tram_stop') AND lower_u(name) = lower_u(@name)
`);
const nearestDistrict = db.prepare(`
  SELECT name, lat, lon,
    ((lat - @lat) * (lat - @lat) + (lon - @lon) * (lon - @lon)) AS d2
  FROM districts ORDER BY d2 ASC LIMIT 1
`);

// 2026-09-15 live report ("Слово 'автобус' — префикс, который не должен
// участвовать в поиске по запросу 'авто'"): routes_bus/routes_tram/
// routes_trolleybus/routes_metro's own `name` column embeds the VEHICLE
// TYPE as a literal leading word — "Автобус 260", "Трамвай 20 ...",
// "Тролей 1 ...", "Метролиния M1 ..." (confirmed against the real data:
// 215 of 227 bus routes, all 34 tram routes, all 20 trolleybus routes carry
// this — the rest, e.g. Flixbus international lines, don't and are
// unaffected). Exactly the same anti-pattern already fixed for streets a
// few hours earlier the same day (splitDesignation/`rest`-only matching
// above): a plain "авто" query matched effectively every city bus route,
// purely because "Автобус" starts with "авто" — nothing to do with the
// route's actual number or destination. Only used for MATCHING below, not
// display — "Автобус 260" still reads exactly as before everywhere else.
const ROUTE_DESIGNATION = /^(автобус|трамвай|тролей|метролиния)\s+/i;
function stripRouteDesignation(name) {
  return String(name || "").replace(ROUTE_DESIGNATION, "");
}

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
  // `stop` (bus/tram) is handled separately below — see STOP_NAMES/
  // STOPS_BY_NAME above — so its physical stop points can be grouped by
  // name into one clustered result instead of one row per platform.
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
  // 2026-09-15 (Point 2 migration): `cluster_of IS NULL` excludes a chain's
  // OTHER real locations (e.g. 6 of the 7 migrated "Фантастико" branches) —
  // those aren't dropped, they ride along on their cluster's primary result
  // as `related`/`related_total` (see the company-result loop below), the
  // same "one entity, one link, siblings nested" shape already used for
  // street/rubric/stop clusters in this file.
  company: db.prepare(`
    SELECT id, name, rubric, addr_street, housenumber, lat, lon FROM organizations
    WHERE lower_u(name) LIKE @contains AND cluster_of IS NULL
    ORDER BY ${orderClause("name")}
    LIMIT @limit
  `),
};

// href on a search result -> the object's real "typical page", so the
// results list/hover-popup can offer "Открыть страницу" instead of only an
// in-panel card (2026-09-09, claude/search-results-plan.md — replaces
// "Подробнее"). 2026-09-15: moved into `lib/objectHref.js` so object.js's
// `/api/object/:type/:id` (the map's "Объект на карте" card) can offer the
// exact same link for a map click, not just a search result — see that
// file's own comment for the fuller history (including the "Проблема A"
// dedup fix `addressLookup` still needs here for `_variantOf`).
const { addressLookup, districtHref, settlementHref, stopHref, routeHref, rubricHref } = require("../lib/objectHref");

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
      const found = addressLookup(row);
      return {
        id: row.id, type: "address", name: row.name || fallbackName,
        subtitle: [withDesignation(row.addr_street), row.housenumber].filter(Boolean).join(" "),
        lat: row.lat, lng: row.lon, map_key: `address:${row.id}`,
        href: found ? `/streets/${found.entry.slug}/dom-${found.house.slug}.html` : null,
        // Transient — read by the "Проблема A" dedup filter below, then
        // stripped before the response goes out (same pattern as `_tier`).
        _variantOf: found ? found.house.variantOf : null,
      };
    }
    case "district":
      return { id: row.id, type: "district", name: row.name, subtitle: LABELS.district, lat: row.lat, lng: row.lon, map_key: `district:${row.id}`, href: districtHref(row) };
    case "settlement":
      return { id: row.id, type: "settlement", name: row.name, subtitle: LABELS.settlement, lat: row.lat, lng: row.lon, map_key: `settlement:${row.id}`, href: settlementHref(row) };
    case "metro_route":
      return { id: row.id, type: "route", name: row.name, subtitle: `Метро ${row.ref}`, lat: null, lng: null, map_key: `route-metro:${row.id}`, route_type: "metro", href: routeHref("metro", row.id) };
    case "metro_stop":
      return { id: row.id, type: "metro", name: row.name, subtitle: LABELS.metro, lat: row.lat, lng: row.lon, map_key: `stop:${row.id}`, href: stopHref("subway", row.id) };
    case "stop":
      return { id: row.id, type: "stop", name: row.name, subtitle: LABELS.stop, lat: row.lat, lng: row.lon, map_key: `stop:${row.id}`, href: stopHref(row.stop_type, row.id) };
    case "rail":
      return { id: row.id, type: "rail", name: row.name, subtitle: LABELS.rail, lat: row.lat, lng: row.lon, map_key: `stop:${row.id}`, href: stopHref("rail", row.id) };
    case "terminal":
      // Only "bus_terminal" has its own static page (stopsDirectory.js's
      // TYPE_LABELS has no "airport" entry — this dataset never built one)
      // — an airport result stays without a page link rather than a guess.
      return { id: row.id, type: "terminal", name: row.name, subtitle: LABELS.terminal, lat: row.lat, lng: row.lon, map_key: `stop:${row.id}`, href: row.stop_type === "bus_terminal" ? stopHref("bus_terminal", row.id) : null };
    case "route":
      return { id: row.id, type: "route", name: row.name || row.ref, subtitle: `Маршрут ${row.rtype}`, lat: null, lng: null, map_key: `route-${row.rtype}:${row.id}`, route_type: row.rtype, href: routeHref(row.rtype, row.id) };
    case "rubric":
      return { id: row.name, type: "rubric", name: row.name, subtitle: `${row.cnt} организаций`, lat: null, lng: null, map_key: `rubric:${encodeURIComponent(row.name)}`, href: rubricHref(row.name) };
    case "company": {
      const link = rubricsDirectory.getCompanyLink(row.rubric, row.id);
      return {
        id: row.id, type: "company", name: row.name, rubric: row.rubric,
        subtitle: [row.rubric, [withDesignation(row.addr_street), row.housenumber].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
        lat: row.lat, lng: row.lon, map_key: `company:${row.id}`,
        href: link ? link.href : null,
      };
    }
    default:
      return null;
  }
}

router.get("/search", (req, res) => {
  // `extractAddressQuery` (2026-09-15, point 3) picks the address-looking
  // part out of a pasted noisy text block; a plain typed query passes
  // through it unchanged (see `looksMessy`), so this is a no-op for every
  // query shape this file's existing tuning already covers.
  const q = extractAddressQuery(String(req.query.q || "").trim());
  const type = String(req.query.type || "all");
  if (q.length < 2) return res.json({ items: [], meta: { total: 0, has_more: false } });

  const subGroups = FILTER_GROUPS[type] || FILTER_GROUPS.all;
  const { prefix, contains } = likeParams(q);
  const needle = q.trim().toLowerCase();
  const items = [];
  // Hoisted up here (was declared much further down, right next to the
  // leader's own related-house loop) because the fix for the live report
  // "по нашей логике, все адреса должны сгруппироваться внутри кластера
  // улицы" (2026-09-15) needs to add house ids to this set from TWO places
  // now: the leader's related-house loop below, AND the namesake-building
  // code inside the street sub-search above (a namesake street's houses
  // were never excluded from the flat address list at all before this fix
  // — only the LEADER's were, and even then only its first
  // `RELATED_LIMIT`-shown houses, not its whole cluster). One shared Set
  // populated from both places, declared before either can run.
  const relatedHouseIds = new Set();
  for (const sub of subGroups) {
    if (sub === "address") {
      const { streetPart, numberPart } = splitAddressQuery(q);
      // 2026-09-15: the no-number path used to reuse the OUTER `contains`/
      // `prefix` (built from the raw, un-stripped `q`) — the exact same
      // "ул./бул./..." designator-prefix problem as the with-number path
      // above, just never demonstrated live because every reported failure
      // happened to include a house number. `streetPart` here already has
      // any designator stripped (`splitAddressQuery` -> `stripStreetDesignator`),
      // so a plain "ул. Раковски" (no number) query now matches
      // `addr_street`/`name` the same way "Раковски" alone always did.
      const streetLike = likeParams(streetPart);
      const rows = numberPart
        ? ADDRESS_WITH_NUMBER.all({
            streetContains: `%${streetPart.toLowerCase()}%`,
            numberExact: numberPart,
            numberGlob: houseNumberGlob(numberPart),
            limit: PER_SUB_LIMIT,
          })
        : ADDRESS_NO_NUMBER.all({ contains: streetLike.contains, prefix: streetLike.prefix, limit: PER_SUB_LIMIT });
      for (const row of rows) {
        const result = toResult(sub, row);
        if (!result) continue;
        // Score against the designator-stripped `streetPart`/`normHouseJs`,
        // not the raw `needle`/`row.housenumber` — same reasoning as the
        // query/column fixes just above (2026-09-15): an exact match that's
        // only "inexact" because of a designator prefix on one side or a
        // "бл./блок" baked into the OTHER side is still the best possible
        // match, and should score tier 0 the same as any other exact hit.
        result._tier = numberPart
          ? (normHouseJs(row.housenumber) === numberPart ? 0 : 1)
          : Math.min(matchTier(row.addr_street, streetPart.toLowerCase()), matchTier(row.name, streetPart.toLowerCase()));
        items.push(result);
      }
      continue;
    }
    if (sub === "street") {
      const names = STREET_NAMES.all({ contains, prefix, limit: PER_SUB_LIMIT }).map((r) => r.name);
      for (const name of names) {
        // 2026-09-15 live report ("Автомагистрала, как и ул, бул, в поиске
        // не участвуют" — a plain "авто" search was returning all four
        // "Автомагистрала X" highways at the very top of the results,
        // ahead of the actually-relevant "Авто и мото" rubric): the SQL
        // above matches on the RAW `name` column, and "авто" happens to be
        // a literal prefix of the designator word "Автомагистрала" itself
        // — none of these four highways' own names ("Хемус"/"Европа"/
        // "Тракия"/"Струма") contain "авто" anywhere (confirmed against
        // the real database: those are the ONLY four street names "авто"
        // matches at all). Same principle `withDesignation`/
        // `splitDesignation` already apply to display and alphabetization
        // — a designator prefix (ул./бул./пл./алея/Автомагистрала) must
        // never be what makes a street match a search query — so skip any
        // name here whose designator-stripped `rest` doesn't itself
        // contain the query anywhere. Regression-checked: "хемус"/
        // "струма" etc. still find these highways fine (the query then
        // lives inside `rest`, not just the designator).
        const rest = splitDesignation(name).rest;
        if (!rest.toLowerCase().includes(needle)) continue;
        const segs = STREET_SEGMENTS_BY_NAME.all({ name }).map((r) => ({ ...r, geometry: JSON.parse(r.geometry) }));
        const clusters = clusterStreetSegments(segs);
        // Deterministic representative per cluster: lowest osm_id, so
        // repeated searches/reloads always pick the same segment (matters
        // for object.js's follow-up lookup by that id). Only bother
        // disambiguating with a district name when this name actually
        // resolved to more than one real street — the common case (one
        // name, one street) keeps the plain "Улица" subtitle. `dirEntry`
        // (same representative-segment choice as streetsDirectory.js's own
        // build(), so this `byRepId` lookup lands on the exact same
        // directory entry, not a re-derived one) is needed for every
        // cluster now, not just the one that used to become a result row —
        // see the leader/namesakes split below.
        const entries = clusters.map((cluster) => {
          const rep = cluster.slice().sort((a, b) => a.id - b.id)[0];
          const point = representativePoint(rep.geometry);
          const district = clusters.length > 1 && point ? nearestDistrict.get({ lat: point[1], lon: point[0] }) : null;
          const dirEntry = streetsDirectory.get().byRepId.get(rep.id) || null;
          return { rep, point, district, dirEntry };
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

        // Fourth wave, "Проблема B" (2026-09-14, search-results-plan.md
        // §8.2/§9, decision B1): Sofia genuinely has several real,
        // physically unconnected streets sharing one name (up to ~10 for
        // "Витоша") — the exact situation the static street page's
        // "namesakes" note already explains honestly rather than hiding
        // (routes/pages.js). Before this wave, every entry here became its
        // own top-level `street` result — correct, but once the bubbling
        // step below puts all of them at the very front of the list at
        // once, it reads as a wall of identical-looking headers (the
        // literal complaint). Now only ONE "leader" cluster — the one with
        // the most real houses, ties broken by lowest osm_id for
        // determinism across reloads — becomes an actual result row (with
        // its own normal "Связанные объекты" preview, computed further
        // down as before); the rest ride along on it as a compact
        // `namesakes` list instead of separate rows. A name with only one
        // real cluster (the overwhelming majority of streets) is entirely
        // unaffected — no house-count lookups, no `namesakes` field.
        const leaderIndex =
          entries.length < 2
            ? 0
            : entries
                .map((e, i) => ({
                  i,
                  houseCount: e.dirEntry ? streetsDirectory.getHousesForEntry(e.dirEntry).filter((h) => !h.variantOf).length : 0,
                }))
                .sort((a, b) => b.houseCount - a.houseCount || entries[a.i].rep.id - entries[b.i].rep.id)[0].i;

        const leader = entries[leaderIndex];
        const namesakeEntries = entries.length > 1 ? entries.filter((_, i) => i !== leaderIndex) : [];
        items.push({
          id: leader.rep.id, type: "street", name: withDesignation(leader.rep.name), subtitle: subtitles[leaderIndex],
          lat: leader.point ? leader.point[1] : null, lng: leader.point ? leader.point[0] : null,
          map_key: `street:${leader.rep.id}`,
          href: leader.dirEntry ? `/streets/${leader.dirEntry.slug}.html` : null,
          // 2026-09-15 live report ("первым в выдаче должна быть улица в
          // центральной Софии" — "витоша" was returning the small "Витоша"
          // residential cluster (54 houses, bare raw name) ahead of the
          // actual central "бул. Витоша" boulevard, 149 houses): root cause
          // turned out to be `matchTier` scoring the boulevard's tier
          // against its RAW name, which already carries the "бул. " prefix
          // as literal text in this dataset (unlike most streets, which
          // have no designator in their raw `name` at all) — so a bare
          // "Витоша" query starts the whole field for the plain name (tier
          // 0) but only starts a WORD for "бул. Витоша" (tier 1), purely
          // because of a designator prefix that has nothing to do with how
          // well the actual street name matches.
          //
          // Score against the designator-stripped `rest` only, computed
          // above for the inclusion check — NOT the raw name (this used to
          // be a `Math.min` of both, dropped the same day, second report:
          // "Автомагистрала...в поиске не участвуют" showed that also
          // checking the raw name lets a query that only matches the
          // DESIGNATOR word itself ("авто" against "Автомагистрала Хемус")
          // still score tier 0 via the raw name — exactly the "designator
          // must not participate in search" rule this was supposed to
          // respect, not violate. `rest`-only scoring still fixes "бул.
          // Витоша" above (rest = "Витоша", tier 0, since the query lives
          // in the actual name there) and leaves ordinary streets (no
          // recognized designator prefix -> `rest === name`) unaffected.
          _tier: matchTier(rest, needle),
          _dirEntry: leader.dirEntry,
          ...(namesakeEntries.length
            ? {
                namesakes_total: namesakeEntries.length,
                // Capped like routes/pages.js's own NAMESAKES_INLINE_LIMIT —
                // a handful of generic village-style names repeat 15-20+
                // times across the municipality, and that stops being a
                // "compact note" if every single one rides along here.
                // `namesakes_total` above always carries the real count.
                namesakes: namesakeEntries.slice(0, NAMESAKES_LIMIT).map((other) => {
                  const j = entries.indexOf(other);
                  const houses = other.dirEntry ? streetsDirectory.getHousesForEntry(other.dirEntry).filter((h) => !h.variantOf) : [];
                  const shown = houses.slice(0, RELATED_LIMIT);
                  // 2026-09-15 live report fix: a namesake's houses are just
                  // as much "inside a street cluster" as the leader's — the
                  // whole point of B1 was that every real street cluster for
                  // this name gets ONE place it belongs (leader row or
                  // namesake note), never a second life as loose flat
                  // address rows. Note this uses the namesake's FULL
                  // `houses` list, not just the `RELATED_LIMIT`-sized
                  // `shown` preview actually rendered here.
                  for (const h of houses) relatedHouseIds.add(h.id);
                  return {
                    id: other.rep.id, type: "street", name: withDesignation(other.rep.name), subtitle: subtitles[j],
                    lat: other.point ? other.point[1] : null, lng: other.point ? other.point[0] : null,
                    href: other.dirEntry ? `/streets/${other.dirEntry.slug}.html` : null,
                    related: shown.map((h) => ({
                      id: h.id, type: "address", name: h.displayName, subtitle: "Дом",
                      href: other.dirEntry ? `/streets/${other.dirEntry.slug}/dom-${h.slug}.html` : null,
                      lat: h.lat, lng: h.lon,
                    })),
                    related_total: houses.length,
                  };
                }),
              }
            : {}),
        });
      }
      continue;
    }
    if (sub === "stop") {
      // See STOP_NAMES/STOPS_BY_NAME above for why this isn't a plain
      // `QUERIES.stop` lookup: group the matched physical stops so
      // "Автогара Юг" (2 platforms), "Автостанция Изток" (8 platforms
      // across bus+tram) etc. become ONE result each, not one row per
      // platform.
      //
      // 2026-09-15 live report, second round ("организации... остановки не
      // сгруппированы" turned out to mean something different once
      // clarified — see stopsDirectory.js's getClusterForStop comment):
      // grouping purely by NAME (as this used to) wrongly merges same-named
      // stops that are physically kilometers apart ("Околовръстен път" —
      // 24 points, 20km spread) into one fake "cluster". Group by
      // stopsDirectory's own geographic cluster instead — every physical
      // point in the SAME real cluster collapses to one result (the
      // cluster's own leader, shared with pages.js so the link below always
      // points at the one real page for that place); a same-named point
      // that clustering correctly kept SEPARATE (too far away) surfaces as
      // its own independent result here, with its own link, exactly as
      // asked ("должна быть отдельная ссылка").
      const names = STOP_NAMES.all({ contains, prefix, limit: PER_SUB_LIMIT }).map((r) => r.name);
      const seenLeaders = new Set();
      for (const name of names) {
        const points = STOPS_BY_NAME.all({ name });
        for (const point of points) {
          const cluster = stopsDirectory.getClusterForStop(point.stop_type, point.id);
          const leaderKey = cluster ? `${cluster.leaderType}:${cluster.leaderId}` : `${point.stop_type}:${point.id}`;
          if (seenLeaders.has(leaderKey)) continue;
          seenLeaders.add(leaderKey);

          const leader = cluster ? cluster.members[0] : { id: point.id, lat: point.lat, lon: point.lon };
          const leaderName = cluster ? cluster.name : point.name;
          const result = toResult("stop", { id: leader.id, name: leaderName, stop_type: leader.type || point.stop_type, lat: leader.lat, lon: leader.lon });
          if (!result) continue;
          result._tier = matchTier(leaderName, needle);

          const siblings = cluster ? cluster.members.slice(1) : [];
          if (siblings.length) {
            const shown = siblings.slice(0, RELATED_LIMIT);
            // 2026-09-15 live report, THIRD round ("нужна одна страница по
            // этой сущности... при выдаче — только одна ссылка на эту
            // страницу"): every sibling used to carry its OWN `href` to its
            // own individual page — a stop with 8 platforms showed 8
            // separate "Открыть страницу" links, no less confusing than the
            // original "looks like duplicates" complaint this whole feature
            // started from (which page is "the" page for this stop?). Now
            // there is exactly ONE real link for the whole entity — the
            // leader's own `href` above — and pages.js 301-redirects any
            // sibling's individual page to it, so a sibling intentionally
            // gets no `href` of its own here (map-search.js explains why in
            // a short note instead of rendering dead-end duplicate links).
            result.related = shown.map((s, i) => ({
              id: s.id, type: "stop", name: `Точка ${i + 2}`, subtitle: LABELS.stop,
              lat: s.lat, lng: s.lon,
            }));
            result.related_total = siblings.length;
          }
          items.push(result);
        }
      }
      continue;
    }
    const stmt = QUERIES[sub];
    if (!stmt) continue;
    const rows = stmt.all({ prefix, contains, limit: PER_SUB_LIMIT });
    for (const row of rows) {
      const result = toResult(sub, row);
      if (!result) continue;
      if (sub === "route" || sub === "metro_route") {
        // See ROUTE_DESIGNATION/stripRouteDesignation above: the SQL WHERE
        // clause above still matches on the raw `name` (needed so a route
        // IS found at all when the query is its actual number/destination),
        // but a match that only lives inside the vehicle-type word itself
        // must not count — skip the row entirely rather than just
        // downranking it, same treatment street designations got earlier.
        const rest = stripRouteDesignation(row.name);
        const refMatches = row.ref != null && String(row.ref).toLowerCase().includes(needle);
        if (!rest.toLowerCase().includes(needle) && !refMatches) continue;
        result._tier = row.ref != null ? Math.min(matchTier(rest, needle), matchTier(row.ref, needle)) : matchTier(rest, needle);
        items.push(result);
        continue;
      }
      if (sub === "company") {
        // 2026-09-15 (Point 2 migration): a handful of organizations are the
        // PRIMARY of a same-name city-wide chain cluster (e.g. "Фантастико",
        // migrated from 7 addressless buildings — see
        // generate_org_migration.js) — QUERIES.company above already
        // excludes every other member from ever becoming its own flat
        // result, so they're attached here instead, same "one entity, one
        // link, siblings nested" shape the stop/street/rubric clusters above
        // already use. The lookup is cheap (returns [] for the other
        // ~21 000 ordinary organizations) so it's not worth a separate
        // "is this a cluster primary" flag on the row.
        const members = rubricsDirectory.getClusterMembers(row.id);
        if (members.length) {
          // Unlike a stop's siblings ("Точка N" — anonymous platforms of one
          // physical place), each member here is a genuinely different real
          // address of the same chain, so the useful label IS the address,
          // not the (identical, uninformative) brand name again — same
          // reasoning as a street's related-house rows showing the house's
          // own displayName rather than repeating the street name.
          result.related = members.map((m) => ({
            id: m.id, type: "company",
            name: [withDesignation(m.addr_street), m.housenumber].filter(Boolean).join(" ") || "Без указанного адреса",
            subtitle: LABELS.company,
            lat: m.lat, lng: m.lon,
          }));
          result.related_total = members.length;
        }
      }
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

  // Rubric AND street results whose query match is at least as strong as
  // "some word in the name starts with it" (tier 0 or 1 — see `matchTier`
  // above) count as "the query hit this rubric/street" and get bubbled to
  // the very front of the list below, mirroring the reference screenshot's
  // "Полиция" example. Rubrics got this in the second wave (2026-09-14,
  // claude/next-steps-rubric-grouping.md §6.1, decision 4); streets joined
  // in the third wave, same day — reported after the second wave shipped:
  // a plain "Витоша" search buried its "Связанные объекты" block ~11 rows
  // down (many exact-housenumber address hits, plus Sofia genuinely having
  // ~10 distinct real streets all named "Витоша" in different
  // neighbourhoods, rank ahead of it under the untouched tier/type sort),
  // which read as "street grouping isn't happening" even though it was —
  // confirmed live against the user's own running server (Chrome, real
  // sofia.db) before concluding this wasn't a dedup bug. User explicitly
  // asked for the same bubbling streets already get symmetric treatment
  // with rubrics. `items` is already tier-then-type sorted at this point,
  // so filtering it (rather than re-deriving order) keeps street and
  // rubric hits interleaved exactly as the existing sort already ranked
  // them relative to each other. Captured here, before `_tier` is stripped
  // from every item a few lines down.
  const bubbleItems = items.filter((item) => (item.type === "rubric" || item.type === "street") && item._tier <= 1);
  // `_tier` itself is NOT stripped here anymore (used to be, right at this
  // point) — the 2026-09-15 live report ("первым в выдаче должна быть улица
  // в центральной Софии") needs it to survive a bit longer, for the final
  // `bubbleItems` re-sort below. Cleaned up at the very end of the handler
  // instead, once nothing else needs it.

  // ---- "Связанные объекты" (2026-09-09, claude/search-results-plan.md) --
  // For a street match, nest its first few real houses inline instead of
  // leaving the street as a bare, childless row — the reference screenshot
  // this was modeled on shows exactly this under a plain street-name
  // search. Runs AFTER the relevance sort above and only adds/removes
  // fields — the top-level ordering decided above is untouched (per the
  // project owner's decision: don't rework sorting, only add grouping).
  //
  // Deliberately built from `getHousesForEntry(...).filter(h => !h.variantOf)`,
  // NOT the `variants` mechanism itself: `variants`/`variantOf`
  // (housenumberProvenance.js) flag the SAME building imported twice from
  // two data sources — a data-quality artifact, not a second real building
  // — so surfacing them as "related objects" would present duplicate-data
  // bookkeeping as if it were genuine nearby addresses.
  for (const item of items) {
    if (item.type !== "street" || !item._dirEntry) continue;
    const houses = streetsDirectory.getHousesForEntry(item._dirEntry).filter((h) => !h.variantOf);
    if (!houses.length) continue;
    const shown = houses.slice(0, RELATED_LIMIT);
    item.related = shown.map((h) => ({
      id: h.id, type: "address", name: h.displayName, subtitle: "Дом",
      href: `/streets/${item._dirEntry.slug}/dom-${h.slug}.html`,
      lat: h.lat, lng: h.lon,
    }));
    item.related_total = houses.length;
    // 2026-09-15: was `for (const h of shown)` — only excluding the first
    // `RELATED_LIMIT` houses actually shown in the preview from the flat
    // address list, leaving the REST of the leader's own cluster (e.g. all
    // but 3 of "бул. Витоша"'s 149 houses) to still show up a second time
    // as ordinary top-level `address` rows further down the same results
    // page. The preview size and the dedup scope are different concerns —
    // every house that belongs to this cluster must be excluded, not just
    // the ones actually rendered under the street row.
    for (const h of houses) relatedHouseIds.add(h.id);
  }
  for (const item of items) delete item._dirEntry;

  // ---- "Организации" for a rubric match (2026-09-14, second wave — see
  // claude/next-steps-rubric-grouping.md and search-results-plan.md §6) —
  // symmetric to "Связанные объекты" above, but for `rubric` results: nest
  // the rubric's own first few organizations inline (`related`/
  // `related_total`, same field names the frontend already knows how to
  // render for streets) so a query that hits a rubric ("Полиция") shows it
  // as a real result with real organizations under it, not a bare "N
  // организаций" row. Only for rubrics `bubbleItems` picked out above
  // (tier 0/1 — see decision 4); a rubric that only shows up as a low-tier
  // filler match doesn't get this treatment.
  //
  // `getCompaniesForRubric` is the SAME cache `/rubrics/:slug/` pages build
  // from — reusing it (rather than a fresh query) means the slug assigned
  // to each company here is guaranteed to be the one its real page actually
  // lives at.
  const RUBRIC_RELATED_LIMIT = 5;
  const rubricRelatedCompanyIds = new Set();
  for (const item of bubbleItems) {
    if (item.type !== "rubric") continue;
    const rubricEntry = rubricsDirectory.listRubrics().find((r) => r.name === item.name);
    const companies = rubricEntry ? rubricsDirectory.getCompaniesForRubric(rubricEntry) : [];
    if (!companies.length) continue;
    const shown = companies.slice(0, RUBRIC_RELATED_LIMIT);
    item.related = shown.map((c) => ({
      id: c.id, type: "company", name: c.name,
      subtitle: [withDesignation(c.addr_street), c.housenumber].filter(Boolean).join(" "),
      href: `/rubrics/${rubricEntry.slug}/${c.slug}.html`,
      lat: c.lat, lng: c.lon,
    }));
    item.related_total = companies.length;
    // 2026-09-15 live report ("организации уже попали в кластер категории,
    // не надо их выводить дополнительно"): same bug/fix shape as the street
    // leader's related-house loop above — was `for (const c of shown)`, only
    // excluding the first `RUBRIC_RELATED_LIMIT` companies actually shown in
    // the preview, leaving the REST of the rubric's own members to still
    // show up a second time as ordinary top-level `company` rows. Confirmed
    // live: "авто" bubbled the "Авто и мото" rubric (746 orgs) at the top,
    // then listed 12 more flat `company` rows further down the SAME page,
    // every one of them already tagged rubric "Авто и мото" — i.e. already
    // a member of the cluster just shown. Every company belonging to this
    // bubbled rubric must be excluded, not just the ones actually rendered
    // in its preview.
    for (const c of companies) rubricRelatedCompanyIds.add(c.id);
  }

  // A house folded into some street's `related` list, or an organization
  // folded into some rubric's `related` list, above shouldn't also show up
  // as its own separate top-level row — same object, shown once.
  //
  // 2026-09-14 (fourth wave, "Проблема A" — search-results-plan.md
  // §8.1/§9): the third exclusion here is unrelated to either preview
  // above — it drops a top-level `address` row whose OWN building is a
  // `variantOf` a different id (the same duplicate-import situation
  // `getHousesForEntry(...).filter(h => !h.variantOf)` already filters out
  // of the street preview, just never applied to this flat list before).
  // Confirmed live: a plain "витоша" search returned "ул. Витоша 10" (and
  // "…6") twice, as two different ids, because this filter was missing.
  let finalItems = items.filter(
    (item) =>
      !(item.type === "address" && relatedHouseIds.has(item.id)) &&
      !(item.type === "company" && rubricRelatedCompanyIds.has(item.id)) &&
      !(item.type === "address" && item._variantOf)
  );
  for (const item of finalItems) delete item._variantOf;

  // Bubble the qualifying rubric(s)/street(s) to the very front —
  // deliberately a stable partition run AFTER the relevance sort, not a
  // change to `_tier`/`TYPE_PRIORITY` themselves (same reasoning as the
  // rest of this file: don't rework top-level ordering, only add grouping
  // on top of it).
  //
  // 2026-09-15 live report ("первым в выдаче должна быть улица в
  // центральной Софии"): a plain "витоша" search bubbled TWO street rows —
  // "бул. Витоша" (149 real houses, central Sofia) and the "ул. Витоша"
  // leader (only 54 houses) — and until now `bubbleItems` was left in
  // whatever order the earlier tier/TYPE_PRIORITY sort happened to leave
  // them, which is name-collation order among same-tier same-type items,
  // not relevance. Re-sorting here by the SAME (tier, type) keys first —
  // so this can never promote a worse tier/type match over a better one,
  // only break ties within one — and then by `related_total` descending
  // (a bigger real street outranks a smaller same-tier same-type one) fixes
  // that. `related_total` is only meaningful once populated above (the
  // leader's own related-house loop, and the rubric-related loop), both of
  // which have already run by this point.
  if (bubbleItems.length) {
    bubbleItems.sort(
      (a, b) =>
        (a._tier - b._tier) ||
        ((TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99)) ||
        ((b.related_total ?? 0) - (a.related_total ?? 0))
    );
    const bubbleSet = new Set(bubbleItems);
    finalItems = [...bubbleItems, ...finalItems.filter((item) => !bubbleSet.has(item))];
  }
  for (const item of finalItems) delete item._tier;

  res.json({ items: finalItems, meta: { total: finalItems.length, has_more: false } });
});

router.warmUpMeiliIndexes = async function warmUpMeiliIndexes() {
  for (const group of Object.keys(GROUPS)) {
    try {
      await meili.index(group).search("", { limit: 1 });
    } catch (err) {
      console.warn(`[warmup] skipped Meilisearch group "${group}": ${err.message}`);
    }
  }
};

module.exports = router;
