# ⚽ Quiniela Liga MX

App web para la quiniela del grupo: cada quien manda su pronóstico (ganador de cada
partido + goles totales de la jornada) antes de que arranque la jornada, los marcadores
se actualizan solos desde ESPN, y la app calcula al ganador de la bolsa semanal y el
histórico de toda la temporada.

## Cómo funciona

- **Registro**: cada quien crea su usuario con un apodo y un PIN de 4 dígitos.
  **El primer usuario que se registra es el admin** (puede nombrar más admins después).
- **El admin crea la jornada**: pulsa "Cargar próximos partidos de la Liga MX",
  desmarca los que no van, y crea la jornada. La app avisa a todos.
- **Todos llenan su quiniela** (Local / Empate / Visita por partido + goles totales).
  Se puede editar hasta que inicia el primer partido; ahí se cierra sola y se revelan
  las quinielas de todos.
- **Resultados en vivo**: la app consulta ESPN automáticamente (cada 45 segundos durante
  los partidos) y manda notificaciones de goles y finales. La tabla se actualiza en
  tiempo real para todos.
- **Ganador**: al terminar el último partido, la app declara al ganador (más aciertos;
  desempate: quien quede más cerca de los goles totales; si persiste el empate, la bolsa
  se divide). La bolsa = cuota ($100) × jugadores con quiniela completa.
- **Temporada**: tabla general con semanas ganadas, aciertos, % de efectividad y balance
  de dinero de cada quien. El dinero real se lo pagan entre ustedes; la app solo lleva
  la cuenta.

## Correr en tu computadora (pruebas)

```
npm install
npm start
```

Abre http://localhost:3000. Los datos se guardan en la carpeta `data/`
(borra esa carpeta para empezar de cero).

## Publicar en internet (para que el grupo la use)

La app es un solo servidor Node.js con base de datos SQLite en disco.
Necesita un hosting **con disco persistente** (para no perder el histórico):

### Opción A — Render.com (recomendada, sencilla)
1. Sube esta carpeta a un repositorio de GitHub.
2. En [render.com](https://render.com): New → Web Service → conecta el repo.
   - Build command: `npm install` · Start command: `npm start`
3. Agrega un **Disk** (Settings → Disks): mount path `/data`, 1 GB.
4. Agrega la variable de entorno `DATA_DIR=/data`.
5. Listo: Render te da una URL `https://tu-app.onrender.com` — ese es el link
   que compartes en el grupo de WhatsApp.

Costo: el plan con disco persistente cuesta ~$7 USD/mes. Con la cuota del grupo
(15 × $100 = $1,500/semana de bolsa) es un gasto menor; también pueden cooperar
$10 pesos cada uno al mes.

### Opción B — Gratis, desde una compu siempre encendida
Si alguien del grupo tiene una PC que no se apaga:
1. `npm start` en esa máquina.
2. Instala [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (gratis)
   para exponer `http://localhost:3000` en una URL pública.

### Después de publicar
- El **primer usuario en registrarse será el admin**: que se registre primero
  la persona encargada del grupo.
- Cada quien abre el link, se registra, y en el menú del navegador elige
  **"Agregar a pantalla de inicio"** para tenerla como app.
- **Notificaciones**: se activan con el botón 🔔. En iPhone solo funcionan si
  primero agregaron la app a la pantalla de inicio (requisito de Apple, iOS 16.4+).
  Requieren HTTPS (cualquiera de las dos opciones de hosting lo da).

## Detalles técnicos

- **Backend**: Node.js + Express + SQLite (módulo nativo `node:sqlite`, sin
  dependencias pesadas). Tiempo real vía Server-Sent Events; notificaciones
  push con VAPID (`web-push`).
- **Datos de la Liga MX**: API pública de ESPN
  (`site.api.espn.com/.../soccer/mex.1/scoreboard`). Sin llave ni costo.
  Si algún día fallara, el admin puede capturar marcadores a mano desde la
  pestaña Admin.
- **Archivos generados en `data/`**: base de datos, llaves de notificaciones y
  secreto de sesiones. Respáldala si migras de servidor.
