// Content-stream colour rewriter with graphics-state tracking and lazy colour emission.
//
// Original colour operators are dropped; before every painting operator the colour mapped
// for that role (text / fill / stroke / image-mask) is emitted if it differs from the colour
// currently in effect. Path-construction operators are buffered so that colour operators are
// always emitted *before* the path (PDF spec: no colour ops between path construction and paint).
//
// A lightweight backdrop model (filled shapes, images, pattern areas in device space) lets text
// be mapped against what is really underneath it.

import { tokenize, serialize, num } from "./tokenizer.mjs";

const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const R = (o) => (o.isNull() ? o : o.resolve());
const rgbL = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const cmykToRgb = (c, m, y, k) => [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];

/** Resolve a colour-space name into a converter: comps[] -> rgb. */
function colorSpaceInfo(name, resources) {
  if (name === "DeviceGray" || name === "G" || name === "CalGray") return { n: 1, conv: (c) => [c[0], c[0], c[0]] };
  if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return { n: 3, conv: (c) => [c[0], c[1], c[2]] };
  if (name === "DeviceCMYK" || name === "CMYK") return { n: 4, conv: (c) => cmykToRgb(c[0], c[1], c[2], c[3]) };
  if (name === "Pattern") return { n: 0, pattern: true };
  const csDict = resources && !resources.isNull() ? resources.get("ColorSpace") : null;
  const obj = csDict && !csDict.isNull() ? R(csDict.get(name)) : null;
  if (!obj || obj.isNull()) return { n: 1, unknown: true, conv: (c) => [c[0], c[0], c[0]] };
  return colorSpaceFromObject(obj, resources);
}

function colorSpaceFromObject(obj, resources) {
  if (obj.isName()) return colorSpaceInfo(obj.asName(), resources);
  if (!obj.isArray()) return { n: 1, unknown: true, conv: (c) => [c[0], c[0], c[0]] };
  const family = obj.get(0).asName();
  if (family === "ICCBased") {
    const N = R(obj.get(1)).get("N").asNumber();
    return colorSpaceInfo(N === 1 ? "DeviceGray" : N === 4 ? "DeviceCMYK" : "DeviceRGB");
  }
  if (family === "CalRGB" || family === "Lab") return colorSpaceInfo("DeviceRGB");
  if (family === "CalGray") return colorSpaceInfo("DeviceGray");
  if (family === "Pattern") return { n: 0, pattern: true };
  if (family === "Indexed") {
    const base = colorSpaceFromObject(R(obj.get(1)), resources);
    const hival = obj.get(2).asNumber();
    const lookupRef = obj.get(3);
    const bytes = R(lookupRef).isString() ? R(lookupRef).asByteString() : lookupRef.readStream().asUint8Array();
    return { n: 1, conv: (c) => { const i = Math.max(0, Math.min(hival, Math.round(c[0]))); const comps = []; for (let k = 0; k < base.n; k++) comps.push(bytes[i * base.n + k] / 255); return base.conv(comps); } };
  }
  if (family === "Separation" || family === "DeviceN") {
    // Approximation: treat tint as ink coverage on white (exact tint transforms: later stage).
    const n = family === "Separation" ? 1 : obj.get(1).length;
    const name = family === "Separation" ? obj.get(1).asName() : "";
    if (name === "None") return { n, conv: () => null };
    return { n, approx: true, conv: (c) => { const t = Math.min(1, c.reduce((a, b) => a + b, 0)); return [1 - t, 1 - t, 1 - t]; } };
  }
  return { n: 1, unknown: true, conv: (c) => [c[0], c[0], c[0]] };
}

// ---------------------------------------------------------------- shading patterns

/** Map a sampled/exponential/stitching function's colour stops. Returns new direct dict or null. */
function mapFunction(doc, fobj, n, fn) {
  const f = R(fobj);
  const type = f.get("FunctionType").asNumber();
  const d = doc.newDictionary();
  f.forEach((v, k) => d.put(k, v));
  if (type === 2) {
    for (const key of ["C0", "C1"]) {
      const arr = f.get(key);
      const comps = arr.isArray() ? [...Array(arr.length).keys()].map((i) => arr.get(i).asNumber()) : (key === "C0" ? [0] : [1]);
      if (comps.length !== n) return null;
      const rgb = n === 1 ? [comps[0], comps[0], comps[0]] : n === 3 ? comps : n === 4 ? cmykToRgb(...comps) : null;
      if (!rgb) return null;
      const m = fn(rgb);
      const outArr = doc.newArray();
      if (n === 1) outArr.push((m[0] + m[1] + m[2]) / 3);
      else if (n === 3) m.forEach((v) => outArr.push(v));
      else return null; // CMYK output not supported in prototype
      d.put(key, outArr);
    }
    return d;
  }
  if (type === 3) {
    const fs = f.get("Functions");
    const arr = doc.newArray();
    for (let i = 0; i < fs.length; i++) { const sub = mapFunction(doc, fs.get(i), n, fn); if (!sub) return null; arr.push(sub); }
    d.put("Functions", arr);
    return d;
  }
  return null; // sampled (0) / PostScript (4): kept as-is
}

/** Create (cached) a colour-remapped copy of a shading pattern. Returns new resource name or null. */
function remapPattern(ctx, resources, name, mode, fn) {
  const pdict = resources.get("Pattern");
  if (!pdict.isDictionary()) return null;
  const ref = pdict.get(name);
  if (ref.isNull()) return null;
  const key = (ref.isIndirect() ? ref.asIndirect() : name) + "|" + mode;
  const newName = name + "_dk" + mode;
  if (ctx.patternCache.has(key)) {
    const r = ctx.patternCache.get(key);
    if (r) pdict.put(newName, r);
    return r ? newName : null;
  }
  const doc = ctx.doc;
  let result = null;
  const p = R(ref);
  if (p.get("PatternType").toString() === "2") {
    const sh = R(p.get("Shading"));
    const csInfo = colorSpaceFromObject(sh.get("ColorSpace").isName() ? sh.get("ColorSpace") : R(sh.get("ColorSpace")), resources);
    const st = sh.get("ShadingType").asNumber();
    if ((st === 2 || st === 3) && !sh.get("Function").isNull() && !csInfo.unknown && !csInfo.approx) {
      const nf = mapFunction(doc, sh.get("Function"), csInfo.n, fn);
      if (nf) {
        const nsh = doc.newDictionary(); sh.forEach((v, k) => nsh.put(k, v)); nsh.put("Function", nf);
        if (csInfo.n === 4) nsh.put("ColorSpace", doc.newName("DeviceRGB"));
        const np = doc.newDictionary(); p.forEach((v, k) => np.put(k, v)); np.put("Shading", doc.addObject(nsh));
        result = doc.addObject(np);
        ctx.stats.patternsRemapped++;
      }
    }
  }
  ctx.patternCache.set(key, result);
  if (!result) { ctx.stats.patternsKept++; return null; }
  pdict.put(newName, result);
  return newName;
}

// ---------------------------------------------------------------- rewriter

const PATH_OPS = new Set(["m", "l", "c", "v", "y", "h", "re", "W", "W*"]);
const PAINT_OPS = new Set(["f", "F", "f*", "B", "B*", "b", "b*", "S", "s", "n"]);

/**
 * @param ctx { mapper, doc, regions, imageRegions, stats, formCache, patternCache, readStream, toBytes }
 */
export function rewriteStream(src, resources, ctx, baseCtm = IDENT, inherit = false) {
  const instrs = tokenize(src);
  const out = [];
  const regions = ctx.regions;

  let gs = {
    ctm: baseCtm,
    fill: inherit ? undefined : [0, 0, 0], stroke: inherit ? undefined : [0, 0, 0],
    fillCS: colorSpaceInfo("DeviceGray"), strokeCS: colorSpaceInfo("DeviceGray"),
    fillPattern: null, strokePattern: null, // pattern resource name when a pattern is selected
    eFill: inherit ? "inherit" : "0 0 0", eStroke: inherit ? "inherit" : "0 0 0", // in effect (mapped)
    tr: 0, fontSize: 1, leading: 0,
  };
  const stack = [];
  let tm = IDENT, tlm = IDENT;

  // current path
  let pending = []; let pathRects = []; let pathOther = false; let pathBox = null; let pathSegs = 0;
  const addPt = (x, y) => {
    const [dx, dy] = apply(gs.ctm, x, y);
    if (!pathBox) pathBox = { x0: dx, y0: dy, x1: dx, y1: dy };
    else { pathBox.x0 = Math.min(pathBox.x0, dx); pathBox.y0 = Math.min(pathBox.y0, dy); pathBox.x1 = Math.max(pathBox.x1, dx); pathBox.y1 = Math.max(pathBox.y1, dy); }
  };
  const flushPath = () => { for (const p of pending) out.push(p); pending = []; pathRects = []; pathOther = false; pathBox = null; pathSegs = 0; };

  const emitRgb = (which, rgb) => {
    const key = rgb.map((v) => v.toFixed(4)).join(" ");
    if (which === "fill") { if (gs.eFill === key) return; gs.eFill = key; out.push({ op: "rg", operands: rgb.map(num) }); }
    else { if (gs.eStroke === key) return; gs.eStroke = key; out.push({ op: "RG", operands: rgb.map(num) }); }
  };
  const emitPattern = (which, pname) => {
    const key = "pattern:" + pname;
    const nm = { type: "name", raw: "/" + pname, value: pname };
    const pat = { type: "name", raw: "/Pattern", value: "Pattern" };
    if (which === "fill") { if (gs.eFill === key) return; gs.eFill = key; out.push({ op: "cs", operands: [pat] }, { op: "scn", operands: [nm] }); }
    else { if (gs.eStroke === key) return; gs.eStroke = key; out.push({ op: "CS", operands: [pat] }, { op: "SCN", operands: [nm] }); }
  };

  function backdropAt(x, y) {
    for (let k = regions.length - 1; k >= 0; k--) {
      const r = regions[k];
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) {
        if (r.keep) return { keep: true };
        if (r.sample) return r.sample(x, y); // { color, changed }
        return { color: r.color, changed: true };
      }
    }
    return null; // page background
  }
  const unchanged = (bd) => bd && (bd.keep || bd.changed === false);

  /** Emit the colour for a fill of the given role. Returns the mapped rgb (if a plain colour). */
  function paintFill(role) {
    let bd = null;
    if (role === "text") {
      const [x, y] = apply(mul(mul([gs.fontSize, 0, 0, gs.fontSize, 0, 0], tm), gs.ctm), 0.25, 0.3);
      if (ctx.analyze) { // analysis pass: only record where light text sits
        if (gs.fill && !gs.fillPattern && rgbL(gs.fill) > 0.6) ctx.textPoints.push([x, y]);
        return null;
      }
      bd = backdropAt(x, y);
      ctx.stats.text++;
    } else if (ctx.analyze) {
      return null;
    } else if (pathBox) {
      bd = backdropAt((pathBox.x0 + pathBox.x1) / 2, (pathBox.y0 + pathBox.y1) / 2);
    }
    if (gs.fillPattern) {
      // Patterns over unchanged content (photo overlays) stay; otherwise remap the gradient stops.
      if (unchanged(bd)) {
        if (process.env.DEBUG_PATTERNS) console.error("pattern kept (unchanged backdrop)", gs.fillPattern, role, JSON.stringify(pathBox), JSON.stringify(bd));
        emitPattern("fill", gs.fillPattern); return { keep: true };
      }
      const back = bd ? bd.color : null;
      const pname = role === "text"
        ? remapPattern(ctx, resources, gs.fillPattern, "T", (c) => ctx.mapper.mapText(c, back))
        : remapPattern(ctx, resources, gs.fillPattern, "P", (c) => ctx.mapper.mapPaint(c));
      emitPattern("fill", pname || gs.fillPattern);
      // Unmappable patterns (tiling textures, sampled functions) are often translucent overlays:
      // do not register them as backdrop.
      if (!pname && process.env.DEBUG_PATTERNS) console.error("pattern not remappable", gs.fillPattern, role, JSON.stringify(pathBox));
      return { mappedPattern: !!pname };
    }
    if (gs.fill === undefined || gs.fill === null) return null;
    let rgb;
    if (role === "text") {
      if (unchanged(bd)) { rgb = gs.fill; ctx.stats.textKept++; }
      else rgb = ctx.mapper.mapText(gs.fill, bd ? bd.color : null);
    } else {
      // A "surface" is a container that carries light text (dark card / banner designed for light
      // text). Such dark surfaces keep their colour; everything else (logos, icons, rules) is mapped.
      const surface = pathBox && pathBox.x1 - pathBox.x0 >= 12 && pathBox.y1 - pathBox.y0 >= 12 &&
        (ctx.textPoints || []).some(([x, y]) => x >= pathBox.x0 && x <= pathBox.x1 && y >= pathBox.y0 && y <= pathBox.y1);
      rgb = surface ? ctx.mapper.mapSurface(gs.fill) : ctx.mapper.mapPaint(gs.fill);
    }
    emitRgb("fill", rgb);
    return { rgb };
  }
  function paintStroke(role) {
    if (ctx.analyze) return;
    if (gs.strokePattern) {
      const pname = remapPattern(ctx, resources, gs.strokePattern, "P", (c) => ctx.mapper.mapPaint(c));
      emitPattern("stroke", pname || gs.strokePattern);
      return;
    }
    if (gs.stroke === undefined || gs.stroke === null) return;
    emitRgb("stroke", role === "text" ? ctx.mapper.mapText(gs.stroke, null) : ctx.mapper.mapPaint(gs.stroke));
  }

  const nums = (ops) => ops.filter((o) => o.type === "number").map((o) => o.value);

  for (const ins of instrs) {
    const { op, operands } = ins;

    // ---- path construction: buffer until the painting operator ----
    if (PATH_OPS.has(op)) {
      const v = nums(operands);
      if (op === "re") { const [x, y, w, h] = v; pathRects.push([x, y, w, h]); addPt(x, y); addPt(x + w, y + h); addPt(x + w, y); addPt(x, y + h); }
      else if (op !== "h" && op !== "W" && op !== "W*") { for (let k = 0; k + 1 < v.length; k += 2) addPt(v[k], v[k + 1]); pathOther = true; }
      if (op !== "W" && op !== "W*") pathSegs++;
      pending.push(ins);
      continue;
    }
    if (PAINT_OPS.has(op)) {
      if (op === "n") { flushPath(); out.push(ins); continue; }
      const fills = !(op === "S" || op === "s");
      const strokes = op === "S" || op === "s" || op.startsWith("B") || op.startsWith("b");
      let res = null;
      if (fills) res = paintFill("fill");
      if (strokes) paintStroke("stroke");
      if (fills && res && pathBox) {
        if (res.keep) regions.push({ ...pathBox, keep: true });
        else if (res.rgb && !pathOther) {
          for (const [x, y, w, h] of pathRects) {
            const p1 = apply(gs.ctm, x, y), p2 = apply(gs.ctm, x + w, y + h);
            regions.push({ x0: Math.min(p1[0], p2[0]), y0: Math.min(p1[1], p2[1]), x1: Math.max(p1[0], p2[0]), y1: Math.max(p1[1], p2[1]), color: res.rgb });
          }
        } else if (res.rgb && (pathBox.x1 - pathBox.x0) * (pathBox.y1 - pathBox.y0) > 400) {
          regions.push({ ...pathBox, color: res.rgb }); // e.g. rounded cards: bbox approximation
        }
      }
      flushPath();
      out.push(ins);
      continue;
    }
    if (pending.length) flushPath(); // malformed stream: path not terminated

    switch (op) {
      case "q": stack.push({ ...gs }); out.push(ins); break;
      case "Q": if (stack.length) gs = stack.pop(); out.push(ins); break;
      case "cm": gs.ctm = mul(nums(operands), gs.ctm); out.push(ins); break;

      // ---- colour setting: record original, drop instruction ----
      case "g": gs.fill = [operands[0].value, operands[0].value, operands[0].value]; gs.fillPattern = null; gs.fillCS = colorSpaceInfo("DeviceGray"); break;
      case "G": gs.stroke = [operands[0].value, operands[0].value, operands[0].value]; gs.strokePattern = null; gs.strokeCS = colorSpaceInfo("DeviceGray"); break;
      case "rg": gs.fill = nums(operands); gs.fillPattern = null; gs.fillCS = colorSpaceInfo("DeviceRGB"); break;
      case "RG": gs.stroke = nums(operands); gs.strokePattern = null; gs.strokeCS = colorSpaceInfo("DeviceRGB"); break;
      case "k": gs.fill = cmykToRgb(...nums(operands)); gs.fillPattern = null; gs.fillCS = colorSpaceInfo("DeviceCMYK"); break;
      case "K": gs.stroke = cmykToRgb(...nums(operands)); gs.strokePattern = null; gs.strokeCS = colorSpaceInfo("DeviceCMYK"); break;
      case "cs": case "CS": {
        const info = colorSpaceInfo(operands[0].value, resources);
        const fill = op === "cs";
        if (fill) { gs.fillCS = info; if (!info.pattern) { gs.fillPattern = null; gs.fill = [0, 0, 0]; } }
        else { gs.strokeCS = info; if (!info.pattern) { gs.strokePattern = null; gs.stroke = [0, 0, 0]; } }
        if (info.approx) ctx.stats.approxColor++;
        break;
      }
      case "sc": case "scn": case "SC": case "SCN": {
        const fill = op === "sc" || op === "scn";
        const info = fill ? gs.fillCS : gs.strokeCS;
        if (info.pattern) {
          const nameOp = operands.find((o) => o.type === "name");
          if (nameOp) { if (fill) gs.fillPattern = nameOp.value; else gs.strokePattern = nameOp.value; ctx.stats.patterns++; }
          break;
        }
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

      // ---- XObjects ----
      case "Do": {
        const name = operands[0].value;
        const xo = resources.get("XObject").get(name);
        if (xo.isNull()) { out.push(ins); break; }
        const obj = R(xo);
        const sub = obj.get("Subtype").asName();
        if (sub === "Image") {
          if (obj.get("ImageMask").toString() === "true") paintFill("fill");
          const reg = ctx.imageRegions.get(xo.isIndirect() ? xo.asIndirect() : -1);
          if (reg) { // unit square -> device space bbox, with pixel sampler for text backdrop
            const m = gs.ctm; const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
            const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
            const inv = invert(m);
            regions.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), sample: (x, y) => { const [u, v] = apply(inv, x, y); return reg.sample(u, 1 - v); } });
          }
        } else if (sub === "Form") {
          const key = xo.isIndirect() ? xo.asIndirect() : -1;
          if (!ctx.analyze && !ctx.formCache.has(key)) {
            ctx.formCache.add(key);
            const fmo = obj.get("Matrix");
            const fm = fmo.isArray() ? [0, 1, 2, 3, 4, 5].map((k) => fmo.get(k).asNumber()) : IDENT;
            const fres = obj.get("Resources").isNull() ? resources : obj.get("Resources");
            const s = rewriteStream(ctx.readStream(xo), fres, ctx, mul(fm, gs.ctm), true);
            xo.writeStream(ctx.toBytes(s));
            ctx.stats.forms++;
          }
          // the form paints with whatever is currently in effect: make sure mapped colours are
          if (gs.fill && !gs.fillPattern) emitRgb("fill", ctx.mapper.mapPaint(gs.fill));
          if (gs.stroke && !gs.strokePattern) emitRgb("stroke", ctx.mapper.mapPaint(gs.stroke));
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
      default: out.push(ins);
    }
  }
  if (pending.length) flushPath();
  return serialize(out);
}

function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
