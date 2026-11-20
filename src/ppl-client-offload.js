// PPL Client Offload — Aproveita CPU (Web Worker + .ppl.wasm), RAM (LRU) e Disco (IndexedDB + SW)
// do dispositivo do visitante para acelerar o site e aliviar a carga no servidor :8080.
(function installPplClientOffload() {
  if (typeof window === 'undefined' || window.PplClientOffload) return;

  const DB_NAME = 'papaleguas_client_offload_v1';
  const STORE_NAME = 'kv_cache';
  const RAM_MAX_ENTRIES = 120;
  const IDB_MAX_ENTRIES = 250;

  const ramCache = new Map();
  let dbPromise = null;
  let worker = null;
  let workerSeq = 0;
  const pendingCalls = new Map();

  const stats = {
    ramHits: 0,
    idbHits: 0,
    misses: 0,
    workerTasks: 0,
    wasmLoaded: [],
    swRegistered: false,
    deviceCores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0,
    deviceMemoryGb: (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0
  };

  function openDb() {
    if (dbPromise) return dbPromise;
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'k' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    return dbPromise;
  }

  function ramSet(key, value, expiresAt) {
    if (ramCache.size >= RAM_MAX_ENTRIES) {
      const oldest = ramCache.keys().next().value;
      if (oldest !== undefined) ramCache.delete(oldest);
    }
    ramCache.set(key, { value, expiresAt });
  }

  async function cacheGet(key) {
    const now = Date.now();
    const ramHit = ramCache.get(key);
    if (ramHit) {
      if (ramHit.expiresAt > now) {
        stats.ramHits++;
        return ramHit.value;
      }
      ramCache.delete(key);
    }
    const db = await openDb();
    if (!db) {
      stats.misses++;
      return null;
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => {
          const rec = req.result;
          if (rec && rec.expiresAt > Date.now()) {
            stats.idbHits++;
            ramSet(key, rec.value, rec.expiresAt);
            resolve(rec.value);
          } else {
            stats.misses++;
            resolve(null);
          }
        };
        req.onerror = () => { stats.misses++; resolve(null); };
      } catch (e) {
        stats.misses++;
        resolve(null);
      }
    });
  }

  async function cacheSet(key, value, ttlMs = 300000) {
    const expiresAt = Date.now() + Math.max(5000, Number(ttlMs) || 300000);
    ramSet(key, value, expiresAt);
    const db = await openDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ k: key, value, expiresAt, savedAt: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function pruneExpiredIdb() {
    const db = await openDb();
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        const rows = Array.isArray(allReq.result) ? allReq.result : [];
        const now = Date.now();
        const alive = [];
        for (const r of rows) {
          if (!r || r.expiresAt <= now) store.delete(r.k);
          else alive.push(r);
        }
        if (alive.length > IDB_MAX_ENTRIES) {
          alive.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
          const excess = alive.length - IDB_MAX_ENTRIES;
          for (let i = 0; i < excess; i++) store.delete(alive[i].k);
        }
      };
    } catch (e) {}
  }

  function ensureWorker() {
    if (worker) return worker;
    if (typeof Worker === 'undefined' || (window.location && window.location.protocol === 'file:')) return null;
    try {
      worker = new Worker('/ppl-worker.js?v=1');
      worker.onmessage = (ev) => {
        const msg = ev && ev.data ? ev.data : {};
        if (Array.isArray(msg.wasmLoaded) && msg.wasmLoaded.length) {
          stats.wasmLoaded = msg.wasmLoaded.slice();
        }
        const entry = pendingCalls.get(msg.id);
        if (!entry) return;
        pendingCalls.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error || 'worker_error'));
      };
      worker.onerror = () => {
        worker = null;
      };
    } catch (e) {
      worker = null;
    }
    return worker;
  }

  function callWorker(op, payload, timeoutMs = 2500) {
    const w = ensureWorker();
    if (!w) return Promise.resolve(null);
    stats.workerTasks++;
    return new Promise((resolve) => {
      const id = ++workerSeq;
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        resolve(null);
      }, timeoutMs);
      pendingCalls.set(id, { resolve, reject: () => resolve(null), timer });
      try {
        w.postMessage(Object.assign({ id, op }, payload || {}));
      } catch (e) {
        clearTimeout(timer);
        pendingCalls.delete(id);
        resolve(null);
      }
    });
  }

  async function rankVideos(videos, query) {
    if (!Array.isArray(videos) || videos.length === 0) return [];
    const res = await callWorker('rankVideos', { videos, query });
    return Array.isArray(res) && res.length > 0 ? res : videos;
  }

  async function filterWebResults(items, filterMode, query) {
    if (!Array.isArray(items)) return [];
    const res = await callWorker('filterWebResults', { items, filterMode, query });
    return Array.isArray(res) ? res : items;
  }

  async function computeBackoff(attempt, baseMs = 250, maxMs = 8000) {
    const res = await callWorker('computeBackoff', { attempt, baseMs, maxMs });
    if (typeof res === 'number' && isFinite(res)) return res;
    return Math.min(maxMs, baseMs * (1 << Math.min(6, Math.max(0, (attempt || 1) - 1))));
  }

  // Registra Service Worker se ainda não estiver ativo (HTTPS ou localhost)
  try {
    const isSecure = window.location && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    if (isSecure && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => {
        stats.swRegistered = true;
      }).catch(() => {});
    }
  } catch (e) {}

  // Aquecimento leve em segundo plano (não bloqueia carregamento da página)
  setTimeout(() => {
    callWorker('ping', {});
    pruneExpiredIdb();
  }, 1500);

  window.PplClientOffload = {
    get: cacheGet,
    set: cacheSet,
    rankVideos,
    filterWebResults,
    computeBackoff,
    getStats: () => Object.assign({}, stats, { ramEntries: ramCache.size, workerActive: Boolean(worker) })
  };
})();
