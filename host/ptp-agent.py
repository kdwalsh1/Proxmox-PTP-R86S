#!/usr/bin/env python3
"""
ptp-agent: manages PTP VLANs/profiles, applies per-profile ptp4l
configuration, polls ptp4l status, bridges PHCs with phc2sys, and serves a
small token-authenticated HTTP API consumed by the ptp-webui LXC.

Stdlib only. Runs as root via ptp-agent.service.
"""

import json
import os
import re
import sqlite3
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DESIRED_PATH = "/etc/ptp-webui/desired.json"
TOKEN_PATH = "/etc/ptp-webui/agent.token"
PTP4L_CONF_PATH_TMPL = "/etc/linuxptp/ptp4l-{}.conf"
TEMPLATE_PATH = "/opt/ptp-webui/ptp4l.conf.template"
DB_PATH = "/var/lib/ptp-webui/history.db"
VLAN_INTERFACES_FILE = "/etc/network/interfaces.d/ptp-webui-vlans"

HTTP_PORT = 8081
POLL_INTERVAL = 3
HISTORY_RETENTION_HOURS = 48

EXCLUDE_PREFIXES = ("vmbr", "veth", "tap", "fwbr", "fwpr", "fwln", "docker", "br-")

VLAN_ID_MIN, VLAN_ID_MAX = 1, 4094
PROFILE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

DEFAULT_PROFILE = {
    "domainNumber": 0,
    "priority1": 128,
    "priority2": 128,
    "logAnnounceInterval": 1,
    "logSyncInterval": 0,
    "logMinDelayReqInterval": 0,
    "interfaces": {},
}

DEFAULT_DESIRED = {
    "vlans": {},
    "profiles": {},
}

PROFILE_SETTINGS_KEYS = (
    "domainNumber", "priority1", "priority2",
    "logAnnounceInterval", "logSyncInterval", "logMinDelayReqInterval",
)

TOKEN = None
STATE_LOCK = threading.Lock()
STATE = {}


def run(cmd, timeout=5):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except Exception as e:
        return -1, "", str(e)


def discover_physical_interfaces():
    """Enumerate physical NICs. Generic across drivers (igc, mlx4_en, ...)."""
    interfaces = []
    for name in sorted(os.listdir("/sys/class/net")):
        if name == "lo" or name.startswith(EXCLUDE_PREFIXES):
            continue
        path = f"/sys/class/net/{name}"
        if not os.path.exists(f"{path}/device"):
            continue  # virtual interface (incl. VLAN sub-interfaces), skip

        iface = {"name": name, "is_vlan": False}

        try:
            iface["mac"] = open(f"{path}/address").read().strip()
        except OSError:
            iface["mac"] = None

        try:
            operstate = open(f"{path}/operstate").read().strip()
        except OSError:
            operstate = "unknown"
        iface["link"] = operstate == "up"

        try:
            speed = open(f"{path}/speed").read().strip()
            iface["speed_mbps"] = int(speed) if speed.lstrip("-").isdigit() and int(speed) > 0 else None
        except OSError:
            iface["speed_mbps"] = None

        driver = None
        rc, out, _ = run(["ethtool", "-i", name])
        if rc == 0:
            for line in out.splitlines():
                if line.startswith("driver:"):
                    driver = line.split(":", 1)[1].strip()
        iface["driver"] = driver

        phc = None
        rc, out, _ = run(["ethtool", "-T", name])
        if rc == 0:
            for line in out.splitlines():
                line = line.strip()
                # Older ethtool/kernels report "PTP Hardware Clock: N";
                # newer ones report "Hardware timestamp provider index: N".
                if line.startswith("PTP Hardware Clock:") or line.startswith("Hardware timestamp provider index:"):
                    val = line.split(":", 1)[1].strip()
                    if val.isdigit():
                        phc = int(val)
        iface["phc_index"] = phc

        interfaces.append(iface)
    return interfaces


def discover_vlan_interfaces(desired, physical_by_name):
    """Build iface dicts for agent-managed VLAN sub-interfaces that exist.

    A VLAN shares its parent NIC's hardware clock, so phc_index is
    inherited from the parent rather than probed separately.
    """
    interfaces = []
    for name, vcfg in desired.get("vlans", {}).items():
        path = f"/sys/class/net/{name}"
        if not os.path.exists(path):
            continue

        iface = {"name": name, "is_vlan": True, "parent": vcfg.get("parent"), "driver": "vlan"}

        try:
            iface["mac"] = open(f"{path}/address").read().strip()
        except OSError:
            iface["mac"] = None

        try:
            operstate = open(f"{path}/operstate").read().strip()
        except OSError:
            operstate = "unknown"
        iface["link"] = operstate == "up"

        try:
            speed = open(f"{path}/speed").read().strip()
            iface["speed_mbps"] = int(speed) if speed.lstrip("-").isdigit() and int(speed) > 0 else None
        except OSError:
            iface["speed_mbps"] = None

        parent = physical_by_name.get(vcfg.get("parent"))
        iface["phc_index"] = parent["phc_index"] if parent else None

        interfaces.append(iface)
    return interfaces


def discover_interfaces(desired):
    physical = discover_physical_interfaces()
    physical_by_name = {i["name"]: i for i in physical}
    vlans = discover_vlan_interfaces(desired, physical_by_name)
    return physical + vlans


def write_vlan_persistence(vlans):
    """Regenerate /etc/network/interfaces.d/ptp-webui-vlans so agent-managed
    VLANs are recreated by ifupdown2 on boot."""
    if not vlans:
        try:
            os.remove(VLAN_INTERFACES_FILE)
        except OSError:
            pass
        return

    lines = ["# Managed by ptp-agent - do not edit by hand\n"]
    for name, vcfg in sorted(vlans.items()):
        lines.append(f"auto {name}\n")
        lines.append(f"iface {name} inet manual\n")
        lines.append(f"    vlan-raw-device {vcfg['parent']}\n")
    content = "".join(lines)

    try:
        with open(VLAN_INTERFACES_FILE) as f:
            current = f.read()
    except OSError:
        current = None

    if content != current:
        os.makedirs(os.path.dirname(VLAN_INTERFACES_FILE), exist_ok=True)
        with open(VLAN_INTERFACES_FILE, "w") as f:
            f.write(content)


def reconcile_vlans(desired, state):
    """Create/delete 802.1q VLAN sub-interfaces to match desired['vlans']."""
    vlans = desired.get("vlans", {})
    if vlans == state.get("last_vlans"):
        return

    for name, vcfg in vlans.items():
        if not os.path.exists(f"/sys/class/net/{name}"):
            run(["ip", "link", "add", "link", vcfg["parent"], "name", name, "type", "vlan", "id", str(vcfg["vlan_id"])])
            run(["ip", "link", "set", name, "up"])

    old_vlans = state.get("last_vlans") or {}
    for name in old_vlans:
        if name not in vlans and os.path.exists(f"/sys/class/net/{name}"):
            run(["ip", "link", "delete", name])

    write_vlan_persistence(vlans)
    state["last_vlans"] = dict(vlans)


def load_desired():
    try:
        with open(DESIRED_PATH) as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}

    if "profiles" not in data and "interfaces" in data:
        # Migrate the old single-domain schema (top-level domainNumber +
        # interfaces) into a single profile called "default".
        profile = dict(DEFAULT_PROFILE)
        for key in PROFILE_SETTINGS_KEYS:
            if key in data:
                profile[key] = data[key]
        profile["interfaces"] = data.get("interfaces", {}) if isinstance(data.get("interfaces"), dict) else {}
        data = {"vlans": {}, "profiles": {"default": profile}}

    merged = {"vlans": {}, "profiles": {}}
    if isinstance(data.get("vlans"), dict):
        merged["vlans"] = data["vlans"]
    if isinstance(data.get("profiles"), dict):
        for name, profile in data["profiles"].items():
            full = dict(DEFAULT_PROFILE)
            if isinstance(profile, dict):
                for key in PROFILE_SETTINGS_KEYS:
                    if key in profile:
                        full[key] = profile[key]
                full["interfaces"] = profile.get("interfaces", {}) if isinstance(profile.get("interfaces"), dict) else {}
            merged["profiles"][name] = full

    return merged


def validate_desired(data, interfaces):
    if not isinstance(data, dict):
        raise ValueError("body must be a JSON object")

    physical_names = {i["name"] for i in interfaces if not i.get("is_vlan")}

    # --- VLANs ---
    vlans_in = data.get("vlans", {})
    if not isinstance(vlans_in, dict):
        raise ValueError("vlans must be an object")

    out_vlans = {}
    for name in sorted(vlans_in.keys()):
        vcfg = vlans_in[name]
        if not isinstance(vcfg, dict):
            raise ValueError(f"vlan {name}: config must be an object")
        parent = vcfg.get("parent")
        vlan_id = vcfg.get("vlan_id")
        if parent not in physical_names:
            raise ValueError(f"vlan {name}: parent must be a physical interface")
        if not isinstance(vlan_id, int) or isinstance(vlan_id, bool) or not (VLAN_ID_MIN <= vlan_id <= VLAN_ID_MAX):
            raise ValueError(f"vlan {name}: vlan_id must be an integer between {VLAN_ID_MIN} and {VLAN_ID_MAX}")
        if name != f"{parent}.{vlan_id}":
            raise ValueError(f"vlan {name}: name must be '<parent>.<vlan_id>'")
        out_vlans[name] = {"parent": parent, "vlan_id": vlan_id}

    # Interfaces a profile may reference: physical NICs + declared VLANs
    # (a brand-new VLAN doesn't exist in `interfaces` yet - the agent
    # creates it on the next reconcile pass).
    valid_names = physical_names | set(out_vlans.keys())

    # --- Profiles ---
    profiles_in = data.get("profiles", {})
    if not isinstance(profiles_in, dict):
        raise ValueError("profiles must be an object")

    out_profiles = {}
    assigned = {}
    for profile_name in sorted(profiles_in.keys()):
        if not PROFILE_NAME_RE.match(profile_name):
            raise ValueError(f"profile name '{profile_name}' must match {PROFILE_NAME_RE.pattern}")
        pcfg = profiles_in[profile_name]
        if not isinstance(pcfg, dict):
            raise ValueError(f"profile {profile_name}: config must be an object")

        out = {}
        for key, (lo, hi) in (("domainNumber", (0, 127)),
                               ("priority1", (0, 255)),
                               ("priority2", (0, 255))):
            v = pcfg.get(key, DEFAULT_PROFILE[key])
            if not isinstance(v, int) or isinstance(v, bool) or not (lo <= v <= hi):
                raise ValueError(f"profile {profile_name}: {key} must be an integer between {lo} and {hi}")
            out[key] = v

        for key in ("logAnnounceInterval", "logSyncInterval", "logMinDelayReqInterval"):
            v = pcfg.get(key, DEFAULT_PROFILE[key])
            if not isinstance(v, int) or isinstance(v, bool) or not (-7 <= v <= 4):
                raise ValueError(f"profile {profile_name}: {key} must be an integer between -7 and 4")
            out[key] = v

        ifaces = pcfg.get("interfaces", {})
        if not isinstance(ifaces, dict):
            raise ValueError(f"profile {profile_name}: interfaces must be an object")

        out_ifaces = {}
        uplinks = 0
        for name in sorted(ifaces.keys()):
            cfg = ifaces[name]
            if name not in valid_names:
                raise ValueError(f"profile {profile_name}: unknown interface '{name}'")
            if not isinstance(cfg, dict):
                raise ValueError(f"profile {profile_name}: interface {name} config must be an object")
            enabled = bool(cfg.get("enabled", False))
            role = cfg.get("role", "downstream")
            if role not in ("uplink", "downstream"):
                raise ValueError(f"profile {profile_name}: interface {name} role must be 'uplink' or 'downstream'")
            if enabled:
                if role == "uplink":
                    uplinks += 1
                if name in assigned:
                    raise ValueError(
                        f"interface '{name}' is enabled in multiple profiles "
                        f"('{assigned[name]}' and '{profile_name}')"
                    )
                assigned[name] = profile_name
            out_ifaces[name] = {"enabled": enabled, "role": role}

        if uplinks > 1:
            raise ValueError(f"profile {profile_name}: only one interface may be configured as the uplink")

        out["interfaces"] = out_ifaces
        out_profiles[profile_name] = out

    # Reject removing a VLAN that's still referenced by a profile.
    referenced_vlans = set()
    for pcfg in out_profiles.values():
        for name in pcfg["interfaces"]:
            if name not in physical_names:
                referenced_vlans.add(name)
    missing = referenced_vlans - set(out_vlans.keys())
    if missing:
        raise ValueError(f"cannot remove VLAN(s) still referenced by a profile: {', '.join(sorted(missing))}")

    return {"vlans": out_vlans, "profiles": out_profiles}


def get_enabled_interfaces(profile_cfg, interfaces):
    """Ordered list of (name, cfg, iface_info) for a profile's enabled interfaces.

    The order here determines ptp4l port numbering (1-based, in config
    file order), and must match the order sections are written in
    render_ptp4l_conf so pmc port numbers can be mapped back to names.
    """
    by_name = {i["name"]: i for i in interfaces}
    result = []
    for name, cfg in profile_cfg["interfaces"].items():
        if cfg.get("enabled") and name in by_name:
            result.append((name, cfg, by_name[name]))
    return result


def render_ptp4l_conf(profile_name, profile_cfg, interfaces):
    enabled = get_enabled_interfaces(profile_cfg, interfaces)
    if not enabled:
        return None

    try:
        with open(TEMPLATE_PATH) as f:
            lines = [f.read().rstrip()]
    except OSError:
        lines = ["[global]"]

    lines.append(f"domainNumber\t\t{profile_cfg['domainNumber']}")
    lines.append(f"priority1\t\t{profile_cfg['priority1']}")
    lines.append(f"priority2\t\t{profile_cfg['priority2']}")
    lines.append(f"logAnnounceInterval\t{profile_cfg['logAnnounceInterval']}")
    lines.append(f"logSyncInterval\t\t{profile_cfg['logSyncInterval']}")
    lines.append(f"logMinDelayReqInterval\t{profile_cfg['logMinDelayReqInterval']}")

    # Each profile is a separate ptp4l instance: give it its own UDS socket
    # paths so pmc can address it independently of any other profile.
    lines.append(f"uds_address\t\t/var/run/ptp4l-{profile_name}")
    lines.append(f"uds_ro_address\t\t/var/run/ptp4l-{profile_name}.ro")

    # Hardware is parsed, not assumed: if this profile's ports don't share a
    # common PHC, ptp4l needs boundary_clock_jbod to manage each port's
    # clock independently.
    phcs = {iface["phc_index"] for _, _, iface in enabled if iface["phc_index"] is not None}
    if len(phcs) > 1:
        lines.append("boundary_clock_jbod\t1")

    # time_stamping is a global-only option (not valid per-port): use
    # hardware only if every enabled port has a PHC, otherwise fall back to
    # software for all of them so ptp4l doesn't fail to parse the config.
    all_hw = all(iface["phc_index"] is not None for _, _, iface in enabled)
    lines.append(f"time_stamping\t\t{'hardware' if all_hw else 'software'}")

    for name, cfg, iface in enabled:
        lines.append(f"\n[{name}]")
        if cfg.get("role") == "downstream":
            lines.append("serverOnly\t\t1")

    return "\n".join(lines) + "\n"


def apply_config(desired, interfaces, state):
    last_conf = state.setdefault("last_conf", {})
    errors = state.setdefault("error", {})
    known = state.setdefault("known_profiles", set())

    current_profiles = set(desired["profiles"].keys())

    for name, profile_cfg in desired["profiles"].items():
        conf = render_ptp4l_conf(name, profile_cfg, interfaces)
        if conf == last_conf.get(name):
            continue
        last_conf[name] = conf

        conf_path = PTP4L_CONF_PATH_TMPL.format(name)
        error = None
        if conf is None:
            run(["systemctl", "disable", "--now", f"ptp4l@{name}"])
        else:
            os.makedirs(os.path.dirname(conf_path), exist_ok=True)
            with open(conf_path, "w") as f:
                f.write(conf)
            run(["systemctl", "enable", f"ptp4l@{name}"])
            run(["systemctl", "restart", f"ptp4l@{name}"], timeout=15)
            _, active, _ = run(["systemctl", "is-active", f"ptp4l@{name}"])
            if active.strip() != "active":
                _, journal, _ = run(["journalctl", "-u", f"ptp4l@{name}", "-n", "20", "--no-pager"])
                error = journal
        errors[name] = error

    for name in known - current_profiles:
        run(["systemctl", "disable", "--now", f"ptp4l@{name}"])
        try:
            os.remove(PTP4L_CONF_PATH_TMPL.format(name))
        except OSError:
            pass
        last_conf.pop(name, None)
        errors.pop(name, None)

    state["known_profiles"] = current_profiles


def parse_pmc_output(output):
    """Parse `pmc` text output into a list of response blocks (dicts)."""
    blocks = []
    current = None
    header_re = re.compile(r"^\s*([0-9a-fA-F.]+-\d+)\s+seq\s+\d+\s+RESPONSE MANAGEMENT\s+(\S+)")
    for line in output.splitlines():
        if not line.strip() or line.startswith("sending:"):
            continue
        m = header_re.match(line)
        if m:
            current = {"_portIdentity": m.group(1), "_type": m.group(2)}
            blocks.append(current)
            continue
        if current is not None:
            parts = line.strip().split(None, 1)
            if len(parts) == 2:
                current[parts[0]] = parts[1]
            elif len(parts) == 1:
                current[parts[0]] = ""
    return blocks


def run_pmc(uds_address, command):
    rc, out, _ = run(["pmc", "-u", "-b", "0", "-s", uds_address, command], timeout=5)
    if rc != 0:
        return None
    return parse_pmc_output(out)


def query_profile_status(profile_name, profile_cfg, interfaces, state):
    _, active, _ = run(["systemctl", "is-active", f"ptp4l@{profile_name}"])
    result = {
        "ptp4l_running": active.strip() == "active",
        "is_grandmaster": None,
        "gm_present": None,
        "gm_identity": None,
        "clock_identity": None,
        "steps_removed": None,
        "master_offset_ns": None,
        "port_states": {},
        "error": state.get("error", {}).get(profile_name),
    }
    if not result["ptp4l_running"]:
        return result

    uds = f"/var/run/ptp4l-{profile_name}"

    dds = run_pmc(uds, "GET DEFAULT_DATA_SET")
    if dds:
        result["clock_identity"] = dds[0].get("clockIdentity")

    cds = run_pmc(uds, "GET CURRENT_DATA_SET")
    if cds:
        try:
            result["steps_removed"] = int(cds[0].get("stepsRemoved"))
            result["is_grandmaster"] = result["steps_removed"] == 0
        except (TypeError, ValueError):
            pass

    tsn = run_pmc(uds, "GET TIME_STATUS_NP")
    if tsn:
        result["gm_present"] = tsn[0].get("gmPresent") == "true"
        result["gm_identity"] = tsn[0].get("gmIdentity")
        try:
            result["master_offset_ns"] = int(tsn[0].get("master_offset"))
        except (TypeError, ValueError):
            pass

    enabled = get_enabled_interfaces(profile_cfg, interfaces)
    pds = run_pmc(uds, "GET PORT_DATA_SET")
    if pds:
        for block in pds:
            port_id = block.get("_portIdentity", "")
            try:
                port_num = int(port_id.rsplit("-", 1)[1])
            except (IndexError, ValueError):
                continue
            if 1 <= port_num <= len(enabled):
                iface_name = enabled[port_num - 1][0]
                result["port_states"][iface_name] = block.get("portState")

    return result


def reconcile_phc2sys(desired, interfaces, profile_statuses, state):
    """Keep every PHC in play disciplined relative to a single reference clock.

    The reference is the PHC of whichever profile's uplink is currently
    slaved to an external grandmaster (steps_removed > 0). If no profile is
    externally slaved, CLOCK_REALTIME is the reference (this box is the GM
    for everything). Every other PHC gets a phc2sys bridge from the
    reference, and if the reference is a PHC, CLOCK_REALTIME is also bridged
    from it so the host clock tracks PTP too.
    """
    all_phcs = set()
    for profile_cfg in desired["profiles"].values():
        for _, _, iface in get_enabled_interfaces(profile_cfg, interfaces):
            if iface["phc_index"] is not None:
                all_phcs.add(iface["phc_index"])

    reference = "CLOCK_REALTIME"
    for profile_name, profile_cfg in desired["profiles"].items():
        status = profile_statuses.get(profile_name, {})
        steps = status.get("steps_removed")
        if steps is None or steps <= 0:
            continue
        for _, cfg, iface in get_enabled_interfaces(profile_cfg, interfaces):
            if cfg.get("role") == "uplink" and iface["phc_index"] is not None:
                reference = f"/dev/ptp{iface['phc_index']}"
                break
        if reference != "CLOCK_REALTIME":
            break

    desired_bridges = {}
    for phc in all_phcs:
        target = f"/dev/ptp{phc}"
        if target != reference:
            desired_bridges[target] = reference
    if reference != "CLOCK_REALTIME":
        desired_bridges["CLOCK_REALTIME"] = reference

    procs = state.setdefault("phc2sys_procs", {})
    sources = state.setdefault("phc2sys_sources", {})

    for target in list(procs.keys()):
        if desired_bridges.get(target) != sources.get(target):
            proc = procs.pop(target)
            sources.pop(target, None)
            if proc and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()

    for target, source in desired_bridges.items():
        if target in procs:
            continue
        cmd = ["phc2sys", "-s", source, "-c", target, "-O", "0"]
        if target == "CLOCK_REALTIME":
            cmd.append("-m")
        procs[target] = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sources[target] = source

    bridges = []
    for target, proc in procs.items():
        bridges.append({
            "source": sources.get(target),
            "target": target,
            "active": proc is not None and proc.poll() is None,
        })
    return bridges


def build_status(desired, interfaces, profile_statuses, phc2sys_bridges):
    assignment = {}
    for pname, pcfg in desired["profiles"].items():
        for iname, icfg in pcfg["interfaces"].items():
            assignment[iname] = (pname, icfg.get("role", "downstream"), bool(icfg.get("enabled")))

    iface_list = []
    for i in interfaces:
        a = assignment.get(i["name"])
        profile, role, enabled = a if a else (None, "downstream", False)
        port_state = None
        if profile and enabled:
            port_state = profile_statuses.get(profile, {}).get("port_states", {}).get(i["name"])
        iface_list.append({
            "name": i["name"],
            "mac": i["mac"],
            "driver": i["driver"],
            "link": i["link"],
            "speed_mbps": i["speed_mbps"],
            "phc_index": i["phc_index"],
            "is_vlan": i.get("is_vlan", False),
            "parent": i.get("parent"),
            "profile": profile,
            "enabled": enabled,
            "role": role,
            "port_state": port_state,
        })

    existing_vlan_names = {i["name"] for i in interfaces if i.get("is_vlan")}
    vlan_list = []
    for name, vcfg in desired.get("vlans", {}).items():
        vlan_list.append({
            "name": name,
            "parent": vcfg.get("parent"),
            "vlan_id": vcfg.get("vlan_id"),
            "exists": name in existing_vlan_names,
        })

    profiles_out = {}
    for name, profile_cfg in desired["profiles"].items():
        status = profile_statuses.get(name, {})
        profiles_out[name] = {
            "ptp4l_running": status.get("ptp4l_running", False),
            "clock_identity": status.get("clock_identity"),
            "is_grandmaster": status.get("is_grandmaster"),
            "gm_present": status.get("gm_present"),
            "gm_identity": status.get("gm_identity"),
            "steps_removed": status.get("steps_removed"),
            "master_offset_ns": status.get("master_offset_ns"),
            "error": status.get("error"),
            "config": {k: profile_cfg[k] for k in PROFILE_SETTINGS_KEYS},
        }

    return {
        "updated": int(time.time()),
        "interfaces": iface_list,
        "vlans": vlan_list,
        "profiles": profiles_out,
        "phc2sys": phc2sys_bridges,
    }


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("CREATE TABLE IF NOT EXISTS offset_history ("
                  "ts INTEGER NOT NULL, offset_ns INTEGER, gm_present INTEGER)")
    cols = [row[1] for row in conn.execute("PRAGMA table_info(offset_history)")]
    if "profile" not in cols:
        conn.execute("ALTER TABLE offset_history ADD COLUMN profile TEXT NOT NULL DEFAULT 'default'")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_offset_history_profile_ts ON offset_history(profile, ts)")
    conn.commit()
    return conn


def record_sample(conn, profile, offset_ns, gm_present):
    now = int(time.time())
    conn.execute("INSERT INTO offset_history (ts, profile, offset_ns, gm_present) VALUES (?, ?, ?, ?)",
                  (now, profile, offset_ns, 1 if gm_present else 0))
    conn.execute("DELETE FROM offset_history WHERE ts < ?", (now - HISTORY_RETENTION_HOURS * 3600,))
    conn.commit()


def fetch_history(conn, minutes, profile):
    cutoff = int(time.time()) - minutes * 60
    cur = conn.execute(
        "SELECT ts, offset_ns FROM offset_history WHERE ts >= ? AND profile = ? ORDER BY ts",
        (cutoff, profile),
    )
    return [{"ts": row[0], "offset_ns": row[1]} for row in cur.fetchall()]


def poll_loop():
    state = {}
    conn = init_db()
    STATE["db"] = conn
    while True:
        try:
            desired = load_desired()
            reconcile_vlans(desired, state)
            interfaces = discover_interfaces(desired)

            apply_config(desired, interfaces, state)

            profile_statuses = {
                name: query_profile_status(name, profile_cfg, interfaces, state)
                for name, profile_cfg in desired["profiles"].items()
            }

            phc2sys_bridges = reconcile_phc2sys(desired, interfaces, profile_statuses, state)
            status = build_status(desired, interfaces, profile_statuses, phc2sys_bridges)

            with STATE_LOCK:
                STATE["status"] = status
                STATE["desired"] = desired
                STATE["interfaces"] = interfaces

            for name, pstatus in profile_statuses.items():
                if pstatus.get("master_offset_ns") is not None:
                    record_sample(conn, name, pstatus["master_offset_ns"], pstatus.get("gm_present"))
        except Exception as e:
            with STATE_LOCK:
                STATE["status"] = {"updated": int(time.time()), "error": f"agent error: {e}"}
        time.sleep(POLL_INTERVAL)


class Handler(BaseHTTPRequestHandler):
    def _authorized(self):
        return self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def _send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._authorized():
            self._send_json(401, {"error": "unauthorized"})
            return

        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/status":
            with STATE_LOCK:
                self._send_json(200, STATE.get("status", {"updated": 0}))
        elif parsed.path == "/api/history":
            qs = urllib.parse.parse_qs(parsed.query)
            profile = (qs.get("profile") or [None])[0]
            with STATE_LOCK:
                desired = STATE.get("desired", DEFAULT_DESIRED)
                conn = STATE["db"]
            if not profile or profile not in desired.get("profiles", {}):
                self._send_json(400, {"error": "unknown or missing profile"})
                return
            try:
                minutes = int(qs.get("minutes", ["60"])[0])
            except ValueError:
                minutes = 60
            minutes = max(1, min(minutes, HISTORY_RETENTION_HOURS * 60))
            self._send_json(200, fetch_history(conn, minutes, profile))
        elif parsed.path == "/api/config":
            with STATE_LOCK:
                self._send_json(200, STATE.get("desired", DEFAULT_DESIRED))
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            self._send_json(401, {"error": "unauthorized"})
            return

        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/config":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            with STATE_LOCK:
                interfaces = STATE.get("interfaces", [])
                validated = validate_desired(body, interfaces)
                os.makedirs(os.path.dirname(DESIRED_PATH), exist_ok=True)
                with open(DESIRED_PATH, "w") as f:
                    json.dump(validated, f, indent=2)
                STATE["desired"] = validated
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
            return
        except Exception as e:
            self._send_json(500, {"error": str(e)})
            return

        self._send_json(200, {"ok": True})

    def log_message(self, *args):
        pass


def main():
    global TOKEN
    with open(TOKEN_PATH) as f:
        TOKEN = f.read().strip()

    STATE["status"] = {"updated": 0}
    STATE["desired"] = load_desired()
    STATE["interfaces"] = []

    threading.Thread(target=poll_loop, daemon=True).start()

    server = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
