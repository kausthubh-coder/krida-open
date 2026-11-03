/*
 * Liquid Glass for the web. No dependencies.
 *
 * Every glass element gets an SVG filter built for its exact size: a displacement map baked from a
 * physical bezel profile (Snell's law through a squircle edge), split per colour channel for
 * dispersion, plus a specular rim map lit from one direction.
 *
 * Two engines feed that filter:
 * - backdrop: Chromium accepts SVG filters in backdrop-filter, so the glass refracts whatever is
 *   painted behind it, live.
 * - mirror: Safari and Firefox don't, so the glass holds a clone of its "scene" element (kept in sync
 *   with a MutationObserver and scroll/transform tracking) and runs the same filter on that clone.
 */

const NS = 'http://www.w3.org/2000/svg';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function detectEngine() {
  const forced = new URLSearchParams(location.search).get('lg-engine');
  if (forced) return forced;
  const brands = navigator.userAgentData?.brands ?? [];
  return brands.some((b) => b.brand === 'Chromium') ? 'backdrop' : 'mirror';
}

export const config = { engine: detectEngine() };

const IS_CHROMIUM = (navigator.userAgentData?.brands ?? []).some((b) => b.brand === 'Chromium');
const IS_GECKO = CSS.supports('-moz-appearance', 'none');
const IS_WEBKIT = !IS_CHROMIUM && !IS_GECKO;
/** Which engine is rendering, for components that tune per engine. */
export const browserEngine = IS_CHROMIUM ? 'chromium' : IS_GECKO ? 'gecko' : 'webkit';

/**
 * The mirror engine's filter uses objectBoundingBox units, because WebKit measures userSpaceOnUse
 * from an ancestor layer rather than the filtered element. Engines disagree on what one unit of
 * feDisplacementMap scale means in those units (measured): WebKit uses width for x and height for
 * y, Firefox uses the normalised diagonal for both, Chromium uses width for both. Returns px per
 * unit of scale on each axis for a W x H filter box.
 */
function bboxAxis(W, H) {
  if (IS_CHROMIUM) return [W, W];
  if (IS_GECKO) {
    const d = Math.sqrt((W * W + H * H) / 2);
    return [d, d];
  }
  return [W, H];
}

export const presets = {
  // Controls and floating chrome: strong edge, almost no blur.
  clear: { bezel: 16, thickness: 18, ior: 1.5, dispersion: 0.22, blur: 0.3, saturate: 1.5, spec: 1, zoom: 0 },
  // Big surfaces (sheets, menus, cards): frosted body, softer edge.
  regular: { bezel: 22, thickness: 14, ior: 1.45, dispersion: 0.12, blur: 7, saturate: 1.9, spec: 0.85, zoom: 0 },
  // The pressed state of knobs and bubbles: a magnifying lens.
  lens: { bezel: 12, thickness: 16, ior: 1.6, dispersion: 0.3, blur: 0, saturate: 1.25, spec: 1, zoom: 0.12 },
  // No refraction at all. Used where no scene can be cloned.
  frost: { bezel: 16, thickness: 0, ior: 1.5, dispersion: 0, blur: 12, saturate: 1.8, spec: 0.8, zoom: 0 },
};

/**
 * Themes restyle every glass element under an ancestor with data-glass-theme="<name>". They're
 * applied last, so they win over component defaults for the keys they set.
 * - bubble: light glass for light backgrounds. A rainbow film on the rim (iridescence), a soft
 *   white glow inside the edge, a faint dark outline so it reads on white, stronger dispersion.
 */
export const themes = {
  // Matched to @_crisjav's light bubble controls: thin faint rainbow edge, short white glints at
  // 10 and 4 o'clock instead of a full rim highlight, clear knobs, squash on press.
  bubble: { iridescence: 0.45, rimGlow: 0.55, outline: 0.1, spec: 0.3, glints: 1, dispersion: 0.7, light: -135, clearKnobs: true, press: 'squash' },
};

/** The theme an element sits in, for components that change behaviour per theme. */
export function themeOf(el) {
  return themeFor(el);
}

// ?lg-dispersion=0 and friends override every glass element, for A/B measurements.
const urlOverrides = {};
for (const [k, v] of new URLSearchParams(location.search)) {
  const name = k.startsWith('lg-') ? k.slice(3) : '';
  if (['dispersion', 'blur', 'bezel', 'thickness', 'refraction', 'zoom', 'iridescence', 'rimGlow', 'outline', 'spec'].includes(name)) urlOverrides[name] = Number(v);
}

const DEFAULTS = { ...presets.clear, curve: 3, light: -135, refraction: 1, iridescence: 0, rimGlow: 0, outline: 0, glints: 0, scene: null, mode: 'auto' };

/* ------------------------------------------------------------------------------------------------
 * Springs and the frame loop
 * ---------------------------------------------------------------------------------------------- */

const active = new Set();
const frameEnd = new Set();
let raf = 0;
let last = 0;

let inLoop = false;
let flushing = false;
let flushQueued = false;

function flushFrameEnd() {
  flushQueued = false;
  flushing = true;
  for (const fn of frameEnd) fn();
  frameEnd.clear();
  flushing = false;
}

function loop(now) {
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  inLoop = true;
  for (const s of active) s.step(dt);
  flushFrameEnd();
  inLoop = false;
  raf = active.size ? requestAnimationFrame(loop) : 0;
}

function kick() {
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
}

/**
 * Run fn once, batched, before this frame paints: at the end of the spring loop when called from a
 * spring, otherwise in a microtask. Waiting for the next animation frame instead leaves clones a
 * frame behind glass that something else moved, which shows as a 1-5px wobble.
 */
export function onFrameEnd(fn) {
  frameEnd.add(fn);
  if (inLoop || flushing || flushQueued) return;
  flushQueued = true;
  queueMicrotask(flushFrameEnd);
}

/**
 * Motion defaults, matched to the values shown in Tykra's Photos tuning panel: stiffness 560,
 * damping ratio 0.74, a 30 ms lag on the trailing edge of moving bubbles, 5% elongation from
 * speed, and buttons that bounce to 1.10.
 */
export const motion = { stiffness: 560, dampingRatio: 0.74, widthDelay: 30, elongation: 0.05, bounce: 1.1 };

export class Spring {
  constructor(value, { stiffness = 420, damping, dampingRatio, mass = 1, precision = 0.001, onUpdate } = {}) {
    this.value = this.target = value;
    this.velocity = 0;
    damping ??= 2 * (dampingRatio ?? 0.73) * Math.sqrt(stiffness * mass);
    Object.assign(this, { stiffness, damping, mass, precision, onUpdate });
  }

  to(target, velocity) {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    if (reduceMotion.matches) return this.set(target);
    active.add(this);
    kick();
    return this;
  }

  set(value) {
    this.value = this.target = value;
    this.velocity = 0;
    active.delete(this);
    this.onUpdate?.(value, this);
    return this;
  }

  step(dt) {
    const n = Math.ceil(dt * 240);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += (force / this.mass) * h;
      this.value += this.velocity * h;
    }
    if (Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 10) {
      this.value = this.target;
      this.velocity = 0;
      active.delete(this);
    }
    this.onUpdate?.(this.value, this);
  }

  get settled() {
    return !active.has(this);
  }
}

export const spring = (value, opts, onUpdate) => new Spring(value, { ...opts, onUpdate });

/* ------------------------------------------------------------------------------------------------
 * Baking maps
 * ---------------------------------------------------------------------------------------------- */

const PROFILE_N = 512;

/**
 * Sideways displacement (px) across the bezel, sampled at t = depth / bezel from the outer edge (0)
 * to where the glass goes flat (1). The edge is a convex curve h = 1 - (1 - t)^curve: higher curve
 * means a steeper wall and a tighter band. A vertical view ray refracts once at the surface (Snell's
 * law) and travels down through the glass, plus a base slab, to the content underneath.
 */
export function profile({ thickness, ior, bezel, curve = 3 }) {
  const out = new Float32Array(PROFILE_N + 1);
  const base = thickness * 0.5;
  for (let i = 0; i <= PROFILE_N; i++) {
    const u = 1 - i / PROFILE_N;
    const height = 1 - u ** curve;
    const dHeight = curve * u ** (curve - 1);
    const incidence = Math.atan((thickness / bezel) * dHeight);
    const refracted = Math.asin(Math.sin(incidence) / ior);
    out[i] = (height * thickness + base) * Math.tan(incidence - refracted);
  }
  return out;
}

/** Half-width of the region at row offset py that sits at least `inset` px inside the shape, or -1. */
function innerHalfWidth(py, hw, hh, R, inset) {
  const ihw = hw - inset;
  const ihh = hh - inset;
  const ir = Math.max(R - inset, 0);
  const ay = Math.abs(py);
  if (ihw <= 0 || ay > ihh) return -1;
  const straight = ihh - ir;
  if (ay <= straight) return ihw;
  const d = ay - straight;
  return d > ir ? -1 : ihw - ir + Math.sqrt(ir * ir - d * d);
}

/** Columns [from, to) on a row that can be skipped because they lie in the flat middle. */
function skipRange(j, W, hw, hh, R, bezel, scale) {
  const half = innerHalfWidth((j + 0.5) / scale - hh, hw, hh, R, bezel) * scale - 2;
  if (half <= 0) return [W, W];
  const c = (W * 1) / 2;
  return [Math.max(0, Math.ceil(c - half)), Math.min(W, Math.floor(c + half))];
}

/** Box-blur a field in place (radius 1, separable, twice): softens the steepest part of the rim. */
function smooth(f, W, H) {
  const tmp = new Float32Array(f.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < H; j++) {
      const row = j * W;
      for (let i = 0; i < W; i++) tmp[row + i] = (f[row + Math.max(i - 1, 0)] + f[row + i] + f[row + Math.min(i + 1, W - 1)]) / 3;
    }
    for (let j = 0; j < H; j++) {
      const up = Math.max(j - 1, 0) * W;
      const row = j * W;
      const dn = Math.min(j + 1, H - 1) * W;
      for (let i = 0; i < W; i++) f[row + i] = (tmp[up + i] + tmp[row + i] + tmp[dn + i]) / 3;
    }
  }
}

/** Signed distance to a rounded rect centred on the origin, and its outward normal. */
function roundedRect(px, py, hw, hh, r, out) {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  if (qx > 0 && qy > 0) {
    const len = Math.hypot(qx, qy);
    out.d = len - r;
    out.nx = (qx / len) * Math.sign(px);
    out.ny = (qy / len) * Math.sign(py);
  } else if (qx > qy) {
    out.d = qx - r;
    out.nx = Math.sign(px) || 1;
    out.ny = 0;
  } else {
    out.d = qy - r;
    out.nx = 0;
    out.ny = Math.sign(py) || 1;
  }
}

function hsl(h, sat, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

const mapCache = new Map();
let canvas;

function toDataURL(img) {
  canvas ??= document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d').putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Bake the displacement map (1x) and specular map (device pixels) for a w x h shape with corner
 * radius r. Returns data URLs and the feDisplacementMap scale that decodes the map back to pixels.
 */
export function bake(w, h, r, o, axis = [1, 1], pad = 0, res = 1) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const bezel = Math.max(1, Math.min(o.bezel, W / 2, H / 2));
  const R = Math.min(Math.max(r, bezel), W / 2, H / 2);
  const key = [W, H, R, bezel, o.thickness, o.ior, o.curve, o.zoom, o.spec, o.light, o.refraction, o.iridescence, o.rimGlow, o.outline, o.glints, dpr, axis[0].toFixed(2), axis[1].toFixed(2), pad, res].join();
  const hit = mapCache.get(key);
  if (hit) {
    mapCache.delete(key);
    mapCache.set(key, hit);
    return hit;
  }

  const t0 = performance.now();
  const table = profile({ thickness: o.thickness, ior: o.ior, bezel, curve: o.curve });
  const hw = W / 2;
  const hh = H / 2;
  const s = { d: 0, nx: 0, ny: 0 };

  // Displacement vectors in px, on a grid of res samples per CSS px (WebKit samples a 1x map
  // coarsely on small knobs, which roughens edges). Only the bezel band moves unless zoom
  // magnifies the whole body.
  const MW = Math.max(1, Math.round(W * res));
  const MH = Math.max(1, Math.round(H * res));
  const dx = new Float32Array(MW * MH);
  const dy = new Float32Array(MW * MH);
  const full = o.zoom !== 0;
  for (let j = 0; j < MH; j++) {
    const [from, to] = full ? [MW, MW] : skipRange(j, MW, hw, hh, R, bezel, res);
    for (let i = 0; i < MW; i++) {
      if (i === from) i = to;
      if (i >= MW) break;
      const px = (i + 0.5) / res - hw;
      const py = (j + 0.5) / res - hh;
      roundedRect(px, py, hw, hh, R, s);
      const t = Math.min(Math.max(-s.d / bezel, 0), 1);
      const mag = table[Math.round(t * PROFILE_N)] * o.refraction;
      // Sample from further inside the glass: the edge bends the view inward, like a real lens.
      const k = j * MW + i;
      dx[k] = -s.nx * mag - px * o.zoom;
      dy[k] = -s.ny * mag - py * o.zoom;
    }
  }
  smooth(dx, MW, MH);
  smooth(dy, MW, MH);
  // Express offsets in filter-scale units per axis, so one map decodes to the right pixels.
  let max = 0;
  for (let k = 0; k < MW * MH; k++) {
    dx[k] /= axis[0];
    dy[k] /= axis[1];
    max = Math.max(max, Math.abs(dx[k]), Math.abs(dy[k]));
  }

  const disp = new ImageData(MW, MH);
  const d32 = new Uint32Array(disp.data.buffer);
  d32.fill(0xff008080); // R = G = 128 means "no displacement"
  if (max > 0) {
    const px = disp.data;
    for (let k = 0; k < MW * MH; k++) {
      if (Math.abs(dx[k]) < max * 1e-3 && Math.abs(dy[k]) < max * 1e-3) continue;
      px[k * 4] = 128 + Math.round((dx[k] / max) * 127);
      px[k * 4 + 1] = 128 + Math.round((dy[k] / max) * 127);
    }
  }

  // Rim light, composited per pixel, bottom to top:
  // - outline: a dark hairline at the very edge, so light glass reads on a white page;
  // - iridescence: a thin rainbow film just inside the edge, hue running around the perimeter;
  // - rimGlow: a soft white glow inside the edge, all the way round;
  // - specular: a crisp 1px line plus a soft glow, brightest on the side facing the light and
  //   fainter on the opposite edge where light exits.
  const SW = Math.round(W * dpr);
  const SH = Math.round(H * dpr);
  const spec = new ImageData(SW, SH);
  const hasRim = o.spec > 0 || o.iridescence > 0 || o.rimGlow > 0 || o.outline > 0 || o.glints > 0;
  if (hasRim) {
    const sp = spec.data;
    const lx = Math.cos((o.light * Math.PI) / 180);
    const ly = Math.sin((o.light * Math.PI) / 180);
    const ringAt = Math.min(2.6, bezel * 0.22);
    const glintAt = Math.min(Math.max(2.5, bezel * 0.3), 7);
    const lightAngle = (o.light * Math.PI) / 180;
    const ringW = Math.max(1.1, bezel * 0.1);
    for (let j = 0; j < SH; j++) {
      const [from, to] = skipRange(j, SW, hw, hh, R, bezel, dpr);
      for (let i = 0; i < SW; i++) {
        if (i === from) i = to;
        if (i >= SW) break;
        roundedRect((i + 0.5) / dpr - hw, (j + 0.5) / dpr - hh, hw, hh, R, s);
        const e = -s.d;
        if (e < 0 || e > bezel) continue;
        const facing = s.nx * lx + s.ny * ly;
        const front = Math.max(facing, 0);
        const back = Math.max(-facing, 0);
        let r = 0, g = 0, b = 0, a = 0;
        const over = (cr, cg, cb, ca) => {
          if (ca <= 0) return;
          ca = Math.min(ca, 1);
          r = cr * ca + r * (1 - ca);
          g = cg * ca + g * (1 - ca);
          b = cb * ca + b * (1 - ca);
          a = ca + a * (1 - ca);
        };
        if (o.outline > 0) over(0, 0, 0, o.outline * Math.exp(-e / 0.7) * (0.5 + 0.5 * back));
        if (o.iridescence > 0) {
          const ring = Math.exp(-(((e - ringAt) / ringW) ** 2));
          const hue = ((Math.atan2(s.ny, s.nx) * 180) / Math.PI) * 1.5 + e * 30 + 200;
          const [cr, cg, cb] = hsl(hue, 1, 0.62);
          // Strongest away from the light; the lit edge washes out to white, as in real thin films.
          over(cr, cg, cb, o.iridescence * 0.55 * ring * (0.25 + 0.75 * back ** 0.8 + 0.25 * (1 - Math.abs(facing))));
        }
        if (o.rimGlow > 0) {
          // A milky band a few px wide, brightest on the lit side, plus a faint wide falloff.
          const band = Math.exp(-(((e - bezel * 0.12) / (bezel * 0.16)) ** 2));
          over(1, 1, 1, o.rimGlow * (0.55 * band + 0.18 * Math.exp(-e / (bezel * 0.6))) * (0.5 + 0.5 * front));
        }
        if (o.glints > 0) {
          // Two short curved strokes just inside the rim, facing the light and opposite it.
          const ang = Math.atan2(s.ny, s.nx);
          const near = (target) => {
            const d = Math.atan2(Math.sin(ang - target), Math.cos(ang - target));
            return Math.exp(-((d / 0.38) ** 2));
          };
          const arc = Math.max(near(lightAngle), 0.8 * near(lightAngle + Math.PI));
          const stroke = Math.exp(-(((e - glintAt) / 1.5) ** 2));
          over(1, 1, 1, Math.min(1, o.glints * 1.3 * arc * stroke));
        }
        if (o.spec > 0) {
          const crisp = Math.exp(-e / 0.75);
          const soft = Math.exp(-e / (bezel * 0.45));
          over(1, 1, 1, o.spec * (crisp * (0.22 + 0.78 * front ** 1.5 + 0.5 * back ** 2) + soft * 0.2 * (front ** 2 + 0.55 * back ** 2)));
        }
        if (a <= 0) continue;
        const k = (j * SW + i) * 4;
        sp[k] = Math.round((r / a) * 255);
        sp[k + 1] = Math.round((g / a) * 255);
        sp[k + 2] = Math.round((b / a) * 255);
        sp[k + 3] = Math.round(a * 255);
      }
    }
  }

  // With padding, the map covers the whole padded filter box (neutral around the edge), so the
  // feImage sits at 0,0 / 1x1 in bbox units. A fractional offset makes WebKit round it and leave a
  // 1px row of no map along two edges, where the colour passes split into yellow lines.
  let dispOut = disp;
  if (pad > 0) {
    const P = Math.round(pad * res);
    dispOut = new ImageData(MW + P * 2, MH + P * 2);
    new Uint32Array(dispOut.data.buffer).fill(0xff008080);
    for (let j = 0; j < MH; j++) dispOut.data.set(disp.data.subarray(j * MW * 4, (j + 1) * MW * 4), ((j + P) * (MW + P * 2) + P) * 4);
  }

  const result = {
    key,
    W,
    H,
    scale: max * 2,
    disp: toDataURL(dispOut),
    spec: hasRim ? toDataURL(spec) : '',
    ms: performance.now() - t0,
  };
  mapCache.set(key, result);
  if (mapCache.size > 96) mapCache.delete(mapCache.keys().next().value);
  return result;
}

/* ------------------------------------------------------------------------------------------------
 * SVG filters
 * ---------------------------------------------------------------------------------------------- */

let defs;
const filters = new Map(); // key -> { el, id, users }
let filterSeq = 0;

function svgDefs() {
  if (defs) return defs;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  document.body.appendChild(svg);
  defs = svg;
  return svg;
}

/**
 * layout.units 'px': userSpaceOnUse, filter box = the element (Chromium backdrop-filter).
 * layout.units 'bbox': objectBoundingBox, filter box = the element plus `pad` on every side, with
 * blur done by CSS before the filter (mirror engine).
 */
function acquireFilter(maps, o, layout) {
  const bbox = layout.units === 'bbox';
  const key = `${maps.key}|${o.blur}|${o.dispersion}|${o.saturate}|${bbox ? `b${layout.FW}x${layout.FH}p${layout.pad}` : 'px'}${layout.owner ? `|${layout.owner}` : ''}`;
  let f = filters.get(key);
  if (!f) {
    const id = `lg-f${++filterSeq}`;
    const el = document.createElementNS(NS, 'filter');
    const { W, H, scale } = maps;
    const box = bbox
      ? // A little slack around the box: WebKit rounds a bbox filter region inward at fractional
        // positions, and the displaced colour passes then sample past its edge (yellow lines).
        { x: -0.05, y: -0.05, width: 1.1, height: 1.1, filterUnits: 'objectBoundingBox', primitiveUnits: 'objectBoundingBox' }
      : { x: 0, y: 0, width: W, height: H, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse' };
    for (const [k, v] of Object.entries({ id, ...box, 'color-interpolation-filters': 'sRGB' })) el.setAttribute(k, v);
    const img = bbox ? { x: 0, y: 0, w: 1, h: 1 } : { x: 0, y: 0, w: W, h: H };

    const src = o.blur > 0 && !bbox ? 'blurred' : 'SourceGraphic';
    let body = src === 'blurred' ? `<feGaussianBlur in="SourceGraphic" stdDeviation="${o.blur}" edgeMode="duplicate" result="blurred"/>` : '';
    body += `<feImage href="${maps.disp}" x="${img.x}" y="${img.y}" width="${img.w}" height="${img.h}" preserveAspectRatio="none" result="map"/>`;
    const displace = (sc, result) =>
      `<feDisplacementMap in="${src}" in2="map" scale="${+sc.toPrecision(6)}" data-base="${+sc.toPrecision(6)}" xChannelSelector="R" yChannelSelector="G" result="${result}"/>`;
    if (o.dispersion > 0 && scale > 0) {
      // Blue bends most, red least. Each channel gets its own displacement with alpha forced to 1,
      // the three are added, and alpha comes back from the middle pass. A screen blend instead
      // leaves black and single-colour pixels wherever one channel lands on a transparent gap.
      const d = o.dispersion * 0.2;
      const keep = (c) => ['1 0 0 0 0', '0 1 0 0 0', '0 0 1 0 0'].map((row, i) => (i === c ? row : '0 0 0 0 0')).join('  ') + '  0 0 0 0 1';
      body += displace(scale * (1 - d), 'dr');
      body += `<feColorMatrix in="dr" type="matrix" values="${keep(0)}" result="r"/>`;
      body += displace(scale, 'dg');
      body += `<feColorMatrix in="dg" type="matrix" values="${keep(1)}" result="g"/>`;
      body += displace(scale * (1 + d), 'db');
      body += `<feColorMatrix in="db" type="matrix" values="${keep(2)}" result="b"/>`;
      body += `<feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg"/>`;
      body += `<feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1" result="rgb"/>`;
      body += `<feComposite in="rgb" in2="dg" operator="in" result="out"/>`;
    } else {
      body += displace(scale, 'out');
    }
    if (o.saturate !== 1) body += `<feColorMatrix in="out" type="saturate" values="${o.saturate}"/>`;
    el.innerHTML = body;
    svgDefs().appendChild(el);
    // WebKit can render a filter before its feImage map has decoded and never repaint once it
    // has, leaving streaks of unbent or channel-split pixels. Decode the map first; elements
    // re-apply the filter when this resolves.
    const ready = IS_WEBKIT ? new Image() : null;
    let readyPromise = Promise.resolve();
    if (ready) {
      ready.src = maps.disp;
      readyPromise = ready.decode().catch(() => {});
    }
    f = { el, id, users: 0, ready: readyPromise };
    filters.set(key, f);
  }
  f.users++;
  return f;
}

function releaseFilter(f) {
  if (!f) return;
  f.users--;
  if (f.users > 0) return;
  // Keep it a moment: a slider dragged back and forth reuses the same few filters.
  setTimeout(() => {
    if (f.users > 0) return;
    for (const [k, v] of filters) if (v === f) filters.delete(k);
    f.el.remove();
  }, 2000);
}

/* ------------------------------------------------------------------------------------------------
 * Scenes (mirror engine)
 * ---------------------------------------------------------------------------------------------- */

const scenes = new Map();

class Scene {
  constructor(el) {
    this.el = el;
    this.users = new Set();
    this.pending = false;
    // WebKit can anchor the page to content inside a scene that scrolls in its own container.
    // Aligning clones forces a layout mid-scroll, WebKit sees the anchor move, and scrolls the
    // whole page the other way. Scenes are never good anchors, so opt them out.
    el.style.overflowAnchor = 'none';
    sizeObserver.observe(el);
    this.queue = [];
    this.full = false;
    this.observer = new MutationObserver((records) => {
      const real = records.filter((r) => !this.isOwnNoise(r.target));
      if (!real.length) return;
      this.queue.push(...real);
      this.invalidate(false);
    });
    this.observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  }

  /** Mutations inside glass that lives in this scene never show up in clones, so ignore them. */
  isOwnNoise(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const glassEl = el?.closest('.lg, .lg-mirror');
    return !!glassEl && glassEl !== this.el && this.el.contains(glassEl);
  }

  /**
   * Bring clones up to date. Small changes (text, attributes, a changed child list) are patched
   * into each clone at the same path; re-cloning a whole scene for a ticking clock caused a 25-50ms
   * hitch every second in WebKit. Resizes and anything unpatchable fall back to a full re-clone.
   */
  invalidate(full = true) {
    if (full) this.full = true;
    if (this.pending) return;
    this.pending = true;
    onFrameEnd(() => {
      this.pending = false;
      const records = this.queue;
      const full = this.full;
      this.queue = [];
      this.full = false;
      for (const g of this.users) {
        // Hidden or offscreen glass catches up when it's seen again.
        if (g.suspended || !visible.has(g)) g.stale = true;
        else if (full || g.stale || !g.patch(records)) g.reclone();
      }
    });
  }

  /** Child-index path from the scene root to node, or null if it's no longer in the scene. */
  pathTo(node) {
    const path = [];
    for (let n = node; n !== this.el; n = n.parentNode) {
      const parent = n?.parentNode;
      if (!parent) return null;
      path.push(Array.prototype.indexOf.call(parent.childNodes, n));
    }
    return path.reverse();
  }

  release(g) {
    this.users.delete(g);
    if (this.users.size) return;
    this.observer.disconnect();
    sizeObserver.unobserve(this.el);
    scenes.delete(this.el);
  }
}

function sceneFor(el) {
  let s = scenes.get(el);
  if (!s) scenes.set(el, (s = new Scene(el)));
  return s;
}

/** The scene for a glass element: an explicit one, or the nearest [data-glass-scene] beside an ancestor. */
function findScene(el, explicit) {
  if (explicit instanceof Element) return explicit;
  if (typeof explicit === 'string') return document.querySelector(explicit);
  for (let a = el.parentElement; a; a = a.parentElement) {
    const s = a.querySelector(':scope > [data-glass-scene]');
    if (s && !s.contains(el)) return s;
    if (a.hasAttribute('data-glass-scene')) return a;
  }
  return null;
}

/** Strip what a clone mustn't carry: other glass's own layers and duplicate ids. */
function cleanClone(node) {
  if (node.nodeType !== 1) return;
  for (const n of node.querySelectorAll('.lg-mirror, .lg-spec')) n.remove();
  for (const n of node.querySelectorAll('[id]')) n.removeAttribute('id');
  node.removeAttribute('id');
}

function syncAnimations(src, dst) {
  const mine = (a) => !a.effect?.target?.closest?.('.lg-mirror');
  const a = src.getAnimations({ subtree: true }).filter(mine);
  const b = dst.getAnimations({ subtree: true });
  if (a.length !== b.length) return;
  b.forEach((anim, i) => {
    anim.playbackRate = a[i].playbackRate;
    if (a[i].startTime != null) anim.startTime = a[i].startTime;
    else anim.currentTime = a[i].currentTime;
  });
}

/* ------------------------------------------------------------------------------------------------
 * Glass
 * ---------------------------------------------------------------------------------------------- */

/**
 * Final options: base, then theme, then URL overrides. WebKit gets no colour split: its
 * feDisplacementMap passes come back with transparent bands at some sizes and fractional
 * positions, which the channel recombine turns into yellow and red streaks (Chromium on the same
 * clone path is clean). Each pass also costs WebKit CPU time. The iridescent rim still adds colour.
 */
function resolve(base, el) {
  const o = { ...base, ...themeFor(el), ...urlOverrides };
  if (IS_WEBKIT && !('dispersion' in urlOverrides)) o.dispersion = 0;
  return o;
}

function themeFor(el) {
  const name = el.closest('[data-glass-theme]')?.getAttribute('data-glass-theme');
  return (name && themes[name]) || {};
}

const all = new Set();
const visible = new Set();
const instances = new WeakMap();

/**
 * Exact (fractional) border-box sizes. offsetWidth rounds to whole pixels, and dividing a
 * transformed rect by a rounded size gives a scale that's off by up to 0.5px per element width,
 * which over a 1440px scene puts the clone several pixels out.
 */
const boxes = new WeakMap();
const sizeObserver = new ResizeObserver((entries) => {
  for (const e of entries) {
    const b = e.borderBoxSize?.[0];
    boxes.set(e.target, b ? { w: b.inlineSize, h: b.blockSize } : { w: e.target.offsetWidth, h: e.target.offsetHeight });
    scenes.get(e.target)?.invalidate();
    const g = fxOwners.get(e.target);
    if (g) g.sync();
  }
});
const fxOwners = new WeakMap();
function box(el) {
  return boxes.get(el) ?? { w: el.offsetWidth, h: el.offsetHeight };
}

const resizeObserver = new ResizeObserver((entries) => {
  for (const e of entries) instances.get(e.target)?.update();
});

const viewObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const g = instances.get(e.target);
      if (!g) continue;
      if (e.isIntersecting) {
        visible.add(g);
        if (g.stale && !g.suspended) g.reclone();
        else g.sync();
      } else visible.delete(g);
    }
  },
  { rootMargin: '100px' },
);

let syncQueued = false;
function syncVisible() {
  if (syncQueued) return;
  syncQueued = true;
  onFrameEnd(() => {
    syncQueued = false;
    for (const g of visible) g.sync();
    for (const g of adaptive) g.adapt();
  });
}

/**
 * Apple flips small glass between light and dark based on what's behind it. A page can't read
 * DOM pixels, so adaptive glass (data-glass-adapt) asks the element under its centre which theme
 * it sits in (the nearest data-glass-theme, or none) and takes that theme.
 */
const adaptive = new Set();
addEventListener('scroll', syncVisible, { capture: true, passive: true });
addEventListener('resize', syncVisible, { passive: true });

function readOptions(el) {
  const o = {};
  const preset = el.getAttribute('data-glass');
  if (preset && presets[preset]) Object.assign(o, presets[preset]);
  for (const k of ['bezel', 'thickness', 'curve', 'ior', 'dispersion', 'blur', 'saturate', 'spec', 'zoom', 'light', 'refraction', 'iridescence', 'rimGlow', 'outline', 'glints']) {
    const v = el.getAttribute(`data-glass-${k}`);
    if (v !== null && v !== '') o[k] = Number(v);
  }
  const scene = el.getAttribute('data-glass-scene-ref');
  if (scene) o.scene = scene;
  const mode = el.getAttribute('data-glass-mode');
  if (mode) o.mode = mode;
  return o;
}

export class Glass {
  constructor(el, opts = {}) {
    this.el = el;
    this.base = { ...DEFAULTS, ...readOptions(el), ...opts };
    this.o = resolve(this.base, el);
    this.strength = 1;
    this.filter = null;
    this.maps = null;
    this.size = '';
    this.scene = null;
    this.mirror = null;
    this.clone = null;
    this.suspended = false;
    this.stale = false;

    el.classList.add('lg');
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    this.specEl = document.createElement('span');
    this.specEl.className = 'lg-spec';
    this.specEl.setAttribute('aria-hidden', 'true');
    el.appendChild(this.specEl);

    instances.set(el, this);
    all.add(this);
    if (this.o.adapt || el.hasAttribute('data-glass-adapt')) {
      adaptive.add(this);
      requestAnimationFrame(() => this.adapt());
    }
    resizeObserver.observe(el);
    viewObserver.observe(el);
    this.applyMode();
  }

  /** Decide how this element refracts: backdrop, a mirrored scene, or plain frost. */
  applyMode() {
    const wanted = config.engine === 'off' ? 'off' : this.o.mode === 'auto' ? config.engine : this.o.mode;
    let mode = wanted;
    let sceneEl = null;
    if (mode === 'mirror') {
      sceneEl = findScene(this.el, this.o.scene);
      if (!sceneEl) mode = 'frost';
    }
    this.mode = mode;
    this.el.dataset.lgMode = mode;

    if (this.scene && this.scene.el !== sceneEl) {
      this.scene.release(this);
      this.scene = null;
    }
    if (mode === 'mirror') {
      if (!this.mirror) {
        // Outer layer clips to the rounded shape; inner layer carries the filter. Firefox doesn't clip
        // a filter's output to the same element's border-radius.
        this.mirror = document.createElement('span');
        this.mirror.className = 'lg-mirror';
        this.mirror.setAttribute('aria-hidden', 'true');
        this.fx = document.createElement('span');
        this.fx.className = 'lg-mirror-fx';
        this.mirror.appendChild(this.fx);
        this.el.prepend(this.mirror);
        fxOwners.set(this.fx, this);
        sizeObserver.observe(this.fx);
      }
      if (!this.scene) {
        this.scene = sceneFor(sceneEl);
        this.scene.users.add(this);
      }
      this.reclone();
    } else if (this.mirror) {
      this.mirror.remove();
      this.mirror = this.fx = this.clone = null;
    }
    this.size = '';
    this.update();
  }

  set(opts) {
    const sceneChanged = 'scene' in opts && opts.scene !== this.o.scene;
    const modeChanged = 'mode' in opts && opts.mode !== this.o.mode;
    Object.assign(this.base, opts);
    Object.assign(this.o, opts);
    if (sceneChanged || modeChanged) this.applyMode();
    else {
      this.size = '';
      this.update();
    }
  }

  radius(w, h) {
    const raw = getComputedStyle(this.el).borderTopLeftRadius;
    const v = parseFloat(raw) || 0;
    const r = raw.endsWith('%') ? (Math.min(w, h) * v) / 100 : v;
    return Math.min(r, w / 2, h / 2);
  }

  /** Rebuild the maps and filter when the element's layout size (not its transform) changes. */
  update() {
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    if (!w || !h) return;
    const r = this.radius(w, h);
    const sig = `${w}x${h}r${r}`;
    if (sig === this.size) return;
    this.size = sig;
    const o = this.o;

    releaseFilter(this.filterFast);
    this.filterFast = null;
    if (this.mode === 'off') {
      releaseFilter(this.filter);
      this.filter = null;
      this.el.style.backdropFilter = this.el.style.webkitBackdropFilter = '';
      this.specEl.style.backgroundImage = 'none';
      return;
    }

    if (this.mode === 'frost') {
      releaseFilter(this.filter);
      this.filter = null;
      const blur = Math.max(o.blur, 8);
      this.el.style.backdropFilter = this.el.style.webkitBackdropFilter = `blur(${blur}px) saturate(${o.saturate})`;
      this.maps = bake(w, h, r, { ...o, thickness: 0.0001, zoom: 0 });
      this.specEl.style.backgroundImage = this.maps.spec ? `url(${this.maps.spec})` : 'none';
      return;
    }

    const prev = this.filter;
    if (this.mode === 'backdrop') {
      this.maps = bake(w, h, r, o);
      this.filter = acquireFilter(this.maps, o, { units: 'px', owner: this.owner });
      this.el.style.backdropFilter = this.suspended ? 'none' : `url(#${this.filter.id})`;
    } else {
      // Pad the filtered layer so CSS blur has real pixels to pull in at the edges.
      // Always at least 1px: WebKit mis-renders a bbox filter that sits flush with its layer
      // (a channel-split streak across the glass, reproducible with blur 0).
      const pad = Math.max(1, o.blur > 0 ? Math.ceil(o.blur * 2.5) : 0);
      const FW = w + pad * 2;
      const FH = h + pad * 2;
      this.fx.style.inset = `${-pad}px`;
      this.maps = bake(w, h, r, o, bboxAxis(FW, FH), pad, IS_WEBKIT ? Math.min(devicePixelRatio || 1, 2) : 1);
      const layout = { units: 'bbox', FW, FH, pad, owner: this.owner };
      this.filter = acquireFilter(this.maps, o, layout);
      const blur = o.blur > 0 ? `blur(${o.blur}px) ` : '';
      this.fxFull = `${blur}url(#${this.filter.id})`;
      // What to show while content scrolls under still glass (measured, see AGENTS.md):
      // - WebKit runs SVG filters on the CPU at a fixed cost per element per frame, so five glass
      //   controls over a scrolling list miss frames. It drops to GPU-only CSS filters until the
      //   content settles, then the refraction returns.
      // - Firefox runs the full filter during scroll at no measurable cost, so it keeps it.
      // - Chromium only lands here when forced to mirror; it drops the colour split.
      const prevFast = this.filterFast;
      this.filterFast = IS_CHROMIUM && o.dispersion > 0 ? acquireFilter(this.maps, { ...o, dispersion: 0 }, layout) : null;
      releaseFilter(prevFast);
      if (IS_WEBKIT) this.fxFast = `${blur}saturate(${o.saturate})`;
      else this.fxFast = this.filterFast ? `${blur}url(#${this.filterFast.id})` : this.fxFull;
      this.el.style.backdropFilter = this.el.style.webkitBackdropFilter = '';
      this.fx.style.filter = this.moving ? this.fxFast : this.fxFull;
      if (IS_WEBKIT) {
        const f = this.filter;
        f.ready.then(() =>
          requestAnimationFrame(() => {
            if (this.filter !== f || !this.fx || this.moving) return;
            this.fx.style.filter = 'none';
            void this.fx.offsetWidth;
            this.fx.style.filter = this.fxFull;
          }),
        );
      }
    }
    this.specEl.style.backgroundImage = this.maps.spec ? `url(${this.maps.spec})` : 'none';
    releaseFilter(prev);
    if (this.strength !== 1) this.applyStrength();
    this.sync();
  }

  /**
   * Scale how hard the glass bends, 0 (flat) to 1. Apple materializes glass by modulating the
   * lensing instead of fading it; menus and sheets animate this as they open. The first call gives
   * the element its own filter, so shared filters aren't affected.
   */
  setStrength(k) {
    if (!this.owner) {
      this.owner = `o${++filterSeq}`;
      this.size = '';
      this.update();
    }
    this.strength = k;
    this.applyStrength();
  }

  applyStrength() {
    for (const f of [this.filter, this.filterFast]) {
      if (!f) continue;
      for (const d of f.el.querySelectorAll('feDisplacementMap')) d.setAttribute('scale', String(Number(d.dataset.base) * this.strength));
    }
  }

  adapt() {
    const r = this.el.getBoundingClientRect();
    const under = document
      .elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      .find((n) => !this.el.contains(n) && !n.contains(this.el) && !n.closest('.lg'));
    const name = under?.closest('[data-glass-theme]')?.getAttribute('data-glass-theme') ?? '';
    if (name === (this.el.getAttribute('data-glass-theme') ?? '')) return;
    if (name) this.el.setAttribute('data-glass-theme', name);
    else this.el.removeAttribute('data-glass-theme');
    this.retheme();
  }

  /** Re-read the theme from the ancestors (after data-glass-theme changes). */
  retheme() {
    this.o = resolve(this.base, this.el);
    this.size = '';
    this.update();
  }

  /**
   * Stop refracting while the glass can't be seen (a knob under its white face, a lens at opacity
   * 0). The filter stays built, so resume() costs nothing.
   */
  suspend() {
    if (this.suspended) return;
    this.suspended = true;
    this.el.dataset.lgSuspended = '';
    if (this.mode === 'backdrop') this.el.style.backdropFilter = 'none';
  }

  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    delete this.el.dataset.lgSuspended;
    if (this.mode === 'backdrop' && this.filter) this.el.style.backdropFilter = `url(#${this.filter.id})`;
    if (this.mode === 'mirror') {
      if (this.stale) this.reclone();
      else this.sync();
    }
  }

  /** Apply mutation records to the existing clone. Returns false when a full re-clone is needed. */
  patch(records) {
    const root = this.clone;
    if (!root) return false;
    const scene = this.scene;
    let structural = false;
    for (const r of records) {
      const path = scene.pathTo(r.target);
      if (!path) return false;
      let node = root;
      for (const i of path) {
        node = node?.childNodes[i];
        if (!node) return false;
      }
      if (node.nodeName !== r.target.nodeName) return false;
      if (r.type === 'characterData') node.data = r.target.data;
      else if (r.type === 'attributes') {
        // The clone root carries our positioning styles; ids are stripped from clones.
        if (r.attributeName === 'id') continue;
        if (node === root && (r.attributeName === 'style' || r.attributeName === 'class')) return false;
        const v = r.target.getAttribute(r.attributeName);
        if (v === null) node.removeAttribute(r.attributeName);
        else node.setAttribute(r.attributeName, v);
      } else {
        if (node === root) return false;
        const fresh = r.target.cloneNode(true);
        cleanClone(fresh);
        node.replaceWith(fresh);
        structural = true;
      }
    }
    if (structural) syncAnimations(scene.el, root);
    return true;
  }

  reclone() {
    if (this.mode !== 'mirror' || !this.scene) return;
    this.stale = false;
    const src = this.scene.el;
    const clone = src.cloneNode(true);
    cleanClone(clone);
    clone.removeAttribute('id');
    clone.removeAttribute('data-glass-scene');
    clone.classList.add('lg-clone');
    clone.inert = true;
    Object.assign(clone.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      right: 'auto',
      bottom: 'auto',
      margin: '0',
      width: `${box(src).w}px`,
      height: `${box(src).h}px`,
      maxWidth: 'none',
      maxHeight: 'none',
      transformOrigin: '0 0',
      translate: 'none',
      scale: 'none',
      rotate: 'none',
      pointerEvents: 'none',
    });
    // Canvases clone blank: copy their pixels once.
    const srcCanvases = src.querySelectorAll('canvas');
    clone.querySelectorAll('canvas').forEach((c, i) => {
      const from = srcCanvases[i];
      if (!from?.width) return;
      try {
        c.getContext('2d')?.drawImage(from, 0, 0);
      } catch {}
    });
    this.fx.replaceChildren(clone);
    this.clone = clone;
    this.lastTransform = '';
    syncAnimations(src, clone);
    this.sync();
  }

  /** Line the clone up with the real scene, undoing this element's own transform. */
  sync() {
    if (!this.clone || this.suspended) return;
    const m = this.fx.getBoundingClientRect();
    const s = this.scene.el.getBoundingClientRect();
    const fb = box(this.fx);
    const sb = box(this.scene.el);
    const sx = m.width / (fb.w || 1) || 1;
    const sy = m.height / (fb.h || 1) || 1;
    const ssx = s.width / (sb.w || 1) || 1;
    const ssy = s.height / (sb.h || 1) || 1;
    const transform = `translate(${(s.left - m.left) / sx}px, ${(s.top - m.top) / sy}px) scale(${ssx / sx}, ${ssy / sy})`;
    if (transform === this.lastTransform) return;
    // The scene moved under glass that stayed put (a list scrolling under a tab bar): switch to
    // the cheaper look until it settles. Moving glass (a dragged lens) keeps the full filter.
    const glassStill = this.lastRect && m.left === this.lastRect.left && m.top === this.lastRect.top;
    if (this.lastTransform && glassStill && this.fxFast !== this.fxFull) {
      if (!this.moving) {
        this.moving = true;
        this.fx.style.filter = this.fxFast;
      }
      clearTimeout(this.settle);
      this.settle = setTimeout(() => {
        this.moving = false;
        this.fx.style.filter = this.fxFull;
      }, 180);
    }
    this.lastRect = { left: m.left, top: m.top };
    this.lastTransform = transform;
    this.clone.style.transform = transform;
  }

  /** Call from animation code after moving the element; batched to once per frame. */
  requestSync() {
    if (this.mode === 'mirror') onFrameEnd(() => this.sync());
  }

  destroy() {
    resizeObserver.unobserve(this.el);
    viewObserver.unobserve(this.el);
    releaseFilter(this.filter);
    releaseFilter(this.filterFast);
    this.scene?.release(this);
    this.mirror?.remove();
    this.specEl.remove();
    this.el.style.backdropFilter = this.el.style.webkitBackdropFilter = '';
    this.el.classList.remove('lg');
    delete this.el.dataset.lgMode;
    all.delete(this);
    visible.delete(this);
    adaptive.delete(this);
    instances.delete(this.el);
  }
}

/** Turn an element into glass, or return the glass it already is. */
export function glass(el, opts) {
  const existing = instances.get(el);
  if (existing) {
    if (opts) existing.set(opts);
    return existing;
  }
  return new Glass(el, opts);
}

export const glassOf = (el) => instances.get(el);

/** Re-apply themes to every glass element, after changing a data-glass-theme attribute. */
export function refreshThemes() {
  for (const g of all) g.retheme();
  document.dispatchEvent(new Event('lg-retheme'));
}

/** Switch every glass element to another engine (for testing the mirror path in Chromium). */
export function setEngine(name) {
  config.engine = name;
  for (const g of all) g.applyMode();
}

export function stats() {
  const modes = {};
  for (const g of all) modes[g.mode] = (modes[g.mode] || 0) + 1;
  return { engine: config.engine, glass: all.size, filters: filters.size, maps: mapCache.size, scenes: scenes.size, modes };
}

/* ------------------------------------------------------------------------------------------------
 * Press: grow, glow under the finger, lean toward it
 * ---------------------------------------------------------------------------------------------- */

export function pressable(el, { scale = motion.bounce, lean = 0.06 } = {}) {
  if (el._lgPress) return;
  el._lgPress = true;
  const g = () => instances.get(el);
  // Uniform bounce by default; themes with press: 'squash' flatten instead (wider, shorter).
  const sx = spring(1, { stiffness: motion.stiffness, dampingRatio: 0.5, precision: 0.0005 });
  const sy = spring(1, { stiffness: motion.stiffness, dampingRatio: 0.5, precision: 0.0005 });
  sx.onUpdate = sy.onUpdate = () => {
    el.style.scale = `${sx.value.toFixed(4)} ${sy.value.toFixed(4)}`;
    g()?.requestSync();
  };
  const s = {
    to(v) {
      if (v !== 1 && themeFor(el).press === 'squash') {
        const r = el.getBoundingClientRect();
        const flat = Math.min(0.1, 9 / Math.max(r.height, 1));
        sx.to(1 + flat * 0.6);
        sy.to(1 - flat);
      } else {
        sx.to(v);
        sy.to(v);
      }
    },
  };
  const glow = spring(0, { stiffness: 260, damping: 28 }, (v) => el.style.setProperty('--lg-glow', v.toFixed(3)));
  // Apple: the glow starts under the fingertip and spreads through the element.
  const spread = spring(0, { stiffness: 120, dampingRatio: 1, precision: 0.5 }, (v) => el.style.setProperty('--lg-glow-r', `${v.toFixed(1)}px`));
  const tx = spring(0, { stiffness: 380, damping: 22, precision: 0.01 });
  const ty = spring(0, { stiffness: 380, damping: 22, precision: 0.01 });
  const moveTo = () => {
    el.style.translate = `${tx.value.toFixed(2)}px ${ty.value.toFixed(2)}px`;
    g()?.requestSync();
  };
  tx.onUpdate = ty.onUpdate = moveTo;
  let down = false;

  const point = (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--lg-px', `${((e.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty('--lg-py', `${((e.clientY - r.top) / r.height) * 100}%`);
    return r;
  };
  el.addEventListener('pointerdown', (e) => {
    if (el.disabled || e.button > 0) return;
    down = true;
    const r = point(e);
    spread.set(Math.min(r.width, r.height) * 0.3);
    spread.to(Math.max(r.width, r.height) * 1.2);
    s.to(scale);
    glow.to(1);
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    const r = point(e);
    const ox = e.clientX - (r.left + r.width / 2);
    const oy = e.clientY - (r.top + r.height / 2);
    tx.to(Math.tanh(ox / 120) * 120 * lean);
    ty.to(Math.tanh(oy / 120) * 120 * lean);
  });
  const up = () => {
    if (!down) return;
    down = false;
    s.to(1);
    glow.to(0);
    tx.to(0);
    ty.to(0);
  };
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, up);
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      s.to(scale);
      glow.to(0.6);
      setTimeout(() => (s.to(1), glow.to(0)), 120);
    }
  });
}

/* ------------------------------------------------------------------------------------------------
 * Auto-upgrade [data-glass] and press behaviour
 * ---------------------------------------------------------------------------------------------- */

export function upgrade(root = document) {
  const els = root.querySelectorAll ? [...root.querySelectorAll('[data-glass]')] : [];
  if (root.matches?.('[data-glass]')) els.unshift(root);
  for (const el of els) glass(el);
  const press = root.querySelectorAll ? [...root.querySelectorAll('.lg-btn, [data-press]')] : [];
  if (root.matches?.('.lg-btn, [data-press]')) press.unshift(root);
  for (const el of press) pressable(el);
}

function boot() {
  upgrade(document);
  new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes) if (n.nodeType === 1 && !n.closest('.lg-mirror')) upgrade(n);
  }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
