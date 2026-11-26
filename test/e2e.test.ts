import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, startServer, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { setLogLevel } from '../src/log.ts';
import { setSetting } from '../src/db.ts';

setLogLevel('error');

const HASH_CACHED = 'a'.repeat(40);
const HASH_UNCACHED = 'b'.repeat(40);
const HASH_EP = 'c'.repeat(40);

// ------------------------------------------------------------------ mock addon + CDN
let mockBase = '';
const mock = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const json = (o: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const p = decodeURIComponent(url.pathname);
  if (p === '/manifest.json') {
    return json({
      id: 'test.addon',
      name: 'TestAddon',
      version: '1.0.0',
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      resources: ['catalog', 'meta', 'stream', 'subtitles'],
      catalogs: [
        { type: 'movie', id: 'top', name: 'Top', extra: [{ name: 'search' }, { name: 'skip' }, { name: 'genre', options: ['Action', 'Drama'] }] },
        { type: 'series', id: 'top', name: 'Top', extra: [{ name: 'search' }] },
      ],
    });
  }
  if (p.startsWith('/catalog/movie/top')) {
    if (p.includes('search=')) return json({ metas: [{ id: 'tt0000001', type: 'movie', name: 'Mock Movie', poster: `${mockBase}/img/p.jpg` }] });
    if (p.includes('skip=')) return json({ metas: [] });
    const genre = /genre=([^&.]+)/.exec(p)?.[1];
    const metas = [
      { id: 'tt0000001', type: 'movie', name: 'Mock Movie', poster: `${mockBase}/img/p.jpg`, genres: ['Action'] },
      { id: 'tt0000003', type: 'movie', name: 'Other Movie', poster: `${mockBase}/img/p.jpg`, genres: ['Drama'] },
    ];
    return json({ metas: genre ? metas.filter((m) => m.genres.includes(genre)) : metas });
  }
  if (p.startsWith('/catalog/series/top')) return json({ metas: [{ id: 'tt0000002', type: 'series', name: 'Mock Show', poster: `${mockBase}/img/p.jpg` }] });
  if (p === '/meta/movie/tt0000001.json')
    return json({ meta: { id: 'tt0000001', type: 'movie', name: 'Mock Movie', runtime: '100 min', releaseInfo: '2020', description: 'desc', imdbRating: '7.5', genres: ['Action'], cast: ['A B'], director: ['D'], poster: `${mockBase}/img/p.jpg`, background: `${mockBase}/img/b.jpg`, trailerStreams: [{ ytId: 'abc', title: 't' }] } });
  if (p === '/meta/movie/tt0000003.json') return json({ meta: { id: 'tt0000003', type: 'movie', name: 'Other Movie', runtime: '90 min' } });
  if (p === '/meta/series/tt0000002.json')
    return json({
      meta: {
        id: 'tt0000002',
        type: 'series',
        name: 'Mock Show',
        runtime: '45 min',
        poster: `${mockBase}/img/p.jpg`,
        videos: [
          { id: 'tt0000002:1:1', title: 'Pilot', season: 1, episode: 1, released: '2020-01-01T00:00:00.000Z' },
          { id: 'tt0000002:1:2', title: 'Second', season: 1, episode: 2, released: '2020-01-08T00:00:00.000Z' },
          { id: 'tt0000002:2:1', title: 'S2 Opener', season: 2, episode: 1, released: '2021-01-01T00:00:00.000Z' },
          { id: 'tt0000002:2:2', title: 'Future', season: 2, episode: 2, released: '2999-01-01T00:00:00.000Z' },
          { id: 'tt0000002:0:1', title: 'Special', season: 0, episode: 1, released: '2020-06-01T00:00:00.000Z' },
        ],
      },
    });
  if (p === '/stream/movie/tt0000001.json')
    return json({
      streams: [
        { name: 'TestAddon\n1080p', title: 'Mock.Movie.2020.1080p.WEB-DL.x264.mkv\n💾 2.1 GB', url: `${mockBase}/resolve/1` },
        { name: '[TB download] TestAddon 4K', title: 'Mock.Movie.2160p.mkv', url: `${mockBase}/resolve/2` },
        { name: 'TestAddon\n2160p', title: 'Mock.Movie.2020.2160p.BluRay.REMUX.HEVC.DV.TrueHD.Atmos.7.1.mkv\n💾 58 GB', infoHash: HASH_CACHED, fileIdx: 0 },
        { name: 'TestAddon\n720p', title: 'Mock.Movie.720p.mkv', infoHash: HASH_UNCACHED },
        { name: 'TestAddon CAM', title: 'Mock.Movie.HDCAM.mkv', url: `${mockBase}/resolve/3` },
      ],
    });
  if (p === '/stream/series/tt0000002:1:2.json')
    return json({ streams: [{ name: 'TestAddon\n1080p', title: 'Mock.Show.S01.1080p.mkv', infoHash: HASH_EP }] });
  if (p === '/stream/series/tt0000002:1:1.json' || p === '/stream/series/tt0000002:2:1.json') {
    const ep = p.includes(':2:1') ? 's2e1' : 's1e1';
    return json({
      streams: [
        { name: 'TestAddon\n2160p', title: `Mock.Show.${ep}.2160p.WEB-DL.mkv`, url: `${mockBase}/resolve/${ep}-4k`, behaviorHints: { bingeGroup: 'grp-4k' } },
        { name: 'TestAddon\n720p', title: `Mock.Show.${ep}.720p.WEBRip.mkv`, url: `${mockBase}/resolve/${ep}-sd`, behaviorHints: { bingeGroup: 'grp-720' } },
      ],
    });
  }
  if (p.startsWith('/stream/')) return json({ streams: [] });
  if (p.startsWith('/subtitles/')) return json({ subtitles: [{ id: 's1', url: `${mockBase}/sub/1.srt`, lang: 'eng' }, { id: 's2', url: `${mockBase}/sub/2.srt`, lang: 'fre' }] });
  if (p.startsWith('/resolve/')) {
    res.writeHead(302, { location: `${mockBase}/cdn/resolved${p.slice(-2)}.mkv` });
    return res.end();
  }
  if (p.startsWith('/cdn/')) {
    const body = Buffer.alloc(1000, 7);
    const range = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ''));
    if (range) {
      const s = Number(range[1]);
      const e = range[2] ? Number(range[2]) : body.length - 1;
      res.writeHead(206, { 'content-type': 'video/x-matroska', 'content-range': `bytes ${s}-${e}/${body.length}`, 'content-length': e - s + 1, 'accept-ranges': 'bytes' });
      return res.end(req.method === 'HEAD' ? undefined : body.subarray(s, e + 1));
    }
    res.writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': body.length, 'accept-ranges': 'bytes' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  if (p.startsWith('/sub/')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  }
  if (p.startsWith('/img/')) {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(Buffer.alloc(10));
  }
  res.writeHead(404);
  res.end();
});

// ------------------------------------------------------------------ mock TorBox
const torboxCalls: string[] = [];
const mockFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.torbox.app/')) return fetch(input, init);
  const u = new URL(url);
  torboxCalls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
  const ok = (data: unknown) => new Response(JSON.stringify({ success: true, error: null, detail: 'ok', data }), { headers: { 'content-type': 'application/json' } });
  if (u.pathname.endsWith('/torrents/checkcached')) {
    const hashes: string[] = JSON.parse(String(init?.body)).hashes;
    return ok(hashes.filter((h) => h === HASH_CACHED || h === HASH_EP).map((h) => ({ hash: h, name: 'x', size: 100, files: [{ id: 0, name: 'Mock.Movie.mkv', size: 62277025792 }] })));
  }
  if (u.pathname.endsWith('/torrents/createtorrent')) return ok({ torrent_id: 77, hash: HASH_CACHED, auth_id: 'x' });
  if (u.pathname.endsWith('/torrents/mylist')) {
    return ok({
      id: 77,
      files: [
        { id: 10, name: 'Pack/Mock.Show.S01E01.1080p.mkv', size: 500 },
        { id: 11, name: 'Pack/Mock.Show.S01E02.1080p.mkv', size: 600 },
        { id: 12, name: 'Pack/sample.mkv', size: 5 },
      ],
    });
  }
  if (u.pathname.endsWith('/torrents/requestdl')) return ok(`${mockBase}/cdn/torbox-${u.searchParams.get('file_id')}.mkv`);
  return new Response(JSON.stringify({ success: false, error: 'NOPE' }), { status: 404 });
};

// ------------------------------------------------------------------ harness
let app: App;
let server: http.Server;
let B = '';
let token = '';
const AUTH = 'MediaBrowser Client="Infuse-Direct", Device="iPhone", DeviceId="dev-1", Version="8.1.2"';

async function api(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<any> {
  const res = await fetch(B + path, {
    ...init,
    redirect: 'manual',
    headers: { authorization: `${AUTH}, Token="${token}"`, 'content-type': 'application/json', ...(init.headers as any) },
  });
  if (init.raw) return res;
  const t = await res.text();
  return t ? JSON.parse(t) : undefined;
}

before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  const cfg = loadConfig({ dbPath: ':memory:', port: 0, host: '127.0.0.1', password: 'pw', username: 'admin', torboxApiKey: 'tbkey' });
  app = createApp(cfg, { fetchImpl: mockFetch });
  await app.addons.install(`${mockBase}/manifest.json`, { enableCatalogs: true });
  server = startServer(app);
  await new Promise<void>((r) => server.once('listening', () => r()));
  B = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  mock.close();
});

describe('Jellyfin API', () => {
  test('public info and login', async () => {
    const info = await api('/System/Info/Public');
    assert.equal(info.ProductName, 'Jellyfin Server');
    assert.match(info.Id, /^[0-9a-f]{32}$/);
    const bad = await api('/Users/AuthenticateByName', { method: 'POST', body: JSON.stringify({ Username: 'admin', Pw: 'nope' }), raw: true });
    assert.equal(bad.status, 401);
    const ok = await api('/Users/AuthenticateByName', { method: 'POST', body: JSON.stringify({ Username: 'Admin', Pw: 'pw' }) });
    assert.ok(ok.AccessToken);
    assert.equal(ok.ServerId, info.Id);
    assert.equal(ok.User.Id.length, 32);
    token = ok.AccessToken;
  });

  test('protected routes need a token; /emby prefix and case-insensitive routes work', async () => {
    const r = await fetch(B + '/UserViews');
    assert.equal(r.status, 401);
    const v = await api('/emby/userviews');
    assert.ok(v.Items.length >= 4);
    const q = await fetch(`${B}/UserViews?api_key=${token}`);
    assert.equal(q.status, 200);
  });

  test('views and catalog browsing with genre filter', async () => {
    const views = await api('/UserViews');
    const names = views.Items.map((i: any) => i.Name);
    assert.deepEqual(names.slice(0, 2), ['My Movies', 'My Shows']);
    const top = views.Items.find((i: any) => i.Name === 'Top Movies');
    assert.equal(top.CollectionType, 'movies');
    const items = await api(`/Items?ParentId=${top.Id}&StartIndex=0&Limit=50`);
    assert.deepEqual(items.Items.map((i: any) => i.Name), ['Mock Movie', 'Other Movie']);
    assert.equal(items.TotalRecordCount, 2);
    const drama = await api(`/Items?ParentId=${top.Id}&Genres=Drama`);
    assert.deepEqual(drama.Items.map((i: any) => i.Name), ['Other Movie']);
    const genres = await api(`/Genres?ParentId=${top.Id}`);
    assert.deepEqual(genres.Items.map((g: any) => g.Name), ['Action', 'Drama']);
  });

  test('search', async () => {
    const r = await api('/Items?searchTerm=mock&Recursive=true&IncludeItemTypes=Movie,Series');
    assert.ok(r.Items.some((i: any) => i.Name === 'Mock Movie'));
    const hints = await api('/Search/Hints?searchTerm=mock');
    assert.ok(hints.SearchHints.length >= 1);
  });

  let movieId = '';
  test('movie details include cached versions only, best first, without touching TorBox writes', async () => {
    const views = await api('/UserViews');
    const top = views.Items.find((i: any) => i.Name === 'Top Movies');
    movieId = (await api(`/Items?ParentId=${top.Id}`)).Items[0].Id;
    torboxCalls.length = 0;
    const item = await api(`/Items/${movieId}`);
    assert.equal(item.Type, 'Movie');
    assert.equal(item.RunTimeTicks, 100 * 60 * 10_000_000);
    assert.equal(item.ProviderIds.Imdb, 'tt0000001');
    assert.equal(item.RemoteTrailers[0].Url, 'https://www.youtube.com/watch?v=abc');
    const labels = item.MediaSources.map((m: any) => m.Name);
    assert.equal(labels.length, 2, `got ${labels.join(' | ')}`);
    assert.match(labels[0], /^4K DV · REMUX · HEVC · Atmos · 58\.0 GB · TestAddon$/);
    assert.match(labels[1], /^1080p · WEB-DL · 2\.10 GB · TestAddon$/);
    assert.ok(torboxCalls.every((c) => c.endsWith('/checkcached')), torboxCalls.join(','));
    const pb = await api(`/Items/${movieId}/PlaybackInfo`, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(pb.MediaSources.length, 2);
    const subs = pb.MediaSources[0].MediaStreams.filter((s: any) => s.Type === 'Subtitle');
    assert.equal(subs.length, 2);
    assert.equal(subs[0].Language, 'eng');
    assert.equal(subs[0].IsExternal, true);
  });

  test('stream redirects to TorBox CDN for the chosen version and only then adds the torrent', async () => {
    const pb = await api(`/Items/${movieId}/PlaybackInfo`);
    const tb = pb.MediaSources[0];
    torboxCalls.length = 0;
    const res = await api(`/Videos/${movieId}/stream?static=true&MediaSourceId=${tb.Id}`, { raw: true });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${mockBase}/cdn/torbox-10.mkv`);
    assert.ok(torboxCalls.includes('POST /v1/api/torrents/createtorrent'));
    // Second request uses the link cache: no TorBox calls.
    torboxCalls.length = 0;
    const res2 = await api(`/Videos/${movieId}/stream.mkv?static=true&mediaSourceId=${tb.Id}`, { raw: true });
    assert.equal(res2.status, 302);
    assert.equal(torboxCalls.length, 0);
  });

  test('url versions resolve through addon redirects', async () => {
    const pb = await api(`/Items/${movieId}/PlaybackInfo`);
    const res = await api(`/Videos/${movieId}/stream?static=true&MediaSourceId=${pb.MediaSources[1].Id}`, { raw: true });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${mockBase}/cdn/resolved/1.mkv`);
  });

  test('proxy mode passes byte ranges through', async () => {
    setSetting(app.db, 'playbackMode', 'proxy');
    const pb = await api(`/Items/${movieId}/PlaybackInfo`);
    const res = await api(`/Videos/${movieId}/stream?MediaSourceId=${pb.MediaSources[1].Id}`, { raw: true, headers: { range: 'bytes=10-19' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 10-19/1000');
    assert.equal((await res.arrayBuffer()).byteLength, 10);
    setSetting(app.db, 'playbackMode', 'redirect');
  });

  test('subtitle file and images', async () => {
    const pb = await api(`/Items/${movieId}/PlaybackInfo`);
    const sub = pb.MediaSources[0].MediaStreams.find((s: any) => s.Type === 'Subtitle');
    const srt = await (await fetch(B + sub.DeliveryUrl)).text();
    assert.match(srt, /Hello/);
    const vtt = await (await fetch(B + sub.DeliveryUrl.replace('.srt', '.vtt'))).text();
    assert.match(vtt, /^WEBVTT[\s\S]*00:00:01\.000/);
    const img = await fetch(`${B}/Items/${movieId}/Images/Primary?maxWidth=300`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
  });

  test('favorites = library (My Movies) and progress → Continue Watching → played', async () => {
    const ud = await api(`/UserFavoriteItems/${movieId}`, { method: 'POST' });
    assert.equal(ud.IsFavorite, true);
    const views = await api('/UserViews');
    const myMovies = views.Items.find((i: any) => i.Name === 'My Movies');
    const lib = await api(`/Items?ParentId=${myMovies.Id}&SortBy=SortName`);
    assert.deepEqual(lib.Items.map((i: any) => i.Name), ['Mock Movie']);
    const favs = await api('/Items?Recursive=true&Filters=IsFavorite&IncludeItemTypes=Movie');
    assert.equal(favs.Items.length, 1);

    const rt = 100 * 60 * 10_000_000;
    await api('/Sessions/Playing', { method: 'POST', body: JSON.stringify({ ItemId: movieId, PositionTicks: 0 }) });
    await api('/Sessions/Playing/Stopped', { method: 'POST', body: JSON.stringify({ ItemId: movieId, PositionTicks: rt * 0.4 }) });
    await new Promise((r) => setTimeout(r, 50));
    const resume = await api('/UserItems/Resume');
    assert.equal(resume.Items[0]?.Id, movieId);
    assert.equal(resume.Items[0].UserData.PlaybackPositionTicks, rt * 0.4);
    await api('/Sessions/Playing/Stopped', { method: 'POST', body: JSON.stringify({ ItemId: movieId, PositionTicks: rt * 0.95 }) });
    await new Promise((r) => setTimeout(r, 50));
    const item = await api(`/Items/${movieId}`);
    assert.equal(item.UserData.Played, true);
    assert.equal(item.UserData.PlaybackPositionTicks, 0);
    assert.equal((await api('/UserItems/Resume')).Items.length, 0);
    const del = await api(`/UserFavoriteItems/${movieId}`, { method: 'DELETE' });
    assert.equal(del.IsFavorite, false);
  });

  test('series: seasons, episodes, next up and episode file selection from a season pack', async () => {
    const views = await api('/UserViews');
    const shows = views.Items.find((i: any) => i.Name === 'Top Shows');
    const series = (await api(`/Items?ParentId=${shows.Id}`)).Items[0];
    assert.equal(series.Type, 'Series');
    const seasons = await api(`/Shows/${series.Id}/Seasons`);
    assert.deepEqual(seasons.Items.map((s: any) => s.Name), ['Season 1', 'Season 2', 'Specials']);
    const eps = await api(`/Shows/${series.Id}/Episodes?SeasonId=${seasons.Items[0].Id}`);
    assert.deepEqual(eps.Items.map((e: any) => e.IndexNumber), [1, 2]);
    // Watch S01E01 → Next Up is S01E02
    await api(`/UserPlayedItems/${eps.Items[0].Id}`, { method: 'POST' });
    const next = await api('/Shows/NextUp');
    assert.equal(next.Items[0]?.Name, 'Second');
    const seriesNext = await api(`/Shows/NextUp?SeriesId=${series.Id}`);
    assert.equal(seriesNext.Items[0]?.Id, eps.Items[1].Id);
    // Play S01E02 from a season pack: picks the S01E02 file.
    const pb = await api(`/Items/${eps.Items[1].Id}/PlaybackInfo`);
    assert.equal(pb.MediaSources.length, 1);
    const res = await api(`/Videos/${eps.Items[1].Id}/stream?MediaSourceId=${pb.MediaSources[0].Id}`, { raw: true });
    assert.equal(res.headers.get('location'), `${mockBase}/cdn/torbox-11.mkv`);
    // Unreleased episode is virtual
    const s2 = await api(`/Shows/${series.Id}/Episodes?SeasonId=${seasons.Items[1].Id}`);
    assert.equal(s2.Items[1].LocationType, 'Virtual');
    // Mark season 1 played → series unplayed count drops
    const s = await api(`/Items/${series.Id}`);
    assert.equal(s.UserData.UnplayedItemCount, 3 - 1);
  });

  test('unknown routes degrade gracefully (404, list routes empty, never 401)', async () => {
    const r = await api('/Some/Unknown/Thing', { raw: true });
    assert.equal(r.status, 404);
    const l = await api('/Items/Something/Unknown');
    assert.equal(l.TotalRecordCount, 0);
    assert.ok(app.unhandled.size >= 1);
  });

  test('Swiftfin-style unquoted auth header with spaces, repeated fields params, bitrate test', async () => {
    const res = await fetch(`${B}/Users/Me`, {
      headers: { authorization: `MediaBrowser DeviceId=abc-1, Device=Ryan's iPhone 15, Client=Swiftfin iOS, Version=1.7.1, Token=${token}` },
    });
    assert.equal(res.status, 200);
    const me = await res.json();
    assert.equal(me.Policy.EnableMediaPlayback, true);
    assert.ok(me.Policy.AuthenticationProviderId && me.Policy.PasswordResetProviderId);
    const views = await api('/UserViews');
    const top = views.Items.find((i: any) => i.Name === 'Top Movies');
    const items = await api(`/Items?ParentId=${top.Id}&fields=Overview&fields=MediaSources`);
    assert.ok(items.Items[0].MediaSources?.length >= 1);
    const bt = await api('/Playback/BitrateTest?size=1000', { raw: true });
    assert.equal(bt.status, 200);
    assert.equal((await bt.arrayBuffer()).byteLength, 1000);
  });

  test('resume keeps the version you were watching (listed first, used by default)', async () => {
    const pb = await api(`/Items/${movieId}/PlaybackInfo`);
    const best = pb.MediaSources[0];
    const other = pb.MediaSources[1];
    assert.notEqual(best.Id, other.Id);
    // Play the second-ranked version.
    const r1 = await api(`/Videos/${movieId}/stream?static=true&MediaSourceId=${other.Id}`, { raw: true });
    assert.equal(r1.status, 302);
    // Swiftfin resumes with item.MediaSources.first → must now be the version just played.
    const item = await api(`/Items/${movieId}`);
    assert.equal(item.MediaSources[0].Id, other.Id);
    const pb2 = await api(`/Items/${movieId}/PlaybackInfo`, { method: 'POST', body: '{}' });
    assert.equal(pb2.MediaSources[0].Id, other.Id);
    // A request without a version (or with the placeholder) also plays it.
    const r2 = await api(`/Videos/${movieId}/stream?static=true`, { raw: true });
    assert.equal(r2.headers.get('location'), r1.headers.get('location'));
    // Choosing a different version explicitly switches the remembered one.
    await api(`/Videos/${movieId}/stream?static=true&MediaSourceId=${best.Id}`, { raw: true });
    assert.equal((await api(`/Items/${movieId}`)).MediaSources[0].Id, best.Id);
  });

  test('next episode prefers the same release (Stremio binge group)', async () => {
    const views = await api('/UserViews');
    const shows = views.Items.find((i: any) => i.Name === 'Top Shows');
    const series = (await api(`/Items?ParentId=${shows.Id}`)).Items[0];
    const seasons = await api(`/Shows/${series.Id}/Seasons`);
    const s1 = await api(`/Shows/${series.Id}/Episodes?SeasonId=${seasons.Items[0].Id}`);
    const s2 = await api(`/Shows/${series.Id}/Episodes?SeasonId=${seasons.Items[1].Id}`);
    const ep1 = s1.Items[0].Id;
    const next = s2.Items[0].Id;
    // Without history, the 4K release ranks first.
    assert.match((await api(`/Items/${next}/PlaybackInfo`)).MediaSources[0].Name, /^4K/);
    // Watch the 720p release of S01E01…
    const pb = await api(`/Items/${ep1}/PlaybackInfo`);
    const sd = pb.MediaSources.find((m: any) => m.Name.startsWith('720p'));
    await api(`/Videos/${ep1}/stream?static=true&MediaSourceId=${sd.Id}`, { raw: true });
    // …and S02E01 now offers the same 720p release first.
    assert.match((await api(`/Items/${next}/PlaybackInfo`)).MediaSources[0].Name, /^720p/);
  });

  test('camelCase profile like Jellyfin (dictionary keys untouched)', async () => {
    const item = await api(`/Items/${movieId}`, { headers: { accept: 'application/json; profile="CamelCase"' } });
    assert.equal(item.id, movieId);
    assert.equal(item.providerIds.Imdb, 'tt0000001');
    assert.ok(item.imageTags.Primary);
    assert.equal(typeof item.userData.playbackPositionTicks, 'number');
    assert.ok('isHD' in item);
  });

  test('stream without token: only for issued version ids', async () => {
    const pb = await api(`/Items/${movieId}/PlaybackInfo`);
    const ok = await fetch(`${B}/Videos/${movieId}/stream?static=true&MediaSourceId=${pb.MediaSources[0].Id}`, { redirect: 'manual' });
    assert.equal(ok.status, 302);
    const bare = await fetch(`${B}/Videos/${movieId}/stream?static=true`, { redirect: 'manual' });
    assert.equal(bare.status, 401);
    const other = await fetch(`${B}/Videos/${'0'.repeat(32)}/stream?MediaSourceId=${pb.MediaSources[0].Id}`, { redirect: 'manual' });
    assert.equal(other.status, 401);
    // "Best available" placeholder from a list response also plays without a token.
    const views = await api('/UserViews');
    const top = views.Items.find((i: any) => i.Name === 'Top Movies');
    const list = await api(`/Items?ParentId=${top.Id}&Fields=MediaSources`);
    const other2 = list.Items.find((i: any) => i.Name === 'Other Movie');
    const ph = other2.MediaSources[0];
    assert.equal(ph.Name, 'Best available');
    assert.notEqual(ph.Id, other2.Id);
    // Tokenless request with the placeholder id passes auth (Other Movie simply has no streams → 404, not 401).
    const anon = await fetch(`${B}/Videos/${other2.Id}/stream?static=true&MediaSourceId=${ph.Id}`, { redirect: 'manual' });
    assert.equal(anon.status, 404);
    // The placeholder id can't be reused for a different item.
    const cross = await fetch(`${B}/Videos/${movieId}/stream?static=true&MediaSourceId=${ph.Id}`, { redirect: 'manual' });
    assert.equal(cross.status, 401);
    // With a token, an unknown version id falls back to the best version.
    const fresh = await fetch(`${B}/Videos/${movieId}/stream?static=true&MediaSourceId=${ph.Id.replace(/./g, 'f')}`, { redirect: 'manual', headers: { 'x-emby-token': token } });
    assert.equal(fresh.status, 302);
  });

  test('Infuse Library Mode: seasons/episodes under a library, exact totals, provider id lookup', async () => {
    const views = await api('/UserViews');
    const shows = views.Items.find((i: any) => i.Name === 'Top Shows');
    const seasons = await api(`/Users/x/Items?ParentId=${shows.Id}&Recursive=true&IncludeItemTypes=Season`);
    assert.equal(seasons.TotalRecordCount, 3);
    const eps = await api(`/Users/x/Items?ParentId=${shows.Id}&Recursive=true&IncludeItemTypes=Episode&ExcludeLocationTypes=Virtual&Fields=MediaSources&StartIndex=0&Limit=200`);
    assert.equal(eps.TotalRecordCount, 4);
    const probe = await api(`/Items?ParentId=${shows.Id}&Limit=0`);
    assert.equal(probe.Items.length, 0);
    assert.equal(probe.TotalRecordCount, 1);
    const byId = await api('/Items?AnyProviderIdEquals=Imdb.tt0000001&Recursive=true&IncludeItemTypes=Movie');
    assert.equal(byId.Items[0]?.Name, 'Mock Movie');
  });
});
