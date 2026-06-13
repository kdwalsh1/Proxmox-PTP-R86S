# Setup

## Architecture

```
┌─────────────────────────────────────────┐        ┌───────────────────────────┐
│ Proxmox host                             │        │ LXC "ptp-webui"           │
│                                           │        │ (unprivileged, Debian 12) │
│  ptp4l  ──(reads)── /etc/linuxptp/        │        │                           │
│   │                  ptp4l.conf           │        │  Apache + PHP             │
│   │  (pmc, ethtool)                       │        │  - login.php              │
│   ▼                                       │        │  - index.php (dashboard)  │
│  ptp-agent.py (systemd, :8081) ◄──────────┼── HTTP ┼─ ajax.php (Bearer token)  │
│   - discovers NICs + PHCs via ethtool     │  bridge│                           │
│   - renders ptp4l.conf, restarts ptp4l    │   IP   │                           │
│   - polls pmc for GM/offset/port state    │        │                           │
│   - writes status.json + history.db       │        │                           │
│   - manages phc2sys                       │        │                           │
└─────────────────────────────────────────┘        └───────────────────────────┘
```

- `ptp4l`, `phc2sys`, `pmc` and `ethtool` all run **on the Proxmox host**,
  because raw access to the NICs' PTP hardware clocks (PHCs) is required.
- `ptp-agent.py` is a small Python 3 stdlib daemon (no extra dependencies)
  that owns the PTP configuration, applies it, and exposes a
  token-authenticated HTTP API on port `8081` (bound to all interfaces,
  reachable from the LXC over the Proxmox bridge).
- The web UI lives in its own unprivileged LXC and never touches the host
  filesystem directly - it only talks to the agent's HTTP API. This avoids
  any LXC bind-mount / UID-mapping permission issues.

## Prerequisites

- A Proxmox VE host with at least one `local-lvm`-style storage for the LXC
  rootfs, and a bridge (default `vmbr0`) with DHCP available for the
  container.
- Outbound internet access on the host the first time it runs, to install
  packages and download the Debian 12 LXC template.

## Running setup.sh

```bash
git clone https://github.com/kdwalsh1/Proxmox-PTP-R86S.git
cd Proxmox-PTP-R86S
./setup.sh
```

Run as root on the Proxmox host. The script:

1. Installs `linuxptp` and `ethtool` on the host.
2. Deploys `host/ptp-agent.py` as a systemd service (`ptp-agent`), generates
   an API token (`/etc/ptp-webui/agent.token`), and seeds
   `/etc/ptp-webui/desired.json` with **no interfaces enabled** - PTP stays
   off until you configure it from the dashboard.
3. Adds a systemd override so the stock `ptp4l.service` is driven entirely
   by the agent-generated `/etc/linuxptp/ptp4l.conf` (the distro unit
   normally hardcodes `-i eth0`).
4. Creates a new unprivileged Debian 12 LXC (`ptp-webui`, DHCP on `vmbr0`),
   installs Apache + PHP, and deploys `webui/` to
   `/var/www/ptp-webui/public`.
5. Prompts for an admin password (first run only) and writes
   `/var/www/ptp-webui/.env` inside the container with the agent's URL and
   token.

It's safe to re-run: existing tokens, `desired.json`, the container, and the
admin password are all preserved. Re-running redeploys `host/` and `webui/`
files and restarts the agent and Apache.

Override defaults via environment variables, e.g.:

```bash
STORAGE=local-zfs BRIDGE=vmbr1 ./setup.sh
```

## Using the dashboard

Open `http://<container-ip>/` (printed at the end of `setup.sh`) and log in
with the admin password you set.

### Interfaces

Every physical NIC on the host is auto-discovered (`vmbr*`, `veth*`, `tap*`
and other virtual interfaces are excluded). Each card shows:

- link state, speed, and driver
- its **hardware PTP clock (PHC)** group, if any - ports that share the same
  underlying PHC (e.g. both SFP+ ports on a multi-port NIC) are labelled
  with the same letter (A, B, ...). Ports with no PHC fall back to software
  timestamping.
- a checkbox to enable/disable `ptp4l` on that port
- a role: **Uplink** (listen for an external grandmaster - this is the only
  port that can become SLAVE) or **Downstream** (always advertises this box
  as master, terminating the PTP domain for devices on that segment). Only
  one port can be the uplink at a time; selecting a new uplink automatically
  demotes the previous one to downstream.

### Global PTP settings

Domain number, `priority1`/`priority2` (lower wins BMCA elections - lower
this device's `priority1` if you want it preferred as grandmaster), and the
announce/sync/min-delay-request intervals (log2 seconds).

### Status banner

- **"This device is the Grandmaster"** - `stepsRemoved == 0`, i.e. nothing
  better was heard on the uplink (or no uplink is configured).
- **"Synced to grandmaster ..."** - shows hop count and current offset in
  nanoseconds.
- **"No grandmaster present"** - the uplink port hasn't heard an announce
  message yet.
- A red error banner appears if `ptp4l` failed to start with the current
  configuration, including the relevant `journalctl` output.

### Offset graph

Plots offset-from-grandmaster (nanoseconds) over the last hour, sampled
every ~3 seconds and retained for 48 hours in
`/var/lib/ptp-webui/history.db` on the host.

## Boundary clock model

When at least one interface is enabled, the agent renders
`/etc/linuxptp/ptp4l.conf` with one `[<interface>]` section per enabled
port:

- **Uplink** port: no `masterOnly` override (defaults to `0`), so BMCA can
  let it run as SLAVE to a better clock, or as MASTER/GM if nothing better
  is heard.
- **Downstream** ports: `masterOnly 1`, so they never become SLAVE and
  always advertise this device as master - this is what "terminates" the
  domain for downstream devices rather than transparently relaying it.
- `time_stamping` is set per-port to `hardware` or `software` depending on
  whether `ethtool -T <iface>` reports a PHC for that interface.
- `boundary_clock_jbod 1` is set automatically whenever the *enabled*
  interfaces span more than one distinct PHC (e.g. an onboard i225/i226 port
  plus a discrete NIC) - required because the boundary clock can't assume a
  single shared hardware clock across all its ports. If every enabled port
  shares one PHC, this is omitted.

When the uplink port is SLAVE, the agent also runs `phc2sys` to step the
host's system clock (`CLOCK_REALTIME`) from that port's PHC. If this device
is itself the grandmaster (or has no uplink configured), `phc2sys` is
stopped.

## Networking caveat

PTP relies on hardware timestamps and (for the `E2E` delay mechanism used
here) regular UDP traffic on the wire. Ports that are enslaved to a Proxmox
Linux bridge (`vmbr*`) and shared with VM/container traffic can still work,
but for the best accuracy and to avoid surprises from bridge STP/filtering,
prefer dedicating physical ports that are **not** members of a `vmbr*`
bridge to PTP where possible.

## Troubleshooting

Check the agent and ptp4l services on the host:

```bash
systemctl status ptp-agent
systemctl status ptp4l
journalctl -u ptp4l -n 50
```

Query the agent API directly:

```bash
curl -s -H "Authorization: Bearer $(cat /etc/ptp-webui/agent.token)" \
  http://localhost:8081/api/status | python3 -m json.tool
```

Query `ptp4l` directly with `pmc`:

```bash
pmc -u -b 0 'GET DEFAULT_DATA_SET'
pmc -u -b 0 'GET CURRENT_DATA_SET'
pmc -u -b 0 'GET TIME_STATUS_NP'
pmc -u -b 0 'GET PORT_DATA_SET'
```

`CURRENT_DATA_SET.stepsRemoved == 0` means this device is currently the
grandmaster.

## Resetting the admin password

The admin password hash lives in `/var/www/ptp-webui/.env` inside the
`ptp-webui` container. To reset it:

```bash
NEWHASH=$(pct exec <vmid> -- php -r 'echo password_hash($argv[1], PASSWORD_DEFAULT);' -- 'new-password')
pct exec <vmid> -- sed -i "s#^ADMIN_PASSWORD_HASH=.*#ADMIN_PASSWORD_HASH=${NEWHASH}#" /var/www/ptp-webui/.env
```

(Find `<vmid>` with `pct list`.)
