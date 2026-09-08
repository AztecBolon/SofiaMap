"""Shared name-alias table for metro station de-duplication (2026-09-08).

`stops` carries 3 orphaned duplicate name spellings for physical stations
that already have a normal, route-used name — an extra OSM node tagged with
a curly-quote variant, an abbreviated form, or a "Св." prefix, that was
never actually wired into any `routes_metro` relation. Found while tracing
why the metro line (built from `route_stops`, see build_subway_lines.py)
didn't visually line up with a couple of station badges (built by grouping
`stops` on exact name, see dedup_stations.py) — these 3 orphan spellings
were producing a second, slightly-offset badge for a station that already
had a correct one.

Confirmed each pair really is the same physical station, not two legitimate
close-together ones (Sofia does have real close-together pairs — "Сердика"
+ "Сердика II", "Национален дворец на културата" + "...II" — both of each
of THOSE pairs are actually used by `route_stops`, which is exactly the
test that rules them out here): for each orphan below, `SELECT COUNT(*)
FROM route_stops rs JOIN stops s ON s.id=rs.stop_id WHERE s.name=?` returns
0 — no real route sequence ever uses that spelling, only its canonical
sibling. A small hardcoded map, not a general fuzzy-match, because the
station-name set is small (60 names) and closed, and a fuzzy match would
risk merging the legitimate close pairs above.

Both dedup_stations.py (station badges) and build_subway_lines.py (line
geometry, keyed off station name from route_stops) normalize through this
map before grouping, so a station's badge and its position on the line are
guaranteed to agree.

2026-09-08, same investigation: "Цар Борис III" (has a normal network tag,
but — like the 3 above — 0 route_stops uses) turned out to be a 4th case
of the same thing, just less obvious: `route_stops` for M3 has an ordered
stop at that exact position (seq 11 of route_id 5) whose `stops` row has
an EMPTY name (''), and the only 2 raw `stops` rows with stop_type=subway
and name='' in the whole table sit ~11m and ~96m from "Цар Борис III"'s
own point — same physical station, just some of its raw OSM nodes never
got a name tag. Added below the same way.
"""

NAME_ALIASES = {
    "Патриарх Евтимий": "Св. Патриарх Евтимий",
    "Акад. Александър Теодоров-Балан": "Академик Александър Теодоров - Балан",
    "Софийски университет Св. Климент Охридски": "Софийски университет „Св. Климент Охридски“",
    "": "Цар Борис III",
}


def canonical_name(name):
    return NAME_ALIASES.get(name, name)
