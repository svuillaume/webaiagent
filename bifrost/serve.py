#!/usr/bin/env python3
"""
Local proxy + static server for chatbox.html and the Chrome extension.
  GET  /              → serves chatbox.html
  GET  /config        → returns Bifrost URL + key as JSON
  GET  /search?q=...  → proxies SearXNG search (CORS bypass for the extension)
  POST /proxy/v1/*    → proxies to Bifrost upstream
  POST /codesec       → runs lacework SCA+SAST on submitted code snippet
  POST /sbom          → runs lacework SCA and returns CycloneDX SBOM JSON

Usage: python3 serve.py
       open http://localhost:8765

SEARXNG_URL in .env overrides the default (http://localhost:8080).
The extension tries Docker SearXNG first; falls back here if Docker is not running.
"""
import http.server, json, os, shutil, socketserver, subprocess, tempfile, urllib.parse, urllib.request, urllib.error

PORT      = 8765
DIR       = os.path.dirname(os.path.abspath(__file__))

# Last compliance PDF cache: {'name': str, 'bytes': bytes}
_last_compliance_pdf: dict = {}
HTML_FILE = os.path.join(DIR, 'chatbox.html')

def load_env():
    path = os.path.join(DIR, '.env')
    env = {}
    if not os.path.exists(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, _, v = line.partition('=')
                env[k.strip()] = v.strip()
    return env

env         = load_env()
VIRTUAL_KEY = env.get('BIFROST_VIRTUAL_KEY', '')
SEARXNG_URL = env.get('SEARXNG_URL', 'http://localhost:8080')
UPSTREAM    = env.get('ANTHROPIC_BASE_URL', 'https://your-bifrost-endpoint/anthropic')

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version',
}


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
        elif self.path.startswith('/search'):
            self.serve_search()
        elif self.path == '/compliance/list':
            self.serve_compliance_list()
        elif self.path == '/compliance/latest-text':
            self.serve_compliance_text()
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == '/codesec':
            self.serve_codesec()
        elif self.path == '/sbom':
            self.serve_sbom()
        elif self.path == '/compliance':
            self.serve_compliance()
        elif self.path.startswith('/proxy/'):
            self.proxy_upstream()
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
            'bifrost_url': env.get('ANTHROPIC_BASE_URL', ''),
            'api_key':     VIRTUAL_KEY,
            'searxng_url': SEARXNG_URL,
        }).encode()
        self.send_json(200, body)

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
            self.send_json(200, resp.read())
        except urllib.error.HTTPError as e:
            self.send_error(e.code, str(e))

    def proxy_upstream(self):
        url    = UPSTREAM + self.path[len('/proxy'):]
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
        """Write files array [{filename, code}] or legacy {filename, code} to tmpdir."""
        files = payload.get('files')
        if files:
            for entry in files:
                name = os.path.basename(entry.get('filename', 'snippet.txt'))
                path = os.path.join(tmpdir, name)
                with open(path, 'w') as f:
                    f.write(entry.get('code', ''))
        else:
            name = os.path.basename(payload.get('filename', 'snippet.txt'))
            with open(os.path.join(tmpdir, name), 'w') as f:
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

        tmpdir = tempfile.mkdtemp(prefix='bifrost-codesec-')
        try:
            self._write_files(tmpdir, payload)
            filename = 'scan'  # used only for error display

            out_json = os.path.join(tmpdir, 'sca.json')
            result   = subprocess.run(
                ['lacework', 'sca', 'scan', tmpdir,
                 '--deployment=offprem', '--noninteractive',
                 '--save-results=false', '-f', 'lw-json', '-o', out_json],
                capture_output=True, text=True, timeout=120,
            )

            findings, weaknesses, secrets = [], [], []
            if os.path.exists(out_json):
                with open(out_json) as f:
                    data = json.load(f)

                # Build artifact id → name map
                art_map = {a['Id']: a.get('Name', a.get('Path', ''))
                           for a in data.get('Artifacts', [])}

                # SCA vulnerabilities — top-level Vulnerabilities[]
                for vuln in data.get('Vulnerabilities', []):
                    info = vuln.get('Info', {})
                    aid  = (vuln.get('AffectedArtifactIds') or [''])[0]
                    fv = info.get('FixVersion') or {}
                    findings.append({
                        'type':        'vuln',
                        'id':          info.get('ExternalId', ''),
                        'severity':    info.get('Severity', ''),
                        'package':     art_map.get(aid, aid),
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
                'stderr':     result.stderr[-2000:] if result.returncode not in (0, 1) else '',
            }).encode()
            self.send_json(200, body)
        except subprocess.TimeoutExpired:
            self.send_json(504, json.dumps({'error': 'scan timed out'}).encode())
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def serve_sbom(self):
        """Accept JSON {files:[{filename,code}]}, return CycloneDX SBOM from lacework SCA."""
        if not shutil.which('lacework'):
            self.send_json(503, json.dumps({'error': 'lacework CLI not found'}).encode())
            return
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {files:[{filename,code}]}')
            return

        tmpdir = tempfile.mkdtemp(prefix='bifrost-sbom-')
        try:
            self._write_files(tmpdir, payload)

            out_json = os.path.join(tmpdir, 'sbom.json')
            result   = subprocess.run(
                ['lacework', 'sca', 'scan', tmpdir,
                 '--deployment=offprem', '--noninteractive',
                 '--save-results=false', '-f', 'cyclonedx-json', '-o', out_json],
                capture_output=True, text=True, timeout=120,
            )

            if os.path.exists(out_json):
                with open(out_json) as f:
                    sbom = json.load(f)
                self.send_json(200, json.dumps(sbom).encode())
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
        """Obtain a short-lived Bearer token from ~/.lacework.toml credentials."""
        toml_path = os.path.expanduser('~/.lacework.toml')
        account = api_key = api_secret = ''
        if os.path.exists(toml_path):
            with open(toml_path) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('account'):
                        account    = line.split('=',1)[1].strip().strip('"')
                    elif line.startswith('api_key'):
                        api_key    = line.split('=',1)[1].strip().strip('"')
                    elif line.startswith('api_secret'):
                        api_secret = line.split('=',1)[1].strip().strip('"')
        if not (account and api_key and api_secret):
            raise ValueError('lacework credentials not found in ~/.lacework.toml')
        base_url = f'https://{account}.lacework.net'
        body = json.dumps({'keyId': api_key, 'expiryTime': 3600}).encode()
        req = urllib.request.Request(
            f'{base_url}/api/v2/access/tokens', data=body, method='POST',
            headers={'X-LW-UAKS': api_secret, 'Content-Type': 'application/json'})
        resp = urllib.request.urlopen(req, timeout=15)
        token_data = json.loads(resp.read())
        return token_data['token'], base_url

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
        """Return all frameworks from /api/v2/Frameworks grouped by cloud."""
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
        """Accept {frameworkGuid, frameworkName}, create temp config, generate PDF, delete config."""
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

        # Pick resource group based on cloud
        cloud_str = ' '.join(clouds).upper()
        if 'AZURE' in cloud_str:
            rg = 'LACEWORK_RESOURCE_GROUP_ALL_AZURE'
        elif 'GCP' in cloud_str or 'GOOGLE' in cloud_str:
            rg = 'LACEWORK_RESOURCE_GROUP_ALL_GCP'
        elif 'OCI' in cloud_str or 'ORACLE' in cloud_str:
            rg = 'LACEWORK_RESOURCE_GROUP_ALL_OCI'
        else:
            rg = 'LACEWORK_RESOURCE_GROUP_ALL_AWS'

        import datetime
        end   = datetime.datetime.now(datetime.timezone.utc)
        start = end - datetime.timedelta(days=7)
        fmt_t = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
        headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

        # Create temp ReportConfiguration
        cfg_body = json.dumps({
            'name':         f'bifrost-tmp-{fw_guid[:8]}',
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

            # Generate PDF
            gen_url = (f'{base_url}/api/v2/ReportConfigurations/{cfg_guid}/generate'
                       f'?startTime={fmt_t(start)}&endTime={fmt_t(end)}&format=pdf')
            req2     = urllib.request.Request(gen_url, method='POST', headers=headers)
            resp2    = urllib.request.urlopen(req2, timeout=120)
            pdf_bytes = resp2.read()
            safe_name = fw_name.replace('/', '-').replace(' ', '_')[:60]
            # Cache for /compliance/latest-text
            _last_compliance_pdf['name']  = fw_name
            _last_compliance_pdf['bytes'] = pdf_bytes
            self.send_pdf(pdf_bytes, f'compliance-{safe_name}.pdf')

        except urllib.error.HTTPError as e:
            err_body = e.read()
            try:
                err_msg = json.loads(err_body).get('message', err_body.decode())
            except Exception:
                err_msg = err_body.decode()[:500]
            self.send_json(e.code, json.dumps({'error': err_msg}).encode())
        finally:
            # Always clean up the temp config
            if cfg_guid:
                try:
                    urllib.request.urlopen(
                        urllib.request.Request(
                            f'{base_url}/api/v2/ReportConfigurations/{cfg_guid}',
                            method='DELETE', headers=headers),
                        timeout=10)
                except Exception:
                    pass

    def serve_compliance_text(self):
        """Extract text from the last generated compliance PDF and return as JSON."""
        if not _last_compliance_pdf.get('bytes'):
            self.send_json(404, json.dumps({'error': 'No compliance PDF generated yet'}).encode())
            return
        pdf_bytes = _last_compliance_pdf['bytes']
        fw_name   = _last_compliance_pdf.get('name', 'Compliance Report')
        # Try pdftotext if available; otherwise return base64 for client-side fallback
        if shutil.which('pdftotext'):
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as f:
                f.write(pdf_bytes)
                tmppath = f.name
            try:
                result = subprocess.run(
                    ['pdftotext', '-layout', tmppath, '-'],
                    capture_output=True, timeout=30)
                text = result.stdout.decode('utf-8', errors='replace')
                self.send_json(200, json.dumps({'name': fw_name, 'text': text}).encode())
            finally:
                os.unlink(tmppath)
        else:
            import base64
            self.send_json(200, json.dumps({
                'name':   fw_name,
                'text':   None,
                'base64': base64.b64encode(pdf_bytes).decode(),
                'note':   'Install pdftotext (poppler-utils) for text extraction',
            }).encode())

    def log_message(self, fmt, *args):
        print(f'  {self.address_string()} {fmt % args}')


LW_AVAILABLE = shutil.which('lacework') is not None

print(f'Bifrost chatbox  →  http://localhost:{PORT}')
print(f'Virtual key      →  {"loaded (" + VIRTUAL_KEY[:12] + "…)" if VIRTUAL_KEY else "MISSING — edit .env"}')
print(f'Proxy route      →  /proxy/v1/* → {UPSTREAM.rstrip("/")}/v1/*')
print(f'Search proxy     →  /search?q=... → {SEARXNG_URL}')
print(f'CodeSec scan     →  POST /codesec     {"(lacework CLI ready)" if LW_AVAILABLE else "(WARNING: lacework CLI not found)"}')
print(f'SBOM export      →  POST /sbom        {"(lacework CLI ready)" if LW_AVAILABLE else "(WARNING: lacework CLI not found)"}')
print(f'Compliance PDF   →  POST /compliance  {"(lacework CLI ready)" if LW_AVAILABLE else "(WARNING: lacework CLI not found)"}')

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
