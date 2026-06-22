#!/usr/bin/env python3
"""
Local proxy + static server for chatbox.html
- Serves chatbox.html with the key pre-filled from .env
- Proxies /proxy/v1/* → https://bifrost.fabriclab.ca/anthropic/v1/*
  (sidesteps Bifrost's missing Access-Control-Allow-Origin on POST responses)

Usage: python3 serve.py
       open http://localhost:8765
"""
import http.server, os, socketserver, urllib.request, urllib.error

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
VIRTUAL_KEY = env.get('BIFROST_VIRTUAL_KEY', '')  # sent as x-api-key

CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version',
}

class Handler(http.server.BaseHTTPRequestHandler):

    # ── static HTML ──────────────────────────────────────────────────────────
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

    # ── CORS preflight ───────────────────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()

    # ── GET ──────────────────────────────────────────────────────────────────
    def do_GET(self):
        if self.path in ('/', '/chatbox.html'):
            self.serve_html()
        else:
            self.send_error(404)

    # ── POST (proxy to Bifrost) ───────────────────────────────────────────────
    def do_POST(self):
        if not self.path.startswith('/proxy/'):
            self.send_error(404)
            return

        upstream_path = self.path[len('/proxy'):]          # /v1/messages
        url           = UPSTREAM + upstream_path
        length        = int(self.headers.get('Content-Length', 0))
        body          = self.rfile.read(length)

        # Forward relevant headers; inject the virtual key
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
            # Forward important upstream headers
            for h in ('content-type', 'x-request-id'):
                val = resp.headers.get(h)
                if val:
                    self.send_header(h, val)
            self.end_headers()

            # Stream the response body (handles SSE)
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

with socketserver.TCPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
