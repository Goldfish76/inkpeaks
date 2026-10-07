// Small numeric helpers shared by the painter: a seeded RNG, value-noise fields and fast blurs.
// Everything works on flat Float32Arrays (row-major, width w) so it runs the same in a worker.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal from a uniform RNG (Box-Muller).
export function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// One octave of value noise: random values on a grid every `cell` pixels (cellY may differ, for
// stretched noise such as cloud bands), smoothly interpolated.
function valueNoise(w, h, cell, rng, out, weight, cellY = cell) {
  const gw = Math.ceil(w / cell) + 3;
  const gh = Math.ceil(h / cellY) + 3;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const inv = 1 / cell, invY = 1 / cellY;
  const sxs = new Float32Array(w);
  const ixs = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = x * inv;
    const ix = Math.floor(fx);
    const tx = fx - ix;
    ixs[x] = ix + 1;
    sxs[x] = tx * tx * (3 - 2 * tx);
  }
  for (let y = 0; y < h; y++) {
    const fy = y * invY;
    const iy = Math.floor(fy);
    const ty = fy - iy;
    const sy = ty * ty * (3 - 2 * ty);
    const r0 = (iy + 1) * gw;
    const r1 = r0 + gw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const ix = ixs[x];
      const sx = sxs[x];
      const a = g[r0 + ix], b = g[r0 + ix + 1], c = g[r1 + ix], d = g[r1 + ix + 1];
      out[row + x] += weight * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
    }
  }
}

// Fractal value noise normalised to [0, 1]. `scales` are cell sizes in pixels.
export function fbm(w, h, scales, weights, seed, stretchX = 1) {
  const rng = mulberry32(seed);
  const out = new Float32Array(w * h);
  for (let i = 0; i < scales.length; i++) {
    const c = Math.max(1.5, scales[i]);
    valueNoise(w, h, c * stretchX, rng, out, weights[i], c);
  }
  normalise(out);
  return out;
}

export function normalise(a) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
  return a;
}

// Gaussian blur approximated by three box blurs (separable, O(n) per pass).
function boxSizes(sigma) {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function boxH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const fv = src[row];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[row + Math.min(j, w - 1)];
    for (let x = 0; x < w; x++) {
      const add = src[row + Math.min(x + r, w - 1)];
      const sub = x - r - 1 >= 0 ? src[row + x - r - 1] : fv;
      val += add - sub;
      dst[row + x] = val * iarr;
    }
  }
}

function boxV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    const fv = src[x];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[Math.min(j, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      const add = src[Math.min(y + r, h - 1) * w + x];
      const sub = y - r - 1 >= 0 ? src[(y - r - 1) * w + x] : fv;
      val += add - sub;
      dst[y * w + x] = val * iarr;
    }
  }
}

// In-place Gaussian blur of a w×h Float32Array. sigmaY defaults to sigmaX.
export function blur(a, w, h, sigmaX, sigmaY = sigmaX) {
  if (sigmaX < 0.3 && sigmaY < 0.3) return a;
  const tmp = new Float32Array(a.length);
  if (sigmaX >= 0.3) {
    for (const b of boxSizes(sigmaX)) {
      boxH(a, tmp, w, h, (b - 1) >> 1);
      a.set(tmp);
    }
  }
  if (sigmaY >= 0.3) {
    for (const b of boxSizes(sigmaY)) {
      boxV(a, tmp, w, h, (b - 1) >> 1);
      a.set(tmp);
    }
  }
  return a;
}

// Grey dilation (running max) with a rectangular window of half-sizes rx, ry.
export function dilate(a, w, h, rx, ry) {
  const tmp = new Float32Array(a.length);
  if (rx > 0) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let m = a[row + x];
        const x0 = Math.max(0, x - rx), x1 = Math.min(w - 1, x + rx);
        for (let k = x0; k <= x1; k++) if (a[row + k] > m) m = a[row + k];
        tmp[row + x] = m;
      }
    }
    a.set(tmp);
  }
  if (ry > 0) {
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let m = a[y * w + x];
        const y0 = Math.max(0, y - ry), y1 = Math.min(h - 1, y + ry);
        for (let k = y0; k <= y1; k++) if (a[k * w + x] > m) m = a[k * w + x];
        tmp[y * w + x] = m;
      }
    }
    a.set(tmp);
  }
  return a;
}

// Linear-interpolated percentile of a typed array (copies and sorts a subsample).
export function percentile(a, p, maxSamples = 200000) {
  const step = Math.max(1, Math.floor(a.length / maxSamples));
  const s = new Float32Array(Math.ceil(a.length / step));
  let n = 0;
  for (let i = 0; i < a.length; i += step) s[n++] = a[i];
  const v = s.subarray(0, n).sort();
  const pos = (p / 100) * (n - 1);
  const i0 = Math.floor(pos), i1 = Math.min(n - 1, i0 + 1);
  return v[i0] + (v[i1] - v[i0]) * (pos - i0);
}
