"""Stitch styled tiles into one seamless mosaic.

Each tile has CORE unique pixels plus MARGIN overlap on every side, so neighbours share a
2*MARGIN band. Inside that band we find the minimum-difference seam with dynamic programming
(the path along which the two drawings agree most), cut along it, and feather a few pixels.

Usage: python stitch.py [styled_dir=tiles_styled] [out=mosaic_styled.png]
Also writes <out>_naive.png (hard cut at core boundaries) for comparison.
"""
import json
import sys

import numpy as np
from PIL import Image, ImageFilter

src = sys.argv[1] if len(sys.argv) > 1 else "tiles_styled"
out_path = sys.argv[2] if len(sys.argv) > 2 else "mosaic_styled.png"
# optional: reuse seam paths from a previous stitch (so day/night/mask layers cut identically)
reuse = json.load(open(sys.argv[3])) if len(sys.argv) > 3 and sys.argv[3] != "-" else None
pattern = sys.argv[4] if len(sys.argv) > 4 else "tile_{c}_{r}.png"
g = json.load(open("tiles_raw/grid.json"))
R, C, M, S = g["R"], g["CORE"], g["MARGIN"], g["SIZE"]
n = 2 * R + 1
FEATHER = 4


def load(c, r):
    im = Image.open(f"{src}/" + pattern.format(c=c, r=r)).convert("RGB")
    if im.size != (S, S):
        im = im.resize((S, S), Image.LANCZOS)
    return np.asarray(im, dtype=np.float32)


def box_blur(a, r):
    k = 2 * r + 1
    p = np.pad(a, r, mode="edge")
    c = np.cumsum(np.cumsum(p, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0)))
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def min_seam(cost):
    """Vertical seam through cost[h, w]: returns x index per row minimising total cost."""
    h, w = cost.shape
    acc = cost.copy()
    back = np.zeros((h, w), dtype=np.int32)
    for y in range(1, h):
        prev = acc[y - 1]
        left = np.r_[np.inf, prev[:-1]]
        right = np.r_[prev[1:], np.inf]
        stack = np.stack([left, prev, right])
        k = stack.argmin(0)
        back[y] = k - 1
        acc[y] += stack[k, np.arange(w)]
    seam = np.zeros(h, dtype=np.int32)
    seam[-1] = int(acc[-1].argmin())
    for y in range(h - 1, 0, -1):
        seam[y - 1] = np.clip(seam[y] + back[y, seam[y]], 0, w - 1)
    return seam


W = n * C + 2 * M
canvas = np.zeros((W, W, 3), np.float32)
filled = np.zeros((W, W), bool)
naive = np.zeros((W, W, 3), np.float32)
seam_cost = []
seams_out = []  # (kind, canvas_x0, canvas_y0, path)

for r in range(n):
    for c in range(n):
        t = load(c, r)
        x0, y0 = c * C, r * C
        # naive: hard cut at the middle of each overlap band
        nx0 = 0 if c == 0 else M
        ny0 = 0 if r == 0 else M
        naive[y0 + ny0:y0 + S, x0 + nx0:x0 + S] = t[ny0:, nx0:]

        mask = np.ones((S, S), np.float32)  # 1 = take new tile
        region = canvas[y0:y0 + S, x0:x0 + S]
        have = filled[y0:y0 + S, x0:x0 + S]
        diff = np.abs(region - t).sum(-1)
        # smooth the cost a little so the seam prefers regions that agree over a neighbourhood
        diff_s = box_blur(diff, 2)
        if c > 0:  # left band: x in [0, 2M)
            band = diff_s[:, :2 * M].copy()
            band[~have[:, :2 * M]] = 0
            sx = np.array(reuse[len(seams_out)][3]) if reuse else min_seam(band)
            xs = np.arange(S)[None, :]
            mask *= (xs > sx[:, None]).astype(np.float32)
            seam_cost.append(float(diff[np.arange(S), sx].mean()))
            seams_out.append(('v', x0, y0, sx.tolist()))
        if r > 0:  # top band: y in [0, 2M)
            band = diff_s[:2 * M, :].T.copy()
            band[~have[:2 * M, :].T] = 0
            sy = np.array(reuse[len(seams_out)][3]) if reuse else min_seam(band)
            ys = np.arange(S)[:, None]
            mask *= (ys > sy[None, :]).astype(np.float32)
            seam_cost.append(float(diff[sy, np.arange(S)].mean()))
            seams_out.append(('h', x0, y0, sy.tolist()))
        # only pixels already filled need blending; elsewhere always take the new tile
        mask = np.where(have, mask, 1.0)
        if FEATHER:
            m_img = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(FEATHER))
            soft = np.asarray(m_img, np.float32) / 255
            mask = np.where(have, soft, 1.0)
        canvas[y0:y0 + S, x0:x0 + S] = region * (1 - mask[..., None]) + t * mask[..., None]
        filled[y0:y0 + S, x0:x0 + S] = True

crop = (slice(M, M + n * C), slice(M, M + n * C))
Image.fromarray(canvas[crop].clip(0, 255).astype(np.uint8)).save(out_path)
Image.fromarray(naive[crop].clip(0, 255).astype(np.uint8)).save(out_path.replace(".png", "_naive.png"))
json.dump(seams_out, open(out_path.replace(".png", "_seams.json"), "w"))
print(f"saved {out_path} {n * C}x{n * C}; mean |diff| along seams: {np.mean(seam_cost):.1f} (0 = identical)")
