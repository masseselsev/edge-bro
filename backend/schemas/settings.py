"""Global orchestrator settings and the sub-objects they nest."""
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, field_validator


class RetentionPolicySchema(BaseModel):
    type: str = Field(default='interval')  # 'interval', 'count', 'timeframe'
    keep_daily: int = Field(default=7, ge=0)
    keep_weekly: int = Field(default=4, ge=0)
    keep_monthly: int = Field(default=6, ge=0)
    keep_last: int = Field(default=5, ge=1)
    within_value: int = Field(default=3, ge=1)
    within_unit: str = Field(default='m')  # 'd', 'w', 'm', 'y'

class ExclusionSchema(BaseModel):
    pattern: str
    comment: str

class CredentialSchema(BaseModel):
    id: str
    username: str
    password: Optional[str] = None
    comment: str = ""

class CredentialSummary(BaseModel):
    """A bootstrap credential without its password.

    What `GET /api/settings` returns `bootstrap_credentials` as. The password
    is needed only at the moment a caller submits a provisioning request, not
    on every settings page load — see `GET /api/settings/credentials`, which
    returns the full `CredentialSchema` and exists for exactly that moment.
    """
    id: str
    username: str
    comment: str = ""

class SettingsBase(BaseModel):
    borg_ssh_port: int = Field(default=12345, ge=1, le=65535)
    keep_daily: int = Field(default=7, ge=0)
    keep_weekly: int = Field(default=4, ge=0)
    keep_monthly: int = Field(default=6, ge=0)
    global_exclusions: List[ExclusionSchema] = Field(default=[])
    orchestrator_ip: str = Field(default='')
    orchestrator_behind_nat: bool = Field(default=False)
    timezone: str = Field(default='Browser Local')
    language: str = Field(default='en')
    retention_policy: Optional[RetentionPolicySchema] = None
    default_compression: str = Field(default='zstd:3')
    default_cpu_quota: Optional[int] = Field(default=30, ge=0, le=400)
    default_rate_limit: Optional[int] = Field(default=None, ge=0)
    server_ips: Optional[List[str]] = Field(default=[])
    max_kiosk_isos: int = Field(default=5, ge=1)
    server_name: str = Field(default='edge-bro')
    bootstrap_credentials: List[CredentialSchema] = Field(default=[])
    default_credentials_id: Optional[str] = Field(default='')
    server_net_capacity_mbps: int = Field(default=1000, ge=1)
    # None = keep successful thermal fits forever (the default, and the
    # recommendation — see monitoring_retention_task). Set only if an operator
    # wants a hard ceiling on the table's growth.
    thermal_fit_retention_days: Optional[int] = Field(default=None, ge=1)
    # Off by default. Only a superadmin's POST /api/settings is honoured for
    # this field — see routers/settings.py's update_settings — so a plain
    # admin submitting a settings form that happens to carry a different
    # value here cannot change it.
    allow_admin_key_terminal_access: bool = Field(default=False)
    # Per-source alert engine config: {"stale_backup": {"enabled": true, "days": 3}, ...}.
    # See core/alert_config.py for the defaults each source falls back to.
    alert_config: Optional[Dict[str, Any]] = Field(default=None)


    @field_validator('server_name')
    @classmethod
    def validate_server_name(cls, v: str) -> str:
        import re
        # Used as an ISO filename prefix, so it is normalised to lowercase and
        # kept free of dots and separators.
        v = v.lower()
        if not re.match(r'^[a-z0-9][a-z0-9_-]*$', v):
            raise ValueError(
                "Server name must start with a letter or digit and contain only "
                "letters, numbers, hyphens, and underscores — no dots or spaces."
            )
        return v

class SettingsResponse(SettingsBase):
    id: int
    available_ips: Optional[List[str]] = None
    borg_host_data_path: Optional[str] = None
    # Shadows SettingsBase.bootstrap_credentials: this is what makes the field
    # write-only. Pydantic validates each stored dict against CredentialSummary
    # and drops the password key, since CredentialSummary never declares it.
    # The real values are reached at GET /api/settings/credentials instead.
    bootstrap_credentials: List[CredentialSummary] = Field(default=[])

    class Config:
        from_attributes = True
