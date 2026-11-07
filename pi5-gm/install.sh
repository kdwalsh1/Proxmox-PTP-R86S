#!/usr/bin/env bash
#
# Single-file installer for the Pi5 + GPS PTP grandmaster/boundary-clock
# device. Meant to be fetched and run standalone, no prior `git clone`
# needed:
#
#   wget -O install.sh https://raw.githubusercontent.com/kdwalsh1/Proxmox-PTP-R86S/main/pi5-gm/install.sh
#   sudo bash install.sh
#
# If this repo is already checked out locally, running
# `sudo ./pi5-gm/install.sh` from inside it works too - it detects that
# and just runs setup.sh in place, no cloning.
#
# Either way, all real provisioning logic lives in pi5-gm/setup.sh; this
# script's only job is making sure that file (and the rest of the repo it
# needs - host/, webui/, scripts/) exists on disk before running it.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root on the Pi5." >&2
    exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/kdwalsh1/Proxmox-PTP-R86S.git}"
CLONE_DIR="${CLONE_DIR:-/opt/proxmox-ptp-r86s-src}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SELF_DIR/setup.sh" ] && [ -d "$SELF_DIR/../host" ] && [ -d "$SELF_DIR/../webui" ]; then
    # Running from inside a real checkout (e.g. `./pi5-gm/install.sh` after
    # `git clone`) - nothing to fetch, just hand off to setup.sh.
    exec "$SELF_DIR/setup.sh" "$@"
fi

echo "--> Fetching Proxmox-PTP-R86S into ${CLONE_DIR}"
if ! command -v git >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y git >/dev/null
fi

if [ -d "$CLONE_DIR/.git" ]; then
    git -C "$CLONE_DIR" pull --ff-only
else
    rm -rf "$CLONE_DIR"
    git clone "$REPO_URL" "$CLONE_DIR"
fi

exec "$CLONE_DIR/pi5-gm/setup.sh" "$@"
