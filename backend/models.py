import os
import uuid

from sqlalchemy import Column, Integer, String, DateTime, Text, BigInteger, ForeignKey, JSON, Boolean, Float, UniqueConstraint, Index, text
from sqlalchemy.sql import func
from database import Base
from core.default_exclusions import DEFAULT_GLOBAL_EXCLUSIONS

class Settings(Base):
    """
    Settings model for global orchestrator configuration.
    Borg passphrase is read from env instead of the DB.
    """
    __tablename__ = 'settings'

    id = Column(Integer, primary_key=True, index=True)
    borg_ssh_port = Column(Integer, default=12345, nullable=False)
    keep_daily = Column(Integer, default=7, nullable=False)
    keep_weekly = Column(Integer, default=4, nullable=False)
    keep_monthly = Column(Integer, default=6, nullable=False)
    global_exclusions = Column(JSON, nullable=True, default=lambda: list(DEFAULT_GLOBAL_EXCLUSIONS))
    # Seeded from .env so a fresh install shows the configured IP in the UI.
    # Once set through the UI the DB value wins; .env is only the initial value.
    orchestrator_ip = Column(String, default=lambda: os.getenv("ORCHESTRATOR_IP", ""), nullable=False)
    # Identifies this install when a node is enrolled with more than one
    # orchestrator (an on-site and an off-site server, say). Each is a fully
    # separate install with its own DB — there is no registry to hand out
    # IDs from — so this is generated once, locally, and used to tag this
    # orchestrator's own entry in a node's authorized_keys/known_hosts
    # (core.ssh_keys.orchestrator_tag) instead of the fixed string every
    # install used to share, which made a second orchestrator's bootstrap
    # silently overwrite the first one's access.
    orchestrator_id = Column(String, default=lambda: uuid.uuid4().hex, nullable=False)
    # When true, nodes cannot reach the orchestrator directly (it sits behind NAT).
    # Backups instead go through a reverse SSH tunnel opened on the orchestrator's
    # own outbound connection to the node. See backup_tasks.resolve_borg_target.
    orchestrator_behind_nat = Column(Boolean, default=False, nullable=False)
    timezone = Column(String, default='Browser Local', nullable=False)
    language = Column(String, default='en', nullable=False)
    retention_policy = Column(JSON, nullable=True)
    default_compression = Column(String, default='zstd:3', nullable=False)
    default_cpu_quota = Column(Integer, default=30, nullable=True)   # % of one core, NULL = no limit
    default_rate_limit = Column(Integer, nullable=True)   # KiB/s, NULL/0 = unlimited
    server_ips = Column(JSON, nullable=True)
    max_kiosk_isos = Column(Integer, default=5, nullable=False)
    server_name = Column(String, default="edge-bro", nullable=False)
    bootstrap_credentials = Column(JSON, nullable=True, default=lambda: [{"id": "default", "username": "user", "password": "admin"}])
    default_credentials_id = Column(String, nullable=True, default='default')
    server_net_capacity_mbps = Column(Integer, default=1000, nullable=False)

    # --- Monitoring: fleet-wide defaults, each overridable per node ---
    monitoring_enabled = Column(Boolean, default=True, nullable=False)
    # How often a node is polled, in days. Every node is also polled on
    # provision, re-provision and after each backup regardless of this.
    monitoring_interval_days = Column(Integer, default=30, nullable=False)
    # Drive temperature thresholds. Roadside enclosures in full sun run hot
    # and a single fleet-wide limit would either cry wolf or miss real
    # trouble, so these are the default rather than the rule.
    smart_temp_warn_c = Column(Integer, default=60, nullable=False)
    smart_temp_crit_c = Column(Integer, default=70, nullable=False)
    # How long raw-ish telemetry rollups are kept. Thermal fits and SMART
    # snapshots are small and kept indefinitely; rollups are the bulky part.
    telemetry_retention_days = Column(Integer, default=90, nullable=False)
    # NULL (the default) keeps successful thermal fits forever — see
    # tasks.monitoring.monitoring_retention_task for why: at ~440k rows/year
    # even at a 2000-node fleet they cost tens of MB, and they are the
    # multi-year degradation trend the feature exists to produce. Set only if
    # an operator wants a hard ceiling anyway.
    thermal_fit_retention_days = Column(Integer, nullable=True)

    # Credential path for the fleet table's web terminal (see
    # core/terminal_bridge.py). Superadmin always connects with the
    # orchestrator's own key; everyone else gets ssh's own password prompt
    # unless this is on, in which case other admins get the key path too.
    # Off by default, and only a superadmin can change it — see
    # routers/settings.py's update_settings.
    allow_admin_key_terminal_access = Column(Boolean, default=False, nullable=False)

    # One sub-object per alert source ({"enabled": bool, ...thresholds}),
    # e.g. {"stale_backup": {"enabled": true, "days": 3}}. Missing keys mean
    # "use that source's default" -- see core/alert_config.py. Nullable
    # rather than defaulting to {} so a fresh install's row is
    # indistinguishable from one where nobody has touched this yet.
    alert_config = Column(JSON, nullable=True)






class BackupGroup(Base):
    """
    BackupGroup model tracking node schedules and allowed time windows.
    """
    __tablename__ = 'backup_groups'

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)
    interval = Column(String, nullable=False)  # weekly, monthly, quarterly, yearly
    target_week = Column(Integer, default=1, nullable=False)
    start_time = Column(String, default="02:00", nullable=False)
    end_time = Column(String, default="05:00", nullable=False)
    concurrency_limit = Column(Integer, default=5, nullable=False)
    randomize_days = Column(Boolean, default=True, nullable=False)
    timezone = Column(String, default='UTC', nullable=False)
    override_retention = Column(Boolean, default=False, nullable=False)
    retention_policy = Column(JSON, nullable=True)

    # NULL = inherit the global Settings value. Set per group when only some
    # sites sit behind NAT relative to the orchestrator.
    orchestrator_behind_nat = Column(Boolean, nullable=True)

    # Resource limits
    upload_rate_limit = Column(Integer, nullable=True)   # KiB/s, NULL = unlimited
    compression = Column(String, nullable=True)           # e.g. "zstd:3", NULL = global default
    checkpoint_interval = Column(Integer, nullable=True)  # seconds, NULL = auto-calculate
    cpu_quota = Column(Integer, nullable=True)            # % of one core, NULL = no limit


class Node(Base):
    """
    Node model tracking physical Debian edge node configurations and statuses.
    """
    __tablename__ = 'nodes'

    id = Column(Integer, primary_key=True, index=True)
    hostname = Column(String, unique=True, index=True, nullable=False)
    ip_address = Column(String, unique=True, index=True, nullable=False)
    ssh_port = Column(Integer, default=22, nullable=False)
    # Login for the fleet table's quick-connect ssh:// link. Distinct from
    # bootstrap_credentials (those are for Ansible provisioning): this is
    # whatever an operator manually types the first time they ctrl/cmd-click
    # the node's IP, and is reused after that without asking again.
    ssh_login = Column(String, nullable=True)
    # Indexed: the scheduler filters on it every 60s, the bootstrap retry
    # every 5 minutes, and the node list filters on it per request.
    status = Column(String, default='NEEDS_BOOTSTRAP', nullable=False, index=True) # OFFLINE, NEEDS_BOOTSTRAP, NEEDS_FIX, READY
    last_backup = Column(DateTime, nullable=True)
    disk_type = Column(String, default='UNKNOWN', nullable=False) # SATA, NVME, UNKNOWN
    network_iface = Column(String, nullable=True)
    ssh_pub_key = Column(Text, nullable=True)
    efi_uuid = Column(String, nullable=True) # Used to maintain exact ESP filesystem UUID during flasher restore
    partition_layout = Column(JSON, nullable=True)
    os_version = Column(String, nullable=True)
    os_arch = Column(String, nullable=True)
    
    # Scheduler & Automated Backup fields
    # Indexed: the scheduler filters nodes by group on every tick.
    group_id = Column(Integer, ForeignKey('backup_groups.id'), nullable=True, index=True)
    # Which borg repository holds this node's archives — see core/repo_paths.
    # Assigned once at enrolment and never recomputed: the archives cannot
    # follow a node to a different repository. Defaults to 0, the repository
    # that predates sharding and the only one always present.
    borg_shard_index = Column(Integer, nullable=False, server_default='0')
    backup_paused = Column(Boolean, default=False, nullable=False)
    backup_today = Column(Boolean, default=False, nullable=False)
    missed_window = Column(Boolean, default=False, nullable=False)
    
    # Hardware & Software attributes
    cpu_info = Column(String, nullable=True)
    memory_info = Column(String, nullable=True)
    edge_version = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    # NULL = inherit from the node's group, then the global Settings value.
    # Set per node for the odd site that differs from the rest of its group.
    orchestrator_behind_nat = Column(Boolean, nullable=True)
    hasp_runtime_version = Column(String, nullable=True)
    hasp_license_v2c = Column(Text, nullable=True)

    # authorized_keys inventory reported by the node at its last bootstrap.
    node_authorized_keys = Column(JSON, nullable=True)

    # KiB/s. NULL = inherit the node's group limit, then unlimited. Set per node
    # for the odd site whose link differs from the rest of its group.
    upload_rate_limit = Column(Integer, nullable=True)

    # Percent of one core. NULL = inherit the node's group, then the global
    # default (settings.default_cpu_quota). 0 = explicit override to no
    # limit — deliberately terminal, unlike upload_rate_limit's 0-falls-
    # through-to-group behavior, so an operator can free one node from a
    # group-wide cap. Set per node for the odd node that needs to differ.
    cpu_quota = Column(Integer, nullable=True)

    # availability fields
    last_ping_status = Column(Boolean, nullable=True)
    last_available_at = Column(DateTime, nullable=True)

    # --- Monitoring overrides. NULL = inherit the global Settings value, the
    # same precedence the rest of the per-node settings use. A node standing
    # in full sun legitimately needs a looser ceiling than one in shade.
    monitoring_enabled = Column(Boolean, nullable=True)
    monitoring_interval_days = Column(Integer, nullable=True)
    smart_temp_warn_c = Column(Integer, nullable=True)
    smart_temp_crit_c = Column(Integer, nullable=True)

    # When the orchestrator last drained this node's telemetry buffer.
    last_harvest_at = Column(DateTime, nullable=True)
    # What the node reported it can actually measure, from the monitoring
    # deploy: RAPL, drive temperature, smartctl. A node without RAPL yields
    # SMART but no thermal model, and the UI needs to say so rather than
    # leaving an empty panel unexplained.
    monitoring_capabilities = Column(JSON, nullable=True)

    @property
    def borg_repo_path(self) -> str:
        """Absolute path of the repository holding this node's archives.

        Derived from `borg_shard_index` rather than stored, so it cannot drift
        from the column. It is a property on the model, not a field computed in
        a router, because `NodeResponse` is returned from a dozen places and
        `from_attributes` picks this up in all of them — including the node list
        the restore kiosk reads, which is the one consumer that cannot work out
        the shard layout on its own.
        """
        from core import repo_paths
        return repo_paths.repo_path_for_node(self)


class BackupHistory(Base):
    """
    BackupHistory model containing compression metrics and execution logs for historical archives.
    """
    __tablename__ = 'backup_history'
    # Declared here so `alembic revision --autogenerate` sees them. They were
    # created by migration only, which meant the next autogenerate run would
    # have emitted DROP INDEX for each one.
    __table_args__ = (
        Index('ix_backup_history_node_id_status', 'node_id', 'status'),
        # Status on its own: the composite above leads with node_id and so
        # cannot serve the fleet-wide "all successful archives" scans.
        Index('ix_backup_history_status', 'status'),
    )

    id = Column(Integer, primary_key=True, index=True)
    node_id = Column(Integer, ForeignKey('nodes.id'), nullable=False)
    archive_name = Column(String, unique=True, index=True, nullable=False)
    timestamp = Column(DateTime, default=func.now(), nullable=False, index=True)
    original_size = Column(BigInteger, nullable=False) # Original uncompressed size
    deduplicated_size = Column(BigInteger, nullable=False) # Deduplicated storage size
    # What restoring or syncing this archive actually transfers: the compressed
    # size of every chunk it references, whether or not another archive already
    # brought them into the repository.
    #
    # Distinct from `deduplicated_size`, which is this archive's *contribution*
    # to the repository and says nothing about its contents — a second backup of
    # an unchanged node contributes a few hundred KB while still being a couple
    # of GB to restore. Borg reports it in the same JSON the other two come from
    # and it used to be discarded, so the UI estimated the download from
    # `original_size * 0.4`. Null on rows written before this column existed.
    compressed_size = Column(BigInteger, nullable=True)
    status = Column(String, nullable=False) # SUCCESS, FAILED
    log_output = Column(Text, nullable=True)
    comment = Column(Text, nullable=True)

    # Transfer throughput to the repository, in Mbit/s. NULL when borg reported
    # no progress to measure, e.g. a very short or failed run.
    avg_speed_mbps = Column(Float, nullable=True)
    max_speed_mbps = Column(Float, nullable=True)

    # How long the run took. Needed to tell whether a node still fits inside its
    # group's backup window. NULL on rows written before this was recorded.
    duration_seconds = Column(Float, nullable=True)

    # One of core.backup_stats.FailureCategory, derived from log_output when the
    # run fails. Stored rather than derived on read so the reliability panel does
    # not have to pull every failed log out of the database.
    error_category = Column(String, nullable=True)


class TaskLog(Base):
    """
    TaskLog model storing execution progress and logs for frontend console streaming.
    """
    __tablename__ = 'task_logs'
    # See the note on BackupHistory: migration-only index, declared so
    # autogenerate does not drop it.
    __table_args__ = (
        Index('ix_task_log_node_id_created_at', 'node_id', 'created_at'),
    )

    id = Column(String, primary_key=True, index=True) # UUID string representation
    task_type = Column(String, nullable=False) # BOOTSTRAP, PREPARE, BACKUP, RESTORE
    # Indexed: the daily prune and the startup reconciliation both filter on
    # status alone, which ix_task_log_node_id_created_at cannot serve.
    status = Column(String, default='PENDING', nullable=False, index=True) # PENDING, RUNNING, SUCCESS, FAILED
    node_id = Column(Integer, ForeignKey('nodes.id', ondelete='CASCADE'), nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)
    log_output = Column(Text, default='', nullable=False)


class SystemLog(Base):
    """
    Model for general system/application logs.
    """
    __tablename__ = 'system_logs'

    id = Column(Integer, primary_key=True, index=True)
    level = Column(String, nullable=False)
    message = Column(Text, nullable=False)
    # Indexed: read with ORDER BY created_at DESC LIMIT, and now swept by date.
    created_at = Column(DateTime, default=func.now(), nullable=False, index=True)


class AuditLog(Base):
    """
    Model for recording user action audits (logging who did what, from where, and when).
    """
    __tablename__ = 'audit_logs'

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, nullable=False, index=True)
    action = Column(String, nullable=False)
    details = Column(Text, nullable=True)
    ip_address = Column(String, nullable=True)
    # Indexed: read with ORDER BY created_at DESC LIMIT, and now swept by date.
    created_at = Column(DateTime, default=func.now(), nullable=False, index=True)


class Kiosk(Base):
    """
    Model for dynamic Kiosk connection and pairing.
    """
    __tablename__ = 'kiosks'

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=True)
    kiosk_id = Column(String, unique=True, index=True, nullable=False)
    key = Column(String, unique=True, index=True, nullable=False)
    status = Column(String, default='PENDING', nullable=False) # PENDING, APPROVED, REVOKED
    ip_address = Column(String, nullable=True)
    ssh_pub_key = Column(Text, nullable=True)
    auth_token = Column(String, unique=True, nullable=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    approved_at = Column(DateTime, nullable=True)
    last_seen = Column(DateTime, nullable=True)
    contact = Column(String, nullable=True)
    comment = Column(Text, nullable=True)
    target_ip = Column(String, nullable=True)
    rebuild_required = Column(Boolean, default=False, nullable=False)
    iso_built_at = Column(DateTime, nullable=True)
    payload_outdated = Column(Boolean, default=False, nullable=False)





class User(Base):
    """
    Model for administrator and superadmin user accounts.
    """
    __tablename__ = 'users'

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    name = Column(String, nullable=False)
    phone = Column(String, nullable=True)
    telegram_id = Column(String, nullable=True)
    comment = Column(Text, nullable=True)

    # Per-user UI state that should follow the person rather than the browser:
    # which series the monitoring graphs plot and how deep a window they show.
    # Stored server-side so the same choices appear from any machine.
    ui_preferences = Column(JSON, nullable=True)
    # Self-service delivery subscription. NULL means "never configured",
    # read as disabled — nobody is opted in just because a telegram_id
    # happens to be on file. {"telegram_enabled": bool, "min_severity": str}
    notification_prefs = Column(JSON, nullable=True)
    is_superadmin = Column(Boolean, default=False, nullable=False)
    is_admin_plus = Column(Boolean, default=False, nullable=False)


class SshKeyFinding(Base):
    """One authorized_keys entry as seen by the most recent audit scan.

    Rows are upserted rather than replaced, so `first_seen` records how long a
    stray has been present and pruned entries stay on the record afterwards.
    """
    __tablename__ = 'ssh_key_findings'
    __table_args__ = (
        UniqueConstraint('location', 'host', 'fingerprint', name='uq_ssh_finding'),
    )

    id = Column(Integer, primary_key=True, index=True)
    # ORCHESTRATOR or NODE
    location = Column(String, nullable=False)
    # Node hostname, or the '__orchestrator__' sentinel. Not nullable: Postgres
    # treats NULLs as distinct, which would defeat the unique constraint above.
    host = Column(String, nullable=False)
    node_id = Column(Integer, ForeignKey('nodes.id', ondelete='SET NULL'), nullable=True)

    fingerprint = Column(String, nullable=False, index=True)
    key_type = Column(String, nullable=True)
    comment = Column(Text, nullable=True)
    options = Column(Text, nullable=True)

    classification = Column(String, nullable=False)
    reason = Column(Text, nullable=True)

    first_seen = Column(DateTime, default=func.now(), nullable=False)
    last_seen = Column(DateTime, default=func.now(), nullable=False)
    resolved_at = Column(DateTime, nullable=True)

    # Two-strike state. Cleared whenever the entry stops being orphaned.
    orphan_since = Column(DateTime, nullable=True)
    orphan_scan_count = Column(Integer, default=0, nullable=False)

    pruned_at = Column(DateTime, nullable=True)




class TelemetryRollup(Base):
    """A time bucket of node telemetry, aggregated for long-term storage.

    Raw minute samples are fitted at harvest and discarded — at a thousand
    nodes they would be tens of millions of rows a month for data nothing
    reads twice. These buckets are what the charts read months later, which
    is why each carries maxima alongside means: a peak temperature averaged
    away is exactly the thing somebody will later wish had been kept.

    Buckets are aligned to the absolute epoch grid, not to each node's first
    sample, so two nodes' rows for the same bucket are directly comparable —
    which is what the cohort detector depends on.
    """
    __tablename__ = 'telemetry_rollups'
    __table_args__ = (
        UniqueConstraint('node_id', 'bucket_start', name='uq_telemetry_rollup'),
        # Charts always ask for one node over a time range, and the retention
        # sweep always asks for everything before a date.
        Index('ix_telemetry_rollups_node_bucket', 'node_id', 'bucket_start'),
    )

    id = Column(Integer, primary_key=True, index=True)
    node_id = Column(Integer, ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False)
    bucket_start = Column(DateTime, nullable=False, index=True)
    sample_count = Column(Integer, nullable=False)

    power_w_mean = Column(Float, nullable=True)
    power_w_max = Column(Float, nullable=True)
    cpu_temp_c_mean = Column(Float, nullable=True)
    cpu_temp_c_max = Column(Float, nullable=True)
    board_temp_c_mean = Column(Float, nullable=True)
    ssd_temp_c_mean = Column(Float, nullable=True)
    cpu_util_mean = Column(Float, nullable=True)
    io_service_ms_mean = Column(Float, nullable=True)
    throttled = Column(Boolean, default=False, nullable=False)


class ThermalFit(Base):
    """One thermal model identified from one window of telemetry.

    Rows are written for rejected windows too, carrying only the rejection
    reason and the excitation that caused it. A node with no theta needs to
    be distinguishable from a node nobody looked at, and "the load never
    varied enough" is the answer an operator will ask for.
    """
    __tablename__ = 'thermal_fits'
    __table_args__ = (
        UniqueConstraint('node_id', 'window_start', name='uq_thermal_fit_window'),
        # The cohort detector asks for every node's fits inside one window; the
        # per-node trend asks for one node's fits over time.
        Index('ix_thermal_fits_node_window', 'node_id', 'window_start'),
    )

    id = Column(Integer, primary_key=True, index=True)
    node_id = Column(Integer, ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False)
    window_start = Column(DateTime, nullable=False, index=True)
    window_end = Column(DateTime, nullable=False)

    # core.thermal.Rejection: OK, or why this window yielded nothing.
    rejection = Column(String, nullable=False)
    n_samples = Column(Integer, nullable=False, default=0)
    excitation = Column(Float, nullable=True)

    theta_c_per_w = Column(Float, nullable=True)
    # Theta corrected back to reference conditions. Comparing a node against
    # its own past needs this; comparing nodes within the same window does
    # not, since they share the weather.
    theta_normalised = Column(Float, nullable=True)
    tau_seconds = Column(Float, nullable=True)
    t_ambient_c = Column(Float, nullable=True)
    mean_temp_c = Column(Float, nullable=True)
    r_squared = Column(Float, nullable=True)

    created_at = Column(DateTime, default=func.now(), nullable=False)


class SmartSnapshot(Base):
    """One smartctl reading of one device, parsed and scored.

    `raw` holds the complete smartctl report so the UI can show the full
    statistics of the latest query. It is nulled out on older rows by the
    retention task — the report is ~15 KB, which across a fleet and a year
    would dwarf everything else in this database, while the parsed scalars
    beside it are what the history graph actually plots.
    """
    __tablename__ = 'smart_snapshots'
    __table_args__ = (
        Index('ix_smart_snapshots_node_captured', 'node_id', 'captured_at'),
    )

    id = Column(Integer, primary_key=True, index=True)
    node_id = Column(Integer, ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False)
    captured_at = Column(DateTime, default=func.now(), nullable=False, index=True)
    device = Column(String, nullable=False)

    protocol = Column(String, nullable=True)
    model = Column(String, nullable=True)
    serial = Column(String, nullable=True)
    firmware = Column(String, nullable=True)

    health_passed = Column(Boolean, nullable=True)
    temperature_c = Column(Integer, nullable=True)
    power_on_hours = Column(Integer, nullable=True)
    written_bytes = Column(BigInteger, nullable=True)
    percent_used = Column(Float, nullable=True)

    score = Column(Integer, nullable=True)
    grade = Column(String, nullable=True)
    subscores = Column(JSON, nullable=True)
    overrides = Column(JSON, nullable=True)
    advisories = Column(JSON, nullable=True)

    # none_as_null matters here. SQLAlchemy's JSON type stores a Python None
    # as the JSON value `null` by default, not as SQL NULL — so a report
    # cleared by retention would still satisfy `raw IS NOT NULL`. Retention
    # would re-clear the same rows on every run and report a false count, and
    # the "full statistics" endpoint would hand back a null report instead of
    # honestly saying none is stored. Absence is what None means here.
    raw = Column(JSON(none_as_null=True), nullable=True)


class Alert(Base):
    """One alert-worthy condition, from open through resolution.

    `dedup_key` is unique only while the row is not RESOLVED (see the
    migration's partial index) — a resolved problem that recurs opens a new
    row rather than reusing the old one, so `first_seen` always means what it
    says for that specific episode.
    """
    __tablename__ = 'alerts'
    __table_args__ = (
        # sqlite_where kept alongside postgresql_where so the partial index
        # (not a full-table unique constraint) also applies to the SQLite
        # databases the test suite runs against — production only ever runs
        # on Postgres via the migration, but the model's metadata is used
        # directly (Base.metadata.create_all) in tests, so both need this.
        Index('uq_alert_open_dedup', 'dedup_key', unique=True,
              postgresql_where=text("status != 'RESOLVED'"),
              sqlite_where=text("status != 'RESOLVED'")),
        # The sweep scans open alerts by status; the API lists them per node
        # and orders by recency.
        Index('ix_alerts_status', 'status'),
        Index('ix_alerts_node_id', 'node_id'),
        Index('ix_alerts_last_seen', 'last_seen'),
    )

    id = Column(Integer, primary_key=True, index=True)
    module = Column(String, nullable=False)           # "smart", "thermal", ...
    dedup_key = Column(String, nullable=False, index=True)
    node_id = Column(Integer, ForeignKey('nodes.id', ondelete='CASCADE'), nullable=True)

    severity = Column(String, nullable=False)          # WATCH, ALERT
    status = Column(String, nullable=False, default='OPEN')  # OPEN, ACKNOWLEDGED, RESOLVED

    title = Column(String, nullable=False)
    detail = Column(JSON, nullable=True)

    first_seen = Column(DateTime, default=func.now(), nullable=False)
    last_seen = Column(DateTime, default=func.now(), nullable=False)
    resolved_at = Column(DateTime, nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)
    acknowledged_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
