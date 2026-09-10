# Running forticnapp-mcp against a local Ollama model

Standalone setup that connects this vendored FortiCNAPP MCP server to a local
Ollama model instead of Claude, using [mcphost](https://github.com/mark3labs/mcphost)
as the bridge. Lives entirely under `vendor/mcp_forticnapp/` and does not touch
`serve.py` or the extension — the main project's Cloud Investigation feature
(`POST /mcp/investigate`) is separate and Claude-only (hardcoded gate at
`serve.py:1733`, since non-Claude models routed through that gateway have been
observed leaking their own tool-call syntax as literal text instead of
proper tool calls).

## Architecture

```
You type a question
        |
        v
+------------------------- container -------------------------+
|                                                               |
|  entrypoint.sh                                                |
|  1. parses ~/.lacework.toml (mounted read-only)               |
|     via parse_lacework_toml.py -> exports FORTICNAPP_* env    |
|  2. execs mcphost, pointed at:                                |
|     - Ollama (default: qwen2.5:7b-instruct) as the "brain"    |
|     - mcp.json      -> how to spawn forticnapp-mcp             |
|     - system-prompt.txt -> output format contract              |
|                                                                 |
|  mcphost (the orchestrator)                                    |
|  - sends your question + allowed tool schemas -> Ollama       |
|  - Ollama decides which tool(s) to call                        |
|  - mcphost relays the call over stdio to the forticnapp-mcp    |
|    subprocess (spawned per mcp.json's "command")               |
|  - forticnapp-mcp hits the real FortiCNAPP REST API using       |
|    the exported creds, returns JSON                            |
|  - mcphost feeds the result back to Ollama; loop repeats        |
|    as needed (multiple tool calls per question)                |
|  - Ollama emits the final answer as HTML per system-prompt.txt |
|                                                                 |
+---------------------------+-----------------------------------+
                             | host.docker.internal:11434
                             v
                      Ollama (runs on the host, not in the container)
```

## Prerequisites

- Docker
- `~/.lacework.toml` with valid FortiCNAPP credentials (`lacework configure`)
- Ollama running locally (`ollama serve`) with a **tool-calling-capable** model
  pulled — check with:
  ```bash
  ollama show <model> | grep -A3 Capabilities
  # or: curl -s http://localhost:11434/api/show -d '{"name":"<model>"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['capabilities'])"
  ```
  Must include `tools`. Plenty of models don't (e.g. `llama3:8b-instruct-q4_K_M`
  reports only `['completion']` and fails outright with "does not support tools").

## Quick start

```bash
cd vendor/mcp_forticnapp
./run_ollama.sh
```

Builds the image (cached after the first run) and drops you into an
interactive `mcphost` chat session. Just ask questions in plain English —
Ollama decides which FortiCNAPP tools to call.

**Overrides:**
```bash
OLLAMA_MODEL=qwen3:8b ./run_ollama.sh                  # different pulled model (must support tools)
OLLAMA_URL=http://192.168.1.5:11434 ./run_ollama.sh    # Ollama on another host
LACEWORK_TOML=~/other.toml ./run_ollama.sh             # different credentials file
```

**One-shot (non-interactive) instead of the chat loop:**
```bash
docker run -it --rm \
  --add-host=host.docker.internal:host-gateway \
  -v ~/.lacework.toml:/run/secrets/lacework.toml:ro \
  mcp-forticnapp-ollama \
  mcphost -m ollama:qwen2.5:7b-instruct --provider-url http://host.docker.internal:11434 \
    --config /app/docker/mcp.json --system-prompt /app/docker/system-prompt.txt \
    -p "List the current open alerts."
```

## Files

| File | Role |
|---|---|
| `run_ollama.sh` | Entry point. Validates `~/.lacework.toml` exists, builds the image, runs the container with the toml mounted read-only and `OLLAMA_MODEL`/`OLLAMA_URL` passed through. |
| `docker/Dockerfile` | Multi-stage build. Stage 1 (`golang:1.26-bookworm`) compiles `mcphost` via `go install` (needs Go >= 1.26 — `mcphost@latest` as of this writing requires it). Stage 2 (`python:3.11-slim`) `pip install`s this vendored package from source and copies the `mcphost` binary + `docker/` dir in. |
| `docker/entrypoint.sh` | Container startup: parses credentials, defaults `OLLAMA_MODEL=qwen2.5:7b-instruct` / `OLLAMA_URL=http://host.docker.internal:11434`, then `exec`s `mcphost`. |
| `docker/parse_lacework_toml.py` | Reads the first `[profile]` section of the mounted toml (same rule as `serve.py`'s own `_lw_creds()`), prints `export FORTICNAPP_API_BASE_URL/KEY_ID/API_SECRET=...` for `entrypoint.sh` to `eval`. `FORTICNAPP_API_BASE_URL` is derived as `https://<account>.lacework.net`. |
| `docker/mcp.json` | Tells `mcphost` how to spawn `forticnapp-mcp` (stdio subprocess), what env vars to pass it, and `allowedTools` — the 10-tool allowlist (see below). |
| `docker/system-prompt.txt` | System prompt: investigator role + strict HTML report template (see Output format below). |

## Tool selection

`forticnapp-mcp` generates ~169 tools total from the full FortiCNAPP OpenAPI
spec; the default tag allowlist (`FORTICNAPP_ENABLED_TAGS`, unchanged here)
narrows that to 37 read-only tools. That's still too much tool-schema context
for a small local model to process quickly, so `docker/mcp.json`'s
`allowedTools` further restricts what's actually shown to Ollama to 10:

- `forticnapp_alerts_list`, `forticnapp_alerts_search` — alert triage
- `forticnapp_vulnerabilities_hosts_search`, `forticnapp_vulnerabilities_containers_search` — CVE exposure
- `forticnapp_inventory_search` — general CSPM/resource inventory
- `forticnapp_cloud_accounts_list` — onboarded cloud account scope
- `forticnapp_entities_machines_search`, `forticnapp_entities_containers_search`, `forticnapp_entities_k8s_pods_search` — entity drill-down
- `forticnapp_policies_list` — active detection/compliance policies

This is a client-side filter (`mcphost` still fetches the full 37-tool list
from the server, but only forwards these 10 schemas to the model) — the
vendored server itself is untouched. Edit the `allowedTools` array to change
the set; tool names are derived deterministically from the OpenAPI spec (see
`src/forticnapp_mcp/tool_registry.py`), list them all with:
```bash
docker run --rm -e FORTICNAPP_API_BASE_URL=https://dummy.lacework.net \
  -e FORTICNAPP_KEY_ID=dummy -e FORTICNAPP_API_SECRET=dummy \
  --entrypoint python3 mcp-forticnapp-ollama -c "
from forticnapp_mcp.openapi_loader import load_spec, extract_operations, select_operations
from forticnapp_mcp.config import load_settings
settings = load_settings()
spec = load_spec(settings.forticnapp_openapi_spec)
ops = select_operations(extract_operations(spec), settings.enabled_tags, settings.enable_mutation_tools)
for op in sorted(ops, key=lambda o: o.tool_name): print(op.tool_name)
"
```

Mutations stay disabled regardless (`ENABLE_MUTATION_TOOLS=false` is
hardcoded in `mcp.json`) — this setup is read-only by design.

## Model choice

Default is **`qwen2.5:7b-instruct`**: confirmed `tools`-capable, and its
32768-token default context window is a quarter of `llama3.1:8b`'s 131072.
That matters more than raw model size — `llama3.1:8b`'s huge default context
caused Ollama to load a 22GB KV cache and split 50/50 CPU/GPU, making even a
10-tool prompt take several minutes. Qwen2.5 is also generally more reliable
than Llama 3.1 at correctly-formed multi-field JSON tool arguments (relevant
for the `*_search` tools, which take nested filter objects).

Ruled out: `llama3:8b-instruct-q4_K_M` (no `tools` capability at all — hard
failure, not a quality tradeoff). Going lighter than `qwen2.5:7b-instruct`
(e.g. `qwen2.5:3b-instruct`, `llama3.2:3b`) is viable for faster responses but
expect more malformed tool-call JSON on the nested-filter search tools.

## Output format

`docker/system-prompt.txt` forces every final answer into HTML (semantic
tags only — `h2`/`h3`/`p`/`ul`/`table`, no CSS/inline styles/`<html>` wrapper):

1. **Alert Summary** — window, primary status, severity range
2. A table grouping findings by security domain (not one row per alert)
3. One `<h3>` section per risk area, citing concrete tool-result evidence, ending in an **Assessment**
4. **Priority Actions** — grouped P1 (urgent) / P2 (lower urgency)
5. **Executive Takeaway** — 2-4 sentences for a leader scanning quickly

Edit `docker/system-prompt.txt` and rebuild to change the format.

## Gotchas found while building this

- **`mcphost`'s model flag is `provider:model`**, not `provider/model` (the
  project's own README examples say `ollama/mistral`, which is wrong — the
  actual CLI, confirmed via `mcphost --help`, only accepts `ollama:model`).
- **`mcphost@latest` needs Go >= 1.26** — `golang:1.23-bookworm` fails with
  `requires go >= 1.26.0`.
- Always verify a candidate model's `tools` capability before wiring it in
  (`ollama show <model>` or `/api/show`) — Ollama fails the request outright
  ("does not support tools") rather than degrading gracefully.
- `docker build` can transiently fail with `DeadlineExceeded` pulling base
  images under load; just retry.
- **Qwen models can drift into Chinese** on analytical/summarization tasks
  even when the user's question and all tool data are in English. Fixed by
  adding an explicit "ALWAYS respond in English" instruction near the top of
  `system-prompt.txt`, plus a repeated reminder at the very end (smaller
  models weight instructions near the end of the prompt more heavily — a
  single instruction stated only once near the top isn't reliably enough).
  The same repetition trick was needed for the "HTML only, no Markdown"
  instruction — an early instance also produced plain Markdown-ish bullets
  despite the template.

## Rebuilding after any edit

```bash
cd vendor/mcp_forticnapp
docker build -t mcp-forticnapp-ollama -f docker/Dockerfile .
```

`run_ollama.sh` does this automatically on every run.
