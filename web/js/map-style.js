// MapLibre style for the Sofia pilot: buildings extruded from
// height/levels/type (fill-extrusion), roads, landuse, water and Sofia's
// own admin boundary from sofia-base.pmtiles, plus transit stops from
// sofia-overlay.pmtiles (the only overlay layer actually rendered as a
// permanent background layer — see the note above the "overlay-stops"
// layer below for what else used to be in there and why it was cut).
// Organizations, routes, districts and settlements are rendered from
// live search/rubric results and on-demand selection instead (GeoJSON
// sources updated by map-search.js), not from vector tiles, so results
// always reflect the current query and nothing is shipped/parsed for
// them until you actually ask for it.

// ---- render-quality detection --------------------------------------------
// A public map can't assume every visitor has working GPU acceleration.
// Corporate laptops with GPU compositing disabled by policy, machines with a
// blocklisted/outdated driver (Chrome falls back silently), Linux boxes on
// Mesa llvmpipe, remote-desktop/VM sessions with no GPU passthrough — all of
// these land on a *software* WebGL rasterizer, where MapLibre still runs,
// but every frame is drawn on the CPU instead of the GPU. Data-size
// optimizations (see pipeline/sofia-schema.yml) don't touch this cost at
// all: it's a per-frame draw cost, not a tile-parsing one. The single
// biggest lever available client-side is `fill-extrusion` — 3D buildings —
// which generates side-wall geometry plus per-pixel lighting for every
// building on screen; on a software rasterizer that's the difference
// between usable and not, independent of how little data is in the tile.
// So: detect a software renderer up front and fall back to a cheap flat
// style instead of degrading in place — same data, same server, just a
// different paint. Never blocks or nags the visitor; there is no "turn on
// your GPU" banner, because for a lot of people that isn't something they
// can act on.
function detectRenderQuality() {
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") || probe.getContext("webgl");
    if (!gl) return "lite"; // no WebGL at all -> the cheapest paint we have
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    // Known software-rasterizer signatures. Not exhaustive — this is a
    // pattern match on the common real-world cases, not a benchmark — but
    // catching these covers the large majority of "GPU accel is silently
    // off" visitors without needing to render a timed test scene first.
    const isSoftware = /SwiftShader|Basic Render Driver|llvmpipe|Software Rasterizer|Mesa OffScreen|softpipe/i.test(renderer);
    return isSoftware ? "lite" : "full";
  } catch (e) {
    return "full"; // can't tell -> don't punish the common case for it
  }
}

// height -> meters, mirroring the server-side default-by-type table used
// when a building carries neither height nor building:levels.
const BUILDING_HEIGHT_EXPR = [
  "coalesce",
  ["get", "height"],
  ["*", ["get", "levels"], 3],
  [
    "match", ["get", "building"],
    ["apartments"], 15,
    ["residential"], 12,
    ["house", "detached"], 8,
    ["commercial"], 9,
    ["retail"], 6,
    ["industrial", "warehouse"], 8,
    ["office"], 15,
    ["hotel"], 18,
    ["church", "cathedral"], 22,
    ["school", "university", "hospital", "civic", "public"], 11,
    ["garage", "garages", "shed"], 3,
    8,
  ],
];

// Road name labels tiered by class (2026-09-05 fix), same idea as the
// transportation *data* tiering in pipeline/sofia-schema.yml but for
// visibility rather than bytes: a single flat minzoom for every road's
// label (the first version of this) meant motorway/trunk names — the ones
// you actually want at a city-overview scale — didn't show until the same
// zoom as residential street names. Real maps label their ring road and
// boulevards long before they label side streets. `minzoomFull` is the
// zoom the layer switches on at; `size` is the [start,end] text-size over
// a 4-zoom interpolation from there, bigger for higher-class roads.
const ROAD_LABEL_TIERS = [
  { classes: ["motorway", "trunk", "motorway_link", "trunk_link"], minzoomFull: 8, size: [13, 16] },
  { classes: ["primary", "primary_link"], minzoomFull: 10, size: [12, 15] },
  { classes: ["secondary", "secondary_link", "tertiary", "tertiary_link"], minzoomFull: 12, size: [11, 14] },
  { classes: ["unclassified", "residential", "living_street", "road"], minzoomFull: 13, size: [10, 13] },
];

// Hover emphasis (2026-09-05, revised after feedback on the first version):
// instead of a separate colored overlay drawn on top of whatever's hovered,
// buildings/roads/road-labels/quarter-labels change their OWN paint via
// MapLibre `feature-state` — the mechanism MapLibre ships specifically for
// this (see map-search.js for where `hover` state gets set/cleared: OSM
// way/node ids survive in this tileset, confirmed by inspecting
// `queryRenderedFeatures(...).id`, so `feature-state` keyed by that id is
// available and is the right tool here, not a duplicate geometry source).
// A building gets a *darker* version of its own per-type color (a shade
// shift, not a bright foreign outline); a road/its label gets *wider*/
// *bigger* — literally more of itself — rather than a new color. Only
// transit stops (`overlay-stops`, a separate Tippecanoe-built tileset with
// no feature ids — confirmed the same way) still need the old
// geometry-in-a-source approach, kept further below as `hover` / `hover-point`.
// Road line color, shared between the normal single-line "roads" layer and
// the per-lane fill layers below (LANE_LAYERS) — same color logic either
// way, so a road doesn't change color when it crosses the zoom threshold
// where individual lanes start being drawn.
// Link/ramp classes (motorway_link, trunk_link, ...) were missing from
// these match groups until 2026-09-07 — every ramp/slip road on the whole
// map (any highway=*_link way) fell through to the "#ffffff" default,
// same white as an actual unclassified/residential street, and on a ramp
// with real lane data this got drawn at full lane width, showing up as a
// wide white band cutting across an otherwise orange/yellow boulevard
// (reported: бул. България). Fixed by matching each `_link` alongside its
// parent class — a ramp now gets its parent road's color, same as OSM
// Carto and most basemaps do.
const ROAD_COLOR_EXPR = [
  "match", ["get", "highway"],
  ["motorway", "trunk", "motorway_link", "trunk_link"], "#f2b866",
  ["primary", "primary_link"], "#f7d38a",
  ["secondary", "tertiary", "secondary_link", "tertiary_link"], "#ffe7ab",
  "#ffffff",
];

const HOVER = ["boolean", ["feature-state", "hover"], false];
// One (base-color, hover-color) pair per building type, so the hover
// branch of the paint expression is a straight per-type darker match
// instead of one flat color for every building regardless of type.
const BUILDING_COLORS = [
  { match: ["church", "cathedral"], base: "#c9b8a8", hover: "#ad9e90" },
  { match: ["school", "university", "hospital", "civic", "public"], base: "#b9c6d6", hover: "#9faab8" },
  { match: ["retail", "commercial"], base: "#d8cdb8", hover: "#bab09e" },
  { match: ["industrial", "warehouse"], base: "#c9c4bd", hover: "#ada9a3" },
];
const BUILDING_DEFAULT = { base: "#d9d2c4", hover: "#bbb5a9" };
function buildingColorExpr(variant) {
  const expr = ["match", ["get", "building"]];
  for (const c of BUILDING_COLORS) expr.push(c.match, c[variant]);
  expr.push(BUILDING_DEFAULT[variant]);
  return expr;
}
const BUILDING_FILL_EXPR = ["case", HOVER, buildingColorExpr("hover"), buildingColorExpr("base")];

// ---- Per-lane road rendering (2026-09-07) ---------------------------------
// Draws each lane of a road as its own equal-width stroke instead of one
// flat-width line, with a dashed stroke between same-direction lanes, a
// solid centerline where the road carries traffic both ways, and small
// repeated chevrons marking each direction. Real per-lane GEOMETRY — the
// curved paint you'd see at an actual interchange — isn't available: OSM
// gives one centerline per road plus a lane COUNT, not per-lane shape. So
// this is deliberately schematic: straight, equal-width lanes offset from
// that one centerline, not a redraw of the true road surface. See project
// doc claude/lane-visualization.md for the data coverage behind this.
//
// Scope: only the classes pipeline/sofia-schema.yml ships lanes/oneway/
// lanes_forward/lanes_backward for (motorway through tertiary — where
// `lanes` tagging is 78-100% complete). Residential/unclassified stay a
// flat single line: their own `lanes` coverage is thin (11-31%) and
// running this many extra line layers at residential density would be
// real render cost for little payoff at the zoom side streets appear at.
// Only active from LANE_MINZOOM up — below that, individual lanes aren't
// legible and the plain "roads" line underneath (drawn for every class,
// unconditionally) is what's actually visible.
const LANE_CLASSES = [
  "motorway", "trunk", "motorway_link", "trunk_link",
  "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link",
];
const LANE_MINZOOM = 15;
// Per direction. Covers every value seen in this extract's `lanes` tag
// (1-8 total, so at most 4 each way on an even split) without the layer
// count below growing further for a handful of outliers.
const LANE_MAX_SLOTS = 4;

// Same width value reused as both each lane's own line-width and the
// per-slot line-offset unit, so lanes tile edge-to-edge with no gap or
// overlap between them. Kept as plain numbers (not the LANE_W expression
// below) so laneOffsetExpr() can fold a slot multiplier into a fresh
// top-level interpolate per layer — the style spec requires a ["zoom"]
// read to be the direct, un-nested input of its own interpolate/step, so
// `["*", LANE_W, k]` (reusing the LANE_W expression object inside more
// arithmetic) is rejected at validation, even though it evaluates fine.
const LANE_W_MIN = 2;
const LANE_W_MAX = 7.5;
const LANE_W = ["interpolate", ["linear"], ["zoom"], LANE_MINZOOM, LANE_W_MIN, 18, LANE_W_MAX];
// A perpendicular offset of `multiplier` lane-widths, as its own
// zoom-interpolated expression (see LANE_W's comment for why this can't
// just be `["*", LANE_W, multiplier]`).
function laneOffsetExpr(multiplier) {
  return ["interpolate", ["linear"], ["zoom"], LANE_MINZOOM, LANE_W_MIN * multiplier, 18, LANE_W_MAX * multiplier];
}

const LANES_TOTAL = ["to-number", ["coalesce", ["get", "lanes"], "0"]];
// Forward = the way's own digitized direction; backward = the reverse.
// Prefer an explicit lanes:forward/lanes:backward split when OSM has one
// (an uneven split, e.g. a climbing lane on a hill); otherwise derive it
// from `oneway`; failing that, split the plain lane total evenly (ceil to
// forward, floor to backward, so the two always add back up to the total
// instead of silently dropping a lane on an odd count).
const LANES_FWD = ["case",
  ["has", "lanes_forward"], ["to-number", ["get", "lanes_forward"]],
  ["==", ["get", "oneway"], "yes"], LANES_TOTAL,
  ["==", ["get", "oneway"], "-1"], 0,
  ["ceil", ["/", LANES_TOTAL, 2]],
];
const LANES_BWD = ["case",
  ["has", "lanes_backward"], ["to-number", ["get", "lanes_backward"]],
  ["==", ["get", "oneway"], "yes"], 0,
  ["==", ["get", "oneway"], "-1"], LANES_TOTAL,
  ["floor", ["/", LANES_TOTAL, 2]],
];
const LANE_CLASS_FILTER = ["in", ["get", "highway"], ["literal", LANE_CLASSES]];

function buildLaneLayers() {
  const layers = [];

  // Each lane's own fill, one layer per (direction, slot) pair — slot 1 is
  // the lane nearest the centerline. Positive line-offset means "to the
  // right of the road's own drawn direction", which in right-hand traffic
  // (Bulgaria) is exactly where that direction's own lanes belong, so
  // forward slots offset right and backward slots offset left — no need to
  // know the road's real-world compass bearing to get the side right.
  //
  // "round" caps/joins (2026-09-07 fix, reported as visible notches/holes
  // at a few intersections): Sofia's OSM ways are digitized as many short
  // segments per street, and `lanes` is tagged per way, not per street —
  // adjacent ways along the same physical road routinely disagree by one
  // lane (a real widening for a turn lane in some cases, plain tagging
  // noise in others; e.g. бул. Патриарх Евтимий runs
  // 3,2,3,3,3,3,4,5,3,3,3,3,2,3,3 lanes across consecutive short ways).
  // Each way is rendered as its own independent line feature, so a flat
  // "butt" cap made that mismatch a hard square notch exactly at the
  // shared vertex. A round cap/join doesn't fix the underlying width
  // mismatch — that would need merging/smoothing the source geometry,
  // real pipeline work, not attempted here — but it rounds that edge into
  // a soft bump and lets neighboring segments' caps overlap slightly,
  // which hides the small gaps and turns the sharp notch into something
  // that reads as an intentional taper rather than a rendering glitch.
  for (let slot = 1; slot <= LANE_MAX_SLOTS; slot++) {
    layers.push({
      id: `lane-fwd-${slot}`, type: "line", source: "base", "source-layer": "transportation",
      minzoom: LANE_MINZOOM,
      filter: ["all", LANE_CLASS_FILTER, [">=", LANES_FWD, slot]],
      paint: { "line-color": ROAD_COLOR_EXPR, "line-width": LANE_W, "line-offset": laneOffsetExpr(slot - 0.5) },
      layout: { "line-cap": "round", "line-join": "round" },
    });
    layers.push({
      id: `lane-bwd-${slot}`, type: "line", source: "base", "source-layer": "transportation",
      minzoom: LANE_MINZOOM,
      filter: ["all", LANE_CLASS_FILTER, [">=", LANES_BWD, slot]],
      paint: { "line-color": ROAD_COLOR_EXPR, "line-width": LANE_W, "line-offset": laneOffsetExpr(-(slot - 0.5)) },
      layout: { "line-cap": "round", "line-join": "round" },
    });
  }

  // Dashed white stroke between two same-direction lanes — only drawn
  // where the (slot+1)-th lane in that direction actually exists.
  const DIVIDER_W = ["interpolate", ["linear"], ["zoom"], LANE_MINZOOM, 0.5, 18, 1.4];
  for (let slot = 1; slot < LANE_MAX_SLOTS; slot++) {
    layers.push({
      id: `lane-divider-fwd-${slot}`, type: "line", source: "base", "source-layer": "transportation",
      minzoom: LANE_MINZOOM,
      filter: ["all", LANE_CLASS_FILTER, [">=", LANES_FWD, slot + 1]],
      paint: { "line-color": "#ffffff", "line-width": DIVIDER_W, "line-offset": laneOffsetExpr(slot), "line-dasharray": [2, 2] },
      layout: { "line-cap": "round", "line-join": "round" },
    });
    layers.push({
      id: `lane-divider-bwd-${slot}`, type: "line", source: "base", "source-layer": "transportation",
      minzoom: LANE_MINZOOM,
      filter: ["all", LANE_CLASS_FILTER, [">=", LANES_BWD, slot + 1]],
      paint: { "line-color": "#ffffff", "line-width": DIVIDER_W, "line-offset": laneOffsetExpr(-slot), "line-dasharray": [2, 2] },
      layout: { "line-cap": "round", "line-join": "round" },
    });
  }

  // Solid centerline where the road carries both directions — the
  // familiar "double yellow" role, continuous rather than dashed. The one
  // visual distinction this rendering draws between "lanes going the same
  // way" and "opposing traffic", from data already on the feature
  // (LANES_FWD and LANES_BWD both > 0) — no extra tagging needed.
  layers.push({
    id: "lane-divider-center", type: "line", source: "base", "source-layer": "transportation",
    minzoom: LANE_MINZOOM,
    filter: ["all", LANE_CLASS_FILTER, [">=", LANES_FWD, 1], [">=", LANES_BWD, 1]],
    paint: { "line-color": "#e8b923", "line-width": ["interpolate", ["linear"], ["zoom"], LANE_MINZOOM, 0.6, 18, 1.6] },
    layout: { "line-cap": "round", "line-join": "round" },
  });

  // Direction chevrons, repeated along the line via MapLibre's own line-
  // placement spacing — a plain "^" from the same self-hosted Basic Latin
  // glyph range every other label on this map already uses (no new font
  // or icon asset to add). `text-rotation-alignment: "map"` turns it to
  // the line's own bearing; the backward layer adds another 180° on top so
  // it points the other way. `text-offset`'s Y component, for a
  // line-placed symbol, is read in that same rotated frame — so it nudges
  // the glyph sideways into that direction's own lane block instead of
  // sitting on the shared centerline. This offset is in font-size ("em")
  // units, a different unit system than LANE_W's pixels, so it's a
  // separate best-effort constant, not derived from LANE_W — nudge
  // CHEVRON_OFFSET_EM if the chevrons don't land inside their lane block
  // at the zoom you're checking.
  const CHEVRON_OFFSET_EM = 1.6;
  const CHEVRON_LAYOUT_BASE = {
    "symbol-placement": "line", "symbol-spacing": 70,
    "text-field": "^", "text-font": ["Noto Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], LANE_MINZOOM, 11, 18, 15],
    "text-rotation-alignment": "map", "text-pitch-alignment": "map",
    "text-keep-upright": false, "text-allow-overlap": true, "text-ignore-placement": true,
  };
  layers.push({
    id: "lane-arrows-fwd", type: "symbol", source: "base", "source-layer": "transportation",
    minzoom: LANE_MINZOOM,
    filter: ["all", LANE_CLASS_FILTER, [">=", LANES_FWD, 1]],
    layout: { ...CHEVRON_LAYOUT_BASE, "text-offset": [0, -CHEVRON_OFFSET_EM] },
    paint: { "text-color": "#7a5a10", "text-opacity": 0.85 },
  });
  layers.push({
    id: "lane-arrows-bwd", type: "symbol", source: "base", "source-layer": "transportation",
    minzoom: LANE_MINZOOM,
    filter: ["all", LANE_CLASS_FILTER, [">=", LANES_BWD, 1]],
    layout: { ...CHEVRON_LAYOUT_BASE, "text-rotate": 180, "text-offset": [0, -CHEVRON_OFFSET_EM] },
    paint: { "text-color": "#7a5a10", "text-opacity": 0.85 },
  });

  return layers;
}

// ---- Railway / tram / metro (2026-09-07) -----------------------------------
// railway=rail (mainline/freight/industrial track), railway=tram (Sofia's
// tram network), railway=subway (metro, drawn semi-transparent — see that
// layer's own comment below) — see pipeline/sofia-schema.yml's "railway"
// layer comment for what's deliberately excluded (disused/construction/
// proposed/etc). Rail gets the classic two-layer "ties" look: a dark solid
// casing plus a white dashed line the same width on top, so at a glance it
// reads as railway-hatching rather than just another grey line, without
// needing an icon/sprite asset. Tram gets a single thin dashed line in a
// distinct brick-red — trams run in mixed street traffic here, so it's
// drawn as an overlay ON the street rather than its own carriageway.
//
// Main line vs. yard/depot (2026-09-07 follow-up, "стало много шума на
// удалённых масштабах" — the tangles the user circled: a metro depot fan
// at Обеля, a rail marshalling yard by ТЕЦ София): OSM tags yard/siding/
// spur/crossover trackage with `service=yard`/`siding`/`spur`/`crossover`,
// distinct from ordinary through track (`service` empty) — see
// sofia-schema.yml's comment for coverage numbers. Every mode below is
// split into a "main" filter (through track) and a "yard" filter (that
// trackage), with `*_YARD_MINZOOM` well above the main line's own minzoom
// — a depot fan or yard ladder now only appears once you're zoomed in
// close enough that it reads as "sidings", not as visual noise on the
// city-wide line. Applied to all three modes for consistency (the metro
// depot tangle the user's screenshot showed is exactly this same pattern,
// even though the request named only rail/tram).
// Shared with the station-icon layers further down (buildStopsLayers) so
// a station badge is tinted to match its own mode's line exactly, not a
// separately-chosen color.
// Muted 2026-09-07 (follow-up: "приглуши еще цвета линий метро и жд") —
// subway's flat blue and rail's neutral grey both read as too vivid next
// to the rest of the (deliberately soft/pastel) map palette. Tram is
// untouched: only metro and rail were called out.
const RAIL_LINE_COLOR = "#9c968c";
const SUBWAY_LINE_COLOR = "#5c7291";
const TRAM_LINE_COLOR = "#a83e34";

function buildRailwayLayers() {
  const YARD_SERVICES = ["yard", "siding", "spur", "crossover"];
  const SERVICE = ["coalesce", ["get", "service"], ""];
  const IS_YARD = ["in", SERVICE, ["literal", YARD_SERVICES]];
  const IS_MAIN = ["!", IS_YARD];
  const RAIL_FILTER = ["==", ["get", "railway"], "rail"];
  const TRAM_FILTER = ["==", ["get", "railway"], "tram"];
  const SUBWAY_FILTER = ["==", ["get", "railway"], "subway"];
  const RAIL_W = ["interpolate", ["linear"], ["zoom"], 11, 1, 16, 2.6];
  const YARD_MINZOOM = 16;

  return [
    // Metro (2026-09-07) — drawn semi-transparent on purpose, not
    // muted-but-solid: almost every metro way in this extract runs in
    // tunnel (`layer` -1 to -4 on nearly all of them, see
    // pipeline/sofia-schema.yml's "railway" layer comment), so a solid
    // line would overstate it as something visible on the ground the way
    // rail/tram actually are. `line-opacity` (not a lighter solid color)
    // keeps it a single flat blue at every zoom while still reading as
    // "there's a line here, underground" rather than a real surface
    // feature. No per-line coloring (M1/M2/...): the OSM `colour` tag
    // is empty on 100% of these ways in this extract, and the real
    // per-line color would need a route-relation lookup, not attempted
    // here — ask if that's wanted.
    // 2026-09-07 revision 4: switched from the tileset's "railway"
    // source-layer to the `subwayLinesGeo` plain-GeoJSON source (see its
    // long comment above the sources block) — the tileset draws two
    // parallel ways per named diameter (the doubled-line complaint).
    // 2026-09-08 revision 5: `subwayLinesGeo` itself is now built from
    // route_stops (station-to-station polyline), not tileset geometry —
    // see the long comment on that source. Not the literal tunnel curve
    // any more, but guaranteed to pass through its own stations, which
    // the tileset-derived version wasn't (see that comment for the
    // measured gap). `subway-yard` right below is untouched, still
    // reading the tileset directly.
    {
      id: "subway", type: "line", source: "subwayLinesGeo",
      minzoom: 10,
      paint: {
        "line-color": SUBWAY_LINE_COLOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 16, 3],
        "line-opacity": 0.4,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    },
    {
      id: "subway-yard", type: "line", source: "base", "source-layer": "railway",
      minzoom: YARD_MINZOOM, filter: ["all", SUBWAY_FILTER, IS_YARD],
      paint: {
        "line-color": SUBWAY_LINE_COLOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], YARD_MINZOOM, 1, 18, 2.4],
        "line-opacity": 0.4,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    },
    {
      id: "rail-casing", type: "line", source: "base", "source-layer": "railway",
      minzoom: 11, filter: ["all", RAIL_FILTER, IS_MAIN],
      paint: { "line-color": RAIL_LINE_COLOR, "line-width": RAIL_W, "line-opacity": 0.8 },
      layout: { "line-cap": "butt", "line-join": "round" },
    },
    {
      id: "rail-ties", type: "line", source: "base", "source-layer": "railway",
      minzoom: 13, filter: ["all", RAIL_FILTER, IS_MAIN],
      paint: { "line-color": "#f2f0eb", "line-width": RAIL_W, "line-dasharray": [1, 3], "line-opacity": 0.8 },
      layout: { "line-cap": "butt", "line-join": "round" },
    },
    {
      id: "rail-yard-casing", type: "line", source: "base", "source-layer": "railway",
      minzoom: YARD_MINZOOM, filter: ["all", RAIL_FILTER, IS_YARD],
      paint: {
        "line-color": RAIL_LINE_COLOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], YARD_MINZOOM, 1, 18, 2.6],
        "line-opacity": 0.8,
      },
      layout: { "line-cap": "butt", "line-join": "round" },
    },
    {
      id: "rail-yard-ties", type: "line", source: "base", "source-layer": "railway",
      minzoom: YARD_MINZOOM, filter: ["all", RAIL_FILTER, IS_YARD],
      paint: {
        "line-color": "#f2f0eb",
        "line-width": ["interpolate", ["linear"], ["zoom"], YARD_MINZOOM, 1, 18, 2.6],
        "line-dasharray": [1, 3],
        "line-opacity": 0.8,
      },
      layout: { "line-cap": "butt", "line-join": "round" },
    },
    // Tram main line raised from minzoom 13 to 15 (2026-09-07 follow-up,
    // "сами трамвайные линии тоже на пару масштабов глубже") — Sofia's
    // tram network is dense enough that even just the through lines read
    // as clutter a couple zooms out from where individual streets become
    // legible.
    {
      id: "tram", type: "line", source: "base", "source-layer": "railway",
      minzoom: 15, filter: ["all", TRAM_FILTER, IS_MAIN],
      paint: {
        "line-color": TRAM_LINE_COLOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 18, 2.4],
        "line-dasharray": [3, 2],
      },
      layout: { "line-cap": "round", "line-join": "round" },
    },
    {
      id: "tram-yard", type: "line", source: "base", "source-layer": "railway",
      minzoom: YARD_MINZOOM, filter: ["all", TRAM_FILTER, IS_YARD],
      paint: {
        "line-color": TRAM_LINE_COLOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], YARD_MINZOOM, 1, 18, 2.4],
        "line-dasharray": [3, 2],
      },
      layout: { "line-cap": "round", "line-join": "round" },
    },
  ];
}

// ---- Transit stop/station icons (2026-09-07, revision 2) -------------------
// Replaces the flat colored dots "overlay-stops" used to draw for every
// transit stop with real pictograms — own, original shapes, generated by
// pipeline/gen_stop_icons.py into web/js/stop-icons.js (loaded as a plain
// script before this file) and registered at runtime as SDF sprites by
// registerStopIcons() below (called once from map-search.js right after
// the map is created — see that file). SDF (not a fixed-color PNG) is
// what lets `icon-color` below tint the SAME shape per feature, instead
// of needing one baked image per color.
//
// Revision 1 (same day) used one plain ring for both rail and metro
// stations (color was the only difference) and flat single-tone diamond/
// square silhouettes for tram/bus stops. Revision 2 — see
// claude/icon-redesign-plan.md for the full design-review history —
// replaced both per direct user feedback ("почти всё не понятно
// интуитивно" on a first icon-set pass, and a request to push the metro
// icon much closer to a real "M + chevron" monogram):
//
// - `overlay-stations` (stop_type rail/subway) is now split by type, not
//   just by color: subway gets "metro-badge" (own geometry/proportions,
//   deliberately NOT a trace of the real Sofia Metro emblem, which is a
//   real organization's mark), rail gets "rail-badge" — own solid-pin
//   silhouette, distinguishable from the metro badge by shape alone, not
//   just by RAIL_LINE_COLOR/SUBWAY_LINE_COLOR. Everything else about this
//   layer (no minzoom, name label only below STATION_LABEL_MAXZOOM) is
//   unchanged from revision 1 — see the git history of this comment for
//   that reasoning if needed.
//   2026-09-08 revision 11 ("жд станции... теряются... в стиле метро"):
//   rail switched from "rail-ladder" (a thin two-rails-and-ties line
//   pictogram) to "rail-badge" (a solid rounded-square+tail pin, same
//   "style" as metro-badge) — see gen_stop_icons.py's draw_rail_pin
//   comment for why the thin version turned out to have the same
//   legibility problem metro-badge itself was fixed for in revision 4.
//
// - `overlay-stops` now covers only airport/other (triangle / plain dot,
//   unchanged single-tone SDF, original minzoom 14). tram_stop/bus_stop/
//   bus_terminal moved to two new stacked layers, `overlay-stops-badge` +
//   `overlay-stops-glyph`: a colored circle (mode color) with a fixed-white
//   vehicle silhouette (bus or tram, own schematic side-profile pictograms)
//   drawn on top — the common real-world transit-map pattern (colored pin +
//   white glyph), still done as two plain SDF sprites stacked at the same
//   point rather than one flat-color shape, so no PNG-per-color is needed.
function registerStopIcons(map) {
  if (typeof STOP_ICON_SPRITES === "undefined") return;
  for (const [name, sprite] of Object.entries(STOP_ICON_SPRITES)) {
    if (map.hasImage(name)) continue;
    const raw = atob(sprite.base64);
    const data = new Uint8ClampedArray(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
    // 2026-09-07 revision 3: sprites now carry their own `sdf` flag —
    // veh-bus-badge/veh-tram-badge are flat, real-color composites (see
    // gen_stop_icons.py's module docstring), everything else — including
    // metro-badge itself again since revision 10, rail-badge since
    // revision 11, and metro-badge-half-a/-b since revision 12 (replacing
    // revision 11's flat metro-badge-split/-hover, which turned out to be
    // GPU-minification-unreliable — see "overlay-stations-split-a/-b"
    // below) — stays a recolorable SDF shape.
    map.addImage(name, { width: sprite.width, height: sprite.height, data }, { sdf: sprite.sdf !== false });
  }
}

// 2026-09-07 revision 4 boosted the station-icon color to ~2x the
// saturation of SUBWAY_LINE_COLOR/RAIL_LINE_COLOR (same hue, pushed
// darker/more saturated), reasoning the exact muted line color would
// disappear on a solid icon the way it does on a 1-3px line. 2026-09-08
// revision 6: the user asked directly for the literal line color
// ("для станций иконки делаем цветом линии"), and with the shape now a
// solid fill (not the old thin ring) plus a genuinely opaque white glyph
// on top (metro's M — see gen_stop_icons.py), the unmodified color reads
// solidly enough on its own; the boost isn't needed for legibility
// either. `rail` still needs this at runtime (rail-badge, like
// rail-ladder before it, stays a recolorable SDF shape).
// 2026-09-08 revision 10 ("сделай иконки цветом линии", round 2 — each
// of the 4 real metro lines its own color): `subway.STATION_ICON_COLOR`
// below is now only the FALLBACK for a station with no single-line color
// of its own (rail, or one of the 13 real M1/M4 shared-trunk stations —
// see dedup_stations.py/station_lines()) — the real per-station color is
// `properties.line_color` on the stationsGeo feature, read via
// METRO_ICON_COLOR_EXPR just below. metro-badge went back to an SDF
// sprite for this (gen_stop_icons.py revision 10) — it does NOT ignore
// icon-color/icon-halo-* any more (that was revision 6-9's flat bake;
// see that script's docstring for the reversal).
const STATION_ICON_COLOR = {
  subway: SUBWAY_LINE_COLOR,
  rail: RAIL_LINE_COLOR,
};
// Shared between the real "overlay-stations" layer and the
// "hover-icon-metro" hover layer so a hovered station's own color can
// never drift from its un-hovered color (see buildStopsLayers()'s
// STATION_COLOR and the hover-icon-metro layer further down).
const METRO_ICON_COLOR_EXPR = ["coalesce", ["get", "line_color"], STATION_ICON_COLOR.subway];
// Same warm amber as the old generic "hover-point" circle
// (circle-color: "#c9781f" below) and gen_stop_icons.py's HOVER_COLOR —
// used for the metro hover ring (hover-icon-metro-halo), the one hover
// element that still needs a FIXED color now that the disc itself is
// colored per station.
const HOVER_RING_COLOR = "#c9781f";
// 2026-09-08 revision 12 ("на малых масштабах... красно-жёлтая, на
// больших старая иконка" — see the "overlay-stations-split-a/-b" comment
// below for the diagnosis this replaced revision 11's flat bake with):
// the M1/M4 shared-trunk stations' two colors, applied at runtime via
// ordinary icon-color paint (metro-badge-half-a/-b are plain SDF shapes
// with no color of their own) instead of baked into pixels. Same values
// as pipeline/line_colors.py's LINE_COLORS["M1"]/["M4"] — kept in sync by
// hand, same manual-sync approach as SUBWAY_LINE_COLOR/RAIL_LINE_COLOR
// already use (that Python module isn't importable from this file).
const SPLIT_COLOR_M1 = "#e5222d";
const SPLIT_COLOR_M4 = "#f8d30a";

// 2026-09-08 revision 8: gen_stop_icons.py's OUT (the native pixel size
// every sprite is baked at) went 28 -> 64 to fix "М видна но не на всех
// масштабах" (see that script's own comment on HIRES/OUT for the full
// diagnosis). icon-size is a multiplier on that native size, so every
// value below is the old value * 28/64 (=0.4375) to keep the actual
// on-screen pixel footprint exactly unchanged — this is a texture-
// resolution fix, not a "make icons bigger" one. Pulled into named
// constants (previously inline) so the new "hover-icon" layer further
// down can reference the EXACT same expression per icon kind instead of a
// second hand-copied one that could drift out of sync.
const STATION_ICON_SIZE = ["interpolate", ["linear"], ["zoom"], 8, 0.24, 12, 0.33, 18, 0.48];
const STOPBADGE_ICON_SIZE = 0.24;  // was 0.55
const STOPDOT_ICON_SIZE = 0.175;   // was 0.4

// 2026-09-08 revision 9 ("м видна на мелком масштабе... на крупных нет,
// при средних — на некоторых"): a baked-bitmap M, however much source
// resolution it's given (revision 8 quadrupled it — see gen_stop_icons.py,
// STOP_ICON_SPRITES), is still a raster image at the mercy of the GPU's
// own texture minification — and the inconsistency reported (same sprite,
// same on-screen size, legible on some station instances and not others)
// pointed at per-instance GPU sampling variance, not a resolution ceiling
// a bigger bake could reliably clear. metro-badge (gen_stop_icons.py) is
// now JUST the disc+tail, no baked letter — the M is drawn here as a real
// MapLibre text-field instead, the same SDF text engine every label on
// this map already uses and specifically built to stay crisp at any zoom.
// STATION_GLYPH_SIZE is its own top-level interpolate (text-size is a
// separate property from icon-size, so no nesting restriction applies —
// see the hover-icon-station/-flat split below for where that restriction
// DOES bite). Chosen as roughly half of STATION_ICON_SIZE's own pixel
// result at each stop (0.24*64=15.36 -> 8, 0.33*64=21.12 -> 11,
// 0.48*64=30.72 -> 16 — matches the M's own proportion inside the disc at
// revision 7's baked geometry) so the letter keeps looking the same size
// relative to the badge as the badge itself scales with zoom.
const STATION_GLYPH_SIZE = ["interpolate", ["linear"], ["zoom"], 8, 8, 12, 11, 18, 16];
// draw_metro_shape's disc is centered at (12u, 10u) in its 24u-square
// canvas — 10/24 = 0.4167 of the way down, i.e. 0.0833 of the icon's own
// height ABOVE the bounding-box center that `icon-anchor: center` (the
// default, unset here) aligns to the feature point. `text-offset` is in
// ems of text-size, and STATION_GLYPH_SIZE is a constant ~0.521 fraction
// of the badge's displayed height at every zoom stop above, so this
// offset (-0.0833 / 0.521) comes out the same constant regardless of
// zoom: text and badge scale together, so their relative offset doesn't
// need to change with them.
const STATION_GLYPH_OFFSET = [0, -0.16];

function buildStopsLayers() {
  const STATION_LABEL_MAXZOOM = 13;
  const STATION_COLOR = ["match", ["get", "stop_type"], "subway", METRO_ICON_COLOR_EXPR, STATION_ICON_COLOR.rail];
  // 2026-09-07 revision 2 (see claude/icon-redesign-plan.md): subway gets
  // its own "metro-badge" (own geometry, not a copy of the real Sofia
  // Metro emblem), rail gets its own solid-pin silhouette — previously
  // both shared the same plain ring, distinguished only by color, which
  // is what caused part of the metro/rail confusion this revision was
  // asked to fix. Rail switched from "rail-ladder" to "rail-badge" in
  // revision 11 (see that revision's note on registerStopIcons above).
  // 2026-09-08 revision 11 ("две ветки по одной линии... разделенная на
  // два цвета") originally had this branch on `line_split` too — the 13
  // real M1/M4 shared-trunk stations (dedup_stations.py) drawing a flat,
  // pre-baked "metro-badge-split" instead of plain "metro-badge". Revision
  // 12 removed that branch entirely: the flat split sprite turned out to
  // be GPU-minification-unreliable (correct at some zooms, reverted to
  // plain at others — see "overlay-stations-split-a/-b" below for the
  // full diagnosis and the fix), so STATION_ICON is back to a single
  // value per stop_type, same as it's always been for rail. The split
  // coloring itself still happens — just via two EXTRA layers stacked on
  // top of this one, not by varying what this layer's icon-image is.
  const STATION_ICON = ["match", ["get", "stop_type"], "subway", "metro-badge", "rail-badge"];
  // tram_stop/bus_stop/bus_terminal moved to their own flat "badge" sprite
  // (colored circle + white vehicle silhouette baked into one image — see
  // overlay-stops-badge below) — this layer now only covers airport/other,
  // unchanged from before (triangle / plain dot, single-tone SDF).
  const STOP_ICON = ["match", ["get", "stop_type"], "airport", "stop-triangle", "stop-dot"];
  const NON_VEHICLE_STOP_TYPES = ["bus_stop", "bus_terminal", "tram_stop"];
  const IS_VEHICLE_STOP = ["in", ["get", "stop_type"], ["literal", NON_VEHICLE_STOP_TYPES]];
  // veh-bus-badge/veh-tram-badge are flat (non-SDF) sprites with the mode
  // color (tram green / bus blue, same two colors as every earlier
  // revision) already baked in — no icon-color paint needed for them.
  const VEHICLE_GLYPH = ["match", ["get", "stop_type"], "tram_stop", "veh-tram-badge", "veh-bus-badge"];

  return [
    // 2026-09-07 revision 3: switched from the Tippecanoe "stations"
    // source-layer to the `stationsGeo` plain-GeoJSON source (see its
    // comment above the sources block) — the tileset had ~193 raw OSM
    // points for 90 real stations (station node + stop_position(s) +
    // platform(s) all separately), so a station with 2-3 nearby points
    // rendered 2-3 overlapping icons ("Станцию тоже выводим только одну
    // иконку" — fixed by centroid-deduping to exactly one feature per
    // (stop_type, name) upstream, in the GeoJSON itself, before the map
    // ever sees it).
    //
    // 2026-09-07 revision 4: icon-size increase alone (0.45/0.55/0.85 ->
    // 0.7/0.95/1.4 in revision 3) did NOT fix "иконок метро по-прежнему не
    // видно" — the actual cause was the icon SHAPE/color, not its size
    // (see gen_stop_icons.py's draw_metro_shape/draw_rail_pin comments
    // and STATION_ICON_COLOR above), so icon-size is dialed back down
    // toward revision-1 territory now that the shapes themselves carry
    // the visibility. icon-halo-width bumped 1 -> 1.6 for a bit more
    // separation from busy backgrounds (dense building fill, other
    // labels). Note: icon-halo only applies to SDF images — revisions
    // 6-9 had metro-badge as a flat bake that ignored it, but revision 10
    // (per-line station colors) put it back on SDF, so both rail-badge
    // and metro-badge get the white separation halo now. For the 13
    // M1/M4 split stations, this layer draws the badge in the neutral
    // fallback color (METRO_ICON_COLOR_EXPR has no `line_color` to
    // coalesce for them) — invisible in practice, since the two split
    // layers right below paint over the ENTIRE silhouette between them;
    // it's the halo ring from THIS instance that actually shows.
    {
      id: "overlay-stations", type: "symbol", source: "stationsGeo",
      layout: {
        "icon-image": STATION_ICON,
        "icon-size": STATION_ICON_SIZE,
        "icon-allow-overlap": true, "icon-ignore-placement": true,
        "text-field": ["step", ["zoom"], ["get", "name"], STATION_LABEL_MAXZOOM, ""],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: {
        "icon-color": STATION_COLOR,
        "icon-halo-color": "#ffffff", "icon-halo-width": 1.6,
        "text-color": "#3d3d3d",
        "text-halo-color": "#ffffff", "text-halo-width": 1.2,
      },
    },
    // 2026-09-08 revision 12 ("на малых масштабах открывается
    // красно-жёлтая, на больших старая иконка"): revision 11's
    // "metro-badge-split" was a FLAT (non-SDF) bitmap with both colors
    // baked into its pixels — real-color raster images are at the mercy
    // of the GPU's own texture minification/mip selection, which can
    // (and, per this bug report, did) produce a different visible result
    // at different zooms/instances on real hardware, even though the
    // underlying data and code were verified correct every time they were
    // checked. This project already hit and fixed the exact same bug
    // class once before for the M-letter glyph (revision 9's comment:
    // baking it bigger, revision 8, only reduced the failure rate, never
    // eliminated it — the fix was dropping the bake entirely in favor of
    // MapLibre's own SDF text engine). Same fix here: two ORDINARY SDF
    // layers instead of one flat one, each just half of metro-badge's own
    // silhouette (gen_stop_icons.py's metro-badge-half-a/-b), each
    // recolored via the normal per-feature icon-color mechanism every
    // other SDF icon in this file already uses reliably — nothing baked,
    // nothing for the GPU to minify inconsistently. The two halves
    // together cover the FULL silhouette (their masks partition it
    // exactly), so they completely hide the neutral-colored base badge
    // from "overlay-stations" above wherever they draw. Filtered to
    // `line_split == true` (only the 13 real stations), same point/size
    // as the base layer so they align pixel-for-pixel with it.
    {
      id: "overlay-stations-split-a", type: "symbol", source: "stationsGeo",
      filter: ["==", ["get", "line_split"], true],
      layout: {
        "icon-image": "metro-badge-half-a",
        "icon-size": STATION_ICON_SIZE,
        "icon-allow-overlap": true, "icon-ignore-placement": true,
      },
      paint: { "icon-color": SPLIT_COLOR_M1 },
    },
    {
      id: "overlay-stations-split-b", type: "symbol", source: "stationsGeo",
      filter: ["==", ["get", "line_split"], true],
      layout: {
        "icon-image": "metro-badge-half-b",
        "icon-size": STATION_ICON_SIZE,
        "icon-allow-overlap": true, "icon-ignore-placement": true,
      },
      paint: { "icon-color": SPLIT_COLOR_M4 },
    },
    // The metro badge's "M" monogram (2026-09-08 revision 9 — see
    // STATION_GLYPH_SIZE's comment above for why this moved off a baked
    // bitmap onto MapLibre's own text engine). Own layer, not a second
    // text-field on "overlay-stations" above (a symbol layer only gets
    // one) — same source, filtered to subway only, drawn right after so
    // it paints on top of the disc. A single-letter "text-field" needs no
    // collision box of its own (it always sits exactly on its badge,
    // which already reserved the space) — allow-overlap/ignore-placement
    // true, same as the badge.
    {
      id: "overlay-stations-glyph", type: "symbol", source: "stationsGeo",
      filter: ["==", ["get", "stop_type"], "subway"],
      layout: {
        "text-field": "M",
        "text-font": ["Noto Sans Regular"],
        "text-size": STATION_GLYPH_SIZE,
        "text-offset": STATION_GLYPH_OFFSET,
        "text-allow-overlap": true, "text-ignore-placement": true,
      },
      paint: { "text-color": "#ffffff" },
    },
    {
      id: "overlay-stops", type: "symbol", source: "overlay", "source-layer": "stops",
      minzoom: 14,
      filter: ["!", IS_VEHICLE_STOP],
      layout: {
        "icon-image": STOP_ICON,
        "icon-size": STOPDOT_ICON_SIZE,
        "icon-allow-overlap": true, "icon-ignore-placement": true,
      },
      paint: {
        "icon-color": "#1f6fd0",
        "icon-halo-color": "#ffffff", "icon-halo-width": 1,
      },
    },
    // Bus/tram "colored badge + white silhouette" — 2026-09-07 revision 2
    // drew this as two stacked SDF symbol layers (a colored circle under a
    // white vehicle silhouette). Revision 3 bakes both into ONE flat
    // sprite per mode (veh-bus-badge/veh-tram-badge, see
    // pipeline/gen_stop_icons.py) and drops the second layer entirely.
    // Reason: with two layers, turning on collision declutter
    // (icon-allow-overlap:false, needed below) reserves each point's
    // collision box on the FIRST layer that draws it; the second layer's
    // box at that same point then always reads as already-occupied and
    // gets silently dropped — badge and glyph would desync instead of
    // hiding together. One flat sprite = one symbol = one collision box,
    // so decluttering behaves like it does for every other icon/label in
    // the style.
    //
    // `icon-allow-overlap`/`icon-ignore-placement` are false (were true)
    // and icon-size bumped 0.4 -> 0.55: with overlap always allowed,
    // every stop in a cluster of nearby real bus/tram stops (legitimately
    // close together, e.g. opposite sides of a street) drew its own
    // full-size badge on top of its neighbors', reported as icons
    // "сливаются в точку" (merging into a blob). Turning overlap off lets
    // MapLibre's own collision detection drop overlapping duplicates and
    // show only one badge per cluster at a given zoom, same as labels.
    {
      id: "overlay-stops-badge", type: "symbol", source: "overlay", "source-layer": "stops",
      minzoom: 14,
      filter: IS_VEHICLE_STOP,
      layout: {
        "icon-image": VEHICLE_GLYPH,
        "icon-size": STOPBADGE_ICON_SIZE,
        "icon-allow-overlap": false, "icon-ignore-placement": false,
      },
      paint: {},
    },
  ];
}

function buildStyle(quality) {
  const lite = quality === "lite";
  return {
    version: 8,
    // Self-hosted glyph PBFs (web/fonts/) instead of an external host: round
    // 2 removed a `glyphs` pointing at protomaps.github.io because it was
    // 404-ing under this sandbox's network rules and the one label using it
    // (cluster count) wasn't worth a runtime dependency for. Street names
    // and house numbers are — vendored once from protomaps/basemaps-assets
    // (Noto Sans Regular, OFL-licensed; just the Basic Latin + Cyrillic +
    // Cyrillic Supplement ranges Bulgarian names actually need, ~290 KB
    // total) so there's no external host at runtime for anyone, on any
    // network.
    // `glyphs` stays a RELATIVE path on purpose (unlike the two `data/...`
    // refs below) — see the 2026-09-07 comment on `cityBoundary` for why
    // these two can't be treated the same.
    glyphs: "fonts/{fontstack}/{range}.pbf",
    sources: {
      // Root-absolute (leading "/"), not relative, since 2026-09-07: the
      // map app is served under a path prefix (e.g. "/map/") while
      // data/ is mounted at the SITE ROOT as its own top-level static
      // route (server/src/index.js: `app.use("/data", ...)` is separate
      // from wherever the web/ app itself is mounted) — a relative
      // "data/sofia-base.pmtiles" resolved against the PAGE's own URL
      // instead, landing on "/map/data/..." and 404ing (reported: "карта
      // перестала открываться", confirmed live — /map/data/... 404,
      // /data/... 200). `fonts/{fontstack}/{range}.pbf` right above is
      // deliberately left relative: those files live inside web/ itself,
      // so they correctly follow whatever prefix the page is served
      // under (confirmed live too — /map/fonts/... 200, /fonts/... 404).
      base: { type: "vector", url: "pmtiles:///data/sofia-base.pmtiles" },
      overlay: { type: "vector", url: "pmtiles:///data/sofia-overlay.pmtiles" },
      // Populated at runtime (map-search.js) with the geometry of whatever
      // is currently selected in the results panel — simpler and more
      // reliable than trying to match vector-tile feature ids back to our
      // own database ids for feature-state highlighting.
      selected: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      // Populated on hover (map-search.js) with a search result point's or
      // cluster's geometry — the "hover-point" layer below draws a plain
      // circle for these two, sized via each feature's own `hr` property.
      // 2026-09-08 revision 8: stops/stations used to share this same
      // source+circle too, but a fixed-radius circle can't track a real
      // icon's own zoom-dependent size or its pin-shaped (disc + off-center
      // tail) silhouette — see hoverIcon below, which replaced that for
      // stops specifically ("подсвечивается не сама иконка... измени
      // технологию").
      hover: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      // Populated on hover (map-search.js) with a transit stop/station's
      // point geometry, tagged with `iconName`/`kind` — see the
      // "hover-icon" layer below for what those drive. Same "no usable
      // feature id, so feature-state is out" situation as `hover` above
      // (this source's own comment) — kept separate from it so this one
      // can carry an actual icon-image instead of a plain circle.
      hoverIcon: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      // Populated on hover with an enlarged copy of whatever street/quarter
      // label is currently hovered ("hover-road-label"/"hover-quarter-label"
      // below) — `text-size` can't be driven by `feature-state` (it's a
      // layout property; feature-state only works in paint), so the real
      // label fades out instead (text-opacity, on the road-labels-*/
      // place-labels layers) and this stands in at a fixed larger size.
      hoverLabel: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      searchResults: { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterRadius: 45, clusterMaxZoom: 16 },
      // Sofia's own outline (Stolichna Community), pre-simplified to ~430
      // points — loaded as one small static GeoJSON file instead of from
      // OSM admin_level tags, because those don't cleanly give one shape
      // here (see pipeline/sofia-schema.yml for why). Not a vector tile
      // source: it's one polygon, cheap to fetch whole.
      cityBoundary: { type: "geojson", data: "/data/sofia-boundary.geojson" },
      // 2026-09-07 revision 3: rail/subway stations moved OFF the
      // Tippecanoe "overlay" vector tileset onto a small static GeoJSON
      // (pipeline generates it straight from sofia.db's `stops` table,
      // grouping by (stop_type, name) and taking the centroid of each
      // group) — same "one small file, fetched whole" pattern as
      // cityBoundary above. Needed because the tileset still carries every
      // OSM point per physical station (station node + stop_position(s) +
      // platform(s), ~193 rows for 90 real stations) and rebuilding the
      // tileset isn't possible in this environment (no Tippecanoe here);
      // deduping client-side via a plain GeoJSON source sidesteps that
      // entirely. 90 features (60 subway + 30 rail) — cheap to fetch whole.
      stationsGeo: { type: "geojson", data: "/data/overlay_stations.geojson" },
      // 2026-09-07 revision 4: the metro LINE itself (not the station
      // badges — see STATION_ICON_COLOR/stationsGeo above for those)
      // visibly drew as two near-parallel strands on every diameter
      // ("Линии метро достаточно одной, не надо рисовать в две стороны").
      // `sofia-base.pmtiles`'s "railway" source-layer carries, for every
      // named metro diameter, two separate OSM ways running the same
      // route a few metres apart, both tagged railway=subway with the
      // SAME name and nothing to tell them apart. Revision 4 first tried
      // fixing this by extracting the line geometry straight from the
      // tileset's own vector tiles and deduping the twin ways there
      // (pipeline/dedup_subway_lines.py) — that DID collapse it to one
      // line, but a follow-up bug report ("линии... не совпадают со
      // станциями") turned out to be real: that extracted geometry sits
      // anywhere from ~100m to ~2.7km from the real station points for a
      // large share of stations, confirmed directly (point-to-line
      // distance from every station centroid), and the gap was already
      // present in the tileset's raw geometry, not introduced by the
      // dedup — most likely a source-data precision limit away from the
      // city centre. 2026-09-08 revision 5: replaced that whole approach
      // — pipeline/build_subway_lines.py now builds this file from
      // `routes_metro`/`route_stops` (the same ordered-stop-sequence data
      // coord.js's getRouteStops already reads for bus/tram) instead of
      // the vector tiles: one LineString per real line (M1-M4), drawn
      // straight through each of its stations' own deduped centroids in
      // route order. Zero gap by construction — the line and the station
      // badge can never again visibly disagree — at the cost of the
      // wiggly real tunnel curve, a fair trade for a layer that's already
      // deliberately drawn translucent (see the `subway` layer's
      // line-opacity below). 7 of the 60 metro-tagged stations aren't
      // covered by any of the 8 routes_metro route relations in this
      // extract (checked: genuinely absent from route_stops, not a typo/
      // alias issue — see pipeline/station_name_aliases.py) and so are
      // NOT connected to a line segment; they still render as ordinary
      // station badges. `subway-yard` below is untouched, still reads
      // the tileset directly (yards/sidings were never reported as
      // doubled or misaligned).
      subwayLinesGeo: { type: "geojson", data: "/data/subway_lines.geojson" },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#eef1f3" } },
      {
        id: "landuse", type: "fill", source: "base", "source-layer": "landuse",
        paint: {
          "fill-color": [
            "match", ["coalesce", ["get", "leisure"], ["get", "landuse"], ["get", "natural"]],
            "park", "#d5ecc4", "garden", "#d5ecc4", "pitch", "#c9e8b8", "playground", "#c9e8b8",
            "wood", "#c8e0b4", "scrub", "#dbe6c6", "grassland", "#e0ecd0",
            "residential", "#eae7e2", "commercial", "#e8dfe3", "industrial", "#e6e1de",
            "cemetery", "#d6ddd0", "wetland", "#cfe3e6",
            "#e5e2dd",
          ],
        },
      },
      { id: "water", type: "fill", source: "base", "source-layer": "water", paint: { "fill-color": "#aad3e0" } },
      // Casing (a wider white line drawn under the colored road line, for
      // the "road with an outline" look) doubles the fill-rate cost of the
      // roads layer — every road pixel gets drawn twice, once per layer.
      // On a software rasterizer that's a real cost for no data reason, so
      // it's dropped in "lite": roads still render, just without the
      // outline. Skipping this whole layer object (not just hiding it) so
      // it isn't sent to the GPU/CPU pipeline at all.
      ...(lite
        ? []
        : [{
            id: "roads-casing", type: "line", source: "base", "source-layer": "transportation",
            paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 16, 6] },
            layout: { "line-cap": "round", "line-join": "round" },
          }]),
      {
        id: "roads", type: "line", source: "base", "source-layer": "transportation",
        paint: {
          "line-color": ROAD_COLOR_EXPR,
          // Hover = the same line, just wider (see HOVER/feature-state note
          // above `ROAD_LABEL_TIERS`) — no color change, per the request to
          // emphasize streets by width rather than an unrelated highlight
          // color. The style spec allows only one zoom-based
          // interpolate/step per expression, so the hover/base split has to
          // live INSIDE each stop's value, not as two separate interpolate
          // calls wrapped in an outer `case`.
          "line-width": ["interpolate", ["linear"], ["zoom"],
            10, ["case", HOVER, 1.6, 0.6],
            16, ["case", HOVER, 7, 4.5],
          ],
          // Explicit, not just relying on the default — same "деliberate,
          // documented smoothness" reasoning as place-labels' text-opacity
          // above (2026-09-05).
          "line-width-transition": { duration: 220 },
        },
        layout: { "line-cap": "round", "line-join": "round" },
      },
      // Per-lane rendering (see buildLaneLayers() above) draws on top of
      // the flat "roads" line above once a qualifying road has lane data
      // and the zoom crosses LANE_MINZOOM — the flat line stays underneath
      // for every other road/zoom, so nothing needs to hide it.
      ...buildLaneLayers(),
      // Invisible, generously-wide hit target for streets (2026-09-05,
      // same complaint and same fix shape as `place-labels-hit` above) — a
      // street's rendered line is only 0.6-4.5px wide (see "roads" above),
      // thinner than a quarter name's own text glyphs at most zooms. Hit-
      // testing the visible line directly meant aiming at a hairline, so
      // real cursor jitter made the highlight flicker on/off constantly
      // ("улицы продолжают сильно мельтешить"). Same trick as the quarter
      // fix: an invisible line, much wider than what's drawn, along the
      // exact same geometry — MapLibre hit-tests it by its real (wide)
      // geometry, not by visible pixels. All road hover/click code below
      // targets THIS layer instead of "roads"/"road-labels-N" directly;
      // feature-state set through it still drives both of those, since all
      // three read the same `{source: "base", sourceLayer: "transportation",
      // id}`. Width grows with zoom as a rough echo of the real line's own
      // width curve, not a fixed pixel value, so it stays comfortably
      // bigger than the line at every zoom without swallowing whole
      // neighboring streets in a dense grid at the closest zooms.
      {
        id: "roads-hit", type: "line", source: "base", "source-layer": "transportation",
        paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 10, 14, 16, 22], "line-opacity": 0 },
        layout: { "line-cap": "round", "line-join": "round" },
      },
      ...buildRailwayLayers(),
      {
        id: "city-boundary", type: "line", source: "cityBoundary",
        paint: { "line-color": "#9a6bb0", "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.7 },
        maxzoom: 13,
      },
      // Buildings: full 3D extrusion on real GPU acceleration, flat 2D fill
      // ("lite") on a detected software rasterizer. Same color logic either
      // way — a flat building footprint colored by type reads fine on its
      // own; it just skips the side-wall geometry and per-pixel lighting
      // that make fill-extrusion so much more expensive to rasterize on a
      // CPU. `BUILDING_HEIGHT_EXPR` (unused in lite mode) is still computed
      // in `full` from raw tags, not baked into tiles — see its own comment.
      lite
        ? {
            // minzoom 14 (one higher than full/tile minzoom 13): on a
            // software rasterizer, the zoom range where buildings first
            // appear is exactly where a wheel-zoom animation crosses many
            // frames per tick — delaying building fill by one zoom level
            // trims fill-rate right where it's most visible as stutter.
            id: "buildings", type: "fill", source: "base", "source-layer": "building",
            minzoom: 14,
            paint: {
              // Hover = a darker shade of the SAME per-type color (see
              // BUILDING_FILL_EXPR above) rather than a bright outline —
              // reads as "this one" without looking like a decal on top.
              "fill-color": BUILDING_FILL_EXPR,
              "fill-color-transition": { duration: 220 },
              "fill-outline-color": "#bdb2a0",
            },
          }
        : {
            id: "buildings", type: "fill-extrusion", source: "base", "source-layer": "building",
            minzoom: 13,
            paint: {
              "fill-extrusion-color": BUILDING_FILL_EXPR,
              "fill-extrusion-color-transition": { duration: 220 },
              "fill-extrusion-height": BUILDING_HEIGHT_EXPR,
              "fill-extrusion-base": 0,
              "fill-extrusion-opacity": 0.9,
            },
          },
      lite
        ? {
            id: "selected-fill", type: "fill", source: "selected",
            filter: ["==", ["geometry-type"], "Polygon"],
            paint: { "fill-color": "#dc5040", "fill-opacity": 0.6, "fill-outline-color": "#9f2f24" },
          }
        : {
            id: "selected-fill", type: "fill-extrusion", source: "selected",
            filter: ["==", ["geometry-type"], "Polygon"],
            paint: { "fill-extrusion-color": "#dc5040", "fill-extrusion-height": 20, "fill-extrusion-opacity": 0.85 },
          },
      lite
        ? {
            id: "selected-fill-mp", type: "fill", source: "selected",
            filter: ["==", ["geometry-type"], "MultiPolygon"],
            paint: { "fill-color": "#dc5040", "fill-opacity": 0.6, "fill-outline-color": "#9f2f24" },
          }
        : {
            id: "selected-fill-mp", type: "fill-extrusion", source: "selected",
            filter: ["==", ["geometry-type"], "MultiPolygon"],
            paint: { "fill-extrusion-color": "#dc5040", "fill-extrusion-height": 20, "fill-extrusion-opacity": 0.85 },
          },
      {
        id: "selected-line", type: "line", source: "selected",
        filter: ["any", ["==", ["geometry-type"], "LineString"], ["==", ["geometry-type"], "MultiLineString"]],
        paint: { "line-color": "#dc5040", "line-width": 5, "line-opacity": 0.9 },
      },
      {
        id: "selected-point", type: "circle", source: "selected",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 9, "circle-color": "#9f2f24", "circle-stroke-color": "#fff", "circle-stroke-width": 3 },
      },
      // No cluster-count text label and no always-on background "overlay
      // routes" layer: the label needed an external glyphs host
      // (protomaps.github.io — an unreviewed runtime dependency, and it was
      // 404-ing under this sandbox's network restrictions) for a number
      // that the cluster circle's own size/color steps already communicate
      // approximately. The background routes layer drew all 289 transit
      // routes, city-wide, all the time, as straight lines directly
      // connecting each route's stops in order (not the real street path) —
      // that's the "что за пунктиры" clutter cutting across every screen.
      // A specific route's *real* stop-to-stop path is still drawn
      // accurately when you select it from search (map-search.js
      // renderRouteSelected -> the "selected" source below) — that's the
      // only place route lines are actually needed.
      ...buildStopsLayers(),
      // Quarter/neighbourhood names (2026-09-05) — the level between "whole
      // city" and "single street" (ж.к. Младост, ж.к. Люлин, ...; see
      // pipeline/sofia-schema.yml for why only the point tag is used, not
      // the boundary relations too). Placed BEFORE the road-label tiers
      // below on purpose: MapLibre gives earlier layers first claim on
      // label space when two labels would overlap, and a quarter name is
      // the more useful one to keep at the zoom where both could collide.
      {
        id: "place-labels", type: "symbol", source: "base", "source-layer": "place",
        minzoom: lite ? 11 : 10,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 13, 15, 16],
          "text-letter-spacing": 0.02,
          "text-transform": "uppercase",
        },
        paint: {
          "text-color": "#6b5f4a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
          // Hover = larger text, same "more of itself" treatment as the
          // road labels below — but `text-size` is a LAYOUT property, and
          // the style spec doesn't allow `feature-state` in layout
          // properties (paint only). So the enlarged version is a second,
          // fixed-larger label drawn from the `hoverLabel` source
          // (`hover-quarter-label`, near the end of this file) and THIS
          // copy just fades out (text-opacity, which IS paint) wherever
          // it's hovered, so the two never show at once. Explicit
          // transition (not just the 300ms default) so it's a deliberate,
          // documented part of "плавные реакции" (2026-09-05) rather than
          // an accident of whatever MapLibre defaults to. Bumped from the
          // original 220ms to 320ms after feedback that even the fixed
          // (2026-09-05) quarter-label reveal could still read a touch
          // faster than "плавно".
          "text-opacity": ["case", HOVER, 0, 1],
          "text-opacity-transition": { duration: 320 },
        },
      },
      // Invisible, generously-sized hit target for quarter names
      // (2026-09-05) — a name is just a short line of text at a point;
      // hovering/clicking the glyphs themselves (`place-labels` above) means
      // aiming at a target only a few CSS pixels tall, and the reported
      // symptom was exactly that: the highlight flickering on/off as the
      // real cursor jittered in and out of that sliver, and clicks landing
      // just off it and falling through to the generic "empty map spot"
      // handler instead of opening the quarter's popup. This circle is
      // centered on the same point, fixed screen-pixel radius (not
      // geography-scaled, so it stays comfortable at every zoom the label
      // itself is visible), and `circle-opacity: 0` — MapLibre still hit-
      // tests it by its actual rendered geometry, not by visible pixels, so
      // an invisible circle is a fully legitimate (and common) hit-area
      // trick. All hover/click code below targets THIS layer instead of
      // `place-labels` directly; feature-state set through it still drives
      // `place-labels`' own opacity above, since both read the same
      // `{source: "base", sourceLayer: "place", id}`.
      {
        id: "place-labels-hit", type: "circle", source: "base", "source-layer": "place",
        minzoom: lite ? 11 : 10,
        paint: { "circle-radius": 20, "circle-opacity": 0 },
      },
      // Street names on the map itself (2026-09-05) — separate from search,
      // which already found streets fine; this is what draws their names
      // along the road so the map is legible without searching first. Text
      // layout/collision runs off the main thread in a worker, so this
      // isn't competing with the per-frame cost the render-quality work
      // above was about — it only needs its own `minzoom` kept sane so
      // idle "lite" tab isn't laying out thousands of labels at once.
      // Tiered by road class (ROAD_LABEL_TIERS, top of file) instead of one
      // flat minzoom — see that constant's comment for why a single
      // minzoom was itself the bug reported 2026-09-05 (motorway/trunk
      // names weren't showing at an overview scale where they should).
      // `["has","name"]` naturally excludes the untagged lowest road tier
      // (service/footway/...), which was never given a `name` attribute in
      // pipeline/sofia-schema.yml.
      ...ROAD_LABEL_TIERS.map((tier, i) => ({
        id: `road-labels-${i}`,
        type: "symbol", source: "base", "source-layer": "transportation",
        filter: ["all", ["has", "name"], ["match", ["get", "highway"], tier.classes, true, false]],
        minzoom: lite ? tier.minzoomFull + 1 : tier.minzoomFull,
        layout: {
          "symbol-placement": "line",
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], tier.minzoomFull, tier.size[0], tier.minzoomFull + 4, tier.size[1]],
          "symbol-spacing": 300,
          "text-letter-spacing": 0.01,
        },
        paint: {
          "text-color": "#4a4640",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
          // Same id space as the "roads" line above (feature-state keyed by
          // {source: "base", sourceLayer: "transportation", id}), so
          // hovering either the line or a label lights up both, and every
          // segment sharing the street's name together (map-search.js sets
          // it on all of them, not just the one under the pointer). The
          // enlarged hover text itself isn't drawn here, though — `text-size`
          // is a layout property, and feature-state only works in paint —
          // so this copy fades out (text-opacity) and a separate, bigger
          // label from the `hoverLabel` source (`hover-road-label`, near
          // the end of this file) takes its place.
          "text-opacity": ["case", HOVER, 0, 1],
          "text-opacity-transition": { duration: 220 },
        },
      })),
      // House numbers (2026-09-05) — only ever useful once you're zoomed to
      // street level, so gated well above where buildings themselves start
      // rendering (minzoom 13/14): showing a number on every one of
      // 132,920 buildings from the moment they appear would be pure
      // clutter, not to mention a lot of glyph layout for no reason at
      // that zoom. Only buildings with a direct `addr:housenumber` OSM tag
      // carry this field (~39,500 of 132,920) — see sofia-schema.yml.
      {
        id: "address-labels", type: "symbol", source: "base", "source-layer": "building",
        filter: ["has", "housenumber"],
        minzoom: lite ? 18 : 17,
        layout: {
          "text-field": ["get", "housenumber"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
        },
        paint: {
          "text-color": "#6b6459",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
        },
      },
      // Search result markers (points + clusters) — placed AFTER
      // address-labels on purpose (2026-09-05 fix). They used to sit right
      // after "selected-point", earlier in the draw order than
      // address-labels, so at building zoom a search point's marker and
      // that same building's own housenumber label (both anchored at
      // essentially the same spot, since the geocoded address point sits at
      // the building's centroid) drew in the wrong order: the plain text
      // digits painted on top of, and interleaved with, the small solid
      // dot — e.g. a "16" housenumber and a search-point dot merging into
      // an illegible "①6"-looking blob ("непонятные значки на домах").
      // Moving these two layers to draw after address-labels makes the
      // marker cleanly cover the number instead of fighting with it.
      {
        id: "search-points", type: "circle", source: "searchResults",
        filter: ["!", ["has", "point_count"]],
        paint: { "circle-radius": 6, "circle-color": "#dc5040", "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      },
      {
        id: "search-clusters", type: "circle", source: "searchResults",
        filter: ["has", "point_count"],
        paint: {
          "circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 30, 22],
          "circle-color": ["step", ["get", "point_count"], "#dc5040", 10, "#c74437", 30, "#9f2f24"],
          "circle-stroke-color": "#fff", "circle-stroke-width": 2,
        },
      },
      // Hover highlight for point objects without a stable tile feature id
      // (2026-09-05) — every other hoverable layer (buildings, roads/their
      // labels, quarter labels) uses `feature-state` directly on its own
      // paint now (see the HOVER note above ROAD_LABEL_TIERS). Three layers
      // can't: transit stops come from `sofia-overlay.pmtiles`, a separate
      // Tippecanoe-built tileset that (confirmed via
      // `queryRenderedFeatures(...).id`) carries no feature ids; search
      // result points/clusters are supercluster-managed (map-search.js's
      // `searchResults` geojson source, `cluster: true`) and can be
      // reshuffled by zoom/data changes, so pinning a highlight to one via
      // feature-state would be fragile. 2026-09-08 revision 8: stops used
      // to share this fallback too, but a fixed-radius circle can't track a
      // real icon's zoom-dependent size or its pin-shaped silhouette — see
      // "hover-icon" right below, which now covers stops/stations
      // specifically. This circle remains the fallback for search result
      // points/clusters only (still no stable id for those). Same warm
      // color as the amber accent used for the popup link, not the red
      // used for a confirmed "selected" search result. Radius is
      // data-driven (`hr` on the pushed feature, map-search.js) so a
      // single search point and a cluster (sized roughly to its own
      // on-map circle) each get an appropriately-sized ring.
      {
        id: "hover-point", type: "circle", source: "hover",
        paint: {
          "circle-radius": ["coalesce", ["get", "hr"], 6.5],
          "circle-color": "#c9781f", "circle-opacity": 0.3, "circle-stroke-color": "#c9781f", "circle-stroke-width": 2,
        },
      },
      // Hover highlight for stops/stations (2026-09-08 revision 8 —
      // "подсвечивается не сама иконка... измени технологию"). Instead of
      // approximating the real icon with a circle (the old shared
      // `hover-point` above), this draws a `*-hover` sprite — the SAME
      // icon baked with a highlight ring traced around its own real
      // silhouette (see gen_stop_icons.py's render_hover) — at the exact
      // same `icon-size` expression per kind (STATION_ICON_SIZE/
      // STOPBADGE_ICON_SIZE/STOPDOT_ICON_SIZE, the same constants the real
      // layers above use), so the highlight always exactly matches the
      // real icon's outline and scale at whatever zoom it's shown at.
      // `iconName`/`kind` are set on the single feature pushed into
      // `hoverIcon` (map-search.js's setHoverIcon), computed there from
      // the same `stop_type` values STATION_ICON/STOP_ICON/VEHICLE_GLYPH
      // above already match on.
      // Split into two layers, not one with a `match`-branched icon-size:
      // MapLibre rejects a `["zoom"]` expression (which STATION_ICON_SIZE's
      // `interpolate` uses internally) anywhere except as the direct,
      // top-level input to a `step`/`interpolate` call — nesting it inside
      // a `match` branch, even as the default/fallback value, fails style
      // validation ("zoom expression may only be used as input to a
      // top-level step or interpolate expression"; confirmed by trying it
      // first — see this layer's git history). stopBadge/stopDot were
      // never zoom-dependent to begin with (the real layers use flat
      // STOPBADGE_ICON_SIZE/STOPDOT_ICON_SIZE numbers), so splitting by
      // `kind` into "needs the zoom curve" vs "doesn't" sidesteps the
      // restriction entirely — `hoverIcon` only ever holds at most one
      // feature, so at most one of these two ever actually draws.
      // Rail (kind: "station") — single-line metro AND the split M1/M4
      // stations both moved to live SDF layer stacks below (revision 10 for
      // single-line, revision 12 for split). rail-badge-hover is still a
      // flat "*-hover" composite (ring + fixed color baked into one
      // sprite) — that only works because rail's color is a fixed
      // constant, never per-feature (always RAIL_LINE_COLOR). Metro is the
      // case whose color genuinely varies per feature or per half, so it's
      // the case that needs the live SDF stacks instead.
      {
        id: "hover-icon-station", type: "symbol", source: "hoverIcon",
        filter: ["==", ["get", "kind"], "station"],
        layout: {
          "icon-image": ["get", "iconName"],
          "icon-size": STATION_ICON_SIZE,
          "icon-allow-overlap": true, "icon-ignore-placement": true,
        },
      },
      // Metro hover (2026-09-08 revision 10, "сделай иконки цветом линии"
      // round 2): now that metro-badge is recolored per FEATURE (own
      // line's color, METRO_ICON_COLOR_EXPR), a flat "metro-badge-hover"
      // bake can no longer carry both a fixed ring color AND the right
      // per-station disc color in one image — see gen_stop_icons.py's
      // render_dilated comment for the full reasoning. Two ordinary SDF
      // layers stacked at the one hovered point instead: the grown
      // silhouette ("metro-badge-halo") drawn first in a fixed amber ring
      // color, then a second real "metro-badge" instance on top, colored
      // via the SAME METRO_ICON_COLOR_EXPR the real station layer uses (its
      // `line_color` is carried through onto the pushed hoverIcon feature
      // by setHighlightForFeature in map-search.js) — so hovering a
      // station never changes its own color, it only adds the ring behind
      // it. `kind: "station-metro"` (not "station") keeps this out of the
      // rail branch above and the "flat" branch below. The halo fires for
      // every metro station including split ones (the ring is always the
      // same fixed color regardless), but the plain single-color disc below
      // must NOT draw for the 13 split stations — those get their own two
      // half-colored layers instead, right after this one.
      {
        id: "hover-icon-metro-halo", type: "symbol", source: "hoverIcon",
        filter: ["==", ["get", "kind"], "station-metro"],
        layout: {
          "icon-image": "metro-badge-halo",
          "icon-size": STATION_ICON_SIZE,
          "icon-allow-overlap": true, "icon-ignore-placement": true,
        },
        paint: { "icon-color": HOVER_RING_COLOR },
      },
      {
        id: "hover-icon-metro", type: "symbol", source: "hoverIcon",
        filter: ["all", ["==", ["get", "kind"], "station-metro"], ["!=", ["get", "line_split"], true]],
        layout: {
          "icon-image": "metro-badge",
          "icon-size": STATION_ICON_SIZE,
          "icon-allow-overlap": true, "icon-ignore-placement": true,
        },
        paint: { "icon-color": METRO_ICON_COLOR_EXPR },
      },
      // Hovered M1/M4 split stations (2026-09-08 revision 12): same
      // half-a/half-b SDF pair as "overlay-stations-split-a/-b" above,
      // fixed M1 red / M4 yellow, drawn on top of the halo. Replaces
      // revision 11's flat "metro-badge-split-hover" bake, which is what
      // turned out to be the GPU-minification-unreliable piece (see that
      // layer's removal note above "overlay-stations-split-a"). `line_split`
      // is carried through onto the pushed hoverIcon feature by
      // setHoverIcon in map-search.js, same as `line_color` already was.
      {
        id: "hover-icon-metro-half-a", type: "symbol", source: "hoverIcon",
        filter: ["all", ["==", ["get", "kind"], "station-metro"], ["==", ["get", "line_split"], true]],
        layout: {
          "icon-image": "metro-badge-half-a",
          "icon-size": STATION_ICON_SIZE,
          "icon-allow-overlap": true, "icon-ignore-placement": true,
        },
        paint: { "icon-color": SPLIT_COLOR_M1 },
      },
      {
        id: "hover-icon-metro-half-b", type: "symbol", source: "hoverIcon",
        filter: ["all", ["==", ["get", "kind"], "station-metro"], ["==", ["get", "line_split"], true]],
        layout: {
          "icon-image": "metro-badge-half-b",
          "icon-size": STATION_ICON_SIZE,
          "icon-allow-overlap": true, "icon-ignore-placement": true,
        },
        paint: { "icon-color": SPLIT_COLOR_M4 },
      },
      // Same "M" text-field as "overlay-stations-glyph" above, redrawn for
      // the hovered metro station specifically — hover-icon-metro-halo plus
      // whichever of hover-icon-metro / the two half layers actually drew
      // paint over (draw on top of, in layer order) the real station's own
      // glyph, so it needs to be repainted here. rail-badge-hover
      // (kind: "station") has no letter, hence this doesn't just fire for
      // kind == "station" wholesale. Split stations (2026-09-08 revision
      // 12) now also stay kind: "station-metro" like every other metro
      // station (no more separate flat "*-hover" bake), so a plain
      // kind == "station-metro" filter covers all metro stations, split or
      // not, without needing the old iconName special-case.
      {
        id: "hover-icon-station-glyph", type: "symbol", source: "hoverIcon",
        filter: ["==", ["get", "kind"], "station-metro"],
        layout: {
          "text-field": "M",
          "text-font": ["Noto Sans Regular"],
          "text-size": STATION_GLYPH_SIZE,
          "text-offset": STATION_GLYPH_OFFSET,
          "text-allow-overlap": true, "text-ignore-placement": true,
        },
        paint: { "text-color": "#ffffff" },
      },
      {
        id: "hover-icon-flat", type: "symbol", source: "hoverIcon",
        filter: ["!", ["in", ["get", "kind"], ["literal", ["station", "station-metro"]]]],
        layout: {
          "icon-image": ["get", "iconName"],
          "icon-size": ["match", ["get", "kind"], "stopBadge", STOPBADGE_ICON_SIZE, STOPDOT_ICON_SIZE],
          "icon-allow-overlap": true, "icon-ignore-placement": true,
        },
      },
      // Enlarged hover labels (2026-09-05) — the `text-size` half of "make
      // hovered streets/quarters bigger", standing in for the real
      // road-labels-*/place-labels layers exactly where those fade out
      // (text-opacity, feature-state) since `feature-state` can't drive a
      // layout property directly. `hoverLabel`'s data (map-search.js) is
      // either every rendered segment of the currently-hovered street's
      // name (as separate LineStrings, so `symbol-placement: line` repeats
      // the label along each one, same as the real layer would) or a
      // single quarter-name point — never both, and empty otherwise.
      // `text-opacity` starts at 1 here but map-search.js's
      // `showHoverLabel` actually drives it (0 right before the new data
      // lands, then back to 1 one animation frame later — the same
      // "set the end state a frame late" trick `revealPopup` uses for the
      // popup's own fade-in) so growing into the bigger label reads as a
      // soft grow-in rather than an instant pop, addressing the "плавные
      // реакции" feedback (2026-09-05) — a plain data swap on a GeoJSON
      // source has no fade of its own, so without this the label would
      // otherwise always appear at full size the instant the data updates,
      // however smooth `place-labels`'/road-labels-*'s own fade-out is.
      {
        id: "hover-road-label", type: "symbol", source: "hoverLabel",
        filter: ["==", ["get", "kind"], "road"],
        layout: {
          "symbol-placement": "line",
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          // Data-driven, not a flat zoom curve (2026-09-05, "надпись вообще
          // пропадает" fix) — `map-search.js`'s `roadHoverLabelSize` computes
          // this per hover, scaled off the SAME road's own tier size
          // (`ROAD_LABEL_TIERS`) instead of one size-fits-all, because a
          // flat curve going up to 26px needs far more line length to fit
          // than a short residential street's own (already short) OSM ways
          // ever have — confirmed by testing that shrinking this all the
          // way down to a flat 8px still failed to render on the reported
          // street, before the real fix (line-merging, same file, "Joins
          // LineString..." comment) closed most of the gap and this
          // tier-relative sizing closed the rest. `coalesce` just guards
          // against a feature that somehow arrives without `size` set.
          "text-size": ["coalesce", ["get", "size"], 18],
          "symbol-spacing": 300,
          "text-letter-spacing": 0.01,
        },
        paint: {
          "text-color": "#4a4640", "text-halo-color": "#ffffff", "text-halo-width": 1.3,
          "text-opacity": 1, "text-opacity-transition": { duration: 220 },
        },
      },
      {
        id: "hover-quarter-label", type: "symbol", source: "hoverLabel",
        filter: ["==", ["get", "kind"], "quarter"],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 17.5, 15, 21.5],
          "text-letter-spacing": 0.02,
          "text-transform": "uppercase",
        },
        paint: {
          "text-color": "#6b5f4a", "text-halo-color": "#ffffff", "text-halo-width": 1.6,
          // Matches place-labels' own 320ms above so the real label fading
          // out and this stand-in growing in read as one continuous
          // crossfade rather than two independently-timed animations.
          "text-opacity": 1, "text-opacity-transition": { duration: 320 },
        },
      },
    ],
  };
}
