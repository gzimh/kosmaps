import type { FrameUniforms } from "./renderer";

type RGB = [number, number, number];

const luma = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sat = (c: RGB, k: number): RGB => { const l = luma(c); return mix([l, l, l], c, k); };
const contrast = (c: RGB, k: number, mul: RGB, gain = 1): RGB =>
  [((c[0] - 0.5) * k + 0.5) * mul[0] * gain, ((c[1] - 0.5) * k + 0.5) * mul[1] * gain, ((c[2] - 0.5) * k + 0.5) * mul[2] * gain];
const clamp = (c: RGB): RGB => [Math.min(1, Math.max(0, c[0])), Math.min(1, Math.max(0, c[1])), Math.min(1, Math.max(0, c[2]))];

/**
 * CPU version of the colour grade in shaders.ts (without the noise terms), so things drawn on the
 * 2D overlay (cars) match the lighting and weather of the WebGL map underneath.
 * `far` is 0 at the bottom of the mosaic (near the camera) and 1 at the top.
 */
export function gradeColor(rgb: RGB, f: FrameUniforms, far = 0.5): RGB {
  // 1. night (the map blends to a baked night layer; approximate it as dark blue)
  let col = mix(rgb, [rgb[0] * 0.3, rgb[1] * 0.33, rgb[2] * 0.5], f.nightK);
  // 2. rain
  col = mix(col, contrast(sat(col, 0.5), 0.8, [0.82, 0.86, 0.94], 0.82), f.rain);
  // 3. snow (overall cooling; cars aren't snow-covered)
  col = mix(col, contrast(sat(col, 0.6), 0.9, [0.88, 0.92, 1]), f.snow * 0.6);
  // 4. smog haze
  const haze: RGB = mix([0.78, 0.74, 0.66], [0.26, 0.21, 0.18], f.nightK);
  const k = f.smog * (0.62 + 0.38 * far) * (1 - 0.45 * f.nightK);
  col = mix(sat(col, 1 - 0.3 * f.smog), haze, Math.min(0.6, Math.max(0, k)));
  return clamp(col);
}
