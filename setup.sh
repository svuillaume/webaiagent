#!/usr/bin/env bash
# Web AI Agent — setup script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${GREEN}▶${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✗${NC} $*"; exit 1; }
prompt()  { echo -e "${CYAN}?${NC}  $*"; }

echo ""
echo "  🌐 Web AI Agent — Setup"
echo "  ──────────────────────────"
echo ""

# ── Step 1: .env — read or create ────────────────────────────────────────────
load_env() {
  if [ -f .env ]; then
    # shellcheck disable=SC2046
    export $(grep -v '^\s*#' .env | grep '=' | xargs) 2>/dev/null || true
  fi
}

write_env_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    # Update existing line
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
  else
    echo "${key}=${value}" >> .env
  fi
}

if [ ! -f .env ]; then
  warn ".env not found — creating from template"
  cp .env.tpl .env
fi
load_env

# Ask for missing required values
if [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
  prompt "Enter your AI Gateway base URL (e.g. https://bifrost.yourhost.com/anthropic):"
  read -rp "  ANTHROPIC_BASE_URL: " val
  [ -n "$val" ] && write_env_key "ANTHROPIC_BASE_URL" "$val" && ANTHROPIC_BASE_URL="$val"
else
  info "ANTHROPIC_BASE_URL detected: ${ANTHROPIC_BASE_URL}"
fi

if [ -z "${BIFROST_VIRTUAL_KEY:-}" ]; then
  prompt "Enter your virtual key (sk-bf-…):"
  read -rp "  BIFROST_VIRTUAL_KEY: " val
  [ -n "$val" ] && write_env_key "BIFROST_VIRTUAL_KEY" "$val" && BIFROST_VIRTUAL_KEY="$val"
else
  info "BIFROST_VIRTUAL_KEY detected: ${BIFROST_VIRTUAL_KEY:0:12}…"
fi

# ── Step 2: extension config ──────────────────────────────────────────────────
if [ ! -f extension/config.json ]; then
  cp extension/config.json.tpl extension/config.json
fi

# ── Step 3: port 8080 check ───────────────────────────────────────────────────
echo ""
info "Checking port 8080 (SearXNG)..."

PORT_PIDS=""
if command -v lsof >/dev/null 2>&1; then
  PORT_PIDS=$(lsof -ti:8080 2>/dev/null || true)
elif command -v ss >/dev/null 2>&1; then
  PORT_PIDS=$(ss -lptn 'sport = :8080' 2>/dev/null | awk '/pid=/{gsub(/.*pid=/,""); gsub(/,.*/,""); print}' || true)
fi

if [ -n "$PORT_PIDS" ]; then
  warn "Port 8080 is already in use (PID: $PORT_PIDS)"
  prompt "Kill the process occupying port 8080? [y/N]"
  read -rp "  > " kill_choice
  if [[ "${kill_choice,,}" == "y" ]]; then
    # Try Docker container first (graceful), then pkill
    DOCKER_CONTAINER=$(docker ps --filter "publish=8080" --format "{{.Names}}" 2>/dev/null | head -1 || true)
    if [ -n "$DOCKER_CONTAINER" ]; then
      info "Stopping Docker container $DOCKER_CONTAINER on port 8080..."
      docker stop "$DOCKER_CONTAINER" >/dev/null
    else
      info "Killing PID(s): $PORT_PIDS"
      echo "$PORT_PIDS" | xargs kill -9 2>/dev/null || true
    fi
    sleep 1
    info "Port 8080 freed"
  else
    warn "Leaving port 8080 occupied — SearXNG may fail to start"
  fi
else
  info "Port 8080 is free"
fi

# ── Step 4: start SearXNG ─────────────────────────────────────────────────────
echo ""
info "Checking Docker runtime..."
DOCKER_AVAILABLE=false

if docker info >/dev/null 2>&1; then
  DOCKER_AVAILABLE=true
  info "Docker is running"

  # Generate SearXNG config if missing
  if [ ! -f searxng/settings.yml ]; then
    info "Generating SearXNG config with random secret..."
    mkdir -p searxng
    SECRET=$(openssl rand -hex 32)
    sed "s/<INSERT_RANDOM_SECRET_HERE>/${SECRET}/" searxng.settings.yml.tpl > searxng/settings.yml
    info "searxng/settings.yml created"
  fi

  # Ensure SEARXNG_URL points to Docker service name
  write_env_key "SEARXNG_URL" "http://searxng:8080"

  info "Starting SearXNG container..."
  docker compose up -d searxng

  echo -n "  Waiting for SearXNG"
  for i in $(seq 1 20); do
    if curl -s "http://localhost:8080/search?q=test&format=json" >/dev/null 2>&1; then
      echo " ✓"
      break
    fi
    echo -n "."
    sleep 1
  done

else
  warn "Docker is not running — falling back to Python venv"

  # Python venv fallback: SearXNG via pip (searxng package or searx)
  if ! command -v python3 >/dev/null 2>&1; then
    error "Python 3 not found. Install Python 3 or start Docker Desktop."
  fi

  VENV_DIR="$SCRIPT_DIR/.venv"
  if [ ! -d "$VENV_DIR" ]; then
    info "Creating Python venv at .venv..."
    python3 -m venv "$VENV_DIR"
  fi

  # Ensure SEARXNG_URL points to localhost for native run
  write_env_key "SEARXNG_URL" "http://localhost:8080"

  info "Starting serve.py via Python venv..."
  "$VENV_DIR/bin/python3" serve.py &
  sleep 1
fi

# ── Step 5: start Bifrost serve.py ───────────────────────────────────────────
echo ""
if [ "$DOCKER_AVAILABLE" = true ]; then
  info "Building and starting Bifrost container..."
  docker compose up -d --build bifrost

  echo -n "  Waiting for Bifrost"
  for i in $(seq 1 20); do
    if curl -s "http://localhost:8765/config" >/dev/null 2>&1; then
      echo " ✓"
      break
    fi
    echo -n "."
    sleep 1
  done
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}✔ Web search tool ready!${NC}"
echo ""
echo "  Chatbox  →  http://localhost:8765"
echo "  Search   →  http://localhost:8080"
echo ""
echo "  Load the extension:"
echo "    chrome://extensions → Developer mode → Load unpacked → select extension/"
echo ""
