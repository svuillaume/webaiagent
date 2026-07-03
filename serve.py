#!/usr/bin/env python3
# Copyright 2026 Fortinet, Inc.
# Licensed under the Apache License, Version 2.0 — see LICENSE
"""
Local proxy + static server for chatbox.html and the Chrome extension.

GET  /              → chatbox.html
GET  /config        → gateway URL, key, lw_ready flag
POST /proxy/v1/*    → proxy to AI gateway upstream
POST /codesec       → lacework SCA+SAST on submitted code
POST /sbom          → CycloneDX SBOM via lacework SCA
POST /compliance    → compliance PDF
GET  /compliance/list → available frameworks
GET  /lql/queries   → list .yaml files from LQL_QUERIES_DIR
POST /lql/run       → execute LQL against FortiCNAPP
POST /lql/cve       → CVE attack surface: hosts + containers
POST /lql/generate  → plain-English → LQL via Claude
GET  /headroom/stats  → lifetime token savings from a local Headroom proxy (HEADROOM_URL)
POST /headroom/toggle → switch chat requests between direct-to-gateway and via-Headroom
POST /model           → persist the extension's model picker as ANTHROPIC_DEFAULT_MODEL

Usage: python3 serve.py  →  http://localhost:45321
"""
import base64, http.server, io, json, os, re, shutil, socketserver, struct, subprocess, tempfile, threading, urllib.parse, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

PORT      = 45321
DIR       = os.path.dirname(os.path.abspath(__file__))

HTML_FILE = os.path.join(DIR, 'chatbox.html')


def load_env():
    env = dict(os.environ)  # start with real env vars (Docker, systemd, etc.)
    path = os.path.join(DIR, '.env')
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, _, v = line.partition('=')
                    env[k.strip()] = v.strip()  # .env overrides env vars if present
    return env

env             = load_env()
VIRTUAL_KEY     = env.get('BIFROST_VIRTUAL_KEY', '')
DIRECT_UPSTREAM = env.get('ANTHROPIC_BASE_URL', 'https://your-gateway-endpoint/anthropic')
MODEL           = env.get('ANTHROPIC_DEFAULT_MODEL', 'claude-haiku-4-5')
LQL_QUERIES_DIR = env.get('LQL_QUERIES_DIR', '')
HEADROOM_URL    = env.get('HEADROOM_URL', '').rstrip('/')  # optional local Headroom proxy, e.g. http://host.docker.internal:8789
# Browser-facing address for the dashboard link and for the extension's own direct fetch — differs
# from HEADROOM_URL when serve.py runs in Docker (host.docker.internal resolves inside the
# container, not in the host's Chrome browser, which is what caused the "Failed to fetch" bug).
HEADROOM_DASHBOARD_URL = env.get('HEADROOM_DASHBOARD_URL', '').rstrip('/') or HEADROOM_URL

# ── Headroom routing toggle ──────────────────────────────────────────────────
# In-memory switch (source of truth while the process runs) + persisted to .env so it survives
# a restart. Never overwrites ANTHROPIC_BASE_URL itself — DIRECT_UPSTREAM always stays the real
# gateway, so toggling back to "direct" can never lose it.
_state_lock = threading.Lock()
_state = {'headroom_enabled': env.get('HEADROOM_ENABLED', '0').strip().lower() in ('1', 'true', 'yes', 'on')}

def _headroom_enabled() -> bool:
    with _state_lock:
        return _state['headroom_enabled'] and bool(HEADROOM_URL)

def current_upstream() -> str:
    """Server-side outbound target — used by proxy_upstream() (chatbox.html's path)."""
    return HEADROOM_URL if _headroom_enabled() else DIRECT_UPSTREAM

def current_browser_gateway_url() -> str:
    """Browser-reachable target — used for /config's gateway_url (the extension fetches this
    directly from the browser). When routing through Headroom this points at serve.py's own
    /proxy passthrough rather than Headroom directly: Headroom's CORS allowlist rejects
    chrome-extension:// origins and the x-api-key/anthropic-version headers outright (400
    "Disallowed CORS origin, headers"), so a direct browser→Headroom fetch always fails —
    going through /proxy sidesteps CORS entirely since it's a server-side call, same as
    chatbox.html already does successfully."""
    if _headroom_enabled():
        return f'http://localhost:{PORT}/proxy'
    return DIRECT_UPSTREAM

def _write_env_var(key: str, value: str) -> None:
    """Update (or add) a single KEY=value line in .env, preserving everything else."""
    path = os.path.join(DIR, '.env')
    lines = []
    if os.path.exists(path):
        with open(path) as f:
            lines = f.readlines()
    found = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped and not stripped.startswith('#') and stripped.split('=', 1)[0].strip() == key:
            lines[i] = f'{key}={value}\n'
            found = True
            break
    if not found:
        if lines and not lines[-1].endswith('\n'):
            lines[-1] += '\n'
        lines.append(f'{key}={value}\n')
    with open(path, 'w') as f:
        f.writelines(lines)

# ── LQL reference doc retrieval (RAG-lite, LQL generation only) ─────────────
# serve.py must stay pure stdlib, so this is keyword-overlap retrieval over pre-split datasource
# chunks — not embeddings. Good enough to ground LQL generation in real field names instead of
# relying solely on hand-curated hints, without dumping the whole ~530KB doc into every prompt.
_LQL_REFERENCE_PATH = os.path.join(DIR, 'FortiCNAPP-LQL_Reference_Guide.txt')
_lql_reference_chunks = None  # lazy-loaded cache: list of (datasource_name, chunk_text)

def _load_lql_reference_chunks():
    global _lql_reference_chunks
    if _lql_reference_chunks is not None:
        return _lql_reference_chunks
    _lql_reference_chunks = []
    if not os.path.exists(_LQL_REFERENCE_PATH):
        return _lql_reference_chunks
    with open(_LQL_REFERENCE_PATH, encoding='utf-8', errors='ignore') as f:
        lines = f.readlines()

    # Strip repeating page header/footer noise interspersed mid-section
    noise_re = re.compile(r'^(FortiCNAPP [\d.]+ LQL Reference Guide|Fortinet Inc\.|Datasource Metadata)\s*\d*\s*$')
    lines = [l for l in lines if not noise_re.match(l.strip())]

    # Datasource section headers are standalone identifier lines at column 0 (LW_HE_MACHINES,
    # CloudTrailRawEvents, ...) — must NOT strip before matching, or indented in-example mentions
    # (e.g. "LW_HA_FILE_CHANGES" inside a JOIN-syntax code sample) are misdetected as new sections.
    header_re = re.compile(r'^(LW_[A-Z0-9_]+|CloudTrail\w+)\n?$')
    header_idx = [i for i, l in enumerate(lines) if header_re.match(l)]
    for n, idx in enumerate(header_idx):
        name = lines[idx].strip()
        end  = header_idx[n + 1] if n + 1 < len(header_idx) else len(lines)
        body = ''.join(lines[idx:end]).strip()
        if len(body) > 40:  # skip stray false-positive header matches with no real content
            _lql_reference_chunks.append((name, body))
    return _lql_reference_chunks

_LQL_RETRIEVAL_STOPWORDS = {
    'the', 'a', 'an', 'of', 'in', 'on', 'for', 'with', 'and', 'or', 'to', 'is', 'are', 'that',
    'this', 'find', 'list', 'show', 'get', 'all', 'any', 'has', 'have', 'not', 'without',
}

_LQL_RETRIEVAL_MIN_SCORE = 5.0  # below this, treat as no real match (avoids injecting noise for
                                 # objectives about datasources this doc doesn't catalog per-section,
                                 # e.g. LW_CFG_* AWS resource types — a raw name match alone clears this)

def _retrieve_lql_reference(objective: str, max_chunks: int = 3, max_chars: int = 5000) -> str:
    """Keyword-overlap ranked excerpts from the LQL reference doc relevant to this objective.
    Score = heavily-weighted name match + length-normalized keyword density in the body — raw counts
    alone would let the two unbounded end-of-file chunks (CloudTrailRawEvents, LW_ACT_GCP_ACTIVITY —
    both huge, no next-header boundary to cap them) win almost every query purely by sheer volume."""
    chunks = _load_lql_reference_chunks()
    if not chunks:
        return ''
    words = [w for w in re.findall(r'[a-z0-9]+', objective.lower())
             if w not in _LQL_RETRIEVAL_STOPWORDS and len(w) > 2]
    if not words:
        return ''
    scored = []
    for name, body in chunks:
        name_l, body_l = name.lower(), body.lower()
        name_score = sum(name_l.count(w) for w in words) * 25
        density    = sum(body_l.count(w) for w in words) / (len(body_l) / 1000.0)
        score = name_score + density
        if score >= _LQL_RETRIEVAL_MIN_SCORE:
            scored.append((score, name, body))
    scored.sort(key=lambda x: -x[0])

    out, budget = [], max_chars
    for _, name, body in scored[:max_chunks]:
        snippet = body[:2000]
        if len(snippet) > budget:
            break
        out.append(snippet)
        budget -= len(snippet)
    return '\n\n---\n\n'.join(out)

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, Authorization, x-portkey-api-key, helicone-auth',
}

_lql_cache: dict = {}
_fg_cache: dict = {'items': [], 'ts': 0.0}

def _fg_outbreaks_cached():
    """Fetch and parse FortiGuard outbreak RSS, cache for 30 min. Returns list of items."""
    from email.utils import parsedate_to_datetime
    import xml.etree.ElementTree as _ET

    now = datetime.now(timezone.utc).timestamp()
    if now - _fg_cache['ts'] < 1800 and _fg_cache['items']:
        return _fg_cache['items']

    try:
        req = urllib.request.Request(
            'https://www.fortiguard.com/rss/outbreakalert.xml',
            headers={'User-Agent': 'Mozilla/5.0 FortiAIScout/1.0'},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            xml_bytes = r.read()

        root = _ET.fromstring(xml_bytes)
        items = []
        for item in root.findall('.//item'):
            title   = (item.findtext('title')       or '').strip()
            link    = (item.findtext('link')         or '').strip()
            desc    = (item.findtext('description')  or '').strip()
            pub_raw = (item.findtext('pubDate')      or '').strip()
            try:
                pub_iso = parsedate_to_datetime(pub_raw).isoformat()
            except Exception:
                pub_iso = ''
            # Extract all CVE IDs mentioned in title + description
            cves = list(dict.fromkeys(
                re.findall(r'CVE-\d{4}-\d+', title + ' ' + desc, re.IGNORECASE)
            ))
            cves = [c.upper() for c in cves]
            # Extract risk/severity hint (Critical, High, Medium, Low)
            risk_m = re.search(r'\b(Critical|High|Medium|Low)\b', title + ' ' + desc, re.IGNORECASE)
            risk   = risk_m.group(1).capitalize() if risk_m else ''
            items.append({
                'title':   title,
                'link':    link,
                'pubDate': pub_iso,
                'summary': desc[:400] if desc else '',
                'cves':    cves,
                'risk':    risk,
            })
        _fg_cache['items'] = items
        _fg_cache['ts']    = now
        return items
    except Exception:
        return _fg_cache['items']  # return stale on error


# CVE intel cache: cveId → {epss, kev, nvd_cvss, outbreaks, ...}
_cve_intel_cache: dict = {}

def _fetch_cve_intel(cve: str) -> dict:
    """Fetch EPSS, CISA KEV, NVD CVSS, and FortiGuard outbreaks for a CVE. Cached 1 hour."""
    now = datetime.now(timezone.utc).timestamp()
    if cve in _cve_intel_cache and now - _cve_intel_cache[cve].get('_ts', 0) < 3600:
        return {k: v for k, v in _cve_intel_cache[cve].items() if k != '_ts'}

    result: dict = {'cveId': cve}

    def _get_json(url, headers=None, timeout=8):
        try:
            req = urllib.request.Request(url, headers=headers or {'User-Agent': 'FortiAIScout/1.0'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except Exception:
            return None

    # EPSS
    epss_data = _get_json(f'https://api.first.org/data/v1/epss?cve={cve}')
    if epss_data and epss_data.get('data'):
        e = epss_data['data'][0]
        result['epss'] = {
            'score':      float(e.get('epss', 0)),
            'percentile': float(e.get('percentile', 0)),
            'date':       e.get('date', ''),
        }
    else:
        result['epss'] = None

    # CISA KEV
    kev_data = _get_json('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', timeout=12)
    if kev_data:
        kev_entry = next((v for v in kev_data.get('vulnerabilities', []) if v.get('cveID') == cve), None)
        if kev_entry:
            result['kev'] = {
                'inKev':        True,
                'vendorProject': kev_entry.get('vendorProject', ''),
                'product':       kev_entry.get('product', ''),
                'dateAdded':     kev_entry.get('dateAdded', ''),
                'dueDate':       kev_entry.get('dueDate', ''),
                'description':   kev_entry.get('shortDescription', ''),
            }
        else:
            result['kev'] = {'inKev': False}
    else:
        result['kev'] = None

    # NVD CVSS
    nvd_data = _get_json(
        f'https://services.nvd.nist.gov/rest/json/cves/2.0?cveId={cve}',
        headers={'User-Agent': 'FortiAIScout/1.0', 'Accept': 'application/json'},
        timeout=10,
    )
    if nvd_data and nvd_data.get('vulnerabilities'):
        vuln = nvd_data['vulnerabilities'][0].get('cve', {})
        metrics = vuln.get('metrics', {})
        cvss_v3 = (metrics.get('cvssMetricV31') or metrics.get('cvssMetricV30') or [None])[0]
        cvss_v2 = (metrics.get('cvssMetricV2') or [None])[0]
        desc_list = vuln.get('descriptions', [])
        desc_en = next((d['value'] for d in desc_list if d.get('lang') == 'en'), '')
        result['nvd'] = {
            'description': desc_en[:500],
            'cvssV3Score':    cvss_v3['cvssData']['baseScore']    if cvss_v3 else None,
            'cvssV3Severity': cvss_v3['cvssData']['baseSeverity'] if cvss_v3 else None,
            'cvssV3Vector':   cvss_v3['cvssData']['vectorString']  if cvss_v3 else None,
            'cvssV2Score':    cvss_v2['cvssData']['baseScore']    if cvss_v2 else None,
            'published':      vuln.get('published', ''),
            'lastModified':   vuln.get('lastModified', ''),
        }
    else:
        result['nvd'] = None

    # FortiGuard outbreaks (from RSS)
    items = _fg_outbreaks_cached()
    result['outbreaks'] = [i for i in items if cve in i.get('cves', [])]

    # FortiGuard outbreak page scrape — PoC, patch, in-the-wild, timeline
    outbreak_slug = None
    if result['outbreaks']:
        # derive slug from link e.g. https://…/outbreak-alert/log4shell → log4shell
        link = result['outbreaks'][0].get('link', '')
        m = re.search(r'/outbreak-alert/([^/?#]+)', link)
        if m:
            outbreak_slug = m.group(1)
    result['fgOutbreakDetail'] = _scrape_fg_outbreak(outbreak_slug) if outbreak_slug else None

    # Threat Radar score (0–100): CVSS + EPSS + KEV + outbreak + PoC + patch
    score = 0
    if result['nvd'] and result['nvd']['cvssV3Score']:
        score += result['nvd']['cvssV3Score'] * 4        # max 40
    if result['epss'] and result['epss']['score']:
        score += result['epss']['score'] * 30            # max 30
    if result['kev'] and result['kev'].get('inKev'):
        score += 20                                       # +20 if actively exploited
    if result['outbreaks']:
        score += 5                                        # +5 if FortiGuard outbreak
    od = result['fgOutbreakDetail'] or {}
    if od.get('pocAvailable'):
        score += 3                                        # +3 PoC exists
    if not od.get('patchAvailable'):
        score += 2                                        # +2 no patch yet
    result['threatRadarScore'] = round(min(score, 100), 1)

    _cve_intel_cache[cve] = {**result, '_ts': now}
    return result


def _scrape_fg_outbreak(slug: str) -> dict:
    """Scrape a FortiGuard outbreak-alert page and return structured signals."""
    url = f'https://fortiguard.fortinet.com/outbreak-alert/{slug}'
    try:
        req  = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 FortiAIScout/1.0'})
        with urllib.request.urlopen(req, timeout=12) as r:
            html = r.read().decode('utf-8', errors='replace')
    except Exception:
        return {}

    result = {'slug': slug, 'url': url}

    # Risk / severity
    m = re.search(r'(?:severity|risk)[^>]*>[\s]*([A-Za-z]+)[\s]*<', html, re.I)
    if m:
        result['severity'] = m.group(1).capitalize()

    # CVE IDs mentioned on page
    result['cves'] = list(set(re.findall(r'CVE-\d{4}-\d+', html)))

    # Affected products / vendors
    m = re.search(r'(?:affected\s+(?:platform|product|vendor)s?)[^:]*:([^<\n]{5,120})', html, re.I)
    if m:
        result['affectedProducts'] = m.group(1).strip()

    # PoC availability — look for "proof-of-concept", "poc", "exploit code", "public exploit"
    poc = bool(re.search(
        r'proof.of.concept|public\s+(?:exploit|poc)|poc\s+(?:code|released|available)|exploit\s+(?:code|published)',
        html, re.I))
    result['pocAvailable'] = poc

    # Patch availability
    patch = bool(re.search(
        r'patch(?:es)?\s+(?:released|available|published)|fix(?:es)?\s+(?:released|available)|update\s+available',
        html, re.I))
    result['patchAvailable'] = patch

    # In-the-wild exploitation
    wild = bool(re.search(
        r'in.the.wild|actively\s+exploit|observed\s+exploit|real.world\s+attack',
        html, re.I))
    result['inTheWild'] = wild

    # Timeline entries — grab date lines
    timeline = re.findall(r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})[^<]{5,120}', html)
    result['timeline'] = timeline[:8]

    # Days since most recent timeline event (recency signal)
    result['daysSinceLatest'] = None
    if timeline:
        try:
            from datetime import datetime as _dt
            latest = _dt.strptime(re.sub(r'[,]', '', timeline[0]).strip(), '%B %d %Y')
            result['daysSinceLatest'] = (datetime.now(timezone.utc).replace(tzinfo=None) - latest).days
        except Exception:
            pass

    return result


class Handler(http.server.BaseHTTPRequestHandler):

    # ── helpers ───────────────────────────────────────────────────────────

    def send_pdf(self, body: bytes, filename: str):
        self.send_response(200)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header('Content-Type', 'application/pdf')
        self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, body: bytes):
        self.send_response(status)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── routing ───────────────────────────────────────────────────────────

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        if self.path in ('/', '/chatbox.html'):
            self.serve_html()
        elif self.path == '/config':
            self.serve_config()
        elif self.path == '/compliance/list':
            self.serve_compliance_list()
        elif self.path == '/lql/queries':
            self.serve_lql_queries()
        elif self.path == '/fortiguard/outbreaks':
            self.serve_fortiguard_outbreaks()
        elif self.path.startswith('/fortiguard/outbreak-by-cve'):
            self.serve_outbreak_by_cve()
        elif self.path.startswith('/fortiguard/outbreak-detail'):
            self.serve_outbreak_detail()
        elif self.path.startswith('/fortiguard/cve-intel'):
            self.serve_cve_intel()
        elif self.path == '/headroom/stats':
            self.serve_headroom_stats()
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == '/codesec':
            self.serve_codesec()
        elif self.path == '/sbom':
            self.serve_sbom()
        elif self.path == '/compliance':
            self.serve_compliance()
        elif self.path == '/lql/run':
            self.serve_lql_run()
        elif self.path == '/lql/cve':
            self.serve_lql_cve()
        elif self.path == '/lql/generate':
            self.serve_lql_generate()
        elif self.path.startswith('/proxy/'):
            self.proxy_upstream()
        elif self.path == '/headroom/toggle':
            self.serve_headroom_toggle()
        elif self.path == '/model':
            self.serve_model_update()
        else:
            self.send_error(404)

    # ── handlers ──────────────────────────────────────────────────────────

    def serve_html(self):
        with open(HTML_FILE, 'rb') as f:
            html = f.read().decode()
        if VIRTUAL_KEY:
            html = html.replace(
                'placeholder="Virtual key (x-bf-vk)…" autocomplete="off"',
                f'placeholder="Virtual key…" autocomplete="off" value="{VIRTUAL_KEY}"',
            )
        body = html.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_config(self):
        body = json.dumps({
            # Browser-reachable — the extension fetches this directly, so it must never be a
            # Docker-internal hostname (see current_browser_gateway_url()'s docstring).
            'gateway_url':   current_browser_gateway_url(),
            'api_key':       VIRTUAL_KEY,
            'lw_ready':      LW_READY,
            'lw_cli':        LW_AVAILABLE,
            'user_name':     _user_first_name(),
            'via_headroom':  _headroom_enabled(),
            'headroom_configured': bool(HEADROOM_URL),
        }).encode()
        self.send_json(200, body)

    def serve_headroom_toggle(self):
        try:
            payload = json.loads(self._read_body() or '{}')
        except json.JSONDecodeError:
            payload = {}
        enable = payload.get('enable')
        if not isinstance(enable, bool):
            self.send_json(400, json.dumps({'error': 'body must be {"enable": true|false}'}).encode())
            return
        if enable and not HEADROOM_URL:
            self.send_json(400, json.dumps({'error': 'HEADROOM_URL is not set in .env'}).encode())
            return
        with _state_lock:
            _state['headroom_enabled'] = enable
        try:
            _write_env_var('HEADROOM_ENABLED', '1' if enable else '0')
        except OSError:
            pass  # in-memory toggle still applies even if the .env write fails (e.g. read-only mount)
        self.send_json(200, json.dumps({
            'via_headroom': _headroom_enabled(),
            'gateway_url':  current_browser_gateway_url(),
        }).encode())

    def serve_model_update(self):
        """Persist the model picked in the extension's dropdown as ANTHROPIC_DEFAULT_MODEL,
        so server-side calls (/lql/generate) use the same model the user is chatting with."""
        global MODEL
        try:
            payload = json.loads(self._read_body() or '{}')
        except json.JSONDecodeError:
            payload = {}
        model = (payload.get('model') or '').strip()
        if not model:
            self.send_json(400, json.dumps({'error': 'body must be {"model": "..."}'}).encode())
            return
        MODEL = model
        try:
            _write_env_var('ANTHROPIC_DEFAULT_MODEL', model)
        except OSError:
            pass  # in-memory update still applies even if the .env write fails (e.g. read-only mount)
        self.send_json(200, json.dumps({'model': MODEL}).encode())

    def proxy_upstream(self):
        url    = current_upstream() + self.path[len('/proxy'):]
        length = int(self.headers.get('Content-Length', 0))
        body   = self.rfile.read(length)
        req    = urllib.request.Request(url, data=body, method='POST', headers={
            'content-type':      self.headers.get('content-type', 'application/json'),
            'anthropic-version': self.headers.get('anthropic-version', '2023-06-01'),
            'x-api-key':         VIRTUAL_KEY,
        })
        try:
            resp = urllib.request.urlopen(req, timeout=120)
            self.send_response(resp.status)
            for k, v in CORS.items():
                self.send_header(k, v)
            for h in ('content-type', 'x-request-id'):
                if val := resp.headers.get(h):
                    self.send_header(h, val)
            self.end_headers()
            while chunk := resp.read(4096):
                self.wfile.write(chunk)
                self.wfile.flush()
        except urllib.error.HTTPError as e:
            self.send_json(e.code, e.read())

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return self.rfile.read(length)

    def _write_files(self, tmpdir, payload):
        """Write files array [{filename, code}] or legacy {filename, code} to tmpdir.

        filename may be a relative path (e.g. src/index.js) — directory structure
        is preserved so lacework SAST can resolve cross-file references. Path components
        are sanitised to prevent traversal outside tmpdir.
        """
        def safe_path(raw_name, fallback='snippet.txt'):
            # Strip leading slashes/dots, then join under tmpdir
            parts = [p for p in raw_name.replace('\\', '/').split('/')
                     if p and p != '.' and p != '..']
            if not parts:
                parts = [fallback]
            dest = os.path.join(tmpdir, *parts)
            # Verify still inside tmpdir
            if not os.path.realpath(dest).startswith(os.path.realpath(tmpdir)):
                dest = os.path.join(tmpdir, fallback)
            return dest

        files = payload.get('files')
        if files:
            for entry in files:
                dest = safe_path(entry.get('filename', 'snippet.txt'))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, 'w') as f:
                    f.write(entry.get('code', ''))
        else:
            dest = safe_path(payload.get('filename', 'snippet.txt'))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, 'w') as f:
                f.write(payload.get('code', ''))

    def serve_codesec(self):
        """Accept JSON {files:[{filename,code}]}, run lacework SCA+SAST, return findings."""
        if not shutil.which('lacework'):
            self.send_json(503, json.dumps({'error': 'lacework CLI not found'}).encode())
            return
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {files:[{filename,code}]}')
            return

        tmpdir = tempfile.mkdtemp(prefix='webai-codesec-')
        try:
            self._write_files(tmpdir, payload)
            # Collect submitted filenames for the response (preserve relative paths)
            files_list = payload.get('files')
            if files_list:
                submitted_files = [e.get('filename', 'snippet.txt') for e in files_list]
            else:
                submitted_files = [payload.get('filename', 'snippet.txt')]
            filename = submitted_files[0] if len(submitted_files) == 1 else submitted_files

            out_json = os.path.join(tmpdir, 'sca.json')
            cmd = ['lacework', 'sca', 'scan', tmpdir,
                   '--deployment=offprem', '--noninteractive',
                   '--save-results=false', '-f', 'lw-json', '-o', out_json,
                   '--secret=false']
            if LW_PROFILE:
                cmd += ['--profile', LW_PROFILE]
            result   = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

            findings, weaknesses, secrets = [], [], []
            if os.path.exists(out_json):
                with open(out_json) as f:
                    data = json.load(f)

                # Build artifact id → {name, path} map
                art_map = {a['Id']: {'name': a.get('Name', ''), 'path': a.get('Path', '')}
                           for a in data.get('Artifacts', [])}

                # SCA vulnerabilities — top-level Vulnerabilities[]
                for vuln in data.get('Vulnerabilities', []):
                    info = vuln.get('Info', {})
                    aid  = (vuln.get('AffectedArtifactIds') or [''])[0]
                    art  = art_map.get(aid, {})
                    fv = info.get('FixVersion') or {}
                    findings.append({
                        'type':        'vuln',
                        'id':          info.get('ExternalId', ''),
                        'severity':    info.get('Severity', ''),
                        'package':     art.get('name') or art.get('path') or aid,
                        'file':        art.get('path', ''),
                        'fixVersion':  fv.get('Version', '') if isinstance(fv, dict) else str(fv),
                        'description': info.get('Description', ''),
                    })

                # SAST / secrets — top-level Weaknesses[]
                for w in data.get('Weaknesses', []):
                    for inst in w.get('Instances', []):
                        loc = (inst.get('LocationDetails') or [{}])[0]
                        ll  = loc.get('LineLocation', {})
                        cat = w.get('Info', {}).get('Category', '')
                        entry = {
                            'type':        'secret' if cat == 'Secret' else 'sast',
                            'id':          w.get('Info', {}).get('ExternalId', ''),
                            'severity':    inst.get('Severity', ''),
                            'title':       w.get('Info', {}).get('Name', ''),
                            'description': w.get('Info', {}).get('ShortDescription', ''),
                            'file':        ll.get('RelativePath', ''),
                            'line':        ll.get('Start', 0),
                            'fix':         w.get('Info', {}).get('RemediationRecommendation', ''),
                        }
                        if cat == 'Secret':
                            secrets.append(entry)
                        else:
                            weaknesses.append(entry)

            body = json.dumps({
                'filename':   filename,
                'vulns':      findings,
                'weaknesses': weaknesses,
                'secrets':    secrets,
                'stderr':     result.stderr[-2000:] if result.returncode not in (0, 1, 2) else '',
            }).encode()
            self.send_json(200, body)
        except subprocess.TimeoutExpired:
            self.send_json(504, json.dumps({'error': 'scan timed out'}).encode())
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def serve_sbom(self):
        """Accept JSON {files:[{filename,code}], format?}, return SBOM via lacework SCA."""
        if not shutil.which('lacework'):
            self.send_json(503, json.dumps({'error': 'lacework CLI not found'}).encode())
            return
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {files:[{filename,code}]}')
            return

        VALID_FORMATS = {'sarif', 'cdx-xml', 'cdx-json', 'spdx-json', 'spdx-tag', 'spdx-yaml', 'lw-json', 'gitlab-json'}
        fmt = payload.get('format', 'cdx-json')
        if fmt not in VALID_FORMATS:
            self.send_error(400, f'Unknown SBOM format: {fmt}')
            return

        EXT_MAP = {'cdx-xml': 'xml', 'spdx-json': 'json', 'spdx-tag': 'spdx',
                   'spdx-yaml': 'yaml', 'sarif': 'json', 'lw-json': 'json',
                   'gitlab-json': 'json', 'cdx-json': 'json'}
        ext = EXT_MAP.get(fmt, 'json')

        tmpdir = tempfile.mkdtemp(prefix='webai-sbom-')
        try:
            self._write_files(tmpdir, payload)

            out_file = os.path.join(tmpdir, f'sbom.{ext}')
            cmd = ['lacework', 'sca', 'scan', tmpdir,
                   '--deployment=offprem', '--noninteractive',
                   '--save-results=false', '-f', fmt, '-o', out_file]
            if LW_PROFILE:
                cmd += ['--profile', LW_PROFILE]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

            if os.path.exists(out_file):
                with open(out_file) as f:
                    raw = f.read()
                if fmt == 'cdx-json':
                    self.send_json(200, raw.encode())
                else:
                    encoded = raw.encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/plain; charset=utf-8')
                    self.send_header('Content-Length', str(len(encoded)))
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(encoded)
            else:
                self.send_json(200, json.dumps({
                    'error':  'no SBOM generated — no packages detected in snippet',
                    'stderr': result.stderr[-2000:],
                }).encode())
        except subprocess.TimeoutExpired:
            self.send_json(504, json.dumps({'error': 'scan timed out'}).encode())
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def _lw_token(self):
        account, api_key, api_secret = _lw_creds()
        if not (account and api_key and api_secret):
            raise ValueError(
                'FortiCNAPP credentials not found. Set LW_ACCOUNT / LW_API_KEY / LW_API_SECRET '
                'env vars, or run: lacework configure')
        base_url = f'https://{account}.lacework.net'
        body = json.dumps({'keyId': api_key, 'expiryTime': 3600}).encode()
        req = urllib.request.Request(
            f'{base_url}/api/v2/access/tokens', data=body, method='POST',
            headers={'X-LW-UAKS': api_secret, 'Content-Type': 'application/json'})
        resp = urllib.request.urlopen(req, timeout=15)
        token_data = json.loads(resp.read())
        return token_data['token'], base_url

    def _lw_evaluator_id(self, token, base_url, query_text):
        """LW_CFG_AWS/AZURE/GCP queries need an evaluatorId; workload datasources return None."""
        qt_upper = query_text.upper()
        if   'LW_CFG_AWS_'   in qt_upper: prefix = 'AWS'
        elif 'LW_CFG_AZURE_' in qt_upper: prefix = 'AZURE'
        elif 'LW_CFG_GCP_'   in qt_upper: prefix = 'GCP'
        else:                              return None
        headers = {'Authorization': f'Bearer {token}'}
        for url in [
            f'{base_url}/api/v2/CloudAccounts',
            f'{base_url}/api/v2/Integrations',
        ]:
            try:
                resp = urllib.request.urlopen(
                    urllib.request.Request(url, headers=headers), timeout=10)
                items = json.loads(resp.read()).get('data', [])
                for item in items:
                    item_type = (item.get('type') or '').upper()
                    if prefix in item_type:
                        guid = (item.get('intgGuid') or item.get('guid')
                                or item.get('id') or item.get('integrationGuid'))
                        if guid:
                            return guid
            except Exception:
                continue
        return None

    def _call_lw_api(self, token, base_url, path, body=None):
        """POST (with body) or GET a FortiCNAPP REST API v2 path. Returns parsed data list."""
        method = 'POST' if body is not None else 'GET'
        req = urllib.request.Request(
            f'{base_url}{path}',
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        )
        try:
            resp = urllib.request.urlopen(req, timeout=20)
            raw  = json.loads(resp.read())
            return raw.get('data', raw) if isinstance(raw, dict) else raw
        except Exception:
            return []

    def _lw_schema_hints(self, token, base_url):
        """Return a compact string of live tenant metadata useful for LQL generation."""
        hints = []
        # Active cloud accounts
        accounts = self._call_lw_api(token, base_url, '/api/v2/CloudAccounts')
        if accounts:
            aliases = sorted({a.get('name') or a.get('accountAlias') or '' for a in accounts if isinstance(a, dict)} - {''})
            if aliases:
                hints.append(f'Active cloud accounts (use these ACCOUNT_ALIAS values): {", ".join(aliases[:8])}')
        # Active regions — sample from inventory (try each CSP; inventory requires csp field)
        now   = datetime.now(timezone.utc)
        start = (now - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
        end   = now.strftime('%Y-%m-%dT%H:%M:%SZ')
        regions = set()
        for csp in ('AWS', 'AZURE', 'GCP'):
            inv = self._call_lw_api(token, base_url, '/api/v2/Inventory/search', {
                'timeFilter': {'startTime': start, 'endTime': end},
                'csp': csp,
                'returns': ['resourceRegion', 'csp'],
            })
            for r in (inv or []):
                if isinstance(r, dict) and r.get('resourceRegion'):
                    regions.add(r['resourceRegion'])
            if len(regions) >= 12:
                break
        if regions:
            hints.append(f'Active regions in inventory: {", ".join(sorted(regions)[:12])}')
        return '\n'.join(hints)

    def _inventory_keyword_search(self, token, base_url, term, csp='AWS'):
        """Pattern-match a keyword (e.g. a named app/software) against resourceConfig
        across ALL resource types via the REST Inventory API — covers Lambda function
        names, ECS task defs/images, EC2 tags/names, EKS, etc. that no single LQL
        datasource models. Complements (not replaces) LQL's structural queries."""
        now   = datetime.now(timezone.utc)
        start = (now - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
        end   = now.strftime('%Y-%m-%dT%H:%M:%SZ')
        items = self._call_lw_api(token, base_url, '/api/v2/Inventory/search', {
            'timeFilter': {'startTime': start, 'endTime': end},
            'csp': csp,
            'filters': [{'field': 'resourceConfig', 'expression': 'rlike', 'value': f'.*{term}.*'}],
            'returns': ['urn', 'resourceType', 'resourceRegion', 'csp', 'service', 'resourceConfig'],
        })
        return items or []

    def _enrich_lql_with_api(self, token, base_url, query_text, rows):
        """
        Enrich LQL results with correlated FortiCNAPP REST API v2 data.

        API contract (from lacework-api-v2.yaml):
          - All search bodies use "timeFilter" (singular), not "timeFilters"
          - Alerts: only "eq" expression supported on severity/status/alertType/etc.
            Use multiple eq filters (one per severity) since "in" is not allowed.
          - Vulnerabilities/Hosts, /Containers, Entities/*, CloudActivities:
            full GENERIC_FILTERS — supports "in" with "values" (plural array).
          - Inventory: requires "csp" field (AWS|AZURE|GCP); "in" via "values".
        """
        if not rows:
            return {}

        now   = datetime.now(timezone.utc)
        start = (now - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
        end   = now.strftime('%Y-%m-%dT%H:%M:%SZ')
        tf    = {'startTime': start, 'endTime': end}  # timeFilter (singular) key
        qt_upper = query_text.upper()

        enrichment = {}

        def _alerts_critical_high(extra_filters=None):
            """Fetch open Critical + High alerts (two calls, Alerts API only supports eq on severity)."""
            result = []
            for sev in ('Critical', 'High'):
                f = [{'field': 'status', 'expression': 'eq', 'value': 'Open'},
                     {'field': 'severity', 'expression': 'eq', 'value': sev}]
                if extra_filters:
                    f += extra_filters
                batch = self._call_lw_api(token, base_url, '/api/v2/Alerts/search', {
                    'timeFilter': tf,
                    'filters': f,
                    'returns': ['alertId', 'severity', 'alertType', 'alertName',
                                'startTime', 'alertInfo', 'derivedFields', 'reachability'],
                })
                result.extend(batch or [])
            return result

        # ── Workload datasources (LW_HE_*, LW_HA_*) ─────────────────────────
        # LW_HE_IMAGES and LW_HE_CONTAINERS start with LW_HE_ so they match first;
        # container vuln lookup is handled below inside the same branch.
        if any(ds in qt_upper for ds in ('LW_HE_', 'LW_HA_')):
            mids = list({str(r.get('MID', '')) for r in rows if r.get('MID')} - {''})[:20]

            # Container images: look up CVEs by imageId
            if any(ds in qt_upper for ds in ('LW_HE_IMAGES', 'LW_HE_CONTAINERS')):
                image_ids = list({str(r.get('IMAGE_ID') or r.get('CONTAINER_ID') or '')
                                  for r in rows if r.get('IMAGE_ID') or r.get('CONTAINER_ID')} - {''})[:15]
                if image_ids:
                    for sev in ('Critical', 'High'):
                        cvulns = self._call_lw_api(token, base_url, '/api/v2/Vulnerabilities/Containers/search', {
                            'timeFilter': tf,
                            'filters': [
                                {'field': 'severity', 'expression': 'eq', 'value': sev},
                                {'field': 'imageId',  'expression': 'in', 'values': image_ids},
                            ],
                            'returns': ['imageId', 'severity', 'vulnId', 'featureKey', 'fixInfo', 'status'],
                        })
                        if cvulns:
                            prev = enrichment.get('container_vulnerabilities', {})
                            enrichment['container_vulnerabilities'] = {
                                'count': prev.get('count', 0) + len(cvulns),
                                'description': 'Critical/High CVEs on matched container images',
                                'items': (prev.get('items', []) + cvulns)[:10],
                            }

            if mids:
                # Host CVEs via Vulnerabilities/Hosts
                host_vulns = []
                for sev in ('Critical', 'High'):
                    hv = self._call_lw_api(token, base_url, '/api/v2/Vulnerabilities/Hosts/search', {
                        'timeFilter': tf,
                        'filters': [
                            {'field': 'severity', 'expression': 'eq', 'value': sev},
                            {'field': 'status',   'expression': 'eq', 'value': 'Active'},
                            {'field': 'mid',      'expression': 'in', 'values': mids},
                        ],
                        'returns': ['mid', 'severity', 'vulnId', 'featureKey', 'fixInfo', 'status', 'machineTags'],
                    })
                    host_vulns.extend(hv or [])
                if host_vulns:
                    enrichment['vulnerabilities'] = {
                        'count': len(host_vulns),
                        'description': 'Active Critical/High CVEs on matched hosts',
                        'items': host_vulns[:10],
                    }

                # Machine details for hostname / internet exposure
                machines = self._call_lw_api(token, base_url, '/api/v2/Entities/Machines/search', {
                    'timeFilter': tf,
                    'filters': [{'field': 'mid', 'expression': 'in', 'values': mids}],
                    'returns': ['mid', 'hostname', 'machineTags', 'primaryIpAddr'],
                })
                if machines:
                    enrichment['machines'] = {
                        'count': len(machines),
                        'description': 'Host details for matched MIDs',
                        'items': machines[:10],
                    }

            # Open alerts — no mid filter on Alerts (not supported); fetch by category
            alerts = _alerts_critical_high()
            if alerts:
                # Post-filter: keep alerts whose entityMap or alertInfo mentions a known hostname
                hostnames = {m.get('hostname', '') for m in (enrichment.get('machines', {}).get('items') or [])} - {''}
                if hostnames:
                    filtered = [a for a in alerts if isinstance(a, dict) and
                                any(h in json.dumps(a) for h in hostnames)]
                    alerts = filtered if filtered else alerts[:10]
                enrichment['alerts'] = {
                    'count': len(alerts),
                    'description': 'Open Critical/High alerts (filtered to matched hosts)',
                    'items': alerts[:10],
                }

        # ── Config datasources (LW_CFG_*, LW_APA_*, LW_CE_*) ─────────────────
        if any(ds in qt_upper for ds in ('LW_CFG_', 'LW_APA_', 'LW_CE_')):
            arns = list({str(r.get('RESOURCE_KEY') or r.get('ARN') or '')
                         for r in rows if r.get('RESOURCE_KEY') or r.get('ARN')} - {''})[:20]

            # ── S3 sensitive-data correlation ─────────────────────────────────
            # LQL can only see structural config (public access blocks, encryption).
            # The Inventory API resourceConfig carries user-defined tags
            # (DataClassification, Sensitivity, data-classification, etc.) and
            # compliance status — fetch these per bucket and surface alongside the
            # LQL exposure findings so Claude can correlate "this exposed bucket
            # also contains PII-tagged objects".
            is_s3_query = any(ds in qt_upper for ds in ('LW_CFG_AWS_S3', 'LW_CFG_AWS_S3CONTROL'))
            if is_s3_query and arns:
                s3_inv = self._call_lw_api(token, base_url, '/api/v2/Inventory/search', {
                    'timeFilter': tf,
                    'csp': 'AWS',
                    'filters': [
                        {'field': 'urn',          'expression': 'in',  'values': arns},
                        {'field': 'resourceType', 'expression': 'rlike', 'value': '.*[Ss]3.*'},
                    ],
                    'returns': ['urn', 'resourceType', 'resourceRegion', 'csp',
                                'service', 'status', 'apiKey', 'resourceConfig', 'cloudDetails'],
                })
                if s3_inv:
                    # Extract tag-based data-classification hints from each bucket
                    SENSITIVE_TAG_KEYS = {
                        'dataclassification', 'data-classification', 'data_classification',
                        'sensitivity', 'data-sensitivity', 'datasensitivity',
                        'data-category', 'datacategory', 'pii', 'phi', 'pci',
                        'classification', 'data-type', 'datatype',
                    }
                    SENSITIVE_TAG_VALUES = {
                        'pii', 'phi', 'pci', 'sensitive', 'confidential', 'restricted',
                        'private', 'internal', 'secret', 'high', 'critical',
                    }
                    classified = []
                    for item in s3_inv:
                        tags = {}
                        # Tags live in resourceConfig.TagSet or cloudDetails.tags
                        rc = item.get('resourceConfig') or {}
                        tagset = rc.get('TagSet') or rc.get('Tags') or []
                        if isinstance(tagset, list):
                            tags = {t.get('Key', '').lower(): t.get('Value', '').lower()
                                    for t in tagset if isinstance(t, dict)}
                        elif isinstance(tagset, dict):
                            tags = {k.lower(): v.lower() for k, v in tagset.items()}
                        # Also check cloudDetails
                        cd = item.get('cloudDetails') or {}
                        cd_tags = cd.get('tags') or cd.get('TagSet') or {}
                        if isinstance(cd_tags, dict):
                            tags.update({k.lower(): v.lower() for k, v in cd_tags.items()})

                        sensitive_tags = {k: v for k, v in tags.items()
                                          if k in SENSITIVE_TAG_KEYS or v in SENSITIVE_TAG_VALUES}
                        classified.append({
                            'urn':            item.get('urn', ''),
                            'resourceRegion': item.get('resourceRegion', ''),
                            'status':         item.get('status', ''),
                            'sensitive_tags': sensitive_tags,
                            'has_sensitive_tags': bool(sensitive_tags),
                        })

                    sensitive_count = sum(1 for b in classified if b['has_sensitive_tags'])
                    enrichment['s3_sensitive_data'] = {
                        'count':           len(classified),
                        'sensitive_count': sensitive_count,
                        'description':     (
                            f'{sensitive_count} of {len(classified)} exposed S3 buckets '
                            f'carry data-classification tags indicating sensitive content'
                            if sensitive_count else
                            f'{len(classified)} exposed S3 buckets checked — '
                            f'no data-classification tags found (buckets may be untagged)'
                        ),
                        'items': classified[:10],
                    }

            # Inventory lookup per CSP (requires explicit csp field)
            if arns:
                for csp in ('AWS', 'AZURE', 'GCP'):
                    inv = self._call_lw_api(token, base_url, '/api/v2/Inventory/search', {
                        'timeFilter': tf,
                        'csp': csp,
                        'filters': [{'field': 'urn', 'expression': 'in', 'values': arns}],
                        'returns': ['urn', 'resourceType', 'resourceRegion', 'csp',
                                    'service', 'status', 'apiKey'],
                    })
                    if inv:
                        prev = enrichment.get('inventory', {})
                        enrichment['inventory'] = {
                            'count': prev.get('count', 0) + len(inv),
                            'description': 'Inventory status for matched cloud resources',
                            'items': (prev.get('items', []) + inv)[:10],
                        }

            # Open alerts narrowed by account alias post-filter
            alerts = _alerts_critical_high()
            if alerts:
                account_aliases = list({str(r.get('ACCOUNT_ALIAS') or '') for r in rows} - {''})[:5]
                if account_aliases:
                    filtered = [a for a in alerts if isinstance(a, dict) and
                                any(alias in json.dumps(a) for alias in account_aliases)]
                    alerts = filtered if filtered else alerts[:10]
                enrichment['alerts'] = {
                    'count': len(alerts),
                    'description': 'Open Critical/High alerts in matched accounts',
                    'items': alerts[:10],
                }

        # ── CloudTrail events ─────────────────────────────────────────────────
        if 'CLOUDTRAILRAWEVENTS' in qt_upper:
            event_names = list({str(r.get('EVENT_NAME') or '') for r in rows
                                if r.get('EVENT_NAME')} - {''})[:10]
            if event_names:
                activities = self._call_lw_api(token, base_url, '/api/v2/CloudActivities/search', {
                    'timeFilter': tf,
                    'filters': [{'field': 'eventType', 'expression': 'in', 'values': event_names}],
                    'returns': ['startTime', 'endTime', 'eventType', 'eventActor',
                                'eventModel', 'sourceIPAddress', 'entityMap'],
                })
                if activities:
                    enrichment['cloud_activities'] = {
                        'count': len(activities),
                        'description': 'Correlated CloudTrail activity events',
                        'items': activities[:10],
                    }

        return enrichment

    def _lw_alert_channel(self, token, base_url):
        """Return the first available alert channel guid from the tenant."""
        req  = urllib.request.Request(
            f'{base_url}/api/v2/ReportConfigurations',
            headers={'Authorization': f'Bearer {token}'})
        resp = urllib.request.urlopen(req, timeout=10)
        for cfg in json.loads(resp.read()).get('data', []):
            chs = cfg.get('alertChannels', [])
            if chs:
                return chs[0]
        raise ValueError('No alert channel found — at least one ReportConfiguration must exist')

    def serve_compliance_list(self):
        try:
            token, base_url = self._lw_token()
        except Exception as e:
            self.send_json(503, json.dumps({'error': str(e)}).encode())
            return
        req = urllib.request.Request(
            f'{base_url}/api/v2/Frameworks',
            headers={'Authorization': f'Bearer {token}'})
        try:
            resp       = urllib.request.urlopen(req, timeout=15)
            frameworks = json.loads(resp.read()).get('data', [])
            result = [
                {
                    'guid':   f['guid'],
                    'name':   f['name'],
                    'clouds': f.get('domains', []),
                }
                for f in frameworks
                if f.get('guid') and f.get('name')
            ]
            self.send_json(200, json.dumps({'frameworks': result}).encode())
        except urllib.error.HTTPError as e:
            self.send_json(e.code, e.read())

    def serve_compliance(self):
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {frameworkGuid, frameworkName}')
            return

        fw_guid = payload.get('frameworkGuid', '').strip()
        fw_name = payload.get('frameworkName', fw_guid)
        clouds  = payload.get('clouds', [])

        if not fw_guid:
            self.send_json(400, json.dumps({'error': 'frameworkGuid is required'}).encode())
            return

        try:
            token, base_url = self._lw_token()
            alert_ch        = self._lw_alert_channel(token, base_url)
        except Exception as e:
            self.send_json(503, json.dumps({'error': str(e)}).encode())
            return

        cloud_str = ' '.join(clouds).upper()
        if 'AZURE' in cloud_str:
            rg = 'LACEWORK_RESOURCE_GROUP_ALL_AZURE'
        elif 'GCP' in cloud_str or 'GOOGLE' in cloud_str:
            rg = 'LACEWORK_RESOURCE_GROUP_ALL_GCP'
        elif 'OCI' in cloud_str or 'ORACLE' in cloud_str:
            rg = 'LACEWORK_RESOURCE_GROUP_ALL_OCI'
        else:
            rg = 'LACEWORK_RESOURCE_GROUP_ALL_AWS'

        end   = datetime.now(timezone.utc)
        start = end - timedelta(days=7)
        fmt_t = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
        headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

        cfg_body = json.dumps({
            'name':         f'webai-tmp-{fw_guid[:8]}',
            'format':       'PDF',
            'type':         'Compliance',
            'templateGuid': fw_guid,
            'frequency':    'monthly',
            'enabled':      0,
            'filters': {
                'severities': ['critical','high','medium','low','info'],
                'violations': ['Compliant','NonCompliant','Suppressed','CouldNotAssess','Manual'],
            },
            'resourceGroups': [rg],
            'alertChannels':  [alert_ch],
        }).encode()

        cfg_guid = None
        try:
            req  = urllib.request.Request(
                f'{base_url}/api/v2/ReportConfigurations',
                data=cfg_body, method='POST', headers=headers)
            resp = urllib.request.urlopen(req, timeout=15)
            cfg_guid = json.loads(resp.read())['data']['reportConfigGuid']

            gen_url = (f'{base_url}/api/v2/ReportConfigurations/{cfg_guid}/generate'
                       f'?startTime={fmt_t(start)}&endTime={fmt_t(end)}&format=pdf')
            req2     = urllib.request.Request(gen_url, method='POST', headers=headers)
            resp2    = urllib.request.urlopen(req2, timeout=120)
            pdf_bytes = resp2.read()
            safe_name = fw_name.replace('/', '-').replace(' ', '_')[:60]
            self.send_pdf(pdf_bytes, f'compliance-{safe_name}.pdf')

        except urllib.error.HTTPError as e:
            err_body = e.read()
            try:
                err_msg = json.loads(err_body).get('message', err_body.decode(errors='replace'))
            except Exception:
                err_msg = err_body.decode(errors='replace')[:500]
            self.send_json(e.code, json.dumps({'error': err_msg}).encode())
        finally:
            if cfg_guid:
                try:
                    urllib.request.urlopen(
                        urllib.request.Request(
                            f'{base_url}/api/v2/ReportConfigurations/{cfg_guid}',
                            method='DELETE', headers=headers),
                        timeout=10)
                except Exception:
                    pass

    def serve_lql_cve(self):
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {cveId}')
            return

        cve_id = (payload.get('cveId') or '').strip().upper()
        if not cve_id:
            self.send_json(400, json.dumps({'error': 'cveId is required'}).encode())
            return
        days = int(payload.get('days', 7))

        try:
            token, base_url = self._lw_token()
        except Exception as e:
            self.send_json(503, json.dumps({'error': str(e)}).encode())
            return

        headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
        now   = datetime.now(timezone.utc)
        start = (now - timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')
        end   = now.strftime('%Y-%m-%dT%H:%M:%SZ')

        def _post_api(path, body):
            req  = urllib.request.Request(
                f'{base_url}{path}', data=json.dumps(body).encode(),
                method='POST', headers=headers)
            try:
                resp = urllib.request.urlopen(req, timeout=60)
                raw  = resp.read()
                return json.loads(raw) if raw.strip() else {}
            except urllib.error.HTTPError as e:
                err = e.read()
                try:
                    msg = json.loads(err).get('message', err.decode()[:400])
                except Exception:
                    msg = err.decode()[:400]
                raise RuntimeError(f'{e.code}: {msg}')

        vuln_rows = []
        for sev in ('Critical', 'High'):
            try:
                resp = _post_api('/api/v2/Vulnerabilities/Hosts/search', {
                    'timeFilter': {'startTime': start, 'endTime': end},
                    'filters': [
                        {'field': 'status',   'expression': 'eq', 'value': 'Active'},
                        {'field': 'severity', 'expression': 'eq', 'value': sev},
                        {'field': 'vulnId',   'expression': 'eq', 'value': cve_id},
                    ],
                    'returns': ['vulnId', 'severity', 'status', 'cveRiskScore',
                                'hostRiskScore', 'featureKey', 'fixInfo',
                                'machineTags', 'mid', 'evalCtx'],
                    'limit': 5000,
                })
                vuln_rows.extend(resp.get('data', []))
            except RuntimeError:
                pass

        if not vuln_rows:
            self.send_json(200, json.dumps({
                'cveId': cve_id, 'hosts': [], 'total_affected': 0,
                'note': f'No active records for {cve_id} in the last {days} days.',
            }).encode())
            return

        hosts = {}
        for v in vuln_rows:
            mid   = str(v.get('mid', 'unknown'))
            tags  = v.get('machineTags') or {}
            ctx   = v.get('evalCtx') or {}
            fk    = v.get('featureKey') or {}
            fi    = v.get('fixInfo') or {}

            if mid not in hosts:
                hosts[mid] = {
                    'mid':              mid,
                    'hostname':         tags.get('Hostname') or ctx.get('hostname') or mid,
                    'account':          tags.get('Account') or tags.get('account') or '',
                    'region':           tags.get('Region') or tags.get('region') or '',
                    # lw_InternetExposure is often unpopulated — fall back to "has a public IP"
                    'host_exposed':     (str(tags.get('lw_InternetExposure', '')).lower() == 'yes'
                                          or bool(tags.get('ExternalIp'))),
                    'host_risk_score':  float(v.get('hostRiskScore') or 0),
                    'cve_risk_score':   float(v.get('cveRiskScore') or 0),
                    'severity':         v.get('severity', ''),
                    'packages':         [],
                    'fix_available':    str(fi.get('fix_available', '0')) == '1',
                    'fixed_version':    fi.get('fixed_version') or '',
                    'containers':       [],   # filled in step 3
                    'container_exposed': False,
                }
            else:
                hosts[mid]['host_risk_score'] = max(
                    hosts[mid]['host_risk_score'], float(v.get('hostRiskScore') or 0))
                if not hosts[mid]['fix_available']:
                    hosts[mid]['fix_available'] = str(fi.get('fix_available', '0')) == '1'
                    hosts[mid]['fixed_version']  = fi.get('fixed_version') or ''

            pkg = fk.get('name') or ''
            ver = fk.get('version') or ''
            if pkg and pkg not in [p['name'] for p in hosts[mid]['packages']]:
                hosts[mid]['packages'].append({'name': pkg, 'version': ver})

        mids  = list(hosts.keys())
        BATCH = 20
        for i in range(0, len(mids), BATCH):
            batch = mids[i:i + BATCH]
            try:
                resp = _post_api('/api/v2/Inventory/search', {
                    'csp': 'AWS',
                    'filters': [{'field': 'resourceType', 'expression': 'eq',
                                 'value': 'container:workload'}],
                    'returns': ['urn', 'resourceType', 'resourceConfig',
                                'resourceTags', 'resourceRegion', 'status'],
                    'limit': 1000,
                })
                for item in resp.get('data', []):
                    cfg  = item.get('resourceConfig') or {}
                    itags = item.get('resourceTags') or {}
                    c_mid = str(itags.get('mid') or cfg.get('MID') or '')
                    c_host = str(itags.get('Hostname') or cfg.get('Hostname') or '')
                    matched_mid = None
                    if c_mid in hosts:
                        matched_mid = c_mid
                    else:
                        for m, h in hosts.items():
                            if c_host and c_host == h['hostname']:
                                matched_mid = m
                                break
                    if not matched_mid:
                        continue
                    name    = (cfg.get('ContainerName') or cfg.get('Name')
                               or item.get('urn', '').split('/')[-1])
                    image   = cfg.get('ImageName') or cfg.get('Image') or ''
                    exposed = str(itags.get('lw_InternetExposure', '')).lower() == 'yes'
                    hosts[matched_mid]['containers'].append({
                        'name': name, 'image': image, 'internet_exposed': exposed,
                    })
                    if exposed:
                        hosts[matched_mid]['container_exposed'] = True
            except RuntimeError:
                pass

        sorted_hosts = sorted(
            hosts.values(),
            key=lambda h: (
                0 if (h['host_exposed'] or h['container_exposed']) else 1,
                -h['host_risk_score'],
            )
        )

        exposed_count   = sum(1 for h in sorted_hosts if h['host_exposed'] or h['container_exposed'])
        fixable_count   = sum(1 for h in sorted_hosts if h['fix_available'])
        container_count = sum(len(h['containers']) for h in sorted_hosts)

        self.send_json(200, json.dumps({
            'cveId':           cve_id,
            'period_days':     days,
            'total_affected':  len(sorted_hosts),
            'internet_exposed': exposed_count,
            'fixable':         fixable_count,
            'total_containers': container_count,
            'hosts':           sorted_hosts,
        }, default=str).encode())

    def serve_lql_queries(self):
        if not LQL_QUERIES_DIR or not os.path.isdir(LQL_QUERIES_DIR):
            self.send_json(200, json.dumps({'queries': []}).encode())
            return
        files = sorted(f for f in os.listdir(LQL_QUERIES_DIR) if f.endswith('.yaml'))
        queries = []
        for fname in files:
            path = os.path.join(LQL_QUERIES_DIR, fname)
            query_id, query_text = fname[:-5], ''
            try:
                with open(path) as f:
                    raw = f.read()
                for line in raw.splitlines():
                    if line.startswith('queryId:'):
                        query_id = line.split(':', 1)[1].strip()
                        break
                lines = raw.splitlines()
                in_block, block_indent = False, 0
                lql_lines = []
                for line in lines:
                    if not in_block and line.strip().startswith('queryText:'):
                        in_block = True
                        continue
                    if in_block:
                        if not line.strip():
                            lql_lines.append('')
                            continue
                        indent = len(line) - len(line.lstrip())
                        if block_indent == 0:
                            block_indent = indent
                        if indent >= block_indent:
                            lql_lines.append(line[block_indent:])
                        else:
                            break
                query_text = '\n'.join(lql_lines).strip()
            except Exception:
                pass
            queries.append({'id': query_id, 'filename': fname, 'queryText': query_text})
        self.send_json(200, json.dumps({'queries': queries}).encode())

    def serve_fortiguard_outbreaks(self):
        self.send_json(200, json.dumps({'items': _fg_outbreaks_cached()}).encode())

    def serve_outbreak_by_cve(self):
        """Return FortiGuard outbreak intel matching a CVE ID."""
        qs    = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        cve   = (qs.get('cveId', [''])[0]).upper().strip()
        items = _fg_outbreaks_cached()
        if not cve:
            self.send_json(400, json.dumps({'error': 'cveId required'}).encode())
            return
        matches = [i for i in items if cve in i.get('cves', [])]
        self.send_json(200, json.dumps({'cveId': cve, 'outbreaks': matches}).encode())

    def serve_outbreak_detail(self):
        """Scrape a FortiGuard outbreak page by slug and return structured signals."""
        qs   = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        slug = (qs.get('slug', [''])[0]).strip()
        if not slug or not re.match(r'^[\w-]+$', slug):
            self.send_json(400, json.dumps({'error': 'slug required'}).encode())
            return
        self.send_json(200, json.dumps(_scrape_fg_outbreak(slug)).encode())

    def serve_cve_intel(self):
        """Aggregate CVE threat intel: FortiGuard outbreaks + EPSS + CISA KEV + NVD CVSS."""
        qs  = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        cve = (qs.get('cveId', [''])[0]).upper().strip()
        if not cve:
            self.send_json(400, json.dumps({'error': 'cveId required'}).encode())
            return
        result = _fetch_cve_intel(cve)
        self.send_json(200, json.dumps(result).encode())

    def serve_headroom_stats(self):
        """Proxy Headroom's lifetime savings — keeps the extension's CSP from needing
        a direct route to the Headroom proxy, same pattern as the FortiGuard routes above."""
        if not HEADROOM_URL:
            self.send_json(200, json.dumps({'available': False}).encode())
            return
        try:
            req = urllib.request.Request(f'{HEADROOM_URL}/stats-history',
                                          headers={'User-Agent': 'FortiAIScout/1.0'})
            with urllib.request.urlopen(req, timeout=4) as r:
                data = json.loads(r.read())
            lifetime      = data.get('lifetime', {})
            tokens_saved  = lifetime.get('tokens_saved', 0)
            # total_input_tokens is what was actually SENT (post-compression), so the original
            # pre-compression total is tokens_saved + total_input_tokens.
            tokens_after  = lifetime.get('total_input_tokens', 0)
            tokens_before = tokens_saved + tokens_after
            savings_pct   = round((tokens_saved / tokens_before) * 100, 1) if tokens_before else 0.0
            self.send_json(200, json.dumps({
                'available':      True,
                'dashboard_url':  f'{HEADROOM_DASHBOARD_URL}/dashboard',
                'tokens_saved':   tokens_saved,
                'requests':       lifetime.get('requests', 0),
                'savings_percent': savings_pct,
            }).encode())
        except Exception:
            self.send_json(200, json.dumps({'available': False}).encode())

    def serve_lql_generate(self):
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {objective}')
            return

        objective = (payload.get('objective') or '').strip()
        if not objective:
            self.send_json(400, json.dumps({'error': 'objective is required'}).encode())
            return

        # Cache lookup — normalize to lowercase, collapse whitespace
        cache_key = ' '.join(objective.lower().split())
        if cache_key in _lql_cache:
            cached = dict(_lql_cache[cache_key])
            cached['cached'] = True
            self.send_json(200, json.dumps(cached).encode())
            return

        if not DIRECT_UPSTREAM or not VIRTUAL_KEY:
            self.send_json(503, json.dumps({'error': 'Gateway URL or virtual key not configured'}).encode())
            return

        # Fetch live tenant metadata to ground LQL generation (best-effort — skip on any failure)
        _lw_token_data = None
        _schema_hints  = ''
        if LW_READY:
            try:
                _lw_token_data = self._lw_token()
                _schema_hints  = self._lw_schema_hints(*_lw_token_data)
            except Exception:
                _lw_token_data = None

        system_prompt = """\
You are a FortiCNAPP LQL (Lacework Query Language) expert. Generate a single valid LQL query for the given objective.

━━ CVE ROUTING RULE ━━
If the objective involves CVE vulnerabilities (e.g. "hosts with CVE-xxx", "vulnerable hosts", "container images with vulnerabilities", "patch exposure"), do NOT generate LQL. Respond ONLY with:
{"queryId": "USE_CVE_TAB", "queryText": "", "note": "CVE vulnerability data is not available in LQL. Use the CVE tab in this panel instead — it queries the FortiCNAPP Vulnerabilities API directly and shows hosts ranked by internet exposure and risk score."}

━━ LQL SYNTAX ━━
Structure:       { source { DATASOURCE } filter { conditions } return distinct { columns } }
Multi-source:    { source { DS_A with DS_B } ... }   — left outer join on a PRE-DEFINED connection; Lacework hardcodes which datasources can link
                 { source { DS_A with DS_B on '(default)' } ... }   — explicit connection name (string, not a column expression)
                 ON does NOT accept column = column expressions — it only accepts a quoted connection name like '(default)'
Array expand:    { source { DS d array_to_rows(d.FIELD:arraypath) as elem } ... }

Comparison:      =  !=  <  <=  >  >=  IS NULL  IS NOT NULL  IS JSON NULL
Pattern match:   FIELD LIKE 'a%'  /  FIELD ILIKE 'a%'  /  FIELD RLIKE 'regex'
Multi-pattern:   FIELD LIKE ANY ('a%', '%b')   — also ILIKE ANY, RLIKE ANY
Set:             FIELD IN (v1, v2)  /  FIELD NOT IN (v1, v2)
Range:           FIELD BETWEEN v1 AND v2
Logic:           AND  OR  NOT
CASE:            CASE WHEN cond THEN val ELSE other END
Cast:            FIELD:json.nested.key::String   — types: String, Number only
                 NEVER cast a JSON boolean field with ::String or ::Boolean — both cause parse errors
                 JSON booleans (true/false) stored in RESOURCE_CONFIG are already comparable as strings without any cast
                 BAD: RESOURCE_CONFIG:Encrypted::String = 'false'
                 BAD: RESOURCE_CONFIG:Encrypted::Boolean = false
                 GOOD: RESOURCE_CONFIG:Encrypted = 'false'

CRITICAL RULES — violations cause parse errors:
- NEVER use array wildcard syntax [*] or [0] — LQL does NOT support array indexing in filters
  BAD: RESOURCE_CONFIG:BlockDeviceMappings[*].Ebs.Encrypted::String
  GOOD: query a dedicated per-resource datasource (e.g. LW_CFG_AWS_EC2_VOLUMES) or use array_to_rows()
- WITH join syntax: ON accepts ONLY a quoted connection-name string (e.g. on '(default)'), NEVER a column = column expression
  LQL joins are pre-defined by Lacework — you cannot create arbitrary joins between unrelated datasources
  BAD: DS_A a WITH DS_B b ON b.RESOURCE_ID = a.RESOURCE_ID   (column expression — parse error)
  BAD: DS_A a WITH DS_B b ON b.RESOURCE_CONFIG:X = a.FIELD   (RESOURCE_CONFIG in ON — parse error)
  GOOD: DS_A with DS_B   (default connection, if one exists)
  GOOD: DS_A with DS_B on '(default)'   (explicit default connection name)
  BEST: avoid joins entirely — pick a single datasource that already contains all needed fields
  EXAMPLE: for EC2 + volume encryption, use LW_CFG_AWS_EC2_VOLUMES alone (has RESOURCE_REGION + Encrypted + State)
  EXAMPLE: for S3 public access, use LW_CFG_AWS_S3_GET_PUBLIC_ACCESS_BLOCK alone (has all 4 block settings)
- NEVER use CONTAINS() function — use LIKE '%value%' instead
- NEVER use timespan(), interval(), NOW(), DATEADD(), DATE_SUB(), DATEDIFF(), or any SQL-style date functions — they do NOT exist in LQL
- RLIKE: keyword form only — FIELD RLIKE 'regex'   (never RLIKE(field, 'regex'))
- REGION FILTERS: RLIKE does NOT work on RESOURCE_REGION in LW_CFG_* datasources — use LIKE or = instead
  BAD:  RESOURCE_REGION RLIKE '^ca-'
  GOOD: RESOURCE_REGION LIKE 'ca-%'          (prefix match for all Canada regions)
  GOOD: RESOURCE_REGION = 'ca-central-1'     (exact match)
  For multiple regions use: RESOURCE_REGION IN ('ca-central-1', 'ca-west-1')

TIME COMPARISONS — ONLY sec_to_timestamp(epoch) works:
  sec_to_timestamp(n)  → converts a hardcoded Unix epoch number to a Timestamp for comparison
  ALL other time functions (diff_days, current_timestamp_sec, now, timestamp_subtract, date_sub, ADD_DAYS, to_timestamp, current_timestamp) DO NOT EXIST or cause type errors in LQL — never use them
  The ONLY valid pattern for "older than N days":  FIELD < sec_to_timestamp(<hardcoded_epoch>)
  90 days before 2026-06-23 = epoch 1742860800
  CORRECT:   LAST_USED_TIME IS NULL OR LAST_USED_TIME < sec_to_timestamp(1742860800)
  WRONG:     diff_days(sec_to_timestamp(LAST_USED_TIME::Number), sec_to_timestamp(current_timestamp_sec())) >= 90
  WRONG:     diff_days(LAST_USED_TIME, now()) > 90
- Null: test with IS NULL / IS NOT NULL, never = null
- IS JSON NULL: tests for JSON-level null (distinct from SQL null)
- Keywords are case-insensitive; datasource names and field names are CASE-SENSITIVE
- Reserved identifiers (cannot be aliases): EXPR, JOIN, LIMIT, OUTER, PARAMINFO, PROPERTIES, SELECT, SQL, TYPE, VARIANT, WHERE
- return distinct deduplicates rows (equivalent to SELECT DISTINCT)
- String literals: use single quotes inside LQL query text

━━ COMMON AWS CONFIG FIELDS ━━
All LW_CFG_AWS_* datasources share:
  BATCH_START_TIME, BATCH_END_TIME, QUERY_START_TIME, QUERY_END_TIME
  ARN, API_KEY, SERVICE, ACCOUNT_ID, ACCOUNT_ALIAS
  RESOURCE_TYPE, RESOURCE_ID, RESOURCE_REGION
  RESOURCE_CONFIG  (JSON — use RESOURCE_CONFIG:fieldName::Type to access subfields)
  RESOURCE_TAGS    (JSON — use RESOURCE_TAGS:TagName::String)

Standard compliance return columns:
  ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_TYPE, SERVICE, 'reason' as COMPLIANCE_FAILURE_REASON

━━ AWS CONFIG DATASOURCES ━━
Identity & Access:
  LW_CFG_AWS_IAM_USERS                        — IAM users list
  LW_CFG_AWS_IAM_USERS_GET_CREDENTIAL_REPORT  — credential report; ALL credential fields live under RESOURCE_CONFIG in lowercase:
                                               RESOURCE_CONFIG:mfa_active = 'true'/'false'
                                               RESOURCE_CONFIG:password_enabled = 'true'/'false'/'not_supported'
                                               RESOURCE_CONFIG:password_last_used  (ISO timestamp or 'N/A')
                                               RESOURCE_CONFIG:access_key_1_active = 'true'/'false'
                                               RESOURCE_CONFIG:access_key_1_last_used_date  (ISO or 'N/A')
                                               RESOURCE_CONFIG:access_key_1_last_rotated  (ISO or 'N/A')
                                               RESOURCE_CONFIG:access_key_2_active = 'true'/'false'
                                               RESOURCE_CONFIG:access_key_2_last_used_date  (ISO or 'N/A')
                                               RESOURCE_CONFIG:access_key_2_last_rotated  (ISO or 'N/A')
                                               Top-level (not under RESOURCE_CONFIG): ARN, ACCOUNT_ID, ACCOUNT_ALIAS, RESOURCE_REGION, RESOURCE_TYPE, SERVICE
                                               NEVER use bare MFA_ACTIVE, PASSWORD_ENABLED etc. — they don't exist as top-level columns
  LW_CFG_AWS_IAM_USERS_LIST_ATTACHED_POLICIES — managed policies attached to each user
  LW_CFG_AWS_IAM_USERS_LIST_POLICIES          — inline policies per user
  LW_CFG_AWS_IAM_USERS_LIST_ACCESS_KEYS       — access key metadata per user
  LW_CFG_AWS_IAM_ROLES                        — IAM roles
  LW_CFG_AWS_IAM_ROLES_LIST_ATTACHED_POLICIES — managed policies attached to roles
  LW_CFG_AWS_IAM_POLICIES                     — IAM managed policies
  LW_CFG_AWS_IAM_GROUPS                       — IAM groups
  LW_CFG_AWS_IAM_MFA_DEVICES                  — virtual MFA devices
  LW_CFG_AWS_IAM_ACCOUNT_PASSWORD_POLICY      — account password policy; RESOURCE_CONFIG:MinimumPasswordLength::Number, RequireUppercaseCharacters = 'true'/'false', MaxPasswordAge::Number, etc.
  LW_CFG_AWS_IAM_ACCOUNT_SUMMARY              — account-level IAM summary counts
  LW_CFG_AWS_IAM_GET_ACCESS_KEY_LAST_USED     — per-key last-used date

Compute — EC2:
  LW_CFG_AWS_EC2_INSTANCES                    — EC2 instances; RESOURCE_CONFIG:State.Name::String = 'running'
  LW_CFG_AWS_EC2_SECURITY_GROUPS               — security groups; RESOURCE_CONFIG:IpPermissions and IpPermissionsEgress contain arrays of rules — DO NOT use [*] to query them; use array_to_rows()
                                                For "0.0.0.0/0 open to the internet", array_to_rows() TWICE — once for IpPermissions, once for the nested IpRanges array — then filter on the inner alias's CidrIp. See example below; this is the reliable way to find internet exposure, NOT LW_HE_MACHINES tags (see note below).
  LW_CFG_AWS_EC2_VPCS                         — VPCs
  LW_CFG_AWS_EC2_SUBNETS                      — subnets
  LW_CFG_AWS_EC2_VOLUMES                      — EBS volumes; RESOURCE_CONFIG:Encrypted = 'true'/'false', RESOURCE_CONFIG:State::String, RESOURCE_CONFIG:VolumeType::String
  LW_CFG_AWS_EC2_EBS_ENCRYPTION_BY_DEFAULT    — EBS default encryption per region; RESOURCE_CONFIG:EbsEncryptionByDefault = 'true'/'false'
  LW_CFG_AWS_EC2_NETWORK_ACLS                 — Network ACLs
  LW_CFG_AWS_EC2_VPC_FLOW_LOGS               — VPC flow log configs
  LW_CFG_AWS_EC2_INTERNET_GATEWAYS            — internet gateways
  LW_CFG_AWS_EC2_SNAPSHOTS                    — EBS snapshots; RESOURCE_CONFIG:Encrypted = 'true'/'false'
  LW_CFG_AWS_EC2_IMAGES                       — AMIs
  LW_CFG_AWS_EC2_KEY_PAIRS                    — EC2 key pairs

Containers & Serverless:
  LW_CFG_AWS_EKS_CLUSTERS                     — EKS clusters
  LW_CFG_AWS_EKS_NODEGROUPS                   — EKS node groups
  LW_CFG_AWS_ECS_CLUSTERS                     — ECS clusters
  LW_CFG_AWS_ECS_TASK_DEFINITIONS             — ECS task definitions
  LW_CFG_AWS_ECR_REPOSITORIES                 — ECR repositories
  LW_CFG_AWS_ECR_REPOSITORIES_GET_POLICY      — ECR repository policies
  LW_CFG_AWS_LAMBDA                           — Lambda functions (lambda list-functions)
  LW_CFG_AWS_LAMBDA_GET_POLICY                — Lambda resource-based policies

Storage:
  LW_CFG_AWS_S3                               — S3 buckets
  LW_CFG_AWS_S3_GET_BUCKET_ACL               — S3 bucket ACLs
  LW_CFG_AWS_S3_GET_BUCKET_ENCRYPTION        — S3 encryption; RESOURCE_CONFIG:ServerSideEncryptionConfiguration::String
  LW_CFG_AWS_S3_GET_BUCKET_LOGGING           — S3 server access logging config
  LW_CFG_AWS_S3_GET_BUCKET_POLICY            — S3 bucket policies
  LW_CFG_AWS_S3_GET_BUCKET_VERSIONING        — S3 versioning; RESOURCE_CONFIG:Status::String ('Enabled' or 'Suspended')
  LW_CFG_AWS_S3_GET_BUCKET_POLICY_STATUS     — S3 public policy status; RESOURCE_CONFIG:PolicyStatus.IsPublic = 'true' (boolean, no ::String cast)
  LW_CFG_AWS_S3_GET_PUBLIC_ACCESS_BLOCK      — per-bucket public access block settings
  LW_CFG_AWS_S3CONTROL_GET_PUBLIC_ACCESS_BLOCK — account-level S3 public access block
  CRITICAL for S3 public access block: all fields are nested under PublicAccessBlockConfiguration — RESOURCE_CONFIG:PublicAccessBlockConfiguration.BlockPublicAcls = 'true'/'false', RESOURCE_CONFIG:PublicAccessBlockConfiguration.BlockPublicPolicy = 'true'/'false', RESOURCE_CONFIG:PublicAccessBlockConfiguration.IgnorePublicAcls = 'true'/'false', RESOURCE_CONFIG:PublicAccessBlockConfiguration.RestrictPublicBuckets = 'true'/'false' — NO ::String cast needed
  CRITICAL for S3 policy status: IsPublic is nested under PolicyStatus — RESOURCE_CONFIG:PolicyStatus.IsPublic = 'true' NOT RESOURCE_CONFIG:IsPublic
  NOTE for S3 public access: join LW_CFG_AWS_S3 with LW_CFG_AWS_S3_GET_PUBLIC_ACCESS_BLOCK — this 2-source join works. Do NOT add a third source (e.g. LW_CFG_AWS_S3_GET_BUCKET_ENCRYPTION) — 3-source S3 joins fail with "Cannot find defined relationships". For sensitive data proxy: use the 2-source public access join alone and mention encryption separately in the report.
  NOTE for S3 sensitive data — TWO-PRONGED APPROACH (LQL + API):
    LQL covers structural exposure: use LW_CFG_AWS_S3 joined with LW_CFG_AWS_S3_GET_PUBLIC_ACCESS_BLOCK to find buckets with weakened public access controls. Return ARN as RESOURCE_KEY.
    API enrichment (automatic): once the LQL runs, the backend automatically calls /api/v2/Inventory/search with resourceConfig and cloudDetails to retrieve bucket tags. Tags like DataClassification=PII, Sensitivity=High, data-classification=confidential appear in the api_enrichment.s3_sensitive_data field returned alongside the LQL results. Claude should correlate the two: "bucket X is publicly exposed (LQL) AND tagged as PII (Inventory API)".
    No native DSPM/data-classification LQL datasource exists — tags are the only classification signal available via the API.
  LW_CFG_AWS_RDS_DB_INSTANCES                 — RDS instances; RESOURCE_CONFIG:StorageEncrypted = 'true'/'false', MultiAZ = 'true'/'false', PubliclyAccessible = 'true'/'false'
  LW_CFG_AWS_RDS_CLUSTERS                     — RDS Aurora clusters
  LW_CFG_AWS_RDS_DB_SNAPSHOTS                 — RDS snapshots
  LW_CFG_AWS_DYNAMODB_TABLES                  — DynamoDB tables

Encryption & Secrets:
  LW_CFG_AWS_KMS_KEYS                         — KMS key list
  LW_CFG_AWS_KMS_KEYS_DESCRIBE_KEY            — KMS key details; fields nested under KeyMetadata: RESOURCE_CONFIG:KeyMetadata.Enabled = 'true'/'false', RESOURCE_CONFIG:KeyMetadata.KeyManager = 'CUSTOMER'/'AWS', RESOURCE_CONFIG:KeyMetadata.KeySpec = 'SYMMETRIC_DEFAULT', RESOURCE_CONFIG:KeyMetadata.KeyUsage
  LW_CFG_AWS_KMS_KEYS_GET_ROTATION_STATUS     — KMS rotation; RESOURCE_CONFIG:KeyRotationEnabled = 'true'/'false'
  LW_CFG_AWS_KMS_ALIASES                      — KMS aliases
  LW_CFG_AWS_SECRETSMANAGER_SECRETS           — Secrets Manager; ALL fields are under RESOURCE_CONFIG — RESOURCE_CONFIG:Name::String, RESOURCE_CONFIG:RotationEnabled::String ('true'/'false'), RESOURCE_CONFIG:LastRotatedDate::String, RESOURCE_CONFIG:Description::String; NAME/ROTATION_ENABLED/LAST_ROTATED_DATE do NOT exist as top-level columns
  LW_CFG_AWS_SSM_PARAMETERS                   — SSM Parameter Store; ALL fields are under RESOURCE_CONFIG — RESOURCE_CONFIG:Name::String, RESOURCE_CONFIG:Description::String, RESOURCE_CONFIG:Value::String; NOTE: RESOURCE_CONFIG:Type is INVALID because TYPE is a reserved LQL keyword — do NOT filter by parameter type; NAME/TYPE/DESCRIPTION do NOT exist as top-level columns

Security & Audit:
  LW_CFG_AWS_CLOUDTRAIL                       — CloudTrail trails; RESOURCE_CONFIG:IsMultiRegionTrail = 'true'/'false', LogFileValidationEnabled = 'true'/'false'
  LW_CFG_AWS_CLOUDTRAIL_GET_EVENT_SELECTORS   — CloudTrail event selector config
  LW_CFG_AWS_CLOUDWATCH                       — CloudWatch alarms
  LW_CFG_AWS_GUARDDUTY_FINDINGS               — GuardDuty findings
  LW_CFG_AWS_GUARDDUTY_DETECTORS              — GuardDuty detectors
  LW_CFG_AWS_INSPECTOR2_COVERAGE              — Inspector2 resource coverage
  LW_CFG_AWS_CONFIG_CONFIGURATION_RECORDERS   — AWS Config recorder config
  LW_CFG_AWS_CONFIG_CONFIGURATION_RECORDERS_STATUS — recorder status

Networking & Org:
  LW_CFG_AWS_ELBV2                            — ALB/NLB load balancers
  LW_CFG_AWS_ELB                              — Classic load balancers
  LW_CFG_AWS_CLOUDFRONT                       — CloudFront distributions
  LW_CFG_AWS_ROUTE53_HOSTED_ZONES            — Route 53 hosted zones
  LW_CFG_AWS_ORGANIZATIONS_ACCOUNTS          — AWS Organizations accounts

━━ WORKLOAD / AGENT DATASOURCES ━━
No ARN/SERVICE/RESOURCE_TYPE — use MID to join to LW_HE_MACHINES for hostname/tags.
Standard return: MID, HOSTNAME (via join or TAGS:Hostname::String), plus relevant fields.

  LW_HE_MACHINES      — host inventory: MID, HOSTNAME, TAGS(JSON), OS, OS_VERSION, KERNEL_RELEASE
                        TAGS:Account::String, TAGS:Zone::String, TAGS:Hostname::String
                        CAUTION: there is NO "Region" tag — verified empty against real tenant data. AWS hosts only
                        carry TAGS:Zone::String, the availability zone (e.g. "ca-central-1a"), not a bare region.
                        For "hosts in region/country X", filter TAGS:Zone::String LIKE '<region-prefix>-%'
                        (e.g. 'ca-%' for Canada, 'eu-%' for Europe) — do NOT filter on TAGS:Region, it will silently
                        match zero rows every time.
                        TAGS:ExternalIp::String — public IP if assigned. CAUTION: hosts with no public IP have this
                        tag present but set to an EMPTY STRING, not absent/null — "IS NOT NULL" alone always passes.
                        Always filter BOTH: TAGS:ExternalIp IS NOT NULL AND TAGS:ExternalIp != ''.
                        CAUTION: TAGS:lw_InternetExposure is often unpopulated (empty on every host in many tenants) —
                        it is NOT a reliable signal. Do NOT use it as the sole filter for "internet exposed" objectives.
                        For TRUE internet exposure (reachable, not just has-a-public-IP), use the security-group
                        0.0.0.0/0 check on LW_CFG_AWS_EC2_SECURITY_GROUPS instead (see example below) — it reflects
                        actual reachability, not an optional agent-computed tag.

  LW_HE_PROCESSES     — running process snapshot: MID, PID, PPID, USERNAME, EXE_PATH, CMDLINE, CWD
  LW_HE_ALL_PROCESSES — all processes incl. short-lived: MID, PID, PPID, EXE_PATH, CMDLINE, IS_IN_CONTAINER, CONTAINER_ID
  LW_HE_CONTAINERS    — running containers: MID, CONTAINER_ID, CONTAINER_NAME, CONTAINER_TYPE, IMAGE_ID, REPO, TAG, PRIVILEGED, NETWORK_MODE, LISTEN_PORT_MAP
  LW_HE_IMAGES        — container images: MID, IMAGE_ID, REPO, TAG, SIZE, ACTIVE_COUNT
  LW_HE_PACKAGES      — installed packages: MID, PACKAGE_NAME, PACKAGE_VERSION, NAMESPACE, IS_IN_CONTAINER, CONTAINER_KEY
  LW_HE_FILES         — filesystem: MID, PATH, FILE_NAME, FILE_PERMISSIONS, OWNER_USERNAME, FILEDATA_HASH, SIZE
  LW_HE_USERS         — OS user accounts: MID, USERNAME, PRIMARY_GROUP_NAME, OTHER_GROUP_NAMES, HOME_DIR
  LW_HE_SECRETS_ALL   — secrets found on disk: MID, HOSTNAME, FILE_PATH, SECRET_TYPE, SECRET_METADATA

  LW_HA_SYSCALLS_EXEC — process execution events: MID, EXE_PATH, CMDLINE, PID, PPID, UID, GID, COUNT, OS
  LW_HA_SYSCALLS_FILE — file access events: MID, TARGET_PATH, TARGET_OP, WATCH_PATH, PID, EXE_PATH, UID, GID, COUNT
  LW_HA_SSH_LOGINS    — SSH login events: MID, USERNAME, IP_ADDR, HOSTNAME, LOGIN_TIME, SSH_KEY_TYPE
  LW_HA_USER_LOGINS   — OS login/logoff: MID, USERNAME, IP_ADDR, HOSTNAME, LOGIN_TIME, LOGOFF_TIME, EVENT_TYPE, TTY, UID, GID
  LW_HA_FILE_CHANGES  — file change audit: MID, PATH, ACTIVITY, FILEDATA_HASH, LAST_MODIFIED_TIME, SIZE
  LW_HA_DNS_REQUESTS  — DNS queries: MID, HOSTNAME, HOST_IP_ADDR, SRV_IP_ADDR, TTL
  LW_HA_CONNECTION_SUMMARY — network connections: MID, SRC_ENTITY_TYPE, SRC_ENTITY_ID, DST_ENTITY_TYPE, DST_ENTITY_ID, SRC_OUT_BYTES, DST_IN_BYTES, NUM_CONNS

  CloudTrailRawEvents — raw CloudTrail audit events: top-level scalars: EVENT_NAME, EVENT_SOURCE, EVENT_TIME, INSERT_ID, INSERT_TIME, ERROR_CODE; JSON blob: EVENT (access subfields as EVENT:requestParameters.xxx, EVENT:responseElements.xxx, EVENT:userIdentity.type, etc.)

━━ CLOUD ENTITLEMENT & ATTACK PATH ━━
  LW_APA_ATTACK_PATHS   — attack paths: PATH_ID, PROVIDER_TYPE, DOMAIN_ID, METRICS(JSON), PATH(JSON), TARGETS(JSON)
  LW_APA_EXPOSURE_PATHS — exposure paths: PATH_ID, PATH_TYPE, TARGET_ID, TARGET_TYPE, TARGET_TAGS
  LW_CE_ENTITLEMENTS    — effective IAM permissions: PRINCIPAL_ID, SERVICE, RESOURCE_TYPE, RESOURCE_ID, POLICY_ID, ACTION, LAST_USED_TIME
  LW_CE_IDENTITIES      — cloud identities: PRINCIPAL_ID, NAME, PROVIDER_TYPE, LAST_USED_TIME, CREATED_TIME, METRICS(JSON)

━━ EXAMPLES ━━

EC2 instances with unencrypted EBS volumes — use LW_CFG_AWS_EC2_VOLUMES (not EC2_INSTANCES with array indexing):
{"queryId":"Custom_AWS_EC2_UnencryptedVolumes","queryText":"{ source { LW_CFG_AWS_EC2_VOLUMES } filter { RESOURCE_CONFIG:Encrypted = 'false' AND RESOURCE_CONFIG:State = 'in-use' } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_TYPE, SERVICE, 'EBS volume is not encrypted' as COMPLIANCE_FAILURE_REASON } }"}

Regions without EBS encryption-by-default:
{"queryId":"Custom_AWS_EC2_NoEBSDefaultEncryption","queryText":"{ source { LW_CFG_AWS_EC2_EBS_ENCRYPTION_BY_DEFAULT } filter { RESOURCE_CONFIG:EbsEncryptionByDefault = 'false' } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, RESOURCE_REGION, 'EBS encryption by default is disabled' as COMPLIANCE_FAILURE_REASON } }"}

IAM users with password login but no MFA:
{"queryId":"Custom_AWS_IAM_UsersNoMFA","queryText":"{ source { LW_CFG_AWS_IAM_USERS_GET_CREDENTIAL_REPORT u } filter { u.RESOURCE_CONFIG:mfa_active = 'false' AND u.RESOURCE_CONFIG:password_enabled = 'true' } return distinct { u.ACCOUNT_ALIAS, u.ACCOUNT_ID, u.ARN as RESOURCE_KEY, u.RESOURCE_REGION, u.RESOURCE_CONFIG:user::String as USERNAME, u.RESOURCE_CONFIG:password_last_used::String as PASSWORD_LAST_USED, 'Password login without MFA' as COMPLIANCE_FAILURE_REASON } }"}

KMS customer-managed keys without rotation (join describe_key to filter to CUSTOMER keys only):
{"queryId":"Custom_AWS_KMS_CustomerKeyRotationDisabled","queryText":"{ source { LW_CFG_AWS_KMS_KEYS keys with( LW_CFG_AWS_KMS_KEYS_DESCRIBE_KEY key, LW_CFG_AWS_KMS_KEYS_GET_ROTATION_STATUS rotation ) } filter { key.RESOURCE_CONFIG:KeyMetadata.Enabled = 'true' and key.RESOURCE_CONFIG:KeyMetadata.KeyManager = 'CUSTOMER' and key.RESOURCE_CONFIG:KeyMetadata.KeySpec = 'SYMMETRIC_DEFAULT' and rotation.RESOURCE_CONFIG:KeyRotationEnabled = 'false' } return distinct { key.ACCOUNT_ALIAS, key.ACCOUNT_ID, key.ARN as RESOURCE_KEY, key.RESOURCE_REGION, key.RESOURCE_TYPE, key.SERVICE, 'KMS customer key rotation not enabled' as COMPLIANCE_FAILURE_REASON } }"}

Security groups open to the internet (0.0.0.0/0 ingress) — TRUE exposure via actual reachability, not an agent tag.
Requires array_to_rows() TWICE: once for IpPermissions, once for the nested IpRanges array:
{"queryId":"Custom_AWS_EC2_SecurityGroupOpenToInternet","queryText":"{ source { LW_CFG_AWS_EC2_SECURITY_GROUPS a, array_to_rows(a.RESOURCE_CONFIG:IpPermissions) as (ip_permissions), array_to_rows(ip_permissions:IpRanges) as (ip_range) } filter { ip_range:CidrIp = '0.0.0.0/0' } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_CONFIG:GroupName::String as GROUP_NAME, ip_permissions:FromPort::String as FROM_PORT, ip_permissions:ToPort::String as TO_PORT } }"}

Hosts with a public IP assigned (has-a-public-IP signal, not full reachability analysis):
{"queryId":"Custom_AWS_Hosts_WithPublicIP","queryText":"{ source { LW_HE_MACHINES } filter { TAGS:ExternalIp IS NOT NULL AND TAGS:ExternalIp != '' } return distinct { MID, TAGS:Hostname::String as HOSTNAME, TAGS:ExternalIp::String as EXTERNAL_IP, TAGS:Account::String as ACCOUNT, TAGS:Zone::String as ZONE } }"}

EC2 hosts in a specific region/country with a public IP (e.g. "EC2 in Canada with internet exposure") — filter on
Zone, not the nonexistent Region tag, and check both null AND empty-string on ExternalIp:
{"queryId":"Custom_AWS_Hosts_WithPublicIP_ByRegion","queryText":"{ source { LW_HE_MACHINES } filter { TAGS:Zone::String LIKE 'ca-%' AND TAGS:ExternalIp IS NOT NULL AND TAGS:ExternalIp != '' } return distinct { MID, TAGS:Hostname::String as HOSTNAME, TAGS:ExternalIp::String as EXTERNAL_IP, TAGS:Account::String as ACCOUNT, TAGS:Zone::String as ZONE } }"}

SSH logins from external IPs on internet-exposed hosts (multi-source join):
{"queryId":"Custom_AWS_Hosts_ExternalSSHLogins","queryText":"{ source { LW_HA_SSH_LOGINS s WITH LW_HE_MACHINES m } filter { m.TAGS:ExternalIp IS NOT NULL AND m.TAGS:ExternalIp != '' AND s.IP_ADDR NOT LIKE '10.%' AND s.IP_ADDR NOT LIKE '192.168.%' } return distinct { s.MID, m.TAGS:Hostname::String as HOSTNAME, s.USERNAME, s.IP_ADDR, s.LOGIN_TIME, m.TAGS:Account::String as ACCOUNT } }"}

List all Secrets Manager secrets:
{"queryId":"Custom_AWS_SecretsManager_AllSecrets","queryText":"{ source { LW_CFG_AWS_SECRETSMANAGER_SECRETS } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_CONFIG:Name::String as SECRET_NAME, RESOURCE_CONFIG:RotationEnabled::String as ROTATION_ENABLED, RESOURCE_CONFIG:LastRotatedDate::String as LAST_ROTATED_DATE } }"}

Secrets Manager secrets without rotation:
{"queryId":"Custom_AWS_SecretsManager_NoRotation","queryText":"{ source { LW_CFG_AWS_SECRETSMANAGER_SECRETS } filter { RESOURCE_CONFIG:RotationEnabled = 'false' } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_CONFIG:Name::String as SECRET_NAME, RESOURCE_CONFIG:LastRotatedDate::String as LAST_ROTATED_DATE, 'Secret rotation not enabled' as COMPLIANCE_FAILURE_REASON } }"}

SSM parameters (potential unmanaged secrets) — TYPE is a reserved keyword, do NOT filter by it:
{"queryId":"Custom_AWS_SSM_AllParameters","queryText":"{ source { LW_CFG_AWS_SSM_PARAMETERS } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_CONFIG:Name::String as PARAM_NAME, RESOURCE_CONFIG:Description::String as DESCRIPTION } }"}

Entitlements unused for 90+ days (epoch 1742860800 = 90 days before 2026-06-23):
{"queryId":"Custom_AWS_IAM_UnusedPermissions90Days","queryText":"{ source { LW_CE_ENTITLEMENTS } filter { LAST_USED_TIME IS NULL OR LAST_USED_TIME < sec_to_timestamp(1742860800) } return distinct { PRINCIPAL_ID, SERVICE, ACTION, RESOURCE_TYPE, RESOURCE_ID, POLICY_ID, LAST_USED_TIME } }"}

CloudTrail log file validation not enabled:
{"queryId":"Custom_AWS_CloudTrail_NoLogValidation","queryText":"{ source { LW_CFG_AWS_CLOUDTRAIL } filter { RESOURCE_CONFIG:LogFileValidationEnabled = 'false' } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_TYPE, SERVICE, 'CloudTrail log file validation not enabled' as COMPLIANCE_FAILURE_REASON } }"}

CloudTrail not encrypted with KMS:
{"queryId":"Custom_AWS_CloudTrail_NotEncrypted","queryText":"{ source { LW_CFG_AWS_CLOUDTRAIL } filter { not value_exists(RESOURCE_CONFIG:KmsKeyId) } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_TYPE, SERVICE, 'CloudTrail not encrypted with KMS' as COMPLIANCE_FAILURE_REASON } }"}

S3 buckets without server-side encryption (join to encryption datasource):
{"queryId":"Custom_AWS_S3_NoEncryption","queryText":"{ source { LW_CFG_AWS_S3 bucket with LW_CFG_AWS_S3_GET_BUCKET_ENCRYPTION encryption } filter { not value_exists(encryption.RESOURCE_CONFIG) } return distinct { bucket.ACCOUNT_ALIAS, bucket.ACCOUNT_ID, bucket.ARN as RESOURCE_KEY, bucket.RESOURCE_REGION, bucket.RESOURCE_TYPE, bucket.SERVICE, 'S3 bucket server-side encryption not enabled' as COMPLIANCE_FAILURE_REASON } }"}

S3 buckets with public access — join base table with public access block config (fields nested under PublicAccessBlockConfiguration):
{"queryId":"Custom_AWS_S3_PublicAccessBlockWeakened","queryText":"{ source { LW_CFG_AWS_S3 b with LW_CFG_AWS_S3_GET_PUBLIC_ACCESS_BLOCK p } filter { p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.BlockPublicAcls = 'false' OR p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.BlockPublicPolicy = 'false' OR p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.IgnorePublicAcls = 'false' OR p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.RestrictPublicBuckets = 'false' } return distinct { b.ACCOUNT_ALIAS, b.ACCOUNT_ID, b.ARN as RESOURCE_KEY, b.RESOURCE_REGION, b.RESOURCE_TYPE, b.SERVICE, p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.BlockPublicAcls::String as BLOCK_PUBLIC_ACLS, p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.BlockPublicPolicy::String as BLOCK_PUBLIC_POLICY, p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.IgnorePublicAcls::String as IGNORE_PUBLIC_ACLS, p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.RestrictPublicBuckets::String as RESTRICT_PUBLIC_BUCKETS, 'S3 bucket public access controls weakened' as COMPLIANCE_FAILURE_REASON } }"}

S3 buckets with potential sensitive data exposure — public access block weakened (2-source join only; 3-source S3 joins fail):
{"queryId":"Custom_AWS_S3_Public_SensitiveData","queryText":"{ source { LW_CFG_AWS_S3 b with LW_CFG_AWS_S3_GET_PUBLIC_ACCESS_BLOCK p } filter { p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.BlockPublicAcls = 'false' OR p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.BlockPublicPolicy = 'false' OR p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.IgnorePublicAcls = 'false' OR p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.RestrictPublicBuckets = 'false' } return distinct { b.ACCOUNT_ALIAS, b.ACCOUNT_ID, b.ARN as RESOURCE_KEY, b.RESOURCE_REGION, b.RESOURCE_TYPE, b.SERVICE, p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.BlockPublicAcls::String as BLOCK_PUBLIC_ACLS, p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.BlockPublicPolicy::String as BLOCK_PUBLIC_POLICY, p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.IgnorePublicAcls::String as IGNORE_PUBLIC_ACLS, p.RESOURCE_CONFIG:PublicAccessBlockConfiguration.RestrictPublicBuckets::String as RESTRICT_PUBLIC_BUCKETS, 'S3 bucket public access controls weakened — potential sensitive data exposure' as COMPLIANCE_FAILURE_REASON } }"}

VPCs without flow logging enabled (join to flow logs):
{"queryId":"Custom_AWS_VPC_NoFlowLogs","queryText":"{ source { LW_CFG_AWS_EC2_VPCS vpc with LW_CFG_AWS_EC2_VPC_FLOW_LOGS log } filter { not value_exists(log.RESOURCE_CONFIG) or log.RESOURCE_CONFIG:FlowLogStatus <> 'ACTIVE' } return distinct { vpc.ACCOUNT_ALIAS, vpc.ACCOUNT_ID, vpc.ARN as RESOURCE_KEY, vpc.RESOURCE_REGION, vpc.RESOURCE_TYPE, vpc.SERVICE, case when not value_exists(log.RESOURCE_CONFIG) then 'VPC flow logging not enabled' else 'VPC flow logging not active' end as COMPLIANCE_FAILURE_REASON } }"}

IAM users with two active access keys:
{"queryId":"Custom_AWS_IAM_TwoActiveAccessKeys","queryText":"{ source { LW_CFG_AWS_IAM_USERS_GET_CREDENTIAL_REPORT } filter { RESOURCE_CONFIG:access_key_1_active = 'true' and RESOURCE_CONFIG:access_key_2_active = 'true' } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_TYPE, SERVICE, 'IAM user has two active access keys' as COMPLIANCE_FAILURE_REASON } }"}

IAM users with inline policies (join users to inline policies):
{"queryId":"Custom_AWS_IAM_InlinePolicy","queryText":"{ source { LW_CFG_AWS_IAM_USERS user with LW_CFG_AWS_IAM_USERS_LIST_POLICIES inline } filter { value_exists(inline.RESOURCE_CONFIG) } return distinct { user.ACCOUNT_ALIAS, user.ACCOUNT_ID, user.ARN as RESOURCE_KEY, user.RESOURCE_REGION, user.RESOURCE_TYPE, user.SERVICE, 'IAM user has inline policy' as COMPLIANCE_FAILURE_REASON } }"}

Default security groups allowing traffic (array_to_rows for permission arrays):
{"queryId":"Custom_AWS_EC2_DefaultSGAllowsTraffic","queryText":"{ source { LW_CFG_AWS_EC2_SECURITY_GROUPS a, array_to_rows(a.RESOURCE_CONFIG:IpPermissions) as (ip_permissions), array_to_rows(a.RESOURCE_CONFIG:IpPermissionsEgress) as (ip_permissions_egress) } filter { RESOURCE_CONFIG:GroupName = 'default' and (ip_permissions <> '[]' or ip_permissions_egress <> '[]') } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_TYPE, SERVICE, 'Default security group allows traffic' as COMPLIANCE_FAILURE_REASON } }"}

IAM entitlements unused for 90+ days (sec_to_timestamp with hardcoded epoch — 90 days before 2026-06-23):
{"queryId":"Custom_AWS_IAM_UnusedPermissions90Days","queryText":"{ source { LW_CE_ENTITLEMENTS } filter { LAST_USED_TIME IS NULL OR LAST_USED_TIME < sec_to_timestamp(1742860800) } return distinct { PRINCIPAL_ID, SERVICE, ACTION, RESOURCE_TYPE, RESOURCE_ID, POLICY_ID, LAST_USED_TIME } }"}

Access key 1 not rotated in 90 days (sec_to_timestamp with hardcoded epoch):
{"queryId":"Custom_AWS_IAM_AccessKey1NotRotated90Days","queryText":"{ source { LW_CFG_AWS_IAM_USERS_GET_CREDENTIAL_REPORT } filter { RESOURCE_CONFIG:access_key_1_active = 'true' AND RESOURCE_CONFIG:access_key_1_last_rotated < sec_to_timestamp(1742860800) } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_TYPE, SERVICE, RESOURCE_CONFIG:access_key_1_last_rotated::String as LAST_ROTATED, 'Access key 1 not rotated in 90 days' as COMPLIANCE_FAILURE_REASON } }"}

━━ REST API FALLBACK (searchTerm) ━━
LQL only covers resource types Lacework has modeled as datasources (see lists above). Many objectives
name a specific piece of software, application, or service (e.g. "MCP servers", "nginx", "Jenkins",
a custom app name) that has NO dedicated LQL datasource — it can only be found by pattern-matching
resource names/configs, which the FortiCNAPP REST API's Inventory search supports but LQL does not.
When the objective names software/technology like this, ALSO include a "searchTerm" field: a short
lowercase keyword (e.g. "mcp") that the backend will use to search resourceConfig across ALL AWS
resources (Lambda function names, ECS task defs/images, EC2 tags/names, EKS, etc.) via the REST
Inventory API — this broadens coverage beyond whatever single LQL datasource you pick.
Omit "searchTerm" entirely when the objective is about a native modeled resource type (S3, IAM, EC2
config, etc.) where LQL alone already gives complete coverage.

━━ OUTPUT FORMAT ━━
Respond with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"queryId": "Custom_<Cloud>_<Service>_<PascalCaseDescription>", "queryText": "{ source { ... } filter { ... } return distinct { ... } }", "searchTerm": "<optional short keyword — omit if not applicable>"}"""

        if _schema_hints:
            system_prompt += f'\n\n━━ LIVE TENANT CONTEXT ━━\n{_schema_hints}'

        _reference_excerpts = _retrieve_lql_reference(objective)
        if _reference_excerpts:
            system_prompt += (
                '\n\n━━ LQL REFERENCE DOC EXCERPTS (authoritative — prefer these exact field names '
                f'over any conflicting guidance above) ━━\n{_reference_excerpts}'
            )

        # Embed system as first user message — works for Anthropic and OpenAI-compatible gateways
        messages = [
            {'role': 'user', 'content': f'<system>\n{system_prompt}\n</system>\n\nObjective: {objective}'},
        ]
        def _call_claude(msgs):
            body = json.dumps({'model': MODEL or 'claude-haiku-4-5', 'max_tokens': 2048, 'messages': msgs}).encode()
            r = urllib.request.Request(
                current_upstream().rstrip('/') + '/v1/messages', data=body, method='POST',
                headers={'Content-Type': 'application/json', 'x-api-key': VIRTUAL_KEY, 'anthropic-version': '2023-06-01'})
            resp = urllib.request.urlopen(r, timeout=60)
            resp_data = json.loads(resp.read())
            if 'content' in resp_data and resp_data['content']:
                raw = resp_data['content'][0].get('text', '')
            elif 'choices' in resp_data and resp_data['choices']:
                raw = resp_data['choices'][0].get('message', {}).get('content', '')
            else:
                raise ValueError(f'Unrecognised response shape: {list(resp_data.keys())}')
            raw = raw.strip()
            if raw.startswith('```'):
                raw = '\n'.join(raw.split('\n')[1:])
                if raw.endswith('```'):
                    raw = raw[:-3].strip()
            brace = raw.find('{')
            if brace > 0:
                raw = raw[brace:]
            # Parse only the first JSON object — models sometimes append trailing
            # commentary or a duplicate object after the closing brace, which
            # would otherwise raise "Extra data" from a strict json.loads().
            obj, _ = json.JSONDecoder().raw_decode(raw)
            return obj

        def _validate_lql(query_text):
            """Validate query syntax only. Returns error string or None if valid."""
            if not shutil.which('lacework'):
                return None  # no CLI — skip validation
            tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.lql', delete=False)
            tmp.write(json.dumps({'queryId': 'Validate', 'queryText': query_text}))
            tmp.close()
            try:
                cmd = ['lacework', '--json', 'query', 'run', '-f', tmp.name, '--validate_only']
                if LW_PROFILE:
                    cmd += ['--profile', LW_PROFILE]
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                if r.returncode == 0:
                    return None
                err = (r.stderr or r.stdout or '').strip()
                for line in err.splitlines():
                    if 'Error:' in line or 'Unable to' in line or 'error' in line.lower():
                        return line.strip()
                return err[-300:] if err else 'validation failed'
            except subprocess.TimeoutExpired:
                return 'validation timed out'
            except Exception as e:
                return str(e)
            finally:
                os.unlink(tmp.name)

        def _run_lql(query_text):
            """Run query for real. Returns (rows, error_string). rows=None on error."""
            if not shutil.which('lacework'):
                return None, None  # no CLI — let extension call /lql/run
            now   = datetime.now(timezone.utc)
            start = (now - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
            end   = now.strftime('%Y-%m-%dT%H:%M:%SZ')
            tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.lql', delete=False)
            tmp.write(json.dumps({'queryId': 'Generate', 'queryText': query_text}))
            tmp.close()
            try:
                cmd = ['lacework', '--json', 'query', 'run', '-f', tmp.name,
                       '--start', start, '--end', end]
                if LW_PROFILE:
                    cmd += ['--profile', LW_PROFILE]
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                if r.returncode == 0 and r.stdout.strip():
                    raw  = json.loads(r.stdout)
                    rows = raw.get('data', raw) if isinstance(raw, dict) else raw
                    return (rows if isinstance(rows, list) else []), None
                err = (r.stderr or r.stdout or '').strip()
                for line in err.splitlines():
                    if 'Error:' in line or 'Unable to' in line or 'error' in line.lower():
                        return None, line.strip()
                return None, err[-300:] if err else 'query failed'
            except subprocess.TimeoutExpired:
                return None, 'query timed out'
            except Exception as e:
                return None, str(e)
            finally:
                os.unlink(tmp.name)

        def _call_claude_retryable(msgs):
            """Call Claude and parse its JSON reply. Never raises — returns
            (result, None) on success or (None, error_str) if the reply wasn't
            parseable JSON, so a malformed model reply is a retryable condition
            instead of an unhandled exception that aborts the whole request."""
            try:
                return _call_claude(msgs), None
            except (json.JSONDecodeError, ValueError) as e:
                return None, f'Model reply was not valid JSON: {e}'

        try:
            messages = [{'role': 'user', 'content': f'<system>\n{system_prompt}\n</system>\n\nObjective: {objective}'}]
            result, last_err = _call_claude_retryable(messages)

            # validate-then-fix loop — validate syntax first (fast), then run for real.
            # Each iteration: if an error occurs and retries remain, feed the error back to
            # Claude and loop again with the corrected query. On the final attempt any
            # remaining error is stored in last_err and surfaced to the caller.
            MAX_RETRIES = 20
            cached_rows = None
            print(f'  [LQL] objective: {objective!r}')
            for attempt in range(MAX_RETRIES):
                if result is None:
                    print(f'  [LQL] attempt {attempt+1}/{MAX_RETRIES} — ✗ parse error: {last_err}')
                    if attempt < MAX_RETRIES - 1:
                        messages.append({'role': 'user', 'content': (
                            f'Your last reply could not be parsed as JSON:\n{last_err}\n\n'
                            'Respond with ONLY the JSON object — no markdown, no commentary before or after it.'
                        )})
                        print(f'  [LQL]   → asking Claude to retry (attempt {attempt+2})')
                        result, last_err = _call_claude_retryable(messages)
                    continue

                query_text = result.get('queryText', '')
                if not query_text or result.get('queryId') == 'USE_CVE_TAB':
                    break

                print(f'  [LQL] attempt {attempt+1}/{MAX_RETRIES} — query: {query_text[:120].replace(chr(10)," ")}…')

                # Step 1: validate syntax before executing (fast, no API call)
                val_err = _validate_lql(query_text)
                if val_err:
                    last_err = val_err
                    print(f'  [LQL]   ✗ validation error: {val_err}')
                    if attempt < MAX_RETRIES - 1:
                        hint = ''
                        if 'Cannot find defined relationships' in val_err:
                            hint = ('\nHINT: This datasource combination has no pre-defined relationship. '
                                    'Use only 2 sources max for S3 queries. Never join more than 2 LW_CFG_AWS_S3_* datasources together.')
                        messages.append({'role': 'assistant', 'content': json.dumps(result)})
                        messages.append({'role': 'user', 'content': (
                            f'That LQL query failed validation with this error:\n{val_err}{hint}\n\n'
                            'Fix the LQL and return only the corrected JSON object.'
                        )})
                        print(f'  [LQL]   → asking Claude to fix (attempt {attempt+2})')
                        result, last_err = _call_claude_retryable(messages)
                    continue  # re-enter loop with corrected result (or exit on final attempt)

                print(f'  [LQL]   ✓ validation passed — running…')

                # Step 2: run for real only after validation passes
                rows, err = _run_lql(query_text)
                if err is None:
                    # rows=None means no CLI — let the extension call /lql/run itself
                    cached_rows = rows
                    last_err    = None
                    count = len(rows) if rows is not None else '(no CLI)'
                    print(f'  [LQL]   ✓ run OK — {count} rows')
                    break
                last_err = err
                print(f'  [LQL]   ✗ run error: {err}')
                if attempt < MAX_RETRIES - 1:
                    hint = ''
                    if 'Cannot find defined relationships' in err:
                        hint = ('\nHINT: This datasource combination does not have a pre-defined relationship in Lacework. '
                                'Use fewer sources (max 2 for S3 joins), or rewrite using a single datasource. '
                                'Do NOT join LW_CFG_AWS_S3_GET_PUBLIC_ACCESS_BLOCK with LW_CFG_AWS_S3_GET_BUCKET_ENCRYPTION — use only one of them joined with LW_CFG_AWS_S3.')
                    elif 'invalid query' in err.lower() or 'json' in err.lower():
                        hint = '\nHINT: The query file must be valid LQL syntax inside { source { ... } filter { ... } return distinct { ... } }'
                    messages.append({'role': 'assistant', 'content': json.dumps(result)})
                    messages.append({'role': 'user', 'content': (
                        f'That LQL query failed with this error:\n{err}{hint}\n\n'
                        'Fix the LQL and return only the corrected JSON object.'
                    )})
                    print(f'  [LQL]   → asking Claude to fix (attempt {attempt+2})')
                    result, last_err = _call_claude_retryable(messages)

            # If all retries exhausted with an error, surface it rather than returning empty
            if last_err and cached_rows is None and (result or {}).get('queryId') != 'USE_CVE_TAB':
                print(f'  [LQL] ✗ gave up after {MAX_RETRIES} attempts — {last_err}')
                self.send_json(500, json.dumps({'error': f'LQL still failing after {MAX_RETRIES} attempts — last error: {last_err}'}).encode())
                return

            # Attach pre-run rows — keep lean, no caching of rows (rows re-run fresh on next request)
            if cached_rows is not None:
                result['rows']  = cached_rows
                result['count'] = len(cached_rows)
                result['total'] = len(cached_rows)

                # Enrich with correlated REST API data (alerts, vulns, inventory)
                if _lw_token_data and cached_rows and result.get('queryText'):
                    try:
                        enrichment = self._enrich_lql_with_api(
                            *_lw_token_data, result['queryText'], cached_rows)
                        if enrichment:
                            result['api_enrichment'] = enrichment
                    except Exception:
                        pass  # enrichment is best-effort — never fail the response

            # searchTerm fallback: LQL only covers resource types Lacework has modeled as
            # datasources. When Claude names a specific software/app not covered by any
            # datasource, broaden the search via the REST Inventory API (rlike over
            # resourceConfig — catches Lambda function names, ECS task defs/images, EC2
            # tags, etc.) and merge alongside any LQL rows so the caller sees both.
            search_term = (result.get('searchTerm') or '').strip().lower()
            if search_term and _lw_token_data:
                try:
                    hits = self._inventory_keyword_search(*_lw_token_data, search_term)
                    if hits:
                        enrichment = result.setdefault('api_enrichment', {})
                        enrichment['inventory_keyword_search'] = {
                            'count':       len(hits),
                            'description': f'AWS resources matching "{search_term}" via REST Inventory API '
                                           f'(broader than LQL — covers all resource types, not just LQL-modeled ones)',
                            'items':       hits[:20],
                        }
                except Exception:
                    pass  # best-effort — never fail the response

            # Cache only queryId+queryText — skip rows to keep endpoint cache small
            if result.get('queryText') and result.get('queryId') != 'USE_CVE_TAB':
                _lql_cache[cache_key] = {
                    'queryId':   result['queryId'],
                    'queryText': result['queryText'],
                }

            self.send_json(200, json.dumps(result).encode())
        except urllib.error.HTTPError as e:
            err_body = e.read()
            try:
                msg = json.loads(err_body).get('error', {}).get('message', err_body.decode()[:400])
            except Exception:
                msg = err_body.decode()[:400]
            self.send_json(e.code, json.dumps({'error': msg}).encode())
        except Exception as e:
            msg = str(e)
            if 'Name or service not known' in msg or 'urlopen error' in msg:
                target = current_upstream()
                hint = 'HEADROOM_URL' if _headroom_enabled() else 'ANTHROPIC_BASE_URL'
                msg = (f'Cannot reach AI gateway ({target}). '
                       f'Check that {hint} in .env points to a reachable address and restart the server.')
            self.send_json(500, json.dumps({'error': msg}).encode())

    def serve_lql_run(self):
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {queryText}')
            return

        query_text = (payload.get('queryText') or '').strip()
        if not query_text:
            self.send_json(400, json.dumps({'error': 'queryText is required'}).encode())
            return

        now   = datetime.now(timezone.utc)
        start = payload.get('startTime') or (now - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
        end   = payload.get('endTime')   or now.strftime('%Y-%m-%dT%H:%M:%SZ')

        if shutil.which('lacework'):
            try:
                tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.lql', delete=False)
                tmp.write(json.dumps({'queryId': 'Run', 'queryText': query_text}))
                tmp.close()
                cmd = ['lacework', '--json', 'query', 'run', '-f', tmp.name,
                       '--start', start, '--end', end]
                if LW_PROFILE:
                    cmd += ['--profile', LW_PROFILE]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                os.unlink(tmp.name)
                if result.returncode == 0 and result.stdout.strip():
                    raw = json.loads(result.stdout)
                    rows = raw.get('data', raw) if isinstance(raw, dict) else raw
                    if not isinstance(rows, list):
                        rows = []
                    resp_body = {'rows': rows, 'count': len(rows), 'total': len(rows),
                                 'startTime': start, 'endTime': end}
                    if LW_READY:
                        try:
                            tk, burl = self._lw_token()
                            enrichment = self._enrich_lql_with_api(tk, burl, query_text, rows)
                            if enrichment:
                                resp_body['api_enrichment'] = enrichment
                        except Exception:
                            pass
                    self.send_json(200, json.dumps(resp_body).encode())
                    return
                cli_err = (result.stderr or result.stdout or '').strip()
            except subprocess.TimeoutExpired:
                self.send_json(504, json.dumps({'error': 'Query timed out'}).encode())
                return
            except Exception:
                cli_err = ''
        else:
            cli_err = ''

        try:
            token, base_url = self._lw_token()
        except Exception as e:
            self.send_json(503, json.dumps({'error': str(e)}).encode())
            return

        arguments = [
            {'name': 'StartTimeRange', 'value': start},
            {'name': 'EndTimeRange',   'value': end},
        ]
        evaluator_id = self._lw_evaluator_id(token, base_url, query_text)
        if evaluator_id:
            arguments.append({'name': 'evaluatorId', 'value': evaluator_id})

        body = json.dumps({
            'query': {'queryText': query_text},
            'arguments': arguments,
        }).encode()
        req = urllib.request.Request(
            f'{base_url}/api/v2/Queries/execute',
            data=body, method='POST',
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        )
        try:
            resp = urllib.request.urlopen(req, timeout=60)
            data = json.loads(resp.read())
            rows  = data.get('data', [])
            total = data.get('paging', {}).get('totalRows', len(rows))
            resp_body = {'rows': rows, 'count': len(rows), 'total': total,
                         'startTime': start, 'endTime': end}
            if LW_READY:
                try:
                    enrichment = self._enrich_lql_with_api(token, base_url, query_text, rows)
                    if enrichment:
                        resp_body['api_enrichment'] = enrichment
                except Exception:
                    pass
            self.send_json(200, json.dumps(resp_body).encode())
        except urllib.error.HTTPError as e:
            err_body = e.read()
            try:
                msg = json.loads(err_body).get('message', err_body.decode()[:500])
            except Exception:
                msg = err_body.decode()[:500]
            if cli_err:
                msg = f'{msg} | CLI: {cli_err}'
            self.send_json(e.code, json.dumps({'error': msg}).encode())

    def log_message(self, fmt, *args):
        print(f'  {self.address_string()} {fmt % args}')


LW_AVAILABLE = shutil.which('lacework') is not None

def _user_first_name():
    # .env override takes precedence
    if env.get('USER_NAME'):
        return env['USER_NAME'].split()[0]
    # macOS: id -F returns full name (e.g. "Sam Vuillaume")
    try:
        full = subprocess.check_output(['id', '-F'], text=True, timeout=2).strip()
        if full:
            return full.split()[0]
    except Exception:
        pass
    # Fallback: OS login name
    return os.environ.get('USER') or os.environ.get('USERNAME') or ''

def _lw_creds():
    account    = env.get('LW_ACCOUNT', '')
    api_key    = env.get('LW_API_KEY', '')
    api_secret = env.get('LW_API_SECRET', '')
    if account and api_key and api_secret:
        return account, api_key, api_secret
    toml_path = os.path.expanduser('~/.lacework.toml')
    if not os.path.exists(toml_path):
        return '', '', ''
    for line in open(toml_path):
        line = line.strip()
        if line.startswith('account')    and not account:
            account    = line.split('=',1)[1].strip().strip('"')
        elif line.startswith('api_key')   and not api_key:
            api_key    = line.split('=',1)[1].strip().strip('"')
        elif line.startswith('api_secret') and not api_secret:
            api_secret = line.split('=',1)[1].strip().strip('"')
    return account, api_key, api_secret

def _lw_profile():
    if env.get('LW_ACCOUNT') and env.get('LW_API_KEY') and env.get('LW_API_SECRET'):
        return ''
    toml_path = os.path.expanduser('~/.lacework.toml')
    if not os.path.exists(toml_path):
        return ''
    first_section = ''
    for line in open(toml_path):
        line = line.strip()
        if line.startswith('[') and line.endswith(']'):
            first_section = line[1:-1]
            break
    return '' if first_section == 'default' else first_section

LW_PROFILE = _lw_profile()
account, api_key, api_secret = _lw_creds()
LW_READY = bool(account and api_key and api_secret)

print(f'FortiAIScout  →  http://localhost:{PORT}')
print(f'Gateway       →  {current_upstream().rstrip("/")}/v1/*  key:{"ok" if VIRTUAL_KEY else "MISSING"}'
      f'{"  (via TokenIQ)" if _headroom_enabled() else ""}')
print(f'FortiCNAPP    →  creds:{"ok" if LW_READY else "MISSING"}  cli:{"ok" if LW_AVAILABLE else "not found"}')
print(f'LQL dir       →  {LQL_QUERIES_DIR or "not set"}')

import socket as _socket
def _port_open(port):
    with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0

if _port_open(PORT):
    print(f'ERROR: port {PORT} is already in use — stop the existing process first')
    print(f'  macOS/Linux: kill $(lsof -ti:{PORT})')
    print(f'  Windows:     Stop-Process -Id (Get-NetTCPConnection -LocalPort {PORT}).OwningProcess')
    raise SystemExit(1)

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
