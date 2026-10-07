// Ink Peaks · 卧游: the app. Pick a mountain, a style, a composition and a format; the painter
// works in a background thread; the inscription, seal and mounting are added here.

import { STR, dateLine } from './i18n.js';
import { loadTerrarium, fetchDem } from './terrain/dem.js';
import { terrainProducers } from './terrain/credits.js';
import { hillshade, fitExtent } from './paint/view.js';
import { COMPOSITIONS } from './paint/render.js';
import { compose, FONTS, poemColumns } from './compose.js';
import { search, parseCoords } from './search.js';
import { pageCanvas, canvasToPdf } from './pdf.js';

const $ = id => document.getElementById(id);

const FORMATS = {
  scroll: { aspect: 3 / 5, preview: 1100, standard: 3000, large: 4000 },
  handscroll: { aspect: 8 / 3, preview: 1500, standard: 4200, large: 5400 },
  square: { aspect: 1, preview: 1000, standard: 2800, large: 3400 },
  fan: { aspect: 1, preview: 1000, standard: 2800, large: 3400 },
  wallpaper: { aspect: 1290 / 2796, preview: 1150, standard: 2796, large: 2796 },
};

function dims(format, longSide) {
  const a = FORMATS[format].aspect;
  return a >= 1 ? { width: Math.round(longSide), height: Math.round(longSide / a) } : { width: Math.round(longSide * a), height: Math.round(longSide) };
}

const VIEW_KEYS = ['style', 'comp', 'az', 'zoom', 'relief', 'mist', 'water', 'texture', 'smooth'];
const VIEW_DEFAULTS = { style: 'ink', comp: 'shenyuan', az: 0, zoom: 0.92, relief: 1, mist: 0, water: 0, texture: 1, smooth: 0 };

const browserLang = (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
const state = {
  lang: browserLang,
  place: null,
  ...VIEW_DEFAULTS,
  seed: 1,
  format: 'scroll',
  mount: true,
  credit: true,
  title: '',
  poem: '',
  date: '',
  seal: '卧游',
  font: 'xing',
  side: 'auto',
  inscLang: browserLang,
  size: 'standard',
  page: 'a4',
  area: 8,
};

let gallery = [];
const dems = new Map();

// ---------- painter (worker with main-thread fallback) ----------

const painter = {
  worker: null,
  ok: false,
  seq: 0,
  pending: new Map(),
  sent: [],
  async init() {
    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => this.onMessage(e.data);
      this.ok = await new Promise(resolve => {
        this.hello = resolve;
        this.worker.onerror = () => resolve(false);
        this.worker.postMessage({ type: 'hello' });
        setTimeout(() => resolve(false), 4000);
      });
    } catch {
      this.ok = false;
    }
  },
  onMessage(m) {
    if (m.type === 'hello') return this.hello?.(m.supported);
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.type === 'done') {
      this.pending.delete(m.id);
      p.resolve(m.res);
    } else if (m.type === 'error') {
      this.pending.delete(m.id);
      p.reject(new Error(m.message));
    }
  },
  async paint(key, dem, opts) {
    if (!this.ok) {
      const { paint } = await import('./paint/render.js');
      await new Promise(r => setTimeout(r, 30));
      return paint(dem, opts, (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      });
    }
    if (!this.sent.includes(key)) {
      this.worker.postMessage({ type: 'dem', key, dem: { w: dem.w, h: dem.h, data: dem.data, mpp: dem.mpp, sea: dem.sea } });
      this.sent.push(key);
      if (this.sent.length > 6) this.sent.shift();
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'paint', id, key, opts });
    });
  },
};

// ---------- text ----------

const t = k => STR[state.lang][k] ?? k;

function applyLang() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('.lang button').forEach(b => b.classList.toggle('active', b.dataset.lang === state.lang));
  renderGallery();
  updatePlaceInfo();
  syncControls();
}

// ---------- places ----------

// The place's name, falling back to the other language. Places picked by coordinates or by your
// location have no name: the panel shows their coordinates, but paintings never do.
function placeName(p, lang = state.lang) {
  if (!p) return '';
  return lang === 'zh' ? p.zh || p.en : p.en || p.zh;
}

function placeLabel(p, lang = state.lang) {
  return placeName(p, lang) || (p?.kind === 'custom' ? `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}` : '');
}

function demKey(p) {
  return p.kind === 'gallery' ? `g:${p.id}` : `c:${p.lat.toFixed(4)},${p.lon.toFixed(4)},${p.areaKm}`;
}

async function getDem(p) {
  const key = demKey(p);
  if (dems.has(key)) return dems.get(key);
  let dem;
  if (p.kind === 'gallery') {
    dem = await loadTerrarium(`data/dem/${p.id}.png`);
    dem.mpp = p.mpp;
    dem.sea = p.sea;
    dem.source = p.source || 'mapterhorn';
    dem.credit = p.credit || [];
  } else {
    dem = await fetchDem(p.lat, p.lon, p.areaKm * 1000, { size: 640 });
    dem.credit = [];
    if (dem.source === 'mapterhorn') {
      // Look the producers up while the painting is made; add them to the margin when they arrive.
      dem.creditReady = producersOf(dem.tiles).then(c => {
        dem.credit = c;
        if (c.length && shown?.dem === dem && shown.format === state.format && !busy && state.credit) show(dem, shown.res);
      });
    }
  }
  dem.key = key;
  dem.stats = stats(dem.data);
  dem.shade = null;
  dems.set(key, dem);
  if (dems.size > 8) dems.delete(dems.keys().next().value);
  return dem;
}

// Data producers for the margin credit, or [] if the lookup fails or takes too long.
function producersOf(tiles) {
  const timeout = new Promise(resolve => setTimeout(() => resolve([]), 6000));
  return Promise.race([terrainProducers(tiles).catch(() => []), timeout]);
}

// An exported painting waits for the lookup, and retries one that came back empty.
async function creditFor(dem) {
  await dem.creditReady;
  if (!dem.credit.length && dem.source === 'mapterhorn' && dem.tiles) dem.credit = await producersOf(dem.tiles);
}

function stats(data) {
  const step = Math.max(1, Math.floor(data.length / 20000));
  const s = [];
  for (let i = 0; i < data.length; i += step) s.push(data[i]);
  s.sort((a, b) => a - b);
  return { p01: s[Math.floor(s.length * 0.01)], p99: s[Math.floor(s.length * 0.99)] };
}

function inscriptionDefaults() {
  const p = state.place;
  state.title = placeName(p, state.inscLang);
  state.poem = p && p.kind === 'gallery' && state.inscLang === 'zh' ? p.poem : '';
  state.date = dateLine(state.inscLang);
}

async function selectGallery(id, { preset = true } = {}) {
  const g = gallery.find(x => x.id === id) || gallery[0];
  state.place = { kind: 'gallery', ...g };
  if (preset) {
    Object.assign(state, VIEW_DEFAULTS);
    for (const k of VIEW_KEYS) if (g.view[k] !== undefined) state[k] = g.view[k];
  }
  inscriptionDefaults();
  await placeChanged();
}

async function selectCustom(lat, lon, names = {}) {
  state.place = { kind: 'custom', lat, lon, areaKm: state.area, zh: names.zh || '', en: names.en || '' };
  Object.assign(state, VIEW_DEFAULTS);
  inscriptionDefaults();
  await placeChanged();
}

async function placeChanged() {
  renderGallery();
  updatePlaceInfo();
  syncControls();
  await render();
}

function updatePlaceInfo() {
  const p = state.place;
  if (!p) return;
  const label = placeLabel(p);
  $('place-name').textContent = label;
  const other = placeName(p, state.lang === 'zh' ? 'en' : 'zh');
  const coords = p.kind === 'custom' ? `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}` : '';
  $('place-meta').textContent = [other !== label ? other : '', coords !== label ? coords : ''].filter(Boolean).join(' · ');
  $('area-row').hidden = p.kind === 'gallery';
  const src = p.kind === 'gallery' && p.poemSrc && state.inscLang === 'zh' && state.poem === p.poem ? `${t('poemSource')}：${p.poemSrc}` : '';
  $('poem-src').textContent = src;
  $('poem-src').hidden = !src;
}

function renderGallery() {
  const el = $('gallery');
  if (!gallery.length) return;
  if (!el.childElementCount) {
    for (const g of gallery) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = g.id;
      b.innerHTML = `<img alt="" loading="lazy" src="img/thumbs/${g.id}.jpg"><span></span>`;
      b.querySelector('img').onerror = e => { e.target.remove(); };
      b.addEventListener('click', () => selectGallery(g.id));
      el.appendChild(b);
    }
  }
  for (const b of el.children) {
    const g = gallery.find(x => x.id === b.dataset.id);
    b.querySelector('span').textContent = placeName(g);
    b.title = placeName(g);
    b.classList.toggle('active', state.place?.kind === 'gallery' && state.place.id === g.id);
  }
}

// ---------- terrain preview ----------

function drawTerrain(dem) {
  const c = $('terrain');
  const ctx = c.getContext('2d');
  const S = c.width;
  if (!dem.shade || dem.shade.width !== S) dem.shade = new ImageData(hillshade(dem, S), S, S);
  ctx.putImageData(dem.shade, 0, 0);
  // The ground the painting looks at, and where the viewer stands.
  const { width, height } = dims(state.format, 1000);
  const comp = COMPOSITIONS[state.comp];
  const groundAspect = comp.groundAspect * Math.pow(Math.min(4.5, Math.max(0.8, width / height / 0.6)), 0.6);
  const ext = fitExtent(dem, state.az, groundAspect);
  const side = Math.min(dem.w, dem.h) * dem.mpp;
  const k = S / side;
  const Wm = ext.width * state.zoom * k, Dm = ext.depth * state.zoom * k;
  const th = (state.az * Math.PI) / 180;
  const f = [Math.sin(th), -Math.cos(th)];   // forward, canvas coordinates (y down)
  const r = [Math.cos(th), Math.sin(th)];
  const cx = S / 2 + f[0] * comp.shift * Dm, cy = S / 2 + f[1] * comp.shift * Dm;
  const near = Wm / (1 + comp.persp);
  const pt = (u, v) => [cx + f[0] * u + r[0] * v, cy + f[1] * u + r[1] * v];
  ctx.save();
  ctx.fillStyle = 'rgba(179, 51, 43, 0.12)';
  ctx.strokeStyle = 'rgba(179, 51, 43, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  [pt(-Dm / 2, -near / 2), pt(Dm / 2, -Wm / 2), pt(Dm / 2, Wm / 2), pt(-Dm / 2, near / 2)].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const [ex, ey] = pt(-Dm / 2 - 14, 0);
  const [ax, ay] = pt(-Dm / 2 + 6, 0);
  ctx.fillStyle = '#b3332b';
  ctx.beginPath();
  ctx.arc(ex, ey, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ax, ay);
  ctx.stroke();
  ctx.fillStyle = 'rgba(42, 38, 34, 0.75)';
  ctx.font = '600 11px Jost, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', S / 2, 12);
  ctx.restore();
}

function terrainClick(e) {
  const c = $('terrain');
  const rect = c.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * c.width - c.width / 2;
  const y = ((e.clientY - rect.top) / rect.height) * c.height - c.height / 2;
  if (Math.hypot(x, y) < 4) return;
  // You stand where you click and look towards the centre.
  state.az = Math.round(((Math.atan2(-x, y) * 180) / Math.PI + 360) % 360);
  syncControls();
  scheduleRender(0);
}

// ---------- rendering ----------

let busy = false, dirty = false, timer = 0;

function scheduleRender(delay = 220) {
  clearTimeout(timer);
  timer = setTimeout(render, delay);
}

function showBusy(text) {
  $('busy').hidden = !text;
  $('busy-text').textContent = text || '';
}

function note(text) {
  $('stage-note').hidden = !text;
  $('stage-note').textContent = text || '';
}

function paintOptions(size) {
  return {
    width: size.width,
    height: size.height,
    style: state.style,
    composition: state.comp,
    azimuth: state.az,
    zoom: state.zoom,
    relief: state.relief,
    mist: state.mist,
    water: state.water,
    texture: state.texture,
    smooth: state.smooth,
    seed: state.seed,
  };
}

function creditText(dem) {
  if (!state.credit) return '';
  let src;
  if (dem?.source === 'aws') src = 'Terrain © Mapzen, USGS & others (AWS Terrain Tiles)';
  else if (dem?.credit?.length) src = `Terrain © ${dem.credit.join(', ')} via Mapterhorn`;
  else src = 'Terrain © Mapterhorn (mapterhorn.com/attribution)';
  return `Ink Peaks · ${state.lang === 'zh' ? '卧游 · ' : ''}${src}`;
}

function composeOptions(dem) {
  return {
    format: state.format,
    mount: state.mount,
    credit: creditText(dem),
    lang: state.inscLang,
    title: state.title,
    date: state.date,
    poem: state.inscLang === 'zh' ? state.poem : '',
    seal: state.seal,
    font: state.font,
    side: state.side,
    seed: state.seed,
  };
}

async function loadInscriptionFonts() {
  const text = [state.title, state.date, ...poemColumns(state.poem)].join('');
  const fam = FONTS[state.font] || FONTS.xing;
  const loads = [document.fonts.load(`400 64px ${fam}`, text || '山'), document.fonts.load(`400 64px ${FONTS.kai}`, state.seal || '卧游')];
  if (state.inscLang === 'en') loads.push(document.fonts.load(`italic 600 48px ${FONTS.latin}`, state.title || 'A'), document.fonts.load(`300 24px ${FONTS.latinSmall}`, 'A'));
  loads.push(document.fonts.load(`300 16px ${FONTS.latinSmall}`, 'Ink Peaks'));
  try {
    await Promise.race([Promise.all(loads), new Promise(r => setTimeout(r, 4000))]);
  } catch { /* draw with fallbacks */ }
}

// The painting on screen, kept so the inscription or credit can be redrawn without repainting.
let shown = null;

function show(dem, res) {
  const out = compose(res, composeOptions(dem));
  const art = $('art');
  art.width = out.width;
  art.height = out.height;
  art.getContext('2d').drawImage(out, 0, 0);
  shown = { dem, res, format: state.format };
}

async function render() {
  if (!state.place) return;
  if (busy) {
    dirty = true;
    return;
  }
  busy = true;
  dirty = false;
  writeHash();
  note('');
  try {
    let dem = dems.get(demKey(state.place));
    if (!dem) {
      showBusy(t('loadingTerrain'));
      dem = await getDem(state.place);
    }
    drawTerrain(dem);
    if (dem.stats.p99 - dem.stats.p01 < 150) note(t('flatWarning'));
    showBusy(t('painting'));
    const size = dims(state.format, FORMATS[state.format].preview);
    const [res] = await Promise.all([painter.paint(dem.key, dem, paintOptions(size)), loadInscriptionFonts()]);
    show(dem, res);
  } catch (err) {
    console.error(err);
    note(state.place.kind === 'custom' ? t('terrainFailed') : String(err.message || err));
  } finally {
    busy = false;
    showBusy('');
    if (dirty) render();
  }
}

// ---------- export ----------

function fileBase() {
  const name = (state.place?.en || 'mountain').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mountain';
  return `inkpeaks-${name}-${state.style}-${state.format}`;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function renderFull(longSide) {
  const dem = await getDem(state.place);
  const size = dims(state.format, longSide);
  const [res] = await Promise.all([painter.paint(dem.key, dem, paintOptions(size)), loadInscriptionFonts(), creditFor(dem)]);
  return compose(res, composeOptions(dem));
}

async function exportPng() {
  const btn = $('export-png');
  btn.disabled = true;
  showBusy(t('exporting'));
  try {
    const out = await renderFull(FORMATS[state.format][state.size]);
    const blob = await new Promise(r => out.toBlob(r, 'image/png'));
    download(blob, `${fileBase()}.png`);
  } catch (err) {
    console.error(err);
    note(String(err.message || err));
  } finally {
    btn.disabled = false;
    showBusy('');
  }
}

async function exportPdf() {
  const btn = $('export-pdf');
  btn.disabled = true;
  showBusy(t('exporting'));
  try {
    const out = await renderFull(FORMATS[state.format][state.page === 'a3' ? 'large' : 'standard']);
    const bg = state.mount ? '#d8d2c2' : '#f4efe4';
    const { canvas, size } = pageCanvas(out, state.page, bg);
    const blob = await canvasToPdf(canvas, size);
    download(blob, `${fileBase()}-${state.page}.pdf`);
  } catch (err) {
    console.error(err);
    note(String(err.message || err));
  } finally {
    btn.disabled = false;
    showBusy('');
  }
}

// ---------- URL state ----------

const NUM = { az: 'a', zoom: 'z', relief: 'r', mist: 'm', water: 'w', texture: 'x', seed: 'd', smooth: 'o' };

function writeHash() {
  const p = state.place;
  if (!p) return;
  const q = new URLSearchParams();
  if (p.kind === 'gallery') q.set('p', p.id);
  else {
    q.set('ll', `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`);
    q.set('km', p.areaKm);
    if (p.zh) q.set('nz', p.zh);
    if (p.en) q.set('ne', p.en);
  }
  q.set('s', state.style);
  q.set('c', state.comp);
  q.set('f', state.format);
  for (const [k, short] of Object.entries(NUM)) q.set(short, String(Math.round(state[k] * 1000) / 1000));
  q.set('ti', state.title);
  q.set('po', state.poem);
  q.set('da', state.date);
  q.set('se', state.seal);
  q.set('fo', state.font);
  q.set('si', state.side);
  q.set('il', state.inscLang);
  q.set('mo', state.mount ? '1' : '0');
  q.set('cr', state.credit ? '1' : '0');
  q.set('l', state.lang);
  history.replaceState(null, '', `#${q.toString()}`);
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (!q.toString()) return null;
  if (q.get('l') === 'zh' || q.get('l') === 'en') state.lang = q.get('l');
  if (q.get('il') === 'zh' || q.get('il') === 'en') state.inscLang = q.get('il');
  return q;
}

function applyHash(q) {
  const pick = (k, list) => (list.includes(q.get(k)) ? q.get(k) : undefined);
  const s = pick('s', ['ink', 'qinglu', 'qianjiang', 'snow']);
  if (s) state.style = s;
  const c = pick('c', ['gaoyuan', 'shenyuan', 'pingyuan']);
  if (c) state.comp = c;
  const f = pick('f', Object.keys(FORMATS));
  if (f) state.format = f;
  for (const [k, short] of Object.entries(NUM)) {
    if (q.has(short) && Number.isFinite(Number(q.get(short)))) state[k] = Number(q.get(short));
  }
  if (q.has('ti')) state.title = q.get('ti');
  if (q.has('po')) state.poem = q.get('po');
  if (q.has('da')) state.date = q.get('da');
  if (q.has('se')) state.seal = q.get('se');
  const fo = pick('fo', ['kai', 'xing', 'cao']);
  if (fo) state.font = fo;
  const si = pick('si', ['auto', 'left', 'right', 'none']);
  if (si) state.side = si;
  if (q.has('mo')) state.mount = q.get('mo') !== '0';
  if (q.has('cr')) state.credit = q.get('cr') !== '0';
}

// ---------- controls ----------

const fmtDeg = a => {
  const dirs = state.lang === 'zh' ? ['北', '东北', '东', '东南', '南', '西南', '西', '西北'] : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${dirs[Math.round(a / 45) % 8]} ${Math.round(a)}°`;
};
const pct = v => `${Math.round(v * 100)}%`;
const signed = v => (v > 0 ? `+${Math.round(v * 100)}` : `${Math.round(v * 100)}`);

function syncControls() {
  const setSeg = (sel, attr, val) => document.querySelectorAll(`${sel} [data-${attr}]`).forEach(b => b.classList.toggle('active', b.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] === val));
  setSeg('#styles', 'style', state.style);
  setSeg('#comps', 'comp', state.comp);
  setSeg('#formats', 'format', state.format);
  setSeg('#fonts', 'font', state.font);
  setSeg('#sides', 'side', state.side);
  setSeg('#sizes', 'size', state.size);
  setSeg('#insc-langs', 'insc-lang', state.inscLang);
  $('comp-note').textContent = t(`compNote_${state.comp}`);
  $('az').value = state.az;
  $('az-val').textContent = fmtDeg(state.az);
  $('zoom').value = state.zoom;
  $('zoom-val').textContent = pct(state.zoom);
  $('relief').value = state.relief;
  $('relief-val').textContent = pct(state.relief);
  $('mist').value = state.mist;
  $('mist-val').textContent = signed(state.mist);
  $('water').value = state.water;
  $('water-val').textContent = state.water > 0 ? pct(state.water) : '—';
  $('texture').value = state.texture;
  $('texture-val').textContent = pct(state.texture);
  $('area').value = state.area;
  $('area-val').textContent = `${state.area} ${t('areaUnit')}`;
  $('mount').checked = state.mount;
  $('credit').checked = state.credit;
  for (const k of ['title', 'poem', 'date', 'seal']) if (document.activeElement !== $(k)) $(k).value = state[k];
  $('poem').disabled = state.inscLang !== 'zh';
  $('page').value = state.page;
}

function bindControls() {
  document.querySelectorAll('.lang button').forEach(b => b.addEventListener('click', () => {
    state.lang = b.dataset.lang;
    applyLang();
    writeHash();
  }));
  const seg = (sel, attr, key, after) => document.querySelectorAll(`${sel} [data-${attr}]`).forEach(b => b.addEventListener('click', () => {
    state[key] = b.getAttribute(`data-${attr}`);
    after?.();
    syncControls();
    scheduleRender(0);
  }));
  seg('#styles', 'style', 'style');
  seg('#comps', 'comp', 'comp');
  seg('#formats', 'format', 'format');
  seg('#fonts', 'font', 'font');
  seg('#sides', 'side', 'side');
  seg('#insc-langs', 'insc-lang', 'inscLang', () => inscriptionDefaults());
  document.querySelectorAll('#sizes [data-size]').forEach(b => b.addEventListener('click', () => {
    state.size = b.dataset.size;
    syncControls();
  }));
  const slider = (id, key, delay = 260) => $(id).addEventListener('input', e => {
    state[key] = Number(e.target.value);
    syncControls();
    scheduleRender(delay);
  });
  slider('az', 'az');
  slider('zoom', 'zoom');
  slider('relief', 'relief');
  slider('mist', 'mist');
  slider('water', 'water');
  slider('texture', 'texture');
  $('area').addEventListener('input', e => {
    state.area = Number(e.target.value);
    syncControls();
    if (state.place?.kind === 'custom') {
      state.place = { ...state.place, areaKm: state.area };
      scheduleRender(500);
    }
  });
  for (const k of ['title', 'poem', 'date', 'seal']) {
    $(k).addEventListener('input', e => {
      state[k] = e.target.value;
      updatePlaceInfo();
      scheduleRender(400);
    });
  }
  $('mount').addEventListener('change', e => { state.mount = e.target.checked; scheduleRender(0); });
  $('credit').addEventListener('change', e => { state.credit = e.target.checked; scheduleRender(0); });
  $('reroll').addEventListener('click', () => {
    state.seed = 1 + Math.floor(Math.random() * 9999);
    scheduleRender(0);
  });
  $('terrain').addEventListener('click', terrainClick);
  $('export-png').addEventListener('click', exportPng);
  $('export-pdf').addEventListener('click', exportPdf);
  $('page').addEventListener('change', e => { state.page = e.target.value; });
  $('share').addEventListener('click', async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      $('share').textContent = t('copied');
      setTimeout(() => { $('share').textContent = t('copyLink'); }, 1600);
    } catch {
      prompt('', location.href);
    }
  });
  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      selectCustom(pos.coords.latitude, pos.coords.longitude, { zh: '我的山', en: 'My mountain' });
    }, () => note(t('terrainFailed')), { timeout: 10000 });
  });
  bindSearch();
}

function bindSearch() {
  const input = $('search'), menu = $('search-menu');
  let items = [], active = -1, q = 0;
  const close = () => { menu.hidden = true; active = -1; };
  const choose = it => {
    close();
    input.value = '';
    input.blur();
    if (it.kind === 'gallery') selectGallery(it.id);
    else if (it.kind === 'coords') selectCustom(it.lat, it.lon);
    else selectCustom(it.lat, it.lon, { zh: it.zh, en: it.en });
  };
  const show = () => {
    menu.innerHTML = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = t('noResults');
      menu.appendChild(li);
    }
    items.forEach((it, i) => {
      const li = document.createElement('li');
      const main = it.kind === 'coords' ? `${it.lat.toFixed(4)}, ${it.lon.toFixed(4)}` : placeName(it);
      const sub = it.kind === 'coords' ? '' : [placeName(it, state.lang === 'zh' ? 'en' : 'zh'), it.elev ? `${Math.round(it.elev)} ${t('elevationM')}` : ''].filter(s => s && s !== main).join(' · ');
      li.innerHTML = '<span></span><small></small>';
      li.firstChild.textContent = main;
      li.lastChild.textContent = sub;
      li.classList.toggle('active', i === active);
      li.addEventListener('mousedown', e => { e.preventDefault(); choose(it); });
      menu.appendChild(li);
    });
    menu.hidden = false;
  };
  input.addEventListener('input', async () => {
    const v = input.value.trim();
    const my = ++q;
    if (!v) return close();
    const c = parseCoords(v);
    if (c) {
      items = [{ kind: 'coords', ...c }];
      return show();
    }
    const res = await search(v, gallery);
    if (my !== q) return;
    items = res;
    active = res.length ? 0 : -1;
    show();
  });
  input.addEventListener('keydown', e => {
    if (menu.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); show(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); show(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[active]) { choose(items[active]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

// ---------- start ----------

// A small handle for scripted use (batch renders for the README, tests).
window.inkpeaks = {
  state,
  ready: null,
  selectGallery,
  render,
  async snapshot(longSide, type = 'image/jpeg', quality = 0.9) {
    const out = await renderFull(longSide);
    return out.toDataURL(type, quality);
  },
};

async function main() {
  const q = readHash();
  bindControls();
  const [g] = await Promise.all([fetch('data/gallery.json').then(r => r.json()), painter.init()]);
  gallery = g;
  applyLang();
  if (q && q.get('p') && gallery.some(x => x.id === q.get('p'))) {
    const gp = gallery.find(x => x.id === q.get('p'));
    state.place = { kind: 'gallery', ...gp };
    Object.assign(state, VIEW_DEFAULTS);
    for (const k of VIEW_KEYS) if (gp.view[k] !== undefined) state[k] = gp.view[k];
    inscriptionDefaults();
    applyHash(q);
    await placeChanged();
  } else if (q && q.get('ll')) {
    const [lat, lon] = q.get('ll').split(',').map(Number);
    state.area = Math.min(25, Math.max(2, Number(q.get('km')) || 8));
    state.place = { kind: 'custom', lat, lon, areaKm: state.area, zh: q.get('nz') || '', en: q.get('ne') || '' };
    inscriptionDefaults();
    applyHash(q);
    await placeChanged();
  } else {
    await selectGallery('huangshan');
  }
}

window.inkpeaks.ready = main();
