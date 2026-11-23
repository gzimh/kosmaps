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

- **Imagery pyramids** `tiles/{day,night,up}/<z>/<x>_<y>.webp`: 512 px tiles (+2 px gutter copied
  from neighbours, so filtering shows no seams), level `maxZ` at full resolution and each level
  below at half the previous. The viewer draws only tiles in view, at the level matching the
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
| 4 | Stitch day mosaic with min-cost seams | `python stitch.py` | `mosaic_styled.png`, `*_seams.json` |
| 5 | Night set generated from the day tiles | `N=3 ./night_all.sh` | `tiles_night/` |
| 6 | Stitch night along the *same* seams | `python stitch.py tiles_night mosaic_night.png mosaic_styled_seams.json` | `mosaic_night.png` |
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
| 19 | Export layers, buildings, roads, profile and buses for the web app | `python export_web.py` | `../public/data/` |

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
- **Empty roads.** The restyle and night prompts tell the model to draw no vehicles on any road
  surface (parked cars in off-street lots may stay), because moving traffic is a live simulated
  layer. The style reference image may still contain cars; the prompt overrides it.

## Cost notes

One tile ≈ 205 m × 290 m of ground (0.059 km²). Day + night ≈ 2 images per tile.
Prishtinë ≈ 1,400 images; all of Kosovo at full detail ≈ 367k images — use a coarser countryside
level for national coverage.

## Data credits

OpenStreetMap contributors (ODbL) · Open-Meteo (weather, air quality) · Google Photorealistic 3D
Tiles (private prototype base; not redistributed here) · CesiumJS.
