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

module.exports = db;
