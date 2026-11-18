// Stage 0 prototype driver: digital PDF -> dark PDF (vector rewrite + image policies).
// Usage: node prototypes/convert.mjs <in.pdf> <out.pdf> [themeBg] [themeText]
import * as mupdf from "mupdf";
import fs from "node:fs";
import { createMapper } from "./engine/color.mjs";
import { rewriteStream } from "./engine/rewrite.mjs";
import { bytesToLatin1, latin1ToBytes } from "./engine/tokenizer.mjs";
import { buildLut, classify, transform } from "./engine/images.mjs";

const [, , inPath, outPath, bgHex = "#262626", textHex = "#F6F6F6"] = process.argv;
const t0 = performance.now();
const srcBytes = fs.readFileSync(inPath);
const doc = new mupdf.PDFDocument(srcBytes);
const mapper = createMapper({ bg: bgHex, text: textHex });
const lut = buildLut(mapper);
const stats = { text: 0, patterns: 0, shadings: 0, forms: 0, inlineImages: 0, approxColor: 0, images: {} };

const readStream = (obj) => bytesToLatin1(obj.readStream().asUint8Array());
const ctx = { mapper, stats, formCache: new Set(), imageRegions: new Map(), regions: [], readStream, toBytes: latin1ToBytes };

// ---------- 1. images ----------
const replaced = new Map(); // old obj num -> new ref
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
      const { cls, stats: st } = classify(px, w, h, pix.getStride() / w);
      let sampler = null, newRef = null;
      if (cls !== "photo") {
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
const n = doc.countPages();
const perPage = [];
for (let i = 0; i < n; i++) {
  const tp = performance.now();
  const page = doc.loadPage(i);
  const pobj = page.getObject();
  const res = pobj.getInheritable("Resources");
  processImages(res, new Set());
  const c = pobj.get("Contents");
  let src = "";
  if (c.isArray()) for (let k = 0; k < c.length; k++) src += readStream(c.get(k)) + "\n";
  else if (!c.isNull()) src = readStream(c);
  ctx.regions = [];
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
