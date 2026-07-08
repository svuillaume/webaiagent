"""Startup wiring shared by both MCP transports (stdio and HTTP).

Flow (see CLAUDE.md for why each step is shaped this way):
  1. load env and config           -> config.load_settings()
  2. validate config                -> raises ConfigError, caught here
  3. load lw.yaml/json               -> openapi_loader.load_spec()
  4. inspect security / token shape -> openapi_loader.discover_token_operation()
  5. initialize auth strategy       -> auth.build_auth_strategy()
  6. register MCP tools             -> extract_operations/select_operations + ToolRegistry
  7. build the transport-agnostic Server -> mcp.server.lowlevel.Server

Everything above is transport-agnostic and lives in build_mcp_server(). run() (this module)
starts it over stdio; http_server.py starts the same Server over Streamable HTTP.
"""

from __future__ import annotations

import sys
from typing import Any

import anyio
import mcp.types as types
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.stdio import stdio_server

from . import __version__
from .auth import build_auth_strategy
from .config import ConfigError, Settings, load_settings
from .errors import SpecError
from .http_client import ForticnappHttpClient
from .logging_utils import configure_logging, get_logger, log_fields
from .openapi_loader import discover_token_operation, extract_operations, load_spec, select_operations
from .tool_registry import ToolRegistry

logger = get_logger(__name__)


def fail(message: str) -> None:
    print(f"forticnapp-mcp: {message}", file=sys.stderr)
    raise SystemExit(1)


def build_mcp_server(settings: Settings) -> tuple[Server, ForticnappHttpClient]:
    """Build the transport-agnostic MCP Server + its HTTP client.

    Caller owns the Server's lifecycle (wiring it to a transport) and must call
    `http_client.aclose()` when done, same as the stdio path below does.
    """
    configure_logging(settings.log_level)
    logger.info(
        "starting forticnapp-mcp",
        extra=log_fields(
            base_url=settings.forticnapp_api_base_url,
            auth_mode=settings.forticnapp_auth_mode,
            enabled_tags=sorted(settings.enabled_tags),
            enable_mutation_tools=settings.enable_mutation_tools,
        ),
    )

    try:
        spec = load_spec(settings.forticnapp_openapi_spec)
    except SpecError as exc:
        fail(f"failed to load OpenAPI spec: {exc}")
        raise  # unreachable, keeps type-checkers happy

    token_hint = discover_token_operation(spec, settings.forticnapp_token_url)
    auth_strategy = build_auth_strategy(settings, token_hint)

    all_operations = extract_operations(spec)
    selected_operations = select_operations(all_operations, settings.enabled_tags, settings.enable_mutation_tools)
    if not selected_operations:
        fail(
            "no operations selected -- check FORTICNAPP_ENABLED_TAGS against the tags in "
            f"{settings.forticnapp_openapi_spec}"
        )
        raise AssertionError("unreachable")

    http_client = ForticnappHttpClient(settings, auth_strategy)
    registry = ToolRegistry(selected_operations, http_client)

    server: Server = Server("forticnapp-mcp", version=__version__)

    @server.list_tools()
    async def handle_list_tools() -> list[types.Tool]:
        return registry.tools

    @server.call_tool()
    async def handle_call_tool(name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
        return await registry.call(name, arguments)

    return server, http_client


async def _serve() -> None:
    try:
        settings = load_settings()
    except ConfigError as exc:
        fail(f"configuration error: {exc}")
        return  # unreachable, keeps type-checkers happy

    server, http_client = build_mcp_server(settings)
    init_options = server.create_initialization_options(notification_options=NotificationOptions())

    try:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, init_options)
    finally:
        await http_client.aclose()


def run() -> None:
    """Entry point for the `forticnapp-mcp` console script (see pyproject.toml)."""
    anyio.run(_serve)


if __name__ == "__main__":
    run()
