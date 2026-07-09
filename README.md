# FortiAIScout — Chrome Extension

> **License**: Apache 2.0 — see [LICENSE](LICENSE) | **Status**: Alpha — early-stage release for testing and feedback; expect rough edges and rapid change.

A Chrome side panel that brings AI-powered cloud security to your browser. Ask questions about any webpage, scan code for vulnerabilities, run cloud security queries, and analyze threats — all without leaving your browser tab.

Works with **FortiCNAPP** (and any CNAPP platform built on Lacework).

---

## Architecture

<img width="1774" height="887" alt="image" src="https://github.com/user-attachments/assets/7ebe863e-8896-4f9e-a636-57bb96fa28c8" />


## Features

| Feature | Description |
|---|---|
| 💬 **AI Chat** | Security-engineer-focused AI assistant with automatic web search |
| 📝 **TL;DR** | Instant plain-English summary of any page |
| 🖱 **Selection-to-chat** | Right-click any selected text (including inside Chrome's built-in PDF viewer) → "Ask AI about selection" to bring it straight into the chat box |
| 🛡 **OnDemand CodeSec** | Scans code on the current page or a GitHub repo for vulnerabilities, misconfigurations, and exposed secrets |
| 🧾 **SBOM Generator** | Generates a Software Bill of Materials for code on the current page or a GitHub repo — SPDX (json/tag/yaml), SARIF, or GitLab JSON |
| 📋 **CSPM Compliance Reports** | Generates compliance PDF reports (CIS, NIST, PCI-DSS, SOC 2, HIPAA, ISO 27001, and 50+ frameworks) |
| 📊 **Risk Hunting and threat Hunting** | Run saved LQL queries, or describe what you want to find in plain English — the AI writes the query, validates it, and retries up to 9 times if it fails. Falls back to a scoping conversation if the objective needs clarification. |
| 🔎 **Cloud Investigation** | Open-ended natural-language question → an AI agent loop calls read-only FortiCNAPP tools across up to 6 iterations to answer it, streaming progress as it goes |
| 🔬 **Unified Attack Threat Surface** | CVE lookup with a computed CVSS/EPSS/exposure risk-profile radar chart, FortiGuard outbreak scrape, and a minimalist AI-generated report table |
| 🧾 **Minimalist Reports** | LQL and CVE reports are a single Markdown table — Finding, What It Means / Why It Matters, Next Steps to Remediate (exact CLI fix commands where remediation applies) — one row per matching resource, no boilerplate sections |
| ⚖️ **Regulatory Obligations** | Reports auto-detect cloud regions and inject applicable frameworks: PIPEDA (Canada), GDPR/NIS2 (EU), NIST/HIPAA/CIRCIA (US), UK GDPR, APAC privacy laws, and ISO 27001 baseline |
| 📋 **Copy / PDF Export** | One-click copy and PDF export on every AI response |
| 💾 **TokenSaving compression** *(optional)* | Route chat through a local token-compression proxy ([Headroom](https://github.com/chopratejas/headroom) under the hood) to cut token usage on large report-generation prompts — toggle live from a badge in the panel, no restart needed |

> 📈 **FAZ** (FortiAnalyzer) and ☁️ **FortiCASB-SSPM** buttons are visible in the toolbar but are "coming soon" placeholders — not yet functional.

---

## What does it do?

Think of it as a security engineer sitting next to you while you browse. You open a side panel in Chrome, and from there you can:

**General AI assistant (works on any webpage)**

- **Chat** — ask the AI anything; it searches the web automatically when it needs fresh information
- **Translate** — select text on the page, then click Translate to get it in English
- **TL;DR** — plain-English summary of any page in seconds
- **Select text → right-click → "Ask AI about selection"** — works on regular pages and inside Chrome's PDF viewer

**Cloud security tools (under the FortiCNAPP menu — requires FortiCNAPP)**

| Button | What it does |
|---|---|
| 🛡 **CodeScan** | Scans code on the current page or a GitHub repo for security vulnerabilities and exposed secrets |
| 🧾 **SBOM Gen** | Generates a Software Bill of Materials (SPDX/SARIF/GitLab formats) for code on the current page or a GitHub repo |
| 📋 **Compliance Report** | Generates a compliance PDF report, opened in a new tab |
| 📊 **Risk Hunting** | Three tabs in one drawer — run saved **LQL** queries, describe an objective in plain English for **✨ Assisted Investigation** (AI writes/validates/retries the LQL query), or ask an open-ended question for **🔎 Cloud Investigation** (an AI agent loop over read-only FortiCNAPP tools) |
| 🔬 **Unified Attack Threat Surface** | CVE lookup with a computed risk-profile radar, PoC/patch signals from FortiGuard, CISA KEV, and a minimalist report table with regulatory obligations |

**Admin menu** *(gear/routing dot icon)* — AI gateway and model pickers, the **📊 TokenSaving Dashboard** (if configured), and the **💬 Community Feed** link.

> If a button is greyed out, hover over it — a tooltip explains what's needed to enable it.

---

## End-to-End Workflow

Same shape for every flow — Chat/TL;DR, CodeScan, SBOM, Compliance, Risk Hunting, Unified Attack Threat Surface. Using Unified Attack Threat Surface as the concrete example:

```
1. SETUP (once)
   ./setup.sh → paste gateway URL/key → chrome://extensions → Load unpacked
     ↓
2. OPEN THE PANEL
   Click the toolbar icon — side panel opens alongside whatever tab you're on
     ↓
3. ASK
   FortiCNAPP ▼ → Unified Attack Threat Surface → type "CVE-2021-44228" → 🔎 Search
   (Risk Hunting: FortiCNAPP ▼ → Risk Hunting → ✨ Assisted Investigation tab →
    "S3 buckets without encryption" → ▶ Run Query)
     ↓
4. THE AI DOES THE WORK
   FortiCNAPP + FortiGuard + NVD + EPSS + CISA KEV queried in parallel
   (Assisted Investigation: LQL generated → validated → retried up to 9x → run → REST-enriched)
     ↓
5. REPORT COMES BACK
   One table — Finding | What It Means / Why It Matters | Next Steps to Remediate
   (exact commands where remediation applies; risk-profile radar chart above it for CVE reports)
     ↓
6. ACT ON IT
   Copy the fix commands · ⬇ Export PDF · ask a follow-up right in the same chat
```

Every step after (1) happens without leaving the tab you're on. Setup is a one-time cost — after that it's ask → report → act.

---

## Reports — Structure

Every LQL ("Risk Hunting") and CVE ("Attack Surface") report follows the same structure: one Markdown table, nothing else — minimal and engineering-focused rather than a board-deck format.

| Finding | What It Means / Why It Matters | Next Steps to Remediate |
|---|---|---|

- **Finding** — the resource/finding itself, real name/ID from the data, one row each. Every matching resource gets a row — no sampling, no truncation, no splitting across multiple tables.
- **What It Means / Why It Matters** — one plain-language sentence: what it is, and the severity/exposure context if applicable. A short factual description for pure inventory questions with no actual risk.
- **Next Steps to Remediate** — one concrete action; an exact command where remediation applies (real names/IDs, never placeholders), or "None — informational only" for pure inventory.
- A regulatory notification obligation (PIPEDA, GDPR, etc.) that applies to the affected region(s) gets its own row rather than a separate section.
- CVE reports get a pre-computed risk-profile radar chart (Attack Vector, Privileges Required, Scope Impact, EPSS Percentile, Internet Exposure) directly above the table.

---

## Attack Surface — How it works

When you search for a CVE, six sources are queried in parallel:

1. **FortiCNAPP** — affected hosts/containers, severity, internet exposure, fix availability
2. **FortiGuard RSS** — active outbreak alerts matching this CVE
3. **FortiGuard outbreak page** — PoC availability, patch status, in-the-wild exploitation signals, timeline
4. **NVD** — CVSS v3 score and description
5. **EPSS (first.org)** — exploit probability score and percentile
6. **CISA KEV** — whether actively exploited in the wild

All six feed into the report table and its 5-axis risk-profile radar chart (Attack Vector, Privileges Required, Scope Impact, EPSS Percentile, Internet Exposure), computed directly from the CVSS vector and exposure data — not left to the model to draw.

**Regulatory obligations** are injected based on the cloud region of each affected host:

| Region prefix | Frameworks applied |
|---|---|
| `ca-*` | PIPEDA + Quebec Law 25 — 72h OPC/CAI notification, threat hunt required |
| `us-*` | NIST CSF + HIPAA + PCI-DSS + CIRCIA 72h |
| `eu-*` | GDPR Art.33 72h + NIS2 24h early warning |
| `eu-west-2` | UK GDPR / ICO 72h |
| `ap-*` | Australia NDB, Japan APPI, Singapore PDPA |
| All | ISO 27001:2022 baseline |

---

## Risk Hunting — LQL, Assisted Investigation & Cloud Investigation

The **Risk Hunting** drawer has three tabs:

- **LQL** — pick from your saved `.yaml` queries and run them directly
- **✨ Assisted Investigation** — describe an objective in plain English; the AI writes and self-heals an LQL query (see below)
- **🔎 Cloud Investigation** — ask an open-ended question; an AI agent loop calls read-only FortiCNAPP tools (up to 6 iterations) to answer it, streaming its tool calls and results live as it works. Unlike Assisted Investigation, this isn't limited to what LQL can express — it can chain multiple tool calls together to answer questions LQL alone can't.

### Assisted Investigation — How it works

```
User types objective
  ↓
serve.py loads the full live datasource catalog — `lacework query list-sources --json`,
cached after the first call: ~2340 real datasource names, always current
  ↓
Objective keyword-matched against that catalog → top few relevant datasources
  e.g. "security groups" → LW_CFG_AWS_EC2_SECURITY_GROUPS
  ↓
Each match's full field schema is pulled from that same cached payload — the identical
data `lacework query show-source LW_CFG_AWS_EC2_SECURITY_GROUPS` would return — and
injected alongside the complete datasource-name list
  ↓
Claude generates LQL query, grounded in real field names — not guessed, not from a
static doc that can drift out of date with your tenant's actual Lacework version
  ↓
serve.py validates syntax (lacework CLI --validate_only)
  ↓ fails → error + hint → Claude fixes → retry (up to 9 attempts)
  ↓ passes
serve.py runs query for real
  ↓ fails → error + hint → Claude fixes → retry
  ↓ passes
Rows returned → enriched with REST API (alerts, inventory, S3 sensitivity tags)
  ↓
Claude writes the report (one row per resource, see Reports — Structure above)
```

The datasource catalog comes from the live `lacework` CLI, not a static reference file — the earlier approach parsed a PDF-derived text dump that truncated ~29% of long datasource names mid-word (column-width cutoff during extraction). The static file is kept only as a fallback if the CLI is ever unavailable.

If the objective doesn't map to a known LQL-modeled resource type, `searchTerm` falls back to a FortiCNAPP Inventory REST search instead of forcing a bad LQL query. If the objective is actually a CVE question, it redirects straight to the Attack Surface flow instead — CVE data isn't in LQL.

If all 9 attempts fail, a scoping conversation starts — Claude asks 2–4 clarifying questions and proposes a refined objective with a **⟳ Run query** button.

Console output shows each attempt:
```
  [LQL] attempt 2/9 — query: { source { LW_CFG_AWS_S3 }…
  [LQL]   ✗ validation error: Cannot find defined relationships
  [LQL]   → asking Claude to fix (attempt 3)
  [LQL]   ✓ run OK — 14 rows
```

---

## TokenSaving — Token Compression (optional)

Report-generation prompts (LQL results, CVE intel, compliance data) can get large — TokenSaving is an optional local proxy that compresses that context before it reaches the AI gateway, cutting token usage without changing what comes back. It's built on the open-source [Headroom](https://github.com/chopratejas/headroom) project.

**It's off by default and entirely optional** — chat works identically either way, just at full token cost when off.

**Turn it on:**
1. Start the sidecar: `docker compose up -d` (already included if you're running the default Docker setup — it's inert until enabled, so leaving it running costs nothing)
2. In the panel, click **⚙ Admin**
3. Click the routing badge (shows `🔀 direct` when off) → confirm the switch
4. It flips to `🔀 TokenSaving · <savings>%` — a live lifetime-savings percentage, and stays on across restarts (`HEADROOM_ENABLED` is written to `.env`)

Click **📊 TokenSaving Dashboard** (also in the Admin menu) to see the live savings dashboard in a new tab.

If you're running `python3 serve.py` directly instead of Docker, you'll need Headroom running separately — see [Technical reference](#technical-reference) below for the exact env vars.

---

## What you need before starting

| Requirement | Notes |
|---|---|
| **Google Chrome** | Any recent version |
| **Python 3** | Pre-installed on Mac. Windows: [python.org](https://python.org) — tick "Add to PATH" |
| **AI Gateway URL + key** | Provided by your IT team or Fortinet contact. Key usually starts with `sk-bf-…` |
| **FortiCNAPP account** | Only needed for security tools (CodeScan, SBOM, Compliance, Risk Hunting, Unified Attack Threat Surface) |

You do **not** need to be a developer. You do **not** need Docker.

---

## Setup — 4 steps

### Step 1 — Download

**Option A — Git:**
```bash
git clone https://github.com/svuillaume/webaiagent.git
cd webaiagent
```

**Option B — ZIP:**
1. Go to [github.com/svuillaume/webaiagent](https://github.com/svuillaume/webaiagent)
2. Click **Code** → **Download ZIP**, unzip, open Terminal/PowerShell inside the folder

---

### Step 2 — Run the setup script

**Mac / Linux:**
```bash
./setup.sh
```

**Windows:**
```powershell
.\setup.ps1
```

| Question | What to enter |
|---|---|
| AI Gateway URL | e.g. `https://bifrost.yourcompany.com/anthropic` |
| Gateway API key | Key starting with `sk-bf-…` |
| FortiCNAPP credentials | Answer **y** — you'll need account name, API Key ID, and API Secret |

When the script shows green `[OK]`, the server is running.

---

### Step 3 — Load the extension into Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Pin the FortiAIScout icon from the toolbar 🧩

---

### Step 4 — Open and use it

Click the FortiAIScout icon. The status dot should be **green**.

- Type anything in the chat box to start
- Click **🔰 FortiCNAPP** for security tools
- Click **🔬** for CVE / attack surface analysis

See [End-to-End Workflow](#end-to-end-workflow) above for a full ask-to-report walkthrough.

---

## Stopping and restarting

**Stop:**
```bash
kill $(cat .serve.pid)                              # Mac/Linux
Stop-Process -Id (Get-Content .serve.pid)           # Windows
```

**Start again:** run `./setup.sh` — skips config questions if `.env` already exists.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Status dot grey | Server not running — run `./setup.sh` again |
| Security buttons greyed out | FortiCNAPP credentials missing — re-run setup and answer **y** |
| Compliance PDF has no "ask about it" button | Removed on purpose — select text in the opened PDF and right-click → "Ask AI about selection" instead |
| CVE returns 0 hosts | CVE may not affect your environment, or extend the time window beyond 7 days |
| LQL keeps failing | Check console for `[LQL] attempt N/9` — error message shows the datasource/syntax issue |
| Windows "execution policy" error | PowerShell as Admin: `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` |
| "via TokenSaving" routing fails | The TokenSaving (Headroom) sidecar isn't running/healthy — `docker compose up -d headroom`, or click the routing badge to switch back to "direct to AI GW" |

---

## Privacy and data

Everything stays on your machine.

| Data | Storage | Notes |
|---|---|---|
| Gateway URL + API key | `.env` file (local only) | Never sent anywhere except your own AI gateway |
| Chat history | Browser memory | Cleared when side panel closes |
| Page content | Browser memory | Never written to disk |
| FortiCNAPP credentials | `.env` (`LW_ACCOUNT`/`LW_API_KEY`/`LW_API_SECRET`), or `~/.lacework.toml` as a fallback | Never sent anywhere except FortiCNAPP's own API |
| FortiGuard threat data | Not stored | RSS feed proxied through local server, cached 30 min |

`serve.py` listens on `localhost` only — not reachable from the internet or other devices.

---

## Technical reference

<details>
<summary>For developers — manual config, API endpoints, Docker, architecture</summary>

### Manual start

```bash
cp .env.tpl .env
# edit .env with your values
python3 serve.py        # http://localhost:45321
```

### Environment variables (`.env`)

| Variable | Description |
|---|---|
| `ANTHROPIC_BASE_URL` | AI gateway endpoint URL — always the real gateway, never overwritten by the Headroom toggle |
| `BIFROST_VIRTUAL_KEY` | Gateway virtual key (`sk-bf-…`) |
| `ANTHROPIC_DEFAULT_MODEL` | Model for chat and LQL Generate. Kept in sync automatically when you change the model dropdown in the extension. |
| `LQL_QUERIES_DIR` | Path to folder with `.yaml` LQL query files (optional — panel opens cleanly if not set) |
| `HEADROOM_URL` | *(optional)* How `serve.py` reaches the [Headroom](https://github.com/chopratejas/headroom) sidecar server-side — `http://headroom:8787` in Docker, `http://127.0.0.1:8787` running `serve.py` directly |
| `HEADROOM_DASHBOARD_URL` | *(optional)* The browser-reachable address for the same proxy — always `http://127.0.0.1:8787` |
| `HEADROOM_ENABLED` | `1`/`0` — whether chat currently routes through Headroom. Toggled live from the extension's routing badge, not meant to be hand-edited. |

FortiCNAPP credentials: set `LW_ACCOUNT` / `LW_API_KEY` / `LW_API_SECRET` in `.env` (Docker builds and runs entirely off these — no host `~/.lacework.toml` required, so a fresh clone on any machine works without depending on a pre-existing local `lacework configure` setup). If those three aren't set, `serve.py` falls back to parsing `~/.lacework.toml`, which must use the `[default]` profile — run `lacework configure` with no `--profile` flag to create one under that name.

### Backend API endpoints (`localhost:45321`)

| Method | Path | Description |
|---|---|---|
| GET | `/config` | Gateway URL, key, `lw_ready` flag |
| POST | `/proxy/v1/*` | Proxy to AI gateway (streaming) |
| POST | `/codesec` | SCA + SAST scan via lacework CLI |
| POST | `/sbom` | CycloneDX SBOM via lacework CLI |
| POST | `/compliance` | Generate compliance PDF |
| GET | `/compliance/list` | List available compliance frameworks |
| GET | `/lql/queries` | List saved `.yaml` LQL files (empty list if dir not set) |
| POST | `/lql/run` | Execute LQL query |
| POST | `/lql/cve` | CVE attack surface: affected hosts + containers |
| POST | `/lql/generate` | Plain-English → validated LQL via Claude (up to 9 retries) |
| POST | `/mcp/investigate` | Cloud Investigation: AI agent loop over read-only FortiCNAPP tools (up to 6 iterations) |
| GET | `/fortiguard/outbreaks` | FortiGuard outbreak RSS (cached 30 min) |
| GET | `/fortiguard/outbreak-by-cve?cveId=` | Outbreak alerts matching a CVE |
| GET | `/fortiguard/outbreak-detail?slug=` | Scrape FortiGuard page for PoC/patch/timeline signals |
| GET | `/fortiguard/cve-intel?cveId=` | Aggregate: EPSS + CISA KEV + NVD CVSS + FortiGuard |
| GET | `/headroom/stats` | Lifetime token savings from the Headroom sidecar |
| POST | `/headroom/toggle` | Switch chat routing between direct-to-gateway and via-Headroom |
| POST | `/model` | Persist the extension's model picker as `ANTHROPIC_DEFAULT_MODEL` |

### Docker

```bash
docker compose up -d           # first run — also starts the optional Headroom sidecar
docker compose up -d webai     # start only webai, skipping Headroom
docker compose up --build -d   # after code changes
docker compose down
```

The `headroom` service is inert until `HEADROOM_ENABLED=1`, so leaving it running costs nothing. It's started with `--no-ccr-inject-tool` — without that flag, Headroom's reversible-compression feature buffers streaming responses in a way that can't handle the `server_tool_use` blocks this app's web-search tool produces, causing intermittent 502s.

### Architecture

```
Chrome Extension (extension/)
  │
  ├─ Chat ──────────► AI Gateway (Bifrost / Portkey / LiteLLM / Helicone)      [HEADROOM_ENABLED=0]
  │              or ► serve.py /proxy ► Headroom sidecar ► AI Gateway         [HEADROOM_ENABLED=1]
  │                        └──► Claude API  (web_search runs server-side)
  │
  └─ Security tools ► serve.py  localhost:45321
                           ├──► FortiCNAPP REST API
                           ├──► lacework CLI  (SCA/SAST, SBOM, LQL validate/run)
                           ├──► NVD API       (CVSS scores)
                           ├──► EPSS API      (exploit probability)
                           ├──► CISA KEV      (actively exploited CVEs)
                           └──► FortiGuard    (outbreak RSS + page scrape)
```

</details>
