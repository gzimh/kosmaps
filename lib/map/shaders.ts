/** A unit quad stretched over one tile's rectangle (canvas px). */
export const VERTEX_SHADER = `#version 300 es
in vec2 p;
uniform vec4 uRect;    // x0, y0, x1, y1 in canvas px (y down)
uniform vec2 uRes;
void main(){
  vec2 c = mix(uRect.xy, uRect.zw, p);
  gl_Position = vec4(c.x / uRes.x * 2. - 1., 1. - c.y / uRes.y * 2., 0., 1.);
}`;

/**
 * Composites the baked day + night illustration with live lighting and weather, one tile at a time.
 * uUp is the sky-facing mask (1 = roof/ground, 0 = wall) rendered from the 3D tiles. Effects are
 * computed in mosaic-pixel coordinates, so they run seamlessly across tiles and zoom levels.
 */
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uDay, uNight, uUp;
uniform vec2 uTileOrigin; // mosaic px at the tile's top-left content pixel
uniform float uTileF;     // mosaic px per tile px at this level
uniform vec2 uTexSize;    // texture size in px, gutter included
uniform float uGutter;
uniform vec2 uUpOrigin;   // the sky-facing mask has its own (coarser) pyramid
uniform float uUpF;
uniform vec2 uUpTexSize;
uniform vec2 uRes;       // canvas px
uniform vec2 uOff;       // image px at canvas origin
uniform float uScale;    // canvas px per image px
uniform float uNightK, uRain, uSnow, uSmog, uTime;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){ float a=.5, s=0.; for(int k=0;k<4;k++){ s+=a*vnoise(p); p*=2.03; a*=.5; } return s; }
float luma(vec3 c){ return dot(c, vec3(.299,.587,.114)); }
vec3 sat(vec3 c, float k){ float l = luma(c); return mix(vec3(l), c, k); }

void main(){
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 ip = uOff + frag / uScale;                // image pixel
  vec2 tuv = (uGutter + (ip - uTileOrigin) / uTileF) / uTexSize;
  vec4 day4 = texture(uDay, tuv);
  // the map's edges are hard cuts, but lossy (AVIF) alpha and filtering soften them into a fringe:
  // threshold it back to a clean edge
  day4.a = smoothstep(0.42, 0.58, day4.a);
  if (day4.a < 0.004) discard;                   // blank (no map here): show what's underneath
  vec3 day = day4.rgb;
  vec3 night = texture(uNight, tuv).rgb;
  float up = texture(uUp, (uGutter + (ip - uUpOrigin) / uUpF) / uUpTexSize).r;
  float far = 1. - frag.y / uRes.y;              // top of the screen is farther from the camera

  // 1. sun: blend from the day layer to the baked night layer
  vec3 col = mix(day, night, uNightK);

  // 2. rain: darker and cooler, wet sheen on sky-facing surfaces, animated streaks
  vec3 wet = ((sat(col, .5) - .5) * .8 + .5) * vec3(.82,.86,.94) * .82;
  col = mix(col, wet, uRain);
  float sheen = step(.85, up) * vnoise(ip / 6.) * .10;
  col += uRain * sheen * mix(vec3(1.), vec3(1.,.8,.5), uNightK);
  vec2 rp = frag * vec2(1., .12) + vec2(frag.y * .23, uTime * 260.);
  vec2 cell = floor(rp / vec2(3., 6.));
  float drop = step(.985 - uRain * .02, hash(cell)) * smoothstep(0., .5, fract(rp.y / 6.));
  col += uRain * drop * .22 * mix(1., .5, uNightK);

  // 3. snow: whiten sky-facing surfaces from the 3D mask, plus falling flakes
  float sm = smoothstep(.80, .95, up) * (.75 + .25 * vnoise(ip / 12.)) * uSnow;
  vec3 snowCol = vec3(.95,.97,1.) * (.88 + .12 * luma(col)) * mix(1., .30, uNightK) * mix(vec3(1.), vec3(.75,.82,1.), uNightK);
  vec3 base = mix(col, ((sat(col, .6) - .5) * .9 + .5) * vec3(.88,.92,1.), uSnow * .6);
  col = mix(base, snowCol, sm * .85);
  vec2 fp = frag / 9. + vec2(sin(uTime * .7 + frag.y * .01) * .6, uTime * 7.);
  float flake = step(.992, hash(floor(fp))) * smoothstep(.5, .1, length(fract(fp) - .5));
  col += step(.01, uSnow) * flake * .55 * uSnow;

  // 4. smog: haze toward warm grey by day, city-glow brown by night; thicker in the distance
  vec3 haze = mix(vec3(.78,.74,.66), vec3(.26,.21,.18), uNightK);
  float k = uSmog * (.62 + .38 * far) * (.9 + .2 * fbm(ip / 900. + uTime * .01)) * mix(1., .55, uNightK);
  col = mix(sat(col, 1. - .3 * uSmog), haze, clamp(k, 0., .6));

  o = vec4(clamp(col, 0., 1.), day4.a);
}`;
