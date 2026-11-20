// Blindagem anti-recursão: o shell do navegador (renderer.js) NUNCA deve rodar dentro de um iframe
function swallowed(err, where) {
  if (typeof window !== 'undefined' && typeof window.__papaSwallowed === 'function') {
    window.__papaSwallowed(err, where);
  }
}
if (typeof window !== 'undefined' && window.self !== window.top) {
  try { if (document.documentElement) document.documentElement.style.display = 'none'; } catch (e) { swallowed(e, 'renderer:top@8'); }
  throw new Error('[Papaléguas] Shell do navegador bloqueado dentro de iframe.');
}

// Criptografia PPL (WebAssembly + stream cipher 64-bit) para buscas e APIs + polyfill file:// -> localhost:8080
(function installRendererPplCrypto() {
  if (typeof window === 'undefined') return;
  const _origFetch = window.fetch;
  const MASK_64 = (1n << 64n) - 1n;
  window.__pplRendererWasm = null;
  (async function () {
    try {
      if (typeof WebAssembly === 'undefined') return;
      const origin = (window.location && window.location.protocol !== 'file:' && window.location.origin !== 'null') ? '' : 'http://localhost:8080';
      const r = await _origFetch.call(window, origin + '/api/ppl-wasm?module=client_guard');
      if (!r.ok) return;
      const inst = await WebAssembly.instantiate(await r.arrayBuffer(), {});
      if (inst && inst.instance && inst.instance.exports) window.__pplRendererWasm = inst.instance.exports;
    } catch (e) {}
  })();

  function pplKeystreamByte(nonce, idx) {
    const w = window.__pplRendererWasm;
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

  window.encryptPplSearchUrl = function(rawUrl) {
    try {
      const base = (window.location && window.location.protocol !== 'file:' && window.location.origin !== 'null') ? window.location.origin : 'http://localhost:8080';
      const u = new URL(rawUrl, base);
      if ((u.pathname === '/search' || u.pathname === '/proxy' || u.pathname.startsWith('/api/')) && u.search && !u.searchParams.has('ppl')) {
        const payload = {};
        u.searchParams.forEach((v, k) => { payload[k] = v; });
        const token = encryptPplObj(payload);
        const prefix = (typeof rawUrl === 'string' && rawUrl.startsWith('http')) ? u.origin : '';
        return prefix + u.pathname + '?ppl=' + encodeURIComponent(token);
      }
    } catch (e) {}
    return rawUrl;
  };

  const ENCRYPTED_API = /^\/api\/(?:search|search-picks|url-suggest|search-rich|search-images|search-videos|ai-answer|preview-img|ipcam-frame|youtube-recent|youtube-trending|youtube-liked-feed|youtube-suggest|suggest|google-trends|curator-recommendations|country-detect)\b/;
  window.fetch = function(input, init) {
    let urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    try {
      const isFile = window.location && window.location.protocol === 'file:';
      const parsed = new URL(urlStr, isFile ? 'http://localhost:8080' : window.location.origin);
      if (ENCRYPTED_API.test(parsed.pathname) && parsed.search && !parsed.searchParams.has('ppl')) {
        const payload = {};
        parsed.searchParams.forEach((v, k) => { payload[k] = v; });
        const prefix = isFile ? 'http://localhost:8080' : '';
        urlStr = prefix + parsed.pathname + '?ppl=' + encodeURIComponent(encryptPplObj(payload));
        input = (typeof input === 'string') ? urlStr : new Request(urlStr, input);
      } else if (isFile) {
        if (typeof input === 'string' && (input.startsWith('/api/') || input.startsWith('/youtube') || input.startsWith('/search') || input.startsWith('/filmes') || input.startsWith('/ipcam-live') || input.startsWith('/video-watch'))) {
          input = 'http://localhost:8080' + input;
        } else if (input instanceof URL && input.protocol === 'file:' && input.pathname.startsWith('/api/')) {
          input = new URL('http://localhost:8080' + input.pathname + input.search);
        }
      }
    } catch (e) {}
    return _origFetch.call(this, input, init);
  };
})();

let tabs = [];
let activeTabId = null;
let previousActiveTabId = null;
let tabCounter = 0;

function publicAppOrigin() {
  if (window.location && window.location.origin && window.location.origin !== 'null' && window.location.protocol !== 'file:') {
    return window.location.origin.replace(/\/$/, '');
  }
  return 'http://localhost:8080';
}

function extractYoutubeVideoId(raw) {
  if (!raw) return null;
  try {
    const s = String(raw).trim();
    // 1. YouTube padrão, embed, shorts ou youtu.be
    const m = s.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/|baixatube(?:\.html)?\?.*[?&]v=)([^"&?\/\s]{11})/i);
    if (m && m[1]) return m[1];
    // 2. Parâmetro v= de 11 caracteres apenas em rotas de vídeo (YouTube / BaixaTube / watch)
    if (/(?:youtube\.com|youtu\.be|youtube-nocookie\.com|\/(?:baixatube|youtube|watch)(?:[/?#.]|$))/i.test(s)) {
      const vMatch = s.match(/[?&]v=([^"&?\/\s]{11})/i);
      if (vMatch && vMatch[1]) return vMatch[1];
    }
    // 3. ID puro de 11 caracteres
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  } catch (e) { swallowed(e, 'renderer:extractYoutubeVideoId@48'); }
  return null;
}

function routeUrlInsideTorApp(raw) {
  const target = String(raw || '').trim();
  if (!target) return target;
  const ytId = extractYoutubeVideoId(target);
  if (ytId) {
    return resolveAppNavUrl('/baixatube?v=' + encodeURIComponent(ytId));
  }
  if (/^https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\/(?:cgi-bin\/snapshot\.cgi|SnapshotJPEG|oneshotimage|axis-cgi\/(?:jpg|mjpg)|mjpg\/video\.mjpg|nphMotionJpeg)/i.test(target)) {
    return resolveAppNavUrl('/ipcam-live?url=' + encodeURIComponent(target));
  }
  if (/^https?:\/\/(?:(?:www|vm|vt|m)\.)?(?:tiktok\.com\/(?:@[^/]+\/video\/|v\/|t\/)|(?:vm|vt)\.tiktok\.com\/|dailymotion\.com\/video\/|dai\.ly\/|vimeo\.com\/\d+|kwai\.com\/(?:photo|video)\/)/i.test(target)) {
    return resolveAppNavUrl('/video-watch?url=' + encodeURIComponent(target) + '&clientId=' + encodeURIComponent(CLIENT_ID));
  }
  if (target.startsWith('/') && !/^\/proxy(?:\?|$)/i.test(target)) return resolveAppNavUrl(target);
  try {
    const parsed = new URL(target, publicAppOrigin() + '/');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return target;
    if (parsed.pathname === '/proxy' || parsed.pathname.indexOf('/proxy/') === 0) {
      if (isElectronApp()) {
        const inner = parsed.searchParams.get('url');
        if (inner) return inner;
      }
      return resolveAppNavUrl(parsed.pathname + parsed.search + parsed.hash);
    }
    if ((window.location && parsed.origin === window.location.origin) || parsed.origin === publicAppOrigin() || /^(localhost|127\.0\.0\.1|0\.0\.0\.0):8080$/i.test(parsed.host)) {
      return resolveAppNavUrl(parsed.pathname + parsed.search + parsed.hash);
    }
    // No Electron desktop, o <webview> já usa a partição persist:tor-browser configurada com Tor SOCKS5.
    // Carregar via /proxy causava injeção dupla, corrompia scripts e exibia códigos brutos na tela!
    if (isElectronApp()) {
      return parsed.href;
    }
    // No ambiente web/celular (iframe), roteia via proxy interno para contornar X-Frame-Options
    return resolveAppNavUrl('/proxy?url=' + encodeURIComponent(parsed.href) + '&clientId=' + encodeURIComponent(CLIENT_ID));
  } catch (e) {
    return target;
  }
}

function resolveAppNavUrl(raw) {
  const s = String(raw || '');
  if (!s) return s;
  if (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:') {
    const filePortalMatch = s.match(/\/((?:newtab|musica)\.html(?:[?#].*)?)$/i);
    if (s.startsWith('file:') && filePortalMatch) {
      return publicAppOrigin() + '/' + filePortalMatch[1];
    }
    if (/^(?:newtab|musica)\.html(?:[?#].*)?$/i.test(s)) {
      return publicAppOrigin() + '/' + s;
    }
  }
  if (/^https?:\/\//i.test(s)) return (typeof window.encryptPplSearchUrl === 'function') ? window.encryptPplSearchUrl(s) : s;
  if (s.startsWith('file:') || s.startsWith('data:') || s.startsWith('blob:')) return s;
  if (s.startsWith('/')) {
    const full = publicAppOrigin() + s;
    return (typeof window.encryptPplSearchUrl === 'function') ? window.encryptPplSearchUrl(full) : full;
  }
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

function isInternalPortalUrl(url) {
  if (!url) return true;
  const s = String(url).trim();
  if (!s || s === '/' || s === '/index.html') return true;
  const lower = s.toLowerCase();
  if (lower.startsWith('/proxy') || lower.includes('/proxy?') || lower.startsWith('/search') || lower.includes('/search?')) {
    return false;
  }
  if (lower.startsWith('file:')) {
    return true;
  }
  try {
    const appOrigin = (typeof publicAppOrigin === 'function' ? publicAppOrigin() : window.location.origin).toLowerCase();
    const locOrigin = (window.location && window.location.origin ? window.location.origin : appOrigin).toLowerCase();
    if (/^https?:\/\//i.test(s)) {
      const parsed = new URL(s);
      const o = parsed.origin.toLowerCase();
      const isAppHost = (
        o === appOrigin ||
        o === locOrigin ||
        /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i.test(o) ||
        /^https?:\/\/(?:www\.)?papaleguas\.app$/i.test(o)
      );
      if (!isAppHost) {
        return false;
      }
      const p = parsed.pathname.toLowerCase();
      if (p === '/' || p === '/index.html' || p.endsWith('/newtab.html') || p.endsWith('/musica.html')) return true;
      if (/^\/(?:baixatube|youtube|filmes?|musicas?|music|home|inicio|menu)(?:\/|$)/i.test(p)) {
        return true;
      }
      return false;
    }
    if (lower.includes('newtab.html') || lower.includes('musica.html')) return true;
    if (/^\/?(?:baixatube|youtube|filmes?|musicas?|music|home|inicio|menu)(?:[/?#]|$)/i.test(lower)) {
      return true;
    }
  } catch (e) { swallowed(e, 'renderer:isInternalPortalUrl@137'); }
  return false;
}

function sameViewUrl(a, b) {
  if (!a || !b) return false;
  try {
    const clean = (u) => String(u || '').trim().replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '') || '/';
    const rawClean = (u) => String(u || '').trim().replace(/\/+$/, '');
    return clean(a) === clean(b) || rawClean(a) === rawClean(b);
  } catch (e) {
    return String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
  }
}

function prettyAddressBarUrl(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';

  try {
    const parsed = new URL(s, publicAppOrigin() + '/');
    if (parsed.pathname === '/proxy' || parsed.pathname === '/proxy/') {
      let proxied = parsed.searchParams.get('url');
      if (!proxied && parsed.searchParams.has('ppl') && typeof window.__pplDecryptPayload === 'function') {
        const dec = window.__pplDecryptPayload(parsed.searchParams.get('ppl'));
        if (dec && dec.url) proxied = String(dec.url);
      }
      return proxied ? prettyAddressBarUrl(proxied) : '';
    }
    if (/\/search(?:\?|$)/i.test(parsed.pathname) || /duckduckgo\.com/i.test(parsed.hostname)) {
      let q = parsed.searchParams.get('q') || parsed.searchParams.get('query');
      if (!q && parsed.searchParams.has('ppl') && typeof window.__pplDecryptPayload === 'function') {
        const dec = window.__pplDecryptPayload(parsed.searchParams.get('ppl'));
        if (dec) q = dec.q || dec.query || '';
      }
      return q ? String(q) : '';
    }
  } catch (e) { swallowed(e, 'renderer:prettyAddressBarUrl@159'); }

  // NUNCA permitir que rotas ou portais internos (menu, baixatube, filme, music, home, newtab)
  // apareçam na barra de endereço/URL, especialmente no aplicativo de celular:
  if (isInternalPortalUrl(s)) {
    return '';
  }

  return s;
}

function enforceCleanPortalUrl() {
  try {
    const isRawInternal = (v) => isInternalPortalUrl(v) || /^\/(?:search|proxy)(?:\?|$)/i.test(String(v || '').trim()) || String(v || '').includes('baixatube') || String(v || '').includes('ngrok.app') || String(v || '').includes('ngrok-free.app') || String(v || '').includes('trycloudflare.com');
    if (urlInput && isRawInternal(urlInput.value)) {
      urlInput.value = '';
      if (typeof syncSearchClearButton === 'function') syncSearchClearButton();
    }
    if (searchFsInput && isRawInternal(searchFsInput.value)) {
      searchFsInput.value = '';
      if (typeof syncSearchFsClearButton === 'function') syncSearchFsClearButton();
    }
  } catch (e) { swallowed(e, 'renderer:enforceCleanPortalUrl@180'); }
}

try { enforceCleanPortalUrl(); } catch (e) { swallowed(e, 'renderer:top@183'); }
document.addEventListener('DOMContentLoaded', enforceCleanPortalUrl);
window.addEventListener('load', enforceCleanPortalUrl);

function setAddressBar(raw) {
  if (!urlInput) return;
  const pretty = prettyAddressBarUrl(raw);
  urlInput.value = (pretty && !isInternalPortalUrl(pretty) && !pretty.includes('baixatube') && !pretty.includes('ngrok.app') && !pretty.includes('ngrok-free.app') && !pretty.includes('trycloudflare.com')) ? pretty : '';
  syncSearchClearButton();
  enforceCleanPortalUrl();
}

function syncSearchClearButton() {
  const btn = document.getElementById('btn-clear-search');
  if (!btn || !urlInput) return;
  btn.hidden = !String(urlInput.value || '').trim();
}

let DEFAULT_URL = 'newtab.html';
const SEARCH_ENGINE = '/search?q=';

// Identificador único persistente para cada cliente/dispositivo (Desktop ou Celular)
// Garante isolamento completo de abas, player e chat entre múltiplos dispositivos conectados,
// compartilhando o mesmo login e credenciais no servidor.
const CLIENT_ID = (() => {
  let id = null;
  try {
    id = localStorage.getItem('papaleguas_client_id');
  } catch (e) { swallowed(e, 'renderer:top@211'); }
  if (!id) {
    id = 'cli_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
    try {
      localStorage.setItem('papaleguas_client_id', id);
    } catch (e) { swallowed(e, 'renderer:top@216'); }
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
    const timer = setTimeout(() => { try { pc.close(); } catch (e) { swallowed(e, 'renderer:reportConnectingDeviceIpv4@245'); } }, 1500);
    pc.onicecandidate = (event) => {
      const cand = event && event.candidate && event.candidate.candidate;
      if (!cand) return;
      const match = cand.match(/\b((?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})\b/);
      if (!match) return;
      clearTimeout(timer);
      try { pc.close(); } catch (e) { swallowed(e, 'renderer:reportConnectingDeviceIpv4@252'); }
      post({ deviceLanIpv4: match[1], localSubnet: match[1].split('.').slice(0, 3).join('.') + '.x' });
    };
  } catch (e) { swallowed(e, 'renderer:reportConnectingDeviceIpv4@255'); }
}

// Se acessado pelo navegador do celular ou fora do Electron, cria o polyfill das APIs via HTTP
if (!window.torBrowserAPI) {
  setTimeout(reportConnectingDeviceIpv4, 2500);
  window.torBrowserAPI = {
    getNewTabUrl: async () => 'newtab.html',
    getTorStatus: async () => {
      try {
        const res = await fetch(`/api/tor-status?clientId=${encodeURIComponent(CLIENT_ID)}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        const data = await res.json();
        window.__plTorConnected = Boolean(data && data.connected);
        return data;
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
        try { return await window.PapaleguasClientCast.scanDevices(); } catch (e) { swallowed(e, 'renderer:getCastDevices@300'); }
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
  const phoneUa = /Android|iPhone|iPod|iPad|Mobile|Opera Mini|IEMobile|webOS|BlackBerry/i.test(ua);
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
    str.startsWith('/ipcam-live') ||
    str.startsWith('/video-watch') ||
    str.startsWith('/papaleguas') ||
    str.startsWith('data:') ||
    str.startsWith('blob:')
  ) {
    return true;
  }
  try {
    const parsed = new URL(str, window.location.origin || 'http://localhost:8080');
    if (parsed.origin === window.location.origin || isLocalAppHost(parsed.hostname) || /localhost:8080|127\.0\.0\.1:8080/i.test(parsed.host)) {
      if (/^\/(search|youtube|filmes|musica|baixatube|ip-check|ipcam-live|video-watch|papaleguas)/i.test(parsed.pathname) || /newtab\.html|musica\.html/i.test(parsed.pathname)) {
        return true;
      }
    }
  } catch (e) { swallowed(e, 'renderer:isInternalAppUrl@500'); }
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
    } catch (e) { swallowed(e, 'renderer:openUrlOutsideIframe@513'); }
  }

  const vid = extractYoutubeVideoId(cleanUrl);
  if (vid) {
    playYoutubeVideoInApp(vid);
    return;
  }

  // Sempre abre em nova aba protegida pela conexão Tor dentro do aplicativo
  const routed = routeUrlInsideTorApp(cleanUrl);
  createTab(routed);
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
  } catch (e) { swallowed(e, 'renderer:checkPhoneLandscapeOrientation@618'); }
}

window.addEventListener('resize', checkPhoneLandscapeOrientation, { passive: true });
window.addEventListener('orientationchange', checkPhoneLandscapeOrientation, { passive: true });
if (window.screen && window.screen.orientation) {
  try {
    window.screen.orientation.addEventListener('change', checkPhoneLandscapeOrientation);
  } catch (e) { swallowed(e, 'renderer:top@626'); }
}
if (window.matchMedia) {
  try {
    const mql = window.matchMedia('(orientation: landscape)');
    if (mql.addEventListener) mql.addEventListener('change', checkPhoneLandscapeOrientation);
    else if (mql.addListener) mql.addListener(checkPhoneLandscapeOrientation);
  } catch (e) { swallowed(e, 'renderer:top@633'); }
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
    try {
      const ua = currentPageUserAgent();
      if (typeof t.webview.setUserAgent === 'function') {
        t.webview.setUserAgent(ua);
      } else {
        t.webview.useragent = ua;
      }
    } catch (e) { swallowed(e, 'renderer:applyMobileMode@650'); }
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
// ==========================================================================
// CENTRAL MULTIPLATAFORMA DE DOWNLOAD E INSTALAÇÃO (WINDOWS, LINUX, ANDROID, IOS)
// ==========================================================================
const btnInstallApp = document.getElementById('btn-install-app');
const installAppModal = document.getElementById('install-app-modal');
const closeInstallModalBtn = document.getElementById('close-install-modal-btn');
const btnTriggerPwaInstall = document.getElementById('btn-trigger-pwa-install');
let deferredInstallPrompt = null;

function detectClientOsLocal() {
  const ua = (navigator.userAgent || '').toLowerCase();
  const plat = (navigator.platform || '').toLowerCase();
  const isTouchMac = /macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iphone|ipad|ipod/.test(ua) || isTouchMac) {
    return {
      osId: 'ios',
      osName: 'iPhone / iPad (iOS)',
      shortLabel: '🍎 Baixar App iOS',
      icon: '🍎',
      downloadUrl: '/download/app?os=ios',
      btnText: '🍎 Baixar App para iPhone / iPad (iOS)'
    };
  }
  if (/android/.test(ua)) {
    return {
      osId: 'android',
      osName: 'Android (Smartphone / Tablet / TV)',
      shortLabel: '🤖 Baixar App Android',
      icon: '🤖',
      downloadUrl: '/download/app?os=android',
      btnText: '🤖 Instalar App no Android Agora'
    };
  }
  if (/win/.test(plat) || /windows|win64|win32/.test(ua)) {
    return {
      osId: 'windows',
      osName: 'Windows 10 / 11 (64-bit)',
      shortLabel: '🪟 Baixar p/ Windows',
      icon: '🪟',
      downloadUrl: '/download/app?os=windows',
      btnText: '🪟 Baixar Instalador para Windows'
    };
  }
  if (/linux/.test(plat) || /linux|x11|ubuntu/.test(ua)) {
    return {
      osId: 'linux',
      osName: 'Linux (Ubuntu / Debian / Mint • 64-bit)',
      shortLabel: '🐧 Baixar p/ Linux',
      icon: '🐧',
      downloadUrl: '/download/app?os=linux',
      btnText: '🐧 Baixar Instalador para Linux'
    };
  }
  return {
    osId: 'windows',
    osName: 'Multiplataforma (Windows / Android / iOS / Linux)',
    shortLabel: 'Baixar App',
    icon: '🚀',
    downloadUrl: '/download/app?os=windows',
    btnText: '🚀 Baixar Super Navegador Papaléguas'
  };
}

let currentDetectedOs = detectClientOsLocal();

function updateOsModalInstructions(osId) {
  const titleEl = document.getElementById('install-steps-title');
  const s1 = document.getElementById('install-step-1');
  const s2 = document.getElementById('install-step-2');
  const s3 = document.getElementById('install-step-3');
  const cards = document.querySelectorAll('.os-download-card');
  cards.forEach((c) => {
    const isActive = c.getAttribute('data-os') === osId;
    c.style.borderColor = isActive ? 'rgba(56, 189, 248, 0.85)' : 'rgba(255,255,255,0.12)';
    c.style.background = isActive ? 'rgba(2, 132, 199, 0.22)' : 'rgba(255,255,255,0.04)';
    c.style.boxShadow = isActive ? '0 0 14px rgba(56, 189, 248, 0.25)' : 'none';
  });

  if (!titleEl || !s1 || !s2 || !s3) return;

  if (osId === 'windows') {
    titleEl.innerHTML = '🪟 Como instalar no Windows (10 / 11):';
    s1.innerHTML = 'Clique em <strong>"Baixar Instalador para Windows"</strong> (arquivo <code>Instalar-Papaleguas-Windows.cmd</code>).';
    s2.innerHTML = 'Abra o arquivo baixado. Ele criará automaticamente o atalho oficial na sua <strong>Área de Trabalho</strong>.';
    s3.innerHTML = 'Pronto! O <strong>Super Navegador Papaléguas</strong> abrirá em janela própria dedicada sem depender de abas externas.';
  } else if (osId === 'linux') {
    titleEl.innerHTML = '🐧 Como instalar no Linux (Ubuntu / Debian / Mint):';
    s1.innerHTML = 'Clique em <strong>"Baixar Instalador para Linux"</strong> (arquivo <code>instalar-papaleguas-linux.sh</code>).';
    s2.innerHTML = 'Execute no terminal com <code>bash ~/Downloads/instalar-papaleguas-linux.sh</code> ou dê dois cliques.';
    s3.innerHTML = 'O aplicativo nativo e o ícone oficial aparecerão no seu <strong>Menu de Aplicativos</strong> e na Área de Trabalho!';
  } else if (osId === 'ios') {
    titleEl.innerHTML = '🍎 Como instalar no iPhone / iPad (iOS):';
    s1.innerHTML = 'Clique no botão acima para baixar o <strong>Perfil WebClip Oficial (Papaleguas-iOS.mobileconfig)</strong> ou toque no ícone <strong>Compartilhar (⎋)</strong> do Safari.';
    s2.innerHTML = 'No Safari, escolha <strong>"Adicionar à Tela de Início"</strong> (ou instale o perfil baixado em <em>Ajustes → Perfil Baixado</em>).';
    s3.innerHTML = 'O ícone oficial do <strong>Papaléguas</strong> aparecerá na tela do seu iPhone abrindo em tela cheia!';
  } else {
    titleEl.innerHTML = '🤖 Como instalar no Android (Celular / Tablet / TV):';
    s1.innerHTML = 'Toque em <strong>"Instalar App no Android Agora"</strong> acima (ou nos <strong>três pontinhos ⋮</strong> do navegador).';
    s2.innerHTML = 'Confirme em <strong>"Instalar aplicativo"</strong> ou <strong>"Adicionar à tela inicial"</strong>.';
    s3.innerHTML = 'O aplicativo <strong>Papaléguas</strong> será instalado na gaveta de apps do seu Android em tela cheia e sem anúncios!';
  }
}

function applyDetectedOsToUi(osInfo) {
  if (!osInfo) return;
  currentDetectedOs = {
    osId: osInfo.osId || osInfo.os_id || currentDetectedOs.osId,
    osName: osInfo.osName || osInfo.os_name || currentDetectedOs.osName,
    shortLabel: osInfo.shortLabel || osInfo.short_label || currentDetectedOs.shortLabel,
    icon: osInfo.icon || currentDetectedOs.icon,
    downloadUrl: osInfo.downloadUrl || osInfo.download_url || currentDetectedOs.downloadUrl,
    btnText: currentDetectedOs.btnText
  };
  const labelEl = document.getElementById('install-app-label');
  if (labelEl) {
    labelEl.textContent = currentDetectedOs.shortLabel.replace(/^[^\wA-Za-zÀ-ÿ]+\s*/, '');
  }
  if (btnInstallApp) {
    btnInstallApp.title = `Sistema detectado: ${currentDetectedOs.osName} — Clique para baixar o App`;
  }
  const bannerEl = document.getElementById('install-detected-os-banner');
  if (bannerEl) {
    bannerEl.innerHTML = `${currentDetectedOs.icon} Sistema detectado: <strong>${currentDetectedOs.osName}</strong>`;
  }
  const primaryLabel = document.getElementById('btn-trigger-pwa-install-label');
  if (primaryLabel) {
    if (currentDetectedOs.osId === 'windows') primaryLabel.textContent = '🪟 Baixar Instalador para Windows';
    else if (currentDetectedOs.osId === 'linux') primaryLabel.textContent = '🐧 Baixar Instalador para Linux';
    else if (currentDetectedOs.osId === 'ios') primaryLabel.textContent = '🍎 Baixar App para iPhone / iPad (iOS)';
    else primaryLabel.textContent = '🤖 Instalar App no Android Agora';
  }
  updateOsModalInstructions(currentDetectedOs.osId);
}

applyDetectedOsToUi(currentDetectedOs);
fetch('/api/os-detect')
  .then((r) => r.json())
  .then((data) => {
    if (data && data.detected) {
      applyDetectedOsToUi(data.detected);
    }
    if (data && data.appOrigin) {
      const extLink = document.getElementById('install-external-link');
      if (extLink) {
        extLink.href = data.appOrigin;
        extLink.textContent = data.appOrigin;
      }
    }
  })
  .catch(() => {});

function hideInstallAppElements() {
  if (btnInstallApp) {
    btnInstallApp.classList.remove('pulse-install');
  }
}

function checkInstalledState() {
  try {
    try {
      localStorage.removeItem('papaleguas_app_installed');
      sessionStorage.removeItem('papaleguas_app_installed');
      document.cookie = 'papaleguas_app_installed=; path=/; max-age=0';
    } catch (e) {}

    var isStandalone = (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: minimal-ui)').matches)) || window.navigator.standalone === true;
    if (isStandalone) {
      document.documentElement.classList.add('client-standalone');
      if (document.body) document.body.classList.add('client-standalone');
    }
  } catch (e) { swallowed(e, 'renderer:checkInstalledState@716'); }
}
checkInstalledState();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (btnInstallApp) {
    btnInstallApp.classList.add('pulse-install');
  }
});

function trackAppDownloadEvent(type, extra = {}) {
  try {
    fetch('/api/papaleguas/app-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: type || 'app_download',
        platform: navigator.platform || '',
        detectedOs: currentDetectedOs.osId,
        userAgent: (navigator.userAgent || '').slice(0, 100),
        timestamp: new Date().toISOString(),
        ...extra
      })
    }).catch(() => {});
  } catch (e) { swallowed(e, 'renderer:trackAppDownloadEvent@749'); }
}

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  trackAppDownloadEvent('appinstalled');
  hideInstallAppElements();
});

function triggerDownloadForOs(osId) {
  const target = osId || currentDetectedOs.osId || 'windows';
  trackAppDownloadEvent('download_' + target, { targetOs: target });
  updateOsModalInstructions(target);
  if (deferredInstallPrompt && (target === 'android' || target === currentDetectedOs.osId)) {
    try {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then((choiceResult) => {
        if (choiceResult && choiceResult.outcome === 'accepted') {
          deferredInstallPrompt = null;
          trackAppDownloadEvent('prompt_accepted');
          hideInstallAppElements();
        }
      });
    } catch (e) {}
  }
  if (typeof window.__plRunAutoInstall === 'function') {
    window.__plRunAutoInstall(target);
    return;
  }
  window.location.href = '/api/download-app?os=' + encodeURIComponent(target);
}

function openInstallAppModal(autoTrigger = true) {
  if (installAppModal) {
    trackAppDownloadEvent('modal_opened');
    applyDetectedOsToUi(currentDetectedOs);
    installAppModal.classList.remove('hidden');
    installAppModal.style.removeProperty('display');
    if (autoTrigger) {
      triggerDownloadForOs(currentDetectedOs.osId);
    }
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
    if (deferredInstallPrompt && currentDetectedOs.osId === 'android') {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then((choiceResult) => {
        if (choiceResult && choiceResult.outcome === 'accepted') {
          deferredInstallPrompt = null;
          trackAppDownloadEvent('prompt_accepted');
          hideInstallAppElements();
        }
      });
    } else {
      triggerDownloadForOs(currentDetectedOs.osId || 'windows');
    }
  });
}

document.querySelectorAll('.os-download-card').forEach((card) => {
  card.addEventListener('click', (e) => {
    const targetOs = card.getAttribute('data-os') || 'windows';
    updateOsModalInstructions(targetOs);
    if (targetOs === 'android' && deferredInstallPrompt) {
      e.preventDefault();
      triggerDownloadForOs('android');
    } else {
      trackAppDownloadEvent('card_download_' + targetOs, { targetOs });
    }
  });
});

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
        setTimeout(() => { btnCopyInstallLink.textContent = '📋 Copiar Link de Instalação'; }, 2500);
      } catch (err) { swallowed(err, 'renderer:top@846'); }
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
      cachedCastDevices.forEach((d) => { try { onFound(d); } catch (e) { swallowed(e, 'renderer:prefetchCastDevices@872'); } });
    }
    return castScanPromise;
  }
  const listeners = typeof onFound === 'function' ? [onFound] : [];
  const run = (async () => {
    try {
      const devices = await window.PapaleguasClientCast.scanDevices((dev) => {
        if (!dev || !dev.ip) return;
        if (!cachedCastDevices.some((d) => d.ip === dev.ip)) cachedCastDevices.push(dev);
        listeners.forEach((fn) => { try { fn(dev); } catch (e) { swallowed(e, 'renderer:prefetchCastDevices@882'); } });
      });
      if (Array.isArray(devices) && devices.length) cachedCastDevices = devices;
    } catch (e) { swallowed(e, 'renderer:prefetchCastDevices@885'); }
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
  return u.includes('/musica') || u.includes('musica.html') || u.includes('/filmes') || u.includes('/youtube') || u.includes('/baixatube');
}

function isHomeOrBaixaTubeTab(t) {
  if (!t || !t.url) return false;
  const u = String(t.url).toLowerCase();
  if (u.includes('/search') || u.includes('/filmes') || u.includes('/musica')) return false;
  return u.includes('newtab.html') || u.includes('baixatube') || u.includes('/youtube') || u === String(DEFAULT_URL).toLowerCase() || u === 'http://localhost:8080/' || u === 'http://localhost:8080';
}

function playYoutubeVideoInApp(vid, title = 'Vídeo Recomendado') {
  if (!vid) return;
  const cleanTitle = String(title || 'Vídeo Recomendado').replace(/['"\\]/g, '');
  const activeTab = getActiveTab();
  const isCurrentlyOnHome = activeTab && isHomeOrBaixaTubeTab(activeTab);
  if (isCurrentlyOnHome && activeTab.webview) {
    if (typeof activeTab.webview.executeJavaScript === 'function') {
      try {
        activeTab.webview.executeJavaScript(`(function() {
          if (typeof playVideoInHomePlayer === 'function') {
            playVideoInHomePlayer('${vid}', '${cleanTitle}', 'Papaléguas BaixaTube', true, true);
            if (typeof loadSuggestionsForVideo === 'function') loadSuggestionsForVideo({ id: '${vid}' });
            const pSec = document.getElementById('home-player-section');
            if (pSec) pSec.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
          }
          return false;
        })()`).then((ok) => {
          if (!ok) openYoutube('', vid);
        }).catch(() => openYoutube('', vid));
        return;
      } catch (err) { swallowed(err, 'renderer:playYoutubeVideoInApp@executeJS'); }
    }
    if (activeTab.webview.contentWindow && typeof activeTab.webview.contentWindow.postMessage === 'function') {
      try {
        activeTab.webview.contentWindow.postMessage({ type: 'play-youtube-video', id: vid, title: cleanTitle, url: '/baixatube?v=' + encodeURIComponent(vid) }, '*');
        return;
      } catch (err) { swallowed(err, 'renderer:playYoutubeVideoInApp@postMessage'); }
    }
  }
  openYoutube('', vid);
}

function syncPortalHomeButton(url) {
  const on = isPortalTabUrl(url);
  document.documentElement.classList.toggle('portal-home', on);
  document.body.classList.toggle('portal-home', on);
  const btn = document.getElementById('fs-home-btn');
  if (btn) {
    const isBaixatube = url && (url.includes('baixatube') || url.includes('youtube') || url.includes('newtab.html'));
    if (isBaixatube) {
      btn.title = 'Minimizar BaixaTube (Restaurar janela)';
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/></svg><span>Minimizar</span>`;
    } else {
      btn.title = 'Voltar para a Home';
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg><span>Home</span>`;
    }
  }
}

function goHomeFromFullscreen() {
  appVideoFullscreen = false;
  document.documentElement.classList.remove('video-true-fs', 'portal-home', 'fullscreen-video-locked');
  document.body.classList.remove('video-true-fs', 'portal-home', 'fullscreen-video-locked');
  if (typeof hidePageLoading === 'function') hidePageLoading();
  const btn = document.getElementById('fs-home-btn');
  if (btn) {
    btn.style.display = 'none';
  }
  try {
    const exitFs = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exitFs && (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement)) {
      exitFs.call(document);
    }
  } catch (e) { swallowed(e, 'renderer:goHomeFromFullscreen@944'); }

  try {
    const activeTab = getActiveTab();
    if (activeTab && activeTab.webview && typeof activeTab.webview.send === 'function') {
      activeTab.webview.send('exit-fullscreen');
    }
    if (typeof postYoutubeCommand === 'function') {
      postYoutubeCommand('exit-fullscreen');
    }
  } catch (e) {}

  const activeTab = getActiveTab();
  const isMusicTab = activeTab && activeTab.url && (activeTab.url.includes('musica.html') || activeTab.url.includes('/musica'));
  const isMusicActive = lastGlobalMusicState && (lastGlobalMusicState.isPlaying || lastGlobalMusicState.track);

  // Procura aba Home (newtab.html) já carregada ou restaura a Home na aba atual (0ms se em cache)
  let homeTab = tabs.find(t => t.url && (t.url.includes('newtab.html') || t.url === DEFAULT_URL || t.url === '/'));
  if (homeTab && (!activeTab || homeTab.id !== activeTab.id)) {
    homeTab.lastSearchUrl = '';
    activateTab(homeTab.id);
    if (typeof hidePageLoading === 'function') hidePageLoading();
  } else if (activeTab && activeTab.webview) {
    activeTab.lastSearchUrl = '';
    if (typeof activeTab.webview.goToCachedUrl === 'function' && activeTab.webview.goToCachedUrl(DEFAULT_URL)) {
      activeTab.url = DEFAULT_URL;
      if (typeof hidePageLoading === 'function') hidePageLoading();
      updateNavControls(activeTab.webview);
    } else if (typeof activeTab.webview.loadURL === 'function') {
      activeTab.url = DEFAULT_URL;
      activeTab.webview.loadURL(DEFAULT_URL);
      if (typeof hidePageLoading === 'function') hidePageLoading();
      updateNavControls(activeTab.webview);
    } else {
      homeTab = createTab(DEFAULT_URL);
    }
  } else {
    homeTab = createTab(DEFAULT_URL);
  }

  if (isMusicTab && isMusicActive) {
    userDismissedMiniPlayer = false;
    if (globalMusicMiniPlayer) globalMusicMiniPlayer.classList.remove('hidden');
  }
  setAddressBar('');
  if (window.history && typeof window.history.pushState === 'function' && !isElectronApp()) {
    try {
      if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') {
        window.history.pushState({ portal: 'home' }, '', '/');
      }
    } catch (e) { swallowed(e, 'renderer:goHomeFromFullscreen@969'); }
  }
}
window.goHome = goHomeFromFullscreen;

function enterMenuPortalFullscreen() {
  document.documentElement.classList.add('video-true-fs', 'portal-home');
  document.body.classList.add('video-true-fs', 'portal-home');
  const btn = document.getElementById('fs-home-btn');
  if (btn) {
    btn.classList.remove('is-hidden');
    btn.style.display = 'inline-flex';
  }
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

  const callerTab = getActiveTab();
  const callerSearchUrl = (callerTab && (callerTab.lastSearchUrl || (/\/search(?:\?|$)/i.test(callerTab.url || '') ? callerTab.url : ''))) || '';
  const callerTabId = callerTab ? callerTab.id : null;
  
  // Procura se já existe uma aba do Papaléguas Music aberta
  const existingMusicTab = tabs.find(t => t.url && (t.url.includes('musica.html') || t.url.includes('/musica')));
  
  if (existingMusicTab) {
    if (callerTabId && callerTabId !== existingMusicTab.id) {
      existingMusicTab.returnToTabId = callerTabId;
      if (callerSearchUrl) existingMusicTab.lastSearchUrl = callerSearchUrl;
    }
    activateTab(existingMusicTab.id);
    if (typeof hidePageLoading === 'function') hidePageLoading();
    if (existingMusicTab.webview && searchQuery && searchQuery.trim()) {
      try {
        existingMusicTab.webview.send('play-dj-music', { query: searchQuery, autoplay });
      } catch (e) { swallowed(e, 'renderer:openPapaleguasMusic@1009'); }
      existingMusicTab.webview.loadURL(musicaUrl);
    }
  } else {
    // Cria sempre uma aba dedicada para o Papaléguas Music, garantindo que continue tocando em segundo plano
    const newMusicTab = createTab(musicaUrl);
    if (newMusicTab && callerTabId) {
      newMusicTab.returnToTabId = callerTabId;
      if (callerSearchUrl) newMusicTab.lastSearchUrl = callerSearchUrl;
    }
  }
  setAddressBar('');
  syncPortalHomeButton('/musica');
  enterMenuPortalFullscreen();
  if (window.history && typeof window.history.pushState === 'function' && !isElectronApp()) {
    try {
      if (window.location.pathname !== '/musica') {
        window.history.pushState({ portal: 'musica' }, '', '/musica');
      }
    } catch (e) { swallowed(e, 'renderer:openPapaleguasMusic@1024'); }
  }
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

  // Intercepta qualquer URL de vídeo para tocar direto no player BaixaTube
  if (initialUrl && typeof initialUrl === 'string' && !isInternalPortalUrl(initialUrl) && !initialUrl.includes('/baixatube') && !initialUrl.includes('newtab.html')) {
    const ytVid = extractYoutubeVideoId(initialUrl);
    if (ytVid) {
      openYoutube('', ytVid);
      return getActiveTab() || null;
    }
  }

  const currentActiveTab = getActiveTab();
  const currentSearchUrl = (currentActiveTab && (currentActiveTab.lastSearchUrl || (/\/search(?:\?|$)/i.test(currentActiveTab.url || '') ? currentActiveTab.url : ''))) || '';

  // Garante que qualquer aba aberta para URL externa passe obrigatoriamente pela conexão Tor (exceto BaixaTube, Filmes e Música, que são sempre diretos)
  if (initialUrl && typeof initialUrl === 'string' && !isAppShellUrl(initialUrl) && !isInternalPortalUrl(initialUrl) && initialUrl !== DEFAULT_URL && !initialUrl.includes('newtab.html') && !initialUrl.includes('musica.html')) {
    initialUrl = routeUrlInsideTorApp(initialUrl);
  }

  tabCounter++;
  const tabId = 'tab-' + tabCounter;

  // Tab Header Element
  const tabElem = document.createElement('div');
  tabElem.className = 'tab';
  tabElem.id = 'header-' + tabId;
  tabElem.innerHTML = `
    <img src="icon-192.png" alt="Papaléguas" width="18" height="18" decoding="async" style="width: 18px; height: 18px; object-fit: contain;" />
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
    // Mantém páginas vizinhas vivas em cache para que o botão Voltar continue de onde estava sem recarregar.
    const VIEW_CACHE_DISTANCE = 4;
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
    } catch (e) { swallowed(e, 'renderer:createTab@1097'); }

    function activeView() {
      return historyViews[viewIndex] || null;
    }

    // Os eventos do <webview> não sobem para o container, então são repassados
    // na mão — e só os da página que está à vista.
    const FORWARDED_EVENTS = [
      'ipc-message', 'new-window', 'console-message', 'did-start-loading',
      'did-stop-loading', 'did-finish-load', 'page-title-updated', 'will-navigate', 'did-navigate',
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
        try { clone[key] = event[key]; } catch (e) { swallowed(e, 'renderer:relayEvent@1122'); }
      });
      EVENT_FIELDS.forEach((key) => {
        if (clone[key] !== undefined) return;
        try {
          if (event[key] !== undefined) clone[key] = event[key];
        } catch (e) { swallowed(e, 'renderer:relayEvent@1128'); }
      });
      webview.dispatchEvent(clone);
    }

    function buildView(url) {
      const view = document.createElement('webview');
      view.className = 'web-client-frame';
      const uStr = String(url || '').toLowerCase();
      const isDirectPortal = isInternalPortalUrl(url) && !uStr.includes('/proxy') && !uStr.includes('/search') && !uStr.includes('/ipcam-live') && !uStr.includes('/video-watch');
      const partName = isDirectPortal ? 'persist:papaleguas-direct' : 'persist:tor-browser';
      view.setAttribute('partition', partName);
      view.partition = partName;
      view.setAttribute('useragent', pageUserAgent);
      view.useragent = pageUserAgent;
      view.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no, webSecurity=yes, allowRunningInsecureContent=yes, backgroundThrottling=no');
      if (webviewPreload) {
        view.setAttribute('preload', webviewPreload);
        view.preload = webviewPreload;
      }
      // A primeira navegação é a que nós mesmos pedimos; ela não conta como
      // navegação feita por dentro da página.
      view.__plFreshLoad = true;
      view.__plSettled = false;
      view.__plInPage = 0;
      view.__plInPageFwd = 0;
      // about:blank e redirecionamentos deixam canGoBack() verdadeiro. Se o
      // voltar usar isso, a página é baixada de novo em vez de reexibir o cache.
      view.addEventListener('did-stop-loading', () => {
        if (view === activeView() && typeof hidePageLoading === 'function') hidePageLoading();
        if (view.__plSettled) return;
        view.__plSettled = true;
        view.__plFreshLoad = false;
        view.__plSettleAt = Date.now();
        try { view.clearHistory(); } catch (e) { swallowed(e, 'renderer:buildView@1162'); }
        try {
          const url = view.getURL();
          const idx = historyViews.indexOf(view);
          if (idx !== -1 && url && !/^about:blank$/i.test(url)) viewHistory[idx] = url;
        } catch (e) { swallowed(e, 'renderer:buildView@1167'); }
        if (view === activeView() && activeTabId === tabId) updateNavControls(webview);
      });
      view.addEventListener('did-finish-load', () => {
        if (view === activeView() && typeof hidePageLoading === 'function') hidePageLoading();
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
      } catch (e) { swallowed(e, 'renderer:suspendView@1210'); }
      try { view.setAudioMuted(true); } catch (e) { swallowed(e, 'renderer:suspendView@1211'); }
      try {
        view.executeJavaScript(
          'document.querySelectorAll("video,audio").forEach(function(m){try{m.pause()}catch(e){}})'
        ).catch(() => {});
      } catch (e) { swallowed(e, 'renderer:suspendView@1216'); }
    }

    function dismissPageChrome(node) {
      const js = '(function(){var b=document.getElementById("torNavLoading");if(b){b.hidden=true;b.style.display="none";}document.querySelectorAll(".is-opening").forEach(function(n){n.classList.remove("is-opening");});})()';
      try {
        const doc = node && node.contentDocument;
        if (doc) {
          const box = doc.getElementById('torNavLoading');
          if (box) {
            box.hidden = true;
            box.style.display = 'none';
          }
          doc.querySelectorAll('.is-opening').forEach((n) => n.classList.remove('is-opening'));
        }
      } catch (e) { swallowed(e, 'renderer:dismissPageChrome@1228'); }
      try {
        if (node && node.contentWindow) node.contentWindow.postMessage({ type: 'papaleguas-hide-loading' }, '*');
      } catch (e) { swallowed(e, 'renderer:dismissPageChrome@1231'); }
      try {
        if (node && typeof node.executeJavaScript === 'function') node.executeJavaScript(js).catch(() => {});
      } catch (e) { swallowed(e, 'renderer:dismissPageChrome@1234'); }
    }

    function saveViewScroll(v) {
      if (!v || typeof v.executeJavaScript !== 'function') return;
      try {
        Promise.resolve(v.executeJavaScript('({ x: window.scrollX || 0, y: window.scrollY || 0 })', true))
          .then((pos) => { if (pos && typeof pos.y === 'number') v.__plSavedScroll = pos; })
          .catch(() => {});
      } catch (e) {}
    }

    function restoreViewScroll(v) {
      if (!v || !v.__plSavedScroll || v.__plSavedScroll.y <= 0 || typeof v.executeJavaScript !== 'function') return;
      const sx = Number(v.__plSavedScroll.x || 0);
      const sy = Number(v.__plSavedScroll.y || 0);
      const apply = () => {
        try {
          Promise.resolve(v.executeJavaScript(`window.scrollTo(${sx}, ${sy})`, true)).catch(() => {});
        } catch (e) {}
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
      else apply();
    }

    function showView(view) {
      Array.prototype.forEach.call(webview.children, (child) => {
        const visible = child === view;
        if (!visible && child.classList.contains('is-visible')) {
          saveViewScroll(child);
          suspendView(child);
        }
        child.classList.toggle('is-visible', visible);
      });
      if (view) {
        try { view.setAudioMuted(false); } catch (e) { swallowed(e, 'renderer:showView@1244'); }
        dismissPageChrome(view);
        restoreViewScroll(view);
      }
    }

    // As páginas distantes são descartadas para o app não segurar um processo
    // de renderização por item de histórico (mas o Papaléguas Music e páginas de busca são preservados).
    function trimViewCache() {
      historyViews.forEach((view, index) => {
        if (!view) return;
        try {
          const u = (view.src || (typeof view.getURL === 'function' ? view.getURL() : '')) || (viewHistory[index] || '');
          if (u.includes('musica.html') || u.includes('/musica') || u.includes('/filmes') || u.includes('/baixatube') || u.includes('/youtube') || u.includes('newtab.html') || /\/search(?:\?|$)/i.test(u) || /duckduckgo\.com/i.test(u)) {
            return; // Preserva a página de busca (/search) e os portais principais em memória para transição instantânea!
          }
        } catch (e) { swallowed(e, 'renderer:trimViewCache@1260'); }
        if (Math.abs(index - viewIndex) <= VIEW_CACHE_DISTANCE) return;
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
      // Se a aba começou na newtab.html e esta é a primeira navegação real (busca ou site),
      // substitui a Home pelo tema pesquisado para que o voltar retorne ao tema e nunca caia na Home!
      if (viewHistory.length === 1 && (viewHistory[0].includes('newtab.html') || viewHistory[0] === DEFAULT_URL || viewHistory[0] === '/')) {
        viewHistory[0] = url;
        viewIndex = 0;
        return false;
      }
      viewHistory.push(url);
      viewIndex = viewHistory.length - 1;
      return true;
    }

    function openInNewView(url) {
      if (!url) return;
      const isPortal = isInternalPortalUrl(url);
      url = isPortal ? resolveAppNavUrl(url) : routeUrlInsideTorApp(url);
      if (tabObj) tabObj.url = url;
      if (
        sameViewUrl(viewHistory[viewIndex], url) &&
        historyViews[viewIndex] &&
        Date.now() - (webview.__plNavAt || 0) < 600
      ) {
        return;
      }
      webview.__plNavAt = Date.now();
      if (!isPortal && typeof showPageLoading === 'function') showPageLoading(url);
      else if (typeof hidePageLoading === 'function') hidePageLoading();
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

    function findCachedViewIndex(targetUrl) {
      if (!targetUrl) return -1;
      for (let i = viewHistory.length - 1; i >= 0; i--) {
        if (sameViewUrl(viewHistory[i], targetUrl) && historyViews[i] && historyViews[i].isConnected) {
          return i;
        }
      }
      return -1;
    }

    function gotoViewIndex(nextIndex) {
      if (nextIndex < 0 || nextIndex >= viewHistory.length) return;
      const targetUrl = viewHistory[nextIndex];
      const isTargetHome = targetUrl && (targetUrl.includes('newtab.html') || targetUrl === DEFAULT_URL || targetUrl === '/');
      if (isTargetHome && tabObj && tabObj.lastSearchUrl && !sameViewUrl(tabObj.lastSearchUrl, targetUrl)) {
        const cachedSearchIdx = findCachedViewIndex(tabObj.lastSearchUrl);
        if (cachedSearchIdx !== -1) {
          gotoViewIndex(cachedSearchIdx);
          return;
        }
        openInNewView(tabObj.lastSearchUrl);
        return;
      }
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

    webview.goToCachedUrl = (targetUrl) => {
      const idx = findCachedViewIndex(targetUrl);
      if (idx === -1) return false;
      gotoViewIndex(idx);
      return true;
    };

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
      try { view.reload(); } catch (e) { swallowed(e, 'renderer:createTab@1351'); }
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
      if (!view) return false;
      if (view.__plInPage > 0) return true;
      if (viewIndex <= 0) {
        try {
          if (typeof view.canGoBack === 'function' && view.canGoBack()) return true;
        } catch (e) {}
      }
      return false;
    }
    function viewHasInPageForward() {
      const view = activeView();
      if (!view) return false;
      if (view.__plInPageFwd > 0) return true;
      try {
        if (typeof view.canGoForward === 'function' && view.canGoForward()) return true;
      } catch (e) {}
      return false;
    }
    webview.canGoBack = () => {
      if (viewHasInPageBack()) return true;
      if (viewIndex <= 0) return false;
      const curUrl = String(viewHistory[viewIndex] || '').toLowerCase();
      const prevUrl = String(viewHistory[viewIndex - 1] || '').toLowerCase();
      const isPrevHome = prevUrl.includes('newtab.html') || prevUrl === String(DEFAULT_URL).toLowerCase() || prevUrl === '/' || prevUrl === 'http://localhost:8080/';
      if (isPrevHome && viewIndex === 1 && curUrl.includes('/search')) {
        return false;
      }
      return true;
    };
    webview.canGoForward = () => viewHasInPageForward() || viewIndex < viewHistory.length - 1;
    webview.goBack = () => {
      const view = activeView();
      if (view && view.__plInPage > 0) {
        view.__plInPage -= 1;
        view.__plInPageFwd = (view.__plInPageFwd || 0) + 1;
        view.__plIgnoreInPage = true;
        try { view.goBack(); } catch (e) { swallowed(e, 'renderer:createTab@1381'); }
        if (activeTabId === tabId) updateNavControls(webview);
        return;
      }
      if (viewIndex > 0) {
        gotoViewIndex(viewIndex - 1);
        return;
      }
      if (view) {
        try {
          if (typeof view.canGoBack === 'function' && view.canGoBack()) {
            view.goBack();
            if (activeTabId === tabId) updateNavControls(webview);
            return;
          }
        } catch (e) {}
      }
    };
    webview.goForward = () => {
      const view = activeView();
      if (view) {
        if (view.__plInPageFwd > 0) {
          view.__plInPageFwd -= 1;
          view.__plInPage = (view.__plInPage || 0) + 1;
          view.__plIgnoreInPage = true;
          try { view.goForward(); } catch (e) { swallowed(e, 'renderer:createTab@1393'); }
          if (activeTabId === tabId) updateNavControls(webview);
          return;
        }
        try {
          if (typeof view.canGoForward === 'function' && view.canGoForward()) {
            view.goForward();
            if (activeTabId === tabId) updateNavControls(webview);
            return;
          }
        } catch (e) {}
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
        } catch (e) { swallowed(e, 'renderer:set@1408'); }
        try {
          if (typeof current.setUserAgent === 'function') {
            current.setUserAgent(value);
          } else {
            current.useragent = value;
            current.setAttribute('useragent', value);
          }
        } catch (e) { swallowed(e, 'renderer:set@1409'); }
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
        if (parsed.origin === window.location.origin || parsed.origin === publicAppOrigin() || /^(localhost|127\.0\.0\.1|0\.0\.0\.0):8080$/i.test(parsed.host)) {
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
              } catch (err) { swallowed(err, 'renderer:resolveIframeUrl@1462'); }
            }
            const rawProxy = parsed.pathname + parsed.search;
            return (typeof window.encryptPplSearchUrl === 'function') ? window.encryptPplSearchUrl(rawProxy) : rawProxy;
          }
          if (/^\/(search|youtube|filmes|musica|baixatube|ip-check|ipcam-live|video-watch|papaleguas|api)/.test(parsed.pathname) || /newtab\.html|musica\.html/.test(path)) {
            return path.startsWith('/') ? resolveAppNavUrl(path) : path;
          }
          return path.startsWith('/') ? resolveAppNavUrl(path) : path;
        }
      } catch (e) { swallowed(e, 'renderer:resolveIframeUrl@1471'); }
      if (
        u.includes('newtab.html') || 
        u.includes('musica.html') ||
        u.startsWith('/musica') ||
        u.startsWith('/youtube') ||
        u.startsWith('/baixatube') ||
        u.startsWith('/search') || 
        u.startsWith('/filmes') || 
        u.startsWith('/ipcam-live') || 
        u.startsWith('/video-watch') || 
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
        } catch (e) { swallowed(e, 'renderer:resolveIframeUrl@1505'); }
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (vid) params.set('v', vid);
        const qs = params.toString();
        return '/baixatube' + (qs ? '?' + qs : '');
      }

      if (u.startsWith('http://') || u.startsWith('https://')) {
        const rawProxy = `/proxy?url=${encodeURIComponent(u)}&clientId=${encodeURIComponent(CLIENT_ID)}`;
        return (typeof window.encryptPplSearchUrl === 'function') ? window.encryptPplSearchUrl(rawProxy) : rawProxy;
      }
      return u;
    };

    const iframeHistory = [initialUrl];
    const historyFrames = [];
    // Distância máxima, em páginas, que continua guardada em volta da atual.
    const FRAME_CACHE_DISTANCE = 5;
    let iframeHistoryIndex = 0;
    let ignoreNextHistoryPush = false;

    function currentHistoryUrl() {
      return iframeHistory[iframeHistoryIndex] || '';
    }

    function buildFrame(url) {
      const frame = document.createElement('iframe');
      frame.className = 'web-client-frame';
      frame.title = 'Conteúdo da Página Papaléguas';
      frame.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock; clipboard-write; camera; microphone; web-share');
      frame.setAttribute('allowfullscreen', 'true');
      // Sem allow-top-navigation e sem allow-popups: nenhum site pode escapar do iframe ou abrir aba fora da rede Tor
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-presentation allow-pointer-lock allow-orientation-lock allow-storage-access-by-user-activation');
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
          try { media.pause(); } catch (e) { swallowed(e, 'renderer:pauseFrameMedia@1555'); }
        });
      } catch (e) { swallowed(e, 'renderer:pauseFrameMedia@1557'); }
      try {
        if (frame && frame.contentWindow) {
          frame.contentWindow.postMessage({ type: 'papaleguas-yt-control', action: 'pause' }, '*');
        }
      } catch (e) { swallowed(e, 'renderer:pauseFrameMedia@1562'); }
    }

    function saveFrameScroll(f) {
      try {
        const win = f && f.contentWindow;
        const doc = f && f.contentDocument;
        if (!win) return;
        f.__plSavedScrollY = win.scrollY || (doc && doc.documentElement && doc.documentElement.scrollTop) || (doc && doc.body && doc.body.scrollTop) || 0;
        f.__plSavedScrollX = win.scrollX || (doc && doc.documentElement && doc.documentElement.scrollLeft) || 0;
      } catch (e) {}
    }

    function restoreFrameScroll(f) {
      if (!f || typeof f.__plSavedScrollY !== 'number' || f.__plSavedScrollY <= 0) return;
      const targetY = f.__plSavedScrollY;
      const targetX = f.__plSavedScrollX || 0;
      const apply = () => {
        try {
          if (f.contentWindow && typeof f.contentWindow.scrollTo === 'function') {
            f.contentWindow.scrollTo(targetX, targetY);
          }
        } catch (e) {}
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
      else apply();
    }

    function showFrame(frame) {
      Array.prototype.forEach.call(webview.children, (child) => {
        const visible = child === frame;
        if (!visible && child.classList.contains('is-visible')) {
          saveFrameScroll(child);
          pauseFrameMedia(child);
        }
        child.classList.toggle('is-visible', visible);
      });
      if (!frame) return;
      restoreFrameScroll(frame);
      try {
        const doc = frame.contentDocument;
        if (doc) {
          const box = doc.getElementById('torNavLoading');
          if (box) {
            box.hidden = true;
            box.style.display = 'none';
          }
          doc.querySelectorAll('.is-opening').forEach((n) => n.classList.remove('is-opening'));
        }
      } catch (e) { swallowed(e, 'renderer:showFrame@1579'); }
      try {
        if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'papaleguas-hide-loading' }, '*');
      } catch (e) { swallowed(e, 'renderer:showFrame@1582'); }
    }

    // Guarda só as páginas vizinhas à atual; as distantes são descartadas
    // para o navegador não segurar memória à toa (páginas de busca são mantidas).
    function trimFrameCache() {
      historyFrames.forEach((frame, index) => {
        if (!frame) return;
        if (Math.abs(index - iframeHistoryIndex) <= FRAME_CACHE_DISTANCE) return;
        const u = iframeHistory[index] || '';
        if (u.includes('musica.html') || u.includes('/musica') || u.includes('/filmes') || u.includes('/baixatube') || u.includes('/youtube') || /\/search(?:\?|$)/i.test(u) || /duckduckgo\.com/i.test(u)) return;
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
      if (!url || sameHistoryUrl(currentHistoryUrl(), url)) return false;
      // Navegar depois de voltar descarta o "avançar": esses iframes saem do DOM.
      historyFrames.slice(iframeHistoryIndex + 1).forEach((frame) => {
        if (frame) frame.remove();
      });
      iframeHistory.splice(iframeHistoryIndex + 1);
      historyFrames.splice(iframeHistoryIndex + 1);
      // Se a aba começou na newtab.html e esta é a primeira navegação (busca ou site),
      // substitui a Home pelo tema pesquisado para que o voltar retorne ao tema e nunca caia na Home!
      if (iframeHistory.length === 1 && (iframeHistory[0].includes('newtab.html') || iframeHistory[0] === DEFAULT_URL || iframeHistory[0] === '/')) {
        iframeHistory[0] = url;
        iframeHistoryIndex = 0;
        return false;
      }
      iframeHistory.push(url);
      iframeHistoryIndex = iframeHistory.length - 1;
      // Sincroniza o histórico nativo do navegador/celular a cada nova página (inclusive cliques dentro do iframe)
      try {
        if (!window.__papaleguasHandlingPopstate && window.history && typeof window.history.pushState === 'function' && !isElectronApp()) {
          window.history.pushState({ appNav: true, tabId: tabId, url: url }, '', window.location.pathname);
        }
      } catch (e) {}
      return true;
    }

    function applyIframeUrl(url, record) {
      if (tabObj) {
        tabObj.url = url;
        if (/\/search(?:\?|$)/i.test(String(url || ''))) {
          tabObj.lastSearchUrl = url;
        }
      }
      const pushed = record ? pushIframeHistory(url) : false;
      ignoreNextHistoryPush = true;
      if (!isInternalPortalUrl(url) && typeof showPageLoading === 'function') showPageLoading(url);
      else if (typeof hidePageLoading === 'function') hidePageLoading();
      const replaced = pushed ? null : historyFrames[iframeHistoryIndex];
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

    function findCachedFrameIndex(targetUrl) {
      if (!targetUrl) return -1;
      for (let i = iframeHistory.length - 1; i >= 0; i--) {
        if (sameHistoryUrl(iframeHistory[i], targetUrl) && historyFrames[i] && historyFrames[i].isConnected) {
          return i;
        }
      }
      return -1;
    }

    // Voltar/avançar: se a página já está carregada, é só mostrar de novo.
    function gotoHistoryIndex(nextIndex) {
      if (nextIndex < 0 || nextIndex >= iframeHistory.length) return;
      const targetUrl = iframeHistory[nextIndex];
      const isTargetHome = targetUrl && (targetUrl.includes('newtab.html') || targetUrl === DEFAULT_URL || targetUrl === '/');
      if (isTargetHome && tabObj && tabObj.lastSearchUrl && !sameViewUrl(tabObj.lastSearchUrl, targetUrl)) {
        const cachedSearchIdx = findCachedFrameIndex(tabObj.lastSearchUrl);
        if (cachedSearchIdx !== -1) {
          gotoHistoryIndex(cachedSearchIdx);
          return;
        }
        applyIframeUrl(tabObj.lastSearchUrl, false);
        return;
      }
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

    webview.goToCachedUrl = (targetUrl) => {
      const idx = findCachedFrameIndex(targetUrl);
      if (idx === -1) return false;
      gotoHistoryIndex(idx);
      return true;
    };

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
    webview.goBack = () => {
      const frame = activeFrame();
      if (frame && frame.__plInFrameSteps > 0) {
        try {
          if (frame.contentWindow && frame.contentWindow.history) {
            frame.__plInFrameSteps -= 1;
            frame.__plInFrameFwd = (frame.__plInFrameFwd || 0) + 1;
            if (iframeHistoryIndex > 0) {
              historyFrames[iframeHistoryIndex - 1] = frame;
              historyFrames[iframeHistoryIndex] = null;
              iframeHistoryIndex -= 1;
              if (tabObj) tabObj.url = iframeHistory[iframeHistoryIndex] || tabObj.url;
            }
            ignoreNextHistoryPush = true;
            frame.contentWindow.history.back();
            if (activeTabId === tabId) {
              setAddressBar(currentHistoryUrl());
              updateNavControls(webview);
            }
            return;
          }
        } catch (e) {}
      }
      if (iframeHistoryIndex > 0) {
        const curUrl = iframeHistory[iframeHistoryIndex];
        let targetIdx = iframeHistoryIndex - 1;
        // Pula entradas adjacentes duplicadas (ex: redirects) para voltar em 1 único clique
        while (targetIdx > 0 && sameHistoryUrl(iframeHistory[targetIdx], curUrl)) {
          targetIdx -= 1;
        }
        gotoHistoryIndex(targetIdx);
        return;
      }
      try {
        if (frame && frame.contentWindow && frame.contentWindow.history && frame.contentWindow.history.length > 1) {
          frame.contentWindow.history.back();
          return;
        }
      } catch (e) {}
    };
    webview.goForward = () => {
      const frame = activeFrame();
      if (frame && frame.__plInFrameFwd > 0) {
        try {
          if (frame.contentWindow && frame.contentWindow.history) {
            frame.__plInFrameFwd -= 1;
            frame.__plInFrameSteps = (frame.__plInFrameSteps || 0) + 1;
            if (iframeHistoryIndex < iframeHistory.length - 1) {
              historyFrames[iframeHistoryIndex + 1] = frame;
              historyFrames[iframeHistoryIndex] = null;
              iframeHistoryIndex += 1;
              if (tabObj) tabObj.url = iframeHistory[iframeHistoryIndex] || tabObj.url;
            }
            ignoreNextHistoryPush = true;
            frame.contentWindow.history.forward();
            if (activeTabId === tabId) {
              setAddressBar(currentHistoryUrl());
              updateNavControls(webview);
            }
            return;
          }
        } catch (e) {}
      }
      if (iframeHistoryIndex < iframeHistory.length - 1) {
        gotoHistoryIndex(iframeHistoryIndex + 1);
        return;
      }
      try {
        if (frame && frame.contentWindow && frame.contentWindow.history) {
          frame.contentWindow.history.forward();
          return;
        }
      } catch (e) {}
    };
    webview.canGoBack = () => {
      if (iframeHistoryIndex <= 0) return false;
      const curUrl = String(iframeHistory[iframeHistoryIndex] || '').toLowerCase();
      const prevUrl = String(iframeHistory[iframeHistoryIndex - 1] || '').toLowerCase();
      const isPrevHome = prevUrl.includes('newtab.html') || prevUrl === String(DEFAULT_URL).toLowerCase() || prevUrl === '/' || prevUrl === 'http://localhost:8080/';
      if (isPrevHome && iframeHistoryIndex === 1 && curUrl.includes('/search')) {
        return false;
      }
      return true;
    };
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
              if (tabObj) {
                tabObj.url = recorded;
                if (/\/search(?:\?|$)/i.test(recorded)) tabObj.lastSearchUrl = recorded;
              }
            }
          } else if (recorded && !sameHistoryUrl(currentHistoryUrl(), recorded) && !sameHistoryUrl(currentHistoryUrl(), loc.href)) {
            // O mesmo iframe navegou para outra página interna ou resultado.
            // Registra a nova URL empurrando no histórico e marca passos internos para usar bfcache ao voltar!
            const prevIdx = iframeHistoryIndex;
            const pushed = pushIframeHistory(recorded);
            if (pushed) {
              historyFrames[prevIdx] = null;
              historyFrames[iframeHistoryIndex] = frame;
              frame.__plInFrameSteps = (frame.__plInFrameSteps || 0) + 1;
              frame.__plInFrameFwd = 0;
            }
            if (tabObj) {
              tabObj.url = recorded;
              if (/\/search(?:\?|$)/i.test(recorded)) tabObj.lastSearchUrl = recorded;
            }
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
    if (typeof shouldShowNavLoading === 'function' && shouldShowNavLoading(initialUrl)) {
      if (typeof showPageLoading === 'function') showPageLoading(initialUrl, 'link');
    }
  }

  const tabObj = {
    id: tabId,
    header: tabElem,
    webview: webview,
    url: initialUrl,
    title: 'Papaléguas',
    lastSearchUrl: currentSearchUrl,
    openerTabId: currentActiveTab ? currentActiveTab.id : null
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
  if (initialUrl && initialUrl !== DEFAULT_URL && !String(initialUrl).includes('newtab.html')) {
    try {
      if (!window.__papaleguasHandlingPopstate && window.history && typeof window.history.pushState === 'function' && !isElectronApp()) {
        window.history.pushState({ appNav: true, tabId: tabId, url: initialUrl }, '', window.location.pathname);
      }
    } catch (e) {}
  }
  return tabObj;
}

function activateTab(tabId) {
  if (activeTabId && activeTabId !== tabId) {
    previousActiveTabId = activeTabId;
  }
  activeTabId = tabId;
  const musicTab = getMusicTab();
  const hasActiveMusic = lastGlobalMusicState && (lastGlobalMusicState.isPlaying || lastGlobalMusicState.track);

  tabs.forEach(tab => {
    const isThisMusicTab = tab.url && (tab.url.includes('musica.html') || tab.url.includes('/musica'));

    if (tab.id === tabId) {
      tab.header.classList.add('active');
      tab.webview.classList.add('active');
      tab.webview.classList.remove('is-audio-background');

      const isNewTab = tab.url && (tab.url.includes('newtab.html') || tab.url === DEFAULT_URL || tab.url === '/');
      if (!isPortalTabUrl(tab.url)) {
        appVideoFullscreen = false;
        document.documentElement.classList.remove('video-true-fs', 'portal-home', 'fullscreen-video-locked');
        document.body.classList.remove('video-true-fs', 'portal-home', 'fullscreen-video-locked');
      }
      if (typeof hidePageLoading === 'function') hidePageLoading();
      setAddressBar(isNewTab ? '' : (tab.url || ''));
      syncPortalHomeButton(tab.url);
      urlInput.placeholder = isNewTab ? '✨ Pergunte ao GPT Astra ou digite uma URL...' : 'Digite uma URL ou pesquise com segurança...';
      updateNavControls(tab.webview);
      if (typeof updateReactivateButtonVisibility === 'function') {
        updateReactivateButtonVisibility(getSiteHost(tab.url));
      }
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
      // Nova aba pedida pela página: só abre link externo se estiver conectado ao Tor (evita vazamento de IP).
      const rawUrl = event.args[0];
      const ytVid = extractYoutubeVideoId(rawUrl);
      if (ytVid) {
        createTab('/baixatube?v=' + encodeURIComponent(ytVid));
        return;
      }
      const isInternalTarget = String(rawUrl || '').startsWith('/') && !/^\/proxy(?:\?|$)/i.test(String(rawUrl || ''));
      const isLocalTarget = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(String(rawUrl || ''));
      if (!isInternalTarget && !isLocalTarget && window.torBrowserAPI && typeof window.torBrowserAPI.getTorStatus === 'function') {
        window.torBrowserAPI.getTorStatus().then(async (st) => {
          if (!st || !st.connected) {
            if (typeof window.torBrowserAPI.toggleTor === 'function') {
              try { st = await window.torBrowserAPI.toggleTor(true); } catch (e) {}
            }
          }
          const urlToOpen = routeUrlInsideTorApp(rawUrl);
          if (urlToOpen && !isAppShellUrl(urlToOpen)) {
            if (typeof showPageLoading === 'function') showPageLoading(urlToOpen, 'link');
            createTab(urlToOpen);
          }
        }).catch(() => {});
        return;
      }
      const urlToOpen = routeUrlInsideTorApp(rawUrl);
      if (urlToOpen && !isAppShellUrl(urlToOpen)) {
        if (typeof showPageLoading === 'function') showPageLoading(urlToOpen, 'link');
        createTab(urlToOpen);
      }
    } else if (event.channel === 'page-loading') {
      const pArg = event.args[0];
      const loadUrl = typeof pArg === 'string' ? pArg : (pArg && pArg.url) || '';
      const loadKind = (pArg && pArg.kind) || 'link';
      if (typeof showPageLoading === 'function') showPageLoading(loadUrl, loadKind);
    } else if (event.channel === 'page-loaded') {
      if (typeof hidePageLoading === 'function') hidePageLoading();
    } else if (event.channel === 'get-adblock-status') {
      try {
        const status = await window.torBrowserAPI.getAdblockStatus();
        wv.send('adblock-status-changed', status);
      } catch (e) { swallowed(e, 'renderer:setupWebviewListeners@1887'); }
    } else if (event.channel === 'allow-native-navigation') {
      wv.__plAllowNativeNav = true;
      setTimeout(() => { wv.__plAllowNativeNav = false; }, 1500);
    } else if (event.channel === 'play-youtube-video') {
      const arg = event.args[0];
      const vid = typeof arg === 'object' ? (arg.id || arg.v) : arg;
      const title = (typeof arg === 'object' && arg.title) || 'Vídeo';
      if (vid) playYoutubeVideoInApp(vid, title);
    } else if (event.channel === 'play-dj-music') {
      const arg = event.args[0];
      const query = typeof arg === 'object' ? (arg.query || arg.q) : String(arg || '');
      openPapaleguasMusic(query, true);
    } else if (event.channel === 'navigate-current-tab') {
      const target = event.args[0];
      const ytVid = extractYoutubeVideoId(target);
      if (ytVid) {
        playYoutubeVideoInApp(ytVid);
        return;
      }
      if (/(?:^|\/)filmes?(?:[/?#]|$)/i.test(String(target))) {
        let fq = '';
        try {
          const u = new URL(target, window.location.origin || 'http://localhost:8080');
          fq = u.searchParams.get('q') || '';
        } catch (e) {}
        openFilmesOnline(fq);
        return;
      }
      if (/(?:\/musica|musica\.html|spotify\.com|deezer\.com)/i.test(String(target))) {
        let mq = '';
        try {
          const u = new URL(target, window.location.origin);
          mq = u.searchParams.get('q') || u.searchParams.get('play') || '';
        } catch (e) { swallowed(e, 'renderer:setupWebviewListeners@1912'); }
        openPapaleguasMusic(mq, true);
        return;
      }
      const urlToOpen = routeUrlInsideTorApp(target);
      if (urlToOpen && !isAppShellUrl(urlToOpen)) {
        if (tab && (/\/search(?:\?|$)/i.test(tab.url || '') || /duckduckgo\.com/i.test(tab.url || ''))) {
          tab.lastSearchUrl = tab.url;
        }
        if (typeof showPageLoading === 'function') showPageLoading(urlToOpen, 'link');
        tab.url = urlToOpen;
        wv.loadURL(urlToOpen);
      }
    } else if (event.channel === 'media-video-detected') {
      const videoData = event.args[0];
      if (videoData) {
        if (!videoData.pageUrl && tab && tab.url) {
          videoData.pageUrl = tab.url;
        }
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
    } else if (event.channel === 'go-back') {
      if (typeof handleGoBack === 'function') handleGoBack();
    } else if (event.channel === 'video-watch') {
      const payload = event.args[0] || {};
      if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(!!payload.active);
    } else if (event.channel === 'enter-video-fullscreen') {
      appVideoFullscreen = true;
      if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(true);
      document.documentElement.classList.add('video-true-fs');
      document.body.classList.add('video-true-fs');
      const act = getActiveTab();
      if (act && act.webview) updateNavControls(act.webview);
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
      } catch (e) { swallowed(e, 'renderer:setupWebviewListeners@1957'); }
      const act = getActiveTab();
      if (act && act.webview) updateNavControls(act.webview);
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
    if (e.url) {
      const vid = extractYoutubeVideoId(e.url);
      if (vid) {
        playYoutubeVideoInApp(vid);
        return;
      }
      createTab(routeUrlInsideTorApp(e.url));
    }
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
      if (isInternalPortalUrl(tab.url)) {
        footerStatus.textContent = 'Pronto';
        if (typeof hidePageLoading === 'function') hidePageLoading();
      } else {
        footerStatus.textContent = 'Carregando ' + (tab.url.includes('newtab.html') ? 'Papaléguas' : tab.url) + '...';
        if (typeof showPageLoading === 'function') showPageLoading(tab.url);
      }
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

  wv.addEventListener('did-stop-loading', () => {
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
    if (e.url) {
      const vid = extractYoutubeVideoId(e.url);
      if (vid) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        try { if (wv.stop) wv.stop(); } catch (err) { swallowed(err, 'renderer:setupWebviewListeners@2046'); }
        playYoutubeVideoInApp(vid);
        return;
      }
      if (/(?:\/musica|musica\.html|open\.spotify\.com|deezer\.com)/i.test(e.url)) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        let query = '';
        try {
          const u = new URL(e.url, window.location.origin);
          query = u.searchParams.get('q') || u.searchParams.get('play') || '';
        } catch (err) { swallowed(err, 'renderer:setupWebviewListeners@2056'); }
        const searchMatch = e.url.match(/open\.spotify\.com\/search\/([^/?#]+)/i);
        if (searchMatch && searchMatch[1]) {
          query = decodeURIComponent(searchMatch[1]);
        }
        try {
          if (wv.stop) wv.stop();
        } catch (err) { swallowed(err, 'renderer:setupWebviewListeners@2063'); }
        openPapaleguasMusic(query, true);
        return;
      }
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
      } catch (err) { swallowed(err, 'renderer:setupWebviewListeners@2082'); }
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
      if (typeof updateReactivateButtonVisibility === 'function') {
        updateReactivateButtonVisibility(getSiteHost(e.url));
      }

      if (e.url && (e.url.includes('youtube.com/watch') || e.url.includes('youtu.be/'))) {
        if (typeof syncPlaybackWithConnectedTv === 'function') {
          syncPlaybackWithConnectedTv(e.url);
        }
      }
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
      } catch (err) { swallowed(err, 'renderer:setupWebviewListeners@2115'); }
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
      if (typeof updateReactivateButtonVisibility === 'function') {
        updateReactivateButtonVisibility(getSiteHost(e.url));
      }
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
      try { wv.reload(); } catch(e) { swallowed(e, 'renderer:setupWebviewListeners@2143'); }
    }
  });

  wv.addEventListener('render-process-gone', (e) => {
    console.warn('Render process gone:', e.reason);
    if (activeTabId === tab.id) {
      footerStatus.textContent = `Processo finalizado (${e.reason}). Recarregando...`;
      try { wv.reload(); } catch(e) { swallowed(e, 'renderer:setupWebviewListeners@2151'); }
    }
  });
}

function updateFloatingNavPill(canBack, canForward) {
  const pill = document.getElementById('floating-nav-pill');
  const fBack = document.getElementById('floating-nav-back');
  const fFwd = document.getElementById('floating-nav-forward');
  if (!pill || !fBack || !fFwd) return;

  const hasHistory = !!(canBack || canForward);
  if (!hasHistory) {
    pill.classList.add('is-hidden');
    pill.hidden = true;
    return;
  }

  pill.hidden = false;
  pill.classList.remove('is-hidden');

  fBack.disabled = !canBack;
  fBack.classList.toggle('is-disabled', !canBack);

  fFwd.disabled = !canForward;
  fFwd.classList.toggle('is-disabled', !canForward);
}

function canActiveTabGoBack() {
  const activeTab = getActiveTab();
  if (!activeTab || !activeTab.webview) return false;
  const isPortalFsOnly = document.body.classList.contains('portal-home') || document.documentElement.classList.contains('portal-home');
  const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  if (appVideoFullscreen || isNativeFs || (!isPortalFsOnly && (document.body.classList.contains('video-true-fs') || document.documentElement.classList.contains('video-true-fs')))) {
    return true;
  }
  const curUrl = String(activeTab.url || '').toLowerCase();
  const isStrictHome = curUrl === '' || curUrl === '/' || curUrl.includes('newtab.html') || curUrl === String(DEFAULT_URL || '').toLowerCase();
  if (isStrictHome) {
    return typeof activeTab.webview.canGoBack === 'function' && activeTab.webview.canGoBack();
  }
  if (activeTab.returnToTabId && tabs.some(t => t.id === activeTab.returnToTabId)) return true;
  if (typeof activeTab.webview.canGoBack === 'function' && activeTab.webview.canGoBack()) return true;
  if (activeTab.lastSearchUrl && !sameViewUrl(activeTab.url, activeTab.lastSearchUrl)) return true;
  if (activeTab.openerTabId && tabs.some(t => t.id === activeTab.openerTabId)) return true;
  if (curUrl.includes('/filmes') || curUrl.includes('/musica') || curUrl.includes('musica.html') || curUrl.includes('/baixatube') || curUrl.includes('/youtube')) {
    return true;
  }
  // Se a aba atual não tem páginas anteriores no histórico mas não é a Home ou veio de outra aba:
  const isHome = isHomeOrBaixaTubeTab(activeTab);
  if (!isHome && (activeTab.lastSearchUrl || previousActiveTabId)) return true;
  if (previousActiveTabId && tabs.some(t => t.id === previousActiveTabId) && previousActiveTabId !== activeTab.id) return true;
  return false;
}

function handleGoBack() {
  const activeTab = getActiveTab();
  if (!activeTab || !activeTab.webview) return;

  // 0. Se o player de vídeo estiver em tela cheia REAL (não apenas modo portal /musica, /filmes, /baixatube),
  // o Voltar recolhe o vídeo primeiro. Em portais normais, volta imediatamente no 1º clique!
  const isPortalFsOnly = document.body.classList.contains('portal-home') || document.documentElement.classList.contains('portal-home');
  const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  const isRealVideoFs = appVideoFullscreen || isNativeFs || (!isPortalFsOnly && (document.body.classList.contains('video-true-fs') || document.documentElement.classList.contains('video-true-fs')));
  if (isRealVideoFs) {
    appVideoFullscreen = false;
    if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(false);
    document.documentElement.classList.remove('video-true-fs', 'fullscreen-video-locked');
    document.body.classList.remove('video-true-fs', 'fullscreen-video-locked');
    try {
      const exitFs = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exitFs && isNativeFs) {
        exitFs.call(document);
      }
    } catch (e) {}
    try {
      if (typeof postYoutubeCommand === 'function') postYoutubeCommand('exit-fullscreen');
      if (typeof activeTab.webview.executeJavaScript === 'function') {
        activeTab.webview.executeJavaScript('(function(){ if (typeof window.exitVideoFullscreen === "function") window.exitVideoFullscreen(); if (typeof window.minimizeCinemaVideo === "function") window.minimizeCinemaVideo(); })()').catch(() => {});
      }
    } catch (e) {}
    updateNavControls(activeTab.webview);
    return;
  }

  // 1. Se abriu vídeo ou música a partir de uma busca/Home, o Voltar retorna direto à aba de origem
  if (activeTab.returnToTabId && tabs.some(t => t.id === activeTab.returnToTabId)) {
    const returnId = activeTab.returnToTabId;
    activeTab.returnToTabId = null;
    const targetTab = tabs.find(t => t.id === returnId);
    const targetIsHome = targetTab && (!targetTab.url || targetTab.url.includes('newtab.html') || targetTab.url === DEFAULT_URL || targetTab.url === '/');
    if (targetIsHome) {
      goHomeFromFullscreen();
      return;
    }
    activateTab(returnId);
    return;
  }

  // 2. Histórico da própria aba (links navegados pelo usuário: Link B -> Link A -> Busca)
  if (typeof activeTab.webview.canGoBack === 'function' && activeTab.webview.canGoBack()) {
    activeTab.webview.goBack();
    return;
  }

  // 2.5. Se a aba foi aberta a partir de outra aba (ex: link de resultado aberto em nova aba a partir de /search),
  // retorna diretamente para a aba de origem sem duplicar a busca na aba atual!
  if (activeTab.openerTabId) {
    const openerTab = tabs.find(t => t.id === activeTab.openerTabId);
    if (openerTab && !isHomeOrBaixaTubeTab(openerTab)) {
      activateTab(openerTab.id);
      return;
    }
  }

  // 3. Se a aba veio de uma busca anterior registrada e estamos em outro site ou link:
  // Volta ao tema pesquisado!
  const targetSearchUrl = activeTab.lastSearchUrl || '';
  if (targetSearchUrl && !sameViewUrl(activeTab.url, targetSearchUrl)) {
    // NÃO anula activeTab.lastSearchUrl: mantém o tema pesquisado como âncora permanente
    activeTab.lastSearchUrl = targetSearchUrl;
    if (typeof activeTab.webview.goToCachedUrl === 'function' && activeTab.webview.goToCachedUrl(targetSearchUrl)) {
      return;
    }
    if (typeof activeTab.webview.loadURL === 'function') {
      activeTab.webview.loadURL(targetSearchUrl);
    } else {
      activeTab.url = targetSearchUrl;
      activeTab.webview.src = targetSearchUrl;
    }
    return;
  }

  // Se já estamos na página de busca, não volta para a Home ao clicar em Voltar
  const isSearchPage = activeTab.url && (/\/search(?:\?|$)/i.test(activeTab.url) || /duckduckgo\.com/i.test(activeTab.url));
  if (isSearchPage) {
    return;
  }

  // 4. Se a aba foi aberta a partir de outra aba (evita pular direto para Home se houver busca)
  if (activeTab.openerTabId) {
    const openerTab = tabs.find(t => t.id === activeTab.openerTabId);
    if (openerTab && !isHomeOrBaixaTubeTab(openerTab)) {
      activateTab(activeTab.openerTabId);
      return;
    }
  }

  // 5. Se há uma aba anterior ativa registrada (não Home)
  if (previousActiveTabId && previousActiveTabId !== activeTab.id) {
    const prevTab = tabs.find(t => t.id === previousActiveTabId);
    if (prevTab && !isHomeOrBaixaTubeTab(prevTab)) {
      activateTab(previousActiveTabId);
      return;
    }
  }

  // 6. NUNCA volta para a Home se estivermos em uma pesquisa (/search) ou houver busca registrada!
  const curTabUrl = String(activeTab.url || '').toLowerCase();
  const isPortalExitToHome = curTabUrl.includes('/filmes') || curTabUrl.includes('/musica') || curTabUrl.includes('musica.html') || curTabUrl.includes('/baixatube') || curTabUrl.includes('/youtube');
  if (!isSearchPage && !targetSearchUrl && (isPortalExitToHome || !isHomeOrBaixaTubeTab(activeTab))) {
    goHomeFromFullscreen();
  }
}

function updateNavControls(wv) {
  if (!wv) return;
  try {
    const canBack = canActiveTabGoBack();
    const canForward = typeof wv.canGoForward === 'function' && wv.canGoForward();
    btnBack.disabled = !canBack;
    btnForward.disabled = !canForward;
    updateFloatingNavPill(canBack, canForward);
  } catch (e) { swallowed(e, 'renderer:updateNavControls@2187'); }
}

function isIpCheckNav(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return false;
  if (/(?:^|\/\/|\.)(meuip\.com\.br|meuip\.net\.br|qualemeuip\.com\.br|qualemeuip\.com|qual-e-o-meu-ip\.com|meu-ip\.com|meuip\.org|whatismyip\.com|whatismyipaddress\.com|showmyip\.com|ipinfo\.io|ip-api\.com|ipleak\.net|browserleaks\.com|dnsleaktest\.com|whoer\.net|ifconfig\.me|ifconfig\.co|ifconfig\.io|icanhazip\.com|ipify\.org|check\.torproject\.org|iplocation\.net)(?:[/?#:]|$)/i.test(s)) {
    return true;
  }
  return /^(meuip|meu ip|qual meu ip|qual o meu ip|qual e o meu ip|qual é o meu ip|qual e meu ip|qual é meu ip|meu endereco ip|meu endereço ip|ip check|check ip|what is my ip|my ip|tor check|check tor|meu ip atual)$/i.test(s);
}

let lastTorStatus = { enabled: true, connected: true };
let torRouteKnown = true;

function useDirectPageLoad() {
  // Sempre falso: navegação externa NUNCA é direta, sempre roteada via Tor
  return false;
}
let pageLoadingTimer = null;

function isTorRoutingNow() {
  if (lastTorStatus && lastTorStatus.enabled) return true;
  return !!(btnToggleTor && btnToggleTor.classList.contains('active'));
}

function shouldShowNavLoading(url) {
  const s = String(url || '');
  if (!s) return false;
  if (isInternalPortalUrl(s)) return false;
  if (/newtab\.html|musica\.html/i.test(s) || /\/(youtube|baixatube|filmes|musica)(?:[/?#]|$)/i.test(s)) return false;
  return /\/search(?:\?|$)/i.test(s) || /\/proxy\?/i.test(s) || /^https?:/i.test(s) || /duckduckgo\.com/i.test(s);
}

let topProgressBarTimer = null;

function startTopProgressBar() {
  const pBar = document.getElementById('top-nav-progress-bar');
  if (!pBar) return;
  if (topProgressBarTimer) {
    clearInterval(topProgressBarTimer);
    topProgressBarTimer = null;
  }
  pBar.classList.add('is-active');
  pBar.style.opacity = '1';
  pBar.style.width = '20%';

  let currentWidth = 20;
  topProgressBarTimer = setInterval(() => {
    if (currentWidth < 80) {
      currentWidth += Math.max(1, (80 - currentWidth) * 0.15);
      pBar.style.width = Math.min(80, Math.round(currentWidth)) + '%';
    } else if (currentWidth < 94) {
      currentWidth += 0.35;
      pBar.style.width = Math.min(94, currentWidth.toFixed(1)) + '%';
    }
  }, 100);
}

function finishTopProgressBar() {
  const pBar = document.getElementById('top-nav-progress-bar');
  if (topProgressBarTimer) {
    clearInterval(topProgressBarTimer);
    topProgressBarTimer = null;
  }
  if (!pBar) return;
  pBar.style.width = '100%';
  setTimeout(() => {
    pBar.style.opacity = '0';
    setTimeout(() => {
      pBar.classList.remove('is-active');
      pBar.style.width = '0%';
    }, 280);
  }, 200);
}

let pageLoadingStartedAt = 0;
let pageLoadingHideTimer = null;

function showPageLoading(url, kind) {
  if (pageLoadingHideTimer) {
    clearTimeout(pageLoadingHideTimer);
    pageLoadingHideTimer = null;
  }
  pageLoadingStartedAt = Date.now();
  startTopProgressBar();
  const isSearch = kind === 'search' || /\/search(?:\?|$)/i.test(String(url || '')) || /duckduckgo\.com\/\?q=/i.test(String(url || ''));
  const isDirectPortal = isInternalPortalUrl(url) && !isSearch;
  if (isDirectPortal || (!shouldShowNavLoading(url) && !isSearch && kind !== 'link')) {
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
  const tor = isTorRoutingNow() && !isDirectPortal;
  if (title) {
    title.textContent = tor
      ? (isSearch ? 'Pesquisando via Tor' : 'Abrindo via Tor')
      : (isSearch ? 'Pesquisando em conexão direta' : 'Carregando página…');
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
      : 'Carregando página em alta velocidade com segurança e zero anúncios…';
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
  if (chipText) chipText.textContent = tor ? 'Tor' : 'Carregando';
  if (bar) {
    bar.classList.add('is-loading');
    bar.classList.toggle('is-direct', !tor);
  }
  if (pageLoadingTimer) clearTimeout(pageLoadingTimer);
  pageLoadingTimer = setTimeout(() => hidePageLoading(true), 120000);
}

function hidePageLoading(force = false) {
  if (pageLoadingHideTimer) {
    clearTimeout(pageLoadingHideTimer);
    pageLoadingHideTimer = null;
  }
  const elapsed = Date.now() - pageLoadingStartedAt;
  if (!force && pageLoadingStartedAt > 0 && elapsed < 700) {
    pageLoadingHideTimer = setTimeout(() => {
      pageLoadingHideTimer = null;
      hidePageLoading(true);
    }, 700 - elapsed);
    return;
  }
  finishTopProgressBar();
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

  // Intercepta qualquer URL de vídeo para tocar direto no player BaixaTube
  const ytDirectVid = extractYoutubeVideoId(target);
  if (ytDirectVid) {
    playYoutubeVideoInApp(ytDirectVid);
    return;
  }

  const cleanNavCmd = target.toLowerCase().replace(/^\/+/, '').trim();
  if (cleanNavCmd === 'baixatube' || cleanNavCmd === 'youtube') {
    openYoutube('');
    return;
  }
  if (cleanNavCmd === 'filmes' || cleanNavCmd === 'filme' || cleanNavCmd === 'filmes online') {
    openFilmesOnline('');
    return;
  }
  if (cleanNavCmd === 'musica' || cleanNavCmd === 'music' || cleanNavCmd === 'musicas' || cleanNavCmd === 'spotify') {
    openPapaleguasMusic('');
    return;
  }
  if (cleanNavCmd === 'home' || cleanNavCmd === 'inicio' || cleanNavCmd === 'menu') {
    goHomeFromFullscreen();
    return;
  }

  // Se o usuário digitou ou colou a URL completa de um portal interno
  try {
    const origin = (typeof publicAppOrigin === 'function' ? publicAppOrigin() : window.location.origin).toLowerCase();
    if (target.toLowerCase().startsWith(origin)) {
      const restPath = target.slice(origin.length).toLowerCase().replace(/^\/+/, '');
      if (restPath === 'baixatube' || restPath === 'youtube') { openYoutube(''); return; }
      if (restPath === 'filmes' || restPath === 'filme') { openFilmesOnline(''); return; }
      if (restPath === 'musica' || restPath === 'music') { openPapaleguasMusic(''); return; }
      if (restPath === 'home' || restPath === 'inicio' || restPath === 'menu' || !restPath) { goHomeFromFullscreen(); return; }
    }
  } catch (e) { swallowed(e, 'renderer:navigateToUrl@2317'); }

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
    const modeSuffix = (typeof selectedSearchMode === 'string' && selectedSearchMode && selectedSearchMode !== 'all')
      ? '&filter=' + encodeURIComponent(selectedSearchMode)
      : '';
    target = resolveAppNavUrl('/search?q=' + encodeURIComponent(target) + modeSuffix);
  }

  if (/^https?:\/\//i.test(target)) {
    if (window.__pplWasmGuard && typeof window.__pplWasmGuard.score_client_nav === 'function') {
      try {
        const isHttps = /^https:\/\//i.test(target) ? 1 : 0;
        const isOnion = /\.onion(?:\/|$|:)/i.test(target) ? 1 : 0;
        window.__lastPplNavScore = Number(window.__pplWasmGuard.score_client_nav(isHttps, isOnion, 0n));
      } catch (e) {}
    }
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

  if (activeTab && (/\/search(?:\?|$)/i.test(activeTab.url || '') || /duckduckgo\.com/i.test(activeTab.url || ''))) {
    activeTab.lastSearchUrl = activeTab.url;
  }
  if (/\/search(?:\?|$)/i.test(target) || /duckduckgo\.com/i.test(target)) {
    if (activeTab) activeTab.lastSearchUrl = target;
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
  const href = link.href || link.getAttribute('href');
  if (!href || href === 'about:blank' || href.startsWith('#') || href.startsWith('javascript:')) return;

  const ytVid = extractYoutubeVideoId(href);
  if (ytVid) {
    event.preventDefault();
    event.stopPropagation();
    const clickTitle = (link.textContent || link.getAttribute('title') || '').trim();
    playYoutubeVideoInApp(ytVid, clickTitle || 'Vídeo');
    return;
  }

  if (typeof showPageLoading === 'function') {
    showPageLoading(href, 'link');
  }

  // Se for link externo para a web ou .onion, sempre intercepta para abrir roteado via Tor
  if ((/^https?:\/\//i.test(href) || /\.onion/i.test(href)) && !isLocalAppHost(new URL(href, window.location.origin).hostname)) {
    event.preventDefault();
    event.stopPropagation();
    const routed = routeUrlInsideTorApp(href);
    if ((link.getAttribute('target') || '').toLowerCase() === '_blank') {
      createTab(routed);
    } else {
      navigateToUrl(routed);
    }
  }
}, true);

if (window.torBrowserAPI && typeof window.torBrowserAPI.onTorRequiredForTab === 'function') {
  window.torBrowserAPI.onTorRequiredForTab(() => {
    if (typeof showToast === 'function') {
      showToast('🔒 Nova aba bloqueada: conecte ao Tor primeiro para evitar vazamento de IP.', 'error');
    }
  });
}
if (window.torBrowserAPI && typeof window.torBrowserAPI.onOpenUrlInApp === 'function') {
  window.torBrowserAPI.onOpenUrlInApp((url) => {
    // window.open / target=_blank barrados pelo Electron voltam para uma aba do app ou tocam direto no BaixaTube.
    const vid = extractYoutubeVideoId(url);
    if (vid) {
      playYoutubeVideoInApp(vid);
      return;
    }
    const inside = routeUrlInsideTorApp(url);
    if (inside && !isAppShellUrl(inside)) createTab(inside);
  });
}

// Sincroniza navegação de páginas carregadas no iframe (celular / web) para manter tudo dentro do app
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  const activeTab = getActiveTab();

  if (data.type === 'papaleguas-go-back') {
    handleGoBack();
    return;
  }

  if (data.type === 'media-video-detected' && data.video) {
    const videoData = data.video;
    if (!videoData.pageUrl && activeTab && activeTab.url) {
      videoData.pageUrl = activeTab.url;
    }
    showVideoSnifferNotification(videoData);
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

  if (data.type === 'go-back') {
    if (typeof handleGoBack === 'function') handleGoBack();
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
    } catch (e) { swallowed(e, 'renderer:top@2477'); }
    const act = getActiveTab();
    if (act && act.webview) updateNavControls(act.webview);
    return;
  }

  if (data.type === 'enter-video-fullscreen') {
    appVideoFullscreen = true;
    fsHomeVideoWatch(true);
    document.documentElement.classList.add('video-true-fs');
    document.body.classList.add('video-true-fs');
    const act = getActiveTab();
    if (act && act.webview) updateNavControls(act.webview);
    return;
  }

  if (data.type === 'youtube-enter-pip') {
    if (data.videoId) {
      lastYoutubeState = Object.assign({}, lastYoutubeState || {}, {
        videoId: data.videoId,
        title: data.title || (lastYoutubeState && lastYoutubeState.title) || 'BaixaTube',
        currentTime: typeof data.currentTime === 'number' ? data.currentTime : (lastYoutubeState && lastYoutubeState.currentTime) || 0,
        isPlaying: true
      });
    }
    // Silencia qualquer áudio de notificação antes de abrir o PiP para evitar áudio duplicado
    if (ytNotifyAudio) {
      try { ytNotifyAudio.pause(); } catch (e) { swallowed(e, 'renderer:top@2500'); }
      ytNotifyAudio.muted = true;
    }
    postYoutubeCommand('mute');
    if (lastYoutubeState && lastYoutubeState.videoId) {
      if (window.torBrowserAPI && typeof window.torBrowserAPI.offerYoutubePip === 'function') {
        window.torBrowserAPI.offerYoutubePip(lastYoutubeState);
      } else {
        prepareMobilePipVideo(lastYoutubeState).then(() => enterMobilePictureInPicture());
      }
    }
    return;
  }

  if (data.type === 'youtube-pip-active') {
    const active = !!data.active;
    if (active && ytNotifyAudio) {
      try { ytNotifyAudio.pause(); } catch (e) { swallowed(e, 'renderer:top@2517'); }
      ytNotifyAudio.muted = true;
    }
    return;
  }

  if (data.type === 'youtube-exit-pip') {
    exitMobilePictureInPicture();
    postYoutubeCommand('unmute');
    postYoutubeCommand('play');
    return;
  }

  if (data.type === 'open-cast-hub') {
    openBrowserCastHub();
    return;
  }

  if (data.type === 'page-loading') {
    showPageLoading(data.url || '', data.kind || 'link');
    return;
  }

  if (data.type === 'page-loaded') {
    if (typeof hidePageLoading === 'function') hidePageLoading();
    return;
  }

  if (data.type === 'play-youtube-video') {
    const vid = data.id || extractYoutubeVideoId(data.url);
    if (vid) playYoutubeVideoInApp(vid, data.title || 'Vídeo');
    return;
  }

  if (data.type === 'play-dj-music') {
    openPapaleguasMusic(data.query || data.q || '', true);
    return;
  }

  if (data.type === 'navigate-current-tab' || data.type === 'navigate-to') {
    const url = data.url;
    if (url) {
      if (isAppShellUrl(url)) return;
      const ytVid = extractYoutubeVideoId(url);
      if (ytVid) {
        createTab('/baixatube?v=' + encodeURIComponent(ytVid));
        return;
      }
      if (/(?:^|\/)filmes?(?:[/?#]|$)/i.test(String(url))) {
        let fq = '';
        try {
          const u = new URL(url, window.location.origin || 'http://localhost:8080');
          fq = u.searchParams.get('q') || '';
        } catch (e) {}
        openFilmesOnline(fq);
        return;
      }
      if (/(?:\/musica|musica\.html|spotify\.com|deezer\.com)/i.test(String(url))) {
        let query = '';
        try {
          const u = new URL(url, window.location.origin);
          query = u.searchParams.get('q') || u.searchParams.get('play') || '';
        } catch (e) { swallowed(e, 'renderer:top@2573'); }
        const searchMatch = String(url).match(/open\.spotify\.com\/search\/([^/?#]+)/i);
        if (searchMatch && searchMatch[1]) {
          query = decodeURIComponent(searchMatch[1]);
        }
        openPapaleguasMusic(query, true);
        return;
      }
      if (activeTab && (/\/search(?:\?|$)/i.test(activeTab.url || '') || /duckduckgo\.com/i.test(activeTab.url || ''))) {
        activeTab.lastSearchUrl = activeTab.url;
      }
      if (activeTab && (/\/search(?:\?|$)/i.test(url || '') || /duckduckgo\.com/i.test(url || ''))) {
        activeTab.lastSearchUrl = url;
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
      if (isAppShellUrl(url)) return;
      const ytVid = extractYoutubeVideoId(url);
      if (ytVid) {
        createTab('/baixatube?v=' + encodeURIComponent(ytVid));
        return;
      }
      const isInternalTarget = String(url).startsWith('/') && !/^\/proxy(?:\?|$)/i.test(String(url));
      const isLocalTarget = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(String(url));
      if (!isInternalTarget && !isLocalTarget && window.torBrowserAPI && typeof window.torBrowserAPI.getTorStatus === 'function') {
        window.torBrowserAPI.getTorStatus().then(async (st) => {
          if (!st || !st.connected) {
            if (typeof window.torBrowserAPI.toggleTor === 'function') {
              try { st = await window.torBrowserAPI.toggleTor(true); } catch (e) {}
            }
          }
          const routedUrl = routeUrlInsideTorApp(url);
          if (routedUrl && !isAppShellUrl(routedUrl)) {
            if (typeof showPageLoading === 'function') showPageLoading(routedUrl, 'link');
            createTab(routedUrl);
          }
        }).catch(() => {});
        return;
      }
      if (/(?:^|\/)filmes?(?:[/?#]|$)/i.test(String(url))) {
        let fq = '';
        try {
          const u = new URL(url, window.location.origin || 'http://localhost:8080');
          fq = u.searchParams.get('q') || '';
        } catch (e) {}
        openFilmesOnline(fq);
        return;
      }
      if (/(?:\/musica|musica\.html|spotify\.com|deezer\.com)/i.test(String(url))) {
        let query = '';
        try {
          const u = new URL(url, window.location.origin);
          query = u.searchParams.get('q') || u.searchParams.get('play') || '';
        } catch (e) { swallowed(e, 'renderer:top@2606'); }
        const searchMatch = String(url).match(/open\.spotify\.com\/search\/([^/?#]+)/i);
        if (searchMatch && searchMatch[1]) {
          query = decodeURIComponent(searchMatch[1]);
        }
        openPapaleguasMusic(query, true);
        return;
      }
      const isElectron = isElectronApp();
      const inside = routeUrlInsideTorApp(url);
      showPageLoading(inside, /\/search(?:\?|$)/i.test(inside) ? 'search' : 'link');
      createTab(inside);
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
    let targetTab = activeTab;
    try {
      if (event && event.source && Array.isArray(tabs)) {
        const matchedTab = tabs.find(t => {
          if (!t || !t.webview) return false;
          if (t.webview.contentWindow === event.source) return true;
          try {
            const iframes = t.webview.querySelectorAll ? t.webview.querySelectorAll('iframe') : [];
            for (const f of iframes) {
              if (f.contentWindow === event.source) return true;
            }
          } catch (e) {}
          return false;
        });
        if (matchedTab) targetTab = matchedTab;
      }
    } catch (e) { swallowed(e, 'renderer:navigate-sync-source'); }

    if (targetTab && data.url) {
      // Se a URL veio de um proxy (/proxy?url=...), restaura a URL original para exibir limpamente na barra
      let displayUrl = data.targetUrl || data.url;
      try {
        if (displayUrl.includes('/proxy?url=')) {
          const uObj = new URL(displayUrl, window.location.origin);
          displayUrl = uObj.searchParams.get('url') || displayUrl;
        }
      } catch(e){ swallowed(e, 'renderer:top@2649'); }

      targetTab.url = displayUrl;
      if (/\/search(?:\?|$)/i.test(displayUrl || '') || /duckduckgo\.com/i.test(displayUrl || '')) {
        targetTab.lastSearchUrl = displayUrl;
      }
      if (data.title && targetTab.header) {
        targetTab.title = data.title;
        const titleEl = targetTab.header.querySelector('.tab-title');
        if (titleEl) titleEl.textContent = data.title;
      }
      if (typeof renderOpenTabsMenu === 'function') renderOpenTabsMenu();

      if (targetTab.id === activeTabId) {
        const isInternal = isInternalPortalUrl(displayUrl);
        setAddressBar(isInternal ? '' : displayUrl);
        if (data.isFinal && typeof hidePageLoading === 'function') {
          hidePageLoading();
        }
      }

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
// Pesquisas nunca são salvas nem retidas na memória/histórico da URL
let sessionRecentSearches = [];

function rememberRecentSearch(query) {
  // Desativado por solicitação do usuário: nenhuma pesquisa da URL é salva
  sessionRecentSearches = [];
}

function looksLikeUrl(s) {
  if (!s || typeof s !== 'string') return false;
  const str = s.trim();
  if (/^https?:\/\//i.test(str)) return true;
  if (/^localhost(?::\d+)?/i.test(str)) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/.test(str)) return true;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?::\d+)?(?:\/.*)?$/.test(str)) return true;
  return false;
}

function isOnionUrl(s) {
  return /\.onion(?::\d+)?(?:[/?#]|$)/i.test(String(s || '').trim());
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
  // Favoritos salvos explicitamente pelo usuário
  try {
    const bookmarks = (typeof getUserBookmarks === 'function') ? getUserBookmarks() : JSON.parse(localStorage.getItem('user_bookmarks') || '[]');
    bookmarks.forEach((bm) => {
      const hay = ((bm.title || '') + ' ' + (bm.url || '')).toLowerCase();
      if (hay.includes(q) && bm.url) {
        out.push({ kind: 'url', title: bm.title || bm.url, subtitle: bm.url, url: bm.url });
      }
    });
  } catch (e) { swallowed(e, 'renderer:localUrlSuggestions@2721'); }
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
const searchFsModes = document.getElementById('search-fs-modes');
let searchFsOpen = false;
let selectedSearchMode = 'all';

if (searchFsModes) {
  searchFsModes.addEventListener('click', (e) => {
    const pill = e.target.closest('.search-fs-mode-pill');
    if (!pill) return;
    selectedSearchMode = pill.getAttribute('data-mode') || 'all';
    searchFsModes.querySelectorAll('.search-fs-mode-pill').forEach((p) => {
      p.classList.toggle('is-active', p === pill);
    });
    const typed = String(searchFsInput ? searchFsInput.value : '').trim();
    if (typed) {
      rememberRecentSearch(typed);
      closeSearchFullscreen(true);
      navigateToUrl(typed);
      return;
    }
    if (searchFsInput) searchFsInput.focus();
  });
}

// Enquanto a tela cheia está aberta, é o campo dela que comanda as sugestões
function activeSuggestInput() {
  return searchFsOpen && searchFsInput ? searchFsInput : urlInput;
}

function hideUrlSuggestions() {
  if (urlSuggestPanel) urlSuggestPanel.hidden = true;
  urlSuggestState.active = -1;
}

function getSuggestionKindIcon(kind, letter = '?') {
  switch (kind) {
    case 'search': return '⌕';
    case 'gpt': return '✦';
    case 'onion': return '🧅';
    case 'wiki': return '📖';
    case 'video': return '▶';
    case 'music': return '🎵';
    case 'news': return '📰';
    case 'movie': return '🎬';
    default: return letter;
  }
}

function applySuggestion(item) {
  if (!item) return;
  const targetUrl = item.url || item.title;
  if (typeof showPageLoading === 'function' && targetUrl) {
    showPageLoading(targetUrl, item.kind === 'search' ? 'search' : 'link');
  }
  hideUrlSuggestions();
  closeSearchFullscreen(true);
  
  if (item.kind === 'video' && item.videoId) {
    if (typeof playYoutubeVideoInApp === 'function') {
      playYoutubeVideoInApp(item.videoId);
      return;
    }
  }
  if (item.kind === 'music') {
    if (typeof openPapaleguasMusic === 'function') {
      openPapaleguasMusic(item.musicQuery || item.title, true);
      return;
    }
  }
  if (item.kind === 'movie' && item.url) {
    navigateToUrl(item.url);
    return;
  }
  let destUrl = item.url || item.title;
  if (item.kind === 'search' && typeof selectedSearchMode === 'string' && selectedSearchMode !== 'all' && destUrl && destUrl.includes('/search?') && !destUrl.includes('filter=')) {
    destUrl += '&filter=' + encodeURIComponent(selectedSearchMode);
  }
  navigateToUrl(destUrl);
}

// ===== Prévia dos resultados (imagem de capa + descrição da página) =====
// O servidor lê as metatags OpenGraph de cada link encontrado; a imagem passa
// pelo proxy /api/preview-img para não expor o usuário ao site de origem.
const pagePreviewStore = new Map();
const pagePreviewPending = new Set();
let pagePreviewTimer = null;

function isPreviewCandidate(item) {
  if (!item || !item.url) return false;
  const kind = item.kind || 'site';
  if (kind !== 'site' && kind !== 'news' && kind !== 'url') return false;
  return /^https?:\/\//i.test(item.url) && !isOnionUrl(item.url);
}

function previewImageSrc(url) {
  return '/api/preview-img?u=' + encodeURIComponent(url) + '&clientId=' + encodeURIComponent(CLIENT_ID);
}

const PREVIEW_ROW_PARTS = {
  fs: { ico: 'search-fs-item-ico', text: 'search-fs-item-text', desc: 'search-fs-item-snip', thumb: 'search-fs-preview', favImg: 'search-fs-thumb' },
  bar: { ico: 'url-suggest-ico', text: 'url-suggest-text', desc: 'url-suggest-desc', thumb: 'url-suggest-preview', favImg: 'url-suggest-thumb' }
};

function decorateRowWithPreview(row, item, variant) {
  if (!row || !isPreviewCandidate(item)) return;
  const parts = PREVIEW_ROW_PARTS[variant] || PREVIEW_ROW_PARTS.fs;
  row.dataset.previewUrl = item.url;
  let thumb = row.querySelector('.' + parts.thumb);
  const known = pagePreviewStore.has(item.url);
  const pv = known ? pagePreviewStore.get(item.url) : null;

  if (!known) {
    // Placeholder animado enquanto a prévia é buscada
    if (!thumb) {
      thumb = document.createElement('span');
      thumb.className = parts.thumb + ' is-loading';
      row.appendChild(thumb);
    }
    return;
  }

  if (!pv) {
    if (thumb) thumb.remove();
    return;
  }

  if (pv.image) {
    if (!thumb) {
      thumb = document.createElement('span');
      thumb.className = parts.thumb;
      row.appendChild(thumb);
    }
    thumb.classList.remove('is-loading');
    if (!thumb.querySelector('img')) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => thumb.classList.add('is-ready');
      img.onerror = () => thumb.remove();
      img.src = previewImageSrc(pv.image);
      thumb.appendChild(img);
    }
  } else if (thumb) {
    thumb.remove();
  }

  const description = String(pv.description || '').trim();
  const text = row.querySelector('.' + parts.text);
  if (description && text) {
    let desc = text.querySelector('.' + parts.desc);
    const current = desc ? String(desc.textContent || '').trim() : '';
    if (!desc) {
      desc = document.createElement('span');
      desc.className = parts.desc;
      text.appendChild(desc);
    }
    if (description.length > current.length) desc.textContent = description;
  }

  // Favicon real do site no lugar da letra inicial
  const ico = row.querySelector('.' + parts.ico);
  if (pv.favicon && ico && !ico.querySelector('img')) {
    const letter = ico.textContent;
    const fav = document.createElement('img');
    fav.alt = '';
    fav.className = parts.favImg + ' is-favicon';
    fav.referrerPolicy = 'no-referrer';
    fav.onerror = () => { fav.remove(); ico.textContent = letter; };
    fav.src = previewImageSrc(pv.favicon);
    ico.textContent = '';
    ico.appendChild(fav);
  }
}

function applyPreviewsToRenderedRows() {
  const containers = [searchFsList, typeof urlSuggestList !== 'undefined' ? urlSuggestList : null];
  containers.forEach((container) => {
    if (!container) return;
    const variant = container === searchFsList ? 'fs' : 'bar';
    container.querySelectorAll('[data-preview-url]').forEach((row) => {
      const url = row.dataset.previewUrl;
      const item = urlSuggestState.items.find((it) => it && it.url === url);
      if (item) decorateRowWithPreview(row, item, variant);
    });
  });
}

function requestSuggestionPreviews() {
  if (pagePreviewTimer) clearTimeout(pagePreviewTimer);
  pagePreviewTimer = setTimeout(runSuggestionPreviews, 120);
}

async function runSuggestionPreviews() {
  pagePreviewTimer = null;
  const urls = urlSuggestState.items
    .filter(isPreviewCandidate)
    .map((item) => item.url)
    .filter((url) => !pagePreviewStore.has(url) && !pagePreviewPending.has(url))
    .slice(0, 12);
  if (!urls.length) return;
  urls.forEach((url) => pagePreviewPending.add(url));
  try {
    const res = await fetch('/api/page-preview?clientId=' + encodeURIComponent(CLIENT_ID), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
      body: JSON.stringify({ urls })
    });
    const data = await res.json();
    const previews = (data && data.previews) || {};
    urls.forEach((url) => pagePreviewStore.set(url, previews[url] || null));
  } catch (e) {
    urls.forEach((url) => pagePreviewStore.set(url, null));
  } finally {
    urls.forEach((url) => pagePreviewPending.delete(url));
  }
  if (pagePreviewStore.size > 600) {
    Array.from(pagePreviewStore.keys()).slice(0, 200).forEach((k) => pagePreviewStore.delete(k));
  }
  applyPreviewsToRenderedRows();
  // Ainda há resultados sem prévia (ex.: chegou mais uma página): busca o próximo lote
  requestSuggestionPreviews();
}

function buildSuggestionRow(item, index) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const kind = item.kind || 'site';
  btn.className = 'search-fs-item' + (index === urlSuggestState.active ? ' is-active' : '') + ' is-' + kind;
  const host = item.subtitle || item.url || '';
  const letter = String(host).replace(/^https?:\/\//, '').charAt(0).toUpperCase() || '?';
  const ico = document.createElement('span');
  ico.className = 'search-fs-item-ico is-' + kind;
  
  if (item.thumb) {
    const img = document.createElement('img');
    img.src = item.thumb;
    img.alt = '';
    img.className = 'search-fs-thumb';
    img.onerror = () => {
      img.remove();
      ico.textContent = getSuggestionKindIcon(kind, letter);
    };
    ico.appendChild(img);
  } else {
    ico.textContent = getSuggestionKindIcon(kind, letter);
  }

  const text = document.createElement('span');
  text.className = 'search-fs-item-text';
  
  const headerRow = document.createElement('div');
  headerRow.className = 'search-fs-item-header';
  
  const title = document.createElement('span');
  title.className = 'search-fs-item-title';
  title.textContent = item.title || item.url || '';
  headerRow.appendChild(title);
  
  if (item.badge) {
    const badge = document.createElement('span');
    badge.className = 'search-fs-badge badge-' + kind;
    badge.textContent = item.badge;
    headerRow.appendChild(badge);
  }
  text.appendChild(headerRow);

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
  decorateRowWithPreview(btn, item, 'fs');
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => applySuggestion(item));
  return btn;
}

function renderRecentSearchChips() {
  if (searchFsRecentBox) searchFsRecentBox.hidden = true;
  if (searchFsRecent) searchFsRecent.innerHTML = '';
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
  if (isInternalPortalUrl(value)) return '';
  try {
    const origin = (typeof publicAppOrigin === 'function' ? publicAppOrigin() : window.location.origin).toLowerCase();
    if (value.toLowerCase().startsWith(origin)) return '';
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin === window.location.origin) return '';
  } catch (e) { swallowed(e, 'renderer:seedValueForSearchTab@2898'); }
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
  const cleanSeed = seedValueForSearchTab(seed);
  searchFsInput.value = (cleanSeed && !isInternalPortalUrl(cleanSeed) && !cleanSeed.includes('baixatube') && !cleanSeed.includes('ngrok.app')) ? cleanSeed : '';
  urlSuggestState.items = [];
  urlSuggestState.q = '';
  urlSuggestState.active = -1;
  syncSearchFsClearButton();
  enforceCleanPortalUrl();
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
    } catch (e) { swallowed(e, 'renderer:openSearchFullscreen@2930'); }
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
    try { urlInput.blur(); } catch (e) { swallowed(e, 'renderer:closeSearchFullscreen@2947'); }
  }
}

function appendRefreshSuggestionsButton(parent) {
  const query = String((activeSuggestInput() && activeSuggestInput().value) || '').trim();
  if (!parent || query.length < 2 || !urlSuggestState.items.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'suggest-more-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'suggest-refresh-btn suggest-load-more-btn' + (urlSuggestState.loading ? ' is-loading' : '');
  btn.disabled = !!urlSuggestState.loading;
  btn.textContent = urlSuggestState.loading
    ? 'Carregando mais resultados…'
    : (urlSuggestState.hasMore ? 'Carregar mais resultados' : 'Buscar mais resultados');
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    urlSuggestState.hasMore = true;
    fetchUrlSuggestions(false);
  });
  wrap.appendChild(btn);
  parent.appendChild(wrap);
}

function renderUrlSuggestions() {
  if (searchFsOpen) {
    renderFullscreenSuggestions();
    return;
  }
  if (!urlSuggestList || !urlSuggestPanel) return;
  // Resposta atrasada não pode reabrir o painel depois que a pesquisa foi fechada
  if (document.activeElement !== urlInput && !(urlSuggestPanel && urlSuggestPanel.contains(document.activeElement)) && !urlSuggestState.loading) {
    hideUrlSuggestions();
    return;
  }
  urlSuggestList.innerHTML = '';
  urlSuggestState.items.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const kind = item.kind || 'site';
    btn.className = 'url-suggest-item' + (index === urlSuggestState.active ? ' is-active' : '') + ' is-' + kind;
    const letter = String(item.subtitle || item.title || '?').replace(/^https?:\/\//, '').charAt(0).toUpperCase();
    const ico = document.createElement('span');
    ico.className = 'url-suggest-ico is-' + kind;
    
    if (item.thumb) {
      const img = document.createElement('img');
      img.src = item.thumb;
      img.alt = '';
      img.className = 'url-suggest-thumb';
      img.onerror = () => {
        img.remove();
        ico.textContent = getSuggestionKindIcon(kind, letter);
      };
      ico.appendChild(img);
    } else {
      ico.textContent = getSuggestionKindIcon(kind, letter);
    }

    const text = document.createElement('span');
    text.className = 'url-suggest-text';
    
    const headerRow = document.createElement('div');
    headerRow.className = 'url-suggest-header';
    
    const name = document.createElement('span');
    name.className = 'url-suggest-name';
    name.textContent = item.title || item.url;
    headerRow.appendChild(name);

    if (item.badge) {
      const badge = document.createElement('span');
      const badgeClass = item.source ? item.source : kind;
      badge.className = 'url-suggest-badge badge-' + badgeClass;
      badge.textContent = item.badge;
      headerRow.appendChild(badge);
    }
    text.appendChild(headerRow);

    const hint = document.createElement('span');
    hint.className = 'url-suggest-hint';
    hint.textContent = item.subtitle || item.url || '';
    text.appendChild(hint);
    if (item.snippet) {
      const desc = document.createElement('span');
      desc.className = 'url-suggest-desc';
      desc.textContent = item.snippet;
      text.appendChild(desc);
    }

    btn.appendChild(ico);
    btn.appendChild(text);
    decorateRowWithPreview(btn, item, 'bar');
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      rememberRecentSearch(urlSuggestState.q);
      applySuggestion(item);
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

let urlSuggestAbortCtrl = null;

async function fetchUrlSuggestions(reset) {
  const input = activeSuggestInput();
  const q = String(input && input.value || '').trim();
  if (q.length < 2) {
    if (urlSuggestAbortCtrl) {
      try { urlSuggestAbortCtrl.abort(); } catch (e) {}
      urlSuggestAbortCtrl = null;
    }
    hideUrlSuggestions();
    if (searchFsOpen) {
      urlSuggestState.items = [];
      urlSuggestState.q = '';
      renderFullscreenSuggestions();
    }
    return;
  }
  if (reset) {
    if (urlSuggestAbortCtrl) {
      try { urlSuggestAbortCtrl.abort(); } catch (e) {}
      urlSuggestAbortCtrl = null;
    }
    urlSuggestState.loading = false;
    urlSuggestState.q = q;
    urlSuggestState.page = 0;
    urlSuggestState.items = localUrlSuggestions(q);
    urlSuggestState.active = -1;
    urlSuggestState.hasMore = true;
    renderUrlSuggestions();
  } else {
    if (urlSuggestState.loading) return;
    if (urlSuggestState.q !== q) return;
  }
  urlSuggestState.hasMore = true;
  urlSuggestState.loading = true;
  renderUrlSuggestions();
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  urlSuggestAbortCtrl = ctrl;
  // Quantidade mínima de resultados de site que queremos mostrar antes de parar
  // (na primeira busca) ou a quantidade de novos sites a cada "Carregar mais resultados"
  const siteCountNow = () => urlSuggestState.items.filter((item) => item.kind === 'site').length;
  const TARGET_SITE_COUNT = reset ? 8 : siteCountNow() + 8;
  try {
    let hops = 0;
    while (hops < (reset ? 2 : 3) && urlSuggestState.hasMore) {
      hops += 1;
      const res = await fetch(
        '/api/url-suggest?q=' + encodeURIComponent(q) + '&page=' + urlSuggestState.page + '&clientId=' + encodeURIComponent(CLIENT_ID),
        ctrl ? { signal: ctrl.signal } : undefined
      );
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
      requestSuggestionPreviews();
      // Continua buscando se ainda não atingiu o mínimo de resultados de site
      const siteCount = siteCountNow();
      if (siteCount >= TARGET_SITE_COUNT) break;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    urlSuggestState.hasMore = false;
  }
  if (urlSuggestAbortCtrl === ctrl) urlSuggestAbortCtrl = null;
  urlSuggestState.loading = false;
  renderUrlSuggestions();
}

function scheduleUrlSuggestions() {
  if (urlSuggestState.timer) clearTimeout(urlSuggestState.timer);
  if (urlSuggestAbortCtrl) {
    try { urlSuggestAbortCtrl.abort(); } catch (e) {}
    urlSuggestAbortCtrl = null;
  }
  urlSuggestState.items = [];
  urlSuggestState.active = -1;
  hideUrlSuggestions();
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
  setTimeout(() => {
    if (urlSuggestPanel && urlSuggestPanel.contains(document.activeElement)) return;
    hideUrlSuggestions();
  }, 220);
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
    try { searchDictation.recognition.stop(); } catch (e) { swallowed(e, 'renderer:stopSearchDictation@3300'); }
  }
  if (searchDictation.recorder && searchDictation.recorder.state === 'recording') {
    try { searchDictation.recorder.stop(); } catch (e) { swallowed(e, 'renderer:stopSearchDictation@3303'); }
  } else {
    releaseDictationStream();
    if (cancelled || searchDictation.state === 'listening') setSearchMicState('idle');
  }
}

function releaseDictationStream() {
  if (searchDictation.stream) {
    searchDictation.stream.getTracks().forEach((track) => {
      try { track.stop(); } catch (e) { swallowed(e, 'renderer:releaseDictationStream@3313'); }
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
      footerStatus.textContent = 'Abrindo página com proteção Tor...';
      createTab(routeUrlInsideTorApp(url));
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
  handleGoBack();
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

if (btnHome) {
  bindMenuTouchAndClick(btnHome, () => {
    goHomeFromFullscreen();
  });
}

// Sincronização do botão Home flutuante com a navegação do app
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

// Configuração do Botão Flutuante Central de Histórico (Voltar / Avançar)
const floatingNavPill = document.getElementById('floating-nav-pill');
const floatingNavBack = document.getElementById('floating-nav-back');
const floatingNavForward = document.getElementById('floating-nav-forward');

if (floatingNavBack) {
  floatingNavBack.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleGoBack();
  });
}

if (floatingNavForward) {
  floatingNavForward.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const activeTab = getActiveTab();
    if (activeTab && activeTab.webview && typeof activeTab.webview.canGoForward === 'function' && activeTab.webview.canGoForward()) {
      activeTab.webview.goForward();
    }
  });
}

if (floatingNavPill) {
  // Arrastável: o usuário pode reposicionar o botão caso queira liberar espaço visual
  if (window.PapaleguasFab && typeof window.PapaleguasFab.makeDraggable === 'function') {
    window.PapaleguasFab.makeDraggable(floatingNavPill, {
      storageKey: 'papaleguas_fab_pos_nav_pill',
      dragThreshold: 14
    });
  }
}

// Atalhos de teclado globais para Voltar / Avançar (Alt + Seta Esquerda / Direita ou Backspace)
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  const isInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
  if (isInput) return;
  if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && !e.altKey && !e.ctrlKey && !e.metaKey)) {
    e.preventDefault();
    handleGoBack();
    return;
  }
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    const activeTab = getActiveTab();
    if (activeTab && activeTab.webview && typeof activeTab.webview.canGoForward === 'function' && activeTab.webview.canGoForward()) {
      activeTab.webview.goForward();
    }
  }
});

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

function bindMenuTouchAndClick(el, fn) {
  if (!el) return;
  let handledTime = 0;
  el.addEventListener('touchend', (e) => {
    handledTime = Date.now();
    e.preventDefault();
    fn();
  }, { passive: false });
  el.addEventListener('click', (e) => {
    if (Date.now() - handledTime < 450) return;
    fn();
  });
}

if (btnSpotify) {
  bindMenuTouchAndClick(btnSpotify, () => {
    openPapaleguasMusic('');
    enterMenuPortalFullscreen();
  });
}
if (btnYoutube) {
  bindMenuTouchAndClick(btnYoutube, () => {
    openYoutube('');
    enterMenuPortalFullscreen();
  });
}
if (btnMovies) {
  bindMenuTouchAndClick(btnMovies, () => {
    openFilmesOnline('');
    enterMenuPortalFullscreen();
  });
}

function openFilmesOnline(searchQuery = '') {
  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
  const baseUrl = isElectron ? 'http://localhost:8080' : '';
  const cleanQ = (searchQuery || '').trim();
  const params = new URLSearchParams();
  if (cleanQ) {
    params.set('q', cleanQ);
  }
  let targetCountry = '';
  try {
    const manualC = localStorage.getItem('papaleguas_baixatube_country') || '';
    const ipC = localStorage.getItem('papaleguas_detected_ip_country') || (window.PapaleguasI18n && window.PapaleguasI18n.getCountry ? window.PapaleguasI18n.getCountry() : '');
    if (manualC && manualC !== 'auto' && /^[A-Z]{2}$/i.test(manualC)) {
      targetCountry = manualC.toUpperCase();
    } else if (ipC && /^[A-Z]{2}$/i.test(ipC)) {
      targetCountry = ipC.toUpperCase();
    }
  } catch (e) { swallowed(e, 'renderer:openFilmesOnline@3691'); }
  if (targetCountry) {
    params.set('country', targetCountry);
  }
  const qs = params.toString();
  const filmesUrl = baseUrl + '/filmes' + (qs ? '?' + qs : '');

  const callerTab = getActiveTab();
  const callerSearchUrl = (callerTab && (callerTab.lastSearchUrl || (/\/search(?:\?|$)/i.test(callerTab.url || '') ? callerTab.url : ''))) || '';
  const callerTabId = callerTab ? callerTab.id : null;

  // Procura se já existe uma aba de Filmes Online aberta para alternar instantaneamente (0ms)
  const existingTab = tabs.find(t => t.url && t.url.includes('/filmes'));
  if (existingTab) {
    if (callerTabId && callerTabId !== existingTab.id) {
      existingTab.returnToTabId = callerTabId;
      if (callerSearchUrl) existingTab.lastSearchUrl = callerSearchUrl;
    }
    activateTab(existingTab.id);
    if (typeof hidePageLoading === 'function') hidePageLoading();
    const countryChanged = targetCountry && (!existingTab.url.includes('country=' + targetCountry));
    if ((cleanQ || countryChanged) && existingTab.webview) {
      existingTab.url = filmesUrl;
      existingTab.webview.loadURL(filmesUrl);
    }
  } else {
    // Cria uma aba dedicada para Filmes sem destruir a aba do BaixaTube (newtab.html)
    const newFilmesTab = createTab(filmesUrl);
    if (newFilmesTab && callerTabId) {
      newFilmesTab.returnToTabId = callerTabId;
      if (callerSearchUrl) newFilmesTab.lastSearchUrl = callerSearchUrl;
    }
  }
  setAddressBar('');
  syncPortalHomeButton('/filmes');
  enterMenuPortalFullscreen();
  if (window.history && typeof window.history.pushState === 'function' && !isElectronApp()) {
    try {
      const targetPath = '/filmes' + (qs ? '?' + qs : '');
      if (window.location.pathname !== '/filmes') {
        window.history.pushState({ portal: 'filmes' }, '', targetPath);
      }
    } catch (e) { swallowed(e, 'renderer:openFilmesOnline@3721'); }
  }
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
  const baixatubeUrl = baseUrl + '/baixatube' + (qs ? '?' + qs : '');

  const callerTab = getActiveTab();
  const callerSearchUrl = (callerTab && (callerTab.lastSearchUrl || (/\/search(?:\?|$)/i.test(callerTab.url || '') ? callerTab.url : ''))) || '';
  const callerTabId = callerTab ? callerTab.id : null;

  // Procura se já existe uma aba de BaixaTube / Home aberta para alternar instantaneamente (0ms)
  // Ignora a aba chamadora (ex: aba de busca /search) para não sobrescrever a pesquisa
  const existingTab = tabs.find((t) => t.id !== callerTabId && t.url && !t.url.includes('/search') && (t.url.includes('/baixatube') || t.url.includes('/youtube') || t.url.includes('newtab.html')));
  if (existingTab) {
    if (callerTabId && callerTabId !== existingTab.id) {
      existingTab.returnToTabId = callerTabId;
      if (callerSearchUrl) existingTab.lastSearchUrl = callerSearchUrl;
    }
    activateTab(existingTab.id);
    if (typeof hidePageLoading === 'function') hidePageLoading();
    if (cleanQ || videoId) {
      existingTab.url = baixatubeUrl;
      let handledDirectly = false;
      if (videoId) {
        if (existingTab.webview && typeof existingTab.webview.executeJavaScript === 'function') {
          existingTab.webview.executeJavaScript(`(function() {
            if (typeof playVideoInHomePlayer === 'function') {
              playVideoInHomePlayer('${videoId}', 'Papaléguas BaixaTube', 'Papaléguas BaixaTube', true, true);
              if (typeof loadSuggestionsForVideo === 'function') loadSuggestionsForVideo({ id: '${videoId}' });
              const pSec = document.getElementById('home-player-section');
              if (pSec) pSec.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return true;
            }
            return false;
          })()`).then((ok) => {
            if (!ok) {
              if (typeof existingTab.webview.loadURL === 'function') existingTab.webview.loadURL(baixatubeUrl);
              else existingTab.webview.src = baixatubeUrl;
            }
          }).catch(() => {
            if (typeof existingTab.webview.loadURL === 'function') existingTab.webview.loadURL(baixatubeUrl);
            else existingTab.webview.src = baixatubeUrl;
          });
          handledDirectly = true;
        } else if (existingTab.webview && existingTab.webview.contentWindow && typeof existingTab.webview.contentWindow.postMessage === 'function') {
          try {
            existingTab.webview.contentWindow.postMessage({ type: 'play-youtube-video', id: videoId, title: 'Papaléguas BaixaTube', url: baixatubeUrl }, '*');
            handledDirectly = true;
          } catch (e) {}
        }
      }
      if (!handledDirectly) {
        if (existingTab.webview && typeof existingTab.webview.loadURL === 'function') {
          existingTab.webview.loadURL(baixatubeUrl);
        } else if (existingTab.webview) {
          existingTab.webview.src = baixatubeUrl;
        }
      }
    }
  } else {
    const newBaixaTab = createTab(baixatubeUrl);
    if (newBaixaTab && callerTabId) {
      newBaixaTab.returnToTabId = callerTabId;
      if (callerSearchUrl) newBaixaTab.lastSearchUrl = callerSearchUrl;
    }
  }
  setAddressBar('');
  syncPortalHomeButton('/baixatube');
  enterMenuPortalFullscreen();
  if (window.history && typeof window.history.pushState === 'function' && !isElectronApp()) {
    try {
      const targetPath = '/baixatube' + (qs ? '?' + qs : '');
      if (window.location.pathname !== '/baixatube') {
        window.history.pushState({ portal: 'baixatube' }, '', targetPath);
      }
    } catch (e) { swallowed(e, 'renderer:openYoutube@3762'); }
  }
}
window.openYoutube = openYoutube;
window.openBaixaTube = openYoutube;

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
    activeTab.lastSearchUrl = searchUrl;
    activeTab.webview.loadURL(searchUrl);
    setAddressBar(searchUrl);
    return;
  }
  createTab(searchUrl);
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
      } catch(e) { swallowed(e, 'renderer:openBookmarkUrl@3805'); }
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
    } catch(e) { swallowed(e, 'renderer:renderBookmarks@3872'); }
    
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
          createTab(routeUrlInsideTorApp(directUrl));
        }
      } catch(err){ swallowed(err, 'renderer:renderBookmarks@3949'); }
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
  } catch (e) { swallowed(e, 'renderer:getUserBookmarks@3974'); }
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
  } catch (e) { swallowed(e, 'renderer:setUserBookmarks@3988'); }
}

function normalizeBookmarkCompare(url) {
  if (!url) return '';
  let s = String(url).trim().toLowerCase();
  try {
    if (s.includes('/proxy?url=')) {
      s = (new URL(s, window.location.origin).searchParams.get('url') || s).toLowerCase();
    }
  } catch (e) { swallowed(e, 'renderer:normalizeBookmarkCompare@3998'); }
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
  } catch (e) { swallowed(e, 'renderer:bookmarkUrlFromTab@4023'); }
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
  } catch (e) { swallowed(e, 'renderer:tabDisplayTitle@4047'); }
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
  const countBadge = document.getElementById('tabs-count-badge');
  if (countBadge) countBadge.textContent = String((tabs && tabs.length) || 1);
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
        } catch (e) { swallowed(e, 'renderer:top@4211'); }
      }
      if (currentUrl.startsWith('/')) {
        currentUrl = window.location.origin + currentUrl;
      }
      try {
        createTab(routeUrlInsideTorApp(currentUrl));
      } catch (e) { swallowed(e, 'renderer:top@4218'); }
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
      } catch (e) { swallowed(e, 'renderer:initCloudflareStatus@4294'); }
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
  lastTorStatus = status || { enabled: true, connected: true, locked: false };
  const isTorOn = !!(status && status.enabled);
  const isTorActive = isTorOn && status.connected;
  const torIpLabel = document.getElementById('tor-ip-label');

  if (isTorActive) {
    if (statusDot) statusDot.className = 'status-dot online';
    if (badgeText) badgeText.textContent = 'Tor: Conectado (9050)';
    if (btnToggleTor) {
      btnToggleTor.classList.add('active');
      if (torToggleLabel) torToggleLabel.textContent = 'Tor: Conectado';
      btnToggleTor.title = 'Tor Ativo neste dispositivo • Navegação 100% anônima';
    }
    if (torModeText) {
      torModeText.textContent = 'Ativo (SOCKS5: 9050) • Navegação Anônima 100% Protegida';
      torModeText.className = 'value text-success';
    }
    if (torIpLabel) {
      torIpLabel.textContent = 'IP de Saída Tor (Navegação Anônima)';
    }
    if (btnModalToggleTor) {
      btnModalToggleTor.textContent = 'Tor Conectado e Protegido';
      btnModalToggleTor.className = 'secondary-btn tor-action-btn connect';
      btnModalToggleTor.disabled = false;
      btnModalToggleTor.title = 'A conexão de toda a navegação externa está ativa e protegida na rede Tor.';
    }
  } else if (isTorOn) {
    if (statusDot) statusDot.className = 'status-dot';
    if (badgeText) badgeText.textContent = 'Tor: Conectando...';
    if (btnToggleTor) {
      btnToggleTor.classList.add('active');
      if (torToggleLabel) torToggleLabel.textContent = 'Tor: Conectando';
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
    // Mantém fallback ativo com proteção Tor sempre ligada
    if (statusDot) statusDot.className = 'status-dot online';
    if (badgeText) badgeText.textContent = 'Tor: Ativo';
    if (btnToggleTor) {
      btnToggleTor.classList.add('active');
      if (torToggleLabel) torToggleLabel.textContent = 'Tor: Ativo';
    }
    if (torModeText) {
      torModeText.textContent = 'Ativo (SOCKS5: 9050) • Roteamento Tor';
      torModeText.className = 'value text-success';
    }
    if (torIpLabel) {
      torIpLabel.textContent = 'IP de Saída Tor (Navegação Anônima)';
    }
    if (btnModalToggleTor) {
      btnModalToggleTor.textContent = 'Tor Conectado e Protegido';
      btnModalToggleTor.className = 'secondary-btn tor-action-btn connect';
      btnModalToggleTor.disabled = false;
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
  } catch (e) { swallowed(e, 'renderer:readThisDeviceIpv4@4450'); }
  return '';
}

async function fetchTorIpInfo() {
  const torIpLabel = document.getElementById('tor-ip-label');
  if (torIpDisplay) torIpDisplay.textContent = 'Consultando...';
  if (torCheckStatus) torCheckStatus.textContent = 'Verificando...';
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
      if (torIpLabel) torIpLabel.textContent = 'IP de Saída Tor (Navegação Anônima)';
    } else {
      const deviceIpv4 = await readThisDeviceIpv4();
      shown = (info && (info.clientIpv4 || (!info.torIp && info.IP))) || deviceIpv4 || '';
      if (torIpLabel) torIpLabel.textContent = 'IP Real do Dispositivo';
    }
    if (torIpDisplay) {
      if (shown) torIpDisplay.textContent = shown;
      else torIpDisplay.textContent = 'Indisponível';
    }
    if (torCheckStatus) {
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
    }
  } catch (e) {
    if (torIpDisplay) torIpDisplay.textContent = 'Erro';
    if (torCheckStatus) torCheckStatus.textContent = e.message;
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
  } catch (e) { swallowed(e, 'renderer:updateAdblockUI@4501'); }
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
        } catch (e) { swallowed(e, 'renderer:top@4516'); }
      });
      // Recarrega a aba ativa para aplicar a nova regra
      const activeTab = getActiveTab();
      if (activeTab && activeTab.webview) {
        activeTab.webview.reload();
      }
    } catch (e) { swallowed(e, 'renderer:top@4523'); }
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
  } catch (e) { swallowed(e, 'renderer:requestAppWakeLock@4582'); }
}
async function releaseAppWakeLock() {
  if (appWakeLock) {
    try { await appWakeLock.release(); } catch (e) { swallowed(e, 'renderer:releaseAppWakeLock@4586'); }
    appWakeLock = null;
  }
}

// Mantém a sessão de mídia viva entre um vídeo e outro em segundo plano delegando ao helper compartilhado (hybrid-bridge.js)
const _ytKeepAlive = (typeof window !== 'undefined' && typeof window.__papaCreateKeepAlive === 'function')
  ? window.__papaCreateKeepAlive(10)
  : null;
let ytKeepAliveActive = false;

function startYtKeepAlive() {
  if (!_ytKeepAlive) return;
  ytKeepAliveActive = true;
  _ytKeepAlive.start(90000);
}

function stopYtKeepAlive() {
  ytKeepAliveActive = false;
  if (_ytKeepAlive) _ytKeepAlive.stop();
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
    // Cobre o intervalo até o próximo vídeo chegar, para a notificação não sumir
    if (document.hidden && lastYoutubeState && lastYoutubeState.isPlaying !== false) {
      startYtKeepAlive();
    }
    postYoutubeCommand('next');
  });
  ytNotifyAudio.addEventListener('playing', () => {
    stopYtKeepAlive();
  });
  ytNotifyAudio.addEventListener('play', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  ytNotifyAudio.addEventListener('pause', () => {
    if (ytNotifyAudio.ended || ytKeepAliveActive) return;
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
  return window.encryptPplSearchUrl(origin + '/api/stream-audio?v=' + encodeURIComponent(id));
}

function ytVideoStreamUrl(id) {
  const origin = window.location.origin && window.location.origin !== 'null'
    ? window.location.origin
    : 'http://localhost:8080';
  return window.encryptPplSearchUrl(origin + '/api/stream-video?v=' + encodeURIComponent(id));
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

function isMobilePipActive() {
  return !!(ytPipVideo && (document.pictureInPictureElement === ytPipVideo || ytPipVideo.webkitPresentationMode === 'picture-in-picture'));
}

function resetPipMediaSource() {
  if (!ytPipVideo) return;
  if (ytPipVideo._pipTimer) {
    clearInterval(ytPipVideo._pipTimer);
    ytPipVideo._pipTimer = null;
  }
  if (ytPipVideo.srcObject) {
    try { ytPipVideo.srcObject.getTracks().forEach((t) => t.stop()); } catch (e) { swallowed(e, 'renderer:resetPipMediaSource@4725'); }
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
  try { await img.decode(); } catch (e) { swallowed(e, 'renderer:fallbackPipCanvas@4741'); }
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
    } catch (e) { swallowed(e, 'renderer:syncPipVideoTime@4766'); }
  }
}

async function prepareMobilePipVideo(state) {
  if (!ytPipVideo || !state || !state.videoId || isElectronShell() || !isMobilePipClient()) return;
  try {
    ytPipVideo.setAttribute('playsinline', 'true');
    ytPipVideo.setAttribute('webkit-playsinline', 'true');
    ytPipVideo.playsInline = true;
    ytPipVideo.disablePictureInPicture = false;
    ytPipVideo.muted = true;
    ytPipVideo.volume = 1.0;
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
    ytPipVideo.volume = 1.0;
    if (ytNotifyAudio && !ytNotifyAudio.paused) {
      try { ytNotifyAudio.pause(); } catch (e) { swallowed(e, 'renderer:armPipAudioForBackground@4830'); }
      ytNotifyAudio.muted = true;
    }
    postYoutubeCommand('mute');
  } else {
    ytPipVideo.muted = true;
  }
}

async function enterMobilePictureInPicture() {
  if (!ytPipVideo || isElectronShell()) return false;
  if (lastYoutubeState) {
    await prepareMobilePipVideo(lastYoutubeState);
    syncPipVideoTime(lastYoutubeState);
  }
  ytPipVideo.muted = true;
  try {
    if (ytPipVideo.paused) await ytPipVideo.play().catch(() => {});
  } catch (e) { swallowed(e, 'renderer:enterMobilePictureInPicture@4848'); }
  try {
    if (document.pictureInPictureEnabled && !document.pictureInPictureElement) {
      await ytPipVideo.requestPictureInPicture();
    }
    if (document.pictureInPictureElement === ytPipVideo) {
      armPipAudioForBackground();
      return true;
    }
  } catch (e) { swallowed(e, 'renderer:enterMobilePictureInPicture@4857'); }
  try {
    if (ytPipVideo.webkitSupportsPresentationMode && typeof ytPipVideo.webkitSetPresentationMode === 'function') {
      if (ytPipVideo.webkitPresentationMode !== 'picture-in-picture') {
        ytPipVideo.webkitSetPresentationMode('picture-in-picture');
      }
      armPipAudioForBackground();
      return true;
    }
  } catch (e) { swallowed(e, 'renderer:enterMobilePictureInPicture@4866'); }
  try { ytPipVideo.pause(); } catch (e) { swallowed(e, 'renderer:enterMobilePictureInPicture@4867'); }
  ytPipVideo.muted = true;
  postYoutubeCommand('unmute');
  postYoutubeCommand('play');
  return false;
}

async function exitMobilePictureInPicture() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
  } catch (e) { swallowed(e, 'renderer:exitMobilePictureInPicture@4877'); }
  try {
    if (ytPipVideo && ytPipVideo.webkitSupportsPresentationMode && ytPipVideo.webkitPresentationMode === 'picture-in-picture') {
      ytPipVideo.webkitSetPresentationMode('inline');
    }
  } catch (e) { swallowed(e, 'renderer:exitMobilePictureInPicture@4882'); }
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
  } catch (e) { swallowed(e, 'renderer:unlockYtNotifyAudio@4894'); }
}

function postYoutubeCommand(action, value) {
  const payload = { type: 'papaleguas-yt-control', action: action, value: value };
  document.querySelectorAll('iframe').forEach((fr) => {
    // Páginas guardadas no histórico ficam ocultas e não devem reagir.
    if (fr.classList.contains('web-client-frame') && !fr.classList.contains('is-visible')) return;
    try {
      if (fr.contentWindow) fr.contentWindow.postMessage(payload, '*');
    } catch (e) { swallowed(e, 'renderer:postYoutubeCommand@4904'); }
  });
  (tabs || []).forEach((tab) => {
    const wv = tab && tab.webview;
    if (!wv) return;
    try {
      if (wv.contentWindow) wv.contentWindow.postMessage(payload, '*');
    } catch (e) { swallowed(e, 'renderer:postYoutubeCommand@4911'); }
    try {
      if (typeof wv.executeJavaScript === 'function') {
        wv.executeJavaScript('window.postMessage(' + JSON.stringify(payload) + ', "*")').catch(() => {});
      }
    } catch (e) { swallowed(e, 'renderer:postYoutubeCommand@4916'); }
  });
}

let lastParentMediaPositionSync = 0;
function syncParentYtMediaSessionPosition(pos, dur) {
  if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
  const now = Date.now();
  if (now - lastParentMediaPositionSync < 1000) return;
  lastParentMediaPositionSync = now;
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
  } catch (e) { swallowed(e, 'renderer:syncParentYtMediaSessionPosition@4936'); }
}

let lastParentMediaVideoId = '';
let lastParentMediaTitle = '';

function handleParentMediaSeek(target) {
  postYoutubeCommand('seek', target);
  if (lastYoutubeState) lastYoutubeState.currentTime = target;
  if (isMobilePipActive()) {
    if (ytPipVideo && ytPipVideo.readyState >= 1) {
      try { ytPipVideo.currentTime = target; } catch (e) { swallowed(e, 'renderer:handleParentMediaSeek@4947'); }
    }
  } else if (ytNotifyAudio && ytNotifyAudio.readyState >= 1) {
    try { ytNotifyAudio.currentTime = target; } catch (e) { swallowed(e, 'renderer:handleParentMediaSeek@4950'); }
  }
  syncParentYtMediaSessionPosition(target, lastYoutubeState && lastYoutubeState.duration);
}

function setupParentYtMediaSession(state) {
  if (!('mediaSession' in navigator) || !state || !state.videoId) return;
  try {
    const id = state.videoId;
    const title = state.title || 'BaixaTube';
    if (lastParentMediaVideoId !== id || lastParentMediaTitle !== title) {
      lastParentMediaVideoId = id;
      lastParentMediaTitle = title;
      const thumb = 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/hqdefault.jpg';
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: state.channel || 'Papaléguas BaixaTube',
        album: 'Papaléguas Navegador',
        artwork: [
          { src: thumb, sizes: '480x360', type: 'image/jpeg' },
          { src: 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/mqdefault.jpg', sizes: '320x180', type: 'image/jpeg' },
          { src: 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/maxresdefault.jpg', sizes: '1280x720', type: 'image/jpeg' }
        ]
      });

      navigator.mediaSession.setActionHandler('play', () => {
        if (lastYoutubeState) lastYoutubeState.isPlaying = true;
        const isPip = isMobilePipActive();
        if (isPip) {
          if (ytPipVideo) { ytPipVideo.muted = false; ytPipVideo.play().catch(() => {}); }
          if (ytNotifyAudio) { try { ytNotifyAudio.pause(); } catch (e) { swallowed(e, 'renderer:setupParentYtMediaSession@4980'); } ytNotifyAudio.muted = true; }
          postYoutubeCommand('mute');
        } else if (document.hidden) {
          if (ytPipVideo) { try { ytPipVideo.pause(); } catch (e) { swallowed(e, 'renderer:setupParentYtMediaSession@4983'); } ytPipVideo.muted = true; }
          if (ytNotifyAudio) {
            ytNotifyAudio.muted = false;
            ytNotifyAudio.play().catch(() => {});
          }
          postYoutubeCommand('mute');
        } else {
          if (ytNotifyAudio) { try { ytNotifyAudio.pause(); } catch (e) { swallowed(e, 'renderer:setupParentYtMediaSession@4990'); } ytNotifyAudio.muted = true; }
          if (ytPipVideo) { try { ytPipVideo.pause(); } catch (e) { swallowed(e, 'renderer:setupParentYtMediaSession@4991'); } ytPipVideo.muted = true; }
          postYoutubeCommand('unmute');
          postYoutubeCommand('play');
        }
        navigator.mediaSession.playbackState = 'playing';
        updateGlobalYtMiniUI();
        requestAppWakeLock();
      });

      navigator.mediaSession.setActionHandler('pause', () => {
        if (lastYoutubeState) lastYoutubeState.isPlaying = false;
        stopYtKeepAlive();
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
      } catch (e) { swallowed(e, 'renderer:setupParentYtMediaSession@5015'); }

      navigator.mediaSession.setActionHandler('previoustrack', () => postYoutubeCommand('prev'));
      navigator.mediaSession.setActionHandler('nexttrack', () => postYoutubeCommand('next'));
      navigator.mediaSession.setActionHandler('stop', () => {
        if (lastYoutubeState) lastYoutubeState.isPlaying = false;
        stopYtKeepAlive();
        if (ytNotifyAudio) {
          ytNotifyAudio.pause();
          ytNotifyAudio.removeAttribute('src');
          ytNotifyAudio.load();
        }
        if (ytPipVideo) {
          try { ytPipVideo.pause(); } catch (e) { swallowed(e, 'renderer:setupParentYtMediaSession@5028'); }
          ytPipVideo.muted = true;
        }
        postYoutubeCommand('pause');
        navigator.mediaSession.playbackState = 'none';
        updateGlobalYtMiniUI();
        releaseAppWakeLock();
      });

      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details && typeof details.seekTime === 'number' && isFinite(details.seekTime)) {
          handleParentMediaSeek(details.seekTime);
        }
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const skip = (details && details.seekOffset) || 10;
        const cur = (lastYoutubeState && lastYoutubeState.currentTime) || (ytNotifyAudio ? ytNotifyAudio.currentTime : 0) || 0;
        handleParentMediaSeek(cur + skip);
      });
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const skip = (details && details.seekOffset) || 10;
        const cur = (lastYoutubeState && lastYoutubeState.currentTime) || (ytNotifyAudio ? ytNotifyAudio.currentTime : 0) || 0;
        handleParentMediaSeek(Math.max(0, cur - skip));
      });
    }

    navigator.mediaSession.playbackState = state.isPlaying === false ? 'paused' : 'playing';
    syncParentYtMediaSessionPosition(state.currentTime, state.duration);
  } catch (e) { swallowed(e, 'renderer:setupParentYtMediaSession@5056'); }
}

function startParentYtAudio(state, opts) {
  if (!ytNotifyAudio || !state || !state.videoId || isElectronShell()) return;
  // Regra de ouro: se o PiP estiver ativo, o áudio toca SOMENTE pelo PiP, nunca pelo áudio de fundo
  if (isMobilePipActive()) {
    if (!ytNotifyAudio.paused) {
      try { ytNotifyAudio.pause(); } catch (e) { swallowed(e, 'renderer:startParentYtAudio@5064'); }
      ytNotifyAudio.muted = true;
    }
    setupParentYtMediaSession(Object.assign({}, state, { isPlaying: true }));
    return;
  }
  const unmute = !!(opts && opts.unmute && document.hidden);
  const id = state.videoId;
  ytNotifyAudio.setAttribute('playsinline', 'true');
  ytNotifyAudio.playsInline = true;
  ytNotifyAudio.loop = false;
  if (ytNotifyAudio.dataset.vid !== id || !ytNotifyAudio.src || ytNotifyAudio.src.indexOf('stream-audio') === -1) {
    ytNotifyAudio.dataset.vid = id;
    ytNotifyAudio.src = ytNotifyStreamUrl(id);
  }
  ytNotifyAudio.muted = !unmute;
  if (!document.hidden) {
    ytNotifyAudio.muted = true;
    try { ytNotifyAudio.pause(); } catch (e) { swallowed(e, 'renderer:startParentYtAudio@5082'); }
    setupParentYtMediaSession(Object.assign({}, state, { isPlaying: true }));
    return;
  }
  const t = typeof state.currentTime === 'number' ? state.currentTime : 0;
  if (ytNotifyAudio.paused) {
    const playp = ytNotifyAudio.play();
    if (playp && typeof playp.then === 'function') {
      playp.then(() => {
        if (t > 1 && ytNotifyAudio.readyState >= 1) {
          try { ytNotifyAudio.currentTime = t; } catch (e) { swallowed(e, 'renderer:startParentYtAudio@5092'); }
        }
        if (unmute) postYoutubeCommand('mute');
      }).catch(() => {
        if (document.hidden) {
          ytNotifyAudio.muted = false;
          ytNotifyAudio.play().catch(() => {});
        }
      });
    }
  } else if (unmute && ytNotifyAudio.muted) {
    ytNotifyAudio.muted = false;
  }
  setupParentYtMediaSession(Object.assign({}, state, { isPlaying: true }));
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
  // Em segundo plano, quem toca é o áudio do shell (ytNotifyAudio). O iframe do
  // BaixaTube não consegue tocar oculto e responde "pausado" (inclusive como eco
  // do nosso próprio comando 'pause'). Se o usuário não pausou, ignora essa pausa
  // para não derrubar o áudio de fundo nem a notificação.
  const shellOwnsBgAudio = document.hidden
    && !isElectronShell()
    && !isMobilePipActive()
    && !!lastYoutubeState
    && lastYoutubeState.isPlaying === true
    && !!ytNotifyAudio;
  if (shellOwnsBgAudio && state && state.isPlaying === false) {
    if (!state.videoId || state.videoId === lastYoutubeState.videoId) return;
    // Vídeo novo (próximo da fila) chegando como "pausado": continua tocando
    state = Object.assign({}, state, { isPlaying: true, currentTime: 0 });
  }
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
  postYoutubeCommand('unmute');
  postYoutubeCommand('play');
}
['fullscreenchange', 'webkitfullscreenchange', 'MSFullscreenChange'].forEach((evName) => {
  document.addEventListener(evName, onAppFullscreenChange);
});

['touchstart', 'pointerdown', 'click'].forEach((evName) => {
  window.addEventListener(evName, unlockYtNotifyAudio, { once: true, capture: true, passive: true });
});

function leaveBrowserToOsPip() {
  if (!lastYoutubeState || !lastYoutubeState.videoId || lastYoutubeState.isPlaying === false) return;
  if (!isMobilePipClient() || isMobilePipActive() || document.hidden) return;
  prepareMobilePipVideo(lastYoutubeState).then(() => enterMobilePictureInPicture()).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  const isHidden = document.hidden;
  document.querySelectorAll('iframe').forEach(iframe => {
    try {
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'parent-visibility-change', hidden: isHidden }, '*');
      }
    } catch(e) { swallowed(e, 'renderer:top@5225'); }
  });

  if (!lastYoutubeState || !lastYoutubeState.videoId) return;
  const isPipActive = isMobilePipActive();

  if (document.hidden) {
    releaseAppWakeLock();
    if (lastYoutubeState.isPlaying) {
      if (isPipActive) {
        // Se o PiP já estiver rodando, o áudio toca SOMENTE por ele: silencia notificação e iframe
        if (ytNotifyAudio) {
          try { ytNotifyAudio.pause(); } catch (e) { swallowed(e, 'renderer:top@5237'); }
          ytNotifyAudio.muted = true;
        }
        postYoutubeCommand('mute');
      } else {
        // Se NÃO estiver em PiP, silencia o PiP e o iframe, e toca apenas o áudio de fundo
        if (ytPipVideo) {
          try { ytPipVideo.pause(); } catch (e) { swallowed(e, 'renderer:top@5244'); }
          ytPipVideo.muted = true;
        }
        postYoutubeCommand('mute');
        postYoutubeCommand('pause');
        startParentYtAudio(lastYoutubeState, { unmute: true });
      }
    }
  } else {
    stopYtKeepAlive();
    if (lastYoutubeState.isPlaying) requestAppWakeLock();
    if (!isPipActive) {
      // Retornou ao app sem PiP: desliga o áudio de notificação e restaura o vídeo no iframe
      if (ytNotifyAudio && !ytNotifyAudio.paused) {
        const cur = ytNotifyAudio.currentTime || 0;
        try { ytNotifyAudio.pause(); } catch (e) { swallowed(e, 'renderer:top@5259'); }
        ytNotifyAudio.muted = true;
        if (cur > 1) {
          lastYoutubeState.currentTime = cur;
          postYoutubeCommand('seek', cur);
        }
      }
      if (ytPipVideo) {
        try { ytPipVideo.pause(); } catch (e) { swallowed(e, 'renderer:top@5267'); }
        ytPipVideo.muted = true;
      }
      postYoutubeCommand('unmute');
      postYoutubeCommand('play');
    }
  }
  updateGlobalYtMiniUI();
});

if (ytPipVideo) {
  ytPipVideo.addEventListener('enterpictureinpicture', () => {
    armPipAudioForBackground();
  });
  ytPipVideo.addEventListener('leavepictureinpicture', () => {
    const cur = (ytPipVideo && ytPipVideo.currentTime) || 0;
    if (ytPipVideo) {
      try { ytPipVideo.pause(); } catch (e) { swallowed(e, 'renderer:top@5284'); }
      ytPipVideo.muted = true;
    }
    if (cur > 1 && lastYoutubeState) {
      lastYoutubeState.currentTime = cur;
      postYoutubeCommand('seek', cur);
    }
    if (document.hidden) {
      // Se fechou o PiP com o celular bloqueado ou em outro app, continua pelo áudio de notificação
      if (lastYoutubeState && lastYoutubeState.isPlaying) {
        startParentYtAudio(lastYoutubeState, { unmute: true });
      }
    } else {
      postYoutubeCommand('unmute');
      postYoutubeCommand('play');
    }
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
    } catch (e) { swallowed(e, 'renderer:collectYoutubePlaybackState@5362'); }
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
    } catch (e) { swallowed(e, 'renderer:detectCurrentMediaToCast@5415'); }

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
    } catch (e) { swallowed(e, 'renderer:detectCurrentMediaToCast@5459'); }

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

async function openBrowserCastHub() {
  if (window.PapaleguasCastHub && typeof window.PapaleguasCastHub.open === 'function') {
    const detected = await detectCurrentMediaToCast();
    window.PapaleguasCastHub.open({
      getMedia: () => {
        const vid = (lastYoutubeState && lastYoutubeState.videoId) || extractYoutubeVideoId(detected.url) || '';
        const title = (lastYoutubeState && lastYoutubeState.title) || detected.title || 'Papaléguas';
        return {
          videoId: vid,
          title,
          url: vid ? ('https://www.youtube.com/watch?v=' + vid) : (detected.url || location.href)
        };
      }
    });
    return;
  }
  if (castModal) {
    castModal.classList.toggle('hidden');
    if (!castModal.classList.contains('hidden')) {
      loadCastDevices();
    }
  }
}

if (btnCast) {
  btnCast.addEventListener('click', () => {
    openBrowserCastHub();
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
    try { recognition.stop(); } catch(e){ swallowed(e, 'renderer:speakText@6028'); }
  }

  if (currentAudio) {
    try { currentAudio.pause(); } catch(e){ swallowed(e, 'renderer:speakText@6032'); }
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

  // Se o usuário entrou no celular direto pela URL /baixatube, /filmes, /musica, /home ou /menu:
  const initPath = (window.location && window.location.pathname) || '';

  if (initPath === '/baixatube' || initPath === '/youtube') {
    openYoutube('');
  } else if (initPath === '/filmes' || initPath === '/filme') {
    openFilmesOnline('');
  } else if (initPath === '/musica' || initPath === '/music') {
    openPapaleguasMusic('');
  } else if (initPath === '/home' || initPath === '/menu') {
    goHomeFromFullscreen();
  }

  // Normaliza apenas rotas auxiliares /home, /menu ou /inicio para '/'
  if (!isElectronApp() && window.history && typeof window.history.replaceState === 'function') {
    try {
      if (initPath === '/home' || initPath === '/menu' || initPath === '/inicio') {
        window.history.replaceState({}, '', '/');
      }
    } catch (e) { swallowed(e, 'renderer:top@6265'); }
  }
  enforceCleanPortalUrl();

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

// Suporte a navegação por histórico do navegador móvel (voltar/avançar no celular)
window.addEventListener('popstate', (e) => {
  window.__papaleguasHandlingPopstate = true;
  try {
    // Se houver histórico anterior na aba ou tema pesquisado, volta para o link anterior ou tema pesquisado!
    if (canActiveTabGoBack()) {
      handleGoBack();
      return;
    }
    const activeTab = getActiveTab();
    const activeIsSearch = activeTab && activeTab.url && (/\/search(?:\?|$)/i.test(activeTab.url) || /duckduckgo\.com/i.test(activeTab.url));
    if (activeIsSearch) {
      enforceCleanPortalUrl();
      return;
    }
    try {
      sessionStorage.removeItem('papaleguas_last_search_url');
      localStorage.removeItem('papaleguas_last_search_url');
      localStorage.removeItem('papaleguas_search_history');
      localStorage.removeItem('papaleguas_saved_tabs');
    } catch (err) {}
    const p = (window.location && window.location.pathname) || '/';
    if (p === '/baixatube' || p === '/youtube') {
      openYoutube('');
    } else if (p === '/filmes' || p === '/filme') {
      openFilmesOnline('');
    } else if (p === '/musica' || p === '/music') {
      openPapaleguasMusic('');
    }
    enforceCleanPortalUrl();
  } finally {
    window.__papaleguasHandlingPopstate = false;
  }
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

const STORAGE_KEY_DISABLED_VIDEO_SITES = 'papaleguas_disabled_video_sites';

function getSiteHost(raw) {
  if (!raw) return '';
  let str = String(raw).trim();
  try {
    if (str.includes('/proxy?') || str.includes('/proxy/')) {
      const match = str.match(/[?&]url=([^&#]+)/i);
      if (match && match[1]) {
        try { str = decodeURIComponent(match[1]); } catch (e) { str = match[1]; }
      }
    }
    if (!/^https?:\/\//i.test(str) && !str.startsWith('file://')) {
      str = 'https://' + str.replace(/^\/+/, '');
    }
    const parsed = new URL(str);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (isLocalAppHost(host) || host === 'papaleguas.app') {
      const inner = parsed.searchParams.get('url');
      if (inner) return getSiteHost(inner);
    }
    return host;
  } catch (e) {
    return '';
  }
}

function getDisabledVideoSites() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DISABLED_VIDEO_SITES);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(s => String(s || '').toLowerCase().trim().replace(/^www\./i, ''))
      .filter(s => s && s !== 'localhost' && s !== '127.0.0.1' && s !== 'papaleguas.app');
  } catch (e) {
    return [];
  }
}

function isVideoRecognitionDisabledForHost(host) {
  if (!host) return false;
  const cleanHost = host.toLowerCase().trim().replace(/^www\./i, '');
  if (!cleanHost || cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === 'papaleguas.app') return false;
  const list = getDisabledVideoSites();
  return list.some(h => {
    const cleanH = String(h || '').toLowerCase().trim().replace(/^www\./i, '');
    return cleanHost === cleanH || cleanHost.endsWith('.' + cleanH) || cleanH.endsWith('.' + cleanHost);
  });
}

function disableVideoRecognitionForHost(host) {
  if (!host) return;
  const cleanHost = host.toLowerCase().trim().replace(/^www\./i, '');
  if (!cleanHost || cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === 'papaleguas.app') return;
  const list = getDisabledVideoSites();
  if (!list.includes(cleanHost)) {
    list.push(cleanHost);
    try {
      localStorage.setItem(STORAGE_KEY_DISABLED_VIDEO_SITES, JSON.stringify(list));
    } catch (e) {}
  }
  updateReactivateButtonVisibility(cleanHost);
}

function enableVideoRecognitionForHost(host) {
  if (!host) return;
  const cleanHost = host.toLowerCase().trim().replace(/^www\./i, '');
  let list = getDisabledVideoSites();
  list = list.filter(h => h !== cleanHost && !cleanHost.endsWith('.' + h) && !h.endsWith('.' + cleanHost));
  try {
    localStorage.setItem(STORAGE_KEY_DISABLED_VIDEO_SITES, JSON.stringify(list));
  } catch (e) {}
  updateReactivateButtonVisibility(cleanHost);
}

function getRelevantVideoHosts(data) {
  const hosts = new Set();
  const currentTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
  const tabUrl = (currentTab && (currentTab.url || currentTab.lastSearchUrl)) || '';
  const tabHost = getSiteHost(tabUrl);
  if (tabHost) hosts.add(tabHost);

  if (data) {
    if (data.pageUrl) {
      const ph = getSiteHost(data.pageUrl);
      if (ph) hosts.add(ph);
    }
    if (data.url) {
      const vh = getSiteHost(data.url);
      if (vh) hosts.add(vh);
    }
    if (data.sourceUrl) {
      const sh = getSiteHost(data.sourceUrl);
      if (sh) hosts.add(sh);
    }
  }
  return Array.from(hosts);
}

function isAnyRelevantHostDisabled(data) {
  const hosts = getRelevantVideoHosts(data);
  return hosts.some(h => isVideoRecognitionDisabledForHost(h));
}

function updateReactivateButtonVisibility(optionalHost) {
  const btn = document.getElementById('btn-reactivate-video-recognition');
  if (!btn) return;
  const currentTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
  const currentUrl = (currentTab && (currentTab.url || currentTab.lastSearchUrl)) || '';
  const host = optionalHost || getSiteHost(currentUrl);
  if (host && isVideoRecognitionDisabledForHost(host)) {
    btn.style.display = 'inline-flex';
    btn.setAttribute('data-host', host);
    const textEl = btn.querySelector('.reactivate-text');
    if (textEl) {
      textEl.textContent = 'Ativar Reconhecimento (' + host + ')';
    }
  } else {
    btn.style.display = 'none';
    btn.removeAttribute('data-host');
  }
}

function handleDisableVideoRecognition(e) {
  if (e) {
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch (err) {}
  }
  const currentTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
  const currentUrl = (currentTab && (currentTab.url || currentTab.lastSearchUrl)) || '';
  const pageHost = (activeDetectedVideo && activeDetectedVideo.pageUrl && getSiteHost(activeDetectedVideo.pageUrl))
    || (currentUrl && getSiteHost(currentUrl))
    || '';
  const videoHost = activeDetectedVideo ? getSiteHost(activeDetectedVideo.url) : '';
  const targetHost = pageHost || videoHost;

  if (targetHost) {
    disableVideoRecognitionForHost(targetHost);
  }
  if (videoHost && videoHost !== 'youtube.com' && videoHost !== targetHost) {
    disableVideoRecognitionForHost(videoHost);
  }

  if (activeDetectedVideo) {
    const key = pagePlayerKey(activeDetectedVideo);
    pagePlayerDismissed.add(key);
    pagePlayerDismissed.add('bar:' + key);
    if (activeDetectedVideo.url) {
      pagePlayerDismissed.add(activeDetectedVideo.url);
      pagePlayerDismissed.add('bar:' + activeDetectedVideo.url);
    }
  }

  closePagePlayer(true);
  hideVideoSnifferNotification();

  if (currentTab) {
    currentTab.detectedVideo = null;
    if (currentTab.webview) {
      try {
        currentTab.webview.send('video-recognition-disabled-for-page', { host: targetHost });
        currentTab.webview.executeJavaScript(`
          if (window.__papaleguasSniffTimer) {
            clearInterval(window.__papaleguasSniffTimer);
            window.__papaleguasSniffTimer = null;
          }
          window.__papaleguasVideoSniffDisabled = true;
        `).catch(() => {});
      } catch (err) {}
    }
  }
  activeDetectedVideo = null;

  updateReactivateButtonVisibility(targetHost);
  if (footerStatus) {
    footerStatus.textContent = 'Reconhecimento de vídeo desativado para ' + (targetHost || 'este site');
  }
}

function handleReactivateVideoRecognition(e) {
  if (e) {
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch (err) {}
  }
  const btn = document.getElementById('btn-reactivate-video-recognition');
  const btnHost = btn && btn.getAttribute('data-host');
  const currentTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
  const currentUrl = (currentTab && (currentTab.url || currentTab.lastSearchUrl)) || '';
  const host = btnHost || getSiteHost(currentUrl);
  if (host) {
    enableVideoRecognitionForHost(host);
  }
  updateReactivateButtonVisibility(host);
  if (footerStatus) {
    footerStatus.textContent = 'Reconhecimento de vídeo reativado para ' + (host || 'este site');
  }
  if (currentTab && currentTab.webview) {
    try {
      currentTab.webview.send('video-recognition-enabled-for-page', { host: host });
      currentTab.webview.executeJavaScript(`
        window.__papaleguasVideoSniffDisabled = false;
        if (typeof sniffVideos === "function") sniffVideos();
      `).catch(() => {});
    } catch (e) {}
  }
}

function pagePlayerKey(data) {
  return String((data && (data.youtubeId || data.mediaUrl || data.url)) || '');
}

function shouldUseOwnPlayer(data) {
  if (!data) return false;
  if (isAnyRelevantHostDisabled(data)) return false;
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
  } catch (e) { swallowed(e, 'renderer:pausePageVideos@6335'); }
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
    try { video.pause(); } catch (e) { swallowed(e, 'renderer:closePagePlayer@6353'); }
    video.hidden = true;
    video.removeAttribute('src');
    try { video.load(); } catch (e) { swallowed(e, 'renderer:closePagePlayer@6356'); }
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
  const currentTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
  const pageHost = (data.pageUrl && getSiteHost(data.pageUrl)) || (currentTab && getSiteHost(currentTab.url)) || '';
  const videoHost = getSiteHost(data.url) || '';
  const host = pageHost || videoHost;

  if (isAnyRelevantHostDisabled(data)) {
    updateReactivateButtonVisibility(host);
    closePagePlayer(false);
    return;
  }
  activeDetectedVideo = data;
  const box = document.getElementById('page-player');
  const frame = document.getElementById('page-player-frame');
  const video = document.getElementById('page-player-video');
  const status = document.getElementById('page-player-status');
  const title = document.getElementById('page-player-title');
  const disableTopBtn = document.getElementById('page-player-disable-top');
  const disableActBtn = document.getElementById('page-player-disable');
  if (disableTopBtn) {
    disableTopBtn.textContent = '🚫 Desativar em ' + (host || 'este site');
    disableTopBtn.title = 'Desativar reconhecimento de vídeo em ' + (host || 'este site');
  }
  if (disableActBtn) {
    disableActBtn.textContent = '🚫 Desativar Reconhecimento em ' + (host || 'este site');
    disableActBtn.title = 'Desativar reconhecimento de vídeo em ' + (host || 'este site');
  }
  if (!box || !frame || !video) return;
  if (title) title.textContent = data.title || 'Vídeo';
  box.hidden = false;
  if (videoSnifferBar) videoSnifferBar.style.display = 'none';
  pausePageVideos();
  if (typeof fsHomeVideoWatch === 'function') fsHomeVideoWatch(true);

  if (data.youtubeId) {
    video.hidden = true;
    try { video.pause(); } catch (e) { swallowed(e, 'renderer:openPagePlayer@6384'); }
    frame.hidden = false;
    const origin = (window.location.origin && window.location.origin !== 'null' && window.location.protocol !== 'file:') ? window.location.origin : 'http://localhost:8080';
    frame.src = 'https://www.youtube.com/embed/' + encodeURIComponent(data.youtubeId) + '?autoplay=1&rel=0&playsinline=1&enablejsapi=1&origin=' + encodeURIComponent(origin) + '&widget_referrer=' + encodeURIComponent(origin);
    if (status) status.hidden = true;
    if (!window.__pagePlayerYtFallbackBound) {
      window.__pagePlayerYtFallbackBound = true;
      setInterval(() => {
        if (frame && !frame.hidden && frame.contentWindow) {
          try { frame.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*'); } catch (e) { swallowed(e, 'renderer:openPagePlayer@6393'); }
        }
      }, 1200);
      window.addEventListener('message', (ev) => {
        if (!activeDetectedVideo || !activeDetectedVideo.youtubeId || frame.hidden) return;
        try {
          const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
          const vd = msg && msg.info && msg.info.videoData;
          if ((msg && msg.event === 'onError') || (vd && (vd.isPlayable === false || vd.errorCode))) {
            frame.hidden = true;
            frame.src = 'about:blank';
            video.hidden = false;
            video.src = window.encryptPplSearchUrl(publicAppOrigin() + '/api/stream-video?v=' + encodeURIComponent(activeDetectedVideo.youtubeId));
            video.play().catch(() => {});
          }
        } catch (e) { swallowed(e, 'renderer:openPagePlayer@6408'); }
      });
    }
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
  const currentTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
  const pageHost = (data.pageUrl && getSiteHost(data.pageUrl)) || (currentTab && getSiteHost(currentTab.url)) || '';
  const videoHost = getSiteHost(data.url) || '';
  const host = pageHost || videoHost;

  if (isAnyRelevantHostDisabled(data)) {
    updateReactivateButtonVisibility(host);
    if (currentTab) currentTab.detectedVideo = null;
    activeDetectedVideo = null;
    closePagePlayer(false);
    hideVideoSnifferNotification();
    return;
  }
  updateReactivateButtonVisibility(host);
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
const pagePlayerDisableTop = document.getElementById('page-player-disable-top');
const pagePlayerDisable = document.getElementById('page-player-disable');
const btnReactivateVideoSniff = document.getElementById('btn-reactivate-video-recognition');
const pagePlayerMp4 = document.getElementById('page-player-mp4');
const pagePlayerMp3 = document.getElementById('page-player-mp3');
if (pagePlayerClose) pagePlayerClose.addEventListener('click', () => closePagePlayer(true));
if (pagePlayerDisableTop) pagePlayerDisableTop.addEventListener('click', handleDisableVideoRecognition);
if (pagePlayerDisable) pagePlayerDisable.addEventListener('click', handleDisableVideoRecognition);
if (btnReactivateVideoSniff) btnReactivateVideoSniff.addEventListener('click', handleReactivateVideoRecognition);

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
    } catch(e) { swallowed(e, 'renderer:sendMusicControlCommand@6745'); }
    try {
      if (musicTab.webview.contentWindow && typeof musicTab.webview.contentWindow.postMessage === 'function') {
        musicTab.webview.contentWindow.postMessage({ type: 'music-player-control', action, value }, '*');
      }
    } catch(e) { swallowed(e, 'renderer:sendMusicControlCommand@6750'); }
  } else if (action === 'toggle' || action === 'play') {
    openPapaleguasMusic('');
  }
}

function clearGlobalMusicState() {
  lastGlobalMusicState = null;
  try { localStorage.removeItem('papaleguas_last_music_state'); } catch (e) { swallowed(e, 'renderer:clearGlobalMusicState@6758'); }
  if (window.torBrowserAPI && typeof window.torBrowserAPI.updateMusicTrayState === 'function') {
    try { window.torBrowserAPI.updateMusicTrayState(null); } catch (e) { swallowed(e, 'renderer:clearGlobalMusicState@6760'); }
  }
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    } catch (e) { swallowed(e, 'renderer:clearGlobalMusicState@6766'); }
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
  } catch(e) { swallowed(e, 'renderer:updateGlobalMusicPlayerUI@6782'); }

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
    } catch (e) { swallowed(e, 'renderer:updateGlobalMusicPlayerUI@6835'); }
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
  } catch (e) { swallowed(e, 'renderer:restoreMiniPlayerPosition@6961'); }
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
    } catch(err) { swallowed(err, 'renderer:top@6994'); }

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
      } catch(err) { swallowed(err, 'renderer:onGmPointerUp@7027'); }

      // Salva a posição exata para permanecer entre todas as abas e recarregamentos
      const curRect = globalMusicMiniPlayer.getBoundingClientRect();
      try {
        localStorage.setItem('papaleguas_mini_player_pos', JSON.stringify({
          left: Math.round(curRect.left),
          top: Math.round(curRect.top)
        }));
      } catch (err) { swallowed(err, 'renderer:onGmPointerUp@7036'); }

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
  } catch (e) { swallowed(e, 'renderer:restoreSavedBookmarks@7092'); }
}

restoreSavedBookmarks();

function wipeLocalTraces() {
  const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
  let keptBookmarks = null;
  const key = (typeof getBookmarksStorageKey === 'function') ? getBookmarksStorageKey() : 'user_bookmarks';
  if (!isElectron) {
    try { keptBookmarks = localStorage.getItem(key) || localStorage.getItem('user_bookmarks'); } catch (e) { swallowed(e, 'renderer:wipeLocalTraces@7102'); }
  }
  let keptEq = null, keptSize = null, keptCountry = null, keptBtCountry = null, keptClientId = null, keptDeviceId = null, keptYtPrefs = null, keptAppVer = null, keptLastVer = null, keptLastTs = null, keptFastFeed = null, keptFastMusic = null;
  try {
    keptEq = localStorage.getItem('papaleguas_music_eq');
    keptSize = localStorage.getItem('sp_player_size');
    keptCountry = localStorage.getItem('papaleguas_selected_country');
    keptBtCountry = localStorage.getItem('papaleguas_baixatube_country');
    keptClientId = localStorage.getItem('papaleguas_client_id');
    keptDeviceId = localStorage.getItem('papaleguas_device_id');
    keptYtPrefs = localStorage.getItem('papaleguas_yt_prefs_v1');
    keptAppVer = localStorage.getItem('pl_app_version');
    keptLastVer = localStorage.getItem('pl_last_attempted_ver');
    keptLastTs = localStorage.getItem('pl_last_attempt_ts');
    keptFastFeed = localStorage.getItem('papaleguas_fast_feed_cache_v1');
    keptFastMusic = localStorage.getItem('papaleguas_fast_music_home_v1');
  } catch (e) { swallowed(e, 'renderer:wipeLocalTraces@7118'); }
  try { localStorage.clear(); } catch (e) { swallowed(e, 'renderer:wipeLocalTraces@7119'); }
  try {
    if (keptBookmarks !== null) {
      localStorage.setItem(key, keptBookmarks);
      if (isElectron) localStorage.setItem('user_bookmarks', keptBookmarks);
    }
    if (keptEq) localStorage.setItem('papaleguas_music_eq', keptEq);
    if (keptSize) localStorage.setItem('sp_player_size', keptSize);
    if (keptCountry) localStorage.setItem('papaleguas_selected_country', keptCountry);
    if (keptBtCountry) localStorage.setItem('papaleguas_baixatube_country', keptBtCountry);
    if (keptClientId) localStorage.setItem('papaleguas_client_id', keptClientId);
    if (keptDeviceId) localStorage.setItem('papaleguas_device_id', keptDeviceId);
    if (keptYtPrefs) localStorage.setItem('papaleguas_yt_prefs_v1', keptYtPrefs);
    if (keptAppVer) localStorage.setItem('pl_app_version', keptAppVer);
    if (keptLastVer) localStorage.setItem('pl_last_attempted_ver', keptLastVer);
    if (keptLastTs) localStorage.setItem('pl_last_attempt_ts', keptLastTs);
    if (keptFastFeed) localStorage.setItem('papaleguas_fast_feed_cache_v1', keptFastFeed);
    if (keptFastMusic) localStorage.setItem('papaleguas_fast_music_home_v1', keptFastMusic);
  } catch (e) { swallowed(e, 'renderer:wipeLocalTraces@7137'); }
  try { sessionStorage.clear(); } catch (e) { swallowed(e, 'renderer:wipeLocalTraces@7138'); }
  try {
    document.cookie.split(';').forEach((cookie) => {
      const name = cookie.split('=')[0].trim();
      if (!name || name === 'papaleguas_device_id' || name === 'ngrok-skip-browser-warning') return;
      document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
    });
  } catch (e) { swallowed(e, 'renderer:wipeLocalTraces@7145'); }
  try {
    if (window.caches && caches.keys) {
      caches.keys().then((keys) => keys.forEach((key) => caches.delete(key))).catch(() => {});
    }
  } catch (e) { swallowed(e, 'renderer:wipeLocalTraces@7150'); }
  try {
    if (window.indexedDB && indexedDB.databases) {
      indexedDB.databases().then((dbs) => {
        (dbs || []).forEach((db) => { 
          if (db && db.name && db.name !== 'papaleguas_music_offline' && db.name !== 'PapaleguasPrefsDB') {
            indexedDB.deleteDatabase(db.name); 
          }
        });
      }).catch(() => {});
    }
  } catch (e) { swallowed(e, 'renderer:wipeLocalTraces@7161'); }
}

function clearSearchFields() {
  sessionRecentSearches = [];
  urlSuggestState.items = [];
  urlSuggestState.q = '';
  try { hideUrlSuggestions(); } catch (e) { swallowed(e, 'renderer:clearSearchFields@7168'); }
  try { if (urlInput) urlInput.value = ''; } catch (e) { swallowed(e, 'renderer:clearSearchFields@7169'); }
  try { setAddressBar(''); } catch (e) { swallowed(e, 'renderer:clearSearchFields@7170'); }
}

function clearAllTraces() {
  if (tracesWiped) return;
  tracesWiped = true;
  clearSearchFields();
  wipeLocalTraces();
}

window.addEventListener('beforeunload', clearAllTraces);
window.addEventListener('pageshow', () => {
  tracesWiped = false;
});

// Pré-aquecimento silencioso dos portais Filmes e Música em segundo plano para transição instantânea no primeiro clique
setTimeout(() => {
  try {
    const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
    const baseUrl = isElectron ? 'http://localhost:8080' : '';
    fetch(baseUrl + '/filmes', { method: 'GET', credentials: 'same-origin' }).catch(() => {});
    fetch(baseUrl + '/api/playlists?q=top%20playlists%20brasil', { method: 'GET', credentials: 'same-origin' }).catch(() => {});
  } catch (e) { swallowed(e, 'renderer:top@7192'); }
}, 2000);

// ====================================================
// SUPER NAVEGADOR: MODO LEITURA, COMMAND PALETTE (CTRL+K) E SUSPENSÃO DE ABAS
// ====================================================
(function initSuperBrowserEnhancements() {
  let readerFontPx = 16;

  function resolveRealTabUrl(rawUrl) {
    const s = String(rawUrl || '').trim();
    if (!s) return '';
    try {
      const u = new URL(s, window.location.origin);
      if (u.pathname === '/proxy' && u.searchParams.get('url')) {
        return u.searchParams.get('url');
      }
      if (/^https?:\/\//i.test(s) && !isLocalAppHost(u.hostname)) {
        return u.href;
      }
    } catch (e) {}
    return '';
  }

  function escapeSafeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function openReaderModeForActiveTab() {
    const modal = document.getElementById('reader-mode-modal');
    const bodyEl = document.getElementById('reader-modal-body');
    const titleEl = document.getElementById('reader-modal-title');
    if (!modal || !bodyEl) return;

    const activeTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
    const rawCandidate = (activeTab && activeTab.url) || (urlInput && urlInput.value) || '';
    const targetUrl = resolveRealTabUrl(rawCandidate);

    modal.classList.remove('hidden');
    if (!targetUrl) {
      if (titleEl) titleEl.textContent = 'Modo Leitura Limpo';
      bodyEl.innerHTML = '<div style="padding:18px;color:#94a3b8;text-align:center;">Abra qualquer site ou notícia para ativar o <b>Modo Leitura Limpo</b> (sem anúncios, banners de cookies ou distrações). Na página de buscas você também pode clicar em <b>📖 Modo Leitura Limpo</b> em qualquer resultado.</div>';
      return;
    }

    if (titleEl) titleEl.textContent = targetUrl;
    bodyEl.innerHTML = '<div style="padding:24px;color:#94a3b8;text-align:center;">⏳ Extraindo artigo limpo sem anúncios e sem rastreadores...</div>';

    try {
      const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
      const baseUrl = isElectron ? 'http://localhost:8080' : '';
      const res = await fetch(`${baseUrl}/api/reader?url=${encodeURIComponent(targetUrl)}`);
      const data = await res.json();
      if (!data || !data.success || !Array.isArray(data.paragraphs) || !data.paragraphs.length) {
        bodyEl.innerHTML = '<div style="padding:18px;color:#94a3b8;">Não foi possível extrair texto corrido desta página.</div>';
        return;
      }
      if (titleEl && data.title) titleEl.textContent = data.title;
      let html = `<article style="max-width:680px;margin:0 auto;">
        <div style="font-size:11.5px;color:#38bdf8;font-weight:700;text-transform:uppercase;margin-bottom:6px;">${escapeSafeHtml(data.siteName || '')} • Modo Leitura Papaléguas</div>
        <h1 style="font-size:1.4em;color:#fff;margin:0 0 16px;line-height:1.3;">${escapeSafeHtml(data.title || '')}</h1>`;
      data.paragraphs.forEach((b) => {
        const txt = escapeSafeHtml(b.text || '');
        if (b.tag === 'h2' || b.tag === 'h3') {
          html += `<h2 style="font-size:1.15em;color:#f8fafc;margin:16px 0 8px;">${txt}</h2>`;
        } else if (b.tag === 'blockquote') {
          html += `<blockquote style="border-left:3px solid #38bdf8;padding-left:12px;color:#cbd5e1;margin:12px 0;">${txt}</blockquote>`;
        } else {
          html += `<p style="margin:0 0 14px;color:#e2e8f0;">${txt}</p>`;
        }
      });
      html += '</article>';
      bodyEl.innerHTML = html;
    } catch (e) {
      bodyEl.innerHTML = '<div style="padding:18px;color:#94a3b8;">Falha ao carregar Modo Leitura.</div>';
    }
  }

  const btnReader = document.getElementById('btn-reader-mode');
  const closeReaderBtn = document.getElementById('close-reader-modal-btn');
  const readerModal = document.getElementById('reader-mode-modal');
  const readerDec = document.getElementById('reader-font-dec');
  const readerInc = document.getElementById('reader-font-inc');

  if (btnReader) btnReader.addEventListener('click', openReaderModeForActiveTab);
  if (closeReaderBtn && readerModal) {
    closeReaderBtn.addEventListener('click', () => readerModal.classList.add('hidden'));
  }
  if (readerDec) {
    readerDec.addEventListener('click', () => {
      readerFontPx = Math.max(13, readerFontPx - 2);
      const b = document.getElementById('reader-modal-body');
      if (b) b.style.fontSize = `${readerFontPx}px`;
    });
  }
  if (readerInc) {
    readerInc.addEventListener('click', () => {
      readerFontPx = Math.min(26, readerFontPx + 2);
      const b = document.getElementById('reader-modal-body');
      if (b) b.style.fontSize = `${readerFontPx}px`;
    });
  }

  // Suspensão inteligente de abas em segundo plano para economizar RAM
  function suspendInactiveTabs() {
    let suspendedCount = 0;
    (tabs || []).forEach((tab) => {
      if (!tab || tab.id === activeTabId || tab.suspended) return;
      const u = String(tab.url || '').toLowerCase();
      // Nunca suspende abas de música, vídeo ou página inicial
      if (u.includes('/musica') || u.includes('/baixatube') || u.includes('newtab.html') || u.includes('/filmes')) return;
      if (tab.webview && tab.url && tab.url !== 'about:blank') {
        tab.suspendedUrl = tab.url;
        tab.suspended = true;
        try { tab.webview.src = 'about:blank'; } catch (e) {}
        suspendedCount += 1;
      }
    });
    return suspendedCount;
  }

  // Restaura aba suspensa automaticamente quando o usuário clica nela
  document.addEventListener('click', () => {
    const active = typeof getActiveTab === 'function' ? getActiveTab() : null;
    if (active && active.suspended && active.suspendedUrl && active.webview) {
      const restoreUrl = active.suspendedUrl;
      active.suspended = false;
      active.suspendedUrl = '';
      try { active.webview.src = restoreUrl; } catch (e) {}
    }
  });

  // Command Palette (Ctrl+K)
  const cmdModal = document.getElementById('command-palette-modal');
  const cmdInput = document.getElementById('cmd-palette-input');
  const cmdList = document.getElementById('cmd-palette-list');
  const closeCmdBtn = document.getElementById('close-cmd-palette-btn');
  const openCmdBtn = document.getElementById('btn-open-cmd-palette');

  function closeCommandPalette() {
    if (cmdModal) cmdModal.classList.add('hidden');
  }

  function renderCommandPaletteItems(filterText) {
    if (!cmdList) return;
    const q = String(filterText || '').trim().toLowerCase();
    const items = [];

    (tabs || []).forEach((t) => {
      items.push({
        icon: t.id === activeTabId ? '🟢' : '🗂️',
        title: `Aba: ${tabDisplayTitle(t)}`,
        sub: prettyAddressBarUrl(t.url) || 'Página aberta',
        run: () => { activateTab(t.id); }
      });
    });

    items.push(
      { icon: '📖', title: 'Ativar Modo Leitura Limpo na aba atual', sub: 'Sem anúncios, pop-ups ou banners', run: () => openReaderModeForActiveTab() },
      { icon: '📹', title: 'Buscar Câmeras IP Públicas Conectadas', sub: 'Filtro direto de câmeras ao vivo', run: () => navigateToUrl('/search?q=brasil&filter=ipcam') },
      { icon: '📄', title: 'Buscar Documentos e Livros em PDF', sub: 'Filtro direto de arquivos PDF', run: () => navigateToUrl('/search?q=livros&filter=pdf') },
      { icon: '⚡', title: 'Suspender abas inativas (Economizar RAM)', sub: 'Congela abas em segundo plano sem fechar', run: () => { suspendInactiveTabs(); } },
      { icon: '➕', title: 'Abrir Nova Aba Privada', sub: 'Atalho rápido', run: () => createTab() },
      { icon: '🎵', title: 'Abrir Papaléguas Músicas', sub: 'Streaming de áudio sem anúncios', run: () => { if (btnSpotify) btnSpotify.click(); } },
      { icon: '🎬', title: 'Abrir Filmes Online', sub: 'Catálogo de filmes e canais', run: () => { if (btnMovies) btnMovies.click(); } },
      { icon: '▶', title: 'Abrir BaixaTube', sub: 'Vídeos e downloads MP4/MP3', run: () => { if (btnYoutube) btnYoutube.click(); } }
    );

    const filtered = q
      ? items.filter((it) => (`${it.title} ${it.sub}`).toLowerCase().includes(q))
      : items;

    cmdList.innerHTML = '';
    filtered.slice(0, 14).forEach((it) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:9px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);color:#f8fafc;text-align:left;cursor:pointer;transition:background 0.15s;';
      btn.innerHTML = `<span style="display:flex;align-items:center;gap:9px;min-width:0;">
        <span style="font-size:16px;">${it.icon}</span>
        <span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeSafeHtml(it.title)}</span>
      </span>
      <small style="font-size:11px;color:#94a3b8;flex-shrink:0;">${escapeSafeHtml(it.sub)}</small>`;
      btn.addEventListener('click', () => {
        closeCommandPalette();
        hideTabsMenu();
        it.run();
      });
      cmdList.appendChild(btn);
    });
  }

  function openCommandPalette() {
    if (!cmdModal) return;
    cmdModal.classList.remove('hidden');
    if (cmdInput) {
      cmdInput.value = '';
      setTimeout(() => cmdInput.focus(), 40);
    }
    renderCommandPaletteItems('');
  }

  if (openCmdBtn) openCmdBtn.addEventListener('click', () => { hideTabsMenu(); openCommandPalette(); });
  if (closeCmdBtn) closeCmdBtn.addEventListener('click', closeCommandPalette);
  if (cmdInput) cmdInput.addEventListener('input', () => renderCommandPaletteItems(cmdInput.value));

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'k') {
      e.preventDefault();
      if (cmdModal && !cmdModal.classList.contains('hidden')) {
        closeCommandPalette();
      } else {
        openCommandPalette();
      }
    } else if (e.key === 'Escape') {
      closeCommandPalette();
      if (readerModal) readerModal.classList.add('hidden');
    }
  });
})();

// Carrega módulo Papaléguas WebAssembly (.ppl.wasm) nativo no navegador
(function initPapaleguasWasmClient() {
  if (typeof WebAssembly === 'undefined' || typeof fetch !== 'function') return;
  const wasmUrl = '/api/ppl-wasm?module=client_guard';
  const loadPromise = typeof WebAssembly.instantiateStreaming === 'function'
    ? WebAssembly.instantiateStreaming(fetch(wasmUrl)).catch(() =>
        fetch(wasmUrl).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? WebAssembly.instantiate(b) : null))
      )
    : fetch(wasmUrl).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? WebAssembly.instantiate(b) : null));
  Promise.resolve(loadPromise).then((res) => {
    if (res && res.instance && res.instance.exports) {
      window.__pplWasmGuard = res.instance.exports;
      window.sanitizePplZoom = (pct) => {
        try {
          return Number(window.__pplWasmGuard.sanitize_zoom_pct(BigInt(Math.round(Number(pct) || 100))));
        } catch (e) {
          return Math.max(50, Math.min(250, Math.round(Number(pct) || 100)));
        }
      };
    }
  }).catch(() => {});
})();

// Zero rastros ao fechar o navegador / aplicativo: apaga buscas, histórico e caches de sessão
(function bindZeroTraceOnClose() {
  const WIPE_KEYS = [
    'papaleguas_active_theme',
    'papaleguas_yt_prefs_v1',
    'papaleguas_fast_feed_cache_v1',
    'papaleguas_recent_searches',
    'papaleguas_search_history',
    'papaleguas_bt_recent_ids',
    'papaleguas_bt_refresh_seq',
    'papaleguas_last_url',
    'papaleguas_tabs_backup'
  ];
  function purgeClientTraces(clearSession) {
    try {
      WIPE_KEYS.forEach((k) => {
        try { localStorage.removeItem(k); } catch (e) {}
      });
      if (clearSession) {
        try { sessionStorage.clear(); } catch (e) {}
        try { if (typeof urlInput !== 'undefined' && urlInput) urlInput.value = ''; } catch (e) {}
      }
      try { document.cookie = 'papaleguas_device_id=; path=/; max-age=0; SameSite=Lax'; } catch (e) {}
      try { if (window.indexedDB) window.indexedDB.deleteDatabase('papaleguas_yt_prefs_db'); } catch (e) {}
    } catch (e) {}
  }
  purgeClientTraces(false);
  window.addEventListener('beforeunload', () => purgeClientTraces(true));
  window.addEventListener('pagehide', () => purgeClientTraces(true));
})();
