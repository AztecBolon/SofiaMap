// Renders the /metro/ page body (CSS + SVG + interaction JS) from the data
// metroScheme.js assembles. Split into its own file purely so metroScheme.js
// stays about data, not markup — pages.js's /metro/ route just calls
// renderMetroPage() and drops the result into the shared page() shell like
// every other route already does.
//
// Everything here is progressive enhancement over plain, crawlable HTML:
// every station circle is a real <a href="/stops/subway/...html"> (or plain
// unlinked text for the one station with no name in sofia.db — see
// metroScheme.js), so a JS-less visitor or a search engine still reaches
// every station page directly from the diagram. JS on top adds click-to-pick
// a route, autocomplete, highlighting and the pulsing "selected station"
// markers — none of it is required to use the diagram for its main job
// (finding a station and reading its name/line).
const { esc } = require("./htmlPage");

function svgMarkup(data) {
  const { W, H, stations, lines, lineMeta, edges, transferPairs, plannedLinks } = data;

  // One <path> PER EDGE (station-to-station segment), not one path for the
  // whole line — this is what lets route highlighting light up only the
  // stretch actually travelled instead of the entire line end-to-end (see
  // metroSchemeRender.js's CLIENT_JS highlightPath, which matches segments
  // by their data-a/data-b endpoint ids).
  const linePaths = Object.entries(lines)
    .map(([ref, ids]) => {
      // M1 and M4 share 13 stations end-to-end (see metroScheme.js) — drawn
      // as two parallel offset lines through the same points, same technique
      // used for any shared-trunk stretch on a real transit diagram, rather
      // than one line hiding the other.
      const off = ref === "M1" ? -3 : ref === "M4" ? 3 : 0;
      return ids
        .slice(0, -1)
        .map((id, i) => {
          const nextId = ids[i + 1];
          const a = stations[id], b = stations[nextId];
          const d = `M${(a.x + off).toFixed(1)},${(a.y - off).toFixed(1)} L${(b.x + off).toFixed(1)},${(b.y - off).toFixed(1)}`;
          return `<path class="ln ln-${ref}" data-line="${ref}" data-a="${id}" data-b="${nextId}" d="${d}" stroke="${lineMeta[ref].color}" />`;
        })
        .join("\n");
    })
    .join("\n");

  const transferLines = transferPairs
    .map((tp) => {
      const a = stations[tp.a], b = stations[tp.b];
      // data-a/data-b so a route that walks this transfer also lights up
      // the connector itself, not just the two station dots either side of it.
      return `<line class="transfer-connector" data-a="${tp.a}" data-b="${tp.b}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
    })
    .join("\n");

  // Purely decorative: a segment currently under construction (verified via
  // web search — see metroSchemeData.json's comment for the source/date).
  // No data-a/data-b, no routable class — it must never be mistaken by
  // highlightPath() for a real, walkable transfer, and it isn't clickable.
  const plannedMarkup = (plannedLinks || [])
    .map((pl) => {
      const a = stations[pl.a], b = stations[pl.b];
      if (!a || !b) return "";
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      return `<line class="planned-link" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />` +
        `<text class="planned-label" x="${mx.toFixed(1)}" y="${(my - 6).toFixed(1)}" text-anchor="middle">${esc(pl.label)} — строится</text>`;
    })
    .join("\n");

  const stationNodes = Object.values(stations)
    .map((s) => {
      const cls = ["station", `s${s.id}`].join(" ");
      // Invisible larger hit-target under the visible dot: the drawn circle
      // is only r=5 (10px, in a 1500-wide viewBox stretched to fit a much
      // narrower container) — too small a target for a real mouse/trackpad
      // click, which is why clicks on the live page were unreliable. This
      // circle is transparent (not "none") so it still receives pointer
      // events, and sits inside the same .station-link so the click handler
      // needs no changes.
      const hit = `<circle class="station-hit" cx="${s.x}" cy="${s.y}" r="12" fill="transparent" data-id="${s.id}" />`;
      const circle = `<circle class="${cls}" id="s${s.id}" cx="${s.x}" cy="${s.y}" r="5" data-id="${s.id}" />`;
      const label = `<text class="stlabel s${s.id}" x="${(s.x + s.labelDx).toFixed(1)}" y="${(s.y + s.labelDy).toFixed(1)}" text-anchor="${s.labelAnchor}">${esc(s.name)}${s.unverifiedName ? " *" : ""}</text>`;
      const ring = `<circle class="marker-ring s${s.id}" cx="${s.x}" cy="${s.y}" r="5" />`;
      if (s.href) {
        return `<a href="${esc(s.href)}" class="station-link" data-id="${s.id}">${hit}${circle}${label}</a>${ring}`;
      }
      return `<g class="station-link" data-id="${s.id}">${hit}${circle}${label}</g>${ring}`;
    })
    .join("\n");

  return `
  <svg id="metro-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" role="img" aria-label="Схема линий метро Софии">
    <g class="lines">${linePaths}</g>
    <g class="transfers">${transferLines}</g>
    <g class="planned">${plannedMarkup}</g>
    <g class="stations">${stationNodes}</g>
  </svg>`;
}

function legendMarkup(lineMeta) {
  return `<div class="metro-legend" id="metro-legend">${Object.entries(lineMeta)
    .map(([ref, m]) => `<button type="button" class="legend-item" data-line="${ref}" style="--line-color:${m.color}"><span class="legend-swatch"></span>${esc(ref)}</button>`)
    .join("")}</div>`;
}

function searchFormMarkup(stations) {
  const options = Object.values(stations)
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b, "bg"))
    .map((n) => `<option value="${esc(n)}"></option>`)
    .join("");
  return `
  <form class="metro-route-form" id="metro-route-form" autocomplete="off">
    <div class="metro-route-field">
      <label for="metro-from">Откъде</label>
      <input list="metro-stations" id="metro-from" name="from" placeholder="Начальная станция" />
    </div>
    <div class="metro-route-field">
      <label for="metro-to">Накъде</label>
      <input list="metro-stations" id="metro-to" name="to" placeholder="Конечная станция" />
    </div>
    <datalist id="metro-stations">${options}</datalist>
    <button type="button" id="metro-route-clear" class="metro-clear-btn">Начать заново</button>
  </form>`;
}

const STYLE = `
<style>
  /* 2026-09-09 (decision E20 — "только визуальный стиль"): the handful of
     rules below that reference --metro-accent are the ONLY change in this
     block — everything else (structure, SVG, the JS above/below) is
     untouched, and the official M1–M4 line colors (lineMeta) are never
     touched here either. --metro-accent mirrors the site's own #3B3FA6/
     #9FA8FF accent (htmlPage.js) so the metro page's non-line UI (form
     focus, buttons, hover) matches the rest of the site instead of a
     neutral grey. */
  :root { --metro-circle:#fff; --metro-text:#111; --metro-dim-op:0.16; --metro-panel-bg:color-mix(in srgb, currentColor 5%, transparent); --metro-border:color-mix(in srgb, currentColor 22%, transparent); --metro-accent:#3B3FA6; }
  @media (prefers-color-scheme: dark) { :root { --metro-circle:#1c1c1c; --metro-text:#eee; --metro-accent:#9FA8FF; } }
  .metro-toolbar { display:flex; flex-wrap:wrap; gap:16px; align-items:flex-start; margin:0.6em 0 1em; }
  .metro-legend { display:flex; gap:8px; flex-wrap:wrap; }
  .legend-item { display:flex; align-items:center; gap:6px; border:1px solid var(--metro-border); background:var(--metro-panel-bg); border-radius:16px; padding:4px 10px 4px 6px; font:inherit; font-size:0.85em; font-weight:600; cursor:pointer; color:inherit; transition:background 0.15s,transform 0.15s; }
  .legend-item:hover { transform:translateY(-1px); border-color:var(--metro-accent); }
  .legend-item.active { background:var(--line-color); color:#fff; border-color:var(--line-color); }
  .legend-item.route-active { animation: legend-pulse 1.4s ease-in-out infinite; }
  .legend-swatch { width:14px; height:14px; border-radius:50%; background:var(--line-color); display:inline-block; }
  @keyframes legend-pulse { 0%,100% { box-shadow:0 0 0 0 color-mix(in srgb, var(--line-color) 55%, transparent);} 50% { box-shadow:0 0 0 6px color-mix(in srgb, var(--line-color) 0%, transparent);} }
  .metro-route-form { display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; }
  .metro-route-field { display:flex; flex-direction:column; gap:2px; font-size:0.85em; }
  .metro-route-field input { padding:6px 8px; border-radius:6px; border:1px solid var(--metro-border); background:var(--metro-panel-bg); color:inherit; font:inherit; min-width:200px; }
  .metro-route-field input:focus { outline:none; border-color:var(--metro-accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--metro-accent) 20%, transparent); }
  .metro-clear-btn { padding:6px 12px; border-radius:6px; border:1px solid var(--metro-border); background:transparent; color:inherit; font:inherit; cursor:pointer; }
  .metro-clear-btn:hover { border-color:var(--metro-accent); color:var(--metro-accent); }
  .metro-scheme-wrap { position:relative; overflow:auto; border:1px solid var(--metro-border); border-radius:10px; margin:0 0 1.2em; background:var(--metro-panel-bg); }
  #metro-svg { display:block; width:1500px; max-width:none; height:auto; }
  @media (min-width: 1180px) { #metro-svg { width:100%; } }
  .ln { fill:none; stroke-width:5; stroke-linecap:round; stroke-linejoin:round; opacity:0.92; }
  .transfer-connector { stroke:#999; stroke-width:3; stroke-dasharray:2,4; opacity:0.85; }
  /* Under construction, not usable yet — visually distinct (thinner, lighter,
     wider gaps) from .transfer-connector so it doesn't read as "walk here now". */
  .planned-link { stroke:#aaa; stroke-width:1.5; stroke-dasharray:1,6; opacity:0.55; pointer-events:none; }
  .planned-label { font-size:9px; fill:#999; font-style:italic; pointer-events:none; user-select:none; }
  #metro-svg.matte .planned-link, #metro-svg.matte .planned-label { opacity:0.12; }
  .station { fill:var(--metro-circle); stroke:#333; stroke-width:2; cursor:pointer; }
  @media (prefers-color-scheme: dark) { .station { stroke:#ccc; } }
  .station:hover { stroke:#000; }
  .stlabel { font-size:11px; fill:var(--metro-text); pointer-events:none; user-select:none; }
  .station-link { cursor:pointer; }
  .marker-ring { fill:none; stroke-width:0; opacity:0; pointer-events:none; }
  .marker-ring.marker-active { animation: marker-pulse 1.3s ease-out infinite; }
  @keyframes marker-pulse { 0% { r:6; stroke-width:4; opacity:0.9; } 100% { r:15; stroke-width:0; opacity:0; } }
  #metro-svg.matte .ln, #metro-svg.matte .station, #metro-svg.matte .stlabel, #metro-svg.matte .transfer-connector { opacity:var(--metro-dim-op); transition:opacity 0.2s; }
  #metro-svg.matte .apart { opacity:1; }
  #metro-svg.matte .station.apart { stroke:#000; }
  .station.s-active { stroke:#000; stroke-width:3; }
  .metro-popup { position:absolute; z-index:5; background:var(--metro-circle); border:1px solid var(--metro-border); border-radius:8px; padding:10px 12px; font-size:0.88em; box-shadow:0 6px 18px rgba(0,0,0,0.18); max-width:240px; }
  .metro-popup h4 { margin:0 0 4px; font-size:1em; }
  .metro-popup .lines-row { display:flex; gap:4px; margin:4px 0 8px; }
  .metro-popup .lines-row span { width:10px; height:10px; border-radius:50%; display:inline-block; }
  .metro-popup .popup-actions { display:flex; gap:6px; margin-top:6px; }
  .metro-popup button { font:inherit; font-size:0.85em; padding:3px 8px; border-radius:5px; border:1px solid var(--metro-border); background:transparent; color:inherit; cursor:pointer; }
  .metro-popup button:hover { border-color:var(--metro-accent); color:var(--metro-accent); }
  .metro-popup a { font-size:0.85em; }
  .metro-popup .popup-close { position:absolute; top:4px; right:6px; border:none; background:none; cursor:pointer; font-size:1em; color:inherit; opacity:0.6; }
  .metro-result { border:1px solid var(--metro-border); border-radius:10px; padding:14px 16px; margin:0 0 1.4em; background:var(--metro-panel-bg); }
  .metro-result h3 { margin:0 0 4px; font-size:1.1em; }
  .metro-result .time-est-note { opacity:0.65; font-size:0.82em; margin:0 0 10px; }
  .metro-result ol.route-steps { list-style:none; margin:8px 0 0; padding:0; }
  .metro-result ol.route-steps li { display:flex; align-items:center; gap:8px; padding:3px 0; }
  .metro-result .dot { width:10px; height:10px; border-radius:50%; flex:none; }
  .metro-result .hub-badge { font-size:0.78em; opacity:0.7; }
  .metro-variant-switch { margin:8px 0; }
  .metro-variant-switch button { font:inherit; font-size:0.85em; padding:3px 10px; border-radius:14px; border:1px solid var(--metro-border); background:transparent; color:inherit; cursor:pointer; margin-right:6px; }
  .metro-variant-switch button.active { background:var(--metro-accent); border-color:var(--metro-accent); color:#fff; }
  .metro-note { font-size:0.85em; opacity:0.7; margin:0.6em 0 1.4em; }
  [hidden] { display:none !important; }
</style>`;

function renderMetroPage(data) {
  const { stations, lineMeta } = data;
  const dataJson = JSON.stringify({
    stations: Object.fromEntries(Object.entries(stations).map(([id, s]) => [id, { name: s.name, href: s.href, x: s.x, y: s.y }])),
    lines: data.lines,
    lineMeta: data.lineMeta,
    lineMembership: data.lineMembership,
    edges: data.edges,
    graph: data.graphForClient,
    transferPairs: data.transferPairs,
  }).replace(/</g, "\\u003c"); // safe to embed inside <script>

  return `
    <p class="meta">
      Схематическая диаграмма линий метро (в духе классических транспортных схем — не географическая карта; для точной географии см. <a href="/map/">интерактивную карту</a>). Станции расположены условно, порядок и пересадки — реальные, из тех же данных, что и на страницах линий и станций.
    </p>
    ${STYLE}
    <div class="metro-toolbar">
      ${legendMarkup(lineMeta)}
      ${searchFormMarkup(stations)}
    </div>
    <div id="metro-result" class="metro-result" hidden></div>
    <div class="metro-scheme-wrap">
      ${svgMarkup(data)}
      <div id="metro-popup-layer"></div>
    </div>
    <p class="metro-note">* — название станции отсутствует в исходных данных (OSM); восстановлено вручную по внешним источникам расписания метро, поэтому отдельной страницы станции у неё нет.</p>
    ${(data.plannedLinks || [])
      .map((pl) => `<p class="metro-note">⋯ — ${esc(pl.label)}: ${esc(pl.note)}. Не учитывается при расчёте маршрута.</p>`)
      .join("\n")}
    <p class="meta">Все станции списком: <a href="/stops/subway/">Станции метро</a>. Линии: ${Object.keys(lineMeta).map((ref) => `<a href="/routes/metro/">${esc(ref)}</a>`).join(", ")}.</p>
    <script>window.__METRO__ = ${dataJson};</script>
    <script>${CLIENT_JS}</script>
  `;
}

// Vanilla JS, no build step, matching the rest of the site — this is the
// diagram's entire interactivity: click-or-search station selection,
// client-side Dijkstra (the graph is tiny — 50 nodes — so no server round
// trip is needed at all, unlike the moscowmap reference this was modelled
// on, which needs a server because its graph has hundreds of stations),
// route highlighting, the pulsing endpoint markers, legend highlighting,
// and #m<id1>m<id2> deep-linking.
const CLIENT_JS = `
(function(){
  var M = window.__METRO__;
  var svg = document.getElementById('metro-svg');
  var fromInput = document.getElementById('metro-from');
  var toInput = document.getElementById('metro-to');
  var resultBox = document.getElementById('metro-result');
  var popupLayer = document.getElementById('metro-popup-layer');
  var legend = document.getElementById('metro-legend');
  var clearBtn = document.getElementById('metro-route-clear');

  var nameToId = {};
  Object.keys(M.stations).forEach(function(id){ nameToId[M.stations[id].name] = id; });

  var state = { from: null, to: null, variants: null, activeVariant: 0, legendLine: null };

  // ---------- Dijkstra (tiny graph, plain array-scan "priority queue" is fine) ----------
  var TRANSFER_PENALTY = 3; // minutes; biases away from unnecessary transfers — see metroScheme.js
  function shortestPath(fromId, toId, minimizeTransfersFirst) {
    var dist = {}, prev = {}, hubs = {}, visited = {};
    Object.keys(M.graph).forEach(function(id){ dist[id] = Infinity; hubs[id] = Infinity; });
    dist[fromId] = 0; hubs[fromId] = 0;
    while (true) {
      var u = null, best = Infinity;
      Object.keys(M.graph).forEach(function(id){
        if (visited[id]) return;
        var key = minimizeTransfersFirst ? (hubs[id]*1000 + dist[id]) : dist[id];
        if (key < best) { best = key; u = id; }
      });
      if (u === null || dist[u] === Infinity) break;
      if (u === String(toId)) break;
      visited[u] = true;
      (M.graph[u]||[]).forEach(function(edge){
        var v = String(edge.to);
        if (visited[v]) return;
        var cost = edge.minutes + (edge.transfer ? TRANSFER_PENALTY : 0);
        var nd = dist[u] + cost;
        var nh = hubs[u] + (edge.transfer ? 1 : 0);
        var better = minimizeTransfersFirst ? (nh < hubs[v] || (nh === hubs[v] && nd < dist[v])) : (nd < dist[v]);
        if (better) { dist[v] = nd; hubs[v] = nh; prev[v] = { from: u, edge: edge }; }
      });
    }
    if (dist[String(toId)] === Infinity) return null;
    var path = [], cur = String(toId), totalMinutes = 0, hubCount = 0;
    while (cur !== undefined) {
      path.unshift(cur);
      var p = prev[cur];
      if (!p) break;
      totalMinutes += p.edge.minutes;
      if (p.edge.transfer) hubCount++;
      cur = p.from;
    }
    return { path: path, minutes: totalMinutes, hubs: hubCount };
  }

  function buildVariants(fromId, toId) {
    var a = shortestPath(fromId, toId, false);
    var b = shortestPath(fromId, toId, true);
    if (!a) return [];
    var variants = [a];
    if (b && (b.path.join(',') !== a.path.join(','))) variants.push(b);
    variants.sort(function(x,y){ return x.minutes - y.minutes; });
    return variants;
  }

  // ---------- SVG highlighting ----------
  function clearHighlight() {
    svg.classList.remove('matte');
    svg.querySelectorAll('.apart').forEach(function(el){ el.classList.remove('apart'); });
  }
  function highlightPath(path) {
    clearHighlight();
    var exempt = [];
    for (var i=0;i<path.length;i++) {
      exempt.push('.s'+path[i]);
      if (i>0) exempt.push('.s'+path[i-1]+'.s'+path[i], '.s'+path[i]+'.s'+path[i-1]);
    }
    svg.querySelectorAll('.station, .stlabel').forEach(function(el){
      path.forEach(function(id){ if (el.classList.contains('s'+id)) el.classList.add('apart'); });
    });
    svg.classList.add('matte');
    // Undim only the line segment(s) actually travelled — each .ln is now
    // one station-to-station edge (data-a/data-b), not the whole line, so
    // matching by consecutive path pairs lights up just the route, not the
    // full line end-to-end.
    var linesUsed = {};
    var segments = svg.querySelectorAll('.ln, .transfer-connector');
    for (var i=0;i<path.length-1;i++) {
      var a = path[i], b = path[i+1];
      segments.forEach(function(el){
        var ea = el.getAttribute('data-a'), eb = el.getAttribute('data-b');
        if ((ea===a && eb===b) || (ea===b && eb===a)) {
          el.classList.add('apart');
          var ref = el.getAttribute('data-line');
          if (ref) linesUsed[ref] = true;
        }
      });
    }
    return Object.keys(linesUsed);
  }

  // ---------- markers ----------
  function setMarker(id, on) {
    var ring = svg.querySelector('.marker-ring.s'+id);
    if (ring) ring.classList.toggle('marker-active', !!on);
  }
  function clearMarkers(){ svg.querySelectorAll('.marker-ring.marker-active').forEach(function(r){ r.classList.remove('marker-active'); }); }

  // ---------- legend ----------
  function paintLegendRouteState(refs) {
    legend.querySelectorAll('.legend-item').forEach(function(btn){
      btn.classList.toggle('route-active', refs && refs.indexOf(btn.dataset.line) !== -1);
    });
  }
  legend.addEventListener('click', function(e){
    var btn = e.target.closest('.legend-item');
    if (!btn) return;
    var ref = btn.dataset.line;
    if (state.legendLine === ref) {
      state.legendLine = null;
      legend.querySelectorAll('.legend-item').forEach(function(b){ b.classList.remove('active'); });
      if (!state.variants) clearHighlight();
      return;
    }
    state.legendLine = ref;
    legend.querySelectorAll('.legend-item').forEach(function(b){ b.classList.toggle('active', b===btn); });
    clearHighlight();
    svg.querySelectorAll('.ln').forEach(function(el){ if (el.getAttribute('data-line')===ref) el.classList.add('apart'); });
    (M.lines[ref]||[]).forEach(function(id){
      svg.querySelectorAll('.s'+id).forEach(function(el){ el.classList.add('apart'); });
    });
    svg.classList.add('matte');
  });

  // ---------- popup ----------
  function closePopup(){ popupLayer.innerHTML=''; }
  function openPopup(id, anchorEl){
    closePopup();
    var s = M.stations[id];
    var refs = M.lineMembership[id] || [];
    var wrapRect = anchorEl.closest('.metro-scheme-wrap').getBoundingClientRect();
    var svgPoint = svg.createSVGPoint();
    svgPoint.x = s.x; svgPoint.y = s.y;
    var ctm = svg.getScreenCTM();
    var screenPt = svgPoint.matrixTransform(ctm);
    var div = document.createElement('div');
    div.className = 'metro-popup';
    div.style.left = (screenPt.x - wrapRect.left + anchorEl.closest('.metro-scheme-wrap').scrollLeft + 10) + 'px';
    div.style.top = (screenPt.y - wrapRect.top + 10) + 'px';
    var linesHtml = refs.map(function(r){ return '<span style="background:'+M.lineMeta[r].color+'" title="'+r+'"></span>'; }).join('');
    var linkHtml = s.href ? '<a href="'+s.href+'">Открыть страницу станции →</a>' : '<em>нет отдельной страницы (см. примечание под схемой)</em>';
    div.innerHTML = '<button class="popup-close" type="button" aria-label="Закрыть">×</button>' +
      '<h4>'+s.name+'</h4><div class="lines-row">'+linesHtml+'</div>' +
      '<div>'+linkHtml+'</div>' +
      '<div class="popup-actions"><button type="button" data-act="from">Отсюда</button><button type="button" data-act="to">Сюда</button></div>';
    popupLayer.appendChild(div);
    div.querySelector('.popup-close').addEventListener('click', closePopup);
    div.querySelectorAll('[data-act]').forEach(function(btn){
      btn.addEventListener('click', function(){ selectStation(id, btn.dataset.act); closePopup(); });
    });
  }

  // ---------- selection / calc ----------
  function selectStation(id, direct) {
    if (!direct) {
      if (!state.from) direct = 'from';
      else if (!state.to) direct = 'to';
      else { state.from = null; state.to = null; clearMarkers(); clearHighlight(); paintLegendRouteState(null); resultBox.hidden = true; direct = 'from'; }
    }
    if (direct === 'from') {
      if (state.to === String(id)) state.to = null;
      state.from = String(id);
      fromInput.value = M.stations[id].name;
      setMarker(id, true);
    } else {
      if (state.from === String(id)) state.from = null;
      state.to = String(id);
      toInput.value = M.stations[id].name;
      setMarker(id, true);
    }
    if (state.from && state.to) calcRoute(); else { clearHighlight(); paintLegendRouteState(null); resultBox.hidden = true; }
  }

  function renderResult() {
    var v = state.variants[state.activeVariant];
    var refs = highlightPath(v.path);
    paintLegendRouteState(refs);
    var switchHtml = state.variants.length > 1
      ? '<div class="metro-variant-switch">' + state.variants.map(function(vv,i){
          return '<button type="button" data-v="'+i+'" class="'+(i===state.activeVariant?'active':'')+'">Вариант '+(i+1)+' — '+vv.minutes+' мин</button>';
        }).join('') + '</div>'
      : '';
    var stepsHtml = v.path.map(function(id, i){
      var s = M.stations[id];
      var isHub = i>0 && prevIsTransfer(v.path[i-1], id);
      var refsHere = M.lineMembership[id] || [];
      var dot = '<span class="dot" style="background:'+ (M.lineMeta[refsHere[0]]||{color:'#888'}).color +'"></span>';
      var label = s.href ? '<a href="'+s.href+'">'+s.name+'</a>' : s.name;
      return '<li>'+dot+label+(isHub?'<span class="hub-badge"> — пересадка</span>':'')+'</li>';
    }).join('');
    resultBox.innerHTML =
      '<h3>'+M.stations[v.path[0]].name+' → '+M.stations[v.path[v.path.length-1]].name+'</h3>' +
      '<p>≈ '+v.minutes+' мин, '+v.hubs+' пересад'+(v.hubs===1?'ка':(v.hubs>=2&&v.hubs<=4?'ки':'ок'))+'</p>' +
      '<p class="time-est-note">Время — оценка по расстоянию между станциями (~40 км/ч), а не официальное расписание; в sofia.db данных о времени перегонов нет.</p>' +
      switchHtml +
      '<ol class="route-steps">'+stepsHtml+'</ol>';
    resultBox.hidden = false;
    resultBox.querySelectorAll('.metro-variant-switch [data-v]').forEach(function(btn){
      btn.addEventListener('click', function(){ state.activeVariant = Number(btn.dataset.v); renderResult(); });
    });
  }
  function prevIsTransfer(prevId, id){
    return M.edges.some(function(e){
      return e.transfer && ((String(e.a)===String(prevId)&&String(e.b)===String(id)) || (String(e.b)===String(prevId)&&String(e.a)===String(id)));
    });
  }

  function calcRoute(){
    if (!state.from || !state.to || state.from === state.to) return;
    var variants = buildVariants(state.from, state.to);
    if (!variants.length) return;
    state.variants = variants; state.activeVariant = 0;
    renderResult();
    location.hash = 'm'+state.from+'m'+state.to;
  }

  function reset(){
    state = { from:null, to:null, variants:null, activeVariant:0, legendLine:null };
    fromInput.value=''; toInput.value='';
    clearHighlight(); clearMarkers(); closePopup();
    paintLegendRouteState(null);
    legend.querySelectorAll('.legend-item').forEach(function(b){ b.classList.remove('active'); });
    resultBox.hidden = true;
    if (location.hash) history.replaceState(null,null,location.pathname);
  }
  clearBtn.addEventListener('click', reset);

  // ---------- inputs (native <datalist> autocomplete) ----------
  function handleInputChange(input, direct){
    var id = nameToId[input.value];
    if (id) selectStation(id, direct);
  }
  fromInput.addEventListener('change', function(){ handleInputChange(fromInput,'from'); });
  toInput.addEventListener('change', function(){ handleInputChange(toInput,'to'); });

  // ---------- clicking stations on the scheme ----------
  svg.addEventListener('click', function(e){
    var link = e.target.closest('.station-link');
    if (!link) return;
    e.preventDefault();
    var id = link.dataset.id;
    openPopup(id, link);
  });
  document.addEventListener('click', function(e){
    if (!e.target.closest('.metro-popup') && !e.target.closest('.station-link')) closePopup();
  });

  // ---------- deep link on load: #m<id1>m<id2> ----------
  function applyHash(){
    var m = /^#m(\\d+)m(\\d+)$/.exec(location.hash);
    if (!m || !M.stations[m[1]] || !M.stations[m[2]]) return;
    state.from = m[1]; state.to = m[2];
    fromInput.value = M.stations[m[1]].name;
    toInput.value = M.stations[m[2]].name;
    setMarker(m[1], true); setMarker(m[2], true);
    calcRoute();
  }
  applyHash();
  window.addEventListener('hashchange', applyHash);
})();
`;

module.exports = { renderMetroPage };
