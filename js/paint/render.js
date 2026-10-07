// The painter: elevation grid in, finished painting (without inscription) out.
// Pure computation plus Canvas 2D for brush marks, so it runs in a worker (OffscreenCanvas) or
// on the main thread. Sizes are in output pixels; U is the brush scale (1 at 1200×2000).

import { makeView } from './view.js';
import { rasterize, fitRelief, nearGround } from './field.js';
import { fbm, blur, dilate, smoothstep, mulberry32, clamp } from './util.js';
import { drawStrokes, drawRidgeLines, drawDots, drawPines, drawRipples } from './marks.js';
import { STYLES, mix } from './styles.js';

// The "three distances" (三远) of Guo Xi's Linquan Gaozhi, as camera and wash presets.
//   高远 high distance: looking up at the peak from its foot.
//   深远 deep distance: looking past the front ridge into layered valleys.
//   平远 level distance: from a near hill across to far, low ranges and water.
export const COMPOSITIONS = {
  gaoyuan: { yFront: 0.97, depthSpan: 0.16, relief: 0.82, topMargin: 0.1, persp: 0.4, bands: 11, fade: 0.09, cloud: 0.24, cloudSoft: 0.12, cloudBands: 0.6, bottomMist: 0.24, atm: 1.3, groundAspect: 1.0, shift: -0.12, pines: 5 },
  shenyuan: { yFront: 0.97, depthSpan: 0.28, relief: 0.72, topMargin: 0.13, persp: 0.75, bands: 15, fade: 0.075, cloud: 0.28, cloudSoft: 0.12, cloudBands: 1, bottomMist: 0.22, atm: 1.7, groundAspect: 1.15, shift: 0, pines: 5 },
  pingyuan: { yFront: 0.95, depthSpan: 0.3, relief: 0.34, topMargin: 0.3, persp: 0.6, bands: 12, fade: 0.08, cloud: 0.22, cloudSoft: 0.12, cloudBands: 0.8, bottomMist: 0.2, atm: 1.5, groundAspect: 1.7, shift: 0.05, pines: 3 },
};

// Highest the near ground may stand above the base line, as a fraction of the picture height.
const MAX_FLOAT = 0.22;

const tiles = new Map();

// Tileable paper fibres: a multiplier around 1, slightly darker along fibres.
function fiberTile(T, seed, makeCanvas) {
  const key = `${T}:${seed}`;
  if (tiles.has(key)) return tiles.get(key);
  const c = makeCanvas(T, T);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, T, T);
  ctx.strokeStyle = '#fff';
  const rng = mulberry32(seed);
  const n = Math.round((T * T) / 2250);
  for (let i = 0; i < n; i++) {
    const x = rng() * T, y = rng() * T, a = rng() * Math.PI, L = 3 + rng() * 15;
    ctx.globalAlpha = (20 + 30 * rng()) / 255;
    ctx.lineWidth = 0.5 + rng() * 0.5;
    for (const ox of [-T, 0, T]) {
      for (const oy of [-T, 0, T]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + L * Math.cos(a), y + oy + L * Math.sin(a));
        ctx.stroke();
      }
    }
  }
  const d = ctx.getImageData(0, 0, T, T).data;
  const f = new Float32Array(T * T);
  for (let i = 0; i < T * T; i++) f[i] = 1 - 0.07 * (d[4 * i] / 255);
  const tile = { T, f };
  tiles.set(key, tile);
  return tile;
}

/**
 * dem: { w, h, data, mpp, sea }
 * o: {
 *   width, height, style ('ink'|'qinglu'|'qianjiang'|'snow'), composition ('gaoyuan'|'shenyuan'|'pingyuan'),
 *   azimuth, zoom (0..1), shift, relief (multiplier), mist (−0.3..0.3), water (0..0.3),
 *   texture (multiplier), detail (0..0.03), smooth (cells), pines, seed
 * }
 * Returns { width, height, data: Uint8ClampedArray (RGBA), topY: Float32Array, paper: [r,g,b] }.
 */
export function paint(dem, o, makeCanvas, onStage = () => {}) {
  const Ws = Math.round(o.width), Hs = Math.round(o.height);
  const N = Ws * Hs;
  const U = Math.sqrt(N / (1200 * 2000));
  const comp = COMPOSITIONS[o.composition] || COMPOSITIONS.shenyuan;
  const seed = (o.seed ?? 1) | 0;
  // Per-place presets may fine-tune the composition directly.
  const P = {
    yFront: o.yFront ?? comp.yFront,
    depthSpan: o.depthSpan ?? comp.depthSpan,
    relief: comp.relief * (o.relief ?? 1),
    persp: o.persp ?? comp.persp,
    bands: o.bands ?? comp.bands,
    fade: comp.fade,
    lightX: -1, lightY: -0.6, lightZ: 1.2, shadeZ: 1.4,
    U: Math.sqrt(N / (1200 * 2000)),
  };

  // Wider pictures look across a wider strip of ground.
  const imgAspect = Ws / Hs;
  const groundAspect = comp.groundAspect * Math.pow(clamp(imgAspect / 0.6, 0.8, 4.5), 0.6);
  const cols = clamp(Math.round(Ws * (1 + P.persp) * 0.55), 300, 1400);
  onStage('view');
  const view = makeView(dem, {
    azimuth: o.azimuth ?? 0,
    zoom: o.zoom ?? 0.9,
    aspect: groundAspect,
    shift: (o.shift ?? 0) + comp.shift,
    cols,
    smooth: o.smooth ?? 0,
    detail: o.detail ?? 0.004,
    water: o.water ?? 0,
    sea: dem.sea,
    seed,
  });

  // Frame the mountain: the highest point sits a set distance below the top edge, whatever the
  // elevation range of the place. Painters stretch mountains upward, but low islands must not
  // become needles, so the vertical exaggeration is capped relative to the horizontal scale at the
  // near edge. The relief control then scales the result.
  const range = Math.max(1, view.Emax - view.Emin);
  const hScale = Ws / (view.Wm / (1 + P.persp));        // px per metre across, at the near edge
  const maxRelief = ((o.maxExaggeration ?? 6) * hScale * range) / Hs;
  const target = (o.topMargin ?? comp.topMargin) * (Hs > Ws ? 1 : 1.4);
  const frame = () => {
    const fit = o.autoFrame !== false ? fitRelief(view, { ...P, relief: comp.relief }, Ws, Hs, target) : comp.relief;
    return Math.min(fit, maxRelief) * (o.relief ?? 1);
  };
  // Heights are measured from the low end of the view, which stands on the base line near the foot
  // of the picture. When the near ground is far above it (standing on a glacier, looking across to
  // a deep valley) the foreground would float up the page and leave the foot empty, so the base
  // line rises with the near ground until it floats no more than MAX_FLOAT of the picture height.
  view.Ebase = view.Emin;
  P.relief = frame();
  const near = nearGround(view, P.persp);
  for (let i = 0; i < 6 && ((near - view.Ebase) / range) * P.relief > MAX_FLOAT * 1.02; i++) {
    view.Ebase = near - (MAX_FLOAT * range) / P.relief;
    P.relief = frame();
  }

  onStage('raster');
  const F = rasterize(view, P, Ws, Hs);
  const { D, t, s, nb, bandOf, fadeLen, sk, Mb, dimg, elev, shade, steep, wash, wat, eTop, eSide, Emin, Emax, front } = F;
  const rng = mulberry32(seed * 7919 + 13);

  // Real silhouettes (a jump in depth) gate the ridge lines and decide where washes restart.
  const gate = Float32Array.from(eTop);
  dilate(gate, Ws, Hs, 1, Math.max(1, Math.round(2.5 * U)));
  for (let p = 0; p < N; p++) gate[p] = smoothstep(0.08, 0.45, gate[p]);

  // Band wash: dark at a ridge and fading down. Each visible band skyline is weighted by how much
  // of a real silhouette it is, smoothed along the ridge. A pixel takes its own band's wash in
  // proportion to that strength and lets the rest through to the wash of the ridges behind and
  // above it, each again in proportion to its strength. A band edge that is just a smooth slope
  // carrying on passes the wash of the true ridge above; a real silhouette starts a new layer
  // (层峦). Everything is a smooth blend along x, so there are no terraces and no column streaks.
  {
    const str = new Float32Array(nb * Ws);
    for (let b = 0; b < nb; b++) {
      for (let X = 0; X < Ws; X++) {
        const y = sk[b * Ws + X];
        const prev = b > 0 ? Mb[(b - 1) * Ws + X] : Infinity;
        if (y < 1e8 && y < prev - 1) str[b * Ws + X] = gate[clamp(Math.round(y), 0, Hs - 1) * Ws + X];
      }
    }
    blur(str, Ws, nb, 10 * U, 0);
    // Washes hang from a smoothed skyline: a jagged crest would otherwise drag a dark streak
    // down from every spike.
    const skS = new Float32Array(nb * Ws), wv = new Float32Array(nb * Ws);
    for (let i = 0; i < nb * Ws; i++) {
      if (sk[i] < 1e8) {
        skS[i] = sk[i];
        wv[i] = 1;
      }
    }
    blur(skS, Ws, nb, 4 * U, 0);
    blur(wv, Ws, nb, 4 * U, 0);
    for (let i = 0; i < nb * Ws; i++) skS[i] = wv[i] > 0.05 ? skS[i] / wv[i] : Infinity;
    for (let y = 0; y < Hs; y++) {
      const yc = y + 0.5;
      for (let X = 0; X < Ws; X++) {
        const p = y * Ws + X;
        const d = dimg[p];
        if (d >= D) continue;
        const b0 = bandOf[d];
        let w = 0, T = 1;
        for (let b = b0; b < nb; b++) {
          const i = b * Ws + X;
          const top = skS[i];
          if (!(top < 1e8)) continue;
          if (top > yc + 2) continue;            // a ridge below this pixel is hidden behind it
          let st = str[i];
          if (b === b0 && st < 0.15) st = 0.15;
          if (st < 0.003) continue;
          w += T * st * Math.exp(-Math.max(0, yc - top) / fadeLen[b]);
          T *= 1 - st;
          if (T < 0.02) break;
        }
        wash[p] = Math.min(1, w);
      }
    }
  }
  // Neighbouring columns can pick their skyline or cliff top from different depths; soften the
  // vertical seams this leaves in the washes and shading.
  blur(wash, Ws, Hs, 2 * U, 1 * U);
  blur(shade, Ws, Hs, 1.5 * U, 0);
  blur(steep, Ws, Hs, 1.5 * U, 0);

  // Mist: a cloud sea that swallows low ground (留白), drifting cloud bands across the middle
  // distance, and soft margins at the sides and foot.
  onStage('mist');
  const nzFog = fbm(Ws, Hs, [0.075 * Hs, 0.0275 * Hs, 0.01 * Hs], [0.5, 0.33, 0.17], seed + 11);
  const nzFrame = fbm(Ws, Hs, [0.05 * Hs, 0.015 * Hs], [0.7, 0.3], seed + 13);
  const nzBand = fbm(Ws, Hs, [0.09 * Hs, 0.035 * Hs, 0.012 * Hs], [0.55, 0.3, 0.15], seed + 17, 1.8);
  const bands = (o.clouds ?? 1) * comp.cloudBands;
  const fog = new Float32Array(N), vis = new Float32Array(N), atm = new Float32Array(N);
  const cloud = comp.cloud + (o.mist ?? 0);
  const yb = P.yFront * Hs;
  for (let y = 0; y < Hs; y++) {
    for (let x = 0; x < Ws; x++) {
      const p = y * Ws + x;
      const d = dimg[p];
      let f;
      if (d >= D) f = 1;
      else {
        const hrel = (elev[p] - Emin) / range;
        const cl = cloud + (nzFog[p] - 0.5) * 0.22 + t[d] * 0.1;
        f = 1 - smoothstep(cl - comp.cloudSoft, cl + comp.cloudSoft * 0.6, hrel);
        if (bands > 0) {
          // Clouds settle in the valleys between ridges of the middle distance.
          const cb = bands * smoothstep(0.55, 0.85, nzBand[p]) * smoothstep(0.12, 0.4, t[d]) * smoothstep(0.45, 0.08, wash[p]);
          if (cb > f) f = cb;
        }
        atm[p] = Math.exp(-comp.atm * t[d]);
      }
      const side = Math.min(x, Ws - 1 - x) / Ws;
      let fr = 1 - smoothstep(0, 0.07 + 0.05 * nzFrame[p], side);
      const fb = smoothstep(yb - comp.bottomMist * Hs - 0.06 * Hs * nzFrame[p], yb - 0.02 * Hs, y);
      if (fb > fr) fr = fb;
      if (fr > f) f = fr;
      if (d < D && wat[p]) f = 1;
      // Below the near edge there is no ground, only the skirt of the raster: fade it to mist.
      if (d === 0) {
        const sf = smoothstep(front[x], front[x] + 0.05 * Hs, y);
        if (sf > f) f = sf;
      }
      fog[p] = f;
    }
  }
  // Soften the mist's edges (value noise alone leaves blocky blobs), then derive visibility.
  blur(fog, Ws, Hs, 1.6 * U);
  for (let p = 0; p < N; p++) vis[p] = dimg[p] >= D ? 0 : 1 - fog[p];

  // Tone: dark at each ridge and fading down (the band wash), deepened in shadow and on steep rock.
  onStage('tone');
  const tone = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const v = vis[p];
    if (v <= 0) continue;
    const sh = Math.pow(1 - shade[p], 1.4);
    const w = wash[p];
    tone[p] = (0.5 * w + 0.3 * sh * (0.45 + 0.55 * w) + 0.12 * steep[p] * (0.3 + 0.7 * w)) * atm[p] * v;
  }
  {
    const big = Float32Array.from(tone);
    blur(big, Ws, Hs, 6 * U);
    for (let p = 0; p < N; p++) tone[p] = Math.min(1, tone[p] + 0.35 * Math.max(0, tone[p] - big[p]));
    blur(tone, Ws, Hs, 0.8 * U);
  }

  // Where texture strokes may start: shadowed, steep, near a ridge, not in mist.
  const texture = o.texture ?? 1;
  const smask = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const v = vis[p];
    const w = wash[p];
    if (v <= 0 || w <= 0.03) continue;
    const sh = Math.pow(1 - shade[p], 1.4);
    const m = clamp((sh * 0.9 + steep[p] * 0.3) * (0.5 + 0.5 * w) * atm[p] * v, 0, 1);
    smask[p] = Math.pow(m, 1.6) * 0.45 * texture;
  }
  const flowE = new Float32Array(N), scaleAt = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const d = dimg[p];
    flowE[p] = d >= D ? Emax : elev[p];
    scaleAt[p] = d >= D ? 1 : s[d];
  }
  blur(flowE, Ws, Hs, 2.7 * U);

  const edgeAll = new Float32Array(N);
  for (let p = 0; p < N; p++) edgeAll[p] = Math.max(eTop[p], eSide[p]);

  onStage('brush');
  const mc = makeCanvas(Ws, Hs);
  const ctx = mc.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, Ws, Hs);
  ctx.globalCompositeOperation = 'lighten';
  drawStrokes(ctx, Ws, Hs, smask, flowE, scaleAt, rng, U, 1);
  drawRidgeLines(ctx, F, gate, rng, U, 1);
  drawDots(ctx, F, edgeAll, fog, rng, U, 1);
  drawPines(ctx, F, eTop, vis, rng, U, o.pines ?? comp.pines);
  if (view.anyWater) drawRipples(ctx, F, rng, U, 1);
  const md = ctx.getImageData(0, 0, Ws, Hs).data;

  // Silhouette lines: thin everywhere, thicker on near, strong edges; broken by dry brush.
  onStage('line');
  const fiber = fbm(Ws, Hs, [30 * U, 7 * U, 2 * U], [0.4, 0.35, 0.25], seed + 21);
  const line = new Float32Array(N), thick = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const d = dimg[p];
    if (d >= D) continue;
    const e = edgeAll[p];
    if (e <= 0) continue;
    const dry = smoothstep(0.25, 0.55, fiber[p]);
    const a = atm[p];
    const v = e * (0.3 + 0.7 * a) * (0.45 + 0.55 * dry) * Math.pow(1 - fog[p], 1.5);
    line[p] = v;
    if (a > 0.55 && e > 0.5) thick[p] = v;
  }
  const rThin = Math.round(0.5 * U);
  if (rThin > 0) dilate(line, Ws, Hs, rThin, rThin);
  dilate(thick, Ws, Hs, Math.max(1, Math.round(1.5 * U)), Math.max(1, Math.round(1.25 * U)));
  for (let p = 0; p < N; p++) {
    const dry = smoothstep(0.25, 0.55, fiber[p]);
    line[p] = Math.max(line[p], thick[p] * (0.6 + 0.4 * dry));
  }
  blur(line, Ws, Hs, 0.7 * U);
  const visSoft = Float32Array.from(vis);
  blur(visSoft, Ws, Hs, 1 * U);

  // Pigment coverage for the coloured styles.
  const style = STYLES[o.style] ? o.style : 'ink';
  const S = STYLES[style];
  let cov = null;
  if (style === 'qinglu' || style === 'qianjiang') {
    cov = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const v = vis[p];
      if (v <= 0) continue;
      if (style === 'qinglu') {
        const u = Math.min(1, Math.max(0, -Math.log(wash[p] + 1e-4) / 1.6));
        cov[p] = clamp((1 - u * 0.75) * v * (0.35 + 0.65 * atm[p]) * (0.75 + 0.25 * shade[p]), 0, 1);
      } else {
        cov[p] = v * (0.5 + 0.5 * atm[p]);
      }
    }
    blur(cov, Ws, Hs, 1.2 * U);
    for (let p = 0; p < N; p++) cov[p] = Math.min(0.92, cov[p] * (0.85 + 0.3 * fiber[p]));
  }

  // Developer aid: return one intermediate field as a grey image.
  if (o.debug) {
    const fields = { wash, fog, vis, tone, shade, steep, line, gate, atm, smask };
    let f = fields[o.debug];
    if (o.debug === 'band') f = Float32Array.from(dimg, d => (d >= D ? 1 : F.bandOf[d] / nb));
    if (o.debug === 'depth') f = Float32Array.from(dimg, d => (d >= D ? 1 : t[d]));
    if (o.debug === 'strokes') f = Float32Array.from({ length: N }, (_, p) => md[4 * p] / 255);
    if (o.debug === 'ridges') f = Float32Array.from({ length: N }, (_, p) => md[4 * p + 1] / 255);
    const img = new Uint8ClampedArray(N * 4);
    for (let p = 0; p < N; p++) {
      const v = 255 * (1 - clamp(f[p], 0, 1));
      img[4 * p] = img[4 * p + 1] = img[4 * p + 2] = v;
      img[4 * p + 3] = 255;
    }
    return { width: Ws, height: Hs, data: img, topY: new Float32Array(Ws), paper: [255, 255, 255] };
  }

  // Paper and final mix.
  onStage('paper');
  const nPaper = fbm(Ws, Hs, [0.2 * Hs, 0.06 * Hs, 15 * U, 3 * U], [0.45, 0.3, 0.15, 0.1], seed + 3);
  const T = clamp(Math.round(512 * U), 256, 1536);
  const tile = fiberTile(T, 77, makeCanvas);
  const out = new Uint8ClampedArray(N * 4);
  const topY = new Float32Array(Ws).fill(Hs);
  const L = { tone: 0, line: 0, strokes: 0, accents: 0, wash: 0, vis: 0, atm: 0, shade: 0, steep: 0, fiber: 0, sky: false, fog: 0, cov: 0, y: 0 };
  const rgb = [0, 0, 0], pap = [0, 0, 0];
  for (let y = 0; y < Hs; y++) {
    const vy = (y / Hs - 0.5) ** 2;
    const tr = (y % T) * T;
    for (let x = 0; x < Ws; x++) {
      const p = y * Ws + x;
      const vign = 1 - 0.1 * ((x / Ws - 0.5) ** 2 + vy);
      const k = (0.95 + 0.07 * nPaper[p]) * tile.f[tr + (x % T)] * vign;
      pap[0] = S.paper[0] * k;
      pap[1] = S.paper[1] * k;
      pap[2] = S.paper[2] * k;
      const d = dimg[p];
      const a = d >= D ? 0 : atm[p];
      L.tone = tone[p];
      L.line = Math.max(line[p] * 0.55, (md[4 * p + 1] / 255) * gate[p] * (0.55 + 0.45 * smoothstep(0.25, 0.55, fiber[p])) * Math.pow(1 - fog[p], 1.5));
      L.strokes = (md[4 * p] / 255) * (0.25 + 0.75 * a) * visSoft[p];
      L.accents = md[4 * p + 2] / 255;
      L.wash = wash[p];
      L.vis = vis[p];
      L.atm = a;
      L.shade = shade[p];
      L.steep = steep[p];
      L.y = y / Hs;
      L.fiber = fiber[p];
      L.sky = d >= D;
      L.fog = fog[p];
      L.cov = cov ? cov[p] : 0;
      mix(style, S, L, pap, rgb);
      const q = 4 * p;
      out[q] = rgb[0];
      out[q + 1] = rgb[1];
      out[q + 2] = rgb[2];
      out[q + 3] = 255;
      if (y < topY[x] && (L.tone > 0.08 || L.line > 0.15 || L.strokes > 0.25 || L.cov > 0.15)) topY[x] = y;
    }
  }
  onStage('done');
  return { width: Ws, height: Hs, data: out, topY, paper: S.paper };
}
