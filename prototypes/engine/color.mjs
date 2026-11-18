// Color science core: sRGB <-> OKLab/OKLCH, WCAG contrast, role-based dark mapping.
// All public colors are [r, g, b] in 0..1 (sRGB, gamma encoded).

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function rgbToOklab([r, g, b]) {
  r = toLin(r); g = toLin(g); b = toLin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Returns linear-light RGB (may be out of gamut). */
function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (lin) => lin.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/** OKLCH -> sRGB with chroma reduction to stay in gamut (hue and lightness kept). */
export function oklchToRgb(L, C, h) {
  L = clamp01(L);
  let lo = 0, hi = C;
  let lin = oklabToLinear([L, C * Math.cos(h), C * Math.sin(h)]);
  if (!inGamut(lin)) {
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear([L, mid * Math.cos(h), mid * Math.sin(h)]))) lo = mid; else hi = mid;
    }
    lin = oklabToLinear([L, lo * Math.cos(h), lo * Math.sin(h)]);
  }
  return lin.map((c) => clamp01(toGam(clamp01(c))));
}

export function rgbToOklch(rgb) {
  const [L, a, b] = rgbToOklab(rgb);
  return [L, Math.hypot(a, b), Math.atan2(b, a)];
}

export function relLuminance([r, g, b]) {
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}
export function contrast(c1, c2) {
  const a = relLuminance(c1), b = relLuminance(c2);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
export const rgbToHex = (c) => "#" + c.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();

const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/**
 * Build a mapper for a theme. The lightness transfer T(L) is monotonically decreasing:
 * T(1) = bg lightness, T(0) = text lightness, with a concave curve fitted to
 * Microsoft Word's measured behaviour (L 0.97->0.32, 0.95->0.33, 0.92->0.38).
 */
export function createMapper(theme, opts = {}) {
  const bg = hexToRgb(theme.bg);
  const text = hexToRgb(theme.text);
  const bgL = rgbToOklab(bg)[0];
  const textL = rgbToOklab(text)[0];
  const gamma = opts.curve ?? 0.8;            // fitted exponent
  const chromaGain = opts.chromaGain ?? 1.5;  // Word boosts chroma of darkened fills
  const minTextContrast = opts.minTextContrast ?? 4.5;
  const cache = new Map();

  const T = (L) => bgL + (textL - bgL) * Math.pow(clamp01(1 - L), gamma);

  /** Generic paint mapping (fills, strokes, pixels). */
  function mapPaint(rgb) {
    const [L, C, h] = rgbToOklch(rgb);
    if (C < 0.004) {
      // neutral: pure lightness inversion onto the theme's neutral axis
      const t = Math.pow(clamp01(1 - L), gamma);
      return bg.map((v, i) => v + (text[i] - v) * t);
    }
    const inv = T(L);
    // vivid mid-tone colours keep their identity; pale tints invert
    const vivid = smoothstep(0.06, 0.16, C);
    const keepL = Math.min(Math.max(L, 0.5), 0.82);
    const Lout = inv + (keepL - inv) * vivid;
    const gain = Lout < L ? 1 + (chromaGain - 1) * (1 - vivid) : 1;
    return oklchToRgb(Lout, C * gain, h);
  }

  /** Ensure foreground has at least `target` contrast against backdrop, moving only lightness. */
  function ensureContrast(fg, backdrop, target = minTextContrast) {
    if (contrast(fg, backdrop) >= target) return fg;
    const [L, C, h] = rgbToOklch(fg);
    const bL = rgbToOklab(backdrop)[0];
    const tryDir = (up) => {
      let lo = L, hi = up ? 1 : 0, best = null;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        const c = oklchToRgb(mid, C, h);
        if (contrast(c, backdrop) >= target) { best = c; hi = mid; } else lo = mid;
      }
      return best;
    };
    const first = tryDir(bL < 0.6);
    if (first) return first;
    const second = tryDir(!(bL < 0.6));
    if (second) return second;
    return bL < 0.6 ? [1, 1, 1] : [0, 0, 0];
  }

  function mapText(rgb, backdrop) {
    const key = rgb.join(",") + "|" + (backdrop ? backdrop.join(",") : "");
    let r = cache.get(key);
    if (!r) {
      const base = mapPaint(rgb);
      r = ensureContrast(base, backdrop ?? bg);
      cache.set(key, r);
    }
    return r;
  }

  return { bg, text, bgL, textL, T, mapPaint, mapText, ensureContrast };
}
