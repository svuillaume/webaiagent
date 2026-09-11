# Vendored pdf.js

- **Source:** `pdfjs-dist@6.2.108`, `build/` tree (not `legacy/build/` — this extension only targets Chrome)
  - `https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.min.mjs`
  - `https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.worker.min.mjs`
- **Version:** 6.2.108 (Apache-2.0, Mozilla)
- **Vendored:** 2026-08-12

One-time copy, not a live npm dependency — upgrading means re-downloading both files at the same
version and keeping these filenames (`extension/panel.js` resolves them via
`chrome.runtime.getURL('vendor/pdfjs/…')`). Used only for TL;DR's PDF text extraction
(`extractPdfText()` in `extension/panel.js`); no rendering, no `cmaps/`, no standard-font data are
vendored, so PDFs relying on those (e.g. CJK embedded-CMap fonts) fall back to a generic
"couldn't extract text" error.
