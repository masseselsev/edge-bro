"""Thermal alert candidates, one per node whose combined verdict is WATCH or
ALERT. Uses the same detectors as the dashboard badge.

The fleet's thermal state is read once per sweep via a ThermalContext and then
queried per node in memory. Doing it the other way round — calling
thermal_verdict() in a loop — is quadratic, because the cohort comparison is
inherently fleet-wide: every call re-read every fit belonging to every node,
computed verdicts for all of them, and discarded all but one. At 2000 nodes
that was tens of millions of rows materialised per hourly sweep.
"""
from __future__ import annotations

from datetime import datetime
from typing import List

from sqlalchemy.orm import Session

import models
from core.alerts import AlertCandidate
from core.monitoring_verdicts import build_thermal_context, verdict_from_context
from core.clock import utcnow

_ALERT_STATUSES = {"WATCH", "ALERT"}


def evaluate(db: Session) -> List[AlertCandidate]:
    from core.alert_config import get as get_alert_config
    if not get_alert_config(db, "thermal")["enabled"]:
        return []

    now = utcnow()
    context = build_thermal_context(db, now)

    candidates: List[AlertCandidate] = []
    # Only id and hostname are needed; loading full ORM rows for the fleet
    # costs memory this task has no use for.
    for node_id, hostname in db.query(models.Node.id, models.Node.hostname).all():
        verdict = verdict_from_context(context, node_id)
        if verdict.status not in _ALERT_STATUSES:
            continue
        candidates.append(AlertCandidate(
            module="thermal",
            node_id=node_id,
            dedup_key=f"thermal:{node_id}",
            severity=verdict.status,
            title=f"Thermal interface {verdict.status.lower()}: {hostname}",
            detail={
                "theta_c_per_w": verdict.theta_c_per_w,
                "cohort_status": verdict.cohort_status,
                "drift_status": verdict.drift_status,
                "reasons": verdict.reasons,
            },
        ))
    return candidates
