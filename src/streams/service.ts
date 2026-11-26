import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db.ts';
import { getJsonSetting, getSetting, setSetting } from '../db.ts';
import { log } from '../log.ts';
import type { AddonService } from '../stremio/addons.ts';
import type { Stream, Subtitle } from '../stremio/types.ts';
import { Torbox, TorboxError } from '../torbox.ts';
import { parseStream, versionLabel, type StreamInfo } from './parse.ts';
import { TtlCache } from '../util/ttl-cache.ts';
import { keys, parseKey } from '../ids.ts';

export interface StreamPrefs {
  maxResolution: number; // 0 = no limit
  minResolution: number;
  excludeCam: boolean;
  excludeKeywords: string[];
  /** Upper bound on versions listed overall. */
  maxResults: number;
  /** Versions kept per quality tier (4K, 1440p, 1080p, 720p, SD, unknown); 0 = no limit. */
  perQuality: number;
  sort: 'quality' | 'size_desc' | 'size_asc';
  /** Keep url streams whose cache state is unknown (addon did not mark them). */
  includeUnknownCache: boolean;
  subtitleLanguages: string[]; // ISO 639-2 like 'eng'; empty = all
  subtitlesPerLanguage: number;
}

export const DEFAULT_PREFS: StreamPrefs = {
  maxResolution: 0,
  minResolution: 0,
  excludeCam: true,
  excludeKeywords: [],
  maxResults: 50,
  perQuality: 5,
  sort: 'quality',
  includeUnknownCache: true,
  subtitleLanguages: [],
  subtitlesPerLanguage: 2,
};

export interface StreamCandidate {
  id: string; // 32-hex media source id
  /** Placeholder meaning "best available at play time". */
  auto?: boolean;
  /** Stremio behaviorHints.bingeGroup: same value = same release across episodes. */
  bingeGroup?: string;
  itemKey: string;
  addonId: string;
  addonName: string;
  label: string;
  kind: 'url' | 'torbox';
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  filename?: string;
  season?: number;
  episode?: number;
  sizeBytes?: number;
  info: StreamInfo;
  proxyHeaders?: Record<string, string>;
}

const SOURCE_RANK: Record<string, number> = { REMUX: 5, BluRay: 4, 'WEB-DL': 3, WEBRip: 2, HDTV: 1, CAM: -5 };

export class StreamService {
  private db: DB;
  private addons: AddonService;
  readonly torbox: Torbox;
  private resolving = new Map<string, Promise<string>>();
  private warm = new TtlCache<StreamCandidate[]>(30 * 60_000, 500);
  private autoWritten = new Map<string, number>();

  constructor(db: DB, addons: AddonService, torbox: Torbox) {
    this.db = db;
    this.addons = addons;
    this.torbox = torbox;
  }

  prefs(): StreamPrefs {
    return { ...DEFAULT_PREFS, ...getJsonSetting<Partial<StreamPrefs>>(this.db, 'streamPrefs', {}) };
  }

  /**
   * All playable (cached) streams for a Stremio video, sorted best first.
   * Never adds anything to TorBox: uncached-by-check infoHashes are dropped.
   */
  async candidates(itemKey: string, type: string, videoId: string, ctx: { season?: number; episode?: number } = {}): Promise<StreamCandidate[]> {
    const prefs = this.prefs();
    const groups = await this.addons.streams(type, videoId);
    const raw: { addonId: string; addonName: string; s: Stream; info: StreamInfo }[] = [];
    for (const g of groups) {
      for (const s of g.streams) {
        if (!s || (!s.url && !s.infoHash)) continue;
        if (s.url && !/^https?:\/\//i.test(s.url)) continue;
        raw.push({ addonId: g.addon.id, addonName: g.addon.manifest.name, s, info: parseStream(s) });
      }
    }

    // Check TorBox cache for raw torrent results in one batch.
    const hashes = raw.filter((r) => !r.s.url && r.s.infoHash).map((r) => r.s.infoHash!.toLowerCase());
    let cached = new Map<string, { files?: { name: string; size: number }[]; size: number; name: string }>();
    if (hashes.length && this.torbox.configured) {
      try {
        cached = await this.torbox.checkCached(hashes);
      } catch (e) {
        log.warn('TorBox cache check failed', e);
      }
    }

    const out: StreamCandidate[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      const { s, info } = r;
      if (s.url) {
        if (info.cached === false) continue;
        if (info.cached === undefined && !prefs.includeUnknownCache) continue;
      } else {
        const h = s.infoHash!.toLowerCase();
        const entry = cached.get(h);
        if (!entry) continue;
        info.cached = true;
        if (!info.sizeBytes) {
          const f = entry.files && s.fileIdx !== undefined ? entry.files[s.fileIdx] : undefined;
          info.sizeBytes = f?.size ?? (entry.files?.length === 1 ? entry.files[0].size : undefined);
        }
      }
      if (!passesPrefs(info, s, prefs)) continue;
      const identity = s.url ? `u|${s.url}` : `t|${s.infoHash!.toLowerCase()}|${s.fileIdx ?? ''}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const id = createHash('md5').update(`${itemKey}|${r.addonId}|${identity}`).digest('hex');
      out.push({
        id,
        itemKey,
        addonId: r.addonId,
        addonName: r.addonName,
        label: versionLabel(info, r.addonName),
        kind: s.url ? 'url' : 'torbox',
        url: s.url,
        infoHash: s.infoHash?.toLowerCase(),
        fileIdx: s.fileIdx,
        filename: info.filename,
        season: ctx.season,
        episode: ctx.episode,
        sizeBytes: info.sizeBytes,
        info,
        proxyHeaders: s.behaviorHints?.proxyHeaders?.request,
        bingeGroup: s.behaviorHints?.bingeGroup,
      });
    }

    sortCandidates(out, prefs);
    // The version you last played survives the limits (applyPreference re-adds it).
    const final = this.applyPreference(itemKey, limitPerQuality(out, prefs.perQuality)).slice(0, Math.max(1, prefs.maxResults));
    this.remember(final);
    this.warm.set(itemKey, final);
    return final;
  }

  /**
   * Like Stremio: the version you last played for this title comes first (so resuming
   * plays the same file), and for episodes the release you were bingeing (same
   * bingeGroup) comes first.
   */
  applyPreference(itemKey: string, list: StreamCandidate[]): StreamCandidate[] {
    const last = this.db.prepare('SELECT source_id FROM last_source WHERE item_key = ?').get(itemKey) as { source_id: string } | undefined;
    if (last) {
      const i = list.findIndex((c) => c.id === last.source_id);
      if (i >= 0) return [list[i], ...list.filter((_, k) => k !== i)];
      const stored = this.source(last.source_id);
      // Still offered even if the addon didn't return it this time (links resolve fresh).
      if (stored && !stored.auto) return [stored, ...list];
    }
    const k = parseKey(itemKey);
    if (k.kind === 'episode') {
      const binge = this.db
        .prepare('SELECT binge_group FROM last_source WHERE parent_key = ? AND binge_group IS NOT NULL ORDER BY at DESC LIMIT 1')
        .get(keys.series(k.stremioId!)) as { binge_group: string } | undefined;
      if (binge) {
        const i = list.findIndex((c) => c.bingeGroup === binge.binge_group);
        if (i > 0) return [list[i], ...list.filter((_, n) => n !== i)];
      }
    }
    return list;
  }

  /** Called when a version actually starts playing. */
  recordPlayed(c: StreamCandidate): void {
    const k = parseKey(c.itemKey);
    const parent = k.kind === 'episode' ? keys.series(k.stremioId!) : null;
    this.db
      .prepare(
        `INSERT INTO last_source (item_key, source_id, binge_group, parent_key, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(item_key) DO UPDATE SET source_id = excluded.source_id, binge_group = excluded.binge_group, at = excluded.at`,
      )
      .run(c.itemKey, c.id, c.bingeGroup ?? null, parent, Date.now());
  }

  /**
   * Unguessable id for the "best available" placeholder version of an item, recorded as an
   * issued source so players that stream without a token (Infuse) can still use it.
   */
  autoSourceId(itemKey: string): string {
    let secret = getSetting(this.db, 'sourceSecret');
    if (!secret) {
      secret = randomBytes(16).toString('hex');
      setSetting(this.db, 'sourceSecret', secret);
    }
    const id = createHash('md5').update(`auto|${itemKey}|${secret}`).digest('hex');
    const last = this.autoWritten.get(id) ?? 0;
    if (Date.now() - last > 86400_000) {
      const stub = { id, itemKey, auto: true };
      this.db
        .prepare('INSERT INTO sources (id, item_key, json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at')
        .run(id, itemKey, JSON.stringify(stub), Date.now());
      this.autoWritten.set(id, Date.now());
    }
    return id;
  }

  /** Candidates computed in the last 30 minutes, without any network calls. */
  peek(itemKey: string): StreamCandidate[] | undefined {
    const list = this.warm.get(itemKey);
    return list ? this.applyPreference(itemKey, list) : undefined;
  }

  private remember(list: StreamCandidate[]): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO sources (id, item_key, json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at',
    );
    for (const c of list) stmt.run(c.id, c.itemKey, JSON.stringify(c), now);
    // Housekeeping: forget sources older than 14 days.
    this.db.prepare('DELETE FROM sources WHERE created_at < ?').run(now - 14 * 86400_000);
  }

  source(id: string): StreamCandidate | undefined {
    const row = this.db.prepare('SELECT json FROM sources WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as StreamCandidate) : undefined;
  }

  /** Direct URL for a candidate (resolving TorBox / addon redirects), cached. */
  async resolve(c: StreamCandidate, clientIp?: string): Promise<string> {
    const row = this.db.prepare('SELECT url, expires_at FROM link_cache WHERE stream_key = ?').get(c.id) as { url: string; expires_at: number } | undefined;
    if (row && row.expires_at > Date.now()) return row.url;
    const running = this.resolving.get(c.id);
    if (running) return running;
    const p = (async () => {
      let url: string;
      if (c.kind === 'torbox') {
        url = await this.torbox.resolve(c.infoHash!, { fileIdx: c.fileIdx, filename: c.filename, season: c.season, episode: c.episode }, clientIp);
      } else {
        url = await followRedirects(c.url!, c.proxyHeaders);
      }
      // TorBox links must be started within ~1-3h; cache for 50 minutes.
      this.db
        .prepare('INSERT INTO link_cache (stream_key, url, expires_at) VALUES (?, ?, ?) ON CONFLICT(stream_key) DO UPDATE SET url = excluded.url, expires_at = excluded.expires_at')
        .run(c.id, url, Date.now() + 50 * 60_000);
      return url;
    })().finally(() => this.resolving.delete(c.id));
    this.resolving.set(c.id, p);
    return p;
  }

  forgetLink(id: string): void {
    this.db.prepare('DELETE FROM link_cache WHERE stream_key = ?').run(id);
  }

  /** Subtitles for a video, filtered by preferred languages. */
  async subtitles(type: string, videoId: string, hint?: { filename?: string; size?: number }): Promise<Subtitle[]> {
    const prefs = this.prefs();
    const extra: Record<string, string | number | undefined> = {};
    if (hint?.filename) extra.filename = hint.filename;
    if (hint?.size) extra.videoSize = hint.size;
    let subs = await this.addons.subtitles(type, videoId, extra);
    const langs = prefs.subtitleLanguages.map((l) => l.toLowerCase());
    if (langs.length) subs = subs.filter((s) => langs.includes(String(s.lang).toLowerCase()));
    const perLang = new Map<string, number>();
    const seenUrl = new Set<string>();
    return subs.filter((s) => {
      if (!s.url || seenUrl.has(s.url)) return false;
      seenUrl.add(s.url);
      const n = perLang.get(s.lang) ?? 0;
      if (n >= prefs.subtitlesPerLanguage) return false;
      perLang.set(s.lang, n + 1);
      return true;
    });
  }
}

export function passesPrefs(info: StreamInfo, s: Stream, p: StreamPrefs): boolean {
  if (p.excludeCam && info.isCam) return false;
  if (p.maxResolution && info.resolution && info.resolution > p.maxResolution) return false;
  if (p.minResolution && info.resolution && info.resolution < p.minResolution) return false;
  if (p.excludeKeywords.length) {
    const text = `${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''} ${s.behaviorHints?.filename ?? ''}`.toLowerCase();
    if (p.excludeKeywords.some((k) => k && text.includes(k.toLowerCase()))) return false;
  }
  return true;
}

/** Keeps the first `n` candidates of each quality tier, preserving order. */
export function limitPerQuality(list: StreamCandidate[], n: number): StreamCandidate[] {
  if (!n || n <= 0) return list;
  const counts = new Map<number, number>();
  return list.filter((c) => {
    const tier = c.info.resolution || 0;
    const seen = counts.get(tier) ?? 0;
    counts.set(tier, seen + 1);
    return seen < n;
  });
}

export function sortCandidates(list: StreamCandidate[], p: StreamPrefs): void {
  const score = (c: StreamCandidate) => c.info.resolution * 10 + (SOURCE_RANK[c.info.source ?? ''] ?? 0) + (c.info.hdr.length ? 3 : 0);
  list.sort((a, b) => {
    if (p.sort === 'size_asc') return (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity);
    if (p.sort === 'size_desc') return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
    const d = score(b) - score(a);
    if (d) return d;
    if ((a.info.cached === true) !== (b.info.cached === true)) return a.info.cached === true ? -1 : 1;
    return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
  });
}

/** Follows addon resolver redirects (e.g. Torrentio /resolve/torbox/…) to the final CDN url. */
export async function followRedirects(url: string, headers?: Record<string, string>, hops = 6): Promise<string> {
  let current = url;
  for (let i = 0; i < hops; i++) {
    let res: Response;
    try {
      res = await fetch(current, { method: 'HEAD', redirect: 'manual', headers, signal: AbortSignal.timeout(30000) });
      if (res.status === 405 || res.status === 501) throw new Error('HEAD not allowed');
    } catch {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      res = await fetch(current, { method: 'GET', redirect: 'manual', headers: { ...headers, range: 'bytes=0-0' }, signal: ctrl.signal });
      clearTimeout(t);
      ctrl.abort();
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status >= 400) throw new TorboxError(res.status, 'RESOLVE_FAILED', `Stream link returned HTTP ${res.status}`);
    break;
  }
  return current;
}
