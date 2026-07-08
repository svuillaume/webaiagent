# forticnapp-mcp

An MCP (Model Context Protocol) server that exposes FortiCNAPP (formerly Lacework) API 2.0
operations as typed, auth-aware tools over stdio. Tools aren't hand-written: they're generated
at startup from the bundled OpenAPI spec (`lw.yaml`), so the tool surface tracks the spec you
point it at.

## Why this exists

FortiCNAPP's API 2.0 spec doesn't declare OpenAPI `securitySchemes`, has no `operationId` on any
of its 120+ operations, and mixes read-only "search" endpoints in with real mutations under the
same HTTP methods. This server works around all three: it hardcodes the real FortiCNAPP auth
handshake, derives deterministic tool names from method + path, and classifies "is this
mutating" from the path shape rather than the HTTP verb alone. See `CLAUDE.md` for the full list
of spec quirks this design accounts for.

## Install

Requires Python 3.11+.

```bash
pip install -e ".[dev]"
```

## Configure

Quickest path — run the interactive setup command, which prompts for your credentials,
validates them against the real FortiCNAPP token endpoint, and writes `.env`, a portable
`.mcp.json`, and `.gitignore`:

```bash
forticnapp-mcp-setup
```

Or configure by hand:

```bash
cp .env.example .env
# then fill in FORTICNAPP_API_BASE_URL, FORTICNAPP_KEY_ID, FORTICNAPP_API_SECRET
```

Credentials come from the FortiCNAPP/Lacework console (Settings > API Keys), which issues a
**keyId** and a **secret** — both are required for the default auth mode. See
`.env.example` for every supported variable, including `FORTICNAPP_ENABLED_TAGS` (which OpenAPI
tags become tools) and `ENABLE_MUTATION_TOOLS` (off by default — only read-only tools are
exposed until you opt in).

## Run

```bash
forticnapp-mcp
# equivalently:
python -m forticnapp_mcp.main
```

The server speaks MCP over stdio. It validates configuration and loads the spec before it starts
listening, and exits with a clear one-line error on stderr if either step fails — it will not
start with a broken configuration.

## Develop

```bash
ruff check src/
pytest
```

## Claude Desktop configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "forticnapp": {
      "command": "python",
      "args": ["-m", "forticnapp_mcp.main"],
      "cwd": "/absolute/path/to/mcp_forticnapp",
      "env": {
        "FORTICNAPP_API_BASE_URL": "https://YourAccount.lacework.net",
        "FORTICNAPP_KEY_ID": "YOUR_KEY_ID",
        "FORTICNAPP_API_SECRET": "YOUR_SECRET",
        "FORTICNAPP_OPENAPI_SPEC": "/absolute/path/to/mcp_forticnapp/lw.yaml"
      }
    }
  }
}
```

`cwd` must be the project root so the default `FORTICNAPP_OPENAPI_SPEC=./lw.yaml` resolves;
alternatively set an absolute path as shown above. Prefer a real `.env` file over inlining
secrets in this config where your setup allows it.

## Architecture

```
config.py          env vars -> validated Settings (pydantic-settings), fails fast
openapi_loader.py   lw.yaml/json -> OperationSpec list (resolves $ref/allOf, builds
                    a pydantic input model per operation, infers the token endpoint's
                    field names)
auth.py             ApiKeyAuthStrategy / BearerTokenStrategy / ApiKeyToTokenStrategy;
                    the last is FortiCNAPP's real keyId+secret -> bearer token handshake
http_client.py      httpx.AsyncClient wrapper: builds requests from validated arguments,
                    retries network/5xx errors, retries once on 401 after refreshing auth,
                    follows FortiCNAPP's cursor-style pagination
tool_registry.py    OperationSpec list -> mcp.types.Tool list (resolving any tool-name
                    collisions) and dispatches call_tool requests to http_client
main.py             wires the above into mcp.server.lowlevel.Server + stdio_server
models.py           OperationSpec/OperationParameter (internal) and the ToolCallResult/
                    RequestMeta/PaginationInfo pydantic models every tool returns
errors.py           ForticnappError hierarchy (auth/validation/api/network/spec), each
                    carrying category/status_code/operation_id/retryable
logging_utils.py    structured JSON logs to stderr with header/secret redaction
utils.py            tool-name derivation, mutation/pagination classification, JSON
                    Schema -> Python type mapping
```

Every tool call returns the same structured JSON envelope:

```json
{
  "success": true,
  "status_code": 200,
  "operation_id": "forticnapp_alerts_list",
  "request": {"method": "GET", "path": "/api/v2/Alerts", "query_keys": ["startTime"], "has_body": false},
  "data": { "...": "..." },
  "pagination": {"rows": 50, "total_rows": 400, "next_page_url": "https://...", "has_more": true},
  "error": null
}
```

To fetch the next page, call the same tool again with `page_url` set to
`pagination.next_page_url` from the previous response — every other argument is ignored when
`page_url` is set.

## Customizing the token exchange

If your FortiCNAPP/Lacework deployment's token endpoint differs from the documented contract
(self-hosted, FedRAMP, a future API revision), there is exactly one place to change:
`ApiKeyToTokenStrategy._acquire_token` in `auth.py`. It builds the token request and parses the
response using field names from a `TokenOperationHint` that's inferred from the spec at startup
(`openapi_loader.discover_token_operation`) with fallback defaults matching FortiCNAPP's current
contract (`keyId`/`expiryTime` in, `token`/`expiresAt` out, secret carried in `X-LW-UAKS`).
Token caching, proactive refresh, and 401-triggered re-acquisition are all wire-format-agnostic
and live in the surrounding `ApiKeyToTokenStrategy` methods — you shouldn't need to touch them.

## Security notes

- Tokens and secrets are kept in memory only; nothing is persisted to disk.
- `logging_utils.redact_headers()`/`redact_secret()` are used everywhere a header dict or secret
  reaches a log call — `Authorization`, `X-LW-UAKS`, and cookie headers are never logged in full.
- Mutating operations (anything that isn't a GET or a `POST .../search`) are excluded from the
  tool list unless `ENABLE_MUTATION_TOOLS=true`.
