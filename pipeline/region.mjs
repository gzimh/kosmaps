// Render raw Google 3D tiles over a whole region (a lat/lon polygon) at a coarser detail, in the
// first area's camera frame, so it sits under the illustrated areas as a background.
//
// Usage (from pipeline/): GCP_MAPS_KEY=... node region.mjs <out_dir> <region.json>
//   region.json: {"frame": {"lat", "lon"}, "mpp": 0.8, "polygon": [[lat, lon], ...], "marginCells": 1}
// Output: <out_dir>/cells/cell_<c>_<r>.png (CORE + 2*MARGIN px, like grid.mjs, at `mpp` metres per px)
//         <out_dir>/region.json  {k: world px per tile px (mpp / 0.2), cells: [[c, r]], ...}
//         Cell (c, r) covers world px [c*CORE*k, (c+1)*CORE*k) x [r*CORE*k, ...), where world px are
//         the frame area's mosaic px (0.2 m/px; frame centre at 1536).
// Google cost: one 3D Tiles session per worker (tiles loaded within it are not billed).
// Parallel: WORKER=i WORKERS=n node region.mjs ... renders every n-th cell (start n processes).
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
const WORLD_MPP = 0.2, MPP = cfg.mpp ?? 0.8, K = MPP / WORLD_MPP;
const CORE = 1024, MARGIN = 128, SIZE = CORE + 2 * MARGIN;
const C0 = 1536;
const WORKER = +(process.env.WORKER ?? 0), WORKERS = +(process.env.WORKERS ?? 1);                               // frame area's centre in world px (3x3 grid of 1024)
fs.mkdirSync(path.join(outDir, 'cells'), { recursive: true });

const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(path.join(dir, 'grid.html'))); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text().replace(/AIza[\w-]+/g, 'AIza***')); });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const groundH = await page.evaluate((o) => window.setup(o), { key, lat: cfg.frame.lat, lon: cfg.frame.lon, widthM: SIZE * MPP, heading: 45, pitch: -45, sse: cfg.sse ?? 4 });
console.log(`frame ground ${groundH.toFixed(1)} m; ${MPP} m/px (${K}x coarser than the areas)`);

// the polygon in world px (densified edges, each point at its real ground height)
const poly = cfg.polygon;
const pts = [];
for (let i = 0; i < poly.length; i++) {
  const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
  for (let s = 0; s < 40; s++) pts.push([a[0] + (b[0] - a[0]) * s / 40, a[1] + (b[1] - a[1]) * s / 40]);
}
const hs = await page.evaluate((p) => window.sampleHeights(p), pts);
const ru = await page.evaluate((p) => window.projectRU(p), pts.map(([la, lo], i) => [la, lo, hs[i] ?? groundH]));
const ring = ru.map(([r, u]) => [C0 + r / WORLD_MPP, C0 - u / WORLD_MPP]);
const inside = (x, y) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const span = CORE * K;                         // world px per cell
const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
const cells = [];
const m = cfg.marginCells ?? 1;
for (let r = Math.floor(Math.min(...ys) / span) - m; r <= Math.floor(Math.max(...ys) / span) + m; r++) {
  for (let c = Math.floor(Math.min(...xs) / span) - m; c <= Math.floor(Math.max(...xs) / span) + m; c++) {
    // keep a cell if any of a 5x5 grid of its points lies within the polygon grown by marginCells
    let hit = false;
    for (let a = -m; a <= 4 + m && !hit; a++) for (let b = -m; b <= 4 + m && !hit; b++) hit = inside((c + a / 4) * span, (r + b / 4) * span);
    if (hit) cells.push([c, r]);
  }
}
console.log(`region spans ${((Math.max(...xs) - Math.min(...xs)) * WORLD_MPP / 1000).toFixed(1)} x ${((Math.max(...ys) - Math.min(...ys)) * WORLD_MPP / 1000).toFixed(1)} km of screen; ${cells.length} cells`);
if (WORKER === 0) fs.writeFileSync(path.join(outDir, 'region.json'), JSON.stringify({ CORE, MARGIN, SIZE, mpp: MPP, k: K, frame: { ...cfg.frame, groundH, centrePx: C0 }, polygon: ring.map(([x, y]) => [Math.round(x), Math.round(y)]), cells, done: false }, null, 1));

let n = 0;
const t00 = Date.now();
// ONLY="c,r;c,r" renders just those cells (for tests)
const only = process.env.ONLY ? new Set(process.env.ONLY.split(';')) : null;
const mine = cells.filter(([c, r], i) => (only ? only.has(`${c},${r}`) : i % WORKERS === WORKER));
for (const [c, r] of mine) {
  n++;
  const file = path.join(outDir, 'cells', `cell_${c}_${r}.png`);
  if (fs.existsSync(file)) continue;
  const dx = ((c + 0.5) * span - C0) * WORLD_MPP, dy = -((r + 0.5) * span - C0) * WORLD_MPP;
  const t0 = Date.now();
  const ok = await page.evaluate(([a, b]) => window.shoot(a, b, true), [dx, dy]);
  await page.screenshot({ path: file });
  const eta = ((Date.now() - t00) / n) * (mine.length - n) / 60000;
  console.log(`cell ${c},${r} ${ok ? 'ok' : 'TIMEOUT(partial)'} ${((Date.now() - t0) / 1000).toFixed(1)}s (${n}/${mine.length}, ~${eta.toFixed(0)} min left)`);
}
const all = cells.every(([c, r]) => fs.existsSync(path.join(outDir, 'cells', `cell_${c}_${r}.png`)));
const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'region.json'), 'utf8'));
meta.done = all;
meta.credits = await page.evaluate(() => window.credits());
fs.writeFileSync(path.join(outDir, 'region.json'), JSON.stringify(meta, null, 1));
await browser.close();
server.close();
