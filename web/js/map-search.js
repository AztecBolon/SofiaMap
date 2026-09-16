(function () {
  "use strict";

  // ---- constants -------------------------------------------------
  const FILTER_GROUP_OF = {
    all: "all", addresses: "all", streets: "all", areas: "all", cities: "all",
    transport: "transport", metro: "transport", stops: "transport", rail: "transport",
    terminals: "transport", routes: "transport",
    organizations: "organizations", rubrics: "organizations",
  };
  const TYPE_LABEL = {
    address: "Адрес / дом", street: "Улица", district: "Район", settlement: "Населённый пункт",
    // 2026-09-15 (/raions/, /parks/ — new public sections): "raion" is the
    // official Stolichna Community administrative division (24 of them —
    // see raionsDirectory.js), deliberately distinct from "district"
    // above (121 OSM admin_level=9 quarters/housing estates) — same two
    // different real-world concepts the site's own hub pages now explain
    // side by side, not a renaming of the existing type.
    raion: "Официальный район", park: "Парк / зелёная зона",
    metro: "Станция метро", stop: "Остановка", rail: "Ж/д платформа", terminal: "Автовокзал / аэропорт",
    route: "Маршрут транспорта", rubric: "Рубрика организаций", company: "Организация",
  };
  const TYPE_GROUP = {
    address: "place", street: "place", district: "place", settlement: "place", raion: "place", park: "place",
    metro: "transport", stop: "transport", rail: "transport", terminal: "transport", route: "transport",
    rubric: "org", company: "org",
  };
  // 2026-09-16 (live report, screenshots of a park/metro/address/street click
  // each landing on a different card shape — "делай по единому стандарту,
  // всю информацию в карточке слева"): the wording for the object card's
  // "Подробнее о …" link (see renderSelected/moreLinkText below) — every
  // click path now ends up on the SAME card, so this is the one place that
  // decides how each type's link reads, instead of a single generic
  // "Открыть страницу" that didn't say what kind of thing it was more info
  // about. Deliberately keyed on `item.type`, not TYPE_LABEL's own strings
  // (which are nouns fit for a results-list subtitle, not this phrase's
  // grammar — e.g. TYPE_LABEL.raion is "Официальный район", but the link
  // reads "Подробнее о районе «X»", not "...об официальном районе...").
  const MORE_LINK_PREFIX = {
    address: "Подробнее об адресе", street: "Подробнее об улице",
    district: "Подробнее о квартале", raion: "Подробнее о районе",
    settlement: "Подробнее о населённом пункте", park: "Подробнее о парке",
    company: "Подробнее об организации", stop: "Подробнее об остановке",
    metro: "Подробнее о станции метро", rail: "Подробнее о платформе",
  };
  function moreLinkText(item) {
    const prefix = MORE_LINK_PREFIX[item.type] || "Подробнее";
    return `${prefix} «${item.name}»`;
  }
  const ICONS = {
    place: '<svg viewBox="0 0 16 16"><path d="M8 1c-2.8 0-5 2.2-5 5 0 3.6 5 9 5 9s5-5.4 5-9c0-2.8-2.2-5-5-5zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>',
    transport: '<svg viewBox="0 0 16 16"><path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4zm1.5 8L2 14v.5h2l1-1.5h6l1 1.5h2V14l-1.5-2h-9zM4 5h8v4H4V5z"/></svg>',
    org: '<svg viewBox="0 0 16 16"><path d="M3 14V3a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v3h2a1 1 0 0 1 1 1v7h1v1H2v-1h1zM5 5h2V4H5v1zm0 3h2V7H5v1zm0 3h2v-1H5v1zm4-3h2V7H9v1zm0 3h2v-1H9v1z"/></svg>',
  };
  // Generic label for a road-hover popup when there's no OSM name to show
  // (the "roads" line layer, unlike its road-labels-* siblings, has no
  // `["has","name"]` filter — it draws every highway class, including the
  // untagged lowest tier, so hovering a footpath or service lane needs its
  // own wording rather than a misleading "street with no name").
  const HIGHWAY_KIND = {
    motorway: "Магистраль", trunk: "Магистраль", motorway_link: "Магистраль", trunk_link: "Магистраль",
    primary: "Главная дорога", primary_link: "Главная дорога",
    secondary: "Дорога", secondary_link: "Дорога", tertiary: "Дорога", tertiary_link: "Дорога",
    unclassified: "Улица", residential: "Улица", living_street: "Улица", road: "Улица",
    service: "Проезд", track: "Грунтовая дорога", pedestrian: "Пешеходная зона", footway: "Пешеходная дорожка",
    path: "Тропа", steps: "Лестница", cycleway: "Велодорожка", bridleway: "Тропа для верховой езды", corridor: "Переход",
  };

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // ---- state -------------------------------------------------
  const ui = document.querySelector(".js-map-search-workspace");
  const els = {
    input: ui.querySelector(".js-map-search-input"),
    form: ui.querySelector(".js-map-search-form"),
    submit: ui.querySelector(".map-search-submit"),
    results: ui.querySelector(".js-map-results"),
    resultCount: ui.querySelector(".js-map-result-count"),
    headTitle: ui.querySelector(".map-search-results__head h1"),
    moreToggle: ui.querySelector(".js-map-more-toggle"),
    more: ui.querySelector(".js-map-more"),
    bounds: ui.querySelector(".js-map-bounds"),
    routeOpen: ui.querySelector(".js-map-route-open"),
    share: ui.querySelector(".js-map-share"),
    shareStatus: ui.querySelector(".js-map-share-status"),
  };

  let typeFilter = "all";
  let results = [];
  let mode = "listing"; // listing | object | rubric | rubric-company | street-houses | street-house | route
  let rubricItems = [];
  let rubricMeta = null;
  let streetHouseItems = [];
  let streetHouseMeta = null;
  // 2026-09-15 live report, point 2 ("из этого списка нет возможности
  // перейти на страницу объекта"): the "К результатам"/back button inside
  // the object card (renderSelected) always went back to the plain search
  // results, even when the card was opened from a nested browsing list
  // (a street's houses, a rubric's companies) rather than from the results
  // list itself — there was no way to express "go back to THAT list" at
  // all. When set, returnToResults() calls this instead of its default
  // "back to search results" behaviour, then clears it (one-shot, so a
  // later unrelated card open — e.g. a plain map click — isn't accidentally
  // routed back into a stale list). renderSelected() resets it to null on
  // every open; a caller that wants custom back behaviour sets it right
  // after calling renderSelected (same tick, no await in between).
  let cardReturnAction = null;
  // ---- routing state ("Как доехать/как дойти", claude/next-steps-routing.md) --
  // routeState is null outside the route panel; while it's open it's always
  // { from: {lat,lng,name}|null, to: {lat,lng,name}|null }. routePicking
  // names which slot the NEXT map click should fill (map.on("click") below
  // checks this before its normal hit-test/object-card flow). routeReqSeq
  // guards against a slower, now-superseded /api/route-plan response (e.g.
  // from swapping points twice quickly) overwriting a newer one.
  let routeState = null;
  let routePicking = null;
  let routeItineraries = [];
  let routeSelectedItin = 0;
  let routeLoading = false;
  let routeError = null;
  let routeReqSeq = 0;
  let searchSnapshot = null;
  let selectedIndex = -1;
  let searchSeq = 0;
  let debounceTimer = null;
  // Whether the isochrone currently on the map belongs to the open card's
  // own toggle button (see toggleIsochrone) -- reset to false the moment
  // the isochrone source is cleared (setIsochroneGeometry), including as a
  // side effect of setSelectedGeometry whenever a DIFFERENT object gets
  // selected, so a stale "Скрыть зону доступности" label can't survive
  // past the card it was computed for.
  let isochroneActive = false;

  function query() {
    return els.input.value.trim();
  }
  function updateSubmit() {
    els.submit.disabled = query().length < 2;
  }

  // ---- map -------------------------------------------------
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  // This is a public map, not a demo on one known machine — some real slice
  // of visitors will land on a software WebGL rasterizer (GPU accel off by
  // IT policy, a blocklisted driver, a VM/remote session with no GPU
  // passthrough), where every WebGL frame is drawn on the CPU instead of
  // the GPU. That cost doesn't depend on how little data is in a tile, so
  // no amount of tile-size trimming (see pipeline/sofia-schema.yml) fixes
  // it — only rendering less per frame does. `detectRenderQuality()`
  // (map-style.js) checks the WebGL renderer string for known software
  // signatures and picks a style accordingly: "full" gets 3D extruded
  // buildings and a slightly higher pixelRatio; "lite" gets flat 2D
  // building footprints (the single biggest cost driver — see that
  // function's comment), no pitch/rotate at all so nobody can accidentally
  // drag into the expensive tilted view a software rasterizer can't keep
  // up with, no road casing layer (map-style.js — halves road fill-rate),
  // and buildings held back one extra zoom level before they render.
  const renderQuality = detectRenderQuality();
  const lite = renderQuality === "lite";
  const map = new maplibregl.Map({
    container: "map",
    style: buildStyle(renderQuality),
    center: [23.3219, 42.6977],
    zoom: 12,
    pitch: 0,
    bearing: 0,
    maxPitch: lite ? 0 : 60,
    antialias: false,
    pixelRatio: Math.min(window.devicePixelRatio || 1, lite ? 1 : 1.5),
    // Default 300ms: MapLibre cross-fades the old and new tile generations
    // for that long on every zoom step, which means *both* get drawn every
    // frame during exactly the interaction we're trying to smooth out.
    // Nothing here depends on that fade looking nice, so it's off for
    // everyone, not just "lite" — it's a straight redraw-cost cut with no
    // visual trade-off worth keeping.
    fadeDuration: 0,
    renderWorldCopies: false,
    // Rotation is already unreachable in "lite" (maxPitch: 0 removes the
    // usual reason to rotate too), so disable the rotate interactions
    // outright there instead of just not offering a UI for it — one less
    // transform MapLibre has to consider on every frame.
    dragRotate: !lite,
    pitchWithRotate: !lite,
    touchPitch: !lite,
  });
  // Registers the transit stop/station icon sprites (map-style.js,
  // stop-icons.js) as soon as the map instance exists — addImage() with
  // raw pixel data is synchronous and doesn't need to wait for the style
  // or its sources to finish loading, so this doesn't need to be inside
  // map.on("load", ...) below.
  registerStopIcons(map);
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: !lite, showCompass: !lite }), "bottom-right");
  console.info(`[map] render quality: ${renderQuality}`);

  function setSelectedGeometry(features) {
    const src = map.getSource("selected");
    if (src) src.setData({ type: "FeatureCollection", features: features || [] });
    // The isochrone (see setIsochroneGeometry/toggleIsochrone below) belongs
    // only to whichever object card is currently open -- every place that
    // moves the "selected" highlight to a new/no object already calls this
    // function right around the same time it (re)builds the card, so
    // clearing it HERE (rather than adding a matching call at every one of
    // those call sites individually) keeps the two in sync for free and
    // can't be forgotten at a future new call site.
    setIsochroneGeometry([]);
  }
  // "Зона доступности" (claude/next-steps-walkability-isochrone.md) — a
  // separate GeoJSON source from "selected" (map-style.js's own comment on
  // why "route" is split out applies here too: 4 concentric polygons need
  // per-feature fill colors, which the single-uniform-color "selected"
  // layers don't support, and its non-lite fill-EXTRUSION variant would
  // draw them as 20m-tall slabs, which makes no sense for an analytic
  // overlay). `features` is expected pre-sorted LARGEST contour first (see
  // toggleIsochrone) -- MapLibre paints a single fill layer's features in
  // the order they appear in the source data, so that order is what makes
  // the smaller/closer (more saturated) rings actually show up on top of
  // the larger/farther ones instead of being hidden underneath them.
  function setIsochroneGeometry(features) {
    const src = map.getSource("isochrone");
    if (src) src.setData({ type: "FeatureCollection", features: features || [] });
    if (!features || !features.length) isochroneActive = false;
  }
  function setSearchPoints(features) {
    const src = map.getSource("searchResults");
    if (src) src.setData({ type: "FeatureCollection", features: features || [] });
  }
  // Draws (or clears, with itin=null) a calculated itinerary: one line
  // feature per leg on the "route" source (map-style.js's route-walk-line/
  // route-transit-line layers key off each feature's own `mode`/`color`),
  // plus one point feature per stop-role on "routePoints" (built by
  // buildRoutePoints below — the same list the legend renders).
  function setRouteGeometry(itin) {
    const routeSrc = map.getSource("route");
    const ptsSrc = map.getSource("routePoints");
    if (!itin) {
      if (routeSrc) routeSrc.setData({ type: "FeatureCollection", features: [] });
      if (ptsSrc) ptsSrc.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const lineFeatures = itin.legs
      .filter((l) => l.geometry && l.geometry.coordinates && l.geometry.coordinates.length > 1)
      .map((l) => ({ type: "Feature", geometry: l.geometry, properties: { mode: l.mode, color: l.routeColor } }));
    const pointFeatures = buildRoutePoints(itin.legs)
      .filter((p) => p.lat != null && p.lng != null)
      .map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] }, properties: { kind: p.kind } }));
    if (routeSrc) routeSrc.setData({ type: "FeatureCollection", features: lineFeatures });
    if (ptsSrc) ptsSrc.setData({ type: "FeatureCollection", features: pointFeatures });
    // 2026-09-16: a walk-only itinerary synthesized from Motis'
    // /api/v1/one-to-many (server/src/routes/routing.js) carries no leg
    // geometry at all (that endpoint only ever returns duration/distance),
    // so lineFeatures is empty for it -- falling back to the point
    // features' own coordinates means picking that alternative still
    // re-centers the map on start/end instead of leaving the view wherever
    // it happened to be from the previously selected (line-having)
    // alternative.
    const allCoords = lineFeatures.length
      ? lineFeatures.reduce((acc, f) => acc.concat(f.geometry.coordinates), [])
      : pointFeatures.map((f) => f.geometry.coordinates);
    if (allCoords.length) fitBoundsCoords(allCoords, 60);
  }
  function flyTo(lat, lng, zoom) {
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), zoom || 16), speed: 1.2 });
  }
  function fitBoundsCoords(coords, pad) {
    if (!coords.length) return;
    const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
    coords.forEach((c) => b.extend(c));
    map.fitBounds(b, { padding: pad || 80, maxZoom: 17, duration: 700 });
  }

  // ---- API helpers -------------------------------------------------
  async function apiSearch(q, type, bounds) {
    const params = new URLSearchParams({ q, type });
    if (bounds) params.set("bounds", bounds.join(","));
    const res = await fetch(`/api/search?${params}`);
    return res.json();
  }
  async function apiRubric(name) {
    const res = await fetch(`/api/rubric/${encodeURIComponent(name)}`);
    return res.json();
  }
  async function apiStreetHouses(id) {
    const res = await fetch(`/api/street/${id}/houses`);
    return res.json();
  }
  async function apiObject(type, id) {
    const res = await fetch(`/api/object/${type}/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return res.json();
  }
  async function apiRouteStops(routeType, id) {
    const res = await fetch(`/api/route/${routeType}/${id}/stops`);
    return res.json();
  }
  async function apiHitTest(lat, lng) {
    const res = await fetch(`/api/hit-test?lat=${lat}&lng=${lng}`);
    return res.json();
  }
  // Resolves a bare street name + the point actually clicked/hovered on the
  // map to the ONE real street there (see server/src/lib/streetCluster.js —
  // Sofia reuses names like "Янтра" across several unrelated streets).
  async function apiStreetAt(name, lat, lng) {
    const params = new URLSearchParams({ name, lat, lng });
    const res = await fetch(`/api/street-at?${params}`);
    return res.json();
  }
  // 2026-09-16 (live feedback): route-point search used to go through
  // Motis' own geocoder (server/src/routes/routing.js's /api/route-geocode)
  // — weak with Cyrillic/typos, per claude/next-steps-routing.md's own
  // note. Reusing the site's own /api/search instead (same endpoint the
  // main results list uses, via apiSearch above) gives it the same
  // typo-tolerant, kirillic-aware ranking as the rest of the site, with no
  // server change needed: every item that has an actual point on the map
  // already carries lat/lng (same filter already used at the hover-hit
  // list below), so anything without one (a rubric category, a transit
  // line) drops out on its own.
  async function apiRoutePointSearch(text) {
    const data = await apiSearch(text, "all");
    return (data.items || []).filter((it) => it.lat != null && it.lng != null);
  }
  // Thin proxy to server/src/routes/routing.js, which in turn proxies to a
  // locally-running Motis (see claude/next-steps-routing.md) — calculates
  // nothing client-side, per the original ask ("Алгоритм расчетов не делай
  // сам, ищи готовые решения"). /api/route-geocode above it still exists
  // server-side but is no longer called from here as of the point above.
  async function apiRoutePlan(from, to) {
    const params = new URLSearchParams({ fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng });
    const res = await fetch(`/api/route-plan?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || "route_error");
    return data;
  }
  // "Зона доступности" (claude/next-steps-walkability-isochrone.md): thin
  // proxy to server/src/routes/isochrone.js, which in turn calls a local
  // pyvalhalla-based service (routing-proto/valhalla) -- same
  // "calculate nothing client-side, proxy to a real routing engine"
  // pattern as apiRoutePlan above, just a different satellite process.
  async function apiIsochrone(lat, lng) {
    const params = new URLSearchParams({ lat, lng });
    const res = await fetch(`/api/isochrone?${params}`);
    const data = await res.json();
    if (!res.ok) {
      const detail = data && data.detail;
      const message =
        data && data.error === "isochrone_engine_unreachable"
          ? "Сервис расчёта зон доступности сейчас недоступен"
          : detail && detail.error === "tiles_not_built"
          ? "Граф для расчёта зон доступности ещё не построен на сервере"
          : "Не удалось построить зону доступности";
      throw new Error(message);
    }
    return data;
  }

  // ---- rendering: result rows -------------------------------------------------
  // "Открыть страницу" (2026-09-09, claude/search-results-plan.md) —
  // replaces the old "Подробнее" wording, and unlike it is a REAL link to
  // the object's own page (search.js's `href`), opened in a new tab; the
  // row itself keeps doing exactly what it always did (choose() -> select
  // on the map, inline card) — this is an extra way in, not a replacement
  // for that. `href` is only ever missing for a handful of types this
  // dataset has no static page for yet (e.g. an "airport" terminal) — no
  // link renders for those rather than pointing at a guess.
  function resultRow(item, index) {
    const isRubric = item.type === "rubric";
    const row = document.createElement("div");
    row.className = "map-search-result" + (isRubric ? " map-search-result--rubric" : "");
    row.dataset.index = String(index);
    const openLink = item.href
      ? `<a class="map-search-result__open" href="${esc(item.href)}" target="_blank" rel="noopener">Открыть страницу</a>`
      : "";
    row.innerHTML = `
      <span class="map-search-result__icon">${ICONS[TYPE_GROUP[item.type] || "place"]}</span>
      <span class="map-search-result__text">
        <strong>${esc(item.name)}</strong>
        <span>${esc(item.subtitle || TYPE_LABEL[item.type] || "")}</span>
        ${openLink}
      </span>`;
    row.addEventListener("click", (e) => {
      // The link handles its own navigation (new tab) — a click on it
      // shouldn't also pick this row on the map underneath it.
      if (e.target.closest(".map-search-result__open")) return;
      choose(index);
    });
    return row;
  }

  // "Связанные объекты" (2026-09-09, claude/search-results-plan.md) — a
  // street result's first few real houses (search.js's `related`/
  // `related_total`), nested right under its row instead of leaving the
  // street as a bare, childless entry. "Показать все N" reuses the exact
  // same street->houses drill-down a click on the row itself already opens
  // (loadStreetHouses via choose()) — no separate flow to maintain.
  //
  // 2026-09-14 (claude/next-steps-rubric-grouping.md, search-results-plan.md
  // §6, second wave): the same block now also renders for a `rubric` result
  // — its first few organizations (same `related`/`related_total` fields,
  // just built from rubricsDirectory.getCompaniesForRubric on the server —
  // see search.js). A rubric's block gets its own heading ("Организации" —
  // these ARE the category's members, not "related" objects) and a second
  // action, "Показать все на карте" (decision 2 of §6.1), that plots every
  // organization of the rubric on the map without leaving the current
  // results list — unlike "Показать все N", which (via choose() ->
  // loadRubric(), already existing before this wave from clicking the row
  // itself) replaces the panel with the full browsable company list.
  // Russian plural of "точка" for a count (1 точка / 2-4 точки / 5+, 11-14
  // точек) — same three-way pattern server/src/routes/pages.js's
  // stopsWord()/pointsWord() already use, just needed here too since this
  // note is client-rendered.
  function pointsWord(n) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "точка";
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "точки";
    return "точек";
  }

  function relatedBlock(item, index) {
    if (!item.related || !item.related.length) return null;
    const isRubric = item.type === "rubric";
    // 2026-09-15 live report ("нужна одна страница по этой сущности... при
    // выдаче — только одна ссылка"): a stop's `related` siblings no longer
    // carry their own `href` at all (search.js) — there is exactly ONE real
    // link for the whole entity, the row's own "Открыть страницу" above
    // (rendered by resultRow from `item.href`), which now opens a page that
    // itself shows every point on its map (pages.js). Say so in a short
    // note instead of the generic "Связанные объекты" heading, so the
    // missing per-row links read as "by design", not as something broken.
    const isStop = item.type === "stop";
    // 2026-09-15 (Point 2 migration): a `company` result only ever carries
    // `related` when it's the primary of a same-name city-wide chain
    // cluster (search.js's getClusterMembers branch) — every OTHER type of
    // company result has no `related` at all, so this check doesn't need
    // its own separate server-sent flag.
    const isCompanyCluster = item.type === "company";
    const title = isRubric
      ? "Организации"
      : isStop
      ? "Другие точки этой остановки"
      : isCompanyCluster
      ? `Другие адреса «${item.name}»`
      : "Связанные объекты";
    const note = isStop
      ? `<p class="map-search-related__note">Эта остановка объединяет ${item.related_total + 1} ${pointsWord(item.related_total + 1)} посадки одного места — все показаны на карте, страница объекта одна для всех точек (см. «Открыть страницу» выше).</p>`
      : isCompanyCluster
      ? `<p class="map-search-related__note">«${esc(item.name)}» встречается в ${item.related_total + 1} местах города — ссылка выше ведёт на основной адрес; остальные адреса ниже, кнопка «Показать на карте» отметит их все.</p>`
      : "";
    const box = document.createElement("div");
    box.className = "map-search-related" + (isRubric ? " map-search-related--rubric" : "");
    box.innerHTML = `
      <div class="map-search-related__title">${title}</div>
      ${note}
      ${item.related
        .map(
          (r) => `
        <div class="map-search-related__row">
          <span>${esc(r.name)}</span>
          ${r.href ? `<a href="${esc(r.href)}" target="_blank" rel="noopener">Открыть страницу</a>` : ""}
        </div>`
        )
        .join("")}
      <div class="map-search-related__actions">
        ${
          !isStop && item.related_total > item.related.length
            ? `<button class="map-search-related__more" type="button">Показать все ${item.related_total}</button>`
            : ""
        }
        ${isRubric ? `<button class="map-search-related__onmap" type="button">Показать все на карте</button>` : ""}
        ${isCompanyCluster ? `<button class="map-search-related__onmap" type="button">Показать на карте</button>` : ""}
      </div>`;
    const more = box.querySelector(".map-search-related__more");
    if (more) more.addEventListener("click", () => choose(index));
    const onMap = box.querySelector(".map-search-related__onmap");
    if (onMap) onMap.addEventListener("click", () => (isCompanyCluster ? showClusterOnMap(item) : showRubricOnMap(item)));
    return box;
  }

  // Lighter version of showRubricOnMap() for a company chain cluster
  // (2026-09-15, Point 2 migration) — no API round trip needed since every
  // member's coordinates already travelled down with the search result
  // itself (search.js's getClusterMembers branch), unlike a rubric's full
  // company list which can run into the hundreds/thousands.
  function showClusterOnMap(item) {
    const points = [{ lat: item.lat, lng: item.lng, name: item.name }, ...item.related].filter((p) => p.lat != null && p.lng != null);
    setSearchPoints(
      points.map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { name: p.name, type: "company" },
      }))
    );
    if (points.length) fitBoundsCoords(points.map((p) => [p.lng, p.lat]));
  }

  // "Показать все на карте" (2026-09-14, second wave) — a lighter-weight
  // sibling of "Показать все N": plots every organization of this rubric as
  // a point on the map and fits the view to them, but (unlike loadRubric(),
  // which "Показать все N"/clicking the row triggers) does NOT replace the
  // results panel with the full browsable list — the current search results
  // stay exactly as they were. Reuses the same /api/rubric/:name endpoint
  // the full-list drill-down already fetches from.
  async function showRubricOnMap(item) {
    const data = await apiRubric(item.name);
    const mapped = (data.items || []).filter((r) => r.lat != null && r.lng != null);
    setSearchPoints(
      mapped.map((r) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.lng, r.lat] },
        properties: { name: r.name, type: "company" },
      }))
    );
    if (mapped.length) fitBoundsCoords(mapped.map((r) => [r.lng, r.lat]));
  }

  // "Ещё N улиц с таким названием" (2026-09-14, fourth wave — search.js's
  // `namesakes`/`namesakes_total`, decision B1 in search-results-plan.md
  // §8.2/§9): Sofia genuinely has several real, physically unconnected
  // streets sharing one name (up to ~10 for "Витоша") — the server now
  // sends only ONE of them as this row's own result, with the rest riding
  // along here as a compact, collapsed-by-default note instead of each
  // becoming its own top-level row. Same "explain the quirk, don't hide
  // it" idea as the existing note on the static street page
  // (routes/pages.js), just structured data the frontend renders (and can
  // expand inline, since every namesake already carries its own small
  // house preview from the server) rather than a fixed HTML string.
  function namesakesBlock(item) {
    if (!item.namesakes || !item.namesakes.length) return null;
    const box = document.createElement("div");
    box.className = "map-search-namesakes";
    const preview = item.namesakes
      .map((n) => esc((n.subtitle || "").replace(/^Улица\s*·\s*/, "") || n.name))
      .filter(Boolean)
      .join(", ");
    box.innerHTML = `
      <p class="map-search-namesakes__note">
        ℹ Название «${esc(item.name)}» в Столичной общине встречается ещё в ${item.namesakes_total} мест${
      item.namesakes_total === 1 ? "е" : "ах"
    } — это отдельные, физически не связанные улицы${preview ? `: ${preview}` : ""}.
        <button class="map-search-namesakes__toggle" type="button">Показать</button>
      </p>
      <div class="map-search-namesakes__list" hidden></div>`;
    const toggle = box.querySelector(".map-search-namesakes__toggle");
    const list = box.querySelector(".map-search-namesakes__list");
    toggle.addEventListener("click", () => {
      const willShow = list.hidden;
      list.hidden = !willShow;
      toggle.textContent = willShow ? "Скрыть" : "Показать";
      if (willShow && !list.dataset.rendered) {
        list.dataset.rendered = "1";
        item.namesakes.forEach((n) => list.appendChild(namesakeRow(n)));
      }
    });
    return box;
  }

  // One namesake, rendered like a miniature version of a normal street
  // result row + its own "Связанные объекты" preview — the server already
  // built both (search.js), this just nests them one level deeper instead
  // of as siblings in the main results list.
  function namesakeRow(n) {
    const row = document.createElement("div");
    row.className = "map-search-namesake";
    const openLink = n.href
      ? `<a class="map-search-namesake__open" href="${esc(n.href)}" target="_blank" rel="noopener">Открыть страницу</a>`
      : "";
    const houses =
      n.related && n.related.length
        ? `<div class="map-search-namesake__houses">${n.related
            .map(
              (h) => `
          <div class="map-search-related__row">
            <span>${esc(h.name)}</span>
            ${h.href ? `<a href="${esc(h.href)}" target="_blank" rel="noopener">Открыть страницу</a>` : ""}
          </div>`
            )
            .join("")}${
            n.related_total > n.related.length
              ? `<span class="map-search-namesake__more-note">и ещё ${n.related_total - n.related.length}</span>`
              : ""
          }</div>`
        : "";
    row.innerHTML = `
      <div class="map-search-namesake__head">
        <strong>${esc(n.name)}</strong>
        <span>${esc(n.subtitle || "")}</span>
        ${openLink}
      </div>
      ${houses}`;
    return row;
  }

  function render() {
    els.results.innerHTML = "";
    els.headTitle.textContent = "Результаты поиска";
    const mapped = results.filter((r) => r.lat != null && r.lng != null);
    els.resultCount.textContent = results.length
      ? `Показано: ${results.length} · на карте: ${mapped.length}`
      : "Ничего не найдено";

    if (!results.length) {
      els.results.innerHTML = '<div class="map-search-empty">Попробуйте изменить запрос или фильтр.</div>';
    }
    let lastGroup = null;
    results.forEach((item, i) => {
      const group = TYPE_GROUP[item.type];
      if (group !== lastGroup && results.length > 3) {
        lastGroup = group;
      }
      els.results.appendChild(resultRow(item, i));
      const related = relatedBlock(item, i);
      if (related) els.results.appendChild(related);
      const namesakes = namesakesBlock(item);
      if (namesakes) els.results.appendChild(namesakes);
    });

    setSearchPoints(
      mapped.map((r) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.lng, r.lat] },
        // `index` is this item's position in `results` — carried through so
        // hovering/clicking the marker on the map can jump straight to
        // `choose(index)`, the exact same call the matching list row makes.
        properties: { name: r.name, type: r.type, index: results.indexOf(r) },
      }))
    );
    if (mapped.length) fitBoundsCoords(mapped.map((r) => [r.lng, r.lat]));
    updateShare();
  }

  async function runSearch() {
    const q = query();
    if (q.length < 2) {
      results = [];
      mode = "listing";
      els.results.innerHTML = '<div class="map-search-empty">Введите не менее двух символов.</div>';
      els.resultCount.textContent = "Поиск объектов и адресов";
      setSearchPoints([]);
      setSelectedGeometry([]);
      return;
    }
    const seq = ++searchSeq;
    els.results.innerHTML = '<div class="map-search-loading">Ищем объекты…</div>';
    let bounds = null;
    if (els.bounds.checked) {
      const b = map.getBounds();
      bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    }
    let data;
    try {
      data = await apiSearch(q, typeFilter, bounds);
    } catch (e) {
      if (seq !== searchSeq) return;
      els.results.innerHTML = '<div class="map-search-error">Поиск временно недоступен. Карта продолжает работать.</div>';
      return;
    }
    if (seq !== searchSeq) return;
    mode = "listing";
    setSelectedGeometry([]);
    results = data.items || [];
    render();
  }

  function scheduleSearch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 220);
  }

  // ---- selecting a result -------------------------------------------------
  async function choose(index) {
    const item = results[index];
    if (!item) return;
    selectedIndex = index;
    if (item.type === "rubric") return loadRubric(item.name);

    Array.from(els.results.querySelectorAll(".map-search-result")).forEach((r) =>
      r.classList.toggle("is-active", Number(r.dataset.index) === index)
    );

    if (item.type === "route") {
      return renderRouteSelected(item);
    }

    if (item.type === "address" || item.type === "district" || item.type === "settlement" || item.type === "raion" || item.type === "park") {
      const obj = await apiObject(item.type, item.id);
      // Picked from the results list, not a map click — there's no actual
      // click point to anchor coordinates/route buttons to, so this falls
      // back to the object's own centroid (obj.lat/obj.lon), same as a
      // `?sel=` deep link (selectFromUrl below).
      renderSelected(item, obj, obj && obj.lat != null ? { lat: obj.lat, lng: obj.lon } : null);
      if (obj && obj.geometry) {
        setSelectedGeometry([{ type: "Feature", geometry: obj.geometry, properties: {} }]);
        const coords = flattenCoords(obj.geometry);
        if (coords.length) fitBoundsCoords(coords);
      }
      return;
    }

    if (item.type === "street") {
      return loadStreetHouses(item);
    }

    // company / stop / metro / rail / terminal — point features
    renderSelected(item, null, item.lat != null ? { lat: item.lat, lng: item.lng } : null);
    if (item.lat != null && item.lng != null) {
      setSelectedGeometry([{ type: "Feature", geometry: { type: "Point", coordinates: [item.lng, item.lat] }, properties: {} }]);
      flyTo(item.lat, item.lng, 17);
    }
    if (item.type === "company") {
      const obj = await apiObject("company", item.id);
      if (obj) appendCompanyDetails(obj);
    }
    if (item.type === "stop" || item.type === "metro" || item.type === "rail" || item.type === "terminal") {
      const obj = await apiObject("stop", item.id);
      if (obj) appendStopRoutes(obj);
    }
  }

  // Shared by choose() (picking a "street" row from the results list) and
  // the map's own road-click popup (resolveStreetClick below) — both end up
  // with a specific street osm_id and want the same "street -> its houses"
  // drill-down: the highlighted line on the map (as before) PLUS a browsable
  // list of the houses actually on it, mirroring the existing "rubric ->
  // its organizations" flow below (2026-09-06, moscowmap precedent: "при
  // выборе улицы - дома"). /api/street/:id/houses already resolves which
  // SPECIFIC same-named cluster this is (see streetCluster.js) the same way
  // /api/object/street/:id does for the line geometry, so both requests can
  // run in parallel against the one id.
  // 2026-09-16 (live report — street's house-list panel was the fourth
  // inconsistent shape shown alongside park/metro/address: no coordinates,
  // no "Подробнее" link, no route buttons at all). `coords`, when given, is
  // the actual point the user clicked (resolveStreetClick, below — a real
  // map click on the road itself); a street picked from the results list
  // (choose()) has no such point, so this falls back to the street's own
  // geometry's first vertex — an approximate but real point on the actual
  // line, good enough for "where is this on the map" the same way a
  // district/park's centroid is for those types.
  async function loadStreetHouses(item, coords) {
    mode = "street-houses";
    searchSnapshot = { results: results.slice() };
    els.headTitle.textContent = TYPE_LABEL.street;
    els.resultCount.textContent = "Загружаем…";
    els.results.innerHTML = '<div class="map-search-loading">Загружаем дома на карту…</div>';
    setSelectedGeometry([]);
    const [obj, data] = await Promise.all([apiObject("street", item.id), apiStreetHouses(item.id)]);
    if (mode !== "street-houses") return; // user navigated away while this was in flight
    streetHouseItems = data.items || [];
    streetHouseMeta = data.meta || { name: item.name, total: 0, returned: 0, partial: false };
    streetHouseMeta.href = obj ? obj.href : null;
    if (coords) {
      streetHouseMeta.coords = coords;
    } else if (obj && obj.geometry) {
      const c = flattenCoords(obj.geometry)[0];
      streetHouseMeta.coords = c ? { lat: c[1], lng: c[0] } : null;
    } else {
      streetHouseMeta.coords = null;
    }
    if (obj && obj.geometry && obj.geometry.geometries) {
      const feats = obj.geometry.geometries.map((g) => ({ type: "Feature", geometry: g, properties: {} }));
      setSelectedGeometry(feats);
      const coordsList = feats.flatMap((f) => flattenCoords(f.geometry));
      if (coordsList.length) fitBoundsCoords(coordsList);
    }
    renderStreetHousesList(item);
  }

  function renderStreetHousesList(item) {
    mode = "street-houses";
    const name = streetHouseMeta.name || item.name;
    const pt = streetHouseMeta.coords || null;
    els.headTitle.textContent = name;
    els.resultCount.textContent = `Домов: ${streetHouseMeta.total}`;
    const head = document.createElement("div");
    head.className = "map-rubric-head";
    head.innerHTML = `
      <button class="map-selected-back js-street-houses-back" type="button">← К результатам поиска</button>
      <strong>${esc(TYPE_LABEL.street)}</strong>
      <h2>${esc(name)}</h2>
      <p>${streetHouseMeta.total} домов с адресом${streetHouseMeta.partial ? " (показаны первые " + streetHouseItems.length + ")" : ""}</p>
      ${coordsHtml(pt && pt.lat, pt && pt.lng)}
      ${streetHouseMeta.href ? `<a class="map-selected-link map-selected-open" href="${esc(streetHouseMeta.href)}" target="_blank" rel="noopener">${esc(moreLinkText({ type: "street", name }))} →</a>` : ""}
      ${routeButtonsHtml(pt && pt.lat, pt && pt.lng)}`;
    els.results.innerHTML = "";
    els.results.appendChild(head);
    head.querySelector(".js-street-houses-back").addEventListener("click", returnFromStreetHouses);
    bindRouteButtons(head, pt && pt.lat, pt && pt.lng, name);

    if (!streetHouseItems.length) {
      els.results.insertAdjacentHTML("beforeend", '<div class="map-search-empty">Дома с известным номером на этой улице не найдены.</div>');
    }
    streetHouseItems.forEach((house, i) => {
      const row = document.createElement("button");
      row.className = "map-rubric-company"; // same row styling as the rubric company list
      row.type = "button";
      row.innerHTML = `<strong>${esc(house.name)}</strong><span>${esc(house.subtitle || "")}</span>`;
      row.addEventListener("click", () => selectStreetHouse(i));
      els.results.appendChild(row);
    });

    const mapped = streetHouseItems.filter((r) => r.lat != null);
    setSearchPoints(
      mapped.map((r) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r.lng, r.lat] }, properties: { name: r.name, type: "address" } }))
    );
    updateShare();
  }

  // 2026-09-15 live report, point 2: clicking a house in the drill-down
  // list used to only highlight it on the map (no way to reach its page at
  // all from here — the user had to separately find and click the matching
  // pin on the map, which `openObjectDetails` DOES open a card for). Now
  // mirrors that exact flow (fetch the full object, open the same "Объект
  // на карте" card, same href/directions), with the one difference that
  // "back" returns to THIS house list, not the outer search results —
  // via `cardReturnAction` (see its own comment).
  async function selectStreetHouse(index) {
    const item = streetHouseItems[index];
    if (!item) return;
    const obj = await apiObject("address", item.id);
    renderSelected(item, obj, obj && obj.lat != null ? { lat: obj.lat, lng: obj.lon } : (item.lat != null ? { lat: item.lat, lng: item.lng } : null));
    cardReturnAction = () => renderStreetHousesList({ name: streetHouseMeta.name });
    if (obj && obj.geometry) {
      setSelectedGeometry([{ type: "Feature", geometry: obj.geometry, properties: {} }]);
      const coords = flattenCoords(obj.geometry);
      if (coords.length) fitBoundsCoords(coords);
    } else if (item.lat != null) {
      setSelectedGeometry([{ type: "Feature", geometry: { type: "Point", coordinates: [item.lng, item.lat] }, properties: {} }]);
      flyTo(item.lat, item.lng, 17);
    }
  }

  function returnFromStreetHouses() {
    mode = "listing";
    results = (searchSnapshot && searchSnapshot.results) || [];
    setSelectedGeometry([]);
    render();
  }

  function flattenCoords(geom) {
    if (!geom) return [];
    switch (geom.type) {
      case "Point": return [geom.coordinates];
      case "LineString": return geom.coordinates;
      case "MultiLineString": return geom.coordinates.flat();
      case "Polygon": return geom.coordinates.flat();
      case "MultiPolygon": return geom.coordinates.flat(2);
      case "GeometryCollection": return geom.geometries.flatMap(flattenCoords);
      default: return [];
    }
  }

  // 2026-09-15 (live report, point 1: "В карточке объекта нужна ссылка на
  // страницу объекта") — this card is reached two different ways, each
  // carrying the object's real page URL in a different place: a search
  // RESULT row's own `item.href` (search.js, already used by `resultRow`'s
  // "Открыть страницу" — see there) when opened via `choose()`, or the
  // freshly-fetched `obj.href` (object.js's `/api/object/:type/:id`, added
  // alongside this fix) when opened via a map click (openObjectDetails) or a
  // `?sel=type:id` deep link (selectFromUrl) — those build `item` from
  // scratch with no `href` of its own. Checking both, in that order, covers
  // every path into this card with the one link, same wording/target as the
  // results list.
  // 2026-09-15 live report, point 3 ("карточка замусорена повторениями и не
  // даёт важной информации... самое важное - проезд, как добраться"): this
  // card used to print the object's TYPE three times over (once in the
  // results-panel header via `resultCount` below, again in its own
  // `.map-selected-type` span, and a third time whenever the caller had set
  // `item.subtitle` to that same TYPE_LABEL string, e.g. openObjectDetails/
  // selectFromUrl below) while never showing anything an actual visitor
  // came for. Fixed by (a) dropping the in-card type span — the header line
  // already says it once, (b) only printing `subtitle` when it carries
  // information beyond the type/name already shown (callers now compute a
  // real one — street address, rubric, etc. — instead of repeating
  // TYPE_LABEL), and (c) surfacing a compact "Как добраться" preview from
  // `obj.directions` (transportNearby.getKakProehat, added server-side
  // alongside this) — full detail (every nearby stop, per-route notes)
  // stays on the object's own page; this is deliberately just enough to
  // answer "can I get there at all", matching what "Открыть страницу"
  // promises.
  // 2026-09-16 (live report, 4 screenshots of a park/metro/address/street
  // click each producing a differently-shaped result — "делай по единому
  // стандарту, всю информацию в карточке слева"): every object type now
  // renders through this ONE function with the SAME fields — name,
  // coordinates, a "Подробнее о …" link (when a real page exists), the
  // compact "Как добраться" preview (when known), and a pair of
  // "Маршрут отсюда/сюда" buttons — instead of a native maplibregl.Popup
  // for some types (park/quarter/water — see the removed placeholder popups
  // in the click handler below) and a bare name-only card for others.
  //
  // `coords`, when given as `{lat, lng}`, is the ANCHOR point this card's
  // coordinates line and route buttons use. For a point object (address,
  // company, stop) that's always going to be close to the object's own
  // lat/lon regardless of how the card was opened. For an AREA object
  // (district/raion/park/street) it matters which point: opened via an
  // actual map click (resolveAreaClick/resolveStreetClick below), `coords`
  // is the exact spot clicked — "в случае больших объектов прокладываем до
  // координаты клика" (live report) — so two clicks on opposite ends of the
  // same large park each anchor a route to where the person actually
  // pointed, not to one fixed centroid. Opened from a list/search result
  // instead (no click to anchor to), callers fall back to the object's own
  // centroid — see this function's call sites.
  function renderSelected(item, obj, coords) {
    cardReturnAction = null;
    mode = "object";
    els.headTitle.textContent = "Объект на карте";
    els.resultCount.textContent = TYPE_LABEL[item.type] || "Объект";
    const subtitle = item.subtitle || "";
    const href = item.href || (obj && obj.href) || null;
    const pointLat = coords && coords.lat != null ? coords.lat : (obj && obj.lat != null ? obj.lat : (item.lat != null ? item.lat : null));
    const pointLng = coords && coords.lng != null ? coords.lng
      : (obj && obj.lon != null ? obj.lon : (obj && obj.lng != null ? obj.lng : (item.lng != null ? item.lng : null)));
    const openLink = href
      ? `<a class="map-selected-link map-selected-open" href="${esc(href)}" target="_blank" rel="noopener">${esc(moreLinkText(item))} →</a>`
      : "";
    const directions = obj && obj.directions ? directionsHtml(obj.directions) : "";
    els.results.innerHTML = `
      <div class="map-selected-card">
        <button class="map-selected-back js-back" type="button">← К результатам</button>
        <h2>${esc(item.name)}</h2>
        ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
        ${coordsHtml(pointLat, pointLng)}
        ${directions}
        ${openLink}
        ${routeButtonsHtml(pointLat, pointLng)}
        ${isochroneButtonHtml(pointLat, pointLng)}
        <div class="js-isochrone-panel"></div>
        <div class="js-extra"></div>
      </div>`;
    els.results.querySelector(".js-back").addEventListener("click", returnToResults);
    bindRouteButtons(els.results, pointLat, pointLng, item.name);
    bindIsochroneButton(els.results, pointLat, pointLng);
    updateShare();
  }

  // Shown on every card that has a real point to anchor to — see
  // renderSelected's own comment on where `coords` comes from for each
  // object type/entry path.
  function coordsHtml(lat, lng) {
    if (lat == null || lng == null) return "";
    return `<p class="map-selected-coords">Координаты: ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}</p>`;
  }

  // "Проложить маршрут (отсюда, сюда)" — opens the route panel
  // (openRoutePanel below) with this point already captured as the from/to
  // anchor, so only the OTHER point needs picking before a real itinerary
  // is calculated (via the Motis proxy, server/src/routes/routing.js).
  function routeButtonsHtml(lat, lng) {
    if (lat == null || lng == null) return "";
    return `<div class="map-selected-directions">
      <button class="js-route-from" type="button">Маршрут отсюда</button>
      <button class="js-route-to" type="button">Маршрут сюда</button>
    </div>`;
  }

  function bindRouteButtons(container, lat, lng, name) {
    if (lat == null || lng == null) return;
    const fromBtn = container.querySelector(".js-route-from");
    const toBtn = container.querySelector(".js-route-to");
    if (fromBtn) fromBtn.addEventListener("click", () => openRoutePanel({ role: "from", name, lat, lng }));
    if (toBtn) toBtn.addEventListener("click", () => openRoutePanel({ role: "to", name, lat, lng }));
  }

  // "Зона доступности" button — deliberately its OWN row (not folded into
  // routeButtonsHtml/bindRouteButtons above), scoped to renderSelected's
  // object card only for this first iteration (claude/next-steps-
  // walkability-isochrone.md — the street-houses drill-down panel, the
  // OTHER caller of routeButtonsHtml, was left out on purpose rather than
  // silently gaining this too as a side effect of touching shared code).
  function isochroneButtonHtml(lat, lng) {
    if (lat == null || lng == null) return "";
    return `<div class="map-selected-directions map-selected-isochrone">
      <button class="js-isochrone" type="button">Зона доступности</button>
    </div>`;
  }

  function bindIsochroneButton(container, lat, lng) {
    if (lat == null || lng == null) return;
    const btn = container.querySelector(".js-isochrone");
    if (!btn) return;
    btn.addEventListener("click", () => toggleIsochrone(lat, lng, container));
  }

  // 5/10/15/20-minute walk contours from server/src/routes/isochrone.js
  // (pedestrian-only for this first iteration, per the same doc). Toggling
  // OFF just clears the source — re-toggling ON re-fetches rather than
  // caching, since this is a cheap single-point call and caching would need
  // its own invalidation story for zero real benefit here.
  async function toggleIsochrone(lat, lng, container) {
    const btn = container.querySelector(".js-isochrone");
    const panel = container.querySelector(".js-isochrone-panel");
    if (isochroneActive) {
      setIsochroneGeometry([]);
      if (btn) { btn.classList.remove("is-active"); btn.textContent = "Зона доступности"; }
      if (panel) panel.innerHTML = "";
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Считаем…"; }
    if (panel) panel.innerHTML = `<p class="map-isochrone-status">Считаем зону пешей доступности…</p>`;
    try {
      const data = await apiIsochrone(lat, lng);
      // Sort defensively rather than trusting the upstream order to stay
      // largest-first forever — see setIsochroneGeometry's comment on why
      // the order matters for rendering.
      const features = (data.features || [])
        .slice()
        .sort((a, b) => (b.properties.contour || 0) - (a.properties.contour || 0));
      setIsochroneGeometry(features);
      isochroneActive = true;
      if (btn) { btn.disabled = false; btn.classList.add("is-active"); btn.textContent = "Скрыть зону доступности"; }
      if (panel) panel.innerHTML = isochroneLegendHtml(features);
      const allCoords = features.flatMap((f) => (f.geometry && f.geometry.coordinates && f.geometry.coordinates[0]) || []);
      if (allCoords.length) fitBoundsCoords(allCoords, 40);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = "Зона доступности"; }
      if (panel) panel.innerHTML = `<p class="map-isochrone-status is-error">${esc((err && err.message) || "Не удалось построить зону доступности")}</p>`;
    }
  }

  function isochroneLegendHtml(features) {
    const rows = features
      .slice()
      .sort((a, b) => (a.properties.contour || 0) - (b.properties.contour || 0))
      .map(
        // f.properties.color comes straight from Valhalla, already
        // "#"-prefixed (server/src/routes/isochrone.js's own comment, and
        // map-style.js's isochrone-fill/-line layers, note the same thing)
        // -- no extra "#" here.
        (f) =>
          `<span class="map-isochrone-legend__item"><i style="background:${esc(String(f.properties.color || "#999"))}"></i>${esc(
            String(f.properties.contour)
          )} мин</span>`
      )
      .join("");
    return `<div class="map-isochrone-legend">${rows}</div>`;
  }

  // Compact "Metro/stops within reach" preview — see renderSelected's
  // comment for why this exists and why it's deliberately shorter than the
  // full block on the object's own page (kakProehatHtml, pages.js): one
  // nearest metro (if any) plus up to 2 nearest surface stops with their
  // route numbers, no per-route "N ост. до метро" annotations — those stay
  // page-only detail. Returns "" (renders nothing) when there's genuinely
  // nothing nearby, same "no data, no block" rule pages.js's version uses.
  function directionsHtml(directions) {
    const metro = directions.metro || [];
    const stops = (directions.surface && directions.surface.stops) || [];
    if (!metro.length && !stops.length) return "";
    const rows = [];
    if (metro.length) {
      const m = metro[0];
      rows.push(`<div class="map-selected-transport__row">Метро «${esc(m.name)}» · ${m.distanceM} м</div>`);
    }
    stops.slice(0, 2).forEach((s) => {
      const refs = [...new Set(s.routes.filter((r) => r.ref).map((r) => r.ref))].slice(0, 6);
      rows.push(
        `<div class="map-selected-transport__row">${esc(s.typeLabel || "Остановка")} «${esc(s.name)}» · ${s.distanceM} м${
          refs.length ? " — " + refs.map(esc).join(", ") : ""
        }</div>`
      );
    });
    return `<div class="map-selected-transport"><p class="map-selected-transport__title">Как добраться</p>${rows.join("")}</div>`;
  }

  function appendCompanyDetails(obj) {
    const extra = els.results.querySelector(".js-extra");
    if (!extra) return;
    const rows = [];
    if (obj.phone) rows.push(`<p>☎ ${esc(obj.phone)}</p>`);
    if (obj.website) rows.push(`<p><a class="map-selected-link" href="${esc(obj.website)}" target="_blank" rel="noopener">${esc(obj.website)}</a></p>`);
    if (obj.opening_hours) rows.push(`<p>Часы работы: ${esc(obj.opening_hours)}</p>`);
    extra.innerHTML = rows.join("") + (obj.directions ? directionsHtml(obj.directions) : "");
  }

  function appendStopRoutes(obj) {
    const extra = els.results.querySelector(".js-extra");
    if (!extra || !obj.routes || !obj.routes.length) return;
    extra.innerHTML =
      "<p><strong>Маршруты:</strong> " +
      obj.routes.map((r) => esc(r.ref || r.route_name || r.route_type)).join(", ") +
      "</p>";
  }

  async function renderRouteSelected(item) {
    cardReturnAction = null;
    mode = "object";
    els.headTitle.textContent = "Маршрут транспорта";
    els.resultCount.textContent = TYPE_LABEL.route;
    els.results.innerHTML = `
      <div class="map-selected-card">
        <button class="map-selected-back js-back" type="button">← К результатам</button>
        <h2>${esc(item.name)}</h2>
        <div class="map-route-stops js-stops"><div class="map-search-loading">Загружаем остановки…</div></div>
      </div>`;
    els.results.querySelector(".js-back").addEventListener("click", returnToResults);
    updateShare();
    const stops = await apiRouteStops(item.route_type, item.id);
    const list = els.results.querySelector(".js-stops");
    if (!list) return;
    if (!stops.length) {
      list.innerHTML = '<div class="map-search-error">Не удалось загрузить остановки.</div>';
      return;
    }
    list.innerHTML = stops
      .map((s, i) => {
        const edge = i === 0 || i === stops.length - 1;
        return `<div class="map-route-stop${edge ? " is-edge" : ""}"><span>${s.num}</span><span>${esc(s.name)}</span></div>`;
      })
      .join("");
    const coords = stops.filter((s) => s.lat != null).map((s) => [s.lng, s.lat]);
    setSelectedGeometry([{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} }]);
    if (coords.length) fitBoundsCoords(coords);
  }

  function returnToResults() {
    selectedIndex = -1;
    setSelectedGeometry([]);
    // Leaving ANY card/panel always drops a calculated route + cancels an
    // in-progress "pick a point on the map" — cheapest to do unconditionally
    // here (the one shared exit path every panel's back button already
    // calls) than to remember which specific callers need it.
    setRouteGeometry(null);
    stopRoutePicking();
    routeState = null;
    routeItineraries = [];
    routeError = null;
    if (cardReturnAction) {
      const action = cardReturnAction;
      cardReturnAction = null;
      return action();
    }
    mode = "listing";
    render();
  }

  // ---- rubric browsing -------------------------------------------------
  async function loadRubric(name) {
    mode = "rubric";
    searchSnapshot = { results: results.slice() };
    els.headTitle.textContent = "Рубрика организаций";
    els.resultCount.textContent = "Загружаем…";
    els.results.innerHTML = '<div class="map-search-loading">Загружаем организации на карту…</div>';
    setSelectedGeometry([]);
    const data = await apiRubric(name);
    rubricItems = data.items || [];
    rubricMeta = data.meta;
    renderRubricList();
  }

  function renderRubricList() {
    mode = "rubric";
    els.headTitle.textContent = rubricMeta.name;
    els.resultCount.textContent = `Найдено: ${rubricMeta.total}`;
    const head = document.createElement("div");
    head.className = "map-rubric-head";
    head.innerHTML = `
      <button class="map-selected-back js-rubric-back" type="button">← К результатам поиска</button>
      <strong>Рубрика организаций</strong>
      <h2>${esc(rubricMeta.name)}</h2>
      <p>${rubricMeta.total} организаций${rubricMeta.partial ? " (показаны первые " + rubricItems.length + ")" : ""}</p>`;
    els.results.innerHTML = "";
    els.results.appendChild(head);
    head.querySelector(".js-rubric-back").addEventListener("click", returnFromRubric);

    if (!rubricItems.length) {
      els.results.insertAdjacentHTML("beforeend", '<div class="map-search-empty">В этой рубрике организации не найдены.</div>');
    }
    rubricItems.forEach((item, i) => {
      const row = document.createElement("button");
      row.className = "map-rubric-company";
      row.type = "button";
      row.innerHTML = `<strong>${esc(item.name)}</strong><span>${esc(item.subtitle || "")}</span>`;
      row.addEventListener("click", () => selectRubricCompany(i));
      els.results.appendChild(row);
    });

    const mapped = rubricItems.filter((r) => r.lat != null);
    setSearchPoints(
      mapped.map((r) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r.lng, r.lat] }, properties: { name: r.name, type: "company" } }))
    );
    if (mapped.length) fitBoundsCoords(mapped.map((r) => [r.lng, r.lat]));
    updateShare();
  }

  // Same fix as selectStreetHouse above (2026-09-15 live report, point 2),
  // applied symmetrically: a company picked from a rubric's full list had
  // exactly the same gap (no way to reach its page from the list itself).
  // Fetches the full object BEFORE rendering (unlike choose()'s company
  // branch, which can render immediately because a search-result `item`
  // already carries its own `href` from search.js) — `/api/rubric/:name`'s
  // rows don't carry one, only `/api/object/company/:id` does.
  async function selectRubricCompany(index) {
    const item = rubricItems[index];
    if (!item) return;
    const obj = await apiObject("company", item.id);
    renderSelected(item, obj, obj && obj.lat != null ? { lat: obj.lat, lng: obj.lon } : (item.lat != null ? { lat: item.lat, lng: item.lng } : null));
    cardReturnAction = () => renderRubricList();
    if (obj && obj.lat != null && obj.lon != null) {
      setSelectedGeometry([{ type: "Feature", geometry: { type: "Point", coordinates: [obj.lon, obj.lat] }, properties: {} }]);
      flyTo(obj.lat, obj.lon, 17);
    } else if (item.lat != null) {
      setSelectedGeometry([{ type: "Feature", geometry: { type: "Point", coordinates: [item.lng, item.lat] }, properties: {} }]);
      flyTo(item.lat, item.lng, 17);
    }
    if (obj) appendCompanyDetails(obj);
  }

  function returnFromRubric() {
    mode = "listing";
    results = (searchSnapshot && searchSnapshot.results) || [];
    setSelectedGeometry([]);
    render();
  }

  // ---- filters -------------------------------------------------
  ui.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      typeFilter = btn.dataset.filter;
      const group = btn.dataset.group || FILTER_GROUP_OF[typeFilter] || "all";
      ui.querySelectorAll(".map-search-filters > [data-filter]").forEach((b) => b.classList.toggle("is-active", b.dataset.filter === group));
      ui.querySelectorAll(".map-search-more [data-filter]").forEach((b) => b.classList.toggle("is-active", b === btn));
      if (!btn.dataset.group) {
        els.more.hidden = true;
        els.moreToggle.setAttribute("aria-expanded", "false");
      }
      if (query().length >= 2) runSearch();
    });
  });
  els.moreToggle.addEventListener("click", () => {
    const open = els.more.hidden;
    els.more.hidden = !open;
    els.moreToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  // ---- search form -------------------------------------------------
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(debounceTimer);
    runSearch();
  });
  els.input.addEventListener("input", () => {
    updateSubmit();
    scheduleSearch();
  });
  els.bounds.addEventListener("change", () => {
    if (query().length >= 2) runSearch();
  });
  map.on("moveend", () => {
    if (els.bounds.checked && query().length >= 2 && mode === "listing") runSearch();
  });

  // ---- share link (query/type only, minimal v1) -------------------------------------------------
  function updateShare() {
    els.share.hidden = !(query().length >= 2 && mode === "listing");
  }
  els.share.addEventListener("click", () => {
    const url = new URL(location.href);
    url.searchParams.set("q", query());
    url.searchParams.set("type", typeFilter);
    const value = url.toString();
    const done = () => {
      els.shareStatus.hidden = false;
      els.shareStatus.textContent = "Ссылка скопирована";
      setTimeout(() => (els.shareStatus.hidden = true), 2200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, () => window.prompt("Скопируйте ссылку", value));
    else window.prompt("Скопируйте ссылку", value);
  });

  // ---- routing ("Как доехать / как дойти") -------------------------------------------------
  // claude/next-steps-routing.md has the full design history. Short version:
  // calculation itself is NOT done here or on our server — it's proxied
  // (server/src/routes/routing.js) to a locally-run Motis process, chosen
  // after directly comparing it with OpenTripPlanner 2 on real Sofia data.
  // This block only owns: picking two points (by name via Motis' own
  // geocoder, or by clicking the map), calling the proxy, and rendering the
  // result (map styling in map-style.js's route-*/routePoints layers, plus
  // the legend below).
  const ROUTE_POINT_LABEL = { start: "Начало", board: "Посадка", transfer: "Пересадка", alight: "Высадка", end: "Конец" };
  const ROUTE_MODE_LABEL = { WALK: "Пешком", BUS: "Автобус", TRAM: "Трамвай", TROLLEYBUS: "Тролейбус", SUBWAY: "Метро", RAIL: "Ж/д" };

  function formatClock(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }
  function formatDistance(m) {
    if (m == null) return "";
    return m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${Math.round(m)} м`;
  }
  // Same pluralization pattern as stopsDirectory-adjacent server code
  // (recordsWord in coord.js) — "1 пересадка" / "2 пересадки" / "5 пересадок".
  function transferWord(n) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "пересадка";
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "пересадки";
    return "пересадок";
  }
  // ~50m tolerance for "is this the same physical stop" — matching Motis'
  // own from/to coordinates for two adjacent legs (rounding noise aside,
  // an interlined transfer's shared stop reports identical coordinates on
  // both legs, so this is a generous, not a tight, threshold).
  function pointsClose(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return false;
    return Math.abs(a.lat - b.lat) < 0.0006 && Math.abs(a.lng - b.lng) < 0.0006;
  }
  // Turns a flat legs[] array into the ordered "Список всех точек (начало,
  // конец, посадка, пересадка, высадка)" the legend shows — the request
  // this whole feature started from asked for exactly this list. A WALK
  // leg's own endpoints never become a point of their own (only start/end
  // ever come from a WALK leg, at the very ends of the trip); two
  // back-to-back transit legs sharing a stop (no walk in between) collapse
  // into a single "transfer" point instead of an alight+board pair at the
  // same spot.
  function buildRoutePoints(legs) {
    if (!legs || !legs.length) return [];
    const events = [{ kind: "start", ...legs[0].from }];
    const transitLegs = legs.filter((l) => l.mode && l.mode !== "WALK");
    transitLegs.forEach((cur, i) => {
      const prev = transitLegs[i - 1];
      const next = transitLegs[i + 1];
      if (!(prev && pointsClose(prev.to, cur.from))) {
        events.push({ kind: "board", ...cur.from, routeName: cur.routeName });
      }
      const mergesWithNext = next && pointsClose(cur.to, next.from);
      events.push({ kind: mergesWithNext ? "transfer" : "alight", ...cur.to, routeName: cur.routeName });
    });
    events.push({ kind: "end", ...legs[legs.length - 1].to });
    return events;
  }

  function pointRowHtml(p) {
    const label = ROUTE_POINT_LABEL[p.kind] || p.kind;
    return `<div class="map-route-point map-route-point--${p.kind}">
      <span class="map-route-point__dot"></span>
      <span class="map-route-point__text"><strong>${esc(label)}:</strong> ${esc(p.name || "точка на карте")}${
        p.routeName ? ` (${esc(p.routeName)})` : ""
      }</span>
    </div>`;
  }
  function legRowHtml(l) {
    const minutes = l.duration != null ? Math.round(l.duration / 60) : null;
    const desc =
      l.mode === "WALK"
        ? `Пешком${l.distance != null ? " · " + esc(formatDistance(l.distance)) : ""}`
        : `${esc(ROUTE_MODE_LABEL[l.mode] || l.mode)}${l.routeName ? " " + esc(l.routeName) : ""}${l.headsign ? " → " + esc(l.headsign) : ""}`;
    const swatchColor = l.mode === "WALK" ? "#999" : l.routeColor || "#3B3FA6";
    return `<div class="map-route-leg">
      <span class="map-route-leg__swatch" style="background:${esc(swatchColor)}"></span>
      <span class="map-route-leg__text">${desc}</span>
      <span class="map-route-leg__time">${minutes != null ? `${minutes} мин` : ""}</span>
    </div>`;
  }

  function routeResultHtml() {
    if (!routeState || !routeState.from || !routeState.to) {
      return `<p class="map-route-hint">Укажите обе точки — по названию или кликом на карте — чтобы построить маршрут.</p>`;
    }
    if (routeLoading) return `<div class="map-search-loading">Строим маршрут…</div>`;
    if (routeError) return `<div class="map-search-error">${esc(routeError)}</div>`;
    if (!routeItineraries.length) return `<div class="map-search-empty">Маршрут между этими точками не найден.</div>`;
    const itin = routeItineraries[routeSelectedItin];
    const points = buildRoutePoints(itin.legs);
    const totalMin = itin.duration != null ? Math.round(itin.duration / 60) : null;
    const switchHtml =
      routeItineraries.length > 1
        ? `<div class="map-route-itin-switch">${routeItineraries
            .map(
              (it, i) =>
                `<button type="button" class="js-route-itin${i === routeSelectedItin ? " is-active" : ""}" data-i="${i}">${
                  it.duration != null ? Math.round(it.duration / 60) + " мин" : "вариант " + (i + 1)
                }</button>`
            )
            .join("")}</div>`
        : "";
    return `
      <div class="map-route-summary">
        ${totalMin != null ? `<strong>${totalMin} мин</strong> · ` : ""}${formatClock(itin.startTime)}–${formatClock(itin.endTime)}${
      itin.transfers ? ` · ${itin.transfers} ${transferWord(itin.transfers)}` : ""
    }
      </div>
      ${switchHtml}
      <div class="map-route-points">
        <p class="map-route-block-title">Точки маршрута</p>
        ${points.map(pointRowHtml).join("")}
      </div>
      <div class="map-route-legs">
        <p class="map-route-block-title">Участки пути</p>
        ${itin.legs.map(legRowHtml).join("")}
      </div>`;
  }

  // 2026-09-16 (live feedback, second issue): the old "Выбрать на карте"
  // button stayed on an unfilled slot even once a plain map click already
  // worked for it (autoRoutePickRole below) — visually implying the click
  // alone wouldn't be enough. Replaced with a plain-text hint (no button,
  // nothing to press) whose wording itself flips once this slot is armed
  // for the next map click, same signal the button's label used to give.
  function pointSlotHtml(role) {
    const p = routeState && routeState[role];
    const label = role === "from" ? "От" : "До";
    const roleWord = role === "from" ? "от" : "до";
    if (p) {
      return `<div class="map-route-point-slot is-filled">
        <span class="map-route-point-slot__label">${label}</span>
        <span class="map-route-point-slot__name">${esc(p.name || "Точка на карте")}</span>
        <button type="button" class="map-route-point-slot__clear js-route-clear" data-role="${role}" aria-label="Убрать точку">✕</button>
      </div>`;
    }
    const picking = routePicking === role || autoRoutePickRole() === role;
    return `<div class="map-route-point-slot${picking ? " is-picking" : ""}" data-role="${role}">
      <span class="map-route-point-slot__label">${label}</span>
      <div class="map-route-search js-route-search" data-role="${role}">
        <input type="text" class="map-route-search__input" placeholder="Название точки..." autocomplete="off" />
        <div class="map-route-search-list js-route-search-list"></div>
      </div>
      <p class="map-route-point-slot__hint">${
        picking ? `Кликните на карте, чтобы указать точку «${roleWord}»` : `Кликните на карте или введите в поиске точку «${roleWord}»`
      }</p>
    </div>`;
  }

  function renderRoutePanel() {
    mode = "route";
    els.headTitle.textContent = "Маршрут";
    els.resultCount.textContent = routeState && routeState.from && routeState.to ? "Построен" : "Выберите точки";
    els.results.innerHTML = `
      <div class="map-route-panel">
        <button class="map-selected-back js-back" type="button">← К результатам</button>
        <h2>Как доехать / как дойти</h2>
        <div class="map-route-points-input">
          ${pointSlotHtml("from")}
          <button type="button" class="map-route-swap js-route-swap" title="Поменять местами" ${
            routeState && (routeState.from || routeState.to) ? "" : "disabled"
          }>⇅</button>
          ${pointSlotHtml("to")}
        </div>
        <div class="js-route-body">${routeResultHtml()}</div>
      </div>`;
    els.results.querySelector(".js-back").addEventListener("click", returnToResults);
    els.results.querySelectorAll(".js-route-clear").forEach((btn) => btn.addEventListener("click", () => clearRoutePoint(btn.dataset.role)));
    const swapBtn = els.results.querySelector(".js-route-swap");
    if (swapBtn) swapBtn.addEventListener("click", swapRoutePoints);
    els.results.querySelectorAll(".js-route-itin").forEach((btn) =>
      btn.addEventListener("click", () => {
        routeSelectedItin = parseInt(btn.dataset.i, 10);
        renderRoutePanel();
        setRouteGeometry(routeItineraries[routeSelectedItin]);
      })
    );
    bindPointSearch("from");
    bindPointSearch("to");
    updateShare();
  }

  // Debounced search-by-name against the site's own /api/search
  // (apiRoutePointSearch above), scoped to whichever point slot's input
  // this is — rebuilt fresh on every renderRoutePanel() call (the whole
  // panel is replaced), so this only needs to attach listeners to whatever
  // is in the DOM right now. Updates just the result list, not the whole
  // panel, so typing never loses focus.
  function bindPointSearch(role) {
    const wrap = els.results.querySelector(`.js-route-search[data-role="${role}"]`);
    if (!wrap) return;
    const input = wrap.querySelector("input");
    const list = wrap.querySelector(".js-route-search-list");
    let timer = null;
    let seq = 0;
    // 2026-09-16: focusing the field (a click into it, or tabbing in) arms
    // this slot for the next map click too — same effect the old "Выбрать
    // на карте" button used to have, minus the extra click on a button that
    // did nothing typing itself couldn't already imply. Doesn't re-render
    // the panel (that would drop the focus this handler just received) —
    // just flips the state + the already-rendered slots' own classes/text.
    input.addEventListener("focus", () => startRoutePicking(role));
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const text = input.value.trim();
      if (text.length < 2) {
        list.innerHTML = "";
        return;
      }
      timer = setTimeout(async () => {
        const mySeq = ++seq;
        const items = await apiRoutePointSearch(text);
        if (mySeq !== seq) return; // a newer keystroke's request already landed
        if (!items.length) {
          list.innerHTML = '<div class="map-route-search-empty">Ничего не найдено</div>';
          return;
        }
        list.innerHTML = items
          .slice(0, 8)
          .map(
            (it, i) => `<button type="button" class="map-route-search-item" data-i="${i}">
              <span class="map-route-search-item__name">${esc(it.name)}</span>${
                it.subtitle && it.subtitle !== it.name ? `<span class="map-route-search-item__sub">${esc(it.subtitle)}</span>` : ""
              }
            </button>`
          )
          .join("");
        list.querySelectorAll("[data-i]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const item = items[parseInt(btn.dataset.i, 10)];
            setRoutePoint(role, { lat: item.lat, lng: item.lng, name: item.name });
          });
        });
      }, 250);
    });
  }

  // 2026-09-16: used to also call renderRoutePanel() to swap the pick
  // button's own label — now that arming happens on focus (bindPointSearch
  // above), a full re-render here would immediately steal back the focus
  // the person just gave the input. updatePickingHighlight() below updates
  // the already-rendered slots in place instead.
  function startRoutePicking(role) {
    routePicking = role;
    map.getCanvas().style.cursor = "crosshair";
    updatePickingHighlight();
  }
  function stopRoutePicking() {
    map.getCanvas().style.cursor = "";
    routePicking = null;
    hideRoutePickLabel();
  }
  // Keeps each unfilled slot's ".is-picking" class and hint wording in sync
  // with whichever role the next map click would fill right now — either
  // explicitly armed (routePicking, via startRoutePicking) or implicitly
  // (autoRoutePickRole, once exactly one side is already set). Called
  // whenever that state changes WITHOUT a full renderRoutePanel() (focus,
  // mousemove-driven checks would be overkill there) so an input never
  // loses focus just because the person clicked into it.
  function updatePickingHighlight() {
    const active = routePicking || autoRoutePickRole();
    els.results.querySelectorAll(".map-route-point-slot[data-role]").forEach((slotEl) => {
      const role = slotEl.dataset.role;
      const isActive = role === active;
      slotEl.classList.toggle("is-picking", isActive);
      const roleWord = role === "from" ? "от" : "до";
      const hint = slotEl.querySelector(".map-route-point-slot__hint");
      if (hint) {
        hint.textContent = isActive ? `Кликните на карте, чтобы указать точку «${roleWord}»` : `Кликните на карте или введите в поиске точку «${roleWord}»`;
      }
    });
  }
  // 2026-09-16 (live feedback): once one of the two points is filled, the
  // other slot is implicitly "next to pick" — a plain map click sets it
  // directly, without first pressing that slot's own "Выбрать на карте"
  // button. Only kicks in when exactly one side is filled: with both empty,
  // a stray click while just browsing the freshly-opened panel shouldn't
  // silently claim "от" the person didn't ask to set yet, and an explicit
  // "Выбрать на карте" press (routePicking) still works the same as before
  // for re-picking either side once both are set.
  function autoRoutePickRole() {
    if (!routeState) return null;
    if (routeState.from && !routeState.to) return "to";
    if (!routeState.from && routeState.to) return "from";
    return null;
  }
  // Called both from map click-picking (handleRoutePick below) and from a
  // geocode search result — either way, setting the SECOND point triggers
  // the actual /api/route-plan call.
  function setRoutePoint(role, point) {
    if (!routeState) routeState = { from: null, to: null };
    routeState[role] = point;
    stopRoutePicking();
    renderRoutePanel();
    // Give the map an immediate crosshair cue for the now-implicit "pick the
    // other point" state, rather than waiting for the next mousemove to
    // notice it via processHover's own autoRoutePickRole() check.
    if (autoRoutePickRole()) map.getCanvas().style.cursor = "crosshair";
    if (routeState.from && routeState.to) fetchAndRenderRoute();
  }
  function clearRoutePoint(role) {
    if (!routeState) routeState = { from: null, to: null };
    routeState[role] = null;
    routeItineraries = [];
    routeError = null;
    setRouteGeometry(null);
    stopRoutePicking();
    renderRoutePanel();
  }
  function swapRoutePoints() {
    if (!routeState) return;
    const tmp = routeState.from;
    routeState.from = routeState.to;
    routeState.to = tmp;
    renderRoutePanel();
    if (routeState.from && routeState.to) fetchAndRenderRoute();
  }
  // The next map click (any layer, anywhere — this is checked first thing
  // in map.on("click") below, ahead of the normal hit-test/object-card
  // flow) fills whichever slot is being picked. apiHitTest gives it a real
  // name when the click happens to land on a building/stop/company already
  // known to the map, same lookup the plain click handler itself uses;
  // otherwise it's just "Точка на карте", same fallback renderSelected uses
  // for a bare map click.
  async function handleRoutePick(lat, lng, roleOverride) {
    const role = roleOverride || routePicking;
    if (!role) return;
    let name = "Точка на карте";
    try {
      const data = await apiHitTest(lat.toFixed(6), lng.toFixed(6));
      const feature = data.features && data.features[0];
      if (feature && feature.properties && feature.properties.name) name = feature.properties.name;
    } catch (e) {
      /* best-effort naming only -- the point itself is still usable */
    }
    setRoutePoint(role, { lat, lng, name });
  }

  async function fetchAndRenderRoute() {
    if (!routeState || !routeState.from || !routeState.to) return;
    const seq = ++routeReqSeq;
    routeLoading = true;
    routeError = null;
    renderRoutePanel();
    let data;
    try {
      data = await apiRoutePlan(routeState.from, routeState.to);
    } catch (err) {
      if (seq !== routeReqSeq) return; // superseded by a newer request
      routeLoading = false;
      routeItineraries = [];
      routeError = "Не удалось построить маршрут. Возможно, маршрутный сервис сейчас недоступен.";
      renderRoutePanel();
      return;
    }
    if (seq !== routeReqSeq) return;
    routeLoading = false;
    routeItineraries = data.itineraries || [];
    routeSelectedItin = 0;
    renderRoutePanel();
    setRouteGeometry(routeItineraries[0] || null);
  }

  function openRoutePanel(anchor) {
    setSelectedGeometry([]);
    routeState = { from: null, to: null };
    routeItineraries = [];
    routeError = null;
    stopRoutePicking();
    if (anchor && (anchor.role === "from" || anchor.role === "to")) {
      routeState[anchor.role] = { lat: anchor.lat, lng: anchor.lng, name: anchor.name || "Точка на карте" };
    }
    renderRoutePanel();
  }
  els.routeOpen.addEventListener("click", () => openRoutePanel(null));

  // ---- resolving a map click on an AREA layer with no per-feature DB id
  // in the vector tile itself (place-labels-hit's point only carries a bare
  // `name`; landuse's fill carries OSM tags, not our own primary key) ------
  // 2026-09-16 (live report, screenshot 1 — clicking a PARK on the map hit
  // a tile-native "Страница появится позже" placeholder instead of the
  // real /parks/ integration built the same wave this session started
  // with): `place-labels-hit` (quarters — the "district" concept, see
  // TYPE_LABEL's own comment on why that's distinct from "raion") and
  // `landuse`/`water` (parks/gardens/forests/protected areas, plus plenty
  // of area with no page at all — residential/commercial/water/...) used to
  // both just show a small native maplibregl.Popup with the bare OSM name,
  // regardless of whether a real page/API integration existed for that spot
  // by now. `/api/area-at` (server/src/routes/coord.js) does the actual
  // point-in-polygon lookup against the real boundary geometry (districts
  // via areasDirectory.findContaining, parks via parksDirectory) — this
  // resolves the click to that object's real id and opens it through the
  // exact same renderSelected() card every other object type now uses,
  // anchored to the ACTUAL point clicked (not the polygon's centroid — see
  // renderSelected's own comment on why that matters for a large object).
  async function fetchAreaAt(kind, lat, lng) {
    const res = await fetch(`/api/area-at?lat=${lat}&lng=${lng}&kind=${kind}`);
    return res.json();
  }
  async function renderResolvedArea(type, id, lat, lng, fallbackName) {
    const obj = id != null ? await apiObject(type, id) : null;
    if (obj) {
      const item = { type, id: obj.id, name: obj.name, subtitle: "" };
      renderSelected(item, obj, { lat, lng });
      if (obj.geometry) setSelectedGeometry([{ type: "Feature", geometry: obj.geometry, properties: {} }]);
      // Deliberately no fitBounds/flyTo here (unlike choose()'s district/
      // park branch) — the person already clicked exactly where they wanted
      // to look; fitting the whole polygon's bounds would zoom OUT from the
      // point of interest instead of keeping it in view.
      return true;
    }
    // No DB row under this point (a resolution miss, or the point is inside
    // a landuse category this site has no page for at all — residential,
    // water, ...) — still the SAME card shape, just without a "Подробнее"
    // link, so this dead end reads as "consistent, but nothing more to say"
    // rather than a smaller, different popup.
    renderSelected({ type, id: null, name: fallbackName || "Точка на карте", subtitle: "" }, null, { lat, lng });
    return false;
  }
  async function resolveAreaClick(kind, name, lat, lng) {
    const data = await fetchAreaAt(kind, lat, lng);
    if (data.found) return renderResolvedArea(data.type, data.id, lat, lng, name);
    renderSelected({ type: kind, id: null, name: name || "Точка на карте", subtitle: "" }, null, { lat, lng });
  }

  // ---- hover: highlight + cursor on buildings/streets/quarters/stops/search results --------------
  // Buildings, street lines, quarter names, stops, and search result
  // markers/clusters all get the same two things on hover: (1) a highlight
  // (feature-state on the vector layers; the "hover" geojson source for the
  // three point layers with no stable tile id — stops, search points,
  // search clusters), (2) a pointer cursor instead of the default grab.
  // 2026-09-15 (live report, "Попап, который появляется при долгом
  // наведении, теперь лишний"): a THIRD thing — a small popup revealed after
  // the pointer dwelled on one object for a while, with a "Подробнее"/
  // "Открыть страницу" action — used to also happen here. Removed: a plain
  // click on the exact same hovered object (map.on("click") below) now opens
  // the real "Объект на карте" card (or the object's own page, for the types
  // that have one) immediately, for every object type this covers, so the
  // dwell popup only ever repeated that after an extra wait. `claude/
  // hover-click-rules.md` (project notes) documents the resulting per-type
  // rules (highlight / cursor / click) and should stay in sync with this.
  // "place-labels-hit"/"roads-hit", not "place-labels"/"roads"/
  // "road-labels-N" themselves: a quarter name is a short line of text at a
  // point, and a street's rendered line is only 0.6-4.5px wide — hovering/
  // clicking either directly (2026-09-05 feedback, twice — first for
  // quarters, then "улицы продолжают сильно мельтешить" once quarters were
  // fixed) meant aiming at a target only a few pixels tall/wide, so the
  // highlight flickered as the real cursor jittered in and out of that
  // sliver, and clicks routinely missed and fell through to the generic
  // "empty map spot" handler instead of the actual object's popup.
  // "place-labels-hit"/"roads-hit" (map-style.js) are invisible, generously
  // -sized proxies over the same geometry — feature-state set through
  // either still drives the real, visible layers' own opacity/width, since
  // all of them key off the same `{source, sourceLayer, id}`.
  // "overlay-stops-badge" added 2026-09-07 (stop icons revision 2, then
  // kept through revision 3): tram_stop/bus_stop/bus_terminal moved off
  // the old flat "overlay-stops" layer onto their own badge sprite (see
  // buildStopsLayers() in map-style.js) — without this, hovering/clicking
  // a bus or tram stop silently did nothing, since queryRenderedFeatures
  // below only ever looked at the old layer id. (Revision 2 briefly split
  // this into two stacked layers, "-badge"+"-glyph"; revision 3 merged
  // them back into the one "-badge" layer below, so there's nothing else
  // to add here now.)
  // "overlay-stations" added 2026-09-08 (stop icons revision 4): metro/rail
  // station badges were NEVER in this list, from the very first version of
  // that layer — a separate, longer-standing gap than the badge/glyph split
  // above, just never reported until now ("не кликаются и не реагируют при
  // наведении"). Same fix shape as overlay-stops below: /api/hit-test
  // already handles this fine server-side (`nearestStop` in
  // server/src/routes/coord.js queries the whole `stops` table regardless
  // of stop_type, so subway/rail rows resolve exactly like bus/tram ones) —
  // this was purely a missing client-side wire-up.
  // "landuse"/"water" added 2026-09-15 (map-display point 5, "подтянуть
  // названия парков/водоёмов + сделать кликабельными") — unlike every other
  // entry here, these are the real, always-drawn fill layers themselves
  // (map-style.js), not a separate invisible "-hit" proxy: a park/lake
  // polygon is already generously large as a hit target, so it doesn't need
  // the widening trick roads-hit/place-labels-hit exist for. Named features
  // only in practice (processHover below drops unnamed ones before they
  // ever reach handleHoverFeature) — an unnamed generic residential/
  // industrial landuse block isn't something to hover/click.
  const HOVER_LAYERS = ["buildings", "roads-hit", "place-labels-hit", "landuse", "water", "overlay-stations", "overlay-stops", "overlay-stops-badge", "search-points", "search-clusters"];
  // 2026-09-16 (live report, third issue — "клик мимо объекта на малых
  // масштабах должен отдавать координаты, а не район/парк"): place-labels-
  // hit (quarters, minzoom 10 in map-style.js) and landuse/water (park/
  // water fills, no minzoom at all -- rendered from the map's own minimum
  // zoom) are both clickable at a fully-zoomed-out, whole-city view, where
  // a single polygon can cover most of the visible map -- resolving a
  // click there into "you clicked inside district X" isn't useful, the
  // person just wants to know where they clicked. 13 matches this site's
  // own existing zoom tiers (map-style.js: buildings render from 13/14,
  // residential streets' minzoomFull is 13) -- the zoom the map already
  // treats as "committed to neighbourhood detail" elsewhere, reused here
  // rather than inventing a second threshold.
  const AREA_RESOLVE_MINZOOM = 13;
  // 2026-09-08: point layers among the above (station/stop/search-result
  // badges, as opposed to buildings/roads-hit/place-labels-hit's areas and
  // lines) can legitimately sit a few metres from ANOTHER point layer's
  // icon at the same spot — real transit data, not a bug: a bus stop is
  // routinely right outside a metro station's own entrance, sharing a
  // name ("пл. Орлов мост" bus stop, ~30m from "Орлов мост" metro station,
  // confirmed via sofia.db — not a one-off, this is normal at interchange
  // stops citywide) — and both layers draw with icon-allow-overlap/
  // icon-ignore-placement:true, so both symbols really do render at
  // overlapping pixels. `queryRenderedFeatures(point, {layers})[0]` picks
  // whichever one happens to be on TOP in paint order (overlay-stops-badge
  // is added after overlay-stations in buildStopsLayers(), so it always
  // won) — NOT whichever one the cursor is actually closer to. That's the
  // "выделяется не точно иконка" report: hovering right on the metro badge
  // could highlight (and, on click, open) the nearby bus stop instead,
  // whose own coordinate is metres away, so the highlight ring visibly
  // misses the icon underneath the cursor.
  //
  // Fix: among the returned features, prefer whichever POINT feature's own
  // coordinate projects closest to the actual cursor pixel — not simply
  // the first one MapLibre's z-order handed back. Falls back to
  // `features[0]` when no point feature is present (buildings/roads-hit/
  // place-labels-hit don't stack this way at one pixel, so z-order is
  // still the right tiebreak for those).
  const HOVER_POINT_LAYERS = new Set(["overlay-stations", "overlay-stops", "overlay-stops-badge", "search-points", "search-clusters"]);
  function pickHoverFeature(features, point) {
    let best = null;
    let bestDist = Infinity;
    for (const f of features) {
      if (!HOVER_POINT_LAYERS.has(f.layer.id) || f.geometry.type !== "Point") continue;
      const screenPt = map.project(f.geometry.coordinates);
      const dx = screenPt.x - point.x;
      const dy = screenPt.y - point.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    return best || features[0];
  }
  // 2026-09-08 revision 8 — hover highlight, take 2 ("подсвечивается не
  // сама иконка... измени технологию", the report right after the
  // pickHoverFeature fix above landed). Maps a stop/station's `stop_type`
  // to the matching baked "*-hover" sprite (gen_stop_icons.py's
  // render_hover — a highlight ring traced around that icon's OWN real
  // silhouette, not an unrelated circle) and to a `kind` naming which of
  // map-style.js's three icon-size expressions (STATION_ICON_SIZE/
  // STOPBADGE_ICON_SIZE/STOPDOT_ICON_SIZE) applies — mirrors the exact
  // same `stop_type` branches STATION_ICON/STOP_ICON/VEHICLE_GLYPH use
  // there, so the highlight always matches the real icon actually drawn.
  //
  // 2026-09-08 revision 10 ("сделай иконки цветом линии" round 2): subway
  // no longer points at a flat "metro-badge-hover" bake — that sprite
  // doesn't exist any more (see gen_stop_icons.py's render_dilated
  // comment: a fixed baked color can't represent a per-station line
  // color). It now returns the REAL recolorable "metro-badge" sprite name
  // plus its own `kind` ("station-metro", not "station") — map-style.js's
  // hover-icon-metro-halo/hover-icon-metro layers use that kind to draw
  // the halo ring and a second real, per-feature-colored "metro-badge"
  // instance stacked on top, instead of one pre-baked composite. See the
  // setHighlightForFeature call site below for where this station's own
  // `line_color` gets carried along too, so the hovered instance is
  // colored exactly the same as the real one underneath it.
  //
  // 2026-09-08 revision 11 (b): rail switched from "rail-ladder-hover" to
  // "rail-badge-hover" — same sprite-rename as the real (non-hover) rail
  // icon, see gen_stop_icons.py's draw_rail_pin comment.
  //
  // 2026-09-08 revision 12: subway's `lineSplit` branch (revision 11)
  // removed again — it used to route the 13 real M1/M4 shared-trunk
  // stations to a flat, pre-baked "metro-badge-split-hover" sprite, kept
  // separate from the live per-feature "metro-badge" + METRO_ICON_COLOR_EXPR
  // path because a split station's two colors aren't a single
  // `line_color`. That flat bake turned out to be exactly the kind of
  // GPU-minification-unreliable sprite this project already hit and fixed
  // once before for the "M" glyph (revision 9): correct at some
  // zooms/instances, stuck showing a stale/wrong render at others. Fixed
  // the same way as revision 9 — stop baking, always return the plain
  // live "metro-badge" (kind: "station-metro"); map-style.js's
  // hover-icon-metro-half-a/-b layers (revision 12) now handle a hovered
  // split station's two colors themselves, filtered on `line_split` on the
  // pushed hoverIcon feature (see setHoverIcon's call site below) — the
  // same live-SDF mechanism the non-hover "overlay-stations-split-a/-b"
  // layers already use, not a second bake.
  function stopHoverIcon(stopType) {
    if (stopType === "subway") return { iconName: "metro-badge", kind: "station-metro" };
    if (stopType === "rail") return { iconName: "rail-badge-hover", kind: "station" };
    if (stopType === "tram_stop") return { iconName: "veh-tram-badge-hover", kind: "stopBadge" };
    if (stopType === "bus_stop" || stopType === "bus_terminal") return { iconName: "veh-bus-badge-hover", kind: "stopBadge" };
    if (stopType === "airport") return { iconName: "stop-triangle-hover", kind: "stopDot" };
    return { iconName: "stop-dot-hover", kind: "stopDot" };
  }
  // 2026-09-15 (live report, "Попап, который появляется при долгом
  // наведении, теперь лишний"): the dwell-triggered hover popup (this
  // constant, `confirmedPopupKey`/`hoverPopup`/`showPopupContent`/
  // `revealPopup`/`bindHoverAction`/`confirmPopup` — all removed below) used
  // to be the only way to reach an object's details from the map without
  // first going through the search box. Now that a plain CLICK on any
  // hoverable object opens the same (or a strictly richer — see the new
  // "Открыть страницу" link, claude/implementation-log.md) "Объект на
  // карте" card directly (map.on("click") below), the popup only ever
  // duplicated what one more click already does instantly, with an extra
  // 5s wait in front of it. Removed everywhere (buildings, stops, roads,
  // quarters, landuse/water, search markers) rather than only for the
  // types with a real card, since every one of them already has an
  // equivalent instant click action. The instant part — highlight + cursor
  // change on hover — is untouched, see `handleHoverFeature`/
  // `setHighlightForFeature` below.

  let hoverFrame = null;
  let pendingHoverPoint = null;
  let pendingHoverLngLat = null;
  let hoverKey = null; // whatever's directly under the pointer right now (drives highlight + cursor, instantly)
  // Grace period before a "nothing under the cursor" frame actually clears
  // the highlight (2026-09-05, "Витиня продолжает сильно мельтешить" —
  // still flickering after the width-based `roads-hit` fix above). Root
  // cause here was different from the earlier quarter/street width issue:
  // OSM cuts a long street into many short ways, and "Витиня" specifically
  // hugs a river and is split into 10+ separate segments in one screen
  // (confirmed via queryRenderedFeatures). A single-pixel hit test can land
  // in a real, narrow gap right at the seam between two adjacent short
  // segments — no amount of *width* on one segment's own invisible proxy
  // line closes a gap that's really about where one segment ends and the
  // next begins. (A first attempt widened the query itself — checking a
  // small box around the cursor instead of one exact pixel — but that
  // let a nearby BUILDING win the hover instead of the street whenever the
  // box happened to reach one, which is worse: wrong object highlighted,
  // not just a flicker. Reverted.)
  // This is a query-time, not per-street-geometry, fix, so it also covers
  // any other street fragmented the same way, not just this one. A single
  // missed frame no longer clears the highlight outright — it schedules a
  // clear a short grace period out, cancelled the moment the very next
  // frame hits anything again (same object: nothing visibly changes at
  // all; a different object: `handleHoverFeature` swaps to it immediately,
  // same as always). Only a MISS that persists for the whole grace period
  // — genuinely leaving the object, not grazing a seam — actually clears.
  // Verified (Playwright, jittered real mouse moves ±8px over the exact
  // spot from the report): before this, feature-state toggled hover
  // true/false on almost every sample; after, it stayed continuously true
  // for the whole simulated hover.
  const HOVER_MISS_GRACE_MS = 150;
  let hoverMissTimer = null;
  let activeHighlight = null; // { kind: "building"|"road"|"place", sourceLayer, ids } | { kind: "stop" } | null

  function setHoverGeometry(features) {
    const src = map.getSource("hover");
    if (src) src.setData({ type: "FeatureCollection", features: features || [] });
  }
  // Counterpart to setHoverGeometry, for the "hoverIcon" source/"hover-icon"
  // layer (map-style.js) — stops/stations' own real-icon highlight, see
  // stopHoverIcon() above.
  function setHoverIcon(features) {
    const src = map.getSource("hoverIcon");
    if (src) src.setData({ type: "FeatureCollection", features: features || [] });
  }
  // See map-style.js's `hoverLabel` source comment: text-size can't be
  // driven by feature-state (layout property), so an enlarged stand-in
  // label is drawn from here instead while the real one fades out.
  function setHoverLabel(features) {
    const src = map.getSource("hoverLabel");
    if (src) src.setData({ type: "FeatureCollection", features: features || [] });
  }
  const HOVER_LABEL_LAYERS = ["hover-road-label", "hover-quarter-label"];
  // Shows the enlarged stand-in label with a soft grow-in instead of an
  // instant pop (2026-09-05, "плавные реакции" feedback) — the same
  // "set the end state one animation frame late" trick the (since-removed)
  // hover popup's own fade-in used, just on a paint property instead of a DOM
  // class. A GeoJSON `setData` swap has no fade of its own (unlike the real
  // label's `text-opacity`, which transitions smoothly via feature-state —
  // see map-style.js), so without this the stand-in would always appear at
  // full size the instant its data lands, however smooth the real label's
  // own fade-out is. Opacity is forced to 0 right before the new geometry
  // replaces the old, then eased back to 1 next frame — map-style.js
  // declares the actual transition duration on both layers.
  function showHoverLabel(features) {
    for (const id of HOVER_LABEL_LAYERS) map.setPaintProperty(id, "text-opacity", 0);
    setHoverLabel(features);
    requestAnimationFrame(() => {
      for (const id of HOVER_LABEL_LAYERS) map.setPaintProperty(id, "text-opacity", 1);
    });
  }

  // Turns off whatever's currently highlighted via `feature-state` (or, for
  // stops/search points/clusters, the geojson source) — the counterpart to
  // `setHighlightForFeature` below. Kept as its own step (used by
  // `clearHighlightOnly`, which is the only teardown left now that the hover
  // popup is gone — see the big comment above `hoverFrame` et al.).
  function clearHighlight() {
    if (!activeHighlight) return;
    if (activeHighlight.kind === "point") {
      // Both sources share the "point" highlight kind (search points/
      // clusters use `hover`, stops/stations use `hoverIcon` — see each
      // source's own comment in map-style.js) — clearing both unconditionally
      // is cheap and avoids having to also track which one is actually live.
      setHoverGeometry([]);
      setHoverIcon([]);
    } else {
      for (const id of activeHighlight.ids) {
        map.setFeatureState({ source: "base", sourceLayer: activeHighlight.sourceLayer, id }, { hover: false });
      }
    }
    if (activeHighlight.kind === "road" || activeHighlight.kind === "place") setHoverLabel([]);
    activeHighlight = null;
  }

  // Lights up whatever's now under the pointer. Buildings and quarter
  // labels light up by their own tile feature id; a street lights up by
  // NAME across every rendered segment that shares it (streets are cut
  // into many separate OSM ways — see pipeline/sofia-schema.yml — so
  // matching only the one segment under the cursor would leave the rest of
  // the same street dark). All three share one id space (`{source: "base",
  // sourceLayer, id}`), which is what "roads" and "road-labels-N" reading
  // the same feature-state get for free — highlighting the line also
  // highlights its label, from one `setFeatureState` call per id. Roads and
  // quarters also feed `hoverLabel` (map-style.js) with an enlarged stand-in
  // Joins LineString coordinate arrays end-to-end wherever two of them
  // share an endpoint (2026-09-05, "надпись вообще пропадает" — a street
  // name's enlarged hover stand-in vanishing completely instead of
  // growing). Root cause: OSM/tiling cuts a long street into many short
  // ways (already known from the `roads-hit` width fix above), and each
  // one is clipped again at tile edges — so the specific fragment nearest
  // the cursor can be genuinely short on screen (tens of px). The BASE
  // label (`road-labels-N`) still shows a full-looking name because
  // MapLibre is free to place ONE small label wherever among all the
  // fragments it fits — but our replacement built one Feature per
  // fragment and fed ALL of them to `hoverLabel` at once, so the enlarged
  // (bigger, so choosier) text had to fit within some single short
  // fragment's own length — confirmed by testing (Playwright): shrinking
  // the stand-in's text-size all the way down to 8px still didn't make it
  // render on the reported street, ruling out "just too big" and pointing
  // at fragment length itself as the wall. This merges same-named
  // fragments that are actually continuous (their endpoints coincide)
  // back into their real, longer shape before handing them to
  // `showHoverLabel` — the same street the base label draws from, not an
  // arbitrarily shorter slice of it.
  function mergeLineStrings(lines) {
    // Coordinates for the "same" shared vertex, as returned by
    // queryRenderedFeatures for the same feature id, are NOT bit-identical
    // across different query calls/viewport states — vector-tile coordinate
    // quantization can shift a vertex by ~4-7m (~4e-5 to 7e-5 degrees)
    // depending on which tile buffer answers the query. 1e-6 (~0.1mm) was
    // far too strict and silently prevented real, continuous fragments from
    // merging. 2e-4 (~15-20m) comfortably covers the observed drift while
    // staying well below the distance between genuinely separate segments.
    const EPS = 2e-4;
    const same = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
    const out = lines.map((l) => l.slice());
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < out.length; i++) {
        for (let j = 0; j < out.length; j++) {
          if (i === j) continue;
          const a = out[i], b = out[j];
          if (same(a[a.length - 1], b[0])) out[i] = a.concat(b.slice(1));
          else if (same(a[a.length - 1], b[b.length - 1])) out[i] = a.concat(b.slice(0, -1).reverse());
          else if (same(a[0], b[b.length - 1])) out[i] = b.concat(a.slice(1));
          else if (same(a[0], b[0])) out[i] = a.slice().reverse().concat(b.slice(1));
          else continue;
          out.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
    return out;
  }

  // How much bigger than its OWN current on-screen size the hover stand-in
  // grows (2026-09-05, same "надпись вообще пропадает" fix as the line-
  // merge above — this is the other half of it). The stand-in used to be a
  // single flat size curve (8px→15, 18px→26) applied to every road class
  // alike, regardless of how big that road's OWN label already was — for a
  // residential street (whose own tier tops out at 13px, `ROAD_LABEL_TIERS`
  // in map-style.js) that meant nearly DOUBLING the text size for the
  // enlarged version, which needs a lot more line length to fit than even
  // the merged geometry above reliably has. Scaling relative to the road's
  // own tier size instead keeps small streets' growth modest (so it still
  // fits) while letting a boulevard, which is both long AND already
  // labeled bigger, grow by the same proportion into something that reads
  // clearly larger. `ROAD_LABEL_TIERS` is declared in map-style.js as a
  // plain top-level `const` (no modules/bundler in this project — see
  // index.html's plain `<script>` tags), so it's already in scope here.
  const HOVER_LABEL_GROWTH = 1.3;
  function roadHoverLabelSize(highway, zoom) {
    const tier = ROAD_LABEL_TIERS.find((t) => t.classes.includes(highway)) || ROAD_LABEL_TIERS[ROAD_LABEL_TIERS.length - 1];
    const [s0, s1] = tier.size;
    const t = Math.max(0, Math.min(1, (zoom - tier.minzoomFull) / 4));
    return (s0 + (s1 - s0) * t) * HOVER_LABEL_GROWTH;
  }

  // label — the one part of "highlight" that feature-state can't drive
  // directly, since text-size is a layout property.
  function setHighlightForFeature(layerId, f, props) {
    if (layerId === "buildings" && f.id != null) {
      map.setFeatureState({ source: "base", sourceLayer: "building", id: f.id }, { hover: true });
      activeHighlight = { kind: "building", sourceLayer: "building", ids: [f.id] };
    } else if (layerId === "place-labels-hit" && f.id != null) {
      map.setFeatureState({ source: "base", sourceLayer: "place", id: f.id }, { hover: true });
      activeHighlight = { kind: "place", sourceLayer: "place", ids: [f.id] };
      showHoverLabel([{ type: "Feature", geometry: f.geometry, properties: { kind: "quarter", name: props.name } }]);
    } else if ((layerId === "landuse" || layerId === "water") && f.id != null) {
      // 2026-09-15 (map-display point 5) — same feature-state mechanism as
      // buildings/quarters, just driving the "fill-outline-color" hover
      // case in map-style.js instead of a darker fill or a label swap: see
      // that layer's own comment for why an outline reads clearly against
      // every landuse fill color without needing a per-category hover
      // color table the way buildings' BUILDING_FILL_EXPR has.
      map.setFeatureState({ source: "base", sourceLayer: layerId, id: f.id }, { hover: true });
      activeHighlight = { kind: layerId, sourceLayer: layerId, ids: [f.id] };
    } else if (layerId === "roads-hit") {
      const matches = props.name
        ? map.queryRenderedFeatures(undefined, { layers: ["roads"], filter: ["==", ["get", "name"], props.name] })
        : [f];
      const ids = [...new Set(matches.map((m) => m.id).filter((id) => id != null))];
      for (const id of ids) map.setFeatureState({ source: "base", sourceLayer: "transportation", id }, { hover: true });
      activeHighlight = { kind: "road", sourceLayer: "transportation", ids };
      const mergedLines = mergeLineStrings(matches.map((m) => m.geometry.coordinates));
      const size = roadHoverLabelSize(props.highway, map.getZoom());
      showHoverLabel(
        mergedLines.map((coordinates) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates },
          properties: { kind: "road", name: props.name, size },
        }))
      );
    } else if (layerId === "overlay-stations" || layerId === "overlay-stops" || layerId === "overlay-stops-badge") {
      // No feature ids in this tileset (see the "hoverIcon" source's
      // comment in map-style.js) — geometry-in-a-source is the fallback.
      // ("overlay-stations" is a plain GeoJSON source now, not a tileset —
      // its features do carry a `properties.id`, but not a top-level
      // MapLibre `id` without a `promoteId` config this style doesn't set,
      // so the same geometry fallback applies here too.)
      // 2026-09-08 revision 8: pushes into `hoverIcon` (the real icon's own
      // silhouette, see stopHoverIcon()) instead of the old generic
      // fixed-radius circle — see that function's comment.
      // 2026-09-08 revision 10: `line_color` carried through too — the
      // hovered metro instance (map-style.js's hover-icon-metro layer)
      // reads it via the same METRO_ICON_COLOR_EXPR the real station icon
      // uses, so a hovered station is never a different color than its own
      // un-hovered badge. undefined for rail/every other stop type, same
      // as on the real feature — harmless, those layers don't read it.
      // 2026-09-08 revision 12: `line_split` now passed through directly on
      // the pushed feature (alongside `line_color`) rather than into
      // stopHoverIcon() — map-style.js's hover-icon-metro-half-a/-b layers
      // filter on it themselves, the same way "overlay-stations-split-a/-b"
      // filter on the real feature's `line_split`. undefined for
      // non-subway stop types, harmless — those layers don't read it.
      setHoverIcon([{ type: "Feature", geometry: f.geometry, properties: { ...stopHoverIcon(props.stop_type), line_color: props.line_color, line_split: props.line_split } }]);
      activeHighlight = { kind: "point" };
    } else if (layerId === "search-points") {
      // Supercluster-managed source, same "no stable id to hang
      // feature-state off" situation as stops — see the hover-point layer's
      // comment in map-style.js. `hr` is a touch bigger than the marker's
      // own 6px radius so the ring reads as "around it", not "on top of it".
      setHoverGeometry([{ type: "Feature", geometry: f.geometry, properties: { hr: 10 } }]);
      activeHighlight = { kind: "point" };
    } else if (layerId === "search-clusters") {
      // Same idea, sized to roughly match this cluster's own circle (the
      // step function in map-style.js's "search-clusters" layer) plus a
      // small margin, so bigger clusters get a visibly bigger ring too.
      const count = props.point_count || 0;
      const base = count >= 30 ? 22 : count >= 10 ? 18 : 14;
      setHoverGeometry([{ type: "Feature", geometry: f.geometry, properties: { hr: base + 6 } }]);
      activeHighlight = { kind: "point" };
    }
  }

  // Drops the highlight and resets the cursor/dwell-miss state — the only
  // teardown needed now that hovering no longer confirms a popup (2026-09-15
  // removal, see the big comment above `hoverFrame` et al.). Used both for a
  // momentary gap mid-pan (`hoverMissTimer`, below) and for the pointer
  // actually leaving the map (`mouseout`, below) — nothing left to treat
  // differently between those two cases now that there's no confirmed popup
  // to preserve through a brief empty patch.
  function clearHighlightOnly() {
    clearTimeout(hoverMissTimer);
    hoverMissTimer = null;
    clearHighlight();
    map.getCanvas().style.cursor = "";
    hoverKey = null;
  }

  // The road hover popup's "Найти на карте →": used to just drop the bare
  // street name into the search box and run a plain text search — fine
  // when a name means one street, wrong when it means several unrelated
  // ones (see apiStreetAt/streetCluster.js) since it opened all of them at
  // once instead of the one actually clicked. Resolves via the click point
  // first, then opens exactly that one street the same way a search result
  // row would.
  async function resolveStreetClick({ name, lat, lng }) {
    const resolved = await apiStreetAt(name, lat, lng);
    if (!resolved.found) {
      // No server-side match somehow (shouldn't happen — the tile itself
      // gave us this name) — fall back to the old best-effort behaviour
      // rather than silently doing nothing.
      els.input.value = name;
      updateSubmit();
      return runSearch();
    }
    const subtitle = resolved.district ? `${TYPE_LABEL.street} · ${resolved.district}` : TYPE_LABEL.street || "";
    // The actual clicked point, not the street's own geometry fallback —
    // see loadStreetHouses's own comment on why this matters for a large
    // linear object the same way it does for a park/district polygon.
    loadStreetHouses({ type: "street", id: resolved.id, name: resolved.name, subtitle }, { lat, lng });
  }

  // Only carries real information (an address the caller doesn't already
  // show as its own name, or a company's rubric/street) — see renderSelected
  // point 3 comment for why a bare repeat of TYPE_LABEL used to be here
  // instead, on both this function's `item` and selectFromUrl's below.
  function addressSubtitle(obj) {
    const addr = [obj.addr_street, obj.housenumber].filter(Boolean).join(" ");
    return obj.name && addr && addr !== obj.name ? addr : "";
  }
  function companySubtitle(obj) {
    const addr = [obj.addr_street, obj.housenumber].filter(Boolean).join(" ");
    return [obj.rubric, addr].filter(Boolean).join(" · ");
  }

  // The hover popup's "Подробнее" for a real object (address/company/stop —
  // whatever /api/hit-test resolved the point to): opens the exact same
  // detail view `choose()` renders for a search result, since that's the
  // closest thing to "the object's page" that exists today.
  async function openObjectDetails({ type, id, name, lat, lng }) {
    const item = { type, id, name, subtitle: "" };
    // `lat`/`lng`, when given, is the point actually clicked (every call
    // site below now passes `e.lngLat` through) — used as the card's
    // coordinates/route anchor for a point object too, falling back to the
    // fetched object's own lat/lon only when no click point was supplied
    // (there is none today, but keeps this safe for a future caller).
    const clickCoords = lat != null ? { lat, lng } : null;
    if (type === "address") {
      const obj = await apiObject("address", id);
      if (obj) {
        item.name = obj.name || item.name;
        item.subtitle = addressSubtitle(obj);
      }
      renderSelected(item, obj, clickCoords || (obj && obj.lat != null ? { lat: obj.lat, lng: obj.lon } : null));
      if (obj && obj.geometry) {
        setSelectedGeometry([{ type: "Feature", geometry: obj.geometry, properties: {} }]);
        const coords = flattenCoords(obj.geometry);
        if (coords.length) fitBoundsCoords(coords);
      }
      return;
    }
    renderSelected(item, null, clickCoords);
    if (type === "company") {
      const obj = await apiObject("company", id);
      if (obj) appendCompanyDetails(obj);
    } else if (type === "stop" || type === "metro" || type === "rail" || type === "terminal") {
      // Same condition choose() already uses for a search-result row of
      // these types (server/src/routes/object.js's /api/object/:type/:id
      // only has a "stop" case — metro/rail/terminal are all rows in the
      // same `stops` table, just with a nicer TYPE_LABEL for display, so
      // the API call itself is always "stop" regardless of which of the
      // four this was). This branch used to check only `type === "stop"`,
      // which meant a hover-popup "Подробнее" click for a metro/rail/
      // terminal object (unlike the exact same object reached via search)
      // rendered the name but never fetched its route list — same bug
      // class as the missing hover/click wiring above, just one level
      // deeper (found while wiring up "overlay-stations").
      const obj = await apiObject("stop", id);
      if (obj) appendStopRoutes(obj);
    }
  }

  // 2026-09-15 live report ("при клике со страницы адреса, на карте должен
  // вызываться необходимый объект. Сейчас кнопка развернуть, просто открывает
  // большую карту"): entry point for the new `?sel=type:id` deep link
  // (htmlPage.js's mapSelectHref/mapSelectLink — today only the house page's
  // "Развернуть"/"Открыть на карте" use it, see routes/pages.js) — selects
  // the exact object via the SAME `/api/object/:type/:id` + render/fit flow
  // `choose()` already uses for a clicked search-result row, instead of the
  // old `?q=`-based text re-search (which can now land on a different row
  // than intended once search results bubble/group — Проблема B). Reuses
  // `openObjectDetails` for the types it already covers (address/company/
  // stop/metro/rail/terminal); street/district/settlement need their own
  // handling below since `openObjectDetails` never had to cover them (no
  // hover-popup "Подробнее" exists for those object types today).
  async function selectFromUrl(type, id) {
    if (type === "district" || type === "settlement" || type === "raion" || type === "park") {
      const obj = await apiObject(type, id);
      if (!obj) return;
      const item = { type, id: obj.id, name: obj.name, subtitle: "" };
      renderSelected(item, obj, obj.lat != null ? { lat: obj.lat, lng: obj.lon } : null);
      if (obj.geometry) {
        setSelectedGeometry([{ type: "Feature", geometry: obj.geometry, properties: {} }]);
        const coords = flattenCoords(obj.geometry);
        if (coords.length) fitBoundsCoords(coords);
      }
      return;
    }
    if (type === "street") {
      const obj = await apiObject("street", id);
      if (!obj) return;
      return loadStreetHouses({ type: "street", id: obj.id, name: obj.name, subtitle: TYPE_LABEL.street || "" });
    }
    if (type === "address") {
      const obj = await apiObject("address", id);
      if (!obj) return;
      // Same fallback shape as server/src/routes/search.js's own
      // `fallbackName` — a plain house with no `name` tag of its own is
      // shown as "<street> <number>", not blank. `obj.addr_street` already
      // comes back designation-normalized (object.js runs it through
      // `withDesignation` itself), so no extra work needed here.
      const name = obj.name || [obj.addr_street, obj.housenumber].filter(Boolean).join(" ");
      const item = { type: "address", id: obj.id, name, subtitle: addressSubtitle(obj) };
      renderSelected(item, obj, obj.lat != null ? { lat: obj.lat, lng: obj.lon } : null);
      if (obj.geometry) {
        setSelectedGeometry([{ type: "Feature", geometry: obj.geometry, properties: {} }]);
        const coords = flattenCoords(obj.geometry);
        if (coords.length) fitBoundsCoords(coords);
      }
      return;
    }
    if (type === "company") {
      const obj = await apiObject("company", id);
      if (!obj) return;
      const item = { type: "company", id: obj.id, name: obj.name, subtitle: companySubtitle(obj) };
      renderSelected(item, obj, obj.lat != null ? { lat: obj.lat, lng: obj.lon } : null);
      if (obj.lat != null && obj.lon != null) {
        setSelectedGeometry([{ type: "Feature", geometry: { type: "Point", coordinates: [obj.lon, obj.lat] }, properties: {} }]);
        flyTo(obj.lat, obj.lon, 17);
      }
      appendCompanyDetails(obj);
      return;
    }
    if (type === "stop" || type === "metro" || type === "rail" || type === "terminal") {
      // Same table-collapsing note as openObjectDetails above: /api/object
      // only knows "stop" — metro/rail/terminal are all the same `stops`
      // table row, just a nicer TYPE_LABEL for display.
      const obj = await apiObject("stop", id);
      if (!obj) return;
      const item = { type, id: obj.id, name: obj.name, subtitle: "" };
      renderSelected(item, null, obj.lat != null ? { lat: obj.lat, lng: obj.lon } : null);
      if (obj.lat != null && obj.lon != null) {
        setSelectedGeometry([{ type: "Feature", geometry: { type: "Point", coordinates: [obj.lon, obj.lat] }, properties: {} }]);
        flyTo(obj.lat, obj.lon, 17);
      }
      appendStopRoutes(obj);
    }
  }

  // Highlight + cursor update instantly on every hover change (immediate
  // feedback that something is interactive). Used to also arm a dwell timer
  // that revealed a small popup after the pointer rested on one object for a
  // while ("долгого удержания курсора… на объекте") — removed 2026-09-15 (see
  // the big comment above `hoverFrame` et al.): every layer this covers now
  // has an equivalent instant click action (map.on("click") below), so the
  // popup only ever repeated, after a wait, what a click already does right
  // away.
  function handleHoverFeature(f, lngLat) {
    const layerId = f.layer.id;
    const props = f.properties || {};
    const key = `${layerId}:${f.id != null ? f.id : JSON.stringify(props)}`;
    map.getCanvas().style.cursor = "pointer";
    // A real hit cancels any pending "clear on persistent miss" from a
    // moment ago (see HOVER_MISS_GRACE_MS above) — whether it's the same
    // object (nothing to do, the highlight never actually turned off) or a
    // different one (the normal swap below handles that).
    if (hoverMissTimer) {
      clearTimeout(hoverMissTimer);
      hoverMissTimer = null;
    }

    if (key === hoverKey) return; // still the same object as last frame — nothing changed

    clearHighlight();
    hoverKey = key;
    setHighlightForFeature(layerId, f, props);
  }

  function processHover(point, lngLat) {
    // While picking a route point (routePicking, see the routing section
    // above) the cursor is pinned to "crosshair" for the whole map, not just
    // hover-able features — skip the normal highlight/cursor churn entirely
    // rather than have this fight startRoutePicking's own cursor setting.
    if (routePicking) return;
    // Same idea as the click handler above: with exactly one route point
    // filled, the map is implicitly in "pick the other one" mode, so it
    // gets the same crosshair cursor as the explicit routePicking case
    // instead of the normal per-feature hover highlight/pointer cursor.
    if (mode === "route" && autoRoutePickRole()) {
      map.getCanvas().style.cursor = "crosshair";
      return;
    }
    // Unnamed "landuse"/"water" features are dropped right here (2026-09-15,
    // map-display point 5) rather than filtered further down — most
    // residential/industrial/commercial landuse polygons and plenty of
    // small water features carry no OSM `name` tag at all, and those
    // shouldn't get a hover cursor/highlight for an object with nothing to
    // show. Every other layer here always has SOME identity worth hovering.
    const features = map.queryRenderedFeatures(point, { layers: HOVER_LAYERS }).filter(
      (f) => (f.layer.id !== "landuse" && f.layer.id !== "water") || (f.properties && f.properties.name)
    );
    if (!features.length) {
      // Passing through empty space (a gap between buildings, a gutter
      // between road segments) drops the highlight — but not on the very
      // first miss: see HOVER_MISS_GRACE_MS above for why a single missed
      // frame gets a short grace period instead of clearing instantly.
      if (hoverKey !== null && !hoverMissTimer) {
        hoverMissTimer = setTimeout(() => {
          hoverMissTimer = null;
          clearHighlightOnly();
        }, HOVER_MISS_GRACE_MS);
      }
      return;
    }
    handleHoverFeature(pickHoverFeature(features, point), lngLat);
  }

  // 2026-09-16 (live feedback, second issue, "к курсору можно добавить
  // to/from если реализуемо"): a small label that tracks the raw pointer
  // position and names which slot the next map click will fill, while the
  // map is in crosshair mode (explicit routePicking OR the implicit
  // autoRoutePickRole case). A plain fixed-position <div>, not a MapLibre
  // Marker/Popup — it needs real screen coordinates, not a map lng/lat, and
  // must never intercept the click itself (pointer-events: none in CSS).
  // Lazily created once and reused rather than rebuilt on every frame.
  let routePickLabelEl = null;
  function routePickLabel() {
    if (!routePickLabelEl) {
      routePickLabelEl = document.createElement("div");
      routePickLabelEl.className = "map-route-pick-label";
      document.body.appendChild(routePickLabelEl);
    }
    return routePickLabelEl;
  }
  function updateRoutePickLabel(clientX, clientY) {
    const role = mode === "route" ? routePicking || autoRoutePickRole() : null;
    const el = routePickLabel();
    if (!role || clientX == null) {
      el.style.display = "none";
      return;
    }
    el.textContent = role === "from" ? "От" : "До";
    el.style.left = `${clientX + 16}px`;
    el.style.top = `${clientY + 14}px`;
    el.style.display = "block";
  }
  function hideRoutePickLabel() {
    if (routePickLabelEl) routePickLabelEl.style.display = "none";
  }

  // `queryRenderedFeatures` isn't free, so it doesn't run on every
  // `mousemove` pixel — at most one call is queued per animation frame,
  // using the latest pointer position by the time that frame actually
  // runs. That caps the extra per-frame cost to something bounded no
  // matter how fast the mouse moves, which matters most on exactly the
  // "lite"/software-rendered visitors this app already goes out of its way
  // for elsewhere (map-style.js's detectRenderQuality). The pick-label
  // update itself is cheap (no layout read, just two style writes) so it
  // runs right away rather than waiting on that same animation frame.
  map.on("mousemove", (e) => {
    pendingHoverPoint = e.point;
    pendingHoverLngLat = e.lngLat;
    if (e.originalEvent) updateRoutePickLabel(e.originalEvent.clientX, e.originalEvent.clientY);
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = null;
      processHover(pendingHoverPoint, pendingHoverLngLat);
    });
  });
  // Actually leaving the canvas always drops the highlight (2026-09-15: used
  // to also check whether the pointer was heading onto the open hover popup
  // itself, via `pointInPopupRect` — removed along with the popup, see the
  // big comment above `hoverFrame` et al.).
  map.on("mouseout", () => {
    clearHighlightOnly();
    hideRoutePickLabel();
  });

  // ---- click on a hovered object / empty map spot -------------------------------------------------
  // Reuses whatever's already hovered rather than re-deriving it from
  // scratch — cheaper than re-querying, and matches exactly what the
  // highlight/cursor already told the person was under the pointer.
  // (2026-09-15: this used to also tear down a confirmed hover popup first
  // — removed along with the popup itself, see the big comment above
  // `hoverFrame` et al.)
  map.on("click", async (e) => {
    // Picking a route point (routePicking, see the routing section above)
    // overrides every other click behaviour on the map — the point clicked
    // is captured as-is (with a best-effort name via apiHitTest inside
    // handleRoutePick) instead of opening whatever object card it would
    // normally resolve to.
    if (routePicking) {
      await handleRoutePick(e.lngLat.lat, e.lngLat.lng);
      return;
    }
    if (mode === "route") {
      const autoRole = autoRoutePickRole();
      if (autoRole) {
        await handleRoutePick(e.lngLat.lat, e.lngLat.lng, autoRole);
        return;
      }
    }
    const hoverHit = pickHoverFeature(map.queryRenderedFeatures(e.point, { layers: HOVER_LAYERS }), e.point);
    if (hoverHit) {
      const layerId = hoverHit.layer.id;
      const props = hoverHit.properties || {};
      // This layer's own GeoJSON already carries name/id/type, so it skips
      // /api/hit-test (whose ~20m match radius several deduped stations'
      // centroids fall outside of) entirely.
      if (layerId === "overlay-stations") {
        openObjectDetails({ type: props.type, id: props.id, name: props.name, lat: e.lngLat.lat, lng: e.lngLat.lng });
        return;
      }
      if (layerId === "buildings" || layerId === "overlay-stops" || layerId === "overlay-stops-badge") {
        const data = await apiHitTest(e.lngLat.lat.toFixed(6), e.lngLat.lng.toFixed(6));
        const feature = data.features && data.features[0];
        if (feature) openObjectDetails({ type: feature.properties.type, id: feature.properties.id, name: feature.properties.name, lat: e.lngLat.lat, lng: e.lngLat.lng });
        return;
      }
      // "place-labels-hit" (quarters) and "landuse"/"water" (park/water
      // fills) — 2026-09-16, see resolveAreaClick's own comment: used to be
      // a native popup saying "Страница появится позже" unconditionally
      // (place-labels-hit), or silently did nothing at all on an unnamed
      // patch (landuse/water) — both now open the same unified object card
      // every other type uses. BUT only from AREA_RESOLVE_MINZOOM up: below
      // it (small-scale overview) a single polygon here can cover most of
      // the visible map, so resolving "you clicked inside district/park X"
      // isn't useful — this falls through to exactly the same plain-
      // coordinate path genuinely empty space always used below (one more
      // apiHitTest in case a building overlaps by a few px, then the
      // "Точка на карте" card) instead of guessing at the wrong page.
      if (layerId === "place-labels-hit" || layerId === "landuse" || layerId === "water") {
        if (props.name && map.getZoom() >= AREA_RESOLVE_MINZOOM) {
          resolveAreaClick(layerId === "place-labels-hit" ? "district" : "park", props.name, e.lngLat.lat, e.lngLat.lng);
          return;
        }
        const { lat, lng } = e.lngLat;
        const data = await apiHitTest(lat.toFixed(6), lng.toFixed(6));
        const feature = data.features && data.features[0];
        if (feature) {
          openObjectDetails({ type: feature.properties.type, id: feature.properties.id, name: feature.properties.name, lat, lng });
          return;
        }
        renderSelected({ type: "point", id: null, name: "Точка на карте", subtitle: "" }, null, { lat, lng });
        return;
      }
      // A search result marker: the exact same action as clicking its row
      // in the results list on the left (choose() handles selection state,
      // the detail card, and re-centering — no need to duplicate any of it
      // here).
      if (layerId === "search-points") {
        choose(props.index);
        return;
      }
      // A cluster: no object to open, so the click's job is to zoom in
      // until it splits. The textbook way to do this is
      // `source.getClusterExpansionZoom(clusterId, callback)` — but tested
      // in sandbox (Playwright) that call's callback never fires at all,
      // even after 9+ seconds (confirmed hung, not just slow: the request
      // reaches a real worker `actor`, just never comes back). That's a
      // round trip to the same GeoJSON worker thread that's already
      // maintaining the cluster index, so it should be near-instant — a
      // hang that consistent smells like something in *this* sandboxed
      // Chromium's worker messaging under software rendering, not a fluke,
      // and the one person this ships to is also on software-rendered
      // Chrome (see README "Раунд 3") — the same conditions, not just the
      // same code path. Rather than ship a click that might silently do
      // nothing for the one real user, this jumps straight to
      // `clusterMaxZoom` (map-style.js's `searchResults` source, 16) at the
      // cluster's own center instead: no worker round trip, so it can't
      // hang, and zoom 16 is the level past which this source stops
      // clustering at all, so the cluster is always fully split there
      // (never partially, unlike a computed expansion zoom that stops as
      // soon as it *first* splits into fewer, still-clustered pieces).
      if (layerId === "search-clusters") {
        map.easeTo({ center: hoverHit.geometry.coordinates, zoom: Math.max(map.getZoom() + 2, 16) });
        return;
      }
      if (props.name) {
        // Same fix as the hover popup's "Найти на карте →" (see
        // resolveStreetClick) — this is a SEPARATE, direct click-on-road
        // path (fires immediately, without waiting for/going through the
        // hover popup at all) that carried the exact same bug and was
        // missed in the first pass: it used to just drop the bare name
        // into the search box, which for a name shared by several
        // unrelated real streets (streetCluster.js) opened all of them at
        // once instead of the one actually clicked.
        resolveStreetClick({ name: props.name, lat: e.lngLat.lat, lng: e.lngLat.lng });
      }
      return; // unnamed road segment (footway/service/...) — nothing to open
    }
    // 2026-09-16 (live report — unify the card, not just the layers that
    // already had a dedicated click branch above): this used to be a native
    // maplibregl.Popup, the one path left rendering something other than
    // the object card. `/api/hit-test` only ever checks point-scale features
    // (buildings, stops, companies), so a click that lands nowhere near one
    // — but still genuinely inside a park or quarter that has no rendered
    // HOVER_LAYERS feature at the click point (e.g. below place-labels-hit's
    // own minzoom) — gets one more chance via the same /api/area-at lookup
    // resolveAreaClick uses, before finally opening a plain "nothing here"
    // card instead of a popup.
    const { lat, lng } = e.lngLat;
    const data = await apiHitTest(lat.toFixed(6), lng.toFixed(6));
    const feature = data.features && data.features[0];
    if (feature) {
      openObjectDetails({ type: feature.properties.type, id: feature.properties.id, name: feature.properties.name, lat, lng });
      return;
    }
    // Same AREA_RESOLVE_MINZOOM gate as the place-labels-hit/landuse/water
    // branch above (2026-09-16) — skipped below it, straight to the plain
    // coordinate card, rather than resolving a small-scale click into
    // whichever huge park/district polygon happens to contain it.
    if (map.getZoom() >= AREA_RESOLVE_MINZOOM) {
      for (const kind of ["park", "district"]) {
        const areaHit = await fetchAreaAt(kind, lat, lng);
        if (areaHit.found) {
          await renderResolvedArea(areaHit.type, areaHit.id, lat, lng);
          return;
        }
      }
    }
    renderSelected({ type: "point", id: null, name: "Точка на карте", subtitle: "" }, null, { lat, lng });
  });

  // ---- initial state from URL (?sel=type:id, or ?q=&type=) ---------------
  // `?sel=` (2026-09-15 live report fix, see selectFromUrl/mapSelectHref
  // above) takes priority over the older `?q=`/`type` text-search params
  // when both are somehow present — it names an exact object, which is
  // strictly more specific than a query that merely used to resolve to it.
  map.on("load", () => {
    const params = new URLSearchParams(location.search);
    const sel = params.get("sel");
    if (sel) {
      const i = sel.indexOf(":");
      if (i > 0) {
        const selType = sel.slice(0, i);
        const selId = decodeURIComponent(sel.slice(i + 1));
        selectFromUrl(selType, selId);
        return;
      }
    }
    const q = params.get("q");
    const type = params.get("type");
    if (type && FILTER_GROUP_OF[type] !== undefined) {
      typeFilter = type;
      const group = FILTER_GROUP_OF[type];
      const btn = ui.querySelector(`.map-search-more [data-filter="${type}"]`);
      ui.querySelectorAll(".map-search-filters > [data-filter]").forEach((b) => b.classList.toggle("is-active", b.dataset.filter === group));
      if (btn) {
        btn.classList.add("is-active");
        els.more.hidden = false;
        els.moreToggle.setAttribute("aria-expanded", "true");
      }
    }
    if (q) {
      els.input.value = q;
      updateSubmit();
      runSearch();
    }
  });
})();
