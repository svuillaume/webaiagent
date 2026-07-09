# Progress stepper for Assisted Investigation & Cloud Investigation

## Problem

Both features show a decorative sailboat animation (`.lql-boat`/`.lql-wake`, `startSailing`/`stopSailing` in `extension/panel.js`) while a request is in flight, with no indication of real progress. Cloud Investigation (`/mcp/investigate`) already streams NDJSON tool-call events, but the client never turns those into a progress signal. Assisted Investigation (`/lql/generate`) is worse: it's a single blocking call that can silently retry up to 20 times server-side before responding at all — the browser has zero visibility into how far along it is.

## Design

### Visual

A segmented stepper replaces the sailboat in both drawers, directly below the existing status-line text (`investigating…`, `🔧 tool_name…`, `validating query…` — unchanged). Segments fill green as steps complete; the current segment pulses red; unfilled segments stay dark (`--dim`-toned). A client-side "Ns elapsed" ticker sits under the stepper (`setInterval`, independent of the server).

- **Cloud Investigation**: 6 segments, 1:1 with its real 6-tool-call budget.
- **Assisted Investigation**: 8 segments (fixed), scaled against the real 20-attempt budget via `ceil(attempt/max × 8)`. The exact "attempt N/20" text stays authoritative in the status label; segments are a proportional visual, not a literal per-attempt count (20 slivers don't fit a ~350px side panel).

### Backend — `/lql/generate` becomes streaming

Converted to NDJSON streaming, mirroring `/mcp/investigate`'s existing `emit()` pattern (`serve.py:1669-1680`): `Content-Type: application/x-ndjson`, same CORS headers, same cache-replay-recorded-events approach (`_lql_cache` stores the full event list, not just the final payload; a cache hit replays it verbatim). HTTP status is always `200` — success/failure is signaled by the last event's `type`, matching how `/mcp/investigate` already behaves.

**New event schema:**
- `{"type":"attempt","attempt":N,"max":20,"phase":"asking_claude"|"validating"|"running"}` — emitted at each phase transition inside the existing retry loop (`serve_lql_generate`'s `for attempt in range(MAX_RETRIES)` loop, ~`serve.py:2408`)
- `{"type":"final", ...}` — same exact payload shape `/lql/generate` returns today on success (`queryId`/`queryText`/`rows`/`count`/`total`/`api_enrichment`/`searchTerm`/`cached`) — the result-handling code on the client is otherwise unchanged
- `{"type":"error","error":"..."}` — replaces today's HTTP 500 body; triggers the same scoping-conversation fallback (`_startLqlScopingConversation`) that already exists on a thrown error

### Frontend

- `extension/panel.js`'s `/lql/generate` fetch switches from `await res.json()` to a streaming NDJSON reader, reusing the same read-loop shape already written for `runCloudInvestigation()` (`panel.js:2861-2883`).
- New shared stepper component (markup + CSS) replaces `.lql-boat`/`.lql-wake` in both drawers in `extension/panel.html`.
- New shared JS helper (replacing `startSailing`/`stopSailing`) drives the stepper: sets segment count, fills segments up to the current step, toggles the pulsing class on the active segment, starts/stops the elapsed-time ticker.
- `runCloudInvestigation()`'s existing per-event handling gets a call into this helper on each `tool_call` event (step = number of tool calls seen so far, out of 6).
- The `/lql/generate` click handler gets the same on each `attempt` event (step = event's `attempt`, out of event's `max`, scaled to 8 segments).

### Error handling

- Stream-level `error` event → same `catch`/scoping-conversation path that exists today (previously triggered by a thrown `Error` from a non-200 or `data.error` body).
- Network-level fetch failure (connection refused, etc.) → same outer `catch` block, unchanged.
- Cache-hit replay emits all recorded events back-to-back almost instantly (same as `/mcp/investigate` today) — the stepper will visibly flash through rather than animate slowly. This mirrors existing Cloud Investigation cache behavior and is not something this change needs to smooth over.

### Cleanup

`startSailing`, `stopSailing`, `.lql-boat`/`.lql-wake` CSS and `@keyframes boat-rock`/`boat-sail` in `panel.html`, and the boat/wake-trail DOM elements (`lql-gen-boat`, `lql-gen-wake-trail`, `investigate-boat`, `investigate-wake-trail`) are all deleted — nothing else references them.

## Out of scope

- No change to the actual retry/validation logic, `MAX_RETRIES`, or `MAX_ITERATIONS` values.
- No true ETA/time-remaining prediction — attempt counts vary too widely (most queries succeed in 1-3 attempts out of a 20 max) to make a fabricated time estimate meaningful. The elapsed-time ticker plus a bounded step count is the honest version of "how long will this take."
