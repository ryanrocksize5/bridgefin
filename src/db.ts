import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS addons (
  id TEXT PRIMARY KEY,
  transport_url TEXT NOT NULL UNIQUE,
  manifest TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS catalogs (
  addon_id TEXT NOT NULL,
  type TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (addon_id, type, catalog_id)
);
CREATE TABLE IF NOT EXISTS ids (hex TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS meta_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS library (
  key TEXT PRIMARY KEY,          -- "movie:tt123" / "series:tt123"
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  poster TEXT,
  added_at INTEGER NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS userdata (
  key TEXT PRIMARY KEY,          -- "movie:tt123" / "episode:tt123:1:2"
  parent_key TEXT,               -- series key for episodes
  played INTEGER NOT NULL DEFAULT 0,
  position_ticks INTEGER NOT NULL DEFAULT 0,
  runtime_ticks INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played INTEGER,
  mtime INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS userdata_parent ON userdata(parent_key);
CREATE TABLE IF NOT EXISTS link_cache (stream_key TEXT PRIMARY KEY, url TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  device_id TEXT,
  device TEXT,
  client TEXT,
  version TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,           -- 32-hex MediaSource id
  item_key TEXT NOT NULL,
  json TEXT NOT NULL,            -- StreamCandidate
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_item ON sources(item_key);
CREATE TABLE IF NOT EXISTS images (tag TEXT PRIMARY KEY, url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS previews (key TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);
`;

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function getSetting(db: DB, k: string): string | undefined {
  const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(k) as { v: string } | undefined;
  return row?.v;
}

export function setSetting(db: DB, k: string, v: string | null): void {
  if (v === null) db.prepare('DELETE FROM settings WHERE k = ?').run(k);
  else db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

export function getJsonSetting<T>(db: DB, k: string, fallback: T): T {
  const raw = getSetting(db, k);
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJsonSetting(db: DB, k: string, v: unknown): void {
  setSetting(db, k, JSON.stringify(v));
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
