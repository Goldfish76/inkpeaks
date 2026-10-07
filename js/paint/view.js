// Turn a north-up elevation grid into the painter's "view grid": a rectangle of ground seen from
// one side. Row 0 is the near edge, the last row is the far edge, columns run left to right.

import { blur, fbm, percentile } from './util.js';

function bilinear(data, w, h, x, y) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = data[y0 * w + x0], b = data[y0 * w + x1];
  const c = data[y1 * w + x0], d = data[y1 * w + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Catmull-Rom bicubic sampling: smooth slopes when the grid is much finer than the data,
// so coarse elevation cells don't show up as facets and herringbone shading.
function cubic(p0, p1, p2, p3, t) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

function bicubic(data, w, h, x, y) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x1 = Math.floor(x), y1 = Math.floor(y);
  const fx = x - x1, fy = y - y1;
  const a = Math.max(0, x1 - 1), b = x1, c = Math.min(w - 1, x1 + 1), d = Math.min(w - 1, x1 + 2);
  const r0 = Math.max(0, y1 - 1) * w, r1 = y1 * w, r2 = Math.min(h - 1, y1 + 1) * w, r3 = Math.min(h - 1, y1 + 2) * w;
  return cubic(
    cubic(data[r0 + a], data[r0 + b], data[r0 + c], data[r0 + d], fx),
    cubic(data[r1 + a], data[r1 + b], data[r1 + c], data[r1 + d], fx),
    cubic(data[r2 + a], data[r2 + b], data[r2 + c], data[r2 + d], fx),
    cubic(data[r3 + a], data[r3 + b], data[r3 + c], data[r3 + d], fx),
    fy,
  );
}

// Largest ground rectangle (aspect = width/depth) that stays inside the elevation grid
// after rotating it to face `azimuth`.
export function fitExtent(dem, azimuth, aspect) {
  const half = (Math.min(dem.w, dem.h) * dem.mpp) / 2;
  const th = (azimuth * Math.PI) / 180;
  const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
  // Corners at (±W/2, ±D/2) in view space with W = aspect·D must fit in the square of half-size `half`.
  const D = (2 * half) / (aspect * c + s > aspect * s + c ? aspect * c + s : aspect * s + c);
  return { width: aspect * D, depth: D };
}

/**
 * dem: { w, h, data: Float32Array (north-up), mpp }
 * opts: {
 *   azimuth   direction the viewer faces, degrees clockwise from north
 *   zoom      0..1, fraction of the largest fitting rectangle to use
 *   aspect    ground width / ground depth
 *   shift     forward shift of the rectangle centre, as a fraction of its depth (−0.5..0.5)
 *   cols      grid columns
 *   smooth    Gaussian smoothing in grid cells
 *   detail    amplitude of added fine relief, as a fraction of the elevation range
 *   water     water level as a fraction of the elevation range above the low end (0 = none)
 *   seaLevel  absolute level treated as water when the grid contains sea (metres)
 *   seed
 * }
 */
export function makeView(dem, opts) {
  const { azimuth = 0, zoom = 1, aspect = 1, shift = 0, cols = 600, smooth = 0, detail = 0, seed = 1 } = opts;
  const fit = fitExtent(dem, azimuth, aspect);
  const Wm = fit.width * zoom, Dm = fit.depth * zoom;
  const C = Math.max(64, Math.round(cols));
  const R = Math.max(48, Math.round((C * Dm) / Wm));
  const th = (azimuth * Math.PI) / 180;
  const fE = Math.sin(th), fN = Math.cos(th);     // forward (east, north)
  const rE = Math.cos(th), rN = -Math.sin(th);    // right
  const cx = (dem.w - 1) / 2, cy = (dem.h - 1) / 2;
  const inv = 1 / dem.mpp;
  const E = new Float32Array(R * C);
  for (let i = 0; i < R; i++) {
    const u = (i / (R - 1) - 0.5 + shift) * Dm;
    for (let j = 0; j < C; j++) {
      const v = (j / (C - 1) - 0.5) * Wm;
      const east = u * fE + v * rE;
      const north = u * fN + v * rN;
      E[i * C + j] = bicubic(dem.data, dem.w, dem.h, cx + east * inv, cy - north * inv);
    }
  }
  if (smooth > 0.3) blur(E, C, R, smooth);

  let Emin = percentile(E, 1), Emax = percentile(E, 99.8);
  if (Emax - Emin < 1) Emax = Emin + 1;
  if (detail > 0) {
    const n = fbm(C, R, [C / 60, C / 25, C / 10], [0.25, 0.35, 0.4], seed + 7);
    const amp = detail * (Emax - Emin);
    for (let i = 0; i < E.length; i++) E[i] += (n[i] - 0.5) * amp;
  }

  // Water: sea (≤ seaLevel) and, optionally, a flooded valley floor.
  const water = new Uint8Array(R * C);
  let level = -Infinity;
  if (opts.sea) level = opts.seaLevel ?? 0.5;
  if (opts.water > 0) level = Math.max(level, Emin + opts.water * (Emax - Emin));
  let anyWater = false;
  if (level > -Infinity) {
    for (let i = 0; i < E.length; i++) {
      if (E[i] <= level) {
        E[i] = level;
        water[i] = 1;
        anyWater = true;
      }
    }
    if (anyWater) Emin = Math.min(Emin, level);
  }

  // Slopes in metres per metre (dimensionless) along columns (x) and rows (depth).
  const cellW = Wm / (C - 1), cellD = Dm / (R - 1);
  const gx = new Float32Array(R * C), gd = new Float32Array(R * C);
  for (let i = 0; i < R; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(R - 1, i + 1);
    for (let j = 0; j < C; j++) {
      const j0 = Math.max(0, j - 1), j1 = Math.min(C - 1, j + 1);
      gx[i * C + j] = (E[i * C + j1] - E[i * C + j0]) / ((j1 - j0) * cellW);
      gd[i * C + j] = (E[i1 * C + j] - E[i0 * C + j]) / ((i1 - i0) * cellD);
    }
  }
  // Smooth the slopes over about one source cell, so survey noise and coarse cells don't turn
  // into fine stripes in the shading.
  const upsample = dem.mpp / Math.min(cellW, cellD);
  const sg = Math.max(1.2, Math.min(12, 0.7 * upsample));
  blur(gx, C, R, sg);
  blur(gd, C, R, sg);
  return { E, gx, gd, water, anyWater, R, C, Emin, Emax, Wm, Dm, cellW, cellD };
}

// A small hillshade of the elevation grid (north up), for the place picker. Returns RGBA bytes.
export function hillshade(dem, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const s = Math.min(dem.w, dem.h) / size;
  const ox = (dem.w - size * s) / 2, oy = (dem.h - size * s) / 2;
  const z = 2.5 / (dem.mpp * s);
  const lx = -0.6, ly = -0.6, lz = 0.53;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const X = ox + (x + 0.5) * s, Y = oy + (y + 0.5) * s;
      const dzdx = (bilinear(dem.data, dem.w, dem.h, X + s, Y) - bilinear(dem.data, dem.w, dem.h, X - s, Y)) * z / 2;
      const dzdy = (bilinear(dem.data, dem.w, dem.h, X, Y + s) - bilinear(dem.data, dem.w, dem.h, X, Y - s)) * z / 2;
      const nx = -dzdx, ny = -dzdy, nz = 1;
      const l = (nx * lx + ny * ly + nz * lz) / Math.hypot(nx, ny, nz);
      const v = Math.max(0, Math.min(255, 70 + 185 * l));
      const k = (y * size + x) * 4;
      out[k] = v * 0.93 + 18;
      out[k + 1] = v * 0.9 + 16;
      out[k + 2] = v * 0.82 + 14;
      out[k + 3] = 255;
    }
  }
  return out;
}
