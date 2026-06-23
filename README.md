# Web AI Agent — Chrome Extension

A Chrome side-panel extension that brings AI chat and FortiCNAPP cloud security tools directly into your browser.

---

## What it does

- **AI chat** — streaming responses via any AI Gateway (Bifrost, Portkey, LiteLLM, Helicone)
- **External Web Search** — Anthropic's native `web_search_20260209` server-side tool
- **Web Page tools** — Read any open tab into context; TL;DR summaries
  
- **FortiCNAPP security tools** _(require `~/.lacework.toml` credentials)_:
  - **CodeSec** — SCA + SAST scan on code from any page or GitHub repo
  - **SBOM** — CycloneDX bill of materials from page code
  - **Compliance** — PDF reports for 54 frameworks (CIS, NIST, PCI DSS, SOC 2, HIPAA, ISO 27001…)
  - **CVE** — attack surface lookup: hosts + containers ranked by internet exposure
  - **LQL** — run saved Lacework Query Language queries against your live tenant
  - **LQL Generate (beta)** — plain-English → LQL, built and run instantly

---

## Requirements

- Google Chrome
- An AI Gateway **URL + API Key** any AI Gateway Bifrost, Portkey, LiteLLM, or Helicone
- Docker Desktop _(recommended)_ or Python 3.8+
- **Optional** `lacework` CLI + `~/.lacework.toml` 

---

## Quick start

```bash
./setup.sh
```

The script handles everything interactively:

1. Creates `.env` from template — prompts for `ANTHROPIC_BASE_URL` and gateway key
2. Starts Docker (or falls back to Python if Docker isn't running)
3. Waits for the service to be healthy

On Windows: `setup.ps1`

---

## Load the Chrome extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click the toolbar icon to open the side panel

---

## Security model

| Data | Storage | Lifetime |
|---|---|---|
| Gateway URL + API key | `chrome.storage.session` (RAM) | Cleared on Chrome close |
| Model / gateway choice | `chrome.storage.local` (disk) | Persists |
| Chat history | JS memory | Cleared on panel close |
| Page content | JS memory | Never persisted |

---

## Backend endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/config` | Gateway URL, key, `lw_ready` flag |
| POST | `/proxy/v1/*` | Proxy to AI gateway |
| POST | `/codesec` | SCA + SAST scan |
| POST | `/sbom` | CycloneDX SBOM |
| POST | `/compliance` | Compliance PDF |
| GET | `/compliance/list` | List frameworks |
| GET | `/lql/queries` | List saved LQL files |
| POST | `/lql/run` | Execute LQL |
| POST | `/lql/cve` | CVE host + container lookup |
| POST | `/lql/generate` | Plain-English → LQL |
