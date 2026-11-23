# kosmaps

A live, illustrated miniature map of Kosovo — starting with one neighbourhood of Prishtinë
(Dardania, around Rruga Isa Boletini).

Inspired by [Small SF](https://smallsf.com/about): render the city from 3D data with an
orthographic 45° camera, have an image model redraw each tile as an illustration, stitch the tiles
along invisible seams, and bring the map alive with real sun, weather and air quality.

> **Status: private prototype.** The base renders come from Google Photorealistic 3D Tiles, whose
> terms do not allow derived content, machine-read measurements or caching outside Google's
> services. This repository therefore contains **code only** — no renders, generated tiles, height
> data or built map. Don't publish outputs until the data licensing is sorted out.

## What it does today

- 3×3 tiles (~615 m × 615 m) rendered from Google 3D with CesiumJS in headless Chrome
- Day and night illustrated tile sets (image model via Codex CLI), stitched with min-cost seams
- One self-contained HTML viewer (WebGL) with pan/zoom and live lighting/weather:
  real sun position, cloud, rain, snow and PM2.5 smog from Open-Meteo
- Clickable buildings: OpenStreetMap name/address/use/places-inside, height from the 3D surface,
  straight 3D outline box; OSM footprints that disagree with the 3D are rebuilt from the roof

## Layout

```
pipeline/          the Google-3D pipeline (run everything from this folder)
osm-prototype/     earlier legally-clean renderer that draws a tile from OpenStreetMap alone
```

## Requirements

- Node 20+ and Google Chrome (Playwright drives the installed Chrome: `channel: 'chrome'`)
- Python 3.11+ (`pip install -r requirements.txt`)
- `GCP_MAPS_KEY`: Google Maps Platform key with the **Map Tiles API** enabled
- [Codex CLI](https://github.com/openai/codex) logged in, with image generation enabled
  (`codex features list | grep image_generation`)

```bash
npm install
python -m venv .venv && .venv/bin/pip install -r requirements.txt
```

## Pipeline

All steps run from `pipeline/`. Outputs land next to the scripts and are git-ignored.

| # | Step | Command | Output |
|---|---|---|---|
| 1 | Render overlapping Google 3D tiles (ortho, heading 45°, pitch −45°, 0.2 m/px) | `node grid.mjs 1 [lat] [lon]` | `tiles_raw/` |
| 2 | Style reference: restyle one tile once (see `style_tile_prompt.txt`), save as `stylized_google.png` | Codex, manual | `stylized_google.png` |
| 3 | Restyle every tile (day) | `N=3 ./style_all.sh` | `tiles_styled/` |
| 4 | Stitch day mosaic with min-cost seams | `python stitch.py` | `mosaic_styled.png`, `*_seams.json` |
| 5 | Night set generated from the day tiles | `N=3 ./night_all.sh` | `tiles_night/` |
| 6 | Stitch night along the *same* seams | `python stitch.py tiles_night mosaic_night.png mosaic_styled_seams.json` | `mosaic_night.png` |
| 7 | Sky-facing mask (rain sheen, snow) | `node aux_pass.mjs` then `python stitch.py aux mosaic_up.png mosaic_styled_seams.json "up_{c}_{r}.png"` | `mosaic_up.png` |
| 8 | Height pass (12-bit, 1/16 m) and decode | `node height_pass.mjs && python decode_height.py` | `height_mosaic.npy` |
| 9 | OpenStreetMap buildings/POIs/roads for the area | Overpass query (see below) | `osm_area.json` |
| 10 | Buildings, pass 1 | `NO_OVERRIDES=1 python build_buildings.py` | `buildings.json`, `idmap.png` |
| 11 | Top-down surface + fix footprints that disagree with 3D | `python dsm.py && python refine_footprints.py` | `footprint_overrides.json` |
| 12 | Buildings, pass 2 | `python build_buildings.py` | `buildings.json`, `idmap.png` |
| 13 | Build the single-file viewer | `python build_live.py small_prishtine.html` | `small_prishtine.html` |

Overpass query used for step 9 (bbox around the 3×3 grid):

```
[out:json][timeout:90];
(way[building](42.6445,21.1455,42.6605,21.1675);relation[building](42.6445,21.1455,42.6605,21.1675);
 node["addr:housenumber"](42.6445,21.1455,42.6605,21.1675);node[name](42.6445,21.1455,42.6605,21.1675);
 way[highway](42.6445,21.1455,42.6605,21.1675););
out body;>;out skel qt;
```

### Debug / analysis tools

- `compare_seams.py` — crossfade vs hard cut vs min-cost seam at the worst-disagreement spots
- `variants.py` — lighting/weather filter variants of one tile (contact sheet)
- `draw_boxes.py` — every building box drawn over the illustration (alignment review)
- `fit_offsets.py` — per-building OSM-vs-3D offset search (diagnostic)
- `render.mjs` + `index.html` — render a single tile; `viewer.html` — simple pan/zoom image viewer

## Key ideas

- **Exact camera.** Orthographic, heading 45°, pitch −45°, so any (east, north, height) maps to a
  mosaic pixel with closed-form maths, and any pixel + its height maps back to the ground.
- **Neighbours line up by construction.** Tiles are produced by sliding one camera along its own
  axes; overlaps match pixel-for-pixel. Cesium resets ortho width every frame in 3D mode, so it is
  pinned in `preRender`.
- **Seams.** Overlap bands are cut along the minimum-difference path (dynamic programming) with a
  4 px feather — no crossfade ghosting.
- **Data passes.** Extra renders with custom shaders (sky-facing mask, height encoded as pure 0/1
  bit-planes so no colour transform can corrupt it) give per-pixel geometry for free.
- **Day/night.** Only night needs its own generation; dusk, golden hour, cloud, rain, snow and smog
  are shader effects over the two sets.

## Cost notes

One tile ≈ 205 m × 290 m of ground (0.059 km²). Day + night ≈ 2 images per tile.
Prishtinë ≈ 1,400 images; all of Kosovo at full detail ≈ 367k images — use a coarser countryside
level for national coverage.

## Data credits

OpenStreetMap contributors (ODbL) · Open-Meteo (weather, air quality) · Google Photorealistic 3D
Tiles (private prototype base; not redistributed here) · CesiumJS.
