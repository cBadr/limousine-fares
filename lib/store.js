'use strict';

// Persistence layer with two interchangeable backends:
//  - Redis (Upstash REST API) when KV_REST_API_URL / UPSTASH_REDIS_REST_URL is set — used on Vercel.
//  - Local JSON files in ./data otherwise — used for local / self-hosted runs.
// Both expose the same async API.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const seed = require('../data/seed.json');

const HISTORY_LIMIT = 60;
const RATE_WINDOW_SEC = 15 * 60;

// ---------------------------------------------------------------- passwords

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function initialDoc() {
  return { ...JSON.parse(JSON.stringify(seed)), version: 1, updatedAt: new Date().toISOString(), updatedBy: 'النظام' };
}

function historyId(doc) {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}_v${doc.version}`;
}

function meta(id, summary, doc) {
  return { id, summary, savedAt: new Date().toISOString(), version: doc.version, by: doc.updatedBy, routes: doc.routes.length };
}

// ---------------------------------------------------------------- Redis backend

function redisBackend(url, token) {
  const base = url.replace(/\/$/, '');
  const K = (k) => `fares:${k}`;

  async function call(path, body) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`Redis error: ${data.error || res.status}`);
    return data;
  }
  const cmd = async (...args) => (await call('', args)).result;
  const pipeline = async (cmds) => (await call('/pipeline', cmds)).map((r) => {
    if (r.error) throw new Error(`Redis error: ${r.error}`);
    return r.result;
  });
  const getJson = async (key) => {
    const raw = await cmd('GET', K(key));
    return raw ? JSON.parse(raw) : null;
  };

  return {
    kind: 'redis',
    async getDoc() {
      let doc = await getJson('db');
      if (!doc) {
        doc = initialDoc();
        // NX: only the first cold start seeds the database.
        const ok = await cmd('SET', K('db'), JSON.stringify(doc), 'NX');
        if (ok) await this.snapshot(doc, 'استيراد قائمة الأسعار الأصلية');
        else doc = await getJson('db');
      }
      return doc;
    },
    async saveDoc(doc, summary) {
      await cmd('SET', K('db'), JSON.stringify(doc));
      await this.snapshot(doc, summary);
    },
    async snapshot(doc, summary) {
      const id = historyId(doc);
      const m = meta(id, summary, doc);
      const [, , overflow] = await pipeline([
        ['SET', K(`h:${id}`), JSON.stringify({ ...m, doc })],
        ['LPUSH', K('hlist'), JSON.stringify(m)],
        ['LRANGE', K('hlist'), HISTORY_LIMIT, -1],
      ]);
      const drop = (overflow || []).map((x) => K(`h:${JSON.parse(x).id}`));
      await pipeline([['LTRIM', K('hlist'), 0, HISTORY_LIMIT - 1], ...(drop.length ? [['DEL', ...drop]] : [])]);
    },
    async history() {
      return (await cmd('LRANGE', K('hlist'), 0, -1)).map((x) => JSON.parse(x));
    },
    async historyEntry(id) {
      if (!/^[\w-]+$/.test(id)) return null;
      return getJson(`h:${id}`);
    },
    async users() {
      let list = await getJson('users');
      if (!list || !list.length) {
        // First run on Vercel: the admin account comes from environment variables.
        const username = process.env.ADMIN_USER || 'admin';
        const password = process.env.ADMIN_PASSWORD;
        if (!password) return [];
        list = [{ username, ...hashPassword(password), createdAt: new Date().toISOString() }];
        await cmd('SET', K('users'), JSON.stringify(list), 'NX');
        list = await getJson('users');
      }
      return list;
    },
    async saveUsers(list) {
      await cmd('SET', K('users'), JSON.stringify(list));
    },
    // Returns true when the IP is currently blocked.
    async rateBlocked(ip) {
      return Number(await cmd('GET', K(`rl:${ip}`))) >= 5;
    },
    async rateFail(ip) {
      await pipeline([['INCR', K(`rl:${ip}`)], ['EXPIRE', K(`rl:${ip}`), RATE_WINDOW_SEC, 'NX']]);
    },
    async rateReset(ip) {
      await cmd('DEL', K(`rl:${ip}`));
    },
  };
}

// ---------------------------------------------------------------- file backend

function fileBackend(dir) {
  const DB = path.join(dir, 'db.json');
  const USERS = path.join(dir, 'users.json');
  const HIST = path.join(dir, 'history');
  fs.mkdirSync(HIST, { recursive: true });

  const read = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  };
  const write = (file, data) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  };
  const attempts = new Map();

  return {
    kind: 'file',
    async getDoc() {
      let doc = read(DB, null);
      if (!doc) {
        doc = initialDoc();
        write(DB, doc);
        await this.snapshot(doc, 'استيراد قائمة الأسعار الأصلية');
      }
      return doc;
    },
    async saveDoc(doc, summary) {
      write(DB, doc);
      await this.snapshot(doc, summary);
    },
    async snapshot(doc, summary) {
      const id = historyId(doc);
      write(path.join(HIST, `${id}.json`), { ...meta(id, summary, doc), doc });
      const files = fs.readdirSync(HIST).filter((f) => f.endsWith('.json')).sort();
      while (files.length > HISTORY_LIMIT) fs.unlinkSync(path.join(HIST, files.shift()));
    },
    async history() {
      return fs.readdirSync(HIST).filter((f) => f.endsWith('.json')).sort().reverse()
        .map((f) => read(path.join(HIST, f), null))
        .filter(Boolean)
        .map((h) => ({ id: h.id, summary: h.summary, savedAt: h.savedAt, version: h.doc.version, by: h.doc.updatedBy, routes: h.doc.routes.length }));
    },
    async historyEntry(id) {
      if (!/^[\w-]+$/.test(id)) return null;
      return read(path.join(HIST, `${id}.json`), null);
    },
    async users() {
      let list = read(USERS, []);
      if (!list.length) {
        const username = process.env.ADMIN_USER || 'admin';
        const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
        list = [{ username, ...hashPassword(password), createdAt: new Date().toISOString() }];
        write(USERS, list);
        fs.writeFileSync(path.join(dir, 'INITIAL_ADMIN.txt'), [
          'بيانات دخول لوحة التحكم (أول تشغيل)',
          `اسم المستخدم: ${username}`,
          `كلمة المرور: ${password}`,
          '',
          'غيّر كلمة المرور من لوحة التحكم > الحساب، ثم احذف هذا الملف.',
        ].join('\n'), 'utf8');
        console.log(`\n  تم إنشاء حساب الأدمن "${username}". كلمة المرور محفوظة في data/INITIAL_ADMIN.txt\n`);
      }
      return list;
    },
    async saveUsers(list) { write(USERS, list); },
    async rateBlocked(ip) {
      const a = attempts.get(ip);
      return !!a && a.count >= 5 && a.until > Date.now();
    },
    async rateFail(ip) {
      const a = attempts.get(ip);
      if (!a || a.until < Date.now()) attempts.set(ip, { count: 1, until: Date.now() + RATE_WINDOW_SEC * 1000 });
      else a.count++;
    },
    async rateReset(ip) { attempts.delete(ip); },
  };
}

// ---------------------------------------------------------------- selection

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

let backend;
if (redisUrl && redisToken) backend = redisBackend(redisUrl, redisToken);
else if (process.env.VERCEL) backend = null; // misconfigured deployment — reported per request
else backend = fileBackend(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

function requireBackend() {
  if (!backend) {
    const err = new Error('لم يتم ربط قاعدة البيانات بعد. اربط Upstash Redis بالمشروع من لوحة Vercel.');
    err.status = 503;
    throw err;
  }
  return backend;
}

module.exports = {
  get kind() { return backend ? backend.kind : 'none'; },
  getDoc: () => requireBackend().getDoc(),
  saveDoc: (doc, summary) => requireBackend().saveDoc(doc, summary),
  history: () => requireBackend().history(),
  historyEntry: (id) => requireBackend().historyEntry(id),
  async findUser(username) {
    return (await requireBackend().users()).find((u) => u.username === username) || null;
  },
  async setPassword(username, password) {
    const b = requireBackend();
    const list = (await b.users()).map((u) => (u.username === username ? { ...u, ...hashPassword(password) } : u));
    await b.saveUsers(list);
    return list.find((u) => u.username === username);
  },
  ensureAdmin: () => requireBackend().users(),
  verifyPassword,
  rateBlocked: (ip) => requireBackend().rateBlocked(ip),
  rateFail: (ip) => requireBackend().rateFail(ip),
  rateReset: (ip) => requireBackend().rateReset(ip),
};
