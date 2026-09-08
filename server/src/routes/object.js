const express = require("express");
const db = require("../db");
const { clusterStreetSegments } = require("../lib/streetCluster");
const { withDesignation } = require("../lib/streetDesignation");

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

    return res.json({
      type: "street", id: first.osm_id, name: withDesignation(first.name), highway: first.highway,
      geometry: { type: "GeometryCollection", geometries: myCluster.map((s) => s.geometry) },
    });
  }

  if (type === "district") {
    const d = getDistrict.get(id);
    if (!d) return res.status(404).json({ error: "not_found" });
    return res.json({ type: "district", id: d.id, name: d.name, lat: d.lat, lon: d.lon, geometry: JSON.parse(d.geometry) });
  }

  if (type === "settlement") {
    const s = getSettlement.get(id);
    if (!s) return res.status(404).json({ error: "not_found" });
    return res.json({ type: "settlement", id: s.id, name: s.name, lat: s.lat, lon: s.lon, geometry: JSON.parse(s.geometry) });
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
    });
  }

  if (type === "stop") {
    const s = getStop.get(id);
    if (!s) return res.status(404).json({ error: "not_found" });
    const routes = getStopRoutes.all(id);
    return res.json({ type: "stop", id: s.id, name: s.name, stop_type: s.stop_type, network: s.network, lat: s.lat, lon: s.lon, routes });
  }

  if (ROUTE_TABLES[type]) {
    const row = db.prepare(`SELECT * FROM ${ROUTE_TABLES[type]} WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json({ type: "route", route_type: type, id: row.id, ref: row.ref, name: row.name, operator: row.operator, from_name: row.from_name, to_name: row.to_name });
  }

  res.status(400).json({ error: "unknown_type" });
});

module.exports = router;
