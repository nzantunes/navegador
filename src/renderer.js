// Polyfill de fetch para ambiente local Electron (file://) rotear requisições /api/ para http://localhost:8080
if (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:') {
  const _origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && (input.startsWith('/api/') || input.startsWith('/youtube') || input.startsWith('/search') || input.startsWith('/filmes'))) {
      input = 'http://localhost:8080' + input;
    } else if (input instanceof URL && input.protocol === 'file:' && input.pathname.startsWith('/api/')) {
      input = new URL('http://localhost:8080' + input.pathname + input.search);
    }
    return _origFetch.call(this, input, init);
  };
}

let tabs = [];
let activeTabId = null;
let tabCounter = 0;

function publicAppOrigin() {
  if (window.location && window.location.origin && window.location.origin !== 'null' && window.location.protocol !== 'file:') {
    return window.location.origin.replace(/\/$/, '');
  }
  return 'http://localhost:8080';
}

function routeUrlInsideTorApp(raw) {
  const target = String(raw || '').trim();
  if (!target) return target;
  if (target.startsWith('/') && !/^\/proxy(?:\?|$)/i.test(target)) return resolveAppNavUrl(target);
  try {
    const parsed = new URL(target, publicAppOrigin() + '/');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return target;
    if (parsed.pathname === '/proxy' || parsed.pathname.indexOf('/proxy/') === 0) {
      if (useDirectPageLoad()) {
        const inner = parsed.searchParams.get('url');
        if (inner) return inner;
      }
      return resolveAppNavUrl(parsed.pathname + parsed.search + parsed.hash);
    }
    if (isLocalAppHost(parsed.hostname) || (window.location && parsed.origin === window.location.origin)) {
      return resolveAppNavUrl(parsed.pathname + parsed.search + parsed.hash);
    }
    if (useDirectPageLoad()) return parsed.href;
    return resolveAppNavUrl('/proxy?url=' + encodeURIComponent(parsed.href) + '&clientId=' + encodeURIComponent(CLIENT_ID));
  } catch (e) {
    return target;
  }
}

function resolveAppNavUrl(raw) {
  const s = String(raw || '');
  if (!s) return s;
  if (/^https?:\/\//i.test(s) || s.startsWith('file:') || s.startsWith('data:') || s.startsWith('blob:')) return s;
  if (s.startsWith('/')) return publicAppOrigin() + s;
  return s;
}

function isLocalAppHost(host) {
  const h = String(host || '').replace(/:\d+$/, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0'
    || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)
    || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
    || /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h);
}

function isAppShellUrl(raw) {
  try {
    const parsed = new URL(String(raw || ''), window.location.href);
    const p = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
    if (p !== '/' && p !== '/index.html' && p !== '/src/index.html') return false;
    if (parsed.origin === window.location.origin) return true;
    return isLocalAppHost(parsed.hostname);
  } catch (e) {
    return false;
  }
}

function prettyAddressBarUrl(raw) {
  if (!raw) return '';
  const s = String(raw);
  if (/newtab\.html/i.test(s) && !/[?&](?:q|v)=/i.test(s)) return '';
  try {
    if (s.includes('/proxy?url=')) {
      const proxied = new URL(s, window.location.origin).searchParams.get('url');
      if (proxied) return prettyAddressBarUrl(proxied);
    }
  } catch (e) {}
  try {
    const parsed = new URL(s, publicAppOrigin() + '/');
    const q = parsed.searchParams.get('q') || parsed.searchParams.get('query');
    if (q && (/\/search(?:\?|$)/i.test(parsed.pathname) || /duckduckgo\.com/i.test(parsed.hostname))) {
      return q;
    }
  } catch (e) {}
  const lower = s.toLowerCase();
  if (lower.includes('musica.html') || /(^|\/)musica(\?|$)/i.test(s) || lower.includes('open.spotify.com')) {
    return publicAppOrigin() + '/musica';
  }
  if (lower.includes('/filmes') || lower.includes('pluto.tv')) {
    return publicAppOrigin() + '/filmes';
  }
  if (lower.includes('/youtube') || lower.includes('/baixatube') || lower.includes('youtube.com') || lower.includes('youtu.be') || /newtab\.html/i.test(s)) {
    return publicAppOrigin() + '/baixatube';
  }
  return s;
}

function setAddressBar(raw) {
  if (!urlInput) return;
  urlInput.value = prettyAddressBarUrl(raw);
  syncSearchClearButton();
}

function syncSearchClearButton() {
  const btn = document.getElementById('btn-clear-search');
  if (!btn || !urlInput) return;
  btn.hidden = !String(urlInput.value || '').trim();
}

let DEFAULT_URL = 'newtab.html';
const SEARCH_ENGINE = 'https://duckduckgo.com/?q=';

// Identificador único persistente para cada cliente/dispositivo (Desktop ou Celular)
// Garante isolamento completo de abas, player e chat entre múltiplos dispositivos conectados,
// compartilhando o mesmo login e credenciais no servidor.
const CLIENT_ID = (() => {
  let id = null;
  try {
    id = localStorage.getItem('papaleguas_client_id');
  } catch (e) {}
  if (!id) {
    id = 'cli_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
    try {
      localStorage.setItem('papaleguas_client_id', id);
    } catch (e) {}
  }
  return id;
})();

function reportConnectingDeviceIpv4() {
  const post = (body) => {
    fetch('/api/papaleguas/device-telemetry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': CLIENT_ID
      },
      body: JSON.stringify(body)
    }).catch(() => {});
  };

  fetch('https://api4.ipify.org?format=json', { cache: 'no-store' })
    .then((res) => res.json())
    .then((data) => {
      const ip = data && String(data.ip || '').trim();
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) post({ deviceIpv4: ip });
    })
    .catch(() => {});

  try {
    const pc = new (window.RTCPeerConnection || window.webkitRTCPeerConnection)({ iceServers: [] });
    pc.createDataChannel('');
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
    const timer = setTimeout(() => { try { pc.close(); } catch (e) {} }, 1500);
    pc.onicecandidate = (event) => {
      const cand = event && event.candidate && event.candidate.candidate;
      if (!cand) return;
      const match = cand.match(/\b((?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})\b/);
      if (!match) return;
      clearTimeout(timer);
      try { pc.close(); } catch (e) {}
      post({ deviceLanIpv4: match[1], localSubnet: match[1].split('.').slice(0, 3).join('.') + '.x' });
    };
  } catch (e) {}
}

// Se acessado pelo navegador do celular ou fora do Electron, cria o polyfill das APIs via HTTP
if (!window.torBrowserAPI) {
  reportConnectingDeviceIpv4();
  window.torBrowserAPI = {
    getNewTabUrl: async () => 'newtab.html',
    getTorStatus: async () => {
      try {
        const res = await fetch(`/api/tor-status?clientId=${encodeURIComponent(CLIENT_ID)}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        return await res.json();
      } catch (e) {
        return { enabled: false, connected: false };
      }
    },
    toggleTor: async (enabled) => {
      try {
        const res = await fetch(`/api/toggle-tor?clientId=${encodeURIComponent(CLIENT_ID)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body: JSON.stringify({ enabled: (typeof enabled === 'boolean') ? enabled : undefined, clientId: CLIENT_ID })
        });
        return await res.json();
      } catch (e) {
        return { enabled: false, connected: false, locked: false };
      }
    },
    getTorIpInfo: async (deviceIpv4) => {
      try {
        const q = deviceIpv4 ? `&deviceIpv4=${encodeURIComponent(deviceIpv4)}` : '';
        const res = await fetch(`/api/tor-ip-info?clientId=${encodeURIComponent(CLIENT_ID)}${q}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        return await res.json();
      } catch (e) {
        return { IsTor: false, IP: '' };
      }
    },
    getAdblockStatus: async () => ({ enabled: false }),
    toggleAdblock: async () => true,
    getCastDevices: async () => {
      if (window.PapaleguasClientCast) {
        try { return await window.PapaleguasClientCast.scanDevices(); } catch (e) {}
      }
      return [];
    },
    castToDevice: async (deviceId, url, title) => {
      if (window.PapaleguasClientCast) {
        const ip = window.PapaleguasClientCast.extractIp(deviceId);
        if (ip) return window.PapaleguasClientCast.launchRoku(ip, url, title);
      }
      return { success: false, error: 'Informe a TV do seu Wi-Fi para transmitir.' };
    },
    openScreenMirroring: async () => {},
    openExternalUrl: async (url) => { if (url) openUrlOutsideIframe(url); },

    queryAstraAI: async (promptOrObj) => {
      try {
        let prompt = '';
        let history = [];
        if (typeof promptOrObj === 'object' && promptOrObj !== null) {
          prompt = promptOrObj.prompt || promptOrObj.query || '';
          history = Array.isArray(promptOrObj.history) ? promptOrObj.history : [];
        } else {
          prompt = String(promptOrObj || '');
        }
        const res = await fetch('/api/query-ai', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': CLIENT_ID
          },
          body: JSON.stringify({ prompt, history, clientId: CLIENT_ID })
        });
        const data = await res.json();
        return (data && data.reply) ? data.reply : 'Sem resposta no momento.';
      } catch (e) {
        return `Erro ao consultar Papaléguas AI: ${e.message}`;
      }
    },
    executeCode: async (language, code) => {
      return { success: true, stdout: 'Execução local simulada no navegador mobile.', stderr: '', executionTimeMs: 10 };
    },
    searchMusic: async (query) => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&clientId=${encodeURIComponent(CLIENT_ID)}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        return await res.json();
      } catch (e) { return { success: false, results: [] }; }
    },
    searchPlaylists: async (query) => {
      try {
        const res = await fetch(`/api/playlists?q=${encodeURIComponent(query)}&clientId=${encodeURIComponent(CLIENT_ID)}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        return await res.json();
      } catch (e) { return { success: false, results: [] }; }
    },
    searchAll: async (query) => {
      try {
        const res = await fetch(`/api/all?q=${encodeURIComponent(query)}&clientId=${encodeURIComponent(CLIENT_ID)}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        return await res.json();
      } catch (e) { return { success: false, results: [] }; }
    },
    getPlaylistTracks: async (playlistId) => {
      try {
        const res = await fetch(`/api/playlist-tracks?id=${encodeURIComponent(playlistId)}&clientId=${encodeURIComponent(CLIENT_ID)}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        return await res.json();
      } catch (e) { return { success: false, tracks: [] }; }
    },
    getAiMusicRecommendations: async (query, category, excludeTitles) => {
      try {
        const res = await fetch('/api/recommendations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': CLIENT_ID
          },
          body: JSON.stringify({ query, category, excludeTitles, clientId: CLIENT_ID })
        });
        return await res.json();
      } catch (e) { return { success: false, results: [] }; }
    },
    chatDjPapaleguas: async (userMessage, history, excludeTitles) => {
      try {
        const res = await fetch('/api/dj-chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': CLIENT_ID
          },
          body: JSON.stringify({ userMessage, history, excludeTitles, clientId: CLIENT_ID })
        });
        return await res.json();
      } catch (e) { return { success: false, reply: 'Erro de conexão no celular', results: [] }; }
    },
    getFullAudioStream: async ({ title, artist }) => {
      try {
        const res = await fetch('/api/audio-stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': CLIENT_ID
          },
          body: JSON.stringify({ title, artist, clientId: CLIENT_ID })
        });
        return await res.json();
      } catch (e) { return { success: false }; }
    },
    isElectron: false
  };
}

// DOM Elements
const tabsContainer = document.getElementById('tabs-container');
const newTabBtn = document.getElementById('new-tab-btn');
const webviewsContainer = document.getElementById('webviews-container');
const urlInput = document.getElementById('url-input');
const btnGo = document.getElementById('btn-go');
const btnOpenSystemBrowser = document.getElementById('btn-open-system-browser');
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnReload = document.getElementById('btn-reload');
const btnHome = document.getElementById('btn-home');
const statusDot = document.getElementById('status-dot');
const badgeText = document.getElementById('badge-text');
const footerStatus = document.getElementById('footer-status');
const btnCircuit = document.getElementById('btn-circuit');
const circuitModal = document.getElementById('circuit-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const torIpDisplay = document.getElementById('tor-ip-display');
const torCheckStatus = document.getElementById('tor-check-status');
const btnRefreshIp = document.getElementById('btn-refresh-ip');
const btnCheckTorWeb = document.getElementById('btn-check-tor-web');
const btnAdblock = document.getElementById('btn-adblock');
const adblockLabel = document.getElementById('adblock-label');
const btnToggleTor = document.getElementById('btn-toggle-tor');
const torToggleLabel = document.getElementById('tor-toggle-label');
const torModeText = document.getElementById('tor-mode-text');
const btnModalToggleTor = document.getElementById('btn-modal-toggle-tor');
const btnMobileMode = document.getElementById('btn-mobile-mode');
const mobileModeLabel = document.getElementById('mobile-mode-label');
let isMobileMode = false;

function detectClientPlatform() {
  const ua = navigator.userAgent || '';
  const uaMobile = !!(navigator.userAgentData && navigator.userAgentData.mobile);
  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron) || /Electron/i.test(ua);
  const phoneUa = /Android.+Mobile|iPhone|iPod|Opera Mini|IEMobile|webOS|BlackBerry/i.test(ua);
  const tabletUa = /iPad|Android(?!.*Mobile)|Tablet/i.test(ua);
  const touch = (navigator.maxTouchPoints || 0) > 1 || ('ontouchstart' in window);
  const narrow = Math.min(window.innerWidth || 1200, (window.screen && window.screen.width) || 1200) <= 900;
  if (isElectron) return 'pc';
  if (uaMobile || phoneUa) return 'phone';
  if (tabletUa || (touch && narrow)) return 'phone';
  return 'pc';
}

const CLIENT_PLATFORM = detectClientPlatform();
const isNativePhone = CLIENT_PLATFORM === 'phone';

const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36';
const DESKTOP_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

function currentPageUserAgent() {
  return (isNativePhone || isMobileMode) ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT;
}

function isElectronApp() {
  return !!(window.torBrowserAPI && window.torBrowserAPI.isElectron) || /Electron/i.test(navigator.userAgent || '');
}

function isInternalAppUrl(u) {
  if (!u) return true;
  const str = String(u).trim();
  if (
    str.includes('newtab.html') ||
    str.includes('musica.html') ||
    str.startsWith('/musica') ||
    str.startsWith('/youtube') ||
    str.startsWith('/baixatube') ||
    str.startsWith('/search') ||
    str.startsWith('/filmes') ||
    str.startsWith('/ip-check') ||
    str.startsWith('/papaleguas') ||
    str.startsWith('data:') ||
    str.startsWith('blob:')
  ) {
    return true;
  }
  try {
    const parsed = new URL(str, window.location.origin || 'http://localhost:8080');
    if (parsed.origin === window.location.origin || isLocalAppHost(parsed.hostname) || /localhost:8080|127\.0\.0\.1:8080/i.test(parsed.host)) {
      if (/^\/(search|youtube|filmes|musica|baixatube|ip-check|papaleguas)/i.test(parsed.pathname) || /newtab\.html|musica\.html/i.test(parsed.pathname)) {
        return true;
      }
    }
  } catch (e) {}
  return false;
}

function openUrlOutsideIframe(url) {
  if (!url) return;
  let cleanUrl = String(url).trim();

  // Se vier no formato /proxy?url=..., extrai a URL real de destino
  if (cleanUrl.includes('/proxy?url=')) {
    try {
      const u = new URL(cleanUrl, window.location.origin || 'http://localhost:8080').searchParams.get('url');
      if (u) cleanUrl = u;
    } catch (e) {}
  }

  // Se for rota interna do app, continua abrindo dentro do app
  if (isInternalAppUrl(cleanUrl)) {
    createTab(cleanUrl);
    return;
  }

  // Se estiver no Electron Desktop, abre pelo navegador padrão do sistema
  if (isElectronApp() && window.torBrowserAPI && typeof window.torBrowserAPI.openExternalUrl === 'function' && window.torBrowserAPI.isElectron) {
    try {
      window.torBrowserAPI.openExternalUrl(cleanUrl);
      return;
    } catch (e) {}
  }

  // No celular / web browser (PWA):
  // Abre diretamente fora do iframe para evitar bloqueios de X-Frame-Options / frame-ancestors
  try {
    const opened = window.open(cleanUrl, '_blank', 'noopener,noreferrer');
    if (opened) return;
  } catch (e) {}

  try {
    const a = document.createElement('a');
    a.href = cleanUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch (err) {}
    }, 100);
  } catch (e) {
    window.location.href = cleanUrl;
  }
}

function isStandaloneDisplay() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}

function isOnPublicTunnel() {
  const host = (window.location.hostname || '').toLowerCase();
  return host.includes('trycloudflare.com') || host.includes('cfargotunnel.com');
}

function applyClientChrome() {
  const html = document.documentElement;
  const body = document.body;
  const electron = isElectronApp();
  const isPhoneLike = isNativePhone || isMobileMode;
  if (html) {
    html.classList.toggle('client-phone', isPhoneLike);
    html.classList.toggle('client-pc', !isPhoneLike);
    html.classList.toggle('mobile-sim-active', isMobileMode);
    html.classList.toggle('client-electron', electron);
    html.classList.toggle('client-hosted', !electron);
    html.classList.toggle('client-standalone', isStandaloneDisplay());
    html.classList.toggle('client-on-tunnel', isOnPublicTunnel());
  }
  if (body) {
    body.classList.toggle('client-phone', isPhoneLike);
    body.classList.toggle('client-pc', !isPhoneLike);
    body.classList.toggle('mobile-sim-active', isMobileMode);
  }
  if (btnMobileMode) {
    btnMobileMode.classList.toggle('active', isPhoneLike);
    btnMobileMode.title = isNativePhone
      ? 'Celular reconhecido automaticamente'
      : (isMobileMode ? 'Simulando celular no PC' : 'PC reconhecido automaticamente — clique para simular celular');
  }
  if (mobileModeLabel) {
    if (isNativePhone) mobileModeLabel.textContent = 'Celular';
    else mobileModeLabel.textContent = isMobileMode ? 'Mobile: ON' : 'PC';
  }
  checkPhoneLandscapeOrientation();
}

function isPhoneInLandscape() {
  const isPhone = isNativePhone || isMobileMode || (document.documentElement && document.documentElement.classList.contains('client-phone'));
  if (!isPhone) return false;

  const w = window.innerWidth || (window.screen && window.screen.width) || 0;
  const h = window.innerHeight || (window.screen && window.screen.height) || 0;

  const mqLandscape = (window.matchMedia && window.matchMedia('(orientation: landscape)').matches);
  const screenType = (window.screen && window.screen.orientation && window.screen.orientation.type) ? String(window.screen.orientation.type).toLowerCase() : '';
  const isScreenLandscape = screenType.includes('landscape');
  const isWindowLandscape = (typeof window.orientation === 'number') ? (Math.abs(window.orientation) === 90) : false;
  const isAspectLandscape = w > h;

  const isLandscape = isScreenLandscape || isWindowLandscape || mqLandscape || isAspectLandscape;
  if (!isLandscape) return false;

  // Em celulares na horizontal, a altura útil da janela fica <= 640px.
  // Em dispositivo celular nativo reconhecido, qualquer orientação landscape qualifica.
  if (isNativePhone) return true;
  return h <= 640 || isScreenLandscape || isWindowLandscape;
}

function checkPhoneLandscapeOrientation() {
  const landscapeFs = isPhoneInLandscape();
  const html = document.documentElement;
  const body = document.body;
  if (html) html.classList.toggle('phone-landscape-fs', landscapeFs);
  if (body) body.classList.toggle('phone-landscape-fs', landscapeFs);

  // Fecha pesquisa em tela cheia se abrir acidentalmente durante rotação
  if (landscapeFs) {
    const searchFs = document.getElementById('search-fs');
    if (searchFs && !searchFs.hidden) {
      searchFs.hidden = true;
    }
  }

  // Notifica o webview ou iframe da aba ativa para ajustar layout
  try {
    const activeTab = (typeof tabs !== 'undefined' && Array.isArray(tabs)) ? tabs.find(t => t.id === activeTabId) : null;
    if (activeTab && activeTab.webview) {
      if (typeof activeTab.webview.send === 'function') {
        activeTab.webview.send('phone-landscape-change', { isLandscape: landscapeFs });
      } else if (activeTab.webview.contentWindow) {
        activeTab.webview.contentWindow.postMessage({
          type: 'phone-landscape-change',
          isLandscape: landscapeFs
        }, '*');
      }
    }
  } catch (e) {}
}

window.addEventListener('resize', checkPhoneLandscapeOrientation, { passive: true });
window.addEventListener('orientationchange', checkPhoneLandscapeOrientation, { passive: true });
if (window.screen && window.screen.orientation) {
  try {
    window.screen.orientation.addEventListener('change', checkPhoneLandscapeOrientation);
  } catch (e) {}
}
if (window.matchMedia) {
  try {
    const mql = window.matchMedia('(orientation: landscape)');
    if (mql.addEventListener) mql.addEventListener('change', checkPhoneLandscapeOrientation);
    else if (mql.addListener) mql.addListener(checkPhoneLandscapeOrientation);
  } catch (e) {}
}

function applyMobileMode(enabled) {
  if (isNativePhone) {
    applyClientChrome();
    return;
  }
  isMobileMode = !!enabled;
  if (webviewsContainer) {
    webviewsContainer.classList.toggle('mobile-mode', isMobileMode);
  }
  applyClientChrome();
  tabs.forEach(t => {
    if (!t.webview) return;
    // A página visível pode mudar de User-Agent. As que estão no histórico
    // ficam como estão: senão o celular recarrega todas ao voltar.
    try { t.webview.useragent = currentPageUserAgent(); } catch (e) {}
  });
}

applyClientChrome();
if (isNativePhone && webviewsContainer) {
  webviewsContainer.classList.remove('mobile-mode');
}

if (btnMobileMode) {
  btnMobileMode.addEventListener('click', () => {
    if (isNativePhone) return;
    applyMobileMode(!isMobileMode);
  });
}

// ==========================================================================
// PWA: INSTALAÇÃO DO APP NO CELULAR COM ÍCONE PAPALÉGUAS
// ==========================================================================
const btnInstallApp = document.getElementById('btn-install-app');
const installAppModal = document.getElementById('install-app-modal');
const closeInstallModalBtn = document.getElementById('close-install-modal-btn');
const btnTriggerPwaInstall = document.getElementById('btn-trigger-pwa-install');
let deferredInstallPrompt = null;

function hideInstallAppElements() {
  try {
    localStorage.setItem('papaleguas_app_installed', 'true');
  } catch (e) {}
  document.documentElement.classList.add('app-installed', 'client-standalone');
  document.documentElement.setAttribute('data-app-installed', 'true');
  if (document.body) {
    document.body.classList.add('app-installed', 'client-standalone');
    document.body.setAttribute('data-app-installed', 'true');
  }
  if (btnInstallApp) {
    btnInstallApp.style.setProperty('display', 'none', 'important');
    btnInstallApp.classList.remove('pulse-install');
  }
  if (installAppModal) {
    installAppModal.classList.add('hidden');
    installAppModal.style.setProperty('display', 'none', 'important');
  }
  // Notifica todos os iframes e webviews que o app foi instalado
  try {
    document.querySelectorAll('iframe, webview').forEach(frame => {
      try {
        if (frame.contentWindow) {
          frame.contentWindow.postMessage({ type: 'papaleguas-app-installed' }, '*');
        }
      } catch (err) {}
    });
  } catch (err) {}
}

function checkInstalledState() {
  try {
    var isInstalled = localStorage.getItem('papaleguas_app_installed') === 'true';
    var isStandalone = isInstalled ||
      (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || window.matchMedia('(display-mode: minimal-ui)').matches)) ||
      window.navigator.standalone === true ||
      (document.referrer && document.referrer.includes('android-app://'));

    if (isStandalone) {
      hideInstallAppElements();
    }
  } catch (e) {}
}
checkInstalledState();

window.addEventListener('beforeinstallprompt', (e) => {
  var isInstalled = false;
  try { isInstalled = localStorage.getItem('papaleguas_app_installed') === 'true'; } catch (err) {}
  if (isInstalled || document.documentElement.classList.contains('app-installed') || document.documentElement.classList.contains('client-standalone')) {
    e.preventDefault();
    hideInstallAppElements();
    return;
  }
  e.preventDefault();
  deferredInstallPrompt = e;
  if (btnInstallApp) {
    btnInstallApp.classList.add('pulse-install');
    btnInstallApp.title = 'Instalar App no Celular (Disponível Agora)';
  }
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  hideInstallAppElements();
});

function openInstallAppModal() {
  var isInstalled = false;
  try { isInstalled = localStorage.getItem('papaleguas_app_installed') === 'true'; } catch (err) {}
  if (isInstalled || document.documentElement.classList.contains('app-installed')) {
    hideInstallAppElements();
    return;
  }
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then((choiceResult) => {
      if (choiceResult && choiceResult.outcome === 'accepted') {
        deferredInstallPrompt = null;
        hideInstallAppElements();
      }
    });
    return;
  }
  if (installAppModal) {
    const appVerEl = document.getElementById('install-modal-app-version');
    if (appVerEl) {
      if (window.currentServerVersion) {
        appVerEl.textContent = 'Versão ' + window.currentServerVersion + ' (Atualizada)';
      } else {
        fetch('/api/session-info').then(r => r.json()).then(data => {
          if (data && data.serverVersion) {
            window.currentServerVersion = data.serverVersion;
            appVerEl.textContent = 'Versão ' + data.serverVersion + ' (Atualizada)';
          }
        }).catch(() => {});
      }
    }
    installAppModal.classList.remove('hidden');
    installAppModal.style.removeProperty('display');
  }
}

function closeInstallAppModal() {
  if (installAppModal) installAppModal.classList.add('hidden');
}

if (btnInstallApp) {
  btnInstallApp.addEventListener('click', (e) => {
    e.stopPropagation();
    openInstallAppModal();
  });
}

if (closeInstallModalBtn) {
  closeInstallModalBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeInstallAppModal();
  });
}

if (btnTriggerPwaInstall) {
  btnTriggerPwaInstall.addEventListener('click', (e) => {
    e.stopPropagation();
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then((choiceResult) => {
        if (choiceResult && choiceResult.outcome === 'accepted') {
          deferredInstallPrompt = null;
          hideInstallAppElements();
        }
      });
    } else {
      alert('Para instalar:\n1. Toque nos 3 pontinhos (⋮) do Chrome no topo.\n2. Escolha "Instalar aplicativo" ou "Adicionar à tela inicial".');
    }
  });
}

const btnCopyInstallLink = document.getElementById('btn-copy-install-link');
if (btnCopyInstallLink) {
  btnCopyInstallLink.addEventListener('click', async (e) => {
    e.stopPropagation();
    const extLink = document.getElementById('install-external-link');
    const u = (extLink && extLink.href && extLink.href !== '#' && !extLink.href.endsWith('#')) ? extLink.href : currentCloudflareUrl;
    if (u) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(u);
        }
        btnCopyInstallLink.textContent = '✅ Link Copiado!';
        setTimeout(() => { btnCopyInstallLink.textContent = '📋 Copiar Link do Celular'; }, 2500);
      } catch (err) {}
    }
  });
}

window.addEventListener('message', (event) => {
  if (event && event.data) {
    if (event.data.type === 'open-install-app-modal') {
      openInstallAppModal();
    } else if (event.data.type === 'papaleguas-app-installed' || event.data.action === 'app-installed') {
      hideInstallAppElements();
    }
  }
});

let cachedCastDevices = [];
let castPrefetchTimer = null;
let castScanPromise = null;

// Varre a rede uma vez por vez; chamadas simultâneas reaproveitam a busca em andamento.
// onFound é chamado assim que cada TV aparece, para a lista atualizar sem esperar o fim.
async function prefetchCastDevices(onFound) {
  if (!window.PapaleguasClientCast) return cachedCastDevices;
  if (castScanPromise) {
    if (typeof onFound === 'function') {
      castScanPromise.listeners.push(onFound);
      cachedCastDevices.forEach((d) => { try { onFound(d); } catch (e) {} });
    }
    return castScanPromise;
  }
  const listeners = typeof onFound === 'function' ? [onFound] : [];
  const run = (async () => {
    try {
      const devices = await window.PapaleguasClientCast.scanDevices((dev) => {
        if (!dev || !dev.ip) return;
        if (!cachedCastDevices.some((d) => d.ip === dev.ip)) cachedCastDevices.push(dev);
        listeners.forEach((fn) => { try { fn(dev); } catch (e) {} });
      });
      if (Array.isArray(devices) && devices.length) cachedCastDevices = devices;
    } catch (e) {}
    return cachedCastDevices;
  })();
  run.listeners = listeners;
  castScanPromise = run;
  try {
    return await run;
  } finally {
    castScanPromise = null;
  }
}

// Helper para abrir o Papaléguas Music em uma aba e tocar a música pedida
function isPortalTabUrl(url) {
  const u = String(url || '').toLowerCase();
  return u.includes('/musica') || u.includes('musica.html') || u.includes('/filmes') || u.includes('/youtube');
}

function syncPortalHomeButton(url) {
  const on = isPortalTabUrl(url);
  document.documentElement.classList.toggle('portal-home', on);
  document.body.classList.toggle('portal-home', on);
}

function goHomeFromFullscreen() {
  document.documentElement.classList.remove('video-true-fs');
  document.body.classList.remove('video-true-fs');
  document.documentElement.classList.remove('portal-home');
  document.body.classList.remove('portal-home');
  try {
    const exitFs = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exitFs && (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement)) {
      exitFs.call(document);
    }
  } catch (e) {}

  const activeTab = getActiveTab();
  const isMusicTab = activeTab && activeTab.url && (activeTab.url.includes('musica.html') || activeTab.url.includes('/musica'));
  const isMusicActive = lastGlobalMusicState && (lastGlobalMusicState.isPlaying || lastGlobalMusicState.track);

  // Se o usuário está na aba de música e ela está tocando, NÃO destrua a aba!
  // Ativa ou abre a aba Home, mantendo a música tocando no mini player flutuante
  if (isMusicTab && isMusicActive) {
    let homeTab = tabs.find(t => t.url && t.url.includes('newtab.html') && t !== activeTab);
    if (!homeTab) {
      homeTab = createTab(DEFAULT_URL);
    } else {
      activateTab(homeTab.id);
    }
    userDismissedMiniPlayer = false;
    if (globalMusicMiniPlayer) globalMusicMiniPlayer.classList.remove('hidden');
    setAddressBar('');
    return;
  }

  if (activeTab && activeTab.webview) {
    activeTab.url = DEFAULT_URL;
    if (activeTab.header) {
      const titleEl = activeTab.header.querySelector('.tab-title');
      if (titleEl) titleEl.textContent = 'Início';
    }
    activeTab.webview.loadURL(DEFAULT_URL);
  } else {
    window.location.href = DEFAULT_URL;
  }
  setAddressBar('');
}

function enterMenuPortalFullscreen() {
  document.documentElement.classList.add('video-true-fs');
  document.body.classList.add('video-true-fs');
}

function openPapaleguasMusic(searchQuery = '', autoplay = true) {
  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
  const baseUrl = isElectron ? 'http://localhost:8080' : '';
  let musicaUrl = baseUrl + '/musica';
  
  const params = [];
  if (searchQuery && searchQuery.trim()) {
    params.push('q=' + encodeURIComponent(searchQuery.trim()));
  }
  if (autoplay) {
    params.push('autoplay=1');
  }
  if (params.length > 0) {
    musicaUrl += '?' + params.join('&');
  }
  
  // Procura se já existe uma aba do Papaléguas Music aberta
  const existingMusicTab = tabs.find(t => t.url && (t.url.includes('musica.html') || t.url.includes('/musica')));
  
  if (existingMusicTab) {
    activateTab(existingMusicTab.id);
    if (existingMusicTab.webview) {
      try {
        existingMusicTab.webview.send('play-dj-music', { query: searchQuery, autoplay });
      } catch (e) {}
      if (searchQuery) {
        existingMusicTab.webview.loadURL(musicaUrl);
      }
    }
  } else {
    // Cria sempre uma aba dedicada para o Papaléguas Music, garantindo que continue tocando em segundo plano
    createTab(musicaUrl);
  }
  setAddressBar(publicAppOrigin() + '/musica');
  syncPortalHomeButton('/musica');
}

// Tab Management
function createTab(initialUrl = DEFAULT_URL) {
  // Se for qualquer URL do Spotify, intercepta e abre direto o Mini Player em tela cheia
  if (initialUrl && typeof initialUrl === 'string' && initialUrl.includes('open.spotify.com')) {
    let query = '';
    const searchMatch = initialUrl.match(/open\.spotify\.com\/search\/([^/?#]+)/i);
    if (searchMatch && searchMatch[1]) {
      query = decodeURIComponent(searchMatch[1]);
    }
    openPapaleguasMusic(query, true);
    return getActiveTab() || null;
  }

  tabCounter++;
  const tabId = 'tab-' + tabCounter;

  // Tab Header Element
  const tabElem = document.createElement('div');
  tabElem.className = 'tab';
  tabElem.id = 'header-' + tabId;
  tabElem.innerHTML = `
    <img src="data:image/png;base64,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" class="tab-icon" style="width: 18px; height: 18px; object-fit: contain;" />
    <span class="tab-title">Papaléguas</span>
    <button class="tab-close" title="Fechar">&times;</button>
  `;

  // Elemento de visualização da aba:
  // Se estiver no Electron, usa <webview> com tor-browser partition.
  // Se for cliente acessando por navegador web móvel/externo onde <webview> não existe, usa <iframe> nativo.
  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
  let webview;

  if (isElectron) {
    // Cada página aberta pela barra de endereço ou por um link do app ganha o
    // próprio <webview>, que continua carregado em segundo plano. Voltar só
    // reexibe o que já estava pronto, em vez de baixar a página de novo.
    webview = document.createElement('div');
    webview.id = 'view-' + tabId;
    webview.className = 'web-client-iframe';

    const resolveSpecialNav = (url) => {
      if (isIpCheckNav(url)) return publicAppOrigin() + '/ip-check';
      return url;
    };
    const resolveViewUrl = (url) => resolveAppNavUrl(resolveSpecialNav(url));

    const viewHistory = [initialUrl];
    const historyViews = [];
    // Cada página guardada é um processo de renderização a mais, então fica só
    // a vizinha de cada lado: o suficiente para o voltar ser instantâneo.
    const VIEW_CACHE_DISTANCE = 1;
    let viewIndex = 0;
    let pageUserAgent = currentPageUserAgent();

    let webviewPreload = '';
    try {
      // location.pathname já vem codificado; sem decodificar antes, uma pasta
      // com acento (como "Área de trabalho") virava %25C3%2581 e o preload
      // simplesmente não carregava.
      const basePath = decodeURIComponent(String(window.location.pathname || ''));
      const preloadPath = basePath.replace(/src\/index\.html$/i, 'main/preload-webview.js');
      if (preloadPath.indexOf('preload-webview.js') !== -1) {
        webviewPreload = 'file://' + encodeURI(preloadPath);
      }
    } catch (e) {}

    function activeView() {
      return historyViews[viewIndex] || null;
    }

    // Os eventos do <webview> não sobem para o container, então são repassados
    // na mão — e só os da página que está à vista.
    const FORWARDED_EVENTS = [
      'ipc-message', 'new-window', 'console-message', 'did-start-loading',
      'did-stop-loading', 'page-title-updated', 'will-navigate', 'did-navigate',
      'did-navigate-in-page', 'did-fail-load', 'crashed', 'render-process-gone',
      'dom-ready', 'media-started-playing', 'media-paused',
      'enter-html-full-screen', 'leave-html-full-screen'
    ];
    const EVENT_FIELDS = [
      'url', 'title', 'channel', 'args', 'level', 'message', 'sourceId', 'line',
      'lineNumber', 'errorCode', 'errorDescription', 'isMainFrame', 'reason',
      'exitCode', 'explicitSet', 'frameName', 'disposition', 'httpResponseCode',
      'validatedURL', 'isInPlace'
    ];

    function relayEvent(view, event) {
      const clone = new Event(event.type, { cancelable: true });
      Object.keys(event).forEach((key) => {
        try { clone[key] = event[key]; } catch (e) {}
      });
      EVENT_FIELDS.forEach((key) => {
        if (clone[key] !== undefined) return;
        try {
          if (event[key] !== undefined) clone[key] = event[key];
        } catch (e) {}
      });
      webview.dispatchEvent(clone);
    }

    function buildView(url) {
      const view = document.createElement('webview');
      view.className = 'web-client-frame';
      view.partition = 'persist:tor-browser';
      view.useragent = pageUserAgent;
      view.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no, webSecurity=yes, allowRunningInsecureContent=yes, backgroundThrottling=no');
      if (webviewPreload) view.preload = webviewPreload;
      // A primeira navegação é a que nós mesmos pedimos; ela não conta como
      // navegação feita por dentro da página.
      view.__plFreshLoad = true;
      view.__plSettled = false;
      view.__plInPage = 0;
      view.__plInPageFwd = 0;
      // about:blank e redirecionamentos deixam canGoBack() verdadeiro. Se o
      // voltar usar isso, a página é baixada de novo em vez de reexibir o cache.
      view.addEventListener('did-stop-loading', () => {
        if (view.__plSettled) return;
        view.__plSettled = true;
        view.__plFreshLoad = false;
        view.__plSettleAt = Date.now();
        try { view.clearHistory(); } catch (e) {}
        try {
          const url = view.getURL();
          const idx = historyViews.indexOf(view);
          if (idx !== -1 && url && !/^about:blank$/i.test(url)) viewHistory[idx] = url;
        } catch (e) {}
        if (view === activeView() && activeTabId === tabId) updateNavControls(webview);
      });
      view.addEventListener('will-navigate', (event) => {
        if (!view.__plSettled) return;
        // Página guardada no cache não pode navegar: senão o voltar baixa de novo.
        if (view !== activeView()) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          return;
        }
        if (webview.__plAllowNativeNav) {
          webview.__plAllowNativeNav = false;
          return;
        }
        const url = event && event.url;
        if (!url || !/^https?:/i.test(url)) return;
        if (/open\.spotify\.com/i.test(url)) return;
        if (sameViewUrl(viewHistory[viewIndex], url)) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        openInNewView(url);
      });
      FORWARDED_EVENTS.forEach((name) => {
        view.addEventListener(name, (event) => {
          if (view !== activeView()) return;
          relayEvent(view, event);
        });
      });
      view.src = resolveViewUrl(url);
      webview.appendChild(view);
      return view;
    }

    // Página escondida não pode continuar tocando som nem consumindo CPU (exceto o Papaléguas Music, que continua tocando em segundo plano).
    function suspendView(view) {
      if (!view) return;
      try {
        const u = (view.src || (typeof view.getURL === 'function' ? view.getURL() : '')) || '';
        if (u.includes('musica.html') || u.includes('/musica')) {
          return; // Nunca suspenda nem silencie o Papaléguas Music!
        }
      } catch (e) {}
      try { view.setAudioMuted(true); } catch (e) {}
      try {
        view.executeJavaScript(
          'document.querySelectorAll("video,audio").forEach(function(m){try{m.pause()}catch(e){}})'
        ).catch(() => {});
      } catch (e) {}
    }

    function dismissPageChrome(node) {
      const js = '(function(){var b=document.getElementById("torNavLoading");if(b)b.hidden=true;document.querySelectorAll(".is-opening").forEach(function(n){n.classList.remove("is-opening");});})()';
      try {
        const doc = node && node.contentDocument;
        if (doc) {
          const box = doc.getElementById('torNavLoading');
          if (box) box.hidden = true;
          doc.querySelectorAll('.is-opening').forEach((n) => n.classList.remove('is-opening'));
        }
      } catch (e) {}
      try {
        if (node && node.contentWindow) node.contentWindow.postMessage({ type: 'papaleguas-hide-loading' }, '*');
      } catch (e) {}
      try {
        if (node && typeof node.executeJavaScript === 'function') node.executeJavaScript(js).catch(() => {});
      } catch (e) {}
    }

    function showView(view) {
      Array.prototype.forEach.call(webview.children, (child) => {
        const visible = child === view;
        if (!visible && child.classList.contains('is-visible')) suspendView(child);
        child.classList.toggle('is-visible', visible);
      });
      if (view) {
        try { view.setAudioMuted(false); } catch (e) {}
        dismissPageChrome(view);
      }
    }

    // As páginas distantes são descartadas para o app não segurar um processo
    // de renderização por item de histórico (mas o Papaléguas Music é preservado).
    function trimViewCache() {
      historyViews.forEach((view, index) => {
        if (!view) return;
        if (Math.abs(index - viewIndex) <= VIEW_CACHE_DISTANCE) return;
        try {
          const u = (view.src || (typeof view.getURL === 'function' ? view.getURL() : '')) || '';
          if (u.includes('musica.html') || u.includes('/musica')) {
            return; // Preserva o Papaléguas Music
          }
        } catch (e) {}
        view.remove();
        historyViews[index] = null;
      });
    }

    function sameViewUrl(a, b) {
      if (!a || !b) return false;
      return String(a).replace(/\/$/, '') === String(b).replace(/\/$/, '');
    }

    function pushViewHistory(url) {
      if (!url || sameViewUrl(viewHistory[viewIndex], url)) return false;
      // Navegar depois de voltar descarta o "avançar".
      historyViews.slice(viewIndex + 1).forEach((view) => {
        if (view) view.remove();
      });
      viewHistory.splice(viewIndex + 1);
      historyViews.splice(viewIndex + 1);
      viewHistory.push(url);
      viewIndex = viewHistory.length - 1;
      return true;
    }

    function openInNewView(url) {
      if (!url) return;
      url = routeUrlInsideTorApp(url);
      if (tabObj) tabObj.url = url;
      if (
        sameViewUrl(viewHistory[viewIndex], url) &&
        historyViews[viewIndex] &&
        Date.now() - (webview.__plNavAt || 0) < 600
      ) {
        return;
      }
      webview.__plNavAt = Date.now();
      if (typeof showPageLoading === 'function') showPageLoading(url);
      const pushed = pushViewHistory(url);
      const replaced = pushed ? null : historyViews[viewIndex];
      const view = buildView(url);
      historyViews[viewIndex] = view;
      if (replaced && replaced !== view) replaced.remove();
      showView(view);
      trimViewCache();
      if (activeTabId === tabId) {
        setAddressBar(url);
        updateNavControls(webview);
      }
    }

    function gotoViewIndex(nextIndex) {
      if (nextIndex < 0 || nextIndex >= viewHistory.length) return;
      viewIndex = nextIndex;
      const url = viewHistory[nextIndex];
      if (tabObj) tabObj.url = url;
      const cached = historyViews[nextIndex];
      if (cached && cached.isConnected) {
        showView(cached);
        trimViewCache();
        if (typeof hidePageLoading === 'function') hidePageLoading();
        if (activeTabId === tabId) {
          setAddressBar(url);
          updateNavControls(webview);
          footerStatus.textContent = 'Pronto';
        }
        if (typeof renderOpenTabsMenu === 'function') renderOpenTabsMenu();
        return;
      }
      // Essa página já saiu do cache: só resta carregá-la de novo.
      const view = buildView(url);
      historyViews[nextIndex] = view;
      showView(view);
      trimViewCache();
      if (activeTabId === tabId) {
        setAddressBar(url);
        updateNavControls(webview);
      }
    }

    webview.loadURL = (url) => openInNewView(url);
    webview.getURL = () => (tabObj && tabObj.url) || '';
    webview.getTitle = () => {
      const view = activeView();
      try { return view ? view.getTitle() : ''; } catch (e) { return ''; }
    };
    webview.reload = () => {
      const view = activeView();
      if (!view) return;
      if (typeof showPageLoading === 'function') showPageLoading(viewHistory[viewIndex]);
      try { view.reload(); } catch (e) {}
    };
    ['stop', 'send', 'executeJavaScript', 'insertCSS', 'focus', 'setZoomFactor',
     'setAudioMuted', 'openDevTools', 'getWebContentsId', 'downloadURL',
     'findInPage', 'stopFindInPage'].forEach((method) => {
      webview[method] = function () {
        const view = activeView();
        if (!view || typeof view[method] !== 'function') return undefined;
        return view[method].apply(view, arguments);
      };
    });

    // O histórico interno do Chromium continua valendo: links clicados dentro
    // da própria página voltam por ele antes de trocarmos de <webview>.
    function viewHasInPageBack() {
      const view = activeView();
      return !!(view && view.__plInPage > 0);
    }
    function viewHasInPageForward() {
      const view = activeView();
      return !!(view && view.__plInPageFwd > 0);
    }
    webview.canGoBack = () => viewHasInPageBack() || viewIndex > 0;
    webview.canGoForward = () => viewHasInPageForward() || viewIndex < viewHistory.length - 1;
    webview.goBack = () => {
      const view = activeView();
      if (view && view.__plInPage > 0) {
        view.__plInPage -= 1;
        view.__plInPageFwd = (view.__plInPageFwd || 0) + 1;
        view.__plIgnoreInPage = true;
        try { view.goBack(); } catch (e) {}
        if (activeTabId === tabId) updateNavControls(webview);
        return;
      }
      gotoViewIndex(viewIndex - 1);
    };
    webview.goForward = () => {
      const view = activeView();
      if (view && view.__plInPageFwd > 0) {
        view.__plInPageFwd -= 1;
        view.__plInPage = (view.__plInPage || 0) + 1;
        view.__plIgnoreInPage = true;
        try { view.goForward(); } catch (e) {}
        if (activeTabId === tabId) updateNavControls(webview);
        return;
      }
      gotoViewIndex(viewIndex + 1);
    };

    Object.defineProperty(webview, 'useragent', {
      get() { return pageUserAgent; },
      set(value) {
        pageUserAgent = value;
        const current = activeView();
        if (!current) return;
        try {
          if (current.getUserAgent && current.getUserAgent() === value) return;
        } catch (e) {}
        try { current.useragent = value; } catch (e) {}
      }
    });

    // Navegação de documento inteiro vira outro <webview> (will-navigate).
    // Aqui só entra âncora / pushState, que não troca o documento.
    webview.addEventListener('did-navigate', (e) => {
      const view = activeView();
      if (!view || view.__plFreshLoad) return;
      if (e && e.url) viewHistory[viewIndex] = e.url;
    });
    webview.addEventListener('did-navigate-in-page', (e) => {
      const view = activeView();
      if (!view || !view.__plSettled) return;
      if (Date.now() - (view.__plSettleAt || 0) < 400) return;
      if (e && e.url) viewHistory[viewIndex] = e.url;
      if (view.__plIgnoreInPage) {
        view.__plIgnoreInPage = false;
        return;
      }
      view.__plInPage = (view.__plInPage || 0) + 1;
      view.__plInPageFwd = 0;
      if (activeTabId === tabId) updateNavControls(webview);
    });

    historyViews[0] = buildView(initialUrl);
    showView(historyViews[0]);
  } else {
    // O "webview" do modo hospedado é um container: cada página visitada fica
    // num iframe próprio, já carregado. Voltar apenas reexibe o iframe antigo,
    // sem baixar a página de novo (o que via Tor demorava vários segundos).
    webview = document.createElement('div');
    webview.id = 'view-' + tabId;
    webview.className = 'web-client-iframe';
    
    // Resolve URL para o iframe (se for externa, usa /proxy?url= para garantir abertura dentro do app sem bloqueio de frame)
    // Sites complexos como YouTube, Google etc.
    const resolveIframeUrl = (u) => {
      if (!u) return u;
      try {
        const parsed = new URL(u, window.location.origin || publicAppOrigin());
        if (parsed.origin === window.location.origin || isLocalAppHost(parsed.hostname) || /localhost:8080|127\.0\.0\.1:8080/i.test(parsed.host)) {
          const path = parsed.pathname + parsed.search;
          if (isAppShellUrl(parsed.href)) return 'newtab.html';
          if (parsed.pathname === '/proxy' || parsed.pathname.indexOf('/proxy/') === 0) {
            const target = parsed.searchParams.get('url');
            const extraQ = parsed.searchParams.get('q');
            if (target && extraQ) {
              try {
                const inner = new URL(target);
                if (!inner.searchParams.get('q')) inner.searchParams.set('q', extraQ);
                parsed.searchParams.set('url', inner.href);
                parsed.searchParams.delete('q');
              } catch (err) {}
            }
            return parsed.pathname + parsed.search;
          }
          if (/^\/(search|youtube|filmes|musica|baixatube|ip-check)/.test(parsed.pathname) || /newtab\.html|musica\.html/.test(path)) {
            return path.startsWith('/') ? resolveAppNavUrl(path) : path;
          }
          return 'newtab.html';
        }
      } catch (e) {}
      if (
        u.includes('newtab.html') || 
        u.includes('musica.html') ||
        u.startsWith('/musica') ||
        u.startsWith('/youtube') ||
        u.startsWith('/baixatube') ||
        u.startsWith('/search') || 
        u.startsWith('/filmes') || 
        u.startsWith('/proxy') || 
        u.startsWith('data:') || 
        u.startsWith('blob:')
      ) {
        return u.startsWith('/') ? resolveAppNavUrl(u) : u;
      }

      if (isIpCheckNav(u)) return '/ip-check';

      if (u.includes('pluto.tv')) {
        return '/filmes';
      }

      if (u.includes('youtube.com') || u.includes('youtu.be') || u.startsWith('/youtube')) {
        let q = '';
        let vid = '';
        try {
          const urlObj = new URL(u, window.location.origin || 'http://localhost:8080');
          q = urlObj.searchParams.get('q') || urlObj.searchParams.get('search_query') || '';
          vid = urlObj.searchParams.get('v') || '';
          if (u.includes('youtu.be/')) {
            vid = u.split('youtu.be/')[1].split('?')[0].split('#')[0] || vid;
          } else if (u.includes('/embed/')) {
            vid = u.split('/embed/')[1].split('?')[0].split('#')[0] || vid;
          }
        } catch (e) {}
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (vid) params.set('v', vid);
        const qs = params.toString();
        return '/youtube' + (qs ? '?' + qs : '');
      }

      if (u.startsWith('http://') || u.startsWith('https://')) {
        return `/proxy?url=${encodeURIComponent(u)}&clientId=${encodeURIComponent(CLIENT_ID)}`;
      }
      return u;
    };

    const iframeHistory = [initialUrl];
    const historyFrames = [];
    // Distância máxima, em páginas, que continua guardada em volta da atual.
    const FRAME_CACHE_DISTANCE = 3;
    let iframeHistoryIndex = 0;
    let ignoreNextHistoryPush = false;

    function currentHistoryUrl() {
      return iframeHistory[iframeHistoryIndex] || '';
    }

    function buildFrame(url) {
      const frame = document.createElement('iframe');
      frame.className = 'web-client-frame';
      frame.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock; clipboard-write; camera; microphone; web-share');
      frame.setAttribute('allowfullscreen', 'true');
      // Sem allow-top-navigation a página não toma a janela do app.
      // Sem allow-popups, window.open / target=_blank não abrem aba no navegador de fora.
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-presentation allow-pointer-lock allow-orientation-lock allow-storage-access-by-user-activation allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
      frame.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
      frame.setAttribute('loading', 'eager');
      frame.addEventListener('load', () => handleFrameLoad(frame));
      frame.addEventListener('error', () => { if (typeof hidePageLoading === 'function') hidePageLoading(); });
      frame.src = resolveIframeUrl(url);
      webview.appendChild(frame);
      return frame;
    }

    // Página escondida não pode continuar tocando som. O /proxy é servido pelo
    // nosso próprio host, então dá para pausar a mídia por dentro.
    function pauseFrameMedia(frame) {
      try {
        const doc = frame && frame.contentWindow && frame.contentWindow.document;
        if (!doc) return;
        doc.querySelectorAll('video, audio').forEach((media) => {
          try { media.pause(); } catch (e) {}
        });
      } catch (e) {}
      try {
        if (frame && frame.contentWindow) {
          frame.contentWindow.postMessage({ type: 'papaleguas-yt-control', action: 'pause' }, '*');
        }
      } catch (e) {}
    }

    function showFrame(frame) {
      Array.prototype.forEach.call(webview.children, (child) => {
        const visible = child === frame;
        if (!visible && child.classList.contains('is-visible')) pauseFrameMedia(child);
        child.classList.toggle('is-visible', visible);
      });
      if (!frame) return;
      try {
        const doc = frame.contentDocument;
        if (doc) {
          const box = doc.getElementById('torNavLoading');
          if (box) box.hidden = true;
          doc.querySelectorAll('.is-opening').forEach((n) => n.classList.remove('is-opening'));
        }
      } catch (e) {}
      try {
        if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'papaleguas-hide-loading' }, '*');
      } catch (e) {}
    }

    // Guarda só as páginas vizinhas à atual; as distantes são descartadas
    // para o navegador não segurar memória à toa.
    function trimFrameCache() {
      historyFrames.forEach((frame, index) => {
        if (!frame) return;
        if (Math.abs(index - iframeHistoryIndex) <= FRAME_CACHE_DISTANCE) return;
        frame.remove();
        historyFrames[index] = null;
      });
    }

    function activeFrame() {
      return historyFrames[iframeHistoryIndex] || null;
    }

    Object.defineProperty(webview, 'contentWindow', {
      get() {
        const frame = activeFrame();
        return frame ? frame.contentWindow : null;
      }
    });

    function sameHistoryUrl(a, b) {
      if (!a || !b) return false;
      const na = String(a).replace(/\/$/, '');
      const nb = String(b).replace(/\/$/, '');
      return na === nb;
    }

    function pushIframeHistory(url) {
      if (!url || sameHistoryUrl(currentHistoryUrl(), url)) return;
      // Navegar depois de voltar descarta o "avançar": esses iframes saem do DOM.
      historyFrames.slice(iframeHistoryIndex + 1).forEach((frame) => {
        if (frame) frame.remove();
      });
      iframeHistory.splice(iframeHistoryIndex + 1);
      historyFrames.splice(iframeHistoryIndex + 1);
      iframeHistory.push(url);
      iframeHistoryIndex = iframeHistory.length - 1;
    }

    function applyIframeUrl(url, record) {
      if (tabObj) tabObj.url = url;
      if (record) pushIframeHistory(url);
      ignoreNextHistoryPush = true;
      if (typeof showPageLoading === 'function') showPageLoading(url);
      const replaced = historyFrames[iframeHistoryIndex];
      const frame = buildFrame(url);
      historyFrames[iframeHistoryIndex] = frame;
      if (replaced && replaced !== frame) replaced.remove();
      showFrame(frame);
      trimFrameCache();
      if (activeTabId === tabId) {
        setAddressBar(url);
        updateNavControls(webview);
      }
    }

    // Voltar/avançar: se a página já está carregada, é só mostrar de novo.
    function gotoHistoryIndex(nextIndex) {
      if (nextIndex < 0 || nextIndex >= iframeHistory.length) return;
      iframeHistoryIndex = nextIndex;
      const url = iframeHistory[nextIndex];
      if (tabObj) tabObj.url = url;
      const cached = historyFrames[nextIndex];
      if (cached && cached.isConnected) {
        showFrame(cached);
        trimFrameCache();
        if (typeof hidePageLoading === 'function') hidePageLoading();
        if (activeTabId === tabId) {
          setAddressBar(url);
          updateNavControls(webview);
          footerStatus.textContent = 'Pronto';
        }
        if (typeof renderOpenTabsMenu === 'function') renderOpenTabsMenu();
        return;
      }
      applyIframeUrl(url, false);
    }

    // Histórico próprio da aba: history.back() do iframe sai do Papaléguas no Chrome.
    webview.loadURL = (url) => {
      applyIframeUrl(url, true);
    };
    webview.getURL = () => (tabObj && tabObj.url) || urlInput.value || '';
    webview.reload = () => {
      const frame = activeFrame();
      ignoreNextHistoryPush = true;
      if (frame) {
        if (typeof showPageLoading === 'function') showPageLoading(currentHistoryUrl());
        frame.src = resolveIframeUrl(currentHistoryUrl());
        return;
      }
      applyIframeUrl(currentHistoryUrl(), false);
    };
    webview.goBack = () => gotoHistoryIndex(iframeHistoryIndex - 1);
    webview.goForward = () => gotoHistoryIndex(iframeHistoryIndex + 1);
    webview.canGoBack = () => iframeHistoryIndex > 0;
    webview.canGoForward = () => iframeHistoryIndex < iframeHistory.length - 1;

    function handleFrameLoad(frame) {
      // Páginas que já saíram do cache não mexem mais no histórico.
      if (!frame || !frame.isConnected) return;
      const isCurrent = frame === activeFrame();
      try {
        const loc = frame.contentWindow && frame.contentWindow.location;
        if (loc && loc.href && isAppShellUrl(loc.href)) {
          const fallback = (tabObj && tabObj.url && !isAppShellUrl(tabObj.url)) ? tabObj.url : DEFAULT_URL;
          ignoreNextHistoryPush = true;
          frame.src = resolveIframeUrl(fallback);
          return;
        }
        if (isCurrent && loc && loc.href && loc.href !== 'about:blank') {
          const inner = loc.pathname + loc.search;
          const looksInternal = loc.origin === window.location.origin;
          const recorded = looksInternal ? inner : loc.href;
          if (ignoreNextHistoryPush) {
            ignoreNextHistoryPush = false;
            if (recorded) {
              iframeHistory[iframeHistoryIndex] = recorded;
              if (tabObj) tabObj.url = recorded;
            }
          } else if (recorded && !sameHistoryUrl(currentHistoryUrl(), recorded) && !sameHistoryUrl(currentHistoryUrl(), loc.href)) {
            // O mesmo iframe mudou de endereço (redirect ou toque no celular).
            // A página anterior continua no iframe de trás; não abrimos um buraco
            // no histórico, senão o voltar baixa tudo de novo.
            iframeHistory[iframeHistoryIndex] = recorded;
            if (tabObj) tabObj.url = recorded;
          }
        }
      } catch (e) {
        ignoreNextHistoryPush = false;
      }
      if (!isCurrent) return;
      if (activeTabId === tabId) {
        footerStatus.textContent = 'Pronto';
        updateNavControls(webview);
        if (tabObj) setAddressBar(tabObj.url);
        if (typeof hidePageLoading === 'function') hidePageLoading();
      }
      if (typeof renderOpenTabsMenu === 'function') renderOpenTabsMenu();
    }

    historyFrames[0] = buildFrame(initialUrl);
    showFrame(historyFrames[0]);
  }

  const tabObj = {
    id: tabId,
    header: tabElem,
    webview: webview,
    url: initialUrl,
    title: 'Papaléguas'
  };

  tabs.push(tabObj);
  tabsContainer.appendChild(tabElem);
  webviewsContainer.appendChild(webview);

  setupWebviewListeners(tabObj);

  tabElem.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeTab(tabId);
    } else {
      activateTab(tabId);
    }
  });

  activateTab(tabId);
  return tabObj;
}

function activateTab(tabId) {
  activeTabId = tabId;
  const musicTab = getMusicTab();
  const hasActiveMusic = lastGlobalMusicState && (lastGlobalMusicState.isPlaying || lastGlobalMusicState.track);

  tabs.forEach(tab => {
    const isThisMusicTab = tab.url && (tab.url.includes('musica.html') || tab.url.includes('/musica'));

    if (tab.id === tabId) {
      tab.header.classList.add('active');
      tab.webview.classList.add('active');
      tab.webview.classList.remove('is-audio-background');

      const isNewTab = tab.url && tab.url.includes('newtab.html');
      setAddressBar(isNewTab ? '' : (tab.url || ''));
      syncPortalHomeButton(tab.url);
      urlInput.placeholder = isNewTab ? '✨ Pergunte ao GPT Astra ou digite uma URL...' : 'Digite uma URL ou pesquise com segurança...';
      updateNavControls(tab.webview);
      if (tab.detectedVideo) {
        showVideoSnifferNotification(tab.detectedVideo);
      } else {
        hideVideoSnifferNotification();
      }

      // Se o usuário está em abas Home ou qualquer outra aba e houver música ativa,
      // mantém o mini player visível, reposicionado e livremente arrastável entre as abas!
      if (!isThisMusicTab) {
        if (hasActiveMusic && !userDismissedMiniPlayer) {
          if (globalMusicMiniPlayer) {
            globalMusicMiniPlayer.classList.remove('hidden');
            if (typeof restoreMiniPlayerPosition === 'function') {
              restoreMiniPlayerPosition();
            }
          }
        }
      } else {
        // Ao retornar para a aba de música, oculta o mini player flutuante global
        if (globalMusicMiniPlayer) globalMusicMiniPlayer.classList.add('hidden');
      }
    } else {
      tab.header.classList.remove('active');
      tab.webview.classList.remove('active');
      // Mantém a aba de música renderizada em segundo plano com áudio contínuo sem travamentos
      if (isThisMusicTab && hasActiveMusic) {
        tab.webview.classList.add('is-audio-background');
      } else {
        tab.webview.classList.remove('is-audio-background');
      }
    }
  });
  if (typeof renderOpenTabsMenu === 'function') renderOpenTabsMenu();
}

function closeTab(tabId) {
  if (tabs.length === 1) {
    const activeTab = tabs[0];
    activeTab.webview.loadURL(DEFAULT_URL);
    activeTab.url = DEFAULT_URL;
    activeTab.title = 'Papaléguas';
    if (activeTab.header) {
      const titleEl = activeTab.header.querySelector('.tab-title');
      if (titleEl) titleEl.textContent = 'Papaléguas';
    }
    if (typeof renderOpenTabsMenu === 'function') renderOpenTabsMenu();
    return;
  }

  const index = tabs.findIndex(t => t.id === tabId);
  if (index === -1) return;

  const tabToClose = tabs[index];
  const closingMusicTab = Boolean(tabToClose.url && (tabToClose.url.includes('musica.html') || tabToClose.url.includes('/musica')));
  tabToClose.header.remove();
  tabToClose.webview.remove();
  tabs.splice(index, 1);
  if (closingMusicTab && typeof clearGlobalMusicState === 'function') clearGlobalMusicState();

  if (activeTabId === tabId) {
    const nextTab = tabs[Math.max(0, index - 1)];
    if (nextTab) activateTab(nextTab.id);
  }
  if (typeof renderOpenTabsMenu === 'function') renderOpenTabsMenu();
}

function getActiveTab() {
  return tabs.find(t => t.id === activeTabId);
}

function setupWebviewListeners(tab) {
  const wv = tab.webview;

  // Responde diretamente a solicitações do preload do webview
  wv.addEventListener('ipc-message', async (event) => {
    if (event.channel === 'query-ai-from-page') {
      const prompt = event.args[0];
      try {
        const reply = await window.torBrowserAPI.queryAstraAI(prompt);
        wv.send('reply-ai-to-page', { success: true, reply });
      } catch (err) {
        wv.send('reply-ai-to-page', { success: false, error: err.message });
      }
    } else if (event.channel === 'execute-code-from-page') {
      const { language, code } = event.args[0] || {};
      try {
        const result = await window.torBrowserAPI.executeCode(language, code);
        wv.send('reply-execute-code-to-page', { success: true, result });
      } catch (err) {
        wv.send('reply-execute-code-to-page', { success: false, error: err.message });
      }
    } else if (event.channel === 'open-new-tab') {
      // Nova aba pedida pela página: abre dentro do app, pela mesma conexão (Tor ou direta).
      const urlToOpen = routeUrlInsideTorApp(event.args[0]);
      if (urlToOpen && !isAppShellUrl(urlToOpen)) {
        createTab(urlToOpen);
      }
    } else if (event.channel === 'get-adblock-status') {
      try {
        const status = await window.torBrowserAPI.getAdblockStatus();
        wv.send('adblock-status-changed', status);
      } catch (e) {}
    } else if (event.channel === 'allow-native-navigation') {
      wv.__plAllowNativeNav = true;
      setTimeout(() => { wv.__plAllowNativeNav = false; }, 1500);
    } else if (event.channel === 'navigate-current-tab') {
      const urlToOpen = routeUrlInsideTorApp(event.args[0]);
      if (urlToOpen && !isAppShellUrl(urlToOpen)) {
        if (typeof showPageLoading === 'function') showPageLoading(urlToOpen);
        wv.loadURL(urlToOpen);
      }
    } else if (event.channel === 'media-video-detected') {
      const videoData = event.args[0];
      if (videoData) {
        tab.detectedVideo = videoData;
        if (activeTabId === tab.id) {
          showVideoSnifferNotification(videoData);
        }
      }
    } else if (event.channel === 'music-state-update') {
      if (typeof updateGlobalMusicPlayerUI === 'function') {
        updateGlobalMusicPlayerUI(event.args[0]);
      }
    } else if (event.channel === 'youtube-state-update') {
      if (typeof updateGlobalYoutubeState === 'function') {
        updateGlobalYoutubeState(event.args[0]);
      }
    } else if (event.channel === 'user-activity') {
      if (typeof fsHomeUserActivity === 'function') fsHomeUserActivity();
    } else if (event.channel === 'video-watch') {
      const payload = event.args[0] || {};
      if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(!!payload.active);
    } else if (event.channel === 'enter-video-fullscreen') {
      appVideoFullscreen = true;
      if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(true);
      document.documentElement.classList.add('video-true-fs');
      document.body.classList.add('video-true-fs');
    } else if (event.channel === 'exit-video-fullscreen') {
      appVideoFullscreen = false;
      if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(false);
      document.documentElement.classList.remove('video-true-fs');
      document.body.classList.remove('video-true-fs');
      try {
        const exitFs = document.exitFullscreen || document.webkitExitFullscreen;
        if (exitFs && (document.fullscreenElement || document.webkitFullscreenElement)) {
          exitFs.call(document);
        }
      } catch (e) {}
    } else if (event.channel === 'toggle-music-mini-player') {
      if (globalMusicMiniPlayer) {
        const isHidden = globalMusicMiniPlayer.classList.contains('hidden');
        if (isHidden) {
          userDismissedMiniPlayer = false;
          globalMusicMiniPlayer.classList.remove('hidden');
        } else {
          userDismissedMiniPlayer = true;
          globalMusicMiniPlayer.classList.add('hidden');
        }
      }
    }
  });

  // Intercepta qualquer abertura de janela / link com target=_blank do webview
  wv.addEventListener('new-window', (e) => {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (e.url) createTab(e.url);
  });

  wv.addEventListener('console-message', (e) => {
    if (e.level >= 2) {
      if (e.message && (e.message.includes('WebGPU') || e.message.includes('Electron Security Warning') || e.message.includes('Unrecognized feature'))) return;
      console.warn(`[WEBVIEW ${tab.id} CONSOLE LEVEL ${e.level}] ${e.message} (${e.sourceId}:${e.line})`);
    }
  });

  wv.addEventListener('did-start-loading', () => {
    tab.detectedVideo = null;
    if (activeTabId === tab.id) {
      if (typeof hideVideoSnifferNotification === 'function') hideVideoSnifferNotification();
      if (typeof closePagePlayer === 'function') closePagePlayer(false);
      footerStatus.textContent = 'Carregando ' + (tab.url.includes('newtab.html') ? 'Papaléguas' : tab.url) + '...';
      if (typeof showPageLoading === 'function') showPageLoading(tab.url);
    }
  });

  wv.addEventListener('did-stop-loading', () => {
    if (activeTabId === tab.id) {
      footerStatus.textContent = 'Pronto';
      updateNavControls(wv);
      if (typeof hidePageLoading === 'function') hidePageLoading();
    }
  });

  wv.addEventListener('dom-ready', () => {
    if (activeTabId === tab.id) {
      updateNavControls(wv);
      if (typeof hidePageLoading === 'function') hidePageLoading();
    }
  });

  wv.addEventListener('did-finish-load', () => {
    if (activeTabId === tab.id) {
      if (typeof hidePageLoading === 'function') hidePageLoading();
    }
  });

  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || 'Sem título';
    tab.header.querySelector('.tab-title').textContent = tab.title;
    if (typeof renderOpenTabsMenu === 'function') renderOpenTabsMenu();
  });

  // Intercepta tentativas de navegação antes de iniciar no webview
  wv.addEventListener('will-navigate', (e) => {
    if (e.url && e.url.includes('open.spotify.com')) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      let query = '';
      const searchMatch = e.url.match(/open\.spotify\.com\/search\/([^/?#]+)/i);
      if (searchMatch && searchMatch[1]) {
        query = decodeURIComponent(searchMatch[1]);
      }
      try {
        if (wv.stop) wv.stop();
        wv.loadURL(DEFAULT_URL);
      } catch (err) {}
      openPapaleguasMusic(query, true);
    }
  });

  wv.addEventListener('did-navigate', (e) => {
    tab.url = e.url;
    // Se o webview navegou para o Spotify (ex: redirecionamento ou link interno), bloqueia e abre o mini player tela cheia
    if (e.url && e.url.includes('open.spotify.com')) {
      let query = '';
      const searchMatch = e.url.match(/open\.spotify\.com\/search\/([^/?#]+)/i);
      if (searchMatch && searchMatch[1]) {
        query = decodeURIComponent(searchMatch[1]);
      }
      try {
        if (wv.stop) wv.stop();
        wv.loadURL(DEFAULT_URL);
      } catch (err) {}
      openPapaleguasMusic(query, true);
      return;
    }
    // Bloqueio de segurança para abas de configurações do Spotify
    if (e.url && e.url.includes('spotify.com') && (e.url.includes('/account') || e.url.includes('/preferences') || e.url.includes('/settings'))) {
      wv.loadURL(DEFAULT_URL);
      return;
    }
    if (activeTabId === tab.id) {
      const isNewTab = e.url && e.url.includes('newtab.html');
      setAddressBar(isNewTab ? '' : e.url);
      updateNavControls(wv);

      if (e.url && (e.url.includes('youtube.com/watch') || e.url.includes('youtu.be/'))) {
        if (typeof syncPlaybackWithConnectedTv === 'function') {
          syncPlaybackWithConnectedTv(e.url);
        }
      }
    }
    // Registra no histórico de sessão para sugestões locais
    if (e.url && !e.url.includes('newtab.html') && /^https?:\/\//i.test(e.url)) {
      if (!Array.isArray(window._sessionVisitedUrls)) window._sessionVisitedUrls = [];
      const entry = { url: e.url, title: tab.title || e.url };
      window._sessionVisitedUrls = [entry]
        .concat(window._sessionVisitedUrls.filter((v) => v.url !== e.url))
        .slice(0, 100);
    }
  });

  wv.addEventListener('did-navigate-in-page', (e) => {
    tab.url = e.url;
    if (e.url && e.url.includes('open.spotify.com')) {
      let query = '';
      const searchMatch = e.url.match(/open\.spotify\.com\/search\/([^/?#]+)/i);
      if (searchMatch && searchMatch[1]) {
        query = decodeURIComponent(searchMatch[1]);
      }
      try {
        if (wv.stop) wv.stop();
        wv.loadURL(DEFAULT_URL);
      } catch (err) {}
      openPapaleguasMusic(query, true);
      return;
    }
    // Bloqueio de segurança para abas do Spotify
    if (e.url && e.url.includes('spotify.com') && (e.url.includes('/account') || e.url.includes('/preferences') || e.url.includes('/settings'))) {
      wv.loadURL(DEFAULT_URL);
      return;
    }
    if (activeTabId === tab.id) {
      const isNewTab = e.url && e.url.includes('newtab.html');
      setAddressBar(isNewTab ? '' : e.url);
      updateNavControls(wv);
    }
  });

  wv.addEventListener('did-fail-load', (e) => {
    if (e && e.isMainFrame === false) return;
    if (typeof hidePageLoading === 'function') hidePageLoading();
    if (e.errorCode !== -3) {
      footerStatus.textContent = `Erro ao carregar: ${e.errorDescription} (${e.errorCode})`;
    }
  });

  wv.addEventListener('crashed', () => {
    console.warn('Webview crash detectado, recarregando...');
    if (activeTabId === tab.id) {
      footerStatus.textContent = 'Processo de renderização reiniciado. Recarregando página...';
      try { wv.reload(); } catch(e) {}
    }
  });

  wv.addEventListener('render-process-gone', (e) => {
    console.warn('Render process gone:', e.reason);
    if (activeTabId === tab.id) {
      footerStatus.textContent = `Processo finalizado (${e.reason}). Recarregando...`;
      try { wv.reload(); } catch(e) {}
    }
  });
}

function updateNavControls(wv) {
  if (!wv) return;
  try {
    btnBack.disabled = !wv.canGoBack();
    btnForward.disabled = !wv.canGoForward();
  } catch (e) {}
}

function isIpCheckNav(raw) {
  return /ipleak\.net|browserleaks\.com|dnsleaktest\.com|whoer\.net|ifconfig\.me|icanhazip\.com|ipify\.org|check\.torproject\.org/i.test(String(raw || ''));
}

let lastTorStatus = { enabled: false, connected: false };
let torRouteKnown = false;

function useDirectPageLoad() {
  return isElectronApp() && torRouteKnown && !isTorRoutingNow();
}
let pageLoadingTimer = null;

function isTorRoutingNow() {
  if (lastTorStatus && lastTorStatus.enabled) return true;
  return !!(btnToggleTor && btnToggleTor.classList.contains('active'));
}

function shouldShowNavLoading(url) {
  const s = String(url || '');
  if (!s) return false;
  if (/newtab\.html/i.test(s) && !/[?&](?:q|v)=/i.test(s)) return false;
  if (/musica\.html/i.test(s) || /\/(youtube|baixatube|filmes|musica)(?:\?|$)/i.test(s)) return false;
  return /\/search(?:\?|$)/i.test(s) || /\/proxy\?/i.test(s) || /^https?:/i.test(s) || /duckduckgo\.com/i.test(s);
}

function showPageLoading(url, kind) {
  if (!shouldShowNavLoading(url) && kind !== 'search' && kind !== 'link') {
    hidePageLoading();
    return;
  }
  const overlay = document.getElementById('page-tor-loading');
  const chip = document.getElementById('url-loading-chip');
  const chipText = document.getElementById('url-loading-chip-text');
  const bar = document.getElementById('address-bar-container');
  const title = document.getElementById('page-tor-loading-title');
  const urlEl = document.getElementById('page-tor-loading-url');
  const hint = document.getElementById('page-tor-loading-hint');
  const torOrb = document.getElementById('page-tor-orb');
  const directOrb = document.getElementById('page-direct-orb');
  const tor = isTorRoutingNow();
  const isSearch = kind === 'search' || /\/search(?:\?|$)/i.test(String(url || '')) || /duckduckgo\.com\/\?q=/i.test(String(url || ''));
  if (title) {
    title.textContent = tor
      ? (isSearch ? 'Pesquisando via Tor' : 'Abrindo via Tor')
      : (isSearch ? 'Pesquisando em conexão direta' : 'Abrindo em conexão direta');
  }
  if (urlEl) {
    try {
      urlEl.textContent = prettyAddressBarUrl(url) || url || '';
    } catch (e) {
      urlEl.textContent = url || '';
    }
  }
  if (hint) {
    hint.textContent = tor
      ? 'A conexão está saindo pela rede Tor. Pode demorar alguns segundos.'
      : 'Tor desligado. A página está abrindo pela internet normal.';
  }
  if (torOrb) torOrb.hidden = !tor;
  if (directOrb) directOrb.hidden = tor;
  if (overlay) {
    overlay.classList.toggle('is-tor', tor);
    overlay.classList.toggle('is-direct', !tor);
    overlay.hidden = false;
  }
  if (chip) {
    chip.classList.toggle('is-direct', !tor);
    chip.hidden = false;
  }
  if (chipText) chipText.textContent = tor ? 'Tor' : 'Direto';
  if (bar) {
    bar.classList.add('is-loading');
    bar.classList.toggle('is-direct', !tor);
  }
  if (pageLoadingTimer) clearTimeout(pageLoadingTimer);
  // O loading permanece ativo continuamente até a página ser aberta por completo.
  // Mantemos apenas um timeout de segurança estendido (120s) para não travar a interface em quedas extremas de conexão.
  pageLoadingTimer = setTimeout(hidePageLoading, 120000);
}

function hidePageLoading() {
  const overlay = document.getElementById('page-tor-loading');
  const chip = document.getElementById('url-loading-chip');
  const bar = document.getElementById('address-bar-container');
  if (overlay) overlay.hidden = true;
  if (chip) chip.hidden = true;
  if (bar) bar.classList.remove('is-loading', 'is-direct');
  if (pageLoadingTimer) {
    clearTimeout(pageLoadingTimer);
    pageLoadingTimer = null;
  }
}

function navigateToUrl(rawInput) {
  let target = rawInput.trim();
  if (!target) return;
  if (typeof hideUrlSuggestions === 'function') hideUrlSuggestions();

  // Intercepta qualquer tentativa de navegar para o Spotify para abrir direto o mini player em tela cheia
  if (target.includes('open.spotify.com')) {
    let query = '';
    const searchMatch = target.match(/open\.spotify\.com\/search\/([^/?#]+)/i);
    if (searchMatch && searchMatch[1]) {
      query = decodeURIComponent(searchMatch[1]);
    }
    openPapaleguasMusic(query, true);
    const activeTab = getActiveTab();
    if (activeTab && activeTab.webview && activeTab.url && activeTab.url.includes('open.spotify.com')) {
      activeTab.webview.loadURL(DEFAULT_URL);
    }
    const isNewTab = activeTab && activeTab.url && activeTab.url.includes('newtab.html');
    setAddressBar(isNewTab ? '' : (activeTab ? activeTab.url : ''));
    return;
  }

  if (isIpCheckNav(target)) {
    const activeTab = getActiveTab();
    setAddressBar('https://www.meuip.com.br/');
    showPageLoading('https://www.meuip.com.br/', 'link');
    if (activeTab && activeTab.webview) {
      activeTab.url = 'https://www.meuip.com.br/';
      activeTab.webview.loadURL(resolveAppNavUrl('/ip-check'));
    } else {
      createTab('/ip-check');
    }
    return;
  }

  if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('/')) {
    // Serviços .onion respondem em HTTP. HTTPS neles costuma não abrir.
    if (/\.onion(\b|\/|:|\?|#|$)/i.test(target)) target = target.replace(/^https:/i, 'http:');
  } else if (/\.onion(\b|\/|:|\?|#|$)/i.test(target) && !/\s/.test(target)) {
    target = 'http://' + target.replace(/^\/+/, '');
  } else if (target.includes('.') && !target.includes(' ')) {
    target = 'https://' + target;
  } else {
    // Se for no desktop Electron, pode usar o URL direto do DuckDuckGo.
    // Se for no celular / navegador web (iframe), usa a página de busca otimizada /search?q=
    target = resolveAppNavUrl('/search?q=' + encodeURIComponent(target));
  }

  if (/^https?:\/\//i.test(target)) {
    target = routeUrlInsideTorApp(target);
  }

  const isNewTab = target.includes('newtab.html');
  setAddressBar(isNewTab ? '' : target);

  const activeTab = getActiveTab();
  const isMusicTab = activeTab && activeTab.url && (activeTab.url.includes('musica.html') || activeTab.url.includes('/musica'));
  const isMusicActive = lastGlobalMusicState && (lastGlobalMusicState.isPlaying || lastGlobalMusicState.track);

  // Se o usuário está na aba de música e ela está tocando, abre o novo site em outra aba para continuar tocando em segundo plano
  if (isMusicTab && isMusicActive) {
    createTab(target);
    userDismissedMiniPlayer = false;
    if (globalMusicMiniPlayer) globalMusicMiniPlayer.classList.remove('hidden');
    return;
  }

  showPageLoading(target, /\/search(?:\?|$)/i.test(target) || /duckduckgo\.com\/\?q=/i.test(target) ? 'search' : 'link');
  if (activeTab && activeTab.webview) {
    activeTab.url = target;
    activeTab.webview.loadURL(resolveAppNavUrl(target));
  } else {
    createTab(target);
  }
}

document.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
  if (!link || link.hasAttribute('download')) return;
  if ((link.getAttribute('target') || '').toLowerCase() !== '_blank') return;
  const href = link.href;
  if (!href || href === 'about:blank') return;
  if (!isElectronApp() && !isInternalAppUrl(href)) {
    // Permite que links com target="_blank" abram fora do iframe no celular/web
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  createTab(routeUrlInsideTorApp(href));
}, true);

if (window.torBrowserAPI && typeof window.torBrowserAPI.onOpenUrlInApp === 'function') {
  window.torBrowserAPI.onOpenUrlInApp((url) => {
    // window.open / target=_blank barrados pelo Electron voltam para uma aba do app.
    const inside = routeUrlInsideTorApp(url);
    if (inside && !isAppShellUrl(inside)) createTab(inside);
  });
}

// Sincroniza navegação de páginas carregadas no iframe (celular / web) para manter tudo dentro do app
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  const activeTab = getActiveTab();

  if (data.type === 'media-video-detected' && data.video) {
    showVideoSnifferNotification(data.video);
    return;
  }

  if (data.type === 'open-external-window' || data.type === 'open-outside-iframe') {
    if (data.url) {
      const inside = routeUrlInsideTorApp(data.url);
      if (activeTab && activeTab.webview) {
        activeTab.webview.loadURL(inside);
      } else {
        createTab(inside);
      }
    }
    return;
  }

  if (data.type === 'open-spotify-player') {
    openPapaleguasMusic(data.query || '', true);
    return;
  }

  if (data.type === 'go-home') {
    fsHomeVideoWatch(false);
    goHomeFromFullscreen();
    return;
  }

  if (data.type === 'user-activity') {
    fsHomeUserActivity();
    return;
  }

  if (data.type === 'video-watch') {
    fsHomeVideoWatch(!!data.active);
    return;
  }

  if (data.type === 'exit-video-fullscreen') {
    appVideoFullscreen = false;
    fsHomeVideoWatch(false);
    document.documentElement.classList.remove('video-true-fs');
    document.body.classList.remove('video-true-fs');
    try {
      const exitFs = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exitFs && (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement)) {
        exitFs.call(document);
      }
    } catch (e) {}
    return;
  }

  if (data.type === 'enter-video-fullscreen') {
    appVideoFullscreen = true;
    fsHomeVideoWatch(true);
    document.documentElement.classList.add('video-true-fs');
    document.body.classList.add('video-true-fs');
    return;
  }

  if (data.type === 'youtube-enter-pip') {
    if (data.videoId) {
      lastYoutubeState = Object.assign({}, lastYoutubeState || {}, {
        videoId: data.videoId,
        title: data.title || (lastYoutubeState && lastYoutubeState.title) || 'BaixaTube',
        isPlaying: true
      });
    }
    if (lastYoutubeState && lastYoutubeState.videoId) {
      prepareMobilePipVideo(lastYoutubeState).then(() => enterMobilePictureInPicture());
    }
    return;
  }

  if (data.type === 'open-cast-hub') {
    if (castModal) {
      castModal.classList.remove('hidden');
      loadCastDevices();
    }
    return;
  }

  if (data.type === 'page-loading') {
    const tab = getActiveTab();
    const pageWindow = tab && tab.webview && tab.webview.contentWindow;
    if (pageWindow && event.source && event.source !== pageWindow) return;
    showPageLoading(data.url || '', data.kind || 'link');
    return;
  }

  if (data.type === 'navigate-current-tab' || data.type === 'navigate-to') {
    const url = data.url;
    if (url) {
      if (isAppShellUrl(url)) return;
      if (url.includes('open.spotify.com')) {
        let query = '';
        const searchMatch = url.match(/open\.spotify\.com\/search\/([^/?#]+)/i);
        if (searchMatch && searchMatch[1]) {
          query = decodeURIComponent(searchMatch[1]);
        }
        openPapaleguasMusic(query, true);
        return;
      }
      const inside = routeUrlInsideTorApp(url);
      showPageLoading(inside, /\/search(?:\?|$)/i.test(inside) ? 'search' : 'link');
      if (activeTab && activeTab.webview) {
        activeTab.webview.loadURL(inside);
      } else {
        createTab(inside);
      }
    }
    return;
  }

  if (data.type === 'open-new-tab') {
    const url = data.url;
    if (url) {
      if (url.includes('open.spotify.com')) {
        let query = '';
        const searchMatch = url.match(/open\.spotify\.com\/search\/([^/?#]+)/i);
        if (searchMatch && searchMatch[1]) {
          query = decodeURIComponent(searchMatch[1]);
        }
        openPapaleguasMusic(query, true);
        return;
      }
      if (isAppShellUrl(url)) return;
      const isElectron = isElectronApp();
      const inside = routeUrlInsideTorApp(url);
      if (!isElectron && activeTab && activeTab.webview) {
        activeTab.webview.loadURL(inside);
      } else {
        createTab(inside);
      }
    }
    return;
  }

  if (data.type === 'navigate-to') {
    const url = data.url;
    if (url) {
      if (url.includes('open.spotify.com')) {
        let query = '';
        const searchMatch = url.match(/open\.spotify\.com\/search\/([^/?#]+)/i);
        if (searchMatch && searchMatch[1]) {
          query = decodeURIComponent(searchMatch[1]);
        }
        openPapaleguasMusic(query, true);
        return;
      }
      if (activeTab) {
        activeTab.url = url;
        const isNewTab = url.includes('newtab.html');
        setAddressBar(isNewTab ? '' : url);
      }
    }
  } else if (data.type === 'navigate-sync') {
    if (activeTab && data.url) {
      // Se a URL veio de um proxy (/proxy?url=...), restaura a URL original para exibir limpamente na barra
      let displayUrl = data.targetUrl || data.url;
      try {
        if (displayUrl.includes('/proxy?url=')) {
          const uObj = new URL(displayUrl, window.location.origin);
          displayUrl = uObj.searchParams.get('url') || displayUrl;
        }
      } catch(e){}

      activeTab.url = displayUrl;
      const isNewTab = displayUrl.includes('newtab.html');
      setAddressBar(isNewTab ? '' : displayUrl);
      if (data.title && activeTab.header) {
        activeTab.title = data.title;
        const titleEl = activeTab.header.querySelector('.tab-title');
        if (titleEl) titleEl.textContent = data.title;
      }
      if (typeof renderOpenTabsMenu === 'function') renderOpenTabsMenu();
      if (typeof hidePageLoading === 'function') hidePageLoading();

      // Se navegou para um vídeo do YouTube e a TV estiver conectada, sincroniza com a TV automaticamente!
      if (displayUrl && (displayUrl.includes('youtube.com') || displayUrl.includes('youtu.be'))) {
        if (typeof syncPlaybackWithConnectedTv === 'function') {
          syncPlaybackWithConnectedTv(displayUrl);
        }
      }
    }
  }
});

// Event Listeners
newTabBtn.addEventListener('click', () => createTab(DEFAULT_URL));

const urlSuggestPanel = document.getElementById('url-suggest-panel');
const urlSuggestList = document.getElementById('url-suggest-list');
const urlSuggestStatus = document.getElementById('url-suggest-status');
const urlSuggestState = {
  q: '',
  page: 0,
  hasMore: false,
  loading: false,
  items: [],
  active: -1,
  timer: null
};

// As pesquisas recentes vivem só na memória desta sessão: fechou, sumiu.
let sessionRecentSearches = [];

function rememberRecentSearch(query) {
  const q = String(query || '').trim();
  if (!q) return;
  sessionRecentSearches = [q]
    .concat(sessionRecentSearches.filter((item) => String(item).toLowerCase() !== q.toLowerCase()))
    .slice(0, 16);
}

function localUrlSuggestions(query) {
  const rawQ = String(query || '').trim();
  const q = rawQ.toLowerCase();
  const out = [];
  if (!q) return out;
  if (!looksLikeUrl(rawQ) && !isOnionUrl(rawQ)) {
    out.push({
      kind: 'gpt',
      title: rawQ,
      subtitle: '✦ Papaléguas AI • Obter resposta imediata com inteligência artificial',
      url: '/search?q=' + encodeURIComponent(rawQ)
    });
  }
  // Pesquisas recentes da sessão
  sessionRecentSearches.forEach((item) => {
    if (String(item).toLowerCase().includes(q) && String(item).toLowerCase() !== q) {
      out.push({ kind: 'search', title: item, subtitle: 'Pesquisa desta sessão', url: '/search?q=' + encodeURIComponent(item) });
    }
  });
  // Favoritos
  try {
    const bookmarks = (typeof getUserBookmarks === 'function') ? getUserBookmarks() : JSON.parse(localStorage.getItem('user_bookmarks') || '[]');
    bookmarks.forEach((bm) => {
      const hay = ((bm.title || '') + ' ' + (bm.url || '')).toLowerCase();
      if (hay.includes(q) && bm.url) {
        out.push({ kind: 'url', title: bm.title || bm.url, subtitle: bm.url, url: bm.url });
      }
    });
  } catch (e) {}
  // Histórico de abas visitadas nesta sessão
  try {
    if (Array.isArray(window._sessionVisitedUrls)) {
      window._sessionVisitedUrls.forEach((entry) => {
        const hay = ((entry.title || '') + ' ' + (entry.url || '')).toLowerCase();
        if (hay.includes(q) && entry.url && !out.some((o) => o.url === entry.url)) {
          out.push({ kind: 'url', title: entry.title || entry.url, subtitle: entry.url, url: entry.url });
        }
      });
    }
  } catch (e) {}
  return out.slice(0, 8);
}

// ===== Aba de pesquisa em tela cheia =====
const searchFs = document.getElementById('search-fs');
const searchFsInput = document.getElementById('search-fs-input');
const searchFsList = document.getElementById('search-fs-list');
const searchFsStatus = document.getElementById('search-fs-status');
const searchFsRecentBox = document.getElementById('search-fs-recent-box');
const searchFsRecent = document.getElementById('search-fs-recent');
const searchFsClear = document.getElementById('search-fs-clear');
const searchFsNet = document.getElementById('search-fs-net');
const searchFsBody = document.getElementById('search-fs-body');
let searchFsOpen = false;

// Enquanto a tela cheia está aberta, é o campo dela que comanda as sugestões
function activeSuggestInput() {
  return searchFsOpen && searchFsInput ? searchFsInput : urlInput;
}

function hideUrlSuggestions() {
  if (urlSuggestPanel) urlSuggestPanel.hidden = true;
  urlSuggestState.active = -1;
}

function applySuggestion(item) {
  if (!item) return;
  rememberRecentSearch(item.kind === 'search' ? (item.title || urlSuggestState.q) : urlSuggestState.q);
  hideUrlSuggestions();
  closeSearchFullscreen(true);
  navigateToUrl(item.url || item.title);
}

function buildSuggestionRow(item, index) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'search-fs-item' + (index === urlSuggestState.active ? ' is-active' : '') + (item.kind === 'gpt' ? ' is-gpt' : '') + (item.kind === 'onion' ? ' is-onion' : '');
  const host = item.subtitle || item.url || '';
  const letter = String(host).replace(/^https?:\/\//, '').charAt(0).toUpperCase() || '?';
  const ico = document.createElement('span');
  ico.className = 'search-fs-item-ico' + (item.kind === 'search' ? ' is-search' : '') + (item.kind === 'gpt' ? ' is-gpt' : '') + (item.kind === 'onion' ? ' is-onion' : '');
  ico.textContent = item.kind === 'search' ? '⌕' : (item.kind === 'gpt' ? '✦' : (item.kind === 'onion' ? '🧅' : letter));
  const text = document.createElement('span');
  text.className = 'search-fs-item-text';
  const title = document.createElement('span');
  title.className = 'search-fs-item-title';
  title.textContent = item.title || item.url || '';
  text.appendChild(title);
  const hostEl = document.createElement('span');
  hostEl.className = 'search-fs-item-host';
  hostEl.textContent = host;
  text.appendChild(hostEl);
  if (item.snippet) {
    const snip = document.createElement('span');
    snip.className = 'search-fs-item-snip';
    snip.textContent = item.snippet;
    text.appendChild(snip);
  }
  btn.appendChild(ico);
  btn.appendChild(text);
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => applySuggestion(item));
  return btn;
}

function renderRecentSearchChips() {
  if (!searchFsRecent || !searchFsRecentBox) return;
  const query = String(searchFsInput && searchFsInput.value || '').trim();
  const show = !query && sessionRecentSearches.length > 0;
  searchFsRecentBox.hidden = !show;
  if (!show) return;
  searchFsRecent.innerHTML = '';
  sessionRecentSearches.slice(0, 12).forEach((term) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'search-fs-chip';
    chip.textContent = term;
    chip.addEventListener('click', () => {
      searchFsInput.value = term;
      syncSearchFsClearButton();
      fetchUrlSuggestions(true);
    });
    searchFsRecent.appendChild(chip);
  });
}

function renderFullscreenSuggestions() {
  if (!searchFsList) return;
  searchFsList.innerHTML = '';
  urlSuggestState.items.forEach((item, index) => {
    searchFsList.appendChild(buildSuggestionRow(item, index));
  });
  appendRefreshSuggestionsButton(searchFsList);
  renderRecentSearchChips();
  if (searchFsStatus) {
    const query = String(searchFsInput && searchFsInput.value || '').trim();
    if (!query) {
      searchFsStatus.hidden = true;
    } else if (urlSuggestState.loading) {
      searchFsStatus.hidden = false;
      const torOn = !!(typeof lastTorStatus !== 'undefined' && lastTorStatus && lastTorStatus.enabled);
      searchFsStatus.textContent = torOn ? 'Procurando na web via Tor…' : 'Procurando nas fontes públicas…';
    } else if (!urlSuggestState.items.length) {
      searchFsStatus.hidden = false;
      searchFsStatus.textContent = 'Nada encontrado ainda. Pressione Enter para abrir a pesquisa completa.';
    } else {
      searchFsStatus.hidden = false;
      searchFsStatus.textContent = urlSuggestState.hasMore
        ? 'Role para carregar mais resultados'
        : 'Fim dos resultados · Enter abre a pesquisa completa';
    }
  }
}

// Estando numa página de busca, a aba reabre com o termo pesquisado em vez da URL interna
function seedValueForSearchTab(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/\/search\b/i.test(value)) {
    const found = value.match(/[?&]q=([^&]*)/);
    if (found) {
      try {
        return decodeURIComponent(found[1].replace(/\+/g, ' '));
      } catch (e) {
        return '';
      }
    }
  }
  if (/^\//.test(value) || /newtab\.html/i.test(value)) return '';
  return value;
}

function syncSearchFsClearButton() {
  if (searchFsClear) searchFsClear.hidden = !String(searchFsInput && searchFsInput.value || '').trim();
}

function openSearchFullscreen(initialValue) {
  if (!searchFs || !searchFsInput || searchFsOpen) return;
  searchFsOpen = true;
  hideUrlSuggestions();
  searchFs.hidden = false;
  const seed = typeof initialValue === 'string' ? initialValue : String(urlInput && urlInput.value || '');
  searchFsInput.value = seedValueForSearchTab(seed);
  urlSuggestState.items = [];
  urlSuggestState.q = '';
  urlSuggestState.active = -1;
  syncSearchFsClearButton();
  if (searchFsNet) {
    const torOn = !!(typeof lastTorStatus !== 'undefined' && lastTorStatus && lastTorStatus.enabled);
    searchFsNet.classList.toggle('is-tor', torOn);
    searchFsNet.textContent = torOn ? 'Pesquisando via Tor' : 'Conexão direta';
  }
  renderFullscreenSuggestions();
  setTimeout(() => {
    try {
      searchFsInput.focus();
      searchFsInput.select();
    } catch (e) {}
  }, 20);
  if (String(searchFsInput.value || '').trim().length >= 2) scheduleUrlSuggestions();
}

function closeSearchFullscreen(keepUrlBar) {
  if (!searchFs || !searchFsOpen) return;
  searchFsOpen = false;
  searchFs.hidden = true;
  if (typeof stopSearchDictation === 'function') stopSearchDictation(true);
  if (urlSuggestState.timer) clearTimeout(urlSuggestState.timer);
  urlSuggestState.items = [];
  urlSuggestState.q = '';
  urlSuggestState.active = -1;
  hideUrlSuggestions();
  if (searchFsList) searchFsList.innerHTML = '';
  if (!keepUrlBar) {
    try { urlInput.blur(); } catch (e) {}
  }
}

function appendRefreshSuggestionsButton(parent) {
  const query = String((activeSuggestInput() && activeSuggestInput().value) || '').trim();
  if (!parent || query.length < 2 || !urlSuggestState.items.length) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'suggest-refresh-btn';
  btn.disabled = urlSuggestState.loading || !urlSuggestState.hasMore;
  btn.textContent = urlSuggestState.loading
    ? 'Buscando novas sugestões…'
    : (urlSuggestState.hasMore ? 'Atualizar sugestões' : 'Sugestões atualizadas');
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => fetchUrlSuggestions(false));
  parent.appendChild(btn);
}

function renderUrlSuggestions() {
  if (searchFsOpen) {
    renderFullscreenSuggestions();
    return;
  }
  if (!urlSuggestList || !urlSuggestPanel) return;
  // Resposta atrasada não pode reabrir o painel depois que a pesquisa foi fechada
  if (document.activeElement !== urlInput) {
    hideUrlSuggestions();
    return;
  }
  urlSuggestList.innerHTML = '';
  urlSuggestState.items.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'url-suggest-item' + (index === urlSuggestState.active ? ' is-active' : '') + (item.kind === 'gpt' ? ' is-gpt' : '') + (item.kind === 'onion' ? ' is-onion' : '');
    const letter = String(item.subtitle || item.title || '?').replace(/^https?:\/\//, '').charAt(0).toUpperCase();
    const ico = document.createElement('span');
    ico.className = 'url-suggest-ico' + (item.kind === 'search' ? ' is-search' : '') + (item.kind === 'gpt' ? ' is-gpt' : '') + (item.kind === 'onion' ? ' is-onion' : '');
    ico.textContent = item.kind === 'search' ? '⌕' : (item.kind === 'gpt' ? '✦' : (item.kind === 'onion' ? '🧅' : letter));
    const text = document.createElement('span');
    text.className = 'url-suggest-text';
    const name = document.createElement('span');
    name.className = 'url-suggest-name';
    name.textContent = item.title || item.url;
    const hint = document.createElement('span');
    hint.className = 'url-suggest-hint';
    hint.textContent = item.subtitle || item.url || '';
    text.appendChild(name);
    text.appendChild(hint);
    btn.appendChild(ico);
    btn.appendChild(text);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      rememberRecentSearch(urlSuggestState.q);
      hideUrlSuggestions();
      navigateToUrl(item.url || item.title);
    });
    urlSuggestList.appendChild(btn);
  });
  appendRefreshSuggestionsButton(urlSuggestList);
  urlSuggestPanel.hidden = urlSuggestState.items.length === 0;
  if (urlSuggestStatus) {
    urlSuggestStatus.hidden = urlSuggestState.items.length === 0;
    urlSuggestStatus.textContent = urlSuggestState.loading
      ? 'Carregando mais sugestões…'
      : (urlSuggestState.hasMore ? 'Role para ver mais URLs' : 'Fim das sugestões');
  }
}

async function fetchUrlSuggestions(reset) {
  const input = activeSuggestInput();
  const q = String(input && input.value || '').trim();
  if (q.length < 2) {
    hideUrlSuggestions();
    if (searchFsOpen) {
      urlSuggestState.items = [];
      urlSuggestState.q = '';
      renderFullscreenSuggestions();
    }
    return;
  }
  if (urlSuggestState.loading) return;
  if (reset) {
    urlSuggestState.q = q;
    urlSuggestState.page = 0;
    urlSuggestState.items = localUrlSuggestions(q);
    urlSuggestState.active = -1;
    urlSuggestState.hasMore = true;
    renderUrlSuggestions();
  } else if (!urlSuggestState.hasMore || urlSuggestState.q !== q) {
    return;
  }
  urlSuggestState.loading = true;
  renderUrlSuggestions();
  // Quantidade mínima de resultados de site que queremos mostrar antes de parar
  const TARGET_SITE_COUNT = 8;
  try {
    let hops = 0;
    while (hops < 10 && urlSuggestState.hasMore) {
      hops += 1;
      const res = await fetch('/api/url-suggest?q=' + encodeURIComponent(q) + '&page=' + urlSuggestState.page + '&clientId=' + encodeURIComponent(CLIENT_ID));
      const data = await res.json();
      if (String(activeSuggestInput().value || '').trim() !== q) {
        urlSuggestState.loading = false;
        return;
      }
      const incoming = (data && data.suggestions) || [];
      const seen = new Set(urlSuggestState.items.map((item) => (item.kind || '') + '|' + (item.url || item.title)));
      incoming.forEach((item) => {
        const key = (item.kind || '') + '|' + (item.url || item.title);
        if (seen.has(key)) return;
        seen.add(key);
        urlSuggestState.items.push(item);
      });
      urlSuggestState.hasMore = !!(data && data.hasMore);
      urlSuggestState.page += 1;
      // Renderiza resultados intermediários para o usuário já ver algo enquanto busca mais
      renderUrlSuggestions();
      // Continua buscando se ainda não atingiu o mínimo de resultados de site
      const siteCount = urlSuggestState.items.filter((item) => item.kind === 'site').length;
      if (siteCount >= TARGET_SITE_COUNT) break;
    }
  } catch (e) {
    urlSuggestState.hasMore = false;
  }
  urlSuggestState.loading = false;
  renderUrlSuggestions();
}

function scheduleUrlSuggestions() {
  if (urlSuggestState.timer) clearTimeout(urlSuggestState.timer);
  const input = activeSuggestInput();
  const q = String(input && input.value || '').trim();
  if (q.length < 2) {
    hideUrlSuggestions();
    if (searchFsOpen) {
      urlSuggestState.items = [];
      urlSuggestState.q = '';
      renderFullscreenSuggestions();
    }
    return;
  }
  urlSuggestState.timer = setTimeout(() => fetchUrlSuggestions(true), 180);
}

urlInput.addEventListener('keydown', (e) => {
  const open = urlSuggestPanel && !urlSuggestPanel.hidden && urlSuggestState.items.length;
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const max = urlSuggestState.items.length - 1;
    if (e.key === 'ArrowDown') urlSuggestState.active = Math.min(max, urlSuggestState.active + 1);
    else urlSuggestState.active = Math.max(0, urlSuggestState.active < 0 ? max : urlSuggestState.active - 1);
    renderUrlSuggestions();
    const activeEl = urlSuggestList && urlSuggestList.children[urlSuggestState.active];
    if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Escape') {
    hideUrlSuggestions();
    return;
  }
  if (e.key === 'Enter') {
    const chosen = open && urlSuggestState.active >= 0 ? urlSuggestState.items[urlSuggestState.active] : null;
    hideUrlSuggestions();
    rememberRecentSearch((chosen && chosen.title) || urlInput.value);
    navigateToUrl(chosen ? (chosen.url || chosen.title) : urlInput.value);
  }
});

urlInput.addEventListener('input', () => {
  syncSearchClearButton();
  scheduleUrlSuggestions();
});

// Clicar no campo de busca abre a aba de pesquisa em tela cheia
urlInput.addEventListener('focus', () => openSearchFullscreen());
urlInput.addEventListener('mousedown', (e) => {
  e.preventDefault();
  openSearchFullscreen();
});

urlInput.addEventListener('blur', () => {
  setTimeout(hideUrlSuggestions, 180);
});

if (urlSuggestPanel) {
  urlSuggestPanel.addEventListener('scroll', () => {
    if (urlSuggestPanel.scrollTop + urlSuggestPanel.clientHeight >= urlSuggestPanel.scrollHeight - 48) {
      fetchUrlSuggestions(false);
    }
  });
}

if (searchFsInput) {
  searchFsInput.addEventListener('input', () => {
    syncSearchFsClearButton();
    scheduleUrlSuggestions();
    renderRecentSearchChips();
  });

  searchFsInput.addEventListener('keydown', (e) => {
    const total = urlSuggestState.items.length;
    if (total && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const max = total - 1;
      if (e.key === 'ArrowDown') urlSuggestState.active = Math.min(max, urlSuggestState.active + 1);
      else urlSuggestState.active = Math.max(0, urlSuggestState.active < 0 ? max : urlSuggestState.active - 1);
      renderFullscreenSuggestions();
      const activeEl = searchFsList && searchFsList.children[urlSuggestState.active];
      if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchFullscreen();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = urlSuggestState.active >= 0 ? urlSuggestState.items[urlSuggestState.active] : null;
      const typed = String(searchFsInput.value || '').trim();
      if (chosen) {
        applySuggestion(chosen);
        return;
      }
      if (!typed) return;
      rememberRecentSearch(typed);
      closeSearchFullscreen(true);
      navigateToUrl(typed);
    }
  });
}

if (searchFsBody) {
  searchFsBody.addEventListener('scroll', () => {
    if (searchFsBody.scrollTop + searchFsBody.clientHeight >= searchFsBody.scrollHeight - 160) {
      fetchUrlSuggestions(false);
    }
  });
}

const searchFsCloseBtn = document.getElementById('search-fs-close');
if (searchFsCloseBtn) searchFsCloseBtn.addEventListener('click', () => closeSearchFullscreen());

if (searchFsClear) {
  searchFsClear.addEventListener('click', () => {
    searchFsInput.value = '';
    syncSearchFsClearButton();
    urlSuggestState.items = [];
    urlSuggestState.q = '';
    renderFullscreenSuggestions();
    searchFsInput.focus();
  });
}

const searchFsGo = document.getElementById('search-fs-go');
if (searchFsGo) {
  searchFsGo.addEventListener('click', () => {
    const typed = String(searchFsInput && searchFsInput.value || '').trim();
    if (!typed) return;
    rememberRecentSearch(typed);
    closeSearchFullscreen(true);
    navigateToUrl(typed);
  });
}

// ============================================================================
// DITADO POR VOZ DO CAMPO DE PESQUISA
// Independente do assistente do DJ: aqui a fala vira só o texto da busca.
// ============================================================================
const searchFsMic = document.getElementById('search-fs-mic');
const searchFsMicWave = document.getElementById('search-fs-mic-wave');
const searchFsField = searchFs ? searchFs.querySelector('.search-fs-field') : null;
const SEARCH_MIC_PLACEHOLDER = searchFsInput ? searchFsInput.placeholder : '';

const searchDictation = {
  state: 'idle',
  recognition: null,
  stream: null,
  recorder: null,
  chunks: [],
  audioCtx: null,
  analyser: null,
  silenceTimer: null,
  maxTimer: null,
  spoke: false,
  cancelled: false
};

function setSearchMicState(state, hint) {
  searchDictation.state = state;
  if (searchFsMic) {
    searchFsMic.classList.toggle('is-listening', state === 'listening');
    searchFsMic.classList.toggle('is-working', state === 'working');
    searchFsMic.title = state === 'listening' ? 'Parar de ouvir' : 'Pesquisar por voz';
  }
  if (searchFsField) searchFsField.classList.toggle('is-listening', state === 'listening');
  if (searchFsMicWave && state !== 'listening') searchFsMicWave.style.transform = 'scale(1)';
  if (searchFsInput) {
    searchFsInput.placeholder = hint || SEARCH_MIC_PLACEHOLDER;
    if (state === 'idle') searchFsInput.classList.remove('is-interim');
  }
}

function applyDictatedText(text, isFinal) {
  const spoken = String(text || '').trim();
  if (!searchFsInput || !spoken) return;
  searchFsInput.value = spoken;
  searchFsInput.classList.toggle('is-interim', !isFinal);
  syncSearchFsClearButton();
  if (!isFinal) return;
  searchFsInput.classList.remove('is-interim');
  rememberRecentSearch(spoken);
  closeSearchFullscreen(true);
  navigateToUrl(spoken);
}

function stopSearchDictation(cancelled) {
  searchDictation.cancelled = Boolean(cancelled);
  if (searchDictation.silenceTimer) clearTimeout(searchDictation.silenceTimer);
  if (searchDictation.maxTimer) clearTimeout(searchDictation.maxTimer);
  searchDictation.silenceTimer = null;
  searchDictation.maxTimer = null;
  if (searchDictation.recognition) {
    try { searchDictation.recognition.stop(); } catch (e) {}
  }
  if (searchDictation.recorder && searchDictation.recorder.state === 'recording') {
    try { searchDictation.recorder.stop(); } catch (e) {}
  } else {
    releaseDictationStream();
    if (cancelled || searchDictation.state === 'listening') setSearchMicState('idle');
  }
}

function releaseDictationStream() {
  if (searchDictation.stream) {
    searchDictation.stream.getTracks().forEach((track) => {
      try { track.stop(); } catch (e) {}
    });
    searchDictation.stream = null;
  }
}

// Navegadores com a API nativa transcrevem enquanto a pessoa fala
function startDictationWithSpeechApi() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) return false;
  let rec;
  try {
    rec = new SpeechRec();
  } catch (e) {
    return false;
  }
  rec.lang = 'pt-BR';
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let got = '';
  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) got = result[0].transcript;
      else interim += result[0].transcript;
    }
    if (got) applyDictatedText(got, true);
    else if (interim) applyDictatedText(interim, false);
  };
  rec.onerror = (event) => {
    searchDictation.recognition = null;
    const code = event && event.error;
    // No Electron a API nativa não tem servidor de fala: cai para a gravação via Whisper
    if ((code === 'network' || code === 'service-not-allowed') && !got) {
      startDictationWithWhisper();
      return;
    }
    setSearchMicState('idle');
  };
  rec.onend = () => {
    searchDictation.recognition = null;
    if (searchDictation.state === 'listening') setSearchMicState('idle');
  };

  try {
    rec.start();
  } catch (e) {
    return false;
  }
  searchDictation.recognition = rec;
  setSearchMicState('listening', 'Ouvindo… pode falar');
  return true;
}

// No Electron a transcrição roda no servidor: grava até o silêncio e envia o áudio
async function startDictationWithWhisper() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setSearchMicState('idle');
    return;
  }
  try {
    searchDictation.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      video: false
    });
  } catch (err) {
    console.warn('[VOZ BUSCA] microfone negado:', err && err.message ? err.message : err);
    setSearchMicState('idle');
    return;
  }

  searchDictation.cancelled = false;
  searchDictation.chunks = [];
  searchDictation.spoke = false;

  try {
    searchDictation.audioCtx = searchDictation.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (searchDictation.audioCtx.state === 'suspended') await searchDictation.audioCtx.resume();
    const source = searchDictation.audioCtx.createMediaStreamSource(searchDictation.stream);
    searchDictation.analyser = searchDictation.audioCtx.createAnalyser();
    searchDictation.analyser.fftSize = 512;
    source.connect(searchDictation.analyser);
  } catch (e) {
    searchDictation.analyser = null;
  }

  let recorder;
  try {
    recorder = new MediaRecorder(searchDictation.stream, { mimeType: 'audio/webm' });
  } catch (e) {
    releaseDictationStream();
    setSearchMicState('idle');
    return;
  }
  searchDictation.recorder = recorder;

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) searchDictation.chunks.push(e.data);
  };

  recorder.onstop = async () => {
    searchDictation.recorder = null;
    releaseDictationStream();
    const blob = new Blob(searchDictation.chunks, { type: 'audio/webm' });
    searchDictation.chunks = [];
    if (searchDictation.cancelled || blob.size < 1200) {
      setSearchMicState('idle');
      return;
    }
    setSearchMicState('working', 'Transcrevendo o que você falou…');
    try {
      const response = await fetch('/api/whisper', { method: 'POST', body: blob });
      const result = await response.json();
      const text = result && result.text ? String(result.text).trim() : '';
      setSearchMicState('idle');
      if (text) applyDictatedText(text, true);
      else if (searchFsInput) searchFsInput.placeholder = 'Não entendi. Toque no microfone e fale de novo.';
    } catch (err) {
      console.warn('[VOZ BUSCA] falha ao transcrever:', err && err.message ? err.message : err);
      setSearchMicState('idle');
      if (searchFsInput) searchFsInput.placeholder = 'Não deu para transcrever agora. Tente de novo.';
    }
  };

  recorder.start(100);
  setSearchMicState('listening', 'Ouvindo… pode falar');

  const watchVolume = () => {
    if (searchDictation.state !== 'listening' || !searchDictation.analyser) return;
    const data = new Uint8Array(searchDictation.analyser.fftSize);
    searchDictation.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
    const volume = sum / data.length;
    if (searchFsMicWave) searchFsMicWave.style.transform = 'scale(' + (1 + Math.min(0.55, volume / 22)).toFixed(3) + ')';
    if (volume > 1.8) {
      searchDictation.spoke = true;
      if (searchDictation.silenceTimer) {
        clearTimeout(searchDictation.silenceTimer);
        searchDictation.silenceTimer = null;
      }
    } else if (searchDictation.spoke && !searchDictation.silenceTimer) {
      // Um segundo de silêncio depois da fala já encerra a captura
      searchDictation.silenceTimer = setTimeout(() => stopSearchDictation(false), 1000);
    }
    requestAnimationFrame(watchVolume);
  };
  watchVolume();

  searchDictation.maxTimer = setTimeout(() => stopSearchDictation(false), 9000);
}

if (searchFsMic) {
  searchFsMic.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (searchDictation.state === 'listening') {
      stopSearchDictation(false);
      return;
    }
    if (searchDictation.state === 'working') return;
    if (searchFsInput) searchFsInput.focus();
    if (!startDictationWithSpeechApi()) startDictationWithWhisper();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchFsOpen) closeSearchFullscreen();
});

const btnClearSearch = document.getElementById('btn-clear-search');
if (btnClearSearch) {
  btnClearSearch.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    urlInput.value = '';
    syncSearchClearButton();
    hideUrlSuggestions();
    openSearchFullscreen('');
  });
}
syncSearchClearButton();

btnGo.addEventListener('click', () => {
  navigateToUrl(urlInput.value);
});

if (btnOpenSystemBrowser) {
  btnOpenSystemBrowser.addEventListener('click', async () => {
    const activeTab = getActiveTab();
    const url = (activeTab && activeTab.url) || urlInput.value.trim();
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      footerStatus.textContent = 'Abrindo página no Papaléguas...';
      createTab(url);
      setTimeout(() => {
        footerStatus.textContent = 'Pronto';
      }, 3000);
    } else {
      footerStatus.textContent = 'Apenas links web (http/https) podem ser abertos.';
    }
  });
}

btnBack.addEventListener('click', (e) => {
  if (e && e.preventDefault) e.preventDefault();
  const activeTab = getActiveTab();
  if (activeTab && activeTab.webview && typeof activeTab.webview.canGoBack === 'function' && activeTab.webview.canGoBack()) {
    activeTab.webview.goBack();
  }
});

btnForward.addEventListener('click', (e) => {
  if (e && e.preventDefault) e.preventDefault();
  const activeTab = getActiveTab();
  if (activeTab && activeTab.webview && typeof activeTab.webview.canGoForward === 'function' && activeTab.webview.canGoForward()) {
    activeTab.webview.goForward();
  }
});

btnReload.addEventListener('click', () => {
  const activeTab = getActiveTab();
  if (activeTab) {
    activeTab.webview.reload();
  }
});

btnHome.addEventListener('click', () => {
  goHomeFromFullscreen();
});

(function trapHostedBrowserBack() {
  if (isElectronApp()) return;
  try {
    window.history.replaceState({ papaleguas: 1 }, '', window.location.href);
    window.history.pushState({ papaleguas: 2 }, '', window.location.href);
  } catch (e) {}
  window.addEventListener('popstate', () => {
    try {
      window.history.pushState({ papaleguas: 2 }, '', window.location.href);
    } catch (e) {}
    const activeTab = getActiveTab();
    if (activeTab && activeTab.webview && typeof activeTab.webview.canGoBack === 'function' && activeTab.webview.canGoBack()) {
      activeTab.webview.goBack();
    }
  });
})();
const fsHomeBtn = document.getElementById('fs-home-btn');
if (fsHomeBtn) {
  fsHomeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    goHomeFromFullscreen();
  });
  // Arrastável: o usuário escolhe onde o botão fica (posição salva).
  if (window.PapaleguasFab && typeof window.PapaleguasFab.makeDraggable === 'function') {
    window.PapaleguasFab.makeDraggable(fsHomeBtn, {
      storageKey: 'papaleguas_fab_pos_home',
      onDragStart: () => { clearTimeout(fsHomeHideTimer); },
      onDragEnd: () => { if (fsHomeWatching) fsHomeScheduleHide(3000); }
    });
  }
}

// Botão Home some enquanto um vídeo está sendo assistido e volta por alguns
// segundos a cada toque na tela (como os controles de um player).
let fsHomeWatching = false;
let fsHomeHideTimer = null;
function fsHomeHide() {
  if (!fsHomeBtn || fsHomeBtn.classList.contains('is-dragging')) return;
  fsHomeBtn.classList.add('is-hidden');
}
function fsHomeShow() {
  if (fsHomeBtn) fsHomeBtn.classList.remove('is-hidden');
}
function fsHomeScheduleHide(ms) {
  clearTimeout(fsHomeHideTimer);
  fsHomeHideTimer = setTimeout(fsHomeHide, ms || 3000);
}
function fsHomeVideoWatch(active) {
  const next = !!active;
  if (next === fsHomeWatching) return; // atualizações repetidas não reiniciam o ciclo
  fsHomeWatching = next;
  clearTimeout(fsHomeHideTimer);
  if (fsHomeWatching) fsHomeHide();
  else fsHomeShow();
}
function fsHomeUserActivity() {
  if (!fsHomeWatching) return;
  fsHomeShow();
  fsHomeScheduleHide(3000);
}
['pointerdown', 'touchstart', 'keydown'].forEach((evName) => {
  window.addEventListener(evName, fsHomeUserActivity, { capture: true, passive: true });
});

// Atalhos Rápidos e Menus (Pluto TV Filmes Online, Papaléguas Music, YouTube, etc.)
const btnMovies = document.getElementById('btn-movies');
const btnSpotify = document.getElementById('btn-spotify');
const btnYoutube = document.getElementById('btn-youtube');
const btnAddBookmark = document.getElementById('btn-add-bookmark');
const bookmarksBarItems = document.getElementById('bookmarks-bar-items');
if (btnSpotify) {
  btnSpotify.addEventListener('click', () => {
    openPapaleguasMusic('');
    enterMenuPortalFullscreen();
  });
}
if (btnYoutube) {
  btnYoutube.addEventListener('click', () => {
    openYoutube('');
    enterMenuPortalFullscreen();
  });
}

function openFilmesOnline(searchQuery = '') {
  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
  const baseUrl = isElectron ? 'http://localhost:8080' : '';
  let filmesUrl = baseUrl + '/filmes';
  if (searchQuery && searchQuery.trim()) {
    filmesUrl += '?q=' + encodeURIComponent(searchQuery.trim());
  }

  // Procura se já existe uma aba de Filmes Online aberta
  const existingTab = tabs.find(t => t.url && t.url.includes('/filmes'));
  if (existingTab) {
    activateTab(existingTab.id);
    if (existingTab.webview) {
      existingTab.webview.loadURL(filmesUrl);
    }
  } else {
    const activeTab = getActiveTab();
    if (activeTab && activeTab.url && activeTab.url.includes('newtab.html') && activeTab.webview) {
      activeTab.webview.loadURL(filmesUrl);
    } else {
      createTab(filmesUrl);
    }
  }
  setAddressBar(publicAppOrigin() + '/filmes');
  syncPortalHomeButton('/filmes');
}
window.openFilmesOnline = openFilmesOnline;
window.openPapaleguasMusic = openPapaleguasMusic;

function openYoutube(searchQuery = '', videoId = '') {
  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
  const baseUrl = isElectron ? 'http://localhost:8080' : '';
  const cleanQ = (searchQuery || '').trim();
  const params = new URLSearchParams();
  if (cleanQ) params.set('q', cleanQ);
  if (videoId) params.set('v', videoId);
  const qs = params.toString();
  const ytUrl = baseUrl + '/youtube' + (qs ? '?' + qs : '');

  const existingTab = tabs.find((t) => t.url && (t.url.includes('/youtube') || t.url.includes('/baixatube') || t.url.includes('newtab.html') || t.url.includes('youtube.com')));
  if (existingTab) {
    activateTab(existingTab.id);
    if (existingTab.webview && typeof existingTab.webview.loadURL === 'function') {
      existingTab.webview.loadURL(ytUrl);
    } else if (existingTab.webview) {
      existingTab.webview.src = ytUrl;
    }
  } else {
    const activeTab = getActiveTab();
    if (activeTab && activeTab.url && activeTab.url.includes('newtab.html') && activeTab.webview) {
      if (typeof activeTab.webview.loadURL === 'function') {
        activeTab.webview.loadURL(ytUrl);
      } else {
        activeTab.webview.src = ytUrl;
      }
    } else {
      createTab(ytUrl);
    }
  }
  setAddressBar(publicAppOrigin() + '/baixatube');
  syncPortalHomeButton('/youtube');
}

function openWebSearch(searchQuery = '', forceAi = false) {
  const cleanQ = (searchQuery || '').trim();
  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
  const baseUrl = isElectron ? 'http://localhost:8080' : '';

  // Se for pedido de IA, resumo ou na versão web/mobile, usa o portal de busca com extração profunda e IA
  let searchUrl = '';
  if (!cleanQ) {
    searchUrl = `${baseUrl}/search`;
  } else if (forceAi || /(?:resumo|resuma|not[ií]cia|quem [eé]|o que [eé]|como|qual|por que|explique|analise)/i.test(cleanQ)) {
    searchUrl = `${baseUrl}/search?q=${encodeURIComponent(cleanQ)}&ai=1`;
  } else {
    searchUrl = `${baseUrl}/search?q=${encodeURIComponent(cleanQ)}`;
  }

  const activeTab = getActiveTab();
  if (activeTab && activeTab.webview) {
    activeTab.url = searchUrl;
    activeTab.webview.loadURL(searchUrl);
    setAddressBar(searchUrl);
    return;
  }
  createTab(searchUrl);
}

if (btnMovies) {
  btnMovies.addEventListener('click', () => {
    openFilmesOnline('');
    enterMenuPortalFullscreen();
  });
}

// Função para abrir favoritos (internos ou externos)
function openBookmarkUrl(rawUrl, title = '') {
  if (!rawUrl) return;
  const cleanUrl = rawUrl.trim();

  // 1. Atalhos de YouTube
  if (cleanUrl === '/youtube' || cleanUrl === 'youtube' || cleanUrl === '/baixatube' || cleanUrl === 'baixatube' || cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be')) {
    let q = '';
    if (cleanUrl.includes('search_query=')) {
      try {
        const u = new URL(cleanUrl.startsWith('http') ? cleanUrl : 'https://youtube.com/' + cleanUrl);
        q = u.searchParams.get('search_query') || '';
      } catch(e) {}
    }
    openYoutube(q);
    return;
  }

  // 2. Atalhos de Filmes
  if (cleanUrl === '/filmes' || cleanUrl === 'filmes' || cleanUrl.includes('pluto.tv')) {
    openFilmesOnline('');
    return;
  }

  // 3. Atalhos de Músicas
  if (cleanUrl === '/musica' || cleanUrl === 'musica' || cleanUrl.includes('musica.html') || cleanUrl.includes('open.spotify.com')) {
    openPapaleguasMusic('');
    return;
  }

  // 4. Atalhos de Mais Tocadas
  if (cleanUrl === 'maistocadas' || cleanUrl.includes('maistocadas.mus.br')) {
    navigateToUrl('https://maistocadas.mus.br/');
    return;
  }

  // 5. Normalização de URL externa ou pesquisa
  let finalUrl = cleanUrl;
  if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://') && !finalUrl.startsWith('/')) {
    if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
      finalUrl = 'https://' + finalUrl;
    } else {
      openWebSearch(finalUrl);
      return;
    }
  }

  navigateToUrl(finalUrl);
}

// Helper para chave de armazenamento isolada por dispositivo/cliente
function getBookmarksStorageKey() {
  const cid = (typeof CLIENT_ID === 'string' && CLIENT_ID.trim()) ? CLIENT_ID.trim() : 'default';
  return 'user_bookmarks_' + cid;
}

// Sistema de Favoritos / Bookmarks Personalizados
function renderBookmarks() {
  if (!bookmarksBarItems) return;
  bookmarksBarItems.innerHTML = '';
  const bookmarks = getUserBookmarks();
  
  bookmarks.forEach((bm, index) => {
    const btn = document.createElement('div');
    btn.className = 'shortcut-item-btn';
    btn.style.position = 'relative';
    btn.style.cursor = 'pointer';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.gap = '6px';
    btn.style.userSelect = 'none';
    
    let hostname = 'google.com';
    try {
      if (bm.url.startsWith('http://') || bm.url.startsWith('https://')) {
        hostname = new URL(bm.url).hostname;
      } else if (bm.url.includes('.')) {
        hostname = new URL('https://' + bm.url).hostname;
      }
    } catch(e) {}
    
    const isYt = bm.url.includes('youtube') || bm.url.includes('/youtube');
    const isMovies = bm.url.includes('filmes') || bm.url.includes('pluto.tv');
    const isMusic = bm.url.includes('musica') || bm.url.includes('spotify');
    
    const iconSrc = isYt
      ? 'https://www.google.com/s2/favicons?domain=youtube.com&sz=32'
      : isMovies
      ? 'papaleguas_icon.png'
      : isMusic
      ? 'papaleguas_icon.png'
      : `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;

    const img = document.createElement('img');
    img.src = iconSrc;
    img.style.width = '16px';
    img.style.height = '16px';
    img.style.borderRadius = '50%';
    img.style.objectFit = 'contain';
    img.style.pointerEvents = 'none';
    img.onerror = () => { img.src = 'papaleguas_icon.png'; };

    const titleSpan = document.createElement('span');
    titleSpan.className = 'bookmark-text';
    titleSpan.textContent = bm.title;
    titleSpan.style.pointerEvents = 'none';
    titleSpan.style.fontSize = '12px';
    titleSpan.style.fontWeight = '500';

    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove-bookmark-btn';
    removeBtn.title = 'Remover favorito';
    removeBtn.innerHTML = '&times;';
    removeBtn.style.color = '#94a3b8';
    removeBtn.style.fontSize = '16px';
    removeBtn.style.padding = '0 3px';
    removeBtn.style.marginLeft = '4px';
    removeBtn.style.cursor = 'pointer';
    removeBtn.style.lineHeight = '1';
    removeBtn.style.display = 'inline-flex';
    removeBtn.style.alignItems = 'center';
    removeBtn.style.transition = 'color 0.2s';

    removeBtn.addEventListener('mouseenter', () => { removeBtn.style.color = '#ef4444'; });
    removeBtn.addEventListener('mouseleave', () => { removeBtn.style.color = '#94a3b8'; });
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (confirm(`Deseja remover o atalho "${bm.title}"?`)) {
        bookmarks.splice(index, 1);
        setUserBookmarks(bookmarks);
        renderBookmarks();
      }
    });

    btn.appendChild(img);
    btn.appendChild(titleSpan);
    btn.appendChild(removeBtn);

    btn.title = `${bm.title}\n• Clique para abrir\n• Botão direito para abrir em nova aba`;

    btn.addEventListener('click', (e) => {
      if (e.target === removeBtn || e.target.closest('.remove-bookmark-btn')) return;
      openBookmarkUrl(bm.url, bm.title);
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      try {
        let directUrl = (bm.url || '').trim();
        if (directUrl) {
          if (!directUrl.startsWith('http://') && !directUrl.startsWith('https://') && !directUrl.startsWith('/')) {
            directUrl = 'https://' + directUrl;
          }
          createTab(directUrl);
        }
      } catch(err){}
    });

    bookmarksBarItems.appendChild(btn);
  });
  if (typeof renderOpenTabsMenu === 'function') renderOpenTabsMenu();
}

function getUserBookmarks() {
  const key = getBookmarksStorageKey();
  try {
    const scoped = localStorage.getItem(key);
    if (scoped !== null) {
      const parsed = JSON.parse(scoped);
      return Array.isArray(parsed) ? parsed : [];
    }
    // Migração de favoritos legados se ainda não houver chave isolada
    const legacy = localStorage.getItem('user_bookmarks');
    if (legacy !== null) {
      const parsedLegacy = JSON.parse(legacy);
      if (Array.isArray(parsedLegacy) && parsedLegacy.length) {
        localStorage.setItem(key, JSON.stringify(parsedLegacy));
        return parsedLegacy;
      }
    }
  } catch (e) {}
  return [];
}

function setUserBookmarks(bookmarks) {
  const list = Array.isArray(bookmarks) ? bookmarks : [];
  const key = getBookmarksStorageKey();
  const serialized = JSON.stringify(list);
  try {
    localStorage.setItem(key, serialized);
    // No Electron mantém compatibilidade com chave legada para fechamento e persistência global
    if (isElectronApp()) {
      localStorage.setItem('user_bookmarks', serialized);
    }
  } catch (e) {}
}

function normalizeBookmarkCompare(url) {
  if (!url) return '';
  let s = String(url).trim().toLowerCase();
  try {
    if (s.includes('/proxy?url=')) {
      s = (new URL(s, window.location.origin).searchParams.get('url') || s).toLowerCase();
    }
  } catch (e) {}
  s = s.replace(/\/+$/, '');
  if (s.includes('youtube') || s.includes('baixatube') || s.includes('youtu.be')) return 'youtube';
  if (s.includes('filmes') || s.includes('pluto.tv')) return 'filmes';
  if (s.includes('musica') || s.includes('spotify')) return 'musica';
  return s;
}

function sameBookmarkUrl(a, b) {
  const na = normalizeBookmarkCompare(a);
  const nb = normalizeBookmarkCompare(b);
  return !!(na && nb && na === nb);
}

function isUrlBookmarked(url) {
  return getUserBookmarks().some((bm) => sameBookmarkUrl(bm.url, url));
}

function bookmarkUrlFromTab(tab) {
  let url = tab && tab.url ? String(tab.url) : '';
  if (!url) return '';
  try {
    if (url.includes('/proxy?url=')) {
      url = new URL(url, window.location.origin).searchParams.get('url') || url;
    }
  } catch (e) {}
  if (/newtab\.html/i.test(url) && !/[?&](?:q|v)=/i.test(url)) return '';
  const lower = url.toLowerCase();
  if (lower.includes('/youtube') || lower.includes('/baixatube')) return '/youtube';
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return url;
  if (lower.includes('/filmes') || lower.includes('pluto.tv')) return '/filmes';
  if (lower.includes('musica.html') || /(^|\/)musica(\?|$)/i.test(url) || lower.includes('open.spotify.com')) return '/musica';
  return url;
}

function tabDisplayTitle(tab) {
  const title = (tab && tab.title || '').trim();
  if (title && title !== 'Papaléguas' && title !== 'Nova Guia' && title !== 'Sem título') return title;
  const url = tab && tab.url ? String(tab.url) : '';
  if (/newtab\.html/i.test(url) && !/[?&](?:q|v)=/i.test(url)) return 'Início';
  if (url.includes('/youtube') || url.includes('/baixatube') || url.includes('youtube.com') || url.includes('youtu.be')) return 'BaixaTube';
  if (url.includes('/filmes') || url.includes('pluto.tv')) return 'Filmes';
  if (url.includes('musica.html') || url.includes('/musica')) return 'Músicas';
  try {
    const pretty = prettyAddressBarUrl(url);
    if (pretty) {
      if (pretty.startsWith('http')) return new URL(pretty).hostname.replace(/^www\./, '');
      return pretty;
    }
  } catch (e) {}
  return 'Aba';
}

function saveBookmarkSilent(title, url, opts = {}) {
  const cleanUrl = (url || '').trim();
  if (!cleanUrl) return false;
  const bookmarks = getUserBookmarks();
  if (bookmarks.some((bm) => sameBookmarkUrl(bm.url, cleanUrl))) return false;
  bookmarks.push({ title: (title || 'Favorito').trim(), url: cleanUrl });
  setUserBookmarks(bookmarks);
  if (!opts.skipRender) renderBookmarks();
  return true;
}

function removeBookmarkByUrl(url) {
  const bookmarks = getUserBookmarks();
  const next = bookmarks.filter((bm) => !sameBookmarkUrl(bm.url, url));
  if (next.length === bookmarks.length) return false;
  setUserBookmarks(next);
  renderBookmarks();
  return true;
}

const tabsMenu = document.getElementById('tabs-menu');
const tabsMenuList = document.getElementById('tabs-menu-list');
const tabsMenuNew = document.getElementById('tabs-menu-new');
const tabsMenuSaveAll = document.getElementById('tabs-menu-save-all');

function hideTabsMenu() {
  if (tabsMenu) tabsMenu.hidden = true;
}

function renderOpenTabsMenu() {
  if (!tabsMenuList) return;
  tabsMenuList.innerHTML = '';
  if (!tabs.length) {
    const empty = document.createElement('div');
    empty.className = 'tabs-menu-empty';
    empty.textContent = 'Nenhuma aba aberta';
    tabsMenuList.appendChild(empty);
    return;
  }
  tabs.forEach((tab) => {
    const row = document.createElement('div');
    row.className = 'tabs-menu-item' + (tab.id === activeTabId ? ' is-active' : '');

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'tabs-menu-main';
    const titleEl = document.createElement('span');
    titleEl.className = 'tabs-menu-title';
    titleEl.textContent = tabDisplayTitle(tab);
    const urlEl = document.createElement('span');
    urlEl.className = 'tabs-menu-url';
    urlEl.textContent = prettyAddressBarUrl(tab.url) || tab.url || 'Página inicial';
    main.appendChild(titleEl);
    main.appendChild(urlEl);
    main.addEventListener('click', () => {
      activateTab(tab.id);
      hideTabsMenu();
    });

    const star = document.createElement('button');
    star.type = 'button';
    const bookmarkUrl = bookmarkUrlFromTab(tab);
    const saved = !!(bookmarkUrl && isUrlBookmarked(bookmarkUrl));
    star.className = 'tabs-menu-star' + (saved ? ' is-saved' : '');
    star.title = saved ? 'Remover dos favoritos' : 'Salvar como favorita';
    star.textContent = saved ? '★' : '☆';
    star.disabled = !bookmarkUrl;
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!bookmarkUrl) return;
      if (isUrlBookmarked(bookmarkUrl)) {
        removeBookmarkByUrl(bookmarkUrl);
      } else {
        saveBookmarkSilent(tabDisplayTitle(tab), bookmarkUrl);
      }
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tabs-menu-close';
    close.title = 'Fechar aba';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    row.appendChild(main);
    row.appendChild(star);
    row.appendChild(close);
    tabsMenuList.appendChild(row);
  });
}

function toggleTabsMenu() {
  if (!tabsMenu) return;
  renderOpenTabsMenu();
  tabsMenu.hidden = !tabsMenu.hidden;
}

if (btnAddBookmark) {
  btnAddBookmark.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTabsMenu();
  });
}

if (tabsMenuNew) {
  tabsMenuNew.addEventListener('click', (e) => {
    e.stopPropagation();
    createTab(DEFAULT_URL);
  });
}

if (tabsMenuSaveAll) {
  tabsMenuSaveAll.addEventListener('click', (e) => {
    e.stopPropagation();
    tabs.forEach((tab) => {
      const url = bookmarkUrlFromTab(tab);
      if (url) saveBookmarkSilent(tabDisplayTitle(tab), url, { skipRender: true });
    });
    renderBookmarks();
  });
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('tabs-menu-wrap');
  if (wrap && !wrap.contains(e.target)) hideTabsMenu();
});

// Botão da Omnibox para adicionar favorito da página atual
const btnBookmark = document.getElementById('btn-bookmark');
if (btnBookmark) {
  btnBookmark.addEventListener('click', () => {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    const url = bookmarkUrlFromTab(activeTab);
    if (!url) {
      toggleTabsMenu();
      return;
    }
    if (isUrlBookmarked(url)) {
      removeBookmarkByUrl(url);
    } else {
      saveBookmarkSilent(tabDisplayTitle(activeTab), url);
    }
  });
}

// Botão da Omnibox para abrir a página atual diretamente em nova janela nativa
const btnOpenExternal = document.getElementById('btn-open-external');
if (btnOpenExternal) {
  btnOpenExternal.addEventListener('click', () => {
    const activeTab = getActiveTab();
    let currentUrl = activeTab && activeTab.url && !activeTab.url.includes('newtab.html') ? activeTab.url : (urlInput ? urlInput.value : '');
    if (currentUrl) {
      if (currentUrl.includes('/proxy?url=')) {
        try {
          const u = new URL(currentUrl, window.location.origin).searchParams.get('url');
          if (u) currentUrl = u;
        } catch (e) {}
      }
      if (currentUrl.startsWith('/')) {
        currentUrl = window.location.origin + currentUrl;
      }
      try {
        openUrlOutsideIframe(currentUrl);
      } catch (e) {}
    }
  });
}

// Inicializa os favoritos
renderBookmarks();


// Circuit Modal Handlers
btnCircuit.addEventListener('click', () => {
  circuitModal.classList.toggle('hidden');
  if (!circuitModal.classList.contains('hidden')) {
    fetchTorIpInfo();
  }
});

closeModalBtn.addEventListener('click', () => {
  circuitModal.classList.add('hidden');
});

btnRefreshIp.addEventListener('click', () => {
  fetchTorIpInfo();
});

btnCheckTorWeb.addEventListener('click', () => {
  const activeTab = getActiveTab();
  if (activeTab) {
    activeTab.webview.loadURL('https://check.torproject.org');
  }
  circuitModal.classList.add('hidden');
});

// Check Tor Status on Startup & UI Update
let currentCloudflareUrl = '';
let cloudflarePollTimer = null;

function updateCloudflareBadge(tunnelUrl, connecting, isNgrok) {
  const badge = document.getElementById('cf-badge');
  const text = document.getElementById('cf-badge-text');
  const dot = document.getElementById('cf-status-dot');
  if (!badge) return;
  if (tunnelUrl && typeof tunnelUrl === 'string' && tunnelUrl.startsWith('http')) {
    currentCloudflareUrl = tunnelUrl;
    const host = tunnelUrl.replace(/^https?:\/\//, '');
    badge.classList.remove('cf-connecting');
    badge.classList.add('cf-ready');
    badge.style.display = isOnPublicTunnel() ? 'none' : 'inline-flex';
    badge.title = (isNgrok ? 'Copiar link Ngrok: ' : 'Copiar link Cloudflare: ') + tunnelUrl;
    if (text) text.textContent = isNgrok ? `Ngrok: ${host}` : host;
    if (dot) dot.className = 'status-dot online';
  } else if (connecting) {
    currentCloudflareUrl = '';
    badge.classList.add('cf-connecting');
    badge.classList.remove('cf-ready');
    badge.style.display = 'inline-flex';
    badge.title = 'Conectando túnel externo (Ngrok / Cloudflare)...';
    if (text) text.textContent = 'Conectando...';
    if (dot) dot.className = 'status-dot pulse';
  } else {
    currentCloudflareUrl = '';
    badge.style.display = 'none';
  }
}

function initCloudflareStatus() {
  const badge = document.getElementById('cf-badge');
  if (badge && !badge.dataset.bound) {
    badge.dataset.bound = '1';
    badge.addEventListener('click', async () => {
      if (!currentCloudflareUrl) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(currentCloudflareUrl);
        }
        if (badge) badge.title = 'Link copiado: ' + currentCloudflareUrl;
      } catch (e) {}
    });
  }
  const poll = async () => {
    try {
      const res = await fetch('/api/session-info', {
        headers: { 'X-Client-Id': CLIENT_ID }
      });
      const info = await res.json();
      const primaryUrl = info.ngrokTunnelUrl || info.cloudflareTunnelUrl;
      const isConnecting = !primaryUrl && (info.ngrokTunnelConnecting || info.cloudflareTunnelConnecting);
      updateCloudflareBadge(primaryUrl, isConnecting, Boolean(info.ngrokTunnelUrl));

      if (info && info.serverVersion) {
        window.currentServerVersion = info.serverVersion;
        const appVerEl = document.getElementById('install-modal-app-version');
        if (appVerEl) {
          appVerEl.textContent = 'Versão ' + info.serverVersion + ' (Atualizada)';
        }
      }

      const extLink = document.getElementById('install-external-link');
      if (extLink && primaryUrl) {
        extLink.href = primaryUrl;
        extLink.textContent = primaryUrl;
      }
      if (!primaryUrl) {
        cloudflarePollTimer = setTimeout(poll, 2500);
      }
    } catch (e) {
      cloudflarePollTimer = setTimeout(poll, 4000);
    }
  };
  poll();
}

async function initTorStatus() {
  try {
    const status = await window.torBrowserAPI.getTorStatus();
    const enabled = !!(status && status.enabled);
    const connected = !!(status && status.enabled && status.connected);
    updateTorUI({ enabled, connected });
    if (enabled && connected) fetchTorIpInfo();
    if (enabled && !connected) setTimeout(initTorStatus, 1500);
  } catch (err) {
    updateTorUI({ enabled: false, connected: false });
    if (badgeText) badgeText.textContent = 'Tor: Desconectado';
  }
}

function updateTorUI(status) {
  torRouteKnown = true;
  lastTorStatus = status || { enabled: false, connected: false, locked: false };
  const isTorOn = !!(status && status.enabled);
  const isTorActive = isTorOn && status.connected;

  if (isTorActive) {
    statusDot.className = 'status-dot online';
    badgeText.textContent = 'Tor: Conectado (9050)';
    if (btnToggleTor) {
      btnToggleTor.classList.add('active');
      torToggleLabel.textContent = 'Tor: Conectado';
      btnToggleTor.title = 'Tor Ativo neste dispositivo. Clique para desconectar este dispositivo.';
    }
    if (torModeText) {
      torModeText.textContent = 'Ativo (SOCKS5: 9050) • Navegação Anônima';
      torModeText.className = 'value text-success';
    }
    if (btnModalToggleTor) {
      btnModalToggleTor.textContent = 'Desconectar este Dispositivo do Tor';
      btnModalToggleTor.className = 'secondary-btn tor-action-btn disconnect';
      btnModalToggleTor.disabled = false;
      btnModalToggleTor.title = 'Desconecta este dispositivo da rede Tor (o servidor continuará ativo).';
    }
  } else if (isTorOn) {
    statusDot.className = 'status-dot';
    badgeText.textContent = 'Tor: Conectando...';
    if (btnToggleTor) {
      btnToggleTor.classList.add('active');
      torToggleLabel.textContent = 'Tor: Conectando';
      btnToggleTor.title = 'Conectando este dispositivo à rede Tor...';
    }
    if (torModeText) {
      torModeText.textContent = 'Ligando — aguardando Tor (9050)';
      torModeText.className = 'value';
    }
    if (btnModalToggleTor) {
      btnModalToggleTor.textContent = 'Conectando ao Tor...';
      btnModalToggleTor.className = 'secondary-btn tor-action-btn connect';
      btnModalToggleTor.disabled = true;
      btnModalToggleTor.title = 'Conectando à rede Tor...';
    }
  } else {
    statusDot.className = 'status-dot';
    badgeText.textContent = 'Tor: Desconectado';
    if (btnToggleTor) {
      btnToggleTor.classList.remove('active');
      torToggleLabel.textContent = 'Conectar Tor';
      btnToggleTor.title = 'Tor Desconectado. O YouTube reconhece seu país original. Clique para conectar este dispositivo ao Tor.';
    }
    if (torModeText) {
      torModeText.textContent = 'Desconectado (IP original do dispositivo)';
      torModeText.className = 'value text-danger';
    }
    if (btnModalToggleTor) {
      btnModalToggleTor.textContent = 'Conectar este Dispositivo ao Tor';
      btnModalToggleTor.className = 'secondary-btn tor-action-btn connect';
      btnModalToggleTor.disabled = false;
      btnModalToggleTor.title = 'Clique para conectar este dispositivo à rede Tor.';
    }
  }
}

async function toggleTorConnection() {
  try {
    const currentStatus = await window.torBrowserAPI.getTorStatus();
    const willEnable = !(currentStatus && currentStatus.enabled);

    const updatedStatus = await window.torBrowserAPI.toggleTor(willEnable);
    updateTorUI(updatedStatus);
    await fetchTorIpInfo();

    if (typeof tabs !== 'undefined' && Array.isArray(tabs)) {
      tabs.forEach((t) => {
        if (!t || !t.webview) return;
        const current = t.url || '';
        if (current && typeof t.webview.loadURL === 'function') t.webview.loadURL(routeUrlInsideTorApp(current));
        else if (typeof t.webview.reload === 'function') t.webview.reload();
      });
    } else {
      const activeTab = getActiveTab();
      if (activeTab && activeTab.webview) {
        const current = activeTab.url || '';
        if (current && typeof activeTab.webview.loadURL === 'function') activeTab.webview.loadURL(routeUrlInsideTorApp(current));
        else activeTab.webview.reload();
      }
    }
  } catch (err) {
    console.error('Erro ao alternar conexão Tor:', err);
  }
}

if (btnToggleTor) {
  btnToggleTor.addEventListener('click', toggleTorConnection);
}

if (btnModalToggleTor) {
  btnModalToggleTor.addEventListener('click', toggleTorConnection);
}

async function readThisDeviceIpv4() {
  try {
    const res = await fetch('https://api4.ipify.org?format=json', { cache: 'no-store' });
    const data = await res.json();
    const ip = data && String(data.ip || '').trim();
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip;
  } catch (e) {}
  return '';
}

async function fetchTorIpInfo() {
  torIpDisplay.textContent = 'Consultando...';
  torCheckStatus.textContent = 'Verificando...';
  try {
    let info = null;
    if (window.torBrowserAPI && typeof window.torBrowserAPI.getTorIpInfo === 'function') {
      info = await window.torBrowserAPI.getTorIpInfo();
    }
    const torOn = !!(info && (info.torOn === true || info.IsTor === true));
    const torIp = (info && (info.torIp || (info.IsTor ? info.IP : ''))) || '';
    let shown = '';
    if (torOn && torIp) {
      shown = torIp;
    } else {
      const deviceIpv4 = await readThisDeviceIpv4();
      shown = (info && (info.clientIpv4 || (!info.torIp && info.IP))) || deviceIpv4 || '';
    }
    if (shown) torIpDisplay.textContent = shown;
    else torIpDisplay.textContent = 'Indisponível';
    if (torOn && torIp) {
      torCheckStatus.textContent = 'ON · ' + torIp;
      torCheckStatus.className = 'value text-tor-on';
    } else if (torOn) {
      torCheckStatus.textContent = 'ON';
      torCheckStatus.className = 'value text-tor-on';
    } else {
      torCheckStatus.textContent = 'OFF';
      torCheckStatus.className = 'value text-danger';
    }
  } catch (e) {
    torIpDisplay.textContent = 'Erro';
    torCheckStatus.textContent = e.message;
  }
}

async function updateAdblockUI() {
  try {
    const status = await window.torBrowserAPI.getAdblockStatus();
    if (status && status.enabled) {
      btnAdblock.classList.add('active');
      adblockLabel.textContent = status.blockedCount > 0 ? `Bloqueados (${status.blockedCount})` : 'Sem Anúncios';
      btnAdblock.title = `Bloqueador Ativo: ${status.blockedCount} anúncios/rastreadores bloqueados. Clique para desativar.`;
    } else {
      btnAdblock.classList.remove('active');
      adblockLabel.textContent = 'Anúncios Permitidos';
      btnAdblock.title = 'Bloqueador Desativado. Clique para ativar proteção contra anúncios.';
    }
  } catch (e) {}
}

if (btnAdblock) {
  btnAdblock.addEventListener('click', async () => {
    try {
      const isCurrentlyActive = btnAdblock.classList.contains('active');
      const newStatus = await window.torBrowserAPI.toggleAdblock(!isCurrentlyActive);
      await updateAdblockUI();
      // Notifica todos os webviews e abas
      tabs.forEach(tab => {
        try {
          if (tab.webview && typeof tab.webview.send === 'function') {
            tab.webview.send('adblock-status-changed', newStatus);
          }
        } catch (e) {}
      });
      // Recarrega a aba ativa para aplicar a nova regra
      const activeTab = getActiveTab();
      if (activeTab && activeTab.webview) {
        activeTab.webview.reload();
      }
    } catch (e) {}
  });
}

// Controles de Janela do Navegador
const btnWinMin = document.getElementById('btn-win-min');
const btnWinMax = document.getElementById('btn-win-max');
const btnWinClose = document.getElementById('btn-win-close');

if (btnWinMin) {
  btnWinMin.addEventListener('click', () => {
    if (window.torBrowserAPI && window.torBrowserAPI.minimizeWindow) {
      window.torBrowserAPI.minimizeWindow();
    }
  });
}

if (btnWinMax) {
  btnWinMax.addEventListener('click', () => {
    if (window.torBrowserAPI && window.torBrowserAPI.maximizeWindow) {
      window.torBrowserAPI.maximizeWindow();
    }
  });
}

if (btnWinClose) {
  btnWinClose.addEventListener('click', () => {
    if (window.torBrowserAPI && window.torBrowserAPI.closeWindow) {
      window.torBrowserAPI.closeWindow();
    }
  });
}

let lastYoutubeState = null;
let userDismissedYtMini = false;
let ytNotifyUnlocked = false;
let appVideoFullscreen = false;
const YT_SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
const ytNotifyAudio = document.getElementById('yt-notify-audio');
const ytPipVideo = document.getElementById('yt-pip-video');
const globalYtMiniPlayer = document.getElementById('global-yt-mini-player');
const gytThumb = document.getElementById('gyt-thumb');
const gytIframe = document.getElementById('gyt-iframe');
const gytTitle = document.getElementById('gyt-title');
const gytPlayIcon = document.getElementById('gyt-play-icon');
const gytBtnPlay = document.getElementById('gyt-btn-play');
const gytBtnExpand = document.getElementById('gyt-btn-expand');
const gytBtnClose = document.getElementById('gyt-btn-close');

let appWakeLock = null;
async function requestAppWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (!appWakeLock) {
      appWakeLock = await navigator.wakeLock.request('screen');
      appWakeLock.addEventListener('release', () => {
        appWakeLock = null;
      });
    }
  } catch (e) {}
}
async function releaseAppWakeLock() {
  if (appWakeLock) {
    try { await appWakeLock.release(); } catch (e) {}
    appWakeLock = null;
  }
}

if (ytNotifyAudio) {
  let lastYtAudioSync = 0;
  ytNotifyAudio.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastYtAudioSync > 1000) {
      lastYtAudioSync = now;
      if (typeof syncParentYtMediaSessionPosition === 'function') {
        syncParentYtMediaSessionPosition(ytNotifyAudio.currentTime, ytNotifyAudio.duration);
      }
    }
  });
  ytNotifyAudio.addEventListener('ended', () => {
    postYoutubeCommand('next');
  });
  ytNotifyAudio.addEventListener('play', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  ytNotifyAudio.addEventListener('pause', () => {
    if (lastYoutubeState && !lastYoutubeState.isPlaying && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  });
}

function isElectronShell() {
  return !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
}

function ytNotifyStreamUrl(id) {
  const origin = window.location.origin && window.location.origin !== 'null'
    ? window.location.origin
    : 'http://localhost:8080';
  return origin + '/api/stream-audio?v=' + encodeURIComponent(id);
}

function ytVideoStreamUrl(id) {
  const origin = window.location.origin && window.location.origin !== 'null'
    ? window.location.origin
    : 'http://localhost:8080';
  return origin + '/api/stream-video?v=' + encodeURIComponent(id);
}

function ytThumbProxyUrl(id) {
  const origin = window.location.origin && window.location.origin !== 'null'
    ? window.location.origin
    : 'http://localhost:8080';
  return origin + '/api/yt-thumb?v=' + encodeURIComponent(id);
}

function isMobilePipClient() {
  return isNativePhone || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

function resetPipMediaSource() {
  if (!ytPipVideo) return;
  if (ytPipVideo._pipTimer) {
    clearInterval(ytPipVideo._pipTimer);
    ytPipVideo._pipTimer = null;
  }
  if (ytPipVideo.srcObject) {
    try { ytPipVideo.srcObject.getTracks().forEach((t) => t.stop()); } catch (e) {}
    ytPipVideo.srcObject = null;
  }
}

async function fallbackPipCanvas(state) {
  if (!ytPipVideo || !state || !state.videoId) return;
  resetPipMediaSource();
  ytPipVideo.removeAttribute('src');
  const canvas = document.createElement('canvas');
  canvas.width = 854;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = ytThumbProxyUrl(state.videoId);
  try { await img.decode(); } catch (e) {}
  const paint = () => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (img.naturalWidth) {
      const scale = Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    }
  };
  paint();
  ytPipVideo._pipTimer = setInterval(paint, 2000);
  ytPipVideo.srcObject = canvas.captureStream(8);
  ytPipVideo.dataset.vid = state.videoId;
  ytPipVideo.dataset.kind = 'canvas';
  await ytPipVideo.play().catch(() => {});
}

function syncPipVideoTime(state) {
  if (!ytPipVideo || !state) return;
  const t = typeof state.currentTime === 'number' ? state.currentTime : 0;
  if (t > 1 && ytPipVideo.readyState >= 1) {
    try {
      if (Math.abs((ytPipVideo.currentTime || 0) - t) > 2) ytPipVideo.currentTime = t;
    } catch (e) {}
  }
}

async function prepareMobilePipVideo(state) {
  if (!ytPipVideo || !state || !state.videoId || isElectronShell() || !isMobilePipClient()) return;
  try {
    ytPipVideo.setAttribute('playsinline', 'true');
    ytPipVideo.setAttribute('webkit-playsinline', 'true');
    ytPipVideo.playsInline = true;
    ytPipVideo.disablePictureInPicture = false;
    ytPipVideo.muted = !document.hidden;
    ytPipVideo.loop = false;
    ytPipVideo.poster = 'https://i.ytimg.com/vi/' + encodeURIComponent(state.videoId) + '/hqdefault.jpg';
    const alreadyLive = ytPipVideo.dataset.vid === state.videoId
      && ytPipVideo.dataset.kind === 'stream'
      && ytPipVideo.src
      && ytPipVideo.src.indexOf('stream-video') !== -1
      && !ytPipVideo.paused
      && ytPipVideo.readyState >= 2;
    if (alreadyLive) {
      syncPipVideoTime(state);
      return;
    }
    resetPipMediaSource();
    ytPipVideo.src = ytVideoStreamUrl(state.videoId);
    ytPipVideo.dataset.vid = state.videoId;
    ytPipVideo.dataset.kind = 'stream';
    const waitReady = new Promise((resolve) => {
      const done = () => {
        ytPipVideo.removeEventListener('loadeddata', done);
        ytPipVideo.removeEventListener('error', fail);
        resolve(true);
      };
      const fail = () => {
        ytPipVideo.removeEventListener('loadeddata', done);
        ytPipVideo.removeEventListener('error', fail);
        resolve(false);
      };
      if (ytPipVideo.readyState >= 2) return resolve(true);
      ytPipVideo.addEventListener('loadeddata', done);
      ytPipVideo.addEventListener('error', fail);
      setTimeout(() => resolve(ytPipVideo.readyState >= 2), 4000);
    });
    const ok = await waitReady;
    if (!ok) {
      await fallbackPipCanvas(state);
      return;
    }
    syncPipVideoTime(state);
    await ytPipVideo.play().catch(() => {});
  } catch (e) {
    await fallbackPipCanvas(state);
  }
}

function armPipAudioForBackground() {
  if (!ytPipVideo) return;
  const isPipActive = !!(document.pictureInPictureElement === ytPipVideo || (ytPipVideo.webkitPresentationMode === 'picture-in-picture'));
  if (isPipActive) {
    ytPipVideo.muted = false;
    if (ytNotifyAudio && !ytNotifyAudio.paused) {
      try { ytNotifyAudio.pause(); } catch (e) {}
    }
  }
  postYoutubeCommand('mute');
}

async function enterMobilePictureInPicture() {
  if (!ytPipVideo || isElectronShell()) return false;
  if (lastYoutubeState) {
    await prepareMobilePipVideo(lastYoutubeState);
    syncPipVideoTime(lastYoutubeState);
  }
  try {
    if (ytPipVideo.paused) await ytPipVideo.play().catch(() => {});
  } catch (e) {}
  armPipAudioForBackground();
  try {
    if (document.pictureInPictureEnabled && !document.pictureInPictureElement) {
      await ytPipVideo.requestPictureInPicture();
      return true;
    }
    if (document.pictureInPictureElement === ytPipVideo) return true;
  } catch (e) {}
  try {
    if (ytPipVideo.webkitSupportsPresentationMode && typeof ytPipVideo.webkitSetPresentationMode === 'function') {
      if (ytPipVideo.webkitPresentationMode !== 'picture-in-picture') {
        ytPipVideo.webkitSetPresentationMode('picture-in-picture');
        return true;
      }
      return true;
    }
  } catch (e) {}
  return false;
}

async function exitMobilePictureInPicture() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
  } catch (e) {}
  try {
    if (ytPipVideo && ytPipVideo.webkitSupportsPresentationMode && ytPipVideo.webkitPresentationMode === 'picture-in-picture') {
      ytPipVideo.webkitSetPresentationMode('inline');
    }
  } catch (e) {}
}

function unlockYtNotifyAudio() {
  if (!ytNotifyAudio || ytNotifyUnlocked) return;
  try {
    ytNotifyAudio.setAttribute('playsinline', 'true');
    ytNotifyAudio.playsInline = true;
    if (!ytNotifyAudio.src) ytNotifyAudio.src = YT_SILENT_WAV;
    ytNotifyAudio.muted = true;
    ytNotifyAudio.loop = true;
    ytNotifyAudio.play().then(() => { ytNotifyUnlocked = true; }).catch(() => {});
  } catch (e) {}
}

function postYoutubeCommand(action, value) {
  const payload = { type: 'papaleguas-yt-control', action: action, value: value };
  document.querySelectorAll('iframe').forEach((fr) => {
    // Páginas guardadas no histórico ficam ocultas e não devem reagir.
    if (fr.classList.contains('web-client-frame') && !fr.classList.contains('is-visible')) return;
    try {
      if (fr.contentWindow) fr.contentWindow.postMessage(payload, '*');
    } catch (e) {}
  });
  (tabs || []).forEach((tab) => {
    const wv = tab && tab.webview;
    if (!wv) return;
    try {
      if (wv.contentWindow) wv.contentWindow.postMessage(payload, '*');
    } catch (e) {}
    try {
      if (typeof wv.executeJavaScript === 'function') {
        wv.executeJavaScript('window.postMessage(' + JSON.stringify(payload) + ', "*")').catch(() => {});
      }
    } catch (e) {}
  });
}

function syncParentYtMediaSessionPosition(pos, dur) {
  if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
  try {
    const cur = typeof pos === 'number' && isFinite(pos) ? pos : ((lastYoutubeState && lastYoutubeState.currentTime) || (ytNotifyAudio ? ytNotifyAudio.currentTime : 0) || 0);
    const total = typeof dur === 'number' && isFinite(dur) && dur > 0 ? dur : ((lastYoutubeState && lastYoutubeState.duration) || (ytNotifyAudio ? ytNotifyAudio.duration : 0) || 0);
    if (total > 0 && cur >= 0 && cur <= total) {
      navigator.mediaSession.setPositionState({
        duration: total,
        playbackRate: 1,
        position: cur
      });
    }
  } catch (e) {}
}

function setupParentYtMediaSession(state) {
  if (!('mediaSession' in navigator) || !state || !state.videoId) return;
  try {
    const id = state.videoId;
    const thumb = 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/hqdefault.jpg';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.title || 'BaixaTube',
      artist: state.channel || 'Papaléguas BaixaTube',
      album: 'Papaléguas Navegador',
      artwork: [
        { src: thumb, sizes: '480x360', type: 'image/jpeg' },
        { src: 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/mqdefault.jpg', sizes: '320x180', type: 'image/jpeg' },
        { src: 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/maxresdefault.jpg', sizes: '1280x720', type: 'image/jpeg' }
      ]
    });
    navigator.mediaSession.playbackState = state.isPlaying === false ? 'paused' : 'playing';
    navigator.mediaSession.setActionHandler('play', () => {
      if (lastYoutubeState) lastYoutubeState.isPlaying = true;
      if (ytPipVideo) ytPipVideo.play().catch(() => {});
      if (ytNotifyAudio && (!ytPipVideo || ytPipVideo.dataset.kind !== 'stream')) {
        ytNotifyAudio.muted = false;
        ytNotifyAudio.play().catch(() => {});
      }
      postYoutubeCommand('play');
      navigator.mediaSession.playbackState = 'playing';
      updateGlobalYtMiniUI();
      requestAppWakeLock();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (lastYoutubeState) lastYoutubeState.isPlaying = false;
      if (ytPipVideo) ytPipVideo.pause();
      if (ytNotifyAudio) ytNotifyAudio.pause();
      postYoutubeCommand('pause');
      navigator.mediaSession.playbackState = 'paused';
      updateGlobalYtMiniUI();
      releaseAppWakeLock();
    });
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', async () => {
        await enterMobilePictureInPicture();
      });
    } catch (e) {}
    navigator.mediaSession.setActionHandler('previoustrack', () => postYoutubeCommand('prev'));
    navigator.mediaSession.setActionHandler('nexttrack', () => postYoutubeCommand('next'));
    navigator.mediaSession.setActionHandler('stop', () => {
      if (lastYoutubeState) lastYoutubeState.isPlaying = false;
      if (ytNotifyAudio) {
        ytNotifyAudio.pause();
        ytNotifyAudio.removeAttribute('src');
        ytNotifyAudio.load();
      }
      postYoutubeCommand('pause');
      navigator.mediaSession.playbackState = 'none';
      updateGlobalYtMiniUI();
      releaseAppWakeLock();
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details && typeof details.seekTime === 'number' && isFinite(details.seekTime)) {
        postYoutubeCommand('seek', details.seekTime);
        if (lastYoutubeState) lastYoutubeState.currentTime = details.seekTime;
        if (ytNotifyAudio && ytNotifyAudio.readyState >= 1) {
          try { ytNotifyAudio.currentTime = details.seekTime; } catch (e) {}
        }
        syncParentYtMediaSessionPosition(details.seekTime, lastYoutubeState && lastYoutubeState.duration);
      }
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      const skip = (details && details.seekOffset) || 10;
      const cur = (lastYoutubeState && lastYoutubeState.currentTime) || (ytNotifyAudio ? ytNotifyAudio.currentTime : 0) || 0;
      const target = cur + skip;
      postYoutubeCommand('seek', target);
      if (lastYoutubeState) lastYoutubeState.currentTime = target;
      if (ytNotifyAudio && ytNotifyAudio.readyState >= 1) {
        try { ytNotifyAudio.currentTime = target; } catch (e) {}
      }
      syncParentYtMediaSessionPosition(target, lastYoutubeState && lastYoutubeState.duration);
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      const skip = (details && details.seekOffset) || 10;
      const cur = (lastYoutubeState && lastYoutubeState.currentTime) || (ytNotifyAudio ? ytNotifyAudio.currentTime : 0) || 0;
      const target = Math.max(0, cur - skip);
      postYoutubeCommand('seek', target);
      if (lastYoutubeState) lastYoutubeState.currentTime = target;
      if (ytNotifyAudio && ytNotifyAudio.readyState >= 1) {
        try { ytNotifyAudio.currentTime = target; } catch (e) {}
      }
      syncParentYtMediaSessionPosition(target, lastYoutubeState && lastYoutubeState.duration);
    });
    syncParentYtMediaSessionPosition(state.currentTime, state.duration);
  } catch (e) {}
}

function startParentYtAudio(state, opts) {
  if (!ytNotifyAudio || !state || !state.videoId || isElectronShell()) return;
  const unmute = !!(opts && opts.unmute);
  const id = state.videoId;
  ytNotifyAudio.setAttribute('playsinline', 'true');
  ytNotifyAudio.playsInline = true;
  ytNotifyAudio.loop = false;
  if (ytNotifyAudio.dataset.vid !== id || !ytNotifyAudio.src || ytNotifyAudio.src.indexOf('stream-audio') === -1) {
    ytNotifyAudio.dataset.vid = id;
    ytNotifyAudio.src = ytNotifyStreamUrl(id);
  }
  ytNotifyAudio.muted = !unmute;
  const t = typeof state.currentTime === 'number' ? state.currentTime : 0;
  const playp = ytNotifyAudio.play();
  if (playp && typeof playp.then === 'function') {
    playp.then(() => {
      if (t > 1 && ytNotifyAudio.readyState >= 1) {
        try { ytNotifyAudio.currentTime = t; } catch (e) {}
      }
      if (unmute) postYoutubeCommand('mute');
    }).catch(() => {
      ytNotifyAudio.muted = false;
      ytNotifyAudio.play().catch(() => {});
    });
  }
  setupParentYtMediaSession(Object.assign({}, state, { isPlaying: true }));
  prepareMobilePipVideo(state);
}

function updateGlobalYtMiniUI() {
  if (globalYtMiniPlayer) globalYtMiniPlayer.classList.add('hidden');
}

function syncParentYoutubeKeepalive(forceUnmute) {
  const state = lastYoutubeState;
  updateGlobalYtMiniUI();
  if (!state || !state.videoId || isElectronShell()) return;
  if (state.isPlaying === false) {
    if (ytNotifyAudio && !ytNotifyAudio.paused) ytNotifyAudio.pause();
    setupParentYtMediaSession(state);
    return;
  }
  const unmute = !!forceUnmute || document.hidden;
  startParentYtAudio(state, { unmute: unmute });
}

function updateGlobalYoutubeState(state) {
  if (!state || !state.videoId) {
    if (state && state.isPlaying === false && typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(false);
    if (state && state.isPlaying === false && lastYoutubeState && lastYoutubeState.videoId === state.videoId) {
      lastYoutubeState = Object.assign({}, lastYoutubeState, { isPlaying: false });
      syncParentYoutubeKeepalive(false);
      return;
    }
    lastYoutubeState = state && state.videoId ? state : lastYoutubeState;
    return;
  }
  if (!lastYoutubeState || lastYoutubeState.videoId !== state.videoId) {
    userDismissedYtMini = false;
  }
  lastYoutubeState = {
    videoId: state.videoId,
    title: state.title || lastYoutubeState && lastYoutubeState.title || 'BaixaTube',
    channel: state.channel || '',
    isPlaying: !!state.isPlaying,
    currentTime: typeof state.currentTime === 'number' ? state.currentTime : (lastYoutubeState && lastYoutubeState.currentTime) || 0,
    duration: typeof state.duration === 'number' ? state.duration : (lastYoutubeState && lastYoutubeState.duration) || 0
  };
  if (state.isPlaying) {
    if (!document.hidden) requestAppWakeLock();
  } else {
    releaseAppWakeLock();
  }
  syncParentYtMediaSessionPosition(lastYoutubeState.currentTime, lastYoutubeState.duration);
  // Vídeo tocando no BaixaTube: botão Home sai da frente; pausou/fechou: volta.
  if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(!!state.isPlaying);
  syncParentYoutubeKeepalive(false);
}

window.papaleguasStartYtNotify = function (state) {
  updateGlobalYoutubeState(state);
};
window.papaleguasEnterYtPip = function () {
  return enterMobilePictureInPicture();
};

function isAppFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement || document.msFullscreenElement);
}

function onAppFullscreenChange() {
  if (isAppFullscreen()) {
    appVideoFullscreen = true;
    if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(true);
    document.documentElement.classList.add('video-true-fs');
    document.body.classList.add('video-true-fs');
    return;
  }
  if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(false);
  document.documentElement.classList.remove('video-true-fs');
  document.body.classList.remove('video-true-fs');
  if (!appVideoFullscreen) return;
  appVideoFullscreen = false;
  const tabUrl = (getActiveTab() && getActiveTab().url) || '';
  if (/\/musica|musica\.html|\/filmes/i.test(tabUrl)) return;
  if (!lastYoutubeState || !lastYoutubeState.videoId) return;
  postYoutubeCommand('enter-mini');
}
['fullscreenchange', 'webkitfullscreenchange', 'MSFullscreenChange'].forEach((evName) => {
  document.addEventListener(evName, onAppFullscreenChange);
});

['touchstart', 'pointerdown', 'click'].forEach((evName) => {
  window.addEventListener(evName, unlockYtNotifyAudio, { once: true, capture: true, passive: true });
});

function leaveBrowserToOsPip() {
  if (!lastYoutubeState || !lastYoutubeState.videoId || lastYoutubeState.isPlaying === false) return;
  if (!isMobilePipClient()) return;
  prepareMobilePipVideo(lastYoutubeState).then(() => enterMobilePictureInPicture()).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  const isHidden = document.hidden;
  document.querySelectorAll('iframe').forEach(iframe => {
    try {
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'parent-visibility-change', hidden: isHidden }, '*');
      }
    } catch(e) {}
  });

  if (!lastYoutubeState || !lastYoutubeState.videoId) return;
  if (document.hidden) {
    releaseAppWakeLock();
    if (isMobilePipClient() && lastYoutubeState.isPlaying) {
      if (ytNotifyAudio) {
        ytNotifyAudio.muted = false;
        if (ytNotifyAudio.paused) ytNotifyAudio.play().catch(() => {});
      }
      postYoutubeCommand('mute');
      leaveBrowserToOsPip();
    }
  } else {
    if (lastYoutubeState.isPlaying) requestAppWakeLock();
    if (isMobilePipClient()) {
      const isPipActive = ytPipVideo && (document.pictureInPictureElement === ytPipVideo || ytPipVideo.webkitPresentationMode === 'picture-in-picture');
      if (!isPipActive) {
        if (ytPipVideo) ytPipVideo.muted = true;
        if (ytNotifyAudio && ytNotifyAudio.src && ytNotifyAudio.src.indexOf('stream-audio') !== -1) {
          ytNotifyAudio.muted = true;
        }
        postYoutubeCommand('unmute');
      }
    }
  }
  updateGlobalYtMiniUI();
});

window.addEventListener('pagehide', leaveBrowserToOsPip);
window.addEventListener('freeze', leaveBrowserToOsPip);

if (ytPipVideo) {
  ytPipVideo.addEventListener('enterpictureinpicture', () => {
    armPipAudioForBackground();
  });
  ytPipVideo.addEventListener('leavepictureinpicture', () => {
    if (!document.hidden && ytPipVideo) ytPipVideo.muted = true;
  });
  ytPipVideo.addEventListener('ended', () => {
    postYoutubeCommand('next');
  });
}

if (gytBtnPlay) {
  gytBtnPlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!lastYoutubeState) return;
    if (lastYoutubeState.isPlaying) {
      lastYoutubeState.isPlaying = false;
      if (ytNotifyAudio) ytNotifyAudio.pause();
      postYoutubeCommand('pause');
    } else {
      lastYoutubeState.isPlaying = true;
      startParentYtAudio(lastYoutubeState, { unmute: true });
      postYoutubeCommand('play');
    }
    updateGlobalYtMiniUI();
  });
}
if (gytBtnExpand) {
  gytBtnExpand.addEventListener('click', (e) => {
    e.stopPropagation();
    const ytTab = (tabs || []).find((t) => t.url && /youtube|newtab\.html/i.test(t.url));
    if (ytTab && typeof activateTab === 'function') activateTab(ytTab.id);
  });
}
if (gytBtnClose) {
  gytBtnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    userDismissedYtMini = true;
    if (ytNotifyAudio) ytNotifyAudio.pause();
    postYoutubeCommand('pause');
    if (globalYtMiniPlayer) globalYtMiniPlayer.classList.add('hidden');
  });
}

async function collectYoutubePlaybackState() {
  let best = lastYoutubeState;
  for (const tab of tabs) {
    const wv = tab && tab.webview;
    if (!wv || typeof wv.executeJavaScript !== 'function') continue;
    try {
      const st = await wv.executeJavaScript(`(function(){
        var id = window.currentActiveVideoId || window.currentCinemaVid || '';
        var paused = window.userExplicitlyPaused === true;
        var playing = false;
        if (typeof window.ytIsPlaying === 'boolean') playing = window.ytIsPlaying;
        else if (typeof isCurrentlyPlaying === 'boolean') playing = isCurrentlyPlaying;
        else playing = !!id && !paused;
        var title = window.currentActiveTitle || '';
        var t = 0;
        if (typeof window.ytCurTime === 'number') t = window.ytCurTime;
        else if (typeof ytCurrentTime === 'number') t = ytCurrentTime;
        return { videoId: id, title: title, isPlaying: !!(id && (playing || !paused)), currentTime: t || 0 };
      })()`);
      if (st && st.videoId) {
        if (st.isPlaying) return st;
        if (!best || !best.videoId) best = st;
      }
    } catch (e) {}
  }
  return best;
}

if (window.torBrowserAPI && typeof window.torBrowserAPI.onQueryYoutubePip === 'function') {
  window.torBrowserAPI.onQueryYoutubePip(async () => {
    const state = await collectYoutubePlaybackState();
    const show = state && state.videoId;
    if (window.torBrowserAPI.offerYoutubePip) {
      window.torBrowserAPI.offerYoutubePip(show ? Object.assign({}, state, { isPlaying: true }) : { isPlaying: false });
    }
  });
}

// Controles de Transmissão (Cast para Smart TVs)
const btnCast = document.getElementById('btn-cast');
const castModal = document.getElementById('cast-modal');
const closeCastModalBtn = document.getElementById('close-cast-modal-btn');
const castDevicesList = document.getElementById('cast-devices-list');
const btnRefreshCast = document.getElementById('btn-refresh-cast');
const castFeedback = document.getElementById('cast-feedback');

async function detectCurrentMediaToCast() {
  const mediaTitleEl = document.getElementById('cast-media-title');
  const mediaUrlEl = document.getElementById('cast-media-url');

  let media = {
    url: '',
    title: 'Vídeo em reprodução'
  };

  // 1. Verifica se tem música no Papaléguas Music
  const spMiniTitle = document.getElementById('sp-mini-title');
  const spMiniArtist = document.getElementById('sp-mini-artist');
  const spAudio = document.getElementById('spotify-preview-audio');
  if (spAudio && !spAudio.paused && spAudio.src) {
    media.url = spAudio.src;
    media.title = `🎵 ${spMiniTitle ? spMiniTitle.textContent : 'Música'} - ${spMiniArtist ? spMiniArtist.textContent : ''}`;
  }

  // 2. Se não, inspeciona a aba ativa do navegador
  const activeTab = getActiveTab();
  if (activeTab && activeTab.webview) {
    let tabUrl = '';
    let tabTitle = activeTab.title || 'Aba Ativa';
    try {
      if (typeof activeTab.webview.getURL === 'function') {
        tabUrl = activeTab.webview.getURL();
      }
      if (typeof activeTab.webview.getTitle === 'function') {
        tabTitle = activeTab.webview.getTitle() || tabTitle;
      }
    } catch (e) {}

    if (!tabUrl && activeTab.url) tabUrl = activeTab.url;

    // Tenta inspecionar elementos <video> dentro do webview
    try {
      if (typeof activeTab.webview.executeJavaScript === 'function') {
        const videoInfo = await activeTab.webview.executeJavaScript(`
          (() => {
            // 1) Player do YouTube embutido (Filmes Online / BaixaTube / home)
            const yt = document.querySelector('#cinema-iframe, iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]');
            if (yt && yt.src) {
              const m = String(yt.src).match(/embed\\/([a-zA-Z0-9_-]{11})/);
              if (m) {
                const titleEl = document.getElementById('active-title') || document.querySelector('.cinema-title, .video-title, h1');
                return {
                  src: 'https://www.youtube.com/watch?v=' + m[1],
                  youtubeId: m[1],
                  paused: false,
                  title: (titleEl && titleEl.textContent ? titleEl.textContent.replace('▶', '').trim() : '') || document.title || ''
                };
              }
            }
            // 2) Vídeo HTML5 direto na página
            const v = document.querySelector('video');
            if (v) {
              return {
                src: v.currentSrc || v.src || '',
                paused: v.paused,
                title: document.title || ''
              };
            }
            return null;
          })()
        `).catch(() => null);

        if (videoInfo && videoInfo.youtubeId) {
          media.url = videoInfo.src;
          media.title = `🎬 ${videoInfo.title || tabTitle}`;
        } else if (videoInfo && videoInfo.src && !videoInfo.src.startsWith('blob:')) {
          media.url = videoInfo.src;
          media.title = `🎬 ${videoInfo.title || tabTitle}`;
        }
      }
    } catch (e) {}

    if (!media.url && tabUrl && !tabUrl.includes('newtab.html')) {
      media.url = tabUrl;
      media.title = `🌐 ${tabTitle}`;
    }
  }

  if (urlInput && urlInput.value && !media.url) {
    media.url = urlInput.value;
  }

  if (mediaTitleEl && mediaUrlEl) {
    if (media.url) {
      mediaTitleEl.textContent = media.title || 'Vídeo pronto para transmitir';
      mediaUrlEl.textContent = media.url;
    } else {
      mediaTitleEl.textContent = 'Nenhum vídeo em reprodução';
      mediaUrlEl.textContent = 'Abra um filme, BaixaTube ou vídeo no navegador';
    }
  }

  return media;
}

async function loadCastDevices() {
  if (!castDevicesList) return;
  if (castFeedback) castFeedback.classList.add('hidden');

  const showScanning = () => {
    castDevicesList.innerHTML = '<div class="scanning-text"><span class="cast-inline-spinner"></span> Procurando Smart TVs no Wi-Fi deste aparelho...</div>';
  };
  if (cachedCastDevices.length > 0) {
    renderCastDeviceList(cachedCastDevices, true);
  } else {
    showScanning();
  }

  detectCurrentMediaToCast();

  try {
    // Cada TV aparece na hora em que é encontrada; a mensagem "nenhuma" só sai
    // quando a varredura termina de verdade (nunca por timeout no meio da busca).
    const devices = await prefetchCastDevices((dev) => {
      renderCastDeviceList(cachedCastDevices, true);
    });
    renderCastDeviceList(devices, false);
  } catch (err) {
    if (cachedCastDevices.length === 0) {
      castDevicesList.innerHTML = `<div class="scanning-text">Erro ao buscar dispositivos: ${err.message}</div>`;
    }
  }
}

let castConnectingDeviceId = '';

function renderCastDeviceList(devices, stillScanning) {
  if (!castDevicesList) return;
  if (!devices || !Array.isArray(devices) || devices.length === 0) {
    castDevicesList.innerHTML = stillScanning
      ? '<div class="scanning-text"><span class="cast-inline-spinner"></span> Procurando Smart TVs no Wi-Fi deste aparelho...</div>'
      : '<div class="scanning-text">Nenhuma Smart TV detectada no Wi-Fi deste aparelho.<br>Verifique se a TV está ligada na sua rede, não na do servidor.</div>';
    return;
  }

  castDevicesList.innerHTML = '';
  devices.forEach(dev => {
    const item = document.createElement('div');
    const isConnecting = castConnectingDeviceId && castConnectingDeviceId === dev.id;
    item.className = 'device-item' + (isConnecting ? ' is-connecting' : '');
    const typeLabel = (dev.type || 'tv').toString().toUpperCase();
    item.innerHTML = `
      <div class="device-item-info">
        <span class="device-item-name">${dev.name || 'Smart TV'}</span>
        <span class="device-item-type">${isConnecting ? 'Conectando ao dispositivo…' : `IP: ${dev.ip || '—'} (${typeLabel})`}</span>
      </div>
      <button class="device-cast-action-btn${isConnecting ? ' is-busy' : ''}" data-id="${dev.id}" ${isConnecting ? 'disabled' : ''}>${isConnecting ? 'Conectando…' : 'Transmitir'}</button>
    `;

    const castBtn = item.querySelector('.device-cast-action-btn');
    castBtn.addEventListener('click', async () => {
      if (castConnectingDeviceId) return;
      castConnectingDeviceId = dev.id;
      castBtn.textContent = 'Conectando…';
      castBtn.classList.add('is-busy');
      castBtn.disabled = true;
      item.classList.add('is-connecting');
      const typeEl = item.querySelector('.device-item-type');
      if (typeEl) typeEl.textContent = 'Conectando ao dispositivo…';

      const agentBadge = document.getElementById('cast-agent-badge');
      const agentStatus = document.getElementById('cast-agent-status-text');
      const agentSteps = document.getElementById('cast-agent-steps');

      if (castFeedback) {
        castFeedback.classList.remove('hidden');
        castFeedback.className = 'cast-feedback connecting';
        castFeedback.innerHTML = `<span class="cast-inline-spinner"></span> Conectando ao dispositivo ${dev.name || dev.ip || ''}… abrindo o YouTube na TV.`;
      }

      if (agentBadge) agentBadge.textContent = 'Conectando à TV...';
      if (agentStatus) agentStatus.textContent = `Conectando ao dispositivo ${dev.name}. O Agente está inspecionando o vídeo e preparando a rota...`;
      if (agentSteps) {
        agentSteps.innerHTML = `
          <div class="cast-agent-step active"><span>🔍</span> Extraindo identificador do filme e link do servidor...</div>
        `;
      }

      let res = { success: false };
      try {
        const mediaToCast = await detectCurrentMediaToCast();
        const targetUrl = mediaToCast.url || (getActiveTab() ? getActiveTab().url : '');
        const targetTitle = mediaToCast.title || '';
        const clientIp = window.PapaleguasClientCast ? window.PapaleguasClientCast.extractIp(dev.id || dev.ip) : (dev.ip || '');

        if (agentSteps) {
          agentSteps.innerHTML += `
            <div class="cast-agent-step active"><span>📡</span> Enviando do seu aparelho para a TV no seu Wi-Fi (${dev.name})...</div>
          `;
        }

        if (window.PapaleguasClientCast && clientIp) {
          res = await window.PapaleguasClientCast.launchRoku(clientIp, targetUrl, targetTitle);
        } else if (window.torBrowserAPI && window.torBrowserAPI.castToDevice) {
          res = await window.torBrowserAPI.castToDevice(dev.id, targetUrl, targetTitle);
        }
      } catch (e) {
        res = { success: false, error: e && e.message };
      }
      res = res || { success: false };

      castConnectingDeviceId = '';
      castBtn.textContent = 'Transmitir';
      castBtn.classList.remove('is-busy');
      castBtn.disabled = false;
      item.classList.remove('is-connecting');
      if (typeEl) typeEl.textContent = `IP: ${dev.ip || '—'} (${typeLabel})`;

      if (res.success) {
        window.activeCastDevice = dev;
        castBtn.textContent = 'Transmitindo ✓';
        if (agentBadge) agentBadge.textContent = 'Transmissão Ativa';
        if (agentStatus) agentStatus.textContent = 'Sucesso! O Agente encontrou a melhor rota e iniciou a reprodução diretamente na sua Smart TV.';
        if (agentSteps) {
          agentSteps.innerHTML += `
            <div class="cast-agent-step success"><span>✅</span> Aplicativo oficial acionado e filme sincronizado na TV!</div>
          `;
        }
      } else {
        if (agentBadge) agentBadge.textContent = 'Atenção Necessária';
        if (agentStatus) agentStatus.textContent = res.error || 'Não foi possível completar a conexão automática com a TV.';
        if (agentSteps) {
          agentSteps.innerHTML += `
            <div class="cast-agent-step" style="color:#ff3366"><span>⚠️</span> Dica: Verifique se o controle de rede móvel da TV está em Permitido/Habilitado.</div>
          `;
        }
      }

      if (castFeedback) {
        castFeedback.classList.remove('hidden');
        if (res.success) {
          castFeedback.className = 'cast-feedback';
          castFeedback.textContent = res.message || `Transmitindo para ${dev.name}!`;
        } else {
          castFeedback.className = 'cast-feedback error';
          castFeedback.textContent = res.error || 'Erro ao conectar à TV.';
        }
      }
    });

    castDevicesList.appendChild(item);
  });
}

// Quando o usuário troca de música no player do app e há uma TV conectada, atualiza a TV automaticamente
async function syncPlaybackWithConnectedTv(urlOrQuery) {
  if (!window.activeCastDevice) return;
  try {
    const ip = window.PapaleguasClientCast
      ? window.PapaleguasClientCast.extractIp(window.activeCastDevice.id || window.activeCastDevice.ip)
      : (window.activeCastDevice.ip || '');
    if (window.PapaleguasClientCast && ip) {
      const isUrl = /^https?:\/\//i.test(String(urlOrQuery || ''));
      await window.PapaleguasClientCast.launchRoku(ip, urlOrQuery, isUrl ? '' : String(urlOrQuery || ''));
    }
  } catch (e) {
    console.warn('Erro ao sincronizar com TV:', e);
  }
}

if (btnCast) {
  btnCast.addEventListener('click', () => {
    if (castModal) {
      castModal.classList.toggle('hidden');
      if (!castModal.classList.contains('hidden')) {
        loadCastDevices();
      }
    }
  });
}

if (closeCastModalBtn) {
  closeCastModalBtn.addEventListener('click', () => {
    if (castModal) castModal.classList.add('hidden');
  });
}

if (btnRefreshCast) {
  btnRefreshCast.addEventListener('click', () => {
    loadCastDevices();
  });
}

const btnOpenScreenMirror = document.getElementById('btn-open-screen-mirror');
if (btnOpenScreenMirror) {
  btnOpenScreenMirror.addEventListener('click', async () => {
    if (window.torBrowserAPI && window.torBrowserAPI.openScreenMirroring) {
      await window.torBrowserAPI.openScreenMirroring();
    }
  });
}

// ============================================================================
// AGENTE DE VOZ (DJ PAPALÉGUAS IA)
// ============================================================================
const btnMic = document.getElementById('btn-mic');
let isListening = false;
let keepListening = false;
let isSpeaking = false;
const voiceOverlay = document.getElementById('voice-overlay');

// Variáveis do STT via OpenAI Whisper
let audioContext = null;
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let analyser = null;
let silenceTimer = null;
let maxRecordingTimer = null;
let isProcessingVoice = false;

// Acorda o sistema de áudio imediatamente no clique (exigência de segurança do Chrome)
function wakeUpAudioSystem() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(e => console.error("Falha ao acordar áudio:", e));
  }
}

// Função utilitária para finalizar e despachar a gravação para a IA
function finishRecordingAndSend() {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (maxRecordingTimer) {
    clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
  }
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    // Exibe status de processamento imediatamente
    const overlayText = document.getElementById('voice-overlay-text');
    const overlaySub = document.getElementById('voice-overlay-sub');
    const volHint = document.getElementById('voice-volume-hint');
    if (overlayText) overlayText.innerText = "Processando com IA...";
    if (overlaySub) overlaySub.innerText = "Transcrevendo seu áudio com OpenAI Whisper...";
    if (volHint) volHint.innerText = "Aguarde um momento...";
    
    mediaRecorder.stop();
  }
}

// Configura os botões manuais do overlay
const btnVoiceFinish = document.getElementById('btn-voice-finish');
if (btnVoiceFinish) {
  btnVoiceFinish.addEventListener('click', () => {
    finishRecordingAndSend();
  });
}

const btnVoiceCancel = document.getElementById('btn-voice-cancel');
if (btnVoiceCancel) {
  btnVoiceCancel.addEventListener('click', () => {
    isListening = false;
    keepListening = false;
    if (silenceTimer) clearTimeout(silenceTimer);
    if (maxRecordingTimer) clearTimeout(maxRecordingTimer);
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.onstop = null; // descarta o envio
      mediaRecorder.stop();
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    if (btnMic) btnMic.classList.remove('listening');
    if (voiceOverlay) voiceOverlay.style.display = 'none';
  });
}

function useNativeSpeechRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    alert("Reconhecimento de voz não suportado neste navegador móvel.");
    return;
  }
  
  const rec = new SpeechRec();
  rec.lang = 'pt-BR';
  rec.continuous = false;
  rec.interimResults = false;

  isListening = true;
  if (btnMic) btnMic.classList.add('listening');
  if (voiceOverlay) {
    document.getElementById('voice-overlay-text').innerText = "Estou te ouvindo...";
    const sub = document.getElementById('voice-overlay-sub');
    if (sub) sub.innerText = "Pode falar seu comando...";
    const hint = document.getElementById('voice-volume-hint');
    if (hint) hint.innerText = "Modo celular ativo 🎙️";
    const bar = document.getElementById('voice-meter-bar');
    if (bar) bar.style.width = '80%';
    voiceOverlay.style.display = 'flex';
  }

  rec.onresult = (e) => {
    isListening = false;
    if (btnMic) btnMic.classList.remove('listening');
    if (voiceOverlay) voiceOverlay.style.display = 'none';
    if (e.results && e.results[0] && e.results[0][0]) {
      const text = e.results[0][0].transcript;
      console.log("[Voz Nativa Mobile]:", text);
      handleVoiceCommand(text);
    }
  };

  rec.onerror = (e) => {
    console.error("Erro na voz nativa mobile:", e);
    isListening = false;
    if (btnMic) btnMic.classList.remove('listening');
    if (voiceOverlay) voiceOverlay.style.display = 'none';
  };

  rec.onend = () => {
    isListening = false;
    if (btnMic) btnMic.classList.remove('listening');
    if (voiceOverlay) voiceOverlay.style.display = 'none';
  };

  try {
    rec.start();
  } catch(e) {
    console.error("Falha ao iniciar SpeechRecognition:", e);
    isListening = false;
    if (btnMic) btnMic.classList.remove('listening');
    if (voiceOverlay) voiceOverlay.style.display = 'none';
  }
}

// Objeto simulado para manter compatibilidade com o resto do código
const recognition = {
  start: async () => {
    if (isListening) return;
    
    wakeUpAudioSystem();

    // Se estiver em navegador móvel onde getUserMedia é bloqueado em HTTP
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (window.SpeechRecognition || window.webkitSpeechRecognition) {
        useNativeSpeechRecognition();
        return;
      }
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: false, // evita cortar voz baixa
          autoGainControl: true
        }, 
        video: false 
      });
      
      const source = audioContext.createMediaStreamSource(mediaStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });
      audioChunks = [];

      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        isListening = false;
        if (btnMic) btnMic.classList.remove('listening');
        if (mediaStream) {
          mediaStream.getTracks().forEach(t => t.stop());
          mediaStream = null;
        }

        if (audioChunks.length === 0) {
          if (voiceOverlay) voiceOverlay.style.display = 'none';
          return;
        }
        
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        console.log("[AudioBlob Size]:", audioBlob.size, "bytes");

        if (audioBlob.size < 1200) {
          if (voiceOverlay) voiceOverlay.style.display = 'none';
          speakText("O áudio captado foi muito curto. Tente falar novamente.");
          return;
        }

        try {
          const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
          const baseUrl = isElectron ? 'http://localhost:8080' : '';
          
          const response = await fetch(baseUrl + '/api/whisper', {
            method: 'POST',
            body: audioBlob
          });
          const result = await response.json();
          
          if (result && result.text && result.text.trim().length > 0) {
            console.log("Comando Whisper Reconhecido:", result.text);
            if (voiceOverlay) voiceOverlay.style.display = 'none';
            handleVoiceCommand(result.text.toLowerCase().trim());
          } else if (result && result.error) {
            console.error("Erro da OpenAI:", result.error);
            if (voiceOverlay) voiceOverlay.style.display = 'none';
            speakText("Houve uma falha ao transcrever sua voz.");
          } else {
            console.warn("Nenhuma voz compreensível detectada.");
            if (voiceOverlay) voiceOverlay.style.display = 'none';
            speakText("Não consegui ouvir sua voz com clareza. Fale mais próximo ao microfone.");
          }
        } catch (e) {
          console.error("Whisper Request Error:", e);
          if (voiceOverlay) voiceOverlay.style.display = 'none';
          speakText("Erro ao conectar com a inteligência de voz.");
        }
      };

      mediaRecorder.start(100); // Grava pedaços a cada 100ms
      isListening = true;
      
      if (btnMic) btnMic.classList.add('listening');
      if (voiceOverlay) {
        document.getElementById('voice-overlay-text').innerText = "Estou te ouvindo...";
        const sub = document.getElementById('voice-overlay-sub');
        if (sub) sub.innerText = "Pode falar seu comando. Pararei ao detectar silêncio.";
        const hint = document.getElementById('voice-volume-hint');
        if (hint) hint.innerText = "Aguardando você falar...";
        const bar = document.getElementById('voice-meter-bar');
        if (bar) bar.style.width = '0%';
        voiceOverlay.style.display = 'flex';
      }

      // Detector de Silêncio e Medidor de Volume em Tempo Real
      let hasSpoken = false;
      const meterBar = document.getElementById('voice-meter-bar');
      const volHint = document.getElementById('voice-volume-hint');
      
      const checkSilence = () => {
        if (!isListening) return;
        
        const dataArray = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(dataArray);
        
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += Math.abs(dataArray[i] - 128);
        }
        const volume = sum / dataArray.length; // Geralmente varia de 0.2 (silêncio) a 20+ (voz)

        // Atualiza a barra de volume visual em tempo real
        if (meterBar) {
          const pct = Math.min(100, Math.round(volume * 6));
          meterBar.style.width = `${pct}%`;
        }

        // Limiar de detecção de fala humana
        if (volume > 1.8) {
          hasSpoken = true;
          if (volHint) volHint.innerText = `🎤 Voz detectada! [Nível: ${Math.round(volume)}]`;
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
        } else if (hasSpoken) {
          // O usuário já começou a falar e agora fez silêncio
          if (volHint) volHint.innerText = `Silêncio detectado... concluindo comando.`;
          if (!silenceTimer) {
            silenceTimer = setTimeout(() => {
              finishRecordingAndSend();
            }, 1200); // 1.2 segundos de silêncio para cortar
          }
        }
        
        requestAnimationFrame(checkSilence);
      };
      
      checkSilence();

      // Timeout máximo de segurança: 7 segundos
      maxRecordingTimer = setTimeout(() => {
        if (isListening) {
          console.log("Tempo limite de gravação atingido. Concluindo...");
          finishRecordingAndSend();
        }
      }, 7000);
      
    } catch(err) {
      console.warn("Mic Access Error, tentando fallback mobile:", err);
      if (window.SpeechRecognition || window.webkitSpeechRecognition) {
        useNativeSpeechRecognition();
        return;
      }
      alert("Falha no microfone: " + (err.message || err.name || JSON.stringify(err)));
      keepListening = false;
    }
  },
  stop: () => {
    finishRecordingAndSend();
  }
};

// Síntese de voz com garantia de Português Brasileiro (TTS local + fallback nativo pt-BR)
function speakWithNativeSpeechSynthesis(text, onDone) {
  if (!window.speechSynthesis) {
    if (onDone) onDone();
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'pt-BR';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    // Procura expressamente por vozes em português brasileiro no aparelho móvel
    const voices = window.speechSynthesis.getVoices() || [];
    const ptVoice = voices.find(v => v.lang === 'pt-BR' || v.lang === 'pt_BR') ||
                    voices.find(v => v.lang.toLowerCase().startsWith('pt')) || null;
    if (ptVoice) {
      utterance.voice = ptVoice;
    }

    utterance.onend = onDone;
    utterance.onerror = onDone;
    window.speechSynthesis.speak(utterance);
  } catch(e) {
    if (onDone) onDone();
  }
}

let currentAudio = null;
function speakText(text, callback) {
  isSpeaking = true;
  
  // Parar o microfone enquanto fala para não dar eco/escutar a própria voz
  if (isListening && recognition) {
    try { recognition.stop(); } catch(e){}
  }

  if (currentAudio) {
    try { currentAudio.pause(); } catch(e){}
    currentAudio = null;
  }

  let callbackFired = false;
  const finishSpeech = () => {
    if (callbackFired) return;
    callbackFired = true;
    isSpeaking = false;
    if (callback) callback();
  };

  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
  const baseUrl = isElectron ? 'http://localhost:8080' : '';
  const safeText = encodeURIComponent((text || '').substring(0, 200));
  const ttsUrl = `${baseUrl}/api/tts?text=${safeText}`;
  
  currentAudio = new Audio(ttsUrl);
  currentAudio.volume = 1.0;
  
  currentAudio.onended = finishSpeech;
  currentAudio.onerror = () => {
    // Se o áudio falhar no celular, cai no sintetizador nativo forçado em pt-BR
    speakWithNativeSpeechSynthesis(text, finishSpeech);
  };
  
  // Fallback timeout para destravar a interface caso a fala demore
  const estimatedTime = Math.max(2000, (text.length / 8) * 1000) + 1500;
  setTimeout(() => {
    if (!callbackFired) {
      finishSpeech();
    }
  }, estimatedTime);
  
  currentAudio.play().catch(e => {
    // Autoplay bloqueado pelo navegador do celular: usa o sintetizador com voz pt-BR
    speakWithNativeSpeechSynthesis(text, finishSpeech);
  });
}

function handleVoiceCommand(cmd) {
  const cleanCmd = (cmd || '').toLowerCase().trim();
  console.log("[Comando de Voz Recebido]:", cleanCmd);

  // 1. COMANDOS DO YOUTUBE
  if (cleanCmd.includes('youtube') || cleanCmd.includes('you tube') || cleanCmd.includes('iutube') || cleanCmd.includes('baixatube') || cleanCmd.includes('baixa tube')) {
    let ytQuery = cleanCmd;
    if (/(?:no|pelo|na|no site do)\s+(?:you\s*tube|baixa\s*tube)/i.test(ytQuery)) {
      ytQuery = ytQuery.replace(/^.*?(?:pesquisar|pesquise|buscar|busque|procurar|procure|ver|assistir|tocar)\s+(?:por\s+)?/i, '');
      ytQuery = ytQuery.replace(/\s+(?:no|pelo|no site do|na plataforma|no aplicativo)\s+(?:you\s*tube|baixa\s*tube).*$/i, '');
    } else {
      ytQuery = ytQuery
        .replace(/^.*?(?:abrir|abre|acessar|acesse|ir para|ver)?\s*(?:o\s+)?(?:you\s*tube|iutube|baixa\s*tube)\s*(?:e\s+)?(?:pesquisar|pesquise|buscar|busque|procurar|procure)?\s*(?:por\s+)?/i, '')
        .trim();
    }
    ytQuery = ytQuery.replace(/^(?:you\s*tube|iutube|baixa\s*tube)$/i, '').trim();

    if (ytQuery) {
      speakText(`Pesquisando ${ytQuery} no BaixaTube.`, () => {
        openYoutube(ytQuery);
      });
    } else {
      speakText("Abrindo o BaixaTube.", () => {
        openYoutube('');
      });
    }
    return;
  }

  // 2. COMANDOS DE FILMES ONLINE
  if (
    cleanCmd.includes('filme') || cleanCmd.includes('filmes') || 
    cleanCmd.includes('cinema') || cleanCmd.includes('pluto tv') ||
    cleanCmd.startsWith('assistir') || cleanCmd.startsWith('assista')
  ) {
    let movieQuery = cleanCmd;
    if (/(?:em|no|nos)\s+(?:filmes online|filmes|cinema)/i.test(movieQuery)) {
      movieQuery = movieQuery.replace(/^.*?(?:pesquisar|pesquise|buscar|busque|procurar|procure|ver|assistir|assista)\s+(?:por\s+)?/i, '');
      movieQuery = movieQuery.replace(/\s+(?:em|no|nos)\s+(?:filmes online|filmes|cinema).*$/i, '');
    } else {
      movieQuery = movieQuery
        .replace(/^.*?(?:abrir|abre|acessar|acesse|ir para|ver|assistir|assista)\s+(?:o|a|os|as)?\s*/i, '')
        .replace(/^(?:filmes online|filmes|filme|cinema|pluto tv)\s*/i, '')
        .replace(/^(?:pesquisar|pesquise|buscar|busque|procurar|procure)\s+(?:por\s+)?(?:o\s+filme\s+|filme\s+)?/i, '')
        .trim();
    }
    movieQuery = movieQuery.replace(/^(?:filme|filmes|filmes online|online)$/i, '').trim();

    if (movieQuery) {
      speakText(`Buscando ${movieQuery} em Filmes Online.`, () => {
        openFilmesOnline(movieQuery);
      });
    } else {
      speakText("Abrindo Filmes Online.", () => {
        openFilmesOnline('');
      });
    }
    return;
  }

  // 3. COMANDOS DE MÚSICA (DJ PAPALÉGUAS)
  const isMusicCmd = (
    /\b(?:música|musica|músicas|musicas|som|canção|cancao|faixa|faixas)\b/i.test(cleanCmd) ||
    /\b(?:tocar|toca|toque|ouvir|ouve|ouça|bota|bote|solta|solte|reproduzir|reproduza)\b/i.test(cleanCmd) ||
    /\b(?:dj|papaléguas|papaleguas)\b/i.test(cleanCmd) ||
    /\b(?:gospel|louvor|louvores|hinos|sertanejo|pagode|funk|forró|forro|eletrônica|eletronica)\b/i.test(cleanCmd)
  );

  if (isMusicCmd) {
    let songQuery = cleanCmd
      .replace(/^.*?(?:peço para|quero|gostaria de|favor|por favor)\s+/i, '')
      .replace(/^(?:dj papaléguas|dj papaleguas|papaléguas|papaleguas)\s*/i, '')
      .replace(/^(?:tocar|toca|toque|ouvir|ouve|bota|bote|solta|solte|colocar|coloque|reproduzir|reproduza)\s+/i, '')
      .replace(/^(?:uma|um|as|os|a|o)\s+/i, '')
      .replace(/^(?:música|musica|músicas|musicas|som|canção|cancao|faixa)\s+/i, '')
      .replace(/^(?:de|do|da|dos|das)\s+/i, '')
      .replace(/^(?:estilo|gênero|genero)\s+/i, '')
      .replace(/\s+(?:no|pelo|através do|atraves do|com o|no)\s+(?:dj|papaléguas|papaleguas).*$/i, '')
      .trim();

    if (songQuery === 'gospel' || songQuery === 'louvor' || songQuery === 'hinos') {
      songQuery = 'musica gospel';
    } else if (!songQuery || songQuery === 'musica' || songQuery === 'música') {
      songQuery = 'sucessos';
    }

    const falaFeedback = songQuery === 'sucessos' 
      ? "Iniciando os melhores sucessos no DJ Papaléguas." 
      : `Tocando ${songQuery} no DJ Papaléguas.`;

    speakText(falaFeedback, () => {
      openPapaleguasMusic(songQuery, true);
    });
    return;
  }

  // 4. PARAR / FECHAR / CONTROLE
  if (
    /^(?:fechar|feche|parar|pare|silêncio|silencio|cancelar|cancela)$/i.test(cleanCmd) ||
    cleanCmd.includes('fechar aba') || cleanCmd.includes('parar escuta')
  ) {
    speakText("Desligando modo de escuta.");
    keepListening = false;
    if (recognition) recognition.stop();
    return;
  }

  // 5. BUSCA DIRETO NA INTERNET (Qualquer tema fora de YouTube, Filmes e Músicas)
  let searchQuery = cleanCmd
    .replace(/^.*?(?:pesquisar|pesquise|buscar|busque|procurar|procure|consultar|consulte|ver|achar|ache|navegar)\s+(?:por\s+|sobre\s+|na internet\s+|no google\s+|na web\s+)?/i, '')
    .replace(/\s+(?:na internet|no google|na web|no navegador|na rede)$/i, '')
    .trim();

  if (!searchQuery) {
    searchQuery = cleanCmd;
  }

  searchQuery = searchQuery.replace(/^[?.,!\s]+|[?.,!\s]+$/g, '').trim();

  if (searchQuery) {
    const isAiRequest = /(?:resumo|resuma|not[ií]cia|quem [eé]|o que [eé]|como|qual|por que|explique|analise)/i.test(searchQuery);
    const feedbackText = isAiRequest 
      ? `Pesquisando e analisando as informações de ${searchQuery} na internet.`
      : `Pesquisando ${searchQuery} na internet.`;

    speakText(feedbackText, () => {
      openWebSearch(searchQuery, isAiRequest);
    });
  } else {
    speakText("O que você deseja pesquisar na internet?", () => {});
  }
}

if (btnMic) {
  btnMic.addEventListener('click', () => {
    // Acorda o subsistema de áudio no clique
    if (typeof wakeUpAudioSystem === 'function') wakeUpAudioSystem();

    if (isListening && recognition) {
      recognition.stop();
    } else if (recognition) {
      try { 
        recognition.start(); 
      } catch(e) {
        console.error("Erro ao iniciar reconhecimento:", e);
      }
    } else {
      alert("Seu navegador não suporta reconhecimento de voz.");
    }
  });
}

function initVoiceAssistant() {
  // Apenas acorda o sistema de áudio sem ativar o microfone automaticamente
  if (typeof wakeUpAudioSystem === 'function') wakeUpAudioSystem();
}

document.addEventListener('DOMContentLoaded', () => {
  initVoiceAssistant();
});

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================

// Inicializa
window.torBrowserAPI.getNewTabUrl().then(url => {
  DEFAULT_URL = url;
  applyClientChrome();
  createTab(DEFAULT_URL);
  initTorStatus();
  updateAdblockUI();
  initCloudflareStatus();

  // Verifica status da sessão compartilhada
  fetch('/api/session-info', {
    headers: { 'X-Client-Id': CLIENT_ID }
  }).then(r => r.json()).then(info => {
    if (info && info.success) {
      console.log('[CLIENT SESSION] Sessão iniciada.');
      const primaryUrl = info.ngrokTunnelUrl || info.cloudflareTunnelUrl;
      const isConnecting = !primaryUrl && (info.ngrokTunnelConnecting || info.cloudflareTunnelConnecting);
      updateCloudflareBadge(primaryUrl, isConnecting, Boolean(info.ngrokTunnelUrl));
    }
  }).catch(() => {});
});

// ============================================================================
// RECONHECIMENTO AUTOMÁTICO E DOWNLOAD DE VÍDEOS (MP4 / MP3)
// ============================================================================
let activeDetectedVideo = null;
const pagePlayerDismissed = new Set();
const videoSnifferBar = document.getElementById('video-sniffer-bar');
const vsniffTitle = document.getElementById('vsniff-title');
const vsniffBtnWatch = document.getElementById('vsniff-btn-watch');
const vsniffBtnMp4 = document.getElementById('vsniff-btn-mp4');
const vsniffBtnMp3 = document.getElementById('vsniff-btn-mp3');
const vsniffBtnClose = document.getElementById('vsniff-btn-close');
const btnMediaDl = document.getElementById('btn-media-dl');
const globalMediaModal = document.getElementById('global-media-download-modal');
const closeGmediaModalBtn = document.getElementById('close-gmedia-modal-btn');

function pagePlayerKey(data) {
  return String((data && (data.youtubeId || data.mediaUrl || data.url)) || '');
}

function shouldUseOwnPlayer(data) {
  if (!data || !data.url) return false;
  if (data.youtubeId) return true;
  const width = Number(data.width) || 0;
  const duration = Number(data.duration) || 0;
  if (width > 0 && width < 160 && duration > 0 && duration < 12) return false;
  return data.type === 'html5' || data.type === 'page' || data.type === 'stream' || data.type === 'youtube';
}

function pausePageVideos() {
  const tab = getActiveTab();
  const view = tab && tab.webview;
  if (!view) return;
  const script = 'document.querySelectorAll("video,audio").forEach(function(m){try{m.pause()}catch(e){}})';
  if (typeof view.executeJavaScript === 'function') {
    view.executeJavaScript(script).catch(() => {});
  }
  try {
    if (view.contentWindow) view.contentWindow.postMessage({ type: 'papaleguas-pause-media' }, '*');
  } catch (e) {}
}

function closePagePlayer(remember) {
  const box = document.getElementById('page-player');
  const frame = document.getElementById('page-player-frame');
  const video = document.getElementById('page-player-video');
  if (activeDetectedVideo) {
    const key = pagePlayerKey(activeDetectedVideo);
    if (remember) pagePlayerDismissed.add(key);
    pagePlayerDismissed.add('bar:' + key);
  }
  if (box) box.hidden = true;
  if (frame) {
    frame.hidden = true;
    frame.src = 'about:blank';
  }
  if (video) {
    try { video.pause(); } catch (e) {}
    video.hidden = true;
    video.removeAttribute('src');
    try { video.load(); } catch (e) {}
  }
  if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(false);

  // Fecha também a parte debaixo (video-sniffer-bar) que tem os botões de baixar MP4 e MP3
  hideVideoSnifferNotification();
  const currentTab = getActiveTab();
  if (currentTab) currentTab.detectedVideo = null;
  activeDetectedVideo = null;
}

async function openPagePlayer(data) {
  if (!data || !data.url) return;
  activeDetectedVideo = data;
  const box = document.getElementById('page-player');
  const frame = document.getElementById('page-player-frame');
  const video = document.getElementById('page-player-video');
  const status = document.getElementById('page-player-status');
  const title = document.getElementById('page-player-title');
  if (!box || !frame || !video) return;
  if (title) title.textContent = data.title || 'Vídeo';
  box.hidden = false;
  if (videoSnifferBar) videoSnifferBar.style.display = 'none';
  pausePageVideos();
  if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(true);

  if (data.youtubeId) {
    video.hidden = true;
    try { video.pause(); } catch (e) {}
    frame.hidden = false;
    const origin = (window.location.origin && window.location.origin !== 'null') ? window.location.origin : 'http://localhost:8080';
    frame.src = 'https://www.youtube.com/embed/' + encodeURIComponent(data.youtubeId) + '?autoplay=1&rel=0&playsinline=1&enablejsapi=1&origin=' + encodeURIComponent(origin);
    if (status) status.hidden = true;
    return;
  }

  frame.hidden = true;
  frame.src = 'about:blank';
  video.hidden = false;
  if (status) {
    status.hidden = false;
    status.textContent = 'Abrindo no player do Papaléguas…';
  }
  let src = data.mediaUrl && /^https?:/i.test(data.mediaUrl) ? data.mediaUrl : '';
  if (!src) {
    try {
      const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron) || window.location.protocol === 'file:';
      const baseUrl = isElectron ? 'http://localhost:8080' : '';
      const res = await fetch(baseUrl + '/api/media/play-url?url=' + encodeURIComponent(data.url));
      const json = await res.json();
      src = json && json.streamUrl ? json.streamUrl : '';
      if (!src && status) status.textContent = (json && json.error) || 'Não achei o vídeo para reproduzir. Dá para baixar mesmo assim.';
    } catch (e) {
      if (status) status.textContent = 'Não consegui abrir o vídeo agora. Dá para baixar mesmo assim.';
    }
  }
  if (!src) return;
  video.src = src;
  video.play().catch(() => {});
  if (status) status.hidden = true;
}

function showVideoSnifferNotification(data) {
  if (!data || !data.url) return;
  activeDetectedVideo = data;

  if (vsniffTitle) {
    vsniffTitle.textContent = data.title || 'Vídeo detectado';
  }
  if (btnMediaDl) {
    btnMediaDl.style.display = 'inline-flex';
  }
  const key = pagePlayerKey(data);
  if (pagePlayerDismissed.has(key) && pagePlayerDismissed.has('bar:' + key)) {
    return;
  }
  if (shouldUseOwnPlayer(data) && !pagePlayerDismissed.has(key)) {
    openPagePlayer(data);
    return;
  }
  const player = document.getElementById('page-player');
  if (player && !player.hidden) return;
  if (pagePlayerDismissed.has('bar:' + key)) return;
  if (videoSnifferBar) videoSnifferBar.style.display = 'flex';
}

function hideVideoSnifferNotification() {
  if (videoSnifferBar) {
    videoSnifferBar.style.display = 'none';
  }
}

if (vsniffBtnClose) {
  vsniffBtnClose.addEventListener('click', () => {
    if (activeDetectedVideo) {
      const key = pagePlayerKey(activeDetectedVideo);
      pagePlayerDismissed.add('bar:' + key);
      pagePlayerDismissed.add(key);
    }
    const currentTab = getActiveTab();
    if (currentTab) currentTab.detectedVideo = null;
    activeDetectedVideo = null;
    hideVideoSnifferNotification();
    closePagePlayer(true);
  });
}

if (vsniffBtnWatch) {
  vsniffBtnWatch.addEventListener('click', () => {
    if (!activeDetectedVideo) return;
    pagePlayerDismissed.delete(pagePlayerKey(activeDetectedVideo));
    pagePlayerDismissed.delete('bar:' + pagePlayerKey(activeDetectedVideo));
    openPagePlayer(activeDetectedVideo);
  });
}

const pagePlayerClose = document.getElementById('page-player-close');
const pagePlayerMp4 = document.getElementById('page-player-mp4');
const pagePlayerMp3 = document.getElementById('page-player-mp3');
if (pagePlayerClose) pagePlayerClose.addEventListener('click', () => closePagePlayer(true));

const pagePlayerModal = document.getElementById('page-player');
if (pagePlayerModal) {
  pagePlayerModal.addEventListener('click', (e) => {
    if (e.target === pagePlayerModal) {
      closePagePlayer(true);
    }
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const box = document.getElementById('page-player');
    if (box && !box.hidden) {
      closePagePlayer(true);
    }
    if (videoSnifferBar && videoSnifferBar.style.display !== 'none') {
      hideVideoSnifferNotification();
    }
  }
});
if (pagePlayerMp4) {
  pagePlayerMp4.addEventListener('click', () => {
    if (activeDetectedVideo) triggerGlobalMediaDownload(activeDetectedVideo.url, 'mp4', activeDetectedVideo.title);
  });
}
if (pagePlayerMp3) {
  pagePlayerMp3.addEventListener('click', () => {
    if (activeDetectedVideo) triggerGlobalMediaDownload(activeDetectedVideo.url, 'mp3', activeDetectedVideo.title);
  });
}

if (vsniffBtnMp4) {
  vsniffBtnMp4.addEventListener('click', () => {
    if (activeDetectedVideo) {
      triggerGlobalMediaDownload(activeDetectedVideo.url, 'mp4', activeDetectedVideo.title);
    }
  });
}

if (vsniffBtnMp3) {
  vsniffBtnMp3.addEventListener('click', () => {
    if (activeDetectedVideo) {
      triggerGlobalMediaDownload(activeDetectedVideo.url, 'mp3', activeDetectedVideo.title);
    }
  });
}

if (btnMediaDl) {
  btnMediaDl.addEventListener('click', () => {
    if (activeDetectedVideo) {
      triggerGlobalMediaDownload(activeDetectedVideo.url, 'mp4', activeDetectedVideo.title);
    }
  });
}

let globalMediaPollTimer = null;

if (closeGmediaModalBtn) {
  closeGmediaModalBtn.addEventListener('click', () => {
    if (globalMediaPollTimer) {
      clearInterval(globalMediaPollTimer);
      globalMediaPollTimer = null;
    }
    if (globalMediaModal) globalMediaModal.classList.add('hidden');
    const ap = document.getElementById('gmedia-audio-player');
    if (ap) ap.pause();
    const vp = document.getElementById('gmedia-video-player');
    if (vp) vp.pause();
  });
}

async function triggerGlobalMediaDownload(url, format, title) {
  if (!url) return;
  if (globalMediaPollTimer) {
    clearInterval(globalMediaPollTimer);
    globalMediaPollTimer = null;
  }
  if (globalMediaModal) globalMediaModal.classList.remove('hidden');

  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron) || window.location.protocol === 'file:';
  const baseUrl = isElectron ? 'http://localhost:8080' : '';

  const loading = document.getElementById('gmedia-loading');
  const success = document.getElementById('gmedia-success');
  const statusText = document.getElementById('gmedia-status-text');
  const modalTitle = document.getElementById('gmedia-modal-title');
  const modalIcon = document.getElementById('gmedia-modal-icon');
  const progressFill = document.getElementById('gmedia-progress-fill');
  const progressPct = document.getElementById('gmedia-progress-pct');
  const progressSpeed = document.getElementById('gmedia-progress-speed');
  const progressTotal = document.getElementById('gmedia-progress-total');

  if (loading) loading.style.display = 'block';
  if (success) success.style.display = 'none';
  if (progressFill) progressFill.style.width = '5%';
  if (progressPct) progressPct.textContent = '5%';
  if (modalIcon) modalIcon.textContent = format === 'mp3' ? '🎵' : '🎬';
  if (modalTitle) modalTitle.textContent = `Download de ${format.toUpperCase()}`;
  if (statusText) statusText.textContent = `Iniciando download de ${(title || 'vídeo').slice(0, 32)}...`;
  if (progressSpeed) progressSpeed.textContent = 'Conectando ao motor de download...';
  if (progressTotal) progressTotal.textContent = '';

  console.log('[MEDIA DOWNLOAD] Download iniciado.');

  function renderSuccess(data) {
    if (globalMediaPollTimer) {
      clearInterval(globalMediaPollTimer);
      globalMediaPollTimer = null;
    }
    if (loading) loading.style.display = 'none';
    if (success) success.style.display = 'block';

    const fileTitle = document.getElementById('gmedia-file-title');
    const fileMeta = document.getElementById('gmedia-file-meta');
    const saveLink = document.getElementById('gmedia-save-link');
    const ap = document.getElementById('gmedia-audio-player');
    const vp = document.getElementById('gmedia-video-player');

    if (fileTitle) fileTitle.textContent = data.title;
    if (fileMeta) fileMeta.textContent = `Duração: ${data.duration} • Formato: ${data.format.toUpperCase()}`;

    const finalUrl = data.url.startsWith('http') ? data.url : (baseUrl + data.url);

    if (saveLink) {
      saveLink.href = finalUrl;
      saveLink.download = `${data.title}.${data.format}`;
      saveLink.textContent = `⬇️ Salvar ${data.format.toUpperCase()} no Dispositivo`;
      saveLink.target = '_self';
    }

    if (format === 'mp3' && ap) {
      if (vp) vp.style.display = 'none';
      ap.style.display = 'block';
      ap.src = finalUrl;
      ap.play().catch(() => {});
    } else if (vp) {
      if (ap) ap.style.display = 'none';
      vp.style.display = 'block';
      vp.src = finalUrl;
    }
  }

  try {
    const jobRes = await fetch(`${baseUrl}/api/media/download-job?url=${encodeURIComponent(url)}&format=${format}`);
    const jobData = await jobRes.json();

    if (!jobData.success || !jobData.jobId) {
      throw new Error(jobData.error || 'Falha ao iniciar processo de download.');
    }

    const jobId = jobData.jobId;

    globalMediaPollTimer = setInterval(async () => {
      try {
        const pollRes = await fetch(`${baseUrl}/api/media/download-status?jobId=${encodeURIComponent(jobId)}`);
        const st = await pollRes.json();

        if (st.progress !== undefined) {
          if (progressFill) progressFill.style.width = `${st.progress}%`;
          if (progressPct) progressPct.textContent = `${st.progress}%`;
        }
        if (st.text && statusText) {
          statusText.textContent = st.text;
        }
        if (progressSpeed) {
          if (st.speed) {
            let speedText = `⚡ ${st.speed}`;
            if (st.eta) speedText += ` • Restante: ${st.eta}`;
            progressSpeed.textContent = speedText;
          } else if (st.stage === 'converting' || st.stage === 'merging') {
            progressSpeed.textContent = 'Processando com FFmpeg...';
          }
        }
        if (progressTotal) {
          let totalText = st.total ? `Tamanho: ${st.total}` : '';
          if (st.frag) totalText += ` (frag. ${st.frag})`;
          progressTotal.textContent = totalText;
        }

        if (st.stage === 'complete' && st.success) {
          if (progressFill) progressFill.style.width = '100%';
          if (progressPct) progressPct.textContent = '100%';
          renderSuccess(st);
        } else if (st.stage === 'error') {
          if (globalMediaPollTimer) {
            clearInterval(globalMediaPollTimer);
            globalMediaPollTimer = null;
          }
          alert('Erro ao converter: ' + (st.error || 'Falha no download'));
          if (globalMediaModal) globalMediaModal.classList.add('hidden');
        }
      } catch (pollErr) {
        console.warn('[MEDIA POLL WARN]', pollErr);
      }
    }, 450);

  } catch (err) {
    if (globalMediaPollTimer) {
      clearInterval(globalMediaPollTimer);
      globalMediaPollTimer = null;
    }
    console.error('[MEDIA DOWNLOAD ERROR]', err);
    alert('Erro de conexão ao baixar: ' + (err.message || 'Verifique se o servidor está ativo'));
    if (globalMediaModal) globalMediaModal.classList.add('hidden');
  }
}

// ============================================================================
// GERENCIAMENTO DO MINI PLAYER FLUTUANTE GLOBAL (PAPALÉGUAS MUSIC)
// Arrastável pela tela e persistente ao navegar por qualquer aba até ser fechado
// ============================================================================
let lastGlobalMusicState = (() => {
  try {
    const raw = localStorage.getItem('papaleguas_last_music_state');
    return raw ? JSON.parse(raw) : null;
  } catch(e) {
    return null;
  }
})();
let userDismissedMiniPlayer = false;

const globalMusicMiniPlayer = document.getElementById('global-music-mini-player');
const gmDragHeader = document.getElementById('gm-drag-header');
const gmTrackThumb = document.getElementById('gm-track-thumb');
const gmTrackTitle = document.getElementById('gm-track-title');
const gmTrackArtist = document.getElementById('gm-track-artist');
const gmProgressBar = document.getElementById('gm-progress-bar');
const gmProgressContainer = document.getElementById('gm-progress-container');
const gmBtnPrev = document.getElementById('gm-btn-prev');
const gmBtnPlay = document.getElementById('gm-btn-play');
const gmPlayIcon = document.getElementById('gm-play-icon');
const gmBtnNext = document.getElementById('gm-btn-next');
const gmBtnMaximize = document.getElementById('gm-btn-maximize');
const gmBtnClose = document.getElementById('gm-btn-close');

function getMusicTab() {
  return tabs.find(t => t.url && (t.url.includes('musica.html') || t.url.includes('/musica')));
}

function sendMusicControlCommand(action, value) {
  const musicTab = getMusicTab();
  if (musicTab && musicTab.webview) {
    try {
      if (typeof musicTab.webview.send === 'function') {
        musicTab.webview.send('music-player-control', { action, value });
      }
    } catch(e) {}
    try {
      if (musicTab.webview.contentWindow && typeof musicTab.webview.contentWindow.postMessage === 'function') {
        musicTab.webview.contentWindow.postMessage({ type: 'music-player-control', action, value }, '*');
      }
    } catch(e) {}
  } else if (action === 'toggle' || action === 'play') {
    openPapaleguasMusic('');
  }
}

function clearGlobalMusicState() {
  lastGlobalMusicState = null;
  try { localStorage.removeItem('papaleguas_last_music_state'); } catch (e) {}
  if (window.torBrowserAPI && typeof window.torBrowserAPI.updateMusicTrayState === 'function') {
    try { window.torBrowserAPI.updateMusicTrayState(null); } catch (e) {}
  }
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    } catch (e) {}
  }
  if (globalMusicMiniPlayer) globalMusicMiniPlayer.classList.add('hidden');
}

// Saindo do app (fechar aba/janela no celular ou desktop): limpa notificação e bandeja
window.addEventListener('beforeunload', (ev) => {
  if (ev && ev.persisted) return;
  if (typeof clearGlobalMusicState === 'function') clearGlobalMusicState();
});

function updateGlobalMusicPlayerUI(state) {
  if (!state || !state.track) return;
  lastGlobalMusicState = state;
  try {
    localStorage.setItem('papaleguas_last_music_state', JSON.stringify(state));
  } catch(e) {}

  if (gmTrackThumb) {
    gmTrackThumb.onerror = () => { gmTrackThumb.src = 'papaleguas_icon.png'; };
    gmTrackThumb.src = state.track.cover || 'papaleguas_icon.png';
  }
  if (gmTrackTitle) {
    gmTrackTitle.textContent = state.track.title || '--';
    gmTrackTitle.title = state.track.title || '';
  }
  if (gmTrackArtist) {
    gmTrackArtist.textContent = state.track.artist || '';
  }
  if (gmProgressBar && state.duration > 0) {
    const pct = Math.min(100, Math.max(0, (state.currentTime / state.duration) * 100));
    gmProgressBar.style.width = `${pct}%`;
  }
  if (gmPlayIcon) {
    if (state.isPlaying) {
      gmPlayIcon.innerHTML = '<rect x="4" y="3" width="4" height="18"/><rect x="12" y="3" width="4" height="18"/>';
      if (gmBtnPlay) gmBtnPlay.title = 'Pausar';
    } else {
      gmPlayIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
      if (gmBtnPlay) gmBtnPlay.title = 'Reproduzir';
    }
  }

  // Notifica a área de notificação do sistema (Tray do sistema operacional)
  if (window.torBrowserAPI && typeof window.torBrowserAPI.updateMusicTrayState === 'function') {
    window.torBrowserAPI.updateMusicTrayState(state);
  }

  // Atualiza controles na central de notificações nativa do sistema (MediaSession / MPRIS)
  // No modo hospedado (celular) o áudio vive dentro da página de música, que já é a dona
  // do cartão de mídia; sobrescrever aqui deixava os botões da notificação travados.
  if (isElectronApp() && 'mediaSession' in navigator && state && state.track) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.track.title || 'Papaléguas Music',
        artist: state.track.artist || 'Papaléguas Music',
        album: 'Papaléguas Music',
        artwork: [
          { src: state.track.cover || 'papaleguas_icon.png', sizes: '512x512', type: 'image/png' }
        ]
      });
      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play', () => sendMusicControlCommand('play'));
      navigator.mediaSession.setActionHandler('pause', () => sendMusicControlCommand('pause'));
      navigator.mediaSession.setActionHandler('previoustrack', () => sendMusicControlCommand('prev'));
      navigator.mediaSession.setActionHandler('nexttrack', () => sendMusicControlCommand('next'));
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) sendMusicControlCommand('seek', details.seekTime);
      });
    } catch (e) {}
  }

  // Se o usuário saiu da aba de música e a faixa está ativa, exibe o mini player flutuante
  const activeTab = getActiveTab();
  const isCurrentlyInMusicTab = activeTab && activeTab.url && (activeTab.url.includes('musica.html') || activeTab.url.includes('/musica'));
  if (!isCurrentlyInMusicTab && !userDismissedMiniPlayer && globalMusicMiniPlayer) {
    globalMusicMiniPlayer.classList.remove('hidden');
    if (typeof restoreMiniPlayerPosition === 'function') {
      restoreMiniPlayerPosition();
    }
  }
}

// Escuta comandos vindos da área de notificação do sistema (Tray)
if (window.torBrowserAPI && typeof window.torBrowserAPI.onMusicTrayCommand === 'function') {
  window.torBrowserAPI.onMusicTrayCommand((cmd) => {
    if (!cmd) return;
    if (cmd.action === 'focus-music-tab') {
      const musicTab = getMusicTab();
      if (musicTab) {
        activateTab(musicTab.id);
      } else {
        openPapaleguasMusic('');
      }
    } else {
      sendMusicControlCommand(cmd.action);
    }
  });
}

// Botões de controle do Mini Player Global
if (gmBtnPlay) {
  gmBtnPlay.addEventListener('click', (e) => {
    e.stopPropagation();
    sendMusicControlCommand('toggle');
  });
}
if (gmBtnNext) {
  gmBtnNext.addEventListener('click', (e) => {
    e.stopPropagation();
    sendMusicControlCommand('next');
  });
}
if (gmBtnPrev) {
  gmBtnPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    sendMusicControlCommand('prev');
  });
}
if (gmBtnMaximize) {
  gmBtnMaximize.addEventListener('click', (e) => {
    e.stopPropagation();
    const musicTab = getMusicTab();
    if (musicTab) {
      activateTab(musicTab.id);
    } else {
      openPapaleguasMusic('');
    }
    if (globalMusicMiniPlayer) globalMusicMiniPlayer.classList.add('hidden');
  });
}
if (gmBtnClose) {
  gmBtnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    userDismissedMiniPlayer = true;
    if (globalMusicMiniPlayer) globalMusicMiniPlayer.classList.add('hidden');
  });
}
if (gmProgressContainer) {
  gmProgressContainer.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!lastGlobalMusicState || !lastGlobalMusicState.duration) return;
    const rect = gmProgressContainer.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    const targetTime = pct * lastGlobalMusicState.duration;
    sendMusicControlCommand('seek', targetTime);
  });
}

// Suporte para mensagens postMessage em clientes web
window.addEventListener('message', (ev) => {
  if (!ev.data) return;
  if (ev.data.type === 'music-state-update') {
    updateGlobalMusicPlayerUI(ev.data);
  } else if (ev.data.type === 'youtube-state-update') {
    updateGlobalYoutubeState(ev.data);
  } else if (ev.data.type === 'toggle-music-mini-player') {
    if (globalMusicMiniPlayer) {
      const isHidden = globalMusicMiniPlayer.classList.contains('hidden');
      if (isHidden) {
        userDismissedMiniPlayer = false;
        globalMusicMiniPlayer.classList.remove('hidden');
      } else {
        userDismissedMiniPlayer = true;
        globalMusicMiniPlayer.classList.add('hidden');
      }
    }
  }
});

// Drag & Drop livre do Mini Player Flutuante (Arrastar e soltar em qualquer posição sobre as abas)
let isGmDragging = false;
let gmStartX = 0, gmStartY = 0;
let gmInitialLeft = 0, gmInitialTop = 0;

function restoreMiniPlayerPosition() {
  if (!globalMusicMiniPlayer) return;
  try {
    const raw = localStorage.getItem('papaleguas_mini_player_pos');
    if (raw) {
      const pos = JSON.parse(raw);
      if (typeof pos.left === 'number' && typeof pos.top === 'number') {
        const w = globalMusicMiniPlayer.offsetWidth || 340;
        const h = globalMusicMiniPlayer.offsetHeight || 100;
        const maxW = Math.max(6, window.innerWidth - w - 6);
        const maxH = Math.max(6, window.innerHeight - h - 6);
        const left = Math.max(6, Math.min(pos.left, maxW));
        const top = Math.max(6, Math.min(pos.top, maxH));
        globalMusicMiniPlayer.style.bottom = 'auto';
        globalMusicMiniPlayer.style.right = 'auto';
        globalMusicMiniPlayer.style.left = `${left}px`;
        globalMusicMiniPlayer.style.top = `${top}px`;
      }
    }
  } catch (e) {}
}

if (globalMusicMiniPlayer) {
  restoreMiniPlayerPosition();

  // Permite arrastar por qualquer lugar do player exceto botões interativos e a barra de progresso
  globalMusicMiniPlayer.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.target.closest('.gm-progress') || e.target.closest('#gm-progress-container')) {
      return;
    }
    if (e.button !== undefined && e.button !== 0) return;

    isGmDragging = true;
    gmStartX = e.clientX || 0;
    gmStartY = e.clientY || 0;

    const rect = globalMusicMiniPlayer.getBoundingClientRect();
    gmInitialLeft = rect.left;
    gmInitialTop = rect.top;

    globalMusicMiniPlayer.style.bottom = 'auto';
    globalMusicMiniPlayer.style.right = 'auto';
    globalMusicMiniPlayer.style.left = `${gmInitialLeft}px`;
    globalMusicMiniPlayer.style.top = `${gmInitialTop}px`;
    globalMusicMiniPlayer.style.transition = 'none';
    globalMusicMiniPlayer.classList.add('is-dragging');

    // Desativa pointer-events nas abas (webviews e iframes) enquanto arrasta
    document.body.classList.add('is-dragging-global-player');

    try {
      globalMusicMiniPlayer.setPointerCapture(e.pointerId);
    } catch(err) {}

    const onGmPointerMove = (ev) => {
      if (!isGmDragging) return;
      if (ev.cancelable) ev.preventDefault();

      const deltaX = (ev.clientX || 0) - gmStartX;
      const deltaY = (ev.clientY || 0) - gmStartY;

      let newLeft = gmInitialLeft + deltaX;
      let newTop = gmInitialTop + deltaY;

      const maxW = Math.max(6, window.innerWidth - globalMusicMiniPlayer.offsetWidth - 6);
      const maxH = Math.max(6, window.innerHeight - globalMusicMiniPlayer.offsetHeight - 6);

      newLeft = Math.max(6, Math.min(newLeft, maxW));
      newTop = Math.max(6, Math.min(newTop, maxH));

      globalMusicMiniPlayer.style.left = `${newLeft}px`;
      globalMusicMiniPlayer.style.top = `${newTop}px`;
    };

    const onGmPointerUp = (ev) => {
      if (!isGmDragging) return;
      isGmDragging = false;
      globalMusicMiniPlayer.style.transition = '';
      globalMusicMiniPlayer.classList.remove('is-dragging');
      document.body.classList.remove('is-dragging-global-player');

      try {
        if (ev && ev.pointerId !== undefined && globalMusicMiniPlayer.releasePointerCapture) {
          globalMusicMiniPlayer.releasePointerCapture(ev.pointerId);
        }
      } catch(err) {}

      // Salva a posição exata para permanecer entre todas as abas e recarregamentos
      const curRect = globalMusicMiniPlayer.getBoundingClientRect();
      try {
        localStorage.setItem('papaleguas_mini_player_pos', JSON.stringify({
          left: Math.round(curRect.left),
          top: Math.round(curRect.top)
        }));
      } catch (err) {}

      window.removeEventListener('pointermove', onGmPointerMove);
      window.removeEventListener('pointerup', onGmPointerUp);
      window.removeEventListener('pointercancel', onGmPointerUp);
    };

    window.addEventListener('pointermove', onGmPointerMove, { passive: false });
    window.addEventListener('pointerup', onGmPointerUp);
    window.addEventListener('pointercancel', onGmPointerUp);
  });

  // Auto-enquadramento do mini player global com o tamanho da tela
  window.addEventListener('resize', () => {
    if (globalMusicMiniPlayer && !globalMusicMiniPlayer.classList.contains('hidden')) {
      const rect = globalMusicMiniPlayer.getBoundingClientRect();
      const maxW = Math.max(6, window.innerWidth - rect.width - 6);
      const maxH = Math.max(6, window.innerHeight - rect.height - 6);

      let curLeft = parseFloat(globalMusicMiniPlayer.style.left) || rect.left;
      let curTop = parseFloat(globalMusicMiniPlayer.style.top) || rect.top;

      curLeft = Math.max(6, Math.min(curLeft, maxW));
      curTop = Math.max(6, Math.min(curTop, maxH));

      globalMusicMiniPlayer.style.left = `${curLeft}px`;
      globalMusicMiniPlayer.style.top = `${curTop}px`;
    }
  });
}



// ============================================================================
// MODO SEM RASTRO
// Pesquisas, URLs abertas, conteúdo extraído, cookies e cache existem só
// enquanto o Papaléguas está aberto. Ao fechar, nada disso sobrevive.
// ============================================================================
let tracesWiped = false;

// No Electron o aviso de fechamento pergunta sobre os favoritos e o processo
// principal já os guardou em arquivo antes daqui. No modo hospedado (celular /
// Cloudflare) não existe esse aviso, então os favoritos são preservados.
async function restoreSavedBookmarks() {
  try {
    if (!window.torBrowserAPI || typeof window.torBrowserAPI.getSavedBookmarks !== 'function') return;
    const current = (typeof getUserBookmarks === 'function') ? getUserBookmarks() : JSON.parse(localStorage.getItem('user_bookmarks') || '[]');
    if (current.length) return;
    const saved = await window.torBrowserAPI.getSavedBookmarks();
    if (!Array.isArray(saved) || !saved.length) return;
    if (typeof setUserBookmarks === 'function') {
      setUserBookmarks(saved);
    } else {
      localStorage.setItem('user_bookmarks', JSON.stringify(saved));
    }
    if (typeof renderBookmarks === 'function') renderBookmarks();
  } catch (e) {}
}

restoreSavedBookmarks();

function wipeLocalTraces() {
  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
  let keptBookmarks = null;
  const key = (typeof getBookmarksStorageKey === 'function') ? getBookmarksStorageKey() : 'user_bookmarks';
  if (!isElectron) {
    try { keptBookmarks = localStorage.getItem(key) || localStorage.getItem('user_bookmarks'); } catch (e) {}
  }
  let keptEq = null, keptSize = null, keptCountry = null, keptClientId = null;
  try {
    keptEq = localStorage.getItem('papaleguas_music_eq');
    keptSize = localStorage.getItem('sp_player_size');
    keptCountry = localStorage.getItem('papaleguas_selected_country');
    keptClientId = localStorage.getItem('papaleguas_client_id');
  } catch (e) {}
  try { localStorage.clear(); } catch (e) {}
  try {
    if (keptBookmarks !== null) {
      localStorage.setItem(key, keptBookmarks);
      if (isElectron) localStorage.setItem('user_bookmarks', keptBookmarks);
    }
    if (keptEq) localStorage.setItem('papaleguas_music_eq', keptEq);
    if (keptSize) localStorage.setItem('sp_player_size', keptSize);
    if (keptCountry) localStorage.setItem('papaleguas_selected_country', keptCountry);
    if (keptClientId) localStorage.setItem('papaleguas_client_id', keptClientId);
  } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  try {
    document.cookie.split(';').forEach((cookie) => {
      const name = cookie.split('=')[0].trim();
      if (!name) return;
      document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
    });
  } catch (e) {}
  try {
    if (window.caches && caches.keys) {
      caches.keys().then((keys) => keys.forEach((key) => caches.delete(key))).catch(() => {});
    }
  } catch (e) {}
  try {
    if (window.indexedDB && indexedDB.databases) {
      indexedDB.databases().then((dbs) => {
        (dbs || []).forEach((db) => { 
          if (db && db.name && db.name !== 'papaleguas_music_offline') {
            indexedDB.deleteDatabase(db.name); 
          }
        });
      }).catch(() => {});
    }
  } catch (e) {}
}

function clearSearchFields() {
  sessionRecentSearches = [];
  urlSuggestState.items = [];
  urlSuggestState.q = '';
  try { hideUrlSuggestions(); } catch (e) {}
  try { if (urlInput) urlInput.value = ''; } catch (e) {}
  try { setAddressBar(''); } catch (e) {}
}

function clearAllTraces() {
  if (tracesWiped) return;
  tracesWiped = true;
  clearSearchFields();
  wipeLocalTraces();
  try {
    if (window.torBrowserAPI && typeof window.torBrowserAPI.clearBrowsingTraces === 'function') {
      window.torBrowserAPI.clearBrowsingTraces();
    }
  } catch (e) {}
  try {
    // No modo hospedado (celular/Cloudflare) o beacon ainda sai durante o fechamento.
    const payload = new Blob(['1'], { type: 'text/plain' });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/clear-traces', payload);
    fetch('/api/clear-traces', { method: 'POST', keepalive: true, cache: 'no-store' }).catch(() => {});
  } catch (e) {}
}

window.addEventListener('beforeunload', clearAllTraces);
window.addEventListener('pageshow', () => {
  tracesWiped = false;
});
