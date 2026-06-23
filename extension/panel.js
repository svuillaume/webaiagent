'use strict';

// ── Constants ─────────────────────────────────────────────────────────────
const MAX_TOKENS     = 512;
const PAGE_MAX_CHARS = 12000;
const SYSTEM_PROMPT  = 'Be concise. Answer in 1-3 sentences unless more detail is clearly needed. No filler phrases.';
const ROLE_LABELS    = { user: 'you', ai: 'ai', system: 'sys' };

// ── Gateway profiles ──────────────────────────────────────────────────────
// Each profile describes how to build the Authorization/API-key headers
// for the /v1/messages endpoint of that gateway.
const GATEWAYS = {
  bifrost:  {
    label:       '⚡ Bifrost',
    urlHint:     'https://bifrost.xxx',
    keyHint:     'sk-bf-…',
    keyLabel:    'key',
    // Headers: x-api-key + anthropic-version (Anthropic passthrough style)
    headers: key => ({
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01',
    }),
  },
  portkey:  {
    label:       'Portkey',
    urlHint:     'https://api.portkey.ai',
    keyHint:     'pk-…',
    keyLabel:    'key',
    // Portkey uses x-portkey-api-key; virtual-key is optional (set in Portkey config)
    headers: key => ({
      'Content-Type':         'application/json',
      'x-portkey-api-key':    key,
      'anthropic-version':    '2023-06-01',
    }),
  },
  litellm:  {
    label:       'LiteLLM',
    urlHint:     'https://litellm.xxx',
    keyHint:     'sk-…',
    keyLabel:    'key',
    // LiteLLM proxy uses Bearer token
    headers: key => ({
      'Content-Type':      'application/json',
      'Authorization':     `Bearer ${key}`,
      'anthropic-version': '2023-06-01',
    }),
  },
  helicone: {
    label:       'Helicone',
    urlHint:     'https://anthropic.helicone.ai',
    keyHint:     'sk-ant-… (Anthropic key)',
    keyLabel:    'ant-key',
    // Helicone: pass Anthropic key as x-api-key, Helicone auth as separate header
    // helicone-auth stored in search-input field (reused as secondary-key field)
    headers: (key, heliconeKey) => ({
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01',
      ...(heliconeKey ? { 'helicone-auth': `Bearer ${heliconeKey}` } : {}),
    }),
  },
};

const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description: 'Search the web for current information, recent events, or live data.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

// ── State ─────────────────────────────────────────────────────────────────
const history = [];
let busy = false;

// ── DOM refs ──────────────────────────────────────────────────────────────
const el          = id => document.getElementById(id);
const urlInput    = el('url-input');
const keyInput    = el('key-input');
const searchInput = el('search-input'); // hidden — holds SearXNG base URL

const setStatus = (text, state = '') => {
  el('status').textContent = text;
  el('status').className   = state;
};

// ── Storage ───────────────────────────────────────────────────────────────
// Sensitive values (URL, key) → session storage: RAM only, cleared on Chrome close.
// Model preference            → local storage:   persists, not sensitive.
chrome.storage.session.get(['bf_url', 'bf_key', 'bf_search'], ({ bf_url, bf_key, bf_search }) => {
  if (bf_url)    urlInput.value    = bf_url;
  if (bf_key)    keyInput.value    = bf_key;
  if (bf_search) searchInput.value = bf_search;
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
  // Try serve.py /config first (single source of truth: .env)
  // Fall back to bundled config.json for offline/dev use
  let cfg = null;
  try {
    const res = await fetch('http://localhost:8765/config');
    if (res.ok) cfg = await res.json();
  } catch { /* serve.py not running */ }

  if (!cfg) {
    try {
      const res = await fetch(chrome.runtime.getURL('config.json'));
      if (res.ok) cfg = await res.json();
    } catch { /* no config.json either */ }
  }

  if (!cfg) return;

  const fill = (input, cfgKey, storeKey) => {
    if (cfg[cfgKey] && !input.value) {
      input.value = cfg[cfgKey];
      chrome.storage.session.set({ [storeKey]: cfg[cfgKey] });
    }
  };
  fill(urlInput,    'bifrost_url', 'bf_url');
  fill(keyInput,    'api_key',     'bf_key');
  fill(searchInput, 'searxng_url', 'bf_search');
  if (cfg.bifrost_url || cfg.api_key) setStatus('config loaded', 'ok');

  // Grey out FortiCNAPP security tools if ~/.lacework.toml credentials are missing
  const lwReady = cfg.lw_ready === true;
  const LW_CHIPS = ['codesec', 'compliance', 'lql', 'cve-btn'];
  LW_CHIPS.forEach(id => {
    const btn = el(id);
    if (!btn) return;
    if (!lwReady) {
      btn.classList.add('lw-disabled');
      btn.title = btn.title.replace('🔑 Requires FortiCNAPP API key', '⚠ FortiCNAPP credentials not found (add ~/.lacework.toml)');
    } else {
      btn.classList.remove('lw-disabled');
    }
  });
}

// ── Welcome message ───────────────────────────────────────────────────────────
appendTurn('ai', `**Web AI Agent** — your browser-native security assistant powered by FortiCNAPP and Claude.

**What I can do on any page you're browsing:**
• 📄 **Read** — load the page into context so you can ask questions about it
• **TL;DR** — summarise the page in 3–5 bullets with source links

**Cloud security tools** _(🔑 require a valid FortiCNAPP API key configured in the backend)_:
• 🛡 **Scan** — FortiCNAPP SCA + SAST scan on code found on this page
• 📋 **Compliance** — generate a FortiCNAPP compliance PDF report
• 🚨 **CVE** — attack surface assessment: search any CVE (e.g. CVE-2021-44228) across hosts and containers, ranked by internet exposure and host risk score
• 🔍 **LQL — Saved queries** — run pre-built Lacework Query Language queries against your live tenant
• ✨ **LQL — Generate** — describe what you want to find in plain English; I'll build and run the LQL query for you

Type anything below to start a conversation.`);

const saveSession = (key, input) => {
  const v = input.value.trim();
  v ? chrome.storage.session.set({ [key]: v }) : chrome.storage.session.remove(key);
};

urlInput.addEventListener('change',    () => saveSession('bf_url',    urlInput));
keyInput.addEventListener('change',    () => saveSession('bf_key',    keyInput));
searchInput.addEventListener('change', () => saveSession('bf_search', searchInput));
el('model').addEventListener('change', () => chrome.storage.local.set({ bf_model: el('model').value }));

// ── Web search ────────────────────────────────────────────────────────────
// Tries Docker SearXNG (8080) first; falls back to serve.py proxy (8765).
async function webSearch(query) {
  const q = encodeURIComponent(query);
  let res;
  try {
    res = await fetch(`http://localhost:8080/search?q=${q}&format=json&language=en`,
      { signal: AbortSignal.timeout(4000) });
  } catch {
    res = await fetch(`http://localhost:8765/search?q=${q}`,
      { signal: AbortSignal.timeout(8000) });
  }
  if (!res.ok) throw new Error(`Search returned ${res.status}`);
  const { results = [] } = await res.json();
  if (!results.length) return 'No results found.';
  return results.slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content || ''}`)
    .join('\n\n');
}

// ── Markdown renderer ─────────────────────────────────────────────────────
// Escape FIRST, then transform — model output can never inject executable HTML.
function renderMarkdown(text) {
  const esc  = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const link = (href, label) => {
    const url = /^https?:\/\//i.test(href) ? href : `https://${href}`;
    return `<a class="ext-link" data-href="${url}">${label}</a>`;
  };
  return text.split(/(```[\s\S]*?```)/g).map((part, i) => {
    if (i % 2 === 1) {
      const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
      return `<pre><code>${esc(code.trimEnd())}</code></pre>`;
    }
    let s = esc(part);
    s = s.replace(/`([^`\n]+)`/g,     '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, l, h) => link(h, l));
    s = s.replace(/(?<!data-href=")(https?:\/\/[^\s<>"]+)/g,              u => link(u, u));
    s = s.replace(/(?<![/"'>])(www\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s<>"]*)/, u => link(u, u));
    return s;
  }).join('');
}

// Inert <template> parse — injected scripts never execute
function setRendered(node, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  node.replaceChildren(tpl.content.cloneNode(true));
}

// ── Chat log ──────────────────────────────────────────────────────────────
function scrollLog() { const l = el('log'); l.scrollTop = l.scrollHeight; }

function appendTurn(role, text = '') {
  const turn  = Object.assign(document.createElement('div'), { className: 'turn' });
  const label = Object.assign(document.createElement('div'), {
    className: `role ${role}`, textContent: ROLE_LABELS[role] ?? role,
  });
  const body  = Object.assign(document.createElement('div'), { className: 'content' });
  if (text) {
    if (role === 'ai') setRendered(body, renderMarkdown(text));
    else               body.textContent = text;
  }
  turn.append(label, body);
  el('log').appendChild(turn);
  scrollLog();
  return body;
}
const resizePrompt = () => {
  const p = el('prompt');
  p.style.height = 'auto';
  p.style.height = Math.min(p.scrollHeight, 180) + 'px';
};

// ── Clear ─────────────────────────────────────────────────────────────────
el('clear').addEventListener('click', () => {
  history.length = 0;
  el('log').innerHTML          = '';
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
  await send(true);
}));

// ── SSE stream parser ─────────────────────────────────────────────────────
async function readStream(res, bubble, cursor) {
  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = '', out = '', inputTk = 0, outputTk = 0, stopReason = null;
  const toolCalls = {};

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
      if (ev.type === 'message_delta') {
        outputTk   = ev.usage?.output_tokens  ?? outputTk;
        stopReason = ev.delta?.stop_reason    ?? stopReason;
      }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use')
        toolCalls[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, input_json: '' };
      if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') {
          out += ev.delta.text;
          setRendered(bubble, renderMarkdown(out));
          bubble.appendChild(cursor);
          scrollLog();
        }
        if (ev.delta?.type === 'input_json_delta' && toolCalls[ev.index])
          toolCalls[ev.index].input_json += ev.delta.partial_json;
      }
    }
  }
  return { out, inputTk, outputTk, stopReason, toolCalls: Object.values(toolCalls) };
}

// ── Send ──────────────────────────────────────────────────────────────────
// silent = true: caller already pushed the user turn (TL;DR path)
async function send(silent = false) {
  if (busy) return;

  const baseUrl   = urlInput.value.trim().replace(/\/+$/, '');
  const key       = keyInput.value.trim();
  const hasSearch = !!searchInput.value.trim();

  if (!baseUrl) { appendTurn('system', 'No endpoint URL — enter the Bifrost base URL above.'); return; }
  if (!key)     { appendTurn('system', 'No API key — enter your sk-bf-… key above.');          return; }

  if (!silent) {
    const text = el('prompt').value.trim();
    if (!text) return;
    history.push({ role: 'user', content: text });
    appendTurn('user', text);
    el('prompt').value        = '';
    el('prompt').style.height = 'auto';
  }

  const bubble = appendTurn('ai');
  const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
  bubble.appendChild(cursor);

  busy = true;
  el('send').disabled = true;

  const gw      = el('gateway').value || 'bifrost';
  const profile = GATEWAYS[gw] || GATEWAYS.bifrost;
  // For Helicone, searchInput holds the Helicone auth key (secondary key)
  const headers = profile.headers(key, gw === 'helicone' ? searchInput.value.trim() : undefined);
  let inputTk = 0, outputTk = 0;

  try {
    while (true) {
      setStatus('streaming…', 'busy');
      const body = {
        model: el('model').value, max_tokens: MAX_TOKENS,
        stream: true, system: SYSTEM_PROMPT, messages: history,
      };
      if (hasSearch) body.tools = [WEB_SEARCH_TOOL];

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

      const { out, inputTk: iTk, outputTk: oTk, stopReason, toolCalls } =
        await readStream(res, bubble, cursor);
      inputTk += iTk; outputTk += oTk;

      if (hasSearch && stopReason === 'tool_use' && toolCalls.length) {
        const asst = out ? [{ type: 'text', text: out }] : [];
        for (const tc of toolCalls) {
          const input = tryParse(tc.input_json);
          asst.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
        }
        history.push({ role: 'assistant', content: asst });

        const toolResults = [];
        for (const tc of toolCalls) {
          const { query } = tryParse(tc.input_json);
          setStatus(`searching: ${query}…`, 'busy');
          let result;
          try   { result = await webSearch(query); }
          catch (e) { result = `Search error: ${e.message}`; }
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
        }
        history.push({ role: 'user', content: toolResults });
        bubble.innerHTML = '';
        bubble.appendChild(cursor);
        continue;
      }

      cursor.remove();
      setRendered(bubble, renderMarkdown(out));
      history.push({ role: 'assistant', content: out });
      setStatus('ok', 'ok');
      el('token-info').textContent = `in:${inputTk} out:${outputTk}`;
      break;
    }
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

const tryParse = json => { try { return JSON.parse(json); } catch { return {}; } };

// Open links in a new tab — target="_blank" is blocked in MV3 side panels
el('log').addEventListener('click', e => {
  const a = e.target.closest('a.ext-link');
  if (!a) return;
  e.preventDefault();
  chrome.tabs.create({ url: a.dataset.href });
});

el('prompt').addEventListener('input',   resizePrompt);
el('prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
el('send').addEventListener('click', send);

el('prompt').focus();

// ── FortiCNAPP CodeSec + SBOM ─────────────────────────────────────────────

// Detect whether a snippet is a package manifest and return its canonical filename,
// or fall back to a source-file extension. SCA requires real manifest filenames.
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

// Files worth fetching for SCA/SAST — manifests first, then common source
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
  return files;
}

// Extract all code blocks from the active tab and return named files for SCA.
// On GitHub pages, fetches real repo files via the API instead of scraping HTML.
async function extractPageCode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');

  const ghRepo = githubRepoFromUrl(tab.url || '');
  if (ghRepo) {
    const files = await fetchGithubRepoFiles(ghRepo.owner, ghRepo.repo);
    const fileList = files.map(f => `  • ${f.path || f.filename}`).join('\n');
    appendTurn('system',
      `🔍 GitHub: ${ghRepo.owner}/${ghRepo.repo} — ${files.length} file${files.length !== 1 ? 's' : ''} fetched:\n${fileList}`);
    return { files, title: tab.title || 'page', url: tab.url || '' };
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

function renderCodeSecResults(data, mode) {
  const panel = el('codesec-panel');
  const body  = el('codesec-body');
  el('codesec-panel-title').textContent = mode === 'sbom' ? '📦 FortiCNAPP SBOM' : '🛡 FortiCNAPP CodeSec';
  panel.classList.add('open');
  body.innerHTML = '';

  if (mode === 'sbom') {
    if (data.error) {
      body.innerHTML = `<div class="cs-empty" style="color:var(--err)">${data.error}</div>`;
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
      const locStr  = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '';
      const fixStr  = f.fixVersion || '';
      row.innerHTML =
        `<div class="cs-sev ${esc(sev)}">${esc(sev)}</div>` +
        `<div class="cs-detail">${esc(rawDesc)}` +
          (idStr   ? `<span class="cs-sub"> [${esc(idStr)}]</span>` : '') +
          (locStr  ? `<span class="cs-sub"> ${esc(locStr)}</span>`  : '') +
          (fixStr  ? `<span class="cs-sub"> → fix: ${esc(fixStr)}</span>` : '') +
        `</div>`;
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
}

async function runCodeSec(mode) {
  const btn = el(mode === 'sbom' ? 'sbom' : 'codesec');
  btn.classList.add('busy');
  btn.disabled = true;
  setStatus(`${mode === 'sbom' ? 'generating SBOM' : 'scanning'}…`, 'busy');

  try {
    const { files } = await extractPageCode();
    if (!files.length) {
      appendTurn('system', 'No code blocks found on this page.');
      setStatus('—');
      return;
    }

    const res = await fetch(`http://localhost:8765/${mode === 'sbom' ? 'sbom' : 'codesec'}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ files }),
    });
    if (!res.ok) throw new Error(`Scan endpoint returned ${res.status}`);
    const data = await res.json();
    renderCodeSecResults(data, mode);

    if (mode !== 'sbom') {
      const total = (data.vulns?.length || 0) + (data.weaknesses?.length || 0) + (data.secrets?.length || 0);
      setStatus(total ? `${total} finding${total !== 1 ? 's' : ''}` : 'clean', total ? 'err' : 'ok');
    } else {
      setStatus('sbom ready', 'ok');
    }
  } catch (e) {
    appendTurn('system', `CodeSec error: ${e.message}`);
    setStatus('error', 'err');
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

el('codesec').addEventListener('click', () => runCodeSec('scan'));
el('sbom').addEventListener('click',    () => runCodeSec('sbom'));
el('codesec-close').addEventListener('click', () => {
  el('codesec-panel').classList.remove('open');
});

// ── FortiCNAPP Compliance Report ──────────────────────────────────────────

el('compliance').addEventListener('click', async () => {
  const panel = el('compliance-panel');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  el('codesec-panel').classList.remove('open');
  if (!isOpen) loadComplianceReports();
});

el('compliance-close').addEventListener('click', () => {
  el('compliance-panel').classList.remove('open');
});

async function loadComplianceReports() {
  const sel = el('comp-report');
  sel.innerHTML = '<option value="">Loading…</option>';
  sel.disabled = true;
  try {
    const res  = await fetch('http://localhost:8765/compliance/list');
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
    const res = await fetch('http://localhost:8765/compliance', {
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

// ── FortiCNAPP CVE Attack Surface ────────────────────────────────────────────

let _lastCveData = null;

el('cve-btn').addEventListener('click', () => {
  const panel  = el('cve-panel');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  el('codesec-panel').classList.remove('open');
  el('compliance-panel').classList.remove('open');
  el('lql-panel').classList.remove('open');
  if (!isOpen) el('cve-input').focus();
});

el('cve-close').addEventListener('click', () => el('cve-panel').classList.remove('open'));

el('cve-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') runCveSearch();
});

el('cve-search').addEventListener('click', runCveSearch);

el('cve-analyse').addEventListener('click', () => {
  if (!_lastCveData) return;
  el('cve-panel').classList.remove('open');
  const d       = _lastCveData;
  const exposed = d.hosts.filter(h => h.host_exposed || h.container_exposed);
  const prompt  = buildCveAnalysisPrompt(d);
  history.push({ role: 'user', content: prompt });
  appendTurn('user', `Analyse attack surface for ${d.cveId}`);
  send(true);
});

function buildCveAnalysisPrompt(d) {
  const lines = [
    `FortiCNAPP vulnerability scan results for **${d.cveId}** (last ${d.period_days} days).`,
    ``,
    `Summary: ${d.total_affected} affected hosts | ${d.internet_exposed} internet-exposed | ${d.fixable} fixable | ${d.total_containers} containers`,
    ``,
    `Affected hosts (internet-exposed first):`,
  ];

  d.hosts.forEach((h, i) => {
    const flags = [];
    if (h.host_exposed)      flags.push('HOST-INTERNET-EXPOSED');
    if (h.container_exposed) flags.push('CONTAINER-INTERNET-EXPOSED');
    if (h.fix_available)     flags.push(`fixable→${h.fixed_version}`);
    lines.push(
      `${i + 1}. ${h.hostname}  [${h.severity}]  risk:${h.host_risk_score.toFixed(1)}` +
      (flags.length ? `  ⚠ ${flags.join(' | ')}` : '') +
      `  account:${h.account}  region:${h.region}`
    );
    h.packages.forEach(p => lines.push(`   pkg: ${p.name} ${p.version}`));
    h.containers.forEach(c => lines.push(
      `   container: ${c.name}  image:${c.image}` +
      (c.internet_exposed ? '  🌐 INTERNET-EXPOSED' : '')
    ));
  });

  lines.push(``, `Tasks:`);
  lines.push(`1. Produce an ASCII architecture diagram showing affected hosts, their containers, trust boundaries (VPC / public internet), and which paths are internet-exposed (mark in red). Show CVE package on each affected node.`);
  lines.push(`2. Rank the top 3 highest-risk hosts and explain why.`);
  lines.push(`3. State the recommended remediation (patch to ${d.hosts.find(h => h.fix_available)?.fixed_version || 'fixed version'} where available).`);
  lines.push(`4. Flag any internet-exposed containers running on vulnerable hosts as critical priority.`);

  return lines.join('\n');
}

async function runCveSearch() {
  const cveId = el('cve-input').value.trim().toUpperCase();
  if (!cveId) return;

  const btn       = el('cve-search');
  const statusEl  = el('cve-status');
  const resultsEl = el('cve-results');
  const analyseBtn = el('cve-analyse');

  btn.disabled         = true;
  statusEl.textContent = 'searching…';
  statusEl.className   = '';
  resultsEl.innerHTML  = '';
  analyseBtn.style.display = 'none';
  _lastCveData = null;
  setStatus(`CVE lookup: ${cveId}…`, 'busy');

  try {
    const res = await fetch('http://localhost:8765/lql/cve', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cveId, days: Number(el('cve-days').value) }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    _lastCveData = data;

    if (!data.hosts || !data.hosts.length) {
      statusEl.textContent = data.note || 'No results';
      statusEl.className   = '';
      setStatus('—');
      resultsEl.innerHTML  = `<div class="cve-summary">${data.note || 'No affected hosts found.'}</div>`;
      return;
    }

    renderCveResults(data);

    const exp = data.internet_exposed;
    statusEl.textContent = `${data.total_affected} hosts  |  ${exp} internet-exposed  |  ${data.fixable} fixable`;
    statusEl.className   = exp ? 'err' : 'ok';
    setStatus(`${cveId}: ${data.total_affected} hosts (${exp} exposed)`, exp ? 'err' : 'ok');
    analyseBtn.style.display = '';
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
    setStatus('CVE error', 'err');
    resultsEl.innerHTML  = `<div class="cve-summary" style="color:var(--err)">${e.message}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderCveResults(data) {
  const resultsEl = el('cve-results');
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
  if (!isOpen) loadLqlQueries();
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
    const res  = await fetch('http://localhost:8765/lql/queries');
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
  const resultsEl = el('lql-results');

  btn.disabled         = true;
  statusEl.textContent = 'running…';
  statusEl.className   = '';
  resultsEl.innerHTML  = '';
  setStatus('running LQL…', 'busy');

  try {
    const res = await fetch('http://localhost:8765/lql/run', {
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

    if (!rows.length) {
      resultsEl.innerHTML = '<pre>No results.</pre>';
      return;
    }

    // Render as a plain-text aligned table
    const keys   = Object.keys(rows[0]);
    const widths = Object.fromEntries(keys.map(k => [k, k.length]));
    rows.forEach(r => keys.forEach(k => {
      widths[k] = Math.max(widths[k], String(r[k] ?? '').length);
    }));
    const pad = (s, w) => String(s ?? '').padEnd(w);
    const header = keys.map(k => pad(k, widths[k])).join('  ');
    const sep    = keys.map(k => '-'.repeat(widths[k])).join('  ');
    const body   = rows.slice(0, 200).map(r =>
      keys.map(k => pad(r[k], widths[k])).join('  ')
    ).join('\n');
    const note = rows.length > 200 ? `\n… ${rows.length - 200} more rows` : '';

    const pre = document.createElement('pre');
    pre.textContent = `${header}\n${sep}\n${body}${note}`;
    resultsEl.appendChild(pre);

    // Also push a summary into chat context
    history.push({
      role: 'user',
      content: `I ran LQL query "${query.id}" and got ${count} rows. Here are the results:\n\n${header}\n${sep}\n${body}${note}\n\nAnalyse these findings.`,
    });
    history.push({ role: 'assistant', content: 'Results loaded.' });
    appendTurn('system', `🔍 LQL "${query.id}" — ${count} rows loaded into context`);
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
    setStatus('LQL error', 'err');
    resultsEl.innerHTML  = `<pre style="color:var(--err)">${e.message}</pre>`;
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
  const preview  = el('lql-gen-preview');
  const codeEl   = el('lql-gen-code');

  btn.disabled         = true;
  statusEl.textContent = 'building…';
  statusEl.className   = '';
  preview.style.display = 'none';
  _genQueryText        = '';

  try {
    const res  = await fetch('http://localhost:8765/lql/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ objective }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    _genQueryText         = data.queryText || '';
    codeEl.textContent    = `-- ${data.queryId}\n\n${_genQueryText}`;
    statusEl.textContent  = 'ready';
    statusEl.className    = 'ok';
    preview.style.display = '';
    el('lql-gen-results').innerHTML = '';
    el('lql-gen-run-status').textContent = '';
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
  } finally {
    btn.disabled = false;
  }
});

el('lql-gen-run').addEventListener('click', async () => {
  if (!_genQueryText) return;

  const btn      = el('lql-gen-run');
  const statusEl = el('lql-gen-run-status');
  const resultsEl = el('lql-gen-results');

  btn.disabled         = true;
  statusEl.textContent = 'running…';
  statusEl.className   = '';
  resultsEl.innerHTML  = '';
  setStatus('running LQL…', 'busy');

  try {
    const res  = await fetch('http://localhost:8765/lql/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ queryText: _genQueryText }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const rows  = data.rows || [];
    const count = data.count ?? rows.length;
    const total = data.total ?? count;

    statusEl.textContent = total > count
      ? `${count} rows (${total} total)`
      : `${count} row${count !== 1 ? 's' : ''}`;
    statusEl.className = count ? 'ok' : '';
    setStatus(`LQL: ${count} rows`, 'ok');

    if (!rows.length) {
      resultsEl.innerHTML = '<pre>No results.</pre>';
      return;
    }

    const keys   = Object.keys(rows[0]);
    const widths = Object.fromEntries(keys.map(k => [k, k.length]));
    rows.forEach(r => keys.forEach(k => {
      widths[k] = Math.max(widths[k], String(r[k] ?? '').length);
    }));
    const pad    = (s, w) => String(s ?? '').padEnd(w);
    const header = keys.map(k => pad(k, widths[k])).join('  ');
    const sep    = keys.map(k => '-'.repeat(widths[k])).join('  ');
    const body   = rows.slice(0, 200).map(r =>
      keys.map(k => pad(r[k], widths[k])).join('  ')
    ).join('\n');
    const note = rows.length > 200 ? `\n… ${rows.length - 200} more rows` : '';

    const pre = document.createElement('pre');
    pre.textContent = `${header}\n${sep}\n${body}${note}`;
    resultsEl.appendChild(pre);

    history.push({
      role: 'user',
      content: `I generated and ran an LQL query for "${el('lql-objective').value}" and got ${count} rows:\n\n${header}\n${sep}\n${body}${note}\n\nAnalyse these findings.`,
    });
    history.push({ role: 'assistant', content: 'Results loaded.' });
    appendTurn('system', `✨ Generated LQL — ${count} rows loaded into context`);
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'err';
    setStatus('LQL error', 'err');
    resultsEl.innerHTML  = `<pre style="color:var(--err)">${e.message}</pre>`;
  } finally {
    btn.disabled = false;
  }
});

// ── enter key on objective input triggers build ────────────────────────────
el('lql-objective').addEventListener('keydown', e => {
  if (e.key === 'Enter') el('lql-gen-btn').click();
});

async function loadCompliancePdfText(reportName) {
  appendTurn('system', `📖 Loading "${reportName}" into context…`);
  try {
    const res  = await fetch('http://localhost:8765/compliance/latest-text');
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
