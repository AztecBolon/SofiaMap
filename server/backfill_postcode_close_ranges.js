// Находка №10 (2026-09-06): закрытие открытых диапазонов (`№ до` пусто) в
// официальном реестре почтовых индексов Български пощи.
//
// Разовый скрипт, не часть серверного кода (не подключён ни к index.js, ни
// к какому-либо роуту) — тот же паттерн, что и backfill_postcode.js/
// backfill_postcode_voronoi.py из предыдущих сессий.
//
// Проблема (см. address-coverage.md, «Находка №10» для полного разбора):
// часть строк реестра для одной улицы имеет ОТКРЫТЫЙ верхний конец диапазона
// (`№ до` пусто) — например для «Околовръстен път»: № от=191, вид=н, № до=
// (пусто), индекс 1700; следующая строка той же улицы — № от=235, н,
// (пусто), индекс 1756. Прежний код трактовал пустое `№ до` как +∞, из-за
// чего соседние открытые диапазоны формально пересекаются (ложная
// неоднозначность) или номер вообще не попадает ни в один диапазон.
//
// Фикс: внутри группы (settlement, street, вид_номера), отсортированной по
// `№ от`, для строки с пустым `№ до` эффективная верхняя граница = (№ от
// следующей строки той же группы) − шаг_чётности (2 для н/ч, 1 для д/'').
// Для последней строки в группе диапазон остаётся открытым (+∞), как и
// раньше.
//
// Дисциплина: правим ТОЛЬКО логику диапазонов, ничего не трогаем в уже
// заполненных строках (postcode != ''). Чтобы не приписать этому узкому
// фиксу лишние (по сути посторонние) исправления, эффект вычисляется через
// A/B-сравнение "старая семантика (+∞) vs новая (закрытая)" на ОДНОЙ и той
// же нормализации/сопоставлении — присваивается индекс только тем домам,
// у которых старая семантика давала конфликт/непопадание, а новая — ровно
// один кандидат. Дома, которые совпадают с реестром напрямую и без всякой
// связи с открытыми диапазонами (например обнаруженная попутно, отдельная
// проблема сопоставления вариантов "бул. X" / "X" / "Св. X" для одной и той
// же улицы — см. address-coverage.md), сознательно НЕ трогаются: это другой
// баг, не входящий в эту находку.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = process.env.SOFIA_DB || path.join(DATA_DIR, "sofia.db");
const RULES_PATH = path.join(DATA_DIR, "external", "postal_rules.json");

const db = new Database(DB_PATH);

// ---------- геометрическое разрешение поселения (Находки №7, №9) ----------
const QUARTER_NAMES = [
  "кв. Драгалевци", "кв. Бояна", "кв. Симеоново", "кв. Суходол",
  "кв. Враждебна", "кв. Горна баня", "кв. Горубляне", "кв. Илиянци",
  "кв. Филиповци", // "кв. Ботунец" сознательно отсутствует - не найден в districts (Находка №7)
];

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

const quarterPolys = QUARTER_NAMES.map((name) => {
  const row = db.prepare("SELECT geometry FROM districts WHERE name = ?").get(name);
  return row ? { name: name.slice(4), geometry: JSON.parse(row.geometry) } : null;
}).filter(Boolean);

const settlementPolys = db
  .prepare("SELECT name, geometry FROM settlements WHERE name != 'София'")
  .all()
  .map((r) => ({ name: r.name, geometry: JSON.parse(r.geometry) }));

function resolveSettlement(lat, lon, cityTag) {
  for (const q of quarterPolys) {
    if (pointInGeometry(lon, lat, q.geometry)) return q.name;
  }
  for (const s of settlementPolys) {
    if (pointInGeometry(lon, lat, s.geometry)) return s.name;
  }
  return cityTag || "София";
}

// ---------- нормализация названия улицы (та же, что в Находке №5) ----------
const ABBR = [
  [/\bГен\.\s*/gi, "Генерал "],
  [/\bСв\.\s*/gi, "Свети "],
  [/\bАкад\.\s*/gi, "Академик "],
  [/\bПроф\.\s*/gi, "Професор "],
  [/\bД-р\.?\s*/gi, "Доктор "],
  [/\bИнж\.\s*/gi, "Инженер "],
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

// ---------- загрузка реестра и подготовка двух вариантов (старый/новый) ----------
const rulesRaw = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));

function parseInt10(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^\d+/);
  return m ? parseInt(m[0], 10) : null;
}

const STEP = { н: 2, ч: 2, д: 1, "": 1 };

function buildVariant(closingEnabled) {
  const rules = rulesRaw.map((r) => ({
    settlement: r.settlement,
    streetNorm: normalizeStreet(r.street),
    numType: r.numType,
    fromRaw: r.from,
    toRaw: r.to,
    from: parseInt10(r.from),
    to: parseInt10(r.to),
    postcode: r.postcode,
  }));

  const groups = new Map();
  for (const r of rules) {
    const key = `${r.settlement}${r.streetNorm}${r.numType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const grp of groups.values()) {
    const numeric = grp.filter((r) => r.from !== null).sort((a, b) => a.from - b.from);
    for (const r of numeric) {
      if (r.to === null && r.toRaw === "") {
        if (closingEnabled) {
          const nexts = numeric.filter((rr) => rr.from > r.from);
          if (nexts.length) {
            const nxt = nexts.reduce((a, b) => (a.from < b.from ? a : b));
            const step = STEP[r.numType] ?? 1;
            r.to = nxt.from - step;
            continue;
          }
        }
        r.to = 1e9; // остаётся открытым (последняя строка в цепочке)
      }
    }
  }

  const byKey = new Map();
  for (const r of rules) {
    const key = `${r.settlement}${r.streetNorm}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  return byKey;
}

const byKeyOld = buildVariant(false);
const byKeyNew = buildVariant(true);

function parityOk(numType, n) {
  if (numType === "ч") return n % 2 === 0;
  if (numType === "н") return n % 2 === 1;
  return true;
}
function inRange(rule, n) {
  const lo = rule.from ?? 0;
  const hi = rule.to ?? 1e9;
  return n >= lo && n <= hi;
}
function matchSet(byKey, settlement, streetNorm, n) {
  const candidates = byKey.get(`${settlement}${streetNorm}`);
  if (!candidates) return null;
  const matched = new Set();
  for (const rule of candidates) {
    if (parityOk(rule.numType, n) && inRange(rule, n)) matched.add(rule.postcode);
  }
  return matched;
}

const HN_RE = /^\s*(\d+)/;
function parseHn(hn) {
  const m = HN_RE.exec(hn || "");
  return m ? parseInt(m[1], 10) : null;
}

// ---------- применение к домам с пустым postcode ----------
const buildings = db
  .prepare("SELECT id, addr_street, housenumber, city, lat, lon FROM buildings WHERE postcode = '' OR postcode IS NULL")
  .all();

const fixed = [];
for (const b of buildings) {
  if (!b.addr_street) continue;
  const n = parseHn(b.housenumber);
  if (n === null) continue;
  const settlement = resolveSettlement(b.lat, b.lon, b.city || "");
  const streetNorm = normalizeStreet(b.addr_street);

  const oldMatched = matchSet(byKeyOld, settlement, streetNorm, n);
  if (oldMatched === null) continue; // улицы нет в реестре вообще - не наш случай
  if (oldMatched.size === 1) continue; // уже было бы однозначно и при старой (буквенной) логике - не наш баг

  const newMatched = matchSet(byKeyNew, settlement, streetNorm, n);
  if (newMatched && newMatched.size === 1) {
    fixed.push({ id: b.id, postcode: [...newMatched][0], settlement, streetNorm, housenumber: b.housenumber });
  }
}

console.log(`Найдено ${fixed.length} домов, которые разрешаются однозначно только после закрытия диапазонов.`);

const update = db.prepare("UPDATE buildings SET postcode = ?, postcode_src = 'postal_registry_range_closed' WHERE id = ? AND (postcode = '' OR postcode IS NULL)");
const applyAll = db.transaction((rows) => {
  let applied = 0;
  for (const r of rows) {
    const info = update.run(r.postcode, r.id);
    applied += info.changes;
  }
  return applied;
});

if (process.argv.includes("--apply")) {
  const applied = applyAll(fixed);
  console.log(`Применено: ${applied} обновлений.`);
} else {
  console.log("Сухой прогон (dry run). Запустите с --apply, чтобы записать в базу.");
  for (const r of fixed) console.log(r);
}
