"""2x upscale of a stitched mosaic with Real-ESRGAN (realesrgan-ncnn-vulkan, x4plus-anime model).

The model sharpens ink lines and flat colour far better than resampling, which makes the closest
zoom level crisp. It runs x4 on overlapping chunks (the whole mosaic at x4 would not fit in
memory), each chunk is reduced to x2 with Lanczos and its padding trimmed, then pasted together.

Usage (from pipeline/): python upscale.py <in.png> <out.png> [esrgan_dir=~/tools/realesrgan]
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

CHUNK, PAD = 768, 24
src, dst = sys.argv[1], sys.argv[2]
tool = os.path.expanduser(sys.argv[3] if len(sys.argv) > 3 else "~/tools/realesrgan")

im = Image.open(src).convert("RGB")
W, H = im.size
work = tempfile.mkdtemp(prefix="upscale_")
inp, outp = os.path.join(work, "in"), os.path.join(work, "out")
os.makedirs(inp)
os.makedirs(outp)
boxes = {}
for y in range(0, H, CHUNK):
    for x in range(0, W, CHUNK):
        x0, y0 = max(0, x - PAD), max(0, y - PAD)
        x1, y1 = min(W, x + CHUNK + PAD), min(H, y + CHUNK + PAD)
        name = f"{x}_{y}.png"
        im.crop((x0, y0, x1, y1)).save(os.path.join(inp, name))
        boxes[name] = (x, y, x0, y0, x1, y1)

subprocess.run([os.path.join(tool, "realesrgan-ncnn-vulkan"), "-i", inp, "-o", outp, "-n", "realesrgan-x4plus-anime",
                "-s", "4", "-m", os.path.join(tool, "models"), "-f", "png"], check=True, capture_output=True)

big = Image.new("RGB", (W * 2, H * 2))
for name, (x, y, x0, y0, x1, y1) in boxes.items():
    up = Image.open(os.path.join(outp, name)).convert("RGB")
    up = up.resize(((x1 - x0) * 2, (y1 - y0) * 2), Image.LANCZOS)
    cw, ch = min(CHUNK, W - x), min(CHUNK, H - y)
    big.paste(up.crop(((x - x0) * 2, (y - y0) * 2, (x - x0 + cw) * 2, (y - y0 + ch) * 2)), (x * 2, y * 2))
big.save(dst)
shutil.rmtree(work)
print(f"{src} {W}x{H} -> {dst} {W * 2}x{H * 2} ({len(boxes)} chunks)")
