// Minimal single-page PDF writer: the finished picture is placed, centred, on a printable page
// and embedded as a JPEG. Dependency-free; a ~300 DPI image is what print shops expect.

export const PAGE_SIZES_PT = {
  a4: [595.28, 841.89],
  a3: [841.89, 1190.55],
  letter: [612, 792],
};

// Lay the picture on a page canvas (portrait or landscape to match it) at about `dpi`.
export function pageCanvas(picture, page, background, dpi = 300, maxPixels = 24e6) {
  let [pw, ph] = PAGE_SIZES_PT[page] || PAGE_SIZES_PT.a4;
  if (picture.width > picture.height) [pw, ph] = [ph, pw];
  let scale = dpi / 72;
  if (pw * ph * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (pw * ph));
  const W = Math.round(pw * scale), H = Math.round(ph * scale);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  const margin = 0.06 * Math.min(W, H);
  const k = Math.min((W - 2 * margin) / picture.width, (H - 2 * margin) / picture.height);
  const dw = picture.width * k, dh = picture.height * k;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(picture, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return { canvas: c, size: [pw, ph] };
}

export async function canvasToPdf(canvas, [pageW, pageH], quality = 0.93) {
  const jpegBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = data => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n, ...parts) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    parts.forEach(push);
    push('\nendobj\n');
  };
  const w = pageW.toFixed(2), h = pageH.toFixed(2);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] `
    + '/Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>');
  object(4, `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} `
    + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  jpeg, '\nendstream');
  object(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = length;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let n = 1; n <= 5; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R /Info << /Producer (Ink Peaks) >> >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
