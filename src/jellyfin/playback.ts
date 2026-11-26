import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { PlaybackMode } from '../config.ts';
import { parseKey } from '../ids.ts';
import { log } from '../log.ts';
import type { StreamCandidate, StreamService } from '../streams/service.ts';
import type { Subtitle } from '../stremio/types.ts';
import { TICKS_PER_SECOND } from '../library.ts';
import type { Catalog } from './catalog.ts';
import { HttpError } from '../http/router.ts';
import { languageName, toIso639_2 } from '../util/lang.ts';

export interface PlayTarget {
  itemKey: string;
  type: 'movie' | 'series';
  videoId: string;
  season?: number;
  episode?: number;
  runtimeTicks?: number;
}

const AUDIO_CODEC: Record<string, string> = {
  Atmos: 'truehd',
  TrueHD: 'truehd',
  'DTS-HD MA': 'dts',
  'DTS:X': 'dts',
  DTS: 'dts',
  'DD+': 'eac3',
  DD: 'ac3',
  AAC: 'aac',
};

export class Playback {
  private catalog: Catalog;
  private streams: StreamService;
  private mode: () => PlaybackMode;

  constructor(catalog: Catalog, streams: StreamService, mode: () => PlaybackMode) {
    this.catalog = catalog;
    this.streams = streams;
    this.mode = mode;
  }

  /** Map a Jellyfin item id to the Stremio video we need streams for. */
  async target(itemId: string): Promise<PlayTarget> {
    const key = this.catalog.ids.toKey(itemId);
    if (!key) throw new HttpError(404, 'Item not found');
    const k = parseKey(key);
    if (k.kind === 'movie') {
      const m = await this.catalog.metaFor('movie', k.stremioId!, false);
      const dto = m ? this.catalog.metaToDto({ ...m, type: 'movie' }) : undefined;
      return { itemKey: key, type: 'movie', videoId: k.stremioId!, runtimeTicks: dto?.RunTimeTicks };
    }
    if (k.kind === 'episode') {
      const m = await this.catalog.addons.meta('series', k.stremioId!);
      const v = m?.videos?.find((x) => x.id === k.videoId);
      const dto = await this.catalog.itemByKey(key, false);
      return { itemKey: key, type: 'series', videoId: k.videoId!, season: v?.season, episode: v?.episode ?? v?.number, runtimeTicks: dto?.RunTimeTicks };
    }
    throw new HttpError(400, 'Item is not playable');
  }

  async candidates(t: PlayTarget): Promise<StreamCandidate[]> {
    return this.streams.candidates(t.itemKey, t.type, t.videoId, { season: t.season, episode: t.episode });
  }

  async subtitles(t: PlayTarget, c?: StreamCandidate): Promise<Subtitle[]> {
    try {
      return await this.streams.subtitles(t.type, t.videoId, c ? { filename: c.filename, size: c.sizeBytes } : undefined);
    } catch {
      return [];
    }
  }

  mediaSource(itemId: string, t: PlayTarget, c: StreamCandidate, subs: Subtitle[]): any {
    const rt = t.runtimeTicks;
    const container = c.info.container ?? 'mkv';
    const streams = mediaStreams(c, subs, itemId);
    const bitrate = c.sizeBytes && rt ? Math.round((c.sizeBytes * 8) / (rt / TICKS_PER_SECOND)) : undefined;
    return {
      Protocol: 'File',
      Id: c.id,
      Path: c.filename ? `/bridgefin/${c.filename}` : `/bridgefin/${c.id}.${container}`,
      Type: 'Default',
      Container: container,
      Size: c.sizeBytes ?? 0,
      Name: c.label,
      IsRemote: false,
      ETag: c.id,
      ...(rt ? { RunTimeTicks: rt } : {}),
      ReadAtNativeFramerate: false,
      IgnoreDts: false,
      IgnoreIndex: false,
      GenPtsInput: false,
      SupportsTranscoding: false,
      SupportsDirectStream: true,
      SupportsDirectPlay: true,
      IsInfiniteStream: false,
      UseMostCompatibleTranscodingProfile: false,
      RequiresOpening: false,
      RequiresClosing: false,
      RequiresLooping: false,
      SupportsProbing: false,
      VideoType: 'VideoFile',
      MediaStreams: streams,
      MediaAttachments: [],
      Formats: [],
      Bitrate: bitrate ?? 0,
      RequiredHttpHeaders: {},
      TranscodingSubProtocol: 'http',
      DefaultAudioStreamIndex: 1,
      DefaultSubtitleStreamIndex: -1,
      HasSegments: false,
    };
  }

  /** PlaybackInfo response. Never touches TorBox beyond the cache check. */
  async playbackInfo(itemId: string, mediaSourceId?: string): Promise<any> {
    const t = await this.target(itemId);
    const list = await this.candidates(t);
    const subs = await this.subtitles(t);
    let chosen = list;
    if (mediaSourceId && mediaSourceId !== itemId) {
      const msid = mediaSourceId.replace(/-/g, '').toLowerCase();
      const hit = list.filter((c) => c.id === msid);
      if (hit.length) chosen = hit;
      else {
        const old = this.streams.source(msid);
        if (old && !old.auto) chosen = [old];
      }
    }
    const sources = chosen.map((c) => this.mediaSource(itemId, t, c, subs));
    const out: any = { MediaSources: sources, PlaySessionId: randomUUID().replace(/-/g, '') };
    if (!sources.length) {
      out.ErrorCode = 'NoCompatibleStream';
    }
    return out;
  }

  /** Media sources embedded into the item DTO on detail pages (bounded wait). */
  async sourcesForItem(itemId: string, timeoutMs = 10000): Promise<any[] | undefined> {
    try {
      const work = (async () => {
        const t = await this.target(itemId);
        const list = await this.candidates(t);
        const subs = await this.subtitles(t);
        return list.map((c) => this.mediaSource(itemId, t, c, subs));
      })();
      return await Promise.race([work, new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs))]);
    } catch (e) {
      log.debug(`sourcesForItem failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Placeholder source used in lists so clients see the item as playable without fetching streams. */
  placeholderSource(itemId: string, runtimeTicks?: number): any {
    const key = this.catalog.ids.toKey(itemId);
    const id = key ? this.streams.autoSourceId(key) : itemId;
    return {
      Protocol: 'File',
      Id: id,
      Path: `/bridgefin/${itemId}.mkv`,
      Type: 'Default',
      Container: 'mkv',
      Size: 0,
      Name: 'Best available',
      IsRemote: false,
      ETag: id,
      ...(runtimeTicks ? { RunTimeTicks: runtimeTicks } : {}),
      ReadAtNativeFramerate: false,
      IgnoreDts: false,
      IgnoreIndex: false,
      GenPtsInput: false,
      SupportsTranscoding: false,
      SupportsDirectStream: true,
      SupportsDirectPlay: true,
      IsInfiniteStream: false,
      UseMostCompatibleTranscodingProfile: false,
      RequiresOpening: false,
      RequiresClosing: false,
      RequiresLooping: false,
      SupportsProbing: false,
      VideoType: 'VideoFile',
      MediaStreams: [],
      MediaAttachments: [],
      Formats: [],
      Bitrate: 0,
      RequiredHttpHeaders: {},
      TranscodingSubProtocol: 'http',
      DefaultAudioStreamIndex: 1,
      HasSegments: false,
    };
  }

  /** Picks the candidate for a stream request, falling back to the best one. */
  private async pick(itemId: string, mediaSourceId?: string): Promise<{ t: PlayTarget; ordered: StreamCandidate[] }> {
    const t = await this.target(itemId);
    const list = await this.candidates(t);
    let ordered = list;
    if (mediaSourceId && mediaSourceId.replace(/-/g, '').toLowerCase() !== itemId) {
      const msid = mediaSourceId.replace(/-/g, '').toLowerCase();
      const hit = list.find((c) => c.id === msid) ?? this.streams.source(msid);
      if (hit && !hit.auto) ordered = [hit, ...list.filter((c) => c.id !== hit.id)];
    }
    if (!ordered.length) throw new HttpError(404, 'No cached streams found for this title');
    return { t, ordered };
  }

  async stream(req: IncomingMessage, res: ServerResponse, itemId: string, mediaSourceId: string | undefined, clientIp: string): Promise<void> {
    const { ordered } = await this.pick(itemId, mediaSourceId);
    let lastErr: unknown;
    // Try the chosen source, then up to two fallbacks.
    for (const c of ordered.slice(0, 3)) {
      try {
        const url = await this.streams.resolve(c, clientIp);
        log.info(`play ${c.label}`);
        if (this.mode() === 'proxy' || c.proxyHeaders) {
          await proxy(req, res, url, c.proxyHeaders, () => this.streams.forgetLink(c.id));
        } else {
          res.writeHead(302, { location: url, 'cache-control': 'no-store' });
          res.end();
        }
        return;
      } catch (e) {
        lastErr = e;
        this.streams.forgetLink(c.id);
        log.warn(`stream ${c.label} failed, trying next`, e);
      }
    }
    throw new HttpError(502, `Could not start any stream: ${(lastErr as Error)?.message ?? 'unknown error'}`);
  }

  async subtitleFile(itemId: string, mediaSourceId: string, index: number, format: string): Promise<{ body: string; type: string }> {
    const t = await this.target(itemId);
    const c = this.streams.source(mediaSourceId.replace(/-/g, '').toLowerCase());
    const subs = await this.subtitles(t);
    const s = subs[index - 2]; // indices 0/1 are video/audio
    if (!s) throw new HttpError(404, 'Subtitle not found');
    void c;
    const r = await fetch(s.url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new HttpError(502, `Subtitle fetch failed (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    let text = decodeSubtitle(buf);
    const fmt = format.toLowerCase();
    if (fmt === 'vtt' && !text.startsWith('WEBVTT')) text = srtToVtt(text);
    return { body: text, type: fmt === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8' };
  }
}

export function mediaStreams(c: StreamCandidate, subs: Subtitle[], itemId: string): any[] {
  const i = c.info;
  const height = i.resolution || undefined;
  const width = height ? Math.round((height * 16) / 9) : undefined;
  const rangeType = i.hdr.includes('DV') ? 'DOVI' : i.hdr.includes('HDR10+') ? 'HDR10Plus' : i.hdr.includes('HDR10') || i.hdr.includes('HDR') ? 'HDR10' : 'SDR';
  const videoCodec = i.videoCodec ?? (height && height >= 2160 ? 'hevc' : 'h264');
  const resLabel = height ? (height >= 2160 ? '4K' : `${height}p`) : '';
  const out: any[] = [
    {
      Codec: videoCodec,
      VideoRange: rangeType === 'SDR' ? 'SDR' : 'HDR',
      VideoRangeType: rangeType,
      DisplayTitle: [resLabel, videoCodec.toUpperCase(), rangeType === 'SDR' ? 'SDR' : rangeType].filter(Boolean).join(' '),
      IsInterlaced: false,
      ...(height ? { Height: height, Width: width } : {}),
      IsDefault: true,
      IsForced: false,
      IsHearingImpaired: false,
      Type: 'Video',
      Index: 0,
      IsExternal: false,
      IsTextSubtitleStream: false,
      SupportsExternalStream: false,
      Level: 0,
    },
  ];
  const audioName = i.audio[0];
  const aCodec = audioName ? AUDIO_CODEC[audioName] ?? 'aac' : 'aac';
  out.push({
    Codec: aCodec,
    DisplayTitle: [audioName ?? 'Audio', i.channels ? `${i.channels - 1}.1` : undefined].filter(Boolean).join(' '),
    ...(i.channels ? { Channels: i.channels } : {}),
    IsDefault: true,
    IsForced: false,
    IsHearingImpaired: false,
    Type: 'Audio',
    Index: 1,
    IsExternal: false,
    IsTextSubtitleStream: false,
    SupportsExternalStream: false,
    Level: 0,
  });
  subs.forEach((s, k) => {
    const index = k + 2;
    const lang = toIso639_2(s.lang);
    out.push({
      Codec: 'srt',
      Language: lang,
      DisplayTitle: `${languageName(lang)} (${s.id ? 'Addon' : 'External'})`,
      Title: languageName(lang),
      IsDefault: false,
      IsForced: false,
      IsHearingImpaired: false,
      Type: 'Subtitle',
      Index: index,
      IsExternal: true,
      IsTextSubtitleStream: true,
      SupportsExternalStream: true,
      DeliveryMethod: 'External',
      DeliveryUrl: `/Videos/${itemId}/${c.id}/Subtitles/${index}/0/Stream.srt`,
      Path: s.url,
      Level: 0,
    });
  });
  return out;
}

async function proxy(req: IncomingMessage, res: ServerResponse, url: string, extraHeaders: Record<string, string> | undefined, onFail: () => void): Promise<void> {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (req.headers.range) headers.range = String(req.headers.range);
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const upstream = await fetch(url, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, signal: ctrl.signal, redirect: 'follow' });
  if (upstream.status >= 400) {
    onFail();
    throw new Error(`upstream HTTP ${upstream.status}`);
  }
  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  const out: Record<string, string> = {};
  for (const h of pass) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  out['accept-ranges'] ??= 'bytes';
  res.writeHead(upstream.status, out);
  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as any);
  body.on('error', () => res.destroy());
  body.pipe(res);
}

function decodeSubtitle(buf: Buffer): string {
  let text = buf.toString('utf8');
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
  return text.replace(/^﻿/, '');
}

export function srtToVtt(srt: string): string {
  return 'WEBVTT\n\n' + srt.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}
