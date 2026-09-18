# FortiCNAPP AI Agent — Release Notes

Running log of notable features and changes. Newest entries at the top.

---

## 2026-09-11

### Fixed: Attack Surface AI analysis appeared stuck / produced no visible report

Three compounding bugs, found while chasing "attack surface analysis is stuck for minutes / Generate AI Analysis shows nothing":

1. `serve.py` used a single-threaded `socketserver.TCPServer` — the entire backend could only handle one HTTP request at a time, so any slow call (a CVE lookup, an alert search) made every other endpoint feel hung too. Switched to `http.server.ThreadingHTTPServer`.
2. `_fetch_cve_intel()`'s three external calls (EPSS, CISA KEV, NVD) ran sequentially; parallelized with `ThreadPoolExecutor`.
3. The real culprit for "Generate AI Analysis shows nothing": `_sendServerSideAnalysis()` (the non-streaming path `/analysis/generate` uses for CVE/Attack Surface reports) built the rendered report into a detached DOM node and never appended it to the visible chat bubble — only the Copy/PDF buttons got attached. The backend was generating the report correctly the whole time; it just never reached the screen. Also hardened `buildAnalyseBtn`'s click handler, which previously had no error handling — any thrown error left the button stuck on "⏳ analysing…" forever with no feedback.

Also added a CRITICAL system-prompt block to `_run_mcp_agent_loop` (FortiCNAPP Search / Forensic) clarifying that Alerts span three categories (`Policy`="Risk Alerts", `Anomaly`, `Composite`="Threat Alerts") and a `Policy`-filtered or severity-only query does not already include Composite/Threat alerts.

---

## 2026-09-10 (6)

### Fixed: Cloud Investigation (on-device) failing on every default model

The on-device Cloud Investigation tab (added in 2026-09-10 (4)) always failed in practice: WebLLM's `tools`/function-calling path is only implemented for Hermes model variants, and none of the three Qwen2.5 models in the Admin dropdown are Hermes — every attempt threw `... is not supported for ChatCompletionRequest.tools`. Added **Hermes-2-Pro-Llama-3-8B** as a fourth on-device model option, and `runCloudInvestigationOnDevice()` now checks the selected model against a `TOOL_CALLING_MODELS` allowlist before loading anything, failing fast with a message pointing the user at Hermes-2-Pro-Llama-3-8B instead of surfacing WebLLM's raw error after a model load. Switch to it in Admin → LLM Model before using this tab.

Hermes-2-Pro surfaced a second, related restriction: WebLLM's tool-calling mode for this model injects its own system prompt internally and throws `CustomSystemPromptError` if the request also includes a custom `role: 'system'` message. Folded the investigator instructions into the initial `user` turn instead of a separate system message — no functional change to the instructions themselves.

---

## 2026-09-10 (5)

### Risk Hunting reports simplified back to just the raw table — no AI analysis

The "🤖 Generate AI Analysis" opt-in (added in 2026-09-10 (3)) turned out not to be very useful for Risk Hunting: LQL saved-query and Assisted Investigation results now render as just the raw table (`renderLqlTable`), with no AI-analysis button offered at all. CVE/Unified Attack Threat Surface reports are unaffected — that's the one place a written report still adds value (patch commands, risk-profile chart), so it keeps its "🤖 Generate AI Analysis" button and `_runBatchedAnalysis` batching unchanged.

---

## 2026-09-10 (4)

### Prototype: Cloud Investigation driven by the on-device model (no Claude requirement)

New "🔎 Cloud Investigation (on-device)" tab alongside the existing Claude-gated one, in the Risk Hunting drawer. The existing `/mcp/investigate` endpoint runs its whole tool-calling agent loop server-side and hard-requires `ANTHROPIC_DEFAULT_MODEL` to start with `claude` — smaller/local models weren't reliable enough at multi-turn tool-calling when this was tested. This new path moves the loop to the client instead: two new thin `serve.py` endpoints, `GET /mcp/tools` (lists the MCP subprocess's tool schemas, OpenAI-function-calling shaped) and `POST /mcp/call` (invokes one named tool, dumb passthrough to the existing `_mcp_call_tool()`), with no agent loop or Claude gate of their own. `panel.js`'s new `runCloudInvestigationOnDevice()` drives the loop itself — calls the currently-selected WebLLM model with `tools`/`tool_choice: 'auto'`, executes any returned `tool_calls` against `/mcp/call`, feeds results back as `role: 'tool'` messages, and repeats up to the same 6-iteration budget as the server-side version.

This is an early prototype for a longer-term direction: letting the user pick *any* backend (Bifrost/other AI gateway, Ollama, or on-device WebLLM) for every AI-driven feature rather than hardcoding transports per endpoint. Expect this on-device tool-calling loop to be noticeably less reliable than the Claude version — smaller models are more prone to malformed tool calls or premature stopping.

---

## 2026-09-10 (3)

### AI analysis is now opt-in, and batched 10-at-a-time, for every generated report

Previously, the moment a Risk Hunting (LQL saved query / Assisted Investigation) or Unified Attack Threat Surface (CVE) report finished fetching data, `panel.js` automatically pushed a synthetic prompt and ran a full on-device generation — the user had no way to just see the raw table without also paying for (and waiting on) a written report. Now the raw table/data always renders immediately in its result card, and a **"🤖 Generate AI Analysis"** button in the card footer is the only way to trigger the model call (`appendResultCard`'s new `opts.onAnalyse`).

When analysis does run, it processes at most **10 items per generation** (CVE hosts, or LQL rows) via a shared `_runBatchedAnalysis()` helper, then appends a **"▶ Continue analysis (N more)"** button to the AI's reply instead of silently continuing — applies uniformly to all three report types. For CVE reports, the pre-computed risk-profile radar chart is only injected into the first batch's prompt (it's a one-time chart, not per-host data). Removed the now-fully-superseded dormant `#cve-analyse` button (`panel.html`/`panel.js`) — it implemented a single-shot, non-batched version of the same idea but was never wired up to be visible.

---

## 2026-09-10 (2)

### Switched on-device model to Qwen2.5-3B-Instruct by default; Qwen2.5-7B-Instruct/Coder-7B as alternatives; deterministic, concise output

Qwen3-4B proved too "greedy" — verbose, wandering answers even with the report-template system prompt constraining structure. Replaced it with a three-model on-device lineup, selectable from the Admin menu's model dropdown (persisted to `localStorage`):

- **Qwen2.5-3B-Instruct** (default) — fastest generation; 7B was too slow for interactive chat on non-discrete GPUs
- **Qwen2.5-7B-Instruct** — better complex-report reasoning, opt-in when quality matters more than speed
- **Qwen2.5-Coder-7B** — alternative for code-heavy follow-up (CodeSec/SBOM findings)

Kept the 16384 `context_window_size` override from the previous entry (all three models default to 4096, same problem as Qwen3-4B). Set `temperature: 0.2` on every `chat.completions.create` call for deterministic, repeatable output instead of creative variation — reports should be the same shape run to run. Tightened `SYSTEM_PROMPT`'s opening line to explicitly demand minimum-words, no-repetition answers. Switching models mid-session calls WebLLM's `engine.reload()` rather than re-creating the engine from scratch. The `<think>` tag stripper from the previous entry is now a defensive no-op (none of the Qwen2.5 variants emit reasoning blocks) — kept in case a future model does.

---

## 2026-09-10

### Qwen3 `<think>` blocks stripped from chat; larger context window; Headroom sidecar fully decommissioned

Chat responses from Qwen3 were leaking raw `<think>...</think>` reasoning blocks into both the rendered bubble and stored history (feeding the model its own prior reasoning on subsequent turns). `readStream()` in `panel.js` now strips them from both, including a still-open trailing `<think>` mid-stream so partial reasoning never flashes on screen.

Also bumped WebLLM's `context_window_size` for Qwen3-4B from its 4096 default to 16384 — large Risk Hunting/CVE report prompts (row data + template) were routinely exceeding 8k input tokens alone and hitting a hard context error. Requires a side panel reload to take effect (engine is cached on first load).

Fully removed the Headroom token-compression sidecar (see 2026-07-03 entry below for what it was) — it was legacy from the old gateway-routed chat path and unused since chat moved on-device. Stripped the `docker-compose.yml` service, `serve.py` routes/state (`/headroom/stats`, `/headroom/toggle`, `HEADROOM_ENABLED`/`HEADROOM_URL`/`HEADROOM_DASHBOARD_URL`), the `panel.js`/`panel.html` UI remnants, and all `.env`/`.env.tpl` vars and docs.

Separately fixed `/lql/generate` returning a bare 404 when `ANTHROPIC_BASE_URL` points at an Ollama (or other OpenAI-compatible) gateway instead of Anthropic-native: `_call_claude()` was unconditionally hitting `/v1/messages` with `x-api-key` auth, producing a broken `.../v1/v1/messages` path against Ollama. Now branches on whether `ANTHROPIC_DEFAULT_MODEL` starts with `claude` to pick `/v1/messages`+`x-api-key` (Anthropic-native) vs. `/chat/completions`+`Bearer` (OpenAI-compatible).

---

## 2026-07-09

### Segmented progress stepper replaces the sailboat; real LQL validation errors surface to the model

Assisted Investigation and Cloud Investigation both showed a purely decorative sailboat animation while working, with no indication of real progress. Worse, `/lql/generate` was a single blocking call that could silently retry up to 20 times server-side before responding at all — the browser had zero visibility into how far along it was, and a `POST /lql/generate` that exhausted all 20 attempts just returned a bare HTTP 500. Converted `/lql/generate` to NDJSON streaming (mirroring `/mcp/investigate`'s existing pattern — `attempt`/`final`/`error` events, cache hits replay the full recorded event list), and replaced the sailboat in both drawers with a segmented stepper: 6 segments 1:1 with Cloud Investigation's tool-call budget, 8 fixed segments scaled against Assisted Investigation's 20-attempt budget, plus a live elapsed-time counter.

Along the way, found and fixed the actual root cause of most retry loops running to exhaustion: `_validate_lql()`/`_run_lql()` extracted the lacework CLI's error detail by returning the *first* line matching "error"/"Unable to"/"Error:" — but the CLI's real output always puts a generic `ERROR unable to validate query:` header first and the actual reason (e.g. `[400] Error: Unable to translate due to: Cannot find a default implicit join between these sources...`) last. The model was only ever shown the useless header, so it blindly guessed across datasources for up to 20 attempts instead of self-correcting. Now returns the last matching line instead of the first — confirmed a previously-failing query ("EC2 instances with attached instance profiles and highly permissive IAM roles") now succeeds on the first attempt.

Also fixed Cloud Investigation defaulting to a stale/out-of-range time window: its system prompt now hands the model an exact pre-computed `startTime`/`endTime` (last 30 days) for any time-filtered tool call instead of vague "start narrow" guidance, since FortiCNAPP's `Inventory/search` enforces an undocumented 90-day cap the model had no way to know about upfront.

---

## 2026-07-08

### Minimalist report format for Risk Hunting (LQL/Assisted Investigation) and Unified Attack Threat Surface (CVE)

Reports were forced through a heavy incident-report template (Status/severity line, separate Remediation/Critical Context/Compliance Deadlines/Preserve Evidence sections, footer) regardless of whether the objective was an actual security finding. For pure inventory objectives (e.g. "list all VM's in Azure") this produced a report structurally disconnected from the data, and — separately — the row data sent to the model was capped at 50 rows with no indication given back, so the report silently covered a fraction of what the raw results table above it already showed in full (verified live: 44 of 196 real Azure VMs, while claiming "196 total"). Replaced `INCIDENT_REPORT_TEMPLATE` with a single minimalist table — Finding | What It Means / Why It Matters | Next Steps to Remediate — shared by both features; CVE reports keep exact patch commands inline and the pre-computed risk-profile radar chart now sits directly above the table instead of inside a removed "Critical Context" section; regulatory obligations become table rows instead of a separate section. Raised the row sample sent to the model to 100 (from 50) with an honest "first N of total" note when truncated, and bumped `MAX_TOKENS` 4096 → 8192, since requiring one row per resource needs more output budget than the old summarized format did — without it the model's own table got cut off mid-row around 120 rows.

---

## 2026-07-03 (cont'd)

### 11. Rebrand: Web AI Agent → FortiAIScout, Status: Alpha

Renamed across every user-facing surface (extension manifest, panel/chatbox titles, chat sender labels, PDF export, setup/uninstall scripts, docs) and internal identifiers (HTTP `User-Agent` headers). Status badge changed from `BETA` to **Alpha**, framed explicitly as an early-stage release for testing and feedback rather than a finished product.

### 10. LQL reference-doc retrieval (RAG-lite) for `/lql/generate`

`FortiCNAPP-LQL_Reference_Guide.txt` (committed to the repo) is split into per-datasource chunks and keyword-matched against each objective, injecting the top-scoring excerpts into the LQL generation prompt as authoritative grounding — pure stdlib keyword-density scoring, no embeddings, no new dependency. Scoped to LQL generation only, not general chat. Two non-obvious bugs fixed along the way: naive header detection was matching indented in-example mentions of datasource names as if they were real section headers, and raw keyword-count scoring let the two largest (unbounded) chunks in the doc win almost every query by sheer volume regardless of relevance — fixed with length-normalized density scoring plus a minimum-relevance threshold so it silently opts out rather than injecting noise when a topic isn't covered by this doc.

### 9. Two real LQL data bugs fixed, verified against live tenant data

`TAGS:Region` doesn't exist on `LW_HE_MACHINES` — only `TAGS:Zone` (the availability zone) does, so region-filtered objectives were silently returning zero rows. Separately, `TAGS:ExternalIp` is an **empty string**, not null, on hosts with no public IP, so `IS NOT NULL` alone never filtered anything. Both fixed in the LQL generation system prompt with examples; confirmed against real tenant data (92 genuinely internet-exposed Canadian hosts had been invisible the whole time).

### 8. Shadow MCP-server detection consolidated

Found 8 overlapping custom LQL queries in the local query library for detecting unauthorized MCP tooling; consolidated the 5 truly-redundant process-based ones into a single query against `LW_HE_ALL_PROCESSES` (covers hosts *and* containers in one query via `IS_IN_CONTAINER`, verified against the real reference doc schema — not `LW_HE_PROCESSES`, which lacks that field). Findings written into the maintained `forticnapp` Claude skill so they carry forward across projects/sessions, not just this repo.

### 7. Assisted Investigation auto-runs the CVE tab

When an LQL objective needs the CVE tab (`USE_CVE_TAB`), the client now checks the typed objective for a CVE ID pattern — if found, it auto-switches tabs, populates the CVE field, and runs the FortiCNAPP + FortiGuard lookups immediately instead of just telling the user to do it manually. Falls back to the old manual-redirect message when no CVE ID is present (e.g. the vulnerability was only named, not ID'd).

### 6. TokenIQ UI consolidation, readability, and cleanup

The action bar and config bar had grown crowded (5+ pill buttons, 2 separate TokenIQ badges). Merged the routing badge and lifetime-savings badge into one (`🔀 TokenIQ · 43%`), moved the Dashboard link into the FortiCNAPP dropdown, removed the FortiGuard Alerts button, and grouped the TokenIQ badge with the status dot on the same edge. Bumped report/chat font sizes and line-height for readability, and fixed the CVE risk-profile radar chart clipping its own axis labels (wider viewBox + two-line label wrapping — the actual fix; a wider box alone wasn't enough). Also fixed a real bug introduced while merging the two TokenIQ badges: the savings detail was being appended to the tooltip and then immediately discarded by the next re-render.

---

## 2026-07-03

### 1. Headroom token-compression sidecar

Optional integration with [Headroom](https://github.com/chopratejas/headroom) to cut input-token usage on large report-generation prompts (LQL/CVE data dumped into a single chat message).

- Runs as a `headroom` service in `docker-compose.yml` — inert until enabled, doesn't affect anyone who hasn't opted in
- **Routing badge** in the extension's top bar (`🔀 direct to AI GW` / `🔀 via Headroom`) — click to switch, with a confirm prompt; the change is applied live and persisted to `.env` (`HEADROOM_ENABLED`), no restart needed
- **📊 Dashboard button** opens Headroom's live savings dashboard in a new tab
- **Lifetime tokens-saved badge** next to the model picker, polling `/headroom/stats` every 60s
- State survives container recreation via a named Docker volume
- Started with `--no-ccr-inject-tool` and `--compress-user-messages` — two non-default flags required for this app's traffic shape (single-turn user messages, not a multi-turn agent tool loop) and to avoid a Headroom bug where its reversible-compression feature 502s on responses containing `server_tool_use` blocks (what this app's web-search tool produces)
- Routes through `serve.py`'s own `/proxy` passthrough rather than the extension talking to Headroom directly — Headroom's CORS allowlist rejects `chrome-extension://` origins outright, and Docker-internal hostnames aren't reachable from the browser anyway

### 2. Live model sync to `.env`

Changing the model dropdown in the extension now also persists `ANTHROPIC_DEFAULT_MODEL` to `.env` server-side (`POST /model`), so `/lql/generate`'s server-side Claude call always matches whatever model you're chatting with — previously these could silently drift apart.

### 3. CVE risk-profile radar chart

The CVE ("Attack Surface") incident report's **Critical Context** section now includes a 5-axis radar chart — Attack Vector, Privileges Required, Scope Impact, EPSS Percentile, Internet Exposure — rendered as inline SVG. Values are computed server-side from the actual CVSS vector, EPSS percentile, and exposure ratio, not left to the model to hand-draw, so the chart is always geometrically correct.

### 4. Minimalist chat UI

Replaced the colored chat-bubble/avatar layout with a flat, labeled-log style (thin left-accent bar per role, no avatars, no filled backgrounds) — more engineering-tool, less consumer-chat-app. Report rendering (tables, badges, PDF export styling) was deliberately left untouched so generated reports keep their established visual language.

### 5. Incident report template

LQL ("Advanced Analytics") and CVE ("Attack Surface") reports now follow one consistent structure instead of an ad-hoc format per flow:

`Status → Affected Resources (table) → Remediation (exact commands + Verify block) → Critical Context → Compliance Deadlines (region-aware) → Preserve Evidence`

Sections without supporting data are omitted rather than padded out with invented content.
