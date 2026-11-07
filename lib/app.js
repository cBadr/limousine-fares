'use strict';

// API request handler — shared by the local server (server.js) and the Vercel function (api/).
// Public:  GET /api/prices
// Admin:   signed session cookie required for /api/admin/*

const store = require('./store');
const session = require('./session');
const { validateDocument, summarize } = require('./validate');

const SECURE_COOKIE = process.env.SECURE_COOKIE === '1' || !!process.env.VERCEL;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readBody(req, limit = 2 * 1024 * 1024) {
  // Some runtimes (Vercel) may already have parsed the body.
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'حجم البيانات كبير جداً'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(httpError(400, 'صيغة البيانات غير صالحة'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function cookie(token, maxAgeSec) {
  return ['sid=' + token, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSec}`, SECURE_COOKIE ? 'Secure' : '']
    .filter(Boolean).join('; ');
}

function clientIp(req) {
  if (process.env.VERCEL) {
    return req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Valid signature + the user still exists + password unchanged since the token was issued.
async function currentUser(req) {
  const data = session.verify(parseCookies(req).sid);
  if (!data) return null;
  const user = await store.findUser(data.username);
  if (!user || session.fingerprint(user) !== data.pv) return null;
  return user;
}

// Mutations must be JSON and same-origin (defence in depth on top of SameSite=Strict).
function assertSameOrigin(req) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) throw httpError(415, 'نوع المحتوى غير مدعوم');
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { ok = false; }
    if (!ok) throw httpError(403, 'طلب غير مسموح');
  }
}

function publicDoc(doc) {
  const { settings, vehicles, fareTypes, sections, routes, notes, version, updatedAt } = doc;
  return { settings, vehicles, fareTypes, sections, routes, notes, version, updatedAt };
}

async function api(req, res, pathname) {
  const route = `${req.method} ${pathname}`;

  if (route === 'GET /api/prices') {
    return send(res, 200, publicDoc(await store.getDoc()), { 'Cache-Control': 'no-cache' });
  }

  if (route === 'POST /api/login') {
    assertSameOrigin(req);
    const ip = clientIp(req);
    if (await store.rateBlocked(ip)) return send(res, 429, { error: 'محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.' });
    const { username, password } = await readBody(req, 4096);
    const user = typeof username === 'string' ? await store.findUser(username.trim()) : null;
    if (!user || typeof password !== 'string' || !store.verifyPassword(password, user)) {
      await store.rateFail(ip);
      return send(res, 401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    await store.rateReset(ip);
    return send(res, 200, { username: user.username }, { 'Set-Cookie': cookie(session.sign(user), session.TTL / 1000) });
  }

  if (route === 'POST /api/logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }

  if (route === 'GET /api/me') {
    const u = await currentUser(req);
    if (!u) return send(res, 401, { error: 'غير مسجل' });
    // sliding expiry
    return send(res, 200, { username: u.username }, { 'Set-Cookie': cookie(session.sign(u), session.TTL / 1000) });
  }

  if (!pathname.startsWith('/api/admin/')) return send(res, 404, { error: 'غير موجود' });

  // ---- everything below requires an admin session ----
  const user = await currentUser(req);
  if (!user) return send(res, 401, { error: 'انتهت الجلسة، سجّل الدخول مرة أخرى' });
  if (req.method !== 'GET') assertSameOrigin(req);

  if (route === 'GET /api/admin/data') {
    const d = await store.getDoc();
    return send(res, 200, { ...publicDoc(d), updatedBy: d.updatedBy });
  }

  if (route === 'PUT /api/admin/data') {
    const body = await readBody(req);
    const current = await store.getDoc();
    if (body.baseVersion !== current.version && !body.force) {
      return send(res, 409, {
        error: 'تم تعديل القائمة من جلسة أخرى بعد فتحك لها. حدّث الصفحة لمراجعة آخر نسخة.',
        version: current.version,
      });
    }
    const clean = validateDocument(body.doc);
    const summary = summarize(current, clean);
    const saved = { ...clean, version: current.version + 1, updatedAt: new Date().toISOString(), updatedBy: user.username };
    await store.saveDoc(saved, summary);
    return send(res, 200, { ...publicDoc(saved), updatedBy: saved.updatedBy, summary });
  }

  if (route === 'GET /api/admin/history') {
    return send(res, 200, await store.history());
  }

  const histMatch = pathname.match(/^\/api\/admin\/history\/([\w-]+)$/);
  if (histMatch && req.method === 'GET') {
    const h = await store.historyEntry(histMatch[1]);
    return h ? send(res, 200, h) : send(res, 404, { error: 'النسخة غير موجودة' });
  }

  if (route === 'POST /api/admin/password') {
    const { current, next } = await readBody(req, 4096);
    if (typeof current !== 'string' || !store.verifyPassword(current, user)) {
      return send(res, 400, { error: 'كلمة المرور الحالية غير صحيحة' });
    }
    if (typeof next !== 'string' || next.length < 8) return send(res, 400, { error: 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف' });
    const updated = await store.setPassword(user.username, next);
    // The new password fingerprint invalidates all other sessions; re-issue this one.
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(session.sign(updated), session.TTL / 1000) });
  }

  return send(res, 404, { error: 'غير موجود' });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // On Vercel every /api/* path is rewritten to /api/index?__p=<rest>.
  const pathname = url.searchParams.has('__p') ? `/api/${url.searchParams.get('__p')}` : url.pathname;
  try {
    return await api(req, res, pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'حدث خطأ غير متوقع في الخادم' : err.message });
  }
}

module.exports = { handler, send, SECURITY_HEADERS };
