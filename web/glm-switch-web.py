#!/usr/bin/env python3
"""glm-switch-web: a small web page on the head Spark to watch the GLM-5.3 cluster and switch its weights.

Switching runs ~/bin/glm-switch, so the page and the command behave the same. A sampler thread gathers the
telemetry in the background, so a page load never waits on ssh.
  GET  /             the page
  GET  /api/status   state, live numbers, each Spark, downloads, the last switch's log (JSON, for other tools too)
  POST /api/switch   {"target": "normal" | "ablit", "force": false}
  POST /api/restart  {"force": false}      restart the model on the weights it serves now
  POST /api/drop     {"peer": "ip:port" | "all"}   close a client's connection; the server cancels its request
  POST /api/diag     {}                    save a diagnostics bundle; GET /diag/<name>.tar.gz downloads it
Stdlib only. Port 8891 (GLM_SWITCH_PORT).
"""
import fcntl
import json
import os
import re
import subprocess
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
TOOL = os.path.join(HOME, "bin", "glm-switch")
LOG = os.path.join(HOME, "glm-switch.log")  # glm-switch writes it itself (CLI or page)
PIDFILE = "/tmp/glm-switch.pid"
PREP_LOG = os.path.join(HOME, "ablit-prepare.log")
DIAG_DIR = os.path.join(HOME, "glm-diag")
STUCK_S = 120  # a request waiting this long with no reply is flagged on the page


def _config(path):
    """KEY=value lines (bash-quoted values allowed), the same file glm-switch sources."""
    conf = {}
    try:
        for line in open(path):
            k, sep, v = line.strip().partition("=")
            if sep and not k.startswith("#"):
                conf[k.strip()] = v.split(" #")[0].strip().strip("'\"")
    except OSError:
        pass
    return conf


CONF = _config(os.environ.get("GLM_SWITCH_CONF", os.path.join(HOME, ".config", "glm-switch", "config.env")))
PORT = int(CONF.get("WEB_PORT", "8891"))
API = CONF.get("API_URL", "http://127.0.0.1:8888")
# NODES: "name|ssh target or local|role" entries separated by ";" -- the head first, as "local"
NODES = [(n, None if t == "local" else t, r) for n, t, r in
         (e.strip().split("|") for e in CONF.get("NODES", "head|local|head").split(";") if e.strip())]
ABLIT_DIR = ".cache/huggingface/hub/models--Mia-AiLab--GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit"
ABLIT_GB = 176  # the Ablit checkpoint on disk (du -sbL), checked 2026-10-22

# the names this page may be reached by (a DNS-rebinding page would send its own); port stripped
ALLOWED_HOSTS = {"127.0.0.1", "localhost", *CONF.get("WEB_HOSTS", "").split()}
LOCK = "/tmp/glm-switch.lock"
_child = {"proc": None}
_lock = threading.Lock()
_cache = {}
_rate = {"t": None, "tokens": None, "tps": 0.0}
_since = {"state": None, "t": None}
_wake = threading.Event()  # set when the cached state is stale: the sampler re-reads at once
_diag = {"running": False, "file": None, "error": None, "finished": None}


def sh(cmd, timeout=20):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip()
    except (subprocess.TimeoutExpired, OSError):
        return 1, ""


def on(node, cmd, timeout=15):
    """Run a shell command on a node (locally for the head)."""
    target = node[1]
    if target is None:
        return sh(["bash", "-c", cmd], timeout)
    return sh(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, cmd], timeout)


def kv(text):
    out = {}
    for line in text.splitlines():
        k, sep, v = line.partition(":")
        if sep:
            out[k.strip()] = v.strip()
    return out


def switching():
    """A switch is running (started here or from the command line): glm-switch's pid file names a live glm-switch."""
    try:
        pid = int(open(PIDFILE).read().strip())
        return b"glm-switch" in open(f"/proc/{pid}/cmdline", "rb").read()
    except (OSError, ValueError):
        return False


def health():
    try:
        with urllib.request.urlopen(API + "/health", timeout=4) as r:
            return json.load(r)
    except (OSError, ValueError):
        return None


def node_info(node):
    # one line each: the model container's status, uptime in seconds, MemAvailable in kB, cable ports with a link
    # (of the 2 physical ports), then the GPU's csv line last
    rc, out = on(node, "echo \"C:$(docker ps --filter name=glm53-flash-tf --format '{{.Status}}')\"; "
                       "echo \"U:$(cut -d. -f1 /proc/uptime)\"; "
                       "echo \"M:$(awk '/MemAvailable/{print $2}' /proc/meminfo)\"; "
                       "echo \"L:$(cat /sys/class/net/enp1s0f0np0/carrier /sys/class/net/enp1s0f1np1/carrier 2>/dev/null | grep -c 1)\"; "
                       "nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,clocks.sm --format=csv,noheader,nounits")
    if rc != 0 and not out:
        return {"name": node[0], "role": node[2], "reachable": False}
    lines = out.splitlines()
    tag = {l[0]: l[2:] for l in lines if len(l) > 1 and l[1] == ":"}
    gpu = lines[-1].split(", ") if lines and "," in lines[-1] else []
    num = lambda k: int(tag[k]) if tag.get(k, "").isdigit() else None
    return {"name": node[0], "role": node[2], "reachable": True,
            "model": tag.get("C") or "not running",
            "uptime_s": num("U"), "mem_free_gib": round(num("M") / 2**20, 1) if num("M") else None,
            "cables_up": num("L"),
            "gpu_pct": gpu[0] if len(gpu) > 0 else None, "temp_c": gpu[1] if len(gpu) > 1 else None,
            "clock_mhz": gpu[2] if len(gpu) > 2 else None}


def downloads():
    rc, _ = sh(["pgrep", "-f", "scripts/prepare.sh"])
    if rc != 0:
        return None
    tail = ""
    try:
        with open(PREP_LOG, errors="ignore") as f:
            f.seek(max(0, os.path.getsize(PREP_LOG) - 4000))
            tail = f.read()
    except OSError:
        pass
    lines = [l for l in re.split(r"[\r\n]", tail) if l.strip() and "it/s" not in l]
    copying = any("worker" in l.lower() and ("copy" in l.lower() or "rsync" in l.lower()) for l in lines[-3:])
    sizes = {}
    with ThreadPoolExecutor(3) as ex:
        for node, (rc, out) in zip(NODES, ex.map(lambda n: on(n, f"du -sbL {ABLIT_DIR} 2>/dev/null | cut -f1"), NODES)):
            sizes[node[0]] = round(int(out) / 1e9, 1) if out.isdigit() else 0.0
    return {"what": "Ablit weights", "total_gb": ABLIT_GB, "gb": sizes,
            "phase": "copying to the workers" if copying or sizes[NODES[0][0]] >= ABLIT_GB - 1 else "downloading to the head",
            "last_line": lines[-1][-200:] if lines else ""}


def connections():
    """The model server's clients, from `glm-switch conns`: who, streaming / waiting / idle, seconds since the request."""
    names = dict(e.split("=", 1) for e in CONF.get("CLIENTS", "").split() if "=" in e)
    out = []
    for line in sh([TOOL, "conns", "--tsv"], 20)[1].splitlines():
        f = line.split("\t")
        if len(f) == 4 and f[2].isdigit() and f[3].isdigit():
            ip = f[0].rsplit(":", 1)[0]
            out.append({"peer": f[0], "client": names.get(ip, ip), "state": f[1], "seconds": int(f[2]),
                        "bytes_sent": int(f[3]), "stuck": f[1] == "waiting" and int(f[2]) >= STUCK_S})
    order = {"waiting": 0, "streaming": 1, "idle": 2}
    return sorted(out, key=lambda c: (order.get(c["state"], 3), -c["seconds"]))


def systemd(unit, prop):
    return sh(["systemctl", "show", "-p", prop, "--value", unit])[1]


def sample_forever():
    weights, weights_t, nodes, nodes_t = {}, 0.0, [], 0.0
    while True:
        try:
            now = time.time()
            st = kv(sh([TOOL, "status"], 60)[1])
            if now - weights_t > 60 or not weights:
                weights, weights_t = kv(sh([TOOL, "weights"], 60)[1]), now
            h = health()
            svc = systemd("glm53", "ActiveState")
            sub = systemd("glm53", "SubState")
            if h and h.get("ok"):
                tok = h.get("completion_tokens_total", 0)
                if _rate["tokens"] is not None and tok >= _rate["tokens"] and now > _rate["t"]:
                    _rate["tps"] = (tok - _rate["tokens"]) / (now - _rate["t"])
                else:
                    _rate["tps"] = 0.0  # first reading, or the counter restarted with the server
                _rate.update(t=now, tokens=tok)
            else:
                _rate.update(t=None, tokens=None, tps=0.0)
            # a crashed start sits in auto-restart (systemd shows it as activating) until its next try
            if switching():
                state = "switching"
            elif h and h.get("ok"):
                state = "up"
            elif sub == "auto-restart" or svc == "failed":
                state = "failed"
            elif svc in ("activating", "active", "reloading"):
                state = "starting"
            else:
                state = "down"
            if state != _since["state"]:
                if _since["state"] is None:  # first reading: count from systemd's last state change
                    try:
                        mono = int(systemd("glm53", "StateChangeTimestampMonotonic")) / 1e6
                        _since["t"] = now - (time.monotonic() - mono) if mono else now
                    except ValueError:
                        _since["t"] = now
                else:
                    _since["t"] = now
                _since["state"] = state
            secs = int(now - _since["t"])
            if now - nodes_t > 15 or not nodes or state != "up":
                with ThreadPoolExecutor(3) as ex:
                    nodes = list(ex.map(node_info, NODES))
                nodes_t = now
            streams = (h or {}).get("streams", {})
            _cache.update({
                "state": state, "state_seconds": secs, "service": svc,
                "serving": st.get("serving", "unknown"), "configured": st.get("configured", "unknown"),
                "weights": weights, "switching": switching(),
                "live": None if not (h and h.get("ok")) else {
                    "tokens_per_s": round(_rate["tps"], 1),
                    "requests_running": h.get("requests_running", 0),
                    "decoding": streams.get("decoding", 0), "prefilling": streams.get("prefilling", 0),
                    "max_at_once": streams.get("max"),
                    "requests_served": h.get("requests_total", 0),
                    "tokens_generated": h.get("completion_tokens_total", 0),
                    "pool_free_pct": round(100 * h.get("pool_free_tokens", 0) / max(1, h.get("pool_tokens", 1))),
                },
                "nodes": nodes, "download": downloads(), "updated": int(now), "error": None,
                "connections": connections() if h and h.get("ok") else [], "stuck_after_s": STUCK_S,
            })
        except Exception as e:  # keep sampling; show the error instead of a stale page
            _cache["error"] = str(e)
        _wake.wait(3 if switching() else 5)
        _wake.clear()


def status():
    out = dict(_cache)
    try:
        with open(LOG) as f:
            out["log"] = f.read()[-4000:]
    except OSError:
        out["log"] = ""
    out["switching"] = switching()
    out["now"] = time.time()  # the page times the switch against this clock, not the viewer's
    if not out["switching"] and out.get("state") == "switching":
        _wake.set()  # the switch just ended; the next reading (within a second) has the real state
    if out["switching"]:
        out["state"] = "switching"
        try:  # glm-switch writes its pid file once it holds the lock: the moment the switch began
            out["switch_started"] = os.path.getmtime(PIDFILE)
        except OSError:
            out["switch_started"] = None
    # the last finished switch: "... DONE: serving ablit, took 187s" or "... ROLLED BACK: serving normal, took 402s"
    # or "... RESTARTED: serving ablit, took 130s"; the log's first line names the action (normal, ablit, restart)
    m = re.search(r"(DONE|ROLLED BACK|RESTARTED): serving (\w+), took (\d+)s", out.get("log", ""))
    out["last_switch"] = {"result": m.group(1).lower(), "serving": m.group(2), "seconds": int(m.group(3)),
                          "finished": os.path.getmtime(LOG)} if m and not out["switching"] else None
    a = re.match(r"\S+ \S+ glm-switch (\w+)", out.get("log", ""))
    out["action"] = a.group(1) if a else None
    out["diag"] = dict(_diag)
    return out


def start_switch(target, force):
    """target: normal, ablit or restart (the same lock, log and refusals)."""
    with _lock:
        try:  # glm-switch's own lock (flock(1) and fcntl.flock are the same lock): free, or a switch is running
            with open(LOCK, "a") as f:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False, "a switch or restart is already running"
        # detached, so a restart of this page leaves it running; it writes its own log once it holds the lock.
        # stderr carries only what it says before that (or a refusal), read below
        p = subprocess.Popen([TOOL, target] + (["--force"] if force else []), stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, start_new_session=True)
        _child["proc"] = p
        try:
            err = p.communicate(timeout=3)[1]  # a refusal (busy, weights, prepare running) ends at once
        except subprocess.TimeoutExpired:
            return True, "started"
        if p.returncode == 0:
            return True, "nothing to do: already serving " + target
        msg = (err or "").strip()
        if not msg:  # refused after taking the lock: the reason is the log's last line
            try:
                msg = open(LOG).read().strip().splitlines()[-1]
            except (OSError, IndexError):
                msg = "the switch stopped (exit %d)" % p.returncode
        return False, msg.replace("glm-switch: ", "")


def drop(peer):
    if peer != "all" and not re.fullmatch(r"[0-9.]+:[0-9]+", peer or ""):
        return False, "peer must be ip:port or all"
    try:
        r = subprocess.run([TOOL, "drop", peer], capture_output=True, text=True, timeout=330)
        ok, msg = r.returncode == 0, (r.stdout or r.stderr).strip().replace("glm-switch: ", "")
    except (subprocess.TimeoutExpired, OSError):
        ok, msg = False, ""
    _wake.set()
    return ok, msg or "the drop failed"


def run_diag():
    def work():
        rc, out = sh([TOOL, "diag"], 300)
        name = os.path.basename(out.splitlines()[-1]) if rc == 0 and out else None
        _diag.update(running=False, file=name, error=None if name else "the bundle failed", finished=time.time())
    with _lock:
        if _diag["running"]:
            return False, "already collecting"
        _diag.update(running=True, error=None)
    threading.Thread(target=work, daemon=True).start()
    return True, "started"


class Handler(BaseHTTPRequestHandler):
    def _host_ok(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in ALLOWED_HOSTS

    def _send(self, code, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")  # read-only status for dashboards elsewhere
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._host_ok():
            return self._send(421, '{"error": "unknown host"}')
        if self.path == "/":
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "glm-switch-web.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif self.path == "/api/status":
            self._send(200, json.dumps(status()))
        elif re.fullmatch(r"/diag/diag-\d{8}-\d{6}\.tar\.gz", self.path):
            try:
                with open(os.path.join(DIAG_DIR, self.path.rsplit("/", 1)[1]), "rb") as f:
                    self._send(200, f.read(), "application/gzip")
            except OSError:
                self._send(404, '{"error": "no such bundle"}')
        else:
            self._send(404, '{"error": "not found"}')

    def do_POST(self):
        if not self._host_ok():
            return self._send(421, '{"error": "unknown host"}')
        if self.path not in ("/api/switch", "/api/restart", "/api/drop", "/api/diag"):
            return self._send(404, '{"error": "not found"}')
        # a custom header and JSON: another site's page cannot send either without a CORS preflight, never granted here
        if self.headers.get("X-GLM-Switch") != "1":
            return self._send(403, '{"error": "send the X-GLM-Switch: 1 header"}')
        # JSON only: a form on another site cannot send it without a CORS preflight, which this server never grants
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return self._send(415, '{"error": "send application/json"}')
        try:
            n = int(self.headers.get("Content-Length", 0))
            if not 0 <= n <= 4096:
                raise ValueError
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._send(400, '{"error": "bad json"}')
        if self.path == "/api/drop":
            ok, msg = drop(body.get("peer"))
        elif self.path == "/api/diag":
            ok, msg = run_diag()
        elif self.path == "/api/restart":
            ok, msg = start_switch("restart", bool(body.get("force")))
        else:
            target = body.get("target")
            if target not in ("normal", "ablit"):
                return self._send(400, '{"error": "target must be normal or ablit"}')
            ok, msg = start_switch(target, bool(body.get("force")))
        self._send(200 if ok else 409, json.dumps({"ok": ok, "message": msg}))

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    threading.Thread(target=sample_forever, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
