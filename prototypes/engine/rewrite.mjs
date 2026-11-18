// Content-stream colour rewriter with graphics-state tracking and lazy colour emission.
// Original colour operators are dropped; before every painting operator the mapped colour
// for that role (text / fill / stroke / image-mask) is emitted if it differs from the
// colour currently in effect. This keeps q/Q semantics exact and lets text be mapped
// against the backdrop it actually sits on.

import { tokenize, serialize, num } from "./tokenizer.mjs";

const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const cmykToRgb = (c, m, y, k) => [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];

/** Resolve a colour-space name/object into a converter: comps[] -> rgb | null (pattern / unsupported). */
function colorSpaceInfo(name, resources) {
  if (name === "DeviceGray" || name === "G" || name === "CalGray") return { n: 1, conv: (c) => [c[0], c[0], c[0]] };
  if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return { n: 3, conv: (c) => [c[0], c[1], c[2]] };
  if (name === "DeviceCMYK" || name === "CMYK") return { n: 4, conv: (c) => cmykToRgb(c[0], c[1], c[2], c[3]) };
  if (name === "Pattern") return { n: 0, pattern: true };
  const csDict = resources && !resources.isNull() ? resources.get("ColorSpace") : null;
  const obj = csDict && !csDict.isNull() ? csDict.get(name).resolve() : null;
  if (!obj || obj.isNull()) return { n: 1, unknown: true, conv: (c) => [c[0], c[0], c[0]] };
  return colorSpaceFromObject(obj, resources);
}

function colorSpaceFromObject(obj, resources) {
  if (obj.isName()) return colorSpaceInfo(obj.asName(), resources);
  if (!obj.isArray()) return { n: 1, unknown: true, conv: (c) => [c[0], c[0], c[0]] };
  const family = obj.get(0).asName();
  if (family === "ICCBased") {
    const N = obj.get(1).resolve().get("N").asNumber();
    return colorSpaceInfo(N === 1 ? "DeviceGray" : N === 4 ? "DeviceCMYK" : "DeviceRGB");
  }
  if (family === "CalRGB" || family === "Lab") return colorSpaceInfo("DeviceRGB");
  if (family === "CalGray") return colorSpaceInfo("DeviceGray");
  if (family === "Pattern") return { n: 0, pattern: true };
  if (family === "Indexed") {
    const base = colorSpaceFromObject(obj.get(1).resolve(), resources);
    const hival = obj.get(2).asNumber();
    const lookupObj = obj.get(3).resolve();
    const bytes = lookupObj.isStream() ? lookupObj.readStream().asUint8Array() : lookupObj.asByteString();
    return { n: 1, conv: (c) => { const i = Math.max(0, Math.min(hival, Math.round(c[0]))); const comps = []; for (let k = 0; k < base.n; k++) comps.push(bytes[i * base.n + k] / 255); return base.conv(comps); } };
  }
  if (family === "Separation" || family === "DeviceN") {
    // Approximation: treat tint as ink coverage on white (exact tint transforms come in Stage 2).
    const n = family === "Separation" ? 1 : obj.get(1).length;
    const name = family === "Separation" ? obj.get(1).asName() : "";
    if (name === "None") return { n, conv: () => null };
    return { n, approx: true, conv: (c) => { const t = Math.min(1, c.reduce((a, b) => a + b, 0)); return [1 - t, 1 - t, 1 - t]; } };
  }
  return { n: 1, unknown: true, conv: (c) => [c[0], c[0], c[0]] };
}

const initialColorFor = (info) => (info.pattern ? null : info.n === 4 ? [0, 0, 0] : [0, 0, 0]);

/**
 * @param ctx { mapper, doc, imageRegions(list), stats, formCache(Map), imageMaskNums(Set) }
 */
export function rewriteStream(src, resources, ctx, baseCtm = IDENT, inherit = false) {
  const instrs = tokenize(src);
  const out = [];
  const regions = ctx.regions; // painted opaque rects (device space) for backdrop lookup

  const fresh = () => ({
    ctm: baseCtm,
    fill: inherit ? undefined : [0, 0, 0], stroke: inherit ? undefined : [0, 0, 0],
    fillCS: colorSpaceInfo("DeviceGray"), strokeCS: colorSpaceInfo("DeviceGray"),
    fillPattern: false, strokePattern: false,
    eFill: inherit ? "inherit" : "0 0 0", eStroke: inherit ? "inherit" : "0 0 0", // what's actually in effect (mapped)
    tr: 0, fontSize: 1, leading: 0,
  });
  let gs = fresh();
  const stack = [];
  let tm = IDENT, tlm = IDENT;
  let pathRects = []; let pathOther = false;

  const emit = (which, rgb) => {
    const key = rgb.map((v) => v.toFixed(4)).join(" ");
    if (which === "fill") { if (gs.eFill === key) return; gs.eFill = key; out.push({ op: "rg", operands: rgb.map(num) }); }
    else { if (gs.eStroke === key) return; gs.eStroke = key; out.push({ op: "RG", operands: rgb.map(num) }); }
  };

  function backdropAt(x, y) {
    for (let k = regions.length - 1; k >= 0; k--) {
      const r = regions[k];
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r.sample ? r.sample(x, y) : r.color;
    }
    return null; // page background
  }

  function paintFill(role) {
    if (gs.fillPattern || gs.fill === undefined || gs.fill === null) return;
    let rgb;
    if (role === "text") {
      const [x, y] = apply(mul(mul([gs.fontSize, 0, 0, gs.fontSize, 0, 0], tm), gs.ctm), 0.25, 0.3);
      rgb = ctx.mapper.mapText(gs.fill, backdropAt(x, y));
      ctx.stats.text++;
    } else rgb = ctx.mapper.mapPaint(gs.fill);
    emit("fill", rgb);
    return rgb;
  }
  function paintStroke(role) {
    if (gs.strokePattern || gs.stroke === undefined || gs.stroke === null) return;
    const rgb = role === "text" ? ctx.mapper.mapText(gs.stroke, null) : ctx.mapper.mapPaint(gs.stroke);
    emit("stroke", rgb);
  }

  const nums = (ops) => ops.filter((o) => o.type === "number").map((o) => o.value);

  for (const ins of instrs) {
    const { op, operands } = ins;
    switch (op) {
      case "q": stack.push({ ...gs }); out.push(ins); break;
      case "Q": if (stack.length) gs = stack.pop(); out.push(ins); break;
      case "cm": gs.ctm = mul(nums(operands), gs.ctm); out.push(ins); break;

      // ---- colour setting: record original, drop instruction ----
      case "g": gs.fill = [operands[0].value, operands[0].value, operands[0].value]; gs.fillPattern = false; gs.fillCS = colorSpaceInfo("DeviceGray"); break;
      case "G": gs.stroke = [operands[0].value, operands[0].value, operands[0].value]; gs.strokePattern = false; gs.strokeCS = colorSpaceInfo("DeviceGray"); break;
      case "rg": gs.fill = nums(operands); gs.fillPattern = false; gs.fillCS = colorSpaceInfo("DeviceRGB"); break;
      case "RG": gs.stroke = nums(operands); gs.strokePattern = false; gs.strokeCS = colorSpaceInfo("DeviceRGB"); break;
      case "k": gs.fill = cmykToRgb(...nums(operands)); gs.fillPattern = false; gs.fillCS = colorSpaceInfo("DeviceCMYK"); break;
      case "K": gs.stroke = cmykToRgb(...nums(operands)); gs.strokePattern = false; gs.strokeCS = colorSpaceInfo("DeviceCMYK"); break;
      case "cs": case "CS": {
        const info = colorSpaceInfo(operands[0].value, resources);
        const fill = op === "cs";
        if (info.pattern) { // pass through untouched; invalidate emitted colour
          out.push(ins);
          if (fill) { gs.fillPattern = true; gs.eFill = "pattern"; } else { gs.strokePattern = true; gs.eStroke = "pattern"; }
          ctx.stats.patterns++;
        }
        if (fill) { gs.fillCS = info; if (!info.pattern) { gs.fillPattern = false; gs.fill = initialColorFor(info); } }
        else { gs.strokeCS = info; if (!info.pattern) { gs.strokePattern = false; gs.stroke = initialColorFor(info); } }
        if (info.approx) ctx.stats.approxColor++;
        break;
      }
      case "sc": case "scn": case "SC": case "SCN": {
        const fill = op === "sc" || op === "scn";
        const pattern = fill ? gs.fillPattern : gs.strokePattern;
        if (pattern) { out.push(ins); break; }
        const info = fill ? gs.fillCS : gs.strokeCS;
        const rgb = info.conv(nums(operands));
        if (fill) gs.fill = rgb; else gs.stroke = rgb;
        break;
      }

      // ---- text state ----
      case "BT": tm = IDENT; tlm = IDENT; out.push(ins); break;
      case "Tm": tm = tlm = nums(operands); out.push(ins); break;
      case "Td": { const [tx, ty] = nums(operands); tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; out.push(ins); break; }
      case "TD": { const [tx, ty] = nums(operands); gs.leading = -ty; tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; out.push(ins); break; }
      case "T*": tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm); tm = tlm; out.push(ins); break;
      case "TL": gs.leading = operands[0].value; out.push(ins); break;
      case "Tf": gs.fontSize = operands[1]?.value ?? 1; out.push(ins); break;
      case "Tr": gs.tr = operands[0].value; out.push(ins); break;
      case "Tj": case "TJ": case "'": case '"': {
        if (op === "'" || op === '"') { tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm); tm = tlm; }
        const mode = gs.tr % 4;
        if (mode === 0 || mode === 2) paintFill("text");
        if (mode === 1 || mode === 2) paintStroke("text");
        out.push(ins);
        break;
      }

      // ---- path construction (track rectangles for backdrop model) ----
      case "re": { const [x, y, w, h] = nums(operands); pathRects.push([x, y, w, h]); out.push(ins); break; }
      case "m": case "l": case "c": case "v": case "y": case "h": pathOther = true; out.push(ins); break;
      case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*": {
        const rgb = paintFill("fill");
        if (op.startsWith("B") || op.startsWith("b")) paintStroke("stroke");
        if (rgb && !pathOther) {
          for (const [x, y, w, h] of pathRects) {
            const p1 = apply(gs.ctm, x, y), p2 = apply(gs.ctm, x + w, y + h);
            regions.push({ x0: Math.min(p1[0], p2[0]), y0: Math.min(p1[1], p2[1]), x1: Math.max(p1[0], p2[0]), y1: Math.max(p1[1], p2[1]), color: rgb });
          }
        }
        pathRects = []; pathOther = false; out.push(ins); break;
      }
      case "S": case "s": paintStroke("stroke"); pathRects = []; pathOther = false; out.push(ins); break;
      case "n": pathRects = []; pathOther = false; out.push(ins); break;

      // ---- XObjects ----
      case "Do": {
        const name = operands[0].value;
        const xo = resources.get("XObject").get(name);
        const obj = xo.resolve();
        const sub = obj.get("Subtype").asName();
        if (sub === "Image") {
          if (obj.get("ImageMask").asBoolean?.() || obj.get("ImageMask").toString() === "true") paintFill("fill");
          const reg = ctx.imageRegions.get(xo.isIndirect() ? xo.asIndirect() : -1);
          if (reg) { // unit square -> device space bbox, with pixel sampler for text backdrop
            const m = gs.ctm; const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
            const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
            const inv = invert(m);
            regions.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), sample: (x, y) => { const [u, v] = apply(inv, x, y); return reg.sample(u, 1 - v); } });
          }
        } else if (sub === "Form") {
          const key = xo.isIndirect() ? xo.asIndirect() : -1;
          if (!ctx.formCache.has(key)) {
            ctx.formCache.add(key);
            const fm = obj.get("Matrix").isArray() ? [0, 1, 2, 3, 4, 5].map((k) => obj.get("Matrix").get(k).asNumber()) : IDENT;
            const fres = obj.get("Resources").isNull() ? resources : obj.get("Resources");
            const s = rewriteStream(ctx.readStream(obj), fres, ctx, mul(fm, gs.ctm), true);
            obj.writeStream(ctx.toBytes(s));
            ctx.stats.forms++;
          }
          // form paints with whatever is currently emitted; ensure mapped colours are in effect
          if (gs.fill && !gs.fillPattern) emit("fill", ctx.mapper.mapPaint(gs.fill));
          if (gs.stroke && !gs.strokePattern) emit("stroke", ctx.mapper.mapPaint(gs.stroke));
        }
        out.push(ins);
        break;
      }
      case "BI": {
        if (/\/(IM|ImageMask)\s+true/.test(ins.inline.dictRaw)) paintFill("fill");
        else ctx.stats.inlineImages++;
        out.push(ins);
        break;
      }
      case "sh": ctx.stats.shadings++; out.push(ins); break;
      case "d0": case "d1": out.push(ins); break;
      default: out.push(ins);
    }
  }
  return serialize(out);
}

function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
