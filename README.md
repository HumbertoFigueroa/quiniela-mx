# ⚽ Quiniela Liga MX

App web para la quiniela del grupo: cada quien manda su pronóstico (ganador de cada
partido + goles totales de la jornada) antes de que arranque la jornada, los marcadores
se actualizan solos desde ESPN, y la app calcula al ganador de la bolsa semanal y el
histórico de toda la temporada.

Corre **gratis** en Cloudflare Workers con base de datos D1 (plan gratuito, sin tarjeta):
no se duerme, no pierde datos, y un cron en la nube actualiza marcadores y manda
notificaciones cada minuto durante los partidos aunque nadie tenga la app abierta.

## Cómo funciona

- **Registro**: cada quien crea su usuario con un apodo y un PIN de 4 dígitos.
  **El primer usuario que se registra es el admin** (puede nombrar más admins después).
- **El admin crea la jornada**: pulsa "Cargar próximos partidos de la Liga MX",
  desmarca los que no van, y crea la jornada. La app avisa a todos.
- **Todos llenan su quiniela** (Local / Empate / Visita por partido + goles totales).
  Se puede editar hasta que inicia el primer partido; ahí se cierra sola y se revelan
  las quinielas de todos.
- **Resultados en vivo**: un cron consulta ESPN cada minuto durante los partidos,
  manda notificaciones de goles y finales, y la tabla se refresca sola en la app.
- **Ganador**: al terminar el último partido, la app declara al ganador (más aciertos;
  desempate: quien quede más cerca de los goles totales; si persiste el empate, la
  bolsa se divide). La bolsa = cuota ($100) × jugadores con quiniela completa.
- **Temporada**: tabla general con semanas ganadas, aciertos, % de efectividad y
  balance de dinero. El dinero real se lo pagan entre ustedes; la app solo lleva la cuenta.

## Probar en tu computadora

```
npm install
npm run dev
```

Abre http://localhost:3000. Los datos locales viven en `.wrangler/` (bórrala para
empezar de cero). La base local es independiente de la publicada.

## Publicar gratis en Cloudflare (una sola vez)

1. Crea una cuenta gratis en **cloudflare.com** (no pide tarjeta).
2. En esta carpeta ejecuta `npx wrangler login` — se abre el navegador, pulsa *Allow*.
3. Crea la base de datos: `npx wrangler d1 create quiniela` — copia el `database_id`
   que imprime y pégalo en `wrangler.toml` (donde dice `PENDIENTE`).
4. Publica: `npm run deploy` — te dará la URL pública, algo como
   `https://quiniela-liga-mx.<tu-cuenta>.workers.dev`. Ese es el link del grupo.

Actualizaciones futuras: solo `npm run deploy` otra vez (los datos no se tocan).

### Estreno (¡importante el orden!)
1. **El encargado del grupo debe registrarse PRIMERO** en la URL pública — el primer
   usuario registrado queda como admin automáticamente.
2. El admin crea la jornada y comparte el link en el grupo de WhatsApp.
3. En los celulares: abrir el link → menú del navegador → **"Agregar a pantalla de
   inicio"** para tenerla como app. Notificaciones: botón 🔔 (en iPhone solo funcionan
   si la abren desde el icono de pantalla de inicio — regla de Apple, iOS 16.4+).

## Detalles técnicos

- **Backend**: Cloudflare Worker (`src/`) con router propio, sin framework.
  Base de datos **D1** (SQLite administrado, gratis hasta 5 GB). El esquema se crea
  solo en el primer arranque.
- **Marcadores**: API pública de ESPN (`.../soccer/mex.1/scoreboard`), sin llave ni
  costo. Un **Cron Trigger** (cada minuto) sincroniza marcadores solo cuando hay
  partidos activos, detecta goles/finales y manda las notificaciones. Si ESPN fallara,
  el admin puede capturar marcadores a mano desde la pestaña Admin.
- **Notificaciones**: Web Push con VAPID (`@block65/webcrypto-web-push`); las llaves
  se generan solas y se guardan en la tabla `config`.
- **Auth**: PIN con PBKDF2 + tokens HMAC de 180 días. La app frontend (`public/`) es
  una PWA estática servida por el CDN de Cloudflare, que se refresca sola cada 30 s.
- **Límites del plan gratis**: 100,000 peticiones/día — un grupo de 15 usa menos del
  1% de eso.
