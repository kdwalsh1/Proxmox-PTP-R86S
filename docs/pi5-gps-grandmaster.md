# Pi5 + GPS PTP grandmaster

`pi5-gm/` turns a Raspberry Pi 5 into a GPS-disciplined PTP grandmaster
and/or boundary clock, using **the exact same `ptp-agent.py` + web
dashboard** as the R86S (see [setup.md](setup.md)) - deployed locally on
the Pi5 instead of inside a Proxmox LXC. Whether a given PTP profile
sources its time from GPS or from an uplink interface is just a dashboard
setting (**Clock source**), so the same Pi5 can be a grandmaster for one
domain and a boundary clock for another, exactly like the R86S can.

## Architecture

```
GNSS module (e.g. Waveshare LC76G)
  │ UART (NMEA)              │ PPS
  ▼                          ▼
 gpsd   ───SHM 0 (coarse)──► chrony  ◄── refclock PPS /dev/pps0 (precise)
                                │
                                │ disciplines CLOCK_REALTIME
                                ▼
                    phc2sys -s CLOCK_REALTIME -c eth0
                                │ steps the NIC's hardware clock (PHC)
                                ▼
   ptp4l -i eth0 (profile clockSource=gps: time_stamping hardware,
                  clockClass pushed live by ptp-agent via pmc)
                                │
                                ▼
                  R86S boundary clock's uplink NIC (same domain)
```

The Pi5's onboard NIC (RP1 `macb` driver) supports hardware TX/RX
timestamping, so `ptp4l` runs in `time_stamping hardware` mode directly on
`eth0` - no additional PTP-capable NIC is needed. This differs from a
Compute Module 4/5 on a carrier board, which exposes a PHY-level
`SYNC_OUT` pin (used by projects like SatPulse) for disciplining the PHC
straight from the PPS signal; a stock Pi5 board doesn't have that pin, so
GPS+PPS instead disciplines `CLOCK_REALTIME` via `chrony`, and `phc2sys`
carries that into the NIC's PHC. This is simpler to wire and plenty
accurate for a homelab boundary clock.

`ptp-agent.py` polls `gpsd`/`chrony` every 3 seconds and, for any profile
whose clock source is GPS, pushes the right `clockClass` (6 = GNSS-locked,
248 = free-running) live via `pmc SET GRANDMASTER_SETTINGS_NP` - no
`ptp4l` restart, and downstream devices see within one poll tick if the
fix or PPS lock is lost.

## Hardware

- Raspberry Pi 5, running Raspberry Pi OS (Bookworm, 64-bit)
- A GNSS module with a UART (NMEA) output and a PPS pin, e.g. the
  [Waveshare LC76G](https://www.waveshare.com/lc76g-gnss-module.htm) (bare
  module - UART, I2C, PPS, RST pins; needs wiring, not a HAT)
- A GNSS antenna with clear sky view (active antenna if the module
  requires one)

### Wiring

`pi5-gm/setup.sh` defaults to UART3 (`uart3-pi5` overlay, GPIO4/GPIO5)
rather than the primary UART0 on GPIO14/15, which on Pi5 defaults to the
serial console and is muxed with Bluetooth - using a secondary UART avoids
both of those headaches. PPS defaults to GPIO18 - there's no Pi5-specific
"low latency" GPIO for this: all GPIO pins run through the RP1 chip
uniformly (RP1 has no per-pin hardware edge-timestamping), so GPIO18 is
just the convention used across every guide, not a special pin.

| LC76G pin | Pi5 pin (BCM / physical)     |
|-----------|-------------------------------|
| VCC       | 3V3 (physical pin 1)           |
| GND       | GND (physical pin 6)           |
| TX        | GPIO5 / RXD3 (physical pin 29) |
| RX        | GPIO4 / TXD3 (physical pin 7)  |
| PPS       | GPIO18 (physical pin 12)       |

Override `UART_OVERLAY`, `UART_DEV` and `PPS_GPIO` (see below) if you wire
it differently.

## Installing

**Option A - single-file installer, no prior clone needed:**

```bash
wget -O install.sh https://raw.githubusercontent.com/kdwalsh1/Proxmox-PTP-R86S/main/pi5-gm/install.sh
sudo bash install.sh
```

This clones the repo to `/opt/proxmox-ptp-r86s-src` and runs
`pi5-gm/setup.sh` from there. Re-running it later pulls the latest changes
and re-applies setup.

**Option B - repo already checked out** (e.g. you already have it for the
R86S):

```bash
git clone https://github.com/kdwalsh1/Proxmox-PTP-R86S.git
cd Proxmox-PTP-R86S
sudo ./pi5-gm/setup.sh
```

Override defaults via environment variables, e.g.:

```bash
PPS_GPIO=18 UART_OVERLAY=uart3-pi5 UART_DEV=/dev/ttyAMA3 sudo -E ./pi5-gm/setup.sh
```

- `PPS_GPIO` (default `18`) - GPIO the PPS line is wired to.
- `UART_OVERLAY` (default `uart3-pi5`) / `UART_DEV` (default
  `/dev/ttyAMA3`) - which UART the GNSS module is wired to.
- `AGENT_PORT` (default `8081`) - port `ptp-agent` listens on.

The script installs `gpsd`, `chrony`, `linuxptp`, `apache2` + PHP; enables
the UART and `pps-gpio` overlays; deploys `ptp-agent.py` and the `webui/`
dashboard locally (same code as the R86S, just no LXC); and prompts for an
admin password on first run. It's safe to re-run.

**A reboot is required the first time** for the `pps-gpio` overlay to take
effect (`/dev/pps0` won't exist, and chrony's PPS refclock will stay
unreachable, until then).

## Making this device a grandmaster

Open the dashboard printed at the end of setup (`http://<pi5-ip>/`) and
log in. Create a PTP profile (or edit one) same as you would on the R86S
(see [setup.md](setup.md#profiles-vlans-and-multi-domain-boundary-clocks)),
and set **Clock source** to **Local GPS + PPS**. A profile with this
clock source can't also have an uplink interface (it's self-sourced);
assign your downstream NIC(s) with role **Downstream**.

The new **GPS grandmaster source** panel at the top of the dashboard shows
(only appears when GPS is actually installed - i.e. never on the R86S):

- Fix status (No fix / 2D fix / 3D fix) and satellites used/visible
- PPS reachability and whether it's the currently-selected chrony source
- Latitude/longitude/altitude and GPS time, with a small map centered on
  the fix (sanity-check that the position looks right)

## Verification

Beyond the dashboard's GPS panel, on the Pi5 itself:

```bash
cgps                                              # NMEA fix (lat/lon, sats)
chronyc sources -v                                # PPS refclock reachable and selected (*)
ethtool -T eth0                                   # hardware-transmit / hardware-receive present
pmc -u -b 0 -s /var/run/ptp4l-<profile> 'GET CURRENT_DATA_SET'   # stepsRemoved 0 == this device is GM
```

Check the services directly if something looks wrong:

```bash
systemctl status gpsd chrony ptp-agent ptp4l@<profile>
journalctl -u ptp-agent -n 50
journalctl -u ptp4l@<profile> -n 50
```

**Known risk to smoke-test on real hardware**: the live `clockClass`
update uses `pmc SET GRANDMASTER_SETTINGS_NP` with a field list
(`clockAccuracy`, `offsetScaledLogVariance`, `currentUtcOffset`, etc.)
assembled from documented linuxptp management fields rather than verified
against this exact command on real hardware. If it doesn't take effect,
`ptp4l-<profile>.conf` still gets a `clockClass 248` at config-apply time
as a safe (if static) fallback - check `journalctl -u ptp-agent` for pmc
errors if the dashboard's fix/PPS badges look healthy but a profile never
shows `clockClass 6` downstream (`pmc GET GRANDMASTER_SETTINGS_NP`).

## Wiring it to the R86S

In the R86S dashboard, create or reuse a profile whose `domainNumber`
matches the Pi5's GPS-sourced profile, and assign the NIC connected to
this Pi5 as **Uplink**. No `priority1` tuning is needed: once the Pi5 is
announcing `clockClass 6`, BMCA will prefer it over the R86S's own
(unsynced) clock automatically. The R86S profile's status banner should
switch to "Synced to grandmaster", `stepsRemoved 1`.
