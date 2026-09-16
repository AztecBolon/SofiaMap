// Opens sofia.db, reassembling it from split-and-gzipped parts on first run
// if the plain .db file isn't present yet (the raw SQLite file is too big to
// commit to the device folder in one piece, so it ships as
// sofia.db.gz.00.part / .01.part / ... and gets rebuilt here once).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Database = require("better-sqlite3");
const { applyPendingPatches } = require("./lib/applyPatches");

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const DB_PATH = path.join(DATA_DIR, "sofia.db");
const PATCHES_DIR = path.join(DATA_DIR, "patches");

function reassembleIfNeeded() {
  if (fs.existsSync(DB_PATH)) return;

  const parts = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^sofia\.db\.gz\.\d+\.part$/.test(f))
    .sort();

  if (!parts.length) {
    throw new Error(
      `sofia.db is missing and no sofia.db.gz.*.part chunks were found in ${DATA_DIR}. ` +
        "Copy the database (or its split .gz.*.part chunks) into data/ before starting the server."
    );
  }

  console.log(`sofia.db not found — reassembling from ${parts.length} part(s)...`);
  const gzPath = path.join(DATA_DIR, "_sofia.db.gz.tmp");
  const out = fs.createWriteStream(gzPath);
  for (const part of parts) {
    fs.appendFileSync(gzPath, fs.readFileSync(path.join(DATA_DIR, part)));
  }
  out.end();

  const compressed = fs.readFileSync(gzPath);
  const decompressed = zlib.gunzipSync(compressed);
  fs.writeFileSync(DB_PATH, decompressed);
  fs.unlinkSync(gzPath);
  console.log(`Reassembled sofia.db (${(decompressed.length / 1e6).toFixed(1)} MB).`);
}

reassembleIfNeeded();

// Small incremental data fixes ship as JSON files under data/patches/
// instead of a whole new copy of the database (see lib/applyPatches.js
// for why and the file format). Applied here, with a short-lived
// writable connection, before the app opens its normal read-only one.
applyPendingPatches(DB_PATH, PATCHES_DIR);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");

// SQLite's built-in lower()/upper() are ASCII-only, so Cyrillic queries
// wouldn't match differently-cased names (e.g. "Витоша" vs "витоша").
// Register a Unicode-aware lowercase function backed by JS instead.
db.function("lower_u", { deterministic: true }, (s) => (s == null ? s : String(s).toLowerCase()));

// 2026-09-15 (live report: "ул. Света Екатерина бл. 79" — the exact address
// this app itself shows for the building — returned "Ничего не найдено" from
// search). Root cause, confirmed against the real data: `buildings.housenumber`
// isn't always a bare number — 5443 of 132920 rows (4%) store a BLOCK number
// with the "бл." (block) designator baked directly into the column, e.g.
// "бл. 79" rather than "79" (this is real source data, not a bug in the
// column itself — Bulgarian panel-block addresses are commonly identified by
// block number rather than a street housenumber). search.js's
// ADDRESS_WITH_NUMBER query compares the typed number against this column
// with `=`/GLOB, which can never match a bare "79" against a stored
// "бл. 79". Registered here (not just in search.js) since it's a general
// housenumber-normalization concern, the same reasoning `lower_u` above
// already follows for case-folding. Strips a leading "бл."/"блок" (block)
// or "вх."/"вход" (entrance) designator — case-insensitively, with or
// without the trailing dot/spaces — from the column value before it's
// compared; a housenumber with no such prefix passes through unchanged.
// Longer alternatives ("блок"/"вход") must come BEFORE their own prefixes
// ("бл"/"вх") in this alternation — regex alternation tries left-to-right
// and takes the first match, so with the short forms listed first,
// "Блок 12" matched only the leading "бл" of "Блок" and left "ок 12"
// behind (caught by direct testing against real data before this shipped).
db.function("norm_house", { deterministic: true }, (s) =>
  s == null ? s : String(s).replace(/^\s*(?:блок|бл|вход|вх)\.?\s*/iu, "").trim()
);

module.exports = db;
