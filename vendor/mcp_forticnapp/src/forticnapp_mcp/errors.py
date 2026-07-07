"""Structured error taxonomy shared by auth, HTTP, spec-loading, and tool code.

Every failure that can reach an MCP tool response is normalized into one of
these exceptions so tool_registry can turn it into a structured JSON error
payload instead of leaking a raw traceback to the calling LLM.
"""

from __future__ import annotations

from enum import Enum
from typing import Any


class ErrorCategory(str, Enum):
    AUTH_ERROR = "auth_error"
    VALIDATION_ERROR = "validation_error"
    API_ERROR = "api_error"
    NETWORK_ERROR = "network_error"
    SPEC_ERROR = "spec_error"


class ForticnappError(Exception):
    """Base class for all normalized errors. Carries enough context to build
    a structured tool response without ever including secret material."""

    category: ErrorCategory = ErrorCategory.API_ERROR
    retryable: bool = False

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        operation_id: str | None = None,
        retryable: bool | None = None,
        category: ErrorCategory | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.operation_id = operation_id
        if retryable is not None:
            self.retryable = retryable
        if category is not None:
            self.category = category

    def to_dict(self) -> dict[str, Any]:
        return {
            "message": self.message,
            "category": self.category.value,
            "status_code": self.status_code,
            "operation_id": self.operation_id,
            "retryable": self.retryable,
        }


class AuthError(ForticnappError):
    category = ErrorCategory.AUTH_ERROR
    retryable = True


class ValidationError(ForticnappError):
    category = ErrorCategory.VALIDATION_ERROR
    retryable = False


class ApiError(ForticnappError):
    category = ErrorCategory.API_ERROR
    retryable = False


class NetworkError(ForticnappError):
    category = ErrorCategory.NETWORK_ERROR
    retryable = True


class SpecError(ForticnappError):
    category = ErrorCategory.SPEC_ERROR
    retryable = False


def error_from_exception(exc: Exception, *, operation_id: str | None = None) -> ForticnappError:
    """Wrap an arbitrary exception that escaped a narrower handler."""
    if isinstance(exc, ForticnappError):
        return exc
    return ApiError(str(exc) or exc.__class__.__name__, operation_id=operation_id, retryable=False)
