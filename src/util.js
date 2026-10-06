'use strict';
const crypto = require('crypto');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const genId = () => crypto.randomBytes(4).toString('hex');

function fmtDur(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = [];
  if (d) p.push(d + 'দিন');
  if (h) p.push(h + 'ঘ');
  if (m) p.push(m + 'মি');
  if (!d && !h) p.push(s + 'সে');
  return p.join(' ');
}

// "play.example.com", "play.example.com:25565", "minecraft://host:port"
function parseHost(input) {
  let s = String(input || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  let port = null;
  const m = s.match(/^(.+):(\d{1,5})$/);
  if (m) { s = m[1]; port = Number(m[2]); }
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(s)) return null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { host: s.toLowerCase(), port };
}

const validName = (n) => /^[A-Za-z0-9_]{3,16}$/.test(String(n || ''));

// [regex, title, hint, slow]  slow = আক্রমণাত্মকভাবে রিট্রাই না করে ধীরে চেষ্টা করবে
const RULES = [
  [/ECONNREFUSED/i, 'সার্ভার বন্ধ বা পোর্ট ভুল', 'সার্ভার চালু আছে কিনা এবং পোর্ট সঠিক কিনা দেখুন।', false],
  [/ENOTFOUND|EAI_AGAIN/i, 'হোস্টনেম খুঁজে পাওয়া যায়নি', 'সার্ভারের URL/IP ঠিকভাবে লিখেছেন কিনা দেখুন।', false],
  [/ETIMEDOUT|timed? ?out/i, 'সার্ভার সাড়া দিচ্ছে না', 'সার্ভার ঘুমিয়ে আছে বা ফায়ারওয়াল আটকাচ্ছে। সার্ভার চালু করুন।', false],
  [/ECONNRESET|socketClosed/i, 'কানেকশন কেটে গেছে', 'সার্ভার রিস্টার্ট হয়েছে বা অ্যান্টি-বট প্লাগিন আটকেছে। অটো-রিকানেক্ট চলছে।', false],
  [/whitelist/i, 'বট হোয়াইটলিস্টে নেই', 'সার্ভারে /whitelist add <বটের নাম> দিন।', true],
  [/banned/i, 'বট ব্যান করা হয়েছে', 'সার্ভারের ব্যান লিস্ট থেকে বটের নাম সরান বা নাম পাল্টান।', true],
  [/Failed to verify username|not authenticated|online-mode|unverified username|Invalid session/i, 'সার্ভার online-mode চালু', 'অফলাইন বট ঢুকতে পারবে না। server.properties-এ online-mode=false করুন।', true],
  [/outdated|incompatible|unsupported|protocol|version/i, 'ভার্সন মিলছে না', 'বটের সেটিংসে সার্ভারের ভার্সন দিন (যেমন 1.20.4)।', true],
  [/already connected|duplicate_login|logged in from another/i, 'এই নামে আগেই কেউ ঢুকে আছে', 'আগের সেশন বন্ধ হওয়া পর্যন্ত অপেক্ষা করুন বা নাম পাল্টান।', false],
  [/throttle/i, 'খুব ঘনঘন কানেক্ট করা হয়েছে', 'সার্ভার থ্রটল করছে। কিছুক্ষণ অপেক্ষা করলে ঠিক হবে।', true],
  [/full|server is full/i, 'সার্ভার ফুল', 'সার্ভারে জায়গা খালি হলে বট ঢুকবে।', false],
  [/kicked|flying|afk|idle/i, 'সার্ভার বটকে কিক করেছে', 'অ্যান্টি-AFK/অ্যান্টিচিট বা অ্যাডমিন কিক দিয়েছে।', false],
  [/Cannot find module/i, 'স্ক্রিপ্টের মডিউল ইন্সটল নেই', 'package.json-এ মডিউলটি যোগ করে আবার ডিপ্লয় করুন।', true],
  [/SyntaxError|ReferenceError|TypeError/i, 'স্ক্রিপ্টে ত্রুটি', 'স্ক্রিপ্ট এডিট করুন বা AI সহায়ককে ঠিক করতে বলুন।', true],
  [/heap out of memory|exit code 134|SIGKILL|SIGABRT/i, 'মেমরি শেষ', 'বট কমান বা বড় প্ল্যানে যান; স্ক্রিপ্টে মেমরি লিক আছে কিনা দেখুন।', false],
  [/watchdog/i, 'বট জমে গিয়েছিল', 'ওয়াচডগ প্রসেসটি রিস্টার্ট করেছে।', false],
];

function diagnose(reason) {
  const r = String(reason || '');
  for (const [re, title, hint, slow] of RULES) if (re.test(r)) return { title, hint, slow, key: title };
  return r ? { title: 'অজানা কারণ', hint: 'লগ দেখুন বা AI সহায়ককে জিজ্ঞেস করুন।', slow: false, key: 'অজানা কারণ' } : null;
}

module.exports = { esc, genId, fmtDur, parseHost, validName, diagnose };
