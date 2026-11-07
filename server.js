'use strict';

// Local / self-hosted entry point: serves the static files in public/ and the API.
// On Vercel, static files are served by the CDN and the API runs from api/index.js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handler, send, SECURITY_HEADERS } = require('./lib/app');
const store = require('./lib/store');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'الصفحة غير موجودة');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=2592000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) return handler(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  return serveStatic(req, res, pathname);
});

// Create the database and the first admin account up front so the owner sees the notice at startup.
Promise.all([store.getDoc(), store.ensureAdmin()]).then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`  قائمة الأسعار تعمل على  http://localhost:${PORT}`);
    console.log(`  لوحة التحكم            http://localhost:${PORT}/admin`);
  });
});
