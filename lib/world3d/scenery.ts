import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Graph } from "./graph";
import type { Terrain } from "./terrain";
import type { WorldFile } from "./types";

/** Trees found in the photo: canopy size and colour from the photo, instanced. */
export function buildTrees(world: WorldFile, terrain: Terrain) {
  const n = world.trees.length;
  const trunkGeo = new THREE.CylinderGeometry(0.7, 1, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
  // lumpy canopy: jitter the vertices once (shared by every tree; per-tree rotation varies it)
  const p = canopyGeo.attributes.position as THREE.BufferAttribute;
  const jitter = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!jitter.has(k)) jitter.set(k, 0.86 + Math.random() * 0.24);
    const f = jitter.get(k)!;
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f);
  }
  canopyGeo.computeVertexNormals();
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 1 }), n);
  const canopies = new THREE.InstancedMesh(canopyGeo, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), n);
  trunks.castShadow = canopies.castShadow = true;
  canopies.receiveShadow = false; // self-shadowing turns low-poly canopies black
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), s = new THREE.Vector3();
  const col = new THREE.Color(), hsl = { h: 0, s: 0, l: 0 };
  world.trees.forEach(([x, y, r, h, cr, cg, cb], i) => {
    const g = terrain.heightAt(x, y);
    const cv = Math.min(r * 1.05, h * 0.45);
    const trunkH = Math.max(0.8, h - cv * 1.4);
    const tr = 0.09 + 0.035 * r;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 2.399) % (Math.PI * 2));
    m.compose(pos.set(x, g - 0.1, -y), q, s.set(tr, trunkH + 0.1, tr));
    trunks.setMatrixAt(i, m);
    m.compose(pos.set(x, g + h - cv, -y), q, s.set(r, cv, r));
    canopies.setMatrixAt(i, m);
    // the photo sees canopies in sun and shade together; lift them a little so lit trees read as green
    col.setRGB(cr / 255, cg / 255, cb / 255, THREE.SRGBColorSpace);
    col.getHSL(hsl);
    col.setHSL(hsl.h, Math.min(0.75, hsl.s * 1.15), Math.min(0.48, Math.max(0.24, hsl.l * 1.7 + 0.06)), THREE.SRGBColorSpace);
    canopies.setColorAt(i, col);
  });
  const group = new THREE.Group();
  group.add(trunks, canopies);
  return group;
}

/** Swimming pools from OSM, as gently moving water. */
export function buildPools(world: WorldFile, terrain: Terrain) {
  const geos: THREE.BufferGeometry[] = [];
  for (const a of world.areas) {
    if (a.kind !== "pool") continue;
    const shape = new THREE.Shape(a.poly.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2); // (x, y) -> (x, 0, -y)
    const cx = a.poly.reduce((s, p) => s + p[0], 0) / a.poly.length;
    const cy = a.poly.reduce((s, p) => s + p[1], 0) / a.poly.length;
    geo.translate(0, terrain.heightAt(cx, cy) + 0.06, 0);
    geos.push(geo);
  }
  const time = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ color: 0x3fb4d8, roughness: 0.08, metalness: 0.15, transparent: true, opacity: 0.92 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nvarying vec3 vWPos;")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
float w = sin(vWPos.x * 2.3 + uTime * 1.7) * sin(vWPos.z * 2.9 - uTime * 1.3) + sin((vWPos.x + vWPos.z) * 4.1 + uTime * 2.2) * 0.5;
totalEmissiveRadiance += vec3(0.05, 0.16, 0.2) * smoothstep(0.6, 1.4, w);`,
      );
  };
  const mesh = new THREE.Mesh(geos.length ? mergeGeometries(geos)! : new THREE.BufferGeometry(), mat);
  mesh.receiveShadow = true;
  return { mesh, tick: (t: number) => { time.value = t; } };
}

/** Street lamps every ~30 m along the estate's streets, alternating sides. */
export function buildLamps(roads: Graph, terrain: Terrain) {
  const spots: [number, number, number][] = []; // x, y, direction the arm points (towards the road)
  const tmpA = { x: 0, y: 0, h: 0 };
  roads.edges.forEach((e, ei) => {
    if (!["residential", "service", "unclassified", "tertiary", "living_street"].includes(e.kind) || e.length < 12) return;
    const lane = roads.lanes.find((l) => l.edge === ei && l.dir === 1)!;
    const step = 30;
    for (let s = 8, k = ei; s < e.length - 6; s += step, k++) {
      const side = k % 2 ? 1 : -1;
      roads.at({ ...lane, offset: 0 }, s, tmpA);
      const off = (e.width / 2 + 0.9) * side;
      const x = tmpA.x + Math.sin(tmpA.h) * off, y = tmpA.y - Math.cos(tmpA.h) * off;
      if (spots.some(([px, py]) => (px - x) ** 2 + (py - y) ** 2 < 15 * 15)) continue;
      spots.push([x, y, tmpA.h + (side > 0 ? Math.PI / 2 : -Math.PI / 2)]);
    }
  });
  const pole = new THREE.CylinderGeometry(0.06, 0.09, 5.2, 6);
  pole.translate(0, 2.6, 0);
  const arm = new THREE.BoxGeometry(1.1, 0.07, 0.07);
  arm.translate(0.5, 5.15, 0);
  const metal = mergeGeometries([pole, arm])!;
  const head = new THREE.BoxGeometry(0.5, 0.12, 0.26);
  head.translate(1.0, 5.07, 0);
  const n = spots.length;
  const poles = new THREE.InstancedMesh(metal, new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.4 }), n);
  const headMat = new THREE.MeshBasicMaterial({ color: 0x9a9a92 });
  const heads = new THREE.InstancedMesh(head, headMat, n);
  poles.castShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  const bulbs: THREE.Vector3[] = [];
  spots.forEach(([x, y, h], i) => {
    q.setFromAxisAngle(up, h); // model +X (the arm) -> towards the road
    const g = terrain.heightAt(x, y);
    m.compose(new THREE.Vector3(x, g, -y), q, one);
    poles.setMatrixAt(i, m);
    heads.setMatrixAt(i, m);
    const hx = x + Math.cos(h) * 1.0, hy = y + Math.sin(h) * 1.0;
    bulbs.push(new THREE.Vector3(hx, g + 4.9, -hy));
  });
  const group = new THREE.Group();
  group.add(poles, heads);
  return {
    group,
    bulbs,
    setNight: (k: number) => headMat.color.setRGB(0.6 + 3.4 * k, 0.6 + 2.6 * k, 0.57 + 1.5 * k),
  };
}

/** Name labels for OSM places (restaurants, the hotel, the school …), shown when nearby. */
export function buildLabels(world: WorldFile, terrain: Terrain) {
  const group = new THREE.Group();
  const seen = new Set<string>();
  const items: { sprite: THREE.Sprite; x: number; y: number }[] = [];
  for (const p of world.places) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    const font = "600 28px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(p.name).width) + 28;
    c.width = w; c.height = 46;
    ctx.font = font;
    ctx.fillStyle = "rgba(20,22,28,0.72)";
    ctx.beginPath();
    ctx.roundRect(0, 0, w, 46, 12);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(p.name, 14, 24);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    sprite.renderOrder = 10;
    sprite.scale.set((w / 46) * 0.026, 0.026, 1);
    let top = terrain.heightAt(p.x, p.y) + 4;
    for (const b of world.buildings) {
      const [x0, y0, x1, y1] = b.bbox;
      if (p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1) top = Math.max(top, terrain.heightAt(p.x, p.y) + b.h + 2.5);
    }
    sprite.position.set(p.x, top, -p.y);
    group.add(sprite);
    items.push({ sprite, x: p.x, y: p.y });
  }
  return {
    group,
    /** Show labels within range, nearest first, hiding any that would overlap one already shown. */
    update: (x: number, y: number, range: number, camera: THREE.Camera) => {
      const shown: [number, number, number, number][] = [];
      const v = new THREE.Vector3();
      const order = items
        .map((it) => ({ it, d: Math.hypot(it.x - x, it.y - y) }))
        .sort((a, b) => a.d - b.d);
      for (const { it, d } of order) {
        it.sprite.visible = false;
        if (d > range) continue;
        v.copy(it.sprite.position).project(camera);
        if (v.z > 1) continue;
        const w = it.sprite.scale.x, h = it.sprite.scale.y; // in NDC-ish units (sizeAttenuation off)
        const box: [number, number, number, number] = [v.x - w, v.y - h, v.x + w, v.y + h];
        if (shown.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        shown.push(box);
        it.sprite.visible = true;
      }
    },
  };
}
