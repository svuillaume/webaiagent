#!/usr/bin/env python3
"""
Local proxy + static server for chatbox.html and the Chrome extension.
  GET  /              → serves chatbox.html
  GET  /config        → returns Bifrost URL + key as JSON
  GET  /search?q=...  → proxies SearXNG search (CORS bypass for the extension)
  POST /proxy/v1/*    → proxies to Bifrost upstream
  POST /codesec       → runs lacework SCA+SAST on submitted code snippet
  POST /sbom          → runs lacework SCA and returns CycloneDX SBOM JSON
  GET  /lql/queries   → lists saved LQL YAML files from LQL_QUERIES_DIR
  POST /lql/run       → executes an LQL query against the FortiCNAPP API
  POST /lql/generate  → natural-language objective → LQL queryText via Claude

Usage: python3 serve.py
       open http://localhost:8765

SEARXNG_URL in .env overrides the default (http://localhost:8080).
LQL_QUERIES_DIR in .env points to the lql_queries/ folder from the forticnapp-lql repo.
The extension tries Docker SearXNG first; falls back here if Docker is not running.
"""
import http.server, json, os, shutil, socketserver, subprocess, tempfile, urllib.parse, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

PORT      = 8765
DIR       = os.path.dirname(os.path.abspath(__file__))

# Last compliance PDF cache: {'name': str, 'bytes': bytes}
_last_compliance_pdf: dict = {}
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
SEARXNG_URL     = env.get('SEARXNG_URL', 'http://localhost:8080')
UPSTREAM        = env.get('ANTHROPIC_BASE_URL', 'https://your-bifrost-endpoint/anthropic')
LQL_QUERIES_DIR = env.get('LQL_QUERIES_DIR', '')

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
        elif self.path == '/lql/queries':
            self.serve_lql_queries()
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
            'lw_ready':    LW_READY,
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
            # Collect submitted filenames for the response
            files_list = payload.get('files')
            if files_list:
                submitted_files = [os.path.basename(e.get('filename', 'snippet.txt')) for e in files_list]
            else:
                submitted_files = [os.path.basename(payload.get('filename', 'snippet.txt'))]
            filename = submitted_files[0] if len(submitted_files) == 1 else submitted_files

            out_json = os.path.join(tmpdir, 'sca.json')
            result   = subprocess.run(
                ['lacework', 'sca', 'scan', tmpdir,
                 '--deployment=offprem', '--noninteractive',
                 '--save-results=false', '-f', 'lw-json', '-o', out_json,
                 '--secret=false'],   # skip secretsAll cloud query (times out)
                capture_output=True, text=True, timeout=120,
            )

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

    def serve_lql_cve(self):
        """Accept {cveId, days?}, return per-host attack surface for that CVE.

        Correlates:
          - Vulnerabilities/Hosts/search  → which hosts carry the CVE + host internet exposure
          - Inventory/search (ec2:instance + container:workload) → container-level exposure
        Returns hosts sorted by internet-exposed first, then host risk score descending.
        """
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

        # ── 1. Pull vuln records for this CVE (Critical + High) ──────────────
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
                pass  # severity tier may return 404 on tenants with no matches

        if not vuln_rows:
            self.send_json(200, json.dumps({
                'cveId': cve_id, 'hosts': [], 'total_affected': 0,
                'note': f'No active records for {cve_id} in the last {days} days.',
            }).encode())
            return

        # ── 2. Aggregate per host ────────────────────────────────────────────
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
                    'host_exposed':     str(tags.get('lw_InternetExposure', '')).lower() == 'yes',
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

        # ── 3. Pull containers for each affected mid ─────────────────────────
        mids = list(hosts.keys())
        # Batch: query containers for up to 20 mids at a time
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
                    # Match container to host by MID or hostname tag
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
                pass  # container inventory optional — don't fail the whole request

        # ── 4. Sort: internet-exposed (host or container) first, then risk ───
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
        """Return a list of saved LQL YAML files from LQL_QUERIES_DIR."""
        if not LQL_QUERIES_DIR or not os.path.isdir(LQL_QUERIES_DIR):
            self.send_json(503, json.dumps({
                'error': 'LQL_QUERIES_DIR not set or not found — add it to .env'
            }).encode())
            return
        files = sorted(f for f in os.listdir(LQL_QUERIES_DIR) if f.endswith('.yaml'))
        queries = []
        for fname in files:
            path = os.path.join(LQL_QUERIES_DIR, fname)
            query_id, query_text = fname[:-5], ''
            try:
                with open(path) as f:
                    raw = f.read()
                # Extract queryId and queryText from the YAML (no external dep)
                for line in raw.splitlines():
                    if line.startswith('queryId:'):
                        query_id = line.split(':', 1)[1].strip()
                        break
                # Extract the LQL block after "queryText: |-"
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

    def serve_lql_generate(self):
        """Accept {objective}, call Claude via Bifrost, return {queryText, queryId}."""
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {objective}')
            return

        objective = (payload.get('objective') or '').strip()
        if not objective:
            self.send_json(400, json.dumps({'error': 'objective is required'}).encode())
            return

        if not UPSTREAM or not VIRTUAL_KEY:
            self.send_json(503, json.dumps({'error': 'Bifrost URL or virtual key not configured'}).encode())
            return

        system_prompt = """\
You are a FortiCNAPP LQL expert. Generate a single valid LQL query for the given objective.

Rules:
- Use ONLY these valid datasources: LW_CFG_AWS_S3, LW_CFG_AWS_S3_GET_BUCKET_ENCRYPTION, LW_CFG_AWS_S3_GET_BUCKET_POLICY, LW_CFG_AWS_EC2_INSTANCES, LW_CFG_AWS_EC2_SECURITY_GROUPS, LW_CFG_AWS_EC2_VPCS, LW_CFG_AWS_CLOUDTRAIL, LW_CFG_AWS_IAM_USERS, LW_CFG_AWS_IAM_USERS_GET_CREDENTIAL_REPORT, LW_CFG_AWS_IAM_USERS_LIST_POLICIES, LW_CFG_AWS_KMS_KEYS, LW_CFG_AWS_EC2_EBS_ENCRYPTION_BY_DEFAULT, LW_HE_PROCESSES, LW_HE_MACHINES, LW_HE_IMAGES, LW_HE_CONTAINERS, CloudTrailRawEvents
- NEVER use CONTAINS() — use LIKE '%value%' instead
- RLIKE is keyword form only: FIELD RLIKE 'pattern' (not RLIKE(field, pattern))
- LW_HE_PROCESSES fields: MID, EXE_PATH, CMDLINE, USERNAME — NO HOSTNAME field
- LW_CFG_AWS_EC2_INSTANCES tags field is RESOURCE_TAGS — NOT TAGS
- LW_HE_CONTAINERS fields: MID, CONTAINER_NAME, CONTAINER_ID only
- No multi-source joins unless using WITH ... ON '(default)' syntax
- JSON path access: FIELD:json.key — cast with ::String, ::Number
- Expand JSON arrays: array_to_rows(alias.FIELD:array) as (colname)
- Standard compliance return columns: ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_TYPE, SERVICE, 'reason' as COMPLIANCE_FAILURE_REASON
- For LW_HE_* datasources omit ARN/SERVICE/RESOURCE_TYPE and return MID plus relevant fields
- queryId format: Custom_<Cloud>_<Service>_<PascalCaseDescription>

Respond with ONLY a JSON object, no markdown, no explanation:
{"queryId": "Custom_...", "queryText": "{ source { ... } filter { ... } return distinct { ... } }"}"""

        messages = [{'role': 'user', 'content': f'Objective: {objective}'}]
        req_body = json.dumps({
            'model': 'claude-haiku-4-5',
            'max_tokens': 1024,
            'system': system_prompt,
            'messages': messages,
        }).encode()

        api_url = UPSTREAM.rstrip('/') + '/v1/messages'
        req = urllib.request.Request(
            api_url, data=req_body, method='POST',
            headers={
                'Content-Type': 'application/json',
                'x-api-key': VIRTUAL_KEY,
                'anthropic-version': '2023-06-01',
            },
        )
        try:
            resp      = urllib.request.urlopen(req, timeout=30)
            resp_data = json.loads(resp.read())
            raw       = resp_data['content'][0]['text'].strip()
            # Strip markdown code fences if model wrapped anyway
            if raw.startswith('```'):
                raw = '\n'.join(raw.split('\n')[1:])
                if raw.endswith('```'):
                    raw = raw[:-3].strip()
            result = json.loads(raw)
            self.send_json(200, json.dumps(result).encode())
        except urllib.error.HTTPError as e:
            err_body = e.read()
            try:
                msg = json.loads(err_body).get('error', {}).get('message', err_body.decode()[:400])
            except Exception:
                msg = err_body.decode()[:400]
            self.send_json(e.code, json.dumps({'error': msg}).encode())
        except Exception as e:
            self.send_json(500, json.dumps({'error': str(e)}).encode())

    def serve_lql_run(self):
        """Accept {queryText, startTime?, endTime?}, execute against FortiCNAPP, return rows."""
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {queryText}')
            return

        query_text = (payload.get('queryText') or '').strip()
        if not query_text:
            self.send_json(400, json.dumps({'error': 'queryText is required'}).encode())
            return

        try:
            token, base_url = self._lw_token()
        except Exception as e:
            self.send_json(503, json.dumps({'error': str(e)}).encode())
            return

        now   = datetime.now(timezone.utc)
        start = payload.get('startTime') or (now - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
        end   = payload.get('endTime')   or now.strftime('%Y-%m-%dT%H:%M:%SZ')

        body = json.dumps({
            'query': {'queryText': query_text},
            'arguments': [
                {'name': 'StartTimeRange', 'value': start},
                {'name': 'EndTimeRange',   'value': end},
            ],
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
            self.send_json(200, json.dumps({
                'rows': rows, 'count': len(rows), 'total': total,
                'startTime': start, 'endTime': end,
            }).encode())
        except urllib.error.HTTPError as e:
            err_body = e.read()
            try:
                msg = json.loads(err_body).get('message', err_body.decode()[:500])
            except Exception:
                msg = err_body.decode()[:500]
            self.send_json(e.code, json.dumps({'error': msg}).encode())

    def log_message(self, fmt, *args):
        print(f'  {self.address_string()} {fmt % args}')


LW_AVAILABLE = shutil.which('lacework') is not None

def _lw_creds_present():
    toml_path = os.path.expanduser('~/.lacework.toml')
    if not os.path.exists(toml_path):
        return False
    account = api_key = api_secret = ''
    with open(toml_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith('account'):
                account    = line.split('=',1)[1].strip().strip('"')
            elif line.startswith('api_key'):
                api_key    = line.split('=',1)[1].strip().strip('"')
            elif line.startswith('api_secret'):
                api_secret = line.split('=',1)[1].strip().strip('"')
    return bool(account and api_key and api_secret)

LW_READY = _lw_creds_present()

print(f'Bifrost chatbox  →  http://localhost:{PORT}')
print(f'Virtual key      →  {"loaded (" + VIRTUAL_KEY[:12] + "…)" if VIRTUAL_KEY else "MISSING — edit .env"}')
print(f'Proxy route      →  /proxy/v1/* → {UPSTREAM.rstrip("/")}/v1/*')
print(f'Search proxy     →  /search?q=... → {SEARXNG_URL}')
print(f'CodeSec scan     →  POST /codesec     {"(lacework CLI ready)" if LW_AVAILABLE else "(WARNING: lacework CLI not found)"}')
print(f'SBOM export      →  POST /sbom        {"(lacework CLI ready)" if LW_AVAILABLE else "(WARNING: lacework CLI not found)"}')
print(f'Compliance PDF   →  POST /compliance  {"(lacework CLI ready)" if LW_AVAILABLE else "(WARNING: lacework CLI not found)"}')
print(f'LQL queries      →  GET  /lql/queries  {"(" + LQL_QUERIES_DIR + ")" if LQL_QUERIES_DIR else "(WARNING: LQL_QUERIES_DIR not set in .env)"}')
print(f'LQL run          →  POST /lql/run')
print(f'LQL generate     →  POST /lql/generate')

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
