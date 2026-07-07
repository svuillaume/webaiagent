# Cloud Investigation (FortiCNAPP MCP integration) — Design

## Summary

Add a "Cloud Investigation" tab to the existing Risk Hunting drawer in the Chrome
extension. The user types a free-text investigation objective (e.g. "find EC2
instances with public S3 buckets attached"); `serve.py` runs a server-side,
multi-step LLM agent loop that calls read-only FortiCNAPP tools exposed by the
`mcp_forticnapp` MCP server (a separate, already-working project at
`~/tmp/personal_project/mcp_forticnapp`), streaming step-by-step progress back to
the browser, and finishes with a narrative answer that lands in the normal chat
log — the same place Risk Hunting and Unified Attack Threat Surface results land.

## Background

`mcp_forticnapp` is a complete MCP (Model Context Protocol) server that generates
37 typed, auth-aware tools from FortiCNAPP's OpenAPI spec (`lw.yaml`) and speaks
MCP over stdio. It already has working credentials and has been verified
end-to-end via a real stdio subprocess handshake. It is entirely separate from
`webaiagent` today — this design wires the two together.

The key constraint (from `webaiagent/CLAUDE.md`): `serve.py` must remain
zero-dependency stdlib Python. `mcp_forticnapp` depends on `mcp`, `httpx`,
`pydantic`, `pydantic-settings`, `python-dotenv`, `PyYAML`, `anyio`. The design
below keeps those dependencies out of `serve.py`'s own import graph by running
`mcp_forticnapp` as a subprocess, the same way `serve.py` already shells out to
the external `lacework` CLI binary rather than importing a Lacework SDK.

## Architecture

```
extension/panel.js (Risk Hunting drawer, new "Cloud Investigation" tab)
        │  POST /mcp/investigate {prompt}  (NDJSON streaming response)
        ▼
serve.py (webai container)
        │
        ├─► _mcp_ensure_started()  — lazy singleton, spawns once, kept alive
        │     subprocess.Popen(["python3","-m","forticnapp_mcp.main"], env={FORTICNAPP_*})
        │     stdin/stdout: newline-delimited JSON-RPC (initialize → tools/list)
        │     ENABLE_MUTATION_TOOLS always "false" — hardcoded, not configurable via UI
        │
        └─► agent loop (server-side, capped at 6 iterations):
              1. POST to DIRECT_UPSTREAM /v1/messages (non-streaming) with the 37
                 MCP tools translated to Anthropic tool schema + running conversation
              2. If response has tool_use blocks → for each: _mcp_call_tool(name, args)
                 over the persistent subprocess (lock-serialized) → write a
                 {"type":"tool_call",...}/{"type":"tool_result",...} NDJSON chunk to
                 the HTTP response immediately, append tool_result to conversation, loop
              3. If response is plain text (stop_reason=end_turn) → write
                 {"type":"final","text":...} and close the stream
```

Credentials for the MCP subprocess are derived at spawn time from the same
`~/.lacework.toml` (`account`/`api_key`/`api_secret`) already used by
`_lw_token()` elsewhere in `serve.py` — no second credential store.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Output UX | Appears in the main chat log, like Risk Hunting/CVE auto-triggers |
| Tool-loop depth | Multi-step agent loop, capped at 6 tool calls |
| Deployment target | Docker only (the `webai` container); no local-dev-mode fallback |
| Credentials | Derived from `~/.lacework.toml` at subprocess spawn time |
| Mutations | Disabled — `ENABLE_MUTATION_TOOLS=false` hardcoded, not user-configurable |
| Process lifecycle | Persistent, lazily-started subprocess; serialized access via a lock |
| Progress UX | Streamed step-by-step status (tool_call/tool_result), not just a spinner |
| UI placement | New tab inside the existing Risk Hunting drawer, alongside LQL and Assisted Investigation |
| Bridge architecture | Hand-rolled stdio JSON-RPC client in `serve.py`, stdlib only (not the real `mcp` SDK imported into `serve.py`, not a separate HTTP shim process) |
| Source vendoring | Copy `mcp_forticnapp`'s `src/`, `pyproject.toml`, `lw.yaml` into `webaiagent/vendor/mcp_forticnapp/` (Docker can't `COPY` from outside its build context); this is a one-time copy, not a live sync — future `mcp_forticnapp` changes need manual re-vendoring |

## Components

### 1. Docker / build (`Dockerfile`)

```dockerfile
COPY vendor/mcp_forticnapp/ ./vendor/mcp_forticnapp/
RUN pip install --no-cache-dir ./vendor/mcp_forticnapp
```

Installs `mcp`/`httpx`/`pydantic`/etc. into the container's site-packages.
`serve.py` never imports them — it only spawns `python3 -m forticnapp_mcp.main`
as an external process. No `docker-compose.yml` changes: no new service, since
the MCP server runs as a child process inside the existing `webai` container.

### 2. MCP client module (`serve.py`)

```python
_mcp_lock = threading.Lock()
_mcp_state = {'proc': None, 'tools': None, 'next_id': 1}

def _mcp_ensure_started():
    # Under _mcp_lock: if proc is None or proc.poll() is not None (crashed/exited),
    # (re)spawn: subprocess.Popen(['python3','-m','forticnapp_mcp.main'], env={...},
    #   stdin=PIPE, stdout=PIPE, stderr=DEVNULL, text=True, bufsize=1)
    # Perform the MCP handshake: `initialize` request, read one response line,
    # send `notifications/initialized`, then `tools/list`, cache the tool list
    # translated to Anthropic tool schema in _mcp_state['tools'].

def _mcp_call_tool(name, arguments, timeout=60):
    # Under _mcp_lock: write one JSON-RPC `tools/call` request line to proc.stdin,
    # block-read proc.stdout until a line with the matching id arrives, return the
    # parsed result dict or raise on timeout/EOF.
```

Env vars passed to the subprocess at spawn time:
```python
{
  'FORTICNAPP_API_BASE_URL': f'https://{account}.lacework.net',
  'FORTICNAPP_KEY_ID': api_key,
  'FORTICNAPP_API_SECRET': api_secret,
  'FORTICNAPP_OPENAPI_SPEC': '/app/vendor/mcp_forticnapp/lw.yaml',
  'ENABLE_MUTATION_TOOLS': 'false',
}
```

Because access is fully serialized behind `_mcp_lock`, there is no need for
request-ID multiplexing — only one request is ever in flight, so "read the next
line" is always "read the response to the request just sent."

### 3. Endpoint (`serve.py`) — `POST /mcp/investigate`

Request: `{"prompt": "..."}`

Response: `200`, no `Content-Length` (matches the existing `/proxy` streaming
pattern), body is newline-delimited JSON flushed after each event:

```
{"type":"tool_call","tool":"forticnapp_inventory_search","input":{...}}
{"type":"tool_result","tool":"forticnapp_inventory_search","summary":"42 rows returned"}
{"type":"final","text":"## Cloud Investigation: ...\n\n..."}
```

Server-side loop (capped at 6 iterations):
1. `_mcp_ensure_started()`.
2. `messages = [{"role":"user","content":prompt}]` with a system prompt
   establishing a read-only FortiCNAPP investigation assistant.
3. Loop: call `DIRECT_UPSTREAM` `/v1/messages` non-streaming,
   `tools=_mcp_state['tools']`.
   - `tool_use` blocks present → write `tool_call` chunk per call, execute via
     `_mcp_call_tool`, write `tool_result` chunk (short human-readable summary,
     not the raw payload — full data stays in the model-facing conversation
     only), append to `messages`, continue loop.
   - No `tool_use` blocks (`stop_reason: end_turn`) → write `final` chunk, stream
     ends.
4. Iteration cap hit without a final answer → write a `final` chunk explaining
   the investigation was cut off, suggesting a narrower objective.

### 4. Frontend (`extension/panel.html`, `extension/panel.js`)

New tab in the existing `.lql-tabs` (the tab-switch handler at `panel.js:2740`
is already generic — `data-tab="investigate"` + `#lql-pane-investigate` needs no
JS wiring changes there):

```html
<div class="lql-tab" data-tab="investigate">🔎 Cloud Investigation</div>
```
```html
<div class="lql-pane" id="lql-pane-investigate">
  <div class="drawer-body">
    <input id="investigate-prompt" class="drawer-input" type="text"
           placeholder="e.g. find EC2 instances with public S3 buckets attached"
           autocomplete="off" style="flex:1;min-width:160px" />
    <button id="investigate-btn" class="drawer-btn primary">🔎 Investigate</button>
    <span id="investigate-status" class="drawer-status"></span>
  </div>
</div>
```

New handler, following the `runCveSearch()`/`guardBusy()` pattern:

```js
el('investigate-btn').addEventListener('click', runCloudInvestigation);

async function runCloudInvestigation() {
  const prompt = el('investigate-prompt').value.trim();
  if (!prompt || guardBusy()) return;
  el('lql-panel').classList.remove('open');
  history.push({ role: 'user', content: prompt });
  appendTurn('user', prompt);
  busy = true; el('send').disabled = true;
  const bubble = appendTurn('ai');
  // fetch(BASE_URL + '/mcp/investigate', {...}), read the NDJSON stream
  // line-by-line (same low-level reader.read() pattern readStream() already
  // uses, split on '\n' instead of SSE "data: " framing):
  //   tool_call/tool_result → append "🔧 tool_name — summary" status lines
  //   final → renderMarkdown, push to history as assistant turn, attach
  //           copy/pdf buttons — same finishing steps send() already does
  // finally: busy = false; el('send').disabled = false;
}
```

This is a parallel function to `send()`, not a reuse of it (`send()` POSTs
directly to the gateway; this POSTs to the new local endpoint) — but it ends
the same way `send()` does, so the result is indistinguishable from a normal
chat turn once complete.

## Error Handling & Safety

- **Subprocess crash**: `_mcp_ensure_started()` checks `proc.poll() is not None`
  before every use and respawns lazily — self-heals on the next investigation.
- **Subprocess never starts**: endpoint writes one `final` chunk with a clear
  one-line reason and closes.
- **Tool call timeout (60s)**: treated as a failed tool result, fed back to the
  model so it can adapt rather than hanging the whole investigation.
- **Iteration cap (6)**: hard stop with an explanatory final message.
- **Mutation safety**: `ENABLE_MUTATION_TOOLS=false` hardcoded at spawn time,
  never read from request payload.
- **`guardBusy()`**: reused as-is on the frontend — prevents overlapping
  investigations from corrupting `history`.
- **Large tool results**: `mcp_forticnapp`'s own `MAX_RESPONSE_BYTES` (5MB) cap
  already turns oversized responses into a `response_too_large` tool error; we
  just ensure that surfaces as a normal (non-fatal) `tool_result`.

## Testing Plan

1. **Subprocess handshake sanity check**: run `_mcp_ensure_started()` in
   isolation, confirm `tools/list` returns 37 tools with valid Anthropic-format
   schemas.
2. **End-to-end via curl**: `POST /mcp/investigate` with a real objective,
   verify the NDJSON stream produces `tool_call` → `tool_result` → `final` in
   order, and the final text is grounded in real tool data.
3. **Crash recovery**: kill the spawned subprocess mid-session, confirm the next
   investigation respawns cleanly.
4. **Iteration cap**: craft a prompt likely to loop, confirm it stops at 6 steps
   with the explanatory message.
5. **Mutation safety**: confirm `tools/list` never includes a mutating tool.
6. **UI**: reload the extension, run a real investigation, confirm
   `guardBusy()` blocks a second concurrent investigation, and confirm the
   final answer lands correctly in `history`.

## Known Limitations / Out of Scope

- No local-dev-mode (`python3 serve.py` directly) support — Docker only.
- Vendored `mcp_forticnapp` source is a one-time copy, not a live sync with the
  upstream project; future tool/spec changes there require manual re-vendoring.
- No mutation-tool support (by design — read-only investigation only).
- No per-request model override — uses the same `ANTHROPIC_DEFAULT_MODEL` every
  other server-side agent endpoint (`/lql/generate`) uses.
