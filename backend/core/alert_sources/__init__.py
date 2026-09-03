"""Registry of alert-producing modules. Adding a source is adding a file
with an evaluate(db) -> list[AlertCandidate] function and one line here —
core.alerts and core.notify never change.
"""
from typing import Callable, Dict, List

from sqlalchemy.orm import Session

from core.alerts import AlertCandidate
from core.alert_sources import smart as smart_source
from core.alert_sources import thermal as thermal_source
from core.alert_sources import stale_backup as stale_backup_source

SOURCES: Dict[str, Callable[[Session], List[AlertCandidate]]] = {
    "smart": smart_source.evaluate,
    "thermal": thermal_source.evaluate,
    "stale_backup": stale_backup_source.evaluate,
}
