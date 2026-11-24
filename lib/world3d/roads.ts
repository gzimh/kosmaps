import * as THREE from "three";
import type { Graph } from "./graph";
import type { Terrain } from "./terrain";
import type { Pt } from "./types";

/**
 * Streets as geometry, from the OSM centre lines and widths: asphalt ribbons with a dashed centre
 * line on two-way streets, and raised pavements with kerbs along the estate's residential streets.
 * Drawn over the photo so the edges the driver looks at are crisp.
 */
export function buildRoads(g: Graph, terrain: Terrain, grain: THREE.Texture) {
  const ap: number[] = [], auv: number[] = [], am: number[] = [];
  const pp: number[] = [], pn: number[] = [], puv: number[] = [];
  const isJunction = (n: number) => g.nodes[n].degree >= 3;

  for (const e of g.edges) {
    const pts = e.pts;
    if (pts.length < 2) continue;
    const hw = e.width / 2;
    const marked = !e.oneway && e.width >= 5.5 && e.kind !== "service" ? 1 : 0;
    const lift = e.kind === "service" ? 0.035 : 0.05;
    ribbon(pts, -hw, hw, (l, r, u0, u1) => {
      // asphalt quad between consecutive cross-sections
      const ends = [Math.min(u0, e.length - u0), Math.min(u1, e.length - u1)];
      const q = [
        [l[0][0], l[0][1], u0, 0, ends[0]], [r[0][0], r[0][1], u0, 1, ends[0]],
        [r[1][0], r[1][1], u1, 1, ends[1]], [l[1][0], l[1][1], u1, 0, ends[1]],
      ];
      for (const k of [0, 1, 2, 0, 2, 3]) { // l0 r0 r1 l1 is counter-clockwise seen from above
        const [x, y, u, v, d] = q[k];
        ap.push(x, terrain.heightAt(x, y) + lift, -y);
        auv.push(u, v);
        am.push(marked, d);
      }
    });

    if (e.kind !== "residential" && e.kind !== "unclassified" && e.kind !== "tertiary") continue;
    // pavements, trimmed back from junctions so they don't run across the crossing street
    const trimA = isJunction(e.from) ? 7 : 0, trimB = isJunction(e.to) ? 7 : 0;
    const sub = trimLine(pts, trimA, trimB);
    if (!sub) continue;
    const W = 1.7, KERB = 0.13;
    for (const side of [-1, 1]) {
      const inner = side * hw, outer = side * (hw + W);
      ribbon(sub, Math.min(inner, outer), Math.max(inner, outer), (l, r, u0, u1) => {
        const quadTop = [[l[0], u0], [r[0], u0], [r[1], u1], [l[1], u1]] as const;
        for (const k of [0, 1, 2, 0, 2, 3]) {
          const [[x, y], u] = quadTop[k];
          pp.push(x, terrain.heightAt(x, y) + KERB, -y);
          pn.push(0, 1, 0);
          puv.push(u * 0.5, (k === 1 || k === 2 ? 1 : 0) * 0.85);
        }
        // kerb face, facing the street: right of travel for the left pavement, left for the right one
        const a = side < 0 ? r : l;
        const dx = a[1][0] - a[0][0], dy = a[1][1] - a[0][1], L = Math.hypot(dx, dy) || 1;
        const nx = (side < 0 ? dy : -dy) / L, ny = (side < 0 ? -dx : dx) / L;
        const h0 = terrain.heightAt(a[0][0], a[0][1]), h1 = terrain.heightAt(a[1][0], a[1][1]);
        const face = [
          [a[0][0], h0 + 0.02, a[0][1]], [a[1][0], h1 + 0.02, a[1][1]],
          [a[1][0], h1 + KERB, a[1][1]], [a[0][0], h0 + KERB, a[0][1]],
        ];
        for (const k of side < 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
          const [x, h, y] = face[k];
          pp.push(x, h, -y);
          pn.push(nx, 0, -ny);
          puv.push(0.95, 0.95);
        }
      });
    }
  }

  const ag = new THREE.BufferGeometry();
  ag.setAttribute("position", new THREE.Float32BufferAttribute(ap, 3));
  ag.setAttribute("uv", new THREE.Float32BufferAttribute(auv, 2));
  ag.setAttribute("aMark", new THREE.Float32BufferAttribute(am, 2));
  ag.computeVertexNormals();
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x5d5f63, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  asphalt.onBeforeCompile = (sh) => {
    sh.uniforms.uGrain = { value: grain };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aMark;\nvarying vec2 vMark;\nvarying vec2 vRoadUv;\nvarying vec3 vRW;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvMark = aMark;\nvRoadUv = uv;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvRW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uGrain;\nvarying vec2 vMark;\nvarying vec2 vRoadUv;\nvarying vec3 vRW;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
float gr = texture2D(uGrain, vRW.xz * 0.35).r * 0.6 + texture2D(uGrain, vRW.xz * 0.05).r * 0.4;
diffuseColor.rgb *= 0.82 + 0.36 * gr;
float edge = smoothstep(0.0, 0.05, vRoadUv.y) * smoothstep(1.0, 0.95, vRoadUv.y);
diffuseColor.rgb *= mix(0.8, 1.0, edge);
float centre = vMark.x * step(9.0, vMark.y) * step(abs(vRoadUv.y - 0.5) * 2.0, 0.035) * step(0.45, fract(vRoadUv.x / 6.0));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.86, 0.82), centre * 0.9);`,
      );
  };
  const roads = new THREE.Mesh(ag, asphalt);
  roads.receiveShadow = true;

  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3));
  pg.setAttribute("normal", new THREE.Float32BufferAttribute(pn, 3));
  pg.setAttribute("uv", new THREE.Float32BufferAttribute(puv, 2));
  const paveMat = new THREE.MeshStandardMaterial({ color: 0xa9a49a, roughness: 0.95 });
  paveMat.onBeforeCompile = (sh) => {
    sh.uniforms.uGrain = { value: grain };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vPW;\nvarying vec2 vPUv;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvPUv = uv;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvPW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uGrain;\nvarying vec3 vPW;\nvarying vec2 vPUv;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec2 tile = fract(vPW.xz / 0.6);
float joint = 1.0 - (1.0 - smoothstep(0.0, 0.04, tile.x) * smoothstep(1.0, 0.96, tile.x)) * 0.35
                  - (1.0 - smoothstep(0.0, 0.04, tile.y) * smoothstep(1.0, 0.96, tile.y)) * 0.35;
diffuseColor.rgb *= mix(1.0, max(joint, 0.55), step(vPUv.y, 0.86)) * (0.9 + 0.2 * texture2D(uGrain, vPW.xz * 0.4).r);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.77, 0.74), step(0.88, vPUv.y));`,
      );
  };
  const pavements = new THREE.Mesh(pg, paveMat);
  pavements.receiveShadow = true;
  pavements.castShadow = false;

  const group = new THREE.Group();
  group.add(roads, pavements);
  return group;
}

/**
 * Walk a polyline and emit quads of a band from offset `a` to offset `b` (metres, + = right of travel),
 * with mitred joints. cb(leftPair, rightPair, u0, u1) where each pair is [start, end] points.
 */
function ribbon(pts: Pt[], a: number, b: number, cb: (l: [Pt, Pt], r: [Pt, Pt], u0: number, u1: number) => void) {
  const n = pts.length;
  const off = (i: number, d: number): Pt => {
    const p = pts[i];
    const dir = (j: number) => {
      const q0 = pts[j], q1 = pts[j + 1];
      const L = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
      return [(q1[0] - q0[0]) / L, (q1[1] - q0[1]) / L];
    };
    const d0 = i > 0 ? dir(i - 1) : dir(0);
    const d1 = i < n - 1 ? dir(i) : dir(n - 2);
    let tx = d0[0] + d1[0], ty = d0[1] + d1[1];
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) { tx = d1[0]; ty = d1[1]; } else { tx /= tl; ty /= tl; }
    const nx = ty, ny = -tx; // right normal of the averaged direction
    const cosHalf = Math.max(0.35, nx * d1[1] + ny * -d1[0]);
    return [p[0] + (nx * d) / cosHalf, p[1] + (ny * d) / cosHalf];
  };
  let u = 0;
  for (let i = 0; i < n - 1; i++) {
    const segL = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    cb([off(i, a), off(i + 1, a)], [off(i, b), off(i + 1, b)], u, u + segL);
    u += segL;
  }
}

/** The part of a polyline from distance `a` from its start to distance `b` from its end. */
function trimLine(pts: Pt[], a: number, b: number): Pt[] | null {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  if (L - a - b < 3) return null;
  const at = (d: number): Pt => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  const out: Pt[] = [at(a)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > a && cum[i] < L - b) out.push(pts[i]);
  out.push(at(L - b));
  return out;
}

/** Tileable grain texture (value noise), for close-up detail on photo-based surfaces. */
export function grainTexture() {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const rnd = (x: number, y: number) => {
    const s = Math.sin(((x % N) * 127.1 + (y % N) * 311.7)) * 43758.5453;
    return s - Math.floor(s);
  };
  const smooth = (x: number, y: number, f: number) => {
    const xi = Math.floor(x / f), yi = Math.floor(y / f);
    const tx = x / f - xi, ty = y / f - yi;
    const m = N / f;
    const v = (i: number, j: number) => rnd(((i % m) + m) % m * 7, ((j % m) + m) % m * 13);
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (v(xi, yi) * (1 - sx) + v(xi + 1, yi) * sx) * (1 - sy) + (v(xi, yi + 1) * (1 - sx) + v(xi + 1, yi + 1) * sx) * sy;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = 0.45 * rnd(x, y) + 0.3 * smooth(x, y, 4) + 0.25 * smooth(x, y, 16);
      const i = (y * N + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(v * 255);
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
