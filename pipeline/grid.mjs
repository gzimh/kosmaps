// Render an N x N grid of overlapping orthographic Google 3D tiles.
// Usage: node grid.mjs [radius=1] [lat] [lon]
// Each tile: CORE px of unique content + MARGIN px overlap on every side (for seam cutting later).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const key = process.env.GCP_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY;
if (!key) { console.error('Set GCP_MAPS_KEY'); process.exit(1); }
const [radius = '1', lat = '42.6525', lon = '21.1565'] = process.argv.slice(2);
const R = +radius;

const M_PER_PX = 0.2;          // ground resolution along the screen x axis
const CORE = 1024;             // unique pixels per tile
const MARGIN = 128;            // overlap on each side
const SIZE = CORE + 2 * MARGIN;
const outDir = path.join(dir, 'tiles_raw');
fs.mkdirSync(outDir, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(fs.readFileSync(path.join(dir, 'grid.html')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text().replace(/AIza[\w-]+/g, 'AIza***')); });
await page.goto(`http://127.0.0.1:${server.address().port}/`);

const groundH = await page.evaluate((o) => window.setup(o),
  { key, lat: +lat, lon: +lon, widthM: SIZE * M_PER_PX, heading: 45, pitch: -45 });
console.log('ground height', groundH.toFixed(1));

const stepM = CORE * M_PER_PX;
for (let j = R; j >= -R; j--) {          // j: screen up
  for (let i = -R; i <= R; i++) {        // i: screen right
    const t0 = Date.now();
    const ok = await page.evaluate(([dx, dy]) => window.shoot(dx, dy), [i * stepM, j * stepM]);
    const name = `tile_${i + R}_${R - j}.png`; // col_row, row 0 = top
    await page.screenshot({ path: path.join(outDir, name) });
    console.log(name, ok ? 'ok' : 'TIMEOUT(partial)', `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}
fs.writeFileSync(path.join(outDir, 'grid.json'), JSON.stringify({ R, CORE, MARGIN, SIZE, M_PER_PX, lat: +lat, lon: +lon, groundH,
  credits: await page.evaluate(() => window.credits()) }, null, 2));
await browser.close();
server.close();
