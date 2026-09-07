from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session
from database import get_db
import models
import schemas
from version import VERSION
from auth import require_admin
from core.default_exclusions import DEFAULT_GLOBAL_EXCLUSIONS

router = APIRouter(prefix="/api")

@router.get("/version")
def get_version():
    """
    Returns the current application version.
    """
    return {"version": VERSION, "is_kiosk": False}


def get_local_ips():
    import socket
    import struct
    import os

    exclude_prefixes = ("br-", "docker", "veth", "lo", "virbr", "kube", "cali", "flannel")

    def ip_to_int(ip_str):
        try:
            return struct.unpack(">I", socket.inet_aton(ip_str))[0]
        except Exception:
            return 0

    ips = []
    
    # Try reading host's network interfaces from process 1 network namespace (since /proc is mapped to /host/proc)
    if os.path.exists("/host/proc/1/net/fib_trie") and os.path.exists("/host/proc/1/net/route"):
        try:
            routes = []
            with open("/host/proc/1/net/route", "r") as f:
                lines = f.readlines()
            for line in lines[1:]:
                parts = line.strip().split()
                if len(parts) >= 8:
                    iface = parts[0]
                    if any(iface.startswith(prefix) for prefix in exclude_prefixes):
                        continue
                    dest_hex = parts[1]
                    mask_hex = parts[7]
                    try:
                        # /proc/net/route prints addresses as little-endian
                        # hex — 192.168.1.0 appears as "0001A8C0", not
                        # "C0A80100". Pack the parsed integer back out in
                        # little-endian order and read it in big-endian to
                        # swap the bytes, which puts it in the same order
                        # inet_aton produces so the mask comparison below is
                        # comparing like with like.
                        dest_val = int(dest_hex, 16)
                        mask_val = int(mask_hex, 16)
                        dest_int = struct.unpack(">I", struct.pack("<I", dest_val))[0]
                        mask_int = struct.unpack(">I", struct.pack("<I", mask_val))[0]
                        if mask_int > 0:
                            routes.append((iface, dest_int, mask_int))
                    except Exception:
                        pass

            trie_ips = []
            with open("/host/proc/1/net/fib_trie", "r") as f:
                lines = f.readlines()
            current_ip = None
            for line in lines:
                line = line.strip()
                if "|--" in line:
                    parts = line.split("|--")
                    if len(parts) > 1:
                        current_ip = parts[1].strip()
                elif "/32 host LOCAL" in line:
                    if current_ip and current_ip != "127.0.0.1":
                        trie_ips.append(current_ip)

            for ip in set(trie_ips):
                ip_int = ip_to_int(ip)
                for iface, dest_int, mask_int in routes:
                    if (ip_int & mask_int) == dest_int:
                        ips.append(ip)
                        break
        except Exception:
            pass

    # Fallback: resolve our own hostname.
    #
    # This returns the container's address rather than the host's, so it is a
    # poor substitute for the /host/proc parse above and exists only so the
    # settings page shows something. It used to sit behind a
    # `socket.getifaddrs()` branch, which is not part of the Python standard
    # library at all — that call raised AttributeError into a bare `except`
    # on every single run, so this hostname lookup was always what actually
    # executed, by accident rather than intent.
    if not ips:
        try:
            hostname = socket.gethostname()
            ips = [socket.gethostbyname(hostname)]
        except Exception:
            pass

    return sorted(list(set(ips)))


@router.get("/settings/global-exclusions/defaults")
def get_default_global_exclusions(current_user: models.User = Depends(require_admin)):
    """The curated exclusion list a fresh install seeds — for the Settings
    page's Reset to Defaults button, so an install whose list was emptied by
    a past migration (or by accident) can recover without support
    intervention.
    """
    return {"global_exclusions": DEFAULT_GLOBAL_EXCLUSIONS}


@router.get("/settings", response_model=schemas.SettingsResponse)
def get_settings(db: Session = Depends(get_db), current_user: models.User = Depends(require_admin)):
    """
    Retrieves global orchestrator settings.
    """
    settings = db.query(models.Settings).first()
    if not settings:
        settings = models.Settings()
        db.add(settings)
        db.commit()
    
    if not settings.bootstrap_credentials:
        settings.bootstrap_credentials = [{"id": "default", "username": "user", "password": "admin", "comment": "Default"}]
        settings.default_credentials_id = "default"
        db.commit()
    
    if settings.default_credentials_id is None:
        settings.default_credentials_id = ""
        db.commit()
    
    settings.available_ips = get_local_ips()
    import os
    settings.borg_host_data_path = os.getenv("BORG_HOST_DATA_PATH", "borg-data")
    return settings


@router.get("/settings/credentials", response_model=List[schemas.CredentialSchema])
def get_bootstrap_credentials(db: Session = Depends(get_db), current_user: models.User = Depends(require_admin)):
    """The saved bootstrap credentials, passwords included.

    `GET /api/settings` deliberately omits the password — see
    `SettingsResponse.bootstrap_credentials` — because it is loaded on every
    page view across the whole app, and a plaintext SSH password has no
    business riding along with the timezone setting. This endpoint is the one
    place that still returns it, for the three call sites that need it at the
    moment they are about to submit a provisioning request: Add Node, Instant
    Provision, and the credentials-management modal itself.

    Same `require_admin` guard as the endpoint above — no access-level change,
    just a narrower one. Any admin who can reach this can already provision a
    node with these credentials, so splitting the response does not hide
    anything from someone who could get it anyway; it only stops it from
    appearing in a response nobody asked to see it in.
    """
    settings = db.query(models.Settings).first()
    if not settings or not settings.bootstrap_credentials:
        return []
    return settings.bootstrap_credentials


@router.post("/settings", response_model=schemas.SettingsResponse)
def update_settings(payload: schemas.SettingsBase, request: Request, db: Session = Depends(get_db), current_user: models.User = Depends(require_admin)):
    """
    Updates global orchestrator settings.
    """
    settings = db.query(models.Settings).first()
    if not settings:
        settings = models.Settings()
        db.add(settings)

    changes = []
    fields = [
        ("borg_ssh_port", "Borg SSH Port"),
        ("keep_daily", "Keep Daily"),
        ("keep_weekly", "Keep Weekly"),
        ("keep_monthly", "Keep Monthly"),
        ("global_exclusions", "Global Exclusions"),
        ("orchestrator_ip", "Orchestrator IP"),
        ("orchestrator_behind_nat", "Orchestrator Behind NAT"),
        ("timezone", "Timezone"),
        ("language", "Language"),
        ("default_compression", "Compression"),
        ("default_cpu_quota", "CPU Quota"),
        ("default_rate_limit", "Default Rate Limit"),
        ("server_ips", "Server IPs"),
        ("server_name", "Server Name"),
        ("default_credentials_id", "Default Credentials ID"),
        ("server_net_capacity_mbps", "Server Net Capacity Mbps"),
        ("thermal_fit_retention_days", "Thermal Fit Retention Days"),
        ("allow_admin_key_terminal_access", "Allow Admin Key Terminal Access"),
    ]
    for attr, label in fields:
        old_val = getattr(settings, attr, None)
        new_val = getattr(payload, attr, None)
        if attr in ("global_exclusions", "server_ips"):
            old_str = ",".join([str(x) for x in old_val]) if isinstance(old_val, list) else str(old_val)
            new_str = ",".join([str(x) for x in new_val]) if isinstance(new_val, list) else str(new_val)
            if old_str != new_str:
                changes.append(f"{label}: '{old_str}' ➔ '{new_str}'")
        else:
            if old_val != new_val:
                changes.append(f"{label}: '{old_val}' ➔ '{new_val}'")

    # Check if bootstrap_credentials changed
    old_creds = settings.bootstrap_credentials or []
    old_creds_map = {c["id"]: c for c in old_creds if isinstance(c, dict) and "id" in c}
    new_creds = []
    if payload.bootstrap_credentials:
        for c in payload.bootstrap_credentials:
            cdict = c.model_dump()
            # If password was not provided (e.g. payload mirrored from GET /api/settings),
            # preserve the stored password for this credential ID so it is not blanked.
            if cdict.get("password") is None and cdict.get("id") in old_creds_map:
                cdict["password"] = old_creds_map[cdict["id"]].get("password", "")
            elif cdict.get("password") is None:
                cdict["password"] = ""
            new_creds.append(cdict)

    if old_creds != new_creds:
        changes.append("Bootstrap Credentials updated")

    old_policy = settings.retention_policy or {}
    new_policy = payload.retention_policy.model_dump() if payload.retention_policy else {}
    if old_policy != new_policy:
        policy_changes = []
        for pk in ["type", "keep_last", "within_value", "within_unit"]:
            op_val = old_policy.get(pk)
            np_val = new_policy.get(pk)
            if op_val != np_val:
                policy_changes.append(f"Retention {pk.replace('_', ' ')}: '{op_val}' ➔ '{np_val}'")
        if policy_changes:
            changes.extend(policy_changes)

    old_alert_cfg = settings.alert_config or {}
    new_alert_cfg = payload.alert_config or {}
    if old_alert_cfg != new_alert_cfg:
        for source in set(old_alert_cfg) | set(new_alert_cfg):
            old_src = old_alert_cfg.get(source, {})
            new_src = new_alert_cfg.get(source, {})
            if old_src != new_src:
                changes.append(f"Alert {source}: {old_src} -> {new_src}")

    rebuild_needed = (
        settings.server_ips != payload.server_ips or 
        settings.orchestrator_ip != payload.orchestrator_ip
    )

    settings.borg_ssh_port = payload.borg_ssh_port
    settings.keep_daily = payload.keep_daily
    settings.keep_weekly = payload.keep_weekly
    settings.keep_monthly = payload.keep_monthly
    settings.global_exclusions = [e.model_dump() for e in payload.global_exclusions] if payload.global_exclusions else []
    settings.orchestrator_ip = payload.orchestrator_ip
    settings.orchestrator_behind_nat = payload.orchestrator_behind_nat
    settings.timezone = payload.timezone
    settings.language = payload.language
    settings.retention_policy = payload.retention_policy.model_dump() if payload.retention_policy else None
    settings.default_compression = payload.default_compression
    settings.default_cpu_quota = payload.default_cpu_quota
    settings.default_rate_limit = payload.default_rate_limit
    settings.server_ips = payload.server_ips
    settings.server_name = payload.server_name
    settings.bootstrap_credentials = new_creds
    settings.default_credentials_id = payload.default_credentials_id
    settings.server_net_capacity_mbps = payload.server_net_capacity_mbps
    settings.thermal_fit_retention_days = payload.thermal_fit_retention_days
    # Superadmin-only: see SettingsBase.allow_admin_key_terminal_access.
    if current_user.is_superadmin:
        settings.allow_admin_key_terminal_access = payload.allow_admin_key_terminal_access
    settings.alert_config = payload.alert_config
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(settings, "bootstrap_credentials")
    flag_modified(settings, "global_exclusions")
    flag_modified(settings, "alert_config")
    db.commit()

    if rebuild_needed:
        try:
            from iso_tasks import trigger_base_iso_rebuild
            trigger_base_iso_rebuild(db)
        except Exception as ex:
            import logging
            logging.getLogger(__name__).error(f"Failed to trigger base ISO rebuild: {ex}")

    from database import log_user_action
    details_str = f"Update Settings: {', '.join(changes)}" if changes else "Updated global orchestrator settings (no values changed)"
    log_user_action(db, current_user.username, "Update Settings", details_str, request)

    settings.available_ips = get_local_ips()
    import os
    settings.borg_host_data_path = os.getenv("BORG_HOST_DATA_PATH", "borg-data")
    return settings
