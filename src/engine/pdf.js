// PDF -> Dark PDF conversion (environment-agnostic: runs in a Web Worker and in Node).
//
//   const { bytes, report } = await convertPdf(mupdf, inputBytes, { theme, password, onProgress });
//
// Per page, the analyser picks one of:
//   - "scanned": one image covers >= 85% of the page, no visible text, paper not pure white
//   - "already-dark": > 50% dark pixels -> left untouched
//   - "digital": vector content-stream rewrite + per-image policies

import { createMapper } from "./color.js";
import { rewriteStream } from "./rewrite.js";
import { bytesToLatin1, latin1ToBytes } from "./tokenizer.js";
import { buildLut, classify, transform, _internal as IMG } from "./images.js";
import { processScan } from "./scan.js";

/** Free WASM-side objects explicitly (finalizers run too late for large documents). */
const free = (...objs) => { for (const o of objs) try { o?.destroy?.(); } catch { /* already freed */ } };

export class ConversionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {typeof import("mupdf")} mupdf
 * @param {Uint8Array} input
 * @param {{ theme: {bg: string, text: string}, password?: string, imageMode?: "smart"|"keep",
 *           pageModes?: Record<number, "auto"|"keep"|"invert">,
 *           onProgress?: (p: {page: number, total: number, stage: string}) => void,
 *           shouldCancel?: () => boolean }} options
 */
export function convertPdf(mupdf, input, options) {
  const t0 = Date.now();
  const { theme, password, onProgress = () => {}, shouldCancel = () => false } = options;
  const imageMode = options.imageMode ?? "smart";
  const pageModes = options.pageModes ?? {};

  let doc, origDoc;
  try {
    doc = new mupdf.PDFDocument(input);
    origDoc = new mupdf.PDFDocument(input);
  } catch (e) {
    throw new ConversionError("corrupt", "This file could not be opened as a PDF. It may be damaged or not a PDF.");
  }
  for (const d of [doc, origDoc]) {
    if (d.needsPassword()) {
      if (!password) throw new ConversionError("password-required", "This PDF is password-protected. Enter the password to convert it.");
      if (!d.authenticatePassword(password)) throw new ConversionError("password-wrong", "The password is incorrect.");
    }
  }

  const warnings = [];
  const acro = doc.getTrailer().get("Root").get("AcroForm");
  if (!acro.isNull() && (acro.get("SigFlags").isNumber() ? acro.get("SigFlags").asNumber() : 0) & 1) {
    warnings.push("This PDF contains digital signatures. Changing colours invalidates them.");
  }
  if (doc.wasRepaired()) warnings.push("The PDF was damaged and has been repaired; check the result carefully.");

  const mapper = createMapper(theme);
  const lut = buildLut(mapper);
  const stats = { text: 0, textKept: 0, patterns: 0, patternsRemapped: 0, patternsKept: 0, shadings: 0, forms: 0, inlineImages: 0, approxColor: 0 };
  const readStream = (obj) => { const b = obj.readStream(); const s = bytesToLatin1(b.asUint8Array()); free(b); return s; };
  const ctx = { mapper, doc, stats, formCache: new Set(), patternCache: new Map(), imageRegions: new Map(), regions: [], readStream, toBytes: latin1ToBytes };
  const replaced = new Map();
  const pageReports = [];
  let scanMode = false;
  let invertMode = false;

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
        const img = doc.loadImage(ref);
        let pix = img.toPixmap();
        free(img);
        if (pix.getColorSpace()?.getName?.() !== "DeviceRGB" || pix.getNumberOfComponents() !== 3) {
          const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
          free(pix);
          pix = rgb;
        }
        const w = pix.getWidth(), h = pix.getHeight(), nc = pix.getStride() / w;
        const px = pix.getPixels();
        let cls;
        if (scanMode) cls = "scan";
        else if (invertMode) cls = "diagram";
        else if (imageMode === "keep") cls = "photo";
        else cls = classify(px, w, h, nc).cls;
        let sampler, newRef = null;
        if (cls === "scan") {
          processScan(px, w, h, nc, mapper, lut, IMG.lutApply);
          const ni = new mupdf.Image(pix.asJPEG(82));
          newRef = doc.addImage(ni);
          free(ni);
          sampler = () => ({ color: mapper.bg, changed: true });
        } else if (cls !== "photo") {
          sampler = transform(px, w, h, nc, cls, lut);
          const wasJpeg = /DCTDecode/.test(obj.get("Filter").toString());
          const ni = wasJpeg ? new mupdf.Image(pix.asJPEG(88)) : new mupdf.Image(pix);
          newRef = doc.addImage(ni);
          free(ni);
          const smask = obj.get("SMask"); if (!smask.isNull()) newRef.put("SMask", smask);
        } else {
          sampler = transform(px, w, h, nc, "keep", lut);
        }
        free(pix);
        replaced.set(num, { newRef, cls });
        ctx.imageRegions.set(num, { sample: sampler });
        if (newRef) ctx.imageRegions.set(newRef.asIndirect(), { sample: sampler });
      }
      const r = replaced.get(num);
      if (r.newRef) xo.put(key, r.newRef);
    });
  }

  function pageLuma(i) {
    const pg = origDoc.loadPage(i);
    const pix = pg.toPixmap(mupdf.Matrix.scale(20 / 72, 20 / 72), mupdf.ColorSpace.DeviceRGB, false);
    free(pg);
    const p = pix.getPixels(), nc = pix.getNumberOfComponents();
    const hist = new Uint32Array(256);
    let dark = 0, tot = 0;
    for (let k = 0; k < p.length; k += nc) { const Y = (0.2126 * p[k] + 0.7152 * p[k + 1] + 0.0722 * p[k + 2]) | 0; hist[Y]++; tot++; if (Y < 80) dark++; }
    let acc = 0, p90 = 255; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= tot * 0.1) { p90 = v; break; } }
    free(pix);
    return { darkFraction: dark / tot, p90: p90 / 255 };
  }

  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    if (shouldCancel()) throw new ConversionError("cancelled", "Conversion cancelled.");
    onProgress({ page: i + 1, total: n, stage: "Analysing page" });
    const page = doc.loadPage(i);
    const pobj = page.getObject();
    const res = pobj.getInheritable("Resources");
    const mode = pageModes[i + 1] ?? "auto";
    if (mode === "keep") { free(page); pageReports.push({ page: i + 1, type: "kept (manual)" }); continue; }

    const opage = origDoc.loadPage(i);
    const { darkFraction, p90 } = pageLuma(i);
    const b = opage.getBounds();
    const pageArea = (b[2] - b[0]) * (b[3] - b[1]);
    let maxImg = 0;
    const dev = new mupdf.Device({ fillImage(img, m) { maxImg = Math.max(maxImg, Math.abs(m[0] * m[3] - m[1] * m[2])); } });
    opage.run(dev, mupdf.Matrix.identity);
    dev.close(); free(dev);
    const st = opage.toStructuredText();
    const visibleText = st.asText().trim().length;
    free(st, opage);

    invertMode = mode === "invert";
    scanMode = !invertMode && maxImg / pageArea >= 0.85 && visibleText === 0 && p90 < 0.975;
    if (!scanMode && !invertMode && darkFraction > 0.5) { free(page); pageReports.push({ page: i + 1, type: "already dark (kept)" }); continue; }

    onProgress({ page: i + 1, total: n, stage: scanMode ? "Processing scanned page" : "Converting page" });
    processImages(res, new Set());
    const c = pobj.get("Contents");
    let src = "";
    if (c.isArray()) for (let k = 0; k < c.length; k++) src += readStream(c.get(k)) + "\n";
    else if (!c.isNull()) src = readStream(c);

    const textPoints = [];
    rewriteStream(src, res, { ...ctx, analyze: true, textPoints, regions: [], stats: { ...stats } });
    ctx.regions = [];
    ctx.textPoints = textPoints;
    const body = rewriteStream(src, res, ctx);
    const mb = pobj.getInheritable("MediaBox");
    const [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) => mb.get(k).asNumber());
    const bgOp = `q ${mapper.bg.map((v) => v.toFixed(4)).join(" ")} rg ${x0} ${y0} ${x1 - x0} ${y1 - y0} re f Q\n`;
    pobj.put("Contents", doc.addStream(latin1ToBytes(bgOp + "q\n" + body + "\nQ\n"), {}));
    free(page);
    pageReports.push({ page: i + 1, type: scanMode ? "scanned" : invertMode ? "inverted (manual)" : "digital" });
  }

  onProgress({ page: n, total: n, stage: "Saving" });
  const outBuf = doc.saveToBuffer("garbage=compact,compress=yes,encrypt=none");
  const bytes = outBuf.asUint8Array().slice();
  free(outBuf, doc, origDoc);
  if (stats.approxColor) warnings.push("Some spot colours were approximated.");
  return {
    bytes,
    report: { pages: n, ms: Date.now() - t0, inputBytes: input.length, outputBytes: bytes.length, pageReports, warnings, stats },
  };
}
