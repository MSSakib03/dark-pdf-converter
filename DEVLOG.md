# Development Log

## Architecture decision (approved)

- **100% free, no server.** All conversion runs in the user's browser (WebAssembly + Web Workers).
  The app is a static site (GitHub Pages / Cloudflare Pages / Vercel Hobby). Documents never leave the device.
- **License:** AGPL-3.0-or-later (required by MuPDF.js; source is public on GitHub).
- **Core libraries:** MuPDF.js (PDF parse/render/write, WASM), fflate (ZIP for DOCX), own colour engine (OKLab).

## Stage 0 — Prototypes & benchmarks (2026-11-18)

All prototypes live in `prototypes/` and run in Node with the same WASM build the browser will use.

### P1/P2/P3 — Vector PDF engine (`prototypes/convert.mjs`, `engine/rewrite.mjs`, `engine/tokenizer.mjs`)

- Content-stream tokenizer + rewriter with graphics-state tracking (q/Q, cm, colour spaces, text state).
- **Lazy colour emission:** original colour operators are dropped; before each painting operator the colour
  mapped for its role (text / fill / stroke / image mask) is emitted. Keeps q/Q semantics exact.
- **Backdrop model:** filled rectangles and placed images are recorded in device space; text colour is
  contrast-checked against what is actually underneath (including sampled image pixels).
- Page background rectangle inserted under the original content.

Results on `ch9.pdf` (Word export, 14 pages, 6 diagram images):

| Metric | Result |
|---|---|
| Extracted text identical to original | 14 / 14 pages |
| Link count identical | 14 / 14 pages |
| Total time (Node, 1 core) | ~1.1 s |
| Size | 839 KB -> 875 KB |

### Colour mapping vs. Microsoft Word dark mode (measured from reference screenshots)

Lightness transfer `T(L) = Lbg + (Ltext - Lbg) * (1 - L)^0.8`, hue kept, chroma x1.5 for darkened tints.

| Light fill | Word dark | Ours | dL (OKLab) |
|---|---|---|---|
| #FFF4D6 | #3E3100 | #3D2F03 | -0.005 |
| #DCE6F1 | #364450 | #333F4C | -0.018 |
| #E8F3E8 | #2B3A2B | #2C392D | 0.000 |

Coloured text is lifted in lightness (hue kept) until it reaches >= 4.5:1 contrast against its backdrop.

### P7 — Image classifier (`engine/images.mjs`)

Signals: border-connected "paper" fraction, flatness, and **solid content** (morphological opening of the
non-paper mask, then connected components kept only if textured).

| Class | Policy | Seen in |
|---|---|---|
| diagram | full smart remap (hue kept, lightness flipped) | all 6 ch9 figures |
| photo-on-paper | remap paper + text drawn on it; keep textured picture regions | all 10 atlas pages |
| photo | keep | — |

Atlas (`Bangladesh-3D-Atlas-preview-Bangla.pdf`, 11 pages of 2160x2700 JPEG + vector overlay):
Bangla headings and body text that are *baked into the JPEG* become light; 3D illustrations are preserved.
~1 s per full-page image in Node (single thread). Text identical on 11 / 11 pages.

Known issues: soft light halo around illustrations (the picture's own drop shadow is kept); white labels
inside illustrations stay white (Word-like behaviour).

### P4 — DOCX path

- LibreOffice WASM (ZetaOffice) is reported at ~300 MB download: **not viable** for a free, mobile-friendly site.
- **DOCX -> Dark DOCX** (`prototypes/docx_dark.mjs`): recolours run colours, shading, borders, highlights,
  DrawingML, theme colours, page background and embedded images. Layout untouched.
  Verified by rendering with desktop LibreOffice: correct. Microsoft Word verification pending (user).

### Not yet covered

- True scanned PDFs (no sample yet), shading/gradient remap, annotation appearance streams,
  transparency groups / blend modes, Type3 glyph colours, mobile performance measurement.
