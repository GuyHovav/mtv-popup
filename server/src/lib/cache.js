// Tiny in-memory TTL cache, used to memoize generated fact batches per
// videoId — two visitors watching the same video (or one replaying it)
// shouldn't cost two LLM calls.
//
// Deliberately in-memory: this project is a small stateless demo with no
// database, and adding a KV store just for caching isn't worth the moving
// part. The caveat is that on Vercel each warm serverless instance has its
// own cache and cold starts begin empty — so this is a best-effort cost
// reducer, not a guarantee. Popular videos still hit warm instances often
// enough for it to pay off.

export function createTtlCache({ ttlMs, maxEntries }) {
  const entries = new Map(); // key -> { value, expiresAt }; Map preserves insertion order for LRU-ish eviction

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      entries.delete(key);
      return undefined;
    }
    // Refresh recency so eviction drops the least recently *used* key.
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value) {
    entries.delete(key);
    entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      entries.delete(oldestKey);
    }
  }

  return { get, set, size: () => entries.size };
}
