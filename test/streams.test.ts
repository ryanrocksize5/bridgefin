import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitPerQuality, type StreamCandidate } from '../src/streams/service.ts';

const c = (id: string, resolution: number): StreamCandidate =>
  ({ id, itemKey: 'movie:tt1', addonId: 'a', addonName: 'A', label: id, kind: 'url', info: { resolution, hdr: [], audio: [], languages: [], isCam: false } }) as StreamCandidate;

test('keeps the first N versions of each quality, in the original order', () => {
  const list = [c('4k-1', 2160), c('4k-2', 2160), c('4k-3', 2160), c('1080-1', 1080), c('1080-2', 1080), c('1080-3', 1080), c('720-1', 720), c('unk-1', 0), c('unk-2', 0)];
  assert.deepEqual(limitPerQuality(list, 2).map((x) => x.id), ['4k-1', '4k-2', '1080-1', '1080-2', '720-1', 'unk-1', 'unk-2']);
});

test('0 means no per-quality limit', () => {
  const list = [c('a', 1080), c('b', 1080), c('c', 1080)];
  assert.equal(limitPerQuality(list, 0).length, 3);
});
