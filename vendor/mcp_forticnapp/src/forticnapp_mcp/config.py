"""Environment-driven configuration, validated once at startup so the server
fails fast with a clear message instead of surfacing a confusing error on the
first tool call.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_VALID_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
_VALID_AUTH_MODES = ("api_key_to_token", "api_key", "bearer_static")


class ConfigError(Exception):
    """Raised for missing/invalid configuration. Always caught at startup in main.py
    and reported as a clear, actionable message -- never a raw traceback."""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    forticnapp_api_base_url: str
    forticnapp_openapi_spec: Path = Path("./lw.yaml")

    forticnapp_key_id: str | None = None
    forticnapp_api_secret: SecretStr | None = None

    forticnapp_auth_mode: Literal["api_key_to_token", "api_key", "bearer_static"] = "api_key_to_token"
    forticnapp_token_url: str = "/api/v2/access/tokens"
    forticnapp_token_header_name: str = "Authorization"
    forticnapp_api_key_header_name: str = "X-LW-UAKS"
    forticnapp_api_key_prefix: str = ""
    forticnapp_bearer_prefix: str = "Bearer"
    forticnapp_token_expiry_seconds: int = 3600

    forticnapp_enabled_tags: str = (
        "Alerts,Entities,Vulnerabilities,VulnerabilityExceptions,Inventory,Policies,Reports,"
        "CloudAccounts,Events"
    )
    enable_mutation_tools: bool = False

    request_timeout_seconds: float = Field(default=30.0, gt=0)
    http_max_retries: int = Field(default=3, ge=0)
    max_response_bytes: int = Field(default=5_000_000, gt=0)

    log_level: str = "INFO"

    @property
    def enabled_tags(self) -> set[str]:
        return {tag.strip() for tag in self.forticnapp_enabled_tags.split(",") if tag.strip()}

    @field_validator("log_level")
    @classmethod
    def _validate_log_level(cls, value: str) -> str:
        upper = value.upper()
        if upper not in _VALID_LOG_LEVELS:
            raise ValueError(f"LOG_LEVEL must be one of {sorted(_VALID_LOG_LEVELS)}, got {value!r}")
        return upper

    @field_validator("forticnapp_api_base_url")
    @classmethod
    def _normalize_base_url(cls, value: str) -> str:
        if not value:
            raise ValueError("FORTICNAPP_API_BASE_URL is required")
        return value.rstrip("/")

    @model_validator(mode="after")
    def _validate_auth_material(self) -> "Settings":
        if self.forticnapp_api_secret is None:
            raise ValueError(
                "FORTICNAPP_API_SECRET is required for every auth mode: it carries the secret used to "
                "request a token (api_key_to_token/api_key modes) or the pre-issued bearer token itself "
                "(bearer_static mode)."
            )
        if self.forticnapp_auth_mode == "api_key_to_token" and not self.forticnapp_key_id:
            raise ValueError("FORTICNAPP_KEY_ID is required when FORTICNAPP_AUTH_MODE=api_key_to_token")
        return self

    def validate_spec_path(self) -> Path:
        """Separate from field validation so a missing spec file produces one clear
        error rather than being buried among other pydantic ValidationErrors."""
        if not self.forticnapp_openapi_spec.exists():
            raise ConfigError(
                f"OpenAPI spec not found at '{self.forticnapp_openapi_spec}'. "
                "Set FORTICNAPP_OPENAPI_SPEC to the path of your lw.yaml/lw.json file."
            )
        return self.forticnapp_openapi_spec


def load_settings() -> Settings:
    """Entry point used by main.py. Wraps pydantic's ValidationError in a ConfigError
    with a flattened, human-readable message so startup failures are unambiguous."""
    from pydantic import ValidationError

    try:
        settings = Settings()  # type: ignore[call-arg]
    except ValidationError as exc:
        details = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors())
        raise ConfigError(f"Invalid configuration: {details}") from exc

    settings.validate_spec_path()
    return settings
