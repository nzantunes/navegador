// PPL Web Worker — Executa módulos .ppl.wasm e tarefas pesadas de ranking/filtragem
// diretamente na CPU do cliente (thread separada, zero travamento na UI principal).
'use strict';

const wasmExports = {};

async function loadWasmModule(name) {
  if (wasmExports[name]) return wasmExports[name];
  if (typeof WebAssembly === 'undefined') return null;
  try {
    const res = await fetch('/api/ppl-wasm?module=' + encodeURIComponent(name));
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const inst = await WebAssembly.instantiate(buf, {});
    if (inst && inst.instance && inst.instance.exports) {
      wasmExports[name] = inst.instance.exports;
      return wasmExports[name];
    }
  } catch (e) {}
  return null;
}

// Pré-carrega os módulos WASM no boot do Worker
Promise.allSettled([
  loadWasmModule('client_guard'),
  loadWasmModule('rate_guard'),
  loadWasmModule('bm25_engine')
]);

function foldText(s) {
  try {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  } catch (e) {
    return String(s || '').toLowerCase();
  }
}

function rankVideosInWorker(videos, query) {
  if (!Array.isArray(videos) || videos.length === 0) return [];
  const qNorm = foldText(query || '').trim();
  const seen = new Set();
  const scored = [];
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (!v || !v.id || seen.has(v.id)) continue;
    seen.add(v.id);
    const title = foldText(v.title || '');
    const channel = foldText(v.channel || '');
    let score = 100 - Math.min(80, i * 2);
    if (v.isGoogleTrend) score += 25;
    if (v.liked || v.relatedToLiked) score += 35;
    if (qNorm.length >= 3) {
      if (title.includes(qNorm)) score += 45;
      if (channel.includes(qNorm)) score += 20;
    }
    scored.push({ v, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.v);
}

function filterWebResultsInWorker(items, filterMode, query) {
  if (!Array.isArray(items)) return [];
  const mode = String(filterMode || 'all').toLowerCase();
  const qNorm = foldText(query || '').trim();
  return items.filter((item) => {
    if (!item) return false;
    const url = String(item.url || '').toLowerCase();
    if (mode === 'official') {
      return /\.(gov|edu|org|mil)(\.[a-z]{2})?(\/|$)/i.test(url);
    }
    if (mode === 'recent') {
      return Boolean(item.date || item.publishedAt);
    }
    if (qNorm && mode === 'match') {
      return foldText((item.title || '') + ' ' + url + ' ' + (item.snippet || '')).includes(qNorm);
    }
    return true;
  });
}

self.onmessage = async function (ev) {
  const data = ev && ev.data ? ev.data : {};
  const id = data.id;
  const op = data.op;
  try {
    let result = null;
    if (op === 'ping') {
      result = { ok: true, wasmLoaded: Object.keys(wasmExports) };
    } else if (op === 'rankVideos') {
      result = rankVideosInWorker(data.videos, data.query);
    } else if (op === 'filterWebResults') {
      result = filterWebResultsInWorker(data.items, data.filterMode, data.query);
    } else if (op === 'computeBackoff') {
      const rg = await loadWasmModule('rate_guard');
      if (rg && typeof rg.compute_backoff_ms === 'function') {
        result = Number(rg.compute_backoff_ms(
          BigInt(Math.max(1, Math.floor(Number(data.attempt) || 1))),
          BigInt(Math.max(50, Math.floor(Number(data.baseMs) || 250))),
          BigInt(Math.max(250, Math.floor(Number(data.maxMs) || 8000)))
        ));
      } else {
        const step = Math.min(8, Math.max(1, Number(data.attempt) || 1));
        result = Math.min(Number(data.maxMs) || 8000, (Number(data.baseMs) || 250) * (1 << (step - 1)));
      }
    } else if (op === 'selectEndpoint') {
      const cg = await loadWasmModule('client_guard');
      if (cg && typeof cg.select_best_endpoint === 'function') {
        result = Number(cg.select_best_endpoint(
          BigInt(Math.max(0, Math.floor(Number(data.lanRttMs) || 0))),
          BigInt(Math.max(0, Math.floor(Number(data.tunnelRttMs) || 0))),
          BigInt(Math.max(0, Math.floor(Number(data.consecutiveErrors) || 0)))
        ));
      } else {
        result = (Number(data.consecutiveErrors) || 0) >= 2 ? 2 : 1;
      }
    } else if (op === 'bm25Score') {
      const bm = await loadWasmModule('bm25_engine');
      if (bm && typeof bm.bm25_term_score === 'function') {
        result = Number(bm.bm25_term_score(
          BigInt(Math.max(0, Math.floor(Number(data.tf) || 0))),
          BigInt(Math.max(1, Math.floor(Number(data.docLen) || 100))),
          BigInt(Math.max(1, Math.floor(Number(data.avgDocLen) || 100))),
          BigInt(Math.max(0, Math.floor(Number(data.docFreq) || 1))),
          BigInt(Math.max(1, Math.floor(Number(data.totalDocs) || 100)))
        ));
      } else {
        result = 0;
      }
    }
    self.postMessage({ id, ok: true, result, wasmLoaded: Object.keys(wasmExports) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
