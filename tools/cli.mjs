// Command-line converter using the same engine as the web app.
// Usage: node tools/cli.mjs <input.pdf|.docx> <output> [themeId] [--password=...]
import * as mupdf from "mupdf";
import * as fflate from "fflate";
import fs from "node:fs";
import { convertPdf } from "../src/engine/pdf.js";
import { convertDocx } from "../src/engine/docx.js";
import { THEMES, DEFAULT_THEME_ID } from "../src/engine/themes.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const password = process.argv.find((a) => a.startsWith("--password="))?.slice(11);
const [inPath, outPath, themeId = DEFAULT_THEME_ID] = args;
if (!inPath || !outPath) { console.error("Usage: node tools/cli.mjs <input.pdf|.docx> <output> [themeId] [--password=...]"); process.exit(2); }
const theme = THEMES.find((t) => t.id === themeId);
if (!theme) { console.error("Unknown theme. Available: " + THEMES.map((t) => t.id).join(", ")); process.exit(2); }
const input = new Uint8Array(fs.readFileSync(inPath));
const isZip = input[0] === 0x50 && input[1] === 0x4b;
const { bytes, report } = isZip ? convertDocx(mupdf, fflate, input, { theme }) : convertPdf(mupdf, input, { theme, password });
fs.writeFileSync(outPath, bytes);
console.log(JSON.stringify(report, (k, v) => (k === "pageReports" ? undefined : v)));
