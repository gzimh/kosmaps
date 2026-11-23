"""Debug: draw every building's box (roof solid, verticals) over the illustration. Orange = outline rebuilt from 3D."""
import json, math, sys
from PIL import Image, ImageDraw
D = json.load(open("buildings.json")); S2 = math.sqrt(.5); C = D["npx"] / 2; M = D["mpp"]
P = lambda e, n, h: (C + (S2 * e - S2 * n) / M, C - (0.5 * e + 0.5 * n + S2 * h) / M)
im = Image.open("mosaic_styled.png").convert("RGB"); d = ImageDraw.Draw(im, "RGBA")
for b in D["buildings"]:
    top = max(b["roof_main"], b["ground"] + 2)
    col = (255, 140, 0, 230) if b.get("fixed") else (255, 255, 255, 230)
    roof = [P(e, n, top) for e, n in b["fp"]]; base = [P(e, n, b["ground"]) for e, n in b["fp"]]
    d.line(roof, fill=col, width=3)
    for (a, c) in zip(base, roof): d.line([a, c], fill=col[:3] + (120,), width=1)
    if b["id"] == 47: d.line(roof, fill=(255, 0, 160, 255), width=5)
im.save("aux/boxes_all.png")
for name, (x, y) in {"ptk": (2000, 1500), "centre": (1300, 1200)}.items():
    im.crop((x - 450, y - 450, x + 450, y + 450)).save(f"aux/boxes_{name}.png")
