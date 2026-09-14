// housenumberProvenance.js (2026-09-09 fix — duplicate "Дома" entries)
//
// Reported live: a street's house list showed the same civic number two or
// three times in a row (e.g. "ул. Жамбилица 1" ×3, "10" ×3, "7"/"2"/"13" ×2).
// Checked directly against the database: these are not corrupt/garbage rows
// with identical coordinates — each duplicate is a REAL, separately-drawn
// building footprint a few metres apart, carrying the same civic number, and
// each one traces back to a different upstream import (`housenumber_src`:
// `address_sofia`, `nsi_sofiaplan`, a plain OSM `tag`, or a standalone
// `address_point`). In other words: the same physical building/address got
// digitized more than once by different data sources that were never merged
// into a single OSM way — an OpenStreetMap/data-import artifact, not a sign
// that Sofia actually has three unrelated houses numbered "1" on one street.
//
// Per the project owner's decision (2026-09-09): never silently drop or
// merge these rows (each is still a real geometry, still worth keeping on
// the map and individually reachable) — instead pick ONE as the address's
// main entry on the street list, chosen by how directly its source names a
// real address (an explicit address-registry import outranks a bare OSM
// tag), and show an honest note linking to the other variant(s) with where
// each one came from. Same "explain the quirk, don't hide it" approach this
// project already uses for postcode provenance (see postcodeProvenance.js)
// and same-named streets (see streetsDirectory.js's `namesakes`).
const HOUSENUMBER_SOURCES = {
  address_point: {
    id: "address_point",
    label: "отдельная адресная точка (address_point)",
    org: "OpenStreetMap",
    detail: "Отдельно нанесённая адресная точка (не контур самого здания), добавленная отдельным импортом адресных точек.",
  },
  address_sofia: {
    id: "address_sofia",
    label: "«Официалните адреси в Столична Община» (address_sofia)",
    org: "Столична община / urbandata.sofia.bg",
    detail: "Официальный реестр адресных точек, сопоставленный с этим контуром здания.",
  },
  nsi_sofiaplan: {
    id: "nsi_sofiaplan",
    label: "«Административни адреси» (набор данных 218)",
    org: "Sofiaplan / НСИ",
    detail: "Геокодированные адреса переписи, сопоставленные с этим контуром здания.",
  },
  tag: {
    id: "tag",
    label: "тег addr:housenumber в OpenStreetMap",
    org: "участники OpenStreetMap",
    detail: "Номер, указанный вручную прямо на контуре здания в OpenStreetMap, без отдельного адресного импорта.",
  },
};

// Which source "wins" as the main entry when several building rows carry the
// same civic number for the same street — earlier wins. An explicit address
// import is more directly "this building's real address" than a bare OSM
// tag; "no source at all" loses to everything.
const PRIORITY_ORDER = ["address_point", "address_sofia", "nsi_sofiaplan", "tag", ""];

function priorityRank(src) {
  const i = PRIORITY_ORDER.indexOf(src || "");
  return i === -1 ? PRIORITY_ORDER.length : i;
}

function sourceLabel(src) {
  const s = HOUSENUMBER_SOURCES[src];
  return s ? `${s.label} (${s.org})` : "источник не указан";
}

module.exports = { HOUSENUMBER_SOURCES, PRIORITY_ORDER, priorityRank, sourceLabel };
