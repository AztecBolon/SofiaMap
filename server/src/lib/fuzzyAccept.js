// Gate for accepting a Meilisearch-only candidate (one the existing plain
// SQL LIKE query in search.js did NOT already find) into the result set.
//
// Why this exists (sandbox spike finding, claude/search-results-plan.md
// §11.4): Meilisearch's own relevance score is NOT a reliable signal for
// this. Empirically, on the real sofia.db, searching the exact acronym
// "рпу" (the query this project's whole matchTier() tiering system was
// built to handle correctly — see search.js's own comment) returns genuine
// "РПУ" hits at rankingScore 0.879, but ALSO returns completely unrelated
// names ("Рувекс", "Русчук", "РУ", "Румик"...) at rankingScore 0.462 —
// i.e. real matches and noise are both "high-ish", nowhere near a clean
// cutoff. Meanwhile a genuinely correct typo-correction ("обориште" — a
// deliberate typo of "оборище" — finding the real street "Оборище") scores
// only 0.308: LOWER than the noise above. Ranking score alone cannot tell
// a real correction from noise here.
//
// So this project's own explicit, testable rule takes over: compute real
// Levenshtein distance between the typed needle and the best-matching
// PREFIX of each word in the candidate's text, and only accept the
// candidate if that distance is within Meilisearch's own stated
// minWordSizeForTypos thresholds (kept identical on purpose — no reason to
// invent different numbers): under 5 chars, 0 (exact only — matches
// Meilisearch's own "too short to risk typos" judgment, and happens to
// reject "рпу"->"рувекс" outright since edit distance there is 2 anyway);
// 5-8 chars, at most 1 typo; 9+ chars, at most 2. This is intentionally
// NOT "trust the engine's ranking" — it's "use the engine only to fetch a
// short candidate list fast, then verify the correction ourselves with a
// rule we can read, test, and defend against a stored regression file."
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

function typoThreshold(len) {
  if (len >= 9) return 2;
  if (len >= 5) return 1;
  return 0;
}

// Unicode-aware word split, same regex as search.js's own matchTier().
function words(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Does ONE needle word (e.g. "оборище", or "5") fuzzy-match some word in the
// candidate text?
function oneWordMatches(needleWord, textWords) {
  const threshold = typoThreshold(needleWord.length);
  for (const w of textWords) {
    // Compare against the word's own prefix of (roughly) the needle word's
    // length, not the whole word — this is a PREFIX-search correction
    // ("витош" typed so far should still find "Витошка ..."), not a
    // whole-word fuzzy match, mirroring how the rest of this file's tier 0/1
    // already only ever cared about prefixes, never whole-word equality.
    const prefixLen = Math.min(w.length, needleWord.length + threshold);
    const candidate = w.slice(0, prefixLen);
    if (levenshtein(needleWord, candidate) <= threshold) return true;
  }
  return false;
}

// `needle` can be multi-word ("Оборище 5" — search.js always passes the
// full, untouched typed query, same as matchTier does). Checking the WHOLE
// needle string's edit distance against a single candidate word is wrong —
// found in the sandbox spike: "оборище 5" vs the single word "оборище" came
// out as edit distance 2 (delete " 5"), which cleared the length-10
// threshold (2) and wrongly pulled the plain street "Оборище" back into a
// query that was actually asking for house number 5 on it specifically.
// Every needle WORD has to independently find its own close match among the
// text's words (AND, not "close enough as one blob") — for "5" that means
// threshold 0 (see typoThreshold), which "Оборище" alone can never satisfy,
// so the false positive above is gone.
function fuzzyAccept(needle, text) {
  const needleWords = words(needle);
  if (!needleWords.length) return false;
  const textWords = words(text);
  if (!textWords.length) return false;
  return needleWords.every((nw) => oneWordMatches(nw, textWords));
}

module.exports = { fuzzyAccept, levenshtein, typoThreshold };
