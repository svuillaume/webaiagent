# Ollama Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Ollama" as a fifth AI gateway option in the extension so it can chat directly against a local Ollama server (default `http://localhost:11434`) with no API key and no external gateway in the path.

**Architecture:** New `GATEWAYS.ollama` profile drives a second client-side request/response translation path in `extension/panel.js` — Ollama's OpenAI-compatible `/v1/chat/completions` endpoint instead of Anthropic's `/v1/messages`, and a new `readOllamaStream()` SSE parser sibling to the existing `readStream()`. The two existing `fetch('${baseUrl}/v1/messages')` call sites (`send()` and `_startLqlScopingConversation()`) branch through one shared request-builder helper. Model selection switches from the static Claude/deepseek `<select>` to a dynamically fetched list from Ollama's `/api/tags`.

**Tech Stack:** Vanilla JS (Chrome extension side panel), no build step, no framework — matches the rest of `extension/panel.js`.

**Reference:** `docs/superpowers/specs/2026-08-12-ollama-connector-design.md` (approved design — read it for the full rationale, especially "Why this isn't just a dropdown entry").

## Global Constraints

- No automated test suite or linter exists in this repo (per `CLAUDE.md`) — every task's verification step is **manual**: reload the unpacked extension in `chrome://extensions` and exercise the behavior, not a `pytest`/`jest` run.
- `serve.py` must not be touched by this feature — Ollama is a pure client-side connector (per design spec, "Out of scope").
- `chatbox.html` (the standalone non-extension UI) is untouched (per design spec, "Out of scope").
- The extension's CSP (`extension/manifest.json`) restricts `connect-src` — any new fetch target must be added there.
- `history` entries are always plain-string `content` — no multi-part/image content blocks exist anywhere in the current codebase, so no multi-part translation is needed for Ollama requests (verified in the design spec).
- **Resolved during planning (deviates from one detail in the design spec):** `#url-input`/`#key-input` in `extension/panel.html` are currently *permanently* `display:none` for all gateways — there is no existing manual-entry UI; the URL is populated only from `serve.py`'s `/config` or bundled `config.json`. Since Ollama has no `serve.py`/`config.json` awareness, this plan reveals `#url-input` (pre-filled with `http://localhost:11434`) specifically when the Ollama profile is active, and leaves it hidden for the other four gateways exactly as today. `#key-input` stays hidden unconditionally (it already was).

---

### Task 1: Ollama gateway profile, dropdown entry, CSP

**Files:**
- Modify: `extension/panel.js:35-81` (`GATEWAYS` map)
- Modify: `extension/panel.html:1465-1470` (`#gateway` select options)
- Modify: `extension/manifest.json:9` (CSP `connect-src`)

**Interfaces:**
- Produces: `GATEWAYS.ollama` — `{ label, urlHint, keyHint, keyLabel, noKey: true, headers }`, consumed by `applyGatewayProfile()`, `send()`, and `_startLqlScopingConversation()` in later tasks.

- [ ] **Step 1: Add the `ollama` entry to `GATEWAYS`**

In `extension/panel.js`, immediately after the `helicone` entry (currently ends at line 80, right before the closing `};` of `GATEWAYS` at line 81):

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

- [ ] **Step 2: Add the dropdown option**

In `extension/panel.html`, inside `<select id="gateway" class="admin-select" title="AI Gateway">` (line 1465-1470), add after the Helicone `<option>`:

```html
        <option value="ollama">🦙 Ollama</option>
```

- [ ] **Step 3: Widen the CSP to allow any localhost port**

In `extension/manifest.json:9`, change:

```
connect-src https://api.github.com https://raw.githubusercontent.com https: http://localhost:45321;
```

to:

```
connect-src https://api.github.com https://raw.githubusercontent.com https: http://localhost:*;
```

(`host_permissions` at `extension/manifest.json:7` already includes `http://localhost/*`, which Chrome match patterns apply to any port on that host — no change needed there.)

- [ ] **Step 4: Manually verify**

Reload the unpacked extension (`chrome://extensions` → reload). Open the side panel → Admin menu → AI Gateway dropdown. Confirm "🦙 Ollama" appears as a fifth option. Open the DevTools console for the side panel and confirm no CSP-violation errors appear on load.

- [ ] **Step 5: Commit**

```bash
git add extension/panel.js extension/panel.html extension/manifest.json
git commit -m "Add Ollama gateway profile, dropdown entry, and CSP allowance"
```

---

### Task 2: Reveal URL field for Ollama, gate the API-key requirement

**Files:**
- Modify: `extension/panel.html:1437-1438` (add `id="url-label"` to the URL `<label>`)
- Modify: `extension/panel.js:138-143` (`applyGatewayProfile()`)
- Modify: `extension/panel.js:973-998` (`send()` — reorder `gw`/`profile` above the key gate, apply `noKey`)

**Interfaces:**
- Consumes: `GATEWAYS.ollama.noKey` from Task 1.
- Produces: `applyGatewayProfile(gw)` now also toggles `#url-input`/`#url-label` visibility and default-fills the URL — later tasks (model refetch) call this same function on gateway switch.

- [ ] **Step 1: Give the URL label an id**

In `extension/panel.html:1437`, change:

```html
  <label for="url-input" style="display:none">url</label>
```

to:

```html
  <label id="url-label" for="url-input" style="display:none">url</label>
```

- [ ] **Step 2: Toggle URL field visibility and default-fill in `applyGatewayProfile()`**

In `extension/panel.js`, replace the body of `applyGatewayProfile()` (lines 138-143):

```js
function applyGatewayProfile(gw) {
  const p = GATEWAYS[gw] || GATEWAYS.bifrost;
  urlInput.placeholder          = p.urlHint;
  keyInput.placeholder          = p.keyHint;
  el('key-label').textContent   = p.keyLabel;
}
```

with:

```js
function applyGatewayProfile(gw) {
  const p = GATEWAYS[gw] || GATEWAYS.bifrost;
  urlInput.placeholder          = p.urlHint;
  keyInput.placeholder          = p.keyHint;
  el('key-label').textContent   = p.keyLabel;

  // The other four gateways get their URL exclusively from serve.py's /config or the
  // bundled config.json — #url-input stays permanently hidden for them, as it always has.
  // Ollama has no server-side config source, so it's the one profile where the user needs
  // to see and edit this field directly.
  urlInput.style.display        = p.noKey ? '' : 'none';
  el('url-label').style.display = p.noKey ? '' : 'none';
  if (p.noKey && !urlInput.value) urlInput.value = p.urlHint;
}
```

- [ ] **Step 3: Reorder `gw`/`profile` above the key gate in `send()`, and skip the key check for `noKey` profiles**

In `extension/panel.js`, `send()` currently reads (lines 973-998):

```js
async function send(silent = false) {
  if (busy) return;

  const baseUrl = urlInput.value.trim().replace(/\/+$/, '');
  const key     = keyInput.value.trim();
  if (!baseUrl) { appendTurn('system', 'No endpoint URL — enter the gateway base URL above.'); return; }
  if (!key)     { appendTurn('system', 'No API key — enter your key above.'); return; }

  if (!silent) {
    const text = el('prompt').value.trim();
    if (!text) return;
    history.push({ role: 'user', content: text });
    appendTurn('user', text);
    el('prompt').value = '';
    el('prompt').style.height = 'auto';
  }

  const bubble = appendTurn('ai');
  const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
  bubble.appendChild(cursor);
  busy = true;
  el('send').disabled = true;

  const gw      = el('gateway').value || 'bifrost';
  const profile = GATEWAYS[gw] || GATEWAYS.bifrost;
  const headers = profile.headers(key, gw === 'helicone' ? key2Input.value.trim() : undefined);
```

Replace it with:

```js
async function send(silent = false) {
  if (busy) return;

  const gw      = el('gateway').value || 'bifrost';
  const profile = GATEWAYS[gw] || GATEWAYS.bifrost;
  const baseUrl = urlInput.value.trim().replace(/\/+$/, '');
  const key     = keyInput.value.trim();
  if (!baseUrl) { appendTurn('system', 'No endpoint URL — enter the gateway base URL above.'); return; }
  if (!profile.noKey && !key) { appendTurn('system', 'No API key — enter your key above.'); return; }

  if (!silent) {
    const text = el('prompt').value.trim();
    if (!text) return;
    history.push({ role: 'user', content: text });
    appendTurn('user', text);
    el('prompt').value = '';
    el('prompt').style.height = 'auto';
  }

  const bubble = appendTurn('ai');
  const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
  bubble.appendChild(cursor);
  busy = true;
  el('send').disabled = true;

  const headers = profile.headers(key, gw === 'helicone' ? key2Input.value.trim() : undefined);
```

(Everything after this point in `send()` — the `fetch`/`readStream` block — is left as-is for this task; it's rewired in Task 4.)

- [ ] **Step 4: Manually verify**

Reload the extension. Switch the Admin → AI Gateway dropdown to Ollama: confirm the URL field becomes visible and pre-filled with `http://localhost:11434`, and no key field appears. Switch back to Bifrost: confirm the URL field disappears again (matching today's behavior) and, with no key set, sending a chat message shows "No API key — enter your key above." Switch to Ollama again and send a chat message with Ollama not running yet — confirm it does NOT show the API-key error (it should instead fail later at the fetch, which is expected until Task 4 wires the request).

- [ ] **Step 5: Commit**

```bash
git add extension/panel.html extension/panel.js
git commit -m "Reveal URL field for Ollama profile, skip API-key gate when noKey"
```

---

### Task 3: Dynamic model list from Ollama's `/api/tags`

**Files:**
- Modify: `extension/panel.js:90-99` (DOM refs section — capture static model options once)
- Modify: `extension/panel.js:129-136` (`chrome.storage.local.get` callback — trigger populate on load if Ollama was persisted)
- Modify: `extension/panel.js:145-149` (`#gateway` change listener — trigger populate/restore)
- Modify: `extension/panel.js:249-268` (`saveSession`/model listeners — add URL-change trigger, guard the `/model` POST)

**Interfaces:**
- Consumes: `GATEWAYS.ollama` (Task 1), `applyGatewayProfile()` (Task 2).
- Produces: `populateOllamaModels(baseUrl)` and `restoreStaticModelOptions()`, both operating on `<select id="model">` — no other task depends on their internals, only on the fact that `#model`'s `<option>` values are valid model identifiers for whichever gateway is active.

- [ ] **Step 1: Capture the static model option list once, at load**

In `extension/panel.js`, right after the DOM refs block (after line 94, before the `setStatus` helper at line 96):

```js
const STATIC_MODEL_OPTIONS_HTML = el('model').innerHTML;
```

- [ ] **Step 2: Add `populateOllamaModels()` and `restoreStaticModelOptions()`**

Add these two functions right after `applyGatewayProfile()` (after the function body written in Task 2, i.e. after its closing `}`):

```js
async function restoreStaticModelOptions() {
  const sel = el('model');
  sel.innerHTML = STATIC_MODEL_OPTIONS_HTML;
  const { bf_model } = await chrome.storage.local.get(['bf_model']);
  if (bf_model) sel.value = bf_model;
}

async function populateOllamaModels(baseUrl) {
  const sel = el('model');
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data   = await res.json();
    const models = data.models || [];
    if (!models.length) throw new Error('no models installed');
    sel.innerHTML = models.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
    setStatus(`${models.length} ollama model${models.length !== 1 ? 's' : ''}`, 'ok');
  } catch (err) {
    sel.innerHTML = '<option value="" disabled selected>⚠ no models found</option>';
    setStatus(`ollama: ${err.message}`, 'err');
  }
}
```

- [ ] **Step 3: Trigger populate/restore on gateway switch**

In `extension/panel.js`, the `#gateway` change listener currently reads (lines 145-149):

```js
el('gateway').addEventListener('change', () => {
  const gw = el('gateway').value;
  applyGatewayProfile(gw);
  chrome.storage.local.set({ bf_gateway: gw });
});
```

Replace with:

```js
el('gateway').addEventListener('change', () => {
  const gw = el('gateway').value;
  applyGatewayProfile(gw);
  chrome.storage.local.set({ bf_gateway: gw });
  if (gw === 'ollama') populateOllamaModels(urlInput.value.trim());
  else                 restoreStaticModelOptions();
});
```

- [ ] **Step 4: Trigger populate on page load if Ollama was the persisted gateway**

In `extension/panel.js`, the `chrome.storage.local.get` callback currently reads (lines 129-136):

```js
chrome.storage.local.get(['bf_model', 'bf_gateway'], ({ bf_model, bf_gateway }) => {
  if (bf_model)  el('model').value   = bf_model;
  if (bf_gateway && GATEWAYS[bf_gateway]) {
    el('gateway').value = bf_gateway;
    applyGatewayProfile(bf_gateway);
  }
  updateInvestigateAvailability();
});
```

Replace with:

```js
chrome.storage.local.get(['bf_model', 'bf_gateway'], ({ bf_model, bf_gateway }) => {
  if (bf_model)  el('model').value   = bf_model;
  if (bf_gateway && GATEWAYS[bf_gateway]) {
    el('gateway').value = bf_gateway;
    applyGatewayProfile(bf_gateway);
    if (bf_gateway === 'ollama') {
      populateOllamaModels(urlInput.value.trim() || 'http://localhost:11434');
    }
  }
  updateInvestigateAvailability();
});
```

- [ ] **Step 5: Refetch models when the URL changes while Ollama is active, and guard the `/model` POST side effect**

`extension/panel.js:249-268` currently reads:

```js
urlInput.addEventListener('change',  () => saveSession('bf_url',  urlInput));
keyInput.addEventListener('change',  () => saveSession('bf_key',  keyInput));
key2Input.addEventListener('change', () => saveSession('bf_key2', key2Input));
el('model').addEventListener('change', () => {
  const model = el('model').value;
  chrome.storage.local.set({ bf_model: model });
  updateInvestigateAvailability();
  // Persist to .env's ANTHROPIC_DEFAULT_MODEL so server-side calls (/lql/generate) stay in
  // sync with whatever model the user is chatting with — best-effort, non-blocking.
  fetch(BASE_URL + '/model', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model }),
  }).catch(() => { /* offline — local chat still uses the picked model regardless */ });
});
```

Replace with:

```js
urlInput.addEventListener('change', () => {
  saveSession('bf_url', urlInput);
  if (el('gateway').value === 'ollama') populateOllamaModels(urlInput.value.trim());
});
keyInput.addEventListener('change',  () => saveSession('bf_key',  keyInput));
key2Input.addEventListener('change', () => saveSession('bf_key2', key2Input));
el('model').addEventListener('change', () => {
  const model = el('model').value;
  chrome.storage.local.set({ bf_model: model });
  updateInvestigateAvailability();
  // Ollama model names (e.g. "llama3:latest") aren't valid ANTHROPIC_DEFAULT_MODEL values for
  // the real AI gateway serve.py talks to server-side (/lql/generate) — never persist them there.
  if (el('gateway').value === 'ollama') return;
  // Persist to .env's ANTHROPIC_DEFAULT_MODEL so server-side calls (/lql/generate) stay in
  // sync with whatever model the user is chatting with — best-effort, non-blocking.
  fetch(BASE_URL + '/model', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model }),
  }).catch(() => { /* offline — local chat still uses the picked model regardless */ });
});
```

- [ ] **Step 6: Manually verify**

`ollama serve` locally and `ollama pull <a small model>`. Reload the extension, switch gateway to Ollama: confirm the model dropdown repopulates with your installed model(s). Stop `ollama serve`, change the URL field to force a refetch (e.g. append then remove a trailing slash and blur): confirm the dropdown shows the disabled "⚠ no models found" option and status reflects the error. Restart `ollama serve`, switch away to Bifrost and back to Ollama: confirm the dropdown returns to the static Claude/deepseek list when on Bifrost. Open the Network tab, pick an Ollama model, confirm no request to `serve.py`'s `/model` endpoint fires (it did fire for Claude/deepseek models before this change — verify that still works by switching back to Bifrost and picking a model).

- [ ] **Step 7: Commit**

```bash
git add extension/panel.js
git commit -m "Populate model dropdown from Ollama /api/tags, guard /model POST for local models"
```

---

### Task 4: Request/response translation — shared helper, `readOllamaStream()`, wire both call sites

**Files:**
- Modify: `extension/panel.js:904-952` (add `readOllamaStream()` as a sibling to `readStream()`)
- Modify: `extension/panel.js:1000-1012` (`send()` — use the shared helper)
- Modify: `extension/panel.js:2989-3000` (`_startLqlScopingConversation()` — use the shared helper)

**Interfaces:**
- Consumes: `GATEWAYS`, `MAX_TOKENS`, `SYSTEM_PROMPT`, `WEB_SEARCH_TOOL`, `history`-shaped message arrays (all pre-existing top-of-file constants), `gw`/`profile`/`headers`/`baseUrl` locals as already constructed at each call site.
- Produces: `buildChatRequest(gw, baseUrl, model, messages)` → `{ url, body }`; `pickStreamReader(gw)` → `readStream` or `readOllamaStream`. Both are called identically from `send()` and `_startLqlScopingConversation()` — no other task depends on them.

- [ ] **Step 1: Add `readOllamaStream()` right after `readStream()`**

In `extension/panel.js`, immediately after the closing `}` of `readStream()` (line 952), add:

```js
// Ollama's OpenAI-compatible SSE shape: `data: {"choices":[{"delta":{"content":"..."}}]}` per
// token, a terminal chunk carrying `usage` (via stream_options.include_usage), ending on
// `data: [DONE]`. Returns the same {out, inputTk, outputTk} shape readStream() does so the rest
// of send() (markdown rendering, token display, history push) doesn't need to know which gateway
// answered.
async function readOllamaStream(res, bubble, cursor) {
  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = '', out = '', inputTk = 0, outputTk = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') break;
      let ev; try { ev = JSON.parse(raw); } catch { continue; }

      const delta = ev.choices?.[0]?.delta?.content;
      if (delta) {
        out += delta;
        setRendered(bubble, renderMarkdown(out));
        bubble.appendChild(cursor);
        scrollLog();
      }
      if (ev.usage) {
        inputTk  = ev.usage.prompt_tokens     ?? inputTk;
        outputTk = ev.usage.completion_tokens ?? outputTk;
      }
    }
  }
  return { out, inputTk, outputTk };
}
```

- [ ] **Step 2: Add the shared request-builder helper**

Immediately after `readOllamaStream()`, add:

```js
// Shared by both /v1/messages call sites (send(), _startLqlScopingConversation()) — mirrors
// their existing duplication of gw/profile/headers construction rather than introducing a new
// shared pattern for that; this is the one new piece of logic that must not be copy-pasted twice.
function buildChatRequest(gw, baseUrl, model, messages) {
  if (gw === 'ollama') {
    return {
      url: `${baseUrl}/v1/chat/completions`,
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        stream: true,
        stream_options: { include_usage: true },
      }),
    };
  }
  return {
    url: `${baseUrl}/v1/messages`,
    body: JSON.stringify({
      model, max_tokens: MAX_TOKENS,
      stream: true, system: SYSTEM_PROMPT, messages,
      tools: [WEB_SEARCH_TOOL],
    }),
  };
}

function pickStreamReader(gw) {
  return gw === 'ollama' ? readOllamaStream : readStream;
}
```

- [ ] **Step 3: Wire `send()` to the shared helper**

In `extension/panel.js`, `send()` currently reads (lines 1000-1012, immediately after the `headers` line from Task 2 Step 3):

```js
  try {
    setStatus('streaming…', 'busy');
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: el('model').value, max_tokens: MAX_TOKENS,
        stream: true, system: SYSTEM_PROMPT, messages: history,
        tools: [WEB_SEARCH_TOOL],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const { out, inputTk, outputTk } = await readStream(res, bubble, cursor);
```

Replace with:

```js
  try {
    setStatus('streaming…', 'busy');
    const { url, body } = buildChatRequest(gw, baseUrl, el('model').value, history);
    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const { out, inputTk, outputTk } = await pickStreamReader(gw)(res, bubble, cursor);
```

- [ ] **Step 4: Wire `_startLqlScopingConversation()` to the shared helper**

In `extension/panel.js`, this function currently reads (lines 2989-3000):

```js
  setStatus('scoping…', 'busy');
  fetch(`${baseUrl}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: el('model').value, max_tokens: MAX_TOKENS,
      stream: true, system: SYSTEM_PROMPT, messages: history,
      tools: [WEB_SEARCH_TOOL],
    }),
  }).then(async res => {
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const { out } = await readStream(res, bubble, cursor);
```

Replace with:

```js
  setStatus('scoping…', 'busy');
  const { url, body } = buildChatRequest(gw, baseUrl, el('model').value, history);
  fetch(url, { method: 'POST', headers, body }).then(async res => {
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const { out } = await pickStreamReader(gw)(res, bubble, cursor);
```

- [ ] **Step 5: Note the report-quality caveat**

In `extension/panel.js`, find `INCIDENT_REPORT_TEMPLATE` (around line 2100) and add one line right above its declaration:

```js
// Note: local Ollama models may follow this template less reliably than Claude — no special
// handling for that here, callers just get whatever the model returns.
```

- [ ] **Step 6: Manually verify (full spec testing plan)**

With `ollama serve` running and a model pulled:
1. Switch gateway to Ollama, confirm URL defaults to `http://localhost:11434`, no key field, model dropdown populates (Task 3 already verified this).
2. Send a chat message. Confirm it streams token-by-token and renders markdown correctly, and the token counter (`el('token-info')`) updates with non-zero `in:`/`out:` values.
3. Switch back to Bifrost, confirm the key field reappears and a Bifrost chat still works (regression check — `readStream()`/Anthropic path untouched).
4. Trigger a Risk Hunting LQL report (or the LQL scoping-conversation error path) while Ollama is active — confirm it streams a response through `pickStreamReader`.
5. Check the DevTools console for CSP violations — confirm none.
6. Stop `ollama serve`, send a chat message: confirm the existing `catch` block in `send()` surfaces a clear "Error: …" bubble rather than hanging.

- [ ] **Step 7: Commit**

```bash
git add extension/panel.js
git commit -m "Add Ollama request/response translation (readOllamaStream, shared request builder)"
```

---

### Task 5: Documentation touch-up

**Files:**
- Modify: `README.md` (architecture diagram gateway list)

**Interfaces:**
- None — pure documentation, no code interfaces.

- [ ] **Step 1: Update the architecture diagram**

In `README.md`, the line (currently around line 388):

```
  ├─ Chat ──────────► AI Gateway (Bifrost / Portkey / LiteLLM / Helicone)      [HEADROOM_ENABLED=0]
```

becomes:

```
  ├─ Chat ──────────► AI Gateway (Bifrost / Portkey / LiteLLM / Helicone / Ollama)  [HEADROOM_ENABLED=0]
```

(Ollama bypasses Headroom/the gateway entirely when selected — it's a direct local connection, not routed through `/proxy`. If a nearby line in the diagram distinguishes routed vs. direct paths, leave Ollama out of the Headroom-routed branch; it only ever takes the direct path.)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document Ollama as a fifth AI gateway option"
```

---

## Post-plan

After Task 5, the feature matches the approved design spec (`docs/superpowers/specs/2026-08-12-ollama-connector-design.md`) with one documented deviation (URL field visibility, see Global Constraints). Update the design spec's `**Status:**` line from "Approved, pending implementation" to "Implemented" as part of Task 5's commit, or a follow-up commit.
