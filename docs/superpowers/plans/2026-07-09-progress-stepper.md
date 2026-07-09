# Progress Stepper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the decorative sailboat animation in Assisted Investigation and Cloud Investigation with a segmented progress stepper that reflects real server-side progress.

**Architecture:** `/mcp/investigate` already streams NDJSON tool-call events — the frontend just needs to turn those into stepper fills. `/lql/generate` is currently a single blocking call (up to 20 silent server-side retries) and must be converted to NDJSON streaming, mirroring `/mcp/investigate`'s existing `emit()` pattern, before its frontend can show real progress.

**Tech Stack:** Python stdlib (`serve.py`, no frameworks), vanilla JS/CSS (`extension/panel.js`/`panel.html`, no build step).

## Global Constraints

- No automated test suite or linter exists in this repo (per `CLAUDE.md`) — every verification step below is either a `curl` check against the running Docker container or a manual click-through in the loaded extension. There is nothing to substitute for actually watching it happen.
- Docker is the only way `/mcp/investigate` runs at all (`vendor/mcp_forticnapp` is pip-installed only in the image) — verification must go through `docker compose up --build -d webai`, not bare `python3 serve.py`.
- Preserve `/lql/generate`'s exact final-success payload shape (`queryId`/`queryText`/`rows`/`count`/`total`/`api_enrichment`/`searchTerm`/`note`) — downstream client code (CVE-tab redirect, report generation) depends on these field names unchanged.
- `RESPONSE_CACHE_TTL_SECONDS` caching behavior for `/lql/generate` must keep working — a cache hit replays a recorded event stream, exactly like `/mcp/investigate` already does.

---

### Task 1: Segmented stepper component + wire Cloud Investigation

**Files:**
- Modify: `extension/panel.html:483-524` (sailboat CSS block — leave as-is, new CSS added alongside it, removed in Task 4)
- Modify: `extension/panel.html:1576-1586` (`#lql-pane-investigate` markup — add stepper div, leave old boat elements in place for now)
- Modify: `extension/panel.js:3041-3108` (leave `startSailing`/`stopSailing` in place; add new stepper helpers immediately after)
- Modify: `extension/panel.js:2833-2930` (`runCloudInvestigation()` — switch from `startSailing`/`stopSailing` to the new stepper helpers)

**Interfaces:**
- Produces: `startStepper(stepperEl, segmentCount)`, `updateStepper(stepperEl, step, max)`, `stopStepper(stepperEl)` — used by Task 3 as well.

- [ ] **Step 1: Add stepper CSS to `panel.html`**

Insert immediately after the existing `@keyframes wake-fade { ... }` block (ends at `panel.html:524`), before `.drawer-results {` (`panel.html:526`):

```css
/* Segmented progress stepper for Assisted Investigation / Cloud Investigation. panel.js
   sets the segment count per feature and fills/pulses segments as real server-side
   progress events arrive — replaces the sailboat's "still working" role with an honest
   step count instead of pure decoration. */
.progress-stepper {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px 8px;
}
.stepper-track {
  display: flex;
  gap: 4px;
  flex: 1;
}
.stepper-seg {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--surface2);
}
.stepper-seg.done   { background: var(--ok); }
.stepper-seg.active { background: var(--accent); animation: stepper-pulse 1s ease-in-out infinite; }
.stepper-elapsed { font-size: 10px; color: var(--dim); white-space: nowrap; }
@keyframes stepper-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: .45; }
}
```

- [ ] **Step 2: Add stepper markup to the Cloud Investigation pane**

In `panel.html`, current markup (lines 1576-1586):

```html
  <div class="lql-pane" id="lql-pane-investigate">
    <div class="drawer-body">
      <input id="investigate-prompt" class="drawer-input" type="text"
             placeholder="e.g. find EC2 instances with public S3 buckets attached"
             autocomplete="off" style="flex:1;min-width:160px" />
      <button id="investigate-btn" class="drawer-btn primary">🔎 Investigate</button>
      <span id="investigate-status" class="drawer-status"></span>
      <span id="investigate-boat" class="lql-boat" title="Working hard…">⛵</span>
      <div id="investigate-wake-trail"></div>
    </div>
  </div>
```

Add a stepper div as a sibling of `.drawer-body`, right before the closing `</div>` of `.lql-pane`:

```html
  <div class="lql-pane" id="lql-pane-investigate">
    <div class="drawer-body">
      <input id="investigate-prompt" class="drawer-input" type="text"
             placeholder="e.g. find EC2 instances with public S3 buckets attached"
             autocomplete="off" style="flex:1;min-width:160px" />
      <button id="investigate-btn" class="drawer-btn primary">🔎 Investigate</button>
      <span id="investigate-status" class="drawer-status"></span>
      <span id="investigate-boat" class="lql-boat" title="Working hard…">⛵</span>
      <div id="investigate-wake-trail"></div>
    </div>
    <div id="investigate-stepper" class="progress-stepper" style="display:none">
      <div class="stepper-track"></div>
      <span class="stepper-elapsed"></span>
    </div>
  </div>
```

(Leave `#investigate-boat`/`#investigate-wake-trail` in place — Task 4 removes them once nothing points at them.)

- [ ] **Step 3: Add the stepper JS helpers to `panel.js`**

Insert immediately after `stopSailing`'s closing brace (`panel.js:3108`), before `el('lql-gen-btn').addEventListener(...)` (`panel.js:3110`):

```js
// Segmented progress stepper — replaces the sailboat for showing real server-side
// progress. startStepper(el, N) renders N empty segments and starts a live elapsed-time
// ticker; updateStepper(el, step, max) fills segments proportionally to step/max and
// pulses the current one; stopStepper(el) tears both down and hides the element.
let _stepperElapsedTimer = null, _stepperStartedAt = 0;

function startStepper(stepperEl, segmentCount) {
  const track = stepperEl.querySelector('.stepper-track');
  track.innerHTML = '';
  for (let i = 0; i < segmentCount; i++) {
    const seg = document.createElement('div');
    seg.className = 'stepper-seg';
    track.appendChild(seg);
  }
  stepperEl.style.display = 'flex';
  _stepperStartedAt = performance.now();
  const elapsedEl = stepperEl.querySelector('.stepper-elapsed');
  elapsedEl.textContent = '0s elapsed';
  clearInterval(_stepperElapsedTimer);
  _stepperElapsedTimer = setInterval(() => {
    const secs = Math.round((performance.now() - _stepperStartedAt) / 1000);
    elapsedEl.textContent = `${secs}s elapsed`;
  }, 1000);
}

function updateStepper(stepperEl, step, max) {
  const segs = stepperEl.querySelectorAll('.stepper-seg');
  if (!segs.length) return;
  const filled = Math.min(segs.length, Math.max(0, Math.ceil((step / max) * segs.length)));
  segs.forEach((seg, i) => {
    seg.classList.toggle('done',   i <  filled - 1);
    seg.classList.toggle('active', i === filled - 1);
  });
}

function stopStepper(stepperEl) {
  clearInterval(_stepperElapsedTimer);
  stepperEl.style.display = 'none';
}
```

- [ ] **Step 4: Wire `runCloudInvestigation()` to the stepper**

In `panel.js`, current lines 2838-2846:

```js
  const btn      = el('investigate-btn');
  const statusEl = el('investigate-status');
  const boatEl   = el('investigate-boat');
  const trailEl  = el('investigate-wake-trail');

  btn.disabled = true;
  statusEl.textContent = 'investigating…';
  statusEl.className   = '';
  startSailing(boatEl, trailEl);
```

Replace with:

```js
  const btn       = el('investigate-btn');
  const statusEl  = el('investigate-status');
  const stepperEl = el('investigate-stepper');

  btn.disabled = true;
  statusEl.textContent = 'investigating…';
  statusEl.className   = '';
  startStepper(stepperEl, 6); // 1:1 with the 6-tool-call budget in serve.py's MAX_ITERATIONS
  updateStepper(stepperEl, 1, 6);
```

Current lines 2873-2878 (inside the NDJSON read loop):

```js
        if (ev.type === 'tool_call') {
          steps.push({ tool: ev.tool, summary: null });
          statusEl.textContent = `🔧 ${ev.tool}…`;
        } else if (ev.type === 'tool_result') {
          const last = steps[steps.length - 1];
          if (last) last.summary = ev.summary;
```

Replace with:

```js
        if (ev.type === 'tool_call') {
          steps.push({ tool: ev.tool, summary: null });
          statusEl.textContent = `🔧 ${ev.tool}…`;
          updateStepper(stepperEl, steps.length, 6);
        } else if (ev.type === 'tool_result') {
          const last = steps[steps.length - 1];
          if (last) last.summary = ev.summary;
```

Current line 2927 (`finally` block):

```js
    stopSailing(boatEl, trailEl);
```

Replace with:

```js
    stopStepper(stepperEl);
```

- [ ] **Step 5: Verify end-to-end in the extension**

```bash
docker compose up -d webai
```

In Chrome: `chrome://extensions` → reload the unpacked FortiAIScout extension → open the side panel → FortiCNAPP ▼ → Risk Hunting → 🔎 Cloud Investigation tab → type an objective (e.g. "list S3 buckets") → 🔎 Investigate.

Expected: a 6-segment bar appears below the input row instead of the sailboat, segments turn green left-to-right as tool calls happen, the current segment pulses red, and a "Ns elapsed" counter ticks up next to it. No sailboat/wake ripples appear for this flow.

- [ ] **Step 6: Commit**

```bash
git add extension/panel.html extension/panel.js
git commit -m "$(cat <<'EOF'
Add segmented progress stepper, wire up Cloud Investigation

Replaces the decorative sailboat with a 6-segment bar driven by real
tool-call events (Cloud Investigation's 6-call budget), plus a live
elapsed-time counter. Assisted Investigation keeps the sailboat until
/lql/generate is converted to streaming in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Convert `/lql/generate` to NDJSON streaming

**Files:**
- Modify: `serve.py:1896-2538` (`serve_lql_generate`)

**Interfaces:**
- Produces NDJSON events consumed by Task 3:
  - `{"type":"attempt","attempt":<int>,"max":20,"phase":"asking_claude"|"validating"|"running"}`
  - `{"type":"final", ...same fields /lql/generate returns today on success...}`
  - `{"type":"error","error":"<string>"}`
- Consumes: nothing new — same `_validate_lql`/`_run_lql`/`_call_claude_retryable` helpers already defined inside `serve_lql_generate`.

- [ ] **Step 1: Switch the cache-hit path to replay recorded events**

Current (`serve.py:1911-1917`):

```python
        cache_key = ' '.join(objective.lower().split())
        entry = _lql_cache.get(cache_key)
        if entry and datetime.now(timezone.utc).timestamp() - entry['cached_at'] < RESPONSE_CACHE_TTL_SECONDS:
            cached = dict(entry['response'])
            cached['cached'] = True
            self.send_json(200, json.dumps(cached).encode())
            return
```

Replace with:

```python
        cache_key = ' '.join(objective.lower().split())
        entry = _lql_cache.get(cache_key)
        if entry and datetime.now(timezone.utc).timestamp() - entry['cached_at'] < RESPONSE_CACHE_TTL_SECONDS:
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            for k, v in CORS.items():
                self.send_header(k, v)
            self.end_headers()
            for ev in entry['events']:
                self.wfile.write((json.dumps(ev) + '\n').encode())
                self.wfile.flush()
            return
```

- [ ] **Step 2: Start the NDJSON stream before the retry loop**

Current (`serve.py:1923-1931`, right after the gateway-configured check and before `system_prompt = """\`):

```python
        # Fetch live tenant metadata to ground LQL generation (best-effort — skip on any failure)
        _lw_token_data = None
        _schema_hints  = ''
        if LW_READY:
            try:
                _lw_token_data = self._lw_token()
                _schema_hints  = self._lw_schema_hints(*_lw_token_data)
            except Exception:
                _lw_token_data = None
```

Leave this block as-is, but insert the stream-start block immediately after it (still before `system_prompt = """\`):

```python
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

        recorded_events = []

        def emit(obj):
            recorded_events.append(obj)
            self.wfile.write((json.dumps(obj) + '\n').encode())
            self.wfile.flush()
```

- [ ] **Step 3: Emit an `attempt` event for the initial (pre-loop) Claude call**

Current (`serve.py:2397-2399`):

```python
        try:
            messages = [{'role': 'user', 'content': f'<system>\n{system_prompt}\n</system>\n\nObjective: {objective}'}]
            result, last_err = _call_claude_retryable(messages)
```

Replace with:

```python
        try:
            messages = [{'role': 'user', 'content': f'<system>\n{system_prompt}\n</system>\n\nObjective: {objective}'}]
            emit({'type': 'attempt', 'attempt': 1, 'max': 20, 'phase': 'asking_claude'})
            result, last_err = _call_claude_retryable(messages)
```

(`MAX_RETRIES` is defined two lines later in the existing code as `20` — this hardcodes the same value since it's not yet in scope; Step 4 below keeps every later reference using the real `MAX_RETRIES` variable.)

- [ ] **Step 4: Emit `attempt` events at each phase transition inside the retry loop**

Current (`serve.py:2408-2472`, the full `for attempt in range(MAX_RETRIES):` loop) — four spots get one `emit(...)` line added each, right next to the existing `print(...)` calls that already track the same information:

4a. After `if result is None:` branch's retry-ask (current `serve.py:2416-2417`):

```python
                        print(f'  [LQL]   → asking Claude to retry (attempt {attempt+2})')
                        result, last_err = _call_claude_retryable(messages)
```

Replace with:

```python
                        print(f'  [LQL]   → asking Claude to retry (attempt {attempt+2})')
                        emit({'type': 'attempt', 'attempt': attempt + 2, 'max': MAX_RETRIES, 'phase': 'asking_claude'})
                        result, last_err = _call_claude_retryable(messages)
```

4b. Before validation (current `serve.py:2424`):

```python
                print(f'  [LQL] attempt {attempt+1}/{MAX_RETRIES} — query: {query_text[:120].replace(chr(10)," ")}…')
```

Replace with:

```python
                print(f'  [LQL] attempt {attempt+1}/{MAX_RETRIES} — query: {query_text[:120].replace(chr(10)," ")}…')
                emit({'type': 'attempt', 'attempt': attempt + 1, 'max': MAX_RETRIES, 'phase': 'validating'})
```

4c. After validation passes, before running (current `serve.py:2441-2442`, inside the `if val_err:` branch's retry-ask, AND current `serve.py:2445` for the success case):

```python
                        print(f'  [LQL]   → asking Claude to fix (attempt {attempt+2})')
                        result, last_err = _call_claude_retryable(messages)
                    continue  # re-enter loop with corrected result (or exit on final attempt)

                print(f'  [LQL]   ✓ validation passed — running…')
```

Replace with:

```python
                        print(f'  [LQL]   → asking Claude to fix (attempt {attempt+2})')
                        emit({'type': 'attempt', 'attempt': attempt + 2, 'max': MAX_RETRIES, 'phase': 'asking_claude'})
                        result, last_err = _call_claude_retryable(messages)
                    continue  # re-enter loop with corrected result (or exit on final attempt)

                print(f'  [LQL]   ✓ validation passed — running…')
                emit({'type': 'attempt', 'attempt': attempt + 1, 'max': MAX_RETRIES, 'phase': 'running'})
```

4d. After a run error, in its retry-ask (current `serve.py:2471-2472`):

```python
                    print(f'  [LQL]   → asking Claude to fix (attempt {attempt+2})')
                    result, last_err = _call_claude_retryable(messages)
```

Replace with:

```python
                    print(f'  [LQL]   → asking Claude to fix (attempt {attempt+2})')
                    emit({'type': 'attempt', 'attempt': attempt + 2, 'max': MAX_RETRIES, 'phase': 'asking_claude'})
                    result, last_err = _call_claude_retryable(messages)
```

- [ ] **Step 5: Emit `error` instead of a 500 response when retries are exhausted**

Current (`serve.py:2474-2478`):

```python
            # If all retries exhausted with an error, surface it rather than returning empty
            if last_err and cached_rows is None and (result or {}).get('queryId') != 'USE_CVE_TAB':
                print(f'  [LQL] ✗ gave up after {MAX_RETRIES} attempts — {last_err}')
                self.send_json(500, json.dumps({'error': f'LQL still failing after {MAX_RETRIES} attempts — last error: {last_err}'}).encode())
                return
```

Replace with:

```python
            # If all retries exhausted with an error, surface it rather than returning empty
            if last_err and cached_rows is None and (result or {}).get('queryId') != 'USE_CVE_TAB':
                print(f'  [LQL] ✗ gave up after {MAX_RETRIES} attempts — {last_err}')
                emit({'type': 'error', 'error': f'LQL still failing after {MAX_RETRIES} attempts — last error: {last_err}'})
                return
```

- [ ] **Step 6: Cache full event list and emit the `final` event**

Current (`serve.py:2516-2523`):

```python
            # Cache the full response (including rows) for RESPONSE_CACHE_TTL_SECONDS
            if result.get('queryText') and result.get('queryId') != 'USE_CVE_TAB':
                _lql_cache[cache_key] = {
                    'response':  dict(result),
                    'cached_at': datetime.now(timezone.utc).timestamp(),
                }

            self.send_json(200, json.dumps(result).encode())
```

Replace with:

```python
            final_event = {'type': 'final', **result}
            recorded_events.append(final_event)

            # Cache the full recorded event stream (including the final rows) for
            # RESPONSE_CACHE_TTL_SECONDS — a cache hit replays it verbatim, same as
            # /mcp/investigate.
            if result.get('queryText') and result.get('queryId') != 'USE_CVE_TAB':
                _lql_cache[cache_key] = {
                    'events':    recorded_events,
                    'cached_at': datetime.now(timezone.utc).timestamp(),
                }

            self.wfile.write((json.dumps(final_event) + '\n').encode())
            self.wfile.flush()
```

(Uses a direct `wfile.write` rather than `emit()` here because `final_event` must be appended to `recorded_events` before the cache-write check above reads it — `emit()` would append after `json.dumps` is already computed, which is fine functionally, but writing it explicitly keeps the ordering obvious. Either is correct; this avoids a subtle reordering bug if Step 6 is ever edited again.)

- [ ] **Step 7: Convert the exception handlers to emit `error` events**

Current (`serve.py:2524-2538`):

```python
        except urllib.error.HTTPError as e:
            err_body = e.read()
            try:
                msg = json.loads(err_body).get('error', {}).get('message', err_body.decode()[:400])
            except Exception:
                msg = err_body.decode()[:400]
            self.send_json(e.code, json.dumps({'error': msg}).encode())
        except Exception as e:
            msg = str(e)
            if 'Name or service not known' in msg or 'urlopen error' in msg:
                target = current_upstream()
                hint = 'HEADROOM_URL' if _headroom_enabled() else 'ANTHROPIC_BASE_URL'
                msg = (f'Cannot reach AI gateway ({target}). '
                       f'Check that {hint} in .env points to a reachable address and restart the server.')
            self.send_json(500, json.dumps({'error': msg}).encode())
```

Replace with:

```python
        except urllib.error.HTTPError as e:
            err_body = e.read()
            try:
                msg = json.loads(err_body).get('error', {}).get('message', err_body.decode()[:400])
            except Exception:
                msg = err_body.decode()[:400]
            emit({'type': 'error', 'error': msg})
        except Exception as e:
            msg = str(e)
            if 'Name or service not known' in msg or 'urlopen error' in msg:
                target = current_upstream()
                hint = 'HEADROOM_URL' if _headroom_enabled() else 'ANTHROPIC_BASE_URL'
                msg = (f'Cannot reach AI gateway ({target}). '
                       f'Check that {hint} in .env points to a reachable address and restart the server.')
            emit({'type': 'error', 'error': msg})
```

(By the time either handler can fire, headers are already sent — the HTTP status can no longer change, so signaling failure via an `error` event, not a status code, is the only option left. This matches `/mcp/investigate`'s existing exception handling.)

- [ ] **Step 8: Verify via `curl` against the running container**

```bash
docker compose up --build -d webai
curl -sN -X POST http://localhost:45321/lql/generate \
  -H 'Content-Type: application/json' \
  -d '{"objective":"List EC2 instances with attached instance profiles and highly permissive IAM roles."}'
```

Expected: multiple `{"type":"attempt",...}` lines streaming out one at a time (not all at once), ending in either a `{"type":"final",...}` line containing `queryText`/`rows`/`count`, or a `{"type":"error",...}` line. Confirm the response `Content-Type` header is `application/x-ndjson`:

```bash
curl -sI -X POST http://localhost:45321/lql/generate \
  -H 'Content-Type: application/json' \
  -d '{"objective":"list S3 buckets"}' | grep -i content-type
```

Re-run the exact same objective a second time within an hour and confirm it returns near-instantly (cache hit replaying the recorded events).

- [ ] **Step 9: Commit**

```bash
git add serve.py
git commit -m "$(cat <<'EOF'
Convert /lql/generate to NDJSON streaming

It was a single blocking call that could silently retry up to 20 times
server-side with zero client-visible progress — the frontend had no way
to show real progress, only a decorative animation. Now streams
attempt/final/error events exactly like /mcp/investigate already does,
including replaying the full event list on a cache hit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire Assisted Investigation to the new stream + stepper

**Files:**
- Modify: `extension/panel.html:1563-1574` (`#lql-pane-generate` markup — add stepper div)
- Modify: `extension/panel.js:3110-3238` (`lql-gen-btn` click handler)

**Interfaces:**
- Consumes: `startStepper`/`updateStepper`/`stopStepper` from Task 1; the `attempt`/`final`/`error` NDJSON events from Task 2.

- [ ] **Step 1: Add stepper markup to the Assisted Investigation pane**

In `panel.html`, current markup (lines 1563-1574):

```html
  <div class="lql-pane" id="lql-pane-generate">
    <div class="drawer-body">
      <input id="lql-objective" class="drawer-input" type="text"
             placeholder="e.g. S3 buckets without encryption"
             autocomplete="off" style="flex:1;min-width:160px" />
      <button id="lql-gen-btn" class="drawer-btn primary">▶ Run Query</button>
      <span id="lql-gen-status" class="drawer-status"></span>
      <span id="lql-gen-boat" class="lql-boat" title="Working hard…">⛵</span>
      <div id="lql-gen-wake-trail"></div>
    </div>
    <div id="lql-gen-results"></div>
  </div>
```

Replace with:

```html
  <div class="lql-pane" id="lql-pane-generate">
    <div class="drawer-body">
      <input id="lql-objective" class="drawer-input" type="text"
             placeholder="e.g. S3 buckets without encryption"
             autocomplete="off" style="flex:1;min-width:160px" />
      <button id="lql-gen-btn" class="drawer-btn primary">▶ Run Query</button>
      <span id="lql-gen-status" class="drawer-status"></span>
      <span id="lql-gen-boat" class="lql-boat" title="Working hard…">⛵</span>
      <div id="lql-gen-wake-trail"></div>
    </div>
    <div id="lql-gen-stepper" class="progress-stepper" style="display:none">
      <div class="stepper-track"></div>
      <span class="stepper-elapsed"></span>
    </div>
    <div id="lql-gen-results"></div>
  </div>
```

- [ ] **Step 2: Replace the blocking fetch with an NDJSON stream reader**

Current (`extension/panel.js:3110-3134`):

```js
el('lql-gen-btn').addEventListener('click', async () => {
  const objective = el('lql-objective').value.trim();
  if (!objective) return;

  const btn      = el('lql-gen-btn');
  const statusEl = el('lql-gen-status');
  const boatEl   = el('lql-gen-boat');
  const trailEl  = el('lql-gen-wake-trail');

  btn.disabled         = true;
  statusEl.textContent = 'running…';
  statusEl.className   = '';
  startSailing(boatEl, trailEl);
  _genQueryText        = '';
  el('lql-gen-results').innerHTML = '';

  try {
    const genRes = await fetch(BASE_URL + '/lql/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ objective }),
    });
    const data = await genRes.json();
    if (data.error) throw new Error(data.error);
```

Replace with:

```js
el('lql-gen-btn').addEventListener('click', async () => {
  const objective = el('lql-objective').value.trim();
  if (!objective) return;

  const btn       = el('lql-gen-btn');
  const statusEl  = el('lql-gen-status');
  const stepperEl = el('lql-gen-stepper');

  btn.disabled         = true;
  statusEl.textContent = 'running…';
  statusEl.className   = '';
  startStepper(stepperEl, 8); // 8 fixed segments scaled against the real 20-attempt budget
  updateStepper(stepperEl, 1, 20);
  _genQueryText        = '';
  el('lql-gen-results').innerHTML = '';

  try {
    const genRes = await fetch(BASE_URL + '/lql/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ objective }),
    });

    const reader = genRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '', data = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'attempt') {
          statusEl.textContent = ev.phase === 'asking_claude' ? 'asking Claude…'
                                : ev.phase === 'validating'    ? 'validating query…'
                                : 'running…';
          updateStepper(stepperEl, ev.attempt, ev.max);
        } else if (ev.type === 'error') {
          throw new Error(ev.error);
        } else if (ev.type === 'final') {
          data = ev;
        }
      }
    }
    if (!data) throw new Error('Stream ended with no result.');
```

- [ ] **Step 3: Replace the old boat teardown in `finally`**

Current (`extension/panel.js`, end of the same handler — the line matching `stopSailing(boatEl, trailEl);` inside its `finally` block, same pattern as `runCloudInvestigation`'s):

```js
  } finally {
    btn.disabled = false;
    stopSailing(boatEl, trailEl);
```

Replace with:

```js
  } finally {
    btn.disabled = false;
    stopStepper(stepperEl);
```

- [ ] **Step 4: Verify end-to-end in the extension**

```bash
docker compose up --build -d webai
```

In Chrome: reload the unpacked extension → Risk Hunting → ✨ Assisted Investigation tab → type an objective known to need a couple of retries (e.g. "List EC2 instances with attached instance profiles and highly permissive IAM roles.") → ▶ Run Query.

Expected: an 8-segment bar appears, fills proportionally as `attempt`/`max` events arrive (status text cycles "asking Claude…" / "validating query…" / "running…"), elapsed-time ticks up, and the run finishes with the LQL results table rendering exactly as before. Also verify a fast-succeeding objective (e.g. "list S3 buckets") still completes correctly, and that a repeated identical objective within the hour returns from cache near-instantly.

- [ ] **Step 5: Commit**

```bash
git add extension/panel.html extension/panel.js
git commit -m "$(cat <<'EOF'
Wire Assisted Investigation to the streaming /lql/generate + stepper

Completes the progress-stepper migration: Assisted Investigation now
shows real attempt/validate/run progress via an 8-segment bar instead
of the sailboat, consuming the NDJSON stream added in the previous
commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Remove the dead sailboat code

**Files:**
- Modify: `extension/panel.html:483-524` (delete `.lql-boat`/`.lql-wake` CSS + keyframes)
- Modify: `extension/panel.html:1563-1586` (delete `#lql-gen-boat`/`#lql-gen-wake-trail`/`#investigate-boat`/`#investigate-wake-trail` elements)
- Modify: `extension/panel.js:3041-3108` (delete `startSailing`/`stopSailing` and their supporting comment/vars)

**Interfaces:** None — this task only removes code nothing references anymore after Tasks 1 and 3.

- [ ] **Step 1: Confirm nothing still references the old boat code**

```bash
grep -n "startSailing\|stopSailing\|lql-boat\|lql-wake\|-boat\"\|-wake-trail" extension/panel.js extension/panel.html
```

Expected output: only the definitions/markup themselves (no remaining call sites in `panel.js` — Tasks 1 and 3 already replaced both).

- [ ] **Step 2: Delete the CSS**

In `panel.html`, delete the entire block from the `/* A little sailboat cruising...` comment (line 483) through the closing `}` of `@keyframes wake-fade` (line 524) — i.e. everything currently between the `.drawer-status.err` rule and `.drawer-results {`.

- [ ] **Step 3: Delete the boat markup**

In `panel.html`, remove these two lines from `#lql-pane-generate`:

```html
      <span id="lql-gen-boat" class="lql-boat" title="Working hard…">⛵</span>
      <div id="lql-gen-wake-trail"></div>
```

And these two lines from `#lql-pane-investigate`:

```html
      <span id="investigate-boat" class="lql-boat" title="Working hard…">⛵</span>
      <div id="investigate-wake-trail"></div>
```

- [ ] **Step 4: Delete the JS functions**

In `panel.js`, delete the entire block from the `// A little sailboat sails slow...` comment (line 3041) through `stopSailing`'s closing `}` (line 3108).

- [ ] **Step 5: Verify the extension still loads and both flows still work**

```bash
docker compose up --build -d webai
```

Reload the unpacked extension in Chrome, open the DevTools console for the side panel, confirm no errors on load. Run one Cloud Investigation query and one Assisted Investigation query end-to-end; confirm both still show the segmented stepper correctly (Task 1/3 behavior unchanged) and no `ReferenceError`/`Cannot read properties of null` appears in the console.

- [ ] **Step 6: Commit**

```bash
git add extension/panel.html extension/panel.js
git commit -m "$(cat <<'EOF'
Remove dead sailboat animation code

Fully superseded by the segmented progress stepper (previous three
commits) — nothing references .lql-boat/.lql-wake or
startSailing/stopSailing anymore.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Visual design (stepper shape, colors) → Task 1 Step 1. Backend streaming + event schema → Task 2. Cloud Investigation wiring → Task 1. Assisted Investigation wiring → Task 3. Cleanup → Task 4. Out-of-scope items (no ETA prediction, no retry-count changes) are simply not touched by any task.
- **Type/name consistency:** `startStepper(stepperEl, segmentCount)` / `updateStepper(stepperEl, step, max)` / `stopStepper(stepperEl)` signatures defined in Task 1 Step 3 are used identically (same argument order and names) in Task 1 Step 4 and Task 3 Steps 2-3.
- **Sequencing constraint:** Task 2 alone temporarily breaks Assisted Investigation in the running extension (old client code calls `res.json()` on a now-multi-line NDJSON body) — Task 3 fixes this immediately. Tasks 2 and 3 should land back-to-back in the same session, not shipped independently.
