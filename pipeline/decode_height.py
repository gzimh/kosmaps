"""Decode the 4x3-bit height passes into one float height mosaic (metres relative to target ground)."""
import json
import numpy as np
from PIL import Image

g = json.load(open("tiles_raw/grid.json"))
R, C, M = g["R"], g["CORE"], g["MARGIN"]
n = 2 * R + 1
H = np.full((n * C, n * C), np.nan, np.float32)
impure = 0
for r in range(n):
    for c in range(n):
        q = np.zeros((g["SIZE"], g["SIZE"]), np.int32)
        for bit in range(4):
            a = np.asarray(Image.open(f"aux/h{bit}_{c}_{r}.png").convert("RGB"), np.int32)
            impure += int(((a > 40) & (a < 215)).sum())
            bits = (a > 127).astype(np.int32)
            q |= (bits[..., 0] | bits[..., 1] << 1 | bits[..., 2] << 2) << (3 * bit)
        h = q.astype(np.float32) * 0.0625 - 64
        h[q == 0] = np.nan  # background
        H[r * C:(r + 1) * C, c * C:(c + 1) * C] = h[M:M + C, M:M + C]
np.save("height_mosaic.npy", H)
v = H[np.isfinite(H)]
print(f"impure channel values: {impure} ; valid px {v.size / H.size:.1%} ; height range {np.percentile(v, 1):.1f} .. {np.percentile(v, 99.9):.1f} m (median {np.median(v):.1f})")
vis = np.clip((np.nan_to_num(H, nan=-20) + 20) / 80, 0, 1)
Image.fromarray((vis * 255).astype(np.uint8)).resize((1024, 1024)).save("aux/height_preview.png")
