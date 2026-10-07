// Elevation data: decoding Terrarium images, fetching terrain tiles around a point, and building
// the square, north-up elevation grid the painter works from.
//
// Terrarium encoding: elevation (m) = R·256 + G + B/256 − 32768.

export const SOURCES = {
  mapterhorn: {
    url: (z, x, y) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`,
    tile: 512,
    maxZoom: 13,
  },
  aws: {
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    tile: 256,
    maxZoom: 14,
  },
};

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Decode a Terrarium image (Blob) into { w, h, data: Float32Array }.
export async function decodeTerrarium(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = makeCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const n = bmp.width * bmp.height;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = px[4 * i] * 256 + px[4 * i + 1] + px[4 * i + 2] / 256 - 32768;
  const out = { w: bmp.width, h: bmp.height, data };
  bmp.close?.();
  return out;
}

export async function loadTerrarium(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return decodeTerrarium(await res.blob());
}

// Web Mercator helpers (global pixel coordinates at zoom z for a given tile size).
const lonToX = (lon, z, ts) => ((lon + 180) / 360) * ts * 2 ** z;
const latToY = (lat, z, ts) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * ts * 2 ** z;
};
export const metersPerPixel = (lat, z, ts) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (ts * 2 ** z);

const tileCache = new Map();

async function fetchTile(src, z, x, y, signal) {
  const n = 2 ** z;
  x = ((x % n) + n) % n;
  const key = `${src}/${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    const p = (async () => {
      // Missing tiles are 404s. All-sea tiles are real but tiny (a few dozen bytes of zeros), so
      // judge a tile by its status and its decoded size, never by its byte count.
      const res = await fetch(SOURCES[src].url(z, x, y), { signal, mode: 'cors' });
      if (!res.ok) throw new Error(`tile ${res.status}`);
      const tile = await decodeTerrarium(await res.blob());
      if (tile.w !== SOURCES[src].tile || tile.h !== SOURCES[src].tile) throw new Error('bad tile');
      return tile;
    })();
    tileCache.set(key, p);
    p.catch(() => tileCache.delete(key));
  }
  return tileCache.get(key);
}

/**
 * Fetch a square, north-up elevation grid of side 2·radiusM around (lat, lon), resampled to
 * `size`×`size` on a local east/north plane. Tries Mapterhorn, then AWS.
 * Returns { w, h, data, mpp, lat, lon, source, zoom, tiles: [{z, x, y}], sea }.
 */
export async function fetchDem(lat, lon, radiusM, { size = 640, signal, onProgress } = {}) {
  const errors = [];
  for (const src of ['mapterhorn', 'aws']) {
    try {
      return await fetchDemFrom(src, lat, lon, radiusM, size, signal, onProgress);
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push(`${src}: ${e.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

async function fetchDemFrom(src, lat, lon, radiusM, size, signal, onProgress) {
  const S = SOURCES[src];
  const ts = S.tile;
  const target = (2 * radiusM) / size;
  // Coarsest zoom whose native resolution is at least as fine as the target spacing.
  let z = 1;
  while (z < S.maxZoom && metersPerPixel(lat, z, ts) > target) z++;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLat = (radiusM / 111320) * 1.05;
  const dLon = (radiusM / (111320 * cosLat)) * 1.05;
  let lastErr;
  for (let zz = z; zz >= Math.max(1, z - 2); zz--) {
    try {
      const x0 = lonToX(lon - dLon, zz, ts), x1 = lonToX(lon + dLon, zz, ts);
      const y0 = latToY(lat + dLat, zz, ts), y1 = latToY(lat - dLat, zz, ts);
      const tx0 = Math.floor(x0 / ts), tx1 = Math.floor(x1 / ts);
      const ty0 = Math.floor(y0 / ts), ty1 = Math.floor(y1 / ts);
      const nTiles = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
      if (nTiles > 36) throw new Error('area too large');
      let done = 0;
      const grid = [];
      const jobs = [];
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          jobs.push(fetchTile(src, zz, tx, ty, signal).then(t => {
            grid.push({ tx, ty, t });
            onProgress?.(++done / nTiles);
          }));
        }
      }
      await Promise.all(jobs);
      const mw = (tx1 - tx0 + 1) * ts, mh = (ty1 - ty0 + 1) * ts;
      const mosaic = new Float32Array(mw * mh);
      for (const { tx, ty, t } of grid) {
        for (let r = 0; r < t.h; r++) {
          mosaic.set(t.data.subarray(r * t.w, (r + 1) * t.w), (ty - ty0) * ts * mw + r * mw + (tx - tx0) * ts);
        }
      }
      // Resample onto the local metric grid.
      const out = new Float32Array(size * size);
      const step = (2 * radiusM) / (size - 1);
      let sea = false;
      for (let i = 0; i < size; i++) {
        const north = radiusM - i * step;
        const la = lat + north / 111320;
        const py = latToY(la, zz, ts) - ty0 * ts;
        for (let j = 0; j < size; j++) {
          const east = -radiusM + j * step;
          const lo = lon + east / (111320 * Math.cos((la * Math.PI) / 180));
          const px = lonToX(lo, zz, ts) - tx0 * ts;
          const v = sample(mosaic, mw, mh, px - 0.5, py - 0.5);
          out[i * size + j] = v;
          if (v <= 0.5) sea = true;
        }
      }
      const n = 2 ** zz;
      const tiles = grid.map(({ tx, ty }) => ({ z: zz, x: ((tx % n) + n) % n, y: ty }));
      return { w: size, h: size, data: out, mpp: step, lat, lon, source: src, zoom: zz, tiles, sea };
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('no data');
}

function sample(a, w, h, x, y) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const p = a[y0 * w + x0], q = a[y0 * w + x1], r = a[y1 * w + x0], s = a[y1 * w + x1];
  return p + (q - p) * fx + (r - p) * fy + (p - q - r + s) * fx * fy;
}
