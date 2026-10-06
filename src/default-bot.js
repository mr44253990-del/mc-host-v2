// ═══════════════════════════════════════════════════════════
//  ডিফল্ট Minecraft বট (mineflayer) — হাঁটা, লাফ, ঘোরা, এলোমেলো কাজ
//  এই কোড আপনি নিজের মতো বদলাতে পারবেন (টেলিগ্রাম: বট > স্ক্রিপ্ট > এডিট, অথবা AI সহায়ককে বলুন)
//
//  হোস্ট সিস্টেম এই environment ভ্যারিয়েবলগুলো নিজেই দেয়:
//    MC_HOST, MC_PORT, MC_USERNAME, MC_VERSION (ফাঁকা = অটো ডিটেক্ট), MC_AUTH
//
//  রিকানেক্ট নিয়ে ভাবতে হবে না: কানেকশন কাটলে প্রসেস বন্ধ হয়ে হোস্ট আবার চালু করে দেয়।
// ═══════════════════════════════════════════════════════════
const mineflayer = require('mineflayer');

// ── সেটিংস (এখানে বদলান) ───────────────────────────────────
const CONFIG = {
  actionDelay: [3000, 9000],   // দুটি কাজের মাঝের বিরতি (মিলিসেকেন্ড, min/max)
  moveRadius: 12,              // শুরুর জায়গা থেকে এত ব্লকের বেশি দূরে গেলে ফিরে আসবে
  jumpChance: 0.35,            // হাঁটার সময় লাফ দেওয়ার সম্ভাবনা (০–১)
  sprintChance: 0.25,          // দৌড়ানোর সম্ভাবনা
  chat: false,                 // true করলে মাঝেমধ্যে চ্যাটে মেসেজ দেবে
  chatEvery: [120000, 300000], // চ্যাটের বিরতি (মিলিসেকেন্ড)
  messages: ['hello!', 'afk-bot here', 'good vibes'],
};

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bot = mineflayer.createBot({
  host: process.env.MC_HOST,
  port: Number(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME || 'HostBot',
  version: process.env.MC_VERSION || undefined,
  auth: process.env.MC_AUTH || 'offline',
  checkTimeoutInterval: 60 * 1000,
});

let origin = null;
let alive = true;

bot.once('spawn', () => {
  origin = bot.entity.position.clone();
  console.log(`[bot] spawn @ ${origin.x | 0}, ${origin.y | 0}, ${origin.z | 0} (v${bot.version})`);
  loopActions();
  if (CONFIG.chat) loopChat();
});

bot.on('death', () => console.log('[bot] মারা গেছে — অটো রেসপন'));
bot.on('kicked', (r) => console.log('[bot] kicked:', typeof r === 'string' ? r : JSON.stringify(r)));
bot.on('error', (e) => console.log('[bot] error:', e.message));
bot.once('end', (reason) => {
  alive = false;
  console.log('[bot] end:', reason);
  process.exit(2); // হোস্ট এটা দেখে অটো-রিকানেক্ট করবে
});

function stopMoving() {
  for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) bot.setControlState(k, false);
}

function lookToward(target) {
  const p = bot.entity.position;
  const yaw = Math.atan2(-(target.x - p.x), -(target.z - p.z));
  return bot.look(yaw, 0, true);
}

// ── কাজের তালিকা: নতুন কাজ যোগ করতে এখানে ফাংশন বানিয়ে ACTIONS-এ বসান ──
const ACTIONS = {
  async walk() {
    await bot.look(rand(-Math.PI, Math.PI), rand(-0.2, 0.2), true);
    bot.setControlState('forward', true);
    if (Math.random() < CONFIG.sprintChance) bot.setControlState('sprint', true);
    const until = Date.now() + rand(1200, 3500);
    while (alive && Date.now() < until) {
      if (Math.random() < CONFIG.jumpChance) { bot.setControlState('jump', true); await sleep(250); bot.setControlState('jump', false); }
      await sleep(350);
    }
    stopMoving();
  },
  async strafe() {
    const dir = pick(['left', 'right', 'back']);
    bot.setControlState(dir, true);
    await sleep(rand(500, 1500));
    stopMoving();
  },
  async jump() {
    bot.setControlState('jump', true);
    await sleep(300);
    bot.setControlState('jump', false);
  },
  async lookAround() {
    for (let i = 0; i < 3; i++) { await bot.look(rand(-Math.PI, Math.PI), rand(-0.6, 0.6), false); await sleep(rand(300, 900)); }
  },
  async swing() { bot.swingArm('right'); await sleep(400); bot.swingArm('left'); },
  async crouch() { bot.setControlState('sneak', true); await sleep(rand(800, 2000)); bot.setControlState('sneak', false); },
};

async function loopActions() {
  while (alive) {
    try {
      await sleep(rand(...CONFIG.actionDelay));
      if (!bot.entity) continue;
      // বেশি দূরে চলে গেলে ফিরে আসা
      if (origin && bot.entity.position.distanceTo(origin) > CONFIG.moveRadius) {
        await lookToward(origin);
        bot.setControlState('forward', true);
        await sleep(2500);
        stopMoving();
        continue;
      }
      await pick(Object.values(ACTIONS))();
    } catch (e) {
      console.log('[bot] action error:', e.message);
      stopMoving();
    }
  }
}

async function loopChat() {
  while (alive) {
    await sleep(rand(...CONFIG.chatEvery));
    if (alive && bot.entity) bot.chat(pick(CONFIG.messages));
  }
}
