"""Even out colour between neighbouring tiles before stitching.

Each tile is drawn on its own, so one can come out a little warmer or brighter than its neighbour.
Neighbouring tiles overlap by 2 x MARGIN px, so their robust mean colour in each shared strip
should agree. Per channel, solve for one gain per tile (in log space, least squares over all
shared strips, gently pulled towards 1 so the map keeps its overall palette) and apply it.

Usage (from pipeline/): python color_match.py <tiles_dir> <out_dir>
"""
import json
import os
import sys

import numpy as np
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
g = json.load(open("tiles_raw/grid.json"))
R, CORE, SIZE = g["R"], g["CORE"], g["SIZE"]
n = 2 * R + 1
OV = SIZE - CORE
REG = 0.15            # pull towards gain 1

tiles = {}
for r in range(n):
    for c in range(n):
        im = Image.open(f"{src}/tile_{c}_{r}.png").convert("RGB")
        if im.size != (SIZE, SIZE):
            im = im.resize((SIZE, SIZE), Image.LANCZOS)
        tiles[(c, r)] = np.asarray(im, np.float64)


def robust_mean(a):
    p = a.reshape(-1, 3)
    lo, hi = np.percentile(p, 10, axis=0), np.percentile(p, 90, axis=0)
    out = []
    for ch in range(3):
        v = p[:, ch]
        out.append(v[(v >= lo[ch]) & (v <= hi[ch])].mean())
    return np.array(out)


pairs = []   # (i, j, mean_i, mean_j) over the strip they share
idx = {k: i for i, k in enumerate(sorted(tiles))}
for (c, r), A in tiles.items():
    if (c + 1, r) in tiles:
        B = tiles[(c + 1, r)]
        pairs.append((idx[(c, r)], idx[(c + 1, r)], robust_mean(A[:, CORE:]), robust_mean(B[:, :OV])))
    if (c, r + 1) in tiles:
        B = tiles[(c, r + 1)]
        pairs.append((idx[(c, r)], idx[(c, r + 1)], robust_mean(A[CORE:, :]), robust_mean(B[:OV, :])))

T = len(tiles)
gains = np.ones((T, 3))
for ch in range(3):
    rows, rhs = [], []
    for i, j, mi, mj in pairs:
        row = np.zeros(T)
        row[i], row[j] = 1, -1                      # log g_i - log g_j = log m_j - log m_i
        rows.append(row)
        rhs.append(np.log(mj[ch]) - np.log(mi[ch]))
    for i in range(T):
        row = np.zeros(T)
        row[i] = REG
        rows.append(row)
        rhs.append(0.0)
    x, *_ = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)
    gains[:, ch] = np.exp(x)

before = np.mean([np.abs(mi - mj).mean() for _, _, mi, mj in pairs])
after = np.mean([np.abs(mi * gains[i] - mj * gains[j]).mean() for i, j, mi, mj in pairs])
for (c, r), A in tiles.items():
    out = np.clip(A * gains[idx[(c, r)]], 0, 255).astype(np.uint8)
    Image.fromarray(out).save(f"{dst}/tile_{c}_{r}.png")
print(f"colour-matched {T} tiles: mean strip colour difference {before:.2f} -> {after:.2f}; "
      f"gains R {gains[:, 0].min():.3f}-{gains[:, 0].max():.3f}, G {gains[:, 1].min():.3f}-{gains[:, 1].max():.3f}, "
      f"B {gains[:, 2].min():.3f}-{gains[:, 2].max():.3f}")
