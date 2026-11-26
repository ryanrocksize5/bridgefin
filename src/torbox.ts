import { log } from './log.ts';

/**
 * Minimal TorBox client. Source: https://api.torbox.app/openapi.json (v1).
 * Only ever adds a torrent when the user presses play on that stream, and only
 * with add_only_if_cached so nothing uncached is ever queued.
 */
const BASE = 'https://api.torbox.app/v1/api';

export interface TorboxFile {
  id: number;
  name: string;
  short_name?: string;
  size: number;
  mimetype?: string;
}

export interface CachedEntry {
  hash: string;
  name: string;
  size: number;
  files?: TorboxFile[];
}

export class TorboxError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Fetch = typeof fetch;

export class Torbox {
  private apiKey: () => string;
  private fetchImpl: Fetch;
  /** hash -> {cached, files, at} — TorBox itself caches for 1h, we cache 30 min. */
  private cacheCheck = new Map<string, { entry: CachedEntry | null; at: number }>();

  constructor(apiKey: () => string, fetchImpl: Fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  get configured(): boolean {
    return !!this.apiKey();
  }

  private async call<T>(method: string, path: string, init: { query?: Record<string, string>; body?: BodyInit; json?: unknown } = {}): Promise<T> {
    const key = this.apiKey();
    if (!key) throw new TorboxError(401, 'NO_AUTH', 'TorBox API key is not set');
    const qs = init.query ? '?' + new URLSearchParams(init.query).toString() : '';
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, 'user-agent': 'Bridgefin/0.1' };
    let body = init.body;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const res = await this.fetchImpl(`${BASE}${path}${qs}`, { method, headers, body, signal: AbortSignal.timeout(20000) });
    let payload: any;
    try {
      payload = await res.json();
    } catch {
      payload = {};
    }
    if (!res.ok || payload?.success === false) {
      const detail = typeof payload?.detail === 'string' ? payload.detail : JSON.stringify(payload?.detail ?? payload?.error ?? res.statusText);
      throw new TorboxError(res.status, String(payload?.error ?? 'HTTP_' + res.status), detail);
    }
    return payload.data as T;
  }

  async me(): Promise<{ email?: string; plan?: number; premium_expires_at?: string }> {
    return this.call('GET', '/user/me');
  }

  /** Returns map of lowercase hash -> entry for the cached subset. */
  async checkCached(hashes: string[]): Promise<Map<string, CachedEntry>> {
    const out = new Map<string, CachedEntry>();
    const now = Date.now();
    const todo: string[] = [];
    for (const h of new Set(hashes.map((x) => x.toLowerCase()))) {
      const hit = this.cacheCheck.get(h);
      if (hit && now - hit.at < 30 * 60_000) {
        if (hit.entry) out.set(h, hit.entry);
      } else todo.push(h);
    }
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100);
      const data = await this.call<CachedEntry[] | Record<string, CachedEntry> | null>('POST', '/torrents/checkcached', {
        query: { format: 'list', list_files: 'true' },
        json: { hashes: chunk },
      });
      const list: CachedEntry[] = Array.isArray(data) ? data : data ? Object.values(data) : [];
      const found = new Set<string>();
      for (const e of list) {
        const h = String(e.hash).toLowerCase();
        found.add(h);
        out.set(h, e);
        this.cacheCheck.set(h, { entry: e, at: now });
      }
      for (const h of chunk) if (!found.has(h)) this.cacheCheck.set(h, { entry: null, at: now });
    }
    return out;
  }

  /** Adds a cached torrent (no-op for TorBox if already present) and returns its id. */
  async addCached(hash: string): Promise<number> {
    const form = new FormData();
    form.set('magnet', `magnet:?xt=urn:btih:${hash}`);
    form.set('seed', '3');
    form.set('allow_zip', 'false');
    form.set('add_only_if_cached', 'true');
    try {
      const data = await this.call<{ torrent_id: number }>('POST', '/torrents/createtorrent', { body: form });
      return data.torrent_id;
    } catch (e) {
      // Already in the user's list: TorBox may answer DIFF_ISSUE / DUPLICATE_ITEM.
      if (e instanceof TorboxError && e.code !== 'DOWNLOAD_NOT_CACHED' && e.status !== 401 && e.status !== 429) {
        const again = await this.findInList(hash);
        if (again) return again.id;
      }
      throw e;
    }
  }

  async findInList(hash: string): Promise<{ id: number; files: TorboxFile[] } | undefined> {
    try {
      const list = await this.call<any[]>('GET', '/torrents/mylist', { query: { bypass_cache: 'true', limit: '1000' } });
      const h = hash.toLowerCase();
      const hit = (list ?? []).find((t) => String(t.hash).toLowerCase() === h);
      return hit ? { id: hit.id, files: hit.files ?? [] } : undefined;
    } catch (e) {
      if (e instanceof TorboxError && e.code === 'ITEM_NOT_FOUND') return undefined;
      throw e;
    }
  }

  async torrentFiles(torrentId: number): Promise<TorboxFile[]> {
    const t = await this.call<any>('GET', '/torrents/mylist', { query: { id: String(torrentId), bypass_cache: 'true' } });
    return (t?.files ?? []) as TorboxFile[];
  }

  async requestLink(torrentId: number, fileId: number, userIp?: string): Promise<string> {
    const query: Record<string, string> = { token: this.apiKey(), torrent_id: String(torrentId), file_id: String(fileId) };
    if (userIp && !isPrivateIp(userIp)) query.user_ip = userIp;
    return this.call<string>('GET', '/torrents/requestdl', { query });
  }

  /**
   * Full resolution: hash (+ optional file hints) -> direct CDN url.
   * File selection order: fileIdx (when file list order matches) → filename → episode match → largest video.
   */
  async resolve(hash: string, hints: { fileIdx?: number; filename?: string; season?: number; episode?: number }, userIp?: string): Promise<string> {
    const torrentId = await this.addCached(hash);
    let files: TorboxFile[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      files = await this.torrentFiles(torrentId);
      if (files.length) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    if (!files.length) throw new TorboxError(404, 'NO_FILES', 'TorBox returned no files for this torrent');
    const file = pickFile(files, hints);
    log.info(`torbox: resolved ${hash.slice(0, 8)}… -> file ${file.id} (${file.short_name ?? file.name})`);
    return this.requestLink(torrentId, file.id, userIp);
  }
}

const VIDEO_RE = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg)$/i;

export function pickFile(files: TorboxFile[], hints: { fileIdx?: number; filename?: string; season?: number; episode?: number }): TorboxFile {
  const videos = files.filter((f) => VIDEO_RE.test(f.name) && !/\bsample\b/i.test(f.name));
  const pool = videos.length ? videos : files;
  const base = (n: string) => n.split('/').pop()!.toLowerCase();
  if (hints.filename) {
    const want = base(hints.filename);
    const hit = pool.find((f) => base(f.name) === want || base(f.short_name ?? '') === want);
    if (hit) return hit;
  }
  if (hints.season !== undefined && hints.episode !== undefined) {
    const s = hints.season, e = hints.episode;
    const pats = [
      new RegExp(`s0*${s}[ ._-]*e0*${e}(?!\\d)`, 'i'),
      new RegExp(`\\b0*${s}x0*${e}(?!\\d)`, 'i'),
      new RegExp(`season[ ._-]*0*${s}.*?(episode|ep|e)[ ._-]*0*${e}(?!\\d)`, 'i'),
    ];
    for (const re of pats) {
      const hit = pool.find((f) => re.test(f.name));
      if (hit) return hit;
    }
  }
  if (hints.fileIdx !== undefined && files[hints.fileIdx] && VIDEO_RE.test(files[hints.fileIdx].name)) {
    return files[hints.fileIdx];
  }
  return pool.reduce((a, b) => (b.size > a.size ? b : a));
}

function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/, '');
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(v);
}
