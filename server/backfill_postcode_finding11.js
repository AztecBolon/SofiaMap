// Находка №11 (2026-09-07): три независимых уточнения сопоставления с
// реестром почтовых индексов + отдельное, явное по просьбе пользователя
// решение по бул. "Свети Климент Охридски".
//
// Как и предыдущие backfill-скрипты — разовый скрипт вне серверного кода,
// dry-run по умолчанию, --apply пишет в БД.
//
// Что меняется относительно Находки №10 (см. backfill_postcode_close_ranges.js):
//
// 1) parseHn(): housenumber вида "бл. N" / "Бл. N" / "БЛ. N" теперь
//    парсится как обычный номер N ДЛЯ ЦЕЛЕЙ СОПОСТАВЛЕНИЯ с диапазонами
//    реестра (по просьбе пользователя: "номер блока используем напрямую
//    как адрес"). Само значение в колонке housenumber не трогаем — блок
//    остаётся блоком, это отдельный, самостоятельно осмысленный факт об
//    объекте, а не опечатка; меняется только то, как мы его читаем при
//    поиске почтового индекса.
//
// 2) resolveSettlement(): сравнение теперь регистронезависимое (нашли
//    "Горна Баня" в реестре vs "Горна баня" у нас — просто разный
//    регистр, база пуста без всякой связи с географией), добавлен
//    "кв. Требич" в список кварталов (геометрия для него у нас ЕСТЬ в
//    districts, как и для остальных 9 — просто не был включён в список
//    Находки №7/№9, хотя реестр содержит отдельные строки для settlement
//    "Требич"), плюс небольшой словарь алиасов написания названий
//    населённых мест реестра -> наша таблица settlements, там где это
//    очевидная опечатка/сокращение одного и того же села:
//      Пасарел -> Долни Пасарел, Войняговци -> Войнеговци,
//      Световрачане -> Световрачене (в реестре ВООБЩЕ ОБА варианта
//      написания встречаются для одного и того же места - раздельно
//      нормализуем к одному), Казичане -> Казичене, Желявя -> Желява.
//    НЕ добавлены (геометрии нет вообще ни в districts, ни в settlements,
//    ни city-тега на зданиях - тот же случай, что и "Ботунец" в Находке
//    №7): Сеславци, Кремиковци, Челопечене.
//
// 3) Отдельно, вне общего механизма: бул. "Свети Климент Охридски" —
//    202 дома с пустым индексом. Официальная строка реестра для этой
//    улицы (settlement=София, без диапазона) даёт 1756, и часть уже
//    самостоятельно (voronoi_nn) разрешённых домов бульвара тоже имеет
//    1756 (наряду с 1616/1700/1734/1797 у соседних участков - см. чат).
//    Пользователь сверил внешние источники: для домов №2 и №3 они также
//    дают 1756, и попросил принять 1756 как основной индекс для ВСЕХ
//    оставшихся 202 домов бульвара, с явной оговоркой на карточке дома.
//    Это НЕ авто-вычисленное решение общего механизма, а разовое,
//    прямое указание пользователя - помечено собственным postcode_src.
//
// Дисциплина по-прежнему: только пустые (postcode='' OR NULL) строки;
// эффект пунктов 1-2 вычисляется через A/B (старая логика Находки №10
// vs новая с этими тремя уточнениями), чтобы не приписать сюда ничего
// постороннего; пункт 3 применяется отдельно и безусловно по прямому
// указанию пользователя (не через общий A/B механизм).

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = process.env.SOFIA_DB || path.join(DATA_DIR, "sofia.db");
const RULES_PATH = path.join(DATA_DIR, "external", "postal_rules.json");

const db = new Database(DB_PATH);

// ---------- геометрия ----------
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  for (const poly of polys) {
    if (!poly.length) continue;
    if (pointInRing(lon, lat, poly[0])) {
      let inHole = false;
      for (let h = 1; h < poly.length; h++) {
        if (pointInRing(lon, lat, poly[h])) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

const QUARTER_NAMES_OLD = [
  "кв. Драгалевци", "кв. Бояна", "кв. Симеоново", "кв. Суходол",
  "кв. Враждебна", "кв. Горна баня", "кв. Горубляне", "кв. Илиянци",
  "кв. Филиповци",
];
const QUARTER_NAMES_NEW = [...QUARTER_NAMES_OLD, "кв. Требич"];

function loadQuarterPolys(names) {
  return names.map((name) => {
    const row = db.prepare("SELECT geometry FROM districts WHERE name = ?").get(name);
    return row ? { name: name.slice(4), geometry: JSON.parse(row.geometry) } : null;
  }).filter(Boolean);
}
const quarterPolysOld = loadQuarterPolys(QUARTER_NAMES_OLD);
const quarterPolysNew = loadQuarterPolys(QUARTER_NAMES_NEW);
const settlementPolys = db.prepare("SELECT name, geometry FROM settlements WHERE name != 'София'").all()
  .map((r) => ({ name: r.name, geometry: JSON.parse(r.geometry) }));

function resolveSettlement(lat, lon, cityTag, quarterPolys) {
  for (const q of quarterPolys) if (pointInGeometry(lon, lat, q.geometry)) return q.name;
  for (const s of settlementPolys) if (pointInGeometry(lon, lat, s.geometry)) return s.name;
  return cityTag || "София";
}

// ---------- нормализация улицы (без изменений) ----------
const ABBR = [
  [/\bГен\.\s*/gi, "Генерал "], [/\bСв\.\s*/gi, "Свети "],
  [/\bАкад\.\s*/gi, "Академик "], [/\bПроф\.\s*/gi, "Професор "],
  [/\bД-р\.?\s*/gi, "Доктор "], [/\bИнж\.\s*/gi, "Инженер "],
  [/\bПолк\.\s*/gi, "Полковник "],
];
function normalizeStreet(s) {
  if (!s) return "";
  let out = s.replace(/\([^)]*\)/g, "");
  for (const [re, repl] of ABBR) out = out.replace(re, repl);
  out = out.replace(/І/g, "I").replace(/і/g, "i");
  out = out.replace(/\s+/g, " ").trim();
  return out.toLowerCase();
}

// ---------- алиасы населённых мест реестра (новое) ----------
const SETTLEMENT_ALIAS = {
  "пасарел": "Долни Пасарел",
  "войняговци": "Войнеговци",
  "световрачане": "Световрачене",
  "казичане": "Казичене",
  "желявя": "Желява",
};
function canonSettlementOld(s) { return s; }
function canonSettlementNew(s) {
  const key = (s || "").toLowerCase();
  if (SETTLEMENT_ALIAS[key]) return SETTLEMENT_ALIAS[key];
  return s;
}

// ---------- housenumber ----------
const HN_RE = /^\s*(\d+)/;
const HN_BLOCK_RE = /^\s*бл\.?\s*(\d+)/i;
function parseHnOld(hn) {
  const m = HN_RE.exec(hn || "");
  return m ? parseInt(m[1], 10) : null;
}
function parseHnNew(hn) {
  const m = HN_RE.exec(hn || "");
  if (m) return parseInt(m[1], 10);
  const mb = HN_BLOCK_RE.exec(hn || "");
  return mb ? parseInt(mb[1], 10) : null;
}

// ---------- реестр: строим варианты с/без диапазонов (та же логика закрытия, что и в Находке №10) ----------
function parseInt10(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^\d+/);
  return m ? parseInt(m[0], 10) : null;
}
const STEP = { н: 2, ч: 2, д: 1, "": 1 };
const rulesRaw = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));

function buildRules(canonSettlement) {
  const rules = rulesRaw.map((r) => ({
    settlement: canonSettlement(r.settlement),
    streetNorm: normalizeStreet(r.street),
    numType: r.numType,
    fromRaw: r.from, toRaw: r.to,
    from: parseInt10(r.from), to: parseInt10(r.to),
    postcode: r.postcode,
  }));
  const groups = new Map();
  for (const r of rules) {
    const key = `${r.settlement}${r.streetNorm}${r.numType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const grp of groups.values()) {
    const numeric = grp.filter((r) => r.from !== null).sort((a, b) => a.from - b.from);
    for (const r of numeric) {
      if (r.to === null && r.toRaw === "") {
        const nexts = numeric.filter((rr) => rr.from > r.from);
        if (nexts.length) {
          const nxt = nexts.reduce((a, b) => (a.from < b.from ? a : b));
          r.to = nxt.from - (STEP[r.numType] ?? 1);
          continue;
        }
        r.to = 1e9;
      }
    }
  }
  const byKey = new Map();
  for (const r of rules) {
    const key = `${r.settlement}${r.streetNorm}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  return byKey;
}
const byKeyOld = buildRules(canonSettlementOld);
const byKeyNew = buildRules(canonSettlementNew);

function parityOk(numType, n) {
  if (numType === "ч") return n % 2 === 0;
  if (numType === "н") return n % 2 === 1;
  return true;
}
function inRange(rule, n) {
  const lo = rule.from ?? 0, hi = rule.to ?? 1e9;
  return n >= lo && n <= hi;
}
function matchSet(byKey, settlement, streetNorm, n) {
  const candidates = byKey.get(`${settlement}${streetNorm}`);
  if (!candidates) return null;
  const matched = new Set();
  for (const rule of candidates) if (parityOk(rule.numType, n) && inRange(rule, n)) matched.add(rule.postcode);
  return matched;
}

// ============================================================
// Часть A: общий A/B по всем ещё пустым домам (пункты 1 и 2)
// ============================================================
const buildings = db.prepare("SELECT id, addr_street, housenumber, city, lat, lon FROM buildings WHERE postcode = '' OR postcode IS NULL").all();

const fixedGeneral = [];
for (const b of buildings) {
  if (!b.addr_street) continue;

  const settlementOld = resolveSettlement(b.lat, b.lon, b.city || "", quarterPolysOld);
  const settlementNew = resolveSettlement(b.lat, b.lon, b.city || "", quarterPolysNew);
  const streetNorm = normalizeStreet(b.addr_street);

  const nOld = parseHnOld(b.housenumber);
  const nNew = parseHnNew(b.housenumber);

  const oldMatched = nOld !== null ? matchSet(byKeyOld, settlementOld, streetNorm, nOld) : null;
  if (oldMatched && oldMatched.size === 1) continue; // уже однозначно и по старой логике - не наш случай

  if (nNew === null) continue;
  const newMatched = matchSet(byKeyNew, settlementNew, streetNorm, nNew);
  if (newMatched && newMatched.size === 1) {
    const usedBlockParse = nOld === null && nNew !== null;
    const usedAlias = settlementOld !== settlementNew;
    let src = "postal_registry_settlement_alias";
    if (usedBlockParse && usedAlias) src = "postal_registry_alias_and_block";
    else if (usedBlockParse) src = "postal_registry_block_number_as_address";
    fixedGeneral.push({
      id: b.id, postcode: [...newMatched][0], src,
      addr_street: b.addr_street, housenumber: b.housenumber,
      settlementOld, settlementNew, usedBlockParse, usedAlias,
    });
  }
}

console.log(`[Общий A/B] Найдено ${fixedGeneral.length} домов, разрешаемых однозначно благодаря п.1-2.`);
const bySrc = {};
for (const f of fixedGeneral) bySrc[f.src] = (bySrc[f.src] || 0) + 1;
console.log("Разбивка по механизму:", bySrc);

// ============================================================
// Часть B: бул. "Свети Климент Охридски" - прямое указание пользователя
// ============================================================
const boulevardTarget = db.prepare(`
  SELECT id FROM buildings
  WHERE addr_street = 'бул. Свети Климент Охридски' AND (postcode = '' OR postcode IS NULL)
`).all();
console.log(`[Бул. Св. Климент Охридски] Домов без индекса: ${boulevardTarget.length} -> будет проставлен 1756 (postal_registry_disputed).`);

// ============================================================
// Применение
// ============================================================
const updateGeneral = db.prepare("UPDATE buildings SET postcode = ?, postcode_src = ? WHERE id = ? AND (postcode = '' OR postcode IS NULL)");
const updateBoulevard = db.prepare("UPDATE buildings SET postcode = '1756', postcode_src = 'postal_registry_disputed' WHERE id = ? AND (postcode = '' OR postcode IS NULL)");

const applyAll = db.transaction(() => {
  let applied = 0;
  for (const f of fixedGeneral) applied += updateGeneral.run(f.postcode, f.src, f.id).changes;
  for (const b of boulevardTarget) applied += updateBoulevard.run(b.id).changes;
  return applied;
});

if (process.argv.includes("--apply")) {
  const applied = applyAll();
  console.log(`Применено суммарно: ${applied} обновлений.`);
} else {
  console.log("Сухой прогон. Запустите с --apply для записи в базу.");
  console.log("Примеры (до 15) из общего A/B:", fixedGeneral.slice(0, 15));
}

fs.writeFileSync("/home/claude/work/finding11_general.json", JSON.stringify(fixedGeneral, null, 2));
fs.writeFileSync("/home/claude/work/finding11_boulevard_ids.json", JSON.stringify(boulevardTarget.map(b=>b.id), null, 2));
