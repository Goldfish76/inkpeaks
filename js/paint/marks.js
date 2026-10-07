// Brush marks drawn with Canvas 2D: texture strokes (皴), ridge lines along the layered skylines,
// moss dots (苔点), pines and water ripples. Marks are drawn white-on-black into separate colour
// channels of one canvas with the "lighten" blend, so a single read-back gives three layers:
//   R = texture strokes, G = ridge lines, B = accents (dots, pines, ripples).
// Strokes of similar intensity are batched into one Path2D, which keeps tens of thousands of
// strokes fast.

import { gauss, clamp } from './util.js';

const BUCKETS = 12;

// A tapered brush stroke along a polyline, as a closed outline. half(i) = half-width at point i.
function ribbon(path, pts, half) {
  const n = pts.length / 2;
  if (n < 2) return;
  const lx = new Float32Array(n), ly = new Float32Array(n), rx = new Float32Array(n), ry = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let dx = pts[2 * b] - pts[2 * a], dy = pts[2 * b + 1] - pts[2 * a + 1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const w = half(i);
    lx[i] = pts[2 * i] - dy * w;
    ly[i] = pts[2 * i + 1] + dx * w;
    rx[i] = pts[2 * i] + dy * w;
    ry[i] = pts[2 * i + 1] - dx * w;
  }
  path.moveTo(lx[0], ly[0]);
  for (let i = 1; i < n; i++) path.lineTo(lx[i], ly[i]);
  for (let i = n - 1; i >= 0; i--) path.lineTo(rx[i], ry[i]);
  path.closePath();
}

function flush(ctx, buckets, channel) {
  for (let b = 0; b < buckets.length; b++) {
    if (!buckets[b].used) continue;
    const v = Math.round(((b + 0.5) / buckets.length) * 255);
    ctx.fillStyle = channel === 0 ? `rgb(${v},0,0)` : channel === 1 ? `rgb(0,${v},0)` : `rgb(0,0,${v})`;
    ctx.fill(buckets[b].path);
  }
}

function newBuckets() {
  return Array.from({ length: BUCKETS }, () => ({ path: new Path2D(), used: false }));
}

function bucketFor(buckets, v255) {
  const b = buckets[clamp(Math.floor((v255 / 256) * BUCKETS), 0, BUCKETS - 1)];
  b.used = true;
  return b.path;
}

/**
 * Texture strokes following the fall line of the visible slope.
 * mask: probability of a stroke starting at a pixel; flowE: smoothed elevation for the flow
 * direction; scaleAt: perspective scale per pixel.
 */
export function drawStrokes(ctx, Ws, Hs, mask, flowE, scaleAt, rng, U, density) {
  const buckets = newBuckets();
  const nTry = Math.round(((Ws * Hs) / 15) * density);
  const nstep = 8;
  const pts = new Float32Array((nstep + 1) * 2);
  for (let n = 0; n < nTry; n++) {
    const x0 = (rng() * Ws) | 0, y0 = (rng() * Hs) | 0;
    const p0 = y0 * Ws + x0;
    const m = mask[p0];
    if (m <= 0 || rng() >= m) continue;
    const sc = scaleAt[p0];
    const L = (19.8 + 39.6 * rng()) * (0.45 + 0.55 * sc) * U;
    const step = L / nstep;
    const wob = gauss(rng) * 0.1;
    const ca = Math.cos(wob), sa = Math.sin(wob);
    let x = x0 + 0.5, y = y0 + 0.5;
    pts[0] = x;
    pts[1] = y;
    for (let i = 0; i < nstep; i++) {
      const xi = clamp(x | 0, 1, Ws - 2), yi = clamp(y | 0, 1, Hs - 2);
      const q = yi * Ws + xi;
      let vx = -(flowE[q + 1] - flowE[q - 1]);
      let vy = -(flowE[q + Ws] - flowE[q - Ws]);
      const mag = Math.hypot(vx, vy) + 1e-6;
      vx /= mag;
      vy = Math.max(vy / mag, 0.4);
      const m2 = Math.hypot(vx, vy);
      vx /= m2;
      vy /= m2;
      x += (vx * ca - vy * sa) * step;
      y += (vx * sa + vy * ca) * step;
      pts[2 * i + 2] = x;
      pts[2 * i + 3] = y;
    }
    const v = 70 + 130 * Math.min(1, m * 1.8);
    const w0 = (0.9 + 1.44 * rng()) * U;
    ribbon(bucketFor(buckets, v), pts, i => 0.5 * w0 * (0.5 + 0.8 * Math.sin(Math.PI * Math.min(1, i / nstep + 0.1))));
  }
  flush(ctx, buckets, 0);
}

/**
 * Brush lines along each band's skyline where it is not hidden by nearer bands.
 * gate (0..1) marks real silhouettes, so smooth slopes don't get contour-like terraces.
 */
export function drawRidgeLines(ctx, F, gate, rng, U, weight) {
  const { sk, Mb, nb, sb, Ws } = F;
  const step = Math.max(1, Math.round(U));
  for (let b = 0; b < nb; b++) {
    const buckets = newBuckets();
    const wb = (0.9 + 2.8 * sb[b] * sb[b]) * U * (b < nb * 0.5 ? 1 : 0.7) * weight;
    const v = 255 * (0.3 + 0.7 * Math.exp((-1.8 * b) / nb));
    const path = bucketFor(buckets, v);
    const visible = x => {
      const y = sk[b * Ws + x];
      if (!(y < 1e8)) return false;
      const prev = b > 0 ? Mb[(b - 1) * Ws + x] : Infinity;
      return y < prev - 1;
    };
    const gateAt = x => {
      const y = clamp(Math.round(sk[b * Ws + x]), 0, F.Hs - 1);
      return gate[y * Ws + x];
    };
    let x = 0;
    const phase = rng() * 10;
    while (x < Ws) {
      if (!visible(x) || gateAt(x) < 0.05) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < Ws && visible(x) && gateAt(x) >= 0.05) x++;
      if (x - x0 < 4 * step) continue;
      const xs = [];
      for (let xx = x0; xx < x; xx += step) xs.push(xx);
      if (xs[xs.length - 1] !== x - 1) xs.push(x - 1);
      const pts = new Float32Array(xs.length * 2);
      const gs = new Float32Array(xs.length);
      for (let i = 0; i < xs.length; i++) {
        pts[2 * i] = xs[i] + 0.5;
        pts[2 * i + 1] = sk[b * Ws + xs[i]];
        gs[i] = gateAt(xs[i]);
      }
      const n = xs.length;
      ribbon(path, pts, i => {
        const f = i / Math.max(1, n - 1);
        const press = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, 0.05 + f * 0.95));
        const wav = 0.75 + 0.5 * Math.abs(Math.sin(i * 0.05 * step + b + phase));
        return 0.5 * wb * press * wav * (0.5 + 0.5 * gs[i]);
      });
    }
    flush(ctx, buckets, 1);
  }
}

// Moss dots (苔点): small clusters on near crests.
export function drawDots(ctx, F, edge, fog, rng, U, amount) {
  const { Ws, Hs, dimg, t, s, D } = F;
  const buckets = newBuckets();
  const prob = (0.02 / (U * U)) * amount;
  for (let p = 0; p < Ws * Hs; p++) {
    if (edge[p] <= 0.6 || fog[p] > 0.5) continue;
    const d = dimg[p];
    if (d >= D || t[d] >= 0.55) continue;
    if (rng() >= prob) continue;
    const x = p % Ws, y = (p / Ws) | 0;
    const k = 1 + ((rng() * 3) | 0);
    for (let i = 0; i < k; i++) {
      const ox = gauss(rng) * 2.8 * U, oy = (gauss(rng) - 0.5) * 1.4 * U;
      const rw = (1.1 + 1.55 * rng()) * U * (0.6 + 0.4 * s[d]);
      const rh = rw * (0.6 + 0.3 * rng());
      const path = bucketFor(buckets, 200 + 55 * rng());
      path.moveTo(x + ox + rw, y + oy);
      path.ellipse(x + ox, y + oy, rw, rh, rng() * 0.6 - 0.3, 0, Math.PI * 2);
    }
  }
  flush(ctx, buckets, 2);
}

// Pines (点景) standing on the highest near crests.
export function drawPines(ctx, F, eTop, vis, rng, U, count) {
  const { Ws, Hs, dimg, t, s, D } = F;
  if (count <= 0) return [];
  const cand = [];
  for (let p = 0; p < Ws * Hs; p++) {
    if (eTop[p] <= 0.8 || vis[p] <= 0.9) continue;
    const d = dimg[p];
    if (d >= D || t[d] >= 0.4) continue;
    cand.push(p);
  }
  if (!cand.length) return [];
  cand.sort((a, b) => a - b); // smaller index = higher on the page
  const top = cand.slice(0, Math.max(50, (cand.length / 6) | 0));
  for (let i = top.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [top[i], top[j]] = [top[j], top[i]];
  }
  const placed = [];
  const buckets = newBuckets();
  for (const p of top) {
    if (placed.length >= count) break;
    const x = p % Ws, y = (p / Ws) | 0;
    if (placed.some(([px, py]) => Math.abs(x - px) < 0.05 * Ws && Math.abs(y - py) < 0.05 * Hs)) continue;
    placed.push([x, y]);
    const sc = U * (0.6 + 0.4 * s[dimg[p]]) * (0.8 + 0.5 * rng());
    const h = 17 * sc;
    const lean = gauss(rng) * 4 * sc;
    const trunk = new Float32Array(16);
    for (let i = 0; i < 8; i++) {
      const tt = i / 7;
      trunk[2 * i] = x + lean * tt ** 1.5 + Math.sin(tt * 5) * 0.75 * sc;
      trunk[2 * i + 1] = y - h * tt;
    }
    ribbon(bucketFor(buckets, 215), trunk, i => 0.5 * (1.6 - 1.1 * (i / 7)) * sc);
    [0.55, 0.75, 0.92].forEach((tt, j) => {
      const cx = x + lean * tt ** 1.5, cy = y - h * tt;
      const side = j % 2 === 0 ? 1 : -1;
      const bw = (6.5 - 1.5 * j) * sc;
      const nNeedle = Math.round(13 * sc);
      for (let k = 0; k < nNeedle; k++) {
        const ox = side * bw * 0.35 + gauss(rng) * bw * 0.45;
        const oy = gauss(rng) * 0.8 * sc;
        const seg = new Float32Array([cx + ox - 1.1 * sc, cy + oy, cx + ox + 1.1 * sc, cy + oy + gauss(rng) * 0.3]);
        ribbon(bucketFor(buckets, 190 + 60 * rng()), seg, () => 0.35 * sc);
      }
    });
  }
  flush(ctx, buckets, 2);
  return placed;
}

// Water ripples (水纹): sparse short horizontal strokes on visible water.
export function drawRipples(ctx, F, rng, U, amount) {
  const { Ws, Hs, dimg, t, s, D, wat } = F;
  const buckets = newBuckets();
  const prob = (0.0007 / (U * U)) * amount;
  for (let p = 0; p < Ws * Hs; p++) {
    if (!wat[p]) continue;
    const d = dimg[p];
    if (d >= D || t[d] > 0.8) continue;
    if (rng() >= prob) continue;
    const x = p % Ws, y = (p / Ws) | 0;
    const sc = U * (0.5 + 0.5 * s[d]);
    const L = (10 + 26 * rng()) * sc;
    const n = 6;
    const pts = new Float32Array(n * 2);
    const bend = gauss(rng) * 0.8 * sc;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      pts[2 * i] = x + (f - 0.5) * L;
      pts[2 * i + 1] = y + Math.sin(f * Math.PI) * bend;
    }
    ribbon(bucketFor(buckets, 110 + 70 * rng() * (1 - t[d])), pts, i => 0.5 * (0.5 + 0.7 * Math.sin((Math.PI * i) / (n - 1))) * sc);
  }
  flush(ctx, buckets, 2);
}
