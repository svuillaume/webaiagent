'use strict';

const MAX_TOKENS = 2048;

const history = [];
let busy = false;

const el = id => document.getElementById(id);
const setStatus = (text, state = '') => { el('status').textContent = text; el('status').className = state; };

// ── Storage ───────────────────────────────────────────────────────────────
// URL + Key → session storage (RAM only, cleared on Chrome close, never touches disk)
// Model     → local storage  (not sensitive, survives restarts)
const urlInput = el('url-input');
const keyInput = el('key-input');

chrome.storage.session.get(['bf_url', 'bf_key'], ({ bf_url, bf_key }) => {
  if (bf_url) urlInput.value = bf_url;
  if (bf_key) keyInput.value = bf_key;
});
chrome.storage.local.get('bf_model', ({ bf_model }) => { if (bf_model) el('model').value = bf_model; });

urlInput.addEventListener('change', () => {
  const v = urlInput.value.trim();
  v ? chrome.storage.session.set({ bf_url: v }) : chrome.storage.session.remove('bf_url');
});
keyInput.addEventListener('change', () => {
  const v = keyInput.value.trim();
  v ? chrome.storage.session.set({ bf_key: v }) : chrome.storage.session.remove('bf_key');
});
el('model').addEventListener('change', () => chrome.storage.local.set({ bf_model: el('model').value }));

// ── Markdown renderer ─────────────────────────────────────────────────────
// Security: escape the entire string FIRST, then apply transforms.
// This prevents XSS from AI responses containing raw HTML tags.
function renderMarkdown(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Split on fenced code blocks; odd-indexed parts are code, even are prose
  return text.split(/(```[\s\S]*?```)/g).map((part, i) => {
    if (i % 2 === 1) {
      const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
      return `<pre><code>${esc(code.trimEnd())}</code></pre>`;
    }
    let s = esc(part);                                          // escape first
    s = s.replace(/`([^`\n]+)`/g,   '<code>$1</code>');        // inline code (already escaped)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); // bold (already escaped)
    return s;
  }).join('');
}

// ── DOM helpers ───────────────────────────────────────────────────────────
function appendTurn(role, text = '') {
  const turn  = document.createElement('div');
  turn.className = 'turn';

  const label = document.createElement('div');
  label.className = `role ${role}`;
  label.textContent = { user: 'you ›', ai: 'ai ›', system: 'sys ›' }[role] ?? role;

  const body = document.createElement('div');
  body.className = 'content';
  if (text) {
    // AI responses get markdown; user input and errors use textContent (no innerHTML)
    if (role === 'ai') body.innerHTML = renderMarkdown(text);
    else               body.textContent = text;
  }

  turn.append(label, body);
  el('log').appendChild(turn);
  scrollLog();
  return body;
}

function scrollLog() {
  const log = el('log');
  log.scrollTop = log.scrollHeight;
}

function resizePrompt() {
  const p = el('prompt');
  p.style.height = 'auto';
  p.style.height = Math.min(p.scrollHeight, 180) + 'px';
}

// ── Clear ─────────────────────────────────────────────────────────────────
el('clear').addEventListener('click', () => {
  history.length = 0;
  el('log').innerHTML = '';
  el('token-info').textContent = '';
  setStatus('—');
});

// ── Send ──────────────────────────────────────────────────────────────────
async function send() {
  if (busy) return;

  const baseUrl = urlInput.value.trim().replace(/\/+$/, '');
  const key     = keyInput.value.trim();
  const text    = el('prompt').value.trim();

  if (!baseUrl) { appendTurn('system', 'No endpoint URL — enter the Bifrost base URL above.'); return; }
  if (!key)     { appendTurn('system', 'No key — enter your sk-bf-… key above.'); return; }
  if (!text) return;

  const endpoint = `${baseUrl}/v1/messages`;

  history.push({ role: 'user', content: text });
  appendTurn('user', text);
  el('prompt').value = '';
  el('prompt').style.height = 'auto';

  const bubble = appendTurn('ai');
  const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
  bubble.appendChild(cursor);

  busy = true;
  el('send').disabled = true;
  setStatus('streaming…', 'busy');

  let out = '', inputTk = 0, outputTk = 0;

  try {
    const res = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: el('model').value, max_tokens: MAX_TOKENS, stream: true, messages: history }),
    });

    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let   buf    = '';

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

        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          out += ev.delta.text;
          bubble.innerHTML = renderMarkdown(out);
          bubble.appendChild(cursor);
          scrollLog();
        }
        if (ev.type === 'message_start') inputTk  = ev.message?.usage?.input_tokens ?? 0;
        if (ev.type === 'message_delta') outputTk = ev.usage?.output_tokens ?? 0;
      }
    }

    cursor.remove();
    bubble.innerHTML = renderMarkdown(out);
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

el('prompt').addEventListener('input',   resizePrompt);
el('prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
el('send').addEventListener('click',     send);

el('prompt').focus();
