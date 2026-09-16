// Live map widget for any server-rendered page with a precise geo point
// (address/house pages today — decision C13: "виджет живой карты... по
// всем страницах с гео-локацией"). Deliberately reuses the exact same
// PMTiles protocol registration and buildStyle()/detectRenderQuality()
// helpers that web/js/map-search.js uses for the full /map/ page — those
// are loaded right before this file (see htmlPage.js's mapAssetsScripts())
// so there's exactly one implementation of "how to stand up a Sofia
// MapLibre map" in the codebase, not two drifting copies.
//
// Deliberately NOT interactive beyond "tap to open the full map": no zoom/
// pan/rotate controls, no NavigationControl — this is a preview, and the
// full experience (search, routing, filters) already lives at /map/. The
// widget's own "Развернуть" link (rendered by htmlPage.js) and a click
// anywhere on the map both go to the same /map/?q=... URL — see
// htmlPage.js's miniMapWidget()/mapHref() for why that reuses the existing
// `?q=` convention instead of teaching /map/ a new lat/lon param.
(function () {
  function init() {
    var nodes = document.querySelectorAll(".mini-map[data-lat][data-lon]");
    if (!nodes.length) return;
    if (typeof maplibregl === "undefined" || typeof pmtiles === "undefined" || typeof buildStyle !== "function") {
      // Assets failed to load (offline, blocked, etc.) — fail quietly into
      // whatever background/placeholder the CSS already gives .mini-map,
      // rather than throwing and breaking the rest of the page.
      return;
    }
    var protocol = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
    var quality = typeof detectRenderQuality === "function" ? detectRenderQuality() : "lite";

    nodes.forEach(function (el) {
      var lat = parseFloat(el.dataset.lat);
      var lon = parseFloat(el.dataset.lon);
      var expand = el.dataset.expand;
      if (!isFinite(lat) || !isFinite(lon)) return;

      // 2026-09-15 (stop-cluster entity page): extra points besides the
      // primary one, e.g. every other platform of the same physical stop —
      // see htmlPage.js's miniMapWidget()`points` param. Parsed defensively
      // since this is just a JSON attribute on the page, not a guaranteed
      // shape.
      var extraPoints = [];
      if (el.dataset.points) {
        try {
          var parsed = JSON.parse(el.dataset.points);
          if (Array.isArray(parsed)) {
            extraPoints = parsed.filter(function (p) {
              return p && isFinite(p.lat) && isFinite(p.lon);
            });
          }
        } catch (e) {
          extraPoints = [];
        }
      }

      // buildStyle()'s `glyphs` entry is deliberately a path RELATIVE to
      // the current page (see map-style.js's own comment on it) because
      // it's designed for /map/'s single static page. This widget can be
      // embedded on any page (house pages today — under /streets/...), so
      // that relative path would resolve against the WRONG page and 404
      // (found live, 2026-09-09: the widget rendered its marker — the map
      // itself still initializes fine even with broken glyphs — but the
      // basemap/labels never painted). Rewrite it to the one place these
      // font files are actually served from (the /map/ static mount)
      // instead of touching map-style.js itself, which must keep working
      // unmodified for /map/'s own page.
      var style = buildStyle(quality);
      if (style && typeof style.glyphs === "string" && style.glyphs.charAt(0) !== "/") {
        style.glyphs = "/map/" + style.glyphs;
      }

      var map = new maplibregl.Map({
        container: el,
        style: style,
        center: [lon, lat],
        zoom: 15.5,
        pitch: 0,
        bearing: 0,
        maxPitch: 0,
        antialias: false,
        interactive: false,
        attributionControl: false,
        renderWorldCopies: false,
        fadeDuration: 0,
      });

      // Registers the transit stop/station icon sprites the vector style's
      // symbol layers reference (map-style.js) — map-search.js does this
      // for the full /map/ page right after creating its own map instance;
      // this widget was missing the same call, so any stop/station icon in
      // view would silently fail to draw (styleimagemissing).
      if (typeof registerStopIcons === "function") registerStopIcons(map);

      map.on("load", function () {
        new maplibregl.Marker({ color: "#3B3FA6" }).setLngLat([lon, lat]).addTo(map);
        extraPoints.forEach(function (p) {
          new maplibregl.Marker({ color: "#8A8FD1", scale: 0.75 }).setLngLat([p.lon, p.lat]).addTo(map);
        });
        // Fixed center/zoom above is right for a single point; with extras,
        // fit the view to every point instead so a spread-out cluster (e.g.
        // several platforms strung along a road) doesn't render with half
        // of them off-screen.
        if (extraPoints.length) {
          var bounds = new maplibregl.LngLatBounds([lon, lat], [lon, lat]);
          extraPoints.forEach(function (p) {
            bounds.extend([p.lon, p.lat]);
          });
          map.fitBounds(bounds, { padding: 28, maxZoom: 16, duration: 0 });
        }
      });

      map.on("error", function (e) {
        // Tile/style fetch errors shouldn't throw or break the rest of the
        // page — surface them to the console only, same "fail quietly"
        // stance as the missing-globals guard above.
        console.error("[mini-map]", (e && e.error) || e);
      });

      if (expand) {
        el.style.cursor = "pointer";
        el.addEventListener("click", function () {
          window.location.href = expand;
        });
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
