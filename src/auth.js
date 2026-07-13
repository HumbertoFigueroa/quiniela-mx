// Autenticación con WebCrypto: PIN con PBKDF2, tokens firmados con HMAC.
import { getConfig, setConfig } from './db.js';

const enc = new TextEncoder();

export function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4);
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Secreto persistente para firmar tokens (se genera una sola vez)
async function getSecret(env) {
  let secret = await getConfig(env, 'session_secret');
  if (!secret) {
    secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await setConfig(env, 'session_secret', secret);
  }
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return `${b64url(salt)}:${b64url(bits)}`;
}

export async function verifyPin(pin, stored) {
  const [saltB64, hashB64] = stored.split(':');
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64urlDecode(saltB64), iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return b64url(bits) === hashB64;
}

export async function issueToken(env, userId) {
  // Sesión de 180 días: dura toda la temporada
  const key = await getSecret(env);
  const body = b64url(enc.encode(JSON.stringify({ uid: userId, exp: Date.now() + 180 * 24 * 3600 * 1000 })));
  const sig = b64url(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${sig}`;
}

export async function requireAuth(req, env) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new HttpError(401, 'Sesión inválida, vuelve a entrar');
  const key = await getSecret(env);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), enc.encode(body));
  if (!ok) throw new HttpError(401, 'Sesión inválida, vuelve a entrar');
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))); } catch { throw new HttpError(401, 'Sesión inválida'); }
  if (payload.exp < Date.now()) throw new HttpError(401, 'Sesión expirada, vuelve a entrar');
  const user = await env.DB.prepare('SELECT id, nickname, is_admin FROM users WHERE id = ?').bind(payload.uid).first();
  if (!user) throw new HttpError(401, 'Usuario no existe');
  return user;
}

export function requireAdmin(user) {
  if (!user.is_admin) throw new HttpError(403, 'Solo el admin puede hacer esto');
}
