import type { DB } from '../db.ts';
import { tx } from '../db.ts';
import { log } from '../log.ts';
import { TtlCache } from '../util/ttl-cache.ts';
import { AddonHttp, addonSupports, normalizeTransportUrl } from './addon-client.ts';
import type { CatalogDef, InstalledAddon, Manifest, Meta, Stream, Subtitle } from './types.ts';

export const DEFAULT_ADDONS = [
  'https://v3-cinemeta.strem.io/manifest.json',
  'https://opensubtitles-v3.strem.io/manifest.json',
];

/** Well known addons offered as one-click installs on the settings page. */
export const SUGGESTED_ADDONS: { name: string; url: string; note: string }[] = [
  { name: 'Torrentio', url: 'https://torrentio.strem.fun/manifest.json', note: 'Torrent results; Bridgefin checks TorBox cache itself' },
  { name: 'Cinemeta', url: 'https://v3-cinemeta.strem.io/manifest.json', note: 'Official metadata & catalogs' },
  { name: 'OpenSubtitles v3', url: 'https://opensubtitles-v3.strem.io/manifest.json', note: 'Subtitles' },
];

export interface CatalogRef {
  addon: InstalledAddon;
  def: CatalogDef;
  enabled: boolean;
  position: number;
}

export function catalogExtras(def: CatalogDef): { name: string; isRequired: boolean; options?: string[] }[] {
  if (def.extra) return def.extra.map((e) => ({ name: e.name, isRequired: !!e.isRequired, options: e.options }));
  const out: { name: string; isRequired: boolean; options?: string[] }[] = [];
  for (const n of def.extraSupported ?? []) out.push({ name: n, isRequired: (def.extraRequired ?? []).includes(n), options: n === 'genre' ? def.genres : undefined });
  return out;
}

export function catalogSupports(def: CatalogDef, extraName: string): boolean {
  return catalogExtras(def).some((e) => e.name === extraName);
}

/** A catalog can be shown as a plain library only if it has no required extras. */
export function catalogBrowsable(def: CatalogDef): boolean {
  return !catalogExtras(def).some((e) => e.isRequired);
}

export class AddonService {
  readonly http: AddonHttp;
  private db: DB;
  private addons: InstalledAddon[] = [];
  private catalogCache = new TtlCache<Meta[]>(6 * 3600_000, 1000);
  private streamCache = new TtlCache<{ addon: InstalledAddon; streams: Stream[] }[]>(30 * 60_000, 500);
  private subtitleCache = new TtlCache<Subtitle[]>(6 * 3600_000, 500);
  private metaMem = new TtlCache<Meta | undefined>(30 * 60_000, 3000);

  constructor(db: DB, http: AddonHttp) {
    this.db = db;
    this.http = http;
    this.reload();
  }

  reload(): void {
    const rows = this.db.prepare('SELECT id, transport_url, manifest, position, enabled FROM addons ORDER BY position, rowid').all() as any[];
    this.addons = rows.map((r) => ({
      id: r.id,
      transportUrl: r.transport_url,
      manifest: JSON.parse(r.manifest) as Manifest,
      position: r.position,
      enabled: !!r.enabled,
    }));
  }

  list(): InstalledAddon[] {
    return this.addons;
  }

  enabled(): InstalledAddon[] {
    return this.addons.filter((a) => a.enabled);
  }

  get(id: string): InstalledAddon | undefined {
    return this.addons.find((a) => a.id === id);
  }

  async ensureDefaults(): Promise<void> {
    if (this.addons.length) return;
    for (const url of DEFAULT_ADDONS) {
      try {
        await this.install(url, { enableCatalogs: true });
      } catch (e) {
        log.warn(`could not install default addon ${url}`, e);
      }
    }
  }

  async install(url: string, opts: { enableCatalogs?: boolean; manifest?: Manifest } = {}): Promise<InstalledAddon> {
    const transportUrl = normalizeTransportUrl(url);
    const manifest = opts.manifest ?? (await this.http.manifest(transportUrl));
    if (!manifest?.id || !manifest.name) throw new Error('Not a valid Stremio addon manifest');
    // Several installs of the same addon id with different configs are allowed; id is made unique.
    const existing = this.addons.find((a) => a.transportUrl === transportUrl);
    const id = existing?.id ?? this.uniqueId(manifest.id);
    const pos = existing?.position ?? (this.addons.reduce((m, a) => Math.max(m, a.position), -1) + 1);
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO addons (id, transport_url, manifest, position, enabled, updated_at) VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, transport_url = excluded.transport_url, updated_at = excluded.updated_at`,
        )
        .run(id, transportUrl, JSON.stringify(manifest), pos, Date.now());
      this.syncCatalogRows(id, manifest, !!opts.enableCatalogs && !existing);
    });
    this.reload();
    this.catalogCache.clear();
    this.streamCache.clear();
    log.info(`addon installed: ${manifest.name} (${id})`);
    return this.get(id)!;
  }

  private uniqueId(base: string): string {
    let id = base;
    let n = 2;
    while (this.addons.some((a) => a.id === id)) id = `${base}#${n++}`;
    return id;
  }

  private syncCatalogRows(addonId: string, m: Manifest, enable: boolean): void {
    const maxPos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM catalogs').get() as { p: number }).p;
    let pos = maxPos + 1;
    for (const c of m.catalogs ?? []) {
      const on = enable && catalogBrowsable(c) && (c.type === 'movie' || c.type === 'series') ? 1 : 0;
      this.db
        .prepare('INSERT OR IGNORE INTO catalogs (addon_id, type, catalog_id, enabled, position) VALUES (?, ?, ?, ?, ?)')
        .run(addonId, c.type, c.id, on, pos++);
    }
  }

  uninstall(id: string): void {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM addons WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM catalogs WHERE addon_id = ?').run(id);
    });
    this.reload();
    this.catalogCache.clear();
    this.streamCache.clear();
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE addons SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    this.reload();
    this.streamCache.clear();
  }

  move(id: string, delta: number): void {
    const list = [...this.addons];
    const i = list.findIndex((a) => a.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    tx(this.db, () => list.forEach((a, k) => this.db.prepare('UPDATE addons SET position = ? WHERE id = ?').run(k, a.id)));
    this.reload();
  }

  async refreshManifests(): Promise<void> {
    for (const a of this.addons) {
      try {
        const m = await this.http.manifest(a.transportUrl);
        this.db.prepare('UPDATE addons SET manifest = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(m), Date.now(), a.id);
        this.syncCatalogRows(a.id, m, false);
      } catch (e) {
        log.warn(`manifest refresh failed for ${a.manifest.name}`, e);
      }
    }
    this.reload();
  }

  // ---------- catalogs ----------

  catalogs(): CatalogRef[] {
    const rows = this.db.prepare('SELECT addon_id, type, catalog_id, enabled, position FROM catalogs ORDER BY position').all() as any[];
    const out: CatalogRef[] = [];
    for (const r of rows) {
      const addon = this.get(r.addon_id);
      if (!addon || !addon.enabled) continue;
      const def = addon.manifest.catalogs?.find((c) => c.type === r.type && c.id === r.catalog_id);
      if (!def) continue;
      out.push({ addon, def, enabled: !!r.enabled, position: r.position });
    }
    return out;
  }

  findCatalog(addonId: string, type: string, catalogId: string): CatalogRef | undefined {
    return this.catalogs().find((c) => c.addon.id === addonId && c.def.type === type && c.def.id === catalogId);
  }

  setCatalogEnabled(addonId: string, type: string, catalogId: string, enabled: boolean): void {
    this.db.prepare('UPDATE catalogs SET enabled = ? WHERE addon_id = ? AND type = ? AND catalog_id = ?').run(enabled ? 1 : 0, addonId, type, catalogId);
  }

  moveCatalog(addonId: string, type: string, catalogId: string, delta: number): void {
    const list = this.db.prepare('SELECT addon_id, type, catalog_id FROM catalogs ORDER BY position').all() as any[];
    const i = list.findIndex((r) => r.addon_id === addonId && r.type === type && r.catalog_id === catalogId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    tx(this.db, () =>
      list.forEach((r, k) => this.db.prepare('UPDATE catalogs SET position = ? WHERE addon_id = ? AND type = ? AND catalog_id = ?').run(k, r.addon_id, r.type, r.catalog_id)),
    );
  }

  /** One page of a catalog. Stremio pages are 100 items (skip is a multiple of 100 for most addons). */
  async catalogPage(ref: CatalogRef, skip: number, extra: Record<string, string> = {}): Promise<Meta[]> {
    const ex: Record<string, string | number> = { ...extra };
    if (skip > 0) ex.skip = skip;
    const key = `${ref.addon.id}|${ref.def.type}|${ref.def.id}|${JSON.stringify(ex)}`;
    return this.catalogCache.wrap(key, async () => {
      try {
        return dedupeMetas(await this.http.catalog(ref.addon, ref.def.type, ref.def.id, ex));
      } catch (e) {
        log.warn(`catalog ${ref.addon.manifest.name}/${ref.def.id} failed`, e);
        return [];
      }
    });
  }

  /**
   * Returns items [start, start+limit) of a catalog by walking pages.
   * `hardCap` bounds the total so library scans can't walk forever.
   */
  async catalogSlice(ref: CatalogRef, start: number, limit: number, hardCap: number, extra: Record<string, string> = {}): Promise<{ items: Meta[]; total: number }> {
    const want = Math.min(start + limit, hardCap);
    const all: Meta[] = [];
    let skip = 0;
    let exhausted = false;
    const seen = new Set<string>();
    while (all.length < want) {
      const page = await this.catalogPage(ref, skip, extra);
      let added = 0;
      for (const m of page) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        all.push(m);
        added++;
      }
      if (page.length === 0 || added === 0 || !catalogSupports(ref.def, 'skip')) {
        exhausted = true;
        break;
      }
      skip += page.length;
    }
    const items = all.slice(start, want);
    // When not exhausted, advertise one more page so clients keep paging (until the cap).
    const total = exhausted ? Math.min(all.length, hardCap) : Math.min(hardCap, Math.max(all.length, want) + (all.length >= want ? 100 : 0));
    return { items, total };
  }

  async search(query: string, types: string[] = ['movie', 'series']): Promise<Meta[]> {
    const refs = this.catalogs().filter((c) => types.includes(c.def.type) && catalogSupports(c.def, 'search'));
    // Use one search catalog per (addon, type) to avoid duplicate queries.
    const seen = new Set<string>();
    const picked = refs.filter((r) => {
      const k = `${r.addon.id}|${r.def.type}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const results = await Promise.all(picked.map((r) => this.catalogPage(r, 0, { search: query })));
    // Interleave results by addon order so the best match of each addon comes first.
    return dedupeMetas(results.flat());
  }

  // ---------- meta ----------

  /** Meta with SQLite persistence (stale copies are served when every addon fails). */
  async meta(type: string, id: string): Promise<Meta | undefined> {
    const key = `${type}:${id}`;
    return this.metaMem.wrap(key, async () => {
      const row = this.db.prepare('SELECT json, fetched_at FROM meta_cache WHERE key = ?').get(key) as { json: string; fetched_at: number } | undefined;
      const fresh = row && Date.now() - row.fetched_at < (type === 'series' ? 12 : 72) * 3600_000;
      if (row && fresh) return JSON.parse(row.json) as Meta;
      const fetched = await this.fetchMeta(type, id);
      if (fetched) {
        this.db
          .prepare('INSERT INTO meta_cache (key, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
          .run(key, JSON.stringify(fetched), Date.now());
        return fetched;
      }
      return row ? (JSON.parse(row.json) as Meta) : undefined;
    });
  }

  cachedMeta(type: string, id: string): Meta | undefined {
    const row = this.db.prepare('SELECT json FROM meta_cache WHERE key = ?').get(`${type}:${id}`) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Meta) : undefined;
  }

  private async fetchMeta(type: string, id: string): Promise<Meta | undefined> {
    for (const a of this.enabled()) {
      if (!addonSupports(a.manifest, 'meta', type, id)) continue;
      try {
        const m = await this.http.meta(a, type, id);
        if (m && m.name) return m;
      } catch (e) {
        log.debug(`meta ${type}/${id} from ${a.manifest.name} failed: ${(e as Error).message}`);
      }
    }
    return undefined;
  }

  // ---------- streams / subtitles ----------

  async streams(type: string, videoId: string): Promise<{ addon: InstalledAddon; streams: Stream[] }[]> {
    return this.streamCache.wrap(`${type}:${videoId}`, async () => {
      const addons = this.enabled().filter((a) => addonSupports(a.manifest, 'stream', type, videoId));
      const res = await Promise.all(
        addons.map(async (addon) => {
          try {
            return { addon, streams: await this.http.streams(addon, type, videoId) };
          } catch (e) {
            log.warn(`streams from ${addon.manifest.name} failed`, e);
            return { addon, streams: [] as Stream[] };
          }
        }),
      );
      return res;
    });
  }

  async subtitles(type: string, videoId: string, extra: Record<string, string | number | undefined> = {}): Promise<Subtitle[]> {
    const key = `${type}:${videoId}:${JSON.stringify(extra)}`;
    return this.subtitleCache.wrap(key, async () => {
      const addons = this.enabled().filter((a) => addonSupports(a.manifest, 'subtitles', type, videoId));
      const res = await Promise.all(
        addons.map((a) =>
          this.http.subtitles(a, type, videoId, extra).catch((e) => {
            log.debug(`subtitles from ${a.manifest.name} failed: ${(e as Error).message}`);
            return [] as Subtitle[];
          }),
        ),
      );
      return res.flat();
    });
  }
}

export function dedupeMetas(metas: Meta[]): Meta[] {
  const seen = new Set<string>();
  const out: Meta[] = [];
  for (const m of metas) {
    if (!m || !m.id || seen.has(`${m.type}:${m.id}`)) continue;
    seen.add(`${m.type}:${m.id}`);
    out.push(m);
  }
  return out;
}
