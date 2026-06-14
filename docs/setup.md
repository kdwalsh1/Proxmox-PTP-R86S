# Setup

## Architecture

```
┌──────────────────────────────────────────────┐   ┌───────────────────────────┐
│ Proxmox host                                  │   │ LXC "ptp-webui"           │
│                                                │   │ (unprivileged, Debian 12) │
│  ptp4l@wan      ──(reads)── /etc/linuxptp/    │   │                           │
│  ptp4l@lan-ptp   (reads)─    ptp4l-<name>.conf│   │  Apache + PHP             │
│   │  (pmc -s /var/run/ptp4l-<name>, ethtool)  │   │  - login.php              │
│   ▼                                           │   │  - index.php (dashboard)  │
│  ptp-agent.py (systemd, :8081) ◄──────────────┼─HTTP┼ ajax.php (Bearer token) │
│   - discovers NICs + PHCs via ethtool         │bridge│                          │
│   - creates/destroys VLAN sub-interfaces      │ IP  │                           │
│   - renders one ptp4l-<profile>.conf per      │     │                           │
│     profile, manages ptp4l@<profile>.service  │     │                           │
│   - polls pmc per profile for GM/offset/state │     │                           │
│   - writes status.json + history.db           │     │                           │
│   - manages phc2sys across all PHCs in use     │     │                           │
└──────────────────────────────────────────────┘   └───────────────────────────┘
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
   `/etc/ptp-webui/desired.json` with **no VLANs or profiles** - PTP stays
   off until you configure it from the dashboard. Also ensures the `8021q`
   kernel module is loaded (and loads on boot), for VLAN sub-interfaces.
3. Installs a templated `ptp4l@.service` systemd unit (the `linuxptp`
   package doesn't ship one) that runs `ptp4l` against
   `/etc/linuxptp/ptp4l-<profile>.conf`. The agent enables/starts or
   disables/stops one `ptp4l@<profile>` instance per PTP profile defined in
   `desired.json`. If a previous install left a single static
   `ptp4l.service`, it's disabled and removed automatically.
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

### VLANs

If you need to hand off PTP to a downstream segment in a different domain
without a PTP-aware switch (see "Profiles, VLANs and multi-domain boundary
clocks" below), add an 802.1q VLAN sub-interface here: pick a parent
physical NIC and a VLAN ID (1-4094). The agent creates it immediately
(`ip link add link <parent> name <parent>.<id> type vlan id <id>`), brings
it up, and persists it in `/etc/network/interfaces.d/ptp-webui-vlans` so it
survives a reboot. A VLAN can be removed once it's no longer assigned to any
profile below.

### Interfaces

Every physical NIC and every VLAN created above is listed here (`vmbr*`,
`veth*`, `tap*` and other virtual interfaces are excluded). Each card shows:

- link state, speed, and driver (or "VLAN of `<parent>`" for VLAN
  sub-interfaces, which always share their parent's hardware clock)
- its **hardware PTP clock (PHC)** group, if any - interfaces that share the
  same underlying PHC (e.g. both SFP+ ports on a multi-port NIC, or a VLAN
  and its parent) are labelled with the same letter (A, B, ...). Interfaces
  with no PHC fall back to software timestamping.
- a **Profile** selector - assign the interface to one of the PTP profiles
  defined below, or leave it "Unassigned" (no `ptp4l` instance touches it).
  Each interface/VLAN can belong to at most one profile.
- once assigned, a checkbox to enable/disable `ptp4l` on that interface
  within its profile, and a role: **Uplink** (listen for an external
  grandmaster - the only port in that profile that can become SLAVE) or
  **Downstream** (always advertises this device as master on that segment,
  terminating the profile's PTP domain for devices there). Only one
  interface per profile can be the uplink; selecting a new uplink
  automatically demotes the previous one to downstream.

## Profiles, VLANs and multi-domain boundary clocks

Each **PTP profile** is an independent `ptp4l` instance/domain
(`ptp4l@<profile>.service`, config `/etc/linuxptp/ptp4l-<profile>.conf`),
with its own:

- Domain number, `priority1`/`priority2` (lower wins BMCA elections - lower
  this device's `priority1` if you want it preferred as grandmaster), and
  the announce/sync/min-delay-request intervals (log2 seconds).
- Status banner:
  - **"This device is the Grandmaster"** - `stepsRemoved == 0`, i.e.
    nothing better was heard on the profile's uplink (or it has no uplink).
  - **"Synced to grandmaster ..."** - shows hop count and current offset in
    nanoseconds.
  - **"No grandmaster present"** - the uplink hasn't heard an announce
    message yet.
  - A red error banner if `ptp4l@<profile>` failed to start, including the
    relevant `journalctl` output.
- An offset graph: offset-from-grandmaster (nanoseconds) over the last hour,
  sampled every ~3 seconds and retained for 48 hours in
  `/var/lib/ptp-webui/history.db` on the host.

For each profile, the agent renders `/etc/linuxptp/ptp4l-<profile>.conf`
with one `[<interface>]` section per interface/VLAN assigned to it:

- **Uplink**: no `serverOnly` override (defaults to `0`), so BMCA can let it
  run as SLAVE to a better clock, or as MASTER/GM if nothing better is heard.
- **Downstream**: `serverOnly 1`, so it never becomes SLAVE and always
  advertises this device as master - this is what "terminates" the domain
  for downstream devices rather than transparently relaying it.
- `time_stamping` is a global-only `ptp4l` option, so it's set once per
  profile in `[global]`: `hardware` if every interface in that profile has a
  PHC (per `ethtool -T`), otherwise `software` for all of them.
- `boundary_clock_jbod 1` is set automatically whenever a profile's
  interfaces span more than one distinct PHC.
- Each profile gets its own `uds_address`/`uds_ro_address`, so
  `pmc -s /var/run/ptp4l-<profile>` queries that instance independently of
  any others.

### Splitting domains across a VLAN

To terminate an incoming domain on an uplink and re-distribute time as a
*different* domain downstream (avoiding the need for PTP-aware switches):

1. In **VLANs**, add a VLAN sub-interface on the NIC connected to the
   downstream segment (e.g. `nic1.100`).
2. Create two profiles, e.g. `wan` (domain 0) with `nic0` as **Uplink**, and
   `lan-ptp` (domain 1) with `nic1.100` as **Downstream**.
3. Save. `wan` syncs this device to the upstream grandmaster on domain 0;
   `lan-ptp` makes this device the grandmaster for domain 1 on the tagged
   VLAN, with no PTP awareness required from the switch in between.

### Clock synchronization (`phc2sys`)

All hardware clocks (PHCs) in use across every profile are kept
disciplined relative to each other. The agent picks a **reference clock**:
the PHC of whichever profile's uplink is currently SLAVE to an external
grandmaster (`stepsRemoved > 0`), or `CLOCK_REALTIME` if this device is the
grandmaster for everything. Every other PHC is bridged from the reference
via `phc2sys -s <reference> -c /dev/ptp<N> -O 0`, and if the reference is
itself a PHC, `CLOCK_REALTIME` is also bridged from it (`-m`). The "Clock
synchronization" section of the dashboard lists the active bridges.

### Per-interface transport (IPv4/IPv6/L2) and unicast PTP

`ptp4l`'s `network_transport` is a per-port option, so each interface in a
profile has its own **Transport** dropdown: `UDPv4` (default), `UDPv6`, or
`L2` (raw Ethernet/802.3 - no IP needed). A profile/domain becomes
"dual-stack" by *mixing* transports across its ports (e.g. an `UDPv6`
uplink and a `UDPv4` downstream VLAN in the same profile) - a single port
always speaks exactly one transport. For `UDPv6`, the interface needs an
IPv6 address; a link-local (`fe80::/10`) address, which Linux assigns
automatically, is enough for link-local multicast/unicast. Each interface
card shows its current IPv4/IPv6 addresses for reference.

Each interface also has two unicast options:

- **Unicast master targets** (one address per line, matching the port's
  transport - IPv4/IPv6 address, or a MAC address for `L2`): when set,
  this port operates as a *unicast slave*, requesting PTP service from
  those specific addresses via `unicast_master_table`. Use this when an
  upstream grandmaster is only reachable via unicast (e.g. across a routed
  network where multicast PTP doesn't propagate).
- **Allow unicast clients**: sets `unicast_listen 1` on this port, letting
  it dynamically grant unicast service to any slave that negotiates with
  it. `ptp4l` has no static "push to these slave addresses" master config -
  to use this device as a unicast master, enable this checkbox here, then
  configure *this interface's address* (shown on its card) as a unicast
  master target on the remote slave.

## Networking caveat

PTP relies on hardware timestamps and (for the `E2E` delay mechanism used
here) regular UDP traffic on the wire. Ports that are enslaved to a Proxmox
Linux bridge (`vmbr*`) and shared with VM/container traffic can still work,
but for the best accuracy and to avoid surprises from bridge STP/filtering,
prefer dedicating physical ports that are **not** members of a `vmbr*`
bridge to PTP where possible.

## Troubleshooting

Check the agent and per-profile ptp4l services on the host (replace
`<profile>` with a profile name from `/etc/ptp-webui/desired.json`, e.g.
`default`, `wan`, `lan-ptp`):

```bash
systemctl status ptp-agent
systemctl status ptp4l@<profile>
journalctl -u ptp4l@<profile> -n 50
```

Query the agent API directly:

```bash
curl -s -H "Authorization: Bearer $(cat /etc/ptp-webui/agent.token)" \
  http://localhost:8081/api/status | python3 -m json.tool
```

Query a specific profile's `ptp4l` instance directly with `pmc`, via its
own UDS socket:

```bash
pmc -u -b 0 -s /var/run/ptp4l-<profile> 'GET DEFAULT_DATA_SET'
pmc -u -b 0 -s /var/run/ptp4l-<profile> 'GET CURRENT_DATA_SET'
pmc -u -b 0 -s /var/run/ptp4l-<profile> 'GET TIME_STATUS_NP'
pmc -u -b 0 -s /var/run/ptp4l-<profile> 'GET PORT_DATA_SET'
```

`CURRENT_DATA_SET.stepsRemoved == 0` means this profile's domain is
currently grandmastered by this device.

Check `phc2sys` clock-bridging processes:

```bash
ps -ef | grep phc2sys
```

## Resetting the admin password

The admin password hash lives in `/var/www/ptp-webui/.env` inside the
`ptp-webui` container. To reset it:

```bash
NEWHASH=$(pct exec <vmid> -- php -r 'echo password_hash($argv[1], PASSWORD_DEFAULT);' -- 'new-password')
pct exec <vmid> -- sed -i "s#^ADMIN_PASSWORD_HASH=.*#ADMIN_PASSWORD_HASH=${NEWHASH}#" /var/www/ptp-webui/.env
```

(Find `<vmid>` with `pct list`.)
