import pngjs from 'pngjs';
import pixelmatch from 'pixelmatch';

const { PNG } = pngjs;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function fillRect(png, box, rgba) {
  const x0 = clamp(Math.floor(box.x), 0, png.width);
  const y0 = clamp(Math.floor(box.y), 0, png.height);
  const x1 = clamp(Math.ceil(box.x + box.w), 0, png.width);
  const y1 = clamp(Math.ceil(box.y + box.h), 0, png.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (png.width * y + x) << 2;
      png.data[i] = rgba[0];
      png.data[i + 1] = rgba[1];
      png.data[i + 2] = rgba[2];
      png.data[i + 3] = rgba[3];
    }
  }
}

/** Mask ignored regions (grey) and crop to watched regions (if any). */
export function prepareScreenshot(buf, { watchBoxes = [], ignoreBoxes = [] } = {}) {
  const src = PNG.sync.read(buf);
  for (const b of ignoreBoxes) fillRect(src, b, [128, 128, 128, 255]);
  let out = src;
  if (watchBoxes.length) {
    const pad = 8;
    const x0 = clamp(Math.min(...watchBoxes.map((b) => b.x)) - pad, 0, src.width - 1);
    const y0 = clamp(Math.min(...watchBoxes.map((b) => b.y)) - pad, 0, src.height - 1);
    const x1 = clamp(Math.max(...watchBoxes.map((b) => b.x + b.w)) + pad, x0 + 1, src.width);
    const y1 = clamp(Math.max(...watchBoxes.map((b) => b.y + b.h)) + pad, y0 + 1, src.height);
    const w = Math.floor(x1 - x0);
    const h = Math.floor(y1 - y0);
    out = new PNG({ width: w, height: h });
    PNG.bitblt(src, out, Math.floor(x0), Math.floor(y0), w, h, 0, 0);
  }
  return { buffer: PNG.sync.write(out), width: out.width, height: out.height };
}

function pad(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/** Highlighted pixel diff of two PNG buffers (different sizes are padded with white). */
export function diffImages(bufA, bufB) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const pa = pad(a, w, h);
  const pb = pad(b, w, h);
  const out = new PNG({ width: w, height: h });
  const changed = pixelmatch(pa.data, pb.data, out.data, w, h, {
    threshold: 0.1,
    includeAA: false,
    alpha: 0.3,
    diffColor: [255, 0, 80],
  });
  return { png: PNG.sync.write(out), diffPct: (changed / (w * h)) * 100, width: w, height: h };
}
