import type { DB } from '../db.ts';
import { getSetting, setSetting } from '../db.ts';
import { keys, parseKey } from '../ids.ts';
import type { Library, LibraryEvent } from '../library.ts';
import { TICKS_PER_MS } from '../library.ts';
import { log } from '../log.ts';
import type { AddonService } from './addons.ts';
import { decodeWatched, encodeWatched, watchedVideoIds } from './watched-bitfield.ts';

const API = 'https://api.strem.io/api';

export interface StremioLibraryItem {
  _id: string;
  name: string;
  type: string;
  poster?: string | null;
  posterShape?: string;
  removed: boolean;
  temp: boolean;
  _ctime?: string | null;
  _mtime: string;
  behaviorHints?: Record<string, unknown>;
  state: {
    lastWatched?: string | null;
    timeWatched: number;
    timeOffset: number;
    overallTimeWatched: number;
    timesWatched: number;
    flaggedWatched: number;
    duration: number;
    video_id?: string | null;
    watched?: string | null;
    noNotif: boolean;
  };
}

export interface SyncStatus {
  loggedIn: boolean;
  email?: string;
  writeBack: boolean;
  lastPull?: number;
  lastError?: string;
  pending: number;
}

/**
 * Optional link to a Stremio account. Local data always works without it.
 * - Import: addons + library + progress (remote wins only when newer).
 * - Write-back (off by default): pushes favorites / progress / watched marks.
 * Network failures never block anything; pending pushes are retried.
 */
export class StremioSync {
  private db: DB;
  private addons: AddonService;
  private library: Library;
  private timer?: NodeJS.Timeout;
  private pushTimer?: NodeJS.Timeout;
  private pending = new Set<string>();
  private lastError?: string;
  private fetchImpl: typeof fetch;

  constructor(db: DB, addons: AddonService, library: Library, fetchImpl: typeof fetch = fetch) {
    this.db = db;
    this.addons = addons;
    this.library = library;
    this.fetchImpl = fetchImpl;
    library.on('change', (e: LibraryEvent) => this.onLocalChange(e));
    const saved = getSetting(db, 'stremioPending');
    if (saved) for (const k of JSON.parse(saved) as string[]) this.pending.add(k);
  }

  private authKey(): string | undefined {
    return getSetting(this.db, 'stremioAuthKey');
  }

  writeBack(): boolean {
    return getSetting(this.db, 'stremioWriteBack') === '1';
  }

  setWriteBack(on: boolean): void {
    setSetting(this.db, 'stremioWriteBack', on ? '1' : '0');
  }

  status(): SyncStatus {
    const last = getSetting(this.db, 'stremioLastPull');
    return {
      loggedIn: !!this.authKey(),
      email: getSetting(this.db, 'stremioEmail'),
      writeBack: this.writeBack(),
      lastPull: last ? Number(last) : undefined,
      lastError: this.lastError,
      pending: this.pending.size,
    };
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (json?.error) throw new Error(`Stremio ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
    if (!res.ok) throw new Error(`Stremio ${method}: HTTP ${res.status}`);
    return json.result as T;
  }

  async login(email: string, password: string): Promise<void> {
    const r = await this.call<{ authKey: string }>('login', { type: 'Login', email, password, facebook: false });
    if (!r?.authKey) throw new Error('Stremio login returned no auth key');
    // Only the auth key is stored, never the password.
    setSetting(this.db, 'stremioAuthKey', r.authKey);
    setSetting(this.db, 'stremioEmail', email);
    log.info(`Stremio account linked: ${email}`);
  }

  async logout(): Promise<void> {
    const key = this.authKey();
    if (key) await this.call('logout', { type: 'Logout', authKey: key }).catch(() => undefined);
    setSetting(this.db, 'stremioAuthKey', null);
    setSetting(this.db, 'stremioEmail', null);
    this.pending.clear();
    this.savePending();
  }

  start(intervalMs = 15 * 60_000): void {
    this.stop();
    const tick = () => {
      if (!this.authKey()) return;
      this.pull().catch((e) => log.warn('Stremio pull failed', e));
      this.flush().catch((e) => log.warn('Stremio push failed', e));
    };
    setTimeout(tick, 5000).unref();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ import

  async importAddons(): Promise<{ added: number; skipped: number }> {
    const key = this.authKey();
    if (!key) throw new Error('Not logged in to Stremio');
    const r = await this.call<{ addons: { transportUrl: string; manifest: any; flags?: { protected?: boolean } }[] }>('addonCollectionGet', {
      type: 'AddonCollectionGet',
      authKey: key,
      update: true,
    });
    let added = 0;
    let skipped = 0;
    for (const a of r.addons ?? []) {
      const url = a.transportUrl ?? '';
      if (!/^https?:\/\//i.test(url) || /\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url)) {
        skipped++;
        continue;
      }
      if (this.addons.list().some((x) => x.transportUrl === url)) {
        skipped++;
        continue;
      }
      try {
        await this.addons.install(url, { manifest: a.manifest?.id ? a.manifest : undefined, enableCatalogs: false });
        added++;
      } catch (e) {
        log.warn(`could not import addon ${url}`, e);
        skipped++;
      }
    }
    return { added, skipped };
  }

  async pull(): Promise<{ items: number }> {
    const key = this.authKey();
    if (!key) throw new Error('Not logged in to Stremio');
    try {
      const items = await this.call<StremioLibraryItem[]>('datastoreGet', { authKey: key, collection: 'libraryItem', ids: [], all: true });
      let n = 0;
      for (const it of items ?? []) {
        if (it.type !== 'movie' && it.type !== 'series') continue;
        await this.applyRemote(it);
        n++;
      }
      setSetting(this.db, 'stremioLastPull', String(Date.now()));
      this.lastError = undefined;
      log.info(`Stremio pull: ${n} library items`);
      return { items: n };
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  private async applyRemote(it: StremioLibraryItem): Promise<void> {
    const type = it.type as 'movie' | 'series';
    const libKey = type === 'movie' ? keys.movie(it._id) : keys.series(it._id);
    const remoteM = Date.parse(it._mtime) || 0;
    const local = this.library.libraryRow(libKey);
    const inLibRemote = !it.removed;
    if (!local || remoteM > local.mtime) {
      if (inLibRemote || local) {
        this.library.setInLibrary(libKey, type, it.name, it.poster ?? undefined, inLibRemote, {
          mtime: remoteM,
          addedAt: Date.parse(it._ctime ?? '') || remoteM,
          silent: true,
        });
      }
    }

    const s = it.state ?? ({} as StremioLibraryItem['state']);
    const lastWatched = Date.parse(s.lastWatched ?? '') || undefined;
    if (type === 'movie') {
      const ud = this.library.get(libKey);
      if (ud && ud.mtime >= remoteM) return;
      const played = (s.flaggedWatched ?? 0) > 0 || (s.timesWatched ?? 0) > 0;
      if (!played && !(s.timeOffset > 0) && !ud) return;
      this.library.importUserData(libKey, null, {
        played: played ? 1 : 0,
        position_ticks: played ? 0 : Math.max(0, (s.timeOffset ?? 0) * TICKS_PER_MS),
        runtime_ticks: (s.duration ?? 0) * TICKS_PER_MS,
        play_count: Math.max(s.timesWatched ?? 0, played ? 1 : 0),
        last_played: lastWatched ?? null,
        mtime: remoteM,
      });
      return;
    }

    // Series: watched bitfield + in-progress episode.
    if (!s.watched && !s.video_id) return;
    const meta = await this.addons.meta('series', it._id).catch(() => undefined);
    if (!meta?.videos?.length) return;
    const ids = watchedVideoIds(meta.videos);
    const watched = decodeWatched(s.watched, ids);
    ids.forEach((vid, i) => {
      if (!watched[i]) return;
      const ek = keys.episode(it._id, vid);
      const cur = this.library.get(ek);
      if (cur?.played) return; // merge: never un-watch from remote
      this.library.importUserData(ek, libKey, { played: 1, position_ticks: 0, play_count: Math.max(1, cur?.play_count ?? 0), last_played: cur?.last_played ?? lastWatched ?? null, mtime: remoteM });
    });
    if (s.video_id && s.timeOffset > 1) {
      const ek = keys.episode(it._id, s.video_id);
      const cur = this.library.get(ek);
      if (!cur || (cur.mtime < remoteM && !cur.played)) {
        this.library.importUserData(ek, libKey, {
          position_ticks: s.timeOffset * TICKS_PER_MS,
          runtime_ticks: (s.duration ?? 0) * TICKS_PER_MS,
          last_played: lastWatched ?? null,
          mtime: remoteM,
        });
      }
    }
  }

  // ------------------------------------------------------------------ write-back

  private onLocalChange(e: LibraryEvent): void {
    if (!this.authKey() || !this.writeBack()) return;
    const k = parseKey(e.kind === 'userdata' && e.parentKey ? e.parentKey : e.key);
    if (k.kind !== 'movie' && k.kind !== 'series') return;
    this.pending.add(k.kind === 'movie' ? keys.movie(k.stremioId!) : keys.series(k.stremioId!));
    this.savePending();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.flush().catch((err) => log.warn('Stremio push failed', err)), 10_000);
    this.pushTimer.unref();
  }

  private savePending(): void {
    setSetting(this.db, 'stremioPending', JSON.stringify([...this.pending]));
  }

  async flush(): Promise<number> {
    const key = this.authKey();
    if (!key || !this.writeBack() || !this.pending.size) return 0;
    const libKeys = [...this.pending];
    const stremioIds = libKeys.map((k) => parseKey(k).stremioId!);
    // If the current remote state can't be read, push nothing (items stay pending):
    // writing blind would overwrite Stremio's data with blanks.
    let remote: StremioLibraryItem[];
    try {
      remote = await this.call<StremioLibraryItem[]>('datastoreGet', { authKey: key, collection: 'libraryItem', ids: stremioIds, all: false });
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
    const byId = new Map((remote ?? []).map((r) => [r._id, r]));
    const changes: StremioLibraryItem[] = [];
    for (const lk of libKeys) {
      const item = await this.buildItem(lk, byId.get(parseKey(lk).stremioId!));
      if (item) changes.push(item);
    }
    if (changes.length) await this.call('datastorePut', { authKey: key, collection: 'libraryItem', changes });
    for (const lk of libKeys) this.pending.delete(lk);
    this.savePending();
    log.info(`Stremio push: ${changes.length} items`);
    return changes.length;
  }

  private async buildItem(libKey: string, existing: StremioLibraryItem | undefined): Promise<StremioLibraryItem | undefined> {
    const k = parseKey(libKey);
    const type = k.kind as 'movie' | 'series';
    const id = k.stremioId!;
    const row = this.library.libraryRow(libKey);
    const meta = this.addons.cachedMeta(type, id) ?? (await this.addons.meta(type, id).catch(() => undefined));
    const now = new Date().toISOString();
    const base: StremioLibraryItem = existing
      ? structuredClone(existing)
      : {
          _id: id,
          name: meta?.name ?? row?.name ?? id,
          type,
          poster: meta?.poster ?? row?.poster ?? null,
          posterShape: 'poster',
          removed: true,
          temp: true,
          _ctime: now,
          _mtime: now,
          behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: type === 'series' },
          state: { lastWatched: null, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false },
        };
    // Only change library membership when we actually have a local decision that is newer
    // than Stremio's; otherwise keep whatever Stremio says (e.g. added on another device).
    const remoteM = existing ? Date.parse(existing._mtime) || 0 : 0;
    if (row && (!existing || row.mtime > remoteM)) {
      base.removed = !!row.removed;
      base.temp = !!row.removed;
    }
    base._mtime = now;
    const s = base.state;

    if (type === 'movie') {
      const ud = this.library.get(libKey);
      if (ud) {
        s.timeOffset = Math.round(ud.position_ticks / TICKS_PER_MS);
        if (ud.runtime_ticks) s.duration = Math.round(ud.runtime_ticks / TICKS_PER_MS);
        s.flaggedWatched = ud.played ? 1 : 0;
        s.timesWatched = Math.max(s.timesWatched ?? 0, ud.play_count);
        if (ud.last_played) s.lastWatched = new Date(ud.last_played).toISOString();
        s.video_id = id;
      }
    } else if (meta?.videos?.length) {
      const ids = watchedVideoIds(meta.videos);
      const remoteWatched = decodeWatched(s.watched, ids);
      const children = new Map(this.library.children(libKey).map((r) => [r.key, r]));
      const watched = ids.map((vid, i) => {
        const r = children.get(keys.episode(id, vid));
        return r ? !!r.played : remoteWatched[i];
      });
      s.watched = encodeWatched(watched, ids);
      const recent = [...children.values()].filter((r) => r.last_played).sort((a, b) => (b.last_played ?? 0) - (a.last_played ?? 0))[0];
      if (recent) {
        s.video_id = parseKey(recent.key).videoId ?? s.video_id;
        s.timeOffset = recent.played ? 0 : Math.round(recent.position_ticks / TICKS_PER_MS);
        if (recent.runtime_ticks) s.duration = Math.round(recent.runtime_ticks / TICKS_PER_MS);
        s.lastWatched = new Date(recent.last_played!).toISOString();
      }
    }
    return base;
  }
}
