"""Parked cars for a flat-3D area, found in the straight-down orthophoto (world3d/ortho.mjs).

Dardania's build_parking.py needs Google's 3D (cars show as low bumps) and an older restyle that
still drew cars; a flat area has neither. The orthophoto (0.2 m/px, north up) shows parked cars
plainly, so: on and beside drivable streets and in car parks (OSM), find blobs that differ strongly
from the local paving colour, keep the car-shaped ones (size, aspect, solidity), drop green ones
(trees over the street) and anything on a building. Each car keeps its photo colour and long-axis
heading. Output matches build_parking.py: parked_cars.json {"cars": [[east, north, h, heading, "#rrggbb"]]}
in the grid's local frame (east/north metres from grid lat/lon, h relative to the grid's ground).

Usage (from the work dir): python world3d/parked_from_ortho.py <world.json>
Inputs: ortho_raw/ + ortho.json, osm_area.json, parking_osm.json, tiles_raw/grid.json
"""
import json
import math
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

world = json.load(open(sys.argv[1]))
meta = json.load(open("ortho.json"))
grid = json.load(open("tiles_raw/grid.json"))
N, CORE, MPP, SIZE = meta["tiles"], meta["core"], meta["mPerPx"], meta["sizeM"]
HALF = SIZE / 2
LAT0, LON0, M_LAT, M_LON = meta["lat"], meta["lon"], meta["mLat"], meta["mLon"]
W = N * CORE

# grid frame (same WGS84 radii as build_buildings.py)
a_, f_ = 6378137.0, 1 / 298.257223563
e2 = f_ * (2 - f_)
phi = math.radians(grid["lat"])
Nr = a_ / math.sqrt(1 - e2 * math.sin(phi) ** 2)
Mr = a_ * (1 - e2) / (1 - e2 * math.sin(phi) ** 2) ** 1.5
KX, KY = math.radians(1) * Nr * math.cos(phi), math.radians(1) * Mr


def ortho_to_ll(x, y):
    return LAT0 + y / M_LAT, LON0 + x / M_LON


def ll_to_grid(lat, lon):
    return (lon - grid["lon"]) * KX, (lat - grid["lat"]) * KY


def ll_to_ortho(lat, lon):
    return (lon - LON0) * M_LON, (lat - LAT0) * M_LAT


mos = np.zeros((W, W, 3), np.uint8)
for j in range(N):
    for i in range(N):
        mos[j * CORE:(j + 1) * CORE, i * CORE:(i + 1) * CORE] = np.asarray(Image.open(f"ortho_raw/o_{i}_{j}.png").convert("RGB"))


def to_px(x, y):
    return (x + HALF) / MPP, (HALF - y) / MPP


def poly_mask(geoms):
    img = Image.new("L", (W, W), 0)
    d = ImageDraw.Draw(img)
    for g in geoms:
        for p in getattr(g, "geoms", [g]):
            if p.is_empty or p.geom_type != "Polygon":
                continue
            d.polygon([to_px(*c) for c in p.exterior.coords], fill=1)
            for hole in p.interiors:
                d.polygon([to_px(*c) for c in hole.coords], fill=0)
    return np.asarray(img, bool)


# where parked cars can be: around drivable streets (kerbside + driveway mouths) and in car parks
els = json.load(open("osm_area.json"))["elements"]
nodes = {e["id"]: (e["lat"], e["lon"]) for e in els if e["type"] == "node" and "lat" in e}
WIDTH = {"motorway": 0, "tertiary": 7.0, "unclassified": 6.0, "residential": 6.0, "service": 4.5, "living_street": 5.0}
zones, lanes = [], []
for e in els:
    t = e.get("tags", {})
    hw = t.get("highway")
    if e["type"] != "way" or hw not in WIDTH or not WIDTH[hw]:
        continue
    pts = [ll_to_ortho(*nodes[i]) for i in e["nodes"] if i in nodes]
    if len(pts) < 2:
        continue
    line = LineString(pts)
    zones.append(line.buffer(WIDTH[hw] / 2 + float(__import__("os").environ.get("KERB_M", "2.2"))))
    if hw in ("tertiary", "unclassified"):        # through roads: the lanes are for driving
        lanes.append(line.buffer(1.3))
for e in json.load(open("parking_osm.json"))["elements"]:
    if e.get("tags", {}).get("parking") in ("underground", "multi-storey", "rooftop"):
        continue                                   # cars there aren't visible from above
    if "geometry" in e and len(e["geometry"]) >= 4:
        zones.append(Polygon([ll_to_ortho(g["lat"], g["lon"]) for g in e["geometry"]]).buffer(1.0))
zone = poly_mask([unary_union(zones)])
lane = poly_mask([unary_union(lanes)]) if lanes else np.zeros((W, W), bool)
bld = poly_mask([Polygon(b["poly"]).buffer(0.6) for b in world["buildings"]])
print(f"search area {zone.mean() * SIZE * SIZE / 1e4:.1f} ha")

# blobs that differ from the local paving colour
img = mos.astype(np.float32)
ys, xs = np.nonzero(zone)
y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
sub = img[y0:y1, x0:x1]
# local paving colour: median over ~8 m, computed at 1/4 resolution (full-res median is far too slow)
small = np.asarray(Image.fromarray(sub.astype(np.uint8)).resize((sub.shape[1] // 4, sub.shape[0] // 4), Image.BILINEAR), np.float32)
bg_s = np.stack([ndimage.median_filter(small[..., c], size=11) for c in range(3)], -1)
bg = np.asarray(Image.fromarray(bg_s.astype(np.uint8)).resize((sub.shape[1], sub.shape[0]), Image.BILINEAR), np.float32)
diff = np.sqrt(((sub - bg) ** 2).sum(-1))
lum = sub @ np.array([0.299, 0.587, 0.114], np.float32)
r, g_, b = sub[..., 0], sub[..., 1], sub[..., 2]
green = (g_ > r + 8) & (g_ > b + 4)
cand = (diff > float(__import__("os").environ.get("DIFF_T", "30"))) & ~green & zone[y0:y1, x0:x1] & ~bld[y0:y1, x0:x1]
cand = ndimage.binary_opening(cand, iterations=1)
cand = ndimage.binary_closing(cand, iterations=1)
cand = ndimage.binary_fill_holes(cand)
if __import__("os").environ.get("DEBUG"):
    dbg = sub.astype(np.uint8).copy()
    dbg[cand] = (0.4 * dbg[cand] + 0.6 * np.array([255, 0, 200])).astype(np.uint8)
    cy_, cx_ = [int(v) for v in __import__("os").environ["DEBUG"].split(",")]
    Image.fromarray(dbg[cy_ - y0 - 300:cy_ - y0 + 300, cx_ - x0 - 450:cx_ - x0 + 450]).save("parked_debug.png")
lab, n = ndimage.label(cand)
print("candidate blobs", n)

# zebra crossings read as car-sized bright stripes: nothing parks on them
crossings = np.array([ll_to_ortho(e["lat"], e["lon"]) for e in json.load(open("osm_road_nodes.json"))["elements"]
                      if e.get("tags", {}).get("highway") == "crossing"] or [[1e9, 1e9]])
cars, why = [], {"size": 0, "shape": 0, "lane": 0, "green": 0, "crossing": 0}
CELL_A = MPP * MPP
CAR_L, ROW_PITCH, LINE_PITCH = 4.4, 2.5, 5.4
for k, sl in enumerate(ndimage.find_objects(lab), start=1):
    jj, ii = np.nonzero(lab[sl] == k)
    area = len(jj) * CELL_A
    if not 3.2 <= area <= 120:
        why["size"] += 1
        continue
    pts = np.stack([(ii + sl[1].start + x0) * MPP - HALF, HALF - (jj + sl[0].start + y0) * MPP], 1)
    ctr = pts.mean(0)
    ev, evec = np.linalg.eigh(np.cov((pts - ctr).T))
    major, minor = evec[:, 1], evec[:, 0]
    u, w = (pts - ctr) @ major, (pts - ctr) @ minor
    L, Wd = u.max() - u.min() + MPP, w.max() - w.min() + MPP
    solid = area / (L * Wd)
    # one car, a row nose to tail (along a kerb), or a row side by side (in bays) — as build_parking.py
    if 3.2 <= L <= 6.0 and 1.3 <= Wd <= 2.7 and solid > 0.55:
        n_cars, head, pitch_axis = 1, major, major
    elif Wd <= 2.9 and L > 6.0 and solid > 0.5:
        n_cars, head, pitch_axis = max(1, round(L / LINE_PITCH)), major, major
    elif 3.6 <= Wd <= 6.2 and L >= 4.0 and solid > 0.5:
        n_cars, head, pitch_axis = max(1, round(L / ROW_PITCH)), minor, major
    else:
        why["shape"] += 1
        continue
    blob = sub[jj + sl[0].start, ii + sl[1].start]
    col = np.median(blob, 0)
    if col[1] > col[0] + 6 and col[1] > col[2] + 2:
        why["green"] += 1
        continue
    pitch = L / n_cars
    for j in range(n_cars):
        t = u.min() + pitch * (j + 0.5)
        c_ = ctr + major * t
        px, py = to_px(*c_)
        if np.hypot(*(crossings - c_).T).min() < 4.0:
            why["crossing"] += 1
            continue
        if lane[int(py), int(px)]:
            why["lane"] += 1           # on a through road's driving lane: moving traffic in the photo
            continue
        # this car's own colour: the blob pixels nearest its slot
        near = np.abs(u - t) < pitch / 2
        cc = np.median(blob[near], 0) if near.any() else col
        lat, lon = ortho_to_ll(*c_)
        e_, n_ = ll_to_grid(lat, lon)
        heading = math.atan2(head[1], head[0]) + (math.pi if (k * 7 + j) % 2 else 0)
        cars.append([round(e_, 2), round(n_, 2), 0.0, round(heading % (2 * math.pi), 3),
                     "#%02x%02x%02x" % tuple(int(v) for v in cc)])

# ground height relative to the grid camera's target (terrain at the grid centre)
ter = world["terrain"]
Ht = np.array(ter["heights"], np.float32).reshape(ter["n"], ter["n"])


def terrain(x, y):
    c = min(ter["n"] - 1.001, max(0, (x + HALF) / ter["step"]))
    r_ = min(ter["n"] - 1.001, max(0, (HALF - y) / ter["step"]))
    c0, r0 = int(c), int(r_)
    fc, fr = c - c0, r_ - r0
    return float((Ht[r0, c0] * (1 - fc) + Ht[r0, c0 + 1] * fc) * (1 - fr) + (Ht[r0 + 1, c0] * (1 - fc) + Ht[r0 + 1, c0 + 1] * fc) * fr)


g0 = terrain(*ll_to_ortho(grid["lat"], grid["lon"]))
for c in cars:
    lat = grid["lat"] + c[1] / KY
    lon = grid["lon"] + c[0] / KX
    c[2] = round(terrain(*ll_to_ortho(lat, lon)) - g0, 2)
json.dump({"cars": cars}, open("parked_cars.json", "w"), separators=(",", ":"))
print(f"parked_cars.json: {len(cars)} cars; rejected {why}")
