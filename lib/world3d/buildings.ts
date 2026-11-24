import * as THREE from "three";
import type { Terrain } from "./terrain";
import type { Building, Pt, WorldFile } from "./types";

/**
 * Buildings from data: OSM footprint walls extruded to the height measured from the photo, roofs
 * textured with the building's own roof from the photo (taken from where the photo's lean put it).
 * Hip roofs where the photo shows a terracotta roof on a rectangular footprint.
 */
export interface BuiltBuildings {
  walls: THREE.Mesh;
  roofs: THREE.Mesh;
  /** building index per triangle, for picking */
  wallTri: Uint32Array;
  roofTri: Uint32Array;
  base: Float32Array;
  wallMaterial: THREE.MeshStandardMaterial;
  setNight(k: number): void;
  /** Colour of the sky near the horizon, reflected in the windows. */
  setSky(c: THREE.Color): void;
}

const FLOOR_H = 3.2;

export function buildBuildings(world: WorldFile, terrain: Terrain, roofTex: THREE.Texture): BuiltBuildings {
  const wp: number[] = [], wn: number[] = [], wuv: number[] = [], wc: number[] = [], wa: number[] = [];
  const rp: number[] = [], ruv: number[] = [];
  const wallTri: number[] = [], roofTri: number[] = [];
  const base = new Float32Array(world.buildings.length);
  const AW = world.roofAtlas.px, AH = world.roofAtlas.h;
  const col = new THREE.Color();

  world.buildings.forEach((b, bi) => {
    let g = Infinity;
    for (const [x, y] of b.poly) g = Math.min(g, terrain.heightAt(x, y));
    base[bi] = g;
    const bottom = g - 0.5;
    const top = g + b.h;
    col.setRGB(b.wallColor[0] / 255, b.wallColor[1] / 255, b.wallColor[2] / 255, THREE.SRGBColorSpace);
    const seed = hash(bi);
    const windows = polyArea(b.poly) > 35 && b.kind !== "toilets" ? 1 : 0;

    // walls
    let u = 0;
    const ring = b.poly;
    for (let k = 0; k < ring.length; k++) {
      const [ax, ay] = ring[k];
      const [bx, by] = ring[(k + 1) % ring.length];
      const ex = bx - ax, ey = by - ay;
      const L = Math.hypot(ex, ey);
      if (L < 0.05) continue;
      const nx = ey / L, nz = ex / L; // outward normal (ey, -ex) in xy -> scene (ey, 0, ex)
      const quad: [number, number, number, number, number][] = [
        // x, y(up), z, u, v
        [ax, bottom, -ay, u, bottom - g],
        [bx, bottom, -by, u + L, bottom - g],
        [bx, top, -by, u + L, top - g],
        [ax, top, -ay, u, top - g],
      ];
      for (const idx of [0, 1, 2, 0, 2, 3]) {
        const q = quad[idx];
        wp.push(q[0], q[1], q[2]);
        wn.push(nx, 0, nz);
        wuv.push(q[3], q[4]);
        wc.push(col.r, col.g, col.b);
        wa.push(seed, b.h, windows);
      }
      wallTri.push(bi, bi);
      u += L;
    }

    // roof
    const uvOf = (x: number, y: number): [number, number] => {
      const [ax, ay, aw] = b.atlas;
      const mpp = (b.bbox[2] - b.bbox[0]) / aw;
      const px = ax + (x + b.roofShift[0] - b.bbox[0]) / mpp;
      const py = ay + (b.bbox[3] - (y + b.roofShift[1])) / mpp;
      return [px / AW, 1 - py / AH];
    };
    const pushTri = (a: [number, number, number], c: [number, number, number], d: [number, number, number]) => {
      for (const v of [a, c, d]) {
        rp.push(v[0], v[2], -v[1]);
        const t = uvOf(v[0], v[1]);
        ruv.push(t[0], t[1]);
      }
      roofTri.push(bi);
    };
    if (b.roof === "hip" && b.obb) {
      hipRoof(b, top, pushTri);
    } else {
      const contour = ring.map(([x, y]) => new THREE.Vector2(x, y));
      const faces = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const [i0, i1, i2] of faces) {
        const A = ring[i0], B = ring[i1], C = ring[i2];
        const cross = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
        const a3: [number, number, number] = [A[0], A[1], top];
        const b3: [number, number, number] = [B[0], B[1], top];
        const c3: [number, number, number] = [C[0], C[1], top];
        if (cross >= 0) pushTri(a3, b3, c3);
        else pushTri(a3, c3, b3);
      }
    }
  });

  const wg = new THREE.BufferGeometry();
  wg.setAttribute("position", new THREE.Float32BufferAttribute(wp, 3));
  wg.setAttribute("normal", new THREE.Float32BufferAttribute(wn, 3));
  wg.setAttribute("uv", new THREE.Float32BufferAttribute(wuv, 2));
  wg.setAttribute("color", new THREE.Float32BufferAttribute(wc, 3));
  wg.setAttribute("aWin", new THREE.Float32BufferAttribute(wa, 3));
  wg.computeBoundingSphere();

  const rg = new THREE.BufferGeometry();
  rg.setAttribute("position", new THREE.Float32BufferAttribute(rp, 3));
  rg.setAttribute("uv", new THREE.Float32BufferAttribute(ruv, 2));
  rg.computeVertexNormals();
  rg.computeBoundingSphere();

  const nightU = { value: 0 };
  const skyU = { value: new THREE.Color(0.7, 0.78, 0.86) };
  const wallMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  wallMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = nightU;
    shader.uniforms.uSky = skyU;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 aWin;\nvarying vec3 vWin;\nvarying vec2 vWall;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvWin = aWin;\nvWall = uv;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uNight;
uniform vec3 uSky;
varying vec3 vWin;
varying vec2 vWall;
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float winMask() {
  float v = vWall.y, u = vWall.x;
  float fv = fract((v - 0.15) / ${FLOOR_H.toFixed(1)});
  float fu = fract(u / 3.0);
  float m = step(0.2, fu) * step(fu, 0.8) * step(0.3, fv) * step(fv, 0.84);
  return m * vWin.z * step(0.9, v) * step(v, vWin.y - 0.8);
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
float wm = winMask();
diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.0, 1.6, vWall.y));            // ground contact shade
diffuseColor.rgb *= 1.0 - 0.12 * step(vWin.y - 0.45, vWall.y);                // cornice line
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.12, 0.15), wm * 0.92);   // glass`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, wm);",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
{
  float fr = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.5);
  totalEmissiveRadiance += wm * (0.18 + 0.75 * fr) * uSky * 0.55;
  float lit = step(0.64, hash13(vec3(floor(vWall.x / 3.0), floor((vWall.y - 0.15) / ${FLOOR_H.toFixed(1)}), vWin.x * 97.0)));
  totalEmissiveRadiance += wm * lit * uNight * vec3(1.0, 0.68, 0.36) * 1.5;
}`,
      );
  };
  const walls = new THREE.Mesh(wg, wallMaterial);
  walls.castShadow = true;
  walls.receiveShadow = true;
  walls.name = "walls";

  const roofs = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.9, metalness: 0 }));
  roofs.castShadow = true;
  roofs.receiveShadow = true;
  roofs.name = "roofs";

  return {
    walls,
    roofs,
    wallTri: Uint32Array.from(wallTri),
    roofTri: Uint32Array.from(roofTri),
    base,
    wallMaterial,
    setNight: (k) => { nightU.value = k; },
    setSky: (c) => { skyU.value.copy(c); },
  };
}

function hipRoof(
  b: Building,
  top: number,
  tri: (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => void,
) {
  const o = b.obb!;
  const eave = 0.35;
  const hx = o.hx + eave, hy = o.hy + eave;
  const ux: Pt = [Math.cos(o.a), Math.sin(o.a)];
  const uy: Pt = [-ux[1], ux[0]];
  const P = (sx: number, sy: number, z: number): [number, number, number] => [
    o.c[0] + ux[0] * sx + uy[0] * sy,
    o.c[1] + ux[1] * sx + uy[1] * sy,
    z,
  ];
  const zr = top + b.roofH;
  const z0 = top - 0.15;
  const P0 = P(-hx, -hy, z0), P1 = P(hx, -hy, z0), P2 = P(hx, hy, z0), P3 = P(-hx, hy, z0);
  if (hx >= hy) {
    const r = hx - hy;
    const R0 = P(-r, 0, zr), R1 = P(r, 0, zr);
    tri(P0, P1, R1); tri(P0, R1, R0);
    tri(P1, P2, R1);
    tri(P2, P3, R0); tri(P2, R0, R1);
    tri(P3, P0, R0);
  } else {
    const r = hy - hx;
    const R0 = P(0, -r, zr), R1 = P(0, r, zr);
    tri(P0, P1, R0);
    tri(P1, P2, R1); tri(P1, R1, R0);
    tri(P2, P3, R1);
    tri(P3, P0, R0); tri(P3, R0, R1);
  }
}

export function polyArea(poly: Pt[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function hash(i: number) {
  let x = (i * 2654435761) >>> 0;
  x ^= x >>> 16;
  return (x % 10007) / 10007;
}
