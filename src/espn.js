// Cliente para la API pública de ESPN (Liga MX: mex.1)
const ENDPOINTS = [
  'https://site.web.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard'
];

function parseEvent(e) {
  const comp = e.competitions?.[0];
  if (!comp) return null;

  const home = comp.competitors?.find(c => c.homeAway === 'home');
  const away = comp.competitors?.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  return {
    espn_id: e.id,
    kickoff: e.date,
    home: home.team?.shortDisplayName || home.team?.displayName || '',
    away: away.team?.shortDisplayName || away.team?.displayName || '',
    home_logo: home.team?.logo || '',
    away_logo: away.team?.logo || '',
    home_score: parseInt(home.score || '0', 10),
    away_score: parseInt(away.score || '0', 10),
    state: e.status?.type?.state || 'pre',   // 'pre' | 'in' | 'post'
    clock: e.status?.type?.state === 'in' 
      ? (e.status.displayClock || `${e.status.period}'`) 
      : (e.status?.type?.shortDetail || '')
  };
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function fetchScoreboard(fromDate, toDate) {
  const datesParam = `dates=${fmtDate(fromDate)}-${fmtDate(toDate)}`;
  
  // Encabezados para simular una petición legítima desde el navegador
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-MX,es;q=0.9',
    'Referer': 'https://www.espn.com.mx/',
    'Origin': 'https://www.espn.com.mx'
  };

  let lastError = null;

  // Intenta con los endpoints disponibles de ESPN en caso de bloqueo
  for (const baseUrl of ENDPOINTS) {
    try {
      const url = `${baseUrl}?${datesParam}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });

      if (res.ok) {
        const data = await res.json();
        return (data.events || []).map(parseEvent).filter(Boolean);
      }
      lastError = new Error(`ESPN respondió ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('No se pudo conectar con ESPN');
}

export async function fetchUpcoming(days = 12) {
  const now = new Date();
  const to = new Date(now.getTime() + days * 24 * 3600 * 1000);
  return fetchScoreboard(now, to);
}

export async function fetchForKickoffs(kickoffs) {
  if (!kickoffs || kickoffs.length === 0) return [];
  const dates = kickoffs.map(k => new Date(k).getTime());
  const from = new Date(Math.min(...dates) - 24 * 3600 * 1000);
  const to = new Date(Math.max(...dates) + 24 * 3600 * 1000);
  return fetchScoreboard(from, to);
}