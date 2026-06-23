# Web AI Agent — Chrome Extension

A Chrome side-panel extension that brings AI chat and FortiCNAPP cloud security tools directly into your browser.

---

## What it does

- **AI chat** — streaming responses via any AI gateway (Bifrost, Portkey, LiteLLM, Helicone)
- **Web search** — Anthropic's native `web_search_20260209` server-side tool; no local search instance needed
- **Page tools** — read any open tab into context; TL;DR summaries
- **FortiCNAPP security tools** _(require `~/.lacework.toml` credentials)_:
  - 🛡 **CodeSec** — SCA + SAST scan on code from any page or GitHub repo
  - 📦 **SBOM** — CycloneDX bill of materials from page code
  - 📋 **Compliance** — PDF reports for 54 frameworks (CIS, NIST, PCI DSS, SOC 2, HIPAA, ISO 27001…)
  - 🚨 **CVE** — attack surface lookup: hosts + containers ranked by internet exposure
  - 🔍 **LQL** — run saved Lacework Query Language queries against your live tenant
  - ✨ **LQL Generate** — plain-English → LQL, built and run instantly

---

## Requirements

- Google Chrome
- An AI gateway URL + key (Bifrost, Portkey, LiteLLM, or Helicone)
- Docker Desktop _(recommended)_ or Python 3.8+
- `lacework` CLI + `~/.lacework.toml` _(optional — FortiCNAPP tools only)_

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

## Configuration

Copy `.env.tpl` → `.env` and fill in:

| Variable | Description |
|---|---|
| `ANTHROPIC_BASE_URL` | AI gateway endpoint, e.g. `https://your-gateway.example.com/anthropic` |
| `BIFROST_VIRTUAL_KEY` | Gateway virtual key (`sk-bf-…`) |
| `ANTHROPIC_DEFAULT_MODEL` | Model for chat and LQL generate (default: `claude-haiku-4-5`) |
| `LQL_QUERIES_DIR` | Path to `.yaml` LQL query files (mounted at `/lql_queries` in Docker) |

FortiCNAPP credentials: run `lacework configure` — stored in `~/.lacework.toml`, mounted read-only into the container.

---

## Docker commands

```bash
docker compose up -d                    # start all services
docker compose up --build -d webai      # rebuild after serve.py / chatbox.html changes
docker compose down                     # stop everything
```

---

## Load the Chrome extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click the toolbar icon to open the side panel

The extension auto-fills its config from `GET /config` on `localhost:8765` at startup. If `serve.py` isn't running, it falls back to `extension/config.json` (create from `config.json.tpl`).

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
