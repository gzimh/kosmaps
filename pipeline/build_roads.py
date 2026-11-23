"""Build the drivable road network for the traffic simulation, plus a compact height layer.

Inputs (in pipeline/):
  tiles_raw/grid.json      camera / mosaic geometry
  height_mosaic.npy        per-pixel surface height (from height_pass.mjs + decode_height.py)
  osm_area.json            OSM ways incl. highways (README step 9)
  osm_road_nodes.json      OSM traffic_signals / stop / give_way / crossing nodes:
      [out:json][timeout:60];
      node[highway~"^(traffic_signals|stop|give_way|crossing)$"](42.6445,21.1455,42.6605,21.1675);
      out body;

Outputs:
  roads.json   graph of links between junctions, in local east/north/height metres
  height.png   half-resolution surface height, max-pooled, 16-bit in R (high) + G (low),
               value = (h + 100) * 16, 0 = unknown. B = 255 where the pixel is a solid occluder
               (a building from idmap.png, or a bridge / covered-road / building-passage deck);
               other tall pixels are trees, which only dim cars instead of hiding them.
"""
import json
import math
from collections import defaultdict

import numpy as np
from PIL import Image

g = json.load(open("tiles_raw/grid.json"))
LAT0, LON0, MPP = g["lat"], g["lon"], g["M_PER_PX"]
NPX = (2 * g["R"] + 1) * g["CORE"]
X0 = Y0 = NPX / 2
S2 = math.sqrt(0.5)
MARGIN_PX = 220          # simulate a little beyond the visible mosaic so cars enter smoothly
STEP_M = 8.0             # densify long segments so heights follow the terrain

a, f = 6378137.0, 1 / 298.257223563
e2 = f * (2 - f)
phi = math.radians(LAT0)
Nr = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
Mr = a * (1 - e2) / (1 - e2 * math.sin(phi) ** 2) ** 1.5
KX, KY = math.radians(1) * Nr * math.cos(phi), math.radians(1) * Mr


def ll2en(lat, lon):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def project(e, n, h):
    return X0 + (S2 * e - S2 * n) / MPP, Y0 - (0.5 * e + 0.5 * n + S2 * h) / MPP


# ------------------------------------------------------------------ terrain from the height mosaic
H = np.load("height_mosaic.npy")
Ys, Xs = np.mgrid[0:NPX, 0:NPX]
xg = (Xs + 0.5 - X0) * MPP
yg = (Y0 - (Ys + 0.5)) * MPP
valid = np.isfinite(H)
E = (xg / S2 + 2 * (yg - S2 * H)) / 2
N = (2 * (yg - S2 * H) - xg / S2) / 2

EXT, CELL = 1000, 20
GC = 2 * EXT // CELL
gi = ((E[valid] + EXT) // CELL).astype(np.int64)
gj = ((EXT - N[valid]) // CELL).astype(np.int64)
key = gj * GC + gi
order = np.argsort(key, kind="stable")
ks, hk = key[order], H[valid][order]
uk, st = np.unique(ks, return_index=True)
dem = np.full(GC * GC, np.nan, np.float32)
for k, s0, s1 in zip(uk, st, list(st[1:]) + [len(ks)]):
    if s1 - s0 > 20:
        dem[k] = np.percentile(hk[s0:s1], 8)
dem = dem.reshape(GC, GC)


def dem_at(e_, n_):
    i_, j_ = int((e_ + EXT) // CELL), int((EXT - n_) // CELL)
    win = dem[max(0, j_ - 2):j_ + 3, max(0, i_ - 2):i_ + 3]
    return float(np.nanmedian(win)) if np.isfinite(win).any() else 0.0


def surface_at(e_, n_, h_):
    x, y = project(e_, n_, h_)
    xi, yi = int(x), int(y)
    if 0 <= xi < NPX and 0 <= yi < NPX and np.isfinite(H[yi, xi]):
        return float(H[yi, xi])
    return None


def road_height(e_, n_):
    """Terrain estimate, refined by the visible road surface where the camera can see it."""
    h = dem_at(e_, n_)
    for _ in range(3):
        s = surface_at(e_, n_, h)
        if s is None or abs(s - h) > 1.5:
            break
        h = s
    return h


# ------------------------------------------------------------------ OSM roads
DRIVABLE = {
    "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service",
}
SKIP_SERVICE = {"parking_aisle", "driveway", "emergency_access", "drive-through"}

els = json.load(open("osm_area.json"))["elements"]
nodes = {e["id"]: (e["lat"], e["lon"]) for e in els if e["type"] == "node" and "lat" in e}
road_nodes = json.load(open("osm_road_nodes.json"))["elements"]
node_kind = {e["id"]: e["tags"]["highway"] for e in road_nodes}

ways = []
for e in els:
    t = e.get("tags", {})
    if e["type"] != "way" or t.get("highway") not in DRIVABLE:
        continue
    if t.get("highway") == "service" and t.get("service") in SKIP_SERVICE:
        continue
    if t.get("access") in ("no", "private") or t.get("motor_vehicle") == "no":
        continue
    ids = [i for i in e["nodes"] if i in nodes]
    if len(ids) < 2:
        continue
    oneway = t.get("oneway")
    if t.get("junction") == "roundabout" and oneway is None:
        oneway = "yes"
    flipped = oneway == "-1"   # links then run against the OSM way's node order
    if flipped:
        ids = ids[::-1]
        oneway = "yes"
    lanes = t.get("lanes", "").split(";")[0]
    ways.append({
        "osm": e["id"], "flipped": flipped, "ids": ids, "cls": t["highway"].replace("_link", ""), "link": t["highway"].endswith("_link"),
        "oneway": oneway == "yes", "lanes": int(lanes) if lanes.isdigit() else None,
        "maxspeed": int(t["maxspeed"]) if t.get("maxspeed", "").isdigit() else None, "name": t.get("name"),
    })

en = {i: ll2en(*nodes[i]) for w in ways for i in w["ids"]}
hgt = {i: road_height(*en[i]) for i in en}


def inside(i):
    x, y = project(*en[i], hgt[i])
    return -MARGIN_PX <= x <= NPX + MARGIN_PX and -MARGIN_PX <= y <= NPX + MARGIN_PX


def crossing(i_in, i_out):
    """Point where the segment from an inside node to an outside node leaves the simulated area.
    It becomes the run's cut end, so cars enter/leave exactly at the margin, never mid-map."""
    lo, hi = 0.0, 1.0
    (e1, n1), (e2_, n2) = en[i_in], en[i_out]
    for _ in range(30):
        t = (lo + hi) / 2
        ee, nn = e1 + (e2_ - e1) * t, n1 + (n2 - n1) * t
        x, y = project(ee, nn, road_height(ee, nn))
        ok = -MARGIN_PX <= x <= NPX + MARGIN_PX and -MARGIN_PX <= y <= NPX + MARGIN_PX
        lo, hi = (t, hi) if ok else (lo, t)
    key = ("cut", i_in, i_out)
    ee, nn = e1 + (e2_ - e1) * lo, n1 + (n2 - n1) * lo
    en[key], hgt[key] = (ee, nn), road_height(ee, nn)
    return key


# split ways into runs inside the simulated area, cutting segments exactly at its edge
runs = []
for w in ways:
    cur, prev = [], None
    for i in w["ids"]:
        if inside(i):
            if not cur and prev is not None:
                cur.append(crossing(i, prev))
            cur.append(i)
        else:
            if cur:
                cur.append(crossing(cur[-1], i))
                if len(cur) >= 2:
                    runs.append((w, cur, True))
            cur = []
        prev = i
    if len(cur) >= 2:
        runs.append((w, cur, len(cur) != len(w["ids"])))

use = defaultdict(int)
for w, ids, _ in runs:
    for k, i in enumerate(ids):
        use[i] += 2 if k in (0, len(ids) - 1) else 1  # endpoints count as junction-worthy
# run ends that aren't the way's own ends were cut by the area boundary: cars enter/leave there
cut_ends = set()
for w, ids, clipped in runs:
    if clipped:
        if ids[0] != w["ids"][0]:
            cut_ends.add(ids[0])
        if ids[-1] != w["ids"][-1]:
            cut_ends.add(ids[-1])

out_nodes, idx = [], {}


def nid(key, e_, n_, h_):
    if key not in idx:
        idx[key] = len(out_nodes)
        out_nodes.append([round(e_, 2), round(n_, 2), round(h_, 2)])
    return idx[key]


links = []
for w, ids, _ in runs:
    seg = [ids[0]]
    for i in ids[1:]:
        seg.append(i)
        junction = use[i] >= 2 or node_kind.get(i) in ("traffic_signals", "stop", "give_way") or i == ids[-1]
        if not junction:
            continue
        pts = []
        for p, q in zip(seg[:-1], seg[1:]):
            pts.append(nid(p, *en[p], hgt[p]))
            (e1, n1), (e2_, n2) = en[p], en[q]
            d = math.hypot(e2_ - e1, n2 - n1)
            k = int(d // STEP_M)
            for s in range(1, k + 1):
                t = s / (k + 1)
                ee, nn = e1 + (e2_ - e1) * t, n1 + (n2 - n1) * t
                pts.append(nid((p, q, s), ee, nn, road_height(ee, nn)))
        pts.append(nid(seg[-1], *en[seg[-1]], hgt[seg[-1]]))
        length = sum(math.hypot(out_nodes[b][0] - out_nodes[a][0], out_nodes[b][1] - out_nodes[a][1]) for a, b in zip(pts[:-1], pts[1:]))
        if length > 0.5:
            links.append({
                "osm": w["osm"], "flipped": w["flipped"], "pts": pts, "cls": w["cls"], "link": w["link"], "oneway": w["oneway"], "lanes": w["lanes"],
                "maxspeed": w["maxspeed"], "name": w["name"], "len": round(length, 2),
            })
        seg = [i]

# light 3-tap smoothing of heights along links (junction nodes stay fixed)
hs = np.array([p[2] for p in out_nodes])
junction_nodes = {l["pts"][0] for l in links} | {l["pts"][-1] for l in links}
for l in links:
    p = l["pts"]
    for k in range(1, len(p) - 1):
        if p[k] not in junction_nodes:
            out_nodes[p[k]][2] = round(float((hs[p[k - 1]] + 2 * hs[p[k]] + hs[p[k + 1]]) / 4), 2)

signals = sorted(idx[i] for i, k in node_kind.items() if k == "traffic_signals" and i in idx)
yields = sorted(idx[i] for i, k in node_kind.items() if k in ("stop", "give_way") and i in idx)
crossings = sorted(idx[i] for i, k in node_kind.items() if k == "crossing" and i in idx)
boundary = sorted(idx[i] for i in cut_ends if i in idx)

json.dump({
    "lat0": LAT0, "lon0": LON0, "mpp": MPP, "npx": NPX,
    "nodes": out_nodes, "links": links,
    "signals": signals, "yields": yields, "crossings": crossings, "boundary": boundary,
}, open("roads.json", "w"), ensure_ascii=False, separators=(",", ":"))

total = sum(l["len"] for l in links)
print(f"roads.json: {len(links)} links, {len(out_nodes)} nodes, {total / 1000:.1f} km, "
      f"{len(signals)} signal nodes, {len(yields)} stop/yield, {len(boundary)} boundary ends")
by_cls = defaultdict(float)
for l in links:
    by_cls[l["cls"]] += l["len"]
print("  km by class:", {k: round(v / 1000, 2) for k, v in sorted(by_cls.items(), key=lambda kv: -kv[1])})

# ------------------------------------------------------------------ solid occluders
# buildings: from the building index map (pass 2 of build_buildings.py)
idm = np.asarray(Image.open("idmap.png").convert("RGB")).astype(np.int32)
solid = (idm[..., 0] + 256 * idm[..., 1]) > 0
# decks over roads: any pixel whose ground position lies within DECK_M of a bridge, tunnel,
# covered or building-passage highway (footbridges included)
from PIL import ImageDraw
DECK_M, RES_D = 6.0, 0.5
GD = int(2 * EXT / RES_D)
deck_img = Image.new("L", (GD, GD), 0)
dd = ImageDraw.Draw(deck_img)
n_deck = 0
for e in els:
    t = e.get("tags", {})
    if e["type"] != "way" or "highway" not in t:
        continue
    if not (t.get("bridge") not in (None, "no") or t.get("tunnel") not in (None, "no") or t.get("covered") == "yes"):
        continue
    pts = [ll2en(*nodes[i]) for i in e["nodes"] if i in nodes]
    if len(pts) < 2:
        continue
    n_deck += 1
    dd.line([((x + EXT) / RES_D, (EXT - y) / RES_D) for x, y in pts], fill=255, width=int(2 * DECK_M / RES_D))
deck = np.asarray(deck_img) > 0
di = np.clip(((np.nan_to_num(E) + EXT) / RES_D).astype(np.int64), 0, GD - 1)
dj = np.clip(((EXT - np.nan_to_num(N)) / RES_D).astype(np.int64), 0, GD - 1)
solid |= valid & (np.abs(E) < EXT) & (np.abs(N) < EXT) & deck[dj, di]
print(f"solid occluders: {solid.mean():.1%} of pixels ({n_deck} bridge/tunnel/covered ways)")

# ------------------------------------------------------------------ half-res max-pooled height layer
Hn = np.nan_to_num(H, nan=-100.0)
half = Hn.reshape(NPX // 2, 2, NPX // 2, 2).max(axis=(1, 3))
solid_half = solid.reshape(NPX // 2, 2, NPX // 2, 2).any(axis=(1, 3))
enc = np.clip(np.round((half + 100) * 16), 0, 65535).astype(np.uint32)
enc[half <= -99.9] = 0
rgb = np.stack([(enc >> 8) & 255, enc & 255, np.where(solid_half, 255, 0)], -1).astype(np.uint8)
Image.fromarray(rgb).save("height.png", optimize=True)
print(f"height.png: {half.shape[1]}x{half.shape[0]} (max-pooled 2x2)")
