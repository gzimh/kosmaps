"use client";

import { useEffect, useRef } from "react";
import { lightingFor, smoothstep, sunElevation } from "@/lib/sun";

/**
 * The opening shot: the screen starts as a layer of clouds, then the camera drops through them
 * (they rush outward past it and thin away) while the map below zooms in to the home view.
 *
 * Clouds are flat puffs at different heights under a camera looking straight down, so a simple
 * perspective divide gives the parallax: near ones grow and fly off faster than far ones.
 */

/** How long the descent takes once the map is ready. */
export const INTRO_MS = 3000;
/** The map's zoom at the start of the descent, relative to its home view. */
const MAP_START = 0.72;

// world units: camera height falls from CAM_START to CAM_END; clouds sit between LAYER_LOW and LAYER_HIGH
const CAM_START = 9;
const CAM_END = 1.5;
const LAYER_LOW = 2.5;
const LAYER_HIGH = 6.5;
const CLOUDS = 70;
// Marigona, for the cloud colour before the map's metadata has loaded
const LAT = 42.584, LON = 21.109;

const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** A dive: gets going fast, then settles gently onto the map. */
const ease = (t: number) => 1 - (1 - t) ** 2;
const progress = (start: number | null, now: number) =>
  start === null ? 0 : Math.min(1, Math.max(0, (now - start) / (reducedMotion() ? 600 : INTRO_MS)));

/** Whether the descent has finished. */
export const introOver = (start: number | null, now: number) => start !== null && progress(start, now) >= 1;

/**
 * The map's scale during the intro at `now`, from `home` (its home view's scale), never zooming out
 * past `min`. Returns `home` once it's over.
 */
export function introScale(start: number | null, now: number, home: number, min: number) {
  const from = Math.min(home, Math.max(min, home * MAP_START));
  if (reducedMotion()) return start === null ? from : home;
  return from + (home - from) * ease(progress(start, now));
}

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, k: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k)) as RGB;
const css = ([r, g, b]: RGB, a = 1) => `rgba(${r},${g},${b},${a})`;

/** A puffy cloud: overlapping soft blobs, a shadowed underside and a bright top. */
function cloudSprite(light: RGB, shadow: RGB, seed: number) {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const blobs = Array.from({ length: 10 + Math.floor(rnd() * 6) }, () => {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
    return { x: 128 + Math.cos(a) * r * 62, y: 128 + Math.sin(a) * r * 44, r: 34 + rnd() * 30 };
  });
  const blob = (x: number, y: number, r: number, col: RGB, a: number) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, css(col, a));
    grad.addColorStop(0.55, css(col, a * 0.7));
    grad.addColorStop(1, css(col, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  for (const b of blobs) blob(b.x, b.y + b.r * 0.22, b.r, shadow, 0.8);
  for (const b of blobs) blob(b.x - b.r * 0.08, b.y - b.r * 0.12, b.r * 0.86, light, 0.85);
  return c;
}

interface Cloud { x: number; y: number; z: number; size: number; sprite: number; flip: boolean }

export default function CloudIntro({ start, onDone }: { start: number | null; onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const startRef = useRef(start);
  const doneRef = useRef(onDone);
  useEffect(() => { startRef.current = start; }, [start]);
  useEffect(() => { doneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    const cv = canvas.current!;
    const g = cv.getContext("2d")!;

    // day: white with blue-grey undersides; night: dusky blue-grey
    const night = lightingFor(sunElevation(new Date(), LAT, LON)).nightK;
    const light = mix([255, 255, 255], [96, 102, 128], night);
    const shadow = mix([196, 207, 222], [44, 48, 66], night);
    const haze = mix([238, 242, 247], [62, 66, 86], night);
    const sprites = [1, 2, 3, 4, 5, 6].map((i) => cloudSprite(light, shadow, i * 7919));

    let W = 0, H = 0, diag = 1;
    const resize = () => {
      W = cv.width = window.innerWidth;
      H = cv.height = window.innerHeight;
      diag = Math.hypot(W, H);
    };
    resize();
    window.addEventListener("resize", resize);

    // scatter the clouds over what the camera sees at the start (field half-size = distance)
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const clouds: Cloud[] = Array.from({ length: CLOUDS }, () => {
      const z = LAYER_LOW + rnd() * (LAYER_HIGH - LAYER_LOW);
      const d0 = CAM_START - z;
      return {
        x: (rnd() * 2 - 1) * d0 * 1.05, y: (rnd() * 2 - 1) * d0 * 0.75, z,
        size: d0 * (0.28 + rnd() * 0.22), sprite: Math.floor(rnd() * sprites.length), flip: rnd() < 0.5,
      };
    }).sort((a, b) => a.z - b.z);   // lowest (farthest) first

    const reduced = reducedMotion();
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = progress(startRef.current, now);
      const e = reduced ? 0 : ease(p);
      const cam = CAM_START + (CAM_END - CAM_START) * e;
      const F = diag / 2;
      const drift = (now - t0) / 1000 * 0.05;   // a little wind while it loads

      g.clearRect(0, 0, W, H);
      g.globalAlpha = reduced ? 1 - p : 1;
      // the solid part of the layer, below the puffs: it thins as the camera drops into it
      const hazeA = 1 - smoothstep(0.05, 0.55, e);
      if (hazeA > 0) {
        g.fillStyle = css(haze, hazeA);
        g.fillRect(0, 0, W, H);
      }
      for (const c of clouds) {
        const d = cam - c.z;
        if (d <= 0.05) continue;
        const a = smoothstep(0.1, 1.1, d) * (1 - smoothstep(0.82, 1, e));
        if (a <= 0) continue;
        const k = F / d;
        const r = c.size * k;
        if (r > diag * 4) continue;
        const sx = W / 2 + (c.x + drift) * k, sy = H / 2 + c.y * k;
        if (sx + r < 0 || sx - r > W || sy + r < 0 || sy - r > H) continue;
        g.globalAlpha = a * (reduced ? 1 - p : 1);
        if (c.flip) {
          g.save();
          g.translate(sx, sy);
          g.scale(-1, 1);
          g.drawImage(sprites[c.sprite], -r, -r, r * 2, r * 2);
          g.restore();
        } else {
          g.drawImage(sprites[c.sprite], sx - r, sy - r, r * 2, r * 2);
        }
      }
      g.globalAlpha = 1;

      if (p >= 1) doneRef.current();
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvas}
      aria-hidden
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", zIndex: 50 }}
    />
  );
}
