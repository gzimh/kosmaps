"""Export the map for the Next.js app into ../public/data/ as tile pyramids + data files.

public/data/ is git-ignored: it holds Google-derived imagery and must never be committed.
Usage (from pipeline/): python export_web.py [out_dir=../public/data]

Imagery (day, night, sky-facing mask) -> tiles/<layer>/<z>/<x>_<y>.webp
  z = 0 is the coarsest level; at z = maxZ one tile pixel is one mosaic pixel, and each level
  below halves the resolution. Every tile is TILE px of content plus a GUTTER px border copied
  from its neighbours, so bilinear filtering never shows seams between tiles.
Data layers, read on the CPU (lossless PNG, one level):
  tiles/idmap/<x>_<y>.png   building index per mosaic pixel (R + 256 G)
  tiles/height/<x>_<y>.png  surface height + solid flag at half resolution (see build_roads.py)
"""
import json
import math
import os
import shutil
import sys

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
g = json.load(open("tiles_raw/grid.json"))


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


def pyramid(src, layer, quality, mode="RGB"):
    full = Image.open(src).convert(mode).convert("RGB")
    size = full.size[0]
    max_z = max(0, math.ceil(math.log2(size / TILE)))
    total, count = 0, 0
    for z in range(max_z + 1):
        f = 2 ** (max_z - z)                      # mosaic px per level px
        lw = math.ceil(size / f)
        level = full if f == 1 else full.resize((lw, lw), Image.LANCZOS)
        padded = pad_edges(level, GUTTER)
        n = math.ceil(lw / TILE)
        d = os.path.join(out, "tiles", layer, str(z))
        os.makedirs(d, exist_ok=True)
        for ty in range(n):
            for tx in range(n):
                x0, y0 = tx * TILE, ty * TILE
                x1, y1 = min(lw, x0 + TILE), min(lw, y0 + TILE)
                tile = padded.crop((x0, y0, x1 + 2 * GUTTER, y1 + 2 * GUTTER))
                p = os.path.join(d, f"{tx}_{ty}.webp")
                tile.save(p, "WEBP", quality=quality, method=6)
                total += os.path.getsize(p)
                count += 1
    print(f"  {src} -> tiles/{layer}: {max_z + 1} levels, {count} tiles, {total / 1e6:.1f} MB")
    return size, max_z


def data_tiles(src, layer, factor):
    """Lossless tiles of a CPU data layer whose pixels are `factor` x mosaic pixels."""
    im = Image.open(src).convert("RGB")
    t = int(DATA_TILE * factor)
    n = math.ceil(im.size[0] / t)
    d = os.path.join(out, "tiles", layer)
    os.makedirs(d, exist_ok=True)
    total = 0
    for ty in range(n):
        for tx in range(n):
            p = os.path.join(d, f"{tx}_{ty}.png")
            im.crop((tx * t, ty * t, min(im.size[0], (tx + 1) * t), min(im.size[1], (ty + 1) * t))).save(p, "PNG", optimize=True)
            total += os.path.getsize(p)
    print(f"  {src} -> tiles/{layer}: {n}x{n} tiles, {total / 1e6:.1f} MB")
    return {"tile": t, "factor": factor, "cols": n, "rows": n}


size, max_z = pyramid("mosaic_styled.png", "day", 82)
pyramid("mosaic_night.png", "night", 82)
pyramid("mosaic_up.png", "up", 70, "L")
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
if os.path.exists("buses.json"):
    shutil.copyfile("buses.json", os.path.join(out, "buses.json"))
    layers.update(buses="buses.json")
    print("  buses.json (bus lines, stops, timetables)")
if os.path.exists("traffic_profile.json"):
    shutil.copyfile("traffic_profile.json", os.path.join(out, "traffic_profile.json"))
    layers.update(trafficProfile="traffic_profile.json")
    print("  traffic_profile.json (weekly pattern)")

meta = {
    "lat": g["lat"],
    "lon": g["lon"],
    "size": size,
    "mpp": g["M_PER_PX"],
    "credits": g.get("credits", ""),
    "pyramid": {"tileSize": TILE, "gutter": GUTTER, "maxZ": max_z, "format": "webp", "layers": ["day", "night", "up"]},
    "data": data,
    "layers": layers,
}
json.dump(meta, open(os.path.join(out, "meta.json"), "w"), indent=2)
print(f"exported to {out}")
