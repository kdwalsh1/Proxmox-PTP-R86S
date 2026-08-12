# ProxmoxPTP-R86S

> **Disclaimer:** Released under the [MIT License](LICENSE) - provided "as
> is", with no warranty of any kind (see the license for the full text). This
> project is intended for personal testing, learning, and home-lab use. It
> has not been hardened or audited for production/commercial deployment.
> Run it at your own risk, and review every script before running it as root
> on your own infrastructure.

Turns a [Topton/R86S](https://wiki.r86s.net/) mini-PC running Proxmox VE
into a PTP boundary clock, using the hardware timestamping support on its
NICs (e.g. Intel i225/i226, Mellanox ConnectX-3 SFP+), with a web dashboard
for configuration and monitoring.

## Goals

- Run `linuxptp` (`ptp4l` / `phc2sys`) on the Proxmox host, syncing the
  system clock to an external PTP grandmaster on one "uplink" interface
  using hardware timestamps.
- Re-distribute PTP to other interfaces, terminating it for downstream
  devices (boundary clock behaviour) - including re-distributing as a
  *different* PTP domain on a VLAN sub-interface, so PTP-unaware switches
  can sit in between.
- Provide a web dashboard (running in its own LXC) to manage VLAN
  sub-interfaces and one or more independent PTP "profiles" (domains), each
  with its own interfaces/roles and domain/priority/interval settings, see
  per-profile grandmaster status, and graph offset-from-GM over time.
- Optionally provide the grandmaster itself: `pi5-gm/` deploys the same
  `ptp-agent`/dashboard onto a Raspberry Pi 5 with a GPS/GNSS + PPS module,
  where a profile's clock source can be set to "Local GPS + PPS" (GM) or
  "Uplink interface" (boundary clock) - same dashboard, same code, either
  role - for the R86S to sync its uplink to.

## Repository layout

```
setup.sh    One-shot install/provisioning script (run as root on Proxmox)
host/       Files deployed on the Proxmox host / Pi5 (ptp-agent daemon, systemd units, ptp4l.conf template)
webui/      PHP web dashboard, deployed into a new LXC (R86S) or locally (Pi5)
scripts/    Shared install helpers sourced by setup.sh and pi5-gm/setup.sh
pi5-gm/     One-shot setup.sh/install.sh + GPS provisioning for a Pi5 GM/BC device
docs/       Architecture, setup walkthrough, and troubleshooting notes
```

## Getting started

See [docs/setup.md](docs/setup.md) for prerequisites and the setup
walkthrough, and [docs/pi5-gps-grandmaster.md](docs/pi5-gps-grandmaster.md)
for setting up a Pi5 + GPS grandmaster/boundary-clock device (installable
with a single `wget` + run, no manual clone needed) to sync the R86S to.
