import type { DB } from '../db.ts';
import { Ids, keys, parseKey } from '../ids.ts';
import type { Library } from '../library.ts';
import { log } from '../log.ts';
import { catalogSupports, type AddonService, type CatalogRef } from '../stremio/addons.ts';
import type { Meta, MetaVideo } from '../stremio/types.ts';
import {
  episodeDto,
  episodeNumberOf,
  isReleased,
  movieDto,
  seasonDto,
  seasonNumbers,
  seriesDto,
  viewDto,
  type DtoContext,
} from './dto.ts';

export const VIEW_LIB_MOVIES = 'view:library-movies';
export const VIEW_LIB_SERIES = 'view:library-series';
export const VIEW_ROOT = 'view:root';

export interface ViewInfo {
  key: string;
  id: string;
  name: string;
  collectionType: 'movies' | 'tvshows';
  catalog?: CatalogRef;
}

const TYPE_LABEL: Record<string, string> = { movie: 'Movies', series: 'Shows' };

/** Everything that turns Stremio data into Jellyfin items. */
export class Catalog {
  readonly ctx: DtoContext;
  readonly addons: AddonService;
  readonly library: Library;
  private db: DB;
  private catalogLimit: number;

  constructor(ctx: DtoContext, addons: AddonService, library: Library, catalogLimit: number) {
    this.ctx = ctx;
    this.addons = addons;
    this.library = library;
    this.db = ctx.db;
    this.catalogLimit = catalogLimit;
  }

  get ids(): Ids {
    return this.ctx.ids;
  }

  // ---------- views ----------

  views(): ViewInfo[] {
    const out: ViewInfo[] = [
      { key: VIEW_LIB_MOVIES, id: this.ids.toId(VIEW_LIB_MOVIES), name: 'My Movies', collectionType: 'movies' },
      { key: VIEW_LIB_SERIES, id: this.ids.toId(VIEW_LIB_SERIES), name: 'My Shows', collectionType: 'tvshows' },
    ];
    const enabled = this.addons.catalogs().filter((c) => c.enabled && (c.def.type === 'movie' || c.def.type === 'series'));
    const names = enabled.map((c) => `${c.def.name ?? c.def.id} ${TYPE_LABEL[c.def.type]}`);
    enabled.forEach((c, i) => {
      const dup = names.filter((n) => n === names[i]).length > 1;
      const key = keys.catalog(c.addon.id, c.def.type, c.def.id);
      out.push({
        key,
        id: this.ids.toId(key),
        name: dup ? `${names[i]} (${c.addon.manifest.name})` : names[i],
        collectionType: c.def.type === 'movie' ? 'movies' : 'tvshows',
        catalog: c,
      });
    });
    return out;
  }

  viewByKey(key: string): ViewInfo | undefined {
    return this.views().find((v) => v.key === key);
  }

  viewDtos(): any[] {
    return this.views().map((v) => viewDto(this.ctx, v.id, v.name, v.collectionType));
  }

  // ---------- previews & metas ----------

  rememberPreviews(metas: Meta[]): void {
    if (!metas.length) return;
    const stmt = this.db.prepare('INSERT INTO previews (key, json, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, at = excluded.at');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const m of metas) stmt.run(`${m.type}:${m.id}`, JSON.stringify(m), now);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  preview(type: string, id: string): Meta | undefined {
    const r = this.db.prepare('SELECT json FROM previews WHERE key = ?').get(`${type}:${id}`) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Meta) : undefined;
  }

  /** Best available meta: full cached meta, else preview, else fetch. */
  async metaFor(type: string, id: string, full: boolean): Promise<Meta | undefined> {
    if (full) return (await this.addons.meta(type, id)) ?? this.preview(type, id);
    return this.addons.cachedMeta(type, id) ?? this.preview(type, id) ?? (await this.addons.meta(type, id));
  }

  // ---------- items ----------

  metaToDto(m: Meta, parentId?: string): any | undefined {
    if (m.type === 'movie') return movieDto(this.ctx, m, parentId);
    if (m.type === 'series' || m.type === 'anime' || m.type === 'tv') return seriesDto(this.ctx, { ...m, type: 'series' }, parentId);
    return undefined;
  }

  /** Item DTO for any id we've issued. `full` fetches complete metadata (detail pages). */
  async itemById(id: string, full = true): Promise<any | undefined> {
    const key = this.ids.toKey(id);
    if (!key) return undefined;
    return this.itemByKey(key, full);
  }

  async itemByKey(key: string, full = true): Promise<any | undefined> {
    const k = parseKey(key);
    switch (k.kind) {
      case 'movie': {
        const m = await this.metaFor('movie', k.stremioId!, full);
        return m ? movieDto(this.ctx, { ...m, type: 'movie' }) : undefined;
      }
      case 'series': {
        const m = await this.metaFor('series', k.stremioId!, full);
        return m ? seriesDto(this.ctx, { ...m, type: 'series' }) : undefined;
      }
      case 'season': {
        const m = await this.addons.meta('series', k.stremioId!);
        return m ? seasonDto(this.ctx, m, k.season!) : undefined;
      }
      case 'episode': {
        const m = await this.addons.meta('series', k.stremioId!);
        const v = m?.videos?.find((x) => x.id === k.videoId);
        return m && v ? episodeDto(this.ctx, m, v) : undefined;
      }
      case 'view':
      case 'catalog': {
        if (key === VIEW_ROOT) return viewDto(this.ctx, this.ids.toId(VIEW_ROOT), 'Media Folders', 'folders');
        const v = this.viewByKey(key);
        return v ? viewDto(this.ctx, v.id, v.name, v.collectionType) : undefined;
      }
      default:
        return undefined;
    }
  }

  // ---------- browsing ----------

  async catalogItems(view: ViewInfo, start: number, limit: number, genre?: string): Promise<{ items: any[]; total: number }> {
    const ref = view.catalog!;
    const extra: Record<string, string> = {};
    if (genre && catalogSupports(ref.def, 'genre')) extra.genre = genre;
    const { items, total } = await this.addons.catalogSlice(ref, start, limit, this.catalogLimit, extra);
    this.rememberPreviews(items);
    return { items: items.map((m) => this.metaToDto({ ...m, type: ref.def.type }, view.id)).filter(Boolean), total };
  }

  async libraryItems(type: 'movie' | 'series', parentId?: string): Promise<any[]> {
    const rows = this.library.libraryItems(type);
    const out: any[] = [];
    for (const r of rows) {
      const k = parseKey(r.key);
      const m =
        this.addons.cachedMeta(type, k.stremioId!) ??
        this.preview(type, k.stremioId!) ??
        ({ id: k.stremioId!, type, name: r.name, poster: r.poster ?? undefined } as Meta);
      const dto = this.metaToDto({ ...m, type }, parentId);
      if (dto) {
        dto.DateCreated = new Date(r.added_at).toISOString();
        out.push(dto);
      }
    }
    return out;
  }

  catalogGenres(view: ViewInfo): string[] {
    const ref = view.catalog;
    if (!ref) return [];
    const ex = (ref.def.extra ?? []).find((e) => e.name === 'genre');
    return ex?.options ?? ref.def.genres ?? [];
  }

  async search(term: string, types: string[]): Promise<any[]> {
    const metas = await this.addons.search(term, types);
    this.rememberPreviews(metas);
    return metas.map((m) => this.metaToDto(m)).filter(Boolean);
  }

  async seasons(seriesStremioId: string): Promise<any[]> {
    const m = await this.addons.meta('series', seriesStremioId);
    if (!m) return [];
    return seasonNumbers(m).map((s) => seasonDto(this.ctx, m, s));
  }

  async episodes(seriesStremioId: string, season?: number): Promise<any[]> {
    const m = await this.addons.meta('series', seriesStremioId);
    if (!m) return [];
    return sortedEpisodes(m)
      .filter((v) => season === undefined || v.season === season)
      .map((v) => episodeDto(this.ctx, m, v));
  }

  // ---------- home rows ----------

  async resumeItems(limit: number, mediaTypes?: string[]): Promise<any[]> {
    const rows = this.library.resumable(limit * 2);
    const out: any[] = [];
    for (const r of rows) {
      const k = parseKey(r.key);
      if (mediaTypes?.length && !mediaTypes.includes(k.kind === 'movie' ? 'Movie' : 'Episode')) continue;
      try {
        const dto = await this.itemByKey(r.key, false);
        if (dto) out.push(dto);
      } catch (e) {
        log.debug(`resume item ${r.key} failed: ${(e as Error).message}`);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Next unwatched released episode for each series with watch activity. */
  async nextUp(limit: number, seriesKeyFilter?: string): Promise<any[]> {
    const active = seriesKeyFilter ? [{ parent_key: seriesKeyFilter, last: 0 }] : this.library.activeSeries(limit * 2);
    const out: any[] = [];
    await mapLimit(active, 4, async (a) => {
      const sid = parseKey(a.parent_key).stremioId!;
      const m = await this.addons.meta('series', sid).catch(() => undefined);
      if (!m) return;
      const next = nextEpisode(m, this.library.children(a.parent_key), !!seriesKeyFilter);
      if (next) out.push({ last: a.last, dto: episodeDto(this.ctx, m, next) });
    });
    out.sort((x, y) => y.last - x.last);
    return out.slice(0, limit).map((x) => x.dto);
  }

  /** "Latest" row of a view. For My Shows: recently released episodes of library series (Stremio notifications). */
  async latest(viewKey: string | undefined, limit: number): Promise<any[]> {
    if (!viewKey || viewKey === VIEW_LIB_MOVIES) {
      const movies = await this.libraryItems('movie');
      if (viewKey) return movies.slice(0, limit);
    }
    if (viewKey === VIEW_LIB_SERIES || !viewKey) {
      const series = this.library.libraryItems('series');
      const eps: { t: number; dto: any }[] = [];
      const cutoff = Date.now() - 45 * 86400_000;
      await mapLimit(series, 4, async (s) => {
        const m = await this.addons.meta('series', parseKey(s.key).stremioId!).catch(() => undefined);
        if (!m) return;
        for (const v of m.videos ?? []) {
          const t = Date.parse(v.released ?? '');
          if (!Number.isNaN(t) && t >= cutoff && t <= Date.now() && episodeNumberOf(v) !== undefined && (v.season ?? 0) > 0) {
            eps.push({ t, dto: episodeDto(this.ctx, m, v) });
          }
        }
      });
      eps.sort((a, b) => b.t - a.t);
      return eps.slice(0, limit).map((e) => e.dto);
    }
    const view = this.viewByKey(viewKey);
    if (view?.catalog) return (await this.catalogItems(view, 0, limit)).items;
    return [];
  }
}

export function sortedEpisodes(m: Meta): MetaVideo[] {
  return (m.videos ?? [])
    .filter((v) => episodeNumberOf(v) !== undefined)
    .slice()
    .sort((a, b) => {
      const sa = a.season ?? 0, sb = b.season ?? 0;
      if (sa !== sb) return (sa === 0 ? 1e6 : sa) - (sb === 0 ? 1e6 : sb);
      return (episodeNumberOf(a) ?? 0) - (episodeNumberOf(b) ?? 0);
    });
}

export function nextEpisode(m: Meta, rows: { key: string; played: number; position_ticks: number; last_played: number | null }[], includeFirst: boolean): MetaVideo | undefined {
  const eps = sortedEpisodes(m).filter((v) => (v.season ?? 0) > 0);
  const state = new Map(rows.map((r) => [r.key, r]));
  let lastIdx = -1;
  let lastTime = -1;
  eps.forEach((v, i) => {
    const r = state.get(keys.episode(m.id, v.id));
    if (r && (r.played || r.position_ticks > 0) && (r.last_played ?? 0) >= lastTime) {
      lastTime = r.last_played ?? 0;
      lastIdx = i;
    }
  });
  if (lastIdx < 0 && !includeFirst) return undefined;
  for (let i = Math.max(0, lastIdx); i < eps.length; i++) {
    const r = state.get(keys.episode(m.id, eps[i].id));
    if (r?.played) continue;
    if (!isReleased(eps[i])) return undefined;
    return eps[i];
  }
  return undefined;
}

export async function mapLimit<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await fn(item);
      } catch (e) {
        log.debug(`mapLimit task failed: ${(e as Error).message}`);
      }
    }
  });
  await Promise.all(workers);
}
