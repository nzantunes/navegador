/**
 * Cache LRU (Least Recently Used) compatível com a interface Map.
 * Evita crescimento ilimitado de memória em servidores 24/7 e promove itens acessados.
 */
const activeLruCaches = new Set();

function createLruCache({ maxEntries = 500, ttlMs = 0 } = {}) {
  const baseLimit = Math.max(1, Number(maxEntries) || 500);
  let limit = baseLimit;
  const ttl = Math.max(0, Number(ttlMs) || 0);
  const store = new Map();

  function isExpired(entry, now = Date.now()) {
    if (!ttl || !entry || typeof entry !== 'object') return false;
    const ts = entry.t || entry.ts || entry.timestamp || 0;
    return ts > 0 && (now - ts > ttl);
  }

  const cacheObj = {
    get size() {
      return store.size;
    },
    get maxEntries() {
      return limit;
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
    setScale(scaleRatio = 1) {
      const ratio = Math.max(0.25, Math.min(2, Number(scaleRatio) || 1));
      limit = Math.max(10, Math.round(baseLimit * ratio));
      let evicted = 0;
      while (store.size > limit) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) break;
        store.delete(oldestKey);
        evicted += 1;
      }
      return evicted;
    },
    [Symbol.iterator]() {
      return store[Symbol.iterator]();
    }
  };
  activeLruCaches.add(cacheObj);
  return cacheObj;
}

function applyHardwareTunerToCaches(recommendedLimit = 5000, shedLoad = false) {
  const ratio = shedLoad ? 0.5 : (recommendedLimit >= 10000 ? 1.25 : 1.0);
  let entriesBefore = 0;
  let entriesAfter = 0;
  let totalRemoved = 0;
  for (const c of activeLruCaches) {
    entriesBefore += c.size;
    totalRemoved += c.pruneExpired();
    totalRemoved += c.setScale(ratio);
    entriesAfter += c.size;
  }
  return { cachesCount: activeLruCaches.size, entriesBefore, entriesAfter, totalRemoved, shedLoad, recommendedLimit };
}

module.exports = { createLruCache, applyHardwareTunerToCaches };
