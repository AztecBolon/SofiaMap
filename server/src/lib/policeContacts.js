// СДВР (Sofia police) district units — house-page-template §13.6/§13.11.
// Sofia's 24 official raions are policed by only 9 РУ (Районно
// управление) units, each covering several raions at once — a materially
// different granularity than the 1-raion-1-administration mapping in
// districtAdminContacts.js, so this needs its own raion -> unit table
// rather than reusing that one.
//
// Sources (fetched 2026-09-06): address + phone for all 9 units from
// about-sofia.com/addresses/police-offices/ (a mirror of mvr.bg content,
// mvr.bg itself unreachable from this environment — §13.12); raion
// coverage per unit from each unit's own about-sofia.com page for 7 of
// the 9 units, which state it directly ("обслужва district X, Y и Z").
// Two assignments — Възраждане under 03 РУ and Панчарево under 08 РУ —
// aren't stated on either unit's own about-sofia.com page and are
// corroborated instead from secondary sources: an official mvr.bg
// Facebook post listing 03 РУ's serviced ж.к.-и (which names a
// "Възраждане" territorial-police group under 03 РУ), and a directory
// listing naming Панчарево's local police "участък" as part of 8-мо
// Районно управление. Same confidence tier as tier-2/tier-3 elsewhere in
// this project (§6) — real, sourced, just one step less direct than the
// other 7.
const UNITS = {
  "01": { address: "гр. София, п.к. 1113, ж.к. „Гео Милев“, бул. „Шипченски проход“ № 8", phone: "02/982 7166" },
  "02": { address: "гр. София, п.к. 1202, ул. „Княз Борис I“ № 215", phone: "02/982 0820" },
  "03": { address: "гр. София, п.к. 1309, ж.к. „Илинден“, ул. „Инже войвода“ № 2", phone: "02/982 1260" },
  "04": { address: "гр. София, п.к. 1421, ж.к. Лозенец, ул. „Крум Попов“ № 57", phone: "02/982 4160" },
  "05": { address: "гр. София, п.к. 1504, ул. „Марин Дринов“ № 4", phone: "02/982 5920" },
  "06": { address: "гр. София, п.к. 1618, ж.к. „Красно село“, бул. „Братя Бъкстон“ № 5", phone: "02/982 1760" },
  "07": { address: "гр. София, п.к. 1700, ж.к. „Младост“, бул. „Александър Малинов“ № 1", phone: "02/982 8760" },
  "08": { address: "гр. София, п.к. 1592, ж.к. „Дружба“, ул. „Иван Арабаджията“ № 141", phone: "02/982 5310" },
  "09": { address: "гр. София, п.к. 1359, ж.к. „Люлин IV“, бл. 464, вх. А", phone: "02/982 5600" },
};

// raion name (as raionsDirectory.js produces it) -> РУ number
const RAION_TO_UNIT = {
  "Средец": "01", "Слатина": "01", "Изгрев": "01",
  "Сердика": "02", "Надежда": "02", "Нови Искър": "02",
  "Илинден": "03", "Красна Поляна": "03", "Възраждане": "03",
  "Триадица": "04", "Лозенец": "04",
  "Оборище": "05", "Подуяне": "05", "Кремиковци": "05",
  "Красно Село": "06", "Овча Купел": "06", "Витоша": "06",
  "Младост": "07", "Студентски": "07",
  "Искър": "08", "Панчарево": "08",
  "Люлин": "09", "Връбница": "09", "Банкя": "09",
};

function getByRaionName(name) {
  const num = RAION_TO_UNIT[name];
  if (!num) return null;
  const unit = UNITS[num];
  return unit ? { num, ...unit } : null;
}

module.exports = { getByRaionName };
