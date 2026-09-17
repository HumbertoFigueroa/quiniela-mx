// Cliente para la API de ESPN (Liga MX: mex.1)
const ENDPOINTS = [
  'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard',
  'https://site.web.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard',
  'https://cdn.espn.com/core/soccer/scoreboard?xhr=1&league=mex.1'
];

const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

export function parseEvent(e) {
  const comp = e.competitions?.[0];
  if (!comp) return null;

  const home = comp.competitors?.find(c => c.homeAway === 'home');
  const away = comp.competitors?.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  return {
    espn_id: String(e.id),
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

async function fetchEventsForDate(dateStr) {
  for (const ep of ENDPOINTS) {
    try {
      const sep = ep.includes('?') ? '&' : '?';
      const url = dateStr ? `${ep}${sep}dates=${dateStr}` : ep;
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();
      const root = data.content?.sbData || data;
      return (root.events || []).map(parseEvent).filter(Boolean);
    } catch {
      // Siguiente endpoint
    }
  }
  return [];
}

export async function fetchUpcoming(days = 12) {
  const now = new Date();
  const maxDate = new Date(now.getTime() + days * 24 * 3600 * 1000);
  const todayStr = now.toISOString().slice(0, 10);
  const maxDateStr = maxDate.toISOString().slice(0, 10);

  let root = null;
  let lastError = null;

  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(ep, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        root = data.content?.sbData || data;
        break;
      }
      lastError = new Error(`ESPN respondió ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }

  if (!root) {
    throw lastError || new Error('No se pudo conectar con ESPN');
  }

  const allEvents = new Map();
  const initialEvents = (root.events || []).map(parseEvent).filter(Boolean);
  for (const ev of initialEvents) allEvents.set(ev.espn_id, ev);

  const calendar = root.leagues?.[0]?.calendar || [];
  const targetDates = new Set();

  for (const entry of calendar) {
    const dStr = (typeof entry === 'string' ? entry : entry.startDate || '').slice(0, 10);
    if (dStr >= todayStr && dStr <= maxDateStr) {
      targetDates.add(dStr.replace(/-/g, ''));
    }
  }

  // Si el calendario no trae fechas o viene vacío, buscar en los próximos días
  if (targetDates.size === 0) {
    for (let i = 0; i < Math.min(days, 7); i++) {
      const d = new Date(now.getTime() + i * 24 * 3600 * 1000);
      targetDates.add(fmtDate(d));
    }
  }

  const datePromises = [...targetDates].map(ds => fetchEventsForDate(ds));
  const results = await Promise.all(datePromises);
  for (const list of results) {
    for (const ev of list) {
      allEvents.set(ev.espn_id, ev);
    }
  }

  return [...allEvents.values()].sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
}

export async function fetchForKickoffs(kickoffs) {
  if (!kickoffs || kickoffs.length === 0) return [];
  const dateStrings = new Set();
  for (const k of kickoffs) {
    const d = new Date(k);
    dateStrings.add(fmtDate(d));
    const prev = new Date(d.getTime() - 24 * 3600 * 1000);
    const next = new Date(d.getTime() + 24 * 3600 * 1000);
    dateStrings.add(fmtDate(prev));
    dateStrings.add(fmtDate(next));
  }

  const allEvents = new Map();
  const promises = [...dateStrings].map(ds => fetchEventsForDate(ds));
  const results = await Promise.all(promises);
  for (const list of results) {
    for (const ev of list) {
      allEvents.set(ev.espn_id, ev);
    }
  }
  return [...allEvents.values()];
}