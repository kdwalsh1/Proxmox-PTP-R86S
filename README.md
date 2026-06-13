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

## Repository layout

```
setup.sh    One-shot install/provisioning script (run as root on Proxmox)
host/       Files deployed on the Proxmox host (ptp-agent daemon, systemd units, ptp4l.conf template)
webui/      PHP web dashboard, deployed into a new LXC
docs/       Architecture, setup walkthrough, and troubleshooting notes
```

## Getting started

See [docs/setup.md](docs/setup.md) for prerequisites and the setup
walkthrough.
