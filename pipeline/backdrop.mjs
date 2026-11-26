// Render raw Google 3D tiles (no illustration) around the map, in the map's own camera frame, as a
// blurred backdrop that fills the screen past the illustrated square. See backdrop.py for the rest.
//
// Usage (from the repo root): GCP_MAPS_KEY=... node pipeline/backdrop.mjs <work_dir> [margin_px=2560] [mpp=0.8]
//   Reads public/data/meta.json (frame centre lat/lon, mosaic size); writes <work_dir>/cells/cell_<c>_<r>.png
//   (CORE + 2*MARGIN px at `mpp` m/px) and <work_dir>/backdrop.json. Cell (c, r) covers mosaic px
//   [c*CORE*k, (c+1)*CORE*k) x [r*CORE*k, ...), k = mpp / 0.2; the mosaic centre is at size / 2.
// Google cost: one 3D Tiles session (tiles loaded within it are not billed separately).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const key = process.env.GCP_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY;
if (!key) { console.error('Set GCP_MAPS_KEY'); process.exit(1); }
const [outDir, marginArg, mppArg] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(dir, '..', 'public', 'data', 'meta.json'), 'utf8'));
const WORLD_MPP = meta.mpp, MPP = +(mppArg ?? 0.8), K = MPP / WORLD_MPP;
const CORE = 1024, MARGIN = 128, SIZE = CORE + 2 * MARGIN;
const C0 = meta.size / 2, M = +(marginArg ?? 2560);
const rect = [-M, -M, meta.size + M, meta.size + M];
fs.mkdirSync(path.join(outDir, 'cells'), { recursive: true });

const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(path.join(dir, 'grid.html'))); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text().replace(/AIza[\w-]+/g, 'AIza***')); });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const groundH = await page.evaluate((o) => window.setup(o), { key, lat: meta.lat, lon: meta.lon, widthM: SIZE * MPP, heading: 45, pitch: -45, sse: 4 });
console.log(`frame ground ${groundH.toFixed(1)} m; ${MPP} m/px (${K}x coarser than the map)`);

const span = CORE * K;
const cells = [];
for (let r = Math.floor(rect[1] / span); r <= Math.floor((rect[3] - 1) / span); r++)
  for (let c = Math.floor(rect[0] / span); c <= Math.floor((rect[2] - 1) / span); c++) cells.push([c, r]);
fs.writeFileSync(path.join(outDir, 'backdrop.json'), JSON.stringify({ CORE, MARGIN, SIZE, mpp: MPP, k: K, rect, cells }, null, 1));
console.log(`${cells.length} cells`);
let n = 0;
for (const [c, r] of cells) {
  n++;
  const file = path.join(outDir, 'cells', `cell_${c}_${r}.png`);
  if (fs.existsSync(file)) continue;
  const dx = ((c + 0.5) * span - C0) * WORLD_MPP, dy = -((r + 0.5) * span - C0) * WORLD_MPP;
  const t0 = Date.now();
  const ok = await page.evaluate(([a, b]) => window.shoot(a, b, true), [dx, dy]);
  await page.screenshot({ path: file });
  console.log(`cell ${c},${r} ${ok ? 'ok' : 'TIMEOUT(partial)'} ${((Date.now() - t0) / 1000).toFixed(1)}s (${n}/${cells.length})`);
}
const info = JSON.parse(fs.readFileSync(path.join(outDir, 'backdrop.json'), 'utf8'));
info.credits = await page.evaluate(() => window.credits());
fs.writeFileSync(path.join(outDir, 'backdrop.json'), JSON.stringify(info, null, 1));
await browser.close();
server.close();
