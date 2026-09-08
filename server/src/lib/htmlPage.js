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
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 16px 20px 60px; line-height: 1.5; }
  nav.crumbs { font-size: 0.9em; opacity: 0.75; margin-bottom: 14px; }
  nav.crumbs a { color: inherit; }
  nav.crumbs span.sep { margin: 0 0.35em; }
  h1 { font-size: 1.5em; margin: 0 0 0.3em; }
  .meta { opacity: 0.7; font-size: 0.92em; margin-bottom: 1.1em; }
  .letters { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 20px; padding: 0; list-style: none; }
  .letters a, .letters span.disabled { display: inline-block; min-width: 1.6em; text-align: center; padding: 3px 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 4px; text-decoration: none; }
  .letters span.disabled { opacity: 0.35; }
  .type-filter { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; padding: 0; list-style: none; }
  .type-filter a, .type-filter span.active { padding: 3px 9px; border-radius: 12px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); text-decoration: none; font-size: 0.9em; }
  .type-filter span.active { font-weight: 600; border-style: solid; }
  ul.item-list { list-style: none; padding: 0; margin: 0 0 1.2em; }
  ul.item-list li { padding: 5px 0; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); display: flex; justify-content: space-between; gap: 1em; }
  ul.item-list .count { opacity: 0.6; font-size: 0.9em; white-space: nowrap; }
  .subgroup-nav { display: flex; justify-content: space-between; margin: 1em 0; font-size: 0.95em; }
  .pagination { display: flex; flex-wrap: wrap; gap: 6px; margin: 1.2em 0; }
  .pagination a, .pagination span.current { padding: 3px 8px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 4px; text-decoration: none; }
  .pagination span.current { font-weight: 600; }
  .map-link { display: inline-block; margin: 0.5em 0 1.2em; }
  .map-cta { display: flex; flex-wrap: wrap; gap: 10px; margin: 0.6em 0 1.6em; }
  .map-cta .map-link { display: inline-block; padding: 10px 18px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: color-mix(in srgb, currentColor 6%, transparent); font-weight: 600; margin: 0; text-decoration: none; }
  footer.back { margin-top: 2em; font-size: 0.9em; }
  ul.stop-list { list-style: none; padding: 0; margin: 0 0 1.2em; }
  ul.stop-list li { padding: 7px 0; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
  ul.stop-list .stop-head { display: flex; justify-content: space-between; gap: 1em; }
  ul.stop-list .stop-head .count { opacity: 0.6; font-size: 0.9em; white-space: nowrap; }
  .stop-routes-label { opacity: 0.6; font-size: 0.85em; margin: 6px 0 3px; }
  ul.stop-routes { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 4px; padding: 0; list-style: none; }
  ul.stop-routes a { padding: 2px 8px; border-radius: 12px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); text-decoration: none; font-size: 0.85em; }
  .postcode-note { font-size: 0.88em; margin: -0.6em 0 1em; padding: 6px 10px; border-radius: 6px; background: color-mix(in srgb, currentColor 6%, transparent); }
  .postcode-note--disputed { background: color-mix(in srgb, orange 12%, transparent); border: 1px solid color-mix(in srgb, orange 35%, transparent); padding: 8px 12px; }
  .postcode-note--disputed .postcode-note__title { font-weight: 600; margin: 0 0 0.4em; }
  .postcode-note--disputed p { margin: 0.5em 0; }
  .postcode-note__extra { opacity: 0.85; }
  .street-collision-note { background: color-mix(in srgb, dodgerblue 8%, transparent); padding: 6px 10px; border-radius: 6px; }
  table.sources-table { border-collapse: collapse; width: 100%; margin: 1em 0 2em; font-size: 0.92em; }
  table.sources-table th, table.sources-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); vertical-align: top; }
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

// noindex (Находка №11): для служебной страницы "/o-dannyh/" — не
// техническая заглушка, а вспомогательная справка про первоисточники и
// нюансы данных, которую незачем показывать в результатах поиска, но на
// которую сайт сам ссылается со страниц домов.
function page({ title, h1, breadcrumbs = [], body, noindex = false }) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${noindex ? '<meta name="robots" content="noindex, nofollow" />\n' : ""}<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${breadcrumbs.length ? crumbs(breadcrumbs) : ""}
<h1>${esc(h1 != null ? h1 : title)}</h1>
${body}
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
function mapLink(query, type) {
  const params = new URLSearchParams({ q: query });
  if (type) params.set("type", type);
  return `<a class="map-link" href="/map/?${params.toString()}">Открыть на карте →</a>`;
}

module.exports = { esc, page, itemList, letterNav, mapLink, crumbs };
