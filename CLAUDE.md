# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

FortiCNAPP AI Agent (Alpha — early-stage, expect rapid change) is a browser-native AI security assistant: a Chrome extension (side panel) backed by a local Python HTTP server (`serve.py`). Chat runs fully in-browser and offline via `@mlc-ai/web-llm` (WebGPU), running **Qwen2.5-3B-Instruct** (default, fastest), **Qwen2.5-7B-Instruct**/**Qwen2.5-Coder-7B**, or **Hermes-2-Pro-Llama-3-8B** (switchable via the Admin menu's model dropdown) on-device — no server, gateway, or network round-trip for chat itself. `serve.py` is a CORS proxy for FortiCNAPP security tools (CodeSec, SBOM, Compliance, Risk Hunting/LQL, CVE lookup, Cloud Investigation) and also powers its own server-side Claude/Ollama calls for `/lql/generate` and `/mcp/investigate` (see Architecture below) — those remain gateway-based and are unrelated to the in-browser chat path.

One other component lives in this repo but is separate from the extension/`serve.py` pair above:
- `vendor/mcp_forticnapp/` — a vendored (one-time copy, not a live dependency) MCP server that exposes FortiCNAPP's API as tools; `serve.py` spawns it as a subprocess for the Cloud Investigation feature (see Architecture below). Has its own README with its own architecture notes — read that before touching files under this directory.


## Running the backend

**Recommended — Docker (minimal endpoint setup, everything self-contained):**
```bash
docker compose up -d          # first run; builds the image
docker compose up --build -d webai     # after any change to serve.py or chatbox.html
docker compose down
```
Only Docker needs to be installed — lacework CLI + SCA component are baked into the image.

**Alternative — Python directly (macOS dev only, lacework CLI must be installed locally):**
```bash
python3 serve.py              # http://localhost:45321
```

`serve.py` is pure Python stdlib — no pip install needed.

**First-time setup:**
```bash
./setup.sh        # interactive: creates .env, starts the service
```
On Windows: `setup.ps1`

## Configuration

Copy `.env.tpl` → `.env` and fill in — these only affect `/lql/generate` and `/mcp/investigate`; the extension's chat is on-device and needs none of this:
- `ANTHROPIC_BASE_URL` — AI gateway endpoint (e.g. `https://your-gateway.example.com/anthropic`)
- `BIFROST_VIRTUAL_KEY` — gateway virtual key (`sk-bf-…`)
- `ANTHROPIC_DEFAULT_MODEL` — model for `/lql/generate`'s server-side calls (default: `claude-haiku-4-5`)
- `LQL_QUERIES_DIR` — path to `.yaml` LQL query files; in Docker this is mounted at `/lql_queries` (docker-compose hardcodes `~/claude_cnapp/lql/lql_queries` as the host path — edit docker-compose.yml to change it)

FortiCNAPP credentials: `~/.lacework.toml` (from `lacework configure`), mounted read-only into the container. `_lw_creds()` in `serve.py` resolves credentials at every call site — `LW_ACCOUNT`/`LW_API_KEY`/`LW_API_SECRET` env vars first (if all three are set), falling back to parsing `~/.lacework.toml`'s `[default]`-equivalent fields. `LW_PROFILE` (`_lw_profile()`) is always `''` (no `--profile` flag passed to the `lacework` CLI) — env-var creds authenticate directly with no profile, and the toml fallback only supports a `[default]`-named profile (run `lacework configure` with no `--profile` flag).

`serve.py` loads `.env` at startup; `.env` values **override** real environment variables. Restart required after any change — except `ANTHROPIC_DEFAULT_MODEL`, which takes effect live via its `POST` endpoint without a restart (see Non-obvious runtime behaviour below).

`.env` is bind-mounted into the container (`./.env:/app/.env` in docker-compose.yml), not baked in at build time — this is what lets the live-toggle endpoint above persist its writes back to the real host file.

**`extension/config.json`** — offline fallback config for the extension when `serve.py` is not running. Create from `config.json.tpl`. The extension tries `GET /config` from serve.py first (for `lw_ready`/`lw_cli` — chat itself needs neither); if that fails, it falls back to this bundled file. It is not committed (untracked in git).

## Architecture

```
Chrome Extension (extension/)
  │
  ├─ Chat ──────────► @mlc-ai/web-llm (vendored, extension/vendor/web-llm/)
  │                        └──► Qwen2.5-3B-Instruct (default), or Qwen2.5-7B-Instruct/Coder-7B, on-device via WebGPU — no network, no server
  │
  └─ Security tools ► serve.py  localhost:45321
                           ├──► FortiCNAPP REST API  (via lacework CLI)
                           ├──► lacework CLI  (SCA/SAST, IaC misconfig, SBOM, LQL validate/run)
                           ├──► FortiGuard  (outbreak RSS + page scrape, cached 30 min)
                           ├──► NVD / EPSS / CISA KEV  (CVE intel aggregation)
                           ├──► AI Gateway (ANTHROPIC_BASE_URL, from .env) — /lql/generate, /mcp/investigate only
                           └──► vendor/mcp_forticnapp subprocess  (Cloud Investigation — see below)
```

**Cloud Investigation** (`POST /mcp/investigate`) is a separate server-side agent loop from `/lql/generate`. `serve.py` lazily spawns `vendor/mcp_forticnapp` (a vendored, one-time copy of an external MCP server — see `vendor/mcp_forticnapp/README.md`) as a subprocess and speaks newline-delimited JSON-RPC 2.0 over its stdin/stdout — a hand-rolled client, not the `mcp` SDK, to keep `serve.py`'s own imports stdlib-only. `_mcp_ensure_started()`/`_mcp_call_tool()` (bottom of `serve.py`) serialize all access behind `_mcp_lock`, so at most one request is ever in flight and respawn-on-crash is just "poll() is not None → spawn again." The loop calls read-only FortiCNAPP tools (`ENABLE_MUTATION_TOOLS` hardcoded `false`, never read from the request) for up to 6 iterations, streaming `{"type":"tool_call"|"tool_result"|"final"}` NDJSON chunks back to the browser. Design doc: `docs/superpowers/specs/2026-07-07-cloud-investigation-design.md`. In the extension this is the "🔎 Cloud Investigation" tab inside the Risk Hunting drawer, alongside saved LQL queries and "✨ Assisted Investigation" (`/lql/generate`) — `extension/panel.js` renders both onto the same two-part output layout.

Because `vendor/mcp_forticnapp` is vendored (not a live dependency), Docker-only: the Dockerfile `pip install`s it into the container so `serve.py` can `subprocess.Popen(['python3', '-m', 'forticnapp_mcp.main'])`; there is no local-dev-mode (`python3 serve.py` directly) fallback. Future upstream changes to `mcp_forticnapp` need manual re-vendoring, not a sync step.

**FortiCNAPP Forensic** (`POST /mcp/forensic`, the "🔎 FortiCNAPP Forensic (REST API)" tab alongside Cloud Investigation) shares `_run_mcp_agent_loop` with `/mcp/investigate` — same tool-selecting loop, same 6-iteration budget, pinned to Claude Haiku-4.5 at low temperature/top_k for deterministic tool picks. It differs by `mechanical_report=True`: once the loop stops requesting tools (or the budget is spent), the final `Finding | What It Means / Why It Matters | Next Steps to Remediate` table is **not** GenAI-written — `_build_mechanical_report()` builds it directly in Python from every row gathered across all tool calls (`collected_rows`), templating Finding from the first identifying field found (`ARN`/`resourceId`/`id`/etc.), "Returned by `<tool_name>`" for Why, and always "None — informational only" for Remediate (no model available to judge remediation safely). Same table shape/columns as the GenAI-written version in `/mcp/investigate`'s `system_prompt` and `panel.js`'s `INCIDENT_REPORT_TEMPLATE`, for visual consistency — but zero model-composed text in this one.

**AI-generated reports (Unified Attack Threat Surface CVE only)** — Risk Hunting (LQL saved query / Assisted Investigation) results render as just the raw table (`renderLqlTable`) with no AI analysis offered — it wasn't adding enough value there and was removed. The CVE/Unified Attack Threat Surface report keeps the opt-in AI analysis: unlike Cloud Investigation's server-side final answer, it comes from a *second* on-device call, entirely in `extension/panel.js`. After `/lql/cve` returns rows, the raw table renders immediately in its result card — AI analysis is opt-in, not automatic: `appendResultCard(icon, title, contentEl, { onAnalyse })` adds a "🤖 Generate AI Analysis" button to the card footer, and only clicking it pushes a synthetic user turn (row data + `buildReportInstructions()`) onto `history` and calls `send(true)`, running the same WebLLM `engine.chat.completions.create({stream:true})` call a normal chat turn uses. `INCIDENT_REPORT_TEMPLATE` is a single Markdown-table template — it overrides `SYSTEM_PROMPT`'s default structure per that prompt's own precedence rule ("if the user's message includes an explicit report template, follow that EXACTLY"). `buildCveAnalysisPrompt()` layers CVE-specific guidance (exact patch commands, a pre-computed risk-profile radar chart — injected only into the first batch, see below) on top of that template; `_regulatoryContext()` layers region-based compliance obligations (PIPEDA, GDPR/NIS2, etc.) on top, folded in as extra table rows rather than a separate section. Row data sent to the model is capped at 100 rows — deliberately lower than the 200-row cap `renderLqlTable`'s own display/CSV export uses — because the template requires one row per matching resource (so the AI report can't under-report what the raw table above it already shows in full), and that needs more output tokens than `MAX_TOKENS` (8192) reliably delivers past ~120 rows; a `coverage` note is appended to the prompt whenever the true row count exceeds the sample, so the report states honestly that it's partial instead of silently mismatching the total count.

**Batched AI analysis** — `_runBatchedAnalysis(items, batchSize, buildPrompt, describeTurn)` (only remaining `onAnalyse` call site: CVE search) processes at most 10 CVE hosts per generation, then appends a "▶ Continue analysis (N more)" button to the AI's reply bubble instead of silently continuing to the next chunk — keeps any single generation fast and lets the user stop after the first batch if that's enough. `send()` returns the AI's reply bubble element so this helper can attach the continue button to it.

**Cloud Investigation (on-device, prototype)** — `GET /mcp/tools` and `POST /mcp/call` are thin, agent-loop-free passthroughs to the same MCP subprocess (`_mcp_ensure_started()`/`_mcp_call_tool()`) used by `/mcp/investigate`, but with no Claude-only gate — any model capable of OpenAI-style function calling can drive them. `extension/panel.js`'s `runCloudInvestigationOnDevice()` owns the entire multi-turn loop client-side: fetches tool schemas once, calls the currently-selected WebLLM model with `tools`/`tool_choice: 'auto'`, executes returned `tool_calls` against `/mcp/call`, appends `role: 'tool'` results back into its own message array, and repeats up to the same 6-iteration budget as the server-side version — forcing a final tools-less answer on the last iteration, mirroring `/mcp/investigate`'s own budget-exhaustion handling. This is the "🔎 Cloud Investigation (on-device)" tab, alongside the Claude-only "🔎 Cloud Investigation" tab, in the Risk Hunting drawer. WebLLM's `tools` support is implemented only for specific Hermes model variants — none of the Qwen2.5 models in `WEBLLM_MODELS` support it — so `runCloudInvestigationOnDevice()` checks the selected model against `TOOL_CALLING_MODELS` before doing anything and fails fast with a message pointing at Hermes-2-Pro-Llama-3-8B (the one Hermes variant registered in `WEBLLM_MODELS`) instead of letting WebLLM throw mid-request. Deliberately kept as a small, isolated prototype — the completion call itself (`engine.chat.completions.create`) is the only backend-specific line, so swapping in a different transport (an AI gateway, Ollama) later is a small change, not a rewrite. Expect smaller on-device models to be less reliable at this than Claude (malformed tool calls, premature stopping) — this is exploratory, not a replacement for the Claude-gated path.

**Response caching** — both `/lql/generate` and `/mcp/investigate` cache successful responses for `RESPONSE_CACHE_TTL_SECONDS` (1 hour), keyed on the lowercased/whitespace-collapsed prompt (`_lql_cache`, `_investigate_cache` near the top of `serve.py`). A cache hit replays the recorded event stream verbatim rather than re-running the LLM/agent loop.

Note: `/lql/generate` and `/mcp/investigate` are server-side calls from `serve.py` to `ANTHROPIC_BASE_URL` (`.env`) — this is a separate consumer of an AI gateway/Claude from the in-browser chat path above, and from Claude Code (the CLI tool used to develop this repo), which talks directly to the Anthropic API and goes through none of this project's code.

**`serve.py`** — single-file Python stdlib HTTP server. Handles all backend routes, reads `.env` at startup, auto-detects `~/.lacework.toml` to set `lw_ready`. No framework, no dependencies.

**`extension/panel.js`** — all extension logic: on-device chat via WebLLM, LQL tab, CVE lookup, CodeSec. When on a GitHub repo page, CodeSec/SBOM fetches real files via the GitHub API (recursive tree + raw content, up to 80 files, manifests prioritised); on other pages it scrapes `<pre>` blocks and guesses filenames heuristically so lacework SCA receives correct manifest names.

**`extension/vendor/web-llm/web-llm.js`** — vendored copy of `@mlc-ai/web-llm`'s `lib/index.js` (a single self-contained ESM bundle, no bundler step). `panel.js` (loaded as `type="module"`) statically imports `CreateMLCEngine` from it and lazily creates a module-level engine (default `Qwen2.5-3B-Instruct-q4f16_1-MLC`, switchable via the Admin menu's model dropdown to `Qwen2.5-7B-Instruct`/`Qwen2.5-Coder-7B`/`Hermes-2-Pro-Llama-3-8B`) on first send; the engine instance is cached and reused for subsequent sends. Model weights are cached by the browser's Cache API after first download — re-vendor manually (copy the new `lib/index.js`) to pick up upstream WebLLM updates or add a new model.

**`extension/background.js`** — service worker that opens the side panel on toolbar icon click.

**`extension/content.js`** — content script injected into every page; detects a `CVE-YYYY-NNNN`-shaped text selection on `mouseup` and messages `background.js` (`CVE_SELECTED`), which feeds the existing CVE-selection flow.

**`chatbox.html`** — standalone browser chat UI (served by `serve.py` at `/`), useful for testing outside the extension.

## Backend endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/config` | Returns `lw_ready`/`lw_cli` flags for the FortiCNAPP tool buttons (chat itself needs neither) |
| POST | `/proxy/v1/*` | Proxies to AI gateway upstream (used by `/lql/generate`/`/mcp/investigate` server-side only) |
| POST | `/codesec` | lacework SCA + SAST + IaC misconfig scan on submitted code |
| POST | `/sbom` | CycloneDX SBOM via lacework |
| POST | `/compliance` | Compliance PDF |
| GET | `/compliance/list` | List available compliance reports |
| GET | `/lql/queries` | List `.yaml` files from `LQL_QUERIES_DIR` |
| POST | `/lql/run` | Execute LQL against FortiCNAPP |
| POST | `/lql/cve` | CVE cross-reference: hosts + containers |
| POST | `/lql/generate` | Plain-English → LQL via Claude (cached 1hr, see below) |
| GET | `/fortiguard/outbreaks` | FortiGuard outbreak RSS (cached 30 min) |
| GET | `/fortiguard/outbreak-by-cve` | Outbreak alerts matching a CVE |
| GET | `/fortiguard/outbreak-detail` | Scrape a FortiGuard outbreak page for PoC/patch/timeline signals |
| GET | `/fortiguard/cve-intel` | Aggregate: EPSS + CISA KEV + NVD CVSS + FortiGuard for one CVE |
| POST | `/mcp/investigate` | Cloud Investigation: agent loop over read-only FortiCNAPP MCP tools (cached 1hr, see below) |
| GET | `/mcp/tools` | List the MCP subprocess's tool schemas (OpenAI-function-calling shaped) — for the on-device Cloud Investigation prototype, no agent loop or Claude gate |
| POST | `/mcp/call` | Invoke one named MCP tool, dumb passthrough to `_mcp_call_tool()` — same prototype, client owns the loop |
| POST | `/model` | Set `ANTHROPIC_DEFAULT_MODEL` for `/lql/generate`'s server-side calls (not wired to the extension's on-device chat model picker — those are independent) |

## Non-obvious runtime behaviour

**`lw_ready` flag** — `serve.py` checks at startup whether `~/.lacework.toml` contains all three fields (`account`, `api_key`, `api_secret`). The result is returned in `GET /config`. `panel.js` reads this flag on load and greys out the CodeSec, Compliance, LQL, and CVE toolbar buttons if credentials are absent.

**Selection-to-chat** — a right-click context menu ("Ask AI about selection", `contexts: ['selection']` in `background.js`) relays any selected text into the chat prompt box via `chrome.storage.session` + `chrome.runtime.sendMessage`, mirroring the existing CVE-selection flow. This works on regular pages and on PDFs opened in Chrome's built-in viewer (a content script can't attach inside the PDF renderer, but the browser-level context menu still fires there) — it replaced the old server-side `/compliance/latest-text` PDF-text-extraction endpoint, which depended on `pdftotext`/poppler-utils and required a Docker rebuild whenever that dependency was missing.

**`/lql/generate` CVE routing** — If the objective mentions CVE vulnerabilities, the LQL generation system prompt intercepts it and returns `{"queryId": "USE_CVE_TAB", ...}` instead of an LQL query; `panel.js` detects this and redirects the user to the CVE tab. CVE data is not available in LQL.

**`/lql/generate` gateway compatibility** — The endpoint calls the AI gateway directly (not via `/proxy/`). It handles both Anthropic-native (`content[].text`) and OpenAI-compatible (`choices[].message.content`) response shapes, so it works with Ollama and other OpenAI-compatible gateways.

**LQL and CVE time window** — Both `/lql/run` and `/lql/cve` default to the last 7 days when no `startTime`/`endTime` are provided.

**CodeSec suppression** — `.lacework/codesec.yaml` configures scan exceptions applied to all CodeSec results.

**LQL datasource grounding (`/lql/generate` only)** — `_load_lw_datasource_catalog()` calls `lacework query list-sources --json` once per process (cached), returning ~2340 real datasource names with full per-field `resultSchema` for the tenant's actual Lacework version. `_all_lql_datasources_text()` injects every name unconditionally into every `/lql/generate` call — deliberately not keyword-filtered, since two real bugs this session (see below) both came from the model working from an incomplete picture, and this endpoint already tolerates multi-second latency and up to 9 retries. `_retrieve_lql_reference()` separately keyword-matches the objective against that same cached catalog and injects the *full field schema* (same data `lacework query show-source <name>` would return — confirmed identical, so no separate CLI call is needed per datasource) for the top few relevant matches.

This replaced an earlier approach that parsed `FortiCNAPP-LQL_Reference_Guide.txt` (a PDF-to-text dump, still in the repo) into per-section chunks — that file truncates ~29% of long datasource names mid-word (column-width cutoff during extraction, e.g. `LW_CFG_AWS_IAM_ACCOUNT_PASSWORD_POLICY` → `..._PASSWORD_`) and only covers the `LW_HE_*`/`LW_HA_*`/`LW_CE_*`/`LW_APA_*` families in parseable per-section form — `LW_CFG_*` (the ~1400 AWS/Azure/GCP/OCI resource-config datasources, including all of IAM/S3/EC2) had no field-level doc there at all. The static-file functions (`_load_lql_reference_chunks()`, `_retrieve_lql_reference_fallback()`, `_all_lql_datasources_text_fallback()`) are kept only as a fallback when `lacework` CLI is unavailable (`shutil.which('lacework')` is falsy) — don't remove them.

Two real grounding bugs found and fixed this session, both worth knowing if `/lql/generate` starts misbehaving again:
1. **IAM has no regional locality.** Every `LW_CFG_AWS_IAM_*` row has `RESOURCE_REGION = 'aws-global'` (verified against real tenant data, 26/26 rows) — filtering by a country/region silently returns zero rows. Worse, once told not to filter on region, the model tried inventing a plausible-looking `ACCOUNT_ALIAS` pattern instead (e.g. `'Canada PAYG%'`) that didn't exist in the tenant. The system prompt now explicitly bans fabricating region-shaped filter values not present in real tenant data, not just banning the specific wrong field.
2. **The CVE-routing rule was too loosely worded.** "Admin **privilege**" objectives were being misclassified as CVE questions because "privilege escalation" is a common CVE/vulnerability category description — the rule's examples ("hosts with CVE-xxx", "vulnerable hosts") didn't rule out IAM/entitlement language explicitly, so the model over-generalized. Fixed by naming IAM/entitlement objectives as an explicit exception.

## Loading the Chrome extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click toolbar icon to open the side panel

The extension reads its initial config from `GET /config` on `localhost:45321`.

## Key constraints

- `serve.py` itself must remain zero-dependency (Python stdlib only) — no pip installs *imported by* `serve.py`. The Dockerfile does `pip install` the vendored `vendor/mcp_forticnapp` package (for Cloud Investigation), but `serve.py` only ever reaches it via `subprocess.Popen`, never `import`, so this constraint holds for the file itself.
- The Dockerfile installs the lacework CLI via its install script during build — lacework SCA and IaC components are pre-installed to avoid download delays at runtime. `checkov` is also `pip install`ed at build time: `lacework iac scan --disable-docker` (Dockerfile/Terraform/K8s misconfig scanning for `/codesec`) shells out to `checkov` natively rather than its default `docker run` mode, since the container has no docker-in-docker access — without `checkov` on PATH, IaC scanning fails outright.
- The extension's CSP (`manifest.json`) restricts `connect-src` to `localhost:45321` (serve.py), `https://api.github.com`/`https://raw.githubusercontent.com` (CodeSec/SBOM), and the Hugging Face CDN hosts WebLLM downloads model weights from — `huggingface.co`/`*.huggingface.co`, `cas-bridge.xethub.hf.co`, and `*.hf.co` (covers the newer regional xet-storage hosts like `us.aws.cdn.hf.co`) — any new fetch target must be added there. `script-src` also needs `'wasm-unsafe-eval'` for WebLLM's WASM runtime.
- There is no automated test suite or linter in this repo (`serve.py` and the extension are both plain, framework-free code). Verify changes by running the backend and exercising the affected flow through the extension or `chatbox.html`.
