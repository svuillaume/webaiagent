#!/usr/bin/env python3
"""
Local proxy + static server for chatbox.html and the Chrome extension.

GET  /              → chatbox.html
GET  /config        → gateway URL, key, lw_ready flag
POST /proxy/v1/*    → proxy to AI gateway upstream
POST /codesec       → lacework SCA+SAST on submitted code
POST /sbom          → CycloneDX SBOM via lacework SCA
POST /compliance    → compliance PDF; cached at /compliance/latest-text
GET  /compliance/list → available frameworks
GET  /lql/queries   → list .yaml files from LQL_QUERIES_DIR
POST /lql/run       → execute LQL against FortiCNAPP
POST /lql/cve       → CVE attack surface: hosts + containers
POST /lql/generate  → plain-English → LQL via Claude

Usage: python3 serve.py  →  http://localhost:45321
"""
import base64, http.server, json, os, shutil, socketserver, subprocess, tempfile, urllib.parse, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

PORT      = 45321
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
UPSTREAM        = env.get('ANTHROPIC_BASE_URL', 'https://your-gateway-endpoint/anthropic')
MODEL           = env.get('ANTHROPIC_DEFAULT_MODEL', 'claude-haiku-4-5')
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
            'gateway_url': env.get('ANTHROPIC_BASE_URL', ''),
            'api_key':     VIRTUAL_KEY,
            'lw_ready':    LW_READY,
            'lw_cli':      LW_AVAILABLE,
            'user_name':   _user_first_name(),
        }).encode()
        self.send_json(200, body)

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

        tmpdir = tempfile.mkdtemp(prefix='webai-codesec-')
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
        """Accept JSON {files:[{filename,code}]}, return CycloneDX SBOM from lacework SCA."""
        if not shutil.which('lacework'):
            self.send_json(503, json.dumps({'error': 'lacework CLI not found'}).encode())
            return
        try:
            payload = json.loads(self._read_body())
        except json.JSONDecodeError:
            self.send_error(400, 'Expected JSON {files:[{filename,code}]}')
            return

        tmpdir = tempfile.mkdtemp(prefix='webai-sbom-')
        try:
            self._write_files(tmpdir, payload)

            out_json = os.path.join(tmpdir, 'sbom.json')
            cmd = ['lacework', 'sca', 'scan', tmpdir,
                   '--deployment=offprem', '--noninteractive',
                   '--save-results=false', '-f', 'cyclonedx-json', '-o', out_json]
            if LW_PROFILE:
                cmd += ['--profile', LW_PROFILE]
            result   = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

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
        if not _last_compliance_pdf.get('bytes'):
            self.send_json(404, json.dumps({'error': 'No compliance PDF generated yet'}).encode())
            return
        pdf_bytes = _last_compliance_pdf['bytes']
        fw_name   = _last_compliance_pdf.get('name', 'Compliance Report')
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
            self.send_json(200, json.dumps({
                'name':   fw_name,
                'text':   None,
                'base64': base64.b64encode(pdf_bytes).decode(),
                'note':   'Install pdftotext (poppler-utils) for text extraction',
            }).encode())

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

        if not UPSTREAM or not VIRTUAL_KEY:
            self.send_json(503, json.dumps({'error': 'Gateway URL or virtual key not configured'}).encode())
            return

        system_prompt = """\
You are a FortiCNAPP LQL (Lacework Query Language) expert. Generate a single valid LQL query for the given objective.

━━ CVE ROUTING RULE ━━
If the objective involves CVE vulnerabilities (e.g. "hosts with CVE-xxx", "vulnerable hosts", "container images with vulnerabilities", "patch exposure"), do NOT generate LQL. Respond ONLY with:
{"queryId": "USE_CVE_TAB", "queryText": "", "note": "CVE vulnerability data is not available in LQL. Use the CVE tab in this panel instead — it queries the FortiCNAPP Vulnerabilities API directly and shows hosts ranked by internet exposure and risk score."}

━━ LQL SYNTAX ━━
Structure:       { source { DATASOURCE } filter { conditions } return distinct { columns } }
Multi-source:    { source { DS_A a WITH DS_B b ON b.KEY = a.KEY } ... }   — left outer join
Array expand:    { source { DS d array_to_rows(d.FIELD:arraypath) as elem } ... }

Comparison:      =  !=  <  <=  >  >=  IS NULL  IS NOT NULL  IS JSON NULL
Pattern match:   FIELD LIKE 'a%'  /  FIELD ILIKE 'a%'  /  FIELD RLIKE 'regex'
Multi-pattern:   FIELD LIKE ANY ('a%', '%b')   — also ILIKE ANY, RLIKE ANY
Set:             FIELD IN (v1, v2)  /  FIELD NOT IN (v1, v2)
Range:           FIELD BETWEEN v1 AND v2
Logic:           AND  OR  NOT
CASE:            CASE WHEN cond THEN val ELSE other END
Cast:            FIELD:json.nested.key::String   — types: String, Number, Boolean

CRITICAL RULES — violations cause parse errors:
- NEVER use array wildcard syntax [*] or [0] — LQL does NOT support array indexing in filters
  BAD: RESOURCE_CONFIG:BlockDeviceMappings[*].Ebs.Encrypted::String
  GOOD: query a dedicated per-resource datasource (e.g. LW_CFG_AWS_EC2_VOLUMES) or use array_to_rows()
- NEVER use CONTAINS() function — use LIKE '%value%' instead
- RLIKE: keyword form only — FIELD RLIKE 'regex'   (never RLIKE(field, 'regex'))
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
  LW_CFG_AWS_IAM_USERS_GET_CREDENTIAL_REPORT  — credential report; top-level fields: USERNAME, MFA_ACTIVE, PASSWORD_ENABLED, PASSWORD_LAST_USED, ACCESS_KEY_1_ACTIVE, ACCESS_KEY_1_LAST_USED_DATE, ACCESS_KEY_2_ACTIVE
  LW_CFG_AWS_IAM_USERS_LIST_ATTACHED_POLICIES — managed policies attached to each user
  LW_CFG_AWS_IAM_USERS_LIST_POLICIES          — inline policies per user
  LW_CFG_AWS_IAM_USERS_LIST_ACCESS_KEYS       — access key metadata per user
  LW_CFG_AWS_IAM_ROLES                        — IAM roles
  LW_CFG_AWS_IAM_ROLES_LIST_ATTACHED_POLICIES — managed policies attached to roles
  LW_CFG_AWS_IAM_POLICIES                     — IAM managed policies
  LW_CFG_AWS_IAM_GROUPS                       — IAM groups
  LW_CFG_AWS_IAM_MFA_DEVICES                  — virtual MFA devices
  LW_CFG_AWS_IAM_ACCOUNT_PASSWORD_POLICY      — account password policy; RESOURCE_CONFIG:MinimumPasswordLength::Number, RequireUppercaseCharacters::Boolean, MaxPasswordAge::Number, etc.
  LW_CFG_AWS_IAM_ACCOUNT_SUMMARY              — account-level IAM summary counts
  LW_CFG_AWS_IAM_GET_ACCESS_KEY_LAST_USED     — per-key last-used date

Compute — EC2:
  LW_CFG_AWS_EC2_INSTANCES                    — EC2 instances; RESOURCE_CONFIG:State.Name::String = 'running'
  LW_CFG_AWS_EC2_SECURITY_GROUPS              — security groups; RESOURCE_CONFIG:IpPermissions and IpPermissionsEgress contain arrays of rules — DO NOT use [*] to query them; use array_to_rows()
  LW_CFG_AWS_EC2_VPCS                         — VPCs
  LW_CFG_AWS_EC2_SUBNETS                      — subnets
  LW_CFG_AWS_EC2_VOLUMES                      — EBS volumes; RESOURCE_CONFIG:Encrypted::Boolean, RESOURCE_CONFIG:State::String, RESOURCE_CONFIG:VolumeType::String
  LW_CFG_AWS_EC2_EBS_ENCRYPTION_BY_DEFAULT    — EBS default encryption per region; RESOURCE_CONFIG:ebsEncryptionByDefault::Boolean
  LW_CFG_AWS_EC2_NETWORK_ACLS                 — Network ACLs
  LW_CFG_AWS_EC2_VPC_FLOW_LOGS               — VPC flow log configs
  LW_CFG_AWS_EC2_INTERNET_GATEWAYS            — internet gateways
  LW_CFG_AWS_EC2_SNAPSHOTS                    — EBS snapshots; RESOURCE_CONFIG:Encrypted::Boolean
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
  LW_CFG_AWS_S3_GET_PUBLIC_ACCESS_BLOCK      — per-bucket public access block settings
  LW_CFG_AWS_S3CONTROL_GET_PUBLIC_ACCESS_BLOCK — account-level S3 public access block
  LW_CFG_AWS_RDS_DB_INSTANCES                 — RDS instances; RESOURCE_CONFIG:StorageEncrypted::Boolean, MultiAZ::Boolean, PubliclyAccessible::Boolean
  LW_CFG_AWS_RDS_CLUSTERS                     — RDS Aurora clusters
  LW_CFG_AWS_RDS_DB_SNAPSHOTS                 — RDS snapshots
  LW_CFG_AWS_DYNAMODB_TABLES                  — DynamoDB tables

Encryption & Secrets:
  LW_CFG_AWS_KMS_KEYS                         — KMS key list
  LW_CFG_AWS_KMS_KEYS_DESCRIBE_KEY            — KMS key details; RESOURCE_CONFIG:KeyState::String, KeyManager::String ('AWS' or 'CUSTOMER'), KeyUsage::String
  LW_CFG_AWS_KMS_KEYS_GET_ROTATION_STATUS     — KMS rotation; RESOURCE_CONFIG:keyRotationEnabled::Boolean
  LW_CFG_AWS_KMS_ALIASES                      — KMS aliases
  LW_CFG_AWS_SECRETSMANAGER_SECRETS           — Secrets Manager; top-level: NAME, DESCRIPTION, ROTATION_ENABLED, LAST_ROTATED_DATE
  LW_CFG_AWS_SSM_PARAMETERS                   — SSM Parameter Store; top-level: NAME, TYPE, DESCRIPTION (TYPE='SecureString' = encrypted)

Security & Audit:
  LW_CFG_AWS_CLOUDTRAIL                       — CloudTrail trails; RESOURCE_CONFIG:IsMultiRegionTrail::Boolean, LogFileValidationEnabled::Boolean
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
                        TAGS:lw_InternetExposure::String = 'Yes'  → internet-exposed host
                        TAGS:Account::String, TAGS:Region::String, TAGS:Hostname::String

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

  CloudTrailRawEvents — raw CloudTrail audit events: EVENT_NAME, EVENT_SOURCE, EVENT_TIME, USER_IDENTITY(JSON), SOURCE_IP_ADDRESS, REQUEST_PARAMETERS(JSON), RESPONSE_ELEMENTS(JSON), ERROR_CODE

━━ CLOUD ENTITLEMENT & ATTACK PATH ━━
  LW_APA_ATTACK_PATHS   — attack paths: PATH_ID, PROVIDER_TYPE, DOMAIN_ID, METRICS(JSON), PATH(JSON), TARGETS(JSON)
  LW_APA_EXPOSURE_PATHS — exposure paths: PATH_ID, PATH_TYPE, TARGET_ID, TARGET_TYPE, TARGET_TAGS
  LW_CE_ENTITLEMENTS    — effective IAM permissions: PRINCIPAL_ID, SERVICE, RESOURCE_TYPE, RESOURCE_ID, POLICY_ID, ACTION, LAST_USED_TIME
  LW_CE_IDENTITIES      — cloud identities: PRINCIPAL_ID, NAME, PROVIDER_TYPE, LAST_USED_TIME, CREATED_TIME, METRICS(JSON)

━━ EXAMPLES ━━

EC2 instances with unencrypted EBS volumes — use LW_CFG_AWS_EC2_VOLUMES (not EC2_INSTANCES with array indexing):
{"queryId":"Custom_AWS_EC2_UnencryptedVolumes","queryText":"{ source { LW_CFG_AWS_EC2_VOLUMES } filter { RESOURCE_CONFIG:Encrypted::Boolean = false AND RESOURCE_CONFIG:State::String = 'in-use' } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, RESOURCE_TYPE, SERVICE, 'EBS volume is not encrypted' as COMPLIANCE_FAILURE_REASON } }"}

Regions without EBS encryption-by-default:
{"queryId":"Custom_AWS_EC2_NoEBSDefaultEncryption","queryText":"{ source { LW_CFG_AWS_EC2_EBS_ENCRYPTION_BY_DEFAULT } filter { RESOURCE_CONFIG:ebsEncryptionByDefault::Boolean = false } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, RESOURCE_REGION, 'EBS encryption by default is disabled' as COMPLIANCE_FAILURE_REASON } }"}

IAM users with password login but no MFA:
{"queryId":"Custom_AWS_IAM_UsersNoMFA","queryText":"{ source { LW_CFG_AWS_IAM_USERS_GET_CREDENTIAL_REPORT } filter { MFA_ACTIVE = false AND PASSWORD_ENABLED = true } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, USERNAME, PASSWORD_LAST_USED, 'Password login without MFA' as COMPLIANCE_FAILURE_REASON } }"}

KMS customer keys without rotation:
{"queryId":"Custom_AWS_KMS_NoRotation","queryText":"{ source { LW_CFG_AWS_KMS_KEYS_GET_ROTATION_STATUS } filter { RESOURCE_CONFIG:keyRotationEnabled::Boolean = false } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, 'KMS key rotation not enabled' as COMPLIANCE_FAILURE_REASON } }"}

Internet-exposed hosts:
{"queryId":"Custom_AWS_Hosts_InternetExposed","queryText":"{ source { LW_HE_MACHINES } filter { TAGS:lw_InternetExposure::String = 'Yes' } return distinct { MID, TAGS:Hostname::String as HOSTNAME, TAGS:Account::String as ACCOUNT, TAGS:Region::String as REGION, OS } }"}

SSH logins from external IPs on internet-exposed hosts (multi-source join):
{"queryId":"Custom_AWS_Hosts_ExternalSSHLogins","queryText":"{ source { LW_HA_SSH_LOGINS s WITH LW_HE_MACHINES m ON m.MID = s.MID } filter { m.TAGS:lw_InternetExposure::String = 'Yes' AND s.IP_ADDR NOT LIKE '10.%' AND s.IP_ADDR NOT LIKE '192.168.%' } return distinct { s.MID, m.TAGS:Hostname::String as HOSTNAME, s.USERNAME, s.IP_ADDR, s.LOGIN_TIME, m.TAGS:Account::String as ACCOUNT } }"}

Secrets Manager secrets without rotation:
{"queryId":"Custom_AWS_SecretsManager_NoRotation","queryText":"{ source { LW_CFG_AWS_SECRETSMANAGER_SECRETS } filter { ROTATION_ENABLED = false } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, NAME, LAST_ROTATED_DATE, 'Secret rotation not enabled' as COMPLIANCE_FAILURE_REASON } }"}

SSM SecureString parameters (potential unmanaged secrets):
{"queryId":"Custom_AWS_SSM_SecureParameters","queryText":"{ source { LW_CFG_AWS_SSM_PARAMETERS } filter { TYPE = 'SecureString' } return distinct { ACCOUNT_ALIAS, ACCOUNT_ID, ARN as RESOURCE_KEY, RESOURCE_REGION, NAME, DESCRIPTION } }"}

━━ OUTPUT FORMAT ━━
Respond with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"queryId": "Custom_<Cloud>_<Service>_<PascalCaseDescription>", "queryText": "{ source { ... } filter { ... } return distinct { ... } }"}"""

        # Embed system as first user message — works for Anthropic and OpenAI-compatible gateways
        messages = [
            {'role': 'user', 'content': f'<system>\n{system_prompt}\n</system>\n\nObjective: {objective}'},
        ]
        model = MODEL or 'claude-haiku-4-5'
        req_body = json.dumps({
            'model': model,
            'max_tokens': 2048,
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
            resp      = urllib.request.urlopen(req, timeout=60)
            resp_data = json.loads(resp.read())

            if 'content' in resp_data and resp_data['content']:
                # Anthropic: {"content": [{"type": "text", "text": "..."}]}
                raw = resp_data['content'][0].get('text', '')
            elif 'choices' in resp_data and resp_data['choices']:
                # OpenAI / Ollama: {"choices": [{"message": {"content": "..."}}]}
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
                cmd = ['lacework', 'query', 'execute',
                       '--query-text', query_text,
                       '--start', start, '--end', end, '--json']
                if LW_PROFILE:
                    cmd += ['--profile', LW_PROFILE]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                if result.returncode == 0 and result.stdout.strip():
                    raw = json.loads(result.stdout)
                    rows = raw.get('data', raw) if isinstance(raw, dict) else raw
                    if not isinstance(rows, list):
                        rows = []
                    self.send_json(200, json.dumps({
                        'rows': rows, 'count': len(rows), 'total': len(rows),
                        'startTime': start, 'endTime': end,
                    }).encode())
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

print(f'Web AI Agent  →  http://localhost:{PORT}')
print(f'Gateway       →  {UPSTREAM.rstrip("/")}/v1/*  key:{"ok" if VIRTUAL_KEY else "MISSING"}')
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
