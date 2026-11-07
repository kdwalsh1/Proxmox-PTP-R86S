#!/usr/bin/env bash
#
# One-shot setup for a Pi5 + GPS PTP grandmaster/boundary-clock device.
#
# Run this as root on a Raspberry Pi 5 running Raspberry Pi OS (Bookworm,
# 64-bit), with this repo checked out locally and a GNSS module (e.g.
# Waveshare LC76G) wired to a UART + a GPIO pin for PPS - see
# docs/pi5-gps-grandmaster.md for wiring. (Prefer `pi5-gm/install.sh` if
# you don't have the repo checked out yet - it bootstraps a clone and then
# runs this script.)
#
# Deploys the exact same ptp-agent.py + webui/ dashboard used on the R86S
# (host/, webui/) directly on the Pi5 (no LXC - this box has no Proxmox
# layer), plus gpsd/chrony/linuxptp so a profile's clock source can be set
# to "Local GPS + PPS" from the dashboard to make this device a grandmaster
# for that domain (or "Uplink interface" for ordinary boundary-clock
# behavior, same as the R86S).
#
# Usage: ./setup.sh
#
# Safe to re-run: re-running redeploys config/units and restarts services;
# the admin password and agent token are preserved.
#
# A reboot is required the first time for the pps-gpio overlay to take
# effect.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root on the Pi5." >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Defaults (override via environment variables)
# ---------------------------------------------------------------------------
PPS_GPIO="${PPS_GPIO:-18}"
UART_OVERLAY="${UART_OVERLAY:-uart0-pi5}"
UART_DEV="${UART_DEV:-/dev/ttyAMA0}"
CONFIG_TXT="${CONFIG_TXT:-/boot/firmware/config.txt}"
AGENT_PORT="${AGENT_PORT:-8081}"

render() {
    sed -e "s|\${UART_DEV}|${UART_DEV}|g" "$1"
}

echo "============================================================"
echo " pi5-gm setup"
echo "============================================================"
echo

# ---------------------------------------------------------------------------
# 1. GPS packages
# ---------------------------------------------------------------------------
echo "--> Installing gpsd, chrony and pps-tools"
apt-get update -qq
apt-get install -y gpsd gpsd-clients chrony pps-tools >/dev/null

# ModemManager probes serial/USB devices on boot and can grab the GNSS
# UART before gpsd does, breaking the fix. Not needed on a headless Pi.
if systemctl list-unit-files ModemManager.service >/dev/null 2>&1; then
    echo "--> Disabling ModemManager (would otherwise contend for ${UART_DEV})"
    systemctl disable --now ModemManager >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# 2. UART + PPS overlay
# ---------------------------------------------------------------------------
# Uses a secondary UART (default uart3-pi5, GPIO4/GPIO5) rather than the
# primary UART0 on GPIO14/15, which on Pi5 defaults to the serial console
# and is muxed with Bluetooth - avoiding both headaches entirely. PPS
# stays on GPIO18: there's no Pi5-specific "low latency" pin - all GPIO
# is uniform through the RP1 chip, GPIO18 is just the common convention.
echo "--> Enabling ${UART_OVERLAY} and pps-gpio overlay (GPIO ${PPS_GPIO}) in ${CONFIG_TXT}"
NEEDS_REBOOT=0
if [ ! -f "$CONFIG_TXT" ]; then
    echo "${CONFIG_TXT} not found - is this a Raspberry Pi OS Bookworm image?" >&2
    exit 1
fi
if ! grep -q "^# --- pi5-gm begin ---$" "$CONFIG_TXT" || \
   ! grep -q "^dtoverlay=${UART_OVERLAY}$" "$CONFIG_TXT" || \
   ! grep -q "dtoverlay=pps-gpio,gpiopin=${PPS_GPIO}$" "$CONFIG_TXT"; then
    sed -i '/^# --- pi5-gm begin ---$/,/^# --- pi5-gm end ---$/d' "$CONFIG_TXT"
    cat >> "$CONFIG_TXT" <<EOF

# --- pi5-gm begin ---
dtoverlay=${UART_OVERLAY}
dtoverlay=pps-gpio,gpiopin=${PPS_GPIO}
# --- pi5-gm end ---
EOF
    NEEDS_REBOOT=1
fi

# ---------------------------------------------------------------------------
# 3. gpsd + chrony (GPS+PPS -> CLOCK_REALTIME)
# ---------------------------------------------------------------------------
echo "--> Configuring gpsd (device ${UART_DEV})"
render "$REPO_DIR/pi5-gm/gpsd.default" > /etc/default/gpsd

echo "--> Configuring chrony GNSS refclocks"
mkdir -p /etc/chrony/conf.d
install -m 644 "$REPO_DIR/pi5-gm/chrony-gnss.conf" /etc/chrony/conf.d/gnss.conf

systemctl daemon-reload
systemctl enable --now gpsd >/dev/null
systemctl restart gpsd
systemctl enable --now chrony >/dev/null
systemctl restart chrony

# ---------------------------------------------------------------------------
# 4. ptp-agent (same code as the R86S host - see scripts/install-ptp-agent.sh)
# ---------------------------------------------------------------------------
echo "--> Installing ptp-agent"
source "$REPO_DIR/scripts/install-ptp-agent.sh"

# ---------------------------------------------------------------------------
# 5. webui (same PHP dashboard as the R86S, deployed locally - no LXC here)
# ---------------------------------------------------------------------------
echo "--> Installing Apache + PHP"
apt-get install -y apache2 libapache2-mod-php php-cli >/dev/null

echo "--> Deploying web UI"
mkdir -p /var/www/ptp-webui
tar czf - -C "$REPO_DIR/webui" --exclude='.env' . | tar xzf - -C /var/www/ptp-webui
chown -R www-data:www-data /var/www/ptp-webui

cat > /etc/apache2/sites-available/ptp-webui.conf <<'EOF'
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
a2dissite 000-default >/dev/null 2>&1 || true
a2ensite ptp-webui >/dev/null
systemctl reload apache2

if [ ! -f /var/www/ptp-webui/.env ]; then
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

    PASS_HASH="$(php -r 'echo password_hash($argv[1], PASSWORD_DEFAULT);' -- "$ADMIN_PASS")"
    AGENT_TOKEN="$(cat /etc/ptp-webui/agent.token)"

    cat > /var/www/ptp-webui/.env <<EOF
AGENT_URL=http://127.0.0.1:${AGENT_PORT}
AGENT_TOKEN=${AGENT_TOKEN}
ADMIN_PASSWORD_HASH=${PASS_HASH}
EOF
    chown www-data:www-data /var/www/ptp-webui/.env
    chmod 640 /var/www/ptp-webui/.env
else
    echo "--> Existing .env found, leaving admin password/token unchanged"
fi

PI_IP="$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -n1)"

echo
echo "============================================================"
echo " Setup complete"
echo "============================================================"
if [ "$NEEDS_REBOOT" -eq 1 ]; then
    echo "!! ${CONFIG_TXT} changed - reboot now for the pps-gpio overlay to"
    echo "   take effect (/dev/pps0 won't exist, and chrony's PPS refclock"
    echo "   will stay unreachable, until then)."
    echo
fi
echo "Dashboard: http://${PI_IP:-<pi5-ip>}/"
echo
echo "No profile is a grandmaster yet. In the dashboard, create (or edit) a"
echo "PTP profile and set its clock source to 'Local GPS + PPS' - see"
echo "docs/pi5-gps-grandmaster.md for verification steps (GPS fix, PPS lock,"
echo "the GPS panel/map) and how to wire the R86S's uplink to this device."
