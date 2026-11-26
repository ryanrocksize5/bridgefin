import type { IncomingMessage } from 'node:http';
import type { AuthInfo } from './router.ts';

/**
 * Parses the Jellyfin/Emby auth header family, the way Jellyfin's AuthorizationContext does:
 *   Authorization: MediaBrowser Client="Infuse", Device="iPhone", DeviceId="x", Version="8", Token="t"
 *   Authorization: MediaBrowser DeviceId=abc, Device=Ryan's iPhone, Client=Swiftfin iOS, Version=1.7.1, Token=t
 *   X-Emby-Authorization: (same format)
 *   X-Emby-Token / X-MediaBrowser-Token: <token>
 *   ?ApiKey= / ?api_key=
 * Values may be quoted or not, may contain spaces, and keys come in any order.
 */
export function parseAuth(req: IncomingMessage, query: Record<string, string>): AuthInfo {
  const info: AuthInfo = {};
  const headers = [req.headers['authorization'], req.headers['x-emby-authorization']];
  for (const h of headers) {
    const value = Array.isArray(h) ? h[0] : h;
    if (!value) continue;
    const parsed = parseMediaBrowserHeader(value);
    if (!parsed) continue;
    info.client ??= parsed.client;
    info.device ??= parsed.device;
    info.deviceId ??= parsed.deviceid;
    info.version ??= parsed.version;
    info.token ??= parsed.token;
  }
  const tokenHeader = req.headers['x-emby-token'] ?? req.headers['x-mediabrowser-token'];
  if (!info.token && tokenHeader) info.token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  if (!info.token && query['apikey']) info.token = query['apikey'];
  if (!info.token && query['api_key']) info.token = query['api_key'];
  if (!info.client) {
    const c = req.headers['x-emby-client'];
    if (c) info.client = String(c);
  }
  if (!info.deviceId) {
    const d = req.headers['x-emby-device-id'];
    if (d) info.deviceId = String(d);
  }
  if (!info.client) {
    const ua = String(req.headers['user-agent'] ?? '');
    const m = /^(Infuse-\w+)/.exec(ua);
    if (m) info.client = m[1];
  }
  return info;
}

export function parseMediaBrowserHeader(value: string): Record<string, string> | undefined {
  const m = /^\s*(MediaBrowser|Emby)\s+(.*)$/is.exec(value);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const part of m[2].split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    let v = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    if (k) out[k] = v;
  }
  return out;
}
