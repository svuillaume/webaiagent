"""Executes OperationSpecs against the FortiCNAPP API: builds the request from
validated arguments, injects auth, retries transient failures, retries once on
401 after refreshing credentials, and normalizes the response into a ToolCallResult.

execute() never raises -- every failure mode (validation, auth, network, API 4xx/5xx)
is captured into ToolCallResult.error so tool_registry can hand it straight back to
the MCP client as structured JSON.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
from pydantic import ValidationError as PydanticValidationError

from .auth import AuthStrategy
from .config import Settings
from .errors import ApiError, ForticnappError, NetworkError
from .errors import ValidationError as FcValidationError
from .logging_utils import get_logger, log_fields, redact_headers
from .models import OperationSpec, PaginationInfo, RequestMeta, ToolCallResult, ToolErrorInfo
from .utils import format_path

logger = get_logger(__name__)

_PAGE_URL_FIELD = "page_url"
_RETRYABLE_STATUS = {429, 502, 503, 504}


class ForticnappHttpClient:
    def __init__(self, settings: Settings, auth: AuthStrategy) -> None:
        self._settings = settings
        self._auth = auth
        self._client = httpx.AsyncClient(
            base_url=settings.forticnapp_api_base_url,
            timeout=settings.request_timeout_seconds,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "ForticnappHttpClient":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def execute(self, operation: OperationSpec, arguments: dict[str, Any]) -> ToolCallResult:
        try:
            validated = self._validate(operation, arguments)
        except FcValidationError as exc:
            return _error_result(operation, exc, request=RequestMeta(method=operation.method, path=operation.path))

        try:
            if validated.get(_PAGE_URL_FIELD):
                return await self._execute_page_follow(operation, validated[_PAGE_URL_FIELD])
            return await self._execute_operation(operation, validated)
        except ForticnappError as exc:
            request_meta = RequestMeta(method=operation.method, path=operation.path)
            return _error_result(operation, exc, request=request_meta)
        except Exception as exc:  # last-resort guard: never let a bug crash the MCP session
            logger.exception("unexpected error executing tool", extra=log_fields(operation_id=operation.tool_name))
            wrapped = ApiError(f"Unexpected error: {exc}", operation_id=operation.tool_name)
            return _error_result(operation, wrapped, request=RequestMeta(method=operation.method, path=operation.path))

    def _validate(self, operation: OperationSpec, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            model_instance = operation.input_model.model_validate(arguments)
        except PydanticValidationError as exc:
            raise FcValidationError(
                f"Invalid arguments for {operation.tool_name}: {exc}",
                operation_id=operation.tool_name,
            ) from exc
        return model_instance.model_dump(exclude_none=True)

    async def _execute_page_follow(self, operation: OperationSpec, page_url: str) -> ToolCallResult:
        headers = await self._headers()
        response = await self._send_with_retry(operation, "GET", page_url, headers=headers, params=None, json_body=None)
        return self._build_result(operation, response, RequestMeta(method="GET", path=page_url, query_keys=[]))

    async def _execute_operation(self, operation: OperationSpec, values: dict[str, Any]) -> ToolCallResult:
        path_values = {p.wire_name: values[p.name] for p in operation.path_params if p.name in values}
        url_path = format_path(operation.path, path_values)

        query_values = {
            p.wire_name: values[p.name]
            for p in operation.query_params
            if p.name in values and p.name != _PAGE_URL_FIELD
        }

        json_body: Any = None
        body_params = operation.body_params
        if len(body_params) == 1 and body_params[0].wire_name == "body":
            json_body = values.get("body")
        elif body_params:
            body_values = {p.wire_name: values[p.name] for p in body_params if p.name in values}
            json_body = body_values or None

        headers = await self._headers()
        response = await self._send_with_retry(
            operation, operation.method, url_path, headers=headers, params=query_values or None, json_body=json_body
        )
        request_meta = RequestMeta(
            method=operation.method,
            path=url_path,
            query_keys=sorted(query_values.keys()),
            has_body=json_body is not None,
        )
        return self._build_result(operation, response, request_meta)

    async def _headers(self) -> dict[str, str]:
        auth_headers = await self._auth.get_headers(self._client)
        return {**auth_headers, "Content-Type": "application/json"}

    async def _send_with_retry(
        self,
        operation: OperationSpec,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        params: dict[str, Any] | None,
        json_body: Any,
    ) -> httpx.Response:
        max_retries = self._settings.http_max_retries
        already_refreshed_auth = False
        attempt = 0

        while True:
            try:
                response = await self._client.request(method, url, params=params, json=json_body, headers=headers)
            except httpx.HTTPError as exc:
                if attempt >= max_retries:
                    raise NetworkError(
                        f"Network error calling {operation.tool_name}: {exc}",
                        operation_id=operation.tool_name,
                        retryable=True,
                    ) from exc
                await self._backoff(attempt)
                attempt += 1
                continue

            logger.info(
                "forticnapp api call",
                extra=log_fields(
                    operation_id=operation.tool_name,
                    method=method,
                    status_code=response.status_code,
                    request_headers=redact_headers(dict(headers)),
                ),
            )

            if response.status_code == 401 and not already_refreshed_auth:
                await self._auth.invalidate()
                headers = await self._headers()
                already_refreshed_auth = True
                continue

            if response.status_code in _RETRYABLE_STATUS and attempt < max_retries:
                await self._backoff(attempt)
                attempt += 1
                continue

            return response

    @staticmethod
    async def _backoff(attempt: int) -> None:
        await asyncio.sleep(min(0.5 * (2**attempt), 8.0))

    def _build_result(
        self, operation: OperationSpec, response: httpx.Response, request_meta: RequestMeta
    ) -> ToolCallResult:
        content_length = len(response.content)
        if content_length > self._settings.max_response_bytes:
            return ToolCallResult(
                success=False,
                status_code=response.status_code,
                operation_id=operation.tool_name,
                request=request_meta,
                data=None,
                pagination=None,
                error=ToolErrorInfo(
                    message=(
                        f"Response too large ({content_length:,} bytes, limit is "
                        f"{self._settings.max_response_bytes:,}) to return safely -- it would "
                        "overflow the MCP client's stdio message size guard. Narrow the request: "
                        "add a more specific 'filters' entry (e.g. a resourceType/resourceRegion "
                        "filter), restrict the 'returns' field list, or use a tighter timeFilter."
                    ),
                    category="response_too_large",
                    retryable=False,
                ),
            )

        try:
            data = response.json()
        except ValueError:
            data = response.text or None

        success = 200 <= response.status_code < 300
        error = None
        if not success:
            error = ToolErrorInfo(
                message=f"FortiCNAPP API returned {response.status_code}",
                category="api_error",
                retryable=response.status_code in _RETRYABLE_STATUS,
            )

        return ToolCallResult(
            success=success,
            status_code=response.status_code,
            operation_id=operation.tool_name,
            request=request_meta,
            data=data,
            pagination=_extract_pagination(data),
            error=error,
        )


def _extract_pagination(data: Any) -> PaginationInfo | None:
    if not isinstance(data, dict):
        return None
    paging = data.get("paging")
    if not isinstance(paging, dict):
        return None
    next_page_url = (paging.get("urls") or {}).get("nextPage")
    return PaginationInfo(
        rows=paging.get("rows"),
        total_rows=paging.get("totalRows"),
        next_page_url=next_page_url,
        has_more=bool(next_page_url),
    )


def _error_result(operation: OperationSpec, exc: ForticnappError, *, request: RequestMeta) -> ToolCallResult:
    return ToolCallResult(
        success=False,
        status_code=exc.status_code,
        operation_id=operation.tool_name,
        request=request,
        data=None,
        pagination=None,
        error=ToolErrorInfo(message=exc.message, category=exc.category.value, retryable=exc.retryable),
    )
