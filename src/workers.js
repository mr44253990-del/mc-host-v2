'use strict';
// Cloudflare Workers-এর মতো: worker.js আপলোড > চালু > /w/<slug> URL, ENV, KV, cron, রিকোয়েস্ট পরিসংখ্যান।
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { genId } = require('./util');

const HOST = path.join(__dirname, 'worker-host.js');
const HEAP = Number(process.env.WORKER_HEAP_MB) || 128;
const REQ_TIMEOUT = 30000;
const BUCKET = 15 * 60000; // পরিসংখ্যান ১৫ মিনিটের ঝুড়িতে (যেকোনো টাইমজোনে সঠিক "আজ" বের করতে)
const KEEP_DAYS = 31;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HOP = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');

class Workers {
  constructor(store, { max = 10 } = {}) {
    this.store = store; this.max = max;
    this.dir = path.join(store.dir, 'workers');
    fs.mkdirSync(this.dir, { recursive: true });
    store.data.workers ||= [];
    this.rt = new Map();
    this._n = 0;
    this._t = setInterval(() => this._tick(), 5000); this._t.unref();
    this._s = setInterval(() => this.flushStats(), 20000); this._s.unref();
  }

  all() { return (this.store.data.workers ||= []); }
  get(id) { return this.all().find((w) => w.id === id); }
  bySlug(s) { return this.all().find((w) => w.slug === s); }
  codeFile(id) { return path.join(this.dir, id + '.mjs'); }
  prevFile(id) { return path.join(this.dir, id + '.prev.mjs'); }
  kvFile(id) { return path.join(this.dir, id + '.kv.json'); }
  statsFile(id) { return path.join(this.dir, id + '.stats.json'); }
  readCode(id) { try { return fs.readFileSync(this.codeFile(id), 'utf8'); } catch { return ''; } }
  hasPrev(id) { return fs.existsSync(this.prevFile(id)); }
  writeCode(id, code) {
    const f = this.codeFile(id);
    if (fs.existsSync(f)) fs.copyFileSync(f, this.prevFile(id));
    fs.writeFileSync(f, code);
    fs.rmSync(f.replace(/\.mjs$/, '.cjs'), { force: true });
  }

  _rt(id) {
    if (!this.rt.has(id)) this.rt.set(id, { state: 'stopped', proc: null, pending: new Map(), logs: [], recent: [], lat: [], seq: 0, inflight: 0, lastBeat: 0, startedAt: 0, fails: 0, error: '', manual: false, waiters: [], timer: null, restartTimer: null, lastCron: 0, kvKeys: 0, stats: null, dirty: false, readyAt: 0 });
    return this.rt.get(id);
  }

  view(w) {
    const rt = this._rt(w.id);
    return { id: w.id, name: w.name, slug: w.slug, enabled: !!w.enabled, cronMin: w.cronMin || 0, envCount: (w.env || []).length, createdAt: w.createdAt, updatedAt: w.updatedAt, state: rt.state, error: rt.error, startedAt: rt.startedAt, inflight: rt.inflight, hasPrev: this.hasPrev(w.id), kvKeys: rt.kvKeys };
  }

  // ---------- validation helpers ----------
  cleanEnv(list, old = []) {
    const out = []; const seen = new Set();
    for (const e of (Array.isArray(list) ? list : []).slice(0, 50)) {
      const key = String(e.key || '').trim();
      if (!key) continue;
      if (!ENV_RE.test(key)) throw new Error(`ENV নাম সঠিক নয়: ${key}`);
      if (seen.has(key)) throw new Error(`ENV নাম দুইবার: ${key}`);
      seen.add(key);
      let value = String(e.value ?? '').slice(0, 4096);
      const secret = !!e.secret;
      if (secret && value === '') { const o = old.find((x) => x.key === key); if (o) value = o.value; }
      out.push({ key, value, secret });
    }
    return out;
  }

  uniqueSlug(base, selfId) {
    let s = slugify(base) || 'worker-' + genId().slice(0, 4);
    if (s.length < 2) s += '-w';
    let n = 1; let c = s;
    while (this.all().some((w) => w.slug === c && w.id !== selfId)) { n++; c = `${s.slice(0, 36)}-${n}`; }
    return c;
  }

  // ---------- CRUD ----------
  create({ name, slug, code, env, cronMin }) {
    if (this.all().length >= this.max) throw new Error(`সর্বোচ্চ ${this.max}টি Worker`);
    const n = String(name || '').trim().slice(0, 60);
    if (!n) throw new Error('নাম দিন');
    if (!String(code || '').trim()) throw new Error('worker.js ফাঁকা');
    if (slug && !SLUG_RE.test(String(slug))) throw new Error('URL নাম: ছোট হাতের a-z, 0-9, হাইফেন (২-৪০ অক্ষর)');
    if (slug && this.bySlug(slug)) throw new Error('এই URL নাম আগেই আছে');
    const w = { id: genId(), name: n, slug: slug || this.uniqueSlug(n), enabled: true, env: this.cleanEnv(env), cronMin: Math.max(0, Math.min(1440, Number(cronMin) || 0)), createdAt: Date.now(), updatedAt: Date.now() };
    this.all().push(w);
    this.writeCode(w.id, String(code));
    this.store.save();
    return w;
  }

  update(w, { name, slug, cronMin }) {
    if (name !== undefined) { const n = String(name).trim().slice(0, 60); if (!n) throw new Error('নাম ফাঁকা'); w.name = n; }
    if (slug !== undefined && slug !== w.slug) {
      if (!SLUG_RE.test(String(slug))) throw new Error('URL নাম সঠিক নয়');
      if (this.bySlug(slug)) throw new Error('এই URL নাম আগেই আছে');
      w.slug = slug;
    }
    if (cronMin !== undefined) w.cronMin = Math.max(0, Math.min(1440, Number(cronMin) || 0));
    w.updatedAt = Date.now();
    this.store.save();
  }

  async remove(id) {
    await this.stop(id, { keep: true });
    this.store.data.workers = this.all().filter((w) => w.id !== id);
    for (const f of [this.codeFile(id), this.prevFile(id), this.kvFile(id), this.statsFile(id), this.codeFile(id).replace(/\.mjs$/, '.cjs')]) fs.rmSync(f, { force: true });
    this.rt.delete(id);
    this.store.save();
  }

  // ---------- lifecycle ----------
  _spawn(w) {
    const rt = this._rt(w.id);
    clearTimeout(rt.restartTimer);
    rt.state = 'starting'; rt.error = ''; rt.startedAt = Date.now(); rt.lastBeat = Date.now(); rt.manual = false; rt.readyAt = 0; rt.loadFailed = false;
    const cfg = { file: this.codeFile(w.id), kv: this.kvFile(w.id), name: w.name, slug: w.slug, env: Object.fromEntries((w.env || []).map((e) => [e.key, e.value])) };
    const proc = spawn(process.execPath, [`--max-old-space-size=${HEAP}`, HOST], { cwd: this.dir, env: { PATH: process.env.PATH, NODE_ENV: 'production', WK_CONFIG: JSON.stringify(cfg) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    rt.proc = proc;
    this._pipe(proc.stdout, rt, false); this._pipe(proc.stderr, rt, true);
    clearTimeout(rt.timer);
    rt.timer = setTimeout(() => { if (rt.state === 'starting' && rt.proc === proc) { rt.error = 'লোড হতে ১০ সেকেন্ডের বেশি লাগছে (top-level await আটকে?)'; this._fail(rt, w, rt.error, true); try { proc.kill('SIGKILL'); } catch { /* gone */ } } }, 10000);
    proc.on('message', (m) => this._msg(w, rt, m));
    proc.on('error', (e) => this._fail(rt, w, e.message, true));
    proc.on('exit', (code, sig) => {
      if (rt.proc !== proc) return;
      rt.proc = null; clearTimeout(rt.timer);
      for (const [, p] of rt.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Worker বন্ধ হয়ে গেছে'), { code: 502 })); }
      rt.pending.clear();
      if (rt.manual) { rt.state = 'stopped'; return; }
      if (rt.loadFailed) return;
      if (rt.state === 'starting') return this._fail(rt, w, rt.error || `লোড হয়নি (exit ${code ?? sig})`, true);
      rt.fails++;
      rt.error = `ক্র্যাশ (exit ${code ?? sig})`;
      rt.state = 'error';
      this._log(rt, '! ' + rt.error);
      const w2 = this.get(w.id);
      if (w2 && w2.enabled) rt.restartTimer = setTimeout(() => { const x = this.get(w.id); if (x && x.enabled && !rt.proc) this._spawn(x); }, Math.min(30000, 1000 * 2 ** Math.min(rt.fails, 5)));
    });
  }

  _fail(rt, w, msg, loadError) {
    rt.state = 'error'; rt.error = msg; if (loadError) rt.loadFailed = true;
    this._log(rt, '! ' + msg.split('\n')[0]);
    const ws = rt.waiters; rt.waiters = [];
    ws.forEach((f) => f({ ok: false, error: msg }));
    if (loadError && rt.proc) { try { rt.proc.kill('SIGKILL'); } catch { /* gone */ } }
  }

  _msg(w, rt, m) {
    if (!m) return;
    if (m.t === 'hb') rt.lastBeat = Date.now();
    else if (m.t === 'ready') {
      clearTimeout(rt.timer); rt.state = 'running'; rt.error = ''; rt.readyAt = Date.now(); rt.lastBeat = Date.now(); rt.kvKeys = m.kv || 0;
      this._log(rt, 'চালু হয়েছে');
      const ws = rt.waiters; rt.waiters = []; ws.forEach((f) => f({ ok: true }));
      setTimeout(() => { if (rt.state === 'running') rt.fails = 0; }, 60000).unref();
    } else if (m.t === 'fatal') { clearTimeout(rt.timer); this._fail(rt, w, m.message || 'লোড ব্যর্থ', true); }
    else if (m.t === 'kv') rt.kvKeys = m.n;
    else if (m.t === 'res') {
      const p = rt.pending.get(m.id); if (!p) return;
      rt.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error), { code: 500 }));
      else p.resolve({ status: m.status, headers: m.headers, body: Buffer.from(m.body || '', 'base64') });
    }
  }

  _pipe(stream, rt, isErr) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1); if (line) this._log(rt, (isErr ? '! ' : '') + line.slice(0, 400)); }
      if (buf.length > 6000) buf = '';
    });
  }

  _log(rt, line) {
    rt.logs.push(`${new Date().toTimeString().slice(0, 8)} ${line}`);
    if (rt.logs.length > 300) rt.logs.splice(0, rt.logs.length - 300);
  }

  logs(id) { return this._rt(id).logs.slice(-200); }

  // চালু করে ready/ব্যর্থ না হওয়া পর্যন্ত অপেক্ষা
  async _startWait(w) {
    await this.stop(w.id, { keep: true });
    const rt = this._rt(w.id);
    return new Promise((resolve) => { rt.waiters.push(resolve); this._spawn(w); });
  }

  // নতুন কোডসহ নিরাপদ ডিপ্লয়: লোড ব্যর্থ হলে আগের কোড ফেরত
  async deploy(id, newCode) {
    const w = this.get(id); if (!w) return { ok: false, error: 'Worker নেই' };
    const prevCode = this.readCode(id);
    if (newCode !== undefined) this.writeCode(id, newCode);
    w.enabled = true; w.updatedAt = Date.now(); this.store.save();
    const r = await this._startWait(w);
    if (!r.ok && newCode !== undefined && prevCode) {
      fs.writeFileSync(this.codeFile(id), prevCode);
      await this._startWait(w).catch(() => {});
      return { ok: false, error: r.error, rolledBack: true };
    }
    return r;
  }

  async rollback(id) {
    if (!this.hasPrev(id)) return { ok: false, error: 'আগের সংস্করণ নেই' };
    const cur = this.readCode(id); const prev = fs.readFileSync(this.prevFile(id), 'utf8');
    fs.writeFileSync(this.codeFile(id), prev); fs.writeFileSync(this.prevFile(id), cur);
    return this.deploy(id);
  }

  async start(id) { const w = this.get(id); if (!w) return { ok: false, error: 'Worker নেই' }; w.enabled = true; this.store.save(); return this._startWait(w); }
  async restart(id) { return this.start(id); }

  stop(id, { keep = false } = {}) {
    return new Promise((resolve) => {
      const w = this.get(id); const rt = this._rt(id);
      if (w && !keep) { w.enabled = false; this.store.save(); }
      rt.manual = true; clearTimeout(rt.restartTimer); clearTimeout(rt.timer);
      const p = rt.proc;
      if (!p) { rt.state = 'stopped'; rt.error = keep ? rt.error : ''; return resolve(); }
      p.once('exit', () => resolve());
      setTimeout(resolve, 4000).unref();
      try { p.send({ t: 'shutdown' }); } catch { /* ipc closed */ }
      setTimeout(() => { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch { /* gone */ } }, 2500).unref();
      rt.state = 'stopped'; if (!keep) rt.error = '';
    });
  }

  async stopAll() { this.flushStats(); await Promise.all(this.all().map((w) => this.stop(w.id, { keep: true }))); }
  autostart() { let i = 0; for (const w of this.all()) if (w.enabled) setTimeout(() => this._startWait(w).catch(() => {}), 800 * i++); }

  _tick() {
    this._n++;
    for (const w of this.all()) {
      const rt = this._rt(w.id);
      if (rt.state === 'running' && rt.proc && Date.now() - rt.lastBeat > 20000) {
        this._log(rt, '! event loop আটকে গিয়েছিল, রিস্টার্ট');
        rt.error = 'event loop আটকে ছিল'; try { rt.proc.kill('SIGKILL'); } catch { /* gone */ }
      }
      if (this._n % 3 === 0 && w.cronMin > 0 && rt.state === 'running' && Date.now() - (rt.lastCron || rt.readyAt) >= w.cronMin * 60000) {
        rt.lastCron = Date.now();
        try { rt.proc.send({ t: 'cron', cron: `every ${w.cronMin}m` }); } catch { /* ipc closed */ }
      }
    }
  }

  // ---------- ইনকামিং রিকোয়েস্ট ----------
  _call(rt, payload) {
    return new Promise((resolve, reject) => {
      const id = ++rt.seq;
      const timer = setTimeout(() => { rt.pending.delete(id); reject(Object.assign(new Error('Worker ৩০ সেকেন্ডে উত্তর দেয়নি'), { code: 504 })); }, REQ_TIMEOUT);
      rt.pending.set(id, { resolve, reject, timer });
      try { rt.proc.send({ t: 'req', id, ...payload }); } catch (e) { clearTimeout(timer); rt.pending.delete(id); reject(Object.assign(e, { code: 502 })); }
    });
  }

  async serve(req, res) {
    const w = this.bySlug(req.params.slug);
    if (!w) return res.status(404).type('text').send('Worker not found');
    const rt = this._rt(w.id);
    if (!w.enabled) return res.status(503).type('text').send('Worker is stopped');
    for (let i = 0; i < 50 && rt.state === 'starting'; i++) await new Promise((r) => setTimeout(r, 100));
    if (rt.state !== 'running' || !rt.proc) { this._rec(w, rt, 503, 0, req, 'unavailable'); return res.status(503).type('text').send('Worker unavailable'); }
    if (rt.inflight >= 100) return res.status(429).type('text').send('Too many requests');

    const origin = `${req.protocol}://${req.get('host')}`;
    const rest = String(req.params[0] || '');
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['content-length', 'connection', 'transfer-encoding'].includes(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    if (headers.cookie) headers.cookie = headers.cookie.split(';').map((s) => s.trim()).filter((s) => !s.startsWith('mch=')).join('; ');
    if (!headers.cookie) delete headers.cookie;
    delete headers['x-mch-token'];
    headers['cf-connecting-ip'] = req.ip || '';
    const body = Buffer.isBuffer(req.body) && req.body.length ? req.body.toString('base64') : null;

    const t0 = Date.now(); rt.inflight++;
    let out; let err = '';
    try { out = await this._call(rt, { method: req.method, url: `${origin}/${rest}${qs}`, headers, body }); } catch (e) {
      err = e.message || 'error';
      this._log(rt, '! ' + err.split('\n').slice(0, 3).join(' | '));
      out = { status: e.code === 504 ? 504 : e.code === 502 ? 502 : 500, headers: [['content-type', 'text/plain; charset=utf-8']], body: Buffer.from(e.code === 504 ? 'Worker timed out' : e.code === 502 ? 'Worker unavailable' : 'Worker threw exception') };
    } finally { rt.inflight--; }
    const ms = Date.now() - t0;
    this._rec(w, rt, out.status, ms, req, err);

    res.status(out.status);
    for (const [k, v] of out.headers) { if (HOP.has(k)) continue; try { res.append(k, v); } catch { /* invalid header */ } }
    res.set('content-length', String(out.body.length));
    res.end(req.method === 'HEAD' ? undefined : out.body);
  }

  // ---------- পরিসংখ্যান ----------
  stats(id) {
    const rt = this._rt(id);
    if (!rt.stats) { try { rt.stats = JSON.parse(fs.readFileSync(this.statsFile(id), 'utf8')); } catch { rt.stats = { t: 0, e: 0, b: {} }; } }
    return rt.stats;
  }

  // বাকেট: [req, msSum, s2xx, s3xx, s4xx, s5xx]
  _rec(w, rt, status, ms, req, err) {
    const st = this.stats(w.id); const k = Math.floor(Date.now() / BUCKET);
    const a = (st.b[k] ||= [0, 0, 0, 0, 0, 0]);
    a[0]++; a[1] += Math.round(ms);
    a[status >= 500 ? 5 : status >= 400 ? 4 : status >= 300 ? 3 : 2]++;
    st.t++; if (status >= 500) st.e++;
    rt.dirty = true;
    rt.lat.push(ms); if (rt.lat.length > 200) rt.lat.shift();
    const p = (req.originalUrl || '').slice(0, 120);
    rt.recent.push({ t: Date.now(), method: req.method, path: p.replace(/^\/w\/[^/?]+/, '') || '/', status, ms, err: err ? err.split('\n')[0].slice(0, 120) : '' });
    if (rt.recent.length > 60) rt.recent.shift();
  }

  flushStats() {
    const cutoff = Math.floor((Date.now() - KEEP_DAYS * 86400000) / BUCKET);
    for (const [id, rt] of this.rt) {
      if (!rt.dirty || !rt.stats) continue;
      for (const k of Object.keys(rt.stats.b)) if (Number(k) < cutoff) delete rt.stats.b[k];
      try { fs.writeFileSync(this.statsFile(id) + '.tmp', JSON.stringify(rt.stats)); fs.renameSync(this.statsFile(id) + '.tmp', this.statsFile(id)); rt.dirty = false; } catch { /* ignore */ }
    }
  }

  // tzMin = JS getTimezoneOffset() (UTC+6 হলে -360)
  agg(ids, tzMin = 0) {
    const off = -Number(tzMin || 0) * 60000, hr = 3600000, day = 86400000, now = Date.now();
    const dayStart = Math.floor((now + off) / day) * day - off;
    const hourStart = Math.floor((now + off) / hr) * hr - off;
    const z = () => ({ req: 0, err: 0, ms: 0 });
    const out = { today: z(), yesterday: z(), d7: z(), d30: z(), total: 0, totalErr: 0, hours: [], days: [], codesToday: [0, 0, 0, 0], codes30: [0, 0, 0, 0] };
    for (let i = 0; i < 24; i++) out.hours.push({ req: 0, err: 0, label: String((((Math.floor((hourStart - (23 - i) * hr + off) / hr)) % 24) + 24) % 24) });
    for (let i = 0; i < 14; i++) { const d = new Date(dayStart - (13 - i) * day + off); out.days.push({ req: 0, err: 0, label: `${d.getUTCDate()}/${d.getUTCMonth() + 1}` }); }
    const add = (o, a) => { o.req += a[0]; o.err += a[5]; o.ms += a[1]; };
    for (const id of ids) {
      const st = this.stats(id); out.total += st.t; out.totalErr += st.e;
      for (const [k, a] of Object.entries(st.b)) {
        const t = Number(k) * BUCKET;
        const dIdx = Math.floor((dayStart - (Math.floor((t + off) / day) * day - off)) / day);
        const hIdx = Math.floor((hourStart - (Math.floor((t + off) / hr) * hr - off)) / hr);
        if (dIdx < 0 || dIdx > 30) continue;
        add(out.d30, a); for (let c = 0; c < 4; c++) out.codes30[c] += a[2 + c];
        if (dIdx < 7) add(out.d7, a);
        if (dIdx === 0) { add(out.today, a); for (let c = 0; c < 4; c++) out.codesToday[c] += a[2 + c]; }
        if (dIdx === 1) add(out.yesterday, a);
        if (dIdx < 14) { out.days[13 - dIdx].req += a[0]; out.days[13 - dIdx].err += a[5]; }
        if (hIdx >= 0 && hIdx < 24) { out.hours[23 - hIdx].req += a[0]; out.hours[23 - hIdx].err += a[5]; }
      }
    }
    return out;
  }

  latency(id) {
    const l = [...this._rt(id).lat].sort((a, b) => a - b);
    if (!l.length) return { p50: 0, p95: 0, n: 0 };
    return { p50: l[Math.floor(l.length * 0.5)], p95: l[Math.min(l.length - 1, Math.floor(l.length * 0.95))], n: l.length };
  }

  recent(id) { return [...this._rt(id).recent].reverse().slice(0, 40); }
}

module.exports = Workers;
module.exports.slugify = slugify;
