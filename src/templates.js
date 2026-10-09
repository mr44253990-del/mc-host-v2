'use strict';
// দ্রুত শুরুর স্ক্রিপ্ট টেমপ্লেট (রিকানেক্ট হোস্ট নিজেই সামলায়)
const HEAD = `const mineflayer = require('mineflayer');
const bot = mineflayer.createBot({
  host: process.env.MC_HOST,
  port: Number(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME || 'HostBot',
  version: process.env.MC_VERSION || false,
  auth: 'offline',
});
const rand = (a, b) => a + Math.random() * (b - a);
`;

module.exports = [
  { key: 'default', name: 'এলোমেলো হাঁটা (ডিফল্ট)', desc: 'হাঁটা, লাফ, ঘোরা: AFK কিক এড়ায়', code: null },
  {
    key: 'stand', name: 'স্থির দাঁড়িয়ে থাকা', desc: 'নড়ে না, শুধু মাঝে মাঝে ছোট লাফ',
    code: HEAD + `bot.once('spawn', () => {
  setInterval(() => { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 250); }, rand(45000, 90000));
  setInterval(() => bot.look(rand(0, Math.PI * 2), rand(-0.4, 0.4)), 15000);
});
`,
  },
  {
    key: 'greeter', name: 'চ্যাট গ্রিটার', desc: 'কেউ hi/hello বললে উত্তর দেয়, জয়েন করলে স্বাগত জানায়',
    code: HEAD + `const GREET = ['hello!', 'hi there', 'welcome!'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
bot.on('chat', (user, msg) => {
  if (user === bot.username) return;
  if (/\\b(hi|hello|hey)\\b/i.test(msg)) setTimeout(() => bot.chat(pick(GREET) + ' ' + user), rand(800, 2000));
});
bot.on('playerJoined', (p) => { if (p.username !== bot.username) setTimeout(() => bot.chat('welcome ' + p.username), rand(1500, 3000)); });
bot.once('spawn', () => setInterval(() => { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 250); }, rand(60000, 120000)));
`,
  },
  {
    key: 'guard', name: 'নিকটতম খেলোয়াড়ের দিকে তাকানো', desc: 'কাছের প্লেয়ারের দিকে মাথা ঘোরায়, AFK মনে হয় না',
    code: HEAD + `bot.once('spawn', () => {
  setInterval(() => {
    const e = bot.nearestEntity((x) => x.type === 'player' && x.username !== bot.username);
    if (e) bot.lookAt(e.position.offset(0, e.height, 0));
    else bot.look(rand(0, Math.PI * 2), 0);
  }, 700);
});
`,
  },
];
