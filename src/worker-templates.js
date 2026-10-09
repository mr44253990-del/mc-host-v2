'use strict';
module.exports = [
  {
    key: 'hello', name: 'Hello World', desc: 'সবচেয়ে সহজ Worker',
    code: `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    return new Response('Hello from MC Host Worker!\\nPath: ' + url.pathname + '\\nMethod: ' + request.method, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
`,
  },
  {
    key: 'json-api', name: 'JSON API', desc: 'রাউটিং, JSON, ENV ব্যবহার',
    code: `// ENV: GREETING (ঐচ্ছিক)
const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    if (url.pathname === '/') return json({ ok: true, message: env.GREETING || 'Hello', time: new Date().toISOString() });
    if (url.pathname === '/echo') {
      const body = request.method === 'POST' ? await request.text() : null;
      return json({ method: request.method, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(request.headers), body });
    }
    return json({ ok: false, error: 'Not found' }, 404);
  },
};
`,
  },
  {
    key: 'kv-counter', name: 'KV ভিজিটর কাউন্টার', desc: 'env.KV দিয়ে স্থায়ী ডাটা, scheduled উদাহরণসহ',
    code: `export default {
  async fetch(request, env) {
    const n = Number((await env.KV.get('visits')) || 0) + 1;
    await env.KV.put('visits', String(n));
    return new Response('ভিজিট নম্বর: ' + n, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
  // সেটিংসে Cron মিনিট দিলে এটি নির্দিষ্ট সময় পরপর চলে
  async scheduled(event, env) {
    console.log('scheduled চলেছে, ভিজিট =', await env.KV.get('visits'));
  },
};
`,
  },
  {
    key: 'proxy', name: 'রিভার্স প্রক্সি (CORS)', desc: 'ENV: TARGET_URL এ ফরওয়ার্ড করে CORS যোগ করে',
    code: `// ENV: TARGET_URL = https://api.example.com
export default {
  async fetch(request, env) {
    if (!env.TARGET_URL) return new Response('TARGET_URL ENV সেট করুন', { status: 500 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const u = new URL(request.url);
    const target = new URL(u.pathname + u.search, env.TARGET_URL);
    const headers = new Headers(request.headers);
    headers.delete('host');
    const upstream = await fetch(target, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer() });
    const out = new Response(upstream.body, upstream);
    out.headers.set('access-control-allow-origin', '*');
    return out;
  },
};
`,
  },
];
