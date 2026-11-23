"""Render one isometric-style tile of Prishtinë from OpenStreetMap data.

Orthographic camera, rotated 45° in plan and pitched 45° down (Small SF style).
Ground layers -> cast shadows -> depth-sorted buildings and trees.
"""
import json
import math
import random
import sys

from PIL import Image, ImageDraw, ImageFont, ImageFilter
from shapely.geometry import Polygon, LineString, Point, box
from shapely.ops import unary_union

LAT0, LON0 = 42.6525, 21.1565          # tile centre, Rruga Isa Boletini (Dardania)
HALF = 150                              # metres: tile is 300 m x 300 m on the ground
AZ = math.radians(45)                   # plan rotation
PITCH = math.radians(45)                # camera tilt from horizontal
SS = 3                                  # supersampling factor
OUT_W = 2048
PX_PER_M = OUT_W / (2 * HALF * math.sqrt(2) * 1.08) * SS
FLOOR_M = 3.1
SUN = (-0.55, 0.35, 0.76)               # light direction (x east, y north, z up), from west-southwest-ish

random.seed(7)

# ---------------------------------------------------------------- data
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "osm.json"))
nodes = {e["id"]: (e["lat"], e["lon"]) for e in d["elements"] if e["type"] == "node" and "lat" in e}
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110540


def to_xy(nid):
    la, lo = nodes[nid]
    return ((lo - LON0) * KX, (la - LAT0) * KY)


TILE = box(-HALF, -HALF, HALF, HALF)

# ---------------------------------------------------------------- projection
CA, SA = math.cos(AZ), math.sin(AZ)
CP, SP = math.cos(PITCH), math.sin(PITCH)


def uv(x, y):
    return (x * CA - y * SA, x * SA + y * CA)


H_IMG = None  # filled after we know vertical extent
OX = OUT_W * SS / 2
OY = None


def proj(x, y, z=0.0):
    u, v = uv(x, y)
    return (OX + u * PX_PER_M, OY - (v * SP + z * CP) * PX_PER_M)


def depth_v(x, y):
    return uv(x, y)[1]


# canvas size: diamond height + headroom for tall buildings + slab
diamond_h = 2 * HALF * math.sqrt(2) * SP * PX_PER_M
headroom = 60 * CP * PX_PER_M
slab = 9 * PX_PER_M
title_h = 150 * SS
H = int(title_h + headroom + diamond_h + slab + 80 * SS)
OY = title_h + headroom + diamond_h / 2

# ---------------------------------------------------------------- palette
C = {
    "bg": (243, 236, 222),
    "ground": (226, 219, 196),
    "slab_l": (176, 150, 118),
    "slab_r": (150, 124, 95),
    "grass": (178, 201, 138),
    "park": (160, 192, 122),
    "forest": (120, 160, 96),
    "parking": (205, 200, 190),
    "pitch": (196, 120, 92),
    "pitch_line": (240, 235, 225),
    "construction": (214, 190, 150),
    "commercial": (222, 212, 196),
    "road": (250, 248, 242),
    "road_edge": (196, 188, 170),
    "primary": (255, 236, 186),
    "footway": (236, 226, 204),
    "shadow": (60, 60, 90, 70),
    "tree": [(96, 146, 82), (112, 160, 90), (86, 134, 76), (128, 170, 98)],
    "trunk": (110, 86, 64),
    "ink": (70, 62, 56),
}

WALL = {  # base wall colour by building kind
    "apartments": (232, 222, 204),
    "apartments_b": (214, 208, 198),
    "house": (240, 228, 206),
    "retail": (222, 226, 230),
    "civic": (236, 214, 190),
    "construction": (200, 180, 150),
}
ROOF = {
    "apartments": (198, 196, 192),
    "house": (190, 92, 66),
    "retail": (176, 186, 194),
    "civic": (176, 150, 130),
    "construction": (190, 170, 140),
}


def shade(rgb, k):
    return tuple(max(0, min(255, int(c * k))) for c in rgb[:3])


# ---------------------------------------------------------------- collect features
buildings, ground, roads, trees = [], [], [], []

for e in d["elements"]:
    if e["type"] != "way":
        continue
    t = e.get("tags", {})
    pts = [to_xy(n) for n in e["nodes"] if n in nodes]
    if len(pts) < 2:
        continue
    closed = e["nodes"][0] == e["nodes"][-1] and len(pts) >= 4
    if "building" in t and closed:
        poly = Polygon(pts).buffer(0)
        if poly.is_empty or not poly.intersects(TILE):
            continue
        buildings.append((poly, t))
    elif "highway" in t:
        ls = LineString(pts).intersection(TILE.buffer(20))
        if not ls.is_empty:
            roads.append((ls, t["highway"]))
    elif closed:
        poly = Polygon(pts).buffer(0)
        if poly.is_empty or not poly.intersects(TILE):
            continue
        kind = (t.get("leisure") or t.get("landuse") or t.get("natural") or t.get("amenity"))
        ground.append((poly, kind, t))

for e in d["elements"]:
    if e["type"] == "node" and e.get("tags", {}).get("natural") == "tree":
        x, y = to_xy(e["id"])
        if abs(x) < HALF - 2 and abs(y) < HALF - 2:
            trees.append((x, y))


# ---------------------------------------------------------------- building heuristics
def classify(poly, t):
    b = t.get("building", "yes")
    a = poly.area
    name = t.get("name", "")
    if b == "construction":
        return "construction", 1
    if t.get("amenity") in ("library", "school") or "PTK" in name:
        return "civic", None
    if b in ("retail", "commercial"):
        return "retail", None
    if b == "apartments":
        return "apartments", None
    if a < 450:
        return "house", None
    return "apartments", None


def levels_for(poly, t, kind):
    if "building:levels" in t:
        try:
            return max(1, int(float(t["building:levels"])))
        except ValueError:
            pass
    a = poly.area
    if kind == "construction":
        return 1
    if kind == "house":
        return 2 if a < 160 else 3 if a < 280 else 4
    if kind == "retail":
        return 2
    if kind == "civic":
        return 4 if a < 1500 else 6
    # Dardania residential blocks: socialist-era slabs and towers
    if a > 1800:
        return 9
    if a > 900:
        return 8
    return 6


items = []
for poly, t in buildings:
    kind, _ = classify(poly, t)
    lv = levels_for(poly, t, kind)
    h = 2.2 if kind == "construction" else lv * FLOOR_M + (0.6 if kind != "house" else 0)
    clipped = poly.intersection(TILE)
    if clipped.is_empty:
        continue
    geoms = [clipped] if clipped.geom_type == "Polygon" else [g for g in getattr(clipped, "geoms", []) if g.geom_type == "Polygon"]
    for g in geoms:
        if g.area < 8:
            continue
        g = g.simplify(0.25)
        items.append({"type": "bldg", "poly": g, "h": h, "lv": lv, "kind": kind, "tags": t})

# procedurally scatter trees in parks / forest / grass where OSM has none
blocked = unary_union([b["poly"].buffer(2.5) for b in items] + [r[0].buffer(4) for r in roads if r[1] not in ("footway", "steps")])
for poly, kind, t in ground:
    if kind in ("park", "forest", "grass", "grassland", "playground"):
        area = poly.intersection(TILE)
        if area.is_empty:
            continue
        dens = {"forest": 1 / 45, "park": 1 / 120, "grass": 1 / 260, "grassland": 1 / 160, "playground": 1 / 300}[kind]
        n = int(area.area * dens)
        minx, miny, maxx, maxy = area.bounds
        placed = 0
        tries = 0
        while placed < n and tries < n * 30:
            tries += 1
            p = Point(random.uniform(minx, maxx), random.uniform(miny, maxy))
            if area.contains(p) and not blocked.contains(p) and abs(p.x) < HALF - 3 and abs(p.y) < HALF - 3:
                trees.append((p.x, p.y))
                placed += 1

for x, y in trees:
    r = random.uniform(2.6, 4.2)
    items.append({"type": "tree", "x": x, "y": y, "r": r, "h": random.uniform(5, 9),
                  "poly": Point(x, y).buffer(r * 0.6, 8), "col": random.choice(C["tree"])})


# ---------------------------------------------------------------- painter's order (pairwise, topological)
def uv_poly(p):
    return Polygon([uv(x, y) for x, y in p.exterior.coords])


for it in items:
    it["uvp"] = uv_poly(it["poly"])
    minu, minv, maxu, maxv = it["uvp"].bounds
    it["ub"] = (minu, maxu)
    it["vmin"] = minv


def in_front(a, b):
    """True if a must be drawn after b (a is nearer the camera where they overlap in u)."""
    lo = max(a["ub"][0], b["ub"][0])
    hi = min(a["ub"][1], b["ub"][1])
    if hi - lo < 1e-6:
        return None
    strip = box(lo, -1e5, hi, 1e5)
    sa = a["uvp"].intersection(strip)
    sb = b["uvp"].intersection(strip)
    if sa.is_empty or sb.is_empty:
        return None
    return sa.bounds[1] < sb.bounds[1]  # smaller v = nearer camera


n = len(items)
after = [set() for _ in range(n)]  # after[i] = items that must be drawn before i
order_hint = sorted(range(n), key=lambda i: -items[i]["vmin"])
for i in range(n):
    for j in range(i + 1, n):
        # cheap reject: screen overlap needs u overlap
        r = in_front(items[i], items[j])
        if r is None:
            continue
        if r:
            after[i].add(j)
        else:
            after[j].add(i)

drawn, order, visiting = set(), [], set()


def visit(i):
    if i in drawn:
        return
    if i in visiting:  # cycle: break it
        return
    visiting.add(i)
    for j in sorted(after[i], key=lambda k: -items[k]["vmin"]):
        visit(j)
    visiting.discard(i)
    drawn.add(i)
    order.append(i)


for i in order_hint:
    visit(i)

# ---------------------------------------------------------------- drawing helpers
img = Image.new("RGB", (OUT_W * SS, H), C["bg"])
dr = ImageDraw.Draw(img, "RGBA")


def fill_poly(poly, z, col, outline=None, width=1):
    polys = [poly] if poly.geom_type == "Polygon" else [g for g in getattr(poly, "geoms", []) if g.geom_type == "Polygon"]
    for p in polys:
        if p.is_empty:
            continue
        dr.polygon([proj(x, y, z) for x, y in p.exterior.coords], fill=col, outline=outline, width=width)
        for hole in p.interiors:
            dr.polygon([proj(x, y, z) for x, y in hole.coords], fill=C["ground"])


def light_k(nx, ny, nz=0.0):
    d = nx * SUN[0] + ny * SUN[1] + nz * SUN[2]
    return 0.72 + 0.32 * max(-0.2, d)


# ---------------------------------------------------------------- tile base (slab + ground)
corners = [(-HALF, -HALF), (HALF, -HALF), (HALF, HALF), (-HALF, HALF)]
SLAB_M = 9
# front faces of slab: those whose outward normal faces camera (nv < 0)
for (x0, y0), (x1, y1) in zip(corners, corners[1:] + corners[:1]):
    nx, ny = (y1 - y0), -(x1 - x0)
    L = math.hypot(nx, ny)
    nx, ny = nx / L, ny / L
    if uv(nx, ny)[1] < 0:
        col = C["slab_l"] if uv(nx, ny)[0] < 0 else C["slab_r"]
        dr.polygon([proj(x0, y0, 0), proj(x1, y1, 0), proj(x1, y1, -SLAB_M), proj(x0, y0, -SLAB_M)], fill=col)
        # strata lines
        for k in (0.35, 0.7):
            dr.line([proj(x0, y0, -SLAB_M * k), proj(x1, y1, -SLAB_M * k)], fill=shade(col, 0.9), width=SS * 2)
dr.polygon([proj(x, y) for x, y in corners], fill=C["ground"])

# ---------------------------------------------------------------- ground layers
GORDER = {"construction": 0, "commercial": 0, "grass": 1, "grassland": 1, "park": 2, "forest": 3,
          "parking": 4, "playground": 5, "pitch": 6}
for poly, kind, t in sorted(ground, key=lambda g: GORDER.get(g[1], 0)):
    p = poly.intersection(TILE)
    if p.is_empty:
        continue
    col = {
        "grass": C["grass"], "grassland": C["grass"], "park": C["park"], "forest": C["forest"],
        "parking": C["parking"], "pitch": C["pitch"], "construction": C["construction"],
        "commercial": C["commercial"], "playground": (230, 200, 150),
    }.get(kind)
    if col is None:
        continue
    fill_poly(p, 0, col)
    if kind == "pitch":
        fill_poly(p.buffer(-1.5), 0, None, outline=C["pitch_line"], width=SS * 2)
    if kind == "parking":
        # parking bay stripes
        minx, miny, maxx, maxy = p.bounds
        xx = minx
        while xx < maxx:
            seg = LineString([(xx, miny), (xx, maxy)]).intersection(p.buffer(-1))
            for s in ([seg] if seg.geom_type == "LineString" else getattr(seg, "geoms", [])):
                if s.length > 0:
                    dr.line([proj(*c) for c in s.coords], fill=(235, 232, 225), width=SS)
            xx += 2.6

# ---------------------------------------------------------------- roads
RW = {"primary": 16, "primary_link": 8, "secondary": 13, "tertiary": 11, "residential": 7.5,
      "service": 4.5, "footway": 2.2, "cycleway": 2.4, "steps": 2.2, "pedestrian": 4, "path": 1.8}


def road_poly(ls, w):
    return ls.buffer(w / 2, cap_style=1, join_style=1).intersection(TILE)


car = [(ls, k) for ls, k in roads if k not in ("footway", "cycleway", "steps", "path", "pedestrian")]
foot = [(ls, k) for ls, k in roads if (ls, k) not in car]
for ls, k in foot:
    fill_poly(road_poly(ls, RW.get(k, 2)), 0, C["footway"])
# curb edge then asphalt
fill_poly(unary_union([road_poly(ls, RW.get(k, 5) + 1.6) for ls, k in car]), 0, C["road_edge"])
fill_poly(unary_union([road_poly(ls, RW.get(k, 5)) for ls, k in car if k not in ("primary", "primary_link")]), 0, C["road"])
fill_poly(unary_union([road_poly(ls, RW.get(k, 5)) for ls, k in car if k in ("primary", "primary_link")]), 0, C["primary"])
# centre dashes on bigger roads
for ls, k in car:
    if k in ("primary", "tertiary", "secondary", "residential"):
        lsc = ls.intersection(TILE.buffer(-2))
        for s in ([lsc] if lsc.geom_type == "LineString" else getattr(lsc, "geoms", [])):
            if s.geom_type != "LineString" or s.length < 6:
                continue
            dist = 2.0
            while dist + 3 < s.length:
                a, b = s.interpolate(dist), s.interpolate(dist + 3)
                dr.line([proj(a.x, a.y), proj(b.x, b.y)], fill=(215, 205, 180), width=SS * 2)
                dist += 7

# ---------------------------------------------------------------- cast shadows (on ground)
sx, sy, sz = SUN
shadow_shapes = []
for it in items:
    h = it["h"]
    off = (-sx / sz * h, -sy / sz * h)
    if it["type"] == "bldg":
        p = it["poly"]
        ring = list(p.exterior.coords)
        quads = [p, Polygon([(x + off[0], y + off[1]) for x, y in ring])]
        for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
            q = Polygon([(x0, y0), (x1, y1), (x1 + off[0], y1 + off[1]), (x0 + off[0], y0 + off[1])])
            if q.is_valid and q.area > 0:
                quads.append(q)
        shadow_shapes.append(unary_union(quads))
    else:
        shadow_shapes.append(Point(it["x"] + off[0] * 0.8, it["y"] + off[1] * 0.8).buffer(it["r"] * 0.9, 10))
shadow = unary_union(shadow_shapes).intersection(TILE)
shadow_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow_layer)
for p in ([shadow] if shadow.geom_type == "Polygon" else shadow.geoms):
    if p.geom_type != "Polygon":
        continue
    sd.polygon([proj(x, y) for x, y in p.exterior.coords], fill=(52, 48, 84, 255))
    for hole in p.interiors:
        sd.polygon([proj(x, y) for x, y in hole.coords], fill=(0, 0, 0, 0))
alpha = shadow_layer.split()[3].point(lambda a: int(a * 0.24)).filter(ImageFilter.GaussianBlur(SS * 1.2))
shadow_layer.putalpha(alpha)
img.paste(shadow_layer, (0, 0), shadow_layer)
dr = ImageDraw.Draw(img, "RGBA")


# ---------------------------------------------------------------- buildings & trees
def draw_windows(p0, p1, h, lv, kind, wall_col):
    (x0, y0), (x1, y1) = p0, p1
    L = math.hypot(x1 - x0, y1 - y0)
    if L < 2.5:
        return
    floor_h = (h - 0.6) / lv if kind != "house" else h / lv
    spacing = 2.6 if kind in ("apartments", "civic") else 3.2
    n = int((L - 1.2) // spacing)
    if n < 1:
        return
    pad = (L - n * spacing) / 2
    win = shade(wall_col, 0.62)
    glint = (180, 200, 214)
    for f in range(lv):
        if kind == "retail" and f == 0:
            # shopfront band
            a, b = 0.06, 0.94
            z0, z1 = 0.4, floor_h * 0.8
            q = [(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a), (x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)]
            dr.polygon([proj(*q[0], z0), proj(*q[1], z0), proj(*q[1], z1), proj(*q[0], z1)], fill=(150, 176, 196))
            continue
        z0 = f * floor_h + floor_h * 0.32
        z1 = f * floor_h + floor_h * 0.78
        for k in range(n):
            s0 = (pad + k * spacing + spacing * 0.22) / L
            s1 = (pad + k * spacing + spacing * 0.78) / L
            ax, ay = x0 + (x1 - x0) * s0, y0 + (y1 - y0) * s0
            bx, by = x0 + (x1 - x0) * s1, y0 + (y1 - y0) * s1
            col = glint if random.random() < 0.08 else win
            dr.polygon([proj(ax, ay, z0), proj(bx, by, z0), proj(bx, by, z1), proj(ax, ay, z1)], fill=col)
        if kind == "apartments" and f > 0:
            # balcony slab line, typical of Dardania blocks
            dr.line([proj(x0, y0, f * floor_h), proj(x1, y1, f * floor_h)], fill=shade(wall_col, 0.86), width=SS)


def draw_building(it):
    p, h, kind, lv = it["poly"], it["h"], it["kind"], it["lv"]
    base = WALL.get(kind, WALL["apartments"])
    if kind == "apartments" and int(p.area) % 3 == 0:
        base = WALL["apartments_b"]
    ring = list(p.exterior.coords)
    if not p.exterior.is_ccw:
        ring = ring[::-1]
    pitched = kind == "house" and len(ring) <= 9
    wall_top = h
    # walls (ccw ring -> outward normal is (dy, -dx))
    walls = []
    for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
        nx, ny = (y1 - y0), -(x1 - x0)
        L = math.hypot(nx, ny)
        if L < 1e-6:
            continue
        nx, ny = nx / L, ny / L
        if uv(nx, ny)[1] >= 0:
            continue
        walls.append(((x0, y0), (x1, y1), nx, ny))
    # draw farther walls first within the building
    walls.sort(key=lambda w: -(depth_v(*w[0]) + depth_v(*w[1])))
    for (a, b, nx, ny) in walls:
        col = shade(base, light_k(nx, ny))
        dr.polygon([proj(*a, 0), proj(*b, 0), proj(*b, wall_top), proj(*a, wall_top)], fill=col)
        if kind != "construction":
            draw_windows(a, b, wall_top, lv, kind, col)
        dr.line([proj(*a, 0), proj(*a, wall_top)], fill=shade(col, 0.9), width=SS)
    # roof
    if pitched:
        cx, cy = p.centroid.x, p.centroid.y
        rh = 2.4
        faces = []
        for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
            faces.append(((x0, y0), (x1, y1)))
        faces.sort(key=lambda f: -(depth_v(*f[0]) + depth_v(*f[1])))
        for (x0, y0), (x1, y1) in faces:
            ex, ey = x1 - x0, y1 - y0
            ax, ay = cx - x0, cy - y0
            # face normal of triangle (p0, p1, apex)
            ux, uy, uz = ex, ey, 0
            vx, vy, vz = ax, ay, rh
            nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
            L = math.sqrt(nx * nx + ny * ny + nz * nz) or 1
            k = light_k(nx / L, ny / L, nz / L)
            dr.polygon([proj(x0, y0, wall_top), proj(x1, y1, wall_top), proj(cx, cy, wall_top + rh)],
                       fill=shade(ROOF["house"], k))
    else:
        rc = ROOF.get(kind, ROOF["apartments"])
        fill_poly(p, wall_top, shade(rc, 1.06))
        if kind != "construction" and p.area > 120:
            inner = p.buffer(-0.9, join_style=2)
            if not inner.is_empty:
                fill_poly(inner, wall_top, shade(rc, 0.97))
            # rooftop details: stairwell boxes / AC units on big flat roofs
            if kind in ("apartments", "civic", "retail") and p.area > 500:
                rp = p.representative_point()
                hut = box(rp.x - 2.2, rp.y - 1.8, rp.x + 2.2, rp.y + 1.8).intersection(inner if not inner.is_empty else p)
                if not hut.is_empty and hut.geom_type == "Polygon":
                    hh = 2.2
                    hr = list(hut.exterior.coords)
                    if not hut.exterior.is_ccw:
                        hr = hr[::-1]
                    for (x0, y0), (x1, y1) in zip(hr, hr[1:]):
                        nx, ny = (y1 - y0), -(x1 - x0)
                        L = math.hypot(nx, ny) or 1
                        if uv(nx / L, ny / L)[1] < 0:
                            dr.polygon([proj(x0, y0, wall_top), proj(x1, y1, wall_top), proj(x1, y1, wall_top + hh),
                                        proj(x0, y0, wall_top + hh)], fill=shade(WALL["apartments_b"], light_k(nx / L, ny / L)))
                    fill_poly(hut, wall_top + hh, shade(rc, 1.1))
        if kind == "construction":
            # scaffolding grid + crane mast hint
            minx, miny, maxx, maxy = p.bounds
            xx = minx
            while xx < maxx:
                seg = LineString([(xx, miny), (xx, maxy)]).intersection(p)
                for s in ([seg] if seg.geom_type == "LineString" else getattr(seg, "geoms", [])):
                    if s.length > 0:
                        dr.line([proj(*c, wall_top) for c in s.coords], fill=(170, 140, 100), width=SS)
                xx += 4
    if kind == "construction" and p.area > 2000:
        rp = p.representative_point()
        mx, my = rp.x, rp.y
        top_z = 46
        mast_col = (226, 170, 60)
        for ox, oy in ((-0.8, -0.8), (0.8, -0.8), (0.8, 0.8), (-0.8, 0.8)):
            dr.line([proj(mx + ox, my + oy, 0), proj(mx + ox, my + oy, top_z)], fill=mast_col, width=SS * 2)
        z = 0
        while z < top_z:
            dr.line([proj(mx - 0.8, my - 0.8, z), proj(mx + 0.8, my - 0.8, z + 2.5)], fill=mast_col, width=SS)
            z += 2.5
        # jib and counter-jib along the ground x axis
        dr.line([proj(mx - 12, my, top_z), proj(mx + 34, my, top_z)], fill=mast_col, width=SS * 3)
        dr.line([proj(mx, my, top_z + 6), proj(mx + 34, my, top_z)], fill=mast_col, width=SS)
        dr.line([proj(mx, my, top_z + 6), proj(mx - 12, my, top_z)], fill=mast_col, width=SS)
        dr.polygon([proj(mx - 12, my - 1.2, top_z - 2.5), proj(mx - 8, my - 1.2, top_z - 2.5),
                    proj(mx - 8, my - 1.2, top_z), proj(mx - 12, my - 1.2, top_z)], fill=(120, 120, 120))
        # hook line
        dr.line([proj(mx + 24, my, top_z), proj(mx + 24, my, 12)], fill=(90, 90, 90), width=SS)
    # crisp outline of the top edge
    top = [proj(x, y, wall_top) for x, y in ring]
    dr.line(top, fill=shade(base, 0.7), width=SS)


def draw_tree(it):
    x, y, r, h, col = it["x"], it["y"], it["r"], it["h"], it["col"]
    bx, by = proj(x, y, 0)
    tx, ty = proj(x, y, h * 0.55)
    dr.line([(bx, by), (tx, ty)], fill=C["trunk"], width=int(SS * 2.2))
    cx, cy = proj(x, y, h * 0.72)
    rp = r * PX_PER_M
    # canopy: three stacked blobs with highlight
    for dx, dy, k, s in ((-0.25, 0.15, 0.82, 0.8), (0.25, 0.1, 0.9, 0.82), (0, -0.2, 1.0, 0.9)):
        cr = rp * s
        ccx, ccy = cx + dx * rp, cy + dy * rp
        dr.ellipse([ccx - cr, ccy - cr, ccx + cr, ccy + cr], fill=shade(col, k))
    hr = rp * 0.35
    dr.ellipse([cx - rp * 0.35 - hr, cy - rp * 0.45 - hr, cx - rp * 0.35 + hr, cy - rp * 0.45 + hr], fill=shade(col, 1.18))


for i in order:
    it = items[i]
    if it["type"] == "bldg":
        draw_building(it)
    else:
        draw_tree(it)

# ---------------------------------------------------------------- title + attribution
def font(sz, bold=False):
    for path in ("/System/Library/Fonts/Supplemental/Georgia Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Georgia.ttf",
                 "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(path, sz)
        except OSError:
            continue
    return ImageFont.load_default()


dr.text((70 * SS, 48 * SS), "Rruga Isa Boletini, Prishtinë", fill=C["ink"], font=font(46 * SS, True))
dr.text((72 * SS, 104 * SS), "Dardania · 300 m × 300 m tile · 42.6525° N, 21.1565° E",
        fill=shade(C["ink"], 1.6), font=font(22 * SS))
dr.text((70 * SS, H - 50 * SS), "Data © OpenStreetMap contributors (ODbL). Heights estimated where OSM has none.",
        fill=shade(C["ink"], 1.8), font=font(18 * SS))

# north arrow (north = +y on ground)
nx0, ny0 = OUT_W * SS - 150 * SS, 90 * SS
ax, ay = uv(0, 1)
L = 46 * SS
tipx, tipy = nx0 + ax * L, ny0 - ay * SP * L / max(abs(ay * SP), 1e-6) * abs(ay * SP)
dr.line([(nx0, ny0), (nx0 + ax * L, ny0 - ay * SP * L)], fill=C["ink"], width=SS * 3)
ex, ey = nx0 + ax * L, ny0 - ay * SP * L
ang = math.atan2(ey - ny0, ex - nx0)
for da in (2.6, -2.6):
    dr.line([(ex, ey), (ex + 14 * SS * math.cos(ang + da), ey + 14 * SS * math.sin(ang + da))], fill=C["ink"], width=SS * 3)
dr.text((nx0 + ax * L + 8 * SS, ny0 - ay * SP * L - 26 * SS), "N", fill=C["ink"], font=font(24 * SS, True))

out = img.resize((OUT_W, H // SS), Image.LANCZOS)
out.save("tile_isa_boletini.png")
print("saved tile_isa_boletini.png", out.size, "items", len(items), "trees", len(trees))
