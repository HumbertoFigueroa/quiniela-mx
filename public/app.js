/* Quiniela Liga MX — frontend */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let token = localStorage.getItem('token');
let me = null;
let currentView = 'live';
let liveJornadaId = 'current';
let draftPicks = {};      // match_id -> H/D/A (vista Mi quiniela)
let draftGoals = null;

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && me) { logout(); throw new Error('Sesión expirada'); }
  if (!res.ok) throw new Error(data.error || 'Error del servidor');
  return data;
}

function toast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.borderColor = ok ? 'var(--green)' : 'var(--red)';
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
  });
}

function fmtMoney(n) {
  n = Number(n);
  return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('es-MX');
}

function countdownText(lockAt) {
  const ms = new Date(lockAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60;
  if (d > 0) return `Cierra en ${d}d ${h}h`;
  if (h > 0) return `Cierra en ${h}h ${m}m`;
  return `⏰ Cierra en ${m} min`;
}

// ---------- auth ----------
let authMode = 'login';
$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-register').onclick = () => setAuthMode('register');
function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#auth-submit').textContent = mode === 'login' ? 'Entrar' : 'Crear mi usuario';
  $('#auth-error').textContent = '';
}

$('#auth-form').onsubmit = async e => {
  e.preventDefault();
  $('#auth-error').textContent = '';
  $('#auth-submit').disabled = true;
  try {
    const data = await api('/' + authMode, {
      method: 'POST',
      body: { nickname: $('#auth-nick').value, pin: $('#auth-pin').value }
    });
    token = data.token;
    localStorage.setItem('token', token);
    me = data.user;
    enterApp();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    $('#auth-submit').disabled = false;
  }
};

function logout() {
  localStorage.removeItem('token');
  token = null; me = null;
  $('#app').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
}
$('#btn-logout').onclick = () => { if (confirm('¿Cerrar sesión?')) logout(); };

// ---------- app shell ----------
$$('#nav button').forEach(b => b.onclick = () => showView(b.dataset.view));

function showView(view) {
  currentView = view;
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  render();
}

async function enterApp() {
  $('#view-login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#nav-admin').classList.toggle('hidden', !me.is_admin);
  registerSW();
  startPolling();
  refreshNotifButton();
  showView('live');
}

function render() {
  const fns = { live: renderLive, picks: renderPicks, season: renderSeason, admin: renderAdmin };
  (fns[currentView] || renderLive)().catch(err => {
    $('#main').innerHTML = `<div class="empty"><div class="big">⚠️</div>${esc(err.message)}</div>`;
  });
}

// ---------- Actualización automática ----------
// Refresca la vista de Jornada cada 30 s (y al volver a la app) para ver
// marcadores y tabla al día. No toca "Mi quiniela" para no borrar cambios sin guardar.
let pollTimer;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && currentView === 'live') render();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentView === 'live') render();
  });
}

// ---------- Vista: Jornada (en vivo) ----------
async function renderLive() {
  const data = await api('/jornadas/' + liveJornadaId);
  const { jornadas } = await api('/jornadas');

  if (!data.jornada) {
    $('#main').innerHTML = `<div class="empty"><div class="big">📭</div>Aún no hay jornadas.<br>El admin debe crear la primera.</div>`;
    return;
  }
  const j = data.jornada;
  const status = j.finalized || j.all_final ? '<span class="pill final">Finalizada</span>'
    : j.locked ? '<span class="pill live">● En juego</span>'
    : '<span class="pill open">Abierta</span>';

  const selector = jornadas.length > 1 ? `
    <select id="jsel">${jornadas.map(x =>
      `<option value="${x.id}" ${x.id === j.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
    </select>` : '';

  const matchesHtml = data.matches.map(m => {
    const live = m.state === 'in';
    const clock = m.state === 'pre' ? fmtDate(m.kickoff) : (live ? `● ${esc(m.clock)}` : 'Final');
    return `<div class="match">
      <div class="team home"><span class="name">${esc(m.home)}</span><img src="${esc(m.home_logo)}" alt=""></div>
      <div class="mid">
        <div class="score">${m.state === 'pre' ? 'vs' : `${m.home_score} - ${m.away_score}`}</div>
        <div class="clock ${live ? 'live' : ''}">${clock}</div>
      </div>
      <div class="team away"><img src="${esc(m.away_logo)}" alt=""><span class="name">${esc(m.away)}</span></div>
    </div>`;
  }).join('');

  let standingsHtml;
  if (!j.locked) {
    // Antes del cierre: solo quién ya mandó su quiniela
    standingsHtml = `<table><tr><th>Jugador</th><th class="num">Quiniela</th></tr>` +
      data.standings.map(r => `<tr class="${r.user_id === me.id ? 'me' : ''}">
        <td>${esc(r.nickname)}</td>
        <td class="num">${r.complete ? '<span class="check">✓ Enviada</span>' : '<span class="pending">Pendiente…</span>'}</td>
      </tr>`).join('') + '</table>';
  } else {
    standingsHtml = `<table>
      <tr><th>#</th><th>Jugador</th><th class="num">Aciertos</th><th class="num">Goles</th></tr>` +
      data.standings.map((r, i) => {
        const isWinner = data.winners.includes(r.user_id) && (j.finalized || j.all_final);
        const total = data.matches.length;
        const enJuego = r.live_points > r.points; // va acertando en partidos aún en juego
        const aciertos = `<b>${r.live_points ?? r.points}/${total}</b>${enJuego ? ' <small style="color:var(--gold)">●</small>' : ''}`;
        const goles = r.goals_prediction === null ? '—'
          : `${r.goals_prediction}${r.goals_diff !== null ? ` <small style="color:var(--muted)">(±${r.goals_diff})</small>` : ''}`;
        const chips = data.matches.map(m => {
          const d = r.picks?.[m.id];
          if (!d || !d.pick) return `<span class="chip">—</span>`;
          const label = d.pick === 'H' ? esc(m.home) : d.pick === 'A' ? esc(m.away) : 'Empate';
          const cls = d.result === 'hit' || d.result === 'hitting' ? 'hit' : d.result === 'miss' || d.result === 'missing' ? 'miss' : '';
          return `<span class="chip ${cls}">${label}</span>`;
        }).join('');
        return `<tr class="row-click ${isWinner ? 'winner' : ''} ${r.user_id === me.id ? 'me' : ''}" onclick="toggleDetail(${r.user_id})">
          <td>${isWinner ? '🏆' : i + 1}</td>
          <td>${esc(r.nickname)}${r.complete ? '' : ' <small style="color:var(--red)">(incompleta)</small>'}</td>
          <td class="num">${aciertos}</td>
          <td class="num">${goles}</td>
        </tr>
        <tr id="detail-${r.user_id}" class="hidden"><td colspan="4"><div class="pick-detail">${chips}</div></td></tr>`;
      }).join('') + '</table>';
  }

  const winnersNames = data.standings.filter(r => data.winners.includes(r.user_id)).map(r => esc(r.nickname));
  const winnerBanner = (j.finalized || j.all_final) && winnersNames.length ? `
    <div class="pot-banner" style="border-color:var(--gold)">
      <div><div class="label">🏆 Ganador${winnersNames.length > 1 ? 'es' : ''} de la jornada</div>
      <div style="font-size:20px;font-weight:800">${winnersNames.join(' y ')}</div></div>
      <div class="amount">${fmtMoney(Math.floor(data.pot / Math.max(1, data.winners.length)))}</div>
    </div>` : '';

  $('#main').innerHTML = `
    ${selector}
    <div class="pot-banner">
      <div><div class="label">Bolsa de la jornada · ${data.participants} jugador${data.participants !== 1 ? 'es' : ''}</div>
      <div style="font-size:17px;font-weight:800">${esc(j.name)} ${status}</div></div>
      <div class="amount">${fmtMoney(data.pot)}</div>
    </div>
    ${winnerBanner}
    ${!j.locked ? `<div class="countdown">${countdownText(j.lock_at) || ''} · las quinielas se revelan al cierre</div>` : ''}
    <div class="section-title">Partidos ${j.locked && !j.all_final ? `· goles acumulados: <b style="color:var(--gold)">${data.actual_goals}</b>` : ''}</div>
    <div class="card">${matchesHtml}</div>
    <div class="section-title">${j.locked ? 'Tabla de la jornada (toca un jugador para ver su quiniela)' : '¿Quién ya mandó?'}</div>
    <div class="card" style="padding:6px 8px">${standingsHtml}</div>`;

  const sel = $('#jsel');
  if (sel) sel.onchange = () => { liveJornadaId = sel.value; renderLive(); };
}

window.toggleDetail = uid => $('#detail-' + uid)?.classList.toggle('hidden');

// ---------- Vista: Mi quiniela ----------
async function renderPicks() {
  const { jornadas } = await api('/jornadas');
  const open = jornadas.find(j => !j.locked);
  const target = open || jornadas[0];
  if (!target) {
    $('#main').innerHTML = `<div class="empty"><div class="big">📭</div>Aún no hay jornadas para pronosticar.</div>`;
    return;
  }
  const data = await api('/jornadas/' + target.id);
  const mine = await api(`/jornadas/${target.id}/mine`);
  draftPicks = Object.fromEntries(mine.picks.map(p => [p.match_id, p.pick]));
  draftGoals = mine.total_goals;
  const locked = data.jornada.locked;

  const cards = data.matches.map(m => {
    const sel = draftPicks[m.id];
    const btn = (val, label) => `<button data-mid="${m.id}" data-val="${val}" class="${sel === val ? 'sel' : ''}" ${locked ? 'disabled' : ''}>${label}</button>`;
    return `<div class="pick-card">
      <div class="pick-teams"><img src="${esc(m.home_logo)}"> ${esc(m.home)} <span style="color:var(--muted)">vs</span> ${esc(m.away)} <img src="${esc(m.away_logo)}"></div>
      <div class="pick-date">${fmtDate(m.kickoff)}</div>
      <div class="pick-btns">${btn('H', 'Local')}${btn('D', 'Empate')}${btn('A', 'Visita')}</div>
    </div>`;
  }).join('');

  const done = data.matches.filter(m => draftPicks[m.id]).length;

  $('#main').innerHTML = `
    <div class="pot-banner">
      <div><div class="label">Mi quiniela</div><div style="font-size:17px;font-weight:800">${esc(target.name)}</div></div>
      <div style="text-align:right"><div class="label">Pronósticos</div><div class="amount" style="font-size:20px" id="done-count">${done}/${data.matches.length}</div></div>
    </div>
    ${locked
      ? `<div class="countdown" style="color:var(--red)">🔒 Jornada cerrada — tu quiniela quedó registrada así:</div>`
      : `<div class="countdown">${countdownText(target.lock_at) || ''}</div>`}
    <div class="card">${cards}</div>
    <div class="card goals-row">
      <div><b>⚽ Goles totales de la jornada</b><br><small style="color:var(--muted)">Desempate: gana quien quede más cerca</small></div>
      <input id="goals-input" type="number" inputmode="numeric" min="0" max="99" value="${draftGoals ?? ''}" placeholder="?" ${locked ? 'disabled' : ''}>
    </div>
    ${locked ? '' : `<div class="save-bar"><button class="btn-primary" id="btn-save">Guardar mi quiniela</button></div>`}`;

  if (!locked) {
    $$('.pick-btns button').forEach(b => b.onclick = () => {
      draftPicks[b.dataset.mid] = b.dataset.val;
      b.parentElement.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      $('#done-count').textContent = `${Object.keys(draftPicks).length}/${data.matches.length}`;
    });
    $('#btn-save').onclick = async () => {
      const goals = parseInt($('#goals-input').value, 10);
      const picks = Object.entries(draftPicks).map(([mid, pick]) => ({ match_id: Number(mid), pick }));
      if (picks.length < data.matches.length || Number.isNaN(goals)) {
        if (!confirm('Tu quiniela está incompleta (faltan partidos o los goles). Solo cuentan quinielas completas para ganar. ¿Guardar de todos modos?')) return;
      }
      try {
        await api(`/jornadas/${target.id}/picks`, { method: 'POST', body: { picks, total_goals: Number.isNaN(goals) ? undefined : goals } });
        toast('✅ Quiniela guardada. ¡Suerte!');
      } catch (err) { toast(err.message, false); }
    };
  }
}

// ---------- Vista: Temporada ----------
async function renderSeason() {
  const data = await api('/season');
  const { jornadas } = await api('/jornadas');
  const finalized = jornadas.filter(j => j.finalized);

  if (!data.table.length) {
    $('#main').innerHTML = `<div class="empty"><div class="big">📊</div>La tabla general aparecerá cuando<br>termine la primera jornada.</div>`;
    return;
  }
  const rows = data.table.map((r, i) => `
    <tr class="${r.user_id === me.id ? 'me' : ''} ${i === 0 ? 'winner' : ''}">
      <td>${i === 0 ? '👑' : i + 1}</td>
      <td>${esc(r.nickname)}</td>
      <td class="num"><b>${r.wins}</b></td>
      <td class="num">${r.hits}</td>
      <td class="num">${r.accuracy}%</td>
      <td class="num" style="color:${r.money >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:700">${r.money >= 0 ? '+' : ''}${fmtMoney(r.money)}</td>
    </tr>`).join('');

  $('#main').innerHTML = `
    <div class="pot-banner">
      <div><div class="label">Temporada</div><div style="font-size:17px;font-weight:800">Tabla general</div></div>
      <div style="text-align:right"><div class="label">Jornadas jugadas</div><div class="amount" style="font-size:20px">${data.jornadas_played}</div></div>
    </div>
    <div class="card" style="padding:6px 8px">
      <table>
        <tr><th>#</th><th>Jugador</th><th class="num">🏆</th><th class="num">Aciertos</th><th class="num">%</th><th class="num">Balance</th></tr>
        ${rows}
      </table>
    </div>
    <div class="section-title">Historial de jornadas</div>
    ${finalized.map(j => `<button class="card" style="width:100%;text-align:left;color:var(--text);font-size:14px" onclick="liveJornadaId=${j.id};showView('live')">
      <b>${esc(j.name)}</b> <span style="float:right;color:var(--muted)">Ver detalle →</span>
    </button>`).join('') || '<div class="empty">Sin jornadas terminadas aún.</div>'}`;
}

// ---------- Vista: Admin ----------
let upcomingEvents = [];
async function renderAdmin() {
  const { jornadas } = await api('/jornadas');
  const { users } = await api('/admin/users');
  const nextNum = jornadas.length + 1;

  const jornadasHtml = jornadas.map(j => `
    <div class="user-row">
      <div class="nick">${esc(j.name)} ${j.finalized ? '<span class="pill final">Finalizada</span>' : j.locked ? '<span class="pill live">En juego</span>' : '<span class="pill open">Abierta</span>'}</div>
      ${!j.locked ? `<button class="btn-secondary btn-danger" onclick="delJornada(${j.id})">Borrar</button>` : ''}
    </div>`).join('') || '<div class="empty" style="padding:16px">Sin jornadas.</div>';

  const usersHtml = users.map(u => `
    <div class="user-row">
      <div class="nick">${esc(u.nickname)} ${u.is_admin ? '<span class="badge-admin">ADMIN</span>' : ''}</div>
      <button class="btn-secondary" onclick="toggleAdmin(${u.id}, ${u.is_admin ? 0 : 1})">${u.is_admin ? 'Quitar admin' : 'Hacer admin'}</button>
      <button class="btn-secondary" onclick="resetPin(${u.id}, '${esc(u.nickname)}')">PIN</button>
      ${u.id !== me.id ? `<button class="btn-secondary btn-danger" onclick="delUser(${u.id}, '${esc(u.nickname)}')">✕</button>` : ''}
    </div>`).join('');

  // Partidos en vivo/por corregir de la jornada más reciente no finalizada
  const active = jornadas.find(j => !j.finalized && j.locked);
  let fixHtml = '';
  if (active) {
    const data = await api('/jornadas/' + active.id);
    fixHtml = `<div class="section-title">Corregir marcadores (${esc(active.name)}) — solo si la API falla</div>
      <div class="card">${data.matches.map(m => `
        <div class="admin-match-row">
          <span style="flex:1">${esc(m.home)} vs ${esc(m.away)}</span>
          <span class="score-edit">
            <input type="number" min="0" id="hs-${m.id}" value="${m.home_score}">
            <input type="number" min="0" id="as-${m.id}" value="${m.away_score}">
            <button class="btn-secondary" onclick="fixScore(${m.id})">✓ Final</button>
          </span>
        </div>`).join('')}
      </div>`;
  }

  $('#main').innerHTML = `
    <div class="section-title">Crear jornada</div>
    <div class="card">
      <label>Nombre<input id="j-name" value="Jornada ${nextNum}"></label>
      <label>Cuota por jugador (pesos)<input id="j-fee" type="number" value="100" min="0"></label>
      <button class="btn-secondary" id="btn-load-matches" style="width:100%">📥 Cargar próximos partidos de la Liga MX</button>
      <div id="upcoming-list"></div>
      <div id="btn-create-wrap"></div>
    </div>
    <div class="section-title">Jornadas</div>
    <div class="card">${jornadasHtml}</div>
    ${fixHtml}
    <div class="section-title">Usuarios (${users.length})</div>
    <div class="card">${usersHtml}</div>`;

  $('#btn-load-matches').onclick = async () => {
    $('#btn-load-matches').textContent = 'Cargando…';
    try {
      const { events } = await api('/admin/upcoming');
      upcomingEvents = events;
      if (!events.length) { $('#upcoming-list').innerHTML = '<div class="empty" style="padding:16px">No hay partidos próximos en ESPN (10 días).</div>'; return; }
      $('#upcoming-list').innerHTML = events.map((e, i) => `
        <div class="admin-match-row">
          <input type="checkbox" id="ev-${i}" checked>
          <img src="${esc(e.home_logo)}" width="22" height="22"> ${esc(e.home)} vs ${esc(e.away)} <img src="${esc(e.away_logo)}" width="22" height="22">
          <span class="when">${fmtDate(e.kickoff)}</span>
        </div>`).join('');
      $('#btn-create-wrap').innerHTML = `<button class="btn-primary" id="btn-create" style="margin-top:12px">Crear jornada con los partidos seleccionados</button>`;
      $('#btn-create').onclick = createJornada;
    } catch (err) { toast(err.message, false); }
    finally { $('#btn-load-matches').textContent = '📥 Cargar próximos partidos de la Liga MX'; }
  };
}

async function createJornada() {
  const matches = upcomingEvents.filter((e, i) => $('#ev-' + i)?.checked);
  if (!matches.length) return toast('Selecciona al menos un partido', false);
  try {
    await api('/admin/jornadas', {
      method: 'POST',
      body: { name: $('#j-name').value, entry_fee: Number($('#j-fee').value), matches }
    });
    toast('✅ Jornada creada. ¡Avísale al grupo!');
    liveJornadaId = 'current';
    renderAdmin();
  } catch (err) { toast(err.message, false); }
}

window.delJornada = async id => {
  if (!confirm('¿Borrar esta jornada y todas sus quinielas?')) return;
  try { await api('/admin/jornadas/' + id, { method: 'DELETE' }); renderAdmin(); } catch (e) { toast(e.message, false); }
};
window.toggleAdmin = async (id, val) => {
  try { await api(`/admin/users/${id}/admin`, { method: 'POST', body: { is_admin: val } }); renderAdmin(); } catch (e) { toast(e.message, false); }
};
window.resetPin = async (id, nick) => {
  const pin = prompt(`Nuevo PIN de 4 dígitos para ${nick}:`);
  if (!pin) return;
  try { await api(`/admin/users/${id}/reset-pin`, { method: 'POST', body: { pin } }); toast('PIN actualizado'); } catch (e) { toast(e.message, false); }
};
window.delUser = async (id, nick) => {
  if (!confirm(`¿Borrar a ${nick}? Se pierden sus quinielas.`)) return;
  try { await api('/admin/users/' + id, { method: 'DELETE' }); renderAdmin(); } catch (e) { toast(e.message, false); }
};
window.fixScore = async mid => {
  try {
    await api(`/admin/matches/${mid}/score`, {
      method: 'POST',
      body: { home_score: Number($('#hs-' + mid).value), away_score: Number($('#as-' + mid).value), state: 'post' }
    });
    toast('Marcador guardado como final');
  } catch (e) { toast(e.message, false); }
};

// ---------- Notificaciones push ----------
async function registerSW() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch {}
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function refreshNotifButton() {
  const btn = $('#btn-notif');
  if (!('Notification' in window) || !('serviceWorker' in navigator)) { btn.style.display = 'none'; return; }
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const sub = reg && await reg.pushManager.getSubscription();
  btn.classList.toggle('on', !!sub);
  btn.title = sub ? 'Notificaciones activadas' : 'Activar notificaciones';
}

$('#btn-notif').onclick = async () => {
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
      toast('🔕 Notificaciones desactivadas');
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('Permiso de notificaciones denegado', false);
      const { key } = await api('/push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      toast('🔔 Recibirás avisos de goles y resultados');
    }
  } catch (err) {
    toast('No se pudieron activar (en iPhone: primero agrega la app a tu pantalla de inicio)', false);
  }
  refreshNotifButton();
};

// ---------- arranque ----------
(async () => {
  if (token) {
    try {
      const { user } = await api('/me');
      me = user;
      enterApp();
      return;
    } catch { localStorage.removeItem('token'); token = null; }
  }
  $('#view-login').classList.remove('hidden');
})();
