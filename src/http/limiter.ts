/**
 * Failed-login limiter: per client IP, plus a global ceiling so rotating IPs can't
 * guess the password quickly either. Successful logins clear that IP's count.
 */
export class LoginLimiter {
  private perIp = new Map<string, { fails: number; since: number }>();
  private global: { fails: number; since: number } = { fails: 0, since: 0 };
  private windowMs: number;
  private maxPerIp: number;
  private maxGlobal: number;

  constructor(opts: { windowMs?: number; maxPerIp?: number; maxGlobal?: number } = {}) {
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.maxPerIp = opts.maxPerIp ?? 10;
    this.maxGlobal = opts.maxGlobal ?? 100;
  }

  /** Seconds until this IP may try again, or 0 when allowed. */
  retryAfter(ip: string, now = Date.now()): number {
    this.expire(now);
    const e = this.perIp.get(ip);
    if (e && e.fails >= this.maxPerIp) return Math.ceil((e.since + this.windowMs - now) / 1000);
    if (this.global.fails >= this.maxGlobal) return Math.ceil((this.global.since + this.windowMs - now) / 1000);
    return 0;
  }

  fail(ip: string, now = Date.now()): void {
    this.expire(now);
    const e = this.perIp.get(ip) ?? { fails: 0, since: now };
    e.fails++;
    this.perIp.set(ip, e);
    if (this.global.fails === 0) this.global.since = now;
    this.global.fails++;
  }

  succeed(ip: string): void {
    this.perIp.delete(ip);
  }

  private expire(now: number): void {
    if (this.global.fails && now - this.global.since > this.windowMs) this.global = { fails: 0, since: 0 };
    for (const [ip, e] of this.perIp) if (now - e.since > this.windowMs) this.perIp.delete(ip);
  }
}
