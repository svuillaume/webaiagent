#!/bin/sh
set -e

TOML=/run/secrets/lacework.toml
if [ -f "$TOML" ]; then
    eval "$(python3 /app/docker/parse_lacework_toml.py "$TOML")"
else
    echo "warning: $TOML not mounted — forticnapp-mcp will fail to authenticate" >&2
fi

: "${OLLAMA_MODEL:=qwen2.5:7b-instruct}"
: "${OLLAMA_URL:=http://host.docker.internal:11434}"

exec mcphost -m "ollama:${OLLAMA_MODEL}" --provider-url "$OLLAMA_URL" --config /app/docker/mcp.json \
    --system-prompt /app/docker/system-prompt.txt
