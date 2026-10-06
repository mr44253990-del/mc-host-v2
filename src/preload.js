'use strict';
// প্রতিটি মাইনক্রাফট বট প্রসেসে `node -r preload.js script.js` হিসেবে লোড হয়।
// কাজ: যেকোনো mineflayer স্ক্রিপ্টের স্ট্যাটাস ম্যানেজারকে জানানো + কানেকশন কাটলে প্রসেস বন্ধ করা
// (ম্যানেজার তখন অটো-রিকানেক্ট করে)। ইউজারের স্ক্রিপ্টে আলাদা কিছু লিখতে হয় না।
const Module = require('module');

const send = (m) => { try { if (process.connected) process.send(m); } catch { /* ignore */ } };

function flat(x, depth = 0) {
  if (x == null || depth > 6) return '';
  if (typeof x === 'string') {
    try { const j = JSON.parse(x); if (j && typeof j === 'object') return flat(j, depth + 1); } catch { /* plain text */ }
    return x;
  }
  if (Array.isArray(x)) return x.map((i) => flat(i, depth + 1)).join('');
  if (typeof x === 'object') {
    if (typeof x.toString === 'function' && x.toString !== Object.prototype.toString) {
      const s = String(x); if (s && s !== '[object Object]') return s;
    }
    const v = x.value !== undefined && typeof x.value === 'object' ? x.value : x;
    return [v.text, v.translate, v.extra, v.with].map((p) => flat(p, depth + 1)).filter(Boolean).join(' ');
  }
  return String(x);
}

let createCount = 0;
let current = null;

function snapshot(bot) {
  try {
    const p = bot.entity && bot.entity.position;
    return {
      username: bot.username,
      version: bot.version,
      health: bot.health,
      food: bot.food,
      mem: Math.round(process.memoryUsage().rss / 1048576),
      pos: p ? [p.x, p.y, p.z].map((n) => Math.round(n)) : null,
      players: Object.keys(bot.players || {}).length,
      ping: bot.player && bot.player.ping,
      dimension: bot.game && bot.game.dimension,
      mode: bot.game && bot.game.gameMode,
    };
  } catch { return {}; }
}

function attach(bot) {
  let timer = null;
  current = bot;
  const push = () => send({ t: 'info', info: snapshot(bot) });
  bot.on('spawn', () => {
    send({ t: 'state', state: 'online' });
    push();
    if (!timer) timer = setInterval(push, 10000);
  });
  bot.on('kicked', (reason) => send({ t: 'kick', reason: flat(reason).slice(0, 300) }));
  bot.on('error', (err) => send({ t: 'error', message: String((err && err.message) || err).slice(0, 300), code: err && err.code }));
  bot.once('end', (reason) => {
    clearInterval(timer);
    send({ t: 'state', state: 'offline', reason: String(reason || '') });
    const seen = createCount;
    // স্ক্রিপ্ট নিজে ৮ সেকেন্ডের মধ্যে নতুন বট না বানালে প্রসেস বন্ধ → ম্যানেজার রিকানেক্ট করবে
    setTimeout(() => { if (createCount === seen) process.exit(3); }, 8000);
  });
}

function hook(mf) {
  if (!mf || mf.__mchost || typeof mf.createBot !== 'function') return mf;
  const orig = mf.createBot;
  try {
    mf.createBot = function (...args) {
      createCount++;
      send({ t: 'state', state: 'connecting' });
      const bot = orig.apply(this, args);
      attach(bot);
      return bot;
    };
    Object.defineProperty(mf, '__mchost', { value: true });
  } catch { /* frozen export — skip */ }
  return mf;
}

const origLoad = Module._load;
Module._load = function (request) {
  const exp = origLoad.apply(this, arguments);
  return request === 'mineflayer' ? hook(exp) : exp;
};

process.on('uncaughtException', (e) => {
  send({ t: 'error', message: String((e && (e.stack || e.message)) || e).slice(0, 500), code: e && e.code, fatal: true });
  setTimeout(() => process.exit(1), 300);
});
process.on('unhandledRejection', (e) => send({ t: 'error', message: String((e && e.message) || e).slice(0, 300) }));

// ম্যানেজার থেকে কমান্ড: চ্যাট পাঠানো
process.on('message', (m) => {
  if (m && m.t === 'chat' && current && typeof m.text === 'string') {
    try { current.chat(m.text.slice(0, 250)); } catch { /* ignore */ }
  }
});
