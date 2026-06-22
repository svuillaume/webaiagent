'use strict';

// ── Constants ─────────────────────────────────────────────────────────────
const MAX_TOKENS     = 512;
const PAGE_MAX_CHARS = 12000;
const SYSTEM_PROMPT  = 'Be concise. Answer in 1-3 sentences unless more detail is clearly needed. No filler phrases.';
const ROLE_LABELS    = { user: 'you ›', ai: 'ai ›', system: 'sys ›' };

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
chrome.storage.local.get('bf_model', ({ bf_model }) => {
  if (bf_model) el('model').value = bf_model;
});

async function autoFillFromConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('config.json'));
    if (!res.ok) return;
    const cfg = await res.json();
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
  } catch { /* config.json absent — user fills fields manually */ }
}

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

const scrollLog    = () => { const l = el('log'); l.scrollTop = l.scrollHeight; };
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

  const headers = {
    'Content-Type':      'application/json',
    'x-api-key':         key,
    'anthropic-version': '2023-06-01',
  };
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
