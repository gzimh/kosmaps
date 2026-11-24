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
- A Next.js web app (WebGL) with pan/zoom and live lighting/weather:
  real sun position (day/night), rain, snow and PM2.5 smog from Open-Meteo
- Clickable buildings: OpenStreetMap name/address/use/places-inside, height from the 3D surface,
  straight 3D outline box; OSM footprints that disagree with the 3D are rebuilt from the roof

## Layout

```
app/               Next.js App Router (layout + the single map page)
components/        React UI: LiveMap (canvas + input), ControlPanel, BuildingCard
lib/               framework-free logic: WebGL renderer + shader, building picking/overlay,
                   sun position, Prishtinë time, Open-Meteo weather
public/data/       map layers exported by the pipeline (git-ignored, Google-derived)
pipeline/          the Google-3D pipeline (run everything from this folder)
osm-prototype/     earlier legally-clean renderer that draws a tile from OpenStreetMap alone
```

## Web app

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build; also: npm run lint, npm run typecheck
```

The app reads its layers from `public/data/` (produced by the last pipeline step): `meta.json`,
small JSON files (buildings, roads, buses, traffic profile) and tiles:

- **Imagery pyramids** `tiles/<version>/{day,night,up}/<z>/<x>_<y>.{avif,webp}`: 512 px tiles
  (+2 px gutter copied from neighbours, so filtering shows no seams), each level double the
  previous. Day and night go to 2× the mosaic (Real-ESRGAN); the smooth sky-facing mask is half
  resolution. AVIF where the browser decodes it (~30% smaller), WebP otherwise. Each export gets a
  new version folder, so tiles are served with a one-year immutable cache (`next.config.ts`). The viewer draws only tiles in view, at the level matching the
  zoom, coarse to fine (a coarser tile covers anything still loading), fetches only the layers
  the current conditions need (no night tiles at noon, no wet/snow mask when dry), decodes off the
  main thread and keeps at most 160 tiles on the GPU.
- **Data tiles** `tiles/idmap/` (building ids, for clicks) and `tiles/height/` (heights, for hiding
  cars): lossless PNG, loaded for the viewport or on first use.

Without them the app shows a "No map data found" notice. Shareable links: `#b=way/<osm id>` opens with that building selected.

## Requirements

- Node 20.9+ and Google Chrome (Playwright drives the installed Chrome: `channel: 'chrome'`)
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
| 4 | Even out colour between neighbouring tiles, then stitch the day mosaic with min-cost seams | `python color_match.py tiles_styled tiles_styled_cm && python stitch.py tiles_styled_cm` | `mosaic_styled.png`, `*_seams.json` |
| 5 | Night set generated from the day tiles | `N=3 ./night_all.sh` | `tiles_night/` |
| 6 | Colour-match and stitch night along its own best seams | `python color_match.py tiles_night tiles_night_cm && python stitch.py tiles_night_cm mosaic_night.png -` | `mosaic_night.png` |
| 6b | 2× Real-ESRGAN upscale for the closest zoom (needs `realesrgan-ncnn-vulkan` in `~/tools/realesrgan`) | `python upscale.py mosaic_styled.png mosaic_styled_2x.png` (and night) | `mosaic_*_2x.png` |
| 7 | Sky-facing mask (rain sheen, snow) | `node aux_pass.mjs` then `python stitch.py aux mosaic_up.png mosaic_styled_seams.json "up_{c}_{r}.png"` | `mosaic_up.png` |
| 8 | Height pass (12-bit, 1/16 m) and decode | `node height_pass.mjs && python decode_height.py` | `height_mosaic.npy` |
| 9 | OpenStreetMap buildings/POIs/roads for the area | Overpass query (see below) | `osm_area.json` |
| 10 | Buildings, pass 1 | `NO_OVERRIDES=1 python build_buildings.py` | `buildings.json`, `idmap.png` |
| 11 | Top-down surface + fix footprints that disagree with 3D | `python dsm.py && python refine_footprints.py` | `footprint_overrides.json` |
| 12 | Buildings, pass 2 | `python build_buildings.py` | `buildings.json`, `idmap.png` |
| 13 | Traffic signals / stop / crossing nodes | Overpass query (see below) | `osm_road_nodes.json` |
| 14 | Road graph + half-res height layer for traffic | `python build_roads.py` | `roads.json`, `height.png` |
| 15 | One-time harvest of Google's predicted corridor travel times, every hour of one week (672 billed calls) | `node harvest_traffic.mjs 2026-11-30` | `traffic_harvest.json` |
| 16 | Weekly traffic profile for the simulation | `python build_traffic_profile.py` | `traffic_profile.json` |
| 17 | Bus routes and stops for Prishtinë (Overpass queries in `build_buses.py`) | Overpass | `bus_routes.json`, `bus_stops.json` |
| 18 | Bus lines: routes matched onto the lane graph, stops placed, timetable merged | `python build_buses.py` | `buses.json` |
| 19 | Parked cars as 3D objects (needs a restyle that still drew cars, e.g. the v1 mosaic) | `python build_parking.py mosaic_with_cars.png mosaic_styled.png` | `parked_cars.json` |
| 20 | Export the area's layers, buildings, roads, profile, buses and parked cars | `python export_web.py ../public/data/areas/dardania` | `public/data/areas/dardania/` |
| 21 | One map: the areas + the road between them (see "World map") | `node corridor.mjs` + `python build_worldmap.py` | `public/data/meta.json`, `tiles/` |

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
- `probe_google_traffic.mjs`: billed Google Routes API probe (Prishtinë vs Belgrade); shows whether
  Google has traffic for a corridor (run at rush hour to tell live data from historical patterns)
- `render.mjs` + `index.html` — render a single tile; `viewer.html` — simple pan/zoom image viewer

Overpass query for step 13:

```
[out:json][timeout:60];
node[highway~"^(traffic_signals|stop|give_way|crossing)$"](42.6445,21.1455,42.6605,21.1675);
out body;
```

## World map: Dardania, Marigona and the road between them

The home page (`/`) shows every area in one map. Each area is exported on its own
(`export_web.py ../public/data/areas/<id>`: buildings, roads, traffic, parked cars, landmarks and
the building-id / height data tiles); the world map then merges their imagery with the road
between them into one sparse tile pyramid.

1. `node corridor.mjs <work_dir> <areas.json>` renders **raw Google 3D tiles** (no restyle) in a
   band ±60 m around the driving route between the areas (one Routes API call), in Dardania's
   camera frame, so they line up with it exactly. It also places the other areas in that frame
   (Marigona's mosaic origin is at world px ≈ 12074, 27700). Away from the road the map is blank.
2. `python build_worldmap.py <world.json>` writes `public/data/meta.json` (world size, home view,
   areas with their data folder and offset, and an index of which tiles exist) and the RGBA tile
   pyramid. The illustrated areas win over the raw corridor where they overlap; the corridor has
   no 2× level (the viewer uses its 1× tiles there) and its night is a colour grade of the photo.

3. Optional city background: `node region.mjs <work_dir> <region.json>` renders raw Google 3D
   tiles over a whole lat/lon polygon at a coarser detail (0.8 m/px, 4× coarser than the areas;
   `sse: 8` loads coarser meshes, which looks the same at that scale and is ~2× faster). For
   Prishtinë plus Marigona: a 14.6 × 14.6 km square, 274 cells, ~35 min, one 3D Tiles session.
   Run it with one worker: parallel workers hit Google's per-minute limit (HTTP 429).
   `build_worldmap.py` puts it under everything (`"background": "<work_dir>"`); the viewer falls
   back to the finest level that exists at each spot, so the city stays at its own detail while
   the illustrated areas and the road go finer.

`areas.json` / `world.json` live in the work dir (`.context/world/`); example:

```json
{"corridor": ".context/world",
 "areas": [{"id": "dardania", "name": "Dardania", "dir": "<work dir with mosaic_*.png>", "data": "/data/areas/dardania"},
           {"id": "marigona", "name": "Marigona", "dir": ".context/marigona/world3d", "data": "/data/areas/marigona"}],
 "background": ".context/city",
 "home": ["background"]}
```

In the viewer each area keeps its own pixel frame (`AreaView` offsets it into the world), its own
traffic simulation, buses, parked cars, clickable buildings and landmarks. The panel has buttons to
jump to each area; "Reset view" shows both.

## Simulated traffic

`lib/traffic/` runs a small microsimulation in the browser on the OpenStreetMap road graph:

- **Cars** follow the car ahead with the Intelligent Driver Model, slow for sharp turns, drive on
  the right, and choose turns at random (weighted towards straight on and bigger roads).
- **Traffic lights** at OSM `traffic_signals` nodes run fixed-time two-phase cycles (64 s);
  nearby signal nodes are grouped into one junction. Minor roads give way to bigger ones.
- **Demand** follows a typical Prishtinë week baked once from Google's predicted travel times on
  the two boulevards through the map (Dëshmorët e Kombit, Bill Klinton; both directions, every
  hour of one week; steps 15–16). It sets how many cars there are and how fast drivers want to go:
  weekday peak at 16:00, morning rush at 08:00, quiet nights, Saturday afternoons, Sunday
  evenings. The site never calls Google: the profile ships as a static file. Without it, a
  hand-tuned profile in `lib/traffic/demand.ts` is used. Rain and snow slow drivers further.
  Cars enter at the map edge or pull out of side streets to keep each road near its share.
- **Drawing**: small shaded 3D boxes in the exact map projection, graded like the map (sun,
  rain, smog), with headlights and tail lights at night and brake lights when slowing.
  Buildings and bridge / passage decks in front of a car hide it; tree canopy only dims it
  (`height.png` flags which tall pixels are solid).
- **No popping**: cars only appear or leave where you can't see it happen. They enter off-screen
  or at the map edge (roads are cut exactly at the simulated margin, outside the illustration),
  or pull out of a dead end (driveway / car park). Surplus cars head for the nearest exit and are
  removed once off-screen or after parking in a dead end. A car hidden behind a building or under
  a bridge is never removed there, so it always comes out the other side.

### Buses

`lib/traffic/buses.ts` runs Trafiku Urban lines through the map to their timetables:

- **Routes and stops** come from OpenStreetMap: each line's route relation is matched onto the
  simulation's lanes (shortest lane path between where the route enters and leaves the map,
  penalising distance from the route line), and stops are matched to routes by distance and side
  of the road. Routes whose OSM relation is broken inside the map are skipped.
- **Timetables**: official departures for lines 3, 3B, 4, 1A (and 1) from trafikurban-pr.com,
  transcribed into `pipeline/bus_schedule.json`; lines without a published timetable (2, 3A, 6,
  6A, 7, 7B, 8, 10) use a headway estimated from the municipality's 2024 trips-per-day figures and
  are labelled as estimates. Timetables only list terminus departures, so times at stops assume
  17 km/h running speed plus 18 s per stop.
- **Driving to the schedule**: a bus is a vehicle in the traffic simulation (cars queue behind it,
  it stops at red lights). It picks its speed to reach the next stop at the scheduled time, dwells
  at least 12 s, and holds if it is early. Buses enter and leave at the map edge.
- **Click a bus** for its line, direction, punctuality, next stop and every stop with its time;
  the line's path and stops are highlighted on the map.

### Landmarks

`pipeline/landmarks.json` (committed) lists the notable places in the map area, researched from
Wikipedia (English first, Albanian where there is no English article), Wikidata and OpenStreetMap:
a short summary written for the map and links to the articles. Each is anchored to a clickable
building (its OSM way) or a label point; `export_web.py` resolves the anchors to map positions.
The map shows them as labels; clicking one opens a panel (or adds a "Read more" section to the
building's card). `#l=<id>` links open a landmark directly. Places whose online sources didn't
check out (e.g. a hospital whose Wikipedia coordinates were 1.5 km away) were left out.

### Play a day (timelapse)

"▶ Play a day" runs the clock 24 h in 30 s. Traffic runs 25× faster than real time (eased in and
out, in 0.1 s substeps so car following stays stable), and car numbers follow the fast clock, so
rush hours fill the streets and nights empty them. Buses can't keep exact times at that speed:
the map keeps as many buses as the timetable has on these streets at that hour, entering at the
edge; when playback stops, every bus is put back on its schedule.

**Why simulated, not live:** TomTom, HERE and Azure Maps don't cover Kosovo, and Esri has
historical speeds only (checked Nov 2026). Google Routes API does have traffic patterns for
Prishtinë, which is what the one-time harvest uses. The profile is Google-derived, so like the
tiles it lives in git-ignored `public/data/` and is not committed. `TrafficSim.setDemandOverride()`
remains the hook for a live congestion index.

## Marigona Residence: built from data (now part of the world map)

Google has no 3D buildings for Marigona Residence (Preoc, Graçanica): its 3D tiles there are flat
terrain with an aerial photo (max 4 m of relief over the estate), so the Dardania approach (render
Google's meshes at 45°, restyle) has nothing to render. Instead `/marigona` builds the estate in 3D
(three.js) from data and shows it through the same camera as the Dardania map: orthographic,
heading 45°, pitch −45°, pan and zoom.

| What | From |
|---|---|
| Ground and roof art | straight-down orthophoto rendered from Google's tiles (0.2 m/px) |
| Building footprints | OpenStreetMap |
| Building heights | the photo: shadow length + how far each roof leans away from its footprint, both scaled so a typical villa is 7 m; published floor counts for named buildings the photo can't measure (`KNOWN` in `build_world.py`) |
| Roof shape | hip roof where the photo shows terracotta on a rectangular footprint, else flat |
| Streets, pavements | OSM centre lines and widths (asphalt, centre lines, kerbs) |
| Trees | dark-green canopy blobs found in the photo, with the photo's colour and size |
| Pools, place labels | OSM |
| Terrain | heights sampled from Google's 3D surface |
| Light | real sun position for the chosen time; lit windows, street lamps and car lights at night |

The photo is not a true orthophoto: every roof is drawn shifted away from the camera by an amount
proportional to its height. The builder finds that shift per building (sliding the footprint outline
over the photo's edges along the shared lean direction), takes each roof's art from where the photo
drew it, measures height from it, and fills the ground the photo's roofs covered with ground cloned
from just beyond. Shadows baked into the photo are lifted to match the sunlit ground around them.

Simulated: ~70 cars on the OSM road graph (car following, slowing for turns, one car at a time
through junctions) and ~150 people on footpaths and pavements. Click a building for its data and how
its height was found.

```bash
cd pipeline
node world3d/ortho.mjs 42.5845 21.1100 8 ../.context/marigona/world3d 0.2 8   # ~10 min: 64 photo tiles + terrain grid
../.venv/bin/python world3d/build_world.py ../.context/marigona/world3d ../public/data/world3d/marigona
```

Output (git-ignored, Google-derived): `public/data/world3d/marigona/{world.json, roofs.jpg, ground/*.jpg}`.

**Illustrated tiles (the Dardania look) for a flat area.** The image model can stand flat buildings up
if it is told where they are and how tall: each raw 45° tile (`grid.mjs`) goes to Codex with the
3D scene above rendered through the identical camera as a geometry guide (`world3d/guides.mjs`, needs
the app running), a finished Dardania tile as style reference, and a per-tile data sheet listing every
building's pixel position, type, floors, height and roof (`world3d/tile_brief.py`). Villa heights
are smoothed over each villa's 9 nearest neighbours and snapped to whole floors (two at least: the
per-villa photo measurement is noisy, the estate is two-storey houses). Then stitch as for Dardania.

**Live map with Dardania parity (in the world map on `/`).** The same viewer as Dardania: day/night, rain, snow, smog, clickable buildings, landmarks, simulated
traffic and parked cars, play-a-day, 2× upscaled close zoom. The data-built 3D scene moved to
`/marigona/3d`; the pipeline renders from it. Steps, in the work dir (`.context/marigona/world3d`),
after the restyle above:

| Step | Command (scripts in `pipeline/`, run from the work dir) | Why |
|---|---|---|
| Align each styled tile to the source geometry | `world3d/align_tiles.py tiles_styled tiles_raw tiles_aligned <world.json>` | the model drifts up to ~70 px; anchored on OSM roads and the 3D guide |
| Make neighbours agree in their shared margins | `world3d/seam_align.py tiles_aligned tiles_seamed 3` | roads meet across seams (mean residual 0.2 px) |
| Colour-match + stitch (as Dardania) | `color_match.py tiles_seamed tiles_styled_cm && stitch.py tiles_styled_cm mosaic_styled.png` | |
| Repair seams where two drawings disagree in style | `world3d/seam_repair.py score tiles_styled_cm roads.json 23` then `… run mosaic_styled.png mosaic_styled_fixed.png world3d/seam_prompt.txt` | Codex redraws a 768 px crop across the seam; only the seam band is blended in |
| Night: Codex from the aligned day tiles, then align/seam/colour/stitch/repair the same way | `world3d/night_all.sh <work_dir> tiles_seamed` | |
| 2× Real-ESRGAN for close zoom | `upscale.py mosaic_styled.png mosaic_styled_2x.png` (and night) | |
| Data passes from the 3D scene (sky-facing mask, 12-bit height) | `node world3d/passes.mjs . http://localhost:3000/marigona/3d && python world3d/passes_decode.py` | stand-in for `aux_pass.mjs` + `height_pass.mjs` (Google is flat here) |
| OSM extracts | Overpass, the Dardania queries with the area's bbox | Marigona is outside Prishtinë's boundary: bus routes found by `rel(bw)` on the bbox's roads (none use the estate) |
| Buildings, roads (private estate streets + motorway), sky mask | `build_buildings.py`, `INCLUDE_PRIVATE=1 EXTRA_CLASSES=motorway,motorway_link build_roads.py`, `stitch.py aux mosaic_up.png mosaic_styled_seams.json "up_{c}_{r}.png"` | |
| Parked cars from the orthophoto | `world3d/parked_from_ortho.py <world.json>` | Dardania's detector needs 3D bumps and an older restyle with cars |
| Landmarks, traffic profile, export | `cp world3d/landmarks_marigona.json landmarks.json`, Dardania's `traffic_profile.json`, `export_web.py ../public/data/areas/marigona` | |

```bash
cd pipeline
node grid.mjs 2 42.584306 21.109356                     # raw 45° tiles (move tiles_raw/ into the work dir)
node world3d/guides.mjs ../.context/marigona/world3d http://localhost:3000/marigona/3d
N=3 world3d/style_all.sh ../.context/marigona/world3d ../public/data/world3d/marigona/world.json <style_ref.png>   # ~20 min for 25 tiles
cd ../.context/marigona/world3d && ../../../.venv/bin/python ../../../pipeline/stitch.py tiles_styled mosaic_styled.png
```
Before rendering a new area, check whether Google has building meshes there at all (sample heights
with `sampleHeightMostDetailed`): areas with real meshes suit the illustrated Dardania pipeline instead.

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
- **Day/night.** Only night needs its own generation; dusk, rain, snow and smog are shader
  effects over the two sets. (Cloud cover and a golden-hour grade were tried and removed for now.)
- **No vehicles in the art.** The restyle and night prompts draw no vehicles at all, moving or
  parked: traffic is simulated and parked cars are 3D objects, so everything with wheels keeps the
  same 3D look. Parked cars are found where the city really had them: a cell counts as a car when
  the 3D capture has a low car-height bump there, it's not a building or greenery, and an older
  restyle that still drew cars drew one there (`build_parking.py`). They're drawn into a cached
  layer, so 2,300 of them cost nothing per frame.

## Cost notes

One tile ≈ 205 m × 290 m of ground (0.059 km²). Day + night ≈ 2 images per tile.
Prishtinë ≈ 1,400 images; all of Kosovo at full detail ≈ 367k images — use a coarser countryside
level for national coverage.

## Data credits

OpenStreetMap contributors (ODbL) · Open-Meteo (weather, air quality) · Google Photorealistic 3D
Tiles (private prototype base; not redistributed here) · CesiumJS.
