# Web AI Agent — Chrome Extension

> **License**: Apache 2.0 — see [LICENSE](LICENSE) | **Status**: BETA

A Chrome side panel that brings AI-powered cloud security to your browser. Ask questions about any webpage, scan code for vulnerabilities, run cloud security queries, and analyze threats — all without leaving your browser tab.

Works with **FortiCNAPP** (and any CNAPP platform built on Lacework).

---

## Features

| Feature | Description |
|---|---|
| 💬 **AI Chat** | CISO-level AI assistant with automatic web search for up-to-date information |
| 📖 **Read Page** | Loads the current webpage into context so you can ask questions about it |
| ⚡ **TL;DR** | Instant plain-English summary of any page |
| 🚨 **FortiGuard Alerts** | Live outbreak alert feed from FortiGuard Labs — button flashes red when active threats are detected in the last 5 days |
| 🛡 **Code Scanner** | Scans code on the current page or a GitHub repo for vulnerabilities, misconfigurations, and exposed secrets |
| 📋 **Compliance Reports** | Generates compliance PDF reports (CIS, NIST, PCI-DSS, SOC 2, HIPAA, ISO 27001, and 50+ frameworks). Full text extracted server-side — no poppler/pdftotext required. |
| 📊 **AI Assist / LQL** | Describe what you want to find — the AI writes the LQL query, validates it, and retries up to 9 times if it fails. Falls back to a scoping conversation if the objective needs clarification. |
| 🔬 **Attack Surface Analyzer** | CVE lookup with a threat radar chart (CVSS, EPSS, KEV, FortiGuard, PoC, No Patch, Exposure), FortiGuard outbreak scrape, and a full AI-generated executive report. |
| 🧾 **CISO-Level Reports** | All reports follow a consistent 5-section executive structure with exact CLI fix commands and urgency labels. |
| ⚖️ **Regulatory Obligations** | Reports auto-detect cloud regions and inject applicable frameworks: PIPEDA (Canada), GDPR/NIS2 (EU), NIST/HIPAA/CIRCIA (US), UK GDPR, APAC privacy laws, and ISO 27001 baseline. |
| 📋 **Copy / PDF Export** | One-click copy and PDF export on every AI response. |

---

## What does it do?

Think of it as a CISO-level security analyst sitting next to you while you browse. You open a side panel in Chrome, and from there you can:

**General AI assistant (works on any webpage)**

- **Chat** — ask the AI anything; it searches the web automatically when it needs fresh information
- **Read this page** — loads the page you're on so you can ask questions about it
- **TL;DR** — plain-English summary of any page in seconds
- **FortiGuard** — live FortiGuard threat intelligence feed; button flashes red on active outbreak alerts

**Cloud security tools (requires FortiCNAPP)**

| Button | What it does |
|---|---|
| 🛡 **Scan Code** | Scans code on the current page or a GitHub repo for security vulnerabilities and exposed secrets |
| 📋 **Compliance** | Generates a compliance PDF report; text is extracted server-side and loaded into AI context automatically |
| 📊 **AI Assist** | Describe what you want to find — AI writes the LQL query, self-heals through up to 9 retries, and generates an executive report |
| 🔬 **Attack Surface** | CVE lookup with threat radar, PoC/patch signals from FortiGuard, CISA KEV, and a full executive report with regulatory obligations |
| 💬 **Community** | Opens the FortiCNAPP community feed |

> If a button is greyed out, hover over it — a tooltip explains what's needed to enable it.

---

## Executive Reports — Structure

Every security report (CVE, LQL, compliance) follows the same 5-section structure:

1. **Metric strip** — critical / high / medium counts + affected resource count at a glance
2. **Executive Review** — 2 sentences for a board member + **Decision required**
3. **Business Impact** — 2–3 bullets: data breach risk, compliance exposure, operational disruption
4. **Affected Resources** — one card per impacted asset with full resource name, account ID, region, and severity
5. **How to Fix + Next Steps** — numbered action items with exact CLI commands, urgency (NOW / 24h / 7d / 30d), owner, and region-aware regulatory obligations

---

## Attack Surface — How it works

When you search for a CVE, six sources are queried in parallel:

1. **FortiCNAPP** — affected hosts/containers, severity, internet exposure, fix availability
2. **FortiGuard RSS** — active outbreak alerts matching this CVE
3. **FortiGuard outbreak page** — PoC availability, patch status, in-the-wild exploitation signals, timeline
4. **NVD** — CVSS v3 score and description
5. **EPSS (first.org)** — exploit probability score and percentile
6. **CISA KEV** — whether actively exploited in the wild

All six feed into a **threat radar chart** (7 axes: CVSS, EPSS, KEV, FortiGuard, PoC, No Patch, Exposed%) and a structured executive report.

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

## AI Assist / LQL Generator — How it works

```
User types objective
  ↓
Claude generates LQL query
  ↓
serve.py validates syntax (lacework CLI --validate_only)
  ↓ fails → error + hint → Claude fixes → retry (up to 9 attempts)
  ↓ passes
serve.py runs query for real
  ↓ fails → error + hint → Claude fixes → retry
  ↓ passes
Rows returned → enriched with REST API (alerts, inventory, S3 sensitivity tags)
  ↓
Claude writes executive report
```

If all 9 attempts fail, a scoping conversation starts — Claude asks 2–4 clarifying questions and proposes a refined objective with a **⟳ Run query** button.

Console output shows each attempt:
```
  [LQL] attempt 2/9 — query: { source { LW_CFG_AWS_S3 }…
  [LQL]   ✗ validation error: Cannot find defined relationships
  [LQL]   → asking Claude to fix (attempt 3)
  [LQL]   ✓ run OK — 14 rows
```

---

## What you need before starting

| Requirement | Notes |
|---|---|
| **Google Chrome** | Any recent version |
| **Python 3** | Pre-installed on Mac. Windows: [python.org](https://python.org) — tick "Add to PATH" |
| **AI Gateway URL + key** | Provided by your IT team or Fortinet contact. Key usually starts with `sk-bf-…` |
| **FortiCNAPP account** | Only needed for security tools (Scan Code, Compliance, Analytics, Attack Surface) |

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
4. Pin the Web AI Agent icon from the toolbar 🧩

---

### Step 4 — Open and use it

Click the Web AI Agent icon. The status dot should be **green**.

- Type anything in the chat box to start
- Click **🔰 FortiCNAPP** for security tools
- Click **🔬** for CVE / attack surface analysis

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
| Compliance PDF shows no text | Restart `serve.py` — pure-Python extraction is built in, no poppler required |
| CVE returns 0 hosts | CVE may not affect your environment, or extend the time window beyond 7 days |
| FortiGuard button flashing red | Active outbreak alert — click to read it |
| LQL keeps failing | Check console for `[LQL] attempt N/9` — error message shows the datasource/syntax issue |
| Windows "execution policy" error | PowerShell as Admin: `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` |

---

## Privacy and data

Everything stays on your machine.

| Data | Storage | Notes |
|---|---|---|
| Gateway URL + API key | `.env` file (local only) | Never sent anywhere except your own AI gateway |
| Chat history | Browser memory | Cleared when side panel closes |
| Page content | Browser memory | Never written to disk |
| FortiCNAPP credentials | `~/.lacework.toml` | Standard lacework CLI credential file |
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
| `ANTHROPIC_BASE_URL` | AI gateway endpoint URL |
| `BIFROST_VIRTUAL_KEY` | Gateway virtual key (`sk-bf-…`) |
| `ANTHROPIC_DEFAULT_MODEL` | Model for chat and LQL Generate (default: `claude-haiku-4-5`) |
| `LQL_QUERIES_DIR` | Path to folder with `.yaml` LQL query files (optional — panel opens cleanly if not set) |

FortiCNAPP credentials come from `~/.lacework.toml` (created by `lacework configure`).

### Backend API endpoints (`localhost:45321`)

| Method | Path | Description |
|---|---|---|
| GET | `/config` | Gateway URL, key, `lw_ready` flag |
| POST | `/proxy/v1/*` | Proxy to AI gateway (streaming) |
| POST | `/codesec` | SCA + SAST scan via lacework CLI |
| POST | `/sbom` | CycloneDX SBOM via lacework CLI |
| POST | `/compliance` | Generate compliance PDF |
| GET | `/compliance/list` | List available compliance frameworks |
| GET | `/compliance/latest-text` | Extract text from last PDF (pure Python zlib, no pdftotext needed) |
| GET | `/lql/queries` | List saved `.yaml` LQL files (empty list if dir not set) |
| POST | `/lql/run` | Execute LQL query |
| POST | `/lql/cve` | CVE attack surface: affected hosts + containers |
| POST | `/lql/generate` | Plain-English → validated LQL via Claude (up to 9 retries) |
| GET | `/fortiguard/outbreaks` | FortiGuard outbreak RSS (cached 30 min) |
| GET | `/fortiguard/outbreak-by-cve?cveId=` | Outbreak alerts matching a CVE |
| GET | `/fortiguard/outbreak-detail?slug=` | Scrape FortiGuard page for PoC/patch/timeline signals |
| GET | `/fortiguard/cve-intel?cveId=` | Aggregate: EPSS + CISA KEV + NVD CVSS + FortiGuard |

### Docker

```bash
docker compose up -d           # first run
docker compose up --build -d   # after code changes
docker compose down
```

`poppler-utils` is included in the image for highest-quality PDF extraction. Pure-Python fallback used when running outside Docker.

### Architecture

```
Chrome Extension (extension/)
  │
  ├─ Chat ──────────► AI Gateway (Bifrost / Portkey / LiteLLM / Helicone)
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
