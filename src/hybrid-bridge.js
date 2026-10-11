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

  // Intercepta todas as chamadas 'fetch' para injetar cabeçalho anti-aviso do ngrok
  const originalFetch = window.fetch;
  window.fetch = function (resource, init) {
    let url = (typeof resource === 'string') ? resource : (resource && resource.url ? resource.url : '');
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

    if (typeof resource === 'string') {
      return originalFetch.call(this, url, init);
    } else {
      try {
        const req = new Request(url, init);
        return originalFetch.call(this, req);
      } catch (e) {
        return originalFetch.call(this, url, init);
      }
    }
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
        this.setRequestHeader(NGROK_SKIP_HEADER, NGROK_SKIP_VALUE);
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  }
})();

