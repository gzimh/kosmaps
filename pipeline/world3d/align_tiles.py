"""Warp each restyled tile back onto its source tile's geometry, so neighbouring tiles meet exactly.

The image model keeps the layout but drifts (up to ~70 px, varying across a tile). The raw tiles are
pixel-aligned with each other by construction, so aligning every styled tile to the raw geometry
makes roads continue across seams.

Anchors, per tile:
  1. roads: the illustration's asphalt (grey, unsaturated) against the OSM road network drawn into the
     tile with the camera formula — exact geometry, and roads look alike in any style;
  2. elsewhere, edges of the raw photo (field boundaries, paths) against the illustration's edges.
Coarse whole-tile shift first, then overlapping blocks searched around it; unreliable blocks are
dropped, the field is filled from neighbours, smoothed, upsampled and the tile resampled.

Usage: python world3d/align_tiles.py <styled_dir> <raw_dir> <out_dir> <world.json>   (from the work dir)
"""
import glob
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

src, raw_dir, dst, world_path = sys.argv[1:5]
os.makedirs(dst, exist_ok=True)
grid = json.load(open(os.path.join(raw_dir, "grid.json")))
world = json.load(open(world_path))
SIZE, MPP, R = grid["SIZE"], grid["M_PER_PX"], grid["R"]
BLOCK, STRIDE = 320, 120
S2 = math.sqrt(0.5)
o = world["origin"]
M_LAT = 111132.92 - 559.82 * math.cos(2 * math.radians(o["lat"]))
M_LON = 111412.84 * math.cos(math.radians(o["lat"]))


def tile_centre(i, j):
    step = grid["CORE"] * MPP
    sr, su = (i - R) * step, (R - j) * step
    return ((grid["lon"] - o["lon"]) * M_LON + sr * S2 + su, (grid["lat"] - o["lat"]) * M_LAT - sr * S2 + su)


def road_mask(i, j):
    cx, cy = tile_centre(i, j)
    img = Image.new("L", (SIZE, SIZE), 0)
    d = ImageDraw.Draw(img)
    for r in world["roads"]:
        pts = []
        for x, y in r["pts"]:
            dx, dy = x - cx, y - cy
            pts.append((SIZE / 2 + (dx - dy) * S2 / MPP, SIZE / 2 - (dx + dy) / 2 / MPP))
        d.line(pts, fill=255, width=max(3, int(r["width"] / MPP * 0.8)))
    return ndimage.gaussian_filter(np.asarray(img, np.float32) / 255, 3)


def road_likelihood(im, mask):
    """How road-like each pixel's colour is, learnt from this tile: colours over-represented inside the
    (possibly offset) OSM road mask vs outside it. Works whatever colour the model painted streets."""
    a = (np.asarray(im, np.int32) // 16)
    key = a[..., 0] * 256 + a[..., 1] * 16 + a[..., 2]
    inside = ndimage.binary_dilation(mask > 0.5, iterations=12)
    hin = np.bincount(key[inside], minlength=4096).astype(np.float32) + 1
    hout = np.bincount(key[~inside], minlength=4096).astype(np.float32) + 1
    ratio = (hin / hin.sum()) / (hout / hout.sum())
    lik = np.clip(np.log(ratio[key]), 0, 3) / 3
    return ndimage.gaussian_filter(lik.astype(np.float32), 3)


def edges(im):
    g = ndimage.gaussian_filter(np.asarray(im.convert("L"), np.float32), 1.6)
    e = np.hypot(ndimage.sobel(g, 0), ndimage.sobel(g, 1))
    return np.minimum(e / (ndimage.uniform_filter(e, 31) + 1e-3), 4.0)


def corr_surface(a, b):
    """Phase-correlation surface; value at (dy, dx) (centred) = match of b shifted by (dx, dy) onto a."""
    h, w = a.shape
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    A = np.fft.fft2((a - a.mean()) * win)
    B = np.fft.fft2((b - b.mean()) * win)
    Rr = A.conj() * B
    return np.fft.fftshift(np.fft.ifft2(Rr / (np.abs(Rr) + 1e-6)).real)


def best_peak(r, expect, radius):
    """Peak within `radius` of the expected shift; returns dx, dy, quality ratio."""
    h, w = r.shape
    cy, cx = h // 2, w // 2
    ex, ey = expect
    y0, y1 = int(max(0, cy + ey - radius)), int(min(h, cy + ey + radius + 1))
    x0, x1 = int(max(0, cx + ex - radius)), int(min(w, cx + ex + radius + 1))
    win = r[y0:y1, x0:x1]
    y, x = np.unravel_index(win.argmax(), win.shape)
    peak = win[y, x]
    masked = win.copy()
    masked[max(0, y - 6):y + 7, max(0, x - 6):x + 7] = -1
    ratio = peak / max(masked.max(), 1e-6)

    def sub(v0, v1, v2):
        d = v0 - 2 * v1 + v2
        return 0.0 if abs(d) < 1e-9 else 0.5 * (v0 - v2) / d
    fy = sub(win[y - 1, x], peak, win[y + 1, x]) if 0 < y < win.shape[0] - 1 else 0
    fx = sub(win[y, x - 1], peak, win[y, x + 1]) if 0 < x < win.shape[1] - 1 else 0
    return x0 + x - cx + fx, y0 + y - cy + fy, peak, ratio


report = {}
for path in sorted(glob.glob(os.path.join(src, "tile_*.png"))):
    name = os.path.basename(path)
    i, j = (int(v) for v in name[5:-4].split("_"))
    rawim = Image.open(os.path.join(raw_dir, name)).convert("RGB")
    sty = Image.open(path).convert("RGB")
    if sty.size != rawim.size:
        sty = sty.resize(rawim.size, Image.LANCZOS)
    ra = road_mask(i, j)
    rb = road_likelihood(sty, ra)
    ea, eb = edges(rawim), edges(sty)
    gpath = os.path.join(os.path.dirname(raw_dir.rstrip("/")) or ".", "guides", f"guide_{i}_{j}.png")
    eg = edges(Image.open(gpath).convert("RGB")) if os.path.exists(gpath) else None

    # coarse: whole tile at 1/4 resolution, roads + edges together
    def small(x):
        return ndimage.zoom(x, 0.25, order=1)
    rc = corr_surface(small(ra), small(rb)) + 0.5 * corr_surface(small(ea), small(eb))
    if eg is not None:
        rc += 0.5 * corr_surface(small(eg), small(eb))
    cdx, cdy, _, cq = best_peak(rc, (0, 0), 40)
    coarse = (cdx * 4, cdy * 4) if cq > 1.2 else (0.0, 0.0)

    starts = list(range(0, SIZE - BLOCK + 1, STRIDE))
    if starts[-1] != SIZE - BLOCK:
        starts.append(SIZE - BLOCK)
    n = len(starts)
    fx = np.full((n, n), np.nan, np.float32)
    fy = np.full((n, n), np.nan, np.float32)
    src_kind = np.zeros((n, n), np.int8)
    for bj, y0 in enumerate(starts):
        for bi, x0 in enumerate(starts):
            sl = (slice(y0, y0 + BLOCK), slice(x0, x0 + BLOCK))
            a, b = ra[sl], rb[sl]
            got = None
            if a.mean() > 0.03 and b.mean() > 0.03:
                dx, dy, peak, q = best_peak(corr_surface(a, b), coarse, 70)
                if peak > 0.03 and q > 1.25:
                    got, kind = (dx, dy), 1
            if got is None and eg is not None and eg[sl].std() > 0.05:
                dx, dy, peak, q = best_peak(corr_surface(eg[sl], eb[sl]), coarse, 50)
                if peak > 0.05 and q > 1.35:
                    got, kind = (dx, dy), 3
            if got is None and ea[sl].std() > 0.05:
                dx, dy, peak, q = best_peak(corr_surface(ea[sl], eb[sl]), coarse, 40)
                if peak > 0.05 and q > 1.4:
                    got, kind = (dx, dy), 2
            if got:
                fx[bj, bi], fy[bj, bi] = got
                src_kind[bj, bi] = kind
    # outliers vs neighbourhood, fill, smooth
    for f in (fx, fy):
        med = ndimage.generic_filter(f, np.nanmedian, size=3, mode="nearest")
        bad = np.isfinite(f) & np.isfinite(med) & (np.abs(f - med) > 10)
        f[bad] = np.nan
    used = int(np.isfinite(fx).sum())
    for f, m in ((fx, coarse[0]), (fy, coarse[1])):
        if np.isnan(f).all():
            f[:] = m
        while np.isnan(f).any():
            filled = ndimage.generic_filter(f, np.nanmean, size=3, mode="nearest")
            hole = np.isnan(f) & np.isfinite(filled)
            if not hole.any():
                f[np.isnan(f)] = m
                break
            f[hole] = filled[hole]
        f[:] = ndimage.gaussian_filter(f, 0.9, mode="nearest")

    centres = np.array(starts) + BLOCK / 2
    ci = np.interp(np.arange(SIZE), centres, np.arange(n)).astype(np.float32)
    rows, cols = ci[:, None].repeat(SIZE, 1), ci[None, :].repeat(SIZE, 0)
    gx = ndimage.map_coordinates(fx, [rows, cols], order=1, mode="nearest")
    gy = ndimage.map_coordinates(fy, [rows, cols], order=1, mode="nearest")
    yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
    arr = np.asarray(sty, np.float32)
    out = np.empty_like(arr)
    for c in range(3):
        out[..., c] = ndimage.map_coordinates(arr[..., c], [yy + gy, xx + gx], order=3, mode="nearest")
    out = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    out.save(os.path.join(dst, name))
    # residual road agreement after warping (correlation of masks), before/after
    rb2 = road_likelihood(out, ra)
    def agree(p, q):
        p, q = p - p.mean(), q - q.mean()
        return float((p * q).sum() / (np.sqrt((p * p).sum() * (q * q).sum()) + 1e-6))
    report[name] = {"coarse": [round(coarse[0], 1), round(coarse[1], 1)], "blocks": used, "of": n * n,
                    "road_blocks": int((src_kind == 1).sum()), "guide_blocks": int((src_kind == 3).sum()), "max_shift": round(float(np.hypot(fx, fy).max()), 1),
                    "road_corr": [round(agree(ra, rb), 3), round(agree(ra, rb2), 3)]}
    print(name, report[name], flush=True)
json.dump(report, open(os.path.join(dst, "align_report.json"), "w"), indent=1)
