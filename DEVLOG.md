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
  Verified by rendering with desktop LibreOffice and in Microsoft Word (project owner): correct.

### Stage 0, round 2 — more samples (handbook, two scanned books)

New engine capabilities:

- **Shading / gradient remap:** axial and radial shadings (Function type 2 and stitching type 3) get a
  remapped copy; text gradients are contrast-checked, gradients over photos are kept.
- **Path buffering:** colour operators are now emitted before path construction (PDF-spec compliant).
- **Already-dark pages** (>50% dark pixels in a 20 dpi render) are left untouched (QR codes stay scannable).
- **Dark surfaces:** a two-pass analysis finds dark containers that carry light text (cards, banners);
  they keep their colour. Logos and icons without text on them are still mapped.
- **Text over unchanged content** (photos, overlays) keeps its designed colour.
- **Scanned-page pipeline** (`engine/scan.mjs`): paper/illumination map -> normalisation -> soft ink
  mask (removes bleed-through) -> theme LUT. Coloured inks (stamps, red handwriting) keep their hue.
  Picture pages (covers: large photo area or coloured paper) are kept and dimmed.
- **Scan vs. digital artwork:** a page is treated as a scan only if it is image-only *and* its paper is
  not pure white (90th percentile luminance < 0.975).

Regression set (Node, single thread):

| Sample | Pages | Time | Size | Text identical | Links | Notes |
|---|---|---|---|---|---|---|
| ch9 (Word export) | 14 | 1.6 s | 839 -> 875 KB | 14/14 | 14/14 | |
| atlas (image-heavy, Bangla) | 11 | 18.7 s | 8.6 -> 9.2 MB | 11/11 | 11/11 | |
| handbook (Chrome/Skia, Bangla) | 8 | 2.6 s | 2.2 -> 2.4 MB | 8/8 | 8/8 | 2 dark pages kept, 101 gradients remapped |
| scanned book 1 | 10 | 13.6 s | 8.7 -> 5.1 MB | 10/10 | 10/10 | cover kept as picture page |
| scanned book 2 | 16 | 19.2 s | 11.3 -> 7.4 MB | 16/16 | 16/16 | green cover kept |

DOCX -> Dark DOCX was verified in Microsoft Word by the project owner: correct.

Known issues after round 2:

- Faint speckles where bleed-through was strongest (needs a small despeckle on the ink mask).
- Low-contrast halftone photos inside text pages are only partly detected; picture-page fallback is
  page-level. A per-page override (Auto / Keep / Invert) will be exposed in the UI.

### Not yet covered

- Annotation appearance streams, transparency groups / blend modes, Type3 glyph colours,
  tiling patterns, sampled-function shadings, mobile performance measurement.
