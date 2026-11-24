// Render the data-built 3D scene (the app's /marigona view) through exactly the camera of each raw
// Google tile from grid.mjs, as a geometry guide for the image model.
// Usage: node world3d/guides.mjs <work_dir with tiles_raw/grid.json> [app_url=http://localhost:3000/marigona/3d]
//   writes <work_dir>/guides/guide_<i>_<j>.png (same size and framing as tiles_raw/tile_<i>_<j>.png)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [work, url = 'http://localhost:3000/marigona/3d'] = process.argv.slice(2);
if (!work) { console.error('usage: node world3d/guides.mjs <work_dir> [app_url]'); process.exit(1); }
const grid = JSON.parse(fs.readFileSync(path.join(work, 'tiles_raw', 'grid.json'), 'utf8'));
const outDir = path.join(work, 'guides');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: grid.SIZE, height: grid.SIZE }, deviceScaleFactor: 1 });
await page.goto(url);
await page.waitForFunction(() => window.__world, null, { timeout: 60000 });
await page.addStyleTag({ content: 'div[class*=panel],div[class*=credits],div[class*=card],nextjs-portal{display:none!important}' });
await page.evaluate(() => {
  const w = window.__world;
  w.setTime(12 * 60);
  w.traffic.group.visible = false;
  w.walkers.group.visible = false;
  w.extras.labels.group.visible = false;
  w.extras.labels.update = () => {};
});
const N = 2 * grid.R + 1;
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    await page.evaluate(([grid, i, j]) => {
      const w = window.__world;
      const o = w.world.origin;
      const mLat = 111132.92 - 559.82 * Math.cos((2 * o.lat * Math.PI) / 180);
      const mLon = 111412.84 * Math.cos((o.lat * Math.PI) / 180);
      const step = grid.CORE * grid.M_PER_PX, S = Math.SQRT1_2;
      const sr = (i - grid.R) * step, su = (grid.R - j) * step; // screen metres right / up
      const x = (grid.lon - o.lon) * mLon + sr * S + su;          // screen right = SE, screen up = NE/sin45
      const y = (grid.lat - o.lat) * mLat - sr * S + su;
      w.lookAt(x, y, grid.SIZE * grid.M_PER_PX);
      w.slowTimer = 0;
    }, [grid, i, j]);
    await page.waitForTimeout(3500);
    await page.locator('canvas').screenshot({ path: path.join(outDir, `guide_${i}_${j}.png`) });
    console.log(`guide_${i}_${j}.png`);
  }
}
await browser.close();
