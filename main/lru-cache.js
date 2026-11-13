/**
 * Cache LRU (Least Recently Used) compatível com a interface Map.
 * Evita crescimento ilimitado de memória em servidores 24/7 e promove itens acessados.
 */
function createLruCache({ maxEntries = 500, ttlMs = 0 } = {}) {
  const limit = Math.max(1, Number(maxEntries) || 500);
  const ttl = Math.max(0, Number(ttlMs) || 0);
  const store = new Map();

  function isExpired(entry, now = Date.now()) {
    if (!ttl || !entry || typeof entry !== 'object') return false;
    const ts = entry.t || entry.ts || entry.timestamp || 0;
    return ts > 0 && (now - ts > ttl);
  }

  return {
    get size() {
      return store.size;
    },
    has(key) {
      if (!store.has(key)) return false;
      const val = store.get(key);
      if (isExpired(val)) {
        store.delete(key);
        return false;
      }
      return true;
    },
    get(key) {
      if (!store.has(key)) return undefined;
      const val = store.get(key);
      if (isExpired(val)) {
        store.delete(key);
        return undefined;
      }
      // Promove item acessado para o final (mais recente)
      store.delete(key);
      store.set(key, val);
      return val;
    },
    set(key, value) {
      if (store.has(key)) {
        store.delete(key);
      } else if (store.size >= limit) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) store.delete(oldestKey);
      }
      store.set(key, value);
      return this;
    },
    delete(key) {
      return store.delete(key);
    },
    clear() {
      store.clear();
    },
    keys() {
      return store.keys();
    },
    values() {
      return store.values();
    },
    entries() {
      return store.entries();
    },
    forEach(cb, thisArg) {
      store.forEach(cb, thisArg);
    },
    pruneExpired(now = Date.now()) {
      if (!ttl) return 0;
      let removed = 0;
      for (const [k, v] of store.entries()) {
        if (isExpired(v, now)) {
          store.delete(k);
          removed += 1;
        }
      }
      return removed;
    },
    [Symbol.iterator]() {
      return store[Symbol.iterator]();
    }
  };
}

module.exports = { createLruCache };
