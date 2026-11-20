// hybrid-bridge.js - Ponte Híbrida: Injeção de cabeçalhos anti-aviso ngrok e conectividade
(function () {
  const NGROK_SKIP_HEADER = 'ngrok-skip-browser-warning';
  const NGROK_SKIP_VALUE = '1';

  // Garante que o cookie anti-aviso do ngrok seja gravado no cliente permanentemente
  function applyAntiWarningCookie() {
    try {
      document.cookie = 'ngrok-skip-browser-warning=1; path=/; max-age=31536000; SameSite=Lax';
      document.cookie = 'ngrok-skip-browser-warning=true; path=/; max-age=31536000; SameSite=Lax';
    } catch (e) {}
  }
  applyAntiWarningCookie();

  // Só injeta o cabeçalho em requisições para o PRÓPRIO servidor. Em domínios de terceiros
  // (ipify, Google etc.) um cabeçalho customizado força preflight CORS e a requisição falha.
  function isSameOriginUrl(u) {
    try {
      if (!u) return true;
      const parsed = new URL(u, window.location.href);
      return parsed.origin === window.location.origin || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    } catch (e) {
      return true;
    }
  }

  // Intercepta todas as chamadas 'fetch' para injetar cabeçalho anti-aviso do ngrok
  const originalFetch = window.fetch;
  window.fetch = function (resource, init) {
    let url = (typeof resource === 'string') ? resource : (resource && resource.url ? resource.url : '');
    if (!isSameOriginUrl(url)) {
      return originalFetch.call(this, resource, init);
    }
    init = init || {};

    let headersObj = {};
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => { headersObj[k.toLowerCase()] = v; });
    } else if (Array.isArray(init.headers)) {
      init.headers.forEach(([k, v]) => { headersObj[k.toLowerCase()] = v; });
    } else if (init.headers && typeof init.headers === 'object') {
      Object.keys(init.headers).forEach((k) => { headersObj[k.toLowerCase()] = init.headers[k]; });
    }

    // Injeta sempre o cabeçalho que pula a tela 'Visit Site' do ngrok
    headersObj[NGROK_SKIP_HEADER] = NGROK_SKIP_VALUE;
    init.headers = headersObj;

    const t0 = Date.now();
    const doCall = () => {
      if (typeof resource === 'string') {
        return originalFetch.call(this, url, init);
      }
      try {
        const req = new Request(url, init);
        return originalFetch.call(this, req);
      } catch (e) {
        return originalFetch.call(this, url, init);
      }
    };

    return doCall().then((res) => {
      window.__pplLastRttMs = Math.max(1, Date.now() - t0);
      window.__pplConnErrorStreak = 0;
      return res;
    }).catch((err) => {
      window.__pplConnErrorStreak = (window.__pplConnErrorStreak || 0) + 1;
      const isGet = !init.method || String(init.method).toUpperCase() === 'GET';
      if (!isGet || (init && init.signal && init.signal.aborted)) throw err;
      const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
      const waitMs = (typeof window.__pplAdaptiveBackoffMs === 'function')
        ? window.__pplAdaptiveBackoffMs(window.__pplConnErrorStreak, window.__pplLastRttMs || 120, isMobile)
        : 350;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          doCall().then(resolve).catch(reject);
        }, waitMs);
      });
    });
  };

  // Intercepta XMLHttpRequest para injetar o cabeçalho anti-aviso
  if (typeof window.XMLHttpRequest !== 'undefined') {
    const origOpen = window.XMLHttpRequest.prototype.open;
    const origSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function () {
      this._plUrl = arguments[1];
      return origOpen.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.send = function () {
      try {
        if (isSameOriginUrl(this._plUrl)) this.setRequestHeader(NGROK_SKIP_HEADER, NGROK_SKIP_VALUE);
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  }

  // Atalho global para manter sessão de mídia e áudio mudo anti-suspensão em segundo plano
  window.__papaCreateKeepAlive = function (durationSec) {
      let el = null;
      let timer = null;
      let active = false;
      let wavUrl = '';
      const sec = durationSec || 10;
      function getUrl() {
        if (wavUrl) return wavUrl;
        const sr = 8000;
        const samples = sr * sec;
        const buf = new ArrayBuffer(44 + samples);
        const v = new DataView(buf);
        const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        ws(0, 'RIFF'); v.setUint32(4, 36 + samples, true); ws(8, 'WAVE'); ws(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true);
        v.setUint16(34, 8, true); ws(36, 'data'); v.setUint32(40, samples, true);
        for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
        wavUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
        return wavUrl;
      }
      return {
        isActive: () => active,
        start: (maxMs) => {
          try {
            if (!el) {
              el = new Audio(getUrl());
              el.loop = true;
              el.preload = 'auto';
              el.setAttribute('playsinline', '');
            }
            active = true;
            el.play().catch(() => {});
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { active = false; try { if (el) el.pause(); } catch (e) {} }, maxMs || 60000);
          } catch (e) {}
        },
        stop: () => {
          active = false;
          if (timer) { clearTimeout(timer); timer = null; }
          try { if (el && !el.paused) el.pause(); } catch (e) {}
        }
      };
    };

    // Relator leve de erros dos aparelhos para /api/client-log (com deduplicação e fila em lote)
    const errQueue = [];
    const errSeen = new Map();
    let flushTimer = null;
    const pageName = (location.pathname || '/').slice(0, 60);
    const metaVer = document.querySelector('meta[name="papaleguas-version"]');
    const appVer = (metaVer && metaVer.content) || '';

    function flushClientErrors() {
      flushTimer = null;
      if (!errQueue.length) return;
      const batch = errQueue.splice(0, 15);
      const body = JSON.stringify({ errors: batch });
      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([body], { type: 'application/json' });
          if (navigator.sendBeacon('/api/client-log', blob)) return;
        }
        originalFetch('/api/client-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true
        }).catch(() => {});
      } catch (e) {}
    }

    function enqueueClientError(item) {
      if (!item || !item.message) return;
      const msg = String(item.message);
      // Ignora ruídos comuns de extensões, resize observer e cancelamentos normais de mídia
      if (/ResizeObserver loop|AbortError|NotAllowedError|The play\(\) request was interrupted/i.test(msg)) return;
      const key = `${item.kind}|${msg.slice(0, 120)}|${item.source || ''}:${item.line || 0}`;
      const prev = errSeen.get(key);
      const now = Date.now();
      if (prev && now - prev.t < 60000) {
        prev.count++;
        return;
      }
      if (errSeen.size > 200) errSeen.clear();
      errSeen.set(key, { t: now, count: 1 });
      errQueue.push({
        kind: item.kind || 'error',
        page: pageName,
        version: appVer,
        message: msg.slice(0, 400),
        source: String(item.source || '').slice(0, 140),
        line: item.line || 0,
        col: item.col || 0,
        stack: String(item.stack || '').slice(0, 900),
        count: 1
      });
      if (!flushTimer) flushTimer = setTimeout(flushClientErrors, 2500);
    }

    window.__papaReportError = enqueueClientError;
    window.__papaSwallowed = function (err, where) {
      try {
        if (localStorage.getItem('PAPALEGUAS_DEBUG') === '1') {
          console.debug('[swallowed]', where, err);
        }
      } catch (e) {}
    };
    window.addEventListener('error', (ev) => {
      if (!ev) return;
      enqueueClientError({
        kind: 'onerror',
        message: ev.message || (ev.error && ev.error.message) || 'Runtime error',
        source: ev.filename || '',
        line: ev.lineno || 0,
        col: ev.colno || 0,
        stack: (ev.error && ev.error.stack) || ''
      });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev && ev.reason;
      enqueueClientError({
        kind: 'unhandledrejection',
        message: (r && (r.message || String(r))) || 'Unhandled promise rejection',
        stack: (r && r.stack) || ''
      });
    });
})();

