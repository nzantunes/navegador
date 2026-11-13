'use strict';
// =========================================================================
// PAPALÉGUAS - LIMITADORES DE REQUISIÇÕES (janela deslizante + concorrência)
// =========================================================================
// Implementação em JS puro, sem dependências. Funciona mesmo quando o módulo
// nativo em Rust não carrega.

class RateLimiter {
  /**
   * @param {{ windowMs: number, max: number, maxKeys?: number }} opts
   */
  constructor(opts) {
    this.windowMs = opts.windowMs;
    this.max = opts.max;
    this.maxKeys = opts.maxKeys || 50000;
    this.hits = new Map(); // key -> { prevCount, curCount, curStart }
  }

  /**
   * Registra uma requisição. Janela deslizante aproximada (2 janelas fixas
   * ponderadas): O(1) de memória por chave e sem picos na virada da janela.
   * @returns {{ allowed: boolean, remaining: number, retryAfterSec: number }}
   */
  hit(key, now = Date.now()) {
    let e = this.hits.get(key);
    if (!e) {
      if (this.hits.size >= this.maxKeys) this.prune(now, true);
      e = { prevCount: 0, curCount: 0, curStart: now };
      this.hits.set(key, e);
    }
    const elapsed = now - e.curStart;
    if (elapsed >= this.windowMs) {
      const windowsPassed = Math.floor(elapsed / this.windowMs);
      e.prevCount = windowsPassed === 1 ? e.curCount : 0;
      e.curCount = 0;
      e.curStart += windowsPassed * this.windowMs;
    }
    const weight = 1 - (now - e.curStart) / this.windowMs;
    const estimated = e.prevCount * weight + e.curCount;
    if (estimated >= this.max) {
      const retryAfterSec = Math.max(1, Math.ceil((this.windowMs - (now - e.curStart)) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    e.curCount++;
    return { allowed: true, remaining: Math.max(0, Math.floor(this.max - estimated - 1)), retryAfterSec: 0 };
  }

  prune(now = Date.now(), aggressive = false) {
    for (const [key, e] of this.hits) {
      if (now - e.curStart >= this.windowMs * 2) this.hits.delete(key);
    }
    if (aggressive && this.hits.size >= this.maxKeys) {
      // Ainda cheio (ataque com muitos IPs): descarta os mais antigos
      const drop = Math.ceil(this.maxKeys * 0.1);
      let i = 0;
      for (const key of this.hits.keys()) {
        this.hits.delete(key);
        if (++i >= drop) break;
      }
    }
  }
}

class ConcurrencyLimiter {
  /** @param {{ max: number }} opts */
  constructor(opts) {
    this.max = opts.max;
    this.active = new Map(); // key -> count
  }

  /**
   * Tenta ocupar uma vaga. Retorna a função de liberação (idempotente) ou null.
   * @returns {null | (() => void)}
   */
  acquire(key) {
    const cur = this.active.get(key) || 0;
    if (cur >= this.max) return null;
    this.active.set(key, cur + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.active.get(key) || 1) - 1;
      if (n <= 0) this.active.delete(key);
      else this.active.set(key, n);
    };
  }

  count(key) {
    return this.active.get(key) || 0;
  }
}

module.exports = { RateLimiter, ConcurrencyLimiter };
