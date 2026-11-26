import type { IncomingMessage } from 'node:http';
import type { AuthInfo } from './router.ts';

/**
 * Parses the Jellyfin/Emby auth header family:
 *   Authorization: MediaBrowser Client="Infuse", Device="iPhone", DeviceId="x", Version="8", Token="t"
 *   X-Emby-Authorization: (same format)
 *   X-Emby-Token / X-MediaBrowser-Token: <token>
 *   ?api_key= / ?ApiKey=
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
  if (!info.token && query['api_key']) info.token = query['api_key'];
  if (!info.token && query['apikey']) info.token = query['apikey'];
  if (!info.client) {
    const c = req.headers['x-emby-client'];
    if (c) info.client = String(c);
  }
  if (!info.deviceId) {
    const d = req.headers['x-emby-device-id'];
    if (d) info.deviceId = String(d);
  }
  return info;
}

export function parseMediaBrowserHeader(value: string): Record<string, string> | undefined {
  const m = /^\s*(MediaBrowser|Emby)\s+(.*)$/i.exec(value);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(m[2]))) {
    let v = r[2] ?? r[3] ?? '';
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    out[r[1].toLowerCase()] = v;
  }
  return out;
}
