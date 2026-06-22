#!/usr/bin/env python3
"""
Local proxy + static server for chatbox.html and the Chrome extension.
- GET  /config        → returns Bifrost URL + key as JSON
- GET  /search?q=...  → proxies web search to SearXNG (CORS bypass for the extension)
- POST /proxy/v1/*    → proxies to Bifrost (bypasses CORS for chatbox.html)
- GET  /              → serves chatbox.html

Usage: python3 serve.py
       open http://localhost:8765

Web search: set SEARXNG_URL in .env (default: http://localhost:8080).
The extension tries Docker SearXNG first; falls back to this proxy if Docker is not running.
"""
import http.server, json, os, socketserver, urllib.parse, urllib.request, urllib.error

PORT     = 8765
DIR      = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(DIR, '.env')
HTML_FILE= os.path.join(DIR, 'chatbox.html')
UPSTREAM = 'https://bifrost.fabriclab.ca/anthropic'

def load_env():
    env = {}
    if os.path.exists(ENV_FILE):
        for line in open(ENV_FILE):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, _, v = line.partition('=')
                env[k.strip()] = v.strip()
    return env

env         = load_env()
VIRTUAL_KEY = env.get('BIFROST_VIRTUAL_KEY', '')
SEARXNG_URL = env.get('SEARXNG_URL', 'http://localhost:8080')

CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version',
}

class Handler(http.server.BaseHTTPRequestHandler):

    def serve_html(self):
        html = open(HTML_FILE, 'rb').read().decode()
        if VIRTUAL_KEY:
            html = html.replace(
                'placeholder="Virtual key (x-bf-vk)…" autocomplete="off"',
                f'placeholder="Virtual key…" autocomplete="off" value="{VIRTUAL_KEY}"'
            )
        body = html.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        if self.path in ('/', '/chatbox.html'):
            self.serve_html()
        elif self.path == '/config':
            self.serve_config()
        elif self.path.startswith('/search'):
            self.serve_search()
        else:
            self.send_error(404)

    def serve_search(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        query  = params.get('q', [''])[0]
        if not query:
            self.send_error(400, 'Missing q parameter')
            return
        url = f"{SEARXNG_URL}/search?q={urllib.parse.quote(query)}&format=json&language=en"
        try:
            req  = urllib.request.Request(url, headers={'User-Agent': 'BifrostChat/1.0'})
            resp = urllib.request.urlopen(req, timeout=10)
            body = resp.read()
            self.send_response(200)
            for k, v in CORS_HEADERS.items():
                self.send_header(k, v)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_error(e.code, str(e))

    def serve_config(self):
        payload = json.dumps({
            'bifrost_url': env.get('ANTHROPIC_BASE_URL', ''),
            'api_key':     VIRTUAL_KEY,
        }).encode()
        self.send_response(200)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if not self.path.startswith('/proxy/'):
            self.send_error(404)
            return

        upstream_path = self.path[len('/proxy'):]
        url           = UPSTREAM + upstream_path
        length        = int(self.headers.get('Content-Length', 0))
        body          = self.rfile.read(length)

        fwd_headers = {
            'content-type':      self.headers.get('content-type', 'application/json'),
            'anthropic-version': self.headers.get('anthropic-version', '2023-06-01'),
            'x-api-key':         VIRTUAL_KEY,
        }

        req = urllib.request.Request(url, data=body, headers=fwd_headers, method='POST')

        try:
            resp = urllib.request.urlopen(req, timeout=120)
            self.send_response(resp.status)
            for k, v in CORS_HEADERS.items():
                self.send_header(k, v)
            for h in ('content-type', 'x-request-id'):
                val = resp.headers.get(h)
                if val:
                    self.send_header(h, val)
            self.end_headers()
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()

        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            for k, v in CORS_HEADERS.items():
                self.send_header(k, v)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} {fmt % args}")

print(f"Bifrost chatbox  →  http://localhost:{PORT}")
print(f"Virtual key      →  {'loaded (' + VIRTUAL_KEY[:12] + '…)' if VIRTUAL_KEY else 'MISSING — edit .env'}")
print(f"Proxy route      →  /proxy/v1/messages → {UPSTREAM}/v1/messages")
print(f"Search proxy     →  /search?q=... → {SEARXNG_URL}")

with socketserver.TCPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
