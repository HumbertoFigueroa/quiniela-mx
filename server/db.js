const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'quiniela.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    nickname_lower TEXT NOT NULL UNIQUE,
    pin_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jornadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lock_at TEXT NOT NULL,           -- ISO UTC: se cierra al iniciar el primer partido
    entry_fee INTEGER NOT NULL DEFAULT 100,
    finalized INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jornada_id INTEGER NOT NULL REFERENCES jornadas(id) ON DELETE CASCADE,
    espn_id TEXT NOT NULL,
    kickoff TEXT NOT NULL,           -- ISO UTC
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    home_logo TEXT,
    away_logo TEXT,
    home_score INTEGER NOT NULL DEFAULT 0,
    away_score INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pre',   -- pre | in | post
    clock TEXT DEFAULT '',
    UNIQUE(jornada_id, espn_id)
  );

  CREATE TABLE IF NOT EXISTS picks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    pick TEXT NOT NULL CHECK (pick IN ('H','D','A')),
    PRIMARY KEY (user_id, match_id)
  );

  CREATE TABLE IF NOT EXISTS goal_predictions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jornada_id INTEGER NOT NULL REFERENCES jornadas(id) ON DELETE CASCADE,
    total_goals INTEGER NOT NULL,
    PRIMARY KEY (user_id, jornada_id)
  );

  CREATE TABLE IF NOT EXISTS push_subs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    subscription TEXT NOT NULL,
    PRIMARY KEY (user_id, endpoint)
  );
`);

module.exports = { db, DATA_DIR };
