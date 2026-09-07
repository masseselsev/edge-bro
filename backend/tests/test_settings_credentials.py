"""GET /api/settings must never carry a bootstrap password; the credentials
endpoint is the only place that does.

`GET /api/settings` is loaded on every page view across the whole app —
timezone, orchestrator IP, the works — and used to carry
`bootstrap_credentials[].password` in plaintext along with it. Provisioning a
node genuinely needs that password client-side at the moment it submits an SSH
bootstrap request, so it can't simply be dropped; it moved to
`GET /api/settings/credentials`, fetched only by the three call sites that use
it (Add Node, Instant Provision, the credentials-management modal), instead of
riding along with everything else.
"""
import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base, get_db
import models
from main import app

TEST_DATABASE_URL = "sqlite:///./test_settings_credentials_db.db"


@pytest.fixture(scope="module")
def db_session():
    engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)
        if os.path.exists("./test_settings_credentials_db.db"):
            os.remove("./test_settings_credentials_db.db")


@pytest.fixture(scope="module")
def settings_row(db_session):
    settings = models.Settings(
        bootstrap_credentials=[
            {"id": "default", "username": "root", "password": "s3cr3t", "comment": "Default"},
            {"id": "spare", "username": "svc", "password": "hunter2", "comment": "Spare"},
        ],
        default_credentials_id="default",
    )
    db_session.add(settings)
    db_session.commit()
    return settings


@pytest.fixture
def admin_client(db_session, settings_row):
    def override_get_db():
        yield db_session
    app.dependency_overrides[get_db] = override_get_db

    from auth import require_admin
    app.dependency_overrides[require_admin] = lambda: models.User(username="test_admin", is_superadmin=True)

    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def anonymous_client(db_session, settings_row):
    def override_get_db():
        yield db_session
    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_settings_response_never_contains_a_password(admin_client):
    res = admin_client.get("/api/settings")
    assert res.status_code == 200
    body = res.json()

    assert body["bootstrap_credentials"], "fixture seeded credentials; the list should not be empty"
    for cred in body["bootstrap_credentials"]:
        assert "password" not in cred, (
            "GET /api/settings returned a password. It must return only "
            "CredentialSummary (id/username/comment) — see SettingsResponse."
        )
        assert cred["id"] and cred["username"]


def test_settings_response_never_contains_a_password_anywhere_in_the_body(admin_client):
    """Belt and braces: scan the raw JSON text, not just the known field."""
    res = admin_client.get("/api/settings")
    assert "s3cr3t" not in res.text
    assert "hunter2" not in res.text


def test_credentials_endpoint_returns_the_real_passwords(admin_client):
    res = admin_client.get("/api/settings/credentials")
    assert res.status_code == 200
    body = res.json()

    by_id = {c["id"]: c for c in body}
    assert by_id["default"]["password"] == "s3cr3t"
    assert by_id["spare"]["password"] == "hunter2"


def test_credentials_endpoint_requires_admin(anonymous_client):
    res = anonymous_client.get("/api/settings/credentials")
    assert res.status_code in (401, 403)


def test_settings_endpoint_still_requires_admin(anonymous_client):
    """Unchanged behaviour — this endpoint's guard was never the point."""
    res = anonymous_client.get("/api/settings")
    assert res.status_code in (401, 403)


def test_credentials_endpoint_with_no_settings_row_returns_empty_list():
    """A fresh install before the first GET /api/settings seeds a row.

    File-backed rather than `:memory:`: an in-memory SQLite engine hands out a
    fresh, empty database per connection unless pinned to a StaticPool, so the
    session used to create the schema and the one the request handler opens
    would not agree the `settings` table exists.
    """
    empty_db_path = "./test_settings_credentials_empty_db.db"
    engine = create_engine(f"sqlite:///{empty_db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    empty_db = sessionmaker(autocommit=False, autoflush=False, bind=engine)()

    def override_get_db():
        yield empty_db
    app.dependency_overrides[get_db] = override_get_db
    from auth import require_admin
    app.dependency_overrides[require_admin] = lambda: models.User(username="test_admin", is_superadmin=True)
    try:
        with TestClient(app) as c:
            res = c.get("/api/settings/credentials")
        assert res.status_code == 200
        assert res.json() == []
    finally:
        app.dependency_overrides.clear()
        empty_db.close()
        Base.metadata.drop_all(bind=engine)
        if os.path.exists(empty_db_path):
            os.remove(empty_db_path)


def test_save_settings_roundtrip_without_passwords_preserves_stored_passwords(admin_client):
    """When frontend updates settings (e.g. orchestrator_ip in IpPromptModal or language)
    using the payload from GET /api/settings, bootstrap_credentials carries CredentialSummary
    (no passwords). The POST must succeed and not blank existing stored passwords.
    """
    res = admin_client.get("/api/settings")
    assert res.status_code == 200
    payload = res.json()

    # Verify passwords are not in the GET response
    for c in payload["bootstrap_credentials"]:
        assert "password" not in c

    # Modify orchestrator_ip and POST back directly without injecting passwords
    payload["orchestrator_ip"] = "172.23.1.123"
    post_res = admin_client.post("/api/settings", json=payload)
    assert post_res.status_code == 200
    assert post_res.json()["orchestrator_ip"] == "172.23.1.123"

    # Verify that stored passwords on GET /api/settings/credentials remain intact
    creds_res = admin_client.get("/api/settings/credentials")
    assert creds_res.status_code == 200
    creds = {c["id"]: c for c in creds_res.json()}
    assert creds["default"]["password"] == "s3cr3t"
    assert creds["spare"]["password"] == "hunter2"

