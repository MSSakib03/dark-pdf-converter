# Dark PDF Converter

Convert PDF, scanned PDF and Word (DOCX) documents to **Dark Mode** — free, private, and entirely in your browser.

**Live:** https://mssakib03.github.io/dark-pdf-converter/

- **Not a colour inverter.** Every element is recoloured by its role: page background, body text, coloured text,
  table shading, borders, gradients, diagrams, photos and scanned pages each get their own treatment.
- **Text stays text.** Digital PDFs are rewritten at the vector level: text remains selectable and searchable,
  links and bookmarks keep working, fonts (including Bangla and other complex scripts) are untouched.
- **Photos keep their colours.** Diagrams and white image backgrounds turn dark; photographs are preserved.
- **Scanned books look natural.** Yellowed paper, uneven lighting and bleed-through are cleaned up; ink becomes
  light, coloured stamps and handwriting keep their hue, covers are kept as pictures.
- **Word documents** are converted to a dark DOCX: colours change, the layout stays exactly as in Word.
- **15 themes + custom colours**, including a theme calibrated against Microsoft Word's own dark mode.
- **Private by design.** No uploads, no server, no tracking. Processing runs locally with WebAssembly
  ([MuPDF](https://mupdf.com/)) inside Web Workers.

## Run locally

Requirements: [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone https://github.com/MSSakib03/dark-pdf-converter.git
cd dark-pdf-converter
npm install
npm run dev
```

Open the address printed in the terminal (normally http://localhost:5173/dark-pdf-converter/).

Production build:

```bash
npm run build
npm run preview
```

### Command line

The same engine can be used from the terminal:

```bash
node tools/cli.mjs input.pdf output-dark.pdf word
```

Theme ids: `word`, `amoled`, `deep-black`, `dark-gray`, `standard-gray`, `charcoal`, `soft-dark`, `warm-dark`,
`sepia-dark`, `cool-dark`, `blue-dark`, `midnight`, `green-dark`, `high-contrast`, `night-red`.

## How it works

| Input | Method |
|---|---|
| Digital PDF | Content-stream rewrite with graphics-state tracking. Colours are mapped in OKLab by role; text is contrast-checked against what is actually underneath it (shapes, images, gradients). Already-dark pages are left as they are. |
| Images in PDFs | Classified as diagram / photo-on-paper / photo. Diagrams are remapped, paper backgrounds inside illustrations become dark, photos are kept. |
| Scanned PDF | Paper and illumination map → normalisation → soft ink mask → theme colours. Coloured ink keeps its hue; covers and photo pages are kept. |
| DOCX | Run colours, shading, borders, highlights, theme colours, page background and embedded images are recoloured in the document XML. |

Development notes and measurements are in [DEVLOG.md](DEVLOG.md).

## Known limitations

- Digital signatures become invalid after conversion (the content changes). A warning is shown next to the converted file.
- DOCX → dark PDF is not done in the browser. Export a PDF from Word (File → Save as → PDF) and convert that PDF.
- Faded halftone photos inside scanned text pages are not always detected.
- Very large documents depend on the memory of your device.

## Deploying your own copy

The site is a static build. Pushing to `main` runs `.github/workflows/deploy.yml`, which builds the site and
publishes it to GitHub Pages (Settings → Pages → Source: **GitHub Actions**). If the repository has a different
name, set `BASE_PATH=/<name>/` for the build.

## License

[GNU AGPL-3.0-or-later](LICENSE). The PDF engine uses [MuPDF.js](https://github.com/ArtifexSoftware/mupdf.js)
(AGPL-3.0). If you host a modified version, you must offer its source code to your users.
