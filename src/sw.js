// Service Worker para Papaléguas PWA com tela de reconexão inteligente e auto-update
const CACHE_NAME = 'papaleguas-pwa-v46';
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
  '/index.html',
  '/newtab.html',
  '/musica.html',
  '/musica.js',
  '/styles.css',
  '/renderer.js',
  '/hybrid-bridge.js',
  '/fab-drag.js?v=1',
  '/client-cast.js?v=9',
  '/cast-hub.js?v=8',
  '/auto-update.js',
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
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Função auxiliar para injetar cabeçalho que pula tela 'Visit Site' do ngrok
function withAntiWarningHeaders(request) {
  try {
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

  // Chamadas para API não passam pelo cache do Service Worker, mas recebem injeção do cabeçalho
  if (url.includes('/api/')) {
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

