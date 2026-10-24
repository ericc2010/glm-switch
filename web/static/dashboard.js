/* The GLM cluster page: reads /api/status every 2 s and /api/history every 10 s, drives the Dyno gauges and cards,
 * and sends the switch, drop, restart and diagnostics actions to the same server. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const THEMES = ['carbon-lime', 'carbon-orange', 'midnight-ice', 'ivory-crimson'];
  const NAMES = { normal: 'Normal', ablit: 'Ablit', none: 'No model', unknown: 'Unknown' };
  const STATE = { up: 'Up', starting: 'Starting', switching: 'Switching', down: 'Down', failed: 'Failed', unresponsive: 'Not answering' };
  const TONE = { up: 'success', starting: 'warning', switching: 'warning', down: 'danger', failed: 'danger', unresponsive: 'danger' };
  const TYPICAL = { restart: 140, switch: 210 };  // a restart usually takes 2–2.5 min, a switch 3–4 min
  const WARN = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 3.2a1.7 1.7 0 0 1 3 0l6.1 10.9a1.7 1.7 0 0 1-1.5 2.5H3.9a1.7 1.7 0 0 1-1.5-2.5z"/><path d="M10 7v4.2"/><circle cx="10" cy="13.7" r=".65" fill="currentColor" stroke="none"/></svg>';
  const FILE = '<svg class="request-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 1h7l5 5v13H4z"/><path d="M11 1v6h5"/></svg>';

  let S = null;            // the last status
  let busy = false, timer = null, typical = TYPICAL.switch;
  let clock = { started: null, offset: 0 };  // offset: server clock minus this browser's clock
  let toastTimer = null, detailOpener = null, settingsOpener = null;
  const detailDialog = $('detail-dialog'), settingsDialog = $('settings-dialog');
  const recoveryMenu = $('recovery-menu'), recoveryButton = $('recovery-button');

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const valid = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const num = (v, d) => valid(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }) : '—';
  const unit = (v, suffix, d) => valid(v) ? num(v, d) + '<small>' + esc(suffix) + '</small>' : '—';
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function dur(s) {
    if (!valid(s)) return '—';
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
    return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`;
  }
  const upfor = s => valid(s) ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : '—';
  function compact(n) {  // 1,234 · 56 k · 73.9 M · 1.20 B, with the exact figure in the title
    if (!valid(n)) return '—';
    const f = n >= 1e9 ? [(n / 1e9).toFixed(2), 'B'] : n >= 1e6 ? [(n / 1e6).toFixed(1), 'M'] : n >= 1e4 ? [(n / 1e3).toFixed(0), 'k'] : [num(n), ''];
    return `<span title="${num(n)}">${f[0]}${f[1] ? '<span class="number-unit"> ' + f[1] + '</span>' : ''}</span>`;
  }

  // the two meters glide to each new reading over ~0.9 s instead of stepping
  const glide = {};
  function glideTo(id, v, apply) {
    if (v == null) { delete glide[id]; apply(null); return; }
    const g = glide[id] || (glide[id] = { cur: v });
    Object.assign(g, { from: g.cur, to: v, t0: performance.now(), apply, done: false });
  }
  setInterval(() => {
    const now = performance.now();
    for (const g of Object.values(glide)) {
      if (g.done) continue;
      const p = Math.min(1, (now - g.t0) / 900);
      g.cur = g.from + (g.to - g.from) * (1 - Math.pow(1 - p, 3));
      g.done = p >= 1;
      g.apply(g.cur);
    }
  }, 50);

  function notify(message, tone) {
    clearTimeout(toastTimer);
    $('toast').hidden = false;
    $('toast').className = 'toast' + (tone ? ' tone-' + tone : '');
    $('toast').textContent = message;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 7000);
  }
  function said(msg) {  // the last action's result, under the model profiles
    $('action-note').hidden = false;
    $('action-note').textContent = new Date().toLocaleTimeString() + ' · ' + msg;
  }

  /* ---------- rendering ---------- */
  function tick() {
    if (!clock.started) return;
    const el = Math.max(0, Date.now() / 1000 + clock.offset - clock.started);
    $('clock').textContent = mmss(el);
    $('tfill').style.width = Math.min(100, 100 * el / typical) + '%';
    $('tbar').className = 'bar' + (el > typical * 1.4 ? ' warn-fill' : '');
  }
  setInterval(tick, 1000);

  function stepOf(log) {  // the switch's current step, from its log
    const l = log.trim().split('\n').reverse();
    const has = re => l.find(x => re.test(x));
    if (has(/going back to/)) return 'The new model did not start — going back to the previous one';
    if (has(/up after/)) return 'Model is up — sending a test question';
    if (has(/starting it/)) return 'Loading the model on all three Sparks' + (has(/waiting\.\.\./) ? '' : '…');
    if (has(/stopping the cluster/)) return 'Stopping the current model';
    return 'Checking that everything is ready';
  }

  function renderHeader(s) {
    const restarting = s.switching && s.action === 'restart';
    const model = NAMES[s.serving] || s.serving;
    $('pill').textContent = restarting ? 'Restarting' : STATE[s.state] || s.state;
    $('pill').className = 'pill tone-' + (TONE[s.state] || 'muted');
    const nodes = s.nodes || [], online = nodes.filter(n => n.reachable).length;
    const tone = online === nodes.length && nodes.length ? 'success' : online ? 'warning' : 'danger';
    $('cluster-status').className = 'cluster-status status-tone-' + tone;
    $('cluster-status').querySelector('.status-text').textContent = `${online} / ${nodes.length || '—'} Sparks online`;
    const hero = {
      up: `<b>${model} model is answering</b> for ${dur(s.state_seconds)}`,
      starting: `<b>Loading the model on all three Sparks</b> for ${dur(s.state_seconds)} (usually 2–6 min)`,
      switching: restarting ? `<b>Restarting the ${model} model</b>` : `<b>Switching to ${NAMES[s.configured] || s.configured}</b>`,
      down: '<b>The model is stopped</b>',
      failed: '<b>The model failed to start</b>; it retries every minute (see the last switch log, or journalctl -u glm53)',
      unresponsive: `<b>The model process is running but its API is not answering</b> for ${dur(s.state_seconds)}: try Drop all, then Restart model`,
    }[s.state] || esc(s.state);
    $('hero').innerHTML = hero;
    $('source-strip').className = 'source-strip' + (TONE[s.state] === 'danger' ? ' is-bad' : TONE[s.state] === 'warning' ? ' is-alert' : '');
    const ls = s.last_switch;
    let right = '';
    if (ls && !s.switching) {
      const ago = Math.round((s.now - ls.finished) / 60);
      right = (ls.result === 'restarted' ? `last restart of ${NAMES[ls.serving] || ls.serving} took ${mmss(ls.seconds)}`
        : ls.result === 'done' ? `last switch to ${NAMES[ls.serving] || ls.serving} took ${mmss(ls.seconds)}`
        : `last switch failed, back on ${NAMES[ls.serving] || ls.serving} after ${mmss(ls.seconds)}`)
        + (ago < 1 ? ' · just now' : ago < 120 ? ` · ${ago} min ago` : '');
    }
    $('source-right').textContent = right.toUpperCase();
    document.body.className = 'data-' + s.state;
    document.title = `Dyno · ${restarting ? 'Restarting' : STATE[s.state] || s.state}` + (s.state === 'up' ? ` · ${model}` : '');

    // the switch timer strip
    if (s.switching && s.switch_started) {
      typical = restarting ? TYPICAL.restart : TYPICAL.switch;
      clock = { started: s.switch_started, offset: s.now - Date.now() / 1000 };
      $('switch-strip').hidden = false;
      $('step').textContent = stepOf(s.log || '') + ` · usually ${mmss(typical - 30)}–${mmss(typical + 30)}`;
      tick();
    } else {
      clock.started = null;
      $('switch-strip').hidden = true;
    }
    $('error-strip').hidden = !s.error;
    $('error-text').textContent = s.error ? 'Status error: ' + s.error : '';
    $('updated').textContent = s.updated ? 'updated ' + new Date(s.updated * 1000).toLocaleTimeString() : '';
  }

  function gaugeThroughput(v, peak) {
    $('throughput-gauge').innerHTML = DynoGauges.throughput({ value: v, peak, label: 'INFERENCE', unit: 'TOKENS / S', id: 'cluster-throughput', unavailable: v == null });
  }
  function renderGauges(s) {
    const L = s.live, T = s.totals || {};
    const peak = valid(T.peak_tps) ? T.peak_tps : null;
    glideTo('tps', L ? L.tokens_per_s : null, v => gaugeThroughput(v, peak));
    $('dial-source').textContent = L ? 'live · reply tokens of all streams together' : 'no current data';
    $('dial-dot').style.background = L ? '' : 'var(--text-muted)';
    $('dial-range').textContent = '0–' + Math.ceil(Math.max(200, L ? L.tokens_per_s : 0, peak || 0) / 50) * 50;
    const gpus = (s.nodes || []).filter(n => n.reachable && n.gpu_pct != null && !isNaN(n.gpu_pct)).map(n => Number(n.gpu_pct));
    const mean = gpus.length ? gpus.reduce((a, b) => a + b, 0) / gpus.length : null;
    $('gpu-gauge').innerHTML = DynoGauges.percent({ value: mean == null ? null : Math.round(mean), label: 'AVG GPU', id: 'average-gpu', unavailable: mean == null });
    $('gpu-coverage').textContent = `${gpus.length} / ${(s.nodes || []).length}`;
    $('memory-gauge').innerHTML = DynoGauges.percent({ value: L ? L.pool_free_pct : null, label: 'FREE', id: 'memory-pool-free', unavailable: !L });
    $('requests-value').textContent = L ? `${L.requests_running} / ${L.max_at_once}` : '— / —';
    $('requests-caption').textContent = L && L.requests_waiting ? `${L.requests_waiting} more queued` : "of the engine's lanes";
    const G = L && L.progress;
    glideTo('cable', L ? L.cable_mb_s : null, v => {
      $('interconnect-value').innerHTML = v == null ? '—' : v >= 1000 ? (v / 1000).toFixed(1) + ' <span class="unit">GB/s</span>' : Math.round(v) + ' <span class="unit">MB/s</span>';
    });
    const cap = $('interconnect-caption');
    cap.className = 'metric-caption' + (G ? G.state === 'stalled' ? ' tone-danger' : G.state === 'loading' ? ' tone-warning' : G.state === 'decoding' ? ' tone-success' : '' : '');
    cap.textContent = !G ? 'on the ring cables' : G.state === 'loading' ? 'a prompt is loading' : G.state === 'decoding' ? 'answering' : G.state === 'stalled' ? `nothing moving for ${G.stalled_s} s` : 'quiet';
  }

  function nodeStatus(n) {
    if (!n.reachable) return { label: 'Offline', cls: 'status-failed' };
    const running = (n.model || '').startsWith('Up');
    if (running && n.cables_up === 2) return { label: 'Running', cls: '' };
    if (running) return { label: 'Check cables', cls: 'status-stale' };
    return { label: 'Model not running', cls: 'status-unknown' };
  }
  function renderNodes(s) {
    const nodes = s.nodes || [];
    $('node-count').textContent = `(${nodes.length})`;
    $('nodes-grid').innerHTML = nodes.length ? nodes.map((n, i) => {
      const st = nodeStatus(n);
      const rank = (n.role.match(/rank (\d+)/) || [])[1] ?? '—';
      const head = /head/.test(n.role);
      const gpu = n.reachable && n.gpu_pct != null ? Number(n.gpu_pct) : null;
      const low = n.reachable && n.mem_free_gib != null && n.mem_free_gib < 4;
      return `<button class="node-card" type="button" data-node-index="${i}" aria-label="Details for ${esc(n.name)}">
        <div class="node-topline"><span class="rank-badge" aria-hidden="true">${esc(rank)}</span><div class="node-name"><h3 title="${esc(n.name)}">${esc(n.name)}</h3><span class="node-role">${head ? 'Head · ' : ''}Rank ${esc(rank)}</span></div>
        <div class="node-state"><span class="node-status ${st.cls}"><span class="status-dot" aria-hidden="true"></span>${st.label}</span><span class="node-uptime">${n.reachable ? 'UP ' + upfor(n.uptime_s) : 'NOT REACHABLE'}</span></div></div>
        <div class="node-metrics"><div class="node-metric"><span class="node-metric-label">GPU</span><strong class="node-metric-value">${gpu == null ? '—' : num(gpu) + '%'}</strong><div class="gpu-track" aria-hidden="true">${gpu == null ? '' : `<span style="width:${gpu}%"></span>`}</div></div>
        <div class="node-metric"><span class="node-metric-label">Temp</span><strong class="node-metric-value">${n.reachable ? unit(Number(n.temp_c), '°C') : '—'}</strong></div>
        <div class="node-metric"><span class="node-metric-label">Clock</span><strong class="node-metric-value">${n.reachable ? unit(Number(n.clock_mhz), ' MHz') : '—'}</strong></div></div>
        <div class="node-bottom"><div><span class="node-metric-label">Free memory</span><strong class="node-metric-value${low ? ' tone-danger' : ''}" title="${low ? 'under 4 GiB: little headroom for big prompts' : ''}">${n.reachable ? unit(n.mem_free_gib, ' GiB', 1) : '—'}</strong></div>
        <div><span class="node-metric-label">Cables</span><strong class="node-metric-value cables-value${n.reachable && n.cables_up !== 2 ? ' tone-danger' : ''}">${n.reachable ? num(n.cables_up) + ' / 2' : '—'}<span class="detail-arrow" aria-hidden="true">↗</span></strong></div></div></button>`;
    }).join('') : '<div class="empty-nodes"><h3>No Spark readings yet</h3><p>The first reading takes a few seconds.</p></div>';
  }

  const RSTATE = { streaming: ['Streaming', 'success'], waiting: ['Waiting for reply', 'warning'], paused: ['Reply paused', 'warning'], gone: ['Client gone', 'warning'], idle: ['Idle', 'muted'] };
  function renderRequests(s) {
    const C = s.connections || [];
    const held = C.filter(c => c.state !== 'idle').length;
    $('request-count').textContent = C.length ? `(${held} active · ${C.length} connected)` : '';
    $('request-list').innerHTML = C.length ? C.map(c => {
      let [label, tone] = RSTATE[c.state] || [c.state, 'muted'];
      if (c.note === 'loading') label += ' · prompt loading';
      else if (c.note === 'stalled') { label += ' · engine stalled'; tone = 'danger'; }
      else if (c.stuck) { label += ' · stuck?'; tone = 'danger'; }
      return `<div class="request-card${c.stuck ? ' is-stuck' : ''}"><div class="request-summary">${FILE}<div class="request-identity"><strong class="request-name" title="${esc(c.client)}">${esc(c.client)}</strong><span class="request-subtitle">${esc(c.peer)}</span></div><span class="request-chip tone-${tone}"><span class="status-dot" aria-hidden="true"></span>${esc(label)}</span></div>
        <dl class="request-metrics"><div><dt>Since request</dt><dd>${c.state === 'idle' ? '—' : dur(c.seconds)}</dd></div><div><dt>Sent to it</dt><dd>${num(c.bytes_sent)} B</dd></div>
        <div class="act"><button class="drop-button" type="button" data-peer="${esc(c.peer)}" ${s.switching ? 'disabled' : ''}>Drop</button></div></dl></div>`;
    }).join('') : '<div class="request-empty"><strong>No clients connected</strong><p>Requests appear here the moment a client connects; each one can be dropped on its own.</p></div>';
    const U = s.unmatched_requests || 0;
    $('unmatched-strip').hidden = !U;
    $('unmatched-text').innerHTML = `<strong>${U} request(s) running with no connection listed for ${dur(s.unmatched_for_s)}</strong> — the client hung up, or it was sent from the head itself. Drop all cannot reach it; if it never ends, restart the model.`;
    const G = s.live && s.live.progress;
    const stuck = C.filter(c => c.stuck);
    $('stall-strip').hidden = !stuck.length && !(G && G.state === 'stalled');
    if (G && G.state === 'stalled') $('stall-text').innerHTML = `<strong>The engine has moved nothing over the cables for ${dur(G.stalled_s)}</strong> with ${G.filling + G.decoding} stream(s) held: a real hang, not a long prompt. Drop the waiting request(s); if the count stays, restart the model.`;
    else if (stuck.length) $('stall-text').innerHTML = stuck.map(c => `<strong>${esc(c.client)}</strong> has waited ${dur(c.seconds)} with no reply`).join(' · ') + " — if that's not a very long prompt, drop it.";
  }

  function renderModels(s) {
    const W = s.weights || {};
    $('models-caption').textContent = s.switching ? 'switch in progress' : s.state === 'up' ? 'live' : STATE[s.state] || '';
    $('model-grid').innerHTML = ['normal', 'ablit'].map(m => {
      const ready = W[m] === 'ready', active = s.serving === m && s.state === 'up', ablit = m === 'ablit';
      const canSwitch = ready && !busy && !active;
      const action = active ? '<span class="model-action-caption">Current profile · answering</span>'
        : `<button type="button" class="model-switch ${ablit ? 'warning-switch' : ''}" data-model="${m}" ${canSwitch ? '' : 'disabled'} title="Switch to ${NAMES[m]}">${ablit ? WARN + '<span class="sr-only">Warning: </span>' : ''}<span class="model-switch-label">Switch to ${NAMES[m]}</span></button>`;
      return `<div class="model-card${active ? ' is-active' : ''}"><div class="model-title"><span class="model-selector" aria-hidden="true"></span><span class="model-name">${NAMES[m]}</span><span class="activity-badge">${active ? 'Active' : s.serving === m ? STATE[s.state] || s.state : 'Standby'}</span></div>
        <span class="model-readiness">${ready ? '<span class="ready-word">Ready</span> on all three Sparks' : '<span class="notready-word">Not ready</span> · weights incomplete'}</span>${action}</div>`;
    }).join('');
    $('menu-drop').disabled = s.switching || !(s.connections || []).length;
    $('menu-restart').disabled = !!s.switching;  // not during a start or a hang: a hang is what it is for
    const D = s.diag || {};
    $('diagnostics-button').disabled = !!D.running;
    $('diagnostics-label').textContent = D.running ? 'Collecting… (about 30 s)' : 'Capture diagnostics';
    $('diag-note').hidden = !(D.file || D.error);
    $('diag-note').innerHTML = D.error ? `<span style="color:var(--danger)">${esc(D.error)}</span>`
      : D.file ? `Last bundle: <a href="/diag/${esc(D.file)}" download>${esc(D.file)}</a> (also in ~/glm-diag on the head)` : '';
  }

  function renderTotals(s) {
    const T = s.totals || {}, L = s.live;
    const peakDate = T.peak_tps_t ? new Date(T.peak_tps_t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    const items = [
      [L ? num(L.requests_served) : '—', 'Requests since start'],
      [num(T.requests), 'Requests · all time'],
      [compact(T.prompt_tokens), 'Prompt tokens · all time'],
      [compact(T.completion_tokens), 'Generated tokens · all time'],
      [valid(T.peak_tps) && T.peak_tps > 0 ? num(T.peak_tps, 1) : '—', 'Recorded peak · tokens/s' + (peakDate ? ' · ' + peakDate : '')],
    ];
    $('totals-grid').innerHTML = items.map(i => `<div class="total"><strong>${i[0]}</strong><span>${esc(i[1])}</span></div>`).join('');
    $('totals-since').textContent = T.since ? 'all time since ' + new Date(T.since * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' · since start resets at each model restart' : '';
  }

  function renderLog(s) {
    $('log-section').hidden = !s.log;
    if (s.log) {
      $('log').textContent = s.log;
      $('log-caption').textContent = (s.action ? `glm-switch ${s.action}` : '') + (s.switching ? ' · running' : '');
    }
    const d = s.download;
    $('dl-strip').hidden = !d;
    if (d) $('dl').innerHTML = `<strong>${esc(d.what)}: ${esc(d.phase)}</strong>` + Object.entries(d.gb).map(([name, gb]) =>
      `<div class="dl-row"><span>${esc(name)}</span><span>${gb.toFixed(0)} / ${d.total_gb} GB</span></div><div class="bar"><div style="width:${Math.min(100, 100 * gb / d.total_gb).toFixed(1)}%"></div></div>`).join('');
  }

  function paint(s) {
    if (!s.state) { $('hero').textContent = s.error ? 'Status error: ' + s.error : 'Collecting the first reading…'; return; }
    S = s;
    busy = s.switching || s.state === 'starting';
    renderHeader(s); renderGauges(s); renderNodes(s); renderRequests(s); renderModels(s); renderTotals(s); renderLog(s);
  }

  async function refresh() {
    try { paint(await (await fetch('/api/status')).json()); }
    catch {
      $('pill').textContent = '?'; $('pill').className = 'pill tone-danger';
      $('hero').innerHTML = "<b>Can't reach the status service on the head Spark</b>";
      $('source-strip').className = 'source-strip is-bad';
    }
    clearTimeout(timer); timer = setTimeout(refresh, 2000);
  }

  /* the last ten minutes of tokens/s, one sample a second, from the server's own buffer */
  function drawHistory(h) {
    const pts = (h.samples || []).filter(p => p[1] != null);
    const svg = $('spark');
    if (pts.length < 2) { svg.innerHTML = ''; $('history-note').textContent = 'Collecting…'; $('history-samples').textContent = ''; return; }
    const t1 = h.samples[h.samples.length - 1][0], t0 = t1 - h.seconds;
    const max = Math.max(50, ...pts.map(p => p[1]));
    const x = t => 600 * (t - t0) / h.seconds, y = v => 50 - 46 * v / max;
    let d = '', prev = null;
    for (const p of h.samples) {  // a gap in the samples (health not answering) breaks the line
      if (p[1] == null) { prev = null; continue; }
      d += (prev && p[0] - prev <= 3 ? ' L ' : ' M ') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1);
      prev = p[0];
    }
    const area = pts.length ? `<path d="M ${x(pts[0][0]).toFixed(1)} 50 ${pts.map(p => 'L ' + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ')} L ${x(pts[pts.length - 1][0]).toFixed(1)} 50 Z" fill="var(--accent)" opacity=".08"/>` : '';
    svg.innerHTML = `<line x1="0" y1="50" x2="600" y2="50" stroke="var(--border)" stroke-width="1"/>${area}<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
    const mean = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    $('history-note').textContent = `peak ${Math.max(...pts.map(p => p[1])).toFixed(1)} · mean ${mean.toFixed(1)} tokens/s`;
    $('history-samples').textContent = pts.length < 90 ? `${pts.length} S OF DATA` : `${Math.round(pts.length / 60)} MIN OF DATA`;
  }
  async function history() {
    try { drawHistory(await (await fetch('/api/history')).json()); } catch { /* the next try is in 10 s */ }
    setTimeout(history, 10000);
  }

  /* ---------- dialogs and actions ---------- */
  function openDialog(c) {
    if (detailDialog.open) detailDialog.close();
    detailOpener = document.activeElement;
    $('dialog-eyebrow').textContent = c.eyebrow || 'Detail';
    $('dialog-eyebrow').className = 'eyebrow' + (c.tone ? ' tone-' + c.tone : '');
    $('dialog-title').textContent = c.title;
    $('dialog-description').innerHTML = c.description || '';
    $('dialog-body').innerHTML = c.body || '';
    $('dialog-actions').replaceChildren();
    (c.actions || [{ label: 'Close', kind: 'secondary', action: () => detailDialog.close() }]).forEach(item => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'button ' + (item.kind || 'secondary') + '-button';
      b.innerHTML = item.html || esc(item.label); b.addEventListener('click', item.action); $('dialog-actions').appendChild(b);
    });
    detailDialog.showModal();
  }
  const rows = items => '<dl class="detail-grid">' + items.map(i => `<div><dt>${esc(i[0])}</dt><dd>${esc(i[1])}</dd></div>`).join('') + '</dl>';
  function confirmDialog(c) {  // resolves true when the confirm button is pressed
    return new Promise(resolve => {
      let ok = false;
      openDialog(Object.assign({}, c, { actions: [
        { label: 'Cancel', kind: 'secondary', action: () => detailDialog.close() },
        { label: c.confirm, kind: c.kind || 'danger', action: () => { ok = true; detailDialog.close(); } },
      ] }));
      detailDialog.addEventListener('close', () => resolve(ok), { once: true });
    });
  }
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GLM-Switch': '1' }, body: JSON.stringify(body) });
    return r.json();
  }

  function showNode(i) {
    const n = (S && S.nodes || [])[i]; if (!n) return;
    const st = nodeStatus(n);
    openDialog({ eyebrow: n.role, title: n.name, description: n.reachable ? 'Read over ssh a few seconds ago.' : 'The head could not reach this Spark over the ring.',
      body: rows([['Status', st.label], ['Model container', n.model || '—'], ['GPU utilization', n.gpu_pct != null ? n.gpu_pct + '%' : '—'], ['Temperature', n.temp_c != null ? n.temp_c + ' °C' : '—'],
        ['Clock', n.clock_mhz != null ? num(Number(n.clock_mhz)) + ' MHz' : '—'], ['Free memory', n.mem_free_gib != null ? n.mem_free_gib + ' GiB' : '—'], ['Ring cables with a link', n.cables_up != null ? n.cables_up + ' / 2' : '—'], ['Up for', upfor(n.uptime_s)]])
        + '<div class="detail-note">On a DGX Spark the GPU and the CPU share the same 128 GB, so <em>free memory</em> is the headroom for a big prompt\'s buffers; under a few GiB the model process starts swapping. The head carries the API, the vision tower and the kept prompts, so it runs tighter than the workers.</div>' });
  }
  function showInterconnect() {
    const L = S && S.live, G = L && L.progress;
    openDialog({ eyebrow: 'Interconnect', title: 'The ring cables', description: 'What the engine moves between the three Sparks over the CX7 cables (RDMA), read from the InfiniBand counters once a second and averaged over 4 s.',
      body: rows([['Now', L && L.cable_mb_s != null ? (L.cable_mb_s >= 1000 ? (L.cable_mb_s / 1000).toFixed(2) + ' GB/s' : L.cable_mb_s + ' MB/s') : '—'], ['Engine', G ? G.state : '—'], ['Streams filling / decoding', G ? `${G.filling} / ${G.decoding}` : '—'], ['Stalled for', G && G.stalled_s ? G.stalled_s + ' s' : '—']])
        + '<div class="detail-note"><strong>Idle:</strong> 0 · <strong>a reply being written:</strong> about 0.5 GB/s (one or two at once) · <strong>a prompt being read:</strong> about 2.3 GB/s · <strong>prompt plus replies:</strong> 1.8–1.9 GB/s.</div><div class="detail-note">This is how the page tells a long prompt from a hang: a prompt loading keeps the cables busy, a stalled engine shows nothing moving for 30 s while it still holds work.</div>' });
  }
  function showRequestHelp() {
    openDialog({ eyebrow: 'Requests', title: 'What the states mean', description: 'Every client connection to the model server, from the kernel\'s TCP counters.',
      body: '<div class="detail-note"><strong>Streaming:</strong> reply bytes are flowing to the client.</div><div class="detail-note"><strong>Waiting for reply:</strong> nothing but headers sent yet — the prompt is being read (<em>prompt loading</em>, about 2.5k tokens/s on three Sparks, so a 300k-token prompt takes two minutes), it is queued, or it is a non-streaming request still being answered. <em>Engine stalled</em> means nothing has moved over the cables for 30 s with work held.</div><div class="detail-note"><strong>Reply paused:</strong> a reply of over 4 KB that has not moved for 3 s. The server closes a chat connection when its reply ends, so an open one is still being answered; a pause while another prompt loads is normal.</div><div class="detail-note"><strong>Client gone:</strong> the client hung up but its request still holds a lane.</div><div class="detail-note"><strong>Idle:</strong> a connection with no request on it, like a health poller.</div><div class="detail-note"><strong>Drop</strong> closes that connection from the head; the server cancels its request within seconds and the others keep going. The client sees an error and may send it again.</div>' });
  }

  async function dropPeer(peer) {
    const C = S && S.connections || [];
    const c = C.find(x => x.peer === peer);
    const ok = await confirmDialog(peer === 'all'
      ? { eyebrow: 'Unstick · step 02', tone: 'danger', title: `Drop all ${C.length} connection(s)?`, description: 'Every running request is cancelled within seconds; the clients see an error and may retry. The model keeps running.', confirm: 'Drop all' }
      : { eyebrow: 'Drop one request', tone: 'danger', title: `Drop ${c ? c.client : peer}?`, description: `Closes ${esc(peer)} from the head. Its request is cancelled; the client sees an error. Other requests keep going.`, confirm: 'Drop it' });
    if (!ok) return;
    const j = await post('/api/drop', { peer });
    said((j.ok ? '' : 'Drop failed: ') + j.message);
    notify(j.message, j.ok ? '' : 'danger');
    refresh();
  }
  async function restart() {
    let n = 0;
    try {  // a fresh count: the page's can be 2 s old
      const L = (await (await fetch('/api/status')).json()).live;
      n = L ? (L.requests_running || 0) + (L.requests_waiting || 0) : 0;
    } catch {}
    const ok = await confirmDialog({ eyebrow: 'Unstick · step 03', tone: 'danger', title: 'Restart the model?', confirm: 'Restart model',
      description: `The same weights are reloaded on all three Sparks: about 2–3 minutes with no model, Atlas uses the cloud meanwhile.` + (n ? ` <strong>${n} request(s) running or queued are cut off.</strong>` : ' No request is running right now.'),
      body: '<div class="detail-note">Only for a real hang: a dropped request that still counts as running after 30 s, or the API not answering. Capture diagnostics first if you have not.</div>' });
    if (!ok) return;
    const j = await post('/api/restart', { force: n > 0 });  // the confirm named what it cuts off; more since then and it refuses
    said(j.message);
    if (!j.ok || j.message !== 'started') notify(j.message, 'danger');
    busy = true; refresh();
  }
  async function diag() {
    const j = await post('/api/diag', {});
    said(j.ok ? 'Collecting diagnostics…' : j.message);
    notify(j.ok ? 'Collecting diagnostics: metrics, connections and every Spark\'s logs (about 30 s).' : j.message, j.ok ? '' : 'danger');
    refresh();
  }
  async function go(target) {
    const ablit = target === 'ablit';
    const ok = await confirmDialog({ eyebrow: ablit ? 'Warning · model change' : 'Model change', tone: ablit ? 'warning' : '', kind: ablit ? 'warning' : 'primary',
      title: `Switch to ${NAMES[target]}?`, confirm: `Switch to ${NAMES[target]}`,
      description: 'The model stops for about 2–6 minutes while the other weights load on all three Sparks; Atlas uses the cloud meanwhile. Both profiles answer to the same name, so nothing else changes. If the new one fails to start, it goes back by itself.',
      body: (ablit ? `<div class="model-warning-note">${WARN}<p><strong>Ablit is the modified weights.</strong> Make sure that is what you want serving before confirming.</p></div>` : '')
        + ($('force').checked ? '<div class="detail-note"><strong>Running requests will be cut off</strong> (the box under the profiles is ticked).</div>' : '<div class="detail-note">If requests are running the switch refuses; tick the box under the profiles to cut them off.</div>') });
    if (!ok) return;
    const j = await post('/api/switch', { target, force: $('force').checked });
    said(j.message);
    if (!j.ok || j.message !== 'started') notify(j.message, 'danger');
    busy = true; refresh();
  }

  /* ---------- wiring ---------- */
  function closeRecovery(focus) { recoveryMenu.hidden = true; recoveryButton.setAttribute('aria-expanded', 'false'); if (focus) recoveryButton.focus(); }
  $('nodes-grid').addEventListener('click', e => { const b = e.target.closest('[data-node-index]'); if (b) showNode(Number(b.dataset.nodeIndex)); });
  $('model-grid').addEventListener('click', e => { const b = e.target.closest('[data-model]'); if (b && !b.disabled) go(b.dataset.model); });
  $('request-list').addEventListener('click', e => { const b = e.target.closest('button.drop-button'); if (b && !b.disabled) dropPeer(b.dataset.peer); });
  $('request-help').addEventListener('click', showRequestHelp);
  $('requests-tile').addEventListener('click', () => $('request-heading').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('interconnect-tile').addEventListener('click', showInterconnect);
  $('diagnostics-button').addEventListener('click', diag);
  recoveryButton.addEventListener('click', () => { const opening = recoveryMenu.hidden; recoveryMenu.hidden = !opening; recoveryButton.setAttribute('aria-expanded', String(opening)); if (opening) recoveryMenu.querySelector('button').focus(); });
  recoveryMenu.addEventListener('click', e => { const b = e.target.closest('[data-action]'); if (!b || b.disabled) return; closeRecovery(false); if (b.dataset.action === 'diagnostics') diag(); else if (b.dataset.action === 'drop') dropPeer('all'); else restart(); });
  recoveryMenu.addEventListener('keydown', e => { const items = Array.from(recoveryMenu.querySelectorAll('button')); const i = items.indexOf(document.activeElement); let n = null; if (e.key === 'ArrowDown') n = (i + 1) % items.length; if (e.key === 'ArrowUp') n = (i + items.length - 1) % items.length; if (e.key === 'Home') n = 0; if (e.key === 'End') n = items.length - 1; if (n !== null) { e.preventDefault(); items[n].focus(); } });
  document.addEventListener('click', e => { if (!e.target.closest('.recovery-wrap')) closeRecovery(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !recoveryMenu.hidden) { e.preventDefault(); closeRecovery(true); } });
  document.querySelector('.dialog-close').addEventListener('click', () => detailDialog.close());
  detailDialog.addEventListener('close', () => { if (detailOpener && detailOpener.isConnected && !detailOpener.closest('[hidden]')) detailOpener.focus(); });
  $('open-settings').addEventListener('click', () => { settingsOpener = document.activeElement; syncTheme(); settingsDialog.showModal(); });
  document.querySelectorAll('.settings-close').forEach(b => b.addEventListener('click', () => settingsDialog.close()));
  settingsDialog.addEventListener('close', () => { if (settingsOpener && settingsOpener.isConnected) settingsOpener.focus(); });
  function syncTheme() { const cur = document.documentElement.getAttribute('data-theme'); document.querySelectorAll('input[name="theme"]').forEach(i => { i.checked = i.value === cur; }); }
  document.querySelectorAll('input[name="theme"]').forEach(i => i.addEventListener('change', () => {
    if (!i.checked || THEMES.indexOf(i.value) < 0) return;
    document.documentElement.setAttribute('data-theme', i.value);
    try { localStorage.setItem('dyno-theme', i.value); } catch {}
  }));

  gaugeThroughput(null, null);
  $('gpu-gauge').innerHTML = DynoGauges.percent({ value: null, label: 'AVG GPU', unavailable: true });
  $('memory-gauge').innerHTML = DynoGauges.percent({ value: null, label: 'FREE', unavailable: true });
  refresh();
  history();
}());
