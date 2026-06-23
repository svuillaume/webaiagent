# Web AI Agent — Windows Setup Script (PowerShell)
# Run with: .\setup.ps1
# Requires PowerShell 5.1+ (built into Windows 10/11)

$ErrorActionPreference = 'Continue'

function Info  { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn  { param($msg) Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Fail  { param($msg) Write-Host "  [X]  $msg" -ForegroundColor Red; exit 1 }
function Ask   { param($msg) Write-Host "  [?]  $msg" -ForegroundColor Cyan }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "  Web AI Agent -- Setup (Windows)" -ForegroundColor Cyan
Write-Host "  --------------------------------" -ForegroundColor Cyan
Write-Host ""

# ── Python check ──────────────────────────────────────────────────────────────
$PyCmd = $null
foreach ($cmd in @("python3", "python")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3") { $PyCmd = $cmd; break }
    } catch {}
}
if (-not $PyCmd) {
    Fail "Python 3 not found. Install from https://python.org (tick 'Add to PATH') and re-run."
}
Info "Python found: $(& $PyCmd --version 2>&1)"

# ── Step 1: .env ──────────────────────────────────────────────────────────────
if (-not (Test-Path ".env")) {
    Warn ".env not found -- creating from template"
    Copy-Item ".env.tpl" ".env"
}

$envLines = Get-Content ".env" -ErrorAction SilentlyContinue
$envMap   = @{}
foreach ($line in $envLines) {
    if ($line -match '^([^#=]+)=(.*)$') { $envMap[$matches[1].Trim()] = $matches[2].Trim() }
}

function Write-EnvKey {
    param($key, $value)
    $lines = Get-Content ".env"
    $found = $false
    $lines = $lines | ForEach-Object {
        if ($_ -match "^${key}=") { "${key}=${value}"; $found = $true } else { $_ }
    }
    if (-not $found) { $lines += "${key}=${value}" }
    $lines | Set-Content ".env"
}

Write-Host ""
if (-not $envMap["ANTHROPIC_BASE_URL"]) {
    Ask "AI Gateway base URL (e.g. https://your-gateway.example.com/anthropic):"
    $val = Read-Host "  ANTHROPIC_BASE_URL"
    if ($val) { Write-EnvKey "ANTHROPIC_BASE_URL" $val; $envMap["ANTHROPIC_BASE_URL"] = $val }
} else {
    Info "ANTHROPIC_BASE_URL: $($envMap['ANTHROPIC_BASE_URL'])"
}

if (-not $envMap["BIFROST_VIRTUAL_KEY"]) {
    Ask "Gateway virtual key (sk-bf-...):"
    $val = Read-Host "  BIFROST_VIRTUAL_KEY"
    if ($val) { Write-EnvKey "BIFROST_VIRTUAL_KEY" $val }
} else {
    Info "BIFROST_VIRTUAL_KEY: $($envMap['BIFROST_VIRTUAL_KEY'].Substring(0, [Math]::Min(12,$envMap['BIFROST_VIRTUAL_KEY'].Length)))..."
}

# ── Step 2: extension offline config ──────────────────────────────────────────
if (-not (Test-Path "extension\config.json")) {
    Copy-Item "extension\config.json.tpl" "extension\config.json"
}

# ── Step 3: lacework CLI ───────────────────────────────────────────────────────
Write-Host ""
Info "Checking FortiCNAPP prerequisites..."

$LwCliOk  = $false
$LwTomlOk = $false

try {
    $lwVer = & lacework version 2>&1 | Select-Object -First 1
    Info "lacework CLI found -- $lwVer"
    $LwCliOk = $true
} catch {
    Warn "lacework CLI not found -- CodeSec and SBOM scanning will be unavailable."
    Write-Host ""
    Ask "Install the lacework CLI now? [y/N]"
    $installLw = Read-Host "  "
    if ($installLw -match '^[yY]') {
        Info "Downloading lacework CLI..."
        try {
            $url  = "https://github.com/lacework/go-sdk/releases/latest/download/lacework-cli-windows-amd64.exe"
            $dest = "$env:LOCALAPPDATA\lacework\lacework.exe"
            New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\lacework" | Out-Null
            Invoke-WebRequest $url -OutFile $dest -UseBasicParsing
            $env:PATH += ";$env:LOCALAPPDATA\lacework"
            Info "lacework CLI installed to $dest"
            Info "Add $env:LOCALAPPDATA\lacework to your PATH permanently via System Properties."
            $LwCliOk = $true
        } catch {
            Warn "Install failed: $_"
            Write-Host "    Download manually from https://github.com/lacework/go-sdk/releases"
        }
    }
}

# ── Step 4: lacework credentials ──────────────────────────────────────────────
$TomlPath = "$env:USERPROFILE\.lacework.toml"
if ((Test-Path $TomlPath) -and (Select-String -Path $TomlPath -Pattern 'api_key' -Quiet)) {
    $acct = (Select-String -Path $TomlPath -Pattern 'account').Line -replace '.*=\s*"?([^"]+)"?.*','$1'
    Info "FortiCNAPP credentials found (account: $acct)"
    $LwTomlOk = $true
} else {
    Warn "~\.lacework.toml not found or incomplete -- LQL, CVE, and Compliance will be unavailable."
    if ($LwCliOk) {
        Write-Host ""
        Ask "Configure FortiCNAPP credentials now? [y/N]"
        $cfgLw = Read-Host "  "
        if ($cfgLw -match '^[yY]') {
            & lacework configure
            if (Test-Path $TomlPath) { Info "Credentials saved."; $LwTomlOk = $true }
        }
    } else {
        Write-Host "    Once the CLI is installed, run:  lacework configure"
    }
}

if (-not $LwCliOk -and -not $LwTomlOk) {
    Write-Host ""
    Warn "Running in chat-only mode -- FortiCNAPP security tools unavailable."
}

# ── Step 5: start serve.py ─────────────────────────────────────────────────────
Write-Host ""
Info "Starting Web AI Agent (serve.py)..."
$proc = Start-Process $PyCmd -ArgumentList "serve.py" -NoNewWindow -PassThru -RedirectStandardOutput "serve.log" -RedirectStandardError "serve.err"
$proc.Id | Out-File ".serve.pid" -Encoding ascii

$ready = $false
Write-Host "  Waiting for server" -NoNewline
for ($i = 0; $i -lt 20; $i++) {
    try {
        $r = Invoke-WebRequest "http://localhost:45321/config" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { Write-Host " OK"; $ready = $true; break }
    } catch {}
    Write-Host "." -NoNewline
    Start-Sleep 1
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
if ($ready) {
    Write-Host "  [OK] Web AI Agent ready!" -ForegroundColor Green
} else {
    Write-Host "  [!]  Server did not respond in time. Check .\serve.err for errors." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Chatbox  ->  http://localhost:45321"
Write-Host "  Log      ->  .\serve.log"
Write-Host "  Errors   ->  .\serve.err"
Write-Host "  Stop     ->  Stop-Process -Id $(Get-Content .serve.pid)"
Write-Host ""
Write-Host "  Load the Chrome extension:" -ForegroundColor Cyan
Write-Host "    chrome://extensions -> Developer mode -> Load unpacked -> select extension\"
Write-Host ""
