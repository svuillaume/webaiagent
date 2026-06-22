# FortiCNAPP AI Assistant — Chrome Extension

A Chrome side-panel extension that brings **Claude AI** and **FortiCNAPP** security tools directly into your browser.

---

## What is this?

This extension is a **FortiCNAPP-connected AI assistant** embedded as a Chrome side panel. It combines three things:

1. **AI chat** via a [Bifrost AI Gateway](https://bifrost.fabriclab.ca) — your private Claude endpoint that keeps API keys out of browser extensions and enforces usage policies
2. **Live web search** via a local [SearXNG](https://github.com/searxng/searxng) instance — private, no tracking, runs on your machine
3. **FortiCNAPP security tools** built into the toolbar:
   - 🛡 **CodeSec** — SCA + SAST scan on code found on any page
   - 📋 **Compliance** — generate PDF reports for 54 frameworks (CIS, NIST, PCI DSS, SOC 2, HIPAA, ISO 27001…) and ask AI questions about them

All traffic stays local or goes to your own gateway — nothing is sent to third-party AI services.

---

## Requirements

- Google Chrome (or Chromium)
- A **Bifrost AI Gateway** — URL + virtual key (`sk-bf-…`)
- **Python 3.8+** — to run `serve.py` (local proxy for CORS, search, and FortiCNAPP endpoints)
- **Docker Desktop** — to run SearXNG (or use Python venv instead, see below)
- `lacework` CLI — for CodeSec and Compliance features (optional but recommended)

---

## Part 1 — AI Chat (Bifrost)

### What it does

The chat panel connects to Claude through your Bifrost AI gateway. It supports streaming responses, markdown rendering, page reading, and TL;DR summarization of any open tab.

### Step 1 — Configure your credentials

```bash
cp .env.tpl .env
```

Edit `.env` with your values:

```
ANTHROPIC_BASE_URL=https://your-bifrost-endpoint/anthropic
BIFROST_VIRTUAL_KEY=sk-bf-your-virtual-key-here
ANTHROPIC_DEFAULT_MODEL=claude-haiku-4-5-20251001
SEARXNG_URL=http://localhost:8080
```

> `.env` is **gitignored** and never committed. It is the **only file you need to edit** — the extension reads credentials from `serve.py` at startup automatically.

### Step 2 — Start serve.py

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt  # if present
python3 serve.py
```

serve.py starts on `http://localhost:8765` and exposes all local endpoints.

### Step 3 — Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder in this repo
4. The 🛡 **FortiCNAPP** icon appears in your Chrome toolbar

### Step 4 — Open the side panel

Click the 🛡 icon. The side panel opens on the right.

On first load, the URL and API key are **auto-filled from `.env`** via serve.py. The status bar shows **config loaded**.

### Chatting

- Type a message → press **Enter** (Shift+Enter for newline)
- Choose model: **haiku-4-5 ⚡** (fast, default) · sonnet-4-6 · opus-4-8 · DeepSeek
- **clear** resets the conversation

### Page tools

| Button | Capability | What it does |
|--------|-----------|-------------|
| **📄 Read Web Page** | Read Web Page and Analysis | Loads the current tab's full text into AI context. Ask follow-up questions, request summaries, extract data, or compare multiple pages. |
| **TL;DR** | Quick Summary | Reads the current page and immediately streams a 3–5 bullet summary. |
| **🛡 CodeSec** | FortiCNAPP Code Scan Review | Extracts all code from the current page and runs a FortiCNAPP SCA + SAST scan. Results show CVEs, severity levels, affected packages, fix versions, and SAST findings with file/line references. Ask the AI to explain or remediate any finding. |
| **📋 Compliance** | FortiCNAPP Compliance Report and Analysis | Generates a PDF compliance report from FortiCNAPP for any of 54 frameworks (CIS, NIST, PCI DSS, SOC 2, HIPAA, ISO 27001…). After download, click **🔍 Ask about this PDF** to load the full report into chat and ask the AI questions about findings, gaps, and remediation steps. |

---

## Part 2 — Web Search (SearXNG)

### What it does

The extension can perform live web searches during chat. SearXNG is a self-hosted, privacy-preserving search engine that runs on your machine — no query tracking, no personalization.

### Option A — Docker (recommended)

**Requires Docker Desktop.**

```bash
# Generate config with a random secret
mkdir -p searxng
sed "s/<INSERT_RANDOM_SECRET_HERE>/$(openssl rand -hex 32)/" \
    searxng.settings.yml.tpl > searxng/settings.yml

# Start SearXNG
docker compose up -d

# Verify it works
curl "http://localhost:8080/search?q=test&format=json" | python3 -m json.tool | head -10
```

SearXNG is now running on `http://localhost:8080`.  
Stop with: `docker compose down`

> `searxng/settings.yml` is **gitignored** — the generated secret never leaves your machine.

### Option B — Python venv (no Docker)

If you can't use Docker, point `SEARXNG_URL` in `.env` to any accessible SearXNG instance (public or remote), or skip search entirely — the extension works without it.

### How search works in chat

The extension automatically uses `SEARXNG_URL` from `.env` (loaded via serve.py). When the AI decides to search, it calls SearXNG and injects the results as context — no extra setup needed once SearXNG is running.

---

## Part 3 — FortiCNAPP Security Tools

### Prerequisites

Install and configure the Lacework CLI:

```bash
curl -sL https://raw.githubusercontent.com/lacework/go-sdk/main/cli/install.sh | bash
lacework configure    # enter your FortiCNAPP account, API key, and secret
```

Credentials are stored in `~/.lacework.toml`.

---

### 🛡 CodeSec — Code Security Scan

Click **CodeSec** in the toolbar. The extension extracts all code blocks from the current page and runs a FortiCNAPP SCA + SAST scan.

Results appear in a drawer with:
- Severity breakdown (Critical / High / Medium / Low)
- CVE IDs, affected packages, fix versions
- SAST findings with file/line locations

Findings can be suppressed via `.lacework/codesec.yaml`.

---

### 📋 Compliance — PDF Report Generator

Click **Compliance** in the toolbar. A picker opens with **54 compliance frameworks** grouped by cloud:

| Cloud | Count | Example frameworks |
|-------|-------|--------------------|
| AWS | 21 | CIS 1.4, NIST CSF, NIST 800-53, PCI DSS 4.0, SOC 2, HIPAA, ISO 27001 |
| Azure | 16 | CIS 1.5, NIST 800-53, PCI DSS, SOC 2, HIPAA, ISO 27001 |
| GCP | 13 | CIS 1.3, NIST CSF, PCI DSS, SOC 2, HIPAA, ISO 27001 |
| OCI | 3 | CIS OCI v1.2, Oracle Config Detector Rules, ISO 27001 |
| Kubernetes | 1 | CIS EKS v1.8.0 |

1. Select a framework
2. Click **⬇ Generate PDF** — the report downloads automatically
3. Click **🔍 Ask about this PDF** — the report text is loaded into chat so you can ask questions about it

The Compliance feature calls the FortiCNAPP API directly — no lacework CLI needed, only `~/.lacework.toml` credentials.

---

## Security model

| What | Storage | Lifetime |
|------|---------|----------|
| Bifrost URL | `chrome.storage.session` (RAM) | Cleared on Chrome close |
| API key | `chrome.storage.session` (RAM) | Cleared on Chrome close |
| Model choice | `chrome.storage.local` (disk) | Persists (not sensitive) |
| Chat history | JS memory | Cleared on panel close |
| Page content | JS memory | Never persisted |

The API key is **never written to disk**. serve.py `/config` is called once on panel open; the value moves to session RAM immediately. `config.json` is a blank fallback with no credentials.

---

## File reference

```
.env                      Your credentials — gitignored, single source of truth
.env.tpl                  Template: copy to .env and fill in

extension/
  manifest.json           Permissions, CSP, extension metadata (MV3)
  background.js           Service worker — opens side panel on icon click
  panel.html              Side panel UI and styles
  panel.js                All logic: chat, streaming, search, CodeSec, Compliance
  config.json             Blank fallback — credentials come from .env via serve.py
  config.json.tpl         Template for config.json

serve.py                  Local proxy: CORS, config, search, CodeSec, Compliance
docker-compose.yml        SearXNG local search container
searxng.settings.yml.tpl  SearXNG config template
searxng/                  Generated at runtime — gitignored

setup.sh                  Mac/Linux interactive setup script
setup.ps1                 Windows PowerShell setup script
.lacework/codesec.yaml    CodeSec scan exception config
```
