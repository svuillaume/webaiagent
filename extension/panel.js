'use strict';

// ── Constants ─────────────────────────────────────────────────────────────
const BASE_URL       = 'http://localhost:45321';
const MAX_TOKENS     = 4096;
const PAGE_MAX_CHARS = 12000;
const SYSTEM_PROMPT = `You are a security engineer. For security findings, answer in plain Markdown — no exec-summary prose, no filler, no walls of text.

## Structure
If the user's message includes an explicit report template, follow that EXACTLY instead of the structure below — it takes precedence. Otherwise, default to:
1. **Objective** — one line: what was investigated or the question being answered.
2. **Findings** — a standard Markdown table (pipe syntax) listing every matched resource, one row each. If there are zero matches, say so in one line instead of an empty table.
3. **Fix** — only if remediation applies: a short numbered list, one line each, exact command/console step in a fenced code block. Omit entirely for pure inventory/lookup questions.

## Components

Table — use for ANY list of 2+ resources (instances, buckets, roles, findings, etc.). Real Markdown pipe-table syntax, not HTML. Pick columns that fit the data:
| Resource | Type | Region/Account | Detail |
|---|---|---|---|
| i-0abc123 | EC2 | us-east-1 · 123456789012 | <span class="rpt-badge high">HIGH</span> public IP, no IMDSv2 |

Severity badge (inline, sparingly — flag a critical/high row inside a table cell, not decoration): <span class="rpt-badge critical">CRITICAL</span> <span class="rpt-badge high">HIGH</span> — this is the ONLY raw HTML allowed; everything else must be plain Markdown.

## Rules
- Prefer the table over prose or cards for any resource list — more compact, easier to scan.
- No metric-strip cards, no per-resource cards, no colored callout boxes — this is an engineering report, not an exec deck.
- Fix section: exact commands only, skip the "why" paragraphs.
- For non-security questions, skip this structure and answer directly.`;
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
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

// Cloud Investigation is a multi-turn native tool-calling loop — it needs the model to return
// proper tool_use blocks on every turn. Non-Claude models routed through this gateway (confirmed
// with deepseek-v4-pro) can instead leak their own tool-call markup as literal text, which then
// shows up as a garbled, irrelevant-looking "final answer" with no indication anything went
// wrong. serve.py rejects this server-side too — this just fails visibly before the user tries.
function updateInvestigateAvailability() {
  const isClaude = el('model').value.startsWith('claude');
  const tip = isClaude ? '' :
    'Cloud Investigation requires a Claude model — switch models in Admin → LLM Model to enable it.';
  const tab = document.querySelector('.lql-tab[data-tab="investigate"]');
  if (tab) {
    tab.classList.toggle('lw-disabled', !isClaude);
    tab.title = tip;
  }
  el('investigate-btn').disabled    = !isClaude;
  el('investigate-btn').title       = tip;
  el('investigate-prompt').disabled = !isClaude;
  el('investigate-prompt').title    = tip;
}

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
  updateInvestigateAvailability();
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
  } catch { /* offline */ }

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
  if (cfg.gateway_url || cfg.api_key) {
    const gw = el('gateway').value || 'bifrost';
    setStatus(gw === 'bifrost' ? 'Bifrost Status OK' : 'config loaded', 'ok');
  }

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
    } catch { /* offline */ }
  }

  const name = firstName ? `, ${firstName.charAt(0).toUpperCase() + firstName.slice(1)}` : '';
  appendTurn('ai', `**${greeting()}${name}!** 👋 I'm **FortiAIScout** — think of me as a security engineer sitting next to you while you browse. Whatever you're looking at, I'm happy to dig in with you.

And if you're a **FortiCNAPP** customer, I can plug directly into your environment — compliance reports, CVE lookups, LQL queries, and full cloud posture investigation, all from right here.

Here's what I can help with:

• 🌐 **Translate** — select text on the page, translate it to English · **TL;DR** — get a quick plain-English page summary · [example](https://github.com/svuillaume/webaiagent#what-does-it-do)
• 🖱 **Select text → right-click → "Ask AI about selection"** — works on any page, even PDFs · [example](https://github.com/svuillaume/webaiagent#what-does-it-do)
• 🛡 **Scan Code** — SCA + SAST on code from this page or a GitHub repo · [example](https://github.com/svuillaume/webaiagent#features)
  - SAST: Go · Java · JavaScript · PHP · Python · TypeScript
  - SCA: .NET · C/C++ · Go · Java · Node.js · PHP · Python · Ruby · Rust
• 🔰 **FortiCNAPP** — Compliance, Risk Hunting, and Attack Surface analysis (Scan Code lives in this menu too) · [walkthrough](https://github.com/svuillaume/webaiagent#end-to-end-workflow)
• ⚙ **Admin** — swap AI gateway, model, or the TokenSaving compression proxy any time · [details](https://github.com/svuillaume/webaiagent#environment-variables-env)

Ask me anything, or pick a tool above to get started.`);
}
showGreeting();

const saveSession = (key, input) => {
  const v = input.value.trim();
  v ? chrome.storage.session.set({ [key]: v }) : chrome.storage.session.remove(key);
};

urlInput.addEventListener('change',  () => saveSession('bf_url',  urlInput));
keyInput.addEventListener('change',  () => saveSession('bf_key',  keyInput));
key2Input.addEventListener('change', () => saveSession('bf_key2', key2Input));
el('model').addEventListener('change', () => {
  const model = el('model').value;
  chrome.storage.local.set({ bf_model: model });
  updateInvestigateAvailability();
  // Persist to .env's ANTHROPIC_DEFAULT_MODEL so server-side calls (/lql/generate) stay in
  // sync with whatever model the user is chatting with — best-effort, non-blocking.
  fetch(BASE_URL + '/model', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model }),
  }).catch(() => { /* offline — local chat still uses the picked model regardless */ });
});

// ── Markdown renderer ─────────────────────────────────────────────────────
// Escape before transform so model output cannot inject HTML.
// Radar/spider chart for a small set of 0-100 risk axes (e.g. CVE Critical Context).
// Pure SVG, no deps — geometry computed here rather than trusting the model to hand-draw it.
function renderRadarChart(axes, values, title) {
  const n = axes.length;
  // Wider-than-tall viewBox: axis labels overflow horizontally at the left/right extremes far
  // more than vertically, so a square box was clipping longer labels (e.g. "Privileges Required").
  const w = 320, h = 260, cx = w / 2, cy = h / 2 + 2, R = 74;
  const pt = (r, i) => {
    const a = (-90 + i * 360 / n) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const rings = [0.25, 0.5, 0.75, 1].map(f =>
    `<polygon points="${Array.from({length:n},(_,i)=>pt(R*f,i).join(',')).join(' ')}" fill="none" stroke="#e5e8ee" stroke-width="1"/>`
  ).join('');
  const axisLines = Array.from({length:n},(_,i) => {
    const [x,y] = pt(R,i);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#d0d5dd" stroke-width="1"/>`;
  }).join('');
  const dataPoly = Array.from({length:n},(_,i) => {
    const v = Math.max(0, Math.min(100, Number(values[i]) || 0)) / 100;
    const [x,y] = pt(R,i);
    return [cx + (x-cx)*v, cy + (y-cy)*v].join(',');
  }).join(' ');
  // Wrap multi-word labels onto two lines — halves the horizontal extent of the longest labels,
  // which is what was actually causing the clipping (a wider viewBox alone isn't enough for a
  // label like "Privileges Required" sitting at the exact left/right extreme of the chart).
  const wrapLabel = name => {
    const words = name.split(' ');
    if (words.length < 2) return [name];
    const mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
  };
  const labels = Array.from({length:n},(_,i) => {
    const [lx,ly] = pt(R + 26, i);
    const anchor = lx < cx - 4 ? 'end' : lx > cx + 4 ? 'start' : 'middle';
    const lines = wrapLabel(axes[i]);
    const nameLines = lines.map((line, li) =>
      `<tspan x="${lx.toFixed(1)}" dy="${li === 0 ? 0 : 11}">${esc(line)}</tspan>`
    ).join('');
    const valueY = ly + lines.length * 11 + 2;
    return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="9.5" font-weight="600" fill="#444" text-anchor="${anchor}" dominant-baseline="middle">${nameLines}</text>`
         + `<text x="${lx.toFixed(1)}" y="${valueY.toFixed(1)}" font-size="9" fill="#999" text-anchor="${anchor}">${Math.round(values[i])}%</text>`;
  }).join('');
  return `<div class="rpt-radar">${title ? `<div class="rpt-radar-title">${esc(title)}</div>` : ''}`
       + `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:340px;display:block;margin:0 auto">`
       + `${rings}${axisLines}<polygon points="${dataPoly}" fill="rgba(204,0,0,.14)" stroke="#cc0000" stroke-width="1.6"/>${labels}</svg></div>`;
}

function renderMarkdown(text) {
  const link = (href, label) => {
    const url = /^https?:\/\//i.test(href) ? href : `https://${href}`;
    return `<a class="ext-link" data-href="${url}">${label}</a>`;
  };
  const inline = s => {
    // Whitelisted pass-through: a severity badge is the one raw HTML tag the model may emit
    // inline (e.g. inside a markdown table cell). esc() has already turned it into literal
    // "&lt;span...&gt;" text by this point — un-escape only this exact safe pattern.
    s = s.replace(/&lt;span class="rpt-badge (critical|high|medium|low)"&gt;([^&]*?)&lt;\/span&gt;/g,
                  '<span class="rpt-badge $1">$2</span>');
    s = s.replace(/`([^`\n]+)`/g,          '<code>$1</code>');
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g,  '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g,      '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g,        '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, l, h) => link(h, l));
    s = s.replace(/(?<!data-href=")(https?:\/\/[^\s<>"]+)/g, u => link(u, u));
    s = s.replace(/(?<![/"'>])(www\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s<>"]*)/, u => link(u, u));
    return s;
  };

  // Extract rpt-* HTML blocks (which contain nested divs) before splitting on code fences.
  // Strategy: stash each top-level <div class="rpt-*">…</div> as a placeholder, run the
  // markdown pipeline on the remainder, then reinsert raw HTML at the end.
  const rptStash = [];
  const withPlaceholders = text.replace(/<div class="rpt-[\s\S]*?(?=\n<div class="rpt-|\n##\s|\n---|\n```|$)/g, match => {
    // Balance the outer div: count open/close tags to find the real end
    let depth = 0, end = 0;
    for (let i = 0; i < match.length; i++) {
      if (match[i] === '<') {
        if (match.startsWith('</div', i))        { depth--; if (depth === 0) { end = i + 6; break; } }
        else if (match.startsWith('<div', i))    depth++;
      }
    }
    const block = end > 0 ? match.slice(0, end) : match;
    const idx = rptStash.push(block) - 1;
    return `\x00rpt${idx}\x00`;
  });

  // Split on fenced code blocks first
  const parts = withPlaceholders.split(/(```[\s\S]*?```)/g);
  const html = parts.map((part, i) => {
    if (i % 2 === 1) {
      const lang = (part.match(/^```(\w+)/) || [])[1] || '';
      const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
      if (lang === 'radar') {
        try {
          const data = JSON.parse(code.trim());
          if (Array.isArray(data.axes) && Array.isArray(data.values) &&
              data.axes.length === data.values.length && data.axes.length >= 3) {
            return renderRadarChart(data.axes, data.values, data.title);
          }
        } catch (_) { /* malformed — fall through to a plain code block */ }
      }
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
      out.push(`<table class="rpt-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`);
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
  // Reinsert rpt-* HTML blocks, replacing placeholders with raw HTML
  return html.join('').replace(/\x00rpt(\d+)\x00/g, (_, idx) => rptStash[+idx] || '');
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

    // Deep-clone and strip panel-specific classes — replace with print-safe inline styles
    const clone = sourceEl.cloneNode(true);

    // Remap known classes to inline styles so the print window is self-contained
    const styleMap = {
      'md-h':         'font-family:Arial,sans-serif;font-weight:700;color:#9063cd;margin:16px 0 5px;padding-bottom:3px;border-bottom:1px solid #ccc;',
      'fg-outbreak-card': 'margin:8px 0;padding:7px 10px;border:1px solid #cc0000;border-left:3px solid #cc0000;border-radius:4px;background:#fff5f5;font-size:12px;',
      'fg-search-link':   'margin-top:6px;font-size:11px;',
      'fg-outbreak-item': 'margin:3px 0;',
      'fg-risk':          'font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px;background:#555;color:#fff;margin-right:4px;',
      'fg-risk-critical': 'background:#cc0000;color:#fff;',
      'fg-risk-high':     'background:#e65c00;color:#fff;',
      'fg-risk-medium':   'background:#f5a623;color:#000;',
      'fg-risk-low':      'background:#4caf50;color:#fff;',
      'fg-date':          'color:#888;font-size:10px;margin-left:auto;',
      'cve-summary':      'margin:6px 0;font-size:12px;',
      // Report visual components — minimal: table + inline badge only
      'rpt-table':         'width:100%;border-collapse:collapse;margin:8px 0;font-size:11px;',
      'rpt-badge':         'display:inline-block;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.3px;border:1px solid #999;color:#333;',
      'rpt-section':       'margin:10px 0;padding:8px 10px;background:#fafafa;border:1px solid #ddd;border-left:3px solid #888;border-radius:0 6px 6px 0;font-size:11.5px;color:#111;',
      'rpt-divider':       'display:flex;align-items:center;gap:8px;margin:10px 0 6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#888;',
      'rpt-radar':         'margin:8px 0;padding:8px 6px 4px;background:#fff;border:1px solid #d0d5dd;border-radius:4px;',
      'rpt-radar-title':   'font-size:10px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.4px;text-align:center;margin-bottom:2px;',
    };
    clone.querySelectorAll('*').forEach(el => {
      el.classList.forEach(cls => {
        if (styleMap[cls]) el.style.cssText += styleMap[cls];
      });
      // Muted severity accent — only critical/high get a colour cue, rest stay neutral
      const sevColours = { critical: '#cc0000', high: '#e65c00' };
      for (const [sev, col] of Object.entries(sevColours)) {
        if (el.classList.contains(sev) && el.classList.contains('rpt-badge')) {
          el.style.cssText += `background:${col};color:#fff;border-color:${col};`;
        }
      }
      el.removeAttribute('class');
    });

    const win = window.open('', '_blank');
    if (!win) return;

    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>FortiAIScout — Security Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 13px; color: #111; max-width: 860px; margin: 40px auto; padding: 0 24px; line-height: 1.6; }
  h2, h3, h4 { font-family: Arial, sans-serif; font-weight: 700; color: #9063cd; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #ddd; }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0 6px 20px; padding: 0; }
  li { margin: 3px 0; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12px; }
  th { background: #9063cd; color: #fff; padding: 6px 10px; text-align: left; border: 1px solid #aaa; }
  td { padding: 5px 10px; border: 1px solid #ccc; vertical-align: top; }
  tr:nth-child(even) td { background: #f6f2fb; }
  pre { background: #f4f4f4; border: 1px solid #ddd; border-left: 3px solid #9063cd; padding: 10px 12px; border-radius: 4px; font-size: 11.5px; white-space: pre-wrap; word-break: break-all; overflow: visible; }
  code { background: #f0f0f0; border: 1px solid #ddd; padding: 1px 4px; border-radius: 3px; font-size: 11.5px; }
  blockquote { border-left: 3px solid #cc0000; margin: 8px 0; padding: 4px 12px; color: #555; background: #fff5f5; }
  hr { border: none; border-top: 1px solid #ccc; margin: 16px 0; }
  a { color: #9063cd; word-break: break-all; }
  strong { color: #111; }
  @media print {
    body { margin: 16px; font-size: 11px; }
    pre  { font-size: 10px; }
    table, pre, blockquote { page-break-inside: avoid; }
  }
</style>
</head><body>
${clone.innerHTML}
<hr style="margin-top:40px">
<p style="color:#888;font-size:11px">Generated by FortiAIScout &mdash; ${new Date().toLocaleString()}</p>
</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 500);
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
    textContent: role === 'user' ? 'You' : 'FortiAIScout',
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
    const lblClone    = Object.assign(document.createElement('div'), { className: 'turn-label', textContent: 'FortiAIScout' });
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

async function readSelectedText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func:   () => ({
      title: document.title,
      url:   location.href,
      text:  (window.getSelection()?.toString() || '').trim(),
    }),
  });
  return result;
}

const pageCtx = page => `[Page context]\nTitle: ${page.title}\nURL: ${page.url}\n\n${page.text}`;

// Shared wrapper for page-button actions: disables btn, restores on finish.
// `reader` defaults to reading the whole page; pass readSelectedText for
// actions that only need the current text selection.
async function withPage(btnId, fn, reader = readCurrentPage) {
  const btn = el(btnId);
  btn.disabled = true;
  setStatus('reading page…', 'busy');
  try {
    await fn(await reader());
  } catch (e) {
    appendTurn('system', `Could not read page: ${e.message}`);
    setStatus('error', 'err');
  } finally {
    btn.disabled = false;
  }
}

el('fcnapp-community').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://community.fortinet.com/forticnapp-63' });
});

// ── TokenSaving: single combined badge (routing + savings) + dashboard link ─────
// One merged element instead of two separate badges — was crowding the config bar. Runs
// independently of autoFillFromConfig()'s url/key cache gate — the whole point is to surface the
// current /config value even when a stale chrome.storage.session value is what the extension is
// actually using (see: the Headroom docker-internal-hostname bug). Clicking the badge toggles
// routing via serve.py's /headroom/toggle, which persists to .env and always hands back a
// browser-reachable gateway_url (never the Docker-internal address).
(function initTokenSaving() {
  const badge = el('routing-badge');
  const dashboardBtn = el('dashboard-token');
  const dot = el('routing-dot'); // small at-a-glance indicator on the Admin button itself,
                                  // since the routing badge now lives inside a closed menu
  if (!badge) return;

  let viaHeadroom        = false;
  let headroomConfigured = false;
  let busyToggling       = false;
  let dashboardUrl       = null;
  let savingsPct         = null;
  let savingsDetail      = ''; // e.g. "— 370.6K tokens saved lifetime over 52 requests."

  const fmtTokens = n =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` :
    n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

  // Single source of truth for badge text/title — refreshSavings() must never mutate
  // badge.title directly, or the next render() call (from either refresh function) silently
  // discards it, since render() always does a full overwrite, not an append.
  function render() {
    const pctSuffix = viaHeadroom && typeof savingsPct === 'number' ? ` · ${savingsPct}%` : '';
    if (viaHeadroom) {
      badge.textContent = `🔀 TokenSaving${pctSuffix}`;
      badge.title = `Chat requests are routed through the local TokenSaving compression proxy. Click to switch back to direct. ${savingsDetail}`;
    } else {
      badge.textContent = '🔀 direct';
      badge.title = (headroomConfigured
        ? 'Chat requests go straight to the AI gateway. Click to route through TokenSaving instead.'
        : 'Chat requests go straight to the AI gateway. TokenSaving is not configured (set HEADROOM_URL in .env) — click for details.'
      ) + ` ${savingsDetail}`;
    }
    badge.style.display = '';

    if (dot) {
      dot.classList.toggle('active', viaHeadroom);
      dot.title = viaHeadroom ? `via TokenSaving${pctSuffix}` : 'direct to AI gateway';
    }
  }

  async function refreshRouting() {
    try {
      const res = await fetch(BASE_URL + '/config');
      if (!res.ok) return;
      const cfg = await res.json();
      viaHeadroom        = !!cfg.via_headroom;
      headroomConfigured = !!cfg.headroom_configured;
      render();
    } catch { /* serve.py unreachable — leave badge as last-known state */ }
  }

  async function refreshSavings() {
    try {
      const res  = await fetch(BASE_URL + '/headroom/stats');
      const data = res.ok ? await res.json() : { available: false };
      if (!data.available) { dashboardUrl = null; savingsPct = null; savingsDetail = ''; return; }
      dashboardUrl  = data.dashboard_url;
      savingsPct    = typeof data.savings_percent === 'number' ? data.savings_percent : null;
      savingsDetail = `— ${fmtTokens(data.tokens_saved)} tokens saved lifetime over ${data.requests} requests.`;
      render();
    } catch { /* offline — leave last-known state */ }
  }

  async function applyGatewayUrl(url) {
    // Bypass autoFillFromConfig()'s "only fill if empty" guard — this is an explicit
    // user action and must take effect on the very next request, not just on next reload.
    urlInput.value = url;
    await chrome.storage.session.set({ bf_url: url });
  }

  badge.addEventListener('click', async () => {
    if (busyToggling) return;
    if (guardBusy()) return;

    const target = !viaHeadroom;
    if (target && !headroomConfigured) {
      appendTurn('system', 'TokenSaving is not configured — set HEADROOM_URL (and HEADROOM_DASHBOARD_URL, if running in Docker) in .env, then restart serve.py.');
      return;
    }
    const confirmed = confirm(
      target
        ? 'Switch chat requests to the local TokenSaving compression proxy?'
        : 'Switch chat requests back to going direct to the AI gateway?'
    );
    if (!confirmed) return;

    busyToggling = true;
    try {
      const res = await fetch(BASE_URL + '/headroom/toggle', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enable: target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      viaHeadroom = !!data.via_headroom;
      await applyGatewayUrl(data.gateway_url);
      render();
      setStatus(viaHeadroom ? 'routing: via TokenSaving' : 'routing: direct to gateway', 'ok');
    } catch (e) {
      appendTurn('system', `Failed to switch routing: ${e.message}`);
    } finally {
      busyToggling = false;
    }
  });

  if (dashboardBtn) {
    dashboardBtn.addEventListener('click', () => {
      if (dashboardUrl) {
        chrome.tabs.create({ url: dashboardUrl });
      } else {
        appendTurn('system', 'TokenSaving not configured — set HEADROOM_URL in .env to enable the token-savings dashboard.');
      }
    });
  }

  function refresh() {
    refreshRouting();
    refreshSavings();
  }
  refresh();
  setInterval(refresh, 60 * 1000);
})();

el('read-page').addEventListener('click', () => withPage('read-page', async page => {
  if (guardBusy()) return;
  if (!page.text) {
    appendTurn('system', 'No text selected — select some text on the page, then click Translate.');
    setStatus('no selection', 'err');
    return;
  }
  history.push({ role: 'user', content:
    `[Selected text from "${page.title}"]\n\n${page.text}\n\n` +
    'If the text above is not already in English, translate it to English. ' +
    'If it is already in English, say so briefly instead of translating. ' +
    'Reply with just the translation (or that brief note) — no extra commentary.' });
  appendTurn('system', `🌐 Selected text from "${page.title}"`);
  el('read-page').classList.add('active');
  await send(true); // user turn already pushed above; silent avoids re-appending it
}, readSelectedText));

el('tldr').addEventListener('click', () => withPage('tldr', async page => {
  if (guardBusy()) return;
  history.push({ role: 'user',      content: pageCtx(page) });
  history.push({ role: 'assistant', content: 'Page loaded.' });
  history.push({ role: 'user',      content:
    'Summarize this page. Read the actual content and compress it to the shortest form that keeps every ' +
    'material fact and its meaning intact — no filler, no restating the page title, nothing padded out for ' +
    'the sake of structure. One fact or claim per bullet. ' +
    'If the page covers multiple distinct topics (or, for a changelog/release-notes page, multiple months or ' +
    'versions), group bullets under a short "### <topic>" heading per group — otherwise just a flat bullet list, ' +
    'no headings needed for a single narrow topic. ' +
    'Always cite sources: end each bullet, or each topic group, with a markdown link to the most relevant URL ' +
    'actually on the page — never omit this, never invent a URL. ' +
    'Start directly with the first bullet or heading — no preamble, no "Here is the summary" or similar opener, ' +
    'not even if you look something up mid-answer and resume afterward.' });
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
// `history` is a single shared array mutated by several async flows (chat send,
// LQL/CVE auto-report triggers, the LQL scoping conversation). Every entry point
// that pushes a 'user' turn and then kicks off a fetch MUST check this first —
// otherwise two flows can interleave pushes while both are in flight, and their
// 'assistant' replies can land back-to-back at the end of history. That breaks
// the strict user/assistant alternation the API requires and produces:
//   "This model does not support assistant message prefill. The conversation
//    must end with a user message." — on whatever silent send happens next.
function guardBusy() {
  if (busy) {
    appendTurn('system', 'Still processing the previous request — wait for it to finish first.');
    return true;
  }
  return false;
}

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
      // Also close SBOM picker if click is outside it too
      const picker = el('sbom-picker');
      if (picker && !picker.contains(e.target) && e.target !== el('sbom')) {
        picker.classList.remove('open');
      }
    }
  });
})();

// ── Admin dropdown toggle (gateway / model / TokenSaving / community) ──────────
// Same open/close pattern as the FortiCNAPP menu, except clicking inside only closes the
// menu for actual action items (.admin-item) — the gateway/model <select> elements need
// clicks to reach their native dropdown without the whole Admin menu closing underneath them.
(function () {
  const btn  = el('admin-btn');
  const menu = el('admin-menu');
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

  menu.addEventListener('click', e => {
    if (!e.target.closest('.admin-item')) return;
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

  // Source files — SAST languages first (Go, Java, JS, PHP, Python, TypeScript)
  if (/^\s*package\s+\w+\s*\nimport\s+[("]/m.test(snippet) ||
      /^\s*func\s+\w+\(/.test(snippet))                            return `snippet${index}.go`;
  if (/^\s*(import|from\s+\S+\s+import|def |class |if __name__)/.test(snippet)) return `snippet${index}.py`;
  if (/^\s*(import\s+\{|export\s+(default|const|function|class)|interface\s+\w|:\s*(string|number|boolean)\b)/.test(snippet)) return `snippet${index}.ts`;
  if (/^\s*(const|let|var|function\s|\(.*\)\s*=>|require\()/.test(snippet))      return `snippet${index}.js`;
  if (/^\s*(package\s+\w|import\s+java\.|public\s+(class|interface))/.test(snippet))      return `snippet${index}.java`;
  if (/<\?php/.test(snippet))                                    return `snippet${index}.php`;
  if (/^\s*(resource|provider|variable|module|terraform)\s+"/.test(snippet))     return `snippet${index}.tf`;
  if (/^\s*(FROM|RUN|COPY|EXPOSE|ENTRYPOINT)\s/.test(snippet))  return 'Dockerfile';
  if (/^\s*(apiVersion|kind):\s/.test(snippet))                  return `manifest${index}.yaml`;
  return `snippet${index}.txt`;
}

// ── GitHub repo scanner ───────────────────────────────────────────────────

// SCA manifest filenames — lacework SCA must see the exact filename to parse them.
// Sources: https://docs.fortinet.com/document/forticnapp/latest/administration-guide/sca-languages
const MANIFEST_NAMES = new Set([
  // Python
  'requirements.txt', 'requirements-dev.txt', 'requirements-test.txt',
  'Pipfile', 'Pipfile.lock', 'setup.py', 'setup.cfg', 'pyproject.toml',
  'poetry.lock', 'uv.lock',
  // Node.js
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  // Go
  'go.mod', 'go.sum',
  // Java
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  // Rust
  'Cargo.toml', 'Cargo.lock',
  // Ruby
  'Gemfile', 'Gemfile.lock',
  // PHP
  'composer.json', 'composer.lock',
  // .NET
  'packages.lock.json', 'packages.config',
  // C/C++
  'conan.lock', 'conanfile.txt', 'conanfile.py',
  // Misc / containers
  'Chart.yaml', 'Chart.lock',
  'Dockerfile', '.dockerignore',
]);
// Suffix-matched manifest patterns (checked separately below)
const MANIFEST_SUFFIXES = [
  '.deps.json',       // .NET DotNet Core
  '.gradle.lockfile', // Java Gradle
];
// SAST source extensions: Go, Java, JS, PHP, Python, TypeScript
// SCA catches manifests above; source exts are for SAST + context
const SOURCE_EXTS = new Set([
  '.go',
  '.java',
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts',
  '.php',
  '.py',
  // Extra useful for context / IaC
  '.tf', '.rs', '.cs', '.cpp', '.c', '.h', '.rb',
  '.yaml', '.yml',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', '__pycache__',
  '.venv', 'venv', 'env', 'coverage', '.nyc_output', '.cache',
  'target', 'out', 'bin', 'obj',
]);

// SAST-scanned source extensions (Go, Java, JS, PHP, Python, TypeScript — the
// languages lacework SAST actually supports; see CLAUDE.md).
const SAST_EXTS = new Set(['.go', '.java', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.php', '.py']);
// Infrastructure-as-Code: Terraform, Dockerfiles, Kubernetes/Helm/CloudFormation
// YAML. Checked before the SCA manifest set below, since Dockerfile/Chart.yaml
// are also in MANIFEST_NAMES (kept there unchanged — that set still drives what
// fetchGithubRepoFiles/serve.py treat as a manifest for the actual scan; this is
// a separate, display-only categorization for the GitHub file card).
const IAC_EXTS  = new Set(['.tf', '.tfvars', '.yaml', '.yml']);
const IAC_NAMES = new Set(['Dockerfile', 'Chart.yaml', 'Chart.lock', '.dockerignore']);

// Display-only categorization for the GitHub repo card — SAST | IaC | SCA | Other.
function categorizeGithubFile(path) {
  const name = path.split('/').pop();
  const ext  = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if (IAC_NAMES.has(name) || IAC_EXTS.has(ext)) return 'IaC';
  if (MANIFEST_NAMES.has(name) || MANIFEST_SUFFIXES.some(s => name.endsWith(s))) return 'SCA';
  if (SAST_EXTS.has(ext)) return 'SAST';
  return 'Other';
}

function githubRepoFromUrl(url) {
  // Matches: github.com/owner/repo[/tree/branch/...]
  const m = url.match(/github\.com\/([^/]+)\/([^/?#]+)(?:\/tree\/([^/?#]+))?/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, ''), branch: m[3] || null };
}

async function fetchGithubRepoFiles(owner, repo, branchHint) {
  setStatus('fetching repo tree…', 'busy');

  const ghHeaders = { Accept: 'application/vnd.github+json' };

  // Use branch from URL if present; only hit the API when we need the default branch
  let branch = branchHint;
  if (!branch) {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`,
      { headers: ghHeaders });
    if (!repoRes.ok) throw new Error(`GitHub API ${repoRes.status}: ${owner}/${repo}`);
    const repoData = await repoRes.json();
    branch = repoData.default_branch || 'main';
  }

  // Fetch full recursive file tree
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: ghHeaders });
  if (!treeRes.ok) throw new Error(`Tree API ${treeRes.status}`);
  const tree = await treeRes.json();

  // Select which files to fetch: all manifests + source files (skip large/binary/vendor)
  const isManifest = (name) =>
    MANIFEST_NAMES.has(name) || MANIFEST_SUFFIXES.some(s => name.endsWith(s));

  const candidates = (tree.tree || []).filter(item => {
    if (item.type !== 'blob') return false;
    if (item.size > 500_000) return false; // skip files >500 KB
    const parts = item.path.split('/');
    if (parts.some(p => SKIP_DIRS.has(p))) return false;
    const name = parts[parts.length - 1];
    const ext  = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    return isManifest(name) || SOURCE_EXTS.has(ext);
  });

  // Prioritise manifests; then source files sorted by extension priority
  // (SAST langs first so they're never starved by IaC/misc files)
  const manifests = candidates.filter(f => isManifest(f.path.split('/').pop()));
  const sastSources = candidates.filter(f => {
    const name = f.path.split('/').pop();
    if (isManifest(name)) return false;
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    return SAST_EXTS.has(ext);
  });
  const otherSources = candidates.filter(f => {
    const name = f.path.split('/').pop();
    if (isManifest(name)) return false;
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    return !SAST_EXTS.has(ext);
  });
  // Cap: all manifests + up to 120 SAST sources + up to 20 other sources
  const selected = [
    ...manifests,
    ...sastSources.slice(0, 120),
    ...otherSources.slice(0, 20),
  ].slice(0, 150);

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
        // Send full relative path so serve.py can preserve directory structure
        // and lacework SAST can resolve cross-file references correctly.
        return { filename: item.path, code, path: item.path };
      } catch { return null; }
    }));
    files.push(...results.filter(Boolean));
  }
  return { files, owner, repo, branch };
}

function appendResultCard(icon, title, contentEl) {
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
  const repoUrl = `https://github.com/${owner}/${repo}`;

  // Group a list of files by directory (unchanged row/chip rendering, just
  // reused per-category below instead of once for the whole file list).
  const buildDirRows = (fileList) => {
    const groups = {};
    fileList.forEach(f => {
      const parts = (f.path || f.filename || '').split('/');
      const dir   = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
      (groups[dir] = groups[dir] || []).push(parts[parts.length - 1]);
    });
    return Object.entries(groups).map(([dir, fnames]) => {
      const dirLabel = dir === '(root)' ? '' : `<span class="gh-dir">${esc(dir)}/</span>`;
      const fileChips = fnames.map(n => `<span class="gh-file">${esc(n)}</span>`).join('');
      return `<div class="gh-row">${dirLabel}${fileChips}</div>`;
    }).join('');
  };

  // Categorize into SAST | IaC | SCA | Other before rendering — same buckets
  // the CodeSec scan itself draws from (see categorizeGithubFile).
  const CATEGORY_META = {
    SAST:  { label: '🛡 SAST',  cls: 'sast'  },
    IaC:   { label: '🏗 IaC',   cls: 'iac'   },
    SCA:   { label: '📦 SCA',   cls: 'sca'   },
    Other: { label: '📄 Other', cls: 'other' },
  };
  const byCategory = { SAST: [], IaC: [], SCA: [], Other: [] };
  files.forEach(f => byCategory[categorizeGithubFile(f.path || f.filename || '')].push(f));

  const sections = Object.keys(CATEGORY_META)
    .filter(cat => byCategory[cat].length)
    .map(cat => {
      const meta = CATEGORY_META[cat];
      return `<div class="gh-cat gh-cat-${meta.cls}">` +
        `<div class="gh-cat-label">${meta.label}<span class="gh-cat-count">${byCategory[cat].length}</span></div>` +
        buildDirRows(byCategory[cat]) +
      `</div>`;
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
    `<div class="gh-files">${sections}</div>`;

  el('log-latest').appendChild(card);
  el('log-all').appendChild(card.cloneNode(true));
  scrollLog();
}

async function extractPageCode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  const url = tab.url || '';
  // Mirror manifest.json's host_permissions (https://*/* and http://localhost/*) instead of
  // blocklisting known-bad schemes — that blocklist missed http://127.0.0.1 (e.g. the TokenSaving
  // dashboard tab), which fell through to executeScript and surfaced Chrome's raw permission
  // error instead of a helpful message.
  const isScannable = /^https:\/\//i.test(url) || /^http:\/\/localhost(:\d+)?(\/|$)/i.test(url);
  if (!isScannable) throw new Error('Navigate to a Github Public web page first.');

  const ghRepo = githubRepoFromUrl(tab.url || '');
  if (ghRepo) {
    const { files, owner, repo, branch } = await fetchGithubRepoFiles(ghRepo.owner, ghRepo.repo, ghRepo.branch);
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

    // Non-JSON formats: show raw output with download/copy
    if (data._raw !== undefined) {
      const fmt = data._format || 'sbom';
      const extMap = { 'cdx-xml': 'xml', 'spdx-json': 'json', 'spdx-tag': 'spdx', 'spdx-yaml': 'yaml', sarif: 'json', 'lw-json': 'json', 'gitlab-json': 'json' };
      const ext = extMap[fmt] || 'txt';
      const title = document.createElement('div');
      title.className = 'cs-section-title';
      title.textContent = `SBOM (${fmt})`;
      body.appendChild(title);
      const actions = document.createElement('div');
      actions.className = 'cs-sbom-actions';
      const dlBtn = document.createElement('button');
      dlBtn.className = 'cs-sbom-btn';
      dlBtn.textContent = `⬇ Download .${ext}`;
      dlBtn.addEventListener('click', () => {
        const blob = new Blob([data._raw], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        chrome.downloads ? chrome.downloads.download({ url, filename: `sbom.${fmt}.${ext}` })
                         : chrome.tabs.create({ url });
      });
      const copyBtn = document.createElement('button');
      copyBtn.className = 'cs-sbom-btn';
      copyBtn.textContent = '📋 Copy';
      copyBtn.addEventListener('click', () => navigator.clipboard.writeText(data._raw));
      actions.append(dlBtn, copyBtn);
      body.appendChild(actions);
      const pre = document.createElement('pre');
      pre.style.cssText = 'font-size:10px;overflow-x:auto;max-height:200px;background:var(--surface3);padding:6px;border-radius:4px;margin-top:4px;';
      pre.textContent = data._raw.slice(0, 3000) + (data._raw.length > 3000 ? '\n…(truncated)' : '');
      body.appendChild(pre);
      appendResultCard('📦', 'FortiCNAPP SBOM', body);
      return;
    }

    const components = data.components || [];
    const title = document.createElement('div');
    title.className = 'cs-section-title';
    title.textContent = `SBOM (cdx-json) — ${components.length} component${components.length !== 1 ? 's' : ''}`;
    body.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'cs-sbom-actions';
    const dlBtn = document.createElement('button');
    dlBtn.className = 'cs-sbom-btn';
    dlBtn.textContent = '⬇ Download JSON';
    dlBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      chrome.downloads ? chrome.downloads.download({ url, filename: 'sbom.cdx-json.json' })
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
      appendTurn('system', 'No Code Found on this page...');
      setStatus('—');
      return;
    }

    const sbomFmt = (document.querySelector('input[name="sbom-fmt"]:checked') || {}).value || 'lw-json';
    const res = await fetch(`${BASE_URL}/${mode === 'sbom' ? 'sbom' : 'codesec'}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ files, ...(mode === 'sbom' ? { format: sbomFmt } : {}) }),
    });
    if (!res.ok) throw new Error(`Scan endpoint returned ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : { _raw: await res.text(), _format: sbomFmt };
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

// SBOM Gen: open format picker, positioned below the button
el('sbom').addEventListener('click', e => {
  e.stopPropagation();
  const picker = el('sbom-picker');
  const rect   = e.currentTarget.getBoundingClientRect();
  picker.style.top  = `${rect.bottom + 4}px`;
  picker.style.left = `${rect.left}px`;
  picker.classList.toggle('open');
});
el('sbom-cancel').addEventListener('click', e => {
  e.stopPropagation();
  el('sbom-picker').classList.remove('open');
});
el('sbom-generate').addEventListener('click', e => {
  e.stopPropagation();
  el('sbom-picker').classList.remove('open');
  startNewSession('SBOM');
  runCodeSec('sbom');
});
// Close picker on outside click
document.addEventListener('click', e => {
  if (!el('sbom-picker').contains(e.target) && e.target !== el('sbom')) {
    el('sbom-picker').classList.remove('open');
  }
});
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
      appendTurn('system',
        `📋 Compliance PDF: ${fw.name} — opened in a new tab. Select any text in it and ` +
        `right-click → "Ask AI about selection" to bring it into this chat.`);
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

// ── Selection-to-chat: "Ask AI about selection" context menu ────────────────
// Works on any page, including a PDF opened in Chrome's built-in viewer (a content
// script can't attach inside the PDF renderer, but the browser-level context menu
// still fires there since contexts:['selection'] isn't scoped by URL match pattern).
const SELECTION_MAX_CHARS = 4000;

function openSelectionInChat(text) {
  ['codesec-panel', 'compliance-panel', 'lql-panel', 'cve-panel'].forEach(id =>
    el(id).classList.remove('open'));
  const trimmed = text.trim();
  const clipped = trimmed.length > SELECTION_MAX_CHARS
    ? trimmed.slice(0, SELECTION_MAX_CHARS) + '\n[…truncated]'
    : trimmed;
  const quoted = clipped.split('\n').map(l => `> ${l}`).join('\n');
  el('prompt').value = `${quoted}\n\n`;
  resizePrompt();
  el('prompt').focus();
  el('prompt').setSelectionRange(el('prompt').value.length, el('prompt').value.length);
  setStatus('selection loaded — ask your question', 'ok');
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'TEXT_SELECTED' && msg.text) openSelectionInChat(msg.text);
});

chrome.storage.session.get('pendingSelection', ({ pendingSelection }) => {
  if (!pendingSelection) return;
  chrome.storage.session.remove('pendingSelection');
  openSelectionInChat(pendingSelection);
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
  if (!isOpen) { startNewSession('Unified Attack Threat Surface'); el('cve-input').focus(); }
});

el('cve-close').addEventListener('click', () => el('cve-panel').classList.remove('open'));

el('cve-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') runCveSearch();
});

el('cve-search').addEventListener('click', runCveSearch);

el('cve-analyse').addEventListener('click', () => {
  if (!_lastCveData) return;
  if (guardBusy()) return;
  el('cve-panel').classList.remove('open');
  const prompt = buildCveAnalysisPrompt(_lastCveData, _lastCveData.fgOutbreaks || []);
  history.push({ role: 'user', content: prompt });
  appendTurn('user', `Analyse attack surface for ${_lastCveData.cveId}`);
  send(true);
});

// ── Regulatory context: map cloud regions → applicable compliance obligations ──
function _regulatoryContext(regions = []) {
  // Normalise region strings to detect geography
  const r = regions.map(s => (s || '').toLowerCase()).join(' ');

  const frameworks = [];

  // Canada — PIPEDA + provincial (Quebec Law 25)
  const isCanada = /\bca-[a-z]|\bcanada\b/.test(r);
  if (isCanada) {
    frameworks.push({
      name: 'PIPEDA (Canada)',
      obligations: [
        'Mandatory breach notification to the Office of the Privacy Commissioner (OPC) when a breach creates a "real risk of significant harm" — report as soon as feasible.',
        'Notify affected individuals directly when a real risk of significant harm exists.',
        'Quebec Law 25 (Bill 64): notify the Commission d\'accès à l\'information (CAI) within 72 hours of becoming aware of a confidentiality incident.',
        'Maintain a record of all breaches for 24 months.',
        'Threat hunting is required to confirm scope — any unconfirmed breach must be treated as a potential reportable incident.',
      ],
      huntingRequirement: 'Launch threat hunt within 24h to determine if data exfiltration occurred — PIPEDA notification clock starts on discovery, not confirmation.',
    });
  }

  // USA
  const isUSA = /\bus-[a-z]|\bunited states\b/.test(r);
  if (isUSA) {
    frameworks.push({
      name: 'NIST CSF / US Federal',
      obligations: [
        'NIST SP 800-61r2: Incident response — contain within 1h for critical, eradicate within 24h.',
        'If healthcare data involved: HIPAA Breach Notification Rule — report to HHS within 60 days of discovery; notify individuals without unreasonable delay.',
        'If payment card data: PCI-DSS — notify acquiring bank immediately; preserve forensic evidence.',
        'CISA: Report significant cyber incidents to CISA within 72 hours (CIRCIA, effective 2026).',
      ],
      huntingRequirement: 'NIST IR Phase 3: Eradication requires confirmed scope via threat hunt before declaring containment.',
    });
  }

  // EU / Europe
  const isEU = /\beu-[a-z]|\bap-[a-z].*eu|\bfrankfurt\b|\bireland\b|\bparis\b|\bstockholm\b|\bspain\b|\bmilan\b/.test(r);
  if (isEU) {
    frameworks.push({
      name: 'GDPR (EU)',
      obligations: [
        'GDPR Article 33: Notify supervisory authority within 72 hours of becoming aware of a personal data breach.',
        'GDPR Article 34: Notify affected individuals "without undue delay" when breach likely results in high risk.',
        'NIS2 Directive: Notify CSIRT within 24 hours (early warning) and within 72 hours (full notification).',
        'Maintain breach register under Article 33(5).',
      ],
      huntingRequirement: 'GDPR 72h clock starts on awareness — threat hunt must begin immediately to scope the breach before notification.',
    });
  }

  // UK
  const isUK = /\beu-west-2\b|\blondon\b|\buk\b/.test(r);
  if (isUK) {
    frameworks.push({
      name: 'UK GDPR / ICO',
      obligations: [
        'UK GDPR: Report personal data breach to ICO within 72 hours.',
        'Notify individuals when breach poses high risk to their rights and freedoms.',
        'Cyber Essentials: Patch critical vulnerabilities within 14 days.',
      ],
      huntingRequirement: 'ICO 72h notification window — begin breach scoping immediately.',
    });
  }

  // Asia-Pacific
  const isAPAC = /\bap-[a-z]|\basia\b|\bsydney\b|\btokyo\b|\bsingapore\b|\bseoul\b|\bmumbai\b|\bjakarta\b/.test(r);
  if (isAPAC && !isEU) {
    frameworks.push({
      name: 'APAC Privacy Laws',
      obligations: [
        'Australia Privacy Act: Mandatory breach notification under the Notifiable Data Breaches (NDB) scheme — notify OAIC and individuals as soon as practicable.',
        'Japan APPI: Notify PPC and affected individuals within 30 days (3–5 days for serious breaches).',
        'Singapore PDPA: Notify PDPC within 3 days of assessing a notifiable breach.',
      ],
      huntingRequirement: 'Begin scoping within 24h — notification timelines vary by jurisdiction but all start from "awareness".',
    });
  }

  // Default fallback — always include ISO 27001
  frameworks.push({
    name: 'ISO 27001:2022',
    obligations: [
      'ISO 27001 A.5.26: Response to information security incidents — document, contain, eradicate, recover.',
      'ISO 27001 A.5.28: Collect and preserve evidence for forensic purposes.',
      'ISO 27001 A.6.8: Employees must report security events immediately.',
    ],
    huntingRequirement: 'ISO 27001 requires documented evidence of incident scope before closure.',
  });

  if (!frameworks.length) return '';

  const lines = ['', '=== REGULATORY OBLIGATIONS (based on affected regions) ==='];
  frameworks.forEach(fw => {
    lines.push(``, `--- ${fw.name} ---`);
    fw.obligations.forEach(o => lines.push(`  • ${o}`));
    lines.push(`  ⚑ Threat hunting requirement: ${fw.huntingRequirement}`);
  });
  lines.push(
    ``,
    `IMPORTANT: Populate the report template's "## Compliance Deadlines" table using the frameworks/obligations`,
    `above — one row per distinct obligation, columns: Regulation | Due | Owner | Action.`,
    `Due dates must be computed from the actual discovery/exposure date given in the data — never invent one.`,
    `If a breach cannot be ruled out, add a row for the notification obligation and state the deadline explicitly.`,
    `Also add a "Preserve Evidence" bullet for anything these frameworks require retaining (e.g. breach record,`,
    `access logs, forensic timeline) that isn't already covered by the finding-specific evidence bullets.`,
  );
  return lines.join('\n');
}

// Shared incident-report template for FortiCNAPP Risk Hunting (LQL) and
// Unified Attack Threat Surface (CVE) reports. This OVERRIDES the system prompt's
// default Objective/Findings/Fix structure per its own precedence rule.
const INCIDENT_REPORT_TEMPLATE = `Use EXACTLY this Markdown template. Fill every placeholder from the data provided below; omit
a whole section if it doesn't apply (e.g. no "Compliance Deadlines" section when no regulated
region is affected, no "Critical Context" bullet you don't have data for). Never invent facts,
dates, counts, or context not present in the data provided.

# <one-line finding title>

## Status
**<CRITICAL|HIGH|MEDIUM|LOW>** — <N> of <total> (<pct>%) <one-line description of what's wrong>.

## Affected <resource type — e.g. Buckets / Instances / Roles / Hosts>
Markdown table, one row per resource. Last column is Status, using 🔴/🟠/🟡 for at-a-glance severity:
| <col> | <col> | <col> | Status |
|---|---|---|---|

## Remediation — Execute NOW
\`\`\`bash
# group commands with a "# Account X (region)" comment header when there's more than one account/region
<exact command per resource — real resource names/IDs from the data, never placeholders>
\`\`\`

**Verify:**
\`\`\`bash
<a command or loop that confirms the fix actually took effect>
\`\`\`

## Critical Context
- **<label>**: <fact — only from data actually provided: log/audit gaps, confirmed reachability tests, missing
  classification tags, related prior findings, etc. Omit this whole section if there is no such context.>

## Compliance Deadlines
Markdown table — only if a regulatory obligation applies to the affected region(s):
| Regulation | Due | Owner | Action |
|---|---|---|---|

## Preserve Evidence
- <bullet list of exactly what to preserve for this finding type and why>

---
**Report Generated**: <today's date, given below> | **Discovery Date**: <from data if known, else omit this field> | **Exposure Window**: <from data if known, else omit this field>`;

function buildReportInstructions() {
  const today = new Date().toISOString().slice(0, 10);
  return `${INCIDENT_REPORT_TEMPLATE}\n\nToday's date: ${today}`;
}

// Computed (not model-authored) risk profile for the CVE report's "Critical Context" section —
// geometry is unreliable coming from an LLM, so we derive the 5 axes straight from the CVSS
// vector / EPSS / exposure data and hand the model a ready-made ```radar block to embed verbatim.
function buildCveRadarBlock(d, intel) {
  const vector = intel?.nvd?.cvssV3Vector;
  if (!vector) return '';
  const av = { N: 100, A: 70, L: 40, P: 15 }[(vector.match(/AV:([NALP])/) || [])[1]];
  const pr = { N: 100, L: 65, H: 30 }[(vector.match(/PR:([NLH])/) || [])[1]];
  const sc = { C: 100, U: 40 }[(vector.match(/\/S:([CU])/) || [])[1]];
  if (av === undefined || pr === undefined || sc === undefined) return '';
  const epss     = intel.epss ? Math.round(intel.epss.percentile * 100) : 0;
  const exposure = d.total_affected ? Math.round((d.internet_exposed / d.total_affected) * 100) : 0;
  const data = {
    title: 'Risk Profile',
    axes:  ['Attack Vector', 'Privileges Required', 'Scope Impact', 'EPSS Percentile', 'Internet Exposure'],
    values: [av, pr, sc, epss, exposure],
  };
  return '```radar\n' + JSON.stringify(data) + '\n```';
}

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
    lines.push(`${i + 1}. ${h.hostname} [${h.severity}] csp:${h.csp || 'unknown'} instance:${h.instance_id || 'unknown'} type:${h.instance_type || ''} account:${h.account || 'unknown'} region:${h.region || ''} vpc:${h.vpc_id || ''} risk:${h.host_risk_score.toFixed(1)} ${flags}`);
    h.packages.forEach(p  => lines.push(`   pkg: ${p.name} ${p.version}`));
    h.containers.forEach(c => lines.push(`   ctr: ${c.name}${c.internet_exposed ? ' 🌐 INTERNET-EXPOSED' : ''}`));
  });

  const radarBlock = buildCveRadarBlock(d, intel);

  lines.push(
    ``,
    buildReportInstructions(),
    ``,
    `Report-specific guidance:`,
    `- Title: "CVE ${d.cveId} Exposure"`,
    `- Status stats: ${d.total_affected} hosts affected, ${d.internet_exposed} internet-exposed, CVSS ${intel.nvd?.cvssV3Score ?? '?'}, EPSS ${intel.epss?.score ?? '?'}.`,
    `- "Affected Hosts" table: full hostname (never truncate), CSP (AWS/Azure/GCP), instance ID, instance type, CSP account ID, region, VPC, severity, internet-exposed flag if applicable. Use "unknown" only if the data field is genuinely blank — never omit the column.`,
    `- Remediation: exact patch command per host/package (e.g. apt-get install <pkg>=<version>, yum update, docker pull <image>:<tag>).`,
    `- Discovery Date / Exposure Window are unknown for CVE data — omit those two fields from the report footer.`,
  );
  if (radarBlock) {
    lines.push(
      `- "Critical Context" section: the very first line must be this exact fenced block, byte-for-byte, unchanged (it is a pre-computed risk-profile chart — do not edit the JSON):`,
      radarBlock,
      `  After that block, continue with the normal bullet list explaining what each axis means for this CVE.`,
    );
  }
  if (intel.kev?.inKev)             lines.push(`NOTE: This CVE is in CISA KEV — actively exploited. Urgency is NOW.`);
  if (intel.epss?.percentile > 0.9) lines.push(`NOTE: EPSS top 10th percentile — patch within 24h.`);

  // Inject region-aware regulatory obligations
  const regions = d.hosts.map(h => h.region).filter(Boolean);
  lines.push(_regulatoryContext(regions));

  return lines.join('\n');
}

// ── SVG radar + attack-surface bar for CVE threat intelligence ────────────────
function buildThreatRadarHtml(cveId, intel, data) {
  const od = intel.fgOutbreakDetail || {};

  // Normalise each axis 0-1
  const cvss    = (intel.nvd?.cvssV3Score  ?? 0) / 10;
  const epss    = intel.epss?.score        ?? 0;
  const kev     = intel.kev?.inKev         ? 1 : 0;
  const fg      = (intel.threatRadarScore  ?? 0) / 100;
  const exposed = data.total_affected > 0
                  ? Math.min(data.internet_exposed / data.total_affected, 1)
                  : 0;
  // PoC: 1 if public PoC exists, 0 if not, 0.5 if unknown
  const poc     = od.pocAvailable === true ? 1 : od.pocAvailable === false ? 0 : 0.5;
  // No-patch risk: 1 if no patch available, 0 if patched
  const noPatch = od.patchAvailable === true ? 0 : od.patchAvailable === false ? 1 : 0.5;

  const axes  = ['CVSS', 'EPSS', 'KEV', 'FortiGuard', 'PoC', 'No Patch', 'Exposed%'];
  const vals  = [cvss, epss, kev, fg, poc, noPatch, exposed];
  const N     = axes.length;
  const R     = 72;   // radius of chart
  const cx    = 90; const cy = 90;

  // Polygon points helper
  const pt = (i, v) => {
    const angle = (Math.PI * 2 * i / N) - Math.PI / 2;
    return [cx + v * R * Math.cos(angle), cy + v * R * Math.sin(angle)];
  };

  // Grid rings at 25/50/75/100%
  const rings = [0.25, 0.5, 0.75, 1].map(r => {
    const pts = Array.from({length: N}, (_, i) => pt(i, r).join(',')).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="#e0e0e0" stroke-width="${r === 1 ? 1.2 : 0.7}"/>`;
  }).join('');

  // Axis lines + labels
  const axisLines = axes.map((label, i) => {
    const [x2, y2] = pt(i, 1);
    const [lx, ly] = pt(i, 1.22);
    const anchor   = lx < cx - 5 ? 'end' : lx > cx + 5 ? 'start' : 'middle';
    return `<line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#ccc" stroke-width="0.8"/>` +
           `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" font-size="7.5" fill="#555" text-anchor="${anchor}">${label}</text>`;
  }).join('');

  // Value polygon
  const polyPts = vals.map((v, i) => pt(i, v).join(',')).join(' ');
  const composite = (cvss * 0.22 + epss * 0.25 + kev * 0.18 + fg * 0.12 + poc * 0.1 + noPatch * 0.08 + exposed * 0.05);
  const radarCol  = composite >= 0.7 ? '#cc0000' : composite >= 0.4 ? '#e65c00' : '#2196f3';
  const scoreLabel = Math.round(composite * 100);
  const scoreLabelCol = composite >= 0.7 ? '#cc0000' : composite >= 0.4 ? '#e65c00' : '#4caf50';

  // Dot on each axis
  const dots = vals.map((v, i) => {
    const [x, y] = pt(i, v);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${radarCol}" stroke="#fff" stroke-width="1"/>`;
  }).join('');

  const radarSvg =
    `<svg viewBox="0 0 180 180" width="160" height="160" style="flex-shrink:0">` +
    rings + axisLines +
    `<polygon points="${polyPts}" fill="${radarCol}" fill-opacity="0.18" stroke="${radarCol}" stroke-width="1.5" stroke-linejoin="round"/>` +
    dots +
    `<text x="${cx}" y="${cy + 4}" font-size="13" font-weight="bold" fill="${scoreLabelCol}" text-anchor="middle">${scoreLabel}</text>` +
    `<text x="${cx}" y="${cy + 13}" font-size="6.5" fill="#888" text-anchor="middle">/ 100</text>` +
    `</svg>`;

  // ── Right panel: 3 headline numbers + badges + description ──────────────
  const total    = data.total_affected || 0;
  const expCount = data.internet_exposed || 0;
  const sevColor = intel.nvd?.cvssV3Severity === 'CRITICAL' ? '#cc0000'
                 : intel.nvd?.cvssV3Severity === 'HIGH'     ? '#e65c00'
                 : intel.nvd?.cvssV3Severity === 'MEDIUM'   ? '#f59e0b' : '#4caf50';

  const tiles =
    `<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">` +
    // CVSS
    (intel.nvd?.cvssV3Score
      ? `<div style="background:#fff;border:1.5px solid ${sevColor};border-radius:6px;padding:5px 10px;text-align:center;min-width:48px">` +
        `<div style="font-size:17px;font-weight:700;color:${sevColor};line-height:1">${intel.nvd.cvssV3Score}</div>` +
        `<div style="font-size:8px;color:#888">CVSSv3</div></div>` : '') +
    // EPSS
    (intel.epss?.score !== undefined
      ? `<div style="background:#fff;border:1.5px solid ${intel.epss.score>0.5?'#cc0000':intel.epss.score>0.1?'#e65c00':'#aaa'};border-radius:6px;padding:5px 10px;text-align:center;min-width:48px">` +
        `<div style="font-size:17px;font-weight:700;color:${intel.epss.score>0.5?'#cc0000':intel.epss.score>0.1?'#e65c00':'#555'};line-height:1">${(intel.epss.score*100).toFixed(0)}%</div>` +
        `<div style="font-size:8px;color:#888">EPSS</div></div>` : '') +
    // Hosts affected
    `<div style="background:#fff;border:1.5px solid ${total>0?'#e65c00':'#ccc'};border-radius:6px;padding:5px 10px;text-align:center;min-width:48px">` +
    `<div style="font-size:17px;font-weight:700;color:${total>0?'#e65c00':'#888'};line-height:1">${total}</div>` +
    `<div style="font-size:8px;color:#888">hosts</div></div>` +
    // Internet exposed
    `<div style="background:#fff;border:1.5px solid ${expCount>0?'#cc0000':'#ccc'};border-radius:6px;padding:5px 10px;text-align:center;min-width:48px">` +
    `<div style="font-size:17px;font-weight:700;color:${expCount>0?'#cc0000':'#888'};line-height:1">${expCount}</div>` +
    `<div style="font-size:8px;color:#888">🌐 exposed</div></div>` +
    // KEV badge tile
    (intel.kev?.inKev
      ? `<div style="background:#fef2f2;border:1.5px solid #cc0000;border-radius:6px;padding:5px 10px;text-align:center;min-width:48px">` +
        `<div style="font-size:10px;font-weight:700;color:#cc0000;line-height:1.6">⚠ KEV</div>` +
        `<div style="font-size:8px;color:#888">exploited</div></div>` : '') +
    // PoC tile
    (od.pocAvailable !== undefined
      ? `<div style="background:#fff;border:1.5px solid ${od.pocAvailable?'#cc0000':'#4caf50'};border-radius:6px;padding:5px 10px;text-align:center;min-width:48px">` +
        `<div style="font-size:10px;font-weight:700;color:${od.pocAvailable?'#cc0000':'#4caf50'};line-height:1.6">${od.pocAvailable?'⚠ PoC':'✓ No PoC'}</div>` +
        `<div style="font-size:8px;color:#888">exploit code</div></div>` : '') +
    // Patch tile
    (od.patchAvailable !== undefined
      ? `<div style="background:#fff;border:1.5px solid ${od.patchAvailable?'#4caf50':'#e65c00'};border-radius:6px;padding:5px 10px;text-align:center;min-width:48px">` +
        `<div style="font-size:10px;font-weight:700;color:${od.patchAvailable?'#4caf50':'#e65c00'};line-height:1.6">${od.patchAvailable?'✓ Patched':'⚠ Unpatched'}</div>` +
        `<div style="font-size:8px;color:#888">vendor fix</div></div>` : '') +
    `</div>`;

  const desc = intel.nvd?.description
    ? `<div style="font-size:10px;color:#555;line-height:1.5;margin-bottom:6px">${intel.nvd.description.slice(0,180)}…</div>`
    : '';

  // Outbreak timeline snippet
  const timelineHtml = od.timeline?.length
    ? `<div style="font-size:9px;color:#666;margin-bottom:6px;border-left:2px solid #e65c00;padding-left:6px">` +
      od.timeline.slice(0,3).map(t => `<div style="margin-bottom:2px">• ${t}</div>`).join('') +
      `</div>`
    : '';

  const links =
    `<div class="fg-search-link">` +
    `<a href="https://www.fortiguard.com/search?q=${encodeURIComponent(cveId)}" target="_blank">FortiGuard</a>` +
    `&nbsp;·&nbsp;<a href="https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveId)}" target="_blank">NVD</a>` +
    (intel.kev?.inKev ? `&nbsp;·&nbsp;<a href="https://www.cisa.gov/known-exploited-vulnerabilities-catalog" target="_blank">CISA KEV</a>` : '') +
    (od.url ? `&nbsp;·&nbsp;<a href="${od.url}" target="_blank">Outbreak Alert</a>` : '') +
    `</div>`;

  const rightPanel = `<div style="flex:1;min-width:0">${tiles}${desc}${timelineHtml}${links}</div>`;

  return (
    `<div style="font-size:11px;font-weight:600;color:#444;margin-bottom:8px">🎯 ${cveId} — Threat Radar</div>` +
    `<div style="display:flex;gap:12px;align-items:flex-start">` +
    radarSvg + rightPanel +
    `</div>`
  );
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

    // ── Visual Threat Radar card — inserted FIRST ─────────────────────────────
    const intelEl = document.createElement('div');
    intelEl.className = 'fg-outbreak-card';
    intelEl.innerHTML = buildThreatRadarHtml(cveId, intel, data);
    resultsEl.appendChild(intelEl);

    // ── Host list ─────────────────────────────────────────────────────────────
    renderCveResults(data, resultsEl);

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

    // Open FortiGuard PSIRT page for this CVE
    chrome.tabs.create({ url: `https://www.fortiguard.com/psirt/${encodeURIComponent(cveId)}`, active: false });

    // If part of an outbreak alert, open the outbreak page too
    if (fgOutbreaks.length) {
      const outbreakUrl = fgOutbreaks[0].link ||
        `https://fortiguard.fortinet.com/outbreak-alert?date=&risk=&vendor=&type=vulnerability&sort=`;
      chrome.tabs.create({ url: outbreakUrl, active: false });
    }

    // Auto-trigger executive analysis with combined CNAPP + FortiGuard context
    if (guardBusy()) return;
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

    addRow('csp',         h.csp);
    addRow('instance id', h.instance_id);
    addRow('account',     h.account);
    addRow('region',      h.region);
    addRow('vpc',         h.vpc_id);
    addRow('type',        h.instance_type);
    addRow('ami',         h.ami_id);
    addRow('internal ip', h.internal_ip);
    addRow('external ip', h.external_ip);
    addRow('state',       h.state);
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

function formatApiEnrichment(enrichment) {
  if (!enrichment || !Object.keys(enrichment).length) return '';
  const lines = ['\n\n--- FortiCNAPP API Correlation ---'];
  const { alerts, vulnerabilities, inventory, cloud_activities, container_vulnerabilities, machines, s3_sensitive_data } = enrichment;
  if (alerts) {
    lines.push(`Open Critical/High Alerts (${alerts.count} total):`);
    (alerts.items || []).forEach(a => {
      const info = a.alertInfo || {};
      lines.push(`  [${a.severity}] ${a.alertName || a.alertType || a.alertId}: ${info.subject || info.description || ''} reachability:${a.reachability || '?'} — ${a.startTime || ''}`);
    });
  }
  if (vulnerabilities) {
    lines.push(`Active Critical/High CVEs on matched hosts (${vulnerabilities.count} total):`);
    (vulnerabilities.items || []).forEach(v => {
      const fk = v.featureKey || {}; const fi = v.fixInfo || {};
      const host = v.machineTags ? (v.machineTags.Hostname || v.machineTags.Name || '') : '';
      lines.push(`  [${v.severity}] ${v.vulnId} pkg:${fk.name || '?'} ${fk.version_installed || ''} → fix:${fi.fixed_version || fi.fix_available || '?'} host:${host} status:${v.status || ''}`);
    });
  }
  if (container_vulnerabilities) {
    lines.push(`Critical/High CVEs on matched containers (${container_vulnerabilities.count} total):`);
    (container_vulnerabilities.items || []).forEach(v => {
      const fk = v.featureKey || {}; const fi = v.fixInfo || {};
      lines.push(`  [${v.severity}] ${v.vulnId} pkg:${fk.name || '?'} ${fk.version_installed || ''} → fix:${fi.fixed_version || fi.fix_available || '?'} status:${v.status || ''}`);
    });
  }
  if (s3_sensitive_data) {
    lines.push(`S3 Sensitive Data Correlation — Inventory API tag scan (${s3_sensitive_data.count} buckets, ${s3_sensitive_data.sensitive_count} with data-classification tags):`);
    (s3_sensitive_data.items || []).forEach(b => {
      const tagStr = Object.keys(b.sensitive_tags || {}).length
        ? Object.entries(b.sensitive_tags).map(([k, v]) => `${k}=${v}`).join(', ')
        : 'no classification tags';
      lines.push(`  ${b.urn || '?'} region:${b.resourceRegion || '?'} status:${b.status || '?'} tags:[${tagStr}]`);
    });
    if (s3_sensitive_data.sensitive_count === 0) {
      lines.push('  NOTE: No data-classification tags found. Buckets may be untagged — treat all exposed buckets as potentially sensitive.');
    }
  }
  if (inventory) {
    lines.push(`Inventory status for matched cloud resources (${inventory.count} total):`);
    (inventory.items || []).forEach(i => {
      const s = i.status || {}; const reason = s.reason || '';
      lines.push(`  [${i.csp}] ${i.resourceType} ${i.urn || ''} region:${i.resourceRegion || ''} service:${i.service || ''} status:${reason || JSON.stringify(s)}`);
    });
  }
  if (machines) {
    lines.push(`Host details for matched MIDs (${machines.count} total):`);
    (machines.items || []).forEach(m => {
      const t = m.machineTags || {};
      lines.push(`  ${m.hostname || '?'} ip:${m.primaryIpAddr || t.InternalIp || '?'} externalIp:${t.ExternalIp || '?'} internetExposure:${t.lw_InternetExposure || 'No'} provider:${t.VmProvider || '?'}`);
    });
  }
  if (cloud_activities) {
    lines.push(`Correlated CloudTrail activity events (${cloud_activities.count} total):`);
    (cloud_activities.items || []).forEach(a =>
      lines.push(`  ${a.eventType} actor:${a.eventActor || '?'} src:${a.sourceIPAddress || '?'} — ${a.startTime || ''}`));
  }
  return lines.join('\n');
}

let _lqlQueries = [];

el('lql').addEventListener('click', async () => {
  const panel  = el('lql-panel');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  el('codesec-panel').classList.remove('open');
  el('compliance-panel').classList.remove('open');
  if (!isOpen) { startNewSession('Risk Hunting'); loadLqlQueries(); }
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
      sel.innerHTML = '<option value="">No saved queries — use ✨ Assisted Investigation</option>';
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
    const keys       = Object.keys(rows[0]);
    const sample     = rows.slice(0, 50).map(r => keys.map(k => `${k}=${r[k] ?? ''}`).join(' | ')).join('\n');
    const regionKeys = keys.filter(k => /region/i.test(k));
    const lqlRegions = [...new Set(rows.flatMap(r => regionKeys.map(k => r[k])).filter(Boolean))];
    if (guardBusy()) return;
    history.push({
      role: 'user',
      content: `Security finding data from LQL query "${query.id}" — ${count} rows:\n\n${sample}${formatApiEnrichment(data.api_enrichment)}\n\n${buildReportInstructions()}${_regulatoryContext(lqlRegions)}`,
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

el('investigate-btn').addEventListener('click', runCloudInvestigation);
el('investigate-prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter') runCloudInvestigation();
});

// Cloud Investigation output matches Assisted Investigation's two-part layout:
// a results card (via appendResultCard, same .lql-query-preview/.lql-row-note
// classes as the "Generated LQL" preview) built once the full tool-call trail
// is known, followed by the narrative answer as a plain chat bubble. Progress
// during the stream shows only in the drawer's status/boat spinner, same as
// Assisted Investigation's "running…" + boat while /lql/generate is in flight
// — the trail itself isn't revealed incrementally in the log because
// appendResultCard's History-pane copy is a one-time clone, not a live
// mirror, so building the card before the trail is complete would leave the
// History pane permanently missing later steps.
async function runCloudInvestigation() {
  const prompt = el('investigate-prompt').value.trim();
  if (!prompt) return;
  if (guardBusy()) return;

  const btn      = el('investigate-btn');
  const statusEl = el('investigate-status');
  const boatEl   = el('investigate-boat');
  const trailEl  = el('investigate-wake-trail');

  btn.disabled = true;
  statusEl.textContent = 'investigating…';
  statusEl.className   = '';
  startSailing(boatEl, trailEl);

  busy = true;
  el('send').disabled = true;

  const steps = [];
  let finalText = '';
  try {
    const res = await fetch(BASE_URL + '/mcp/investigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'tool_call') {
          steps.push({ tool: ev.tool, summary: null });
          statusEl.textContent = `🔧 ${ev.tool}…`;
        } else if (ev.type === 'tool_result') {
          const last = steps[steps.length - 1];
          if (last) last.summary = ev.summary;
        } else if (ev.type === 'final') {
          finalText = ev.text || '';
        }
      }
    }

    el('lql-panel').classList.remove('open');

    // Results card — same visual language as the "Generated LQL" collapsible
    // preview (.lql-query-preview / .lql-row-note), just listing tool calls
    // instead of a query string.
    const resultsEl = document.createElement('div');
    resultsEl.className = 'lql-result-body';
    const details = document.createElement('details');
    details.className = 'lql-query-preview';
    details.open = true;
    const summaryEl = document.createElement('summary');
    summaryEl.textContent = `▶ ${steps.length} tool call${steps.length !== 1 ? 's' : ''}`;
    details.appendChild(summaryEl);
    steps.forEach(s => {
      const row = document.createElement('div');
      row.className = 'lql-row-note';
      row.textContent = `🔧 ${s.tool} — ${s.summary || '(no result)'}`;
      details.appendChild(row);
    });
    resultsEl.appendChild(details);
    appendResultCard('🔎', `Cloud Investigation: ${prompt}`, resultsEl);

    // Narrative answer, as a plain AI turn — the model's answer is already
    // final (no second LLM call needed, unlike Assisted Investigation's
    // send(true)), so render it directly the same way a static AI message
    // (e.g. the greeting) renders: markdown + copy/PDF buttons, no visible
    // user bubble, matching Assisted Investigation's own report step.
    if (finalText) {
      history.push({ role: 'user', content: prompt });
      history.push({ role: 'assistant', content: finalText });
      appendTurn('ai', finalText);
    }
    statusEl.textContent = 'done';
    statusEl.className   = 'ok';
  } catch (err) {
    statusEl.textContent = `✗ ${err.message}`;
    statusEl.className   = 'err';
    appendTurn('system', `Cloud Investigation failed: ${err.message}`);
  } finally {
    busy = false;
    el('send').disabled = false;
    btn.disabled = false;
    stopSailing(boatEl, trailEl);
    scrollLog();
  }
}

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

// Kick off an AI-assisted scoping conversation after an LQL error.
// Injects a hidden user message with error context so Claude asks targeted
// clarifying questions. After the AI responds, a "Re-run LQL" quick-action
// button appears so the user can retry with a refined objective.
function _startLqlScopingConversation(objective, errorMsg) {
  if (guardBusy()) return;
  const scopingPrompt = [
    `The user tried to run a FortiCNAPP LQL security investigation with this objective:`,
    `"${objective}"`,
    ``,
    `It failed with: ${errorMsg}`,
    ``,
    `As a CISO-level FortiCNAPP expert, ask 2–4 targeted scoping questions to clarify intent.`,
    `Cover only what is missing — typical gaps include: cloud provider (AWS/GCP/Azure),`,
    `resource type (hosts, containers, S3 buckets, IAM roles…), severity filter (CRITICAL/HIGH),`,
    `time window (last 7d / 30d / custom), and account or environment scope (prod/staging/all).`,
    ``,
    `After your questions, end with a blank line then a best-guess refined objective on its own line`,
    `in exactly this format (no quotes around the text):`,
    `**Proposed objective:** <refined one-sentence objective>`,
    ``,
    `The user can answer your questions then click Re-run to execute the query with the proposed`,
    `objective updated to reflect their answers.`,
  ].join('\n');

  history.push({ role: 'user', content: scopingPrompt });
  // Show the user-facing version in chat (without the raw prompt internals)
  appendTurn('user', `Investigation: "${objective}" — scoping needed`);

  // After AI responds, attach a Re-run button to its bubble
  const bubble = appendTurn('ai');
  const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
  bubble.appendChild(cursor);
  busy = true;
  el('send').disabled = true;

  const gw      = el('gateway').value || 'bifrost';
  const profile = GATEWAYS[gw] || GATEWAYS.bifrost;
  const key     = keyInput.value.trim();
  const baseUrl = urlInput.value.trim().replace(/\/+$/, '');
  const headers = profile.headers(key, gw === 'helicone' ? key2Input.value.trim() : undefined);

  setStatus('scoping…', 'busy');
  fetch(`${baseUrl}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: el('model').value, max_tokens: MAX_TOKENS,
      stream: true, system: SYSTEM_PROMPT, messages: history,
      tools: [WEB_SEARCH_TOOL],
    }),
  }).then(async res => {
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const { out } = await readStream(res, bubble, cursor);
    cursor.remove();
    if (out) {
      const node = document.createElement('span');
      setRendered(node, renderMarkdown(out));
      bubble.appendChild(makeCopyBtn(out));
      bubble.appendChild(makePdfBtn(node));
      if (bubble._allBody) {
        bubble._allBody.appendChild(makeCopyBtn(out));
        bubble._allBody.appendChild(makePdfBtn(bubble._allBody.querySelector('.content') || node));
      }
    }
    history.push({ role: 'assistant', content: out });
    setStatus('ok', 'ok');

    // Extract the proposed objective Claude embedded in its response
    const proposedMatch = out.match(/\*\*Proposed objective:\*\*\s*(.+)/i);
    const proposedObjective = proposedMatch ? proposedMatch[1].trim() : objective;

    // Append a Re-run LQL button — uses the proposed objective, updated with user answers
    const rerunBtn = document.createElement('button');
    rerunBtn.className     = 'rc-copy-btn';
    rerunBtn.textContent   = '⟳ Run query';
    rerunBtn.title         = 'Run the LQL query with the proposed objective above';
    rerunBtn.style.cssText = 'margin-top:6px;display:block;';
    rerunBtn.addEventListener('click', () => {
      el('lql-objective').value = proposedObjective;
      el('lql-gen-btn').click();
    });
    bubble.appendChild(rerunBtn);
    if (bubble._allBody) bubble._allBody.appendChild(rerunBtn.cloneNode(true));
    scrollLog();
  }).catch(err => {
    cursor.remove();
    bubble.textContent = `Error: ${err.message}`;
    history.pop();
    setStatus('error', 'err');
  }).finally(() => {
    busy = false;
    el('send').disabled = false;
    scrollLog();
  });
}

// A little sailboat sails slow, randomly-sized circles around the whole panel — via CSS Motion
// Path (offset-path), not point-to-point jumps, so it actually traces a curved course — leaving
// a brief fading wake behind it while LQL generation/validation/REST-enrichment is in flight.
// Pure fun, no functional role.
let _boatCircleTimeout = null, _wakeTimer = null, _sailFlipTimeout = null;
let _currentCircle = null; // { cx, cy, r, duration, start } — used to compute wake positions

function startSailing(boatEl, trailEl) {
  boatEl.style.display = 'inline-block';
  boatEl.style.setProperty('--dir', 1);

  // Crossing winds — flip the sail to the other side on an irregular timer, independent of
  // travel direction (the boat itself no longer turns to face where it's going).
  const scheduleFlip = () => {
    _sailFlipTimeout = setTimeout(() => {
      const cur = boatEl.style.getPropertyValue('--dir').trim();
      boatEl.style.setProperty('--dir', cur === '-1' ? 1 : -1);
      scheduleFlip();
    }, 2500 + Math.random() * 3500); // every 2.5–6s
  };
  scheduleFlip();

  const pickCircle = () => {
    const r      = 40 + Math.random() * 90;              // random size: 40–130px radius
    const margin = 15;
    const spanX  = Math.max(10, window.innerWidth  - 2 * (margin + r));
    const spanY  = Math.max(10, window.innerHeight - 2 * (margin + r));
    const cx     = margin + r + Math.random() * spanX;
    const cy     = margin + r + Math.random() * spanY;
    const duration = 10 + Math.random() * 8;             // slow: 10–18s per full lap
    boatEl.style.offsetPath = `circle(${r.toFixed(1)}px at ${cx.toFixed(1)}px ${cy.toFixed(1)}px)`;
    boatEl.style.animationDuration = `2.2s, ${duration}s`; // [boat-rock, boat-sail], must match declaration order
    return { cx, cy, r, duration, start: Date.now() };
  };

  const scheduleNext = () => {
    _currentCircle = pickCircle();
    _boatCircleTimeout = setTimeout(scheduleNext, _currentCircle.duration * 1000);
  };
  scheduleNext();

  // Drop a wake ripple at the boat's current point on its circle — computed from elapsed time
  // rather than tracked via transition events, since offset-path motion isn't driven by JS.
  _wakeTimer = setInterval(() => {
    if (!_currentCircle) return;
    const { cx, cy, r, duration, start } = _currentCircle;
    const elapsed = ((Date.now() - start) / 1000) % duration;
    const angle   = (elapsed / duration) * 2 * Math.PI;
    const wx = cx + r * Math.cos(angle);
    const wy = cy + r * Math.sin(angle);

    const wake = document.createElement('span');
    wake.className = 'lql-wake';
    wake.textContent = '〰️';
    wake.style.left = `${wx.toFixed(1)}px`;
    wake.style.top  = `${(wy + 14).toFixed(1)}px`;
    trailEl.appendChild(wake);
    setTimeout(() => wake.remove(), 1700);
  }, 900);
}
function stopSailing(boatEl, trailEl) {
  clearTimeout(_boatCircleTimeout);
  clearInterval(_wakeTimer);
  clearTimeout(_sailFlipTimeout);
  _currentCircle = null;
  boatEl.style.display = 'none';
  trailEl.innerHTML = '';
}

el('lql-gen-btn').addEventListener('click', async () => {
  const objective = el('lql-objective').value.trim();
  if (!objective) return;

  const btn      = el('lql-gen-btn');
  const statusEl = el('lql-gen-status');
  const boatEl   = el('lql-gen-boat');
  const trailEl  = el('lql-gen-wake-trail');

  btn.disabled         = true;
  statusEl.textContent = 'running…';
  statusEl.className   = '';
  startSailing(boatEl, trailEl);
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
      const cveMatch = objective.match(/CVE-\d{4}-\d{4,}/i);
      if (cveMatch) {
        const cveId = cveMatch[0].toUpperCase();
        statusEl.textContent = `↪ running CVE tab for ${cveId}`;
        statusEl.className   = 'ok';
        el('lql-panel').classList.remove('open');
        el('cve-panel').classList.add('open');
        el('codesec-panel').classList.remove('open');
        el('compliance-panel').classList.remove('open');
        el('cve-input').value = cveId;
        await runCveSearch();
      } else {
        statusEl.textContent = '⚠ Use CVE tab';
        statusEl.className   = 'err';
        el('lql-gen-results').innerHTML = `<div class="lql-row-note" style="padding:8px 2px;color:var(--dim)">${data.note || ''}</div>`;
      }
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

    // Show the actual generated LQL — collapsed by default, but the query itself must always
    // be visible somewhere. It was previously captured (_genQueryText) and used to run the
    // query but never rendered anywhere in the UI.
    if (_genQueryText) {
      const details = document.createElement('details');
      details.className = 'lql-query-preview';
      const summary = document.createElement('summary');
      summary.textContent = '▶ Generated LQL';
      const pre = document.createElement('pre');
      pre.textContent = _genQueryText;
      details.append(summary, pre);
      resultsEl.appendChild(details);
    }

    if (!rows.length) {
      resultsEl.innerHTML += '<div class="lql-row-note" style="padding:8px 2px">No results.</div>';
      appendResultCard('📊', `LQL: ${label}`, resultsEl);
      return;
    }

    renderLqlTable(resultsEl, rows, total, label);
    appendResultCard('📊', `LQL: ${label} — ${statusEl.textContent}`, resultsEl);

    const keys    = Object.keys(rows[0]);
    const sample  = rows.slice(0, 50).map(r => keys.map(k => `${k}=${r[k] ?? ''}`).join(' | ')).join('\n');
    // Extract regions from row data for regulatory context
    const regionKeys = keys.filter(k => /region/i.test(k));
    const lqlRegions = [...new Set(rows.flatMap(r => regionKeys.map(k => r[k])).filter(Boolean))];
    if (guardBusy()) return;
    history.push({
      role: 'user',
      content: `Security finding data from LQL query "${label}" — ${count} rows:\n\n${sample}${formatApiEnrichment(data.api_enrichment)}\n\n${buildReportInstructions()}${_regulatoryContext(lqlRegions)}`,
    });
    send(true);
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
    setStatus('LQL error', 'err');
    _startLqlScopingConversation(objective, e.message);
  } finally {
    btn.disabled = false;
    stopSailing(boatEl, trailEl);
  }
});

// ── LQL table renderer ───────────────────────────────────────────────────────
function renderLqlTable(containerEl, rows, totalRows, queryLabel) {
  containerEl.innerHTML = '';

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
