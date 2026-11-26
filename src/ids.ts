import { createHash } from 'node:crypto';
import type { DB } from './db.ts';

/**
 * Jellyfin clients expect 32-hex GUID-like ids and cache them across restarts.
 * Every Stremio-side thing we expose gets a stable key, hashed to an id and stored
 * so the id can be turned back into the key.
 *
 * Key shapes:
 *   movie:<stremioId>            series:<stremioId>
 *   season:<seriesId>:<n>        episode:<seriesId>:<videoId>
 *   view:<name>                  catalog:<addonId>:<type>:<catalogId>
 *   user:<name>                  source:<base64url stream key>
 */
export class Ids {
  private cache = new Map<string, string>();
  private reverse = new Map<string, string>();
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  static hash(key: string): string {
    return createHash('md5').update(key).digest('hex');
  }

  toId(key: string): string {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const hex = Ids.hash(key);
    this.db.prepare('INSERT OR IGNORE INTO ids (hex, key) VALUES (?, ?)').run(hex, key);
    this.cache.set(key, hex);
    this.reverse.set(hex, key);
    return hex;
  }

  toKey(id: string): string | undefined {
    const hex = normalizeId(id);
    if (!hex) return undefined;
    const hit = this.reverse.get(hex);
    if (hit) return hit;
    const row = this.db.prepare('SELECT key FROM ids WHERE hex = ?').get(hex) as { key: string } | undefined;
    if (row) {
      this.reverse.set(hex, row.key);
      this.cache.set(row.key, hex);
    }
    return row?.key;
  }
}

/** Accepts dashed or undashed GUIDs, any case. Returns lowercase 32-hex or undefined. */
export function normalizeId(id: string | undefined | null): string | undefined {
  if (!id) return undefined;
  const hex = id.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : undefined;
}

export function dashed(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ParsedKey {
  kind: 'movie' | 'series' | 'season' | 'episode' | 'view' | 'catalog' | 'user' | 'source' | 'other';
  /** Stremio id of the movie/series (for season/episode: the series id). */
  stremioId?: string;
  season?: number;
  /** Stremio video id (episodes), e.g. "tt123:1:2". */
  videoId?: string;
  rest?: string;
}

export function parseKey(key: string): ParsedKey {
  const i = key.indexOf(':');
  const kind = (i < 0 ? key : key.slice(0, i)) as ParsedKey['kind'];
  const rest = i < 0 ? '' : key.slice(i + 1);
  switch (kind) {
    case 'movie':
    case 'series':
      return { kind, stremioId: rest };
    case 'season': {
      const j = rest.lastIndexOf(':');
      return { kind, stremioId: rest.slice(0, j), season: Number(rest.slice(j + 1)) };
    }
    case 'episode': {
      // episode:<seriesId>|<videoId>
      const j = rest.indexOf('|');
      return { kind, stremioId: rest.slice(0, j), videoId: rest.slice(j + 1) };
    }
    case 'view':
    case 'catalog':
    case 'user':
    case 'source':
      return { kind, rest };
    default:
      return { kind: 'other', rest: key };
  }
}

export const keys = {
  movie: (id: string) => `movie:${id}`,
  series: (id: string) => `series:${id}`,
  season: (seriesId: string, n: number) => `season:${seriesId}:${n}`,
  episode: (seriesId: string, videoId: string) => `episode:${seriesId}|${videoId}`,
  view: (name: string) => `view:${name}`,
  catalog: (addonId: string, type: string, catalogId: string) => `catalog:${addonId}:${type}:${catalogId}`,
};
