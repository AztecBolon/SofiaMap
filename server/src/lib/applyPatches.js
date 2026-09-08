// Auto-apply small "patch" files to sofia.db on server startup.
//
// Why this exists: sofia.db is ~100MB, far past what can be committed to
// the user's machine in one piece (the device-file-transfer tool caps a
// single write at ~20MB). Historically that meant shipping a whole new
// zipped database after every data fix and asking the user to manually
// unzip it over the old one. Most fixes are actually just UPDATEs to a
// few hundred/thousand existing rows (e.g. filling in postcode +
// postcode_src) — tiny as a list of changed values, even though the
// database itself is huge. So instead: a fix ships as a small JSON
// "patch" file (a handful of SQL statement templates + the changed rows'
// parameters) that gets written straight into data/patches/ next to the
// database, and this module applies any not-yet-applied patch to
// sofia.db right here on the next normal server startup — no manual
// re-copying of the database file needed.
//
// Patch file shape (see data/patches/README.md for the authoring side):
//   {
//     "id": "2026-09-07-finding11-postcodes",         // unique, stable
//     "description": "human-readable summary",         // shown in logs
//     "statements": [
//       {
//         "sql": "UPDATE buildings SET postcode = ?, postcode_src = ? WHERE id = ?",
//         "paramSets": [["1756","postal_registry_disputed",4821], ...]
//       },
//       // or a single one-shot statement:
//       { "sql": "CREATE INDEX IF NOT EXISTS ...", "params": [] }
//     ]
//   }
//
// Every UPDATE we ship this way is written to be idempotent (sets an
// explicit value rather than e.g. incrementing), so re-applying an
// already-applied patch — which can happen if the user's copy of the
// database already had the fix some other way — is always harmless.
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const TRACKING_TABLE = "_applied_patches";

function ensureTrackingTable(db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
       id TEXT PRIMARY KEY,
       description TEXT,
       applied_at TEXT NOT NULL,
       statement_count INTEGER
     )`
  );
}

function alreadyApplied(db, id) {
  const row = db.prepare(`SELECT 1 FROM ${TRACKING_TABLE} WHERE id = ?`).get(id);
  return !!row;
}

function applyOnePatch(db, patch, fileName) {
  if (!patch || typeof patch !== "object" || !patch.id || !Array.isArray(patch.statements)) {
    console.warn(`[patches] Skipping ${fileName}: missing id/statements — not a valid patch file.`);
    return { ok: false };
  }
  if (alreadyApplied(db, patch.id)) {
    return { ok: true, skipped: true };
  }

  let statementCount = 0;
  const applyTxn = db.transaction(() => {
    for (const stmt of patch.statements) {
      if (!stmt || typeof stmt.sql !== "string") {
        throw new Error(`statement missing "sql" in patch ${patch.id}`);
      }
      // ALTER TABLE ... ADD COLUMN is how a patch adds a column a fix
      // needs (e.g. postcode_src on a database that predates it). SQLite
      // has no "ADD COLUMN IF NOT EXISTS", so re-running this same
      // statement against a database where some other path already added
      // the column (or a patch that failed after adding the column but
      // before finishing) would normally abort the whole patch on
      // "duplicate column name". Since a repeated ADD COLUMN is always a
      // safe no-op in intent, that one error is swallowed here — a real
      // schema/SQL mistake in the same statement still fails normally,
      // and every other statement in this patch still runs and still
      // aborts the whole patch on any other error.
      const isAddColumn = /^\s*alter\s+table\s+\S+\s+add\s+column\b/i.test(stmt.sql);
      const prepared = db.prepare(stmt.sql);
      const runOne = (params) => {
        try {
          prepared.run(...params);
        } catch (err) {
          if (isAddColumn && /duplicate column name/i.test(err.message)) {
            return; // column already exists — nothing to do
          }
          throw err;
        }
      };
      if (Array.isArray(stmt.paramSets)) {
        for (const params of stmt.paramSets) {
          runOne(Array.isArray(params) ? params : [params]);
          statementCount++;
        }
      } else if (stmt.params !== undefined) {
        runOne(Array.isArray(stmt.params) ? stmt.params : [stmt.params]);
        statementCount++;
      } else {
        runOne([]);
        statementCount++;
      }
    }
    db.prepare(
      `INSERT INTO ${TRACKING_TABLE} (id, description, applied_at, statement_count) VALUES (?, ?, ?, ?)`
    ).run(patch.id, patch.description || null, new Date().toISOString(), statementCount);
  });

  applyTxn();
  return { ok: true, skipped: false, statementCount };
}

// Scans patchesDir for *.json files (sorted by filename, so a numeric or
// date prefix in the filename controls apply order) and applies every one
// not already recorded in the tracking table, in a short-lived writable
// connection. Never throws on a single bad/failing patch — logs it and
// keeps going, so one mistake in a patch file can't stop the server from
// starting and serving the (unpatched) data it already has.
function applyPendingPatches(dbPath, patchesDir) {
  if (!fs.existsSync(patchesDir)) return;

  let files;
  try {
    files = fs
      .readdirSync(patchesDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch (err) {
    console.warn(`[patches] Could not read ${patchesDir}: ${err.message}`);
    return;
  }
  if (!files.length) return;

  const db = new Database(dbPath);
  try {
    ensureTrackingTable(db);
    for (const file of files) {
      const fullPath = path.join(patchesDir, file);
      let patch;
      try {
        patch = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      } catch (err) {
        console.warn(`[patches] Skipping ${file}: invalid JSON (${err.message}).`);
        continue;
      }
      try {
        const result = applyOnePatch(db, patch, file);
        if (result.ok && !result.skipped) {
          console.log(
            `[patches] Applied ${patch.id} (${file}): ${patch.description || "no description"} — ${result.statementCount} statement(s).`
          );
        }
      } catch (err) {
        console.error(`[patches] FAILED to apply ${file} (patch id: ${patch && patch.id}): ${err.message}`);
        console.error(`[patches] This patch was skipped; the server will start with the data it already has.`);
      }
    }
  } finally {
    db.close();
  }
}

module.exports = { applyPendingPatches, TRACKING_TABLE };
