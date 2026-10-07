// Who made the terrain under a painting. Mapterhorn merges many open elevation datasets and
// publishes a coverage index: a PMTiles archive of small JSON tiles (zoom 4–12) that name the
// sources behind every terrain tile. We read the entries for the tiles a painting used and credit
// their producers, finest data first. tools/gallery_credits.py does the same for the gallery.
// PMTiles format: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md

const INDEX_URL = 'https://download.mapterhorn.com/coverage-index.pmtiles';

let header = null;
const leaves = new Map();

async function range(offset, length) {
  const res = await fetch(INDEX_URL, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (!res.ok) throw new Error(`coverage index ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A server that ignores Range sends the whole file.
  return res.status === 200 ? bytes.subarray(offset, offset + length) : bytes;
}

async function decompress(bytes, kind) {
  if (kind === 0 || kind === 1) return bytes; // unknown / none
  if (kind !== 2) throw new Error(`compression ${kind}`);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function varint(b, pos) {
  let value = 0, scale = 1, byte;
  do {
    byte = b[pos++];
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return [value, pos];
}

function parseDirectory(b) {
  let [n, pos] = varint(b, 0);
  const cols = [];
  for (let c = 0; c < 4; c++) { // tile ids (delta), run lengths, lengths, offsets
    const col = new Array(n);
    for (let i = 0; i < n; i++) [col[i], pos] = varint(b, pos);
    cols.push(col);
  }
  const [ids, runs, lens, offs] = cols;
  for (let i = 1; i < n; i++) ids[i] += ids[i - 1];
  for (let i = 0; i < n; i++) offs[i] = offs[i] === 0 && i > 0 ? offs[i - 1] + lens[i - 1] : offs[i] - 1;
  return { ids, runs, lens, offs };
}

// Position on the Hilbert curve, counting all tiles of lower zooms first.
function tileId(z, x, y) {
  let acc = (4 ** z - 1) / 3;
  for (let a = z - 1; a >= 0; a--) {
    const s = 1 << a;
    const rx = x & s ? 1 : 0, ry = y & s ? 1 : 0;
    acc += ((3 * rx) ^ ry) * s * s;
    if (!ry) {
      if (rx) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      [x, y] = [y, x];
    }
  }
  return acc;
}

function findEntry(d, id) {
  let lo = 0, hi = d.ids.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (d.ids[m] < id) lo = m + 1;
    else if (d.ids[m] > id) hi = m - 1;
    else return m;
  }
  return hi >= 0 && (d.runs[hi] === 0 || id - d.ids[hi] < d.runs[hi]) ? hi : -1;
}

function getHeader() {
  if (!header) {
    header = (async () => {
      const b = await range(0, 16384);
      if (String.fromCharCode(...b.subarray(0, 7)) !== 'PMTiles' || b[7] !== 3) throw new Error('not PMTiles v3');
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const u64 = off => dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 2 ** 32;
      const h = { leafOff: u64(40), dataOff: u64(56), icomp: b[97], tcomp: b[98], maxZoom: b[101] };
      const rootOff = u64(8), rootLen = u64(16);
      h.root = parseDirectory(await decompress(b.subarray(rootOff, rootOff + rootLen), h.icomp));
      return h;
    })();
    header.catch(() => { header = null; });
  }
  return header;
}

async function indexTile(z, x, y) {
  const h = await getHeader();
  const id = tileId(z, x, y);
  let dir = h.root;
  for (let depth = 0; depth < 4; depth++) {
    const i = findEntry(dir, id);
    if (i < 0) return {};
    if (dir.runs[i] > 0) {
      const bytes = await decompress(await range(h.dataOff + dir.offs[i], dir.lens[i]), h.tcomp);
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    const key = `${dir.offs[i]}/${dir.lens[i]}`;
    if (!leaves.has(key)) {
      const p = range(h.leafOff + dir.offs[i], dir.lens[i]).then(b => decompress(b, h.icomp)).then(parseDirectory);
      leaves.set(key, p);
      p.catch(() => leaves.delete(key));
    }
    dir = await leaves.get(key);
  }
  return {};
}

async function producers(tiles) {
  const h = await getHeader();
  const keys = new Set(tiles.map(({ z, x, y }) => {
    const d = Math.max(0, z - h.maxZoom); // finer tiles are listed under their parent at the top zoom
    return `${z - d}/${x >> d}/${y >> d}`;
  }));
  const found = {};
  for (const entry of await Promise.all([...keys].map(k => indexTile(...k.split('/').map(Number))))) {
    Object.assign(found, entry);
  }
  const name = s => String(s.producer_short ?? '');
  const ranked = Object.values(found).sort((a, b) => a.resolution - b.resolution || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  return [...new Set(ranked.map(name).filter(Boolean))];
}

/**
 * Producers of the terrain in these Mapterhorn tiles ([{z, x, y}]), finest data first,
 * e.g. ['swisstopo', 'INGV', 'Copernicus']. Empty when nothing is known.
 */
export async function terrainProducers(tiles) {
  try {
    return await producers(tiles);
  } catch {
    // The index may have been republished since its header was read: start over once.
    header = null;
    leaves.clear();
    return producers(tiles);
  }
}
