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
  const mkCookie = () => { const exp = Date.now() + 7 * 864e5; return `${exp}.${sign(String(exp))}`; };
  const validCookie = (c) => {
    if (!c) return false;
    const [exp, sig] = c.split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const a = Buffer.from(sig), b = Buffer.from(sign(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const cookieOf = (req) => (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('mch='))?.slice(4) || String(req.headers['x-mch-token'] || '');
  const setCookie = (req, res, token) => res.setHeader('Set-Cookie', `mch=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${req.secure ? '; Secure' : ''}`);
  const LIMIT = 10, LOCK_MS = 5 * 60000;
  const tries = new Map();
  const audit = (req, type, detail = '') => { const a = (store.data.audit ||= []); a.push({ t: Date.now(), ip: req.ip || '', type, detail: String(detail).slice(0, 160) }); if (a.length > 200) a.splice(0, a.length - 200); store.save(); };

  const runner = new Runner(store);
  const ai = new Ai(store, runner);
  const workers = new Workers(store, { max: MAX_WK });
  const tg = new Tg(store, runner, ai, { maxBots: MAX_MC, defaultScript: DEFAULT_SCRIPT, workers, sys, insights, getPwMode: () => pwMode() });
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
  app.all('/w/:slug', rawBody, wkServe);
  app.all('/w/:slug/*', rawBody, wkServe);

  const jsonParser = express.json({ limit: '1mb' });
  app.use((req, res, next) => (req.path === '/api/restore' ? next() : jsonParser(req, res, next)));
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
  app.post('/api/login', (req, res) => {
    const ip = req.ip;
    const t = tries.get(ip) || { n: 0, until: 0 };
    if (Date.now() < t.until) { const w = Math.ceil((t.until - Date.now()) / 1000); return res.status(429).json({ ok: false, wait: w, error: `অনেকবার ভুল হয়েছে। ${Math.ceil(w / 60)} মিনিট পরে চেষ্টা করুন` }); }
    const given = Buffer.from(clean((req.body || {}).password));
    const real = Buffer.from(password);
    const good = given.length === real.length && crypto.timingSafeEqual(given, real);
    if (!good) {
      t.n++; audit(req, 'login-fail', 'ভুল পাসওয়ার্ড');
      if (t.n >= LIMIT) { t.until = Date.now() + LOCK_MS; t.n = 0; }
      tries.set(ip, t);
      return fail(res, `পাসওয়ার্ড ভুল (আর ${Math.max(0, LIMIT - t.n)}বার চেষ্টা করা যাবে)`, 401);
    }
    tries.delete(ip); audit(req, 'login', 'সফল লগইন');
    const token = mkCookie();
    setCookie(req, res, token);
    ok(res, { token });
  });
  app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'mch=; Max-Age=0; Path=/'); ok(res); });
  app.get('/api/me', (req, res) => res.json({ ok: validCookie(cookieOf(req)) }));
  app.use('/api', (req, res, next) => {
    if (!validCookie(cookieOf(req))) return fail(res, 'লগইন করুন', 401);
    if (req.method !== 'GET' && !/^\/(ai\/chat|bots\/[^/]+\/ai|workers\/[^/]+\/(ai|test))/.test(req.path)) audit(req, 'api', req.method + ' ' + req.path);
    next();
  });

  // ---------- state ----------
  const botView = (b) => ({ id: b.id, username: b.username, host: b.host, port: b.port, version: b.version || '', notify: b.notify !== false, autoRestartHours: b.autoRestartHours || 0, joinCmds: b.joinCmds || [], rules: b.rules || [], periodic: b.periodic || [], desired: !!b.desired, createdAt: b.createdAt, snap: runner.snapshot(b.id) });
  const mask = (k) => (k ? k.slice(0, 4) + '••••' + k.slice(-3) : '');

  app.get('/api/state', (req, res) => {
    res.json({
      ok: true,
      fleet: runner.fleet(),
      bots: store.data.bots.map(botView),
      tg: tg.list(),
      ai: { ready: ai.ready(), model: ai.model(), keyMask: mask(ai.key()), fromEnv: !store.setting('mistralKey') && !!process.env.MISTRAL_API_KEY },
      webhook: !!store.setting('webhookUrl'),
      workers: { count: workers.all().length, running: workers.all().filter((w) => workers.view(w).state === 'running').length },
      host: { port: PORT, mode: store.mode, node: process.version, uptime: Date.now() - started, rss: Math.round(process.memoryUsage().rss / 1048576), cpus: os.cpus().length, limits: { mc: MAX_MC, tg: MAX_TG }, platform: process.env.RENDER ? 'Render' : process.env.SERVER_PORT ? 'Wispbyte / Pterodactyl' : 'Generic' },
      history: store.data.history.slice(-90),
      settings: { statusPublic: !!store.setting('statusPublic', false), tzOffset: store.setting('tzOffset', null), digestHour: store.setting('digestHour', -1), muteUntil: store.setting('muteUntil', 0), notifyBots: store.setting('notifyBots', true), notifyWorkers: store.setting('notifyWorkers', true) },
    });
  });

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
    delete data.settings.autoPassword; delete data.settings.customPassword; delete data.settings.customPasswordEnv; delete data.history;
    res.setHeader('Content-Disposition', 'attachment; filename="mc-host-backup.json"');
    res.json({ v: 4, ts: Date.now(), data, scripts, workerFiles: workers.exportAll() });
  });
  app.post('/api/restore', express.json({ limit: '40mb' }), async (req, res) => {
    const { data, scripts, workerFiles, workers: legacy } = req.body || {};
    if (!data || !Array.isArray(data.bots) || !Array.isArray(data.tgBots)) return fail(res, 'ব্যাকআপ ফাইল সঠিক নয়');
    for (const [id, code] of Object.entries(scripts || {})) { try { new vm.Script(String(code)); } catch { return fail(res, 'ব্যাকআপের একটি স্ক্রিপ্টে ত্রুটি আছে'); } }
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
      workers._migrate();
      workers.autostart();
    }
    store.save();
    ok(res, { bots: store.data.bots.length, workers: workers.all().length });
  });
  app.post('/api/password', (req, res) => {
    const cur = clean(req.body.current), nw = clean(req.body.next);
    if (cur !== password) return fail(res, 'বর্তমান পাসওয়ার্ড ভুল');
    if (nw.length < 6) return fail(res, 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষর');
    password = nw;
    store.setSetting('customPassword', nw);
    store.setSetting('customPasswordEnv', envPw);
    const token = mkCookie();
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
    ok(res, await ai.chat(botId, text));
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

  // ---------- Workers ----------
  const guard = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e.message || 'ত্রুটি'); } };
  const withWk = (fn) => guard(async (req, res) => { const w = workers.get(req.params.id); if (!w) return fail(res, 'Worker পাওয়া যায়নি', 404); return fn(w, req, res); });
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
  app.patch('/api/workers/:id', withWk(async (w, req, res) => { workers.update(w, req.body || {}); ok(res); }));
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
    try { ok(res, await ai.chatWorker(workers, w, text)); } catch (e) { fail(res, e.message, 502); }
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
