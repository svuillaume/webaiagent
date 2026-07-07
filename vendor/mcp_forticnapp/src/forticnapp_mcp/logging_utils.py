"""Structured logging with automatic secret redaction.

Nothing in this codebase should ever pass a raw header dict, token, or secret
into a log call without going through redact_headers()/redact_text() first.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

# Header names (case-insensitive) whose values must never appear in logs.
_SENSITIVE_HEADER_NAMES = {
    "authorization",
    "x-lw-uaks",
    "api-key",
    "x-api-key",
    "cookie",
    "set-cookie",
}


def redact_headers(headers: dict[str, str] | None) -> dict[str, str]:
    """Return a copy of headers safe to log: sensitive values become a fixed marker."""
    if not headers:
        return {}
    redacted: dict[str, str] = {}
    for key, value in headers.items():
        if key.lower() in _SENSITIVE_HEADER_NAMES:
            redacted[key] = "***REDACTED***"
        else:
            redacted[key] = value
    return redacted


def redact_secret(value: str | None) -> str:
    """Render a secret-like value as a short, non-reversible fingerprint for logs."""
    if not value:
        return "<empty>"
    return f"***{len(value)}-chars***"


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = getattr(record, "extra_fields", None)
        if extra:
            payload.update(extra)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    """Configure root logging once, writing structured JSON lines to stderr.

    stderr is used deliberately: stdout is reserved for the MCP JSON-RPC
    transport when running with the stdio server.
    """
    root = logging.getLogger()
    root.setLevel(level.upper())
    root.handlers.clear()

    handler = logging.StreamHandler(stream=sys.stderr)
    handler.setFormatter(_JsonFormatter())
    root.addHandler(handler)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def log_fields(**fields: Any) -> dict[str, Any]:
    """Build the `extra` dict expected by _JsonFormatter, e.g.
    logger.info("event", extra=log_fields(operation_id=op_id, status_code=200))
    """
    return {"extra_fields": fields}
