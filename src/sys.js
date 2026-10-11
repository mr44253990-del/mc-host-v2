'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

let last = Date.now(); const lags = [];
const t = setInterval(() => { const now = Date.now(); lags.push(Math.max(0, now - last - 1000)); if (lags.length > 10) lags.shift(); last = now; }, 1000);
t.unref();
const lag = () => Math.max(0, ...lags);

const cache = { t: 0, v: 0 };
function dirSize(dir, budget = { n: 20000 }) {
  let s = 0;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    if (budget.n-- <= 0) break;
    const p = path.join(dir, e.name);
    try { s += e.isDirectory() ? dirSize(p, budget) : fs.statSync(p).size; } catch { /* skip */ }
  }
  return s;
}
const disk = (dir) => { if (Date.now() - cache.t > 60000) { cache.v = dirSize(dir); cache.t = Date.now(); } return cache.v; };

function info(store, runner, workers) {
  const mu = process.memoryUsage();
  const running = workers ? workers.all().filter((w) => workers._rt(w.id).state === 'running').length : 0;
  return {
    load: os.loadavg().map((x) => Math.round(x * 100) / 100), cpus: os.cpus().length,
    totalMem: Math.round(os.totalmem() / 1048576), freeMem: Math.round(os.freemem() / 1048576),
    rss: Math.round(mu.rss / 1048576), heap: Math.round(mu.heapUsed / 1048576),
    lag: lag(), disk: Math.round(disk(store.dir) / 1048576 * 10) / 10,
    uptime: Math.round(process.uptime() * 1000), node: process.version,
    procs: { bots: runner.fleet().online, workers: running },
  };
}

module.exports = { info, lag };
