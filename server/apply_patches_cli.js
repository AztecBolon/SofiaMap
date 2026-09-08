// Manual one-off runner for data/patches/*.json — same logic the server
// already runs automatically on every startup (src/db.js). Useful to
// apply patches (and see the log output) without starting the whole
// server, e.g. right after copying a new patch file in.
//
// Usage:  node apply_patches_cli.js
const path = require("path");
const { applyPendingPatches } = require("./src/lib/applyPatches");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "sofia.db");
const PATCHES_DIR = path.join(DATA_DIR, "patches");

console.log(`Applying pending patches from ${PATCHES_DIR} to ${DB_PATH} ...`);
applyPendingPatches(DB_PATH, PATCHES_DIR);
console.log("Done. (Any patch already applied earlier was skipped — see log above.)");
