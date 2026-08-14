# StackPDF

Merge and split PDFs in the browser. Files never leave the tab.

No account. No daily cap. No upload. Open index.html or host the folder on GitHub Pages.

StackPDF is an original tool and is not affiliated with Smallpdf, iLovePDF, or Adobe.

## Run locally

Open index.html in a browser, or serve the folder with any static file server, then visit that local URL.

pdf-lib 1.17.1 is pinned in vendor (jsDelivr copy). IBM Plex loads from Google Fonts. PDF bytes are never fetched or posted anywhere.

## Use

1. Drop PDFs onto the stage, or choose files. Multiple files are fine.
2. Reorder the list (drag, or the arrows). Remove anything you do not want.
3. Merge combines the stack in list order and downloads stackpdf-merged.pdf.
4. Split works on the selected file. Type a range (1-3, 5, 8-10) or click pages on the stage, then extract. Every page writes one PDF per page (zipped when there is more than one).

Page counts come from pdf-lib in the tab.

## License

MIT. Copyright 2026 Asher Weisberger.
