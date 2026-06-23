#!/usr/bin/env bash
# Bifrost Chat — setup script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}▶${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
error() { echo -e "${RED}✗${NC} $*"; exit 1; }

echo ""
echo "  ⚡ Bifrost Chat — Setup"
echo "  ────────────────────────"
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

# ── Step 2: extension config ──────────────────────────────────────────────
if [ ! -f extension/config.json ]; then
  cp extension/config.json.tpl extension/config.json
fi

# ── Step 3: Docker check + SearXNG (always) ───────────────────────────────
info "Checking Docker..."
if ! docker info >/dev/null 2>&1; then
  warn "Docker is not running — skipping SearXNG. Start Docker Desktop to enable web search."
  DOCKER_AVAILABLE=false
else
  DOCKER_AVAILABLE=true

  if [ ! -f searxng/settings.yml ]; then
    info "Generating SearXNG config..."
    mkdir -p searxng
    SECRET=$(openssl rand -hex 32)
    sed "s/<INSERT_RANDOM_SECRET_HERE>/${SECRET}/" searxng.settings.yml.tpl > searxng/settings.yml
    info "searxng/settings.yml created"
  else
    info "searxng/settings.yml already exists — skipping"
  fi

  info "Starting SearXNG..."
  docker compose up -d searxng

  echo -n "  Waiting for SearXNG"
  for i in $(seq 1 15); do
    if curl -s "http://localhost:8080/search?q=test&format=json" >/dev/null 2>&1; then
      echo " ✓"
      break
    fi
    echo -n "."
    sleep 1
  done
  info "SearXNG running at http://localhost:8080"
fi

# ── Step 4: serve.py (Docker or Python) ──────────────────────────────────
if [ "$DOCKER_AVAILABLE" = true ]; then
  echo ""
  echo "  How do you want to run Bifrost?"
  echo ""
  echo "  [1] Docker  — All services in containers (recommended)"
  echo "  [2] Python  — serve.py locally (requires Python 3)"
  echo ""
  read -rp "  Enter 1 or 2 [default: 1]: " choice
  choice="${choice:-1}"
else
  choice="2"
fi

case "$choice" in
  1)
    info "Building and starting all containers..."
    docker compose up -d --build

    echo -n "  Waiting for Bifrost"
    for i in $(seq 1 20); do
      if curl -s "http://localhost:8765/config" >/dev/null 2>&1; then
        echo " ✓"
        break
      fi
      echo -n "."
      sleep 1
    done
    ;;

  2)
    if ! command -v lacework >/dev/null 2>&1; then
      warn "lacework CLI not found — CodeSec and SBOM scanning will be unavailable."
      warn "Install: curl -sL https://raw.githubusercontent.com/lacework/go-sdk/main/cli/install.sh | bash"
    else
      info "lacework CLI found — CodeSec and SBOM scanning enabled."
    fi

    info "Starting serve.py..."
    python3 serve.py &
    sleep 1
    ;;

  *)
    error "Invalid choice. Run setup.sh again and enter 1 or 2."
    ;;
esac

echo ""
echo "  Chatbox  →  http://localhost:8765"
echo "  Search   →  http://localhost:8080"
echo "  CodeSec  →  POST http://localhost:8765/codesec"
echo "  SBOM     →  POST http://localhost:8765/sbom"
echo ""
echo "  Load the extension: chrome://extensions → Enable Developer mode → Load unpacked → select extension/"
echo ""
