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

# ── Step 2: config.json ───────────────────────────────────────────────────
if [ ! -f extension/config.json ]; then
  warn "extension/config.json not found — creating from template"
  cp extension/config.json.tpl extension/config.json
  echo ""
  echo "  Edit extension/config.json and set:"
  echo "    bifrost_url  = your Bifrost endpoint"
  echo "    api_key      = your sk-bf-… key"
  echo ""
  read -rp "  Press Enter once done: "
fi

# ── Step 3: choose backend ────────────────────────────────────────────────
echo ""
echo "  How do you want to run web search?"
echo ""
echo "  [1] Docker  — SearXNG container on localhost:8080"
echo "               Requires Docker Desktop. Fast, self-contained."
echo ""
echo "  [2] Python  — serve.py venv proxy on localhost:8765"
echo "               No Docker needed. Uses your Python venv."
echo ""
read -rp "  Enter 1 or 2: " choice

case "$choice" in
  1)
    # ── Docker path ───────────────────────────────────────────────────────
    info "Checking Docker..."
    docker info >/dev/null 2>&1 || error "Docker is not running. Start Docker Desktop and try again."

    if [ ! -f searxng/settings.yml ]; then
      info "Generating SearXNG config..."
      mkdir -p searxng
      SECRET=$(openssl rand -hex 32)
      sed "s/REPLACE_WITH_RANDOM_SECRET/${SECRET}/" searxng.settings.yml.tpl > searxng/settings.yml
      info "searxng/settings.yml created"
    else
      info "searxng/settings.yml already exists — skipping"
    fi

    info "Starting SearXNG container..."
    docker compose up -d

    # wait up to 10s for it to be ready
    echo -n "  Waiting for SearXNG"
    for i in $(seq 1 10); do
      if curl -s "http://localhost:8080/search?q=test&format=json" >/dev/null 2>&1; then
        echo " ✓"
        break
      fi
      echo -n "."
      sleep 1
    done

    info "SearXNG running at http://localhost:8080"
    echo ""
    echo "  Extension search URL: http://localhost:8080"
    echo "  To stop: docker compose down"
    ;;

  2)
    # ── Python venv path ──────────────────────────────────────────────────
    info "Setting up Python venv..."
    python3 -m venv .venv
    # shellcheck disable=SC1091
    source .venv/bin/activate

    info "Starting serve.py search proxy..."
    echo ""
    echo "  serve.py will run on http://localhost:8765"
    echo "  Search endpoint: http://localhost:8765/search?q=..."
    echo "  It proxies to: ${SEARXNG_URL:-http://localhost:8080} (set SEARXNG_URL in .env to override)"
    echo ""
    echo "  Press Ctrl+C to stop."
    echo ""
    python3 serve.py
    ;;

  *)
    error "Invalid choice. Run setup.sh again and enter 1 or 2."
    ;;
esac
