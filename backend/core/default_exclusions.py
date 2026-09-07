"""Canonical default entries for Settings.global_exclusions.

Single source of truth: both the ORM column default (models.py) and the
GET /settings/global-exclusions/defaults endpoint (routers/settings.py)
import this list rather than each keeping their own copy — that duplication
is what let a customer's exclusions silently drift from what a fresh
install seeds.
"""

DEFAULT_GLOBAL_EXCLUSIONS = [
    {"pattern": "/dev/*", "comment": "System devices"},
    {"pattern": "/proc/*", "comment": "Virtual process filesystem"},
    {"pattern": "/sys/*", "comment": "Sysfs system info"},
    {"pattern": "/run/*", "comment": "Transient runtime files"},
    {"pattern": "/tmp/*", "comment": "Temporary files"},
    {"pattern": "/home/*", "comment": "User home directories"},
    {"pattern": "/mnt/*", "comment": "Mounted filesystems"},
    {"pattern": "/media/*", "comment": "Removable media mounts"},
    {"pattern": "/lost+found", "comment": "Recovered filesystem fragments"},
    {"pattern": "/var/log/edge/*", "comment": "Edge app logs"},
    {"pattern": "/var/opt/edge/blobstore/*", "comment": "Local media files storage"},
    {"pattern": "/var/opt/edge/trainer/*", "comment": "Edge trainer application data"},
    {"pattern": "/var/spool/edge/*", "comment": "Edge spool directory"},
    {"pattern": "/var/log/journal/*", "comment": "Systemd journal logs"},
    {"pattern": "/var/log/**/*.gz", "comment": "Compressed rotated logs"},
    {"pattern": "/var/log/**/*.1", "comment": "Rotated log backups"},
    {"pattern": "/var/hasplm/*", "comment": "Sentinel HASP licensing data"},
    {"pattern": "/etc/hasplm/*", "comment": "Sentinel HASP licensing config"},
    {"pattern": "/var/opt/edge/*.iso", "comment": "ISO disk images"},
    {"pattern": "/var/tmp/*", "comment": "Preserved temporary files"},
    {"pattern": "/var/cache/apt/archives/*", "comment": "Cached APT package archives"},
    {"pattern": "/var/crash/*", "comment": "System crash dumps"},
    {"pattern": "/var/lib/systemd/coredump/*", "comment": "Systemd process core dumps"},
    {"pattern": "/swapfile", "comment": "System swap file"},
    {"pattern": "/root/.cache/*", "comment": "Root user temporary cache"},
]
