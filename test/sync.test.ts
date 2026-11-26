import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { keys } from '../src/ids.ts';
import { Library } from '../src/library.ts';
import { AddonHttp } from '../src/stremio/addon-client.ts';
import { AddonService } from '../src/stremio/addons.ts';
import { StremioSync, type StremioLibraryItem } from '../src/stremio/sync.ts';
import { decodeWatched, watchedVideoIds } from '../src/stremio/watched-bitfield.ts';
import { setLogLevel } from '../src/log.ts';

setLogLevel('error');

const videos = [1, 2, 3, 4, 5, 6].map((e) => ({ id: `tt9:1:${e}`, season: 1, episode: e }));
const META = { id: 'tt9', type: 'series', name: 'Show', videos };

function setup(remote: StremioLibraryItem[]) {
  const db = openDb(':memory:');
  const state = { failGet: false };
  const puts: StremioLibraryItem[][] = [];
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = url.split('/api/')[1];
    calls.push(method);
    const body = JSON.parse(String(init?.body ?? '{}'));
    const ok = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { 'content-type': 'application/json' } });
    if (method === 'login') return ok({ authKey: 'AK', user: {} });
    if (method === 'datastoreGet') {
      if (state.failGet) throw new TypeError('fetch failed');
      return ok(body.all ? remote : remote.filter((r) => body.ids.includes(r._id)));
    }
    if (method === 'datastorePut') {
      puts.push(body.changes);
      return ok({ success: true });
    }
    if (method === 'addonCollectionGet') return ok({ addons: [{ transportUrl: 'http://127.0.0.1:11470/local-addon/manifest.json', manifest: {} }] });
    return new Response('{}', { status: 404 });
  };
  const addons = new AddonService(db, new AddonHttp(1000));
  // Provide series meta without network.
  db.prepare('INSERT INTO meta_cache (key, json, fetched_at) VALUES (?, ?, ?)').run('series:tt9', JSON.stringify(META), Date.now());
  db.prepare('INSERT INTO meta_cache (key, json, fetched_at) VALUES (?, ?, ?)').run('movie:tt1', JSON.stringify({ id: 'tt1', type: 'movie', name: 'Film' }), Date.now());
  const library = new Library(db);
  const sync = new StremioSync(db, addons, library, fetchImpl);
  return { db, sync, library, puts, calls, state };
}

const base = (o: Partial<StremioLibraryItem>): StremioLibraryItem => ({
  _id: 'tt1',
  name: 'Film',
  type: 'movie',
  removed: false,
  temp: false,
  _mtime: new Date(Date.now() - 1000).toISOString(),
  _ctime: new Date(Date.now() - 5000).toISOString(),
  state: { timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, noNotif: false },
  ...o,
});

test('pull imports library, movie progress and series watched bitfield', async () => {
  const remote = [
    base({ state: { ...base({}).state, timeOffset: 600_000, duration: 6_000_000, lastWatched: new Date().toISOString() } }),
    base({ _id: 'tt9', name: 'Show', type: 'series', state: { ...base({}).state, watched: 'tt9:1:3:3:eJyTZwAAAEAAIA==', video_id: 'tt9:1:6', timeOffset: 120_000, duration: 2_400_000 } }),
  ];
  // 5 bits set, anchored at ep 3 → eps 1..5 watched; ep 6 is in progress.
  const { sync, library } = setup(remote);
  await sync.login('a@b.c', 'pw');
  const r = await sync.pull();
  assert.equal(r.items, 2);
  assert.equal(library.isInLibrary(keys.movie('tt1')), true);
  assert.equal(library.isInLibrary(keys.series('tt9')), true);
  assert.equal(library.get(keys.movie('tt1'))!.position_ticks, 600_000 * 10_000);
  const ids = watchedVideoIds(videos);
  const expect = decodeWatched('tt9:1:3:3:eJyTZwAAAEAAIA==', ids);
  ids.forEach((vid, i) => assert.equal(!!library.get(keys.episode('tt9', vid))?.played, expect[i], vid));
  assert.equal(library.get(keys.episode('tt9', 'tt9:1:6'))!.position_ticks, 120_000 * 10_000);
});

test('write-back is off by default; when on, pushes merged watched state', async () => {
  const { sync, library, puts } = setup([base({ _id: 'tt9', name: 'Show', type: 'series' })]);
  await sync.login('a@b.c', 'pw');
  library.setPlayed(keys.episode('tt9', 'tt9:1:1'), keys.series('tt9'), true);
  assert.equal(await sync.flush(), 0);
  assert.equal(puts.length, 0);
  sync.setWriteBack(true);
  library.setPlayed(keys.episode('tt9', 'tt9:1:2'), keys.series('tt9'), true);
  library.setInLibrary(keys.series('tt9'), 'series', 'Show', undefined, true);
  const n = await sync.flush();
  assert.equal(n, 1);
  const item = puts[0][0];
  assert.equal(item._id, 'tt9');
  assert.equal(item.removed, false);
  const w = decodeWatched(item.state.watched, watchedVideoIds(videos));
  assert.deepEqual(w, [true, true, false, false, false, false]);
});

test('importing addons skips local-only addons', async () => {
  const { sync } = setup([]);
  await sync.login('a@b.c', 'pw');
  const r = await sync.importAddons();
  assert.deepEqual(r, { added: 0, skipped: 1 });
});

test('write-back never pushes blind when Stremio cannot be read; items stay pending', async () => {
  const { sync, library, puts, state } = setup([base({})]);
  await sync.login('a@b.c', 'pw');
  sync.setWriteBack(true);
  library.setPlayed(keys.movie('tt1'), null, true);
  state.failGet = true;
  await assert.rejects(() => sync.flush());
  assert.equal(puts.length, 0);
  assert.equal(sync.status().pending, 1);
  state.failGet = false;
  assert.equal(await sync.flush(), 1);
  assert.equal(puts[0][0].state.flaggedWatched, 1);
  assert.equal(sync.status().pending, 0);
});

test('watching a title saved in Stremio (but not pulled yet) keeps it in the Stremio library', async () => {
  const { sync, library, puts } = setup([base({ removed: false, name: 'Film' })]);
  await sync.login('a@b.c', 'pw');
  sync.setWriteBack(true);
  // No local library row; only playback progress here.
  library.reportProgress(keys.movie('tt1'), null, 30 * 60 * 10_000_000, 100 * 60 * 10_000_000, true);
  await sync.flush();
  assert.equal(puts[0][0].removed, false);
  assert.equal(puts[0][0].state.timeOffset, 30 * 60 * 1000);
});

test('removing a favorite locally (newer than Stremio) removes it there', async () => {
  const { sync, library, puts } = setup([base({ removed: false })]);
  await sync.login('a@b.c', 'pw');
  sync.setWriteBack(true);
  library.setInLibrary(keys.movie('tt1'), 'movie', 'Film', undefined, false);
  await sync.flush();
  assert.equal(puts[0][0].removed, true);
});
