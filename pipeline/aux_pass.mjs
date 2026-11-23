// Render the auxiliary "faces up" mask for one grid tile, pixel-aligned with tiles_raw.
// Usage: node aux_pass.mjs <col> <row>
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import { chromium } from 'playwright';
const dir = path.dirname(fileURLToPath(import.meta.url));
const g = JSON.parse(fs.readFileSync(path.join(dir, 'tiles_raw/grid.json')));
const args = process.argv.slice(2);
const cells = args.length ? [[args[0], args[1]]] : [...Array((2 * g.R + 1) ** 2).keys()].map(k => [String(k % (2 * g.R + 1)), String(Math.floor(k / (2 * g.R + 1)))]);
const key = process.env.GCP_MAPS_KEY;
const server = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html'); r.end(fs.readFileSync(path.join(dir, 'grid.html'))); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const b = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: g.SIZE, height: g.SIZE }, deviceScaleFactor: 1 });
p.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text().replace(/AIza[\w-]+/g, 'AIza***')); });
await p.goto(`http://127.0.0.1:${server.address().port}/`);
await p.evaluate(o => window.setup(o), { key, lat: g.lat, lon: g.lon, widthM: g.SIZE * g.M_PER_PX, heading: 45, pitch: -45, mode: 'up' });
const step = g.CORE * g.M_PER_PX;
fs.mkdirSync(path.join(dir, "aux"), { recursive: true });
for (const [col, row] of cells) {
  await p.evaluate(([dx, dy]) => window.shoot(dx, dy), [(+col - g.R) * step, (g.R - +row) * step]);
  await p.screenshot({ path: path.join(dir, `aux/up_${col}_${row}.png`) });
  console.log(`saved aux/up_${col}_${row}.png`);
}
await b.close(); server.close();
