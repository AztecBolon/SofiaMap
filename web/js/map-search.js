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
    metro: "Станция метро", stop: "Остановка", rail: "Ж/д платформа", terminal: "Автовокзал / аэропорт",
    route: "Маршрут транспорта", rubric: "Рубрика организаций", company: "Организация",
  };
  const TYPE_GROUP = {
    address: "place", street: "place", district: "place", settlement: "place",
    metro: "transport", stop: "transport", rail: "transport", terminal: "transport", route: "transport",
    rubric: "org", company: "org",
  };
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
  let mode = "listing"; // listing | object | rubric | rubric-company | street-houses | street-house | route-stub
  let rubricItems = [];
  let rubricMeta = null;
  let streetHouseItems = [];
  let streetHouseMeta = null;
  let searchSnapshot = null;
  let selectedIndex = -1;
  let searchSeq = 0;
  let debounceTimer = null;

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
  }
  function setSearchPoints(features) {
    const src = map.getSource("searchResults");
    if (src) src.setData({ type: "FeatureCollection", features: features || [] });
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

  // ---- rendering: result rows -------------------------------------------------
  function resultRow(item, index) {
    const isRubric = item.type === "rubric";
    const row = document.createElement("div");
    row.className = "map-search-result" + (isRubric ? " map-search-result--rubric" : "");
    row.dataset.index = String(index);
    row.innerHTML = `
      <span class="map-search-result__icon">${ICONS[TYPE_GROUP[item.type] || "place"]}</span>
      <span class="map-search-result__text">
        <strong>${esc(item.name)}</strong>
        <span>${esc(item.subtitle || TYPE_LABEL[item.type] || "")}</span>
      </span>`;
    row.addEventListener("click", () => choose(index));
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

    if (item.type === "address" || item.type === "district" || item.type === "settlement") {
      const obj = await apiObject(item.type, item.id);
      renderSelected(item, obj);
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
    renderSelected(item, null);
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
  async function loadStreetHouses(item) {
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
    if (obj && obj.geometry && obj.geometry.geometries) {
      const feats = obj.geometry.geometries.map((g) => ({ type: "Feature", geometry: g, properties: {} }));
      setSelectedGeometry(feats);
      const coords = feats.flatMap((f) => flattenCoords(f.geometry));
      if (coords.length) fitBoundsCoords(coords);
    }
    renderStreetHousesList(item);
  }

  function renderStreetHousesList(item) {
    mode = "street-houses";
    const name = streetHouseMeta.name || item.name;
    els.headTitle.textContent = name;
    els.resultCount.textContent = `Домов: ${streetHouseMeta.total}`;
    const head = document.createElement("div");
    head.className = "map-rubric-head";
    head.innerHTML = `
      <button class="map-selected-back js-street-houses-back" type="button">← К результатам поиска</button>
      <strong>${esc(TYPE_LABEL.street)}</strong>
      <h2>${esc(name)}</h2>
      <p>${streetHouseMeta.total} домов с адресом${streetHouseMeta.partial ? " (показаны первые " + streetHouseItems.length + ")" : ""}</p>`;
    els.results.innerHTML = "";
    els.results.appendChild(head);
    head.querySelector(".js-street-houses-back").addEventListener("click", returnFromStreetHouses);

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

  function selectStreetHouse(index) {
    mode = "street-house";
    const item = streetHouseItems[index];
    if (!item) return;
    Array.from(els.results.querySelectorAll(".map-rubric-company")).forEach((r, i) => r.classList.toggle("is-active", i === index));
    if (item.lat != null) {
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

  function renderSelected(item, obj) {
    mode = "object";
    els.headTitle.textContent = "Объект на карте";
    els.resultCount.textContent = TYPE_LABEL[item.type] || "Объект";
    const subtitle = item.subtitle || "";
    els.results.innerHTML = `
      <div class="map-selected-card">
        <button class="map-selected-back js-back" type="button">← К результатам</button>
        <span class="map-selected-type">${esc(TYPE_LABEL[item.type] || "Объект")}</span>
        <h2>${esc(item.name)}</h2>
        <p>${esc(subtitle)}</p>
        <div class="js-extra"></div>
      </div>`;
    els.results.querySelector(".js-back").addEventListener("click", returnToResults);
    updateShare();
  }

  function appendCompanyDetails(obj) {
    const extra = els.results.querySelector(".js-extra");
    if (!extra) return;
    const rows = [];
    if (obj.phone) rows.push(`<p>☎ ${esc(obj.phone)}</p>`);
    if (obj.website) rows.push(`<p><a class="map-selected-link" href="${esc(obj.website)}" target="_blank" rel="noopener">${esc(obj.website)}</a></p>`);
    if (obj.opening_hours) rows.push(`<p>Часы работы: ${esc(obj.opening_hours)}</p>`);
    extra.innerHTML = rows.join("");
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
    mode = "object";
    els.headTitle.textContent = "Маршрут транспорта";
    els.resultCount.textContent = TYPE_LABEL.route;
    els.results.innerHTML = `
      <div class="map-selected-card">
        <button class="map-selected-back js-back" type="button">← К результатам</button>
        <span class="map-selected-type">${esc(TYPE_LABEL.route)}</span>
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
    if (mode === "rubric-company" && rubricMeta) {
      return renderRubricList();
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

  function selectRubricCompany(index) {
    mode = "rubric-company";
    const item = rubricItems[index];
    Array.from(els.results.querySelectorAll(".map-rubric-company")).forEach((r, i) => r.classList.toggle("is-active", i === index));
    if (item.lat != null) {
      setSelectedGeometry([{ type: "Feature", geometry: { type: "Point", coordinates: [item.lng, item.lat] }, properties: {} }]);
      flyTo(item.lat, item.lng, 17);
    }
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

  // ---- routing stub -------------------------------------------------
  els.routeOpen.addEventListener("click", () => {
    mode = "route-stub";
    setSelectedGeometry([]);
    els.headTitle.textContent = "Маршрут";
    els.resultCount.textContent = "В разработке";
    els.results.innerHTML = `
      <div class="map-route-stub">
        <button class="map-selected-back js-back" type="button">← К результатам</button>
        <span class="badge">Скоро</span>
        <h2>Построение маршрута появится позже</h2>
        <p>Расчёт маршрутов между двумя точками (общественный транспорт, пешком) — отдельная задача,
        которая разрабатывается независимо от карты. Здесь будет выбор точек А и Б на карте и
        расчёт вариантов проезда.</p>
      </div>`;
    els.results.querySelector(".js-back").addEventListener("click", returnToResults);
  });

  // ---- hover: highlight + cursor + popup on buildings/streets/quarters/stops/search results --------------
  // Buildings, street lines, quarter names, stops, and now search result
  // markers/clusters all get the same three things on hover: (1) a
  // highlight (feature-state on the vector layers; the "hover" geojson
  // source for the three point layers with no stable tile id — stops,
  // search points, search clusters), (2) a pointer cursor instead of the
  // default grab, (3) a small popup with whatever info is cheaply
  // available (a cluster is the one exception — see `showPopupContent`).
  // Where a real detail view already exists — address/company/stop via the
  // same apiObject+renderSelected flow `choose()` uses for a search
  // result — the popup's "Подробнее" opens it; that's today's stand-in for
  // "the object's page" (none exist yet — "Страниц сейчас нет,
  // планируем"). Quarters (place-labels) have no backing database object
  // at all, only an OSM point name (pipeline/sofia-schema.yml), so their
  // popup says a page is coming instead of faking a link — same "Скоро"
  // convention as the routing stub above. This is documented as a single
  // rules table (per object type: highlight / cursor / hover popup /
  // click) in the project notes — see `claude/hover-click-rules.md` — kept
  // in sync with whatever's implemented here.
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
  const HOVER_LAYERS = ["buildings", "roads-hit", "place-labels-hit", "overlay-stations", "overlay-stops", "overlay-stops-badge", "search-points", "search-clusters"];
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
  // How long the pointer has to rest on one object before its popup
  // appears, and (symmetrically) how long it has to rest on a DIFFERENT
  // object before that popup is replaced — see the big comment above
  // `handleHoverFeature` for the reasoning. Not applied to the highlight or
  // the cursor, which stay instant: this is specifically about not
  // flashing a popup for every object the pointer merely passes over while
  // navigating the map.
  const HOVER_DWELL_MS = 5000;

  let hoverFrame = null;
  let pendingHoverPoint = null;
  let pendingHoverLngLat = null;
  let hoverKey = null; // whatever's directly under the pointer right now (drives highlight + cursor, instantly)
  let dwellTimer = null; // counts down to revealing/switching the popup for `hoverKey`
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
  let confirmedPopupKey = null; // the object whose popup is currently on screen, if any
  let hoverSeq = 0;
  let activeHighlight = null; // { kind: "building"|"road"|"place", sourceLayer, ids } | { kind: "stop" } | null
  const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "map-hover-popup-wrap", offset: 10 });

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
  // "set the end state one animation frame late" trick `revealPopup` uses
  // for the popup's own fade-in, just on a paint property instead of a DOM
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
  // `setHighlightForFeature` below. Kept as its own step (not folded into
  // clearing the popup) since the highlight is instant and the popup is
  // dwell-gated — they're cleared on different schedules, see
  // `clearHighlightOnly` vs `clearHover`.
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

  // Instant part of leaving an object: drop the highlight, reset the
  // cursor, and stop counting down toward showing/switching a popup for it.
  // Deliberately does NOT touch an already-CONFIRMED popup — see
  // `clearHover` below for why that's a separate, rarer action.
  function clearHighlightOnly() {
    clearTimeout(dwellTimer);
    dwellTimer = null;
    clearTimeout(hoverMissTimer);
    hoverMissTimer = null;
    clearHighlight();
    map.getCanvas().style.cursor = "";
    hoverKey = null;
  }

  // Full teardown, including an already-confirmed popup — used only when
  // the pointer actually leaves the map (not just a momentary gap between
  // two hoverable features while crossing dense building tiling) or when a
  // click supersedes it. A brief empty patch mid-pan is common enough
  // (small gaps between buildings, gutters between road segments) that
  // hiding a confirmed popup for it would recreate the exact flicker the
  // dwell delay exists to avoid — so passing through empty space alone
  // only calls `clearHighlightOnly`, not this.
  function clearHover() {
    clearHighlightOnly();
    if (confirmedPopupKey !== null) {
      confirmedPopupKey = null;
      hoverPopup.remove();
    }
  }

  // The popup renders offset from the actual hover point (`offset: 10`
  // above), so reaching its "Подробнее" button means moving the mouse OFF
  // the map canvas and onto the popup's own DOM element — which, because it
  // visually overlaps the canvas, makes the canvas fire its native
  // `mouseout` the instant the pointer crosses onto it, same as leaving the
  // map entirely. `pointInPopupRect` lets both the mousemove and mouseout
  // handlers recognize "the pointer is over the currently-open popup" and
  // leave everything alone in that case — the popup's own `mouseleave`
  // (bound below) is what actually closes it once the pointer leaves that
  // rect without having landed back on a hoverable map feature.
  function pointInPopupRect(clientX, clientY) {
    if (confirmedPopupKey === null) return false;
    const content = hoverPopup.getElement() && hoverPopup.getElement().querySelector(".maplibregl-popup-content");
    if (!content) return false;
    const r = content.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }
  // MapLibre's `setHTML`/`setDOMContent` replaces the content element
  // outright rather than just its innerHTML, so this has to run again
  // after every setHTML call, not just the first — guarded by a marker on
  // the element itself (not a module-level flag) so it's safe to call as
  // often as needed without double-binding the same node.
  function ensurePopupListeners() {
    const content = hoverPopup.getElement() && hoverPopup.getElement().querySelector(".maplibregl-popup-content");
    if (!content || content.__hoverBound) return;
    content.__hoverBound = true;
    content.addEventListener("mouseleave", clearHover);
  }

  function hoverPopupHtml(title, subtitle, action) {
    return `<div class="map-hover-popup">
      <strong>${esc(title)}</strong>
      <span>${esc(subtitle || "")}</span>
      ${action || ""}
    </div>`;
  }

  // Shows the popup with a fade-in (`.is-visible`, transitioned in CSS) —
  // the "плавно проявляется" part of the request. Only the initial reveal
  // fades; a later `setHTML` on the same popup instance (e.g. a building's
  // "Загрузка…" placeholder resolving) just swaps content in place.
  function revealPopup(lngLat, html) {
    hoverPopup.setLngLat(lngLat).setHTML(html).addTo(map);
    ensurePopupListeners();
    const el = hoverPopup.getElement();
    if (el) requestAnimationFrame(() => el.classList.add("is-visible"));
  }

  // Binds the click on whatever "action" HTML `hoverPopupHtml` was given —
  // done as a separate step (rather than inline in the HTML string) because
  // popup content is plain markup; MapLibre doesn't wire up handlers for
  // strings passed to setHTML.
  function bindHoverAction(kind, payload) {
    const el = hoverPopup.getElement();
    const btn = el && el.querySelector(".js-hover-more");
    if (!btn) return;
    btn.addEventListener("click", () => {
      confirmedPopupKey = null;
      hoverPopup.remove();
      if (kind === "object") openObjectDetails(payload);
      else if (kind === "street") resolveStreetClick(payload);
      else if (kind === "result") choose(payload.index);
    });
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
    loadStreetHouses({ type: "street", id: resolved.id, name: resolved.name, subtitle });
  }

  // The hover popup's "Подробнее" for a real object (address/company/stop —
  // whatever /api/hit-test resolved the point to): opens the exact same
  // detail view `choose()` renders for a search result, since that's the
  // closest thing to "the object's page" that exists today.
  async function openObjectDetails({ type, id, name }) {
    const item = { type, id, name, subtitle: TYPE_LABEL[type] || "" };
    if (type === "address") {
      const obj = await apiObject("address", id);
      renderSelected(item, obj);
      if (obj && obj.geometry) {
        setSelectedGeometry([{ type: "Feature", geometry: obj.geometry, properties: {} }]);
        const coords = flattenCoords(obj.geometry);
        if (coords.length) fitBoundsCoords(coords);
      }
      return;
    }
    renderSelected(item, null);
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

  // Builds and reveals the popup for whatever just finished its dwell —
  // this is the exact per-layer content logic the previous (instant)
  // version of this feature used, just moved behind the delay instead of
  // running on every hover change. `key` is re-checked before touching
  // anything async, in case the pointer moved on while a network request
  // (the building/stop hit-test) was in flight.
  function showPopupContent(key, layerId, props, lngLat) {
    // A search result marker already carries everything it needs (`results`
    // has the full item — name/type/id) from the search that put it on the
    // map, so unlike buildings/stops this needs no /api/hit-test round trip.
    // "Подробнее" reuses `choose()`, the exact same call the matching list
    // row's click makes — same card, same fitBounds/flyTo.
    if (layerId === "search-points") {
      const item = results[props.index];
      if (!item) return;
      const action = '<button class="map-hover-popup__link js-hover-more" type="button">Подробнее →</button>';
      revealPopup(lngLat, hoverPopupHtml(item.name, item.subtitle || TYPE_LABEL[item.type] || "", action));
      bindHoverAction("result", { index: props.index });
      return;
    }
    // A cluster isn't one named object — there's nothing a popup could
    // usefully say beyond the count the circle's own size already
    // communicates (see map-style.js) — so it only ever gets the instant
    // highlight/cursor, never a popup. Dwell timer still runs (harmlessly:
    // `confirmPopup` calls this, this returns without opening anything).
    if (layerId === "search-clusters") return;

    // "overlay-stations" (metro/rail) carries name/id/type directly in its
    // own GeoJSON (see pipeline/dedup_stations.py) — unlike buildings/
    // ordinary stops below, no /api/hit-test round trip needed, and
    // deliberately so: hit-test resolves by nearest-point-within-~20m
    // (coord.js's M2DEG2), but several deduped stations' own centroid sits
    // 40-90m from the nearest raw stop row it was merged from (long
    // platforms) — well past that radius, so hit-test would legitimately
    // come back empty for exactly the points this layer draws.
    if (layerId === "overlay-stations") {
      const action = '<button class="map-hover-popup__link js-hover-more" type="button">Подробнее →</button>';
      revealPopup(lngLat, hoverPopupHtml(props.name, TYPE_LABEL[props.type] || "", action));
      bindHoverAction("object", { type: props.type, id: props.id, name: props.name });
      return;
    }

    // Buildings and ordinary stops carry no usable name in the vector tile
    // itself — deliberately, see pipeline/sofia-schema.yml — so their
    // popup content comes from the same /api/hit-test lookup the "click on
    // empty map spot" handler above already uses, keyed by the hover point.
    if (layerId === "buildings" || layerId === "overlay-stops" || layerId === "overlay-stops-badge") {
      const seq = ++hoverSeq;
      revealPopup(lngLat, hoverPopupHtml("Загрузка…", ""));
      apiHitTest(lngLat.lat.toFixed(6), lngLat.lng.toFixed(6)).then((data) => {
        if (seq !== hoverSeq || key !== confirmedPopupKey) return; // popup moved on before this resolved
        const feature = data.features && data.features[0];
        if (!feature) {
          hoverPopup.setHTML(hoverPopupHtml("Объект не найден", ""));
          ensurePopupListeners(); // setHTML replaced the content element — rebind
          return;
        }
        const p = feature.properties;
        const action = '<button class="map-hover-popup__link js-hover-more" type="button">Подробнее →</button>';
        hoverPopup.setHTML(hoverPopupHtml(p.name, TYPE_LABEL[p.type] || "", action));
        ensurePopupListeners(); // setHTML replaced the content element — rebind
        bindHoverAction("object", { type: p.type, id: p.id, name: p.name });
      });
      return;
    }

    if (layerId === "place-labels-hit") {
      revealPopup(lngLat, hoverPopupHtml(props.name, "Квартал / жилой комплекс", '<span class="map-hover-popup__soon">Страница появится позже</span>'));
      return;
    }

    // Everything else reaching this point is "roads-hit" (the invisible
    // wide hit proxy over the transportation source-layer — see
    // pipeline/sofia-schema.yml for its highway/name properties), so this
    // one branch covers every street regardless of class. Unnamed ways
    // (footways, service lanes — the untagged lowest tier) fall back to a
    // generic kind instead of a confusing "street with no name", and skip
    // the search action since there's no name to search for.
    const kind = HIGHWAY_KIND[props.highway] || "Дорога";
    const title = props.name || kind;
    const subtitle = props.name ? kind : "";
    const action = props.name ? '<button class="map-hover-popup__link js-hover-more" type="button">Найти на карте →</button>' : "";
    revealPopup(lngLat, hoverPopupHtml(title, subtitle, action));
    if (props.name) bindHoverAction("street", { name: props.name, lat: lngLat.lat, lng: lngLat.lng });
  }

  // Fires once `key` has been continuously hovered for HOVER_DWELL_MS.
  function confirmPopup(key, layerId, props, lngLat) {
    if (hoverKey !== key) return; // moved on already — this timer should have been cancelled, but double-check
    if (confirmedPopupKey !== null) hoverPopup.remove(); // instant swap, no fade-out — only the reveal fades
    confirmedPopupKey = key;
    showPopupContent(key, layerId, props, lngLat);
  }

  // Highlight + cursor update instantly on every hover change (immediate
  // feedback that something is interactive); the popup does not — it only
  // appears after the pointer has rested on the SAME object for
  // HOVER_DWELL_MS ("долгого удержания курсора… на объекте"), and an
  // already-visible popup only gets replaced once the pointer has rested
  // on a DIFFERENT object for that same duration ("скрывается после
  // аналогичного удержания на другом объекте") — or immediately on a click
  // (see the click handler below). Without this, merely passing the mouse
  // over the map while heading somewhere else would flash a popup for
  // every building/street/quarter along the way.
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

    clearTimeout(dwellTimer);
    clearHighlight();
    hoverKey = key;
    setHighlightForFeature(layerId, f, props);

    if (key === confirmedPopupKey) return; // its popup is already on screen
    dwellTimer = setTimeout(() => confirmPopup(key, layerId, props, lngLat), HOVER_DWELL_MS);
  }

  function processHover(point, lngLat, clientX, clientY) {
    if (pointInPopupRect(clientX, clientY)) return; // pointer is over the open popup itself — leave it alone
    const features = map.queryRenderedFeatures(point, { layers: HOVER_LAYERS });
    if (!features.length) {
      // Passing through empty space (a gap between buildings, a gutter
      // between road segments) drops the highlight — but not on the very
      // first miss: see HOVER_MISS_GRACE_MS above for why a single missed
      // frame gets a short grace period instead of clearing instantly, and
      // `clearHighlightOnly`'s own comment for why this still leaves an
      // already-confirmed popup alone either way.
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

  // `queryRenderedFeatures` isn't free, so it doesn't run on every
  // `mousemove` pixel — at most one call is queued per animation frame,
  // using the latest pointer position by the time that frame actually
  // runs. That caps the extra per-frame cost to something bounded no
  // matter how fast the mouse moves, which matters most on exactly the
  // "lite"/software-rendered visitors this app already goes out of its way
  // for elsewhere (map-style.js's detectRenderQuality).
  let pendingHoverClientX = null;
  let pendingHoverClientY = null;
  map.on("mousemove", (e) => {
    pendingHoverPoint = e.point;
    pendingHoverLngLat = e.lngLat;
    pendingHoverClientX = e.originalEvent.clientX;
    pendingHoverClientY = e.originalEvent.clientY;
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = null;
      processHover(pendingHoverPoint, pendingHoverLngLat, pendingHoverClientX, pendingHoverClientY);
    });
  });
  // Skip the clear if the pointer left the canvas heading onto the open
  // popup itself (see pointInPopupRect above) — otherwise reaching for its
  // button would tear the popup down before the click ever lands. Unlike a
  // momentary gap mid-map, actually leaving the canvas IS a full teardown
  // (clearHover, not clearHighlightOnly) — there's no "another object" to
  // wait a dwell period for.
  map.on("mouseout", (e) => {
    if (pointInPopupRect(e.originalEvent.clientX, e.originalEvent.clientY)) return;
    clearHover();
  });

  // ---- click on a hovered object / empty map spot -------------------------------------------------
  // Reuses whatever's already hovered rather than re-deriving it from
  // scratch: since the hover popup sits offset from the cursor (so it
  // doesn't cover what you're pointing at), reaching its small
  // "Подробнее"/"Найти на карте" button with the mouse means crossing
  // whatever's between the two — dense building tiling can make that a
  // real obstacle course. A plain click on the highlighted object itself,
  // with the cursor exactly where it already is, does the same action —
  // no extra mouse travel needed. The popup's own button still works when
  // it's reachable; this is the always-reachable fallback. A click also
  // dismisses any confirmed popup outright ("скрывается… по клику"),
  // whatever it ends up doing next.
  map.on("click", async (e) => {
    clearTimeout(dwellTimer);
    if (confirmedPopupKey !== null) {
      confirmedPopupKey = null;
      hoverPopup.remove();
    }
    const hoverHit = pickHoverFeature(map.queryRenderedFeatures(e.point, { layers: HOVER_LAYERS }), e.point);
    if (hoverHit) {
      const layerId = hoverHit.layer.id;
      const props = hoverHit.properties || {};
      // Same reasoning as showPopupContent's "overlay-stations" branch
      // above: this layer's own GeoJSON already carries name/id/type, so
      // it skips /api/hit-test (whose ~20m match radius several deduped
      // stations' centroids fall outside of) entirely.
      if (layerId === "overlay-stations") {
        openObjectDetails({ type: props.type, id: props.id, name: props.name });
        return;
      }
      if (layerId === "buildings" || layerId === "overlay-stops" || layerId === "overlay-stops-badge") {
        const data = await apiHitTest(e.lngLat.lat.toFixed(6), e.lngLat.lng.toFixed(6));
        const feature = data.features && data.features[0];
        if (feature) openObjectDetails({ type: feature.properties.type, id: feature.properties.id, name: feature.properties.name });
        return;
      }
      if (layerId === "place-labels-hit") {
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(`<div class="map-click-popup"><h3>${esc(props.name)}</h3><p>Страница появится позже</p></div>`)
          .addTo(map);
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
    const { lat, lng } = e.lngLat;
    const data = await apiHitTest(lat.toFixed(6), lng.toFixed(6));
    const feature = data.features && data.features[0];
    const html = feature
      ? `<div class="map-click-popup"><h3>${esc(feature.properties.name)}</h3><p>${esc(TYPE_LABEL[feature.properties.type] || feature.properties.type || "")}</p></div>`
      : `<div class="map-click-popup"><h3>Здесь объект не найден</h3><p>${lat.toFixed(5)}, ${lng.toFixed(5)}</p></div>`;
    new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(html).addTo(map);
  });

  // ---- initial state from URL (?q=&type=) -------------------------------------------------
  map.on("load", () => {
    const params = new URLSearchParams(location.search);
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
