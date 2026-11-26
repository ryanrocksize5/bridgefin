import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Auth } from './auth.ts';
import type { Config, PlaybackMode } from './config.ts';
import { newId } from './config.ts';
import { getSetting, openDb, setSetting, type DB } from './db.ts';
import { parseAuth } from './http/auth.ts';
import { HttpError, Router, type Ctx } from './http/router.ts';
import { Ids } from './ids.ts';
import { Catalog } from './jellyfin/catalog.ts';
import type { DtoContext } from './jellyfin/dto.ts';
import { Playback } from './jellyfin/playback.ts';
import { registerJellyfinRoutes } from './jellyfin/routes.ts';
import { registerAdminRoutes } from './admin/routes.ts';
import { Library } from './library.ts';
import { log } from './log.ts';
import { AddonHttp } from './stremio/addon-client.ts';
import { AddonService } from './stremio/addons.ts';
import { StremioSync } from './stremio/sync.ts';
import { StreamService } from './streams/service.ts';
import { Torbox } from './torbox.ts';

export interface App {
  cfg: Config;
  db: DB;
  ids: Ids;
  auth: Auth;
  library: Library;
  addons: AddonService;
  torbox: Torbox;
  streams: StreamService;
  catalog: Catalog;
  playback: Playback;
  sync: StremioSync;
  serverId: string;
  userId: string;
  router: Router;
  /** Unhandled routes seen, for the settings page (helps add support for new clients). */
  unhandled: Map<string, { count: number; ua: string; last: number }>;
  playbackMode(): PlaybackMode;
  torboxKey(): string;
}

export function createApp(cfg: Config, opts: { fetchImpl?: typeof fetch } = {}): App {
  const db = openDb(cfg.dbPath);
  let serverId = getSetting(db, 'serverId');
  if (!serverId) {
    serverId = newId();
    setSetting(db, 'serverId', serverId);
  }
  let userId = getSetting(db, 'userId');
  if (!userId) {
    userId = newId();
    setSetting(db, 'userId', userId);
  }
  const ids = new Ids(db);
  const auth = new Auth(db);
  auth.init(cfg.username, cfg.password);
  const library = new Library(db);
  const addons = new AddonService(db, new AddonHttp(cfg.addonTimeoutMs));
  if (cfg.torboxApiKey && !getSetting(db, 'torboxApiKey')) setSetting(db, 'torboxApiKey', cfg.torboxApiKey);
  const torboxKey = () => getSetting(db, 'torboxApiKey') ?? cfg.torboxApiKey;
  const torbox = new Torbox(torboxKey, opts.fetchImpl);
  const streams = new StreamService(db, addons, torbox);
  const dtoCtx: DtoContext = { serverId, userId, ids, library, db };
  const catalog = new Catalog(dtoCtx, addons, library, cfg.catalogLimit);
  const playbackMode = (): PlaybackMode => (getSetting(db, 'playbackMode') as PlaybackMode | undefined) ?? cfg.playbackMode;
  const playback = new Playback(catalog, streams, playbackMode);
  const sync = new StremioSync(db, addons, library, opts.fetchImpl);
  const router = new Router();
  const app: App = {
    cfg, db, ids, auth, library, addons, torbox, streams, catalog, playback, sync,
    serverId, userId, router, unhandled: new Map(), playbackMode, torboxKey,
  };
  registerJellyfinRoutes(app);
  registerAdminRoutes(app);
  return app;
}

const PREFIX_RE = /^\/(emby|jellyfin|mediabrowser)(?=\/|$)/i;

async function readBody(req: IncomingMessage): Promise<any> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  const ct = String(req.headers['content-type'] ?? '');
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function clientIp(req: IncomingMessage): string {
  const xf = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xf) ? xf[0] : xf)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || '';
}

/** Properties whose values are dictionaries: Jellyfin keeps their keys as-is in camelCase mode. */
const DICT_PROPS = new Set(['ImageTags', 'ProviderIds', 'ImageBlurHashes', 'RequiredHttpHeaders', 'CustomPrefs']);

/** Jellyfin's `Accept: application/json; profile="CamelCase"` output: first letter lowercased. */
export function camelize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelize);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k.charAt(0).toLowerCase() + k.slice(1)] = DICT_PROPS.has(k) ? val : camelize(val);
  }
  return out;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, camel = false): void {
  if (res.headersSent) return;
  if (body === undefined || status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  const json = JSON.stringify(camel ? camelize(body) : body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

export async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.pathname.replace(PREFIX_RE, '') || '/';
  const query: Record<string, string> = {};
  // Keys are case-insensitive; repeated array params (fields=A&fields=B) are joined like comma lists.
  for (const [k, v] of url.searchParams) {
    const lk = k.toLowerCase();
    query[lk] = query[lk] !== undefined && query[lk] !== '' ? `${query[lk]},${v}` : v;
  }
  const method = (req.method ?? 'GET').toUpperCase();

  res.setHeader('access-control-allow-origin', '*');
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, DELETE, PUT, HEAD, OPTIONS',
      'access-control-allow-headers': 'Authorization, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token, Content-Type, Range',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  const authInfo = parseAuth(req, query);
  const found = app.router.match(method, path);
  try {
    if (!found) {
      recordUnhandled(app, method, path, url.search, String(req.headers['user-agent'] ?? authInfo.client ?? ''));
      // List-shaped routes get an empty list; everything else a 404 (never 401: some clients log out on 401).
      const lower = path.toLowerCase();
      if (method === 'GET' && (/\/items(\/|$)/.test(lower) || lower.endsWith('/episodes') || lower.endsWith('/seasons'))) {
        sendJson(res, 200, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
      } else if (method === 'POST') sendJson(res, 204, undefined);
      else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
      }
      return;
    }
    const authed = app.auth.validToken(authInfo.token);
    if (!found.route.public && !authed) {
      throw new HttpError(401, 'Unauthorized');
    }
    const ctx: Ctx = {
      req,
      res,
      method,
      path,
      params: found.params,
      query,
      body: await readBody(req),
      token: authed ? authInfo.token : undefined,
      auth: authInfo,
    };
    const result = await found.route.handler(ctx);
    if (!res.headersSent && !res.writableEnded) {
      const camel = /profile="?camelcase/i.test(String(req.headers.accept ?? ''));
      if (result === undefined) sendJson(res, 204, undefined);
      else sendJson(res, 200, result, camel);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) log.error(`${method} ${path} failed`, e);
    else log.debug(`${method} ${path} -> ${status} ${(e as Error).message}`);
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end((e as Error).message);
    } else res.destroy();
  } finally {
    log.debug(`${method} ${path}${url.search} ${res.statusCode} ${Date.now() - started}ms [${authInfo.client ?? req.headers['user-agent'] ?? ''}]`);
  }
}

function recordUnhandled(app: App, method: string, path: string, search: string, ua: string): void {
  const k = `${method} ${path.replace(/[0-9a-f]{32}|[0-9a-f-]{36}/gi, '{id}')}`;
  const cur = app.unhandled.get(k) ?? { count: 0, ua, last: 0 };
  cur.count++;
  cur.ua = ua;
  cur.last = Date.now();
  app.unhandled.set(k, cur);
  if (cur.count <= 3) log.info(`unhandled route: ${method} ${path}${search} [${ua}]`);
}

export function startServer(app: App): http.Server {
  const server = http.createServer((req, res) => {
    handle(app, req, res).catch((e) => {
      log.error('request crashed', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  // Jellyfin clients open a websocket at /socket; we don't push events, so refuse politely.
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  });
  server.keepAliveTimeout = 65_000;
  server.listen(app.cfg.port, app.cfg.host, () => log.info(`Bridgefin listening on http://${app.cfg.host}:${app.cfg.port}`));
  return server;
}
