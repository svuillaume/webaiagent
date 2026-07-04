# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

FortiAIScout (Alpha — early-stage, expect rapid change) is a browser-native AI security assistant: a Chrome extension (side panel) backed by a local Python HTTP server (`serve.py`). The extension sends chat through an AI gateway (Bifrost, Portkey, LiteLLM, or Helicone) to Claude. Web search uses Anthropic's native `web_search_20260209` server-side tool — no local search instance required. `serve.py` is a CORS proxy for FortiCNAPP security tools.


## Running the backend

**Recommended — Docker (minimal endpoint setup, everything self-contained):**
```bash
docker compose up -d          # first run; builds the image (also starts the optional Headroom sidecar)
docker compose up --build -d webai     # after any change to serve.py or chatbox.html
docker compose up -d webai             # start only webai, skipping the Headroom sidecar
docker compose down
```
Only Docker needs to be installed — lacework CLI + SCA component are baked into the image. The bare `docker compose up -d` (no service name) also brings up the `headroom` sidecar since it's declared in the same file — it's inert (no API calls, negligible resources) until `HEADROOM_ENABLED=1`, so this is safe to leave running even if you never use it. `webai` has no `depends_on` on it, so naming `webai` explicitly skips it entirely.

**Alternative — Python directly (macOS dev only, lacework CLI must be installed locally):**
```bash
python3 serve.py              # http://localhost:45321
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
- `HEADROOM_URL` — optional; how `serve.py` reaches the Headroom token-compression sidecar server-side (`http://headroom:8787` in Docker — the Compose service DNS name; `http://127.0.0.1:8787` running `serve.py` directly)
- `HEADROOM_DASHBOARD_URL` — optional; the browser-reachable address for the same proxy, opened directly by the extension (`http://127.0.0.1:8787` in both setups — `HEADROOM_URL`'s Docker value only resolves inside containers, never in the browser)
- `HEADROOM_ENABLED` — `1`/`0`; whether chat requests currently route through Headroom. Not meant to be hand-edited — toggled from the extension's routing badge (`POST /headroom/toggle`), which writes it back here.

FortiCNAPP credentials: `~/.lacework.toml` (from `lacework configure`). Mounted read-only into the container.

`serve.py` loads `.env` at startup; `.env` values **override** real environment variables. Restart required after any change — except `HEADROOM_ENABLED` and `ANTHROPIC_DEFAULT_MODEL`, which take effect live via their respective `POST` endpoints without a restart (see Non-obvious runtime behaviour below).

`.env` is bind-mounted into the container (`./.env:/app/.env` in docker-compose.yml), not baked in at build time — this is what lets the two live-toggle endpoints above persist their writes back to the real host file.

**`extension/config.json`** — offline fallback config for the extension when `serve.py` is not running. Create from `config.json.tpl` and fill in `gateway_url` and `api_key`. The extension tries `GET /config` from serve.py first; if that fails, it falls back to this bundled file. It is not committed (untracked in git).

## Architecture

```
Chrome Extension (extension/)
  │
  ├─ Chat ──────────► AI Gateway (Bifrost / Portkey / LiteLLM / Helicone)      [HEADROOM_ENABLED=0]
  │              or ► serve.py /proxy ► Headroom sidecar ► AI Gateway         [HEADROOM_ENABLED=1]
  │                        └──► Claude API  (web search runs server-side)
  │
  └─ Security tools ► serve.py  localhost:45321
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
| POST | `/compliance` | Compliance PDF |
| GET | `/compliance/list` | List available compliance reports |
| GET | `/lql/queries` | List `.yaml` files from `LQL_QUERIES_DIR` |
| POST | `/lql/run` | Execute LQL against FortiCNAPP |
| POST | `/lql/cve` | CVE cross-reference: hosts + containers |
| POST | `/lql/generate` | Plain-English → LQL via Claude |
| GET | `/headroom/stats` | Lifetime token savings from the Headroom sidecar (`HEADROOM_URL`) |
| POST | `/headroom/toggle` | Switch chat routing between direct-to-gateway and via-Headroom |
| POST | `/model` | Persist the extension's model picker as `ANTHROPIC_DEFAULT_MODEL` |

## Non-obvious runtime behaviour

**`lw_ready` flag** — `serve.py` checks at startup whether `~/.lacework.toml` contains all three fields (`account`, `api_key`, `api_secret`). The result is returned in `GET /config`. `panel.js` reads this flag on load and greys out the CodeSec, Compliance, LQL, and CVE toolbar buttons if credentials are absent.

**Web search** — The extension declares Anthropic's `web_search_20260209` server-side tool on every chat request. Claude searches the web automatically during inference on Anthropic's infrastructure — no client-side tool loop is needed.

**Selection-to-chat** — a right-click context menu ("Ask AI about selection", `contexts: ['selection']` in `background.js`) relays any selected text into the chat prompt box via `chrome.storage.session` + `chrome.runtime.sendMessage`, mirroring the existing CVE-selection flow. This works on regular pages and on PDFs opened in Chrome's built-in viewer (a content script can't attach inside the PDF renderer, but the browser-level context menu still fires there) — it replaced the old server-side `/compliance/latest-text` PDF-text-extraction endpoint, which depended on `pdftotext`/poppler-utils and required a Docker rebuild whenever that dependency was missing.

**`/lql/generate` CVE routing** — If the objective mentions CVE vulnerabilities, the LQL generation system prompt intercepts it and returns `{"queryId": "USE_CVE_TAB", ...}` instead of an LQL query; `panel.js` detects this and redirects the user to the CVE tab. CVE data is not available in LQL.

**`/lql/generate` gateway compatibility** — The endpoint calls the AI gateway directly (not via `/proxy/`). It handles both Anthropic-native (`content[].text`) and OpenAI-compatible (`choices[].message.content`) response shapes, so it works with Ollama and other OpenAI-compatible gateways.

**LQL and CVE time window** — Both `/lql/run` and `/lql/cve` default to the last 7 days when no `startTime`/`endTime` are provided.

**CodeSec suppression** — `.lacework/codesec.yaml` configures scan exceptions applied to all CodeSec results.

**LQL datasource grounding (`/lql/generate` only)** — `_load_lw_datasource_catalog()` calls `lacework query list-sources --json` once per process (cached), returning ~2340 real datasource names with full per-field `resultSchema` for the tenant's actual Lacework version. `_all_lql_datasources_text()` injects every name unconditionally into every `/lql/generate` call — deliberately not keyword-filtered, since two real bugs this session (see below) both came from the model working from an incomplete picture, and this endpoint already tolerates multi-second latency and up to 9 retries. `_retrieve_lql_reference()` separately keyword-matches the objective against that same cached catalog and injects the *full field schema* (same data `lacework query show-source <name>` would return — confirmed identical, so no separate CLI call is needed per datasource) for the top few relevant matches.

This replaced an earlier approach that parsed `FortiCNAPP-LQL_Reference_Guide.txt` (a PDF-to-text dump, still in the repo) into per-section chunks — that file truncates ~29% of long datasource names mid-word (column-width cutoff during extraction, e.g. `LW_CFG_AWS_IAM_ACCOUNT_PASSWORD_POLICY` → `..._PASSWORD_`) and only covers the `LW_HE_*`/`LW_HA_*`/`LW_CE_*`/`LW_APA_*` families in parseable per-section form — `LW_CFG_*` (the ~1400 AWS/Azure/GCP/OCI resource-config datasources, including all of IAM/S3/EC2) had no field-level doc there at all. The static-file functions (`_load_lql_reference_chunks()`, `_retrieve_lql_reference_fallback()`, `_all_lql_datasources_text_fallback()`) are kept only as a fallback when `lacework` CLI is unavailable (`shutil.which('lacework')` is falsy) — don't remove them.

Two real grounding bugs found and fixed this session, both worth knowing if `/lql/generate` starts misbehaving again:
1. **IAM has no regional locality.** Every `LW_CFG_AWS_IAM_*` row has `RESOURCE_REGION = 'aws-global'` (verified against real tenant data, 26/26 rows) — filtering by a country/region silently returns zero rows. Worse, once told not to filter on region, the model tried inventing a plausible-looking `ACCOUNT_ALIAS` pattern instead (e.g. `'Canada PAYG%'`) that didn't exist in the tenant. The system prompt now explicitly bans fabricating region-shaped filter values not present in real tenant data, not just banning the specific wrong field.
2. **The CVE-routing rule was too loosely worded.** "Admin **privilege**" objectives were being misclassified as CVE questions because "privilege escalation" is a common CVE/vulnerability category description — the rule's examples ("hosts with CVE-xxx", "vulnerable hosts") didn't rule out IAM/entitlement language explicitly, so the model over-generalized. Fixed by naming IAM/entitlement objectives as an explicit exception.

**Headroom routing (`HEADROOM_ENABLED`)** — The extension fetches its chat gateway URL directly from the browser (`panel.js`'s `${baseUrl}/v1/messages`, not through `serve.py`'s `/proxy`), so `gateway_url` in `GET /config` must always be something the *browser* can actually reach. `current_browser_gateway_url()` in `serve.py` handles this: direct mode returns the real `ANTHROPIC_BASE_URL`; Headroom mode returns `serve.py`'s own `http://localhost:45321/proxy` — **not** `HEADROOM_URL` directly. Two independent bugs made this necessary and both will resurface if a future refactor "simplifies" it back to a direct URL:
1. Docker's `HEADROOM_URL` (`http://headroom:8787`, a Compose service name) only resolves inside containers — a direct browser fetch to it fails outright ("Failed to fetch").
2. Even given a browser-reachable address, Headroom's own CORS allowlist rejects `chrome-extension://` origins and the `x-api-key`/`anthropic-version` headers outright (`400 Disallowed CORS origin, headers`) — there's no config flag to change this. Routing through `serve.py`'s `/proxy` sidesteps it entirely since that's a server-to-server call, not subject to browser CORS.

**Headroom CCR vs. `web_search_20260209`** — The `headroom` sidecar is started with `--no-ccr-inject-tool` (see docker-compose.yml). Without it, Headroom's reversible-compression feature injects its own `headroom_retrieve` tool and buffers any `stream:true` request into a non-streaming upstream call so it can resolve retrieval tool-calls server-side, then reconstructs a synthetic SSE stream for the client. That reconstruction has no case for Anthropic's `server_tool_use` content block — exactly what `web_search_20260209` produces — so any Headroom-routed request where the model actually searches the web fails with a `502` (`"Unable to safely convert buffered response to SSE"`). The flag disables only the retrieval-tool injection, not the underlying token-saving compression.

## Loading the Chrome extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click toolbar icon to open the side panel

The extension reads its initial config from `GET /config` on `localhost:45321`.

## Key constraints

- `serve.py` must remain zero-dependency (Python stdlib only). No pip installs.
- The Dockerfile installs the lacework CLI via its install script during build — lacework SCA component is pre-installed to avoid download delays at runtime.
- The extension's CSP (`manifest.json`) restricts `connect-src` to `localhost:45321`, `https://api.github.com`, `https://raw.githubusercontent.com`, and `https://*` — any new fetch target must be added there.
