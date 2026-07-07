"""Turns a list of selected OperationSpecs into MCP tool definitions and dispatches
tool calls to http_client. This is the only module that talks to mcp.types --
everything upstream (openapi_loader) is MCP-agnostic OpenAPI parsing.
"""

from __future__ import annotations

from typing import Any

import mcp.types as types

from .http_client import ForticnappHttpClient
from .logging_utils import get_logger, log_fields
from .models import OperationSpec, RequestMeta, ToolCallResult, ToolErrorInfo
from .utils import build_tool_name, derive_name_components

logger = get_logger(__name__)


def _resolve_name_collisions(operations: list[OperationSpec]) -> list[OperationSpec]:
    """Two naively-derived names can collide (e.g. GET CloudAccounts/{type} and
    GET CloudAccounts/{intgGuid} both derive "forticnapp_cloud_accounts_get"). For any
    colliding group, rebuild the name with the path parameter(s) as a disambiguator;
    a numeric suffix is the last-resort fallback and is logged loudly since it means
    two truly identical-shaped operations exist."""
    name_counts: dict[str, int] = {}
    for op in operations:
        name_counts[op.tool_name] = name_counts.get(op.tool_name, 0) + 1

    used_names: set[str] = set()
    for op in operations:
        if name_counts[op.tool_name] > 1:
            path_param_names = [p.wire_name for p in op.path_params]
            disambiguator = "_".join(path_param_names) if path_param_names else op.method.lower()
            resource_segments, action_suffix = derive_name_components(op.method, op.path)
            new_name = build_tool_name("forticnapp", resource_segments, action_suffix, disambiguator=disambiguator)
            base, counter = new_name, 2
            while new_name in used_names:
                new_name = f"{base}_{counter}"
                counter += 1
                logger.warning(
                    "tool name still collides after disambiguation, appending numeric suffix",
                    extra=log_fields(base_name=base, path=op.path, method=op.method),
                )
            op.tool_name = new_name
        used_names.add(op.tool_name)
    return operations


def _build_tool(operation: OperationSpec) -> types.Tool:
    description = operation.description or operation.summary
    if operation.is_mutation:
        description = f"[MUTATION] {description}"
    if operation.supports_pagination:
        description = f"{description} Supports pagination via the page_url argument."
    return types.Tool(
        name=operation.tool_name,
        description=description[:1000],
        inputSchema=operation.input_model.model_json_schema(),
    )


class ToolRegistry:
    """Owns the final (collision-resolved) operation list, the mcp.types.Tool
    definitions built from it, and dispatch from tool name -> http_client.execute."""

    def __init__(self, operations: list[OperationSpec], http_client: ForticnappHttpClient) -> None:
        self._operations = _resolve_name_collisions(list(operations))
        self._by_name = {op.tool_name: op for op in self._operations}
        self._http_client = http_client
        self.tools: list[types.Tool] = [_build_tool(op) for op in self._operations]
        logger.info("registered MCP tools", extra=log_fields(count=len(self.tools)))

    async def call(self, name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
        operation = self._by_name.get(name)
        if operation is None:
            result = ToolCallResult(
                success=False,
                status_code=None,
                operation_id=name,
                request=RequestMeta(method="", path=""),
                error=ToolErrorInfo(
                    message=f"Unknown tool '{name}'", category="validation_error", retryable=False
                ),
            )
            return result.model_dump()

        result = await self._http_client.execute(operation, arguments or {})
        return result.model_dump()
