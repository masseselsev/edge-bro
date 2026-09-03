"""Per-source alert configuration: whether a source runs at all, and the
thresholds it evaluates against. Stored as one JSON column on Settings so
adding a source later is a dict entry, not a migration.
"""
from __future__ import annotations

from typing import Any, Dict

from sqlalchemy.orm import Session

import models

DEFAULTS: Dict[str, Dict[str, Any]] = {
    "smart": {"enabled": True},
    "thermal": {"enabled": True},
    "stale_backup": {"enabled": True, "days": 3},
    "node_offline": {"enabled": True, "days": 3},
    "storage": {"enabled": True, "watch_percent": 15, "alert_percent": 5},
}


def get(db: Session, source: str) -> Dict[str, Any]:
    """This source's config, defaults merged under whatever is stored.

    Missing `Settings` row, missing key, or a partially-stored sub-object
    all fall back to `DEFAULTS[source]` for whatever they don't cover --
    this is the only place that needs to know the shape is "merge, don't
    replace".
    """
    settings = db.query(models.Settings).first()
    stored = (settings.alert_config or {}).get(source, {}) if settings else {}
    return {**DEFAULTS[source], **stored}
