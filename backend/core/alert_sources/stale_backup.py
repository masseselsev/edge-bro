"""Stale-backup alert candidates: a node overdue for its next backup, or one
that has never completed one. Reuses Node.last_backup -- no new column.
"""
from __future__ import annotations

from typing import List

from sqlalchemy.orm import Session

import models
from core.alerts import AlertCandidate
from core.alert_config import get as get_alert_config
from core.clock import utcnow


def evaluate(db: Session) -> List[AlertCandidate]:
    cfg = get_alert_config(db, "stale_backup")
    if not cfg["enabled"]:
        return []

    days = cfg["days"]
    now = utcnow()
    candidates: List[AlertCandidate] = []

    # group_id required: an unassigned node has no schedule to be overdue
    # against, and alerting on it would just restate "not set up yet".
    nodes = (
        db.query(models.Node)
        .filter(
            models.Node.backup_paused.is_(False),
            models.Node.group_id.isnot(None),
        )
        .all()
    )
    for node in nodes:
        if node.last_backup is not None:
            age_days = (now - node.last_backup).days
            if age_days < days:
                continue
            title = f"No successful backup in {age_days}+ days: {node.hostname}"
        else:
            # Never backed up. Only once the node is READY -- NEEDS_BOOTSTRAP
            # and NEEDS_FIX nodes have never had a chance to run one, and
            # alerting on them would just restate their own status.
            if node.status != "READY":
                continue
            title = f"Never backed up: {node.hostname}"

        candidates.append(AlertCandidate(
            module="stale_backup",
            node_id=node.id,
            dedup_key=f"stale_backup:{node.id}",
            severity="ALERT",
            title=title,
            detail={
                "last_backup": node.last_backup.isoformat() if node.last_backup else None,
                "threshold_days": days,
            },
        ))
    return candidates
