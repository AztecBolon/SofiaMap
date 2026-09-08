#!/usr/bin/env python3
"""Generate icon sprites for transit stops/stations (2026-09-07, revision
3 — see claude/icon-redesign-plan.md in the project for the full
design-review history). Own, original pictograms — NOT a copy of any real
transit operator's mark (see web/js/map-style.js's icon comment for why):

- "metro-badge": solid disc + pointed tail (pin silhouette), no letter (the
  M is a real MapLibre text-field now, drawn by map-style.js — see revision
  9 below). Own proportions/geometry, not a trace of the real Sofia Metro
  emblem — used for stop_type=subway, drawn from the `stationsGeo` GeoJSON
  source (deduped to one feature per physical station — see map-style.js).
  Revision history: revision 6 baked it as a flat two-color sprite (M as a
  separate white layer, not an SDF hole, which let the basemap show through
  instead of true white); revision 9 dropped the baked M entirely in favor
  of real text; revision 10 ("сделай иконки цветом линии" round 2 — each
  station colored by its OWN line) needed per-feature runtime recoloring,
  which only SDF's icon-color supports, so it's SDF again — see
  render_dilated()'s comment further down for the full reasoning and how
  its hover ring ("metro-badge-halo") works now that the disc's color
  varies per feature instead of being one baked-in constant.
- "rail-ladder": two rails + three ties (a literal railroad-track
  pictogram) — SUPERSEDED by "rail-badge" (revision 11, see below) as
  what the map actually draws, but still generated (kept in case it's
  useful elsewhere, same reasoning as badge-circle/veh-bus/veh-tram below).
- "rail-badge" (revision 11, "жд станции... теряются на карте... в стиле
  метро"): solid rounded-square + pointed tail — same "pin" family/style
  as metro-badge (a solid fill, not an outline/thin-stroke pictogram),
  because rail-ladder turned out to have the exact same "thin stays thin
  and pale at any scale" legibility problem revision 4 already diagnosed
  and fixed for metro-badge (see that revision's comment in the project
  doc) — a bare two-rails-and-ties line pictogram, even baked at 64px/SDF/
  with a halo, just doesn't put down enough "ink" to read at a glance next
  to a solid disc. Rounded-SQUARE top (not a circle) keeps it
  silhouette-distinguishable from metro-badge at a glance — still a hard
  requirement from revision 2 ("не просто по цвету") — even though the
  two are now visually closer in overall weight/style than before.
- "metro-badge-half-a"/"metro-badge-half-b" (revision 12, replacing
  revision 11's flat "metro-badge-split"/"metro-badge-split-hover" —
  see below for why): the 13 real stations on the M1/M4 shared trunk
  (Младост 1 <-> Сливница — see dedup_stations.py's station_lines())
  belong to TWO real lines at once, and SDF's icon-color can only ever
  tint a whole shape ONE color, so a single icon can't carry both colors.
  Revision 11's answer was to bake the two colors directly into one FLAT
  (non-SDF) sprite via render_split(). That turned out to be the exact
  same class of bug this project already hit once before and fixed by
  moving AWAY from a flat bake (see draw_metro_letter's revision 9
  comment: "a raster bitmap this thin, at these sizes, is fighting the
  GPU's own minification filter no matter how much source detail it
  starts from" — a baked bitmap's on-screen result depends on the specific
  GPU's texture minification/mip selection at the current zoom, which can
  differ from instance to instance and from zoom to zoom in ways a bigger
  bake reduces but never reliably eliminates). The user's bug report this
  time was the same shape: correct at some zooms, reverted to plain at
  others, on a machine my own test browser couldn't reproduce it on —
  classic GPU-sampling-variance fingerprint, not a logic bug in the
  `line_split` expression itself (independently confirmed: the expression
  evaluated correctly at runtime every time it was checked).
  render_half() replaces render_split(): instead of compositing two real
  colors into one flat bitmap, it renders TWO ORDINARY SDF sprites, each
  the SAME metro-badge silhouette masked down to just one diagonal half
  (mask_to_sdf on a half-mask, same infra render()/render_dilated() already
  use — no new mechanism, just applied to half a shape). map-style.js
  stacks both as two separate symbol layers at the station's point, each
  with a FIXED icon-color (M1 red / M4 yellow) — ordinary per-feature SDF
  recoloring, the same reliable mechanism metro-badge/rail-badge already
  use for their own (single) color, just two instances instead of one.
  Nothing here is baked as real pixels any more, so there's no bitmap for
  the GPU to minify inconsistently — this sidesteps the bug class
  entirely rather than trying to out-resolution it (revision 8 already
  tried "bake it bigger" for the M-legibility version of this exact
  problem and it only reduced the failure rate, never eliminated it).
- "entrance-chevron": subway entrance pictogram (down-chevron in a thin
  ring), smaller/quieter than the station badge. Generated and registered
  now so the sprite is ready — the pipeline does not ingest
  railway=subway_entrance nodes yet (see the project doc's open blocker),
  so this sprite isn't drawn on the map until that's resolved.
- "veh-bus-badge" / "veh-tram-badge": the bus/tram "colored badge + white
  silhouette" look, baked into ONE flat (non-SDF) sprite per mode instead
  of two stacked SDF layers (revision 2's approach). Revision 2 stacked a
  colored "badge-circle" SDF layer under a white "veh-bus"/"veh-tram" SDF
  layer at the same points — that made per-mode declutter (icon-allow-
  overlap:false) unreliable, because MapLibre's collision index is shared
  across layers in draw order: the badge layer would reserve a point's
  box, and the glyph layer's box at that same point would then always
  read as "already occupied" and get dropped, silently splitting badge
  and glyph. Baking both into one flat sprite makes each stop exactly one
  symbol with one collision box, so overlap declutter behaves the same
  way it does for every other icon/label in the style. `badge-circle`/
  `veh-bus`/`veh-tram` are kept below (still valid standalone SDF shapes)
  in case they're useful elsewhere, but are no longer referenced by
  buildStopsLayers().
- "stop-triangle": unchanged, airport.
- "stop-dot": unchanged, fallback ("other").

Output: web/js/stop-icons.js — a small generated JS module exporting
STOP_ICON_SPRITES = { name: {width, height, base64, sdf} }. For SDF
sprites (sdf: true, the default/most entries): base64 = raw RGBA bytes,
R=G=B=255 and A=the SDF value per pixel, the convention MapLibre expects
for `map.addImage(id, {width,height,data}, {sdf:true})` — same encoding
text glyphs use, and `icon-color` can recolor it per feature. For flat
sprites (sdf: false — veh-bus-badge/veh-tram-badge): base64 = ordinary
premultiplied-alpha RGBA pixels with the real colors already baked in;
`icon-color` has no effect on these and isn't set for them in
map-style.js. Loaded and registered at runtime by `registerStopIcons(map)`
in web/js/map-style.js (reads each sprite's own `sdf` flag) — no
sprite.json/spritesheet build step, no network fetch: the pixel data is
embedded directly, same "vendor it, no runtime dependency" approach
already used for fonts.

Re-run this script and re-paste its output only if an icon SHAPE or the
baked-in flat colors change; per-feature SDF colors are applied
client-side via `icon-color` and never need regenerating here.
"""
import base64
import json
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt

# 2026-09-08 revision 8 ("М видна но не на всех масштабах" — legible up
# close, a solid blob at the city-wide zooms most of the map is actually
# viewed at): OUT was 28. Confirmed by direct reproduction, not guessed —
# an isolated test page (same maplibre-gl.js, same addImage()/paint code)
# rendered the M perfectly at 15/21/28px in a real WebGL browser, so the
# icon-registration code and the baked pixels were never the bug. The
# actual difference between "works" and "doesn't" was screen size at the
# CITY-WIDE zooms this app spends most of its time at: at icon-size 0.55
# (zoom 8), a 28px sprite displays at ~15px on screen, and — evidently, on
# the user's real GPU, though not on the software renderer used for the
# isolated test above — the M's thin stroke doesn't survive whatever
# minification/mip filtering the GPU applies at that size, even though the
# SAME 28px source read fine when magnified up for the isolated test.
# More source texture gives that filtering more real detail to average
# from instead of aliasing it away, so OUT is quadrupled (28 -> 64,
# 784 -> 4096px, ~5x the baked bytes — still a few hundred KB inline,
# fine) and HIRES doubled alongside it (128 -> 256) to keep the same
# supersample-to-output ratio for the initial LANCZOS downsample. Every
# on-screen icon-size in map-style.js that multiplies OUT is rescaled by
# 28/64 (=0.4375) to keep the actual on-screen pixel footprint unchanged —
# this is a texture-resolution fix, not a "make icons bigger" one.
HIRES = 256       # supersampled drawing resolution
OUT = 64          # final sprite pixel size (square)
EDGE_SOFTNESS = 8.0  # SDF distance (in HIRES px) mapped across the 0-255 alpha range


def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mask_to_sdf(mask: np.ndarray) -> np.ndarray:
    """mask: bool array, True = inside the shape. Returns a HIRES x HIRES
    uint8 array: 255 deep inside, ~128 right at the edge, 0 deep outside."""
    inside = distance_transform_edt(mask)
    outside = distance_transform_edt(~mask)
    signed = inside - outside  # positive inside, negative outside
    alpha = 128 + signed * (127.0 / EDGE_SOFTNESS)
    return np.clip(alpha, 0, 255).astype(np.uint8)


def dilate_mask(mask: np.ndarray, px: float) -> np.ndarray:
    """Grow a boolean HIRES-resolution mask outward by `px` HIRES-pixels —
    used by render_hover() to trace a highlight ring around an icon's own
    real silhouette (see that function)."""
    return mask | (distance_transform_edt(~mask) <= px)


def render(draw_fn) -> dict:
    img = Image.new("L", (HIRES, HIRES), 0)
    d = ImageDraw.Draw(img)
    draw_fn(d, HIRES)
    mask = np.array(img) > 127
    sdf = mask_to_sdf(mask)
    sdf_img = Image.fromarray(sdf, mode="L").resize((OUT, OUT), Image.LANCZOS)
    sdf_arr = np.array(sdf_img)
    rgba = np.zeros((OUT, OUT, 4), dtype=np.uint8)
    rgba[..., 0] = 255
    rgba[..., 1] = 255
    rgba[..., 2] = 255
    rgba[..., 3] = sdf_arr
    b64 = base64.b64encode(rgba.tobytes()).decode("ascii")
    return {"width": OUT, "height": OUT, "base64": b64, "sdf": True}


# 2026-09-08 revision 10 ("сделай иконки цветом линии" round 2 — each
# station colored by its OWN line, M1/M2/M3/M4, not one shared subway
# color): metro-badge needs to be recolored per-FEATURE now (a station's
# `line_color` property, see dedup_stations.py) — SDF's icon-color is the
# only mechanism that recolors per-feature at runtime, so metro-badge goes
# back to being SDF (like rail-ladder always was), reversing revision 6's
# switch to a flat baked sprite. That's safe now in a way it wasn't in
# revision 6: the reason for going flat back then was the SDF "hole" for
# the M letter showing the basemap through instead of true white — but
# revision 9 already removed the M from the badge entirely (it's a real
# MapLibre text-field now, see map-style.js), so metro-badge is just a
# plain single-color disc+tail silhouette with no hole to begin with.
#
# The hover ring can't simply go back to a flat "*-hover" composite like
# rail-ladder-hover/veh-*-badge-hover still are, though — the old bake
# fixed the ring's color AND the disc's color into one image, but the
# disc's color now varies per station. render_dilated() bakes just the
# grown SILHOUETTE as its own separate SDF sprite ("metro-badge-halo") —
# map-style.js layers it (colored via icon-color: HOVER_COLOR, a fixed
# amber, at a slightly bigger icon-size) directly BEHIND another instance
# of the real "metro-badge" sprite (colored via the SAME per-feature
# ["get","line_color"] expression the real station layer uses) at the
# hovered point. Two ordinary SDF layers stacked at one point is exactly
# what revision 3's veh-bus-badge/veh-tram-badge move AWAY from — but that
# was specifically about `icon-allow-overlap:false` collision-box conflicts
# between MANY simultaneous stops; a single ad-hoc hover feature always has
# `icon-allow-overlap:true` (nothing else competes with it for a box), so
# that failure mode doesn't apply here.
def render_dilated(draw_fn, dilate_px=9) -> dict:
    img = Image.new("L", (HIRES, HIRES), 0)
    d = ImageDraw.Draw(img)
    draw_fn(d, HIRES)
    mask = dilate_mask(np.array(img) > 127, dilate_px)
    sdf = mask_to_sdf(mask)
    sdf_img = Image.fromarray(sdf, mode="L").resize((OUT, OUT), Image.LANCZOS)
    rgba = np.zeros((OUT, OUT, 4), dtype=np.uint8)
    rgba[..., 0] = 255
    rgba[..., 1] = 255
    rgba[..., 2] = 255
    rgba[..., 3] = np.array(sdf_img)
    b64 = base64.b64encode(rgba.tobytes()).decode("ascii")
    return {"width": OUT, "height": OUT, "base64": b64, "sdf": True}


def render_flat(layers) -> dict:
    """layers: [(draw_fn, (r,g,b)), ...] drawn in order (later = on top).
    Renders a real-color, non-SDF RGBA sprite by supersampling each
    layer's mask at HIRES and alpha-compositing it over the previous
    layers before downsampling — used for the bus/tram badges, which need
    two colors (mode color + white) baked into a single flat sprite so it
    collides as ONE symbol (see the module docstring's veh-*-badge note)."""
    img = Image.new("RGBA", (HIRES, HIRES), (0, 0, 0, 0))
    for draw_fn, color in layers:
        mask_img = Image.new("L", (HIRES, HIRES), 0)
        d = ImageDraw.Draw(mask_img)
        draw_fn(d, HIRES)
        color_img = Image.new("RGBA", (HIRES, HIRES), color + (255,))
        img = Image.composite(color_img, img, mask_img)
    small = img.resize((OUT, OUT), Image.LANCZOS)
    b64 = base64.b64encode(np.array(small).tobytes()).decode("ascii")
    return {"width": OUT, "height": OUT, "base64": b64, "sdf": False}


# 2026-09-08 revision 8 — hover highlight, take 2. The first hover/click fix
# (revision 7, pickHoverFeature in map-search.js) made the right OBJECT get
# picked; the user's next report was that the highlight drawn for it still
# didn't match: a plain fixed-radius circle ("hover-point" in map-style.js,
# `["coalesce", ["get","hr"], 6.5]`), same 6.5px at every zoom, drawn at the
# station's point coordinate regardless of how big the real badge is at the
# current zoom (icon-size interpolates ~10px -> ~30px across zoom 8-18) or
# what shape it is (metro-badge/veh-*-badge are a disc + a pointed tail
# below center, not a circle — a centered ring can never trace that outline
# no matter its radius). "измени технологию": stop approximating the icon
# with an unrelated shape; highlight the icon's OWN silhouette instead.
#
# render_hover() bakes that directly: take the SAME outline draw_fn(s) the
# base icon already uses for its outer shape (draw_metro_shape,
# draw_rail_ladder, draw_badge_circle, draw_triangle, draw_dot — not the
# inner glyph/letter, just the outer silhouette), grow that mask outward by
# a few px, fill the grown ring with the shared hover accent color, then
# composite the icon's own normal flat layers unchanged on top. The result
# is a "*-hover" sprite baked on the exact same OUT canvas as its base icon
# and driven by the exact same icon-size expression in map-style.js's new
# "hover-icon" layer (see HOVER_ICON_SIZE there) — so at every zoom the
# highlight is, by construction, the real icon's own outline plus a fixed
# margin, not a guess.
HOVER_COLOR = (201, 120, 31)  # #c9781f — same warm accent as the old
# generic hover-point ring / the popup's "Подробнее" link, kept for
# continuity even though the ring is now baked, not drawn live.


def render_hover(outline_fns, layers, dilate_px=9):
    """outline_fns: draw_fn(s) whose UNION silhouette gets the highlight
    ring (usually the base icon's own outer-shape function). layers: the
    same (draw_fn, (r,g,b)) list render_flat() would use for the icon
    itself, composited unchanged on top of the ring. dilate_px is in
    HIRES pixels — icon geometry already reaches close to this canvas's
    edge (e.g. the metro badge's tail tip sits ~1.5 "u" units, ~16px at
    HIRES=256, from the bottom edge), so this stays modest to avoid
    clipping the ring; checked visually after generation, not just by
    the math."""
    union_mask = np.zeros((HIRES, HIRES), dtype=bool)
    for fn in outline_fns:
        m = Image.new("L", (HIRES, HIRES), 0)
        d = ImageDraw.Draw(m)
        fn(d, HIRES)
        union_mask |= (np.array(m) > 127)
    grown = dilate_mask(union_mask, dilate_px)

    img = Image.new("RGBA", (HIRES, HIRES), (0, 0, 0, 0))
    ring_color_img = Image.new("RGBA", (HIRES, HIRES), HOVER_COLOR + (255,))
    ring_mask_img = Image.fromarray((grown * 255).astype(np.uint8), mode="L")
    img = Image.composite(ring_color_img, img, ring_mask_img)

    for draw_fn, color in layers:
        mask_img = Image.new("L", (HIRES, HIRES), 0)
        d = ImageDraw.Draw(mask_img)
        draw_fn(d, HIRES)
        color_img = Image.new("RGBA", (HIRES, HIRES), color + (255,))
        img = Image.composite(color_img, img, mask_img)

    small = img.resize((OUT, OUT), Image.LANCZOS)
    b64 = base64.b64encode(np.array(small).tobytes()).decode("ascii")
    return {"width": OUT, "height": OUT, "base64": b64, "sdf": False}


# 2026-09-08 revision 12 (replaces revision 11's render_split()/
# render_split_hover() — see the module docstring's "metro-badge-half-a/-b"
# entry for the full why). Renders an SDF of just ONE diagonal half of
# draw_fn's silhouette — `half` selects which: "a" keeps pixels above/left
# of the corner-to-corner diagonal (`row + col < HIRES`), "b" keeps the
# rest. Two calls (half="a"/half="b") on the same draw_fn produce a pair of
# ordinary SDF sprites that partition the full shape between them exactly
# (their union covers every pixel of the original silhouette once), so
# stacking both — each recolored via the normal per-feature `icon-color`
# mechanism, same as any other SDF icon — reproduces the two-color split
# with no baked pixels anywhere. The straight cut falls right where
# EDGE_SOFTNESS's own blur already softens an SDF edge, so the seam between
# the two halves anti-aliases the same way the shape's outer silhouette
# does — no separate seam-smoothing needed.
def render_half(draw_fn, half) -> dict:
    img = Image.new("L", (HIRES, HIRES), 0)
    d = ImageDraw.Draw(img)
    draw_fn(d, HIRES)
    mask = np.array(img) > 127
    rows, cols = np.indices((HIRES, HIRES))
    half_a = (rows + cols) < HIRES
    half_mask = mask & (half_a if half == "a" else ~half_a)
    sdf = mask_to_sdf(half_mask)
    sdf_img = Image.fromarray(sdf, mode="L").resize((OUT, OUT), Image.LANCZOS)
    rgba = np.zeros((OUT, OUT, 4), dtype=np.uint8)
    rgba[..., 0] = 255
    rgba[..., 1] = 255
    rgba[..., 2] = 255
    rgba[..., 3] = np.array(sdf_img)
    b64 = base64.b64encode(rgba.tobytes()).decode("ascii")
    return {"width": OUT, "height": OUT, "base64": b64, "sdf": True}


# ---- metro: solid disc + pointed tail, with a SOLID WHITE M ON TOP
# (viewBox 24) -- own geometry, not a trace of the real Sofia Metro emblem
# (that constraint is still in force — see claude/icon-redesign-plan.md;
# the user asked for the real official icon in round 6 and that request
# was declined for this reason, see the reply for the explanation).
#
# 2026-09-07 revision 4: was a thin ring outline + separate M stroke; at
# the small render sizes stations actually use, a ~2px-wide outline reads
# as almost nothing against the light basemap. Switched to this solid
# filled shape — far more on-screen "ink" at the same nominal size.
#
# 2026-09-08 revision 6: the M was a HOLE cut through the solid fill
# (fill=0 on an SDF sprite) — meant to read as "white", but an SDF cutout
# has no color of its own: it's just "not-shape", so whatever is UNDER the
# icon (the pale basemap) shows through, not necessarily white — exactly
# the "белое внутри... прозрачным" complaint. Split into two separate draw
# functions (draw_metro_shape / draw_metro_letter) rendered via
# render_flat() as a flat two-color sprite instead: the shape gets an
# opaque baked fill (METRO_BADGE_COLOR, see FLAT_ICONS below) and the M is
# a SEPARATE opaque white layer painted ON TOP, not a hole — genuinely
# white, always, regardless of what's under the icon.
def draw_metro_shape(d, s):
    u = s / 24.0
    cx, cy, r = 12 * u, 10 * u, 8.6 * u
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    tri = [(9 * u, 17.2 * u), (12 * u, 22.5 * u), (15 * u, 17.2 * u)]
    d.polygon(tri, fill=255)


# 2026-09-08 revision 7 ("м не читается на иконке" — the shape/color fixes
# above made the badge itself read fine, but at the small on-screen sizes
# stations actually render at, the M glyph inside it washed out): widened
# and thickened, same "more ink at small size beats a precise but thin
# shape" reasoning already applied to the badge outline in revision 4.
# Half-width 3.7u->4.6u, half-height 3.1u->4.2u, stroke 2.3u->3.1u — still
# comfortably inside draw_metro_shape's disc (corner-to-center distance
# ~6.2u against the disc's 8.6u radius, with room for the thicker stroke).
#
# 2026-09-08 revision 9: SUPERSEDED — no longer used to bake the M into the
# sprite (kept only as a record of the geometry that was tried). Revision 8
# quadrupled the bake resolution (OUT 28->64) on the theory that more
# source texture would survive GPU minification at small on-screen sizes;
# the user's follow-up report showed that was only PART of the picture —
# screenshots at one single zoom level showed some station instances with
# a crisp M and others (same sprite, same on-screen size) as a solid blob,
# which a source-resolution fix can't explain: it points to per-instance
# GPU texture-sampling variance (subpixel placement, mip/LOD selection)
# that baking harder pixels can reduce but not reliably eliminate — a
# raster bitmap this thin, at these sizes, is fighting the GPU's own
# minification filter no matter how much source detail it starts from.
# Rather than keep tuning stroke width/resolution against unknown GPU
# behavior, the M moved to a completely different rendering path: a real
# MapLibre `text-field` ("overlay-stations-glyph"/hover-icon-station-glyph
# in map-style.js), drawn with MapLibre's own SDF text engine — the same
# system every label on this map already uses, specifically built to stay
# crisp at any zoom, which a baked-bitmap glyph inside an icon image never
# was. draw_metro_shape (the disc+tail, no letter) is now the WHOLE of
# metro-badge/metro-badge-hover; see FLAT_ICONS/HOVER_ICONS below.
def draw_metro_letter(d, s):
    u = s / 24.0
    pts = [(7.4 * u, 14.2 * u), (7.4 * u, 5.8 * u), (12 * u, 10.9 * u), (16.6 * u, 5.8 * u), (16.6 * u, 14.2 * u)]
    m_w = max(1, round(3.1 * u))
    d.line(pts, fill=255, width=m_w, joint="curve")
    rr = m_w / 2.0
    for (x, y) in pts:  # round caps/joins for the stroke
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=255)


# ---- rail: two rails + three ties (viewBox 24) — strokes thickened
# 2026-09-07 revision 4 (2.0u -> 2.6u) for the same "more ink at small
# sizes" reason as the metro badge above. ------------------------------
def draw_rail_ladder(d, s):
    u = s / 24.0
    w = max(1, round(2.6 * u))

    def line(x1, y1, x2, y2):
        d.line([(x1 * u, y1 * u), (x2 * u, y2 * u)], fill=255, width=w)
        rr = w / 2.0
        for (x, y) in [(x1, y1), (x2, y2)]:
            d.ellipse([x * u - rr, y * u - rr, x * u + rr, y * u + rr], fill=255)

    line(7, 3, 7, 21)
    line(17, 3, 17, 21)
    line(4, 7, 20, 7)
    line(4, 12, 20, 12)
    line(4, 17, 20, 17)


# 2026-09-08 revision 11 ("жд станции... теряются... в стиле метро"): a
# solid pin, same silhouette FAMILY as draw_metro_shape (rounded top +
# pointed tail, same anchor point/proportions) but with a rounded-SQUARE
# top instead of a circle, so rail and metro read as "the same visual
# language" (both solid, both high-contrast) while staying tellable apart
# by shape alone at a glance, same requirement draw_rail_ladder above was
# originally built to satisfy. half=6.3u/diagonal≈8.9u chosen to read as
# roughly the same visual size as draw_metro_shape's r=8.6u disc.
def draw_rail_pin(d, s):
    u = s / 24.0
    cx, cy, half, rad = 12 * u, 10 * u, 6.3 * u, 2.2 * u
    d.rounded_rectangle([cx - half, cy - half, cx + half, cy + half], radius=rad, fill=255)
    tri = [(9 * u, 17.2 * u), (12 * u, 22.5 * u), (15 * u, 17.2 * u)]
    d.polygon(tri, fill=255)


# ---- subway entrance: down-chevron in a thin ring (viewBox 24) -----------
def draw_entrance_chevron(d, s):
    u = s / 24.0
    cx, cy, r = 12 * u, 12 * u, 9 * u
    ring_w = max(1, round(2.1 * u))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=255, width=ring_w)
    pts = [(8 * u, 10 * u), (12 * u, 15 * u), (16 * u, 10 * u)]
    chev_w = max(1, round(2.4 * u))
    d.line(pts, fill=255, width=chev_w, joint="curve")
    rr = chev_w / 2.0
    for (x, y) in pts:
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=255)


# ---- bus/tram badge pair (viewBox 32 — square canvas so badge-circle and
# the vehicle glyph line up pixel-for-pixel when stacked as two layers) ----
def draw_badge_circle(d, s):
    u = s / 32.0
    cx, cy, r = 16 * u, 16 * u, 15 * u
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)


def draw_veh_bus(d, s):
    u = s / 32.0

    def R(x, y, w, h, rad, fill):
        d.rounded_rectangle([x * u, y * u, (x + w) * u, (y + h) * u], radius=rad * u, fill=fill)

    def C(cx, cy, r, fill):
        d.ellipse([(cx - r) * u, (cy - r) * u, (cx + r) * u, (cy + r) * u], fill=fill)

    R(5, 12, 26, 12, 2.5, 255)          # body
    R(8, 15, 5, 4, 0.6, 0)              # windows (real holes, not a color trick)
    R(15.5, 15, 5, 4, 0.6, 0)
    R(23, 15, 5, 4, 0.6, 0)
    C(11, 25, 2.6, 255)                 # wheels
    C(25, 25, 2.6, 255)


def draw_veh_tram(d, s):
    u = s / 32.0

    def R(x, y, w, h, rad, fill):
        d.rounded_rectangle([x * u, y * u, (x + w) * u, (y + h) * u], radius=rad * u, fill=fill)

    def C(cx, cy, r, fill):
        d.ellipse([(cx - r) * u, (cy - r) * u, (cx + r) * u, (cy + r) * u], fill=fill)

    def L(x1, y1, x2, y2, w):
        lw = max(1, round(w * u))
        d.line([(x1 * u, y1 * u), (x2 * u, y2 * u)], fill=255, width=lw)
        rr = lw / 2.0
        for (x, y) in [(x1, y1), (x2, y2)]:
            d.ellipse([x * u - rr, y * u - rr, x * u + rr, y * u + rr], fill=255)

    R(3, 15, 12, 9, 2, 255)             # segment 1
    R(16, 15, 15, 9, 2, 255)            # segment 2
    R(14.1, 17.6, 2.8, 3.8, 1, 255)     # connector waist (articulation)
    R(5, 17.6, 7, 3, 0.6, 0)            # window strip seg1 (hole)
    R(18, 17.6, 10, 3, 0.6, 0)          # window strip seg2 (hole)
    L(11, 15, 11, 11.4, 1.3)            # pantograph pole
    L(8, 11.4, 14, 11.4, 1.6)           # pantograph bar
    C(7, 25, 1.7, 255)                  # 4 low wheels (vs bus's 2 big ones)
    C(13, 25, 1.7, 255)
    C(20, 25, 1.7, 255)
    C(27, 25, 1.7, 255)


# ---- unchanged from revision 1 --------------------------------------------
def draw_triangle(d, s):
    m = s * 0.16
    d.polygon([(s / 2, m), (s - m, s - m), (m, s - m)], fill=255)


def draw_dot(d, s):
    cx = cy = s / 2
    r = s * 0.32
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)


# ---- bus/tram flat composite badges (baked colors, viewBox 32) -----------
# Same colors revision 1/2 used via icon-color: bus/terminal blue, tram
# green. Baked here instead of applied at runtime because these two are
# flat (non-SDF) composites — see render_flat()/module docstring.
BUS_BLUE = (31, 111, 208)
TRAM_GREEN = (10, 138, 60)

# 2026-09-08 revision 6: metro badge fill — the literal SUBWAY_LINE_COLOR
# from web/js/map-style.js (#5c7291), not a saturated/darkened variant.
# Round 4 boosted saturation+darkness on the assumption the exact line
# color would be too washed out for a solid icon; round 6's user feedback
# ("для станций иконки делаем цветом линии") asked for the literal line
# color instead, and with the solid-fill shape (not a thin ring) plus a
# genuinely opaque white M on top (see draw_metro_letter above), the
# unmodified color reads solidly enough on its own. Keep in sync by hand
# if SUBWAY_LINE_COLOR in map-style.js ever changes — not computed from
# there, that file isn't importable from this standalone script.
# 2026-09-08 revision 10: no longer used to bake metro-badge (which is SDF/
# per-feature-recolored again, see render_dilated's comment above) — kept
# only for METRO_BADGE_COLOR below, still the fallback color map-style.js's
# STATION_COLOR uses for a station with no single-line color of its own
# (rail, or one of the 13 real M1/M4 shared-trunk stations).
METRO_BADGE_COLOR = (92, 114, 145)  # #5c7291, == SUBWAY_LINE_COLOR

# Same manual-sync approach as METRO_BADGE_COLOR above (this script can't
# import map-style.js) — used only by the flat "-hover" bakes below, which
# need rail/stop-dot/stop-triangle's colors as real baked pixels instead of
# a runtime icon-color, the same reason veh-*-badge is flat.
RAIL_ICON_COLOR = hex_to_rgb("#9c968c")   # RAIL_LINE_COLOR in map-style.js
STOP_ICON_COLOR = hex_to_rgb("#1f6fd0")   # overlay-stops layer's icon-color


# 2026-09-08 revision 10: metro-badge moved (back) here — SDF, recolored
# per-feature at runtime (map-style.js's STATION_COLOR, now data-driven off
# each station's own `line_color`) — see render_dilated's comment above for
# why. "metro-badge-halo" (render_dilated below) is its hover-ring partner.
# 2026-09-08 revision 11: "rail-badge" added (solid pin, replaces
# rail-ladder as what the map actually draws — see draw_rail_pin's
# comment); rail-ladder itself stays here too, still generated, just
# unreferenced by buildStopsLayers() now (same "kept in case useful
# elsewhere" treatment as badge-circle/veh-bus/veh-tram below).
ICONS = {
    "metro-badge": draw_metro_shape,
    "rail-ladder": draw_rail_ladder,
    "rail-badge": draw_rail_pin,
    "entrance-chevron": draw_entrance_chevron,
    "badge-circle": draw_badge_circle,
    "veh-bus": draw_veh_bus,
    "veh-tram": draw_veh_tram,
    "stop-triangle": draw_triangle,
    "stop-dot": draw_dot,
}

FLAT_ICONS = {
    "veh-bus-badge": [(draw_badge_circle, BUS_BLUE), (draw_veh_bus, (255, 255, 255))],
    "veh-tram-badge": [(draw_badge_circle, TRAM_GREEN), (draw_veh_tram, (255, 255, 255))],
}

# name -> draw_fn for render_dilated() — SDF "halo" sprites, currently just
# metro-badge's (see render_dilated's comment for why it isn't a flat
# "-hover" composite like the others below).
DILATED_ICONS = {
    "metro-badge-halo": draw_metro_shape,
}

# name -> (draw_fn, "a"|"b") for render_half() — the M1/M4 shared-trunk
# stations' diagonal split badge (revision 12, see the module docstring's
# "metro-badge-half-a/-b" entry). Both halves reuse draw_metro_shape's own
# silhouette (same shape metro-badge itself uses) so they line up with it
# and each other pixel-for-pixel; map-style.js supplies the actual M1/M4
# colors at runtime via icon-color (kept in sync by hand with LINE_COLORS,
# same manual-sync approach as METRO_BADGE_COLOR/RAIL_ICON_COLOR above —
# map-style.js can't import this Python module).
HALF_ICONS = {
    "metro-badge-half-a": (draw_metro_shape, "a"),
    "metro-badge-half-b": (draw_metro_shape, "b"),
}

# name-hover -> (outline_fns, layers) for render_hover() — see that
# function's comment. `layers` mirrors each base icon's own FLAT_ICONS
# entry (or, for the plain SDF shapes below, the single fixed color they're
# actually drawn with at runtime today — rail-badge via RAIL_LINE_COLOR,
# stop-triangle/stop-dot via overlay-stops's icon-color). metro-badge-hover
# is NOT here any more — see render_dilated's comment; map-style.js
# composes its hover state from "metro-badge-halo" + "metro-badge" instead.
# rail-ladder-hover stays for the same "kept, just unreferenced now" reason
# as rail-ladder itself above; rail-badge-hover (revision 11) is what
# buildStopsLayers() actually uses.
HOVER_ICONS = {
    "rail-ladder-hover": ([draw_rail_ladder], [(draw_rail_ladder, RAIL_ICON_COLOR)]),
    "rail-badge-hover": ([draw_rail_pin], [(draw_rail_pin, RAIL_ICON_COLOR)]),
    "veh-bus-badge-hover": ([draw_badge_circle], FLAT_ICONS["veh-bus-badge"]),
    "veh-tram-badge-hover": ([draw_badge_circle], FLAT_ICONS["veh-tram-badge"]),
    "stop-triangle-hover": ([draw_triangle], [(draw_triangle, STOP_ICON_COLOR)]),
    "stop-dot-hover": ([draw_dot], [(draw_dot, STOP_ICON_COLOR)]),
}


def main():
    sprites = {name: render(fn) for name, fn in ICONS.items()}
    for name, fn in DILATED_ICONS.items():
        sprites[name] = render_dilated(fn)
    for name, layers in FLAT_ICONS.items():
        sprites[name] = render_flat(layers)
    for name, (fn, half) in HALF_ICONS.items():
        sprites[name] = render_half(fn, half)
    for name, (outline_fns, layers) in HOVER_ICONS.items():
        sprites[name] = render_hover(outline_fns, layers)
    js = (
        "// GENERATED by pipeline/gen_stop_icons.py — do not hand-edit.\n"
        "// Icon sprites for transit stops/stations (2026-09-08, revision 12\n"
        "// — metro-badge-half-a/-b (two ordinary SDF half-sprites) replace\n"
        "// revision 11's flat, baked \"metro-badge-split\"/\"-hover\": that\n"
        "// flat bake turned out to be GPU-minification-unreliable across\n"
        "// zoom/instances, the same bug class already fixed once before for\n"
        "// the M-letter glyph (revision 9) — see this script's own\n"
        "// docstring for the full diagnosis).\n"
        "const STOP_ICON_SPRITES = " + json.dumps(sprites) + ";\n"
    )
    with open("web/js/stop-icons.js", "w") as f:
        f.write(js)
    print("Wrote web/js/stop-icons.js:", {k: (v["width"], v["height"], v["sdf"]) for k, v in sprites.items()})


if __name__ == "__main__":
    main()
