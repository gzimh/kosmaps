"""Lighting/weather variants of one styled tile using only post-processing filters.

Inputs: tiles_styled/tile_1_1.png (day illustration), aux/up_1_1.png (faces-sky mask rendered from the 3D),
optional variants/night_generated.png (image-model night version).
Everything here is cheap per-pixel maths that a WebGL shader could do live in the browser.
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 1280
day = np.asarray(Image.open("tiles_styled/tile_1_1.png").convert("RGB").resize((S, S), Image.LANCZOS), np.float32) / 255
up = np.asarray(Image.open("aux/up_1_1.png").convert("L").resize((S, S)), np.float32) / 255
rng = np.random.default_rng(3)


def luma(x):
    return (x * [0.299, 0.587, 0.114]).sum(-1, keepdims=True)


def sat(x, k):
    l = luma(x)
    return l + (x - l) * k


def contrast(x, k, pivot=0.5):
    return (x - pivot) * k + pivot


def noise(scale, seed):
    r = np.random.default_rng(seed)
    small = r.random((S // scale + 2, S // scale + 2)).astype(np.float32)
    im = Image.fromarray((small * 255).astype(np.uint8)).resize((S, S), Image.BICUBIC).filter(ImageFilter.GaussianBlur(scale / 3))
    return np.asarray(im, np.float32)[..., None] / 255


yy = np.linspace(0, 1, S, dtype=np.float32)[:, None, None]  # 0 = top (farther from camera)

out = {"Day (generated once)": day}

# Golden hour: warm, slightly contrasty, sun-side lift
g = contrast(day, 1.08) * np.array([1.10, 0.93, 0.74])
g = g + 0.05 * np.array([1.0, 0.6, 0.2]) * (1 - yy)
out["Golden hour (filter)"] = g

# Overcast: flat, desaturated, cool, with soft drifting cloud shadows
cloud = noise(160, 1)
o = contrast(sat(day, 0.55), 0.82) * np.array([0.92, 0.95, 1.0]) * 0.93
o = o * (0.86 + 0.16 * cloud)
out["Overcast + cloud shadows (filter)"] = o

# Smog: blend toward warm grey haze, thicker toward the top (further away), PM2.5-driven strength
haze = np.array([0.78, 0.74, 0.66])
k = 0.38 + 0.22 * (1 - yy)
out["Winter smog, PM2.5 ~120 (filter)"] = sat(day, 0.7) * (1 - k) + haze * k

# Rain: overcast, darker, wet sheen on sky-facing surfaces, streaks
r = contrast(sat(day, 0.5), 0.8) * np.array([0.82, 0.86, 0.94]) * 0.82
wet = (up[..., None] > 0.85) * 0.10 * noise(24, 5)
r = r + wet
streak = Image.new("L", (S, S), 0)
d = ImageDraw.Draw(streak)
for _ in range(1400):
    x, y = rng.integers(0, S, 2)
    d.line([(x, y), (x - 6, y + 26)], fill=int(rng.integers(60, 140)), width=1)
r = r + (np.asarray(streak, np.float32)[..., None] / 255) * 0.35
out["Rain (filter + 3D mask)"] = r

# Snow: whiten sky-facing surfaces (roofs, ground, tree tops) using the 3D mask; cool the rest
m = np.clip((up - 0.80) / 0.15, 0, 1)[..., None]
m = m * (0.75 + 0.25 * noise(12, 9))
snow_col = np.array([0.95, 0.97, 1.0]) * (0.88 + 0.12 * luma(day))
base = contrast(sat(day, 0.6), 0.9) * np.array([0.88, 0.92, 1.0])
out["Snow (filter + 3D mask)"] = base * (1 - m * 0.85) + snow_col * m * 0.85

# Night, filter only: what you get if you just darken and tint
out["Night — filter only"] = sat(day, 0.45) * np.array([0.20, 0.25, 0.42])

if os.path.exists("variants/night_generated.png"):
    night = np.asarray(Image.open("variants/night_generated.png").convert("RGB").resize((S, S), Image.LANCZOS), np.float32) / 255
    out["Night — generated once"] = night
    # Dusk: blend the two baked sets, then grade. This is how a live sun position would drive it.
    out["Dusk = 55% night + golden grade"] = g * 0.45 + night * 0.55 * np.array([1.05, 0.95, 1.0])

# contact sheet
T = 420
cols = 3
rows = (len(out) + cols - 1) // cols
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 19)
sheet = Image.new("RGB", (cols * (T + 12) + 12, rows * (T + 40) + 12), (245, 240, 230))
dr = ImageDraw.Draw(sheet)
crop = (S // 2 - 340, S // 2 - 340, S // 2 + 340, S // 2 + 340)  # centre crop for visibility
for i, (name, im) in enumerate(out.items()):
    pil = Image.fromarray((np.clip(im, 0, 1) * 255).astype(np.uint8)).crop(crop).resize((T, T), Image.LANCZOS)
    x, y = 12 + (i % cols) * (T + 12), 12 + (i // cols) * (T + 40)
    dr.text((x, y), name, fill=(40, 34, 28), font=font)
    sheet.paste(pil, (x, y + 28))
os.makedirs("variants", exist_ok=True)
sheet.save("variants/contact_sheet.png")
print("saved variants/contact_sheet.png with", len(out), "variants")
