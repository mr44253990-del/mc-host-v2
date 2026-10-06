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
  constructor(store, runner) { this.store = store; this.runner = runner; this.pending = new Map(); }

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
  async chat(botId, text) {
    const mem = botId ? this.store.mem(botId) : this.store.mem('_fleet');
    const history = mem.chat.slice(-12);
    const messages = [
      { role: 'system', content: SYSTEM + '\n\n' + this.context(botId) },
      ...history,
      { role: 'user', content: String(text).slice(0, 4000) },
    ];
    const reply = await this.complete(messages);
    mem.chat.push({ role: 'user', content: String(text).slice(0, 1500) }, { role: 'assistant', content: reply.replace(/```[\s\S]*?```/g, '[code]').slice(0, 1500) });
    if (mem.chat.length > 30) await this._compact(mem).catch(() => {});
    this.store.save();

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

module.exports = Ai;
module.exports.FALLBACK_MODELS = FALLBACK_MODELS;
