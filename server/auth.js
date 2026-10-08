// Password hashing + stateless signed tokens, built on node:crypto.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { get } from './db.js';

const SECRET = process.env.JWT_SECRET || 'engineeros-dev-secret-change-me';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export const ROLES = ['ADMIN', 'PM', 'DEVELOPER', 'TESTER', 'DESIGNER', 'CLIENT'];

export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(plain, salt, 64).toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const a = Buffer.from(key, 'hex');
  const b = scryptSync(plain, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const sign = (body) => createHmac('sha256', SECRET).update(body).digest('base64url');

export function issueOAuthState(provider) {
  const body = b64({ provider, nonce: randomBytes(24).toString('base64url'), exp: Date.now() + OAUTH_STATE_TTL_MS });
  return `${body}.${sign(body)}`;
}

export function readOAuthState(state, expectedProvider) {
  const [body, signature] = String(state || '').split('.');
  if (!body || !signature || sign(body) !== signature) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.provider === expectedProvider && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function issueToken(user) {
  const body = b64({ id: user.id, email: user.email, role: user.role, exp: Date.now() + TOKEN_TTL_MS });
  return `${body}.${sign(body)}`;
}

export function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || sign(body) !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

/** Express middleware: rejects the request unless a valid token is present. */
export function requireAuth(req, res, next) {
  const payload = readToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  const user = get('SELECT id, name, email, role, avatar_url, github_username, github_token FROM users WHERE id = ?', payload.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  req.user = user;
  next();
}

/** Express middleware factory: restricts a route to the listed roles. */
export function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
}
