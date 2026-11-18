// Image classification and transformation (classical heuristics, no ML).
//  - "diagram": flat-colour line-art on light paper  -> full smart remap (hue kept, lightness flipped)
//  - "photo-on-paper": photo/illustration embedded in a light page-like background
//                        -> remap only the border-connected paper region (soft mask), keep the photo
//  - "photo": natural image                           -> keep (optionally dimmed)

import { rgbToOklab } from "./color.mjs";

/** 3D LUT (N^3) of mapper.mapPaint for fast per-pixel mapping with trilinear interpolation. */
export function buildLut(mapper, N = 33) {
  const lut = new Float32Array(N * N * N * 3);
  let p = 0;
  for (let r = 0; r < N; r++) for (let g = 0; g < N; g++) for (let b = 0; b < N; b++) {
    const o = mapper.mapPaint([r / (N - 1), g / (N - 1), b / (N - 1)]);
    lut[p++] = o[0] * 255; lut[p++] = o[1] * 255; lut[p++] = o[2] * 255;
  }
  return { lut, N };
}

function lutApply({ lut, N }, r, g, b, out, o) {
  const s = (N - 1) / 255;
  // guard: callers may pass slightly out-of-range values
  r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
  const fr = r * s, fg = g * s, fb = b * s;
  const r0 = Math.min(N - 2, fr | 0), g0 = Math.min(N - 2, fg | 0), b0 = Math.min(N - 2, fb | 0);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  for (let c = 0; c < 3; c++) {
    const at = (i, j, k) => lut[((i * N + j) * N + k) * 3 + c];
    const c00 = at(r0, g0, b0) * (1 - db) + at(r0, g0, b0 + 1) * db;
    const c01 = at(r0, g0 + 1, b0) * (1 - db) + at(r0, g0 + 1, b0 + 1) * db;
    const c10 = at(r0 + 1, g0, b0) * (1 - db) + at(r0 + 1, g0, b0 + 1) * db;
    const c11 = at(r0 + 1, g0 + 1, b0) * (1 - db) + at(r0 + 1, g0 + 1, b0 + 1) * db;
    out[o + c] = (c00 * (1 - dg) + c01 * dg) * (1 - dr) + (c10 * (1 - dg) + c11 * dg) * dr;
  }
}

/** Downscale RGB(A) pixels to at most `max` px on the long side (box filter). */
function downscale(px, w, h, nc, max) {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / max));
  const W = Math.ceil(w / f), H = Math.ceil(h / f);
  const out = new Float32Array(W * H * 3);
  const cnt = new Float32Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * nc, j = ((y / f | 0) * W + (x / f | 0));
    out[j * 3] += px[i]; out[j * 3 + 1] += px[i + 1]; out[j * 3 + 2] += px[i + 2]; cnt[j]++;
  }
  for (let j = 0; j < W * H; j++) { out[j * 3] /= cnt[j]; out[j * 3 + 1] /= cnt[j]; out[j * 3 + 2] /= cnt[j]; }
  return { small: out, W, H, f };
}

/** Paper mask: light, low-chroma pixels flood-filled from the image border (on downscaled image). */
function paperMask(small, W, H) {
  const cand = new Uint8Array(W * H);
  for (let j = 0; j < W * H; j++) {
    const [L, a, b] = rgbToOklab([small[j * 3] / 255, small[j * 3 + 1] / 255, small[j * 3 + 2] / 255]);
    if (L > 0.86 && Math.hypot(a, b) < 0.06) cand[j] = 1;
  }
  const mask = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => { const j = y * W + x; if (cand[j] && !mask[j]) { mask[j] = 1; stack.push(j); } };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const j = stack.pop(), x = j % W, y = (j / W) | 0;
    if (x > 0) push(x - 1, y); if (x < W - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < H - 1) push(x, y + 1);
  }
  return { mask, cand };
}

export function classify(px, w, h, nc) {
  const { small, W, H } = downscale(px, w, h, nc, 256);
  const { mask, cand } = paperMask(small, W, H);
  let paper = 0, light = 0, flat = 0, nonPaper = 0, sat = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const j = y * W + x;
    if (mask[j]) paper++;
    if (cand[j]) light++;
    if (!mask[j]) {
      nonPaper++;
      let g = 0;
      for (const k of [j - 1, j + 1, j - W, j + W]) g += Math.abs(small[j * 3] - small[k * 3]) + Math.abs(small[j * 3 + 1] - small[k * 3 + 1]) + Math.abs(small[j * 3 + 2] - small[k * 3 + 2]);
      if (g < 12) flat++;
      const mx = Math.max(small[j * 3], small[j * 3 + 1], small[j * 3 + 2]), mn = Math.min(small[j * 3], small[j * 3 + 1], small[j * 3 + 2]);
      sat += (mx - mn) / 255;
    }
  }
  const tot = (W - 2) * (H - 2);
  const paperFrac = paper / tot;
  const flatFrac = nonPaper ? flat / nonPaper : 1;
  // "Solid" content: non-paper pixels that survive an erosion of radius R (thin strokes/text vanish).
  const R = 2;
  let solid = 0, solidFlat = 0;
  for (let y = R; y < H - R; y++) for (let x = R; x < W - R; x++) {
    let ok = true;
    for (let dy = -R; dy <= R && ok; dy++) for (let dx = -R; dx <= R; dx++) if (mask[(y + dy) * W + x + dx]) { ok = false; break; }
    if (!ok) continue;
    solid++;
    const j = y * W + x;
    let g = 0;
    for (const k of [j - 1, j + 1, j - W, j + W]) g += Math.abs(small[j * 3] - small[k * 3]) + Math.abs(small[j * 3 + 1] - small[k * 3 + 1]) + Math.abs(small[j * 3 + 2] - small[k * 3 + 2]);
    if (g < 12) solidFlat++;
  }
  const solidFrac = solid / tot;
  const solidFlatFrac = solid ? solidFlat / solid : 1;
  const stats = { paperFrac: +paperFrac.toFixed(3), lightFrac: +(light / tot).toFixed(3), flatFrac: +flatFrac.toFixed(3), solidFrac: +solidFrac.toFixed(3), solidFlatFrac: +solidFlatFrac.toFixed(3), meanSat: +(nonPaper ? sat / nonPaper : 0).toFixed(3) };
  let cls = "photo";
  const hasPhotoRegion = solidFrac > 0.05 && solidFlatFrac < 0.45;
  if (paperFrac > 0.2 && !hasPhotoRegion) cls = "diagram";
  else if (paperFrac > 0.08) cls = "photo-on-paper";
  return { cls, stats };
}

/**
 * Transform pixels in place (RGB, nc components incl. optional alpha).
 * Returns a sampler(u, v) for backdrop lookups (u,v in 0..1, v=0 at top row).
 */
export function transform(px, w, h, nc, cls, lut, opts = {}) {
  const tmp = [0, 0, 0];
  const before = downscale(px, w, h, nc, 256); // small copy of the original for backdrop sampling
  if (cls === "diagram") {
    for (let i = 0; i < w * h * nc; i += nc) { lutApply(lut, px[i], px[i + 1], px[i + 2], tmp, 0); px[i] = tmp[0]; px[i + 1] = tmp[1]; px[i + 2] = tmp[2]; }
  } else if (cls === "photo-on-paper") {
    const { small, W, H, f } = downscale(px, w, h, nc, 512);
    const { mask } = paperMask(small, W, H);
    // Document region = everything except "solid" picture content. Solid content is the
    // morphological opening of the non-paper mask: thin structures (text, rules, arrows)
    // vanish, large photo/illustration areas survive. Text drawn into the image on paper
    // therefore gets remapped (ink -> light) together with the paper (-> dark).
    const R = Math.max(2, Math.round(W / 128));
    const nonPaper = new Uint8Array(W * H);
    for (let j = 0; j < W * H; j++) nonPaper[j] = mask[j] ? 0 : 1;
    const opened = morph(morph(nonPaper, W, H, R, "min"), W, H, R + 1, "max");
    const solid = keepTexturedComponents(opened, small, W, H);
    const doc = new Uint8Array(W * H);
    for (let j = 0; j < W * H; j++) doc[j] = solid[j] ? 0 : 1;
    const soft = blurMask(doc, W, H, 2);
    const dim = opts.photoDim ?? 0.92;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(H - 1, y / f);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * nc;
        const a = bilinear(soft, W, H, Math.min(W - 1, x / f), sy);
        lutApply(lut, px[i], px[i + 1], px[i + 2], tmp, 0);
        px[i] = tmp[0] * a + px[i] * dim * (1 - a);
        px[i + 1] = tmp[1] * a + px[i + 1] * dim * (1 - a);
        px[i + 2] = tmp[2] * a + px[i + 2] * dim * (1 - a);
      }
    }
  } else if (opts.photoDim && opts.photoDim < 1) {
    for (let i = 0; i < w * h * nc; i += nc) { px[i] *= opts.photoDim; px[i + 1] *= opts.photoDim; px[i + 2] *= opts.photoDim; }
  }
  const after = downscale(px, w, h, nc, 256);
  const { W, H } = before;
  // Sampler: average colour (3x3 on the small grid) after transformation, plus whether it changed.
  return (u, v) => {
    const cx = Math.round(Math.min(1, Math.max(0, u)) * (W - 1)), cy = Math.round(Math.min(1, Math.max(0, v)) * (H - 1));
    let r = 0, g = 0, b = 0, d = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = Math.min(W - 1, Math.max(0, cx + dx)), y = Math.min(H - 1, Math.max(0, cy + dy));
      const j = (y * W + x) * 3;
      r += after.small[j]; g += after.small[j + 1]; b += after.small[j + 2];
      d += Math.abs(after.small[j] - before.small[j]) + Math.abs(after.small[j + 1] - before.small[j + 1]) + Math.abs(after.small[j + 2] - before.small[j + 2]);
      c++;
    }
    return { color: [r / c / 255, g / c / 255, b / c / 255], changed: d / c / 3 / 255 > 0.12 };
  };
}

/**
 * Keep only connected components that look like pictures (textured). Flat components
 * (very bold text, solid shapes) are dropped so they get remapped like ink.
 */
function keepTexturedComponents(maskIn, small, W, H) {
  const label = new Int32Array(W * H).fill(-1);
  const out = new Uint8Array(W * H);
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!maskIn[s] || label[s] >= 0) continue;
    const members = [];
    label[s] = s; stack.push(s);
    let flat = 0, interior = 0;
    while (stack.length) {
      const j = stack.pop(); members.push(j);
      const x = j % W, y = (j / W) | 0;
      if (x > 1 && x < W - 2 && y > 1 && y < H - 2 && maskIn[j - 2] && maskIn[j + 2] && maskIn[j - 2 * W] && maskIn[j + 2 * W]) {
        interior++;
        let g = 0;
        for (const k of [j - 1, j + 1, j - W, j + W]) g += Math.abs(small[j * 3] - small[k * 3]) + Math.abs(small[j * 3 + 1] - small[k * 3 + 1]) + Math.abs(small[j * 3 + 2] - small[k * 3 + 2]);
        if (g < 12) flat++;
      }
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1]) {
        if (k >= 0 && maskIn[k] && label[k] < 0) { label[k] = s; stack.push(k); }
      }
    }
    const textured = interior > 0 && flat / interior < 0.5 && members.length > (W * H) / 300;
    if (textured) for (const j of members) out[j] = 1;
  }
  return out;
}

/** Separable square min/max filter (erosion/dilation) of a binary mask. */
function morph(src, W, H, r, mode) {
  const isMin = mode === "min";
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = isMin ? 1 : 0;
    for (let d = -r; d <= r; d++) { const xx = Math.min(W - 1, Math.max(0, x + d)); const s = src[y * W + xx]; if (isMin ? s < v : s > v) v = s; }
    tmp[y * W + x] = v;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = isMin ? 1 : 0;
    for (let d = -r; d <= r; d++) { const yy = Math.min(H - 1, Math.max(0, y + d)); const s = tmp[yy * W + x]; if (isMin ? s < v : s > v) v = s; }
    out[y * W + x] = v;
  }
  return out;
}

function blurMask(mask, W, H, r) {
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
export const _internal = { downscale, paperMask, morph, keepTexturedComponents, lutApply };
