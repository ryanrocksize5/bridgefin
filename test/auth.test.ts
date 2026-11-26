import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth } from '../src/auth.ts';
import { openDb } from '../src/db.ts';
import { LoginLimiter } from '../src/http/limiter.ts';
import { setLogLevel } from '../src/log.ts';

setLogLevel('error');

test('locks an IP out after 10 failures, even with the right password; other IPs unaffected', () => {
  const auth = new Auth(openDb(':memory:'));
  auth.init('admin', 'secret');
  for (let i = 0; i < 10; i++) assert.deepEqual(auth.attempt('admin', 'wrong', '1.1.1.1'), { ok: false, retryAfter: 0 });
  const locked = auth.attempt('admin', 'secret', '1.1.1.1');
  assert.equal(locked.ok, false);
  assert.ok(!locked.ok && locked.retryAfter > 0);
  assert.deepEqual(auth.attempt('admin', 'secret', '2.2.2.2'), { ok: true });
});

test('global ceiling stops guessing from many IPs; window expiry unlocks', () => {
  const lim = new LoginLimiter({ windowMs: 1000, maxPerIp: 10, maxGlobal: 5 });
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) lim.fail(`10.0.0.${i}`, t0);
  assert.ok(lim.retryAfter('10.0.0.99', t0) > 0);
  assert.equal(lim.retryAfter('10.0.0.99', t0 + 1001), 0);
});

test('BRIDGEFIN_PASSWORD only sets the first login; reset flag replaces it and signs devices out', () => {
  const db = openDb(':memory:');
  const a = new Auth(db);
  a.init('admin', 'first');
  a.setCredentials('admin', 'changed-in-settings');
  const token = a.issueToken({ deviceId: 'phone' });
  new Auth(db).init('admin', 'first'); // restart with the same env
  assert.equal(a.checkPassword('admin', 'changed-in-settings'), true);
  assert.equal(a.checkPassword('admin', 'first'), false);
  new Auth(db).init('admin', 'recovered', true); // forgotten-password reset
  assert.equal(a.checkPassword('admin', 'recovered'), true);
  assert.equal(a.validToken(token), false);
});
