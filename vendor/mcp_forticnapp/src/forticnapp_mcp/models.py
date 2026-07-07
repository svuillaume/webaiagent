"""Shared data shapes: internal operation metadata plus the pydantic models
that define the structured JSON contract every MCP tool returns.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

ParamLocation = Literal["path", "query", "header", "body"]


@dataclass(frozen=True)
class OperationParameter:
    """One flattened input field: an OpenAPI path/query parameter, or a
    top-level property lifted out of the request body schema.

    `name` is the sanitized Python/JSON-Schema identifier exposed to the MCP
    tool caller; `wire_name` is the exact key the FortiCNAPP API expects. They
    differ only when the original name isn't a valid Python identifier.
    """

    name: str
    wire_name: str
    location: ParamLocation
    required: bool
    python_type: Any
    description: str | None = None
    default: Any = None


@dataclass
class OperationSpec:
    """Everything tool_registry and http_client need to expose and execute
    one OpenAPI operation as an MCP tool."""

    tool_name: str
    method: str
    path: str
    summary: str
    description: str
    tags: list[str]
    parameters: list[OperationParameter]
    deprecated: bool
    is_mutation: bool
    supports_pagination: bool
    input_model: type[BaseModel] = field(repr=False)

    @property
    def path_params(self) -> list[OperationParameter]:
        return [p for p in self.parameters if p.location == "path"]

    @property
    def query_params(self) -> list[OperationParameter]:
        return [p for p in self.parameters if p.location == "query"]

    @property
    def body_params(self) -> list[OperationParameter]:
        return [p for p in self.parameters if p.location == "body"]


class RequestMeta(BaseModel):
    """Request metadata safe to echo back to the caller -- never headers or secrets."""

    method: str
    path: str
    query_keys: list[str] = []
    has_body: bool = False


class PaginationInfo(BaseModel):
    rows: int | None = None
    total_rows: int | None = None
    next_page_url: str | None = None
    has_more: bool = False


class ToolErrorInfo(BaseModel):
    message: str
    category: str
    retryable: bool


@dataclass
class TokenOperationHint:
    """Field names inferred from the token-exchange operation in the spec (falls back to
    FortiCNAPP's known keyId/expiryTime/token/expiresAt contract when nothing is found).
    See openapi_loader.discover_token_operation and the CUSTOMIZE block in auth.py."""

    key_field_name: str = "keyId"
    expiry_field_name: str = "expiryTime"
    secret_header_name: str | None = None
    response_token_field: str = "token"
    response_expiry_field: str = "expiresAt"


class ToolCallResult(BaseModel):
    """The structured JSON contract returned by every FortiCNAPP MCP tool."""

    model_config = ConfigDict(populate_by_name=True)

    success: bool
    status_code: int | None
    operation_id: str
    request: RequestMeta
    data: Any = None
    pagination: PaginationInfo | None = None
    error: ToolErrorInfo | None = None
