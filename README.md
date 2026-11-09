# Paperwork

Paperwork is a static PDF editor. Open or drop a local PDF, edit existing text, add text, draw, highlight, outline areas, or cover content with whiteout. The Pages sidebar lets you reorder, rotate, remove, and insert blank pages. Use **Download PDF** to save a copy with the edits applied.

## Deploy

GitHub Pages publishes the app from `main` → [`/docs`](docs/). The HTML, CSS, JavaScript, and bundled PDF libraries in that directory are the complete site. You can also [download the deployable ZIP](https://github.com/zteisberg/pdfer/releases/latest/download/paperwork-static.zip) and publish its contents on another static host.

If your host asks for a publish directory, enter `docs` and leave the build command empty. The app uses relative asset URLs, so it can also live under a path such as `/pdfer/`. Serve `.mjs` files as JavaScript and `.wasm` files as `application/wasm`. No backend, build, credentials, or CDN is required.

For a local preview from the repository root, use either command:

```sh
node scripts/serve.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory docs
```

Visit `http://127.0.0.1:8000` in a current browser and select **Try a sample PDF**. Serve it over HTTP or HTTPS so the browser can load its JavaScript modules and PDF worker.

## How edits work

- PDF files and edits stay in your browser. Download your work before closing or reloading the tab.
- **Edit text** outlines supported text runs. Click a run, change its text, then select **Save text**. Export rewrites the text on the PDF page. The replacement starts at the original position and does not reflow the page, so longer text can overlap nearby content. Scanned images, text inside embedded forms, and some PDF text structures are outside this tool's scope.
- Paperwork tries the original font first. If the font lacks the replacement characters, Paperwork can use Noto Sans for simple text runs, including Latin, Greek, and Cyrillic. **Add text** uses Helvetica with Windows-1252 encoding.
- Marks are added to the page content on export. Whiteout covers content visually. The editing tools are intended for corrections to page content.
- Open an unlocked copy of a password-protected PDF. Editing a signed PDF may invalidate its signature.
- Shortcuts: `V` select, `T` add text, `E` edit existing text, `D` draw, `H` highlight, `R` rectangle, `W` whiteout, `Delete` remove the selected mark, and `Ctrl/Cmd+Z` undo (`Shift` to redo).

The site bundles [PDF.js 6.5.438](https://www.npmjs.com/package/pdfjs-dist/v/6.5.438), [pdf-lib 1.17.1](https://www.npmjs.com/package/pdf-lib/v/1.17.1), [EmbedPDF PDFium 2.15.1](https://www.npmjs.com/package/@embedpdf/pdfium/v/2.15.1), and [Noto Sans](https://github.com/notofonts/noto-fonts/tree/c971829a87e7920f960e7277c3dafd9bedd3c601/hinted/ttf/NotoSans). Their licenses are in `docs/vendor/`.

Run the export tests with `node --test`.
