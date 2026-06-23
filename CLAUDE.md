# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Bifrost is a browser-native AI security assistant: a Chrome extension (side panel) backed by a local Python HTTP server (`serve.py`). The extension sends chat through an AI gateway (Bifrost, Portkey, LiteLLM, or Helicone) to Claude, and uses `serve.py` as a CORS proxy for FortiCNAPP security tools and SearXNG web search.

> **Note:** The `bifrost/` subdirectory is an older snapshot of the project. All active code lives at the repo root. Do not edit files under `bifrost/`.

## Running the backend

**Recommended — Docker (all services):**
```bash
docker compose up -d          # first run; builds the image
docker compose up --build -d bifrost   # after any change to serve.py or chatbox.html
docker compose down
```

**Alternative — Python directly (no lacework scanning):**
```bash
python3 serve.py              # http://localhost:8765
```

`serve.py` is pure Python stdlib — no pip install needed.

**First-time setup:**
```bash
./setup.sh        # interactive: creates .env, searxng/settings.yml, starts services
```
On Windows: `setup.ps1`

## Configuration

Copy `.env.tpl` → `.env` and fill in:
- `ANTHROPIC_BASE_URL` — AI gateway endpoint (e.g. `https://bifrost.yourhost.com/anthropic`)
- `BIFROST_VIRTUAL_KEY` — gateway virtual key (`sk-bf-…`)
- `ANTHROPIC_DEFAULT_MODEL` — model for chat (default: `claude-haiku-4-5-20251001`); note `/lql/generate` is hardcoded to `claude-haiku-4-5` and ignores this setting
- `LQL_QUERIES_DIR` — path to `.yaml` LQL query files; in Docker this is mounted at `/lql_queries` (docker-compose hardcodes `~/claude_cnapp/lql/lql_queries` as the host path — edit docker-compose.yml to change it)

FortiCNAPP credentials: `~/.lacework.toml` (from `lacework configure`). Mounted read-only into the container.

`serve.py` loads `.env` at startup, with real environment variables taking precedence and `.env` values overriding only when the key is absent. Restart required after any change.

## Architecture

```
Chrome Extension (extension/)
  │
  ├─ Chat ──────────► AI Gateway (Bifrost / Portkey / LiteLLM / Helicone)
  │                        └──► Claude API
  │
  └─ Security tools ► serve.py  localhost:8765
                           ├──► FortiCNAPP REST API  (via lacework CLI)
                           ├──► lacework CLI  (SCA/SAST, SBOM)
                           └──► SearXNG       localhost:8080
```

**`serve.py`** — single-file Python stdlib HTTP server. Handles all backend routes, reads `.env` at startup, auto-detects `~/.lacework.toml` to set `lw_ready`. No framework, no dependencies.

**`extension/panel.js`** — all extension logic: gateway auth header construction, streaming chat, LQL tab, CVE lookup, CodeSec. Gateway choice and model persist in `chrome.storage.local`; API key and gateway URL are session-RAM only (cleared on Chrome close, never written to disk). When on a GitHub repo page, CodeSec/SBOM fetches real files via the GitHub API (recursive tree + raw content, up to 80 files, manifests prioritised); on other pages it scrapes `<pre>` blocks and guesses filenames heuristically so lacework SCA receives correct manifest names.

**`extension/background.js`** — service worker that opens the side panel on toolbar icon click.

**`chatbox.html`** — standalone browser chat UI (served by `serve.py` at `/`), useful for testing outside the extension.

## Backend endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/config` | Returns gateway URL, key, `lw_ready` flag |
| GET | `/search?q=…` | SearXNG proxy (CORS bypass) |
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

**Web search fallback** — The extension tries `localhost:8080` (Docker SearXNG) directly first with a 4-second timeout, then falls back to `localhost:8765/search` (serve.py proxy). Search is only offered to the AI model when `SEARXNG_URL` is non-empty.

**Compliance PDF text extraction** — `/compliance/latest-text` uses `pdftotext` (poppler-utils) if it is on `PATH`; otherwise it returns base64 for client-side fallback. The PDF is held in process memory only (`_last_compliance_pdf` dict); it is lost on server restart.

**CodeSec suppression** — `.lacework/codesec.yaml` configures scan exceptions applied to all CodeSec results.

## Loading the Chrome extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click toolbar icon to open the side panel

The extension reads its initial config from `GET /config` on `localhost:8765`.

## Key constraints

- `serve.py` must remain zero-dependency (Python stdlib only). No pip installs.
- The Dockerfile installs the lacework CLI via its install script during build — lacework SCA component is pre-installed to avoid download delays at runtime.
- `searxng/settings.yml` is generated by `setup.sh` with a random secret; it is gitignored. Regenerate with `setup.sh` if missing.
- The extension's CSP (`manifest.json`) restricts `connect-src` to `localhost:8080`, `localhost:8765`, `https://api.github.com`, `https://raw.githubusercontent.com`, and `https://*` — any new fetch target must be added there.
