// Cliente de la API pública de ESPN para la Liga MX (mex.1)
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard';

function parseEvent(e) {
  const comp = e.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors.find(c => c.homeAway === 'home');
  const away = comp.competitors.find(c => c.homeAway === 'away');
  if (!home || !away) return null;
  return {
    espn_id: e.id,
    kickoff: e.date,
    home: home.team.shortDisplayName || home.team.displayName,
    away: away.team.shortDisplayName || away.team.displayName,
    home_logo: home.team.logo || '',
    away_logo: away.team.logo || '',
    home_score: parseInt(home.score || '0', 10),
    away_score: parseInt(away.score || '0', 10),
    state: e.status?.type?.state || 'pre',   // pre | in | post
    clock: e.status?.type?.state === 'in' ? (e.status.displayClock || '') : (e.status?.type?.shortDetail || '')
  };
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function fetchScoreboard(fromDate, toDate) {
  const url = `${BASE}?dates=${fmtDate(fromDate)}-${fmtDate(toDate)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`ESPN respondió ${res.status}`);
  const data = await res.json();
  return (data.events || []).map(parseEvent).filter(Boolean);
}

// Próximos partidos (para que el admin arme la jornada)
export async function fetchUpcoming(days = 12) {
  const now = new Date();
  const to = new Date(now.getTime() + days * 24 * 3600 * 1000);
  return fetchScoreboard(now, to);
}

// Partidos en un rango que cubre los kickoffs dados (para actualizar marcadores)
export async function fetchForKickoffs(kickoffs) {
  const dates = kickoffs.map(k => new Date(k).getTime());
  const from = new Date(Math.min(...dates) - 24 * 3600 * 1000);
  const to = new Date(Math.max(...dates) + 24 * 3600 * 1000);
  return fetchScoreboard(from, to);
}
