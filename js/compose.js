// Finishing a painting: format (fan mask), inscription (题款), seal (印章), mounting (装裱) and
// the small data credit. Runs on the main thread, where the web fonts live.

import { mulberry32 } from './paint/util.js';

export const FONTS = {
  kai: '"Ma Shan Zheng", "KaiTi", "STKaiti", serif',
  xing: '"Zhi Mang Xing", "Ma Shan Zheng", "KaiTi", serif',
  cao: '"Long Cang", "Ma Shan Zheng", "KaiTi", serif',
  latin: '"Cormorant Garamond", "Times New Roman", serif',
  latinSmall: '"Jost", "Helvetica Neue", sans-serif',
};

const MOUNT = { silk: '#d8d2c2', edge: '#b9ab86', shadow: 'rgba(60, 45, 20, 0.25)' };
const INK = 'rgba(38, 33, 30, 0.92)';
const SEAL_RED = '#b3332b';

// Mount margins as fractions of the painting size [top, right, bottom, left].
function mountMargins(format, w, h) {
  if (format === 'scroll') return [0.15 * h, 0.07 * w, 0.09 * h, 0.07 * w];
  if (format === 'handscroll') return [0.1 * h, 0.035 * w, 0.1 * h, 0.035 * w];
  const m = 0.07 * Math.min(w, h);
  return [m, m, m, m];
}

const PUNCT = /[，。、；：！？,.;:!?·「」『』“”"'（）()《》\s]+/;

// Split a poem into columns at its punctuation (classical inscriptions carry none).
export function poemColumns(text) {
  return (text || '').split(PUNCT).map(s => s.trim()).filter(Boolean);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = Math.round(h);
  return c;
}

/** A square seal stamp with up to four characters, white on red (白文), with a worn edge. */
export function drawSeal(ctx, x, y, size, text, seed = 3) {
  const chars = [...(text || '')].filter(ch => ch.trim()).slice(0, 4);
  if (!chars.length) return;
  const rng = mulberry32(seed);
  const s = Math.ceil(size);
  const c = makeCanvas(s, s);
  const g = c.getContext('2d');
  g.fillStyle = SEAL_RED;
  const r = s * 0.06;
  g.beginPath();
  g.roundRect(0, 0, s, s, r);
  g.fill();
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const n = chars.length;
  const pad = s * 0.12;
  const inner = s - 2 * pad;
  const put = (ch, cx, cy, fs, sx = 1, sy = 1) => {
    g.save();
    g.translate(cx, cy);
    g.scale(sx, sy);
    g.font = `400 ${fs}px ${FONTS.kai}`;
    g.fillText(ch, 0, fs * 0.04);
    g.restore();
  };
  if (n === 1) put(chars[0], s / 2, s / 2, inner * 0.92);
  else if (n === 2) {
    put(chars[0], s / 2, pad + inner / 4, inner * 0.5, 1.7, 1);
    put(chars[1], s / 2, pad + (3 * inner) / 4, inner * 0.5, 1.7, 1);
  } else if (n === 3) {
    // Right column holds the first character at double height; the left column the other two.
    put(chars[0], pad + (3 * inner) / 4, s / 2, inner * 0.5, 1, 1.9);
    put(chars[1], pad + inner / 4, pad + inner / 4, inner * 0.5);
    put(chars[2], pad + inner / 4, pad + (3 * inner) / 4, inner * 0.5);
  } else {
    // Read top to bottom, right column first.
    put(chars[0], pad + (3 * inner) / 4, pad + inner / 4, inner * 0.5);
    put(chars[1], pad + (3 * inner) / 4, pad + (3 * inner) / 4, inner * 0.5);
    put(chars[2], pad + inner / 4, pad + inner / 4, inner * 0.5);
    put(chars[3], pad + inner / 4, pad + (3 * inner) / 4, inner * 0.5);
  }
  // Inner frame line, then wear: specks and a broken edge.
  g.globalCompositeOperation = 'destination-out';
  g.lineWidth = Math.max(1, s * 0.02);
  g.strokeRect(pad * 0.45, pad * 0.45, s - pad * 0.9, s - pad * 0.9);
  for (let i = 0; i < s * 1.2; i++) {
    const edge = rng() < 0.5;
    const px = edge ? (rng() < 0.5 ? rng() * s * 0.08 : s - rng() * s * 0.08) : rng() * s;
    const py = edge ? rng() * s : rng() * s;
    g.beginPath();
    g.arc(px, py, rng() * s * 0.018 + 0.3, 0, Math.PI * 2);
    g.fill();
  }
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.92;
  ctx.drawImage(c, x, y, size, size);
  ctx.restore();
}

// Lay out vertical Chinese columns. Returns the block geometry, or null if nothing to draw.
function verticalBlock(cols, u) {
  const colsOut = [];
  let width = 0, height = 0;
  cols.forEach((c, i) => {
    const size = c.size * u;
    const chars = [...c.text];
    const h = chars.length * size * 1.04;
    colsOut.push({ ...c, size, chars, h, w: size });
    width += size + (i ? 0.45 * size : 0);
    height = Math.max(height, h + (c.offset || 0) * u);
  });
  return { cols: colsOut, width, height };
}

/**
 * Compose the final picture.
 * painting: { data, width, height, topY } from paint()
 * opts: {
 *   format, mount (bool), credit (string|''), lang ('zh'|'en'),
 *   title, date, poem, seal, font ('kai'|'xing'|'cao'), side ('auto'|'left'|'right'|'none'),
 *   seed
 * }
 * Returns a canvas.
 */
export function compose(painting, opts) {
  const pw = painting.width, ph = painting.height;
  const art = makeCanvas(pw, ph);
  const actx = art.getContext('2d');
  actx.putImageData(new ImageData(painting.data, pw, ph), 0, 0);

  if (opts.side !== 'none') inscribe(actx, painting, opts);

  const fan = opts.format === 'fan';
  const mount = opts.mount && opts.format !== 'wallpaper';
  let out, ox = 0, oy = 0;
  if (mount) {
    const [t, r, b, l] = mountMargins(opts.format, pw, ph);
    out = makeCanvas(pw + l + r, ph + t + b);
    ox = l;
    oy = t;
    const ctx = out.getContext('2d');
    silk(ctx, out.width, out.height, opts.seed ?? 1);
    if (!fan) {
      ctx.save();
      ctx.shadowColor = MOUNT.shadow;
      ctx.shadowBlur = Math.max(2, pw * 0.006);
      ctx.fillStyle = '#000';
      ctx.fillRect(ox, oy, pw, ph);
      ctx.restore();
      ctx.drawImage(art, ox, oy);
      ctx.strokeStyle = MOUNT.edge;
      ctx.lineWidth = Math.max(1, pw * 0.0025);
      ctx.strokeRect(ox - ctx.lineWidth * 1.5, oy - ctx.lineWidth * 1.5, pw + ctx.lineWidth * 3, ph + ctx.lineWidth * 3);
    }
  } else {
    out = makeCanvas(pw, ph);
    const ctx = out.getContext('2d');
    if (fan) silk(ctx, pw, ph, opts.seed ?? 1, true);
    else ctx.drawImage(art, 0, 0);
  }
  if (fan) {
    const ctx = out.getContext('2d');
    const cx = ox + pw / 2, cy = oy + ph / 2, rad = Math.min(pw, ph) * 0.47;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(art, ox, oy);
    ctx.restore();
    ctx.strokeStyle = 'rgba(110, 86, 52, 0.9)';
    ctx.lineWidth = Math.max(1.5, rad * 0.012);
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (opts.credit) {
    const ctx = out.getContext('2d');
    const fs = Math.max(9, Math.min(out.width, out.height) * 0.011);
    ctx.font = `300 ${fs}px ${FONTS.latinSmall}`;
    ctx.fillStyle = mount ? 'rgba(80, 70, 55, 0.75)' : 'rgba(80, 70, 55, 0.55)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const pad = mount ? (out.height - oy - ph) * 0.35 : fs * 0.9;
    const inset = mount ? ox : fs;
    ctx.fillText(opts.credit, out.width - inset, out.height - pad, out.width - 2 * inset);
  }
  return out;
}

// Plain silk for mounts and the area around a round fan.
function silk(ctx, w, h, seed, light = false) {
  ctx.fillStyle = light ? '#ece6d8' : MOUNT.silk;
  ctx.fillRect(0, 0, w, h);
  const rng = mulberry32(seed + 101);
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = '#ffffff';
  const n = Math.round((w + h) / 3);
  for (let i = 0; i < n; i++) {
    const y = rng() * h;
    ctx.lineWidth = rng() * 1.2 + 0.3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y + (rng() - 0.5) * 4);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function inkTop(topY, x0, x1) {
  let m = Infinity;
  for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(topY.length - 1, Math.ceil(x1)); x++) m = Math.min(m, topY[x]);
  return m;
}

function inscribe(ctx, painting, o) {
  const W = painting.width, H = painting.height;
  const topY = painting.topY;
  const fan = o.format === 'fan';
  const u = Math.min(W, H) * (fan ? 0.82 : 1);
  const tall = H >= W;
  const marginX = fan ? W * 0.2 : tall ? W * 0.075 : W * 0.04;
  const marginY = fan ? H * 0.2 : tall ? H * 0.055 : H * 0.09;
  const sides = o.side === 'left' ? ['left'] : o.side === 'right' ? ['right'] : ['right', 'left'];

  if (o.lang === 'en') {
    for (let scale = 1; scale >= 0.6; scale -= 0.1) {
      const tsize = 0.05 * u * scale, ssize = 0.02 * u * scale;
      ctx.font = `italic 600 ${tsize}px ${FONTS.latin}`;
      const tw = ctx.measureText(o.title || '').width;
      ctx.font = `300 ${ssize}px ${FONTS.latinSmall}`;
      const dateText = (o.date || '').toUpperCase();
      const sw = ctx.measureText(dateText).width + [...dateText].length * ssize * 0.15;
      const seal = 0.05 * u * scale;
      const th = o.title ? tsize * 1.25 : 0; // an unnamed place has only the date and seal
      const bw = Math.max(tw, sw + seal * 1.4), bh = (o.title ? tsize * 1.1 : 0) + ssize * 2.2;
      const choice = pickSide(sides, topY, W, bw, marginX, marginY + bh, o.side === 'auto' && scale > 0.6);
      if (!choice) continue;
      const left = choice === 'left';
      const x0 = left ? marginX : W - marginX - bw;
      ctx.fillStyle = INK;
      ctx.textBaseline = 'top';
      ctx.textAlign = left ? 'left' : 'right';
      const ax = left ? x0 : x0 + bw;
      ctx.font = `italic 600 ${tsize}px ${FONTS.latin}`;
      ctx.fillText(o.title || '', ax, marginY);
      ctx.font = `300 ${ssize}px ${FONTS.latinSmall}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${ssize * 0.15}px`;
      const dy = marginY + th;
      ctx.fillText((o.date || '').toUpperCase(), left ? ax : ax - seal * 1.3, dy + ssize * 0.2);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      if (o.seal) drawSeal(ctx, left ? ax + sw + seal * 0.3 : ax - seal, dy - seal * 0.2, seal, o.seal, o.seed);
      return;
    }
    return;
  }

  const fontFamily = FONTS[o.font] || FONTS.xing;
  const poem = poemColumns(o.poem);
  for (let scale = 1; scale >= 0.55; scale -= 0.09) {
    const cols = [];
    if (o.title) cols.push({ text: [...o.title].slice(0, 8).join(''), size: 0.064 * scale, font: fontFamily });
    poem.forEach(p => cols.push({ text: p, size: 0.034 * scale, font: fontFamily, offset: 0.012 * scale }));
    if (o.date) cols.push({ text: o.date, size: 0.03 * scale, font: fontFamily, offset: 0.03 * scale });
    if (!cols.length) return;
    const block = verticalBlock(cols, u);
    const sealSize = o.seal ? 0.052 * u * scale : 0;
    const last = block.cols[block.cols.length - 1];
    const lastBottom = (last.offset || 0) * u + last.h;
    const bh = Math.max(block.height, lastBottom + (sealSize ? sealSize * 1.25 : 0));
    const maxH = H * (tall ? 0.62 : 0.8);
    if (bh > maxH) continue;
    const choice = pickSide(sides, topY, W, block.width, marginX, marginY + bh, o.side === 'auto' && scale > 0.6);
    if (!choice) continue;
    const left = choice === 'left';
    // Columns run right to left; the block sits against the chosen edge.
    let x = left ? marginX + block.width : W - marginX;
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    block.cols.forEach((c, i) => {
      const cx = x - c.w / 2;
      let y = marginY + (c.offset || 0) * u;
      ctx.font = `400 ${c.size}px ${c.font}`;
      for (const ch of c.chars) {
        ctx.fillText(ch, cx, y);
        y += c.size * 1.04;
      }
      if (i === block.cols.length - 1 && sealSize) {
        drawSeal(ctx, cx - sealSize / 2, y + sealSize * 0.25, sealSize, o.seal, o.seed);
      }
      x -= c.w + 0.45 * c.size;
    });
    return;
  }
}

// Choose the side whose columns stay clear of the painted mountains. With `strict`, a side only
// qualifies if the block fits above the ink; otherwise the emptier side wins.
function pickSide(sides, topY, W, bw, marginX, blockBottom, strict) {
  const room = s => {
    const x0 = s === 'left' ? marginX : W - marginX - bw;
    return inkTop(topY, x0 - bw * 0.15, x0 + bw * 1.15) - blockBottom;
  };
  const scored = sides.map(s => ({ s, r: room(s) })).sort((a, b) => b.r - a.r);
  if (strict) return scored[0].r > 0 ? scored[0].s : null;
  return scored[0].s;
}
