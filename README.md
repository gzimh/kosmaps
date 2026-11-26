# kosmaps — Marigona, live

Marigona Residence (Preoc, just south of Prishtinë) as a live illustrated miniature, with the real
sun, weather, smog and simulated traffic. It's made to run all day in a digital photo frame:
a little "outside" world that follows the real time and weather in Prishtinë.

Inspired by [Small SF](https://smallsf.com/about): the estate was rendered from 3D data with an
orthographic 45° camera, redrawn tile by tile as an illustration, stitched, and brought to life in
the browser.

> **Status: private prototype.** The base renders come from Google Photorealistic 3D Tiles. This
> repository contains **code only**: no renders, tiles, height data or exported map. Never commit
> `public/data/`.

## What's on the map

- Opens by falling through a layer of clouds (white by day, dusky blue at night) onto the map
- Day and night illustrations, blended by the real sun position; rain, snow and PM2.5 smog from
  Open-Meteo (it keeps following the clock if it's offline)
- Around the illustrated square, its real surroundings (a raw Google render, colour-matched); the
  camera can't zoom or pan past them
- A thin blur layer on top of everything: clear inside an invisible perimeter about 20 m around the
  neighbourhood, then gradually more blurred further out, like a tilt-shift photo. It only blurs
  what's under it; the images and cars underneath are unchanged (`lib/map/perimeterBlur.ts`;
  add `?perimeter` to the URL to see the line)
- Simulated traffic on the OpenStreetMap roads (car following, lights, give way), with demand from a
  one-time Google typical-week harvest; cars fade in and out at the illustration's edge
- Parked cars as small 3D objects, clickable buildings (OpenStreetMap details) and researched
  landmarks with links

## Two pages

| URL      | For                                                                               |
| -------- | --------------------------------------------------------------------------------- |
| `/`      | Interactive: pan, zoom, click buildings, time/weather sliders, play a day           |
| `/frame` | Photo frame: no controls or cursor, slow camera drift, always live, dims at night, keeps the screen awake, reloads daily |

## Run

```bash
npm install
npm run dev        # http://localhost:3000 and /frame
npm run build      # also: npm run lint, npm run typecheck
```

### Photo frame

Any device with a modern browser and WebGL2 works (a Raspberry Pi 5 with a screen, an old iPad).
Serve a production build (`npm run build && npm start`) on the device or the local network and open
`/frame` full screen, e.g. on a Pi: `chromium --kiosk --noerrdialogs http://localhost:3000/frame`.
Tiles are cached by the browser for a year, so after the first load it needs the network only
for the weather.

### Mac app

```bash
macos/build.sh --install   # -> ~/Applications/Marigona.app
```

A small native shell (Swift, AppKit, the system WebKit; a ~120 KB binary) around a static export of
the site (`KOSMAPS_EXPORT=1 next build`). The map files ship inside the app and are served through
a `marigona://` scheme, so it works offline except for the weather. View > Map (Cmd-1) or Photo Frame
(Cmd-2, full screen, keeps the display awake). The `.app` contains the map imagery: don't commit or
share it.

## Layout

```
app/               Next.js App Router: / (interactive) and /frame (photo frame)
components/        LiveMap (canvases, loop, input), ControlPanel, BuildingCard, LandmarkInfo
lib/map/           WebGL tile renderer + shaders (tiles, backdrop), buildings, landmarks
lib/traffic/       road graph, traffic simulation, car drawing, demand profile
lib/               sun position, Prishtinë time, Open-Meteo weather, types
macos/             Marigona.app: native WebKit shell (Marigona.swift), Info.plist, icon, build.sh
pipeline/          export_web.py (map files -> public/data), backdrop.mjs/.py (surroundings), perimeter.py,
                   grid.html (the Google 3D render page) and the curated landmarks.json
public/data/       the exported map (git-ignored, Google-derived)
```

## Data

The app reads `public/data/`, written by `pipeline/export_web.py` from a folder of local map files
(the stitched mosaics, `buildings.json`, `roads.json`, `height.png`, `parked_cars.json`,
`traffic_profile.json`):

```bash
cd <folder with the map files> && python /path/to/pipeline/export_web.py /path/to/public/data
```

- **Imagery** `tiles/<version>/{day,night,up}/<z>/<x>_<y>.{avif,webp}`: 512 px tiles with a 2 px
  gutter, one pyramid per layer, AVIF with a WebP fallback. Each export is a new version, so tiles
  are cached for a year (`next.config.ts`).
- **Data tiles** `tiles/<version>/{idmap,height}/`: building ids for clicks and surface heights for
  hiding cars behind buildings and trees.
- **meta.json** (not cached) names the current version and lists the layers.

The tiles are never regenerated. The generation pipeline (3D rendering, illustration, stitching,
roads, parking, traffic harvest) is in the git history before the Marigona-only rewrite.

### Surroundings and perimeter

```bash
GCP_MAPS_KEY=... node pipeline/backdrop.mjs .context/backdrop   # 9 raw Google renders, ~4 min, one 3D Tiles session
.venv/bin/python pipeline/backdrop.py .context/backdrop         # stitch + colour-match -> public/data
.venv/bin/python pipeline/perimeter.py                          # the perimeter's distance map -> public/data
```

The surroundings cover 2560 mosaic px (512 m) past each side of the illustration at 0.8 m/px.
`perimeter.py` joins the estate's buildings into one shape, pads it by 20 m (second argument) and
writes `perimeter.png`, the distance in metres outside it, which the blur layer turns into masks.
Both add an entry to `meta.json`, and re-running `export_web.py` rewrites `meta.json`, so run them
after it.

## Credits

Base imagery: Google Photorealistic 3D Tiles (Google, Landsat / Copernicus, Airbus). Roads and
buildings: © OpenStreetMap contributors. Weather and air quality: Open-Meteo.
