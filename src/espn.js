// Cliente de API-Football para la Liga MX (ID: 262)
const API_KEY = '0c584fe5142c3de054dc15f715e197d3'; 
const BASE_URL = 'https://v3.football.api-sports.io/fixtures';

// --- CONFIGURACIÓN DE LÍMITES Y HORARIOS ---
const MAX_DAILY_REQUESTS = 95; // Margen de seguridad

// Tiempos de caché dinámicos (en milisegundos)
const CACHE_LIVE_MS = 3 * 60 * 1000;     // 3 min si hay partidos "in" (jugándose)
const CACHE_IDLE_MS = 15 * 60 * 1000;    // 15 min si está en ventana activa pero no hay juego
const CACHE_OFF_HOURS_MS = 60 * 60 * 1000; // 1 hora si está fuera de ventana horaria

let dailyRequestCount = 0;
let lastResetDate = new Date().getUTCDate();

const apiCache = new Map();

function checkAndResetDailyCounter() {
  const currentDay = new Date().getUTCDate();
  if (currentDay !== lastResetDate) {
    dailyRequestCount = 0;
    lastResetDate = currentDay;
  }
}

/**
 * Valida si la hora actual está dentro de la ventana de partidos (Hora Centro de México - UTC-6)
 */
function isWithinMatchWindow() {
  const now = new Date();
  
  // Convertir a hora del Centro de México (America/Mexico_City)
  const mxTimeString = now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' });
  const mxDate = new Date(mxTimeString);
  
  const dayOfWeek = mxDate.getDay(); // 0 = Domingo, 1 = Lunes, ...
  const hour = mxDate.getHours();    // Formato 24 hrs (0 - 23)

  // Domingo: Transmisiones desde las 12:00 PM hasta las 23:00 PM
  if (dayOfWeek === 0) {
    return hour >= 12 && hour < 23;
  }

  // Resto de la semana: Transmisiones de 15:00 PM (3:00 PM) a 23:00 PM (11:00 PM)
  return hour >= 15 && hour < 23;
}

function parseEvent(item) {
  if (!item || !item.fixture || !item.teams) return null;

  const { fixture, teams, goals, status } = item;

  const shortStatus = status?.short || '';
  let state = 'pre';
  if (['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE'].includes(shortStatus)) {
    state = 'in';
  } else if (['FT', 'AET', 'PEN'].includes(shortStatus)) {
    state = 'post';
  }

  let clock = '';
  if (state === 'in') {
    clock = status?.elapsed ? `${status.elapsed}'` : 'En vivo';
  } else {
    clock = status?.long || shortStatus;
  }

  return {
    espn_id: fixture.id.toString(),
    kickoff: fixture.date,
    home: teams.home?.name || '',
    away: teams.away?.name || '',
    home_logo: teams.home?.logo || '',
    away_logo: teams.away?.logo || '',
    home_score: goals.home ?? 0,
    away_score: goals.away ?? 0,
    state,
    clock
  };
}

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

async function fetchScoreboard(fromDate, toDate) {
  checkAndResetDailyCounter();

  const from = fmtDate(fromDate);
  const to = fmtDate(toDate);
  const url = `${BASE_URL}?league=262&season=2026&from=${from}&to=${to}`;
  const now = Date.now();
  const inWindow = isWithinMatchWindow();

  // 1. Revisar Caché con TTL Dinámico
  if (apiCache.has(url)) {
    const cached = apiCache.get(url);
    const hasLiveGames = cached.data.some(event => event.state === 'in');

    // Determinamos cuánto tiempo es válida la caché actual
    let currentTTL = CACHE_OFF_HOURS_MS;
    if (inWindow) {
      currentTTL = hasLiveGames ? CACHE_LIVE_MS : CACHE_IDLE_MS;
    }

    if (now - cached.timestamp < currentTTL) {
      return cached.data;
    }
  }

  // 2. Control por Fuera de Horario (si no hay caché previa y estamos fuera de ventana, igual hace la petición para poblar)
  if (!inWindow && apiCache.has(url)) {
    console.log('[API MatchWindow] Fuera de horario de partidos. Sirviendo caché guardada.');
    return apiCache.get(url).data;
  }

  // 3. Control de Cuota Diaria
  if (dailyRequestCount >= MAX_DAILY_REQUESTS) {
    console.warn(`[API Limit] Límite diario alcanzado (${dailyRequestCount}/${MAX_DAILY_REQUESTS}).`);
    if (apiCache.has(url)) return apiCache.get(url).data;
    throw new Error('Límite de peticiones diarias alcanzado.');
  }

  // 4. Petición HTTP a la API
  dailyRequestCount++;
  console.log(`[API Request] Petición #${dailyRequestCount} enviada (${inWindow ? 'Dentro de ventana' : 'Fuera de ventana'}).`);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-apisports-key': API_KEY
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) throw new Error(`API-Football respondió ${res.status}`);
  
  const data = await res.json();
  const parsedData = (data.response || []).map(parseEvent).filter(Boolean);

  // 5. Guardar en Caché
  apiCache.set(url, {
    timestamp: now,
    data: parsedData
  });

  return parsedData;
}

// Próximos partidos
export async function fetchUpcoming(days = 12) {
  const now = new Date();
  const to = new Date(now.getTime() + days * 24 * 3600 * 1000);
  return fetchScoreboard(now, to);
}

// Actualización de marcadores para los kickoffs
export async function fetchForKickoffs(kickoffs) {
  if (!kickoffs || kickoffs.length === 0) return [];
  const dates = kickoffs.map(k => new Date(k).getTime());
  const from = new Date(Math.min(...dates) - 24 * 3600 * 1000);
  const to = new Date(Math.max(...dates) + 24 * 3600 * 1000);
  return fetchScoreboard(from, to);
}