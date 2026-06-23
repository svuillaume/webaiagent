# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Web AI Agent is a browser-native AI security assistant: a Chrome extension (side panel) backed by a local Python HTTP server (`serve.py`). The extension sends chat through an AI gateway (Bifrost, Portkey, LiteLLM, or Helicone) to Claude. Web search uses Anthropic's native `web_search_20260209` server-side tool — no local search instance required. `serve.py` is a CORS proxy for FortiCNAPP security tools.


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
python3 serve.py              # http://localhost:8765
```

`serve.py` is pure Python stdlib — no pip install needed.

**First-time setup:**
```bash
./setup.sh        # interactive: creates .env, starts the service
```
On Windows: `setup.ps1`

## Configuration

Copy `.env.tpl` → `.env` and fill in:
- `ANTHROPIC_BASE_URL` — AI gateway endpoint (e.g. `https://your-gateway.example.com/anthropic`)
- `BIFROST_VIRTUAL_KEY` — gateway virtual key (`sk-bf-…`)
- `ANTHROPIC_DEFAULT_MODEL` — model for chat and `/lql/generate` (default: `claude-haiku-4-5`); both use this setting
- `LQL_QUERIES_DIR` — path to `.yaml` LQL query files; in Docker this is mounted at `/lql_queries` (docker-compose hardcodes `~/claude_cnapp/lql/lql_queries` as the host path — edit docker-compose.yml to change it)

FortiCNAPP credentials: `~/.lacework.toml` (from `lacework configure`). Mounted read-only into the container.

`serve.py` loads `.env` at startup; `.env` values **override** real environment variables. Restart required after any change.

**`extension/config.json`** — offline fallback config for the extension when `serve.py` is not running. Create from `config.json.tpl` and fill in `gateway_url` and `api_key`. The extension tries `GET /config` from serve.py first; if that fails, it falls back to this bundled file. It is not committed (untracked in git).

## Architecture

```
Chrome Extension (extension/)
  │
  ├─ Chat ──────────► AI Gateway (Bifrost / Portkey / LiteLLM / Helicone)
  │                        └──► Claude API  (web search runs server-side)
  │
  └─ Security tools ► serve.py  localhost:8765
                           ├──► FortiCNAPP REST API  (via lacework CLI)
                           └──► lacework CLI  (SCA/SAST, SBOM)
```

**`serve.py`** — single-file Python stdlib HTTP server. Handles all backend routes, reads `.env` at startup, auto-detects `~/.lacework.toml` to set `lw_ready`. No framework, no dependencies.

**`extension/panel.js`** — all extension logic: gateway auth header construction, streaming chat, LQL tab, CVE lookup, CodeSec. Gateway choice and model persist in `chrome.storage.local`; API key and gateway URL are session-RAM only (cleared on Chrome close, never written to disk). When on a GitHub repo page, CodeSec/SBOM fetches real files via the GitHub API (recursive tree + raw content, up to 80 files, manifests prioritised); on other pages it scrapes `<pre>` blocks and guesses filenames heuristically so lacework SCA receives correct manifest names.

**`extension/background.js`** — service worker that opens the side panel on toolbar icon click.

**`chatbox.html`** — standalone browser chat UI (served by `serve.py` at `/`), useful for testing outside the extension.

## Backend endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/config` | Returns gateway URL, key, `lw_ready` flag |
| POST | `/proxy/v1/*` | Proxies to AI gateway upstream |
| POST | `/codesec` | lacework SCA + SAST on submitted code |
| POST | `/sbom` | CycloneDX SBOM via lacework |
| POST | `/compliance` | Compliance PDF; cached at `/compliance/latest-text` |
| GET | `/compliance/list` | List available compliance reports |
| GET | `/lql/queries` | List `.yaml` files from `LQL_QUERIES_DIR` |
| POST | `/lql/run` | Execute LQL against FortiCNAPP |
| POST | `/lql/cve` | CVE cross-reference: hosts + containers |
| POST | `/lql/generate` | Plain-English → LQL via Claude |

## Non-obvious runtime behaviour

**`lw_ready` flag** — `serve.py` checks at startup whether `~/.lacework.toml` contains all three fields (`account`, `api_key`, `api_secret`). The result is returned in `GET /config`. `panel.js` reads this flag on load and greys out the CodeSec, Compliance, LQL, and CVE toolbar buttons if credentials are absent.

**Web search** — The extension declares Anthropic's `web_search_20260209` server-side tool on every chat request. Claude searches the web automatically during inference on Anthropic's infrastructure — no client-side tool loop is needed.

**Compliance PDF text extraction** — `/compliance/latest-text` uses `pdftotext` (poppler-utils) if it is on `PATH`; otherwise it returns base64 for client-side fallback. The PDF is held in process memory only (`_last_compliance_pdf` dict); it is lost on server restart.

**`/lql/generate` CVE routing** — If the objective mentions CVE vulnerabilities, the LQL generation system prompt intercepts it and returns `{"queryId": "USE_CVE_TAB", ...}` instead of an LQL query; `panel.js` detects this and redirects the user to the CVE tab. CVE data is not available in LQL.

**`/lql/generate` gateway compatibility** — The endpoint calls the AI gateway directly (not via `/proxy/`). It handles both Anthropic-native (`content[].text`) and OpenAI-compatible (`choices[].message.content`) response shapes, so it works with Ollama and other OpenAI-compatible gateways.

**LQL and CVE time window** — Both `/lql/run` and `/lql/cve` default to the last 7 days when no `startTime`/`endTime` are provided.

**CodeSec suppression** — `.lacework/codesec.yaml` configures scan exceptions applied to all CodeSec results.

## Loading the Chrome extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click toolbar icon to open the side panel

The extension reads its initial config from `GET /config` on `localhost:8765`.

## Key constraints

- `serve.py` must remain zero-dependency (Python stdlib only). No pip installs.
- The Dockerfile installs the lacework CLI via its install script during build — lacework SCA component is pre-installed to avoid download delays at runtime.
- The extension's CSP (`manifest.json`) restricts `connect-src` to `localhost:8765`, `https://api.github.com`, `https://raw.githubusercontent.com`, and `https://*` — any new fetch target must be added there.
