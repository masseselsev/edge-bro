from unittest.mock import patch, MagicMock
import subprocess
import pytest
from routers.network import (
    get_network_status,
    scan_wifi,
    connect_wifi,
    configure_wired,
    WifiConnectRequest,
    WiredConfigRequest,
    prefix_to_mask,
    mask_to_prefix
)


def test_prefix_to_mask():
    assert prefix_to_mask(24) == "255.255.255.0"
    assert prefix_to_mask(32) == "255.255.255.255"
    assert prefix_to_mask(0) == "0.0.0.0"
    assert prefix_to_mask(16) == "255.255.0.0"


def test_mask_to_prefix():
    assert mask_to_prefix("255.255.255.0") == 24
    assert mask_to_prefix("255.255.0.0") == 16
    assert mask_to_prefix("255.255.255.255") == 32
    assert mask_to_prefix("invalid") == 24


@patch("subprocess.check_output")
def test_get_network_status_mock_fallback(mock_check):
    # Simulate nmcli executable not found or raising exception
    mock_check.side_effect = subprocess.SubprocessError("nmcli not found")
    res = get_network_status()
    # It should fall back to mock data
    assert res.wired.connected is True
    assert res.wired.ip == "192.168.1.50"
    assert res.wifi.connected is False


@patch("subprocess.check_output")
def test_get_network_status_success(mock_check):
    # Mocking standard nmcli output for devices and details
    def side_effect(cmd, *args, **kwargs):
        if "device" in cmd and "show" not in cmd:
            return b"eth0:ethernet:connected\nwlan0:wifi:disconnected\n"
        elif "device" in cmd and "show" in cmd:
            return b"IP4.ADDRESS[1]:192.168.1.50/24\nIP4.GATEWAY:192.168.1.1\nIP4.DNS[1]:8.8.8.8\n"
        elif "connection" in cmd and "show" in cmd and "--active" in cmd:
            return b"Wired connection 1:802-3-ethernet:eth0:yes\n"
        elif "connection" in cmd and "show" in cmd:
            return b"ipv4.method:manual\nipv4.dns:8.8.8.8\n"
        return b""

    mock_check.side_effect = side_effect

    res = get_network_status()
    assert res.wired.connected is True
    assert res.wired.device == "eth0"
    assert res.wired.ip == "192.168.1.50"
    assert res.wired.netmask == "255.255.255.0"
    assert res.wired.gateway == "192.168.1.1"
    assert res.wired.dns_servers == ["8.8.8.8"]
    assert res.wired.mode == "manual"
    assert res.wired.dns_mode == "manual"
    assert res.wifi.connected is False


@patch("subprocess.check_output")
def test_wifi_scan_mock(mock_check):
    # Standard scanning output with a colon in one of the SSIDs
    # and WPA2 security, sorted signal strengths
    mock_check.return_value = (
        b"Office\\:5G:95:WPA2:no\n"
        b"Guest_Net:45:Open:no\n"
        b"Home_Wifi:80:WPA1 WPA2:yes\n"
    )

    res = scan_wifi()
    assert len(res) == 3
    # Sorted by signal descending
    assert res[0].ssid == "Office:5G"
    assert res[0].signal == 95
    assert res[0].security == "WPA2"
    assert res[0].active is False

    assert res[1].ssid == "Home_Wifi"
    assert res[1].signal == 80
    assert res[1].security == "WPA1 WPA2"
    assert res[1].active is True

    assert res[2].ssid == "Guest_Net"
    assert res[2].signal == 45
    assert res[2].security == "Open"
    assert res[2].active is False


@patch("subprocess.check_call")
def test_connect_wifi_success(mock_call):
    req = WifiConnectRequest(ssid="Office_5G", password="super_password", hidden=True)
    res = connect_wifi(req)
    assert res.status == "SUCCESS"
    assert mock_call.call_count == 1
    args, kwargs = mock_call.call_args
    assert args[0] == ["nmcli", "device", "wifi", "connect", "Office_5G", "password", "super_password", "hidden", "yes"]
    assert kwargs.get("timeout") == 30


@patch("subprocess.check_call")
@patch("subprocess.check_output")
def test_configure_wired_manual(mock_output, mock_call):
    # Active connection query output
    mock_output.return_value = b"Wired connection 1:802-3-ethernet:eth0:yes\n"

    req = WiredConfigRequest(
        mode="manual",
        ip_address="192.168.1.100",
        netmask="255.255.255.0",
        gateway="192.168.1.1",
        dns_mode="manual",
        dns_servers=["1.1.1.1", "8.8.8.8"]
    )
    res = configure_wired(req)
    assert res.status == "SUCCESS"

    # Verify connection modify and up calls
    calls = [call[0][0] for call in mock_call.call_args_list]
    assert ["nmcli", "connection", "modify", "Wired connection 1", "ipv4.method", "manual", "ipv4.addresses", "192.168.1.100/24"] in calls
    assert ["nmcli", "connection", "modify", "Wired connection 1", "ipv4.gateway", "192.168.1.1"] in calls
    assert ["nmcli", "connection", "modify", "Wired connection 1", "ipv4.dns", "1.1.1.1 8.8.8.8"] in calls
    assert ["nmcli", "connection", "modify", "Wired connection 1", "ipv4.ignore-auto-dns", "yes"] in calls
    assert ["nmcli", "connection", "up", "Wired connection 1"] in calls


def test_bootstrap_node_task_passes_orchestrator_ip(monkeypatch):
    import os
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from database import Base
    import models
    import tasks
    import ansible_utils

    TEST_DATABASE_URL = "sqlite:///./test_network_orchestrator.db"
    if os.path.exists("./test_network_orchestrator.db"):
        os.remove("./test_network_orchestrator.db")
    engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    
    # Initialize DB data using a temporary session
    db = TestingSessionLocal()
    settings = db.query(models.Settings).first()
    if not settings:
        settings = models.Settings(orchestrator_ip="192.168.100.100")
        db.add(settings)
    else:
        settings.orchestrator_ip = "192.168.100.100"
    
    node = models.Node(hostname="test-node", ip_address="192.168.100.1", status="NEEDS_BOOTSTRAP")
    db.add(node)
    db.commit()
    node_id = node.id
    db.close()

    # Mock SessionLocal with TestingSessionLocal (not the db instance).
    # Two bindings: `tasks.SessionLocal` for the task module, and the one
    # core.db_session resolves for every session_scope() in the process.
    monkeypatch.setattr("tasks.SessionLocal", TestingSessionLocal)
    monkeypatch.setattr("database.SessionLocal", TestingSessionLocal)

    passed_vars = {}

    def mock_run_playbook(task_id, playbook_name, host_ip, ssh_port, extra_vars, ssh_password=None):
        nonlocal passed_vars
        passed_vars = extra_vars
        return {"status": "SUCCESS", "parsed_data": {}}

    monkeypatch.setattr("tasks.run_ansible_playbook", mock_run_playbook)
    # mock ensure_orchestrator_ssh_key too to avoid file access
    monkeypatch.setattr("tasks.ensure_orchestrator_ssh_key", lambda: "ssh-ed25519 AAA...")
    
    # Mock celery task request to provide a task ID
    class MockRequest:
        id = "test-task-id"
    monkeypatch.setattr("celery.app.task.Task.request", MockRequest())

    # Run task
    tasks.run_bootstrap_task(node_id=node_id, bootstrap_user="root", ssh_password="pwd")
    
    # Cleanup DB
    Base.metadata.drop_all(bind=engine)
    if os.path.exists("./test_network_orchestrator.db"):
        os.remove("./test_network_orchestrator.db")

    assert passed_vars.get("orchestrator_ip") == "192.168.100.100"


def test_bootstrap_node_task_passes_force_orchestrator_proxy(monkeypatch):
    import os
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from database import Base
    import models
    import tasks

    TEST_DATABASE_URL = "sqlite:///./test_network_force_proxy.db"
    if os.path.exists("./test_network_force_proxy.db"):
        os.remove("./test_network_force_proxy.db")
    engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    
    # Initialize DB data using a temporary session
    db = TestingSessionLocal()
    node = models.Node(hostname="test-node-force", ip_address="192.168.100.2", status="NEEDS_BOOTSTRAP")
    db.add(node)
    db.commit()
    node_id = node.id
    db.close()

    monkeypatch.setattr("tasks.SessionLocal", TestingSessionLocal)
    monkeypatch.setattr("database.SessionLocal", TestingSessionLocal)

    passed_vars = {}

    def mock_run_playbook(task_id, playbook_name, host_ip, ssh_port, extra_vars, ssh_password=None):
        nonlocal passed_vars
        passed_vars = extra_vars
        return {"status": "SUCCESS", "parsed_data": {}}

    monkeypatch.setattr("tasks.run_ansible_playbook", mock_run_playbook)
    monkeypatch.setattr("tasks.ensure_orchestrator_ssh_key", lambda: "ssh-ed25519 AAA...")
    
    class MockRequest:
        id = "test-task-id-force"
    monkeypatch.setattr("celery.app.task.Task.request", MockRequest())

    # Run task with force_orchestrator_proxy=True
    tasks.run_bootstrap_task(node_id=node_id, bootstrap_user="root", ssh_password="pwd", force_orchestrator_proxy=True)
    
    Base.metadata.drop_all(bind=engine)
    if os.path.exists("./test_network_force_proxy.db"):
        os.remove("./test_network_force_proxy.db")

    assert passed_vars.get("force_orchestrator_proxy") is True


def test_bootstrap_refuses_when_backup_is_running(monkeypatch):
    import os
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from database import Base
    import models
    import tasks

    TEST_DATABASE_URL = "sqlite:///./test_network_backup_running.db"
    if os.path.exists("./test_network_backup_running.db"):
        os.remove("./test_network_backup_running.db")
    engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    db = TestingSessionLocal()
    node = models.Node(hostname="test-node-busy", ip_address="192.168.100.3", status="ONLINE")
    db.add(node)
    db.commit()
    node_id = node.id
    db.close()

    monkeypatch.setattr("tasks.SessionLocal", TestingSessionLocal)
    monkeypatch.setattr("database.SessionLocal", TestingSessionLocal)

    playbook_called = False

    def mock_run_playbook(task_id, playbook_name, host_ip, ssh_port, extra_vars, ssh_password=None):
        nonlocal playbook_called
        playbook_called = True
        return {"status": "SUCCESS", "parsed_data": {}}

    monkeypatch.setattr("tasks.run_ansible_playbook", mock_run_playbook)
    monkeypatch.setattr("tasks.ensure_orchestrator_ssh_key", lambda: "ssh-ed25519 AAA...")
    monkeypatch.setattr("core.scheduler.is_backup_lock_live", lambda nid: True)

    class MockRequest:
        id = "test-task-id-busy"
    monkeypatch.setattr("celery.app.task.Task.request", MockRequest())

    result = tasks.run_bootstrap_task(node_id=node_id, bootstrap_user="root", ssh_password="pwd")

    db = TestingSessionLocal()
    log = db.query(models.TaskLog).filter(models.TaskLog.id == "test-task-id-busy").first()
    db.close()

    Base.metadata.drop_all(bind=engine)
    if os.path.exists("./test_network_backup_running.db"):
        os.remove("./test_network_backup_running.db")

    assert playbook_called is False
    assert result["status"] == "FAILED"
    assert log is not None
    assert log.status == "FAILED"
    assert "backup" in log.log_output.lower()


@patch("subprocess.check_call")
@patch("subprocess.check_output")
def test_configure_wired_dhcp(mock_output, mock_call):
    # No active connections fallback to listing all connections
    mock_output.side_effect = [b"", b"Wired connection 2:802-3-ethernet:eth1\n"]

    req = WiredConfigRequest(
        mode="auto",
        dns_mode="auto"
    )
    res = configure_wired(req)
    assert res.status == "SUCCESS"

    # Verify method set to auto and dns cleared
    calls = [call[0][0] for call in mock_call.call_args_list]
    assert ["nmcli", "connection", "modify", "Wired connection 2", "ipv4.method", "auto", "ipv4.addresses", "", "ipv4.gateway", ""] in calls
    assert ["nmcli", "connection", "modify", "Wired connection 2", "ipv4.dns", ""] in calls
    assert ["nmcli", "connection", "modify", "Wired connection 2", "ipv4.ignore-auto-dns", "no"] in calls
    assert ["nmcli", "connection", "up", "Wired connection 2"] in calls


# ─────────────────────────────────────────────────────────────────────────────
# Bandwidth endpoint tests
# ─────────────────────────────────────────────────────────────────────────────

import json
import time as time_module
import routers.network as network_module
from routers.network import get_network_bytes, get_bandwidth, _fallback_traffic_cache


FAKE_PROC_NET_DEV = """\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:   1000     100    0    0    0     0          0         0     1000     100    0    0    0     0       0          0
  eth0: 5000000    5000    0    0    0     0          0         0  3000000    4000    0    0    0     0       0          0
docker0:    500      10    0    0    0     0          0         0      500      10    0    0    0     0       0          0
br-abc:    200       5    0    0    0     0          0         0      200       5    0    0    0     0       0          0
veth123:   100       2    0    0    0     0          0         0      100       2    0    0    0     0       0          0
"""


def test_get_network_bytes_excludes_virtual():
    """get_network_bytes() should sum only eth0 and exclude lo, docker, br-, veth."""
    m = __import__("unittest.mock", fromlist=["mock_open"])
    mock_open = m.mock_open(read_data=FAKE_PROC_NET_DEV)
    with __import__("unittest.mock", fromlist=["patch"]).patch("builtins.open", mock_open):
        _, rx, tx = get_network_bytes()
    assert rx == 5_000_000, f"Expected 5000000 rx, got {rx}"
    assert tx == 3_000_000, f"Expected 3000000 tx, got {tx}"


def test_bandwidth_first_call_returns_zero():
    """First call with no cached snapshot must return rx_speed=0, tx_speed=0."""
    from unittest.mock import patch, MagicMock

    # Clear module fallback cache
    _fallback_traffic_cache.clear()

    mock_redis = MagicMock()
    mock_redis.get.return_value = None  # no previous snapshot

    with patch.object(network_module, "_redis_client", mock_redis):
        with patch.object(network_module, "get_network_bytes", return_value=(1000.0, 5_000_000, 3_000_000)):
            result = get_bandwidth(db=None)

    assert result.rx_speed == 0.0
    assert result.tx_speed == 0.0


def test_bandwidth_calculates_correct_speed():
    """Second call 1 second later with 1 MB more should give ~1 MB/s speed."""
    from unittest.mock import patch, MagicMock

    _fallback_traffic_cache.clear()

    prev_snapshot = {
        "timestamp": 1000.0,
        "rx_bytes": 5_000_000,
        "tx_bytes": 3_000_000,
        "rx_speed": 0.0,
        "tx_speed": 0.0,
    }
    mock_redis = MagicMock()
    mock_redis.get.return_value = json.dumps(prev_snapshot).encode()

    with patch.object(network_module, "_redis_client", mock_redis):
        with patch.object(network_module, "get_network_bytes", return_value=(1001.0, 6_000_000, 3_500_000)):
            result = get_bandwidth(db=None)

    assert abs(result.rx_speed - 1_000_000.0) < 1, f"Unexpected rx_speed: {result.rx_speed}"
    assert abs(result.tx_speed - 500_000.0) < 1, f"Unexpected tx_speed: {result.tx_speed}"


def test_bandwidth_rate_limits_sub_half_second():
    """When delta_time < 0.5s the endpoint must return the cached speed unchanged."""
    from unittest.mock import patch, MagicMock

    _fallback_traffic_cache.clear()

    prev_snapshot = {
        "timestamp": 1000.0,
        "rx_bytes": 5_000_000,
        "tx_bytes": 3_000_000,
        "rx_speed": 12345.0,
        "tx_speed": 67890.0,
    }
    mock_redis = MagicMock()
    mock_redis.get.return_value = json.dumps(prev_snapshot).encode()

    # Only 0.1 s elapsed — below threshold
    with patch.object(network_module, "_redis_client", mock_redis):
        with patch.object(network_module, "get_network_bytes", return_value=(1000.1, 5_100_000, 3_100_000)):
            result = get_bandwidth(db=None)

    assert result.rx_speed == 12345.0
    assert result.tx_speed == 67890.0


def test_bandwidth_fallback_to_memory_on_redis_failure():
    """When Redis raises an exception the endpoint should use in-process dict and return gracefully."""
    from unittest.mock import patch, MagicMock

    _fallback_traffic_cache.clear()

    mock_redis = MagicMock()
    mock_redis.get.side_effect = Exception("Redis connection refused")

    with patch.object(network_module, "_redis_client", mock_redis):
        with patch.object(network_module, "get_network_bytes", return_value=(1000.0, 5_000_000, 3_000_000)):
            # First call — no fallback entry yet, should return zeros
            result = get_bandwidth(db=None)

    assert result.rx_speed == 0.0
    assert result.tx_speed == 0.0
    # Fallback cache should have been populated
    assert network_module.BANDWIDTH_CACHE_KEY in _fallback_traffic_cache

    # Second call — fallback cache has previous entry, 1s later with more bytes
    with patch.object(network_module, "_redis_client", mock_redis):
        with patch.object(network_module, "get_network_bytes", return_value=(1001.0, 6_000_000, 3_500_000)):
            result2 = get_bandwidth(db=None)

    assert result2.rx_speed > 0, "Should calculate non-zero speed on second call"


def test_bandwidth_endpoint_metrics():
    """Verify that get_bandwidth returns the correct keys and fields."""
    from unittest.mock import patch, MagicMock
    _fallback_traffic_cache.clear()
    mock_redis = MagicMock()
    mock_redis.get.return_value = None

    with patch.object(network_module, "_redis_client", mock_redis):
        with patch.object(network_module, "get_network_bytes", return_value=(1000.0, 5_000_000, 3_000_000)):
            result = get_bandwidth(db=None)

    assert hasattr(result, "rx_speed")
    assert hasattr(result, "tx_speed")
    assert hasattr(result, "rx_percent")
    assert hasattr(result, "tx_percent")
    assert hasattr(result, "cpu_usage")
    assert hasattr(result, "ram_usage")

