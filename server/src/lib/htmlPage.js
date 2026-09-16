// Minimal shared HTML shell for the whole static directory section
// (/streets/, /rubrics/, /routes/, /stops/, /districts/, /settlements/).
//
// Task requirement #2 ("технология рендера"): this project's only HTML
// today is the SPA's single static web/index.html — there's no templating
// engine anywhere in server/ to reuse. Rather than pull in a template
// engine dependency for what's still a fairly small, fixed set of page
// shapes, this renders strings by hand the same way the JSON API routes
// already build their response objects by hand — just producing HTML
// instead of JSON. If this section grows real content (task explicitly
// scopes that OUT for this pass — see README/task notes), swapping this
// for a real template engine is a contained, one-file change.
const { icon } = require("./icons");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Site-wide chrome (2026-09-08, see claude/site-design-plan.md; redesigned
// 2026-09-09 per the approved design canvas — claude/design-decisions.md):
// header (logo + nav + search) + mobile drawer + footer service menu +
// responsive ad slot, wrapped around every "typical" page's existing
// breadcrumbs/h1/body. /map/ never goes through this file at all (it's
// web/index.html, a separate static SPA document). /metro/ DOES render
// through page() (see pages.js) but is explicitly "нетипичная" per the
// plan — it opts out with `frame: false` so its output is byte-for-byte
// what page() produced before this chrome existed.
const NAV_ITEMS = [
  { label: "Главная", href: "/" },
  { label: "Улицы", href: "/streets/" },
  { label: "Организации", href: "/rubrics/" },
  { label: "Маршруты", href: "/routes/" },
  { label: "Остановки", href: "/stops/" },
  { label: "Официальные районы", href: "/raions/" },
  { label: "Кварталы", href: "/districts/" },
  { label: "Населённые пункты", href: "/settlements/" },
  { label: "Парки", href: "/parks/" },
  { label: "Индексы", href: "/indexes/" },
  { label: "Карта", href: "/map/" },
  { label: "Схема метро", href: "/metro/" },
];

// Every route's breadcrumbs array is [HOME, <section>, ...] (HOME is
// pages.js's own {label:"София", href:"/"} — not redefined here). The
// section's label text is stable across hub pages (no href — it's the
// current page) and deeper pages (has an href) alike, so matching on
// label rather than href works for both without a second parameter
// threaded through ~30 page() call sites. A couple of section labels
// used in breadcrumbs differ from their shorter nav-menu wording
// (e.g. "Почтовые индексы" vs. the menu's "Индексы"), hence this
// explicit table instead of comparing breadcrumbs[1].href directly.
const SECTION_LABEL_TO_NAV_HREF = {
  "Улицы": "/streets/",
  "Организации": "/rubrics/",
  "Маршруты": "/routes/",
  "Остановки": "/stops/",
  "Официальные районы": "/raions/",
  "Кварталы": "/districts/",
  "Населённые пункты": "/settlements/",
  "Парки": "/parks/",
  "Почтовые индексы": "/indexes/",
};

function activeNavHref(breadcrumbs) {
  const section = breadcrumbs && breadcrumbs[1];
  if (!section) return "/"; // no breadcrumbs (home, 404) → "Главная" active
  return SECTION_LABEL_TO_NAV_HREF[section.label] || null;
}

// Visual style (2026-09-08, refreshed 2026-09-09 — see
// claude/design-decisions.md for the full approved rationale): the site's
// own accent color, heading font and (new) body font. The accent itself
// (#3B3FA6) is UNCHANGED from the original pass — it already cleared the
// project's AAA contrast bar (≥8.4:1) on white, and the redesign's own
// decision was to unify EVERY surface (including /map/'s old separate red
// accent) onto this one color rather than mint a new one. Manrope is kept
// for headings; Golos Text is new for body copy, chosen specifically to
// avoid the Inter/Roboto/Arial "generic AI tool" look while still being a
// solid Cyrillic-native webfont.
//
// Color/accent tokens that would change /metro/'s own chrome (legend,
// route form, popups, notes) are scoped to `body.framed` (added only when
// frame:true, see page()) — /metro/ renders through this same page()/
// STYLE with frame:false and its SVG/JS must stay byte-for-byte untouched
// (site-design-plan.md §4.1, §6; decision E20: metro may only change
// *visual style* — fonts/colors — never structure or interactivity). The
// body font and the Google Fonts <link> ARE applied unconditionally,
// deliberately: switching typography is exactly the "visual style" E20
// permits, and metroSchemeRender.js's own STYLE (a separate <style> block,
// see that file) uses `currentColor`/theme-agnostic values throughout, so
// it inherits this body font automatically without needing its own edit
// for every rule — only the handful of E20-approved accent touches below
// were added there directly.
const GOOGLE_FONTS_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&family=Manrope:wght@600;700;800&display=swap" />`;

const STYLE = `
  :root {
    color-scheme: light dark;
    --accent: #3B3FA6; --accent-hover: #2E3389; --accent-tint: #EFEFFB; --accent-tint-2: #E2E2F6;
    --ink: #171923; --ink-soft: #4A4E5C; --muted: #6D7280; --line: #E3E4EC; --line-soft: #EEEFF5;
    --bg: #F7F7FB; --surface: #FFFFFF;
    --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-pill: 999px;
    --shadow-sm: 0 1px 2px rgba(23,25,35,.08);
    --warn-bg: #FFF4E5; --warn-border: #F0BE7D; --warn-ink: #7A4E00;
    --font-head: 'Manrope', system-ui, sans-serif; --font-body: 'Golos Text', system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --accent: #9FA8FF; --accent-hover: #B7BEFF; --accent-tint: #262A42; --accent-tint-2: #2E3350;
      --ink: #EDEDF4; --ink-soft: #C7C9D6; --muted: #9299AE; --line: #33364A; --line-soft: #282B3D;
      --bg: #121319; --surface: #1B1D28;
      --warn-bg: #3A2C10; --warn-border: #6B4E1E; --warn-ink: #F2C879;
    }
  }
  * { box-sizing: border-box; }
  body { font-family: var(--font-body), system-ui, sans-serif; margin: 0; line-height: 1.5; }
  body.framed { background: var(--bg); color: var(--ink); }
  body.framed a { color: var(--accent); }
  body.framed h1, body.framed h2, .site-name, .brand .word, .site-nav a { font-family: var(--font-head), system-ui, sans-serif; }
  nav.crumbs { font-size: 0.88em; color: var(--muted); margin-bottom: 14px; }
  nav.crumbs a { color: inherit; }
  nav.crumbs span.sep { margin: 0 0.35em; opacity: 0.7; }
  nav.crumbs span[aria-current] { color: var(--ink); font-weight: 600; }
  h1 { font-size: 1.6em; font-weight: 800; letter-spacing: -0.01em; margin: 0 0 0.3em; }
  .meta { color: var(--muted); font-size: 0.92em; margin-bottom: 1.1em; }
  .letters { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 20px; padding: 0; list-style: none; }
  .letters a, .letters span.disabled { display: inline-flex; align-items: center; justify-content: center; min-width: 1.9em; height: 1.9em; text-align: center; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-sm); text-decoration: none; font-weight: 700; font-size: 0.9em; color: var(--ink-soft); background: var(--surface); }
  .letters a[aria-current] { background: var(--accent); border-color: var(--accent); color: #fff; }
  .letters span.disabled { opacity: 0.4; border-style: dashed; background: transparent; }
  .type-filter { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; padding: 0; list-style: none; }
  .type-filter a, .type-filter span.active { padding: 4px 12px; border-radius: var(--r-pill); border: 1px solid var(--line); text-decoration: none; font-size: 0.88em; color: var(--ink-soft); background: var(--surface); }
  .type-filter a:hover { border-color: var(--accent); color: var(--accent); }
  .type-filter span.active { font-weight: 700; border-color: var(--accent); background: var(--accent-tint); color: var(--accent); }
  ul.item-list { list-style: none; padding: 0; margin: 0 0 1.2em; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; }
  ul.item-list li { padding: 12px 16px; border-top: 1px solid var(--line-soft); display: flex; justify-content: space-between; align-items: center; gap: 1em; }
  ul.item-list li:first-child { border-top: none; }
  ul.item-list li:hover { background: var(--bg); }
  ul.item-list a { font-weight: 600; }
  ul.item-list .count { color: var(--muted); font-size: 0.88em; white-space: nowrap; }
  .subgroup-nav { display: flex; justify-content: space-between; margin: 1em 0; font-size: 0.92em; color: var(--muted); }
  .pagination { display: flex; flex-wrap: wrap; gap: 6px; margin: 1.2em 0; }
  .pagination a, .pagination span.current { display: inline-flex; align-items: center; justify-content: center; min-width: 2em; height: 2em; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-sm); text-decoration: none; font-weight: 700; font-size: 0.88em; color: var(--ink-soft); background: var(--surface); }
  .pagination span.current { background: var(--accent); border-color: var(--accent); color: #fff; }
  .map-link { display: inline-flex; align-items: center; gap: 6px; margin: 0.5em 0 1.2em; font-weight: 600; }
  .map-cta { display: flex; flex-wrap: wrap; gap: 10px; margin: 0.6em 0 1.6em; }
  .map-cta .map-link { padding: 10px 18px; border-radius: var(--r-md); border: 1px solid var(--line); background: var(--surface); box-shadow: var(--shadow-sm); margin: 0; text-decoration: none; }
  footer.back { margin-top: 2em; font-size: 0.9em; }
  ul.stop-list { list-style: none; padding: 0; margin: 0 0 1.2em; }
  ul.stop-list li { padding: 7px 0; border-bottom: 1px solid var(--line-soft); }
  ul.stop-list .stop-head { display: flex; justify-content: space-between; gap: 1em; }
  ul.stop-list .stop-head .count { color: var(--muted); font-size: 0.9em; white-space: nowrap; }
  .stop-routes-label { color: var(--muted); font-size: 0.85em; margin: 6px 0 3px; }
  /* 2026-09-09 fix: route ref + "до метро..." explanation used to be one
     long <a> pill (reported: "номер маршрута нужно делать единым стилем,
     не нужно в чипс включать пояснение") — now the ref is a small, uniform
     badge (fixed look regardless of text length) and the explanation is
     plain text next to it, not part of the clickable chip. */
  ul.stop-routes { display: flex; flex-wrap: wrap; align-items: center; row-gap: 6px; column-gap: 6px; margin: 0 0 8px; padding: 0; list-style: none; }
  ul.stop-routes li { display: flex; align-items: center; gap: 7px; }
  ul.stop-routes a.route-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 2.1em; height: 1.9em; padding: 0 8px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--surface); text-decoration: none; font-size: 0.85em; font-weight: 700; color: var(--ink); }
  ul.stop-routes a.route-badge:hover { border-color: var(--accent); color: var(--accent); }
  ul.stop-routes .route-note { color: var(--muted); font-size: 0.85em; }
  .postcode-note { font-size: 0.9em; margin: -0.4em 0 1em; padding: 8px 12px; border-radius: var(--r-md); background: var(--accent-tint); }
  .postcode-note--disputed { background: var(--warn-bg); border: 1px solid var(--warn-border); border-radius: var(--r-md); padding: 10px 14px; color: var(--warn-ink); }
  .postcode-note--disputed .postcode-note__title { font-weight: 700; margin: 0 0 0.4em; }
  .postcode-note--disputed p { margin: 0.5em 0; }
  .postcode-note__extra { opacity: 0.9; }
  .street-collision-note { background: var(--accent-tint); border-radius: var(--r-md); padding: 8px 12px; }
  ul.item-list li.has-variants { flex-direction: column; align-items: flex-start; gap: 0.4em; }
  .house-variants-note { font-size: 0.85em; color: var(--muted); background: var(--accent-tint); border-radius: var(--r-md); padding: 6px 10px; }
  .house-variants-note a { font-weight: 600; }
  p.house-variants-note { margin: -0.4em 0 1em; }
  table.sources-table { border-collapse: collapse; width: 100%; margin: 1em 0 2em; font-size: 0.92em; }
  table.sources-table th, table.sources-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }

  /* ---------------------------------------------------------- card blocks
     Used by the address/house page (and available to any other page that
     wants the same "titled card with an icon" shape). */
  .seo-block { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 16px 18px; margin: 0 0 20px; box-shadow: var(--shadow-sm); }
  .seo-block p { margin: 0 0 12px; color: var(--ink-soft); }
  .seo-block p:last-child { margin-bottom: 0; }
  .anchor-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .anchor-tabs a { display: inline-block; padding: 5px 13px; border-radius: var(--r-pill); background: var(--accent-tint); color: var(--accent); font-weight: 700; font-size: 0.85em; text-decoration: none; }
  .anchor-tabs a:hover { background: var(--accent-tint-2); }
  .block { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 18px 20px; margin: 0 0 18px; scroll-margin-top: 90px; }
  .block-head { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; }
  .block-head .block-icon { width: 34px; height: 34px; border-radius: var(--r-md); background: var(--accent-tint); color: var(--accent); display: flex; align-items: center; justify-content: center; flex: none; }
  .block-head h2 { font-size: 1.05em; margin: 0; }
  .block > *:last-child { margin-bottom: 0 !important; }

  /* ---------------------------------------------------------- mini-map
     Live map widget embedded on any page that has a precise geo point
     (address/house pages today; any other geo page can reuse it — see
     miniMapWidget()/mapAssetsHead()/mapAssetsScripts()). */
  .mini-map-widget { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; margin: 0 0 18px; }
  .mini-map-widget .mini-map { height: 220px; width: 100%; background: var(--line-soft); }
  .mini-map-widget .mini-map-foot { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; font-size: 0.88em; }
  .mini-map-widget .mini-map-expand { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; }
  .mini-map .maplibregl-ctrl { display: none; } /* preview map: no controls, tap → expand */

  /* ---------------------------------------------------------- home page
     Hero (lead text + stat numbers + two primary CTA buttons) and the
     section-card grid that replace the old flat itemList() of 7 equal
     rows (2026-09-15 redesign — "сейчас она очень слаба и скучна", see
     claude/next-steps-homepage-design.md). No map preview here by
     decision — mini-map.js's widget is built for one street-level point
     (fixed zoom 15.5, non-interactive), not a city overview, so a live
     MapLibre instance would be unwarranted weight on the crawlable entry
     page; plain accent-styled buttons instead. Streets/Organizations get
     the --lg card treatment (most content, most likely entry points);
     the rest are --sm but keep the same icon+title+description+count
     shape (every card gets a one-line description, not just the big
     two). */
  .home-hero { background: linear-gradient(135deg, var(--accent-tint), var(--surface) 65%); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 28px 30px 26px; margin: 0 0 26px; box-shadow: var(--shadow-sm); }
  .home-hero__lead { font-size: 1.08em; color: var(--ink-soft); margin: 0 0 20px; max-width: 640px; }
  .home-stats { display: flex; flex-wrap: wrap; gap: 26px; list-style: none; margin: 0 0 22px; padding: 0; }
  .home-stats li { display: flex; flex-direction: column; gap: 1px; }
  .home-stats strong { font-family: var(--font-head), system-ui, sans-serif; font-size: 1.5em; font-weight: 800; color: var(--ink); line-height: 1.1; }
  .home-stats span { font-size: 0.82em; color: var(--muted); }
  .home-hero__actions { display: flex; flex-wrap: wrap; gap: 12px; }
  /* Compound .home-cta.home-cta--primary selectors (not two separate
     rules) deliberately, not just style — the body.framed a { color } rule
     above outranks a single-class selector on specificity (2 elements
     beat a 1-class/1-class tie), which silently made this button's own
     color:#fff lose to the global accent-colored-link rule: same hex as
     the button's own background, so the label was invisible (caught
     visually in a rendered screenshot, not by reading the CSS). */
  .home-cta { display: inline-flex; align-items: center; gap: 8px; padding: 13px 22px; border-radius: var(--r-md); font-weight: 700; font-size: 0.95em; text-decoration: none; }
  .home-cta.home-cta--primary { background: var(--accent); color: #fff; box-shadow: var(--shadow-sm); }
  .home-cta.home-cta--primary:hover { background: var(--accent-hover); }
  .home-cta.home-cta--secondary { background: var(--surface); color: var(--accent); border: 1.5px solid var(--accent); }
  .home-cta.home-cta--secondary:hover { background: var(--accent-tint); }
  .home-sections-title { font-size: 1.15em; font-weight: 800; margin: 0 0 14px; }
  .home-grid-lg { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 0 0 16px; }
  .home-grid-sm { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin: 0 0 20px; }
  .home-card { display: flex; gap: 14px; align-items: flex-start; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 18px 20px; text-decoration: none; color: inherit; box-shadow: var(--shadow-sm); transition: border-color 0.15s ease; }
  .home-card:hover { border-color: var(--accent); }
  .home-card__icon { border-radius: var(--r-md); background: var(--accent-tint); color: var(--accent); display: flex; align-items: center; justify-content: center; flex: none; }
  .home-card__body { display: flex; flex-direction: column; min-width: 0; }
  .home-card__title { font-family: var(--font-head), system-ui, sans-serif; font-weight: 800; color: var(--ink); margin-bottom: 2px; }
  .home-card__desc { color: var(--ink-soft); font-size: 0.86em; margin-bottom: 10px; }
  .home-card__count { display: inline-flex; align-self: flex-start; padding: 3px 11px; border-radius: var(--r-pill); background: var(--accent-tint); color: var(--accent); font-weight: 700; font-size: 0.82em; white-space: nowrap; }
  .home-card--lg { padding: 24px 26px; }
  .home-card--lg .home-card__icon { width: 54px; height: 54px; }
  .home-card--lg .home-card__title { font-size: 1.22em; }
  .home-card--sm .home-card__icon { width: 38px; height: 38px; }
  .home-card--sm .home-card__title { font-size: 1em; }
  @media (max-width: 640px) {
    .home-hero { padding: 22px 20px; }
    .home-grid-lg { grid-template-columns: 1fr; }
    .home-cta { flex: 1 1 auto; justify-content: center; }
  }

  /* -------------------------------------------------------------- chrome
     Bare pages (frame: false, e.g. /metro/) never emit any of the markup
     these rules target, so none of this affects them. */
  .site-header { position: sticky; top: 0; z-index: 30; background: var(--surface); border-bottom: 1px solid var(--line); }
  /* 2026-09-09 fix: the header used to share .layout's 1360px reading-
     width cap, but logo + all 10 nav items + a real search box need more
     room than that — capped at 1360px the nav ALWAYS wrapped onto a second
     line on every desktop width, never actually reaching the hamburger
     breakpoint below (reported: "не должно быть двух этажей меню"). The
     header is chrome, not reading content, so it gets its own wider cap;
     .layout/.footer-inner keep 1360px. */
  .header-inner { max-width: 1600px; margin: 0 auto; min-height: 64px; display: flex; align-items: center; gap: 22px; padding: 10px 20px; }
  .brand { display: flex; align-items: center; gap: 9px; flex: none; text-decoration: none; }
  .brand .mark { width: 30px; height: 30px; border-radius: var(--r-sm); background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; flex: none; }
  .brand .word { font-weight: 800; font-size: 18px; color: var(--ink); white-space: nowrap; }
  .brand .word em { color: var(--accent); font-style: normal; }
  .site-nav ul { display: flex; flex-wrap: nowrap; list-style: none; margin: 0; padding: 0; gap: 2px; } /* never wraps — hidden behind the hamburger below the breakpoint instead (see "не должно быть двух этажей меню") */
  .site-nav a { font-size: 13.5px; font-weight: 700; color: var(--ink-soft); padding: 8px 11px; border-radius: var(--r-sm); text-decoration: none; white-space: nowrap; }
  .site-nav a:hover { background: var(--bg); }
  .site-nav a.active { color: var(--accent); background: var(--accent-tint); }
  .header-search { margin-left: auto; flex: 0 1 240px; display: flex; align-items: center; gap: 8px; background: var(--bg); border: 1.5px solid var(--line); border-radius: var(--r-pill); padding: 8px 14px; color: var(--muted); }
  .header-search input { border: none; background: none; outline: none; font-size: 13.5px; width: 100%; font-family: var(--font-body); color: var(--ink); }
  .nav-toggle { display: none; margin-left: auto; flex: none; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; }
  @media (min-width: 1501px) { .site-drawer { display: none !important; } } /* drawer only ever exists ≤1500px — see the nav-collapse breakpoint below */

  .layout { display: flex; align-items: flex-start; gap: 32px; max-width: 1360px; margin: 0 auto; padding: 24px 20px 60px; }
  .ad-rail { flex: 0 0 300px; width: 300px; }
  main { flex: 1 1 auto; min-width: 0; max-width: 860px; }
  .ad-slot { background: var(--surface); border: 1px dashed var(--line); border-radius: var(--r-md); padding: 14px; text-align: center; color: var(--muted); font-size: 12px; }
  .ad-slot__box { height: 250px; border-radius: 8px; background: var(--bg); display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 12px; }
  .ad-slot-mobile { display: none; margin: 0 0 20px; }

  .site-footer { background: var(--ink); color: rgba(255,255,255,.85); margin-top: 24px; }
  .site-footer .footer-inner { max-width: 1360px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 24px 20px; }
  .footer-brand { font-family: var(--font-head), system-ui, sans-serif; font-weight: 800; font-size: 15px; color: #fff; }
  .footer-brand em { color: #9FA3E8; font-style: normal; }
  .site-footer nav ul, .site-footer nav { display: flex; gap: 18px; margin: 0; padding: 0; list-style: none; flex-wrap: wrap; }
  .site-footer a { color: rgba(255,255,255,.78); font-size: 13px; text-decoration: none; }
  .site-footer a:hover { color: #fff; }
  .legal-page p { color: var(--ink-soft); }
  .legal-page .draft-note { background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-ink); border-radius: var(--r-md); padding: 10px 14px; font-size: 0.9em; margin-bottom: 1.4em; }

  /* Nav-collapse breakpoint (2026-09-09, replaces the old 900px one):
     logo + all 10 nav items + a real search box measure ~1443px wide at
     minimum (measured directly — see harness/measure-nav2.js) — well
     above where the old 900px threshold assumed they'd fit, which is
     exactly why the nav used to wrap onto a second line on every desktop
     width instead of ever reaching a hamburger (reported: "не должно быть
     двух этажей меню"; .site-nav ul above is also flex-wrap: nowrap now
     for the same reason — it should never wrap, only hide). 1500px
     leaves ~55px of margin over that minimum. Deliberately a SEPARATE
     breakpoint from the ≤900px content-layout one below — the two-column
     body layout has its own, unrelated width requirement (ad-rail +
     860px main), so a narrow-laptop/tablet width can legitimately show
     the desktop two-column body with a collapsed (hamburger) header. */
  @media (max-width: 1500px) {
    .site-nav, .header-search { display: none; }
    .nav-toggle { display: inline-flex; }
    .site-drawer { position: fixed; inset: 64px 0 0 0; z-index: 29; background: var(--surface); overflow-y: auto; padding: 16px 20px 32px; border-top: 1px solid var(--line); }
    .site-drawer[hidden] { display: none; }
    .site-drawer nav ul { list-style: none; margin: 0 0 18px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .site-drawer nav a { display: block; padding: 12px 10px; border-radius: var(--r-sm); text-decoration: none; color: var(--ink); font-weight: 700; }
    .site-drawer nav a.active { color: var(--accent); background: var(--accent-tint); }
    .drawer-search { display: flex; gap: 8px; background: var(--bg); border: 1.5px solid var(--line); border-radius: var(--r-pill); padding: 6px 6px 6px 16px; }
    .drawer-search input { flex: 1 1 auto; border: none; background: none; outline: none; font-size: 15px; font-family: var(--font-body); color: var(--ink); }
    .drawer-search button { border: none; background: var(--accent); color: #fff; width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: none; }
  }

  /* Content-layout breakpoint — unrelated to the header, unchanged at
     900px: below this the ad-rail sidebar no longer fits next to an
     860px-max main column, so the page stacks to one column and the ad
     slot moves inline under the title instead (decision B10). */
  @media (max-width: 900px) {
    .layout { flex-direction: column; padding: 16px 16px 40px; }
    .ad-rail { display: none; }
    .ad-slot-mobile { display: block; }
    main { max-width: none; }
  }
`;

function crumbs(items) {
  const parts = items.map((it, i) => {
    const isLast = i === items.length - 1;
    return isLast || !it.href
      ? `<span aria-current="page">${esc(it.label)}</span>`
      : `<a href="${esc(it.href)}">${esc(it.label)}</a>`;
  });
  return `<nav class="crumbs">${parts.join('<span class="sep">›</span>')}</nav>`;
}

function navLinks(activeHref) {
  return NAV_ITEMS.map((it) => {
    const isActive = it.href === activeHref;
    return `<li><a href="${esc(it.href)}"${isActive ? ' class="active" aria-current="page"' : ""}>${esc(it.label)}</a></li>`;
  }).join("");
}

function siteHeader(activeHref) {
  const links = navLinks(activeHref);
  // Search box: a plain GET form to /map/ with name="q" — the map's own
  // bootstrap (web/js/map-search.js) already reads `?q=` on load and runs
  // the search, so this needs zero changes to the map's JS to work; see
  // mapLink() below for the same convention used ~15 places already.
  return `<header class="site-header">
<div class="header-inner">
  <a class="brand" href="/"><span class="mark">${icon("logoMark", 17)}</span><span class="word">Sofia<em>Map</em></span></a>
  <nav class="site-nav" aria-label="Разделы сайта"><ul>${links}</ul></nav>
  <form class="header-search" action="/map/" method="get" role="search">
    <span aria-hidden="true">${icon("search", 15)}</span>
    <input type="text" name="q" placeholder="Поиск по SofiaMap" aria-label="Поиск по SofiaMap" autocomplete="off" />
  </form>
  <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-drawer" aria-label="Открыть меню">
    <span class="i-open">${icon("menu", 20)}</span>
    <span class="i-close" hidden>${icon("close", 20)}</span>
  </button>
</div>
<div class="site-drawer" id="site-drawer" hidden>
  <nav aria-label="Разделы сайта (моб.)"><ul>${links}</ul></nav>
  <form class="drawer-search" action="/map/" method="get" role="search">
    <input type="text" name="q" placeholder="Поиск по SofiaMap" aria-label="Поиск по SofiaMap" autocomplete="off" />
    <button type="submit" aria-label="Найти">${icon("search", 16)}</button>
  </form>
</div>
</header>
<script>(function(){
  var btn=document.querySelector(".nav-toggle"),drawer=document.getElementById("site-drawer");
  if(!btn||!drawer)return;
  var open=document.querySelector(".nav-toggle .i-open"),close=document.querySelector(".nav-toggle .i-close");
  btn.addEventListener("click",function(){
    var willOpen=drawer.hasAttribute("hidden");
    if(willOpen){drawer.removeAttribute("hidden");}else{drawer.setAttribute("hidden","");}
    btn.setAttribute("aria-expanded",String(willOpen));
    if(open)open.hidden=willOpen;
    if(close)close.hidden=!willOpen;
  });
})();</script>`;
}

function adSlotHtml() {
  // Honest reserved space, not a fabricated ad — this codebase's own rule
  // (see siteFooter()'s comment below) is to never invent content that
  // isn't real, and there's no ad network wired up yet. Per the approved
  // design (B10) this slot renders right after the title/breadcrumbs on
  // narrow screens too (see .ad-slot-mobile in STYLE) instead of being
  // hidden — the old behaviour just dropped it below 900px.
  return `<div class="ad-slot"><div class="ad-slot__box">Место для рекламного блока</div></div>`;
}

function siteFooter() {
  // "О данных" is the only real page today; the other three are drafted
  // per the user's own follow-up request (Дисклеймер / Пользовательское
  // соглашение — see routes for /disclaimer/ and /soglashenie/, both
  // explicitly marked as a non-legal draft). "Обратная связь" links to a
  // plain contact page — the actual FORM was explicitly postponed by the
  // user, so this is a mailto/contact page, not a working form.
  return `<footer class="site-footer">
<div class="footer-inner">
  <div class="footer-brand">Sofia<em>Map</em></div>
  <nav><ul>
    <li><a href="/o-dannyh/">О данных</a></li>
    <li><a href="/disclaimer/">Дисклеймер</a></li>
    <li><a href="/soglashenie/">Пользовательское соглашение</a></li>
    <li><a href="/obratnaya-svyaz/">Обратная связь</a></li>
  </ul></nav>
</div>
</footer>`;
}

// A titled card block for the address page (and any future page that wants
// the same shape) — icon + <h2> inside .block-head, content below.
function blockWrap(id, title, iconName, innerHtml) {
  return `<section class="block" id="${esc(id)}">
<div class="block-head"><span class="block-icon">${icon(iconName, 18)}</span><h2>${esc(title)}</h2></div>
${innerHtml}
</section>`;
}

// Live map widget (decision C13: "виджет живой карты... по всем страницах
// с гео-локацией"). Reuses the exact same MapLibre + PMTiles bootstrap the
// full map page uses (web/js/map-style.js's buildStyle/detectRenderQuality,
// web/js/pmtiles.js's Protocol) via mini-map.js, loaded from the /map/
// static mount so there's exactly one copy of that logic in the codebase.
// "Развернуть" reuses mapLink()'s own `?q=` convention (below) rather than
// teaching /map/ a new lat/lon URL param — the address text is already
// specific enough to resolve to this exact building via the map's existing
// search (same convention already used at ~15 other call sites).
// 2026-09-15 (live report: "при клике со страницы адреса, на карте должен
// вызываться необходимый объект. Сейчас кнопка развернуть, просто открывает
// большую карту"): `?q=`/`type` was never a reliable way to land on THIS
// exact object once the map's own search can bubble/group things (Проблема
// B's leader+namesakes split, "Витоша" etc.) — a text re-search from the
// mini-map can now resolve to a different row than the one the widget was
// actually showing. `selType`/`selId` on `miniMapWidget()` below take
// priority when given: they build a `?sel=type:id` link instead, resolved
// map-side (web/js/map-search.js's `selectFromUrl`) via the SAME
// `/api/object/:type/:id` endpoint the map already uses when a search
// result row is clicked — so "Развернуть" ends up doing exactly what
// clicking that object in search results does, not a fresh text search.
// Kept as an addition, not a replacement of `mapHref`/`type`: every other
// call site of `miniMapWidget()`/`mapLink()` (~15 across pages.js) still
// only has a query string to offer, and stays on the old behavior.
function mapSelectHref(type, id) {
  return `/map/?sel=${encodeURIComponent(type)}:${encodeURIComponent(id)}`;
}

function mapSelectLink(type, id, label = "Открыть на карте →") {
  return `<a class="map-link" href="${esc(mapSelectHref(type, id))}">${esc(label)}</a>`;
}

// `points` (2026-09-15, stop-cluster entity page): optional extra
// [{lat, lon}, ...] markers besides the primary one — a multi-platform
// stop's own page needs to show EVERY physical point of the cluster on one
// map, not just the single point this call is centered on. Serialized as a
// `data-points` JSON attribute; mini-map.js draws the primary marker as
// before and a smaller one for each extra point, then fits the view to all
// of them instead of a fixed center/zoom. Omitted entirely (no attribute)
// when there's nothing extra — every existing single-point caller
// (addresses, districts, ...) is completely unaffected.
function miniMapWidget({ lat, lon, query, type, selType, selId, points }) {
  if (lat == null || lon == null) return "";
  const expandHref = selType && selId != null ? mapSelectHref(selType, selId) : mapHref(query, type);
  const pointsAttr = points && points.length ? ` data-points="${esc(JSON.stringify(points))}"` : "";
  return `<div class="mini-map-widget">
<div class="mini-map" data-lat="${esc(lat)}" data-lon="${esc(lon)}" data-expand="${esc(expandHref)}"${pointsAttr} role="img" aria-label="Карта расположения"></div>
<div class="mini-map-foot"><span class="meta" style="margin:0">Показано на карте Софии</span><a class="mini-map-expand" href="${esc(expandHref)}">Развернуть ${icon("externalLink", 14)}</a></div>
</div>`;
}

function mapAssetsHead() {
  return `<link rel="stylesheet" href="/map/css/maplibre-gl.css" />`;
}

function mapAssetsScripts() {
  return `<script src="/map/js/maplibre-gl.js"></script>
<script src="/map/js/pmtiles.js"></script>
<script src="/map/js/map-style.js"></script>
<script src="/map/js/mini-map.js"></script>`;
}

// noindex (Находка №11): для служебной страницы "/o-dannyh/" — не
// техническая заглушка, а вспомогательная справка про первоисточники и
// нюансы данных, которую незачем показывать в результатах поиска, но на
// которую сайт сам ссылается со страниц домов.
//
// frame (2026-09-08, default true): wraps breadcrumbs/h1/body in the
// site-wide header/footer/ad-rail chrome. Pass frame:false for a page
// that must render exactly as page() produced it before the chrome
// existed — today only /metro/ (see pages.js), because it's explicitly
// out of scope for the chrome (site-design-plan.md §4.1) even though it
// shares this same page() shell with every "typical" page.
//
// headExtra/scripts (2026-09-09): a small per-page escape hatch for pages
// that need extra <link>/<style> in <head> or extra <script> before
// </body> — today only the mini-map widget's CSS/JS (mapAssetsHead() /
// mapAssetsScripts() above), without every other page paying for
// MapLibre/PMTiles it doesn't use.
function page({ title, h1, breadcrumbs = [], body, noindex = false, frame = true, headExtra = "", scripts = "" }) {
  const topHtml = `${breadcrumbs.length ? crumbs(breadcrumbs) : ""}
<h1>${esc(h1 != null ? h1 : title)}</h1>`;
  const mainContent = frame
    ? `${topHtml}
<div class="ad-slot-mobile">${adSlotHtml()}</div>
${body}`
    : `${topHtml}
${body}`;
  const content = frame
    ? `${siteHeader(activeNavHref(breadcrumbs))}
<div class="layout">
<main>
${mainContent}
</main>
<aside class="ad-rail" aria-hidden="true">${adSlotHtml()}</aside>
</div>
${siteFooter()}`
    : mainContent;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${noindex ? '<meta name="robots" content="noindex, nofollow" />\n' : ""}<title>${esc(title)}</title>
${GOOGLE_FONTS_LINK}
${headExtra ? headExtra + "\n" : ""}<style>${STYLE}</style>
</head>
<body${frame ? ' class="framed"' : ""}>
${content}
${scripts}
</body>
</html>`;
}

// A simple "link + right-aligned count" list — the one repeating shape
// every hub/subgroup page in this section uses per task requirement #3
// ("просто список ссылок с названием/количеством").
function itemList(items) {
  if (!items.length) return `<p><em>Пусто.</em></p>`;
  return `<ul class="item-list">${items
    .map((it) => {
      // A null/falsy href (e.g. a route's stop with no name — nothing to
      // link to, see routes/pages.js) renders as plain unlinked text
      // rather than a broken or empty <a href>.
      const label = it.href ? `<a href="${esc(it.href)}">${esc(it.label)}</a>` : `<span>${esc(it.label)}</span>`;
      return `<li>${label}${it.count != null ? `<span class="count">${esc(it.count)}</span>` : ""}</li>`;
    })
    .join("")}</ul>`;
}

function letterNav(summary, { activeSlug, hrefFor }) {
  return `<ul class="letters">${summary
    .map((l) => (l.count ? `<li><a href="${esc(hrefFor(l.slug))}"${l.slug === activeSlug ? ' aria-current="true"' : ""}>${esc(l.letter)}</a></li>` : `<li><span class="disabled">${esc(l.letter)}</span></li>`))
    .join("")}</ul>`;
}

// 2026-09-07: the interactive SPA moved from "/" to "/map/" (see index.js
// and pages.js's new "/" landing route) — "/" is now the crawlable
// landing/hub page, not the map itself, so every one of this file's many
// "Открыть на карте" links has to point at the map's new address. Kept as
// one shared function specifically so this was a one-line change instead
// of updating each of the ~15 call sites across pages.js individually.
function mapHref(query, type) {
  const params = new URLSearchParams({ q: query });
  if (type) params.set("type", type);
  return `/map/?${params.toString()}`;
}

function mapLink(query, type) {
  return `<a class="map-link" href="${esc(mapHref(query, type))}">Открыть на карте →</a>`;
}

module.exports = { esc, page, itemList, letterNav, mapLink, mapHref, mapSelectLink, mapSelectHref, crumbs, blockWrap, miniMapWidget, mapAssetsHead, mapAssetsScripts, adSlotHtml };
