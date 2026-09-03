"""SMART alert candidates: the latest snapshot per (node, device), mapped
from its already-computed grade. No recomputation — the score and grade are
stored at harvest time; this module only decides which grades are alert-worthy.
"""
from __future__ import annotations

from typing import List

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from core.alerts import AlertCandidate

_SEVERITY_BY_GRADE = {"WATCH": "WATCH", "REPLACE": "ALERT"}


def evaluate(db: Session) -> List[AlertCandidate]:
    from core.alert_config import get as get_alert_config
    if not get_alert_config(db, "smart")["enabled"]:
        return []

    latest = (
        db.query(
            models.SmartSnapshot.node_id.label("node_id"),
            models.SmartSnapshot.device.label("device"),
            func.max(models.SmartSnapshot.captured_at).label("captured_at"),
        )
        .group_by(models.SmartSnapshot.node_id, models.SmartSnapshot.device)
        .subquery()
    )
    rows = (
        db.query(models.SmartSnapshot)
        .join(
            latest,
            (models.SmartSnapshot.node_id == latest.c.node_id)
            & (models.SmartSnapshot.device == latest.c.device)
            & (models.SmartSnapshot.captured_at == latest.c.captured_at),
        )
        .all()
    )

    candidates: List[AlertCandidate] = []
    for row in rows:
        severity = _SEVERITY_BY_GRADE.get(row.grade)
        if severity is None:  # OK, UNKNOWN -> not alert-worthy
            continue
        candidates.append(AlertCandidate(
            module="smart",
            node_id=row.node_id,
            dedup_key=f"smart:{row.node_id}:{row.device}",
            severity=severity,
            title=f"SMART {row.grade.lower()}: {row.device}",
            detail={
                "score": row.score, "grade": row.grade, "device": row.device,
                "model": row.model,
                "captured_at": row.captured_at.isoformat() if row.captured_at else None,
            },
        ))
    return candidates
