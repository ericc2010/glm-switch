# glm-switch

Switch a [TensorFold GLM-5.3](https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold) cluster of
DGX Sparks between the **normal** weights and the **Ablit** weights (`ABLIT=0` / `ABLIT=1`), from a command or a web page,
and watch the cluster while it runs.

Both weights serve under the same model name, so clients (Atlas, Hermes, ...) need no change when you switch.

## What's in it

| Path | What it does |
|---|---|
| `bin/glm-switch` | The command: `status`, `weights`, `normal`, `ablit`, `restart`, `conns`, `drop`, `diag` |
| `web/glm-switch-web.py` + `.html` | The web page (port 8891): status, live numbers, every Spark, client connections, downloads, switch and unstick buttons, a timer |
| `systemd/glm-switch-web.service` | Runs the page at boot (the installer fills in the user and path) |
| `bin/rootsh` | Runs a command as root through docker, for Sparks where sudo has no password (see below) |
| `config.example.env` | The cluster's own values: copy it to `~/.config/glm-switch/config.env` |
| `install.sh` | Installs or updates everything on the head Spark |

## Install (on the head Spark)

1. `git clone` this repo on the head, then run `./install.sh`. The first run copies the example config and stops.
2. Fill in `~/.config/glm-switch/config.env`: the workers' ssh targets, the page's addresses and the Sparks' names.
3. Run `./install.sh` again. Then open `http://<head>:8891/`.

Requirements:
- The glm53 systemd service runs the recipe (`start.sh` or `start-tp3.sh`).
- The head can ssh to every worker with a key.
- Root through `sudo -n`, or `ROOT_CMD=$HOME/bin/rootsh` (copy `bin/rootsh` there) when the user is in the docker group.
- For Ablit: `HF_TOKEN=` in the recipe's `.env`, and the weights on every Spark (`ABLIT=1 TP=3 scripts/prepare.sh`).

## Using it

**The page:** press **Switch to Normal** or **Switch to Ablit** and confirm. A stopwatch, a progress bar and the current
step show until the model answers again (usually 3–4 minutes).

**The command:**

```
glm-switch status            # which weights are serving, and whether the cluster is up
glm-switch weights           # which weights are complete on every Spark
glm-switch ablit             # switch to Ablit (refuses while requests run)
glm-switch normal --force    # switch even if requests are running (they are cut off)
glm-switch conns             # the clients connected to the model: streaming, waiting for a reply, or idle
glm-switch drop 10.2.2.16:59466   # close one client's connection: the server cancels that request only
glm-switch drop all          # free every slot without reloading the model
glm-switch restart --force   # reload the weights now serving (2–3 min, every request is cut off)
glm-switch diag              # save metrics, connections and every Spark's logs to ~/glm-diag/diag-<time>.tar.gz
```

## When a request is stuck

The page's **Requests** card lists every client connection. *Waiting for reply* means the request is in its prompt
(prefill) or queued; one waiting over 2 minutes is flagged. The **Unstick** card goes from least to most disruptive:

1. **Drop** (one request) or **Drop all**: closes the connection(s) from the head (`ss -K`, as root). TensorFold checks
   between prompt chunks and decode rounds whether the client is still there, so it cancels the request within a few
   seconds and frees the slot; other requests keep going. The client sees a connection error and may retry.
2. **Restart model**: if a dropped request still counts as running after about 30 s, the server is stuck somewhere it
   doesn't check for cancels (a collective between the Sparks, for example). This restarts glm53 on the same weights and
   sends a test question, like a switch without the change.
3. **Capture diagnostics** (any time, best while it's stuck): two metrics readings 5 s apart, the connections, the
   glm53 journal, and from every Spark the GPU, ring link counters, `dmesg` and the model log. The last 20 bundles are kept.

A waiting request is inferred: the server's running count minus the connections streaming a reply. A very long prompt
also waits for minutes (about 2.5k prompt tokens/s on 3 Sparks, less while others decode).

**For other tools:** `GET /api/status` returns everything as JSON. `state` is one of `up`, `starting`, `switching`,
`down` or `failed`.

## What a switch does

1. Refuses if another switch is running, a download is running (`prepare.sh`), requests are running (unless `--force`),
   or the target weights aren't complete at the pinned revision on every Spark.
2. Sets `ABLIT=` in the recipe's `.env` (keeping `HF_TOKEN`), and refuses if `local.sh` or the environment overrides it.
3. Restarts glm53 and waits until it answers. A crashed start is caught within about 10 seconds.
4. Checks that the container really loaded the target weights, and sends one test question.
5. If anything fails, it goes back to the weights that were serving before.

It logs to `~/glm-switch.log` and holds `/tmp/glm-switch.lock`. It ignores a closed ssh session, so a switch never stops
halfway.

## Safety

- The page accepts only the host names in `WEB_HOSTS`, which blocks DNS rebinding.
- A switch needs the `X-GLM-Switch: 1` header and a JSON body, so another website can't trigger one.
- There is **no password**. Anyone who can reach the page can switch, as with the model's own API. Keep it on your LAN or
  tailnet.
- `bin/rootsh` gives root to anyone in the docker group. Docker's group already means that; the script only makes it
  convenient.

Add to the glm53 unit: `SuccessExitStatus=130`. The recipe's `start.sh` exits 130 on a clean stop, which systemd would
otherwise count as a failure.
