"""Executes OperationSpecs against the FortiCNAPP API: builds the request from
validated arguments, injects auth, retries transient failures, retries once on
401 after refreshing credentials, and normalizes the response into a ToolCallResult.

execute() never raises -- every failure mode (validation, auth, network, API 4xx/5xx)
is captured into ToolCallResult.error so tool_registry can hand it straight back to
the MCP client as structured JSON.

Oversized responses: FortiCNAPP's list/search endpoints share one envelope shape
(`{"paging": {...}, "data": [...]}`). When a single upstream page exceeds
MAX_RESPONSE_BYTES, that shape is sliced into MCP-client-sized chunks (see
_build_oversized_result) instead of just erroring. Continuation between chunks reuses
the existing page_url contract -- the server stays stateless, so a synthetic
`LOCALPAGE:<base64>` cursor re-encodes the *original* request + a row offset; a
follow-up call decodes it, replays the identical upstream request, and slices from
there. Real upstream `nextPage` URLs (always absolute https://...) are used once local
rows are exhausted, so pagination is transparent to the caller either way.
"""

from __future__ import annotations

import asyncio
import base64
import json
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
_LOCAL_PAGE_PREFIX = "LOCALPAGE:"
_CHUNK_TARGET_RATIO = 0.8


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
        local = _decode_local_cursor(page_url)
        headers = await self._headers()

        if local is not None:
            method, url, params, json_body, offset = local
            response = await self._send_with_retry(
                operation, method, url, headers=headers, params=params, json_body=json_body
            )
            request_meta = RequestMeta(
                method=method, path=url, query_keys=sorted((params or {}).keys()), has_body=json_body is not None
            )
            return self._build_result(
                operation, response, request_meta, method=method, url=url, params=params, json_body=json_body,
                offset=offset,
            )

        # Real upstream FortiCNAPP nextPage URL: always GET, self-contained, no body.
        response = await self._send_with_retry(operation, "GET", page_url, headers=headers, params=None, json_body=None)
        request_meta = RequestMeta(method="GET", path=page_url, query_keys=[])
        return self._build_result(
            operation, response, request_meta, method="GET", url=page_url, params=None, json_body=None, offset=0
        )

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
        return self._build_result(
            operation, response, request_meta,
            method=operation.method, url=url_path, params=query_values or None, json_body=json_body, offset=0,
        )

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
        self,
        operation: OperationSpec,
        response: httpx.Response,
        request_meta: RequestMeta,
        *,
        method: str,
        url: str,
        params: dict[str, Any] | None,
        json_body: Any,
        offset: int,
    ) -> ToolCallResult:
        content_length = len(response.content)
        if content_length > self._settings.max_response_bytes:
            return self._build_oversized_result(
                operation, response, request_meta,
                method=method, url=url, params=params, json_body=json_body, offset=offset,
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

    def _build_oversized_result(
        self,
        operation: OperationSpec,
        response: httpx.Response,
        request_meta: RequestMeta,
        *,
        method: str,
        url: str,
        params: dict[str, Any] | None,
        json_body: Any,
        offset: int,
    ) -> ToolCallResult:
        """Slice a too-large list/search response into an MCP-sized chunk instead of
        erroring outright. Falls back to the plain too-large error if the body isn't
        JSON, doesn't match FortiCNAPP's {"paging", "data": [...]} envelope, or even a
        single row can't fit safely (checked below)."""
        try:
            parsed = response.json()
        except ValueError:
            parsed = None

        rows = parsed.get("data") if isinstance(parsed, dict) else None
        if not isinstance(rows, list):
            return _too_large_result(
                operation, request_meta, response.status_code, content_length=len(response.content),
                limit=self._settings.max_response_bytes,
            )

        remaining = rows[offset:]
        budget = int(self._settings.max_response_bytes * _CHUNK_TARGET_RATIO)
        chunk = _greedy_chunk(remaining, budget)
        if not chunk:
            return _too_large_result(
                operation, request_meta, response.status_code, content_length=len(response.content),
                limit=self._settings.max_response_bytes,
            )

        consumed = offset + len(chunk)
        upstream_paging = parsed.get("paging") if isinstance(parsed.get("paging"), dict) else {}
        upstream_next = (upstream_paging.get("urls") or {}).get("nextPage")

        if consumed < len(rows):
            next_page_url = _encode_local_cursor(method, url, params, json_body, consumed)
            has_more = True
        elif upstream_next:
            next_page_url = upstream_next
            has_more = True
        else:
            next_page_url = None
            has_more = False

        chunk_envelope = dict(parsed)
        chunk_envelope["data"] = chunk
        if isinstance(chunk_envelope.get("paging"), dict):
            chunk_envelope["paging"] = {**chunk_envelope["paging"], "rows": len(chunk)}

        result = ToolCallResult(
            success=True,
            status_code=response.status_code,
            operation_id=operation.tool_name,
            request=request_meta,
            data=chunk_envelope,
            pagination=PaginationInfo(
                rows=len(chunk),
                total_rows=upstream_paging.get("totalRows"),
                next_page_url=next_page_url,
                has_more=has_more,
            ),
            error=None,
        )

        # Byte-budget chunking is an estimate (JSON escaping, our own wrapper fields) --
        # confirm the actual serialized result fits before handing it back.
        if len(result.model_dump_json().encode()) > self._settings.max_response_bytes:
            return _too_large_result(
                operation, request_meta, response.status_code, content_length=len(response.content),
                limit=self._settings.max_response_bytes,
            )

        return result


def _too_large_result(
    operation: OperationSpec, request_meta: RequestMeta, status_code: int, *, content_length: int, limit: int
) -> ToolCallResult:
    return ToolCallResult(
        success=False,
        status_code=status_code,
        operation_id=operation.tool_name,
        request=request_meta,
        data=None,
        pagination=None,
        error=ToolErrorInfo(
            message=(
                f"Response too large ({content_length:,} bytes, limit is {limit:,}) to return safely "
                "even after chunking -- narrow the request: add a more specific 'filters' entry (e.g. a "
                "resourceType/resourceRegion filter), restrict the 'returns' field list, or use a "
                "tighter timeFilter."
            ),
            category="response_too_large",
            retryable=False,
        ),
    )


def _greedy_chunk(rows: list[Any], budget_bytes: int) -> list[Any]:
    """Pack rows (in order) until the next one would exceed budget_bytes. Always includes
    at least one row if `rows` is non-empty, even if that row alone exceeds the budget --
    the caller does a final real-serialization check to catch that pathological case."""
    chunk: list[Any] = []
    used = 2  # enclosing "[" "]"
    for row in rows:
        size = len(json.dumps(row, separators=(",", ":")).encode())
        if chunk and used + size + 1 > budget_bytes:
            break
        chunk.append(row)
        used += size + 1  # +1 for the separating comma
    return chunk


def _encode_local_cursor(method: str, url: str, params: dict[str, Any] | None, json_body: Any, offset: int) -> str:
    payload = {"m": method, "u": url, "p": params, "b": json_body, "o": offset}
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    return f"{_LOCAL_PAGE_PREFIX}{encoded}"


def _decode_local_cursor(token: str) -> tuple[str, str, dict[str, Any] | None, Any, int] | None:
    """Returns (method, url, params, json_body, offset), or None if `token` isn't one of
    our own cursors (e.g. a real FortiCNAPP nextPage URL, or a corrupted/foreign value --
    treated the same as "not ours" and left for the caller to handle as a plain URL)."""
    if not token.startswith(_LOCAL_PAGE_PREFIX):
        return None
    try:
        raw = base64.urlsafe_b64decode(token[len(_LOCAL_PAGE_PREFIX):].encode())
        payload = json.loads(raw)
        return payload["m"], payload["u"], payload["p"], payload["b"], payload["o"]
    except Exception:
        return None


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
