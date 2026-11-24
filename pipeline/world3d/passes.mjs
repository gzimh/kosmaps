// Data passes for a flat-3D area, rendered from the data-built 3D scene (the app's /marigona view)
// through exactly each raw tile's camera — the stand-ins for Dardania's aux_pass.mjs + height_pass.mjs,
// which read Google's meshes (flat here).
//   aux/up_<c>_<r>.png       sky-facing mask (1 = roof/ground, 0 = wall), like aux_pass.mjs
//   aux/hq_<c>_<r>.png       surface height relative to the camera's ground target, 12 bits in R (high)
//                            and G (low), q = (h + 64) * 16, 0 = background — decode with passes_decode.py
// Pixels are read straight from a render target (no tone mapping or colour conversion).
// Usage: node world3d/passes.mjs <work_dir> [app_url=http://localhost:3000/marigona/3d]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { PNG } from './png.mjs';

const [work, url = 'http://localhost:3000/marigona/3d'] = process.argv.slice(2);
if (!work) { console.error('usage: node world3d/passes.mjs <work_dir> [app_url]'); process.exit(1); }
const grid = JSON.parse(fs.readFileSync(path.join(work, 'tiles_raw', 'grid.json'), 'utf8'));
const auxDir = path.join(work, 'aux');
fs.mkdirSync(auxDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: grid.SIZE, height: grid.SIZE }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__world && window.__THREE, null, { timeout: 60000 });
await page.evaluate((grid) => {
  const THREE = window.__THREE;
  const w = window.__world;
  w.traffic.group.visible = false;
  w.walkers.group.visible = false;
  w.extras.labels.group.visible = false;
  w.extras.labels.update = () => {};
  w.highlight.visible = false;
  w.passMaterial = new THREE.ShaderMaterial({
    uniforms: { uGround: { value: 0 } },
    vertexShader: `
      #include <common>
      varying vec3 vW;
      void main() {
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        p = modelMatrix * p;
        vW = p.xyz;
        gl_Position = projectionMatrix * viewMatrix * p;
      }`,
    fragmentShader: `
      uniform float uGround;
      varying vec3 vW;
      void main() {
        vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
        float up = abs(n.y);
        float q = clamp(floor((vW.y - uGround + 64.0) * 16.0 + 0.5), 1.0, 4095.0);
        gl_FragColor = vec4(floor(q / 256.0) / 255.0, mod(q, 256.0) / 255.0, up, 1.0);
      }`,
    toneMapped: false,
  });
  w.passTarget = new THREE.WebGLRenderTarget(grid.SIZE, grid.SIZE, { depthBuffer: true });
  w.passTarget.texture.colorSpace = THREE.NoColorSpace;
}, grid);

const N = 2 * grid.R + 1;
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    const b64 = await page.evaluate(([grid, c, r]) => {
      const THREE = window.__THREE;
      const w = window.__world;
      const o = w.world.origin;
      const mLat = 111132.92 - 559.82 * Math.cos((2 * o.lat * Math.PI) / 180);
      const mLon = 111412.84 * Math.cos((o.lat * Math.PI) / 180);
      const step = grid.CORE * grid.M_PER_PX, S = Math.SQRT1_2;
      const sr = (c - grid.R) * step, su = (grid.R - r) * step;
      const x = (grid.lon - o.lon) * mLon + sr * S + su;
      const y = (grid.lat - o.lat) * mLat - sr * S + su;
      // the grid camera aims at the ground at the grid centre: same target height here
      const gx = (grid.lon - o.lon) * mLon, gy = (grid.lat - o.lat) * mLat;
      const ground = w.terrain.heightAt(gx, gy);
      w.lookAt(x, y, grid.SIZE * grid.M_PER_PX);
      w.target.y = ground;
      w.passMaterial.uniforms.uGround.value = ground;
      const cam = w.camera;
      const hw = (grid.SIZE * grid.M_PER_PX) / 2;
      cam.left = -hw; cam.right = hw; cam.top = hw; cam.bottom = -hw;
      cam.position.copy(w.target).addScaledVector(new THREE.Vector3(0.5, -Math.SQRT1_2, -0.5).normalize(), -2500);
      cam.lookAt(w.target);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      const scene = w.scene;
      const bg = scene.background;
      scene.background = null;
      scene.overrideMaterial = w.passMaterial;
      const rr = w.renderer;
      rr.setRenderTarget(w.passTarget);
      rr.setClearColor(0x000000, 0);
      rr.clear();
      rr.render(scene, cam);
      const buf = new Uint8Array(grid.SIZE * grid.SIZE * 4);
      rr.readRenderTargetPixels(w.passTarget, 0, 0, grid.SIZE, grid.SIZE, buf);
      rr.setRenderTarget(null);
      scene.overrideMaterial = null;
      scene.background = bg;
      // flip rows (GL origin is bottom-left) and base64 it
      const S2 = grid.SIZE * 4, out = new Uint8Array(buf.length);
      for (let y = 0; y < grid.SIZE; y++) out.set(buf.subarray((grid.SIZE - 1 - y) * S2, (grid.SIZE - y) * S2), y * S2);
      let s = '';
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
      return btoa(s);
    }, [grid, c, r]);
    const px = Buffer.from(b64, 'base64');
    const S = grid.SIZE;
    const up = Buffer.alloc(S * S), hq = Buffer.alloc(S * S * 3);
    for (let k = 0; k < S * S; k++) {
      const a = px[k * 4 + 3];
      up[k] = a ? px[k * 4 + 2] : 0;
      hq[k * 3] = a ? px[k * 4] : 0;
      hq[k * 3 + 1] = a ? px[k * 4 + 1] : 0;
    }
    fs.writeFileSync(path.join(auxDir, `up_${c}_${r}.png`), PNG.encode(S, S, up, 1));
    fs.writeFileSync(path.join(auxDir, `hq_${c}_${r}.png`), PNG.encode(S, S, hq, 3));
    console.log(`passes ${c}_${r}`);
  }
}
await browser.close();
