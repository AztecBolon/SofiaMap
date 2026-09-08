"""Official Sofia Metro per-line colors (2026-09-08, revision 10 —
"сделай иконки цветом линии" round 2: the user wanted station icons colored
by their OWN line, M1/M2/M3/M4 distinctly, not all one uniform subway
color as the 5th bug-report's "цветом линии" had been read as until now).

`routes_metro`/`sofia.db` carries no colour column (checked — the OSM
`colour` tag is empty on every way in this extract, same gap noted in
build_subway_lines.py), so these aren't derived from our own data. Sourced
from the OFFICIAL Metropolitan Sofia network scheme instead — fetched
metropolitan.bg's own published map image (metropolitan.bg/en/scheme/
operating-metro -> "Схема на метрото_2026.jpg") and sampled the actual line
stroke pixels directly (Python/PIL, averaged over 1000+ pixels per line
from a clean screenshot, not eyeballed) rather than guessing or reusing a
generic transit palette:

  M1  red     #e5222d   (Бизнес парк <-> Сливница)
  M2  blue    #1874b0   (Обеля <-> Витоша)
  M3  green   #41ad52   (Ген. Владимир Вазов <-> Горна баня)
  M4  yellow  #f8d30a   (Летище София <-> Сливница)

These are the SAME 4 colors metropolitan.bg's own official map uses for
each line's stroke — not a new invented palette, and not a copy of any
logo/mark (a set of 4 plain color values isn't a trademark the way the
metro roundel emblem is; see gen_stop_icons.py's module docstring for that
separate, still-standing constraint).

Used by:
- build_subway_lines.py: each of the 4 LineString features' own
  `properties.color`, read by map-style.js's "subway" line layer.
- dedup_stations.py: `properties.line_color` on each SINGLE-line station
  (see that script for how a station on the M1/M4 shared trunk — 13 of
  them, all real overlap, not a data gap — is deliberately left without
  one, falling back to the old neutral SUBWAY_LINE_COLOR at render time
  rather than arbitrarily picking one of its two lines).
"""

LINE_COLORS = {
    "M1": "#e5222d",
    "M2": "#1874b0",
    "M3": "#41ad52",
    "M4": "#f8d30a",
}
