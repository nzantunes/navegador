// Criptografia Universal PPL (WebAssembly + stream cipher 64-bit) para todos os métodos GET e POST
(function installUniversalPplCrypto() {
  if (typeof window === 'undefined' || window.__pplUniversalCryptoInstalled) return;
  window.__pplUniversalCryptoInstalled = true;

  const _origFetch = window.fetch;
  const MASK_64 = (1n << 64n) - 1n;
  window.__pplClientWasm = window.__pplClientWasm || null;

  (async function loadWasm() {
    try {
      if (typeof WebAssembly === 'undefined') return;
      const isFile = window.location && window.location.protocol === 'file:';
      const origin = (!isFile && window.location && window.location.origin && window.location.origin !== 'null') ? '' : 'http://localhost:8080';
      const res = await _origFetch.call(window, origin + '/api/ppl-wasm?module=client_guard');
      if (!res.ok) return;
      const inst = await WebAssembly.instantiate(await res.arrayBuffer(), {});
      if (inst && inst.instance && inst.instance.exports) {
        window.__pplClientWasm = inst.instance.exports;
      }
    } catch (e) {}
  })();

  function pplKeystreamByte(nonce, idx) {
    const w = window.__pplClientWasm;
    if (w && typeof w.ppl_keystream_byte === 'function') {
      try { return Number(w.ppl_keystream_byte(BigInt(nonce >>> 0), BigInt(idx))) & 0xFF; } catch (e) {}
    }
    const seed = (BigInt(nonce >>> 0) ^ 0x50504C5F32303236n) & MASK_64;
    let z = (seed + (((BigInt(idx) + 1n) * 0x9E3779B97F4A7C15n) & MASK_64)) & MASK_64;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK_64;
    z = (z ^ (z >> 31n)) & MASK_64;
    return Number(z & 0xFFn);
  }

  function encryptPplObj(obj) {
    const arr = new Uint32Array(1);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(arr);
    else arr[0] = (Math.random() * 0xFFFFFFFF) >>> 0;
    const nonce = arr[0] >>> 0;
    const plain = new TextEncoder().encode(JSON.stringify(obj || {}));
    const out = new Uint8Array(plain.length);
    for (let i = 0; i < plain.length; i++) out[i] = plain[i] ^ pplKeystreamByte(nonce, i);
    let bin = '';
    for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
    return nonce.toString(16).padStart(8, '0') + '.' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decryptPplObj(token) {
    try {
      const raw = String(token || '').trim();
      const dot = raw.indexOf('.');
      if (dot <= 0) return null;
      const nonceHex = raw.slice(0, dot);
      if (!/^[0-9a-fA-F]{1,8}$/.test(nonceHex)) return null;
      const nonce = parseInt(nonceHex, 16) >>> 0;
      const b64 = raw.slice(dot + 1).replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
      const bin = atob(b64 + pad);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) ^ pplKeystreamByte(nonce, i);
      const parsed = JSON.parse(new TextDecoder().decode(out));
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function isSameAppOrigin(parsed) {
    if (!parsed) return false;
    if (window.location && window.location.protocol === 'file:') {
      return parsed.origin === 'http://localhost:8080' || parsed.origin === 'http://127.0.0.1:8080';
    }
    if (window.location && window.location.origin && window.location.origin !== 'null') {
      return parsed.origin === window.location.origin;
    }
    return /^(?:localhost|127\.0\.0\.1):8080$/i.test(parsed.host);
  }

  function shouldEncryptPathname(pathname) {
    if (!pathname || pathname === '/api/ppl-wasm') return false;
    if (/\.(?:css|js|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|wasm|json|map)$/i.test(pathname)) return false;
    return true;
  }

  function encryptPplUrl(rawUrl) {
    try {
      const isFile = window.location && window.location.protocol === 'file:';
      const base = (!isFile && window.location && window.location.origin && window.location.origin !== 'null')
        ? window.location.origin
        : 'http://localhost:8080';
      const u = new URL(rawUrl, base);
      if (!isSameAppOrigin(u) || !shouldEncryptPathname(u.pathname)) {
        if (isFile && typeof rawUrl === 'string' && rawUrl.startsWith('/')) return 'http://localhost:8080' + rawUrl;
        return rawUrl;
      }
      if (u.search && !u.searchParams.has('ppl')) {
        const payload = {};
        u.searchParams.forEach((v, k) => { payload[k] = v; });
        const token = encryptPplObj(payload);
        const prefix = (typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl)) ? u.origin : (isFile ? 'http://localhost:8080' : '');
        return prefix + u.pathname + '?ppl=' + encodeURIComponent(token);
      }
      if (isFile && typeof rawUrl === 'string' && rawUrl.startsWith('/')) return 'http://localhost:8080' + rawUrl;
    } catch (e) {}
    return rawUrl;
  }

  function selectBestEndpointPpl(lanRttMs, tunnelRttMs, consecutiveErrors) {
    const w = window.__pplClientWasm;
    if (w && typeof w.select_best_endpoint === 'function') {
      try {
        return Number(w.select_best_endpoint(
          BigInt(Math.max(0, Math.floor(Number(lanRttMs) || 0))),
          BigInt(Math.max(0, Math.floor(Number(tunnelRttMs) || 0))),
          BigInt(Math.max(0, Math.floor(Number(consecutiveErrors) || 0)))
        ));
      } catch (e) {}
    }
    if ((Number(consecutiveErrors) || 0) >= 2) return 2;
    const lan = Math.max(0, Math.floor(Number(lanRttMs) || 0));
    const tun = Math.max(0, Math.floor(Number(tunnelRttMs) || 0));
    if (lan > 0 && (tun === 0 || lan + 15 < tun)) return 1;
    return 2;
  }

  function computeAdaptiveBackoffMsPpl(attempt, rttMs, isMobileNet) {
    const w = window.__pplClientWasm;
    if (w && typeof w.compute_adaptive_backoff_ms === 'function') {
      try {
        return Number(w.compute_adaptive_backoff_ms(
          BigInt(Math.max(1, Math.floor(Number(attempt) || 1))),
          BigInt(Math.max(0, Math.floor(Number(rttMs) || 0))),
          isMobileNet ? 1 : 0
        ));
      } catch (e) {}
    }
    const step = Math.min(6, Math.max(1, Math.floor(Number(attempt) || 1)));
    let base = step * 350 + (isMobileNet ? 250 : 0);
    const bonus = Math.min(2000, Math.max(0, Math.floor(Number(rttMs) || 0)));
    return Math.min(8000, Math.max(250, base + Math.floor(bonus / 2)));
  }

  window.__pplEncryptPayload = encryptPplObj;
  window.__pplDecryptPayload = decryptPplObj;
  window.__pplEncryptUrl = encryptPplUrl;
  window.__pplSelectBestEndpoint = selectBestEndpointPpl;
  window.__pplAdaptiveBackoffMs = computeAdaptiveBackoffMsPpl;
  window.encryptPplSearchUrl = encryptPplUrl;

  window.fetch = function(input, init) {
    try {
      const isFile = window.location && window.location.protocol === 'file:';
      const base = (!isFile && window.location && window.location.origin && window.location.origin !== 'null')
        ? window.location.origin
        : 'http://localhost:8080';
      const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      const parsed = new URL(urlStr, base);
      if (isSameAppOrigin(parsed) && shouldEncryptPathname(parsed.pathname)) {
        if (parsed.search && !parsed.searchParams.has('ppl')) {
          const encUrl = encryptPplUrl(typeof input === 'string' ? urlStr : parsed.href);
          input = (typeof input === 'string') ? encUrl : new Request(encUrl, input);
        } else if (isFile && typeof input === 'string' && input.startsWith('/')) {
          input = 'http://localhost:8080' + input;
        }
        if (init && typeof init.body === 'string') {
          const trimmed = init.body.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            const bodyObj = JSON.parse(trimmed);
            if (bodyObj && typeof bodyObj === 'object' && !bodyObj.ppl) {
              init = Object.assign({}, init, { body: JSON.stringify({ ppl: encryptPplObj(bodyObj) }) });
            }
          }
        }
      }
    } catch (e) {}
    return _origFetch.call(this, input, init);
  };

  if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      let nextUrl = url;
      try {
        const isFile = window.location && window.location.protocol === 'file:';
        const base = (!isFile && window.location && window.location.origin && window.location.origin !== 'null')
          ? window.location.origin
          : 'http://localhost:8080';
        const parsed = new URL(String(url || ''), base);
        this.__pplEncryptedTarget = isSameAppOrigin(parsed) && shouldEncryptPathname(parsed.pathname);
        if (this.__pplEncryptedTarget && parsed.search && !parsed.searchParams.has('ppl')) {
          nextUrl = encryptPplUrl(String(url));
        }
      } catch (e) {}
      const args = Array.prototype.slice.call(arguments);
      args[1] = nextUrl;
      return _origOpen.apply(this, args);
    };
    XMLHttpRequest.prototype.send = function(body) {
      try {
        if (this.__pplEncryptedTarget && typeof body === 'string') {
          const trimmed = body.trim();
          if (trimmed.startsWith('{')) {
            const obj = JSON.parse(trimmed);
            if (obj && !obj.ppl) body = JSON.stringify({ ppl: encryptPplObj(obj) });
          }
        }
      } catch (e) {}
      return _origSend.call(this, body);
    };
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    // Usa fase de borbulhamento (false) e respeita ev.defaultPrevented para nunca sequestrar
    // formulários SPA (ex: chat do DJ Papaléguas IA, modais) que usam fetch/AJAX via JS.
    document.addEventListener('submit', function(ev) {
      if (ev.defaultPrevented) return;
      const form = ev.target;
      if (!form || form.tagName !== 'FORM' || form.hasAttribute('data-no-ppl')) return;
      const rawAction = String(form.getAttribute('action') || '').trim();
      if (!rawAction) return;
      try {
        const u = new URL(rawAction, window.location.origin || 'http://localhost:8080');
        if (!isSameAppOrigin(u) || !shouldEncryptPathname(u.pathname)) return;
        const method = String(form.getAttribute('method') || 'GET').toUpperCase();
        if (method === 'GET') {
          ev.preventDefault();
          const payload = {};
          new FormData(form).forEach((v, k) => { payload[k] = String(v); });
          window.location.href = u.pathname + '?ppl=' + encodeURIComponent(encryptPplObj(payload));
        }
      } catch (e) {}
    }, false);
  }
})();
