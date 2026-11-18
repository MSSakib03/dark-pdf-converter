// Stage 0 prototype: DOCX -> Dark DOCX by rewriting WordprocessingML/DrawingML colours.
// Layout is untouched (Word/LibreOffice still lay out the document), only colours change.
// Usage: node prototypes/docx_dark.mjs <in.docx> <out.docx> [bg] [text]
import fs from "node:fs";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import * as mupdf from "mupdf";
import { createMapper, hexToRgb, rgbToHex } from "./engine/color.mjs";
import { buildLut, classify, transform } from "./engine/images.mjs";

const [, , inPath, outPath, bgHex = "#262626", textHex = "#F6F6F6"] = process.argv;
const mapper = createMapper({ bg: bgHex, text: textHex });
const lut = buildLut(mapper);
const files = unzipSync(fs.readFileSync(inPath));
const stats = { color: 0, fill: 0, border: 0, highlight: 0, drawing: 0, images: {} };

const hex = (rgb) => rgbToHex(rgb).slice(1);
const textHexOut = hex(mapper.text);
const borderAuto = hex(mapper.bg.map((v, i) => v + (mapper.text[i] - v) * 0.55));
const HIGHLIGHT = { yellow: "FFFF00", green: "00FF00", cyan: "00FFFF", magenta: "FF00FF", blue: "0000FF", red: "FF0000", darkBlue: "000080", darkCyan: "008080", darkGreen: "008000", darkMagenta: "800080", darkRed: "800000", darkYellow: "808000", darkGray: "808080", lightGray: "C0C0C0", black: "000000", white: "FFFFFF" };

function recolorXml(xml) {
  // theme references override explicit values in Word; drop them (explicit val is kept)
  xml = xml.replace(/\s+w:theme(Color|Tint|Shade|Fill|FillTint|FillShade)="[^"]*"/g, "");
  // run colour
  xml = xml.replace(/<w:color\s+w:val="([0-9A-Fa-f]{6}|auto)"/g, (_, v) => { stats.color++; return `<w:color w:val="${v === "auto" ? textHexOut : hex(mapper.mapText(hexToRgb("#" + v)))}"`; });
  // shading fills
  xml = xml.replace(/(<w:shd\b[^>]*?\bw:fill=")([0-9A-Fa-f]{6})"/g, (_, pre, v) => { stats.fill++; return `${pre}${hex(mapper.mapPaint(hexToRgb("#" + v)))}"`; });
  // borders (paragraph / table / cell)
  xml = xml.replace(/(<w:(?:top|bottom|left|right|start|end|insideH|insideV|between|bar)\b[^>]*?\bw:color=")([0-9A-Fa-f]{6}|auto)"/g, (_, pre, v) => { stats.border++; return `${pre}${v === "auto" ? borderAuto : hex(mapper.mapPaint(hexToRgb("#" + v)))}"`; });
  // highlight (fixed palette) -> equivalent run shading with mapped colour
  xml = xml.replace(/<w:highlight\s+w:val="([a-zA-Z]+)"\s*\/>/g, (m, v) => { if (v === "none" || !HIGHLIGHT[v]) return m; stats.highlight++; return `<w:shd w:val="clear" w:color="auto" w:fill="${hex(mapper.mapPaint(hexToRgb("#" + HIGHLIGHT[v])))}"/>`; });
  // DrawingML colours (shapes, SmartArt, charts)
  xml = xml.replace(/(<a:srgbClr\s+val=")([0-9A-Fa-f]{6})"/g, (_, pre, v) => { stats.drawing++; return `${pre}${hex(mapper.mapPaint(hexToRgb("#" + v)))}"`; });
  return xml;
}

for (const name of Object.keys(files)) {
  if (!/^word\/(document|styles|stylesWithEffects|header\d*|footer\d*|footnotes|endnotes|numbering|charts\/chart\d*)\.xml$/.test(name)) continue;
  let xml = strFromU8(files[name]);
  xml = recolorXml(xml);
  if (name === "word/document.xml" && !/<w:background\b/.test(xml)) {
    xml = xml.replace(/(<w:document\b[^>]*>)/, `$1<w:background w:color="${hex(mapper.bg)}"/>`);
  }
  if (name === "word/styles.xml") {
    // default text colour for runs that never specify one
    xml = xml.replace(/<w:rPrDefault>\s*<w:rPr>/, (m) => m + `<w:color w:val="${textHexOut}"/>`);
  }
  files[name] = strToU8(xml);
}
if (files["word/settings.xml"]) {
  let s = strFromU8(files["word/settings.xml"]);
  if (!/<w:displayBackgroundShape/.test(s)) s = s.replace(/(<w:settings\b[^>]*>)/, "$1<w:displayBackgroundShape/>");
  files["word/settings.xml"] = strToU8(s);
}
// theme colours (used by anything we did not de-theme, e.g. DrawingML schemeClr)
if (files["word/theme/theme1.xml"]) {
  let t = strFromU8(files["word/theme/theme1.xml"]);
  t = t.replace(/(<a:(dk1|lt1|dk2|lt2|accent\d|hlink|folHlink)>\s*<a:(?:srgbClr val|sysClr val="[^"]*" lastClr)=")([0-9A-Fa-f]{6})"/g, (_, pre, slot, v) => `${pre}${hex(slot.startsWith("dk") || slot.includes("lnk") ? mapper.mapText(hexToRgb("#" + v)) : mapper.mapPaint(hexToRgb("#" + v)))}"`);
  files["word/theme/theme1.xml"] = strToU8(t);
}
// embedded images
for (const name of Object.keys(files)) {
  if (!/^word\/media\/.+\.(png|jpe?g)$/i.test(name)) continue;
  let pix = new mupdf.Image(files[name]).toPixmap();
  if (pix.getNumberOfComponents() !== 3) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
  const w = pix.getWidth(), h = pix.getHeight(), nc = pix.getStride() / w;
  const px = pix.getPixels();
  const { cls } = classify(px, w, h, nc);
  if (cls !== "photo") {
    transform(px, w, h, nc, cls, lut);
    files[name] = (/png$/i.test(name) ? pix.asPNG() : pix.asJPEG(88)).slice();
  }
  stats.images[name] = cls;
}
fs.writeFileSync(outPath, zipSync(files, { level: 6 }));
console.log(JSON.stringify(stats));
