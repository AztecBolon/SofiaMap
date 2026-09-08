// Normalizes the "street type" word/abbreviation Bulgarian street names
// carry as their own leading prefix — "ул." (street), "бул." (boulevard),
// "пл." (square), "алея" (alley) — for DISPLAY and for ALPHABETIZATION.
//
// Why this exists: raw OSM `name` values are the mapper's own free-typed
// text, so the exact same designator shows up in several different
// spellings/casings across the dataset — found by direct inspection
// (2026-09-06, user report "не должно быть Алея и алея"):
//   ул.:   "ул. Дунав" (8), "Ул. Клокотница" (4), "Улица Анемоне" (1 — the
//          full word instead of the abbreviation)
//   пл.:   "пл. Йоан Павел II" (9)... "Пл. ..." (1), "Площад Предгаров" /
//          "Площад на Толерантността" (2, full word)
//   алея:  "алея Ален мак" (11), "Алея Академия" (8) — split almost evenly,
//          no dominant casing to defer to
//   бул.:  already 100% consistent ("бул.", 88/88) — left as a sanity
//          check in the table below, not because it needed fixing
// This is deliberately anchored (`^`) so it only ever matches when the
// designator is a genuine leading PREFIX before the actual street name —
// exactly the "ул. X" / "бул. X" pattern. Names where the same word is the
// tail of an otherwise complete, different name — "Горна алея" (lit.
// "Upper Alley" — a complete name in its own right, not "[type] +
// [name]"), "Панорамна алея "Галунка" ..." — do NOT match and are passed
// through completely untouched: rewriting those into "алея Горна" would
// invent an address that doesn't exist, not just reformat one.
//
// Order matters: check the full-word forms ("улица", "площад") before the
// abbreviations they'd otherwise also match a prefix of.
const RULES = [
  { re: /^(булевард|бул\.?)\s+/i, canonical: "бул." },
  { re: /^(площад|пл\.?)\s+/i, canonical: "пл." },
  { re: /^(улица|ул\.?)\s+/i, canonical: "ул." },
  // "алея" is a whole word in Bulgarian, never abbreviated — canonicalized
  // to lowercase to match how the OTHER designators above already read
  // (lowercase, unlike a sentence-starting proper name) rather than to
  // whichever casing happens to be more common in this one dataset.
  { re: /^алея\s+/i, canonical: "алея" },
];

// { designation, rest, displayName } — `rest` is the name with the
// designator (and the single space after it) stripped, used as the
// alphabetization/grouping key so "бул. Симеоновско шосе" files under
// "С" (task requirement — sort by the STREET name, not by the type word).
// `displayName` re-assembles the name with the designator's casing fixed;
// everything else in the original string (the actual name part) is left
// exactly as-is.
//
// No-designator case (2026-09-06, user follow-up — "давай добавим префикс
// ул для всех улиц, где нет другого и закроем этот вопрос"): the earlier
// version of this function left `displayName === name` untouched here,
// on the grounds that plain Bulgarian street names legitimately carry no
// word at all in the source data (see file header — this is real, not a
// gap). That's still true of the STORED data (`streets.name`/
// `buildings.addr_street` are deliberately never rewritten — see
// `rest`/slug comments below and street-name-collisions.md for why:
// slugs and every SQL join are keyed off the untouched raw name, and
// mutating it in place would silently reshuffle existing street URLs and
// break every `addr_street = name`-style match in orgMatch.js/
// streetsDirectory.js/schoolsDirectory.js). What changed is what the user
// actually asked to fix — pages showing some addresses as "Дунав 5" and
// others as "бул. Витоша 1" side by side reads as inconsistent/half-done,
// even though the underlying data is correct either way. So `displayName`
// now ALWAYS carries a designator — the real one when the name has one,
// "ул." (the implicit Bulgarian default for an ordinary street) when it
// doesn't — while `designation` itself stays `null` for this case exactly
// as before: `classifyType()`'s бул./пл./алея bucket lookup and
// `sortKey`'s "strip only when there really was a designator to strip"
// logic both key off `designation`, and defaulting it to "ул." would
// silently change their behavior along with the display text. Only the
// text shown to the user changes here.
function splitDesignation(name) {
  const trimmed = String(name || "").trim();
  for (const { re, canonical } of RULES) {
    const m = trimmed.match(re);
    if (m) {
      const rest = trimmed.slice(m[0].length).trim();
      return { designation: canonical, rest, displayName: rest ? `${canonical} ${rest}` : canonical };
    }
  }
  return { designation: null, rest: trimmed, displayName: trimmed ? `ул. ${trimmed}` : trimmed };
}

// Convenience wrapper for the many call sites that only ever want the
// display text for a raw street/address name (search subtitles, map
// hit-test popups, organization/company address lines) and have no use
// for `designation`/`rest` — `""`/`null`/`undefined` pass through
// unchanged rather than becoming the string "ул. ".
function withDesignation(name) {
  return name ? splitDesignation(name).displayName : name;
}

module.exports = { splitDesignation, withDesignation };
