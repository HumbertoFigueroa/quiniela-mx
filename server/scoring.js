const { db } = require('./db');

function matchWinner(m) {
  if (m.home_score > m.away_score) return 'H';
  if (m.home_score < m.away_score) return 'A';
  return 'D';
}

function isLocked(jornada) {
  return Date.now() >= new Date(jornada.lock_at).getTime();
}

// Tabla de una jornada: puntos por acierto L/E/V, desempate por goles totales.
// Solo participan usuarios con quiniela completa (todos los partidos + goles).
function jornadaStandings(jornadaId) {
  const jornada = db.prepare('SELECT * FROM jornadas WHERE id = ?').get(jornadaId);
  if (!jornada) return null;
  const matches = db.prepare('SELECT * FROM matches WHERE jornada_id = ? ORDER BY kickoff, id').all(jornadaId);
  const locked = isLocked(jornada);
  const allFinal = matches.length > 0 && matches.every(m => m.state === 'post');
  const actualGoals = matches.reduce((s, m) => (m.state !== 'pre' ? s + m.home_score + m.away_score : s), 0);

  const users = db.prepare('SELECT id, nickname FROM users ORDER BY nickname_lower').all();
  const picks = db.prepare(`SELECT p.user_id, p.match_id, p.pick FROM picks p
                            JOIN matches m ON m.id = p.match_id WHERE m.jornada_id = ?`).all(jornadaId);
  const goalPreds = db.prepare('SELECT user_id, total_goals FROM goal_predictions WHERE jornada_id = ?').all(jornadaId);
  const goalByUser = new Map(goalPreds.map(g => [g.user_id, g.total_goals]));
  const picksByUser = new Map();
  for (const p of picks) {
    if (!picksByUser.has(p.user_id)) picksByUser.set(p.user_id, new Map());
    picksByUser.get(p.user_id).set(p.match_id, p.pick);
  }

  const rows = [];
  for (const u of users) {
    const userPicks = picksByUser.get(u.id) || new Map();
    const complete = matches.length > 0 && matches.every(m => userPicks.has(m.id)) && goalByUser.has(u.id);
    if (!complete && userPicks.size === 0) continue; // nunca participó
    let points = 0;
    const detail = {};
    for (const m of matches) {
      const pick = userPicks.get(m.id) || null;
      let result = null;
      if (m.state === 'post') result = pick === matchWinner(m) ? 'hit' : 'miss';
      else if (m.state === 'in' && pick) result = pick === matchWinner(m) ? 'hitting' : 'missing';
      if (m.state === 'post' && pick === matchWinner(m)) points++;
      detail[m.id] = { pick, result };
    }
    const goals = goalByUser.has(u.id) ? goalByUser.get(u.id) : null;
    rows.push({
      user_id: u.id, nickname: u.nickname, complete, points,
      goals_prediction: goals,
      goals_diff: goals === null ? null : Math.abs(goals - actualGoals),
      picks: locked ? detail : undefined  // ocultas hasta el cierre
    });
  }

  // Orden: puntos desc, luego cercanía a goles, luego apodo
  rows.sort((a, b) => b.points - a.points
    || (a.goals_diff ?? 999) - (b.goals_diff ?? 999)
    || a.nickname.localeCompare(b.nickname));

  // Ganadores solo entre quinielas completas y con jornada terminada
  let winners = [];
  if (allFinal) {
    const eligible = rows.filter(r => r.complete);
    if (eligible.length) {
      const maxPts = Math.max(...eligible.map(r => r.points));
      const top = eligible.filter(r => r.points === maxPts);
      const minDiff = Math.min(...top.map(r => r.goals_diff ?? 999));
      winners = top.filter(r => (r.goals_diff ?? 999) === minDiff).map(r => r.user_id);
    }
  }

  const participants = rows.filter(r => r.complete).length;
  return {
    jornada: { ...jornada, locked, all_final: allFinal },
    matches, actual_goals: actualGoals,
    pot: participants * jornada.entry_fee,
    participants,
    standings: rows,
    winners
  };
}

// Tabla general de la temporada (solo jornadas finalizadas)
function seasonTable() {
  const jornadas = db.prepare('SELECT id FROM jornadas WHERE finalized = 1 ORDER BY lock_at').all();
  const totals = new Map(); // user_id -> stats
  for (const j of jornadas) {
    const s = jornadaStandings(j.id);
    for (const r of s.standings) {
      if (!r.complete) continue;
      if (!totals.has(r.user_id)) {
        totals.set(r.user_id, { user_id: r.user_id, nickname: r.nickname, jornadas: 0, hits: 0, misses: 0, wins: 0, money: 0 });
      }
      const t = totals.get(r.user_id);
      t.jornadas++;
      t.hits += r.points;
      t.misses += s.matches.length - r.points;
      if (s.winners.includes(r.user_id)) {
        t.wins++;
        t.money += Math.floor(s.pot / s.winners.length);
      }
      t.money -= s.jornada.entry_fee; // lo que aportó esa semana
    }
  }
  const rows = [...totals.values()];
  for (const r of rows) {
    const total = r.hits + r.misses;
    r.accuracy = total ? Math.round((r.hits / total) * 100) : 0;
  }
  rows.sort((a, b) => b.wins - a.wins || b.hits - a.hits || a.nickname.localeCompare(b.nickname));
  return { jornadas_played: jornadas.length, table: rows };
}

module.exports = { jornadaStandings, seasonTable, matchWinner, isLocked };
