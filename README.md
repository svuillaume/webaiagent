# Web AI Agent — Chrome Extension 

I am your Web AI Security Agent integrating with your best AI Gateway platfrom (LLMlite, Portkey, Helicone, ...) built into Chrome and powered by FortiCNAPP for real-time code scanning and cloud security insights.

Ask questions about any webpage, search the web, or run FortiCNAPP security checks — all from a side panel without leaving your browser.
Use TL;DR mode to quickly summarize any page in seconds.

---

## What it does

**Chat & research** — works on any webpage:
- Ask the AI anything — it automatically searches the web when needed
- **Read** — loads the page you're on so you can ask questions about it
- **TL;DR** — gives a plain-English summary of any page in seconds
- **FortiGuard** — opens the FortiGuard Labs threat intelligence feed; the button flashes red when there are active outbreak alerts

**FortiCNAPP security tools** — click the 🔰 FortiCNAPP button:

| Tool | What it does |
|---|---|
| 🛡 **Scan Code** | Scans code on the current page or a GitHub repo for vulnerabilities and secrets |
| 📋 **Compliance Report** | Downloads a compliance PDF (CIS, NIST, PCI-DSS, SOC 2, HIPAA, and 50+ more) |
| 📊 **Advanced Analytics** | Runs saved LQL security queries against your FortiCNAPP account — or describe what you want in plain English and it writes the query for you |
| 🔬 **Attack Threat Surface** | Look up any CVE and see exactly which servers and containers in your environment are exposed |
| 💬 **Community Feed** | Opens the FortiCNAPP community blog and articles |

> Greyed-out buttons have a tooltip explaining what's needed to enable them.

---

## Before you start — what you need

| What | Where to get it |
|---|---|
| **Google Chrome** | [chrome.google.com](https://chrome.google.com) |
| **Python 3** | [python.org](https://python.org) — already installed on most Macs |
| **AI Gateway URL + key** | Provided by your IT team or Fortinet contact (starts with `sk-bf-…`) |
| **FortiCNAPP credentials** | Found in FortiCNAPP under **Settings → API Keys** |

You do not need Docker. You do not need to be a developer.

---

## Setup — 4 steps

### Step 1 — Download the extension

Download or clone this repository to a folder on your computer.
If you received a `.zip` file, unzip it first.

---

### Step 2 — Run the setup script

Open **Terminal** (macOS/Linux) or **PowerShell** (Windows) in the folder you just downloaded, then run:

**macOS / Linux:**
```
./setup.sh
```

**Windows:**
```
.\setup.ps1
```

The script asks you 3 questions:

1. **Gateway URL** — paste the URL your IT team gave you (e.g. `https://bifrost.yourcompany.com/anthropic`)
2. **Gateway key** — paste your API key (starts with `sk-bf-…`)
3. **FortiCNAPP credentials** — answer **y** to set these up now (you'll need your account name, API Key, and API Secret from FortiCNAPP → Settings → API Keys)

When you see ✔ at the end, the server is running and you're ready for Step 3.

---

### Step 3 — Load the extension in Chrome

1. Open Chrome and go to: **`chrome://extensions`**
2. Turn on **Developer mode** — toggle in the top-right corner
3. Click **Load unpacked**
4. Select the **`extension`** folder inside the folder you downloaded
5. The Web AI Agent icon (🔰) appears in your Chrome toolbar

---

### Step 4 — Start using it

Click the 🔰 icon in the Chrome toolbar — the side panel opens.
Type anything to start chatting, or use the toolbar buttons.

✅ **Check:** The status dot in the top-right of the panel should be green. If it's grey, the server isn't running — go back to Step 2.

---

## Stopping and restarting

The server runs quietly in the background.

**To stop:**
- macOS/Linux: `kill $(cat .serve.pid)`
- Windows: `Stop-Process -Id (Get-Content .serve.pid)`

**To restart:** run `./setup.sh` (or `.\setup.ps1`) again.

---

## Troubleshooting

**Panel shows "not connected" or status dot is grey**
→ The server isn't running. Open Terminal in the extension folder and run `./setup.sh` again.
→ Check it's running: open `http://localhost:45321` in Chrome — you should see a chat page.

**"Cannot scan a Github web page" when clicking Scan Code**
→ Navigate to a GitHub repository page first, then click Scan Code.

**Scan runs but finds nothing**
→ The page needs visible code — GitHub repository pages work best. On a GitHub repo, it fetches the actual source files automatically.

**LQL / CVE / Compliance buttons are greyed out**
→ Your FortiCNAPP credentials aren't configured. Run `./setup.sh` and answer **y** when asked about FortiCNAPP.

**Scan Code is greyed out but other buttons work**
→ The lacework CLI is not installed. Run `./setup.sh` and answer **y** when asked to install it.

**FortiGuard button is flashing red**
→ There is an active outbreak alert from the last 5 days. Click the button to open FortiGuard Labs — the flashing stops once you've checked it.

---

## Privacy & security

Your keys and credentials stay on your machine — nothing is stored in the cloud.

| Data | Where it's stored | When it's cleared |
|---|---|---|
| Gateway URL + API key | Browser memory only | When you close Chrome |
| Chat history | Browser memory only | When you close the side panel |
| Page content you read | Browser memory only | Never written to disk |
| FortiCNAPP credentials | Your machine only (`~/.lacework.toml`) | You control this |

The local server (`serve.py`) only listens on `localhost` — nothing is reachable from outside your machine.

---

## Technical reference

<details>
<summary>Manual configuration, environment variables, API endpoints</summary>

### Manual start (no setup script)

```bash
cp .env.tpl .env        # copy the template
# edit .env and fill in ANTHROPIC_BASE_URL and BIFROST_VIRTUAL_KEY
python3 serve.py        # starts on http://localhost:45321
```

### Environment variables (`.env`)

| Variable | Description |
|---|---|
| `ANTHROPIC_BASE_URL` | AI gateway endpoint URL |
| `BIFROST_VIRTUAL_KEY` | Gateway virtual key (`sk-bf-…`) |
| `ANTHROPIC_DEFAULT_MODEL` | Model used for chat and LQL Generate (default: `claude-haiku-4-5`) |
| `LQL_QUERIES_DIR` | Path to folder containing `.yaml` LQL query files |

FortiCNAPP credentials come from `~/.lacework.toml` (created by `lacework configure`).

### Backend API endpoints (served on `localhost:45321`)

| Method | Path | Description |
|---|---|---|
| GET | `/config` | Returns gateway URL, key, and feature-availability flags |
| POST | `/proxy/v1/*` | Proxies streaming requests to the AI gateway |
| POST | `/codesec` | SCA + SAST scan via lacework CLI |
| POST | `/sbom` | CycloneDX SBOM via lacework CLI |
| POST | `/compliance` | Generate compliance PDF report |
| GET | `/compliance/list` | List available compliance frameworks |
| GET | `/lql/queries` | List saved `.yaml` LQL query files |
| POST | `/lql/run` | Execute an LQL query against FortiCNAPP |
| POST | `/lql/cve` | CVE attack surface: affected hosts and containers |
| POST | `/lql/generate` | Convert plain-English objective to LQL via Claude |
| GET | `/fortiguard/outbreaks` | Proxies FortiGuard outbreak alert RSS feed |

### Docker (self-contained, for teams)

```bash
docker compose up -d          # first run
docker compose up --build -d  # after changes to serve.py
docker compose down
```

Requires `~/claude_cnapp/lql/lql_queries` for LQL files and `~/.lacework.toml` for credentials — both mounted read-only into the container.

</details>
