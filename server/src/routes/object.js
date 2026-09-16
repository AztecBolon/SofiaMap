const express = require("express");
const db = require("../db");
const { clusterStreetSegments } = require("../lib/streetCluster");
const { withDesignation } = require("../lib/streetDesignation");
const streetsDirectory = require("../lib/streetsDirectory");
// 2026-09-15 (live report, point 1: "В карточке объекта нужна ссылка на
// страницу объекта"): this endpoint feeds the map's "Объект на карте" card
// (both a plain click via openObjectDetails and a `?sel=type:id` deep link
// via selectFromUrl, map-search.js) — before this it never returned an
// `href` at all, even for object types search.js already links to just
// fine from its own results list. Shared lookup, not a re-derived one — see
// that module's own comment for why.
const objectHref = require("../lib/objectHref");
const raionsDirectory = require("../lib/raionsDirectory");
const parksDirectory = require("../lib/parksDirectory");
// 2026-09-15 (live report, point 3: "карточка не даёт важной информации...
// самое важное - проезд, как добраться"): the map's "Объект на карте" card
// had nothing beyond a name and a page link. transportNearby.getKakProehat
// already computes exactly this ("nearest metro" + "nearby stops with their
// routes") for the house/organization PAGES (pages.js) — reused verbatim
// here rather than re-derived, same "one source of truth per data shape"
// rule objectHref.js documents. Only for point-like object types where
// "how do I get there" is a meaningful question (address, company) — a
// stop/route result IS itself transit, and a district/settlement is too
// large an area for a single "nearest stop" answer to mean much.
const transportNearby = require("../lib/transportNearby");

const router = express.Router();

const getBuilding = db.prepare(`SELECT * FROM buildings WHERE id = ?`);
const getStreetSegments = db.prepare(`SELECT * FROM streets WHERE osm_id = ?`);
const getStreetByName = db.prepare(`SELECT * FROM streets WHERE lower_u(name) = lower_u(?)`);
const getDistrict = db.prepare(`SELECT * FROM districts WHERE id = ?`);
const getSettlement = db.prepare(`SELECT * FROM settlements WHERE id = ?`);
const getCompany = db.prepare(`SELECT * FROM organizations WHERE id = ?`);
const getStop = db.prepare(`SELECT * FROM stops WHERE id = ?`);
const getStopRoutes = db.prepare(`
  SELECT rs.route_type, rs.route_id,
    CASE rs.route_type
      WHEN 'bus' THEN (SELECT ref FROM routes_bus WHERE id = rs.route_id)
      WHEN 'tram' THEN (SELECT ref FROM routes_tram WHERE id = rs.route_id)
      WHEN 'trolleybus' THEN (SELECT ref FROM routes_trolleybus WHERE id = rs.route_id)
      WHEN 'metro' THEN (SELECT ref FROM routes_metro WHERE id = rs.route_id)
    END AS ref,
    CASE rs.route_type
      WHEN 'bus' THEN (SELECT name FROM routes_bus WHERE id = rs.route_id)
      WHEN 'tram' THEN (SELECT name FROM routes_tram WHERE id = rs.route_id)
      WHEN 'trolleybus' THEN (SELECT name FROM routes_trolleybus WHERE id = rs.route_id)
      WHEN 'metro' THEN (SELECT name FROM routes_metro WHERE id = rs.route_id)
    END AS route_name
  FROM route_stops rs WHERE rs.stop_id = ?
  GROUP BY rs.route_type, rs.route_id
`);

const ROUTE_TABLES = { bus: "routes_bus", tram: "routes_tram", trolleybus: "routes_trolleybus", metro: "routes_metro" };

router.get("/object/:type/:id", (req, res) => {
  const { type, id } = req.params;

  if (type === "address" || type === "building") {
    const b = getBuilding.get(id);
    if (!b) return res.status(404).json({ error: "not_found" });
    return res.json({
      type: "address", id: b.id, name: b.name || null,
      addr_street: withDesignation(b.addr_street), housenumber: b.housenumber, city: b.city,
      building: b.building, levels: b.levels, height: b.height,
      lat: b.lat, lon: b.lon, geometry: JSON.parse(b.geometry),
      href: objectHref.addressHref(b),
      directions: b.lat != null && b.lon != null ? transportNearby.getKakProehat(b.lat, b.lon) : null,
    });
  }

  if (type === "street") {
    const segs = getStreetSegments.all(id);
    const first = segs[0] || getStreetByName.get(decodeURIComponent(id));
    if (!first) return res.status(404).json({ error: "not_found" });

    // Sofia reuses street names across physically unrelated districts (see
    // lib/streetCluster.js) — "every segment with this name" is NOT the
    // same as "this street": it can span several real, kilometers-apart
    // streets. Only draw/zoom to the segments that are actually the same
    // physical street as the one the user picked (endpoint-connected to
    // `first`), never the whole same-named set.
    const sameName = db.prepare(`SELECT * FROM streets WHERE lower_u(name) = lower_u(?)`).all(first.name);
    const parsed = sameName.map((s) => ({ ...s, geometry: JSON.parse(s.geometry) }));
    const clusters = clusterStreetSegments(parsed);
    const myCluster =
      clusters.find((c) => c.some((s) => s.osm_id === first.osm_id)) ||
      parsed.filter((s) => s.osm_id === first.osm_id);

    // Same "lowest osm_id is the deterministic representative" convention
    // search.js's own street sub-search uses (so repeated loads/reloads
    // always land on the same directory entry) — `streetsDirectory`'s own
    // `byRepId` map is keyed off exactly that representative segment.
    const rep = myCluster.slice().sort((a, b) => a.osm_id - b.osm_id)[0];
    const dirEntry = rep ? streetsDirectory.get().byRepId.get(rep.osm_id) : null;

    return res.json({
      type: "street", id: first.osm_id, name: withDesignation(first.name), highway: first.highway,
      geometry: { type: "GeometryCollection", geometries: myCluster.map((s) => s.geometry) },
      href: dirEntry ? `/streets/${dirEntry.slug}.html` : null,
    });
  }

  if (type === "district") {
    const d = getDistrict.get(id);
    if (!d) return res.status(404).json({ error: "not_found" });
    return res.json({ type: "district", id: d.id, name: d.name, lat: d.lat, lon: d.lon, geometry: JSON.parse(d.geometry), href: objectHref.districtHref(d) });
  }

  if (type === "settlement") {
    const s = getSettlement.get(id);
    if (!s) return res.status(404).json({ error: "not_found" });
    return res.json({ type: "settlement", id: s.id, name: s.name, lat: s.lat, lon: s.lon, geometry: JSON.parse(s.geometry), href: objectHref.settlementHref(s) });
  }

  // 2026-09-15 (/raions/, /parks/ — new public sections): both come from
  // an in-memory directory (raionsDirectory's GeoJSON, parksDirectory's
  // sofia.db `parks` table), not a `db.prepare(...).get(id)` row like
  // district/settlement above — so these look the entry up via the
  // directory's own getById() rather than a SQL statement.
  if (type === "raion") {
    const r = raionsDirectory.getById(id);
    if (!r) return res.status(404).json({ error: "not_found" });
    return res.json({ type: "raion", id: r.id, name: r.name, lat: r.lat, lon: r.lon, geometry: r.geometry, href: objectHref.raionHref(r) });
  }

  if (type === "park") {
    const p = parksDirectory.getById(id);
    if (!p) return res.status(404).json({ error: "not_found" });
    return res.json({
      type: "park", id: p.id, name: p.name, typeLabel: p.typeLabel, lat: p.lat, lon: p.lon, geometry: p.geometry,
      href: objectHref.parkHref(p),
      // Unlike district/settlement above (see this file's top comment on
      // why those skip it — an area that size makes "nearest stop" not
      // mean much), a park is closer to a point-scale feature the same way
      // a company is, so "how do I get there" is a meaningful answer here.
      directions: p.lat != null && p.lon != null ? transportNearby.getKakProehat(p.lat, p.lon) : null,
    });
  }

  if (type === "company") {
    const c = getCompany.get(id);
    if (!c) return res.status(404).json({ error: "not_found" });
    return res.json({
      type: "company", id: c.id, name: c.name, rubric: c.rubric,
      addr_street: withDesignation(c.addr_street), housenumber: c.housenumber,
      phone: c.phone, website: c.website, email: c.email,
      opening_hours: c.opening_hours, wheelchair: c.wheelchair,
      lat: c.lat, lon: c.lon,
      href: objectHref.companyHref(c),
      directions: c.lat != null && c.lon != null ? transportNearby.getKakProehat(c.lat, c.lon) : null,
    });
  }

  if (type === "stop") {
    const s = getStop.get(id);
    if (!s) return res.status(404).json({ error: "not_found" });
    const routes = getStopRoutes.all(id);
    return res.json({ type: "stop", id: s.id, name: s.name, stop_type: s.stop_type, network: s.network, lat: s.lat, lon: s.lon, routes, href: objectHref.stopHref(s.stop_type, s.id) });
  }

  if (ROUTE_TABLES[type]) {
    const row = db.prepare(`SELECT * FROM ${ROUTE_TABLES[type]} WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json({ type: "route", route_type: type, id: row.id, ref: row.ref, name: row.name, operator: row.operator, from_name: row.from_name, to_name: row.to_name, href: objectHref.routeHref(type, row.id) });
  }

  res.status(400).json({ error: "unknown_type" });
});

module.exports = router;
