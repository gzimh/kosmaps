"""Bundle day/night/mask mosaics into ONE self-contained HTML (images inlined as WebP data URLs).

Data URLs are not cross-origin, so WebGL can sample them even when opened via file://.
Usage: python build_live.py [out=small_prishtine.html]
"""
import base64
import io
import json
import sys

from PIL import Image

out = sys.argv[1] if len(sys.argv) > 1 else "small_prishtine.html"
g = json.load(open("tiles_raw/grid.json"))


def data_url(path, quality, mode="RGB"):
    im = Image.open(path).convert(mode)
    if mode == "L":
        im = im.convert("RGB")  # keep a single texture format in the shader
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=quality, method=6)
    b = buf.getvalue()
    print(f"  {path}: {im.size[0]}x{im.size[1]} -> {len(b) / 1e6:.1f} MB webp")
    return "data:image/webp;base64," + base64.b64encode(b).decode()


html = open("live_template.html").read()
html = html.replace("__LAT__", str(g["lat"])).replace("__LON__", str(g["lon"]))
html = html.replace("__DAY__", data_url("mosaic_styled.png", 82))
html = html.replace("__NIGHT__", data_url("mosaic_night.png", 82))
html = html.replace("__UP__", data_url("mosaic_up.png", 70, "L"))
# ID map must be lossless (exact building indices)
buf = io.BytesIO(); Image.open("idmap.png").convert("RGB").save(buf, "PNG", optimize=True)
print(f"  idmap.png -> {len(buf.getvalue()) / 1e6:.1f} MB png")
html = html.replace("__IDMAP__", "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())
html = html.replace("__BUILDINGS__", open("buildings.json").read())
open(out, "w").write(html)
print(f"saved {out} ({len(html) / 1e6:.1f} MB)")
