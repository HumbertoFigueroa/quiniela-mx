// Cliente de la API pública de ESPN para la Liga MX (mex.1)
const BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard';

// Caché en memoria para evitar saturar a ESPN (5 minutos)
const CACHE_TTL_MS = 5 * 60 * 1000;
const apiCache = new Map();

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
  const url = `${BASE_URL}?dates=${fmtDate(fromDate)}-${fmtDate(toDate)}`;
  const now = Date.now();

  // 1. Si tenemos datos en caché de menos de 5 minutos, los usamos
  if (apiCache.has(url)) {
    const cached = apiCache.get(url);
    if (now - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  try {
    // 2. Petición con User-Agent de navegador para burlar el bloqueo 403
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8'
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      // Si responde 403 y tenemos datos viejos en caché, los devolvemos en lugar de fallar
      if (res.status === 403 && apiCache.has(url)) {
        console.warn('[ESPN 403] Bloqueado por ESPN. Sirviendo datos previos de caché.');
        return apiCache.get(url).data;
      }
      throw new Error(`ESPN respondió ${res.status}`);
    }

    const data = await res.json();
    const parsedData = (data.events || []).map(parseEvent).filter(Boolean);

    // 3. Guardar en caché
    apiCache.set(url, { timestamp: now, data: parsedData });
    return parsedData;

  } catch (err) {
    // Fallback de emergencia si falla la red
    if (apiCache.has(url)) return apiCache.get(url).data;
    throw err;
  }
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