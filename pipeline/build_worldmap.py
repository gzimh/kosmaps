"""One map for several areas: merge each area's illustrated mosaics and the raw Google corridor
tiles between them into a single sparse tile pyramid, in one camera frame.

Usage (from pipeline/): python build_worldmap.py <config.json> [out_dir=../public/data]

config.json:
  {"corridor": "<dir with corridor.json + cells/ from corridor.mjs>",
   "areas": [{"id": "dardania", "name": "Dardania", "dir": "<work dir with mosaic_*.png>",
              "data": "/data/areas/dardania"}, ...],      # same ids / order as corridor.json
   "home": ["dardania", "marigona"]}                       # areas the first view fits

Writes <out>/tiles/<version>/{day,night,up}/<z>/<x>_<y>.{avif,webp} (RGBA; blank where nothing is
drawn) and <out>/meta.json with an index of the tiles that exist, the areas' offsets in world px,
and the corridor route. World px = the first area's mosaic px, shifted so the world starts at 0.

Levels: day/night finest = 0.5 mosaic px per tile px (the areas' 2x Real-ESRGAN mosaics; the raw
corridor has no 2x level, the viewer shows its 1x tiles there), each coarser level halves. The
sky-facing mask ('up') is stored from half resolution down. Precedence where sources overlap:
areas in config order (first wins), then the corridor. Corridor night is a colour grade of the
day photo (the corridor is not restyled).
"""
import json
import math
import os
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
TILE, GUTTER = 512, 2
FORMATS = {"avif": dict(quality=65, speed=6), "webp": dict(quality=82, method=4)}

cfg = json.load(open(sys.argv[1]))
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join("..", "public", "data")
cor = json.load(open(os.path.join(cfg["corridor"], "corridor.json")))
CORE, MARGIN = cor["CORE"], cor["MARGIN"]

# ------------------------------------------------------------------ world frame
placed = {a["id"]: a for a in cor["areas"]}
areas = []
for a in cfg["areas"]:
    p = placed[a["id"]]
    areas.append({**a, "size": p["size"], "frame_off": [round(p["offset"][0]), round(p["offset"][1])]})
# optional coarse background (region.mjs): a whole city at lower detail, under everything else
bgcfg = json.load(open(os.path.join(cfg["background"], "region.json"))) if cfg.get("background") else None
BG_K = bgcfg["k"] if bgcfg else None                     # world px per background px
BG_SPAN = CORE * BG_K if bgcfg else None
bg_list = [(c, r) for c, r in bgcfg["cells"] if os.path.exists(os.path.join(cfg["background"], "cells", f"cell_{c}_{r}.png"))] if bgcfg else []
xs = [0.0] + [c * CORE for c, _ in cor["cells"]] + [a["frame_off"][0] for a in areas] + [c * BG_SPAN for c, _ in bg_list]
ys = [0.0] + [r * CORE for _, r in cor["cells"]] + [a["frame_off"][1] for a in areas] + [r * BG_SPAN for _, r in bg_list]
x1s = [(c + 1) * CORE for c, _ in cor["cells"]] + [a["frame_off"][0] + a["size"] for a in areas] + [(c + 1) * BG_SPAN for c, _ in bg_list]
y1s = [(r + 1) * CORE for _, r in cor["cells"]] + [a["frame_off"][1] + a["size"] for a in areas] + [(r + 1) * BG_SPAN for _, r in bg_list]
OX, OY = math.floor(min(xs) / 512) * 512, math.floor(min(ys) / 512) * 512   # world origin in frame px
W, H = int(max(x1s) - OX), int(max(y1s) - OY)
for a in areas:
    a["offset"] = [a["frame_off"][0] - OX, a["frame_off"][1] - OY]
cells = [((c * CORE - OX), (r * CORE - OY), os.path.join(cfg["corridor"], "cells", f"cell_{c}_{r}.png")) for c, r in cor["cells"]]
bg_cells = [((c * BG_SPAN - OX), (r * BG_SPAN - OY), os.path.join(cfg["background"], "cells", f"cell_{c}_{r}.png")) for c, r in bg_list]

FINEST = 0.5
F0 = 2 ** math.ceil(math.log2(max(W, H) / TILE))          # coarsest level: one tile
MAXZ = int(round(math.log2(F0 / FINEST)))
UP_FINEST = 2.0
UP_MAXZ = int(round(math.log2(F0 / UP_FINEST)))
level_f = lambda z, finest, maxz: finest * 2 ** (maxz - z)

# ------------------------------------------------------------------ sources
_cache = {}


def img(path, mode="RGB"):
    k = (path, mode)
    if k not in _cache:
        _cache[k] = np.asarray(Image.open(path).convert(mode))
    return _cache[k]


def area_src(a, layer, scale):
    """(array, px per world px) for an area layer at roughly this scale."""
    d = a["dir"]
    if layer == "up":
        return img(os.path.join(d, "mosaic_up.png"), "L"), 1.0
    name = "mosaic_styled" if layer == "day" else "mosaic_night"
    if scale >= 2 and os.path.exists(os.path.join(d, f"{name}_2x.png")):
        return img(os.path.join(d, f"{name}_2x.png")), 2.0
    return img(os.path.join(d, f"{name}.png")), 1.0


def night_grade(rgb):
    """Corridor night: the day photo darkened and cooled towards the illustrated night palette."""
    x = rgb.astype(np.float32) / 255.0
    lum = x @ np.array([0.299, 0.587, 0.114], np.float32)
    x = x * 0.55 + lum[..., None] * 0.45
    x = (x ** 1.25) * np.array([0.34, 0.37, 0.58], np.float32) + np.array([0.02, 0.02, 0.05], np.float32)
    return np.clip(x * 255, 0, 255).astype(np.uint8)


def compose(layer, x0, y0, f, with_corridor, bg_only=False):
    """RGBA tile (TILE x TILE) of world px [x0, x0 + TILE*f) at f world px per tile px."""
    out = np.zeros((TILE, TILE, 4), np.uint8)
    span = TILE * f
    s = 1.0 / f                                   # tile px per world px

    def paste(src, sx0, sy0, sscale, pre_fn=None):
        """Paste the part of src (src px = (world px - (sx0, sy0)) * sscale) that falls in the tile."""
        h_, w_ = src.shape[:2]
        wx0, wy0 = max(x0, sx0), max(y0, sy0)
        wx1, wy1 = min(x0 + span, sx0 + w_ / sscale), min(y0 + span, sy0 + h_ / sscale)
        if wx1 <= wx0 or wy1 <= wy0:
            return
        cx0, cy0 = (wx0 - sx0) * sscale, (wy0 - sy0) * sscale
        cx1, cy1 = (wx1 - sx0) * sscale, (wy1 - sy0) * sscale
        crop = src[int(round(cy0)):int(round(cy1)), int(round(cx0)):int(round(cx1))]
        if crop.size == 0:
            return
        if pre_fn:
            crop = pre_fn(crop)
        tw, th = int(round((wx1 - wx0) * s)), int(round((wy1 - wy0) * s))
        if tw <= 0 or th <= 0:
            return
        im = Image.fromarray(crop)
        if im.size != (tw, th):
            im = im.resize((tw, th), Image.LANCZOS if tw < im.size[0] else Image.BICUBIC)
        arr = np.asarray(im.convert("RGB"))
        tx, ty = int(round((wx0 - x0) * s)), int(round((wy0 - y0) * s))
        th, tw = min(th, TILE - ty), min(tw, TILE - tx)
        out[ty:ty + th, tx:tx + tw, :3] = arr[:th, :tw]
        out[ty:ty + th, tx:tx + tw, 3] = 255

    if bg_only:
        for cx, cy, path in bg_cells:
            if cx >= x0 + span or cy >= y0 + span or cx + BG_SPAN <= x0 or cy + BG_SPAN <= y0:
                continue
            core = img(path)[MARGIN:MARGIN + CORE, MARGIN:MARGIN + CORE]
            paste(core, cx, cy, 1.0 / BG_K, night_grade if layer == "night" else None)
        return out
    if with_corridor and layer != "up":
        for cx, cy, path in cells:
            if cx >= x0 + span or cy >= y0 + span or cx + CORE <= x0 or cy + CORE <= y0:
                continue
            core = img(path)[MARGIN:MARGIN + CORE, MARGIN:MARGIN + CORE]
            paste(core, cx, cy, 1.0, night_grade if layer == "night" else None)
    for a in reversed(areas):                     # first area in config wins: paste it last
        src, sc = area_src(a, layer, s)
        paste(src, a["offset"][0], a["offset"][1], sc)
    return out


def bleed(arr):
    """Copy the nearest drawn colour into transparent pixels (alpha stays 0), so texture filtering and
    mipmaps near the map's edge blend with real colours instead of black (no dark halos)."""
    a = arr[..., 3]
    if a.all() or not a.any():
        return arr
    from scipy import ndimage
    _, (iy, ix) = ndimage.distance_transform_edt(a == 0, return_indices=True)
    out = arr.copy()
    out[..., :3] = arr[iy, ix, :3]
    return out


def over(fg, bg):
    """fg over bg (straight alpha RGBA uint8)."""
    if fg is None:
        return bg
    fa = fg[..., 3:4].astype(np.float32) / 255
    ba = bg[..., 3:4].astype(np.float32) / 255
    oa = fa + ba * (1 - fa)
    rgb = (fg[..., :3] * fa + bg[..., :3] * ba * (1 - fa)) / np.maximum(oa, 1e-6)
    return np.concatenate([np.clip(rgb, 0, 255), oa * 255], -1).astype(np.uint8)


def encode(job):
    path, arr = job
    im = Image.fromarray(bleed(arr), "RGBA")
    for fmt, kw in FORMATS.items():
        im.save(f"{path}.{fmt}", fmt.upper(), **kw)
    return sum(os.path.getsize(f"{path}.{fmt}") for fmt in FORMATS)


def with_gutter(tiles, tx, ty):
    """TILE + 2*GUTTER tile with its border copied from neighbouring tiles (transparent if none)."""
    g = GUTTER
    big = np.zeros((TILE + 2 * g, TILE + 2 * g, 4), np.uint8)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            t = tiles.get((tx + dx, ty + dy))
            if t is None:
                continue
            sy0, sy1 = (TILE - g, TILE) if dy < 0 else (0, TILE) if dy == 0 else (0, g)
            sx0, sx1 = (TILE - g, TILE) if dx < 0 else (0, TILE) if dx == 0 else (0, g)
            oy = 0 if dy < 0 else g if dy == 0 else TILE + g
            ox = 0 if dx < 0 else g if dx == 0 else TILE + g
            big[oy:oy + sy1 - sy0, ox:ox + sx1 - sx0] = t[sy0:sy1, sx0:sx1]
    return big


def main():
    print(f"world {W} x {H} px ({W * 0.2 / 1000:.1f} x {H * 0.2 / 1000:.1f} km of screen), origin {OX},{OY}; "
          f"{len(cells)} corridor cells; areas " + ", ".join(f"{a['id']}@{a['offset']}" for a in areas))
    VERSION = time.strftime("%Y%m%d-%H%M%S")
    TILES = os.path.join(OUT, "tiles", VERSION)
    pool = ProcessPoolExecutor(max_workers=max(2, (os.cpu_count() or 4) - 2))


    def write_level(layer, z, tiles):
        d = os.path.join(TILES, layer, str(z))
        os.makedirs(d, exist_ok=True)
        jobs = [(os.path.join(d, f"{tx}_{ty}"), with_gutter(tiles, tx, ty)) for (tx, ty) in tiles]
        total = sum(pool.map(encode, jobs, chunksize=4))
        return total


    def downsample(children):
        """Level z tiles from level z+1: each tile = its 2x2 children halved (alpha-aware)."""
        parents = {}
        for (cx, cy) in children:
            parents.setdefault((cx // 2, cy // 2), None)
        out = {}
        for (px, py) in parents:
            big = np.zeros((2 * TILE, 2 * TILE, 4), np.uint8)
            for dy in (0, 1):
                for dx in (0, 1):
                    t = children.get((2 * px + dx, 2 * py + dy))
                    if t is not None:
                        big[dy * TILE:(dy + 1) * TILE, dx * TILE:(dx + 1) * TILE] = t
            # exact 2x2 average (Pillow premultiplies RGBA); Lanczos would ring at the map's edges
            im = Image.fromarray(big, "RGBA").resize((TILE, TILE), Image.BOX)
            arr = np.asarray(im)
            if arr[..., 3].any():
                out[(px, py)] = arr
        return out


    def candidates(f, with_corridor, layer):
        span = TILE * f
        rects = [(a["offset"][0], a["offset"][1], a["size"], a["size"]) for a in areas]
        if with_corridor and layer != "up":
            rects += [(cx, cy, CORE, CORE) for cx, cy, _ in cells]
        keys = set()
        for x, y, w, h in rects:
            for ty in range(int(y // span), int(math.ceil((y + h) / span))):
                for tx in range(int(x // span), int(math.ceil((x + w) / span))):
                    keys.add((tx, ty))
        return sorted(keys, key=lambda k: (k[1], k[0]))


    index = {}
    sizes = {}
    for layer in ("day", "night", "up"):
        finest, maxz = (UP_FINEST, UP_MAXZ) if layer == "up" else (FINEST, MAXZ)
        index[layer] = {}
        sizes[layer] = 0
        t0 = time.time()
        prev = None
        for z in range(maxz, -1, -1):
            f = level_f(z, finest, maxz)
            if layer != "up" and f == 0.5:
                # finest: areas only (2x); the corridor has no 2x data
                tiles = {k: compose(layer, k[0] * TILE * f, k[1] * TILE * f, f, False) for k in candidates(f, False, layer)}
            elif f <= 1 or (layer == "up" and f <= UP_FINEST):
                tiles = {k: compose(layer, k[0] * TILE * f, k[1] * TILE * f, f, True) for k in candidates(f, True, layer)}
            else:
                tiles = downsample(prev)
            if bg_cells and layer != "up" and f == BG_K:
                # the background's native level: put it under everything drawn so far
                keys = set()
                for x, y, _ in bg_cells:
                    for ty in range(int(y // (TILE * f)), int(math.ceil((y + BG_SPAN) / (TILE * f)))):
                        for tx in range(int(x // (TILE * f)), int(math.ceil((x + BG_SPAN) / (TILE * f)))):
                            keys.add((tx, ty))
                for k in keys:
                    tiles[k] = over(tiles.get(k), compose(layer, k[0] * TILE * f, k[1] * TILE * f, f, False, bg_only=True))
                print(f"  {layer}: background composed under {len(keys)} tiles at f={f:g}")
            tiles = {k: v for k, v in tiles.items() if v[..., 3].any()}
            sizes[layer] += write_level(layer, z, tiles)
            index[layer][str(z)] = sorted([list(k) for k in tiles])
            print(f"  {layer} z{z} (f={f:g}): {len(tiles)} tiles")
            if not (layer != "up" and f == 0.5):
                prev = tiles
        print(f"{layer}: {sizes[layer] / 1e6:.1f} MB in {time.time() - t0:.0f}s")
    pool.shutdown()

    # ------------------------------------------------------------------ meta
    # home view: the listed areas, and/or "background" (the region's outline)
    home = cfg.get("home", [a["id"] for a in areas])
    rects = [(a["offset"][0], a["offset"][1], a["offset"][0] + a["size"], a["offset"][1] + a["size"]) for a in areas if a["id"] in home]
    if "background" in home and bgcfg:
        px_ = [x - OX for x, _ in bgcfg["polygon"]]
        py_ = [y - OY for _, y in bgcfg["polygon"]]
        rects.append((min(px_), min(py_), max(px_), max(py_)))
    hx0, hy0 = min(r_[0] for r_ in rects), min(r_[1] for r_ in rects)
    hx1, hy1 = max(r_[2] for r_ in rects), max(r_[3] for r_ in rects)
    meta = {
        "lat": cor["frame"]["lat"], "lon": cor["frame"]["lon"], "mpp": cor["M_PER_PX"],
        "width": W, "height": H, "size": max(W, H),
        "credits": cor.get("credits", ""),
        "tiles": VERSION,
        "pyramid": {
            "tileSize": TILE, "gutter": GUTTER, "formats": list(FORMATS),
            "layers": {"day": {"maxZ": MAXZ, "finest": FINEST}, "night": {"maxZ": MAXZ, "finest": FINEST},
                       "up": {"maxZ": UP_MAXZ, "finest": UP_FINEST}},
            "index": index,
        },
        "home": [hx0, hy0, hx1, hy1],
        "areas": [{"id": a["id"], "name": a["name"], "data": a["data"], "offset": a["offset"], "size": a["size"]} for a in areas],
        "corridor": {"route": [[x - OX, y - OY] for x, y in cor["route"]]},
    }
    for old in os.listdir(os.path.join(OUT, "tiles")):
        if old != VERSION and os.path.isdir(os.path.join(OUT, "tiles", old)):
            shutil.rmtree(os.path.join(OUT, "tiles", old))
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"))
    print(f"wrote {OUT}/meta.json and tiles/{VERSION} ({sum(sizes.values()) / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
