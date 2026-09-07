import os
import subprocess
import json
from typing import Dict, Any, Optional
from sqlalchemy.orm import Session
from models import Node, TaskLog, Settings
from celery_app import celery_app
from core import known_hosts, ssh_keys
from core.db_session import session_scope
import tasks


#: How many offline nodes one auto-retry pass may re-bootstrap. Each retry is
#: a separate ansible-playbook process, and this task runs every 5 minutes.
AUTO_RETRY_BATCH_SIZE = int(os.getenv("AUTO_RETRY_BATCH_SIZE", "20"))


def sync_node_key(
    task_id: str, node_id: int, hostname: str, old_pubkey: Optional[str], new_pubkey: str
) -> None:
    """Point the orchestrator's authorized_keys at the node's current key.

    A node that was re-imaged presents a new key; the grant for its previous
    key is revoked first, so a re-image cannot leave a live entry behind.

    Takes the node's fields rather than the node, because it runs outside any
    session — `fix_ssh_permissions` shells out to chown, and this is called
    from a task that must not be holding a connection.
    """
    if not new_pubkey:
        tasks.log_to_task(
            task_id, "WARNING: node returned no SSH public key; nothing to authorize"
        )
        return

    new_fp = ssh_keys.fingerprint(new_pubkey)

    if old_pubkey:
        try:
            if ssh_keys.fingerprint(old_pubkey) != new_fp:
                action = ssh_keys.revoke(ssh_keys.ORCHESTRATOR_AUTHORIZED_KEYS, old_pubkey)
                tasks.log_to_task(
                    task_id,
                    f"Node presented a new SSH key; previous grant {action.value} "
                    f"({ssh_keys.fingerprint(old_pubkey)})",
                )
        except ValueError:
            tasks.log_to_task(
                task_id, "WARNING: stored SSH key is unparseable; skipping revoke"
            )

    action = ssh_keys.authorize(
        ssh_keys.ORCHESTRATOR_AUTHORIZED_KEYS,
        new_pubkey,
        options=ssh_keys.BORG_SERVE_OPTIONS,
        tag=ssh_keys.node_tag(node_id),
    )
    tasks.fix_ssh_permissions()
    tasks.log_to_task(
        task_id,
        f"Borg access for {hostname}: {action.value} {new_fp} "
        f"tag={ssh_keys.node_tag(node_id)}",
        status="SUCCESS",
    )


def deploy_monitoring(
    task_id: str, host_ip: str, ssh_port: int, ssh_password: Optional[str] = None
) -> bool:
    """Install the telemetry collector on a node that has just been provisioned.

    Never raises and never fails the caller. Monitoring is an addition to a
    node that is already working; a node whose collector would not install
    still backs up perfectly well, and turning that into a bootstrap failure
    would be a worse outcome than going without telemetry.
    """
    try:
        tasks.log_to_task(task_id, "Installing the telemetry collector...")
        result = tasks.run_ansible_playbook(
            task_id=task_id,
            playbook_name="deploy_monitoring.yml",
            host_ip=host_ip,
            ssh_port=ssh_port,
            extra_vars={},
            ssh_key_path=ssh_keys.ORCHESTRATOR_PRIVATE_KEY,
            ssh_password=ssh_password,
        )
        if result.get("status") == "SUCCESS":
            tasks.log_to_task(task_id, "Telemetry collector installed and running.")
            return True
        tasks.log_to_task(
            task_id,
            f"WARNING: Could not install the telemetry collector (exit code {result.get('return_code')}). "
            "The node is otherwise provisioned; monitoring can be retried separately.",
        )
    except Exception as e:
        tasks.log_to_task(task_id, f"WARNING: Monitoring deploy raised: {str(e)}")
    return False


@celery_app.task(bind=True, name="tasks.run_bootstrap_task")
def run_bootstrap_task(self, node_id: int, ssh_password: str, bootstrap_user: str, force_orchestrator_proxy: bool = False) -> Dict[str, Any]:
    """
    Celery task to run the Node bootstrapping process using Ansible.
    """
    return _run_bootstrap(
        node_id, self.request.id, ssh_password, bootstrap_user, force_orchestrator_proxy
    )


def _run_bootstrap(
    node_id, task_id, ssh_password, bootstrap_user, force_orchestrator_proxy
) -> Dict[str, Any]:
    # Three phases, and the session lifetime is what separates them: read what
    # the playbook needs, run the playbook holding no connection, then record
    # the outcome. Bootstrap used to hold one session across all three, which
    # meant a pooled connection sat idle in transaction on `settings` for the
    # several minutes a playbook takes — see core.db_session.
    with session_scope() as db:
        node = db.query(Node).filter(Node.id == node_id).first()
        if not node:
            return {"status": "FAILED", "error": "Node not found"}
        node_ip = node.ip_address
        node_port = node.ssh_port
        node_hostname = node.hostname

        db.add(TaskLog(
            id=task_id, task_type="BOOTSTRAP", status="RUNNING", node_id=node_id, log_output=""
        ))

        settings = db.query(Settings).first()
        if not settings:
            settings = Settings()
            db.add(settings)
            db.flush()
        orchestrator_ip = settings.orchestrator_ip
        orchestrator_borg_ssh_port = settings.borg_ssh_port
        orchestrator_tag = ssh_keys.orchestrator_tag(settings.orchestrator_id)

    # Bootstrap reinstalls borgbackup on the node (`apt-get install
    # borgbackup ...`) and restarts its sshd. A `borg create` already running
    # there is a separate SSH session the node holds outbound to borg-server,
    # unaffected by that restart, and Linux keeps an already-running
    # process's binary readable even after apt replaces the file on disk —
    # but a *second* borg invocation racing the mid-install window is not
    # protected, so refuse rather than risk it. The node stays exactly as it
    # was; re-provisioning after the backup finishes costs nothing.
    from core.scheduler import is_backup_lock_live
    if is_backup_lock_live(node_id):
        tasks.log_to_task(
            task_id,
            f"[BLOCKED] {node_hostname} is currently running a backup. "
            "Provisioning would race package installs and an SSH restart "
            "against it -- try again once the backup finishes.",
            status="FAILED",
        )
        return {"status": "FAILED", "error": "Backup currently running for this node"}

    tasks.log_to_task(task_id, f"Starting bootstrap for {node_hostname} ({node_ip})")

    # A (re)install regenerates the node's SSH host keys. Forgetting the old
    # entry unconditionally means the next connection just relearns the new
    # one quietly instead of every backup afterwards printing a full "REMOTE
    # HOST IDENTIFICATION HAS CHANGED" warning for a change that was expected.
    try:
        if known_hosts.forget(node_ip, node_port):
            tasks.log_to_task(
                task_id,
                f"Cleared the previous SSH host key for {node_ip}:{node_port} "
                f"— (re)install generates a new one",
            )
    except Exception as e:
        tasks.log_to_task(task_id, f"WARNING: Could not clear old host key: {str(e)}")

    try:
        orchestrator_pub_key = tasks.ensure_orchestrator_ssh_key()
        parsed_orch = ssh_keys.parse_line(orchestrator_pub_key)
        if parsed_orch is None:
            raise ValueError("orchestrator public key is unparseable")
        # Pass the key already normalized so the playbook's raw shell block
        # never has to cope with a comment containing shell metacharacters.
        orchestrator_pub_key = f"{parsed_orch.keytype} {parsed_orch.blob}"
    except Exception as e:
        tasks.log_to_task(task_id, f"WARNING: Failed to ensure orchestrator SSH key: {str(e)}")
        orchestrator_pub_key = ""

    if not orchestrator_ip:
        orchestrator_ip = os.getenv("ORCHESTRATOR_IP")
    if not orchestrator_ip:
        try:
            route_cmd = f"ip route get {node_ip}"
            route_out = subprocess.check_output(route_cmd, shell=True, text=True)
            orchestrator_ip = route_out.split("src")[1].split()[0]
        except Exception:
            orchestrator_ip = "127.0.0.1"

    res = tasks.run_ansible_playbook(
        task_id=task_id,
        playbook_name="bootstrap.yml",
        host_ip=node_ip,
        ssh_port=node_port,
        extra_vars={
            "bootstrap_user": bootstrap_user,
            "orchestrator_ssh_pub_key": orchestrator_pub_key,
            "orchestrator_ip": orchestrator_ip,
            "orchestrator_tag": orchestrator_tag,
            "borg_ssh_port": orchestrator_borg_ssh_port,
            "force_orchestrator_proxy": force_orchestrator_proxy
        },
        ssh_password=ssh_password
    )

    if res["status"] == "SUCCESS":
        return _record_bootstrap_success(
            node_id, task_id, res, ssh_password, node_ip, node_port
        )
    return _record_bootstrap_failure(node_id, task_id, res)


def _record_bootstrap_success(
    node_id, task_id, res, ssh_password, node_ip, node_port
) -> Dict[str, Any]:
    """Persist what the playbook reported, then do the post-provision work.

    Split out so the session covers only the writes: everything after the
    `with` block shells out — chown, ssh-keyscan, another whole playbook.
    """
    parsed = res["parsed_data"]
    ssh_pub_key = parsed.get("ssh_pub_key")

    with session_scope() as db:
        node = db.query(Node).filter(Node.id == node_id).first()
        if not node:
            return res

        # Captured before the overwrite: syncing the key needs to know which
        # grant to revoke, and that runs after this session has closed.
        old_pubkey = node.ssh_pub_key
        node.ssh_pub_key = ssh_pub_key

        node_keys = parsed.get("node_authorized_keys")
        if node_keys:
            node.node_authorized_keys = node_keys

        # Save os_version and hardware details
        for field, key in (
            ("os_version", "os_version"),
            ("cpu_info", "cpu_info"),
            ("memory_info", "memory_info"),
            ("edge_version", "edge_version"),
            ("hasp_runtime_version", "hasp_runtime_version"),
        ):
            value = parsed.get(key)
            if value:
                setattr(node, field, value)

        # Update hostname if detected
        detected_hostname = parsed.get("hostname")
        if detected_hostname:
            existing_host = db.query(Node).filter(
                Node.hostname == detected_hostname, Node.id != node.id
            ).first()
            node.hostname = (
                f"{detected_hostname}-{node.id}" if existing_host else detected_hostname
            )

        is_prep = parsed.get("prepared") == "true"
        if is_prep:
            node.disk_type = parsed.get("disk_type", "UNKNOWN")
            node.network_iface = parsed.get("network_iface")
            node.efi_uuid = parsed.get("efi_uuid")
            if "partition_layout" in parsed:
                node.partition_layout = parsed["partition_layout"]
        node.status = "READY" if is_prep else "NEEDS_FIX"
        hostname = node.hostname

    if node_keys:
        tasks.log_to_task(
            task_id, f"Recorded {len(node_keys)} authorized_keys entrie(s) from the node"
        )

    # Remove temporary credentials from Redis
    try:
        tasks.redis_client.delete(f"bootstrap_creds:{node_id}")
    except Exception as e:
        tasks.logger.error(f"Error deleting Redis credentials: {str(e)}")

    try:
        sync_node_key(task_id, node_id, hostname, old_pubkey, ssh_pub_key)
    except Exception as e:
        tasks.log_to_task(
            task_id, f"WARNING: Failed to sync node SSH key: {str(e)}", status="FAILED"
        )

    tasks.log_to_task(
        task_id, f"Bootstrap completed. {'Already prepared.' if is_prep else 'Key fetched.'}"
    )

    try:
        known_hosts.record(node_ip, node_port)
    except Exception as e:
        tasks.log_to_task(task_id, f"WARNING: Could not record node SSH host key: {str(e)}")

    # Install the telemetry collector so a freshly provisioned node starts
    # sampling without a second visit. Deliberately after the commit and
    # non-fatal: monitoring is an addition to a node that is already
    # working, and a failure to install it must never turn a successful
    # bootstrap into a failed one.
    deploy_monitoring(task_id, node_ip, node_port, ssh_password=ssh_password)
    return res


def _record_bootstrap_failure(node_id, task_id, res) -> Dict[str, Any]:
    """Classify why the playbook failed and park the node accordingly."""
    error_msg = "Bootstrap task failed."

    with session_scope() as db:
        node = db.query(Node).filter(Node.id == node_id).first()
        if not node:
            return res

        task_log_obj = db.query(TaskLog).filter(TaskLog.id == task_id).first()
        log_output = task_log_obj.log_output if task_log_obj else None

        is_offline = False
        if log_output:
            log_out_upper = log_output.upper()
            if ("UNREACHABLE" in log_out_upper or "COULD NOT RESOLVE" in log_out_upper
                    or "CONNECTION TIMEOUT" in log_out_upper or "CONNECT TO HOST" in log_out_upper):
                is_offline = True

        node.status = "OFFLINE" if is_offline else "NEEDS_BOOTSTRAP"

        if log_output and "OS_UNSUPPORTED" in log_output:
            for line in log_output.splitlines():
                if "OS_UNSUPPORTED" in line:
                    error_msg = f"Bootstrap rejected: {line.strip()}"
                    break

    if is_offline:
        try:
            import time
            tasks.redis_client.set(f"node_next_retry:{node_id}", int(time.time() + 300), ex=300)
        except Exception as e:
            tasks.logger.error(f"Error setting node_next_retry: {str(e)}")

    tasks.log_to_task(task_id, error_msg, status="FAILED")
    return res

@celery_app.task(name="tasks.auto_retry_bootstrap_task")
def auto_retry_bootstrap_task() -> Dict[str, Any]:
    """
    Periodic task to check for OFFLINE nodes, retrieve credentials from Redis,
    and trigger bootstrap tasks for them.
    """
    db: Session = tasks.SessionLocal()
    try:
        # Capped per run. Each retry spawns a full ansible-playbook process
        # (~150 MB resident), and this fires every five minutes — so after a
        # site-wide outage an uncapped sweep would queue hundreds of them at
        # once, then hundreds more before the first batch had finished.
        # Whatever is left over is picked up by the next run.
        offline_nodes = (
            db.query(Node)
            .filter(Node.status == "OFFLINE")
            .order_by(Node.id)
            .limit(AUTO_RETRY_BATCH_SIZE)
            .all()
        )
        triggered = []
        for node in offline_nodes:
            creds_json = tasks.redis_client.get(f"bootstrap_creds:{node.id}")
            if creds_json:
                creds = json.loads(creds_json)
                node.status = "NEEDS_BOOTSTRAP"
                db.commit()
                try:
                    tasks.redis_client.delete(f"node_next_retry:{node.id}")
                except Exception:
                    pass
                run_bootstrap_task.delay(
                    node.id,
                    creds["bootstrap_password"],
                    creds["bootstrap_user"],
                    creds.get("force_orchestrator_proxy", False)
                )
                triggered.append(node.id)
        return {"status": "SUCCESS", "triggered_node_ids": triggered}
    except Exception as e:
        tasks.logger.error(f"Error in auto_retry_bootstrap_task: {str(e)}")
        return {"status": "FAILED", "error": str(e)}
    finally:
        db.close()


@celery_app.task(bind=True, name="tasks.revoke_node_access_task")
def revoke_node_access_task(self, hostname: str, ip_address: str, ssh_port: int) -> Dict[str, Any]:
    """Best-effort removal of the orchestrator's key from a deleted node.

    A decommissioned box is often already switched off, so an unreachable host
    is a logged outcome, not an error.
    """
    task_id = self.request.id
    with session_scope() as db:
        db.add(TaskLog(
            id=task_id, task_type="REVOKE_ACCESS", status="RUNNING", log_output=""
        ))
        settings = db.query(Settings).first()
        # Falls back to the bare (suffix-less) tag if Settings somehow does not
        # exist yet, which cannot match anything a real bootstrap wrote — a
        # safe no-op rather than a guess that might match another
        # orchestrator's entry.
        orchestrator_tag = (
            ssh_keys.orchestrator_tag(settings.orchestrator_id) if settings
            else ssh_keys.ORCHESTRATOR_TAG
        )

    tasks.log_to_task(task_id, f"Revoking orchestrator access from {hostname} ({ip_address})")
    try:
        res = tasks.run_ansible_playbook(
            task_id=task_id,
            playbook_name="revoke_access.yml",
            host_ip=ip_address,
            ssh_port=ssh_port,
            extra_vars={"orchestrator_tag": orchestrator_tag},
            ssh_key_path="/root/.ssh/id_ed25519",
        )
    except Exception as e:
        tasks.log_to_task(
            task_id,
            f"Could not reach {hostname}; orchestrator key may remain on that host: {str(e)}",
            status="FAILED",
        )
        return {"status": "FAILED", "error": str(e)}

    if res["status"] == "SUCCESS":
        tasks.log_to_task(
            task_id, f"Orchestrator access revoked from {hostname}", status="SUCCESS"
        )
    else:
        tasks.log_to_task(
            task_id,
            f"Host {hostname} unreachable; orchestrator key may remain on it",
            status="FAILED",
        )
    return res
