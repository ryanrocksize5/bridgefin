import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** Path with any /emby or /jellyfin prefix removed, original case. */
  path: string;
  params: Record<string, string>;
  /** Query parameters with lowercase keys (Jellyfin is case-insensitive). */
  query: Record<string, string>;
  /** Parsed JSON body (or form body) when present. */
  body: any;
  /** Set by auth middleware. */
  token?: string;
  auth: AuthInfo;
}

export interface AuthInfo {
  client?: string;
  device?: string;
  deviceId?: string;
  version?: string;
  token?: string;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  re: RegExp;
  names: string[];
  handler: Handler;
  pattern: string;
  public: boolean;
}

export interface RouteOptions {
  /** Route does not require a valid access token. */
  public?: boolean;
}

export class Router {
  private routes: Route[] = [];

  add(method: string | string[], pattern: string | string[], handler: Handler, opts: RouteOptions = {}): void {
    const methods = Array.isArray(method) ? method : [method];
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    for (const m of methods) {
      for (const p of patterns) {
        const names: string[] = [];
        const src = p
          .split('/')
          .map((seg) => {
            if (seg === '*') {
              names.push('wildcard');
              return '(.*)';
            }
            // Params may appear anywhere in a segment: ":id", "stream.:ext", "Stream.:fmt".
            let out = '';
            let last = 0;
            for (const m2 of seg.matchAll(/:(\w+)/g)) {
              out += seg.slice(last, m2.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              names.push(m2[1]);
              out += '([^/]+?)';
              last = m2.index! + m2[0].length;
            }
            return out + seg.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/');
        this.routes.push({
          method: m.toUpperCase(),
          re: new RegExp(`^${src}/?$`, 'i'),
          names,
          handler,
          pattern: p,
          public: !!opts.public,
        });
      }
    }
  }

  get(p: string | string[], h: Handler, o?: RouteOptions) { this.add('GET', p, h, o); }
  post(p: string | string[], h: Handler, o?: RouteOptions) { this.add('POST', p, h, o); }
  del(p: string | string[], h: Handler, o?: RouteOptions) { this.add('DELETE', p, h, o); }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const m = method === 'HEAD' ? 'GET' : method;
    for (const route of this.routes) {
      if (route.method !== m) continue;
      const r = route.re.exec(path);
      if (!r) continue;
      const params: Record<string, string> = {};
      route.names.forEach((n, i) => {
        params[n] = decodeURIComponent(r[i + 1] ?? '');
      });
      return { route, params };
    }
    return undefined;
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
