# Web AI Agent — Chrome Extension

A Chrome side-panel extension that brings AI chat and FortiCNAPP cloud security tools directly into your browser.

---

## What it does

- **AI chat** — streaming responses via any AI gateway (Bifrost, Portkey, LiteLLM, Helicone)
- **Live web search** — private, self-hosted [SearXNG](https://github.com/searxng/searxng) running locally
- **Page tools** — read any open tab, TL;DR summaries
- **FortiCNAPP security tools** _(require `~/.lacework.toml` credentials)_:
  - 🛡 **CodeSec** — SCA + SAST scan on code found on any page or GitHub repo
  - 📦 **SBOM** — CycloneDX bill of materials from page code
  - 📋 **Compliance** — generate PDF reports for 54 frameworks (CIS, NIST, PCI DSS, SOC 2, HIPAA, ISO 27001…)
  - 🚨 **CVE** — attack surface lookup: hosts + containers ranked by internet exposure
  - 🔍 **LQL** — run saved Lacework Query Language queries against your live tenant
  - ✨ **LQL Generate** — plain-English → LQL query, built and run instantly

---

## Requirements

- Google Chrome
- An AI Gateway URL + virtual key
- Docker Desktop _(recommended)_ or Python 3.8+
- `lacework` CLI + `~/.lacework.toml` _(optional — FortiCNAPP tools only)_

---

## Quick start

```bash
./setup.sh
```

The script handles everything interactively:

1. Creates `.env` from template if missing — prompts for `ANTHROPIC_BASE_URL` and `BIFROST_VIRTUAL_KEY` only if not already set
2. Detects if port 8080 is occupied — offers to kill the process
3. Checks Docker: if running → starts SearXNG + Bifrost containers; if not → falls back to Python venv
4. Waits for both services to be healthy
5. Prints **`✔ Web search tool ready!`** when done

On Windows: `setup.ps1`

---

## Configuration

`.env` values (auto-created by `setup.sh`, or copy `.env.tpl` manually):

| Variable | Description |
|---|---|
| `ANTHROPIC_BASE_URL` | AI gateway endpoint, e.g. `https://bifrost.yourhost.com/anthropic` |
| `BIFROST_VIRTUAL_KEY` | Gateway virtual key (`sk-bf-…`) |
| `ANTHROPIC_DEFAULT_MODEL` | Model for chat (default: `claude-haiku-4-5-20251001`) |
| `SEARXNG_URL` | Set to `http://searxng:8080` for Docker, `http://localhost:8080` for Python-direct |
| `LQL_QUERIES_DIR` | Path to `.yaml` LQL query files (mounted at `/lql_queries` in Docker) |

FortiCNAPP credentials: run `lacework configure` — stored in `~/.lacework.toml`, mounted read-only into the container.

---

## Manual Docker commands (these are managed in setup.sh) 

```bash
docker compose up -d                       # start all services
docker compose up --build -d bifrost       # rebuild after serve.py / chatbox.html changes
docker compose down                        # stop everything
```

---

## Load the Chrome extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click the toolbar icon to open the side panel

The extension auto-fills its config from `GET /config` on `localhost:8765` at startup.

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
| GET | `/search?q=…` | SearXNG proxy |
| POST | `/proxy/v1/*` | Proxy to AI gateway |
| POST | `/codesec` | SCA + SAST scan |
| POST | `/sbom` | CycloneDX SBOM |
| POST | `/compliance` | Compliance PDF |
| GET | `/compliance/list` | List frameworks |
| GET | `/lql/queries` | List saved LQL files |
| POST | `/lql/run` | Execute LQL |
| POST | `/lql/cve` | CVE host + container lookup |
| POST | `/lql/generate` | Plain-English → LQL |
