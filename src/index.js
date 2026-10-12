'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const store = require('./store');
const Runner = require('./runner');
const Ai = require('./ai');
const Tg = require('./tg');
const { genId, parseHost, validName } = require('./util');
const Sec = require('./security');
const GDrive = require('./gdrive');
const ADMIN_ONLY = /^\/(tokens|users|settings|password|restore|backup|gdrive|hooks|reports)(\/|$)/;
const TEMPLATES = require('./templates');
const Workers = require('./workers');
const sys = require('./sys');
const insights = require('./insights');
const WK_TEMPLATES = require('./worker-templates');

// Wispbyte / Pterodactyl: SERVER_PORT, Render/Heroku/Railway: PORT, নইলে 11336
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || process.env.APP_PORT || 11336);
const HOST = '0.0.0.0';
const MAX_MC = Number(process.env.MAX_MC_BOTS) || 5;
const MAX_TG = Number(process.env.MAX_TG_BOTS) || 3;
const MAX_WK = Number(process.env.MAX_WORKERS) || 10;
const DEFAULT_SCRIPT = fs.readFileSync(path.join(__dirname, 'default-bot.js'), 'utf8');
const started = Date.now();

const ok = (res, extra = {}) => res.json({ ok: true, ...extra });
const fail = (res, error, code = 400) => res.status(code).json({ ok: false, error });

(async () => {
  await store.init();

  // পাসওয়ার্ড: ড্যাশবোর্ডে বদলানো > ENV > অটো। ENV-এর ফাঁকা জায়গা ও উদ্ধৃতি চিহ্ন বাদ দেওয়া হয়
  const clean = (v) => String(v || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  const envPw = clean(process.env.ADMIN_PASSWORD);
  // ড্যাশবোর্ডে পাসওয়ার্ড বদলানোর পর ENV-এর মান পাল্টালে ENV জেতে (ভুলে গেলে এটাই উদ্ধারের উপায়)
  if (store.setting('customPassword') && envPw && envPw !== store.setting('customPasswordEnv', envPw)) store.setSetting('customPassword', '');
  let password = clean(store.setting('customPassword')) || envPw || store.setting('autoPassword');
  if (!password) { password = crypto.randomBytes(5).toString('hex'); store.setSetting('autoPassword', password); }
  const pwMode = () => (store.setting('customPassword') ? 'custom' : envPw ? 'env' : 'auto');
  console.log(pwMode() === 'auto' ? `[auth] ADMIN_PASSWORD সেট নেই। অটো পাসওয়ার্ড: ${password}` : `[auth] পাসওয়ার্ড উৎস: ${pwMode() === 'custom' ? 'ড্যাশবোর্ডে বদলানো' : 'ADMIN_PASSWORD env'} (দৈর্ঘ্য ${password.length})`);
  const sec = () => crypto.createHash('sha256').update('mchost|' + password).digest();
  const sign = (v) => crypto.createHmac('sha256', sec()).update(v).digest('hex');
  const mkCookie = (role = 'admin', uid = 'owner') => { const body = `${Date.now() + 7 * 864e5}.${role}.${uid}`; return `${body}.${sign(body)}`; };
  const readSession = (c) => {
    if (!c) return null;
    const p = c.split('.'); if (p.length !== 4) return null;
    const [exp, role, uid, sig] = p;
    if (!(Number(exp) > Date.now()) || !['admin', 'operator', 'viewer'].includes(role)) return null;
    const body = `${exp}.${role}.${uid}`;
    const x = Buffer.from(sig), y = Buffer.from(sign(body));
    if (!(x.length === y.length && crypto.timingSafeEqual(x, y))) return null;
    return { role, uid, via: 'session' };
  };
  const cookieOf = (req) => (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('mch='))?.slice(4) || String(req.headers['x-mch-token'] || '');
  // সেশন: Authorization: Bearer mcht_... (API টোকেন) > x-mch-token / কুকি (ব্রাউজার সেশন)
  const getSession = (req) => {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const raw = bearer || cookieOf(req);
    if (raw.startsWith('mcht_')) {
      const h = Sec.sha256(raw);
      const t = (store.data.tokens || []).find((x) => x.hash === h);
      if (!t) return null;
      t.lastUsed = Date.now();
      return { role: t.scope === 'control' ? 'operator' : 'viewer', uid: 'token:' + t.id, via: 'token', name: 'টোকেন: ' + t.name };
    }
    return readSession(raw);
  };
  const setCookie = (req, res, token) => res.setHeader('Set-Cookie', `mch=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${req.secure ? '; Secure' : ''}`);
  const LIMIT = 10, LOCK_MS = 5 * 60000;
  const tries = new Map();
  const audit = (req, type, detail = '') => { const a = (store.data.audit ||= []); a.push({ t: Date.now(), ip: req.ip || '', type, detail: String(detail).slice(0, 160) }); if (a.length > 200) a.splice(0, a.length - 200); store.save(); };

  const runner = new Runner(store);
  const ai = new Ai(store, runner);
  const workers = new Workers(store, { max: MAX_WK });
  const gd = new GDrive(store);
  const tg = new Tg(store, runner, ai, { maxBots: MAX_MC, defaultScript: DEFAULT_SCRIPT, workers, sys, insights, getPwMode: () => pwMode(), getOwnerPw: () => password });
  runner.on('relay', (ev) => { console.log(`[relay] → ${ev.to}: ${ev.ok ? 'পাঠানো' : 'বট অফলাইন'}`); });
  runner.on('event', (ev) => {
    tg.notifyEvent(ev);
    const url = store.setting('webhookUrl');
    if (!url || ev.bot.notify === false) return;
    const txt = ({ online: 'অনলাইন হয়েছে', offline: 'অফলাইন হয়েছে', failing: 'ঢুকতে পারছে না' })[ev.type];
    if (!txt) return;
    const body = `MC Host: ${ev.bot.username} ${txt}${ev.reason ? ' (' + String(ev.reason).slice(0, 120) + ')' : ''}`;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: body, text: body }), signal: AbortSignal.timeout(8000) }).catch(() => {});
  });

  workers.on('event', (ev) => {
    tg.notifyWorker(ev);
    const url = store.setting('webhookUrl');
    if (!url) return;
    const txt = ({ down: 'বন্ধ/ত্রুটিতে', up: 'আবার চালু', errorrate: 'ত্রুটির হার বেশি' })[ev.type];
    if (!txt) return;
    const body = `MC Host Worker: ${ev.worker.name} ${txt}${ev.reason ? ' (' + String(ev.reason).slice(0, 120) + ')' : ''}`;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: body, text: body }), signal: AbortSignal.timeout(8000) }).catch(() => {});
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // Worker পাবলিক URL: /w/<slug>/...  (লগইন লাগে না, Cloudflare Workers-এর মতো)
  const rawBody = express.raw({ type: () => true, limit: '1mb' });
  const wkServe = (req, res) => workers.serve(req, res).catch((e) => { console.error('[worker]', e.message); if (!res.headersSent) res.status(500).type('text').send('Worker error'); });
  // পাবলিক রিসিভার: GitHub-এর X-Hub-Signature-256 বা x-mch-secret হেডার যাচাই
  app.post('/api/hooks/:id', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const h = (store.data.hooks || []).find((x) => x.id === req.params.id);
    if (!h) return res.status(404).json({ ok: false, error: 'হুক পাওয়া যায়নি' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const sig = String(req.headers['x-hub-signature-256'] || '');
    const want = 'sha256=' + crypto.createHmac('sha256', h.secret).update(body).digest('hex');
    const okSig = sig ? Sec.safeEq(sig, want) : Sec.safeEq(String(req.headers['x-mch-secret'] || ''), h.secret);
    if (!okSig) { audit(req, 'hook-denied', h.name); return res.status(401).json({ ok: false, error: 'সিগনেচার মেলেনি' }); }
    if (String(req.headers['x-github-event'] || '') === 'ping') return res.json({ ok: true, pong: true });
    let result = '';
    try {
      if (h.action === 'restart-worker') { const r = await workers.start(h.target); result = r.ok ? 'Worker রিস্টার্ট' : r.error; }
      else if (h.action === 'start-worker') { const r = await workers.start(h.target); result = r.ok ? 'Worker চালু' : r.error; }
      else if (h.action === 'stop-worker') { await workers.stop(h.target); result = 'Worker বন্ধ'; }
      else if (h.action === 'restart-bots') { const list = h.target === 'all' ? store.data.bots : [store.bot(h.target)].filter(Boolean); for (const b of list) await runner.restart(b.id); result = `${list.length}টি বট রিস্টার্ট`; }
      else if (h.action === 'backup-drive') { const r = await gd.backupNow(() => buildBackupData(), origin(req)); result = 'ব্যাকআপ: ' + r.name; }
      h.fired++; h.lastFired = Date.now(); store.save();
      audit(req, 'hook-fired', `${h.name}: ${result}`);
      res.json({ ok: true, result });
    } catch (e) { audit(req, 'hook-error', `${h.name}: ${e.message}`); res.status(500).json({ ok: false, error: e.message }); }
  });

  // Google Drive OAuth callback (সেশন কুকি লাগে না, state দিয়ে যাচাই হয়)
  app.get('/api/gdrive/callback', async (req, res) => {
    try {
      if (req.query.error) throw new Error('Google অনুমতি দেয়নি: ' + String(req.query.error));
      await gd.callback(origin(req), String(req.query.code || ''), String(req.query.state || ''));
      audit(req, 'gdrive-connect', 'Google Drive সংযুক্ত');
      res.redirect('/#gdrive=ok');
      setTimeout(() => gd.backupNow(() => buildBackupData(), origin(req)).catch(() => {}), 500);
    } catch (e) { res.redirect('/#gdrive=err:' + encodeURIComponent(e.message).slice(0, 300)); }
  });
  // কাস্টম ডোমেইন: Host হেডার মিললে ওই Worker সরাসরি চলে (DNS ও প্রক্সি আপনার দিকে ঠিক করা থাকতে হবে)
  app.use((req, res, next) => {
    const host = String(req.hostname || '').toLowerCase();
    if (!host) return next();
    const w = workers.all().find((x) => x.domain && x.domain === host);
    if (!w) return next();
    req.params = { slug: w.slug, 0: String(req.path || '/').replace(/^\//, '') };
    rawBody(req, res, () => wkServe(req, res));
  });
  app.all('/w/:slug', rawBody, wkServe);
  app.all('/w/:slug/*', rawBody, wkServe);

  const jsonParser = express.json({ limit: '1mb' });
  app.use((req, res, next) => (req.path === '/api/restore' || req.path.startsWith('/api/hooks/') ? next() : jsonParser(req, res, next)));
  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  // পাবলিক স্ট্যাটাস পেজ (লগইন ছাড়া, শুধু সুইচ চালু থাকলে; কোনো ফাইল/ENV/লগ দেখায় না)
  const esc2 = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  app.get('/status', (req, res) => {
    if (!store.setting('statusPublic', false)) return res.status(404).type('text').send('Not found');
    const bots = store.data.bots.map((b) => { const sn = runner.snapshot(b.id); return { name: b.username, state: sn.state, up: sn.uptimePct || 0 }; });
    const wks = workers.all().map((w) => { const v = workers.view(w); const a = workers.agg([w.id], 0); const ok = a.d30.req ? Math.round((1 - a.d30.err / a.d30.req) * 1000) / 10 : 100; return { name: w.name, state: v.state === 'running' ? 'online' : v.state === 'error' ? 'error' : 'stopped', ok, p95: workers.latency(w.id).p95 }; });
    const lab = { online: 'চালু', starting: 'চালু হচ্ছে', reconnecting: 'পুনরায় চেষ্টা', stopped: 'বন্ধ', error: 'সমস্যা' };
    const col = { online: '#35e6a0', starting: '#ffb94a', reconnecting: '#ff8a4a', stopped: '#6a7099', error: '#ff5a73' };
    const row = (n, st, sub) => `<div class="r"><span class="dot" style="background:${col[st] || '#6a7099'}"></span><b>${esc2(n)}</b><span class="sub">${sub}</span><span class="pill">${lab[st] || esc2(st)}</span></div>`;
    const allOk = bots.every((b) => b.state === 'online' || b.state === 'stopped') && wks.every((w) => w.state !== 'error');
    const html = `<!DOCTYPE html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>স্ট্যাটাস</title><style>
    body{margin:0;min-height:100vh;font-family:system-ui,'Noto Sans Bengali',sans-serif;background:radial-gradient(900px 500px at 10% -10%,rgba(124,92,255,.35),transparent 70%),radial-gradient(800px 500px at 110% 10%,rgba(39,211,255,.25),transparent 70%),#070914;color:#eef1ff;padding:28px 18px}
    main{max-width:760px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.hero{padding:20px 22px;border-radius:22px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(20px);margin-bottom:18px}
    .ok{color:#35e6a0}.bad{color:#ff5a73}.card{padding:16px 18px;border-radius:20px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);margin-bottom:14px}
    h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8d95c0;margin:0 0 10px}.r{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.07)}.r:last-child{border:0}
    .dot{width:9px;height:9px;border-radius:50%;flex:none}.sub{margin-left:auto;color:#8d95c0;font-size:13px}.pill{font-size:12px;padding:3px 10px;border-radius:20px;border:1px solid rgba(255,255,255,.14);color:#c9cff0}
    .foot{color:#6a7099;font-size:12px;text-align:center;margin-top:18px}</style></head><body><main>
    <div class="hero"><h1>MC Host স্ট্যাটাস</h1><div class="${allOk ? 'ok' : 'bad'}">${allOk ? '● সব সেবা স্বাভাবিক' : '● কিছু সেবায় সমস্যা'}</div><div class="foot" style="text-align:left;margin:8px 0 0">সর্বশেষ হালনাগাদ: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</div></div>
    <div class="card"><h2>বট</h2>${bots.map((b) => row(b.name, b.state, 'আপটাইম ' + b.up + '%')).join('') || '<div class="sub">কোনো বট নেই</div>'}</div>
    <div class="card"><h2>Workers</h2>${wks.map((w) => row(w.name, w.state, 'সফলতা ' + w.ok + '% · p95 ' + w.p95 + 'ms')).join('') || '<div class="sub">কোনো Worker নেই</div>'}</div>
    <div class="foot">এই পেজে কোনো ব্যক্তিগত তথ্য, ফাইল বা ENV দেখানো হয় না।</div></main></body></html>`;
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  });

  // ---------- auth ----------
  app.get('/api/login-info', (req, res) => {
    const t = tries.get(req.ip);
    res.json({ ok: true, mode: pwMode(), wait: t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0 });
  });
  const origin = (req) => `${req.protocol}://${req.get('host')}`;
  const buildBackupData = () => { const d = JSON.parse(JSON.stringify(store.data)); delete d.settings.autoPassword; delete d.settings.customPassword; delete d.settings.customPasswordEnv; delete d.history; delete d.gdrive; return { v: 6, ts: Date.now(), data: d, scripts: Object.fromEntries(store.data.bots.map((b) => [b.id, store.readScript(b.id)])), workerFiles: workers.exportAll(), workerDbs: workers.dbExportAll() }; };
  app.post('/api/login', (req, res) => {
    const ip = req.ip;
    const t = tries.get(ip) || { n: 0, until: 0 };
    if (Date.now() < t.until) { const w = Math.ceil((t.until - Date.now()) / 1000); return res.status(429).json({ ok: false, wait: w, error: `অনেকবার ভুল হয়েছে। ${Math.ceil(w / 60)} মিনিট পরে চেষ্টা করুন` }); }
    const given = clean((req.body || {}).password);
    let who = null;
    if (Sec.safeEq(given, password)) who = { role: 'admin', uid: 'owner', name: 'মালিক' };
    else { const u = (store.data.users || []).find((x) => Sec.verifyPw(given, x.hash)); if (u) { who = { role: u.role, uid: u.id, name: u.name }; u.lastLogin = Date.now(); } }
    if (!who) {
      t.n++; audit(req, 'login-fail', 'ভুল পাসওয়ার্ড');
      if (t.n >= LIMIT) { t.until = Date.now() + LOCK_MS; t.n = 0; }
      tries.set(ip, t);
      return fail(res, `পাসওয়ার্ড ভুল (আর ${Math.max(0, LIMIT - t.n)}বার চেষ্টা করা যাবে)`, 401);
    }
    tries.delete(ip); audit(req, 'login', `সফল লগইন: ${who.name} (${who.role})`);
    if (who.role === 'admin' && gd.connected() && Date.now() - (gd.cfg().lastBackup || 0) > 30 * 60000) setTimeout(() => gd.backupNow(() => buildBackupData(), origin(req)).catch(() => {}), 1500);
    const token = mkCookie(who.role, who.uid);
    setCookie(req, res, token);
    ok(res, { token });
  });
  app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'mch=; Max-Age=0; Path=/'); ok(res); });
  app.get('/api/me', (req, res) => { const s = getSession(req); res.json({ ok: !!s, role: s ? s.role : null, name: s ? (s.name || 'মালিক') : '' }); });
  app.use('/api', (req, res, next) => {
    const sess = getSession(req);
    if (!sess) return fail(res, 'লগইন করুন', 401);
    req.sess = sess;
    const write = req.method !== 'GET';
    if (write && sess.role === 'viewer') return fail(res, 'শুধু দেখার অনুমতি আছে', 403);
    if (ADMIN_ONLY.test(req.path) && sess.role !== 'admin') return fail(res, 'এটি শুধু মালিক (admin) করতে পারে', 403);
    if (write && !/^\/(ai\/chat|bots\/[^/]+\/ai|workers\/[^/]+\/(ai|test))/.test(req.path)) audit(req, 'api', `${sess.name || sess.uid}: ${req.method} ${req.path}`);
    next();
  });

  // ---------- state ----------
  const botView = (b) => ({ color: b.color || '', id: b.id, username: b.username, host: b.host, port: b.port, version: b.version || '', notify: b.notify !== false, autoRestartHours: b.autoRestartHours || 0, joinCmds: b.joinCmds || [], rules: b.rules || [], periodic: b.periodic || [], desired: !!b.desired, createdAt: b.createdAt, snap: runner.snapshot(b.id) });
  const mask = (k) => (k ? k.slice(0, 4) + '••••' + k.slice(-3) : '');

  const stateOf = (sess) => ({
      ok: true,
      fleet: runner.fleet(),
      bots: store.data.bots.map(botView),
      tg: tg.list(),
      ai: { ready: ai.ready(), model: ai.model(), keyMask: mask(ai.key()), fromEnv: !store.setting('mistralKey') && !!process.env.MISTRAL_API_KEY },
      webhook: !!store.setting('webhookUrl'),
      workers: { count: workers.all().length, running: workers.all().filter((w) => workers.view(w).state === 'running').length },
      host: { port: PORT, mode: store.mode, node: process.version, uptime: Date.now() - started, rss: Math.round(process.memoryUsage().rss / 1048576), cpus: os.cpus().length, limits: { mc: MAX_MC, tg: MAX_TG }, platform: process.env.RENDER ? 'Render' : process.env.SERVER_PORT ? 'Wispbyte / Pterodactyl' : 'Generic' },
      history: store.data.history.slice(-90),
      me: { role: sess ? sess.role : null, name: sess ? (sess.name || 'মালিক') : '' },
      settings: { statusPublic: !!store.setting('statusPublic', false), tzOffset: store.setting('tzOffset', null), digestHour: store.setting('digestHour', -1), muteUntil: store.setting('muteUntil', 0), notifyBots: store.setting('notifyBots', true), notifyWorkers: store.setting('notifyWorkers', true), weeklyReport: !!store.setting('weeklyReport', false) },
});
  app.get('/api/state', (req, res) => res.json(stateOf(req.sess)));

  // ---------- bots ----------
  app.post('/api/bots', (req, res) => {
    if (store.data.bots.length >= MAX_MC) return fail(res, `সর্বোচ্চ ${MAX_MC}টি বট চালানো যাবে`);
    const { username, host: hostRaw, port, version, script, template } = req.body || {};
    if (!validName(username)) return fail(res, 'নাম ৩-১৬ অক্ষর (A-Z, 0-9, _)');
    const h = parseHost(hostRaw);
    if (!h) return fail(res, 'সার্ভার ঠিকানা সঠিক নয়');
    const p = Number(port) || h.port || 25565;
    if (p < 1 || p > 65535) return fail(res, 'পোর্ট সঠিক নয়');
    let code = DEFAULT_SCRIPT;
    if (script && String(script).trim()) {
      try { new vm.Script(String(script)); } catch (e) { return fail(res, 'স্ক্রিপ্টে ত্রুটি: ' + e.message); }
      code = String(script);
    }
    const tpl = TEMPLATES.find((t) => t.key === template);
    if (tpl && tpl.code && !(script && String(script).trim())) code = tpl.code;
    const bot = { id: genId(), tgBotId: null, username, host: h.host, port: p, version: String(version || '').trim(), notify: true, desired: false, createdAt: Date.now() };
    store.data.bots.push(bot);
    store.writeScript(bot.id, code);
    store.save();
    ok(res, { id: bot.id });
  });

  const withBot = (fn) => (req, res) => { const b = store.bot(req.params.id); return b ? fn(b, req, res) : fail(res, 'বট পাওয়া যায়নি', 404); };

  const S_ = (v, n) => String(v ?? '').slice(0, n);
  const N_ = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  const arr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
  const cleanFeatures = (body) => {
    const out = {};
    if (body.joinCmds !== undefined) out.joinCmds = arr(body.joinCmds, 10).map((x) => ({ cmd: S_(x.cmd, 200).trim(), delay: N_(x.delay, 0, 300, 3) })).filter((x) => x.cmd);
    if (body.rules !== undefined) {
      out.rules = arr(body.rules, 20).map((x) => ({ match: S_(x.match, 100).trim(), reply: S_(x.reply, 200).trim(), regex: !!x.regex, cooldown: N_(x.cooldown, 1, 3600, 10) })).filter((x) => x.match && x.reply);
      for (const r of out.rules) if (r.regex) { try { new RegExp(r.match, 'i'); } catch { throw new Error('Regex সঠিক নয়: ' + r.match); } }
    }
    if (body.periodic !== undefined) out.periodic = arr(body.periodic, 10).map((x) => ({ text: S_(x.text, 200).trim(), every: N_(x.every, 30, 86400, 300) })).filter((x) => x.text);
    return out;
  };

  app.patch('/api/bots/:id', withBot(async (b, req, res) => {
    const { username, host, port, version, notify } = req.body || {};
    if (username !== undefined) { if (!validName(username)) return fail(res, 'নাম সঠিক নয়'); b.username = username; }
    if (host !== undefined) { const h = parseHost(host); if (!h) return fail(res, 'ঠিকানা সঠিক নয়'); b.host = h.host; if (h.port && port === undefined) b.port = h.port; }
    if (port !== undefined) { const p = Number(port); if (!(p > 0 && p < 65536)) return fail(res, 'পোর্ট সঠিক নয়'); b.port = p; }
    if (version !== undefined) b.version = String(version).trim();
    if (notify !== undefined) b.notify = !!notify;
    if (req.body && req.body.quiet !== undefined) { const q = req.body.quiet; b.quiet = q && Number.isInteger(q.from) && Number.isInteger(q.to) && q.from >= 0 && q.from < 24 && q.to >= 0 && q.to < 24 ? { from: q.from, to: q.to } : null; }
    if (req.body && req.body.color !== undefined) b.color = /^#[0-9a-f]{6}$/i.test(String(req.body.color)) ? String(req.body.color) : '';
    if (req.body.autoRestartHours !== undefined) b.autoRestartHours = Math.max(0, Math.min(168, Number(req.body.autoRestartHours) || 0));
    let feat = {};
    try { feat = cleanFeatures(req.body || {}); } catch (e) { return fail(res, e.message); }
    Object.assign(b, feat);
    store.save();
    if (runner.state(b.id) !== 'stopped' && (username || host || port || version !== undefined || Object.keys(feat).length)) await runner.restart(b.id);
    ok(res);
  }));
  app.delete('/api/bots/:id', withBot(async (b, req, res) => { await runner.stop(b.id); store.removeBot(b.id); ok(res); }));
  app.post('/api/bots/:id/start', withBot((b, req, res) => { const r = runner.start(b.id, { user: true }); r.ok ? ok(res) : fail(res, r.error); }));
  app.post('/api/bots/:id/stop', withBot(async (b, req, res) => { await runner.stop(b.id); ok(res); }));
  app.post('/api/bots/:id/restart', withBot(async (b, req, res) => { await runner.restart(b.id); ok(res); }));
  app.post('/api/bots/:id/say', withBot((b, req, res) => (runner.say(b.id, String(req.body.text || '').trim()) ? ok(res) : fail(res, 'বট অনলাইন নেই'))));
  app.get('/api/bots/:id/logs', withBot((b, req, res) => ok(res, { logs: runner.logs(b.id, 200), chat: runner.chatLog(b.id) })));
  app.get('/api/bots/:id/analysis', withBot((b, req, res) => ok(res, { snap: runner.snapshot(b.id), events: runner.events(b.id, 40), notes: store.mem(b.id).notes })));

  // ---------- scripts ----------
  app.get('/api/bots/:id/script', withBot((b, req, res) => ok(res, { code: store.readScript(b.id), hasPrev: store.hasPrev(b.id) })));
  app.put('/api/bots/:id/script', withBot(async (b, req, res) => {
    const code = String(req.body.code || '');
    if (!code.trim()) return fail(res, 'স্ক্রিপ্ট ফাঁকা');
    try { new vm.Script(code); } catch (e) { return fail(res, 'সিনট্যাক্স ত্রুটি: ' + e.message); }
    store.writeScript(b.id, code);
    if (runner.state(b.id) !== 'stopped') await runner.restart(b.id);
    ok(res);
  }));
  app.post('/api/bots/:id/script/rollback', withBot(async (b, req, res) => {
    if (!store.rollback(b.id)) return fail(res, 'আগের সংস্করণ নেই');
    if (runner.state(b.id) !== 'stopped') await runner.restart(b.id);
    ok(res);
  }));
  app.post('/api/bots/:id/script/reset', withBot(async (b, req, res) => {
    store.writeScript(b.id, DEFAULT_SCRIPT);
    if (runner.state(b.id) !== 'stopped') await runner.restart(b.id);
    ok(res);
  }));

  // ---------- feed / bulk / clone / templates ----------
  app.get('/api/feed', (req, res) => ok(res, { feed: runner.feed.slice(-40).reverse() }));
  app.get('/api/templates', (req, res) => ok(res, { templates: TEMPLATES.map((t) => ({ key: t.key, name: t.name, desc: t.desc })) }));
  app.post('/api/bulk/:action', async (req, res) => {
    const a = req.params.action;
    if (a === 'start') return ok(res, { n: runner.startAll() });
    if (a === 'stop') { await runner.stopAll(); return ok(res); }
    if (a === 'restart') { await runner.restartAll(); return ok(res); }
    fail(res, 'অজানা কাজ');
  });
  app.post('/api/bots/:id/clone', withBot((b, req, res) => {
    if (store.data.bots.length >= MAX_MC) return fail(res, `সর্বোচ্চ ${MAX_MC}টি বট চালানো যাবে`);
    const name = String(req.body.username || '').trim();
    if (!validName(name)) return fail(res, 'নতুন নামটি সঠিক নয়');
    const c = { id: genId(), tgBotId: null, username: name, host: b.host, port: b.port, version: b.version || '', notify: b.notify !== false, desired: false, createdAt: Date.now(), autoRestartHours: b.autoRestartHours || 0 };
    store.data.bots.push(c);
    store.writeScript(c.id, store.readScript(b.id));
    ok(res, { id: c.id });
  }));

  // ---------- backup / password ----------
  app.get('/api/backup', (req, res) => {
    const scripts = {};
    for (const b of store.data.bots) scripts[b.id] = store.readScript(b.id);
    const data = JSON.parse(JSON.stringify(store.data));
    delete data.settings.autoPassword; delete data.settings.customPassword; delete data.settings.customPasswordEnv; delete data.history; delete data.gdrive;
    res.setHeader('Content-Disposition', 'attachment; filename="mc-host-backup.json"');
    res.json({ v: 5, ts: Date.now(), data, scripts, workerFiles: workers.exportAll(), workerDbs: workers.dbExportAll() });
  });
  const doRestore = async (body) => {
    const { data, scripts, workerFiles, workers: legacy } = body || {};
    if (!data || !Array.isArray(data.bots) || !Array.isArray(data.tgBots)) throw new Error('ব্যাকআপ ফাইল সঠিক নয়');
    for (const [id, code] of Object.entries(scripts || {})) { try { new vm.Script(String(code)); } catch { throw new Error('ব্যাকআপের একটি স্ক্রিপ্টে ত্রুটি আছে'); } }
    await runner.stopAll({ keepDesired: true });
    const keep = { autoPassword: store.setting('autoPassword'), customPassword: store.setting('customPassword'), customPasswordEnv: store.setting('customPasswordEnv') };
    store.data.bots = data.bots.slice(0, MAX_MC).map((b) => ({ ...b, desired: false }));
    store.data.aiMem = data.aiMem || {};
    store.data.settings = { ...(data.settings || {}), ...keep };
    for (const b of store.data.bots) store.writeScript(b.id, String((scripts || {})[b.id] || DEFAULT_SCRIPT));
    if (Array.isArray(data.workers)) {
      for (const w of workers.all().slice()) await workers.remove(w.id);
      store.data.workers = data.workers.slice(0, MAX_WK).map((w) => ({ ...w, enabled: !!w.enabled }));
      workers.importAll(workerFiles || legacy || {});
      workers.dbImportAll(body.workerDbs || {});
      workers._migrate();
      workers.autostart();
    }
    store.save();
    return { bots: store.data.bots.length, workers: workers.all().length };
  };
  app.post('/api/restore', express.json({ limit: '40mb' }), async (req, res) => {
    try { ok(res, await doRestore(req.body || {})); } catch (e) { fail(res, e.message); }
  });
  app.post('/api/password', (req, res) => {
    const cur = clean(req.body.current), nw = clean(req.body.next);
    if (cur !== password) return fail(res, 'বর্তমান পাসওয়ার্ড ভুল');
    if (nw.length < 6) return fail(res, 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষর');
    password = nw;
    store.setSetting('customPassword', nw);
    store.setSetting('customPasswordEnv', envPw);
    const token = mkCookie('admin', 'owner');
    setCookie(req, res, token);
    ok(res, { token });
  });

  // ---------- AI ----------
  const aiGuard = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e.message, 502); } };
  app.get('/api/ai/models', aiGuard(async (req, res) => ok(res, { models: await ai.models(), current: ai.model() })));
  app.post('/api/ai/chat', aiGuard(async (req, res) => {
    const botId = req.body.botId || null;
    if (botId && !store.bot(botId)) return fail(res, 'বট পাওয়া যায়নি', 404);
    const text = String(req.body.text || '').trim();
    if (!text) return fail(res, 'মেসেজ ফাঁকা');
    ok(res, await ai.chat(botId, text, Array.isArray(req.body.history) ? req.body.history : null));
  }));
  app.post('/api/bots/:id/ai/analyze', withBot(aiGuard(async (b, req, res) => ok(res, { text: await ai.analyze(b.id) }))));
  app.post('/api/bots/:id/ai/apply', withBot(async (b, req, res) => {
    const code = String(req.body.code || '') || ai.takePending(b.id);
    if (!code) return fail(res, 'প্রয়োগ করার মতো কোড নেই');
    const err = Ai.validate(code);
    if (err) return fail(res, 'সিনট্যাক্স ত্রুটি: ' + err);
    store.writeScript(b.id, code);
    ai.addNote(b.id, 'AI প্রস্তাব করা স্ক্রিপ্ট প্রয়োগ হয়েছে ' + new Date().toISOString().slice(0, 16));
    if (runner.state(b.id) !== 'stopped') await runner.restart(b.id);
    ok(res);
  }));
  app.delete('/api/ai/memory', (req, res) => { ai.clearMemory(req.query.botId || null); ok(res); });

  // ---------- settings ----------
  app.put('/api/settings', (req, res) => {
    const { mistralKey, mistralModel, webhookUrl } = req.body || {};
    if (typeof webhookUrl === 'string') { if (webhookUrl && !/^https:\/\//.test(webhookUrl.trim())) return fail(res, 'ওয়েবহুক URL https:// দিয়ে শুরু হতে হবে'); store.setSetting('webhookUrl', webhookUrl.trim()); }
    if (typeof mistralKey === 'string' && mistralKey.trim()) store.setSetting('mistralKey', mistralKey.trim());
    if (mistralKey === '') store.setSetting('mistralKey', '');
    if (typeof mistralModel === 'string' && mistralModel.trim()) store.setSetting('mistralModel', mistralModel.trim());
    const b = req.body || {};
    if (b.tzOffset !== undefined && Number.isFinite(Number(b.tzOffset))) store.setSetting('tzOffset', Math.max(-840, Math.min(840, Number(b.tzOffset))));
    if (b.digestHour !== undefined) store.setSetting('digestHour', Math.max(-1, Math.min(23, Number(b.digestHour) || 0)));
    if (b.muteUntil !== undefined) store.setSetting('muteUntil', Number(b.muteUntil) || 0);
    if (typeof b.notifyBots === 'boolean') store.setSetting('notifyBots', b.notifyBots);
    if (typeof b.notifyWorkers === 'boolean') store.setSetting('notifyWorkers', b.notifyWorkers);
    if (typeof b.statusPublic === 'boolean') store.setSetting('statusPublic', b.statusPublic);
    ok(res);
  });

  // ---------- telegram ----------
  app.post('/api/tg', async (req, res) => {
    if (store.data.tgBots.length >= MAX_TG) return fail(res, `সর্বোচ্চ ${MAX_TG}টি টেলিগ্রাম বট`);
    const r = await tg.add(String(req.body.token || '').trim());
    r.ok ? ok(res, { username: r.username }) : fail(res, r.error);
  });
  app.delete('/api/tg/:id', async (req, res) => { await tg.remove(req.params.id); ok(res); });

  // ---------- Insights / System / Audit ----------
  app.get('/api/insights', (req, res) => {
    const tz = Number(req.query.tz) || 0;
    ok(res, { items: insights.build({ store, runner, workers, sys: sys.info(store, runner, workers), tzMin: tz, extra: { renderLocal: !!process.env.RENDER && store.mode === 'local', autoPassword: pwMode() === 'auto', noAi: !ai.ready(), noTg: store.data.tgBots.length === 0 } }) });
  });
  app.get('/api/system', (req, res) => ok(res, { sys: sys.info(store, runner, workers) }));
  app.get('/api/audit', (req, res) => ok(res, { items: [...(store.data.audit || [])].reverse().slice(0, 100) }));

  const guard = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e.message || 'ত্রুটি'); } };
  const guard0 = guard;
  const withWk = (fn) => guard(async (req, res) => { const w = workers.get(req.params.id); if (!w) return fail(res, 'Worker পাওয়া যায়নি', 404); return fn(w, req, res); });
  // ---------- Worker: টেস্ট ও ডাটাবেস ----------
  app.post('/api/workers/:id/tests/run', withWk(async (w, req, res) => ok(res, await workers.runTests(w.id))));
  app.get('/api/workers/:id/db', withWk((w, req, res) => { try { ok(res, workers.dbTables(w.id)); } catch (e) { fail(res, e.message); } }));
  app.get('/api/workers/:id/db/rows', withWk((w, req, res) => { try { ok(res, workers.dbRows(w.id, String(req.query.table || ''), req.query.limit, req.query.offset)); } catch (e) { fail(res, e.message); } }));
  app.post('/api/workers/:id/db/query', withWk((w, req, res) => { try { ok(res, workers.dbQuery(w.id, (req.body || {}).sql)); } catch (e) { fail(res, e.message); } }));

  // ---------- রিপোর্ট (SLA, ব্যয়, পারফরম্যান্স) ----------
  const buildReport = (days, tz = 0) => {
    const period = days === 30 ? 'd30' : 'd7';
    const rows = [['type', 'name', 'uptime_pct', 'sessions', 'crashes', 'requests', 'errors_5xx', 'error_rate_pct', 'avg_ms', 'cpu_ms_per_req', 'bytes', 'budget_p95_ms', 'budget_err_pct', 'budget_status']];
    for (const b of store.data.bots) {
      const sn = runner.snapshot(b.id); const st = sn.stats || { upMs: 0, since: Date.now(), sessions: 0, crashes: 0 };
      const span = Math.max(1, Date.now() - st.since);
      rows.push(['bot', b.username, Math.round(Math.min(100, st.upMs / span * 100) * 10) / 10, st.sessions, st.crashes, '', '', '', '', '', '', '', '', '']);
    }
    for (const w of workers.all()) {
      const a = workers.agg([w.id], tz); const x = a[period]; const lat = workers.latency(w.id);
      const errPct = x.req ? Math.round(x.err / x.req * 1000) / 10 : 0;
      const avg = x.req ? Math.round(x.ms / x.req) : 0;
      const bu = w.budget || {}; const breach = [];
      if (bu.p95Ms && lat.p95 > bu.p95Ms) breach.push('p95');
      if (bu.errPct && errPct > bu.errPct) breach.push('err');
      rows.push(['worker', w.name, '', '', '', x.req, x.err, errPct, avg, x.req ? Math.round((x.cpu / x.req) * 10) / 10 : 0, x.bytes, bu.p95Ms || '', bu.errPct || '', breach.length ? 'breach:' + breach.join('+') : (bu.p95Ms || bu.errPct ? 'ok' : '')]);
    }
    return rows.map((r) => r.map((c) => { const t = String(c ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }).join(',')).join('\n') + '\n';
  };
  app.get('/api/reports/csv', (req, res) => {
    const days = Number(req.query.days) === 7 ? 7 : 30;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mc-host-report-${days}d.csv"`);
    res.end(buildReport(days, tzOf(req)));
  });
  app.post('/api/reports/drive', guard0(async (req, res) => {
    const days = Number((req.body || {}).days) === 7 ? 7 : 30;
    const csv = Buffer.from(buildReport(days, Number((req.body || {}).tz) || 0));
    const name = `mc-host-report-${days}d-${new Date().toISOString().slice(0, 10)}.csv`;
    const f = await gd.uploadReport(name, csv, 'text/csv');
    audit(req, 'report-drive', name); ok(res, { file: f });
  }));
  app.put('/api/reports/settings', guard0((req, res) => { store.setSetting('weeklyReport', !!(req.body || {}).weekly); ok(res); }));

  // ---------- ইনবাউন্ড ওয়েবহুক (GitHub/যেকোনো সেবা থেকে ট্রিগার) ----------
  app.get('/api/hooks', guard0((req, res) => ok(res, { hooks: (store.data.hooks || []).map((h) => ({ ...h, url: origin(req) + '/api/hooks/' + h.id })) })));
  app.post('/api/hooks', guard0((req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 40); const action = String(b.action || '');
    if (!name) return fail(res, 'নাম দিন');
    if (!['restart-worker', 'start-worker', 'stop-worker', 'restart-bots', 'backup-drive'].includes(action)) return fail(res, 'অজানা কাজ');
    const target = String(b.target || '');
    if (action.endsWith('worker') && !workers.get(target)) return fail(res, 'Worker বাছুন');
    if (action === 'restart-bots' && target !== 'all' && !store.bot(target)) return fail(res, 'বট বাছুন বা "সব" দিন');
    if ((store.data.hooks || []).length >= 30) return fail(res, 'সর্বোচ্চ ৩০টি হুক');
    const h = { id: genId() + genId(), name, action, target, secret: Sec.newToken().replace('mcht_', ''), createdAt: Date.now(), fired: 0, lastFired: 0 };
    (store.data.hooks ||= []).push(h); store.save(); audit(req, 'hook-create', name);
    ok(res, { hook: { ...h, url: origin(req) + '/api/hooks/' + h.id } });
  }));
  app.delete('/api/hooks/:id', guard0((req, res) => { store.data.hooks = (store.data.hooks || []).filter((h) => h.id !== req.params.id); store.save(); audit(req, 'hook-delete', req.params.id); ok(res); }));
  // ---------- OpenAPI (নিজে থেকে তৈরি, সব প্রধান এন্ডপয়েন্ট) ----------
  app.get('/api/openapi.json', (req, res) => {
    const op = (summary, tag, write = false) => ({ summary, tags: [tag], security: [{ session: [] }, { bearer: [] }], responses: { 200: { description: 'OK' }, 401: { description: 'লগইন দরকার' }, 403: { description: 'অনুমতি নেই' } }, ...(write ? {} : {}) });
    res.json({
      openapi: '3.0.3', info: { title: 'MC Host API', version: '2.9.0', description: 'প্যানেলের API। Authorization: Bearer mcht_... টোকেন দিয়ে ব্যবহার করুন।' },
      servers: [{ url: origin(req) }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, session: { type: 'apiKey', in: 'cookie', name: 'mch' } } },
      paths: {
        '/api/state': { get: op('সব অবস্থা (বট, Worker, হোস্ট)', 'সাধারণ') },
        '/api/bots': { post: op('নতুন বট', 'বট') },
        '/api/bots/{id}/start': { post: op('বট চালু', 'বট') },
        '/api/bots/{id}/stop': { post: op('বট বন্ধ', 'বট') },
        '/api/bots/{id}/restart': { post: op('বট রিস্টার্ট', 'বট') },
        '/api/bots/{id}/say': { post: op('গেমে চ্যাট পাঠানো', 'বট') },
        '/api/workers': { get: op('সব Worker ও পরিসংখ্যান', 'Worker'), post: op('নতুন Worker', 'Worker') },
        '/api/workers/{id}/deploy': { post: op('ডিপ্লয়', 'Worker') },
        '/api/workers/{id}/tests/run': { post: op('টেস্ট স্যুট চালানো', 'Worker') },
        '/api/workers/{id}/db': { get: op('SQLite টেবিল তালিকা', 'Worker') },
        '/api/workers/{id}/db/query': { post: op('শুধু SELECT কোয়েরি', 'Worker') },
        '/api/workers/{id}/stats.csv': { get: op('দৈনিক CSV', 'Worker') },
        '/api/reports/csv': { get: op('SLA ও সম্পদ রিপোর্ট (CSV)', 'রিপোর্ট') },
        '/api/reports/drive': { post: op('রিপোর্ট Drive-এ', 'রিপোর্ট') },
        '/api/hooks/{id}': { post: { summary: 'ইনবাউন্ড ওয়েবহুক (HMAC যাচাই)', tags: ['হুক'], responses: { 200: { description: 'OK' }, 401: { description: 'সিগনেচার মেলেনি' } } } },
        '/api/ai/command': { post: op('কথায় নির্দেশ', 'AI') },
        '/api/workers/{id}/ai': { post: op('Worker AI চ্যাট', 'AI') },
      },
    });
  });

  // ---------- Google Drive (শুধু admin) ----------
  app.get('/api/gdrive', guard0(async (req, res) => ok(res, { gd: gd.status(origin(req)), files: gd.connected() ? await gd.list().catch(() => []) : [] })));
  app.post('/api/gdrive/setup', guard0((req, res) => { const r = gd.setup(origin(req), (req.body || {}).clientId, (req.body || {}).clientSecret); audit(req, 'gdrive-setup', 'ক্লায়েন্ট তথ্য সেভ'); ok(res, r); }));
  app.post('/api/gdrive/disconnect', guard0(async (req, res) => { await gd.disconnect(); audit(req, 'gdrive-disconnect', ''); ok(res); }));
  app.post('/api/gdrive/backup', guard0(async (req, res) => { const r = await gd.backupNow(() => buildBackupData(), origin(req)); audit(req, 'gdrive-backup', r.name); ok(res, { backup: r }); }));
  app.put('/api/gdrive/settings', guard0((req, res) => { const c = gd.cfg(); const b = req.body || {}; if (b.autoHours !== undefined) c.autoHours = [0, 1, 6, 12, 24].includes(Number(b.autoHours)) ? Number(b.autoHours) : 0; if (b.keep !== undefined) c.keep = Math.max(3, Math.min(60, Number(b.keep) || 14)); store.save(); ok(res); }));
  app.post('/api/gdrive/restore', guard0(async (req, res) => {
    const id = String((req.body || {}).id || ''); if (!/^[\w-]{10,}$/.test(id)) return fail(res, 'ফাইল আইডি সঠিক নয়');
    const buf = await gd.download(id);
    let data; try { data = JSON.parse(buf.toString('utf8')); } catch { return fail(res, 'ফাইলটি JSON ব্যাকআপ নয়'); }
    const r = await doRestore(data); audit(req, 'gdrive-restore', id); ok(res, r);
  }));
  app.delete('/api/gdrive/backups/:id', guard0(async (req, res) => { await gd.remove(req.params.id); ok(res); }));

  // লাইভ আপডেট: একটি SSE সংযোগ; বারবার পোল করার বদলে সার্ভার প্রতি ৩ সেকেন্ডে পাঠায়
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const push = () => { try { res.write('data: ' + JSON.stringify(stateOf(req.sess)) + '\n\n'); } catch { /* বন্ধ */ } };
    push();
    const t = setInterval(push, 3000);
    req.on('close', () => clearInterval(t));
  });

  // কথায় নির্দেশ: AI ছাড়াও কাজ করে; বিপজ্জনক কাজে আগে নিশ্চিতকরণ লাগে
  const pendingCmd = new Map();
  app.post('/api/ai/command', guard0(async (req, res) => {
    const raw = String((req.body || {}).text || '').trim();
    const t = raw.toLowerCase().replace(/\s+/g, ' ');
    if (/^(হ্যাঁ|হ্যা|yes|confirm|ok)$/i.test(t)) {
      const p = pendingCmd.get(((req.sess && req.sess.uid) || 'anon')); pendingCmd.delete(((req.sess && req.sess.uid) || 'anon'));
      if (!p || Date.now() - p.t > 60000) return ok(res, { reply: 'নিশ্চিত করার মতো কোনো কাজ নেই' });
      if (p.action === 'stop-bots') { await runner.stopAll(); return ok(res, { reply: 'সব বট বন্ধ হয়েছে', done: true }); }
      if (p.action === 'stop-workers') { await Promise.all(workers.all().map((w) => workers.stop(w.id))); return ok(res, { reply: 'সব Worker বন্ধ হয়েছে', done: true }); }
    }
    const has = (...w) => w.some((x) => t.includes(x));
    const all = has('সব', 'সবগুলো', 'all');
    const askConfirm = (action, text) => { pendingCmd.set(((req.sess && req.sess.uid) || 'anon'), { action, t: Date.now() }); return ok(res, { reply: text + '। নিশ্চিত করতে "হ্যাঁ" লিখুন', needConfirm: action }); };
    if (has('বট', 'bot') && all && has('বন্ধ', 'stop', 'থামা')) return askConfirm('stop-bots', 'সব বট বন্ধ করা হবে');
    if (has('বট', 'bot') && all && has('চালু', 'start', 'শুরু')) return ok(res, { reply: `${runner.startAll()}টি বট চালু হচ্ছে`, done: true });
    if (has('worker', 'ওয়ার্কার') && all && has('বন্ধ', 'stop')) return askConfirm('stop-workers', 'সব Worker বন্ধ করা হবে');
    if (has('worker', 'ওয়ার্কার') && all && has('চালু', 'start')) { const r = await Promise.all(workers.all().map((w) => workers.start(w.id))); return ok(res, { reply: `${r.filter((x) => x.ok).length}টি Worker চালু`, done: true }); }
    if (has('ত্রুটি', 'error', 'failed', '5xx') && has('দেখাও', 'show', 'কী', 'কি', 'list', 'গুলো')) {
      const errs = workers.all().flatMap((w) => workers.recent(w.id).filter((r) => r.status >= 500).slice(0, 5).map((r) => `${w.name}: ${r.method} ${r.path} → ${r.status}`));
      return ok(res, { reply: errs.length ? errs.slice(0, 15).join('\n') : 'সাম্প্রতিক সময়ে কোনো 5xx ত্রুটি নেই' });
    }
    if (has('সবচেয়ে') && has('রিকোয়েস্ট', 'request', 'ট্রাফিক') && workers.all().length) {
      const ranked = workers.all().map((w) => ({ w, n: workers.agg([w.id], 0).d30.req })).sort((a, c) => c.n - a.n);
      return ok(res, { reply: `গত ৩০ দিনে সবচেয়ে বেশি রিকোয়েস্ট: ${ranked[0].w.name} (${ranked[0].n.toLocaleString('en-US')}টি)` + (ranked[1] ? `\nএরপর: ${ranked.slice(1, 3).map((x) => x.w.name + ' ' + x.n).join(', ')}` : '') });
    }
    if (has('সবচেয়ে') && has('ধীর', 'slow', 'লেটেন্সি') && workers.all().length) {
      const ranked = workers.all().map((w) => ({ w, p: workers.latency(w.id).p95 })).sort((a, c) => c.p - a.p);
      return ok(res, { reply: `সবচেয়ে ধীর (p95): ${ranked[0].w.name} — ${ranked[0].p}ms` });
    }
    if (has('অবস্থা', 'status', 'সারসংক্ষেপ') || t.includes('সবকিছু কেমন') || t.includes('কেমন আছে')) {
      const f = runner.fleet(); const wr = workers.all().filter((w) => workers.view(w).state === 'running').length;
      return ok(res, { reply: `বট: ${f.online}/${f.total} অনলাইন · Worker: ${wr}/${workers.all().length} চালু · RAM ${f.mem}MB` });
    }
    if (has('ব্যাকআপ', 'backup') && has('drive', 'ড্রাইভ', 'গুগল', 'google')) {
      if (!gd.connected()) return fail(res, 'Google Drive সংযুক্ত নেই');
      const r = await gd.backupNow(() => buildBackupData(), origin(req)); return ok(res, { reply: `Drive-এ ব্যাকআপ হয়েছে: ${r.name}`, done: true });
    }
    ok(res, { reply: 'বুঝতে পারিনি। উদাহরণ: "সব বট বন্ধ করো", "সব Worker চালু", "গত ত্রুটিগুলো দেখাও", "অবস্থা কেমন", "Drive-এ ব্যাকআপ নাও"। বিস্তারিত প্রশ্নে AI সহায়ক ব্যবহার করুন।' });
  }));

  // Worker কোডের AI রিভিউ (ডিপ্লয়ের আগে নিরাপত্তা ও পারফরম্যান্স)
  app.post('/api/workers/:id/review', withWk(async (w, req, res) => {
    if (!ai.ready()) return fail(res, 'AI চালু নেই (Mistral key দিন)');
    const files = workers.listFiles(w.id).filter((f) => /\.(m?js|cjs|json)$/.test(f.path) && f.size < 60000).slice(0, 8);
    const code = files.map((f) => `--- ${f.path}\n${workers.readFile(w.id, f.path).text || ''}`).join('\n').slice(0, 14000);
    const reply = await ai.complete([
      { role: 'system', content: 'You review Cloudflare-Workers-style JavaScript for a Node host. Reply in Bengali, max 8 short lines: security issues (secrets in code, injection, open proxies), bugs, performance, then a verdict line "রায়: ঠিক আছে" or "রায়: ঝুঁকি আছে". Do not repeat the code.' },
      { role: 'user', content: code || '(কোনো JS ফাইল নেই)' },
    ], { max_tokens: 700 });
    ok(res, { reply });
  }));

  // ---------- Workers ----------
  const tzOf = (req) => Number(req.query.tz) || 0;
  const wkFull = (w, tz) => ({ ...workers.view(w), agg: workers.agg([w.id], tz) });
  const blob = express.raw({ type: () => true, limit: '30mb' });
  const MIME = { html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', md: 'text/plain' };

  app.get('/api/worker-templates', (req, res) => ok(res, { templates: WK_TEMPLATES }));
  app.get('/api/workers', (req, res) => {
    const tz = tzOf(req);
    ok(res, { workers: workers.all().map((w) => wkFull(w, tz)), agg: workers.agg(workers.all().map((w) => w.id), tz), max: MAX_WK, origin: workers.origin });
  });
  app.post('/api/workers', guard(async (req, res) => {
    const b = req.body || {};
    const w = workers.create({ name: b.name, slug: b.slug, code: b.code, files: b.files, env: b.env, cronMin: b.cronMin, entry: b.entry });
    const deploy = await workers.deploy(w.id);
    ok(res, { id: w.id, slug: w.slug, deploy });
  }));
  app.post('/api/workers/:id/clone', withWk(async (w, req, res) => { const c = workers.clone(w.id, (req.body || {}).name); ok(res, { id: c.id }); }));
  app.get('/api/workers/:id/stats', withWk((w, req, res) => ok(res, { agg: workers.agg([w.id], tzOf(req)), lat: workers.latency(w.id), recent: workers.recent(w.id), extra: workers.extra(w.id), w: workers.view(w) })));
  // একসাথে একাধিক Worker: start | stop | restart
  app.post('/api/workers/bulk/:action', guard(async (req, res) => {
    const act = req.params.action; const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : workers.all().map((w) => w.id);
    const list = ids.map((id) => workers.get(id)).filter(Boolean).slice(0, 50);
    if (act === 'stop') { await Promise.all(list.map((w) => workers.stop(w.id))); return ok(res, { n: list.length }); }
    if (act === 'start' || act === 'restart') { const r = await Promise.all(list.map((w) => workers.start(w.id))); return ok(res, { n: list.length, failed: r.filter((x) => !x.ok).length }); }
    fail(res, 'অজানা কাজ');
  }));
  app.get('/api/workers/:id/check', withWk((w, req, res) => ok(res, workers.check(w.id))));
  app.get('/api/workers/:id/versions/:name/diff', withWk((w, req, res) => { try { ok(res, workers.diffVersion(w.id, req.params.name, req.query.file ? String(req.query.file) : null)); } catch (e) { fail(res, e.message); } }));
  app.get('/api/workers/:id/stats.csv', withWk((w, req, res) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${w.slug}-daily.csv"`); res.end(workers.csv(w.id, tzOf(req))); }));
  app.get('/api/workers/:id/logs', withWk((w, req, res) => ok(res, { logs: workers.logs(w.id), w: workers.view(w) })));

  // ফাইল ম্যানেজার
  app.get('/api/workers/:id/files', withWk((w, req, res) => ok(res, { files: workers.listFiles(w.id), entry: workers.entryOf(w), w: workers.view(w) })));
  app.get('/api/workers/:id/file', withWk((w, req, res) => ok(res, workers.readFile(w.id, String(req.query.path || '')))));
  app.get('/api/workers/:id/raw', withWk((w, req, res) => {
    const f = workers.absOf(w.id, String(req.query.path || ''));
    const ext = f.split('.').pop().toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(f)}"`);
    res.end(fs.readFileSync(f));
  }));
  app.put('/api/workers/:id/file', withWk((w, req, res) => {
    const p = workers.safeRel((req.body || {}).path);
    const content = String((req.body || {}).content ?? '');
    workers.writeFile(w.id, p, content);
    ok(res, { path: p, syntax: workers.syntaxCheck(p, content) });
  }));
  app.put('/api/workers/:id/blob', blob, withWk((w, req, res) => {
    if (!Buffer.isBuffer(req.body)) return fail(res, 'ফাইল ডাটা পাওয়া যায়নি');
    const p = workers.safeRel(req.query.path);
    workers.writeFile(w.id, p, req.body);
    ok(res, { path: p, size: req.body.length });
  }));
  app.delete('/api/workers/:id/file', withWk((w, req, res) => { workers.deleteFile(w.id, String(req.query.path || '')); ok(res); }));
  app.post('/api/workers/:id/move', withWk((w, req, res) => { workers.moveFile(w.id, (req.body || {}).from, (req.body || {}).to); ok(res); }));
  app.post('/api/workers/:id/import-zip', blob, withWk((w, req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 'ZIP ফাইল পাওয়া যায়নি');
    ok(res, workers.importZip(w.id, req.body, { replace: req.query.replace === '1' }));
  }));
  app.get('/api/workers/:id/export', withWk((w, req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${w.slug}.zip"`);
    res.end(workers.exportZip(w.id));
  }));

  // ডিপ্লয় ও ভার্সন
  app.post('/api/workers/:id/deploy', withWk(async (w, req, res) => { const r = await workers.deploy(w.id); r.ok ? ok(res) : res.status(422).json({ ok: false, error: r.error, rolledBack: !!r.rolledBack }); }));
  app.put('/api/workers/:id/code', withWk(async (w, req, res) => { // পুরনো এন্ডপয়েন্ট: এন্ট্রি ফাইল লিখে ডিপ্লয়
    const code = String((req.body || {}).code || '');
    if (!code.trim()) return fail(res, 'worker.js ফাঁকা');
    workers.writeFile(w.id, workers.entryOf(w) || 'worker.js', code);
    const r = await workers.deploy(w.id);
    r.ok ? ok(res) : res.status(422).json({ ok: false, error: r.error, rolledBack: !!r.rolledBack });
  }));
  app.get('/api/workers/:id/versions', withWk((w, req, res) => ok(res, { versions: workers.versions(w.id) })));
  app.post('/api/workers/:id/restore', withWk(async (w, req, res) => { const r = await workers.restore(w.id, String((req.body || {}).name || '')); r.ok ? ok(res) : res.status(422).json({ ok: false, error: r.error }); }));
  app.post('/api/workers/:id/snapshot', withWk((w, req, res) => { workers.snapshot(w.id, 'manual'); ok(res); }));

  // ENV
  app.get('/api/workers/:id/env', withWk((w, req, res) => ok(res, { env: (w.env || []).map((e) => ({ key: e.key, secret: !!e.secret, value: e.secret ? '' : e.value, has: e.value !== '' })) })));
  app.put('/api/workers/:id/env', withWk(async (w, req, res) => {
    w.env = workers.cleanEnv((req.body || {}).env, w.env);
    w.updatedAt = Date.now(); store.save();
    const r = w.enabled ? await workers.start(w.id) : { ok: true };
    ok(res, { restarted: w.enabled, deploy: r });
  }));
  app.patch('/api/workers/:id', withWk(async (w, req, res) => {
    const b = req.body || {};
    if (b.concurrency !== undefined) w.concurrency = Math.max(5, Math.min(500, Number(b.concurrency) || 50));
    if (b.strictTests !== undefined) w.strictTests = !!b.strictTests;
    if (b.budget !== undefined) {
      const bu = b.budget || {};
      w.budget = { p95Ms: Math.max(0, Math.min(60000, Number(bu.p95Ms) || 0)), errPct: Math.max(0, Math.min(100, Number(bu.errPct) || 0)) };
    }
    if (b.domain !== undefined) {
      const d = String(b.domain || '').trim().toLowerCase();
      if (d) {
        if (!Sec.validDomain(d)) return fail(res, 'ডোমেইন সঠিক নয় (যেমন api.example.com)');
        if (d === String(req.hostname || '').toLowerCase()) return fail(res, 'এটি প্যানেলের নিজের ডোমেইন, Worker-এর জন্য আলাদা ডোমেইন দিন');
        if (workers.all().some((x) => x.id !== w.id && x.domain === d)) return fail(res, 'এই ডোমেইন আগেই আরেক Worker-এ আছে');
      }
      w.domain = d; store.save();
    }
    workers.update(w, b); ok(res);
  }));

  // ---------- API টোকেন ও ব্যবহারকারী (শুধু admin) ----------
  app.get('/api/tokens', (req, res) => ok(res, { tokens: (store.data.tokens || []).map((t) => ({ id: t.id, name: t.name, scope: t.scope, createdAt: t.createdAt, lastUsed: t.lastUsed || 0 })) }));
  app.post('/api/tokens', (req, res) => {
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    const scope = (req.body || {}).scope === 'control' ? 'control' : 'read';
    if (!name) return fail(res, 'টোকেনের নাম দিন');
    if ((store.data.tokens || []).length >= 20) return fail(res, 'সর্বোচ্চ ২০টি টোকেন');
    const token = Sec.newToken();
    const t = { id: genId(), name, scope, hash: Sec.sha256(token), createdAt: Date.now(), lastUsed: 0 };
    (store.data.tokens ||= []).push(t); store.save();
    audit(req, 'token-create', `${name} (${scope})`);
    ok(res, { token, id: t.id }); // টোকেন এই একবারই দেখানো হয়, পরে আর দেখা যাবে না
  });
  app.delete('/api/tokens/:id', (req, res) => {
    const t = (store.data.tokens || []).find((x) => x.id === req.params.id);
    if (!t) return fail(res, 'টোকেন পাওয়া যায়নি', 404);
    store.data.tokens = store.data.tokens.filter((x) => x.id !== t.id); store.save();
    audit(req, 'token-revoke', t.name); ok(res);
  });
  app.get('/api/users', (req, res) => ok(res, { users: (store.data.users || []).map((u) => ({ id: u.id, name: u.name, role: u.role, createdAt: u.createdAt, lastLogin: u.lastLogin || 0 })) }));
  app.post('/api/users', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 30), pw = clean(b.password), role = b.role === 'viewer' ? 'viewer' : 'operator';
    if (!name) return fail(res, 'নাম দিন');
    if (pw.length < 6) return fail(res, 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষর');
    if (Sec.safeEq(pw, password) || (store.data.users || []).some((u) => Sec.verifyPw(pw, u.hash))) return fail(res, 'এই পাসওয়ার্ড অন্য কেউ ব্যবহার করছে, আলাদা দিন');
    if ((store.data.users || []).length >= 20) return fail(res, 'সর্বোচ্চ ২০ জন ব্যবহারকারী');
    const u = { id: genId(), name, role, hash: Sec.hashPw(pw), createdAt: Date.now() };
    (store.data.users ||= []).push(u); store.save();
    audit(req, 'user-create', `${name} (${role})`);
    ok(res, { id: u.id });
  });
  app.delete('/api/users/:id', (req, res) => {
    const u = (store.data.users || []).find((x) => x.id === req.params.id);
    if (!u) return fail(res, 'ব্যবহারকারী পাওয়া যায়নি', 404);
    store.data.users = store.data.users.filter((x) => x.id !== u.id); store.save();
    audit(req, 'user-remove', u.name); ok(res);
  });
  app.post('/api/workers/:id/start', withWk(async (w, req, res) => { const r = await workers.start(w.id); r.ok ? ok(res) : fail(res, r.error); }));
  app.post('/api/workers/:id/restart', withWk(async (w, req, res) => { const r = await workers.start(w.id); r.ok ? ok(res) : fail(res, r.error); }));
  app.post('/api/workers/:id/stop', withWk(async (w, req, res) => { await workers.stop(w.id); ok(res); }));
  app.delete('/api/workers/:id', withWk(async (w, req, res) => { await workers.remove(w.id); ok(res); }));
  app.post('/api/workers/:id/test', withWk(async (w, req, res) => {
    const b = req.body || {};
    const o = await workers.invoke(w.id, { method: String(b.method || 'GET').toUpperCase(), path: String(b.path || '/'), headers: b.headers || {}, body: b.body || null });
    ok(res, { status: o.status, ms: o.ms, headers: o.headers, body: o.body.subarray(0, 20000).toString('utf8') });
  }));

  // Worker AI
  app.post('/api/workers/:id/ai', withWk(async (w, req, res) => {
    const text = String((req.body || {}).text || '').trim();
    if (!text) return fail(res, 'মেসেজ ফাঁকা');
    try { ok(res, await ai.chatWorker(workers, w, text, Array.isArray((req.body || {}).history) ? req.body.history : null)); } catch (e) { fail(res, e.message, 502); }
  }));
  app.post('/api/workers/:id/ai/apply', withWk(async (w, req, res) => {
    let changes = ai.takePendingW(w.id);
    const only = Array.isArray((req.body || {}).paths) ? new Set(req.body.paths) : null;
    if (only) changes = changes.filter((c) => only.has(c.path));
    if (!changes.length) return fail(res, 'প্রয়োগ করার মতো পরিবর্তন নেই (মেয়াদ শেষ?)');
    workers.applyChanges(w.id, changes);
    ai.addNote('w:' + w.id, `AI পরিবর্তন প্রয়োগ: ${changes.map((c) => c.path).join(', ')}`.slice(0, 280));
    const r = (req.body || {}).deploy === false ? { ok: true } : await workers.deploy(w.id);
    r.ok ? ok(res, { applied: changes.length }) : res.status(422).json({ ok: false, error: r.error, rolledBack: !!r.rolledBack });
  }));

  // ---------- static ----------
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));
  app.use((err, req, res, next) => { console.error('[http]', err.message); if (!res.headersSent) fail(res, 'সার্ভার ত্রুটি', 500); });

  // ফ্লিট হিস্ট্রি স্যাম্পলার (গ্রাফের জন্য)
  const sample = () => { const f = runner.fleet(); store.pushHistory({ t: Date.now(), online: f.online, total: f.total, mem: f.mem, rss: Math.round(process.memoryUsage().rss / 1048576), lag: sys.lag(), wreq: workers.totalRequests() }); };
  setInterval(sample, 30000).unref();
  sample();

  // সাপ্তাহিক রিপোর্ট: প্রতি সোমবার সকাল ৯টায় (স্থানীয় সময়), Drive সংযুক্ত থাকলে
  setInterval(() => {
    if (!store.setting('weeklyReport', false) || !gd.connected()) return;
    const tz = Number(store.setting('tzOffset', 0)) || 0;
    const local = new Date(Date.now() + tz * 60000);
    if (local.getUTCDay() !== 1 || local.getUTCHours() !== 9) return;
    const key = local.toISOString().slice(0, 10);
    if (store.setting('weeklyLast', '') === key) return;
    store.setSetting('weeklyLast', key);
    try { const csv = Buffer.from(buildReport(7, -tz)); gd.uploadReport(`mc-host-report-7d-${key}.csv`, csv, 'text/csv').catch((e) => console.error('[report]', e.message)); } catch (e) { console.error('[report]', e.message); }
  }, 60 * 60000).unref();

  // স্বয়ংক্রিয় Google Drive ব্যাকআপ (প্রতি মিনিট পরীক্ষা)
  setInterval(() => {
    const c = gd.cfg();
    if (gd.connected() && c.autoHours > 0 && Date.now() - (c.lastBackup || 0) > c.autoHours * 3600000 && !gd.busy) {
      gd.backupNow(() => buildBackupData(), process.env.PUBLIC_URL || '').catch((e) => console.error('[gdrive auto]', e.message));
    }
  }, 60000).unref();

  // keep-alive (Render ফ্রি / অন্য হোস্টে ঘুম ঠেকাতে)
  const selfUrl = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) setInterval(() => fetch(selfUrl.replace(/\/$/, '') + '/healthz').catch(() => {}), 5 * 60000).unref();

  const server = app.listen(PORT, HOST, () => {
    console.log('============================================');
    console.log(` MC Host v2 চালু: http://${HOST}:${PORT}`);
    console.log(` ডাটা: ${store.dir} (${store.mode})   Node ${process.version}`);
    console.log(` AI: ${ai.ready() ? 'Mistral ' + ai.model() : 'বন্ধ (API key দিন)'}`);
    console.log('============================================');
    tg.launchAll().catch((e) => console.error('[tg]', e.message));
    runner.autostart();
    workers.autostart();
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`পোর্ট ${PORT} ব্যবহৃত। Wispbyte প্যানেলে দেখানো পোর্ট দিয়ে PORT env সেট করুন।`);
    else console.error('[server]', e.message);
    process.exit(1);
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    console.log('বন্ধ হচ্ছে...');
    await runner.stopAll({ keepDesired: true });
    await workers.stopAll();
    await tg.stopAll();
    await store.flushAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message));
})();
