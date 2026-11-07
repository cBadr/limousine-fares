'use strict';

// Stateless signed session tokens, so sessions survive serverless cold starts.
// token = base64url(payload) "." base64url(HMAC-SHA256(payload))
// payload = { u: username, exp: epoch ms, pv: password fingerprint }
// Changing the password changes `pv`, which invalidates every older token.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TTL = 8 * 60 * 60 * 1000;

let cachedSecret = null;
function secret() {
  if (cachedSecret) return cachedSecret;
  if (process.env.SESSION_SECRET) return (cachedSecret = process.env.SESSION_SECRET);
  if (process.env.VERCEL) throw new Error('SESSION_SECRET is not configured');
  // Local development: persist a random secret next to the data files.
  const file = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), '.session-secret');
  try {
    cachedSecret = fs.readFileSync(file, 'utf8').trim();
  } catch {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cachedSecret, 'utf8');
  }
  return cachedSecret;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', secret()).update(data).digest();

function fingerprint(user) {
  return crypto.createHash('sha256').update(`${user.salt}:${user.hash}`).digest('base64url').slice(0, 16);
}

function sign(user) {
  const payload = b64(JSON.stringify({ u: user.username, exp: Date.now() + TTL, pv: fingerprint(user) }));
  return `${payload}.${b64(hmac(payload))}`;
}

// Returns { username, pv } when the signature and expiry are valid, else null.
function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  const expected = hmac(payload);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.u || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return { username: data.u, pv: data.pv };
  } catch {
    return null;
  }
}

module.exports = { sign, verify, fingerprint, TTL };
