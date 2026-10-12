'use strict';
// টেলিগ্রাম কন্ট্রোল সেন্টার: বট, Worker, বিশ্লেষণ, AI, সেটিংস সবকিছু এক জায়গা থেকে
const { Telegraf, Markup } = require('telegraf');
const { esc, genId, fmtDur, parseHost, validName, diagnose } = require('./util');
const Ai = require('./ai');
const BOT_TEMPLATES = require('./templates');
const WK_TEMPLATES = require('./worker-templates');
const { unzip } = require('./zip');
const Sec = require('./security');

const B = Markup.button.callback;
const KB = (rows) => Markup.inlineKeyboard(rows.filter((r) => r.length));
const LINE = '━━━━━━━━━━━━━━━━━━';
const DOT = { online: '🟢', starting: '🟡', reconnecting: '🟠', stopped: '⚪' };
const WDOT = { running: '🟢', starting: '🟡', error: '🔴', stopped: '⚪' };
const STATE_TAG = { online: 'অনলাইন', starting: 'কানেক্ট হচ্ছে', reconnecting: 'রিকানেক্ট হবে', stopped: 'বন্ধ' };
const WSTATE = { running: 'চলছে', starting: 'চালু হচ্ছে', error: 'ত্রুটি', stopped: 'বন্ধ' };
const STRIP = { o: '🟩', s: '🟨', r: '🟧', x: '⬜', '.': '⬛' };
const LV = { bad: '🔴', warn: '🟠', info: '🔵', good: '🟢' };
const MENU = { home: '🏠 হোম', bots: '🤖 বট', workers: '☁️ Workers', an: '📊 অ্যানালিটিক্স', ai: '✨ AI', se: '⚙️ সেটিংস' };
const PAGE = 6;
const QUICK = [
  'বটের বর্তমান অবস্থা ও লগ বিশ্লেষণ করে সমস্যা ও সমাধান বলো।',
  'স্ক্রিপ্টটি পর্যালোচনা করে ত্রুটি বা উন্নতির জায়গা ঠিক করে সম্পূর্ণ নতুন স্ক্রিপ্ট দাও।',
  'বটকে আরও মানুষের মতো আচরণ করাও (এলোমেলো হাঁটা, তাকানো, ছোট বিরতি) এবং সম্পূর্ণ স্ক্রিপ্ট দাও।',
];
const WQUICK = [
  'এই Worker-এর ত্রুটি ও লগ বিশ্লেষণ করে সমস্যা ও সমাধান বলো, দরকারে ফাইল ঠিক করো।',
  'কোড পর্যালোচনা করে নিরাপত্তা, পারফরম্যান্স ও ত্রুটি হ্যান্ডলিং উন্নত করো।',
  'একটি নতুন /health এন্ডপয়েন্ট এবং CORS সাপোর্ট যোগ করো।',
];

const VIEW_OK = new Set(['noop', 'h', 'bl', 'wl', 'b', 'w', 'an', 'in', 'sys', 'l', 'gc', 'a', 'wlg', 'wa', 'wv', 'lv', 'lx', 'aih', 'se']);
const SP = '▁▂▃▄▅▆▇█';
const spark = (arr) => { const m = Math.max(1, ...arr); return arr.map((v) => (v <= 0 ? '▁' : SP[Math.min(7, Math.floor((v / m) * 7.99))])).join(''); };
const bar = (n, len = 10) => { const f = Math.max(0, Math.min(len, Math.round((Number(n) || 0) / 100 * len))); return '▰'.repeat(f) + '▱'.repeat(len - f); };
const nf = (n) => Number(n || 0).toLocaleString('en-US');
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : '0.0');
const trend = (a, b) => (!b ? (a ? '▲ নতুন' : '─') : a >= b ? `▲ ${Math.round((a - b) / b * 100)}%` : `▼ ${Math.round((b - a) / b * 100)}%`);
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B');
const clip = (t, n = 3900) => (t.length > n ? t.slice(0, n - 20) + '\n…' : t);
const avg = (o) => (o && o.req ? Math.round(o.ms / o.req) : 0);

class Tg {
  constructor(store, runner, ai, { maxBots, defaultScript, workers, sys, insights, getPwMode, getOwnerPw }) {
    this.getOwnerPw = getOwnerPw || (() => '');
    this.store = store; this.runner = runner; this.ai = ai; this.workers = workers; this.sys = sys; this.insights = insights;
    this.maxBots = maxBots; this.defaultScript = defaultScript; this.getPwMode = getPwMode || (() => 'env');
    this.inst = new Map(); this.wiz = new Map(); this.chatMode = new Map(); this.live = new Map(); this.pendingDoc = new Map();
    this._dg = setInterval(() => this._digestTick().catch(() => {}), 60000); this._dg.unref();
  }

  // ---------- সাধারণ সহায়ক ----------
  tzMin() { return -(Number(this.store.setting('tzOffset', 0)) || 0); }
  muted() { return Number(this.store.setting('muteUntil', 0)) > Date.now(); }
  list() { return this.store.data.tgBots.map((t) => ({ id: t.id, username: t.username, owner: t.ownerId || null, running: this.inst.has(t.id) })); }
  base() { const o = this.workers.origin || ''; return /localhost|127\.0\.0\.1/.test(o) ? '' : o; }
  wurl(w) { return `${this.base()}/w/${w.slug}`; }
  findBot(q) { const s = String(q || '').toLowerCase(); return this.store.data.bots.find((b) => b.username.toLowerCase() === s) || this.store.data.bots.find((b) => b.username.toLowerCase().startsWith(s)); }
  findWorker(q) { const s = String(q || '').toLowerCase(); return this.workers.all().find((w) => w.slug === s || w.name.toLowerCase() === s) || this.workers.all().find((w) => w.slug.startsWith(s) || w.name.toLowerCase().startsWith(s)); }
  wagg(ids) { return this.workers.agg(ids || this.workers.all().map((w) => w.id), this.tzMin()); }
  insightsList() {
    return this.insights.build({ store: this.store, runner: this.runner, workers: this.workers, sys: this.sys.info(this.store, this.runner, this.workers), tzMin: this.tzMin(), extra: { renderLocal: !!process.env.RENDER && this.store.mode === 'local', autoPassword: this.getPwMode() === 'auto', noAi: !this.ai.ready(), noTg: false } });
  }

  // ---------- জীবনচক্র ----------
  async add(token) {
    if (!/^\d{5,}:[\w-]{30,}$/.test(token)) return { ok: false, error: 'টোকেনের ফরম্যাট সঠিক নয়' };
    if (this.store.data.tgBots.some((t) => t.token === token)) return { ok: false, error: 'এই টোকেন আগেই যোগ করা আছে' };
    let me;
    try { me = await new Telegraf(token).telegram.getMe(); } catch { return { ok: false, error: 'টোকেন ভুল বা টেলিগ্রামে কানেক্ট হয়নি' }; }
    const t = { id: genId(), token, username: me.username, ownerId: Number(process.env.OWNER_ID) || null };
    this.store.data.tgBots.push(t);
    this.store.save();
    this._launch(t);
    return { ok: true, username: me.username };
  }

  async remove(id) {
    const inst = this.inst.get(id);
    if (inst) { try { inst.stop('remove'); } catch { /* not running */ } this.inst.delete(id); }
    this.store.data.tgBots = this.store.data.tgBots.filter((t) => t.id !== id);
    this.store.save();
  }

  async launchAll() {
    const envTokens = (process.env.TELEGRAM_BOT_TOKEN || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const tok of envTokens) if (!this.store.data.tgBots.some((t) => t.token === tok)) await this.add(tok);
    for (const t of this.store.data.tgBots) if (!this.inst.has(t.id)) this._launch(t);
  }

  async stopAll() { for (const [, k] of this.live) clearInterval(k.timer); this.live.clear(); for (const [, i] of this.inst) { try { i.stop('shutdown'); } catch { /* ignore */ } } this.inst.clear(); }

  _launch(t) {
    const bot = new Telegraf(t.token);
    this.inst.set(t.id, bot);
    bot.catch((e) => console.error('[tg]', t.username, e.message));

    bot.use(async (ctx, next) => {
      const uid = ctx.from && ctx.from.id;
      if (!uid) return;
      const env = Number(process.env.OWNER_ID) || null;
      if (env) t.ownerId = env;
      if (!t.ownerId) {
        if (ctx.message && /^\/start/.test(ctx.message.text || '')) { t.ownerId = uid; this.store.save(); } else return;
      }
      const mem = (t.members || []).find((m) => m.id === uid);
      if (t.ownerId !== uid && !mem) { if (ctx.message) await ctx.reply('এই বট ব্যক্তিগত।').catch(() => {}); return; }
      ctx.mcRole = t.ownerId === uid ? 'owner' : mem.role;
      return next();
    });

    const menu = (ctx) => { this._reset(ctx.from.id); return this.sendHome(ctx, true); };
    bot.start(menu);
    bot.command('menu', menu);
    bot.command('cancel', menu);
    bot.command('help', (ctx) => ctx.reply(this.helpText(), { parse_mode: 'HTML' }));
    // সদস্য ব্যবস্থাপনা (শুধু মালিক): /member add <id> viewer|operator, /member remove <id>, /member list
    bot.command('member', async (ctx) => {
      if (ctx.mcRole !== 'owner') return ctx.reply('শুধু মালিক এটি করতে পারেন।');
      const [sub, idRaw, roleRaw] = ctx.message.text.split(/\s+/).slice(1);
      t.members ||= [];
      if (sub === 'list') return ctx.reply(t.members.map((m) => `${m.id} — ${m.role === 'viewer' ? 'শুধু দেখা' : 'অপারেটর'}`).join('\n') || 'কোনো সদস্য নেই');
      const id = Number(idRaw);
      if (!Number.isInteger(id) || id <= 0) return ctx.reply('ব্যবহার: /member add <টেলিগ্রাম আইডি> viewer|operator');
      if (sub === 'add') {
        if (id === t.ownerId) return ctx.reply('এটি মালিকের আইডি।');
        const role = roleRaw === 'operator' ? 'operator' : 'viewer';
        t.members = t.members.filter((m) => m.id !== id).concat([{ id, role, addedAt: Date.now() }]);
        this.store.save(); return ctx.reply(`✅ ${id} যোগ হয়েছে (${role === 'viewer' ? 'শুধু দেখা' : 'অপারেটর'})`);
      }
      if (sub === 'remove') { t.members = t.members.filter((m) => m.id !== id); this.store.save(); return ctx.reply('✅ সরানো হয়েছে'); }
      return ctx.reply('ব্যবহার: /member add|remove|list');
    });
    // ইনলাইন মোড: যেকোনো চ্যাটে @বটনাম টাইপ করে দ্রুত অবস্থা (BotFather-এ Inline mode চালু থাকতে হবে)
    bot.on('inline_query', async (ctx) => {
      const q = String(ctx.inlineQuery.query || '').toLowerCase();
      const rows = [];
      for (const b of this.store.data.bots) { const s = this.runner.snapshot(b.id); rows.push({ type: 'article', id: 'b' + b.id, title: `${DOT[s.state]} ${b.username}`, description: `${STATE_TAG[s.state]} · স্বাস্থ্য ${s.health}/100`, input_message_content: { message_text: `${DOT[s.state]} <b>${esc(b.username)}</b> — ${STATE_TAG[s.state]}, স্বাস্থ্য ${s.health}/100`, parse_mode: 'HTML' } }); }
      for (const w of this.workers.all()) { const v = this.workers.view(w); const a = this.workers.agg([w.id], this.tzMin()); rows.push({ type: 'article', id: 'w' + w.id, title: `${WDOT[v.state] || '⚪'} ${w.name}`, description: `আজ ${nf(a.today.req)} রিকোয়েস্ট · ত্রুটি ${a.today.err}`, input_message_content: { message_text: `☁️ <b>${esc(w.name)}</b> — ${WSTATE[v.state] || v.state}\nআজ ${nf(a.today.req)} রিকোয়েস্ট, ত্রুটি ${a.today.err}`, parse_mode: 'HTML' } }); }
      await ctx.answerInlineQuery(rows.filter((r) => !q || r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)).slice(0, 40), { cache_time: 10 }).catch(() => {});
    });
    bot.command('bots', (ctx) => this.show(ctx, this.vBots(0)));
    bot.command('workers', (ctx) => this.show(ctx, this.vWorkers(0)));
    bot.command('stats', (ctx) => this.show(ctx, this.vAnalytics()));
    bot.command('insights', (ctx) => this.show(ctx, this.vInsights()));
    bot.command('system', (ctx) => this.show(ctx, this.vSystem()));
    bot.command('ai', (ctx) => { const q = ctx.message.text.replace(/^\/ai(@\w+)?\s*/, ''); this.chatMode.set(ctx.from.id, '_fleet'); return q ? this.askAi(ctx, '_fleet', q) : this.show(ctx, this.vAiHome()); });
    for (const cmd of ['logs', 'run', 'stop', 'restart', 'say']) bot.command(cmd, (ctx) => this.quickCmd(ctx, cmd).catch((e) => ctx.reply('ত্রুটি: ' + e.message)));
    bot.on('callback_query', async (ctx) => {
      await ctx.answerCbQuery().catch(() => {});
      try { await this.route(ctx, t, String(ctx.callbackQuery.data || '')); } catch (e) { console.error('[tg:cb]', e.message); await ctx.reply('ত্রুটি: ' + esc(e.message), { parse_mode: 'HTML' }).catch(() => {}); }
    });
    bot.on('text', (ctx) => this.onText(ctx, t, ctx.message.text).catch((e) => console.error('[tg:text]', e.message)));
    bot.on('document', (ctx) => this.onDoc(ctx, t).catch(async (e) => { console.error('[tg:doc]', e.message); await ctx.reply('ফাইল প্রক্রিয়া করা যায়নি: ' + e.message).catch(() => {}); }));

    bot.launch({ dropPendingUpdates: true }).catch((e) => { console.error('[tg] launch ব্যর্থ:', e.message); this.inst.delete(t.id); });
    bot.telegram.setMyCommands([
      { command: 'menu', description: 'মূল মেনু' }, { command: 'bots', description: 'সব বট' }, { command: 'workers', description: 'সব Worker' },
      { command: 'stats', description: 'অ্যানালিটিক্স' }, { command: 'insights', description: 'স্মার্ট ইনসাইট' }, { command: 'system', description: 'সিস্টেম' },
      { command: 'ai', description: 'AI সহায়ক' }, { command: 'logs', description: 'লগ: /logs নাম' }, { command: 'restart', description: 'রিস্টার্ট: /restart নাম' }, { command: 'help', description: 'সাহায্য' },
    ]).catch(() => {});
  }

  _reset(uid) { this.wiz.delete(uid); this.chatMode.delete(uid); }
  owners() { return this.store.data.tgBots.filter((t) => this.inst.has(t.id) && t.ownerId).map((t) => ({ inst: this.inst.get(t.id), id: t.ownerId })); }
  broadcast(text, rows) { for (const o of this.owners()) o.inst.telegram.sendMessage(o.id, clip(text), { parse_mode: 'HTML', disable_notification: this.muted(), disable_web_page_preview: true, ...KB(rows || []) }).catch(() => {}); }

  helpText() {
    return `<b>MC Host কন্ট্রোল</b>\n${LINE}\n/menu মূল মেনু\n/bots · /workers · /stats · /insights · /system\n/logs <i>নাম</i> · /restart <i>নাম</i> · /run <i>নাম</i> · /stop <i>নাম</i>\n/say <i>বট</i> <i>মেসেজ</i> গেমে চ্যাট\n/ai <i>প্রশ্ন</i> AI সহায়ক\n\n💡 টিপস:\n• কোনো <b>.js / .zip / .env ফাইল</b> পাঠালে কোথায় রাখবেন জিজ্ঞেস করব\n• কার্ডে <b>🔴 লাইভ</b> চাপলে ২ মিনিট নিজে আপডেট হবে\n• নিচের মেনু বোতাম সবসময় আছে`;
  }

  replyKeyboard() { return Markup.keyboard([[MENU.home, MENU.bots, MENU.workers], [MENU.an, MENU.ai, MENU.se]]).resize().persistent(); }

  // ---------- নোটিফিকেশন ----------
  notifyEvent(ev) {
    if (ev.bot.notify === false || this.store.setting('notifyBots', true) === false) return;
    const b = ev.bot; const d = diagnose(ev.reason);
    const name = `<b>${esc(b.username)}</b>`;
    const rows = [[B('🔄 রিস্টার্ট', 'r:' + b.id), B('📜 লগ', 'l:' + b.id), B('🤖 বট', 'b:' + b.id)]];
    let text;
    if (ev.type === 'online') text = ev.recovered ? `🟢 ${name} আবার অনলাইন ✅` : `🟢 ${name} সার্ভারে ঢুকেছে`;
    else if (ev.type === 'offline') {
      text = `🔴 ${name} অফলাইন\n${LINE}\n${d ? `<b>${esc(d.title)}</b>\n<i>${esc(d.hint)}</i>\n` : ''}⏱ ${ev.nextIn}সে পরে আবার চেষ্টা হবে`;
      rows.push(this.fixButtons(b.id, d)); if (this.ai.ready()) rows.push([B('✨ AI দিয়ে বিশ্লেষণ', `aq:${b.id}:0`)]);
    } else if (ev.type === 'failing') {
      text = `🟠 ${name} ${ev.attempts} বার চেষ্টা করেও ঢুকতে পারেনি\n${LINE}\n${d ? `<b>${esc(d.title)}</b>\n<i>${esc(d.hint)}</i>` : esc(ev.reason)}`;
      rows.push(this.fixButtons(b.id, d)); if (this.ai.ready()) rows.push([B('✨ AI দিয়ে বিশ্লেষণ', `aq:${b.id}:0`)]);
    } else return;
    this.broadcast(text, rows);
  }

  notifyWorker(ev) {
    if (this.store.setting('notifyWorkers', true) === false) return;
    const w = ev.worker; const name = `<b>${esc(w.name)}</b>`;
    const rows = [[B('🔄 রিস্টার্ট', 'wr:' + w.id), B('📜 লগ', 'wlg:' + w.id), B('☁️ Worker', 'w:' + w.id)]];
    let text;
    if (ev.type === 'down') { text = `🔴 Worker ${name} বন্ধ/ত্রুটিতে\n${LINE}\n<code>${esc(String(ev.reason || '').slice(0, 300))}</code>`; if (this.ai.ready()) rows.push([B('✨ AI দিয়ে ঠিক করুন', `waq:${w.id}:0`)]); }
    else if (ev.type === 'up') text = `🟢 Worker ${name} আবার চালু ✅`;
    else if (ev.type === 'errorrate') { text = `🟠 Worker ${name}-এ ত্রুটির হার বেশি\n${LINE}\nগত ৫ মিনিটে ${ev.total} রিকোয়েস্টের <b>${ev.errors}</b>টি 5xx (${pct(ev.errors, ev.total)}%)`; if (this.ai.ready()) rows.push([B('✨ AI দিয়ে বিশ্লেষণ', `waq:${w.id}:0`)]); }
    else return;
    this.broadcast(text, rows);
  }

  fixButtons(id, d) {
    const t = d ? d.title : '';
    if (/ব্যান|হোয়াইটলিস্ট|এই নামে/.test(t)) return [B('✏️ নাম বদলান', `ce:${id}:name`)];
    if (/ভার্সন/.test(t)) return [B('🧩 ভার্সন সেট করুন', `ce:${id}:version`)];
    if (/হোস্টনেম|বন্ধ বা পোর্ট|সাড়া দিচ্ছে না/.test(t)) return [B('🌐 সার্ভার বদলান', `ce:${id}:host`)];
    return [];
  }

  async _digestTick() {
    const h = Number(this.store.setting('digestHour', -1));
    if (h < 0) return;
    const local = new Date(Date.now() + (-this.tzMin()) * 60000);
    const day = local.toISOString().slice(0, 10);
    if (local.getUTCHours() !== h || this.store.setting('digestLast', '') === day) return;
    this.store.setSetting('digestLast', day);
    const v = this.vDigest();
    this.broadcast(v.text, v.kb.reply_markup ? v.kb.reply_markup.inline_keyboard : []);
  }

  vDigest() {
    const a = this.wagg(); const f = this.runner.fleet(); const ins = this.insightsList().filter((x) => x.level !== 'good').slice(0, 3);
    const text = `🗞 <b>দৈনিক রিপোর্ট</b>\n${LINE}\n🤖 বট: ${f.online}/${f.total} অনলাইন\n☁️ Workers: আজ <b>${nf(a.today.req)}</b> রিকোয়েস্ট (${trend(a.today.req, a.yesterday.req)}), ত্রুটি ${nf(a.today.err)}, গড় ${avg(a.today)}ms\n🕒 ${spark(a.hours.map((x) => x.req))}\n${ins.length ? '\n' + ins.map((x) => `${LV[x.level]} ${esc(x.title)}`).join('\n') : '\n✅ কোনো সমস্যা নেই'}`;
    return { text, kb: KB([[B('📊 বিস্তারিত', 'an'), B('🏠 হোম', 'h')]]) };
  }

  // ================= ভিউ (টেক্সট + বোতাম) =================
  liveRow(key, id, live) { return live ? [B('⏹ লাইভ বন্ধ', `lx:${key}:${id || 0}`)] : [B('🔴 লাইভ', `lv:${key}:${id || 0}`)]; }

  vHome(live) {
    const bots = this.store.data.bots; const f = this.runner.fleet();
    const cnt = { online: 0, reconnecting: 0, starting: 0, stopped: 0 };
    for (const b of bots) cnt[this.runner.state(b.id)]++;
    const ws = this.workers.all(); const run = ws.filter((w) => this.workers._rt(w.id).state === 'running').length;
    const a = this.wagg(); const si = this.sys.info(this.store, this.runner, this.workers);
    const ins = this.insightsList().filter((x) => x.level !== 'good').slice(0, 3);
    const text = `🏠 <b>MC Host</b>${live ? '  ·  🔴 <i>লাইভ</i>' : ''}\n${LINE}\n🤖 <b>বট</b>  🟢 ${cnt.online}  🟠 ${cnt.reconnecting + cnt.starting}  ⚪ ${cnt.stopped}  <i>(${bots.length})</i>\n☁️ <b>Workers</b>  🟢 ${run}/${ws.length}  ·  আজ <b>${nf(a.today.req)}</b> রিকোয়েস্ট ${trend(a.today.req, a.yesterday.req)}${a.today.err ? `  ·  ⚠️ ${a.today.err}` : ''}\n🕒 <code>${spark(a.hours.map((x) => x.req))}</code>\n💾 RAM ${si.rss}MB  ·  ⏱ ${fmtDur(si.uptime)}  ·  ⚡ ${si.lag}ms\n✨ AI: ${this.ai.ready() ? esc(this.ai.model()) : 'বন্ধ'}${this.muted() ? '\n🔕 নোটিফিকেশন নীরব' : ''}\n${LINE}\n${ins.length ? ins.map((x) => `${LV[x.level]} <b>${esc(x.title)}</b>`).join('\n') : '✅ সব ঠিক আছে'}`;
    return { text, kb: KB([
      [B('🤖 বট', 'bl:0'), B('☁️ Workers', 'wl:0')],
      [B('📊 অ্যানালিটিক্স', 'an'), B('💡 ইনসাইট', 'in')],
      [B('✨ AI সহায়ক', 'aih'), B('⚙️ সেটিংস', 'se')],
      [B('▶️ সব বট চালু', 'ba:start'), B('⏹ সব বন্ধ', 'ba:stop')],
      [B('🔄 রিফ্রেশ', 'h'), ...this.liveRow('h', 0, live)],
    ]) };
  }

  vBots(p = 0) {
    const bots = this.store.data.bots; const pages = Math.max(1, Math.ceil(bots.length / PAGE)); p = Math.min(Math.max(0, p), pages - 1);
    const slice = bots.slice(p * PAGE, p * PAGE + PAGE);
    const text = `🤖 <b>বট</b>  <i>${bots.length}/${this.maxBots}</i>\n${LINE}\n` + (slice.map((b) => {
      const s = this.runner.snapshot(b.id);
      return `${DOT[s.state]} <b>${esc(b.username)}</b>  <code>${esc(b.host)}:${b.port}</code>\n      ${bar(s.health, 8)} ${s.health}${s.state === 'online' ? ` · ⏱ ${fmtDur(Date.now() - s.onlineSince)}` : s.state === 'reconnecting' ? ` · ⏳ ${s.nextIn}সে` : ''}`;
    }).join('\n') || 'এখনো কোনো বট নেই। ➕ চাপুন।');
    const rows = []; for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2).map((b) => B(`${DOT[this.runner.state(b.id)]} ${b.username}`, 'b:' + b.id)));
    if (pages > 1) rows.push([B('‹', `bl:${p - 1}`), B(`${p + 1}/${pages}`, 'noop'), B('›', `bl:${p + 1}`)]);
    rows.push([B('➕ নতুন বট', 'nb'), B('▶️ সব', 'ba:start'), B('⏹ সব', 'ba:stop'), B('🔄 সব', 'ba:restart')], [B('« হোম', 'h')]);
    return { text, kb: KB(rows) };
  }

  stripOf(s) { return [...(s.strip || '').slice(-18).padStart(18, '.')].map((c) => STRIP[c] || '⬛').join(''); }

  vBot(id, live) {
    const b = this.store.bot(id); if (!b) return this.vBots(0);
    const s = this.runner.snapshot(id); const st = s.stats || { sessions: 0, crashes: 0, upMs: 0 };
    const l = [`${DOT[s.state]} <b>${esc(b.username)}</b>  ${STATE_TAG[s.state]}${live ? '  ·  🔴 <i>লাইভ</i>' : ''}`, `<code>${esc(b.host)}:${b.port}</code>${b.version ? '  ·  ' + esc(b.version) : ''}`, LINE, `❤️ স্বাস্থ্য ${bar(s.health)} <b>${s.health}</b>`, `📶 ${this.stripOf(s)}`];
    if (s.state === 'online') {
      l.push(`⏱ আপটাইম <b>${fmtDur(Date.now() - s.onlineSince)}</b>`);
      const i = s.info;
      if (i) l.push(`🎮 HP ${i.health ?? '-'} · 🍗 ${i.food ?? '-'} · 📡 ${i.ping ?? '-'}ms · 👥 ${i.players ?? '-'}${i.mem ? ` · 💾 ${i.mem}MB` : ''}${i.pos ? `\n📍 ${i.pos.join(', ')}` : ''}`);
    } else if (s.state === 'reconnecting') l.push(`⏳ পরের চেষ্টা ${s.nextIn}সে পরে (#${s.attempts})`);
    if (s.diag && s.state !== 'online') l.push(`\n⚠️ <b>${esc(s.diag.title)}</b>\n<i>${esc(s.diag.hint)}</i>`);
    l.push(`${LINE}\n📊 সেশন ${st.sessions} · ক্র্যাশ ${st.crashes} · মোট আপটাইম ${fmtDur(st.upMs)}`);
    const run = s.state === 'stopped' ? [B('▶️ চালু', 's:' + id)] : [B('⏹ বন্ধ', 'x:' + id), B('🔄 রিস্টার্ট', 'r:' + id)];
    const rows = [run.concat([B('📜 লগ', 'l:' + id), B('💬 চ্যাট', 'gc:' + id)]), [B('📊 বিশ্লেষণ', 'a:' + id), B('🧩 অটোমেশন', 'au:' + id), B('📝 স্ক্রিপ্ট', 'sc:' + id)], [B('⚙️ সেটিংস', 'cf:' + id), B('🎮 গেমে বলুন', 'sy:' + id), B('✨ AI', 'ai:' + id)]];
    if (s.state !== 'online') { const fx = this.fixButtons(id, s.diag); if (fx.length) rows.unshift(fx); }
    rows.push([B('🔄 রিফ্রেশ', 'b:' + id), ...this.liveRow('b', id, live)], [B('« বট তালিকা', 'bl:0')]);
    return { text: l.join('\n'), kb: KB(rows) };
  }

  vBotLogs(id) {
    const b = this.store.bot(id); const logs = this.runner.logs(id, 24).join('\n') || '(লগ নেই)';
    return { text: `📜 <b>${esc(b.username)} — লগ</b>\n<pre>${esc(logs.slice(-3300))}</pre>`, kb: KB([[B('🔄 রিফ্রেশ', 'l:' + id), B('💬 গেম চ্যাট', 'gc:' + id)], [B('« বট', 'b:' + id)]]) };
  }

  vBotChat(id) {
    const b = this.store.bot(id); const c = this.runner.chatLog(id, 25).map((x) => `${new Date(x.t).toTimeString().slice(0, 8)} ${x.text}`).join('\n') || '(এখনো কোনো চ্যাট আসেনি)';
    return { text: `💬 <b>${esc(b.username)} — গেম চ্যাট</b>\n<pre>${esc(c.slice(-3300))}</pre>`, kb: KB([[B('🔄 রিফ্রেশ', 'gc:' + id), B('🎮 গেমে বলুন', 'sy:' + id)], [B('« বট', 'b:' + id)]]) };
  }

  vBotAn(id) {
    const b = this.store.bot(id); const s = this.runner.snapshot(id); const st = s.stats || { sessions: 0, crashes: 0, upMs: 0, reasons: {} };
    const ev = this.runner.events(id, 8).map((e) => `${new Date(e.t).toTimeString().slice(0, 5)} ${esc(e.type)} ${esc(e.text)}`).join('\n') || '-';
    const top = Object.entries(st.reasons || {}).sort((a, c) => c[1] - a[1]).slice(0, 4);
    const mx = top[0] ? top[0][1] : 1;
    const text = `📊 <b>${esc(b.username)} — বিশ্লেষণ</b>\n${LINE}\n❤️ ${bar(s.health)} <b>${s.health}</b>/100\n📶 ${this.stripOf(s)}\n🔁 সেশন ${st.sessions} · 💥 ক্র্যাশ ${st.crashes} · ⏱ মোট ${fmtDur(st.upMs)}${top.length ? `\n\n<b>সমস্যার ধরন</b>\n${top.map(([n, c]) => `${bar(c / mx * 100, 6)} ${esc(n)} (${c})`).join('\n')}` : ''}\n\n<b>সাম্প্রতিক ঘটনা</b>\n<pre>${ev}</pre>${s.diag ? `\n⚠️ <b>${esc(s.diag.title)}</b>\n<i>${esc(s.diag.hint)}</i>` : ''}`;
    const rows = [[B('🔄 রিফ্রেশ', 'a:' + id), B('« বট', 'b:' + id)]];
    if (this.ai.ready()) rows.unshift([B('✨ AI বিশ্লেষণ', `aq:${id}:0`)]);
    return { text, kb: KB(rows) };
  }

  vAuto(id) {
    const b = this.store.bot(id);
    const j = (b.joinCmds || []).map((x, i) => `${i + 1}. <code>${esc(x.cmd.replace(/^(\/(?:login|register|l|reg)\s+).*/i, '$1••••'))}</code> (${x.delay}সে)`);
    const r = (b.rules || []).map((x, i) => `${i + 1}. "${esc(x.match)}" → ${esc(x.reply)}${x.regex ? ' <i>(regex)</i>' : ''}`);
    const p = (b.periodic || []).map((x, i) => `${i + 1}. ${esc(x.text)} <i>(প্রতি ${x.every}সে)</i>`);
    const text = `🧩 <b>${esc(b.username)} — অটোমেশন</b>\n${LINE}\n<b>জয়েন কমান্ড</b>\n${j.join('\n') || '<i>নেই</i>'}\n\n<b>অটো-রিপ্লাই</b>\n${r.join('\n') || '<i>নেই</i>'}\n\n<b>সময় পরপর মেসেজ</b>\n${p.join('\n') || '<i>নেই</i>'}`;
    const rows = [[B('➕ জয়েন কমান্ড', 'auj:' + id), B('➕ রিপ্লাই', 'aur:' + id), B('➕ পিরিয়ডিক', 'aup:' + id)]];
    const dels = [];
    (b.joinCmds || []).forEach((_, i) => dels.push(B(`🗑 J${i + 1}`, `aud:${id}:j:${i}`)));
    (b.rules || []).forEach((_, i) => dels.push(B(`🗑 R${i + 1}`, `aud:${id}:r:${i}`)));
    (b.periodic || []).forEach((_, i) => dels.push(B(`🗑 P${i + 1}`, `aud:${id}:p:${i}`)));
    for (let i = 0; i < dels.length; i += 4) rows.push(dels.slice(i, i + 4));
    rows.push([B('« বট', 'b:' + id)]);
    return { text, kb: KB(rows) };
  }

  vScript(id) {
    const b = this.store.bot(id);
    return { text: `📝 <b>${esc(b.username)} — স্ক্রিপ্ট</b>\n${LINE}\nসাইজ: ${kb(this.store.readScript(id).length)}`, kb: KB([
      [B('📄 ফাইল হিসেবে দেখুন', 'sd:' + id), B('✏️ এডিট/আপলোড', 'se:' + id)],
      [B('🧪 টেমপ্লেট', 'st:' + id), B('✨ AI দিয়ে আপডেট', 'ai:' + id)],
      [...(this.store.hasPrev(id) ? [B('↩️ আগের সংস্করণ', 'sr:' + id)] : []), B('♻️ ডিফল্টে রিসেট', 'sz:' + id)],
      [B('« বট', 'b:' + id)]]) };
  }

  vBotCfg(id) {
    const b = this.store.bot(id);
    return { text: `⚙️ <b>সেটিংস: ${esc(b.username)}</b>\n${LINE}\nনাম: <code>${esc(b.username)}</code>\nসার্ভার: <code>${esc(b.host)}:${b.port}</code>\nভার্সন: ${esc(b.version || 'অটো')}\nনোটিফিকেশন: ${b.notify === false ? '🔕 বন্ধ' : '🔔 চালু'}\nঅটো-রিস্টার্ট: ${b.autoRestartHours ? 'প্রতি ' + b.autoRestartHours + ' ঘণ্টা' : 'বন্ধ'}`, kb: KB([
      [B('✏️ নাম', `ce:${id}:name`), B('🌐 সার্ভার', `ce:${id}:host`), B('🧩 ভার্সন', `ce:${id}:version`)],
      [B(b.notify === false ? '🔔 নোটিফিকেশন চালু' : '🔕 নোটিফিকেশন বন্ধ', 'cn:' + id)],
      [B('⏰ অটো-রিস্টার্ট:', 'noop'), ...[0, 6, 12, 24].map((h) => B(h === (b.autoRestartHours || 0) ? `✅ ${h ? h + 'ঘ' : 'বন্ধ'}` : (h ? h + 'ঘ' : 'বন্ধ'), `ar:${id}:${h}`))],
      [B('📋 ক্লোন', 'cl:' + id), B('🗑 মুছুন', 'dl:' + id)], [B('« বট', 'b:' + id)]]) };
  }

  // ---------- Workers ----------
  vWorkers(p = 0) {
    const ws = this.workers.all(); const pages = Math.max(1, Math.ceil(ws.length / PAGE)); p = Math.min(Math.max(0, p), pages - 1);
    const slice = ws.slice(p * PAGE, p * PAGE + PAGE); const a = this.wagg();
    const text = `☁️ <b>Workers</b>  <i>${ws.length}/${this.workers.max}</i>\n${LINE}\nআজ <b>${nf(a.today.req)}</b> ${trend(a.today.req, a.yesterday.req)} · ত্রুটি ${nf(a.today.err)} · ⏱ ${avg(a.today)}ms\n🕒 <code>${spark(a.hours.map((x) => x.req))}</code>\n\n` + (slice.map((w) => {
      const v = this.workers.view(w); const t = this.wagg([w.id]).today;
      return `${WDOT[v.state]} <b>${esc(w.name)}</b>  <code>/w/${esc(w.slug)}</code>\n      আজ ${nf(t.req)} · ⚠️ ${t.err} · 📦 ${v.fileCount}`;
    }).join('\n') || 'এখনো কোনো Worker নেই। ➕ চাপুন।');
    const rows = []; for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2).map((w) => B(`${WDOT[this.workers._rt(w.id).state]} ${w.name}`, 'w:' + w.id)));
    if (pages > 1) rows.push([B('‹', `wl:${p - 1}`), B(`${p + 1}/${pages}`, 'noop'), B('›', `wl:${p + 1}`)]);
    rows.push([B('➕ নতুন Worker', 'wn'), B('📊 অ্যানালিটিক্স', 'an')], [B('« হোম', 'h')]);
    return { text, kb: KB(rows) };
  }

  vWorker(id, live) {
    const w = this.workers.get(id); if (!w) return this.vWorkers(0);
    const v = this.workers.view(w); const a = this.workers.agg([id], this.tzMin()); const lat = this.workers.latency(id);
    const l = [`${WDOT[v.state]} <b>${esc(w.name)}</b>  ${WSTATE[v.state]}${live ? '  ·  🔴 <i>লাইভ</i>' : ''}`, `🔗 <code>${esc(this.wurl(w))}</code>`, LINE,
      `📈 আজ <b>${nf(a.today.req)}</b> ${trend(a.today.req, a.yesterday.req)}  ·  গতকাল ${nf(a.yesterday.req)}`,
      `⚠️ ত্রুটি ${nf(a.today.err)} (${pct(a.today.err, a.today.req)}%)  ·  ⏱ গড় ${avg(a.today)}ms · p95 ${lat.p95}ms`,
      `🕒 <code>${spark(a.hours.map((x) => x.req))}</code>`,
      `📦 ${v.fileCount} ফাইল (${kb(v.totalSize)}) · 🔑 ${v.envCount} ENV · 🗄 KV ${v.kvKeys}${v.cronMin ? ` · ⏰ ${v.cronMin}মি` : ''}${v.rateLimit ? ` · 🚦 ${v.rateLimit}/মি` : ''}`];
    if (v.state === 'error') l.push(`\n🚨 <code>${esc(String(v.error).split('\n')[0].slice(0, 200))}</code>`);
    const run = w.enabled ? [B('⏹ বন্ধ', 'wx:' + id), B('🔄 রিস্টার্ট', 'wr:' + id)] : [B('▶️ চালু', 'ws:' + id)];
    const rows = [run.concat([B('📜 লগ', 'wlg:' + id), B('🧪 টেস্ট', 'wt:' + id)]), [B('📁 ফাইল', `wf:${id}:0`), B('🔑 ENV', 'we:' + id), B('📊 বিশ্লেষণ', 'wa:' + id), B('🕘 ভার্সন', 'wv:' + id)], [B('✨ AI', 'wai:' + id), B('⚙️ সেটিংস', 'wc:' + id), B('🚀 ডিপ্লয়', 'wd:' + id)], [B('🔄 রিফ্রেশ', 'w:' + id), ...this.liveRow('w', id, live)], [B('« Workers', 'wl:0')]];
    return { text: l.join('\n'), kb: KB(rows) };
  }

  vWLogs(id) {
    const w = this.workers.get(id); const logs = this.workers.logs(id).slice(-24).join('\n') || '(কোনো লগ নেই)';
    return { text: `📜 <b>${esc(w.name)} — লগ</b>\n<pre>${esc(logs.slice(-3300))}</pre>`, kb: KB([[B('🔄 রিফ্রেশ', 'wlg:' + id), B('🧪 টেস্ট', 'wt:' + id)], [B('« Worker', 'w:' + id)]]) };
  }

  vWFiles(id, p = 0) {
    const w = this.workers.get(id); const files = this.workers.listFiles(id); const pages = Math.max(1, Math.ceil(files.length / 8)); p = Math.min(Math.max(0, p), pages - 1);
    const slice = files.slice(p * 8, p * 8 + 8); const entry = this.workers.entryOf(w);
    const text = `📁 <b>${esc(w.name)} — ফাইল</b>  <i>${files.length}</i>\n${LINE}\n` + (slice.map((f) => `${f.path === entry ? '⭐' : '📄'} <code>${esc(f.path)}</code>  <i>${kb(f.size)}</i>`).join('\n') || 'কোনো ফাইল নেই') + `\n\n<i>ফাইল খুলতে নিচে চাপুন। আপলোডে সরাসরি ফাইল/ZIP পাঠান।</i>`;
    const rows = slice.map((f) => [B(`${f.path === entry ? '⭐' : '📄'} ${f.path.slice(-34)}`, `wfo:${id}:${files.indexOf(f)}`)]);
    if (pages > 1) rows.push([B('‹', `wf:${id}:${p - 1}`), B(`${p + 1}/${pages}`, 'noop'), B('›', `wf:${id}:${p + 1}`)]);
    rows.push([B('⬆️ ফাইল/ZIP আপলোড', 'wup:' + id), B('➕ নতুন ফাইল', 'wnf:' + id)], [B('📦 ZIP ডাউনলোড', 'wzip:' + id), B('« Worker', 'w:' + id)]);
    return { text, kb: KB(rows) };
  }

  vWFile(id, idx) {
    const files = this.workers.listFiles(id); const f = files[idx]; if (!f) return this.vWFiles(id, 0);
    let preview = '';
    try { const r = this.workers.readFile(id, f.path); preview = r.text ? `<pre>${esc(r.text.slice(0, 1400))}</pre>` : `<i>${r.binary ? 'বাইনারি ফাইল' : 'অনেক বড়'}</i>`; } catch { /* ignore */ }
    const w = this.workers.get(id);
    return { text: `📄 <code>${esc(f.path)}</code>  <i>${kb(f.size)}</i>${f.path === this.workers.entryOf(w) ? '  ⭐ এন্ট্রি' : ''}\n${preview}`, kb: KB([
      [B('📥 পাঠান', `wfd:${id}:${idx}`), B('✏️ নতুন কন্টেন্ট', `wfe:${id}:${idx}`)],
      [...(/\.(m?js|cjs)$/.test(f.path) ? [B('⭐ এন্ট্রি করুন', `wfs:${id}:${idx}`)] : []), B('🗑 মুছুন', `wfx:${id}:${idx}`)],
      [B('« ফাইল', `wf:${id}:0`)]]) };
  }

  vWEnv(id) {
    const w = this.workers.get(id); const env = w.env || [];
    const text = `🔑 <b>${esc(w.name)} — ENV</b>  <i>${env.length}</i>\n${LINE}\n` + (env.map((e, i) => `${i + 1}. <code>${esc(e.key)}</code> = ${e.secret ? '🔒 ••••••' : `<code>${esc(e.value.length > 28 ? e.value.slice(0, 28) + '…' : e.value)}</code>`}`).join('\n') || 'কোনো ভেরিয়েবল নেই') + `\n\n<i>কোডে: env.KEY বা process.env.KEY</i>`;
    const rows = []; for (let i = 0; i < env.length; i += 2) rows.push(env.slice(i, i + 2).map((e, j) => B(`${e.secret ? '🔒' : '🔑'} ${e.key}`, `wei:${id}:${i + j}`)));
    rows.push([B('➕ যোগ/আপডেট', 'wea:' + id), B('📥 .env ফাইল ইমপোর্ট', 'wei2:' + id)], [B('« Worker', 'w:' + id)]);
    return { text, kb: KB(rows) };
  }

  vWEnvItem(id, idx) {
    const w = this.workers.get(id); const e = (w.env || [])[idx]; if (!e) return this.vWEnv(id);
    return { text: `🔑 <code>${esc(e.key)}</code>\n${LINE}\nমান: ${e.secret ? '🔒 গোপন' : `<code>${esc(e.value.slice(0, 200))}</code>`}\nধরন: ${e.secret ? 'গোপন (secret)' : 'সাধারণ'}`, kb: KB([[B('✏️ মান বদলান', `wee:${id}:${idx}`), B(e.secret ? '🔓 সাধারণ করুন' : '🔒 গোপন করুন', `wes:${id}:${idx}`)], [B('🗑 মুছুন', `wed:${id}:${idx}`), B('« ENV', 'we:' + id)]]) };
  }

  vWAn(id) {
    const w = this.workers.get(id); const a = this.workers.agg([id], this.tzMin()); const x = this.workers.extra(id); const lat = this.workers.latency(id);
    const DAYS = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহ', 'শুক্র', 'শনি'];
    let pk = { v: 0, d: 0, h: 0 }; a.heat.forEach((row, d) => row.forEach((v, h) => { if (v > pk.v) pk = { v, d, h }; }));
    const lt = x.lhist.reduce((s, n) => s + n, 0) || 1; const names = ['<10ms', '<25ms', '<50ms', '<100ms', '<250ms', '<1সে', '≥1সে'];
    const codes = a.codes30; const ct = codes.reduce((s, n) => s + n, 0) || 1;
    const ua = Object.entries(x.ua).sort((p, q) => q[1] - p[1]).slice(0, 4).map(([k, n]) => `${esc(k)} ${Math.round(n / (w ? this.workers.stats(id).t || 1 : 1) * 100)}%`).join(' · ');
    const meth = Object.entries(x.methods).sort((p, q) => q[1] - p[1]).slice(0, 4).map(([k, n]) => `${esc(k)} ${n}`).join(' · ');
    const text = `📊 <b>${esc(w.name)} — বিশ্লেষণ</b>\n${LINE}\n<b>রিকোয়েস্ট</b>\nআজ <b>${nf(a.today.req)}</b> ${trend(a.today.req, a.yesterday.req)} · গতকাল ${nf(a.yesterday.req)}\n৭ দিন ${nf(a.d7.req)} · ৩০ দিন ${nf(a.d30.req)} · মোট ${nf(a.total)}\n\n⚠️ আজ ত্রুটি ${nf(a.today.err)} (${pct(a.today.err, a.today.req)}%) · টাইমআউট ${a.inv.tmo} · exception ${a.inv.exc}\n⏱ গড় ${avg(a.today)}ms · p50 ${lat.p50} · p95 ${lat.p95} · p99 ${lat.p99}\n📦 ডাটা আজ ${kb(a.today.bytes)} · ⚙️ CPU গড় ${a.today.req ? Math.round(a.today.cpu / a.today.req * 10) / 10 : 0}ms\n\n🕒 ২৪ঘ <code>${spark(a.hours.map((h) => h.req))}</code>\n📅 ১৪দিন <code>${spark(a.days.map((d) => d.req))}</code>${pk.v ? `\n🔥 ব্যস্ততম: ${DAYS[pk.d]} ${String(pk.h).padStart(2, '0')}:00` : ''}\n\n<b>লেটেন্সি</b>\n<code>${x.lhist.map((n, i) => `${names[i].padEnd(6)} ${bar(n / lt * 100, 8)} ${Math.round(n / lt * 100)}%`).join('\n')}</code>\n\n<b>স্ট্যাটাস (৩০ দিন)</b>\n<code>${['2xx', '3xx', '4xx', '5xx'].map((n, i) => `${n} ${bar(codes[i] / ct * 100, 8)} ${nf(codes[i])}`).join('\n')}</code>${x.top.length ? `\n\n<b>শীর্ষ এন্ডপয়েন্ট</b>\n${x.top.slice(0, 5).map((t) => `<code>${esc(t.path)}</code> — ${nf(t.req)}${t.err ? ` (⚠️${t.err})` : ''} · ${t.avg}ms`).join('\n')}` : ''}${ua ? `\n\n🌐 ${ua}` : ''}${meth ? `\n🔧 ${meth}` : ''}`;
    const rows = [[B('🔄 রিফ্রেশ', 'wa:' + id), B('📜 লগ', 'wlg:' + id)]];
    if (this.ai.ready()) rows.unshift([B('✨ AI বিশ্লেষণ', `waq:${id}:0`)]);
    rows.push([B('« Worker', 'w:' + id)]);
    return { text: clip(text), kb: KB(rows) };
  }

  vWVers(id) {
    const w = this.workers.get(id); const vs = this.workers.versions(id);
    const ic = { ok: '✅', failed: '❌', manual: '📌' };
    const text = `🕘 <b>${esc(w.name)} — ভার্সন</b>\n${LINE}\n` + (vs.map((v, i) => `${ic[v.label] || '•'} ${new Date(v.ts + (-this.tzMin()) * 60000).toISOString().slice(5, 16).replace('T', ' ')} · ${v.files} ফাইল · ${kb(v.size)}`).join('\n') || 'এখনো কোনো ভার্সন নেই (সফল ডিপ্লয়ে তৈরি হয়)');
    const rows = vs.slice(0, 6).map((v, i) => [B(`↩️ ${i + 1}. ফেরান (${ic[v.label]})`, `wvr:${id}:${v.name}`)]);
    rows.push([B('📌 এখনকার ভার্সন সেভ', 'wvs:' + id)], [B('« Worker', 'w:' + id)]);
    return { text, kb: KB(rows) };
  }

  vWCfg(id) {
    const w = this.workers.get(id); const v = this.workers.view(w);
    return { text: `⚙️ <b>সেটিংস: ${esc(w.name)}</b>\n${LINE}\nনাম: ${esc(w.name)}\nURL: <code>${esc(this.wurl(w))}</code>\nএন্ট্রি: <code>${esc(v.entry)}</code>\nCron: ${w.cronMin ? 'প্রতি ' + w.cronMin + ' মিনিট' : 'বন্ধ'}\nRate limit: ${w.rateLimit ? w.rateLimit + '/মিনিট (প্রতি IP)' : 'বন্ধ'}`, kb: KB([
      [B('✏️ নাম', 'wcn:' + id), B('🔗 URL নাম', 'wcs:' + id)],
      [B('⏰ Cron:', 'noop'), ...[0, 1, 5, 15, 60].map((m) => B(m === (w.cronMin || 0) ? `✅ ${m || 'বন্ধ'}` : (m || 'বন্ধ'), `wcc:${id}:${m}`))],
      [B('🚦 Rate:', 'noop'), ...[0, 30, 60, 120, 600].map((m) => B(m === (w.rateLimit || 0) ? `✅ ${m || 'বন্ধ'}` : (m || 'বন্ধ'), `wcr:${id}:${m}`))],
      [B('📋 ক্লোন', 'wcl:' + id), B('📦 ZIP', 'wzip:' + id), B('🗑 মুছুন', 'wdl:' + id)], [B('« Worker', 'w:' + id)]]) };
  }

  // ---------- বিশ্লেষণ / ইনসাইট / সিস্টেম / সেটিংস ----------
  vAnalytics(live) {
    const a = this.wagg(); const ws = this.workers.all(); const bots = this.store.data.bots;
    const per = ws.map((w) => ({ w, t: this.wagg([w.id]).today })).sort((p, q) => q.t.req - p.t.req).slice(0, 4); const mx = per[0] ? Math.max(1, per[0].t.req) : 1;
    const feed = (this.runner.feed || []).slice(-5).reverse().map((e) => `${new Date(e.t).toTimeString().slice(0, 5)} ${esc(e.bot || '')} ${esc(e.type)}`).join('\n');
    const text = `📊 <b>অ্যানালিটিক্স</b>${live ? '  ·  🔴 <i>লাইভ</i>' : ''}\n${LINE}\n<b>☁️ Workers</b>\nআজ <b>${nf(a.today.req)}</b> ${trend(a.today.req, a.yesterday.req)} · গতকাল ${nf(a.yesterday.req)} · ৭দিন ${nf(a.d7.req)} · ৩০দিন ${nf(a.d30.req)}\n⚠️ ত্রুটি ${nf(a.today.err)} (${pct(a.today.err, a.today.req)}%) · ⏱ ${avg(a.today)}ms · 📦 ${kb(a.today.bytes)}\n🕒 ২৪ঘ <code>${spark(a.hours.map((h) => h.req))}</code>\n📅 ১৪দিন <code>${spark(a.days.map((d) => d.req))}</code>${per.length ? `\n\n<b>🏆 শীর্ষ Worker (আজ)</b>\n${per.map((x) => `${bar(x.t.req / mx * 100, 8)} ${esc(x.w.name)} — ${nf(x.t.req)}`).join('\n')}` : ''}\n\n<b>🤖 বট স্বাস্থ্য</b>\n${bots.map((b) => { const s = this.runner.snapshot(b.id); return `${DOT[s.state]} ${bar(s.health, 8)} ${s.health} ${esc(b.username)}`; }).join('\n') || '<i>কোনো বট নেই</i>'}${feed ? `\n\n<b>🚨 সাম্প্রতিক ঘটনা</b>\n<pre>${feed}</pre>` : ''}`;
    return { text: clip(text), kb: KB([[B('💡 ইনসাইট', 'in'), B('🖥 সিস্টেম', 'sys')], [B('🔄 রিফ্রেশ', 'an'), ...this.liveRow('an', 0, live)], [B('« হোম', 'h')]]) };
  }

  vInsights() {
    const items = this.insightsList();
    const text = `💡 <b>স্মার্ট ইনসাইট</b>\n${LINE}\n` + items.slice(0, 8).map((x) => `${LV[x.level]} <b>${esc(x.title)}</b>\n<i>${esc(x.text)}</i>`).join('\n\n');
    const rows = [];
    for (const x of items.slice(0, 8)) if (x.action && x.action.id) rows.push([B(`${x.action.page === 'workers' ? '☁️' : '🤖'} ${x.title.slice(0, 30)}`, `${x.action.page === 'workers' ? 'w' : 'b'}:${x.action.id}`)]);
    rows.push([B('🔄 রিফ্রেশ', 'in'), B('« হোম', 'h')]);
    return { text: clip(text), kb: KB(rows.slice(0, 7)) };
  }

  vSystem(live) {
    const s = this.sys.info(this.store, this.runner, this.workers);
    const ramP = s.totalMem ? Math.round(s.rss / s.totalMem * 100) : 0;
    const text = `🖥 <b>সিস্টেম</b>${live ? '  ·  🔴 <i>লাইভ</i>' : ''}\n${LINE}\n💾 RAM ${bar(ramP)} ${s.rss}MB / ${s.totalMem}MB\n🧮 Heap ${s.heap}MB · খালি ${s.freeMem}MB\n⚙️ লোড ${s.load.join(' / ')} (${s.cpus} CPU)\n⚡ Event-loop lag ${s.lag}ms\n💽 ডাটা ফোল্ডার ${s.disk}MB (${esc(this.store.mode)})\n⏱ আপটাইম ${fmtDur(s.uptime)} · Node ${esc(s.node)}\n🔧 প্রসেস: বট ${s.procs.bots} · Worker ${s.procs.workers}`;
    return { text, kb: KB([[B('🔄 রিফ্রেশ', 'sys'), ...this.liveRow('sys', 0, live)], [B('💾 ব্যাকআপ পাঠান', 'bk'), B('« হোম', 'h')]]) };
  }

  vSettings() {
    const dg = Number(this.store.setting('digestHour', -1)); const tz = Number(this.store.setting('tzOffset', 0)) || 0;
    const tzs = (m) => `UTC${m >= 0 ? '+' : '-'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? ':' + String(Math.abs(m) % 60).padStart(2, '0') : ''}`;
    const nb = this.store.setting('notifyBots', true) !== false, nw = this.store.setting('notifyWorkers', true) !== false;
    const text = `⚙️ <b>সেটিংস</b>\n${LINE}\n🔔 বট নোটিফিকেশন: ${nb ? 'চালু' : 'বন্ধ'}\n🔔 Worker নোটিফিকেশন: ${nw ? 'চালু' : 'বন্ধ'}\n${this.muted() ? `🔕 নীরব (${fmtDur(Number(this.store.setting('muteUntil', 0)) - Date.now())} বাকি)` : '🔔 নীরব মোড: বন্ধ'}\n🗞 দৈনিক রিপোর্ট: ${dg >= 0 ? String(dg).padStart(2, '0') + ':00' : 'বন্ধ'}\n🕐 টাইমজোন: ${tzs(tz)}\n✨ AI: ${this.ai.ready() ? esc(this.ai.model()) : 'বন্ধ (key নেই)'}`;
    return { text, kb: KB([
      [B(nb ? '🔕 বট নোটিফিকেশন বন্ধ' : '🔔 বট নোটিফিকেশন চালু', 'sn:bots'), B(nw ? '🔕 Worker বন্ধ' : '🔔 Worker চালু', 'sn:workers')],
      [B('🔕 নীরব:', 'noop'), B('১ঘ', 'sm:1'), B('৮ঘ', 'sm:8'), B('২৪ঘ', 'sm:24'), B('বন্ধ', 'sm:0')],
      [B('🗞 রিপোর্ট:', 'noop'), ...[-1, 8, 12, 20].map((h) => B(h === dg ? `✅ ${h < 0 ? 'বন্ধ' : h + 'টা'}` : (h < 0 ? 'বন্ধ' : h + 'টা'), `sg:${h}`))],
      [B('🕐 টাইমজোন:', 'noop'), ...[0, 180, 330, 360, 480].map((m) => B(m === tz ? `✅ ${tzs(m)}` : tzs(m), `stz:${m}`))],
      [B('🤖 AI মডেল', 'smd'), B('🔑 AI key দিন', 'sk')],
      [B('🔐 অ্যাক্সেস (টোকেন/ব্যবহারকারী)', 'ac')],
      [B('💾 ব্যাকআপ পাঠান', 'bk'), B('🖥 সিস্টেম', 'sys')], [B('« হোম', 'h')]]) };
  }

  vAiHome() {
    const rows = [[B('🌐 সব কিছু (সাধারণ)', 'ai:_fleet')]];
    for (const b of this.store.data.bots) rows.push([B(`🤖 ${b.username}`, 'ai:' + b.id)]);
    for (const w of this.workers.all()) rows.push([B(`☁️ ${w.name}`, 'wai:' + w.id)]);
    rows.push([B('« হোম', 'h')]);
    return { text: `✨ <b>AI সহায়ক</b>\n${LINE}\n${this.ai.ready() ? `মডেল: <code>${esc(this.ai.model())}</code>\n` : '⚠️ AI বন্ধ। ⚙️ সেটিংস থেকে Mistral key দিন।\n'}কার সাথে কথা বলবেন? AI লগ, ফাইল, ENV-এর নাম ও আগের কথা মনে রেখে সাহায্য করে, ফাইল বদলে ডিপ্লয়ও করতে পারে।`, kb: KB(rows.slice(0, 14)) };
  }

  render(key, id, live) {
    return ({ h: () => this.vHome(live), b: () => this.vBot(id, live), w: () => this.vWorker(id, live), an: () => this.vAnalytics(live), sys: () => this.vSystem(live) })[key]();
  }

  // ================= প্রদর্শন ও লাইভ =================
  async show(ctx, v) {
    const opt = { parse_mode: 'HTML', disable_web_page_preview: true, ...(v.kb || {}) };
    const text = clip(v.text);
    if (ctx.callbackQuery) {
      try { return await ctx.editMessageText(text, opt); } catch (e) { if (/not modified/i.test(e.message)) return; }
    }
    return ctx.reply(text, opt);
  }

  async sendHome(ctx, withKeyboard) {
    if (withKeyboard) await ctx.reply('👋 <b>MC Host কন্ট্রোল সেন্টার</b>\nনিচের মেনু বোতাম সবসময় থাকবে। <i>/help</i> দেখুন।', { parse_mode: 'HTML', ...this.replyKeyboard() });
    return this.show(ctx, this.vHome());
  }

  liveKey(ctx) { const m = ctx.callbackQuery.message; return { k: `${m.chat.id}:${m.message_id}`, chat: m.chat.id, mid: m.message_id }; }
  liveStop(k) { const x = this.live.get(k); if (x) { clearInterval(x.timer); this.live.delete(k); } }
  liveStart(ctx, key, id) {
    const { k, chat, mid } = this.liveKey(ctx);
    this.liveStop(k);
    let n = 0;
    const tick = async () => {
      n++;
      const final = n >= 24;
      let v; try { v = this.render(key, id, !final); } catch { return this.liveStop(k); }
      try { await ctx.telegram.editMessageText(chat, mid, undefined, clip(v.text), { parse_mode: 'HTML', disable_web_page_preview: true, ...v.kb }); } catch (e) { if (!/not modified/i.test(e.message)) return this.liveStop(k); }
      if (final) this.liveStop(k);
    };
    this.live.set(k, { timer: setInterval(tick, 5000) });
    return this.show(ctx, this.render(key, id, true));
  }

  // ================= রাউটার =================
  async route(ctx, t, data) {
    const uid = ctx.from.id;
    const [k, id, extra, x4] = data.split(':');
    if (ctx.mcRole === 'viewer' && !VIEW_OK.has(k)) return this.show(ctx, { text: '👁 আপনার শুধু দেখার অনুমতি আছে।', kb: KB([[B('🏠 হোম', 'h')]]) });
    const bot = id ? this.store.bot(id) : null;
    const wk = id ? this.workers.get(id) : null;
    const isW = /^w/.test(k) && !['wl', 'wn', 'wnt', 'wnu'].includes(k);
    if (id && id !== '_fleet' && id !== '0') {
      if (isW && !wk) return this.show(ctx, this.vWorkers(0));
      if (!isW && /^(b|s|x|r|l|gc|a|sy|au|auj|aur|aup|aud|sc|sd|se|sr|sz|st|stp|cf|cn|ce|ar|cl|dl|dy|ai|aq|am|ap|ad)$/.test(k) && !bot) return this.show(ctx, this.vBots(0));
    }
    const S = (v) => this.show(ctx, v);
    const restartIf = async (bid) => { if (this.runner.state(bid) !== 'stopped') await this.runner.restart(bid); };
    const wRun = async (r) => { if (!r.ok) await ctx.reply('⚠️ ' + esc(String(r.error || '').split('\n')[0]), { parse_mode: 'HTML' }); };

    switch (k) {
      case 'noop': return;
      case 'h': this._reset(uid); return S(this.vHome());
      case 'lv': return this.liveStart(ctx, id, extra === undefined ? '0' : extra);
      case 'lx': this.liveStop(this.liveKey(ctx).k); return S(this.render(id, extra, false));
      case 'bl': return S(this.vBots(Number(id) || 0));
      case 'wl': return S(this.vWorkers(Number(id) || 0));
      case 'an': return S(this.vAnalytics());
      case 'in': return S(this.vInsights());
      case 'sys': return S(this.vSystem());
      case 'aih': this._reset(uid); return S(this.vAiHome());

      // ---------- বট ----------
      case 'b': return S(this.vBot(id));
      case 's': { const r = this.runner.start(id, { user: true }); if (!r.ok) await ctx.answerCbQuery(r.error).catch(() => {}); return S(this.vBot(id)); }
      case 'x': await this.runner.stop(id); return S(this.vBot(id));
      case 'r': await this.runner.restart(id); return S(this.vBot(id));
      case 'l': return S(this.vBotLogs(id));
      case 'gc': return S(this.vBotChat(id));
      case 'a': return S(this.vBotAn(id));
      case 'sy': this.wiz.set(uid, { step: 'say', id }); return S({ text: `🎮 <b>${esc(bot.username)}</b> গেমে যা বলবে লিখুন\n<i>(/ দিয়ে কমান্ডও চলে। /cancel বাতিল)</i>`, kb: KB([[B('❌ বাতিল', 'b:' + id)]]) });
      case 'ba': {
        const act = id; const bots = this.store.data.bots;
        if (act === 'start') bots.forEach((b) => this.runner.start(b.id, { user: true }));
        else if (act === 'stop') await Promise.all(bots.map((b) => this.runner.stop(b.id)));
        else if (act === 'restart') await Promise.all(bots.map((b) => this.runner.restart(b.id)));
        return S(this.vBots(0));
      }
      case 'au': return S(this.vAuto(id));
      case 'auj': this.wiz.set(uid, { step: 'auj1', id }); return S({ text: '🧩 <b>জয়েন কমান্ড</b>\nসার্ভারে ঢোকার পর যা পাঠাবে লিখুন, যেমন:\n<code>/login mypass123</code>\n<code>/register mypass123 mypass123</code>', kb: KB([[B('❌ বাতিল', 'au:' + id)]]) });
      case 'aur': this.wiz.set(uid, { step: 'aur1', id }); return S({ text: '🧩 <b>অটো-রিপ্লাই</b>\nচ্যাটে কী শুনলে উত্তর দেবে? লিখুন (regex চাইলে শুরুতে <code>re:</code> দিন):\nযেমন: <code>!help</code> বা <code>re:^!pos (\\d+)</code>', kb: KB([[B('❌ বাতিল', 'au:' + id)]]) });
      case 'aup': this.wiz.set(uid, { step: 'aup1', id }); return S({ text: '🧩 <b>সময় পরপর মেসেজ</b>\nযে মেসেজটি বারবার পাঠাবে লিখুন:', kb: KB([[B('❌ বাতিল', 'au:' + id)]]) });
      case 'aud': { const key = { j: 'joinCmds', r: 'rules', p: 'periodic' }[extra]; if (key && Array.isArray(bot[key])) { bot[key].splice(Number(x4), 1); this.store.save(); await restartIf(id); } return S(this.vAuto(id)); }

      case 'sc': return S(this.vScript(id));
      case 'sd': await ctx.replyWithDocument({ source: Buffer.from(this.store.readScript(id)), filename: `${bot.username}.js` }); return;
      case 'se': if (!id) return S(this.vSettings()); this.wiz.set(uid, { step: 'script', id }); return S({ text: '✏️ নতুন স্ক্রিপ্ট পেস্ট করুন বা <b>.js ফাইল</b> পাঠান (/cancel)', kb: KB([[B('❌ বাতিল', 'sc:' + id)]]) });
      case 'sr': if (this.store.rollback(id)) await restartIf(id); return S(this.vBot(id));
      case 'sz': this.store.writeScript(id, this.defaultScript); await restartIf(id); return S(this.vBot(id));
      case 'st': return S({ text: '🧪 <b>স্ক্রিপ্ট টেমপ্লেট</b>', kb: KB([...BOT_TEMPLATES.map((x) => [B(`${x.name}`, `stp:${id}:${x.key}`)]), [B('« স্ক্রিপ্ট', 'sc:' + id)]]) });
      case 'stp': { const tp = BOT_TEMPLATES.find((x) => x.key === extra); if (tp) { this.store.writeScript(id, tp.code || this.defaultScript); await restartIf(id); } return S(this.vBot(id)); }
      case 'cf': return S(this.vBotCfg(id));
      case 'cn': bot.notify = bot.notify === false; this.store.save(); return S(this.vBotCfg(id));
      case 'ce': this.wiz.set(uid, { step: 'cfg', id, field: extra }); return S({ text: ({ name: '✏️ নতুন নাম (৩-১৬ অক্ষর)', host: '🌐 নতুন সার্ভার (host অথবা host:port)', version: '🧩 ভার্সন (যেমন 1.20.4) অথবা <code>auto</code>' })[extra] + ' লিখুন', kb: KB([[B('❌ বাতিল', 'cf:' + id)]]) });
      case 'ar': bot.autoRestartHours = Number(extra) || 0; this.store.save(); return S(this.vBotCfg(id));
      case 'cl': {
        if (this.store.data.bots.length >= this.maxBots) return S({ text: `সর্বোচ্চ ${this.maxBots}টি বট।`, kb: KB([[B('« ফিরুন', 'cf:' + id)]]) });
        const c = { ...JSON.parse(JSON.stringify(bot)), id: genId(), username: (bot.username + '_2').slice(0, 16), desired: false, stats: undefined, createdAt: Date.now() };
        this.store.data.bots.push(c); this.store.writeScript(c.id, this.store.readScript(id)); this.store.save(); return S(this.vBot(c.id));
      }
      case 'dl': return S({ text: `🗑 <b>${esc(bot.username)}</b> মুছে ফেলবেন? স্ক্রিপ্টসহ সব যাবে।`, kb: KB([[B('✅ হ্যাঁ, মুছুন', 'dy:' + id), B('না', 'cf:' + id)]]) });
      case 'dy': await this.runner.stop(id); this.store.removeBot(id); return S(this.vBots(0));
      case 'nb':
        if (this.store.data.bots.length >= this.maxBots) return S({ text: `সর্বোচ্চ ${this.maxBots}টি বট রাখা যায়।`, kb: KB([[B('« ফিরুন', 'bl:0')]]) });
        this.wiz.set(uid, { step: 'name', data: {} });
        return S({ text: '➕ <b>নতুন বট</b>\nধাপ ১/৩: বটের গেম-নাম লিখুন (৩-১৬ অক্ষর, A-Z 0-9 _)', kb: KB([[B('❌ বাতিল', 'bl:0')]]) });
      case 'nbd': return this.finishNew(ctx, uid, this.defaultScript);
      case 'nbt': { const tp = BOT_TEMPLATES.find((x) => x.key === id); return this.finishNew(ctx, uid, (tp && tp.code) || this.defaultScript); }
      case 'nbs': { const w = this.wiz.get(uid); if (w) w.step = 'newscript'; return S({ text: '📝 স্ক্রিপ্ট পেস্ট করুন বা .js ফাইল পাঠান', kb: KB([[B('❌ বাতিল', 'bl:0')]]) }); }

      // ---------- বট AI ----------
      case 'ai': {
        if (!this.ai.ready()) return S({ text: '✨ AI চালু নেই। ⚙️ সেটিংস > AI key দিন।', kb: KB([[B('⚙️ সেটিংস', 'se'), B('« হোম', 'h')]]) });
        this.wiz.delete(uid); this.chatMode.set(uid, id);
        const who = id === '_fleet' ? 'সব কিছু' : esc(bot.username);
        return S({ text: `✨ <b>AI সহায়ক: ${who}</b>  <code>${esc(this.ai.model())}</code>\n${LINE}\nআমি বটের অবস্থা, লগ, স্ক্রিপ্ট ও আগের কথা মনে রাখি। সাধারণ ভাষায় লিখুন, যেমন: <i>"বটকে ১০ সেকেন্ডে একবার লাফ দিতে বলো"</i>`, kb: KB([
          ...(id === '_fleet' ? [] : [[B('🔍 লগ বিশ্লেষণ', `aq:${id}:0`)], [B('🛠 স্ক্রিপ্ট ঠিক করো', `aq:${id}:1`), B('🧑 মানুষের মতো করো', `aq:${id}:2`)]]),
          [B('🧹 মেমরি মুছুন', 'am:' + id), B('« বের হন', id === '_fleet' ? 'h' : 'b:' + id)]]) });
      }
      case 'aq': this.chatMode.set(uid, id); return this.askAi(ctx, id, QUICK[Number(extra)] || QUICK[0]);
      case 'am': this.ai.clearMemory(id === '_fleet' ? null : id); return ctx.reply('🧹 AI মেমরি মুছে ফেলা হয়েছে।');
      case 'ap': {
        const code = this.ai.takePending(id);
        if (!code) return ctx.reply('প্রয়োগ করার মতো কোড নেই (মেয়াদ শেষ)। আবার চেয়ে দেখুন।');
        this.store.writeScript(id, code); this.ai.addNote(id, 'AI প্রস্তাব করা স্ক্রিপ্ট প্রয়োগ হয়েছে'); await restartIf(id);
        return ctx.reply('✅ স্ক্রিপ্ট আপডেট হয়েছে' + (this.runner.state(id) !== 'stopped' ? ' এবং বট রিস্টার্ট হচ্ছে।' : '।'), KB([[B('🤖 বট দেখুন', 'b:' + id)]]));
      }
      case 'ad': this.ai.takePending(id); return ctx.reply('প্রস্তাব বাতিল।');

      // ---------- Workers ----------
      case 'w': return S(this.vWorker(id));
      case 'ws': await wRun(await this.workers.start(id)); return S(this.vWorker(id));
      case 'wx': await this.workers.stop(id); return S(this.vWorker(id));
      case 'wr': await wRun(await this.workers.restart(id)); return S(this.vWorker(id));
      case 'wd': { await ctx.reply('🚀 ডিপ্লয় চলছে...'); const r = await this.workers.deploy(id); await ctx.reply(r.ok ? '✅ ডিপ্লয় সফল, Worker চালু।' : `❌ ডিপ্লয় ব্যর্থ${r.rolledBack ? ' (আগের ভার্সন ফেরত আনা হয়েছে)' : ''}\n<code>${esc(String(r.error).split('\n').slice(0, 3).join('\n').slice(0, 500))}</code>`, { parse_mode: 'HTML' }); return S(this.vWorker(id)); }
      case 'wlg': return S(this.vWLogs(id));
      case 'wa': return S(this.vWAn(id));
      case 'wv': return S(this.vWVers(id));
      case 'wvr': { const r = await this.workers.restore(id, extra); await ctx.reply(r.ok ? '✅ ভার্সন ফেরত এসেছে ও চালু।' : '❌ ' + esc(String(r.error).split('\n')[0]), { parse_mode: 'HTML' }); return S(this.vWVers(id)); }
      case 'wvs': this.workers.snapshot(id, 'manual'); return S(this.vWVers(id));
      case 'wc': return S(this.vWCfg(id));
      case 'wcn': this.wiz.set(uid, { step: 'wcn', id }); return S({ text: '✏️ Worker-এর নতুন নাম লিখুন', kb: KB([[B('❌ বাতিল', 'wc:' + id)]]) });
      case 'wcs': this.wiz.set(uid, { step: 'wcs', id }); return S({ text: '🔗 নতুন URL নাম লিখুন (ছোট হাতের a-z, 0-9, হাইফেন)\nপাবলিক ঠিকানা বদলে যাবে।', kb: KB([[B('❌ বাতিল', 'wc:' + id)]]) });
      case 'wcc': this.workers.update(wk, { cronMin: Number(extra) }); if (wk.enabled && this.workers._rt(id).state === 'running') this.workers._rt(id).lastCron = 0; return S(this.vWCfg(id));
      case 'wcr': this.workers.update(wk, { rateLimit: Number(extra) }); return S(this.vWCfg(id));
      case 'wcl': { try { const c = this.workers.clone(id); return S(this.vWorker(c.id)); } catch (e) { return ctx.reply('⚠️ ' + esc(e.message), { parse_mode: 'HTML' }); } }
      case 'wdl': return S({ text: `🗑 Worker <b>${esc(wk.name)}</b>, তার সব ফাইল ও KV ডাটা মুছে যাবে। নিশ্চিত?`, kb: KB([[B('✅ হ্যাঁ, মুছুন', 'wdy:' + id), B('না', 'wc:' + id)]]) });
      case 'wdy': await this.workers.remove(id); return S(this.vWorkers(0));
      case 'wzip': await ctx.replyWithDocument({ source: this.workers.exportZip(id), filename: `${wk.slug}.zip` }); return;
      case 'wt': this.wiz.set(uid, { step: 'wtest', id }); return S({ text: `🧪 <b>${esc(wk.name)} — টেস্ট</b>\nরিকোয়েস্ট লিখুন:\n<code>GET /</code>\n<code>GET /api/items?x=1</code>\n<code>POST /echo {"a":1}</code>\n<i>শুধু পাথ (/health) লিখলে GET হবে।</i>`, kb: KB([[B('GET /', 'wtq:' + id + ':0'), B('GET /health', 'wtq:' + id + ':1')], [B('« Worker', 'w:' + id)]]) });
      case 'wtq': return this.workerTest(ctx, id, extra === '0' ? 'GET /' : 'GET /health');

      // ফাইল
      case 'wf': return S(this.vWFiles(id, Number(extra) || 0));
      case 'wfo': return S(this.vWFile(id, Number(extra)));
      case 'wfd': { const f = this.workers.listFiles(id)[Number(extra)]; if (f) await ctx.replyWithDocument({ source: this.workers.absOf(id, f.path), filename: f.path.split('/').pop() }); return; }
      case 'wfe': { const f = this.workers.listFiles(id)[Number(extra)]; if (!f) return; this.wiz.set(uid, { step: 'wfe', id, path: f.path }); return S({ text: `✏️ <code>${esc(f.path)}</code>-এর নতুন কন্টেন্ট পেস্ট করুন বা ফাইল পাঠান`, kb: KB([[B('❌ বাতিল', `wfo:${id}:${extra}`)]]) }); }
      case 'wfs': { const f = this.workers.listFiles(id)[Number(extra)]; if (f) { this.workers.update(wk, { entry: f.path }); } return S(this.vWFile(id, Number(extra))); }
      case 'wfx': { const f = this.workers.listFiles(id)[Number(extra)]; if (!f) return S(this.vWFiles(id, 0)); return S({ text: `🗑 <code>${esc(f.path)}</code> মুছবেন?`, kb: KB([[B('✅ হ্যাঁ', `wfy:${id}:${extra}`), B('না', `wfo:${id}:${extra}`)]]) }); }
      case 'wfy': { const f = this.workers.listFiles(id)[Number(extra)]; if (f) this.workers.deleteFile(id, f.path); return S(this.vWFiles(id, 0)); }
      case 'wup': this.wiz.set(uid, { step: 'wup', id }); return S({ text: `⬆️ <b>${esc(wk.name)}-এ আপলোড</b>\nএখন যেকোনো <b>ফাইল বা .zip</b> পাঠান (একাধিকবার পাঠানো যায়)।\n• ক্যাপশনে পাথ লিখলে সেই পাথে রাখব (যেমন <code>lib/utils.js</code>)\n• .zip পাঠালে ভেতরের সব ফাইল সাজিয়ে রাখব\n• .env পাঠালে ফাইল হিসেবেই থাকবে (Worker নিজে লোড করে)`, kb: KB([[B('✅ শেষ', `wf:${id}:0`), B('🚀 ডিপ্লয়', 'wd:' + id)]]) });
      case 'wnf': this.wiz.set(uid, { step: 'wnf1', id }); return S({ text: '➕ নতুন ফাইলের পাথ লিখুন, যেমন <code>lib/helpers.js</code> বা <code>public/index.html</code>', kb: KB([[B('❌ বাতিল', `wf:${id}:0`)]]) });

      // ENV
      case 'we': return S(this.vWEnv(id));
      case 'wei': return S(this.vWEnvItem(id, Number(extra)));
      case 'wea': this.wiz.set(uid, { step: 'wenv', id }); return S({ text: '🔑 <b>ENV যোগ/আপডেট</b>\nপ্রতি লাইনে <code>KEY=value</code> লিখুন (একসাথে একাধিক)।\nনামে key/token/secret/pass থাকলে গোপন হবে।\n<i>নিরাপত্তার জন্য আপনার মেসেজটি আমি মুছে দেব।</i>', kb: KB([[B('❌ বাতিল', 'we:' + id)]]) });
      case 'wei2': this.wiz.set(uid, { step: 'wenvimp', id }); return S({ text: '📥 <b>.env ফাইল</b> পাঠান (অথবা কন্টেন্ট পেস্ট করুন)। সব ভেরিয়েবল ইমপোর্ট হবে।', kb: KB([[B('❌ বাতিল', 'we:' + id)]]) });
      case 'wee': { const e = (wk.env || [])[Number(extra)]; if (!e) return; this.wiz.set(uid, { step: 'wenvedit', id, idx: Number(extra) }); return S({ text: `✏️ <code>${esc(e.key)}</code>-এর নতুন মান লিখুন\n<i>মেসেজটি মুছে দেব।</i>`, kb: KB([[B('❌ বাতিল', `wei:${id}:${extra}`)]]) }); }
      case 'wes': { const e = (wk.env || [])[Number(extra)]; if (e) { e.secret = !e.secret; this.store.save(); } return S(this.vWEnvItem(id, Number(extra))); }
      case 'wed': { (wk.env || []).splice(Number(extra), 1); this.store.save(); if (wk.enabled) await this.workers.start(id); return S(this.vWEnv(id)); }

      // Worker AI
      case 'wai': {
        if (!this.ai.ready()) return S({ text: '✨ AI চালু নেই। ⚙️ সেটিংস > AI key দিন।', kb: KB([[B('⚙️ সেটিংস', 'se'), B('« Worker', 'w:' + id)]]) });
        this.wiz.delete(uid); this.chatMode.set(uid, 'w:' + id);
        return S({ text: `✨ <b>AI: ${esc(wk.name)}</b>  <code>${esc(this.ai.model())}</code>\n${LINE}\nAI সব ফাইল, লগ, ত্রুটি ও ENV-এর <i>নাম</i> দেখে (মান নয়) কাজ করে। বলুন কী চান, যেমন: <i>"/users এন্ডপয়েন্ট যোগ করো, ডাটা KV-তে রাখো"</i>\nপ্রস্তাব এলে "প্রয়োগ" চাপলে ফাইল বদলে ডিপ্লয় হবে (ব্যর্থ হলে আগের ভার্সন ফেরত)।`, kb: KB([[B('🔍 ত্রুটি বিশ্লেষণ', `waq:${id}:0`)], [B('🛡 কোড উন্নত করো', `waq:${id}:1`), B('➕ /health যোগ', `waq:${id}:2`)], [B('🧹 মেমরি মুছুন', 'am:w:' + id), B('« বের হন', 'w:' + id)]]) });
      }
      case 'waq': this.chatMode.set(uid, 'w:' + id); return this.askAi(ctx, 'w:' + id, WQUICK[Number(extra)] || WQUICK[0]);
      case 'wap': {
        const changes = this.ai.takePendingW(id);
        if (!changes.length) return ctx.reply('প্রয়োগ করার মতো পরিবর্তন নেই (মেয়াদ শেষ)। আবার চেয়ে দেখুন।');
        this.workers.applyChanges(id, changes); this.ai.addNote('w:' + id, `AI পরিবর্তন প্রয়োগ: ${changes.map((c) => c.path).join(', ')}`.slice(0, 280));
        await ctx.reply('🚀 ফাইল আপডেট হয়েছে, ডিপ্লয় চলছে...');
        const r = await this.workers.deploy(id);
        return ctx.reply(r.ok ? `✅ ডিপ্লয় সফল (${changes.length}টি ফাইল)` : `❌ ডিপ্লয় ব্যর্থ${r.rolledBack ? ', আগের ভার্সন ফেরত আনা হয়েছে' : ''}\n<code>${esc(String(r.error).split('\n').slice(0, 3).join('\n').slice(0, 500))}</code>`, { parse_mode: 'HTML', ...KB([[B('☁️ Worker', 'w:' + id), B('📜 লগ', 'wlg:' + id)]]) });
      }
      case 'wad': this.ai.takePendingW(id); return ctx.reply('প্রস্তাব বাতিল।');
      case 'wpv': { for (const c of this.ai.pendingW.get(id) || []) await ctx.replyWithDocument({ source: Buffer.from(c.content), filename: c.path.split('/').pop() }, { caption: c.path }); return; }
      case 'wn': {
        if (this.workers.all().length >= this.workers.max) return S({ text: `সর্বোচ্চ ${this.workers.max}টি Worker।`, kb: KB([[B('« ফিরুন', 'wl:0')]]) });
        this.wiz.set(uid, { step: 'wnew' });
        return S({ text: '➕ <b>নতুন Worker</b>\nWorker-এর নাম লিখুন (যেমন <code>my-api</code>)। এই নাম থেকে URL হবে।', kb: KB([[B('❌ বাতিল', 'wl:0')]]) });
      }
      case 'wnt': return this.finishWorker(ctx, uid, id);
      case 'wnu': { const w = this.wiz.get(uid); if (w) w.step = 'wnewup'; return S({ text: '⬆️ এখন <b>worker.js</b> বা প্রজেক্টের <b>.zip</b> ফাইল পাঠান।', kb: KB([[B('❌ বাতিল', 'wl:0')]]) }); }

      // ---------- সেটিংস ----------
      case 'se': return S(this.vSettings());
      case 'sn': this.store.setSetting(id === 'bots' ? 'notifyBots' : 'notifyWorkers', this.store.setting(id === 'bots' ? 'notifyBots' : 'notifyWorkers', true) === false); return S(this.vSettings());
      case 'sm': this.store.setSetting('muteUntil', Number(id) ? Date.now() + Number(id) * 3600000 : 0); return S(this.vSettings());
      case 'sg': this.store.setSetting('digestHour', Number(id)); return S(this.vSettings());
      case 'stz': this.store.setSetting('tzOffset', Number(id)); return S(this.vSettings());
      case 'smd': {
        try { this._models = (await this.ai.models()).slice(0, 12); } catch (e) { return ctx.reply('⚠️ ' + esc(e.message), { parse_mode: 'HTML' }); }
        const rows = []; for (let i = 0; i < this._models.length; i += 2) rows.push(this._models.slice(i, i + 2).map((m, j) => B((m === this.ai.model() ? '✅ ' : '') + m, `smd2:${i + j}`)));
        rows.push([B('« সেটিংস', 'se')]); return S({ text: '🤖 <b>AI মডেল বাছুন</b>', kb: KB(rows) });
      }
      case 'smd2': if (this._models && this._models[Number(id)]) this.store.setSetting('mistralModel', this._models[Number(id)]); return S(this.vSettings());
      case 'sk': this.wiz.set(uid, { step: 'apikey' }); return S({ text: '🔑 Mistral API key পাঠান।\n<i>নিরাপত্তার জন্য মেসেজটি মুছে দেব।</i>', kb: KB([[B('❌ বাতিল', 'se')]]) });
      case 'bk': await ctx.replyWithDocument({ source: Buffer.from(JSON.stringify(this.buildBackup())), filename: 'mc-host-backup.json' }, { caption: '💾 পূর্ণ ব্যাকআপ (বট, স্ক্রিপ্ট, Worker ফাইল ও ENV)। নিরাপদে রাখুন।' }); return;

      // ---------- ফাইল পাঠানো হলে কোথায় রাখব ----------
      case 'pd': return this.applyPendingDoc(ctx, uid, id, extra);
      case 'ac': this.wiz.delete(uid); return S(this.vAccess());
      case 'tkn': this.wiz.set(uid, { step: 'tkname' }); return S({ text: '🔐 <b>নতুন API টোকেন</b>\nটোকেনের নাম লিখুন (কোথায় ব্যবহার হবে, যেমন ci-deploy)', kb: KB([[B('❌ বাতিল', 'ac')]]) });
      case 'tks': { const w = this.wiz.get(uid); if (!w || w.step !== 'tkscope') return S(this.vAccess()); this.wiz.delete(uid); try { const tok = this.tgTokenCreate(w.name, id === 'control' ? 'control' : 'read'); return ctx.reply(`✅ টোকেন তৈরি হয়েছে। <b>এটি এখনই একবার দেখানো হচ্ছে</b>, কপি করে রাখুন:\n<code>${esc(tok)}</code>\n\n<i>বার্তাটি ব্যক্তিগত চ্যাটে থাকে, চাইলে মুছে দিন।</i>`, { parse_mode: 'HTML', ...KB([[B('🔐 অ্যাক্সেস', 'ac')]]) }); } catch (e) { return ctx.reply('⚠️ ' + esc(e.message), { parse_mode: 'HTML' }); } }
      case 'tkx': { const x = (this.store.data.tokens || []).find((y) => y.id === id); if (!x) return S(this.vAccess()); return S({ text: `🗑 টোকেন <b>${esc(x.name)}</b> বাতিল হবে? সাথে সাথে কাজ বন্ধ হবে।`, kb: KB([[B('✅ হ্যাঁ, বাতিল', 'tkr:' + id), B('না', 'ac')]]) }); }
      case 'tkr': this.store.data.tokens = (this.store.data.tokens || []).filter((y) => y.id !== id); this.store.save(); return S(this.vAccess());
      case 'usn': this.wiz.set(uid, { step: 'usname' }); return S({ text: '👤 <b>নতুন ব্যবহারকারী</b>\nনাম লিখুন', kb: KB([[B('❌ বাতিল', 'ac')]]) });
      case 'usr': { const w = this.wiz.get(uid); if (!w || w.step !== 'usrole') return S(this.vAccess()); this.wiz.delete(uid); try { this.tgUserCreate(w.name, w.pw, id === 'viewer' ? 'viewer' : 'operator'); return S(this.vAccess()); } catch (e) { return ctx.reply('⚠️ ' + esc(e.message), { parse_mode: 'HTML' }); } }
      case 'usx': { const x = (this.store.data.users || []).find((y) => y.id === id); if (!x) return S(this.vAccess()); return S({ text: `🗑 <b>${esc(x.name)}</b> সরানো হবে? তার সেশনও বাতিল হবে।`, kb: KB([[B('✅ হ্যাঁ, সরান', 'usr_:' + id), B('না', 'ac')]]) }); }
      case 'usr_': this.store.data.users = (this.store.data.users || []).filter((y) => y.id !== id); this.store.save(); return S(this.vAccess());
      default: return S(this.vHome());
    }
  }


  // ---------- অ্যাক্সেস ব্যবস্থাপনা (শুধু মালিক) ----------
  vAccess() {
    const tk = this.store.data.tokens || []; const us = this.store.data.users || [];
    const RL = { operator: 'অপারেটর', viewer: 'শুধু দেখা' };
    const when = (x) => (x ? new Date(x).toLocaleDateString('bn-BD') : 'কখনো না');
    const text = `🔐 <b>অ্যাক্সেস</b>\n${LINE}\n<b>API টোকেন</b> (${tk.length}/20)\n${tk.map((x) => `• ${esc(x.name)} — ${x.scope === 'control' ? 'নিয়ন্ত্রণ' : 'শুধু পড়া'} · শেষ ${when(x.lastUsed)}`).join('\n') || '<i>নেই</i>'}\n\n<b>ব্যবহারকারী</b> (${us.length}/20)\n${us.map((x) => `• ${esc(x.name)} — ${RL[x.role] || x.role} · লগইন ${when(x.lastLogin)}`).join('\n') || '<i>শুধু মালিক</i>'}`;
    const rows = [[B('➕ টোকেন তৈরি', 'tkn')], ...tk.slice(0, 8).map((x) => [B(`🗑 টোকেন: ${x.name.slice(0, 20)}`, 'tkx:' + x.id)]), [B('👤 ব্যবহারকারী যোগ', 'usn')], ...us.slice(0, 8).map((x) => [B(`🗑 ${x.name.slice(0, 20)}`, 'usx:' + x.id)]), [B('« সেটিংস', 'se')]];
    return { text, kb: KB(rows) };
  }

  tgTokenCreate(name, scope) {
    if ((this.store.data.tokens || []).length >= 20) throw new Error('সর্বোচ্চ ২০টি টোকেন');
    const token = Sec.newToken();
    (this.store.data.tokens ||= []).push({ id: genId(), name: name.slice(0, 40), scope, hash: Sec.sha256(token), createdAt: Date.now(), lastUsed: 0 });
    this.store.save();
    return token;
  }

  tgUserCreate(name, pw, role) {
    if (pw.length < 6) throw new Error('পাসওয়ার্ড কমপক্ষে ৬ অক্ষর');
    if (Sec.safeEq(pw, this.store.setting('customPassword') || this.getOwnerPw())) throw new Error('এটি মালিকের পাসওয়ার্ড, আলাদা দিন');
    if ((this.store.data.users || []).some((u) => Sec.verifyPw(pw, u.hash))) throw new Error('এই পাসওয়ার্ড অন্য কেউ ব্যবহার করছে');
    if ((this.store.data.users || []).length >= 20) throw new Error('সর্বোচ্চ ২০ জন ব্যবহারকারী');
    (this.store.data.users ||= []).push({ id: genId(), name: name.slice(0, 30), role, hash: Sec.hashPw(pw), createdAt: Date.now() });
    this.store.save();
  }

  buildBackup() {
    const data = JSON.parse(JSON.stringify(this.store.data));
    delete data.settings.autoPassword; delete data.settings.customPassword; delete data.settings.customPasswordEnv; delete data.history; delete data.audit;
    const scripts = {}; for (const b of this.store.data.bots) scripts[b.id] = this.store.readScript(b.id);
    return { v: 4, ts: Date.now(), data, scripts, workerFiles: this.workers.exportAll() };
  }

  async quickCmd(ctx, cmd) {
    if (ctx.mcRole === 'viewer' && cmd !== 'logs') return ctx.reply('👁 শুধু দেখার অনুমতি আছে।');
    const args = ctx.message.text.split(/\s+/).slice(1); const q = args[0];
    if (!q) return ctx.reply(`ব্যবহার: /${cmd} <নাম>${cmd === 'say' ? ' <মেসেজ>' : ''}`);
    const b = this.findBot(q); const w = b ? null : this.findWorker(q);
    if (!b && !w) return ctx.reply(`"${q}" নামে কোনো বট বা Worker পাওয়া যায়নি।`);
    if (cmd === 'logs') return this.show(ctx, b ? this.vBotLogs(b.id) : this.vWLogs(w.id));
    if (cmd === 'say') { if (!b) return ctx.reply('/say শুধু বটের জন্য।'); return ctx.reply(this.runner.say(b.id, args.slice(1).join(' ')) ? '✅ পাঠানো হয়েছে' : '⚠️ বট অনলাইন নেই'); }
    if (b) {
      if (cmd === 'run') this.runner.start(b.id, { user: true }); else if (cmd === 'stop') await this.runner.stop(b.id); else if (cmd === 'restart') await this.runner.restart(b.id);
      return this.show(ctx, this.vBot(b.id));
    }
    if (cmd === 'run') await this.workers.start(w.id); else if (cmd === 'stop') await this.workers.stop(w.id); else if (cmd === 'restart') await this.workers.restart(w.id);
    return this.show(ctx, this.vWorker(w.id));
  }

  async workerTest(ctx, id, text) {
    const m = text.trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+([\s\S]+))?$/i);
    const method = m ? m[1].toUpperCase() : 'GET'; const p = m ? m[2] : text.trim(); const body = m && m[3] ? m[3] : null;
    const headers = body && /^[\[{]/.test(body.trim()) ? { 'content-type': 'application/json' } : {};
    const o = await this.workers.invoke(id, { method, path: p, headers, body });
    const hs = o.headers.filter(([k]) => ['content-type', 'cache-control', 'set-cookie', 'location', 'access-control-allow-origin'].includes(k)).map(([k, v]) => `${k}: ${v}`).join('\n');
    let bd = o.body.subarray(0, 2000).toString('utf8'); try { bd = JSON.stringify(JSON.parse(bd), null, 2); } catch { /* text */ }
    const ok = o.status < 400 ? '🟢' : o.status < 500 ? '🟠' : '🔴';
    return ctx.reply(clip(`${ok} <b>${o.status}</b>  ·  ⏱ ${o.ms}ms  ·  📦 ${kb(o.body.length)}\n<code>${esc(method)} ${esc(p)}</code>\n${hs ? `<pre>${esc(hs)}</pre>` : ''}<pre>${esc(bd.slice(0, 1800) || '(ফাঁকা)')}</pre>`), { parse_mode: 'HTML', ...KB([[B('🔁 আরেকটি টেস্ট', 'wt:' + id), B('📜 লগ', 'wlg:' + id)], [B('« Worker', 'w:' + id)]]) });
  }

  // ================= AI চ্যাট =================
  async askAi(ctx, target, text) {
    await ctx.sendChatAction('typing').catch(() => {});
    const send = async (reply) => { const body = esc(reply); for (let i = 0; i < body.length; i += 3800) await ctx.reply(body.slice(i, i + 3800), { parse_mode: 'HTML' }).catch(() => ctx.reply(reply.slice(i, i + 3800))); };
    if (String(target).startsWith('w:')) {
      const id = target.slice(2); const w = this.workers.get(id); if (!w) return;
      let r; try { r = await this.ai.chatWorker(this.workers, w, text); } catch (e) { return ctx.reply('AI ত্রুটি: ' + e.message); }
      await send(r.reply);
      if (r.changes.length) {
        const lines = r.changes.map((c) => (c.error ? `⚠️ <code>${esc(c.path)}</code> — ${esc(String(c.error).split('\n')[0].slice(0, 120))}` : `${c.isNew ? '🆕' : '✏️'} <code>${esc(c.path)}</code> <i>${kb(c.size)}</i>`));
        const good = r.changes.filter((c) => !c.error).length;
        await ctx.reply(`📝 <b>প্রস্তাবিত পরিবর্তন</b>\n${LINE}\n${lines.join('\n')}${good < r.changes.length ? '\n\n<i>⚠️ ত্রুটিযুক্ত ফাইল প্রয়োগ হবে না।</i>' : ''}`, { parse_mode: 'HTML', ...KB(good ? [[B('✅ প্রয়োগ ও ডিপ্লয়', 'wap:' + id)], [B('👁 কোড দেখুন', 'wpv:' + id), B('✖ বাতিল', 'wad:' + id)]] : []) });
      }
      return;
    }
    const botId = target === '_fleet' ? null : target;
    let r; try { r = await this.ai.chat(botId, text); } catch (e) { return ctx.reply('AI ত্রুটি: ' + e.message); }
    const inlineOk = r.code && r.code.length <= 1800;
    let body = r.reply.replace(/```[\s\S]*?```/g, r.code ? (inlineOk ? '[[CODE]]' : '(পুরো কোড নিচের ফাইলে)') : '(কোড)');
    body = esc(body).replace('[[CODE]]', `<pre>${esc(r.code)}</pre>`);
    for (let i = 0; i < body.length; i += 3800) await ctx.reply(body.slice(i, i + 3800), { parse_mode: 'HTML' }).catch(() => ctx.reply(r.reply.slice(i, i + 3800)));
    if (r.error) await ctx.reply('⚠️ AI-এর দেওয়া কোডে সিনট্যাক্স ত্রুটি আছে: ' + r.error + '\nআবার ঠিক করতে বলুন।');
    if (r.code && botId) {
      if (!inlineOk) await ctx.replyWithDocument({ source: Buffer.from(r.code), filename: 'proposed.js' });
      await ctx.reply('এই স্ক্রিপ্ট প্রয়োগ করবেন?', KB([[B('✅ প্রয়োগ করুন', 'ap:' + botId), B('✖ বাতিল', 'ad:' + botId)]]));
    }
  }

  // ================= টেক্সট / উইজার্ড =================
  menuGo(ctx, key) {
    if (key === 'home') return this.show(ctx, this.vHome());
    if (key === 'bots') return this.show(ctx, this.vBots(0));
    if (key === 'workers') return this.show(ctx, this.vWorkers(0));
    if (key === 'an') return this.show(ctx, this.vAnalytics());
    if (key === 'ai') return this.show(ctx, this.vAiHome());
    return this.show(ctx, this.vSettings());
  }

  parseEnv(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) out.push({ key: m[1], value: m[2].replace(/^(["'])(.*)\1$/, '$2'), secret: /key|token|secret|pass|pwd|private/i.test(m[1]) });
    }
    return out;
  }

  async mergeEnv(w, list) {
    const env = w.env || [];
    for (const e of list) { const i = env.findIndex((x) => x.key === e.key); if (i >= 0) env[i] = { ...env[i], value: e.value, secret: env[i].secret || e.secret }; else env.push(e); }
    w.env = this.workers.cleanEnv(env, env); w.updatedAt = Date.now(); this.store.save();
    if (w.enabled) await this.workers.start(w.id);
  }

  async onText(ctx, t, text) {
    const uid = ctx.from.id;
    const mk = Object.entries(MENU).find(([, v]) => v === text);
    if (mk) { this._reset(uid); return this.menuGo(ctx, mk[0]); }
    const w = this.wiz.get(uid);
    if (!w) {
      const mode = this.chatMode.get(uid);
      if (mode) return this.askAi(ctx, mode, text);
      return this.show(ctx, this.vHome());
    }
    const done = (v) => { this.wiz.delete(uid); return this.show(ctx, v); };
    const wipe = () => ctx.deleteMessage().catch(() => {});
    switch (w.step) {
      case 'name':
        if (!validName(text)) return ctx.reply('নাম ৩-১৬ অক্ষর হতে হবে (A-Z, 0-9, _)। আবার লিখুন:');
        w.data.username = text; w.step = 'host';
        return ctx.reply('ধাপ ২/৩: সার্ভার ঠিকানা লিখুন (host অথবা host:port)');
      case 'host': {
        const h = parseHost(text);
        if (!h) return ctx.reply('ঠিকানা সঠিক নয়। যেমন: play.example.com অথবা play.example.com:25565');
        w.data.host = h.host;
        if (h.port) { w.data.port = h.port; w.step = 'scriptchoice'; return this.askScript(ctx); }
        w.step = 'port'; return ctx.reply('পোর্ট লিখুন (ডিফল্ট হলে <code>25565</code>)', { parse_mode: 'HTML' });
      }
      case 'port': { const p = Number(text); if (!(p > 0 && p < 65536)) return ctx.reply('পোর্ট ১-৬৫৫৩৫ এর মধ্যে হতে হবে।'); w.data.port = p; w.step = 'scriptchoice'; return this.askScript(ctx); }
      case 'newscript': return this.finishNew(ctx, uid, text);
      case 'script': return this.saveScript(ctx, uid, w.id, text);
      case 'say': { this.wiz.delete(uid); return ctx.reply(this.runner.say(w.id, text) ? '✅ পাঠানো হয়েছে।' : '⚠️ বট এখন অনলাইন নেই।', KB([[B('« বট', 'b:' + w.id)]])); }
      case 'cfg': {
        const b = this.store.bot(w.id); if (!b) return this.show(ctx, this.vBots(0));
        if (w.field === 'name') { if (!validName(text)) return ctx.reply('নাম সঠিক নয়।'); b.username = text; }
        else if (w.field === 'host') { const h = parseHost(text); if (!h) return ctx.reply('ঠিকানা সঠিক নয়।'); b.host = h.host; if (h.port) b.port = h.port; }
        else if (w.field === 'version') b.version = /^auto$/i.test(text) ? '' : text.trim();
        this.store.save(); this.wiz.delete(uid);
        if (this.runner.state(b.id) !== 'stopped') await this.runner.restart(b.id);
        return this.show(ctx, this.vBot(b.id));
      }
      // অটোমেশন
      case 'auj1': w.cmd = text.slice(0, 200); w.step = 'auj2'; await wipe(); return ctx.reply('কত সেকেন্ড পরে পাঠাবে? (0-300, ডিফল্ট 3)');
      case 'auj2': { const b = this.store.bot(w.id); (b.joinCmds ||= []).push({ cmd: w.cmd, delay: Math.max(0, Math.min(300, Number(text) || 3)) }); this.store.save(); if (this.runner.state(b.id) !== 'stopped') await this.runner.restart(b.id); return done(this.vAuto(w.id)); }
      case 'aur1': w.match = text.replace(/^re:/i, '').slice(0, 100); w.regex = /^re:/i.test(text); if (w.regex) { try { new RegExp(w.match, 'i'); } catch { return ctx.reply('Regex সঠিক নয়। আবার লিখুন:'); } } w.step = 'aur2'; return ctx.reply('উত্তরে কী বলবে? ({bot} = বটের নাম, regex হলে $1 ক্যাপচার)');
      case 'aur2': { const b = this.store.bot(w.id); (b.rules ||= []).push({ match: w.match, reply: text.slice(0, 200), regex: w.regex, cooldown: 10 }); this.store.save(); if (this.runner.state(b.id) !== 'stopped') await this.runner.restart(b.id); return done(this.vAuto(w.id)); }
      case 'aup1': w.text = text.slice(0, 200); w.step = 'aup2'; return ctx.reply('কত সেকেন্ড পরপর? (সর্বনিম্ন 30)');
      case 'aup2': { const b = this.store.bot(w.id); (b.periodic ||= []).push({ text: w.text, every: Math.max(30, Math.min(86400, Number(text) || 300)) }); this.store.save(); if (this.runner.state(b.id) !== 'stopped') await this.runner.restart(b.id); return done(this.vAuto(w.id)); }
      // Worker
      case 'wnew': {
        const name = text.trim().slice(0, 60); if (!name) return ctx.reply('নাম লিখুন।');
        w.name = name; w.step = 'wnewchoice';
        return ctx.reply(`<b>${esc(name)}</b> — কী দিয়ে শুরু করবেন?`, { parse_mode: 'HTML', ...KB([...WK_TEMPLATES.map((x) => [B(x.name, 'wnt:' + x.key)]), [B('⬆️ নিজের worker.js / ZIP আপলোড', 'wnu:0')], [B('❌ বাতিল', 'wl:0')]]) });
      }
      case 'wtest': return this.workerTest(ctx, w.id, text);
      case 'wcn': { const wk = this.workers.get(w.id); try { this.workers.update(wk, { name: text }); } catch (e) { return ctx.reply('⚠️ ' + e.message); } return done(this.vWCfg(w.id)); }
      case 'wcs': { const wk = this.workers.get(w.id); try { this.workers.update(wk, { slug: text.trim().toLowerCase() }); } catch (e) { return ctx.reply('⚠️ ' + e.message); } return done(this.vWCfg(w.id)); }
      case 'wnf1': try { w.path = this.workers.safeRel(text.trim()); } catch (e) { return ctx.reply('⚠️ ' + e.message); } w.step = 'wnf2'; return ctx.reply(`<code>${esc(w.path)}</code>-এর কন্টেন্ট পেস্ট করুন (ফাঁকা ফাইলের জন্য <code>-</code>) অথবা ফাইল পাঠান`, { parse_mode: 'HTML' });
      case 'wnf2': case 'wfe': return this.saveWorkerFile(ctx, uid, w, w.step === 'wnf2' && text === '-' ? '' : text);
      case 'wenv': {
        const list = this.parseEnv(text); await wipe();
        if (!list.length) return ctx.reply('কোনো সঠিক <code>KEY=value</code> পাইনি। আবার লিখুন:', { parse_mode: 'HTML' });
        await this.mergeEnv(this.workers.get(w.id), list);
        await ctx.reply(`✅ ${list.length}টি ভেরিয়েবল সেভ হয়েছে${this.workers.get(w.id).enabled ? ', Worker রিস্টার্ট' : ''}।`);
        return done(this.vWEnv(w.id));
      }
      case 'wenvimp': {
        const list = this.parseEnv(text); await wipe();
        if (!list.length) return ctx.reply('কোনো ভেরিয়েবল পাইনি।');
        await this.mergeEnv(this.workers.get(w.id), list); await ctx.reply(`✅ ${list.length}টি ইমপোর্ট হয়েছে।`);
        return done(this.vWEnv(w.id));
      }
      case 'wenvedit': {
        await wipe(); const wk = this.workers.get(w.id); const e = (wk.env || [])[w.idx]; if (!e) return done(this.vWEnv(w.id));
        e.value = text.slice(0, 4096); this.store.save(); if (wk.enabled) await this.workers.start(wk.id);
        return done(this.vWEnvItem(w.id, w.idx));
      }
      case 'tkname': { const name = text.trim().slice(0, 40); if (!name) return ctx.reply('নাম লিখুন।'); this.wiz.set(uid, { step: 'tkscope', name }); return ctx.reply(`<b>${esc(name)}</b> — অনুমতি বাছুন:`, { parse_mode: 'HTML', ...KB([[B('📖 শুধু পড়া', 'tks:read'), B('🛠 নিয়ন্ত্রণ', 'tks:control')], [B('❌ বাতিল', 'ac')]]) }); }
      case 'usname': { const name = text.trim().slice(0, 30); if (!name) return ctx.reply('নাম লিখুন।'); this.wiz.set(uid, { step: 'uspw', name }); return ctx.reply('পাসওয়ার্ড লিখুন (কমপক্ষে ৬ অক্ষর)। <i>মেসেজটি মুছে দেব।</i>', { parse_mode: 'HTML' }); }
      case 'uspw': { await wipe(); if (text.length < 6) return ctx.reply('পাসওয়ার্ড কমপক্ষে ৬ অক্ষর। আবার লিখুন।'); this.wiz.set(uid, { step: 'usrole', name: w.name, pw: text }); return ctx.reply(`<b>${esc(w.name)}</b> — ভূমিকা বাছুন:`, { parse_mode: 'HTML', ...KB([[B('🛠 অপারেটর', 'usr:operator'), B('👁 শুধু দেখা', 'usr:viewer')], [B('❌ বাতিল', 'ac')]]) }); }
      case 'apikey': await wipe(); this.store.setSetting('mistralKey', text.trim()); await ctx.reply('✅ AI key সেভ হয়েছে।'); return done(this.vSettings());
      case 'wup': return ctx.reply('ফাইল বা .zip পাঠান (টেক্সট নয়)। শেষ হলে নিচের ✅ বোতাম চাপুন।');
      case 'wnewup': return ctx.reply('worker.js বা .zip ফাইল পাঠান।');
      default: this.wiz.delete(uid); return this.show(ctx, this.vHome());
    }
  }

  askScript(ctx) {
    return ctx.reply('ধাপ ৩/৩: স্ক্রিপ্ট বাছুন', KB([...BOT_TEMPLATES.map((x) => [B(x.name, 'nbt:' + x.key)]), [B('📝 নিজের স্ক্রিপ্ট দেব', 'nbs')]]));
  }

  async saveScript(ctx, uid, id, code) {
    const err = Ai.validate(code);
    if (err) return ctx.reply('সিনট্যাক্স ত্রুটি:\n' + err + '\nঠিক করে আবার পাঠান।');
    this.wiz.delete(uid);
    this.store.writeScript(id, code);
    if (this.runner.state(id) !== 'stopped') await this.runner.restart(id);
    return this.show(ctx, this.vBot(id));
  }

  async finishNew(ctx, uid, code) {
    const w = this.wiz.get(uid);
    if (!w || !w.data || !w.data.host) return this.show(ctx, this.vBots(0));
    const err = Ai.validate(code);
    if (err) return ctx.reply('সিনট্যাক্স ত্রুটি:\n' + err + '\nআবার পাঠান।');
    if (this.store.data.bots.length >= this.maxBots) return this.show(ctx, this.vBots(0));
    const bot = { id: genId(), tgBotId: null, ...w.data, version: '', notify: true, desired: false, createdAt: Date.now() };
    this.store.data.bots.push(bot); this.store.writeScript(bot.id, code); this.store.save(); this.wiz.delete(uid);
    return this.show(ctx, this.vBot(bot.id));
  }

  async finishWorker(ctx, uid, key) {
    const w = this.wiz.get(uid);
    if (!w || !w.name) return this.show(ctx, this.vWorkers(0));
    const tp = WK_TEMPLATES.find((x) => x.key === key) || WK_TEMPLATES[0];
    let wk;
    try { wk = this.workers.create({ name: w.name, files: tp.files || [{ path: 'worker.js', content: tp.code }] }); } catch (e) { return ctx.reply('⚠️ ' + esc(e.message), { parse_mode: 'HTML' }); }
    this.wiz.delete(uid);
    await ctx.reply('🚀 ডিপ্লয় চলছে...');
    const r = await this.workers.deploy(wk.id);
    if (!r.ok) await ctx.reply('⚠️ তৈরি হয়েছে কিন্তু চালু হয়নি:\n' + esc(String(r.error).split('\n')[0]), { parse_mode: 'HTML' });
    return this.show(ctx, this.vWorker(wk.id));
  }

  async saveWorkerFile(ctx, uid, w, content) {
    try { this.workers.writeFile(w.id, w.path, content); } catch (e) { return ctx.reply('⚠️ ' + esc(e.message), { parse_mode: 'HTML' }); }
    this.wiz.delete(uid);
    const syn = this.workers.syntaxCheck(w.path, content);
    await ctx.reply(`✅ <code>${esc(w.path)}</code> সেভ হয়েছে${syn ? `\n⚠️ সিনট্যাক্স সতর্কতা:\n<code>${esc(syn.slice(0, 400))}</code>` : ''}`, { parse_mode: 'HTML', ...KB([[B('🚀 ডিপ্লয়', 'wd:' + w.id), B('📁 ফাইল', `wf:${w.id}:0`)]]) });
  }

  // ================= ডকুমেন্ট (ফাইল আপলোড) =================
  async download(ctx, d) {
    if (d.file_size && d.file_size > 20 * 1024 * 1024) throw new Error('ফাইল ২০MB এর বেশি (টেলিগ্রামের সীমা)');
    const url = await ctx.telegram.getFileLink(d.file_id);
    const r = await fetch(url.href || String(url));
    if (!r.ok) throw new Error('ফাইল নামানো যায়নি');
    return Buffer.from(await r.arrayBuffer());
  }

  async onDoc(ctx, t) {
    const uid = ctx.from.id; const d = ctx.message.document; const w = this.wiz.get(uid);
    const name = d.file_name || 'file';
    if (!w || !['newscript', 'script', 'wup', 'wnewup', 'wenvimp', 'wfe', 'wnf2'].includes(w.step)) {
      this.pendingDoc.set(uid, { file_id: d.file_id, name, size: d.file_size || 0, caption: ctx.message.caption || '' });
      const isJs = /\.(m?js|cjs|txt)$/i.test(name);
      const rows = this.workers.all().slice(0, 6).map((x) => [B(`☁️ ${x.name}-এ রাখুন`, `pd:${x.id}:w`)]);
      if (isJs) for (const b of this.store.data.bots.slice(0, 4)) rows.push([B(`🤖 ${b.username}-এর স্ক্রিপ্ট`, `pd:${b.id}:b`)]);
      rows.push([B('📦 নতুন Worker হিসেবে', 'pd:n:n')], [B('❌ কিছু না', 'h')]);
      return ctx.reply(`📎 <b>${esc(name)}</b> <i>(${kb(d.file_size || 0)})</i>\nকোথায় রাখব?`, { parse_mode: 'HTML', ...KB(rows) });
    }
    const buf = await this.download(ctx, d);
    return this.handleUpload(ctx, uid, w, name, buf, ctx.message.caption || '');
  }

  async handleUpload(ctx, uid, w, name, buf, caption) {
    const text = () => buf.toString('utf8');
    if (w.step === 'newscript') return this.finishNew(ctx, uid, text());
    if (w.step === 'script') return this.saveScript(ctx, uid, w.id, text());
    if (w.step === 'wenvimp') { const list = this.parseEnv(text()); if (!list.length) return ctx.reply('কোনো ভেরিয়েবল পাইনি।'); await this.mergeEnv(this.workers.get(w.id), list); this.wiz.delete(uid); await ctx.reply(`✅ ${list.length}টি ইমপোর্ট হয়েছে।`); return this.show(ctx, this.vWEnv(w.id)); }
    if (w.step === 'wfe' || w.step === 'wnf2') return this.saveWorkerFile(ctx, uid, w, text());
    if (w.step === 'wnewup') {
      let wk;
      try {
        if (/\.zip$/i.test(name)) { wk = this.workers.create({ name: w.name, code: 'export default { fetch: () => new Response("ok") };' }); this.workers.importZip(wk.id, buf, { replace: true }); }
        else wk = this.workers.create({ name: w.name, files: [{ path: 'worker.js', content: text() }] });
      } catch (e) { return ctx.reply('⚠️ ' + esc(e.message), { parse_mode: 'HTML' }); }
      this.wiz.delete(uid); await ctx.reply('🚀 ডিপ্লয় চলছে...');
      const r = await this.workers.deploy(wk.id);
      if (!r.ok) await ctx.reply('⚠️ চালু হয়নি:\n' + esc(String(r.error).split('\n')[0]), { parse_mode: 'HTML' });
      return this.show(ctx, this.vWorker(wk.id));
    }
    // wup: ফাইল বা zip যোগ
    const id = w.id; const cap = caption.trim();
    if (/\.zip$/i.test(name)) {
      const r = this.workers.importZip(id, buf, { replace: false });
      return ctx.reply(`📦 ZIP খোলা হয়েছে: ✅ ${r.written}টি ফাইল${r.skipped ? `, ⚠️ ${r.skipped}টি বাদ` : ''}`, KB([[B('🚀 ডিপ্লয়', 'wd:' + id), B('📁 ফাইল', `wf:${id}:0`)]]));
    }
    let rel = cap && /[./]/.test(cap) && !/\s/.test(cap) ? cap : name;
    try { rel = this.workers.safeRel(rel); this.workers.writeFile(id, rel, buf); } catch (e) { return ctx.reply('⚠️ ' + esc(e.message), { parse_mode: 'HTML' }); }
    return ctx.reply(`✅ <code>${esc(rel)}</code> (${kb(buf.length)}) যোগ হয়েছে। আরও পাঠাতে পারেন।`, { parse_mode: 'HTML', ...KB([[B('🚀 ডিপ্লয়', 'wd:' + id), B('📁 ফাইল', `wf:${id}:0`)]]) });
  }

  async applyPendingDoc(ctx, uid, id, kind) {
    const pd = this.pendingDoc.get(uid);
    if (!pd) return ctx.reply('ফাইলের মেয়াদ শেষ। আবার পাঠান।');
    const buf = await this.download(ctx, pd);
    this.pendingDoc.delete(uid);
    if (kind === 'b') { const err = Ai.validate(buf.toString('utf8')); if (err) return ctx.reply('সিনট্যাক্স ত্রুটি:\n' + err); this.store.writeScript(id, buf.toString('utf8')); if (this.runner.state(id) !== 'stopped') await this.runner.restart(id); return this.show(ctx, this.vBot(id)); }
    if (kind === 'n') { this.wiz.set(uid, { step: 'wnewup', name: pd.name.replace(/\.[^.]+$/, '') || 'worker' }); return this.handleUpload(ctx, uid, this.wiz.get(uid), pd.name, buf, ''); }
    return this.handleUpload(ctx, uid, { step: 'wup', id }, pd.name, buf, pd.caption);
  }
}

module.exports = Tg;
