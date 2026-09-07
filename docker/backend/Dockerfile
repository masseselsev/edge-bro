FROM python:3.13-slim
RUN apt-get update && apt-get install -y \
    ssh openssh-client sshpass rsync curl parted util-linux fdisk dosfstools e2fsprogs systemd iproute2 iputils-ping borgbackup udev \
    xorriso squashfs-tools syslinux syslinux-common isolinux cpio \
    gcc libpq-dev \
    && mkdir -p /opt/offline-packages \
    && cd /opt/offline-packages \
    && apt-get download openssh-server openssh-client openssh-sftp-server runit-helper libwtmpdb0 wireguard-tools openresolv borgbackup \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The lock, not requirements.txt: the latter carries floors and reasoning for
# humans, while this installs an exact, fully transitive set so that two builds
# of the same commit are the same image. Without it, every rebuild resolved
# whatever was newest that day and the deployed versions drifted away from the
# ones the test suite had ever run against.
COPY backend/requirements.txt backend/requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY backend .
COPY payload_client /payload_client
