"""The neighbourhood's perimeter: an invisible outline about 20 m outside its buildings.

Usage (from the repo root): .venv/bin/python pipeline/perimeter.py [data_dir=public/data] [pad_m=20]

Takes the estate's buildings (not the warehouses beyond the main road to the south-east), joins
them into one solid shape (closing gaps up to ~90 m, filling courtyards and parks), pads it by
`pad_m` and writes data_dir/perimeter.png: for every cell, the distance in metres outside the
perimeter (0 inside, capped at 255), covering the backdrop's rectangle. meta.json gets
`perimeter: {"file", "rect", "pad"}`. The app blurs the view progressively from this line outward.
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

data = sys.argv[1] if len(sys.argv) > 1 else os.path.join("public", "data")
PAD = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
CLOSE = 45.0                                  # metres: gaps up to twice this are bridged
meta = json.load(open(os.path.join(data, "meta.json")))
bf = json.load(open(os.path.join(data, meta["layers"]["buildings"])))
S, MPP = bf["npx"], bf["mpp"]
rect = meta.get("backdrop", {}).get("rect", [0, 0, S, S])
CELL = 16                                     # image px per cell
M = CELL * MPP                                # metres per cell (horizontal)
W, H = round((rect[2] - rect[0]) / CELL), round((rect[3] - rect[1]) / CELL)
S2 = math.sqrt(0.5)


def to_image(e, n, h):
    return S / 2 + (S2 * e - S2 * n) / MPP, S / 2 - (0.5 * e + 0.5 * n + S2 * h) / MPP


def in_estate(b):
    """Marigona's own buildings: not the big halls, nor anything beyond the south-east road."""
    fp = b["fp"]
    area = abs(sum(fp[i][0] * fp[i + 1][1] - fp[i + 1][0] * fp[i][1] for i in range(len(fp) - 1))) / 2
    if area > 1200 and b["use"] not in ("Hotel", "School"):
        return False
    x, y = to_image(sum(p[0] for p in fp) / len(fp), sum(p[1] for p in fp) / len(fp), b["ground"])
    return x < 4720 and 2000 * x + 1480 * y < 14.65e6   # west of the road from (5080, 3120) to (3600, 5120)


# 1. the buildings (ground outline and roof, so tall ones are covered up to their tops)
img = Image.new("L", (W, H), 0)
d = ImageDraw.Draw(img)
kept = [b for b in bf["buildings"] if in_estate(b)]
for b in kept:
    for h in (b["ground"], max(b["roof"], b["ground"] + 2)):
        pts = [to_image(e, n, h) for e, n in b["fp"]]
        d.polygon([((x - rect[0]) / CELL, (y - rect[1]) / CELL) for x, y in pts], fill=255)
mask = np.asarray(img) > 0

# 2. one solid shape: close the gaps between buildings, fill holes, then pad
dist_out = ndimage.distance_transform_edt(~mask) * M
solid = ndimage.binary_fill_holes(dist_out <= CLOSE)
dist_in = ndimage.distance_transform_edt(solid) * M
solid = ndimage.binary_fill_holes(dist_in > CLOSE - PAD)
solid = ndimage.gaussian_filter(solid.astype(np.float32), 2.0) > 0.5          # a smooth outline
lab, n = ndimage.label(solid)
if n > 1:                                                                      # keep the main piece
    sizes = ndimage.sum(solid, lab, range(1, n + 1))
    solid = lab == (1 + int(np.argmax(sizes)))

# 3. distance outside the perimeter, in metres
dist = ndimage.distance_transform_edt(~solid) * M
out = np.clip(np.round(dist), 0, 255).astype(np.uint8)
Image.fromarray(out).save(os.path.join(data, "perimeter.png"), optimize=True)
meta["perimeter"] = {"file": "perimeter.png", "rect": rect, "pad": PAD}
json.dump(meta, open(os.path.join(data, "meta.json"), "w"), indent=2)
print(f"perimeter.png: {W}x{H} cells of {M:.1f} m around {len(kept)} of {len(bf['buildings'])} buildings, "
      f"{PAD:.0f} m padding, {solid.sum() * M * M / 1e4:.0f} ha inside")
