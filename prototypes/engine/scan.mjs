// Scanned-page pipeline: paper/illumination estimation -> normalisation -> soft ink mask ->
// theme composition, with photo regions preserved.
//
//   1. Paper map: per-block bright-pixel colour (robust max), smoothed -> removes yellowing,
//      uneven lighting and shadows in one step.
//   2. Normalise: I / paper  -> paper becomes white, ink keeps its hue (purple stamps, red text).
//   3. Ink alpha: smoothstep on normalised darkness -> suppresses noise and bleed-through.
//   4. Compose through the theme LUT (dark paper, light ink, colours lifted).
//   5. Photo regions (large, textured, after opening) keep their pixels (slightly dimmed).

import { rgbToOklab } from "./color.mjs";
import { _internal as I } from "./images.mjs";

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/** Robust bright colour per block: mean of the pixels at or above the block's 90th luminance percentile. */
function paperMap(px, w, h, nc, B) {
  const W = Math.ceil(w / B), H = Math.ceil(h / B);
  const map = new Float32Array(W * H * 3);
  const hist = new Uint32Array(256);
  for (let by = 0; by < H; by++) for (let bx = 0; bx < W; bx++) {
    hist.fill(0);
    const x0 = bx * B, y0 = by * B, x1 = Math.min(w, x0 + B), y1 = Math.min(h, y0 + B);
    let n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * w + x) * nc; hist[(px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8]++; n++; }
    let acc = 0, thr = 255; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.1) { thr = v; break; } }
    let r = 0, g = 0, b = 0, c = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * nc;
      if (((px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8) >= thr) { r += px[i]; g += px[i + 1]; b += px[i + 2]; c++; }
    }
    const j = (by * W + bx) * 3; map[j] = r / c; map[j + 1] = g / c; map[j + 2] = b / c;
  }
  // Blocks that are entirely ink/photo get a too-dark estimate: replace by the brighter of the
  // neighbourhood (dilation), then smooth.
  const dil = new Float32Array(map.length);
  const R = 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let best = -1, bj = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const xx = clamp(x + dx, 0, W - 1), yy = clamp(y + dy, 0, H - 1), j = (yy * W + xx) * 3;
      const L = map[j] + map[j + 1] + map[j + 2]; if (L > best) { best = L; bj = j; }
    }
    const j = (y * W + x) * 3; dil[j] = map[bj]; dil[j + 1] = map[bj + 1]; dil[j + 2] = map[bj + 2];
  }
  const out = new Float32Array(map.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, c = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const j = (clamp(y + dy, 0, H - 1) * W + clamp(x + dx, 0, W - 1)) * 3; r += dil[j]; g += dil[j + 1]; b += dil[j + 2]; c++;
    }
    const j = (y * W + x) * 3; out[j] = r / c; out[j + 1] = g / c; out[j + 2] = b / c;
  }
  return { map: out, W, H };
}

/** Median paper colour (0..1) of the whole page. */
function medianPaper({ map, W, H }) {
  const ch = [[], [], []];
  for (let j = 0; j < W * H; j++) for (let c = 0; c < 3; c++) ch[c].push(map[j * 3 + c]);
  return ch.map((a) => { a.sort((x, y) => x - y); return a[a.length >> 1] / 255; });
}

/**
 * Process one scanned page image in place.
 * @returns info about the page (paper colour, photo fraction)
 */
export function processScan(px, w, h, nc, mapper, lut, lutApply, opts = {}) {
  const B = Math.max(24, Math.round(Math.max(w, h) / 90));
  const pm = paperMap(px, w, h, nc, B);
  const paper = medianPaper(pm);
  const [pL, pa, pb] = rgbToOklab(paper);
  const paperChroma = Math.hypot(pa, pb);

  // --- normalise (into a scratch RGB buffer at full resolution) ---
  const norm = new Uint8ClampedArray(w * h * 3);
  for (let y = 0; y < h; y++) {
    const fy = clamp((y + 0.5) / B - 0.5, 0, pm.H - 1), y0 = fy | 0, y1 = Math.min(pm.H - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = clamp((x + 0.5) / B - 0.5, 0, pm.W - 1), x0 = fx | 0, x1 = Math.min(pm.W - 1, x0 + 1), tx = fx - x0;
      const i = (y * w + x) * nc, o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const a = pm.map[(y0 * pm.W + x0) * 3 + c] * (1 - tx) + pm.map[(y0 * pm.W + x1) * 3 + c] * tx;
        const b = pm.map[(y1 * pm.W + x0) * 3 + c] * (1 - tx) + pm.map[(y1 * pm.W + x1) * 3 + c] * tx;
        const p = a * (1 - ty) + b * ty;
        norm[o + c] = (px[i + c] / Math.max(24, p)) * 255;
      }
    }
  }

  // --- photo regions: blocks dominated by mid-tones (text blocks are bimodal: paper + ink) ---
  // measured at full resolution (every 2nd pixel): downscaling would turn dense text into grey
  const fB = Math.max(16, Math.round(Math.max(w, h) / 80)); // full-res pixels per block
  const BW = Math.ceil(w / fB), BH = Math.ceil(h / fB);
  let photoBlk = new Uint8Array(BW * BH);
  // Measured on the ORIGINAL pixels (normalisation flattens light photo areas into "paper").
  // Photo block: real contrast (sd) AND many pixels in the middle of the block's own range.
  // Text blocks are bimodal (few mid pixels); blank paper has tiny sd.
  for (let by = 0; by < BH; by++) for (let bx = 0; bx < BW; bx++) {
    const x0 = bx * fB, y0 = by * fB, x1 = Math.min(w, x0 + fB), y1 = Math.min(h, y0 + fB);
    let n = 0, sum = 0, sum2 = 0, lo = 1, hi = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * nc; const Y = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      sum += Y; sum2 += Y * Y; n++; if (Y < lo) lo = Y; if (Y > hi) hi = Y;
    }
    const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    if (sd < 0.06) continue;
    let mid = 0; const rg = Math.max(0.05, hi - lo);
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * nc; const Y = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      const t = (Y - lo) / rg;
      if (t > 0.2 && t < 0.7) mid++;
    }
    photoBlk[by * BW + bx] = mid / n > 0.3 ? 1 : 0;
  }
  const rawBlk = photoBlk.slice();
  // close gaps, then keep only large components, then fill holes
  photoBlk = I.morph(I.morph(photoBlk, BW, BH, 3, "max"), BW, BH, 3, "min");
  photoBlk = keepLarge(photoBlk, BW, BH, Math.max(6, (BW * BH) / 25)); // stamps / bold headings are smaller
  photoBlk = fillHoles(photoBlk, BW, BH);
  if (process.env.DEBUG_SCAN) { let g = ""; for (let y = 0; y < BH; y += 2) { for (let x = 0; x < BW; x++) g += photoBlk[y * BW + x] ? "#" : (rawBlk[y * BW + x] ? "+" : "."); g += "\n"; } console.error(g); }
  let photoPx = 0; for (let j = 0; j < BW * BH; j++) photoPx += photoBlk[j];
  const photoFrac = photoPx / (BW * BH);
  // Picture pages (covers, plates): partial masks look broken, keep the whole page (dimmed).
  // Coloured cover: paper clearly tinted in a hue that ageing does not produce (yellow/brown 60-110 deg).
  const paperHue = ((Math.atan2(pb, pa) * 180) / Math.PI + 360) % 360;
  const colouredCover = paperChroma > 0.08 || (paperChroma > 0.035 && (paperHue < 60 || paperHue > 110));
  const picturePage = photoFrac >= (opts.picturePageFrac ?? 0.12) || colouredCover;
  if (picturePage) {
    const dimP = opts.pictureDim ?? 0.85;
    for (let k = 0; k < w * h; k++) { const i = k * nc; px[i] *= dimP; px[i + 1] *= dimP; px[i + 2] *= dimP; }
    return { paper: paper.map((v) => +v.toFixed(3)), paperL: +pL.toFixed(3), photoFrac: +photoFrac.toFixed(3), picturePage: true };
  }
  const photoSoft = photoFrac > 0 ? blur(photoBlk, BW, BH, 1) : null;

  // --- local paper tint (coloured covers keep a dark version of their colour) ---
  const tintMap = new Float32Array(pm.W * pm.H * 3); // additive shift relative to theme bg (0..255)
  let anyTint = false;
  for (let j = 0; j < pm.W * pm.H; j++) {
    const pc = [pm.map[j * 3] / 255, pm.map[j * 3 + 1] / 255, pm.map[j * 3 + 2] / 255];
    const [, a, b] = rgbToOklab(pc);
    const wgt = smooth(0.05, 0.09, Math.hypot(a, b));
    if (wgt > 0) {
      anyTint = true;
      const t = mapper.mapPaint(pc);
      for (let c = 0; c < 3; c++) tintMap[j * 3 + c] = (t[c] - mapper.bg[c]) * 255 * wgt;
    }
  }

  // Strongly coloured paper (book covers) keeps a dark tint of its colour; yellowed paper -> theme bg.
  const lo = opts.inkLo ?? 0.14, hi = opts.inkHi ?? 0.62;
  const dim = opts.photoDim ?? 0.9;
  const tmp = [0, 0, 0];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * nc, o = (y * w + x) * 3;
      let r = norm[o], g = norm[o + 1], b = norm[o + 2];
      // ink strength from normalised luminance
      const Y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const dark = 1 - Y;
      const alpha = smooth(lo, hi, dark);
      // rescale ink darkness: faint marks/bleed-through -> paper, real ink -> full strength
      const k = dark > 1e-3 ? alpha / dark : 0;
      r = clamp(255 - (255 - r) * k, 0, 255); g = clamp(255 - (255 - g) * k, 0, 255); b = clamp(255 - (255 - b) * k, 0, 255);
      lutApply(lut, r, g, b, tmp, 0);
      if (anyTint) { // paper areas move to the tinted background, ink stays
        const j = (Math.min(pm.H - 1, (y / B) | 0) * pm.W + Math.min(pm.W - 1, (x / B) | 0)) * 3;
        const s = 1 - alpha;
        tmp[0] += tintMap[j] * s; tmp[1] += tintMap[j + 1] * s; tmp[2] += tintMap[j + 2] * s;
      }
      if (photoSoft) {
        const a = bilinear(photoSoft, BW, BH, Math.min(BW - 1, x / fB), Math.min(BH - 1, y / fB));
        if (a > 0) { tmp[0] = tmp[0] * (1 - a) + px[i] * dim * a; tmp[1] = tmp[1] * (1 - a) + px[i + 1] * dim * a; tmp[2] = tmp[2] * (1 - a) + px[i + 2] * dim * a; }
      }
      px[i] = tmp[0]; px[i + 1] = tmp[1]; px[i + 2] = tmp[2];
    }
  }
  return { paper: paper.map((v) => +v.toFixed(3)), paperL: +pL.toFixed(3), paperChroma: +paperChroma.toFixed(3), photoFrac: +photoFrac.toFixed(3), block: B, tinted: anyTint };
}

function keepLarge(m, W, H, minSize) {
  const out = new Uint8Array(W * H), seen = new Uint8Array(W * H), st = [];
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!m[s0] || seen[s0]) continue;
    const comp = []; seen[s0] = 1; st.push(s0);
    while (st.length) { const j = st.pop(); comp.push(j); const x = j % W, y = (j / W) | 0;
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1]) if (k >= 0 && m[k] && !seen[k]) { seen[k] = 1; st.push(k); } }
    if (comp.length >= minSize) for (const j of comp) out[j] = 1;
  }
  return out;
}
function fillHoles(m, W, H) {
  const outside = new Uint8Array(W * H), st = [];
  const push = (j) => { if (!m[j] && !outside[j]) { outside[j] = 1; st.push(j); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (st.length) { const j = st.pop(); const x = j % W, y = (j / W) | 0; if (x > 0) push(j - 1); if (x < W - 1) push(j + 1); if (y > 0) push(j - W); if (y < H - 1) push(j + W); }
  const out = new Uint8Array(W * H); for (let j = 0; j < W * H; j++) out[j] = outside[j] ? 0 : 1;
  return out;
}

function blur(mask, W, H, r) {
  const a = new Float32Array(W * H), b = new Float32Array(W * H);
  for (let j = 0; j < W * H; j++) a[j] = mask[j];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, c = 0; for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < W) { s += a[y * W + xx]; c++; } } b[y * W + x] = s / c; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, c = 0; for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < H) { s += b[yy * W + x]; c++; } } a[y * W + x] = s / c; }
  return a;
}
function bilinear(a, W, H, x, y) {
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), dx = x - x0, dy = y - y0;
  return (a[y0 * W + x0] * (1 - dx) + a[y0 * W + x1] * dx) * (1 - dy) + (a[y1 * W + x0] * (1 - dx) + a[y1 * W + x1] * dx) * dy;
}
