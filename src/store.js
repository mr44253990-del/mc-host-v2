'use strict';
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const REMOTE_URL = process.env.UPSTASH_REDIS_REST_URL;
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REMOTE_KEY = process.env.REMOTE_KEY || 'mchost:state:v2';

class Store {
  constructor() {
    this.dir = DIR;
    this.file = path.join(DIR, 'state.json');
    this.scriptsDir = path.join(DIR, 'scripts');
    fs.mkdirSync(this.scriptsDir, { recursive: true });
    this.data = { tgBots: [], bots: [], settings: {}, aiMem: {}, history: [] };
    this.remote = !!(REMOTE_URL && REMOTE_TOKEN);
    this.mode = this.remote ? 'remote' : /^\/(var\/data|data|mnt)/.test(DIR) ? 'disk' : 'local';
    this._t1 = null;
    this._t2 = null;
  }

  async init() {
    if (fs.existsSync(this.file)) {
      try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { console.error('[store] state.json পড়া যায়নি:', e.message); }
    } else if (this.remote) {
      try { await this._restore(); } catch (e) { console.error('[store] remote restore ব্যর্থ:', e.message); }
    }
    this.data.tgBots ||= [];
    this.data.bots ||= [];
    this.data.settings ||= {};
    this.data.aiMem ||= {};
    this.data.history ||= [];
    this.data.workers ||= [];
  }

  // ---------- settings / AI memory / fleet history ----------
  setting(k, d = '') { return this.data.settings[k] ?? d; }
  setSetting(k, v) { this.data.settings[k] = v; this.save(); }
  mem(botId) { return (this.data.aiMem[botId] ||= { notes: [], chat: [] }); }
  pushHistory(p) { const h = this.data.history; h.push(p); if (h.length > 180) h.splice(0, h.length - 180); }

  // ---------- lookups ----------
  bot(id) { return this.data.bots.find((b) => b.id === id); }
  botsOf(tgId) { return this.data.bots.filter((b) => b.tgBotId === tgId); }
  tg(id) { return this.data.tgBots.find((t) => t.id === id); }

  // ---------- scripts ----------
  scriptPath(id) { return path.join(this.scriptsDir, id + '.js'); }
  readScript(id) { try { return fs.readFileSync(this.scriptPath(id), 'utf8'); } catch { return ''; } }
  hasPrev(id) { return fs.existsSync(path.join(this.scriptsDir, id + '.prev.js')); }
  writeScript(id, code) {
    const p = this.scriptPath(id);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(this.scriptsDir, id + '.prev.js'));
    fs.writeFileSync(p, code);
    this.save();
  }
  rollback(id) {
    const prev = path.join(this.scriptsDir, id + '.prev.js');
    if (!fs.existsSync(prev)) return false;
    const cur = this.readScript(id);
    fs.copyFileSync(prev, this.scriptPath(id));
    fs.writeFileSync(prev, cur);
    this.save();
    return true;
  }
  removeBot(id) {
    this.data.bots = this.data.bots.filter((b) => b.id !== id);
    delete this.data.aiMem[id];
    for (const f of [id + '.js', id + '.prev.js']) fs.rmSync(path.join(this.scriptsDir, f), { force: true });
    this.save();
  }

  // ---------- persistence ----------
  save() {
    clearTimeout(this._t1);
    this._t1 = setTimeout(() => this.flush(), 400);
    if (this.remote) {
      clearTimeout(this._t2);
      this._t2 = setTimeout(() => this._push().catch((e) => console.error('[store] remote push ব্যর্থ:', e.message)), 3000);
    }
  }

  flush() {
    clearTimeout(this._t1);
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[store] সেভ ব্যর্থ:', e.message); }
  }

  async flushAll() {
    this.flush();
    if (this.remote) { clearTimeout(this._t2); await this._push().catch(() => {}); }
  }

  // ---------- remote (Upstash Redis REST) ----------
  async _cmd(cmd) {
    const r = await fetch(REMOTE_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + REMOTE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  }

  async _push() {
    const scripts = {};
    for (const b of this.data.bots) scripts[b.id] = this.readScript(b.id);
    const wk = {};
    for (const w of this.data.workers || []) { try { wk[w.id] = fs.readFileSync(path.join(DIR, 'workers', w.id + '.mjs'), 'utf8'); } catch { /* missing */ } }
    const blob = JSON.stringify({ data: this.data, scripts, workers: wk, ts: Date.now() });
    if (blob.length > 900000) return console.warn('[store] ডাটা ১MB-এর কাছাকাছি — remote backup বাদ দেওয়া হলো');
    await this._cmd(['SET', REMOTE_KEY, blob]);
  }

  async _restore() {
    const raw = await this._cmd(['GET', REMOTE_KEY]);
    if (!raw) return;
    const { data, scripts, workers } = JSON.parse(raw);
    this.data = data;
    fs.mkdirSync(path.join(DIR, 'workers'), { recursive: true });
    for (const [id, code] of Object.entries(workers || {})) fs.writeFileSync(path.join(DIR, 'workers', id + '.mjs'), code);
    for (const [id, code] of Object.entries(scripts || {})) fs.writeFileSync(this.scriptPath(id), code);
    this.flush();
    console.log(`[store] remote থেকে ${data.bots.length}টি বট ও ${data.tgBots.length}টি টেলিগ্রাম বট ফিরিয়ে আনা হয়েছে`);
  }
}

module.exports = new Store();
