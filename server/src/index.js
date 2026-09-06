const path = require("path");
const express = require("express");

const searchRoutes = require("./routes/search");
const rubricRoutes = require("./routes/rubric");
const objectRoutes = require("./routes/object");
const coordRoutes = require("./routes/coord");

const PORT = process.env.PORT || 5173;
const WEB_DIR = path.resolve(__dirname, "..", "..", "web");
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");

const app = express();

// API (search, rubric browsing, object details, route stops, hit-test) —
// mirrors the /services/* endpoints from the moscowmap reference.
app.use("/api", searchRoutes);
app.use("/api", rubricRoutes);
app.use("/api", objectRoutes);
app.use("/api", coordRoutes);

// Static frontend + PMTiles data. express.static supports HTTP Range
// requests out of the box, which is what pmtiles.js needs to read tiles
// directly out of a single static file (no tile server required).
app.use("/data", express.static(DATA_DIR, { maxAge: "1h" }));
// The web/js/*.js files get edited and redelivered often during active
// development (search/hover-click fixes, most recently 2026-09-06) — a
// plain `express.static(WEB_DIR)` sends no Cache-Control at all, and a
// user reported a fix not taking effect after a full server restart
// because the browser kept serving its own cached copy of map-search.js
// without ever re-checking with the server (no explicit header means the
// browser is free to apply its own heuristic caching, and evidently did).
// `Cache-Control: no-cache` still lets the browser keep a cached copy, but
// forces it to revalidate with the server (a cheap conditional request)
// before using it, so an edited file is picked up on the next normal page
// reload — no more relying on the user doing a hard-refresh.
app.use("/", express.static(WEB_DIR, { setHeaders: (res) => res.set("Cache-Control", "no-cache") }));

app.listen(PORT, () => {
  console.log(`Sofia map server running at http://localhost:${PORT}`);
});
