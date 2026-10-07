// Offline place search: the curated gallery plus a gazetteer of notable mountains from Wikidata
// (data/peaks.json, CC0). Typing coordinates ("30.13, 118.17") also works.

let index = null;
let loading = null;

const fold = s => (s || '')
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/^(mount|mt\.?|monte|mont|mount\s+)\s+/, '')
  .replace(/[\s\-'’.,/()]+/g, ' ')
  .trim();

export function parseCoords(q) {
  const m = q.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export async function loadIndex(gallery) {
  if (index) return index;
  if (!loading) {
    loading = (async () => {
      const entries = gallery.map(g => ({
        kind: 'gallery', id: g.id, en: g.en, zh: g.zh, lat: g.lat, lon: g.lon, elev: null, rank: 1e6,
        keys: [fold(g.en), fold(g.zh)],
      }));
      try {
        const res = await fetch('data/peaks.json');
        const json = await res.json();
        const f = Object.fromEntries(json.fields.map((k, i) => [k, i]));
        for (const r of json.rows) {
          const en = r[f.en] || '', zh = r[f.zh] || '';
          const alias = (r[f.alias] || '').split('|').filter(Boolean);
          entries.push({
            kind: 'peak', en, zh, lat: r[f.lat], lon: r[f.lon], elev: r[f.elev], rank: r[f.rank] || 0,
            keys: [fold(en), fold(zh), ...alias.map(fold)].filter(Boolean),
          });
        }
      } catch (e) {
        console.warn('peaks.json not available', e);
      }
      index = entries;
      return index;
    })();
  }
  return loading;
}

export async function search(q, gallery, limit = 8) {
  const query = fold(q);
  if (!query) return [];
  const list = await loadIndex(gallery);
  const scored = [];
  for (const e of list) {
    let best = 0;
    for (const k of e.keys) {
      if (!k) continue;
      if (k === query) best = Math.max(best, 3);
      else if (k.startsWith(query)) best = Math.max(best, 2);
      else if (query.length >= 2 && k.includes(query)) best = Math.max(best, 1);
    }
    if (best) scored.push({ e, s: best * 1e7 + Math.min(e.rank, 9e6) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map(x => x.e);
}
