// Straight-down orthophoto + terrain heights of an area from Google Photorealistic 3D Tiles.
// For areas where Google has no building meshes (flat terrain + aerial photo, e.g. Marigona) the
// render is a clean orthophoto; the game uses it as ground and roof art.
//
// Usage: GCP_MAPS_KEY=... node world3d/ortho.mjs <lat> <lon> <tiles> <out_dir> [m_per_px=0.2] [dem_step_m=8]
//   renders tiles x tiles cores of 1024 px around (lat, lon), north up, plus a DEM grid.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const key = process.env.GCP_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY;
if (!key) { console.error('Set GCP_MAPS_KEY'); process.exit(1); }
const [latS, lonS, nS, outDir, mppS = '0.2', demS = '8'] = process.argv.slice(2);
if (!outDir) { console.error('usage: node world3d/ortho.mjs <lat> <lon> <tiles> <out_dir> [m_per_px] [dem_step_m]'); process.exit(1); }
const lat = +latS, lon = +lonS, N = +nS, M_PER_PX = +mppS, DEM_STEP = +demS;
const CORE = 1024, MARGIN = 32, SIZE = CORE + 2 * MARGIN;
const tileDir = path.join(outDir, 'ortho_raw');
fs.mkdirSync(tileDir, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(fs.readFileSync(path.join(dir, '..', 'grid.html')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text().replace(/AIza[\w-]+/g, 'AIza***')); });
await page.goto(`http://127.0.0.1:${server.address().port}/`);

const groundH = await page.evaluate((o) => window.setup(o),
  { key, lat, lon, widthM: SIZE * M_PER_PX, heading: 0, pitch: -90 });
console.log('ground height', groundH.toFixed(1));

// Tile (i, j): i = column (west→east), j = row (north→south); centre offsets in metres.
const stepM = CORE * M_PER_PX;
const half = (N - 1) / 2;
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const ok = await page.evaluate(([dx, dy]) => window.shoot(dx, dy), [(i - half) * stepM, (half - j) * stepM]);
    const name = `o_${i}_${j}.png`;
    await page.screenshot({ path: path.join(tileDir, name), clip: { x: MARGIN, y: MARGIN, width: CORE, height: CORE } });
    console.log(name, ok ? 'ok' : 'TIMEOUT(partial)', `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

// Terrain: height grid over the same square, DEM_STEP metres apart, row 0 = north.
const sizeM = N * stepM;
const nD = Math.round(sizeM / DEM_STEP) + 1;
const mLat = 111132.92 - 559.82 * Math.cos(2 * lat * Math.PI / 180);
const mLon = 111412.84 * Math.cos(lat * Math.PI / 180);
const heights = [];
for (let r = 0; r < nD; r++) {
  const pts = [];
  for (let c = 0; c < nD; c++) {
    const e = -sizeM / 2 + c * DEM_STEP, n = sizeM / 2 - r * DEM_STEP;
    pts.push([lat + n / mLat, lon + e / mLon]);
  }
  const row = await page.evaluate((p) => window.sampleHeights(p), pts);
  heights.push(row.map((h) => (h == null ? null : +(h - groundH).toFixed(2))));
}
console.log('dem', nD, 'x', nD);

fs.writeFileSync(path.join(outDir, 'ortho.json'), JSON.stringify({
  lat, lon, tiles: N, core: CORE, mPerPx: M_PER_PX, sizeM, groundH, mLat, mLon,
  dem: { step: DEM_STEP, n: nD, heights },
  credits: await page.evaluate(() => window.credits()),
}));
await browser.close();
server.close();
