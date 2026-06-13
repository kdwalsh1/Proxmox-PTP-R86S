#!/usr/bin/env bash
#
# One-shot setup for ProxmoxPTP-R86S.
#
# Run this as root on the Proxmox host, with this repo checked out locally.
# It will:
#   1. Install linuxptp + ethtool on the host, deploy ptp-agent (a small
#      Python daemon that applies PTP config, polls ptp4l status via pmc,
#      and serves a token-authenticated HTTP API).
#   2. Create a new unprivileged Debian 12 LXC (DHCP on vmbr0) running the
#      PHP web UI, which talks to the host agent over the bridge.
#
# Usage: ./setup.sh
#
# Safe to re-run: existing config/tokens/passwords are preserved, the
# container and webui files are redeployed in place.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root on the Proxmox host." >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# ---------------------------------------------------------------------------
# Defaults (override via environment variables)
# ---------------------------------------------------------------------------
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
LXC_HOSTNAME="${LXC_HOSTNAME:-ptp-webui}"
CORES="${CORES:-1}"
MEMORY="${MEMORY:-512}"
DISK_SIZE="${DISK_SIZE:-4}"
AGENT_PORT="${AGENT_PORT:-8081}"

echo "============================================================"
echo " ProxmoxPTP-R86S setup"
echo "============================================================"
echo

# ---------------------------------------------------------------------------
# 1. Host: linuxptp + ptp-agent
# ---------------------------------------------------------------------------
echo "--> Installing linuxptp and ethtool on the host"
apt-get update -qq
apt-get install -y linuxptp ethtool >/dev/null

echo "--> Setting up /etc/ptp-webui, /var/lib/ptp-webui, /opt/ptp-webui"
mkdir -p /etc/ptp-webui /var/lib/ptp-webui /opt/ptp-webui

if [ ! -f /etc/ptp-webui/desired.json ]; then
    cat > /etc/ptp-webui/desired.json <<'EOF'
{
  "domainNumber": 0,
  "priority1": 128,
  "priority2": 128,
  "logAnnounceInterval": 1,
  "logSyncInterval": 0,
  "logMinDelayReqInterval": 0,
  "interfaces": {}
}
EOF
    echo "    Seeded desired.json with no interfaces enabled (safe default)."
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
# ptp4l via systemctl, so provide one driven entirely by its generated config.
install -m 644 "$REPO_DIR/host/ptp4l.service" /etc/systemd/system/ptp4l.service
rm -rf /etc/systemd/system/ptp4l.service.d

systemctl daemon-reload
systemctl enable --now ptp-agent >/dev/null
systemctl restart ptp-agent

# ---------------------------------------------------------------------------
# 2. LXC: ptp-webui
# ---------------------------------------------------------------------------
echo "--> Looking for an existing '${LXC_HOSTNAME}' container"
VMID="$(pct list | awk -v n="$LXC_HOSTNAME" '$NF == n {print $1; exit}')"

if [ -z "$VMID" ]; then
    echo "--> Creating new container '${LXC_HOSTNAME}'"

    if ! pveam list local 2>/dev/null | grep -q debian-12-standard; then
        echo "    Downloading Debian 12 LXC template"
        pveam update >/dev/null
        TEMPLATE="$(pveam available 2>/dev/null | awk '/debian-12-standard/ {print $2}' | sort -V | tail -n1)"
        pveam download local "$TEMPLATE" >/dev/null
    fi
    TEMPLATE_VOLID="$(pveam list local | awk '/debian-12-standard/ {print $1}' | sort -V | tail -n1)"

    VMID="$(pvesh get /cluster/nextid)"
    pct create "$VMID" "$TEMPLATE_VOLID" \
        --hostname "$LXC_HOSTNAME" \
        --cores "$CORES" \
        --memory "$MEMORY" \
        --rootfs "${STORAGE}:${DISK_SIZE}" \
        --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp,type=veth" \
        --unprivileged 1 \
        --features nesting=0 \
        --onboot 1 >/dev/null
    pct start "$VMID" >/dev/null
else
    echo "    Found existing container VMID $VMID"
    pct status "$VMID" | grep -q running || pct start "$VMID" >/dev/null
fi

echo "--> Waiting for ${LXC_HOSTNAME} (VMID $VMID) to get an IP address"
LXC_IP=""
for _ in $(seq 1 30); do
    LXC_IP="$(pct exec "$VMID" -- sh -c "ip -4 -o addr show eth0 2>/dev/null | awk '{print \$4}' | cut -d/ -f1" || true)"
    [ -n "$LXC_IP" ] && break
    sleep 2
done
if [ -z "$LXC_IP" ]; then
    echo "Container did not get an IPv4 address within 60s." >&2
    exit 1
fi
echo "    Container IP: $LXC_IP"

echo "--> Installing Apache + PHP in the container"
pct exec "$VMID" -- bash -c "apt-get update -qq && apt-get install -y apache2 libapache2-mod-php php-cli >/dev/null"

echo "--> Deploying web UI"
pct exec "$VMID" -- mkdir -p /var/www/ptp-webui
tar czf - -C "$REPO_DIR/webui" --exclude='.env' . | pct exec "$VMID" -- tar xzf - -C /var/www/ptp-webui
pct exec "$VMID" -- chown -R www-data:www-data /var/www/ptp-webui

cat > "$WORKDIR/ptp-webui.conf" <<'EOF'
<VirtualHost *:80>
    DocumentRoot /var/www/ptp-webui/public
    <Directory /var/www/ptp-webui/public>
        AllowOverride All
        Require all granted
    </Directory>
    ErrorLog ${APACHE_LOG_DIR}/ptp-webui-error.log
    CustomLog ${APACHE_LOG_DIR}/ptp-webui-access.log combined
</VirtualHost>
EOF
pct push "$VMID" "$WORKDIR/ptp-webui.conf" /etc/apache2/sites-available/ptp-webui.conf
pct exec "$VMID" -- a2dissite 000-default >/dev/null 2>&1 || true
pct exec "$VMID" -- a2ensite ptp-webui >/dev/null
pct exec "$VMID" -- systemctl reload apache2

BRIDGE_IP="$(ip -4 -o addr show "$BRIDGE" | awk '{print $4}' | cut -d/ -f1 | head -n1)"

ENV_EXISTS="$(pct exec "$VMID" -- sh -c '[ -f /var/www/ptp-webui/.env ] && echo yes || echo no')"
if [ "$ENV_EXISTS" = "no" ]; then
    echo
    echo "Set the admin password for the PTP web UI."
    while true; do
        read -rsp "Admin password: " ADMIN_PASS; echo
        read -rsp "Confirm password: " ADMIN_PASS2; echo
        if [ -z "$ADMIN_PASS" ]; then
            echo "  Password cannot be empty." >&2
        elif [ "$ADMIN_PASS" != "$ADMIN_PASS2" ]; then
            echo "  Passwords did not match." >&2
        else
            break
        fi
    done

    PASS_HASH="$(pct exec "$VMID" -- php -r 'echo password_hash($argv[1], PASSWORD_DEFAULT);' -- "$ADMIN_PASS")"
    AGENT_TOKEN="$(cat /etc/ptp-webui/agent.token)"

    cat > "$WORKDIR/.env" <<EOF
AGENT_URL=http://${BRIDGE_IP}:${AGENT_PORT}
AGENT_TOKEN=${AGENT_TOKEN}
ADMIN_PASSWORD_HASH=${PASS_HASH}
EOF
    pct push "$VMID" "$WORKDIR/.env" /var/www/ptp-webui/.env
    pct exec "$VMID" -- chown www-data:www-data /var/www/ptp-webui/.env
    pct exec "$VMID" -- chmod 640 /var/www/ptp-webui/.env
else
    echo "--> Existing .env found in container, leaving admin password/token unchanged"
fi

echo
echo "============================================================"
echo " Setup complete"
echo "============================================================"
echo "Web UI:    http://${LXC_IP}/"
echo "Agent API: http://${BRIDGE_IP}:${AGENT_PORT}/api/status"
echo "           (Authorization: Bearer \$(cat /etc/ptp-webui/agent.token))"
echo "Container: VMID $VMID ($LXC_HOSTNAME)"
echo
echo "No interfaces are enabled for PTP yet - log in and configure them from"
echo "the dashboard."
