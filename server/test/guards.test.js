import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../src/lib/cache.js';
import { createRateLimiter, clientKeyFromRequest } from '../src/lib/rateLimit.js';
import { factsCacheKey } from '../src/lib/guards.js';

test('cache returns stored values and expires them after the TTL', async () => {
  const cache = createTtlCache({ ttlMs: 20, maxEntries: 10 });
  cache.set('a', { hello: true });
  assert.deepEqual(cache.get('a'), { hello: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cache.get('a'), undefined);
});

test('cache evicts the least recently used entry past maxEntries', () => {
  const cache = createTtlCache({ ttlMs: 10000, maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // refresh 'a' so 'b' is the LRU entry
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('rate limiter allows up to the limit per window, then blocks', () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 10000 });
  assert.ok(limiter.isAllowed('ip1'));
  assert.ok(limiter.isAllowed('ip1'));
  assert.ok(limiter.isAllowed('ip1'));
  assert.equal(limiter.isAllowed('ip1'), false);
  // A different client has its own budget.
  assert.ok(limiter.isAllowed('ip2'));
});

test('rate limiter resets after the window elapses', async () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 20 });
  assert.ok(limiter.isAllowed('ip1'));
  assert.equal(limiter.isAllowed('ip1'), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(limiter.isAllowed('ip1'));
});

test('clientKeyFromRequest prefers the first x-forwarded-for hop', () => {
  assert.equal(
    clientKeyFromRequest({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }),
    '1.2.3.4',
  );
  assert.equal(clientKeyFromRequest({ headers: {}, ip: '5.6.7.8' }), '5.6.7.8');
  assert.equal(clientKeyFromRequest({ headers: {} }), 'unknown');
});

test('factsCacheKey buckets nearby durations together, far ones apart', () => {
  assert.equal(factsCacheKey('abc12345678', 240), factsCacheKey('abc12345678', 243));
  assert.notEqual(factsCacheKey('abc12345678', 240), factsCacheKey('abc12345678', 21600));
  assert.notEqual(factsCacheKey('abc12345678', 240), factsCacheKey('zzz12345678', 240));
});
