import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWatched, encodeWatched, watchedVideoIds } from '../src/stremio/watched-bitfield.ts';

const ids = Array.from({ length: 10 }, (_, i) => `tt2934286:1:${i + 1}`);

test('decodes stremio-core test vector (eps 1-5 watched)', () => {
  const w = decodeWatched('tt2934286:1:5:5:eJyTZwAAAEAAIA==', ids);
  assert.deepEqual(w, [true, true, true, true, true, false, false, false, false, false]);
});

test('anchor shifts when episodes are prepended', () => {
  const shifted = ['tt2934286:0:1', ...ids];
  const w = decodeWatched('tt2934286:1:5:5:eJyTZwAAAEAAIA==', shifted);
  assert.deepEqual(w.slice(0, 7), [false, true, true, true, true, true, false]);
});

test('encode/decode roundtrip', () => {
  const w = ids.map((_, i) => i % 3 === 0);
  const s = encodeWatched(w, ids);
  assert.match(s, /^tt2934286:1:10:10:/);
  assert.deepEqual(decodeWatched(s, ids), w);
});

test('nothing watched encodes anchor at index 0', () => {
  const s = encodeWatched(ids.map(() => false), ids);
  assert.ok(s.startsWith('tt2934286:1:1:1:'));
  assert.deepEqual(decodeWatched(s, ids), ids.map(() => false));
});

test('video order: no-season first, then by season/episode', () => {
  const order = watchedVideoIds([
    { id: 'b', season: 1, episode: 2 },
    { id: 'a', season: 1, episode: 1 },
    { id: 's', season: 0, episode: 1 },
    { id: 'x' },
    { id: 'a', season: 1, episode: 1 },
  ]);
  assert.deepEqual(order, ['x', 's', 'a', 'b']);
});
