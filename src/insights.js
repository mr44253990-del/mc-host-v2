'use strict';
// স্মার্ট ইনসাইট: বট, Worker ও হোস্টের অবস্থা দেখে করণীয় সাজেশন তৈরি করে
const { diagnose, fmtDur } = require('./util');

const SEV = { bad: 0, warn: 1, info: 2, good: 3 };

function build({ store, runner, workers, sys, tzMin = 0, extra = {} }) {
  const out = [];
  const add = (level, title, text, action) => out.push({ level, title, text, action: action || null });

  for (const b of store.data.bots) {
    const s = runner.snapshot(b.id);
    const name = b.username;
    const go = { label: 'বট খুলুন', page: 'bots', id: b.id };
    if (s.state !== 'online' && b.desired) {
      const d = s.diag || (s.reason ? diagnose(s.reason) : null);
      add(s.attempts >= 5 ? 'bad' : 'warn', `${name} অফলাইন`, d ? `${d.title}। ${d.hint}` : 'সংযোগ হচ্ছে না। লগ দেখুন।', go);
    }
    if (s.stats && s.stats.crashes >= 10) add('warn', `${name} বারবার ক্র্যাশ করছে`, `মোট ${s.stats.crashes}বার। সার্ভারের নিয়ম বা স্ক্রিপ্ট যাচাই করুন, দরকারে AI দিয়ে বিশ্লেষণ করুন।`, go);
    if (s.info && s.info.mem > 150) add('warn', `${name}-এর মেমরি সীমার কাছে`, `${s.info.mem}MB ব্যবহার হচ্ছে (সীমা ~192MB)। স্ক্রিপ্টে মেমরি লিক থাকতে পারে, অটো-রিস্টার্ট ঘণ্টা সেট করুন।`, go);
    if (s.state === 'online' && s.onlineSince && Date.now() - s.onlineSince > 86400000) add('good', `${name} স্থিতিশীল`, `টানা ${fmtDur(Date.now() - s.onlineSince)} অনলাইন।`, go);
  }

  for (const w of workers.all()) {
    const v = workers.view(w);
    const go = { label: 'Worker খুলুন', page: 'workers', id: w.id };
    const a = workers.agg([w.id], tzMin);
    const lat = workers.latency(w.id);
    if (v.state === 'error') add('bad', `Worker "${w.name}" ত্রুটিতে`, String(v.error || '').split('\n')[0].slice(0, 160) || 'চালু হচ্ছে না।', go);
    if (a.today.req >= 20 && a.today.err / a.today.req >= 0.05) add('warn', `"${w.name}"-এ ত্রুটির হার ${(a.today.err / a.today.req * 100).toFixed(1)}%`, `আজ ${a.today.req} রিকোয়েস্টের ${a.today.err}টি 5xx। লগ ও AI বিশ্লেষণ দেখুন।`, go);
    if (lat.n >= 20 && lat.p95 > 1000) add('warn', `"${w.name}" ধীর`, `p95 লেটেন্সি ${lat.p95}ms। ভারী কাজ বা বাইরের API ধীর কিনা দেখুন।`, go);
    if (a.inv.tmo > 0) add('warn', `"${w.name}"-এ টাইমআউট`, `গত ৩০ দিনে ${a.inv.tmo}টি রিকোয়েস্ট ৩০ সেকেন্ডে শেষ হয়নি।`, go);
    // পারফরম্যান্স বাজেট: সীমা পেরোলে সতর্কতা
    const bu = w.budget || {};
    if (bu.p95Ms && lat.n >= 20 && lat.p95 > bu.p95Ms) add('warn', `"${w.name}" বাজেট ছাড়িয়েছে (p95)`, `p95 ${lat.p95}ms, সীমা ${bu.p95Ms}ms।`, go);
    const errNow = a.today.req ? a.today.err / a.today.req * 100 : 0;
    if (bu.errPct && a.today.req >= 20 && errNow > bu.errPct) add('bad', `"${w.name}" ত্রুটির বাজেট ছাড়িয়েছে`, `আজ ${errNow.toFixed(1)}% ত্রুটি, সীমা ${bu.errPct}%।`, go);
    // একই ত্রুটি বারবার: ৩ বার বা বেশি একই বার্তা
    if (typeof workers.recent === 'function') {
      const sig = {};
      for (const r of workers.recent(w.id)) if (r.status >= 500 && r.err) { const k = r.err.slice(0, 80); sig[k] = (sig[k] || 0) + 1; }
      const top = Object.entries(sig).sort((x, y) => y[1] - x[1])[0];
      if (top && top[1] >= 3) add('warn', `"${w.name}"-এ একই ত্রুটি বারবার`, `"${top[0]}" — ${top[1]} বার। AI রিভিউ চালান বা লগ দেখুন।`, go);
    }
    // অস্বাভাবিক নীরবতা: আগে নিয়মিত ট্রাফিক ছিল, এখন গত ২ ঘণ্টায় একটিও নেই
    const hourAvg = a.d7.req / 168;
    const lastTwo = (a.hours || []).slice(-2).reduce((s, h) => s + h.req, 0);
    if (v.state === 'running' && hourAvg >= 2 && lastTwo === 0) add('warn', `"${w.name}" হঠাৎ নীরব`, `গত ২ ঘণ্টায় কোনো রিকোয়েস্ট নেই, অথচ গড়ে ঘণ্টায় ${hourAvg.toFixed(1)}টি আসে। ক্লায়েন্ট বা DNS ঠিক আছে কিনা দেখুন।`, go);
    // অস্বাভাবিক স্পাইক: শেষ ঘণ্টা স্বাভাবিকের ৫ গুণের বেশি (অন্তত ২০টি)
    const lastH = (a.hours || []).slice(-1)[0];
    if (lastH && lastH.req >= 20 && hourAvg > 0 && lastH.req > hourAvg * 5) add('info', `"${w.name}"-এ অস্বাভাবিক স্পাইক`, `শেষ ঘণ্টায় ${lastH.req}টি রিকোয়েস্ট, স্বাভাবিক গড় ${hourAvg.toFixed(1)}। বট/স্ক্যানার হতে পারে।`, go);
    const prev = (a.d7.req - a.today.req) / 6;
    if (a.today.req >= 50 && prev > 0 && a.today.req > prev * 3) add('info', `"${w.name}"-এ ট্রাফিক বেড়েছে`, `আজ ${a.today.req} রিকোয়েস্ট, আগের গড়ের ${(a.today.req / prev).toFixed(1)} গুণ।`, go);
    if (v.enabled && v.state === 'running' && a.d7.req === 0 && Date.now() - w.createdAt > 3 * 86400000) add('info', `"${w.name}" ৭ দিন ব্যবহার হয়নি`, 'দরকার না থাকলে বন্ধ করে রিসোর্স বাঁচান।', go);
  }

  if (sys) {
    if (sys.lag > 150) add('warn', 'সার্ভার ধীর (event loop lag)', `${sys.lag}ms দেরি। বট/Worker কমান বা বড় প্ল্যানে যান।`, { label: 'সেটিংস', page: 'set' });
    if (sys.totalMem && sys.rss / sys.totalMem > 0.7) add('warn', 'প্যানেলের মেমরি বেশি', `${sys.rss}MB / ${sys.totalMem}MB।`, null);
    if (sys.disk > 500) add('info', 'ডাটা ফোল্ডার বড়', `${sys.disk}MB। পুরনো Worker ফাইল বা ভার্সন মুছুন।`, null);
  }
  if (extra.renderLocal) add('warn', 'ডাটা হারাতে পারে', 'Render ফ্রি প্ল্যানে ফাইল রিস্টার্টে মুছে যায়। Upstash Redis ব্যাকআপ চালু করুন বা নিয়মিত ব্যাকআপ নামান।', { label: 'ব্যাকআপ', page: 'set' });
  if (extra.autoPassword) add('warn', 'অটো পাসওয়ার্ড ব্যবহার হচ্ছে', 'নিজের শক্ত পাসওয়ার্ড দিন (সেটিংস বা ADMIN_PASSWORD env)।', { label: 'সেটিংস', page: 'set' });
  if (extra.noAi) add('info', 'AI সহায়ক বন্ধ', 'Mistral API key দিলে স্ক্রিপ্ট ও Worker AI দিয়ে ঠিক করা যায়।', { label: 'সেটিংস', page: 'set' });
  if (extra.noTg) add('info', 'টেলিগ্রাম যুক্ত নেই', 'টেলিগ্রাম বট যোগ করলে ফোন থেকেই সব নিয়ন্ত্রণ ও সতর্কতা পাবেন।', { label: 'টেলিগ্রাম', page: 'tg' });

  const real = out.filter((x) => x.title);
  if (!real.some((x) => x.level === 'bad' || x.level === 'warn')) real.unshift({ level: 'good', title: 'সব ঠিক আছে', text: 'কোনো সমস্যা ধরা পড়েনি।', action: null });
  return real.sort((a, b) => SEV[a.level] - SEV[b.level]);
}

module.exports = { build };
