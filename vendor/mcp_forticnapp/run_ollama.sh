#!/usr/bin/env bash
# Builds and runs vendor/mcp_forticnapp + mcphost in a container, driven by a
# local Ollama model instead of Claude. FortiCNAPP credentials are read from
# ~/.lacework.toml on the host (mounted read-only) at container start.
#
# Usage:
#   ./run_ollama.sh                          # defaults: qwen2.5:7b-instruct, http://host.docker.internal:11434
#   OLLAMA_MODEL=qwen3:8b ./run_ollama.sh     # pick a different pulled model (must support tool-calling)
#   OLLAMA_URL=http://192.168.1.5:11434 ./run_ollama.sh   # Ollama on another host
set -euo pipefail
cd "$(dirname "$0")"

LACEWORK_TOML="${LACEWORK_TOML:-$HOME/.lacework.toml}"
if [ ! -f "$LACEWORK_TOML" ]; then
    echo "error: $LACEWORK_TOML not found — run 'lacework configure' first." >&2
    exit 1
fi

IMAGE=mcp-forticnapp-ollama

docker build -t "$IMAGE" -f docker/Dockerfile .

docker run -it --rm \
    --add-host=host.docker.internal:host-gateway \
    -v "$LACEWORK_TOML:/run/secrets/lacework.toml:ro" \
    -e OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:7b-instruct}" \
    -e OLLAMA_URL="${OLLAMA_URL:-http://host.docker.internal:11434}" \
    "$IMAGE"
