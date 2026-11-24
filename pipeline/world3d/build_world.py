"""Build the game world (world.json + ground tiles + roof atlas) for one area from data.

Inputs (in <work_dir>): ortho_raw/o_<i>_<j>.png and ortho.json from `node world3d/ortho.mjs`, and an
OpenStreetMap extract (downloaded from Overpass on first run, cached as osm.json).

Everything placed in the game comes from here:
  - buildings: OSM footprints; roof art and colour from the orthophoto; height from the length of
    the building's shadow in the photo (calibrated so a typical villa is TYPICAL_VILLA_H), roof
    shape from roof colour + footprint shape
  - roads / paths / pools / parks / pitches / named places: OSM
  - trees: dark-green canopy blobs found in the orthophoto (inside built-up land only), with the
    photo's colour and a size from the blob
  - terrain: height grid sampled from Google's 3D surface

Usage: python world3d/build_world.py <work_dir> <export_dir> [name]
"""
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely import affinity
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union
from shapely.geometry.polygon import orient
from shapely.validation import make_valid

TYPICAL_VILLA_H = 7.0  # m, two storeys + parapet; sets the shadow-length scale
ROAD_WIDTH = {
    "motorway": 11.0, "trunk": 10.0, "primary": 9.0, "secondary": 8.0, "tertiary": 7.0,
    "unclassified": 6.0, "residential": 6.0, "living_street": 5.0, "service": 4.0,
    "motorway_link": 5.0, "trunk_link": 5.0, "primary_link": 5.0, "tertiary_link": 5.0,
}
PATH_KINDS = {"footway", "pedestrian", "path", "steps", "cycleway", "track"}
# Floor counts for named buildings the photo can't measure well (tower on a podium), with sources.
KNOWN = {
    # 5 floors: successfulmeetings.com and expedia.com venue listings for Four Points Prishtina City
    "Four Points by Sheraton": 5,
}

work = Path(sys.argv[1])
export = Path(sys.argv[2])
name = sys.argv[3] if len(sys.argv) > 3 else "Marigona Residence"
meta = json.loads((work / "ortho.json").read_text())
N, CORE, MPP, SIZE = meta["tiles"], meta["core"], meta["mPerPx"], meta["sizeM"]
LAT0, LON0, M_LAT, M_LON = meta["lat"], meta["lon"], meta["mLat"], meta["mLon"]
HALF = SIZE / 2
area_box = box(-HALF, -HALF, HALF, HALF)


def local(lat, lon):
    return ((lon - LON0) * M_LON, (lat - LAT0) * M_LAT)


def to_px(x, y):
    return ((x + HALF) / MPP, (HALF - y) / MPP)


# ---------------------------------------------------------------- orthophoto mosaic
W = N * CORE
mosaic = np.zeros((W, W, 3), np.uint8)
for j in range(N):
    for i in range(N):
        t = Image.open(work / "ortho_raw" / f"o_{i}_{j}.png").convert("RGB")
        mosaic[j * CORE:(j + 1) * CORE, i * CORE:(i + 1) * CORE] = np.asarray(t)
lum = mosaic.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
print("mosaic", mosaic.shape)

# ---------------------------------------------------------------- OSM
osm_path = work / "osm.json"
if not osm_path.exists():
    s, w = LAT0 - HALF / M_LAT, LON0 - HALF / M_LON
    n, e = LAT0 + HALF / M_LAT, LON0 + HALF / M_LON
    q = f"[out:json][timeout:120];(nwr({s},{w},{n},{e}););out body geom;"
    req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                 data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": "kosmaps-prototype"})
    osm_path.write_bytes(urllib.request.urlopen(req, timeout=180).read())
elements = json.loads(osm_path.read_text())["elements"]


def way_pts(geom):
    return [local(g["lat"], g["lon"]) for g in geom]


def polygon_of(el):
    """Outer polygon (shapely) of a closed way or multipolygon relation, in local metres."""
    if el["type"] == "way" and "geometry" in el and len(el["geometry"]) >= 4:
        rings = [way_pts(el["geometry"])]
    elif el["type"] == "relation":
        rings = [way_pts(m["geometry"]) for m in el.get("members", [])
                 if m.get("role") == "outer" and "geometry" in m and len(m["geometry"]) >= 4]
    else:
        return None
    polys = []
    for r in rings:
        p = make_valid(Polygon(r))
        polys += [g for g in getattr(p, "geoms", [p]) if g.geom_type == "Polygon"]
    if not polys:
        return None
    p = max(polys, key=lambda g: g.area).intersection(area_box)
    if p.is_empty or p.geom_type != "Polygon":
        return None
    return orient(p, 1.0)


def ring(p, nd=2):
    return [[round(x, nd), round(y, nd)] for x, y in list(p.exterior.coords)[:-1]]


def poly_mask(p, pad=0):
    """Boolean mask of polygon p over its pixel bbox; returns (mask, x0, y0)."""
    minx, miny, maxx, maxy = p.bounds
    x0, y0 = int(math.floor((minx + HALF) / MPP)) - pad, int(math.floor((HALF - maxy) / MPP)) - pad
    x1, y1 = int(math.ceil((maxx + HALF) / MPP)) + pad, int(math.ceil((HALF - miny) / MPP)) + pad
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, W)
    img = Image.new("L", (max(x1 - x0, 1), max(y1 - y0, 1)), 0)
    ImageDraw.Draw(img).polygon([(px - x0, py - y0) for px, py in (to_px(*c) for c in p.exterior.coords)], fill=1)
    return np.asarray(img, bool), x0, y0


# ---------------------------------------------------------------- buildings
raw_buildings = []
for el in elements:
    t = el.get("tags", {})
    if "building" not in t or t.get("building") in ("no", "roof"):
        continue
    p = polygon_of(el)
    if p is None or p.area < 6:
        continue
    raw_buildings.append((el, t, p))
print("buildings", len(raw_buildings))

# built-up mask (buildings), used to keep trees off roofs and to stop shadow rays at walls
built = np.zeros((W, W), bool)
for _, _, p in raw_buildings:
    m, x0, y0 = poly_mask(p)
    built[y0:y0 + m.shape[0], x0:x0 + m.shape[1]] |= m


# ---------------------------------------------------------------- roof shift (lean) registration
# The photo is not a true orthophoto: every roof is drawn shifted away from the camera, by an amount
# proportional to the building's height, while footprints (and roads) sit where they really are.
# Find each roof by sliding the footprint outline over the photo's edges. The shift direction is
# shared by the whole area (found from the villas); its length gives a second height measurement.
lum_s = ndimage.gaussian_filter(lum, 1.0)
grad_x, grad_y = ndimage.sobel(lum_s, 1), ndimage.sobel(lum_s, 0)


def outline(p, step=0.3):
    coords = list(p.exterior.coords)
    pts, nrm = [], []
    for (ax, ay), (bx, by) in zip(coords[:-1], coords[1:]):
        ex, ey = bx - ax, by - ay
        L = math.hypot(ex, ey)
        if L < 0.5:
            continue
        for s in np.arange(0.2, L - 0.2, step):
            pts.append((ax + ex * s / L, ay + ey * s / L))
            nrm.append((ey / L, -ex / L))
    return np.array(pts), np.array(nrm)


def edge_score(pts, nrm, dx, dy):
    """Mean photo gradient across the outline shifted by (dx, dy) metres."""
    ix = np.clip(((pts[:, 0] + dx + HALF) / MPP).astype(int), 0, W - 1)
    iy = np.clip(((HALF - pts[:, 1] - dy) / MPP).astype(int), 0, W - 1)
    return float(np.abs(grad_x[iy, ix] * nrm[:, 0] - grad_y[iy, ix] * nrm[:, 1]).mean())


outlines = {el["id"]: outline(p) for el, _, p in raw_buildings}
villa_shifts = []
S2 = np.arange(-7, 7.01, 0.4)
for el, t, p in raw_buildings:
    pts, nrm = outlines[el["id"]]
    if not (60 < p.area < 450) or len(pts) < 10:
        continue
    best = max(((edge_score(pts, nrm, dx, dy), dx, dy) for dx in S2 for dy in S2))
    villa_shifts.append(best[1:])
vs = np.array(villa_shifts)
LEAN = np.median(vs, axis=0)
LEAN_LEN = float(np.hypot(*LEAN))
lean_u = LEAN / LEAN_LEN
lean_v = np.array([-lean_u[1], lean_u[0]])
print(f"roof lean: {LEAN_LEN:.2f} m towards {math.degrees(math.atan2(lean_u[0], lean_u[1])) % 360:.0f}° "
      f"for a typical villa (from {len(vs)} villas)")

roof_shift, lean_len = {}, {}
T_RANGE = np.arange(0, LEAN_LEN * 4.5, 0.3)
P_RANGE = np.arange(-1.5, 1.51, 0.5)
for el, t, p in raw_buildings:
    pts, nrm = outlines[el["id"]]
    if len(pts) < 8:
        roof_shift[el["id"]] = (0.0, 0.0)
        continue
    best = max(((edge_score(pts, nrm, *(lean_u * tt + lean_v * pp)) * (1 - 0.03 * abs(pp)), tt, pp)
                for tt in T_RANGE for pp in P_RANGE))
    _, tt, pp = best
    roof_shift[el["id"]] = tuple(float(v) for v in lean_u * tt + lean_v * pp)
    lean_len[el["id"]] = float(tt)
    nk = t.get("name") or t.get("brand") or ""
    if nk in KNOWN:  # a tower on a podium has no single shift; use the one its known height implies
        hk = KNOWN[nk] * 3.4 + 1.5
        roof_shift[el["id"]] = tuple(float(v) for v in lean_u * LEAN_LEN * hk / TYPICAL_VILLA_H)


def shadow_rays(p, d):
    """Shadow lengths (m) cast from the building's walls facing direction d (unit, local metres)."""
    coords = list(p.exterior.coords)
    out = []
    for (ax, ay), (bx, by) in zip(coords[:-1], coords[1:]):
        ex, ey = bx - ax, by - ay
        L = math.hypot(ex, ey)
        if L < 1.5:
            continue
        nx, ny = ey / L, -ex / L  # outward normal of a CCW ring
        if nx * d[0] + ny * d[1] < 0.35:
            continue
        for s in np.arange(0.6, L - 0.6, 0.6):
            sx, sy = ax + ex * s / L + nx * 0.3, ay + ey * s / L + ny * 0.3
            run, gap = 0.0, 0
            for k in range(1, 300):  # up to 60 m
                px, py = to_px(sx + d[0] * k * MPP, sy + d[1] * k * MPP)
                ix, iy = int(px), int(py)
                if not (0 <= ix < W and 0 <= iy < W) or built[iy, ix]:
                    break
                if lum[iy, ix] < dark_thr:
                    run, gap = k * MPP, 0
                else:
                    gap += 1
                    if gap > 3:
                        break
            out.append(run)
    return out


# Shadow direction: the azimuth whose neighbouring ground is darkest, summed over all buildings.
dark_thr = float(np.percentile(lum, 12))
best = None
for az in range(0, 360, 10):
    d = (math.sin(math.radians(az)), math.cos(math.radians(az)))
    score = []
    for _, _, p in raw_buildings[::3]:
        rays = shadow_rays(p, d)
        if rays:
            score.append(np.mean(rays))
    v = float(np.mean(score)) if score else 0
    if best is None or v > best[1]:
        best = (az, v)
az0 = best[0]
for az in np.arange(az0 - 8, az0 + 9, 2):
    d = (math.sin(math.radians(az)), math.cos(math.radians(az)))
    v = float(np.mean([np.mean(r) for r in (shadow_rays(p, d) for _, _, p in raw_buildings[::3]) if r]))
    if v > best[1]:
        best = (float(az), v)
SHADOW_AZ = best[0]
shadow_d = (math.sin(math.radians(SHADOW_AZ)), math.cos(math.radians(SHADOW_AZ)))
print(f"shadow azimuth {SHADOW_AZ:.0f}° (sun from {(SHADOW_AZ + 180) % 360:.0f}°)")

shadow_len = {}
for el, t, p in raw_buildings:
    rays = shadow_rays(p, shadow_d)
    if len(rays) >= 3:
        shadow_len[el["id"]] = float(np.percentile(rays, 70))
villas = [shadow_len[el["id"]] for el, t, p in raw_buildings
          if el["id"] in shadow_len and 60 < p.area < 450 and shadow_len[el["id"]] > 0.5]
K = TYPICAL_VILLA_H / float(np.median(villas))
SUN_ELEV = math.degrees(math.atan(K))
print(f"villa shadow median {np.median(villas):.2f} m from {len(villas)} villas -> sun elevation ≈ {SUN_ELEV:.0f}°")


def is_terracotta(c):
    r, g, b = c
    return r > g * 1.12 and r > b * 1.3 and r > 90


buildings = []
atlas_items = []
for el, t, p in raw_buildings:
    m, x0, y0 = poly_mask(p)
    core = ndimage.binary_erosion(m, iterations=3) if m.sum() > 60 else m
    px = mosaic[y0:y0 + m.shape[0], x0:x0 + m.shape[1]][core if core.any() else m]
    roof_c = [int(v) for v in np.median(px, axis=0)]
    terracotta = is_terracotta(roof_c)

    nm_key = t.get("name") or t.get("brand") or ""
    levels = None
    if "building:levels" in t:
        try:
            levels = float(t["building:levels"])
        except ValueError:
            pass
    if "height" in t:
        try:
            h, src = float(t["height"].split()[0]), "osm"
        except ValueError:
            h, src = None, None
    else:
        h, src = None, None
    if h is None and levels:
        h, src = levels * 3.2 + 1.0, "osm"
    if h is None and nm_key in KNOWN:
        levels = KNOWN[nm_key]
        h, src = levels * 3.4 + 1.5, "known"
    if h is None:
        # two independent measurements from the photo, both scaled so a typical villa is 7 m
        est = []
        L = shadow_len.get(el["id"])
        if L is not None and L > 0.5:
            est.append(K * L)
        if el["id"] in lean_len and lean_len[el["id"]] > 0.3:
            est.append(TYPICAL_VILLA_H * lean_len[el["id"]] / LEAN_LEN)
        small = p.area < 450
        if est:
            # disagreeing measurements: shadows run into other dark things, so trust the lower one
            h = float(np.mean(est)) if len(est) == 1 or max(est) < 1.6 * min(est) else min(est)
            src = "photo"
            h = min(max(h, 4.5), 10.5) if small else max(h, 4.0)
        else:
            h, src = (3.0 if p.area < 30 else TYPICAL_VILLA_H if small else 8.0), "typical"
    lv = levels or max(1, round((h - 1.0) / 3.2))

    rect = p.minimum_rotated_rectangle
    rc = list(rect.exterior.coords)
    e1 = (rc[1][0] - rc[0][0], rc[1][1] - rc[0][1])
    e2 = (rc[2][0] - rc[1][0], rc[2][1] - rc[1][1])
    l1, l2 = math.hypot(*e1), math.hypot(*e2)
    ang = math.atan2(e1[1], e1[0])
    obb = {"c": [round(rect.centroid.x, 2), round(rect.centroid.y, 2)],
           "hx": round(l1 / 2, 2), "hy": round(l2 / 2, 2), "a": round(ang, 4)}
    rectangularity = p.area / max(rect.area, 1e-6)
    hip = terracotta and rectangularity > 0.82 and p.area < 900
    roof_h = round(min(l1, l2) * 0.28, 2) if hip else 0.0

    if terracotta:
        wall = [236, 226, 208]
    else:  # flat modern villas: walls a touch warmer and darker than the (white) roof
        lumr = sum(roof_c) / 3
        wall = [int(min(245, 0.55 * c + 0.45 * lumr + 18)) for c in roof_c]
        wall = [min(245, wall[0] + 4), wall[1], max(0, wall[2] - 6)]

    sx, sy = roof_shift.get(el["id"], (0.0, 0.0))
    minx, miny, maxx, maxy = p.bounds
    minx, maxx, miny, maxy = minx + sx, maxx + sx, miny + sy, maxy + sy
    bx0 = int(math.floor((minx + HALF) / MPP)) - 2
    by0 = int(math.floor((HALF - maxy) / MPP)) - 2
    bx1 = int(math.ceil((maxx + HALF) / MPP)) + 2
    by1 = int(math.ceil((HALF - miny) / MPP)) + 2
    bx0, by0, bx1, by1 = max(bx0, 0), max(by0, 0), min(bx1, W), min(by1, W)
    atlas_items.append((len(buildings), bx0, by0, bx1 - bx0, by1 - by0))
    bbox_m = [bx0 * MPP - HALF, HALF - by1 * MPP, bx1 * MPP - HALF, HALF - by0 * MPP]

    b = {
        "id": f"{el['type']}/{el['id']}", "kind": t.get("building", "yes"),
        "poly": ring(p), "h": round(h, 2), "hSource": src, "roof": "hip" if hip else "flat",
        "roofH": roof_h, "obb": obb, "roofColor": roof_c, "wallColor": wall,
        "atlas": [0, 0, 0, 0], "bbox": [round(v, 3) for v in bbox_m], "levels": int(lv),
        "roofShift": [round(sx, 2), round(sy, 2)],
    }
    nm = t.get("name") or t.get("brand")
    if nm:
        b["name"] = nm
    if "amenity" in t or "tourism" in t or "shop" in t:
        b["kind"] = t.get("tourism") or t.get("amenity") or t.get("shop")
    buildings.append(b)

# Villas: one building's photo measurement is noisy (±3 m), but houses along a street are built to the
# same few designs. Use the median of each villa's 9 nearest villas, snapped to whole floors.
FLOOR_H = 3.2
vill = [k for k, b in enumerate(buildings) if b["hSource"] == "photo" and 60 < Polygon(b["poly"]).area < 450]
cent = np.array([Polygon(buildings[k]["poly"]).centroid.coords[0] for k in vill])
raw_h = np.array([buildings[k]["h"] for k in vill])
for n, k in enumerate(vill):
    near = np.argsort(np.hypot(*(cent - cent[n]).T))[:9]
    med = float(np.median(raw_h[near]))
    floors = 2 if med < 8.8 else 3  # the estate is two-storey villas; low readings are shadows lost in hedges
    buildings[k]["h"] = round(floors * FLOOR_H + 0.6, 2)
    buildings[k]["levels"] = floors
print("villa floors after neighbourhood smoothing:",
      {f: sum(buildings[k]["levels"] == f for k in vill) for f in (1, 2, 3)})

# Roof atlas: shelf-pack each building's bbox crop of the orthophoto.
ATLAS_W = 4096
atlas_items.sort(key=lambda a: -a[4])
x = y = shelf = 0
placed = []
for idx, bx0, by0, w, h in atlas_items:
    if x + w > ATLAS_W:
        x, y, shelf = 0, y + shelf + 2, 0
    placed.append((idx, x, y, bx0, by0, w, h))
    x += w + 2
    shelf = max(shelf, h)
atlas_h = y + shelf
atlas_h = int(math.ceil(atlas_h / 4) * 4)
atlas = np.zeros((atlas_h, ATLAS_W, 3), np.uint8)
for idx, ax, ay, bx0, by0, w, h in placed:
    atlas[ay:ay + h, ax:ax + w] = mosaic[by0:by0 + h, bx0:bx0 + w]
    buildings[idx]["atlas"] = [ax, ay, w, h]
print("roof atlas", ATLAS_W, "x", atlas_h)

# Ghost roofs: in the photo each roof (and the wall facing the camera) is drawn beside its footprint.
# The game stands a 3D building on the footprint, so paint those leftovers out of the ground photo.
ghost = np.zeros((W, W), bool)
for el, t, p in raw_buildings:
    sx, sy = roof_shift.get(el["id"], (0.0, 0.0))
    if abs(sx) + abs(sy) < 0.2:
        continue
    g = unary_union([p, affinity.translate(p, sx, sy)]).convex_hull.buffer(0.8)
    m, x0, y0 = poly_mask(g)
    ghost[y0:y0 + m.shape[0], x0:x0 + m.shape[1]] |= m

# ---------------------------------------------------------------- roads, paths, areas, places
roads, paths, areas, places = [], [], [], []
residential = []
for el in elements:
    t = el.get("tags", {})
    if el["type"] == "way" and "highway" in t and "geometry" in el:
        hw = t["highway"]
        line = LineString(way_pts(el["geometry"])).intersection(area_box)
        if line.is_empty:
            continue
        parts = getattr(line, "geoms", [line])
        for k, part in enumerate(parts):
            if part.geom_type != "LineString" or part.length < 2:
                continue
            pts = [[round(a, 2), round(b, 2)] for a, b in part.coords]
            rid = f"way/{el['id']}" + (f"#{k}" if len(parts) > 1 else "")
            if hw in ROAD_WIDTH and t.get("area") != "yes":
                width = ROAD_WIDTH[hw]
                if "lanes" in t:
                    try:
                        width = max(width, float(t["lanes"]) * 3.3)
                    except ValueError:
                        pass
                r = {"id": rid, "kind": hw, "width": width,
                     "oneway": t.get("oneway") in ("yes", "1") or hw in ("motorway", "motorway_link")
                     or t.get("junction") == "roundabout", "pts": pts}
                if t.get("name"):
                    r["name"] = t["name"]
                roads.append(r)
            elif hw in PATH_KINDS:
                paths.append({"id": rid, "kind": hw, "pts": pts})
        continue
    kind = None
    if t.get("leisure") == "swimming_pool" or t.get("amenity") == "swimming_pool":
        kind = "pool"
    elif t.get("leisure") in ("park", "garden"):
        kind = "park"
    elif t.get("leisure") == "pitch":
        kind = "pitch"
    elif t.get("leisure") == "playground":
        kind = "playground"
    elif t.get("amenity") == "parking":
        kind = "parking"
    elif t.get("landuse") == "grass":
        kind = "grass"
    if kind and el["type"] in ("way", "relation"):
        p = polygon_of(el)
        if p is not None and p.area > 4:
            a = {"id": f"{el['type']}/{el['id']}", "kind": kind, "poly": ring(p)}
            if t.get("name"):
                a["name"] = t["name"]
            areas.append(a)
    if t.get("landuse") == "residential" and el["type"] in ("way", "relation"):
        p = polygon_of(el)
        if p is not None:
            residential.append(p)
    nm = t.get("name")
    pk = t.get("amenity") or t.get("shop") or t.get("tourism") or t.get("leisure")
    if nm and pk and "highway" not in t:
        if el["type"] == "node":
            x, y = local(el["lat"], el["lon"])
        else:
            p = polygon_of(el)
            if p is None:
                continue
            x, y = p.representative_point().x, p.representative_point().y
        if abs(x) < HALF and abs(y) < HALF:
            places.append({"name": nm, "kind": pk, "x": round(x, 2), "y": round(y, 2)})
print("roads", len(roads), "paths", len(paths), "areas", len(areas), "places", len(places))

# ---------------------------------------------------------------- trees from the photo
r_, g_, b_ = (mosaic[..., c].astype(np.int16) for c in range(3))
canopy = (g_ > r_ + 6) & (g_ >= b_) & (lum < 92) & (lum > 18)
# only on built-up land (the estate and parks), never in the open fields
land = np.zeros((W, W), bool)
for p in residential + [Polygon(a["poly"]) for a in areas if a["kind"] in ("park", "playground", "grass")]:
    m, x0, y0 = poly_mask(p.buffer(15), pad=0)
    land[y0:y0 + m.shape[0], x0:x0 + m.shape[1]] |= m
canopy &= land & ~ndimage.binary_dilation(built | ghost, iterations=3)
# canopy is textured; lawns and crops are smooth
lumf = ndimage.uniform_filter(lum, 7)
var = ndimage.uniform_filter(lum * lum, 7) - lumf * lumf
canopy &= var > 40
canopy = ndimage.binary_opening(canopy, iterations=2)
canopy = ndimage.binary_closing(canopy, iterations=1)
dist = ndimage.distance_transform_edt(canopy)
peaks = (dist == ndimage.maximum_filter(dist, size=11)) & (dist >= 4)
ys, xs = np.nonzero(peaks)
trees = []
taken = np.zeros((W, W), bool)
order = np.argsort(-dist[ys, xs])
for k in order:
    yy, xx = ys[k], xs[k]
    if taken[yy, xx]:
        continue
    rpx = dist[yy, xx]
    r = rpx * MPP + 0.4
    ylo, yhi = max(0, int(yy - rpx)), min(W, int(yy + rpx) + 1)
    xlo, xhi = max(0, int(xx - rpx)), min(W, int(xx + rpx) + 1)
    taken[ylo:yhi, xlo:xhi] = True
    c = mosaic[ylo:yhi, xlo:xhi][canopy[ylo:yhi, xlo:xhi]].mean(axis=0)
    tx, ty = xx * MPP - HALF, HALF - yy * MPP
    h = min(max(2.3 * r + 1.8, 3.0), 13.0)
    trees.append([round(tx, 2), round(ty, 2), round(r, 2), round(h, 2), int(c[0]), int(c[1]), int(c[2])])
print("trees", len(trees))

# Fill each ghost area with real ground from just beyond it: the roof hides the strip of ground on
# the lean side of the building, and the ground one roof-shift further along looks like it (lawn,
# paving). Step along the lean until the source pixel is clean, then soften the seams slightly.
ys, xs = np.nonzero(ghost)
src_y, src_x = ys.copy(), xs.copy()
todo = np.ones(len(ys), bool)
step_px = np.array([lean_u[0], -lean_u[1]]) * LEAN_LEN / MPP
for k in range(1, 12):
    sx_ = np.clip(np.round(xs + step_px[0] * k).astype(int), 0, W - 1)
    sy_ = np.clip(np.round(ys + step_px[1] * k).astype(int), 0, W - 1)
    ok = todo & ~ghost[sy_, sx_] & ~built[sy_, sx_]
    src_y[ok], src_x[ok] = sy_[ok], sx_[ok]
    todo &= ~ok
filled = mosaic.copy()
filled[ys, xs] = mosaic[src_y, src_x]
edge = ndimage.binary_dilation(ghost, iterations=2) & ~ndimage.binary_erosion(ghost, iterations=2)
soft = filled.copy()
for c in range(3):
    soft[..., c] = ndimage.uniform_filter(filled[..., c], 5)
filled[edge] = soft[edge]
mosaic = filled
print("ghost roofs painted out:", int(ghost.sum() * MPP * MPP), "m²")

# Shadow lift: the photo's shadows (trees, hedges, the photo's own buildings) would sit under the
# game's real-time sun as black stains. Find shadowed pixels (much darker than their surroundings)
# and scale each colour channel up to match the sunlit ground nearby. Statistics at 1/4 resolution.
def lift_shadows(img):
    f = 4
    small = np.asarray(Image.fromarray(img).resize((W // f, W // f), Image.BILINEAR)).astype(np.float32)
    L = small @ np.array([0.299, 0.587, 0.114], np.float32)
    M = ndimage.gaussian_filter(L, 25 / f)
    sh = ((L < 0.72 * M) & (L < 90)).astype(np.float32)
    lit = 1 - sh
    ws, wl = ndimage.gaussian_filter(sh, 40 / f) + 1e-3, ndimage.gaussian_filter(lit, 40 / f) + 1e-3
    gains = []
    for c in range(3):
        s_mean = ndimage.gaussian_filter(small[..., c] * sh, 40 / f) / ws
        l_mean = ndimage.gaussian_filter(small[..., c] * lit, 40 / f) / wl
        gains.append(np.clip((l_mean + 2) / (s_mean + 2), 1.0, 2.6))
    gain = np.stack(gains, -1)
    # full-resolution shadow mask (soft), gains upsampled
    Lf = img.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
    Mf = np.asarray(Image.fromarray(M.astype(np.float32)).resize((W, W), Image.BILINEAR))
    mask = ndimage.gaussian_filter(((Lf < 0.72 * Mf) & (Lf < 90)).astype(np.float32), 2.0)
    out = np.empty_like(img)
    for c in range(3):
        g = np.asarray(Image.fromarray(gain[..., c]).resize((W, W), Image.BILINEAR))
        out[..., c] = np.clip(img[..., c].astype(np.float32) * (1 + (g - 1) * mask), 0, 255).astype(np.uint8)
    return out, float(mask.mean())


mosaic, frac = lift_shadows(mosaic)
print(f"shadows lifted on {frac * 100:.0f}% of the ground photo")

# ---------------------------------------------------------------- terrain
dem = meta["dem"]
H = np.array([[np.nan if v is None else v for v in row] for row in dem["heights"]], np.float32)
if np.isnan(H).any():
    fill = ndimage.generic_filter(np.nan_to_num(H, nan=np.nanmedian(H)), np.median, size=5)
    H = np.where(np.isnan(H), fill, H)
H = ndimage.median_filter(H, size=3)
H = ndimage.gaussian_filter(H, 1.0)
H -= float(np.median(H))

# ---------------------------------------------------------------- export
export.mkdir(parents=True, exist_ok=True)
(export / "ground").mkdir(exist_ok=True)
TILE_PX = CORE
for j in range(N):
    for i in range(N):
        Image.fromarray(mosaic[j * CORE:(j + 1) * CORE, i * CORE:(i + 1) * CORE]).save(
            export / "ground" / f"{i}_{j}.jpg", quality=84, optimize=True)
OVERVIEW = 2048
Image.fromarray(mosaic).resize((OVERVIEW, OVERVIEW), Image.LANCZOS).save(
    export / "ground" / "overview.jpg", quality=86, optimize=True)
Image.fromarray(atlas).save(export / "roofs.jpg", quality=88, optimize=True)

world = {
    "name": name,
    "origin": {"lat": LAT0, "lon": LON0},
    "sizeM": SIZE,
    "ground": {"tiles": N, "tileM": CORE * MPP, "tilePx": TILE_PX, "overviewPx": OVERVIEW},
    "terrain": {"step": dem["step"], "n": dem["n"], "heights": [round(float(v), 2) for v in H.ravel()]},
    "roofAtlas": {"px": ATLAS_W, "h": atlas_h},
    "photo": {"shadowAzimuth": SHADOW_AZ, "sunElevation": round(SUN_ELEV, 1)},
    "buildings": buildings, "roads": roads, "paths": paths, "areas": areas, "trees": trees,
    "places": places, "credits": "Imagery & terrain: Google; map data: © OpenStreetMap contributors",
}
(export / "world.json").write_text(json.dumps(world, separators=(",", ":")))
print("wrote", export / "world.json", f"{(export / 'world.json').stat().st_size / 1e6:.1f} MB")
hs = [b["h"] for b in buildings]
print("heights: median", np.median(hs), "max", max(hs), "sources",
      {s: sum(b["hSource"] == s for b in buildings) for s in ("shadow", "typical", "osm")})
for b in sorted(buildings, key=lambda b: -b["h"])[:6]:
    print("  tallest:", b.get("name", b["id"]), b["h"], b["hSource"], "area", round(Polygon(b["poly"]).area))
