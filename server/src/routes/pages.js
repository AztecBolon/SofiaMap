// Static, crawlable HTML directory section — /directory/, /streets/,
// /rubrics/, /routes/, /stops/, /districts/, /settlements/.
//
// This is deliberately NOT part of the MapLibre SPA (web/index.html +
// web/js/map-search.js) — those are untouched. Every route here renders a
// full, independent HTML document server-side (see lib/htmlPage.js for
// why hand-built strings rather than a template engine) so each page has
// its own indexable URL, title and <h1>, per the task's scope: structure,
// breadcrumbs and navigation only — no map rendering, org cards, or any
// of the reference site's richer content on this pass.
const express = require("express");
const streets = require("../lib/streetsDirectory");
const rubrics = require("../lib/rubricsDirectory");
const routesDir = require("../lib/routesDirectory");
const stops = require("../lib/stopsDirectory");
const areas = require("../lib/areasDirectory");
const raions = require("../lib/raionsDirectory");
const districtAdmin = require("../lib/districtAdminContacts");
const police = require("../lib/policeContacts");
const orgMatch = require("../lib/orgMatch");
const transportNearby = require("../lib/transportNearby");
const { buildingKindLabel } = require("../lib/buildingKind");
const culturalHeritage = require("../lib/culturalHeritage");
const schoolsDir = require("../lib/schoolsDirectory");
const { withDesignation } = require("../lib/streetDesignation");
const { getPostcodeNote, SOURCES } = require("../lib/postcodeProvenance");
const { sourceLabel: houseSourceLabel } = require("../lib/housenumberProvenance");
const postcodes = require("../lib/postcodesDirectory");
const { page, itemList, letterNav, mapLink, esc, blockWrap, miniMapWidget, mapAssetsHead, mapAssetsScripts } = require("../lib/htmlPage");
const metroScheme = require("../lib/metroScheme");
const { renderMetroPage } = require("../lib/metroSchemeRender");

const router = express.Router();

// Warm the street-cluster cache at router-load time (server startup)
// instead of on the first visitor's request — see streetsDirectory.js's
// comment on why this is a one-time, ~100ms, safe-to-do-eagerly cost.
streets.get();

// 2026-09-07: "/" became this landing/hub page itself (was the bare SPA —
// see index.js's own comment). HOME now means "site root", not "the map".
// DIRECTORY is gone — every breadcrumb that used to read "Карта Софии ›
// Справочник › ..." now reads "София › ..." directly, since the hub IS
// the root, not a page one level below it.
const HOME = { label: "София", href: "/" };

function notFound(res, what) {
  res.status(404).type("html").send(page({ title: "Не найдено", h1: "Не найдено", body: `<p>${what} не найден(а).</p><p><a href="/">← На главную</a></p>` }));
}

// ---------------------------------------------------------------------- "/"
// The site's landing/hub page (2026-09-07, replacing the old "/directory/"
// hub — moved here verbatim plus two additions). Until this change "/" was
// the bare MapLibre SPA: no real text, no outbound links a crawler could
// follow, so the domain root passed none of its link weight to the ~150
// 000 indexable pages this project has spent most of its recent sessions
// building (postal codes, cultural heritage, schools, admin/police
// contacts — see house-page-template.md §14-26). The map is still fully
// available, one click away at /map/ — this page just isn't it anymore.
router.get("/", (req, res) => {
  const streetTotal = streets.get().entries.length;
  const rubricRows = rubrics.listRubrics();
  const orgTotal = rubricRows.reduce((a, r) => a + r.count, 0);
  const routeCounts = Object.keys(routesDir.ROUTE_TABLES).map((t) => ({ t, n: routesDir.listRoutes(t).length }));
  const routeTotal = routeCounts.reduce((a, r) => a + r.n, 0);
  const stopCounts = Object.keys(stops.TYPE_LABELS).map((t) => ({ t, n: (stops.getType(t) || { stops: [] }).stops.length }));
  const stopTotal = stopCounts.reduce((a, r) => a + r.n, 0);

  const seoParagraph = `
    <p>
      Интерактивная карта Софии и справочник объектов города: улицы (${streetTotal}), организации
      (${orgTotal}) по ${rubricRows.length} рубрикам, маршруты общественного транспорта (${routeTotal}),
      остановки и станции (${stopTotal}), районы, населённые пункты Столичной общины и почтовые индексы
      каждого дома.
    </p>
  `;

  // Two equal-weight entry points (2026-09-07, by direct request — "равнозначную
  // ссылке на карту"): the interactive geographic map, and the schematic metro
  // diagram (still in development — see claude/metro-scheme-plan.md — so this
  // links to an honest "в разработке" page for now, not a fabricated finished
  // one; the URL and its equal billing on the homepage are real from day one).
  const mapCta = `
    <p class="map-cta">
      <a class="map-link" href="/map/">Открыть интерактивную карту →</a>
      <a class="map-link" href="/metro/">Схема метро →</a>
    </p>
  `;

  const body = itemList([
    { href: "/streets/", label: "Улицы", count: streetTotal },
    { href: "/rubrics/", label: "Организации по рубрикам", count: `${orgTotal} · ${rubricRows.length} рубрик` },
    { href: "/routes/", label: "Маршруты транспорта", count: routeTotal },
    { href: "/stops/", label: "Остановки и станции", count: stopTotal },
    { href: "/districts/", label: "Районы", count: areas.getAll("districts").length },
    { href: "/settlements/", label: "Населённые пункты", count: areas.getAll("settlements").length },
    { href: "/indexes/", label: "Почтовые индексы", count: postcodes.get().codes.length },
  ]);
  res.type("html").send(page({
    title: "Карта Софии — интерактивная карта и справочник домов, улиц, организаций и транспорта",
    h1: "Карта Софии",
    body: `${seoParagraph}${mapCta}${body}`,
  }));
});

// Old hub URL — permanent redirect, not a second copy of the same content
// (avoids a duplicate-content page competing with "/" itself in search).
router.get("/directory/", (req, res) => res.redirect(301, "/"));

// -------------------------------------------------------------------- /metro/
// The interactive schematic metro diagram (2026-09-08) — replaces the
// honest "в разработке" stub that stood here since the homepage first linked
// to this URL with equal billing to /map/. See claude/metro-scheme-plan.md
// for the original spec and claude/metro-scheme-build-notes.md for what
// changed during the actual build (50 real stations, not the estimated 60;
// where the schematic coordinates came from; the two disclosed
// approximations — travel-time estimates and the one restored station name).
// All rendering/data logic lives in lib/metroScheme.js + lib/metroSchemeRender.js;
// this route is just the same page()-shell wiring every other route here uses.
router.get("/metro/", (req, res) => {
  const data = metroScheme.build();
  res.type("html").send(page({
    title: "Схема метро Софии — Карта Софии",
    h1: "Схема метро Софии",
    breadcrumbs: [HOME, { label: "Схема метро" }],
    body: renderMetroPage(data),
    // /metro/ is explicitly out of scope for the header/footer/ad-rail
    // chrome (site-design-plan.md §4.1) despite sharing this page() shell
    // with every "typical" page — frame:false keeps its output identical
    // to what page() produced before the chrome existed.
    frame: false,
  }));
});

// ------------------------------------------------------------------ /streets/
const TYPE_FILTER_ORDER = ["all", "ulitsi", "bulevardi", "alei", "shosseta", "ploshtadi", "proezdi", "drugi"];
function typeFilterNav(activeType, hrefFor) {
  const counts = streets.typeCounts();
  const total = streets.get().entries.length;
  const items = TYPE_FILTER_ORDER.map((t) => {
    const label = t === "all" ? "Все" : streets.TYPE_LABELS[t];
    const n = t === "all" ? total : counts.get(t) || 0;
    if (!n) return "";
    const isActive = (activeType || "all") === t;
    return `<li>${isActive ? `<span class="active">${label} (${n})</span>` : `<a href="${hrefFor(t)}">${label} (${n})</a>`}</li>`;
  }).join("");
  return `<ul class="type-filter">${items}</ul>`;
}
function streetTypeQS(type) {
  return type && type !== "all" ? `?type=${encodeURIComponent(type)}` : "";
}
// Russian plural of "остановка" for a count (1 остановка / 2-4 остановки /
// 5-20, 25, ... остановок) — used by the house page's "N ост. до метро"
// text (§15.1); the existing ad-hoc "N === 1 ? x : y" pattern elsewhere in
// this file only handles the singular/plural split, not this word's
// three-way one, so it gets a real helper instead.
function stopsWord(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "остановка";
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "остановки";
  return "остановок";
}
// One "Остановки рядом" card (§15.2, following a reference screenshot the
// user supplied 2026-09-06): name/type/distance, then its OWN routes as
// chips grouped by mode ("Автобусы"/"Трамваи"/...) — not the single
// deduped chip row at the end of the whole block, which only says which
// numbers exist somewhere nearby without saying which stop to catch them
// from. A route whose direction from this exact stop reaches a metro
// station gets that named on its own chip (transportNearby.js's per-route
// `toMetro`, §15.1) — the OTHER direction of the same ref, boarded here,
// may not, so this can't be hoisted to one line per stop.
function surfaceStopCard(s) {
  const head = `<div class="stop-head">${s.href ? `<a href="${esc(s.href)}">${esc(s.name)}</a>` : `<span>${esc(s.name)}</span>`}<span class="count">${esc(s.typeLabel)} · ${s.distanceM} м</span></div>`;
  const named = s.routes.filter((r) => r.ref);
  if (!named.length) return `<li>${head}</li>`;
  const byType = new Map();
  for (const r of named) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(r);
  }
  const groups = [...byType.entries()]
    .map(([type, routes]) => `
      <p class="stop-routes-label">${esc(routesDir.TYPE_LABELS[type] || type)}</p>
      <ul class="stop-routes">${routes
        .map(
          (r) =>
            `<li><a class="route-badge" href="${esc(r.href)}">${esc(r.ref)}</a>${
              r.toMetro ? `<span class="route-note">до метро «${esc(r.toMetro.metroName)}» — ${r.toMetro.stops} ${stopsWord(r.toMetro.stops)}</span>` : ""
            }</li>`
        )
        .join("")}</ul>
    `)
    .join("");
  return `<li>${head}${groups}</li>`;
}

// The "Как доехать"/"Транспорт рядом" inner content (metro box + surface
// stop cards + deduped route-chip row) — factored out of the house page
// (§12.3) so the organization page can reuse the exact same rendering
// (house-page-template.md §9's organization-page adaptation: "«Транспорт
// рядом» (переиспользовать логику §12.3 с страницы дома)") instead of a
// second, drifting copy. Returns "" when there's nothing at all nearby, so
// callers can skip the heading entirely rather than printing an empty
// section (this file's rule everywhere: no data, no block).
function kakProehatHtml(kakProehat) {
  const { metro, surface } = kakProehat;
  if (!metro.length && !surface.stops.length) return "";
  let inner = "";
  if (metro.length) {
    inner += `
      <h3>Ближайшее метро</h3>
      ${itemList(metro.map((s) => ({ href: s.href, label: `${s.name} · ${s.distanceM} м`, count: null })))}
    `;
  }
  if (surface.stops.length) {
    inner += `
      <h3>Остановки рядом</h3>
      <ul class="stop-list">${surface.stops.map(surfaceStopCard).join("")}</ul>
      <p class="meta">Показан${surface.stops.length === 1 ? "а" : "ы"} ${surface.stops.length} ближайш${surface.stops.length === 1 ? "ая" : "их"} остановк${surface.stops.length === 1 ? "а" : "и"} из ${surface.total} в радиусе ${surface.radiusM} м</p>
    `;
  }
  if (kakProehat.routes.length) {
    inner += `<ul class="type-filter">${kakProehat.routes.map((r) => `<li><a href="${esc(r.href)}">${esc(r.ref || "?")}</a></li>`).join("")}</ul>`;
  }
  return inner;
}

// Organization "Основное" contacts (house-page-template.md §9's
// organization-page adaptation) — phone/website/email/opening_hours/
// wheelchair already existed in `organizations` and were never rendered
// anywhere on the site before this. Same "no data, no row" rule as
// everywhere else: each line only appears when that specific field is
// non-empty for THIS organization.
const WHEELCHAIR_LABELS = { yes: "доступно", no: "недоступно", limited: "частично доступно", designated: "специально оборудовано" };
function wheelchairLabel(v) {
  return WHEELCHAIR_LABELS[v] || v;
}
function websiteHref(url) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}
function organizationContactHtml(company) {
  const lines = [];
  if (company.phone) lines.push(`<p>Телефон: ${esc(company.phone)}</p>`);
  // A handful of `website` values in the source data are actually mistagged
  // emails (contain "@" — e.g. "user@domain.bg" instead of a URL) — shown
  // as plain text rather than wrapped in an https:// link that would
  // misrepresent what the value actually is.
  if (company.website) {
    lines.push(company.website.includes("@")
      ? `<p>Сайт: ${esc(company.website)}</p>`
      : `<p>Сайт: <a href="${esc(websiteHref(company.website))}" rel="nofollow">${esc(company.website)}</a></p>`);
  }
  if (company.email) lines.push(`<p>Email: <a href="mailto:${esc(company.email)}">${esc(company.email)}</a></p>`);
  if (company.opening_hours) lines.push(`<p>Часы работы: ${esc(company.opening_hours)}</p>`);
  if (company.wheelchair) lines.push(`<p>Доступность для колясок: ${esc(wheelchairLabel(company.wheelchair))}</p>`);
  return lines.join("");
}

router.get("/streets/", (req, res) => {
  const type = req.query.type && streets.TYPE_LABELS[req.query.type] ? req.query.type : null;
  const idx = streets.getForType(type);
  const body = `
    ${typeFilterNav(type, (t) => `/streets/${streetTypeQS(t)}`)}
    <p class="meta">Всего улиц: ${idx.entries.length}</p>
    ${letterNav(idx.alpha.summary, { hrefFor: (slug) => `/streets/${slug}/${streetTypeQS(type)}` })}
  `;
  res.type("html").send(page({
    title: "Улицы Софии — алфавитный указатель",
    h1: "Улицы Софии",
    breadcrumbs: [HOME, { label: "Улицы" }],
    body,
  }));
});

// NOTE on the `([^./]+)` constraints below: Express's default (non-strict)
// routing treats a trailing "/" as optional, which means an UNconstrained
// `/streets/:letterSlug/` would also match a single-segment path like
// `/streets/some-street.html` (capturing the whole thing, dot included,
// as `letterSlug`) — and because this route is registered first, it would
// silently swallow every street page request before the real
// `/streets/:slug.html` route below ever saw it (caught via an actual
// 404 while testing the Янтра walkthrough, not spotted by inspection).
// Excluding "." from every letter/subgroup/type param closes that off.
router.get("/streets/:letterSlug([^./]+)/", (req, res) => {
  const type = req.query.type && streets.TYPE_LABELS[req.query.type] ? req.query.type : null;
  const idx = streets.getForType(type);
  const letterPage = idx.alpha.letterPages.get(req.params.letterSlug);
  if (!letterPage) return notFound(res, "Буква");
  const qs = streetTypeQS(type);

  let body = `${typeFilterNav(type, (t) => `/streets/${req.params.letterSlug}/${streetTypeQS(t)}`)}`;
  body += letterNav(idx.alpha.summary, { activeSlug: req.params.letterSlug, hrefFor: (slug) => `/streets/${slug}/${qs}` });
  body += `<p class="meta">Буква «${letterPage.letter}»: ${letterPage.count} улиц${letterPage.subgroups ? ", разбито на группы" : ""}</p>`;

  if (letterPage.subgroups) {
    body += itemList(letterPage.subgroups.map((sg) => ({ href: `/streets/${req.params.letterSlug}/${sg.slug}/${qs}`, label: sg.label, count: sg.entries.length })));
  } else {
    body += itemList(letterPage.entries.map((e) => ({ href: `/streets/${e.slug}.html`, label: e.district ? `${e.displayName} · ${e.district}` : e.displayName, count: null })));
  }

  res.type("html").send(page({
    title: `Улицы Софии на букву «${letterPage.letter}»`,
    h1: `Улицы на букву «${letterPage.letter}»`,
    breadcrumbs: [HOME, { label: "Улицы", href: "/streets/" }, { label: letterPage.letter }],
    body,
  }));
});

router.get("/streets/:letterSlug([^./]+)/:subgroupSlug([^./]+)/", (req, res) => {
  const type = req.query.type && streets.TYPE_LABELS[req.query.type] ? req.query.type : null;
  const idx = streets.getForType(type);
  const key = `${req.params.letterSlug}/${req.params.subgroupSlug}`;
  const sg = idx.alpha.subgroupPages.get(key);
  if (!sg) return notFound(res, "Группа улиц");
  const qs = streetTypeQS(type);

  let body = `${typeFilterNav(type, (t) => `/streets/${key}/${streetTypeQS(t)}`)}`;
  body += letterNav(idx.alpha.summary, { activeSlug: req.params.letterSlug, hrefFor: (slug) => `/streets/${slug}/${qs}` });
  body += `<div class="subgroup-nav">
    <span>${sg.prevSlug ? `<a href="/streets/${sg.letterSlug}/${sg.prevSlug}/${qs}">← ${sg.prevLabel}</a>` : ""}</span>
    <span>${sg.nextSlug ? `<a href="/streets/${sg.letterSlug}/${sg.nextSlug}/${qs}">${sg.nextLabel} →</a>` : ""}</span>
  </div>`;
  body += `<p class="meta">Группа «${sg.label}»: ${sg.count} улиц</p>`;
  body += itemList(sg.entries.map((e) => ({ href: `/streets/${e.slug}.html`, label: e.district ? `${e.displayName} · ${e.district}` : e.displayName, count: null })));

  res.type("html").send(page({
    title: `Улицы Софии: ${sg.label}`,
    h1: `Улицы: ${sg.label}`,
    breadcrumbs: [HOME, { label: "Улицы", href: "/streets/" }, { label: sg.letter, href: `/streets/${sg.letterSlug}/` }, { label: sg.label }],
    body,
  }));
});

// The street page — house-page-template.md §9's street-page adaptation
// (2026-09-07): "Основное" gets the official district via point-in-
// polygon on the cluster's own representative point (the same
// areasDirectory lookup the house page uses on one exact building, §5 —
// NOT `entry.district`, which is a nearest-CENTROID disambiguation label
// for same-named clusters, not a real containment test); "Организации"
// covers every house on the street, not one (orgMatch.js#
// findOrganizationsForStreet, same calibrated three-tier matching as the
// house page, just run per house and merged); "Инфраструктура рядом" is
// measured against the street's actual GEOMETRY, not a single point (a
// long boulevard's own midpoint can sit hundreds of metres from either of
// its ends).
// 2026-09-09 fix (reported live: "ул. Жамбилица 1" listed three times in
// "Дома") — see housenumberProvenance.js for why duplicate building rows
// exist and streetsDirectory.js's getHousesForEntry for how one is picked
// as the address's main entry (`house.variants`) with the rest flagged
// (`house.variantOf`). These two render the honest explanation rather than
// silently hiding the duplicates: a small note under the main entry linking
// to the other version(s), and a note on each other version's own page
// pointing back to the main one.
function houseVariantsNote(house, streetSlug, tag = "div") {
  if (!house.variants || !house.variants.length) return "";
  // sourceLabel()/houseSourceLabel() already return a fully-formed
  // "label (org)" string (and for some sources the label itself already
  // carries its own guillemets, e.g. "«Официалните адреси...» (address_sofia)")
  // — no extra «» wrapping here, same convention postcodeProvenance.js's
  // sourceLink() uses.
  const links = house.variants
    .map((v) => `<a href="/streets/${esc(streetSlug)}/dom-${esc(v.slug)}.html">запись из ${esc(v.sourceLabel)}</a>`)
    .join(", ");
  return `<${tag} class="${tag === "p" ? "meta " : ""}house-variants-note">ℹ Этот адрес продублирован в исходных данных — контур здания встретился в нескольких источниках. Показана запись из источника ${esc(houseSourceLabel(house.housenumber_src))}; другие варианты: ${links}.</${tag}>`;
}
function houseVariantOfNote(house, streetSlug) {
  if (!house.variantOf) return "";
  return `<p class="meta house-variants-note">ℹ Это не единственная запись для этого адреса в наших данных — контур этого здания продублирован (эта запись из источника ${esc(houseSourceLabel(house.housenumber_src))}). Основная запись: <a href="/streets/${esc(streetSlug)}/dom-${esc(house.variantOf.slug)}.html">${esc(house.variantOf.displayName)}</a> (источник ${esc(house.variantOf.sourceLabel)}).</p>`;
}

const ORGS_DISPLAY_LIMIT = 80;
router.get("/streets/:slug.html", (req, res) => {
  const idx = streets.get();
  const entry = idx.bySlug.get(req.params.slug);
  if (!entry) return notFound(res, "Улица");
  const houses = streets.getHousesForEntry(entry);
  const displayName = entry.district ? `${entry.displayName} · ${entry.district}` : entry.displayName;

  const { segments, bbox, repPoint } = streets.getClusterGeometry(entry);
  const district = repPoint ? areas.findContaining(repPoint[1], repPoint[0]) : null;
  const orgs = orgMatch.findOrganizationsForStreet(houses, entry.name);
  const orgsShown = orgs.slice(0, ORGS_DISPLAY_LIMIT);
  const infra = bbox ? rubrics.getNearbyByRubricForGeometry(segments, bbox, streets.distanceToCluster) : [];

  const mainBlock = `
    <h2 id="main">Основное</h2>
    <p class="meta">${streets.TYPE_LABELS[entry.type]}${entry.district ? ` · ${entry.district}` : ""}${district ? ` · <a href="/${district.kind}/${district.slug}.html">${esc(district.name)}</a>` : ""}</p>
    ${mapLink(entry.name, "streets")}
  `;

  // Only one entry per real civic number is shown here — duplicate building
  // rows (see housenumberProvenance.js) stay individually reachable via the
  // note under their address's main entry, they just don't clutter the list
  // as separate-looking "houses" (2026-09-09 fix).
  const visibleHouses = houses.filter((h) => !h.variantOf);
  const housesBlock = `
    <h2 id="houses">Дома (${visibleHouses.length})</h2>
    <ul class="item-list">${visibleHouses
      .map((h) => {
        const note = houseVariantsNote(h, entry.slug);
        return `<li${note ? ' class="has-variants"' : ""}><a href="/streets/${esc(entry.slug)}/dom-${esc(h.slug)}.html">${esc(h.displayName)}</a>${note}</li>`;
      })
      .join("")}</ul>
  `;

  const orgsBlock = orgs.length ? `
    <h2 id="orgs">Организации (${orgs.length})</h2>
    ${itemList(orgsShown.map((o) => ({ href: o.href, label: o.exact ? o.name : `${o.name} (поблизости)`, count: o.rubric || null })))}
    ${orgs.length > ORGS_DISPLAY_LIMIT ? `<p class="meta">Показаны первые ${ORGS_DISPLAY_LIMIT} из ${orgs.length}.</p>` : ""}
  ` : "";

  const infraBlock = infra.length ? `
    <h2 id="infra">Инфраструктура рядом</h2>
    <ul class="type-filter">${infra.map((r) => `<li><a href="/rubrics/${r.slug}/?nearStreet=${entry.slug}">${esc(r.name)} (${r.nearbyCount})</a></li>`).join("")}</ul>
  ` : "";

  const anchors = [{ href: "#main", label: "Основное" }, { href: "#houses", label: "Дома" }];
  if (orgsBlock) anchors.push({ href: "#orgs", label: "Организации" });
  if (infraBlock) anchors.push({ href: "#infra", label: "Инфраструктура" });
  const anchorNav = `<p class="meta">${anchors.map((a) => `<a href="${a.href}">${esc(a.label)}</a>`).join(" · ")}</p>`;

  // SEO paragraph (§8) — only facts this specific street cluster actually has.
  const seoFacts = [];
  if (district) seoFacts.push(`проходит в районе ${district.name}`);
  if (orgs.length) seoFacts.push(`${orgs.length} организаци${orgs.length === 1 ? "я" : "й"} на этой улице`);
  seoFacts.push(`${visibleHouses.length} дом${visibleHouses.length === 1 ? "" : "ов"}`);
  const seoParagraph = `<p>${esc(displayName)} — ${seoFacts.join(", ")}.</p>`;

  const body = `
    ${seoParagraph}
    ${anchorNav}
    ${mainBlock}
    ${housesBlock}
    ${orgsBlock}
    ${infraBlock}
  `;
  res.type("html").send(page({
    title: `${displayName} — улица в Софии`,
    h1: displayName,
    breadcrumbs: [HOME, { label: "Улицы", href: "/streets/" }, { label: entry.displayName }],
    body,
  }));
});

// The house/address page — the "typical page" template developed in
// house-page-template.md from the moscowmap.ru reference passport,
// reconciled against what this dataset actually has (§9 skeleton, §5
// district, §6 organizations, §7 infrastructure, §12.3 transport). Every
// added block below is conditional on real data being found for THIS
// house — nothing here ever prints an empty section or a placeholder for
// data we don't have (buildingKind.js/streetDesignation.js's own rule:
// never claim more than is actually known).
router.get("/streets/:streetSlug/dom-:houseSlug.html", (req, res) => {
  const idx = streets.get();
  const entry = idx.bySlug.get(req.params.streetSlug);
  if (!entry) return notFound(res, "Улица");
  const houses = streets.getHousesForEntry(entry);
  const house = houses.find((h) => h.slug === req.params.houseSlug);
  if (!house) return notFound(res, "Дом");
  const displayStreet = entry.district ? `${entry.displayName} · ${entry.district}` : entry.displayName;

  // §5: point-in-polygon, not the street cluster's own nearest-centroid
  // label — this is one exact point (the building itself), so use the
  // exact answer rather than the street-level approximation.
  const district = areas.findContaining(house.lat, house.lon);
  // §13.11/§13.12: the OFFICIAL raion (one of the 24 administrative
  // districts of Sofia Municipality) — a different, coarser polygon than
  // `district` above (which is really the OSM quarter/housing-estate the
  // house sits in, e.g. "Център"; a house's official raion is usually
  // "Средец"). Point-in-polygon against the boundary file the user
  // supplied (raionsDirectory.js) after this sandbox's own network
  // policy blocked downloading it directly — `null` outside the mapped
  // area is expected, not a bug, same as every other findContaining-style
  // lookup on this page.
  const raion = raions.findRaion(house.lat, house.lon);
  const adminContact = raion ? districtAdmin.getByRaionName(raion.name) : null;
  const policeContact = raion ? police.getByRaionName(raion.name) : null;
  // §6: three-tier match (own tag / geometric containment / 50m proximity
  // fallback) — see orgMatch.js for why this replaced the original,
  // methodologically wrong "83% of orgs have no address" estimate.
  const orgs = orgMatch.findOrganizationsForBuilding({
    housenumber: house.housenumber,
    addr_street: house.addr_street || entry.name,
    lat: house.lat,
    lon: house.lon,
    geometryRaw: house.geometryRaw,
  });
  // §12: "Как доехать" — nearest metro (own box, own radius) + nearest
  // surface stops with their routes, mirroring the reference's own
  // two-part shape (transportNearby.js's getKakProehat) rather than one
  // undifferentiated list — see that module's comment for why metro needs
  // a materially larger radius than surface stops in this city.
  const kakProehat = transportNearby.getKakProehat(house.lat, house.lon);
  // §7: only rubrics that actually have something nearby.
  const infra = rubrics.getNearbyByRubric(house.lat, house.lon);
  // §17: individually-listed cultural monument (footprint overlap or
  // ≤30m — culturalHeritage.js) and/or protection zone (real drawn
  // boundary, containment only) — either can be null, most houses are
  // neither.
  const monument = culturalHeritage.findMonumentForHouse({ lat: house.lat, lon: house.lon, geometryRaw: house.geometryRaw });
  const protectionZone = culturalHeritage.findProtectionZoneForHouse(
    { lat: house.lat, lon: house.lon },
    { excludeRn: monument ? monument.rn : undefined }
  );
  // §13.10/§18: официально прилежащее училище по адресу (street+housenumber
  // match against the municipal register) — null for the ~30% of addresses
  // outside that register's ул./бул./пл. scope or genuinely missing from it,
  // same "no match, no block" rule as everywhere else on this page.
  const schoolMatch = schoolsDir.findSchoolsForHouse({
    addr_street: house.addr_street || entry.name,
    housenumber: house.housenumber,
  });

  const kindLabel = buildingKindLabel(house.building);

  // ---- Основное ----
  let mainMeta = `${esc(kindLabel)}`;
  if (house.levels) mainMeta += ` · ${esc(house.levels)} эт.`;
  // §Находка №11 / data-honesty: индекс больше не показывается как один
  // безликий факт — под ним, где это уместно, идёт короткая честная
  // приписка: либо ссылка на первоисточник (реестр), либо признание, что
  // индекс вычислен нами, либо (для конфликтующих случаев вроде бул. Св.
  // Климент Охридски) — разбор самого конфликта. См. lib/postcodeProvenance.js
  // и claude/data-honesty-and-quirks.md.
  let postcodeNoteHtml = "";
  if (house.postcode) {
    mainMeta += ` · п.к. <a href="/indexes/${esc(house.postcode)}/">${esc(house.postcode)}</a>`;
    const note = getPostcodeNote(house.postcode_src);
    if (note) postcodeNoteHtml = note.html;
  }
  if (district) mainMeta += ` · <a href="/${district.kind}/${district.slug}.html">${esc(district.name)}</a>`;

  // §Находка №11 / data-honesty: если это название улицы физически
  // встречается в нескольких несвязанных местах Столичной общины (как
  // "Свети Климент Охридски" — короткая улица в центре И отдельный
  // бульвар в Студентски, плюс сёла на севере), прямо говорим об этом и
  // ссылаемся на "тёзок" — это НАША сила, честное объяснение того, с чем
  // официальные справочники обычно не разбираются, а не путаница, которую
  // стоило бы прятать.
  const namesakes = idx.entries.filter((e) => e.name === entry.name && e.slug !== entry.slug && e.district);
  // Некоторые названия ("Здравец", "Еделвайс" и т.п. — обычные для
  // болгарских сёл "садовые" имена улиц) физически повторяются в 15-20+
  // разных местах Столичной общины; перечислять их все инлайн на карточке
  // дома было бы уже не честным пояснением, а шумом — показываем первые
  // несколько и добавляем ссылку на полный разбор на /o-dannyh/.
  const NAMESAKES_INLINE_LIMIT = 6;
  const collisionHtml = namesakes.length
    ? `<p class="meta street-collision-note">ℹ Название «${esc(entry.displayName)}» в Столичной общине встречается не один раз (${namesakes.length + 1} мест) — ` +
      `это отдельные, физически не связанные улицы, например: ${namesakes
        .slice(0, NAMESAKES_INLINE_LIMIT)
        .map((n) => `<a href="/streets/${esc(n.slug)}.html">${esc(n.displayName)}${n.district ? ` (${esc(n.district)})` : ""}</a>`)
        .join(", ")}${namesakes.length > NAMESAKES_INLINE_LIMIT ? ` и ещё ${namesakes.length - NAMESAKES_INLINE_LIMIT}` : ""}. ` +
      `Если адрес выглядит не в том районе — возможно, это не ошибка, а просто тёзка (подробнее: <a href="/o-dannyh/#odnoimennye-ulitsy">почему так бывает</a>).</p>`
    : "";

  // 2026-09-09 fix — same duplicate-building-row situation as the street
  // list (see housenumberProvenance.js): whichever of these two applies to
  // THIS house, one is always empty.
  const duplicateNoteHtml = house.variantOf
    ? houseVariantOfNote(house, entry.slug)
    : houseVariantsNote(house, entry.slug, "p");

  const mainInner = `
    <p class="meta">${mainMeta}</p>
    ${postcodeNoteHtml}
    ${collisionHtml}
    ${duplicateNoteHtml}
    ${mapLink(house.housenumber ? `${entry.name} ${house.housenumber}` : entry.name, "streets")}
  `;
  const mainBlock = blockWrap("main", "Основное", "mapPin", mainInner);

  // Live map widget (decision C13) — same address text as the "Открыть на
  // карте" link above, via the shared mapHref()/`?q=` convention (see
  // htmlPage.js's miniMapWidget()); needs the house's own point, not the
  // street cluster's, so it lands on this exact building.
  const mapWidgetHtml = miniMapWidget({
    lat: house.lat,
    lon: house.lon,
    query: house.housenumber ? `${entry.name} ${house.housenumber}` : entry.name,
    type: "streets",
  });

  // ---- Как доехать (§12: metro box + surface stops, reference's own
  // two-part shape — see transportNearby.js#getKakProehat). Rendering
  // itself now lives in the shared kakProehatHtml() (2026-09-07), reused
  // verbatim by the organization page's "Транспорт рядом" block below.
  const { metro, surface } = kakProehat;
  const kpHtml = kakProehatHtml(kakProehat);
  const transportBlock = kpHtml ? blockWrap("transport", "Как доехать", "bus", kpHtml) : "";

  // ---- Культурное наследие (§13.2/§17) ----
  let heritageBlock = "";
  if (monument || protectionZone) {
    let inner = "";
    if (monument) {
      const facts = [monument.type, monument.category].filter(Boolean);
      const label = monument.exact
        ? esc(monument.name)
        : `${esc(monument.name)} (предположительно, в ${monument.distanceM} м)`;
      inner += `<p>${label}${facts.length ? ` — ${esc(facts.join(", "))}` : ""}</p>`;
      if (monument.act) inner += `<p class="meta">Охраняется на основании: ${esc(monument.act)}</p>`;
    }
    if (protectionZone) {
      inner += `<p>Дом находится в охранной зоне памятника «${esc(protectionZone.name)}»</p>`;
    }
    heritageBlock = blockWrap("heritage", "Культурное наследие", "landmark", inner);
  }

  // ---- Администрация и полиция (§13.6/§13.11/§13.12) — only when the
  // house's point actually falls inside one of the 24 official raion
  // polygons; both contact tables cover all 24 raions completely (no
  // partial-coverage case to worry about), so this is all-or-nothing with
  // `raion` itself.
  let adminBlock = "";
  if (raion && adminContact && policeContact) {
    const inner = `
      <p class="meta">Официальный район: <strong>${esc(raion.name)}</strong></p>
      <p>Районна администрация «${esc(raion.name)}»: ${esc(adminContact.address)} (кмет: ${esc(adminContact.mayor)})</p>
      <p>${esc(policeContact.num)} РУ СДВР: ${esc(policeContact.address)}, тел. ${esc(policeContact.phone)}</p>
    `;
    adminBlock = blockWrap("admin", "Администрация и полиция", "shield", inner);
  }

  // ---- Приписанная школа (§13.10/§18) ----
  let schoolBlock = "";
  if (schoolMatch) {
    const inner = schoolMatch.ambiguous
      ? `<p class="meta">Для этого адреса в реестре указано несколько школ (вероятно, по разным подъездам):</p><ul>${schoolMatch.schools.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
      : `<p>${esc(schoolMatch.schools[0])}</p>`;
    schoolBlock = blockWrap("school", "Приписанная школа", "school", inner);
  }

  // ---- Организации ----
  let orgsBlock = "";
  if (orgs.length) {
    const inner = itemList(orgs.map((o) => ({ href: o.href, label: o.exact ? o.name : `${o.name} (поблизости)`, count: o.rubric || null })));
    orgsBlock = blockWrap("orgs", `Организации (${orgs.length})`, "briefcase", inner);
  }

  // ---- Инфраструктура рядом ----
  let infraBlock = "";
  if (infra.length) {
    const inner = `<ul class="type-filter">${infra.map((r) => `<li><a href="/rubrics/${r.slug}/?near=${house.lat},${house.lon}">${esc(r.name)} (${r.nearbyCount})</a></li>`).join("")}</ul>`;
    infraBlock = blockWrap("infra", "Инфраструктура рядом", "grid", inner);
  }

  // ---- якорное меню — только реально присутствующие блоки (§9) ----
  const anchors = [{ href: "#main", label: "Основное" }];
  if (heritageBlock) anchors.push({ href: "#heritage", label: "Культурное наследие" });
  if (metro.length || surface.stops.length) anchors.push({ href: "#transport", label: "Как доехать" });
  if (adminBlock) anchors.push({ href: "#admin", label: "Администрация" });
  if (schoolBlock) anchors.push({ href: "#school", label: "Школа" });
  if (orgs.length) anchors.push({ href: "#orgs", label: "Организации" });
  if (infra.length) anchors.push({ href: "#infra", label: "Инфраструктура" });
  const anchorNav = anchors.length > 1 ? `<p class="meta">${anchors.map((a) => `<a href="${a.href}">${esc(a.label)}</a>`).join(" · ")}</p>` : "";

  // ---- SEO-абзац (§8) — только реально присутствующие факты, никогда
  // фиксированный шаблон текста с постоянным списком возможностей.
  // Metro headlines the sentence when there's one close enough to matter
  // (mirrors the reference's own SEO paragraph, which always leads with
  // the metro distance) — falls back to the nearest surface stop
  // otherwise, since most houses in this city have no nearby metro at all.
  const seoFacts = [];
  if (monument && monument.exact) seoFacts.push(`является объектом культурного наследия («${monument.name}»)`);
  if (district) seoFacts.push(`расположен в районе ${district.name}`);
  if (schoolMatch && !schoolMatch.ambiguous) seoFacts.push(`приписан к школе «${schoolMatch.schools[0]}»`);
  if (orgs.length) seoFacts.push(`${orgs.length} организаци${orgs.length === 1 ? "я" : "й"} по этому адресу`);
  if (metro.length) seoFacts.push(`ближайшее метро «${metro[0].name}» в ${metro[0].distanceM} м`);
  else if (surface.stops.length) seoFacts.push(`ближайшая остановка «${surface.stops[0].name}» в ${surface.stops[0].distanceM} м`);
  const seoParagraph = seoFacts.length ? `<p>${esc(house.displayName)} ${seoFacts.join(", ")}.</p>` : "";
  const seoBlockHtml = seoParagraph || anchorNav
    ? `<div class="seo-block">
        ${house.housenumber && !seoParagraph ? `<p>№ ${house.housenumber}</p>` : ""}
        ${seoParagraph}
        ${anchors.length > 1 ? `<ul class="anchor-tabs">${anchors.map((a) => `<li><a href="${a.href}">${esc(a.label)}</a></li>`).join("")}</ul>` : ""}
      </div>`
    : "";

  const body = `
    ${seoBlockHtml}
    ${mapWidgetHtml}
    ${mainBlock}
    ${heritageBlock}
    ${transportBlock}
    ${adminBlock}
    ${schoolBlock}
    ${orgsBlock}
    ${infraBlock}
  `;
  res.type("html").send(page({
    title: `${house.displayName} — ${displayStreet}`,
    h1: house.displayName,
    breadcrumbs: [HOME, { label: "Улицы", href: "/streets/" }, { label: entry.displayName, href: `/streets/${entry.slug}.html` }, { label: house.displayName }],
    body,
    headExtra: mapWidgetHtml ? mapAssetsHead() : "",
    scripts: mapWidgetHtml ? mapAssetsScripts() : "",
  }));
});

// ------------------------------------------------------------------ /rubrics/
router.get("/rubrics/", (req, res) => {
  const rows = rubrics.listRubrics();
  const body = itemList(rows.map((r) => ({ href: `/rubrics/${r.slug}/`, label: r.name, count: r.count })));
  res.type("html").send(page({
    title: "Организации по рубрикам — Карта Софии",
    h1: "Организации по рубрикам",
    breadcrumbs: [HOME, { label: "Организации" }],
    body,
  }));
});

// §7 (house-page-template.md): "Инфраструктура рядом" doesn't get its own
// URL subtree — a rubric page filtered by `?near=lat,lon` instead of
// paginated alphabetically. Checked first, before the normal
// pagination/`:n` handling below, and returns its own distance-sorted
// (not paginated) view — a "рядом" list is inherently short (bounded by
// the search radius, not by the rubric's total size), so the normal
// PAGE_SIZE pagination doesn't apply here at all.
function rubricPageHandler(req, res) {
  const rubric = rubrics.getRubricBySlug(req.params.rubricSlug);
  if (!rubric) return notFound(res, "Рубрика");

  // Street page's "Инфраструктура рядом" grid (house-page-template.md's
  // street-page adaptation, 2026-09-07) links here with `?nearStreet=` —
  // NOT `?near=lat,lon` — because a street's "рядом" has to be measured
  // against its actual geometry (every segment of its cluster), not one
  // representative point: a long boulevard's own midpoint can sit
  // hundreds of metres from either of its own ends. This mirrors the
  // `?near=` branch below exactly, just against
  // rubricsDirectory.js#getNearbyForRubricByGeometry instead of the
  // point version.
  if (req.query.nearStreet) {
    const idx = streets.get();
    const entry = idx.bySlug.get(String(req.query.nearStreet));
    if (!entry) return notFound(res, "Улица");
    const { segments, bbox } = streets.getClusterGeometry(entry);
    const radiusParsed = parseInt(req.query.radius, 10);
    const radiusM = Number.isFinite(radiusParsed) && radiusParsed > 0 ? radiusParsed : rubrics.DEFAULT_NEARBY_RADIUS_M;
    const items = bbox ? rubrics.getNearbyForRubricByGeometry(rubric, segments, streets.distanceToCluster, radiusM) : [];
    const streetLabel = entry.district ? `${entry.displayName} · ${entry.district}` : entry.displayName;
    const body = `
      <p class="meta">${items.length ? `Рядом с улицей «${esc(streetLabel)}» (в радиусе ${radiusM} м): ${items.length}` : `В радиусе ${radiusM} м от улицы «${esc(streetLabel)}» ничего не найдено`}</p>
      ${itemList(items.map((c) => ({ href: `/rubrics/${rubric.slug}/${c.slug}.html`, label: c.name, count: `${c.distanceM} м` })))}
    `;
    return res.type("html").send(page({
      title: `${rubric.name} рядом с улицей ${entry.displayName} — организации в Софии`,
      h1: `${rubric.name} — рядом с улицей ${entry.displayName}`,
      breadcrumbs: [HOME, { label: "Организации", href: "/rubrics/" }, { label: rubric.name, href: `/rubrics/${rubric.slug}/` }, { label: "Рядом" }],
      body,
    }));
  }

  if (req.query.near) {
    const [latStr, lonStr] = String(req.query.near).split(",");
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return notFound(res, "Координаты");
    const radiusParsed = parseInt(req.query.radius, 10);
    const radiusM = Number.isFinite(radiusParsed) && radiusParsed > 0 ? radiusParsed : rubrics.DEFAULT_NEARBY_RADIUS_M;
    const items = rubrics.getNearbyForRubric(rubric, lat, lon, radiusM);
    const body = `
      <p class="meta">${items.length ? `Рядом (в радиусе ${radiusM} м): ${items.length}` : `В радиусе ${radiusM} м ничего не найдено`}</p>
      ${itemList(items.map((c) => ({ href: `/rubrics/${rubric.slug}/${c.slug}.html`, label: c.name, count: `${c.distanceM} м` })))}
    `;
    return res.type("html").send(page({
      title: `${rubric.name} рядом — организации в Софии`,
      h1: `${rubric.name} — рядом`,
      breadcrumbs: [HOME, { label: "Организации", href: "/rubrics/" }, { label: rubric.name, href: `/rubrics/${rubric.slug}/` }, { label: "Рядом" }],
      body,
    }));
  }

  const pageNum = req.params.n ? parseInt(req.params.n, 10) : 1;
  if (!Number.isFinite(pageNum) || pageNum < 1) return notFound(res, "Страница");
  const { items, total, pageCount } = rubrics.getCompanyPage(rubric, pageNum);
  if (pageNum > 1 && !items.length) return notFound(res, "Страница");

  let pagination = "";
  if (pageCount > 1) {
    const links = [];
    for (let i = 1; i <= pageCount; i++) {
      const href = i === 1 ? `/rubrics/${rubric.slug}/` : `/rubrics/${rubric.slug}/page-${i}/`;
      links.push(i === pageNum ? `<span class="current">${i}</span>` : `<a href="${href}">${i}</a>`);
    }
    pagination = `<div class="pagination">${links.join("")}</div>`;
  }

  const body = `
    <p class="meta">Всего организаций: ${total}${pageCount > 1 ? ` · страница ${pageNum} из ${pageCount}` : ""}</p>
    ${itemList(items.map((c) => ({ href: `/rubrics/${rubric.slug}/${c.slug}.html`, label: c.name, count: null })))}
    ${pagination}
  `;
  res.type("html").send(page({
    title: `${rubric.name} — организации в Софии`,
    h1: rubric.name,
    breadcrumbs: [HOME, { label: "Организации", href: "/rubrics/" }, { label: rubric.name }],
    body,
  }));
}
router.get("/rubrics/:rubricSlug([^./]+)/", rubricPageHandler);
router.get("/rubrics/:rubricSlug([^./]+)/page-:n(\\d+)/", rubricPageHandler);

// The organization detail page — house-page-template.md §9's organization-
// page adaptation: "Основное" (rubric + the phone/website/email/
// opening_hours/wheelchair fields that already existed in `organizations`
// and were never shown anywhere), "Транспорт рядом" (§12.3's logic,
// reused verbatim via kakProehatHtml — an organization is just another
// point as far as that module cares), "Рядом" (other organizations
// nearby, any rubric — orgMatch.js#findNearbyOrganizations, plain
// proximity, not the house page's address-tiered matching, since there's
// no building to anchor an "exact address" claim to here). Same rule as
// every other page in this file: a block with nothing found is omitted
// entirely, never shown empty.
router.get("/rubrics/:rubricSlug/:companySlug.html", (req, res) => {
  const rubric = rubrics.getRubricBySlug(req.params.rubricSlug);
  if (!rubric) return notFound(res, "Рубрика");
  const company = rubrics.findCompanyBySlug(rubric, req.params.companySlug);
  if (!company) return notFound(res, "Организация");
  const address = [withDesignation(company.addr_street), company.housenumber].filter(Boolean).join(" ");

  const kakProehat = transportNearby.getKakProehat(company.lat, company.lon);
  const { metro, surface } = kakProehat;
  const nearbyOrgs = orgMatch.findNearbyOrganizations({ lat: company.lat, lon: company.lon, excludeId: company.id });

  const mainBlock = `
    <h2 id="main">Основное</h2>
    <p class="meta">${esc(rubric.name)}${address ? ` · ${esc(address)}` : ""}</p>
    ${organizationContactHtml(company)}
    ${mapLink(company.name, "organizations")}
  `;

  const kpHtml = kakProehatHtml(kakProehat);
  const transportBlock = kpHtml ? `<h2 id="transport">Транспорт рядом</h2>${kpHtml}` : "";

  const nearbyBlock = nearbyOrgs.length ? `
    <h2 id="nearby">Рядом</h2>
    ${itemList(nearbyOrgs.map((o) => ({ href: o.href, label: o.name, count: `${o.distanceM} м` })))}
  ` : "";

  const anchors = [{ href: "#main", label: "Основное" }];
  if (transportBlock) anchors.push({ href: "#transport", label: "Транспорт рядом" });
  if (nearbyBlock) anchors.push({ href: "#nearby", label: "Рядом" });
  const anchorNav = anchors.length > 1 ? `<p class="meta">${anchors.map((a) => `<a href="${a.href}">${esc(a.label)}</a>`).join(" · ")}</p>` : "";

  // SEO paragraph (§8's rule applied here too) — only facts this specific
  // organization actually has.
  const seoFacts = [];
  if (address) seoFacts.push(`расположена по адресу ${address}`);
  if (company.phone) seoFacts.push(`телефон ${company.phone}`);
  if (metro.length) seoFacts.push(`ближайшее метро «${metro[0].name}» в ${metro[0].distanceM} м`);
  else if (surface.stops.length) seoFacts.push(`ближайшая остановка «${surface.stops[0].name}» в ${surface.stops[0].distanceM} м`);
  const seoParagraph = seoFacts.length ? `<p>${esc(company.name)} (${esc(rubric.name)}) ${seoFacts.join(", ")}.</p>` : "";

  const body = `
    ${seoParagraph}
    ${anchorNav}
    ${mainBlock}
    ${transportBlock}
    ${nearbyBlock}
  `;
  res.type("html").send(page({
    title: `${company.name} — ${rubric.name}`,
    h1: company.name,
    breadcrumbs: [HOME, { label: "Организации", href: "/rubrics/" }, { label: rubric.name, href: `/rubrics/${rubric.slug}/` }, { label: company.name }],
    body,
  }));
});

// ------------------------------------------------------------------- /routes/
router.get("/routes/", (req, res) => {
  const body = itemList(Object.keys(routesDir.ROUTE_TABLES).map((t) => ({
    href: `/routes/${t}/`, label: routesDir.TYPE_LABELS[t], count: routesDir.listRoutes(t).length,
  })));
  res.type("html").send(page({
    title: "Маршруты общественного транспорта — Карта Софии",
    h1: "Маршруты транспорта",
    breadcrumbs: [HOME, { label: "Маршруты" }],
    body,
  }));
});

router.get("/routes/:type([^./]+)/", (req, res) => {
  const { type } = req.params;
  if (!routesDir.ROUTE_TABLES[type]) return notFound(res, "Тип маршрута");
  const list = routesDir.listRoutes(type);
  const body = itemList(list.map((r) => ({ href: `/routes/${type}/${r.slug}.html`, label: r.label, count: null })));
  res.type("html").send(page({
    title: `${routesDir.TYPE_LABELS[type]} — маршруты Софии`,
    h1: routesDir.TYPE_LABELS[type],
    breadcrumbs: [HOME, { label: "Маршруты", href: "/routes/" }, { label: routesDir.TYPE_LABELS[type] }],
    body,
  }));
});

router.get("/routes/:type/:routeSlug.html", (req, res) => {
  const { type } = req.params;
  if (!routesDir.ROUTE_TABLES[type]) return notFound(res, "Тип маршрута");
  const route = routesDir.getRouteBySlug(type, req.params.routeSlug);
  if (!route) return notFound(res, "Маршрут");
  const stopsList = routesDir.getRouteStops(type, route.id);

  const body = `
    <p class="meta">${[route.from_name, route.to_name].filter(Boolean).join(" → ") || ""}</p>
    <h2>Остановки (${stopsList.length})</h2>
    ${itemList(stopsList.map((s, i) => {
      // Stops with no name are excluded from the /stops/ directory
      // entirely (stopsDirectory.js's getType — nothing to link to or
      // show on its own page), so such a stop appears here as plain,
      // unlinked text rather than a broken href.
      const stopEntry = s.stop_type ? stops.getStopById(s.stop_type, s.id) : null;
      return {
        href: stopEntry ? `/stops/${s.stop_type}/${stopEntry.slug}.html` : null,
        label: `${i + 1}. ${s.name || "(без названия)"}`,
        count: null,
      };
    }))}
  `;
  res.type("html").send(page({
    title: `${route.label} — ${routesDir.TYPE_LABELS[type]}`,
    h1: route.label,
    breadcrumbs: [HOME, { label: "Маршруты", href: "/routes/" }, { label: routesDir.TYPE_LABELS[type], href: `/routes/${type}/` }, { label: route.label }],
    body,
  }));
});

// -------------------------------------------------------------------- /stops/
router.get("/stops/", (req, res) => {
  const body = itemList(Object.keys(stops.TYPE_LABELS).map((t) => ({
    href: `/stops/${t}/`, label: stops.TYPE_LABELS[t], count: stops.getType(t).stops.length,
  })));
  res.type("html").send(page({
    title: "Остановки и станции — Карта Софии",
    h1: "Остановки и станции",
    breadcrumbs: [HOME, { label: "Остановки" }],
    body,
  }));
});

router.get("/stops/:type([^./]+)/", (req, res) => {
  const { type } = req.params;
  const t = stops.getType(type);
  if (!t) return notFound(res, "Тип остановки");

  let body;
  if (t.alpha) {
    body = `<p class="meta">Всего: ${t.stops.length}</p>${letterNav(t.alpha.summary, { hrefFor: (slug) => `/stops/${type}/${slug}/` })}`;
  } else {
    body = itemList(t.stops.map((s) => ({ href: `/stops/${type}/${s.slug}.html`, label: s.name, count: null })));
  }
  res.type("html").send(page({
    title: `${stops.TYPE_LABELS[type]} — Карта Софии`,
    h1: stops.TYPE_LABELS[type],
    breadcrumbs: [HOME, { label: "Остановки", href: "/stops/" }, { label: stops.TYPE_LABELS[type] }],
    body,
  }));
});

router.get("/stops/:type([^./]+)/:letterSlug([^./]+)/", (req, res) => {
  const { type } = req.params;
  const t = stops.getType(type);
  if (!t || !t.alpha) return notFound(res, "Тип остановки");
  const letterPage = t.alpha.letterPages.get(req.params.letterSlug);
  if (!letterPage) return notFound(res, "Буква");

  let body = letterNav(t.alpha.summary, { activeSlug: req.params.letterSlug, hrefFor: (slug) => `/stops/${type}/${slug}/` });
  body += `<p class="meta">Буква «${letterPage.letter}»: ${letterPage.count}</p>`;
  if (letterPage.subgroups) {
    body += itemList(letterPage.subgroups.map((sg) => ({ href: `/stops/${type}/${req.params.letterSlug}/${sg.slug}/`, label: sg.label, count: sg.entries.length })));
  } else {
    body += itemList(letterPage.entries.map((s) => ({ href: `/stops/${type}/${s.slug}.html`, label: s.name, count: null })));
  }
  res.type("html").send(page({
    title: `${stops.TYPE_LABELS[type]} на букву «${letterPage.letter}»`,
    h1: `${stops.TYPE_LABELS[type]}: буква «${letterPage.letter}»`,
    breadcrumbs: [HOME, { label: "Остановки", href: "/stops/" }, { label: stops.TYPE_LABELS[type], href: `/stops/${type}/` }, { label: letterPage.letter }],
    body,
  }));
});

router.get("/stops/:type([^./]+)/:letterSlug([^./]+)/:subgroupSlug([^./]+)/", (req, res) => {
  const { type } = req.params;
  const t = stops.getType(type);
  if (!t || !t.alpha) return notFound(res, "Тип остановки");
  const key = `${req.params.letterSlug}/${req.params.subgroupSlug}`;
  const sg = t.alpha.subgroupPages.get(key);
  if (!sg) return notFound(res, "Группа");

  let body = letterNav(t.alpha.summary, { activeSlug: req.params.letterSlug, hrefFor: (slug) => `/stops/${type}/${slug}/` });
  body += `<div class="subgroup-nav">
    <span>${sg.prevSlug ? `<a href="/stops/${type}/${sg.letterSlug}/${sg.prevSlug}/">← ${sg.prevLabel}</a>` : ""}</span>
    <span>${sg.nextSlug ? `<a href="/stops/${type}/${sg.letterSlug}/${sg.nextSlug}/">${sg.nextLabel} →</a>` : ""}</span>
  </div>`;
  body += `<p class="meta">Группа «${sg.label}»: ${sg.count}</p>`;
  body += itemList(sg.entries.map((s) => ({ href: `/stops/${type}/${s.slug}.html`, label: s.name, count: null })));

  res.type("html").send(page({
    title: `${stops.TYPE_LABELS[type]}: ${sg.label}`,
    h1: `${stops.TYPE_LABELS[type]}: ${sg.label}`,
    breadcrumbs: [HOME, { label: "Остановки", href: "/stops/" }, { label: stops.TYPE_LABELS[type], href: `/stops/${type}/` }, { label: sg.letter, href: `/stops/${type}/${sg.letterSlug}/` }, { label: sg.label }],
    body,
  }));
});

// The stop page — house-page-template.md §9's stop-page adaptation
// (2026-09-07): "Основное" (type + network — both already on the row,
// never shown), the existing "Маршруты через эту остановку" list is left
// as-is, plus two new blocks reusing the exact same patterns as the house
// page: "Организации рядом" (orgMatch.js#findNearbyOrganizations — plain
// proximity, since a stop isn't a building with its own address to match
// against) and "Инфраструктура рядом" (rubricsDirectory.js#
// getNearbyByRubric, the same rubric grid the house page already uses).
router.get("/stops/:type/:stopSlug.html", (req, res) => {
  const { type } = req.params;
  if (!stops.TYPE_LABELS[type]) return notFound(res, "Тип остановки");
  const stop = stops.getStopBySlug(type, req.params.stopSlug);
  if (!stop) return notFound(res, "Остановка");
  const routesThrough = stops.getRoutesForStop(stop.id);
  const nearbyOrgs = orgMatch.findNearbyOrganizations({ lat: stop.lat, lon: stop.lon });
  const infra = rubrics.getNearbyByRubric(stop.lat, stop.lon);

  const mainBlock = `
    <h2 id="main">Основное</h2>
    <p class="meta">${esc(stops.TYPE_LABELS[type])}${stop.network ? ` · ${esc(stop.network)}` : ""}</p>
    ${mapLink(stop.name, "stops")}
  `;

  const routesBlock = `
    <h2 id="routes">Маршруты через эту остановку (${routesThrough.length})</h2>
    ${itemList(routesThrough.map((r) => ({ href: `/routes/${r.route_type}/`, label: `${routesDir.TYPE_LABELS[r.route_type] || r.route_type} ${r.ref || ""} ${r.route_name || ""}`.trim(), count: null })))}
  `;

  const nearbyBlock = nearbyOrgs.length ? `
    <h2 id="nearby">Организации рядом</h2>
    ${itemList(nearbyOrgs.map((o) => ({ href: o.href, label: o.name, count: `${o.distanceM} м` })))}
  ` : "";

  const infraBlock = infra.length ? `
    <h2 id="infra">Инфраструктура рядом</h2>
    <ul class="type-filter">${infra.map((r) => `<li><a href="/rubrics/${r.slug}/?near=${stop.lat},${stop.lon}">${esc(r.name)} (${r.nearbyCount})</a></li>`).join("")}</ul>
  ` : "";

  const anchors = [{ href: "#main", label: "Основное" }, { href: "#routes", label: "Маршруты" }];
  if (nearbyBlock) anchors.push({ href: "#nearby", label: "Организации рядом" });
  if (infraBlock) anchors.push({ href: "#infra", label: "Инфраструктура" });
  const anchorNav = `<p class="meta">${anchors.map((a) => `<a href="${a.href}">${esc(a.label)}</a>`).join(" · ")}</p>`;

  const seoFacts = [];
  if (routesThrough.length) seoFacts.push(`${routesThrough.length} маршрут${routesThrough.length === 1 ? "" : "ов"} общественного транспорта`);
  if (nearbyOrgs.length) seoFacts.push(`${nearbyOrgs.length} организаци${nearbyOrgs.length === 1 ? "я" : "й"} поблизости`);
  const seoParagraph = seoFacts.length ? `<p>${esc(stop.name)} (${esc(stops.TYPE_LABELS[type])}) — ${seoFacts.join(", ")}.</p>` : "";

  const body = `
    ${seoParagraph}
    ${anchorNav}
    ${mainBlock}
    ${routesBlock}
    ${nearbyBlock}
    ${infraBlock}
  `;
  res.type("html").send(page({
    title: `${stop.name} — ${stops.TYPE_LABELS[type]}`,
    h1: stop.name,
    breadcrumbs: [HOME, { label: "Остановки", href: "/stops/" }, { label: stops.TYPE_LABELS[type], href: `/stops/${type}/` }, { label: stop.name }],
    body,
  }));
});

// -------------------------------------------------------- /districts/ /settlements/
function areasHub(kind, title) {
  return (req, res) => {
    const items = areas.getAll(kind);
    const body = itemList(items.map((d) => ({ href: `/${kind}/${d.slug}.html`, label: d.name, count: null })));
    res.type("html").send(page({
      title: `${title} — Карта Софии`,
      h1: title,
      breadcrumbs: [HOME, { label: title }],
      body,
    }));
  };
}
function areaDetail(kind, title) {
  return (req, res) => {
    const item = areas.getBySlug(kind, req.params.slug);
    if (!item) return notFound(res, title);
    const body = mapLink(item.name, kind === "districts" ? "areas" : "cities");
    res.type("html").send(page({
      title: `${item.name} — ${title}`,
      h1: item.name,
      breadcrumbs: [HOME, { label: title, href: `/${kind}/` }, { label: item.name }],
      body,
    }));
  };
}
router.get("/districts/", areasHub("districts", "Районы"));
router.get("/districts/:slug.html", areaDetail("districts", "Районы"));
router.get("/settlements/", areasHub("settlements", "Населённые пункты"));
router.get("/settlements/:slug.html", areaDetail("settlements", "Населённые пункты"));

// -------------------------------------------------------------- /indexes/
// Собственная ветка по почтовым индексам (Находка №11): главная → группа
// (первые 2 цифры) → сам индекс → улица → готовая карточка дома. Той же
// формы, что и остальной справочник (itemList/крошки/буквенная нав.), но
// на своих данных (lib/postcodesDirectory.js).
const INDEXES = { label: "Почтовые индексы", href: "/indexes/" };

router.get("/indexes/", (req, res) => {
  const { prefixes } = postcodes.get();
  const items = [...prefixes.values()]
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
    .map((p) => ({ href: `/indexes/${p.prefix}/`, label: `${p.prefix}00–${p.prefix}99`, count: `${p.codes.length} индексов · ${p.total} домов` }));
  const body = `
    <p class="meta">
      Здесь собраны все почтовые индексы, которые нам удалось определить для домов Софии — как напрямую по
      официальному реестру Български пощи, так и вычисленные нами там, где реестр не даёт точного диапазона номеров.
      У каждого дома на карточке видно, откуда взят именно его индекс — см. <a href="/o-dannyh/">страницу о данных</a>.
    </p>
    ${itemList(items)}
  `;
  res.type("html").send(page({
    title: "Почтовые индексы — Карта Софии",
    h1: "Почтовые индексы",
    breadcrumbs: [HOME, { label: "Почтовые индексы" }],
    body,
  }));
});

router.get("/indexes/:prefix([0-9]{2})/", (req, res) => {
  const { prefixes } = postcodes.get();
  const p = prefixes.get(req.params.prefix);
  if (!p) return notFound(res, "Группа индексов");
  const items = p.codes
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((c) => ({ href: `/indexes/${c.code}/`, label: c.code, count: `${c.count} домов` }));
  const body = itemList(items);
  res.type("html").send(page({
    title: `${p.prefix}00–${p.prefix}99 — Почтовые индексы`,
    h1: `Индексы ${p.prefix}00–${p.prefix}99`,
    breadcrumbs: [HOME, INDEXES, { label: `${p.prefix}00–${p.prefix}99` }],
    body,
  }));
});

router.get("/indexes/:code([0-9]{4})/", (req, res) => {
  const code = req.params.code;
  const streetList = postcodes.getStreetsForCode(code);
  if (!streetList) return notFound(res, "Индекс");
  const prefix = code.slice(0, 2);
  const items = streetList.map((s) => ({
    href: `/indexes/${code}/${s.slug}/`,
    label: s.otherCodes.length
      ? `${s.name} <span class="meta" style="opacity:.65">(есть и в других индексах: ${s.otherCodes.join(", ")})</span>`
      : s.name,
    count: `${s.count} домов`,
  }));
  const body = `
    <p class="meta">
      ${streetList.some((s) => s.otherCodes.length)
        ? "У части этих улиц есть дома и под другими индексами — это не ошибка: длинная улица или бульвар может " +
          "физически пересекать несколько почтовых зон. Такая улица отмечена ниже и ведёт на разбор конкретного случая."
        : "Все дома, для которых определён этот почтовый индекс, сгруппированы здесь по улице."}
    </p>
    ${itemList(items)}
  `;
  res.type("html").send(page({
    title: `Индекс ${code} — улицы`,
    h1: `Индекс ${code}`,
    breadcrumbs: [HOME, INDEXES, { label: `${prefix}00–${prefix}99`, href: `/indexes/${prefix}/` }, { label: code }],
    body,
  }));
});

router.get("/indexes/:code([0-9]{4})/:streetSlug([^./]+)/", (req, res) => {
  const code = req.params.code;
  const result = postcodes.getHousesForCodeAndStreet(code, req.params.streetSlug);
  if (!result) return notFound(res, "Улица в этом индексе");
  const prefix = code.slice(0, 2);
  const items = result.houses.map((h) => ({
    href: `/streets/${h.streetSlug}/dom-${h.houseSlug}.html`,
    label: h.displayName,
    count: null,
  }));
  const otherCodesNote = result.otherCodes.length
    ? `<p class="meta street-collision-note">ℹ У улицы «${esc(result.streetName)}» есть дома и под другим${result.otherCodes.length > 1 ? "ими" : "им"} индекс${result.otherCodes.length > 1 ? "ами" : "ом"}: ${result.otherCodes
        .map((c) => `<a href="/indexes/${esc(c)}/">${esc(c)}</a>`)
        .join(", ")}. Это нормально для длинных улиц/бульваров на границе почтовых зон.</p>`
    : "";
  const body = `
    ${otherCodesNote}
    ${itemList(items)}
    ${result.unresolvedCount ? `<p class="meta">Ещё ${result.unresolvedCount} дом(ов) с этим индексом не удалось однозначно связать с карточкой — техническое ограничение сопоставления, не потеря данных.</p>` : ""}
  `;
  res.type("html").send(page({
    title: `${result.streetName} — индекс ${code}`,
    h1: `${result.streetName}, индекс ${code}`,
    breadcrumbs: [HOME, INDEXES, { label: `${prefix}00–${prefix}99`, href: `/indexes/${prefix}/` }, { label: code, href: `/indexes/${code}/` }, { label: result.streetName }],
    body,
  }));
});

// ------------------------------------------------------------- /o-dannyh/
// Служебная, закрытая от индексации страница (Находка №11, по прямой
// просьбе пользователя): таблица первоисточников проекта + честный разбор
// нюансов вроде конфликта индексов на бул. "Свети Климент Охридски" —
// то, на что ссылаются короткие пометки под индексом/названием улицы на
// карточке дома, вынесенное в одно место вместо повторения текста на
// тысячах страниц. Никогда не должна попадать в поиск сама по себе — see
// htmlPage.js `noindex`.
router.get("/o-dannyh/", (req, res) => {
  const rows = Object.values(SOURCES)
    .map((s) => `<tr><td>${esc(s.label)}</td><td>${esc(s.org)}</td><td>${esc(s.detail)}</td><td>${s.url ? `<a href="${esc(s.url)}" rel="nofollow">${esc(s.urlLabel)}</a>` : "—"}</td></tr>`)
    .join("");
  const body = `
    <p class="meta">
      Эта страница не предназначена для поисковых систем — на неё ссылаются короткие пометки под данными на
      карточках домов, чтобы не повторять одно и то же объяснение тысячи раз. Здесь — полный список того,
      откуда взяты данные проекта, и честный разбор случаев, где источники расходятся или где мы вычислили
      значение сами.
    </p>
    <h2>Источники данных</h2>
    <div style="overflow-x:auto"><table class="sources-table">
      <tr><th>Источник</th><th>Организация</th><th>Что именно</th><th>Ссылка</th></tr>
      ${rows}
    </table></div>
    <h2 id="metod-knn">Как мы считаем индекс сами (k ближайших соседей)</h2>
    <p>
      Там, где официальный реестр вообще не содержит диапазона номеров для улицы, индекс соседнего дома с уже
      известным индексом переносится на дом без индекса — но только если 5 ближайших домов с известным индексом
      (в радиусе 300 м) единогласно называют один и тот же индекс. Если хоть один из пяти называет другой —
      мы оставляем индекс пустым, а не гадаем. На проверочных данных (известные индексы, скрытые и предсказанные
      этим же методом заново) точность метода — около 99,1–99,6%.
    </p>
    <h2 id="kliment-ohridski">Разбор случая: бул. «Свети Климент Охридски»</h2>
    <p>
      В Столичной общине это название носят как минимум четыре разных, физически не связанных друг с другом
      дороги: короткая улица в центре (район Средец, индекс 1504), длинный бульвар в студенческом городке
      (район Студентски) и ещё две улицы в присоединённых сёлах на севере (Нови Искър, Кътина). Официальный
      реестр их прекрасно различает по паре «населённый пункт + полное название» — коллизию создаёт только
      наше собственное сопоставление, если оно теряет по пути обозначение «бул.»/«ул.».
    </p>
    <p>
      Для бульвара реестр даёт один индекс без диапазона номеров — 1756. Внешние источники независимо
      подтверждают 1756 для домов №2 и №3. Мы приняли 1756 как основной индекс для всех домов бульвара без
      собственного индекса. Но у 81 дома бульвара, уже определённого нашим собственным расчётом, встречается
      сразу пять разных индексов: 1616, 1700, 1734, 1756 и 1797 — значит, бульвар физически пересекает
      несколько почтовых зон, и точный индекс конкретного дома у другого конца бульвара вполне может отличаться
      от показанного. Если вы знаете точный индекс своего дома на этом бульваре — сообщите нам, поправим.
    </p>
    <h2 id="odnoimennye-ulitsy">Одноимённые улицы — это норма, а не ошибка</h2>
    <p>
      Столична община — это не только сам город, но и десятки бывших сёл, ставших районами и кварталами. У них
      исторически сложились одинаковые, очень «сельские» названия улиц: «Здравец» повторяется как отдельная улица
      в 24 разных, физически не связанных местах, «Еделвайс» — в 19, «Кокиче» и «Люляк» — в 17 и 16. Это не
      дубликат в наших данных, а факт о городе: каждое такое название на карточке дома помечено ссылками на
      остальные места с тем же именем, чтобы было видно, что это тёзка, а не ошибка адреса.
    </p>
    <h2 id="settlement-mismatch">Когда сам реестр не совпадает с нашими границами сёл</h2>
    <p>
      Официальный реестр время от времени называет населённый пункт иначе, чем принято у нас (например «Пасарел»
      вместо официального «Долни Пасарел», «Казичане» вместо «Казичене», «Войняговци» вместо «Войнеговци» — а
      «Световрачане» и «Световрачене» встречаются в самом реестре ОБА варианта написания одновременно, для одного
      и того же села). Для 853 домов это единственная причина, по которой их адрес не находился в реестре напрямую
      — мы вручную проверили и сопоставили каждое такое написание. Карточка каждого такого дома отмечена этой
      причиной в поле «Источник».
    </p>
    <h2>Почему мы вообще об этом рассказываем</h2>
    <p>
      Одинаковые названия улиц в разных частях города, официальные источники, которые сами расходятся друг с
      другом или содержат опечатки в названиях сёл, — обычное дело для любого крупного города, но большинство
      справочников об этом просто умалчивает. Мы решили, что честное объяснение — сильная сторона проекта, а
      не недостаток: там, где мы уверены — говорим прямо; там, где вычислили сами — так и пишем; там, где
      источники спорят между собой — показываем спор, а не одно случайно выбранное число.
    </p>
  `;
  res.type("html").send(page({
    title: "О данных — Карта Софии",
    h1: "О данных проекта",
    breadcrumbs: [HOME, { label: "О данных" }],
    body,
    noindex: true,
  }));
});

// ------------------------------------------------------------ /disclaimer/
// Дисклеймер и /soglashenie/ (Пользовательское соглашение) — набросок
// текста, который пользователь попросил подготовить самому ("2. Сделай
// набросок (после дизайна)"). Это ЧЕРНОВИК: явно помечен как таковой на
// самой странице и НЕ является юридической консультацией — перед публикацией
// его должен проверить юрист. Обе страницы индексируются (в отличие от
// /o-dannyh/) — это реальные пользовательские страницы, а не служебная
// справка.
router.get("/disclaimer/", (req, res) => {
  const body = `
    <div class="legal-page">
      <p class="draft-note">Черновик. Этот текст подготовлен для проекта автоматически и ещё не проверен юристом — рассматривайте его как основу для доработки, а не как готовый юридический документ.</p>
      <p>SofiaMap.com — независимый справочник улиц, домов, организаций и общественного транспорта города София. Данные собраны из открытых государственных реестров, картографических источников (в духе OpenStreetMap) и общедоступных публикаций муниципальных структур; полный перечень источников — на странице <a href="/o-dannyh/">«О данных»</a>.</p>
      <h2>Точность данных</h2>
      <p>Мы стараемся поддерживать данные актуальными и честно отмечаем случаи, где источники расходятся или где значение (например, часть почтовых индексов) вычислено нами самими, а не взято из официального реестра. Тем не менее сайт не гарантирует полноту, точность или актуальность какой-либо информации: адреса, границы районов, расписания и контакты организаций могут измениться быстрее, чем мы успеваем обновить данные.</p>
      <h2>Не официальный источник</h2>
      <p>SofiaMap.com не является органом Столичной общины (Столична община), полиции или иного государственного учреждения и не действует от их имени. Контакты районных администраций и полицейских управлений на карточках домов приведены для удобства и должны сверяться с официальными сайтами соответствующих ведомств перед использованием в важных обращениях.</p>
      <h2>Ограничение ответственности</h2>
      <p>Проект и его авторы не несут ответственности за решения, принятые на основании информации с этого сайта, а также за любые прямые или косвенные убытки, связанные с использованием сайта.</p>
      <h2>Обратная связь</h2>
      <p>Если вы заметили ошибку или неточность в данных — напишите нам через страницу <a href="/obratnaya-svyaz/">«Обратная связь»</a>.</p>
    </div>
  `;
  res.type("html").send(page({
    title: "Дисклеймер — SofiaMap",
    h1: "Дисклеймер",
    breadcrumbs: [HOME, { label: "Дисклеймер" }],
    body,
  }));
});

router.get("/soglashenie/", (req, res) => {
  const body = `
    <div class="legal-page">
      <p class="draft-note">Черновик. Этот текст подготовлен для проекта автоматически и ещё не проверен юристом — рассматривайте его как основу для доработки, а не как готовый юридический документ.</p>
      <p>Используя сайт SofiaMap.com, вы соглашаетесь с условиями, изложенными ниже. Если вы не согласны с каким-либо из условий — пожалуйста, не используйте сайт.</p>
      <h2>Использование сайта</h2>
      <p>Сайт предоставляется «как есть», в справочных целях, бесплатно и без регистрации. Разрешается свободно просматривать страницы, переходить по ссылкам и пользоваться картой и схемой метро в обычном (не автоматизированном) режиме.</p>
      <h2>Что запрещено</h2>
      <p>Запрещается: автоматическое массовое копирование (скрапинг) содержимого сайта без отдельного согласования; попытки нарушить работу сайта или обойти технические ограничения; использование данных сайта способом, вводящим третьих лиц в заблуждение относительно их официального статуса (см. <a href="/disclaimer/">Дисклеймер</a>).</p>
      <h2>Интеллектуальная собственность</h2>
      <p>Тексты, оформление и программный код сайта принадлежат проекту SofiaMap.com, если не указано иное. Первичные данные (адресный реестр, картографическая основа, транспортные маршруты и т.п.) взяты из открытых источников — см. <a href="/o-dannyh/">«О данных»</a> — и используются в соответствии с условиями их первоначального распространения.</p>
      <h2>Изменения условий</h2>
      <p>Мы можем время от времени обновлять это соглашение; дата последнего изменения будет указываться на этой странице после выхода из черновой стадии.</p>
      <h2>Связь с нами</h2>
      <p>По вопросам, связанным с этим соглашением, — страница <a href="/obratnaya-svyaz/">«Обратная связь»</a>.</p>
    </div>
  `;
  res.type("html").send(page({
    title: "Пользовательское соглашение — SofiaMap",
    h1: "Пользовательское соглашение",
    breadcrumbs: [HOME, { label: "Пользовательское соглашение" }],
    body,
  }));
});

// --------------------------------------------------------- /obratnaya-svyaz/
// Контактная страница без формы — разработка формы обратной связи прямо
// отложена пользователем ("1. Откладываем разработку"); футер, однако,
// ссылается на неё уже сейчас (см. htmlPage.js siteFooter()), так что нужен
// хоть какой-то реальный адрес, а не заглушка/404.
router.get("/obratnaya-svyaz/", (req, res) => {
  const body = `
    <div class="legal-page">
      <p>Форма обратной связи на сайте пока в разработке. Если вы нашли ошибку в данных, неточность на карте или хотите что-то предложить — сейчас проще всего написать нам напрямую.</p>
      <p class="meta">Раздел появится на этой странице позже; ошибки в данных также можно уточнить на странице <a href="/o-dannyh/">«О данных»</a> — там указано, откуда взята информация по каждому дому.</p>
    </div>
  `;
  res.type("html").send(page({
    title: "Обратная связь — SofiaMap",
    h1: "Обратная связь",
    breadcrumbs: [HOME, { label: "Обратная связь" }],
    body,
  }));
});

module.exports = router;
