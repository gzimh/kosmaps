"""Turn the raw Google renders from backdrop.mjs into the map's surroundings.

Usage (from the repo root): .venv/bin/python pipeline/backdrop.py <work_dir> [data_dir=public/data]

Stitches <work_dir>/cells into one image in the map's camera frame, matches its colours to the
illustration where they overlap, and writes data_dir/tiles/backdrop-<stamp>.webp plus
`backdrop: {"file", "rect": [x0, y0, x1, y1]}` (mosaic px) in meta.json. The app draws it, as it is,
under the illustration and keeps the camera inside `rect`.
"""
import glob
import json
import os
import sys
import time

import numpy as np
from PIL import Image

work = sys.argv[1]
data = sys.argv[2] if len(sys.argv) > 2 else os.path.join("public", "data")
info = json.load(open(os.path.join(work, "backdrop.json")))
meta = json.load(open(os.path.join(data, "meta.json")))
CORE, MARGIN, K = info["CORE"], info["MARGIN"], info["k"]
span = CORE * K
cells = info["cells"]
c0, r0 = min(c for c, _ in cells), min(r for _, r in cells)
c1, r1 = max(c for c, _ in cells), max(r for _, r in cells)

# 1. stitch the cells' cores
raw = Image.new("RGB", ((c1 - c0 + 1) * CORE, (r1 - r0 + 1) * CORE))
for c, r in cells:
    im = Image.open(os.path.join(work, "cells", f"cell_{c}_{r}.png")).convert("RGB")
    raw.paste(im.crop((MARGIN, MARGIN, MARGIN + CORE, MARGIN + CORE)), ((c - c0) * CORE, (r - r0) * CORE))
x0, y0, x1, y1 = info["rect"]
ox, oy = c0 * span, r0 * span                       # mosaic px at raw's top-left
raw = raw.crop(tuple(round(v) for v in ((x0 - ox) / K, (y0 - oy) / K, (x1 - ox) / K, (y1 - oy) / K)))

# 2. the illustration at the same scale (the pyramid level with K mosaic px per tile px)
v = meta["tiles"]
pyr = meta["pyramid"]["layers"]["day"]
z = pyr["maxZ"] - round(np.log2(K / pyr["finest"]))
T, G = meta["pyramid"]["tileSize"], meta["pyramid"]["gutter"]
n = meta["size"] // K
ill = Image.new("RGBA", (n, n))
for f in glob.glob(os.path.join(data, "tiles", v, "day", str(z), "*.webp")):
    tx, ty = map(int, os.path.basename(f)[:-5].split("_"))
    t = Image.open(f).convert("RGBA")
    ill.paste(t.crop((G, G, t.width - G, t.height - G)), (tx * T, ty * T))
ill = np.asarray(ill.crop((0, 0, n, n)), dtype=np.float32)
ix, iy = round(-x0 / K), round(-y0 / K)              # illustration's top-left in the backdrop

# 3. colour: match the photo's per-channel mean / spread to the illustration where both exist
a = np.asarray(raw, dtype=np.float32)
mask = ill[..., 3].reshape(-1) > 128
ref = ill[..., :3].reshape(-1, 3)[mask]
inner = a[iy:iy + n, ix:ix + n].reshape(-1, 3)[mask]
a = (a - inner.mean(0)) * (ref.std(0) / np.maximum(inner.std(0), 1)) + ref.mean(0)
a = np.clip(a * 0.92 + a.mean(2, keepdims=True) * 0.08, 0, 255)   # a touch less saturated than the drawing

# 4. write it (versioned name: cached forever) and point meta.json at it
for old in glob.glob(os.path.join(data, "tiles", "backdrop-*.webp")):
    os.remove(old)
name = f"tiles/backdrop-{time.strftime('%Y%m%d-%H%M%S')}.webp"
Image.fromarray(a.astype(np.uint8)).save(os.path.join(data, name), quality=85, method=6)
meta["backdrop"] = {"file": name, "rect": [x0, y0, x1, y1]}
json.dump(meta, open(os.path.join(data, "meta.json"), "w"), indent=2)
print(f"{name}: {raw.width}x{raw.height} px for mosaic px {x0, y0, x1, y1} ({K} mosaic px per px)")
