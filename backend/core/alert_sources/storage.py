"""Low-storage alert candidates: free space at every path this install
writes into -- every active borg shard, plus the ISO cache. One source
covers both "host disk is full" and "this shard is full", because a shard
can be its own mount and checking its free space *is* checking host disk
space for that path.
"""
from __future__ import annotations

import os
import shutil
from typing import List, Optional

from sqlalchemy.orm import Session

from core import repo_paths
from core.alerts import AlertCandidate
from core.alert_config import get as get_alert_config

#: Container-side mount point for the ISO cache volume (docker-compose.yml);
#: the host-side path behind it is whatever ISO_CACHE_HOST_PATH resolves to.
ISO_CACHE_PATH = "/opt/data/iso_cache"


def _percent_free(path: str) -> Optional[float]:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return None
    if usage.total == 0:
        return None
    return 100.0 * usage.free / usage.total


def evaluate(db: Session) -> List[AlertCandidate]:
    cfg = get_alert_config(db, "storage")
    if not cfg["enabled"]:
        return []

    watch_pct, alert_pct = cfg["watch_percent"], cfg["alert_percent"]
    candidates: List[AlertCandidate] = []

    paths = [(p, f"Repository shard: {p}") for p in repo_paths.all_shard_paths()]
    if os.path.isdir(ISO_CACHE_PATH):
        paths.append((ISO_CACHE_PATH, "ISO cache"))

    for path, label in paths:
        free_pct = _percent_free(path)
        if free_pct is None:
            continue
        if free_pct < alert_pct:
            severity = "ALERT"
        elif free_pct < watch_pct:
            severity = "WATCH"
        else:
            continue
        candidates.append(AlertCandidate(
            module="storage",
            node_id=None,
            dedup_key=f"storage:{path}",
            severity=severity,
            title=f"{label} low on space: {free_pct:.1f}% free",
            detail={
                "path": path, "percent_free": round(free_pct, 1),
                "watch_percent": watch_pct, "alert_percent": alert_pct,
            },
        ))
    return candidates
