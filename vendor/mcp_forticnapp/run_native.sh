#!/usr/bin/env bash
# Native (non-Docker) stdio entrypoint for forticnapp-mcp, for MCP clients that
# spawn a local process directly (e.g. OpenCode's `mcp` config) instead of
# going through mcphost/Docker like run_ollama.sh does.
#
# Reads ~/.lacework.toml (or $LACEWORK_TOML) the same way run_ollama.sh's
# containerized entrypoint.sh does, exports FORTICNAPP_* env vars, then execs
# the forticnapp-mcp binary from the local venv (see: python3 -m venv .venv &&
# .venv/bin/pip install -e .).
set -euo pipefail
cd "$(dirname "$0")"

LACEWORK_TOML="${LACEWORK_TOML:-$HOME/.lacework.toml}"
if [ ! -f "$LACEWORK_TOML" ]; then
    echo "error: $LACEWORK_TOML not found — run 'lacework configure' first." >&2
    exit 1
fi

eval "$(python3 docker/parse_lacework_toml.py "$LACEWORK_TOML")"
export ENABLE_MUTATION_TOOLS=false

exec .venv/bin/forticnapp-mcp
