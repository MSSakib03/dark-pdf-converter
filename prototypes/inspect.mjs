// Stage 0 prototype: inspect PDF structure (color spaces, operators, images, fonts).
import * as mupdf from "mupdf";
import fs from "node:fs";

const file = process.argv[2];
const doc = new mupdf.PDFDocument(fs.readFileSync(file));
const n = doc.countPages();
const opCount = {};
const csSet = new Set();
const images = [];
const fonts = new Set();
let streamBytes = 0;

function contentsOf(pageObj) {
  const c = pageObj.get("Contents");
  if (c.isArray()) { let s = ""; for (let i = 0; i < c.length; i++) s += c.get(i).readStream().asString() + "\n"; return s; }
  return c.isNull() ? "" : c.readStream().asString();
}
function scanRes(res, depth, seen) {
  if (!res || res.isNull()) return;
  const cs = res.get("ColorSpace");
  if (cs.isDictionary()) cs.forEach((v, k) => { const r = v.resolve(); csSet.add(k + ":" + (r.isArray() ? r.get(0).asName() : r.isName() ? r.asName() : "?")); });
  const f = res.get("Font");
  if (f.isDictionary()) f.forEach(v => { const r = v.resolve(); fonts.add(r.get("Subtype").asName() + " " + r.get("BaseFont").toString()); });
  const xo = res.get("XObject");
  if (xo.isDictionary()) xo.forEach((v, k) => {
    const num = v.isIndirect() ? v.asIndirect() : -1;
    if (seen.has(num)) return; seen.add(num);
    const r = v.resolve();
    const st = r.get("Subtype").asName();
    if (st === "Image") images.push({ k, num, w: r.get("Width").asNumber(), h: r.get("Height").asNumber(), cs: r.get("ColorSpace").toString().slice(0, 40), bpc: r.get("BitsPerComponent").toString(), filter: r.get("Filter").toString(), smask: !r.get("SMask").isNull(), mask: r.get("ImageMask").toString() });
    else if (st === "Form") { const s = r.readStream().asString(); count(s); scanRes(r.get("Resources"), depth + 1, seen); }
  });
}
function count(s) {
  streamBytes += s.length;
  // crude tokenizer for op stats only (strings/arrays ignored roughly)
  const toks = s.replace(/\((?:\\.|[^\\)])*\)/g, " ").replace(/<[0-9a-fA-F\s]*>/g, " ").split(/[\s\[\]]+/);
  for (const t of toks) if (/^[A-Za-z'"*][A-Za-z0-9*'"]*$/.test(t) && !/^(true|false|null)$/.test(t)) opCount[t] = (opCount[t] || 0) + 1;
}
const seen = new Set();
for (let i = 0; i < n; i++) {
  const p = doc.loadPage(i).getObject();
  count(contentsOf(p));
  scanRes(p.getInheritable("Resources"), 0, seen);
  const annots = p.get("Annots");
  if (i === 0) console.log("page0 MediaBox", p.getInheritable("MediaBox").toString(), "Rotate", p.getInheritable("Rotate").toString());
  if (annots.isArray()) { const t = {}; for (let j = 0; j < annots.length; j++) { const s = annots.get(j).resolve().get("Subtype").asName(); t[s] = (t[s] || 0) + 1; } console.log("page", i, "annots", JSON.stringify(t)); }
}
console.log("pages", n, "contentBytes", streamBytes);
console.log("ops", JSON.stringify(Object.entries(opCount).sort((a, b) => b[1] - a[1])));
console.log("colorspaces", [...csSet]);
console.log("fonts", [...fonts].slice(0, 30), fonts.size);
console.log("images", images.length);
for (const im of images.slice(0, 40)) console.log(JSON.stringify(im));
