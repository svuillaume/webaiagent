"""Auth strategies for FortiCNAPP.

FortiCNAPP/Lacework's real contract (confirmed against lw.yaml -- see CLAUDE.md):
    POST /api/v2/access/tokens
      header  X-LW-UAKS: <secret>
      body    {"keyId": "...", "expiryTime": <=86400}
      ->      {"token": "...", "expiresAt": "<RFC3339>"}
    Every other call: Authorization: Bearer <token>

=== CUSTOMIZATION POINT ===
If your FortiCNAPP/Lacework deployment's token contract differs (self-hosted,
FedRAMP, a future API revision), the only method you need to change is
ApiKeyToTokenStrategy._acquire_token below. Everything else in this module
(caching, refresh-on-401, locking) is wire-format agnostic.
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx

from .config import Settings
from .errors import AuthError
from .logging_utils import get_logger, log_fields, redact_secret
from .models import TokenOperationHint

logger = get_logger(__name__)


@dataclass
class _TokenBundle:
    token: str
    expires_at: datetime


class AuthStrategy(ABC):
    """Supplies auth headers for outgoing requests and knows how to react to a 401."""

    @abstractmethod
    async def get_headers(self, client: httpx.AsyncClient) -> dict[str, str]: ...

    async def invalidate(self) -> None:
        """Called after a 401 so the next get_headers() call re-acquires credentials.
        Default is a no-op: static strategies have nothing to invalidate."""
        return None


class ApiKeyAuthStrategy(AuthStrategy):
    """Sends the raw secret on every request. No token exchange -- for FortiCNAPP
    deployments that accept the API key directly rather than requiring a token."""

    def __init__(self, *, header_name: str, secret: str, prefix: str = "") -> None:
        self._header_name = header_name
        self._secret = secret
        self._prefix = prefix

    async def get_headers(self, client: httpx.AsyncClient) -> dict[str, str]:
        value = f"{self._prefix}{self._secret}" if self._prefix else self._secret
        return {self._header_name: value}


class BearerTokenStrategy(AuthStrategy):
    """Uses a pre-issued, static bearer token: no exchange step, no refresh possible."""

    def __init__(self, *, header_name: str, token: str, bearer_prefix: str = "Bearer") -> None:
        self._header_name = header_name
        self._token = token
        self._bearer_prefix = bearer_prefix

    async def get_headers(self, client: httpx.AsyncClient) -> dict[str, str]:
        value = f"{self._bearer_prefix} {self._token}".strip()
        return {self._header_name: value}

    async def invalidate(self) -> None:
        logger.warning(
            "bearer_static token was rejected with 401 and cannot be refreshed automatically; "
            "issue a new FORTICNAPP_API_SECRET and restart the server"
        )


class ApiKeyToTokenStrategy(AuthStrategy):
    """The real FortiCNAPP/Lacework handshake: exchange keyId+secret for a short-lived
    bearer token, cache it in memory, and refresh proactively or on 401."""

    def __init__(
        self,
        *,
        token_url: str,
        key_id: str,
        secret: str,
        expiry_seconds: int,
        token_header_name: str,
        bearer_prefix: str,
        hint: TokenOperationHint,
        expiry_buffer_seconds: int = 60,
    ) -> None:
        self._token_url = token_url
        self._key_id = key_id
        self._secret = secret
        self._expiry_seconds = expiry_seconds
        self._token_header_name = token_header_name
        self._bearer_prefix = bearer_prefix
        self._hint = hint
        self._expiry_buffer = timedelta(seconds=expiry_buffer_seconds)
        self._cached: _TokenBundle | None = None
        self._lock = asyncio.Lock()

    async def get_headers(self, client: httpx.AsyncClient) -> dict[str, str]:
        token = await self._get_valid_token(client)
        return {self._token_header_name: f"{self._bearer_prefix} {token}".strip()}

    async def invalidate(self) -> None:
        async with self._lock:
            self._cached = None

    async def _get_valid_token(self, client: httpx.AsyncClient) -> str:
        # Lock spans the whole check-and-acquire so concurrent tool calls that all
        # miss the cache at once don't fire N redundant token requests.
        async with self._lock:
            if self._cached and self._cached.expires_at - self._expiry_buffer > _now():
                return self._cached.token
            self._cached = await self._acquire_token(client)
            return self._cached.token

    # === CUSTOMIZATION POINT ===
    # `self._hint` carries field names inferred from the spec at startup
    # (openapi_loader.discover_token_operation); everything else in this class is
    # unaware of the wire format. If your deployment's token endpoint differs from
    # FortiCNAPP's documented contract, adjust the request/response handling below.
    async def _acquire_token(self, client: httpx.AsyncClient) -> _TokenBundle:
        header_name = self._hint.secret_header_name or "X-LW-UAKS"
        request_body = {
            self._hint.key_field_name: self._key_id,
            self._hint.expiry_field_name: self._expiry_seconds,
        }
        logger.info(
            "requesting FortiCNAPP access token",
            extra=log_fields(token_url=self._token_url, key_id=self._key_id),
        )
        try:
            response = await client.post(
                self._token_url,
                headers={header_name: self._secret, "Content-Type": "application/json"},
                json=request_body,
            )
        except httpx.HTTPError as exc:
            raise AuthError(f"Token request failed: {exc}", retryable=True) from exc

        if response.status_code >= 400:
            raise AuthError(
                f"Token exchange rejected with status {response.status_code}",
                status_code=response.status_code,
                retryable=response.status_code >= 500,
            )

        try:
            payload = response.json()
            token = payload[self._hint.response_token_field]
            expires_at_raw = payload[self._hint.response_expiry_field]
        except (ValueError, KeyError) as exc:
            raise AuthError(f"Unexpected token response shape: {exc}") from exc

        expires_at = _parse_rfc3339(expires_at_raw)
        logger.info(
            "acquired FortiCNAPP access token",
            extra=log_fields(expires_at=expires_at.isoformat(), token=redact_secret(token)),
        )
        return _TokenBundle(token=token, expires_at=expires_at)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_rfc3339(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def build_auth_strategy(settings: Settings, hint: TokenOperationHint) -> AuthStrategy:
    """Factory selecting a strategy from FORTICNAPP_AUTH_MODE. Settings validation
    already guarantees forticnapp_api_secret is set, and forticnapp_key_id is set
    when auth_mode is api_key_to_token."""
    secret = settings.forticnapp_api_secret.get_secret_value() if settings.forticnapp_api_secret else ""

    if settings.forticnapp_auth_mode == "bearer_static":
        return BearerTokenStrategy(
            header_name=settings.forticnapp_token_header_name,
            token=secret,
            bearer_prefix=settings.forticnapp_bearer_prefix,
        )

    if settings.forticnapp_auth_mode == "api_key":
        return ApiKeyAuthStrategy(
            header_name=settings.forticnapp_api_key_header_name,
            secret=secret,
            prefix=settings.forticnapp_api_key_prefix,
        )

    assert settings.forticnapp_key_id is not None  # enforced by Settings._validate_auth_material
    return ApiKeyToTokenStrategy(
        token_url=settings.forticnapp_token_url,
        key_id=settings.forticnapp_key_id,
        secret=secret,
        expiry_seconds=settings.forticnapp_token_expiry_seconds,
        token_header_name=settings.forticnapp_token_header_name,
        bearer_prefix=settings.forticnapp_bearer_prefix,
        hint=hint,
    )
