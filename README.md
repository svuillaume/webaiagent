# Bifrost Chat — Chrome Extension

A secure AI chat side panel for the [Bifrost AI Gateway](https://bifrost.fabriclab.ca).

---

## What is this?

A Chrome browser extension that opens as a side panel and lets you chat with Claude AI models through a **Bifrost AI Gateway** — a private API proxy that manages model access and virtual keys for your organisation.

**Key capabilities:**
- 💬 Chat with Claude (haiku / sonnet / opus) via your private gateway
- 📄 **Read Web Page** — load any open tab into AI context and ask questions about it
- 📋 **TL;DR** — one-click bullet-point summary of the current page
- 🔍 **Web search** — live results via local SearXNG container (optional)
- 🔗 Clickable links in AI responses open in a new tab

---

## Who is this for?

Anyone with access to a Bifrost AI Gateway virtual key who wants a fast, private AI assistant embedded directly in Chrome — without sending data to third-party browser AI tools.

---

## Why is it secure?

| Concern | How it's handled |
|---------|-----------------|
| API key on disk | Never written to disk — stored in `chrome.storage.session` (RAM only, cleared on Chrome close) |
| API key in source | Loaded at runtime from `config.json` (gitignored) — never hardcoded |
| XSS from AI output | Markdown rendered via inert `<template>` element — injected scripts never execute |
| Outbound connections | CSP restricts to `https:` and `localhost:8080` only |
| Page content privacy | Page text stays local — sent only to your own Bifrost gateway |
| Secrets in git | `.env`, `config.json`, `searxng/` all gitignored |

---

## Requirements

- Google Chrome (or Chromium)
- Access to a Bifrost AI Gateway — URL + virtual key (`sk-bf-…`)
- (Optional) Docker Desktop for web search

---

## Step-by-step setup

### Step 1 — Clone the repo

```bash
git clone https://github.com/svuillaume/bifrost_pluggin.git
cd bifrost_pluggin/bifrost
```

### Step 2 — Create your credentials file

Copy the template and fill in your values:

```bash
cp extension/config.json.tpl extension/config.json
```

Edit `extension/config.json`:

```json
{
  "bifrost_url": "https://bifrost.fabriclab.ca/anthropic",
  "api_key":     "sk-bf-your-virtual-key-here",
  "searxng_url": "http://localhost:8080"
}
```

> `config.json` is **gitignored** — it will never be committed. Do not commit it manually.

The same values map to `.env` variables (used by `serve.py` if you run the local proxy):

```
ANTHROPIC_BASE_URL=
BIFROST_VIRTUAL_KEY=
ANTHROPIC_DEFAULT_MODEL=
```

> Copy `.env.tpl` → `.env` and fill in your values. `.env` is also gitignored.

### Step 3 — Load the extension in Chrome

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this repo
5. The ⚡ **Bifrost Chat** icon appears in your toolbar

### Step 4 — Open the side panel

Click the ⚡ icon — the side panel opens on the right.

On first load the URL and API key are auto-filled from `config.json`. The status bar shows **config loaded**.

### Step 5 — Start chatting

- Type a message → press **Enter** (Shift+Enter for a newline)
- Choose model: **haiku-4-5 ⚡** (fast, default) · sonnet-4-6 · opus-4-8
- **clear** resets the conversation

---

## Web search setup (optional)

Web search requires a local [SearXNG](https://docs.searxng.org) Docker container.
Public SearXNG instances block API access — self-hosting is the only reliable option.

### Why local? 
Public instances (searx.be etc.) return 403/429 on JSON API calls. Running locally gives unlimited, instant results with no rate limits.

```bash
# 1. Generate config with a random secret key
mkdir -p searxng
sed "s/REPLACE_WITH_RANDOM_SECRET/$(openssl rand -hex 32)/" \
    searxng.settings.yml.tpl > searxng/settings.yml

# 2. Start the container
docker compose up -d

# 3. Test it
curl "http://localhost:8080/search?q=test&format=json" | python3 -m json.tool | head -20
```

The extension auto-fills `http://localhost:8080` from `config.json`. The model will use web search automatically when you ask about current events.

Stop search: `docker compose down`

> `searxng/settings.yml` is **gitignored** — the generated secret never leaves your machine.

---

## Toolbar buttons

| Button | What it does |
|--------|-------------|
| **📄 Read Web Page** | Extracts text from the current tab (up to 12,000 chars) and loads it as context. Button turns green when active. Ask follow-up questions about the page. |
| **TL;DR** | Reads the current page and immediately streams a 3-5 bullet summary |
| **clear** | Wipes conversation history and resets context |

---

## Security model (full detail)

| What | Where stored | Lifetime |
|------|-------------|----------|
| Bifrost URL | `chrome.storage.session` (RAM) | Cleared when Chrome closes |
| API key | `chrome.storage.session` (RAM) | Cleared when Chrome closes |
| SearXNG URL | `chrome.storage.session` (RAM) | Cleared when Chrome closes |
| Model choice | `chrome.storage.local` (disk) | Persists (not sensitive) |
| Conversation history | JS memory only | Cleared when panel closes |
| Page content | JS memory only | Never persisted |

**The API key is never written to disk after initial load.** `config.json` is read once on panel open; the value moves immediately to session RAM.

**Content Security Policy** blocks all inline scripts, all external scripts, and restricts network calls to `https:` + `localhost:8080`.

**Page reading** uses `chrome.scripting` to extract visible text — no form data, no cookies, no credentials. Chrome prompts for permission per site.

---

## Code Security Scan

Scanned with **Lacework FortiCNAPP Code Security** (IaC + SCA/SAST).

| Severity | IaC | SCA | Total |
|----------|-----|-----|-------|
| Critical |  0  |  0  |   0   |
| High     |  0  |  0  |   0   |
| Medium   |  0  |  0  |   0   |
| Low      |  0  |  0  |   0   |

39 findings in `.venv/` (third-party packages) excluded via `.lacework/codesec.yaml`.

---

## File reference

```
extension/
  manifest.json           Permissions, CSP, extension metadata (v1.8)
  background.js           Service worker — opens side panel on icon click
  panel.html              Side panel UI + styles
  panel.js                All chat logic: storage, streaming, search, page reader
  config.json             Your credentials — gitignored, never committed
  config.json.tpl         Safe template — copy to config.json and fill in values
  icon16/48/128.png       Extension icons

docker-compose.yml        Starts local SearXNG search container
searxng.settings.yml.tpl  SearXNG config template — run setup command to generate real file
searxng/                  Generated at runtime, gitignored (contains secret key)

serve.py                  Local CORS proxy for chatbox.html (optional, not used by extension)
.env                      Server credentials — gitignored
.env.tpl                  Template: copy to .env and fill in values
.lacework/codesec.yaml    Code security scan config
```
