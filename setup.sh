#!/usr/bin/env bash
# Web AI Agent — setup script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()   { echo -e "${GREEN}▶${NC} $*"; }
warn()   { echo -e "${YELLOW}⚠${NC}  $*"; }
error()  { echo -e "${RED}✗${NC} $*"; exit 1; }
prompt() { echo -e "${CYAN}?${NC}  $*"; }

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

if [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
  prompt "Enter your AI Gateway base URL (e.g. https://your-gateway.example.com/anthropic):"
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

# ── Step 2b: lacework CLI + credentials check ────────────────────────────────
echo ""
info "Checking FortiCNAPP / lacework prerequisites..."

LW_CLI_OK=false
LW_TOML_OK=false

if command -v lacework >/dev/null 2>&1; then
  info "lacework CLI found ($(lacework version 2>/dev/null | head -1))"
  LW_CLI_OK=true
else
  warn "lacework CLI not found — CodeSec and SBOM scanning will be unavailable."
  echo "    Install it with:"
  echo "      curl -sL https://raw.githubusercontent.com/lacework/go-sdk/main/cli/install.sh | bash"
  echo "    Then run:  lacework configure"
fi

TOML="${HOME}/.lacework.toml"
if [ -f "$TOML" ] && grep -q 'api_key' "$TOML" && grep -q 'api_secret' "$TOML"; then
  ACCOUNT=$(grep 'account' "$TOML" | head -1 | cut -d= -f2 | tr -d ' "')
  info "lacework credentials found (~/.lacework.toml, account: ${ACCOUNT})"
  LW_TOML_OK=true
else
  warn "~/.lacework.toml not found or incomplete — LQL, CVE, and Compliance will be unavailable."
  echo "    Run:  lacework configure"
  echo "    (You need your FortiCNAPP account name + API key/secret)"
fi

if [ "$LW_CLI_OK" = false ] && [ "$LW_TOML_OK" = false ]; then
  echo ""
  warn "No FortiCNAPP integration available. Web AI Agent will run in chat-only mode."
fi

# ── Step 3: start Web AI Agent ────────────────────────────────────────────────
echo ""
info "Checking Docker runtime..."

if docker info >/dev/null 2>&1; then
  info "Docker is running — building and starting Web AI Agent container..."
  docker compose up -d --build webai

  echo -n "  Waiting for Web AI Agent"
  for i in $(seq 1 20); do
    if curl -s "http://localhost:8765/config" >/dev/null 2>&1; then
      echo " ✓"
      break
    fi
    echo -n "."
    sleep 1
  done
else
  warn "Docker is not running — falling back to Python"
  if ! command -v python3 >/dev/null 2>&1; then
    error "Python 3 not found. Install Python 3 or start Docker Desktop."
  fi
  info "Starting serve.py..."
  python3 serve.py &
  sleep 1
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}✔ Web AI Agent ready!${NC}"
echo ""
echo "  Chatbox  →  http://localhost:8765"
echo ""
echo "  Load the extension:"
echo "    chrome://extensions → Developer mode → Load unpacked → select extension/"
echo ""
