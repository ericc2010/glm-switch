#!/usr/bin/env python3
"""glm-switch-web: a small web page on the head Spark to watch the GLM-5.3 cluster and switch its weights.

Switching runs ~/bin/glm-switch, so the page and the command behave the same. Two sampler threads gather the
telemetry in the background, so a page load never waits on ssh: a fast one reads /health and the cable counters every
second (the meters are means over the last few seconds), a slow one does the rest (ssh, ss, glm-switch) every 5 s.
  GET  /             the page (the Spark Performance Dyno design); /classic is the plain page it replaced
  GET  /static/...   the page's stylesheet, script, fonts and gauge component (web/static)
  GET  /api/status   state, live numbers, all-time totals, each Spark, downloads, the last switch's log (JSON, for other tools too)
  GET  /api/history  the last 10 minutes of tokens/s and cable MB/s, one sample a second
  POST /api/switch   {"target": "normal" | "ablit", "force": false}
  POST /api/restart  {"force": false}      restart the model on the weights it serves now
  POST /api/drop     {"peer": "ip:port" | "all"}   close a client's connection; the server cancels its request
  POST /api/diag     {}                    save a diagnostics bundle; GET /diag/<name>.tar.gz downloads it
Stdlib only. Port 8891 (GLM_SWITCH_PORT).
"""
import fcntl
import glob
import json
import os
import re
import subprocess
import threading
import time
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
TOOL = os.path.join(HOME, "bin", "glm-switch")
LOG = os.path.join(HOME, "glm-switch.log")  # glm-switch writes it itself (CLI or page)
PIDFILE = "/tmp/glm-switch.pid"
PREP_LOG = os.path.join(HOME, "ablit-prepare.log")
DIAG_DIR = os.path.join(HOME, "glm-diag")
STUCK_S = 120  # a request waiting this long with no reply is flagged on the page
HUNG_S = 900  # glm53 active this long with /health not answering: the server is up but not answering (not a start)
# The ring cables carry the engine's work between the Sparks (RDMA, so the kernel's Ethernet counters miss it): a
# prompt being read moves ~2.3 GB/s on 3 Sparks, one reply being written ~0.5 GB/s, an idle or stuck engine ~0.
CABLE_GLOB = "/sys/class/infiniband/*/ports/1/counters/port_xmit_data"  # 4-byte units
QUIET_MB_S = 50.0
STALL_S = 30  # streams held but the cables below what their work moves, this long: the engine is not progressing


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
PREFILL_MB_S = float(CONF.get("CABLE_PREFILL_MB_S", "1000"))  # below this with a prompt filling: it is not being read
LOCK = "/tmp/glm-switch.lock"
# The server's counters start over at every restart; this page keeps their sum across restarts here.
TOTALS = os.path.join(HOME, ".local", "state", "glm-switch", "totals.json")
TOTAL_KEYS = {"requests": "requests_total", "prompt_tokens": "prompt_tokens_total", "completion_tokens": "completion_tokens_total"}
_totals = {"since": None, "requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "last": None, "last_t": None,
           "peak_tps": 0.0, "peak_tps_t": None,  # peak: the fastest ~5 s window of reply tokens seen, all streams together
           "peak_since": None}  # when the peak was last reset by hand (None: never)
_child = {"proc": None}
_lock = threading.Lock()
_cache = {}
SMOOTH_S = 4  # tokens/s and the cable rate shown are means over about this many seconds of 1 s samples
PEAK_S = 5  # the all-time peak tokens/s is taken over this long, so a one-second blip cannot set it
_fast = {"t": None, "h": None, "tps": 0.0, "tps_peak_window": 0.0, "mb_s": None, "prog": None}  # the fast sampler's latest
_tok = deque(maxlen=PEAK_S + 3)  # (time, completion_tokens_total), one per second
_mb = deque(maxlen=SMOOTH_S)  # MB/s on the cables, one per second
HISTORY_S = 600
_hist = deque(maxlen=HISTORY_S)  # (time, tokens/s, cable MB/s or None), one per second, for the page's trace
WEBDIR = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(WEBDIR, "static")
MIME = {".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".ttf": "font/ttf",
        ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".json": "application/json", ".png": "image/png"}
_since = {"state": None, "t": None}
_orphan = {"n": 0, "since": None}  # requests held with no connection to drop, and since when (reported once it persists)
_cable = {"t": None, "bytes": None, "slow_since": None}
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
    """The model server's clients, from `glm-switch conns`: who, waiting / streaming / gone / idle, seconds since
    the request, bytes sent for it. Read even when /health hangs: the Drop buttons matter most then."""
    names = dict(e.split("=", 1) for e in CONF.get("CLIENTS", "").split() if "=" in e)
    out = []
    for line in sh([TOOL, "conns", "--tsv"], 20)[1].splitlines():
        f = line.split("\t")
        if len(f) == 4 and f[2].isdigit() and f[3].lstrip("-").isdigit():
            ip = f[0].rsplit(":", 1)[0]
            out.append({"peer": f[0], "client": names.get(ip, ip), "state": f[1], "seconds": int(f[2]),
                        "bytes_sent": max(0, int(f[3])), "stuck": f[1] == "waiting" and int(f[2]) >= STUCK_S})
    order = {"waiting": 0, "gone": 1, "paused": 2, "streaming": 3, "idle": 4}
    return sorted(out, key=lambda c: (order.get(c["state"], 5), -c["seconds"]))


def cable_sample(now):
    """MB/s sent on the ring cables since the last sample (None without counters, or on the first reading)."""
    try:
        b = 4 * sum(int(open(f).read()) for f in glob.glob(CABLE_GLOB)) if glob.glob(CABLE_GLOB) else None
    except (OSError, ValueError):
        b = None
    prev_b, prev_t = _cable["bytes"], _cable["t"]
    _cable.update(bytes=b, t=now)
    if b is None or prev_b is None or b < prev_b or now - prev_t <= 0:
        return None
    return (b - prev_b) / (now - prev_t) / 1e6


def engine_progress(filling, decoding, mb_s, now):
    """What the cables say the engine is doing: loading (a prompt is being read), decoding, quiet, or stalled (streams
    held but the cables below what their work moves, for STALL_S). None without cable counters."""
    if mb_s is None:
        _cable["slow_since"] = None
        return None
    need = PREFILL_MB_S if filling else QUIET_MB_S if decoding else 0.0
    slow = bool(filling or decoding) and mb_s < need
    _cable["slow_since"] = (_cable["slow_since"] or now) if slow else None
    stalled_s = int(now - _cable["slow_since"]) if slow else 0
    state = ("stalled" if stalled_s >= STALL_S else "loading" if filling else "decoding" if decoding else "quiet")
    return {"state": state, "mb_s": round(mb_s), "stalled_s": stalled_s, "filling": filling, "decoding": decoding}


def load_totals():
    try:
        with open(TOTALS) as f:
            d = json.load(f)
        _totals.update({k: d[k] for k in _totals if k in d})
    except (OSError, ValueError):
        pass


def add_totals(h, now):
    """Add what /health's counters gained since the last reading to the all-time totals, and save them. The counters
    start over when the model restarts: then the new run's whole count is added (what the old run did after the last
    reading, at most a few seconds' worth, is lost). A restart shows as fewer finished requests than before, or as a
    service start newer than the last reading. completion_tokens_total counts running replies too, so it can dip a
    little when a reply is cancelled: a dip without a restart adds nothing."""
    cur = {k: int(h.get(src) or 0) for k, src in TOTAL_KEYS.items()}
    last = _totals["last"]
    peak = _fast["tps_peak_window"] > _totals["peak_tps"]
    if peak:
        _totals.update(peak_tps=round(_fast["tps_peak_window"], 1), peak_tps_t=now)
    if last is None:  # first reading ever: the running server's count so far is the start
        _totals.update(cur, since=now)
    else:
        restarted = cur["requests"] < last["requests"] or _service_age() < now - (_totals["last_t"] or now)
        gained = {k: cur[k] if restarted else max(0, cur[k] - last[k]) for k in cur}
        if not any(gained.values()) and not peak:
            _totals.update(last=cur, last_t=now)  # a dip, or nothing new: no write
            return
        for k, v in gained.items():
            _totals[k] += v
    _totals.update(last=cur, last_t=now)
    save_totals()


def save_totals():
    try:
        os.makedirs(os.path.dirname(TOTALS), exist_ok=True)
        tmp = TOTALS + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_totals, f)
        os.replace(tmp, TOTALS)
    except OSError as e:
        _cache["error"] = "cannot save the all-time totals: %s" % e


TOTALS_SHOWN = ("since", "requests", "prompt_tokens", "completion_tokens", "peak_tps", "peak_tps_t", "peak_since")


def reset_peak():
    """Forget the recorded peak tokens/s so the next readings set a new one; the other totals stay."""
    now = time.time()
    _totals.update(peak_tps=0.0, peak_tps_t=None, peak_since=now)
    save_totals()
    with _lock:  # the page's next poll shows it at once, not after the slow sampler's next pass
        if "totals" in _cache:
            _cache["totals"] = {k: _totals[k] for k in TOTALS_SHOWN}
    return True, "peak reset"


def systemd(unit, prop):
    return sh(["systemctl", "show", "-p", prop, "--value", unit])[1]


def _service_age():
    """Seconds since glm53 last changed state (its start, when it is active)."""
    try:
        mono = int(systemd("glm53", "StateChangeTimestampMonotonic")) / 1e6
        return time.monotonic() - mono if mono else 0.0
    except ValueError:
        return 0.0


def _window_rate(samples, span, whole=False):
    """Per-second rate between the newest sample and the oldest one within span seconds of it. With whole, 0 unless
    the samples really cover the span (a peak must not come from a short window)."""
    if not samples:
        return 0.0
    t1, v1 = samples[-1]
    t0, v0 = next(((t, v) for t, v in samples if t1 - t <= span + 0.5), (t1, v1))
    if t1 <= t0 or (whole and t1 - t0 < span - 0.5):
        return 0.0
    return (v1 - v0) / (t1 - t0)


def live_numbers(h):
    """The Live card's figures, from the fast sampler's latest /health reading and its rolling means."""
    streams = h.get("streams", {})
    return {
        "tokens_per_s": round(_fast["tps"], 1),
        "requests_running": h.get("requests_running", 0),
        "requests_waiting": h.get("requests_waiting", 0),
        "decoding": streams.get("decoding", 0), "prefilling": streams.get("prefilling", 0),
        "max_at_once": streams.get("max"),
        "requests_served": h.get("requests_total", 0),
        "tokens_generated": h.get("completion_tokens_total", 0),
        "pool_free_pct": round(100 * h.get("pool_free_tokens", 0) / max(1, h.get("pool_tokens", 1))),
        "cable_mb_s": None if _fast["mb_s"] is None else round(_fast["mb_s"]),
        "progress": _fast["prog"], "smooth_s": SMOOTH_S,
    }


def sample_fast_forever():
    """Every second: /health (one GET to localhost) and the cable counters (four sysfs files). Keeps the last few
    seconds of both for the rolling means, and refreshes the Live figures in the cache while the model is up."""
    while True:
        now = time.time()
        try:
            h = health()
            ok = bool(h and h.get("ok"))
            tok = h.get("completion_tokens_total", 0) if ok else None
            if tok is None or (_tok and tok < _tok[-1][1]):
                _tok.clear()  # the server is down, or its counter started over with it
            if tok is not None:
                _tok.append((now, tok))
            mb = cable_sample(now)
            if mb is None:
                _mb.clear()
            else:
                _mb.append(mb)
            mb_s = sum(_mb) / len(_mb) if _mb else None
            streams = (h or {}).get("streams", {})
            prog = engine_progress(streams.get("filling", 0), streams.get("decoding", 0), mb_s, now) if ok else None
            _fast.update(t=now, h=h, tps=_window_rate(_tok, SMOOTH_S), tps_peak_window=_window_rate(_tok, PEAK_S, whole=True),
                         mb_s=mb_s, prog=prog)
            _hist.append((int(now), round(_fast["tps"], 1) if ok else None, None if mb_s is None else round(mb_s)))
            if ok and _cache.get("state") == "up" and _cache.get("live") is not None:
                _cache["live"] = live_numbers(h)
                _cache["updated"] = int(now)
        except Exception as e:
            _cache["error"] = str(e)
        time.sleep(max(0.2, 1.0 - (time.time() - now)))


def sample_forever():
    weights, weights_t, nodes, nodes_t = {}, 0.0, [], 0.0
    while True:
        try:
            now = time.time()
            st = kv(sh([TOOL, "status"], 60)[1])
            if now - weights_t > 60 or not weights:
                weights, weights_t = kv(sh([TOOL, "weights"], 60)[1]), now
            # the fast sampler's reading, unless it is stale (a hanging /health) or has not happened yet
            h = _fast["h"] if _fast["t"] and now - _fast["t"] < 5 else health()
            svc = systemd("glm53", "ActiveState")
            sub = systemd("glm53", "SubState")
            if h and h.get("ok"):
                add_totals(h, now)
            # a crashed start sits in auto-restart (systemd shows it as activating) until its next try
            if switching():
                state = "switching"
            elif h and h.get("ok"):
                state = "up"
            elif sub == "auto-restart" or svc == "failed":
                state = "failed"
            elif svc == "active" and _service_age() > HUNG_S:
                state = "unresponsive"  # long past any start: the process is there, the API is not
            elif svc in ("activating", "active", "reloading"):
                state = "starting"
            else:
                state = "down"
            if state != _since["state"]:
                if _since["state"] is None:  # first reading: count from systemd's last state change
                    _since["t"] = now - _service_age()
                else:
                    _since["t"] = now
                _since["state"] = state
            secs = int(now - _since["t"])
            if now - nodes_t > 15 or not nodes or state != "up":
                with ThreadPoolExecutor(3) as ex:
                    nodes = list(ex.map(node_info, NODES))
                nodes_t = now
            conns = connections() if svc == "active" else []
            # requests the server holds beyond the connections that could hold one (the client hung up, or it was sent
            # from the head). The count is read before and after the connection scan and the smaller taken, so a request
            # that finished in between is not an orphan; and it is reported only once it has lasted two readings.
            held = lambda hh: (hh.get("requests_running", 0) + hh.get("requests_waiting", 0)) if hh and hh.get("ok") else 0
            h2 = _fast["h"] if _fast["t"] and time.time() - _fast["t"] < 5 else h
            orphans = max(0, min(held(h), held(h2)) - sum(1 for c in conns if c["state"] != "idle"))
            if orphans and _orphan["n"]:
                _orphan["n"] = orphans
            else:
                _orphan.update(n=orphans, since=now if orphans else None)
            unmatched = orphans if _orphan["since"] and now - _orphan["since"] >= 5 else 0
            prog = _fast["prog"] if h and h.get("ok") else None
            for c in conns:  # the cables say whether a waiting request's prompt is being read, or nothing moves
                if c["state"] == "waiting" and prog and prog["state"] in ("stalled", "loading"):
                    c["note"] = prog["state"]
                    c["stuck"] = prog["state"] == "stalled"
            _cache.update({
                "state": state, "state_seconds": secs, "service": svc,
                "serving": st.get("serving", "unknown"), "configured": st.get("configured", "unknown"),
                "weights": weights, "switching": switching(),
                "live": live_numbers(h) if h and h.get("ok") else None,
                "totals": {k: _totals[k] for k in TOTALS_SHOWN},
                "nodes": nodes, "download": downloads(), "updated": int(now), "error": None,
                "connections": conns, "stuck_after_s": STUCK_S,
                "unmatched_requests": unmatched,
                "unmatched_for_s": int(now - _orphan["since"]) if unmatched else 0,
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
    try:  # the log's first line names the action (normal, ablit, restart); the tail above may have lost it
        with open(LOG) as f:
            a = re.match(r"\S+ \S+ glm-switch (\w+)", f.readline())
    except OSError:
        a = None
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

    def _send(self, code, body, ctype="application/json", public=False, cache=False):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-store")
        if public:
            self.send_header("Access-Control-Allow-Origin", "*")  # read-only status for dashboards elsewhere
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._host_ok():
            return self._send(421, '{"error": "unknown host"}')
        path = self.path.split("?", 1)[0]
        if path in ("/", "/classic"):
            with open(os.path.join(WEBDIR, "classic.html" if path == "/classic" else "glm-switch-web.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif path == "/api/status":
            self._send(200, json.dumps(status()), public=True)
        elif path == "/api/history":
            self._send(200, json.dumps({"seconds": HISTORY_S, "samples": list(_hist)}), public=True)
        elif path.startswith("/static/"):
            rel = os.path.normpath(path[len("/static/"):])
            full = os.path.join(STATIC, rel)
            ext = os.path.splitext(rel)[1].lower()
            if rel.startswith(("..", "/")) or ext not in MIME or not os.path.isfile(full):
                return self._send(404, '{"error": "not found"}')
            with open(full, "rb") as f:
                self._send(200, f.read(), MIME[ext], cache=True)
        elif re.fullmatch(r"/diag/diag-\d{8}-\d{6}\.tar\.gz", path):
            try:
                with open(os.path.join(DIAG_DIR, path.rsplit("/", 1)[1]), "rb") as f:
                    self._send(200, f.read(), "application/gzip")
            except OSError:
                self._send(404, '{"error": "no such bundle"}')
        else:
            self._send(404, '{"error": "not found"}')

    def do_POST(self):
        if not self._host_ok():
            return self._send(421, '{"error": "unknown host"}')
        if self.path not in ("/api/switch", "/api/restart", "/api/drop", "/api/diag", "/api/reset-peak"):
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
        if self.path == "/api/reset-peak":
            ok, msg = reset_peak()
        elif self.path == "/api/drop":
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
    load_totals()
    threading.Thread(target=sample_fast_forever, daemon=True).start()
    threading.Thread(target=sample_forever, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
