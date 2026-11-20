'use strict';

let videoStreamPpl = null;
try {
  const pplRuntime = require('../../papaleguas-lang/runtime');
  videoStreamPpl = pplRuntime.loadNativeModule('video_stream');
} catch (e) {
  videoStreamPpl = null;
}

function buildIpCamLiveHtml({ camUrl, camTitle, clientId, escapeHtml }) {
  const baseFrameIntervalMs = (videoStreamPpl && typeof videoStreamPpl.optimal_frame_interval_ms === 'function')
    ? Number(videoStreamPpl.optimal_frame_interval_ms(220, 0)) || 220
    : 220;
  let camOrigin = camUrl;
  try { camOrigin = new URL(camUrl).origin + '/'; } catch (e) {}
  const safeCamUrl = escapeHtml(camUrl);
  const safeCamTitle = escapeHtml(camTitle);
  const safeCamOrigin = escapeHtml(camOrigin);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🔴 ${safeCamTitle} • Streaming Ao Vivo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #050811;
      color: #f8fafc;
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .cam-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 18px;
      background: rgba(10, 15, 28, 0.95);
      border-bottom: 1px solid rgba(56, 189, 248, 0.22);
      flex-wrap: wrap;
    }
    .cam-title-group {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .live-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 11px;
      border-radius: 999px;
      background: rgba(220, 38, 38, 0.25);
      border: 1px solid rgba(239, 68, 68, 0.7);
      color: #fca5a5;
      font-size: 11.5px;
      font-weight: 800;
      letter-spacing: 0.4px;
      white-space: nowrap;
    }
    .live-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ef4444;
      box-shadow: 0 0 10px #ef4444;
      animation: pulse 1.1s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    .cam-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .cam-btn {
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.06);
      color: #e2e8f0;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .cam-btn:hover {
      background: rgba(56, 189, 248, 0.18);
      border-color: rgba(56, 189, 248, 0.5);
    }
    .cam-stage {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 16px;
      position: relative;
    }
    .cam-frame-wrap {
      position: relative;
      background: #000;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(16, 185, 129, 0.4);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8);
      max-width: 96vw;
      max-height: 78vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #camLiveImg {
      display: block;
      max-width: 96vw;
      max-height: 78vh;
      width: auto;
      height: auto;
      object-fit: contain;
    }
    .cam-hud {
      margin-top: 10px;
      font-family: monospace;
      font-size: 12px;
      color: #94a3b8;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      justify-content: center;
    }
  </style>
</head>
<body>
  <header class="cam-topbar">
    <div class="cam-title-group">
      <button type="button" class="cam-btn" onclick="if (window.parent && window.parent !== window) { window.parent.postMessage({ type: 'papaleguas-go-back' }, '*'); } else if (history.length > 1) { history.back(); } else { window.location.href='/search?q=brasil&filter=ipcam'; }">← Voltar</button>
      <span class="live-badge"><span class="live-dot" id="liveDot"></span> <span id="liveStatusText">STREAMING AO VIVO</span></span>
      <strong style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeCamTitle}</strong>
    </div>
    <div class="cam-controls">
      <button type="button" class="cam-btn" id="btnPauseCam">⏸ Pausar</button>
      <button type="button" class="cam-btn" id="btnSnapCam">📸 Capturar Foto</button>
      <button type="button" class="cam-btn" id="btnFsCam">⛶ Tela Cheia</button>
      <a class="cam-btn" href="/proxy?url=${encodeURIComponent(camOrigin)}&clientId=${encodeURIComponent(clientId)}">🌐 Painel da Câmera (${safeCamOrigin})</a>
    </div>
  </header>
  <main class="cam-stage">
    <div class="cam-frame-wrap" id="camStageWrap">
      <img id="camLiveImg" alt="Streaming Ao Vivo" />
    </div>
    <div class="cam-hud">
      <span id="camFpsInfo">Conectando ao stream em tempo real...</span>
      <span>Endpoint: ${safeCamUrl}</span>
    </div>
  </main>
  <script src="/ppl-net-crypto.js?v=1"></script>
  <script>
    (function() {
      try {
        if (window.torBrowserAPI && typeof window.torBrowserAPI.sendToHost === 'function') {
          window.torBrowserAPI.sendToHost('navigate-sync', { url: window.location.href, title: document.title });
        }
        var app = (window.top && window.top !== window) ? window.top : ((window.parent && window.parent !== window) ? window.parent : null);
        if (app) app.postMessage({ type: 'navigate-sync', url: window.location.href, title: document.title }, '*');
      } catch (e) {}

      var rawUrl = ${JSON.stringify(camUrl)};
      var imgEl = document.getElementById('camLiveImg');
      var fpsEl = document.getElementById('camFpsInfo');
      var statusEl = document.getElementById('liveStatusText');
      var dotEl = document.getElementById('liveDot');
      var pauseBtn = document.getElementById('btnPauseCam');
      var snapBtn = document.getElementById('btnSnapCam');
      var fsBtn = document.getElementById('btnFsCam');
      var wrapEl = document.getElementById('camStageWrap');

      var paused = false;
      var frames = 0;
      var isMjpeg = /mjpg|video\\.cgi|nphMotionJpeg/i.test(rawUrl);

      function buildFrameSrc() {
        var raw = '/api/ipcam-frame?u=' + encodeURIComponent(rawUrl) + '&_t=' + Date.now() + '_' + frames;
        return (typeof window.__pplEncryptUrl === 'function') ? window.__pplEncryptUrl(raw) : raw;
      }

      if (isMjpeg) {
        imgEl.src = buildFrameSrc();
        fpsEl.textContent = '🟢 Stream MJPEG Contínuo Ativo';
      } else {
        var preloader = new Image();
        var tStart = Date.now();
        var errStreak = 0;
        var baseInterval = ${JSON.stringify(baseFrameIntervalMs)};

        function requestNextFrame() {
          if (paused) return;
          tStart = Date.now();
          preloader.src = buildFrameSrc();
        }

        preloader.onload = function() {
          frames += 1;
          errStreak = 0;
          var latency = Date.now() - tStart;
          imgEl.src = preloader.src;
          fpsEl.textContent = '🟢 Quadros ao vivo: ' + frames + ' • Atualização: ' + latency + 'ms';
          var nextDelay = Math.max(60, Math.min(1200, Math.round(Math.max(baseInterval, latency) * 0.45)));
          if (!paused) {
            setTimeout(requestNextFrame, nextDelay);
          }
        };

        preloader.onerror = function() {
          errStreak += 1;
          fpsEl.textContent = '⏳ Reconectando frame da câmera...';
          var retryDelay = (typeof window.__pplAdaptiveBackoffMs === 'function')
            ? window.__pplAdaptiveBackoffMs(errStreak, 600, true)
            : Math.min(2500, 800 + errStreak * 400);
          if (!paused) {
            setTimeout(requestNextFrame, retryDelay);
          }
        };

        requestNextFrame();
      }

      pauseBtn.addEventListener('click', function() {
        paused = !paused;
        pauseBtn.textContent = paused ? '▶ Retomar Ao Vivo' : '⏸ Pausar';
        statusEl.textContent = paused ? 'PAUSADO' : 'STREAMING AO VIVO';
        dotEl.style.background = paused ? '#f59e0b' : '#ef4444';
        if (!paused && !isMjpeg) {
          var p = new Image();
          p.onload = function() { imgEl.src = p.src; };
          p.src = buildFrameSrc();
          location.reload();
        }
      });

      snapBtn.addEventListener('click', function() {
        try {
          var c = document.createElement('canvas');
          c.width = imgEl.naturalWidth || 640;
          c.height = imgEl.naturalHeight || 480;
          c.getContext('2d').drawImage(imgEl, 0, 0);
          var a = document.createElement('a');
          a.download = 'camera-ip-' + Date.now() + '.jpg';
          a.href = c.toDataURL('image/jpeg', 0.92);
          a.click();
        } catch (e) {}
      });

      fsBtn.addEventListener('click', function() {
        if (!document.fullscreenElement && wrapEl.requestFullscreen) {
          wrapEl.requestFullscreen().catch(function() {});
        } else if (document.exitFullscreen) {
          document.exitFullscreen().catch(function() {});
        }
      });
    })();
  </script>
</body>
</html>`;
}

module.exports = { buildIpCamLiveHtml };
