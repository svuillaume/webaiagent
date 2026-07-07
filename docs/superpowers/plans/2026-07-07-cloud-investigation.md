# Cloud Investigation (FortiCNAPP MCP integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Cloud Investigation" tab to the Risk Hunting drawer that runs a server-side, multi-step LLM agent loop against read-only FortiCNAPP tools exposed by the `mcp_forticnapp` MCP server, streaming progress into the existing chat log.

**Architecture:** `serve.py` spawns `python3 -m forticnapp_mcp.main` as a persistent subprocess and speaks MCP's stdio JSON-RPC protocol directly (hand-rolled, stdlib only — `subprocess`/`json`/`threading`, no `mcp` SDK import in `serve.py` itself). A new `POST /mcp/investigate` endpoint runs a tool-use loop against the AI gateway (capped at 6 iterations) and streams newline-delimited JSON progress events. The extension's Risk Hunting drawer gets a third tab that posts to this endpoint and renders the result as a normal chat turn.

**Tech Stack:** Python 3 stdlib (`serve.py`), vanilla JS (`extension/panel.js`), `mcp_forticnapp`'s existing Python package (vendored, installed only inside the Docker image, never imported by `serve.py`).

## Global Constraints

- `serve.py` must remain zero-dependency stdlib Python — no `import mcp`/`httpx`/`pydantic` inside it. (source: `webaiagent/CLAUDE.md` "Key constraints"; spec "Background")
- `ENABLE_MUTATION_TOOLS` is hardcoded to `"false"` at subprocess spawn time — never read from a request payload. (spec "Decisions" table, "Error Handling & Safety")
- The MCP subprocess is a persistent, lazily-started singleton; all access to it is serialized behind one lock — no per-request ID multiplexing. (spec "Decisions" table)
- Docker only — no local `python3 serve.py` fallback path for this feature. (spec "Decisions" table)
- Tool-loop is capped at 6 iterations; on cap-out, return an explanatory final message rather than looping forever. (spec "Endpoint" section)
- Vendored `mcp_forticnapp` source is a one-time copy under `webaiagent/vendor/mcp_forticnapp/`, not a live sync. (spec "Decisions" table)
- This project has no automated test suite for `serve.py` (confirmed: no `pytest`/test files reference it) — verification throughout this plan is via real `curl`/manual commands against the running Docker container, matching the spec's own "Testing Plan" section and the existing convention used to verify every other fix in this session.

---

## Task 1: Vendor `mcp_forticnapp` source into the Docker build context

**Files:**
- Create: `webaiagent/vendor/mcp_forticnapp/pyproject.toml`
- Create: `webaiagent/vendor/mcp_forticnapp/lw.yaml`
- Create: `webaiagent/vendor/mcp_forticnapp/src/forticnapp_mcp/*.py` (all 11 files: `__init__.py`, `auth.py`, `config.py`, `errors.py`, `http_client.py`, `logging_utils.py`, `main.py`, `models.py`, `openapi_loader.py`, `tool_registry.py`, `utils.py` — `setup_cli.py` is a CLI helper not needed at runtime, skip it)
- Modify: `webaiagent/.gitignore` (if `vendor/` should be excluded — see Step 3)

**Interfaces:**
- Produces: `webaiagent/vendor/mcp_forticnapp/` — a pip-installable copy of the `forticnapp-mcp` package, consumed by Task 2's Dockerfile change.

- [ ] **Step 1: Copy the source tree**

```bash
mkdir -p /Users/svuillaume/tmp/personal_project/webaiagent/vendor/mcp_forticnapp/src
cp /Users/svuillaume/tmp/personal_project/mcp_forticnapp/pyproject.toml \
   /Users/svuillaume/tmp/personal_project/mcp_forticnapp/lw.yaml \
   /Users/svuillaume/tmp/personal_project/webaiagent/vendor/mcp_forticnapp/
cp -r /Users/svuillaume/tmp/personal_project/mcp_forticnapp/src/forticnapp_mcp \
   /Users/svuillaume/tmp/personal_project/webaiagent/vendor/mcp_forticnapp/src/
rm -f /Users/svuillaume/tmp/personal_project/webaiagent/vendor/mcp_forticnapp/src/forticnapp_mcp/setup_cli.py
find /Users/svuillaume/tmp/personal_project/webaiagent/vendor -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null
```

- [ ] **Step 2: Verify the copy is complete and installable in isolation**

```bash
cd /Users/svuillaume/tmp/personal_project/webaiagent/vendor/mcp_forticnapp
python3 -c "import ast, sys; [ast.parse(open(f).read(), f) for f in __import__('glob').glob('src/forticnapp_mcp/*.py')]; print('all files parse OK')"
ls src/forticnapp_mcp/
```
Expected: `all files parse OK`, and the directory listing shows 10 files (no `setup_cli.py`, no `__pycache__`).

- [ ] **Step 3: Add a note to `.gitignore` about the vendored copy staying tracked**

Read `/Users/svuillaume/tmp/personal_project/webaiagent/.gitignore` first — if it has a blanket `vendor/` or similar pattern that would exclude this, add an explicit exception. Vendored source must be **committed** (it's the only copy the Docker build can see), unlike typical `vendor/` directories that get `pip install`-populated at build time.

```bash
grep -n "vendor" /Users/svuillaume/tmp/personal_project/webaiagent/.gitignore || echo "no existing vendor rule — nothing to change"
```
If a rule exists that would exclude `vendor/mcp_forticnapp/`, add this line to `.gitignore`:
```
!vendor/mcp_forticnapp/
```
If no rule exists, skip this edit — the directory is tracked by default.

- [ ] **Step 4: Commit**

```bash
cd /Users/svuillaume/tmp/personal_project/webaiagent
git add vendor/mcp_forticnapp .gitignore
git commit -m "$(cat <<'EOF'
Vendor mcp_forticnapp source for the Cloud Investigation feature

Docker can't COPY from outside its build context, so this is a one-time
copy of the MCP server's source/spec into webaiagent/vendor/ (not a live
sync — see docs/superpowers/specs/2026-07-07-cloud-investigation-design.md).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Install the vendored package into the Docker image

**Files:**
- Modify: `webaiagent/Dockerfile`

**Interfaces:**
- Consumes: `webaiagent/vendor/mcp_forticnapp/` (Task 1).
- Produces: a container where `python3 -m forticnapp_mcp.main` is runnable, and `/app/vendor/mcp_forticnapp/lw.yaml` exists at a known absolute path — consumed by Task 3's subprocess spawn env (`FORTICNAPP_OPENAPI_SPEC`).

- [ ] **Step 1: Read the current Dockerfile**

```bash
cat /Users/svuillaume/tmp/personal_project/webaiagent/Dockerfile
```

- [ ] **Step 2: Add the vendored package COPY + pip install, after the lacework CLI install and before `WORKDIR /app`'s existing COPY lines**

Edit `/Users/svuillaume/tmp/personal_project/webaiagent/Dockerfile` — insert this block right after the existing `RUN --mount=type=secret...` SCA install block (currently ending at line 15) and before `WORKDIR /app` (currently line 17):

```dockerfile
WORKDIR /app
COPY vendor/mcp_forticnapp/ ./vendor/mcp_forticnapp/
RUN pip install --no-cache-dir ./vendor/mcp_forticnapp

COPY serve.py chatbox.html FortiCNAPP-LQL_Reference_Guide.txt ./
COPY extension/ ./extension/
```

This replaces the existing `WORKDIR /app` / `COPY serve.py ...` / `COPY extension/ ...` block (previously lines 17-19) — the vendored package install is inserted between `WORKDIR /app` and the existing app-file copies, keeping Docker's layer cache working correctly (the rarely-changing vendored package installs before the frequently-changing `serve.py`/`extension/` files, so edits to those don't invalidate the pip-install layer).

- [ ] **Step 3: Rebuild and verify the package installed**

```bash
cd /Users/svuillaume/tmp/personal_project/webaiagent
docker compose build webai 2>&1 | tail -30
docker compose run --rm webai python3 -c "import forticnapp_mcp; print('forticnapp_mcp importable OK')"
docker compose run --rm webai python3 -m forticnapp_mcp.main 2>&1 | head -5
```
Expected: `forticnapp_mcp importable OK`, and the second command should print a `forticnapp-mcp: configuration error: ...` one-liner on stderr and exit non-zero (since no `FORTICNAPP_*` env vars are set for this bare `docker compose run` — that's the correct fail-fast behavior documented in `mcp_forticnapp`'s README, confirming the package runs at all).

- [ ] **Step 4: Bring the real service back up and commit**

```bash
docker compose up -d webai 2>&1
docker compose ps -a 2>&1
git add Dockerfile
git commit -m "$(cat <<'EOF'
Install vendored mcp_forticnapp package into the webai Docker image

pip-installed into the container's site-packages only — serve.py never
imports it directly, it only shells out to the resulting console entry
point as a subprocess (Task 3), preserving serve.py's stdlib-only
constraint the same way the lacework CLI already does.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
Expected: `webai-serve` shows `Up` in `docker compose ps -a`.

---

## Task 3: MCP stdio client module in `serve.py`

**Files:**
- Modify: `webaiagent/serve.py` (new module-level functions, inserted after `_lw_profile()` — currently ending around line 2432, before `_port_open()` at line 2433)

**Interfaces:**
- Consumes: `_lw_creds()` (existing, `serve.py:2389`, returns `(account, api_key, api_secret)` tuple).
- Produces:
  - `_mcp_ensure_started() -> None` — raises `RuntimeError` with a one-line reason on failure; otherwise guarantees `_mcp_state['tools']` is populated (a `list[dict]` of Anthropic-format tool schemas: `{"name": str, "description": str, "input_schema": dict}`).
  - `_mcp_call_tool(name: str, arguments: dict, timeout: float = 60) -> dict` — returns the tool's `structuredContent` dict (the `ToolCallResult` envelope described in `mcp_forticnapp`'s README: `success`, `status_code`, `operation_id`, `request`, `data`, `pagination`, `error`), or raises `RuntimeError`/`TimeoutError` on transport failure.
  - Consumed by Task 4's `serve_mcp_investigate`.

MCP wire protocol reference (confirmed by reading `mcp_forticnapp/src/forticnapp_mcp/main.py`, which uses the standard `mcp` Python SDK's `stdio_server()` — this is JSON-RPC 2.0, one message per line over stdin/stdout, NOT Content-Length-framed like LSP):

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"webaiagent","version":"1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{...},"serverInfo":{...}}}
→ {"jsonrpc":"2.0","method":"notifications/initialized"}          (notification — no id, no response)
→ {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":...,"description":...,"inputSchema":{...}}, ...]}}
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"...","arguments":{...}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"..."}],"structuredContent":{...},"isError":false}}
```

- [ ] **Step 1: Add the module-level state and helper functions**

Insert into `/Users/svuillaume/tmp/personal_project/webaiagent/serve.py`, immediately after the `_lw_profile()` function (search for `def _lw_profile():`, insert after its closing blank line, before `def _port_open(port):`):

```python
# ── FortiCNAPP MCP client (Cloud Investigation) ──────────────────────────────
# Hand-rolled stdio JSON-RPC client — deliberately not importing the `mcp` SDK
# here, to keep serve.py's own imports stdlib-only. The vendored MCP server
# (webaiagent/vendor/mcp_forticnapp) is spawned as a subprocess and speaks
# newline-delimited JSON-RPC 2.0 over stdin/stdout, same as any MCP stdio
# server. Access is fully serialized behind _mcp_lock, so there is never more
# than one in-flight request — "read the next line" is always "read the
# response to the request just sent."
_mcp_lock  = threading.Lock()
_mcp_state = {'proc': None, 'tools': None, 'next_id': 1}
MCP_SPEC_PATH = os.path.join(DIR, 'vendor', 'mcp_forticnapp', 'lw.yaml')


def _mcp_next_id():
    _mcp_state['next_id'] += 1
    return _mcp_state['next_id']


def _mcp_write(proc, obj):
    proc.stdin.write(json.dumps(obj) + '\n')
    proc.stdin.flush()


def _mcp_read_response(proc, want_id, timeout=30):
    """Block-read lines from proc.stdout until one with id == want_id arrives.

    Lines without a matching id (server-initiated notifications, if any) are
    skipped. Raises TimeoutError if the process produces no matching line
    within `timeout` seconds, RuntimeError if the pipe closes (process died).
    """
    import queue
    q = queue.Queue()

    def _reader():
        line = proc.stdout.readline()
        q.put(line)

    t = threading.Thread(target=_reader, daemon=True)
    t.start()
    try:
        line = q.get(timeout=timeout)
    except queue.Empty:
        raise TimeoutError(f'MCP server did not respond within {timeout}s (id={want_id})')
    if not line:
        raise RuntimeError('MCP server closed its output pipe (process likely exited)')
    msg = json.loads(line)
    if msg.get('id') != want_id:
        # Only one request is ever in flight (serialized by _mcp_lock), so a
        # mismatched id means a protocol-level surprise — surface it rather
        # than silently discarding.
        raise RuntimeError(f'MCP server response id mismatch: expected {want_id}, got {msg.get("id")}')
    if 'error' in msg:
        raise RuntimeError(f'MCP error: {msg["error"]}')
    return msg.get('result', {})


def _mcp_ensure_started():
    """Lazily spawn (or respawn after a crash) the forticnapp-mcp subprocess,
    perform the initialize handshake, and cache its tool list."""
    with _mcp_lock:
        proc = _mcp_state['proc']
        if proc is not None and proc.poll() is None and _mcp_state['tools'] is not None:
            return  # already running and handshaken

        account, api_key, api_secret = _lw_creds()
        if not (account and api_key and api_secret):
            raise RuntimeError('FortiCNAPP credentials not found (~/.lacework.toml) — Cloud Investigation unavailable')
        if not os.path.exists(MCP_SPEC_PATH):
            raise RuntimeError(f'MCP spec not found at {MCP_SPEC_PATH} — was the image built with vendor/mcp_forticnapp?')

        env = dict(os.environ)
        env.update({
            'FORTICNAPP_API_BASE_URL':  f'https://{account}.lacework.net',
            'FORTICNAPP_KEY_ID':        api_key,
            'FORTICNAPP_API_SECRET':    api_secret,
            'FORTICNAPP_OPENAPI_SPEC':  MCP_SPEC_PATH,
            'ENABLE_MUTATION_TOOLS':    'false',
        })
        proc = subprocess.Popen(
            ['python3', '-m', 'forticnapp_mcp.main'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, env=env,
        )
        _mcp_state['proc']  = proc
        _mcp_state['tools'] = None

        init_id = _mcp_next_id()
        _mcp_write(proc, {
            'jsonrpc': '2.0', 'id': init_id, 'method': 'initialize',
            'params': {
                'protocolVersion': '2024-11-05',
                'capabilities': {},
                'clientInfo': {'name': 'webaiagent', 'version': '1.0'},
            },
        })
        _mcp_read_response(proc, init_id, timeout=30)
        _mcp_write(proc, {'jsonrpc': '2.0', 'method': 'notifications/initialized'})

        list_id = _mcp_next_id()
        _mcp_write(proc, {'jsonrpc': '2.0', 'id': list_id, 'method': 'tools/list', 'params': {}})
        result = _mcp_read_response(proc, list_id, timeout=30)
        _mcp_state['tools'] = [
            {'name': t['name'], 'description': t.get('description', ''), 'input_schema': t['inputSchema']}
            for t in result.get('tools', [])
        ]


def _mcp_call_tool(name, arguments, timeout=60):
    with _mcp_lock:
        proc = _mcp_state['proc']
        if proc is None or proc.poll() is not None:
            raise RuntimeError('MCP subprocess is not running — call _mcp_ensure_started() first')
        call_id = _mcp_next_id()
        _mcp_write(proc, {
            'jsonrpc': '2.0', 'id': call_id, 'method': 'tools/call',
            'params': {'name': name, 'arguments': arguments or {}},
        })
        result = _mcp_read_response(proc, call_id, timeout=timeout)
        if result.get('structuredContent') is not None:
            return result['structuredContent']
        # Fallback: some tool results may only populate content[0].text (JSON-encoded)
        content = result.get('content') or []
        if content and content[0].get('type') == 'text':
            try:
                return json.loads(content[0]['text'])
            except json.JSONDecodeError:
                return {'success': not result.get('isError', False), 'data': content[0]['text']}
        return {'success': not result.get('isError', False), 'data': None}
```

- [ ] **Step 2: Verify the module loads without syntax errors**

```bash
cd /Users/svuillaume/tmp/personal_project/webaiagent
python3 -c "import ast; ast.parse(open('serve.py').read()); print('serve.py parses OK')"
```
Expected: `serve.py parses OK`

- [ ] **Step 3: Verify the real handshake against the running container**

```bash
docker compose up -d --build webai 2>&1 | tail -10
docker compose exec webai python3 -c "
import sys; sys.path.insert(0, '/app')
import serve
serve._mcp_ensure_started()
print(f'{len(serve._mcp_state[\"tools\"])} tools loaded')
print(serve._mcp_state['tools'][0]['name'])
"
```
Expected: a line like `37 tools loaded` (or however many the default `FORTICNAPP_ENABLED_TAGS` selects) followed by a real tool name (e.g. something like `forticnapp_alerts_search_post` — exact name depends on `mcp_forticnapp`'s collision-resolution naming, don't hardcode an assumption, just confirm it's a non-empty string).

- [ ] **Step 4: Verify a real tool call executes and returns data**

```bash
docker compose exec webai python3 -c "
import sys; sys.path.insert(0, '/app')
import serve
serve._mcp_ensure_started()
tools = [t['name'] for t in serve._mcp_state['tools']]
cloud_accounts_tool = next((n for n in tools if 'cloudaccount' in n.lower()), tools[0])
print('calling:', cloud_accounts_tool)
result = serve._mcp_call_tool(cloud_accounts_tool, {})
print('success:', result.get('success'), 'status_code:', result.get('status_code'))
"
```
Expected: `success: True status_code: 200` (or a clear `success: False` with a real FortiCNAPP API error message in `result['error']` if that specific tool needs different arguments — either outcome confirms the transport layer works; if it hangs or raises `TimeoutError`/`RuntimeError`, the client implementation needs debugging before moving on).

- [ ] **Step 5: Verify no mutating tools leaked into the list (spec: "Mutation safety")**

`mcp_forticnapp` derives tool names from `method + path` (see its `CLAUDE.md`) and, per its own `select_operations()` classification, mutating operations are GET-excluded and non-`/search`-POST-excluded — with `ENABLE_MUTATION_TOOLS=false` (set in Step 1's spawn env), none should be present at all. Confirm directly against the live list rather than trusting the env var alone:

```bash
docker compose exec webai python3 -c "
import sys; sys.path.insert(0, '/app')
import serve
serve._mcp_ensure_started()
names = [t['name'] for t in serve._mcp_state['tools']]
suspect = [n for n in names if any(n.lower().endswith(s) for s in ('_post', '_put', '_patch', '_delete')) and '_search' not in n.lower()]
print(f'{len(names)} total tools, {len(suspect)} suspected mutating')
print(suspect)
"
```
Expected: `0 suspected mutating`, empty list. If this is non-empty, stop — do not proceed to Task 4 until `ENABLE_MUTATION_TOOLS=false` is confirmed to actually suppress these (check `mcp_forticnapp/src/forticnapp_mcp/openapi_loader.py`'s `select_operations()` for how it reads that setting).

- [ ] **Step 6: Commit**

```bash
git add serve.py
git commit -m "$(cat <<'EOF'
Add hand-rolled MCP stdio client to serve.py

Speaks MCP's JSON-RPC-over-stdio protocol directly (initialize, tools/list,
tools/call) against the vendored forticnapp-mcp subprocess, keeping
serve.py's own imports stdlib-only. Access is serialized behind one lock;
the subprocess is a lazy, persistent singleton that respawns on crash.

Verified against the real container: handshake loads the live tool list
and a real tools/call executes against the actual FortiCNAPP tenant.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `POST /mcp/investigate` endpoint

**Files:**
- Modify: `webaiagent/serve.py`
  - Add routing line in `do_POST` (currently `serve.py:565-585`)
  - Add `serve_mcp_investigate` method to the `Handler` class (place it near `serve_lql_generate`, e.g. immediately before `def serve_lql_generate(self):` at `serve.py:1636`)
  - Update the module docstring's route table (`serve.py:7-20`)

**Interfaces:**
- Consumes: `_mcp_ensure_started()`, `_mcp_state['tools']`, `_mcp_call_tool(name, arguments, timeout)` (Task 3); `VIRTUAL_KEY`, `MODEL`, `current_upstream()` (existing module globals, `serve.py:46-71`).
- Produces: `POST /mcp/investigate` — request `{"prompt": str}`, response `200` with `Content-Type: application/x-ndjson`, body is newline-delimited JSON objects of the form `{"type":"tool_call",...}` / `{"type":"tool_result",...}` / `{"type":"final","text":str}`. Consumed by Task 6's frontend handler.

- [ ] **Step 1: Add the route in `do_POST`**

In `/Users/svuillaume/tmp/personal_project/webaiagent/serve.py`, find:
```python
        elif self.path == '/model':
            self.serve_model_update()
        else:
            self.send_error(404)
```
Replace with:
```python
        elif self.path == '/model':
            self.serve_model_update()
        elif self.path == '/mcp/investigate':
            self.serve_mcp_investigate()
        else:
            self.send_error(404)
```

- [ ] **Step 2: Update the module docstring's route table**

In the same file, find the docstring block starting `GET  /              → chatbox.html` (`serve.py:7`). After the line:
```
POST /model           → persist the extension's model picker as ANTHROPIC_DEFAULT_MODEL
```
Add:
```
POST /mcp/investigate → Cloud Investigation: agent loop over read-only FortiCNAPP MCP tools
```

- [ ] **Step 3: Add the endpoint handler**

Insert into `/Users/svuillaume/tmp/personal_project/webaiagent/serve.py`, immediately before `def serve_lql_generate(self):` (`serve.py:1636`):

```python
    def serve_mcp_investigate(self):
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {prompt}')
            return
        prompt = (payload.get('prompt') or '').strip()
        if not prompt:
            self.send_json(400, json.dumps({'error': 'prompt is required'}).encode())
            return

        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

        def emit(obj):
            self.wfile.write((json.dumps(obj) + '\n').encode())
            self.wfile.flush()

        try:
            _mcp_ensure_started()
        except RuntimeError as e:
            emit({'type': 'final', 'text': f'Cloud Investigation is unavailable: {e}'})
            return

        if not DIRECT_UPSTREAM or not VIRTUAL_KEY:
            emit({'type': 'final', 'text': 'Gateway URL or virtual key not configured.'})
            return

        system_prompt = (
            "You are a read-only FortiCNAPP cloud security investigator. Use the "
            "available tools to answer the user's objective by querying their real "
            "tenant data. Call as many tools as needed to gather evidence, then give "
            "a clear, evidence-grounded narrative answer citing the specific "
            "resources/accounts/regions you found. Never fabricate data not returned "
            "by a tool call. If a tool call fails, note the failure and try a "
            "different approach rather than guessing at an answer."
        )
        messages = [{'role': 'user', 'content': prompt}]

        MAX_ITERATIONS = 6
        for _ in range(MAX_ITERATIONS):
            body = json.dumps({
                'model': MODEL or 'claude-haiku-4-5',
                'max_tokens': 4096,
                'system': system_prompt,
                'messages': messages,
                'tools': _mcp_state['tools'],
            }).encode()
            req = urllib.request.Request(
                current_upstream().rstrip('/') + '/v1/messages', data=body, method='POST',
                headers={'Content-Type': 'application/json', 'x-api-key': VIRTUAL_KEY,
                          'anthropic-version': '2023-06-01'})
            try:
                resp = urllib.request.urlopen(req, timeout=90)
                resp_data = json.loads(resp.read())
            except urllib.error.HTTPError as e:
                err_body = e.read()
                try:
                    msg = json.loads(err_body).get('error', {}).get('message', err_body.decode()[:400])
                except Exception:
                    msg = err_body.decode()[:400]
                emit({'type': 'final', 'text': f'Investigation failed: {msg}'})
                return

            content_blocks = resp_data.get('content', [])
            tool_use_blocks = [b for b in content_blocks if b.get('type') == 'tool_use']

            if not tool_use_blocks:
                text = ''.join(b.get('text', '') for b in content_blocks if b.get('type') == 'text')
                emit({'type': 'final', 'text': text or 'No answer was generated.'})
                return

            messages.append({'role': 'assistant', 'content': content_blocks})
            tool_results = []
            for block in tool_use_blocks:
                emit({'type': 'tool_call', 'tool': block['name'], 'input': block.get('input', {})})
                try:
                    result = _mcp_call_tool(block['name'], block.get('input', {}))
                    rows = result.get('data')
                    count = len(rows) if isinstance(rows, list) else ('1' if result.get('success') else '0')
                    summary = f'{count} result(s)' if result.get('success') else f"error: {result.get('error')}"
                except (RuntimeError, TimeoutError) as e:
                    result  = {'success': False, 'error': str(e)}
                    summary = f'error: {e}'
                emit({'type': 'tool_result', 'tool': block['name'], 'summary': summary})
                tool_results.append({
                    'type': 'tool_result', 'tool_use_id': block['id'],
                    'content': json.dumps(result)[:20000],  # keep the model's own context bounded
                })
            messages.append({'role': 'user', 'content': tool_results})

        emit({'type': 'final', 'text': f'Investigation exceeded the {MAX_ITERATIONS}-step limit — try narrowing the objective.'})
```

- [ ] **Step 4: Verify syntax**

```bash
cd /Users/svuillaume/tmp/personal_project/webaiagent
python3 -c "import ast; ast.parse(open('serve.py').read()); print('serve.py parses OK')"
```
Expected: `serve.py parses OK`

- [ ] **Step 5: Rebuild and verify end-to-end via curl**

```bash
docker compose up -d --build webai 2>&1 | tail -10
curl -s -N -X POST http://localhost:45321/mcp/investigate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"List the cloud accounts connected to this FortiCNAPP tenant."}'
```
Expected: a stream of NDJSON lines — at least one `{"type":"tool_call",...}`, a matching `{"type":"tool_result",...}`, and a final `{"type":"final","text":"..."}` whose text references real account data (not a generic "I don't have access" response — apply the same verification method used earlier this session for the Headroom compression bug: read the actual final text, don't just check the HTTP status).

- [ ] **Step 6: Verify the iteration cap with a deliberately open-ended prompt**

```bash
curl -s -N -X POST http://localhost:45321/mcp/investigate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Investigate everything about this cloud environment in exhaustive detail across every service."}' \
  | tail -3
```
Expected: eventually a `{"type":"final",...}` line — either a real answer (if the model wraps up in under 6 steps) or the exceeded-limit message. Confirm the request does NOT hang indefinitely (should complete within a few minutes given the 90s per-call timeout × 6 iterations).

- [ ] **Step 7: Commit**

```bash
git add serve.py
git commit -m "$(cat <<'EOF'
Add POST /mcp/investigate endpoint

Server-side agent loop (capped at 6 tool calls) over the MCP client from
the previous commit, streaming tool_call/tool_result/final NDJSON events.
Verified end-to-end against the real container and FortiCNAPP tenant.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Frontend UI — new "Cloud Investigation" tab

**Files:**
- Modify: `webaiagent/extension/panel.html`

**Interfaces:**
- Consumes: existing `.lql-tabs` / `.lql-pane` tab-switch machinery (`extension/panel.js:2740-2746`, unmodified — it's already generic over `data-tab`).
- Produces: DOM elements `#investigate-prompt`, `#investigate-btn`, `#investigate-status` — consumed by Task 6.

- [ ] **Step 1: Add the tab button**

In `/Users/svuillaume/tmp/personal_project/webaiagent/extension/panel.html`, find:
```html
    <div class="lql-tab active" data-tab="saved">LQL</div>
    <div class="lql-tab" data-tab="generate">✨ Assisted Investigation</div>
```
Replace with:
```html
    <div class="lql-tab active" data-tab="saved">LQL</div>
    <div class="lql-tab" data-tab="generate">✨ Assisted Investigation</div>
    <div class="lql-tab" data-tab="investigate">🔎 Cloud Investigation</div>
```

- [ ] **Step 2: Add the pane**

In the same file, find the closing of the `#lql-pane-generate` div:
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
</div>
```
Replace the final `</div>` (the one closing `#lql-panel`) with a new pane inserted before it:
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

  <div class="lql-pane" id="lql-pane-investigate">
    <div class="drawer-body">
      <input id="investigate-prompt" class="drawer-input" type="text"
             placeholder="e.g. find EC2 instances with public S3 buckets attached"
             autocomplete="off" style="flex:1;min-width:160px" />
      <button id="investigate-btn" class="drawer-btn primary">🔎 Investigate</button>
      <span id="investigate-status" class="drawer-status"></span>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Verify the HTML is well-formed**

```bash
cd /Users/svuillaume/tmp/personal_project/webaiagent
python3 -c "
import re
html = open('extension/panel.html').read()
assert html.count('id=\"lql-pane-saved\"') == 1
assert html.count('id=\"lql-pane-generate\"') == 1
assert html.count('id=\"lql-pane-investigate\"') == 1
assert html.count('data-tab=\"investigate\"') == 1
print('structure OK')
"
```
Expected: `structure OK`

- [ ] **Step 4: Commit**

```bash
git add extension/panel.html
git commit -m "$(cat <<'EOF'
Add Cloud Investigation tab to the Risk Hunting drawer

New third tab alongside LQL and Assisted Investigation, reusing the same
drawer-input/drawer-btn/drawer-status classes — no new CSS needed. Wired
up to POST /mcp/investigate in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Frontend JS — wire the tab to `/mcp/investigate`

**Files:**
- Modify: `webaiagent/extension/panel.js`

**Interfaces:**
- Consumes: `guardBusy()` (`panel.js:916`), `history` (`panel.js:84`), `appendTurn()` (`panel.js:574`), `renderMarkdown()` (`panel.js:295`), `setRendered()` (`panel.js:421`), `makeCopyBtn()`/`makePdfBtn()` (`panel.js:476`/`488`), `scrollLog()` (`panel.js:440`), `esc()` (`panel.js:81`), `el()` helper, `BASE_URL` (`panel.js:4`), module-level `busy` (`panel.js:85`).
- Produces: `runCloudInvestigation()` — click handler for `#investigate-btn`.

- [ ] **Step 1: Add the handler**

In `/Users/svuillaume/tmp/personal_project/webaiagent/extension/panel.js`, find the existing tab-switch wiring block:
```js
document.querySelectorAll('.lql-tab').forEach(tab => {
```
Insert the new function and its event listener immediately **before** that block:

```js
el('investigate-btn').addEventListener('click', runCloudInvestigation);
el('investigate-prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter') runCloudInvestigation();
});

async function runCloudInvestigation() {
  const prompt = el('investigate-prompt').value.trim();
  if (!prompt) return;
  if (guardBusy()) return;

  const btn      = el('investigate-btn');
  const statusEl = el('investigate-status');
  btn.disabled = true;
  statusEl.textContent = 'investigating…';
  statusEl.className   = '';

  el('lql-panel').classList.remove('open');
  history.push({ role: 'user', content: prompt });
  appendTurn('user', prompt);

  busy = true;
  el('send').disabled = true;
  const bubble = appendTurn('ai');
  const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
  bubble.appendChild(cursor);

  let finalText = '';
  try {
    const res = await fetch(BASE_URL + '/mcp/investigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'tool_call') {
          const row = document.createElement('div');
          row.className = 'cve-row';
          row.innerHTML = `<span class="cve-label">🔧 ${esc(ev.tool)}</span>`;
          bubble.insertBefore(row, cursor);
          scrollLog();
        } else if (ev.type === 'tool_result') {
          const rows = bubble.querySelectorAll('.cve-row');
          const last = rows[rows.length - 1];
          if (last) last.innerHTML += ` <span class="cve-val">${esc(ev.summary)}</span>`;
          scrollLog();
        } else if (ev.type === 'final') {
          finalText = ev.text || '';
        }
      }
    }
    cursor.remove();
    if (finalText) {
      // Use a plain appendChild here, NOT setRendered(bubble, ...) — setRendered
      // does node.replaceChildren(), which would wipe out the 🔧 tool_call/
      // tool_result rows already inserted into `bubble` above. The final answer
      // must be appended after them, not replace them.
      const node = document.createElement('div');
      setRendered(node, renderMarkdown(finalText));
      bubble.appendChild(node);
      bubble.appendChild(makeCopyBtn(finalText));
      bubble.appendChild(makePdfBtn(node));
      // Mirror only the final answer (not the tool-call trail) into the History
      // pane — matches the existing precedent where readStream()'s searchMarker
      // is also never mirrored into bubble._allBody.
      if (bubble._allBody) {
        const allNode = document.createElement('div');
        setRendered(allNode, renderMarkdown(finalText));
        bubble._allBody.appendChild(allNode);
        bubble._allBody.appendChild(makeCopyBtn(finalText));
        bubble._allBody.appendChild(makePdfBtn(allNode));
      }
    }
    history.push({ role: 'assistant', content: finalText });
    statusEl.textContent = 'done';
    statusEl.className   = 'ok';
  } catch (err) {
    cursor.remove();
    bubble.textContent = `Error: ${err.message}`;
    history.pop();
    statusEl.textContent = 'error';
    statusEl.className   = 'err';
  } finally {
    busy = false;
    el('send').disabled = false;
    btn.disabled = false;
    scrollLog();
  }
}
```

- [ ] **Step 2: Verify syntax**

```bash
cd /Users/svuillaume/tmp/personal_project/webaiagent
node --check extension/panel.js && echo "panel.js OK"
```
Expected: `panel.js OK`

- [ ] **Step 3: Commit**

```bash
git add extension/panel.js
git commit -m "$(cat <<'EOF'
Wire the Cloud Investigation tab to POST /mcp/investigate

Follows the same guardBusy()/history/appendTurn pattern as the CVE and
LQL auto-trigger flows, but reads a newline-delimited JSON stream
(tool_call/tool_result/final) instead of Anthropic's SSE format, since
the endpoint is a local server-side agent loop, not a direct model call.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: End-to-end verification in the real extension

**Files:** none (verification only)

- [ ] **Step 1: Confirm the container is running the latest build**

```bash
cd /Users/svuillaume/tmp/personal_project/webaiagent
docker compose up -d --build webai 2>&1 | tail -10
docker compose ps -a 2>&1
```
Expected: `webai-serve` shows `Up`.

- [ ] **Step 2: Reload the extension**

Tell the user to reload the unpacked extension at `chrome://extensions` (this cannot be done from the terminal — it requires the user's browser).

- [ ] **Step 3: Manually drive the real UI flow and confirm each spec requirement**

Open the side panel → FortiCNAPP → Risk Hunting → the new "🔎 Cloud Investigation" tab. Enter a real objective (e.g. "what cloud accounts are connected to this tenant?") and click Investigate. Confirm:
- The drawer closes and a user turn appears in the chat log with the typed prompt (spec: "Output UX — appears in the main chat log").
- `🔧 tool_name` status lines appear incrementally before the final answer (spec: "Progress UX — streamed step-by-step status").
- The final answer is a real narrative grounded in actual tenant data, not a generic response (same failure mode fixed for the CVE report earlier this session — verify by eye, don't just check that *an* answer appeared).
- Clicking Investigate again while the first is still running shows the "Still processing the previous request" system message rather than corrupting the chat (spec: "guardBusy() reused as-is").
- The answer is visible in both the "Latest" and "History" log panes, and has working copy/PDF buttons, matching every other AI turn.

- [ ] **Step 4: Confirm no regression in the two existing Risk Hunting tabs**

Click the "LQL" and "✨ Assisted Investigation" tabs — confirm they still switch panes and function exactly as before (the new tab was added alongside them, not replacing any existing wiring).

- [ ] **Step 5: Report results to the user**

Summarize what was tested and its outcome. If anything in Step 3 or 4 didn't match expectations, stop and fix it before considering the feature complete — do not report success without having actually driven the real UI.
