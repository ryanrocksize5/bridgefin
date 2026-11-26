import { EventEmitter } from 'node:events';
import type { DB } from './db.ts';

export const TICKS_PER_MS = 10_000;
export const TICKS_PER_SECOND = 10_000_000;

export interface UserDataRow {
  key: string;
  parent_key: string | null;
  played: number;
  position_ticks: number;
  runtime_ticks: number;
  play_count: number;
  last_played: number | null;
  mtime: number;
}

export interface LibraryRow {
  key: string;
  type: string;
  name: string;
  poster: string | null;
  added_at: number;
  removed: number;
  mtime: number;
}

/** Emitted so the optional Stremio sync can push changes. */
export type LibraryEvent =
  | { kind: 'library'; key: string }
  | { kind: 'userdata'; key: string; parentKey?: string | null };

export class Library extends EventEmitter {
  private db: DB;

  constructor(db: DB) {
    super();
    this.db = db;
  }

  private changed(e: LibraryEvent): void {
    this.emit('change', e);
  }

  // ---------- library (= favorites) ----------

  isInLibrary(key: string): boolean {
    const r = this.db.prepare('SELECT removed FROM library WHERE key = ?').get(key) as { removed: number } | undefined;
    return !!r && !r.removed;
  }

  libraryItems(type?: string): LibraryRow[] {
    const sql = type
      ? 'SELECT * FROM library WHERE removed = 0 AND type = ? ORDER BY added_at DESC'
      : 'SELECT * FROM library WHERE removed = 0 ORDER BY added_at DESC';
    return (type ? this.db.prepare(sql).all(type) : this.db.prepare(sql).all()) as unknown as LibraryRow[];
  }

  libraryRow(key: string): LibraryRow | undefined {
    return this.db.prepare('SELECT * FROM library WHERE key = ?').get(key) as LibraryRow | undefined;
  }

  setInLibrary(key: string, type: string, name: string, poster: string | undefined, inLib: boolean, opts: { mtime?: number; addedAt?: number; silent?: boolean } = {}): void {
    const now = opts.mtime ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO library (key, type, name, poster, added_at, removed, mtime) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET removed = excluded.removed, mtime = excluded.mtime,
           name = COALESCE(NULLIF(excluded.name, ''), library.name), poster = COALESCE(excluded.poster, library.poster),
           added_at = CASE WHEN library.removed = 1 AND excluded.removed = 0 THEN excluded.added_at ELSE library.added_at END`,
      )
      .run(key, type, name, poster ?? null, opts.addedAt ?? now, inLib ? 0 : 1, now);
    if (!opts.silent) this.changed({ kind: 'library', key });
  }

  // ---------- user data ----------

  get(key: string): UserDataRow | undefined {
    return this.db.prepare('SELECT * FROM userdata WHERE key = ?').get(key) as UserDataRow | undefined;
  }

  children(parentKey: string): UserDataRow[] {
    return this.db.prepare('SELECT * FROM userdata WHERE parent_key = ?').all(parentKey) as unknown as UserDataRow[];
  }

  private upsert(key: string, parentKey: string | null | undefined, patch: Partial<UserDataRow>): UserDataRow {
    const cur = this.get(key) ?? {
      key,
      parent_key: parentKey ?? null,
      played: 0,
      position_ticks: 0,
      runtime_ticks: 0,
      play_count: 0,
      last_played: null,
      mtime: 0,
    };
    const next: UserDataRow = { ...cur, ...patch, parent_key: parentKey ?? cur.parent_key, mtime: patch.mtime ?? Date.now() };
    this.db
      .prepare(
        `INSERT INTO userdata (key, parent_key, played, position_ticks, runtime_ticks, play_count, last_played, mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET parent_key = excluded.parent_key, played = excluded.played,
           position_ticks = excluded.position_ticks, runtime_ticks = excluded.runtime_ticks,
           play_count = excluded.play_count, last_played = excluded.last_played, mtime = excluded.mtime`,
      )
      .run(next.key, next.parent_key, next.played, next.position_ticks, next.runtime_ticks, next.play_count, next.last_played, next.mtime);
    return next;
  }

  setPlayed(key: string, parentKey: string | null | undefined, played: boolean, opts: { at?: number; silent?: boolean } = {}): UserDataRow {
    const cur = this.get(key);
    const at = opts.at ?? Date.now();
    const row = this.upsert(key, parentKey, {
      played: played ? 1 : 0,
      position_ticks: 0,
      play_count: played ? Math.max(1, (cur?.play_count ?? 0) + (cur?.played ? 0 : 1)) : 0,
      last_played: played ? at : cur?.last_played ?? null,
      mtime: opts.at,
    });
    if (!opts.silent) this.changed({ kind: 'userdata', key, parentKey });
    return row;
  }

  /**
   * Playback progress from the client. Mirrors Jellyfin defaults: under 5% → no resume
   * point, over 90% → played. When runtime is unknown we only store the position.
   */
  reportProgress(key: string, parentKey: string | null | undefined, positionTicks: number, runtimeTicks: number, stopped: boolean): UserDataRow {
    const cur = this.get(key);
    const runtime = runtimeTicks || cur?.runtime_ticks || 0;
    const now = Date.now();
    let patch: Partial<UserDataRow> = { position_ticks: Math.max(0, Math.floor(positionTicks)), runtime_ticks: runtime, last_played: now };
    if (runtime > 0) {
      const pct = positionTicks / runtime;
      if (pct >= 0.9) {
        patch = { ...patch, played: 1, position_ticks: 0, play_count: (cur?.play_count ?? 0) + (cur?.played ? 0 : 1) };
      } else if (stopped && pct < 0.05) {
        patch = { ...patch, position_ticks: 0 };
      }
    }
    const row = this.upsert(key, parentKey, patch);
    if (stopped || !cur || Math.abs((cur.position_ticks ?? 0) - row.position_ticks) > 60 * TICKS_PER_SECOND || row.played !== cur.played) {
      this.changed({ kind: 'userdata', key, parentKey });
    }
    return row;
  }

  /** Raw write used by sync import. */
  importUserData(key: string, parentKey: string | null, patch: Partial<UserDataRow>): void {
    this.upsert(key, parentKey, patch);
  }

  resumable(limit = 50): UserDataRow[] {
    return this.db
      .prepare('SELECT * FROM userdata WHERE played = 0 AND position_ticks > 0 ORDER BY last_played DESC LIMIT ?')
      .all(limit) as unknown as UserDataRow[];
  }

  /** Series keys with watch activity, most recent first. */
  activeSeries(limit = 50): { parent_key: string; last: number }[] {
    return this.db
      .prepare(
        `SELECT parent_key, MAX(last_played) AS last FROM userdata
         WHERE parent_key IS NOT NULL AND last_played IS NOT NULL
         GROUP BY parent_key ORDER BY last DESC LIMIT ?`,
      )
      .all(limit) as unknown as { parent_key: string; last: number }[];
  }

  recentlyPlayed(limit = 50): UserDataRow[] {
    return this.db.prepare('SELECT * FROM userdata WHERE last_played IS NOT NULL ORDER BY last_played DESC LIMIT ?').all(limit) as unknown as UserDataRow[];
  }
}
