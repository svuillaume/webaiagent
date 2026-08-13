# TL;DR Download Fallback for PDF/DOCX — Design

**Date:** 2026-08-12
**Status:** Implemented

## Goal

Fix a real bug discovered via live testing in the just-shipped TL;DR PDF/DOCX extraction feature (`docs/superpowers/specs/2026-08-12-tldr-document-extraction-design.md`): navigating directly to a `.docx` URL doesn't leave a usable tab behind for `tryReadAsDocument()` to read, because Chrome has no native DOCX renderer and closes the tab once the navigation resolves to a download with nothing to display. PDF is unaffected (Chrome renders PDFs natively, the tab stays open) — this is a DOCX-specific (and, generalized, "any document Chrome decides to download instead of display") gap.

**Scope:** restore the *originally approved* scope — "the current tab is the document, reached by direct navigation" — for the case where Chrome's own handling of that navigation doesn't leave a live tab behind. This does **not** reopen document-viewer pages (Google Docs, Office Online, SharePoint's `:w:` viewer links) as in-scope; those remain explicitly out of scope, as decided in the original design. A completed download and a live viewing session in someone else's web app are different things — this spec only addresses the former.

## Why this needs `chrome.downloads`, not a DOM/tab fix

Once Chrome closes the tab, there is nothing left in the tab/DOM/`chrome.tabs` surface for the extension to read — this isn't fixable by reading `tab.url` faster or differently. Research into `chrome.downloads` (current as of the API's stable Manifest V3 surface) confirmed:

- There is no way to read a completed download's file bytes directly through the `chrome.downloads` API (no such method exists — `getFileIcon()` returns an icon, not content; `open()` launches the OS handler, not bytes).
- `file://` access to the locally-downloaded copy is heavily restricted (requires the user to manually enable "Allow access to file URLs" per-extension in `chrome://extensions`, plus `file://` host permissions) — not something to depend on.
- The only broadly viable approach is: detect that a matching download completed, get its **source URL** (`finalUrl` — the URL after redirects, i.e. the one that actually served the bytes) from the `DownloadItem`, and re-fetch that URL through the extension's existing `fetch()`-based pipeline — the same one already built and reviewed for the tab-URL case.

This means the fix reuses `extractPdfText()`/`extractDocxText()` and the magic-byte verification **completely unchanged** — only the *source of the URL to fetch* changes (from `tab.url` to a recent download's `finalUrl`), when the tab-URL path comes up empty.

**Known, accepted risk:** re-fetching `finalUrl` some time after the download completed can fail if the link was signed/time-limited (S3 presigned URLs, some SharePoint/OneDrive download links can be short-lived or single-use). Plain web servers and Google-Drive-style stable share links are low-risk; enterprise document portals using signed URLs are a real, not-hypothetical failure mode. This spec treats it as an explicit, distinctly-messaged error case (§4) rather than something to solve — minimizing the re-fetch delay (checking immediately when TL;DR is clicked, not on a delay) is the only mitigation, and it's inherent to the on-demand trigger model already chosen.

## Design

### 1. Trigger model

On-demand only — clicking TL;DR still drives everything, exactly as today. No new passive/automatic behavior, no new UI surface, no background service-worker listener. Because the check happens synchronously at click-time (not via a live `chrome.downloads.onChanged` listener), none of Manifest V3's service-worker wake-reliability concerns for background listeners apply here — this is a plain, one-shot `chrome.downloads.search()` call made directly from `panel.js` when needed, no `background.js` changes at all.

### 2. Flow

`tryReadAsDocument(tab)` (`extension/panel.js`) gains a fallback path. Today it does: fetch `tab.url` → check magic bytes → extract or return `null`. The fallback only engages when that returns `null` (i.e., `tab.url` isn't currently a PDF/DOCX — including the "tab closed/navigated away after a download" case, which looks the same as "not a document" from this function's point of view):

1. Call `chrome.downloads.search({ state: 'complete', orderBy: ['-endTime'], limit: 5 })`.
2. Filter results to those whose `filename` ends in `.pdf` or `.docx` (case-insensitive) **and** whose `endTime` is within the last 2 minutes (generous for realistic navigate → switch to side panel → click timing; bounded enough to avoid resurfacing a forgotten older download).
3. Take the single most recent match (already sorted by `-endTime`; first filtered result). No match → proceed to today's unchanged HTML DOM-scrape fallback (and, ultimately, today's unchanged "No content found" message if that's also empty) — this function's contract of "never throw for not-a-document, only for real parse failures" is unchanged.
4. Re-fetch that download's `finalUrl` via the same `fetch(url, { credentials: 'include' })` pattern already used for `tab.url`, with the same `Content-Length` size guard (§ from the original spec, unchanged — reuse, don't reimplement).
5. Run the fetched bytes through the exact same magic-byte check → `extractPdfText()`/`extractDocxText()` pipeline already in place. This is the authoritative check — if `search()`'s filename-based filtering guessed wrong (unlikely but possible, e.g. a misnamed file), the magic-byte check and the extractors' own error handling catch it exactly as they do today for the tab-URL path.

### 3. Filtering & candidate selection

`chrome.downloads.search()`'s query filters by `state`, but not by filename extension directly in a single call in a way that's reliably portable across all matcher options — filtering by `filename`/`endTime` is done client-side on the (small, `limit: 5`) result set. No persistence, no dedup tracking: each TL;DR click re-runs this fresh. This is intentionally simple because the trigger model (§1) is on-demand, not passive — there's no "have I already offered this download" state to track, unlike a passive-notification design would need.

### 4. Error handling

- No recent matching download found → falls through to the existing HTML-scrape path and, ultimately, the existing "No content found" message — no new error surface for this case, it's just today's existing fallback chain with one more link in it.
- A matching recent download is found, but re-fetching its `finalUrl` fails (network error, or a non-2xx response — the expired-signed-URL case) → surface a distinct message: "The downloaded file's source link has expired — try downloading it again." This is different from "no content found" because the situation is different and actionable differently (re-download vs. "there's nothing here").
- Bytes are fetched successfully but don't match a PDF/DOCX magic number, or extraction throws → identical to today's existing handling for the tab-URL case (falls through / surfaces the extractor's specific error message).

### 5. Manifest changes

Add `"downloads"` to `extension/manifest.json`'s `permissions` array. This is the only manifest change needed — no new host permissions or CSP changes (the re-fetch uses the same `fetch()` call already covered by existing `host_permissions`/`connect-src`). This is a real, user-visible permission addition (Chrome discloses "Manage your downloads" access) — approved explicitly as part of this design, not a silent addition.

## Out of scope

- Document-viewer pages (Google Docs, Office Online, SharePoint `:w:` viewer links, etc.) — still out of scope, unchanged from the original spec. This fix only restores the direct-navigation-to-raw-file case for downloads Chrome itself completes.
- Any passive/automatic "a document was downloaded" notification UI — the on-demand trigger model (§1) was deliberately chosen over this.
- Handling of expired/signed download URLs beyond a clear error message — no retry logic, no re-authentication flow.
- `file://` access to the locally-downloaded copy — deliberately avoided per the research (§ "Why this needs `chrome.downloads`").
- Legacy binary `.doc`, OCR for scanned PDFs — unchanged exclusions from the original spec.

## Testing plan

No automated test suite exists in this repo (per `CLAUDE.md`). Verification is manual:

1. Navigate directly to a real `.docx` URL (reproducing the originally-reported bug) → confirm the tab closing no longer breaks TL;DR — it should now find the completed download and summarize it correctly.
2. Same for a real `.pdf` URL where the browser is configured/forced to download rather than view inline (e.g. via a `Content-Disposition: attachment` response header) → confirm the same fallback kicks in for PDF too.
3. Click TL;DR on an ordinary HTML page with no relevant recent downloads → confirm behavior is unchanged from today (regression check).
4. Click TL;DR shortly after downloading an unrelated file type (e.g. a `.zip` or `.png`) → confirm it's correctly ignored (falls through to HTML-scrape/"No content found", not misdetected).
5. If a genuinely expired/signed URL scenario can be reproduced (e.g. a short-lived presigned link), confirm the distinct "source link has expired" message appears rather than a generic failure.
6. Confirm the new `"downloads"` permission doesn't trigger any unexpected Chrome permission-escalation prompt beyond the normal one-time disclosure when the extension is reloaded.
