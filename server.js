// AasthiChain app server — thin adapter over the Vercel serverless handler.
//
// Step 1 of docs/ONE-API.md. The repo has carried two hand-maintained
// implementations of the same 82 routes: this file's upstream
// (frontend/api/index.js, what production actually serves) and
// mock-api-server.js (what every local test exercises). They drift, in both
// directions, and four defects have been traced to it.
//
// This process serves the frontend, proxies the one route lambdas cannot do
// (SSE), and hands everything else to the serverless handler — so the code
// under test is the code that ships. mock-api-server.js is untouched and
// still the default; run this one with:
//
//   UMI_GATEWAY_URL=http://localhost:21100 PORT=8081 node server.js
//
// The handler is ESM (frontend/package.json is type:module) and this file is
// CJS, hence the dynamic import.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DIST = path.join(__dirname, 'frontend', 'dist');
const UMI_GATEWAY_URL = (process.env.UMI_GATEWAY_URL || 'http://localhost:21100').replace(/\/$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Read the whole request body. Vercel hands the handler a parsed `req.body`,
// so we reproduce that: JSON and form bodies become objects, anything else
// stays a string. The raw bytes are kept so the few spots that re-read the
// stream themselves (parsePayUParams) still work after we have drained it.
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function parseBody(raw, contentType) {
  const text = raw.toString('utf8');
  if (!text) return undefined;
  const ct = String(contentType || '');
  if (ct.includes('application/json')) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const out = {};
    for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    return out;
  }
  // No content-type (curl -d without a header, some webhooks): try JSON anyway.
  try { return JSON.parse(text); } catch { return text; }
}

// Replay the drained body to anything that attaches its own stream listeners
// after the handler has started.
function makeReplayable(req, raw) {
  const realOn = req.on.bind(req);
  req.on = function (event, cb) {
    if (event === 'data') {
      if (raw.length) setImmediate(() => cb(raw));
      return req;
    }
    if (event === 'end') {
      setImmediate(() => cb());
      return req;
    }
    if (event === 'error') return req;
    return realOn(event, cb);
  };
}

// The handler only ever calls res.status(), res.json() and res.setHeader().
function decorate(res) {
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (payload) {
    const body = JSON.stringify(payload);
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(body);
    return res;
  };
  res.send = function (payload) {
    if (payload === undefined || payload === null) return res.end();
    if (Buffer.isBuffer(payload) || typeof payload === 'string') { res.end(payload); return res; }
    return res.json(payload);
  };
  return res;
}

function serveStatic(req, res, pathname) {
  // Never serve outside dist.
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  // The build prerenders a head-per-route at dist/<route>/index.html. Vercel
  // serves those automatically; do the same here so local and production
  // return the same HTML for the same URL.
  if (stat.isDirectory()) {
    const nested = path.join(file, 'index.html');
    try {
      const s2 = fs.statSync(nested);
      if (!s2.isFile()) return false;
      return sendFile(req, res, nested, s2);
    } catch { return false; }
  }
  if (!stat.isFile()) return false;
  return sendFile(req, res, file, stat);
}

function sendFile(req, res, file, stat) {
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveIndex(res) {
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) {
    const body = fs.readFileSync(index);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(body);
    return;
  }
  res.statusCode = 503;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<h1>AasthiChain</h1><p>Frontend dist not found at ${DIST} — run <code>cd frontend && npm run build</code></p>`);
}

// Server-sent events. Lambdas cannot hold a connection open, which is why the
// serverless handler has no equivalent and the frontend falls back to polling
// in production (frontend/src/lib/useLedgerStream.js).
async function proxyEvents(req, res) {
  let upstream;
  try {
    upstream = await fetch(UMI_GATEWAY_URL + '/drunix/events', { headers: { Accept: 'text/event-stream' } });
  } catch (e) {
    return decorate(res).status(503).json({ error: 'ERR_UMI_RAIL_UNAVAILABLE', message: e.message });
  }
  if (!upstream.ok || !upstream.body) {
    return decorate(res).status(502).json({ error: 'ERR_UMI_STREAM_FAILED', upstreamStatus: upstream.status });
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const reader = upstream.body.getReader();
  req.on('close', () => { try { reader.cancel(); } catch { /* already gone */ } });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch { /* client hung up mid-stream */ }
  res.end();
}

async function main() {
  const mod = await import('./frontend/api/index.js');
  const handler = mod.default;

  const server = http.createServer(async (req, res) => {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch {
      return decorate(res).status(400).json({ error: 'ERR_BAD_URL' });
    }
    const pathname = parsed.pathname;

    if (pathname === '/api/umi/events') return proxyEvents(req, res);

    if (!pathname.startsWith('/api/')) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname !== '/' && serveStatic(req, res, pathname)) return;
        return serveIndex(res); // SPA fallback
      }
    }

    const raw = await readBody(req);
    req.body = parseBody(raw, req.headers['content-type']);
    makeReplayable(req, raw);
    req.query = Object.fromEntries(parsed.searchParams.entries());
    decorate(res);

    try {
      await handler(req, res);
    } catch (e) {
      console.error(`[server] ${req.method} ${pathname} threw:`, e);
      if (!res.headersSent) res.status(500).json({ error: 'ERR_INTERNAL', message: e.message });
      else res.end();
    }
    if (!res.writableEnded) res.end(); // handler returned without responding
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`AasthiChain app server on :${PORT} — serverless handler (frontend/api/index.js) + static ${DIST}`);
    console.log(`UMI rail: ${UMI_GATEWAY_URL} | SSE /api/umi/events proxied here (lambdas cannot stream)`);
  });
}

main().catch((e) => { console.error('[server] failed to start:', e); process.exit(1); });
