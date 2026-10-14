#!/bin/bash
# Installs the bundle unpacked at /opt/nadcab/l2 as a systemd service that brings the L2 up and resumes it after reboots.
set -euo pipefail

cat > /etc/systemd/system/nadcab-l2.service <<'UNIT'
[Unit]
Description=Nadcab OP Stack L2 bring-up
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash /opt/nadcab/l2/host/l2-up.sh
Restart=on-failure
RestartSec=60
TimeoutStartSec=infinity

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable nadcab-l2.service
systemctl start --no-block nadcab-l2.service
