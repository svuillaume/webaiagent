# Web AI Agent — Windows Setup Script (PowerShell)
# Run with: .\setup.ps1
# Requires PowerShell 5.1+ (built into Windows 10/11)

$ErrorActionPreference = 'Stop'

function Info  { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn  { param($msg) Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Fail  { param($msg) Write-Host "  [X] $msg"  -ForegroundColor Red; exit 1 }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "  🌐 Web AI Agent — Setup (Windows)" -ForegroundColor Cyan
Write-Host "  ───────────────────────────────────" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: .env ──────────────────────────────────────────────────────────
if (-not (Test-Path ".env")) {
    Warn ".env not found — creating from template"
    Copy-Item ".env.tpl" ".env"
    Write-Host ""
    Write-Host "  Edit .env and set your values:" -ForegroundColor Yellow
    Write-Host "    ANTHROPIC_BASE_URL  = your gateway endpoint"
    Write-Host "    BIFROST_VIRTUAL_KEY = your sk-bf-... key"
    Write-Host ""
    notepad.exe ".env" | Out-Null
    Read-Host "  Press Enter once you've saved .env"
}

# ── Step 2: extension config ──────────────────────────────────────────────
if (-not (Test-Path "extension\config.json")) {
    Copy-Item "extension\config.json.tpl" "extension\config.json"
}

# ── Step 3: start Web AI Agent ────────────────────────────────────────────
$DockerAvailable = $false
try {
    docker info 2>&1 | Out-Null
    $DockerAvailable = $true
    Info "Docker found"
} catch {
    Warn "Docker is not running — will use Python directly."
}

if ($DockerAvailable) {
    Write-Host ""
    Write-Host "  How do you want to run Web AI Agent?"
    Write-Host ""
    Write-Host "  [1] Docker  — container (recommended)"
    Write-Host "  [2] Python  — serve.py locally (requires Python 3)"
    Write-Host ""
    $choice = Read-Host "  Enter 1 or 2 [default: 1]"
    if (-not $choice) { $choice = "1" }
} else {
    $choice = "2"
}

switch ($choice) {
    "1" {
        Info "Building and starting Web AI Agent container..."
        docker compose up -d --build webai

        Write-Host "  Waiting for Web AI Agent" -NoNewline
        for ($i = 0; $i -lt 20; $i++) {
            try {
                $r = Invoke-WebRequest "http://localhost:8765/config" -UseBasicParsing -TimeoutSec 2
                if ($r.StatusCode -eq 200) { Write-Host " OK"; break }
            } catch {}
            Write-Host "." -NoNewline
            Start-Sleep 1
        }
    }

    "2" {
        try { python --version 2>&1 | Out-Null } catch { Fail "Python not found. Install from https://python.org" }
        Info "Starting serve.py..."
        Start-Process python -ArgumentList "serve.py" -NoNewWindow
        Start-Sleep 1
    }

    default {
        Fail "Invalid choice. Run setup.ps1 again and enter 1 or 2."
    }
}

Write-Host ""
Write-Host "  Chatbox  ->  http://localhost:8765"
Write-Host "  CodeSec  ->  POST http://localhost:8765/codesec"
Write-Host "  SBOM     ->  POST http://localhost:8765/sbom"
Write-Host ""
Write-Host "  Load the extension: chrome://extensions -> Enable Developer mode -> Load unpacked -> select extension/" -ForegroundColor Cyan
Write-Host ""
