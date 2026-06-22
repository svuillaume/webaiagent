# Web AI Agent

A browser-native AI security assistant that runs as a Chrome side panel. Combines a Claude-powered chat interface with live FortiCNAPP (Lacework) cloud security data — CVE attack surface, LQL queries, compliance reports, and code scanning — all accessible while you browse.

## Architecture

```
Chrome Extension (side panel)
        │
        ├── Chat & tools → AI Gateway (Bifrost / Portkey / LiteLLM / Helicone)
        │                         └── Claude API (haiku / sonnet / opus)
        │
        └── Security tools → serve.py (localhost:8765)
                                  └── FortiCNAPP REST API
```

**serve.py** is a local Python stdlib HTTP server (no dependencies beyond standard library). It proxies the AI gateway, bridges FortiCNAPP API calls, and serves the extension's security endpoints.

## Features

### Chat
- Streaming Claude chat via any LLM-native AI gateway
- **📄 Read** — load the current page into context
- **TL;DR** — summarise the page in 3–5 bullets with source links
- Web search via SearXNG (self-hosted, privacy-preserving)

### Cloud Security (FortiCNAPP)
- **🚨 CVE** — attack surface assessment: search any CVE across hosts and containers, ranked by internet exposure and host risk score
- **🛡 Scan** — FortiCNAPP SCA + SAST scan on code found on the current page
- **📋 Compliance** — generate and download FortiCNAPP compliance PDF reports
- **🔍 LQL — Saved queries** — run pre-built Lacework Query Language queries against your live tenant
- **✨ LQL — Generate** — describe what you want to find in plain English; Claude builds and runs the LQL query for you

## AI Gateway Compatibility

The extension works with any LLM-native AI gateway that exposes an Anthropic-compatible `/v1/messages` endpoint. Select your gateway in the config bar — the extension adapts headers automatically.

| Gateway | Auth header | Key placeholder |
|---|---|---|
| **⚡ Bifrost** | `x-api-key: sk-bf-…` | Virtual key |
| **Portkey** | `x-portkey-api-key: pk-…` | Portkey API key |
| **LiteLLM** | `Authorization: Bearer sk-…` | Bearer token |
| **Helicone** | `x-api-key` (Anthropic) + `helicone-auth` | Anthropic key + Helicone key |

## Setup

### 1. Start the backend

```bash
cd bifrost
cp .env.example .env   # fill in your credentials
docker compose up -d
```

`.env` fields:
```
ANTHROPIC_BASE_URL=https://bifrost.fabriclab.ca/anthropic
BIFROST_VIRTUAL_KEY=sk-bf-…
ANTHROPIC_DEFAULT_MODEL=claude-sonnet-4-7
LQL_QUERIES_DIR=/lql_queries
```

### 2. LQL queries directory (optional)

Mount your `lql_queries/` folder in `docker-compose.yml`:
```yaml
volumes:
  - ~/claude_cnapp/lql/lql_queries:/lql_queries:ro
```

### 3. Install the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Click the extension icon in the toolbar to open the side panel

The URL and key auto-fill from `serve.py /config` on first open.

## FortiCNAPP credentials

The backend reads Lacework credentials from `~/.lacework.toml` (mounted read-only into the container). Standard `lacework configure` setup works.

## LQL Query Language

LQL queries in `lql_queries/*.yaml` use this structure:

```lql
{
    source { LW_CFG_AWS_EC2_INSTANCES }
    filter { RESOURCE_REGION NOT IN ('ca-central-1', 'ca-west-1') }
    return distinct {
        ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY,
        RESOURCE_REGION, RESOURCE_TYPE, SERVICE,
        'Instance outside Canada' as COMPLIANCE_FAILURE_REASON
    }
}
```

The **✨ Generate** tab lets you describe the objective in plain English — Claude writes the query, shows it for review, then runs it against your live tenant.

## Security model

| What | Storage | Lifetime |
|---|---|---|
| Gateway URL + key | `chrome.storage.session` (RAM) | Cleared on Chrome close |
| Gateway choice, model | `chrome.storage.local` | Persists (not sensitive) |
| Chat history | JS memory | Cleared on panel close |
| FortiCNAPP credentials | `~/.lacework.toml` on host | Never enter the extension |

The key never touches disk. Re-enter it once per Chrome session.

## Files

```
serve.py              Local proxy + FortiCNAPP API bridge
docker-compose.yml    bifrost-serve + searxng containers
extension/
  manifest.json       Extension config, permissions, CSP
  panel.html          Side panel UI (two-row header, chip buttons, drawers)
  panel.js            All logic: gateway auth, streaming, LQL, CVE, CodeSec
  background.js       Service worker — opens side panel on icon click
```
