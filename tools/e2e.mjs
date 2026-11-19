// End-to-end check of the built site in Chromium (run `npm run build && npx vite preview` first).
// Uses local samples (git-ignored). Usage: node tools/e2e.mjs [baseUrl] [outDir]
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright"); // installed globally (not a project dependency)
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:4173/dark-pdf-converter/";
const outDir = process.argv[3] ?? "out/e2e";
fs.mkdirSync(outDir, { recursive: true });
const files = ["samples/ch9.pdf", "samples/handbook.pdf", "samples/ch9.docx"].filter((f) => fs.existsSync(f));

const browser = await chromium.launch();
const errors = [];
async function run(name, contextOpts) {
  const ctx = await browser.newContext({ ...contextOpts, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name} console: ${m.text()}`); });
  await page.goto(base);
  await page.screenshot({ path: path.join(outDir, `${name}-empty.png`) });
  await page.setInputFiles('input[type="file"]', files);
  await page.getByRole("button", { name: /^Convert/ }).click();
  const t0 = Date.now();
  await page.getByRole("button", { name: "All converted" }).waitFor({ timeout: 180_000 });
  console.log(`${name}: converted ${files.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  // preview of the first file (before/after)
  await page.getByRole("button", { name: /Preview ch9.pdf/ }).click();
  await page.locator('img[alt="Converted page"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, `${name}-done.png`), fullPage: false });
  // downloads
  const dl = [];
  for (const btn of await page.getByRole("button", { name: "Download" }).all()) {
    const [d] = await Promise.all([page.waitForEvent("download"), btn.click()]);
    const p = path.join(outDir, `${name}-${d.suggestedFilename()}`);
    await d.saveAs(p);
    dl.push(`${d.suggestedFilename()} ${Math.round(fs.statSync(p).size / 1024)}KB`);
  }
  console.log(`${name}: downloads -> ${dl.join(", ")}`);
  await ctx.close();
}
await run("desktop", { viewport: { width: 1366, height: 860 }, deviceScaleFactor: 1 });
await run("phone", { ...devices["iPhone 13"] });
await browser.close();
if (errors.length) { console.log("ERRORS:\n" + errors.join("\n")); process.exit(1); }
console.log("no page errors");
