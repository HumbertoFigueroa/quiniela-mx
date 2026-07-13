const express = require('express');
const path = require('node:path');
const { db } = require('./db');
const { hashPin, verifyPin, issueToken, requireAuth, requireAdmin } = require('./auth');
const espn = require('./espn');
const push = require('./push');
const { jornadaStandings, seasonTable, isLocked } = require('./scoring');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- SSE: tiempo real ----------
const sseClients = new Set();
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
function notifyClients(type, data = {}) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const c of sseClients) c.write(msg);
}

// ---------- Auth ----------
app.post('/api/register', (req, res) => {
  const nickname = String(req.body.nickname || '').trim();
  const pin = String(req.body.pin || '');
  if (nickname.length < 2 || nickname.length > 20) return res.status(400).json({ error: 'El apodo debe tener entre 2 y 20 caracteres' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos' });
  const exists = db.prepare('SELECT id FROM users WHERE nickname_lower = ?').get(nickname.toLowerCase());
  if (exists) return res.status(409).json({ error: 'Ese apodo ya está ocupado' });
  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const info = db.prepare('INSERT INTO users (nickname, nickname_lower, pin_hash, is_admin) VALUES (?, ?, ?, ?)')
    .run(nickname, nickname.toLowerCase(), hashPin(pin), isFirst ? 1 : 0);
  const user = { id: Number(info.lastInsertRowid), nickname, is_admin: isFirst ? 1 : 0 };
  res.json({ token: issueToken(user.id), user });
});

app.post('/api/login', (req, res) => {
  const nickname = String(req.body.nickname || '').trim();
  const pin = String(req.body.pin || '');
  const user = db.prepare('SELECT * FROM users WHERE nickname_lower = ?').get(nickname.toLowerCase());
  if (!user || !verifyPin(pin, user.pin_hash)) return res.status(401).json({ error: 'Apodo o PIN incorrecto' });
  res.json({ token: issueToken(user.id), user: { id: user.id, nickname: user.nickname, is_admin: user.is_admin } });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

// ---------- Jornadas ----------
app.get('/api/jornadas', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM jornadas ORDER BY lock_at DESC').all();
  res.json({ jornadas: rows.map(j => ({ ...j, locked: isLocked(j) })) });
});

// Jornada actual (la más reciente) o por id, con tabla en vivo
app.get('/api/jornadas/:id', requireAuth, (req, res) => {
  let id = req.params.id;
  if (id === 'current') {
    const j = db.prepare('SELECT id FROM jornadas ORDER BY lock_at DESC LIMIT 1').get();
    if (!j) return res.json({ jornada: null });
    id = j.id;
  }
  const data = jornadaStandings(Number(id));
  if (!data) return res.status(404).json({ error: 'Jornada no encontrada' });
  // Antes del cierre cada quien solo ve su propia quiniela
  if (!data.jornada.locked) {
    data.standings = data.standings.map(r => r.user_id === req.user.id ? r
      : { ...r, points: 0, goals_prediction: null, goals_diff: null, picks: undefined });
  }
  res.json(data);
});

// Mis picks de una jornada
app.get('/api/jornadas/:id/mine', requireAuth, (req, res) => {
  const jid = Number(req.params.id);
  const picks = db.prepare(`SELECT p.match_id, p.pick FROM picks p
                            JOIN matches m ON m.id = p.match_id
                            WHERE m.jornada_id = ? AND p.user_id = ?`).all(jid, req.user.id);
  const goals = db.prepare('SELECT total_goals FROM goal_predictions WHERE jornada_id = ? AND user_id = ?').get(jid, req.user.id);
  res.json({ picks, total_goals: goals ? goals.total_goals : null });
});

// Guardar quiniela (hasta el cierre)
app.post('/api/jornadas/:id/picks', requireAuth, (req, res) => {
  const jid = Number(req.params.id);
  const jornada = db.prepare('SELECT * FROM jornadas WHERE id = ?').get(jid);
  if (!jornada) return res.status(404).json({ error: 'Jornada no encontrada' });
  if (isLocked(jornada)) return res.status(400).json({ error: 'La jornada ya está cerrada, no se pueden cambiar pronósticos' });

  const { picks, total_goals } = req.body;
  const validMatches = new Set(db.prepare('SELECT id FROM matches WHERE jornada_id = ?').all(jid).map(m => m.id));
  const upsert = db.prepare(`INSERT INTO picks (user_id, match_id, pick) VALUES (?, ?, ?)
                             ON CONFLICT(user_id, match_id) DO UPDATE SET pick = excluded.pick`);
  for (const p of picks || []) {
    if (!validMatches.has(p.match_id) || !['H', 'D', 'A'].includes(p.pick)) continue;
    upsert.run(req.user.id, p.match_id, p.pick);
  }
  if (Number.isInteger(total_goals) && total_goals >= 0 && total_goals <= 99) {
    db.prepare(`INSERT INTO goal_predictions (user_id, jornada_id, total_goals) VALUES (?, ?, ?)
                ON CONFLICT(user_id, jornada_id) DO UPDATE SET total_goals = excluded.total_goals`)
      .run(req.user.id, jid, total_goals);
  }
  notifyClients('picks_updated', { jornada_id: jid });
  res.json({ ok: true });
});

// ---------- Tabla general ----------
app.get('/api/season', requireAuth, (req, res) => res.json(seasonTable()));

// ---------- Admin ----------
app.get('/api/admin/upcoming', requireAuth, requireAdmin, async (req, res) => {
  try {
    const events = await espn.fetchUpcoming(12);
    res.json({ events: events.filter(e => e.state === 'pre') });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo consultar ESPN: ' + err.message });
  }
});

app.post('/api/admin/jornadas', requireAuth, requireAdmin, (req, res) => {
  const { name, entry_fee, matches } = req.body;
  if (!name || !Array.isArray(matches) || matches.length === 0) {
    return res.status(400).json({ error: 'Falta el nombre o los partidos' });
  }
  const lockAt = matches.map(m => m.kickoff).sort()[0];
  const info = db.prepare('INSERT INTO jornadas (name, lock_at, entry_fee) VALUES (?, ?, ?)')
    .run(String(name).trim(), lockAt, Number(entry_fee) || 100);
  const jid = Number(info.lastInsertRowid);
  const ins = db.prepare(`INSERT INTO matches (jornada_id, espn_id, kickoff, home, away, home_logo, away_logo)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const m of matches) ins.run(jid, m.espn_id, m.kickoff, m.home, m.away, m.home_logo || '', m.away_logo || '');
  notifyClients('jornada_created', { jornada_id: jid });
  push.broadcast('📋 Nueva jornada abierta', `"${name}" ya está lista. ¡Manda tu quiniela antes del cierre!`, 'jornada');
  res.json({ ok: true, jornada_id: jid });
});

app.delete('/api/admin/jornadas/:id', requireAuth, requireAdmin, (req, res) => {
  const j = db.prepare('SELECT * FROM jornadas WHERE id = ?').get(Number(req.params.id));
  if (!j) return res.status(404).json({ error: 'No existe' });
  if (isLocked(j)) return res.status(400).json({ error: 'No se puede borrar una jornada ya iniciada' });
  db.prepare('DELETE FROM jornadas WHERE id = ?').run(j.id);
  notifyClients('jornada_deleted', { jornada_id: j.id });
  res.json({ ok: true });
});

// Corrección manual de marcador (si la API fallara)
app.post('/api/admin/matches/:id/score', requireAuth, requireAdmin, (req, res) => {
  const { home_score, away_score, state } = req.body;
  db.prepare('UPDATE matches SET home_score = ?, away_score = ?, state = ? WHERE id = ?')
    .run(Number(home_score) || 0, Number(away_score) || 0, ['pre', 'in', 'post'].includes(state) ? state : 'post', Number(req.params.id));
  const m = db.prepare('SELECT jornada_id FROM matches WHERE id = ?').get(Number(req.params.id));
  if (m) checkJornadaComplete(m.jornada_id);
  notifyClients('scores_updated', {});
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: db.prepare('SELECT id, nickname, is_admin, created_at FROM users ORDER BY nickname_lower').all() });
});

app.post('/api/admin/users/:id/admin', requireAuth, requireAdmin, (req, res) => {
  const target = Number(req.params.id);
  const makeAdmin = req.body.is_admin ? 1 : 0;
  if (!makeAdmin && target === req.user.id) {
    const admins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n;
    if (admins <= 1) return res.status(400).json({ error: 'Debe quedar al menos un admin' });
  }
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(makeAdmin, target);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reset-pin', requireAuth, requireAdmin, (req, res) => {
  const pin = String(req.body.pin || '');
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos' });
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(pin), Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = Number(req.params.id);
  if (target === req.user.id) return res.status(400).json({ error: 'No puedes borrarte a ti mismo' });
  db.prepare('DELETE FROM users WHERE id = ?').run(target);
  res.json({ ok: true });
});

// ---------- Notificaciones push ----------
app.get('/api/push/key', (req, res) => res.json({ key: push.publicKey() }));
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  push.saveSubscription(req.user.id, req.body.subscription);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  push.removeSubscription(req.user.id, req.body.endpoint);
  res.json({ ok: true });
});

// ---------- Sincronización con ESPN ----------
let lastPoll = 0;
async function syncScores() {
  // Partidos aún no terminados de jornadas ya cerradas (o por cerrar en <15 min)
  const soon = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const pending = db.prepare(`SELECT m.* FROM matches m JOIN jornadas j ON j.id = m.jornada_id
                              WHERE m.state != 'post' AND j.lock_at <= ? AND j.finalized = 0`).all(soon);
  if (pending.length === 0) return;

  // Poll cada 45 s si hay partido en vivo o por iniciar en 15 min; si no, cada 10 min
  const now = Date.now();
  const activeWindow = pending.some(m => {
    const ko = new Date(m.kickoff).getTime();
    return m.state === 'in' || (now >= ko - 15 * 60 * 1000 && now <= ko + 3 * 3600 * 1000);
  });
  const interval = activeWindow ? 45 * 1000 : 10 * 60 * 1000;
  if (now - lastPoll < interval) return;
  lastPoll = now;

  let events;
  try {
    events = await espn.fetchForKickoffs(pending.map(m => m.kickoff));
  } catch (err) {
    console.error('Error consultando ESPN:', err.message);
    return;
  }
  const byId = new Map(events.map(e => [e.espn_id, e]));
  let changed = false;
  const jornadasTouched = new Set();

  for (const m of pending) {
    const e = byId.get(m.espn_id);
    if (!e) continue;
    const scoreChanged = e.home_score !== m.home_score || e.away_score !== m.away_score;
    const stateChanged = e.state !== m.state || e.clock !== m.clock;
    if (!scoreChanged && !stateChanged) continue;
    db.prepare('UPDATE matches SET home_score = ?, away_score = ?, state = ?, clock = ? WHERE id = ?')
      .run(e.home_score, e.away_score, e.state, e.clock, m.id);
    changed = true;
    jornadasTouched.add(m.jornada_id);

    const scoreline = `${m.home} ${e.home_score} - ${e.away_score} ${m.away}`;
    if (scoreChanged && e.state === 'in') {
      push.broadcast('⚽ ¡GOOOL!', scoreline, `goal-${m.id}`);
    }
    if (e.state === 'post' && m.state !== 'post') {
      push.broadcast('🏁 Final del partido', scoreline, `final-${m.id}`);
    }
  }

  if (changed) {
    notifyClients('scores_updated', {});
    for (const jid of jornadasTouched) checkJornadaComplete(jid);
  }
}

// Si todos los partidos terminaron, finaliza la jornada y anuncia al ganador
function checkJornadaComplete(jornadaId) {
  const j = db.prepare('SELECT * FROM jornadas WHERE id = ?').get(jornadaId);
  if (!j || j.finalized) return;
  const left = db.prepare("SELECT COUNT(*) AS n FROM matches WHERE jornada_id = ? AND state != 'post'").get(jornadaId).n;
  if (left > 0) return;
  db.prepare('UPDATE jornadas SET finalized = 1 WHERE id = ?').run(jornadaId);
  const s = jornadaStandings(jornadaId);
  const names = s.standings.filter(r => s.winners.includes(r.user_id)).map(r => r.nickname);
  if (names.length) {
    const prize = Math.floor(s.pot / s.winners.length);
    push.broadcast('🏆 ¡Tenemos ganador!',
      `${names.join(' y ')} gana${names.length > 1 ? 'n' : ''} la ${j.name} — $${prize} c/u`, `winner-${jornadaId}`);
  }
  notifyClients('jornada_finalized', { jornada_id: jornadaId });
}

setInterval(() => syncScores().catch(err => console.error(err)), 15 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quiniela MX corriendo en http://localhost:${PORT}`));
