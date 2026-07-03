# FortiAIScout — Windows Setup Script (PowerShell)
# Run with: .\setup.ps1
# Requires PowerShell 5.1+ (built into Windows 10/11)

$ErrorActionPreference = 'Continue'

function Info  { param($msg) Write-Host "     [OK] $msg" -ForegroundColor Green }
function Warn  { param($msg) Write-Host "     [!]  $msg" -ForegroundColor Yellow }
function Fail  { param($msg) Write-Host "     [X]  $msg" -ForegroundColor Red; exit 1 }
function Ask   { param($msg) Write-Host "     [?]  $msg" -ForegroundColor Cyan }
function Step  { param($n,$msg) Write-Host ""; Write-Host "  STEP $n — $msg" -ForegroundColor White; Write-Host "  $('─' * 60)" -ForegroundColor DarkGray }
function Note  { param($msg) Write-Host "     $msg" -ForegroundColor DarkGray }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║       FortiAIScout  —  Windows Setup     ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  This script will:"
Write-Host "    1. Verify Python 3 is installed"
Write-Host "    2. Configure your AI Gateway credentials (.env)"
Write-Host "    3. Set up the Chrome extension config"
Write-Host "    4. Optionally install the lacework (FortiCNAPP) CLI"
Write-Host "    5. Optionally configure FortiCNAPP credentials"
Write-Host "    6. Start the local AI Agent server (serve.py)"
Write-Host "    7. Show you how to load the Chrome extension"
Write-Host ""
Write-Host "  Press Ctrl+C at any time to cancel." -ForegroundColor DarkGray
Write-Host ""

# ═══════════════════════════════════════════════════════════════
Step 1 "Check Python 3"
# ═══════════════════════════════════════════════════════════════
Note "Looking for python3 or python on your PATH..."

$PyCmd = $null
foreach ($cmd in @("python3", "python")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3") { $PyCmd = $cmd; break }
    } catch {}
}

if (-not $PyCmd) {
    Write-Host ""
    Fail "Python 3 not found."
    Write-Host ""
    Write-Host "  HOW TO INSTALL PYTHON:" -ForegroundColor Yellow
    Write-Host "    UI:  Open https://python.org/downloads"
    Write-Host "         Download the latest Python 3.x installer"
    Write-Host "         Run the installer — TICK 'Add python.exe to PATH'"
    Write-Host "         Click 'Install Now'"
    Write-Host ""
    Write-Host "    CLI: winget install Python.Python.3.12"
    Write-Host ""
    Write-Host "  After installing, close and reopen PowerShell, then re-run .\setup.ps1"
    exit 1
}
Info "Python found: $(& $PyCmd --version 2>&1)"

# ═══════════════════════════════════════════════════════════════
Step 2 "Configure AI Gateway credentials"
# ═══════════════════════════════════════════════════════════════
Note "The FortiAIScout needs an AI gateway URL and API key to call Claude."
Note "These are stored in the .env file in this folder."

if (-not (Test-Path ".env")) {
    Warn ".env file not found — creating from template (.env.tpl)"
    if (-not (Test-Path ".env.tpl")) { Fail ".env.tpl missing. Re-download the project." }
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

if (-not $envMap["ANTHROPIC_BASE_URL"]) {
    Write-Host ""
    Note "ANTHROPIC_BASE_URL — the base URL of your AI gateway (Portkey, Bifrost, LiteLLM, etc.)"
    Note "Example: https://api.portkey.ai/v1  or  https://gateway.example.com/anthropic"
    Ask "Enter ANTHROPIC_BASE_URL:"
    $val = Read-Host "     "
    if ($val) { Write-EnvKey "ANTHROPIC_BASE_URL" $val; $envMap["ANTHROPIC_BASE_URL"] = $val }
    else { Warn "Skipped — you can edit .env manually later." }
} else {
    Info "ANTHROPIC_BASE_URL already set: $($envMap['ANTHROPIC_BASE_URL'])"
}

if (-not $envMap["BIFROST_VIRTUAL_KEY"]) {
    Write-Host ""
    Note "BIFROST_VIRTUAL_KEY — your gateway virtual/API key (starts with sk-bf-... or similar)"
    Ask "Enter BIFROST_VIRTUAL_KEY:"
    $val = Read-Host "     "
    if ($val) { Write-EnvKey "BIFROST_VIRTUAL_KEY" $val }
    else { Warn "Skipped — you can edit .env manually later." }
} else {
    $preview = $envMap['BIFROST_VIRTUAL_KEY'].Substring(0, [Math]::Min(12,$envMap['BIFROST_VIRTUAL_KEY'].Length))
    Info "BIFROST_VIRTUAL_KEY already set: ${preview}..."
}

Write-Host ""
Note "To edit credentials manually later:"
Note "  UI:  Open .env in Notepad — double-click the file in Explorer"
Note "  CLI: notepad .env"

# ═══════════════════════════════════════════════════════════════
Step 3 "Set up Chrome extension config"
# ═══════════════════════════════════════════════════════════════
Note "The extension needs a config.json to know the agent server address."

if (-not (Test-Path "extension\config.json")) {
    if (Test-Path "extension\config.json.tpl") {
        Copy-Item "extension\config.json.tpl" "extension\config.json"
        Info "extension\config.json created from template."
    } else {
        Warn "extension\config.json.tpl not found — skipping. Re-download the project if missing."
    }
} else {
    Info "extension\config.json already exists."
}

# ═══════════════════════════════════════════════════════════════
Step 4 "FortiCNAPP — lacework CLI (optional)"
# ═══════════════════════════════════════════════════════════════
Note "The lacework CLI is needed for LQL queries, CVE scanning, and compliance reports."
Note "If you skip this, the AI chat and attack surface features still work."

$LwCliOk  = $false
$LwTomlOk = $false

try {
    $lwVer = & lacework version 2>&1 | Select-Object -First 1
    Info "lacework CLI already installed — $lwVer"
    $LwCliOk = $true
} catch {
    Warn "lacework CLI not found on PATH."
    Write-Host ""
    Note "HOW TO INSTALL (choose one):"
    Note "  CLI: winget install Lacework.LaceworkCLI"
    Note "       — or —"
    Note "  CLI: Download and run the installer manually:"
    Note "       https://github.com/lacework/go-sdk/releases/latest"
    Note "       File: lacework-cli-windows-amd64.exe"
    Note "  UI:  Run the .exe installer, follow the prompts, restart PowerShell"
    Write-Host ""
    Ask "Download and install the lacework CLI now? [y/N]"
    $installLw = Read-Host "     "
    if ($installLw -match '^[yY]') {
        Info "Downloading lacework CLI from GitHub releases..."
        try {
            $url  = "https://github.com/lacework/go-sdk/releases/latest/download/lacework-cli-windows-amd64.exe"
            $dest = "$env:LOCALAPPDATA\lacework\lacework.exe"
            New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\lacework" | Out-Null
            Invoke-WebRequest $url -OutFile $dest -UseBasicParsing
            $env:PATH += ";$env:LOCALAPPDATA\lacework"
            Info "Installed to: $dest"
            Warn "To make this permanent, add the folder to your PATH:"
            Note "  UI:  Start → 'Edit the system environment variables'"
            Note "       Environment Variables → System variables → Path → Edit → New"
            Note "       Add: $env:LOCALAPPDATA\lacework"
            Note "  CLI: [System.Environment]::SetEnvironmentVariable('PATH', `$env:PATH + ';$env:LOCALAPPDATA\lacework', 'User')"
            $LwCliOk = $true
        } catch {
            Warn "Download failed: $_"
            Note "Install manually from: https://github.com/lacework/go-sdk/releases"
        }
    } else {
        Note "Skipped. You can install it later and re-run .\setup.ps1"
    }
}

# ═══════════════════════════════════════════════════════════════
Step 5 "FortiCNAPP — configure credentials (optional)"
# ═══════════════════════════════════════════════════════════════
Note "Credentials are stored in ~\.lacework.toml and are needed for LQL, CVE, and compliance."

$TomlPath = "$env:USERPROFILE\.lacework.toml"
if ((Test-Path $TomlPath) -and (Select-String -Path $TomlPath -Pattern 'api_key' -Quiet)) {
    $acct = (Select-String -Path $TomlPath -Pattern 'account').Line -replace '.*=\s*"?([^"]+)"?.*','$1'
    Info "Credentials already configured (account: $acct)"
    $LwTomlOk = $true
} elseif ($LwCliOk) {
    Warn "No FortiCNAPP credentials found (~\.lacework.toml missing or incomplete)."
    Write-Host ""
    Note "HOW TO GET YOUR API CREDENTIALS:"
    Note "  UI:  Log into your FortiCNAPP console"
    Note "       Settings → API Keys → Create New Key"
    Note "       Copy the Key ID and Secret"
    Write-Host ""
    Note "HOW TO CONFIGURE:"
    Note "  CLI: lacework configure"
    Note "       (interactive — enter account name, Key ID, Secret when prompted)"
    Write-Host ""
    Ask "Run 'lacework configure' now to enter credentials interactively? [y/N]"
    $cfgLw = Read-Host "     "
    if ($cfgLw -match '^[yY]') {
        & lacework configure
        if ((Test-Path $TomlPath) -and (Select-String -Path $TomlPath -Pattern 'api_key' -Quiet)) {
            Info "Credentials saved to ~\.lacework.toml"
            $LwTomlOk = $true
        } else {
            Warn "Credentials not detected after configure — check the values and retry."
        }
    } else {
        Note "Skipped. Run 'lacework configure' any time to set up credentials."
    }
} else {
    Warn "lacework CLI not installed — skipping credentials setup."
    Note "Install the CLI first (Step 4), then re-run .\setup.ps1"
}

if (-not $LwCliOk -or -not $LwTomlOk) {
    Write-Host ""
    Warn "FortiCNAPP features (LQL, CVE, Compliance) will be unavailable until CLI + credentials are set up."
    Note "The AI Chat and Attack Surface Analyzer still work without them."
}

# ═══════════════════════════════════════════════════════════════
Step 6 "Install Python dependencies"
# ═══════════════════════════════════════════════════════════════
Note "Installing required Python packages (defusedxml for safe XML parsing)..."
& $PyCmd -m pip install --quiet -r requirements.txt
if ($LASTEXITCODE -ne 0) { Warn "pip install failed — server may not start correctly." }
else { Info "Dependencies installed." }

# ═══════════════════════════════════════════════════════════════
Step 7 "Start the AI Agent server"
# ═══════════════════════════════════════════════════════════════
Note "Starting serve.py on http://localhost:45321 ..."
Note "Logs: .\serve.log   Errors: .\serve.err"

$proc = Start-Process $PyCmd -ArgumentList "serve.py" `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput "serve.log" `
    -RedirectStandardError  "serve.err"
$proc.Id | Out-File ".serve.pid" -Encoding ascii

$ready = $false
Write-Host ""
Write-Host "     Waiting for server to start" -NoNewline
for ($i = 0; $i -lt 20; $i++) {
    try {
        $r = Invoke-WebRequest "http://localhost:45321/config" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { Write-Host " ready!" -ForegroundColor Green; $ready = $true; break }
    } catch {}
    Write-Host "." -NoNewline
    Start-Sleep 1
}

if (-not $ready) {
    Write-Host ""
    Warn "Server did not respond in 20 seconds."
    Note "Check .\serve.err for Python errors."
    Note "Common cause: missing or wrong values in .env"
}

# ═══════════════════════════════════════════════════════════════
Step 8 "Load the Chrome extension"
# ═══════════════════════════════════════════════════════════════
Note "The extension is a local folder — Chrome loads it in Developer mode."
Write-Host ""
Write-Host "     HOW TO LOAD THE EXTENSION:" -ForegroundColor Cyan
Note "  1. Open Chrome and go to:  chrome://extensions"
Note "  2. Enable 'Developer mode' (toggle in the top-right corner)"
Note "  3. Click 'Load unpacked'"
Note "  4. Select the 'extension' folder inside this project:"
Note "     $ScriptDir\extension"
Note "  5. The FortiAIScout icon will appear in your Chrome toolbar"
Note "  6. Pin it: click the puzzle piece icon → pin 'FortiAIScout'"

# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ══════════════════════════════════════════════" -ForegroundColor DarkGray
if ($ready) {
    Write-Host "  [OK] Setup complete — FortiAIScout is running!" -ForegroundColor Green
} else {
    Write-Host "  [!]  Setup complete with warnings — see above." -ForegroundColor Yellow
}
Write-Host "  ══════════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Server   ->  http://localhost:45321"
Write-Host "  Log      ->  $ScriptDir\serve.log"
Write-Host "  Errors   ->  $ScriptDir\serve.err"
$pid_ = Get-Content ".serve.pid" -ErrorAction SilentlyContinue
Write-Host "  Stop     ->  Stop-Process -Id $pid_"
Write-Host ""
Write-Host "  To restart the server later:" -ForegroundColor DarkGray
Write-Host "    $PyCmd serve.py" -ForegroundColor DarkGray
Write-Host ""
