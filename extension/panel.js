'use strict';

import { CreateMLCEngine } from './vendor/web-llm/web-llm.js';

console.log('[panel.js] build 2026-09-11-lql-save-debug');

// ── Constants ─────────────────────────────────────────────────────────────
const BASE_URL       = 'http://localhost:45321';
// 8192, not 4096: the Risk Hunting / CVE report template now requires one row per matching
// resource (up to the 200-row sample cap in the LQL report call sites below) — a low cap here
// truncates the table mid-row, silently dropping resources from the report.
const MAX_TOKENS     = 8192;
const PAGE_MAX_CHARS = 12000;
const SYSTEM_PROMPT = `You are a security engineer having a terminal-style chat — answer like a CLI tool would, not like you're writing a report. Be concise and direct: minimum words to convey the answer fully, no repetition, no filler, no walls of text, no exec-summary preamble.

## Structure
If the user's message includes an explicit report template, follow that EXACTLY instead of everything below — it takes precedence (this applies to Risk Hunting / CVE report generation, not normal chat). Otherwise:
- Lead with the answer, not a restatement of the question.
- Plain prose and short bullet lists by default — one fact per line, no filler sentences around them.
- A resource/identifier stands on its own line as \`inline code\` (e.g. \`i-0abc123\` — \`ec2\` — \`us-east-1\`), not padded into a table row, unless there are genuinely many resources (5+) with several attributes each where a Markdown table is actually more scannable than a list.
- Fenced code blocks for actual commands/config only.
- Skip sections that don't apply — no empty "Fix" heading when there's nothing to fix, no headings at all for a short answer.

## Rules
- No badges, no colored callouts, no card layouts, no raw HTML of any kind — plain Markdown only.
- For non-security questions, just answer directly.

## Help / identity
Only when the user directly asks something like "what can you do", "help", "who are you", or "what's your name" — never unprompted, never prepended to an unrelated answer — reply warmly, positively, like a friendly human colleague (not a corporate script), covering:
- Your name is **FortiAIScout** — a Cloud Security Engineer sitting next to them while they browse.
- Explicitly state: you rely on **FortiCNAPP** to detect Risk Findings across Public Cloud environments (compliance reports, CVE lookups, LQL queries, full cloud posture investigation).
- Quick capability list: Explain selected text (drops it into this chat) · TL;DR page summaries · right-click "Ask AI about selection" (works on any page, even PDFs) · Scan Code (SCA + SAST) · FortiCNAPP tools (Compliance, Risk Hunting, Attack Surface) · Admin (swap AI gateway/model).
Keep it upbeat and human, not a wall of bullet-point marketing copy.`;
const ROLE_LABELS    = { user: 'you', ai: 'ai', system: 'sys' };

// Shown next to the cursor while the model loads/generates — removed the moment the first
// token streams in, so it never lingers alongside real output.
const GENAI_FUN_FACTS = [
  'GPT stands for "Generative Pre-trained Transformer" — the Transformer architecture behind it was introduced by Google in 2017.',
  'Large language models don\'t "look up" answers — they predict the next token, one at a time, from patterns learned during training.',
  'A "token" isn\'t a word — it\'s often a word-piece; "unbelievable" might be split into "un", "believ", "able".',
  'Quantization (e.g. q4f16) shrinks a model\'s weights to 4-bit precision — a ~4x size cut with only a small accuracy tradeoff.',
  'WebGPU lets a browser tap your GPU directly for tensor math — no plugin, no native app, just JavaScript.',
  'Temperature controls randomness: 0 is deterministic and repeatable, higher values let the model take creative risks.',
  '"Hallucination" is when a model states something fluent and confident that isn\'t true — a known failure mode of next-token prediction.',
  'The context window is the model\'s working memory — everything outside it is simply invisible to the next prediction.',
  'Chain-of-thought prompting — asking a model to "think step by step" — can noticeably improve reasoning accuracy on hard questions.',
  'Running a model fully on-device (like this extension does) means your prompts never leave your machine.',
];
function randomFunFact() {
  return GENAI_FUN_FACTS[Math.floor(Math.random() * GENAI_FUN_FACTS.length)];
}
function makeFunFact() {
  const span = document.createElement('span');
  span.className   = 'fun-fact';
  span.textContent = `${randomFunFact()}`;
  return span;
}

// ── On-device model (WebLLM / WebGPU) ──────────────────────────────────────
// Qwen3-4B was replaced: too greedy/verbose for report generation even with prompt tuning.
// Qwen2.5-3B-Instruct is the default — generation speed on WebGPU scales with parameter count,
// and 7B was too slow for interactive chat on non-discrete GPUs. Qwen2.5-7B-Instruct and
// Qwen2.5-Coder-7B remain as opt-in alternatives when quality matters more than speed (7B is
// noticeably better at complex report reasoning; Coder-7B for code-heavy CodeSec/SBOM
// follow-up). Low temperature (0.2) on all these for deterministic, repeatable report output
// rather than creative variation.
// Phi-3.5-vision-instruct is the only vision-capable (ModelType.VLM) model this vendored
// WebLLM build supports — Qwen2.5-VL has no MLC-compiled weights and no architecture support
// in web-llm.js, so it can't be added (see web-llm.js's ModelType/model_type entries). Works
// fine as a plain text chat model too (VLM models accept text-only messages), so it's listed
// here alongside the text-only models rather than gated behind a separate "vision mode".
const WEBLLM_MODELS = {
  'Qwen2.5-3B-Instruct-q4f16_1-MLC': 'Qwen2.5-3B-Instruct (fast)',
  'Qwen2.5-7B-Instruct-q4f16_1-MLC': 'Qwen2.5-7B-Instruct',
  'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC': 'Qwen2.5-Coder-7B',
  'Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC': 'Hermes-2-Pro-Llama-3-8B',
  'Hermes-3-Llama-3.1-8B-q4f16_1-MLC': 'Hermes-3-Llama-3.1-8B',
  'Phi-3.5-vision-instruct-q4f16_1-MLC': 'Phi-3.5-vision-instruct',
};
const DEFAULT_WEBLLM_MODEL = 'Qwen2.5-3B-Instruct-q4f16_1-MLC';
const CHAT_TEMPERATURE = 0.2;

// WebLLM's `tools`/tool_choice support is implemented only for these Hermes variants (see
// web-llm.js's hermes2FunctionCallingSystemPrompt) — none of the Qwen2.5 models can drive
// FortiCNAPP Search on-device. Checked before starting that loop so it fails fast with a
// message pointing at Hermes instead of letting WebLLM throw mid-request.
const TOOL_CALLING_MODELS = new Set([
  'Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f16_1-MLC',
]);
let webllmModel = localStorage.getItem('webllm_model') || DEFAULT_WEBLLM_MODEL;
if (!WEBLLM_MODELS[webllmModel]) webllmModel = DEFAULT_WEBLLM_MODEL;
let enginePromise = null;
let engineModel = null;

// Both Qwen2.5-7B variants and Phi-3.5-vision-instruct default context_window_size to 4096 in
// WebLLM's prebuilt config — too small for the Risk Hunting / CVE report prompts (row data +
// template routinely exceeds 8k input tokens alone, before MAX_TOKENS of output). Override to
// 16384, comfortably above MAX_TOKENS + the 100-row prompt cap, while staying within what
// q4f16_1's KV cache can hold on typical GPUs. Hermes-2-Pro-Llama-3-8B (Cloud Investigation
// on-device's tool-calling model) needs this too — its MCP tool-schema prompt alone runs
// ~11.5k tokens, above even an 8192 window — so there's no smaller window that both fits the
// prompt and reduces VRAM pressure; GPU memory constraints have to be solved by freeing VRAM
// elsewhere, not by shrinking this.
function getEngine(onProgress) {
  if (!enginePromise) {
    engineModel = webllmModel;
    enginePromise = CreateMLCEngine(webllmModel, {
      initProgressCallback: onProgress,
    }, {
      context_window_size: 16384,
    });
    // A failed load must not stick around as a permanently-rejected cached promise —
    // otherwise every future getEngine() call replays the same failure forever.
    enginePromise.catch(() => { enginePromise = null; engineModel = null; });
  } else if (engineModel !== webllmModel) {
    engineModel = webllmModel;
    enginePromise = enginePromise.then(engine =>
      engine.reload(webllmModel, { context_window_size: 16384 }).then(() => engine)
    );
    enginePromise.catch(() => { enginePromise = null; engineModel = null; });
  }
  return enginePromise;
}

// WebGPU can invalidate the device out from under an already-created engine (GPU process
// reset, side panel suspended/resumed, laptop sleep, etc.) — e.g. "A valid external Instance
// reference no longer exists." The engine object is cached at module scope, so without this
// the same dead engine would be reused and fail identically on every subsequent attempt until
// the extension is manually reloaded. Detect that class of error and drop the cache so the next
// call rebuilds the engine from scratch.
function invalidateEngineOnGpuError(err) {
  if (/instance reference|device.*lost|lost.*device|invalid.*gpu/i.test(err?.message || '')) {
    enginePromise = null;
    engineModel = null;
  }
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// WebLLM's initProgressCallback `.text` is a verbose per-shard status line (e.g.
// "Fetching param cache[35/62]: 999MB fetched. 60% completed, 34 secs elapsed...") —
// too long/noisy for the status bar. Show a short phase label + percentage instead.
function formatLoadProgress(p) {
  const pct = Number.isFinite(p?.progress) ? Math.round(p.progress * 100) : null;
  const text = p?.text || '';
  let phase = 'loading model';
  if (/param cache/i.test(text))       phase = 'downloading weights';
  else if (/fetching wasm/i.test(text)) phase = 'downloading runtime';
  else if (/loading model|shader|gpu/i.test(text)) phase = 'initializing';
  return pct === null ? phase : `${phase}… ${pct}%`;
}

// ── State ─────────────────────────────────────────────────────────────────
const history = [];
let busy = false;

// ── DOM refs ──────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);

const setStatus = (text, state = '') => {
  el('status').textContent = text;
  el('status').className   = state;
};

// ── Storage ───────────────────────────────────────────────────────────────
autoFillFromConfig();

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

  const lwReady = cfg.lw_ready !== false;   // creds — LQL/CVE/Compliance
  const lwCli   = cfg.lw_cli   !== false;   // CLI binary — CodeSec/SBOM

  [['codesec', lwCli,   '⚠ lacework CLI not installed — CodeSec unavailable'],
   ['compliance', lwReady, '⚠ FortiCNAPP credentials not found (add ~/.lacework.toml)'],
   ['lql',        lwReady, '⚠ FortiCNAPP credentials not found (add ~/.lacework.toml)'],
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

  const tenantEl = el('fcnapp-tenant');
  if (tenantEl && cfg.lw_account) {
    tenantEl.innerHTML = `Tenant: <strong>${esc(cfg.lw_account)}</strong>`;
    tenantEl.style.display = 'flex';
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
  appendTurn('ai', `**${greeting()}${name}!** I'm **FortiAIScout** — think of me as a Cloud Security Engineer sitting next to you, enabling Cloud Risk Findings Hunting.`);
}
showGreeting();


// ── Markdown renderer ─────────────────────────────────────────────────────
// Escape before transform so model output cannot inject HTML.
// Radar/spider chart for a small set of 0-100 risk axes (e.g. CVE risk profile).
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
  const copyBtn = node._copyBtn || null;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  node.replaceChildren(tpl.content.cloneNode(true));
  if (copyBtn) node.appendChild(copyBtn);
}

// ── Chat log (single continuous pane) ────────────────────────────────────
function scrollLog() {
  const pane = el('log-latest');
  if (pane) pane.scrollTop = pane.scrollHeight;
}

function _appendToLog(node) {
  el('log-latest').appendChild(node);
  scrollLog();
}

// Insert a session separator marking the start of a new FortiCNAPP feature, without
// clearing prior turns — the log is one continuous history now, not archived per-feature.
function startNewSession(label) {
  if (!el('log-latest').children.length) return;
  history.length = 0; // resets AI context so the new feature session starts with a clean slate
  const sep = Object.assign(document.createElement('div'), { className: 'session-sep' });
  sep.textContent = label;
  el('log-latest').appendChild(sep);
}

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
      'rpt-table':         'width:100%;border-collapse:collapse;margin:10px 0;font-size:11.5px;box-shadow:0 0 0 1px #e0e0e0;border-radius:8px;overflow:hidden;',
      'rpt-badge':         'display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:600;padding:2px 8px;border-radius:100px;text-transform:uppercase;letter-spacing:.3px;background:#eee;color:#666;',
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
      const sevColours = { critical: '#dc2626', high: '#d97706' };
      for (const [sev, col] of Object.entries(sevColours)) {
        if (el.classList.contains(sev) && el.classList.contains('rpt-badge')) {
          el.style.cssText += `background:${col}1f;color:${col};`;
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

  // ai turn: body is live-updated during streaming
  if (role === 'ai') {
    col.append(lbl, body);

    // Static text (greeting, page-loaded, etc.) — add copy + PDF buttons immediately
    if (text) {
      col.appendChild(makeCopyBtn(text));
      col.appendChild(makePdfBtn(body));
    }

    el('log-latest').appendChild(turn);
    scrollLog();
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

el('read-page').addEventListener('click', () => withPage('read-page', async page => {
  if (guardBusy()) return;
  if (!page.text) {
    appendTurn('system',
      'No text selected — select some text on the page, then click Explain. ' +
      '(In a PDF, use right-click → "Ask AI about selection" instead.)');
    setStatus('no selection', 'err');
    return;
  }
  openSelectionInChat(page.text);
}, readSelectedText));

el('tldr').addEventListener('click', () => withPage('tldr', async page => {
  if (guardBusy()) return;
  history.push({ role: 'user',      content: pageCtx(page) });
  history.push({ role: 'assistant', content: 'Page loaded.' });
  history.push({ role: 'user',      content:
    'Summarize this page. Read the actual content and compress it to the shortest form that keeps every ' +
    'material fact and its meaning intact — no filler, no restating the page title, nothing padded out for ' +
    'the sake of structure. One fact or claim per bullet, in YOUR OWN WORDS — never copy a sentence or run of ' +
    'sentences straight from the page; a bullet that isn\'t shorter than the passage it summarizes is not a ' +
    'summary, rewrite it. ' +
    'If the page covers multiple distinct topics (or, for a changelog/release-notes page, multiple months or ' +
    'versions), group bullets under a short "### <topic>" heading per group — otherwise just a flat bullet list, ' +
    'no headings needed for a single narrow topic. ' +
    'Always cite sources: end each bullet, or each topic group, with a markdown link to the most relevant URL ' +
    'actually on the page — never omit this, never invent a URL. ' +
    'Start directly with the first bullet or heading — no preamble, no "Here is the summary" or similar opener, ' +
    'not even if you look something up mid-answer and resume afterward.' });
  appendTurn('system', `TL;DR — "${page.title}"`);
  el('read-page').classList.add('active');
  await send(true); // user turn already pushed above; silent avoids re-appending it
}));

// Defensive no-op for the current models (Qwen2.5-Instruct/Coder don't emit these) —
// kept in case a future reasoning-style model is added; strips <think>...</think> blocks
// from both the rendered bubble and stored history, including a still-open trailing
// <think> so partial reasoning never flashes on screen mid-stream.
function stripThink(s) {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/^\s+/, '');
}

// ── Stream consumer (WebLLM's AsyncGenerator of OpenAI-shaped chunks) ─────
// funFact: removed (both panes) the moment the first real token arrives, so it never
// overlaps rendered output.
async function readStream(chunks, bubble, cursor, funFact) {
  let raw = '', out = '', inputTk = 0, outputTk = 0;

  for await (const chunk of chunks) {
    if (chunk.usage) {
      inputTk  = chunk.usage.prompt_tokens ?? inputTk;
      outputTk = chunk.usage.completion_tokens ?? outputTk;
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      if (funFact) {
        funFact.remove();
        funFact = null;
      }
      raw += delta;
      out = stripThink(raw);
      setRendered(bubble, renderMarkdown(out));
      bubble.appendChild(cursor);
      scrollLog();
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
  const funFact = makeFunFact();
  bubble.append(funFact, cursor);
  busy = true;
  el('send').disabled = true;

  try {
    setStatus('loading model…', 'busy');
    const engine = await getEngine(p => setStatus(formatLoadProgress(p), 'busy'));

    setStatus('streaming…', 'busy');
    const chunks = await engine.chat.completions.create({
      model: webllmModel, max_tokens: MAX_TOKENS, temperature: CHAT_TEMPERATURE, stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    });

    const { out, inputTk, outputTk } = await readStream(chunks, bubble, cursor, funFact);
    cursor.remove();
    funFact.remove();
    if (out) {
      const node = document.createElement('span');
      setRendered(node, renderMarkdown(out));
      bubble.appendChild(makeCopyBtn(out));
      bubble.appendChild(makePdfBtn(node));
    }
    history.push({ role: 'assistant', content: out });
    setStatus('ok', 'ok');
    el('token-info').textContent = `in:${inputTk} out:${outputTk}`;
    return bubble;
  } catch (err) {
    invalidateEngineOnGpuError(err);
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

// Shared batching for opt-in AI analysis: processes `items` in chunks of `batchSize`,
// appending a "Continue analysis" button to the AI's reply so the next chunk only runs
// if the user asks for it — reports on large result sets (CVE hosts, LQL rows) would
// otherwise burn one huge, slow generation the user never asked to wait for.
//
// `useServerSide: true` (CVE/Attack Surface only) sends the prompt to
// serve.py's /analysis/generate instead of running it on-device — pinned server-side to
// Claude Haiku-4.5 via Bifrost, same upstream as /mcp/investigate and /mcp/forensic, so
// this report reads identically regardless of which on-device model the user has picked
// in the Admin menu. LQL analysis stays on-device (useServerSide omitted/false there).
async function _runBatchedAnalysis(items, batchSize, buildPrompt, describeTurn, useServerSide = false) {
  let cursor = 0;
  const total = items.length;

  async function runBatch() {
    if (guardBusy()) return false;
    const batch = items.slice(cursor, cursor + batchSize);
    const batchNum = Math.floor(cursor / batchSize) + 1;
    const totalBatches = Math.ceil(total / batchSize);
    const prompt = buildPrompt(batch, cursor, total);
    history.push({ role: 'user', content: prompt });
    appendTurn('user', describeTurn(batch, cursor, total, batchNum, totalBatches));
    const bubble = useServerSide ? await _sendServerSideAnalysis(prompt) : await send(true);
    cursor += batch.length;
    if (!bubble) return false; // fetch/API error already rendered by the send helper
    if (cursor < total) {
      const btn = document.createElement('button');
      btn.className   = 'rc-copy-btn rc-analyse-btn';
      btn.style.cssText = 'margin-top:6px;display:block;';
      btn.textContent = `▶ Continue analysis (${total - cursor} more)`;
      btn.addEventListener('click', () => {
        btn.disabled    = true;
        btn.textContent = '⏳ analysing…';
        runBatch();
      }, { once: true });
      bubble.appendChild(btn);
    }
    return true;
  }

  return runBatch();
}

// Non-streaming counterpart to send() for server-side (Bifrost/Claude Haiku-4.5) report
// generation — same bubble/history/status bookkeeping as send(), but a single fetch to
// serve.py's /analysis/generate instead of an on-device engine.chat.completions.create call.
async function _sendServerSideAnalysis(prompt) {
  if (busy) return null;
  const bubble = appendTurn('ai');
  const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
  const funFact = makeFunFact();
  bubble.append(funFact, cursor);
  busy = true;
  el('send').disabled = true;

  try {
    setStatus('analysing (Bifrost, Haiku-4.5)…', 'busy');
    const res = await fetch(BASE_URL + '/analysis/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `API ${res.status}`);
    const out = data.text || '';

    cursor.remove();
    funFact.remove();
    if (out) {
      // Unlike send()'s streaming path (readStream renders into `bubble` incrementally as
      // chunks arrive, so `bubble` already shows content by the time this block runs), this is
      // a single non-streaming response — nothing has been rendered into the DOM yet. The
      // rendered node must actually be appended to `bubble`, not just built and discarded.
      const node = document.createElement('span');
      setRendered(node, renderMarkdown(out));
      bubble.appendChild(node);
      bubble.appendChild(makeCopyBtn(out));
      bubble.appendChild(makePdfBtn(node));
    }
    history.push({ role: 'assistant', content: out });
    setStatus('ok', 'ok');
    return bubble;
  } catch (err) {
    cursor.remove();
    bubble.textContent = `Error: ${err.message}`;
    history.pop();
    setStatus('error', 'err');
    return null;
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

// ── Admin dropdown toggle (on-device model info) ──────────────────────────
// Same open/close pattern as the FortiCNAPP menu.
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
    if (['model-select', 'server-select', 'gateway-models-fetch', 'gateway-model-select'].includes(e.target.id)
        || !e.target.closest('.admin-item')) return;
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

// ── Model picker (Qwen2.5-3B-Instruct default, 7B-Instruct/Coder-7B alternatives) ──
(function () {
  const sel = el('model-select');
  if (!sel) return;
  for (const [id, label] of Object.entries(WEBLLM_MODELS)) {
    sel.appendChild(new Option(label, id, false, id === webllmModel));
  }
  sel.addEventListener('change', () => {
    webllmModel = WEBLLM_MODELS[sel.value] ? sel.value : DEFAULT_WEBLLM_MODEL;
    localStorage.setItem('webllm_model', webllmModel);
  });
})();

// ── Server-side (Bifrost) model picker ─────────────────────────────────────
// ── Server selector (Bifrost / Local llama-cpp / on-device WebGPU) ─────────────
// 'webgpu' routes all of Risk Hunting (LQL Builder generation, CVE/Attack Surface AI
// analysis, FortiCNAPP Search) through the already-loaded WebLLM engine instead of any
// server-side gateway — no /gateway/switch call, since serve.py has no upstream concept
// for it (there's no server-side model at all in this mode).
function isOnDeviceRiskHunting() {
  return localStorage.getItem('server_choice') === 'webgpu';
}

(function () {
  const serverSel = el('server-select');
  if (!serverSel) return;
  const saved = localStorage.getItem('server_choice') || 'bifrost';
  serverSel.value = saved;

  function resetServerModelPicker() {
    const modelSel = el('gateway-model-select');
    const fetchBtn = el('gateway-models-fetch');
    if (modelSel && fetchBtn) {
      modelSel.innerHTML = '';
      modelSel.style.display = 'none';
      fetchBtn.style.display = 'inline-block';
    }
  }

  // serve.py's upstream (DIRECT_UPSTREAM/VIRTUAL_KEY) is an in-memory global, reset to the
  // .env default (Bifrost) on every process restart — it does NOT persist across restarts
  // the way this extension's own localStorage choice does. So a saved 'local'/'bifrost'
  // choice from a previous session can silently drift out of sync with what serve.py is
  // actually pointed at right now (e.g. after `docker compose restart` or `python3 serve.py`
  // relaunch) until the user manually re-picks the dropdown. Re-issue the switch on every
  // load for 'bifrost'/'local' so the two stay in sync without requiring that manual step.
  async function applyServerChoice(choice, { revertTo } = {}) {
    if (choice === 'webgpu') {
      resetServerModelPicker();
      const fetchBtn = el('gateway-models-fetch');
      if (fetchBtn) fetchBtn.style.display = 'none';
      return;
    }
    try {
      const res = await fetch(BASE_URL + '/gateway/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateway: choice })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      resetServerModelPicker(); // clear cached models so next fetch uses the new server
      const fetchBtn = el('gateway-models-fetch');
      if (fetchBtn) fetchBtn.style.display = 'inline-block';
    } catch (e) {
      console.error('Server switch failed:', e);
      if (revertTo !== undefined) serverSel.value = revertTo; // revert on error
    }
  }

  serverSel.addEventListener('change', () => {
    const choice = serverSel.value;
    localStorage.setItem('server_choice', choice);
    applyServerChoice(choice, { revertTo: saved });
  });

  applyServerChoice(saved); // resync serve.py to the persisted choice on every load
})();

// Fetches the gateway's live model catalog (GET /gateway/models, server-side so
// the API key never touches the browser) instead of hardcoding model ids that
// drift out of sync with what Bifrost actually has configured. Selecting one
// POSTs /model, which persists it as ANTHROPIC_DEFAULT_MODEL for /lql/generate
// (the only server-side caller that honors this — /mcp/investigate and
// /mcp/forensic are pinned to Claude regardless, see serve.py).
(function () {
  const fetchBtn = el('gateway-models-fetch');
  const sel      = el('gateway-model-select');
  const statusEl = el('gateway-models-status');
  if (!fetchBtn || !sel) return;

  fetchBtn.addEventListener('click', async () => {
    fetchBtn.disabled = true;
    statusEl.textContent = 'fetching…';
    try {
      const res = await fetch(BASE_URL + '/gateway/models');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      sel.innerHTML = '';
      (data.models || []).forEach(id => sel.appendChild(new Option(id, id)));
      sel.style.display = 'block';
      fetchBtn.style.display = 'none';
      statusEl.textContent = `${data.models.length} models`;
    } catch (e) {
      statusEl.textContent = `✗ ${e.message}`;
    } finally {
      fetchBtn.disabled = false;
    }
  });

  sel.addEventListener('change', async () => {
    const model = sel.value;
    if (!model) return;
    statusEl.textContent = 'saving…';
    try {
      const res = await fetch(BASE_URL + '/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      statusEl.textContent = `✓ ${model}`;
    } catch (e) {
      statusEl.textContent = `✗ ${e.message}`;
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

// Per-extension icon for the GitHub repo card's file tree — purely cosmetic.
const EXT_ICONS = {
  '.py': '🐍', '.go': '🐹', '.java': '☕', '.js': '📜', '.jsx': '📜', '.mjs': '📜', '.cjs': '📜',
  '.ts': '📘', '.tsx': '📘', '.php': '🐘', '.rb': '💎', '.rs': '🦀', '.tf': '🧱', '.tfvars': '🧱',
  '.yaml': '⚙️', '.yml': '⚙️', '.json': '🔩', '.lock': '🔒',
};
function extIcon(name) {
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return '🐳';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  return EXT_ICONS[ext] || '📄';
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
    if (item.size > 2_000_000) return false; // skip files >2 MB (node_modules/vendor/dist already excluded via SKIP_DIRS)
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

// opts.onAnalyse: if given, a "Generate AI Analysis" button is added to the card footer.
// AI analysis is opt-in — no report auto-triggers a model call anymore; the raw table/data
// always renders on its own, and the user decides whether to spend the extra generation time.
function appendResultCard(icon, title, contentEl, opts = {}) {
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

  const buildAnalyseBtn = () => {
    if (!opts.onAnalyse) return null;
    const btn = document.createElement('button');
    btn.className   = 'rc-copy-btn rc-analyse-btn';
    btn.textContent = 'Generate AI Analysis';
    btn.title       = 'Send this data to the on-device model for a written report (not run automatically)';
    btn.addEventListener('click', async () => {
      btn.disabled    = true;
      btn.textContent = '⏳ analysing…';
      try {
        const ok = await opts.onAnalyse();
        // _runBatchedAnalysis resolves to a falsy bubble on a caught fetch/API error (the
        // error itself is already rendered as an AI turn by _sendServerSideAnalysis/send) —
        // still reset the button so it doesn't stay stuck on "analysing…" for a failed run.
        btn.textContent = ok === false ? 'Generate AI Analysis' : '✓ Analysed';
        btn.disabled    = ok === false ? false : true;
      } catch (err) {
        // A thrown error here (e.g. a malformed prompt build) must not leave the button
        // stuck on "analysing…" forever with no report and no feedback — surface it and
        // re-enable so the user can retry instead of reloading the extension.
        btn.disabled    = false;
        btn.textContent = 'Generate AI Analysis';
        appendTurn('system', `AI analysis failed: ${err.message || err}`);
      }
    });
    return btn;
  };

  const buildCard = (body, analyseBtn) => {
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
    // Footer with copy button (and, when opted in, the AI analysis trigger) always visible
    const footer = document.createElement('div');
    footer.className = 'rc-footer';
    if (analyseBtn) footer.appendChild(analyseBtn);
    footer.appendChild(buildCopyBtn(body));
    card.append(hdr, body, footer);
    return card;
  };

  el('log-latest').appendChild(buildCard(contentEl, buildAnalyseBtn()));
  scrollLog();
}

function appendGithubCard(owner, repo, branch, files) {
  const repoUrl = `https://github.com/${owner}/${repo}`;

  // Group a list of files by directory, rendered as a mini tree: one header
  // row per directory (folder icon + path), files listed vertically underneath —
  // easier to scan than the old wrapped inline-chip layout.
  const buildDirRows = (fileList) => {
    const groups = {};
    fileList.forEach(f => {
      const parts = (f.path || f.filename || '').split('/');
      const dir   = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
      (groups[dir] = groups[dir] || []).push(parts[parts.length - 1]);
    });
    return Object.entries(groups).map(([dir, fnames]) => {
      const dirHeader = dir
        ? `<div class="gh-dir"><span class="gh-dir-icon">📁</span>${esc(dir)}/</div>`
        : '';
      const fileRows = fnames.map(n =>
        `<div class="gh-file"><span class="gh-file-icon">${extIcon(n)}</span>${esc(n)}</div>`
      ).join('');
      return `<div class="gh-dirgroup">${dirHeader}<div class="gh-filelist">${fileRows}</div></div>`;
    }).join('');
  };

  // Categorize into SAST | IaC | SCA | Other before rendering — same buckets
  // the CodeSec scan itself draws from (see categorizeGithubFile).
  const CATEGORY_META = {
    SAST:  { label: 'SAST',  cls: 'sast',  icon: '🛡️' },
    IaC:   { label: 'IaC',   cls: 'iac',   icon: '🏗️' },
    SCA:   { label: 'SCA',   cls: 'sca',   icon: '📦' },
    Other: { label: 'Other', cls: 'other', icon: '📄' },
  };
  const byCategory = { SAST: [], IaC: [], SCA: [], Other: [] };
  files.forEach(f => byCategory[categorizeGithubFile(f.path || f.filename || '')].push(f));

  const sections = Object.keys(CATEGORY_META)
    .filter(cat => byCategory[cat].length)
    .map(cat => {
      const meta = CATEGORY_META[cat];
      return `<details class="gh-cat gh-cat-${meta.cls}" open>` +
        `<summary class="gh-cat-label">` +
          `<span class="gh-cat-icon">${meta.icon}</span>${meta.label}` +
          `<span class="gh-cat-count">${byCategory[cat].length}</span>` +
        `</summary>` +
        `<div class="gh-cat-body">${buildDirRows(byCategory[cat])}</div>` +
      `</details>`;
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
      appendResultCard('', 'FortiCNAPP SBOM', body);
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
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => navigator.clipboard.writeText(data._raw));
      actions.append(dlBtn, copyBtn);
      body.appendChild(actions);
      const pre = document.createElement('pre');
      pre.style.cssText = 'font-size:10px;overflow-x:auto;max-height:200px;background:var(--surface3);padding:6px;border-radius:4px;margin-top:4px;';
      pre.textContent = data._raw.slice(0, 3000) + (data._raw.length > 3000 ? '\n…(truncated)' : '');
      body.appendChild(pre);
      appendResultCard('', 'FortiCNAPP SBOM', body);
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
    copyBtn.textContent = 'Copy JSON';
    copyBtn.addEventListener('click', () => navigator.clipboard.writeText(JSON.stringify(data, null, 2)));
    actions.append(dlBtn, copyBtn);
    body.appendChild(actions);

    if (!components.length) {
      const empty = document.createElement('div');
      empty.className = 'cs-empty';
      empty.textContent = 'No packages detected in page code snippets.';
      body.appendChild(empty);
      appendResultCard('', 'FortiCNAPP SBOM', body);
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
    appendResultCard('', 'FortiCNAPP SBOM', body);
    return;
  }

  // CodeSec mode
  const all = [
    ...(data.secrets   || []).map(f => ({ ...f, _cat: 'Secrets' })),
    ...(data.weaknesses|| []).map(f => ({ ...f, _cat: 'SAST Weaknesses' })),
    ...(data.vulns     || []).map(f => ({ ...f, _cat: 'SCA Vulnerabilities' })),
    ...(data.misconfigs|| []).map(f => ({ ...f, _cat: 'IaC Misconfigurations' })),
  ].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));

  if (!all.length) {
    const ok = document.createElement('div');
    ok.className = 'cs-empty';
    ok.textContent = '✓ No vulnerabilities, weaknesses, secrets, or IaC misconfigurations detected.';
    body.appendChild(ok);
    appendResultCard('', 'FortiCNAPP CodeSec', body);
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
      fixBtn.textContent = 'Fix';
      fixBtn.title = 'Ask FortiAIScout to propose a fix for this finding';
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
  appendResultCard('', 'FortiCNAPP CodeSec', body);
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
      const total = (data.vulns?.length || 0) + (data.weaknesses?.length || 0) + (data.secrets?.length || 0) + (data.misconfigs?.length || 0);
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
        `Compliance PDF: ${fw.name} — opened in a new tab. Select any text in it and ` +
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
  ['codesec-panel', 'compliance-panel'].forEach(id => el(id).classList.remove('open'));
  el('lql-panel').classList.add('open');
  switchLqlTab('cve');
  runCveSearch();
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type !== 'CVE_SELECTED' || !msg.cveId) return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => openCvePanel(msg.cveId));
  } else {
    openCvePanel(msg.cveId);
  }
});

chrome.storage.session.get('pendingCve', ({ pendingCve }) => {
  if (!pendingCve) return;
  chrome.storage.session.remove('pendingCve');
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => openCvePanel(pendingCve));
  } else {
    openCvePanel(pendingCve);
  }
});

// ── Selection-to-chat: "Ask AI about selection" context menu ────────────────
// Works on any page, including a PDF opened in Chrome's built-in viewer (a content
// script can't attach inside the PDF renderer, but the browser-level context menu
// still fires there since contexts:['selection'] isn't scoped by URL match pattern).
const SELECTION_MAX_CHARS = 4000;

function openSelectionInChat(text) {
  ['codesec-panel', 'compliance-panel', 'lql-panel'].forEach(id =>
    el(id).classList.remove('open'));
  const trimmed = text.trim();
  if (!trimmed) return;
  const clipped = trimmed.length > SELECTION_MAX_CHARS
    ? trimmed.slice(0, SELECTION_MAX_CHARS) + '\n[…truncated]'
    : trimmed;
  const quoted = clipped.split('\n').map(l => `> ${l}`).join('\n');

  // If a request is already in flight, fall back to just pre-filling the box —
  // can't safely push a new turn and call send() mid-stream.
  if (busy) {
    el('prompt').value = `${quoted}\n\n`;
    resizePrompt();
    el('prompt').focus();
    el('prompt').setSelectionRange(el('prompt').value.length, el('prompt').value.length);
    setStatus('selection loaded — busy, ask when ready', 'err');
    return;
  }

  history.push({ role: 'user', content: `${quoted}\n\nExplain the above selected text.` });
  appendTurn('user', quoted);
  send(true); // user turn already pushed above; silent avoids re-appending it
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'TEXT_SELECTED' && msg.text) openSelectionInChat(msg.text);
});

chrome.storage.session.get('pendingSelection', ({ pendingSelection }) => {
  if (!pendingSelection) return;
  chrome.storage.session.remove('pendingSelection');
  openSelectionInChat(pendingSelection);
});

// ── FortiCNAPP Attack Surface (CVE) — tab inside the Risk Hunting drawer ────

let _lastCveData = null;

el('cve-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') runCveSearch();
});

el('cve-search').addEventListener('click', runCveSearch);

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
    `IMPORTANT: Add one table row per distinct obligation above (Finding = regulation/obligation name).`,
    `What It Means / Why It Matters = the obligation itself, including anything it requires preserving`,
    `(breach record, access logs, forensic timeline). Next Steps to Remediate = the concrete deadline`,
    `and action, computed from the actual discovery/exposure date given in the data — never invent one.`,
    `If a breach cannot be ruled out, add a row for the notification obligation with its deadline stated explicitly.`,
  );
  return lines.join('\n');
}

// Shared minimalist template for FortiCNAPP Risk Hunting (LQL) and
// Attack Surface (CVE) reports. This OVERRIDES the system prompt's
// default Objective/Findings/Fix structure per its own precedence rule.
const INCIDENT_REPORT_TEMPLATE = `Use EXACTLY this format — a single Markdown table, nothing else. No title, no status/severity
line, no separate remediation section, no other headings or sections before or after the table
(a regulatory radar/risk-profile chart may precede it if one is supplied below — nothing else).
Never invent facts, dates, counts, or context not present in the data provided.

| Finding | What It Means / Why It Matters | Next Steps to Remediate |
|---|---|---|

Rules:
- One row per matching resource — real names/IDs from the data as the Finding, never a placeholder.
- Include EVERY matching resource from the data as its own row — never sample, truncate, or split
  into multiple tables. If 196 resources match, the table has 196 rows.
- "What It Means / Why It Matters": one plain-language sentence — what the resource/finding is and
  why it matters (severity/exposure context if applicable). For pure inventory with no actual risk,
  a short factual description is enough.
- "Next Steps to Remediate": one concrete action. Use an exact command where remediation applies
  (real resource names/IDs, never placeholders). Use "None — informational only" when there is
  nothing to remediate (e.g. plain inventory/listing objectives).
- If a regulatory notification obligation applies to the affected region(s) (given below), add it
  as its own row (Finding = the obligation/regulation name) rather than a separate section.`;

function buildReportInstructions() {
  const today = new Date().toISOString().slice(0, 10);
  return `${INCIDENT_REPORT_TEMPLATE}\n\nToday's date: ${today}`;
}

// Same Finding/Why/Remediate template as CVE analysis, applied to raw LQL rows
// (both the saved-query "LQL" tab and the "LQL Builder"/Assisted Investigation tab).
function buildLqlAnalysisPrompt(rows, label, batch, batchOffset, batchTotal) {
  const data = batch || rows;
  const keys = Object.keys(rows[0] || {});
  const lines = [
    `=== LQL RESULTS: ${label} ===`,
    ``,
    `Total matching rows: ${batchTotal || rows.length}`,
    ``,
  ];
  data.forEach((r, i) => {
    const fields = keys.map(k => `${k}: ${String(r[k] ?? '').slice(0, 300)}`).join(' | ');
    lines.push(`${(batchOffset || 0) + i + 1}. ${fields}`);
  });
  if (batchTotal && batchTotal > data.length) {
    lines.push(``, `(Analysing rows ${(batchOffset || 0) + 1}-${(batchOffset || 0) + data.length} of ${batchTotal} — one row per resource in THIS batch only, not the full set.)`);
  }
  lines.push(``, buildReportInstructions());
  return lines.join('\n');
}

// Computed (not model-authored) risk profile chart prepended to the CVE report's table —
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

function buildCveAnalysisPrompt(d, fgOutbreaks, hostsBatch, batchOffset, batchTotal) {
  const hosts = hostsBatch || d.hosts;
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
  hosts.forEach((h, i) => {
    const flags = [
      h.host_exposed      ? 'HOST-EXPOSED'      : '',
      h.container_exposed ? 'CONTAINER-EXPOSED' : '',
      h.fix_available     ? `fix→${h.fixed_version || fixVer}` : '',
    ].filter(Boolean).join(' ');
    lines.push(`${(batchOffset || 0) + i + 1}. ${h.hostname} [${h.severity}] csp:${h.csp || 'unknown'} instance:${h.instance_id || 'unknown'} type:${h.instance_type || ''} account:${h.account || 'unknown'} region:${h.region || ''} vpc:${h.vpc_id || ''} risk:${h.host_risk_score.toFixed(1)} ${flags}`);
    h.packages.forEach(p  => lines.push(`   pkg: ${p.name} ${p.version}`));
    h.containers.forEach(c => lines.push(`   ctr: ${c.name}${c.internet_exposed ? ' INTERNET-EXPOSED' : ''}`));
  });
  if (batchTotal && batchTotal > hosts.length) {
    lines.push(``, `(Analysing hosts ${(batchOffset || 0) + 1}-${(batchOffset || 0) + hosts.length} of ${batchTotal} — one row per host in THIS batch only, not the full set.)`);
  }

  const radarBlock = buildCveRadarBlock(d, intel);

  lines.push(
    ``,
    buildReportInstructions(),
    ``,
    `Report-specific guidance:`,
    `- Finding column: hostname (full, never truncate) plus CSP (AWS/Azure/GCP), instance ID, instance`,
    `  type, CSP account ID, region, VPC in parentheses — e.g. "prod-db-01 (aws, i-0abc123, m5.large,`,
    `  123456789012, us-east-1, vpc-0def456)". Use "unknown" only if the field is genuinely blank —`,
    `  never omit it from the string. One row per affected host.`,
    `- What It Means / Why It Matters column: severity, whether internet-exposed, CVSS ${intel.nvd?.cvssV3Score ?? '?'} /`,
    `  EPSS ${intel.epss?.score ?? '?'} context for this host's exposure.`,
    `- Next Steps to Remediate column: exact patch command for this host/package (e.g. apt-get install`,
    `  <pkg>=<version>, yum update, docker pull <image>:<tag>) — real package/version from the data.`,
  );
  if (radarBlock && !batchOffset) {
    lines.push(
      `- The very first line of the whole answer must be this exact fenced block, byte-for-byte,`,
      `  unchanged (it is a pre-computed risk-profile chart — do not edit the JSON), followed directly`,
      `  by the table — no bullets or prose after it:`,
      radarBlock,
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
    `<div style="font-size:8px;color:#888">exposed</div></div>` +
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
    `<div style="font-size:11px;font-weight:600;color:#444;margin-bottom:8px">${cveId} — Threat Radar</div>` +
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
    el('lql-panel').classList.remove('open');

    if (!data.hosts || !data.hosts.length) {
      const noResultEl = document.createElement('div');
      noResultEl.className = 'cve-summary';
      noResultEl.textContent = data.note || `No hosts found for ${cveId} in the selected window.`;
      const fgSearchNoResult = document.createElement('div');
      fgSearchNoResult.className = 'fg-search-link';
      fgSearchNoResult.innerHTML =
        `<a href="https://www.fortiguard.com/search?q=${encodeURIComponent(cveId)}" target="_blank">FortiGuard: ${cveId}</a>` +
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
      appendResultCard('', `CVE: ${cveId}`, noResultEl);
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

    appendResultCard('', `CVE: ${cveId} — ${data.total_affected} hosts (${exp} exposed)`, resultsEl, {
      onAnalyse: () => _runBatchedAnalysis(
        data.hosts, 10,
        (batch, offset) => buildCveAnalysisPrompt(data, fgOutbreaks, batch, offset, data.hosts.length),
        (batch, offset, total, batchNum, totalBatches) =>
          `Analyse attack surface for ${cveId}${totalBatches > 1 ? ` (batch ${batchNum}/${totalBatches})` : ''}`,
        !isOnDeviceRiskHunting(), // useServerSide — Bifrost/Claude Haiku-4.5, unless WebGPU mode is on
      ),
    });

    // Open FortiGuard PSIRT page for this CVE
    chrome.tabs.create({ url: `https://www.fortiguard.com/psirt/${encodeURIComponent(cveId)}`, active: false });

    // If part of an outbreak alert, open the outbreak page too
    if (fgOutbreaks.length) {
      const outbreakUrl = fgOutbreaks[0].link ||
        `https://fortiguard.fortinet.com/outbreak-alert?date=&risk=&vendor=&type=vulnerability&sort=`;
      chrome.tabs.create({ url: outbreakUrl, active: false });
    }
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
    setStatus('CVE error', 'err');
    const errEl = document.createElement('div');
    errEl.className = 'cve-summary';
    errEl.style.color = 'var(--err)';
    errEl.textContent = e.message;
    appendResultCard('', `CVE: ${cveId} — error`, errEl);
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
      b.textContent = 'host exposed';
      hdr.appendChild(b);
    }
    if (h.container_exposed) {
      const b = document.createElement('span');
      b.className = 'cve-badge container';
      b.textContent = 'container exposed';
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
          (c.internet_exposed ? ' <span class="cve-badge internet" style="margin-left:4px">(internet)</span>' : '') +
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
      sel.innerHTML = '<option value="">No saved queries — use LQL Builder</option>';
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

// Turn a free-text objective into a short, underscore-joined name suggestion
// (e.g. "s3 public access and no encryption" -> "s3_public_access_no_encryption") —
// filler words dropped, everything else kept in its original casing so acronyms
// like "S3" or "IAM" survive. Just a starting point: the field stays editable.
const _NAME_STOPWORDS = new Set(['a','an','the','and','or','of','in','on','for','to','with',
  'that','are','is','list','all','show','find','get','me','any','have','has']);
function _suggestQueryName(objective) {
  const words = objective.split(/[^a-zA-Z0-9]+/).filter(Boolean)
    .filter(w => !_NAME_STOPWORDS.has(w.toLowerCase()));
  return words.slice(0, 8).join('_').slice(0, 60) || objective.slice(0, 60);
}

// window.prompt()/confirm() don't reliably work inside a Chrome extension side panel
// (it isn't a top-level browsing context) — they silently return null instead of
// showing a dialog, which made the old prompt()-based Save button a no-op. Build
// an inline name/description form instead.
function buildLqlSaveForm(queryText, objective, containerEl) {
  const form = document.createElement('div');
  form.className = 'lql-save-form';

  const nameInput = document.createElement('input');
  nameInput.className = 'drawer-input';
  nameInput.placeholder = 'Name for this saved query';
  nameInput.value = _suggestQueryName(objective);

  const descInput = document.createElement('input');
  descInput.className = 'drawer-input';
  descInput.placeholder = 'Description (optional)';
  descInput.value = objective;

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'lql-export-btn';
  confirmBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'lql-export-btn';
  cancelBtn.textContent = 'Cancel';

  const statusSpan = document.createElement('span');
  statusSpan.className = 'lql-row-note';

  confirmBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { statusSpan.textContent = 'Name is required'; statusSpan.style.color = 'var(--err)'; return; }
    confirmBtn.disabled = true;
    statusSpan.style.color = '';
    statusSpan.textContent = 'saving…';
    try {
      const res = await fetch(BASE_URL + '/lql/save', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, description: descInput.value.trim(), queryText }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      statusSpan.textContent = `Saved as "${data.id}"`;
      statusSpan.style.color = 'var(--ok)';
      await loadLqlQueries();
      form.remove();
    } catch (e) {
      statusSpan.textContent = `Save failed: ${e.message}`;
      statusSpan.style.color = 'var(--err)';
      confirmBtn.disabled = false;
    }
  });
  cancelBtn.addEventListener('click', () => form.remove());

  form.append(nameInput, descInput, confirmBtn, cancelBtn, statusSpan);
  containerEl.appendChild(form);
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
      appendResultCard('', `LQL: ${query.id}`, resultsEl);
      return;
    }

    renderLqlTable(resultsEl, rows, total, query.id);
    appendResultCard('', `LQL: ${query.id} — ${statusEl.textContent}`, resultsEl, {
      onAnalyse: () => _runBatchedAnalysis(
        rows, 10,
        (batch, offset) => buildLqlAnalysisPrompt(rows, query.id, batch, offset, rows.length),
        (batch, offset, total, batchNum, totalBatches) =>
          `Analyse LQL results for ${query.id}${totalBatches > 1 ? ` (batch ${batchNum}/${totalBatches})` : ''}`,
      ),
    });
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

// ── FortiCNAPP Search (REST API) — server-side path ───────────────────────
// Despite the name, this is the SERVER-SIDE path: an agent loop that hits serve.py's
// /mcp/forensic, which pins the model to Claude Haiku-4.5 with a low temperature and
// top_k=10 server-side, independent of ANTHROPIC_DEFAULT_MODEL/the Admin → LLM Model
// picker (which only affects /lql/generate and on-device chat). No on-device model or
// tool-calling support required. The on-device equivalent (WebGPU mode) is
// runFortiCnappSearchOnDevice() below, which runs the same style of tool-selecting
// loop entirely client-side against /mcp/tools + /mcp/call.
// Unlike Cloud Investigation, this tab has NO GenAI-written final answer — serve.py
// still uses Claude to pick which read-only FortiCNAPP tool(s) to call, but the
// response is a 'final_raw' event ({groups: [{tool, rows}, ...]}) carrying the actual
// rows collected from every tool call. All groups' rows are flattened into one
// table and rendered with renderLqlTable() — the exact same single-table,
// no-AI-analysis-button shape the LQL Builder tab uses — so what you see is exactly
// what FortiCNAPP returned, no templated prose or extra chrome in between.
async function runCloudInvestigationOnDevice() {
  const prompt = el('investigate-od-prompt').value.trim();
  if (!prompt) return;
  if (guardBusy()) return;

  const btn       = el('investigate-od-btn');
  const statusEl  = el('investigate-od-status');
  const stepperEl = el('investigate-od-stepper');

  btn.disabled = true;
  statusEl.textContent = 'investigating…';
  statusEl.className   = '';
  startStepper(stepperEl, 6); // 1:1 with the 6-tool-call budget in serve.py's MAX_ITERATIONS
  updateStepper(stepperEl, 1, 6);

  busy = true;
  el('send').disabled = true;

  const steps = [];
  let groups = [];
  try {
    const res = await fetch(BASE_URL + '/mcp/forensic', {
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
          statusEl.textContent = `${ev.tool}…`;
          updateStepper(stepperEl, steps.length, 6);
        } else if (ev.type === 'tool_result') {
          const last = steps[steps.length - 1];
          if (last) last.summary = ev.summary;
        } else if (ev.type === 'final_raw') {
          groups = ev.groups || [];
        }
      }
    }

    el('lql-panel').classList.remove('open');

    const resultsEl = document.createElement('div');
    resultsEl.className = 'lql-result-body';

    const rows = groups.flatMap(g => g.rows || []);
    if (!rows.length) {
      resultsEl.innerHTML = '<div class="lql-row-note" style="padding:8px 2px">No results.</div>';
      appendResultCard('', `FortiCNAPP Search: ${prompt}`, resultsEl);
    } else {
      renderLqlTable(resultsEl, rows, rows.length, 'forticnapp-forensic');
      appendResultCard('', `FortiCNAPP Search: ${prompt} — ${rows.length} row${rows.length !== 1 ? 's' : ''}`, resultsEl);
    }

    statusEl.textContent = 'done';
    statusEl.className   = 'ok';
  } catch (err) {
    statusEl.textContent = `✗ ${err.message}`;
    statusEl.className   = 'err';
    appendTurn('system', `FortiCNAPP Search failed: ${err.message}`);
  } finally {
    busy = false;
    el('send').disabled = false;
    btn.disabled = false;
    stopStepper(stepperEl);
    scrollLog();
  }
}

// ── FortiCNAPP Search — on-device path (WebGPU mode) ──────────────────────
// Client-side equivalent of runCloudInvestigationOnDevice() above: same read-only
// FortiCNAPP MCP tools, same 6-iteration budget, but the tool-selecting loop itself
// runs against the currently-loaded WebLLM model instead of server-side Claude.
// WebLLM's `tools`/tool_choice support only exists for the Hermes-2-Pro/Hermes-3
// variants (see TOOL_CALLING_MODELS) — none of the Qwen2.5 models can drive this, so
// it fails fast with a message pointing at Hermes rather than letting WebLLM throw
// mid-request with a confusing error.
const MCP_ONDEVICE_MAX_ITERATIONS = 6; // mirrors serve.py's MAX_ITERATIONS for /mcp/investigate|forensic

async function runFortiCnappSearchOnDevice() {
  const prompt = el('investigate-od-prompt').value.trim();
  if (!prompt) return;
  if (guardBusy()) return;

  if (!TOOL_CALLING_MODELS.has(webllmModel)) {
    el('investigate-od-status').textContent = '✗ FortiCNAPP Search on-device requires Hermes-2-Pro or Hermes-3 — switch your on-device model in Admin.';
    el('investigate-od-status').className = 'err';
    return;
  }

  const btn       = el('investigate-od-btn');
  const statusEl  = el('investigate-od-status');
  const stepperEl = el('investigate-od-stepper');

  btn.disabled = true;
  statusEl.textContent = 'loading model…';
  statusEl.className   = '';
  startStepper(stepperEl, MCP_ONDEVICE_MAX_ITERATIONS);
  updateStepper(stepperEl, 1, MCP_ONDEVICE_MAX_ITERATIONS);

  busy = true;
  el('send').disabled = true;

  // (tool_name, row) pairs across every tool call this loop makes — same shape
  // serve.py's collected_rows/_group_collected_rows uses, so the two paths render
  // identically regardless of which one ran.
  const collectedRows = [];

  try {
    const toolsRes = await fetch(BASE_URL + '/mcp/tools');
    if (!toolsRes.ok) throw new Error(`/mcp/tools ${toolsRes.status}`);
    const { tools } = await toolsRes.json();

    const engine = await getEngine(p => {
      statusEl.textContent = formatLoadProgress(p);
    });

    const messages = [
      { role: 'system', content: 'You are a FortiCNAPP cloud security assistant. Use the available read-only tools to investigate the user objective, then stop calling tools once you have enough data.' },
      { role: 'user', content: prompt },
    ];

    for (let iter = 1; iter <= MCP_ONDEVICE_MAX_ITERATIONS; iter++) {
      statusEl.textContent = `thinking… (${iter}/${MCP_ONDEVICE_MAX_ITERATIONS})`;
      updateStepper(stepperEl, iter, MCP_ONDEVICE_MAX_ITERATIONS);

      const lastIter = iter === MCP_ONDEVICE_MAX_ITERATIONS;
      const completion = await engine.chat.completions.create({
        messages,
        temperature: CHAT_TEMPERATURE,
        max_tokens: MAX_TOKENS,
        ...(lastIter ? {} : { tools, tool_choice: 'auto' }),
      });

      const msg = completion.choices[0].message;
      messages.push(msg);
      const toolCalls = msg.tool_calls || [];
      if (!toolCalls.length) break; // model gave a final answer (or last iteration forced none)

      for (const call of toolCalls) {
        const name = call.function?.name || '';
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* malformed args from a smaller model */ }

        statusEl.textContent = `${name}…`;
        let result;
        try {
          const callRes = await fetch(BASE_URL + '/mcp/call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, arguments: args }),
          });
          result = await callRes.json();
        } catch (e) {
          result = { success: false, error: String(e) };
        }

        if (result.success !== false) {
          const rows = result.data;
          const items = Array.isArray(rows) ? rows
                      : (rows && Array.isArray(rows.data)) ? rows.data
                      : null;
          if (items) collectedRows.push(...items.map(item => [name, item]));
          else if (rows != null) collectedRows.push([name, rows]);
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 4000), // bound payload back into context, mirrors serve.py's _bound_mcp_tool_result intent
        });
      }
    }

    el('lql-panel').classList.remove('open');

    const resultsEl = document.createElement('div');
    resultsEl.className = 'lql-result-body';
    const rows = collectedRows.map(([, row]) => row);

    if (!rows.length) {
      resultsEl.innerHTML = '<div class="lql-row-note" style="padding:8px 2px">No results.</div>';
      appendResultCard('', `FortiCNAPP Search: ${prompt}`, resultsEl);
    } else {
      renderLqlTable(resultsEl, rows, rows.length, 'forticnapp-search-ondevice');
      appendResultCard('', `FortiCNAPP Search: ${prompt} — ${rows.length} row${rows.length !== 1 ? 's' : ''}`, resultsEl);
    }

    statusEl.textContent = 'done';
    statusEl.className   = 'ok';
  } catch (err) {
    invalidateEngineOnGpuError(err);
    statusEl.textContent = `✗ ${err.message}`;
    statusEl.className   = 'err';
    appendTurn('system', `FortiCNAPP Search (on-device) failed: ${err.message}`);
  } finally {
    busy = false;
    el('send').disabled = false;
    btn.disabled = false;
    stopStepper(stepperEl);
    scrollLog();
  }
}

el('investigate-od-btn').addEventListener('click', () =>
  isOnDeviceRiskHunting() ? runFortiCnappSearchOnDevice() : runCloudInvestigationOnDevice()
);
el('investigate-od-prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter') el('investigate-od-btn').click();
});

function switchLqlTab(tabName) {
  document.querySelectorAll('.lql-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.lql-pane').forEach(p => p.classList.toggle('active', p.id === 'lql-pane-' + tabName));
}

document.querySelectorAll('.lql-tab').forEach(tab => {
  tab.addEventListener('click', () => switchLqlTab(tab.dataset.tab));
});

// ── LQL Generate ─────────────────────────────────────────────────────────────

let _genQueryText = '';

// Kick off an AI-assisted scoping conversation after an LQL error.
// Injects a hidden user message with error context so Claude asks targeted
// clarifying questions. After the AI responds, a "Re-run LQL" quick-action
// button appears so the user can retry with a refined objective.
async function _startLqlScopingConversation(objective, errorMsg) {
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
  const funFact = makeFunFact();
  bubble.append(funFact, cursor);
  busy = true;
  el('send').disabled = true;

  setStatus('loading model…', 'busy');
  (async () => {
    const engine = await getEngine(p => setStatus(formatLoadProgress(p), 'busy'));
    setStatus('scoping…', 'busy');
    const chunks = await engine.chat.completions.create({
      model: webllmModel, max_tokens: MAX_TOKENS, temperature: CHAT_TEMPERATURE, stream: true,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    });
    const { out } = await readStream(chunks, bubble, cursor, funFact);
    cursor.remove();
    funFact.remove();
    if (out) {
      const node = document.createElement('span');
      setRendered(node, renderMarkdown(out));
      bubble.appendChild(makeCopyBtn(out));
      bubble.appendChild(makePdfBtn(node));
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
    scrollLog();
  })().catch(err => {
    invalidateEngineOnGpuError(err);
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

// Segmented progress stepper — replaces the sailboat for showing real server-side
// progress. startStepper(el, N) renders N empty segments and starts a live elapsed-time
// ticker; updateStepper(el, step, max) fills segments proportionally to step/max and
// pulses the current one; stopStepper(el) tears both down and hides the element.
let _stepperElapsedTimer = null, _stepperStartedAt = 0;

function startStepper(stepperEl, segmentCount) {
  const track = stepperEl.querySelector('.stepper-track');
  track.innerHTML = '';
  for (let i = 0; i < segmentCount; i++) {
    const seg = document.createElement('div');
    seg.className = 'stepper-seg';
    track.appendChild(seg);
  }
  stepperEl.style.display = 'flex';
  _stepperStartedAt = performance.now();
  const elapsedEl = stepperEl.querySelector('.stepper-elapsed');
  elapsedEl.textContent = '0s elapsed';
  clearInterval(_stepperElapsedTimer);
  _stepperElapsedTimer = setInterval(() => {
    const secs = Math.round((performance.now() - _stepperStartedAt) / 1000);
    elapsedEl.textContent = `${secs}s elapsed`;
  }, 1000);
}

function updateStepper(stepperEl, step, max) {
  const segs = stepperEl.querySelectorAll('.stepper-seg');
  if (!segs.length) return;
  const filled = Math.min(segs.length, Math.max(0, Math.ceil((step / max) * segs.length)));
  segs.forEach((seg, i) => {
    seg.classList.toggle('done',   i <  filled - 1);
    seg.classList.toggle('active', i === filled - 1);
  });
}

function stopStepper(stepperEl) {
  clearInterval(_stepperElapsedTimer);
  stepperEl.style.display = 'none';
}

el('lql-gen-btn').addEventListener('click', async () => {
  const objective = el('lql-objective').value.trim();
  if (!objective) return;

  const btn       = el('lql-gen-btn');
  const statusEl  = el('lql-gen-status');
  const stepperEl = el('lql-gen-stepper');

  btn.disabled         = true;
  statusEl.textContent = 'running…';
  statusEl.className   = '';
  startStepper(stepperEl, 8); // 8 fixed segments scaled against the real 20-attempt budget
  updateStepper(stepperEl, 1, 20);
  _genQueryText        = '';
  el('lql-gen-results').innerHTML = '';

  try {
    let data;
    if (isOnDeviceRiskHunting()) {
      // On-device: no live tenant datasource grounding (that requires the `lacework` CLI,
      // server-side only) and no multi-attempt validate/retry loop — one best-effort shot,
      // asking the model to emit a single LQL query. No USE_CVE_TAB heuristic either; that's
      // a server-side classifier over Claude's grounded output, not something this smaller
      // best-effort path can reliably reproduce.
      statusEl.textContent = 'loading model…';
      const engine = await getEngine(p => { statusEl.textContent = formatLoadProgress(p); });
      statusEl.textContent = 'generating…';
      updateStepper(stepperEl, 10, 20);
      const completion = await engine.chat.completions.create({
        messages: [
          { role: 'system', content: 'You write FortiCNAPP LQL (Lacework Query Language) queries. Reply with ONLY the raw LQL query text for the given objective — no markdown fences, no explanation.' },
          { role: 'user', content: objective },
        ],
        temperature: CHAT_TEMPERATURE,
        max_tokens: MAX_TOKENS,
      });
      const queryText = (completion.choices[0].message.content || '').trim()
        .replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();
      if (!queryText) throw new Error('Model returned an empty query.');
      data = { queryText };
    } else {
      const genRes = await fetch(BASE_URL + '/lql/generate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ objective }),
      });

      const reader = genRes.body.getReader();
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
          if (ev.type === 'attempt') {
            statusEl.textContent = ev.phase === 'asking_claude' ? 'Chatting with FortiAIScout…'
                                  : ev.phase === 'validating'    ? 'validating query…'
                                  : 'running…';
            updateStepper(stepperEl, ev.attempt, ev.max);
          } else if (ev.type === 'error') {
            throw new Error(ev.error);
          } else if (ev.type === 'final') {
            data = ev;
          }
        }
      }
      if (!data) throw new Error('Stream ended with no result.');
    }

    if (data.queryId === 'USE_CVE_TAB') {
      const cveMatch = objective.match(/CVE-\d{4}-\d{4,}/i);
      if (cveMatch) {
        const cveId = cveMatch[0].toUpperCase();
        statusEl.textContent = `↪ running Attack Surface tab for ${cveId}`;
        statusEl.className   = 'ok';
        switchLqlTab('cve');
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

    // renderLqlTable() below clears its container (containerEl.innerHTML = '') before
    // rendering the table — anything appended to resultsEl before that call gets wiped.
    // Render the table into its own child node first, then build/prepend the feedback
    // gate and query preview around it.
    const tableEl = document.createElement('div');

    if (!rows.length) {
      tableEl.innerHTML = '<div class="lql-row-note" style="padding:8px 2px">No results.</div>';
    } else {
      renderLqlTable(tableEl, rows, total, label);
    }
    resultsEl.appendChild(tableEl);

    // Snapshot this card's own query text now — _genQueryText is a shared module-level
    // variable that gets overwritten by the *next* generate call. Reading it later (e.g.
    // from a button's click handler) instead of capturing it here risked saving whichever
    // query was most recently generated, mislabeled under an older card's objective/name.
    const cardQueryText = _genQueryText;

    // Feedback gate: only offer to save this generated query into the LQL/Risk Hunting
    // tab once the user confirms it actually returned what they intended — a saved query
    // that silently answered the wrong question is worse than no saved query at all.
    if (cardQueryText) {
      const feedback = document.createElement('div');
      feedback.className = 'lql-row-note';
      feedback.style.cssText = 'margin:2px 2px 8px;padding:6px 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--border);border-radius:6px;';
      const feedbackLabel = document.createElement('span');
      feedbackLabel.textContent = 'Did this return exactly what you intended?';
      const yesBtn = document.createElement('button');
      yesBtn.className = 'lql-export-btn';
      yesBtn.textContent = '👍 Yes, save to LQL tab';
      const noBtn = document.createElement('button');
      noBtn.className = 'lql-export-btn';
      noBtn.textContent = '👎 No';
      yesBtn.addEventListener('click', () => {
        feedback.remove();
        buildLqlSaveForm(cardQueryText, objective, resultsEl);
      }, { once: true });
      noBtn.addEventListener('click', () => {
        feedback.textContent = 'Not saved — refine the objective and try again.';
      }, { once: true });
      feedback.append(feedbackLabel, yesBtn, noBtn);
      resultsEl.insertBefore(feedback, tableEl);
    }

    // Show the actual generated LQL — collapsed by default, but the query itself must always
    // be visible somewhere. It was previously captured (_genQueryText) and used to run the
    // query but never rendered anywhere in the UI.
    if (cardQueryText) {
      const details = document.createElement('details');
      details.className = 'lql-query-preview';
      const summary = document.createElement('summary');
      summary.textContent = '▶ Generated LQL';
      const pre = document.createElement('pre');
      pre.textContent = cardQueryText;
      details.append(summary, pre);
      resultsEl.insertBefore(details, tableEl);
    }

    if (!rows.length) {
      appendResultCard('', `LQL: ${label}`, resultsEl);
      return;
    }

    appendResultCard('', `LQL: ${label} — ${statusEl.textContent}`, resultsEl, {
      onAnalyse: () => _runBatchedAnalysis(
        rows, 10,
        (batch, offset) => buildLqlAnalysisPrompt(rows, label, batch, offset, rows.length),
        (batch, offset, total, batchNum, totalBatches) =>
          `Analyse LQL results for ${label}${totalBatches > 1 ? ` (batch ${batchNum}/${totalBatches})` : ''}`,
      ),
    });
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
    setStatus('LQL error', 'err');
    _startLqlScopingConversation(objective, e.message);
  } finally {
    btn.disabled = false;
    stopStepper(stepperEl);
  }
});

// ── LQL table renderer ───────────────────────────────────────────────────────
const LQL_BADGE_KEY_RE = /(SEVERITY|STATUS|RISK|COMPLIANCE|ENCRYPT|PUBLIC)/i;
const LQL_BADGE_RULES = [
  { re: /^(critical|high|fail(ed)?|true|non-?compliant|public|open|violat)/i, cls: 'lql-badge-crit' },
  { re: /^(medium|warn(ing)?|unknown|partial)/i, cls: 'lql-badge-warn' },
  { re: /^(low|pass(ed)?|false|compliant|closed|ok|healthy|private|encrypted)/i, cls: 'lql-badge-ok' },
];

// Badges are meant for short enum-like values (true/false, critical/low, compliant/...).
// A column merely *named* like PUBLIC/ENCRYPT/etc. can still hold a long free-text
// description (e.g. "S3 bucket is internet exposed via weakened public access block; ...") —
// forcing that into a non-wrapping .lql-badge pill made it overflow across neighboring
// cells instead of wrapping like normal text. Only badge-ify short values; anything longer
// falls through to plain (wrapping) text.
const LQL_BADGE_MAX_LEN = 24;

function lqlBadgeClassFor(key, val) {
  if (!LQL_BADGE_KEY_RE.test(key) || !val || val.trim().length > LQL_BADGE_MAX_LEN) return null;
  const rule = LQL_BADGE_RULES.find(r => r.re.test(val.trim()));
  return rule ? rule.cls : 'lql-badge-neutral';
}

// FortiCNAPP Inventory search returns `cloudDetails` as a nested object
// ({accountAlias, accountID, ...} for AWS; subscriptionName/subscriptionId for
// Azure; projectId for GCP) — rendered as-is via String() it's just
// "[object Object]". Flatten it to the one line an analyst actually wants:
// "<CSP> <alias or id>" (falls back to raw JSON if the shape is unrecognized).
function _formatCloudDetails(csp, cd) {
  if (!cd || typeof cd !== 'object') return String(cd ?? '');
  const label = cd.accountAlias || cd.subscriptionName || cd.projectId
    || cd.accountID || cd.accountId || cd.subscriptionId || '';
  const cspLabel = csp || (cd.accountID || cd.accountId ? 'AWS' : cd.subscriptionId ? 'Azure' : cd.projectId ? 'GCP' : '');
  return label ? `${cspLabel} ${label}`.trim() : JSON.stringify(cd);
}

function renderLqlTable(containerEl, rows, totalRows, queryLabel) {
  containerEl.innerHTML = '';

  const URL_RE = /^https?:\/\/\S+$/;
  // Cells past this length still render in full (CSS wraps rather than truncates),
  // but get a "▸ show more / ▾ show less" toggle so a long value doesn't force
  // every other row's cell to look equally tall.
  const LONG_CELL_THRESHOLD = 140;
  const SHORT_PREVIEW_LEN   = 140;

  // cloudDetails is a nested object in FortiCNAPP's Inventory search response —
  // flatten it in place, on every row, before deriving columns/CSV/cell rendering
  // below, so it's treated exactly like any other plain string field.
  if (rows.some(r => r && typeof r.cloudDetails === 'object')) {
    rows = rows.map(r => (r && typeof r.cloudDetails === 'object')
      ? { ...r, cloudDetails: _formatCloudDetails(r.csp, r.cloudDetails) }
      : r);
  }

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
      const badgeCls = lqlBadgeClassFor(k, val);
      if (URL_RE.test(val)) {
        const a = document.createElement('a');
        a.className = 'lql-link';
        a.href = val; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = val;
        td.appendChild(a);
      } else if (badgeCls) {
        const badge = document.createElement('span');
        badge.className = `lql-badge ${badgeCls}`;
        badge.textContent = val;
        td.appendChild(badge);
      } else if (val.length > LONG_CELL_THRESHOLD) {
        const textSpan = document.createElement('span');
        textSpan.textContent = val.slice(0, SHORT_PREVIEW_LEN) + '…';
        const toggle = document.createElement('span');
        toggle.className = 'lql-cell-toggle';
        toggle.textContent = `▸ show more (${val.length} chars)`;
        let expanded = false;
        toggle.addEventListener('click', () => {
          expanded = !expanded;
          textSpan.textContent = expanded ? val : val.slice(0, SHORT_PREVIEW_LEN) + '…';
          toggle.textContent = expanded ? '▾ show less' : `▸ show more (${val.length} chars)`;
        });
        td.append(textSpan, toggle);
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
