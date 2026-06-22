# Bifrost Chat — Chrome Extension

A minimal Chrome side-panel chat UI for the [Bifrost AI Gateway](https://bifrost.fabriclab.ca).

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this `extension/` folder
4. Click the ⚡ icon in the toolbar to open the side panel

## Usage

1. Paste your `sk-bf-…` virtual key into the **key** field
2. Pick a model (haiku / sonnet / opus)
3. Type a message and press **Enter** (Shift+Enter for newline)

The side panel stays open while you browse any page.

## Security model

| What | Storage | Lifetime |
|------|---------|----------|
| Virtual key | `chrome.storage.session` (RAM) | Cleared on Chrome close |
| Model choice | `chrome.storage.local` (disk) | Persists (not sensitive) |
| Chat history | JS memory | Cleared on panel close |

**The key never touches disk.** Re-enter it once per Chrome session.

The extension connects only to `https://bifrost.fabriclab.ca` — enforced by both
`host_permissions` and a strict `Content-Security-Policy` in the manifest.

## Code Security Scan

Scanned with **Lacework FortiCNAPP Code Security** (IaC + SCA/SAST) on 2026-06-22.

| Severity | IaC | SCA | Total |
|----------|-----|-----|-------|
| Critical |  0  |  0  |   0   |
| High     |  0  |  0  |   0   |
| Medium   |  0  |  0  |   0   |
| Low      |  0  |  0  |   0   |

**No findings in project code.** The scanner detected 39 weaknesses and secrets exclusively inside `.venv/` (third-party packages), which are excluded via `.lacework/codesec.yaml`.

## Files

```
manifest.json   Extension config, permissions, CSP
background.js   Service worker — opens side panel on icon click
panel.html      Side panel UI
panel.js        All logic: storage, markdown, streaming, XSS-safe rendering
icon*.png       16 / 48 / 128 px icons
```
