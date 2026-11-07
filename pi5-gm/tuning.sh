#!/bin/bash
# Pi 5 GM timing isolation: PPS IRQ + chrony on CPU3, eth0 IRQ + ptp4l/phc2sys on CPU2,
# everything else on CPU0-1, PTP-aware egress priority on eth0. Reboot afterwards.
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tuning"
CMDLINE="${CMDLINE:-/boot/firmware/cmdline.txt}"
install -m755 "$D/timing-irq-pin" "$D/ptp-qdisc" /usr/local/sbin/
install -m644 "$D/systemd/timing-irq-pin.service" /etc/systemd/system/
for d in "$D"/systemd/*.service.d; do
  n=$(basename "$d"); mkdir -p "/etc/systemd/system/$n"
  install -m644 "$d/timing.conf" "/etc/systemd/system/$n/"
done
grep -q 'isolcpus=2,3' "$CMDLINE" || sed -i '1 s/$/ isolcpus=2,3 irqaffinity=0,1/' "$CMDLINE"
systemctl daemon-reload
systemctl enable timing-irq-pin
echo "--> Timing isolation installed. Reboot to apply. Do NOT add threadirqs (it raises PPS jitter)."
