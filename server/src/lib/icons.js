// Small inline SVG icon set for the 2026-09-09 visual redesign (see
// claude/design-decisions.md — approved design canvas). Every icon is a
// bare <svg> string using `currentColor` for stroke/fill so it inherits
// whatever color context it's dropped into (header nav, block headings,
// footer, mobile drawer) without a separate light/dark variant — same
// trick htmlPage.js's own CSS already relies on via `color-mix(in srgb,
// currentColor ...)`.
//
// Deliberately hand-rolled rather than an icon-font/sprite dependency:
// this project has no build step (see htmlPage.js's own top comment on
// why there's no template engine either) — a plain exported function per
// icon keeps that "no bundler" property intact.
//
// stroke-width 1.8, 24x24 viewBox, round caps/joins — one consistent
// "hand", matching the approved canvas's icon style.

function svg(paths, { size = 20, viewBox = "0 0 24 24", filled = false } = {}) {
  const common = filled
    ? `viewBox="${viewBox}" fill="currentColor"`
    : `viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg width="${size}" height="${size}" ${common} aria-hidden="true" focusable="false">${paths}</svg>`;
}

const ICONS = {
  // ---- chrome (header / footer / drawer) ----
  logoMark: (size) => svg('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>', { size }),
  search: (size) => svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', { size }),
  menu: (size) => svg('<path d="M4 7h16M4 12h16M4 17h16"/>', { size }),
  close: (size) => svg('<path d="M6 6l12 12M18 6 6 18"/>', { size }),
  chevronDown: (size) => svg('<path d="m6 9 6 6 6-6"/>', { size }),
  chevronRight: (size) => svg('<path d="m9 6 6 6-6 6"/>', { size }),
  externalLink: (size) => svg('<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>', { size }),

  // ---- block headings on the address page (per approved mockup) ----
  mapPin: (size) => svg('<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/>', { size }),
  bus: (size) => svg('<rect x="4" y="4" width="16" height="13" rx="2.5"/><path d="M4 12h16M8 17v2M16 17v2"/><circle cx="8" cy="14" r=".6" fill="currentColor" stroke="none"/><circle cx="16" cy="14" r=".6" fill="currentColor" stroke="none"/>', { size }),
  landmark: (size) => svg('<path d="M4 21h16M5 21V10M19 21V10M3 10l9-6 9 6M9 21v-6h6v6"/>', { size }),
  shield: (size) => svg('<path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z"/>', { size }),
  school: (size) => svg('<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M6 10.5V16c0 1.4 2.7 3 6 3s6-1.6 6-3v-5.5"/>', { size }),
  briefcase: (size) => svg('<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', { size }),
  grid: (size) => svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>', { size }),
  info: (size) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".9" fill="currentColor" stroke="none"/>', { size }),
  warning: (size) => svg('<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v5"/><circle cx="12" cy="17.5" r=".9" fill="currentColor" stroke="none"/>', { size }),

  // ---- homepage section cards (2026-09-15 homepage redesign) ----
  road: (size) => svg('<path d="M8 3 4 21"/><path d="M16 3l4 18"/><path d="M12 3v3M12 9.5v3M12 16v3"/>', { size }),
  flag: (size) => svg('<path d="M6 21V4"/><path d="M6 5h11l-3 4 3 4H6"/>', { size }),
  hexagon: (size) => svg('<path d="M12 3 4.5 7.5v9L12 21l7.5-4.5v-9L12 3z"/>', { size }),
  home: (size) => svg('<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-6h4v6"/>', { size }),
  mail: (size) => svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', { size }),

  // ---- /raions/ + /parks/ sections (2026-09-15) ----
  tree: (size) => svg('<path d="M12 3 6 11h3l-4 6h4v4h6v-4h4l-4-6h3L12 3z"/>', { size }),
};

module.exports = { icon: (name, size) => (ICONS[name] ? ICONS[name](size) : ""), ICONS };
