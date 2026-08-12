# TL;DR Document Extraction (PDF/DOCX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the extension's TL;DR feature so that when the active tab is a PDF or `.docx` file (not an HTML page), it extracts and summarizes the document's actual text instead of getting nothing from the current DOM-scrape approach.

**Architecture:** `readCurrentPage()` in `extension/panel.js` gains a fetch-and-sniff step before its existing DOM-scrape fallback: fetch the tab's own URL, check the first bytes for a PDF or ZIP (docx) magic number, and if matched, extract text via a vendored pdf.js (PDF) or a hand-rolled ZIP/XML reader (docx) instead of falling through to the unchanged HTML path.

**Tech Stack:** Vanilla JS (Chrome extension side panel, MV3), no build step. One new vendored dependency: Mozilla's pdf.js (ES modules, loaded via dynamic `import()`).

**Reference:** `docs/superpowers/specs/2026-08-12-tldr-document-extraction-design.md` (approved design — read it for full rationale).

## Global Constraints

- No automated test suite or linter exists in this repo (per `CLAUDE.md`) — every task's verification step is **manual**: reload the unpacked extension and exercise the behavior, or (where noted) a standalone Node script against the actual extracted function, not a `pytest`/`jest` run.
- This only changes the `tldr` button's behavior. Translate (`read-page` button), the CVE-selection flow, and `chatbox.html` are untouched.
- Legacy binary `.doc` (OLE format) is out of scope — only modern `.docx` (OOXML/ZIP). Scanned/image-only PDFs (no text layer) are detected and surfaced as a clear error, not silently summarized as empty.
- Truncate all extracted text to `PAGE_MAX_CHARS` (`extension/panel.js:9`, currently `12000`) — same constant the existing HTML path already uses, so the downstream summarization prompt is unaffected.
- pdf.js ships ES-modules-only as of v4.0+ (confirmed against the current release, 6.2.108) — there is no non-module/UMD build to vendor. It's loaded via dynamic `import()` from `panel.js`, which stays a classic script (no `type="module"` conversion).
- No `unsafe-eval` or CSP relaxation is needed — text extraction (`getDocument`/`getTextContent`) doesn't touch pdf.js's PostScript-function-compilation path (rendering/shading only), and even that path uses WebAssembly first, which MV3's baseline extension-page CSP already permits.

---

### Task 1: Vendor pdf.js and wire the manifest

**Files:**
- Create: `extension/vendor/pdfjs/pdf.min.mjs` (downloaded, not hand-written)
- Create: `extension/vendor/pdfjs/pdf.worker.min.mjs` (downloaded, not hand-written)
- Modify: `extension/manifest.json:11` (`web_accessible_resources`)

**Interfaces:**
- Produces: two static files at `chrome.runtime.getURL('vendor/pdfjs/pdf.min.mjs')` and `chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs')`, consumed by Task 2's `extractPdfText()`.

- [ ] **Step 1: Download the current pdf.js build**

```bash
mkdir -p extension/vendor/pdfjs
curl -fL -o extension/vendor/pdfjs/pdf.min.mjs \
  https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.min.mjs
curl -fL -o extension/vendor/pdfjs/pdf.worker.min.mjs \
  https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.worker.min.mjs
```

If `6.2.108` has been superseded by a newer patch/minor release by the time this runs, use the latest `6.x` release instead (check `https://www.npmjs.com/package/pdfjs-dist?activeTab=versions`) — just keep the two downloaded filenames identical (`pdf.min.mjs`, `pdf.worker.min.mjs`) so later tasks' `chrome.runtime.getURL(...)` calls don't need to change. Do not use the `legacy/build/` tree — this extension only targets Chrome, so the plain `build/` tree (smaller, no unneeded old-browser transpilation) is correct.

- [ ] **Step 2: Verify the downloads**

```bash
ls -la extension/vendor/pdfjs/
file extension/vendor/pdfjs/pdf.min.mjs extension/vendor/pdfjs/pdf.worker.min.mjs
```

Expected: both files present, `pdf.min.mjs` roughly 400-550 KB, `pdf.worker.min.mjs` roughly 1.2-1.4 MB, both reported as ASCII/UTF-8 text (JS source), not binary/HTML (an HTML result means the download URL 404'd and returned an error page instead of the file — check the version number if so).

- [ ] **Step 3: Add `web_accessible_resources` entry**

In `extension/manifest.json`, the current `web_accessible_resources` (line 11) reads:

```json
  "web_accessible_resources": [{ "resources": ["config.json"], "matches": ["<all_urls>"] }],
```

Change to:

```json
  "web_accessible_resources": [
    { "resources": ["config.json"], "matches": ["<all_urls>"] },
    { "resources": ["vendor/pdfjs/*"], "matches": ["<all_urls>"] }
  ],
```

- [ ] **Step 4: Verify manifest is valid JSON**

```bash
python3 -c "import json; json.load(open('extension/manifest.json')); print('OK')"
```

- [ ] **Step 5: Commit**

```bash
git add extension/vendor/pdfjs/pdf.min.mjs extension/vendor/pdfjs/pdf.worker.min.mjs extension/manifest.json
git commit -m "Vendor pdf.js for client-side PDF text extraction"
```

---

### Task 2: PDF text extraction

**Files:**
- Modify: `extension/panel.js` (add `extractPdfText()` — place it near `readCurrentPage()`, e.g. directly above it, around line 803)

**Interfaces:**
- Consumes: `chrome.runtime.getURL()` (standard extension API), the vendored files from Task 1.
- Produces: `async function extractPdfText(arrayBuffer)` → `Promise<string>` (full extracted text, untruncated — truncation happens in Task 4's caller). Throws `Error` with a human-readable message for password-protected or textless PDFs. Consumed by Task 4.

- [ ] **Step 1: Add `extractPdfText()`**

In `extension/panel.js`, add this function directly above `async function readCurrentPage() {` (currently line 803):

```js
// Loaded via dynamic import() since pdf.js ships ES-modules-only (no UMD/global build as of
// v4.0+) — panel.js itself stays a classic script, this is the one place that needs `import()`.
async function extractPdfText(arrayBuffer) {
  const pdfjsLib = await import(chrome.runtime.getURL('vendor/pdfjs/pdf.min.mjs'));
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');

  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw new Error('This PDF is password-protected.');
    throw err;
  }

  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page    = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n\n';
  }

  text = text.trim();
  if (!text) {
    throw new Error(
      'This PDF appears to be scanned/image-based with no extractable text — OCR isn\'t supported.');
  }
  return text;
}
```

- [ ] **Step 2: Manually verify — standalone Node script against a real PDF**

There is no automated test suite in this repo, and browser automation cannot load unpacked Chrome extensions in this environment (documented constraint from prior work in this repo) — so verify the extraction logic directly with Node instead of the full extension UI. Node's `import()` works the same way against local `.mjs` files (only `chrome.runtime.getURL()` needs a stand-in, since that's Chrome-extension-only):

```bash
cat > /tmp/test-pdf-extract.mjs <<'EOF'
const pdfjsLib = await import('/absolute/path/to/repo/extension/vendor/pdfjs/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'file:///absolute/path/to/repo/extension/vendor/pdfjs/pdf.worker.min.mjs';

const fs = await import('fs');
const bytes = fs.readFileSync(process.argv[2]); // path to a real PDF, passed as argv
const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
let text = '';
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  text += content.items.map(it => it.str).join(' ') + '\n\n';
}
console.log(`Pages: ${doc.numPages}`);
console.log(`Extracted ${text.trim().length} chars`);
console.log(text.trim().slice(0, 300));
EOF
node /tmp/test-pdf-extract.mjs /path/to/any/real/text-based.pdf
```

(Substitute real absolute paths — this repo's actual path and a real PDF file available in the environment, e.g. `man -t man | ps2pdf - /tmp/test.pdf` on Linux/macOS with ghostscript, or any existing PDF on disk.) Expected: prints a page count and non-empty extracted text that resembles the source PDF's actual content — not garbage/mojibake. If a password-protected or image-only PDF is available, adapt the script to confirm the two specific error paths (`PasswordException` → clear message; empty `getTextContent()` → clear message) trigger correctly.

- [ ] **Step 3: Commit**

```bash
git add extension/panel.js
git commit -m "Add PDF text extraction via vendored pdf.js"
```

---

### Task 3: DOCX text extraction (hand-rolled, no dependency)

**Files:**
- Modify: `extension/panel.js` (add `extractDocxText()` — place it directly below Task 2's `extractPdfText()`)

**Interfaces:**
- Consumes: nothing beyond browser built-ins (`DataView`, `DecompressionStream`, `DOMParser`, `TextDecoder`).
- Produces: `async function extractDocxText(arrayBuffer)` → `Promise<string>` (full extracted text, untruncated). Throws `Error('Couldn\'t read this as a Word document.')` for anything that isn't a well-formed `.docx`. Consumed by Task 4.

- [ ] **Step 1: Add `extractDocxText()`**

In `extension/panel.js`, add this function directly below Task 2's `extractPdfText()`:

```js
// Minimal ZIP reader — extracts one named entry (word/document.xml) via the End-Of-Central-
// Directory record. Central-directory sizes are used (not the local file header's, which can be
// zeroed out under ZIP's optional streaming/data-descriptor mode) so this works regardless of
// which tool wrote the .docx (Word desktop, Word Online, LibreOffice, python-docx, ...).
async function extractDocxText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view  = new DataView(arrayBuffer);
  const NOT_A_DOCX = () => new Error('Couldn\'t read this as a Word document.');

  const EOCD_SIG    = 0x06054b50;
  const searchStart = Math.max(0, bytes.length - 65557); // 22-byte record + up to 65535-byte comment
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= searchStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw NOT_A_DOCX();

  const entryCount    = view.getUint16(eocdOffset + 10, true);
  const centralDirOff = view.getUint32(eocdOffset + 16, true);

  const CENTRAL_SIG = 0x02014b50;
  let offset = centralDirOff;
  let target = null;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIG) break;
    const compMethod  = view.getUint16(offset + 10, true);
    const compSize    = view.getUint32(offset + 20, true);
    const nameLen     = view.getUint16(offset + 28, true);
    const extraLen    = view.getUint16(offset + 30, true);
    const commentLen  = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    if (name === 'word/document.xml') {
      target = { compMethod, compSize, localOffset };
      break;
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  if (!target) throw NOT_A_DOCX();

  // The local file header precedes the actual compressed data; its own name/extra field lengths
  // (which can differ from the central directory's) determine where the data actually starts.
  const localNameLen  = view.getUint16(target.localOffset + 26, true);
  const localExtraLen = view.getUint16(target.localOffset + 28, true);
  const dataStart   = target.localOffset + 30 + localNameLen + localExtraLen;
  const compressed  = bytes.subarray(dataStart, dataStart + target.compSize);

  let xmlBytes;
  if (target.compMethod === 0) {
    xmlBytes = compressed; // stored, no compression
  } else if (target.compMethod === 8) {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    xmlBytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw NOT_A_DOCX(); // unsupported compression method
  }

  const xmlText = new TextDecoder('utf-8').decode(xmlBytes);
  const xmlDoc  = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xmlDoc.getElementsByTagName('parsererror').length) throw NOT_A_DOCX();

  let text = '';
  for (const run of xmlDoc.getElementsByTagNameNS('*', 't')) text += run.textContent + ' ';

  text = text.trim();
  if (!text) throw NOT_A_DOCX();
  return text;
}
```

- [ ] **Step 2: Manually verify — standalone Node script against a real .docx**

Node has `DecompressionStream`, `DOMParser` is not built into Node by default — swap in a minimal manual check instead of the full function for the XML step, or run this verification in a browser console (open `chrome://extensions` → the loaded extension's side panel → DevTools console) where `DOMParser` exists natively. Simplest path: verify the ZIP/decompression half in Node, and the full function (including `DOMParser`) manually once the extension is loaded (Task 4's verification covers that end-to-end). Node-only check for the ZIP + decompression logic:

```bash
cat > /tmp/test-docx-zip.mjs <<'EOF'
import fs from 'fs';
const arrayBuffer = fs.readFileSync(process.argv[2]).buffer;
const bytes = new Uint8Array(arrayBuffer);
const view  = new DataView(arrayBuffer);

const EOCD_SIG = 0x06054b50;
const searchStart = Math.max(0, bytes.length - 65557);
let eocdOffset = -1;
for (let i = bytes.length - 22; i >= searchStart; i--) {
  if (view.getUint32(i, true) === EOCD_SIG) { eocdOffset = i; break; }
}
console.log('EOCD found at', eocdOffset);
const entryCount    = view.getUint16(eocdOffset + 10, true);
const centralDirOff = view.getUint32(eocdOffset + 16, true);
console.log('entries:', entryCount, 'central dir offset:', centralDirOff);

const CENTRAL_SIG = 0x02014b50;
let offset = centralDirOff, target = null;
for (let i = 0; i < entryCount; i++) {
  const compMethod = view.getUint16(offset + 10, true);
  const compSize   = view.getUint32(offset + 20, true);
  const nameLen    = view.getUint16(offset + 28, true);
  const extraLen   = view.getUint16(offset + 30, true);
  const commentLen = view.getUint16(offset + 32, true);
  const localOffset = view.getUint32(offset + 42, true);
  const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
  if (name === 'word/document.xml') { target = { compMethod, compSize, localOffset }; break; }
  offset += 46 + nameLen + extraLen + commentLen;
}
console.log('target:', target);
const localNameLen  = view.getUint16(target.localOffset + 26, true);
const localExtraLen = view.getUint16(target.localOffset + 28, true);
const dataStart  = target.localOffset + 30 + localNameLen + localExtraLen;
const compressed = bytes.subarray(dataStart, dataStart + target.compSize);
const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
const xmlBytes = new Uint8Array(await new Response(stream).arrayBuffer());
const xmlText = new TextDecoder('utf-8').decode(xmlBytes);
console.log('XML length:', xmlText.length);
console.log('Contains <w:t>:', xmlText.includes('<w:t'));
console.log(xmlText.slice(0, 500));
EOF
node /tmp/test-docx-zip.mjs /path/to/any/real.docx
```

Expected: EOCD found at a sane offset near the file's end, `target` is a non-null object with a `compMethod` of `0` or `8`, and the printed XML snippet contains `<w:t` runs with recognizable document text. If no `.docx` file is available in the environment, create one (e.g. any word processor's "Save As .docx", or `libreoffice --headless --convert-to docx` from a plain text file if LibreOffice is installed) before this step — don't skip verification for lack of a fixture.

- [ ] **Step 3: Commit**

```bash
git add extension/panel.js
git commit -m "Add DOCX text extraction via hand-rolled ZIP/XML reader"
```

---

### Task 4: Wire detection into `readCurrentPage()`

**Files:**
- Modify: `extension/panel.js:803-818` (`readCurrentPage()`)

**Interfaces:**
- Consumes: `extractPdfText()` (Task 2), `extractDocxText()` (Task 3), `PAGE_MAX_CHARS` (`panel.js:9`, pre-existing).
- Produces: `readCurrentPage()`'s public contract (`Promise<{title, url, text}>`) is unchanged — `withPage()` (`panel.js:839`) and the `tldr`/`read-page` click handlers need no changes at all.

- [ ] **Step 1: Add `tryReadAsDocument()` and rewire `readCurrentPage()`**

`extension/panel.js` currently reads (lines 803-818):

```js
// ── Page reader ───────────────────────────────────────────────────────────
async function readCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args:   [PAGE_MAX_CHARS],
    func:   (maxChars) => {
      const clone = document.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,nav,footer,aside,iframe').forEach(n => n.remove());
      const text = (clone.body?.innerText || clone.body?.textContent || '')
        .replace(/\s{3,}/g, '\n\n').trim().slice(0, maxChars);
      return { title: document.title, url: location.href, text };
    },
  });
  return result;
}
```

Replace with:

```js
// ── Page reader ───────────────────────────────────────────────────────────
// Attempts to read `tab.url` as a PDF or DOCX document by fetching its raw bytes and checking
// magic numbers (not Content-Type — many servers send generic application/octet-stream for
// downloadable files, which would misdetect a real PDF/DOCX). Returns null for "not a document
// we handle" so the caller falls back to the DOM-scrape path below — never throws for that case,
// only for real parse failures once the bytes are confirmed to be a PDF/DOCX we're supposed to
// be able to read.
async function tryReadAsDocument(tab) {
  let buf;
  try {
    const res = await fetch(tab.url, { credentials: 'include' });
    if (!res.ok) return null;
    buf = await res.arrayBuffer();
  } catch {
    return null;
  }

  const bytes = new Uint8Array(buf.slice(0, 4));
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04; // PK\x03\x04
  if (!isPdf && !isZip) return null;

  const text = isPdf ? await extractPdfText(buf) : await extractDocxText(buf);
  return { title: tab.title || tab.url, url: tab.url, text: text.slice(0, PAGE_MAX_CHARS) };
}

async function readCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');

  const doc = await tryReadAsDocument(tab);
  if (doc) return doc;

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args:   [PAGE_MAX_CHARS],
    func:   (maxChars) => {
      const clone = document.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,nav,footer,aside,iframe').forEach(n => n.remove());
      const text = (clone.body?.innerText || clone.body?.textContent || '')
        .replace(/\s{3,}/g, '\n\n').trim().slice(0, maxChars);
      return { title: document.title, url: location.href, text };
    },
  });
  return result;
}
```

Note: `extractPdfText()`/`extractDocxText()` errors (password-protected, no text layer, corrupt docx) propagate up through `tryReadAsDocument()` → `readCurrentPage()` → `withPage()`'s existing `catch` block (`panel.js:839`), which already shows `Could not read page: {message}` — no new error handling plumbing needed, the specific messages from Tasks 2/3 just flow through it.

- [ ] **Step 2: Manually verify — full extension load**

Reload the unpacked extension (`chrome://extensions` → reload). Open the side panel.

1. Navigate a tab directly to a real PDF URL (Chrome's built-in viewer renders it). Click TL;DR. Confirm it summarizes the PDF's actual content (not an empty/garbage result) and the DevTools console shows no CSP violations or "resource not web accessible" errors for the pdf.js worker.
2. Navigate a tab directly to a real `.docx` URL. Click TL;DR. Confirm it summarizes the document's actual content.
3. Navigate to a regular HTML page (e.g. any news article or docs page). Click TL;DR. Confirm behavior is identical to before this change — this is the most important check, since it's the previously-working path.
4. If available, test a scanned/image-only PDF, a password-protected PDF, and a `.docx`-renamed non-docx file — confirm each shows its specific clear error message (from Tasks 2/3) rather than a crash or silent wrong summary.

- [ ] **Step 3: Commit**

```bash
git add extension/panel.js
git commit -m "Wire PDF/DOCX detection into TL;DR's page reader"
```

---

### Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md` (mention the new vendored dependency and TL;DR's document-extraction behavior)

**Interfaces:**
- None — pure documentation.

- [ ] **Step 1: Document the vendored dependency and behavior change**

In `CLAUDE.md`, find the `extension/panel.js` bullet (in the file-by-file description section) and add a sentence noting: TL;DR now extracts text from PDF/DOCX tabs directly (fetch + magic-number sniff, not Content-Type) via a vendored pdf.js (`extension/vendor/pdfjs/`, ES modules, loaded via dynamic `import()`) for PDF and a hand-rolled ZIP/XML reader for DOCX — the first third-party dependency in the extension, which previously had none (mirrors how `vendor/mcp_forticnapp` is called out for `serve.py` — same "vendored, not a live dependency" framing, but this one is loaded directly in the browser rather than spawned as a subprocess).

Also check the "Key constraints" section — if it documents the extension's dependency posture anywhere (it currently only states this for `serve.py`), add a short line there too so a future session doesn't assume the whole repo (extension included) is dependency-free.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document vendored pdf.js and TL;DR's PDF/DOCX extraction"
```

---

## Post-plan

After Task 5, update the design spec's `**Status:**` line (`docs/superpowers/specs/2026-08-12-tldr-document-extraction-design.md`) from "Approved, pending implementation" to "Implemented", as part of Task 5's commit or a follow-up commit.
