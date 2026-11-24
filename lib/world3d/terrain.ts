import * as THREE from "three";
import type { WorldFile } from "./types";

/** Terrain height lookup (bilinear over the sampled grid), in metres relative to the area's ground. */
export class Terrain {
  private readonly half: number;
  private readonly step: number;
  private readonly n: number;
  private readonly h: Float32Array;

  constructor(world: WorldFile) {
    this.half = world.sizeM / 2;
    this.step = world.terrain.step;
    this.n = world.terrain.n;
    this.h = Float32Array.from(world.terrain.heights);
  }

  heightAt(x: number, y: number): number {
    const n = this.n;
    const c = Math.min(n - 1.001, Math.max(0, (x + this.half) / this.step));
    const r = Math.min(n - 1.001, Math.max(0, (this.half - y) / this.step));
    const c0 = Math.floor(c), r0 = Math.floor(r);
    const fc = c - c0, fr = r - r0;
    const i = r0 * n + c0;
    const a = this.h[i] * (1 - fc) + this.h[i + 1] * fc;
    const b = this.h[i + n] * (1 - fc) + this.h[i + n + 1] * fc;
    return a * (1 - fr) + b * fr;
  }
}

/**
 * Ground: one mesh per photo tile, following the terrain. Every tile starts with the low-resolution
 * overview photo; tiles near the camera swap in their full-resolution photo (and drop it when far).
 */
export class Ground {
  readonly group = new THREE.Group();
  private readonly tiles: {
    mesh: THREE.Mesh;
    mat: THREE.MeshStandardMaterial;
    low: THREE.Texture;
    hi: THREE.Texture | null;
    loading: boolean;
    cx: number;
    cy: number;
    i: number;
    j: number;
  }[] = [];
  private readonly loader = new THREE.TextureLoader();

  constructor(
    private readonly world: WorldFile,
    terrain: Terrain,
    overview: THREE.Texture,
    private readonly baseUrl: string,
    private readonly anisotropy: number,
    grain: THREE.Texture,
  ) {
    const { tiles, tileM } = world.ground;
    const half = world.sizeM / 2;
    const seg = Math.max(4, Math.round(tileM / world.terrain.step));
    for (let j = 0; j < tiles; j++) {
      for (let i = 0; i < tiles; i++) {
        const x0 = -half + i * tileM, y1 = half - j * tileM;
        const geo = new THREE.PlaneGeometry(tileM, tileM, seg, seg);
        geo.rotateX(-Math.PI / 2); // plane now in XZ, +Z = south; uv v=1 at north (top of photo)
        const pos = geo.attributes.position as THREE.BufferAttribute;
        for (let k = 0; k < pos.count; k++) {
          const x = pos.getX(k) + x0 + tileM / 2;
          const z = pos.getZ(k) - y1 + tileM / 2; // z = -y
          pos.setXYZ(k, x, terrain.heightAt(x, -z), z);
        }
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        const low = overview.clone();
        low.repeat.set(1 / tiles, 1 / tiles);
        low.offset.set(i / tiles, 1 - (j + 1) / tiles);
        low.needsUpdate = true;
        const mat = new THREE.MeshStandardMaterial({ map: low, roughness: 0.97, metalness: 0 });
        addGrain(mat, grain);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        mesh.name = "ground";
        this.group.add(mesh);
        this.tiles.push({ mesh, mat, low, hi: null, loading: false, cx: x0 + tileM / 2, cy: y1 - tileM / 2, i, j });
      }
    }
  }

  /**
   * Swap photo resolution by distance from the view centre (x east, y north): load full resolution for
   * tiles within `near` metres, drop it beyond `far`.
   */
  update(x: number, y: number, near: number, far: number) {
    for (const t of this.tiles) {
      const d = Math.hypot(t.cx - x, t.cy - y);
      if (d < near && !t.hi && !t.loading) {
        t.loading = true;
        this.loader.load(`${this.baseUrl}/ground/${t.i}_${t.j}.jpg`, (tex) => {
          t.loading = false;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = this.anisotropy;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          t.hi = tex;
          t.mat.map = tex;
          t.mat.needsUpdate = true;
        }, undefined, () => { t.loading = false; });
      } else if (d > far && t.hi) {
        t.mat.map = t.low;
        t.mat.needsUpdate = true;
        t.hi.dispose();
        t.hi = null;
      }
    }
  }

  get hiResCount() {
    return this.tiles.filter((t) => t.hi).length;
  }

  dispose() {
    for (const t of this.tiles) {
      t.mesh.geometry.dispose();
      t.mat.dispose();
      t.hi?.dispose();
    }
  }
}

/** Close-up detail: modulate a photo-textured surface with fine grain that fades out with distance. */
export function addGrain(mat: THREE.MeshStandardMaterial, grain: THREE.Texture) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGrain = { value: grain };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGW;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uGrain;\nvarying vec3 vGW;")
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
float gd = 1.0 - smoothstep(25.0, 90.0, distance(vGW, cameraPosition));
float gn = texture2D(uGrain, vGW.xz * 0.9).r * 0.55 + texture2D(uGrain, vGW.xz * 0.21).r * 0.45;
diffuseColor.rgb *= mix(1.0, 0.8 + 0.4 * gn, gd);`,
      );
  };
  mat.customProgramCacheKey = () => "grain";
}
