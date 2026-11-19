// DOCX -> Dark DOCX: rewrites WordprocessingML / DrawingML colours. Layout is untouched, so Word
// (or any DOCX app) lays the document out exactly as before.
//
//   const { bytes, report } = convertDocx(mupdf, fflate, inputBytes, { theme });

import { createMapper, hexToRgb, rgbToHex } from "./color.js";
import { buildLut, classify, transform } from "./images.js";
import { ConversionError } from "./pdf.js";

const HIGHLIGHT = { yellow: "FFFF00", green: "00FF00", cyan: "00FFFF", magenta: "FF00FF", blue: "0000FF", red: "FF0000", darkBlue: "000080", darkCyan: "008080", darkGreen: "008000", darkMagenta: "800080", darkRed: "800000", darkYellow: "808000", darkGray: "808080", lightGray: "C0C0C0", black: "000000", white: "FFFFFF" };
const PARTS = /^word\/(document|styles|stylesWithEffects|header\d*|footer\d*|footnotes|endnotes|numbering|comments|charts\/chart\d*)\.xml$/;

/**
 * @param {any} mupdf
 * @param {any} fflate
 * @param {Uint8Array} input
 * @param {{ theme: {bg: string, text: string}, onProgress?: (p: {page: number, total: number, stage: string}) => void }} options
 */
export function convertDocx(mupdf, fflate, input, { theme, onProgress = (_p) => {} }) {
  const t0 = Date.now();
  let files;
  try { files = fflate.unzipSync(input); } catch { throw new ConversionError("corrupt", "This file could not be opened as a DOCX document."); }
  if (!files["word/document.xml"]) throw new ConversionError("corrupt", "This file is not a Word (DOCX) document.");

  const mapper = createMapper(theme);
  const lut = buildLut(mapper);
  const stats = { color: 0, fill: 0, border: 0, highlight: 0, drawing: 0, images: 0 };
  const hex = (rgb) => rgbToHex(rgb).slice(1);
  const textHex = hex(mapper.text);
  const borderAuto = hex(mapper.bg.map((v, i) => v + (mapper.text[i] - v) * 0.55));
  const dec = new TextDecoder(), enc = new TextEncoder();

  function recolor(xml) {
    xml = xml.replace(/\s+w:theme(Color|Tint|Shade|Fill|FillTint|FillShade)="[^"]*"/g, "");
    xml = xml.replace(/<w:color\s+w:val="([0-9A-Fa-f]{6}|auto)"/g, (_, v) => { stats.color++; return `<w:color w:val="${v === "auto" ? textHex : hex(mapper.mapText(hexToRgb("#" + v)))}"`; });
    xml = xml.replace(/(<w:shd\b[^>]*?\bw:fill=")([0-9A-Fa-f]{6})"/g, (_, pre, v) => { stats.fill++; return `${pre}${hex(mapper.mapPaint(hexToRgb("#" + v)))}"`; });
    xml = xml.replace(/(<w:(?:top|bottom|left|right|start|end|insideH|insideV|between|bar)\b[^>]*?\bw:color=")([0-9A-Fa-f]{6}|auto)"/g, (_, pre, v) => { stats.border++; return `${pre}${v === "auto" ? borderAuto : hex(mapper.mapPaint(hexToRgb("#" + v)))}"`; });
    xml = xml.replace(/<w:highlight\s+w:val="([a-zA-Z]+)"\s*\/>/g, (m, v) => { if (!HIGHLIGHT[v]) return m; stats.highlight++; return `<w:shd w:val="clear" w:color="auto" w:fill="${hex(mapper.mapPaint(hexToRgb("#" + HIGHLIGHT[v])))}"/>`; });
    xml = xml.replace(/(<a:srgbClr\s+val=")([0-9A-Fa-f]{6})"/g, (_, pre, v) => { stats.drawing++; return `${pre}${hex(mapper.mapPaint(hexToRgb("#" + v)))}"`; });
    return xml;
  }

  onProgress({ page: 1, total: 2, stage: "Recolouring text and tables" });
  for (const name of Object.keys(files)) {
    if (!PARTS.test(name)) continue;
    let xml = recolor(dec.decode(files[name]));
    if (name === "word/document.xml" && !/<w:background\b/.test(xml)) xml = xml.replace(/(<w:document\b[^>]*>)/, `$1<w:background w:color="${hex(mapper.bg)}"/>`);
    if (name === "word/styles.xml") xml = xml.replace(/<w:rPrDefault>\s*<w:rPr>/, (m) => m + `<w:color w:val="${textHex}"/>`);
    files[name] = enc.encode(xml);
  }
  if (files["word/settings.xml"]) {
    let s = dec.decode(files["word/settings.xml"]);
    if (!/<w:displayBackgroundShape/.test(s)) s = s.replace(/(<w:settings\b[^>]*>)/, "$1<w:displayBackgroundShape/>");
    files["word/settings.xml"] = enc.encode(s);
  }
  for (const name of Object.keys(files)) {
    if (!/^word\/theme\/theme\d*\.xml$/.test(name)) continue;
    const t = dec.decode(files[name]).replace(/(<a:(dk1|lt1|dk2|lt2|accent\d|hlink|folHlink)>\s*<a:(?:srgbClr val|sysClr val="[^"]*" lastClr)=")([0-9A-Fa-f]{6})"/g,
      (_, pre, slot, v) => `${pre}${hex(slot.startsWith("dk") || slot.includes("lnk") ? mapper.mapText(hexToRgb("#" + v)) : mapper.mapPaint(hexToRgb("#" + v)))}"`);
    files[name] = enc.encode(t);
  }

  onProgress({ page: 2, total: 2, stage: "Processing images" });
  for (const name of Object.keys(files)) {
    if (!/^word\/media\/.+\.(png|jpe?g)$/i.test(name)) continue;
    try {
      let pix = new mupdf.Image(files[name]).toPixmap();
      if (pix.getNumberOfComponents() !== 3) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
      const w = pix.getWidth(), h = pix.getHeight(), nc = pix.getStride() / w;
      const px = pix.getPixels();
      const { cls } = classify(px, w, h, nc);
      if (cls !== "photo") {
        transform(px, w, h, nc, cls, lut);
        files[name] = (/png$/i.test(name) ? pix.asPNG() : pix.asJPEG(88)).slice();
        stats.images++;
      }
    } catch { /* unsupported image: keep as is */ }
  }
  const bytes = fflate.zipSync(files, { level: 6 });
  return { bytes, report: { ms: Date.now() - t0, inputBytes: input.length, outputBytes: bytes.length, warnings: [], stats } };
}
