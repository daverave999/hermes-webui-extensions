/*
 * Flightdeck for Hermes WebUI — browser wiring.
 *
 * Watches the current session's live /api/chat/stream (a second, read-only
 * subscriber; WebUI's StreamChannel fans out), reduces events with
 * FlightdeckCore, and draws a "Flight" tab in the right panel plus a one-line
 * strip above the composer on narrow screens. Observes only: no writes to
 * WebUI APIs, no network beyond same-origin GETs, no third-party assets.
 *
 * Idea and panel set: scasella/claude-flightdeck (MIT).
 */
(function () {
  'use strict';
  if (window.__flightdeckLoaded) return;
  window.__flightdeckLoaded = true;

  const ID = 'flightdeck';
  const VERSION = '0.2.0';
  const C = window.FlightdeckCore;
  if (!C) { console.warn('[flightdeck] core missing'); return; }

  // ------------------------------------------------------------ settings
  const HES = window.HermesExtensionSettings;
  const ext = (window.hermesExt && typeof window.hermesExt.register === 'function') ? window.hermesExt.register(ID) : null;
  const settingsApi = ext ? ext.settings : (HES && HES.settingsForExtension ? HES.settingsForExtension(ID) : null);
  const storageApi = ext ? ext.storage : (HES && HES.storageForExtension ? HES.storageForExtension(ID) : null);
  const DEFAULTS = { panels: 'main,gate,agents,advisor,receipt,log', advisorPattern: 'advisor|architect|review',
    advisorLabel: 'ADVISOR', gateLabel: 'GATE', maxCards: 3, layout: 'auto', motion: 'while-active',
    mobileStrip: true, pollAgents: true };
  function setting(k) {
    try { const v = settingsApi && settingsApi.get(k); if (v !== undefined && v !== null && v !== '') return v; } catch (_) { /* default */ }
    return DEFAULTS[k];
  }
  const opts = () => ({ advisorPattern: String(setting('advisorPattern') || '') });

  // ----------------------------------------------------------- persistence
  // Core keeps all of an extension's storage in ONE localStorage value and
  // rewrites it on every set(), so the namespace is held to a byte budget and
  // saves are debounced. Without the storage API, state lives for this page
  // load only: no raw localStorage keys.
  const STORE_BUDGET = 400000;
  const MAX_SESSIONS = 20;
  const memStore = new Map();
  const store = {
    get(k) {
      if (!storageApi) return memStore.has(k) ? memStore.get(k) : null;
      try { const v = storageApi.get(k, null); return v === undefined ? null : v; } catch (_) { return null; }
    },
    set(k, v) {
      if (!storageApi) { memStore.set(k, v); return true; }
      try { return storageApi.set(k, v) !== false; } catch (_) { return false; }
    },
    remove(k) {
      if (!storageApi) { memStore.delete(k); return true; }
      try { return typeof storageApi.remove === 'function' ? storageApi.remove(k) !== false : storageApi.set(k, null) !== false; } catch (_) { return false; }
    },
    all() {
      if (!storageApi) return Object.fromEntries(memStore);
      try { return (typeof storageApi.getAll === 'function' && storageApi.getAll()) || {}; } catch (_) { return {}; }
    },
  };
  const ui = Object.assign({ tab: 'core' }, store.get('ui') || {});
  function saveUi(patch) {
    Object.assign(ui, patch);
    store.set('ui', ui);
  }

  function loadState(sid) { return C.normalize(store.get('s:' + sid), sid); }
  let saveTimer = null;
  let dirty = false;
  function saveSoon() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 4000);
  }
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!state || !state.sessionId || !dirty) return;
    const sid = state.sessionId;
    for (let level = 0; level <= 2; level++) {
      const slim = C.slimForSave(state, level);
      const all = store.all();
      const prev = (Array.isArray(all.index) ? all.index : []).filter((x) => typeof x === 'string' && x !== sid);
      const idx = prev.concat(sid).slice(-MAX_SESSIONS);
      const sizes = {};
      let overhead = 0;
      Object.keys(all).forEach((k) => { if (!/^s:/.test(k)) overhead += k.length + JSON.stringify(all[k]).length; });
      idx.forEach((id) => {
        sizes[id] = id === sid ? JSON.stringify(slim).length : (all['s:' + id] ? JSON.stringify(all['s:' + id]).length : 0);
      });
      const plan = C.planEviction(idx, sizes, STORE_BUDGET, overhead);
      if (plan.total > STORE_BUDGET) continue;
      prev.filter((id) => plan.keep.indexOf(id) < 0).forEach((id) => store.remove('s:' + id));
      Object.keys(all).forEach((k) => { if (/^s:/.test(k) && plan.keep.indexOf(k.slice(2)) < 0 && k !== 's:' + sid) store.remove(k); });
      if (!store.set('s:' + sid, slim)) continue;          // full: try a smaller copy
      if (JSON.stringify(all.index) !== JSON.stringify(plan.keep)) store.set('index', plan.keep);
      dirty = false;
      return;
    }
  }

  // ----------------------------------------------------------------- state
  let state = null;          // current session's FD state
  let source = null;         // EventSource for the live turn
  let sourceStream = null;
  let currentSid = null;
  const deadStreams = new Set();   // streams that ended or 404'd: don't reattach every second
  function retireStream(id) {
    deadStreams.add(id);
    while (deadStreams.size > 40) deadStreams.delete(deadStreams.values().next().value);
  }
  const view = { expanded: null, gateOpen: null, confirmReset: 0 };

  // WebUI declares `const S` at top level in ui.js: a global lexical binding that is
  // visible to classic scripts as bare `S` but is NOT a property of window.
  function hostState() {
    // eslint-disable-next-line no-undef
    try { if (typeof S === 'object' && S) return S; } catch (_) { /* not declared yet */ }
    return window.S || null;
  }
  function activeSessionId() { const s = hostState(); return (s && s.session && s.session.session_id) || null; }
  function activeStreamId() { const s = hostState(); return (s && s.activeStreamId) || null; }

  function switchSession(sid) {
    if (sid === currentSid) return;
    saveNow();
    closeStream();
    if (pollController) pollController.abort();
    pollEpoch++;
    currentSid = sid;
    state = sid ? loadState(sid) : null;
    view.expanded = null; view.gateOpen = null; view.confirmReset = 0;
    pollDelay = POLL_MIN;
    pollCursor = 0; caughtUp.clear();
    render();
    if (sid) {
      const st = activeStreamId();
      if (st) attach(st);
      // A turn saved as running whose stream Core no longer follows (it ended
      // while this page was away, or its terminal frame was missed): replay it.
      // Core serves a finished stream from its run journal; a stream that is
      // gone 404s and is settled in attach().
      else if (state.turn && state.turn.status === 'running' && state.turn.streamId) attach(state.turn.streamId, undefined, true);
      if (state.agents.some((a) => !a.endedAt || !a.summary)) pollAgents(true);
    }
  }

  // ------------------------------------------------------------- streaming
  const EVENTS = ['tool', 'tool_complete', 'approval', 'metering', 'runtime_model', 'compressing', 'compressed',
    'warning', 'apperror', 'cancel', 'done', 'stream_end', 'todo_state'];

  function attach(streamId, startedAtMs, explicit) {
    if (!streamId || !state) return;
    if (!explicit && deadStreams.has(streamId)) return;
    if (source && sourceStream === streamId && source.readyState !== 2) return;
    deadStreams.delete(streamId);
    closeStream();
    const after = (state.seen && state.seen[streamId]) || 0;
    if (!after) {
      const hs = hostState();
      const pending = hs && hs.session && Number(hs.session.pending_started_at);
      const at = startedAtMs || (pending ? pending * 1000 : Date.now());
      C.reduce(state, { event: 'turn_start', streamId, at, data: { model: hs && hs.session && hs.session.model } }, opts());
      scheduleRender();
    }
    const url = new URL(`api/chat/stream?stream_id=${encodeURIComponent(streamId)}&replay=1&after_seq=${after}`,
      document.baseURI || location.href).href;
    let es;
    try { es = new EventSource(url, { withCredentials: true }); } catch (e) { return; }
    source = es; sourceStream = streamId;
    const sidAtAttach = currentSid;
    const openedAt = Date.now();
    let lastAt = openedAt;
    EVENTS.forEach((name) => es.addEventListener(name, (msg) => {
      if (source !== es || currentSid !== sidAtAttach || !state) return;
      let data = null; try { data = JSON.parse(msg.data); } catch (_) { data = {}; }
      const seq = seqOf(msg.lastEventId, streamId);
      const now = Date.now();
      // Backfill arrives as a burst right after connect; its timing isn't real,
      // so throughput must not be measured across it.
      const replay = now - openedAt < 400 && now - lastAt < 50;
      lastAt = now;
      C.reduce(state, { event: name, data, seq, streamId, at: now, replay }, opts());
      if (name === 'tool' && data && data.name === 'delegate_task') pollAgents(true);
      scheduleRender(); saveSoon();
      if (name === 'stream_end' || name === 'cancel' || name === 'apperror') {
        retireStream(streamId);
        closeStream();
        saveNow();
      }
    }));
    es.onerror = () => {
      // Server closes after stream_end; a dead stream 404s. Don't spin.
      if (es.readyState === 2) {
        retireStream(streamId);
        if (source === es) { source = null; sourceStream = null; settleLost(streamId); }
      }
    };
  }
  // The stream closed for good without a terminal frame and Core isn't running
  // it either: the turn is over, outcome unknown. Close it at its last activity
  // so it doesn't read "running" forever.
  function settleLost(streamId) {
    const t = state && state.turn;
    if (!t || t.streamId !== streamId || t.status !== 'running' || activeStreamId() === streamId) return;
    const last = state.log.reduce((m, l) => Math.max(m, Number(l.at) || 0), t.startedAt || 0);
    C.reduce(state, { event: 'stream_lost', streamId, at: last || Date.now(), data: {} }, opts());
    dirty = true; saveNow(); scheduleRender();
  }
  function seqOf(lastEventId, streamId) {
    const m = String(lastEventId || '').match(/:(\d+)$/);
    if (!m) return undefined;
    if (!String(lastEventId).startsWith(streamId)) return undefined;
    return Number(m[1]);
  }
  function closeStream() {
    if (source) { try { source.close(); } catch (_) { /* closed */ } }
    source = null; sourceStream = null;
  }

  // ------------------------------------------------------ subagent polling
  // /api/sessions lists every conversation, so it is polled only while a
  // subagent is live, never twice at once, never in a hidden tab, and backs
  // off (4 s -> 20 s) while nothing changes.
  const POLL_MIN = 4000, POLL_MAX = 20000;
  let pollDelay = POLL_MIN, lastPollAt = 0, pollBusy = false;
  let pollCursor = 0;        // rotates child-detail fetches so a fifth child isn't starved
  // Finished children whose detail was already requested in this session: each
  // gets one catch-up attempt, so an empty answer can't keep polling alive.
  const caughtUp = new Set();
  let pollController = null, pollEpoch = 0;
  const live = (a) => a.status === 'running' || a.status === 'starting';
  const needsDetail = (a) => !!a.sessionId && (live(a) || (!a.summary && !caughtUp.has(a.sessionId)));
  function wantsAgentPoll() {
    if (!state || !setting('pollAgents') || document.hidden) return false;
    return state.agents.some((a) => live(a) || needsDetail(a));
  }
  async function pollAgents(force) {
    if (!state || !currentSid || pollBusy || document.hidden || !setting('pollAgents')) return;
    const now = Date.now();
    if (!force && now - lastPollAt < pollDelay) return;
    pollBusy = true; lastPollAt = now;
    const sid = currentSid, epoch = pollEpoch;
    const controller = new AbortController();
    pollController = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    const request = { credentials: 'same-origin', cache: 'no-store', signal: controller.signal };
    try {
      const r = await fetch(new URL('api/sessions', document.baseURI || location.href).href, request);
      if (!r.ok) return;
      const body = await r.json();
      if (sid !== currentSid || epoch !== pollEpoch || !state) return;
      const rows = [].concat(body.sessions || [], body.sidebar_reference_sessions || []);
      const before = JSON.stringify(state.agents);
      C.mergeChildSessions(state, rows, sid, Date.now());
      // Fetch details for children that are still open, or finished without a
      // final answer and not yet asked; four at a time, rotating.
      const eligible = state.agents.filter(needsDetail);
      const start = eligible.length ? pollCursor % eligible.length : 0;
      const need = eligible.slice(start).concat(eligible.slice(0, start)).slice(0, 4);
      pollCursor = start + need.length;
      need.forEach((a) => { if (!live(a)) caughtUp.add(a.sessionId); });
      await Promise.all(need.map(async (a) => {
        try {
          const u = new URL(`api/session?session_id=${encodeURIComponent(a.sessionId)}&msg_limit=40&resolve_model=0`, document.baseURI || location.href).href;
          const rr = await fetch(u, request);
          if (!rr.ok) return;
          const d = await rr.json();
          if (sid === currentSid && epoch === pollEpoch && state) C.applyChildDetail(state, d);
        } catch (_) { /* skip */ }
      }));
      if (sid !== currentSid || epoch !== pollEpoch || !state) return;
      if (JSON.stringify(state.agents) !== before) { pollDelay = POLL_MIN; scheduleRender(); saveSoon(); }
      else pollDelay = Math.min(POLL_MAX, Math.round(pollDelay * 1.5));
    } catch (_) { /* offline; next tick */ } finally {
      clearTimeout(timeout);
      if (pollController === controller) pollController = null;
      pollBusy = false;
    }
  }

  // ------------------------------------------------------------- lifecycle
  if (ext && ext.events && typeof ext.events.on === 'function') {
    ext.events.on('turn:start', (e) => {
      if (e.sessionId && e.sessionId !== currentSid) switchSession(e.sessionId);
      if (e.streamId) attach(e.streamId, Number.isFinite(e.startedAt) ? e.startedAt * 1000 : undefined, true);
    });
    ['turn:complete', 'turn:error', 'turn:cancel'].forEach((t) => ext.events.on(t, (e) => {
      const sid = currentSid;
      // Match the turn, not just an open subscriber: ours can have closed (a
      // 404 or a dropped connection) while Core kept running the turn.
      const stream = (e && e.streamId) || sourceStream || (state && state.turn && state.turn.streamId) || null;
      if ((e && e.sessionId && e.sessionId !== sid) || !stream) return;
      setTimeout(() => {
        if (currentSid !== sid) return;
        if (state && state.turn && state.turn.streamId === stream && state.turn.status === 'running') {
          const event = t === 'turn:complete' ? 'stream_end' : t === 'turn:cancel' ? 'cancel' : 'apperror';
          C.reduce(state, { event, streamId: stream, at: Date.now(), data: { message: (e && e.message) || '' } }, opts());
          dirty = true; scheduleRender();
        }
        retireStream(stream);
        if (sourceStream === stream) closeStream();
        if (state && state.agents.length) pollAgents(true);
        saveNow();
      }, 1500);
    }));
  }
  // Session switches and streams started before we loaded: cheap watcher.
  setInterval(() => {
    const sid = activeSessionId();
    if (sid !== currentSid) switchSession(sid);
    const st = activeStreamId();
    if (st && state && (!source || sourceStream !== st)) attach(st);
    if (wantsAgentPoll()) pollAgents(false);
    const ticking = state && (state.main.isRunning || state.agents.some((a) => a.status === 'running'));
    if (view.confirmReset && Date.now() > view.confirmReset) { view.confirmReset = 0; scheduleRender(); }
    if (ticking) scheduleRender(); // clocks
  }, 1000);
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

  // ================================================================== UI
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const sr = (text) => el('span', 'fd-sr', text);
  const isCompact = () => (typeof window._isCompactWorkspaceViewport === 'function'
    ? !!window._isCompactWorkspaceViewport() : window.matchMedia('(max-width: 900px)').matches);

  let panelEl = null, tabEl = null, stripEl = null, rafPending = false;

  function mountTab() {
    const tabs = document.querySelector('.rightpanel .workspace-panel-tabs');
    const panel = document.querySelector('.rightpanel');
    if (!tabs || !panel) return false;
    if (!document.getElementById('fdTab')) {
      tabEl = el('button', 'workspace-panel-tab fd-tab', 'Flight');
      tabEl.id = 'fdTab'; tabEl.type = 'button';
      tabEl.setAttribute('role', 'tab'); tabEl.setAttribute('aria-selected', 'false');
      tabEl.setAttribute('aria-controls', 'fdPanel');
      tabEl.title = 'Flightdeck: live agent instruments';
      tabEl.addEventListener('click', () => openFlightTab(true));
      tabs.appendChild(tabEl);
    }
    if (!document.getElementById('fdPanel')) {
      panelEl = el('div', 'fd-panel'); panelEl.id = 'fdPanel';
      panelEl.setAttribute('role', 'tabpanel'); panelEl.setAttribute('aria-labelledby', 'fdTab');
      panelEl.tabIndex = 0;
      panelEl.addEventListener('keydown', containKeys);
      panelEl.addEventListener('keydown', onKey);
      panelEl.addEventListener('click', onClick);
      panelEl.addEventListener('pointerdown', onPointerDown);
      const anchor = document.getElementById('previewArea');
      panel.insertBefore(panelEl, anchor || null);
      if (typeof ResizeObserver === 'function') new ResizeObserver(() => scheduleRender()).observe(panelEl);
    }
    // Core switches tabs without telling extensions (its own tab buttons, an
    // artifact click opening Files, the Todos tab hiding itself). Follow it.
    if (typeof MutationObserver === 'function' && !panel.__fdObserved) {
      panel.__fdObserved = true;
      new MutationObserver(() => {
        if (panel.dataset.activeTab !== 'flightdeck' && tabEl && tabEl.classList.contains('active')) {
          markTab(false);
          saveUi({ tab: 'core' });
        }
      }).observe(panel, { attributes: true, attributeFilter: ['data-active-tab'] });
    }
    return true;
  }

  function markTab(on) {
    if (!tabEl) return;
    tabEl.classList.toggle('active', on);
    tabEl.setAttribute('aria-selected', on ? 'true' : 'false');
    if (panelEl) panelEl.classList.toggle('fd-open', on);
  }

  function openFlightTab(fromUser) {
    const panel = document.querySelector('.rightpanel');
    if (!panel || !panelEl) return;
    const layoutEl = document.querySelector('.layout');
    const closed = panel.offsetWidth < 40 || (layoutEl && layoutEl.classList.contains('workspace-panel-collapsed')) ||
      document.documentElement.dataset.workspacePanel === 'closed' ||
      (isCompact() && !panel.classList.contains('mobile-open'));
    if (closed && fromUser !== false && typeof window.openWorkspacePanel === 'function') {
      try { window.openWorkspacePanel('browse'); } catch (_) { /* best effort */ }
    }
    document.querySelectorAll('.rightpanel .workspace-panel-tab').forEach((b) => {
      if (b === tabEl) return;
      b.classList.remove('active'); b.setAttribute('aria-selected', 'false');
    });
    panel.dataset.activeTab = 'flightdeck';
    markTab(true);
    applyTextColors();
    render();
    if (fromUser !== false && !isCompact()) saveUi({ tab: 'flight' });
  }

  function mountStrip() {
    if (document.getElementById('fdStrip')) return true;
    const wrap = document.getElementById('composerWrap');
    if (!wrap || !wrap.parentNode) return false;
    stripEl = el('button', 'fd-strip'); stripEl.id = 'fdStrip'; stripEl.type = 'button';
    stripEl.hidden = true;
    stripEl.appendChild(el('span', 'fd-strip-dot'));
    stripEl.appendChild(el('span', 'fd-strip-text'));
    stripEl.addEventListener('click', () => openFlightTab(true));
    wrap.parentNode.insertBefore(stripEl, wrap);
    if (typeof MutationObserver === 'function') {
      const watch = new MutationObserver(() => renderStrip());
      DOCKED.concat(TERMINAL).forEach((id) => { const c = document.getElementById(id); if (c) watch.observe(c, { attributes: true, attributeFilter: ['class', 'hidden'] }); });
    }
    return true;
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  // --------------------------------------------------------------- colour
  // Skin tokens are tuned for fills; as small text some sit near 1.5:1 on
  // their own background. Text uses a variant nudged to >= 5:1 against both
  // the panel background and the box fill. Fills keep the raw tokens.
  const TEXT_ROLES = { ok: 'var(--success, #3d8b40)', warn: 'var(--warning, #e68a00)', bad: 'var(--error, #c62828)',
    info: 'var(--info, #0288a8)', accent: 'var(--accent, #3b82f6)' };
  let probe = null;
  function resolveColor(host, value) {
    if (!probe) { probe = el('span', 'fd-probe'); probe.setAttribute('aria-hidden', 'true'); }
    host.appendChild(probe);
    probe.style.color = '';
    probe.style.color = value;
    const c = C.parseColor(getComputedStyle(probe).color);
    probe.remove();
    return c;
  }
  function applyTextColors() {
    [panelEl, stripEl].forEach((host) => {
      if (!host || !host.isConnected) return;
      const bgs = [resolveColor(host, 'var(--sidebar, var(--bg, #fff))'), resolveColor(host, 'var(--surface, var(--bg, #fff))'),
        resolveColor(host, 'var(--bg, #fff)')].filter(Boolean);
      Object.keys(TEXT_ROLES).forEach((role) => {
        let fg = resolveColor(host, TEXT_ROLES[role]);
        if (!fg) return;
        for (let i = 0; i < 3; i++) bgs.forEach((bg) => { fg = C.parseColor(C.textSafe(fg, bg, 5)); });
        host.style.setProperty('--fd-t-' + role, C.toHex(fg));
      });
    });
  }
  let colorTimer = null;
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      clearTimeout(colorTimer);
      colorTimer = setTimeout(() => { applyTextColors(); scheduleRender(); }, 150);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-skin', 'data-theme', 'style'] });
  }

  // ----------------------------------------------------------- rendering
  // Boxes are rebuilt as detached nodes and swapped in only when their markup
  // changed. A swap keeps keyboard focus (same data-fd-* control) and scroll
  // position, and never happens under a pressed pointer, so a click or tap that
  // spans a clock tick still lands.
  const mounted = new Map();   // key -> { node, html }
  let cols = [];
  let rootMode = '';
  let hold = null;             // { key, until }
  const FOCUS_ATTRS = ['data-fd-agent', 'data-fd-gate', 'data-fd-reset', 'data-fd-session', 'data-fd-scroll'];

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const box = e.target.closest && e.target.closest('[data-fd-key]');
    if (box) hold = { key: box.dataset.fdKey, until: Date.now() + 5000 };
  }
  const releaseHold = () => { if (hold) { hold = null; scheduleRender(); } };
  window.addEventListener('pointerup', releaseHold, true);
  window.addEventListener('pointercancel', releaseHold, true);
  window.addEventListener('blur', releaseHold);
  const held = (key) => !!(hold && hold.key === key && Date.now() < hold.until);

  function focusKey(node) {
    for (const a of FOCUS_ATTRS) if (node.hasAttribute && node.hasAttribute(a)) return [a, node.getAttribute(a)];
    return null;
  }
  function swapBox(m, node, html) {
    const old = m.node;
    const active = document.activeElement;
    const fk = active && old.contains(active) ? focusKey(active) : null;
    const scrolls = Array.from(old.querySelectorAll('[data-fd-scroll]')).map((e) => [e.getAttribute('data-fd-scroll'), e.scrollTop]);
    if (old.parentNode) old.replaceWith(node);
    scrolls.forEach(([k, top]) => { const e = node.querySelector('[data-fd-scroll="' + k + '"]'); if (e) e.scrollTop = top; });
    if (fk) {
      const next = Array.from(node.querySelectorAll('[' + fk[0] + ']')).find((n) => n.getAttribute(fk[0]) === fk[1]);
      try { (next || panelEl).focus({ preventScroll: true }); } catch (_) { (next || panelEl).focus(); }
    }
    m.node = node; m.html = html;
  }

  function showMessage(mode, text) {
    if (rootMode === mode && panelEl.firstChild && panelEl.firstChild.textContent === text) return;
    mounted.clear(); cols = []; rootMode = mode;
    panelEl.replaceChildren(el('div', 'fd-' + mode, text));
  }

  // Rebuilding columns, removing a box or swapping in a message drops focus to
  // <body>, where Core's Enter = Allow once shortcut is armed. Put it back on
  // the same control, or on the panel, which contains Enter (containKeys).
  function render() {
    const had = panelEl && panelEl.contains(document.activeElement) ? document.activeElement : null;
    renderPanel();
    if (had && panelEl.isConnected && !panelEl.contains(document.activeElement)) {
      const back = had.isConnected && panelEl.contains(had) ? had : panelEl;
      try { back.focus({ preventScroll: true }); } catch (_) { back.focus(); }
    }
  }

  function renderPanel() {
    renderStrip();
    if (!panelEl || !panelEl.classList.contains('fd-open')) return;
    const now = Date.now();
    const width = panelEl.clientWidth || 320;
    const layout = C.layoutFor(width, setting('layout'));
    panelEl.dataset.layout = layout;
    panelEl.dataset.motion = setting('motion') === 'off' ? 'off' : 'on';
    if (!state) { showMessage('empty', 'Open a conversation to see its instruments.'); return; }
    panelEl.classList.toggle('fd-live', !!(state.turn && state.turn.status === 'running'));
    if (layout === 'mini') { showMessage('mini', C.miniLine(state, now) || 'idle'); return; }
    const wanted = [];
    C.parsePanels(setting('panels')).forEach((p) => {
      const node = PANELS[p] && PANELS[p](now, layout);
      if (node) { node.setAttribute('data-fd-key', p); wanted.push([p, node]); }
    });
    if (!wanted.length) { showMessage('empty', 'No activity recorded for this conversation yet. Instruments fill in on the next turn.'); return; }

    const ncol = layout === 'wide' ? 2 : 1;
    if (rootMode !== 'cols' || cols.length !== ncol) {
      cols = Array.from({ length: ncol }, () => el('div', 'fd-col'));
      panelEl.replaceChildren(...cols);
      rootMode = 'cols';
    }
    const right = new Set(['agents', 'advisor', 'log']);
    const perCol = cols.map(() => []);
    const seen = new Set();
    wanted.forEach(([key, node]) => {
      seen.add(key);
      const html = node.outerHTML;
      let m = mounted.get(key);
      if (!m) { m = { node, html }; mounted.set(key, m); }
      else if (m.html !== html && !held(key)) swapBox(m, node, html);
      perCol[ncol === 2 && right.has(key) ? 1 : 0].push(m.node);
    });
    for (const [key, m] of mounted) if (!seen.has(key)) { m.node.remove(); mounted.delete(key); }
    perCol.forEach((nodes, i) => {
      const col = cols[i];
      const same = col.children.length === nodes.length && nodes.every((n, j) => col.children[j] === n);
      if (!same) col.replaceChildren(...nodes);
    });
  }

  function box(name, title, aside) {
    const b = el('section', 'fd-box fd-' + name);
    const h = el('header', 'fd-head');
    const t = el('h3', 'fd-title', title);
    t.id = 'fd-h-' + name;
    b.setAttribute('aria-labelledby', t.id);
    h.appendChild(t);
    if (aside) h.appendChild(el('span', 'fd-aside', aside));
    b.appendChild(h);
    return b;
  }
  function statRow() {
    const row = el('div', 'fd-row');
    row.stat = (k, v, cls, label) => {
      const s = el('span', 'fd-stat' + (cls ? ' ' + cls : ''));
      const kk = el('span', 'fd-k', k);
      if (label) { kk.setAttribute('aria-hidden', 'true'); s.title = label; s.appendChild(sr(label + ' ')); }
      s.appendChild(kk); s.appendChild(el('span', 'fd-v', v)); row.appendChild(s);
    };
    return row;
  }

  const STATUS = {
    running: ['●', 'running'], starting: ['◌', 'starting'], completed: ['✓', 'done'], failed: ['✗', 'failed'],
    error: ['✗', 'failed'], interrupted: ['⏸', 'interrupted'], timeout: ['⌛', 'timed out'],
  };
  const CELL_WORD = { running: 'running', pending: 'waiting for approval', approved: 'approved', ran: 'ran', error: 'failed', denied: 'denied' };

  const PANELS = {
    main(now) {
      const m = state.main;
      if (!m.model && m.ctxTokens == null && m.costUsd == null) return null;
      const b = box('main', 'MAIN', [C.shortModel(m.model), m.provider].filter(Boolean).join(' · '));
      const pct = C.ctxPct(m);
      const g = el('div', 'fd-gauge');
      const bar = el('div', 'fd-gauge-bar');
      bar.setAttribute('role', 'meter');
      bar.setAttribute('aria-label', 'Context used');
      bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-valuenow', String(Math.round(pct || 0)));
      const fill = el('div', 'fd-gauge-fill'); fill.style.width = (pct || 0).toFixed(1) + '%';
      if (m.compressAt && m.ctxWindow) {
        const at = Math.min(100, (m.compressAt / m.ctxWindow) * 100);
        const mark = el('div', 'fd-gauge-mark'); mark.style.left = at.toFixed(1) + '%';
        mark.title = 'compresses at ' + C.fmtTokens(m.compressAt);
        bar.setAttribute('aria-valuetext', `${Math.round(pct || 0)}%, compresses at ${Math.round(at)}%`);
        bar.appendChild(mark);
        if (m.ctxTokens >= m.compressAt * 0.9) fill.classList.add('fd-hot');
      }
      bar.appendChild(fill);
      g.appendChild(el('span', 'fd-k', 'ctx'));
      g.appendChild(bar);
      const tilde = state.turn && state.turn.status === 'running' && state.gate.recent.some((c) => c.status === 'running') ? '≥' : '';
      g.appendChild(el('span', 'fd-v', m.ctxTokens != null ? `${tilde}${C.fmtTokens(m.ctxTokens)} / ${C.fmtTokens(m.ctxWindow)}` : '—'));
      b.appendChild(g);
      const row = statRow();
      row.stat('cost', C.fmtCost(m.costUsd));
      if (m.cacheHitPct != null) row.stat('cache', Math.round(m.cacheHitPct) + '%');
      if (m.tps) row.stat('tok/s', String(Math.round(m.tps)));
      row.stat('⟲', String(m.compressions), m.compressing ? 'fd-pulse' : '', 'compressions');
      b.appendChild(row);
      if (m.fallback) {
        const w = el('div', 'fd-warn');
        w.setAttribute('role', 'note');
        w.textContent = '⚠ fallback model active' + (m.fallbackNote ? ': ' + m.fallbackNote : '');
        b.appendChild(w);
      }
      return b;
    },

    gate() {
      const recent = state.gate.recent;
      if (!recent.length) return null;
      const s = C.gateSummary(state);
      const parts = [`${s.ran} ran`]; if (s.approved) parts.push(`${s.approved} ok'd`);
      if (s.pending) parts.push(`${s.pending} waiting`); if (s.error) parts.push(`${s.error} ✗`); if (s.denied) parts.push(`${s.denied} ⛔`);
      const b = box('gate', String(setting('gateLabel') || 'GATE'), parts.join(' · '));
      // The cells are one button: on touch there is no hover, so tapping them
      // lists the most recent calls with their details.
      const cells = el('button', 'fd-cells' + (view.gateOpen === 'all' ? ' fd-on' : ''));
      cells.type = 'button'; cells.dataset.fdGate = 'all';
      cells.setAttribute('aria-pressed', String(view.gateOpen === 'all'));
      cells.setAttribute('aria-label', C.gateAria(state) + '. Show recent calls');
      recent.forEach((c) => {
        const cell = el('span', 'fd-cell fd-' + c.status);
        cell.setAttribute('aria-hidden', 'true');
        cell.title = `${c.tool}${c.detail ? ': ' + c.detail : ''} (${CELL_WORD[c.status] || c.status}${c.approval ? ', needed approval' : ''})`;
        cells.appendChild(cell);
      });
      b.appendChild(cells);
      const fam = el('div', 'fd-fams');
      C.BUCKETS.forEach((bk) => {
        const t = state.gate.totals[bk] || {};
        const n = (t.ran || 0) + (t.approved || 0) + (t.error || 0) + (t.denied || 0) + (t.pending || 0);
        if (!n) return;
        const bad = (t.error || 0) + (t.denied || 0);
        const btn = el('button', 'fd-fam' + (view.gateOpen === bk ? ' fd-on' : ''));
        btn.type = 'button'; btn.dataset.fdGate = bk;
        btn.setAttribute('aria-pressed', String(view.gateOpen === bk));
        btn.setAttribute('aria-label', `${bk} tools: ${n}${bad ? ', ' + bad + ' failed or denied' : ''}`);
        const key = el('span', 'fd-key', bk[0]); key.setAttribute('aria-hidden', 'true');
        btn.appendChild(key);
        btn.appendChild(document.createTextNode(`${bk} ${n}`));
        if (bad) btn.appendChild(el('span', 'fd-bad', ` ✗${bad}`));
        fam.appendChild(btn);
      });
      b.appendChild(fam);
      if (s.error || s.denied || s.approved || s.pending) b.appendChild(el('div', 'fd-sub', 'Errors and approval outcomes are inferred from tool previews.'));
      if (view.gateOpen) {
        const list = view.gateOpen === 'all' ? recent.slice(-8) : recent.filter((c) => c.bucket === view.gateOpen).slice(-5);
        const dl = el('ol', 'fd-drill');
        dl.setAttribute('aria-label', view.gateOpen === 'all' ? 'Recent tool calls' : `Recent ${view.gateOpen} tool calls`);
        list.slice().reverse().forEach((c) => {
          const li = el('li', 'fd-' + c.status);
          const dot = el('span', 'fd-dot'); dot.setAttribute('aria-hidden', 'true');
          li.appendChild(dot);
          li.appendChild(el('span', 'fd-tool', c.tool));
          const d = el('span', 'fd-detail', c.detail || '');
          if (c.detail) d.title = c.detail;
          li.appendChild(d);
          li.appendChild(sr(', ' + (CELL_WORD[c.status] || c.status)));
          dl.appendChild(li);
        });
        b.appendChild(dl);
      }
      return b;
    },

    agents(now, layout) {
      if (!state.agents.length) return null;
      const running = state.agents.filter((a) => a.status === 'running' || a.status === 'starting').length;
      const b = box('agents', 'AGENTS', `${running} running · ${state.agents.length} total`);
      const maxCards = Math.max(1, Math.min(6, Number(setting('maxCards')) || 3));
      const asLanes = state.agents.length > maxCards || (layout === 'compact' && state.agents.length > 2);
      b.appendChild(asLanes ? lanes(now) : cards(now));
      return b;
    },

    advisor(now) {
      const cs = state.advisor.consults;
      if (!cs.length) return null;
      const open = cs.filter((c) => !c.endAt).length;
      const last = cs[cs.length - 1];
      const b = box('advisor', String(setting('advisorLabel') || 'ADVISOR'),
        `${cs.length} consult${cs.length === 1 ? '' : 's'}${open ? ' · running' : ''}`);
      const t0 = Math.min(...cs.map((c) => c.at)), t1 = Math.max(now, ...cs.map((c) => c.endAt || now));
      const W = 300, H = 18; const sx = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (W - 4) + 2;
      const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fd-timeline', preserveAspectRatio: 'none', role: 'img',
        'aria-label': `${cs.length} advisor consult${cs.length === 1 ? '' : 's'} over ${C.fmtDuration(t1 - t0)}` });
      s.appendChild(svg('line', { x1: 0, y1: H / 2, x2: W, y2: H / 2, class: 'fd-axis' }));
      cs.forEach((c) => {
        const x = sx(c.at), x2 = Math.max(x + 3, sx(c.endAt || now));
        const r = svg('rect', { x, y: 3, width: x2 - x, height: H - 6, rx: 2, class: c.endAt ? 'fd-consult' : 'fd-consult fd-open' });
        const tt = svg('title', {}); tt.textContent = `${c.via} · ${c.moment} (inferred)`; r.appendChild(tt);
        s.appendChild(r);
      });
      b.appendChild(s);
      b.appendChild(el('div', 'fd-sub', `last: ${last.via} · ${last.moment} (inferred)${last.endAt ? ' · ' + C.fmtDuration(last.endAt - last.at) : ''}`));
      return b;
    },

    receipt(now) {
      const t = state.turn && state.turn.status === 'running' ? state.turn : null;
      const r = t ? null : state.receipt;
      if (!t && !r) return null;
      const b = box('receipt', t ? 'TURN' : 'RECEIPT', t ? 'running' : r.status);
      const row = statRow();
      if (t) {
        row.stat('⏱', C.fmtDuration(now - t.startedAt), '', 'elapsed');
        row.stat('tools', String(t.tools)); if (t.agents) row.stat('agents', String(t.agents));
        row.stat('edits', String(t.edits)); row.stat('errors', String(t.errors), t.errors ? 'fd-badv' : '');
        if (t.todosTotal) row.stat('todos', `${t.todosDone}/${t.todosTotal}`);
        if (t.costAtStart != null && state.main.costUsd != null) row.stat('+cost', C.fmtCost(state.main.costUsd - t.costAtStart));
      } else {
        row.stat('⏱', C.fmtDuration(r.durationMs), '', 'took');
        row.stat('tools', String(r.tools)); if (r.agents) row.stat('agents', String(r.agents));
        row.stat('edits', String(r.edits));
        const bad = r.errors + (r.denied || 0);
        row.stat('errors', String(bad), bad ? 'fd-badv' : '');
        if (r.costDelta != null) row.stat('+cost', C.fmtCost(r.costDelta));
      }
      b.appendChild(row);
      return b;
    },

    log() {
      if (!state.log.length) return null;
      const b = box('log', 'LOG', String(state.log.length));
      const armed = view.confirmReset && Date.now() <= view.confirmReset;
      const reset = el('button', 'fd-reset' + (armed ? ' fd-armed' : ''), armed ? 'confirm reset?' : 'reset');
      reset.type = 'button'; reset.dataset.fdReset = '1';
      reset.title = 'Clear Flightdeck history for this conversation (the conversation itself is untouched)';
      reset.setAttribute('aria-label', armed ? 'Confirm: clear Flightdeck history for this conversation'
        : 'Reset Flightdeck history for this conversation');
      b.querySelector('.fd-head').appendChild(reset);
      const ol = el('ol', 'fd-loglist');
      ol.dataset.fdScroll = 'log';
      ol.tabIndex = 0;
      ol.setAttribute('aria-label', 'Event log, newest first');
      state.log.slice(-60).reverse().forEach((l) => {
        const li = el('li', 'fd-' + l.kind);
        const d = new Date(l.at);
        const time = el('time', 'fd-at', [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':'));
        time.dateTime = d.toISOString();
        li.appendChild(time);
        li.appendChild(el('span', 'fd-who', l.who));
        const tx = el('span', 'fd-text', l.text); tx.title = l.text;
        li.appendChild(tx);
        ol.appendChild(li);
      });
      b.appendChild(ol);
      return b;
    },
  };

  function agentClock(a, now) { return C.fmtDuration((a.endedAt || now) - a.startedAt); }
  function agentLabel(a, i) {
    const st = STATUS[a.status] ? STATUS[a.status][1] : a.status;
    return `Agent ${i + 1}, ${st}${a.goal ? ': ' + a.goal : ''}`;
  }
  function statusIcon(a) {
    const s = el('span', 'fd-status', STATUS[a.status] ? STATUS[a.status][0] : '•');
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  function cards(now) {
    const wrap = el('div', 'fd-agentwrap');
    const grid = el('div', 'fd-cards');
    let open = null;
    state.agents.forEach((a, i) => {
      const on = view.expanded === a.id;
      const card = el('button', 'fd-card fd-a-' + a.status + (on ? ' fd-on' : ''));
      card.type = 'button'; card.dataset.fdAgent = a.id;
      card.setAttribute('aria-expanded', String(on));
      card.setAttribute('aria-label', agentLabel(a, i));
      const top = el('div', 'fd-card-top');
      top.appendChild(el('span', 'fd-num', String(i + 1)));
      top.appendChild(statusIcon(a));
      top.appendChild(el('span', 'fd-clock', agentClock(a, now)));
      card.appendChild(top);
      card.appendChild(el('div', 'fd-goal', a.goal || (a.sessionId ? 'subagent ' + a.sessionId.slice(-6) : 'subagent')));
      const meta = [C.shortModel(a.model), a.steps ? a.steps + ' msgs' : '', a.background ? 'bg' : ''].filter(Boolean).join(' · ');
      if (meta) card.appendChild(el('div', 'fd-meta', meta));
      grid.appendChild(card);
      if (on) open = a;
    });
    wrap.appendChild(grid);
    if (open) wrap.appendChild(agentDetail(open));
    return wrap;
  }

  function lanes(now) {
    const wrap = el('div', 'fd-lanes');
    // Child start times come from the server's clock, which can run ahead of
    // this browser's: span every recorded time and clamp, so a skewed card
    // can't push its bar past the track.
    const t0 = Math.min(...state.agents.map((a) => a.startedAt || now));
    const t1 = Math.max(now, ...state.agents.map((a) => Math.max(a.startedAt || 0, a.endedAt || now)));
    const pct = (v) => Math.min(100, Math.max(0, v));
    state.agents.forEach((a, i) => {
      const on = view.expanded === a.id;
      const row = el('button', 'fd-lane fd-a-' + a.status + (on ? ' fd-on' : ''));
      row.type = 'button'; row.dataset.fdAgent = a.id;
      row.setAttribute('aria-expanded', String(on));
      row.setAttribute('aria-label', agentLabel(a, i));
      row.appendChild(el('span', 'fd-num', String(i + 1)));
      const track = el('span', 'fd-track');
      const bar = el('span', 'fd-bar');
      const L = pct(((a.startedAt - t0) / Math.max(1, t1 - t0)) * 100);
      const R = pct(((Math.max(a.endedAt || now, a.startedAt || 0)) - t0) / Math.max(1, t1 - t0) * 100);
      const W = Math.max(1.5, R - L);
      bar.style.left = Math.min(L, 100 - W).toFixed(2) + '%'; bar.style.width = W.toFixed(2) + '%';
      track.appendChild(bar);
      row.appendChild(track);
      const clock = el('span', 'fd-clock');
      clock.appendChild(statusIcon(a));
      clock.appendChild(document.createTextNode(' ' + agentClock(a, now)));
      row.appendChild(clock);
      row.title = a.goal || '';
      wrap.appendChild(row);
      if (on) wrap.appendChild(agentDetail(a));
    });
    return wrap;
  }

  function agentDetail(a) {
    const d = el('div', 'fd-detailbox');
    if (a.goal) d.appendChild(el('p', 'fd-goal-full', a.goal));
    const facts = [['status', STATUS[a.status] ? STATUS[a.status][1] : a.status], ['model', a.model || '—'],
      ['messages', a.steps || '—'], ['tools', a.tools ? a.tools + (a.lastTool ? ' (last ' + a.lastTool + ')' : '') : '—'],
      ['subagent', a.subagentId || '—'], ['session', a.sessionId || '—']];
    const dl = el('dl', 'fd-facts');
    facts.forEach(([k, v]) => { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, String(v))); });
    d.appendChild(dl);
    if (a.summary) d.appendChild(el('p', 'fd-summary', a.summary));
    if (a.sessionId) {
      const link = el('a', 'fd-open-link', 'Open transcript →');
      link.href = '#'; link.dataset.fdSession = a.sessionId;
      d.appendChild(link);
    }
    return d;
  }

  let stripText = null;
  // With the soft keyboard up the strip would take a large share of what's
  // left of the screen, so it steps aside. Core sets --keyboard-bottom-inset on
  // <html> only while a touch keyboard covers the viewport; the observer on
  // <html> style below re-renders when it changes.
  const keyboardUp = () => !!document.documentElement.style.getPropertyValue('--keyboard-bottom-inset');
  // Core docks its approval, clarify and queue cards, and the composer
  // terminal (open, or collapsed to its dock pill), over the composer's top
  // edge, which is where the strip sits. While one is up it matters more, so
  // the strip steps aside instead of peeking out around it.
  const DOCKED = ['approvalCard', 'clarifyCard', 'queueCard'];
  const TERMINAL = 'composerTerminalPanel';
  const dockedCardUp = () => DOCKED.some((id) => { const c = document.getElementById(id); return !!(c && c.classList.contains('visible')); }) ||
    (() => { const t = document.getElementById(TERMINAL); return !!(t && !t.hidden && (t.classList.contains('is-open') || t.classList.contains('is-collapsed'))); })();
  function renderStrip() {
    if (!stripEl) return;
    const show = !!(isCompact() && setting('mobileStrip') && state && !keyboardUp() && !dockedCardUp() &&
      (state.main.isRunning || state.agents.some((a) => a.status === 'running') ||
       (state.receipt && Date.now() - (state.receipt.endedAt || 0) < 120000)));
    if (stripEl.hidden === show) stripEl.hidden = !show;
    if (!show) return;
    stripEl.classList.toggle('fd-live', !!state.main.isRunning);
    const text = C.miniLine(state, Date.now()) || 'Flightdeck';
    if (text !== stripText) {
      stripText = text;
      stripEl.lastChild.textContent = text;
      stripEl.setAttribute('aria-label', `Flightdeck: ${text}. Opens the Flight panel.`);
    }
  }

  // -------------------------------------------------------------- input
  function onClick(e) {
    const ag = e.target.closest('[data-fd-agent]');
    const gate = e.target.closest('[data-fd-gate]');
    const open = e.target.closest('[data-fd-session]');
    if (e.target.closest('[data-fd-reset]')) {
      if (view.confirmReset && Date.now() <= view.confirmReset) {
        view.confirmReset = 0;
        if (state) { const sid = state.sessionId; state = C.defaultState(sid); dirty = true; saveNow(); }
      } else {
        view.confirmReset = Date.now() + 4000;
      }
      render();
      return;
    }
    if (open) {
      e.preventDefault(); e.stopPropagation();
      const sid = open.dataset.fdSession;
      if (typeof window.loadSession === 'function') window.loadSession(sid);
      else location.hash = '#/session/' + encodeURIComponent(sid);
      return;
    }
    if (ag) { view.expanded = view.expanded === ag.dataset.fdAgent ? null : ag.dataset.fdAgent; render(); return; }
    if (gate) { view.gateOpen = view.gateOpen === gate.dataset.fdGate ? null : gate.dataset.fdGate; render(); }
  }

  // Core answers a pending approval on Enter ("Allow once") unless the key's
  // target is a control. The panel and the scrollable log take focus but
  // aren't controls, so Enter and Space stop here; a focused button still
  // activates, since that is the key's default action, not propagation.
  function containKeys(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') e.stopPropagation();
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (/^[1-6]$/.test(e.key) && state) {
      const a = state.agents[Number(e.key) - 1];
      if (a) { view.expanded = view.expanded === a.id ? null : a.id; render(); e.preventDefault(); }
    } else if (e.key.length === 1 && 'fswoa'.includes(e.key)) {
      const bk = { f: 'file', s: 'shell', w: 'web', o: 'other', a: 'all' }[e.key];
      view.gateOpen = view.gateOpen === bk ? null : bk; render(); e.preventDefault();
    } else if (e.key === 'Escape' && (view.expanded || view.gateOpen || view.confirmReset)) {
      view.expanded = null; view.gateOpen = null; view.confirmReset = 0; render();
    }
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    const ok = mountTab();
    mountStrip();
    if (!ok) { setTimeout(boot, 500); return; }
    applyTextColors();
    switchSession(activeSessionId());
    window.addEventListener('resize', scheduleRender);
    // Come back to the Flight tab after a reload if it was the last one used
    // (desktop only, and never forcing a closed panel open).
    if (ui.tab === 'flight' && !isCompact()) openFlightTab(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Debug/test handle (read-only snapshot).
  window.__flightdeck = {
    version: VERSION,
    state: () => state && JSON.parse(JSON.stringify(state)),
    open: () => openFlightTab(true),
    render,
    view: () => Object.assign({}, view),
  };
})();
