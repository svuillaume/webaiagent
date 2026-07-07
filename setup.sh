#!/usr/bin/env bash
# FortiAIScout — setup script (macOS / Linux)
# Runs serve.py directly — no Docker required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()   { echo -e "${GREEN}▶${NC} $*"; }
warn()   { echo -e "${YELLOW}⚠${NC}  $*"; }
error()  { echo -e "${RED}✗${NC} $*"; exit 1; }
ask()    { echo -e "${CYAN}?${NC}  $*"; }

echo ""
echo "  🌐 FortiAIScout — Setup"
echo "  ──────────────────────────"
echo ""

# ── Python check ──────────────────────────────────────────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
  error "Python 3 not found. Install it from https://python.org and re-run this script."
fi
info "Python $(python3 --version 2>&1 | cut -d' ' -f2) found"

# ── Step 1: .env ──────────────────────────────────────────────────────────────
write_env_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
  else
    echo "${key}=${value}" >> .env
  fi
}

load_env() {
  if [ -f .env ]; then
    # shellcheck disable=SC2046
    export $(grep -v '^\s*#' .env | grep '=' | xargs) 2>/dev/null || true
  fi
}

if [ ! -f .env ]; then
  warn ".env not found — creating from template"
  cp .env.tpl .env
fi
load_env

echo ""
if [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
  ask "AI Gateway base URL (e.g. https://your-gateway.example.com/anthropic):"
  read -rp "  ANTHROPIC_BASE_URL: " val
  [ -n "$val" ] && write_env_key "ANTHROPIC_BASE_URL" "$val" && ANTHROPIC_BASE_URL="$val"
else
  info "ANTHROPIC_BASE_URL: ${ANTHROPIC_BASE_URL}"
fi

if [ -z "${BIFROST_VIRTUAL_KEY:-}" ]; then
  ask "Gateway virtual key (sk-bf-…):"
  read -rp "  BIFROST_VIRTUAL_KEY: " val
  [ -n "$val" ] && write_env_key "BIFROST_VIRTUAL_KEY" "$val" && BIFROST_VIRTUAL_KEY="$val"
else
  info "BIFROST_VIRTUAL_KEY: ${BIFROST_VIRTUAL_KEY:0:12}…"
fi

# ── Step 2: extension offline config ──────────────────────────────────────────
if [ ! -f extension/config.json ]; then
  cp extension/config.json.tpl extension/config.json
fi

# ── Step 3: lacework CLI ───────────────────────────────────────────────────────
echo ""
info "Checking FortiCNAPP prerequisites..."

LW_CLI_OK=false
LW_TOML_OK=false

if command -v lacework >/dev/null 2>&1; then
  info "lacework CLI found — $(lacework version 2>/dev/null | head -1)"
  LW_CLI_OK=true
else
  warn "lacework CLI not found — CodeSec and SBOM scanning will be unavailable."
  echo ""
  ask "Install the lacework CLI now? [y/N]"
  read -rp "  " install_lw
  if [[ "${install_lw,,}" == "y" ]]; then
    info "Installing lacework CLI..."
    curl -sL https://raw.githubusercontent.com/lacework/go-sdk/main/cli/install.sh | bash
    if command -v lacework >/dev/null 2>&1; then
      info "lacework CLI installed — $(lacework version 2>/dev/null | head -1)"
      LW_CLI_OK=true
    else
      warn "Install failed. Add lacework to your PATH and re-run, or install manually:"
      echo "    https://docs.lacework.net/cli"
    fi
  fi
fi

# ── Step 4: lacework credentials ──────────────────────────────────────────────
TOML="${HOME}/.lacework.toml"
if [ -f "$TOML" ] && grep -q 'api_key' "$TOML" && grep -q 'api_secret' "$TOML"; then
  ACCOUNT=$(grep 'account' "$TOML" | head -1 | cut -d= -f2 | tr -d ' "')
  info "FortiCNAPP credentials found (account: ${ACCOUNT})"
  LW_TOML_OK=true
else
  warn "~/.lacework.toml not found or incomplete — LQL, CVE, and Compliance will be unavailable."
  if [ "$LW_CLI_OK" = true ]; then
    echo ""
    ask "Configure FortiCNAPP credentials now? [y/N]"
    read -rp "  " cfg_lw
    if [[ "${cfg_lw,,}" == "y" ]]; then
      lacework configure
      if [ -f "$TOML" ] && grep -q 'api_key' "$TOML"; then
        info "Credentials saved to ~/.lacework.toml"
        LW_TOML_OK=true
      fi
    fi
  else
    echo "    Once the CLI is installed, run:  lacework configure"
  fi
fi

if [ "$LW_CLI_OK" = false ] && [ "$LW_TOML_OK" = false ]; then
  echo ""
  warn "Running in chat-only mode — FortiCNAPP security tools unavailable."
fi

# ── Step 5: start serve.py ─────────────────────────────────────────────────────
echo ""
if lsof -ti:45321 >/dev/null 2>&1; then
  info "FortiAIScout is already running on port 45321 — leaving it as is."
else
  info "Starting FortiAIScout (python3 serve.py)..."
  nohup python3 serve.py > serve.log 2>&1 &
  echo $! > .serve.pid

  echo -n "  Waiting for server"
  READY=false
  for i in $(seq 1 20); do
    if ! kill -0 "$(cat .serve.pid)" 2>/dev/null; then
      echo " ✗"
      error "serve.py exited immediately — check serve.log:\n$(tail -5 serve.log)"
    fi
    if curl -s "http://localhost:45321/config" >/dev/null 2>&1; then
      echo " ✓"
      READY=true
      break
    fi
    echo -n "."
    sleep 1
  done
  [ "$READY" = true ] || error "Server did not come up in time — check serve.log"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}✔ FortiAIScout ready!${NC}"
echo ""
echo "  Chatbox  →  http://localhost:45321"
echo "  Log      →  ./serve.log   (tail -f serve.log)"
echo "  Stop     →  kill \$(cat .serve.pid)"
echo ""
echo "  Load the Chrome extension:"
echo "    chrome://extensions → Developer mode → Load unpacked → select extension/"
echo ""
