// Paints in a background thread so the page stays responsive. The main thread sends each
// elevation grid once (keyed), then paint requests; results come back as transferable pixels.

import { paint } from './paint/render.js';

const dems = new Map();
const supported = typeof OffscreenCanvas !== 'undefined' && typeof Path2D !== 'undefined';

self.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'hello') {
    self.postMessage({ type: 'hello', supported });
    return;
  }
  if (msg.type === 'dem') {
    if (dems.size > 6) dems.delete(dems.keys().next().value);
    dems.set(msg.key, msg.dem);
    return;
  }
  if (msg.type === 'paint') {
    const { id, key, opts } = msg;
    try {
      const dem = dems.get(key);
      if (!dem) throw new Error('terrain not loaded');
      const res = paint(dem, opts, (w, h) => new OffscreenCanvas(w, h), stage => self.postMessage({ type: 'stage', id, stage }));
      self.postMessage({ type: 'done', id, res }, [res.data.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, message: String(err && err.message || err) });
    }
  }
};
