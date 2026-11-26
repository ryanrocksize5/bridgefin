import { deflateSync, inflateSync } from 'node:zlib';
import type { MetaVideo } from './types.ts';

/**
 * Port of stremio-core's WatchedBitField (stremio-watched-bitfield crate).
 * Format: "<anchorVideoId>:<anchorLength>:<base64(zlib(bytes))>", bits LSB-first.
 */

/** Video id order used by stremio-core (LibraryItemState::watched_bitfield). */
export function watchedVideoIds(videos: MetaVideo[]): string[] {
  const seen = new Set<string>();
  const uniq: MetaVideo[] = [];
  for (const v of videos) {
    if (!v?.id || seen.has(v.id)) continue;
    seen.add(v.id);
    uniq.push(v);
  }
  const key = (v: MetaVideo): [number, number, number] => {
    const ep = v.episode ?? v.number;
    const has = v.season !== undefined && v.season !== null && ep !== undefined && ep !== null;
    const rel = Date.parse(v.released ?? '');
    return [has ? v.season! : -Infinity, has ? ep! : -Infinity, Number.isNaN(rel) ? -Infinity : rel];
  };
  return uniq
    .map((v, i) => ({ v, i, k: key(v) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.i - b.i)
    .map((x) => x.v.id);
}

export function decodeWatched(serialized: string | null | undefined, videoIds: string[]): boolean[] {
  const out = new Array<boolean>(videoIds.length).fill(false);
  if (!serialized) return out;
  const parts = serialized.split(':');
  if (parts.length < 3) return out;
  const b64 = parts.pop()!;
  const anchorLength = Number(parts.pop());
  const anchorId = parts.join(':');
  let bytes: Buffer;
  try {
    bytes = inflateSync(Buffer.from(b64, 'base64'));
  } catch {
    return out;
  }
  const bit = (i: number) => i >= 0 && i >> 3 < bytes.length && (bytes[i >> 3] & (1 << (i & 7))) !== 0;
  const pos = videoIds.indexOf(anchorId);
  if (pos < 0 || !Number.isFinite(anchorLength)) return out;
  const offset = anchorLength - pos - 1;
  for (let i = 0; i < videoIds.length; i++) out[i] = bit(i + offset);
  return out;
}

export function encodeWatched(watched: boolean[], videoIds: string[]): string {
  let last = -1;
  watched.forEach((w, i) => {
    if (w) last = i;
  });
  const idx = last < 0 ? 0 : last;
  const anchorId = videoIds[idx] ?? 'undefined';
  const bytes = Buffer.alloc(Math.ceil(videoIds.length / 8));
  watched.forEach((w, i) => {
    if (w) bytes[i >> 3] |= 1 << (i & 7);
  });
  const b64 = deflateSync(bytes, { level: 6 }).toString('base64');
  return `${anchorId}:${idx + 1}:${b64}`;
}
