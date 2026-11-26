import { Readable } from 'node:stream';
import type { App } from '../app.ts';
import { clientIp } from '../app.ts';
import { HttpError, type Ctx } from '../http/router.ts';
import { Ids, keys, normalizeId, parseKey } from '../ids.ts';
import { log } from '../log.ts';
import { imageUrlForTag, isoDate, queryResult, sortName } from './dto.ts';
import { VIEW_LIB_MOVIES, VIEW_LIB_SERIES, VIEW_ROOT, mapLimit, type ViewInfo } from './catalog.ts';

const csv = (v: string | undefined): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const int = (v: string | undefined, d: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined): boolean | undefined => (v === undefined ? undefined : v.toLowerCase() === 'true');

export function registerJellyfinRoutes(app: App): void {
  const r = app.router;
  const { catalog, library, playback, ids } = app;

  // ---------------------------------------------------------------- system
  const publicInfo = () => ({
    LocalAddress: '',
    ServerName: app.cfg.serverName,
    Version: app.cfg.jellyfinVersion,
    ProductName: 'Jellyfin Server',
    OperatingSystem: '',
    Id: app.serverId,
    StartupWizardCompleted: true,
  });
  r.get('/System/Info/Public', (c) => ({ ...publicInfo(), LocalAddress: localAddress(c) }), { public: true });
  r.get('/System/Info', (c) => ({
    ...publicInfo(),
    LocalAddress: localAddress(c),
    OperatingSystemDisplayName: 'Linux',
    PackageName: 'bridgefin',
    HasPendingRestart: false,
    IsShuttingDown: false,
    SupportsLibraryMonitor: false,
    WebSocketPortNumber: app.cfg.port,
    CompletedInstallations: [],
    CanSelfRestart: false,
    CanLaunchWebBrowser: false,
    ProgramDataPath: '/data',
    WebPath: '',
    ItemsByNamePath: '/data',
    CachePath: '/data',
    LogPath: '/data',
    InternalMetadataPath: '/data',
    TranscodingTempPath: '/data',
    CastReceiverApplications: [],
    HasUpdateAvailable: false,
    EncoderLocation: 'NotFound',
    SystemArchitecture: process.arch === 'arm64' ? 'Arm64' : 'X64',
  }));
  r.add(['GET', 'POST'], '/System/Ping', () => 'Jellyfin Server', { public: true });
  r.get('/System/Endpoint', (c) => ({ IsLocal: true, IsInNetwork: true, _ip: clientIp(c.req) }));
  r.get('/Branding/Configuration', () => ({ SplashscreenEnabled: false, LoginDisclaimer: '', CustomCss: '' }), { public: true });
  r.get(['/Branding/Css', '/Branding/Css.css'], (c) => {
    c.res.writeHead(200, { 'content-type': 'text/css' });
    c.res.end('');
  }, { public: true });
  r.get('/QuickConnect/Enabled', () => false, { public: true });
  r.get('/Users/Public', () => [], { public: true });
  r.get('/Localization/Cultures', () => [{ Name: 'English', DisplayName: 'English', TwoLetterISOLanguageName: 'en', ThreeLetterISOLanguageName: 'eng', ThreeLetterISOLanguageNames: ['eng'] }]);
  r.get('/Localization/Countries', () => [{ Name: 'US', DisplayName: 'United States', TwoLetterISORegionName: 'US', ThreeLetterISORegionName: 'USA' }]);
  r.get('/Localization/ParentalRatings', () => []);
  r.get('/Localization/Options', () => [{ Name: 'English', Value: 'en-US' }]);
  r.get(['/Plugins', '/Packages', '/ScheduledTasks', '/Notifications/Types', '/Devices', '/Auth/Keys'], () => []);
  r.get('/web/*', (c) => redirect(c, '/admin'), { public: true });
  r.get(['/', '/web'], (c) => redirect(c, '/admin'), { public: true });
  r.get('/health', () => 'Healthy', { public: true });
  r.get(['/favicon.ico', '/robots.txt'], (c) => {
    c.res.writeHead(c.path.endsWith('.txt') ? 200 : 204, { 'content-type': 'text/plain' });
    c.res.end(c.path.endsWith('.txt') ? 'User-agent: *\nDisallow: /\n' : undefined);
  }, { public: true });

  // ---------------------------------------------------------------- users & auth
  const userDto = () => userObject(app);
  r.post('/Users/AuthenticateByName', (c) => {
    const body = c.body ?? {};
    const username = String(body.Username ?? body.username ?? '');
    const pw = String(body.Pw ?? body.pw ?? body.Password ?? body.password ?? '');
    if (!app.auth.checkPassword(username, pw)) {
      log.warn(`failed login for "${username}" from ${clientIp(c.req)} (${c.auth.client ?? '?'})`);
      throw new HttpError(401, 'Invalid username or password');
    }
    const token = app.auth.issueToken(c.auth);
    log.info(`login: ${c.auth.client ?? '?'} ${c.auth.version ?? ''} on ${c.auth.device ?? '?'}`);
    return {
      User: userDto(),
      SessionInfo: sessionInfo(app, c),
      AccessToken: token,
      ServerId: app.serverId,
    };
  }, { public: true });
  r.post('/Users/AuthenticateWithQuickConnect', () => {
    throw new HttpError(400, 'Quick Connect is not supported');
  }, { public: true });
  r.get(['/Users/Me', '/Users/:uid'], (c) => {
    if (c.params.uid && normalizeId(c.params.uid) !== app.userId) throw new HttpError(404, 'User not found');
    return userDto();
  });
  r.get('/Users', () => [userDto()]);
  r.post(['/Sessions/Logout'], (c) => {
    if (c.token) app.auth.revoke(c.token);
  });
  r.get('/Sessions', (c) => [sessionInfo(app, c)]);
  r.post(['/Sessions/Capabilities', '/Sessions/Capabilities/Full'], () => undefined);
  r.post('/Users/:uid/Configuration', () => undefined);

  // ---------------------------------------------------------------- views
  const viewsResult = () => queryResult(catalog.viewDtos());
  r.get(['/UserViews', '/Users/:uid/Views'], viewsResult);
  r.get('/Library/MediaFolders', viewsResult);
  r.get('/Library/VirtualFolders', () =>
    catalog.views().map((v) => ({ Name: v.name, Locations: [], CollectionType: v.collectionType, ItemId: v.id, LibraryOptions: {} })),
  );
  r.get(['/UserViews/GroupingOptions', '/Users/:uid/GroupingOptions'], () => []);
  r.get(['/DisplayPreferences/:id'], (c) => ({
    Id: c.params.id,
    SortBy: 'SortName',
    RememberIndexing: false,
    PrimaryImageHeight: 250,
    PrimaryImageWidth: 250,
    CustomPrefs: {},
    ScrollDirection: 'Horizontal',
    ShowBackdrop: true,
    RememberSorting: false,
    SortOrder: 'Ascending',
    ShowSidebar: false,
    Client: c.query.client ?? 'emby',
  }));
  r.post('/DisplayPreferences/:id', () => undefined);

  // ---------------------------------------------------------------- items
  r.get(['/Items', '/Users/:uid/Items'], (c) => queryItems(app, c));

  r.get(['/Items/Latest', '/Users/:uid/Items/Latest'], async (c) => {
    const parent = c.query.parentid ? ids.toKey(c.query.parentid) : undefined;
    const limit = int(c.query.limit, 20);
    const items = await catalog.latest(parent, limit);
    return withFields(app, c, items);
  });

  r.get(['/UserItems/Resume', '/Users/:uid/Items/Resume'], async (c) => {
    const limit = int(c.query.limit, 20);
    const types = csv(c.query.includeitemtypes);
    const items = await catalog.resumeItems(limit, types.length ? types : undefined);
    return queryResult(withFields(app, c, items));
  });

  r.get(['/Items/Counts'], () => ({
    MovieCount: library.libraryItems('movie').length,
    SeriesCount: library.libraryItems('series').length,
    EpisodeCount: 0,
    ArtistCount: 0, ProgramCount: 0, TrailerCount: 0, SongCount: 0, AlbumCount: 0, MusicVideoCount: 0, BoxSetCount: 0, BookCount: 0, ItemCount: 0,
  }));

  r.get(['/Items/Filters', '/Items/Filters2'], (c) => {
    const view = c.query.parentid ? viewFor(app, c.query.parentid) : undefined;
    const genres = view ? catalog.catalogGenres(view) : [];
    if (c.path.toLowerCase().endsWith('filters2')) return { Genres: genres.map((g) => ({ Name: g, Id: hashId(`genre:${g}`) })), Tags: [], AudioLanguages: [], SubtitleLanguages: [] };
    return { Genres: genres, OfficialRatings: [], Years: [], Tags: [] };
  });

  r.get('/Genres', (c) => {
    const view = c.query.parentid ? viewFor(app, c.query.parentid) : undefined;
    const names = view ? catalog.catalogGenres(view) : allGenres(app);
    const items = names.map((g) => ({
      Name: g,
      ServerId: app.serverId,
      Id: hashId(`genre:${g}`),
      Type: 'Genre',
      IsFolder: false,
      ImageTags: {},
      BackdropImageTags: [],
      LocationType: 'Remote',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: g, ItemId: hashId(`genre:${g}`) },
    }));
    return queryResult(items);
  });
  r.get(['/Persons', '/Studios', '/Artists', '/MusicGenres', '/Years'], () => queryResult([]));

  r.get('/Search/Hints', async (c) => {
    const term = c.query.searchterm ?? '';
    if (!term.trim()) return { SearchHints: [], TotalRecordCount: 0 };
    const types = typesFrom(c.query.includeitemtypes);
    const items = await catalog.search(term, types);
    const limit = int(c.query.limit, 40);
    const hints = items.slice(0, limit).map((i) => ({
      ItemId: i.Id,
      Id: i.Id,
      Name: i.Name,
      ProductionYear: i.ProductionYear,
      PrimaryImageTag: i.ImageTags?.Primary,
      ThumbImageTag: i.ImageTags?.Thumb,
      ThumbImageItemId: i.Id,
      BackdropImageTag: i.BackdropImageTags?.[0],
      BackdropImageItemId: i.Id,
      Type: i.Type,
      IsFolder: i.IsFolder,
      RunTimeTicks: i.RunTimeTicks,
      MediaType: i.MediaType,
      Artists: [],
      ChannelId: null,
      PrimaryImageAspectRatio: i.PrimaryImageAspectRatio,
    }));
    return { SearchHints: hints, TotalRecordCount: hints.length };
  });

  const getItem = async (c: Ctx) => {
    const id = c.params.id;
    const dto = await catalog.itemById(id, true);
    if (!dto) throw new HttpError(404, 'Item not found');
    if (dto.Type === 'Movie' || dto.Type === 'Episode') {
      const sources = await playback.sourcesForItem(dto.Id);
      dto.MediaSources = sources?.length ? sources : [playback.placeholderSource(dto.Id, dto.RunTimeTicks)];
      dto.MediaStreams = dto.MediaSources[0]?.MediaStreams ?? [];
    }
    return dto;
  };
  r.get(['/Items/:id', '/Users/:uid/Items/:id'], getItem);

  r.get(['/Items/:id/Ancestors'], async (c) => {
    const key = ids.toKey(c.params.id);
    if (!key) return [];
    const k = parseKey(key);
    const out: any[] = [];
    if (k.kind === 'episode' || k.kind === 'season') {
      const seriesDto = await catalog.itemByKey(keys.series(k.stremioId!), false);
      if (k.kind === 'episode') {
        const m = await app.addons.meta('series', k.stremioId!);
        const v = m?.videos?.find((x) => x.id === k.videoId);
        const season = await catalog.itemByKey(keys.season(k.stremioId!, v?.season ?? 0), false);
        if (season) out.push(season);
      }
      if (seriesDto) out.push(seriesDto);
    }
    const viewKey = k.kind === 'movie' ? VIEW_LIB_MOVIES : VIEW_LIB_SERIES;
    const view = await catalog.itemByKey(viewKey, false);
    if (view) out.push(view);
    return out;
  });

  const empty = () => queryResult([]);
  r.get(['/Items/:id/Similar', '/Movies/:id/Similar', '/Shows/:id/Similar'], empty);
  r.get(['/Items/:id/Intros', '/Users/:uid/Items/:id/Intros'], empty);
  r.get(['/Items/:id/SpecialFeatures', '/Users/:uid/Items/:id/SpecialFeatures', '/Items/:id/LocalTrailers', '/Users/:uid/Items/:id/LocalTrailers'], () => []);
  r.get(['/Items/:id/ThemeMedia', '/Items/:id/ThemeSongs', '/Items/:id/ThemeVideos'], (c) => {
    const one = { Items: [], TotalRecordCount: 0, StartIndex: 0, OwnerId: c.params.id };
    return c.path.toLowerCase().endsWith('thememedia') ? { ThemeVideosResult: one, ThemeSongsResult: one, SoundtrackSongsResult: one } : one;
  });
  r.get(['/Items/:id/CriticReviews', '/Items/:id/ExternalIdInfos', '/Items/:id/RemoteImages/Providers'], () => []);
  r.get(['/MediaSegments/:id', '/Episode/:id/IntroTimestamps', '/Episode/:id/IntroSkipperSegments'], () => queryResult([]));
  r.post(['/Items/:id/Refresh'], () => undefined);
  r.get(['/Playlists/:id/Items', '/Collections/:id/Items'], empty);
  r.get(['/LiveTv/Info'], () => ({ Services: [], IsEnabled: false, EnabledUsers: [] }));
  r.get(['/LiveTv/Channels', '/LiveTv/Programs', '/LiveTv/Programs/Recommended', '/LiveTv/Recordings', '/LiveTv/Timers', '/Channels'], empty);
  r.get('/Movies/Recommendations', () => []);

  // ---------------------------------------------------------------- shows
  r.get('/Shows/NextUp', async (c) => {
    const limit = int(c.query.limit, 20);
    let seriesKey: string | undefined;
    if (c.query.seriesid) seriesKey = ids.toKey(c.query.seriesid);
    const items = await catalog.nextUp(limit, seriesKey);
    return queryResult(withFields(app, c, items));
  });
  r.get('/Shows/Upcoming', async (c) => {
    const limit = int(c.query.limit, 30);
    const out: { t: number; dto: any }[] = [];
    await mapLimit(library.libraryItems('series'), 4, async (s) => {
      const m = await app.addons.meta('series', parseKey(s.key).stremioId!);
      for (const v of m?.videos ?? []) {
        const t = Date.parse(v.released ?? '');
        if (!Number.isNaN(t) && t > Date.now() && t < Date.now() + 60 * 86400_000 && (v.season ?? 0) > 0) {
          const dto = await catalog.itemByKey(keys.episode(m!.id, v.id), false);
          if (dto) out.push({ t, dto });
        }
      }
    });
    out.sort((a, b) => a.t - b.t);
    return queryResult(out.slice(0, limit).map((x) => x.dto));
  });
  r.get('/Shows/:id/Seasons', async (c) => {
    const k = seriesKeyOf(app, c.params.id);
    return queryResult(withFields(app, c, await catalog.seasons(k)));
  });
  r.get('/Shows/:id/Episodes', async (c) => {
    const sid = seriesKeyOf(app, c.params.id);
    let season: number | undefined;
    if (c.query.seasonid) {
      const sk = ids.toKey(c.query.seasonid);
      if (sk) season = parseKey(sk).season;
    } else if (c.query.season) season = int(c.query.season, 0);
    let eps = await catalog.episodes(sid, season);
    if (c.query.startitemid) {
      const i = eps.findIndex((e) => e.Id === normalizeId(c.query.startitemid));
      if (i > 0) eps = eps.slice(i);
    }
    if (bool(c.query.isvirtualunaired) === false || bool(c.query.ismissing) === false) eps = eps.filter((e) => e.LocationType !== 'Virtual');
    const start = int(c.query.startindex, 0);
    const limit = int(c.query.limit, eps.length);
    return queryResult(withFields(app, c, eps.slice(start, start + limit)), eps.length, start);
  });

  // ---------------------------------------------------------------- playback
  const pbInfo = async (c: Ctx) => {
    const msid = c.query.mediasourceid ?? c.body?.MediaSourceId;
    return playback.playbackInfo(normalizeId(c.params.id) ?? c.params.id, msid);
  };
  r.add(['GET', 'POST'], '/Items/:id/PlaybackInfo', pbInfo);

  const stream = async (c: Ctx) => {
    const id = normalizeId(c.params.id);
    if (!id) throw new HttpError(404, 'Item not found');
    const msid = c.query.mediasourceid ?? c.query.tag;
    // Infuse sometimes requests streams without a token. Allow that only for version ids
    // this server issued (unguessable), never for "best available" on a bare item id.
    if (!c.token) {
      const src = msid ? app.streams.source(msid.replace(/-/g, '').toLowerCase()) : undefined;
      if (!src || ids.toId(src.itemKey) !== id) throw new HttpError(401, 'Unauthorized');
    }
    await playback.stream(c.req, c.res, id, msid, clientIp(c.req));
  };
  r.add(['GET', 'HEAD'], ['/Videos/:id/stream', '/Videos/:id/stream.:ext', '/Items/:id/Download', '/Videos/:id/:ignored/stream', '/Videos/:id/:ignored/stream.:ext'], stream, { public: true });
  r.get('/Videos/:id/AdditionalParts', () => queryResult([]));
  // Swiftfin measures bandwidth before every playback; it fails if this is missing.
  r.get('/Playback/BitrateTest', (c) => {
    const size = Math.min(Math.max(int(c.query.size, 500_000), 1), 10_000_000);
    c.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store' });
    c.res.end(Buffer.alloc(size));
  });
  r.get(['/Videos/:id/master.m3u8', '/Videos/:id/main.m3u8'], () => {
    throw new HttpError(400, 'Transcoding is not supported by Bridgefin; enable direct play');
  });

  const subtitle = async (c: Ctx) => {
    const { body, type } = await playback.subtitleFile(normalizeId(c.params.id) ?? c.params.id, c.params.msid, int(c.params.index, -1), c.params.fmt ?? 'srt');
    c.res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
    c.res.end(body);
  };
  r.get(
    ['/Videos/:id/:msid/Subtitles/:index/Stream.:fmt', '/Videos/:id/:msid/Subtitles/:index/:ticks/Stream.:fmt'],
    subtitle,
    { public: true },
  );

  r.post(['/Sessions/Playing', '/Sessions/Playing/Progress', '/Sessions/Playing/Stopped', '/Sessions/Playing/Ping'], (c) => {
    const b = c.body ?? {};
    const itemId = normalizeId(b.ItemId ?? b.itemId ?? c.query.itemid);
    if (!itemId) return undefined;
    const key = ids.toKey(itemId);
    if (!key) return undefined;
    const pos = Number(b.PositionTicks ?? b.positionTicks ?? c.query.positionticks ?? 0);
    const stopped = c.path.toLowerCase().endsWith('/stopped');
    if (c.path.toLowerCase().endsWith('/ping')) return undefined;
    void reportProgress(app, key, pos, stopped);
    return undefined;
  });
  // Legacy per-user playback reporting
  r.add(['POST', 'DELETE'], ['/Users/:uid/PlayingItems/:id', '/PlayingItems/:id', '/Users/:uid/PlayingItems/:id/Progress', '/PlayingItems/:id/Progress'], (c) => {
    const key = ids.toKey(c.params.id);
    if (!key) return undefined;
    const pos = Number(c.query.positionticks ?? 0);
    void reportProgress(app, key, pos, c.method === 'DELETE');
    return undefined;
  });

  // ---------------------------------------------------------------- user data
  const favorite = (on: boolean) => async (c: Ctx) => {
    const key = ids.toKey(c.params.id);
    if (!key) throw new HttpError(404, 'Item not found');
    const k = parseKey(key);
    if (k.kind === 'movie' || k.kind === 'series') {
      const m = await catalog.metaFor(k.kind, k.stremioId!, false);
      library.setInLibrary(key, k.kind, m?.name ?? '', m?.poster, on);
    }
    const dto = await catalog.itemByKey(key, false);
    return dto?.UserData ?? {};
  };
  r.post(['/UserFavoriteItems/:id', '/Users/:uid/FavoriteItems/:id'], favorite(true));
  r.del(['/UserFavoriteItems/:id', '/Users/:uid/FavoriteItems/:id'], favorite(false));

  const played = (on: boolean) => async (c: Ctx) => {
    const key = ids.toKey(c.params.id);
    if (!key) throw new HttpError(404, 'Item not found');
    await markPlayed(app, key, on);
    const dto = await catalog.itemByKey(key, false);
    return dto?.UserData ?? {};
  };
  r.post(['/UserPlayedItems/:id', '/Users/:uid/PlayedItems/:id'], played(true));
  r.del(['/UserPlayedItems/:id', '/Users/:uid/PlayedItems/:id'], played(false));

  r.get(['/UserItems/:id/UserData', '/Users/:uid/Items/:id/UserData'], async (c) => {
    const dto = await catalog.itemById(c.params.id, false);
    if (!dto) throw new HttpError(404, 'Item not found');
    return dto.UserData;
  });
  r.post(['/UserItems/:id/UserData', '/Users/:uid/Items/:id/UserData'], async (c) => {
    const key = ids.toKey(c.params.id);
    if (!key) throw new HttpError(404, 'Item not found');
    const b = c.body ?? {};
    const k = parseKey(key);
    if (b.IsFavorite !== undefined && (k.kind === 'movie' || k.kind === 'series')) {
      const m = await catalog.metaFor(k.kind, k.stremioId!, false);
      library.setInLibrary(key, k.kind, m?.name ?? '', m?.poster, !!b.IsFavorite);
    }
    if (b.Played !== undefined) await markPlayed(app, key, !!b.Played);
    if (b.PlaybackPositionTicks !== undefined && !b.Played) {
      const dto = await catalog.itemByKey(key, false);
      library.reportProgress(key, parentKeyOf(key), Number(b.PlaybackPositionTicks), dto?.RunTimeTicks ?? 0, true);
    }
    const dto = await catalog.itemByKey(key, false);
    return dto?.UserData ?? {};
  });
  r.del(['/UserItems/:id/Rating', '/Users/:uid/Items/:id/Rating'], () => ({}));
  r.post(['/UserItems/:id/Rating', '/Users/:uid/Items/:id/Rating'], () => ({}));

  // ---------------------------------------------------------------- images
  const image = async (c: Ctx) => {
    const type = (c.params.type ?? 'Primary').toLowerCase();
    let url = c.query.tag ? imageUrlForTag(app.db, c.query.tag) : undefined;
    if (!url) {
      const dto = await catalog.itemById(c.params.id, false).catch(() => undefined);
      const tag =
        type === 'backdrop'
          ? dto?.BackdropImageTags?.[int(c.params.index, 0)] ?? dto?.ParentBackdropImageTags?.[0]
          : dto?.ImageTags?.[cap(type)];
      if (tag) url = imageUrlForTag(app.db, tag);
    }
    if (!url) throw new HttpError(404, 'Image not found');
    const upstream = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Bridgefin/0.1' } });
    if (!upstream.ok || !upstream.body) throw new HttpError(404, 'Image not available');
    c.res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
      ...(upstream.headers.get('content-length') ? { 'content-length': upstream.headers.get('content-length')! } : {}),
      'cache-control': 'public, max-age=604800',
    });
    if (c.method === 'HEAD') {
      c.res.end();
      await upstream.body.cancel();
      return;
    }
    Readable.fromWeb(upstream.body as any).pipe(c.res);
  };
  r.add(['GET', 'HEAD'], ['/Items/:id/Images/:type', '/Items/:id/Images/:type/:index', '/Items/:id/Images/:type/:index/:tag/:format/:maxWidth/:maxHeight/:percentPlayed/:unplayedCount'], image, { public: true });
  r.get(['/Users/:uid/Images/:type', '/Persons/:name/Images/:type', '/Genres/:name/Images/:type', '/Studios/:name/Images/:type'], () => {
    throw new HttpError(404, 'No image');
  }, { public: true });
  r.get('/Items/:id/Images', async (c) => {
    const dto = await catalog.itemById(c.params.id, false);
    if (!dto) return [];
    const out: any[] = [];
    for (const [t, tag] of Object.entries(dto.ImageTags ?? {})) out.push({ ImageType: t, ImageTag: tag, ImageIndex: null });
    (dto.BackdropImageTags ?? []).forEach((tag: string, i: number) => out.push({ ImageType: 'Backdrop', ImageTag: tag, ImageIndex: i }));
    return out;
  });
}

// ====================================================================== helpers

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function hashId(s: string): string {
  return Ids.hash(s);
}

function redirect(c: Ctx, to: string): void {
  c.res.writeHead(302, { location: to });
  c.res.end();
}

function localAddress(c: Ctx): string {
  const host = c.req.headers.host;
  return host ? `http://${host}` : '';
}

function userObject(app: App): any {
  return {
    Name: app.auth.username(),
    ServerId: app.serverId,
    Id: app.userId,
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    LastLoginDate: isoDate(Date.now()),
    LastActivityDate: isoDate(Date.now()),
    Configuration: {
      PlayDefaultAudioTrack: true,
      SubtitleLanguagePreference: '',
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      SubtitleMode: 'Default',
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: true,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
      CastReceiverId: 'F007D354',
    },
    Policy: {
      IsAdministrator: true,
      IsHidden: true,
      EnableCollectionManagement: false,
      EnableSubtitleManagement: false,
      EnableLyricManagement: false,
      IsDisabled: false,
      BlockedTags: [],
      AllowedTags: [],
      EnableUserPreferenceAccess: true,
      AccessSchedules: [],
      BlockUnratedItems: [],
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false,
      EnablePlaybackRemuxing: false,
      ForceRemoteSourceTranscoding: false,
      EnableContentDeletion: false,
      EnableContentDeletionFromFolders: [],
      EnableContentDownloading: true,
      EnableSyncTranscoding: false,
      EnableMediaConversion: false,
      EnabledDevices: [],
      EnableAllDevices: true,
      EnabledChannels: [],
      EnableAllChannels: true,
      EnabledFolders: [],
      EnableAllFolders: true,
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: -1,
      MaxActiveSessions: 0,
      EnablePublicSharing: false,
      BlockedMediaFolders: [],
      BlockedChannels: [],
      RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
      PasswordResetProviderId: 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
      SyncPlayAccess: 'None',
    },
  };
}

function sessionInfo(app: App, c: Ctx): any {
  return {
    PlayState: { CanSeek: false, IsPaused: false, IsMuted: false, RepeatMode: 'RepeatNone', PlaybackOrder: 'Default' },
    AdditionalUsers: [],
    Capabilities: { PlayableMediaTypes: [], SupportedCommands: [], SupportsMediaControl: false, SupportsPersistentIdentifier: true },
    RemoteEndPoint: clientIp(c.req),
    PlayableMediaTypes: [],
    Id: hashId(`session:${c.auth.deviceId ?? 'unknown'}`),
    UserId: app.userId,
    UserName: app.auth.username(),
    Client: c.auth.client ?? 'Unknown',
    LastActivityDate: isoDate(Date.now()),
    LastPlaybackCheckIn: '0001-01-01T00:00:00.0000000Z',
    DeviceName: c.auth.device ?? 'Unknown',
    DeviceId: c.auth.deviceId ?? 'unknown',
    ApplicationVersion: c.auth.version ?? '',
    IsActive: true,
    SupportsMediaControl: false,
    SupportsRemoteControl: false,
    NowPlayingQueue: [],
    NowPlayingQueueFullItems: [],
    HasCustomDeviceName: false,
    ServerId: app.serverId,
    SupportedCommands: [],
  };
}

function viewFor(app: App, id: string): ViewInfo | undefined {
  const key = app.ids.toKey(id);
  return key ? app.catalog.viewByKey(key) : undefined;
}

function allGenres(app: App): string[] {
  const set = new Set<string>();
  for (const v of app.catalog.views()) for (const g of app.catalog.catalogGenres(v)) set.add(g);
  return [...set];
}

function typesFrom(includeItemTypes: string | undefined): string[] {
  const t = csv(includeItemTypes).map((x) => x.toLowerCase());
  if (!t.length) return ['movie', 'series'];
  const out: string[] = [];
  if (t.includes('movie')) out.push('movie');
  if (t.includes('series') || t.includes('episode')) out.push('series');
  return out;
}

function seriesKeyOf(app: App, id: string): string {
  const key = app.ids.toKey(id);
  if (!key) throw new HttpError(404, 'Series not found');
  const k = parseKey(key);
  if (k.kind !== 'series' && k.kind !== 'season' && k.kind !== 'episode') throw new HttpError(400, 'Not a series');
  return k.stremioId!;
}

export function parentKeyOf(key: string): string | null {
  const k = parseKey(key);
  return k.kind === 'episode' ? keys.series(k.stremioId!) : null;
}

async function reportProgress(app: App, key: string, positionTicks: number, stopped: boolean): Promise<void> {
  try {
    const dto = await app.catalog.itemByKey(key, false);
    app.library.reportProgress(key, parentKeyOf(key), positionTicks, dto?.RunTimeTicks ?? 0, stopped);
  } catch (e) {
    log.warn('progress report failed', e);
  }
}

async function markPlayed(app: App, key: string, on: boolean): Promise<void> {
  const k = parseKey(key);
  if (k.kind === 'movie' || k.kind === 'episode') {
    app.library.setPlayed(key, parentKeyOf(key), on);
    return;
  }
  // Series/season: mark every released episode.
  if (k.kind === 'series' || k.kind === 'season') {
    const m = await app.addons.meta('series', k.stremioId!);
    for (const v of m?.videos ?? []) {
      if ((v.season ?? 0) === 0 && k.kind === 'series') continue;
      if (k.kind === 'season' && v.season !== k.season) continue;
      const rel = Date.parse(v.released ?? '');
      if (on && !Number.isNaN(rel) && rel > Date.now()) continue;
      app.library.setPlayed(keys.episode(k.stremioId!, v.id), keys.series(k.stremioId!), on);
    }
  }
}

function wantsField(c: Ctx, f: string): boolean {
  return csv(c.query.fields).some((x) => x.toLowerCase() === f.toLowerCase());
}

/** Adds placeholder media sources to list results when the client asks for them. */
function withFields(app: App, c: Ctx, items: any[]): any[] {
  if (!wantsField(c, 'MediaSources')) return items;
  for (const it of items) {
    if ((it.Type === 'Movie' || it.Type === 'Episode') && !it.MediaSources) {
      // Real versions if they were looked up recently (no network here), else one placeholder
      // that plays the best version.
      const key = app.ids.toKey(it.Id);
      const warm = key ? app.streams.peek(key) : undefined;
      it.MediaSources = warm?.length
        ? warm.map((s) => app.playback.mediaSource(it.Id, { itemKey: key!, type: 'movie', videoId: '', runtimeTicks: it.RunTimeTicks }, s, []))
        : [app.playback.placeholderSource(it.Id, it.RunTimeTicks)];
      it.MediaStreams = it.MediaSources[0].MediaStreams ?? [];
    }
  }
  return items;
}

function sortItems(items: any[], sortBy: string[], order: string[]): any[] {
  if (!sortBy.length) return items;
  const desc = (order[0] ?? 'Ascending').toLowerCase().startsWith('desc');
  const keyFn = (it: any, s: string): any => {
    switch (s.toLowerCase()) {
      case 'sortname':
      case 'name':
        return it.SortName ?? sortName(it.Name ?? '');
      case 'datecreated':
        return it.DateCreated ?? '';
      case 'premieredate':
        return it.PremiereDate ?? '';
      case 'productionyear':
        return it.ProductionYear ?? 0;
      case 'communityrating':
        return it.CommunityRating ?? 0;
      case 'dateplayed':
      case 'datelastcontentadded':
        return it.UserData?.LastPlayedDate ?? '';
      case 'runtime':
        return it.RunTimeTicks ?? 0;
      case 'random':
        return Math.random();
      default:
        return undefined;
    }
  };
  const s = sortBy[0];
  const sorted = [...items].sort((a, b) => {
    const x = keyFn(a, s), y = keyFn(b, s);
    if (x === undefined || y === undefined) return 0;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return desc ? sorted.reverse() : sorted;
}

function applyFilters(items: any[], c: Ctx): any[] {
  const filters = csv(c.query.filters).map((f) => f.toLowerCase());
  let out = items;
  if (filters.includes('isfavorite') || bool(c.query.isfavorite) === true) out = out.filter((i) => i.UserData?.IsFavorite);
  if (filters.includes('isplayed') || bool(c.query.isplayed) === true) out = out.filter((i) => i.UserData?.Played);
  if (filters.includes('isunplayed') || bool(c.query.isplayed) === false) out = out.filter((i) => !i.UserData?.Played);
  if (filters.includes('isresumable')) out = out.filter((i) => (i.UserData?.PlaybackPositionTicks ?? 0) > 0);
  const genres = csv(c.query.genres?.replace(/\|/g, ','));
  if (genres.length) out = out.filter((i) => (i.Genres ?? []).some((g: string) => genres.includes(g)));
  const years = csv(c.query.years).map(Number);
  if (years.length) out = out.filter((i) => years.includes(i.ProductionYear));
  const types = csv(c.query.includeitemtypes).map((t) => t.toLowerCase());
  if (types.length) out = out.filter((i) => types.includes(String(i.Type).toLowerCase()));
  const nameStarts = c.query.namestartswith?.toLowerCase();
  if (nameStarts) out = out.filter((i) => (i.SortName ?? '').startsWith(nameStarts));
  return out;
}

function page(items: any[], c: Ctx): any {
  const start = int(c.query.startindex, 0);
  const limit = int(c.query.limit, items.length);
  return queryResult(withFieldsNoop(items.slice(start, start + limit)), items.length, start);
}
const withFieldsNoop = (x: any[]) => x;

/** GET /Items — the workhorse used for browsing, search, favorites and Library Mode scans. */
async function queryItems(app: App, c: Ctx): Promise<any> {
  const { catalog, ids } = app;
  const q = c.query;
  const sortBy = csv(q.sortby);
  const order = csv(q.sortorder);
  const types = csv(q.includeitemtypes).map((t) => t.toLowerCase());

  // Explicit ids
  if (q.ids) {
    const items = (await Promise.all(csv(q.ids).map((id) => catalog.itemById(id, false).catch(() => undefined)))).filter(Boolean);
    return queryResult(withFields(app, c, items));
  }

  // Lookup by external ids (Infuse uses AnyProviderIdEquals=Imdb.tt…,Tmdb.…)
  if (q.anyprovideridequals) {
    const items = await catalog.byProviderIds(q.anyprovideridequals, typesFrom(q.includeitemtypes));
    return queryResult(withFields(app, c, items));
  }

  // Search
  if (q.searchterm) {
    if (types.length && !types.some((t) => t === 'movie' || t === 'series')) return queryResult([]);
    const items = await catalog.search(q.searchterm, typesFrom(q.includeitemtypes));
    return page(withFields(app, c, applyFilters(items, c)), c);
  }

  const parentKey = q.parentid ? ids.toKey(q.parentid) : undefined;
  const filters = csv(q.filters).map((f) => f.toLowerCase());

  // Resumable shortcut
  if (filters.includes('isresumable') && !parentKey) {
    const items = await catalog.resumeItems(int(q.limit, 50));
    return queryResult(withFields(app, c, items));
  }

  if (parentKey) {
    const pk = parseKey(parentKey);
    if (parentKey === VIEW_ROOT) return queryResult(catalog.viewDtos());
    if (pk.kind === 'series') {
      if (types.includes('episode') || bool(q.recursive)) {
        const eps = await catalog.episodes(pk.stremioId!);
        return page(withFields(app, c, applyFilters(eps, c)), c);
      }
      return page(withFields(app, c, await catalog.seasons(pk.stremioId!)), c);
    }
    if (pk.kind === 'season') {
      const eps = await catalog.episodes(pk.stremioId!, pk.season);
      return page(withFields(app, c, eps), c);
    }
    const viewInfo = catalog.viewByKey(parentKey);
    if (viewInfo && types.length && types.every((t) => t === 'episode' || t === 'season')) {
      // Infuse Library Mode: every season / episode under a library.
      if (viewInfo.collectionType !== 'tvshows') return queryResult([]);
      const kind = types.includes('episode') ? 'episode' : 'season';
      let all = await catalog.viewChildren(viewInfo, kind);
      if (csv(q.excludelocationtypes).some((t) => t.toLowerCase() === 'virtual')) all = all.filter((i) => i.LocationType !== 'Virtual');
      return page(withFields(app, c, applyFilters(all, c)), c);
    }
    if (parentKey === VIEW_LIB_MOVIES || parentKey === VIEW_LIB_SERIES) {
      const isMovies = parentKey === VIEW_LIB_MOVIES;
      let items = await catalog.libraryItems(isMovies ? 'movie' : 'series', q.parentid ? normalizeId(q.parentid) : undefined);
      items = sortItems(applyFilters(items, c), sortBy, order);
      return page(withFields(app, c, items), c);
    }
    const view = viewInfo;
    if (view?.catalog) {
      const start = int(q.startindex, 0);
      const limit = int(q.limit, 100);
      const genre = csv(q.genres?.replace(/\|/g, ','))[0] ?? (q.genreids ? genreName(app, view, q.genreids) : undefined);
      const { items, total } = await catalog.catalogItems(view, start, Math.min(limit, 500), genre);
      // Only filter on user-data in catalog views (genre/type already applied by the addon).
      const filtered = filters.length ? items.filter((i) => applyFilters([i], { ...c, query: { ...q, genres: undefined as any, includeitemtypes: undefined as any } } as Ctx).length) : items;
      return queryResult(withFields(app, c, filtered), total, start);
    }
    return queryResult([]);
  }

  // No parent: favorites / recursive library scans.
  const wantMovies = !types.length || types.includes('movie');
  const wantSeries = !types.length || types.includes('series');
  const wantEpisodes = types.includes('episode');
  let items: any[] = [];
  if (wantMovies) items.push(...(await catalog.libraryItems('movie')));
  if (wantSeries) items.push(...(await catalog.libraryItems('series')));
  if (wantEpisodes && filters.includes('isfavorite') === false) {
    // Episodes without parent are only requested for "played/recent" style queries; serve recently played.
    const recent = app.library.recentlyPlayed(int(q.limit, 50)).filter((r) => parseKey(r.key).kind === 'episode');
    for (const r of recent) {
      const dto = await catalog.itemByKey(r.key, false).catch(() => undefined);
      if (dto) items.push(dto);
    }
  }
  if (!types.length && !filters.length && bool(q.recursive) !== true && !q.isfavorite) {
    return queryResult(catalog.viewDtos());
  }
  items = sortItems(applyFilters(items, c), sortBy, order);
  return page(withFields(app, c, items), c);
}

function genreName(app: App, view: ViewInfo, genreIds: string): string | undefined {
  const wanted = csv(genreIds.replace(/\|/g, ',')).map((g) => normalizeId(g));
  return app.catalog.catalogGenres(view).find((g) => wanted.includes(Ids.hash(`genre:${g}`)));
}
