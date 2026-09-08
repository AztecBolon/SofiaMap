// Transliteration + slugging shared by every branch of the new static
// directory section (/streets/, /rubrics/, /routes/, /stops/, /districts/,
// /settlements/) — one function so a URL built for a street looks the same
// "shape" as one built for an organization or a bus stop.
//
// Decision (documented per the task's requirement #1): this data is
// Bulgarian (Sofia), not Russian, even though the moscowmap.ru reference
// site we copied the page *structure* from is Russian. So this uses the
// OFFICIAL Bulgarian transliteration table (Закон за транслитерацията,
// obn. ДВ бр.19/2009 г. — the same "streamlined" system Bulgaria uses on
// road signs and in passports), not the Russian GOST/BGN scheme the
// reference's own URLs (`abelmanovskaya-ulitsa`, `ulitsa-abakumova-egora`)
// happen to use. Notably this means х→h (not "kh") and щ→sht (not "shcht"
// or "shch"), which is why Sofia street slugs look a little different from
// the Moscow reference's own — that's intentional, not a bug.
const translitMap = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s",
  т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht",
  ъ: "a", ь: "y", ю: "yu", я: "ya",
  // A handful of names in this dataset are Russian/other-Cyrillic rather
  // than Bulgarian proper (import artifacts) — cover the two letters
  // Bulgarian's own alphabet doesn't have so they don't just vanish.
  ё: "yo", ы: "y", э: "e",
};

function transliterate(str) {
  let out = "";
  for (const ch of String(str)) {
    const lower = ch.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(translitMap, lower)) {
      out += translitMap[lower];
    } else {
      out += ch;
    }
  }
  return out;
}

// Plain text -> URL-safe slug: transliterate Cyrillic, lowercase, collapse
// anything that isn't [a-z0-9] into a single "-", trim edge dashes.
function slugify(text) {
  const translited = transliterate(String(text || ""));
  return translited
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Collision-safe slug assignment (task requirement #1: "проверить на
// коллизии ... и решить, как разруливать"). Two different names can
// perfectly well transliterate to the same slug (e.g. two organizations
// both literally named "Аптека", or — per street-name-collisions.md — two
// *different, unrelated* physical streets that happen to share a name and
// therefore a slug too). Rule: first caller to claim a base slug (in
// whatever order the caller iterates — callers pass rows in a stable,
// deterministic DB order, usually `ORDER BY id`, so re-running this stays
// stable across restarts) gets it bare; every later collision gets a
// deterministic `-2`, `-3`, ... suffix appended. This is the same "honest
// disambiguation, not fake precision" approach streetCluster.js's
// `dedupeLabels` already uses for colliding district labels.
function createSlugAssigner() {
  const counts = new Map();
  return function assign(text, fallback) {
    let base = slugify(text);
    if (!base) base = slugify(fallback) || "obekt";
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

module.exports = { transliterate, slugify, createSlugAssigner };
