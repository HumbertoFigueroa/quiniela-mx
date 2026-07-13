// Quiniela Liga MX — backend en Cloudflare Workers + D1
import { ensureSchema } from './db.js';
import { HttpError, hashPin, verifyPin, issueToken, requireAuth, requireAdmin } from './auth.js';
import * as espn from './espn.js';
import * as push from './push.js';
import { jornadaStandings, seasonTable, isLocked } from './scoring.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' }
});

// ---------- Router mínimo ----------
const routes = [];
function route(method, pattern, handler) {
  const names = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, names, handler });
}

// ---------- Auth ----------
route('POST', '/api/register', async ({ env, body }) => {
  const nickname = String(body.nickname || '').trim();
  const pin = String(body.pin || '');
  if (nickname.length < 2 || nickname.length > 20) throw new HttpError(400, 'El apodo debe tener entre 2 y 20 caracteres');
  if (!/^\d{4}$/.test(pin)) throw new HttpError(400, 'El PIN debe ser de 4 dígitos');
  const exists = await env.DB.prepare('SELECT id FROM users WHERE nickname_lower = ?').bind(nickname.toLowerCase()).first();
  if (exists) throw new HttpError(409, 'Ese apodo ya está ocupado');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const isFirst = count.n === 0;
  const info = await env.DB.prepare('INSERT INTO users (nickname, nickname_lower, pin_hash, is_admin) VALUES (?, ?, ?, ?)')
    .bind(nickname, nickname.toLowerCase(), await hashPin(pin), isFirst ? 1 : 0).run();
  const user = { id: info.meta.last_row_id, nickname, is_admin: isFirst ? 1 : 0 };
  return json({ token: await issueToken(env, user.id), user });
});

route('POST', '/api/login', async ({ env, body }) => {
  const nickname = String(body.nickname || '').trim();
  const pin = String(body.pin || '');
  const user = await env.DB.prepare('SELECT * FROM users WHERE nickname_lower = ?').bind(nickname.toLowerCase()).first();
  if (!user || !(await verifyPin(pin, user.pin_hash))) throw new HttpError(401, 'Apodo o PIN incorrecto');
  return json({ token: await issueToken(env, user.id), user: { id: user.id, nickname: user.nickname, is_admin: user.is_admin } });
});

route('GET', '/api/me', async ({ user }) => json({ user }));

// ---------- Jornadas ----------
route('GET', '/api/jornadas', async ({ env }) => {
  const { results } = await env.DB.prepare('SELECT * FROM jornadas ORDER BY lock_at DESC').all();
  return json({ jornadas: results.map(j => ({ ...j, locked: isLocked(j) })) });
});

route('GET', '/api/jornadas/:id', async ({ env, params, user }) => {
  let id = params.id;
  if (id === 'current') {
    const j = await env.DB.prepare('SELECT id FROM jornadas ORDER BY lock_at DESC LIMIT 1').first();
    if (!j) return json({ jornada: null });
    id = j.id;
  }
  const data = await jornadaStandings(env, Number(id));
  if (!data) throw new HttpError(404, 'Jornada no encontrada');
  if (!data.jornada.locked) {
    // Antes del cierre cada quien solo ve su propia quiniela
    data.standings = data.standings.map(r => r.user_id === user.id ? r
      : { ...r, points: 0, live_points: 0, goals_prediction: null, goals_diff: null, picks: undefined });
  }
  return json(data);
});

route('GET', '/api/jornadas/:id/mine', async ({ env, params, user }) => {
  const jid = Number(params.id);
  const { results: picks } = await env.DB.prepare(
    `SELECT p.match_id, p.pick FROM picks p JOIN matches m ON m.id = p.match_id
     WHERE m.jornada_id = ? AND p.user_id = ?`).bind(jid, user.id).all();
  const goals = await env.DB.prepare('SELECT total_goals FROM goal_predictions WHERE jornada_id = ? AND user_id = ?')
    .bind(jid, user.id).first();
  return json({ picks, total_goals: goals ? goals.total_goals : null });
});

route('POST', '/api/jornadas/:id/picks', async ({ env, params, user, body }) => {
  const jid = Number(params.id);
  const jornada = await env.DB.prepare('SELECT * FROM jornadas WHERE id = ?').bind(jid).first();
  if (!jornada) throw new HttpError(404, 'Jornada no encontrada');
  if (isLocked(jornada)) throw new HttpError(400, 'La jornada ya está cerrada, no se pueden cambiar pronósticos');

  const { picks, total_goals } = body;
  const { results: valid } = await env.DB.prepare('SELECT id FROM matches WHERE jornada_id = ?').bind(jid).all();
  const validIds = new Set(valid.map(m => m.id));
  const stmts = [];
  const upsert = env.DB.prepare(`INSERT INTO picks (user_id, match_id, pick) VALUES (?, ?, ?)
                                 ON CONFLICT(user_id, match_id) DO UPDATE SET pick = excluded.pick`);
  for (const p of picks || []) {
    if (!validIds.has(p.match_id) || !['H', 'D', 'A'].includes(p.pick)) continue;
    stmts.push(upsert.bind(user.id, p.match_id, p.pick));
  }
  if (Number.isInteger(total_goals) && total_goals >= 0 && total_goals <= 99) {
    stmts.push(env.DB.prepare(`INSERT INTO goal_predictions (user_id, jornada_id, total_goals) VALUES (?, ?, ?)
                               ON CONFLICT(user_id, jornada_id) DO UPDATE SET total_goals = excluded.total_goals`)
      .bind(user.id, jid, total_goals));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
});

// ---------- Temporada ----------
route('GET', '/api/season', async ({ env }) => json(await seasonTable(env)));

// ---------- Admin ----------
route('GET', '/api/admin/upcoming', async ({ env, user }) => {
  requireAdmin(user);
  try {
    const events = await espn.fetchUpcoming(12);
    return json({ events: events.filter(e => e.state === 'pre') });
  } catch (err) {
    throw new HttpError(502, 'No se pudo consultar ESPN: ' + err.message);
  }
});

route('POST', '/api/admin/jornadas', async ({ env, user, body, ctx }) => {
  requireAdmin(user);
  const { name, entry_fee, matches } = body;
  if (!name || !Array.isArray(matches) || matches.length === 0) throw new HttpError(400, 'Falta el nombre o los partidos');
  const lockAt = matches.map(m => m.kickoff).sort()[0];
  const info = await env.DB.prepare('INSERT INTO jornadas (name, lock_at, entry_fee) VALUES (?, ?, ?)')
    .bind(String(name).trim(), lockAt, Number(entry_fee) || 100).run();
  const jid = info.meta.last_row_id;
  const ins = env.DB.prepare(`INSERT INTO matches (jornada_id, espn_id, kickoff, home, away, home_logo, away_logo)
                              VALUES (?, ?, ?, ?, ?, ?, ?)`);
  await env.DB.batch(matches.map(m => ins.bind(jid, m.espn_id, m.kickoff, m.home, m.away, m.home_logo || '', m.away_logo || '')));
  ctx.waitUntil(push.broadcast(env, '📋 Nueva jornada abierta', `"${name}" ya está lista. ¡Manda tu quiniela antes del cierre!`, 'jornada'));
  return json({ ok: true, jornada_id: jid });
});

route('DELETE', '/api/admin/jornadas/:id', async ({ env, user, params }) => {
  requireAdmin(user);
  const j = await env.DB.prepare('SELECT * FROM jornadas WHERE id = ?').bind(Number(params.id)).first();
  if (!j) throw new HttpError(404, 'No existe');
  if (isLocked(j)) throw new HttpError(400, 'No se puede borrar una jornada ya iniciada');
  await env.DB.prepare('DELETE FROM jornadas WHERE id = ?').bind(j.id).run();
  return json({ ok: true });
});

// Corrección manual de marcador (si la API fallara)
route('POST', '/api/admin/matches/:id/score', async ({ env, user, params, body, ctx }) => {
  requireAdmin(user);
  const state = ['pre', 'in', 'post'].includes(body.state) ? body.state : 'post';
  await env.DB.prepare('UPDATE matches SET home_score = ?, away_score = ?, state = ? WHERE id = ?')
    .bind(Number(body.home_score) || 0, Number(body.away_score) || 0, state, Number(params.id)).run();
  const m = await env.DB.prepare('SELECT jornada_id FROM matches WHERE id = ?').bind(Number(params.id)).first();
  if (m) await checkJornadaComplete(env, ctx, m.jornada_id);
  return json({ ok: true });
});

route('GET', '/api/admin/users', async ({ env, user }) => {
  requireAdmin(user);
  const { results } = await env.DB.prepare('SELECT id, nickname, is_admin, created_at FROM users ORDER BY nickname_lower').all();
  return json({ users: results });
});

route('POST', '/api/admin/users/:id/admin', async ({ env, user, params, body }) => {
  requireAdmin(user);
  const target = Number(params.id);
  const makeAdmin = body.is_admin ? 1 : 0;
  if (!makeAdmin && target === user.id) {
    const admins = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').first();
    if (admins.n <= 1) throw new HttpError(400, 'Debe quedar al menos un admin');
  }
  await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(makeAdmin, target).run();
  return json({ ok: true });
});

route('POST', '/api/admin/users/:id/reset-pin', async ({ env, user, params, body }) => {
  requireAdmin(user);
  const pin = String(body.pin || '');
  if (!/^\d{4}$/.test(pin)) throw new HttpError(400, 'El PIN debe ser de 4 dígitos');
  await env.DB.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').bind(await hashPin(pin), Number(params.id)).run();
  return json({ ok: true });
});

route('DELETE', '/api/admin/users/:id', async ({ env, user, params }) => {
  requireAdmin(user);
  const target = Number(params.id);
  if (target === user.id) throw new HttpError(400, 'No puedes borrarte a ti mismo');
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(target).run();
  return json({ ok: true });
});

// ---------- Notificaciones push ----------
route('GET', '/api/push/key', async ({ env }) => json({ key: (await push.getVapid(env)).publicKey }));
route('POST', '/api/push/subscribe', async ({ env, user, body }) => {
  await push.saveSubscription(env, user.id, body.subscription);
  return json({ ok: true });
});
route('POST', '/api/push/unsubscribe', async ({ env, user, body }) => {
  await push.removeSubscription(env, user.id, body.endpoint);
  return json({ ok: true });
});

// Rutas públicas (sin sesión)
const PUBLIC = new Set(['POST /api/register', 'POST /api/login', 'GET /api/push/key']);

// ---------- Sincronización de marcadores (cron cada minuto) ----------
async function syncScores(env, ctx) {
  const soon = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const { results: pending } = await env.DB.prepare(
    `SELECT m.* FROM matches m JOIN jornadas j ON j.id = m.jornada_id
     WHERE m.state != 'post' AND j.lock_at <= ? AND j.finalized = 0`).bind(soon).all();
  if (!pending.length) return;

  // Con partidos en vivo (o por iniciar) consulta cada minuto; si no, cada 10
  const now = Date.now();
  const activeWindow = pending.some(m => {
    const ko = new Date(m.kickoff).getTime();
    return m.state === 'in' || (now >= ko - 15 * 60 * 1000 && now <= ko + 3 * 3600 * 1000);
  });
  if (!activeWindow && new Date().getUTCMinutes() % 10 !== 0) return;

  let events;
  try { events = await espn.fetchForKickoffs(pending.map(m => m.kickoff)); }
  catch (err) { console.error('Error consultando ESPN:', err.message); return; }

  const byId = new Map(events.map(e => [e.espn_id, e]));
  const jornadasTouched = new Set();
  for (const m of pending) {
    const e = byId.get(m.espn_id);
    if (!e) continue;
    const scoreChanged = e.home_score !== m.home_score || e.away_score !== m.away_score;
    const stateChanged = e.state !== m.state || e.clock !== m.clock;
    if (!scoreChanged && !stateChanged) continue;
    await env.DB.prepare('UPDATE matches SET home_score = ?, away_score = ?, state = ?, clock = ? WHERE id = ?')
      .bind(e.home_score, e.away_score, e.state, e.clock, m.id).run();
    jornadasTouched.add(m.jornada_id);

    const scoreline = `${m.home} ${e.home_score} - ${e.away_score} ${m.away}`;
    if (scoreChanged && e.state === 'in') await push.broadcast(env, '⚽ ¡GOOOL!', scoreline, `goal-${m.id}`);
    if (e.state === 'post' && m.state !== 'post') await push.broadcast(env, '🏁 Final del partido', scoreline, `final-${m.id}`);
  }
  for (const jid of jornadasTouched) await checkJornadaComplete(env, ctx, jid);
}

// Si todos los partidos terminaron, finaliza la jornada y anuncia al ganador
async function checkJornadaComplete(env, ctx, jornadaId) {
  const j = await env.DB.prepare('SELECT * FROM jornadas WHERE id = ?').bind(jornadaId).first();
  if (!j || j.finalized) return;
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE jornada_id = ? AND state != 'post'").bind(jornadaId).first();
  if (left.n > 0) return;
  await env.DB.prepare('UPDATE jornadas SET finalized = 1 WHERE id = ?').bind(jornadaId).run();
  const s = await jornadaStandings(env, jornadaId);
  const names = s.standings.filter(r => s.winners.includes(r.user_id)).map(r => r.nickname);
  if (names.length) {
    const prize = Math.floor(s.pot / s.winners.length);
    await push.broadcast(env, '🏆 ¡Tenemos ganador!',
      `${names.join(' y ')} gana${names.length > 1 ? 'n' : ''} la ${j.name} — $${prize} c/u`, `winner-${jornadaId}`);
  }
}

// ---------- Entradas del Worker ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    await ensureSchema(env);
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = url.pathname.match(r.regex);
        if (!match) continue;
        const params = Object.fromEntries(r.names.map((n, i) => [n, match[i + 1]]));
        const key = `${req.method} ${url.pathname}`;
        const user = PUBLIC.has(key) ? null : await requireAuth(req, env);
        const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
        return await r.handler({ req, env, ctx, params, user, body });
      }
      return json({ error: 'Ruta no encontrada' }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Error del servidor' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(syncScores(env, ctx));
  }
};
