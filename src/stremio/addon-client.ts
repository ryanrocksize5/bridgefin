import type { InstalledAddon, Manifest, Meta, Stream, Subtitle } from './types.ts';
import { log } from '../log.ts';

/** Turns a transport url (…/manifest.json, stremio://…) into the addon base url. */
export function addonBase(transportUrl: string): string {
  let u = transportUrl.trim();
  if (u.startsWith('stremio://')) u = 'https://' + u.slice('stremio://'.length);
  u = u.replace(/\/manifest\.json(\?.*)?$/i, '');
  return u.replace(/\/+$/, '');
}

export function normalizeTransportUrl(url: string): string {
  let u = url.trim();
  if (u.startsWith('stremio://')) u = 'https://' + u.slice('stremio://'.length);
  if (!/\/manifest\.json(\?.*)?$/i.test(u)) u = u.replace(/\/+$/, '') + '/manifest.json';
  return u;
}

export function encodeExtra(extra: Record<string, string | number | undefined>): string {
  return Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** Does this addon serve `resource` for `type` and `id`? Mirrors stremio-core's logic. */
export function addonSupports(m: Manifest, resource: string, type: string, id?: string): boolean {
  for (const r of m.resources ?? []) {
    const name = typeof r === 'string' ? r : r.name;
    if (name !== resource) continue;
    const types = (typeof r === 'string' ? undefined : r.types) ?? m.types ?? [];
    if (types.length && !types.includes(type)) continue;
    const prefixes = (typeof r === 'string' ? undefined : r.idPrefixes) ?? m.idPrefixes;
    if (id && prefixes && prefixes.length && !prefixes.some((p) => id.startsWith(p))) continue;
    return true;
  }
  return false;
}

export class AddonHttp {
  private timeoutMs: number;
  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  async getJson<T>(url: string): Promise<T> {
    const started = Date.now();
    const res = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'Bridgefin/0.1' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${redact(url)}`);
    const json = (await res.json()) as T;
    log.debug(`addon GET ${redact(url)} ${Date.now() - started}ms`);
    return json;
  }

  manifest(transportUrl: string): Promise<Manifest> {
    return this.getJson<Manifest>(normalizeTransportUrl(transportUrl));
  }

  async catalog(a: InstalledAddon, type: string, id: string, extra: Record<string, string | number | undefined> = {}): Promise<Meta[]> {
    const ex = encodeExtra(extra);
    const url = `${addonBase(a.transportUrl)}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}${ex ? '/' + ex : ''}.json`;
    const r = await this.getJson<{ metas?: Meta[] }>(url);
    return Array.isArray(r.metas) ? r.metas : [];
  }

  async meta(a: InstalledAddon, type: string, id: string): Promise<Meta | undefined> {
    const url = `${addonBase(a.transportUrl)}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const r = await this.getJson<{ meta?: Meta | null }>(url);
    return r.meta ?? undefined;
  }

  async streams(a: InstalledAddon, type: string, id: string): Promise<Stream[]> {
    const url = `${addonBase(a.transportUrl)}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const r = await this.getJson<{ streams?: Stream[] }>(url);
    return Array.isArray(r.streams) ? r.streams : [];
  }

  async subtitles(a: InstalledAddon, type: string, id: string, extra: Record<string, string | number | undefined> = {}): Promise<Subtitle[]> {
    const ex = encodeExtra(extra);
    const url = `${addonBase(a.transportUrl)}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}${ex ? '/' + ex : ''}.json`;
    const r = await this.getJson<{ subtitles?: Subtitle[] }>(url);
    return Array.isArray(r.subtitles) ? r.subtitles : [];
  }
}

/** Hide configuration segments (they usually contain API keys) in logs. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/');
    let cut = segs.findIndex((s) => /^(catalog|meta|stream|subtitles|manifest\.json)$/i.test(s));
    if (cut < 0) cut = segs.length;
    const parts = segs.map((p, i) => (i > 0 && i < cut && (p.length > 16 || /[=%|]/.test(p)) ? '…' : p));
    return `${u.host}${parts.join('/')}`;
  } catch {
    return url.slice(0, 60);
  }
}
