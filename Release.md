# FortiAIScout — Release Notes

Running log of notable features and changes. Newest entries at the top.

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
