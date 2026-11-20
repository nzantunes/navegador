// Service Worker para Papaléguas PWA + PPL Client Offload (cache em disco de .ppl.wasm, assets e thumbs)
const CACHE_NAME = 'papaleguas-pwa-2026.11.19-v156';
const WASM_CACHE_NAME = 'papaleguas-ppl-wasm-v1';
const THUMB_CACHE_NAME = 'papaleguas-media-thumbs-v1';
const MAX_THUMB_ENTRIES = 180;
const OFFLINE_URL = '/offline.html';

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Papaléguas - Reconectar</title>
  <style>
    * { box-sizing: border-box; }
    body {
      background: #0b0d14;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      text-align: center;
    }
    .card {
      background: #111422;
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 18px;
      padding: 26px 20px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.7);
    }
    .mascot {
      width: 68px;
      height: 68px;
      border-radius: 14px;
      margin-bottom: 14px;
      border: 2px solid rgba(56, 189, 248, 0.5);
      box-shadow: 0 4px 16px rgba(2, 132, 199, 0.4);
    }
    h2 { margin: 0 0 8px 0; font-size: 19px; color: #38bdf8; font-weight: 700; }
    p { font-size: 13px; color: #94a3b8; line-height: 1.5; margin: 0 0 18px 0; }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 12px;
      margin-bottom: 10px;
      border-radius: 10px;
      border: none;
      font-size: 13.5px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s;
    }
    .btn-primary {
      background: linear-gradient(135deg, #0284c7, #2563eb);
      color: #fff;
      box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4);
    }
    .btn-primary:active { transform: scale(0.98); }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #e2e8f0;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .input-wrap {
      margin-top: 18px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding-top: 16px;
      text-align: left;
    }
    label { font-size: 11.5px; color: #cbd5e1; font-weight: 600; display: block; margin-bottom: 6px; }
    input {
      width: 100%;
      padding: 11px;
      border-radius: 8px;
      border: 1px solid rgba(56, 189, 248, 0.3);
      background: #1a1e2e;
      color: #fff;
      font-size: 13px;
      margin-bottom: 10px;
    }
    input:focus { outline: none; border-color: #38bdf8; }
  </style>
</head>
<body>
  <div class="card">
    <img src="icon-192.png" alt="Papaléguas" class="mascot" onerror="this.onerror=null;this.src='papaleguas_icon.png';">
    <h2>Servidor Desconectado</h2>
    <p>O endereço do túnel Cloudflare mudou ou seu computador está offline.</p>
    <button class="btn btn-primary" onclick="location.reload()">🔄 Tentar Reconectar</button>
    
    <div class="input-wrap">
      <label for="newUrl">Ou cole o novo link gerado no computador:</label>
      <input type="url" id="newUrl" placeholder="https://...trycloudflare.com">
      <button class="btn btn-secondary" onclick="openNewUrl()">Acessar Novo Endereço</button>
    </div>
  </div>
  <script>
    function openNewUrl() {
      var val = (document.getElementById('newUrl').value || '').trim();
      if (val) {
        if (!/^https?:\\/\\//i.test(val)) val = 'https://' + val;
        window.location.href = val;
      }
    }
  </script>
</body>
</html>`;

const SHELL_ASSETS = [
  '/',
  '/baixatube',
  '/index.html',
  '/newtab.html',
  '/musica.html',
  '/musica.js',
  '/styles.css',
  '/renderer.js',
  '/hybrid-bridge.js',
  '/ppl-net-crypto.js?v=2',
  '/ppl-worker.js?v=1',
  '/ppl-client-offload.js?v=1',
  '/fab-drag.js?v=109',
  '/client-cast.js?v=14',
  '/cast-hub.js?v=10',
  '/auto-update.js',
  '/i18n-ip.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.png',
  '/papaleguas_icon.png',
  '/papaleguas_logo.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const resp = new Response(OFFLINE_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
      await cache.put(OFFLINE_URL, resp);
      try {
        await cache.addAll(SHELL_ASSETS);
      } catch (err) {}
    }).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  const keepCaches = new Set([CACHE_NAME, WASM_CACHE_NAME, THUMB_CACHE_NAME]);
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (!keepCaches.has(key)) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

async function trimCacheEntries(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxEntries) {
      const excess = keys.length - maxEntries;
      for (let i = 0; i < excess; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch (e) {}
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Função auxiliar para injetar cabeçalho que pula tela 'Visit Site' do ngrok
function withAntiWarningHeaders(request) {
  try {
    // Domínios de terceiros: não altera (cabeçalho customizado quebraria CORS / no-cors)
    if (new URL(request.url).origin !== self.location.origin) return request;
    const headers = new Headers(request.headers);
    headers.set('ngrok-skip-browser-warning', '1');
    return new Request(request, { headers });
  } catch (e) {
    return request;
  }
}

self.addEventListener('fetch', (event) => {
  const url = event.request.url || '';

  // Áudio, vídeo e fluxos de mídia: NUNCA interceptar com respondWith!
  // Deixa o navegador fazer streaming direto pela conexão de rede nativa em segundo plano.
  // Se o Service Worker intercepta Range/audio, o Android suspende a thread do worker ao minimizar,
  // causando cortes de áudio e engasgos.
  if (event.request.destination === 'audio' ||
      event.request.destination === 'video' ||
      url.includes('/api/stream-') ||
      url.includes('/api/audio-') ||
      url.includes('/api/downloaded-track-file')) {
    return;
  }

  // Módulos PPL WebAssembly (.ppl.wasm): Cache-First + atualização em segundo plano (0 ms no disco do cliente)
  if (url.includes('/api/ppl-wasm')) {
    event.respondWith(
      caches.open(WASM_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        const netPromise = fetch(withAntiWarningHeaders(event.request)).then((resp) => {
          if (resp && resp.status === 200) cache.put(event.request, resp.clone()).catch(() => {});
          return resp;
        }).catch(() => cached);
        return cached || netPromise;
      })
    );
    return;
  }

  // Miniaturas e capas (/api/preview-img, /api/cover): Cache-First no disco do cliente (alivia banda do servidor)
  if (event.request.method === 'GET' && (url.includes('/api/preview-img') || url.includes('/api/cover'))) {
    event.respondWith(
      caches.open(THUMB_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const resp = await fetch(withAntiWarningHeaders(event.request));
        if (resp && resp.status === 200) {
          cache.put(event.request, resp.clone()).then(() => trimCacheEntries(THUMB_CACHE_NAME, MAX_THUMB_ENTRIES)).catch(() => {});
        }
        return resp;
      })
    );
    return;
  }

  // Chamadas para API e navegação via Proxy não passam pelo cache do Service Worker
  // Evita que requisições proxy no iframe caiam no fallback offline (/index.html) e quebrem com tela branca
  if (url.includes('/api/') || url.includes('/proxy')) {
    event.respondWith(fetch(withAntiWarningHeaders(event.request)));
    return;
  }

  // Navegação de página (quando abre o app)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(withAntiWarningHeaders(event.request))
        .then((networkResp) => {
          if (networkResp && networkResp.status === 200) {
            const copy = networkResp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return networkResp;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(event.request) ||
                         await cache.match('/index.html') ||
                         await cache.match('/');
          return cached || await cache.match(OFFLINE_URL) || new Response(OFFLINE_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        })
    );
    return;
  }

  // Recursos estáticos locais: Stale-While-Revalidate (carrega rápido e atualiza em segundo plano)
  if (event.request.destination === 'style' ||
      event.request.destination === 'script' ||
      event.request.destination === 'image') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        const fetchPromise = fetch(withAntiWarningHeaders(event.request)).then((networkResp) => {
          if (networkResp && networkResp.status === 200) {
            cache.put(event.request, networkResp.clone()).catch(() => {});
          }
          return networkResp;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }
});

