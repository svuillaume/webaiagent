#!/usr/bin/env bash
# Bifrost Chat — setup script
# Asks whether to run web search via Docker (SearXNG) or Python venv (serve.py proxy)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}▶${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
error() { echo -e "${RED}✗${NC} $*"; exit 1; }

echo ""
echo "  ⚡ Bifrost Chat — Search Backend Setup"
echo "  ──────────────────────────────────────"
echo ""

# ── Step 1: .env ─────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  warn ".env not found — creating from template"
  cp .env.tpl .env
  echo ""
  echo "  Edit .env and set your values:"
  echo "    ANTHROPIC_BASE_URL   = your Bifrost endpoint"
  echo "    BIFROST_VIRTUAL_KEY  = your sk-bf-… key"
  echo ""
  read -rp "  Press Enter once you've edited .env, or Ctrl+C to quit: "
fi

# ── Step 2: config.json (auto-generated from .env — no manual edit needed) ──
if [ ! -f extension/config.json ]; then
  cp extension/config.json.tpl extension/config.json
fi

# ── Step 3: choose backend ────────────────────────────────────────────────
echo ""
echo "  How do you want to run Bifrost?"
echo ""
echo "  [1] Docker  — All services in containers (SearXNG + Bifrost + CodeSec)"
echo "               Requires Docker Desktop. Includes lacework SCA/SAST scanning."
echo ""
echo "  [2] Python  — serve.py in a local venv + SearXNG in Docker"
echo "               Lighter weight. CodeSec requires lacework CLI installed locally."
echo ""
read -rp "  Enter 1 or 2: " choice

case "$choice" in
  1)
    # ── Full Docker path ──────────────────────────────────────────────────
    info "Checking Docker..."
    docker info >/dev/null 2>&1 || error "Docker is not running. Start Docker Desktop and try again."

    if [ ! -f searxng/settings.yml ]; then
      info "Generating SearXNG config..."
      mkdir -p searxng
      SECRET=$(openssl rand -hex 32)
      sed "s/<INSERT_RANDOM_SECRET_HERE>/${SECRET}/" searxng.settings.yml.tpl > searxng/settings.yml
      info "searxng/settings.yml created"
    else
      info "searxng/settings.yml already exists — skipping"
    fi

    info "Building and starting all containers (first build may take a few minutes)..."
    docker compose up -d --build

    # wait up to 20s for bifrost to be ready
    echo -n "  Waiting for Bifrost"
    for i in $(seq 1 20); do
      if curl -s "http://localhost:8765/config" >/dev/null 2>&1; then
        echo " ✓"
        break
      fi
      echo -n "."
      sleep 1
    done

    info "All services running"
    echo ""
    echo "  Chatbox  →  http://localhost:8765"
    echo "  Search   →  http://localhost:8080"
    echo "  CodeSec  →  POST http://localhost:8765/codesec"
    echo "  SBOM     →  POST http://localhost:8765/sbom"
    echo ""
    echo "  To stop: docker compose down"
    ;;

  2)
    # ── Python venv + Docker SearXNG path ────────────────────────────────
    info "Checking Docker for SearXNG..."
    docker info >/dev/null 2>&1 || error "Docker is not running. Start Docker Desktop and try again."

    if [ ! -f searxng/settings.yml ]; then
      info "Generating SearXNG config..."
      mkdir -p searxng
      SECRET=$(openssl rand -hex 32)
      sed "s/<INSERT_RANDOM_SECRET_HERE>/${SECRET}/" searxng.settings.yml.tpl > searxng/settings.yml
      info "searxng/settings.yml created"
    else
      info "searxng/settings.yml already exists — skipping"
    fi

    info "Starting SearXNG container..."
    docker compose up -d searxng

    # wait up to 10s for SearXNG
    echo -n "  Waiting for SearXNG"
    for i in $(seq 1 10); do
      if curl -s "http://localhost:8080/search?q=test&format=json" >/dev/null 2>&1; then
        echo " ✓"
        break
      fi
      echo -n "."
      sleep 1
    done

    info "Setting up Python venv..."
    python3 -m venv .venv
    # shellcheck disable=SC1091
    source .venv/bin/activate

    if ! command -v lacework >/dev/null 2>&1; then
      warn "lacework CLI not found — CodeSec and SBOM scanning will be unavailable."
      warn "Install it with: curl -sL https://raw.githubusercontent.com/lacework/go-sdk/main/cli/install.sh | bash"
    else
      info "lacework CLI found — CodeSec and SBOM scanning enabled."
    fi

    info "Starting serve.py..."
    echo ""
    echo "  Chatbox  →  http://localhost:8765"
    echo "  Search   →  http://localhost:8080"
    echo "  CodeSec  →  POST http://localhost:8765/codesec"
    echo "  SBOM     →  POST http://localhost:8765/sbom"
    echo ""
    echo "  Press Ctrl+C to stop."
    echo ""
    python3 serve.py
    ;;

  *)
    error "Invalid choice. Run setup.sh again and enter 1 or 2."
    ;;
esac
