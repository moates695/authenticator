"""Shared fixtures. Every test gets a throwaway SQLite file and its own app."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def make_client(tmp_path):
    """
    Builds a client with production-shaped defaults. Pass overrides to exercise a
    limit without waiting for the real one, e.g. `make_client(max_login_attempts=2)`.
    Two clients from the same test share the database, which is how a restart is
    simulated.
    """
    base = Settings(
        db_path=tmp_path / "test.db",
        token_ttl_seconds=3600,
        max_ciphertext_bytes=1024 * 1024,
        max_users=0,
        max_login_attempts=10,
        login_attempt_window_seconds=900,
        max_registrations_per_ip=5,
        registration_window_seconds=3600,
        enable_docs=False,
    )

    def _make(**overrides) -> TestClient:
        return TestClient(create_app(replace(base, **overrides)))

    return _make


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()
