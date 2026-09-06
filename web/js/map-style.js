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
    glyphs: "fonts/{fontstack}/{range}.pbf",
    sources: {
      base: { type: "vector", url: "pmtiles://data/sofia-base.pmtiles" },
      overlay: { type: "vector", url: "pmtiles://data/sofia-overlay.pmtiles" },
      // Populated at runtime (map-search.js) with the geometry of whatever
      // is currently selected in the results panel — simpler and more
      // reliable than trying to match vector-tile feature ids back to our
      // own database ids for feature-state highlighting.
      selected: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      // Populated on hover (map-search.js) with a transit stop's point
      // geometry when one's hovered — the one hoverable layer without
      // usable feature ids, so it can't use `feature-state` like everything
      // else (see the "hover-point" layer below for why).
      hover: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
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
      cityBoundary: { type: "geojson", data: "data/sofia-boundary.geojson" },
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
          "line-color": [
            "match", ["get", "highway"],
            ["motorway", "trunk"], "#f2b866",
            ["primary"], "#f7d38a",
            ["secondary", "tertiary"], "#ffe7ab",
            "#ffffff",
          ],
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
      {
        id: "overlay-stops", type: "circle", source: "overlay", "source-layer": "stops",
        minzoom: 14,
        paint: {
          "circle-radius": 3.5,
          "circle-color": ["match", ["get", "stop_type"], "subway", "#d0001f", "tram_stop", "#0a8a3c", "rail", "#c98a1f", "#1f6fd0"],
          "circle-stroke-color": "#fff", "circle-stroke-width": 1,
        },
      },
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
      // feature-state would be fragile. This one small geojson-source-driven
      // circle is the shared fallback for all three. Same warm color as the
      // amber accent used for the popup link, not the red used for a
      // confirmed "selected" search result. Radius is data-driven (`hr` on
      // the pushed feature, map-search.js) so a stop, a single search point,
      // and a cluster (sized roughly to its own on-map circle) each get an
      // appropriately-sized ring; falls back to the original fixed stop
      // radius when `hr` isn't set.
      {
        id: "hover-point", type: "circle", source: "hover",
        paint: {
          "circle-radius": ["coalesce", ["get", "hr"], 6.5],
          "circle-color": "#c9781f", "circle-opacity": 0.3, "circle-stroke-color": "#c9781f", "circle-stroke-width": 2,
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
