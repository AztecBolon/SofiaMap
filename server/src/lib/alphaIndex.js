// Generic "alphabetical hub -> letter -> (subgroup) -> item" index builder,
// shared by /streets/ (4 814 names / 6 162 real street clusters) and
// /stops/bus_stop/ (2 652 stops) — the two branches large enough that a
// flat single-page list would be unusable. Modeled on the moscowmap.ru
// reference's "Аб–Ав" / "Аг–Ак" letter-subgroup pattern, but generated
// dynamically from whatever names are actually in the data rather than a
// fixed dictionary, since Sofia's street/stop names don't match a
// pre-built Russian alphabetical breakdown.
const { transliterate, createSlugAssigner } = require("./slugify");

const CYRILLIC_RE = /[А-яЁё]/; // А-я + Ё/ё

// First grouping character for one name: its own first letter, uppercased,
// if that letter is Cyrillic — otherwise every non-Cyrillic-starting name
// (digits, Latin, punctuation) is bucketed together under a single "0-9"
// pseudo-letter. (Seen in the data: mostly numeral names like "626-та", a
// handful of stray Latin-lettered ones — not worth their own 26 empty
// Latin-letter pages for four total entries.)
function firstLetterOf(name) {
  const trimmed = String(name || "").trim();
  const ch = trimmed[0] || "";
  return CYRILLIC_RE.test(ch) ? ch.toUpperCase() : "0-9";
}

function letterSlug(letter) {
  return letter === "0-9" ? "0-9" : transliterate(letter.toLowerCase());
}

// Splits a sorted list of {name, ...} entries into readable "Аб–Ав"-style
// subgroups once a letter has more than `splitThreshold` entries. Bucketing
// by 2-character prefix first (so a subgroup boundary never falls in the
// middle of otherwise-identical name beginnings), then greedily merging
// consecutive prefix buckets until each subgroup holds roughly
// `targetSize` entries — the same idea as the reference's fixed groupings,
// just computed on the fly instead of hand-curated per city.
function buildSubgroups(entries, { targetSize = 25 } = {}) {
  const buckets = new Map(); // 2-char prefix -> entries[]
  for (const e of entries) {
    const name = e.sortKey || e.name;
    const prefix = name.slice(0, 2).toUpperCase() || name.toUpperCase();
    if (!buckets.has(prefix)) buckets.set(prefix, []);
    buckets.get(prefix).push(e);
  }
  const prefixes = [...buckets.keys()].sort((a, b) => a.localeCompare(b, "bg"));

  const groups = [];
  let current = { prefixes: [], entries: [] };
  for (const prefix of prefixes) {
    current.prefixes.push(prefix);
    current.entries.push(...buckets.get(prefix));
    if (current.entries.length >= targetSize) {
      groups.push(current);
      current = { prefixes: [], entries: [] };
    }
  }
  if (current.entries.length) {
    // A too-small trailing remainder reads as an odd, near-empty page —
    // fold it into the previous group instead (matches the "never a
    // 1-2 item subgroup" feel of the reference's own groupings).
    const MIN_TRAILING = 8;
    if (groups.length && current.entries.length < MIN_TRAILING) {
      const prev = groups[groups.length - 1];
      prev.prefixes.push(...current.prefixes);
      prev.entries.push(...current.entries);
    } else {
      groups.push(current);
    }
  }

  return groups.map((g) => {
    const from = g.prefixes[0];
    const to = g.prefixes[g.prefixes.length - 1];
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    const label = from === to ? cap(from) : `${cap(from)}–${cap(to)}`;
    const slug = `${transliterate(from.toLowerCase())}-${transliterate(to.toLowerCase())}`;
    return { label, slug, entries: g.entries };
  });
}

// Builds the full letter index for a set of named entries.
// `entries`: array of { name, sortKey?, ...anything }. `sortKey` lets a
// caller sort/group on something other than the display name (unused here
// today, kept for a future case where display name and sort name differ).
// `splitThreshold`: letters with more entries than this get subdivided via
// buildSubgroups; smaller letters are left as one flat page.
function buildAlphaIndex(entries, { splitThreshold = 80, targetSubgroupSize = 25 } = {}) {
  const byLetter = new Map();
  for (const e of entries) {
    const letter = firstLetterOf(e.sortKey || e.name);
    if (!byLetter.has(letter)) byLetter.set(letter, []);
    byLetter.get(letter).push(e);
  }

  const collator = (a, b) => (a.sortKey || a.name).localeCompare(b.sortKey || b.name, "bg");

  const letters = [...byLetter.keys()].sort((a, b) => {
    if (a === "0-9") return -1;
    if (b === "0-9") return 1;
    return a.localeCompare(b, "bg");
  });

  // Bulgarian's Ъ transliterates to the same "a" as А (see slugify.js's
  // table — that's correct, official transliteration, not a bug: ъ really
  // does romanize as "a"). Left alone that's a real slug collision between
  // two different letter pages. Resolved the same way any other
  // transliteration collision in this codebase is (createSlugAssigner):
  // whichever letter sorts first keeps the bare slug, the other gets a
  // deterministic "-2" — checked here explicitly because, unlike names,
  // there are only ~30 letters, so this collision is guaranteed to recur
  // for every single Bulgarian dataset this code ever runs on again.
  const assignLetterSlug = createSlugAssigner();
  const letterSlugOf = new Map(letters.map((l) => [l, assignLetterSlug(letterSlug(l))]));

  // Subgroups nest UNDER their letter (/streets/<letter>/<subgroup>/)
  // rather than living flat at the top level like the moscowmap
  // reference's own /streets/ab-av/ — a deliberate deviation: nesting
  // makes a subgroup's slug only need to be unique WITHIN its own letter,
  // not site-wide, so two different letters can never collide on a
  // subgroup slug no matter how their own 2-char boundaries transliterate.
  const letterPages = new Map(); // letterSlug -> { letter, slug, count, subgroups: [] | null, entries: [] | null }
  const subgroupPages = new Map(); // "letterSlug/subgroupSlug" -> { label, letter, letterSlug, slug, count, entries }

  for (const letter of letters) {
    const list = byLetter.get(letter).slice().sort(collator);
    const lSlug = letterSlugOf.get(letter);
    if (list.length > splitThreshold) {
      const subgroups = buildSubgroups(list, { targetSize: targetSubgroupSize });
      letterPages.set(lSlug, { letter, slug: lSlug, count: list.length, subgroups, entries: null });
      subgroups.forEach((sg, i) => {
        const key = `${lSlug}/${sg.slug}`;
        subgroupPages.set(key, {
          label: sg.label, letter, letterSlug: lSlug, slug: sg.slug, key,
          count: sg.entries.length, entries: sg.entries,
          prevSlug: i > 0 ? subgroups[i - 1].slug : null,
          prevLabel: i > 0 ? subgroups[i - 1].label : null,
          nextSlug: i < subgroups.length - 1 ? subgroups[i + 1].slug : null,
          nextLabel: i < subgroups.length - 1 ? subgroups[i + 1].label : null,
        });
      });
    } else {
      letterPages.set(lSlug, { letter, slug: lSlug, count: list.length, subgroups: null, entries: list });
    }
  }

  const summary = letters.map((letter) => ({
    letter, slug: letterSlugOf.get(letter), count: byLetter.get(letter).length,
  }));

  return { summary, letterPages, subgroupPages, total: entries.length };
}

module.exports = { buildAlphaIndex, firstLetterOf, letterSlug };
