'use strict';
// প্রতিটি Worker আলাদা প্রসেসে চলে (Cloudflare Workers-এর মতো fetch হ্যান্ডলার)।
// সমর্থিত: export default { fetch, scheduled }  অথবা  addEventListener('fetch', ...)
const fs = require('fs');
const { pathToFileURL } = require('url');
const { createRequire } = require('module');

const cfg = JSON.parse(process.env.WK_CONFIG || '{}');
const send = (m) => { try { if (process.connected) process.send(m); } catch { /* ignore */ } };
const MAX_RES = 5 * 1024 * 1024;

if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
globalThis.require = createRequire(cfg.file);

// ---------- KV (সরল, ফাইল-ভিত্তিক) ----------
class KV {
  constructor(file) {
    this.file = file; this.dirty = false; this.m = new Map();
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) this.m.set(k, v); } catch { /* new */ }
    this.t = setInterval(() => this.flush(), 2000);
    this.t.unref();
  }
  _live(k) { const e = this.m.get(k); if (!e) return null; if (e.x && e.x < Date.now()) { this.m.delete(k); this.dirty = true; return null; } return e; }
  async get(key, opts) {
    const e = this._live(String(key)); if (!e) return null;
    const type = typeof opts === 'string' ? opts : (opts && opts.type) || 'text';
    if (type === 'json') return JSON.parse(e.v);
    if (type === 'arrayBuffer') return new TextEncoder().encode(e.v).buffer;
    return e.v;
  }
  async put(key, value, opts = {}) {
    let v = value;
    if (typeof v !== 'string') v = v instanceof ArrayBuffer ? Buffer.from(v).toString('utf8') : ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8') : String(v);
    if (v.length > 1024 * 1024) throw new Error('KV value 1MB এর বেশি');
    if (!this.m.has(String(key)) && this.m.size >= 5000) throw new Error('KV সর্বোচ্চ ৫০০০ key');
    const x = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : opts.expiration ? opts.expiration * 1000 : 0;
    this.m.set(String(key), { v, x }); this.dirty = true;
  }
  async delete(key) { this.dirty = this.m.delete(String(key)) || this.dirty; }
  async list(o = {}) {
    const p = o.prefix || '', lim = Math.min(1000, o.limit || 1000);
    const keys = [];
    for (const k of [...this.m.keys()].sort()) if (k.startsWith(p) && this._live(k)) { keys.push({ name: k }); if (keys.length >= lim) break; }
    return { keys, list_complete: true };
  }
  flush() {
    if (!this.dirty) return;
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(Object.fromEntries(this.m))); fs.renameSync(this.file + '.tmp', this.file); this.dirty = false; send({ t: 'kv', n: this.m.size }); } catch { /* ignore */ }
  }
}
const kv = new KV(cfg.kv);

// ---------- env / globals ----------
const env = { ...(cfg.env || {}), KV: kv };
for (const [k, v] of Object.entries(cfg.env || {})) { process.env[k] = v; globalThis[k] = v; }
globalThis.KV = kv;

const listeners = { fetch: [], scheduled: [] };
globalThis.addEventListener = (type, fn) => { if (listeners[type]) listeners[type].push(fn); };

let fetchFn = null, schedFn = null;
const mkCtx = () => { const w = []; return { w, ctx: { waitUntil: (p) => { w.push(Promise.resolve(p).catch((e) => console.error('waitUntil:', e && e.message))); }, passThroughOnException() {} } }; };

async function load() {
  let mod;
  try { mod = await import(pathToFileURL(cfg.file).href); } catch (e) {
    if (e instanceof ReferenceError && /module|exports/.test(e.message)) { // CommonJS স্টাইল
      const cjs = cfg.file.replace(/\.mjs$/, '.cjs'); fs.copyFileSync(cfg.file, cjs); mod = require(cjs);
    } else throw e;
  }
  const def = mod.default || mod;
  if (def && typeof def.fetch === 'function') fetchFn = (req, ctx) => def.fetch(req, env, ctx);
  else if (listeners.fetch.length) fetchFn = null;
  else throw new Error('Worker-এ `export default { fetch(request, env, ctx) {...} }` অথবা addEventListener("fetch", ...) পাওয়া যায়নি');
  if (def && typeof def.scheduled === 'function') schedFn = (ev, ctx) => def.scheduled(ev, env, ctx);
  else if (listeners.scheduled.length) schedFn = (ev, ctx) => listeners.scheduled.forEach((f) => f({ ...ev, waitUntil: ctx.waitUntil }));
}

async function runFetch(request, ctx) {
  if (fetchFn) return fetchFn(request, ctx);
  return new Promise((resolve, reject) => {
    let done = false;
    const ev = { request, respondWith: (p) => { done = true; resolve(p); }, waitUntil: ctx.waitUntil, passThroughOnException() {} };
    try { listeners.fetch.forEach((f) => f(ev)); } catch (e) { return reject(e); }
    if (!done) reject(new Error('fetch listener respondWith() কল করেনি'));
  });
}

async function onReq(m) {
  const { w, ctx } = mkCtx();
  try {
    const init = { method: m.method, headers: m.headers };
    if (m.body && !['GET', 'HEAD'].includes(m.method)) init.body = Buffer.from(m.body, 'base64');
    const resp = await runFetch(new Request(m.url, init), ctx);
    if (!(resp instanceof Response)) throw new TypeError('fetch হ্যান্ডলার Response ফেরত দেয়নি');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_RES) throw new Error('Response ৫MB এর বেশি');
    const headers = [];
    resp.headers.forEach((v, k) => { if (k !== 'set-cookie') headers.push([k, v]); });
    const sc = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
    for (const c of sc) headers.push(['set-cookie', c]);
    send({ t: 'res', id: m.id, status: resp.status, headers, body: buf.toString('base64') });
  } catch (e) {
    send({ t: 'res', id: m.id, error: String((e && e.stack) || e).slice(0, 2000) });
  }
  Promise.all(w).catch(() => {});
}

process.on('message', async (m) => {
  if (!m) return;
  if (m.t === 'req') return onReq(m);
  if (m.t === 'cron' && schedFn) {
    const { w, ctx } = mkCtx();
    try { await schedFn({ type: 'scheduled', scheduledTime: Date.now(), cron: m.cron || '' }, ctx); await Promise.all(w); } catch (e) { console.error('scheduled ত্রুটি:', (e && e.stack) || e); }
  }
  if (m.t === 'shutdown') { kv.flush(); process.exit(0); }
});
process.on('SIGTERM', () => { kv.flush(); process.exit(0); });
process.on('uncaughtException', (e) => console.error('uncaughtException:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', (e && e.stack) || e));
setInterval(() => send({ t: 'hb' }), 5000);

load().then(() => send({ t: 'ready', kv: kv.m.size })).catch((e) => { send({ t: 'fatal', message: String((e && e.stack) || e).slice(0, 2000) }); setTimeout(() => process.exit(1), 200); });
