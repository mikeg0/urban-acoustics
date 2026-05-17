"""Backend runtime settings.

Mirrors the env-var table in plans/phase-1-contracts.md and the authoritative
list in contracts.ENV_VARS. Read once at startup and injected via the
`get_settings()` dependency so tests can override.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .contracts import (
    EVENT_INTENT_TTL_SECONDS as DEFAULT_INTENT_TTL,
    EVENT_MAX_SIZE_BYTES as DEFAULT_MAX_SIZE,
    EVENT_PLAYBACK_URL_TTL_SECONDS as DEFAULT_PLAYBACK_TTL,
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, case_sensitive=True, extra="ignore")

    # --- Postgres / Timescale ----------------------------------------------
    DATABASE_URL: str

    # --- MQTT (the API only needs these for health checks / device cmds) ---
    # Optional on the API process — the ingest worker is the primary consumer.
    MQTT_BROKER_URL: str | None = None
    MQTT_CA_FILE: str | None = None
    MQTT_CLIENT_CERT: str | None = None
    MQTT_CLIENT_KEY: str | None = None

    # --- Object store ------------------------------------------------------
    S3_ENDPOINT: str
    S3_PUBLIC_ENDPOINT: str
    S3_ACCESS_KEY: str
    S3_SECRET_KEY: str
    S3_BUCKET: str
    S3_REGION: str = "us-east-1"

    # --- Auth --------------------------------------------------------------
    JWT_SECRET: str
    JWT_TTL_SECONDS: int = 3600

    # --- Cert / event policy ----------------------------------------------
    DEVICE_CERT_TTL_DAYS: int = 365
    EVENT_MAX_SIZE_BYTES: int = DEFAULT_MAX_SIZE
    EVENT_INTENT_TTL_SECONDS: int = DEFAULT_INTENT_TTL
    EVENT_PLAYBACK_URL_TTL_SECONDS: int = DEFAULT_PLAYBACK_TTL

    # --- Modes / CORS / logging --------------------------------------------
    DEMO_MODE: bool = False
    ALLOWED_ORIGINS: str = Field(default="", description="Comma-separated origin list. Never '*' in prod.")
    LOG_LEVEL: str = "INFO"

    @field_validator("ALLOWED_ORIGINS")
    @classmethod
    def _no_wildcard(cls, v: str) -> str:
        if "*" in v:
            raise ValueError("ALLOWED_ORIGINS must not contain '*'")
        return v

    @property
    def allowed_origins(self) -> list[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
