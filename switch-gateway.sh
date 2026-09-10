#!/bin/bash
# Switch between Bifrost (remote Claude) and Ollama (local LLM)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY="${1:?Usage: $0 bifrost|ollama}"

case "$GATEWAY" in
  bifrost)
    cp "$SCRIPT_DIR/.env.bifrost" "$SCRIPT_DIR/.env"
    echo "✅ Switched to Bifrost (Claude models via https://bifrost.fabriclab.ca)"
    ;;
  ollama)
    cp "$SCRIPT_DIR/.env.ollama" "$SCRIPT_DIR/.env"
    echo "✅ Switched to Ollama (qwen2.5-coder:7b on http://localhost:11434)"
    echo "⚠️  Make sure Ollama is running: ollama serve"
    ;;
  *)
    echo "❌ Unknown gateway: $GATEWAY"
    echo "Usage: $0 bifrost|ollama"
    exit 1
    ;;
esac

if command -v docker &>/dev/null && docker ps 2>/dev/null | grep -q webai-serve; then
  echo "🔄 Restarting Docker container..."
  docker compose restart webai
else
  echo "💡 If using Docker: docker compose restart webai"
  echo "💡 If running locally: restart serve.py"
fi
