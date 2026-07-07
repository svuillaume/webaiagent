"""Deterministic name derivation and JSON-Schema-to-Python-type mapping.

Isolated here because openapi_loader and tool_registry both need it, and
because tool-name derivation is the single trickiest piece of this codebase
(see CLAUDE.md for why: no operationIds, PascalCase paths, POST .../search
being a read, collisions between similarly-shaped paths).
"""

from __future__ import annotations

import keyword
import re
from typing import Any
from urllib.parse import quote

_BOUNDARY_LOWER_UPPER = re.compile(r"([a-z0-9])([A-Z])")
_BOUNDARY_ACRONYM = re.compile(r"([A-Z]+)([A-Z][a-z])")
_NON_IDENTIFIER = re.compile(r"\W")

_ACTION_WORDS = {
    "search",
    "scan",
    "comment",
    "close",
    "validate",
    "test",
    "export",
    "import",
    "preview",
    "run",
}

_VERSION_SEGMENT = re.compile(r"^v\d+$", re.IGNORECASE)


def pascal_to_snake(name: str) -> str:
    """AgentAccessTokens -> agent_access_tokens, InternalIPAddresses -> internal_ip_addresses."""
    s = _BOUNDARY_ACRONYM.sub(r"\1_\2", name)
    s = _BOUNDARY_LOWER_UPPER.sub(r"\1_\2", s)
    s = re.sub(r"[\s\-]+", "_", s)
    s = re.sub(r"_+", "_", s)
    return s.lower().strip("_")


def safe_field_name(name: str) -> str:
    """Turn an arbitrary OpenAPI parameter/property name into a valid Python identifier."""
    candidate = name if name.isidentifier() else _NON_IDENTIFIER.sub("_", name)
    if not candidate or candidate[0].isdigit():
        candidate = f"_{candidate}"
    if keyword.iskeyword(candidate):
        candidate = f"{candidate}_field"
    return candidate


def split_path_segments(path: str) -> tuple[list[str], list[str]]:
    """Split an OpenAPI path template into (static_segments, path_param_names), in order,
    dropping a leading /api/vN prefix if present."""
    raw = [seg for seg in path.split("/") if seg]

    start = 0
    if raw and raw[0].lower() == "api":
        start = 1
    if len(raw) > start and _VERSION_SEGMENT.match(raw[start]):
        start += 1
    raw = raw[start:]

    static_segments: list[str] = []
    param_names: list[str] = []
    for seg in raw:
        if seg.startswith("{") and seg.endswith("}"):
            param_names.append(seg[1:-1])
        else:
            static_segments.append(seg)
    return static_segments, param_names


def is_mutation_operation(method: str, path: str) -> bool:
    """GET is always safe. POST ending in /search is a read (query-by-body). Everything
    else (POST create/action, PUT, PATCH, DELETE) is a mutation."""
    method = method.lower()
    if method == "get":
        return False
    if method == "post" and path.rstrip("/").lower().endswith("/search"):
        return False
    return True


def supports_pagination(method: str, path: str) -> bool:
    """Heuristic mirroring is_mutation_operation: GET collections and POST .../search both
    follow FortiCNAPP's paging.urls.nextPage convention; single-resource GETs and mutations don't."""
    method = method.lower()
    if method == "post" and path.rstrip("/").lower().endswith("/search"):
        return True
    if method == "get":
        _, param_names = split_path_segments(path)
        return len(param_names) == 0
    return False


def derive_name_components(method: str, path: str) -> tuple[list[str], str]:
    """Return (resource_segments, action_suffix) for tool naming. resource_segments
    excludes any trailing static segment that was consumed as the action word (e.g.
    the "search" in .../search, or "scan"/"comment"/"close" action sub-resources),
    so build_tool_name never joins an action word into the resource name and then
    appends it again as the suffix."""
    static_segments, param_names = split_path_segments(path)
    ends_with_param = bool(param_names) and path.rstrip("/").endswith("}")
    method_lower = method.lower()

    if method_lower == "get":
        return static_segments, ("get" if ends_with_param else "list")
    if method_lower == "delete":
        return static_segments, "delete"
    if method_lower == "patch":
        return static_segments, "update"
    if method_lower == "put":
        return static_segments, "replace"
    if method_lower == "post":
        if len(static_segments) > 1:
            last_snake = pascal_to_snake(static_segments[-1])
            if last_snake in _ACTION_WORDS:
                return static_segments[:-1], last_snake
        return static_segments, "create"
    return static_segments, method_lower


def build_tool_name(
    prefix: str,
    resource_segments: list[str],
    action_suffix: str,
    disambiguator: str | None = None,
) -> str:
    parts = [prefix] + [pascal_to_snake(seg) for seg in resource_segments]
    if disambiguator:
        parts.append(f"by_{pascal_to_snake(disambiguator)}")
    parts.append(action_suffix)
    name = "_".join(p for p in parts if p)
    return re.sub(r"_+", "_", name)


def format_path(path_template: str, path_values: dict[str, Any]) -> str:
    """Substitute {param} placeholders with URL-safe encoded values."""

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in path_values:
            raise KeyError(f"Missing path parameter '{key}' for template '{path_template}'")
        return quote(str(path_values[key]), safe="")

    return re.sub(r"\{([^{}]+)\}", replace, path_template)


def json_schema_to_python_type(schema: dict[str, Any] | None) -> Any:
    """Map a (already-resolved) JSON Schema fragment to a Python type usable in
    pydantic.create_model. Intentionally conservative: nested objects and unions
    collapse to permissive types rather than attempting a full JSON-Schema compiler --
    the real API is still the source of truth for validation."""
    if not schema:
        return Any
    if "enum" in schema:
        return str
    schema_type = schema.get("type")
    if schema_type == "string":
        return str
    if schema_type == "integer":
        return int
    if schema_type == "number":
        return float
    if schema_type == "boolean":
        return bool
    if schema_type == "array":
        item_type = json_schema_to_python_type(schema.get("items"))
        return list[item_type]  # type: ignore[valid-type]
    if schema_type == "object" or schema_type is None:
        return dict[str, Any]
    return Any
