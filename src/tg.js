'use strict';
const { Telegraf, Markup } = require('telegraf');
const { esc, genId, fmtDur, parseHost, validName, diagnose } = require('./util');
const Ai = require('./ai');

const B = Markup.button.callback;
const KB = (rows) => Markup.inlineKeyboard(rows);
const STATE_TAG = { online: 'অনলাইন', starting: 'কানেক্ট হচ্ছে', reconnecting: 'রিকানেক্ট হবে', stopped: 'বন্ধ' };
const DOT = { online: '🟢', starting: '🟡', reconnecting: '🟠', stopped: '⚪' };
const QUICK = [
  'বটের বর্তমান অবস্থা ও লগ বিশ্লেষণ করে সমস্যা ও সমাধান বলো।',
  'স্ক্রিপ্টটি পর্যালোচনা করে ত্রুটি বা উন্নতির জায়গা ঠিক করে সম্পূর্ণ নতুন স্ক্রিপ্ট দাও।',
  'বটকে আরও মানুষের মতো আচরণ করাও (এলোমেলো হাঁটা, তাকানো, ছোট বিরতি) এবং সম্পূর্ণ স্ক্রিপ্ট দাও।',
];

const bar = (n) => { const f = Math.round(n / 10); return '▰'.repeat(f) + '▱'.repeat(10 - f) + ` ${n}`; };

class Tg {
  constructor(store, runner, ai, { maxBots, defaultScript }) {
    this.store = store; this.runner = runner; this.ai = ai;
    this.maxBots = maxBots; this.defaultScript = defaultScript;
    this.inst = new Map();       // tgId -> Telegraf
    this.wiz = new Map();        // userId -> wizard state
    this.chatMode = new Map();   // userId -> botId | '_fleet'
  }

  list() { return this.store.data.tgBots.map((t) => ({ id: t.id, username: t.username, owner: t.ownerId || null, running: this.inst.has(t.id) })); }

  // ---------- lifecycle ----------
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

  async stopAll() { for (const [, i] of this.inst) { try { i.stop('shutdown'); } catch { /* ignore */ } } this.inst.clear(); }

  _launch(t) {
    const bot = new Telegraf(t.token);
    this.inst.set(t.id, bot);
    bot.catch((e) => console.error('[tg]', t.username, e.message));

    // অ্যাক্সেস কন্ট্রোল: OWNER_ID বা প্রথম /start যে দেবে সে মালিক
    bot.use(async (ctx, next) => {
      const uid = ctx.from && ctx.from.id;
      if (!uid) return;
      const env = Number(process.env.OWNER_ID) || null;
      if (env) t.ownerId = env;
      if (!t.ownerId) {
        if (ctx.message && /^\/start/.test(ctx.message.text || '')) { t.ownerId = uid; this.store.save(); } else return;
      }
      if (t.ownerId !== uid) { if (ctx.message) await ctx.reply('এই বট ব্যক্তিগত।').catch(() => {}); return; }
      return next();
    });

    bot.start((ctx) => { this._reset(ctx.from.id); return this.home(ctx, true); });
    bot.command('menu', (ctx) => { this._reset(ctx.from.id); return this.home(ctx, true); });
    bot.command('cancel', (ctx) => { this._reset(ctx.from.id); return this.home(ctx, true); });
    bot.on('callback_query', async (ctx) => {
      await ctx.answerCbQuery().catch(() => {});
      try { await this.route(ctx, t, String(ctx.callbackQuery.data || '')); } catch (e) { console.error('[tg:cb]', e.message); await ctx.reply('ত্রুটি: ' + esc(e.message), { parse_mode: 'HTML' }).catch(() => {}); }
    });
    bot.on('text', (ctx) => this.onText(ctx, t, ctx.message.text).catch((e) => console.error('[tg:text]', e.message)));
    bot.on('document', (ctx) => this.onDoc(ctx, t).catch((e) => console.error('[tg:doc]', e.message)));

    bot.launch({ dropPendingUpdates: true }).catch((e) => { console.error('[tg] launch ব্যর্থ:', e.message); this.inst.delete(t.id); });
    bot.telegram.setMyCommands([{ command: 'menu', description: 'মূল মেনু' }, { command: 'cancel', description: 'বাতিল' }]).catch(() => {});
  }

  _reset(uid) { this.wiz.delete(uid); this.chatMode.delete(uid); }

  // ---------- notifications ----------
  notifyEvent(ev) {
    if (ev.bot.notify === false) return;
    const b = ev.bot;
    const d = diagnose(ev.reason);
    let text; let rows = [[B('বট দেখুন', 'b:' + b.id)]];
    const name = `<b>${esc(b.username)}</b>`;
    if (ev.type === 'online') text = ev.recovered ? `🟢 ${name} আবার অনলাইন হয়েছে।` : `🟢 ${name} সার্ভারে ঢুকেছে।`;
    else if (ev.type === 'offline') {
      text = `🔴 ${name} অফলাইন হয়েছে।\n${d ? `<b>${esc(d.title)}</b>\n${esc(d.hint)}\n` : ''}${ev.nextIn}সে পরে আবার চেষ্টা হবে।`;
      if (this.ai.ready()) rows = [[B('AI দিয়ে বিশ্লেষণ', `aq:${b.id}:0`), B('বট দেখুন', 'b:' + b.id)]];
    } else if (ev.type === 'failing') {
      text = `🟠 ${name} ${ev.attempts} বার চেষ্টা করেও ঢুকতে পারেনি।\n${d ? `<b>${esc(d.title)}</b>\n${esc(d.hint)}` : esc(ev.reason)}`;
      if (this.ai.ready()) rows = [[B('AI দিয়ে বিশ্লেষণ', `aq:${b.id}:0`), B('বট দেখুন', 'b:' + b.id)]];
    } else return;
    for (const t of this.store.data.tgBots) {
      const inst = this.inst.get(t.id);
      if (inst && t.ownerId) inst.telegram.sendMessage(t.ownerId, text, { parse_mode: 'HTML', ...KB(rows) }).catch(() => {});
    }
  }

  // ---------- view helpers ----------
  async show(ctx, text, kb) {
    const opt = { parse_mode: 'HTML', disable_web_page_preview: true, ...(kb || {}) };
    if (ctx.callbackQuery) {
      try { return await ctx.editMessageText(text, opt); } catch (e) { if (/not modified/i.test(e.message)) return; }
    }
    return ctx.reply(text, opt);
  }

  home(ctx) {
    const bots = this.store.data.bots;
    const f = this.runner.fleet();
    const lines = bots.map((b) => `${DOT[this.runner.state(b.id)]} <b>${esc(b.username)}</b>  <code>${esc(b.host)}:${b.port}</code>`);
    const text = `<b>MC Host</b>\nঅনলাইন ${f.online} / ${f.total}  ·  মেমরি ${f.mem} MB\nAI: ${this.ai.ready() ? esc(this.ai.model()) : 'বন্ধ'}\n\n${lines.join('\n') || 'এখনো কোনো বট নেই।'}`;
    const rows = bots.map((b) => [B(`${DOT[this.runner.state(b.id)]} ${b.username}`, 'b:' + b.id)]);
    if (bots.length) rows.push([B('সব চালু', 'ba:s'), B('সব রিস্টার্ট', 'ba:r'), B('সব বন্ধ', 'ba:x')]);
    rows.push([B('+ নতুন বট', 'nb'), B('AI সহায়ক', 'ai:_fleet')]);
    rows.push([B('রিফ্রেশ', 'h'), B('অবস্থা', 'st')]);
    return this.show(ctx, text, KB(rows));
  }

  card(b) {
    const s = this.runner.snapshot(b.id);
    const l = [`${DOT[s.state]} <b>${esc(b.username)}</b>  ${STATE_TAG[s.state]}`, `<code>${esc(b.host)}:${b.port}</code>${b.version ? '  ·  ' + esc(b.version) : ''}`, `স্বাস্থ্য ${bar(s.health)}`];
    if (s.state === 'online') {
      l.push(`আপটাইম ${fmtDur(Date.now() - s.onlineSince)}`);
      const i = s.info;
      if (i) l.push(`HP ${i.health ?? '-'}  ক্ষুধা ${i.food ?? '-'}  পিং ${i.ping ?? '-'}ms  প্লেয়ার ${i.players ?? '-'}${i.pos ? `\nস্থান ${i.pos.join(', ')}` : ''}${i.mem ? `  ·  RAM ${i.mem}MB` : ''}`);
    } else if (s.state === 'reconnecting') l.push(`পরের চেষ্টা ${s.nextIn}সে পরে (#${s.attempts})`);
    if (s.diag && s.state !== 'online') l.push(`\n<b>${esc(s.diag.title)}</b>\n${esc(s.diag.hint)}`);
    return l.join('\n');
  }

  botKb(b) {
    const st = this.runner.state(b.id);
    const run = st === 'stopped' ? [B('চালু করুন', 's:' + b.id)] : [B('বন্ধ করুন', 'x:' + b.id), B('রিস্টার্ট', 'r:' + b.id)];
    const rows = [run, [B('লগ', 'l:' + b.id), B('বিশ্লেষণ', 'a:' + b.id), B('রিফ্রেশ', 'b:' + b.id)], [B('স্ক্রিপ্ট', 'sc:' + b.id), B('সেটিংস', 'cf:' + b.id), B('গেমে চ্যাট', 'sy:' + b.id)]];
    rows.push([B('AI দিয়ে স্ক্রিপ্ট আপডেট', 'ai:' + b.id)], [B('« ফিরুন', 'h')]);
    return KB(rows);
  }

  async showBot(ctx, id) {
    const b = this.store.bot(id);
    if (!b) return this.home(ctx);
    return this.show(ctx, this.card(b), this.botKb(b));
  }

  // ---------- router ----------
  async route(ctx, t, data) {
    const uid = ctx.from.id;
    const [k, id, extra] = data.split(':');
    const b = id ? this.store.bot(id) : null;
    if (k === 'ba') {
      if (id === 's') this.runner.startAll(); else if (id === 'x') await this.runner.stopAll(); else if (id === 'r') await this.runner.restartAll();
      return this.home(ctx);
    }
    if (id && id !== '_fleet' && !b) return this.home(ctx);

    switch (k) {
      case 'h': this._reset(uid); return this.home(ctx);
      case 'st': {
        const f = this.runner.fleet();
        return this.show(ctx, `<b>সিস্টেম</b>\nবট ${f.total}  ·  অনলাইন ${f.online}\nRAM (বট) ${f.mem} MB  ·  RAM (হোস্ট) ${Math.round(process.memoryUsage().rss / 1048576)} MB\nআপটাইম ${fmtDur(process.uptime() * 1000)}\nডাটা মোড: ${this.store.mode}\nAI: ${this.ai.ready() ? esc(this.ai.model()) : 'বন্ধ'}`, KB([[B('« ফিরুন', 'h')]]));
      }
      case 'b': return this.showBot(ctx, id);
      case 's': { const r = this.runner.start(id, { user: true }); if (!r.ok) await ctx.answerCbQuery(r.error).catch(() => {}); return this.showBot(ctx, id); }
      case 'x': await this.runner.stop(id); return this.showBot(ctx, id);
      case 'r': await this.runner.restart(id); return this.showBot(ctx, id);
      case 'l': {
        const logs = this.runner.logs(id, 25).join('\n') || '(লগ নেই)';
        return this.show(ctx, `<b>${esc(b.username)} লগ</b>\n<pre>${esc(logs.slice(-3300))}</pre>`, KB([[B('রিফ্রেশ', 'l:' + id), B('« বট', 'b:' + id)]]));
      }
      case 'a': {
        const s = this.runner.snapshot(id);
        const ev = this.runner.events(id, 8).map((e) => `${new Date(e.t).toTimeString().slice(0, 8)} ${esc(e.type)} ${esc(e.text)}`).join('\n') || '-';
        const st = s.stats;
        const top = st ? Object.entries(st.reasons).sort((a, c) => c[1] - a[1]).slice(0, 3).map(([n, c]) => `${esc(n)} (${c})`).join(', ') : '';
        const text = `<b>বিশ্লেষণ: ${esc(b.username)}</b>\nস্বাস্থ্য ${bar(s.health)}\nসেশন ${st.sessions}  ·  ক্র্যাশ ${st.crashes}  ·  মোট আপটাইম ${fmtDur(st.upMs)}\n${top ? 'প্রধান সমস্যা: ' + top + '\n' : ''}\n<b>সাম্প্রতিক ঘটনা</b>\n<pre>${ev}</pre>${s.diag ? `\n<b>${esc(s.diag.title)}</b>\n${esc(s.diag.hint)}` : ''}`;
        const rows = [[B('রিফ্রেশ', 'a:' + id), B('« বট', 'b:' + id)]];
        if (this.ai.ready()) rows.unshift([B('AI বিশ্লেষণ', `aq:${id}:0`)]);
        return this.show(ctx, text, KB(rows));
      }
      case 'sy': this.wiz.set(uid, { step: 'say', id }); return this.show(ctx, `<b>${esc(b.username)}</b> গেমে যা বলবে সেটি লিখুন (/cancel)`, KB([[B('বাতিল', 'b:' + id)]]));

      // ----- script -----
      case 'sc': return this.show(ctx, `<b>${esc(b.username)} স্ক্রিপ্ট</b>`, KB([
        [B('ফাইল হিসেবে দেখুন', 'sd:' + id), B('এডিট', 'se:' + id)],
        [B('AI দিয়ে আপডেট', 'ai:' + id)],
        [...(this.store.hasPrev(id) ? [B('আগের সংস্করণ', 'sr:' + id)] : []), B('ডিফল্টে রিসেট', 'sz:' + id)],
        [B('« বট', 'b:' + id)]]));
      case 'sd': await ctx.replyWithDocument({ source: Buffer.from(this.store.readScript(id)), filename: `${b.username}.js` }); return;
      case 'se': this.wiz.set(uid, { step: 'script', id }); return this.show(ctx, 'নতুন স্ক্রিপ্ট পেস্ট করুন বা <b>.js ফাইল</b> পাঠান (/cancel)', KB([[B('বাতিল', 'sc:' + id)]]));
      case 'sr': if (this.store.rollback(id) && this.runner.state(id) !== 'stopped') await this.runner.restart(id); return this.showBot(ctx, id);
      case 'sz': this.store.writeScript(id, this.defaultScript); if (this.runner.state(id) !== 'stopped') await this.runner.restart(id); return this.showBot(ctx, id);

      // ----- config -----
      case 'cf': return this.show(ctx, `<b>সেটিংস: ${esc(b.username)}</b>\nনাম: <code>${esc(b.username)}</code>\nসার্ভার: <code>${esc(b.host)}:${b.port}</code>\nভার্সন: ${esc(b.version || 'অটো')}\nনোটিফিকেশন: ${b.notify === false ? 'বন্ধ' : 'চালু'}`, KB([
        [B('নাম', `ce:${id}:name`), B('সার্ভার', `ce:${id}:host`), B('ভার্সন', `ce:${id}:version`)],
        [B(b.notify === false ? 'নোটিফিকেশন চালু' : 'নোটিফিকেশন বন্ধ', 'cn:' + id)],
        [B('বট মুছুন', 'dl:' + id), B('« বট', 'b:' + id)]]));
      case 'cn': b.notify = b.notify === false; this.store.save(); return this.route(ctx, t, 'cf:' + id);
      case 'ce': this.wiz.set(uid, { step: 'cfg', id, field: extra }); return this.show(ctx, ({ name: 'নতুন নাম (৩-১৬ অক্ষর)', host: 'নতুন সার্ভার (host অথবা host:port)', version: 'ভার্সন (যেমন 1.20.4) অথবা <code>auto</code>' })[extra] + ' লিখুন', KB([[B('বাতিল', 'cf:' + id)]]));
      case 'dl': return this.show(ctx, `<b>${esc(b.username)}</b> মুছে ফেলবেন? স্ক্রিপ্টসহ সব যাবে।`, KB([[B('হ্যাঁ, মুছুন', 'dy:' + id), B('না', 'cf:' + id)]]));
      case 'dy': await this.runner.stop(id); this.store.removeBot(id); return this.home(ctx);

      // ----- new bot -----
      case 'nb':
        if (this.store.data.bots.length >= this.maxBots) return this.show(ctx, `সর্বোচ্চ ${this.maxBots}টি বট রাখা যায়।`, KB([[B('« ফিরুন', 'h')]]));
        this.wiz.set(uid, { step: 'name', data: {} });
        return this.show(ctx, '<b>নতুন বট</b>\nধাপ ১/৩: বটের গেম-নাম লিখুন (৩-১৬ অক্ষর, A-Z 0-9 _)', KB([[B('বাতিল', 'h')]]));
      case 'nbd': return this.finishNew(ctx, uid, this.defaultScript);
      case 'nbs': { const w = this.wiz.get(uid); if (w) w.step = 'newscript'; return this.show(ctx, 'স্ক্রিপ্ট পেস্ট করুন বা .js ফাইল পাঠান', KB([[B('বাতিল', 'h')]])); }

      // ----- AI -----
      case 'ai': {
        if (!this.ai.ready()) return this.show(ctx, 'AI চালু নেই। ওয়েব ড্যাশবোর্ডের AI সেটিংসে Mistral API key দিন।', KB([[B('« ফিরুন', 'h')]]));
        this.wiz.delete(uid);
        this.chatMode.set(uid, id);
        const who = id === '_fleet' ? 'সব বট' : esc(b.username);
        return this.show(ctx, `<b>AI সহায়ক: ${who}</b>  <code>${esc(this.ai.model())}</code>\nআমি বটের অবস্থা, লগ, স্ক্রিপ্ট ও আগের কথোপকথন মনে রাখি। যা চান লিখুন, যেমন "বটকে ১০ সেকেন্ডে একবার লাফ দিতে বলো"।`, KB([
          ...(id === '_fleet' ? [] : [[B('লগ বিশ্লেষণ', `aq:${id}:0`)], [B('স্ক্রিপ্ট ঠিক করো', `aq:${id}:1`), B('মানুষের মতো করো', `aq:${id}:2`)]]),
          [B('মেমরি মুছুন', 'am:' + id), B('বের হন', id === '_fleet' ? 'h' : 'b:' + id)]]));
      }
      case 'aq': this.chatMode.set(uid, id); return this.askAi(ctx, id, QUICK[Number(extra)] || QUICK[0]);
      case 'am': this.ai.clearMemory(id === '_fleet' ? null : id); return ctx.reply('AI মেমরি মুছে ফেলা হয়েছে।');
      case 'ap': {
        const code = this.ai.takePending(id);
        if (!code) return ctx.reply('প্রয়োগ করার মতো কোড নেই (মেয়াদ শেষ)। আবার চেয়ে দেখুন।');
        this.store.writeScript(id, code);
        this.ai.addNote(id, 'AI প্রস্তাব করা স্ক্রিপ্ট প্রয়োগ হয়েছে');
        if (this.runner.state(id) !== 'stopped') await this.runner.restart(id);
        return ctx.reply('স্ক্রিপ্ট আপডেট হয়েছে' + (this.runner.state(id) !== 'stopped' ? ' এবং বট রিস্টার্ট হচ্ছে।' : '।'), KB([[B('বট দেখুন', 'b:' + id)]]));
      }
      case 'ad': this.ai.takePending(id); return ctx.reply('প্রস্তাব বাতিল।');
      default: return this.home(ctx);
    }
  }

  // ---------- AI chat ----------
  async askAi(ctx, botId, text) {
    const target = botId === '_fleet' ? null : botId;
    await ctx.sendChatAction('typing').catch(() => {});
    let r;
    try { r = await this.ai.chat(target, text); } catch (e) { return ctx.reply('AI ত্রুটি: ' + e.message); }
    const inlineOk = r.code && r.code.length <= 1800;
    let body = r.reply.replace(/```[\s\S]*?```/g, r.code ? (inlineOk ? '[[CODE]]' : '(পুরো কোড নিচের ফাইলে)') : '(কোড)');
    body = esc(body).replace('[[CODE]]', `<pre>${esc(r.code)}</pre>`);
    for (let i = 0; i < body.length; i += 3800) {
      const part = body.slice(i, i + 3800);
      await ctx.reply(part, { parse_mode: 'HTML' }).catch(() => ctx.reply(r.reply.slice(i, i + 3800)));
    }
    if (r.error) await ctx.reply('AI-এর দেওয়া কোডে সিনট্যাক্স ত্রুটি আছে: ' + r.error + '\nআবার ঠিক করতে বলুন।');
    if (r.code && target) {
      if (!inlineOk) await ctx.replyWithDocument({ source: Buffer.from(r.code), filename: 'proposed.js' });
      await ctx.reply('এই স্ক্রিপ্ট প্রয়োগ করবেন?', KB([[B('প্রয়োগ করুন', 'ap:' + target), B('বাতিল', 'ad:' + target)]]));
    }
  }

  // ---------- text / wizard ----------
  async onText(ctx, t, text) {
    const uid = ctx.from.id;
    const w = this.wiz.get(uid);
    if (!w) {
      const mode = this.chatMode.get(uid);
      if (mode) return this.askAi(ctx, mode, text);
      return this.home(ctx);
    }
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
        w.step = 'port';
        return ctx.reply('পোর্ট লিখুন (ডিফল্ট 25565 হলে <code>25565</code> লিখুন)', { parse_mode: 'HTML' });
      }
      case 'port': {
        const p = Number(text);
        if (!(p > 0 && p < 65536)) return ctx.reply('পোর্ট ১-৬৫৫৩৫ এর মধ্যে হতে হবে।');
        w.data.port = p; w.step = 'scriptchoice';
        return this.askScript(ctx);
      }
      case 'newscript': return this.finishNew(ctx, uid, text);
      case 'script': return this.saveScript(ctx, uid, w.id, text);
      case 'say': {
        this.wiz.delete(uid);
        const okSay = this.runner.say(w.id, text);
        return ctx.reply(okSay ? 'পাঠানো হয়েছে।' : 'বট এখন অনলাইন নেই।', KB([[B('« বট', 'b:' + w.id)]]));
      }
      case 'cfg': {
        const b = this.store.bot(w.id);
        if (!b) return this.home(ctx);
        if (w.field === 'name') { if (!validName(text)) return ctx.reply('নাম সঠিক নয়।'); b.username = text; }
        else if (w.field === 'host') { const h = parseHost(text); if (!h) return ctx.reply('ঠিকানা সঠিক নয়।'); b.host = h.host; if (h.port) b.port = h.port; }
        else if (w.field === 'version') b.version = /^auto$/i.test(text) ? '' : text.trim();
        this.store.save(); this.wiz.delete(uid);
        if (this.runner.state(b.id) !== 'stopped') await this.runner.restart(b.id);
        return this.showBot(ctx, b.id);
      }
      default: this.wiz.delete(uid); return this.home(ctx);
    }
  }

  askScript(ctx) {
    return ctx.reply('ধাপ ৩/৩: স্ক্রিপ্ট', KB([[B('ডিফল্ট স্ক্রিপ্ট ব্যবহার করুন', 'nbd')], [B('নিজের স্ক্রিপ্ট দেব', 'nbs')]]));
  }

  async onDoc(ctx, t) {
    const uid = ctx.from.id;
    const w = this.wiz.get(uid);
    if (!w || !['newscript', 'script'].includes(w.step)) return;
    const d = ctx.message.document;
    if (d.file_size > 300000 || !/\.(js|txt|cjs)$/i.test(d.file_name || '')) return ctx.reply('৩০০KB এর ছোট .js ফাইল পাঠান।');
    const url = await ctx.telegram.getFileLink(d.file_id);
    const text = await (await fetch(url.href || String(url))).text();
    return w.step === 'newscript' ? this.finishNew(ctx, uid, text) : this.saveScript(ctx, uid, w.id, text);
  }

  async saveScript(ctx, uid, id, code) {
    const err = Ai.validate(code);
    if (err) return ctx.reply('সিনট্যাক্স ত্রুটি:\n' + err + '\nঠিক করে আবার পাঠান।');
    this.wiz.delete(uid);
    this.store.writeScript(id, code);
    if (this.runner.state(id) !== 'stopped') await this.runner.restart(id);
    return this.showBot(ctx, id);
  }

  async finishNew(ctx, uid, code) {
    const w = this.wiz.get(uid);
    if (!w || !w.data || !w.data.host) return this.home(ctx);
    const err = Ai.validate(code);
    if (err) return ctx.reply('সিনট্যাক্স ত্রুটি:\n' + err + '\nআবার পাঠান।');
    if (this.store.data.bots.length >= this.maxBots) return this.home(ctx);
    const bot = { id: genId(), tgBotId: null, ...w.data, version: '', notify: true, desired: false, createdAt: Date.now() };
    this.store.data.bots.push(bot);
    this.store.writeScript(bot.id, code);
    this.wiz.delete(uid);
    return this.showBot(ctx, bot.id);
  }
}

module.exports = Tg;
