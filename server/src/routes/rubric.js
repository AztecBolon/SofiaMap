const express = require("express");
const db = require("../db");
const { withDesignation } = require("../lib/streetDesignation");

const router = express.Router();

const stmt = db.prepare(`
  SELECT id, name, addr_street, housenumber, lat, lon FROM organizations
  WHERE rubric = @rubric
  ORDER BY name
  LIMIT 500
`);
const countStmt = db.prepare(`SELECT COUNT(*) as c FROM organizations WHERE rubric = @rubric`);

router.get("/rubric/:name", (req, res) => {
  const rubric = decodeURIComponent(req.params.name);
  const total = countStmt.get({ rubric }).c;
  const rows = stmt.all({ rubric });
  const items = rows.map((r) => ({
    id: r.id,
    type: "company",
    name: r.name,
    subtitle: [withDesignation(r.addr_street), r.housenumber].filter(Boolean).join(" "),
    lat: r.lat,
    lng: r.lon,
    map_key: `company:${r.id}`,
  }));
  res.json({
    meta: { name: rubric, total, returned: items.length, partial: total > items.length },
    items,
  });
});

module.exports = router;
