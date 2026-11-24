"""Decode world3d/passes.mjs height tiles into height_mosaic.npy (same format as decode_height.py):
float32 mosaic, metres relative to the camera's ground target, NaN where nothing was drawn.
Usage (from the work dir): python world3d/passes_decode.py
"""
import json

import numpy as np
from PIL import Image

g = json.load(open("tiles_raw/grid.json"))
R, C, M = g["R"], g["CORE"], g["MARGIN"]
n = 2 * R + 1
H = np.full((n * C, n * C), np.nan, np.float32)
for r in range(n):
    for c in range(n):
        a = np.asarray(Image.open(f"aux/hq_{c}_{r}.png").convert("RGB"), np.int32)
        q = a[..., 0] * 256 + a[..., 1]
        h = q.astype(np.float32) / 16 - 64
        h[q == 0] = np.nan
        H[r * C:(r + 1) * C, c * C:(c + 1) * C] = h[M:M + C, M:M + C]
np.save("height_mosaic.npy", H)
v = H[np.isfinite(H)]
print(f"valid px {v.size / H.size:.1%}; height range {np.percentile(v, 1):.1f} .. {np.percentile(v, 99.9):.1f} m (median {np.median(v):.1f})")
