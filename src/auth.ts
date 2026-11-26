import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.ts';
import { getSetting, setSetting } from './db.ts';
import { log } from './log.ts';
import type { AuthInfo } from './http/router.ts';

/** Single-user account + device tokens. */
export class Auth {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  /** Called at startup: seed credentials from env or generate a password once. */
  init(envUser: string, envPassword: string): void {
    if (envPassword) {
      this.setCredentials(envUser || 'admin', envPassword);
      return;
    }
    if (!getSetting(this.db, 'passwordHash')) {
      const generated = randomBytes(9).toString('base64url');
      this.setCredentials(envUser || 'admin', generated);
      log.warn('================================================================');
      log.warn(` No BRIDGEFIN_PASSWORD set. Generated login: ${envUser || 'admin'} / ${generated}`);
      log.warn(' Change it on the settings page (/admin). Shown only once.');
      log.warn('================================================================');
    }
  }

  username(): string {
    return getSetting(this.db, 'username') ?? 'admin';
  }

  setCredentials(username: string, password: string): void {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32);
    setSetting(this.db, 'username', username);
    setSetting(this.db, 'passwordHash', `${salt.toString('hex')}:${hash.toString('hex')}`);
  }

  checkPassword(username: string, password: string): boolean {
    if (username.trim().toLowerCase() !== this.username().toLowerCase()) return false;
    const stored = getSetting(this.db, 'passwordHash');
    if (!stored) return false;
    const [saltHex, hashHex] = stored.split(':');
    const want = Buffer.from(hashHex, 'hex');
    const got = scryptSync(password ?? '', Buffer.from(saltHex, 'hex'), want.length);
    return timingSafeEqual(want, got);
  }

  issueToken(a: AuthInfo): string {
    const token = randomBytes(16).toString('hex');
    const now = Date.now();
    // One token per device id, like Jellyfin.
    if (a.deviceId) this.db.prepare('DELETE FROM tokens WHERE device_id = ?').run(a.deviceId);
    this.db
      .prepare('INSERT INTO tokens (token, device_id, device, client, version, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(token, a.deviceId ?? null, a.device ?? null, a.client ?? null, a.version ?? null, now, now);
    return token;
  }

  validToken(token: string | undefined): boolean {
    if (!token) return false;
    const row = this.db.prepare('SELECT last_seen FROM tokens WHERE token = ?').get(token) as { last_seen: number } | undefined;
    if (!row) return false;
    if (Date.now() - row.last_seen > 60_000) this.db.prepare('UPDATE tokens SET last_seen = ? WHERE token = ?').run(Date.now(), token);
    return true;
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
  }

  revokeAll(): void {
    this.db.prepare('DELETE FROM tokens').run();
  }

  devices(): { token: string; device: string; client: string; version: string; last_seen: number }[] {
    return this.db.prepare('SELECT token, device, client, version, last_seen FROM tokens ORDER BY last_seen DESC').all() as any[];
  }
}
