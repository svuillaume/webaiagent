# Web AI Agent — Chrome Extension

A browser-native AI security assistant. Opens as a Chrome side panel and stays visible while you browse.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this `extension/` folder
4. Click the extension icon in the toolbar to open the side panel

The **url** and **key** fields auto-fill from `serve.py` on first open (requires the Docker backend running on `localhost:8765`).

## Config bar

| Field | Purpose |
|---|---|
| Gateway | AI gateway type — sets auth headers automatically |
| url | Base URL of your gateway (e.g. `https://bifrost.fabriclab.ca/anthropic`) |
| key | API / virtual key for the selected gateway |
| model | Claude model to use |

### Supported gateways

| Gateway | url example | key format |
|---|---|---|
| ⚡ Bifrost | `https://bifrost.fabriclab.ca/anthropic` | `sk-bf-…` |
| Portkey | `https://api.portkey.ai` | `pk-…` |
| LiteLLM | `https://litellm.yourhost.com` | `sk-…` |
| Helicone | `https://anthropic.helicone.ai` | Anthropic key (`sk-ant-…`) |

## Action chips

| Button | What it does |
|---|---|
| 📄 Read | Load the current page into chat context |
| TL;DR | Summarise the page in 3–5 bullets with source links |
| 🛡 Scan | FortiCNAPP SCA + SAST scan on code found on this page |
| 📋 Compliance | Generate a FortiCNAPP compliance PDF report |
| 🔍 LQL | Run saved or AI-generated LQL queries against FortiCNAPP |
| 🚨 CVE | Search a CVE across hosts/containers by internet exposure |
| ✕ Clear | Clear chat history |

## LQL drawer — two tabs

**Saved queries** — dropdown of `.yaml` files from `lql_queries/` (served by `localhost:8765`). Select one and click ▶ Run.

**✨ Generate** — type a plain-English objective (e.g. "EC2 instances outside Canada"), press Build. Claude writes the LQL, shows it for review, then you click ▶ Run to execute it live.

## Security model

| What | Storage | Lifetime |
|---|---|---|
| Gateway URL + key | `chrome.storage.session` (RAM) | Cleared on Chrome close |
| Gateway choice, model | `chrome.storage.local` | Persists |
| Chat history | JS memory | Cleared on panel close |

The key never touches disk.

## Files

```
manifest.json   Extension config, permissions, CSP
background.js   Service worker — opens side panel on icon click
panel.html      UI: two-row header, chip action bar, drawer panels
panel.js        All logic: gateway auth, streaming, LQL, CVE, CodeSec
icon*.png       16 / 48 / 128 px icons
```
