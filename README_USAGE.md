# Edge B.R.O. — Usage Guide

🇬🇧 [English](README.md) · [Usage Guide](README_USAGE.md) · 🇷🇺 [Русский](README_ru.md) · [Инструкция](README_USAGE_ru.md)

Step-by-step instructions: from a bare server to managing a fleet of edge devices, creating backups, restoring disks, and generating Live-CD kiosks.

---

## 1. Server Setup

Any x86_64 Linux machine with Docker works. An Intel NUC, a mini-PC, or a full server — whatever you have.

1. Install a base OS (Ubuntu 22.04/24.04/26.04 or Debian 12/13).
2. Install Docker:
   ```bash
    # Option A: Install official Docker CE (Recommended)
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh

    # Option B: Alternatively, install distro-packaged Docker
    # sudo apt update && sudo apt install -y docker.io docker-compose-v2

    # Enable service and configure user permissions
    sudo systemctl enable --now docker
    sudo usermod -aG docker $USER
   ```
   Re-login after adding yourself to the `docker` group.

---

## 2. Deploy the Orchestrator

### 2.1 Clone and configure

```bash
git clone https://github.com/masseselsev/edge-bro.git /opt/stacks/edge-bro
cd /opt/stacks/edge-bro
cp .env.example .env
```

Edit `.env` — every line matters:

```env
# ── Database ──
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<strong_db_password>
POSTGRES_DB=borg_orchestrator
DATABASE_URL=postgresql://postgres:<strong_db_password>@db:5432/borg_orchestrator

# ── Redis ──
REDIS_URL=redis://redis:6379/0

# ── Borg ──
BORG_PASSPHRASE=<strong_borg_passphrase>

# ── Network ──
ORCHESTRATOR_IP=192.168.1.10      # IP of this server, reachable by edge nodes
                                   # Can be changed later in Settings → UI

# ── Superadmin credentials (first launch only) ──
SUPERADMIN_USERNAME=admin          # Login for the web dashboard
ADMIN_PASSWORD=<strong_password>   # Will NOT be overwritten if changed via UI later
JWT_SECRET_KEY=<random_secret>     # Used to sign session tokens

# ── SSH stability (optional) ──
# SSH_KEEPALIVE_INTERVAL=30        # Seconds between keepalive packets
# SSH_KEEPALIVE_COUNT=3            # Missed responses before disconnect

# ── Repository sharding (optional, defaults shown) ──
BORG_SHARD_COUNT=1                 # Independent Borg repositories. Borg locks a
                                   # repository for the whole of `borg create`,
                                   # so one repository = one node writing at a
                                   # time. Raise it later if you need more
                                   # parallel writers; it cannot be lowered.
# BORG_LOCK_WAIT_SECONDS=600       # How long prune and delete wait for the
                                   # repository lock instead of failing
# BORG_CREATE_LOCK_WAIT_SECONDS=60 # The same for a backup, kept short: one that
                                   # cannot have the lock now is retried below
                                   # rather than holding a worker to find out
# BORG_WRITER_TTL=14400            # How long a running backup stays registered
                                   # as a writer without a heartbeat

# ── Backup retries (optional, defaults shown) ──
# BACKUP_REPO_BUSY_COUNTDOWN_SECONDS=600   # How long before asking a busy
#                                          # repository again
# BACKUP_REPO_BUSY_MAX_RETRIES=144         # ~24h of asking before giving up
# BACKUP_RECONNECT_COUNTDOWN_SECONDS=60    # How long before retrying a
#                                          # transfer whose link dropped
# BACKUP_RECONNECT_MAX_RETRIES=3           # Attempts before reporting it

# ── Storage paths ──
BORG_HOST_DATA_PATH=borg-data     # Docker volume by default
                                   # Set an absolute path for external storage:
                                   # BORG_HOST_DATA_PATH=/mnt/hdd/borg_data

ISO_CACHE_HOST_PATH=iso-cache     # Base/client ISO cache, Docker volume by default
                                   # Set an absolute path for external storage:
                                   # ISO_CACHE_HOST_PATH=/mnt/hdd/iso_cache

# ── Docker network (optional, default shown) ──
# DOCKER_SUBNET=172.29.13.0/24     # Subnet for the stack's own network. Change
                                   # it only if it clashes with something this
                                   # host already routes — see 10.4.
```

> **About `SUPERADMIN_USERNAME` / `ADMIN_PASSWORD`**: these values seed the first superadmin account on initial startup. Once created, the account lives in the database. Changing `.env` later won't overwrite a password you've already changed via the web UI. To force-reset: clear the `users` table in PostgreSQL and restart.
>
> 🔑 **Generating a secure `JWT_SECRET_KEY`**: Run this command to generate a strong random secret key for session signing:
> ```bash
> python3 -c "import secrets; print(secrets.token_hex(32))"
> ```
>
> 🌐 **If nodes can't reach the orchestrator directly** (it sits behind NAT with no port forwarding): enable **"Orchestrator is behind NAT"** in Settings → Orchestrator Network Addresses. Backups then tunnel through the orchestrator's own outbound SSH connection to each node instead of connecting straight to the orchestrator's IP. This adds SSH encryption overhead on every backup (the data is encrypted twice), so leave it off unless nodes genuinely can't connect directly. It only covers automated/manual Fleet backups — Live-USB kiosk pairing and restore still need their own network path (e.g. the kiosk's WireGuard client) if the orchestrator is unreachable.

### 2.2 Configure backup storage

By default, backups go into a Docker named volume (`borg-data`) under `/var/lib/docker/volumes/`. For any serious deployment, point it to a dedicated large drive:

```bash
# Create the directory on your large drive
mkdir -p /mnt/hdd/borg_data
chown -R 1000:1000 /mnt/hdd/borg_data
```

Then set in `.env`:
```env
BORG_HOST_DATA_PATH=/mnt/hdd/borg_data
```

> ⚠️ If the root partition fills up, backup tasks will fail with `Insufficient free space` and other host services may break. Always use a dedicated volume for production.

The configured path is shown in the web UI under **Settings**.

### 2.3 Configure ISO cache storage

Separately from backups, the orchestrator keeps an ISO cache at `/opt/data/iso_cache` inside the containers. It holds the downloaded Debian base image — the current Debian stable live build, matched to the packages the orchestrator ships into the kiosk — plus every generated USB-Kiosk client image, so plan for **~20 GB or more**. By default it lives in the `iso-cache` Docker volume under `/var/lib/docker/volumes/`.

To move it to a dedicated drive:

```bash
mkdir -p /mnt/hdd/iso_cache
chown -R 1000:1000 /mnt/hdd/iso_cache
```

Then set in `.env`:
```env
ISO_CACHE_HOST_PATH=/mnt/hdd/iso_cache
```

**Using one drive for both.** If you have a single large volume — an NFS share attached to a small VM, for example — keep the two as sibling directories rather than nesting the cache inside the backup path, which holds borg repositories:

```env
BORG_HOST_DATA_PATH=/mnt/nfs/edge-bro
ISO_CACHE_HOST_PATH=/mnt/nfs/iso_cache
```

The two are independent bind-mounts and need not share a drive at all — put the ISO cache on a separate disk if that suits the host better. The container-side paths (`/data/borg` and `/opt/data/iso_cache`) are fixed and never need changing.

Apply the change — no rebuild needed, the containers just get recreated with the new mount:

```bash
docker compose up -d
```

> ⚠️ Changing this path does **not** move existing data. Anything already cached (base ISO, built client images) stays in the old location and will be re-downloaded or rebuilt. To keep it, copy the contents across before restarting:
> ```bash
> docker run --rm -v edge-bro_iso-cache:/from -v /mnt/hdd/iso_cache:/to alpine cp -a /from/. /to/
> ```

If the cache sits on the system root partition, the dashboard raises an `ISO_CACHE_ON_ROOT` health warning.

### 2.4 Start everything

#### Option A: Pre-built Release Deployment (Recommended for Production)

Zero local compilation or toolchain required. Pull official release images directly from GitHub Container Registry (`ghcr.io`). Starting with **v1.8.1**, deployment requires **strictly only two files** (`docker-compose.yml` and `.env`) — the Live-CD Kiosk payload is embedded inside the container image:

```bash
# 1. Download only docker-compose.yml and .env
curl -fsSL https://raw.githubusercontent.com/masseselsev/edge-bro/v1.8.1/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/masseselsev/edge-bro/v1.8.1/.env.example -o .env

# 2. Configure passwords and settings
nano .env

# 3. Pull images and launch
docker compose pull && docker compose up -d
```

*(Note: If deploying inside a git clone checkout, run `docker compose -f docker-compose.yml up -d` so Compose ignores the development `docker-compose.override.yml` file).*

#### Option B: Local Build from Source (Development Only)

If you are modifying frontend or backend source code locally:

```bash
docker compose up -d --build
```

Database migrations run automatically on startup (the backend container waits for PostgreSQL, applies Alembic migrations, then launches FastAPI).

**Done.** Open `http://<YOUR_SERVER_IP>:7777` in a browser. Log in with the credentials from `.env`.

> ⚠️ Backups themselves are **not** in PostgreSQL. Archives live in the Borg
> repositories on the backup volume, so even a total loss of this database
> costs the node registry, schedules and history — not a single archive.

---

## 3. Adding Nodes (Fleet Provisioning)

Go to the **Fleet** tab.

### 3.1 Add nodes

Click **Add Nodes**. Enter IP addresses in any format:
- Single: `192.168.1.10`
- List: `192.168.1.10, 192.168.1.11, 192.168.1.12`
- Range: `192.168.1.50-60`
- CIDR: `10.0.0.0/24`

Fill in SSH credentials (login, password, port). The form pre-fills defaults (`user` / `admin` / port `2222`) — adjust as needed. Alternatively, you can predefine multiple bootstrap credentials in the **Settings** tab. In the node creation dialog, these pre-saved variants will be displayed by their comment or their username/password pair.

### 3.2 What happens during Bootstrap

The orchestrator connects to each node in parallel (up to 24 at a time) and:

1. **Bypasses dead APT proxies** — temporarily renames unreachable proxy configs, restores them after.
2. **Installs packages** — `python3`, `borgbackup`, `parted`, `e2fsprogs`, `dosfstools`.
3. **Injects SSH key** — appends the orchestrator's Ed25519 public key to `/root/.ssh/authorized_keys`. Sets `PermitRootLogin prohibit-password`.
4. **Creates `borg` user** — system user with its own SSH keypair for pushing backup data.
5. **Gathers hardware/software info** — disk type, EFI UUID, hostname, OS version, partition layout, network interfaces, RAM size, CPU model/cores, Edge software version, and Sentinel LDK runtime version.

From this point on, all communication is key-based — no passwords stored.

### 3.3 Auto-Prepare (disk labeling)

If a node shows status **NEEDS_FIX**, click **Auto-Prepare**. This:

1. Backs up `/etc/fstab` → `/etc/fstab.bak`.
2. Writes persistent labels to partitions: `edgeroot` (root), `edgeboot` (boot), `edgelog` (logs), `edgestor` (data), `EFI` (boot EFI).
3. Rewrites `/etc/fstab` using `LABEL=` entries instead of `/dev/sdX` paths. This makes the system immune to disk name drift (SATA ↔ NVMe swaps).
4. Runs `update-grub` + `update-initramfs -u` to embed the new config.

If anything fails, the original fstab is auto-restored from backup.

---

## 4. Creating Backups

### 4.1 Manual backup

1. In the **Fleet** tab, click the **Backup** button on any node row.
2. Click **View Logs** to watch real-time terminal output.
3. The orchestrator SSHes into the node, runs `borg create`, and data streams back to the central Borg repository.
4. Track results in the **Archive** tab (sizes, timestamps, deduplication stats).

**If the repository is busy.** Borg allows one writer per repository and holds the lock for the whole of `borg create`, so backups bound for the same shard run one at a time. A run that arrives while another is writing waits its turn — checking back every ten minutes for up to a day — rather than failing. It is not recorded as a failed backup unless that budget runs out. Raise `BORG_SHARD_COUNT` if you need genuinely parallel writers.

**Stopping a run.** Press **Backup** on a node that is already backing up and the dialog offers **Stop** instead of starting a second one. It ends a run that is waiting its turn as well as one already transferring, and what has been transferred so far is kept: the next run resumes from borg's last checkpoint rather than starting over.

Pressing **Backup** twice on the same node does not start a second backup — the duplicate could only queue behind the first.

### 4.2 Scheduled backups (Backup Groups)

Go to the **Schedule** tab → **Create Group**.

A backup group defines:
- **Which nodes** belong to it (drag from the list)
- **Interval** — 10min, 30min (both for testing purposes), weekly, monthly, quarterly, yearly
- **Execution window** — start time / end time
- **Concurrency limit** — how many nodes back up simultaneously

#### Resource limits (per group)

| Setting | What it does |
|---------|-------------|
| **Upload Rate Limit** (KiB/s) | Caps network throughput per backup stream |
| **CPU Quota** (%) | Limits CPU on the target node (0–400% of one core). Enforced via `systemd-run --scope -p CPUQuota=...` |
| **Compression** | Algorithm selection: `lz4` (fast), `zstd:1`–`zstd:9` (better ratio). `zstd:3` is the shipped default — the best ratio-for-CPU tradeoff for mixed backup data. Deduplication is keyed on plaintext chunk content before compression, so mixing compression settings within one repository is safe: it only affects the new chunks a run adds. |
| **Checkpoint Interval** | Auto-calculated from upload speed by default, and capped so a dropped link can never lose more than a few minutes of transfer. Manual override available (seconds). |

#### Per-node overrides

A single node can differ from the rest of its group. Open **Node Details** and
set any of these; each falls back to the group, then to the global default:

| Override | Values |
|---------|--------|
| **NAT tunnel** | Inherit / Behind NAT / Direct |
| **Upload limit** (Mbit/s) | Empty inherits the group limit |
| **CPU quota override** | Inherit / No limit / a custom percentage of one core |

#### Smart queue behavior

- **Dynamic concurrency**: if the window is running short, the scheduler automatically increases parallelism to finish on time.
- **Bandwidth capping**: with low upload limits, concurrency is auto-reduced to ensure stability (recommending/allocating ~2 MiB/s per stream, though it can scale lower depending on network capacity).
- **FIFO queue**: nodes are launched sequentially by stagger offset. When one finishes, the next starts immediately.
- **Running protection**: backups already in progress are allowed to finish past the window close.

#### Retention policies

Each group can inherit the global retention policy or override with its own:
- **Interval** — keep N daily + N weekly + N monthly backups
- **Count** — keep last N backups total
- **Timeframe** — keep everything within the last N days/weeks/months/years

Global defaults (retention, compression, CPU quota) are configured in **Settings**.

Pruning runs automatically at 03:00 daily via Celery Beat, followed by `borg compact`.

### 4.3 How deduplication saves space

Nodes are spread over `BORG_SHARD_COUNT` Borg repositories (default 1), and
nodes sharing one store identical files only once.

| Scenario | Space used |
|----------|-----------|
| 1st node in a shard (6 GB base OS) | ~2.2–2.7 GB (55–65% compression) |
| Each additional cloned node | +100–200 MB (97% dedup) |
| Nodes with minor differences | +20–30% of unique data |
| Incremental backup runs | ~100–200 MB per run |

Deduplication does not cross a shard boundary, so the base image is stored once
per shard. That is the price of parallelism: Borg holds a repository's lock for
the entire duration of `borg create`, so with a single repository only one node
in the whole fleet can be writing at any moment. Five shards buy five
simultaneous writers for a few extra GB.

A node's shard is `node.id % BORG_SHARD_COUNT`, worked out once when it is
enrolled and then stored on the node, never recomputed.

**You can raise `BORG_SHARD_COUNT` later. You cannot lower it.** Because the
shard is stored, adding shards leaves every existing node in the repository
that holds its archives and routes only new enrolments to the new ones. So a
small deployment can start at `1` — byte-for-byte the layout that predates
sharding — and add capacity when it grows:

```bash
# in .env
BORG_SHARD_COUNT=2

docker compose up -d --build
```

That is the whole procedure. The SSH forced command names the repositories a
key may reach and is derived from the count, so the fleet's grants have to be
rewritten to match — the orchestrator does that itself on startup. It is
idempotent and reports what it did in the backend log:

```
Shards: /data/borg/fleet, /data/borg/shard-1
2 borg grant(s): 1 to update, 1 already current.
```

`scripts/reauthorize_shard_access.py` is still there for running by hand, and
takes `--dry-run` to show what would change without changing it.

**Lowering the count is prevented, not merely reported.** The repositories
present on disk put a floor under the setting: a `shard-N` directory exists
because a node was routed there, so the fleet goes on serving it whatever the
variable says. Startup states that the setting was overridden and what to set
instead. Were it allowed through, the shard would drop out of the fleet-wide
list — the nightly prune would skip it and its nodes' keys would stop being
granted it, failing their backups with a "restricted path" error that points
nowhere near the setting responsible.

One case the floor cannot see is a node assigned to a shard it has not yet
written to, since there is no directory to infer it from. Startup checks the
database for that separately, and when it finds one it **suppresses the grant
rewrite** — rewriting to a lower count would narrow the grants and take away
access those nodes still depend on.

#### How many shards do you need

**Not one per N nodes.** Backup groups spread the fleet across weeks and months
— that is what `interval`, `target_week` and `randomize_days` are for, and
Settings → Scheduler Load shows the resulting calendar — so the number of
backups due on any one night is small by design and is rarely the constraint.

What sizes the shard count is **peak concurrency**, because backups landing on
one repository run strictly one at a time: borg holds its lock for the whole of
`borg create`. A group with `concurrency_limit: 5` on a single shard gets one
writer, not five.

> **Rule of thumb: set `BORG_SHARD_COUNT` to the largest `concurrency_limit`
> you actually want to achieve.** The default is 1, the pre-sharding layout.
> Groups capped at 2 need 2 shards, and no more.

The Scheduler Load calendar accounts for this — a group's usable concurrency is
reported as the smaller of its limit and the shard count, so a plan that would
overrun a serialised window is shown as not fitting rather than looking fine.

The scheduler enforces this too, not just the calendar: it will not dispatch
more concurrent backups than there are shards, since the extras cannot start
and would occupy a worker waiting out `--lock-wait`.

**One thing to decide before a bulk enrolment.** A node's shard is assigned
when it is enrolled and never changes. Raising `BORG_SHARD_COUNT` later routes
*new* nodes to the new repositories, but every node already enrolled stays
where it is — a fleet onboarded at 1 remains entirely on shard 0, however high
you raise the setting afterwards. That is fine for a fleet whose groups spread
the load, which is the normal case. If you are about to enrol hundreds of nodes
and want them spread, set the count first.

An incremental run is a small fraction of a first backup — most of its cost is
walking the filesystem, not moving data — so a shard absorbs a few hundred
serialised backups inside a typical window. A spread schedule will not come
close to that. Settings → Scheduler Load reports your own figures.

**Settings → Storage → Repository Capacity answers this from your own data.**
Rather than working the rule of thumb by hand, it projects the schedule forward
and reports, per repository:

- the busiest night as a percentage of that repository's execution window,
- how many nodes one repository serves in a single night, and how many it
  sustains at the schedule the fleet actually runs,
- how many further enrolments fit before the busiest one saturates,
- what the busiest figure would become at a higher count.

Backup durations come from recorded run times, so the projection reflects the
increments the fleet really does rather than an assumed figure. A node that has
never run is estimated from the fleet's *first* backups, which are the slow
ones — the estimate is not quietly optimistic about onboarding.

Two things it will tell you that are easy to get wrong:

- **Raising the count relieves nothing that is already enrolled.** The
  expansion rows say so explicitly and show the busiest figure unchanged. When
  the busiest repository is genuinely full, the answer is migrating archives,
  not a larger number in `.env`.
- **Repositories give parallel locks, not parallel bandwidth.** Where two
  backups have actually overlapped, the panel measures what the storage carried
  and, if that supports fewer writers than there are repositories, names the
  storage as the limit. Until then it says there is nothing to measure rather
  than printing a number — which is the expected reading on a small or newly
  installed fleet.

The one place more shards genuinely pay off is **onboarding**: first backups
are the expensive ones and they all fall due at once, so the wave finishes in
roughly a fifth of the time on five shards. It runs once and can be left
outside the normal window, which makes it a reason to start with more shards
rather than to keep them.

If in doubt, start low. `BORG_SHARD_COUNT` can be raised later and each shard
costs one extra copy of the base image.

### 4.4 Default backup exclusions

Configured in **Settings** → **Global Exclusions**. Each entry has a pattern and a comment. The shipped defaults:

| Pattern | Purpose |
|---------|---------|
| `/dev/*` | System devices |
| `/proc/*` | Virtual process filesystem |
| `/sys/*` | Sysfs system info |
| `/run/*` | Transient runtime files |
| `/tmp/*` | Temporary files |
| `/home/*` | User home directories |
| `/mnt/*` | Mounted filesystems |
| `/media/*` | Removable media mounts |
| `/lost+found` | Recovered filesystem fragments |
| `/var/log/edge/*` | Edge app logs |
| `/var/opt/edge/blobstore/*` | Local media file storage |
| `/var/opt/edge/trainer/*` | Edge trainer application data |
| `/var/spool/edge/*` | Edge spool directory |
| `/var/log/journal/*` | Systemd journal logs |
| `/var/log/**/*.gz` | Compressed rotated logs |
| `/var/log/**/*.1` | Rotated log backups |
| `/var/hasplm/*` | Sentinel HASP licensing data |
| `/etc/hasplm/*` | Sentinel HASP licensing config |
| `/var/opt/edge/*.iso` | ISO disk images |

You can add, remove, or comment any exclusion directly from the UI.

---


### 4.5 Reading the Archive tab

The four header cards each answer a different question, and they are deliberately not interchangeable:

| Card | What it means |
|------|---------------|
| **Stored on Disk** | Measured size of the Borg repository, plus free space on its filesystem. The real number. |
| **Source Data** | Logical bytes across every successful archive, before compression and deduplication. Cumulative over time. |
| **Cross-Node Saving** | What the shared repository saves compared with storing each node's base image separately. |
| **Success Rate** | Successful archives out of all archives. Turns red below 80%. |

**Why the saving is measured on base backups only.** A node that backs up weekly and barely changes writes gigabytes of source for a few hundred kilobytes of new data each run. Counting those runs would score "this node rarely changes" as deduplication and inflate the ratio several times over. Only the base backups say anything about storage: the first node pays for its whole image, every node after it pays only for what it does not share.

The base backup is identified by largest deduplicated contribution, not by being the oldest. Retention prunes old archives and the daily job deletes the matching history rows, so a node's earliest *surviving* row eventually becomes an incremental — and using it would send the ratio into the thousands.

**Fleet Insights** sits below, collapsed by default and fetched only when opened. Pick a 7, 30 or 90 day window, or type any value from 1 to 365. Panels cover reliability, throughput, duration against the group window, and capacity. A metric the system cannot compute honestly is shown as a dash with the reason, never as a zero.

### 4.6 Clearing failed backup records

Failed entries accumulate from controlled test runs and known outages, and they skew every reliability figure on the page.

- **One record** — the **Delete record** button on any failed row.
- **All failures on a node** — **Clear failures** in the node's header, shown only when the node has some.

Successful archives cannot be deleted here; they hold restorable data, and removing them belongs to retention or to **Purge Archives**. An unreachable repository does not block the deletion. Every removal is written to the audit log.

A checkpoint archive left by the failed run is **kept**, not deleted with the record: it holds the data already transferred, which is what lets the node's next attempt resume instead of starting over. It is cleared once a later backup of that node has succeeded.

### 4.7 Reading the Fleet list

The **Backup** button carries a mark when the node has an archive to restore from, and the **Last Backup** date is coloured to match, so a row reads the same way twice:

| Colour | Meaning |
|--------|---------|
| **Green** | Backed up, and the schedule is being kept |
| **Amber** | The last scheduled backup did not run |
| **Grey** | No schedule applies — the node is in no group, or is paused |
| **No mark** | Nothing to restore from yet |

A node that has never backed up *and* missed its window shows an amber **Never** — the case worth catching first.

While a backup runs, the button shows the speed borg is actually achieving, against the upload limit in force for that run (`42.3 / 50 Mbit/s`, or just the measured figure when uncapped). Hovering a hostname shows that node's notes; hostnames with a note are underlined.

**Web terminal.** Ctrl/⌘-click a node's `IP:PORT` cell to open an in-browser SSH terminal — no local ssh client or protocol handler needed. Full-screen programs (`htop`, `vim`, `top`) work normally. By default every admin gets ssh's own interactive password prompt inside the terminal, which the orchestrator never sees or stores, connecting as whatever login is saved on the node (the first connection asks for it and saves it; every connection after that reuses it without asking again). The superadmin always connects with the orchestrator's own key instead, with no prompt — and always as `root`, regardless of the node's saved login, since bootstrap only ever authorizes the orchestrator's key for that account. **Settings** → *Allow admins to use the orchestrator's key for the web terminal* extends that same key-based, no-prompt, always-root access to other admins (off by default, superadmin-only to change). A session idle for 15 minutes closes automatically; only its open/close is written to the audit log, never anything typed inside it.

## 5. Bare-Metal Restore (Flasher)

Restore a backup directly onto a physical disk connected to the orchestrator via USB.

### 5.1 Connect the disk

Use a **USB-to-SATA** or **USB-to-NVMe** adapter.

| Drive type | Hot-plug rules |
|-----------|----------------|
| **SATA** | USB-SATA adapters generally support hot-plug. Plug the USB into the server while it's running. |
| **NVMe** | Insert the M.2 drive into the adapter **first**, then connect USB to the server. Never remove the M.2 board while the adapter is plugged in. Always safe-eject before unplugging. |

### 5.2 Flash the disk

1. Go to the **Flasher** tab.
2. **Right side** — select the target disk. **Warning**: Since the orchestrator allows flashing drives directly from the server, all drives other than the server's own system (OS) partition will be visible in the dropdown list. Choose the target disk **EXTREMELY CAREFULLY**! Drives connected via USB will have a special badge/label indicating they are USB.
3. **Left side** — select the source node and the backup snapshot (archive) to restore.
4. Click **Start Flashing**. The log console shows every step:
   - Disk wiped (`wipefs`) and repartitioned as GPT
   - EFI partition formatted as `vfat` with the historically captured UUID
   - System partitions formatted as `ext4` (with `orphan_file` disabled for Debian 10 compat)
   - `borg extract` unpacks the archive onto the mounted disk
   - Chroot: `mount --bind` of `/dev`, `/proc`, `/sys` → GRUB reinstalled → `update-initramfs`
   - Network reset: persistent-net rules wiped, generic DHCP injected for `eth*`/`en*`
   - Sentinel LDK (HASP) reinstallation: By design, Sentinel licensing does not survive raw cloning of machine hardware/fingerprints. Therefore, the Sentinel HASP runtime is completely reinstalled/reactivated during the restore process.
   - Fallback EFI loader written to `EFI/BOOT/BOOTX64.EFI`
5. Wait for `Restore completed successfully!` — the disk is safely unmounted.
6. Disconnect the adapter, install the disk into the target node, power on. It boots with all data from the backup timestamp.

> 💡 **NVMe ↔ SATA migration**: because fstab uses `LABEL=edgeroot` (not `/dev/sdX`), you can restore an NVMe backup onto a SATA disk or vice versa. The UI shows a "drive type mismatch" warning — this is by design. Confirm and proceed.

---

## 6. Live-CD Kiosk (Office Technician Client & Network Restore)

The primary operating pattern of the system is a centralized backup server (in a server room or cloud) with technician PCs/laptops booting the Live-CD Kiosk. 

From this kiosk, you can connect to the server and flash target drives in two ways:
1. **Network Restore**: Connect over the LAN/VPN and write backups directly to target drives by pulling them from the server.
2. **Offline Local Restore**: Pre-synchronize required backup snapshots to the free space on the bootable USB flash drive itself beforehand, then boot the client in a fully offline environment with no network connection needed.

Additionally, booting the Live-USB directly on the target edge node itself is supported as a secondary, alternative pattern.

### 6.1 Kiosk ISO Preparation & Issuance

The base template caching and client ISO compilation is fully automated. You do not need to compile or repack files manually:

1. Go to the **Live-CD & Kiosks** tab.
2. Under the **Kiosk Control Panel** section on the right, click **Issue Live Kiosk**.
3. Enter the Friendly Name, contact details, and comment.
4. The system automatically creates a new kiosk registration and generates a custom ISO with a unique pairing token.
5. Click **Download** on the kiosk row to download the compiled ISO.
6. If the cache is pruned or configuration changes require a rebuild, click **Re-create** next to the kiosk row to repack the ISO.

#### The template ISO keeps itself current

Every kiosk ISO is packed on top of a shared template, shown on the left of
the tab as **USB-Kiosk Client**. The template contains the dashboard bundle,
the payload scripts and the borg binary, so an upgrade that changes any of
them leaves it out of date and the card is marked **OUTDATED**.

Nothing needs to be done about that. The orchestrator compares the template
against its sources every ten minutes and rebuilds it when they differ; the
card moves to **REBUILDING** and then back to **READY**, typically within a
couple of minutes. Approved kiosks are then flagged for repacking on top of
the new template.

Two behaviours worth knowing:

- A rebuild that fails is not retried on the next check. Retrying the same
  sources every ten minutes costs an ISO build each time and cannot succeed;
  the next change to the sources clears the block. The failure is recorded in
  the Logs tab as an `ISO_GEN` task.
- Issuing a kiosk while the template is rebuilding is fine — the new kiosk is
  packed once the template is ready.

### 6.2 Write the ISO to USB

Use one of these tools (in **DD mode**, not ISO mode):

| Tool | Platform | Notes |
|------|----------|-------|
| [**Rufus**](https://rufus.ie/) | Windows | Select **DD Image** mode when prompted. ISO/GPT mode won't boot correctly. |
| [**balenaEtcher**](https://etcher.balena.io/) | Windows / macOS / Linux | Always writes in DD mode. Just select the ISO and the USB drive. |
| `dd` | Linux | `sudo dd if=technician_client_v1.iso of=/dev/sdX bs=4M status=progress && sync` |

> ⚠️ **Why DD mode?** The ISO contains a hybrid bootable image with custom partitioning. Writing it as a regular ISO (e.g., via Rufus in ISO mode) will break the boot layout. Rufus will ask you — always pick DD.

**USB drive requirements**: Minimum 32 GB (preferably larger), write speed ≥ 15-20 MB/s. Recommended: Netac US5 level or higher.

### 6.3 Single Snapshot Sync

Instead of downloading the entire node's backup history (potentially hundreds of GB), you can sync just one specific snapshot:

1. In the **Live-CD & Kiosks** tab, select the target node and the desired snapshot.
2. Click **Sync Snapshot**.
3. The backend compiles a temporary mini-repository on the fly using `borg export-tar` | `borg import-tar` and streams it to the USB.
4. The UI shows real-time download speed, progress bar, and ETA.

### 6.4 Boot and restore

1. **Main Operating Pattern**: Insert the written USB drive into a technician's PC/laptop (e.g., in the office) and boot it.
2. **Alternative Pattern**: Alternatively, insert the USB into the target edge node itself and boot it.
3. If the client needs a VPN connection to reach the central orchestrator:
   - Place your WireGuard `.conf` configuration file directly at the root of the USB's persistence partition (mounts as `/media/usb-data/wg0.conf`), or configure it in the kiosk UI using the webcam QR scanner or textbox.
   - Any NetworkManager profile connections (`.nmconnection`) should be placed in the `/system-connections/` folder on the USB persistence partition (i.e. `/media/usb-data/system-connections/`).
   - The VPN profile persists on the USB and auto-connects on next boot.
4. The kiosk automatically connects to the central orchestrator and displays the Flasher interface.
5. **Under the Main Pattern**: Connect the target disk via a USB-to-SATA/NVMe adapter to the laptop. Select the adapter's drive as the target and choose the desired node and snapshot to write.
6. **Under the Alternative Pattern**: Select the node's internal disk as the target and choose the desired snapshot to write.

### 6.5 Kiosk Management

From the **Live-CD & Kiosks** tab → **Kiosk Control Panel** section, you can:

- **Issue personalized ISOs** — Click **Issue Live Kiosk**, fill in recipient details, and the system compiles a custom ISO with a unique pairing token.
- **Approve / Block / Re-activate / Delete** kiosk access.
- **Edit Kiosk Metadata** — Name, contact, and comments.
- **Re-create / Download** previously generated ISOs from the history list.
- **Cache Size Limit (`max_kiosk_isos`)**: Configured in Settings, this sets the maximum number of custom kiosk ISOs kept on the server's disk (default is 5). When a new kiosk ISO is generated that exceeds this limit, the oldest ISO file is automatically deleted from disk to save space. The kiosk record remains in the database, and its status in the dashboard changes to pruned (you can re-generate it at any time by clicking **Re-create**).

---

## 7. Sentinel LDK Licensing (HASP Keys)

For edge nodes running Sentinel HASP software licensing.

### 7.1 Status monitoring

During bootstrap, the orchestrator detects the Sentinel LDK runtime version. If present, a collapsible **Sentinel LDK License Info** card appears in the node details modal:
- **Active** (green) — license valid
- **Expired** (orange) — license expired
- **Clone Detected** (red) — hardware change detected
- **Disabled** (grey) — key or daemon offline

### 7.2 Download C2V fingerprint

1. Open node details in **Fleet** → expand the Sentinel card.
2. Click **Download C2V Fingerprint**.
3. The orchestrator runs `hasp_update lf` + `hasp_update i` on the node via SSH. Falls back to the local ACC API (`127.0.0.1:1947`) if CLI tools are missing.
4. The `.c2v` file downloads to your browser.

### 7.3 Apply V2C license update

1. Open node details → Sentinel card.
2. Drag-and-drop or select the `.V2C` file.
3. The orchestrator uploads it to the node and runs `hasp_update u <file>` via SSH.
4. The license status refreshes automatically.

---

## 8. User Management

Go to **Settings** → **Users**.

| Role | Permissions |
|------|------------|
| **Superadmin** | Full access. Can create/edit/delete other users. |
| **Admin** | Can operate the system (backup, restore, view logs) but cannot manage users. |

The first superadmin account is seeded from `.env` on first launch (see section 2.1).

To reset a lost password: update `ADMIN_PASSWORD` in `.env`, clear the `users` table in PostgreSQL, and restart the backend container.

---

## 9. Database Backup & Recovery

The orchestrator's PostgreSQL database holds all node configs, SSH keys, backup history, groups, and settings. Back it up.

### Automated daily dump (cron)

Create `/opt/backup_db.sh`:
```bash
#!/bin/bash
BACKUP_DIR="/var/backups/edge_bro_db"
mkdir -p "$BACKUP_DIR"
FILENAME="${BACKUP_DIR}/db_backup_$(date +%Y%m%d_%H%M%S).sql.gz"

docker compose -f /opt/stacks/edge-bro/docker-compose.yml \
  exec -T db pg_dump -U postgres borg_orchestrator | gzip > "$FILENAME"

# Keep 30 days of history
find "$BACKUP_DIR" -type f -name "db_backup_*.sql.gz" -mtime +30 -delete
```

Add to crontab (`crontab -e`):
```cron
15 3 * * * /bin/bash /opt/backup_db.sh > /dev/null 2>&1
```

### Recovery

```bash
gunzip -c db_backup_YYYYMMDD_HHMMSS.sql.gz > recovery.sql

docker compose exec -T db psql -U postgres -d postgres \
  -c "DROP DATABASE borg_orchestrator;"
docker compose exec -T db psql -U postgres -d postgres \
  -c "CREATE DATABASE borg_orchestrator;"
docker compose exec -T db psql -U postgres -d borg_orchestrator < recovery.sql
```

Restart the backend container after recovery to pick up the restored data.

---

## 10. Troubleshooting & Log Collection

When diagnosing orchestrator issues, you can download logs directly via the REST API or retrieve container logs from the server.

### 10.1 Diagnostic Endpoints (API)
These endpoints are secured and require the appropriate authentication session headers:

- **System Daemon Logs**: `/api/tasks/debug-logs` (requires Admin)
  - Returns the latest 500 system logs (FastAPI, Celery workers, and scheduler execution logs).
- **Administrative Audit Logs**: `/api/users/audit-logs` (requires Superadmin or Admin)
  - Returns the latest 1000 user activity logs (logins, settings changes, user actions).
- **Task Console Logs**: `/api/tasks/{task_id}` (requires Kiosk or Admin)
  - Returns the full execution console/Ansible playbook output of a specific background task.

### 10.2 Server Container Logs
For low-level Docker issues or standard output logs of all services (Nginx, FastAPI, Borg SSH Server, Postgres, Redis, Workers, Beat), run the following command on the orchestrator server:

```bash
docker compose logs --tail=2000 > edge_bro_logs.txt
```
Attach `edge_bro_logs.txt` to the support ticket.

### 10.3 `external volume "..." not found` on startup

Older revisions of `docker-compose.yml` declared every named volume as `external: true`, which tells Compose the volumes already exist and must never be created. On a fresh install nothing has created them yet, so `docker compose up` aborts with:

```
external volume "backup-edge-restore_apt-cache" not found
```

This is fixed in current revisions — the volumes are declared `external: false` and Compose creates them on first run. Pull the latest code and start normally:

```bash
git pull
docker compose up -d --build
```

If you already worked around it by hand, note that volumes are now named `edge-bro_*`. Data written under the old `backup-edge-restore_*` names is not picked up automatically — list what exists with `docker volume ls`, and copy anything worth keeping:

```bash
docker run --rm -v backup-edge-restore_pg-data:/from -v edge-bro_pg-data:/to alpine cp -a /from/. /to/
```

### 10.4 Containers are healthy but nothing answers on its port

Symptom: `docker compose ps` shows every service up and healthy, `docker exec`
into any container works, the containers reach each other — and yet the
dashboard on 7777, the API on 8000 and the borg endpoint on 12345 all refuse to
answer, or accept a connection and immediately drop it. Nodes fail their
backups; the orchestrator's own logs show nothing wrong, because nothing is.

The cause is a routing clash. The host already routes the range Docker put the
stack's network on — a VPN, a site-to-site tunnel, another Docker network — and
the more specific route wins, so traffic the host sends to a container leaves
through the tunnel instead of the bridge.

Check what the host routes against what the stack uses:

```bash
ip route
docker network inspect edge-bro_default -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

If they overlap, pick a range nothing else claims and set it in `.env`:

```env
DOCKER_SUBNET=10.83.44.0/24
```

The network is created at startup and cannot be re-addressed in place, so the
stack has to be stopped for the change to apply:

```bash
docker compose down
docker compose up -d
```

Current revisions state the subnet rather than leaving it to Docker's pool, so
a fresh install lands on `172.29.13.0/24` unless you override it. Deployments
created before that may still be on whatever was auto-assigned; the same
`down` / `up` moves them onto the stated range.

## 11. Fleet Health Monitoring (SMART & Thermal)

Passive drive-health scoring and CPU thermal-interface tracking, shown as
badges on the DISK DRIVE and CPU cards of each node.

### 11.1 Enabling collection on a node

The collector installs itself automatically as the last step of every
successful **Bootstrap** — both the first provision and any later
re-provision. Nothing to trigger by hand for a node that goes through
Bootstrap normally. A failed install is logged as a warning on the bootstrap
task but does not fail the bootstrap itself — a node that already backs up
correctly is not marked broken over telemetry.

Installation runs `backend/playbooks/deploy_monitoring.yml`, which puts a
POSIX-sh collector and a systemd timer (`edge-bro-collect.timer`, every 60 s)
on the node, sampling temperatures, RAPL energy counters and disk I/O from
sysfs only — no `smartctl` spin-up, idle I/O priority, nothing listens on the
network. Samples buffer to `/var/log/edge/edge-bro/telemetry.jsonl` (capped at
16 MB, already excluded from backups) until the orchestrator pulls them over
the existing SSH channel. The task log reports, per node, whether RAPL,
`drivetemp` and `smartctl` are actually available — a node without RAPL still
gets SMART scoring but no thermal reading.

To (re)install the collector on a node **without** running a full Bootstrap
— e.g. a node that was provisioned before monitoring existed — run the same
playbook directly:

```bash
docker compose exec worker ansible-playbook playbooks/deploy_monitoring.yml \
  -i "<node_ip>, ansible_user=root, ansible_ssh_private_key_file=/root/.ssh/id_ed25519"
```

### 11.2 Reading the badges

- **SMART badge** — a 0–100 score shaded green to red. Click it for the full
  latest reading (per-attribute sub-scores, wear/endurance projection with its
  derivation, access latency) and a history graph with selectable metrics.
- **CPU badge** — thermal interface status: `OK` / `WATCH` / `ALERT` /
  `INSUFFICIENT_DATA`. Shows the estimated thermal resistance (θ, °C/W) rather
  than a percentage — a thermal interface is judged as like its peers or not,
  not scored on an invented scale. `INSUFFICIENT_DATA` is the honest state
  when there is not yet enough backup-load history to fit a value, and the
  tooltip says why (no fit yet vs. windows rejected for insufficient load).
- A node is judged two ways: against **peers on the same CPU model**
  (a lone outlier in its cohort) and against **its own history**
  (drift from its own baseline). Either can independently flag ALERT/WATCH.

### 11.3 Thresholds

`Settings` carries global defaults for SMART temperature warning/critical and
the monitoring interval; each is overridable per node the same way the backup
rate limit is, for units that legitimately run hotter (e.g. full sun).
Monitoring can be disabled per node, e.g. during maintenance.

### 11.4 Nodes provisioned before monitoring existed

Bootstrap-time installation only fires on a Bootstrap run. A node that was
already `READY` before the collector shipped will not pick it up on its own —
re-run Bootstrap on it, or apply the playbook directly as shown in §11.1.

