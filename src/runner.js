'use strict';
const { spawn } = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const { diagnose } = require('./util');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'preload.js');
const HEAP = Number(process.env.MC_BOT_HEAP_MB) || 192;
const LABELS = { online: 'অনলাইন', starting: 'কানেক্ট হচ্ছে', reconnecting: 'রিকানেক্ট হবে', stopped: 'বন্ধ' };
const WATCHDOG_MS = 60000;

class Runner extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.rt = new Map();
    this.feed = [];
    this._wd = setInterval(() => this._watchdog(), 10000);
    this._wd.unref();
  }

  _rt(id) {
    if (!this.rt.has(id)) {
      this.rt.set(id, {
        state: 'stopped', proc: null, timer: null, manual: false,
        attempts: 0, restarts: 0, onlineSince: 0, startedAt: 0, nextAt: 0, lastExit: 0, lastBeat: 0,
        lastReason: '', lastKick: '', lastErr: '', info: null, logs: [], events: [],
        wasOnline: false, hadProblem: false, userInit: false, wdKilled: false,
      });
    }
    return this.rt.get(id);
  }

  _stats(bot) {
    return (bot.stats ||= { sessions: 0, crashes: 0, upMs: 0, since: Date.now(), reasons: {} });
  }

  state(id) { return this._rt(id).state; }
  uptime(id) { const rt = this._rt(id); return rt.onlineSince ? Date.now() - rt.onlineSince : 0; }
  logs(id, n = 20) { return this._rt(id).logs.slice(-n); }
  events(id, n = 40) { return this._rt(id).events.slice(-n); }

  // স্বাস্থ্য স্কোর (০-১০০): আপটাইম অনুপাত, ঘনঘন ক্র্যাশ ও বর্তমান অবস্থা মিলিয়ে
  health(bot) {
    const rt = this._rt(bot.id);
    const st = this._stats(bot);
    const live = rt.onlineSince ? Date.now() - rt.onlineSince : 0;
    const span = Date.now() - st.since;
    const pad = Math.max(0, 600000 - span); // নতুন বটকে প্রথম ১০ মিনিট ন্যায্য স্কোর
    const ratio = Math.min(1, (st.upMs + live + pad) / (span + pad));
    let score = ratio * 70;
    score += rt.state === 'online' ? 20 : rt.state === 'starting' ? 8 : 0;
    score -= Math.min(30, st.crashes * 1.5);
    if (rt.state === 'online' && live > 3600000) score += 10;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  snapshot(id) {
    const rt = this._rt(id);
    const bot = this.store.bot(id);
    const st = bot ? this._stats(bot) : null;
    return {
      state: rt.state,
      label: LABELS[rt.state],
      onlineSince: rt.onlineSince,
      startedAt: rt.startedAt,
      attempts: rt.attempts,
      restarts: rt.restarts,
      nextIn: rt.state === 'reconnecting' ? Math.max(0, Math.ceil((rt.nextAt - Date.now()) / 1000)) : 0,
      reason: rt.lastReason,
      diag: rt.lastReason ? diagnose(rt.lastReason) : null,
      lastExit: rt.lastExit,
      info: rt.state === 'online' ? rt.info : null,
      health: bot ? this.health(bot) : 0,
      strip: (rt.hist || []).join(''),
      stats: st ? { ...st, upMs: st.upMs + (rt.onlineSince ? Date.now() - rt.onlineSince : 0) } : null,
    };
  }

  fleet() {
    let online = 0, mem = 0, total = 0;
    for (const b of this.store.data.bots) {
      total++;
      const rt = this._rt(b.id);
      if (rt.state === 'online') { online++; mem += (rt.info && rt.info.mem) || 0; }
    }
    return { online, total, mem };
  }

  // ---------- control ----------
  start(id, { user = false } = {}) {
    const bot = this.store.bot(id);
    if (!bot) return { ok: false, error: 'বট পাওয়া যায়নি' };
    const rt = this._rt(id);
    if (rt.proc || rt.timer) return { ok: false, error: 'বট ইতিমধ্যে চলছে' };
    rt.manual = false;
    rt.userInit = user;
    if (user) { rt.attempts = 0; rt.lastReason = ''; rt.lastKick = ''; rt.lastErr = ''; }
    bot.desired = true;
    this.store.save();
    this._spawn(bot, rt);
    return { ok: true };
  }

  stop(id, { keepDesired = false } = {}) {
    return new Promise((resolve) => {
      const rt = this._rt(id);
      const bot = this.store.bot(id);
      rt.manual = true;
      clearTimeout(rt.timer);
      rt.timer = null;
      if (bot && !keepDesired) { bot.desired = false; this.store.save(); }
      const p = rt.proc;
      if (!p) { rt.state = 'stopped'; rt.onlineSince = 0; rt.info = null; return resolve(); }
      p.once('exit', () => resolve());
      setTimeout(resolve, 5000).unref();
      try { p.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch { /* ignore */ } }, 3000).unref();
    });
  }

  async restart(id) { await this.stop(id); return this.start(id, { user: true }); }
  startAll() { let n = 0; for (const b of this.store.data.bots) if (this.start(b.id, { user: true }).ok) n++; return n; }
  async restartAll() { for (const b of this.store.data.bots) if (this.state(b.id) !== 'stopped') await this.restart(b.id); }
  async stopAll(opts) { await Promise.all([...this.rt.keys()].map((id) => this.stop(id, opts))); }

  say(id, text) {
    const rt = this._rt(id);
    if (rt.state !== 'online' || !rt.proc || !rt.proc.connected) return false;
    rt.proc.send({ t: 'chat', text: String(text).slice(0, 250) });
    this._log(rt, '> ' + String(text).slice(0, 120));
    return true;
  }

  autostart() {
    let i = 0;
    for (const b of this.store.data.bots) if (b.desired) setTimeout(() => this.start(b.id), 2500 * i++);
  }

  // ---------- internals ----------
  _log(rt, line) {
    const t = new Date().toTimeString().slice(0, 8);
    rt.logs.push(`${t} ${line}`);
    if (rt.logs.length > 300) rt.logs.splice(0, rt.logs.length - 300);
  }

  _ev(rt, type, text, bot) {
    const e = { t: Date.now(), type, text: String(text).slice(0, 200) };
    rt.events.push(e);
    const b = bot || rt._bot;
    this.feed.push({ ...e, bot: b ? b.username : '', id: b ? b.id : '' });
    if (this.feed.length > 80) this.feed.splice(0, this.feed.length - 80);
    if (rt.events.length > 100) rt.events.splice(0, rt.events.length - 100);
  }

  _watchdog() {
    this._tick = (this._tick || 0) + 1;
    for (const b of this.store.data.bots) {
      const rt = this._rt(b.id);
      if (this._tick % 6 === 0) { rt.hist = rt.hist || []; rt.hist.push({ online: 'o', starting: 's', reconnecting: 'r', stopped: 'x' }[rt.state]); if (rt.hist.length > 120) rt.hist.shift(); }
      const h = Number(b.autoRestartHours) || 0;
      if (h > 0 && rt.state === 'online' && rt.onlineSince && Date.now() - rt.onlineSince > h * 3600000 && !rt.sched) {
        rt.sched = true;
        this._log(rt, `নির্ধারিত অটো-রিস্টার্ট (${h} ঘণ্টা)`);
        this._ev(rt, 'sched', `${h} ঘণ্টা পূর্ণ, রিস্টার্ট`);
        this.restart(b.id).finally(() => { rt.sched = false; });
      }
    }
    for (const [id, rt] of this.rt) {
      if (rt.state === 'online' && rt.proc && rt.lastBeat && Date.now() - rt.lastBeat > WATCHDOG_MS) {
        this._log(rt, 'watchdog: ৬০ সেকেন্ড কোনো সাড়া নেই, প্রসেস রিস্টার্ট');
        this._ev(rt, 'watchdog', 'বট জমে গিয়েছিল');
        rt.lastErr = 'watchdog timeout';
        rt.wdKilled = true;
        try { rt.proc.kill('SIGKILL'); } catch { /* ignore */ }
        rt.lastBeat = 0;
      }
    }
  }

  _spawn(bot, rt) {
    rt._bot = bot;
    rt.state = 'starting';
    rt.startedAt = Date.now();
    rt.onlineSince = 0;
    rt.info = null;
    rt.lastBeat = 0;
    rt.lastKick = '';
    rt.lastErr = '';
    this._log(rt, `start ${bot.host}:${bot.port} as ${bot.username}`);
    this._ev(rt, 'start', `${bot.host}:${bot.port}`);

    const env = {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      NODE_PATH: path.join(ROOT, 'node_modules'),
      MC_BOT_ID: bot.id, MC_HOST: bot.host, MC_PORT: String(bot.port),
      MC_USERNAME: bot.username, MC_VERSION: bot.version || '', MC_AUTH: 'offline',
    };

    let proc;
    try {
      proc = spawn(process.execPath, [`--max-old-space-size=${HEAP}`, '-r', PRELOAD, this.store.scriptPath(bot.id)], {
        cwd: this.store.dir, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (e) {
      rt.lastErr = e.message;
      return this._exited(bot, rt, 1, null);
    }
    rt.proc = proc;
    proc.on('message', (m) => this._msg(bot, rt, m));
    this._pipe(proc.stdout, rt, false);
    this._pipe(proc.stderr, rt, true);
    proc.on('error', (e) => {
      rt.lastErr = e.message;
      if (!proc.pid && rt.proc === proc) { rt.proc = null; this._exited(bot, rt, 1, null); }
    });
    proc.on('exit', (code, sig) => {
      if (rt.proc !== proc) return;
      rt.proc = null;
      this._exited(bot, rt, code, sig);
    });
  }

  _pipe(stream, rt, isErr) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trimEnd();
        buf = buf.slice(i + 1);
        if (line) this._log(rt, (isErr ? '! ' : '') + line.slice(0, 300));
      }
      if (buf.length > 4000) buf = '';
    });
  }

  _sessionEnd(bot, rt) {
    if (!rt.onlineSince) return 0;
    const up = Date.now() - rt.onlineSince;
    this._stats(bot).upMs += up;
    rt.onlineSince = 0;
    this.store.save();
    return up;
  }

  _msg(bot, rt, m) {
    if (!m || typeof m !== 'object') return;
    rt.lastBeat = Date.now();
    if (m.t === 'state') {
      if (m.state === 'connecting' && rt.state !== 'online') rt.state = 'starting';
      else if (m.state === 'online' && rt.state !== 'online') {
        rt.state = 'online';
        rt.onlineSince = Date.now();
        rt.wasOnline = true;
        this._stats(bot).sessions++;
        this._log(rt, 'সার্ভারে ঢুকেছে');
        this._ev(rt, 'online', 'সার্ভারে ঢুকেছে');
        if (rt.hadProblem || !rt.userInit) this._emit('online', bot, { recovered: rt.hadProblem });
        rt.hadProblem = false;
        rt.userInit = false;
      } else if (m.state === 'offline') {
        const was = rt.wasOnline;
        rt.state = 'reconnecting';
        rt.nextAt = Date.now() + 8000;
        rt.lastReason = rt.lastKick || rt.lastErr || m.reason || '';
        this._sessionEnd(bot, rt);
        rt.info = null;
        if (was) {
          rt.wasOnline = false;
          rt.hadProblem = true;
          this._ev(rt, 'offline', rt.lastReason || 'কানেকশন কেটেছে');
          this._emit('offline', bot, { reason: rt.lastReason, nextIn: 8 });
        }
      }
    } else if (m.t === 'info') rt.info = m.info;
    else if (m.t === 'kick') { rt.lastKick = m.reason; this._log(rt, 'kicked: ' + m.reason); this._ev(rt, 'kick', m.reason); }
    else if (m.t === 'error') { rt.lastErr = m.message; this._log(rt, '! ' + m.message); }
  }

  // রিকানেক্ট বিলম্ব: এক্সপোনেনশিয়াল + জিটার; স্থায়ী কারণে (ব্যান, ভার্সন, স্ক্রিপ্ট ত্রুটি) ধীর গতি
  _delay(attempts, diag) {
    const base = diag && diag.slow ? 60000 : 5000;
    const cap = diag && diag.slow ? 300000 : 120000;
    const d = Math.min(cap, base * 2 ** Math.min(attempts - 1, 5));
    return Math.round(d * (0.85 + Math.random() * 0.3));
  }

  _exited(bot, rt, code, sig) {
    const upFor = this._sessionEnd(bot, rt);
    rt.info = null;
    if (rt.manual) { rt.state = 'stopped'; this._log(rt, 'বন্ধ করা হয়েছে'); this._ev(rt, 'stop', 'ম্যানুয়ালি বন্ধ'); return; }

    const st = this._stats(bot);
    st.crashes++;
    rt.restarts++;
    if (upFor > 60000) rt.attempts = 0;
    rt.attempts++;
    rt.lastReason = rt.lastKick || rt.lastErr || rt.lastReason || `exit code ${code}${sig ? ' ' + sig : ''}`;
    rt.lastExit = Date.now();
    rt.wdKilled = false;
    const diag = diagnose(rt.lastReason);
    if (diag) st.reasons[diag.key] = (st.reasons[diag.key] || 0) + 1;

    const delay = this._delay(rt.attempts, diag);
    rt.state = 'reconnecting';
    rt.nextAt = Date.now() + delay;
    this._log(rt, `${Math.round(delay / 1000)} সেকেন্ড পরে আবার চেষ্টা (#${rt.attempts}): ${rt.lastReason}`.slice(0, 300));
    this._ev(rt, 'retry', `#${rt.attempts} ${Math.round(delay / 1000)}s`);

    if (rt.wasOnline) {
      rt.wasOnline = false;
      rt.hadProblem = true;
      this._emit('offline', bot, { reason: rt.lastReason, nextIn: Math.round(delay / 1000) });
    } else if ([2, 5, 15, 40, 100].includes(rt.attempts)) {
      rt.hadProblem = true;
      this._emit('failing', bot, { reason: rt.lastReason, attempts: rt.attempts, nextIn: Math.round(delay / 1000) });
    }
    this.store.save();

    rt.timer = setTimeout(() => {
      rt.timer = null;
      const b = this.store.bot(bot.id);
      if (b && !rt.manual) this._spawn(b, rt);
    }, delay);
  }

  _emit(type, bot, extra) { this.emit('event', { type, bot, ...extra }); }
}

module.exports = Runner;
