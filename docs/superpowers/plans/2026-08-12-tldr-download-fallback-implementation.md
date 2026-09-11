# TL;DR Download Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix TL;DR's PDF/DOCX extraction so it still works when Chrome closes the tab after navigating to a document it can't render inline (confirmed real for `.docx` via live testing — Chrome has no native DOCX renderer) — by falling back to checking whether a matching document finished downloading recently, and re-fetching its source URL through the already-existing extraction pipeline.

**Architecture:** `tryReadAsDocument()` in `extension/panel.js` is refactored so its fetch-and-classify step is a separate, reusable function. The tab-URL path uses it exactly as today (falls through silently on failure). A new fallback, engaged only when the tab-URL path finds nothing, queries `chrome.downloads.search()` for a recently-completed PDF/DOCX download and re-fetches its `finalUrl` through the same reusable function — a network failure there gets a distinct, actionable error message instead of the generic "no content found."

**Tech Stack:** Vanilla JS (Chrome extension side panel, MV3), no build step. New manifest permission: `"downloads"`.

**Reference:** `docs/superpowers/specs/2026-08-12-tldr-download-fallback-design.md` (approved design — read it for full rationale, including the `chrome.downloads` API research this plan's code relies on).

## Global Constraints

- No automated test suite or linter exists in this repo — every task's verification step is **manual**: careful code inspection, hand-tracing, and (where useful) standalone Node scripts against the already-existing, unchanged `extractPdfText()`/`extractDocxText()` — not a live browser check (browser automation cannot load unpacked Chrome extensions in this environment, a documented constraint from prior work in this repo).
- `extractPdfText()` and `extractDocxText()` are **not touched** by this plan — they're reused exactly as they are today. Do not modify their internals.
- The tab-URL path's existing observable behavior (fetch `tab.url`, check magic bytes, extract, fall through silently on any failure) must be **unchanged** for callers — this plan only adds a new fallback that engages after that path already returns nothing.
- `PAGE_MAX_CHARS` (`extension/panel.js:9`) and `MAX_DOC_BYTES` (`extension/panel.js:11`) are reused as-is — no new truncation/size logic beyond what already exists.
- Confirmed API facts this plan's code relies on (researched against current Chrome extension docs):
  - `"downloads"` permission alone is sufficient for `chrome.downloads.search()` — no additional host permissions needed for the `chrome.downloads` calls themselves.
  - `chrome.downloads.search({state, orderBy, limit})` is a valid query shape; `orderBy: ['-endTime']` sorts newest-first; `state: 'complete'` is a valid `DownloadItem.State` value.
  - A `DownloadItem` has both `url` (pre-redirect) and `finalUrl` (post-redirect — Chrome 54+, the one that actually served the bytes) — this plan uses `finalUrl`.
  - `chrome.downloads.search()` does not filter by file extension directly in a portably reliable way — filtering by `filename` is done client-side on the small (`limit: 5`) result set.
  - There is no way to read a completed download's file bytes directly through `chrome.downloads` — re-fetching `finalUrl` is the only broadly viable approach (confirmed: no `file://` dependency, no filesystem API used).

---

### Task 1: Download fallback for TL;DR document extraction

**Files:**
- Modify: `extension/panel.js:1-12` (add `DOWNLOAD_FALLBACK_WINDOW_MS` constant near `PAGE_MAX_CHARS`/`MAX_DOC_BYTES`)
- Modify: `extension/panel.js:947-983` (replace `tryReadAsDocument()`, add `fetchAndClassifyDocument()`, `extractDocumentText()`, `findRecentDocumentDownload()`)
- Modify: `extension/manifest.json:6` (add `"downloads"` permission)

**Interfaces:**
- Consumes: `extractPdfText(arrayBuffer)`, `extractDocxText(arrayBuffer)` (pre-existing, unchanged), `PAGE_MAX_CHARS`, `MAX_DOC_BYTES` (pre-existing, unchanged).
- Produces: `tryReadAsDocument(tab)` keeps its existing contract exactly (`Promise<{title, url, text, kind} | null>`, throws only for genuine parse/fetch failures once a document is confirmed) — `readCurrentPage()` (`panel.js:985`) and everything above it (`withPage()`, the `tldr` click handler) needs **no changes at all**.

- [ ] **Step 1: Add the new constant**

In `extension/panel.js`, near the existing `const MAX_DOC_BYTES = 50 * 1024 * 1024;` (currently line 11), add:

```js
const DOWNLOAD_FALLBACK_WINDOW_MS = 2 * 60 * 1000; // how recent a completed download can be to count
```

- [ ] **Step 2: Replace `tryReadAsDocument()` with the refactored version plus its two new helpers**

`extension/panel.js` currently reads (lines 947-983 — verify against the actual current file first, since line numbers may have shifted slightly since this plan was written):

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
    // Don't buffer a whole large binary (installer, dataset, huge scan) into the panel's heap
    // just to look at 4 magic bytes — treat anything oversized as "not a document we handle".
    // Content-Length is absent under chunked encoding; nothing to check then, so carry on.
    if (Number(res.headers.get('content-length')) > MAX_DOC_BYTES) return null;
    buf = await res.arrayBuffer();
  } catch {
    return null;
  }

  const bytes = new Uint8Array(buf.slice(0, 4));
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04; // PK\x03\x04
  if (!isPdf && !isZip) return null;

  // `kind` tells the caller this text came out of a binary document rather than a live page —
  // the TL;DR prompt uses it to drop the "link to a URL on the page" citation rule, which
  // extracted PDF/DOCX text can only satisfy by inventing URLs.
  const text = isPdf ? await extractPdfText(buf) : await extractDocxText(buf);
  return {
    title: tab.title || tab.url,
    url:   tab.url,
    text:  text.slice(0, PAGE_MAX_CHARS),
    kind:  isPdf ? 'pdf' : 'docx',
  };
}
```

Replace it with:

```js
// ── Page reader ───────────────────────────────────────────────────────────
// Fetches `url` and returns its bytes plus a PDF/DOCX magic-number verdict, or `null` if the
// magic bytes don't match either format (Content-Type isn't used for detection — many servers
// send generic application/octet-stream for downloadable files) or the response is too large to
// buffer (Content-Length over MAX_DOC_BYTES — don't materialize a whole installer/dataset/huge
// scan into the panel's heap just to look at 4 bytes; Content-Length is absent under chunked
// encoding, so nothing to check then, carry on). A network/fetch failure (including a non-2xx
// status) THROWS rather than returning null — callers decide what that should mean for them,
// since the tab-URL path and the download-fallback path react to a failed fetch differently.
async function fetchAndClassifyDocument(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_DOC_BYTES) return null;
  const buf = await res.arrayBuffer();

  const bytes = new Uint8Array(buf.slice(0, 4));
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04; // PK\x03\x04
  if (!isPdf && !isZip) return null;

  return { buf, isPdf };
}

// `kind` tells the caller this text came out of a binary document rather than a live page — the
// TL;DR prompt uses it to drop the "link to a URL on the page" citation rule, which extracted
// PDF/DOCX text can only satisfy by inventing URLs.
async function extractDocumentText({ buf, isPdf }) {
  const text = isPdf ? await extractPdfText(buf) : await extractDocxText(buf);
  return { text: text.slice(0, PAGE_MAX_CHARS), kind: isPdf ? 'pdf' : 'docx' };
}

// Looks for a PDF/DOCX download completed in the last DOWNLOAD_FALLBACK_WINDOW_MS — the fallback
// for when Chrome itself doesn't leave a usable tab behind after navigating straight to a
// document URL (it has no native DOCX renderer, so the tab closes once the download starts; the
// same can happen for PDFs if the browser/user has it configured to download instead of view
// inline). chrome.downloads.search() doesn't filter by extension directly, so that's done here
// client-side against the small (limit: 5), already-sorted (newest first) result set.
async function findRecentDocumentDownload() {
  const downloads = await chrome.downloads.search({
    state: 'complete', orderBy: ['-endTime'], limit: 5,
  });
  const cutoff = Date.now() - DOWNLOAD_FALLBACK_WINDOW_MS;
  return downloads.find(d =>
    /\.(pdf|docx)$/i.test(d.filename) && new Date(d.endTime).getTime() >= cutoff) || null;
}

// Attempts to read `tab.url` as a PDF or DOCX document; if that finds nothing (including the
// case where Chrome closed the tab after the navigation resolved to a download), falls back to
// checking whether a matching document finished downloading recently and re-fetching its source
// URL. Returns null for "not a document we handle at all" so the caller falls back to the
// DOM-scrape path below — never throws for that case, only for real parse failures once bytes
// are confirmed to be a PDF/DOCX, or for a download-fallback fetch that fails (a distinct,
// actionable error — the tab-URL path's own fetch failures stay silent/fall-through, matching
// today's existing behavior exactly).
async function tryReadAsDocument(tab) {
  let classified = null;
  try {
    classified = await fetchAndClassifyDocument(tab.url);
  } catch {
    // Network/fetch failure reading the tab's own URL — treated the same as "not a document",
    // matches today's existing fall-through behavior exactly.
  }

  if (classified) {
    const { text, kind } = await extractDocumentText(classified);
    return { title: tab.title || tab.url, url: tab.url, text, kind };
  }

  const download = await findRecentDocumentDownload();
  if (!download) return null;

  let downloadClassified;
  try {
    downloadClassified = await fetchAndClassifyDocument(download.finalUrl);
  } catch {
    throw new Error(
      'The downloaded file\'s source link has expired — try downloading it again.');
  }
  if (!downloadClassified) return null; // filename looked right but the bytes weren't actually a PDF/DOCX

  const { text, kind } = await extractDocumentText(downloadClassified);
  return { title: download.filename.split(/[\\/]/).pop(), url: download.finalUrl, text, kind };
}
```

- [ ] **Step 3: Add the manifest permission**

In `extension/manifest.json`, the `permissions` array (currently line 6) reads:

```json
  "permissions": ["storage", "sidePanel", "tabs", "activeTab", "scripting", "identity", "contextMenus"],
```

Change to:

```json
  "permissions": ["storage", "sidePanel", "tabs", "activeTab", "scripting", "identity", "contextMenus", "downloads"],
```

- [ ] **Step 4: Manually verify**

There is no automated test suite, and browser automation cannot load unpacked Chrome extensions in this environment — verify by careful code inspection and hand-tracing, plus a standalone Node check of the parts that don't need `chrome.*` APIs:

1. `node --check extension/panel.js` for syntax validity.
2. `python3 -c "import json; json.load(open('extension/manifest.json')); print('OK')"` for manifest validity.
3. Hand-trace every branch of the new `tryReadAsDocument()`:
   - Tab URL is a real PDF/DOCX → `fetchAndClassifyDocument(tab.url)` succeeds → returns immediately with `title: tab.title || tab.url` — unchanged from before.
   - Tab URL fetch throws (network error, 404, non-2xx) → caught, `classified` stays `null` → falls through to the download check — matches today's silent fall-through for this case.
   - Tab URL isn't a document (magic bytes don't match) → `classified` is `null` (not thrown) → falls through to the download check — matches today.
   - No matching recent download found → `findRecentDocumentDownload()` returns `null` → `tryReadAsDocument` returns `null` → caller falls through to the unchanged DOM-scrape path, exactly as today.
   - Most recent download is an unrelated file type (e.g. `.zip`, `.png`) → `findRecentDocumentDownload()`'s `/\.(pdf|docx)$/i` regex against `d.filename` correctly excludes it, even if it's more recent than any actual PDF/DOCX download in the last `DOWNLOAD_FALLBACK_WINDOW_MS` — confirm the regex only matches filenames actually ending in `.pdf`/`.docx`, not ones merely containing those substrings elsewhere.
   - Matching recent download found, its `finalUrl` fetch succeeds and is a real PDF/DOCX → returns `{title: <bare filename>, url: finalUrl, text, kind}`.
   - Matching recent download found, but its `finalUrl` fetch fails → throws the specific "source link has expired" `Error`, which propagates through `readCurrentPage()` into `withPage()`'s existing `catch` (`Could not read page: {message}`) — confirm this is a NEW, distinguishable message from the generic "No content found" text the `tldr` handler shows for a null/empty result.
   - Matching recent download found, `finalUrl` fetch succeeds, but bytes aren't actually a PDF/DOCX (misleading filename) → `downloadClassified` is `null` → `tryReadAsDocument` returns `null` → falls through to DOM-scrape, same as "no document at all" — matches the design's stated behavior.
4. Confirm `extractPdfText`/`extractDocxText` are called with the exact same argument shape as before (`{buf, isPdf}` destructured correctly, `buf` is the raw `ArrayBuffer` in both the tab-URL and download-fallback paths) — no behavior change to extraction itself.
5. Confirm nothing above `tryReadAsDocument()` in the call chain (`readCurrentPage()`, `withPage()`, the `tldr` click handler) needed to change — grep for `tryReadAsDocument` to confirm its only caller is unchanged.
6. If a real Chrome instance is available for a quick manual smoke test (not required for this task, but valuable): reload the unpacked extension, navigate to a real `.docx` URL (reproducing the original bug), click TL;DR, confirm it now finds the completed download and summarizes it instead of showing "No content found."

- [ ] **Step 5: Commit**

```bash
git add extension/panel.js extension/manifest.json
git commit -m "Add download fallback to TL;DR when Chrome closes the tab (fixes DOCX)"
```

---

## Post-plan

Update the design spec's `**Status:**` line (`docs/superpowers/specs/2026-08-12-tldr-download-fallback-design.md`) from "Approved, pending implementation" to "Implemented" as part of this task's commit or a follow-up commit.
