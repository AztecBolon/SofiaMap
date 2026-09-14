const express = require("express");
const db = require("../db");
const { buildingKindLabel } = require("../lib/buildingKind");
const { withDesignation } = require("../lib/streetDesignation");
// 2026-09-09 (claude/search-results-plan.md): every result type already has
// a real page somewhere on the site (built for the "typical pages" static
// section) — these are only needed here to attach that page's URL to each
// search result (`href`) and, for a street match, its first few houses
// ("Связанные объекты"). None of this touches the relevance ordering below.
const streetsDirectory = require("../lib/streetsDirectory");
const rubricsDirectory = require("../lib/rubricsDirectory");
const areasDirectory = require("../lib/areasDirectory");
const stopsDirectory = require("../lib/stopsDirectory");
const routesDirectory = require("../lib/routesDirectory");
// 2026-09-14 (search sandbox spike, claude/search-results-plan.md §11-§12):
// FULL REPLACEMENT design (§12 pivot) — Meilisearch is no longer an
// additive/extra candidate source running alongside SQL LIKE/GLOB queries;
// it is now the ONLY candidate source for every sub-search, including the
// numbered-address path ("Оборище 5"), which used to be the one thing kept
// 100% on SQL/GLOB (see git history / search-results-plan.md §11 for that
// earlier additive version). The explicit reason (§12, user's own words):
// "Задача милисерч — в первую очередь увеличение скорости поиска, SQL-
// запросы в этом контексте должны быть отключены" — running SQL AND
// Meilisearch for every request can only ever be slower than SQL alone, so
// once Meilisearch covers a sub-search's recall, its SQL query is deleted,
// not kept as a parallel path. There is now NO SQL left directly in this
// file at all — the one thing that used to remain (street-segment geometry
// for clustering, and reverse-geocoding a point to a district label) turned
// out, on closer look (§12.5), to be work streetsDirectory.js already does
// once at server startup and keeps in memory; this file now reuses that
// cache (`streetsDirectory.getEntriesByName`/`getClusterGeometry`) instead
// of re-querying `streets`/`districts` and re-clustering on every request.
// `fuzzyAccept` is now the SOLE correctness gate on every result (there's
// no SQL ground truth to fall back on if Meilisearch is wrong) — see that
// file for why Meilisearch's own rankingScore isn't trusted directly.
// `_tier`/`TYPE_PRIORITY`/the boosting below are unchanged — Meilisearch
// only replaces candidate retrieval, never ranking.
//
// Accepted trade-off (§12, explicitly approved): SQL's old tier-2 behavior
// — a query matching only as an arbitrary substring straddling word content
// ("рпу" inside "коРПУс") — has no Meilisearch equivalent (it's a word-
// based engine) and is not reproduced. Anything that only ever matched at
// that tier under the old SQL LIKE now legitimately finds nothing; this was
// always the lowest-value, most false-positive-prone tier (see matchTier's
// own comment) and losing it was explicitly signed off on rather than
// discovered as a regression.
const meili = require("../lib/meiliClient");
const { fuzzyAccept } = require("../lib/fuzzyAccept");

const router = express.Router();

// Every sub-search FILTER_GROUPS can route to now has a matching Meilisearch
// sub (scripts/reindexMeilisearch.js builds exactly these 12) — there is
// no SQL-only sub left to special-case.
const MEILI_INDEXED_SUBS = new Set([
  "address", "street", "district", "settlement", "metro_route", "metro_stop",
  "stop", "rail", "terminal", "route", "rubric", "company",
]);

// 2026-09-14 (§14, real-machine deployment finding): each sub above used to
// be its OWN physical Meilisearch index (12 total). That broke on the real
// Windows machine — see reindexMeilisearch.js's top comment for the full
// story (Windows can only keep ~4-6 Meilisearch indexes open at once, and
// every search here queries all 12 subs in parallel, so the engine had to
// constantly close/reopen indexes just to serve one request, which itself
// panicked often enough on Windows to be a real, live problem). The 12 subs
// now live in 3 physical indexes (GROUP_OF), each document tagged with a
// `sub` field — every search below filters `sub = "<sub>"` so recall/
// ranking is unaffected (Meilisearch filters before ranking, so ranking
// still only ever sees one sub's own documents, exactly as when each sub
// had its own index); this mapping just says which physical index a given
// sub's documents now live in.
const GROUP_OF = {
  address: "places", street: "places", district: "places", settlement: "places",
  metro_route: "transport", metro_stop: "transport", stop: "transport",
  rail: "transport", terminal: "transport", route: "transport",
  rubric: "business", company: "business",
};

// Text fields worth checking `needle` against for each sub — used to gate a
// Meilisearch hit through `fuzzyAccept` with the same fields `matchTier`
// itself looks at further down (so a hit fuzzyAccept vouches for is also a
// hit matchTier can meaningfully tier).
function textFieldsFor(sub, hit) {
  switch (sub) {
    case "address":
      return [hit.name, hit.addr_street];
    case "street":
    case "rubric":
      return [hit.name];
    case "metro_route":
    case "route":
      return [hit.name, hit.ref];
    default:
      return [hit.name];
  }
}

// Single entry point for every Meilisearch lookup in this file. `gate` is
// the text fuzzyAccept checks each hit's fields against — normally the same
// as `queryText`, but the numbered-address path passes just the street part
// (see below: the house-number half is already handled exactly, via
// `filter`, so it has nothing to do with the fuzzy gate). `fields` lets a
// caller narrow which of the hit's fields count for the gate (again, the
// numbered-address path: only `addr_street` should gate there, matching
// what the old SQL query actually checked — a building's own `name` was
// never part of that specific match).
async function meiliSearchOnce(sub, queryText, { filter, limit = PER_SUB_LIMIT } = {}) {
  // Narrow the group-wide index back down to this one sub's own documents
  // (see GROUP_OF's comment) — always ANDed with any caller-supplied filter
  // (the numbered-address path's exact hn_digits/hn_letter match).
  const subFilter = `sub = "${sub}"`;
  const combinedFilter = filter ? `${subFilter} AND (${filter})` : subFilter;
  return meili.index(GROUP_OF[sub]).search(queryText, {
    // Headroom: fuzzyAccept rejects some of what Meilisearch returns
    // (noise its own ranking let through — see fuzzyAccept.js), and
    // `sortByRelevance` below needs to see every real candidate to pick
    // the SAME top-`limit` old SQL's exhaustive scan+ORDER BY would have
    // — not just whichever ones Meilisearch's own ranking happens to put
    // first. `limit * 4` (48) was found too small live: a common short
    // word like "авто" has ~145 real company matches, and the specific
    // ones old SQL's tie-break preferred could sit well past position 48
    // in Meilisearch's own ranking (confirmed: one such case sat at rank
    // 48, one past this exact cutoff). 300 comfortably covers every
    // measured real-query candidate count on this dataset while staying
    // cheap — Meilisearch itself answers a 300-limit query in single-
    // digit-to-low-double-digit ms even on the ~112k-document address
    // index (measured), and fuzzyAccept's own filtering cost scales the
    // same way, linearly, so this isn't a meaningful latency risk.
    limit: Math.max(limit * 4, 300),
    filter: combinedFilter,
  });
}

async function meiliSearchSub(sub, queryText, { filter, limit = PER_SUB_LIMIT, gate = queryText, fields } = {}) {
  if (!MEILI_INDEXED_SUBS.has(sub)) return [];
  let res;
  try {
    res = await meiliSearchOnce(sub, queryText, { filter, limit });
  } catch (err) {
    // 2026-09-14 (real-machine deployment finding, search-results-plan.md
    // §14): right after a fresh reindex on the real Windows machine, the
    // FIRST search against a just-written index sometimes threw "Too many
    // spurious wake ups while trying to open the index X" — looks like
    // Windows file-locking/AV-scan contention while Meilisearch lazily
    // opens that index's memory-mapped files, not a real/permanent
    // failure (a retry moments later succeeds, and index.js's own startup
    // warm-up below now forces this "first open" before the server ever
    // accepts a real request, so live users shouldn't hit this at all).
    // One retry here is cheap insurance for whatever this warm-up doesn't
    // catch — most requests never need it.
    await new Promise((r) => setTimeout(r, 150));
    try {
      res = await meiliSearchOnce(sub, queryText, { filter, limit });
    } catch (err2) {
      // Meilisearch down/unreachable/still failing: log and degrade to an
      // empty result for THIS sub only, rather than failing the whole
      // request — one sub being unavailable shouldn't take every other
      // sub's results down with it. (Unlike the additive design, there is
      // no SQL fallback left here — that's the explicit, accepted cost of
      // "SQL must be disabled in this context", §12.)
      console.warn(`[search] Meilisearch "${sub}" lookup failed (after retry): ${err2.message}`);
      return [];
    }
  }
  return res.hits.filter((hit) => {
    const textFields = fields ? fields(hit) : textFieldsFor(sub, hit);
    return textFields.some((t) => t && fuzzyAccept(gate, t));
  });
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

// 2026-09-14 (§12, real-diff bugfix — see implementation-log for the full
// story): every old SQL query truncated to LIMIT @limit AFTER an explicit
// `ORDER BY` (`orderClause` further down: exact/prefix match on the text
// field first, then shorter values first) — never on raw table order.
// Meilisearch's own hits arrive in ITS relevance order (word/typo/
// proximity/attribute-based), which is a perfectly good order for SHOWING
// a handful of results but is NOT the same order SQL used to decide WHICH
// handful survives a `.slice(0, PER_SUB_LIMIT)` truncation. Confirmed live:
// for "50" (a common numeric prefix, ~400 real matches on `address`),
// Meilisearch's top-48-by-its-own-ranking still contained the old SQL
// winners (buildings on "5036-та"/"5046-та" etc, short prefix-matching
// street names) — so the headroom was fine — but a plain `.slice(0, 12)`
// on that Meilisearch order picked 12 DIFFERENT, also-valid candidates
// instead, silently dropping the ones old SQL would have shown. Re-sorting
// every sub's fuzzyAccept-filtered candidates by the SAME criteria the old
// SQL `ORDER BY` used, immediately before each `.slice(0, PER_SUB_LIMIT)`,
// makes truncation pick the same "top 12" old SQL would have — Meilisearch
// still decides WHICH candidates are correct (via fuzzyAccept), this only
// decides which ones are FIRST once there are more than fit.
// SQL `coalesce(a, b)` only falls back to `b` when `a` is literal NULL —
// an empty STRING `a` (which is what this dataset actually stores for a
// nameless building, never true NULL — confirmed against the live DB) is
// not NULL, so coalesce returns that empty string, not `b`. The old
// ADDRESS_NO_NUMBER query's `ORDER BY ... coalesce(name, addr_street)`
// relied on exactly this: a nameless building's sort key was ALWAYS ''
// (never falls back to its real addr_street), which — found only by
// diffing actual query output, not by reading the SQL — pushed a query
// like "50" to prefer whichever nameless "50"-ish buildings happen to
// have the lowest row id (an accidental, meaningless tiebreak), and for
// "витоша" incidentally let two REAL-named buildings ("Витоша Маркет",
// "Витоша Парк Хотел") outrank a wall of nameless "ул. Витоша N" addresses
// that would otherwise out-sort them on length alone. Faithfully
// reproducing this exact SQL semantic (not the more "sensible" JS `||`
// fallback used here until this fix, which resolved differently and
// silently swapped which addresses survived truncation) via `sqlCoalesce`
// below is what makes the "address" sub's truncation match old SQL
// exactly — see its own call site for where NULL vs '' actually matters.
function sqlCoalesce(a, b) {
  return a === null || a === undefined ? b : a;
}

// A tier+length tie (common for the many nameless/empty-field rows the
// `sqlCoalesce` case above produces, all sorting as '' / length 0) needs
// its own tiebreak: SQLite, given an ORDER BY that doesn't fully
// disambiguate, falls back to its own table-scan order — for a simple
// table scanned without a covering index, that's ascending `rowid`, which
// for this dataset's auto-increment `id` columns lines up with ascending
// `id` (confirmed against the live DB: baseline's actual tied winners for
// "50" are exactly ids 61-73, the LOWEST ids among every tied candidate).
// Without this, a stable JS sort would instead preserve MEILISEARCH's own
// relevance order among tied rows — a different, equally arbitrary-to-SQL
// order that picks a different 12 once there are more ties than fit.
function sortByRelevance(rows, needle, fieldOf, idOf = (r) => r.id) {
  return rows.slice().sort((a, b) => {
    const ta = String(fieldOf(a) || "").toLowerCase();
    const tb = String(fieldOf(b) || "").toLowerCase();
    const pa = ta.startsWith(needle) ? 0 : 1;
    const pb = tb.startsWith(needle) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (ta.length !== tb.length) return ta.length - tb.length;
    const ia = idOf(a);
    const ib = idOf(b);
    return typeof ia === "number" && typeof ib === "number" ? ia - ib : 0;
  });
}

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

// Relevance tier for one text field against the typed query. Plain
// substring matching (what the old SQL `contains` LIKE used, before this
// migration) treated "рпу" found anywhere inside "Корпус" (literally the
// letters after "ко-") as being just as good a hit as an actual word "РПУ"
// — reported 2026-09-06 ("корпус не отвечает запросу РПУ"): a search for
// the police-precinct abbreviation "РПУ" ranked several unrelated "Корпус
// N" (residential block) results ahead of/alongside real "РПУ" matches,
// purely because the letters happen to run together in the middle of
// "к-о-Р-П-У-с". Three tiers instead of two: 0 = the WHOLE field starts
// with the query (or equals it) — the strongest signal; 1 = some individual
// WORD inside the field starts with it (e.g. "МВР 01 РПУ-СДВР ..." has
// "РПУ" as its own token) — still a real, meaningful match, just not at the
// very front; 2 = the query only occurs as an arbitrary run of letters
// straddling word content ("корПУс" has no word starting with "рпу") —
// kept for SQL-era text that still reaches this function, but as of the
// §12 full-replacement migration nothing coming out of Meilisearch can
// land here any more (word-based engine, no substring-of-a-word matching;
// see the top-of-file comment on the accepted tier-2 trade-off) — this
// function itself is untouched, only what it's ever called with changed.
// Splitting on anything that isn't a letter/digit (`\p{L}`/`\p{N}`,
// Unicode-aware) turns "МВР 01 РПУ-СДВР" into ["мвр","01","рпу","сдвр"] —
// hyphens, quotes and dots all count as word breaks, not just spaces.
function matchTier(text, needle) {
  const t = String(text || "").toLowerCase();
  if (!needle || !t) return 2;
  if (t === needle || t.startsWith(needle)) return 0;
  const words = t.split(/[^\p{L}\p{N}]+/u);
  if (words.some((w) => w.startsWith(needle))) return 1;
  return 2;
}

// Address search needs its own two-shape query, not a single free-text
// lookup: an address query is (almost always) a street name plus a house
// number typed as one string ("Оборище 5"), and searching that whole raw
// string against a building's fields (the previous version of this query —
// bug found & fixed 2026-09-05) meant the house-number half could never
// usefully match anything (`housenumber` only ever holds something like
// "5", never "Оборище 5"). Splitting the query into a street part and a
// trailing number part before it reaches Meilisearch fixes that — the
// street part becomes the free-text query, the number part becomes an
// exact filter (see housenumberFilter below).
function splitAddressQuery(q) {
  const trimmed = q.trim();
  // Trailing token that looks like a house/block number: digits, optionally
  // with one trailing letter (common Bulgarian suffix, e.g. "5А"). No match
  // -> treat the whole thing as a street name (or building name) query.
  const m = trimmed.match(/^(.+?)[,\s]+(\d+[a-zA-Zа-яА-Я]?)$/u);
  if (m) return { streetPart: m[1].trim(), numberPart: m[2].trim() };
  return { streetPart: trimmed, numberPart: null };
}

// §12.1: Meilisearch filter equivalent of the old SQL GLOB boundary trick.
// This dataset's housenumber values are messy (ranges "50-52", combos
// "50;56"/"51,49", letter suffixes "5А"/"51Б", block labels "бл. 42"...).
// The bug reported 2026-09-06 ("дом 15 не отвечает запросу 5") happened
// because a bare substring match treats "5" as present in "15", "25",
// "505А" — anything containing the digit "5" anywhere. What actually
// distinguishes house number "5" from "15"/"50" is whether the character
// right after the matched digits is itself another digit.
//
// The old fix (houseNumberGlob, since removed) expressed that boundary with
// SQL GLOB's `[^0-9]` character class at QUERY time, against the raw stored
// string. This migration moves the same parsing to INDEX time instead
// (parseHousenumber in scripts/reindexMeilisearch.js, applied once per
// document to derive `hn_digits`/`hn_letter`), which turns the boundary
// check into a plain integer-equality filter here: "5" (digits 5, no
// letter) becomes `hn_digits = 5`, matching stored "5", "5А", "5-7", "5,12"
// (all parse to leading digits 5) but not "15" or "505А" (leading digits
// 15 / 505) — the exact same distinction, no GLOB needed. This is also
// simpler than the old code: it naturally subsumes what used to be a
// SEPARATE `housenumber = @numberExact` check (a bare "5" stored value
// parses to digits=5/letter="" too, so plain digit equality already
// catches it — no second condition needed). A query that itself carries a
// trailing letter ("5А") narrows further with an exact `hn_letter` match,
// the same disambiguation the old GLOB's `${digits}${letter}*` branch did.
function housenumberFilter(numberPart) {
  const m = numberPart.match(/^(\d+)([a-zA-Zа-яА-Я]?)$/u);
  if (!m) return null;
  const [, digits, letter] = m;
  const digitsInt = parseInt(digits, 10);
  return letter ? `hn_digits = ${digitsInt} AND hn_letter = "${letter.toLowerCase()}"` : `hn_digits = ${digitsInt}`;
}

// href on a search result -> the object's real "typical page", so the
// results list/hover-popup can offer "Открыть страницу" instead of only an
// in-panel card (2026-09-09, claude/search-results-plan.md — replaces
// "Подробнее"). Every branch here reuses the SAME lookup the static page
// section already built for itself (streetsDirectory/rubricsDirectory/
// areasDirectory/stopsDirectory/routesDirectory) rather than re-deriving a
// slug — a mismatch there would silently 404. `null` (not a guess) when no
// matching directory entry exists yet.
// 2026-09-14 (fourth wave, "Проблема A" — claude/search-results-plan.md
// §8.1/§9): this lookup already tells us everything `addressHref` used —
// including, on `found.house`, the SAME `variantOf` that
// `getHousesForEntry(...).filter(h => !h.variantOf)` already uses to keep a
// street's "Связанные объекты" preview free of duplicate-import rows
// (housenumberProvenance.js). `addressHref` only ever read `found.href`
// and threw the rest away, so a building imported twice (once from
// `address_sofia`, once from `nsi_sofiaplan`, say) surfaced as two separate
// top-level `address` results with different ids — a real, confirmed bug
// (found live: "ул. Витоша 10" as both id 821 and id 390). Returning the
// whole `found` object lets `toResult()` below carry `variantOf` forward so
// the postprocessing step can drop the duplicate, the same way the street
// preview already does — not a second, differently-shaped fix.
function addressLookup(row) {
  if (!row.addr_street) return null;
  return streetsDirectory.findHouseByBuildingId(row.addr_street, row.id);
}
function districtHref(row) {
  const entry = areasDirectory.getAll("districts").find((d) => d.id === row.id);
  return entry ? `/districts/${entry.slug}.html` : null;
}
function settlementHref(row) {
  const entry = areasDirectory.getAll("settlements").find((s) => s.id === row.id);
  return entry ? `/settlements/${entry.slug}.html` : null;
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

router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const type = String(req.query.type || "all");
  if (q.length < 2) return res.json({ items: [], meta: { total: 0, has_more: false } });

  const subGroups = FILTER_GROUPS[type] || FILTER_GROUPS.all;
  const needle = q.trim().toLowerCase();
  const items = [];
  const { streetPart, numberPart } = splitAddressQuery(q);
  const hnFilter = numberPart ? housenumberFilter(numberPart) : null;

  // ---- Every Meilisearch lookup this request needs, all fired together ---
  // (§11.6/§12 sandbox spike finding, carried forward unchanged: awaiting
  // these one sub at a time measured ~550ms/request on the real sofia.db —
  // ~45ms of this JS client's own per-call overhead x N subs, even though
  // Meilisearch itself answers in ~2ms, because nothing overlaps. One
  // Promise.all across every sub brought that back down to a few ms of
  // overhead total.) This is now simpler than the additive design's
  // three-phase split — there's no SQL phase to sequence around any more,
  // just this one batch, then building results from it.
  const subTasks = subGroups.map((sub) => {
    if (sub === "address") {
      return numberPart && hnFilter
        ? meiliSearchSub("address", streetPart, {
            filter: hnFilter,
            gate: streetPart,
            // Only `addr_street` gated the old SQL numbered-address query
            // (housenumber matching was handled entirely by the filter,
            // never by fuzzy-matching a building's own `name`) — keep that
            // exact scope rather than widening it now that both fields are
            // technically available.
            fields: (hit) => [hit.addr_street],
            limit: PER_SUB_LIMIT * 2,
          }).then((hits) => ["address", hits])
        : meiliSearchSub("address", q).then((hits) => ["address", hits]);
    }
    return meiliSearchSub(sub, q).then((hits) => [sub, hits]);
  });
  const resultsBySub = {};
  for (const [sub, hits] of await Promise.all(subTasks)) resultsBySub[sub] = hits;

  // ---- Build result items from the Meilisearch candidates ----------------
  // Everything from here down is unchanged from before the §12 pivot: same
  // matchTier/_tier assignment, same street-clustering/leader-namesakes
  // logic, same PER_SUB_LIMIT cap — only where the candidates upstream of
  // this loop came from has changed.
  for (const sub of subGroups) {
    if (sub === "address") {
      const hits = resultsBySub.address || [];
      // Old SQL ORDER BY, reproduced client-side since a Meilisearch filter
      // query has no equivalent "ORDER BY" of its own to lean on here:
      // exact housenumber match first, then shorter (usually plainer)
      // stored values first — e.g. "5" before "5-7" before "50-52" when all
      // three parsed to the same hn_digits.
      const rows = numberPart
        ? hits
            .slice()
            .sort((a, b) => {
              const aExact = a.housenumber === numberPart ? 0 : 1;
              const bExact = b.housenumber === numberPart ? 0 : 1;
              if (aExact !== bExact) return aExact - bExact;
              return String(a.housenumber || "").length - String(b.housenumber || "").length;
            })
            .slice(0, PER_SUB_LIMIT)
        // No number typed: same relevance-before-truncation fix as every
        // other sub below — old SQL's `orderClause("coalesce(name,
        // addr_street)")` (prefix match first, then shorter first) decided
        // which rows survived LIMIT, not Meilisearch's own ranking.
        // `sqlCoalesce`, not `r.name || r.addr_street` — see that function's
        // comment: the old SQL's `coalesce(name, addr_street)` never
        // actually fell back to addr_street for this dataset's nameless
        // buildings (name is stored as '', not NULL), and reproducing that
        // exactly is what makes truncation pick the same rows old SQL did.
        : sortByRelevance(hits, needle, (r) => sqlCoalesce(r.name, r.addr_street)).slice(0, PER_SUB_LIMIT);
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
      // The "street" index holds one document per distinct name (see
      // reindexMeilisearch.js) so hits are already name-deduplicated.
      // Sorted by the old `orderClause("name")` criteria BEFORE truncating
      // — same fix as every other sub, applied here to the raw hits (not
      // the plain name strings) so the sort still has the full row to look
      // at.
      const names = sortByRelevance(resultsBySub.street || [], needle, (r) => r.name)
        .map((r) => r.name)
        .slice(0, PER_SUB_LIMIT);
      for (const name of names) {
        // 2026-09-14 (§12.5 perf fix): every real street name's clusters —
        // segments grouped into physically distinct streets, district
        // label already resolved AND deduped, slug already assigned — were
        // already sitting in memory in streetsDirectory (built once at
        // server startup specifically so this kind of lookup doesn't need
        // to be redone per request — see that module's own top comment).
        // This used to re-derive all of that from scratch on every single
        // search (STREET_SEGMENTS_BY_NAME query + clusterStreetSegments +
        // representativePoint + nearestDistrict + dedupeLabels), measured
        // adding ~180-210ms to any search whose matched names have several
        // segments/clusters (e.g. "Витоша", ~10 real streets) — an entirely
        // avoidable cost once the already-built directory is reused
        // directly instead of duplicating its work.
        const dirEntries = streetsDirectory.getEntriesByName(name);
        if (!dirEntries.length) continue;
        // Deterministic representative per cluster: lowest osm_id (already
        // the order streetsDirectory built `dirEntries` in), so repeated
        // searches/reloads always pick the same segment (matters for
        // object.js's follow-up lookup by that id).
        const entries = dirEntries.map((dirEntry) => ({
          dirEntry,
          point: streetsDirectory.getClusterGeometry(dirEntry).repPoint,
          subtitle: dirEntry.district ? `${LABELS.street} · ${dirEntry.district}` : LABELS.street,
        }));

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
                  houseCount: streetsDirectory.getHousesForEntry(e.dirEntry).filter((h) => !h.variantOf).length,
                }))
                .sort((a, b) => b.houseCount - a.houseCount || entries[a.i].dirEntry.id - entries[b.i].dirEntry.id)[0].i;

        const leader = entries[leaderIndex];
        const namesakeEntries = entries.length > 1 ? entries.filter((_, i) => i !== leaderIndex) : [];
        items.push({
          id: leader.dirEntry.id, type: "street", name: withDesignation(leader.dirEntry.name), subtitle: leader.subtitle,
          lat: leader.point ? leader.point[1] : null, lng: leader.point ? leader.point[0] : null,
          map_key: `street:${leader.dirEntry.id}`,
          href: `/streets/${leader.dirEntry.slug}.html`,
          _tier: matchTier(leader.dirEntry.name, needle),
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
                  const houses = streetsDirectory.getHousesForEntry(other.dirEntry).filter((h) => !h.variantOf);
                  const shown = houses.slice(0, RELATED_LIMIT);
                  return {
                    id: other.dirEntry.id, type: "street", name: withDesignation(other.dirEntry.name), subtitle: other.subtitle,
                    lat: other.point ? other.point[1] : null, lng: other.point ? other.point[0] : null,
                    href: `/streets/${other.dirEntry.slug}.html`,
                    related: shown.map((h) => ({
                      id: h.id, type: "address", name: h.displayName, subtitle: "Дом",
                      href: `/streets/${other.dirEntry.slug}/dom-${h.slug}.html`,
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
    if (!MEILI_INDEXED_SUBS.has(sub)) continue;
    // Same relevance-before-truncation fix as address/street above, with
    // each sub's OLD SQL sort criteria reproduced: "rubric" used to order
    // by `cnt DESC` (organization count), not text relevance at all; every
    // other sub here used `orderClause("name")` (prefix match on `name`
    // first, then shorter `name` first — even metro_route/route, whose
    // MATCH also checks `ref`, sorted on `name` alone). "route" itself
    // never had an ORDER BY in the old code (a plain UNION ALL ... LIMIT,
    // truncated in whatever order SQLite's table scan happened to produce)
    // — nothing meaningful to reproduce there, so it's left in
    // Meilisearch's own relevance order; a different arbitrary-by-the-old-
    // spec 12 surviving truncation isn't a regression the way it would be
    // for a sub the old code actually sorted.
    const candidates = resultsBySub[sub] || [];
    const sorted =
      sub === "rubric"
        ? candidates.slice().sort((a, b) => (b.cnt || 0) - (a.cnt || 0))
        : sub === "route"
        ? candidates
        : sortByRelevance(candidates, needle, (r) => r.name);
    const rows = sorted.slice(0, PER_SUB_LIMIT);
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
  // relative order is preserved rather than reshuffled.
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
  for (const item of items) delete item._tier;

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
  const relatedHouseIds = new Set();
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
    for (const h of shown) relatedHouseIds.add(h.id);
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
    for (const c of shown) rubricRelatedCompanyIds.add(c.id);
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
  // on top of it). `bubbleItems` is already in the sort's own order, so
  // this doesn't reshuffle street vs rubric relative to each other either.
  if (bubbleItems.length) {
    const bubbleSet = new Set(bubbleItems);
    finalItems = [...bubbleItems, ...finalItems.filter((item) => !bubbleSet.has(item))];
  }

  res.json({ items: finalItems, meta: { total: finalItems.length, has_more: false } });
});

// 2026-09-14 (§14): forces every Meilisearch (group) index open (see
// meiliSearchSub's retry comment above, and reindexMeilisearch.js's
// top-of-file comment, for why this matters on the real Windows machine) —
// called once from index.js, after reindex and before app.listen, so the
// one-time "first open" cost/flakiness is absorbed at startup rather than by
// whichever live search request happens to land on a given index first.
// Sequential on purpose, not Promise.all: even though 3 groups is
// comfortably under Windows' own ~4-6-open-indexes budget (the whole reason
// there are only 3 now, not 12), opening them one at a time leaves the
// largest possible margin against that budget during the one moment
// (startup) where it's cheap to be extra conservative. A throwaway
// single-character query is enough to force the open; failures are logged
// but don't stop startup — meiliSearchSub's own retry is still there as a
// safety net for anything this doesn't catch.
// 2026-09-14 (§14 follow-up, real-machine finding): the first version of
// this warm-up ran ONE unfiltered "a" query per GROUP (3 total) — that
// forces the group's index open, but every real search here always adds a
// `sub = "<sub>"` filter (meiliSearchOnce, above), and on Windows a filter
// touches a SEPARATE on-disk structure (the filterable-attributes database)
// from the one an unfiltered query touches. Right after a fresh reindex
// that structure is just-written and cold — confirmed live: startup's own
// unfiltered warm-up reported ~220ms, yet the very FIRST real user search
// after that same restart still took ~7s, while every search after it was
// back to ~150-250ms (i.e. exactly a one-time "someone has to pay the cold
// page-in cost" pattern, not a sustained slowdown). Fix: warm up every SUB
// individually with the SAME filter shape a real search uses — this pays
// that one-time cost at startup instead of on a live user's first query.
// Sequential on purpose (see below) — 12 throwaway single-character
// filtered queries add a modest amount of startup time in exchange for a
// consistently fast first real search.
router.warmUpMeiliIndexes = async function warmUpMeiliIndexes() {
  for (const sub of Object.keys(GROUP_OF)) {
    try {
      await meiliSearchOnce(sub, "a", { limit: 1 });
    } catch (err) {
      console.warn(`[startup] Meilisearch warm-up for "${sub}" failed (non-fatal): ${err.message}`);
    }
  }
  // `address` also gets a numbered-address-shaped search (its own extra
  // `hn_digits`/`hn_letter` filterable attributes, only ever touched by the
  // house-number path, otherwise never warmed by the loop above).
  try {
    await meiliSearchOnce("address", "a", { filter: "hn_digits = 1", limit: 1 });
  } catch (err) {
    console.warn(`[startup] Meilisearch warm-up for "address" (hn filter) failed (non-fatal): ${err.message}`);
  }
};

module.exports = router;
