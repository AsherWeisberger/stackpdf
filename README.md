# StackPDF

Merge and split PDFs in the browser. Files never leave the tab.

No account. No daily cap. No upload. Open `index.html` or host the folder on GitHub Pages.

StackPDF is an original tool and is not affiliated with Smallpdf, iLovePDF, or Adobe.

## Run locally

Open `index.html` in a browser, or serve the folder with any static file server.

pdf-lib 1.17.1 is pinned in `vendor` (jsDelivr copy). Fraunces and Manrope are self-hosted in `vendor/fonts`. PDF bytes are never fetched or posted anywhere.

## Use

1. Add PDFs — drop them on the stage, or tap **Add PDFs**.
2. Reorder the stack with the handle (mouse or touch), or the arrows. Remove anything you do not want.
3. **Merge** combines the stack in list order and downloads `stackpdf-merged.pdf`.
4. Select a file to split it. Tap pages (they look like little sheets), or use All / Odd / Even / a range such as `1-3, 5, 8-10`, then **Extract**. **Every page** writes one PDF per page (zipped when there is more than one).

Password-protected, damaged, and oversized files are refused with a plain-language error. Page counts come from pdf-lib in the tab.

## License

MIT. Copyright 2026 Asher Weisberger.
