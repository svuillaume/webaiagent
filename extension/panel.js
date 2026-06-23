'use strict';

// ── Constants ─────────────────────────────────────────────────────────────
const BASE_URL       = 'http://localhost:45321';
const MAX_TOKENS     = 4096;
const PAGE_MAX_CHARS = 12000;
const SYSTEM_PROMPT = `You are a CISO/VP-level security analyst. For every response that contains security findings, ALWAYS use this exact structure — no exceptions, no deviations:

---

# [Finding Title] — Risk Assessment

**Assessment Date:** [today]
**Priority:** CRITICAL / HIGH / MEDIUM / LOW
**Affected Assets:** [count and type]
**Affected Accounts / Systems:** [scope]
**Regions / Environments:** [if applicable]

---

## Executive Summary

### [Risk Headline in bold]

Two to three sentences. What is exposed, what could happen to the business if exploited, and what decision is needed now. No jargon. Write for a board member.

List any specifically named high-risk assets (exact names from the data).

If sensitive data may be involved, state the potential consequences:
- Regulatory reporting obligations
- Compliance violations (GDPR, CCPA, PCI-DSS, HIPAA)
- Incident response costs
- Customer notification obligations
- Reputational damage

**Executive Decision Required:** One sentence on what must be approved or initiated within 24 hours.

---

## Risk Overview

| Category | Assessment |
|---|---|
| Overall Risk | CRITICAL / HIGH / MEDIUM / LOW |
| Affected Scope | [number and type] |
| Geographic / Environment Scope | [regions or systems] |
| Potential Data Types | [PII, Credentials, Config, Logs, etc.] |
| Regulatory Exposure | HIGH / MEDIUM / LOW |
| Exploit Likelihood | HIGH / MEDIUM / LOW |
| Business Impact | HIGH / MEDIUM / LOW |

## Risk Heat Map

| Risk Area | Level |
|---|---|
| [Top risk area] | CRITICAL |
| [Second area] | HIGH |
| [Third area] | HIGH |
| [Fourth area] | MEDIUM |

---

## Key Findings

### 1. [Most Critical Finding Title]

Table listing the worst affected assets (name, account/owner, location, risk level).

Explain what these assets contain or could expose, and why that matters to the business.

### 2. [Second Finding Title]

Repeat structure. Group related assets together. Focus on business consequence.

[Continue for each distinct finding category]

---

## Business Impact Assessment

### Regulatory Impact
Which regulations may be triggered. What the penalties or obligations are.

### Operational Impact
What attackers could do with this information. What internal operations are at risk.

### Reputational Impact
Customer trust, brand damage, media exposure risk.

---

## Immediate Response Plan (0–72 Hours)

### Priority 1 — Contain
Specific assets to lock down immediately. Exact actions (block public access, revoke credentials, isolate system).

### Priority 2 — Validate Exposure
How to confirm whether data was accessed. Tools or services to invoke.

### Priority 3 — Protect Credentials
Any secrets, keys, or config that must be rotated.

### Priority 4 — Assign Ownership
Owner assignment and deadline requirements.

---

## Strategic Remediation Plan (30 Days)

Group into: Governance, Data Protection, Security Monitoring, Asset Hygiene. Bullet points per group.

---

## Recommended Executive Actions

**Immediate Approval Requested:**
Numbered list of decisions or authorizations needed from leadership.

**Quick Remediation — Automation Scripts:**
For each priority action, provide a ready-to-run CLI or shell snippet wherever possible. Use AWS CLI, Azure CLI, GCP CLI, or bash as appropriate to the resource type. Format each as a fenced code block with a one-line comment. Example — revoke S3 public access: aws s3api put-public-access-block --bucket BUCKET_NAME --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

---

## Impacted Resources Summary

MANDATORY — one row per affected resource. Never skip or group.

| Resource Name | Type | Account / Owner | Risk Level | Status |
|---|---|---|---|---|
| [exact name from data] | [EC2 / S3 / IAM Role / Container / etc.] | [account or owner] | CRITICAL / HIGH / MEDIUM / LOW | Exposed / Misconfigured / Unpatched / Unused |

---

## Conclusion

Two sentences. Restate the risk and the single most important thing to do now.

---

For conversational questions not related to security findings, be concise and direct. No filler phrases.`;
const ROLE_LABELS    = { user: 'you', ai: 'ai', system: 'sys' };

// ── Gateway profiles ──────────────────────────────────────────────────────
const GATEWAYS = {
  bifrost:  {
    label:    '⚡ Bifrost',
    urlHint:  'https://bifrost.xxx',
    keyHint:  'sk-bf-…',
    keyLabel: 'key',
    headers: key => ({
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01',
    }),
  },
  portkey:  {
    label:    'Portkey',
    urlHint:  'https://api.portkey.ai',
    keyHint:  'pk-…',
    keyLabel: 'key',
    headers: key => ({
      'Content-Type':      'application/json',
      'x-portkey-api-key': key,
      'anthropic-version': '2023-06-01',
    }),
  },
  litellm:  {
    label:    'LiteLLM',
    urlHint:  'https://litellm.xxx',
    keyHint:  'sk-…',
    keyLabel: 'key',
    headers: key => ({
      'Content-Type':      'application/json',
      'Authorization':     `Bearer ${key}`,
      'anthropic-version': '2023-06-01',
    }),
  },
  helicone: {
    label:    'Helicone',
    urlHint:  'https://anthropic.helicone.ai',
    keyHint:  'sk-ant-… (Anthropic key)',
    keyLabel: 'ant-key',
    headers: (key, heliconeKey) => ({
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01',
      ...(heliconeKey ? { 'helicone-auth': `Bearer ${heliconeKey}` } : {}),
    }),
  },
};

const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search' };

// ── State ─────────────────────────────────────────────────────────────────
const history = [];
let busy = false;

// ── DOM refs ──────────────────────────────────────────────────────────────
const el          = id => document.getElementById(id);
const urlInput    = el('url-input');
const keyInput    = el('key-input');
const key2Input   = el('key2-input');   // hidden — holds Helicone secondary auth key

const setStatus = (text, state = '') => {
  el('status').textContent = text;
  el('status').className   = state;
};

// ── Storage ───────────────────────────────────────────────────────────────
// session = auto-cleared on Chrome close (keeps credentials out of disk); local = survives restarts (safe for non-secret prefs)
chrome.storage.session.get(['bf_url', 'bf_key', 'bf_key2'], ({ bf_url, bf_key, bf_key2 }) => {
  if (bf_url)  urlInput.value  = bf_url;
  if (bf_key)  keyInput.value  = bf_key;
  if (bf_key2) key2Input.value = bf_key2;
  if (!bf_url || !bf_key) autoFillFromConfig();
});
chrome.storage.local.get(['bf_model', 'bf_gateway'], ({ bf_model, bf_gateway }) => {
  if (bf_model)  el('model').value   = bf_model;
  if (bf_gateway && GATEWAYS[bf_gateway]) {
    el('gateway').value = bf_gateway;
    applyGatewayProfile(bf_gateway);
  }
});

function applyGatewayProfile(gw) {
  const p = GATEWAYS[gw] || GATEWAYS.bifrost;
  urlInput.placeholder          = p.urlHint;
  keyInput.placeholder          = p.keyHint;
  el('key-label').textContent   = p.keyLabel;
}

el('gateway').addEventListener('change', () => {
  const gw = el('gateway').value;
  applyGatewayProfile(gw);
  chrome.storage.local.set({ bf_gateway: gw });
});

async function autoFillFromConfig() {
  let cfg = null;
  try {
    const res = await fetch(BASE_URL + '/config');
    if (res.ok) cfg = await res.json();
  } catch { /* serve.py not running */ }

  if (!cfg) {
    try {
      const res = await fetch(chrome.runtime.getURL('config.json'));
      if (res.ok) cfg = await res.json();
    } catch { /* no bundled config.json */ }
  }

  if (!cfg) return;

  const fill = (input, cfgKey, storeKey) => {
    if (cfg[cfgKey] && !input.value) {
      input.value = cfg[cfgKey];
      chrome.storage.session.set({ [storeKey]: cfg[cfgKey] });
    }
  };
  fill(urlInput,  'gateway_url', 'bf_url');
  fill(keyInput,  'api_key',     'bf_key');
  if (cfg.gateway_url || cfg.api_key) setStatus('config loaded', 'ok');

  const lwReady = cfg.lw_ready !== false;   // creds — LQL/CVE/Compliance
  const lwCli   = cfg.lw_cli   !== false;   // CLI binary — CodeSec/SBOM

  [['codesec', lwCli,   '⚠ lacework CLI not installed — CodeSec unavailable'],
   ['compliance', lwReady, '⚠ FortiCNAPP credentials not found (add ~/.lacework.toml)'],
   ['lql',        lwReady, '⚠ FortiCNAPP credentials not found (add ~/.lacework.toml)'],
   ['cve-btn',    lwReady, '⚠ FortiCNAPP credentials not found (add ~/.lacework.toml)'],
  ].forEach(([id, enabled, tip]) => {
    const btn = el(id);
    if (!btn) return;
    if (!enabled) {
      btn.classList.add('lw-disabled');
      btn.title = tip;
    } else {
      btn.classList.remove('lw-disabled');
    }
  });
  const fcBtn = el('fcnapp-btn');
  if (fcBtn) {
    fcBtn.title = (lwReady && lwCli)
      ? 'FortiCNAPP tools'
      : 'FortiCNAPP tools — ⚠ some features unavailable (see individual buttons)';
  }
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

async function showGreeting() {
  // Try Chrome identity first (signed-in Google account)
  const email = await new Promise(resolve =>
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, ({ email }) => resolve(email || ''))
  );
  let firstName = email ? email.split('@')[0].split('.')[0] : '';

  // Fall back to OS username from serve.py /config
  if (!firstName) {
    try {
      const r = await fetch(`${BASE_URL}/config`);
      if (r.ok) {
        const cfg = await r.json();
        if (cfg.user_name) firstName = cfg.user_name;
      }
    } catch { /* serve.py not running */ }
  }

  const name = firstName ? `, ${firstName.charAt(0).toUpperCase() + firstName.slice(1)}` : '';
  appendTurn('ai', `**${greeting()}${name}!** — I'm your Web AI Assistant, built into the browser. I can help you understand the page you're viewing and connect directly to your FortiCNAPP environment.

• 📄 **Read** / **TL;DR** — load the current page into context or generate a concise summary
• 🛡 **Scan Code** — run SCA and SAST scans against code found on the current page or a GitHub repository
• 🔰 **FortiCNAPP Security Tools** (Cloud Security) — run compliance reports, search CVEs, execute LQL queries, and investigate cloud assets, vulnerabilities, risks, and security posture

Type anything to get started.`);
}
showGreeting();

const saveSession = (key, input) => {
  const v = input.value.trim();
  v ? chrome.storage.session.set({ [key]: v }) : chrome.storage.session.remove(key);
};

urlInput.addEventListener('change',  () => saveSession('bf_url',  urlInput));
keyInput.addEventListener('change',  () => saveSession('bf_key',  keyInput));
key2Input.addEventListener('change', () => saveSession('bf_key2', key2Input));
el('model').addEventListener('change', () => chrome.storage.local.set({ bf_model: el('model').value }));

// ── Markdown renderer ─────────────────────────────────────────────────────
// Escape before transform so model output cannot inject HTML.
function renderMarkdown(text) {
  const esc  = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const link = (href, label) => {
    const url = /^https?:\/\//i.test(href) ? href : `https://${href}`;
    return `<a class="ext-link" data-href="${url}">${label}</a>`;
  };
  const inline = s => {
    s = s.replace(/`([^`\n]+)`/g,          '<code>$1</code>');
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g,  '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g,      '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g,        '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, l, h) => link(h, l));
    s = s.replace(/(?<!data-href=")(https?:\/\/[^\s<>"]+)/g, u => link(u, u));
    s = s.replace(/(?<![/"'>])(www\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s<>"]*)/, u => link(u, u));
    return s;
  };

  // Split on fenced code blocks first
  const parts = text.split(/(```[\s\S]*?```)/g);
  const html = parts.map((part, i) => {
    if (i % 2 === 1) {
      const lang = (part.match(/^```(\w+)/) || [])[1] || '';
      const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
      return `<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(code.trimEnd())}</code></pre>`;
    }

    const lines  = esc(part).split('\n');
    const out    = [];
    let listType = null, listItems = [], tableRows = [];

    const flushList = () => {
      if (!listItems.length) return;
      out.push(`<${listType}>${listItems.map(li => `<li>${inline(li)}</li>`).join('')}</${listType}>`);
      listItems = []; listType = null;
    };
    const flushTable = () => {
      if (!tableRows.length) return;
      const header = tableRows[0].map(c => `<th>${inline(c)}</th>`).join('');
      const body   = tableRows.slice(2).map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`);
      tableRows = [];
    };

    for (const raw of lines) {
      const line = raw;

      // Horizontal rule
      if (/^(\*\*\*|---|___)\s*$/.test(line.trim())) {
        flushList(); flushTable();
        out.push('<hr>'); continue;
      }
      // Table row
      if (/^\|/.test(line)) {
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        tableRows.push(cells); continue;
      }
      if (tableRows.length) { flushTable(); }

      // Headings
      const hm = line.match(/^(#{1,4})\s+(.*)/);
      if (hm) {
        flushList();
        const lvl = Math.min(hm[1].length + 1, 4); // h2–h4 inside bubble
        out.push(`<h${lvl} class="md-h">${inline(hm[2])}</h${lvl}>`); continue;
      }
      // Blockquote
      if (/^&gt;\s?/.test(line)) {
        flushList();
        out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`); continue;
      }
      // Unordered list
      const ul = line.match(/^(\s*)[-*+]\s+(.*)/);
      if (ul) {
        if (listType !== 'ul') { flushList(); listType = 'ul'; }
        listItems.push(ul[2]); continue;
      }
      // Ordered list
      const ol = line.match(/^\s*\d+\.\s+(.*)/);
      if (ol) {
        if (listType !== 'ol') { flushList(); listType = 'ol'; }
        listItems.push(ol[1]); continue;
      }

      flushList();
      // Blank line → paragraph break
      if (!line.trim()) { out.push('<br>'); continue; }
      out.push(`<p>${inline(line)}</p>`);
    }
    flushList(); flushTable();
    return out.join('');
  });
  return html.join('');
}

function setRendered(node, html) {
  // Preserve the copy button across replaceChildren
  const copyBtn  = node._copyBtn  || null;
  const copyBtn2 = node._allBody?._copyBtn || null;

  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  node.replaceChildren(tpl.content.cloneNode(true));
  if (copyBtn) node.appendChild(copyBtn);

  if (node._allBody) {
    const tpl2 = document.createElement('template');
    tpl2.innerHTML = html;
    node._allBody.replaceChildren(tpl2.content.cloneNode(true));
    if (copyBtn2) node._allBody.appendChild(copyBtn2);
  }
}

// ── Chat log (dual-pane: latest / all) ───────────────────────────────────
function scrollLog() {
  const active = document.querySelector('.log-pane.active');
  if (active) active.scrollTop = active.scrollHeight;
}

function _appendToLog(node, cloneForAll) {
  el('log-latest').appendChild(node);
  el('log-all').appendChild(cloneForAll || node.cloneNode(true));
  scrollLog();
}

// Archive the current Latest session and start fresh for a new FortiCNAPP feature.
// Call when opening any FortiCNAPP drawer so the previous conversation is preserved
// in History and Latest starts clean for the new feature context.
function startNewSession(label) {
  if (!el('log-latest').children.length) return; // nothing to archive
  history.length = 0; // resets AI context so the new feature session starts with a clean slate

  // Add a session-separator in log-all (History) so the boundary is visible
  const sep = Object.assign(document.createElement('div'), { className: 'session-sep' });
  sep.textContent = label;
  el('log-all').appendChild(sep);

  el('log-latest').innerHTML = ''; // clear Latest for the new session
}

document.querySelectorAll('.log-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.log-tab').forEach(t  => t.classList.remove('active'));
    document.querySelectorAll('.log-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    el('log-' + tab.dataset.pane).classList.add('active');
    scrollLog();
  });
});

function makeCopyBtn(getText) {
  const btn = Object.assign(document.createElement('button'), {
    className: 'rc-copy-btn', textContent: '⎘ Copy', title: 'Copy response',
  });
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(typeof getText === 'function' ? getText() : getText);
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = '⎘ Copy'; }, 1500);
  });
  return btn;
}

function makePdfBtn(getSourceEl) {
  const btn = Object.assign(document.createElement('button'), {
    className: 'rc-copy-btn rc-pdf-btn', textContent: '⬇ PDF', title: 'Export as PDF',
  });
  btn.addEventListener('click', () => {
    const sourceEl = typeof getSourceEl === 'function' ? getSourceEl() : getSourceEl;
    if (!sourceEl) return;

    const win = window.open('', '_blank');
    if (!win) return;

    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Web AI Agent Report</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; color: #111; max-width: 860px; margin: 40px auto; padding: 0 24px; }
  h2,h3,h4 { color: #003366; margin: 18px 0 6px; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th { background: #003366; color: #fff; padding: 6px 10px; text-align: left; }
  td { padding: 5px 10px; border: 1px solid #ccc; }
  tr:nth-child(even) td { background: #f4f7fb; }
  pre, code { background: #f4f4f4; border: 1px solid #ddd; padding: 8px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; }
  blockquote { border-left: 3px solid #cc0000; margin: 8px 0; padding: 4px 12px; color: #555; background: #fff5f5; }
  hr { border: none; border-top: 1px solid #ccc; margin: 14px 0; }
  a { color: #003366; }
  @media print { body { margin: 20px; } }
</style>
</head><body>
${sourceEl.innerHTML}
<hr style="margin-top:40px">
<p style="color:#888;font-size:11px">Generated by Web AI Agent &mdash; ${new Date().toLocaleString()}</p>
</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 400);
  });
  return btn;
}

function appendTurn(role, text = '') {
  const turn = Object.assign(document.createElement('div'), {
    className: `turn turn-${role}`,
  });

  if (role === 'system') {
    const body = Object.assign(document.createElement('div'), { className: 'content' });
    if (text) body.textContent = text;
    turn.append(body);
    _appendToLog(turn);
    return body;
  }

  const avatar = Object.assign(document.createElement('div'), {
    className: `role ${role}`,
    textContent: role === 'user' ? 'You' : 'AI',
  });

  const col = Object.assign(document.createElement('div'), { className: 'bubble-col' });
  const lbl = Object.assign(document.createElement('div'), {
    className: 'turn-label',
    textContent: role === 'user' ? 'You' : 'Web AI Agent',
  });
  const body = Object.assign(document.createElement('div'), { className: 'content' });
  if (text) {
    if (role === 'ai') setRendered(body, renderMarkdown(text));
    else               body.textContent = text;
  }
  turn.append(avatar, col);

  if (role === 'user') {
    col.append(lbl, body);
    _appendToLog(turn);
    return body;
  }

  // ai turn: body is live-updated during streaming — keep a reference in both panes
  if (role === 'ai') {
    const bodyClone   = Object.assign(document.createElement('div'), { className: 'content' });
    const colClone    = Object.assign(document.createElement('div'), { className: 'bubble-col' });
    const lblClone    = Object.assign(document.createElement('div'), { className: 'turn-label', textContent: 'Web AI Agent' });
    const avatarClone = Object.assign(document.createElement('div'), { className: 'role ai', textContent: 'AI' });
    const turnClone   = Object.assign(document.createElement('div'), { className: 'turn turn-ai' });

    col.append(lbl, body);
    colClone.append(lblClone, bodyClone);
    turnClone.append(avatarClone, colClone);

    // Static text (greeting, page-loaded, etc.) — add copy + PDF buttons immediately
    if (text) {
      col.appendChild(makeCopyBtn(text));
      col.appendChild(makePdfBtn(body));
      colClone.appendChild(makeCopyBtn(text));
      colClone.appendChild(makePdfBtn(bodyClone));
    }

    el('log-latest').appendChild(turn);
    el('log-all').appendChild(turnClone);
    scrollLog();

    body._allBody = bodyClone; // dual-pane sync: setRendered writes to both Latest and History simultaneously
    return body;
  }
}
const resizePrompt = () => {
  const p = el('prompt');
  p.style.height = 'auto';
  p.style.height = Math.min(p.scrollHeight, 180) + 'px';
};

// ── Clear ─────────────────────────────────────────────────────────────────
el('clear').addEventListener('click', () => {
  history.length = 0;
  el('log-latest').innerHTML   = '';
  el('log-all').innerHTML      = '';
  el('token-info').textContent = '';
  el('read-page').classList.remove('active');
  setStatus('—');
});

// ── Page reader ───────────────────────────────────────────────────────────
async function readCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args:   [PAGE_MAX_CHARS],
    func:   (maxChars) => {
      const clone = document.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,nav,footer,aside,iframe').forEach(n => n.remove());
      const text = (clone.body?.innerText || clone.body?.textContent || '')
        .replace(/\s{3,}/g, '\n\n').trim().slice(0, maxChars);
      return { title: document.title, url: location.href, text };
    },
  });
  return result;
}

const pageCtx = page => `[Page context]\nTitle: ${page.title}\nURL: ${page.url}\n\n${page.text}`;

// Shared wrapper for page-button actions: disables btn, restores on finish
async function withPage(btnId, fn) {
  const btn = el(btnId);
  btn.disabled = true;
  setStatus('reading page…', 'busy');
  try {
    await fn(await readCurrentPage());
  } catch (e) {
    appendTurn('system', `Could not read page: ${e.message}`);
    setStatus('error', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── FortiGuard outbreak alert flash ─────────────────────────────────────────
(async function initFortiGuardAlert() {
  const btn       = el('fortiguard-feed');
  const STORE_KEY = 'fg_seen_outbreak';
  const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;

  async function checkOutbreaks() {
    try {
      const res  = await fetch(BASE_URL + '/fortiguard/outbreaks');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.items?.length) return;

      const now    = Date.now();
      const newest = data.items
        .map(i => ({ ...i, ts: i.pubDate ? new Date(i.pubDate).getTime() : 0 }))
        .filter(i => i.ts > 0 && (now - i.ts) < FIVE_DAYS);

      if (!newest.length) { btn.classList.remove('fg-alert'); return; }

      // Check if user already saw this alert
      const { [STORE_KEY]: seen } = await chrome.storage.local.get(STORE_KEY);
      const latestTs = Math.max(...newest.map(i => i.ts));
      if (seen && seen >= latestTs) { btn.classList.remove('fg-alert'); return; }

      btn.classList.add('fg-alert');
      btn.title = `⚠ ${newest.length} outbreak alert${newest.length > 1 ? 's' : ''} in the last 5 days — click to view`;
    } catch { /* serve.py not running */ }
  }

  btn.addEventListener('click', async () => {
    btn.classList.remove('fg-alert');
    // Record seen time so it won't flash again for same alerts
    await chrome.storage.local.set({ [STORE_KEY]: Date.now() });
    chrome.tabs.create({ url: 'https://www.fortiguard.com/' });
  });

  // Check on load, then every 30 minutes
  checkOutbreaks();
  setInterval(checkOutbreaks, 30 * 60 * 1000);
})();

el('fcnapp-community').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://community.fortinet.com/forticnapp-63' });
});

el('read-page').addEventListener('click', () => withPage('read-page', page => {
  history.push({ role: 'user',      content: pageCtx(page) });
  history.push({ role: 'assistant', content: 'Page loaded. Ask me anything about it.' });
  appendTurn('system', `📄 "${page.title}"`);
  appendTurn('ai',     'Page loaded. Ask me anything about it.');
  el('read-page').classList.add('active');
  setStatus('page loaded', 'ok');
}));

el('tldr').addEventListener('click', () => withPage('tldr', async page => {
  history.push({ role: 'user',      content: pageCtx(page) });
  history.push({ role: 'assistant', content: 'Page loaded.' });
  history.push({ role: 'user',      content: 'TL;DR this page in 3-5 bullets. End each bullet with a markdown link to the most relevant source URL.' });
  appendTurn('system', `📄 TL;DR — "${page.title}"`);
  el('read-page').classList.add('active');
  await send(true); // user turn already pushed above; silent avoids re-appending it
}));

// ── SSE stream parser ─────────────────────────────────────────────────────
async function readStream(res, bubble, cursor) {
  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = '', out = '', inputTk = 0, outputTk = 0, searchMarker = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') break;
      let ev; try { ev = JSON.parse(raw); } catch { continue; }

      if (ev.type === 'message_start')
        inputTk = ev.message?.usage?.input_tokens ?? 0;
      if (ev.type === 'message_delta')
        outputTk = ev.usage?.output_tokens ?? outputTk;

      // Show [searching…] while the server-side web_search tool runs
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use'
          && ev.content_block?.name === 'web_search') {
        searchMarker = Object.assign(document.createElement('span'), {
          className: 'search-marker', textContent: ' [searching…] ',
        });
        bubble.appendChild(searchMarker);
        bubble.appendChild(cursor);
        setStatus('searching…', 'busy');
      }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_result') {
        searchMarker?.remove(); searchMarker = null;
        setStatus('streaming…', 'busy');
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        searchMarker?.remove(); searchMarker = null;
        out += ev.delta.text;
        setRendered(bubble, renderMarkdown(out));
        bubble.appendChild(cursor);
        scrollLog();
      }
    }
  }
  return { out, inputTk, outputTk };
}

// ── Send ──────────────────────────────────────────────────────────────────
// silent = true: caller already pushed the user turn into history and appended it to the log,
//   so send() must skip both steps to avoid duplicating the visible message.
async function send(silent = false) {
  if (busy) return;

  const baseUrl = urlInput.value.trim().replace(/\/+$/, '');
  const key     = keyInput.value.trim();
  if (!baseUrl) { appendTurn('system', 'No endpoint URL — enter the gateway base URL above.'); return; }
  if (!key)     { appendTurn('system', 'No API key — enter your key above.'); return; }

  if (!silent) {
    const text = el('prompt').value.trim();
    if (!text) return;
    history.push({ role: 'user', content: text });
    appendTurn('user', text);
    el('prompt').value = '';
    el('prompt').style.height = 'auto';
  }

  const bubble = appendTurn('ai');
  const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
  bubble.appendChild(cursor);
  busy = true;
  el('send').disabled = true;

  const gw      = el('gateway').value || 'bifrost';
  const profile = GATEWAYS[gw] || GATEWAYS.bifrost;
  const headers = profile.headers(key, gw === 'helicone' ? key2Input.value.trim() : undefined);

  try {
    setStatus('streaming…', 'busy');
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: el('model').value, max_tokens: MAX_TOKENS,
        stream: true, system: SYSTEM_PROMPT, messages: history,
        tools: [WEB_SEARCH_TOOL],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const { out, inputTk, outputTk } = await readStream(res, bubble, cursor);
    cursor.remove();
    if (out) {
      const node = document.createElement('span');
      setRendered(node, renderMarkdown(out));
      bubble.appendChild(node);
      bubble.appendChild(makeCopyBtn(out));
      bubble.appendChild(makePdfBtn(node));
      if (bubble._allBody) {
        bubble._allBody.appendChild(makeCopyBtn(out));
        bubble._allBody.appendChild(makePdfBtn(node));
      }
    }
    history.push({ role: 'assistant', content: out });
    setStatus('ok', 'ok');
    el('token-info').textContent = `in:${inputTk} out:${outputTk}`;
  } catch (err) {
    cursor.remove();
    bubble.textContent = `Error: ${err.message}`;
    history.pop();
    setStatus('error', 'err');
  } finally {
    busy = false;
    el('send').disabled = false;
    scrollLog();
  }
}

// ── FortiCNAPP dropdown toggle ────────────────────────────────────────────────
(function () {
  const btn  = el('fcnapp-btn');
  const menu = el('fcnapp-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    if (!isOpen) {
      const r = btn.getBoundingClientRect();
      menu.style.top  = `${r.bottom + 4}px`;
      menu.style.left = `${r.left}px`;
    }
    menu.classList.toggle('open', !isOpen);
    btn.classList.toggle('open', !isOpen);
  });

  menu.addEventListener('click', () => {
    menu.classList.remove('open');
    btn.classList.remove('open');
  });

  document.addEventListener('click', e => {
    if (!btn.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.remove('open');
      btn.classList.remove('open');
    }
  });
})();

// MV3 side panels block target="_blank"; open links via chrome.tabs instead
function handleExtLink(e) {
  const a = e.target.closest('a.ext-link');
  if (!a) return;
  e.preventDefault();
  chrome.tabs.create({ url: a.dataset.href });
}
el('log-latest').addEventListener('click', handleExtLink);
el('log-all').addEventListener('click', handleExtLink);
el('codesec-body').addEventListener('click', handleExtLink);

el('prompt').addEventListener('input',   resizePrompt);
el('prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
el('send').addEventListener('click', send);

el('prompt').focus();

// ── FortiCNAPP CodeSec + SBOM ─────────────────────────────────────────────

// SCA requires real manifest filenames — detect the type from content.
function guessFilename(snippet, index) {
  // Package manifests — must use exact filenames for lacework SCA to parse them
  if (/^\s*\{[\s\S]*"dependencies"\s*:/.test(snippet))           return 'package.json';
  if (/^\[packages\]|^\[dev-packages\]/m.test(snippet))          return 'Pipfile';
  if (/^[a-zA-Z0-9_.-]+==[0-9]/.test(snippet))                  return 'requirements.txt';
  if (/^\s*<project[\s\S]*<dependencies>/m.test(snippet))        return 'pom.xml';
  if (/^module\s+\S+\s*\n[\s\S]*^require\s*\(/m.test(snippet))  return 'go.mod';
  if (/^\[package\]\s*\nname\s*=/m.test(snippet))                return 'Cargo.toml';
  if (/^gemspec|^gem\s+['"]/.test(snippet))                      return 'Gemfile';
  if (/^<Project[\s\S]*PackageReference/m.test(snippet))         return `project${index}.csproj`;
  if (/^\s*\{[\s\S]*"require"\s*:/m.test(snippet))               return 'composer.json';
  if (/^name:\s*\S+\nversion:/m.test(snippet))                   return 'Chart.yaml'; // Helm

  // Lock files
  if (/^# yarn lockfile/.test(snippet))                          return 'yarn.lock';
  if (/^# This file is automatically/m.test(snippet) &&
      /version\s*=\s*\d/.test(snippet))                         return 'Pipfile.lock';

  // Source files
  if (/^\s*(import|from\s+\S+\s+import|def |class |if __name__)/.test(snippet)) return `snippet${index}.py`;
  if (/^\s*(const|let|var|function\s|\(.*\)\s*=>|require\()/.test(snippet))      return `snippet${index}.js`;
  if (/^\s*(import\s+\{|export\s+(default|const|function)|interface\s+\w)/.test(snippet)) return `snippet${index}.ts`;
  if (/^\s*(package\s+\w|import\s+java\.|public\s+(class|interface))/.test(snippet))      return `snippet${index}.java`;
  if (/<\?php/.test(snippet))                                    return `snippet${index}.php`;
  if (/^\s*(resource|provider|variable|module|terraform)\s+"/.test(snippet))     return `snippet${index}.tf`;
  if (/^\s*(FROM|RUN|COPY|EXPOSE|ENTRYPOINT)\s/.test(snippet))  return 'Dockerfile';
  if (/^\s*(apiVersion|kind):\s/.test(snippet))                  return `manifest${index}.yaml`;
  return `snippet${index}.txt`;
}

// ── GitHub repo scanner ───────────────────────────────────────────────────

const MANIFEST_NAMES = new Set([
  'requirements.txt', 'requirements-dev.txt', 'requirements-test.txt',
  'Pipfile', 'Pipfile.lock', 'setup.py', 'setup.cfg', 'pyproject.toml',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'go.mod', 'go.sum',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'Cargo.toml', 'Cargo.lock',
  'Gemfile', 'Gemfile.lock',
  'composer.json', 'composer.lock',
  'Chart.yaml', 'Chart.lock',
  'Dockerfile', '.dockerignore',
]);
const SOURCE_EXTS = new Set([
  '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rb', '.php',
  '.tf', '.rs', '.cs', '.cpp', '.c', '.h', '.yaml', '.yml',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', '__pycache__',
  '.venv', 'venv', 'env', 'coverage', '.nyc_output',
]);

function githubRepoFromUrl(url) {
  // Matches: github.com/owner/repo  (any path beneath)
  const m = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

async function fetchGithubRepoFiles(owner, repo) {
  setStatus('fetching repo tree…', 'busy');

  const ghHeaders = { Accept: 'application/vnd.github+json' };

  // Get default branch
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`,
    { headers: ghHeaders });
  if (!repoRes.ok) throw new Error(`GitHub API ${repoRes.status}: ${owner}/${repo}`);
  const repoData = await repoRes.json();
  const branch   = repoData.default_branch || 'main';

  // Fetch full recursive file tree
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: ghHeaders });
  if (!treeRes.ok) throw new Error(`Tree API ${treeRes.status}`);
  const tree = await treeRes.json();

  // Select which files to fetch: all manifests + source files (skip large/binary/vendor)
  const candidates = (tree.tree || []).filter(item => {
    if (item.type !== 'blob') return false;
    if (item.size > 200_000) return false; // skip files >200 KB
    const parts = item.path.split('/');
    if (parts.some(p => SKIP_DIRS.has(p))) return false;
    const name = parts[parts.length - 1];
    const ext  = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    return MANIFEST_NAMES.has(name) || SOURCE_EXTS.has(ext);
  });

  // Prioritise manifests, then source — cap total at 80 files to stay fast
  const manifests = candidates.filter(f => {
    const name = f.path.split('/').pop();
    return MANIFEST_NAMES.has(name);
  });
  const sources = candidates.filter(f => {
    const name = f.path.split('/').pop();
    return !MANIFEST_NAMES.has(name);
  });
  const selected = [...manifests, ...sources].slice(0, 80);

  // Fetch file contents in parallel batches of 10
  const files = [];
  for (let i = 0; i < selected.length; i += 10) {
    const batch = selected.slice(i, i + 10);
    setStatus(`fetching files ${i + 1}–${Math.min(i + 10, selected.length)} / ${selected.length}…`, 'busy');
    const results = await Promise.all(batch.map(async item => {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.path}`;
        const r = await fetch(rawUrl);
        if (!r.ok) return null;
        const code = await r.text();
        return { filename: item.path.split('/').pop(), code, path: item.path };
      } catch { return null; }
    }));
    files.push(...results.filter(Boolean));
  }
  return { files, owner, repo, branch };
}

function appendResultCard(icon, title, contentEl) {
  const table = contentEl.querySelector('table');

  const buildCopyBtn = (body) => {
    const btn = document.createElement('button');
    btn.className   = 'rc-copy-btn';
    btn.textContent = '⎘ Copy';
    btn.title       = 'Copy as plain text';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(body.innerText || body.textContent);
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = '⎘ Copy'; }, 1500);
    });
    return btn;
  };

  const buildCsvBtn = (tbl) => {
    if (!tbl) return null;
    const btn = document.createElement('button');
    btn.className   = 'rc-copy-btn';
    btn.textContent = '⬇ CSV';
    btn.title       = 'Download as CSV';
    btn.addEventListener('click', () => {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      const csv  = rows.map(r =>
        Array.from(r.querySelectorAll('th,td'))
          .map(c => `"${(c.textContent || '').replace(/"/g, '""')}"`)
          .join(',')
      ).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url  = URL.createObjectURL(blob);
      chrome.downloads
        ? chrome.downloads.download({ url, filename: `${title.replace(/[^a-z0-9]/gi,'_')}.csv` })
        : chrome.tabs.create({ url });
    });
    return btn;
  };

  const buildCard = (body) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    const hdr = document.createElement('div');
    hdr.className = 'result-card-header';
    hdr.innerHTML = `<span class="result-card-icon">${icon}</span><span class="result-card-title">${title}</span>`;
    const csvBtn = buildCsvBtn(body.querySelector('table'));
    if (csvBtn) {
      const actions = document.createElement('div');
      actions.className = 'rc-actions';
      actions.appendChild(csvBtn);
      hdr.appendChild(actions);
    }
    // Footer with copy button always visible at the bottom of the card
    const footer = document.createElement('div');
    footer.className = 'rc-footer';
    footer.appendChild(buildCopyBtn(body));
    card.append(hdr, body, footer);
    return card;
  };

  el('log-latest').appendChild(buildCard(contentEl));
  el('log-all').appendChild(buildCard(contentEl.cloneNode(true)));
  scrollLog();
}

function appendGithubCard(owner, repo, branch, files) {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const repoUrl = `https://github.com/${owner}/${repo}`;

  // Group files by directory
  const groups = {};
  files.forEach(f => {
    const parts = (f.path || f.filename || '').split('/');
    const dir   = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
    (groups[dir] = groups[dir] || []).push(parts[parts.length - 1]);
  });

  const rows = Object.entries(groups).map(([dir, fnames]) => {
    const dirLabel = dir === '(root)' ? '' : `<span class="gh-dir">${esc(dir)}/</span>`;
    const fileChips = fnames.map(n =>
      `<span class="gh-file">${esc(n)}</span>`
    ).join('');
    return `<div class="gh-row">${dirLabel}${fileChips}</div>`;
  }).join('');

  const card = document.createElement('div');
  card.className = 'gh-card';
  card.innerHTML =
    `<div class="gh-header">` +
      `<span class="gh-icon">⬡</span>` +
      `<a class="ext-link gh-repo" data-href="${repoUrl}">${esc(owner)}/<strong>${esc(repo)}</strong></a>` +
      `<span class="gh-branch">⎇ ${esc(branch)}</span>` +
      `<span class="gh-count">${files.length} file${files.length !== 1 ? 's' : ''}</span>` +
    `</div>` +
    `<div class="gh-files">${rows}</div>`;

  el('log-latest').appendChild(card);
  el('log-all').appendChild(card.cloneNode(true));
  scrollLog();
}

async function extractPageCode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  const url = tab.url || '';
  if (/^(chrome|chrome-extension|about|edge):\/\//i.test(url))
    throw new Error(`Cannot scan a browser page (${url.split('://')[0]}://). Navigate to a Github web page first.`);

  const ghRepo = githubRepoFromUrl(tab.url || '');
  if (ghRepo) {
    const { files, owner, repo, branch } = await fetchGithubRepoFiles(ghRepo.owner, ghRepo.repo);
    // Build basename → [full path] map so findings can resolve the GitHub URL
    const pathMap = {};
    files.forEach(f => {
      if (!f.path) return;
      const base = f.path.split('/').pop();
      (pathMap[base] = pathMap[base] || []).push(f.path);
    });
    appendGithubCard(owner, repo, branch, files);
    return { files, title: tab.title || 'page', url: tab.url || '', ghCtx: { owner, repo, branch, pathMap } };
  }

  // Fallback: scrape <pre> blocks from the rendered page
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const snippets = [];
      document.querySelectorAll('pre code, pre, textarea, .highlight, .code-block').forEach(node => {
        const text = (node.innerText || node.textContent || '').trim();
        if (text.length > 30) snippets.push(text);
      });
      const seen = new Set();
      return snippets.filter(s => { if (seen.has(s)) return false; seen.add(s); return true; });
    },
  });
  const snippets = result || [];
  const usedNames = new Set();
  const files = snippets.map((code, i) => {
    let name = guessFilename(code, i);
    if (usedNames.has(name)) {
      const ext  = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
      const base = name.slice(0, name.length - ext.length);
      name = `${base}_${i}${ext}`;
    }
    usedNames.add(name);
    return { filename: name, code };
  });
  return { files, title: tab.title || 'page', url: tab.url || '' };
}

function severityOrder(s) {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[s?.toLowerCase()] ?? 5;
}

function renderCodeSecResults(data, mode, ghCtx, scannedFiles) {
  el('codesec-panel').classList.remove('open');
  const body = document.createElement('div');
  body.className = 'cs-result-body';

  if (mode === 'sbom') {
    if (data.error) {
      body.innerHTML = `<div class="cs-empty" style="color:var(--err)">${data.error}</div>`;
      appendResultCard('📦', 'FortiCNAPP SBOM', body);
      return;
    }
    const components = data.components || [];
    const title = document.createElement('div');
    title.className = 'cs-section-title';
    title.textContent = `CycloneDX SBOM — ${components.length} component${components.length !== 1 ? 's' : ''}`;
    body.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'cs-sbom-actions';
    const dlBtn = document.createElement('button');
    dlBtn.className = 'cs-sbom-btn';
    dlBtn.textContent = '⬇ Download JSON';
    dlBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      chrome.downloads ? chrome.downloads.download({ url, filename: 'sbom.cyclonedx.json' })
                       : chrome.tabs.create({ url });
    });
    const copyBtn = document.createElement('button');
    copyBtn.className = 'cs-sbom-btn';
    copyBtn.textContent = '📋 Copy JSON';
    copyBtn.addEventListener('click', () => navigator.clipboard.writeText(JSON.stringify(data, null, 2)));
    actions.append(dlBtn, copyBtn);
    body.appendChild(actions);

    if (!components.length) {
      const empty = document.createElement('div');
      empty.className = 'cs-empty';
      empty.textContent = 'No packages detected in page code snippets.';
      body.appendChild(empty);
      appendResultCard('📦', 'FortiCNAPP SBOM', body);
      return;
    }
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    components.slice(0, 50).forEach(c => {
      const row = document.createElement('div');
      row.className = 'cs-row';
      row.style.gridTemplateColumns = '1fr 80px';
      row.innerHTML =
        `<div class="cs-detail">${esc(c.name || '')}` +
          `<span class="cs-sub"> ${esc(c.version || '')} · ${esc(c.type || '')}</span></div>` +
        `<div class="cs-sub">${esc(c.licenses?.[0]?.license?.id || '—')}</div>`;
      body.appendChild(row);
    });
    if (components.length > 50) {
      const more = document.createElement('div');
      more.className = 'cs-sub';
      more.style.padding = '4px 0';
      more.textContent = `… and ${components.length - 50} more components`;
      body.appendChild(more);
    }
    appendResultCard('📦', 'FortiCNAPP SBOM', body);
    return;
  }

  // CodeSec mode
  const all = [
    ...(data.secrets   || []).map(f => ({ ...f, _cat: 'Secrets' })),
    ...(data.weaknesses|| []).map(f => ({ ...f, _cat: 'SAST Weaknesses' })),
    ...(data.vulns     || []).map(f => ({ ...f, _cat: 'SCA Vulnerabilities' })),
  ].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));

  if (!all.length) {
    const ok = document.createElement('div');
    ok.className = 'cs-empty';
    ok.textContent = '✓ No vulnerabilities, weaknesses, or secrets detected.';
    body.appendChild(ok);
    appendResultCard('🛡', 'FortiCNAPP CodeSec', body);
    return;
  }

  const byCategory = {};
  all.forEach(f => {
    (byCategory[f._cat] = byCategory[f._cat] || []).push(f);
  });

  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  Object.entries(byCategory).forEach(([cat, findings]) => {
    const title = document.createElement('div');
    title.className = 'cs-section-title';
    title.textContent = `${cat} (${findings.length})`;
    body.appendChild(title);

    findings.forEach(f => {
      const row = document.createElement('div');
      row.className = 'cs-row';
      const sev     = (f.severity || 'info').toLowerCase();
      const idStr   = f.id || '';
      // Truncate long CVE descriptions to first sentence / 120 chars
      const rawDesc = f.title || (f.description || '').split('\n')[0].slice(0, 120) || idStr;
      const locLabel = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '';
      const locHtml  = (() => {
        if (!locLabel) return '';
        if (ghCtx && f.file) {
          const base     = f.file.split('/').pop();
          const paths    = ghCtx.pathMap?.[base] || [];
          // Pick the path whose suffix best matches what the scanner reported
          const fullPath = paths.find(p => p.endsWith(f.file)) || paths[0] || f.file;
          const href = `https://github.com/${ghCtx.owner}/${ghCtx.repo}/blob/${ghCtx.branch}/${fullPath}${f.line ? '#L' + f.line : ''}`;
          return `<span class="cs-sub"> <a class="ext-link" data-href="${href}">${esc(locLabel)}</a></span>`;
        }
        return `<span class="cs-sub"> ${esc(locLabel)}</span>`;
      })();
      const fixStr  = f.fixVersion || '';
      row.innerHTML =
        `<div class="cs-sev ${esc(sev)}">${esc(sev)}</div>` +
        `<div class="cs-detail">${esc(rawDesc)}` +
          (idStr    ? `<span class="cs-sub"> [${esc(idStr)}]</span>` : '') +
          locHtml +
          (fixStr   ? `<span class="cs-sub"> → fix: ${esc(fixStr)}</span>` : '') +
        `</div>`;

      // Fix button — send finding + file content to chat
      const fixBtn = document.createElement('button');
      fixBtn.className = 'cs-fix-btn';
      fixBtn.textContent = '✦ Fix';
      fixBtn.title = 'Ask Claude to propose a fix for this finding';
      fixBtn.addEventListener('click', () => {
        const base      = (f.file || '').split('/').pop();
        const fileEntry = scannedFiles?.find(sf =>
          (sf.path || sf.filename || '').endsWith(f.file || '') ||
          (sf.filename || '') === base
        );
        const isSast = f._cat !== 'SCA Vulnerabilities';
        let codeBlock = '';
        if (fileEntry) {
          if (isSast && f.line) {
            // SAST: extract a window of lines around the finding
            const lines   = fileEntry.code.split('\n');
            const lineIdx = f.line - 1;
            const start   = Math.max(0, lineIdx - 3);
            const end     = Math.min(lines.length, lineIdx + 4);
            const snippet = lines.slice(start, end)
              .map((l, i) => `${start + i + 1 === f.line ? '>' : ' '} ${start + i + 1}  ${l}`)
              .join('\n');
            codeBlock = `\`\`\`\n// ${fileEntry.path || fileEntry.filename} (lines ${start + 1}–${end})\n${snippet}\n\`\`\``;
          } else if (!isSast) {
            codeBlock = `\`\`\`\n// ${fileEntry.path || fileEntry.filename}\n${fileEntry.code}\n\`\`\``;
          }
        }
        const prompt =
          `Fix the following ${f._cat} finding using best practices.\n\n` +
          `**${rawDesc}**${idStr ? ` [${idStr}]` : ''}\n` +
          (locLabel ? `Location: \`${locLabel}\`\n` : '') +
          (fixStr   ? `Suggested fix version: ${fixStr}\n` : '') +
          (f.fix    ? `Remediation hint: ${f.fix}\n` : '') +
          (codeBlock ? `\n${codeBlock}` : '') +
          `\n\nProvide the corrected code snippet only, with a brief explanation of what changed and why.`;

        el('codesec-panel').classList.remove('open');
        el('prompt').value = prompt;
        resizePrompt();
        el('prompt').focus();
        send();
      });
      row.appendChild(fixBtn);
      body.appendChild(row);
    });
  });

  if (data.stderr) {
    const warn = document.createElement('div');
    warn.className = 'cs-sub';
    warn.style.cssText = 'padding:6px 0;color:var(--err)';
    warn.textContent = `Scanner warning: ${data.stderr}`;
    body.appendChild(warn);
  }
  appendResultCard('🛡', 'FortiCNAPP CodeSec', body);
}

async function runCodeSec(mode) {
  const btn = el(mode === 'sbom' ? 'sbom' : 'codesec');
  btn.classList.add('busy');
  btn.disabled = true;
  setStatus(`${mode === 'sbom' ? 'generating SBOM' : 'scanning'}…`, 'busy');

  try {
    const { files, ghCtx } = await extractPageCode();
    if (!files.length) {
      appendTurn('system', 'No code blocks found on this page.');
      setStatus('—');
      return;
    }

    const res = await fetch(`${BASE_URL}/${mode === 'sbom' ? 'sbom' : 'codesec'}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ files }),
    });
    if (!res.ok) throw new Error(`Scan endpoint returned ${res.status}`);
    const data = await res.json();
    try {
      renderCodeSecResults(data, mode, ghCtx, files);
    } catch (renderErr) {
      appendTurn('system', `CodeSec render error: ${renderErr.message}`);
    }

    if (mode !== 'sbom') {
      const total = (data.vulns?.length || 0) + (data.weaknesses?.length || 0) + (data.secrets?.length || 0);
      setStatus(total ? `${total} finding${total !== 1 ? 's' : ''}` : 'clean', total ? 'err' : 'ok');
    } else {
      setStatus('sbom ready', 'ok');
    }
  } catch (e) {
    const msg = e?.message || String(e);
    appendTurn('system', `CodeSec error: ${msg}`);
    setStatus('error', 'err');
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

el('codesec').addEventListener('click', () => { startNewSession('CodeSec'); runCodeSec('scan'); });
el('sbom').addEventListener('click',    () => { startNewSession('SBOM');    runCodeSec('sbom'); });
el('codesec-close').addEventListener('click', () => {
  el('codesec-panel').classList.remove('open');
});

// ── FortiCNAPP Compliance Report ──────────────────────────────────────────

el('compliance').addEventListener('click', async () => {
  const panel = el('compliance-panel');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  el('codesec-panel').classList.remove('open');
  if (!isOpen) { startNewSession('Compliance'); loadComplianceReports(); }
});

el('compliance-close').addEventListener('click', () => {
  el('compliance-panel').classList.remove('open');
});

async function loadComplianceReports() {
  const sel = el('comp-report');
  sel.innerHTML = '<option value="">Loading…</option>';
  sel.disabled = true;
  try {
    const res  = await fetch(BASE_URL + '/compliance/list');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const frameworks = data.frameworks || [];
    if (!frameworks.length) {
      sel.innerHTML = '<option value="">No frameworks found</option>';
      return;
    }
    // Group by cloud (first domain or "Other")
    const CLOUD_ORDER = ['AWS', 'AZURE', 'GCP', 'OCI', 'Kubernetes', 'Other'];
    const groups = {};
    CLOUD_ORDER.forEach(c => { groups[c] = []; });
    frameworks.forEach(f => {
      const clouds = f.clouds || [];
      const key = clouds.find(c => groups[c] !== undefined) || 'Other';
      groups[key].push(f);
    });
    sel.innerHTML = '';
    CLOUD_ORDER.forEach(cloud => {
      const items = groups[cloud];
      if (!items.length) return;
      const grp = document.createElement('optgroup');
      grp.label = cloud;
      items.forEach(f => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify({ guid: f.guid, name: f.name, clouds: f.clouds });
        opt.textContent = f.name;
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    });
    sel.disabled = false;
  } catch (e) {
    sel.innerHTML = `<option value="">Error: ${e.message}</option>`;
  }
}

async function runComplianceReport() {
  const btn      = el('comp-generate');
  const statusEl = el('comp-status');
  const raw      = el('comp-report').value;

  if (!raw) { statusEl.textContent = '✗ Select a framework first'; statusEl.className = 'err'; return; }

  let fw;
  try { fw = JSON.parse(raw); } catch { fw = { guid: raw, name: raw, clouds: [] }; }

  btn.disabled         = true;
  statusEl.textContent = 'generating…';
  statusEl.className   = '';
  setStatus('generating compliance PDF…', 'busy');

  try {
    const res = await fetch(BASE_URL + '/compliance', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ frameworkGuid: fw.guid, frameworkName: fw.name, clouds: fw.clouds }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('pdf') || ct.includes('octet-stream')) {
      const blob  = await res.blob();
      const url   = URL.createObjectURL(blob);
      const safe  = fw.name.replace(/[^a-z0-9]/gi, '_').slice(0, 50);
      const fname = `compliance-${safe}.pdf`;
      chrome.downloads
        ? chrome.downloads.download({ url, filename: fname })
        : chrome.tabs.create({ url });
      statusEl.textContent = '✓ PDF downloaded';
      statusEl.className   = 'ok';
      setStatus('PDF ready', 'ok');
      const msgEl  = appendTurn('system', `📋 Compliance PDF: ${fw.name}`);
      const askBtn = document.createElement('button');
      askBtn.className   = 'cs-sbom-btn';
      askBtn.textContent = '🔍 Ask about this PDF';
      askBtn.style.marginTop = '6px';
      askBtn.addEventListener('click', () => loadCompliancePdfText(fw.name));
      msgEl.appendChild(document.createElement('br'));
      msgEl.appendChild(askBtn);
    } else {
      const d = await res.json();
      throw new Error(d.error || 'No PDF returned');
    }
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
    setStatus('error', 'err');
    appendTurn('system', `Compliance error: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

el('comp-generate').addEventListener('click', runComplianceReport);

// ── CVE text-selection auto-fill ─────────────────────────────────────────────

function openCvePanel(cveId) {
  el('cve-input').value = cveId;
  ['codesec-panel', 'compliance-panel', 'lql-panel'].forEach(id =>
    el(id).classList.remove('open'));
  el('cve-panel').classList.add('open');
  runCveSearch();
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'CVE_SELECTED' && msg.cveId) openCvePanel(msg.cveId);
});

chrome.storage.session.get('pendingCve', ({ pendingCve }) => {
  if (!pendingCve) return;
  chrome.storage.session.remove('pendingCve');
  openCvePanel(pendingCve);
});

// ── FortiCNAPP CVE Attack Surface ────────────────────────────────────────────

let _lastCveData = null;

el('cve-btn').addEventListener('click', () => {
  const panel  = el('cve-panel');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  el('codesec-panel').classList.remove('open');
  el('compliance-panel').classList.remove('open');
  el('lql-panel').classList.remove('open');
  if (!isOpen) { startNewSession('Attack Surface'); el('cve-input').focus(); }
});

el('cve-close').addEventListener('click', () => el('cve-panel').classList.remove('open'));

el('cve-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') runCveSearch();
});

el('cve-search').addEventListener('click', runCveSearch);

el('cve-analyse').addEventListener('click', () => {
  if (!_lastCveData) return;
  el('cve-panel').classList.remove('open');
  const prompt = buildCveAnalysisPrompt(_lastCveData, _lastCveData.fgOutbreaks || []);
  history.push({ role: 'user', content: prompt });
  appendTurn('user', `Analyse attack surface for ${_lastCveData.cveId}`);
  send(true);
});

const EXEC_REPORT_TEMPLATE = `Write the full security report using the structure defined in your system prompt.`;

function buildCveAnalysisPrompt(d, fgOutbreaks) {
  const intel        = d.cveIntel || {};
  const fixVer       = d.hosts.find(h => h.fix_available)?.fixed_version || 'latest';
  const fgSearchUrl  = `https://www.fortiguard.com/search?q=${encodeURIComponent(d.cveId)}`;
  const nvdUrl       = `https://nvd.nist.gov/vuln/detail/${d.cveId}`;

  const lines = [
    `=== CVE THREAT INTELLIGENCE REPORT: ${d.cveId} ===`,
    ``,
  ];

  // ── Threat Radar ──────────────────────────────────────────────────────────
  if (intel.threatRadarScore !== undefined) {
    lines.push(`Threat Radar Score: ${intel.threatRadarScore}/100 (composite: CVSS + EPSS + KEV + FortiGuard)`);
  }

  // ── NVD CVSS ──────────────────────────────────────────────────────────────
  if (intel.nvd) {
    const n = intel.nvd;
    lines.push(``,`--- NVD / CVSS ---`);
    if (n.cvssV3Score)    lines.push(`  CVSSv3 Score:    ${n.cvssV3Score} (${n.cvssV3Severity})`);
    if (n.cvssV3Vector)   lines.push(`  CVSSv3 Vector:   ${n.cvssV3Vector}`);
    if (n.cvssV2Score)    lines.push(`  CVSSv2 Score:    ${n.cvssV2Score}`);
    if (n.description)    lines.push(`  Description:     ${n.description}`);
    if (n.published)      lines.push(`  Published:       ${n.published.slice(0,10)}`);
    lines.push(`  NVD URL:         ${nvdUrl}`);
  }

  // ── EPSS ──────────────────────────────────────────────────────────────────
  if (intel.epss) {
    const e = intel.epss;
    lines.push(``,`--- EPSS (Exploit Prediction Scoring System) ---`);
    lines.push(`  EPSS Score:      ${(e.score * 100).toFixed(2)}%  (probability of exploitation in next 30 days)`);
    lines.push(`  EPSS Percentile: ${(e.percentile * 100).toFixed(1)}th percentile among all CVEs`);
    if (e.date) lines.push(`  As of:           ${e.date}`);
  }

  // ── CISA KEV ──────────────────────────────────────────────────────────────
  if (intel.kev) {
    lines.push(``,`--- CISA Known Exploited Vulnerabilities (KEV) ---`);
    if (intel.kev.inKev) {
      lines.push(`  ⚠ IN CISA KEV — actively exploited in the wild`);
      if (intel.kev.product)     lines.push(`  Product:   ${intel.kev.vendorProject} ${intel.kev.product}`);
      if (intel.kev.dateAdded)   lines.push(`  Added:     ${intel.kev.dateAdded}`);
      if (intel.kev.dueDate)     lines.push(`  FCEB Due:  ${intel.kev.dueDate}`);
      if (intel.kev.description) lines.push(`  Details:   ${intel.kev.description}`);
    } else {
      lines.push(`  Not in CISA KEV catalog`);
    }
  }

  // ── FortiGuard ────────────────────────────────────────────────────────────
  lines.push(``,`--- FortiGuard Threat Intelligence ---`);
  lines.push(`  FortiGuard Search: ${fgSearchUrl}`);
  if (fgOutbreaks && fgOutbreaks.length) {
    fgOutbreaks.forEach(o => {
      lines.push(`  Outbreak: ${o.title}`);
      if (o.risk)    lines.push(`    Risk:      ${o.risk}`);
      if (o.pubDate) lines.push(`    Published: ${o.pubDate.slice(0, 10)}`);
      if (o.summary) lines.push(`    Summary:   ${o.summary}`);
      if (o.link)    lines.push(`    URL:       ${o.link}`);
    });
  } else {
    lines.push(`  No active FortiGuard outbreak alert for this CVE.`);
  }

  // ── FortiCNAPP Exposure ───────────────────────────────────────────────────
  lines.push(
    ``,`--- FortiCNAPP Exposure (last ${d.period_days} days) ---`,
    `  Total affected: ${d.total_affected} hosts`,
    `  Internet-exposed: ${d.internet_exposed}`,
    `  Fixable: ${d.fixable}`,
    ``,
  );
  d.hosts.forEach((h, i) => {
    const flags = [
      h.host_exposed      ? 'HOST-EXPOSED'      : '',
      h.container_exposed ? 'CONTAINER-EXPOSED' : '',
      h.fix_available     ? `fix→${h.fixed_version || fixVer}` : '',
    ].filter(Boolean).join(' ');
    lines.push(`${i + 1}. ${h.hostname} [${h.severity}] risk:${h.host_risk_score.toFixed(1)} ${flags}`);
    h.packages.forEach(p  => lines.push(`   pkg: ${p.name} ${p.version}`));
    h.containers.forEach(c => lines.push(`   ctr: ${c.name}${c.internet_exposed ? ' 🌐 INTERNET-EXPOSED' : ''}`));
  });

  lines.push(
    ``,
    `IMPORTANT REPORTING INSTRUCTIONS:`,
    `  1. Include a "Threat Radar" section combining CVSS + EPSS + KEV + FortiGuard score`,
    `  2. Include a "FortiGuard Threat Correlation" section — reference outbreak URLs, map MITRE TTPs`,
    `  3. Call out CISA KEV status prominently if inKev=true — this means active exploitation`,
    `  4. Use EPSS percentile to justify urgency: top 10th percentile = patch within 24h`,
    `  5. Include all reference links (FortiGuard, NVD) in the References section`,
    ``,
    EXEC_REPORT_TEMPLATE,
  );
  return lines.join('\n');
}

async function runCveSearch() {
  const cveId = el('cve-input').value.trim().toUpperCase();
  if (!cveId) return;

  const btn      = el('cve-search');
  const statusEl = el('cve-status');

  btn.disabled         = true;
  statusEl.textContent = 'searching…';
  statusEl.className   = '';
  _lastCveData         = null;
  setStatus(`CVE lookup: ${cveId}…`, 'busy');

  try {
    // Fetch CNAPP exposure + full CVE threat intel in parallel
    const [cnappRes, intelRes] = await Promise.all([
      fetch(BASE_URL + '/lql/cve', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cveId, days: Number(el('cve-days').value) }),
      }),
      fetch(BASE_URL + `/fortiguard/cve-intel?cveId=${encodeURIComponent(cveId)}`).catch(() => null),
    ]);

    const data  = await cnappRes.json();
    if (data.error) throw new Error(data.error);

    const intel       = intelRes?.ok ? await intelRes.json().catch(() => ({})) : {};
    const fgOutbreaks = intel.outbreaks || [];
    data.fgOutbreaks  = fgOutbreaks;
    data.cveIntel     = intel;
    _lastCveData      = data;

    // Close the drawer before posting results
    el('cve-panel').classList.remove('open');

    if (!data.hosts || !data.hosts.length) {
      const noResultEl = document.createElement('div');
      noResultEl.className = 'cve-summary';
      noResultEl.textContent = data.note || `No hosts found for ${cveId} in the selected window.`;
      const fgSearchNoResult = document.createElement('div');
      fgSearchNoResult.className = 'fg-search-link';
      fgSearchNoResult.innerHTML =
        `🔍 <a href="https://www.fortiguard.com/search?q=${encodeURIComponent(cveId)}" target="_blank">FortiGuard: ${cveId}</a>` +
        `&nbsp;&nbsp;|&nbsp;&nbsp;` +
        `<a href="https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveId)}" target="_blank">NVD: ${cveId}</a>`;
      noResultEl.appendChild(fgSearchNoResult);
      if (fgOutbreaks.length) {
        const fgLink = document.createElement('a');
        fgLink.href = fgOutbreaks[0].link || `https://www.fortiguard.com/outbreak-alert?type=vulnerability`;
        fgLink.target = '_blank';
        fgLink.textContent = `FortiGuard has ${fgOutbreaks.length} outbreak alert(s) for this CVE.`;
        fgLink.style.cssText = 'color:#cc0000;font-weight:600;display:block;margin-top:4px;';
        noResultEl.appendChild(fgLink);
      }
      appendResultCard('🔬', `CVE: ${cveId}`, noResultEl);
      setStatus('—');
      return;
    }

    const exp = data.internet_exposed;
    const fgBadge = fgOutbreaks.length ? `  |  ⚠ ${fgOutbreaks.length} FortiGuard outbreak alert(s)` : '';
    statusEl.textContent = `${data.total_affected} hosts  |  ${exp} internet-exposed  |  ${data.fixable} fixable${fgBadge}`;
    statusEl.className   = exp ? 'err' : 'ok';
    setStatus(`${cveId}: ${data.total_affected} hosts (${exp} exposed)${fgOutbreaks.length ? ' ⚠ FortiGuard alert' : ''}`, exp ? 'err' : 'ok');

    // Build detached results and post as a card
    const resultsEl = document.createElement('div');
    resultsEl.className = 'cve-result-body';
    renderCveResults(data, resultsEl);

    // Threat Radar + intel badges
    const intel = data.cveIntel || {};
    const intelEl = document.createElement('div');
    intelEl.className = 'fg-outbreak-card';

    let intelHtml = '';

    // Threat Radar Score
    if (intel.threatRadarScore !== undefined) {
      const score = intel.threatRadarScore;
      const col = score >= 70 ? '#cc0000' : score >= 40 ? '#e65c00' : '#4caf50';
      intelHtml += `<div style="margin-bottom:6px"><strong>🎯 Threat Radar Score: <span style="color:${col}">${score}/100</span></strong></div>`;
    }

    // Badges row: CVSS | EPSS | KEV
    const badges = [];
    if (intel.nvd?.cvssV3Score) {
      const sev = intel.nvd.cvssV3Severity || '';
      const c = sev === 'CRITICAL' ? '#cc0000' : sev === 'HIGH' ? '#e65c00' : sev === 'MEDIUM' ? '#f5a623' : '#4caf50';
      badges.push(`<span class="fg-risk" style="background:${c};color:#fff">CVSSv3 ${intel.nvd.cvssV3Score} ${sev}</span>`);
    }
    if (intel.epss?.score !== undefined) {
      const pct = (intel.epss.score * 100).toFixed(1);
      const c = intel.epss.score > 0.5 ? '#cc0000' : intel.epss.score > 0.1 ? '#e65c00' : '#555';
      badges.push(`<span class="fg-risk" style="background:${c};color:#fff">EPSS ${pct}%</span>`);
    }
    if (intel.kev?.inKev) {
      badges.push(`<span class="fg-risk" style="background:#cc0000;color:#fff">⚠ CISA KEV</span>`);
    }
    if (badges.length) intelHtml += `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">${badges.join('')}</div>`;

    // NVD description
    if (intel.nvd?.description) {
      intelHtml += `<div style="font-size:10.5px;color:#333;margin-bottom:4px">${intel.nvd.description.slice(0,200)}…</div>`;
    }

    // FortiGuard + NVD links
    intelHtml +=
      `<div class="fg-search-link" style="margin-top:4px">` +
      `🔍 <a href="https://www.fortiguard.com/search?q=${encodeURIComponent(cveId)}" target="_blank">FortiGuard</a>` +
      `&nbsp;|&nbsp;<a href="https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveId)}" target="_blank">NVD</a>` +
      (intel.kev?.inKev ? `&nbsp;|&nbsp;<a href="https://www.cisa.gov/known-exploited-vulnerabilities-catalog" target="_blank">CISA KEV</a>` : '') +
      `</div>`;

    intelEl.innerHTML = intelHtml;
    resultsEl.appendChild(intelEl);

    // Append FortiGuard outbreak alert cards
    if (fgOutbreaks.length) {
      const fgEl = document.createElement('div');
      fgEl.className = 'fg-outbreak-card';
      fgEl.innerHTML = `<strong>⚠ FortiGuard Outbreak Alert${fgOutbreaks.length > 1 ? 's' : ''}</strong>` +
        fgOutbreaks.map(o =>
          `<div class="fg-outbreak-item">
            <a href="${o.link}" target="_blank">${o.title}</a>
            ${o.risk ? `<span class="fg-risk fg-risk-${o.risk.toLowerCase()}">${o.risk}</span>` : ''}
            ${o.pubDate ? `<span class="fg-date">${o.pubDate.slice(0,10)}</span>` : ''}
          </div>`
        ).join('');
      resultsEl.appendChild(fgEl);
    }

    appendResultCard('🔬', `CVE: ${cveId} — ${data.total_affected} hosts (${exp} exposed)`, resultsEl);

    // Auto-trigger executive analysis with combined CNAPP + FortiGuard context
    const prompt = buildCveAnalysisPrompt(data, fgOutbreaks);
    history.push({ role: 'user', content: prompt });
    appendTurn('user', `Analyse attack surface for ${cveId}`);
    send(true);
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
    setStatus('CVE error', 'err');
    const errEl = document.createElement('div');
    errEl.className = 'cve-summary';
    errEl.style.color = 'var(--err)';
    errEl.textContent = e.message;
    appendResultCard('🔬', `CVE: ${cveId} — error`, errEl);
  } finally {
    btn.disabled = false;
  }
}

function renderCveResults(data, resultsEl) {
  resultsEl.innerHTML = '';

  const summary = document.createElement('div');
  summary.className   = 'cve-summary';
  summary.textContent = `${data.cveId} — ${data.total_affected} affected hosts over ${data.period_days} days`;
  resultsEl.appendChild(summary);

  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  data.hosts.forEach(h => {
    const hostExposed = h.host_exposed || h.container_exposed;
    const card = document.createElement('div');
    card.className = `cve-host${hostExposed ? ' exposed' : ''}`;

    // Header row
    const hdr = document.createElement('div');
    hdr.className = 'cve-host-header';

    const name = document.createElement('span');
    name.className   = 'cve-host-name';
    name.textContent = h.hostname;
    name.title       = 'Click to copy';
    name.style.cursor = 'pointer';
    name.addEventListener('click', () => {
      navigator.clipboard.writeText(h.hostname).then(() => {
        const orig = name.textContent;
        name.textContent = '✓ copied';
        name.style.color = 'var(--ok)';
        setTimeout(() => { name.textContent = orig; name.style.color = ''; }, 1200);
      });
    });
    hdr.appendChild(name);

    if (h.host_exposed) {
      const b = document.createElement('span');
      b.className = 'cve-badge internet';
      b.textContent = '🌐 host exposed';
      hdr.appendChild(b);
    }
    if (h.container_exposed) {
      const b = document.createElement('span');
      b.className = 'cve-badge container';
      b.textContent = '📦 container exposed';
      hdr.appendChild(b);
    }
    const sevBadge = document.createElement('span');
    sevBadge.className = `cve-badge ${(h.severity || '').toLowerCase()}`;
    sevBadge.textContent = h.severity;
    hdr.appendChild(sevBadge);

    const risk = document.createElement('span');
    risk.className   = 'cve-risk';
    risk.textContent = `risk ${h.host_risk_score.toFixed(1)}`;
    hdr.appendChild(risk);
    card.appendChild(hdr);

    // Body
    const body = document.createElement('div');
    body.className = 'cve-host-body';

    const addRow = (label, val, cls = '') => {
      if (!val) return;
      const row = document.createElement('div');
      row.className = 'cve-row';
      row.innerHTML =
        `<span class="cve-label">${esc(label)}</span>` +
        `<span class="cve-val${cls ? ' ' + cls : ''}">${esc(val)}</span>`;
      body.appendChild(row);
    };

    addRow('account',  h.account);
    addRow('region',   h.region);
    const pkgStr = h.packages.map(p => `${p.name} ${p.version}`.trim()).join(', ');
    addRow('packages', pkgStr);
    if (h.fix_available) addRow('fix →', h.fixed_version || 'available', 'fix');

    // Containers
    if (h.containers.length) {
      const cSection = document.createElement('div');
      cSection.className = 'cve-containers';
      h.containers.forEach(c => {
        const row = document.createElement('div');
        row.className = 'cve-row';
        row.innerHTML =
          `<span class="cve-label">container</span>` +
          `<span class="cve-val">${esc(c.name)}` +
          (c.image ? ` <span style="color:var(--dim)">(${esc(c.image)})</span>` : '') +
          (c.internet_exposed ? ' <span class="cve-badge internet" style="margin-left:4px">🌐</span>' : '') +
          `</span>`;
        cSection.appendChild(row);
      });
      body.appendChild(cSection);
    }

    card.appendChild(body);
    resultsEl.appendChild(card);
  });

}

// ── FortiCNAPP LQL ───────────────────────────────────────────────────────────

let _lqlQueries = [];

el('lql').addEventListener('click', async () => {
  const panel  = el('lql-panel');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  el('codesec-panel').classList.remove('open');
  el('compliance-panel').classList.remove('open');
  if (!isOpen) { startNewSession('Advanced Analytics'); loadLqlQueries(); }
});

el('lql-close').addEventListener('click', () => {
  el('lql-panel').classList.remove('open');
});

async function loadLqlQueries() {
  const sel = el('lql-select');
  sel.innerHTML = '<option value="">Loading…</option>';
  sel.disabled  = true;
  const statusEl = el('lql-status');
  statusEl.textContent = '';
  statusEl.className   = '';
  try {
    const res  = await fetch(BASE_URL + '/lql/queries');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    _lqlQueries = data.queries || [];
    if (!_lqlQueries.length) {
      sel.innerHTML = '<option value="">No saved queries found</option>';
      return;
    }
    sel.innerHTML = '<option value="">— select a query —</option>';
    _lqlQueries.forEach((q, i) => {
      const opt   = document.createElement('option');
      opt.value   = String(i);
      opt.textContent = q.id;
      sel.appendChild(opt);
    });
    sel.disabled = false;
  } catch (e) {
    sel.innerHTML = `<option value="">Error: ${e.message}</option>`;
  }
}

el('lql-run').addEventListener('click', async () => {
  const idx = el('lql-select').value;
  if (idx === '') return;
  const query     = _lqlQueries[Number(idx)];
  const btn       = el('lql-run');
  const statusEl  = el('lql-status');
  const _oldResultsEl = el('lql-results');

  btn.disabled            = true;
  statusEl.textContent    = 'running…';
  statusEl.className      = '';
  _oldResultsEl.innerHTML = '';
  setStatus('running LQL…', 'busy');

  try {
    const res = await fetch(BASE_URL + '/lql/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ queryText: query.queryText }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const rows  = data.rows || [];
    const count = data.count ?? rows.length;
    const total = data.total ?? count;

    statusEl.textContent = total > count
      ? `${count} rows shown (${total} total)`
      : `${count} row${count !== 1 ? 's' : ''}`;
    statusEl.className = count ? 'ok' : '';
    setStatus(`LQL: ${count} rows`, 'ok');

    el('lql-panel').classList.remove('open');
    const resultsEl = document.createElement('div');
    resultsEl.className = 'lql-result-body';

    if (!rows.length) {
      resultsEl.innerHTML = '<div class="lql-row-note" style="padding:8px 2px">No results.</div>';
      appendResultCard('📊', `LQL: ${query.id}`, resultsEl);
      return;
    }

    renderLqlTable(resultsEl, rows, total, query.id);
    appendResultCard('📊', `LQL: ${query.id} — ${statusEl.textContent}`, resultsEl);

    // Plain-text summary for AI context
    const keys   = Object.keys(rows[0]);
    const sample = rows.slice(0, 50).map(r => keys.map(k => `${k}=${r[k] ?? ''}`).join(' | ')).join('\n');
    history.push({
      role: 'user',
      content: `Security finding data from LQL query "${query.id}" — ${count} rows:\n\n${sample}\n\n${EXEC_REPORT_TEMPLATE}`,
    });
    send(true); // auto-triggers executive analysis; user turn already pushed above
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
    setStatus('LQL error', 'err');
    _oldResultsEl.innerHTML = `<pre style="color:var(--err)">${e.message}</pre>`;
  } finally {
    btn.disabled = false;
  }
});

// ── LQL tab switching ─────────────────────────────────────────────────────────

document.querySelectorAll('.lql-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.lql-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.lql-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    el('lql-pane-' + tab.dataset.tab).classList.add('active');
  });
});

// ── LQL Generate ─────────────────────────────────────────────────────────────

let _genQueryText = '';

el('lql-gen-btn').addEventListener('click', async () => {
  const objective = el('lql-objective').value.trim();
  if (!objective) return;

  const btn      = el('lql-gen-btn');
  const statusEl = el('lql-gen-status');

  btn.disabled         = true;
  statusEl.textContent = 'running…';
  statusEl.className   = '';
  _genQueryText        = '';
  el('lql-gen-results').innerHTML = '';

  try {
    const genRes = await fetch(BASE_URL + '/lql/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ objective }),
    });
    const data = await genRes.json();
    if (data.error) throw new Error(data.error);

    if (data.queryId === 'USE_CVE_TAB') {
      statusEl.textContent = '⚠ Use CVE tab';
      statusEl.className   = 'err';
      el('lql-gen-results').innerHTML = `<div class="lql-row-note" style="padding:8px 2px;color:var(--dim)">${data.note || ''}</div>`;
      return;
    }

    _genQueryText = data.queryText || '';

    // Use pre-run cached rows from generate, or fall back to a separate /lql/run call
    let runData;
    if (data.rows !== undefined) {
      runData = data; // serve.py already ran and cached results
    } else {
      statusEl.textContent = 'running…';
      setStatus('running LQL…', 'busy');
      const runRes = await fetch(BASE_URL + '/lql/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ queryText: _genQueryText }),
      });
      runData = await runRes.json();
      if (runData.error) throw new Error(runData.error);
    }

    const rows  = runData.rows || [];
    const count = runData.count ?? rows.length;
    const total = runData.total ?? count;
    const label = objective;

    statusEl.textContent = total > count
      ? `${count} rows (${total} total)`
      : `${count} row${count !== 1 ? 's' : ''}`;
    statusEl.className = count ? 'ok' : '';
    setStatus(`LQL: ${count} rows`, 'ok');

    el('lql-panel').classList.remove('open');
    const resultsEl = document.createElement('div');
    resultsEl.className = 'lql-result-body';

    if (!rows.length) {
      resultsEl.innerHTML = '<div class="lql-row-note" style="padding:8px 2px">No results.</div>';
      appendResultCard('📊', `LQL: ${label}`, resultsEl);
      return;
    }

    renderLqlTable(resultsEl, rows, total, label);
    appendResultCard('📊', `LQL: ${label} — ${statusEl.textContent}`, resultsEl);

    const keys   = Object.keys(rows[0]);
    const sample = rows.slice(0, 50).map(r => keys.map(k => `${k}=${r[k] ?? ''}`).join(' | ')).join('\n');
    history.push({
      role: 'user',
      content: `Security finding data from LQL query "${label}" — ${count} rows:\n\n${sample}\n\n${EXEC_REPORT_TEMPLATE}`,
    });
    send(true);
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
    setStatus('LQL error', 'err');
    appendTurn('system', `LQL error: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ── LQL table renderer ───────────────────────────────────────────────────────
function renderLqlTable(containerEl, rows, totalRows, queryLabel) {
  containerEl.innerHTML = '';

  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const URL_RE = /^https?:\/\/\S+$/;

  const keys = Object.keys(rows[0]);
  const displayed = rows.slice(0, 200);

  // Export bar
  const bar = document.createElement('div');
  bar.className = 'lql-export-bar';

  const note = document.createElement('span');
  note.className = 'lql-row-note';
  note.textContent = totalRows > displayed.length
    ? `${displayed.length} of ${totalRows} rows`
    : `${rows.length} row${rows.length !== 1 ? 's' : ''}`;
  bar.appendChild(note);

  const csvBtn = document.createElement('button');
  csvBtn.className = 'lql-export-btn';
  csvBtn.textContent = '⬇ CSV';
  csvBtn.addEventListener('click', () => {
    const lines = [keys.join(',')];
    rows.forEach(r => lines.push(keys.map(k => {
      const v = String(r[k] ?? '');
      return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g,'""')}"` : v;
    }).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${queryLabel || 'lql'}.csv`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  });
  bar.appendChild(csvBtn);
  containerEl.appendChild(bar);

  // Table
  const wrap  = document.createElement('div');
  wrap.className = 'lql-table-wrap';
  const table = document.createElement('table');
  table.className = 'lql-table';

  // Header
  const thead = document.createElement('thead');
  const hrow  = document.createElement('tr');
  keys.forEach(k => {
    const th = document.createElement('th');
    th.textContent = k;
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  displayed.forEach(r => {
    const tr = document.createElement('tr');
    keys.forEach(k => {
      const td  = document.createElement('td');
      const val = String(r[k] ?? '');
      if (URL_RE.test(val)) {
        const a = document.createElement('a');
        a.className = 'lql-link';
        a.href = val; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = val;
        td.appendChild(a);
      } else {
        td.textContent = val;
      }
      td.title = val; // full value on hover
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  containerEl.appendChild(wrap);

  if (rows.length > 200) {
    const more = document.createElement('div');
    more.className = 'lql-row-note';
    more.style.padding = '5px 2px';
    more.textContent = `… ${rows.length - 200} more rows not shown`;
    containerEl.appendChild(more);
  }
}

// ── enter key on objective input triggers build ────────────────────────────
el('lql-objective').addEventListener('keydown', e => {
  if (e.key === 'Enter') el('lql-gen-btn').click();
});

async function loadCompliancePdfText(reportName) {
  appendTurn('system', `📖 Loading "${reportName}" into context…`);
  try {
    const res  = await fetch(BASE_URL + '/compliance/latest-text');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (data.text) {
      const MAX = 40000;
      const text = data.text.length > MAX
        ? data.text.slice(0, MAX) + `\n\n[Truncated — ${data.text.length} chars total]`
        : data.text;
      history.push({ role: 'user', content: `Here is the content of the compliance report "${data.name}":\n\n${text}\n\nAsk me anything about this report.` });
      appendTurn('system', `✓ "${data.name}" loaded — ask your questions below.`);
    } else if (data.note) {
      appendTurn('system', `⚠ ${data.note} — PDF text extraction not available.`);
    }
  } catch (e) {
    appendTurn('system', `PDF load error: ${e.message}`);
  }
}
