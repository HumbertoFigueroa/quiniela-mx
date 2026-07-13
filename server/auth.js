const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

// Secreto persistente para firmar tokens de sesión
const secretFile = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
}
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

function hashPin(pin, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(pin, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(check));
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function issueToken(userId) {
  // Sesión de 180 días: dura toda la temporada sin volver a pedir PIN
  return sign({ uid: userId, exp: Date.now() + 180 * 24 * 3600 * 1000 });
}

// Middleware
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Sesión inválida, vuelve a entrar' });
  const user = db.prepare('SELECT id, nickname, is_admin FROM users WHERE id = ?').get(payload.uid);
  if (!user) return res.status(401).json({ error: 'Usuario no existe' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Solo el admin puede hacer esto' });
  next();
}

module.exports = { hashPin, verifyPin, issueToken, requireAuth, requireAdmin };
