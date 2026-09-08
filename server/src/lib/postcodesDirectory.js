// Собственная ветка разлинковки по почтовым индексам (Находка №11, по
// прямой просьбе пользователя от 2026-09-07):
//   /indexes/               — группы (первые 2 цифры индекса)
//   /indexes/:prefix/       — конкретные индексы внутри группы
//   /indexes/:code/         — улицы, у которых есть дома с этим индексом,
//                             с пометкой, если у улицы ЕСТЬ дома и под
//                             другими индексами (обычная ситуация для
//                             длинных улиц/бульваров, пересекающих
//                             границу почтовой зоны — не ошибка, а факт)
//   /indexes/:code/:street/ — дома этой улицы с этим индексом, ссылки на
//                             готовую карточку дома (/streets/.../dom-N.html)
//
// Строится один раз при старте (тот же паттерн, что streetsDirectory.js) —
// таблица buildings не меняется во время работы процесса (db.js открывает
// её readonly), инвалидировать нечем.
const db = require("../db");
const streets = require("./streetsDirectory");
const { createSlugAssigner, slugify } = require("./slugify");

let cache = null;

function build() {
  const rows = db.prepare(`
    SELECT id, addr_street, postcode FROM buildings
    WHERE postcode != '' AND addr_street != ''
  `).all();

  const byCode = new Map(); // code -> Map(streetName -> ids[])
  const streetCodes = new Map(); // streetName -> Set(code)

  for (const r of rows) {
    if (!byCode.has(r.postcode)) byCode.set(r.postcode, new Map());
    const byStreet = byCode.get(r.postcode);
    if (!byStreet.has(r.addr_street)) byStreet.set(r.addr_street, []);
    byStreet.get(r.addr_street).push(r.id);

    if (!streetCodes.has(r.addr_street)) streetCodes.set(r.addr_street, new Set());
    streetCodes.get(r.addr_street).add(r.postcode);
  }

  const codes = [...byCode.keys()].sort();
  const prefixes = new Map(); // "12" -> { prefix, codes: [{code,count}], total }
  for (const code of codes) {
    const total = [...byCode.get(code).values()].reduce((a, ids) => a + ids.length, 0);
    const prefix = code.slice(0, 2);
    if (!prefixes.has(prefix)) prefixes.set(prefix, { prefix, codes: [], total: 0 });
    const p = prefixes.get(prefix);
    p.codes.push({ code, count: total });
    p.total += total;
  }

  return { byCode, streetCodes, codes, prefixes };
}

function get() {
  if (!cache) cache = build();
  return cache;
}

// Улицы внутри одного индекса, со слагами (собственная нумерация коллизий
// в рамках ЭТОГО индекса — двум разным улицам с одинаковым названием
// внутри одной зоны просто не бывает откуда взяться, но на всякий случай
// та же дисциплина, что и везде в проекте).
function getStreetsForCode(code) {
  const data = get();
  const byStreet = data.byCode.get(code);
  if (!byStreet) return null;
  const assign = createSlugAssigner();
  const list = [...byStreet.entries()].map(([name, ids]) => {
    const otherCodes = [...data.streetCodes.get(name)].filter((c) => c !== code).sort();
    return { name, count: ids.length, slug: assign(name, `ulitsa-${ids[0]}`), otherCodes };
  });
  list.sort((a, b) => a.name.localeCompare(b.name, "bg"));
  return list;
}

function getHousesForCodeAndStreet(code, streetSlug) {
  const list = getStreetsForCode(code);
  if (!list) return null;
  const entry = list.find((s) => s.slug === streetSlug);
  if (!entry) return null;
  const data = get();
  const ids = data.byCode.get(code).get(entry.name);

  // Найти реальную карточку дома (сама постройка может относиться к
  // одному из НЕСКОЛЬКИХ физически разных кластеров с этим именем улицы
  // — street-name-collisions.md; поэтому ищем среди всех кластеров с
  // таким названием тот, что реально содержит этот building id, а не
  // берём первый попавшийся).
  const candidateEntries = streets.get().entries.filter((e) => e.name === entry.name);
  const idSet = new Set(ids);
  const found = new Map(); // building id -> {streetSlug, houseSlug, displayName}
  for (const ce of candidateEntries) {
    if (found.size === idSet.size) break;
    const houses = streets.getHousesForEntry(ce);
    for (const h of houses) {
      if (idSet.has(h.id) && !found.has(h.id)) {
        found.set(h.id, { streetSlug: ce.slug, houseSlug: h.slug, displayName: h.displayName });
      }
    }
  }

  const houses = ids.map((id) => found.get(id)).filter(Boolean);
  houses.sort((a, b) => a.displayName.localeCompare(b.displayName, "bg", { numeric: true }));
  return { streetName: entry.name, otherCodes: entry.otherCodes, houses, unresolvedCount: ids.length - houses.length };
}

module.exports = { get, getStreetsForCode, getHousesForCodeAndStreet };
