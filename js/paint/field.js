// Project the view grid onto the picture and find, for every pixel, which point of the ground
// it shows. This is a "floating horizon" raster: each screen column walks from the near edge to
// the far edge, keeping the highest projected point seen so far; anything below it is hidden.
//
// Alongside the visible depth we keep everything later passes need: elevation, shading, slope,
// water, and the "layered ranges" (层峦) bands. The depth is cut into bands; each band's skyline
// is the top of its mountains in this column, and the wash fades downward from that skyline the
// way a painter layers ridges.

import { clamp, smoothstep, percentile } from './util.js';

/**
 * How high the near ground stands: a low percentile of the elevations in the nearest stretch of
 * the view (the part that reaches the foot of the picture).
 */
export function nearGround(view, persp) {
  const { E, R, C, Emin } = view;
  const frontFrac = 1 / (1 + persp);
  const rows = Math.max(1, Math.round(0.08 * (R - 1)));
  const near = [];
  for (let r = 0; r <= rows; r++) {
    const s = 1 / (1 + persp * (r / (R - 1)));
    const half = ((C - 1) * frontFrac) / (2 * s);
    const c0 = Math.max(0, Math.ceil((C - 1) / 2 - half)), c1 = Math.min(C - 1, Math.floor((C - 1) / 2 + half));
    for (let c = c0; c <= c1; c++) near.push(E[r * C + c]);
  }
  return near.length ? percentile(near, 10) : Emin;
}

/**
 * Scale the relief so the highest point of the picture lands at `targetTop` (fraction of the
 * height from the top). Samples the same projection as rasterize on a coarse set of columns.
 * Returns the adjusted relief (a fraction of the picture height for the full elevation range).
 */
export function fitRelief(view, P, Ws, Hs, targetTop, minRelief = 0.2, maxRelief = 1.6) {
  const { E, R, C, Emin, Emax } = view;
  const base0 = view.Ebase ?? Emin;
  const D = Math.max(96, Math.round(R * 1.5));
  const persp = P.persp;
  const frontFrac = 1 / (1 + persp);
  const range = Math.max(1, Emax - Emin);
  let relief = P.relief;
  for (let iter = 0; iter < 4; iter++) {
    const k = (relief * Hs) / range;
    let best = Infinity, bestH = 0, bestBase = 0;
    for (let X = 0; X < Ws; X += Math.max(1, Ws >> 7)) {
      const off = (X + 0.5 - Ws / 2) * (((C - 1) * frontFrac) / Ws);
      for (let d = 0; d < D; d += 2) {
        const t = d / (D - 1);
        const s = persp > 0 ? 1 / (1 + persp * t) : 1;
        const g = persp > 0 ? (1 - s) / (1 - 1 / (1 + persp)) : t;
        const cc = (C - 1) / 2 + off / s;
        if (cc < 0 || cc > C - 1) continue;
        const e = E[Math.round(t * (R - 1)) * C + Math.round(cc)];
        const base = P.yFront * Hs - P.depthSpan * Hs * g;
        const h = (e - base0) * s / range;  // height term per unit relief
        const y = base - h * relief * Hs;
        if (y < best) {
          best = y;
          bestH = h;
          bestBase = base;
        }
      }
    }
    if (bestH <= 1e-6) break;
    const next = (bestBase - targetTop * Hs) / (bestH * Hs);
    relief = Math.min(maxRelief, Math.max(minRelief, next));
  }
  return relief;
}

/**
 * view: output of makeView (E, gx, gd, water, R, C, Emin, Emax)
 * P: { yFront, depthSpan, relief, persp, bands, fade, lightX, lightY, lightZ, shadeZ }
 */
export function rasterize(view, P, Ws, Hs) {
  const { E, gx, gd, water, R, C, Emin, Emax } = view;
  const D = Math.max(96, Math.round(R * 1.5));
  const t = new Float32Array(D), s = new Float32Array(D), g = new Float32Array(D);
  const persp = P.persp;
  for (let d = 0; d < D; d++) {
    const tt = d / (D - 1);
    t[d] = tt;
    if (persp > 0) {
      const ss = 1 / (1 + persp * tt);
      s[d] = ss;
      g[d] = (1 - ss) / (1 - 1 / (1 + persp));
    } else {
      s[d] = 1;
      g[d] = tt;
    }
  }
  const yF = P.yFront * Hs;
  const span = P.depthSpan * Hs;
  const k = (P.relief * Hs) / Math.max(1, Emax - Emin);
  const base0 = view.Ebase ?? Emin;
  const frontFrac = 1 / (1 + persp);         // share of the grid width visible at the near edge
  const colScale = ((C - 1) * frontFrac) / Ws;
  const cx = Ws / 2;

  const nb = P.bands;
  const bandOf = new Uint8Array(D);
  for (let d = 0; d < D; d++) bandOf[d] = Math.min(nb - 1, Math.floor((d * nb) / D));
  const sb = new Float32Array(nb), cnt = new Float32Array(nb);
  for (let d = 0; d < D; d++) {
    sb[bandOf[d]] += s[d];
    cnt[bandOf[d]]++;
  }
  const fadeLen = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    sb[b] /= Math.max(1, cnt[b]);
    fadeLen[b] = P.fade * Hs * (0.45 + 0.55 * sb[b]);
  }

  // Light, in view space: x to the right, y away from the viewer, z up.
  const ln = Math.hypot(P.lightX, P.lightY, P.lightZ);
  const Lx = P.lightX / ln, Ly = P.lightY / ln, Lz = P.lightZ / ln;
  const nzc = P.shadeZ;

  const N = Ws * Hs;
  const dimg = new Uint16Array(N);
  const elev = new Float32Array(N);
  const shade = new Float32Array(N).fill(0.6); // neutral where there is no ground, for later blurs
  const steep = new Float32Array(N);
  const wash = new Float32Array(N);
  const wat = new Uint8Array(N);
  const sk = new Float32Array(nb * Ws);   // band skylines (screen y), per column
  const Mb = new Float32Array(nb * Ws);   // running min of band skylines, near to far
  const front = new Float32Array(Ws);     // projected y of the near edge; below it is just a skirt

  const ecol = new Float32Array(D), shcol = new Float32Array(D), stcol = new Float32Array(D);
  const wcol = new Uint8Array(D), Mcol = new Float32Array(D), Ycol = new Float32Array(D);
  const U = P.U ?? 1;
  const face0 = 2 * U, face1 = 10 * U;

  for (let X = 0; X < Ws; X++) {
    for (let b = 0; b < nb; b++) sk[b * Ws + X] = Infinity;
    let m = Infinity;
    const off = (X + 0.5 - cx) * colScale;
    for (let d = 0; d < D; d++) {
      const cc = (C - 1) / 2 + off / s[d];
      let y = Infinity;
      if (cc >= 0 && cc <= C - 1) {
        const rr = t[d] * (R - 1);
        const r0 = rr | 0, c0 = cc | 0;
        const r1 = r0 < R - 1 ? r0 + 1 : r0, c1 = c0 < C - 1 ? c0 + 1 : c0;
        const fr = rr - r0, fc = cc - c0;
        const i00 = r0 * C + c0, i01 = r0 * C + c1, i10 = r1 * C + c0, i11 = r1 * C + c1;
        const w00 = (1 - fr) * (1 - fc), w01 = (1 - fr) * fc, w10 = fr * (1 - fc), w11 = fr * fc;
        const e = E[i00] * w00 + E[i01] * w01 + E[i10] * w10 + E[i11] * w11;
        const ax = gx[i00] * w00 + gx[i01] * w01 + gx[i10] * w10 + gx[i11] * w11;
        const ad = gd[i00] * w00 + gd[i01] * w01 + gd[i10] * w10 + gd[i11] * w11;
        ecol[d] = e;
        const nx = -ax, ny = -ad;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nzc * nzc);
        shcol[d] = clamp((nx * Lx + ny * Ly + nzc * Lz) * inv, 0, 1);
        stcol[d] = Math.min(2, Math.sqrt(ax * ax + ad * ad) * 0.8);
        wcol[d] = water[fr < 0.5 ? (fc < 0.5 ? i00 : i01) : (fc < 0.5 ? i10 : i11)];
        y = yF - span * g[d] - (e - base0) * k * s[d];
      }
      Ycol[d] = y;
      if (y < m) m = y;
      Mcol[d] = m;
      if (d === 0) front[X] = y;
      const bi = bandOf[d] * Ws + X;
      if (y < sk[bi]) sk[bi] = y;
    }
    let mb = Infinity;
    for (let b = 0; b < nb; b++) {
      const v = sk[b * Ws + X];
      if (v < mb) mb = v;
      Mb[b * Ws + X] = mb;
    }
    // Walk up the column: the visible depth only ever moves farther away.
    let d = 0;
    for (let y = Hs - 1; y >= 0; y--) {
      const yc = y + 0.5;
      while (d < D && Mcol[d] > yc) d++;
      const p = y * Ws + X;
      dimg[p] = d;
      if (d < D) {
        elev[p] = ecol[d];
        // Far below its ground point the pixel shows a vertical face (a cliff, or the side of a
        // peak): give faces a steady tone so neighbouring columns don't streak.
        const gap = yc - Ycol[d];
        if (gap > face0) {
          const f = smoothstep(face0, face1, gap);
          shade[p] = shcol[d] * (1 - f) + 0.5 * f;
          steep[p] = Math.max(stcol[d], 1.2 * f);
        } else {
          shade[p] = shcol[d];
          steep[p] = stcol[d];
        }
        wat[p] = wcol[d];
        const b = bandOf[d];
        wash[p] = Math.exp(-Math.max(0, yc - sk[b * Ws + X]) / fadeLen[b]);
      }
    }
  }

  // Silhouette edges: a jump in visible depth between neighbouring pixels.
  const thr = 0.012;
  const eTop = new Float32Array(N), eSide = new Float32Array(N);
  const SKY = 2 * D;
  for (let y = 0; y < Hs; y++) {
    for (let x = 0; x < Ws; x++) {
      const p = y * Ws + x;
      const d = dimg[p];
      if (d >= D) continue;
      const up = y > 0 ? (dimg[p - Ws] >= D ? SKY : dimg[p - Ws]) : SKY;
      eTop[p] = smoothstep(thr, thr * 6, (up - d) / D);
      const l = x > 0 ? (dimg[p - 1] >= D ? SKY : dimg[p - 1]) : SKY;
      const r = x < Ws - 1 ? (dimg[p + 1] >= D ? SKY : dimg[p + 1]) : SKY;
      eSide[p] = 0.6 * smoothstep(thr * 2, thr * 10, Math.max(l - d, r - d) / D);
    }
  }

  return { D, t, s, nb, bandOf, sb, fadeLen, dimg, elev, shade, steep, wash, wat, sk, Mb, front, eTop, eSide, Emin, Emax, Ws, Hs };
}
