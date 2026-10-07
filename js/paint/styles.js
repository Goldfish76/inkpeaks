// Painting styles: paper colour plus how the ink layers and mineral pigments are combined.
// Every layer arrives as a 0..1 field; `mix` returns the final RGB for one pixel.

export const STYLES = {
  // 水墨 Ink: ink only, on warm xuan paper.
  ink: {
    paper: [236, 228, 208],
    ink: [28, 27, 31],
  },
  // 青绿 Blue-green: azurite on the crests, malachite below, ochre at the foot, on aged silk.
  qinglu: {
    paper: [229, 214, 181],
    ink: [34, 30, 30],
    azure: [38, 86, 122],
    green: [58, 128, 104],
    ochre: [176, 128, 82],
  },
  // 浅绛 Light crimson: an ink painting with pale ochre washes and a little indigo.
  qianjiang: {
    paper: [233, 222, 198],
    ink: [36, 32, 32],
    ochre: [186, 124, 82],
    indigo: [92, 108, 124],
  },
  // 雪景 Snow: white peaks against a darkened sky, the way Song painters left snow as bare silk.
  snow: {
    paper: [226, 221, 210],
    ink: [36, 36, 42],
    sky: [128, 127, 128],
  },
};

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * L: per-pixel layer values. Returns [r, g, b] in 0..255 given the paper colour `pap` (array).
 * Fields: tone, line, strokes, accents, wash, vis, atm, shade, fiber, sky, fog
 */
export function mix(style, S, L, pap, out) {
  if (style === 'ink') {
    let ink = 1 - (1 - L.tone * 0.9) * (1 - L.line * 0.95) * (1 - L.strokes * 0.7) * (1 - L.accents * 0.92);
    ink = Math.min(1, ink * (0.9 + 0.2 * L.fiber));
    out[0] = lerp(pap[0], S.ink[0], ink);
    out[1] = lerp(pap[1], S.ink[1], ink);
    out[2] = lerp(pap[2], S.ink[2], ink);
    return out;
  }
  if (style === 'qinglu') {
    const u = Math.min(1, Math.max(0, -Math.log(L.wash + 1e-4) / 1.6));
    let c0, c1, f;
    if (u < 0.35) {
      c0 = S.azure; c1 = S.green; f = u / 0.35;
    } else {
      c0 = S.green; c1 = S.ochre; f = (u - 0.35) / 0.65;
    }
    f = f * f * (3 - 2 * f);
    const cov = L.cov;
    const br = lerp(pap[0], lerp(c0[0], c1[0], f), cov);
    const bg = lerp(pap[1], lerp(c0[1], c1[1], f), cov);
    const bb = lerp(pap[2], lerp(c0[2], c1[2], f), cov);
    const ink = Math.min(1, 1 - (1 - L.tone * 0.3) * (1 - L.line * 0.85) * (1 - L.strokes * 0.4) * (1 - L.accents * 0.85));
    out[0] = lerp(br, S.ink[0], ink);
    out[1] = lerp(bg, S.ink[1], ink);
    out[2] = lerp(bb, S.ink[2], ink);
    return out;
  }
  if (style === 'qianjiang') {
    // Ochre on lit, lower slopes; indigo veil on far ranges and in shadow.
    const oc = L.cov * (0.35 + 0.65 * L.shade) * (0.4 + 0.6 * (1 - L.wash));
    const ind = L.cov * (0.25 * (1 - L.atm) + 0.25 * (1 - L.shade)) * (0.6 + 0.4 * L.wash);
    let r = lerp(pap[0], S.ochre[0], oc * 0.55), g = lerp(pap[1], S.ochre[1], oc * 0.55), b = lerp(pap[2], S.ochre[2], oc * 0.55);
    r = lerp(r, S.indigo[0], ind * 0.6);
    g = lerp(g, S.indigo[1], ind * 0.6);
    b = lerp(b, S.indigo[2], ind * 0.6);
    let ink = 1 - (1 - L.tone * 0.7) * (1 - L.line * 0.92) * (1 - L.strokes * 0.6) * (1 - L.accents * 0.9);
    ink = Math.min(1, ink * (0.9 + 0.2 * L.fiber));
    out[0] = lerp(r, S.ink[0], ink);
    out[1] = lerp(g, S.ink[1], ink);
    out[2] = lerp(b, S.ink[2], ink);
    return out;
  }
  // snow: the sky is washed grey (darker towards the top) so the peaks read as bare silk; snow
  // lies on gentle slopes, while steep rock and shadowed faces stay dark, as in Song snow scenes.
  {
    const wash = (0.32 + 0.3 * (1 - L.y)) * (L.sky ? 1 : L.fog * (1 - L.vis));
    let r = lerp(pap[0], S.sky[0], wash), g = lerp(pap[1], S.sky[1], wash), b = lerp(pap[2], S.sky[2], wash);
    const rock = Math.min(1, Math.max(0, (L.steep - 0.75) / 0.6)) * L.vis;
    const white = L.vis * (0.65 + 0.35 * L.shade) * (1 - 0.8 * rock);
    r = lerp(r, 247, white * 0.9);
    g = lerp(g, 245, white * 0.9);
    b = lerp(b, 241, white * 0.9);
    const rockInk = rock * (0.35 + 0.35 * (1 - L.shade)) * (0.6 + 0.4 * L.atm) * (0.55 + 0.7 * L.fiber);
    const ink = Math.min(1, 1 - (1 - L.tone * 0.4) * (1 - rockInk) * (1 - L.line * 0.95) * (1 - L.strokes * 0.85) * (1 - L.accents * 0.92));
    out[0] = lerp(r, S.ink[0], ink);
    out[1] = lerp(g, S.ink[1], ink);
    out[2] = lerp(b, S.ink[2], ink);
    return out;
  }
}
