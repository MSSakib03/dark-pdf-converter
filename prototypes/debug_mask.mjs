// Debug helper: dump paper / opened / solid masks of one image XObject as PNG.
import * as mupdf from "mupdf"; import fs from "node:fs";
import { _internal as I } from "./engine/images.mjs";
const [, , file, objNum, outPrefix] = process.argv;
const doc = new mupdf.PDFDocument(fs.readFileSync(file));
const img = doc.loadImage(doc.newIndirect(+objNum));
let pix = img.toPixmap(); if (pix.getNumberOfComponents() !== 3) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
const w = pix.getWidth(), h = pix.getHeight(), nc = pix.getStride() / w;
const { small, W, H } = I.downscale(pix.getPixels(), w, h, nc, 512);
const { mask } = I.paperMask(small, W, H);
const R = Math.max(2, Math.round(W / 128));
const nonPaper = mask.map((v) => (v ? 0 : 1));
const opened = I.morph(I.morph(nonPaper, W, H, R, "min"), W, H, R + 1, "max");
const solid = I.keepTexturedComponents(opened, small, W, H);
const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false);
const p = out.getPixels();
for (let j = 0; j < W * H; j++) { p[j * 3] = mask[j] * 255; p[j * 3 + 1] = opened[j] * 255; p[j * 3 + 2] = solid[j] * 255; }
fs.writeFileSync(outPrefix + ".png", out.asPNG());
console.log({ W, H, R });
