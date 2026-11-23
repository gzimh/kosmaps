"""Check each OSM footprint against the Google 3D surface; where they disagree, replace it with a
straight, right-angled footprint derived from the 3D roof itself.

Reads buildings.json (pass 1) + dsm.npy, writes footprint_overrides.json {osm_id: [[e, n], ...]}.
"""
import json
import math

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely.affinity import rotate
from shapely.geometry import MultiPoint, Polygon, box
from shapely.ops import unary_union

RES, EXT = 0.5, 700
dsm = np.load("dsm.npy")
G = dsm.shape[0]
B = json.load(open("buildings.json"))["buildings"]
polys = {b["id"]: Polygon(b["fp"]).buffer(0) for b in B}

# screen-space check: where the building's roof would be drawn, does the camera actually see a roof?
HM = np.load("height_mosaic.npy")
NPX = HM.shape[0]; S2 = math.sqrt(0.5); MPP = 0.2


def false_roof(b, top):
    pts = [(NPX / 2 + (S2 * e - S2 * n) / MPP, NPX / 2 - (0.5 * e + 0.5 * n + S2 * top) / MPP) for e, n in Polygon(b["fp"]).buffer(-1.0).exterior.coords] \
        if not Polygon(b["fp"]).buffer(-1.0).is_empty else []
    if len(pts) < 4:
        return 0.0
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, y0 = int(max(0, min(xs))), int(max(0, min(ys))); x1, y1 = int(min(NPX, max(xs) + 1)), int(min(NPX, max(ys) + 1))
    if x1 - x0 < 3 or y1 - y0 < 3:
        return 0.0
    im = Image.new("L", (x1 - x0, y1 - y0), 0)
    ImageDraw.Draw(im).polygon([(x - x0, y - y0) for x, y in pts], fill=1)
    m = np.asarray(im, bool)
    seen = HM[y0:y1, x0:x1][m]
    seen = seen[np.isfinite(seen)]
    if seen.size < 30:
        return 0.0
    return float((seen < top - 4.0).mean())


def raster(poly, j0, i0, h, w):
    im = Image.new("L", (w, h), 0)
    for geom in getattr(poly, "geoms", [poly]):
        if geom.geom_type == "Polygon" and not geom.is_empty:
            ImageDraw.Draw(im).polygon([((e + EXT) / RES - i0, (EXT - n) / RES - j0) for e, n in geom.exterior.coords], fill=1)
    return np.asarray(im, bool)


def rectilinear(cells_en, angle_deg):
    """Union of 1 m squares in the building's own axis frame -> straight right-angled polygon."""
    pts = MultiPoint(cells_en)
    c = pts.centroid
    rot = [rotate(MultiPoint([p]), -angle_deg, origin=c).geoms[0] for p in [*pts.geoms]]
    xs = np.array([p.x for p in rot]); ys = np.array([p.y for p in rot])
    x0, y0 = xs.min(), ys.min()
    CELL = 1.5
    gx = ((xs - x0) // CELL).astype(int); gy = ((ys - y0) // CELL).astype(int)
    grid = np.zeros((gy.max() + 1, gx.max() + 1), bool)
    grid[gy, gx] = True
    grid = ndimage.binary_closing(grid, iterations=2)
    grid = ndimage.binary_opening(grid, iterations=1)
    grid = ndimage.binary_fill_holes(grid)
    sq = [box(x0 + i * CELL, y0 + j * CELL, x0 + (i + 1) * CELL, y0 + (j + 1) * CELL) for j, i in zip(*np.nonzero(grid))]
    if not sq:
        return None
    poly = unary_union(sq)
    if poly.geom_type != "Polygon":
        poly = max(poly.geoms, key=lambda p: p.area)
    poly = Polygon(poly.exterior).simplify(2.0)
    return rotate(poly, angle_deg, origin=c)


overrides, stats = {}, {"kept": 0, "replaced": 0, "skipped": 0}
for b in B:
    poly = polys[b["id"]]
    rel = b["roof_main"] - b["ground"]
    if rel < 4:
        stats["skipped"] += 1
        continue
    thr = b["ground"] + max(2.5, 0.5 * rel)
    reg = poly.buffer(8)
    minx, miny, maxx, maxy = reg.bounds
    i0, i1 = int((minx + EXT) / RES), int((maxx + EXT) / RES) + 1
    j0, j1 = int((EXT - maxy) / RES), int((EXT - miny) / RES) + 1
    if i0 < 0 or j0 < 0 or i1 > G or j1 > G:
        continue
    win = dsm[j0:j1, i0:i1]
    h, w = win.shape
    own = raster(poly, j0, i0, h, w)
    inreg = raster(reg, j0, i0, h, w)
    # cells inside a neighbour's outline only count if they are clearly taller than that neighbour
    blocked = np.zeros_like(own)
    wn = np.nan_to_num(win, nan=-1e9)
    for o in B:
        if o["id"] != b["id"] and polys[o["id"]].intersects(reg):
            om = raster(polys[o["id"]], j0, i0, h, w) & ~own
            blocked |= om & (wn < o["roof_main"] + 3.0)
    elev = wn > thr
    cand = elev & inreg & ~blocked
    cand = ndimage.binary_opening(cand, iterations=1)
    lab, nlab = ndimage.label(cand)
    if nlab == 0:
        stats["kept"] += 1
        continue
    overlap = ndimage.sum(own, lab, index=np.arange(1, nlab + 1))
    k = int(np.argmax(overlap)) + 1
    comp = lab == k
    seen_own = own & np.isfinite(win)
    iou = (comp & own).sum() / max(1, (comp | seen_own).sum())
    fr = false_roof(b, b["roof_main"])
    if (iou >= 0.45 and fr < 0.25) or comp.sum() < 40:
        stats["kept"] += 1
        continue
    jj, ii = np.nonzero(comp)
    cells = list(zip((ii + i0 + 0.5) * RES - EXT, EXT - (jj + j0 + 0.5) * RES))
    mrr = MultiPoint(cells).minimum_rotated_rectangle
    xy = list(mrr.exterior.coords)
    edges = [(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]) for i in range(2)]
    ex, ey = max(edges, key=lambda v: math.hypot(*v))
    angle = math.degrees(math.atan2(ey, ex))
    area_ratio = comp.sum() * RES * RES / mrr.area
    newp = mrr if area_ratio > 0.80 else rectilinear(cells, angle)
    if newp is not None and len(newp.exterior.coords) > 13 and area_ratio > 0.65:
        newp = mrr  # too fiddly: a clean rectangle reads better
    if newp is None or newp.area < 30:
        stats["kept"] += 1
        continue
    overrides[b["osm"]] = [[round(x, 2), round(y, 2)] for x, y in newp.exterior.coords]
    stats["replaced"] += 1
    print(f"replaced {b['osm']:>18} {str(b['name'] or b['use'])[:34]:34} IoU {iou:.2f} false-roof {fr:.2f} -> {len(newp.exterior.coords) - 1} corners")
json.dump(overrides, open("footprint_overrides.json", "w"))
print(stats)
