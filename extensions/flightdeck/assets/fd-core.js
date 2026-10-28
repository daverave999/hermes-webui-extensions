/*
 * Flightdeck for Hermes WebUI — pure core.
 *
 * Reducers, classifiers and formatters with no DOM, no fetch and no timers, so
 * every behaviour is testable under `node --test` against recorded run-journal
 * fixtures. Shape and "merge over defaults" rule follow scasella/claude-flightdeck
 * (MIT) hooks/core.ts; the event vocabulary is Hermes WebUI's /api/chat/stream.
 *
 * Loaded two ways: as a classic <script> (attaches window.FlightdeckCore) and via
 * require() in tests (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlightdeckCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const MAX_CHECKS = 80;
  const MAX_LOG = 200;
  const MAX_AGENTS = 12;
  const PANELS = ['main', 'gate', 'agents', 'advisor', 'receipt', 'log'];
  const BUCKETS = ['file', 'shell', 'web', 'other'];

  // ------------------------------------------------------------- defaults
  const zeroTally = () => ({ ran: 0, approved: 0, pending: 0, denied: 0, error: 0 });

  function defaultState(sessionId) {
    return {
      v: SCHEMA_VERSION,
      sessionId: sessionId || '',
      main: {
        model: '', provider: '', fallback: false, fallbackNote: '',
        ctxTokens: null, ctxWindow: null, compressAt: null,
        compressions: 0, compressing: false,
        costUsd: null, tps: null, cacheHitPct: null, isRunning: false,
      },
      gate: { recent: [], totals: { file: zeroTally(), shell: zeroTally(), web: zeroTally(), other: zeroTally() } },
      agents: [],
      advisor: { consults: [] },
      turn: null,
      receipt: null,
      log: [],
      seen: {},           // streamId -> last applied seq (dedupe across replays/reconnects)
    };
  }

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const merge = (def, stored) => (isObj(stored) ? Object.assign({}, def, stored) : def);
  const list = (v) => (Array.isArray(v) ? v : []);

  /** A stored state merged over defaults so an older/partial shape never breaks the panel. */
  function normalize(stored, sessionId) {
    const d = defaultState(sessionId);
    if (!isObj(stored) || stored.v !== SCHEMA_VERSION) return d;
    const totals = merge(d.gate.totals, isObj(stored.gate) ? stored.gate.totals : null);
    return {
      v: SCHEMA_VERSION,
      sessionId: sessionId || stored.sessionId || '',
      main: merge(d.main, stored.main),
      gate: {
        recent: list(stored.gate && stored.gate.recent).slice(-MAX_CHECKS),
        totals: { file: merge(zeroTally(), totals.file), shell: merge(zeroTally(), totals.shell),
                  web: merge(zeroTally(), totals.web), other: merge(zeroTally(), totals.other) },
      },
      agents: list(stored.agents).slice(-MAX_AGENTS),
      advisor: { consults: list(stored.advisor && stored.advisor.consults).slice(-40) },
      turn: isObj(stored.turn) ? stored.turn : null,
      receipt: isObj(stored.receipt) ? stored.receipt : null,
      log: list(stored.log).slice(-MAX_LOG),
      seen: isObj(stored.seen) ? stored.seen : {},
    };
  }

  // ---------------------------------------------------------- classifiers
  const FILE_TOOLS = /^(read_file|write_file|patch|search_files|edit_file|multi_edit|str_replace|vision_analyze)$/;
  const SHELL_TOOLS = /^(terminal|process|process_manage|execute_code|shell|bash)$/;
  const WEB_TOOLS = /^(web_|browser|mcp__browser|mcp__web|fetch)/;
  const EDIT_TOOLS = /^(write_file|patch|edit_file|multi_edit|str_replace)$/;

  function bucket(name) {
    const n = String(name || '').replace(/^mcp__/, (m) => (/^mcp__(browser|web)/.test(name) ? m : ''));
    if (FILE_TOOLS.test(n)) return 'file';
    if (SHELL_TOOLS.test(n)) return 'shell';
    if (WEB_TOOLS.test(String(name || ''))) return 'web';
    return 'other';
  }

  const isEdit = (name) => EDIT_TOOLS.test(String(name || ''));

  /**
   * Classify a tool_complete preview. WebUI's structured path hard-codes
   * is_error:false, so we read the result text. Conservative: only clear,
   * leading failure shapes count, never a stray "Error" inside file contents.
   */
  function resultKind(name, preview, isErrorFlag) {
    if (isErrorFlag === true) return 'error';
    const t = String(preview || '').slice(0, 600).trimStart();
    if (/^BLOCKED:/.test(t) || /^(Denied|Command denied|User denied)/i.test(t)) return 'denied';
    if (/^\{/.test(t)) {
      if (/"success"\s*:\s*false/.test(t)) return 'error';
      if (/"status"\s*:\s*"(error|failed|failure)"/.test(t)) return 'error';
      const ec = t.match(/"exit_code"\s*:\s*(-?\d+)/);
      if (ec && Number(ec[1]) !== 0) return 'error';
      if (/^\{\s*"error"\s*:\s*"[^"]/.test(t)) return 'error';
    }
    if (/^(Error|Traceback \(most recent call last\)|Exception|Failed to|Tool error)/.test(t)) return 'error';
    // WebUI's snippet keeps only the `output` field of a shell result, so the exit
    // code is lost. Infer from the classic `prog: message` stderr shape.
    if (SHELL_TOOLS.test(String(name || '')) && SHELL_STDERR.test(t.split('\n', 1)[0])) return 'error';
    return 'ok';
  }
  const SHELL_STDERR = /^(?:(?:ba|z)?sh: (?:line \d+: )?)?[\w./+-]+: .*(No such file or directory|command not found|Permission denied|cannot access|cannot open|cannot stat|Operation not permitted|Not a directory|Is a directory|invalid option|unrecognized option|not found)\b/;

  // ------------------------------------------------------------ masking
  const SECRET_PATTERNS = [
    [/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '$1-•••'],
    [/\b(gh[pousr]_)[A-Za-z0-9]{12,}/g, '$1•••'],
    [/\b(xox[abpr]-)[A-Za-z0-9-]{8,}/g, '$1•••'],
    [/\bAKIA[0-9A-Z]{12,}/g, 'AKIA•••'],
    [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1•••'],
    [/((?:api[_-]?key|token|secret|password|passwd|pwd|authorization)["']?\s*[:=]\s*["']?)[^\s"'&]{4,}/gi, '$1•••'],
    [/(https?:\/\/[^:\s/]+:)[^@\s/]+@/g, '$1•••@'],
  ];

  function mask(s) {
    let out = String(s == null ? '' : s).slice(0, 4096); // bound regex work before scanning untrusted text
    for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
    return out;
  }

  const oneLine = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t;
  };

  /** Short, masked, human summary of a tool call: path, command or query. */
  function summarize(name, args) {
    const a = isObj(args) ? args : {};
    const pick = a.path || a.file_path || a.command || a.cmd || a.code || a.url || a.query ||
      a.pattern || a.goal || a.tasks || a.name || a.action || '';
    return mask(oneLine(pick, 90));
  }

  // ------------------------------------------------------------- helpers
  function pushLog(st, at, who, kind, text) {
    st.log.push({ at, who, kind, text: mask(oneLine(text, 140)) });
    if (st.log.length > MAX_LOG) st.log.splice(0, st.log.length - MAX_LOG);
  }

  function findCheck(st, tid, name) {
    for (let i = st.gate.recent.length - 1; i >= 0; i--) {
      const c = st.gate.recent[i];
      if (c.status !== 'running' && c.status !== 'pending') continue;
      if (tid ? c.tid === tid : c.tool === name) return c;
    }
    return null;
  }

  function tally(st, b, key, delta) {
    const t = st.gate.totals[b] || (st.gate.totals[b] = zeroTally());
    t[key] = Math.max(0, (t[key] || 0) + delta);
  }

  // The advisor setting is a list of words separated by `|`, matched without
  // case anywhere in the tool name or delegate role. It is not a regular
  // expression: a user-supplied pattern ran on every tool event, and a nested
  // quantifier could stall the page.
  function compileAdvisor(pattern) {
    const words = String(pattern || '').split('|').map((w) => w.trim().toLowerCase().slice(0, 64))
      .filter(Boolean).slice(0, 20);
    if (!words.length) return null;
    return { test: (text) => { const t = String(text || '').toLowerCase(); return words.some((w) => t.includes(w)); } };
  }

  function ensureTurn(st, at, streamId) {
    if (!st.turn || st.turn.streamId !== streamId) {
      st.turn = { streamId, startedAt: at, tools: 0, edits: 0, errors: 0, denied: 0, errorStreak: 0,
                  agents: 0, costAtStart: st.main.costUsd, endedAt: null, status: 'running',
                  // Generation clock: model time only (paused while any tool runs).
                  genMs: 0, genFrom: at, open: 0,
                  outBase: Number.isFinite(st.main.outTotal) ? st.main.outTotal : null };
      st.main.tps = null;
      st.main.isRunning = true;
    }
    return st.turn;
  }

  function genPause(t, at) {
    if (t && t.genFrom != null) { t.genMs += Math.max(0, at - t.genFrom); t.genFrom = null; }
  }
  function genResume(t, at) {
    if (t && t.genFrom == null && t.open === 0 && t.status === 'running') t.genFrom = at;
  }

  /**
   * Output tok/s for this turn = agent output tokens (session_completion_tokens,
   * includes thinking) generated this turn / model time this turn (tool runs excluded).
   * WebUI's own `tps` counts stream deltas over wall time since the first token,
   * tool time included, so it reads ~1 on tool-heavy turns; we ignore it.
   */
  function noteOutput(st, out, at, replay) {
    const t = st.turn;
    if (!t || t.status !== 'running' || !Number.isFinite(out)) return;
    if (out < t.outBase) t.outBase = 0;               // fresh agent: counter restarted this turn
    if (t.outBase == null || replay) {
      // No baseline yet, or a replay burst with no real timing: rebase and measure from here.
      t.outBase = out; t.genMs = 0; if (t.genFrom != null) t.genFrom = at;
      return;
    }
    const tok = out - t.outBase;
    const ms = t.genMs + (t.genFrom != null ? Math.max(0, at - t.genFrom) : 0);
    if (tok > 0 && ms >= 1000) st.main.tps = tok / (ms / 1000);
  }

  function consultMoment(turn) {
    if (!turn) return 'before a plan';
    if (turn.errorStreak >= 2) return 'error repeats';
    if (turn.edits > 0) return 'before done';
    return 'before a plan';
  }

  function applyUsage(st, u, at, replay) {
    if (!isObj(u)) return;
    if (u.output_tokens != null && Number.isFinite(Number(u.output_tokens)) && Number(u.output_tokens) > 0) {
      const out = Number(u.output_tokens);
      if (at != null) noteOutput(st, out, at, replay);
      st.main.outTotal = out;
    }
    if (u.context_length) st.main.ctxWindow = Number(u.context_length) || st.main.ctxWindow;
    if (u.threshold_tokens) st.main.compressAt = Number(u.threshold_tokens) || st.main.compressAt;
    if (u.last_prompt_tokens) st.main.ctxTokens = Number(u.last_prompt_tokens) || st.main.ctxTokens;
    if (u.estimated_cost != null && Number.isFinite(Number(u.estimated_cost))) st.main.costUsd = Number(u.estimated_cost);
    if (u.cache_hit_percent != null) st.main.cacheHitPct = Number(u.cache_hit_percent);
  }

  /** Parse delegate_task's tool_complete preview: {status, mode, count, goals, subagent_ids, delegation_id}. */
  function parseDelegation(preview) {
    const t = String(preview || '');
    let obj = null;
    try { obj = JSON.parse(t); } catch (_) {
      const ids = t.match(/"subagent_ids"\s*:\s*\[([^\]]*)\]/);
      const mode = t.match(/"mode"\s*:\s*"([a-z]+)"/);
      const count = t.match(/"count"\s*:\s*(\d+)/);
      if (ids || mode) {
        obj = { mode: mode && mode[1], count: count && Number(count[1]),
                subagent_ids: ids ? ids[1].split(',').map((s) => s.replace(/["\s]/g, '')).filter(Boolean) : [] };
        const goals = t.match(/"goals"\s*:\s*\[(.*?)\]\s*,\s*"/);
        if (goals) { try { obj.goals = JSON.parse('[' + goals[1] + ']'); } catch (_) { /* ignore */ } }
      }
    }
    if (!isObj(obj)) return null;
    // Synchronous runs return {results:[{status, summary, duration_seconds, ...}]}.
    return obj;
  }

  function goalsFromArgs(args) {
    const a = isObj(args) ? args : {};
    if (a.goal) return [String(a.goal)];
    const raw = a.tasks;
    if (Array.isArray(raw)) return raw.map((x) => (isObj(x) ? String(x.goal || '') : String(x)));
    if (typeof raw === 'string') {
      const out = []; const re = /'goal':\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g; let m;
      while ((m = re.exec(raw))) out.push(m[1] || m[2] || '');
      if (out.length) return out;
      return [raw];
    }
    return [];
  }

  function upsertAgent(st, card) {
    const i = st.agents.findIndex((a) => a.id === card.id);
    if (i >= 0) st.agents[i] = Object.assign({}, st.agents[i], card);
    else st.agents.push(card);
    if (st.agents.length > MAX_AGENTS) st.agents.splice(0, st.agents.length - MAX_AGENTS);
  }

  // -------------------------------------------------------------- reducer
  /**
   * Apply one /api/chat/stream event. Mutates and returns `st`.
   * ev = { event, data, seq?, streamId, at? (ms) }.
   * opts = { advisorPattern?: string, now?: ms }.
   */
  function reduce(st, ev, opts) {
    const o = opts || {};
    const data = isObj(ev.data) ? ev.data : {};
    const sid = ev.streamId || '';
    const at = Number.isFinite(ev.at) ? ev.at : (o.now || Date.now());
    if (sid && Number.isFinite(ev.seq)) {
      const last = st.seen[sid] || 0;
      if (ev.seq <= last) return st;          // replay / reconnect duplicate
      st.seen[sid] = ev.seq;
      const keys = Object.keys(st.seen);
      if (keys.length > 30) delete st.seen[keys[0]];
    }
    const advisorRe = compileAdvisor(o.advisorPattern);

    switch (ev.event) {
      case 'turn_start': {
        // Synthetic: emitted by the browser layer when it attaches to a live stream,
        // so the clock starts at send time rather than at the first model output.
        if (!st.seen[sid] && (!st.turn || st.turn.streamId !== sid)) {
          ensureTurn(st, at, sid);
          if (data.model && !st.main.model) st.main.model = String(data.model);
        }
        break;
      }
      case 'runtime_model': {
        ensureTurn(st, at, sid);
        if (data.model) st.main.model = String(data.model);
        if (data.provider) st.main.provider = String(data.provider);
        st.main.fallback = !!data.fallback_active;
        if (!data.fallback_active) st.main.fallbackNote = '';
        break;
      }
      case 'warning': {
        const msg = String(data.message || '');
        if (data.type === 'fallback' || /fallback/i.test(msg)) {
          st.main.fallback = true; st.main.fallbackNote = oneLine(msg.replace(/^\W+/, ''), 120);
        }
        pushLog(st, at, 'warn', 'error', msg);
        break;
      }
      case 'metering': {
        applyUsage(st, data.usage, at, !!ev.replay);
        break;
      }
      case 'compressing':
        st.main.compressing = true; pushLog(st, at, 'ctx', 'info', '⟲ compressing context'); break;
      case 'compressed':
        st.main.compressing = false; st.main.compressions += 1;
        applyUsage(st, data.usage, at, !!ev.replay);
        if (isObj(data.usage) && data.usage.post_compression_context_tokens_estimate)
          st.main.ctxTokens = Number(data.usage.post_compression_context_tokens_estimate);
        pushLog(st, at, 'ctx', 'info', '⟲ context compressed'); break;
      case 'tool': {
        const turn = ensureTurn(st, at, sid);
        const name = String(data.name || 'tool');
        if (data.tid && st.gate.recent.some((c) => c.tid === data.tid)) break;
        const b = bucket(name);
        const check = { tid: data.tid || null, tool: name, bucket: b, status: 'running',
                        detail: summarize(name, data.args), at, endAt: null, approval: false };
        st.gate.recent.push(check);
        turn.open += 1; genPause(turn, at);
        if (st.gate.recent.length > MAX_CHECKS) st.gate.recent.splice(0, st.gate.recent.length - MAX_CHECKS);
        turn.tools += 1;
        if (name === 'delegate_task') {
          const goals = goalsFromArgs(data.args);
          turn.agents += Math.max(1, goals.length);
          goals.forEach((g, i) => upsertAgent(st, {
            id: (data.tid || 'deleg') + ':' + i, goal: oneLine(g, 160), model: '', status: 'starting',
            startedAt: at, endedAt: null, tools: 0, lastTool: '', sessionId: null, summary: '',
            via: 'stream', tid: data.tid || null, index: i,
          }));
          pushLog(st, at, 'spawn', 'info', `delegate_task → ${goals.length || 1} agent(s): ${goals[0] || ''}`);
        } else {
          pushLog(st, at, name, 'info', check.detail || name);
        }
        if (advisorRe && advisorRe.test(name + ' ' + (data.args && (data.args.role || data.args.agent_type || '')))) {
          st.advisor.consults.push({ at, endAt: null, via: name, moment: consultMoment(turn), tid: data.tid || null });
          if (st.advisor.consults.length > 40) st.advisor.consults.shift();
          pushLog(st, at, 'advisor', 'consult', `consult via ${name}`);
        }
        break;
      }
      case 'approval': {
        const turn = ensureTurn(st, at, sid);
        // The approval belongs to the newest running shell-ish check.
        let c = null;
        for (let i = st.gate.recent.length - 1; i >= 0; i--) {
          if (st.gate.recent[i].status === 'running') { c = st.gate.recent[i]; break; }
        }
        if (c && c.status !== 'pending') { c.status = 'pending'; c.approval = true; tally(st, c.bucket, 'pending', 1); }
        pushLog(st, at, 'gate', 'consult', `approval needed: ${oneLine(data.description || data.command || '', 90)}`);
        void turn;
        break;
      }
      case 'tool_complete': {
        const turn = ensureTurn(st, at, sid);
        const name = String(data.name || 'tool');
        const c = findCheck(st, data.tid, name);
        const kind = resultKind(name, data.preview, data.is_error);
        if (c && (c.status === 'running' || c.status === 'pending')) { turn.open = Math.max(0, turn.open - 1); genResume(turn, at); }
        if (c) {
          const wasPending = c.status === 'pending';
          if (wasPending) tally(st, c.bucket, 'pending', -1);
          c.endAt = at;
          c.status = kind === 'denied' ? 'denied' : kind === 'error' ? 'error' : (c.approval ? 'approved' : 'ran');
          tally(st, c.bucket, c.status, 1);
        } else {
          tally(st, bucket(name), kind === 'denied' ? 'denied' : kind === 'error' ? 'error' : 'ran', 1);
        }
        if (kind === 'error') { turn.errors += 1; turn.errorStreak += 1; pushLog(st, at, name, 'error', `✗ ${oneLine(data.preview, 110)}`); }
        else if (kind === 'denied') { turn.denied += 1; turn.errorStreak += 1; pushLog(st, at, name, 'error', `⛔ denied: ${oneLine(data.preview, 100)}`); }
        else { turn.errorStreak = 0; if (isEdit(name)) turn.edits += 1; }
        // Advisor consult closes.
        for (let i = st.advisor.consults.length - 1; i >= 0; i--) {
          const k = st.advisor.consults[i];
          if (!k.endAt && (data.tid ? k.tid === data.tid : k.via === name)) { k.endAt = at; break; }
        }
        if (name === 'delegate_task') {
          const d = parseDelegation(data.preview) || {};
          const tid = data.tid || 'deleg';
          let cards = st.agents.filter((a) => a.tid === (data.tid || null) || a.id.startsWith(tid + ':'));
          // WebUI truncates tool args to ~120 chars, so the start event may have
          // shown fewer goals than were dispatched; the result lists them all.
          const goals = list(d.goals);
          const want = Math.max(goals.length, list(d.subagent_ids).length, list(d.results).length, Number(d.count) || 0);
          const startedAt = cards.length ? cards[0].startedAt : at;
          for (let i = 0; i < want; i++) {
            const card = cards[i];
            const goal = goals[i] ? oneLine(goals[i], 160) : '';
            if (card) { if (goal && goal.length >= card.goal.length) card.goal = goal; continue; }
            upsertAgent(st, { id: tid + ':' + i, goal, model: '', status: 'starting', startedAt, endedAt: null,
                              tools: 0, lastTool: '', sessionId: null, summary: '', via: 'stream',
                              tid: data.tid || null, index: i });
          }
          if (want > cards.length && st.turn) st.turn.agents += want - cards.length;
          cards = st.agents.filter((a) => a.tid === (data.tid || null) || a.id.startsWith(tid + ':'));
          const bg = d.mode === 'background' || d.status === 'dispatched';
          const ids = list(d.subagent_ids);
          const results = list(d.results);
          cards.forEach((card, i) => {
            if (ids[i]) card.subagentId = ids[i];
            if (d.delegation_id) card.delegationId = d.delegation_id;
            if (bg) { card.status = 'running'; card.background = true; }
            else {
              const r = results[i] || {};
              card.status = kind === 'error' ? 'failed' : (r.status || 'completed');
              card.endedAt = at;
              if (r.summary) card.summary = oneLine(r.summary, 300);
              if (r.duration_seconds) card.endedAt = card.startedAt + r.duration_seconds * 1000;
            }
          });
          pushLog(st, at, 'spawn', kind === 'error' ? 'error' : 'done',
            bg ? `dispatched ${cards.length} background agent(s)` : `delegate_task finished (${cards.length})`);
        }
        break;
      }
      case 'todo_state': {
        const todos = list(data.todos || (data.todo_state && data.todo_state.todos));
        if (todos.length && st.turn) {
          st.turn.todosDone = todos.filter((t) => /done|complete/i.test(String(t.status))).length;
          st.turn.todosTotal = todos.length;
        }
        break;
      }
      case 'done': {
        const turn = ensureTurn(st, at, sid);
        applyUsage(st, data.usage, at, !!ev.replay);
        const s = isObj(data.session) ? data.session : {};
        if (s.model && !st.main.model) st.main.model = String(s.model);
        if (s.model_provider && !st.main.provider) st.main.provider = String(s.model_provider);
        if (isObj(data.usage) && data.usage.used_model) st.main.model = String(data.usage.used_model);
        const dur = isObj(data.usage) && data.usage.duration_seconds ? data.usage.duration_seconds * 1000 : at - turn.startedAt;
        closeTurn(st, at, 'complete', dur);
        break;
      }
      case 'cancel':
        ensureTurn(st, at, sid); closeTurn(st, at, 'cancelled'); pushLog(st, at, 'turn', 'error', 'turn cancelled'); break;
      case 'apperror':
        ensureTurn(st, at, sid); closeTurn(st, at, 'error');
        pushLog(st, at, 'turn', 'error', `error: ${data.message || data.error || data.type || ''}`); break;
      case 'stream_end':
        if (st.turn && st.turn.streamId === sid && st.turn.status === 'running') closeTurn(st, at, 'complete');
        break;
      case 'stream_lost':
        // Browser layer: the turn's stream is gone and no terminal frame was seen,
        // so the outcome isn't known. Close it at its last recorded activity.
        if (st.turn && st.turn.streamId === sid && st.turn.status === 'running') closeTurn(st, at, 'ended');
        break;
      default:
        break;
    }
    return st;
  }

  function closeTurn(st, at, status, durationMs) {
    const t = st.turn;
    if (!t || t.status !== 'running') { st.main.isRunning = false; return; }
    genPause(t, at);
    t.status = status; t.endedAt = at;
    // Any check still open when the turn ends was interrupted.
    st.gate.recent.forEach((c) => {
      if (c.status === 'running' || c.status === 'pending') {
        if (c.status === 'pending') tally(st, c.bucket, 'pending', -1);
        c.status = status === 'complete' || status === 'ended' ? 'ran' : 'error'; c.endAt = at;
      }
    });
    st.receipt = {
      streamId: t.streamId, status, durationMs: Math.max(0, durationMs != null ? durationMs : at - t.startedAt),
      tools: t.tools, agents: t.agents, edits: t.edits, errors: t.errors, denied: t.denied,
      costDelta: st.main.costUsd != null && t.costAtStart != null ? Math.max(0, st.main.costUsd - t.costAtStart) : null,
      endedAt: at,
    };
    st.main.isRunning = false;
    st.main.compressing = false;
    pushLog(st, at, 'turn', status === 'complete' ? 'done' : status === 'ended' ? 'info' : 'error',
      status === 'ended' ? `ended · outcome not recorded · ${t.tools} tools`
        : `${status} · ${fmtDuration(st.receipt.durationMs)} · ${t.tools} tools · ${t.errors} errors`);
  }

  /**
   * Merge child-session rows (from /api/sessions) into agent cards.
   * rows: [{session_id, parent_session_id, model, message_count, is_streaming, created_at, updated_at, title}]
   */
  function mergeChildSessions(st, rows, parentId, now) {
    const kids = list(rows).filter((r) => r && r.parent_session_id === parentId &&
      String(r.raw_source || r.source || r.session_source || '').toLowerCase() === 'subagent');
    kids.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    const nowMs = now || Date.now();
    kids.forEach((r) => {
      const startedAt = (r.created_at || 0) * 1000;
      // Pair with an unclaimed stream card spawned within 2 min before this child, else make a new card.
      let card = st.agents.find((a) => a.sessionId === r.session_id);
      if (!card) {
        card = st.agents
          .filter((a) => !a.sessionId && a.startedAt <= startedAt + 5000 && startedAt - a.startedAt < 120000)
          .sort((a, b) => a.startedAt - b.startedAt)[0];
        if (card) card.sessionId = r.session_id;
      }
      const updatedMs = (r.updated_at || r.created_at || 0) * 1000;
      const live = !!r.is_streaming || (nowMs - updatedMs < 90000);
      const patch = {
        sessionId: r.session_id, model: r.model || (card && card.model) || '',
        steps: Number(r.message_count) || 0, lastSeenAt: updatedMs,
      };
      if (!card) {
        card = { id: 'sess:' + r.session_id, goal: '', status: live ? 'running' : 'completed',
                 startedAt, endedAt: live ? null : updatedMs, tools: 0, lastTool: '', summary: '', via: 'session' };
        st.agents.push(card);
      }
      Object.assign(card, patch);
      if (!card.startedAt || startedAt < card.startedAt) card.startedAt = startedAt || card.startedAt;
      if (live && card.status !== 'failed') { card.status = 'running'; card.endedAt = null; }
      else if (!live && (card.status === 'running' || card.status === 'starting')) { card.status = 'completed'; card.endedAt = updatedMs; }
    });
    if (st.agents.length > MAX_AGENTS) st.agents.splice(0, st.agents.length - MAX_AGENTS);
    return st;
  }

  /**
   * Apply a child session's metadata (/api/session?session_id=<child>) to its card:
   * end_reason => finished; last assistant message => answer.
   */
  function applyChildDetail(st, detail) {
    const s = isObj(detail) && isObj(detail.session) ? detail.session : detail;
    if (!isObj(s) || !s.session_id) return st;
    const card = st.agents.find((a) => a.sessionId === s.session_id);
    if (!card) return st;
    if (s.model) card.model = String(s.model);
    const msgs = list(s.messages);
    if (msgs.length) card.steps = Math.max(card.steps || 0, Number(s.message_count) || msgs.length);
    let tools = 0, lastTool = '';
    msgs.forEach((m) => {
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        tools += m.tool_calls.length;
        const tc = m.tool_calls[m.tool_calls.length - 1];
        lastTool = (tc && (tc.function && tc.function.name || tc.name)) || lastTool;
      }
    });
    if (tools) { card.tools = tools; card.lastTool = lastTool; }
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        card.summary = mask(oneLine(m.content, 300)); break;
      }
    }
    if (s.end_reason) {
      const endMs = (Number(s.last_message_at || s.updated_at) || 0) * 1000;
      card.status = /error|fail|timeout|interrupt/i.test(String(s.end_reason)) ? 'failed' : 'completed';
      card.endReason = String(s.end_reason);
      card.endedAt = endMs || card.endedAt || Date.now();
    }
    return st;
  }

  // ----------------------------------------------------------- formatting
  function fmtTokens(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    n = Number(n);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  function fmtCost(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    n = Number(n);
    if (n === 0) return '$0';
    if (n < 0.01) return '<$0.01';
    if (n < 100) return '$' + n.toFixed(2);
    return '$' + Math.round(n);
  }

  function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return `${m}:${String(r).padStart(2, '0')}`;
    const h = Math.floor(m / 60);
    return `${h}h${String(m % 60).padStart(2, '0')}`;
  }

  function shortModel(m) {
    return String(m || '').replace(/^(anthropic|openai|openrouter|google)\//, '').replace(/^claude-/, '');
  }

  function ctxPct(main) {
    if (!main.ctxTokens || !main.ctxWindow) return null;
    return Math.max(0, Math.min(100, (main.ctxTokens / main.ctxWindow) * 100));
  }

  function gateSummary(st) {
    const s = { ran: 0, approved: 0, pending: 0, denied: 0, error: 0 };
    BUCKETS.forEach((b) => { const t = st.gate.totals[b] || {}; Object.keys(s).forEach((k) => { s[k] += t[k] || 0; }); });
    return s;
  }

  function parsePanels(spec) {
    const want = String(spec || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const out = want.filter((p, i) => PANELS.includes(p) && want.indexOf(p) === i);
    return out.length ? out : PANELS.slice();
  }

  /** Pick a layout from a width and a user override. The right panel defaults to ~300px. */
  function layoutFor(width, override) {
    if (override && override !== 'auto') return override;
    if (width < 200) return 'mini';
    if (width >= 560) return 'wide';
    return 'compact';
  }

  /** Mobile/composer one-liner. */
  function miniLine(st, now) {
    const m = st.main; const pct = ctxPct(m); const g = gateSummary(st);
    const running = st.agents.filter((a) => a.status === 'running' || a.status === 'starting').length;
    const parts = [];
    if (m.model) parts.push(shortModel(m.model) + (m.fallback ? ' ⚠' : ''));
    if (pct != null) parts.push(`ctx ${Math.round(pct)}%`);
    if (m.costUsd != null) parts.push(fmtCost(m.costUsd));
    const tools = g.ran + g.approved + g.error + g.denied + g.pending;
    if (tools) parts.push(`${tools} tool${tools === 1 ? '' : 's'}${g.error + g.denied ? ' ✗' + (g.error + g.denied) : ''}${g.pending ? ' · ' + g.pending + ' waiting' : ''}`);
    if (st.agents.length) parts.push(`agents ${running}/${st.agents.length}`);
    if (st.turn && st.turn.status === 'running') parts.push(fmtDuration((now || Date.now()) - st.turn.startedAt));
    return parts.join(' · ');
  }

  /** Screen-reader sentence for the gate cells (the cells themselves are colour only). */
  function gateAria(st) {
    const recent = st.gate.recent;
    const n = recent.length;
    if (!n) return 'No tool calls yet';
    const c = {};
    recent.forEach((x) => { c[x.status] = (c[x.status] || 0) + 1; });
    const words = [['ran', 'ran'], ['approved', 'approved'], ['running', 'running'], ['pending', 'waiting for approval'],
      ['error', 'failed'], ['denied', 'denied']];
    const parts = words.filter(([k]) => c[k]).map(([k, w]) => c[k] + ' ' + w);
    return `Last ${n} tool call${n === 1 ? '' : 's'}: ${parts.join(', ')}`;
  }

  // -------------------------------------------------------------- storage
  /**
   * A copy of the state sized for storage. Core keeps every extension's data in
   * ONE localStorage value that is rewritten on each save, so per-conversation
   * state must stay small. level 0 = normal, 1 = tight, 2 = minimal (instruments
   * and the receipt only).
   */
  function slimForSave(st, level) {
    const L = [[60, 60, 12, 20, 12], [24, 30, 8, 8, 6], [0, 0, 4, 0, 3]][Math.max(0, Math.min(2, level | 0))];
    const tail = (v, n) => (n > 0 ? list(v).slice(-n) : []);   // slice(-0) would keep everything
    const out = JSON.parse(JSON.stringify(st));
    out.log = tail(out.log, L[0]);
    out.gate.recent = tail(out.gate.recent, L[1]);
    out.agents = tail(out.agents, L[2]).map((a) => Object.assign({}, a, { summary: oneLine(a.summary, level ? 120 : 300) }));
    out.advisor.consults = tail(out.advisor.consults, L[3]);
    const keys = Object.keys(out.seen || {});
    keys.slice(0, Math.max(0, keys.length - L[4])).forEach((k) => { delete out.seen[k]; });
    return out;
  }

  /**
   * Which stored conversations to drop so the namespace fits `budget` chars.
   * index: session ids oldest -> newest; sizes: id -> serialized length.
   * The newest (current) conversation is never evicted.
   */
  function planEviction(index, sizes, budget, overhead) {
    const ids = list(index).slice();
    let total = (overhead || 0) + ids.reduce((s, id) => s + (sizes[id] || 0), 0);
    const drop = [];
    while (total > budget && ids.length > 1) {
      const id = ids.shift();
      drop.push(id);
      total -= sizes[id] || 0;
    }
    return { drop, keep: ids, total };
  }

  // --------------------------------------------------------------- colour
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function parseColor(s) {
    s = String(s || '').trim().toLowerCase();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
    if (m) return [m[1], m[2], m[3]].map((x) => clamp(Math.round(Number(x)), 0, 255));
    m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
    if (m) return [m[1], m[2], m[3]].map((x) => clamp(Math.round(Number(x) * 255), 0, 255));
    return null;
  }
  function luminance(rgb) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }
  function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  const toHex = (rgb) => '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  /** Nudge `fg` toward black (light bg) or white (dark bg) until it reaches `min` contrast. */
  function textSafe(fg, bg, min) {
    min = min || 4.5;
    if (!fg || !bg) return null;
    if (contrast(fg, bg) >= min) return toHex(fg);
    const target = luminance(bg) > 0.18 ? [0, 0, 0] : [255, 255, 255];
    for (let p = 0.95; p > 0; p -= 0.05) {
      const c = fg.map((v, i) => v * p + target[i] * (1 - p));
      if (contrast(c, bg) >= min) return toHex(c);
    }
    return toHex(target);
  }

  return {
    SCHEMA_VERSION, PANELS, BUCKETS, MAX_CHECKS, MAX_LOG,
    defaultState, normalize, reduce, mergeChildSessions, applyChildDetail,
    bucket, isEdit, resultKind, mask, summarize, goalsFromArgs, parseDelegation,
    fmtTokens, fmtCost, fmtDuration, shortModel, ctxPct, gateSummary, gateAria, parsePanels, layoutFor, miniLine,
    slimForSave, planEviction, parseColor, luminance, contrast, toHex, textSafe,
  };
});
