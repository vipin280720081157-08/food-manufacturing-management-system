"""
Application configuration loaded from environment variables.

Database credentials and authentication secrets must never be
hardcoded or committed to version control.
"""

from __future__ import annotations

from functools import lru_cache
import secrets
import os
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated backend configuration."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="",
        case_sensitive=False,
        extra="ignore",
    )

    DATABASE_URL: str = Field(
        default="sqlite:///./food_manufacturing.db",
        min_length=1,
        description="PostgreSQL connection URL for SQLAlchemy.",
    )

    SECRET_KEY: SecretStr = Field(
        default_factory=lambda: SecretStr(secrets.token_urlsafe(48)),
        min_length=32,
        description="Secret used to sign authentication tokens.",
    )

    ALGORITHM: Literal["HS256", "HS384", "HS512"] = "HS256"

    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(
        default=30,
        ge=1,
        le=10080,
    )

    CORS_ORIGINS: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
    )

    ENVIRONMENT: Literal["development", "testing", "production"] = (
        "development"
    )

    DEMO_MODE: bool = Field(default=False)

    COMPANY_STATE: str = Field(default="Tamil Nadu", min_length=1, max_length=100)

    PORT: int = Field(
        default=8000,
        ge=1,
        le=65535,
    )

    @field_validator("DATABASE_URL")
    @classmethod
    def validate_database_url(cls, value: str) -> str:
        """Require a PostgreSQL URL compatible with Psycopg 3."""

        url = value.strip()

        supported_prefixes = (
            "postgresql://",
            "postgresql+psycopg://",
            "sqlite:///",
        )

        if not url.startswith(supported_prefixes):
            raise ValueError(
                "DATABASE_URL must use PostgreSQL, or SQLite for local development."
            )

        if url.startswith("sqlite:///"):
            if url[10:] in {"", ":memory:"}:
                raise ValueError("DATABASE_URL must identify a local SQLite file.")
            if os.getenv("ENVIRONMENT", "development").lower() == "production":
                raise ValueError("SQLite is only supported for local development and testing.")

        if url.startswith("postgresql://"):
            url = url.replace(
                "postgresql://",
                "postgresql+psycopg://",
                1,
            )

        return url


    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: object) -> object:
        """Accept JSON arrays or comma-separated origin strings."""

        if isinstance(value, str):
            stripped = value.strip()

            if stripped.startswith("["):
                return value

            return [
                origin.strip()
                for origin in stripped.split(",")
                if origin.strip()
            ]

        return value

    @field_validator("CORS_ORIGINS")
    @classmethod
    def validate_cors_origins(cls, origins: list[str]) -> list[str]:
        """Allow explicit HTTP or HTTPS origins only."""

        validated: list[str] = []

        for origin in origins:
            normalized = origin.strip().rstrip("/")

            if not normalized.startswith(
                ("http://", "https://")
            ):
                raise ValueError(
                    "Each CORS origin must start with "
                    "http:// or https://."
                )

            if "*" in normalized:
                raise ValueError(
                    "Wildcard CORS origins are not permitted."
                )

            if normalized not in validated:
                validated.append(normalized)

        return validated

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"

    @property
    def is_development(self) -> bool:
        return self.ENVIRONMENT == "development"

    @property
    def is_testing(self) -> bool:
        return self.ENVIRONMENT == "testing"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached, validated settings instance."""

    return Settings()


settings = get_settings()
