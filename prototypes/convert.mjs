// Stage 0 prototype driver: digital PDF -> dark PDF (vector rewrite + image policies).
// Usage: node prototypes/convert.mjs <in.pdf> <out.pdf> [themeBg] [themeText]
import * as mupdf from "mupdf";
import fs from "node:fs";
import { createMapper } from "./engine/color.mjs";
import { rewriteStream } from "./engine/rewrite.mjs";
import { bytesToLatin1, latin1ToBytes } from "./engine/tokenizer.mjs";
import { buildLut, classify, transform, _internal as IMG } from "./engine/images.mjs";
import { processScan } from "./engine/scan.mjs";

const [, , inPath, outPath, bgHex = "#262626", textHex = "#F6F6F6"] = process.argv;
const t0 = performance.now();
const srcBytes = fs.readFileSync(inPath);
const doc = new mupdf.PDFDocument(srcBytes);
const mapper = createMapper({ bg: bgHex, text: textHex });
const lut = buildLut(mapper);
const stats = { scannedPages: [], text: 0, textKept: 0, skippedDarkPages: [], patterns: 0, patternsRemapped: 0, patternsKept: 0, shadings: 0, forms: 0, inlineImages: 0, approxColor: 0, images: {} };

const readStream = (obj) => bytesToLatin1(obj.readStream().asUint8Array());
const ctx = { mapper, doc, stats, formCache: new Set(), patternCache: new Map(), imageRegions: new Map(), regions: [], readStream, toBytes: latin1ToBytes };

// ---------- 1. images ----------
const replaced = new Map(); // old obj num -> new ref
let scanMode = false; // set per page by the page analyser
function processImages(res, seen) {
  if (!res || res.isNull()) return;
  const xo = res.get("XObject");
  if (!xo.isDictionary()) return;
  xo.forEach((ref, key) => {
    if (!ref.isIndirect()) return;
    const num = ref.asIndirect();
    const obj = ref.resolve();
    const sub = obj.get("Subtype").asName();
    if (sub === "Form") { if (!seen.has(num)) { seen.add(num); processImages(obj.get("Resources"), seen); } return; }
    if (sub !== "Image" || obj.get("ImageMask").toString() === "true") return;
    if (!replaced.has(num)) {
      const ti = performance.now();
      const img = doc.loadImage(ref);
      let pix = img.toPixmap();
      if (pix.getColorSpace()?.getName?.() !== "DeviceRGB" || pix.getNumberOfComponents() !== 3) {
        pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
      }
      const w = pix.getWidth(), h = pix.getHeight(), nc = pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0);
      const px = pix.getPixels();
      let { cls, stats: st } = scanMode ? { cls: "scan", stats: {} } : classify(px, w, h, pix.getStride() / w);
      let sampler = null, newRef = null;
      if (cls === "scan") {
        st = processScan(px, w, h, pix.getStride() / w, mapper, lut, IMG.lutApply);
        newRef = doc.addImage(new mupdf.Image(pix.asJPEG(82)));
        sampler = () => ({ color: mapper.bg, changed: true });
      } else if (cls !== "photo") {
        sampler = transform(px, w, h, pix.getStride() / w, cls, lut);
        const wasJpeg = /DCTDecode/.test(obj.get("Filter").toString());
        const newImg = wasJpeg ? new mupdf.Image(pix.asJPEG(88)) : new mupdf.Image(pix);
        newRef = doc.addImage(newImg);
        const smask = obj.get("SMask"); if (!smask.isNull()) newRef.put("SMask", smask);
      } else {
        sampler = transform(px, w, h, pix.getStride() / w, "keep", lut);
      }
      replaced.set(num, newRef);
      ctx.imageRegions.set(num, { sample: sampler });
      if (newRef) ctx.imageRegions.set(newRef.asIndirect(), { sample: sampler });
      stats.images[num] = { key, w, h, nc, cls, ...st, ms: Math.round(performance.now() - ti) };
    }
    const nr = replaced.get(num);
    if (nr) xo.put(key, nr);
  });
}

// ---------- 2. pages ----------
const origDoc = new mupdf.PDFDocument(srcBytes);
/** Low-res luminance statistics of the original page: dark fraction and 90th percentile (paper). */
function pageLuma(i) {
  const pix = origDoc.loadPage(i).toPixmap(mupdf.Matrix.scale(20 / 72, 20 / 72), mupdf.ColorSpace.DeviceRGB, false);
  const p = pix.getPixels(), nc = pix.getNumberOfComponents();
  const hist = new Uint32Array(256);
  let dark = 0, tot = 0;
  for (let k = 0; k < p.length; k += nc) { const Y = (0.2126 * p[k] + 0.7152 * p[k + 1] + 0.0722 * p[k + 2]) | 0; hist[Y]++; tot++; if (Y < 80) dark++; }
  let acc = 0, p90 = 255; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= tot * 0.1) { p90 = v; break; } }
  return { darkFraction: dark / tot, p90: p90 / 255 };
}
const n = doc.countPages();
const perPage = [];
for (let i = 0; i < n; i++) {
  const tp = performance.now();
  const page = doc.loadPage(i);
  const pobj = page.getObject();
  const res = pobj.getInheritable("Resources");
  const { darkFraction: df, p90 } = pageLuma(i);
  // scanned page: one image covering >= 85% of the page and no visible text
  const pageArea = (() => { const b = origDoc.loadPage(i).getBounds(); return (b[2] - b[0]) * (b[3] - b[1]); })();
  let maxImg = 0;
  { const dev = new mupdf.Device({ fillImage(img, m) { maxImg = Math.max(maxImg, Math.abs(m[0] * m[3] - m[1] * m[2])); } }); origDoc.loadPage(i).run(dev, mupdf.Matrix.identity); }
  const visibleText = origDoc.loadPage(i).toStructuredText().asText().trim().length;
  // real scans never have pure-white paper; full-page digital artwork does -> image classifier instead
  scanMode = maxImg / pageArea >= 0.85 && visibleText === 0 && p90 < 0.975;
  if (scanMode) stats.scannedPages.push(i + 1);
  if (!scanMode && df > 0.5) { stats.skippedDarkPages.push({ page: i + 1, darkFraction: +df.toFixed(2) }); perPage.push(Math.round(performance.now() - tp)); continue; }
  processImages(res, new Set());
  const c = pobj.get("Contents");
  let src = "";
  if (c.isArray()) for (let k = 0; k < c.length; k++) src += readStream(c.get(k)) + "\n";
  else if (!c.isNull()) src = readStream(c);
  // pass 1: analysis (no side effects) -> where does light text sit?
  const textPoints = [];
  rewriteStream(src, res, { ...ctx, analyze: true, textPoints, regions: [], stats: { ...stats } });
  // pass 2: rewrite
  ctx.regions = [];
  ctx.textPoints = textPoints;
  const body = rewriteStream(src, res, ctx);
  const mb = pobj.getInheritable("MediaBox");
  const [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) => mb.get(k).asNumber());
  const bgOp = `q ${mapper.bg.map((v) => v.toFixed(4)).join(" ")} rg ${x0} ${y0} ${x1 - x0} ${y1 - y0} re f Q\n`;
  pobj.put("Contents", doc.addStream(latin1ToBytes(bgOp + "q\n" + body + "\nQ\n"), {}));
  perPage.push(Math.round(performance.now() - tp));
}
const outBytes = doc.saveToBuffer("garbage=compact,compress=yes").asUint8Array().slice();
fs.writeFileSync(outPath, outBytes);
const total = Math.round(performance.now() - t0);

// ---------- 3. verification ----------
const a = new mupdf.PDFDocument(srcBytes), b = new mupdf.PDFDocument(outBytes);
let textSame = 0, linksSame = 0;
for (let i = 0; i < n; i++) {
  const pa = a.loadPage(i), pb = b.loadPage(i);
  if (pa.toStructuredText("preserve-whitespace").asText() === pb.toStructuredText("preserve-whitespace").asText()) textSame++;
  if (pa.getLinks().length === pb.getLinks().length) linksSame++;
}
console.log(JSON.stringify({ in: inPath, pages: n, totalMs: total, perPageMs: perPage, inKB: Math.round(srcBytes.length / 1024), outKB: Math.round(outBytes.length / 1024), textIdenticalPages: textSame, linkCountSamePages: linksSame, stats }, null, 1));
