// Esquema de la base D1 (SQLite). Se crea solo la primera vez.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    nickname_lower TEXT NOT NULL UNIQUE,
    pin_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS jornadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lock_at TEXT NOT NULL,
    entry_fee INTEGER NOT NULL DEFAULT 100,
    finalized INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jornada_id INTEGER NOT NULL REFERENCES jornadas(id) ON DELETE CASCADE,
    espn_id TEXT NOT NULL,
    kickoff TEXT NOT NULL,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    home_logo TEXT,
    away_logo TEXT,
    home_score INTEGER NOT NULL DEFAULT 0,
    away_score INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pre',
    clock TEXT DEFAULT '',
    UNIQUE(jornada_id, espn_id)
  )`,
  `CREATE TABLE IF NOT EXISTS picks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    pick TEXT NOT NULL CHECK (pick IN ('H','D','A')),
    PRIMARY KEY (user_id, match_id)
  )`,
  `CREATE TABLE IF NOT EXISTS goal_predictions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jornada_id INTEGER NOT NULL REFERENCES jornadas(id) ON DELETE CASCADE,
    total_goals INTEGER NOT NULL,
    PRIMARY KEY (user_id, jornada_id)
  )`,
  `CREATE TABLE IF NOT EXISTS push_subs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    subscription TEXT NOT NULL,
    PRIMARY KEY (user_id, endpoint)
  )`
];

let schemaReady = null;
export function ensureSchema(env) {
  if (!schemaReady) schemaReady = env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  return schemaReady;
}

export async function getConfig(env, key) {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setConfig(env, key, value) {
  await env.DB.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value).run();
}
