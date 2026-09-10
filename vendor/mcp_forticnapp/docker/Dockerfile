# Bundles forticnapp-mcp (this vendored MCP server) with mcphost, a Go-based MCP
# client, so the server can be driven by a local Ollama model instead of Claude.
# Standalone from the main project's Dockerfile/serve.py — build/run from this
# directory's parent via ../run_ollama.sh.

FROM golang:1.26-bookworm AS mcphost-build
RUN go install github.com/mark3labs/mcphost@latest

FROM python:3.11-slim
WORKDIR /app

COPY . /app
RUN pip install --no-cache-dir .

COPY --from=mcphost-build /go/bin/mcphost /usr/local/bin/mcphost
RUN chmod +x /app/docker/entrypoint.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
