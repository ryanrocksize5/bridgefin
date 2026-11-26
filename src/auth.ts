import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.ts';
import { getSetting, setSetting } from './db.ts';
import { log } from './log.ts';
import type { AuthInfo } from './http/router.ts';
import { LoginLimiter } from './http/limiter.ts';

/** Single-user account + device tokens. */
export class Auth {
  private db: DB;
  readonly limiter: LoginLimiter;

  constructor(db: DB, limiter = new LoginLimiter()) {
    this.db = db;
    this.limiter = limiter;
  }

  /**
   * Called at startup. BRIDGEFIN_PASSWORD only sets the *first* login; after that the
   * settings page owns it (so a restart never undoes a password change). Set
   * BRIDGEFIN_RESET_PASSWORD=1 for one start to replace a forgotten login.
   */
  init(envUser: string, envPassword: string, reset = false): void {
    const hasLogin = !!getSetting(this.db, 'passwordHash');
    if (envPassword && (!hasLogin || reset)) {
      this.setCredentials(envUser || 'admin', envPassword);
      if (reset) {
        this.revokeAll();
        log.warn('Login replaced from BRIDGEFIN_PASSWORD and all devices signed out. Remove BRIDGEFIN_RESET_PASSWORD now.');
      }
      return;
    }
    if (envPassword && hasLogin && !this.checkPassword(this.username(), envPassword)) {
      log.info('BRIDGEFIN_PASSWORD differs from the saved login; the saved one (from the settings page) is used.');
    }
    if (!hasLogin) {
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

  /**
   * Password check with brute-force protection (per IP and overall).
   * Returns retryAfter (seconds) when the caller is temporarily locked out.
   */
  attempt(username: string, password: string, ip: string): { ok: true } | { ok: false; retryAfter: number } {
    const wait = this.limiter.retryAfter(ip);
    if (wait > 0) return { ok: false, retryAfter: wait };
    if (this.checkPassword(username, password)) {
      this.limiter.succeed(ip);
      return { ok: true };
    }
    this.limiter.fail(ip);
    return { ok: false, retryAfter: 0 };
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
