# PDF Compiler

A static web app for merging, reordering and compressing PDF files. Everything runs in the browser and no file is ever uploaded.

## Features

- Add PDFs (about 50) by dropping them on the page or with the file picker
- Reorder by dragging, with the ↑/↓ buttons, Sort A→Z or Reverse
- Merge everything into one PDF, or compress a single PDF on its own
- Three compression modes:
  - **Lossless**: copies the original pages unchanged (text stays selectable) and re-saves them with compressed object streams. Savings are modest (0–20%).
  - **Medium** (150 DPI, JPEG 70%) and **Strong** (100 DPI, JPEG 50%): each page is turned into a JPEG image. Scanned or image-heavy files get much smaller, but text can no longer be selected. Resolution and quality can be fine-tuned.

## Limitations

- When merging, bookmarks and form fields from the source files are not kept. A single file compressed in Lossless mode keeps them.
- Password-protected PDFs are rejected.
- The image modes can make files that are mostly text *larger*. The app says so when that happens.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then select `main` and `/ (root)`.
3. The app will be at `https://<user>.github.io/<repo>/`.

There is no build step. The libraries are saved in `vendor/`, so the app needs no CDN:

| Library | Version | Use |
|---|---|---|
| [pdf-lib](https://pdf-lib.js.org/) | 1.17.1 | merging and writing PDFs |
| [pdf.js](https://mozilla.github.io/pdf.js/) | 3.11.174 | thumbnails and page rendering |
| [SortableJS](https://sortablejs.github.io/Sortable/) | 1.15.2 | drag-and-drop reordering (works on touch screens) |

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

The app has to be served over HTTP. Opening `index.html` directly from disk won't load the pdf.js worker.
