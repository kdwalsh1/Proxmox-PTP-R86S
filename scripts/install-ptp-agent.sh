#!/usr/bin/env bash
#
# Shared "install the host PTP agent" logic, sourced by both the top-level
# setup.sh (Proxmox host) and pi5-gm/setup.sh (Raspberry Pi 5) - both boxes
# run ptp-agent.py directly as root, identically, so this is real shared
# code rather than a parameterized abstraction over two different targets.
#
# Contract: the caller must `set -euo pipefail`, run as root, and have
# REPO_DIR set to the repo root (the directory containing host/) before
# sourcing this file.

echo "--> Installing linuxptp and ethtool"
apt-get update -qq
apt-get install -y linuxptp ethtool >/dev/null

echo "--> Setting up /etc/ptp-webui, /var/lib/ptp-webui, /opt/ptp-webui"
mkdir -p /etc/ptp-webui /var/lib/ptp-webui /opt/ptp-webui

if [ ! -f /etc/ptp-webui/desired.json ]; then
    cat > /etc/ptp-webui/desired.json <<'EOF'
{
  "vlans": {},
  "profiles": {}
}
EOF
    echo "    Seeded desired.json with no VLANs or profiles (safe default)."
fi

if [ ! -f /etc/ptp-webui/agent.token ]; then
    umask 077
    openssl rand -hex 32 > /etc/ptp-webui/agent.token
    umask 022
    echo "    Generated a new agent API token."
fi

echo "--> Deploying ptp-agent"
install -m 755 "$REPO_DIR/host/ptp-agent.py" /opt/ptp-webui/ptp-agent.py
install -m 644 "$REPO_DIR/host/ptp4l.conf.template" /opt/ptp-webui/ptp4l.conf.template
install -m 644 "$REPO_DIR/host/ptp-agent.service" /etc/systemd/system/ptp-agent.service

# The linuxptp package does not ship a ptp4l.service unit; ptp-agent manages
# one ptp4l instance per PTP profile via systemctl, so provide a templated
# unit (ptp4l@<profile>.service) driven by the agent's generated configs.
install -m 644 "$REPO_DIR/host/ptp4l@.service" "/etc/systemd/system/ptp4l@.service"
rm -rf /etc/systemd/system/ptp4l.service.d

# Migration: earlier versions used a single static ptp4l.service unit.
if [ -f /etc/systemd/system/ptp4l.service ]; then
    echo "    Removing legacy single-instance ptp4l.service"
    systemctl disable --now ptp4l.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/ptp4l.service /etc/linuxptp/ptp4l.conf
fi

# VLAN sub-interfaces (802.1q) need the 8021q module at boot.
modprobe 8021q || true
grep -qx 8021q /etc/modules || echo 8021q >> /etc/modules

systemctl daemon-reload
systemctl enable --now ptp-agent >/dev/null
systemctl restart ptp-agent
