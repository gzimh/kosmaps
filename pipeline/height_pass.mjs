// Render the 12-bit height pass (4 sub-passes x 3 bits) for every grid tile, pixel-aligned with tiles_raw.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import { chromium } from 'playwright';
const dir = path.dirname(fileURLToPath(import.meta.url));
const g = JSON.parse(fs.readFileSync(path.join(dir, 'tiles_raw/grid.json')));
const n = 2 * g.R + 1, step = g.CORE * g.M_PER_PX;
const server = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html'); r.end(fs.readFileSync(path.join(dir, 'grid.html'))); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const b = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: g.SIZE, height: g.SIZE }, deviceScaleFactor: 1 });
p.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text().replace(/AIza[\w-]+/g, 'AIza***')); });
await p.goto(`http://127.0.0.1:${server.address().port}/`);
const gh = await p.evaluate(o => window.setup(o), { key: process.env.GCP_MAPS_KEY, lat: g.lat, lon: g.lon, widthM: g.SIZE * g.M_PER_PX, heading: 45, pitch: -45, mode: 'hbits' });
console.log('groundH', gh, 'grid groundH', g.groundH);
fs.mkdirSync(path.join(dir, 'aux'), { recursive: true });
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
  await p.evaluate(([dx, dy]) => window.shoot(dx, dy), [(c - g.R) * step, (g.R - r) * step]);
  for (let bit = 0; bit < 4; bit++) {
    await p.evaluate(b => window.setBit(b), bit);
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(dir, `aux/h${bit}_${c}_${r}.png`) });
  }
  console.log('tile', c, r);
}
await b.close(); server.close();
