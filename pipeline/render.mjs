// Render one orthographic 45° tile of Google Photorealistic 3D Tiles with CesiumJS in headless Chromium.
// Usage: GCP_MAPS_KEY=... node render.mjs [lat] [lon] [out.png]
// Private experiment: keep Google's on-screen attribution; don't publish or run models over the output.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const keyFile = path.join(dir, '.key');
const key = process.env.GCP_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
if (!key) { console.error('Set GOOGLE_MAPS_API_KEY'); process.exit(1); }
const [lat = '42.6525', lon = '21.1565', out = 'google_tile_isa_boletini.png'] = process.argv.slice(2);

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(fs.readFileSync(path.join(dir, 'index.html')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1600 }, deviceScaleFactor: 1.5 });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/?lat=${lat}&lon=${lon}&key=${encodeURIComponent(key)}`);

let status = '';
for (let i = 0; i < 400; i++) {
  status = await page.evaluate(() => window.status_);
  if (status === 'ready' || status?.startsWith('error')) break;
  await page.waitForTimeout(500);
}
console.log('status:', status, 'groundH:', await page.evaluate(() => window.groundH));
await page.screenshot({ path: path.join(dir, out) });
console.log('saved', path.join(dir, out));
await browser.close();
server.close();
