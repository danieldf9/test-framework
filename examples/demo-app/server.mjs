import http from 'node:http';
import { PROFILES } from './profiles.mjs';
import { renderCheckout, renderProducts } from './render.mjs';

const PORT = Number(process.env.DEMO_PORT || 4173);
let currentProfile = process.env.CHAOS_PROFILE || 'baseline';

if (!PROFILES[currentProfile]) {
  console.error(`Unknown profile "${currentProfile}". Known: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Chaos-harness control endpoint: switch the DOM mutation profile at runtime.
  if (url.pathname === '/__chaos') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const { profile } = JSON.parse(body || '{}');
          if (!PROFILES[profile]) throw new Error(`unknown profile: ${profile}`);
          currentProfile = profile;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, profile: currentProfile }));
          console.log(`[demo-app] chaos profile → ${currentProfile}`);
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err.message) }));
        }
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ profile: currentProfile }));
    return;
  }

  const profile = PROFILES[currentProfile];
  if (url.pathname === '/' || url.pathname === '/products') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderProducts(profile));
    return;
  }
  if (url.pathname === '/checkout') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderCheckout(profile));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[demo-app] serving profile "${currentProfile}" on http://127.0.0.1:${PORT}`);
});
