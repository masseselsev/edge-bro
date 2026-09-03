import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
import models
import main
import schemas


@pytest.fixture
def db_session():
    """In-memory SQLite session, fresh per test."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(autocommit=False, autoflush=False, bind=engine)()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)


def test_new_settings_row_seeds_orchestrator_ip_from_env(db_session, monkeypatch):
    """A fresh install must show the .env value in Settings, not an empty default."""
    monkeypatch.setenv("ORCHESTRATOR_IP", "10.20.30.40")

    settings = models.Settings()
    db_session.add(settings)
    db_session.commit()

    assert settings.orchestrator_ip == "10.20.30.40"


def test_new_settings_row_without_env_stays_empty(db_session, monkeypatch):
    monkeypatch.delenv("ORCHESTRATOR_IP", raising=False)

    settings = models.Settings()
    db_session.add(settings)
    db_session.commit()

    assert settings.orchestrator_ip == ""


def test_upgrade_backfills_empty_orchestrator_ip(db_session, monkeypatch):
    """Existing deployments created before seeding get the .env value on startup."""
    monkeypatch.delenv("ORCHESTRATOR_IP", raising=False)
    settings = models.Settings()
    db_session.add(settings)
    db_session.commit()
    assert settings.orchestrator_ip == ""

    monkeypatch.setenv("ORCHESTRATOR_IP", "10.20.30.40")
    main.upgrade_settings(db_session)

    assert settings.orchestrator_ip == "10.20.30.40"


def test_upgrade_does_not_overwrite_user_configured_ip(db_session, monkeypatch):
    """A value set through the UI wins over .env — the DB is the source of truth."""
    monkeypatch.setenv("ORCHESTRATOR_IP", "10.20.30.40")
    settings = models.Settings(orchestrator_ip="192.168.5.5")
    db_session.add(settings)
    db_session.commit()

    main.upgrade_settings(db_session)

    assert settings.orchestrator_ip == "192.168.5.5"


def test_model_default_server_name_passes_schema_validation(db_session):
    """The seeded default must survive response serialisation.

    GET /api/settings returns SettingsResponse, so a model default the
    validator rejects makes the endpoint 500 on every fresh install.
    """
    settings = models.Settings()
    db_session.add(settings)
    db_session.commit()

    schemas.SettingsResponse.model_validate(settings)


@pytest.mark.parametrize("name", ["edge-bro", "orchestrator", "main_server_01", "edge-bro-2"])
def test_server_name_accepts_valid_names(name):
    assert schemas.SettingsBase(server_name=name).server_name == name


@pytest.mark.parametrize("given,expected", [("Edge-BRO", "edge-bro"), ("ORCHESTRATOR", "orchestrator")])
def test_server_name_is_normalised_to_lowercase(given, expected):
    assert schemas.SettingsBase(server_name=given).server_name == expected


@pytest.mark.parametrize("name", ["edge bro", "edge/bro", "edge.bro", ".hidden", "-leading", ""])
def test_server_name_rejects_unsafe_names(name):
    """The name is used as an ISO filename prefix, so it must stay path-safe."""
    with pytest.raises(ValueError):
        schemas.SettingsBase(server_name=name)


def test_new_settings_row_gets_the_curated_default_exclusions(db_session):
    settings = models.Settings()
    db_session.add(settings)
    db_session.commit()

    patterns = [e["pattern"] for e in settings.global_exclusions]
    assert "/var/opt/edge/trainer/*" in patterns
    assert "/var/opt/edge/*.iso" in patterns
    assert "/tmp/*" in patterns
    assert "/home/*" in patterns
    assert len(settings.global_exclusions) == 19


def test_alert_config_defaults_to_none(db_session):
    settings = models.Settings()
    db_session.add(settings)
    db_session.commit()
    db_session.refresh(settings)
    assert settings.alert_config is None


@pytest.fixture
def client():
    """TestClient runs requests on a background thread, so this needs the
    same dedicated StaticPool engine as
    `test_only_superadmin_can_change_admin_key_terminal_access` below —
    a bare `sqlite:///:memory:` hands each thread its own unmigrated
    database and every request 500s with `no such table: settings`.
    """
    from fastapi.testclient import TestClient
    from sqlalchemy.pool import StaticPool
    from database import get_db
    from main import app
    from auth import require_admin

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(autocommit=False, autoflush=False, bind=engine)()

    settings = models.Settings()
    db.add(settings)
    db.commit()

    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_admin] = lambda: models.User(username="tester-admin", is_superadmin=True)

    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.clear()
        db.close()
        Base.metadata.drop_all(bind=engine)


def test_alert_config_round_trips_through_the_settings_api(client):
    payload = client.get("/api/settings").json()
    payload["alert_config"] = {"stale_backup": {"enabled": False, "days": 7}}
    # GET returns bootstrap_credentials without passwords (CredentialSummary,
    # see schemas/settings.py); POST requires them back (CredentialSchema).
    # Unrelated to alert_config — fill in dummies so the round trip validates.
    for cred in payload["bootstrap_credentials"]:
        cred["password"] = "dummy"

    res = client.post("/api/settings", json=payload)

    assert res.status_code == 200
    assert res.json()["alert_config"] == {"stale_backup": {"enabled": False, "days": 7}}

    # And it actually persisted, not just echoed back from the request body.
    assert client.get("/api/settings").json()["alert_config"] == {"stale_backup": {"enabled": False, "days": 7}}


def test_only_superadmin_can_change_admin_key_terminal_access():
    """Not the module's `db_session` fixture: that engine is a bare
    `sqlite:///:memory:` with no `poolclass=StaticPool`, so SQLAlchemy's
    default `SingletonThreadPool` hands each *thread* its own separate,
    unmigrated in-memory database — and `TestClient` runs requests on a
    background thread. The symptom was `OperationalError: no such table:
    settings` even though the row had just been inserted moments earlier.
    A dedicated `StaticPool` engine shares one real connection across
    threads, which is what a `TestClient`-driven test actually needs."""
    from fastapi.testclient import TestClient
    from sqlalchemy.pool import StaticPool
    from database import get_db
    from main import app
    from auth import require_admin

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db_session = sessionmaker(autocommit=False, autoflush=False, bind=engine)()

    settings = models.Settings()
    db_session.add(settings)
    db_session.commit()

    app.dependency_overrides[get_db] = lambda: db_session
    app.dependency_overrides[require_admin] = lambda: models.User(username="plain-admin", is_superadmin=False)

    base_payload = {
        "borg_ssh_port": 12345, "keep_daily": 7, "keep_weekly": 4, "keep_monthly": 6,
        "global_exclusions": [], "orchestrator_ip": "", "orchestrator_behind_nat": False,
        "timezone": "Browser Local", "language": "en", "default_compression": "zstd:3",
        "default_cpu_quota": 30, "default_rate_limit": None, "server_ips": [],
        "max_kiosk_isos": 5, "server_name": "edge-bro", "bootstrap_credentials": [],
        "default_credentials_id": "", "server_net_capacity_mbps": 1000,
        "thermal_fit_retention_days": None, "allow_admin_key_terminal_access": True,
    }

    try:
        with TestClient(app) as c:
            resp = c.post("/api/settings", json=base_payload)
        assert resp.status_code == 200

        db_session.expire_all()
        settings = db_session.query(models.Settings).first()
        assert settings.allow_admin_key_terminal_access is False  # a plain admin's attempt is ignored

        app.dependency_overrides[require_admin] = lambda: models.User(username="root-admin", is_superadmin=True)
        with TestClient(app) as c:
            resp = c.post("/api/settings", json=base_payload)
        assert resp.status_code == 200

        db_session.expire_all()
        settings = db_session.query(models.Settings).first()
        assert settings.allow_admin_key_terminal_access is True  # a superadmin's attempt applies
    finally:
        app.dependency_overrides.clear()
        db_session.close()
        Base.metadata.drop_all(bind=engine)
