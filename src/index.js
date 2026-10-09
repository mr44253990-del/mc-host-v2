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

// Wispbyte / Pterodactyl: SERVER_PORT, Render/Heroku/Railway: PORT, নইলে 11336
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || process.env.APP_PORT || 11336);
const HOST = '0.0.0.0';
const MAX_MC = Number(process.env.MAX_MC_BOTS) || 5;
const MAX_TG = Number(process.env.MAX_TG_BOTS) || 3;
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

  const runner = new Runner(store);
  const ai = new Ai(store, runner);
  const tg = new Tg(store, runner, ai, { maxBots: MAX_MC, defaultScript: DEFAULT_SCRIPT });
  runner.on('event', (ev) => {
    tg.notifyEvent(ev);
    const url = store.setting('webhookUrl');
    if (!url || ev.bot.notify === false) return;
    const txt = ({ online: 'অনলাইন হয়েছে', offline: 'অফলাইন হয়েছে', failing: 'ঢুকতে পারছে না' })[ev.type];
    if (!txt) return;
    const body = `MC Host: ${ev.bot.username} ${txt}${ev.reason ? ' (' + String(ev.reason).slice(0, 120) + ')' : ''}`;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: body, text: body }), signal: AbortSignal.timeout(8000) }).catch(() => {});
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.get('/healthz', (req, res) => res.type('text').send('ok'));

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
      t.n++;
      if (t.n >= LIMIT) { t.until = Date.now() + LOCK_MS; t.n = 0; }
      tries.set(ip, t);
      return fail(res, `পাসওয়ার্ড ভুল (আর ${Math.max(0, LIMIT - t.n)}বার চেষ্টা করা যাবে)`, 401);
    }
    tries.delete(ip);
    const token = mkCookie();
    setCookie(req, res, token);
    ok(res, { token });
  });
  app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'mch=; Max-Age=0; Path=/'); ok(res); });
  app.get('/api/me', (req, res) => res.json({ ok: validCookie(cookieOf(req)) }));
  app.use('/api', (req, res, next) => (validCookie(cookieOf(req)) ? next() : fail(res, 'লগইন করুন', 401)));

  // ---------- state ----------
  const botView = (b) => ({ id: b.id, username: b.username, host: b.host, port: b.port, version: b.version || '', notify: b.notify !== false, autoRestartHours: b.autoRestartHours || 0, desired: !!b.desired, createdAt: b.createdAt, snap: runner.snapshot(b.id) });
  const mask = (k) => (k ? k.slice(0, 4) + '••••' + k.slice(-3) : '');

  app.get('/api/state', (req, res) => {
    res.json({
      ok: true,
      fleet: runner.fleet(),
      bots: store.data.bots.map(botView),
      tg: tg.list(),
      ai: { ready: ai.ready(), model: ai.model(), keyMask: mask(ai.key()), fromEnv: !store.setting('mistralKey') && !!process.env.MISTRAL_API_KEY },
      webhook: !!store.setting('webhookUrl'),
      host: { port: PORT, mode: store.mode, node: process.version, uptime: Date.now() - started, rss: Math.round(process.memoryUsage().rss / 1048576), cpus: os.cpus().length, limits: { mc: MAX_MC, tg: MAX_TG }, platform: process.env.RENDER ? 'Render' : process.env.SERVER_PORT ? 'Wispbyte / Pterodactyl' : 'Generic' },
      history: store.data.history.slice(-90),
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

  app.patch('/api/bots/:id', withBot(async (b, req, res) => {
    const { username, host, port, version, notify } = req.body || {};
    if (username !== undefined) { if (!validName(username)) return fail(res, 'নাম সঠিক নয়'); b.username = username; }
    if (host !== undefined) { const h = parseHost(host); if (!h) return fail(res, 'ঠিকানা সঠিক নয়'); b.host = h.host; if (h.port && port === undefined) b.port = h.port; }
    if (port !== undefined) { const p = Number(port); if (!(p > 0 && p < 65536)) return fail(res, 'পোর্ট সঠিক নয়'); b.port = p; }
    if (version !== undefined) b.version = String(version).trim();
    if (notify !== undefined) b.notify = !!notify;
    if (req.body.autoRestartHours !== undefined) b.autoRestartHours = Math.max(0, Math.min(168, Number(req.body.autoRestartHours) || 0));
    store.save();
    if (runner.state(b.id) !== 'stopped' && (username || host || port || version !== undefined)) await runner.restart(b.id);
    ok(res);
  }));
  app.delete('/api/bots/:id', withBot(async (b, req, res) => { await runner.stop(b.id); store.removeBot(b.id); ok(res); }));
  app.post('/api/bots/:id/start', withBot((b, req, res) => { const r = runner.start(b.id, { user: true }); r.ok ? ok(res) : fail(res, r.error); }));
  app.post('/api/bots/:id/stop', withBot(async (b, req, res) => { await runner.stop(b.id); ok(res); }));
  app.post('/api/bots/:id/restart', withBot(async (b, req, res) => { await runner.restart(b.id); ok(res); }));
  app.post('/api/bots/:id/say', withBot((b, req, res) => (runner.say(b.id, String(req.body.text || '').trim()) ? ok(res) : fail(res, 'বট অনলাইন নেই'))));
  app.get('/api/bots/:id/logs', withBot((b, req, res) => ok(res, { logs: runner.logs(b.id, 200) })));
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
    res.json({ v: 2, ts: Date.now(), data, scripts });
  });
  app.post('/api/restore', async (req, res) => {
    const { data, scripts } = req.body || {};
    if (!data || !Array.isArray(data.bots) || !Array.isArray(data.tgBots)) return fail(res, 'ব্যাকআপ ফাইল সঠিক নয়');
    for (const [id, code] of Object.entries(scripts || {})) { try { new vm.Script(String(code)); } catch { return fail(res, 'ব্যাকআপের একটি স্ক্রিপ্টে ত্রুটি আছে'); } }
    await runner.stopAll({ keepDesired: true });
    const keep = { autoPassword: store.setting('autoPassword'), customPassword: store.setting('customPassword'), customPasswordEnv: store.setting('customPasswordEnv') };
    store.data.bots = data.bots.slice(0, MAX_MC).map((b) => ({ ...b, desired: false }));
    store.data.aiMem = data.aiMem || {};
    store.data.settings = { ...(data.settings || {}), ...keep };
    for (const b of store.data.bots) store.writeScript(b.id, String((scripts || {})[b.id] || DEFAULT_SCRIPT));
    store.save();
    ok(res, { bots: store.data.bots.length });
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
    ok(res);
  });

  // ---------- telegram ----------
  app.post('/api/tg', async (req, res) => {
    if (store.data.tgBots.length >= MAX_TG) return fail(res, `সর্বোচ্চ ${MAX_TG}টি টেলিগ্রাম বট`);
    const r = await tg.add(String(req.body.token || '').trim());
    r.ok ? ok(res, { username: r.username }) : fail(res, r.error);
  });
  app.delete('/api/tg/:id', async (req, res) => { await tg.remove(req.params.id); ok(res); });

  // ---------- static ----------
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));
  app.use((err, req, res, next) => { console.error('[http]', err.message); if (!res.headersSent) fail(res, 'সার্ভার ত্রুটি', 500); });

  // ফ্লিট হিস্ট্রি স্যাম্পলার (গ্রাফের জন্য)
  const sample = () => { const f = runner.fleet(); store.pushHistory({ t: Date.now(), online: f.online, total: f.total, mem: f.mem }); };
  setInterval(sample, 30000).unref();
  sample();

  // নির্ধারিত অটো-রিস্টার্ট (মেমরি/ল্যাগ জমা হওয়া ঠেকাতে)
  setInterval(() => {
    for (const b of store.data.bots) {
      const h = b.autoRestartHours;
      if (h && runner.state(b.id) === 'online' && runner.uptime(b.id) > h * 3600000) { console.log(`[sched] ${b.username} অটো-রিস্টার্ট`); runner.restart(b.id); }
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
    await tg.stopAll();
    await store.flushAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message));
})();
