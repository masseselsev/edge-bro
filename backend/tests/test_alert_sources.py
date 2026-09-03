import os
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models
from database import Base
from core.alert_sources import smart as smart_source
from core.alert_sources import thermal as thermal_source
from core.alert_sources import stale_backup as stale_backup_source
from core.alert_sources import node_offline as node_offline_source
from core.alert_sources import storage as storage_source
from core.alert_sources import SOURCES
from core.clock import utcnow

TEST_DATABASE_URL = "sqlite:///./test_alert_sources_db.db"


@pytest.fixture
def db_session():
    if os.path.exists("./test_alert_sources_db.db"):
        os.remove("./test_alert_sources_db.db")
    engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
    factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = factory()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()
        if os.path.exists("./test_alert_sources_db.db"):
            os.remove("./test_alert_sources_db.db")


def make_node(db, hostname="node-1", cpu="11th Gen Intel(R) Core(TM) i5-1145G7E @ 2.60GHz"):
    node = models.Node(hostname=hostname, ip_address="10.0.0.1", ssh_port=2222, cpu_info=cpu)
    db.add(node)
    db.commit()
    db.refresh(node)
    return node


def make_group(db, name="group-1"):
    # interval has no column default and is NOT NULL -- must be supplied
    # explicitly or the commit fails the schema's constraint.
    group = models.BackupGroup(name=name, interval="weekly")
    db.add(group)
    db.commit()
    db.refresh(group)
    return group


def add_smart(db, node, grade, device="/dev/sda"):
    snapshot = models.SmartSnapshot(
        node_id=node.id, captured_at=utcnow(), device=device,
        protocol="SATA", model="Test SSD", health_passed=(grade != "REPLACE"),
        temperature_c=40, power_on_hours=100, written_bytes=1_000_000,
        percent_used=1.0, score=90 if grade == "OK" else 40, grade=grade,
        subscores=[], overrides=[], advisories=[],
    )
    db.add(snapshot)
    db.commit()
    return snapshot


def add_fit(db, node, theta=1.5, rejection="OK", days_ago=1):
    start = utcnow() - timedelta(days=days_ago)
    fit = models.ThermalFit(
        node_id=node.id, window_start=start, window_end=start + timedelta(hours=4),
        rejection=rejection, n_samples=200, excitation=0.3,
        theta_c_per_w=theta, theta_normalised=theta, tau_seconds=1800.0,
        t_ambient_c=25.0, mean_temp_c=45.0, r_squared=0.9,
    )
    db.add(fit)
    db.commit()
    return fit


from core.alert_config import get as get_alert_config, DEFAULTS as ALERT_CONFIG_DEFAULTS


def test_alert_config_returns_defaults_when_settings_missing(db_session):
    cfg = get_alert_config(db_session, "stale_backup")
    assert cfg == ALERT_CONFIG_DEFAULTS["stale_backup"]


def test_alert_config_merges_stored_over_defaults(db_session):
    settings = models.Settings(alert_config={"stale_backup": {"days": 10}})
    db_session.add(settings)
    db_session.commit()

    cfg = get_alert_config(db_session, "stale_backup")

    assert cfg["days"] == 10
    assert cfg["enabled"] is True  # untouched key still falls back to the default


def test_alert_config_disabling_a_source_is_respected(db_session):
    settings = models.Settings(alert_config={"smart": {"enabled": False}})
    db_session.add(settings)
    db_session.commit()

    cfg = get_alert_config(db_session, "smart")

    assert cfg["enabled"] is False


@pytest.mark.parametrize("grade,expect_candidate,expect_severity", [
    ("OK", False, None),
    ("UNKNOWN", False, None),
    ("WATCH", True, "WATCH"),
    ("REPLACE", True, "ALERT"),
])
def test_smart_source_maps_grade_to_severity(db_session, grade, expect_candidate, expect_severity):
    node = make_node(db_session)
    add_smart(db_session, node, grade)
    candidates = smart_source.evaluate(db_session)
    if expect_candidate:
        assert len(candidates) == 1
        assert candidates[0].severity == expect_severity
        assert candidates[0].dedup_key == f"smart:{node.id}:/dev/sda"
    else:
        assert candidates == []


def test_smart_source_uses_only_the_latest_snapshot_per_device(db_session):
    node = make_node(db_session)
    add_smart(db_session, node, "REPLACE")
    add_smart(db_session, node, "OK")  # newer, same device -> should win
    candidates = smart_source.evaluate(db_session)
    assert candidates == []


def test_thermal_source_produces_no_candidate_when_insufficient_data(db_session):
    node = make_node(db_session)
    candidates = thermal_source.evaluate(db_session)
    assert candidates == []


def test_smart_source_returns_nothing_when_disabled(db_session):
    node = make_node(db_session)
    add_smart(db_session, node, grade="REPLACE")
    settings = models.Settings(alert_config={"smart": {"enabled": False}})
    db_session.add(settings)
    db_session.commit()

    assert smart_source.evaluate(db_session) == []


def test_thermal_source_returns_nothing_when_disabled(db_session):
    # Create a cohort of nodes with multiple fits each so thermal comparison triggers
    now = utcnow()
    bad_node = models.Node(hostname="bad-node", ip_address="10.0.0.100", ssh_port=2222,
                           cpu_info="11th Gen Intel(R) Core(TM) i5-1145G7E @ 2.60GHz")
    db_session.add(bad_node)
    db_session.flush()
    for i in range(3):
        add_fit(db_session, bad_node, theta=3.0, rejection="OK", days_ago=i+1)

    # Add normal peers so the outlier is detectable (need MIN_COHORT_SIZE=5)
    for peer_idx in range(4):
        peer = models.Node(hostname=f"peer-{peer_idx}", ip_address=f"10.0.0.{101+peer_idx}",
                          ssh_port=2222, cpu_info="11th Gen Intel(R) Core(TM) i5-1145G7E @ 2.60GHz")
        db_session.add(peer)
        db_session.flush()
        for i in range(3):
            add_fit(db_session, peer, theta=1.0, rejection="OK", days_ago=i+1)

    settings = models.Settings(alert_config={"thermal": {"enabled": False}})
    db_session.add(settings)
    db_session.commit()

    assert thermal_source.evaluate(db_session) == []


def test_stale_backup_flags_a_node_past_the_threshold(db_session):
    group = make_group(db_session)
    node = make_node(db_session)
    node.group_id = group.id
    node.status = "READY"
    node.last_backup = utcnow() - timedelta(days=10)
    db_session.commit()

    candidates = stale_backup_source.evaluate(db_session)

    assert len(candidates) == 1
    assert candidates[0].module == "stale_backup"
    assert candidates[0].node_id == node.id
    assert candidates[0].severity == "ALERT"


def test_stale_backup_ignores_a_node_within_the_threshold(db_session):
    group = make_group(db_session)
    node = make_node(db_session)
    node.group_id = group.id
    node.status = "READY"
    node.last_backup = utcnow() - timedelta(days=1)
    db_session.commit()

    assert stale_backup_source.evaluate(db_session) == []


def test_stale_backup_ignores_a_paused_node(db_session):
    group = make_group(db_session)
    node = make_node(db_session)
    node.group_id = group.id
    node.status = "READY"
    node.backup_paused = True
    node.last_backup = utcnow() - timedelta(days=30)
    db_session.commit()

    assert stale_backup_source.evaluate(db_session) == []


def test_stale_backup_ignores_a_node_with_no_group(db_session):
    node = make_node(db_session)
    node.status = "READY"
    node.last_backup = utcnow() - timedelta(days=30)
    db_session.commit()

    assert stale_backup_source.evaluate(db_session) == []


def test_stale_backup_flags_a_ready_node_that_never_backed_up(db_session):
    group = make_group(db_session)
    node = make_node(db_session)
    node.group_id = group.id
    node.status = "READY"
    db_session.commit()

    candidates = stale_backup_source.evaluate(db_session)

    assert len(candidates) == 1
    assert "Never backed up" in candidates[0].title


def test_stale_backup_ignores_a_node_still_being_bootstrapped(db_session):
    group = make_group(db_session)
    node = make_node(db_session)
    node.group_id = group.id
    node.status = "NEEDS_BOOTSTRAP"
    db_session.commit()

    assert stale_backup_source.evaluate(db_session) == []


def test_stale_backup_respects_the_disabled_flag(db_session):
    group = make_group(db_session)
    node = make_node(db_session)
    node.group_id = group.id
    node.status = "READY"
    node.last_backup = utcnow() - timedelta(days=30)
    settings = models.Settings(alert_config={"stale_backup": {"enabled": False}})
    db_session.add(settings)
    db_session.commit()

    assert stale_backup_source.evaluate(db_session) == []


def test_node_offline_opens_at_watch_with_no_prior_alert(db_session):
    node = make_node(db_session)
    node.status = "OFFLINE"
    db_session.commit()

    candidates = node_offline_source.evaluate(db_session)

    assert len(candidates) == 1
    assert candidates[0].severity == "WATCH"
    assert candidates[0].dedup_key == f"node_offline:{node.id}"


def test_node_offline_escalates_to_alert_past_the_threshold(db_session):
    node = make_node(db_session)
    node.status = "OFFLINE"
    db_session.commit()
    # Simulate a prior sweep having already opened this alert 10 days ago.
    db_session.add(models.Alert(
        module="node_offline", node_id=node.id, dedup_key=f"node_offline:{node.id}",
        severity="WATCH", status="OPEN",
        title="Offline: node-1",
        first_seen=utcnow() - timedelta(days=10), last_seen=utcnow() - timedelta(days=10),
    ))
    db_session.commit()

    candidates = node_offline_source.evaluate(db_session)

    assert len(candidates) == 1
    assert candidates[0].severity == "ALERT"


def test_node_offline_ignores_a_node_that_is_not_offline(db_session):
    node = make_node(db_session)
    node.status = "READY"
    db_session.commit()

    assert node_offline_source.evaluate(db_session) == []


def test_node_offline_respects_the_disabled_flag(db_session):
    node = make_node(db_session)
    node.status = "OFFLINE"
    settings = models.Settings(alert_config={"node_offline": {"enabled": False}})
    db_session.add(settings)
    db_session.commit()

    assert node_offline_source.evaluate(db_session) == []


def _usage(total, free):
    return MagicMock(total=total, free=free)


def test_storage_flags_a_path_below_alert_percent(db_session):
    with patch("core.alert_sources.storage.repo_paths.all_shard_paths", return_value=["/data/borg/fleet"]), \
         patch("os.path.isdir", return_value=False), \
         patch("shutil.disk_usage", return_value=_usage(100, 2)):  # 2% free
        candidates = storage_source.evaluate(db_session)

    assert len(candidates) == 1
    assert candidates[0].severity == "ALERT"
    assert candidates[0].module == "storage"


def test_storage_flags_a_path_below_watch_percent_only(db_session):
    with patch("core.alert_sources.storage.repo_paths.all_shard_paths", return_value=["/data/borg/fleet"]), \
         patch("os.path.isdir", return_value=False), \
         patch("shutil.disk_usage", return_value=_usage(100, 10)):  # 10% free
        candidates = storage_source.evaluate(db_session)

    assert len(candidates) == 1
    assert candidates[0].severity == "WATCH"


def test_storage_ignores_a_healthy_path(db_session):
    with patch("core.alert_sources.storage.repo_paths.all_shard_paths", return_value=["/data/borg/fleet"]), \
         patch("os.path.isdir", return_value=False), \
         patch("shutil.disk_usage", return_value=_usage(100, 50)):  # 50% free
        assert storage_source.evaluate(db_session) == []


def test_storage_skips_an_unreadable_path_without_raising(db_session):
    with patch("core.alert_sources.storage.repo_paths.all_shard_paths", return_value=["/data/borg/fleet"]), \
         patch("os.path.isdir", return_value=False), \
         patch("shutil.disk_usage", side_effect=OSError("no such path")):
        assert storage_source.evaluate(db_session) == []


def test_storage_respects_the_disabled_flag(db_session):
    settings = models.Settings(alert_config={"storage": {"enabled": False}})
    db_session.add(settings)
    db_session.commit()
    with patch("core.alert_sources.storage.repo_paths.all_shard_paths", return_value=["/data/borg/fleet"]), \
         patch("shutil.disk_usage", return_value=_usage(100, 1)):
        assert storage_source.evaluate(db_session) == []


def test_registry_has_all_five_sources():
    assert set(SOURCES.keys()) == {
        "smart", "thermal", "stale_backup", "node_offline", "storage",
    }
