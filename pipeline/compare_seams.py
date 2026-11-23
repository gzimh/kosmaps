"""Stress-test seam hiding: crossfade vs naive cut vs min-cost seam, at the worst-disagreement spots."""
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

g = json.load(open("tiles_raw/grid.json"))
R, C, M, S = g["R"], g["CORE"], g["MARGIN"], g["SIZE"]
n = 2 * R + 1
W = n * C + 2 * M

def load(c, r):
    im = Image.open(f"tiles_styled/tile_{c}_{r}.png").convert("RGB")
    return np.asarray(im.resize((S, S), Image.LANCZOS) if im.size != (S, S) else im, np.float32)

tiles = {(c, r): load(c, r) for r in range(n) for c in range(n)}

# crossfade: weighted average with linear ramps across the 2M overlap (classic feathered blend)
ramp = np.ones(S, np.float32)
ramp[:2 * M] = np.linspace(0, 1, 2 * M)
ramp[-2 * M:] = np.linspace(1, 0, 2 * M)
acc = np.zeros((W, W, 3), np.float32); wsum = np.zeros((W, W), np.float32)
for (c, r), t in tiles.items():
    wx = ramp.copy(); wy = ramp.copy()
    if c == 0: wx[:2 * M] = 1
    if c == n - 1: wx[-2 * M:] = 1
    if r == 0: wy[:2 * M] = 1
    if r == n - 1: wy[-2 * M:] = 1
    w = wy[:, None] * wx[None, :]
    acc[r * C:r * C + S, c * C:c * C + S] += t * w[..., None]
    wsum[r * C:r * C + S, c * C:c * C + S] += w
xfade = (acc / wsum[..., None])[M:M + n * C, M:M + n * C]
Image.fromarray(xfade.clip(0, 255).astype(np.uint8)).save("mosaic_styled_crossfade.png")

seam = np.asarray(Image.open("mosaic_styled.png"), np.float32)
naive = np.asarray(Image.open("mosaic_styled_naive.png"), np.float32)
seams = json.load(open("mosaic_styled_seams.json"))

# disagreement map inside every overlap band, in final (cropped) coordinates
dis = np.zeros((n * C, n * C), np.float32)
for c in range(n - 1):
    for r in range(n):
        a, b = tiles[(c, r)], tiles[(c + 1, r)]
        d = np.abs(a[:, C:C + 2 * M] - b[:, :2 * M]).sum(-1)
        y0, x0 = r * C - M, (c + 1) * C - M  # canvas->final: subtract M
        ys, xs = slice(max(0, y0), y0 + S), slice(x0, x0 + 2 * M)
        dis[ys, xs] = np.maximum(dis[ys, xs], d[max(0, -y0):max(0, -y0) + dis[ys, xs].shape[0]])
for r in range(n - 1):
    for c in range(n):
        a, b = tiles[(c, r)], tiles[(c, r + 1)]
        d = np.abs(a[C:C + 2 * M, :] - b[:2 * M, :]).sum(-1)
        y0, x0 = (r + 1) * C - M, c * C - M
        ys, xs = slice(y0, y0 + 2 * M), slice(max(0, x0), x0 + S)
        dis[ys, xs] = np.maximum(dis[ys, xs], d[:, max(0, -x0):max(0, -x0) + dis[ys, xs].shape[1]])

# pick the 3 worst 200x200 windows (non-overlapping)
k = 200
from numpy.lib.stride_tricks import sliding_window_view
cs = np.pad(dis, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
win = cs[k:, k:] - cs[:-k, k:] - cs[k:, :-k] + cs[:-k, :-k]
picks = []
for _ in range(3):
    y, x = np.unravel_index(win.argmax(), win.shape)
    picks.append((x, y))
    win[max(0, y - k):y + k, max(0, x - k):x + k] = -1
print("mean disagreement in overlap bands (0-765):", dis[dis > 0].mean().round(1))

def seam_overlay(x, y):
    """Draw seam paths that pass through the window."""
    pts = []
    for kind, cx0, cy0, path in seams:
        for i, p in enumerate(path):
            px, py = (cx0 + p, cy0 + i) if kind == "v" else (cx0 + i, cy0 + p)
            px, py = px - M, py - M
            if x <= px < x + k and y <= py < y + k:
                pts.append((px - x, py - y))
    return pts

Z = 2  # upscale crops so differences are visible
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
rows = []
for (x, y) in picks:
    crops = [Image.fromarray(im[y:y + k, x:x + k].clip(0, 255).astype(np.uint8)).resize((k * Z, k * Z), Image.NEAREST)
             for im in (xfade, naive, seam)]
    ov = crops[2].copy(); d = ImageDraw.Draw(ov)
    for px, py in seam_overlay(x, y):
        d.point((px * Z, py * Z), fill=(255, 0, 180))
    rows.append(crops + [ov])
labels = ["CROSSFADE (ghosting)", "NAIVE hard cut", "SEAM-CUT (ours)", "ours + seam path"]
out = Image.new("RGB", (4 * k * Z + 50, 3 * k * Z + 40 + 20), "white")
d = ImageDraw.Draw(out)
for i, l in enumerate(labels):
    d.text((i * (k * Z + 15) + 6, 8), l, fill=(0, 0, 0), font=font)
for j, row in enumerate(rows):
    for i, im in enumerate(row):
        out.paste(im, (i * (k * Z + 15), 40 + j * (k * Z + 10)))
out.save("seam_stress_test.png")
print("worst windows:", picks)
