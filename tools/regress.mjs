// Regression check over local samples (samples/ is git-ignored: private documents).
// For every PDF: convert, then verify extracted text and link counts are unchanged.
import * as mupdf from "mupdf";
import fs from "node:fs";
import path from "node:path";
import { convertPdf } from "../src/engine/pdf.js";
import { THEMES } from "../src/engine/themes.js";

const dir = process.argv[2] ?? "samples";
const outDir = process.argv[3] ?? "out/regress";
fs.mkdirSync(outDir, { recursive: true });
const theme = THEMES[0];
let failed = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".pdf")).sort()) {
  const input = new Uint8Array(fs.readFileSync(path.join(dir, f)));
  const { bytes, report } = convertPdf(mupdf, input, { theme });
  fs.writeFileSync(path.join(outDir, f.replace(/\.pdf$/i, "_dark.pdf")), bytes);
  const a = new mupdf.PDFDocument(input), b = new mupdf.PDFDocument(bytes);
  let text = 0, links = 0;
  for (let i = 0; i < report.pages; i++) {
    const pa = a.loadPage(i), pb = b.loadPage(i);
    const sa = pa.toStructuredText("preserve-whitespace"), sb = pb.toStructuredText("preserve-whitespace");
    if (sa.asText() === sb.asText()) text++;
    if (pa.getLinks().length === pb.getLinks().length) links++;
    for (const o of [sa, sb, pa, pb]) o.destroy();
  }
  a.destroy(); b.destroy();
  const ok = text === report.pages && links === report.pages;
  if (!ok) failed++;
  const types = report.pageReports.reduce((m, p) => ((m[p.type] = (m[p.type] || 0) + 1), m), {});
  console.log(`${ok ? "PASS" : "FAIL"} ${f.padEnd(14)} ${String(report.pages).padStart(3)}p ${(report.ms / 1000).toFixed(1).padStart(5)}s ` +
    `${Math.round(report.inputBytes / 1024)}->${Math.round(report.outputBytes / 1024)}KB text ${text}/${report.pages} links ${links}/${report.pages} ${JSON.stringify(types)}`);
}
process.exit(failed ? 1 : 0);
