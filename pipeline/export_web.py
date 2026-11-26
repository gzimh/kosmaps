"""Export the map for the Next.js app into ../public/data/ as tile pyramids + data files.

public/data/ is git-ignored: it holds Google-derived imagery and must never be committed.
Usage (from pipeline/): python export_web.py [out_dir=../public/data]

Everything tiled goes under tiles/<version>/ (a new version per export), so browsers can cache
tiles for a year without ever showing stale ones; meta.json (not cached) says which version.

Imagery -> tiles/<v>/<layer>/<z>/<x>_<y>.{avif,webp}, one pyramid per layer:
  day, night  from mosaic_*_2x.png when present (Real-ESRGAN 2x, see upscale.py in git history): the finest level
              has 2 tile px per mosaic px
  up          the sky-facing mask is smooth, so it is stored at half resolution
  z = 0 is the coarsest level, each level doubles the resolution of the one before. Every tile is
  TILE px of content plus a GUTTER px border copied from its neighbours (no seams when filtering).
  AVIF is ~30% smaller than WebP at the same quality; WebP copies are written for browsers without
  AVIF decoding.
Data layers, read on the CPU (lossless PNG, one level):
  tiles/<v>/idmap/<x>_<y>.png   building index per mosaic pixel (R + 256 G)
  tiles/<v>/height/<x>_<y>.png  surface height + solid flag at half resolution (see build_roads.py in git history)
"""
import json
import math
import os
import shutil
import sys
import time

from PIL import Image

TILE = 512
GUTTER = 2
DATA_TILE = 512          # data tiles cover DATA_TILE mosaic pixels

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join("..", "public", "data")
os.makedirs(out, exist_ok=True)
for old in ("day.webp", "night.webp", "up.webp", "idmap.png", "height.png"):   # pre-tiling exports
    if os.path.exists(os.path.join(out, old)):
        os.remove(os.path.join(out, old))
shutil.rmtree(os.path.join(out, "tiles"), ignore_errors=True)
VERSION = time.strftime("%Y%m%d-%H%M%S")
TILES = os.path.join(out, "tiles", VERSION)
g = json.load(open("tiles_raw/grid.json"))
NPX = (2 * g["R"] + 1) * g["CORE"]
FORMATS = {"avif": dict(quality=65, speed=4), "webp": dict(quality=82, method=6)}


def pad_edges(im, gut):
    """Image grown by `gut` px on every side, edge pixels repeated (for tiles on the map border)."""
    w, h = im.size
    big = Image.new(im.mode, (w + 2 * gut, h + 2 * gut))
    big.paste(im, (gut, gut))
    big.paste(im.crop((0, 0, w, 1)).resize((w, gut)), (gut, 0))
    big.paste(im.crop((0, h - 1, w, h)).resize((w, gut)), (gut, h + gut))
    big.paste(big.crop((gut, 0, gut + 1, h + 2 * gut)).resize((gut, h + 2 * gut)), (0, 0))
    big.paste(big.crop((w + gut - 1, 0, w + gut, h + 2 * gut)).resize((gut, h + 2 * gut)), (w + gut, 0))
    return big


def pyramid(src, layer, mode="RGB", scale=1.0):
    """Tile pyramid of one layer. `scale` resizes the source first (0.5 = half resolution)."""
    full = Image.open(src).convert(mode).convert("RGB")
    if scale != 1.0:
        full = full.resize((round(full.size[0] * scale), round(full.size[1] * scale)), Image.LANCZOS)
    size = full.size[0]
    finest = NPX / size                       # mosaic px per tile px at the finest level
    max_z = max(0, math.ceil(math.log2(size / TILE)))
    total, count = {f: 0 for f in FORMATS}, 0
    for z in range(max_z + 1):
        f = 2 ** (max_z - z)                      # source px per level px
        lw = math.ceil(size / f)
        level = full if f == 1 else full.resize((lw, lw), Image.LANCZOS)
        padded = pad_edges(level, GUTTER)
        n = math.ceil(lw / TILE)
        d = os.path.join(TILES, layer, str(z))
        os.makedirs(d, exist_ok=True)
        for ty in range(n):
            for tx in range(n):
                x0, y0 = tx * TILE, ty * TILE
                x1, y1 = min(lw, x0 + TILE), min(lw, y0 + TILE)
                tile = padded.crop((x0, y0, x1 + 2 * GUTTER, y1 + 2 * GUTTER))
                for fmt, kw in FORMATS.items():
                    p = os.path.join(d, f"{tx}_{ty}.{fmt}")
                    tile.save(p, fmt.upper(), **kw)
                    total[fmt] += os.path.getsize(p)
                count += 1
    sizes = ", ".join(f"{f} {b / 1e6:.1f} MB" for f, b in total.items())
    print(f"  {src} -> tiles/{layer}: {size} px, {max_z + 1} levels, {count} tiles ({sizes})")
    return {"maxZ": max_z, "finest": finest}


def data_tiles(src, layer, factor):
    """Lossless tiles of a CPU data layer whose pixels are `factor` x mosaic pixels."""
    im = Image.open(src).convert("RGB")
    t = int(DATA_TILE * factor)
    n = math.ceil(im.size[0] / t)
    d = os.path.join(TILES, layer)
    os.makedirs(d, exist_ok=True)
    total = 0
    for ty in range(n):
        for tx in range(n):
            p = os.path.join(d, f"{tx}_{ty}.png")
            im.crop((tx * t, ty * t, min(im.size[0], (tx + 1) * t), min(im.size[1], (ty + 1) * t))).save(p, "PNG", optimize=True)
            total += os.path.getsize(p)
    print(f"  {src} -> tiles/{layer}: {n}x{n} tiles, {total / 1e6:.1f} MB")
    return {"tile": t, "factor": factor, "cols": n, "rows": n}


def best(name):
    return f"{name}_2x.png" if os.path.exists(f"{name}_2x.png") else f"{name}.png"


layer_info = {
    "day": pyramid(best("mosaic_styled"), "day"),
    "night": pyramid(best("mosaic_night"), "night"),
    "up": pyramid("mosaic_up.png", "up", "L", scale=0.5),
}
data = {"idmap": data_tiles("idmap.png", "idmap", 1.0)}

shutil.copyfile("buildings.json", os.path.join(out, "buildings.json"))
layers = {"buildings": "buildings.json"}

# Traffic simulation inputs (optional; produced by build_roads.py)
if os.path.exists("roads.json") and os.path.exists("height.png"):
    shutil.copyfile("roads.json", os.path.join(out, "roads.json"))
    data["height"] = data_tiles("height.png", "height", 0.5)
    layers.update(roads="roads.json")
    print("  roads.json (traffic)")
else:
    print("  (no roads.json/height.png: run build_roads.py to enable simulated traffic)")
if os.path.exists("parked_cars.json"):
    shutil.copyfile("parked_cars.json", os.path.join(out, "parked_cars.json"))
    layers.update(parkedCars="parked_cars.json")
    print("  parked_cars.json (parked cars as 3D objects)")
# Landmarks: curated in the repo (pipeline/landmarks.json); resolved here to map positions
LM_SRC = next((p_ for p_ in ("landmarks.json", os.path.join(os.path.dirname(os.path.abspath(__file__)), "landmarks.json")) if os.path.exists(p_)), None)
if LM_SRC:
    lm = json.load(open(LM_SRC, encoding="utf-8"))
    bjs = json.load(open("buildings.json"))
    by_osm = {b["osm"]: b for b in bjs["buildings"]}
    rd = json.load(open("roads.json")) if os.path.exists("roads.json") else None
    lat0, lon0 = g["lat"], g["lon"]
    a_, f_ = 6378137.0, 1 / 298.257223563
    e2_ = f_ * (2 - f_)
    ph = math.radians(lat0)
    kx = math.radians(1) * a_ / math.sqrt(1 - e2_ * math.sin(ph) ** 2) * math.cos(ph)
    ky = math.radians(1) * a_ * (1 - e2_) / (1 - e2_ * math.sin(ph) ** 2) ** 1.5
    out_lm = []
    for L_ in lm["landmarks"]:
        anc = L_["anchor"]
        if "osm" in anc:
            b = by_osm.get(anc["osm"])
            if not b:
                print(f"  ! landmark {L_['id']}: building {anc['osm']} not in buildings.json, skipped")
                continue
            xs, ys = [p_[0] for p_ in b["fp"][:-1]], [p_[1] for p_ in b["fp"][:-1]]
            pos = {"building": b["id"], "e": round(sum(xs) / len(xs), 2), "n": round(sum(ys) / len(ys), 2), "h": b.get("roof_main", b["roof"])}
        else:
            e_, n_ = (anc["lon"] - lon0) * kx, (anc["lat"] - lat0) * ky
            h_ = 0.0
            if rd:   # ground height from the nearest road node
                h_ = min(rd["nodes"], key=lambda q: (q[0] - e_) ** 2 + (q[1] - n_) ** 2)[2]
            pos = {"e": round(e_, 2), "n": round(n_, 2), "h": round(h_, 2)}
            # a point landmark outside this map belongs to another area's list (shared fallback file)
            px_ = NPX / 2 + (e_ - n_) * math.sqrt(0.5) / g["M_PER_PX"]
            py_ = NPX / 2 - (e_ + n_) / 2 / g["M_PER_PX"]
            if not (0 <= px_ < NPX and 0 <= py_ < NPX):
                continue
        out_lm.append({k: v for k, v in L_.items() if k != "anchor"} | pos)
    json.dump({"about": lm.get("about"), "landmarks": out_lm}, open(os.path.join(out, "landmarks.json"), "w"), ensure_ascii=False)
    layers.update(landmarks="landmarks.json")
    print(f"  landmarks.json ({len(out_lm)} landmarks)")
if os.path.exists("traffic_profile.json"):
    shutil.copyfile("traffic_profile.json", os.path.join(out, "traffic_profile.json"))
    layers.update(trafficProfile="traffic_profile.json")
    print("  traffic_profile.json (weekly pattern)")

meta = {
    "lat": g["lat"],
    "lon": g["lon"],
    "size": NPX,
    "mpp": g["M_PER_PX"],
    "credits": g.get("credits", ""),
    "tiles": VERSION,
    "pyramid": {"tileSize": TILE, "gutter": GUTTER, "formats": list(FORMATS), "layers": layer_info},
    "data": data,
    "layers": layers,
}
json.dump(meta, open(os.path.join(out, "meta.json"), "w"), indent=2)
print(f"exported to {out}")
