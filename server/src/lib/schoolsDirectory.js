// «Прилежащо училище» (assigned school) block — house-page-template.md
// §13.10/§13.11/§18. Source: Sofia open-data portal's "Адреси и прилежащи
// училища СО" register (106,630 rows), user-supplied 2026-09-06 as
// addresses-and-associated-schools.xlsx, preprocessed with Python/openpyxl
// into data/external/school_assignments.json — {schools: {id: name},
// entries: [[prefix, streetNameUpper, housenumberNormalized, [schoolId,...]]]}.
//
// Scope limitation (deliberate, documented): the preprocessing kept only
// the ул./бул./пл.-addressed rows (~90,562 of 106,629) — the rest use a
// "Ж.К." (housing-estate) or "КВ."/МЕСТНОСТ/... addressing scheme that
// doesn't correspond to a street+housenumber pair at all, and this page
// has no way to look those up against our own building data. A house
// whose real address is one of those simply won't get a schools block —
// same "don't fabricate, don't guess" rule as everywhere else on this
// page, not a bug.
//
// Matching problem and fix (2026-09-06): a naive match of the dataset's
// (already ул./бул.-prefixed) street names against our own `streets`/
// `buildings.addr_street` values got only ~1-4% hits. Root cause: almost
// all of OUR OWN street names in OSM are stored WITHOUT a "ул."/"бул."
// prefix at all (`addr_street` "Дунав", not "ул. Дунав" — confirmed only
// ~102 of our 4,815 distinct street names carry one), so stripping the
// dataset's prefix and comparing bare names is what actually works —
// jumped to 60% of distinct street names in common. A second pass
// expanding common Bulgarian title abbreviations the two sources spell
// differently (Ген./Генерал, Св./Свети, Акад./Академик, Проф./Професор,
// Д-р/Доктор, Инж./Инженер, Полк./Полковник) plus dropping parenthetical
// alt-names ("Михай Еминеску (Ситняково)") raised that to 90.8% of
// distinct street names, 70.0% of all (street,housenumber) building pairs
// citywide (75.6% excluding "бл. N" block-numbered addresses, which are
// exactly the Ж.К.-scheme addresses this dataset doesn't cover per the
// scope limitation above — see house-page-template.md §18 for the full
// calibration). The residual ~9% of street names genuinely don't appear
// in our OSM extraction (obscure outlying-village streets, a few
// truncated names in the source spreadsheet) or vice versa.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(__dirname, "..", "..", "..", "data");
const DATA_PATH = path.join(DATA_DIR, "external", "school_assignments.json");

const ABBREV = [
  [/Д-Р\.?/g, "ДОКТОР"],
  [/ИНЖ\.\s*/g, "ИНЖЕНЕР "],
  [/ПОЛК\.\s*/g, "ПОЛКОВНИК "],
  [/ГЕН\.\s*/g, "ГЕНЕРАЛ "],
  [/АКАД\.\s*/g, "АКАДЕМИК "],
  [/ПРОФ\.\s*/g, "ПРОФЕСОР "],
  [/СВ\.\s*/g, "СВЕТИ "],
];

function normStreet(s) {
  let n = String(s || "").toUpperCase()
    .replace(/^(УЛ|БУЛ|ПЛ|АЛЕЯ)\.?\s+/, "")
    .replace(/\([^)]*\)/g, " ");
  for (const [re, rep] of ABBREV) n = n.replace(re, rep);
  return n.replace(/[.,\-]/g, " ").replace(/\s+/g, " ").trim();
}

function normHn(hn) {
  if (hn == null) return null;
  const m = String(hn).trim().toUpperCase().match(/^0*(\d+)\s*([A-ZА-Я]?)/);
  if (!m) return null;
  return m[1] + (m[2] || "");
}

let cache = null;
function load() {
  if (cache) return cache;
  let schools = {};
  const lookup = new Map();
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const data = JSON.parse(raw);
    schools = data.schools || {};
    for (const [, name, hn, ids] of data.entries || []) {
      const key = normStreet(name);
      if (!lookup.has(key)) lookup.set(key, new Map());
      lookup.get(key).set(normHn(hn), ids);
    }
  } catch (e) {
    console.error(`[schoolsDirectory] could not load ${DATA_PATH}:`, e.message);
  }
  cache = { schools, lookup };
  return cache;
}

// Returns null (no match — either the scope limitation above, or a
// genuine gap) or { schools: [name,...], ambiguous } — `ambiguous: true`
// when more than one school id is on record for this exact
// (street,housenumber) pair (~5.6% of matched addresses: usually a
// multi-entrance building whose entrances the source register split
// across different school zones) — the caller shows every name rather
// than guessing which entrance the house actually is.
function findSchoolsForHouse(house) {
  if (!house || !house.addr_street || !house.housenumber) return null;
  const { schools, lookup } = load();
  const streetMap = lookup.get(normStreet(house.addr_street));
  if (!streetMap) return null;
  const ids = streetMap.get(normHn(house.housenumber));
  if (!ids || !ids.length) return null;
  const names = ids.map((id) => schools[id]).filter(Boolean);
  if (!names.length) return null;
  return { schools: names, ambiguous: names.length > 1 };
}

module.exports = { findSchoolsForHouse };
