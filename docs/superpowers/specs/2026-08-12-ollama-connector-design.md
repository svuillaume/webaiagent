# Ollama Connector — Design

**Date:** 2026-08-12
**Status:** Implemented

## Goal

Add "Ollama" as a fifth option in the extension's AI gateway dropdown (alongside Bifrost, Portkey, LiteLLM, Helicone), so the extension can chat directly against a local Ollama server (default `http://localhost:11434`) with no API key and no external gateway in the path.

## Why this isn't just a dropdown entry

The existing four gateways all work today because they speak — or translate into — Anthropic's Messages API shape: the extension POSTs to `{gateway_url}/v1/messages` and its SSE stream reader (`readStream()`, `extension/panel.js:905`) only understands Anthropic-shaped events (`content_block_delta`/`text_delta`, `message_start`, `message_delta`, etc).

Ollama does not speak that API. It exposes its own native API (`/api/chat`) and an OpenAI-compatible one (`/v1/chat/completions`), both with a different request/response/streaming shape than Anthropic's. Supporting Ollama as a direct connector therefore requires a second client-side request/response translation path in `panel.js`, not just a new entry in the `GATEWAYS` profile map.

Three architectures were considered:
1. **Server-side translation via `serve.py`** (like the existing Headroom `/proxy` routing) — no CSP change, no new browser-side parser, but requires `serve.py` running for chat.
2. **Direct browser-to-Ollama connector** — no `serve.py` dependency for chat; adds a second request/response/streaming code path in `panel.js` and needs a CSP update. **Chosen.**
3. **Document routing through a local LiteLLM proxy pointed at Ollama** — zero engineering cost, but pushes the burden of standing up and maintaining a translation proxy onto the user just to reach local Ollama.

Option 2 was chosen: it keeps the "run one thing locally" simplicity of Ollama itself, matching what a user reaching for Ollama actually wants — no extra proxy process.

## Design

### 1. Gateway profile & UI

`GATEWAYS.ollama` (new entry in `extension/panel.js:35`):
```js
ollama: {
  label:    '🦙 Ollama',
  urlHint:  'http://localhost:11434',
  keyHint:  '',
  keyLabel: '',
  noKey:    true,
  headers: () => ({ 'Content-Type': 'application/json' }),
},
```
`applyGatewayProfile()` hides/disables the key-input row when `profile.noKey` is set. `send()`'s existing `if (!key) { ...; return; }` gate (`panel.js:979`) is skipped when `noKey` is set on the active profile — the `if (!baseUrl)` gate stays, since a target URL is still required.

### 2. Model selection

The model field is currently a static `<select id="model">` of Claude/deepseek names (`extension/panel.html:1472`) — not applicable to Ollama, where installed models are arbitrary and local.

While Ollama is the active gateway:
- On switching to Ollama, and again whenever the URL field changes while Ollama is active, fetch `GET {baseUrl}/api/tags` and repopulate `<select id="model">` from the returned model list.
- The original static option list is captured once at page load and restored verbatim when switching away from Ollama to any other gateway.
- If the fetch fails (Ollama not running, bad URL) or returns zero models, the dropdown shows a single disabled `⚠ no models found` option and status reflects the failure — consistent with how `lw_ready`/`lw_cli` already grey out toolbar buttons elsewhere in this file.

### 3. Request/response translation

Both `send()` call sites (`panel.js:996` main chat, `panel.js:2983` report-generation auto-send) branch on `gw === 'ollama'`:

- **Request:** POST `{baseUrl}/v1/chat/completions` with body:
  ```json
  {
    "model": "<selected model>",
    "messages": [{"role": "system", "content": SYSTEM_PROMPT}, ...history],
    "stream": true,
    "stream_options": {"include_usage": true}
  }
  ```
  No `tools` field is included — `web_search_20260209` is simply absent from this body shape, so Ollama requests never declare it. `history` entries are always plain-string `content` (verified — no image/multi-part content blocks exist anywhere in the current codebase), so no multi-part translation is needed.

- **Response:** a new `readOllamaStream()` function (sibling to `readStream()`) parses OpenAI-compatible SSE chunks — `data: {"choices":[{"delta":{"content":"..."}}]}` per token, a terminal chunk carrying `usage: {prompt_tokens, completion_tokens}` (via `stream_options.include_usage`), ending on `data: [DONE]`. It returns the same `{out, inputTk, outputTk}` shape `readStream()` does, so the rest of `send()` (markdown rendering, token display, history push) is unchanged.

- The request-building and reader-selection logic is factored into one small shared helper used by both call sites, rather than duplicated — mirroring the existing duplication of `gw`/`profile`/`headers` construction between the two sites, but not adding a second copy of new logic.

Because both call sites share this branch, the AI-generated Risk Hunting/CVE report flows (which push a synthetic user turn and call `send(true)`) work over Ollama automatically, with a caveat noted in a code comment that local models may follow `INCIDENT_REPORT_TEMPLATE` less reliably than Claude.

### 4. CSP

`extension/manifest.json`'s `content_security_policy.extension_pages` `connect-src` currently allows only `http://localhost:45321` for plain HTTP (everything else must be `https:`). This becomes `http://localhost:*` — any local port, covering Ollama's default 11434 and custom ports, while still blocking non-localhost HTTP entirely.

### 5. Error handling

Fetch failures (Ollama not running, wrong port, connection refused) surface through `send()`'s existing `catch` block — no new error path needed. `updateInvestigateAvailability()`'s existing Claude-only gate for Cloud Investigation (`el('model').value.startsWith('claude')`, `panel.js:107`) already excludes any Ollama model name, since none start with `claude` — no change needed there.

## Out of scope

- `chatbox.html` (separate standalone browser UI, not the extension) is untouched — not part of the original ask.
- No changes to `serve.py`, `/lql/generate`, or Cloud Investigation — those are unaffected by this feature.
- No dynamic-port autodiscovery beyond the CSP wildcard; the user still types the URL if it's non-default.

## Testing plan

No automated test suite exists in this repo (per `CLAUDE.md`). Verification is manual:
0. **Before anything else — CORS.** Every request from the side panel is cross-origin from `chrome-extension://…`, and the `Content-Type: application/json` body forces a preflight. Some Ollama versions reject that origin outright, which surfaces as an opaque "Failed to fetch" indistinguishable from "Ollama isn't running". If that happens, restart with the origin allowed: `OLLAMA_ORIGINS='chrome-extension://*' ollama serve`. Same class of trap for the address form: use `http://localhost:11434` or `http://127.0.0.1:11434` — both are covered by the manifest's CSP `connect-src`/`host_permissions`, nothing else on plain HTTP is.
1. `ollama serve` + `ollama pull <model>` locally.
2. Load the unpacked extension, open the side panel, switch gateway to Ollama.
3. Confirm the URL field defaults to `http://localhost:11434`, the key input is hidden, and the model dropdown populates from `/api/tags`.
4. Send a chat message; confirm streaming renders correctly and the token counter updates.
5. Switch back to Bifrost; confirm the key field reappears and the model dropdown reverts to the static Claude/deepseek list.
6. Trigger a Risk Hunting LQL report while Ollama is active; confirm it streams a response (quality caveat aside).
7. Check the browser console for CSP violations to confirm the `connect-src` change is sufficient.
8. Stop `ollama serve` and confirm the extension surfaces a clear error rather than hanging.
