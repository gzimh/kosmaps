// Render raw Google 3D tiles along the road between two areas, in the FIRST area's camera frame,
// so they line up with it pixel for pixel. Also places the other areas in that frame.
//
// Usage (from pipeline/): GCP_MAPS_KEY=... node corridor.mjs <out_dir> <areas.json>
//   areas.json: {"frame": {"lat":..,"lon":..}, "areas": [{"id","lat","lon","groundH","size"}],
//                "route": {"from":[lat,lon], "to":[lat,lon]}, "bufferM": 60}
// Output: <out_dir>/cells/cell_<c>_<r>.png (raw tiles, CORE + MARGIN like grid.mjs; c, r = world
//         cell index, cell (0,0) is the frame mosaic's top-left core cell for radius 1)
//         <out_dir>/corridor.json (route in world px, cell list, area placements)
// One Routes API call (the road), plus Map Tiles requests for the rendered cells.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const key = process.env.GCP_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY;
if (!key) { console.error('Set GCP_MAPS_KEY'); process.exit(1); }
const [outDir, cfgPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const M_PER_PX = 0.2, CORE = 1024, MARGIN = 128, SIZE = CORE + 2 * MARGIN;
const R0 = 1;                                  // the frame area's grid radius (3x3: centre px 1536)
const C0 = (2 * R0 + 1) * CORE / 2;
fs.mkdirSync(path.join(outDir, 'cells'), { recursive: true });

// ---- the road (one Routes API call)
function decode(str) { let i = 0, la = 0, lo = 0; const out = []; while (i < str.length) { for (const k of [0, 1]) { let b, s = 0, r = 0; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32); const d = r & 1 ? ~(r >> 1) : r >> 1; if (k === 0) la += d; else lo += d; } out.push([la / 1e5, lo / 1e5]); } return out; }
let routeLL;
const cached = path.join(outDir, 'route.json');
if (fs.existsSync(cached)) routeLL = JSON.parse(fs.readFileSync(cached, 'utf8'));
else {
  const wp = ([la, lo]) => ({ location: { latLng: { latitude: la, longitude: lo } } });
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.polyline.encodedPolyline,routes.description' },
    body: JSON.stringify({ origin: wp(cfg.route.from), destination: wp(cfg.route.to), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', polylineQuality: 'HIGH_QUALITY' }),
  });
  const j = await r.json();
  if (!j.routes?.[0]) { console.error('route failed', JSON.stringify(j).slice(0, 300)); process.exit(1); }
  routeLL = decode(j.routes[0].polyline.encodedPolyline);
  console.log(`route: ${(j.routes[0].distanceMeters / 1000).toFixed(1)} km via ${j.routes[0].description || '?'}`);
  fs.writeFileSync(cached, JSON.stringify(routeLL));
}
// densify to ~10 m so the cell sweep doesn't skip corners
const dense = [];
for (let k = 0; k + 1 < routeLL.length; k++) {
  const [a, b] = [routeLL[k], routeLL[k + 1]];
  const d = Math.hypot((b[0] - a[0]) * 111000, (b[1] - a[1]) * 82000);
  const n = Math.max(1, Math.ceil(d / 10));
  for (let s = 0; s < n; s++) dense.push([a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n]);
}
dense.push(routeLL[routeLL.length - 1]);

// ---- browser with the frame camera
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(path.join(dir, 'grid.html'))); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text().replace(/AIza[\w-]+/g, 'AIza***')); });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const groundH = await page.evaluate((o) => window.setup(o), { key, lat: cfg.frame.lat, lon: cfg.frame.lon, widthM: SIZE * M_PER_PX, heading: 45, pitch: -45 });
console.log('frame ground', groundH.toFixed(2));
const toPx = ([r, u]) => [C0 + r / M_PER_PX, C0 - u / M_PER_PX];

// road heights from the 3D tiles, in chunks (falls back to the previous height)
const heights = [];
for (let k = 0; k < dense.length; k += 200) {
  const hs = await page.evaluate((p) => window.sampleHeights(p), dense.slice(k, k + 200));
  for (const h of hs) heights.push(h ?? heights[heights.length - 1] ?? groundH);
}
const routePx = (await page.evaluate((p) => window.projectRU(p), dense.map(([la, lo], i) => [la, lo, heights[i]]))).map(toPx);

// areas: their mosaic centre in this frame
const areas = [];
for (const a of cfg.areas) {
  const [[r, u]] = await page.evaluate((p) => window.projectRU(p), [[a.lat, a.lon, a.groundH]]);
  const [cx, cy] = toPx([r, u]);
  areas.push({ ...a, offset: [Math.round((cx - a.size / 2) * 100) / 100, Math.round((cy - a.size / 2) * 100) / 100] });
  console.log(`area ${a.id}: mosaic origin at world px ${areas.at(-1).offset.map((v) => v.toFixed(1))}`);
}

// cells along the road (buffer in px), minus cells fully inside an area's mosaic
const buf = (cfg.bufferM ?? 60) / M_PER_PX;
const cells = new Map();
for (const [x, y] of routePx) {
  for (const dx of [-buf, 0, buf]) for (const dy of [-buf, 0, buf]) {
    const c = Math.floor((x + dx) / CORE), r = Math.floor((y + dy) / CORE);
    cells.set(`${c}_${r}`, [c, r]);
  }
}
const inside = (c, r) => areas.some((a) => c * CORE >= a.offset[0] && (c + 1) * CORE <= a.offset[0] + a.size && r * CORE >= a.offset[1] && (r + 1) * CORE <= a.offset[1] + a.size);
const todo = [...cells.values()].filter(([c, r]) => !inside(c, r)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
console.log(`${todo.length} corridor cells to render`);

let n = 0;
for (const [c, r] of todo) {
  const file = path.join(outDir, 'cells', `cell_${c}_${r}.png`);
  if (fs.existsSync(file)) continue;
  const dx = ((c + 0.5) * CORE - C0) * M_PER_PX, dy = -((r + 0.5) * CORE - C0) * M_PER_PX;
  const t0 = Date.now();
  const ok = await page.evaluate(([a, b]) => window.shoot(a, b, true), [dx, dy]);
  await page.screenshot({ path: file });
  console.log(`cell ${c},${r} ${ok ? 'ok' : 'TIMEOUT(partial)'} ${((Date.now() - t0) / 1000).toFixed(1)}s (${++n}/${todo.length})`);
}
fs.writeFileSync(path.join(outDir, 'corridor.json'), JSON.stringify({
  CORE, MARGIN, SIZE, M_PER_PX, frame: { ...cfg.frame, groundH, centrePx: C0 }, areas, cells: todo,
  route: routePx.map(([x, y]) => [Math.round(x), Math.round(y)]),
  credits: await page.evaluate(() => window.credits()),
}, null, 1));
await browser.close();
server.close();
