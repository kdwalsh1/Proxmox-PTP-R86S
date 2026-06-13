#!/usr/bin/env python3
"""
ptp-agent: applies PTP configuration, polls ptp4l status, and serves a small
token-authenticated HTTP API consumed by the ptp-webui LXC.

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
PTP4L_CONF_PATH = "/etc/linuxptp/ptp4l.conf"
TEMPLATE_PATH = "/opt/ptp-webui/ptp4l.conf.template"
DB_PATH = "/var/lib/ptp-webui/history.db"

HTTP_PORT = 8081
POLL_INTERVAL = 3
HISTORY_RETENTION_HOURS = 48

EXCLUDE_PREFIXES = ("vmbr", "veth", "tap", "fwbr", "fwpr", "fwln", "docker", "br-")

DEFAULT_DESIRED = {
    "domainNumber": 0,
    "priority1": 128,
    "priority2": 128,
    "logAnnounceInterval": 1,
    "logSyncInterval": 0,
    "logMinDelayReqInterval": 0,
    "interfaces": {},
}

TOKEN = None
STATE_LOCK = threading.Lock()
STATE = {}


def run(cmd, timeout=5):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except Exception as e:
        return -1, "", str(e)


def discover_interfaces():
    """Enumerate physical NICs. Generic across drivers (igc, mlx4_en, ...)."""
    interfaces = []
    for name in sorted(os.listdir("/sys/class/net")):
        if name == "lo" or name.startswith(EXCLUDE_PREFIXES):
            continue
        path = f"/sys/class/net/{name}"
        if not os.path.exists(f"{path}/device"):
            continue  # virtual interface, skip

        iface = {"name": name}

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
                if "PTP Hardware Clock" in line:
                    val = line.split(":", 1)[1].strip()
                    if val.isdigit():
                        phc = int(val)
        iface["phc_index"] = phc

        interfaces.append(iface)
    return interfaces


def load_desired():
    try:
        with open(DESIRED_PATH) as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    merged = dict(DEFAULT_DESIRED)
    for key in ("domainNumber", "priority1", "priority2",
                "logAnnounceInterval", "logSyncInterval", "logMinDelayReqInterval"):
        if key in data:
            merged[key] = data[key]
    merged["interfaces"] = data.get("interfaces", {}) if isinstance(data.get("interfaces"), dict) else {}
    return merged


def validate_desired(data, interfaces):
    if not isinstance(data, dict):
        raise ValueError("body must be a JSON object")

    out = {}
    for key, (lo, hi) in (("domainNumber", (0, 127)),
                           ("priority1", (0, 255)),
                           ("priority2", (0, 255))):
        v = data.get(key, DEFAULT_DESIRED[key])
        if not isinstance(v, int) or isinstance(v, bool) or not (lo <= v <= hi):
            raise ValueError(f"{key} must be an integer between {lo} and {hi}")
        out[key] = v

    for key in ("logAnnounceInterval", "logSyncInterval", "logMinDelayReqInterval"):
        v = data.get(key, DEFAULT_DESIRED[key])
        if not isinstance(v, int) or isinstance(v, bool) or not (-7 <= v <= 4):
            raise ValueError(f"{key} must be an integer between -7 and 4")
        out[key] = v

    valid_names = {i["name"] for i in interfaces}
    ifaces = data.get("interfaces", {})
    if not isinstance(ifaces, dict):
        raise ValueError("interfaces must be an object")

    out_ifaces = {}
    uplinks = 0
    for name in sorted(ifaces.keys()):
        cfg = ifaces[name]
        if name not in valid_names:
            raise ValueError(f"unknown interface: {name}")
        if not isinstance(cfg, dict):
            raise ValueError(f"interface {name}: config must be an object")
        enabled = bool(cfg.get("enabled", False))
        role = cfg.get("role", "downstream")
        if role not in ("uplink", "downstream"):
            raise ValueError(f"interface {name}: role must be 'uplink' or 'downstream'")
        if enabled and role == "uplink":
            uplinks += 1
        out_ifaces[name] = {"enabled": enabled, "role": role}

    if uplinks > 1:
        raise ValueError("only one interface may be configured as the uplink")

    out["interfaces"] = out_ifaces
    return out


def get_enabled_interfaces(desired, interfaces):
    """Ordered list of (name, cfg, iface_info) for enabled interfaces.

    The order here determines ptp4l port numbering (1-based, in config
    file order), and must match the order sections are written in
    render_ptp4l_conf so pmc port numbers can be mapped back to names.
    """
    by_name = {i["name"]: i for i in interfaces}
    result = []
    for name, cfg in desired["interfaces"].items():
        if cfg.get("enabled") and name in by_name:
            result.append((name, cfg, by_name[name]))
    return result


def render_ptp4l_conf(desired, interfaces):
    enabled = get_enabled_interfaces(desired, interfaces)
    if not enabled:
        return None

    try:
        with open(TEMPLATE_PATH) as f:
            lines = [f.read().rstrip()]
    except OSError:
        lines = ["[global]"]

    lines.append(f"domainNumber\t\t{desired['domainNumber']}")
    lines.append(f"priority1\t\t{desired['priority1']}")
    lines.append(f"priority2\t\t{desired['priority2']}")
    lines.append(f"logAnnounceInterval\t{desired['logAnnounceInterval']}")
    lines.append(f"logSyncInterval\t\t{desired['logSyncInterval']}")
    lines.append(f"logMinDelayReqInterval\t{desired['logMinDelayReqInterval']}")

    # Hardware is parsed, not assumed: if the enabled ports don't share a
    # common PHC (e.g. an i225 port + a ConnectX-3 SFP+ port), ptp4l needs
    # boundary_clock_jbod to manage each port's clock independently.
    phcs = {iface["phc_index"] for _, _, iface in enabled if iface["phc_index"] is not None}
    if len(phcs) > 1:
        lines.append("boundary_clock_jbod\t1")

    for name, cfg, iface in enabled:
        lines.append(f"\n[{name}]")
        if iface["phc_index"] is not None:
            lines.append("time_stamping\t\thardware")
        else:
            lines.append("time_stamping\t\tsoftware")
        if cfg.get("role") == "downstream":
            lines.append("masterOnly\t\t1")

    return "\n".join(lines) + "\n"


def apply_config(desired, interfaces, state):
    conf = render_ptp4l_conf(desired, interfaces)
    if conf == state.get("last_conf"):
        return
    state["last_conf"] = conf

    error = None
    if conf is None:
        run(["systemctl", "stop", "ptp4l"])
        run(["systemctl", "disable", "ptp4l"])
    else:
        os.makedirs(os.path.dirname(PTP4L_CONF_PATH), exist_ok=True)
        with open(PTP4L_CONF_PATH, "w") as f:
            f.write(conf)
        run(["systemctl", "enable", "ptp4l"])
        run(["systemctl", "restart", "ptp4l"], timeout=15)
        _, active, _ = run(["systemctl", "is-active", "ptp4l"])
        if active.strip() != "active":
            _, journal, _ = run(["journalctl", "-u", "ptp4l", "-n", "20", "--no-pager"])
            error = journal

    state["error"] = error


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


def run_pmc(command):
    rc, out, _ = run(["pmc", "-u", "-b", "0", command], timeout=5)
    if rc != 0:
        return None
    return parse_pmc_output(out)


def query_ptp_status(desired, interfaces, state):
    _, active, _ = run(["systemctl", "is-active", "ptp4l"])
    result = {
        "ptp4l_running": active.strip() == "active",
        "is_grandmaster": None,
        "gm_present": None,
        "gm_identity": None,
        "clock_identity": None,
        "steps_removed": None,
        "master_offset_ns": None,
        "port_states": {},
        "error": state.get("error"),
    }
    if not result["ptp4l_running"]:
        return result

    dds = run_pmc("GET DEFAULT_DATA_SET")
    if dds:
        result["clock_identity"] = dds[0].get("clockIdentity")

    cds = run_pmc("GET CURRENT_DATA_SET")
    if cds:
        try:
            result["steps_removed"] = int(cds[0].get("stepsRemoved"))
            result["is_grandmaster"] = result["steps_removed"] == 0
        except (TypeError, ValueError):
            pass

    tsn = run_pmc("GET TIME_STATUS_NP")
    if tsn:
        result["gm_present"] = tsn[0].get("gmPresent") == "true"
        result["gm_identity"] = tsn[0].get("gmIdentity")
        try:
            result["master_offset_ns"] = int(tsn[0].get("master_offset"))
        except (TypeError, ValueError):
            pass

    enabled = get_enabled_interfaces(desired, interfaces)
    pds = run_pmc("GET PORT_DATA_SET")
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


def reconcile_phc2sys(desired, interfaces, ptp_status, state):
    """Sync the host's system clock to the uplink's PHC once we're a slave."""
    by_name = {i["name"]: i for i in interfaces}
    uplink = None
    for name, cfg in desired["interfaces"].items():
        if cfg.get("enabled") and cfg.get("role") == "uplink":
            uplink = name
            break

    want_phc = None
    steps = ptp_status.get("steps_removed")
    if uplink and steps is not None and steps > 0:
        iface = by_name.get(uplink)
        if iface and iface["phc_index"] is not None:
            want_phc = f"/dev/ptp{iface['phc_index']}"

    if want_phc != state.get("phc2sys_target"):
        proc = state.get("phc2sys_proc")
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if want_phc:
            state["phc2sys_proc"] = subprocess.Popen(
                ["phc2sys", "-s", want_phc, "-c", "CLOCK_REALTIME", "-O", "0", "-m"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        else:
            state["phc2sys_proc"] = None
        state["phc2sys_target"] = want_phc

    proc = state.get("phc2sys_proc")
    return proc is not None and proc.poll() is None


def build_status(desired, interfaces, ptp_status, phc2sys_active):
    iface_list = []
    for i in interfaces:
        cfg = desired["interfaces"].get(i["name"], {"enabled": False, "role": "downstream"})
        iface_list.append({
            "name": i["name"],
            "mac": i["mac"],
            "driver": i["driver"],
            "link": i["link"],
            "speed_mbps": i["speed_mbps"],
            "phc_index": i["phc_index"],
            "enabled": bool(cfg.get("enabled")),
            "role": cfg.get("role", "downstream"),
            "port_state": ptp_status["port_states"].get(i["name"]),
        })

    return {
        "updated": int(time.time()),
        "ptp4l_running": ptp_status["ptp4l_running"],
        "clock_identity": ptp_status["clock_identity"],
        "is_grandmaster": ptp_status["is_grandmaster"],
        "gm_present": ptp_status["gm_present"],
        "gm_identity": ptp_status["gm_identity"],
        "steps_removed": ptp_status["steps_removed"],
        "master_offset_ns": ptp_status["master_offset_ns"],
        "phc2sys_active": phc2sys_active,
        "error": ptp_status["error"],
        "interfaces": iface_list,
        "config": {k: desired[k] for k in (
            "domainNumber", "priority1", "priority2",
            "logAnnounceInterval", "logSyncInterval", "logMinDelayReqInterval",
        )},
    }


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("CREATE TABLE IF NOT EXISTS offset_history ("
                  "ts INTEGER NOT NULL, offset_ns INTEGER, gm_present INTEGER)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_offset_history_ts ON offset_history(ts)")
    conn.commit()
    return conn


def record_sample(conn, offset_ns, gm_present):
    now = int(time.time())
    conn.execute("INSERT INTO offset_history (ts, offset_ns, gm_present) VALUES (?, ?, ?)",
                  (now, offset_ns, 1 if gm_present else 0))
    conn.execute("DELETE FROM offset_history WHERE ts < ?", (now - HISTORY_RETENTION_HOURS * 3600,))
    conn.commit()


def fetch_history(conn, minutes):
    cutoff = int(time.time()) - minutes * 60
    cur = conn.execute("SELECT ts, offset_ns FROM offset_history WHERE ts >= ? ORDER BY ts", (cutoff,))
    return [{"ts": row[0], "offset_ns": row[1]} for row in cur.fetchall()]


def poll_loop():
    state = {}
    conn = init_db()
    STATE["db"] = conn
    while True:
        try:
            interfaces = discover_interfaces()
            desired = load_desired()

            apply_config(desired, interfaces, state)
            ptp_status = query_ptp_status(desired, interfaces, state)
            phc2sys_active = reconcile_phc2sys(desired, interfaces, ptp_status, state)
            status = build_status(desired, interfaces, ptp_status, phc2sys_active)

            with STATE_LOCK:
                STATE["status"] = status
                STATE["desired"] = desired
                STATE["interfaces"] = interfaces

            if ptp_status["master_offset_ns"] is not None:
                record_sample(conn, ptp_status["master_offset_ns"], ptp_status["gm_present"])
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
            try:
                minutes = int(qs.get("minutes", ["60"])[0])
            except ValueError:
                minutes = 60
            minutes = max(1, min(minutes, HISTORY_RETENTION_HOURS * 60))
            with STATE_LOCK:
                conn = STATE["db"]
            self._send_json(200, fetch_history(conn, minutes))
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
