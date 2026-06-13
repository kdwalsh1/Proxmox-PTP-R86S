# ProxmoxPTP-R86S

> **Disclaimer:** Released under the [MIT License](LICENSE) - provided "as
> is", with no warranty of any kind (see the license for the full text). This
> project is intended for personal testing, learning, and home-lab use. It
> has not been hardened or audited for production/commercial deployment.
> Run it at your own risk, and review every script before running it as root
> on your own infrastructure.

Scripts and docs for setting up Precision Time Protocol (PTP) on a
[Topton/R86S](https://wiki.r86s.net/) mini-PC running Proxmox VE, using the
hardware timestamping support on its Intel i225/i226 NICs.

## Goals

- Configure `linuxptp` (`ptp4l` / `phc2sys`) on the Proxmox host to sync the
  system clock to a PTP grandmaster (or act as one) using hardware
  timestamps.
- Distribute accurate time from the Proxmox host to guest VMs/LXCs via NTP
  or PTP.

## Repository layout

```
scripts/    Setup/config scripts for the Proxmox host
docs/       Setup and configuration notes
```

## Getting started

See [docs/setup.md](docs/setup.md) for prerequisites and the setup
walkthrough.
