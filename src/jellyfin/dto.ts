import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import { dashed, Ids, keys } from '../ids.ts';
import type { Library, UserDataRow } from '../library.ts';
import { TICKS_PER_SECOND } from '../library.ts';
import type { Meta, MetaVideo } from '../stremio/types.ts';

export interface DtoContext {
  serverId: string;
  userId: string;
  ids: Ids;
  library: Library;
  db: DB;
}

const DATE_ZERO = '0001-01-01T00:00:00.0000000Z';

export function isoDate(v: string | number | undefined | null): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace(/\.(\d{3})Z$/, (_m, ms: string) => `.${ms}0000Z`);
}

export function parseYear(m: Pick<Meta, 'year' | 'releaseInfo' | 'released'>): number | undefined {
  for (const v of [m.year, m.releaseInfo, m.released]) {
    if (v === undefined || v === null) continue;
    const r = /(\d{4})/.exec(String(v));
    if (r) return Number(r[1]);
  }
  return undefined;
}

/** "2h 10min", "130 min", "45min", "1h" → ticks. */
export function parseRuntimeTicks(rt: string | number | undefined): number | undefined {
  if (rt === undefined || rt === null || rt === '') return undefined;
  if (typeof rt === 'number') return rt * 60 * TICKS_PER_SECOND;
  const h = /(\d+)\s*h/i.exec(rt);
  const m = /(\d+)\s*m/i.exec(rt);
  let mins = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  if (!h && !m) {
    const n = /(\d+)/.exec(rt);
    if (n) mins = Number(n[1]);
  }
  return mins > 0 ? mins * 60 * TICKS_PER_SECOND : undefined;
}

export function imageTag(ctx: DtoContext, url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  const tag = createHash('md5').update(url).digest('hex');
  ctx.db.prepare('INSERT OR IGNORE INTO images (tag, url) VALUES (?, ?)').run(tag, url);
  return tag;
}

export function imageUrlForTag(db: DB, tag: string): string | undefined {
  const r = db.prepare('SELECT url FROM images WHERE tag = ?').get(tag) as { url: string } | undefined;
  return r?.url;
}

function providerIds(m: Meta): Record<string, string> {
  const p: Record<string, string> = {};
  const imdb = m.imdb_id ?? (/^tt\d+$/.test(m.id) ? m.id : undefined);
  if (imdb) p.Imdb = imdb;
  if (m.moviedb_id) p.Tmdb = String(m.moviedb_id);
  else if (/^tmdb:\d+$/.test(m.id)) p.Tmdb = m.id.slice(5);
  if (m.tvdb_id) p.Tvdb = String(m.tvdb_id);
  return p;
}

function externalUrls(p: Record<string, string>, type: 'movie' | 'tv'): { Name: string; Url: string }[] {
  const out: { Name: string; Url: string }[] = [];
  if (p.Imdb) out.push({ Name: 'IMDb', Url: `https://www.imdb.com/title/${p.Imdb}` });
  if (p.Tmdb) out.push({ Name: 'TMDB', Url: `https://www.themoviedb.org/${type}/${p.Tmdb}` });
  return out;
}

function trailers(m: Meta): { Url: string; Name: string }[] {
  const ids = new Set<string>();
  for (const t of m.trailerStreams ?? []) if (t.ytId) ids.add(t.ytId);
  for (const t of m.trailers ?? []) if (t.source && (!t.type || t.type === 'Trailer')) ids.add(t.source);
  return [...ids].slice(0, 5).map((id) => ({ Url: `https://www.youtube.com/watch?v=${id}`, Name: 'Trailer' }));
}

function people(ctx: DtoContext, m: Meta): any[] {
  const out: any[] = [];
  const asList = (v: string[] | string | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
  const castExtra = m.app_extras?.cast;
  const cast = castExtra?.length ? castExtra.map((c) => ({ name: c.name, role: c.character ?? '', photo: c.photo })) : asList(m.cast).map((n) => ({ name: n, role: '', photo: undefined as string | undefined }));
  for (const c of cast.slice(0, 20)) {
    const tag = imageTag(ctx, c.photo);
    out.push({ Name: c.name, Id: Ids.hash(`person:${c.name}`), Role: c.role, Type: 'Actor', ...(tag ? { PrimaryImageTag: tag } : {}) });
  }
  for (const d of asList(m.director)) out.push({ Name: d, Id: Ids.hash(`person:${d}`), Role: 'Director', Type: 'Director' });
  for (const w of asList(m.writer)) out.push({ Name: w, Id: Ids.hash(`person:${w}`), Role: 'Writer', Type: 'Writer' });
  return out;
}

function genres(m: Meta): string[] {
  return (m.genres ?? m.genre ?? []).filter((g) => typeof g === 'string');
}

export function userDataDto(itemId: string, row: UserDataRow | undefined, favorite: boolean, runtimeTicks?: number, extra: Record<string, unknown> = {}): any {
  const pos = row?.position_ticks ?? 0;
  const rt = runtimeTicks || row?.runtime_ticks || 0;
  const ud: any = {
    PlaybackPositionTicks: pos,
    PlayCount: row?.play_count ?? 0,
    IsFavorite: favorite,
    Played: !!row?.played,
    Key: dashed(itemId),
    ItemId: itemId,
    ...extra,
  };
  if (row?.last_played) ud.LastPlayedDate = isoDate(row.last_played);
  if (pos > 0 && rt > 0) ud.PlayedPercentage = Math.min(100, (pos / rt) * 100);
  return ud;
}

function base(ctx: DtoContext, id: string, name: string, type: string): any {
  return {
    Name: name,
    ServerId: ctx.serverId,
    Id: id,
    Etag: id.slice(0, 16),
    DateCreated: DATE_ZERO,
    CanDelete: false,
    CanDownload: false,
    SortName: sortName(name),
    ExternalUrls: [],
    EnableMediaSourceDisplay: true,
    ChannelId: null,
    Taglines: [],
    Genres: [],
    PlayAccess: 'Full',
    RemoteTrailers: [],
    ProviderIds: {},
    IsFolder: false,
    Type: type,
    People: [],
    Studios: [],
    GenreItems: [],
    LocalTrailerCount: 0,
    SpecialFeatureCount: 0,
    Tags: [],
    ImageTags: {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
    LocationType: 'Remote',
    MediaType: 'Unknown',
    LockedFields: [],
    LockData: false,
  };
}

export function sortName(name: string): string {
  return name.toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
}

function applyImages(ctx: DtoContext, dto: any, imgs: { primary?: string; backdrop?: string; logo?: string; thumb?: string }): void {
  const p = imageTag(ctx, imgs.primary);
  const b = imageTag(ctx, imgs.backdrop);
  const l = imageTag(ctx, imgs.logo);
  const t = imageTag(ctx, imgs.thumb);
  if (p) dto.ImageTags.Primary = p;
  if (l) dto.ImageTags.Logo = l;
  if (t) dto.ImageTags.Thumb = t;
  if (b) dto.BackdropImageTags = [b];
}

function commonMeta(ctx: DtoContext, dto: any, m: Meta, tvOrMovie: 'movie' | 'tv'): void {
  const pids = providerIds(m);
  dto.ProviderIds = pids;
  dto.ExternalUrls = externalUrls(pids, tvOrMovie);
  dto.Overview = m.description ?? '';
  const g = genres(m);
  dto.Genres = g;
  dto.GenreItems = g.map((n) => ({ Name: n, Id: Ids.hash(`genre:${n}`) }));
  const year = parseYear(m);
  if (year) dto.ProductionYear = year;
  const prem = isoDate(m.released) ?? (year ? `${year}-01-01T00:00:00.0000000Z` : undefined);
  if (prem) dto.PremiereDate = prem;
  const rating = Number(m.imdbRating);
  if (Number.isFinite(rating) && rating > 0) dto.CommunityRating = rating;
  if (m.certification) dto.OfficialRating = m.certification;
  dto.RemoteTrailers = trailers(m);
  dto.People = people(ctx, m);
  if (m.country) dto.ProductionLocations = m.country.split(/,\s*/);
  dto.OriginalTitle = m.name;
  dto.PrimaryImageAspectRatio = m.posterShape === 'landscape' ? 16 / 9 : m.posterShape === 'square' ? 1 : 2 / 3;
}

export function movieDto(ctx: DtoContext, m: Meta, parentId?: string): any {
  const key = keys.movie(m.id);
  const id = ctx.ids.toId(key);
  const dto = base(ctx, id, m.name, 'Movie');
  commonMeta(ctx, dto, m, 'movie');
  const rt = parseRuntimeTicks(m.runtime);
  if (rt) dto.RunTimeTicks = rt;
  dto.IsFolder = false;
  dto.MediaType = 'Video';
  dto.VideoType = 'VideoFile';
  dto.Container = 'mkv';
  dto.IsHD = true;
  if (parentId) dto.ParentId = parentId;
  applyImages(ctx, dto, { primary: m.poster, backdrop: m.background, logo: m.logo, thumb: m.background });
  dto.UserData = userDataDto(id, ctx.library.get(key), ctx.library.isInLibrary(key), rt);
  return dto;
}

export function seriesDto(ctx: DtoContext, m: Meta, parentId?: string): any {
  const key = keys.series(m.id);
  const id = ctx.ids.toId(key);
  const dto = base(ctx, id, m.name, 'Series');
  commonMeta(ctx, dto, m, 'tv');
  dto.IsFolder = true;
  dto.AirDays = [];
  dto.DisplayOrder = '';
  if (m.status) dto.Status = /ended|cancel/i.test(m.status) ? 'Ended' : 'Continuing';
  else if (typeof m.releaseInfo === 'string' && /\d{4}-\d{4}/.test(m.releaseInfo)) dto.Status = 'Ended';
  else if (typeof m.releaseInfo === 'string' && /\d{4}[-–]\s*$/.test(m.releaseInfo)) dto.Status = 'Continuing';
  const rt = parseRuntimeTicks(m.runtime);
  if (rt) dto.RunTimeTicks = rt;
  if (parentId) dto.ParentId = parentId;
  applyImages(ctx, dto, { primary: m.poster, backdrop: m.background, logo: m.logo, thumb: m.background });
  const eps = (m.videos ?? []).filter((v) => episodeNumberOf(v) !== undefined && (v.season ?? 0) > 0);
  const seasons = new Set(eps.map((v) => v.season));
  const extra: Record<string, unknown> = {};
  if (m.videos) {
    const played = new Set(ctx.library.children(key).filter((r) => r.played).map((r) => r.key));
    const released = eps.filter((v) => isReleased(v));
    const unplayed = released.filter((v) => !played.has(keys.episode(m.id, v.id))).length;
    extra.UnplayedItemCount = unplayed;
    extra.PlayedPercentage = released.length ? ((released.length - unplayed) / released.length) * 100 : 0;
    dto.RecursiveItemCount = released.length;
    dto.ChildCount = seasons.size;
  }
  const ud = userDataDto(id, undefined, ctx.library.isInLibrary(key), undefined, extra);
  ud.Played = extra.UnplayedItemCount === 0 && (dto.RecursiveItemCount ?? 0) > 0;
  dto.UserData = ud;
  return dto;
}

export function episodeNumberOf(v: MetaVideo): number | undefined {
  return v.episode ?? v.number;
}

export function isReleased(v: MetaVideo, now = Date.now()): boolean {
  const r = v.released ?? v.firstAired;
  if (!r) return true;
  const t = Date.parse(r);
  return Number.isNaN(t) || t <= now;
}

export function seasonNumbers(m: Meta): number[] {
  const set = new Set<number>();
  for (const v of m.videos ?? []) if (v.season !== undefined && episodeNumberOf(v) !== undefined) set.add(v.season);
  return [...set].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
}

export function seasonDto(ctx: DtoContext, m: Meta, season: number): any {
  const seriesKey = keys.series(m.id);
  const seriesId = ctx.ids.toId(seriesKey);
  const id = ctx.ids.toId(keys.season(m.id, season));
  const name = season === 0 ? 'Specials' : `Season ${season}`;
  const dto = base(ctx, id, name, 'Season');
  dto.SortName = String(season).padStart(4, '0');
  dto.IndexNumber = season;
  dto.IsFolder = true;
  dto.ParentId = seriesId;
  dto.SeriesId = seriesId;
  dto.SeriesName = m.name;
  dto.SeriesPrimaryImageTag = imageTag(ctx, m.poster);
  dto.ProviderIds = {};
  const eps = (m.videos ?? []).filter((v) => v.season === season && episodeNumberOf(v) !== undefined);
  const released = eps.filter((v) => isReleased(v));
  const played = new Set(ctx.library.children(seriesKey).filter((r) => r.played).map((r) => r.key));
  const unplayed = released.filter((v) => !played.has(keys.episode(m.id, v.id))).length;
  dto.ChildCount = eps.length;
  dto.RecursiveItemCount = eps.length;
  const yearEp = eps.find((v) => v.released);
  if (yearEp?.released) {
    dto.PremiereDate = isoDate(yearEp.released);
    dto.ProductionYear = new Date(yearEp.released).getUTCFullYear();
  }
  applyImages(ctx, dto, { primary: m.poster, backdrop: m.background });
  dto.ParentBackdropItemId = seriesId;
  const bt = imageTag(ctx, m.background);
  if (bt) dto.ParentBackdropImageTags = [bt];
  const lt = imageTag(ctx, m.logo);
  if (lt) {
    dto.ParentLogoItemId = seriesId;
    dto.ParentLogoImageTag = lt;
  }
  const ud = userDataDto(id, undefined, false, undefined, {
    UnplayedItemCount: unplayed,
    PlayedPercentage: released.length ? ((released.length - unplayed) / released.length) * 100 : 0,
  });
  ud.Played = released.length > 0 && unplayed === 0;
  dto.UserData = ud;
  return dto;
}

export function episodeDto(ctx: DtoContext, m: Meta, v: MetaVideo): any {
  const seriesKey = keys.series(m.id);
  const seriesId = ctx.ids.toId(seriesKey);
  const season = v.season ?? 0;
  const seasonId = ctx.ids.toId(keys.season(m.id, season));
  const key = keys.episode(m.id, v.id);
  const id = ctx.ids.toId(key);
  const epNum = episodeNumberOf(v);
  const name = v.title ?? v.name ?? (epNum !== undefined ? `Episode ${epNum}` : v.id);
  const dto = base(ctx, id, name, 'Episode');
  dto.SortName = `${String(season).padStart(3, '0')} - ${String(epNum ?? 0).padStart(4, '0')} - ${name}`;
  dto.IndexNumber = epNum;
  dto.ParentIndexNumber = season;
  dto.ParentId = seasonId;
  dto.SeasonId = seasonId;
  dto.SeasonName = season === 0 ? 'Specials' : `Season ${season}`;
  dto.SeriesId = seriesId;
  dto.SeriesName = m.name;
  dto.Overview = v.overview ?? v.description ?? '';
  dto.MediaType = 'Video';
  dto.VideoType = 'VideoFile';
  dto.Container = 'mkv';
  dto.IsFolder = false;
  dto.ProviderIds = {};
  if (v.released) {
    dto.PremiereDate = isoDate(v.released);
    const y = new Date(v.released).getUTCFullYear();
    if (Number.isFinite(y)) dto.ProductionYear = y;
  }
  const rt = parseRuntimeTicks(v.runtime) ?? parseRuntimeTicks(m.runtime);
  if (rt) dto.RunTimeTicks = rt;
  const seriesPrimary = imageTag(ctx, m.poster);
  if (seriesPrimary) dto.SeriesPrimaryImageTag = seriesPrimary;
  applyImages(ctx, dto, { primary: v.thumbnail ?? m.background, thumb: v.thumbnail });
  dto.PrimaryImageAspectRatio = 16 / 9;
  dto.ParentBackdropItemId = seriesId;
  const bt = imageTag(ctx, m.background);
  if (bt) dto.ParentBackdropImageTags = [bt];
  const lt = imageTag(ctx, m.logo);
  if (lt) {
    dto.ParentLogoItemId = seriesId;
    dto.ParentLogoImageTag = lt;
  }
  if (!isReleased(v)) dto.LocationType = 'Virtual';
  dto.UserData = userDataDto(id, ctx.library.get(key), false, rt);
  return dto;
}

export function viewDto(ctx: DtoContext, id: string, name: string, collectionType: 'movies' | 'tvshows' | 'mixed' | 'folders', poster?: string): any {
  const dto = base(ctx, id, name, 'CollectionFolder');
  dto.IsFolder = true;
  dto.CollectionType = collectionType === 'mixed' ? undefined : collectionType;
  dto.DisplayPreferencesId = id;
  dto.ParentId = ctx.ids.toId('view:root');
  dto.Path = `/bridgefin/${id}`;
  dto.LocationType = 'FileSystem';
  dto.ChildCount = 0;
  dto.UserData = userDataDto(id, undefined, false);
  if (poster) applyImages(ctx, dto, { primary: poster });
  return dto;
}

export function queryResult(items: any[], total = items.length, start = 0): any {
  return { Items: items, TotalRecordCount: total, StartIndex: start };
}
