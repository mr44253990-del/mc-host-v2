'use strict';
// Mistral AI সহায়ক: বটের অবস্থা, লগ, স্ক্রিপ্ট ও আগের কথোপকথন (মেমরি) দেখে উত্তর ও স্ক্রিপ্ট আপডেট প্রস্তাব করে।
const vm = require('vm');
const { diagnose } = require('./util');

const API = 'https://api.mistral.ai/v1';
const FALLBACK_MODELS = ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'codestral-latest', 'open-mistral-nemo'];

const SYSTEM = `You are "MC Host Assistant", an expert embedded in a Minecraft bot hosting system. Reply in the same language as the user (usually Bengali), concise and practical.

How the host works:
- Each Minecraft bot is a Node.js script using the "mineflayer" library, started as: node -r preload.js script.js
- Environment variables given to every script: MC_HOST, MC_PORT, MC_USERNAME, MC_VERSION (empty = auto-detect), MC_AUTH.
- Reconnect is handled by the host. When the connection ends, the process exits and the host restarts it with exponential backoff. Scripts must NOT implement their own reconnect loops.
- Only mineflayer and Node built-in modules are available. Do not require anything else unless the user explicitly installs it.
- Memory is limited (about 192 MB per bot): avoid memory leaks, unbounded arrays and heavy loops.

When you propose a script change:
1. Give a short explanation of what changes and why (2-5 lines).
2. Then output the COMPLETE new script in exactly ONE fenced block: \`\`\`js ... \`\`\`
3. Always read host/port/username/version from the env vars above. Never hardcode them.
4. Keep working parts of the existing script unless the user asks to change them.
If the user only asks a question or wants debugging help, answer without a code block unless a fix needs code.`;

class Ai {
  constructor(store, runner) { this.store = store; this.runner = runner; this.pending = new Map(); this.pendingW = new Map(); }

  key() { return this.store.setting('mistralKey') || process.env.MISTRAL_API_KEY || ''; }
  model() { return this.store.setting('mistralModel') || process.env.MISTRAL_MODEL || 'mistral-small-latest'; }
  ready() { return !!this.key(); }

  async _fetch(path, opts = {}) {
    if (!this.ready()) throw new Error('Mistral API key সেট করা নেই। ড্যাশবোর্ডের AI সেটিংসে দিন।');
    let r;
    try {
      r = await fetch(API + path, {
        ...opts,
        headers: { Authorization: 'Bearer ' + this.key(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
        signal: AbortSignal.timeout(opts.timeout || 60000),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'Mistral সাড়া দিতে দেরি করছে, আবার চেষ্টা করুন।' : 'Mistral-এ কানেক্ট করা যায়নি: ' + e.message);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.message || (j.error && j.error.message) || r.statusText || '').toString().slice(0, 200);
      if (r.status === 401) throw new Error('API key ভুল বা বাতিল।');
      if (r.status === 429) throw new Error('Mistral রেট লিমিট: একটু পরে আবার চেষ্টা করুন।');
      throw new Error(`Mistral ত্রুটি ${r.status}: ${msg}`);
    }
    return j;
  }

  async models() {
    try {
      const j = await this._fetch('/models', { timeout: 15000 });
      const list = (j.data || []).filter((m) => !m.capabilities || m.capabilities.completion_chat).map((m) => m.id);
      const uniq = [...new Set(list)].sort();
      return uniq.length ? uniq : FALLBACK_MODELS;
    } catch (e) {
      if (!this.ready()) throw e;
      return FALLBACK_MODELS;
    }
  }

  async complete(messages, { temperature = 0.3, max_tokens = 3500 } = {}) {
    const j = await this._fetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: this.model(), messages, temperature, max_tokens }),
    });
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }

  // ---------- context ----------
  context(botId) {
    if (!botId) {
      const rows = this.store.data.bots.map((b) => {
        const s = this.runner.snapshot(b.id);
        return `- ${b.name || b.username} (${b.host}:${b.port}) state=${s.state} health=${s.health} restarts=${s.restarts}`;
      });
      return 'Fleet overview:\n' + (rows.join('\n') || '(no bots yet)');
    }
    const b = this.store.bot(botId);
    if (!b) return 'Bot not found.';
    const s = this.runner.snapshot(botId);
    const d = s.reason ? diagnose(s.reason) : null;
    const logs = this.runner.logs(botId, 30).join('\n');
    const code = this.store.readScript(botId).slice(0, 7000);
    const notes = this.store.mem(botId).notes.map((n) => '- ' + n).join('\n');
    return [
      `Bot: ${b.name || b.username} | host=${b.host}:${b.port} | username=${b.username} | version=${b.version || 'auto'}`,
      `State: ${s.state} | attempts=${s.attempts} | restarts=${s.restarts} | health=${s.health}/100`,
      d ? `Last problem: ${s.reason} => ${d.title} (${d.hint})` : 'Last problem: none',
      `Memory notes:\n${notes || '(none)'}`,
      `Recent logs:\n${logs || '(empty)'}`,
      `Current script:\n\`\`\`js\n${code}\n\`\`\``,
    ].join('\n');
  }

  static extractCode(text) {
    const m = String(text).match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/i);
    return m ? m[1].trim() : '';
  }

  static validate(code) {
    try { new vm.Script(code); return null; } catch (e) { return e.message; }
  }

  // ---------- chat with memory ----------
  async chat(botId, text, clientHistory) {
    const mem = botId ? this.store.mem(botId) : this.store.mem('_fleet');
    const local = Array.isArray(clientHistory); // ব্রাউজারে সংরক্ষিত ইতিহাস: সার্ভারে কিছু জমা হয় না
    const history = local ? Ai.cleanHist(clientHistory) : mem.chat.slice(-12);
    const messages = [
      { role: 'system', content: SYSTEM + '\n\n' + this.context(botId) },
      ...history,
      { role: 'user', content: String(text).slice(0, 4000) },
    ];
    const reply = await this.complete(messages);
    if (!local) {
      mem.chat.push({ role: 'user', content: String(text).slice(0, 1500) }, { role: 'assistant', content: reply.replace(/```[\s\S]*?```/g, '[code]').slice(0, 1500) });
      if (mem.chat.length > 30) await this._compact(mem).catch(() => {});
      this.store.save();
    }

    let code = Ai.extractCode(reply);
    let error = null;
    if (code && botId) {
      error = Ai.validate(code);
      if (!error) this.pending.set(botId, code);
    } else code = '';
    return { reply, code: code && !error ? code : '', error };
  }

  async _compact(mem) {
    const old = mem.chat.splice(0, mem.chat.length - 10);
    const sum = await this.complete([
      { role: 'system', content: 'Summarize the key facts, decisions and user preferences from this conversation into at most 3 short bullet lines. Same language as the conversation.' },
      { role: 'user', content: old.map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 9000) },
    ], { max_tokens: 300 });
    mem.notes.push(sum.trim().slice(0, 600));
    if (mem.notes.length > 8) mem.notes.splice(0, mem.notes.length - 8);
  }

  takePending(botId) { const c = this.pending.get(botId); this.pending.delete(botId); return c || ''; }
  hasPending(botId) { return this.pending.has(botId); }

  addNote(botId, note) { const m = this.store.mem(botId); m.notes.push(String(note).slice(0, 300)); if (m.notes.length > 8) m.notes.shift(); this.store.save(); }
  clearMemory(botId) { this.store.data.aiMem[botId || '_fleet'] = { notes: [], chat: [] }; this.pending.delete(botId); this.store.save(); }

  async analyze(botId) {
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: this.context(botId) + '\n\nAnalyze the bot health. Reply in Bengali with: 1) what is happening, 2) most likely cause, 3) concrete next steps. Max 8 lines.' },
    ];
    return this.complete(messages, { max_tokens: 700 });
  }
}


const SYSTEM_W = `You are "MC Host Worker Assistant", an expert in a Cloudflare-Workers-like runtime embedded in a hosting panel. Reply in the same language as the user (usually Bengali), concise and practical.

Runtime facts:
- A Worker is a project with MULTIPLE FILES in one folder. Entry file (default worker.js) exports: export default { async fetch(request, env, ctx) {...}, async scheduled(event, env, ctx) {...} }. addEventListener('fetch') and CommonJS (module.exports) also work.
- Files can import each other with relative ESM paths including extension: import { x } from './lib/utils.js'. JSON can be read with fs. No npm install is possible; only Node built-ins and Web APIs (fetch, Request, Response, Headers, URL, crypto, TextEncoder...).
- env contains the user's environment variables (env.KEY, also process.env.KEY and globals), env.KV (get/put/delete/list persistent store), env.ASSETS.fetch(request) serving static files from the public/, static/ or assets/ folder. A .env file in the project is also loaded.
- The public URL is /w/<slug>/... and the path your code sees has that prefix removed.
- Never print or invent secret values. Refer to env by name only.

When you create or change files, output EACH changed or new file COMPLETELY (never partial) in this exact format, one block per file:
\`\`\`file:path/relative/to/project.js
<full file content>
\`\`\`
Explain briefly before the blocks (2-5 lines). Only include files that actually change. If the user only asks a question, answer without file blocks.`;

Ai.prototype.workerContext = function (workers, w) {
  const files = workers.listFiles(w.id);
  const entry = workers.entryOf(w);
  const v = workers.view(w);
  const rt = workers._rt(w.id);
  const err = workers.recent(w.id).filter((r) => r.status >= 500).slice(0, 5).map((r) => `${r.method} ${r.path} -> ${r.status} ${r.err || ''}`).join('\n');
  let budget = 14000; const parts = [];
  const order = [...files].sort((a, b) => (b.path === entry) - (a.path === entry) || a.size - b.size);
  for (const f of order) {
    if (budget <= 0) { parts.push(`--- ${f.path} (${f.size}B, বাদ: কনটেক্সট সীমা)`); continue; }
    let r; try { r = workers.readFile(w.id, f.path); } catch { continue; }
    if (!r.text) { parts.push(`--- ${f.path} (${f.size}B, বাইনারি/বড়)`); continue; }
    const t = r.text.slice(0, Math.min(budget, 6000)); budget -= t.length;
    parts.push(`--- ${f.path}${t.length < r.text.length ? ' (কাটা)' : ''}\n${t}`);
  }
  const notes = this.store.mem('w:' + w.id).notes.map((n) => '- ' + n).join('\n');
  return [
    `Worker: ${w.name} | slug=${w.slug} | entry=${entry} | state=${v.state} | files=${files.length} | cron=${w.cronMin || 0}m | rateLimit=${w.rateLimit || 0}/min`,
    `ENV keys: ${(w.env || []).map((e) => e.key + (e.secret ? '(secret)' : '')).join(', ') || '(none)'}`,
    v.error ? `Current error: ${v.error.slice(0, 500)}` : 'Current error: none',
    `Recent 5xx:\n${err || '(none)'}`,
    `Recent logs:\n${workers.logs(w.id).slice(-25).join('\n') || '(empty)'}`,
    `Memory notes:\n${notes || '(none)'}`,
    `Project files:\n${parts.join('\n')}`,
  ].join('\n');
};

Ai.parseFiles = function (text) {
  const out = []; const re = /```file:([^\n`]+)\n([\s\S]*?)```/g; let m;
  while ((m = re.exec(String(text)))) out.push({ path: m[1].trim(), content: m[2].replace(/\n$/, '') });
  return out;
};

Ai.cleanHist = (arr) => arr.slice(-12).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));

Ai.prototype.chatWorker = async function (workers, w, text, clientHistory) {
  const mem = this.store.mem('w:' + w.id);
  const local = Array.isArray(clientHistory);
  const messages = [
    { role: 'system', content: SYSTEM_W + '\n\n' + this.workerContext(workers, w) },
    ...(local ? Ai.cleanHist(clientHistory).slice(-10) : mem.chat.slice(-10)),
    { role: 'user', content: String(text).slice(0, 4000) },
  ];
  const reply = await this.complete(messages, { max_tokens: 6000 });
  const blocks = Ai.parseFiles(reply);
  const existing = new Set(workers.listFiles(w.id).map((f) => f.path));
  const changes = [];
  for (const b of blocks.slice(0, 20)) {
    let p; try { p = workers.safeRel(b.path); } catch (e) { changes.push({ path: b.path, content: '', error: e.message, isNew: true }); continue; }
    changes.push({ path: p, content: b.content, isNew: !existing.has(p), error: workers.syntaxCheck(p, b.content), size: Buffer.byteLength(b.content) });
  }
  const shown = reply.replace(/```file:([^\n`]+)\n[\s\S]*?```/g, (_, p) => `[ফাইল: ${p.trim()}]`);
  if (!local) {
    mem.chat.push({ role: 'user', content: String(text).slice(0, 1500) }, { role: 'assistant', content: shown.slice(0, 1500) });
    if (mem.chat.length > 30) await this._compact(mem).catch(() => {});
    this.store.save();
  }
  const good = changes.filter((c) => !c.error);
  if (good.length) this.pendingW.set(w.id, good); else this.pendingW.delete(w.id);
  return { reply: shown, changes };
};
Ai.prototype.takePendingW = function (id) { const c = this.pendingW.get(id); this.pendingW.delete(id); return c || []; };

module.exports = Ai;
module.exports.FALLBACK_MODELS = FALLBACK_MODELS;
