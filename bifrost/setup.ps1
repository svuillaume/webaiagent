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
Write-Host "  ⚡ Bifrost Chat — Search Backend Setup (Windows)" -ForegroundColor Cyan
Write-Host "  ─────────────────────────────────────────────────" -ForegroundColor Cyan
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

# ── Step 2: config.json ───────────────────────────────────────────────────
if (-not (Test-Path "extension\config.json")) {
    Warn "extension\config.json not found — creating from template"
    Copy-Item "extension\config.json.tpl" "extension\config.json"
    Write-Host ""
    Write-Host "  Edit extension\config.json and set:" -ForegroundColor Yellow
    Write-Host "    bifrost_url = your Bifrost endpoint"
    Write-Host "    api_key     = your sk-bf-... key"
    Write-Host ""
    notepad.exe "extension\config.json" | Out-Null
    Read-Host "  Press Enter once done"
}

# ── Step 3: choose backend ────────────────────────────────────────────────
Write-Host ""
Write-Host "  How do you want to run web search?"
Write-Host ""
Write-Host "  [1] Docker  — SearXNG container on localhost:8080"
Write-Host "               Requires Docker Desktop for Windows."
Write-Host ""
Write-Host "  [2] Python  — serve.py venv proxy on localhost:8765"
Write-Host "               No Docker needed. Uses Python 3."
Write-Host ""
$choice = Read-Host "  Enter 1 or 2"

switch ($choice) {
    "1" {
        # ── Docker path ───────────────────────────────────────────────────
        Info "Checking Docker..."
        try { docker info 2>&1 | Out-Null } catch { Fail "Docker is not running. Start Docker Desktop and try again." }

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

        Info "Starting SearXNG container..."
        docker compose up -d

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
        Write-Host ""
        Write-Host "  Extension search URL : http://localhost:8080"
        Write-Host "  To stop              : docker compose down"
    }

    "2" {
        # ── Python venv path ──────────────────────────────────────────────
        Info "Checking Python..."
        try { python --version 2>&1 | Out-Null } catch { Fail "Python not found. Install from https://python.org" }

        Info "Setting up Python venv..."
        python -m venv .venv
        .\.venv\Scripts\Activate.ps1

        Info "Starting serve.py search proxy..."
        Write-Host ""
        Write-Host "  serve.py running at  : http://localhost:8765"
        Write-Host "  Search endpoint      : http://localhost:8765/search?q=..."
        Write-Host "  Press Ctrl+C to stop."
        Write-Host ""
        python serve.py
    }

    default {
        Fail "Invalid choice. Run setup.ps1 again and enter 1 or 2."
    }
}
