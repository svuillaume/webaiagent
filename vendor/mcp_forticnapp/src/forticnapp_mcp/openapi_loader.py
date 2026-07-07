"""Loads lw.yaml/lw.json, resolves $ref/allOf, and turns OpenAPI operations into
OperationSpec objects (including their generated pydantic input model).

Operation *selection* (which tags, whether to include mutations) is deliberately
kept separate from *extraction* here: extract_operations() parses everything
non-deprecated; select_operations() applies the policy from Settings. That way
naming/parsing logic can be tested without needing a Settings instance.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, create_model

from .errors import SpecError
from .models import OperationParameter, OperationSpec, TokenOperationHint
from .utils import (
    build_tool_name,
    derive_name_components,
    is_mutation_operation,
    json_schema_to_python_type,
    safe_field_name,
    supports_pagination,
)

_HTTP_METHODS = ("get", "post", "put", "patch", "delete")
_AUTO_INJECTED_HEADERS = {"authorization", "x-lw-uaks", "content-type"}
_MAX_REF_DEPTH = 12


def load_spec(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SpecError(f"OpenAPI spec not found at '{path}'")
    text = path.read_text(encoding="utf-8")
    try:
        if path.suffix.lower() in (".yaml", ".yml"):
            spec = yaml.safe_load(text)
        else:
            spec = json.loads(text)
    except (yaml.YAMLError, json.JSONDecodeError) as exc:
        raise SpecError(f"Failed to parse OpenAPI spec '{path}': {exc}") from exc
    if not isinstance(spec, dict) or "paths" not in spec:
        raise SpecError(f"'{path}' does not look like a valid OpenAPI document (missing top-level 'paths')")
    return spec


def resolve_ref(spec: dict[str, Any], ref: str) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise SpecError(f"Only local $ref pointers are supported, got '{ref}'")
    node: Any = spec
    for part in ref[2:].split("/"):
        if not isinstance(node, dict) or part not in node:
            raise SpecError(f"Broken $ref '{ref}': '{part}' not found")
        node = node[part]
    return node


def flatten_schema(
    spec: dict[str, Any],
    schema: dict[str, Any] | None,
    _seen: frozenset[str] = frozenset(),
    _depth: int = 0,
) -> dict[str, Any]:
    """Resolve one schema node to a plain dict with type/properties/required/items/enum
    directly usable by json_schema_to_python_type. Merges allOf branches shallowly
    (union of properties/required) -- deep nested schemas are intentionally left as-is
    since they collapse to dict[str, Any] downstream anyway."""
    if not schema or _depth > _MAX_REF_DEPTH:
        return {}

    if "$ref" in schema:
        ref = schema["$ref"]
        if ref in _seen:
            return {}  # cycle guard
        resolved = resolve_ref(spec, ref)
        return flatten_schema(spec, resolved, _seen | {ref}, _depth + 1)

    if "allOf" in schema:
        merged: dict[str, Any] = {"type": "object", "properties": {}, "required": []}
        for branch in schema["allOf"]:
            flat = flatten_schema(spec, branch, _seen, _depth + 1)
            if flat.get("type") and merged.get("type") == "object" and not flat.get("properties"):
                merged["type"] = flat["type"]
            merged["properties"].update(flat.get("properties") or {})
            merged["required"].extend(flat.get("required") or [])
        merged["required"] = list(dict.fromkeys(merged["required"]))
        if "description" in schema:
            merged["description"] = schema["description"]
        return merged

    return dict(schema)


def _resolve_parameters(
    spec: dict[str, Any], operation: dict[str, Any], path_item: dict[str, Any]
) -> list[dict[str, Any]]:
    raw_params = list(path_item.get("parameters", [])) + list(operation.get("parameters", []))
    resolved = []
    for param in raw_params:
        resolved.append(resolve_ref(spec, param["$ref"]) if "$ref" in param else param)
    return resolved


def _build_body_parameters(spec: dict[str, Any], operation: dict[str, Any]) -> list[OperationParameter]:
    request_body = operation.get("requestBody")
    if not request_body:
        return []

    media = (request_body.get("content") or {}).get("application/json")
    if not media:
        return []
    schema = flatten_schema(spec, media.get("schema"))
    if not schema:
        return []

    if schema.get("type") == "object" and schema.get("properties"):
        required_names = set(schema.get("required") or [])
        params = []
        for prop_name, prop_schema in schema["properties"].items():
            resolved_prop = flatten_schema(spec, prop_schema)
            params.append(
                OperationParameter(
                    name=safe_field_name(prop_name),
                    wire_name=prop_name,
                    location="body",
                    required=prop_name in required_names,
                    python_type=json_schema_to_python_type(resolved_prop),
                    description=resolved_prop.get("description"),
                )
            )
        return params

    # Non-object body (array/scalar): expose as a single opaque "body" field.
    return [
        OperationParameter(
            name="body",
            wire_name="body",
            location="body",
            required=bool(request_body.get("required")),
            python_type=json_schema_to_python_type(schema),
            description=request_body.get("description"),
        )
    ]


def _build_input_model(model_name: str, parameters: list[OperationParameter]) -> type[BaseModel]:
    fields: dict[str, Any] = {}
    for param in parameters:
        python_type = param.python_type if param.required else (param.python_type | None)
        default = ... if param.required else param.default
        fields[param.name] = (python_type, default)
    return create_model(model_name, **fields)  # type: ignore[call-overload]


def extract_operations(spec: dict[str, Any]) -> list[OperationSpec]:
    """Parse every non-deprecated operation in the spec into an OperationSpec. Tag/mutation
    policy filtering happens later, in select_operations."""
    operations: list[OperationSpec] = []
    for path, path_item in (spec.get("paths") or {}).items():
        for method in _HTTP_METHODS:
            operation = path_item.get(method)
            if not operation or operation.get("deprecated"):
                continue

            tags = list(operation.get("tags") or [])
            method_upper = method.upper()
            mutation = is_mutation_operation(method, path)
            paginated = supports_pagination(method, path)

            resource_segments, action_suffix = derive_name_components(method, path)
            tool_name = build_tool_name("forticnapp", resource_segments, action_suffix)

            parameters: list[OperationParameter] = []
            for raw in _resolve_parameters(spec, operation, path_item):
                location = raw.get("in")
                name = raw.get("name", "")
                if location == "header":
                    continue  # auth headers are injected automatically; no other header params in this spec
                if location not in ("path", "query"):
                    continue
                schema = flatten_schema(spec, raw.get("schema"))
                parameters.append(
                    OperationParameter(
                        name=safe_field_name(name),
                        wire_name=name,
                        location=location,
                        required=bool(raw.get("required")) or location == "path",
                        python_type=json_schema_to_python_type(schema),
                        description=raw.get("description"),
                    )
                )

            parameters.extend(_build_body_parameters(spec, operation))

            if paginated:
                parameters.append(
                    OperationParameter(
                        name="page_url",
                        wire_name="page_url",
                        location="query",
                        required=False,
                        python_type=str,
                        description=(
                            "Absolute next-page URL copied from a previous call's "
                            "pagination.next_page_url. When set, every other argument is "
                            "ignored and this URL is fetched directly."
                        ),
                        default=None,
                    )
                )

            summary = (operation.get("summary") or f"{method_upper} {path}").strip()
            description = (operation.get("description") or summary).strip()

            operations.append(
                OperationSpec(
                    tool_name=tool_name,
                    method=method_upper,
                    path=path,
                    summary=summary,
                    description=description[:1500],
                    tags=tags,
                    parameters=parameters,
                    deprecated=False,
                    is_mutation=mutation,
                    supports_pagination=paginated,
                    input_model=_build_input_model(f"{tool_name}_input", parameters),
                )
            )
    return operations


def select_operations(
    operations: list[OperationSpec],
    enabled_tags: set[str],
    enable_mutation_tools: bool,
) -> list[OperationSpec]:
    """Apply the tag allowlist and mutation gate. Empty enabled_tags means "no tag
    restriction" (useful for tests); production configs always set FORTICNAPP_ENABLED_TAGS."""
    selected = []
    for op in operations:
        if enabled_tags and not (set(op.tags) & enabled_tags):
            continue
        if op.is_mutation and not enable_mutation_tools:
            continue
        selected.append(op)
    return selected


def discover_token_operation(spec: dict[str, Any], token_path: str) -> TokenOperationHint:
    """Best-effort inference of the token-exchange request/response field names from the
    spec itself. Falls back to FortiCNAPP's documented keyId/expiryTime/token/expiresAt
    contract (see TokenOperationHint defaults) when the operation or its schema can't be
    found -- this never raises, since auth.py always has a working default to fall back on.
    """
    hint = TokenOperationHint()
    path_item = (spec.get("paths") or {}).get(token_path)
    if not path_item:
        return hint
    operation = path_item.get("post") or path_item.get("get")
    if not operation:
        return hint

    for raw in _resolve_parameters(spec, operation, path_item):
        name = raw.get("name", "")
        # Unlike _build_input_model's header skip-list, "authorization"/"x-lw-uaks" are not
        # excluded here -- X-LW-UAKS *is* the header this discovery is looking for.
        if raw.get("in") == "header" and name.lower() != "content-type":
            hint.secret_header_name = name
            break

    request_body = operation.get("requestBody") or {}
    request_schema = flatten_schema(
        spec, ((request_body.get("content") or {}).get("application/json") or {}).get("schema")
    )
    props = request_schema.get("properties") or {}
    required = request_schema.get("required") or []
    key_candidates = [n for n in props if "key" in n.lower()] or [n for n in required if "key" in n.lower()]
    if key_candidates:
        hint.key_field_name = key_candidates[0]
    expiry_candidates = [n for n in props if "expir" in n.lower()]
    if expiry_candidates:
        hint.expiry_field_name = expiry_candidates[0]

    responses = operation.get("responses") or {}
    success_response = responses.get("201") or responses.get("200") or {}
    response_schema = flatten_schema(
        spec, ((success_response.get("content") or {}).get("application/json") or {}).get("schema")
    )
    response_props = response_schema.get("properties") or {}
    token_candidates = [n for n in response_props if "token" in n.lower()]
    if token_candidates:
        hint.response_token_field = token_candidates[0]
    expiry_resp_candidates = [n for n in response_props if "expir" in n.lower()]
    if expiry_resp_candidates:
        hint.response_expiry_field = expiry_resp_candidates[0]

    return hint
