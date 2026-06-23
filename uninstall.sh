#!/usr/bin/env bash
# Web AI Agent — stop and clean up

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}▶${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }

echo ""
echo "  🛑 Web AI Agent — Uninstall"
echo "  ──────────────────────"
echo ""

# ── Stop and remove containers ────────────────────────────────────────────────
if docker info >/dev/null 2>&1; then
  info "Stopping containers..."
  docker compose down --remove-orphans

  # Kill anything still holding port 8765
  for PORT in 8765; do
    PIDS=$(lsof -ti:$PORT 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      warn "Port $PORT still in use (PID $PIDS) — killing..."
      echo "$PIDS" | xargs kill -9 2>/dev/null || true
    fi
  done

  # Remove dangling images
  DANGLING=$(docker images -f "dangling=true" -q 2>/dev/null || true)
  if [ -n "$DANGLING" ]; then
    info "Removing dangling images..."
    echo "$DANGLING" | xargs docker rmi 2>/dev/null || true
  fi

  # Remove unused volumes
  docker volume prune -f >/dev/null 2>&1 && info "Unused volumes pruned"

else
  warn "Docker not running — checking for stray serve.py process..."
  PIDS=$(lsof -ti:8765 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    info "Killing serve.py (PID $PIDS)..."
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
  fi
fi

# ── Remove temp/generated files ───────────────────────────────────────────────
if [ -f extension/config.json ]; then
  info "Removing extension/config.json..."
  rm -f extension/config.json
fi

echo ""
echo -e "  ${GREEN}✔ All stopped and cleaned up${NC}"
echo ""
echo "  To fully remove the Chrome extension:"
echo "    1. Open chrome://extensions in your browser"
echo "    2. Find 'Web AI Agent' and click Remove"
echo ""
