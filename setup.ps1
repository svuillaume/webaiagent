# Bifrost Chat — Windows Setup Script (PowerShell)
# Run with: .\setup.ps1
# Requires PowerShell 5.1+ (built into Windows 10/11)

$ErrorActionPreference = 'Stop'

function Info  { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn  { param($msg) Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Fail  { param($msg) Write-Host "  [X] $msg"  -ForegroundColor Red; exit 1 }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "  ⚡ Bifrost Chat — Setup (Windows)" -ForegroundColor Cyan
Write-Host "  ───────────────────────────────────" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: .env ──────────────────────────────────────────────────────────
if (-not (Test-Path ".env")) {
    Warn ".env not found — creating from template"
    Copy-Item ".env.tpl" ".env"
    Write-Host ""
    Write-Host "  Edit .env and set your values:" -ForegroundColor Yellow
    Write-Host "    ANTHROPIC_BASE_URL  = your Bifrost endpoint"
    Write-Host "    BIFROST_VIRTUAL_KEY = your sk-bf-... key"
    Write-Host ""
    notepad.exe ".env" | Out-Null
    Read-Host "  Press Enter once you've saved .env"
}

# ── Step 2: extension config ──────────────────────────────────────────────
if (-not (Test-Path "extension\config.json")) {
    Copy-Item "extension\config.json.tpl" "extension\config.json"
}

# ── Step 3: Docker check + SearXNG (always) ───────────────────────────────
$DockerAvailable = $false
try {
    docker info 2>&1 | Out-Null
    $DockerAvailable = $true
    Info "Docker found"
} catch {
    Warn "Docker is not running — skipping SearXNG. Start Docker Desktop to enable web search."
}

if ($DockerAvailable) {
    if (-not (Test-Path "searxng\settings.yml")) {
        Info "Generating SearXNG config..."
        New-Item -ItemType Directory -Force -Path "searxng" | Out-Null
        $secret = -join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
        (Get-Content "searxng.settings.yml.tpl") -replace "REPLACE_WITH_RANDOM_SECRET", $secret |
            Set-Content "searxng\settings.yml"
        Info "searxng\settings.yml created"
    } else {
        Info "searxng\settings.yml already exists — skipping"
    }

    Info "Starting SearXNG..."
    docker compose up -d searxng

    Write-Host "  Waiting for SearXNG" -NoNewline
    for ($i = 0; $i -lt 15; $i++) {
        try {
            $r = Invoke-WebRequest "http://localhost:8080/search?q=test&format=json" -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -eq 200) { Write-Host " OK"; break }
        } catch {}
        Write-Host "." -NoNewline
        Start-Sleep 1
    }
    Info "SearXNG running at http://localhost:8080"
}

# ── Step 4: serve.py (Docker or Python) ──────────────────────────────────
if ($DockerAvailable) {
    Write-Host ""
    Write-Host "  How do you want to run Bifrost?"
    Write-Host ""
    Write-Host "  [1] Docker  — All services in containers (recommended)"
    Write-Host "  [2] Python  — serve.py locally (requires Python 3)"
    Write-Host ""
    $choice = Read-Host "  Enter 1 or 2 [default: 1]"
    if (-not $choice) { $choice = "1" }
} else {
    $choice = "2"
}

switch ($choice) {
    "1" {
        Info "Building and starting all containers..."
        docker compose up -d --build

        Write-Host "  Waiting for Bifrost" -NoNewline
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
Write-Host "  Search   ->  http://localhost:8080"
Write-Host "  CodeSec  ->  POST http://localhost:8765/codesec"
Write-Host "  SBOM     ->  POST http://localhost:8765/sbom"
Write-Host ""
Write-Host "  Load the extension: chrome://extensions -> Enable Developer mode -> Load unpacked -> select extension/" -ForegroundColor Cyan
Write-Host ""
