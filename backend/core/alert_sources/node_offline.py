"""Node-offline alert candidates. Node carries no "offline since" column --
this reads back its own prior open alert (if any) for first_seen, which the
sync engine already maintains, and escalates severity once that crosses the
configured threshold. A node down for five minutes and one down for five
days are not the same event, hence WATCH then ALERT rather than one flat
severity.
"""
from __future__ import annotations

from typing import List

from sqlalchemy.orm import Session

import models
from core.alerts import AlertCandidate
from core.alert_config import get as get_alert_config
from core.clock import utcnow


def evaluate(db: Session) -> List[AlertCandidate]:
    cfg = get_alert_config(db, "node_offline")
    if not cfg["enabled"]:
        return []

    days = cfg["days"]
    now = utcnow()

    offline_nodes = db.query(models.Node).filter(models.Node.status == "OFFLINE").all()
    if not offline_nodes:
        return []

    dedup_keys = [f"node_offline:{n.id}" for n in offline_nodes]
    existing_by_key = {
        row.dedup_key: row
        for row in db.query(models.Alert)
        .filter(models.Alert.dedup_key.in_(dedup_keys), models.Alert.status != "RESOLVED")
        .all()
    }

    candidates: List[AlertCandidate] = []
    for node in offline_nodes:
        key = f"node_offline:{node.id}"
        existing = existing_by_key.get(key)
        since = existing.first_seen if existing else now
        offline_days = (now - since).days
        severity = "ALERT" if offline_days >= days else "WATCH"

        candidates.append(AlertCandidate(
            module="node_offline",
            node_id=node.id,
            dedup_key=key,
            severity=severity,
            title=(f"Offline {offline_days}+ days: {node.hostname}" if offline_days
                   else f"Offline: {node.hostname}"),
            detail={"offline_days": offline_days, "threshold_days": days},
        ))
    return candidates
