// Debug helper: list everything painted over a point (PDF user space, y measured from top) on a page.
// Usage: node prototypes/probe.mjs file.pdf pageIndex x yFromTop
import * as mupdf from "mupdf"; import fs from "node:fs";
const [, , file, pi, px, py] = process.argv;
const doc = new mupdf.PDFDocument(fs.readFileSync(file));
const page = doc.loadPage(+pi);
const X = +px, Y = +py;
const hit = (b) => X >= b[0] && X <= b[2] && Y >= b[1] && Y <= b[3];
const stroke = new mupdf.StrokeState({ lineCap: "Butt", lineJoin: "Miter", lineWidth: 1, miterLimit: 10 });
let n = 0;
const dev = new mupdf.Device({
  fillPath(path, eo, ctm, cs, color, alpha) { const b = path.getBounds(stroke, ctm); if (hit(b)) console.log(n++, "fillPath", cs?.getName?.(), color.map((v) => +v.toFixed(3)), "a", alpha, b.map(Math.round)); },
  fillShade(shade, ctm, alpha) { const b = shade.getBounds(); console.log(n++, "fillShade a", alpha, b.map(Math.round)); },
  fillImage(img, ctm, alpha) { console.log(n++, "fillImage", img.getWidth(), img.getHeight(), "a", alpha, ctm.map((v) => +v.toFixed(1))); },
  fillText(text, ctm, cs, color, alpha) { const b = text.getBounds(stroke, ctm); if (hit(b)) console.log(n++, "fillText", color.map((v) => +v.toFixed(3)), "a", alpha); },
  beginGroup(bbox, cs, iso, ko, bm, alpha) { if (hit(bbox)) console.log(n++, "beginGroup", bm, alpha, bbox.map(Math.round)); },
  beginMask(bbox, lum) { if (hit(bbox)) console.log(n++, "beginMask lum", lum); },
  beginTile(area, view, xs, ys, ctm) { if (hit(area)) console.log(n++, "beginTile", area.map(Math.round)); return 0; },
});
page.run(dev, mupdf.Matrix.identity);
