import { randomUUID } from 'node:crypto';
import path from 'node:path';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(env(name), 10);
  return Number.isFinite(n) ? n : fallback;
}

export type PlaybackMode = 'redirect' | 'proxy';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  serverName: string;
  /** Initial credentials; can be changed later from the admin page. */
  username: string;
  password: string;
  torboxApiKey: string;
  playbackMode: PlaybackMode;
  catalogLimit: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Version reported to clients. Swiftfin/Infuse check this. */
  jellyfinVersion: string;
  addonTimeoutMs: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(env('DATA_DIR', './data'));
  const mode = env('PLAYBACK_MODE', 'redirect');
  const cfg: Config = {
    port: envInt('PORT', 8096),
    host: env('HOST', '0.0.0.0'),
    dataDir,
    dbPath: path.join(dataDir, 'bridgefin.db'),
    serverName: env('SERVER_NAME', 'Bridgefin'),
    username: env('BRIDGEFIN_USERNAME', 'admin'),
    password: env('BRIDGEFIN_PASSWORD', ''),
    torboxApiKey: env('TORBOX_API_KEY', ''),
    playbackMode: mode === 'proxy' ? 'proxy' : 'redirect',
    catalogLimit: envInt('CATALOG_LIMIT', 300),
    logLevel: (env('LOG_LEVEL', 'info') as Config['logLevel']),
    // Swiftfin warns below 12.1; Infuse 8.5.6+ supports 12.x.
    jellyfinVersion: env('JELLYFIN_VERSION', '12.4.0'),
    addonTimeoutMs: envInt('ADDON_TIMEOUT_MS', 15000),
    ...overrides,
  };
  return cfg;
}

export const newId = (): string => randomUUID().replace(/-/g, '');
