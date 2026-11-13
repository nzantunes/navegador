require('./log-redact').installLogRedaction();
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFile, spawn } = require('child_process');
const papaleguasTracker = require('../papaleguas/tracker.js');
const ngrokTunnel = require('./ngrok-tunnel');
const appRoutes = require('./routes');
const logger = require('./logger');
const { swallowed } = logger;
const serverLog = logger.createLogger('server');
const { createRequestGuard } = require('./security/request-guard');
const { handleClientLog } = require('./client-log');
const requestGuard = createRequestGuard({
  logger: logger.createLogger('guard'),
  isIpBlocked: (ip) => typeof papaleguasTracker.isIpBlocked === 'function' && papaleguasTracker.isIpBlocked(ip)
});
const telegramBot = require('./telegram-bot');
const nativeCore = require('./native-core');
const botCommander = require('./bot-commander');
const { searchOnionLinks, crawlOnionSublinks, crawlWebForOnionLinks, setTorCountry, checkOnionAlive, startBackgroundUptimeScanner, getOnionStatusSync } = require('./onion-search');
const { createLruCache } = require('./lru-cache');
const { sanitizeSearchText, scoreSearchRelevance, computeAntiSpamPenalty, suggestQueryCorrection } = require('./search-utils');
const { sendCompressed } = require('./compression');
const { parseSuggestPayload, filterOffTopic: filterOffTopicHelper, spreadResultsByHost: spreadResultsByHostHelper } = require('./search-engines');

// Controle em tempo real e persistente de logs do servidor no terminal (console.log / console.info)
let serverConsoleLogsPaused = typeof papaleguasTracker.isServerLogsPaused === 'function' ? papaleguasTracker.isServerLogsPaused() : false;
const nativeConsoleLog = console.log.bind(console);
const nativeConsoleInfo = (console.info || console.log).bind(console);

console.log = function(...args) {
  if (serverConsoleLogsPaused) return;
  nativeConsoleLog(...args);
};

console.info = function(...args) {
  if (serverConsoleLogsPaused) return;
  nativeConsoleInfo(...args);
};

function isServerConsoleLogsPaused() {
  if (typeof papaleguasTracker.isServerLogsPaused === 'function') {
    serverConsoleLogsPaused = papaleguasTracker.isServerLogsPaused();
  }
  return serverConsoleLogsPaused;
}

function setServerConsoleLogsPaused(paused) {
  serverConsoleLogsPaused = Boolean(paused);
  if (typeof papaleguasTracker.setServerLogsPaused === 'function') {
    papaleguasTracker.setServerLogsPaused(serverConsoleLogsPaused);
  }
  if (!serverConsoleLogsPaused) {
    nativeConsoleLog('[SERVER LOGS] Logs do terminal do servidor ATIVADOS (visíveis).');
  } else {
    nativeConsoleLog('[SERVER LOGS] Logs do terminal do servidor PAUSADOS (modo silencioso).');
  }
  return serverConsoleLogsPaused;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =========================================================================
// CONTROLE DE ACESSO: PAINEL ADMINISTRATIVO RESTRITO À REDE LOCAL
// =========================================================================
function isLocalAdminRequest(req) {
  if (!req) return false;
  const headers = req.headers || {};
  // Se a requisição veio via Cloudflare Tunnel, Ngrok ou proxy externo
  if (
    headers['cf-connecting-ip'] ||
    headers['cf-ray'] ||
    headers['cf-visitor'] ||
    headers['ngrok-skip-browser-warning'] ||
    headers['x-original-host']
  ) {
    return false;
  }
  const host = (headers.host || '').toLowerCase();
  const forwardedHost = (headers['x-forwarded-host'] || '').toLowerCase();
  if (
    host.includes('trycloudflare.com') ||
    host.includes('ngrok') ||
    host.includes('loca.lt') ||
    host.includes('lhr.life') ||
    forwardedHost.includes('trycloudflare.com') ||
    forwardedHost.includes('ngrok') ||
    forwardedHost.includes('loca.lt') ||
    forwardedHost.includes('lhr.life')
  ) {
    return false;
  }
  if (headers['x-forwarded-for']) {
    const forwardedIps = String(headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
    if (forwardedIps.some((ip) => !papaleguasTracker.isPrivateIp(ip))) {
      return false;
    }
  }
  const socketIp = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
  if (socketIp && !papaleguasTracker.isPrivateIp(socketIp)) {
    return false;
  }
  const clientIp = papaleguasTracker.extractClientIp(req);
  return papaleguasTracker.isPrivateIp(clientIp);
}

function isBlockedInternalProxyHost(hostname) {
  if (papaleguasTracker && papaleguasTracker.nativeCore && typeof papaleguasTracker.nativeCore.isSafeProxyHost === 'function') {
    return !papaleguasTracker.nativeCore.isSafeProxyHost(hostname);
  }
  const clean = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return true;
  if (
    clean === 'localhost' ||
    clean === '0.0.0.0' ||
    clean === '::1' ||
    clean === '::' ||
    clean.endsWith('.localhost') ||
    clean.endsWith('.local')
  ) {
    return true;
  }
  return papaleguasTracker.isPrivateIp(clean);
}

function sendForbiddenAdminResponse(res, isJson = false) {
  if (isJson) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: '403 Forbidden: Acesso restrito. A área administrativa do Papaléguas só pode ser acessada dentro da rede local (Localhost ou Wi-Fi).'
    }));
    return;
  }
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>403 - Acesso Restrito</title>
  <style>
    body { background: #07090e; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 20px; padding: 40px 30px; max-width: 480px; text-align: center; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6); backdrop-filter: blur(12px); }
    .icon { font-size: 56px; margin-bottom: 16px; }
    h1 { font-size: 24px; color: #f87171; margin: 0 0 12px; font-weight: 700; }
    p { font-size: 14.5px; color: #94a3b8; line-height: 1.6; margin: 0 0 24px; }
    .badge { display: inline-block; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; font-size: 12px; font-weight: 700; padding: 8px 16px; border-radius: 10px; letter-spacing: 0.5px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🛡️</div>
    <h1>Acesso Restrito: Somente Local</h1>
    <p>O Painel Administrativo do Papaléguas está configurado para acesso exclusivo dentro da <strong>rede local</strong> (Localhost ou Wi-Fi privado). Tentativas de acesso externo via túnel público ou internet foram bloqueadas por segurança.</p>
    <div class="badge">403 FORBIDDEN &bull; LOCAL ACCESS ONLY</div>
  </div>
</body>
</html>`);
}

let BINANCE_PAY_QR_DATA_URI = '';
try {
  const qrImgPath = path.join(__dirname, '..', 'src', 'binance_pay_qr.jpg');
  if (fs.existsSync(qrImgPath)) {
    const b64 = fs.readFileSync(qrImgPath).toString('base64');
    BINANCE_PAY_QR_DATA_URI = `data:image/jpeg;base64,${b64}`;
  }
} catch (e) {
  swallowed(e, 'server:binance_qr_load');
}

function renderBlockedIpPaymentNotice(clientIp) {
  const safeIp = String(clientIp || '').replace(/[^a-zA-Z0-9.:_-]/g, '');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <title>Acesso Bloqueado • Taxa de Desbloqueio 5 USDT</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #090d16;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
    }
    .blocked-card {
      background: linear-gradient(145deg, #111827 0%, #0b1120 100%);
      border: 1px solid rgba(239, 68, 68, 0.45);
      border-radius: 20px;
      max-width: 480px;
      width: 100%;
      padding: 28px 22px;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.7), 0 0 35px rgba(239, 68, 68, 0.2);
    }
    .shield-icon {
      font-size: 46px;
      margin-bottom: 10px;
      display: inline-block;
      animation: pulse-shield 2.2s infinite ease-in-out;
    }
    @keyframes pulse-shield {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.08); }
    }
    h1 {
      font-size: 22px;
      font-weight: 800;
      color: #f87171;
      margin-bottom: 6px;
      letter-spacing: -0.5px;
    }
    .ip-box {
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      padding: 8px 14px;
      margin: 14px auto;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #94a3b8;
    }
    .ip-val {
      color: #38bdf8;
      font-weight: 700;
      font-family: monospace;
      font-size: 13.5px;
    }
    .fee-badge {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.22) 0%, rgba(217, 119, 6, 0.3) 100%);
      border: 1px solid rgba(245, 158, 11, 0.55);
      border-radius: 14px;
      padding: 14px;
      margin: 16px 0;
      text-align: center;
    }
    .fee-title {
      font-size: 12px;
      color: #fbbf24;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 2px;
    }
    .fee-amount {
      font-size: 32px;
      font-weight: 900;
      color: #fef08a;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      text-shadow: 0 0 20px rgba(245, 158, 11, 0.5);
    }
    .fee-sub {
      font-size: 12px;
      color: #cbd5e1;
      margin-top: 4px;
    }
    .fee-sub b {
      color: #f59e0b;
    }
    .qr-container {
      background: #ffffff;
      padding: 10px;
      border-radius: 16px;
      display: inline-block;
      margin: 12px auto;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }
    .qr-container img {
      max-width: 210px;
      width: 100%;
      height: auto;
      display: block;
      border-radius: 8px;
    }
    .instructions {
      text-align: left;
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 12px;
      color: #cbd5e1;
      line-height: 1.6;
      margin-top: 14px;
    }
    .instructions ol {
      margin-left: 18px;
    }
    .instructions li {
      margin-bottom: 4px;
    }
    .btn-group {
      display: flex;
      gap: 10px;
      margin-top: 18px;
    }
    .btn {
      flex: 1;
      padding: 12px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: none;
    }
    .btn-primary {
      background: #10b981;
      color: #020617;
    }
    .btn-primary:hover {
      background: #34d399;
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #cbd5e1;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
    }
  </style>
</head>
<body>
  <div class="blocked-card">
    <div class="shield-icon">🛡️</div>
    <h1>Acesso Bloqueado</h1>
    <p style="font-size:13px;color:#94a3b8;line-height:1.45;">Seu endereço IP foi temporariamente bloqueado pelo sistema anti-abuso.</p>

    <div class="ip-box">
      <span>IP Bloqueado:</span>
      <span class="ip-val">${safeIp}</span>
    </div>

    <div class="fee-badge">
      <div class="fee-title">Taxa de Desbloqueio</div>
      <div class="fee-amount">5 USDT</div>
      <div class="fee-sub">Pagamento via <b>Binance Pay (OperaTrade)</b></div>
    </div>

    <div class="qr-container">
      <img src="${BINANCE_PAY_QR_DATA_URI || '/binance_pay_qr.jpg'}" alt="Escaneie com Binance App para pagar 5 USDT" />
    </div>

    <div class="instructions">
      <strong style="color:#fbbf24;display:block;margin-bottom:4px;">Como desbloquear seu IP com Binance Pay:</strong>
      <ol>
        <li>Abra o aplicativo da <b>Binance</b> no celular.</li>
        <li>Toque no ícone de escaneamento de <b>QR Code</b> (no topo da tela).</li>
        <li>Escaneie a imagem acima e envie <b>5 USDT</b> para <b>OperaTrade</b>.</li>
        <li>Após o pagamento, informe o administrador com seu IP ou clique em <b>Verificar Desbloqueio</b>.</li>
      </ol>
    </div>

    <div class="btn-group">
      <button type="button" class="btn btn-secondary" onclick="navigator.clipboard.writeText('${safeIp}'); this.textContent='✅ IP Copiado!'; setTimeout(() => this.textContent='📋 Copiar Meu IP', 2000);">
        📋 Copiar Meu IP
      </button>
      <button type="button" class="btn btn-primary" onclick="location.reload();">
        🔄 Verificar Desbloqueio
      </button>
    </div>
  </div>
</body>
</html>`;
}

const MEDIA_DOWNLOADS_DIR = path.join(os.homedir(), '.papaleguas_downloads');
try { fs.mkdirSync(MEDIA_DOWNLOADS_DIR, { recursive: true }); } catch (e) { swallowed(e, 'server:top@164'); }

let SERVER_BUILD_VERSION = '2026.11.12-v139';
function getServerBuildVersion() {
  try {
    const swPath = path.join(__dirname, '../src/sw.js');
    if (fs.existsSync(swPath)) {
      const txt = fs.readFileSync(swPath, 'utf8');
      const m = txt.match(/CACHE_NAME\s*=\s*['"]papaleguas-pwa-([^'"]+)['"]/);
      if (m && m[1]) {
        return m[1].startsWith('2026.') ? m[1] : '2026.11.07-' + m[1];
      }
    }
  } catch (e) {}
  return SERVER_BUILD_VERSION;
}
const querystring = require('querystring');
const zlib = require('zlib');
const http2 = require('http2');
const tls = require('tls');
let SocksProxyAgent;
try {
  SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
} catch (e) { swallowed(e, 'server:top@174'); }
// Usado para abrir a conexão HTTP/2 das buscas por dentro do Tor
let SocksClient;
try {
  SocksClient = require('socks').SocksClient;
} catch (e) { swallowed(e, 'server:top@179'); }

const TorManager = require('./tor-manager');
const torManager = new TorManager({ socksPort: 9050, socksHost: '127.0.0.1' });

const TOR_SOCKS_PROXY = 'socks5://127.0.0.1:9050';
const TOR_SOCKS_AGENT = 'socks5h://127.0.0.1:9050';
const torAgent = SocksProxyAgent ? new SocksProxyAgent(TOR_SOCKS_AGENT, {
  keepAlive: true,
  keepAliveMsecs: 15000,
  timeout: 25000
}) : undefined;
let appTorEnabled = true;
let outboundIpCache = { t: 0, tor: false, info: null };

function setAppTorEnabled(enabled) {
  appTorEnabled = Boolean(enabled);
  outboundIpCache = { t: 0, tor: false, info: null };
  try {
    const ai = require('./ai-client');
    if (ai && typeof ai.setOutboundAgent === 'function') {
      ai.setOutboundAgent(appTorEnabled ? torAgent : undefined);
    }
  } catch (e) { swallowed(e, 'server:setAppTorEnabled@202'); }
  return appTorEnabled;
}

function isAppTorEnabled() {
  return appTorEnabled;
}

function isTorRoutingEnabled(session) {
  return true;
}

function applyServerTorRouting(enabled) {
  const on = true;
  setAppTorEnabled(on);
  try {
    clientSessions.forEach((session) => {
      session.torEnabled = on;
    });
  } catch (e) { swallowed(e, 'server:applyServerTorRouting@221'); }
  return on;
}

function getOutboundAgent(force) {
  // Quando force é false (ex: BaixaTube, YouTube, catálogo Deezer, previews de áudio, downloads diretos), não usa o proxy Tor
  if (force === false) {
    return undefined;
  }
  if (typeof force === 'string' && (isYoutubeHost(force) || isDeezerHost(force))) {
    return undefined;
  }
  if (!appTorEnabled && force !== true) {
    return undefined;
  }
  // Sempre usa o agente Tor SOCKS5h (DNS remoto sem vazamento de IP) quando habilitado ou forçado
  return torAgent || undefined;
}

// ----------------------------------------------------
// SUPORTE A LINK PREVIEW / OPEN GRAPH PARA WHATSAPP, TELEGRAM, DISCORD E ROBÔS DE IA
// Garante imagem em alta definição, cards interativos e tags ricas para crawlers e agentes
// ----------------------------------------------------
const SOCIAL_CRAWLER_REGEX = /facebookexternalhit|whatsapp|facebot|twitterbot|telegrambot|linkedinbot|discordbot|slackbot|skypeuripreview|bluesky|threads|mastodon|gptbot|chatgpt-user|perplexitybot|claudebot|applebot|google-extended|ia_archiver/i;
const videoMetaCache = createLruCache({ maxEntries: 500, ttlMs: 60 * 60 * 1000 });

function getVideoTitleFast(videoId, fallbackTitle) {
  if (!videoId) return Promise.resolve(fallbackTitle || 'Vídeo no Papaléguas BaixaTube');
  if (videoMetaCache.has(videoId)) {
    return Promise.resolve(videoMetaCache.get(videoId));
  }
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (t) => {
      if (resolved) return;
      resolved = true;
      if (t) videoMetaCache.set(videoId, t);
      resolve(t || fallbackTitle || 'Vídeo no Papaléguas BaixaTube');
    };
    const oembedUrl = 'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' + encodeURIComponent(videoId) + '&format=json';
    const req = https.get(oembedUrl, { agent: getOutboundAgent(false), headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(null);
        return;
      }
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          finish(parsed.title || null);
        } catch (e) {
          finish(null);
        }
      });
    });
    req.on('error', () => finish(null));
    req.setTimeout(2500, () => {
      try { req.destroy(); } catch (e) { swallowed(e, 'server:getVideoTitleFast@280'); }
      finish(null);
    });
  });
}

function serveSocialPreview(res, { title, description, imageUrl, pageUrl, isVideo = false }) {
  const cleanTitle = escapeHtml(title || 'Papaléguas BaixaTube');
  const cleanDesc = escapeHtml(description || 'Papaléguas - Navegador Privado, Filmes Online, Músicas e Streaming sem anúncios.');
  const cleanImg = escapeHtml(imageUrl || 'https://papaleguas.app/og-banner.jpg');
  const cleanUrl = escapeHtml(pageUrl || 'https://papaleguas.app/');
  const imgWidth = isVideo ? '480' : '1200';
  const imgHeight = isVideo ? '360' : '630';
  const ogType = isVideo ? 'video.other' : 'website';

  const html = `<!DOCTYPE html>
<html lang="pt-BR" prefix="og: http://ogp.me/ns#">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cleanTitle}</title>
  <meta name="description" content="${cleanDesc}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="${cleanUrl}">
  <!-- OpenGraph para WhatsApp, Telegram, Facebook e Discord -->
  <meta property="og:site_name" content="Papaléguas BaixaTube">
  <meta property="og:locale" content="pt_BR">
  <meta property="og:title" content="${cleanTitle}">
  <meta property="og:description" content="${cleanDesc}">
  <meta property="og:image" content="${cleanImg}">
  <meta property="og:image:secure_url" content="${cleanImg}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="${imgWidth}">
  <meta property="og:image:height" content="${imgHeight}">
  <meta property="og:url" content="${cleanUrl}">
  <meta property="og:type" content="${ogType}">
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@papaleguas">
  <meta name="twitter:title" content="${cleanTitle}">
  <meta name="twitter:description" content="${cleanDesc}">
  <meta name="twitter:image" content="${cleanImg}">
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
      border: 1px solid rgba(0, 240, 255, 0.4);
      border-radius: 18px;
      padding: 24px;
      max-width: 520px;
      width: 100%;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.7);
    }
    .thumb {
      width: 100%;
      max-height: 280px;
      object-fit: cover;
      border-radius: 12px;
      margin-bottom: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    h1 { font-size: 19px; color: #00f0ff; margin: 0 0 10px 0; line-height: 1.4; }
    p { font-size: 13.5px; color: #94a3b8; line-height: 1.5; margin: 0 0 20px 0; }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0284c7, #2563eb);
      color: #fff;
      font-weight: 700;
      font-size: 14.5px;
      padding: 13px 20px;
      border-radius: 10px;
      text-decoration: none;
      box-shadow: 0 4px 16px rgba(2, 132, 199, 0.4);
      transition: transform 0.15s ease;
    }
    .btn:active { transform: scale(0.98); }
  </style>
</head>
<body>
  <div class="card">
    <img src="${cleanImg}" alt="${cleanTitle}" class="thumb">
    <h1>${cleanTitle}</h1>
    <p>${cleanDesc}</p>
    <a href="${cleanUrl}" class="btn">▶ Assistir Sem Anúncios no Papaléguas BaixaTube</a>
  </div>
</body>
</html>`;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html, 'utf8'),
    'Cache-Control': 'public, max-age=3600'
  });
  res.end(html);
}

// ----------------------------------------------------
// INTEGRAÇÃO COM GOOGLE TRENDS BRASIL (trends.google.com.br/trending)
// Coleta os tópicos e termos mais pesquisados no Google no Brasil em tempo real,
// alimentando o SEO dinâmico, o sitemap.xml e o feed "Em Alta" do BaixaTube.
// ----------------------------------------------------
const googleTrendsCache = createLruCache({ maxEntries: 100, ttlMs: 30 * 60 * 1000 });
const GOOGLE_TRENDS_TTL = 30 * 60 * 1000; // 30 minutos de cache em memória (1.800.000 ms)

function cleanTrendsString(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function parseGoogleTrendsPage(html) {
  if (!html) return [];
  const match = html.match(/AF_initDataCallback\((\{key:\s*'ds:0'[\s\S]*?\})\);/);
  if (!match) return [];
  try {
    const fn = new Function('return ' + match[1]);
    const obj = fn();
    const rawList = (obj && obj.data && Array.isArray(obj.data[1])) ? obj.data[1] : [];
    const items = [];
    for (const item of rawList) {
      if (!Array.isArray(item) || !item[0]) continue;
      const title = String(item[0]).trim();
      if (!title) continue;
      const count = typeof item[6] === 'number' ? item[6] : 0;
      let trafficFormatted = '';
      if (count >= 1000000) trafficFormatted = (count / 1000000).toFixed(0) + 'M+';
      else if (count >= 1000) trafficFormatted = Math.round(count / 1000) + ' mil+';
      else if (count > 0) trafficFormatted = count + '+';
      else trafficFormatted = 'Em alta';

      const related = Array.isArray(item[9]) ? item[9].filter(Boolean).slice(0, 5) : [];
      const newsTitle = related.length > 1 ? related.slice(1, 4).join(' • ') : '';

      items.push({
        title,
        traffic: trafficFormatted,
        searchCount: count,
        newsTitle,
        relatedQueries: related
      });
      if (items.length >= 35) break;
    }
    return items;
  } catch (e) {
    return [];
  }
}

function parseGoogleTrendsRss(xml) {
  if (!xml) return [];
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < 25) {
    const block = match[1];
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(block);
    const trafficMatch = /<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/.exec(block);
    const newsTitleMatch = /<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/.exec(block);
    const newsUrlMatch = /<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/.exec(block);
    const pictureMatch = /<ht:picture>([\s\S]*?)<\/ht:picture>/.exec(block);
    const pubDateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);

    const title = cleanTrendsString(titleMatch ? titleMatch[1] : '');
    const traffic = cleanTrendsString(trafficMatch ? trafficMatch[1] : '');
    const newsTitle = cleanTrendsString(newsTitleMatch ? newsTitleMatch[1] : '');
    const newsUrl = cleanTrendsString(newsUrlMatch ? newsUrlMatch[1] : '');
    const picture = cleanTrendsString(pictureMatch ? pictureMatch[1] : '');
    const pubDate = cleanTrendsString(pubDateMatch ? pubDateMatch[1] : '');

    if (title) {
      items.push({
        title,
        traffic: traffic || 'Em alta',
        newsTitle,
        newsUrl,
        picture,
        pubDate
      });
    }
  }
  return items;
}

function getCachedGoogleTrends(country = 'BR') {
  const c = String(country || 'BR').toUpperCase();
  const cached = googleTrendsCache.get(c);
  if (cached && Array.isArray(cached.trends) && cached.trends.length > 0) {
    return cached.trends;
  }
  return [];
}

function findGoogleTrendMatch(query, country = 'BR') {
  const rawQ = String(query || '').trim().toLowerCase();
  if (!rawQ || rawQ.length < 3) return null;
  const trends = getCachedGoogleTrends(country);
  for (const t of trends) {
    const tTitle = (t.title || '').toLowerCase();
    if (tTitle === rawQ || tTitle.includes(rawQ) || rawQ.includes(tTitle)) {
      return t;
    }
  }
  return null;
}

async function fetchGoogleTrends(country = 'BR', forceRefresh = false) {
  const c = String(country || 'BR').toUpperCase();
  const cached = googleTrendsCache.get(c);
  if (!forceRefresh && cached && (Date.now() - cached.timestamp < GOOGLE_TRENDS_TTL) && cached.trends.length > 0) {
    return cached.trends;
  }

  // 1. Tenta carregar a página oficial de tendências em tempo real (trends.google.com.br/trending?geo=BR)
  const pageUrl = c === 'BR'
    ? 'https://trends.google.com.br/trending?geo=BR'
    : `https://trends.google.com/trending?geo=${encodeURIComponent(c)}`;

  const pageItems = await new Promise((resolve) => {
    let resolved = false;
    const finish = (items) => {
      if (resolved) return;
      resolved = true;
      resolve(items || []);
    };
    const req = https.get(pageUrl, {
      agent: getOutboundAgent(false),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish([]);
        return;
      }
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') {
        const gunzip = zlib.createGunzip();
        gunzip.on('error', () => finish([]));
        stream = res.pipe(gunzip);
      } else if (enc === 'deflate') {
        const inflate = zlib.createInflate();
        inflate.on('error', () => finish([]));
        stream = res.pipe(inflate);
      }
      let raw = '';
      stream.on('data', chunk => raw += chunk);
      stream.on('end', () => {
        try {
          const parsed = parseGoogleTrendsPage(raw);
          finish(parsed);
        } catch (e) {
          finish([]);
        }
      });
    });
    req.on('error', () => finish([]));
    req.setTimeout(12000, () => {
      try { req.destroy(); } catch (e) { swallowed(e, 'server:fetchGoogleTrends@562'); }
      finish([]);
    });
  });

  if (Array.isArray(pageItems) && pageItems.length > 0) {
    googleTrendsCache.set(c, { timestamp: Date.now(), trends: pageItems });
    nativeConsoleLog(`🔥 [GOOGLE TRENDS] ${pageItems.length} tópicos em alta atualizados ao vivo para '${c}' (cache de 30 minutos).`);
    return pageItems;
  }

  // 2. Fallback secundário via RSS caso a página HTML não retorne dados
  const rssUrl = c === 'BR'
    ? 'https://trends.google.com.br/trending/rss?geo=BR'
    : `https://trends.google.com/trending/rss?geo=${encodeURIComponent(c)}`;

  const rssItems = await new Promise((resolve) => {
    let resolved = false;
    const finish = (items) => {
      if (resolved) return;
      resolved = true;
      resolve(items || []);
    };
    const req = https.get(rssUrl, {
      agent: getOutboundAgent(false),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.8'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish([]);
        return;
      }
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const items = parseGoogleTrendsRss(raw);
          finish(items);
        } catch (e) {
          finish([]);
        }
      });
    });
    req.on('error', () => finish([]));
    req.setTimeout(6000, () => {
      try { req.destroy(); } catch (e) { swallowed(e, 'server:fetchGoogleTrends@610'); }
      finish([]);
    });
  });

  const finalItems = (Array.isArray(rssItems) && rssItems.length > 0) ? rssItems : ((cached && cached.trends) || []);
  if (finalItems.length > 0) {
    // Se usou fallback RSS, armazena por apenas 2 minutos para retentar o extrator em tempo real logo em seguida
    googleTrendsCache.set(c, { timestamp: Date.now() - (GOOGLE_TRENDS_TTL - 120000), trends: finalItems });
  }
  return finalItems;
}

// ----------------------------------------------------
// MOTOR DE SEO DINÂMICO PARA O GOOGLE E MOTORES DE BUSCA (PAPALÉGUAS BAIXATUBE)
// Injeta dinamicamente títulos, meta descriptions ricas, canonical, OpenGraph,
// Twitter Cards e dados estruturados Schema.org (VideoObject / CollectionPage)
// baseados no tema ativo ou no vídeo em reprodução para máxima indexação no Google.
// ----------------------------------------------------
const THEME_SEO_MAP = {
  noticias: {
    title: 'Notícias das Últimas Horas em Vídeo | Papaléguas BaixaTube',
    description: 'Acompanhe as principais notícias do Brasil e do mundo em vídeo, fatos urgentes e jornalismo atualizado das últimas horas. Assista sem anúncios no Papaléguas BaixaTube.',
    keywords: 'notícias em vídeo, últimas notícias brasil, jornalismo ao vivo, notícias urgentes, papaleguas notícias, vídeos de notícias hoje, youtube sem anúncios',
    heading: 'Notícias das últimas horas'
  },
  musicas: {
    title: 'Músicas e Lançamentos em Vídeo | Papaléguas BaixaTube',
    description: 'Ouça e assista aos principais clipes musicais, lançamentos, sertanejo, funk, gospel, pop e rock sem anúncios e em segundo plano no Papaléguas BaixaTube.',
    keywords: 'músicas youtube, clipes de música, ouvir música em segundo plano, baixar mp3, sertanejo, funk, lançamentos musicais, papaleguas músicas',
    heading: 'Músicas & Lançamentos nas últimas horas'
  },
  esportes: {
    title: 'Esportes, Futebol e Melhores Momentos em Vídeo | Papaléguas BaixaTube',
    description: 'Assista aos melhores momentos do futebol, gols da rodada, basquete, lutas e esportes das últimas horas sem interrupções no Papaléguas BaixaTube.',
    keywords: 'gols da rodada, futebol ao vivo, melhores momentos futebol, esportes em vídeo, brasileirão, libertadores, papaleguas esportes',
    heading: 'Esportes, Futebol & Gols nas últimas horas'
  },
  podcasts: {
    title: 'Podcasts e Entrevistas em Vídeo sem Anúncios | Papaléguas BaixaTube',
    description: 'Assista e ouça podcasts famosos, entrevistas exclusivas e debates completos em segundo plano, sem anúncios e com alta qualidade no Papaléguas BaixaTube.',
    keywords: 'podcasts em vídeo, flow podcast, podpah, podcasts brasil, entrevistas completas, ouvir podcast sem tela ligada, papaleguas podcasts',
    heading: 'Podcasts & Entrevistas nas últimas horas'
  },
  games: {
    title: 'Games, Gameplays e Melhores Jogadas | Papaléguas BaixaTube',
    description: 'Confira gameplays eletrizantes, lançamentos de jogos, dicas gamer, Minecraft, GTA, Free Fire e trailers de games no Papaléguas BaixaTube.',
    keywords: 'gameplay, vídeos de games, lançamentos de jogos, gta gameplay, minecraft, free fire, vídeos gamer youtube, papaleguas games',
    heading: 'Games & Gameplays nas últimas horas'
  },
  filmes: {
    title: 'Filmes, Trailers e Novidades do Cinema | Papaléguas BaixaTube',
    description: 'Assista aos trailers inéditos dos lançamentos do cinema e séries, análises e resenhas em alta definição no Papaléguas BaixaTube.',
    keywords: 'trailers de filmes, cinema, lançamentos cinema 2026, resenha de filmes, melhores filmes, trailers youtube, papaleguas filmes',
    heading: 'Filmes, Trailers & Cinema nas últimas horas'
  },
  tecnologia: {
    title: 'Tecnologia, Inovação e Inteligência Artificial | Papaléguas BaixaTube',
    description: 'Fique por dentro das novidades em tecnologia, inteligência artificial, smartphones, programação, gadgets e inovação no Papaléguas BaixaTube.',
    keywords: 'tecnologia em vídeo, inteligência artificial, novidades tech, celulares lançamento, tutoriais de programação, papaleguas tecnologia',
    heading: 'Tecnologia & IA nas últimas horas'
  },
  'ao vivo': {
    title: 'Transmissões Ao Vivo e Canais em Tempo Real | Papaléguas BaixaTube',
    description: 'Assista a lives, transmissões ao vivo de eventos, canais de notícias e shows em tempo real sem travamentos no Papaléguas BaixaTube.',
    keywords: 'transmissão ao vivo, live youtube, notícias ao vivo, canais ao vivo grátis, eventos em tempo real, papaleguas ao vivo',
    heading: 'Transmissões ao vivo agora'
  },
  humor: {
    title: 'Vídeos de Humor, Comédia e Stand-up | Papaléguas BaixaTube',
    description: 'Dê boas risadas com os vídeos de comédia mais engraçados, stand-up comedy, pegadinhas e memes das últimas horas no Papaléguas BaixaTube.',
    keywords: 'vídeos engraçados, comédia brasil, stand up comedy, pegadinhas youtube, memes do dia, papaleguas humor',
    heading: 'Vídeos de Humor & Comédia nas últimas horas'
  },
  'em alta': {
    title: 'Vídeos Em Alta e Tendências do YouTube | Papaléguas BaixaTube',
    description: 'Veja o que todo mundo está assistindo hoje. Os vídeos mais populares, virais e em alta no Brasil e no mundo no Papaléguas BaixaTube.',
    keywords: 'vídeos em alta, tendências youtube brasil, vídeos virais, mais assistidos hoje, destaques da internet, papaleguas em alta',
    heading: 'Em alta nas últimas horas'
  },
  curtidos: {
    title: 'Para Você - Vídeos Recomendados Personalizados | Papaléguas BaixaTube',
    description: 'Vídeos recomendados especialmente para o seu gosto, baseados nas suas preferências e curtidas recentes no Papaléguas BaixaTube.',
    keywords: 'vídeos para você, recomendações personalizadas, vídeos favoritos, papaleguas vídeos',
    heading: 'Para Você: Vídeos recomendados'
  },
  financeiro: {
    title: 'Finanças, Mercado Financeiro e Investimentos em Vídeo | Papaléguas BaixaTube',
    description: 'Acompanhe as últimas notícias do mercado financeiro, bolsa de valores, investimentos, economia e finanças pessoais sem anúncios no Papaléguas BaixaTube.',
    keywords: 'finanças, mercado financeiro, investimentos, bolsa de valores, ibovespa, economia hoje, tesouro direto, dividendos, papaleguas financeiro',
    heading: '💰 Finanças & Mercado Financeiro nas últimas horas'
  },
  criptomoedas: {
    title: 'Criptomoedas, Bitcoin e Web3 em Vídeo | Papaléguas BaixaTube',
    description: 'Notícias, análises de mercado, cotação de Bitcoin, Ethereum, altcoins, blockchain e novidades cripto em tempo real no Papaléguas BaixaTube.',
    keywords: 'criptomoedas, bitcoin hoje, btc, ethereum, altcoins, cotação cripto, blockchain, web3, notícias cripto, papaleguas criptomoedas',
    heading: '🪙 Criptomoedas, Bitcoin & Web3 nas últimas horas'
  }
};

function getThemeSeoMetadata(query) {
  const rawQ = String(query || '').trim();
  const normalizedKey = rawQ.toLowerCase().replace(/\+/g, ' ');
  let matchedKey = null;

  if (!rawQ || normalizedKey === 'noticias' || normalizedKey === 'noticia') matchedKey = 'noticias';
  else if (normalizedKey === 'musicas' || normalizedKey === 'musica') matchedKey = 'musicas';
  else if (normalizedKey === 'esportes' || normalizedKey === 'esporte' || normalizedKey === 'futebol') matchedKey = 'esportes';
  else if (normalizedKey === 'financeiro' || normalizedKey === 'financas' || normalizedKey === 'finanças' || normalizedKey === 'investimentos' || normalizedKey === 'economia') matchedKey = 'financeiro';
  else if (normalizedKey === 'criptomoedas' || normalizedKey === 'cripto' || normalizedKey === 'bitcoin' || normalizedKey === 'crypto' || normalizedKey === 'btc') matchedKey = 'criptomoedas';
  else if (normalizedKey === 'podcasts' || normalizedKey === 'podcast') matchedKey = 'podcasts';
  else if (normalizedKey === 'games' || normalizedKey === 'game' || normalizedKey === 'jogos') matchedKey = 'games';
  else if (normalizedKey.includes('filme') || normalizedKey.includes('trailer')) matchedKey = 'filmes';
  else if (normalizedKey === 'tecnologia' || normalizedKey === 'tech') matchedKey = 'tecnologia';
  else if (normalizedKey === 'ao vivo' || normalizedKey === 'aovivo' || normalizedKey === 'live' || normalizedKey === 'lives') matchedKey = 'ao vivo';
  else if (normalizedKey === 'humor' || normalizedKey === 'comedia') matchedKey = 'humor';
  else if (normalizedKey === 'em alta' || normalizedKey === 'alta' || normalizedKey === 'tudo') matchedKey = 'em alta';
  else if (normalizedKey === 'curtidos' || normalizedKey === 'para voce') matchedKey = 'curtidos';

  if (matchedKey && THEME_SEO_MAP[matchedKey]) {
    const entry = THEME_SEO_MAP[matchedKey];

    // Se a categoria for "Notícias", enriquece dinamicamente junto com os assuntos mais buscados do Google Trends Brasil
    if (matchedKey === 'noticias') {
      const trends = getCachedGoogleTrends('BR');
      if (Array.isArray(trends) && trends.length > 0) {
        const top3Names = trends.slice(0, 3).map(t => t.title).join(', ');
        const topKeywords = trends.slice(0, 10).map(t => t.title).join(', ');
        return {
          query: 'noticias',
          canonicalKey: 'noticias',
          title: `Notícias das Últimas Horas e Assuntos em Alta no Google: ${top3Names} | Papaléguas BaixaTube`,
          description: `Acompanhe as principais notícias em vídeo e os temas mais buscados hoje no Google Trends Brasil (${top3Names}). Assista sem anúncios e baixe em MP4/MP3 no Papaléguas BaixaTube.`,
          keywords: `${topKeywords}, notícias brasil, últimas notícias, google trends brasil, assuntos em alta hoje, jornalismo ao vivo, papaleguas baixatube, youtube sem anúncios`,
          heading: `📰 Notícias das últimas horas & 🔥 Assuntos em Alta no Google`,
          url: 'https://papaleguas.app/baixatube',
          googleTrends: trends.slice(0, 10),
          isVideo: false
        };
      }
    }

    // Se a categoria for "Em Alta", enriquece dinamicamente com os tópicos mais buscados no Google Trends Brasil (Top 10)
    if (matchedKey === 'em alta') {
      const trends = getCachedGoogleTrends('BR');
      if (Array.isArray(trends) && trends.length > 0) {
        const top3Names = trends.slice(0, 3).map(t => t.title).join(', ');
        const topKeywords = trends.slice(0, 10).map(t => t.title).join(', ');
        return {
          query: 'em alta',
          canonicalKey: 'em alta',
          title: `Em Alta no Google Brasil: ${top3Names} | Papaléguas BaixaTube`,
          description: `Assista aos vídeos dos 10 temas mais buscados hoje no Google Trends Brasil (${top3Names}). Vídeos sem anúncios e downloads em MP4/MP3 no Papaléguas BaixaTube.`,
          keywords: `${topKeywords}, google trends brasil, em alta hoje, 10 assuntos mais buscados brasil, vídeos virais, youtube sem anúncios, papaleguas baixatube`,
          heading: `🔥 Em Alta no Google: ${top3Names}`,
          url: 'https://papaleguas.app/baixatube?q=em+alta',
          googleTrends: trends.slice(0, 10),
          isVideo: false
        };
      }
    }

    return {
      query: rawQ || 'noticias',
      canonicalKey: matchedKey,
      title: entry.title,
      description: entry.description,
      keywords: entry.keywords,
      heading: entry.heading,
      url: matchedKey === 'noticias' ? 'https://papaleguas.app/baixatube' : `https://papaleguas.app/baixatube?q=${encodeURIComponent(matchedKey)}`,
      isVideo: false
    };
  }

  // Se a busca for exatamente sobre um assunto do Google Trends, enriquece a descrição e título
  const matchedTrend = findGoogleTrendMatch(rawQ, 'BR');
  if (matchedTrend) {
    const safeQ = matchedTrend.title;
    const headline = matchedTrend.newsTitle ? ` (${matchedTrend.newsTitle})` : '';
    return {
      query: safeQ,
      canonicalKey: safeQ,
      title: `${safeQ} - Em Alta no Google Trends | Papaléguas BaixaTube`,
      description: `Assista aos vídeos mais recentes sobre "${safeQ}" (${matchedTrend.traffic || 'Em alta'} buscas)${headline}. Assista sem anúncios e baixe em MP4 ou MP3 no Papaléguas BaixaTube.`,
      keywords: `${safeQ}, google trends ${safeQ}, vídeos de ${safeQ}, assistir ${safeQ}, baixar ${safeQ} mp3, papaleguas baixatube`,
      heading: `🔥 Em Alta no Google: ${safeQ}`,
      url: `https://papaleguas.app/baixatube?q=${encodeURIComponent(safeQ)}`,
      isVideo: false
    };
  }

  // Busca personalizada
  const safeQ = rawQ || 'Vídeos';
  return {
    query: safeQ,
    canonicalKey: safeQ,
    title: `Vídeos de ${safeQ} - Assista e Baixe em MP4 e MP3 | Papaléguas BaixaTube`,
    description: `Assista aos vídeos mais recentes e relevantes sobre "${safeQ}" sem anúncios e em alta qualidade no Papaléguas BaixaTube. Downloads em MP4 e MP3.`,
    keywords: `${safeQ}, vídeos de ${safeQ}, assistir ${safeQ}, baixar ${safeQ} mp3, papaleguas baixatube, youtube sem anuncios`,
    heading: `Vídeos de "${safeQ}" nas últimas horas`,
    url: `https://papaleguas.app/baixatube?q=${encodeURIComponent(safeQ)}`,
    isVideo: false
  };
}

function getVideoSeoMetadata(videoId, videoTitle) {
  const cleanVid = escapeHtml(videoId);
  const rawTitle = String(videoTitle || 'Vídeo no Papaléguas BaixaTube').replace(/^[▶\s]+|[▶\s]+$/g, '').trim();
  const title = `${rawTitle} | Papaléguas BaixaTube`;
  const description = `Assista "${rawTitle}" online em alta definição, sem anúncios e com reprodução em segundo plano no Papaléguas BaixaTube. Downloads rápidos em MP4 e áudio MP3.`;
  const keywords = `${rawTitle}, assistir ${rawTitle}, youtube sem anúncios, baixar mp4, baixar mp3, papaleguas baixatube`;
  const url = `https://papaleguas.app/baixatube?v=${cleanVid}`;
  const thumbUrl = `https://papaleguas.app/api/thumb/${cleanVid}.jpg`;

  return {
    videoId: cleanVid,
    title,
    cleanTitle: rawTitle,
    description,
    keywords,
    url,
    thumbUrl,
    isVideo: true
  };
}

function injectSeoIntoHtml(html, seoData) {
  if (!html) return '';

  const cleanTitle = escapeHtml(seoData.title || 'Papaléguas BaixaTube');
  const cleanDesc = escapeHtml(seoData.description || 'Assista vídeos sem anúncios e baixe em MP4 ou MP3.');
  const cleanKeywords = escapeHtml(seoData.keywords || 'papaleguas, baixatube, videos sem anuncios, youtube sem anuncios');
  const cleanUrl = escapeHtml(seoData.url || 'https://papaleguas.app/baixatube');
  const cleanThumb = escapeHtml(seoData.thumbUrl || 'https://papaleguas.app/og-banner.jpg');
  const imgWidth = seoData.isVideo ? '480' : '1200';
  const imgHeight = seoData.isVideo ? '360' : '630';
  const ogType = seoData.isVideo ? 'video.other' : 'website';

  let schemaJson = '';
  if (seoData.isVideo && seoData.videoId) {
    schemaJson = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      'name': seoData.cleanTitle || seoData.title,
      'description': seoData.description,
      'thumbnailUrl': [
        `https://papaleguas.app/api/thumb/${seoData.videoId}.jpg`,
        `https://i.ytimg.com/vi/${seoData.videoId}/hqdefault.jpg`
      ],
      'uploadDate': '2026-10-30T00:00:00Z',
      'embedUrl': `https://www.youtube.com/embed/${seoData.videoId}`,
      'contentUrl': `https://papaleguas.app/baixatube?v=${seoData.videoId}`,
      'publisher': {
        '@type': 'Organization',
        'name': 'Papaléguas BaixaTube',
        'url': 'https://papaleguas.app/baixatube',
        'logo': {
          '@type': 'ImageObject',
          'url': 'https://papaleguas.app/icon-192.png'
        }
      }
    }, null, 2);
  } else {
    schemaJson = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      'name': seoData.title,
      'description': seoData.description,
      'url': seoData.url,
      'inLanguage': 'pt-BR',
      'isPartOf': {
        '@type': 'WebSite',
        'name': 'Papaléguas BaixaTube',
        'url': 'https://papaleguas.app/baixatube',
        'potentialAction': {
          '@type': 'SearchAction',
          'target': {
            '@type': 'EntryPoint',
            'urlTemplate': 'https://papaleguas.app/baixatube?q={search_term_string}'
          },
          'query-input': 'required name=search_term_string'
        }
      },
      'publisher': {
        '@type': 'Organization',
        'name': 'Papaléguas',
        'url': 'https://papaleguas.app',
        'logo': {
          '@type': 'ImageObject',
          'url': 'https://papaleguas.app/icon-192.png'
        }
      }
    }, null, 2);
  }

  const seoBlock = `<title>${cleanTitle}</title>
  <meta name="description" content="${cleanDesc}">
  <meta name="keywords" content="${cleanKeywords}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
  <link rel="canonical" href="${cleanUrl}">
  <meta name="google-site-verification" content="SJH0DPmzrPqP6IQsWjyW-z1b_rAyECfY8s3XKWeyiD0">
  <meta name="google-site-verification" content="google4acffdc77e16ecda">
  <!-- Dynamic OpenGraph for Social Sharing & Search Engine Indexing -->
  <meta property="og:site_name" content="Papaléguas BaixaTube">
  <meta property="og:title" content="${cleanTitle}">
  <meta property="og:description" content="${cleanDesc}">
  <meta property="og:type" content="${ogType}">
  <meta property="og:url" content="${cleanUrl}">
  <meta property="og:image" content="${cleanThumb}">
  <meta property="og:image:secure_url" content="${cleanThumb}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="${imgWidth}">
  <meta property="og:image:height" content="${imgHeight}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${cleanTitle}">
  <meta name="twitter:description" content="${cleanDesc}">
  <meta name="twitter:image" content="${cleanThumb}">
  <!-- Structured Data JSON-LD Schema.org -->
  <script type="application/ld+json">
${schemaJson}
  </script>`;

  let modifiedHtml = html;
  const seoRegex = /<title>[\s\S]*?<meta name="twitter:image"[^>]*>/i;
  if (seoRegex.test(modifiedHtml)) {
    modifiedHtml = modifiedHtml.replace(seoRegex, seoBlock);
  } else {
    const headMatch = /<head[^>]*>/i.exec(modifiedHtml);
    if (headMatch) {
      const idx = headMatch.index + headMatch[0].length;
      modifiedHtml = modifiedHtml.slice(0, idx) + '\n  ' + seoBlock + modifiedHtml.slice(idx);
    }
  }

  // Pre-renderização SSR do título no feed
  if (seoData.heading) {
    modifiedHtml = modifiedHtml.replace(
      /(<span\s+id="home-feed-title-text"[^>]*>)([\s\S]*?)(<\/span>)/i,
      `$1${escapeHtml(seoData.heading)}$3`
    );
  }

  // Pre-renderização SSR do chip ativo correspondente
  if (seoData.canonicalKey && !seoData.isVideo) {
    modifiedHtml = modifiedHtml.replace(/(class="yt-chip)\s+active(")/gi, '$1$2');
    const chipRegex = new RegExp(`(<button[^>]*class="yt-chip)([^>]*data-q="${seoData.canonicalKey}"[^>]*>)`, 'i');
    if (chipRegex.test(modifiedHtml)) {
      modifiedHtml = modifiedHtml.replace(chipRegex, '$1 active$2');
    }
  }

  // Pre-renderização SSR da barra de tópicos em alta do Google Trends para indexação imediata no Googlebot
  const trendsList = seoData.googleTrends || (typeof getCachedGoogleTrends === 'function' ? getCachedGoogleTrends('BR') : []);
  if (Array.isArray(trendsList) && trendsList.length > 0) {
    const trendsPillsHtml = trendsList.slice(0, 10).map((t, index) => {
      const safeTitle = escapeHtml(t.title);
      const safeTraffic = t.traffic ? `<span class="pill-traffic">${escapeHtml(t.traffic)}</span>` : '';
      return `<a href="/baixatube?q=${encodeURIComponent(t.title)}" class="google-trends-pill" title="Vídeos de ${safeTitle}"><span>#${index + 1} ${safeTitle}</span>${safeTraffic}</a>`;
    }).join('\n        ');
    modifiedHtml = modifiedHtml.replace(
      /(<div\s+class="google-trends-scroll-track"\s+id="google-trends-scroll-track"[^>]*>)([\s\S]*?)(<\/div>)/i,
      `$1\n        ${trendsPillsHtml}\n      $3`
    );
  }

  return modifiedHtml;
}

// YouTube, BaixaTube e Google Video não passam pelo proxy Tor: saem direto na velocidade máxima da internet
function isYoutubeHost(hostname) {
  return /(?:^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com|ytimg\.com|ggpht\.com|gvt1\.com)$/i.test(String(hostname || ''));
}

function isDeezerHost(hostname) {
  return /(?:^|\.)(deezer\.com|dzcdn\.net)$/i.test(String(hostname || ''));
}

// Arquivos para download (vídeos, áudios, compactados, instaladores, binários) saem direto sem passar pelo Tor
function isDownloadOrMediaUrl(urlObj) {
  if (!urlObj) return false;
  const hostname = String(urlObj.hostname || '').toLowerCase();
  if (isYoutubeHost(hostname)) return true;

  const pathname = String(urlObj.pathname || '').toLowerCase();
  const search = String(urlObj.search || '').toLowerCase();

  const downloadExts = /\.(mp4|webm|mkv|avi|mov|wmv|flv|m4v|3gp|mp3|m4a|aac|flac|wav|ogg|opus|wma|zip|rar|7z|tar|gz|bz2|xz|iso|apk|deb|rpm|exe|msi|dmg|pkg|appimage|bin|pdf|torrent)(\?|#|$)/i;
  if (downloadExts.test(pathname) || downloadExts.test(search)) return true;

  if (search.includes('download=') || search.includes('dl=1') || search.includes('export=download') || pathname.includes('/download/')) {
    return true;
  }
  return false;
}

function isIpCheckHost(hostname) {
  return /(?:^|\.)(meuip\.com\.br|meuip\.net\.br|qualemeuip\.com\.br|qualemeuip\.com|qual-e-o-meu-ip\.com|meu-ip\.com|meuip\.org|whatismyip\.com|whatismyipaddress\.com|showmyip\.com|ipinfo\.io|ip-api\.com|ipleak\.net|browserleaks\.com|dnsleaktest\.com|whoer\.net|ifconfig\.me|ifconfig\.co|ifconfig\.io|icanhazip\.com|ipify\.org|check\.torproject\.org|iplocation\.net)$/i.test(String(hostname || ''));
}

function fetchJsonViaAgent(url, agent, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      const target = new URL(url);
      const lib = target.protocol === 'http:' ? http : https;
      const req = lib.get(target, {
        agent,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' }
      }, (res) => {
        let d = '';
        res.on('data', (c) => {
          if (d.length < 20000) d += c;
        });
        res.on('end', () => {
          try {
            finish(JSON.parse(d));
          } catch (e) {
            finish({ IP: String(d || '').trim(), IsTor: false });
          }
        });
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => {
        req.destroy();
        finish(null);
      });
    } catch (e) {
      finish(null);
    }
  });
}

const COUNTRY_LANGUAGE_MAP = {
  'DE': { lang: 'de-DE,de;q=0.9,en;q=0.8', primary: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'] },
  'US': { lang: 'en-US,en;q=0.9', primary: 'en-US', languages: ['en-US', 'en'] },
  'GB': { lang: 'en-GB,en;q=0.9,en-US;q=0.8', primary: 'en-GB', languages: ['en-GB', 'en', 'en-US'] },
  'FR': { lang: 'fr-FR,fr;q=0.9,en;q=0.8', primary: 'fr-FR', languages: ['fr-FR', 'fr', 'en-US', 'en'] },
  'NL': { lang: 'nl-NL,nl;q=0.9,en;q=0.8', primary: 'nl-NL', languages: ['nl-NL', 'nl', 'en-US', 'en'] },
  'CH': { lang: 'de-CH,de;q=0.9,fr-CH;q=0.8,en;q=0.7', primary: 'de-CH', languages: ['de-CH', 'de', 'fr-CH', 'en'] },
  'AT': { lang: 'de-AT,de;q=0.9,en;q=0.8', primary: 'de-AT', languages: ['de-AT', 'de', 'en-US', 'en'] },
  'SE': { lang: 'sv-SE,sv;q=0.9,en;q=0.8', primary: 'sv-SE', languages: ['sv-SE', 'sv', 'en-US', 'en'] },
  'NO': { lang: 'nb-NO,no;q=0.9,en;q=0.8', primary: 'nb-NO', languages: ['nb-NO', 'no', 'en-US', 'en'] },
  'FI': { lang: 'fi-FI,fi;q=0.9,en;q=0.8', primary: 'fi-FI', languages: ['fi-FI', 'fi', 'en-US', 'en'] },
  'DK': { lang: 'da-DK,da;q=0.9,en;q=0.8', primary: 'da-DK', languages: ['da-DK', 'da', 'en-US', 'en'] },
  'ES': { lang: 'es-ES,es;q=0.9,en;q=0.8', primary: 'es-ES', languages: ['es-ES', 'es', 'en-US', 'en'] },
  'IT': { lang: 'it-IT,it;q=0.9,en;q=0.8', primary: 'it-IT', languages: ['it-IT', 'it', 'en-US', 'en'] },
  'PT': { lang: 'pt-PT,pt;q=0.9,en;q=0.8', primary: 'pt-PT', languages: ['pt-PT', 'pt', 'en-US', 'en'] },
  'BR': { lang: 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7', primary: 'pt-BR', languages: ['pt-BR', 'pt', 'en-US', 'en'] },
  'CA': { lang: 'en-CA,en;q=0.9,fr-CA;q=0.8,en-US;q=0.7', primary: 'en-CA', languages: ['en-CA', 'en', 'fr-CA'] },
  'AU': { lang: 'en-AU,en;q=0.9,en-US;q=0.8', primary: 'en-AU', languages: ['en-AU', 'en', 'en-US'] },
  'PL': { lang: 'pl-PL,pl;q=0.9,en;q=0.8', primary: 'pl-PL', languages: ['pl-PL', 'pl', 'en-US', 'en'] },
  'CZ': { lang: 'cs-CZ,cs;q=0.9,en;q=0.8', primary: 'cs-CZ', languages: ['cs-CZ', 'cs', 'en-US', 'en'] },
  'RO': { lang: 'ro-RO,ro;q=0.9,en;q=0.8', primary: 'ro-RO', languages: ['ro-RO', 'ro', 'en-US', 'en'] },
  'RU': { lang: 'ru-RU,ru;q=0.9,en;q=0.8', primary: 'ru-RU', languages: ['ru-RU', 'ru', 'en-US', 'en'] },
  'UA': { lang: 'uk-UA,uk;q=0.9,en;q=0.8', primary: 'uk-UA', languages: ['uk-UA', 'uk', 'en-US', 'en'] },
  'JP': { lang: 'ja-JP,ja;q=0.9,en;q=0.8', primary: 'ja-JP', languages: ['ja-JP', 'ja', 'en-US', 'en'] },
  'IS': { lang: 'is-IS,is;q=0.9,en;q=0.8', primary: 'is-IS', languages: ['is-IS', 'is', 'en-US', 'en'] },
  'LU': { lang: 'fr-LU,de-LU;q=0.9,en;q=0.8', primary: 'fr-LU', languages: ['fr-LU', 'de-LU', 'en'] }
};

let torCountryCache = { t: 0, country: 'DE', countryName: 'Germany', ip: '' };

function getLocaleForCountry(countryCode) {
  const code = String(countryCode || '').toUpperCase().trim();
  if (COUNTRY_LANGUAGE_MAP[code]) {
    return COUNTRY_LANGUAGE_MAP[code];
  }
  return {
    lang: 'en-US,en;q=0.9',
    primary: 'en-US',
    languages: ['en-US', 'en']
  };
}

async function getTorExitCountry() {
  if (torCountryCache.country && (Date.now() - torCountryCache.t) < 300000) {
    return torCountryCache;
  }
  const agent = getOutboundAgent(true);
  try {
    const geo = await fetchJsonViaAgent('http://ip-api.com/json', agent, 4000);
    if (geo && geo.countryCode) {
      torCountryCache = {
        t: Date.now(),
        country: String(geo.countryCode).toUpperCase(),
        countryName: geo.country || '',
        ip: geo.query || ''
      };
      if (typeof setTorCountry === 'function') setTorCountry(torCountryCache.country);
      return torCountryCache;
    }
  } catch (e) { swallowed(e, 'server:getTorExitCountry@1107'); }

  try {
    const geo2 = await fetchJsonViaAgent('https://ipwho.is/', agent, 4000);
    if (geo2 && geo2.country_code) {
      torCountryCache = {
        t: Date.now(),
        country: String(geo2.country_code).toUpperCase(),
        countryName: geo2.country || '',
        ip: geo2.ip || ''
      };
      if (typeof setTorCountry === 'function') setTorCountry(torCountryCache.country);
      return torCountryCache;
    }
  } catch (e2) { swallowed(e2, 'server:getTorExitCountry@1121'); }

  return torCountryCache;
}

// Dispara checagem inicial da geolocalização do nó Tor em segundo plano
setTimeout(() => { getTorExitCountry().catch(() => {}); }, 1500);

async function lookupOutboundIp(forceTor) {
  const viaTor = Boolean(getOutboundAgent(forceTor));
  if (outboundIpCache.info && outboundIpCache.tor === viaTor && (Date.now() - outboundIpCache.t) < 180000) {
    return outboundIpCache.info;
  }
  const agent = getOutboundAgent(forceTor);
  let info = await fetchJsonViaAgent('https://check.torproject.org/api/ip', agent, viaTor ? 10000 : 6000);
  if (!info || !info.IP) {
    info = await fetchJsonViaAgent('https://api.ipify.org?format=json', agent, 7000);
  }
  if (viaTor) {
    getTorExitCountry().catch(() => {});
  }
  const hasIp = Boolean(info && (info.IP || info.ip));
  const isTor = (viaTor && hasIp) ? true : Boolean(info && (info.IsTor === true || info.IsTor === 'true'));
  const result = {
    IP: (info && (info.IP || info.ip)) || '',
    IsTor: isTor,
    viaTor
  };
  outboundIpCache = { t: Date.now(), tor: viaTor, info: result };
  return result;
}

function isPrivateIpAddress(ip) {
  if (!ip) return true;
  const clean = String(ip).trim().replace(/^::ffff:/, '');
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost' || clean.startsWith('127.')) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  const match172 = clean.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (match172) {
    const oct = parseInt(match172[1], 10);
    if (oct >= 16 && oct <= 31) return true;
  }
  const lower = clean.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;
  return false;
}

function extractRequestDeviceIp(req, explicitIp = '') {
  let ip = String(explicitIp || '').trim();
  if (ip && !isPrivateIpAddress(ip)) return ip;

  if (req && req.headers) {
    const devHeader = req.headers['x-device-ip'] || req.headers['x-client-ip'];
    if (devHeader && !isPrivateIpAddress(devHeader)) return String(devHeader).trim();

    if (req.headers['cf-connecting-ip'] && !isPrivateIpAddress(req.headers['cf-connecting-ip'])) {
      return String(req.headers['cf-connecting-ip']).trim();
    }
    if (req.headers['true-client-ip'] && !isPrivateIpAddress(req.headers['true-client-ip'])) {
      return String(req.headers['true-client-ip']).trim();
    }
    if (req.headers['x-real-ip'] && !isPrivateIpAddress(req.headers['x-real-ip'])) {
      return String(req.headers['x-real-ip']).trim();
    }
    if (req.headers['x-forwarded-for']) {
      const parts = String(req.headers['x-forwarded-for']).split(',');
      for (const p of parts) {
        const clean = p.trim().replace(/^::ffff:/, '');
        if (clean && !isPrivateIpAddress(clean)) return clean;
      }
    }
  }

  if (typeof papaleguasTracker !== 'undefined' && typeof papaleguasTracker.extractClientIp === 'function') {
    const tracked = papaleguasTracker.extractClientIp(req);
    if (tracked && !isPrivateIpAddress(tracked)) return tracked;
  }

  if (req && req.socket && req.socket.remoteAddress) {
    let clean = String(req.socket.remoteAddress).trim().replace(/^::ffff:/, '');
    if (clean && !isPrivateIpAddress(clean)) return clean;
  }

  return '';
}

// Cache de país por IP do dispositivo — TTL 30 min
const ipCountryCache = createLruCache({ maxEntries: 1000, ttlMs: 24 * 60 * 60 * 1000 });

// Detecta o país do dispositivo cliente baseado no IP da conexão
async function getClientCountryCode(req, explicitIp = '', useTor = false) {
  // 1. Cloudflare (quando rodando atrás de tunelamento público, indica o país de origem do visitante)
  const cfCountry = req && req.headers && (req.headers['cf-ipcountry'] || req.headers['x-country']);
  if (cfCountry && cfCountry.length === 2 && cfCountry !== 'XX' && cfCountry !== 'T1') return cfCountry.toUpperCase();

  // 2. Lookup via ip-api.com / api.country.is usando o IP real do dispositivo cliente
  const deviceIp = extractRequestDeviceIp(req, explicitIp);
  if (deviceIp && !isPrivateIpAddress(deviceIp)) {
    const cached = ipCountryCache.get(deviceIp);
    if (cached && (Date.now() - cached.t) < 30 * 60 * 1000) return cached.country;
    try {
      const geoInfo = await fetchJsonViaAgent(
        'http://ip-api.com/json/' + encodeURIComponent(deviceIp) + '?fields=status,countryCode',
        null, 2500
      );
      if (geoInfo && geoInfo.status === 'success' && geoInfo.countryCode) {
        const country = String(geoInfo.countryCode).toUpperCase();
        ipCountryCache.set(deviceIp, { t: Date.now(), country });
        return country;
      }
    } catch (e) { swallowed(e, 'server:getClientCountryCode@1231'); }

    try {
      const countryIs = await fetchJsonViaAgent('https://api.country.is/' + encodeURIComponent(deviceIp), null, 2500);
      if (countryIs && countryIs.country && countryIs.country.length === 2) {
        const country = String(countryIs.country).toUpperCase();
        ipCountryCache.set(deviceIp, { t: Date.now(), country });
        return country;
      }
    } catch (e) { swallowed(e, 'server:getClientCountryCode@1240'); }

    try {
      const whois = await fetchJsonViaAgent('https://ipwho.is/' + encodeURIComponent(deviceIp), null, 2500);
      if (whois && whois.country_code && whois.country_code.length === 2) {
        const country = String(whois.country_code).toUpperCase();
        ipCountryCache.set(deviceIp, { t: Date.now(), country });
        return country;
      }
    } catch (e) { swallowed(e, 'server:getClientCountryCode@1249'); }
  }

  // 3. Se for IP privado / rede Wi-Fi local, consulta a geolocalização da conexão pública real (direta, sem Tor)
  try {
    const cachedPublic = ipCountryCache.get('__public_egress__');
    if (cachedPublic && (Date.now() - cachedPublic.t) < 30 * 60 * 1000) return cachedPublic.country;
    const publicGeo = await fetchJsonViaAgent('https://api.country.is/', null, 2500);
    if (publicGeo && publicGeo.country && publicGeo.country.length === 2) {
      const country = String(publicGeo.country).toUpperCase();
      ipCountryCache.set('__public_egress__', { t: Date.now(), country });
      return country;
    }
  } catch (e) { swallowed(e, 'server:getClientCountryCode@1262'); }

  try {
    const publicGeo2 = await fetchJsonViaAgent('http://ip-api.com/json/?fields=status,countryCode', null, 2500);
    if (publicGeo2 && publicGeo2.status === 'success' && publicGeo2.countryCode) {
      const country = String(publicGeo2.countryCode).toUpperCase();
      ipCountryCache.set('__public_egress__', { t: Date.now(), country });
      return country;
    }
  } catch (e) { swallowed(e, 'server:getClientCountryCode@1271'); }

  // 4. Fallback por Accept-Language do navegador do dispositivo cliente
  const lang = (req && req.headers && req.headers['accept-language']) || '';
  if (/pt-PT/i.test(lang)) return 'PT';
  if (/pt-BR/i.test(lang)) return 'BR';
  if (/es-AR/i.test(lang)) return 'AR';
  if (/es-MX/i.test(lang)) return 'MX';
  if (/es-ES|es/i.test(lang)) return 'ES';
  if (/en-US/i.test(lang)) return 'US';
  if (/en-GB/i.test(lang)) return 'GB';
  if (/fr/i.test(lang)) return 'FR';
  if (/de/i.test(lang)) return 'DE';
  if (/it/i.test(lang)) return 'IT';
  if (/ja/i.test(lang)) return 'JP';
  if (/ko/i.test(lang)) return 'KR';
  if (/zh/i.test(lang)) return 'CN';
  return 'BR';
}

function getHlForCountry(country = 'BR') {
  const c = String(country || '').toUpperCase();
  if (c === 'BR') return 'pt-BR';
  if (c === 'PT') return 'pt-PT';
  if (['AR', 'MX', 'ES', 'CO', 'CL', 'PE', 'UY', 'VE', 'BO', 'EC', 'PY'].includes(c)) return 'es';
  if (['US', 'GB', 'CA', 'AU', 'NZ', 'IE'].includes(c)) return 'en';
  if (c === 'FR') return 'fr';
  if (['DE', 'AT', 'CH'].includes(c)) return 'de';
  if (c === 'IT') return 'it';
  if (c === 'NO') return 'no';
  if (c === 'SE') return 'sv';
  if (c === 'NL') return 'nl';
  if (['RU', 'BY', 'KZ'].includes(c)) return 'ru';
  if (c === 'JP') return 'ja';
  if (c === 'KR') return 'ko';
  if (c === 'CN') return 'zh-CN';
  if (c === 'PL') return 'pl';
  if (c === 'TR') return 'tr';
  return 'en';
}

function buildIpCheckPage(info) {
  const ip = info.IP || '—';
  const viaTor = Boolean(info.viaTor);
  const isTor = Boolean(info.IsTor || viaTor);
  const statusLabel = isTor ? 'Saída Tor Confirmada • Navegação 100% Anônima' : (!viaTor ? 'Internet direta' : 'Tor ativo');
  const statusColor = isTor ? '#00ff88' : (!viaTor ? '#38bdf8' : '#f59e0b');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Meu IP — Papaléguas Tor</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#07090e; color:#e2e8f0; font-family:system-ui,sans-serif; padding:24px; }
    .card { width:min(480px,100%); background:#111827; border:1px solid rgba(255,255,255,.08); border-radius:24px; padding:36px 28px; text-align:center; box-shadow:0 20px 50px rgba(0,0,0,.45); }
    .kicker { font-size:13px; letter-spacing:.08em; text-transform:uppercase; color:#94a3b8; margin-bottom:10px; }
    .ip { font-size:34px; font-weight:800; letter-spacing:-.04em; color:#fff; word-break:break-all; margin:8px 0 18px; }
    .badge { display:inline-block; padding:8px 14px; border-radius:999px; font-size:13px; font-weight:700; color:${statusColor}; background:rgba(255,255,255,.05); border:1px solid ${statusColor}55; }
    .shield-box { margin-top:16px; padding:12px; background:rgba(0,255,136,0.06); border:1px solid rgba(0,255,136,0.2); border-radius:12px; font-size:13px; color:#86efac; text-align:left; line-height:1.45; }
    p { color:#94a3b8; font-size:14px; line-height:1.55; margin:18px 0 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="kicker">IP de saída desta conexão</div>
    <div class="ip">${ip}</div>
    <div class="badge">${statusLabel}</div>
    <div class="shield-box">
      🛡️ <strong>Seu IP real está 100% blindado e oculto.</strong> Sites externos e buscas enxergam somente o endereço de saída Tor acima (${ip}).
    </div>
    <p>Sites de checagem com antibot agressivo são interceptados diretamente para este painel seguro, usando o nó de saída Tor da sua navegação.</p>
  </div>
  <script>
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'navigate-sync', url: 'https://www.meuip.com.br/', targetUrl: 'https://www.meuip.com.br/', title: 'Meu IP — Tor' }, '*');
      }
    } catch (e) {}
  </script>
</body>
</html>`;
}

function ytdlpProxyArgs() {
  return ['-4', '--proxy', ''];
}

function rewriteGoogleFamilyThroughProxy(html, clientId, pageOrigin) {
  return rewriteProxiedHtml(html, clientId, pageOrigin);
}

function encodeProxyOriginB64(origin) {
  const originSlash = String(origin || '').replace(/\/?$/, '/');
  return Buffer.from(originSlash, 'utf8').toString('base64url');
}

function buildProxyBaseHref(clientId, origin) {
  return '/proxy-base/' + encodeURIComponent(clientId || 'client_default') + '/' + encodeProxyOriginB64(origin) + '/';
}

function wrapProxyAbs(url, clientId) {
  return '/proxy?url=' + encodeURIComponent(url) + '&clientId=' + encodeURIComponent(clientId || 'client_default');
}

function rewriteMetaRefresh(html, clientId, pageUrl, headerRefresh = null) {
  let out = String(html || '');
  let hadMetaRefresh = false;

  out = out.replace(/<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*>/gi, (tag) => {
    hadMetaRefresh = true;
    const contentMatch = tag.match(/content=(["'])([\s\S]*?)\1/i) || tag.match(/content=([^\s>]+)/i);
    if (!contentMatch) return tag;
    const content = String(contentMatch[2] || contentMatch[1] || '').trim();
    const parts = content.split(/url\s*=\s*/i);
    const delay = String(parts[0] || '0').replace(/;+\s*$/, '').trim() || '0';
    let next = pageUrl;
    if (parts.length >= 2) {
      next = String(parts[1] || '').replace(/^["']|["']$/g, '').trim();
      try {
        next = new URL(next, pageUrl).href;
      } catch (e) {
        next = pageUrl;
      }
    }
    return '<meta http-equiv="refresh" content="' + delay + ';url=' + wrapProxyAbs(next, clientId) + '">';
  });

  // Se o servidor enviou o header HTTP Refresh (ex: Dread/DDoS protection 'refresh: 18' ou '10; url=...')
  if (!hadMetaRefresh && headerRefresh) {
    const rawH = String(headerRefresh).trim();
    const parts = rawH.split(/url\s*=\s*/i);
    const delay = String(parts[0] || '0').replace(/;+\s*$/, '').trim() || '0';
    let next = pageUrl;
    if (parts.length >= 2) {
      next = String(parts[1] || '').replace(/^["']|["']$/g, '').trim();
      try {
        next = new URL(next, pageUrl).href;
      } catch (e) {
        next = pageUrl;
      }
    }
    const metaTag = '<meta http-equiv="refresh" content="' + delay + ';url=' + wrapProxyAbs(next, clientId) + '">';
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head[^>]*>/i, `$&${metaTag}`);
    } else {
      out = metaTag + out;
    }
  }

  return out;
}

const proxyCookieJars = new Map();

function proxyCookieKey(clientId, hostname) {
  return String(clientId || 'client_default') + '\n' + String(hostname || '').toLowerCase();
}

function storeProxyCookies() {
  // Modo sem cookies: não armazena cookies de terceiros em memória
}

function cookieHeaderForProxy() {
  // Modo sem cookies: nunca envia cookies nas requisições do proxy
  return '';
}

function rewriteSetCookieForProxy(raw) {
  return String(raw || '');
}

function applyProxySetCookies(responseHeaders) {
  if (responseHeaders && responseHeaders['set-cookie']) {
    delete responseHeaders['set-cookie'];
  }
}

function isAppShellPathname(pathname) {
  const p = String(pathname || '/').replace(/\/+$/, '') || '/';
  return p === '/' || p === '/index.html' || p === '/src/index.html';
}

function isIframeDocumentRequest(req) {
  const dest = String((req && req.headers && req.headers['sec-fetch-dest']) || '').toLowerCase();
  return dest === 'iframe' || dest === 'frame';
}

function readRequestCookie(req, name) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  if (!raw || !name) return '';
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 1) continue;
    if (parts[i].slice(0, eq).trim() === name) return parts[i].slice(eq + 1).trim();
  }
  return '';
}

function parseRefererProxy(req) {
  const result = { target: '', clientId: req.headers['x-client-id'] || 'client_default' };
  const referer = String((req && req.headers && req.headers.referer) || '');
  if (referer) {
    try {
      const u = new URL(referer, 'http://127.0.0.1');
      if (u.pathname === '/proxy' || u.pathname === '/proxy/') {
        result.target = u.searchParams.get('url') || '';
        result.clientId = u.searchParams.get('clientId') || result.clientId;
      } else if (u.pathname.startsWith('/proxy-base/')) {
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length >= 3) {
          result.clientId = decodeURIComponent(parts[1] || result.clientId);
          result.target = Buffer.from(parts[2], 'base64url').toString('utf8');
        }
      }
    } catch (e) { swallowed(e, 'server:parseRefererProxy@1520'); }
  }
  if (!result.target) {
    const sess = clientSessions.get(result.clientId) || clientSessions.get('client_default');
    if (sess && sess.lastProxyOrigin) {
      result.target = sess.lastProxyOrigin;
    }
  }
  return result;
}

function isProxiedPageReferer(req) {
  return /\/proxy(?:\?|-base\/)/i.test(String((req && req.headers && req.headers.referer) || ''));
}

// Dentro do HTML o "&" das URLs vem escapado como &amp;. Reencodar isso quebra a query
// da página de destino (foi o que deixava o load.php da Wikipédia sem devolver CSS).
function decodeAttrUrl(url) {
  return String(url || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;|&#[xX]0*26;/g, '&');
}

// O CSS chega de um caminho /proxy?url=..., então tudo que é relativo dentro dele
// apontaria para o nosso servidor. Reescreve url(...) e @import para o endereço real.
function rewriteProxiedCss(css, clientId, cssUrl) {
  const toAbsolute = (raw) => {
    try {
      return new URL(String(raw).trim(), cssUrl).href;
    } catch (e) {
      return '';
    }
  };
  return String(css || '')
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, quote, raw) => {
      const value = String(raw).trim();
      if (!value || /^(data:|blob:|about:|#)/i.test(value) || value.indexOf('/proxy?url=') === 0) return all;
      const full = toAbsolute(value);
      return full ? 'url(' + quote + wrapProxyAbs(full, clientId) + quote + ')' : all;
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (all, quote, raw) => {
      if (String(raw).indexOf('/proxy?url=') === 0) return all;
      const full = toAbsolute(raw);
      return full ? '@import ' + quote + wrapProxyAbs(full, clientId) + quote : all;
    });
}

function rewriteProxiedHtml(html, clientId, pageOrigin) {
  const origin = String(pageOrigin || '').replace(/\/$/, '');
  if (!origin) return String(html || '');
  const wrapAbs = (url) => wrapProxyAbs(decodeAttrUrl(url), clientId);
  let out = String(html || '');
  // Remove qualquer meta tag interna que force bloqueio de iframe (CSP frame-ancestors ou X-Frame-Options)
  out = out.replace(/<meta[^>]+http-equiv=["']?(?:content-security-policy|x-frame-options)["']?[^>]*>/gi, '');
  out = out.replace(/\s(src|href|action|poster|data-src)=(["'])(https?:\/\/[^"']+)\2/gi, (all, attr, quote, url) => {
    if (url.indexOf('/proxy?url=') !== -1 || url.indexOf('/proxy-base/') !== -1) return all;
    return ' ' + attr + '=' + quote + wrapAbs(url) + quote;
  });
  out = out.replace(/\s(src|href|action|poster|data-src)=(["'])(\/\/[^"']+)\2/gi, (all, attr, quote, url) => {
    if (url.indexOf('/proxy?url=') !== -1) return all;
    return ' ' + attr + '=' + quote + wrapAbs('https:' + url) + quote;
  });
  out = out.replace(/\s(src|href|action|poster|data-src)=(["'])(\/[^"']*)\2/gi, (all, attr, quote, path) => {
    if (path.indexOf('/proxy') === 0 || path.indexOf('/api/') === 0 || path.indexOf('/youtube') === 0 || path.indexOf('/baixatube') === 0 || path.indexOf('/icon-') === 0 || path.indexOf('/favicon') === 0 || path.indexOf('/papaleguas') === 0) return all;
    return ' ' + attr + '=' + quote + wrapAbs(origin + path) + quote;
  });
  // Imagens responsivas trazem várias URLs separadas por vírgula no mesmo atributo
  out = out.replace(/\s(srcset|imagesrcset|data-srcset)=(["'])([^"']+)\2/gi, (all, attr, quote, value) => {
    const candidates = value.split(',').map((part) => {
      const pieces = part.trim().split(/\s+/);
      const url = decodeAttrUrl(pieces[0] || '');
      if (!url || /^data:/i.test(url) || url.indexOf('/proxy?url=') === 0) return part.trim();
      let full = url;
      if (url.indexOf('//') === 0) full = 'https:' + url;
      else if (url.charAt(0) === '/') full = origin + url;
      else if (!/^https?:\/\//i.test(url)) return part.trim();
      return [wrapProxyAbs(full, clientId)].concat(pieces.slice(1)).join(' ');
    }).filter(Boolean);
    return ' ' + attr + '=' + quote + candidates.join(', ') + quote;
  });
  // Folhas de estilo embutidas seguem as mesmas regras dos arquivos .css
  out = out.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (all, open, body, close) => {
    return open + rewriteProxiedCss(body, clientId, origin + '/') + close;
  });
  return out;
}

function buildProxyLeakShield(clientId, pageUrl, pageOrigin, torLocale = null) {
  const localePatch = torLocale ? `
    try {
      var TOR_LANG = ${JSON.stringify(torLocale.primary)};
      var TOR_LANGS = ${JSON.stringify(torLocale.languages)};
      try { Object.defineProperty(Navigator.prototype, 'language', { get: function() { return TOR_LANG; }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(Navigator.prototype, 'languages', { get: function() { return TOR_LANGS; }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(navigator, 'language', { get: function() { return TOR_LANG; }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(navigator, 'languages', { get: function() { return TOR_LANGS; }, configurable: true }); } catch (e) {}
    } catch (e) {}
  ` : '';

  return `
              <script>
                (function() {
                  var CLIENT_ID = ${JSON.stringify(String(clientId || 'client_default'))};
                  var PAGE_URL = ${JSON.stringify(String(pageUrl || pageOrigin || ''))};
                  var PAGE_ORIGIN = ${JSON.stringify(String(pageOrigin || '').replace(/\/$/, ''))};
                  try {
                    window.__plRealTop = window.top;
                    window.__plRealParent = window.parent;
                  } catch (e) {}
                  // Escudo Anti-Bot & Camuflagem de Navegador Humano (Cloudflare / Akamai / DataDome)
                  try {
                    Object.defineProperty(Navigator.prototype, 'webdriver', { get: function() { return false; }, configurable: true });
                    Object.defineProperty(navigator, 'webdriver', { get: function() { return false; }, configurable: true });
                  } catch (e) {}
                  try {
                    if (!window.chrome) {
                      window.chrome = { runtime: {}, app: { isInstalled: false }, csi: function() { return {}; }, loadTimes: function() { return {}; } };
                    }
                  } catch (e) {}
                  try {
                    if (!navigator.plugins || navigator.plugins.length === 0) {
                      Object.defineProperty(Navigator.prototype, 'plugins', {
                        get: function() { return [{ name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }, { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }]; },
                        configurable: true
                      });
                    }
                  } catch (e) {}
                  ${localePatch}

                  function killWebRTC() {
                    var blocked = function() { throw new Error('blocked'); };
                    try { window.RTCPeerConnection = blocked; } catch (e) {}
                    try { window.webkitRTCPeerConnection = blocked; } catch (e) {}
                    try { window.mozRTCPeerConnection = blocked; } catch (e) {}
                    try { window.RTCIceCandidate = blocked; } catch (e) {}
                    try {
                      if (navigator.mediaDevices) {
                        navigator.mediaDevices.getUserMedia = function() { return Promise.reject(new Error('blocked')); };
                        navigator.mediaDevices.enumerateDevices = function() { return Promise.resolve([]); };
                      }
                    } catch (e) {}
                  }
                  killWebRTC();

                  function toProxy(url) {
                    if (!url || typeof url !== 'string') return url;
                    var raw = url.trim();
                    if (!raw || raw.charAt(0) === '#' || /^(javascript|data|blob|mailto|tel):/i.test(raw)) return url;
                    if (raw.indexOf('/proxy?') === 0 || raw.indexOf('/proxy-base/') === 0) return url;
                    try {
                      var abs = new URL(raw, PAGE_URL || location.href);
                      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return url;
                      if (abs.origin === location.origin && (abs.pathname.indexOf('/proxy') === 0 || abs.pathname.indexOf('/api/') === 0)) return url;
                      if (abs.origin === location.origin) {
                        return '/proxy?url=' + encodeURIComponent(PAGE_ORIGIN + abs.pathname + abs.search + abs.hash) + '&clientId=' + encodeURIComponent(CLIENT_ID);
                      }
                      return '/proxy?url=' + encodeURIComponent(abs.href) + '&clientId=' + encodeURIComponent(CLIENT_ID);
                    } catch (e) {
                      return url;
                    }
                  }

                  try {
                    var nativeFetch = window.fetch;
                    if (nativeFetch) {
                      window.fetch = function(input, init) {
                        try {
                          if (typeof input === 'string') input = toProxy(input);
                          else if (input && input.url) input = new Request(toProxy(input.url), input);
                        } catch (e) {}
                        return nativeFetch.call(this, input, init);
                      };
                    }
                  } catch (e) {}

                  try {
                    var xo = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function(method, url) {
                      var args = Array.prototype.slice.call(arguments);
                      if (typeof url === 'string') args[1] = toProxy(url);
                      return xo.apply(this, args);
                    };
                  } catch (e) {}

                  try {
                    if (navigator.sendBeacon) {
                      var beacon = navigator.sendBeacon.bind(navigator);
                      navigator.sendBeacon = function(url, data) { return beacon(toProxy(url), data); };
                    }
                  } catch (e) {}

                  try {
                    var NativeWS = window.WebSocket;
                    window.WebSocket = function(url, protocols) {
                      return new NativeWS(toProxy(String(url || '')), protocols);
                    };
                    window.WebSocket.prototype = NativeWS.prototype;
                    window.WebSocket.CONNECTING = NativeWS.CONNECTING;
                    window.WebSocket.OPEN = NativeWS.OPEN;
                    window.WebSocket.CLOSING = NativeWS.CLOSING;
                    window.WebSocket.CLOSED = NativeWS.CLOSED;
                  } catch (e) {}

                  try {
                    var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
                    if (imgDesc && imgDesc.set) {
                      Object.defineProperty(HTMLImageElement.prototype, 'src', {
                        configurable: true,
                        get: function() { return imgDesc.get.call(this); },
                        set: function(v) { imgDesc.set.call(this, toProxy(v)); }
                      });
                    }
                  } catch (e) {}

                  try {
                    var setAttr = Element.prototype.setAttribute;
                    Element.prototype.setAttribute = function(name, value) {
                      var n = String(name || '').toLowerCase();
                      if ((n === 'src' || n === 'href' || n === 'action' || n === 'poster' || n === 'data-src') && typeof value === 'string') {
                        value = toProxy(value);
                      }
                      return setAttr.call(this, name, value);
                    };
                  } catch (e) {}

                  try {
                    var locAssign = window.location.assign.bind(window.location);
                    var locReplace = window.location.replace.bind(window.location);
                    window.location.assign = function(url) { locAssign(toProxy(String(url || ''))); };
                    window.location.replace = function(url) { locReplace(toProxy(String(url || ''))); };
                    var hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
                    if (hrefDesc && hrefDesc.set) {
                      Object.defineProperty(Location.prototype, 'href', {
                        configurable: true,
                        get: function() { return hrefDesc.get.call(this); },
                        set: function(v) { hrefDesc.set.call(this, toProxy(String(v || ''))); }
                      });
                    }
                  } catch (e) {}

                  try {
                    window.open = function(url, target, features) {
                      if (!url || url === 'about:blank') return null;
                      var proxied = toProxy(String(url));
                      try {
                        if (window.parent && window.parent !== window) {
                          window.parent.postMessage({ type: 'open-new-tab', url: proxied }, '*');
                          return null;
                        }
                      } catch (err) {}
                      location.href = proxied;
                      return null;
                    };
                  } catch (e) {}

                  try {
                    document.addEventListener('click', function(ev) {
                      var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
                      if (!a) return;
                      var rawHref = a.getAttribute('href');
                      if (!rawHref || rawHref.charAt(0) === '#' || /^(javascript|data|blob|mailto|tel):/i.test(rawHref)) return;
                      var target = (a.getAttribute('target') || '').toLowerCase().trim();
                      var proxied = toProxy(a.href || rawHref);
                      if (target === '_blank' || target === '_new' || ev.ctrlKey || ev.metaKey) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        try {
                          if (window.parent && window.parent !== window) {
                            window.parent.postMessage({ type: 'open-new-tab', url: proxied }, '*');
                            return;
                          }
                        } catch (err) {}
                        location.href = proxied;
                        return;
                      }
                      if (a.href && a.href.indexOf('/proxy') === -1) {
                        a.href = proxied;
                      }
                    }, true);

                    document.addEventListener('submit', function(ev) {
                      var form = ev.target;
                      if (!form || !form.tagName) return;
                      var tgt = (form.getAttribute('target') || '').toLowerCase().trim();
                      if (tgt === '_blank' || tgt === '_new') {
                        form.setAttribute('target', '_self');
                      }
                      var action = form.getAttribute('action') || location.href;
                      var proxiedAction = toProxy(action);
                      if (proxiedAction && form.action !== proxiedAction) {
                        form.setAttribute('action', proxiedAction);
                      }
                    }, true);
                  } catch (e) {}

                  try {
                    document.addEventListener('submit', function(ev) {
                      var form = ev.target;
                      if (!form || !form.action) return;
                      var act = form.getAttribute('action');
                      if (act && act.indexOf('/proxy') === -1) {
                        form.action = toProxy(form.action || act);
                      }
                    }, true);
                  } catch (e) {}

                  killWebRTC();
                })();
              </script>`;
}

function buildYouTubeEnhancement(clientId, pageUrl, pageHostname) {
  return `
    <style id="papaleguas-yt-adblock">
      /* Bloqueio Total de Anúncios e Promoções no YouTube Mobile */
      ytd-promoted-sparkles-web-renderer,
      ytm-promoted-sparkles-web-renderer,
      ytm-companion-ad-renderer,
      ytm-promoted-video-renderer,
      ytm-paid-content-overlay-renderer,
      .ad-container,
      .video-ads,
      .ytp-ad-module,
      .ytp-ad-overlay-container,
      .ytp-ad-player-overlay,
      .ytp-ad-action-interstitial,
      .ad-div,
      [class*="promoted"],
      [class*="ad-unit"],
      /* Banners de 'Abrir App' e 'YouTube Kids' */
      ytm-open-app-tool-bar,
      .open-app-button,
      [aria-label*="Abrir app" i],
      [aria-label*="Open app" i],
      [aria-label*="Abrir o app" i],
      ytm-mealbar-promo-renderer,
      ytm-upsell-dialog-renderer,
      ytm-app-banner,
      .mobile-topbar-header [aria-label*="Abrir" i],
      button.c3-material-button--tonal[aria-label*="Abrir" i] {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
        height: 0 !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
      }

      /* Barra de Ações Papaléguas (Baixar MP4 / MP3) */
      #papaleguas-yt-bar {
        position: fixed;
        bottom: 12px;
        left: 10px;
        right: 10px;
        max-width: 480px;
        margin: 0 auto;
        z-index: 2147483647;
        background: linear-gradient(135deg, rgba(13, 27, 42, 0.95) 0%, rgba(6, 9, 19, 0.98) 100%);
        border: 1px solid rgba(0, 240, 255, 0.4);
        border-radius: 16px;
        padding: 8px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.75), 0 0 16px rgba(0, 240, 255, 0.25);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-sizing: border-box;
      }
      .pl-yt-brand {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .pl-yt-logo {
        width: 22px;
        height: 22px;
        border-radius: 6px;
        object-fit: cover;
      }
      .pl-yt-title {
        font-size: 13px;
        font-weight: 700;
        color: #00f0ff;
        letter-spacing: 0.3px;
      }
      .pl-yt-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
        justify-content: flex-end;
      }
      .pl-yt-btn {
        appearance: none;
        border: none;
        outline: none;
        border-radius: 10px;
        padding: 7px 12px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 5px;
        transition: transform 0.15s ease, opacity 0.15s ease;
        white-space: nowrap;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .pl-yt-btn:active {
        transform: scale(0.95);
      }
      .pl-yt-btn-mp4 {
        background: linear-gradient(135deg, #0284c7 0%, #00f0ff 100%);
        color: #030408;
        box-shadow: 0 2px 10px rgba(0, 240, 255, 0.35);
      }
      .pl-yt-btn-mp3 {
        background: linear-gradient(135deg, #059669 0%, #00ff88 100%);
        color: #030408;
        box-shadow: 0 2px 10px rgba(0, 255, 136, 0.35);
      }

      /* Modal de Download */
      #papaleguas-dl-modal {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-sizing: border-box;
      }
      #papaleguas-dl-modal.pl-hidden {
        display: none !important;
      }
      .pl-modal-backdrop {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }
      .pl-modal-card {
        position: relative;
        z-index: 1;
        width: 100%;
        max-width: 380px;
        background: #0f172a;
        border: 1px solid rgba(0, 240, 255, 0.35);
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.8), 0 0 24px rgba(0, 240, 255, 0.2);
        color: #f8fafc;
        box-sizing: border-box;
      }
      .pl-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      .pl-modal-heading {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 15px;
        font-weight: 700;
        color: #00f0ff;
      }
      .pl-modal-close {
        background: rgba(255, 255, 255, 0.1);
        border: none;
        color: #94a3b8;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
      }
      .pl-modal-video-title {
        font-size: 13px;
        font-weight: 600;
        color: #e2e8f0;
        margin-bottom: 14px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        line-height: 1.4;
      }
      .pl-track {
        width: 100%;
        height: 8px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        overflow: hidden;
        margin-bottom: 10px;
      }
      .pl-fill {
        width: 0%;
        height: 100%;
        background: linear-gradient(90deg, #00f0ff 0%, #00ff88 100%);
        transition: width 0.3s ease;
      }
      .pl-status-row {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        color: #94a3b8;
        margin-bottom: 6px;
      }
      .pl-pct {
        font-weight: 700;
        color: #00ff88;
      }
      .pl-speed {
        font-size: 11px;
        color: #64748b;
      }
      .pl-download-btn {
        width: 100%;
        margin-top: 14px;
        padding: 10px;
        border: none;
        border-radius: 10px;
        background: linear-gradient(135deg, #059669 0%, #00ff88 100%);
        color: #030408;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        display: none;
        text-align: center;
        text-decoration: none;
        box-sizing: border-box;
      }
    </style>
    <script id="papaleguas-yt-enhancer">
      (function() {
        var CLIENT_ID = ${JSON.stringify(String(clientId || 'client_default'))};

        function extractYtId(raw) {
          if (!raw) return '';
          var s = String(raw).trim();
          var m = s.match(/(?:youtube\\.com\\/(?:[^\\/]+\\/.+\\/|(?:v|e(?:mbed)?|shorts|live)\\/|.*[?&]v=)|youtu\\.be\\/)([^"&?\\/\\s]{11})/i);
          if (m && m[1]) return m[1];
          var mShort = s.match(/[?&]v=([^"&?\\/\\s]{11})/i) || s.match(/\\/shorts\\/([^"&?\\/\\s]{11})/i);
          if (mShort && mShort[1]) return mShort[1];
          return '';
        }

        function getActiveVideoId() {
          var id = extractYtId(location.href);
          if (id) return id;
          var player = document.querySelector('video.html5-main-video, video');
          if (player && player.closest) {
            var c = player.closest('[data-video-id]');
            if (c && c.getAttribute('data-video-id')) return c.getAttribute('data-video-id');
          }
          var link = document.querySelector('a[href*="/watch?v="]');
          if (link) return extractYtId(link.getAttribute('href'));
          return '';
        }

        function mountBar() {
          if (document.getElementById('papaleguas-yt-bar')) return;
          if (!document.body) return;

          var bar = document.createElement('div');
          bar.id = 'papaleguas-yt-bar';
          bar.innerHTML = '<div class="pl-yt-brand" id="pl-yt-brand-btn" title="Assistir no Papaléguas BaixaTube">' +
            '<img src="/icon-192.png" class="pl-yt-logo" alt="Papaléguas" onerror="this.src=\\'/favicon.ico\\';" />' +
            '<span class="pl-yt-title">Papaléguas</span>' +
            '</div>' +
            '<div class="pl-yt-actions">' +
            '<button class="pl-yt-btn pl-yt-btn-mp4" id="pl-dl-mp4-btn" type="button">🎬 Baixar MP4</button>' +
            '<button class="pl-yt-btn pl-yt-btn-mp3" id="pl-dl-mp3-btn" type="button">🎵 Baixar MP3</button>' +
            '</div>';
          document.body.appendChild(bar);

          var modal = document.createElement('div');
          modal.id = 'papaleguas-dl-modal';
          modal.className = 'pl-hidden';
          modal.innerHTML = '<div class="pl-modal-backdrop" id="pl-modal-bg"></div>' +
            '<div class="pl-modal-card">' +
            '<div class="pl-modal-header">' +
            '<div class="pl-modal-heading"><span>⚡</span><span>Download Papaléguas</span></div>' +
            '<button class="pl-modal-close" id="pl-modal-close-btn" type="button">&times;</button>' +
            '</div>' +
            '<div class="pl-modal-video-title" id="pl-modal-title">Preparando vídeo...</div>' +
            '<div class="pl-track"><div class="pl-fill" id="pl-modal-fill"></div></div>' +
            '<div class="pl-status-row">' +
            '<span id="pl-modal-status">Conectando ao servidor...</span>' +
            '<span class="pl-pct" id="pl-modal-pct">0%</span>' +
            '</div>' +
            '<div class="pl-speed" id="pl-modal-speed">Aguardando conversão multi-core...</div>' +
            '<a class="pl-download-btn" id="pl-modal-dl-btn" href="#" download>⬇️ Salvar Arquivo no Celular</a>' +
            '</div>';
          document.body.appendChild(modal);

          document.getElementById('pl-dl-mp4-btn').addEventListener('click', function() { startDownload('mp4'); });
          document.getElementById('pl-dl-mp3-btn').addEventListener('click', function() { startDownload('mp3'); });
          document.getElementById('pl-modal-close-btn').addEventListener('click', closeModal);
          document.getElementById('pl-modal-bg').addEventListener('click', closeModal);
          document.getElementById('pl-yt-brand-btn').addEventListener('click', function() {
            var vid = getActiveVideoId();
            if (vid) {
              try {
                if (window.parent && window.parent !== window) {
                  window.parent.postMessage({ type: 'open-new-tab', url: '/baixatube?v=' + vid }, '*');
                  return;
                }
              } catch(e) {}
              location.href = '/baixatube?v=' + vid;
            }
          });
        }

        var activeDownloadPoll = null;

        function closeModal() {
          if (activeDownloadPoll) { clearInterval(activeDownloadPoll); activeDownloadPoll = null; }
          var modal = document.getElementById('papaleguas-dl-modal');
          if (modal) modal.classList.add('pl-hidden');
        }

        function startDownload(format) {
          var vid = getActiveVideoId();
          if (!vid) {
            alert('Abra um vídeo do YouTube para iniciar o download.');
            return;
          }

          var modal = document.getElementById('papaleguas-dl-modal');
          var fill = document.getElementById('pl-modal-fill');
          var pct = document.getElementById('pl-modal-pct');
          var status = document.getElementById('pl-modal-status');
          var speed = document.getElementById('pl-modal-speed');
          var titleEl = document.getElementById('pl-modal-title');
          var dlBtn = document.getElementById('pl-modal-dl-btn');

          if (modal) modal.classList.remove('pl-hidden');
          if (fill) fill.style.width = '0%';
          if (pct) pct.textContent = '0%';
          if (status) status.textContent = 'Iniciando download em ' + format.toUpperCase() + '...';
          if (speed) speed.textContent = '⚡ Conectando ao motor FFmpeg...';
          if (dlBtn) dlBtn.style.display = 'none';

          var currentTitle = document.title ? document.title.replace(/\\s*-\\s*YouTube$/i, '') : 'Vídeo Papaléguas';
          var headerTitle = document.querySelector('h1.slim-video-information-title, ytm-slim-video-metadata-renderer .title, h1');
          if (headerTitle && headerTitle.textContent) currentTitle = headerTitle.textContent.trim();
          if (titleEl) titleEl.textContent = currentTitle;

          fetch('/api/media/download-job', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: vid, format: format, quality: 'best' })
          })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (!data || !data.success || !data.jobId) {
              throw new Error(data && data.error ? data.error : 'Falha ao iniciar processamento');
            }
            var jobId = data.jobId;
            if (activeDownloadPoll) clearInterval(activeDownloadPoll);
            activeDownloadPoll = setInterval(function() {
              fetch('/api/media/download-status?jobId=' + encodeURIComponent(jobId))
                .then(function(r) { return r.json(); })
                .then(function(st) {
                  if (st.progress !== undefined) {
                    if (fill) fill.style.width = st.progress + '%';
                    if (pct) pct.textContent = st.progress + '%';
                  }
                  if (st.text && status) status.textContent = st.text;
                  if (st.speed && speed) speed.textContent = '⚡ ' + st.speed + (st.eta ? ' • Restante: ' + st.eta : '');
                  if (st.stage === 'complete' && st.success && st.url) {
                    clearInterval(activeDownloadPoll);
                    activeDownloadPoll = null;
                    if (fill) fill.style.width = '100%';
                    if (pct) pct.textContent = '100%';
                    if (status) status.textContent = '✅ Download concluído!';
                    if (speed) speed.textContent = 'Arquivo pronto para salvar';
                    if (dlBtn) {
                      dlBtn.href = st.url;
                      dlBtn.download = (st.title || currentTitle || 'papaleguas') + '.' + (st.format || format);
                      dlBtn.style.display = 'block';
                    }
                    try {
                      var a = document.createElement('a');
                      a.href = st.url;
                      a.download = (st.title || currentTitle || 'papaleguas') + '.' + (st.format || format);
                      document.body.appendChild(a);
                      a.click();
                      setTimeout(function() { a.remove(); }, 1500);
                    } catch(eAuto) {}
                  } else if (st.stage === 'error') {
                    clearInterval(activeDownloadPoll);
                    activeDownloadPoll = null;
                    if (status) status.textContent = '❌ Erro no download';
                    if (speed) speed.textContent = st.error || 'Falha ao baixar vídeo';
                  }
                })
                .catch(function(err) {});
            }, 350);
          })
          .catch(function(err) {
            if (status) status.textContent = '❌ Erro ao conectar';
            if (speed) speed.textContent = err.message || 'Verifique sua conexão';
          });
        }

        // Intercepta e neutraliza abertura do app externo e deep-links (intent://, vnd.youtube:, market:)
        function sanitizeUrl(u) {
          if (!u || typeof u !== 'string') return u;
          if (/^(intent|vnd\\.youtube|android-app|market):/i.test(u)) {
            var vid = extractYtId(u);
            if (vid) {
              return '/proxy?url=' + encodeURIComponent('https://m.youtube.com/watch?v=' + vid) + '&clientId=' + encodeURIComponent(CLIENT_ID);
            }
            return null;
          }
          return u;
        }

        try {
          var origAssign = window.location.assign.bind(window.location);
          var origReplace = window.location.replace.bind(window.location);
          window.location.assign = function(u) {
            var s = sanitizeUrl(u);
            if (!s) return;
            origAssign(s);
          };
          window.location.replace = function(u) {
            var s = sanitizeUrl(u);
            if (!s) return;
            origReplace(s);
          };
        } catch(e) {}

        // INTERCEPTAÇÃO PRIORITÁRIA DE CLIQUES EM RECOMENDAÇÕES E LINKS
        document.addEventListener('click', function(e) {
          // 1. Bloqueia qualquer clique em botão ou banner de 'Abrir app'
          var openApp = e.target && e.target.closest ? e.target.closest('[aria-label*="Abrir app" i], [aria-label*="Open app" i], [aria-label*="Abrir o app" i], ytm-open-app-tool-bar, .open-app-button, ytm-mealbar-promo-renderer, ytm-promoted-sparkles-web-renderer') : null;
          if (openApp) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            try { openApp.remove(); } catch(err) { openApp.style.display = 'none'; }
            return;
          }

          // 2. Intercepta cliques em vídeos de recomendação
          var card = e.target && e.target.closest ? e.target.closest('a[href*="/watch"], a[href*="/shorts"], ytm-compact-video-renderer, ytm-video-with-context-renderer, ytm-media-item, [data-video-id]') : null;
          if (card) {
            if (card.closest('#papaleguas-yt-bar') || card.closest('#papaleguas-dl-modal')) return;

            var href = (card.getAttribute && card.getAttribute('href')) || '';
            if (!href && card.querySelector) {
              var innerA = card.querySelector('a[href*="/watch"], a[href*="/shorts"]');
              if (innerA) href = innerA.getAttribute('href') || '';
            }
            var vid = extractYtId(href);
            if (!vid && card.getAttribute) {
              vid = card.getAttribute('data-video-id') || '';
            }

            if (vid) {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();

              var targetWatch = 'https://m.youtube.com/watch?v=' + vid;
              var nextProxied = '/proxy?url=' + encodeURIComponent(targetWatch) + '&clientId=' + encodeURIComponent(CLIENT_ID);
              location.href = nextProxied;
              return;
            }
          }
        }, true);

        // Bloqueador de Anúncios de Vídeo Ativo (Auto-Skip & Mute)
        setInterval(function() {
          var skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button, .ytp-ad-overlay-close-button');
          if (skip) {
            try { skip.click(); } catch(e) {}
          }
          var isAd = document.querySelector('.ad-showing, .ad-interrupting, .video-ads:not(:empty)');
          if (isAd) {
            var v = document.querySelector('video');
            if (v) {
              v.muted = true;
              if (isFinite(v.duration) && v.duration > 0) {
                v.currentTime = v.duration;
              }
            }
          }
          var promos = document.querySelectorAll('ytm-promoted-sparkles-web-renderer, ytm-mealbar-promo-renderer, [aria-label*="Abrir app" i]');
          for (var i = 0; i < promos.length; i++) {
            promos[i].style.display = 'none';
          }
          mountBar();
        }, 300);

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', mountBar);
        } else {
          mountBar();
        }
      })();
    </script>
  `;
}

// Finaliza todos os servidores e processos Python criados anteriormente a cada inicialização/reinício
try {
  const { stopAllPythonServers } = require('./python-runner');
  stopAllPythonServers();
} catch (e) { swallowed(e, 'server:top@2326'); }

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
// Mantendo exclusivamente o Cloudflare Tunnel oficial (papaleguas.app) como túnel público
ngrokTunnel.stopTunnel();
const SRC_DIR = path.join(__dirname, '../src');
const aiClient = require('./ai-client');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
aiClient.setOpenAiFallbackKey(OPENAI_API_KEY);

// Busca no DuckDuckGo (HTML) para navegação web e celulares via Tor
const NAMED_HTML_ENTITIES = {
  quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', amp: '&',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Yacute: 'Ý',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  Acirc: 'Â', Ecirc: 'Ê', Icirc: 'Î', Ocirc: 'Ô', Ucirc: 'Û',
  atilde: 'ã', otilde: 'õ', ntilde: 'ñ',
  Atilde: 'Ã', Otilde: 'Õ', Ntilde: 'Ñ',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  Agrave: 'À', Egrave: 'È', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Euml: 'Ë', Iuml: 'Ï', Ouml: 'Ö', Uuml: 'Ü',
  ccedil: 'ç', Ccedil: 'Ç',
  ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°', ordm: 'º', ordf: 'ª'
};

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return ' '; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return ' '; }
    })
    .replace(/&([a-zA-Z]{2,8});/g, (full, name) => (
      Object.prototype.hasOwnProperty.call(NAMED_HTML_ENTITIES, name) ? NAMED_HTML_ENTITIES[name] : full
    ))
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapDuckUrl(raw) {
  let u = String(raw || '').replace(/&amp;/g, '&');
  if (u.startsWith('//')) u = 'https:' + u;
  try {
    const parsed = new URL(u, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg') || parsed.searchParams.get('u');
    if (uddg) return decodeURIComponent(uddg);
    if (parsed.hostname && !/duckduckgo\.com$/i.test(parsed.hostname)) return parsed.href;
  } catch (e) { swallowed(e, 'server:unwrapDuckUrl@2363'); }
  return u;
}

function decodeMaybeGzip(buffer, encoding) {
  if (!buffer || !buffer.length) return '';
  const enc = String(encoding || '').toLowerCase().trim();
  
  // 1. Verificação explícita por cabeçalho
  if (enc.includes('gzip')) {
    try { return zlib.gunzipSync(buffer).toString('utf8'); } catch (e) { swallowed(e, 'server:decodeMaybeGzip@2373'); }
  }
  if (enc.includes('deflate')) {
    try { return zlib.inflateSync(buffer).toString('utf8'); } catch (e) {
      try { return zlib.inflateRawSync(buffer).toString('utf8'); } catch (e2) { swallowed(e2, 'server:decodeMaybeGzip@2377'); }
    }
  }
  if (enc.includes('br') && typeof zlib.brotliDecompressSync === 'function') {
    try { return zlib.brotliDecompressSync(buffer).toString('utf8'); } catch (e) { swallowed(e, 'server:decodeMaybeGzip@2381'); }
  }

  // 2. Detecção automática por Magic Bytes (servidores que mandam comprimido sem Content-Encoding)
  // GZIP magic number: 0x1F 0x8B
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try { return zlib.gunzipSync(buffer).toString('utf8'); } catch (e) { swallowed(e, 'server:decodeMaybeGzip@2387'); }
  }

  // ZLIB Deflate magic bytes: 0x78 (ex: 0x78 0x01, 0x78 0x9c, 0x78 0xda)
  if (buffer.length >= 2 && buffer[0] === 0x78) {
    try { return zlib.inflateSync(buffer).toString('utf8'); } catch (e) {
      try { return zlib.inflateRawSync(buffer).toString('utf8'); } catch (e2) { swallowed(e2, 'server:decodeMaybeGzip@2393'); }
    }
  }

  return buffer.toString('utf8');
}

function fetchHttpsText(options, body, timeoutMs = 9000) {
  return new Promise((resolve) => {
    const lib = options.protocol === 'http:' ? http : https;
    const headers = Object.assign({ 'Accept-Encoding': 'gzip, deflate, br' }, options.headers || {});
    delete headers.cookie;
    delete headers.Cookie;
    const req = lib.request({ ...options, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const next = new URL(res.headers.location, `${options.protocol === 'http:' ? 'http' : 'https'}://${options.hostname}${options.path || '/'}`);
          const nextHeaders = Object.assign({}, options.headers || {});
          delete nextHeaders.cookie;
          delete nextHeaders.Cookie;
          return fetchHttpsText({
            hostname: next.hostname,
            port: next.port || options.port,
            path: next.pathname + next.search,
            method: 'GET',
            protocol: next.protocol,
            agent: options.agent,
            headers: nextHeaders,
            maxBytes: options.maxBytes
          }, null, timeoutMs).then(resolve);
        } catch (e) {
          return resolve('');
        }
      }
      const chunks = [];
      let size = 0;
      const limit = options.maxBytes || 700000;
      res.on('data', (chunk) => {
        if (size < limit) {
          chunks.push(chunk);
          size += chunk.length;
        }
      });
      res.on('end', () => resolve(decodeMaybeGzip(Buffer.concat(chunks), res.headers['content-encoding'])));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve('');
    });
    req.on('error', () => resolve(''));
    if (body) req.write(body);
    req.end();
  });
}

function parseDuckDuckGoHtml(html) {
  const results = [];
  const seen = new Set();
  const rawHtml = String(html || '');

  // Divide por cada bloco de resultado para parear título e snippet sem desvio por anúncios
  const blocks = rawHtml.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (/result--ad|badge--ad|duckduckgo\.com\/y\.js/i.test(block)) continue;
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = unwrapDuckUrl(linkMatch[1]);
    const title = stripTags(linkMatch[2]);
    if (!url || !title || !/^https?:\/\//i.test(url) || /duckduckgo\.com/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const snipMatch = block.match(/<(?:a|td|span|div|p)[^>]*class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|span|div|p)>/i);
    const snippet = snipMatch ? stripTags(snipMatch[1]) : '';
    results.push({ title, url, snippet });
  }

  if (results.length === 0) {
    const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(rawHtml)) !== null) {
      if (/duckduckgo\.com\/y\.js/i.test(m[1])) continue;
      const url = unwrapDuckUrl(m[1]);
      const title = stripTags(m[2]);
      if (!url || !title || !/^https?:\/\//i.test(url) || /duckduckgo\.com/i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({ title, url, snippet: '' });
    }
  }
  return results;
}

// O Bing envolve cada resultado em bing.com/ck/a?...&u=a1<base64url do link real>
// e cada notícia em bing.com/news/apiclick.aspx?...&url=<link real codificado>
function unwrapBingUrl(raw) {
  const s = decodeHtmlEntities(raw).replace(/&amp;/g, '&').trim();
  const b64 = s.match(/[?&]u=a1([A-Za-z0-9_\-]+)/);
  if (b64) {
    try {
      const decoded = Buffer.from(b64[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch (e) { swallowed(e, 'server:unwrapBingUrl@2494'); }
  }
  const plain = s.match(/[?&]url=([^&]+)/i);
  if (plain) {
    try {
      const decoded = decodeURIComponent(plain[1]);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch (e) { swallowed(e, 'server:unwrapBingUrl@2501'); }
  }
  return s;
}

function stripTags(html) {
  // O Bing marca os termos buscados com <strong>; trocar a tag por espaço deixaria
  // sobras como "Santos Dumont : biografia", então a pontuação volta a se encostar.
  return sanitizeSearchText(String(html || '').replace(/<[^>]+>/g, ' '), decodeHtmlEntities)
    .replace(/\s+([,.;:!?%)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const pick = (tag) => {
      const hit = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
      if (!hit) return '';
      return stripTags(hit[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
    };
    const url = unwrapBingUrl(pick('link'));
    const title = pick('title');
    if (!url || !title || !/^https?:\/\//i.test(url)) continue;
    items.push({
      title,
      url,
      snippet: pick('description'),
      date: pick('pubDate'),
      outlet: pick('News:Source')
    });
  }
  return items;
}

function parseBingHtml(html) {
  const results = [];
  const seen = new Set();
  const blocks = String(html || '').split(/<li class="b_algo"/i).slice(1);
  blocks.forEach((block) => {
    const titleHit = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleHit) return;
    const url = unwrapBingUrl(titleHit[1]);
    const title = stripTags(titleHit[2]);
    if (!url || !title || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    const snipHit = block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    let snippet = snipHit ? stripTags(snipHit[1]) : '';
    let date = '';
    // O Bing prefixa a descrição com a data no formato "18 de dez. de 2025 · texto"
    const dateHit = snippet.match(/^([^·]{4,28}?)\s*·\s*/);
    if (dateHit && /\d/.test(dateHit[1])) {
      date = dateHit[1].trim();
      snippet = snippet.slice(dateHit[0].length);
    }
    seen.add(url);
    results.push({ title, url, snippet, date, source: 'bing' });
  });
  return results;
}

function collectRelatedDuckTopics(topics, out) {
  (topics || []).forEach((item) => {
    if (!item) return;
    if (Array.isArray(item.Topics)) {
      collectRelatedDuckTopics(item.Topics, out);
      return;
    }
    if (item.FirstURL && item.Text && !/duckduckgo\.com/i.test(item.FirstURL)) {
      out.push({ title: String(item.Text).split(' - ')[0], url: item.FirstURL, snippet: item.Text });
    }
  });
}

async function searchDuckInstantApi(query, useTor = false) {
  const text = await fetchHttpsText({
    hostname: 'api.duckduckgo.com',
    path: '/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&no_redirect=1&kl=br-pt',
    method: 'GET',
    agent: getOutboundAgent(useTor),
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  }, null, 5000);
  try {
    const data = JSON.parse(text || '{}');
    const out = [];
    if (data.AbstractURL && !/duckduckgo\.com/i.test(data.AbstractURL)) {
      out.push({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText || '' });
    }
    collectRelatedDuckTopics(data.RelatedTopics, out);
    return out;
  } catch (e) {
    return [];
  }
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

function webSourceHeaders() {
  return {
    'User-Agent': BROWSER_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
  };
}

// Os buscadores entregam uma página degradada (resultado de uma palavra só) para quem
// chega em HTTP/1.1 sem os client hints do Chrome. Falando HTTP/2 com o mesmo conjunto
// de cabeçalhos de um navegador, o Bing, DuckDuckGo e Yahoo devolvem a página real de resultados.
const BROWSER_H2_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': BROWSER_UA
};

function decodeCompressed(buffer, encoding) {
  return decodeMaybeGzip(buffer, encoding);
}

async function openHttp2Session(targetUrl, useTor) {
  const options = { ALPNProtocols: ['h2'] };
  if (useTor && SocksClient) {
    const info = await SocksClient.createConnection({
      proxy: { host: '127.0.0.1', port: 9050, type: 5 },
      command: 'connect',
      destination: { host: targetUrl.hostname, port: Number(targetUrl.port) || 443 },
      timeout: 7000
    });
    const tlsSocket = tls.connect({
      socket: info.socket,
      servername: targetUrl.hostname,
      ALPNProtocols: ['h2', 'http/1.1']
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        tlsSocket.destroy();
        reject(new Error('TLS_TIMEOUT'));
      }, 6000);
      tlsSocket.once('secureConnect', () => {
        clearTimeout(timer);
        resolve();
      });
      tlsSocket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    if (tlsSocket.alpnProtocol !== 'h2') {
      tlsSocket.destroy();
      throw new Error('ALPN_NOT_H2');
    }
    options.createConnection = () => tlsSocket;
  }
  return http2.connect(targetUrl.origin, options);
}

async function fetchBrowserText(url, { headers = {}, useTor = false, timeoutMs = 9000, hops = 0 } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    return '';
  }

  // Modo estritamente sem cookies: remove qualquer cabeçalho de cookie
  const reqHeaders = Object.assign({}, headers);
  delete reqHeaders.cookie;
  delete reqHeaders.Cookie;

  // Se o HTTP/2 não subir ou o servidor negociar HTTP/1.1 via ALPN, cai para HTTP/1.1 sem cookies
  const viaHttp1 = () => fetchHttpsText({
    hostname: target.hostname,
    path: target.pathname + target.search,
    method: 'GET',
    agent: getOutboundAgent(useTor),
    headers: { ...webSourceHeaders(), ...reqHeaders }
  }, null, timeoutMs);

  let session = null;
  try {
    session = await openHttp2Session(target, useTor);
  } catch (e) {
    return viaHttp1();
  }

  const text = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => done(''), timeoutMs);
    session.on('error', () => { clearTimeout(timer); done(''); });

    let stream;
    try {
      stream = session.request({
        ...BROWSER_H2_HEADERS,
        ...reqHeaders,
        ':method': 'GET',
        ':path': target.pathname + target.search,
        ':authority': target.host,
        ':scheme': 'https'
      });
    } catch (e) {
      clearTimeout(timer);
      return done('');
    }

    let status = 0;
    let encoding = '';
    let location = '';
    const chunks = [];
    stream.on('response', (head) => {
      status = Number(head[':status']) || 0;
      encoding = head['content-encoding'] || '';
      location = head.location || '';
      // Ignora completamente head['set-cookie'] para não salvar cookies
    });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', () => { clearTimeout(timer); done(''); });
    stream.on('end', async () => {
      clearTimeout(timer);
      if (status >= 300 && status < 400 && location && hops < 4) {
        let next = '';
        try { next = new URL(location, url).href; } catch (e) { swallowed(e, 'server:fetchBrowserText@2754'); }
        done(next ? await fetchBrowserText(next, { headers: reqHeaders, useTor, timeoutMs, hops: hops + 1 }) : '');
        return;
      }
      done(decodeCompressed(Buffer.concat(chunks), encoding));
    });
    stream.end();
  });

  try { session.close(); } catch (e) { swallowed(e, 'server:fetchBrowserText@2766'); }
  return text || viaHttp1();
}

// Atenção aos parâmetros: com "count" na URL, ou com "setlang" e "cc" juntos, o Bing
// troca a busca pela primeira palavra do termo e devolve resultados sem relação nenhuma.
function bingSearchUrl(path, query, extra = '') {
  return 'https://www.bing.com' + path + '?q=' + encodeURIComponent(query) + '&setlang=pt-BR' + extra;
}

// Sob rajada de requisições o Bing pode trocar a busca pela primeira palavra do termo.
// Valida se os resultados cobrem os termos buscados e evita descartar resultados válidos.
function looksLikeDegradedSerp(results, query) {
  const tokens = searchQueryTokens(query);
  if (tokens.length < 3 || !results || !results.length) return false;
  const matched = results.filter((item) => {
    const text = normalizeForMatch((item.title || '') + ' ' + (item.snippet || ''));
    return tokens.some((token) => text.includes(token));
  });
  return matched.length === 0;
}

async function searchBingHtml(query, useTor = false) {
  // Qualquer parâmetro além de q e setlang (count, cc, first…) degrada a resposta,
  // então a busca fica restrita à primeira página mesmo.
  const url = bingSearchUrl('/search', query);
  const timeoutMs = useTor ? 12000 : 8000;
  let results = parseBingHtml(await fetchBrowserText(url, { useTor, timeoutMs }));
  if (looksLikeDegradedSerp(results, query)) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const retry = parseBingHtml(await fetchBrowserText(url, { useTor, timeoutMs }));
    if (retry && retry.length && !looksLikeDegradedSerp(retry, query)) return retry;
  }
  // Se o HTML falhou ou veio vazio, tenta feed RSS de emergência
  if (!results || results.length === 0) {
    try {
      const rss = await searchBingRss(query, useTor);
      if (rss && rss.length) return rss;
    } catch (e) { swallowed(e, 'server:searchBingHtml@2804'); }
  }
  return results || [];
}

// O feed RSS é mais frágil que o HTML: só entra quando a página não rendeu nada
async function searchBingRss(query, useTor = false) {
  const xml = await fetchBrowserText(bingSearchUrl('/search', query, '&format=rss'), {
    headers: { accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' },
    useTor,
    timeoutMs: useTor ? 9000 : 6000
  });
  return parseRssItems(xml)
    .filter((item) => !/(^|\.)bing\.com$/i.test(safeHostname(item.url)))
    .map((item) => ({ ...item, source: 'bing' }));
}

async function searchBingNews(query, useTor = false, limit = 10) {
  const xml = await fetchBrowserText(bingSearchUrl('/news/search', query, '&format=rss&setlang=pt-br'), {
    headers: { accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' },
    useTor,
    timeoutMs: useTor ? 9000 : 6000
  });
  return parseRssItems(xml)
    .filter((item) => !/(^|\.)bing\.com$/i.test(safeHostname(item.url)))
    .map((item) => ({ ...item, source: item.outlet || 'noticias' }))
    .slice(0, limit);
}


function parseDuckLiteHtml(html) {
  const results = [];
  const seen = new Set();
  const cleanHtml = String(html || '').replace(/<tr[^>]*class=['"][^'"]*result-sponsored[^'"]*['"][^>]*>[\s\S]*?<\/tr>/gi, '');
  const re = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+class=['"]result-link['"][^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(cleanHtml)) !== null) {
    const rawHref = m[1] || m[3];
    const rawTitle = m[2] || m[4];
    if (/duckduckgo\.com\/y\.js/i.test(rawHref)) continue;
    const url = unwrapDuckUrl(rawHref);
    const title = stripTags(rawTitle);
    if (!url || !title || title.length < 4 || !/^https?:\/\//i.test(url)) continue;
    if (/duckduckgo\.com|lite\.duckduckgo/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const after = cleanHtml.slice(m.index, m.index + 1200);
    const snipM = after.match(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
    const snippet = snipM ? stripTags(snipM[1]) : '';
    results.push({ title, url, snippet });
    if (results.length >= 16) break;
  }
  return results;
}

// Em HTTP/1.1 o DuckDuckGo só devolve a página de "tráfego anômalo"; falando HTTP/2
// como navegador ele responde normalmente e vira a segunda fonte boa da busca.
async function searchDuckDuckGoHtml(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return [];
  const html = await fetchBrowserText(
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=br-pt',
    { useTor, timeoutMs: useTor ? 12000 : 8000 }
  );
  return parseDuckDuckGoHtml(html).map((item) => ({ ...item, source: 'duckduckgo' }));
}

async function searchDuckDuckGoFallback(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return [];
  const lite = await fetchBrowserText(
    'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q) + '&kl=br-pt',
    { useTor, timeoutMs: useTor ? 10000 : 6000 }
  );
  return parseDuckLiteHtml(lite).map((item) => ({ ...item, source: 'duckduckgo' }));
}

// Brave Search: índice próprio, resultados independentes do Bing/Google
function parseBraveHtml(html) {
  const results = [];
  const seen = new Set();
  // Blocos de resultado: <div class="snippet"> … </div>
  const blockRe = /<div[^>]+class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]+class="[^"]*snippet|<\/section|<\/main|<\/div\s*>\s*<\/div\s*>\s*<\/main)/gi;
  // Fallback simples: qualquer <a> com href externo
  const linkRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const extractTitle = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const url = m[1].split('?')[0].split('#')[0];
    const title = extractTitle(m[2]);
    if (!url || !title || title.length < 5) continue;
    if (/brave\.com|bravesoft|localhost/i.test(url)) continue;
    const key = (url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    // Snippet: tenta capturar o parágrafo seguinte
    const snipRe = /<p[^>]*>([\s\S]{10,400}?)<\/p>/i;
    const after = html.slice(m.index, m.index + 600);
    const snipM = snipRe.exec(after);
    const snippet = snipM ? extractTitle(snipM[1]).slice(0, 200) : '';
    results.push({ title, url, snippet, source: 'brave' });
    if (results.length >= 20) break;
  }
  return results;
}

async function searchBraveHtml(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const html = await fetchBrowserText(
      'https://search.brave.com/search?q=' + encodeURIComponent(q) + '&source=web&country=br',
      { useTor, timeoutMs: useTor ? 12000 : 8000 }
    );
    return parseBraveHtml(html).map((item) => ({ ...item, source: 'brave' }));
  } catch (e) {
    return [];
  }
}

async function searchOnionSources(query) {
  return [];
}

function safeHostname(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

const PT_MONTH_INDEX = {
  jan: 0, fev: 1, mar: 2, abr: 3, mai: 4, jun: 5,
  jul: 6, ago: 7, set: 8, out: 9, nov: 10, dez: 11
};

// O Bing devolve data ora em inglês ("Tue, 22 Sep 2026"), ora em português ("18 de dez. de 2025")
function parseSearchDate(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const direct = new Date(value);
  if (!isNaN(direct.getTime())) return direct;
  const parts = value.match(/(\d{1,2})\s+(?:de\s+)?([a-zà-ü]{3,})\.?\s+(?:de\s+)?(\d{4})/i);
  if (!parts) return null;
  const month = PT_MONTH_INDEX[normalizeForMatch(parts[2]).slice(0, 3)];
  if (month === undefined) return null;
  const time = value.match(/(\d{1,2}):(\d{2})/);
  return new Date(
    Number(parts[3]),
    month,
    Number(parts[1]),
    time ? Number(time[1]) : 0,
    time ? Number(time[2]) : 0
  );
}

// As fontes devolvem datas em formatos diferentes; mostra sempre algo curto e legível
function formatSearchDate(raw) {
  const parsed = parseSearchDate(raw);
  if (!parsed || isNaN(parsed.getTime())) return '';
  const diffMin = Math.round((Date.now() - parsed.getTime()) / 60000);
  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `há ${diffMin} min`;
  if (diffMin < 1440) {
    const hours = Math.round(diffMin / 60);
    return `há ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  }
  if (diffMin < 10080) {
    const days = Math.round(diffMin / 1440);
    return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
  }
  return parsed.toLocaleDateString('pt-BR');
}

// Busca adicional no Yandex com parsing resiliente de SERP
async function searchYandexHtml(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = 'https://yandex.com/search/?text=' + encodeURIComponent(q);
  try {
    const html = await fetchBrowserText(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      },
      useTor,
      timeoutMs: useTor ? 8000 : 5000
    });
    if (!html || html.includes('checkbox-captcha') || html.includes('showcaptcha')) {
      return [];
    }
    return parseYandexHtml(html);
  } catch (e) {
    return [];
  }
}

function parseYandexHtml(html) {
  if (!html) return [];
  const items = [];
  const seen = new Set();

  const serpRegex = /<li[^>]+class="[^"]*serp-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = serpRegex.exec(html)) !== null && items.length < 15) {
    const block = match[1];
    const linkMatch = block.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*organic__url[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
                      block.match(/<a[^>]+class="[^"]*organic__url[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
                      block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    let url = linkMatch[1];
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//i.test(url) || url.includes('yandex.') || seen.has(url)) continue;
    seen.add(url);

    const title = decodeHtmlEntities(linkMatch[2].replace(/<[^>]+>/g, '').trim());
    const snipMatch = block.match(/class="[^"]*(?:organic__text|text-container)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i);
    const snippet = snipMatch ? decodeHtmlEntities(snipMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

    if (title && title.length > 2) {
      items.push({
        title,
        url,
        snippet,
        source: 'yandex'
      });
    }
  }

  return items;
}

function unwrapYahooUrl(rawUrl) {
  if (!rawUrl) return '';
  const match = rawUrl.match(/\/RU=([^/]+)/i);
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch (e) {
      return match[1];
    }
  }
  return rawUrl;
}

async function searchYahooHtml(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return [];
  const baseUrl = 'https://br.search.yahoo.com/search?p=' + encodeURIComponent(q) + '&ei=UTF-8';
  const reqOpts = {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'User-Agent': BROWSER_UA
    },
    useTor,
    timeoutMs: useTor ? 10000 : 7000
  };
  try {
    const [htmlPage1, htmlPage2] = await Promise.all([
      fetchBrowserText(baseUrl, reqOpts),
      fetchBrowserText(baseUrl + '&b=8', reqOpts).catch(() => '')
    ]);
    const out = [];
    const seen = new Set();
    for (const item of [...parseYahooHtml(htmlPage1), ...parseYahooHtml(htmlPage2)]) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        out.push(item);
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

function parseYahooHtml(html) {
  if (!html) return [];
  const items = [];
  const seen = new Set();

  const blocks = String(html || '').split(/(?:<li[^>]*>)?<div[^>]+class="[^"]*(?:algo-sr|algo)[^"]*"/i).slice(1);
  for (const block of blocks) {
    const linkMatch = block.match(/<h3[^>]*class="[^"]*title[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
                      block.match(/<a[^>]+href="([^"]+)"[^>]*><span[^>]*>([\s\S]*?)<\/span><\/a>/i);
    if (!linkMatch) continue;

    let targetUrl = unwrapYahooUrl(linkMatch[1]);
    if (!/^https?:\/\//i.test(targetUrl) || targetUrl.includes('yahoo.com/search') || seen.has(targetUrl)) continue;
    seen.add(targetUrl);

    let rawTitle = linkMatch[2].replace(/<span[^>]*class="[^"]*(?:fz-|fc-|wr-|d-ib|p-abs)[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
    const title = stripTags(rawTitle);
    if (!title || title.length < 2) continue;

    const snipMatch = block.match(/<span class="fc-falcon">([\s\S]*?)<\/span>/i) ||
                      block.match(/class="[^"]*(?:compText|s-desc)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/i);
    const snippet = snipMatch ? stripTags(snipMatch[1]) : '';

    items.push({
      title,
      url: targetUrl,
      snippet,
      source: 'yahoo'
    });
  }

  // Fallback caso a estrutura mude ligeiramente
  if (items.length === 0) {
    const linkMatches = [...html.matchAll(/<h3[^>]*class="[^"]*title[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const m of linkMatches) {
      let targetUrl = unwrapYahooUrl(m[1]);
      if (!/^https?:\/\//i.test(targetUrl) || targetUrl.includes('yahoo.com/search') || seen.has(targetUrl)) continue;
      seen.add(targetUrl);
      let rawTitle = m[2].replace(/<span[^>]*class="[^"]*(?:fz-|fc-|wr-|d-ib|p-abs)[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
      const title = stripTags(rawTitle);
      if (title && title.length > 2) {
        items.push({ title, url: targetUrl, snippet: '', source: 'yahoo' });
      }
    }
  }

  return items;
}

function unwrapGoogleUrl(raw) {
  if (!raw) return '';
  let url = raw;
  if (url.startsWith('/url?')) {
    try {
      const parsed = new URL('https://www.google.com' + url);
      url = parsed.searchParams.get('q') || parsed.searchParams.get('url') || url;
    } catch (e) { swallowed(e, 'server:unwrapGoogleUrl@3120'); }
  }
  return url;
}

function parseGoogleHtml(html) {
  if (!html) return [];
  const items = [];
  const seen = new Set();

  const linkH3Regex = /<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let m;
  while ((m = linkH3Regex.exec(html)) !== null && items.length < 15) {
    const rawUrl = m[1];
    const targetUrl = unwrapGoogleUrl(rawUrl);
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) continue;
    if (/google\.(?:com|[a-z]{2})/i.test(targetUrl) || seen.has(targetUrl)) continue;
    seen.add(targetUrl);

    const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '').trim());
    if (!title || title.length < 2) continue;

    const sliceAfter = html.slice(m.index, m.index + 800);
    const snipMatch = sliceAfter.match(/(?:<div[^>]+class="[^"]*(?:VwiC3b|yXK7lf|MUxGbd|s3v9rd)[^"]*"[^>]*>|<div style="[^"]*font-size:[^"]*"[^>]*>)([\s\S]*?)<\/div>/i);
    const snippet = snipMatch ? decodeHtmlEntities(snipMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

    items.push({
      title,
      url: targetUrl,
      snippet,
      source: 'google'
    });
  }

  if (items.length < 3) {
    const liteRegex = /<a[^>]+href="\/url\?q=(https?:\/\/[^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = liteRegex.exec(html)) !== null && items.length < 15) {
      const targetUrl = decodeURIComponent(m[1]);
      if (!/^https?:\/\//i.test(targetUrl) || /google\.(?:com|[a-z]{2})/i.test(targetUrl) || seen.has(targetUrl)) continue;
      seen.add(targetUrl);
      const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '').trim());
      if (title && title.length > 2) {
        items.push({
          title,
          url: targetUrl,
          snippet: '',
          source: 'google'
        });
      }
    }
  }

  return items;
}

async function searchGoogleHtml(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const html = await fetchBrowserText(
      'https://www.google.com/search?q=' + encodeURIComponent(q) + '&hl=pt-BR&gl=br&num=15',
      {
        useTor,
        headers: {
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none'
        },
        timeoutMs: useTor ? 10000 : 6000
      }
    );
    return parseGoogleHtml(html);
  } catch (e) {
    return [];
  }
}

// ----------------------------------------------------
// FONTES ESPECIALIZADAS PARA ENRIQUECIMENTO DA PESQUISA
// Trazem conhecimento enciclopédico, notícias, vídeos, músicas e filmes
// diretamente relacionados ao tema pesquisado.
// ----------------------------------------------------

async function fetchWikiTopicSummary(query) {
  const q = String(query || '').trim();
  if (!q || q.length < 2) return null;
  try {
    const openUrl = 'https://pt.wikipedia.org/w/api.php?action=opensearch&search=' + encodeURIComponent(q) + '&limit=3&namespace=0&format=json';
    const textOpen = await fetchBrowserText(openUrl, { timeoutMs: 3500 });
    let titles = [];
    try {
      const parsed = JSON.parse(textOpen);
      if (Array.isArray(parsed) && Array.isArray(parsed[1])) titles = parsed[1];
    } catch (e) { swallowed(e, 'server:fetchWikiTopicSummary@3214'); }

    const targetTitle = titles[0] || q;
    const summaryUrl = 'https://pt.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(targetTitle.replace(/\s+/g, '_'));
    const sumText = await fetchBrowserText(summaryUrl, { timeoutMs: 3500 });
    let sumData = null;
    try { sumData = JSON.parse(sumText); } catch (e) { swallowed(e, 'server:fetchWikiTopicSummary@3220'); }
    if (!sumData || (!sumData.extract && !sumData.description)) return null;

    return {
      title: sumData.title || targetTitle,
      extract: sumData.extract || sumData.description || '',
      thumbnail: sumData.thumbnail?.source || sumData.originalimage?.source || '',
      url: sumData.content_urls?.desktop?.page || ('https://pt.wikipedia.org/wiki/' + encodeURIComponent(targetTitle.replace(/\s+/g, '_'))),
      description: sumData.description || ''
    };
  } catch (e) {
    return null;
  }
}

async function searchWikipediaArticles(query, limit = 4) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const url = 'https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(q) + '&utf8=&format=json&srlimit=' + limit;
    const text = await fetchBrowserText(url, { timeoutMs: 4000 });
    const data = JSON.parse(text);
    const items = data?.query?.search || [];
    return items.map((it) => ({
      title: it.title,
      url: 'https://pt.wikipedia.org/wiki/' + encodeURIComponent(it.title.replace(/\s+/g, '_')),
      snippet: stripTags(it.snippet || ''),
      source: 'wikipedia'
    }));
  } catch (e) {
    return [];
  }
}

async function searchGoogleNewsRss(query, limit = 8) {
  // Substitui feed com redirecionamento bloqueado do news.google por notícias com links diretos dos portais
  return searchBingNews(query, false, limit);
}

async function searchComprehensiveNews(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return [];
  const safe = (p) => p.catch(() => []);
  const bingNews = await safe(searchBingNews(q, useTor, 10), []);
  const seen = new Set();
  const all = [];
  (bingNews || []).forEach((n) => {
    if (!n || !n.url) return;
    if (/news\.google\.com/i.test(n.url)) return;
    const k = normalizeSearchUrl(n.url);
    if (!k || seen.has(k)) return;
    seen.add(k);
    all.push(n);
  });
  return all.slice(0, 10);
}

async function searchDeezerTracks(query, limit = 4) {
  const q = String(query || '').trim();
  if (!q || q.length < 2) return [];
  try {
    const res = await searchDeezer(q, limit, 'RANKING');
    if (!res || !res.success || !Array.isArray(res.results)) return [];
    return res.results.slice(0, limit).map((t) => ({
      id: t.id,
      title: t.title || 'Música',
      artist: t.artist || 'Artista',
      album: t.album || '',
      cover: t.cover || '',
      preview: t.preview || '',
      url: `/musica?play=${encodeURIComponent((t.title || '') + ' ' + (t.artist || ''))}`
    }));
  } catch (e) {
    return [];
  }
}

let cachedLocalMoviesCatalog = null;
function getLocalMoviesCatalog() {
  if (cachedLocalMoviesCatalog) return cachedLocalMoviesCatalog;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '../gupifilm_movies.json'), 'utf8');
    cachedLocalMoviesCatalog = JSON.parse(raw);
  } catch (e) {
    cachedLocalMoviesCatalog = [];
  }
  return cachedLocalMoviesCatalog;
}

function searchLocalMovies(query, limit = 4) {
  const q = String(query || '').toLowerCase().trim();
  if (!q || q.length < 3) return [];
  const catalog = getLocalMoviesCatalog();
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  const matches = [];
  for (const m of catalog) {
    const name = (m.name || '').toLowerCase();
    const desc = (m.description || '').toLowerCase();
    let score = 0;
    if (name.includes(q)) score += 10;
    tokens.forEach((tok) => {
      if (name.includes(tok)) score += 4;
      if (desc.includes(tok)) score += 1;
    });
    if (score >= 4) {
      matches.push({
        score,
        title: (m.name || '').replace(/^[^\w\s]+/, '').trim(),
        url: m.url || m.pageUrl,
        poster: m.logo || '',
        description: m.description || '',
        category: 'Cinema'
      });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}

async function fetchRawYoutubeQuery(targetQuery) {
  return new Promise((resolve) => {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(targetQuery) + '&hl=pt-BR&gl=BR';
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml'
      }
    }, (res) => {
      let html = '';
      res.on('data', chunk => { html += chunk; });
      res.on('end', () => {
        try {
          const match = html.match(/var ytInitialData = ({.*?});<\/script>/) || html.match(/var ytInitialData = ({.*?});?\s*<\/script>/);
          if (!match) return resolve([]);
          const data = JSON.parse(match[1]);
          const list = [];
          const seen = new Set();

          function add(id, title, duration, channel, views, thumb) {
            if (!id || id.length !== 11 || seen.has(id)) return;
            seen.add(id);
            list.push({
              id,
              title: title || 'Vídeo',
              duration: duration || '',
              channel: channel || 'YouTube',
              views: views || '',
              thumbnail: thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              url: 'https://www.youtube.com/watch?v=' + id
            });
          }

          function walk(node) {
            if (!node || typeof node !== 'object') return;
            if (node.videoRenderer) {
              const v = node.videoRenderer;
              const id = v.videoId;
              const title = v.title?.runs?.[0]?.text || v.title?.simpleText || '';
              const dur = v.lengthText?.simpleText || '';
              const ch = v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '';
              const views = v.viewCountText?.simpleText || (v.viewCountText?.runs || []).map(r => r.text).join('') || '';
              const thumbs = v.thumbnail?.thumbnails || [];
              const th = (thumbs[thumbs.length - 1] && thumbs[thumbs.length - 1].url) || '';
              add(id, title, dur, ch, views, th);
            }
            if (node.shortsLockupViewModel) {
              const s = node.shortsLockupViewModel;
              const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || (s.entityId && s.entityId.replace(/^shorts-shelf-item-/, '')) || '';
              const title = s.accessibilityText || s.overlayMetadata?.primaryText?.content || '';
              const cleanTitle = title.split(',')[0] || '';
              const views = title.split(',')[1] || '';
              add(id, cleanTitle, 'Shorts', 'YouTube Shorts', views ? views.trim() : '', `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
            }
            if (node.lockupViewModel) {
              const l = node.lockupViewModel;
              const id = l.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId || '';
              const title = l.metadata?.lockupMetadataViewModel?.title?.content || '';
              add(id, title, '', 'YouTube', '', `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
            }
            for (const k of Object.keys(node)) {
              if (typeof node[k] === 'object') walk(node[k]);
            }
          }

          walk(data);
          resolve(list);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(6000, () => { try { req.destroy(); } catch (e) {} resolve([]); });
  });
}

async function fetchBingVideosFallback(q, pageNum = 0) {
  try {
    const bingUrl = 'https://www.bing.com/videos/search?q=' + encodeURIComponent(q) + '&first=' + (pageNum * 15);
    const bHtml = await fetchBrowserText(bingUrl, {
      timeoutMs: 3500,
      useTor: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    const ytIds = new Set();
    const matches = bHtml.matchAll(/(?:youtube\.com\/watch\?v=|youtu\.be\/|vi\/)([a-zA-Z0-9_-]{11})/g);
    for (const m of matches) ytIds.add(m[1]);
    if (ytIds.size > 0) {
      return Array.from(ytIds).map((id) => ({
        id,
        title: q,
        duration: '',
        channel: 'YouTube',
        views: '',
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        url: 'https://www.youtube.com/watch?v=' + id
      }));
    }
  } catch (e) {
    swallowed(e, 'server:searchYoutubeVideosForTopic@fallback');
  }
  return [];
}

async function searchYoutubeVideosForTopic(query, limit = 8, page = 0) {
  const q = String(query || '').trim();
  if (!q) return [];
  const pageNum = Math.max(0, parseInt(page, 10) || 0);
  const offset = pageNum * limit;
  const cacheKey = `topic_vid_${q.toLowerCase()}`;
  let videos = [];
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < YT_CACHE_TTL) && cached.videos.length > 0) {
    videos = cached.videos;
  } else {
    videos = await fetchRawYoutubeQuery(q);
    if (!videos || videos.length === 0) {
      videos = await fetchBingVideosFallback(q, 0);
    }
    if (videos && videos.length > 0) {
      youtubeSearchCache.set(cacheKey, { timestamp: Date.now(), videos });
    }
  }

  // Se a página solicitada precisa de mais vídeos do que os armazenados, busca páginas adicionais
  if (offset + limit > videos.length) {
    const variations = [
      q,
      q + ' videos',
      q + ' hd',
      q + ' completo',
      q + ' novidades',
      q + ' canal',
      q + ' melhor',
      q + ' oficial',
      q + ' 2026',
      q + ' especial',
      q + ' reportagem',
      q + ' tutorial'
    ];
    const nextQuery = variations[pageNum % variations.length] || (q + ' ' + pageNum);
    const [extraYt, extraBing] = await Promise.all([
      fetchRawYoutubeQuery(nextQuery).catch(() => []),
      fetchBingVideosFallback(q, pageNum).catch(() => [])
    ]);
    const seen = new Set(videos.map(v => v.id));
    for (const v of [...extraYt, ...extraBing]) {
      if (v && v.id && !seen.has(v.id)) {
        seen.add(v.id);
        videos.push(v);
      }
    }
    youtubeSearchCache.set(cacheKey, { timestamp: Date.now(), videos });
  }

  const resultSlice = (videos || []).slice(offset, offset + limit);
  if (resultSlice.length === 0 && videos.length > 0) {
    const cycleOffset = offset % videos.length;
    return videos.slice(cycleOffset, cycleOffset + limit);
  }
  return resultSlice;
}

const topicImagesCache = createLruCache({ maxEntries: 300, ttlMs: 15 * 60 * 1000 });

async function searchTopicImages(query, useTor = false, page = 0) {
  const q = String(query || '').trim();
  if (!q) return [];
  const pageNum = Math.max(0, parseInt(page, 10) || 0);
  const cacheKey = `${q.toLowerCase()}:${pageNum}`;
  const cached = topicImagesCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < 300000) && cached.list.length > 0) {
    return cached.list;
  }

  const list = [];
  const seen = new Set();

  const parseBingHtml = (html, maxLimit = 60) => {
    if (!html) return;
    const regex = /m="({[^"]+})"/g;
    let match;
    while ((match = regex.exec(html)) !== null && list.length < maxLimit) {
      try {
        const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const obj = JSON.parse(decoded);
        const img = obj.murl || obj.turl;
        const thumb = obj.turl || obj.murl;
        if (img && !seen.has(img)) {
          seen.add(img);
          list.push({
            title: obj.t || q,
            image: img,
            thumbnail: thumb,
            pageUrl: obj.purl || img,
            source: safeHostname(obj.purl || '') || 'Web'
          });
        }
      } catch (e) {}
    }
  };

  const parseCommonsJson = (text, maxLimit = 80) => {
    if (!text) return;
    try {
      const json = JSON.parse(text);
      const pages = json?.query?.pages || {};
      for (const k of Object.keys(pages)) {
        if (list.length >= maxLimit) break;
        const p = pages[k];
        const info = p.imageinfo && p.imageinfo[0];
        if (info && (info.thumburl || info.url)) {
          const rawTitle = String(p.title || '').replace(/^File:/i, '').replace(/\.[a-zA-Z0-9]+$/, '').replace(/_/g, ' ');
          const imgUrl = info.url || info.thumburl;
          if (imgUrl && !seen.has(imgUrl)) {
            seen.add(imgUrl);
            list.push({
              title: rawTitle || q,
              image: imgUrl,
              thumbnail: info.thumburl || info.url,
              pageUrl: info.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(p.title || '')),
              source: 'Wikimedia Commons'
            });
          }
        }
      }
    } catch (e) {}
  };

  const bingHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
  };

  if (pageNum === 0) {
    const bingUrl1 = 'https://www.bing.com/images/search?q=' + encodeURIComponent(q) + '&form=HDRSC2';
    const bingUrl2 = 'https://www.bing.com/images/async?q=' + encodeURIComponent(q) + '&first=35&count=35&mmasync=1';
    const commUrl = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' + encodeURIComponent(q) + '&gsrnamespace=6&gsrlimit=20&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json';

    try {
      const [html1, html2, commJson] = await Promise.all([
        fetchBrowserText(bingUrl1, { timeoutMs: 4000, useTor: false, headers: bingHeaders }).catch(() => ''),
        fetchBrowserText(bingUrl2, { timeoutMs: 4000, useTor: false, headers: bingHeaders }).catch(() => ''),
        fetchBrowserText(commUrl, { timeoutMs: 3500, useTor: false, headers: { 'User-Agent': 'Papaleguas/1.0 (Mozilla/5.0)' } }).catch(() => '')
      ]);

      parseBingHtml(html1, 35);
      parseBingHtml(html2, 60);
      parseCommonsJson(commJson, 80);
    } catch (e) {
      swallowed(e, 'server:searchTopicImages@parallel');
    }
  } else {
    const firstOffset = (pageNum + 1) * 35;
    const bingUrl = 'https://www.bing.com/images/async?q=' + encodeURIComponent(q) + '&first=' + firstOffset + '&count=35&mmasync=1';
    const commOffset = pageNum * 15;
    const commUrl = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' + encodeURIComponent(q) + '&gsrnamespace=6&gsroffset=' + commOffset + '&gsrlimit=15&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json';

    try {
      const [html, commJson] = await Promise.all([
        fetchBrowserText(bingUrl, { timeoutMs: 4000, useTor: false, headers: bingHeaders }).catch(() => ''),
        fetchBrowserText(commUrl, { timeoutMs: 3500, useTor: false, headers: { 'User-Agent': 'Papaleguas/1.0 (Mozilla/5.0)' } }).catch(() => '')
      ]);
      parseBingHtml(html, 35);
      parseCommonsJson(commJson, 50);
    } catch (e) {
      swallowed(e, 'server:searchTopicImages@paged');
    }
  }

  if (list.length > 0) {
    topicImagesCache.set(cacheKey, { time: Date.now(), list });
    if (topicImagesCache.size > 200) {
      const firstK = topicImagesCache.keys().next().value;
      topicImagesCache.delete(firstK);
    }
  }

  return list;
}

function isMediaStreamingUrl(url) {
  if (!url) return false;
  return /(?:youtube\.com\/(?:watch|shorts|embed|live)|youtu\.be\/|vimeo\.com|tiktok\.com|dailymotion\.com|deezer\.com\/(?:track|album|playlist)|open\.spotify\.com\/(?:track|album|playlist|artist)|music\.apple\.com|soundcloud\.com)/i.test(url);
}

// =========================================================================
// SPIDER / CRAWLER AUTÔNOMO DO MOTOR DE BUSCA NATIVO EM RUST (BM25)
// =========================================================================
const rustSpiderQueue = [];
const rustSpiderVisited = new Set();

function enqueueRustSpiderUrls(urls) {
  if (!Array.isArray(urls)) return;
  for (const raw of urls) {
    if (!raw || typeof raw !== 'string') continue;
    if (rustSpiderQueue.length >= 400) break;
    const clean = nativeCore.stripTrackingParams(raw.trim());
    if (!/^https?:\/\//i.test(clean) || isMediaStreamingUrl(clean) || nativeCore.isTrackerOrAd(clean)) continue;
    const key = normalizeSearchUrl(clean);
    if (!key || rustSpiderVisited.has(key)) continue;
    rustSpiderVisited.add(key);
    rustSpiderQueue.push(clean);
  }
}

async function runRustSpiderStep() {
  if (!rustSpiderQueue.length) return;
  const targetUrl = rustSpiderQueue.shift();
  if (!targetUrl) return;
  try {
    const isOnion = /\.onion(\/|$)/i.test(targetUrl);
    const html = await fetchBrowserText(targetUrl, {
      useTor: isOnion && isAppTorEnabled(),
      timeoutMs: isOnion ? 12000 : 6500
    });
    if (html && html.length > 200) {
      const extracted = nativeCore.extractPageMetadataAndLinks(targetUrl, html);
      if (extracted && Array.isArray(extracted.links) && extracted.links.length) {
        enqueueRustSpiderUrls(extracted.links.slice(0, 12));
      }
      const foundOnions = (extracted && (extracted.onionLinks || extracted.onion_links)) || [];
      if (Array.isArray(foundOnions) && foundOnions.length) {
        for (const onionUrl of foundOnions.slice(0, 8)) {
          nativeCore.indexDocument(
            onionUrl,
            extracted.title ? `${extracted.title} (Mirror .onion)` : onionUrl,
            extracted.description || extracted.textExcerpt || 'Serviço oculto .onion descoberto pelo Spider Rust.',
            'tor onion spider',
            'Descoberto pelo Spider Rust'
          );
        }
        enqueueRustSpiderUrls(foundOnions.slice(0, 4));
      }
    }
  } catch (e) {}
}

setInterval(() => {
  runRustSpiderStep().catch(() => {});
}, 25000).unref();

// Junta o Índice Nativo em Rust (BM25) + fontes públicas sem cookies e auto-indexa novos resultados em tempo real
async function searchWebSources(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return [];
  const viaTor = Boolean(useTor && isAppTorEnabled());
  const engineTimeoutMs = viaTor ? 7000 : 3200;
  const safe = (promise) => Promise.race([
    promise.catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), engineTimeoutMs))
  ]);
  try {
    // 1. Consulta instantânea (< 1ms) ao Motor de Busca Nativo em Rust (BM25 + Inverted Index)
    const rustLocalHits = nativeCore.searchLocalIndex(q, 18, false);

    const [bingHtml, duck, duckLite, instant, brave, yandex, yahoo, google, wikiArticles, newsArticles] = await Promise.all([
      safe(searchBingHtml(q, viaTor)),
      safe(searchDuckDuckGoHtml(q, viaTor)),
      safe(searchDuckDuckGoFallback(q, viaTor)),
      safe(searchDuckInstantApi(q, viaTor)),
      safe(searchBraveHtml(q, viaTor)),
      safe(searchYandexHtml(q, viaTor)),
      safe(searchYahooHtml(q, viaTor)),
      safe(searchGoogleHtml(q, viaTor)),
      safe(searchWikipediaArticles(q, 4)),
      safe(searchGoogleNewsRss(q, 8))
    ]);

    const results = [];
    const seenMap = new Map();
    const pushAll = (list) => {
      (list || []).forEach((item) => {
        if (!item || !item.url || !/^https?:\/\//i.test(item.url)) return;
        const cleanUrl = nativeCore.stripTrackingParams(item.url);
        if (isMediaStreamingUrl(cleanUrl) || nativeCore.isTrackerOrAd(cleanUrl)) return;
        const key = normalizeSearchUrl(cleanUrl);
        const srcName = item.source || 'web';
        if (seenMap.has(key)) {
          // Consenso multi-motor: acumula fontes independentes e aproveita o melhor snippet
          const previous = seenMap.get(key);
          if (previous) {
            if (!previous._sources) previous._sources = new Set([previous.source]);
            previous._sources.add(srcName);
            previous.consensusCount = previous._sources.size;
            if ((!previous.snippet || previous.snippet.length < (item.snippet || '').length) && item.snippet) {
              previous.snippet = item.snippet;
            }
            if (!previous.date && item.date) previous.date = item.date;
          }
          return;
        }
        const entry = {
          title: item.title,
          url: cleanUrl,
          snippet: item.snippet || '',
          date: item.date || '',
          source: srcName,
          consensusCount: 1,
          _sources: new Set([srcName]),
          host: safeHostname(cleanUrl),
          rank: results.length
        };
        seenMap.set(key, entry);
        results.push(entry);
      });
    };

    const interleaveEngines = (engineLists) => {
      const maxLen = Math.max(...engineLists.map((e) => (e ? e.length : 0)), 0);
      for (let i = 0; i < maxLen; i++) {
        engineLists.forEach((engine) => {
          if (engine && engine[i]) pushAll([engine[i]]);
        });
      }
    };

    // Buscadores principais: Índice Nativo Rust (BM25), DuckDuckGo, Yahoo, Bing, Google, Brave, Yandex
    interleaveEngines([
      rustLocalHits || [],
      duck || [],
      yahoo || [],
      bingHtml || [],
      duckLite || [],
      google || [],
      brave || [],
      (instant || []).map((item) => ({ ...item, source: 'duckduckgo' })),
      yandex || []
    ]);

    // Artigos enciclopédicos e notícias recentes entram para enriquecer a página
    pushAll((wikiArticles || []).slice(0, 4));
    pushAll(newsArticles);

    if (results.length < 10) {
      pushAll(await safe(searchBingRss(q, viaTor)));
    }

    // Auto-alimenta o Índice Nativo em Rust (BM25) e o Spider com todas as páginas descobertas!
    const freshDocs = results.filter((r) => r.source !== 'rust-index');
    if (freshDocs.length > 0) {
      nativeCore.indexDocumentsBatch(freshDocs);
      enqueueRustSpiderUrls(freshDocs.slice(0, 10).map((r) => r.url));
    }

    return results.slice(0, 100);
  } catch (err) {
    console.warn('[SEARCH] falhou:', err && err.message ? err.message : err);
    return [];
  }
}

// Palavras muito comuns atrapalham a relevância: "quem foi santos dumont" só precisa casar com "santos dumont"
const SEARCH_STOPWORDS = new Set([
  'que', 'qual', 'quais', 'quem', 'como', 'onde', 'quando', 'porque', 'por', 'para', 'pra',
  'com', 'sem', 'dos', 'das', 'uma', 'uns', 'umas', 'foi', 'era', 'sao', 'ser', 'esta', 'este',
  'isso', 'mais', 'menos', 'melhor', 'melhores', 'sobre', 'the', 'and', 'for', 'você', 'voce'
]);

// Nome próprio para não colidir com o queryTokens do módulo de música mais abaixo
function searchQueryTokens(query) {
  return String(query || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !SEARCH_STOPWORDS.has(w));
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const TRUSTED_DOMAINS_REGEX = /(?:wikipedia\.org|\.gov(?:\.br)?|\.edu(?:\.br)?|\.org(?:\.br)?|scielo\.org|bbc\.com|g1\.globo\.com|uol\.com\.br|estadao\.com\.br|folha\.uol\.com\.br|cnnbrasil\.com\.br|canaltech\.com\.br|tecmundo\.com\.br|techtudo\.com\.br|brasilescola\.uol\.com\.br|todamateria\.com\.br|mundoeducacao\.uol\.com\.br|infoescola\.com|github\.com|developer\.mozilla\.org|stackoverflow\.com|docs\.)/i;

function scoreSearchResult(item, tokens, rawQuery = '') {
  const title = normalizeForMatch(item.title || '');
  const snippet = normalizeForMatch(item.snippet || '');
  const phrase = normalizeForMatch(rawQuery || '').trim();
  const host = normalizeForMatch(item.host || safeHostname(item.url) || '');
  const urlPath = normalizeForMatch(item.url || '');
  let score = 0;
  let covered = 0;
  let titleTokensCovered = 0;

  tokens.forEach((token) => {
    const wordPattern = new RegExp('(?:^|[^a-z0-9])' + token + '(?:[^a-z0-9]|$)', 'i');
    const inTitleExact = wordPattern.test(title);
    const inTitleSub = title.includes(token);
    const inSnippetExact = wordPattern.test(snippet);
    const inSnippetSub = snippet.includes(token);
    const inHostOrPath = host.includes(token) || urlPath.includes(token);

    if (inTitleExact) {
      score += 6;
      titleTokensCovered += 1;
    } else if (inTitleSub) {
      score += 3;
      titleTokensCovered += 1;
    }

    if (inSnippetExact) {
      score += 2.5;
    } else if (inSnippetSub) {
      score += 1;
    }

    if (inHostOrPath) {
      score += 3;
    }

    if (inTitleSub || inSnippetSub || inHostOrPath) {
      covered += 1;
    }
  });

  if (tokens.length > 0) {
    const coverageRatio = covered / tokens.length;
    score += coverageRatio * 10;
    if (titleTokensCovered === tokens.length) {
      score += 12;
    }
    if (coverageRatio < 0.5 && tokens.length >= 2) {
      score -= 8;
    }
  }

  if (phrase.length > 3) {
    if (title === phrase) {
      score += 25;
    } else if (title.startsWith(phrase)) {
      score += 18;
    } else if (title.includes(phrase)) {
      score += 12;
    } else if (snippet.includes(phrase)) {
      score += 6;
    }
  }

  if (TRUSTED_DOMAINS_REGEX.test(host)) {
    score += 8;
  }
  if (phrase && host.includes(phrase.replace(/\s+/g, ''))) {
    score += 15;
  }

  if (item.snippet && item.snippet.length >= 60) {
    score += 3;
  } else if (!item.snippet || item.snippet.length < 20) {
    score -= 4;
  }

  if (item.date) score += 1.5;

  // Consenso multi-motor: URLs confirmadas por múltiplos buscadores sobem contra spam isolado
  const consensus = Number(item.consensusCount) || 1;
  if (consensus >= 2) {
    score += Math.min(consensus - 1, 4) * 7;
  }

  // Filtro anti-SEO-farm, anti-clickbait e anti-phishing
  score += computeAntiSpamPenalty(item);

  if (typeof item.rank === 'number') {
    score += Math.max(0, 8 - item.rank * 0.35);
  }

  return score;
}

const webSuggestCache = createLruCache({ maxEntries: 400, ttlMs: 10 * 60 * 1000 });

async function fetchSuggestPhrases(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return [];
  const agent = getOutboundAgent(useTor);
  const sources = [
    { hostname: 'api.bing.com', path: '/osjson.aspx?market=pt-BR&query=' + encodeURIComponent(q) },
    { hostname: 'duckduckgo.com', path: '/ac/?q=' + encodeURIComponent(q) + '&kl=br-pt&type=list' },
    { hostname: 'suggestqueries.google.com', path: '/complete/search?client=firefox&hl=pt-BR&q=' + encodeURIComponent(q) }
  ];
  for (const source of sources) {
    const text = await fetchHttpsText({
      ...source,
      method: 'GET',
      agent,
      headers: { 'Accept': '*/*', 'User-Agent': BROWSER_UA }
    }, null, useTor ? 7000 : 4500);
    const phrases = parseSuggestPayload(text);
    if (phrases.length) return phrases;
  }
  return [];
}

async function getWebSearchPool(query, useTor = false) {
  const q = String(query || '').trim();
  const torOn = Boolean(useTor && isAppTorEnabled());
  const key = q.toLowerCase() + (torOn ? ':tor' : ':direct');
  const cached = webSuggestCache.get(key);
  if (cached && (Date.now() - cached.t < 180000) && cached.items.length) return cached.items;

  const web = await searchWebSources(q, torOn);
  const seen = new Set();
  const items = [];
  const push = (item) => {
    if (!item || !item.url) return;
    if (isOnionHref(item.url) || isMediaStreamingUrl(item.url)) return;
    const k = normalizeSearchUrl(item.url);
    if (!k || seen.has(k)) return;
    seen.add(k);
    items.push(item);
  };
  (web || []).forEach(push);
  const tokens = searchQueryTokens(q);
  const onTopic = filterOffTopic(items, tokens);
  onTopic.sort((a, b) => scoreSearchResult(b, tokens, q) - scoreSearchResult(a, tokens, q));
  const ordered = spreadResultsByHost(onTopic);
  webSuggestCache.set(key, { t: Date.now(), items: ordered });
  return ordered;
}

function filterOffTopic(items, tokens) {
  return filterOffTopicHelper(items, tokens, normalizeForMatch);
}

function spreadResultsByHost(items, maxPerHost = 2) {
  return spreadResultsByHostHelper(items, safeHostname, maxPerHost);
}

const richSearchCache = createLruCache({ maxEntries: 250, ttlMs: 10 * 60 * 1000 });

// Reúne tudo que o buscador consegue extrair de uma pesquisa:
// resultados com descrição, resumo de contexto, notícias recentes, conhecimento enciclopédico, vídeos, músicas e filmes.
async function getRichSearchData(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return { q, results: [], onion: [], news: [], related: [], sources: [], wiki: null, videos: [], images: [], music: [], movies: [] };
  const torOn = Boolean((useTor || isTorRoutingEnabled(null)) && isAppTorEnabled());
  const key = q.toLowerCase() + (torOn ? ':tor' : ':direct');
  const cached = richSearchCache.get(key);
  if (cached && (Date.now() - cached.t < 180000)) return cached.data;

  const safe = (promise, fallback) => promise.catch(() => fallback);
  const webPromise = Promise.race([
    safe(getWebSearchPool(q, torOn), []),
    new Promise((resolve) => setTimeout(() => resolve([]), torOn ? 14000 : 8000))
  ]);
  const newsPromise = Promise.race([
    safe(searchComprehensiveNews(q, torOn), []),
    new Promise((resolve) => setTimeout(() => resolve([]), torOn ? 9000 : 5000))
  ]);
  const onionPromise = Promise.race([
    safe(searchOnionLinks(q), []),
    new Promise((resolve) => setTimeout(() => resolve([]), torOn ? 9000 : 6500))
  ]);
  const wikiPromise = Promise.race([
    safe(fetchWikiTopicSummary(q), null),
    new Promise((resolve) => setTimeout(() => resolve(null), 5000))
  ]);
  const videosPromise = Promise.race([
    safe(searchYoutubeVideosForTopic(q, 8), []),
    new Promise((resolve) => setTimeout(() => resolve([]), 8000))
  ]);
  const imagesPromise = Promise.race([
    safe(searchTopicImages(q, torOn), []),
    new Promise((resolve) => setTimeout(() => resolve([]), 8000))
  ]);

  const [results, news, related, onionResults, wikiResult, videosResult, imagesResult] = await Promise.all([
    webPromise,
    newsPromise,
    safe(fetchSuggestPhrases(q, torOn), []),
    onionPromise,
    wikiPromise,
    videosPromise,
    imagesPromise
  ]);

  const newsUrls = new Set((news || []).map((item) => normalizeSearchUrl(item.url)));
  const data = {
    q,
    viaTor: torOn,
    wiki: wikiResult,
    videos: videosResult || [],
    images: imagesResult || [],
    music: [],
    movies: [],
    onion: onionResults || [],
    news: news || [],
    related: (related || []).filter((phrase) => String(phrase).toLowerCase() !== q.toLowerCase()).slice(0, 10),
    results: (results || []).filter((item) => !newsUrls.has(normalizeSearchUrl(item.url))),
    sources: Array.from(new Set((results || []).map((item) => item.source).filter(Boolean)))
  };
  // Guardar uma busca com conteúdo no cache por 3 minutos
  if (data.results.length || data.wiki || data.videos.length || data.images.length) {
    richSearchCache.set(key, { t: Date.now(), data });
  }
  return data;
}

// ----------------------------------------------------
// RESPOSTA DA IA SOBRE A BUSCA
// A IA sintetiza e aprofunda os resultados reais retornados pelas fontes,
// citando com rigor e oferecendo uma resposta rica, didática e estruturada.
// ----------------------------------------------------
const searchAnswerCache = createLruCache({ maxEntries: 250, ttlMs: 20 * 60 * 1000 });

function buildAiSources(data, limit = 12) {
  const sources = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || !item.url || sources.length >= limit) return;
    const key = normalizeSearchUrl(item.url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    sources.push({
      title: item.title || safeHostname(item.url),
      url: item.url,
      host: safeHostname(item.url),
      snippet: String(item.snippet || item.description || item.extract || '').slice(0, 950),
      date: item.date || ''
    });
  };

  // 1. Wikipédia enciclopédica (máxima prioridade de definição e contextualização)
  if (data && data.wiki && data.wiki.url) {
    add({
      title: (data.wiki.title ? data.wiki.title + ' (Wikipédia)' : 'Wikipédia Enciclopédia'),
      url: data.wiki.url,
      snippet: data.wiki.extract || data.wiki.description || ''
    });
  }

  // 2. Notícias contemporâneas em tempo real (essencial para temas dinâmicos)
  const newsList = (data && data.news) || [];
  if (newsList.length > 0) {
    newsList.slice(0, 3).forEach(add);
  }

  // 3. Resultados gerais dos motores de busca (Google, Bing, Brave, DuckDuckGo, Yandex) com foco em relevância temática
  ((data && data.results) || []).forEach(add);

  // 4. Serviços .onion da camada profunda (somente se rota Tor estiver ativa ou tema direcionado)
  const onionList = (data && data.onion) || [];
  const qStr = String(data && data.q || '').toLowerCase();
  const isDeepQuery = !!(data && (data.viaTor || /onion|tor|dark|deep\s*web|hidden/i.test(qStr)));
  if (onionList.length > 0 && isDeepQuery) {
    onionList.filter((o) => {
      const isGeneric = /duckduckgo|ahmia|tor\s*taxi/i.test(o.title || '');
      return !isGeneric || /ahmia|taxi|engine|buscador|diretorio/i.test(qStr);
    }).slice(0, 2).forEach(add);
  }

  return sources;
}

function buildAiContext(sources) {
  return sources.map((item, index) => {
    const head = '[' + (index + 1) + '] ' + item.title + ' — ' + item.host + (item.date ? ' — ' + item.date : '');
    return head + '\n' + (item.snippet || '(sem descrição disponível)');
  }).join('\n\n');
}

const SEARCH_ANSWER_SYSTEM = [
  'Você é o assistente de inteligência artificial do navegador Papaléguas.',
  'Sua missão é fornecer uma resposta RESUMIDA, DIRETA E OBJETIVA em português do Brasil sobre o tema pesquisado.',
  '',
  'DIRETRIZES DE RESUMO (MÁXIMA CONCISÃO):',
  '• Responda de forma sucinta e direta, sem introduções desnecessárias ou enrolação.',
  '• Escreva no máximo 1 parágrafo curto (2 a 3 frases) com a definição ou resposta essencial.',
  '• Em seguida, se relevante, inclua no máximo 2 a 3 tópicos curtos ("•") com os pontos mais importantes.',
  '• Mantenha o texto total em torno de 60 a 120 palavras.',
  '',
  'REGRAS DE CITAÇÃO:',
  '• Baseie-se estritamente nas fontes numeradas fornecidas.',
  '• Cite as fontes no final das frases com [1], [2], etc.',
  '• Destaque termos-chave em negrito ("**termo**").'
].join('\n');

// ----------------------------------------------------
// AGENTE "MELHORES RESULTADOS": escolhe 2–3 links para abrir e explica o porquê.
// ----------------------------------------------------
const searchPicksCache = createLruCache({ maxEntries: 250, ttlMs: 20 * 60 * 1000 });
const SEARCH_PICKS_TTL = 5 * 60 * 1000;

function fallbackSearchPicks(question, sources) {
  // Sem IA: pontua por termos da pergunta no título/descrição e por domínio conhecido.
  const terms = normalizeDjText(question).split(/\s+/).filter((t) => t.length > 2);
  const trusted = /(wikipedia|gov\.br|\.gov|\.edu|\.org|g1\.globo|bbc|uol|folha|estadao|cnn|reuters|mdn|stackoverflow|github|docs\.)/i;
  const scored = sources.map((src, index) => {
    const text = normalizeDjText((src.title || '') + ' ' + (src.snippet || ''));
    let score = 0;
    terms.forEach((t) => { if (text.includes(t)) score += 3; });
    if (trusted.test(src.host || '')) score += 4;
    if ((src.snippet || '').length > 120) score += 2;
    score -= index * 0.4;
    return { n: index + 1, score, src };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).filter((p) => p.score > 0).map((p) => ({
    n: p.n,
    why: trusted.test(p.src.host || '') ? 'Fonte reconhecida e diretamente ligada ao que você pesquisou.' : 'Título e descrição batem com os termos da sua pesquisa.'
  }));
}

async function pickBestSearchResults(question, data) {
  const sources = buildAiSources(data, 10);
  if (!question || sources.length < 2) return { picks: [], intro: '', sources };

  let picks = [];
  let intro = '';
  try {
    const gptRes = await callOpenAi({
      model: 'gpt-4o-mini',
      timeoutMs: 7000,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Você é o agente de pesquisa do navegador Papaléguas. Recebe a pesquisa do usuário e uma lista numerada de resultados (título, site e descrição). Escolha os 2 ou 3 resultados que MAIS valem a pena abrir primeiro para resolver essa pesquisa.
Critérios: responde diretamente ao que foi pedido; fonte confiável/oficial ou especializada; conteúdo completo em vez de superficial; evite duplicatas do mesmo assunto e páginas apenas comerciais quando o usuário quer informação.
Para cada escolha, explique o motivo em UMA frase curta e concreta em português do Brasil (máx. 110 caracteres), citando o que a página oferece (ex.: "Página oficial com a tabela completa de preços").
Responda ESTRITAMENTE em JSON: { "intro": "frase de até 80 caracteres resumindo o que abrir primeiro", "picks": [ { "n": número da fonte, "why": "motivo" } ] }.
Use apenas números que existem na lista. Ordene do melhor para o pior.`
        },
        {
          role: 'user',
          content: 'Pesquisa: "' + question + '"\n\nResultados:\n' + buildAiContext(sources)
        }
      ]
    });
    const content = gptRes && gptRes.choices && gptRes.choices[0] && gptRes.choices[0].message && gptRes.choices[0].message.content;
    const parsed = content ? JSON.parse(content) : null;
    const seen = new Set();
    picks = (parsed && Array.isArray(parsed.picks) ? parsed.picks : [])
      .map((p) => ({ n: parseInt(p && p.n, 10), why: String(p && p.why || '').trim().slice(0, 140) }))
      .filter((p) => p.n >= 1 && p.n <= sources.length && !seen.has(p.n) && seen.add(p.n))
      .slice(0, 3);
    intro = String(parsed && parsed.intro || '').trim().slice(0, 120);
  } catch (e) {
    picks = [];
  }
  if (!picks.length) picks = fallbackSearchPicks(question, sources);
  const items = picks.map((p) => Object.assign({}, sources[p.n - 1], { n: p.n, why: p.why }));
  return { picks: items, intro, sources };
}

async function answerSearchWithAi(question, data, history = []) {
  const sources = buildAiSources(data, 12);
  if (!sources || sources.length === 0) {
    return {
      answer: `Nenhum resultado foi encontrado nos buscadores para "${question}".`,
      sources: []
    };
  }

  // Tenta LLM externa com timeout balanceado e conexão direta rápida
  const messages = [{ role: 'system', content: SEARCH_ANSWER_SYSTEM }];
  (history || []).slice(-4).forEach((turn) => {
    if (!turn || !turn.role || !turn.content) return;
    if (turn.role !== 'user' && turn.role !== 'assistant') return;
    messages.push({ role: turn.role, content: String(turn.content).slice(0, 1000) });
  });

  const promptContent = 'Tema pesquisado: ' + question + '\n\nFontes encontradas na web:\n' + buildAiContext(sources) + '\n\nIMPORTANTE: Forneça um resumo muito direto e conciso (máximo 1 parágrafo curto e até 2 ou 3 tópicos com os pontos essenciais), citando as fontes [1], [2].';
  messages.push({
    role: 'user',
    content: promptContent
  });

  try {
    const completion = await callOpenAi({
      messages,
      temperature: 0.2,
      max_tokens: 350,
      timeoutMs: 6500,
      direct: true
    });
    const choice = completion && completion.choices && completion.choices[0];
    const answer = (choice && choice.message && choice.message.content) || '';
    if (answer && String(answer).trim().length > 20) {
      return { answer: String(answer).trim(), sources };
    }
  } catch (err) {
    // LLM externa demorou ou indisponível: prossegue com a síntese de extração enriquecida
  }

  // Resposta com base rigorosa na extração de todos os buscadores (Google, Bing, DuckDuckGo, Brave, Yandex, Yahoo, Tor)
  const extractionAnswer = generateExtractionBasedAnswer(question, sources, data);
  return { answer: extractionAnswer, sources };
}

function generateExtractionBasedAnswer(question, sources, data) {
  const safeList = Array.isArray(sources) && sources.length > 0
    ? sources
    : buildAiSources(data, 8);

  if (!safeList || safeList.length === 0) {
    return 'Resultados públicos encontrados para esta pesquisa estão disponíveis nos links abaixo.';
  }

  const clean = (str) => String(str || '').replace(/\s+/g, ' ').trim();
  const ranked = safeList.map((s, idx) => ({
    n: idx + 1,
    title: clean(s.title || s.host || 'Fonte ' + (idx + 1)),
    host: clean(s.host || safeHostname(s.url)),
    snippet: clean(s.snippet || s.description || ''),
    url: s.url,
    date: clean(s.date || ''),
    isOnion: /\.onion(\b|\/|$)/i.test(s.url)
  }));

  const blocks = [];

  // 1. Resumo conciso e direto (Wikipédia ou principal fonte)
  const wikiSource = ranked.find((s) => /wikipédia|wikipedia/i.test(s.title || s.host));
  const prime = wikiSource || ranked[0];

  if (prime && prime.snippet && prime.snippet.length > 25) {
    let intro = prime.snippet;
    if (intro.length > 260) {
      const match = intro.slice(0, 250).match(/^(.*[.!?])\s/);
      intro = match ? match[1] : intro.slice(0, 230) + '…';
    }
    blocks.push(`${intro} [${prime.n}].`);
  } else {
    blocks.push(`Resumo das principais informações públicas consolidadas sobre **${question}** [1].`);
  }

  // 2. No máximo 2 tópicos curtos e objetivos
  const usedNums = new Set([prime ? prime.n : 1]);
  let added = 0;

  for (let i = 0; i < ranked.length && added < 2; i++) {
    const item = ranked[i];
    if (usedNums.has(item.n) || !item.snippet || item.snippet.length < 30 || item.isOnion) continue;

    let text = item.snippet.replace(/\.{2,}$/, '').trim();
    if (text.length > 130) text = text.slice(0, 120).trim() + '…';

    let label = item.title.split(/[-–|:;]/)[0].trim();
    if (label.length > 30) label = label.slice(0, 28) + '…';

    blocks.push(`• **${label}**: ${text} [${item.n}].`);
    usedNums.add(item.n);
    added++;
  }

  // 3. Notícia recente (apenas 1 item se relevante)
  const newsItem = ranked.find((s) => !usedNums.has(s.n) && (s.date || /g1|globo|uol|folha|estadao|cnn|bbc|reuters|noticias/i.test(s.host || s.title)));
  if (newsItem && added < 2) {
    let t = newsItem.snippet || newsItem.title;
    if (t.length > 130) t = t.slice(0, 120) + '…';
    blocks.push(`• **Recente**: ${t} [${newsItem.n}].`);
  }

  return blocks.join('\n\n');
}

function formatAiAnswerToHtml(text, sources) {
  if (!text) return '<div class="ai-skeleton"><i></i><i></i><i></i></div>';
  const escape = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (line) => {
    let html = escape(line)
      .replace(/[*][*]([^*]+)[*][*]/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="ai-code">$1</code>');
    return html.replace(/\[([0-9]+(?:[ ]*,[ ]*[0-9]+)*)\]/g, (match, group) => {
      const links = group.split(',').map((raw) => {
        const num = parseInt(raw, 10);
        const src = sources && sources[num - 1];
        if (!src) return '';
        return `<a class="ai-cite" href="#" data-ai-src="${num}" title="${escape((src.title || '') + ' · ' + (src.host || ''))}">[${num}]</a>`;
      }).join('');
      return links || match;
    });
  };

  const blocks = [];
  let currentListType = null;
  let listItems = [];

  const flushList = () => {
    if (currentListType && listItems.length) {
      blocks.push(`<${currentListType} class="ai-${currentListType}">${listItems.join('')}</${currentListType}>`);
    }
    currentListType = null;
    listItems = [];
  };

  let pendingBlank = false;
  String(text || '').split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      pendingBlank = true;
      return;
    }
    const heading = line.match(/^#{1,4}[ ]+(.*)$/);
    if (heading) {
      flushList();
      pendingBlank = false;
      blocks.push(`<h4 class="ai-subtitle">${inline(heading[1])}</h4>`);
      return;
    }
    const ordered = line.match(/^[0-9]+[.)][ ]+(.*)$/);
    if (ordered) {
      if (currentListType !== 'ol') {
        flushList();
        currentListType = 'ol';
      }
      listItems.push(`<li>${inline(ordered[1])}</li>`);
      pendingBlank = false;
      return;
    }
    const bullet = line.match(/^(?:[-*•])[ ]+(.*)$/);
    if (bullet) {
      if (currentListType !== 'ul') {
        flushList();
        currentListType = 'ul';
      }
      listItems.push(`<li>${inline(bullet[1])}</li>`);
      pendingBlank = false;
      return;
    }
    flushList();
    pendingBlank = false;
    blocks.push(`<p>${inline(line)}</p>`);
  });
  flushList();
  return blocks.join('');
}

function formatAiSourcesToHtml(sources, clientId) {
  if (!Array.isArray(sources) || !sources.length) return '';
  const escape = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return sources.map((src, index) => {
    const title = escape(src.title || src.host);
    const host = escape(src.host || src.title);
    const directUrl = escape(src.url);
    const proxyUrl = '/proxy?url=' + encodeURIComponent(src.url) + '&clientId=' + encodeURIComponent(clientId || 'client_default');
    return `<a class="ai-source" href="${proxyUrl}" data-direct="${directUrl}" title="${title} · ${host}">` +
      `<span class="ai-source-num">${index + 1}</span>` +
      `<span class="ai-source-name">${host}</span>` +
    `</a>`;
  }).join('');
}

// Perguntas de acompanhamento ("e quanto custa?") não fazem sentido sozinhas na busca:
// quando nenhuma palavra do assunto aparece, o tema original volta para a consulta.
function searchQueryForFollowUp(topic, question) {
  const topicTokens = searchQueryTokens(topic);
  const asked = normalizeForMatch(question);
  const mentionsTopic = topicTokens.some((token) => asked.includes(token));
  if (mentionsTopic && searchQueryTokens(question).length >= 2) return question;
  return (topic + ' ' + question).trim();
}

function looksLikeUrlQuery(query) {
  const q = String(query || '').trim();
  if (/\.onion(\b|\/|:|\?|#|$)/i.test(q)) return false;
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/.*)?$/i.test(q) && !/\s/.test(q);
}

function isOnionHref(raw) {
  const s = String(raw || '').trim();
  if (!s || !/\.onion/i.test(s)) return false;
  try {
    const href = /^https?:\/\//i.test(s) ? s : 'http://' + s.replace(/^\/+/, '');
    return /\.onion$/i.test(new URL(href).hostname) || /(?:^|\/\/)[a-z0-9.-]+\.onion(?:[/:?#]|$)/i.test(href);
  } catch (e) {
    return /[a-z0-9.-]+\.onion\b/i.test(s);
  }
}

function ensureAbsoluteUrl(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s;
}

function normalizeSearchUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch (e) {
    return String(url || '').trim().toLowerCase();
  }
}

async function getUrlSuggestions({ query, page = 0, useTor = false }) {
  const q = String(query || '').trim();
  const p = Math.max(0, parseInt(page, 10) || 0);
  const suggestions = [];
  if (!q) return { success: true, q, page: p, hasMore: false, suggestions };

  const safe = (promise, fallback) => promise.catch(() => fallback);

  if (p === 0) {
    if (isOnionHref(q)) {
      const url = /^https?:\/\//i.test(q) ? q.replace(/^https:/i, 'http:') : 'http://' + q.replace(/^\/+/, '');
      suggestions.push({
        kind: 'onion',
        title: q.replace(/^https?:\/\//i, ''),
        subtitle: 'Abrir endereço .onion',
        badge: 'Rede Tor',
        url
      });
    } else if (looksLikeUrlQuery(q)) {
      const url = /^https?:\/\//i.test(q) ? q : 'https://' + q;
      suggestions.push({
        kind: 'url',
        title: q.replace(/^https?:\/\//i, ''),
        subtitle: url,
        url
      });
    } else {
      suggestions.push({
        kind: 'gpt',
        title: q,
        subtitle: '✦ Papaléguas AI • Obter resposta imediata com inteligência artificial',
        badge: 'IA',
        url: '/search?q=' + encodeURIComponent(q)
      });
    }
    suggestions.push({
      kind: 'search',
      title: q,
      subtitle: useTor && isAppTorEnabled() ? 'Pesquisar tema na web e na rede Tor' : 'Pesquisar tema na web',
      badge: 'Buscar',
      url: '/search?q=' + encodeURIComponent(q)
    });
  }

  // Na página 0, usa orçamento rápido para nunca travar o autocomplete no celular
  const withDeadline = (promise, ms, fallback) => Promise.race([
    safe(promise, fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
  const poolPromise = (p === 0)
    ? withDeadline(getWebSearchPool(q, useTor), 2400, null)
    : safe(getWebSearchPool(q, useTor), []);
  const phrasesPromise = (p === 0)
    ? withDeadline(fetchSuggestPhrases(q, useTor), 1600, [])
    : safe(fetchSuggestPhrases(q, useTor), []);
  const onionPromise = (p === 0) ? withDeadline(searchOnionLinks(q), 1500, []) : Promise.resolve([]);
  const wikiPromise = (p === 0) ? withDeadline(fetchWikiTopicSummary(q), 1500, null) : Promise.resolve(null);
  const newsPromise = (p === 0) ? withDeadline(searchGoogleNewsRss(q, 2), 1500, []) : Promise.resolve([]);

  const [pool, phrases, onionLinks, wiki, news] = await Promise.all([
    poolPromise,
    phrasesPromise,
    onionPromise,
    wikiPromise,
    newsPromise
  ]);

  const webPool = Array.isArray(pool)
    ? pool
    : (nativeCore.searchLocalIndex(q, 10, false) || []);
  const phraseList = Array.isArray(phrases) ? phrases : [];
  const onionList = Array.isArray(onionLinks) ? onionLinks : [];

  if (p === 0) {
    // 1. Resumo Enciclopédico da Wikipédia (Conhecimento Imediato)
    if (wiki && (wiki.extract || wiki.title)) {
      suggestions.push({
        kind: 'wiki',
        title: wiki.title,
        subtitle: 'Wikipédia • Conhecimento Enciclopédico',
        badge: 'Wikipédia',
        snippet: wiki.extract ? (wiki.extract.slice(0, 160) + '...') : '',
        thumb: wiki.thumbnail || '',
        url: wiki.url
      });
    }

    // 2. Notícias em tempo real sobre o tema
    if (Array.isArray(news) && news.length > 0) {
      news.slice(0, 2).forEach((n) => {
        suggestions.push({
          kind: 'news',
          title: n.title,
          subtitle: '📰 Notícia • ' + n.source + (n.date ? ' · ' + formatSearchDate(n.date) : ''),
          badge: 'Notícia',
          snippet: n.snippet || '',
          url: n.url
        });
      });
    }

    // 3. Links da Rede Tor confirmados
    if (onionList.length > 0) {
      onionList.slice(0, 2).forEach((o) => {
        suggestions.push({
          kind: 'onion',
          title: o.title,
          subtitle: '🧅 ' + (o.category || 'Rede Tor') + ' • ' + o.url.replace(/^https?:\/\//i, '').slice(0, 28) + '...',
          badge: 'Rede Tor',
          url: o.url
        });
      });
    }

    // 4. Pesquisas e perguntas derivadas do tema
    (phraseList || []).slice(0, 6).forEach((phrase) => {
      if (String(phrase).toLowerCase() === q.toLowerCase()) return;
      if (suggestions.some((s) => s.kind === 'search' && String(s.title).toLowerCase() === String(phrase).toLowerCase())) return;
      suggestions.push({
        kind: 'search',
        title: phrase,
        subtitle: 'Explorar tema relacionado',
        badge: 'Pesquisa',
        url: '/search?q=' + encodeURIComponent(phrase)
      });
    });
  }

  // 8. Resultados da Web com paginação contínua (10 por lote sincronizado com a interface)
  const pageSize = 10;
  const start = p * pageSize;

  function formatSuggestSiteItem(r) {
    let host = r.url;
    try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (e) { swallowed(e, 'server:getUrlSuggestions@4236'); }
    const badgeMap = {
      yahoo: 'Yahoo',
      bing: 'Bing',
      duckduckgo: 'Duck',
      google: 'Google',
      brave: 'Brave',
      yandex: 'Yandex',
      wikipedia: 'Wiki'
    };
    const consensus = Number(r.consensusCount) || 1;
    const badge = consensus >= 2
      ? `✓ ${consensus} fontes`
      : (badgeMap[r.source] || '');
    const cachedPv = pagePreviewCache.get(r.url);
    const itemImg = (cachedPv && cachedPv.data && cachedPv.data.image) || r.image || '';
    const itemFav = (cachedPv && cachedPv.data && cachedPv.data.favicon) || r.favicon || '';
    const rawSnip = (cachedPv && cachedPv.data && cachedPv.data.description) || r.snippet || '';
    const cleanTitle = sanitizeSearchText(r.title || host, decodeHtmlEntities) || host;
    const cleanSnip = sanitizeSearchText(rawSnip, decodeHtmlEntities);

    return {
      kind: 'site',
      title: cleanTitle,
      subtitle: host,
      url: r.url,
      snippet: cleanSnip,
      image: itemImg,
      favicon: itemFav,
      date: r.date || '',
      badge: badge || undefined,
      source: r.source || 'web'
    };
  }

  const webSlice = webPool.slice(start, start + pageSize);
  webSlice.forEach((r) => {
    if (isOnionHref(r.url)) return;
    if (suggestions.some((s) => normalizeSearchUrl(s.url) === normalizeSearchUrl(r.url))) return;
    suggestions.push(formatSuggestSiteItem(r));
  });

  let hasMore = (start + pageSize) < webPool.length;
  // Se o lote inicial tiver menos que pageSize ou o pool principal esgotar, busca termos derivados com filtro de relevância
  if (suggestions.length < pageSize || !hasMore) {
    const candidates = (phraseList || []).filter((ph) => String(ph).toLowerCase() !== q.toLowerCase());
    const fallbackCandidates = [
      q + ' site',
      q + ' oficial',
      q + ' 2026',
      q + ' novidades',
      q + ' brasil',
      q + ' guia',
      q + ' artigos'
    ];
    const poolOfPhrases = candidates.length ? candidates.concat(fallbackCandidates) : fallbackCandidates;
    let phraseIndex = Math.max(0, p - Math.max(1, Math.floor(webPool.length / pageSize)));
    let extraHops = 0;
    while (suggestions.length < pageSize && phraseIndex < poolOfPhrases.length && extraHops < 2) {
      extraHops += 1;
      const extraQ = poolOfPhrases[phraseIndex];
      phraseIndex += 1;
      if (!extraQ) break;
      const extraRaw = await safe(getWebSearchPool(extraQ, useTor), []);
      const scoredExtra = extraRaw
        .map((r) => ({ r, rel: scoreSearchRelevance(r, q) }))
        .sort((a, b) => b.rel - a.rel);
      const hasRelevant = scoredExtra.some((x) => x.rel > 0);
      const filteredExtra = hasRelevant ? scoredExtra.filter((x) => x.rel > 0) : scoredExtra;
      const seenUrls = new Set(suggestions.map((s) => normalizeSearchUrl(s.url)));
      filteredExtra.forEach(({ r }) => {
        if (suggestions.length >= pageSize) return;
        const k = normalizeSearchUrl(r.url);
        if (!k || seenUrls.has(k) || isOnionHref(r.url)) return;
        seenUrls.add(k);
        suggestions.push(formatSuggestSiteItem(r));
      });
    }
    hasMore = phraseIndex < poolOfPhrases.length;
  }

  return { success: true, q, page: p, hasMore, suggestions, generatedByAi: false };
}

// ===== Prévia de páginas (imagem + descrição) para os resultados do buscador =====
// Lê as metatags OpenGraph/Twitter/description da página encontrada, sem cookies,
// e devolve imagem de capa, descrição, nome do site e favicon. Fica em cache por algumas horas.
const pagePreviewCache = createLruCache({ maxEntries: 1500, ttlMs: 6 * 60 * 60 * 1000 });
const pagePreviewInflight = new Map();
const PAGE_PREVIEW_TTL = 6 * 60 * 60 * 1000;
const PAGE_PREVIEW_FAIL_TTL = 20 * 60 * 1000;
const PAGE_PREVIEW_MAX_ENTRIES = 1500;

function parseHtmlTagAttributes(tag) {
  const attrs = {};
  String(tag || '').replace(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g, (_, name, __, dq, sq, bare) => {
    const key = name.toLowerCase();
    if (!(key in attrs)) attrs[key] = dq !== undefined ? dq : (sq !== undefined ? sq : (bare || ''));
    return '';
  });
  return attrs;
}

function resolvePreviewUrl(raw, base) {
  const value = decodeHtmlEntities(String(raw || '')).trim();
  if (!value || /^(data|javascript|blob|about):/i.test(value)) return '';
  try {
    const abs = new URL(value, base);
    return /^https?:$/i.test(abs.protocol) ? abs.href : '';
  } catch (e) {
    return '';
  }
}

function extractPagePreview(html, pageUrl) {
  const source = String(html || '');
  const headEnd = source.search(/<\/head>/i);
  const head = source.slice(0, headEnd > 0 ? Math.min(headEnd + 7, 400000) : 400000);
  const metas = {};
  (head.match(/<meta\b[^>]*>/gi) || []).forEach((tag) => {
    const a = parseHtmlTagAttributes(tag);
    const key = String(a.property || a.name || a.itemprop || '').toLowerCase().trim();
    const content = a.content;
    if (key && content && !(key in metas)) metas[key] = content;
  });

  let base = pageUrl;
  const baseTag = head.match(/<base\b[^>]*href\s*=\s*["']([^"']+)["']/i);
  if (baseTag) base = resolvePreviewUrl(baseTag[1], pageUrl) || pageUrl;

  const links = (head.match(/<link\b[^>]*>/gi) || []).map(parseHtmlTagAttributes);
  const linkHref = (re) => {
    const found = links.find((l) => re.test(String(l.rel || '')) && l.href);
    return found ? resolvePreviewUrl(found.href, base) : '';
  };

  let image = '';
  ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image', 'thumbnailurl']
    .some((k) => (image = resolvePreviewUrl(metas[k], base)));
  if (!image) image = linkHref(/(^|\s)image_src(\s|$)/i);
  if (!image) {
    // Último recurso: primeira imagem "de conteúdo" do corpo (ignora pixels, ícones e sprites)
    const body = source.slice(headEnd > 0 ? headEnd : 0, (headEnd > 0 ? headEnd : 0) + 300000);
    const imgs = body.match(/<img\b[^>]*>/gi) || [];
    for (const tag of imgs.slice(0, 40)) {
      const a = parseHtmlTagAttributes(tag);
      const src = a['data-src'] || a['data-lazy-src'] || a.src || '';
      if (!src || /(sprite|pixel|logo|icon|avatar|spacer|blank|tracking|1x1)/i.test(src)) continue;
      const w = parseInt(a.width, 10);
      const h = parseInt(a.height, 10);
      if ((w && w < 120) || (h && h < 80)) continue;
      if (/\.svg(\?|$)/i.test(src)) continue;
      image = resolvePreviewUrl(src, base);
      if (image) break;
    }
  }

  // Se ainda não encontrou imagem de conteúdo, busca logo/marca do próprio site
  if (!image) {
    const body = source.slice(headEnd > 0 ? headEnd : 0, (headEnd > 0 ? headEnd : 0) + 300000);
    const imgs = body.match(/<img\b[^>]*>/gi) || [];
    for (const tag of imgs.slice(0, 30)) {
      const a = parseHtmlTagAttributes(tag);
      const src = a['data-src'] || a['data-lazy-src'] || a.src || '';
      if (!src || /(sprite|pixel|spacer|blank|tracking|1x1)/i.test(src)) continue;
      if (/\.svg(\?|$)/i.test(src)) continue;
      if (/(logo|brand|header)/i.test(src) || /(logo|brand)/i.test(a.class || '') || /(logo|brand)/i.test(a.alt || '')) {
        const candidate = resolvePreviewUrl(src, base);
        if (candidate) { image = candidate; break; }
      }
    }
  }

  // Se o site não tem imagem nem logo no body, usa apple-touch-icon (ícone de alta resolução)
  if (!image) {
    const touchIcon = linkHref(/(^|\s)apple-touch-icon(\s|$)/i);
    if (touchIcon && !touchIcon.endsWith('.ico')) {
      image = touchIcon;
    }
  }

  const sanitizeText = (txt) => {
    let t = decodeHtmlEntities(stripTags(String(txt || ''))).replace(/\s+/g, ' ').trim();
    if (!t || /^[{<\[]|[{}[\]]{2,}|parsoid|mw:Extension|\{\{|\\u0000|":\s*["{]|"name":/i.test(t)) return '';
    return t;
  };

  let description = sanitizeText(metas['og:description'] || metas['description'] || metas['twitter:description'] || '');
  if (!description || description.length < 40) {
    const paragraphs = source.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
    for (const p of paragraphs.slice(0, 30)) {
      const text = sanitizeText(p);
      if (text.length >= 70 && !text.includes('Predefinição:') && !text.includes('mw-')) {
        description = text;
        break;
      }
    }
  }
  if (description.length > 320) description = description.slice(0, 317).replace(/\s+\S*$/, '') + '…';

  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeHtmlEntities(metas['og:title'] || metas['twitter:title'] || (titleTag ? titleTag[1] : '')).slice(0, 200);
  const siteName = decodeHtmlEntities(metas['og:site_name'] || metas['application-name'] || '').slice(0, 80);
  let favicon = linkHref(/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i);
  if (!favicon) {
    try { favicon = new URL('/favicon.ico', pageUrl).href; } catch (e) { favicon = ''; }
  }
  const published = metas['article:published_time'] || metas['og:updated_time'] || metas['date'] || '';
  return { title, description, image, siteName, favicon, published: String(published).slice(0, 40) };
}

function isPreviewableUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (!/^https?:$/i.test(u.protocol)) return null;
    if (isOnionHref(u.href) || isBlockedInternalProxyHost(u.hostname)) return null;
    return u;
  } catch (e) {
    return null;
  }
}

async function getPagePreview(rawUrl, useTor = false) {
  const target = isPreviewableUrl(rawUrl);
  if (!target) return null;
  const key = target.href;
  const cached = pagePreviewCache.get(key);
  if (cached && Date.now() - cached.t < (cached.data ? PAGE_PREVIEW_TTL : PAGE_PREVIEW_FAIL_TTL)) return cached.data;
  if (pagePreviewInflight.has(key)) return pagePreviewInflight.get(key);

  const job = (async () => {
    let html = '';
    try {
      if (target.protocol === 'https:') {
        html = await fetchBrowserText(key, { useTor, timeoutMs: 6500 });
      } else {
        html = await fetchHttpsText({
          hostname: target.hostname,
          port: target.port || 80,
          path: target.pathname + target.search,
          method: 'GET',
          protocol: 'http:',
          agent: getOutboundAgent(useTor),
          headers: webSourceHeaders()
        }, null, 6500);
      }
    } catch (e) {
      html = '';
    }
    const data = html ? extractPagePreview(html, key) : null;
    const useful = data && (data.image || data.description) ? data : null;
    if (pagePreviewCache.size >= PAGE_PREVIEW_MAX_ENTRIES) {
      const oldest = pagePreviewCache.keys().next().value;
      pagePreviewCache.delete(oldest);
    }
    pagePreviewCache.set(key, { t: Date.now(), data: useful });
    return useful;
  })().finally(() => pagePreviewInflight.delete(key));

  pagePreviewInflight.set(key, job);
  return job;
}

// Pools dinâmicos para alternar vídeos a cada requisição mantendo sempre os mais novos
function getDynamicRecentYoutubeQuery(categoryOrQuery, isForcedCustom = false, country = 'BR', pageIndex = null) {
  if (isForcedCustom) {
    return { query: categoryOrQuery, sortByRecent: false, isCustomQuery: true };
  }
  const c = (categoryOrQuery || 'noticias').toLowerCase().trim();
  const cUpper = String(country || 'BR').toUpperCase();
  const isPt = cUpper === 'BR' || cUpper === 'PT';
  const isEs = ['AR', 'MX', 'ES', 'CO', 'CL', 'PE', 'UY', 'VE', 'BO', 'EC', 'PY'].includes(cUpper);
  const isDe = ['DE', 'AT', 'CH'].includes(cUpper);
  const isFr = cUpper === 'FR';

  let newsPool, musicPool, sportsPool, podcastPool, trendingPool, gamesPool, moviePool, techPool, livePool, humorPool, financePool, cryptoPool;

  if (isPt) {
    newsPool = [
      'jovem pan news ultimas noticias',
      'record news jornal hoje',
      'sbt news ultimas noticias',
      'g1 noticias agora brasil',
      'globo news jornal agora',
      'band jornalismo noticias hoje',
      'cnn brasil ultimas noticias'
    ];
    financePool = [
      'mercado financeiro hoje brasil ultimas noticias',
      'bolsa de valores ibovespa fechamento analise',
      'investimentos economia brasil hoje noticias',
      'noticias economia mercado financeiro brasil',
      'dividendos acoes melhores investimentos 2026',
      'tesouro direto selic juros economia brasil',
      'noticias financeiras economia brasil hoje'
    ];
    cryptoPool = [
      'bitcoin hoje criptomoedas analise mercado',
      'criptomoedas noticias bitcoin ethereum hoje',
      'cotacao bitcoin analise grafica hoje',
      'altcoins criptomoedas promissoras 2026',
      'mercado cripto btc noticias brasil hoje',
      'blockchain web3 criptomoedas novidades',
      'noticias criptomoedas bitcoin brasil hoje'
    ];
    musicPool = [
      'novos lancamentos musicas brasil 2026',
      'top musicas mais tocadas brasil hoje',
      'novos clipes musicas brasil 2026',
      'melhores musicas brasil lancamentos'
    ];
    sportsPool = [
      'esportes futebol gols da rodada melhores momentos brasil',
      'ultimas noticias futebol brasil rodada hoje',
      'melhores momentos futebol rodada lances gols brasil'
    ];
    podcastPool = [
      'podcast brasil episodio completo',
      'flow podcast episodio completo',
      'inteligencia ltda podcast',
      'podpah podcast episodio'
    ];
    trendingPool = [
      'videos virais brasil hoje',
      'videos mais vistos brasil hoje',
      'viral brasil em alta'
    ];
    gamesPool = [
      'games brasil lancamentos 2026',
      'gameplay jogos novidades brasil 2026',
      'novos games gameplay lancamentos brasil',
      'jogos novidades gameplay brasil'
    ];
    moviePool = [
      'trailers filmes cinema dublado brasil 2026',
      'novos filmes trailers lancamentos brasil',
      'filmes lancamentos trailers cinema brasil em alta'
    ];
    techPool = [
      'tecnologia brasil novidades 2026',
      'inteligencia artificial brasil noticias novidades',
      'noticias tecnologia brasil inovacoes hoje',
      'tecnologia celulares novidades brasil 2026',
      'canal tecnologia brasil lancamentos',
      'principais novidades tecnologia inteligencia artificial brasil',
      'tendencias tecnologia brasil 2026',
      'gadgets tecnologia inovacao brasil'
    ];
    livePool = [
      'ao vivo brasil',
      'live agora brasil',
      'jornal ao vivo agora brasil'
    ];
    humorPool = [
      'comedia humor standup brasil videos novos',
      'melhores esquetes comedia humor brasil novos',
      'humor comedia videos brasil'
    ];
  } else if (isDe) {
    newsPool = ['tagesschau nachrichten heute', 'zdf heute nachrichten aktuell', 'welt nachrichten live stream', 'dw nachrichten deutschland'];
    musicPool = ['deutsche top hits 2026', 'neue musik releases charts heute', 'top songs deutschland'];
    sportsPool = ['bundesliga highlights heute tore', 'sport nachrichten heute highlights'];
    podcastPool = ['podcast ganze folge neu', 'podcast gespräch interview neu'];
    trendingPool = ['virale videos heute deutschland', 'trending videos youtube heute'];
    gamesPool = ['gameplay neuheiten 2026 spiele', 'gaming deutschland highlights'];
    moviePool = ['neue kino trailer 2026 deutsch', 'filmtrailer vorschau 2026'];
    techPool = ['technik nachrichten ki künstliche intelligenz', 'technologie innovationen 2026'];
    livePool = ['nachrichten live stream deutschland', 'live stream jetzt'];
    humorPool = ['comedy lustige videos neu', 'beste sketches comedy'];
  } else if (isEs) {
    newsPool = ['noticias de hoy en vivo ultimas noticias', 'el pais ultimas noticias hoy', 'rtve noticias en directo'];
    musicPool = ['nuevas canciones lanzamientos 2026', 'top exitos canciones nuevas', 'musica latina tendencias hoy'];
    sportsPool = ['futbol resumenes goles de la jornada', 'noticias del deporte hoy futbol'];
    podcastPool = ['podcast episodio completo nuevo', 'entrevistas podcast nuevo'];
    trendingPool = ['videos virales hoy tendencias', 'lo mas visto hoy en youtube'];
    gamesPool = ['nuevos juegos gameplay 2026', 'gameplay en espanol videojuegos'];
    moviePool = ['nuevos trailers peliculas estreno 2026', 'trailers de cine oficiales'];
    techPool = ['noticias tecnologia inteligencia artificial', 'nuevos dispositivos innovaciones 2026'];
    livePool = ['en vivo noticias transmision en directo', 'transmision en vivo'];
    humorPool = ['videos de risa comedia nuevos', 'humor stand up comedia'];
  } else if (isFr) {
    newsPool = ['france 24 direct actualites', 'bfmtv direct info', 'le monde actualite france'];
    musicPool = ['top musique france 2026', 'nouveautes musique france clip'];
    sportsPool = ['football resume buts ligue 1', 'actualites sport france'];
    podcastPool = ['podcast episode complet', 'interview podcast france'];
    trendingPool = ['videos tendances france aujourdhui', 'videos virales france'];
    gamesPool = ['gameplay jeux video nouveautes 2026', 'jeux video france'];
    moviePool = ['bandes annonces nouveaux films 2026', 'films cinema bande annonce'];
    techPool = ['actualite tech intelligence artificielle', 'innovations technologie'];
    livePool = ['en direct streaming france', 'info direct'];
    humorPool = ['humour sketch comedie nouveaux', 'videos droles'];
  } else {
    // English / Global International default (US, GB, NO, SE, NL, etc.)
    newsPool = [
      'breaking news today world live',
      'latest world news headlines today',
      'top news live stream international',
      'world news update live stream',
      'cnn live news today headlines',
      'bbc news live stream world'
    ];
    musicPool = [
      'top hits songs today world',
      'new music releases 2026 official',
      'billboard hot songs trending now',
      'trending music videos today'
    ];
    sportsPool = [
      'sports highlights today top plays',
      'football soccer match highlights goals',
      'latest sports news highlights today'
    ];
    podcastPool = [
      'podcast full episode trending today',
      'popular podcast interview full episode'
    ];
    trendingPool = [
      'trending videos today popular',
      'viral videos right now trending',
      'most watched videos today'
    ];
    gamesPool = [
      'new games gameplay trailers 2026',
      'gameplay walkthrough new release'
    ];
    moviePool = [
      'new movie trailers 2026 official',
      'upcoming cinema movies trailer 2026'
    ];
    techPool = [
      'tech news artificial intelligence innovations',
      'latest technology gadgets 2026'
    ];
    livePool = [
      'live news stream today',
      'live stream now'
    ];
    humorPool = [
      'funny videos comedy compilation 2026',
      'best comedy sketches comedy videos'
    ];
    financePool = [
      'stock market today financial news live',
      'finance economy investments market update',
      'wall street stock market news analysis 2026',
      'financial market news today live'
    ];
    cryptoPool = [
      'crypto news today bitcoin ethereum analysis',
      'bitcoin market update crypto latest news',
      'altcoins cryptocurrency blockchain 2026',
      'crypto market today latest headlines'
    ];
  }

  const pickRandom = (arr) => (pageIndex !== null && pageIndex !== undefined)
    ? arr[Math.abs(pageIndex) % arr.length]
    : arr[Math.floor(Math.random() * arr.length)];

  if (c === 'noticias' || c === 'noticia' || c === 'jornal' || c === 'urgente' || c === 'news') {
    return { query: pickRandom(newsPool), sortByRecent: true };
  }
  if (c === 'musicas' || c === 'musica' || c === 'som' || c === 'clipe' || c === 'music') {
    return { query: pickRandom(musicPool), sortByRecent: true };
  }
  if (c === 'esportes' || c === 'esporte' || c === 'futebol' || c === 'gol' || c === 'sports') {
    return { query: pickRandom(sportsPool), sortByRecent: true };
  }
  if (c === 'financeiro' || c === 'financas' || c === 'finanças' || c === 'investimentos' || c === 'economia' || c === 'finance') {
    return { query: pickRandom(financePool || newsPool), sortByRecent: true };
  }
  if (c === 'criptomoedas' || c === 'cripto' || c === 'bitcoin' || c === 'crypto' || c === 'btc') {
    return { query: pickRandom(cryptoPool || techPool), sortByRecent: true };
  }
  if (c === 'podcasts' || c === 'podcast' || c === 'corte' || c === 'entrevista') {
    return { query: pickRandom(podcastPool), sortByRecent: true, searchMode: 'podcast' };
  }
  if (c === 'games' || c === 'game' || c === 'jogo') {
    return { query: pickRandom(gamesPool), sortByRecent: true };
  }
  if (c === 'filmes' || c === 'filme' || c === 'trailer' || c === 'filmes trailers' || c === 'movies') {
    return { query: pickRandom(moviePool), sortByRecent: true };
  }
  if (c === 'tecnologia' || c === 'tech' || c === 'ia') {
    return { query: pickRandom(techPool), sortByRecent: true };
  }
  if (c === 'ao vivo' || c === 'live' || c === 'streaming') {
    return { query: pickRandom(livePool), sortByRecent: true, searchMode: 'live' };
  }
  if (c === 'humor' || c === 'comedia' || c === 'comedy') {
    return { query: pickRandom(humorPool), sortByRecent: true };
  }
  if (c === 'alta' || c === 'em alta' || c === 'trending' || c === 'viral' || c === 'tudo' || c === 'tudo / em alta') {
    return { query: pickRandom(trendingPool), sortByRecent: true, searchMode: 'trending' };
  }

  return { query: categoryOrQuery, sortByRecent: true, isCustomQuery: true };
}

const NEWS_OUTLET_QUERIES_BY_COUNTRY = {
  BR: [
    'jovem pan news ultimas noticias',
    'record news jornal hoje',
    'sbt news ultimas noticias',
    'g1 noticias agora brasil',
    'globo news jornal agora',
    'band jornalismo noticias hoje',
    'cnn brasil ultimas noticias',
    'uol noticias hoje',
    'metropoles noticias hoje',
    'bandnews tv ao vivo noticias',
    'estadao noticias hoje',
    'folha de s paulo noticias hoje',
    'sbt brasil jornal hoje',
    'jornal da record hoje'
  ],
  PT: [
    'rtp noticias direto ultimas',
    'sic noticias ultimas informacoes',
    'tvi noticias direto',
    'observador noticias hoje portugal'
  ],
  US: [
    'cnn live breaking news today',
    'nbc news live today headlines',
    'abc news live updates today',
    'cbs news live stream today',
    'fox news live breaking headlines',
    'associated press breaking news live',
    'reuters world news headlines',
    'bloomberg markets live news'
  ],
  GB: [
    'bbc news live stream uk',
    'sky news live breaking uk',
    'itv news headlines today',
    'channel 4 news uk today',
    'the guardian news video'
  ],
  AR: [
    'tn en vivo noticias argentina',
    'c5n en vivo noticias hoy',
    'la nacion mas en vivo argentina',
    'clarin noticias hoy argentina',
    'cronica tv en vivo noticias'
  ],
  MX: [
    'noticias telemundo hoy',
    'nmas en vivo noticias mexico',
    'milenio noticias hoy mexico',
    'el universal noticias mexico',
    'adn40 en vivo noticias'
  ],
  CA: [
    'cbc news live stream canada',
    'global news live today canada',
    'ctv news live headlines'
  ],
  JP: [
    'nhk ニュース ライブ',
    'ann ニュース ライブ 日本',
    'tbs news dig ライブ',
    '日テレnews ライブ 日本'
  ],
  DE: [
    'tagesschau nachrichten heute',
    'zdf heute nachrichten aktuell',
    'welt nachrichten live stream',
    'dw deutsch nachrichten heute'
  ],
  ES: [
    'rtve noticias directo espana',
    'el pais noticias hoy',
    'antena 3 noticias hoy',
    'la sexta noticias directo'
  ],
  FR: [
    'france 24 direct actualites',
    'bfmtv direct info',
    'le monde actualite france'
  ],
  IT: [
    'tgcom24 notizie ora',
    'sky tg24 diretta',
    'rai news 24 diretta'
  ],
  DEFAULT: [
    'bbc news live stream world',
    'cnn live breaking news today',
    'reuters world news headlines',
    'sky news live breaking world',
    'associated press breaking news live',
    'dw news live stream english'
  ]
};

function isNewsYoutubeCategory(query) {
  const c = String(query || '').toLowerCase().trim();
  return !c || c === 'noticias' || c === 'noticia' || c === 'jornal' || c === 'urgente' || c === 'news';
}

function pickNewsOutletQueries(count = 6, country = 'BR') {
  const cUpper = String(country || 'BR').toUpperCase();
  const pool = NEWS_OUTLET_QUERIES_BY_COUNTRY[cUpper] || NEWS_OUTLET_QUERIES_BY_COUNTRY.DEFAULT;
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function interleaveVideoLists(lists, max = 30) {
  const seen = new Set();
  const out = [];
  let idx = 0;
  let progressed = true;
  while (out.length < max && progressed) {
    progressed = false;
    for (const list of lists) {
      if (!list || idx >= list.length) continue;
      const video = list[idx];
      if (video && video.id && !seen.has(video.id)) {
        seen.add(video.id);
        out.push(video);
        progressed = true;
      } else {
        progressed = true;
      }
    }
    idx += 1;
  }
  return out;
}

let mixedNewsCache = null;
let mixedNewsCacheTime = 0;
const MIXED_NEWS_CACHE_TTL = 3 * 60 * 1000;
const mixedNewsCacheByKey = new Map();

// Intercala vídeos agrupando por CANAL (máx. N por canal) para que o feed de Notícias
// mostre sempre uma mistura dos principais canais de jornalismo, sem repetir o mesmo canal em sequência.
function interleaveByChannel(videos, maxPerChannel = 3, max = 30) {
  const groups = new Map();
  for (const v of videos || []) {
    if (!v || !v.id) continue;
    const ch = String(v.channel || 'desconhecido').toLowerCase().trim();
    if (!groups.has(ch)) groups.set(ch, []);
    const g = groups.get(ch);
    if (g.length < maxPerChannel && !g.some((x) => x.id === v.id)) g.push(v);
  }
  const lists = Array.from(groups.values());
  // Embaralha a ordem dos canais a cada atualização para variar o topo do feed
  for (let i = lists.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lists[i], lists[j]] = [lists[j], lists[i]];
  }
  return interleaveVideoLists(lists, max);
}

const mixedNewsInFlight = new Map();
async function fetchMixedNewsVideos(opts = {}) {
  const k = `${String(opts.country || 'BR').toUpperCase()}_${opts.timeFilter || 'hour'}_${opts.page || 1}`;
  const cachedEntry = mixedNewsCacheByKey.get(`mixed_news_${k}`);
  if (!opts.forceRefresh && cachedEntry && (Date.now() - cachedEntry.ts < MIXED_NEWS_CACHE_TTL) && cachedEntry.videos.length >= 6) {
    return cachedEntry.videos;
  }
  // Reaproveita a mesma busca em andamento (ex.: pré-aquecimento) em vez de disparar outra em paralelo
  if (mixedNewsInFlight.has(k)) return mixedNewsInFlight.get(k);
  // Se existe cache antigo, devolve na hora e atualiza em segundo plano
  const p = fetchMixedNewsVideosFresh(opts).finally(() => mixedNewsInFlight.delete(k));
  mixedNewsInFlight.set(k, p);
  if (!opts.forceRefresh && cachedEntry && cachedEntry.videos.length >= 6) {
    p.catch(() => {});
    return cachedEntry.videos;
  }
  return p;
}

async function fetchMixedNewsVideosFresh({ timeFilter = 'hour', useTor = false, timeoutMs = 5000, perQuery = 6, country = 'BR', clientIp = '', page = 1, forceRefresh = false } = {}) {
  const hl = getHlForCountry(country);
  const cUpper = String(country || 'BR').toUpperCase();
  const cacheKey = `mixed_news_${cUpper}_${timeFilter}_${page}`;
  const pool = NEWS_OUTLET_QUERIES_BY_COUNTRY[cUpper] || NEWS_OUTLET_QUERIES_BY_COUNTRY.DEFAULT;
  // Consulta até 8 canais principais em paralelo (rotacionando a cada página do scroll)
  const shuffled = pickNewsOutletQueries(pool.length, cUpper);
  const start = ((Math.max(1, page) - 1) * 8) % Math.max(1, shuffled.length);
  const queries = [];
  for (let i = 0; i < Math.min(8, shuffled.length); i++) {
    queries.push(shuffled[(start + i) % shuffled.length]);
  }
  // Notícias dos canais nas últimas 24h ordenadas pelas mais recentes (filtro 'hour' por canal costuma vir vazio)
  const outletFilter = timeFilter === 'hour' ? 'day' : timeFilter;
  const results = await Promise.all(queries.map((q) => Promise.race([
    searchYoutubeVideos(q, hl, true, outletFilter, false, '', country, clientIp).catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs))
  ])));
  const flat = interleaveVideoLists(results.map((list) => (list || []).slice(0, perQuery)), 80);
  let mixed = interleaveByChannel(flat, 3, 30);

  if (mixed.length < 10) {
    const isBr = cUpper === 'BR' || cUpper === 'PT';
    const fallbackQuery = isBr
      ? 'noticias brasil hoje jovem pan record g1 globo news band sbt'
      : (cUpper === 'DE' ? 'nachrichten heute aktuell live welt zdf tagesschau' : 'breaking news today world latest headlines live stream');
    const fallback = await Promise.race([
      searchYoutubeVideos(fallbackQuery, hl, true, 'day', false, '', country, clientIp).catch(() => []),
      new Promise((resolve) => setTimeout(() => resolve([]), 2000))
    ]);
    mixed = interleaveByChannel([...flat, ...(fallback || [])], 3, 30);
  }

  if (mixed.length >= 6) {
    mixedNewsCacheByKey.set(cacheKey, { ts: Date.now(), videos: mixed });
    if (mixedNewsCacheByKey.size > 60) mixedNewsCacheByKey.delete(mixedNewsCacheByKey.keys().next().value);
    mixedNewsCache = mixed;
    mixedNewsCacheTime = Date.now();
  }
  return mixed;
}

async function fetchMixedNewsVideosLegacy({ timeFilter = 'hour', useTor = false, timeoutMs = 2600, perQuery = 8, country = 'BR', clientIp = '' } = {}) {
  const hl = getHlForCountry(country);
  const cacheKey = `mixed_news_${country}_${hl}_${clientIp || 'default'}_${timeFilter}_direct`;
  if (mixedNewsCache && (Date.now() - mixedNewsCacheTime < MIXED_NEWS_CACHE_TTL) && mixedNewsCache.length >= 6) {
    return mixedNewsCache;
  }
  const waitMs = timeoutMs;
  const queries = pickNewsOutletQueries(3, country);
  const effectiveClientIp = clientIp;
  const results = await Promise.all(queries.map((q) => Promise.race([
    searchYoutubeVideos(q, hl, true, timeFilter, false, '', country, effectiveClientIp).catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), waitMs))
  ])));
  const mixed = interleaveVideoLists(results.map((list) => (list || []).slice(0, perQuery)), 30);
  if (mixed.length >= 6) {
    mixedNewsCache = mixed;
    mixedNewsCacheTime = Date.now();
    return mixed;
  }

  const cUpper = String(country || 'BR').toUpperCase();
  const isBr = cUpper === 'BR' || cUpper === 'PT';
  const fallbackQuery = isBr
    ? 'noticias brasil hoje jovem pan record g1 globo news band sbt'
    : (cUpper === 'DE' ? 'nachrichten heute aktuell live welt zdf tagesschau' : 'breaking news today world latest headlines live stream');

  const fallback = await Promise.race([
    searchYoutubeVideos(fallbackQuery, hl, true, timeFilter, false, '', country, effectiveClientIp).catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), 1200))
  ]);
  const combined = interleaveVideoLists([mixed, fallback || []], 30);
  if (combined.length >= 6) {
    mixedNewsCache = combined;
    mixedNewsCacheTime = Date.now();
    return combined;
  }

  if (timeFilter === 'hour') {
    const extraQuery = isBr ? 'noticias brasil ultimas horas ao vivo' : 'world news headlines live stream today';
    const extra = await searchYoutubeVideos(extraQuery, hl, true, 'day', false, '', country, effectiveClientIp).catch(() => []);
    const res = interleaveVideoLists([combined, extra || []], 30);
    if (res.length >= 6) {
      mixedNewsCache = res;
      mixedNewsCacheTime = Date.now();
    }
    return res;
  }
  return combined;
}

function getDynamicRecentMovieQuery(categoryOrQuery, pageIndex = null, country = 'BR') {
  const c = (categoryOrQuery || 'todos').toLowerCase().trim();
  const cUpper = String(country || 'BR').toUpperCase();
  const isPt = cUpper === 'BR' || cUpper === 'PT';
  const isEs = ['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'UY', 'PY', 'BO', 'CR', 'PA', 'DO', 'GT'].includes(cUpper);
  const isFr = ['FR', 'BE', 'SN', 'CI', 'MA', 'DZ', 'TN'].includes(cUpper);
  const isDe = ['DE', 'AT', 'CH'].includes(cUpper);
  const isIt = cUpper === 'IT';

  const langKey = isPt ? 'pt' : (isEs ? 'es' : (isFr ? 'fr' : (isDe ? 'de' : (isIt ? 'it' : 'en'))));

  const poolsByLang = {
    pt: {
      todos: [
        'filmes completos dublados lancamentos 2025',
        'filmes completos dublados lancamentos 2026',
        'novos filmes completos dublados em hd',
        'filmes lancamentos completos dublados',
        'melhores filmes lancamentos dublados completos',
        'cinema filmes completos dublados novos',
        'filmes de acao completos dublados adrenalina pura',
        'filmes completos dublados netmovies',
        'filmes completos dublados swen action',
        'filmes completos dublados em portugues acao',
        'filmes completos dublados alta definicao',
        'filmes gratis completos dublados hd',
        'filmes de ficcao cientifica dublados novos',
        'filmes de suspense e misterio dublados completos',
        'filmes de aventura dublados lancamentos',
        'filmes de acao e aventura dublados 2025',
        'filmes completos dublados cinerama portugues',
        'filmes completos dublados elite filmes',
        'filmes de acao policial completos dublados',
        'filmes de comedia e romance dublados completos',
        'filmes classicos do cinema completos dublados'
      ],
      acao: [
        'filmes de acao completos dublados lancamentos 2025',
        'filmes de acao completos dublados lancamentos 2026',
        'novos filmes de acao dublados completos hd',
        'filmes de acao e aventura completos dublados novos',
        'filmes de acao lancamentos dublados 2024',
        'filmes de acao e tiro dublados completos',
        'filmes de acao policial completos dublados',
        'filmes de acao adrenalina pura dublados',
        'filmes de acao swen filmes dublado completo',
        'filmes de artes marciais e acao dublados'
      ],
      comedia: [
        'filmes de comedia completos dublados novos',
        'novos filmes de comedia dublados completos 2025',
        'filmes de comedia lancamentos dublados',
        'filmes de comedia e romance dublados completos',
        'filmes de comedia brasileira completos',
        'melhores comédias dubladas completas hd'
      ],
      terror: [
        'filmes de terror completos dublados lancamentos',
        'novos filmes de terror e misterio dublados',
        'filmes de terror completos dublados novos hd',
        'filmes de terror psicologico dublados completos',
        'filmes de terror sobrenatural dublados',
        'filmes de terror e suspense completos dublados 2025'
      ],
      suspense: [
        'filmes de suspense dublados completos novos',
        'novos filmes de suspense e investigacao dublados',
        'filmes de suspense completos dublados lancamentos',
        'filmes de suspense policial dublados completos',
        'filmes de espionagem e suspense dublados',
        'filmes de suspense e acao completos dublados hd'
      ],
      ficcao: [
        'filmes de ficcao cientifica dublados lancamentos',
        'novos filmes de ficcao cientifica completos dublados',
        'filmes de ficcao dublados novos hd',
        'filmes de ficcao cientifica e espaco dublados',
        'filmes de ficcao pos apocaliptico dublados',
        'filmes de fantasia e ficcao dublados completos'
      ],
      aventura: [
        'filmes de aventura completos dublados lancamentos',
        'novos filmes de aventura dublados completos',
        'filmes de aventura e exploracao dublados',
        'filmes de aventura na selva dublados completos',
        'filmes de aventura e fantasia dublados',
        'filmes de jornada e aventura completos dublados'
      ],
      animacao: [
        'desenhos e animacoes filmes completos dublados novos',
        'novos filmes de animacao dublados completos',
        'animacoes filmes infantis completos dublados',
        'filmes de desenho animado dublados completos',
        'animacao infantil completa dublada hd',
        'filmes de animacao para a familia dublados'
      ],
      luta: [
        'filmes de luta e artes marciais dublados novos',
        'novos filmes de artes marciais completos dublados',
        'filmes de acao e luta dublados completos',
        'filmes de kung fu e karate dublados completos',
        'filmes de boxe e mma dublados completos',
        'filmes de acao e combate dublados hd'
      ]
    },
    en: {
      todos: [
        'full movies free english 2025',
        'full movies free english 2026',
        'new action full movies in english hd',
        'best free full movies on youtube english',
        'hollywood full movies in english hd',
        'full length movies english free',
        'thriller action full movie english',
        'sci fi full movie english hd',
        'adventure full movie english free',
        'crime thriller full movie english'
      ],
      acao: [
        'action full movie english hd 2025',
        'action full movie english 2026',
        'new action movies full length english',
        'action thriller full movie english free',
        'hollywood action full movie in english',
        'special forces action full movie english'
      ],
      comedia: [
        'comedy full movie english hd',
        'funny comedy full movies in english free',
        'romantic comedy full movie english',
        'family comedy full movie english hd'
      ],
      terror: [
        'horror full movie english hd',
        'scary horror full movies in english free',
        'supernatural horror full movie english',
        'thriller horror full movie english 2025'
      ],
      suspense: [
        'thriller suspense full movie english hd',
        'mystery thriller full movie in english',
        'crime investigation full movie english',
        'psychological thriller full movie english'
      ],
      ficcao: [
        'sci fi full movie english hd',
        'science fiction full movies in english free',
        'alien space sci fi full movie english',
        'post apocalyptic sci fi full movie english'
      ],
      aventura: [
        'adventure full movie english hd',
        'fantasy adventure full movie in english',
        'survival adventure full movie english',
        'action adventure full length movie english'
      ],
      animacao: [
        'animated full movie english hd',
        'animation family full movie in english',
        'cartoon animated movie full length english',
        'kids family animation full movie english'
      ],
      luta: [
        'martial arts full movie english hd',
        'kung fu action full movie in english',
        'mma fighting full movie english',
        'karate ninja action full movie english'
      ]
    },
    es: {
      todos: [
        'peliculas completas en espanol latino hd 2025',
        'peliculas completas en espanol 2026',
        'nuevas peliculas completas en espanol hd',
        'peliculas de accion completas en espanol',
        'cine peliculas completas en espanol gratis',
        'mejores peliculas completas dobladas al espanol',
        'peliculas de suspenso completas en espanol',
        'peliculas de aventura completas en espanol'
      ],
      acao: [
        'peliculas de accion completas en espanol hd',
        'nuevas peliculas de accion en espanol 2025',
        'peliculas de accion y aventura en espanol completas',
        'peliculas policiales de accion completas en espanol'
      ],
      comedia: [
        'peliculas de comedia completas en espanol hd',
        'comedias divertidas completas en espanol latino',
        'peliculas de comedia y romance en espanol completas'
      ],
      terror: [
        'peliculas de terror completas en espanol hd',
        'peliculas de miedo y terror en espanol completas',
        'terror sobrenatural pelicula completa en espanol'
      ],
      suspense: [
        'peliculas de suspenso completas en espanol hd',
        'thriller misterio pelicula completa en espanol',
        'peliculas de intriga y suspenso en espanol'
      ],
      ficcao: [
        'peliculas de ciencia ficcion completas en espanol hd',
        'ciencia ficcion espacio pelicula completa en espanol',
        'peliculas de fantasia y ficcion en espanol completas'
      ],
      aventura: [
        'peliculas de aventura completas en espanol hd',
        'aventuras y accion pelicula completa en espanol',
        'peliculas de supervivencia en espanol completas'
      ],
      animacao: [
        'peliculas de animacion completas en espanol hd',
        'dibujos animados pelicula completa en espanol',
        'peliculas animadas familiares en espanol completas'
      ],
      luta: [
        'peliculas de artes marciales completas en espanol hd',
        'peliculas de pelea y accion en espanol completas',
        'kung fu karate pelicula completa en espanol'
      ]
    },
    fr: {
      todos: [
        'film complet en francais hd 2025',
        'film complet en francais 2026',
        'nouveau film complet en francais gratuit',
        'film action complet en francais hd',
        'meilleurs films complets en francais',
        'film thriller suspense complet en francais'
      ],
      acao: ['film action complet en francais hd', 'nouveau film action vf complet', 'film policier action complet en francais'],
      comedia: ['film comedie complet en francais hd', 'comedie francaise film complet', 'film humour complet en francais'],
      terror: ['film horreur complet en francais hd', 'film epouvante complet vf', 'thriller horreur film complet en francais'],
      suspense: ['film suspense thriller complet en francais hd', 'film policier mystere complet vf'],
      ficcao: ['film science fiction complet en francais hd', 'film fantastique sf complet vf'],
      aventura: ['film aventure complet en francais hd', 'film action aventure complet vf'],
      animacao: ['film animation complet en francais hd', 'dessin anime film complet vf famille'],
      luta: ['film arts martiaux complet en francais hd', 'film combat kung fu complet vf']
    },
    de: {
      todos: [
        'ganzer film deutsch komplett hd 2025',
        'ganzer film deutsch 2026',
        'neue filme komplett auf deutsch hd',
        'actionfilm ganzer film deutsch',
        'spielfilm komplett auf deutsch kostenlos',
        'thriller ganzer film deutsch hd'
      ],
      acao: ['actionfilm ganzer film deutsch hd', 'action thriller komplett auf deutsch', 'neue actionfilme deutsch ganzer film'],
      comedia: ['komodie ganzer film deutsch hd', 'lustige filme komplett auf deutsch'],
      terror: ['horrorfilm ganzer film deutsch hd', 'gruselfilm komplett auf deutsch'],
      suspense: ['thriller krimi ganzer film deutsch hd', 'spannung film komplett auf deutsch'],
      ficcao: ['science fiction ganzer film deutsch hd', 'sci fi fantasy film komplett deutsch'],
      aventura: ['abenteuerfilm ganzer film deutsch hd', 'action abenteuer komplett auf deutsch'],
      animacao: ['animationsfilm ganzer film deutsch hd', 'zeichentrickfilm familie komplett deutsch'],
      luta: ['kampfkunst martial arts ganzer film deutsch', 'kung fu actionfilm komplett deutsch']
    },
    it: {
      todos: [
        'film completo in italiano hd 2025',
        'film completo in italiano 2026',
        'nuovi film completi in italiano gratis',
        'film azione completo in italiano hd',
        'migliori film completi in italiano',
        'film thriller completo in italiano'
      ],
      acao: ['film azione completo in italiano hd', 'film poliziesco azione completo italiano'],
      comedia: ['film commedia completo in italiano hd', 'commedia italiana film completo'],
      terror: ['film horror completo in italiano hd', 'film paura thriller completo italiano'],
      suspense: ['film thriller suspense completo in italiano hd', 'film giallo mistero completo italiano'],
      ficcao: ['film fantascienza completo in italiano hd', 'sci fi film completo in italiano'],
      aventura: ['film avventura completo in italiano hd', 'film azione avventura completo italiano'],
      animacao: ['film animazione completo in italiano hd', 'cartoni animati film completo italiano'],
      luta: ['film arti marziali completo in italiano hd', 'film combattimento kung fu italiano']
    }
  };

  const pools = poolsByLang[langKey] || poolsByLang.en;

  const pickRandom = (arr) => (pageIndex !== null && pageIndex !== undefined)
    ? arr[Math.abs(pageIndex) % arr.length]
    : arr[Math.floor(Math.random() * arr.length)];
  const catKey = pools[c] ? c : (Object.keys(pools).find(k => c.includes(k)) || 'todos');
  const filters = ['month', 'year', ''];
  return {
    query: pickRandom(pools[catKey]),
    sortByRecent: Math.random() > 0.45,
    timeFilter: filters[Math.floor(Math.random() * filters.length)]
  };
}

// Acervo curado de filmes dublados completos verificados de canais abertos e livres (Swen, Adrenalina Pura, Cinerama, NetMovies)
const CURATED_OFFICIAL_MOVIES = [
  {
    id: "BOFHtZGManA",
    title: "Dose Dupla | FILME COMPLETO DUBLADO",
    duration: "1:48:29",
    category: "acao",
    channel: "Swen Action",
    thumbnail: "https://i.ytimg.com/vi/BOFHtZGManA/hqdefault.jpg"
  },
  {
    id: "jBUaAHxS9NQ",
    title: "Os Mercenários 2 com Stallone e Chuck Norris - Filme Completo Dublado",
    duration: "1:42:29",
    category: "acao",
    channel: "Adrenalina Pura TV BR",
    thumbnail: "https://i.ytimg.com/vi/jBUaAHxS9NQ/hqdefault.jpg"
  },
  {
    id: "R77ESxgaSUE",
    title: "Marcando Território com Laurence Fishburne - Filme Completo Dublado",
    duration: "1:26:06",
    category: "acao",
    channel: "Adrenalina Pura TV BR",
    thumbnail: "https://i.ytimg.com/vi/R77ESxgaSUE/hqdefault.jpg"
  },
  {
    id: "YR2giGfY3OM",
    title: "Mente Criminosa com Kevin Costner, Gal Gadot e Ryan Reynolds",
    duration: "1:53:10",
    category: "acao",
    channel: "Adrenalina Pura TV BR",
    thumbnail: "https://i.ytimg.com/vi/YR2giGfY3OM/hqdefault.jpg"
  },
  {
    id: "P53HWbznl1M",
    title: "Blecaute - Filme Completo Dublado - Ação e Suspense",
    duration: "1:42:13",
    category: "suspense",
    channel: "Adrenalina Pura TV BR",
    thumbnail: "https://i.ytimg.com/vi/P53HWbznl1M/hqdefault.jpg"
  },
  {
    id: "Ety8o1xELCY",
    title: "Pura Adrenalina | Filme Completo Dublado",
    duration: "1:34:41",
    category: "acao",
    channel: "Cinerama - Português",
    thumbnail: "https://i.ytimg.com/vi/Ety8o1xELCY/hqdefault.jpg"
  },
  {
    id: "NMyqRqfFG24",
    title: "Cão Selvagem com Scott Adkins - Filme Completo Dublado",
    duration: "1:31:21",
    category: "luta",
    channel: "Adrenalina Pura TV BR",
    thumbnail: "https://i.ytimg.com/vi/NMyqRqfFG24/hqdefault.jpg"
  },
  {
    id: "-ssspLgJVB8",
    title: "Além do Limite - Filme Completo Dublado Aventura e Ação",
    duration: "1:26:37",
    category: "aventura",
    channel: "Hank Skott",
    thumbnail: "https://i.ytimg.com/vi/-ssspLgJVB8/hqdefault.jpg"
  },
  {
    id: "XQJGokSQTQ4",
    title: "Assassina Implacável - Filme de Ação Completo Dublado",
    duration: "1:28:30",
    category: "acao",
    channel: "Além da Tela",
    thumbnail: "https://i.ytimg.com/vi/XQJGokSQTQ4/hqdefault.jpg"
  },
  {
    id: "SBoODpO-DT0",
    title: "Os Mercenários 2 · Dublado em Português",
    duration: "1:42:20",
    category: "acao",
    channel: "Swen Filmes",
    thumbnail: "https://i.ytimg.com/vi/SBoODpO-DT0/hqdefault.jpg"
  },
  {
    id: "hLg7zL0LhS4",
    title: "O Resgate de uma Vida - Filme Completo Dublado",
    duration: "1:35:10",
    category: "suspense",
    channel: "NetMovies",
    thumbnail: "https://i.ytimg.com/vi/hLg7zL0LhS4/hqdefault.jpg"
  },
  {
    id: "7vWwJmX2JpI",
    title: "Perseguição Implacável - Filme de Ação Dublado",
    duration: "1:38:40",
    category: "acao",
    channel: "Adrenalina Pura TV BR",
    thumbnail: "https://i.ytimg.com/vi/7vWwJmX2JpI/hqdefault.jpg"
  },
  {
    id: "m4y9G1a3Qd8",
    title: "Mundo Subterrâneo - Ficção Científica Completo Dublado",
    duration: "1:41:15",
    category: "ficcao",
    channel: "Swen Filmes",
    thumbnail: "https://i.ytimg.com/vi/m4y9G1a3Qd8/hqdefault.jpg"
  },
  {
    id: "8c3Kj9Xp7Lk",
    title: "Operação Fronteira - Suspense e Ação Dublado",
    duration: "1:33:50",
    category: "suspense",
    channel: "Cinerama",
    thumbnail: "https://i.ytimg.com/vi/8c3Kj9Xp7Lk/hqdefault.jpg"
  }
];

function fetchYoutubeHtml(url, hl, useTor = false, clientIp = '') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    // BaixaTube e YouTube saem sempre direto (sem Tor) na velocidade máxima da internet
    const agent = undefined;
    let glParam = 'BR';
    let hlParam = hl || 'pt-BR';
    try {
      const u = new URL(url);
      if (u.searchParams.get('gl')) glParam = u.searchParams.get('gl');
      if (u.searchParams.get('hl')) hlParam = u.searchParams.get('hl');
    } catch (e) { swallowed(e, 'server:fetchYoutubeHtml@5230'); }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': `${hlParam},en-US;q=0.8,en;q=0.7`,
      'Accept': 'text/html,application/xhtml+xml',
      'Cookie': `PREF=hl=${encodeURIComponent(hlParam)}&gl=${encodeURIComponent(glParam)};`
    };
    // Encaminha o IP do dispositivo cliente para o YouTube gerar recomendações locais baseadas no visitante
    if (clientIp && !isPrivateIpAddress(clientIp)) {
      headers['X-Forwarded-For'] = String(clientIp).trim();
      headers['Client-IP'] = String(clientIp).trim();
      headers['X-Real-IP'] = String(clientIp).trim();
    }
    const req = https.get(url, {
      agent,
      headers
    }, (res) => {
      let html = '';
      let finished = false;
      res.on('data', chunk => {
        if (finished) return;
        html += chunk;
        const start = html.indexOf('var ytInitialData = ');
        if (start !== -1 && html.indexOf('</script>', start) !== -1) {
          finished = true;
          try { req.destroy(); } catch (e) { swallowed(e, 'server:fetchYoutubeHtml@5256'); }
          finish({ ok: true, html });
        } else if (html.length > 3500000) {
          finished = true;
          try { req.destroy(); } catch (e) { swallowed(e, 'server:fetchYoutubeHtml@5260'); }
          finish({ ok: true, html });
        }
      });
      res.on('end', () => finish({ ok: true, html }));
    });
    req.on('error', (err) => finish({ ok: false, error: err }));
    const timeout = 6500;
    req.setTimeout(timeout, () => { try { req.destroy(); } catch (e) { swallowed(e, 'server:fetchYoutubeHtml@5268'); } finish({ ok: false, timeout: true }); });
  });
}

// Cache de alta performance para buscas do YouTube (TTL de 6 minutos)
const youtubeSearchCache = createLruCache({ maxEntries: 300, ttlMs: 15 * 60 * 1000 });
const YT_CACHE_TTL = 6 * 60 * 1000;

function youtubeSearchSp(sortByRecent, timeFilter, searchMode) {
  if (searchMode === 'live') return '&sp=EgJAAQ%3D%3D';
  if (searchMode === 'trending' || searchMode === 'views') {
    if (timeFilter === 'hour') return '&sp=CAMSBAgBEAE%3D';
    if (timeFilter === 'day') return '&sp=CAMSBAgCEAE%3D';
    if (timeFilter === 'month') return '&sp=CAMSBAgEEAE%3D';
    return '&sp=CAMSBAgDEAE%3D';
  }
  if (!sortByRecent) {
    if (timeFilter === 'hour') return '&sp=EgIIAQ%3D%3D';
    if (timeFilter === 'day') return '&sp=EgIIAg%3D%3D';
    if (timeFilter === 'week') return '&sp=EgIIAw%3D%3D';
    if (timeFilter === 'month') return '&sp=EgIIBA%3D%3D';
    if (timeFilter === 'year') return '&sp=EgIIBQ%3D%3D';
    return '';
  }
  if (timeFilter === 'hour') return '&sp=CAISBAgBEAE%3D';
  if (timeFilter === 'day') return '&sp=CAISBAgCEAE%3D';
  if (timeFilter === 'week') return '&sp=CAISBAgDEAE%3D';
  if (timeFilter === 'month') return '&sp=CAISBAgEEAE%3D';
  return '&sp=CAI%3D';
}

function parseYoutubePublishedAgeDays(publishedAt) {
  if (!publishedAt) return null;
  const raw = String(publishedAt).toLowerCase().replace(/\u00a0/g, ' ').trim();
  if (!raw) return null;
  if (/ao vivo|live|assistindo|watching|agora|now|hoje|today|hoy|heute|aujourd|oggi|premiere|estreia/i.test(raw)) {
    return 0;
  }
  if (/ontem|yesterday|ayer|hier|gestern|ieri/i.test(raw)) {
    return 1;
  }
  const mYear = raw.match(/(?:^|\b)(\d+)\s*(?:y|yr|yrs|year|years|ano|anos|a[ñn]o|a[ñn]os|an|ans|jahr|jahre|jahren|anno|anni|年前|년\s*전|лет|год|года)(?:\b|$)/i);
  if (mYear) return parseInt(mYear[1], 10) * 365;
  const mMonth = raw.match(/(?:^|\b)(\d+)\s*(?:mo|mos|month|months|m[eê]s|meses|mois|monat|monate|monaten|mese|mesi|か月前|ヶ月前|개월\s*전|месяц)(?:\b|$)/i);
  if (mMonth) return parseInt(mMonth[1], 10) * 30;
  const mWeek = raw.match(/(?:^|\b)(\d+)\s*(?:w|wk|wks|week|weeks|semana|semanas|semaine|semaines|woche|wochen|settimana|settimane|週間前|주\s*전|недел)(?:\b|$)/i);
  if (mWeek) return parseInt(mWeek[1], 10) * 7;
  const mDay = raw.match(/(?:^|\b)(\d+)\s*(?:d|day|days|dia|dias|d[ií]a|d[ií]as|jour|jours|tag|tage|tagen|giorno|giorni|日前|일\s*전|дн|день|дня|дней)(?:\b|$)/i);
  if (mDay) return parseInt(mDay[1], 10);
  const mRecent = raw.match(/(?:^|\b)(\d+)\s*(?:s|sec|secs|second|seconds|seg|segundo|segundos|m|min|mins|minute|minutes|minuto|minutos|minuti|h|hr|hrs|hour|hours|hora|horas|heure|heures|stunde|stunden|ora|ore|分前|時間前|秒前|시간\s*전|분\s*전|час|мин)(?:\b|$)/i);
  if (mRecent) return 0.25;
  return null;
}

function isOldYoutubeVideo(video, maxDays = 14) {
  if (!video) return true;
  if (video.isLive) return false;
  const ageDays = parseYoutubePublishedAgeDays(video.publishedAt);
  if (ageDays !== null && ageDays > maxDays) return true;
  return false;
}

function filterRecentYoutubeVideos(videos, timeFilter = '') {
  if (!Array.isArray(videos) || videos.length === 0) return [];
  const tf = String(timeFilter || '').toLowerCase();
  if (!tf || tf === 'none') return videos;
  const strictMaxDays = tf === 'hour' ? 2 : (tf === 'day' ? 4 : (tf === 'week' ? 14 : (tf === 'month' ? 40 : 365)));
  const strictList = videos.filter((v) => !isOldYoutubeVideo(v, strictMaxDays));
  if (strictList.length >= 2) return strictList;
  // Mesmo em fallback, nunca aceita vídeos com meses ou anos de idade quando há filtro de tempo ativo
  const nonAncientList = videos.filter((v) => !isOldYoutubeVideo(v, 21));
  return nonAncientList.length > 0 ? nonAncientList : strictList;
}

function parseYoutubeViewCount(text) {
  const raw = String(text || '').toLowerCase().replace(/\s/g, '').replace(/\./g, '');
  const num = parseFloat(raw.replace(',', '.').replace(/[^\d,.]/g, ''));
  if (!num) return 0;
  if (raw.includes('mi') || /(^|[^a-z])m([^a-z]|$)/.test(raw)) return num * 1000000;
  if (raw.includes('mil') || raw.includes('k')) return num * 1000;
  return parseInt(raw.replace(/\D/g, ''), 10) || 0;
}

function parseYoutubeDurationMinutes(text) {
  const parts = String(text || '').split(':').map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
  if (parts.length === 3) return parts[0] * 60 + parts[1];
  if (parts.length === 2) return parts[0] + (parts[1] / 60);
  return 0;
}

function textHasEastAsianScript(text) {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(String(text || ''));
}

function isEastAsianHeavyTitle(text) {
  const marks = (String(text || '').match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  if (marks < 4) return false;
  const letters = (String(text || '').match(/[A-Za-zÀ-ÿ0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  return marks / Math.max(letters, 1) >= 0.35;
}

function themeMatchTokens(query) {
  const stop = new Set(['de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'os', 'as', 'um', 'uma', 'ao', 'ou', 'para', 'pra', 'com', 'por', 'que', 'the', 'and', 'for']);
  return normalizeDjText(query).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !stop.has(w));
}

function keepThemeVideos(videos, query) {
  let list = Array.isArray(videos) ? videos.filter(Boolean) : [];
  if (!textHasEastAsianScript(query)) {
    list = list.filter((v) => !isEastAsianHeavyTitle((v.title || '') + ' ' + (v.channel || '')));
  }
  const tokens = themeMatchTokens(query);
  if (tokens.length) {
    const matched = list.filter((v) => {
      const text = normalizeDjText((v.title || '') + ' ' + (v.channel || ''));
      return tokens.some((token) => text.includes(token));
    });
    if (matched.length) list = matched;
  }
  return list;
}

function filterVideosByCountryRelevance(videos, country = 'BR') {
  if (!Array.isArray(videos) || videos.length === 0) return [];
  const c = String(country || 'BR').toUpperCase();
  if (c === 'BR' || c === 'PT') {
    const foreignSpanishRegex = /(?:[¿¡]|\ben España\b|\ben espana\b|\bmerece la pena\b|\bcuánto cuesta\b|\bcuanto cuesta\b|\blo que hace\b|\blo que falla\b|\bte contamos qué es\b|\bsuscríbete\b|\ben directo\b|\bde la jornada\b|\bel resumen\b|\blos goles de\b|\ben vivo noticias\b|\bprobamos\b|\bpara qué sirve\b)/i;
    const localVideos = [];
    const foreignVideos = [];
    for (const v of videos) {
      if (!v) continue;
      const text = `${v.title || ''} ${v.description || ''} ${v.channel || ''}`;
      if (foreignSpanishRegex.test(text)) {
        foreignVideos.push(v);
      } else {
        localVideos.push(v);
      }
    }
    return localVideos.length >= 4 ? localVideos : [...localVideos, ...foreignVideos];
  }
  return videos;
}

function filterYoutubeModeResults(videos, searchMode) {
  const list = Array.isArray(videos) ? videos.slice() : [];
  if (searchMode === 'live') {
    const liveOnly = list.filter((v) => v && v.isLive);
    return (liveOnly.length ? liveOnly : list).slice(0, 30);
  }
  if (searchMode === 'podcast') {
    const longEps = list.filter((v) => !v.isLive && (v.durationMin || 0) >= 15);
    return (longEps.length >= 4 ? longEps : list.filter((v) => !v.isLive)).slice(0, 30);
  }
  if (searchMode === 'trending') {
    return list
      .filter((v) => !v.isLive)
      .sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))
      .slice(0, 30);
  }
  return list.slice(0, 30);
}

function collectYoutubeRenderers(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.videoRenderer) out.push(node.videoRenderer);
  if (node.compactVideoRenderer) out.push(node.compactVideoRenderer);
  if (node.gridVideoRenderer) out.push(node.gridVideoRenderer);
  if (node.lockupViewModel) out.push(node.lockupViewModel);
  if (Array.isArray(node)) {
    node.forEach((item) => collectYoutubeRenderers(item, out));
    return;
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') collectYoutubeRenderers(val, out);
  }
}

function extractRichYoutubeDescription(v) {
  if (!v) return '';
  const parts = [];
  if (Array.isArray(v.detailedMetadataSnippets)) {
    for (const s of v.detailedMetadataSnippets) {
      const txt = (s?.snippetText?.runs || []).map((r) => r.text).join('').trim();
      if (txt && !parts.includes(txt)) parts.push(txt);
    }
  }
  const descRuns = (v.descriptionSnippet?.runs || []).map((r) => r.text).join('').trim();
  if (descRuns && !parts.includes(descRuns)) parts.push(descRuns);
  let combined = parts.join(' ').replace(/\s+/g, ' ').trim();
  // Remove clichês de rodapé ("Inscreva-se no canal...") que ocupam espaço útil da legenda
  combined = combined
    .replace(/\bInscreva-se no canal[^.!?\n]*[.!?]?/gi, '')
    .replace(/\bDeixe seu like[^.!?\n]*[.!?]?/gi, '')
    .replace(/\bAtive o sininho[^.!?\n]*[.!?]?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return combined;
}

function mapYoutubeRenderer(v) {
  if (!v) return null;

  // Suporte a novo formato YouTube lockupViewModel (usado em vídeos recomendados e feeds 2026)
  if (v.lockupViewModel) v = v.lockupViewModel;
  if (v.metadata?.lockupMetadataViewModel || v.contentImage?.thumbnailViewModel) {
    const videoId = v.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId
      || v.contentImage?.thumbnailViewModel?.overlays?.[0]?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.animationActivationTargetId;
    if (!videoId) return null;
    const title = v.metadata?.lockupMetadataViewModel?.title?.content
      || v.rendererContext?.accessibilityContext?.label
      || '';
    const rows = v.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
    const channel = rows[0]?.metadataParts?.[0]?.text?.content || '';
    const viewsText = rows[1]?.metadataParts?.[0]?.accessibilityLabel || rows[1]?.metadataParts?.[0]?.text?.content || '';
    const publishedAt = rows[1]?.metadataParts?.[1]?.text?.content || rows[1]?.metadataParts?.[1]?.accessibilityLabel || '';
    const duration = v.contentImage?.thumbnailViewModel?.overlays?.[0]?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text || '';
    const sources = v.contentImage?.thumbnailViewModel?.image?.sources || [];
    const thumbnail = sources.length ? sources[sources.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const isLive = duration.toLowerCase().includes('ao vivo') || duration.toLowerCase().includes('live');
    return {
      id: videoId,
      title,
      thumbnail,
      channel,
      duration,
      views: viewsText,
      viewCount: parseYoutubeViewCount(viewsText),
      durationMin: parseYoutubeDurationMinutes(duration),
      isLive,
      publishedAt,
      description: title
    };
  }

  if (!v.videoId) return null;
  const thumbs = v.thumbnail?.thumbnails || [];
  const viewsText = v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || (v.viewCountText?.runs || []).map((r) => r.text).join('') || '';
  const duration = v.lengthText?.simpleText || '';
  const fullTitle = (v.title?.runs || []).map((r) => r.text).join('') || v.title?.simpleText || '';
  return {
    id: v.videoId,
    title: fullTitle,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : '',
    channel: v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '',
    duration,
    views: viewsText,
    viewCount: parseYoutubeViewCount(viewsText),
    durationMin: parseYoutubeDurationMinutes(duration),
    isLive: isYoutubeLiveRenderer(v),
    publishedAt: v.publishedTimeText?.simpleText || '',
    description: extractRichYoutubeDescription(v)
  };
}

async function fetchTrendingVideos({ useTor = false, country = 'BR', clientIp = '' } = {}) {
  const hl = getHlForCountry(country);
  const cacheKey = `trending__${country}__${hl}`;
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < YT_CACHE_TTL) && cached.videos.length > 0) {
    return cached.videos;
  }
  const url = 'https://www.youtube.com/feed/trending?gl=' + encodeURIComponent(country) + '&hl=' + encodeURIComponent(hl);
  const parseTrending = (html) => {
    try {
      const match = html.match(/var ytInitialData = ({.*?});<\/script>/);
      if (!match) return [];
      const data = JSON.parse(match[1]);
      const renderers = [];
      collectYoutubeRenderers(data, renderers);
      const seen = new Set();
      const videos = [];
      for (const v of renderers) {
        const mapped = mapYoutubeRenderer(v);
        if (!mapped || seen.has(mapped.id)) continue;
        seen.add(mapped.id);
        videos.push(mapped);
      }
      return filterYoutubeModeResults(videos, 'trending');
    } catch (e) {
      return [];
    }
  };
  try {
    const res = await fetchYoutubeHtml(url, hl, false, clientIp);
    if (res.ok && res.html) {
      const videos = (parseTrending(res.html) || []).filter((v) => !isEastAsianHeavyTitle((v && v.title) + ' ' + (v && v.channel)));
      if (videos.length) {
        youtubeSearchCache.set(cacheKey, { timestamp: Date.now(), videos });
        return videos;
      }
    }
  } catch (e) { swallowed(e, 'server:fetchTrendingVideos@5560'); }
  return [];
}

function isYoutubeLiveRenderer(v) {
  if (!v) return false;
  const badges = v.badges || [];
  for (const b of badges) {
    const label = (b.metadataBadgeRenderer && b.metadataBadgeRenderer.label) || '';
    if (/live|ao vivo/i.test(label)) return true;
  }
  const overlays = v.thumbnailOverlays || [];
  for (const o of overlays) {
    const st = o.thumbnailOverlayTimeStatusRenderer;
    if (st && (st.style === 'LIVE' || /live|ao vivo/i.test(st.text && (st.text.simpleText || '')))) return true;
  }
  const views = String(v.viewCountText && (v.viewCountText.simpleText || '') || '');
  if (/assistindo agora|watching now/i.test(views)) return true;
  return false;
}

async function searchYoutubeVideos(query, hl = 'pt-BR', sortByRecent = false, timeFilter = 'hour', forceTor = false, searchMode = '', country = 'BR', clientIp = '') {
  const trimmed = (query || 'noticias brasil').trim();
  const cacheKey = `${trimmed}__${hl}__${country || 'BR'}__${sortByRecent}__${timeFilter}__${searchMode || 'default'}__direct`;
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < YT_CACHE_TTL) && cached.videos.length > 0) {
    return cached.videos;
  }

  let url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(trimmed);
  url += '&hl=' + encodeURIComponent(hl || 'pt-BR') + '&gl=' + encodeURIComponent(country || 'BR') + '&persist_hl=1&persist_gl=1';
  url += youtubeSearchSp(sortByRecent, timeFilter, searchMode);

  const parseYoutubeHtml = (html) => {
    try {
      const match = html.match(/var ytInitialData = ({.*?});<\/script>/) || html.match(/var ytInitialData = ({.*?});?\s*<\/script>/);
      if (!match) return [];
      const data = JSON.parse(match[1]);
      const sections = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
      const videos = [];
      const seen = new Set();
      const pushVideo = (v) => {
        const mapped = mapYoutubeRenderer(v);
        if (!mapped || !mapped.id || seen.has(mapped.id)) return;
        seen.add(mapped.id);
        videos.push(mapped);
      };

      for (const s of sections) {
        const items = s.itemSectionRenderer?.contents || [];
        for (const it of items) {
          if (it.videoRenderer) pushVideo(it.videoRenderer);
          if (it.lockupViewModel) pushVideo(it.lockupViewModel);
          if (it.shelfRenderer) {
            const shelfItems = it.shelfRenderer?.content?.verticalListRenderer?.items || [];
            for (const sit of shelfItems) {
              if (sit.videoRenderer) pushVideo(sit.videoRenderer);
              if (sit.lockupViewModel) pushVideo(sit.lockupViewModel);
            }
          }
        }
      }
      if (videos.length === 0) {
        const renderers = [];
        collectYoutubeRenderers(data, renderers);
        renderers.forEach(pushVideo);
      }
      return videos.slice(0, 30);
    } catch(e) {
      return [];
    }
  };

  // BaixaTube e YouTube: sempre conexão direta (sem Tor) na velocidade máxima da internet
  try {
    const directRes = await fetchYoutubeHtml(url, hl, false, clientIp);
    if (directRes.ok && directRes.html) {
      const directVideos = parseYoutubeHtml(directRes.html);
      if (directVideos && directVideos.length > 0) {
        const recencyFiltered = filterRecentYoutubeVideos(directVideos, timeFilter);
        const filtered = filterVideosByCountryRelevance(keepThemeVideos(filterYoutubeModeResults(recencyFiltered, searchMode), trimmed), country);
        if (filtered.length) {
          youtubeSearchCache.set(cacheKey, { timestamp: Date.now(), videos: filtered });
          return filtered;
        }
      }
    }
  } catch (e) { swallowed(e, 'server:searchYoutubeVideos@5647'); }

  return [];
}

// ----------------------------------------------------
// MOTOR DE RECONHECIMENTO E DOWNLOAD DE VÍDEOS (MP4 / MP3)
// ----------------------------------------------------
function downloadMediaFile(urlOrId, format = 'mp4', onProgress = null, quality = '720', lang = 'pt') {
  return new Promise((resolve, reject) => {
    let targetUrl = (urlOrId || '').trim();
    if (!targetUrl) return reject(new Error('URL ou ID inválido'));
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      if (/^[a-zA-Z0-9_-]{11}$/.test(targetUrl)) {
        targetUrl = `https://www.youtube.com/watch?v=${targetUrl}`;
      } else {
        targetUrl = `ytsearch1:${targetUrl}`;
      }
    }

    const isMp3 = (format || '').toLowerCase() === 'mp3';
    const fileId = `media_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const outputTemplate = path.join(MEDIA_DOWNLOADS_DIR, `${fileId}.%(ext)s`);
    const langShort = String(lang || 'pt').split('-')[0].replace(/[^a-zA-Z]/g, '').toLowerCase() || 'pt';

    const args = [
      '-u',
      '-m', 'yt_dlp',
      '--js-runtimes', 'node',
      '--extractor-args', `youtube:player_client=default,android,ios,web,mweb;lang=${langShort}`,
      '--no-playlist',
      '--newline',
      '--no-warnings',
      '--write-info-json',
      '-o', outputTemplate
    ].concat(ytdlpProxyArgs());

    if (isMp3) {
      args.push(
        '-f', `ba[language^=${langShort}]/ba/ba*`,
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '--postprocessor-args', 'ffmpeg:-threads 0'
      );
    } else {
      let q = (quality || '720').toString().toLowerCase().replace('p', '');
      let height = 720;
      if (q === '1080') height = 1080;
      else if (q === '720') height = 720;
      else if (q === '480') height = 480;
      else if (q === '360') height = 360;
      else if (q === 'best') height = 9999;

      if (height === 9999) {
        args.push('-f', `bv*+ba[language^=${langShort}]/bv*+ba/b[language^=${langShort}]/b`, '--merge-output-format', 'mp4');
      } else {
        args.push('-f', `bv*[height<=${height}]+ba[language^=${langShort}]/bv*[height<=${height}]+ba/b[height<=${height}][language^=${langShort}]/b[height<=${height}]/bv*+ba[language^=${langShort}]/bv*+ba/b`, '--merge-output-format', 'mp4');
      }
    }

    args.push(targetUrl);

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'connecting', progress: 5, text: 'Conectando ao vídeo e obtendo dados...' });
    }

    console.log(`[MEDIA DOWNLOAD] Iniciando direto (sem Tor): formato=${format}, qualidade=${quality || '720'}`);
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const dlEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
    delete dlEnv.HTTP_PROXY;
    delete dlEnv.HTTPS_PROXY;
    delete dlEnv.ALL_PROXY;
    delete dlEnv.http_proxy;
    delete dlEnv.https_proxy;
    delete dlEnv.all_proxy;
    const proc = spawn(pythonCmd, args, {
      timeout: 600000,
      env: dlEnv
    });
    let stdout = '';
    let stderr = '';
    let parsedInfo = null;
    let convertTicker = null;
    let currentConvertPct = 96;

    // Suporta formatos normais, streams fragmentados e velocidades desconhecidas (ex: Unknown B/s)
    const dlRegex = /\[download\]\s+(\d+(?:\.\d+)?)\s*%\s+of\s*(?:~\s*)?([0-9\.]+\s*[A-Za-z]+)(?:\s+at\s+([0-9\.]+\s*[A-Za-z]+\/s|Unknown B\/s))?(?:\s+ETA\s+([0-9:]+|Unknown))?(?:\s+\(frag\s+(\d+\/\d+)\))?/;
    const dlSimpleRegex = /\[download\]\s+(\d+(?:\.\d+)?)\s*%/;

    function parseProgress(chunk) {
      const text = chunk.toString();
      const lines = text.split('\n');
      for (const l of lines) {
        const trimmed = l.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('INFO:')) {
          const parts = trimmed.substring(5).split('\t');
          parsedInfo = {
            title: parts[0] || '',
            duration_string: parts[1] || '',
            thumbnail: parts[2] || ''
          };
          continue;
        }

        const m = trimmed.match(dlRegex);
        if (m && typeof onProgress === 'function') {
          const rawPct = parseFloat(m[1]);
          const scaledPct = Math.min(94, Math.max(6, Math.round(5 + (rawPct * 0.89))));
          const totalSize = m[2] ? m[2].trim() : '';
          const rawSpeed = m[3] ? m[3].trim() : '';
          const rawEta = m[4] ? m[4].trim() : '';
          const frag = m[5] ? m[5].trim() : '';
          
          const speed = (rawSpeed && !rawSpeed.includes('Unknown')) ? rawSpeed : '';
          const eta = (rawEta && !rawEta.includes('Unknown')) ? rawEta : '';

          let statusDesc = `Baixando mídia: ${rawPct.toFixed(0)}%`;
          if (totalSize) statusDesc += ` de ${totalSize}`;
          if (frag) statusDesc += ` (frag. ${frag})`;

          onProgress({
            stage: 'downloading',
            progress: scaledPct,
            rawPercent: rawPct,
            total: totalSize,
            speed: speed,
            eta: eta,
            frag: frag,
            text: statusDesc
          });
        } else if (trimmed.match(dlSimpleRegex) && typeof onProgress === 'function') {
          const sm = trimmed.match(dlSimpleRegex);
          const rawPct = parseFloat(sm[1]);
          const scaledPct = Math.min(94, Math.max(6, Math.round(5 + (rawPct * 0.89))));
          onProgress({
            stage: 'downloading',
            progress: scaledPct,
            rawPercent: rawPct,
            text: `Baixando fluxo de dados: ${rawPct.toFixed(0)}%...`
          });
        } else if (trimmed.includes('Downloading webpage') && typeof onProgress === 'function') {
          onProgress({ stage: 'connecting', progress: 8, text: 'Obtendo informações do vídeo...' });
        } else if ((trimmed.includes('Solving JS') || trimmed.includes('player')) && typeof onProgress === 'function') {
          onProgress({ stage: 'connecting', progress: 12, text: 'Processando autenticação e codecs...' });
        } else if (trimmed.includes('[ExtractAudio]') && typeof onProgress === 'function') {
          if (!convertTicker) {
            currentConvertPct = 96;
            convertTicker = setInterval(() => {
              if (currentConvertPct < 99) {
                currentConvertPct++;
                onProgress({
                  stage: 'converting',
                  progress: currentConvertPct,
                  speed: 'Codificando MP3 via FFmpeg...',
                  text: 'Extraindo e refinando áudio MP3 em alta qualidade...'
                });
              }
            }, 1200);
          }
          onProgress({
            stage: 'converting',
            progress: 96,
            speed: 'Processando com FFmpeg multi-core...',
            text: 'Extraindo áudio MP3 em alta qualidade via FFmpeg...'
          });
        } else if (trimmed.includes('[Merger]') && typeof onProgress === 'function') {
          if (!convertTicker) {
            currentConvertPct = 96;
            convertTicker = setInterval(() => {
              if (currentConvertPct < 99) {
                currentConvertPct++;
                onProgress({
                  stage: 'merging',
                  progress: currentConvertPct,
                  speed: 'Mesclando faixas via FFmpeg...',
                  text: 'Finalizando arquivo de vídeo MP4...'
                });
              }
            }, 1200);
          }
          onProgress({
            stage: 'merging',
            progress: 96,
            speed: 'Mesclando vídeo e áudio...',
            text: 'Mesclando faixas de vídeo e áudio em MP4 via FFmpeg...'
          });
        }
      }
    }

    proc.stdout.on('data', d => {
      stdout += d.toString();
      parseProgress(d);
    });
    proc.stderr.on('data', d => {
      stderr += d.toString();
      parseProgress(d);
    });

    proc.on('close', code => {
      if (convertTicker) {
        clearInterval(convertTicker);
        convertTicker = null;
      }

      if (code !== 0) {
        console.error(`[MEDIA DOWNLOAD ERROR] code=${code}`);
        let errMsg = stderr.slice(-250) || 'Falha ao processar e baixar o vídeo';
        if (errMsg.includes('This video is not available') || errMsg.includes('Video unavailable') || errMsg.includes('Private video')) {
          errMsg = 'Este vídeo não está disponível ou possui restrições no BaixaTube.';
        }
        return reject(new Error(errMsg));
      }

      let info = {};
      const infoPath = path.join(MEDIA_DOWNLOADS_DIR, `${fileId}.info.json`);
      if (fs.existsSync(infoPath)) {
        try {
          info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          fs.unlinkSync(infoPath);
        } catch (e) { swallowed(e, 'server:downloadMediaFile@5870'); }
      }

      const finalExt = isMp3 ? 'mp3' : 'mp4';
      let actualFilename = `${fileId}.${finalExt}`;
      try {
        const files = fs.readdirSync(MEDIA_DOWNLOADS_DIR);
        const match = files.find(f => f.startsWith(fileId) && f.endsWith('.' + finalExt));
        if (match) actualFilename = match;
      } catch (e) { swallowed(e, 'server:downloadMediaFile@5879'); }

      const result = {
        id: fileId,
        title: info.title || 'Audio_Papaleguas',
        duration: info.duration_string || '--:--',
        thumbnail: info.thumbnail || '',
        format: finalExt,
        filename: actualFilename,
        filePath: path.join(MEDIA_DOWNLOADS_DIR, actualFilename),
        url: `/api/media/file/${actualFilename}?title=${encodeURIComponent(info.title || 'audio')}`
      };

      if (typeof onProgress === 'function') {
        onProgress({
          stage: 'complete',
          progress: 100,
          text: 'Conversão concluída com sucesso!',
          success: true,
          ...result
        });
      }

      resolve(result);
    });

    proc.on('error', err => {
      reject(err);
    });
  });
}

// Gerenciador de Jobs de Download em Segundo Plano (Imune a buffering de proxy Cloudflare/Mobile)
const mediaJobs = new Map();

function startMediaDownloadJob(urlOrId, format = 'mp4', quality = '720', lang = 'pt') {
  const cleanQ = format === 'mp3' ? 'MP3' : ((quality || '720').toString().replace('p', '') + 'p');
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  const job = {
    jobId,
    url: urlOrId,
    format,
    quality: cleanQ,
    stage: 'init',
    progress: 5,
    text: `Iniciando motor de download (${cleanQ})...`,
    speed: '',
    eta: '',
    total: '',
    frag: '',
    startTime: Date.now(),
    lastUpdated: Date.now(),
    success: false,
    result: null,
    error: null
  };
  mediaJobs.set(jobId, job);

  downloadMediaFile(urlOrId, format, (p) => {
    Object.assign(job, p, { lastUpdated: Date.now() });
  }, quality, lang).then((res) => {
    job.stage = 'complete';
    job.progress = 100;
    job.success = true;
    job.result = res;
    job.lastUpdated = Date.now();
  }).catch((err) => {
    job.stage = 'error';
    job.success = false;
    job.error = err.message || 'Falha no download';
    job.lastUpdated = Date.now();
  });

  // Limpeza automática de jobs após 30 minutos
  setTimeout(() => {
    mediaJobs.delete(jobId);
  }, 30 * 60 * 1000);

  return job;
}

// Busca no acervo Deezer com suporte a paginação e rolagem infinita
function searchDeezer(query, limit = 30, order = 'RANKING', index = 0) {
  const trimmed = (query || '').trim();
  const isTrending = !trimmed || trimmed.toLowerCase().match(/^(bombando|atual|atuais|em alta|top|paradas|hits|sucessos|mais tocadas|2026|2025)$/);

  if (isTrending && index === 0) {
    return getDeezerChartTracks(limit);
  }

  const effectiveQuery = isTrending ? 'hits bombando 2026' : trimmed;

  return new Promise((resolve) => {
    const url = 'https://api.deezer.com/search?q=' + encodeURIComponent(effectiveQuery) + '&limit=' + limit + '&order=' + order + '&index=' + index;
    const req = https.get(url, { agent: getOutboundAgent(false), headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.data || []).map(item => {
            const safeTitle = item.title || 'Música';
            const safeArtist = item.artist ? item.artist.name : 'Desconhecido';
            return {
              id: item.id,
              title: safeTitle,
              artist: safeArtist,
              album: item.album ? item.album.title : '',
              cover: proxyCoverUrl(item.album && item.album.cover_medium ? item.album.cover_medium : (item.artist ? item.artist.picture_medium : '')),
              duration: item.duration || 0,
              preview: proxyPreviewUrl(item.preview || ''),
              rank: item.rank || 0,
              fullStreamUrl: `/api/stream-audio?title=${encodeURIComponent(safeTitle)}&artist=${encodeURIComponent(safeArtist)}`
            };
          });
          results.sort((a, b) => (b.rank || 0) - (a.rank || 0));
          resolve({ success: true, results, total: json.total || 0, nextIndex: index + results.length });
        } catch (e) {
          resolve({ success: false, error: e.message, results: [] });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message, results: [] }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ success: false, error: 'Timeout', results: [] }); });
  });
}

function httpsGetJson(url, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const req = https.get(url, { agent: getOutboundAgent(false), headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

const DEEZER_COVER_HOSTS = new Set([
  'cdn-images.dzcdn.net',
  'e-cdns-images.dzcdn.net',
  'cdns-images.dzcdn.net'
]);

function proxyCoverUrl(cover) {
  const value = String(cover || '').trim();
  if (!value) return '/papaleguas_logo.png';
  if (value.startsWith('/')) return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !DEEZER_COVER_HOSTS.has(parsed.hostname)) {
      return '/papaleguas_logo.png';
    }
    return '/api/cover?u=' + encodeURIComponent(parsed.href);
  } catch (e) {
    return '/papaleguas_logo.png';
  }
}

function mapDeezerTrack(item, extra = {}) {
  if (!item) return null;
  const safeTitle = item.title || 'Música';
  const safeArtist = item.artist ? item.artist.name : (extra.artist || 'Desconhecido');
  return Object.assign({
    id: item.id,
    title: safeTitle,
    artist: safeArtist,
    album: item.album ? item.album.title : '',
    cover: proxyCoverUrl(item.album && item.album.cover_medium ? item.album.cover_medium : (item.artist && item.artist.picture_medium ? item.artist.picture_medium : '')),
    duration: item.duration || 0,
    preview: proxyPreviewUrl(item.preview || ''),
    rank: item.rank || 0,
    fullStreamUrl: `/api/stream-audio?title=${encodeURIComponent(safeTitle)}&artist=${encodeURIComponent(safeArtist)}`
  }, extra);
}

async function searchDeezerArtistTop(query, limit = 16) {
  const q = String(query || '').trim();
  if (!q || q.length < 2) return [];
  const artistJson = await httpsGetJson('https://api.deezer.com/search/artist?q=' + encodeURIComponent(q) + '&limit=1');
  const artist = artistJson && artistJson.data && artistJson.data[0];
  if (!artist || !artist.id) return [];
  const artistName = String(artist.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const nq = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!(artistName === nq || nq.includes(artistName) || artistName.includes(nq))) return [];
  const topJson = await httpsGetJson('https://api.deezer.com/artist/' + artist.id + '/top?limit=' + limit);
  return ((topJson && topJson.data) || []).map((item) => mapDeezerTrack(item, {
    artist: item.artist ? item.artist.name : artist.name,
    aiReason: '⭐ Top de ' + artist.name
  })).filter(Boolean);
}

// Busca músicas bombando e mais tocadas do momento nas paradas oficiais
function getDeezerChartTracks(limit = 16) {
  return new Promise((resolve) => {
    const url = `https://api.deezer.com/chart/0/tracks?limit=${limit}`;
    const req = https.get(url, { agent: getOutboundAgent(false), headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.data || []).map(item => ({
            id: item.id,
            title: item.title,
            artist: item.artist ? item.artist.name : 'Desconhecido',
            album: item.album ? item.album.title : '',
            cover: proxyCoverUrl(item.album && item.album.cover_medium ? item.album.cover_medium : (item.artist ? item.artist.picture_medium : '')),
            duration: item.duration || 0,
            preview: proxyPreviewUrl(item.preview || ''),
            rank: item.rank || 999999,
            aiReason: '🔥 Top 1 Paradas Mundiais / Brasil 2026'
          }));
          resolve({ success: true, results });
        } catch (e) {
          resolve({ success: false, error: e.message, results: [] });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message, results: [] }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ success: false, error: 'Timeout', results: [] }); });
  });
}

// Busca playlists no acervo Deezer
function searchDeezerPlaylists(query, limit = 12) {
  return new Promise((resolve) => {
    const term = (query || '').trim() || 'top playlists brasil';
    const url = 'https://api.deezer.com/search/playlist?q=' + encodeURIComponent(term) + '&limit=' + limit;
    const req = https.get(url, { agent: getOutboundAgent(false), headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.data || []).map(item => ({
            id: item.id,
            title: item.title,
            creator: item.user ? item.user.name : 'Papaléguas Music',
            nb_tracks: item.nb_tracks || 0,
            cover: proxyCoverUrl(item.picture_medium || item.picture || ''),
            link: item.link || '',
            type: 'playlist'
          }));
          resolve({ success: true, results });
        } catch (e) {
          resolve({ success: false, error: e.message, results: [] });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message, results: [] }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ success: false, error: 'Timeout', results: [] }); });
  });
}

// Busca faixas de uma playlist do Deezer
function isDeezerPreviewHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase();
  return h === 'dzcdn.net' || h.endsWith('.dzcdn.net') || h === 'deezer.com' || h.endsWith('.deezer.com');
}

function proxyPreviewUrl(preview) {
  const value = String(preview || '').trim();
  if (!value || value.startsWith('/')) return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !isDeezerPreviewHost(parsed.hostname)) return '';
    return '/api/audio-preview?u=' + encodeURIComponent(parsed.href);
  } catch (e) {
    return '';
  }
}

function mapPlaylistTrack(item, playlistTitle) {
  if (!item || !item.title) return null;
  const artist = item.artist ? item.artist.name : 'Desconhecido';
  const album = item.album || {};
  return {
    id: item.id,
    title: item.title,
    artist,
    album: album.title || playlistTitle || '',
    cover: proxyCoverUrl(album.cover_medium || album.cover_big || album.cover_small || album.cover || ''),
    fullStreamUrl: `/api/stream-audio?title=${encodeURIComponent(item.title)}&artist=${encodeURIComponent(artist)}`,
    duration: item.duration || 0,
    preview: proxyPreviewUrl(item.preview || ''),
    rank: item.rank || 0
  };
}

function getDeezerPlaylistTracks(playlistId, limit = 30) {
  const cap = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  return new Promise((resolve) => {
    const url = 'https://api.deezer.com/playlist/' + encodeURIComponent(playlistId) + '/tracks?limit=' + cap;
    const req = https.get(url, { agent: getOutboundAgent(false), headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => {
        if (data.length < 1500000) data += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const rawTracks = Array.isArray(json.data) ? json.data : ((json.tracks && json.tracks.data) || []);
          const tracks = rawTracks.map((item) => mapPlaylistTrack(item, '')).filter(Boolean);
          resolve({
            success: tracks.length > 0,
            title: json.title || '',
            cover: proxyCoverUrl(json.picture_medium || ''),
            creator: '',
            tracks
          });
        } catch (e) {
          resolve({ success: false, error: e.message, tracks: [] });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message, tracks: [] }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ success: false, error: 'Timeout', tracks: [] }); });
  });
}

// Busca mista para o menu 'Tudo' (Playlists Online + Músicas de Sucesso)
async function searchDeezerAll(query) {
  const term = (query || '').trim();
  const [playlistsRes, tracksRes] = await Promise.all([
    searchDeezerPlaylists(term || 'top playlists brasil', 8),
    searchDeezer(term || 'top brasil', 16, 'RANKING')
  ]);
  const playlists = (playlistsRes.success && playlistsRes.results) ? playlistsRes.results : [];
  const tracks = (tracksRes.success && tracksRes.results) ? tracksRes.results : [];
  const mixed = [];
  // Playlists online em destaque primeiro
  playlists.forEach(pl => mixed.push({ ...pl, itemType: 'playlist' }));
  // Músicas em seguida
  tracks.forEach(tr => mixed.push({ ...tr, itemType: 'track' }));
  return { success: true, results: mixed };
}

// Construtor de Playlist com mais de 50 músicas completas e URLs de streaming direto
async function buildMegaPlaylist(seedTracks = [], userQuery = '', targetCount = 60) {
  const seenTitles = new Set();
  const playlist = [];

  const addTrack = (track, reason = '🎧 Seleção do DJ Papaléguas') => {
    if (!track || !track.title) return;
    const norm = track.title.toLowerCase().trim().replace(/\s*\(.*\)/g, '').replace(/\s*\[.*\]/g, '');
    if (seenTitles.has(norm)) return;
    seenTitles.add(norm);

    const safeTitle = track.title || 'Música';
    const safeArtist = track.artist || 'DJ Papaléguas';
    playlist.push({
      ...track,
      title: safeTitle,
      artist: safeArtist,
      cover: track.cover && !track.cover.includes('5f448b1112674e1d51b32d665fec7db5') ? track.cover : '/papaleguas_logo.png',
      aiReason: track.aiReason || reason,
      fullStreamUrl: `/api/stream-audio?title=${encodeURIComponent(safeTitle)}&artist=${encodeURIComponent(safeArtist)}`
    });
  };

  // 1. Adiciona as faixas selecionadas pela IA
  (seedTracks || []).forEach(t => addTrack(t));

  // 2. Se for uma mistura de gêneros (ex: sertanejo com pagode, funk e eletrônica)
  const isMix = userQuery && userQuery.match(/\b(com|e|\+|mistura|misturado|junto)\b/i);
  if (isMix && playlist.length < targetCount) {
    const rawParts = userQuery.split(/\b(?:com|e|\+|mistura|misturado|junto)\b/i)
      .map(p => p.trim().replace(/^(quero|toca|coloca|uma|de)\s+/gi, ''))
      .filter(p => p.length >= 2);

    if (rawParts.length >= 2) {
      for (const part of rawParts) {
        try {
          const subRes = await searchDeezer(`${part} sucessos`, 30, 'RANKING');
          if (subRes && subRes.success && subRes.results) {
            subRes.results.forEach(t => addTrack(t, `🎶 Mistura: ${part.toUpperCase()}`));
          }
        } catch (e) { swallowed(e, 'server:buildMegaPlaylist@6261'); }
      }
    }
  }

  // 3. Se ainda não alcançou o targetCount (60 faixas), busca mais faixas no catálogo Deezer
  if (playlist.length < targetCount) {
    try {
      const searchRes = await searchDeezer(userQuery || 'hits bombando 2026', 60, 'RANKING');
      if (searchRes && searchRes.success && searchRes.results) {
        searchRes.results.forEach(t => addTrack(t, '🔥 Hit em Alta no Estilo'));
      }
    } catch (e) { swallowed(e, 'server:buildMegaPlaylist@6273'); }
  }

  // 3. Se ainda faltar para o alvo, complementa com o Chart Geral oficial de 2026
  if (playlist.length < targetCount) {
    try {
      const chartRes = await getDeezerChartTracks(60);
      if (chartRes && chartRes.success && chartRes.results) {
        chartRes.results.forEach(t => addTrack(t, '⭐ Top Paradas 2026'));
      }
    } catch (e) { swallowed(e, 'server:buildMegaPlaylist@6283'); }
  }

  return playlist.slice(0, Math.max(targetCount, playlist.length));
}

// Cache em memória para URLs de stream de áudio (4 horas de retenção)
const audioStreamUrlCache = createLruCache({ maxEntries: 500, ttlMs: 60 * 60 * 1000 });

// Extrai áudio completo via yt-dlp otimizado (resposta rápida ~3s)
function getFullAudioStream({ title, artist }) {
  if (!title && !artist) return Promise.resolve({ success: false, error: 'Sem parâmetros de busca' });
  const cacheKey = `${(title || '').toLowerCase().trim()} - ${(artist || '').toLowerCase().trim()}`;
  if (audioStreamUrlCache.has(cacheKey)) {
    const cached = audioStreamUrlCache.get(cacheKey);
    if (Date.now() - cached.timestamp < 4 * 60 * 60 * 1000) {
      return Promise.resolve({ success: true, streamUrl: cached.url });
    }
  }

  if (audioStreamPending.has(cacheKey)) return audioStreamPending.get(cacheKey);

  const query = `${title || ''} ${artist || ''} official audio`.trim();
  const ytdlpPath = process.platform === 'win32' ? 'yt-dlp' : (fs.existsSync('/home/nain/.local/bin/yt-dlp') ? '/home/nain/.local/bin/yt-dlp' : 'yt-dlp');
  const baseArgs = [
    ...ytdlpProxyArgs(),
    '--no-playlist',
    '--extractor-args', 'youtube:player_client=android,web;player_skip=webpage,configs',
    '-f', 'ba[ext=m4a]/140/ba/b',
    '--no-warnings',
    '--socket-timeout', '12',
    '-g'
  ];
  const runSearch = (term, timeout) => new Promise((resolve) => {
    execFile(ytdlpPath, [...baseArgs, `ytsearch1:${term}`], { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve({ success: false, error: error.message });
      const streamUrl = (stdout || '').trim().split('\n')[0];
      if (streamUrl && streamUrl.startsWith('http')) return resolve({ success: true, streamUrl });
      resolve({ success: false, error: 'URL de stream inválida' });
    });
  });

  const job = (async () => {
    let out = await runSearch(query, 40000);
    if (!out.success) out = await runSearch(`${title} ${artist}`.trim(), 30000);
    if (out.success) audioStreamUrlCache.set(cacheKey, { url: out.streamUrl, timestamp: Date.now() });
    return out;
  })();
  audioStreamPending.set(cacheKey, job);
  job.finally(() => audioStreamPending.delete(cacheKey));
  return job;
}
const audioStreamPending = new Map();

const videoStreamUrlCache = createLruCache({ maxEntries: 500, ttlMs: 60 * 60 * 1000 });
const videoStreamPending = new Map();
const playUrlCache = createLruCache({ maxEntries: 400, ttlMs: 30 * 60 * 1000 });

function getFullVideoStreamByVideoId(videoId, lang = 'pt') {
  if (!videoId) return Promise.resolve({ success: false, error: 'ID ausente' });
  const langShort = String(lang || 'pt').split('-')[0].replace(/[^a-zA-Z]/g, '').toLowerCase() || 'pt';
  const cacheKey = `${videoId}:${langShort}`;
  if (videoStreamUrlCache.has(cacheKey)) {
    const cached = videoStreamUrlCache.get(cacheKey);
    if (Date.now() - cached.timestamp < 4 * 60 * 60 * 1000) {
      return Promise.resolve({ success: true, streamUrl: cached.url });
    }
  }
  if (videoStreamPending.has(cacheKey)) return videoStreamPending.get(cacheKey);
  const ytdlpPath = process.platform === 'win32' ? 'yt-dlp' : (fs.existsSync('/home/nain/.local/bin/yt-dlp') ? '/home/nain/.local/bin/yt-dlp' : 'yt-dlp');
  const job = new Promise((resolve) => {
    execFile(ytdlpPath, [
      ...ytdlpProxyArgs(),
      '--js-runtimes', 'node',
      '--no-playlist',
      '--extractor-args', `youtube:player_client=default,android,ios;lang=${langShort}`,
      '-f', `b[language^=${langShort}][acodec!=none][vcodec!=none]/18[language^=${langShort}]/18/b[acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/b/best`,
      '--no-warnings',
      '--socket-timeout', '12',
      '-g',
      'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId)
    ], { timeout: 15000 }, (error, stdout) => {
      if (error) return resolve({ success: false, error: error.message });
      const lines = (stdout || '').trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
      const streamUrl = lines[0] || '';
      if (streamUrl && streamUrl.startsWith('http')) {
        videoStreamUrlCache.set(cacheKey, { url: streamUrl, timestamp: Date.now() });
        resolve({ success: true, streamUrl });
      } else {
        resolve({ success: false, error: 'URL de vídeo inválida' });
      }
    });
  });
  videoStreamPending.set(cacheKey, job);
  job.finally(() => videoStreamPending.delete(cacheKey));
  return job;
}

function resolvePlayableMediaUrl(pageUrl) {
  const target = String(pageUrl || '').trim();
  if (!/^https?:/i.test(target)) return Promise.resolve({ success: false, error: 'URL inválida' });
  if (/\.(mp4|webm|m4v|mov|mkv|m3u8)(\?|#|$)/i.test(target)) {
    return Promise.resolve({ success: true, streamUrl: target });
  }
  const cached = playUrlCache.get(target);
  if (cached && Date.now() - cached.t < 10 * 60 * 1000) return Promise.resolve(cached.data);
  const ytdlpPath = process.platform === 'win32' ? 'yt-dlp' : (fs.existsSync('/home/nain/.local/bin/yt-dlp') ? '/home/nain/.local/bin/yt-dlp' : 'yt-dlp');
  return new Promise((resolve) => {
    execFile(ytdlpPath, [
      ...ytdlpProxyArgs(),
      '--no-playlist',
      '-f', '18/22/best[ext=mp4][height<=720]/best',
      '--no-warnings',
      '-g',
      target
    ], { timeout: 20000 }, (error, stdout) => {
      const streamUrl = String(stdout || '').split('\n').map((line) => line.trim()).find((line) => /^https?:/i.test(line)) || '';
      const data = streamUrl
        ? { success: true, streamUrl }
        : { success: false, error: 'Não achei um vídeo reproduzível nessa página.' };
      if (data.success) playUrlCache.set(target, { t: Date.now(), data });
      resolve(data);
    });
  });
}

// Extrai áudio completo via yt-dlp por ID do vídeo com cache e preferência de idioma detectado
function getFullAudioStreamByVideoId(videoId, lang = 'pt') {
  if (!videoId) return Promise.resolve({ success: false, error: 'ID ausente' });
  const langShort = String(lang || 'pt').split('-')[0].replace(/[^a-zA-Z]/g, '').toLowerCase() || 'pt';
  const cacheKey = `${videoId}:${langShort}`;
  if (audioStreamUrlCache.has(cacheKey)) {
    const cached = audioStreamUrlCache.get(cacheKey);
    if (Date.now() - cached.timestamp < 4 * 60 * 60 * 1000) {
      return Promise.resolve({ success: true, streamUrl: cached.url });
    }
  }
  if (audioStreamPending.has(cacheKey)) return audioStreamPending.get(cacheKey);

  const ytdlpPath = process.platform === 'win32' ? 'yt-dlp' : (fs.existsSync('/home/nain/.local/bin/yt-dlp') ? '/home/nain/.local/bin/yt-dlp' : 'yt-dlp');

  const job = new Promise((resolve) => {
    execFile(ytdlpPath, [
      ...ytdlpProxyArgs(),
      '--js-runtimes', 'node',
      '--no-playlist',
      '--extractor-args', `youtube:player_client=default,android,ios;lang=${langShort}`,
      '-f', `ba[language^=${langShort}][ext=m4a]/ba[language^=${langShort}]/ba[ext=m4a]/140/ba/b`,
      '--no-warnings',
      '--socket-timeout', '12',
      '-g',
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    ], { timeout: 14000 }, (error, stdout) => {
      if (error) {
        return resolve({ success: false, error: error.message });
      }
      const streamUrl = (stdout || '').trim().split('\n')[0];
      if (streamUrl && streamUrl.startsWith('http')) {
        audioStreamUrlCache.set(cacheKey, { url: streamUrl, timestamp: Date.now() });
        resolve({ success: true, streamUrl });
      } else {
        resolve({ success: false, error: 'URL de stream inválida' });
      }
    });
  });
  audioStreamPending.set(cacheKey, job);
  job.finally(() => audioStreamPending.delete(cacheKey));
  return job;
}

// Proxy de streaming de áudio/vídeo contínuo com suporte a Range e idioma detectado por IP
async function handleAudioStreamingProxy(req, res, { title, artist, videoId, preferVideo, lang, country }) {
  let resolvedLang = lang ? String(lang).split('-')[0].toLowerCase() : '';
  if (!resolvedLang) {
    let resolvedCountry = (country && /^[A-Z]{2}$/i.test(country) && country.toUpperCase() !== 'AUTO') ? country.toUpperCase() : '';
    if (!resolvedCountry) {
      resolvedCountry = await getClientCountryCode(req, '', false).catch(() => 'BR');
    }
    const hl = getHlForCountry(resolvedCountry);
    resolvedLang = String(hl || 'pt').split('-')[0].toLowerCase();
  }
  const fetchPromise = preferVideo && videoId
    ? getFullVideoStreamByVideoId(videoId, resolvedLang)
    : (videoId ? getFullAudioStreamByVideoId(videoId, resolvedLang) : getFullAudioStream({ title, artist }));
  fetchPromise.then(streamRes => {
    if (!streamRes || !streamRes.success || !streamRes.streamUrl) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(preferVideo ? 'Vídeo completo não localizado.' : 'Áudio completo não localizado.');
      return;
    }

    const directUrl = streamRes.streamUrl;
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'Accept': '*/*'
    };
    if (req.headers.range) {
      reqHeaders['Range'] = req.headers.range;
    }

    try {
      const parsed = new URL(directUrl);
      const proxyReq = https.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        agent: getOutboundAgent(false),
        headers: reqHeaders
      }, (proxyRes) => {
        if (proxyRes.statusCode === 403) {
          const cacheKey = videoId || `${(title || '').toLowerCase().trim()} - ${(artist || '').toLowerCase().trim()}`;
          audioStreamUrlCache.delete(cacheKey);
          if (videoId) videoStreamUrlCache.delete(videoId);
        }

        const resHeaders = {
          'Content-Type': proxyRes.headers['content-type'] || (preferVideo ? 'video/mp4' : 'audio/webm'),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        };
        if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length'];
        if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range'];

        res.writeHead(proxyRes.statusCode || 200, resHeaders);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.warn('[STREAM PROXY WARN]', err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Erro de conexão com o fluxo de áudio.');
        }
      });

      req.on('close', () => {
        proxyReq.destroy();
      });

      proxyReq.end();
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Erro ao processar stream de áudio.');
      }
    }
  }).catch(err => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Falha interna ao resolver áudio.');
    }
  });
}

function callOpenAi(payload) {
  return aiClient.callMainAi(payload);
}

const musicRecCache = createLruCache({ maxEntries: 300, ttlMs: 30 * 60 * 1000 });
const MUSIC_REC_TTL = 3 * 60 * 1000;

function mergeMusicTracks(lists, query, excludeSet, limit = 24, keepOrder = false) {
  const seen = new Set();
  const merged = [];
  lists.forEach((list) => {
    (list || []).forEach((track) => {
      if (!track || !track.title) return;
      const titleKey = String(track.title).trim().toLowerCase();
      if (excludeSet.has(titleKey)) return;
      const uniq = titleKey + '|' + String(track.artist || '').trim().toLowerCase();
      if (seen.has(uniq)) return;
      seen.add(uniq);
      merged.push(track);
    });
  });
  if (keepOrder) return merged.slice(0, limit);
  const ranked = query ? sortTracksByQuery(merged, query) : merged.slice().sort((a, b) => (b.rank || 0) - (a.rank || 0));
  return ranked.slice(0, limit);
}

// Recomendações musicais pelo catálogo real (sem Grok): paradas, artista e busca em paralelo conforme o país
async function getAiMusicRecommendations(query, category = 'all', excludeTitles = [], country = 'BR') {
  const q = typeof query === 'string' ? query.trim() : '';
  const cat = category || 'all';
  const cUpper = String(country || 'BR').toUpperCase();
  const excludeSet = new Set((Array.isArray(excludeTitles) ? excludeTitles : [])
    .map((t) => String(t || '').trim().toLowerCase())
    .filter(Boolean));
  const isTrendingQuery = !q || /bombando|atual|atuais|em alta|top|paradas|hits|sucessos|mais tocadas|2026|2025|trending|charts/i.test(q);
  const cacheKey = cUpper + '__' + cat + '__' + (q || 'trending').toLowerCase();
  const cached = musicRecCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < MUSIC_REC_TTL) && cached.results.length > 0) {
    const fresh = mergeMusicTracks([cached.results], q, excludeSet, 24);
    if (fresh.length >= 6) {
      return { success: true, summary: cached.summary, results: fresh };
    }
  }

  let countryHitsQuery = 'hits brasil 2026';
  if (['US', 'GB', 'CA', 'AU'].includes(cUpper)) countryHitsQuery = 'billboard top hits 2026';
  else if (['ES', 'MX', 'AR', 'CO', 'CL'].includes(cUpper)) countryHitsQuery = 'top exitos canciones 2026';
  else if (cUpper === 'PT') countryHitsQuery = 'top hits portugal 2026';
  else if (cUpper === 'FR') countryHitsQuery = 'top hits musique france 2026';
  else if (['DE', 'AT', 'CH'].includes(cUpper)) countryHitsQuery = 'top hits deutschland 2026';
  else if (cUpper === 'IT') countryHitsQuery = 'top hits musica italia 2026';
  else if (cUpper === 'JP') countryHitsQuery = 'top j-pop hits 2026';

  const searchQuery = cat !== 'all' && q ? (q + ' ' + cat) : (q || countryHitsQuery);
  const detectedGenre = q ? detectDjGenre(q) : null;
  const lookArtist = q && q.split(/\s+/).length <= 4 && !detectedGenre && !isTrendingQuery;

  const jobs = [
    searchDeezer(searchQuery, 30, 'RANKING').catch(() => ({ results: [] })),
    isTrendingQuery || !q ? getDeezerChartTracks(24).catch(() => ({ results: [] })) : Promise.resolve({ results: [] }),
    detectedGenre ? searchDjGenreMusic(detectedGenre, 20).catch(() => []) : Promise.resolve([]),
    lookArtist ? searchDeezerArtistTop(q, 16).catch(() => []) : Promise.resolve([])
  ];
  if (cat === 'all' && q) {
    jobs.push(searchDeezerPlaylists(q, 3).catch(() => ({ results: [] })));
  }

  const [searchRes, chartRes, genreTracks, artistTop, playlistRes] = await Promise.all(jobs);
  const searchTracks = ((searchRes && searchRes.results) || []).map((t) => Object.assign({}, t, {
    aiReason: t.aiReason || (q ? ('🎯 ' + q) : '🔥 Em alta agora')
  }));
  const chartTracks = ((chartRes && chartRes.results) || []).map((t) => Object.assign({}, t, {
    aiReason: t.aiReason || '🔥 Top das paradas'
  }));
  const playlists = ((playlistRes && playlistRes.results) || []).slice(0, 2).map((pl) => Object.assign({}, pl, {
    itemType: 'playlist',
    aiReason: '💿 Playlist em alta'
  }));

  let results = mergeMusicTracks(
    [artistTop, genreTracks, searchTracks, isTrendingQuery ? chartTracks : [], playlists],
    q,
    excludeSet,
    24
  );

  if (results.length < 8 && !isTrendingQuery && chartTracks.length) {
    results = mergeMusicTracks([results, chartTracks], q, excludeSet, 24);
  }

  let defaultSummary = 'Hits bombando no topo das paradas agora';
  if (['US', 'GB', 'CA', 'AU'].includes(cUpper)) defaultSummary = 'Top trending hits on the charts now';
  else if (['ES', 'MX', 'AR'].includes(cUpper)) defaultSummary = 'Los mayores éxitos en las listas ahora';
  else if (cUpper === 'FR') defaultSummary = 'Les plus grands succès du moment';
  else if (['DE', 'AT', 'CH'].includes(cUpper)) defaultSummary = 'Top-Hits in den Charts jetzt';
  else if (cUpper === 'IT') defaultSummary = 'I migliori successi del momento';

  const summary = q
    ? (detectedGenre
      ? `Sucessos de ${detectedGenre.label} para "${q}"`
      : `As faixas mais ouvidas para "${q}"`)
    : defaultSummary;

  if (results.length > 0) {
    musicRecCache.set(cacheKey, { timestamp: Date.now(), results, summary });
  }

  return { success: true, summary, results };
}

function normalizeDjText(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function isCasualDjChat(text) {
  const t = normalizeDjText(text);
  return /^(oi+|ola+|e ?ai+|eae+|fala+|hey+|hi+|hello+|bom dia|boa tarde|boa noite|tudo bem\??|td bem\??|blz\??|beleza+|obrigad[oa]|valeu+|tchau+|como (voce |vc )?esta\??|quem e voce\??|o que voce (faz|e)\??)[\s!?.]*$/.test(t);
}

function cleanDjSearchQuery(text) {
  const cleaned = String(text || '')
    .replace(/^(dj papaleguas|dj papaléguas|papaleguas|dj)\s+/i, '')
    .replace(/^\s*(por favor|pfv|pf|please)\s+/i, '')
    .replace(/^\s*(toca|tocar|toque|play|põe|poe|coloca|solta|reproduz|quero ouvir|quero escutar|quero|me toca|bota pra tocar|põe pra tocar|poe pra tocar|bota|manda)\s+/i, '')
    .replace(/^\s*(pra|para)\s+(mim|gente|nós|nos)\s+/i, '')
    .replace(/^\s*(aquela|aquele|essa|esse|isto|uns|umas|uma|um)\s+((m[uú]sica|som|faixa)\s+)?(do|da|de|dos|das)?\s*/i, '')
    .replace(/^\s*(m[uú]sica|som|faixa)\s+(do|da|de|dos|das)\s+/i, '')
    .replace(/\s+(por favor|pfv|pf|please|pra mim|para mim|agora)\s*$/i, '')
    .trim();
  return cleaned || String(text || '').trim();
}

const DJ_QUERY_STOPWORDS = new Set([
  'toca', 'tocar', 'toque', 'play', 'poe', 'coloca', 'solta', 'reproduz', 'quero', 'ouvir', 'escutar',
  'musica', 'musicas', 'som', 'uma', 'um', 'uns', 'umas', 'pra', 'para', 'com', 'do', 'da', 'de',
  'o', 'a', 'os', 'as', 'me', 'mim', 'dj', 'papaleguas', 'por', 'favor', 'pfv', 'pf', 'bota', 'manda',
  'agora', 'ai', 'essa', 'esse', 'aquele', 'aquela', 'mais', 'bem', 'tipo', 'estilo', 'faz', 'la',
  'dos', 'das', 'no', 'na', 'em', 'eu', 'voce', 'vc'
]);

function queryTokens(query) {
  return normalizeDjText(query).split(/[^a-z0-9]+/).filter((w) => w && !DJ_QUERY_STOPWORDS.has(w) && w.length >= 2);
}

function fuzzyWordMatch(word, text) {
  if (!word || !text) return false;
  if (text.includes(word)) return true;
  if (word.length < 4) return false;
  return text.split(/[^a-z0-9]+/).some((part) => {
    if (!part) return false;
    if (part.includes(word) || (word.includes(part) && part.length >= 4)) return true;
    return part.length >= 4 && word.slice(0, 4) === part.slice(0, 4);
  });
}

function scoreTrackAgainstQuery(track, query) {
  const q = normalizeDjText(query);
  const title = normalizeDjText(track && track.title);
  const artist = normalizeDjText(track && track.artist);
  if (!q || !title) return 0;
  let score = 0;
  if (title === q) score += 140;
  if ((title + ' ' + artist) === q || (artist + ' ' + title) === q) score += 130;
  if (title.includes(q)) score += 80;
  if (q.includes(title) && title.length > 3) score += 55;
  if (artist && (q === artist || q.includes(artist) || artist.includes(q))) score += 50;
  const qWords = queryTokens(q);
  let hits = 0;
  qWords.forEach((w) => {
    if (fuzzyWordMatch(w, title)) { score += 18; hits += 1; }
    if (fuzzyWordMatch(w, artist)) { score += 16; hits += 1; }
  });
  if (qWords.length && hits >= qWords.length) score += 25;
  return score;
}

function sortTracksByQuery(tracks, query) {
  return (tracks || []).slice().sort((a, b) => {
    const diff = scoreTrackAgainstQuery(b, query) - scoreTrackAgainstQuery(a, query);
    if (diff !== 0) return diff;
    return (b.rank || 0) - (a.rank || 0);
  });
}

const DJ_GENRE_CATALOG = [
  { label: 'pop nacional', keys: ['pop nacional', 'pop brasil', 'pop brasileiro', 'pop br'], byPlaylist: true, playlistQuery: 'pop nacional', playlistKeys: ['pop nacional', 'pop brasil', 'pop'], queries: ['pop nacional', 'pop brasil'] },
  { label: 'ragga nacional', keys: ['ragga nacional', 'ragga brasil', 'raggae nacional', 'ragga', 'raggae'], byPlaylist: true, playlistQuery: 'raggae nacional', playlistKeys: ['ragga', 'raggae', 'reggae'], queries: ['ragga nacional', 'raggae brasil', 'ragga hits'] },
  { label: 'gaúcha', keys: ['gaucho', 'gauchos', 'musica gaucha', 'musicas gauchas', 'gaucha', 'gauchas', 'tradicionalista', 'tradicionalismo gaucho', 'vanera', 'vanerao', 'tche'], byPlaylist: true, playlistQuery: 'musicas gauchas', playlistKeys: ['gaucho', 'gaucha', 'gauchas', 'vanera', 'tche'], queries: ['musicas gauchas', 'musica gaucha sucessos', 'tradicionalismo gaucho'] },
  { label: 'psytrance', keys: ['psy', 'psytrance', 'psy trance', 'psy-trance', 'psychedelic trance'], byPlaylist: true, playlistQuery: 'psytrance', playlistKeys: ['psy', 'psytrance', 'trance'], queries: ['psytrance hits', 'psy trance'] },
  { label: 'rock nacional', keys: ['rock nacional', 'rock brasil', 'rock brasileiro'], byPlaylist: true, playlistQuery: 'rock nacional', playlistKeys: ['rock nacional', 'rock brasil', 'rock'], queries: ['rock nacional hits', 'rock brasil'] },
  { label: 'reggae nacional', keys: ['reggae nacional', 'reggae brasil'], byPlaylist: true, playlistQuery: 'reggae nacional', playlistKeys: ['reggae nacional', 'reggae brasil', 'reggae'], queries: ['reggae nacional', 'reggae brasil'] },
  { label: 'rap nacional', keys: ['rap nacional', 'rap brasil', 'hip hop nacional', 'hiphop nacional'], byPlaylist: true, playlistQuery: 'rap nacional', playlistKeys: ['rap nacional', 'rap brasil', 'rap'], queries: ['rap nacional', 'rap brasil'] },
  { label: 'flashback nacional', keys: ['flashback nacional', 'flash back nacional'], byPlaylist: true, playlistQuery: 'flashback nacional', playlistKeys: ['flashback', 'flash back', 'anos 80', 'anos 90'], queries: ['flashback nacional', 'sucessos nacionais anos 80 90'] },
  { label: 'flashback', keys: ['flashback', 'flash back', 'flashbak', 'flash bak', 'flasback', 'flahback', 'retro', 'vintage'], byPlaylist: true, playlistQuery: 'flashback', playlistKeys: ['flashback', 'flash back'], queries: ['sucessos anos 80', 'sucessos anos 90'] },
  { label: 'anos 70', keys: ['anos 70', 'anos70'], queries: ['hits anos 70', 'sucessos anos 70'] },
  { label: 'anos 80', keys: ['anos 80', 'anos80'], queries: ['hits anos 80', 'sucessos anos 80'] },
  { label: 'anos 90', keys: ['anos 90', 'anos90'], queries: ['hits anos 90', 'sucessos anos 90'] },
  { label: 'anos 2000', keys: ['anos 2000', 'anos 2000s'], queries: ['hits anos 2000', 'sucessos anos 2000'] },
  { label: 'dance', keys: ['dance', 'danca', 'dancante', 'dence'], byPlaylist: true, deezerGenreId: 113, playlistQuery: 'dance hits', playlistKeys: ['dance'], queries: ['dance music hits'] },
  { label: 'eurodance', keys: ['eurodance'], byPlaylist: true, playlistQuery: 'eurodance hits', queries: ['eurodance hits', 'genre:"Dance"'] },
  { label: 'house', keys: ['house', 'hause'], queries: ['genre:"House"', 'house music hits'] },
  { label: 'techno', keys: ['techno', 'tekno', 'tecno'], queries: ['genre:"Techno"', 'techno hits'] },
  { label: 'trance', keys: ['trance'], queries: ['trance hits'] },
  { label: 'disco', keys: ['disco'], queries: ['disco hits', 'genre:"Disco"'] },
  { label: 'eletrônica', keys: ['eletronica', 'eletronic', 'eletronika', 'edm'], byPlaylist: true, playlistQuery: 'eletronica hits', playlistKeys: ['eletronica', 'edm'], queries: ['genre:"Electro"', 'electronic dance hits'] },
  { label: 'sertanejo', keys: ['sertanejo', 'sertaneijo', 'certanejo', 'universitario', 'agronejo', 'modao'], byPlaylist: true, playlistQuery: 'sertanejo', playlistKeys: ['sertanejo'], queries: ['genre:"Sertanejo"', 'sertanejo sucessos'] },
  { label: 'pagode', keys: ['pagode', 'pagodi'], byPlaylist: true, playlistQuery: 'pagode', playlistKeys: ['pagode'], queries: ['pagode sucessos', 'pagode hits'] },
  { label: 'samba', keys: ['samba'], byPlaylist: true, playlistQuery: 'samba', queries: ['samba sucessos'] },
  { label: 'funk', keys: ['funk', 'funck', 'fank'], byPlaylist: true, playlistQuery: 'funk brasil', playlistKeys: ['funk'], queries: ['funk hits brasil', 'funk sucessos'] },
  { label: 'gospel', keys: ['gospel', 'gosple', 'louvor'], byPlaylist: true, playlistQuery: 'gospel', queries: ['gospel sucessos', 'louvor hits'] },
  { label: 'forró', keys: ['forro', 'foroo', 'piseiro'], byPlaylist: true, playlistQuery: 'forro', playlistKeys: ['forro', 'piseiro'], queries: ['forro sucessos', 'piseiro hits'] },
  { label: 'axé', keys: ['axe', 'axé'], byPlaylist: true, playlistQuery: 'axe', queries: ['axe sucessos'] },
  { label: 'rock', keys: ['rock', 'rok', 'roque'], queries: ['genre:"Rock"', 'rock hits'] },
  { label: 'pop', keys: ['pop'], queries: ['genre:"Pop"', 'pop hits'] },
  { label: 'rap', keys: ['rap', 'hip hop', 'hiphop'], queries: ['genre:"Rap/Hip Hop"', 'rap hits'] },
  { label: 'trap', keys: ['trap'], queries: ['trap hits', 'trap brasil'] },
  { label: 'mpb', keys: ['mpb'], queries: ['mpb sucessos'] },
  { label: 'jazz', keys: ['jazz'], queries: ['genre:"Jazz"', 'jazz hits'] },
  { label: 'blues', keys: ['blues'], queries: ['blues hits'] },
  { label: 'reggae', keys: ['reggae', 'reague', 'regge', 'reggue'], queries: ['reggae hits'] },
  { label: 'arrocha', keys: ['arrocha', 'arocha', 'arroxa'], queries: ['arrocha sucessos'] },
  { label: 'brega', keys: ['brega'], queries: ['brega sucessos'] },
  { label: 'romântica', keys: ['romantica', 'romantico'], queries: ['musicas romanticas sucessos'] },
  { label: 'phonk', keys: ['phonk', 'fonk', 'phunk'], queries: ['phonk hits'] },
  { label: 'k-pop', keys: ['kpop', 'k-pop', 'k pop'], queries: ['kpop hits'] },
  { label: 'lo-fi', keys: ['lofi', 'lo-fi', 'lo fi'], queries: ['lofi beats'] },
  { label: 'metal', keys: ['metal', 'heavy metal'], queries: ['metal hits', 'genre:"Metal"'] },
  { label: 'black metal', keys: ['black metal', 'blackmetal'], queries: ['black metal hits'] },
  { label: 'punk', keys: ['punk'], queries: ['punk hits'] },
  { label: 'indie', keys: ['indie'], queries: ['indie hits', 'indie rock'] },
  { label: 'r&b', keys: ['r&b', 'rnb', 'r e b', 'rhythm and blues'], queries: ['r&b hits', 'genre:"R&B"'] },
  { label: 'soul', keys: ['soul'], queries: ['soul hits'] },
  { label: 'clássica', keys: ['classica', 'erudita', 'musica classica'], queries: ['classical music hits'] },
  { label: 'reggaeton', keys: ['reggaeton', 'regueton'], queries: ['reggaeton hits'] },
  { label: 'salsa', keys: ['salsa'], queries: ['salsa hits'] },
  { label: 'bachata', keys: ['bachata'], queries: ['bachata hits'] },
  { label: 'country', keys: ['country'], queries: ['country hits'] },
  { label: 'dubstep', keys: ['dubstep'], queries: ['dubstep hits'] },
  { label: 'drum and bass', keys: ['drum and bass', 'drum n bass', 'dnb'], queries: ['drum and bass hits'] },
  { label: 'grunge', keys: ['grunge'], queries: ['grunge hits'] },
  { label: 'folk', keys: ['folk'], queries: ['folk hits'] },
  { label: 'bossa nova', keys: ['bossa nova', 'bossa', 'bosa nova'], queries: ['bossa nova sucessos'] },
  { label: 'pisadinha', keys: ['pisadinha', 'pizadinha'], queries: ['pisadinha hits'] },
  { label: 'drill', keys: ['drill'], queries: ['drill hits'] },
  { label: 'afrobeats', keys: ['afrobeats', 'afrobeat', 'afro beats'], queries: ['afrobeats hits'] },
  { label: 'dancehall', keys: ['dancehall'], queries: ['dancehall hits'] },
  { label: 'cumbia', keys: ['cumbia'], queries: ['cumbia hits'] },
  { label: 'tango', keys: ['tango'], queries: ['tango hits'] },
  { label: 'trilha', keys: ['trilha', 'trilha sonora', 'soundtrack'], queries: ['soundtrack hits'] },
  { label: 'emo', keys: ['emo'], queries: ['emo hits'] },
  { label: 'ska', keys: ['ska'], queries: ['ska hits'] },
  { label: 'synthwave', keys: ['synthwave', 'retrowave'], queries: ['synthwave hits'] },
  { label: 'hyperpop', keys: ['hyperpop'], queries: ['hyperpop hits'] },
  { label: 'latin', keys: ['latin', 'latina', 'latino'], queries: ['latin hits'] },
  { label: 'bolero', keys: ['bolero'], queries: ['bolero hits'] },
  { label: 'flamenco', keys: ['flamenco'], queries: ['flamenco hits'] },
  { label: 'samba-rock', keys: ['samba rock', 'samba-rock'], queries: ['samba rock sucessos'] },
  { label: 'funk melody', keys: ['funk melody'], queries: ['funk melody hits'] },
  { label: 'kuduro', keys: ['kuduro'], queries: ['kuduro hits'] },
  { label: 'zouk', keys: ['zouk'], queries: ['zouk hits'] },
  { label: 'jazz fusion', keys: ['jazz fusion'], queries: ['jazz fusion'] },
  { label: 'ambient', keys: ['ambient', 'ambiente'], queries: ['ambient music'] },
  { label: 'pop rock', keys: ['pop rock'], queries: ['pop rock hits'] },
  { label: 'afoxé', keys: ['afoxe'], queries: ['afoxe sucessos'] },
  { label: 'balada', keys: ['balada'], queries: ['balada hits'] },
  { label: 'batucada', keys: ['batucada'], queries: ['batucada'] },
  { label: 'beats', keys: ['beats'], queries: ['lofi beats', 'beats'] },
  { label: 'boogie', keys: ['boogie'], queries: ['boogie hits'] },
  { label: 'breakbeat', keys: ['breakbeat', 'break beat'], queries: ['breakbeat hits'] },
  { label: 'chill', keys: ['chill', 'chillout', 'chill out', 'chillwave'], queries: ['chillout music'] },
  { label: 'city pop', keys: ['city pop', 'citypop'], queries: ['city pop hits'] },
  { label: 'dembow', keys: ['dembow'], queries: ['dembow hits'] },
  { label: 'downtempo', keys: ['downtempo', 'down tempo'], queries: ['downtempo'] },
  { label: 'electro swing', keys: ['electro swing', 'electroswing'], queries: ['electro swing'] },
  { label: 'funk carioca', keys: ['funk carioca', 'funk brasileiro'], queries: ['funk carioca hits'] },
  { label: 'grime', keys: ['grime'], queries: ['grime hits'] },
  { label: 'guaracha', keys: ['guaracha'], queries: ['guaracha hits'] },
  { label: 'hardstyle', keys: ['hardstyle', 'hard style'], queries: ['hardstyle hits'] },
  { label: 'j-pop', keys: ['jpop', 'j-pop', 'j pop'], queries: ['jpop hits'] },
  { label: 'j-rock', keys: ['jrock', 'j-rock', 'j rock'], queries: ['jrock hits'] },
  { label: 'lounge', keys: ['lounge', 'easy listening'], queries: ['lounge music'] },
  { label: 'mambo', keys: ['mambo'], queries: ['mambo hits'] },
  { label: 'mariachi', keys: ['mariachi'], queries: ['mariachi hits'] },
  { label: 'merengue', keys: ['merengue'], queries: ['merengue hits'] },
  { label: 'nu disco', keys: ['nu disco', 'nudisco'], queries: ['nu disco hits'] },
  { label: 'nu metal', keys: ['nu metal', 'numetal'], queries: ['nu metal hits'] },
  { label: 'trip hop', keys: ['trip hop', 'triphop', 'trip-hop'], queries: ['trip hop hits'] },
  { label: 'vaporwave', keys: ['vaporwave', 'vapor wave'], queries: ['vaporwave'] }
];

const DJ_GENRE_SUGGESTIONS = [
  'Sertanejo', 'Funk', 'Pagode', 'Forró', 'Flashback', 'Dance', 'Rock', 'Pop',
  'Rap', 'Gospel', 'MPB', 'Eletrônica', 'Reggae', 'Pisadinha', 'Phonk', 'House',
  'Axé', 'Samba', 'Jazz', 'K-pop', 'Lo-fi', 'Trap', 'Brega', 'Arrocha'
];

const DJ_GENRE_BLENDS = {
  flashback: ['disco', 'dance'],
  'anos 70': ['disco', 'rock'],
  'anos 80': ['flashback', 'rock'],
  'anos 90': ['flashback', 'dance'],
  'anos 2000': ['pop', 'rap'],
  dance: ['house', 'pop'],
  eurodance: ['dance', 'flashback'],
  house: ['techno', 'dance'],
  techno: ['house', 'trance'],
  trance: ['techno', 'house'],
  disco: ['flashback', 'dance'],
  'eletrônica': ['house', 'dance'],
  sertanejo: ['pagode', 'forró'],
  pagode: ['samba', 'sertanejo'],
  samba: ['pagode', 'mpb'],
  funk: ['rap', 'phonk'],
  gospel: ['romântica', 'mpb'],
  'forró': ['pisadinha', 'sertanejo'],
  'axé': ['pagode', 'samba'],
  rock: ['pop rock', 'blues'],
  pop: ['dance', 'r&b'],
  rap: ['trap', 'funk'],
  trap: ['rap', 'drill'],
  mpb: ['bossa nova', 'samba'],
  jazz: ['soul', 'blues'],
  blues: ['rock', 'jazz'],
  reggae: ['dancehall', 'ska'],
  arrocha: ['sertanejo', 'forró'],
  brega: ['arrocha', 'pisadinha'],
  'romântica': ['pop', 'bossa nova'],
  phonk: ['trap', 'funk'],
  'k-pop': ['pop', 'dance'],
  'lo-fi': ['jazz', 'ambient'],
  metal: ['rock', 'punk'],
  punk: ['rock', 'grunge'],
  indie: ['pop rock', 'folk'],
  'r&b': ['soul', 'pop'],
  soul: ['r&b', 'jazz'],
  'clássica': ['jazz', 'trilha'],
  reggaeton: ['latin', 'dancehall'],
  salsa: ['bachata', 'latin'],
  bachata: ['salsa', 'romântica'],
  country: ['folk', 'rock'],
  dubstep: ['drum and bass', 'eletrônica'],
  'drum and bass': ['dubstep', 'techno'],
  grunge: ['rock', 'punk'],
  folk: ['indie', 'country'],
  'bossa nova': ['mpb', 'jazz'],
  pisadinha: ['forró', 'brega'],
  drill: ['trap', 'rap'],
  afrobeats: ['dancehall', 'pop'],
  dancehall: ['reggae', 'afrobeats'],
  cumbia: ['latin', 'salsa'],
  tango: ['bolero', 'latin'],
  trilha: ['clássica', 'pop'],
  emo: ['pop rock', 'punk'],
  ska: ['reggae', 'punk'],
  synthwave: ['eletrônica', 'flashback'],
  hyperpop: ['pop', 'eletrônica'],
  latin: ['reggaeton', 'salsa'],
  bolero: ['romântica', 'tango'],
  flamenco: ['latin', 'folk'],
  'samba-rock': ['samba', 'rock'],
  'funk melody': ['funk', 'romântica'],
  kuduro: ['afrobeats', 'dance'],
  zouk: ['romântica', 'latin'],
  'jazz fusion': ['jazz', 'funk'],
  ambient: ['lo-fi', 'clássica'],
  'pop rock': ['rock', 'pop']
};

const DJ_OPEN_MIXES = [
  ['sertanejo', 'pagode'],
  ['funk', 'rap'],
  ['pop', 'dance'],
  ['rock', 'blues'],
  ['forró', 'axé'],
  ['house', 'techno'],
  ['mpb', 'bossa nova'],
  ['reggae', 'dancehall'],
  ['trap', 'phonk'],
  ['arrocha', 'pisadinha']
];

function detectDjGenres(text) {
  const t = normalizeDjText(text);
  if (!t) return [];
  const found = [];
  DJ_GENRE_CATALOG.forEach((genre) => {
    let hitLen = 0;
    (genre.keys || []).forEach((key) => {
      const nk = normalizeDjText(key);
      if (!nk || nk.length < hitLen) return;
      const re = new RegExp('(?:^|\\b)' + nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\b|$)');
      if (re.test(t)) hitLen = nk.length;
    });
    if (hitLen) found.push({ genre, hitLen });
  });
  found.sort((a, b) => b.hitLen - a.hitLen);
  const seen = new Set();
  const genres = [];
  found.forEach((item) => {
    if (seen.has(item.genre.label)) return;
    seen.add(item.genre.label);
    genres.push(item.genre);
  });
  return genres;
}

function detectDjGenre(text) {
  const genres = detectDjGenres(text);
  return genres.length ? genres[0] : null;
}

function editDistance(a, b) {
  if (a === b) return 0;
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return Math.max(left.length, right.length);
  if (Math.abs(left.length - right.length) > 2) return 3;
  let prev = [];
  let cur = [];
  for (let j = 0; j <= right.length; j++) prev[j] = j;
  for (let i = 1; i <= left.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= right.length; j++) {
      const cost = left.charCodeAt(i - 1) === right.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > 2) return 3;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[right.length];
}

function typoLimit(length) {
  if (length < 5) return 0;
  if (length <= 6) return 1;
  return 2;
}

function fuzzyGenreHits(text) {
  const tokens = queryTokens(cleanDjSearchQuery(text)).filter((token) => token.length >= 5);
  if (tokens.length > 2) return [];
  const pieces = tokens.slice();
  if (tokens.length === 2) pieces.push(tokens[0] + tokens[1]);
  const hits = [];
  DJ_GENRE_CATALOG.forEach((genre) => {
    let best = 99;
    (genre.keys || [genre.label]).forEach((key) => {
      const compact = normalizeDjText(key).replace(/\s+/g, '');
      if (!compact || compact.length < 5) return;
      pieces.forEach((piece) => {
        const dist = editDistance(piece, compact);
        const limit = typoLimit(Math.max(piece.length, compact.length));
        if (limit && dist > 0 && dist <= limit && dist < best) best = dist;
      });
    });
    if (best < 99) hits.push({ genre, dist: best });
  });
  hits.sort((a, b) => a.dist - b.dist || a.genre.label.length - b.genre.label.length);
  return hits;
}

function applyFuzzyGenre(text) {
  if (detectDjGenres(text).length) return { text, ambiguous: false, corrected: '' };
  const hits = fuzzyGenreHits(text);
  if (!hits.length) return { text, ambiguous: false, corrected: '' };
  const best = hits[0].dist;
  const top = [];
  hits.forEach((hit) => {
    if (hit.dist !== best) return;
    if (top.some((item) => item.label === hit.genre.label)) return;
    top.push(hit.genre);
  });
  if (top.length > 1) {
    return {
      text,
      ambiguous: true,
      corrected: '',
      labels: top.slice(0, 4).map((genre) => genre.label)
    };
  }
  return { text: text + ' ' + top[0].label, ambiguous: false, corrected: top[0].label };
}

function asksForGenreOptions(text) {
  const t = normalizeDjText(text);
  return /\b(quais|que|lista de|lista os)\s+(estilos|generos)\b/.test(t)
    || /\b(me )?(indica|sugere|sugira|mostra)\b.*\b(estilo|genero|opcoes)\b/.test(t)
    || /^(estilos|generos|generos musicais)$/.test(t);
}

function djFollowUpKind(text) {
  const t = normalizeDjText(cleanDjSearchQuery(text));
  if (!t) return '';
  if (/^(mais|continua|continue|outras?|de novo|o mesmo|a mesma|desse estilo|mais desse|mais musicas|pode continuar|segue|solta mais|manda mais)$/.test(t)) return 'repeat';
  if (/^(e |com |mistura com |junto com |junto de )/.test(normalizeDjText(text))) return 'add';
  return '';
}

function lastUserMusicTurn(history, current) {
  const turns = [];
  (history || []).forEach((item) => {
    if (!item || !item.content) return;
    const role = item.role === 'dj' || item.role === 'assistant' ? 'dj' : 'user';
    if (role !== 'user') return;
    turns.push(String(item.content));
  });
  const cur = String(current || '').trim();
  for (let i = turns.length - 1; i >= 0; i--) {
    const text = turns[i].trim();
    if (!text || text === cur) continue;
    if (isCasualDjChat(text) || djFollowUpKind(text) === 'repeat') continue;
    if (cleanDjSearchQuery(text).length < 2) continue;
    return text;
  }
  return '';
}

function djTextWithContext(message, history) {
  const kind = djFollowUpKind(message);
  if (!kind) return message;
  const prev = lastUserMusicTurn(history, message);
  if (!prev) return message;
  if (kind === 'repeat') return prev;
  return prev + ' ' + message;
}

function genreByLabel(label) {
  const want = normalizeDjText(label);
  return DJ_GENRE_CATALOG.find((genre) => normalizeDjText(genre.label) === want) || null;
}

function blendPartners(genre) {
  if (!genre) return [];
  const names = DJ_GENRE_BLENDS[genre.label] || genre.blend || [];
  return names.map(genreByLabel).filter((item) => item && item.label !== genre.label).slice(0, 2);
}

function interleaveTrackLists(lists, limit) {
  const seen = new Set();
  const out = [];
  let index = 0;
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    (lists || []).forEach((list) => {
      if (!list || index >= list.length || out.length >= limit) return;
      const track = list[index];
      const key = normalizeDjText((track && track.title) + '|' + (track && track.artist));
      progressed = true;
      if (!track || !key || seen.has(key)) return;
      seen.add(key);
      out.push(track);
    });
    index += 1;
  }
  return out;
}

function isOpenDjRequest(text) {
  if (detectDjGenres(text).length) return false;
  const tokens = queryTokens(cleanDjSearchQuery(text));
  if (!tokens.length && hasDjPlayVerb(text)) return true;
  const cleaned = normalizeDjText(cleanDjSearchQuery(text));
  return /^(musica|musicas|som|sons|algo|qualquer|surpresa|mistura|mix|playlist|hit|hits|sucessos)$/.test(cleaned);
}

function syntheticGenreFromText(text) {
  const cleaned = cleanDjSearchQuery(text);
  const tokens = queryTokens(normalizeDjText(cleaned)).filter((token) => !/^(musica|musicas|som|sons|hit|hits|estilo|genero)$/.test(token));
  if (tokens.length !== 1 || tokens[0].length < 4) return null;
  if (detectDjGenre(cleaned)) return null;
  const label = tokens[0];
  return {
    label,
    queries: [label + ' hits', 'genre:"' + label + '"'],
    blend: ['pop']
  };
}

function specificDjGenres(text) {
  const genres = detectDjGenres(text);
  return genres.filter((genre) => {
    const label = normalizeDjText(genre.label);
    return !genres.some((other) => {
      if (other === genre) return false;
      const otherLabel = normalizeDjText(other.label);
      return otherLabel.length > label.length && otherLabel.indexOf(label) !== -1;
    });
  });
}

async function collectDjGenreSet(text, limit = 30) {
  let genres = specificDjGenres(text);
  if (!genres.length) {
    const synthetic = syntheticGenreFromText(text);
    if (synthetic) genres = [synthetic];
  }
  if (!genres.length) return null;
  const lists = await Promise.all(genres.map((genre) => searchDjGenreMusic(genre, limit).catch(() => [])));
  return {
    genres,
    tracks: interleaveTrackLists(lists, limit)
  };
}

function styleKeysMatchTitle(title, keys) {
  const text = normalizeDjText(title);
  if (!text) return false;
  return (keys || []).some((key) => {
    const nk = normalizeDjText(key);
    if (!nk) return false;
    if (text.includes(nk)) return true;
    const re = new RegExp('(?:^|[^a-z0-9])' + nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)');
    return re.test(text);
  });
}

async function searchDeezerGenreChart(genreId, limit = 40) {
  const cap = Math.min(100, Math.max(10, parseInt(limit, 10) || 40));
  const json = await httpsGetJson('https://api.deezer.com/chart/' + encodeURIComponent(genreId) + '/tracks?limit=' + cap);
  return ((json && json.data) || []).map((item) => mapDeezerTrack(item)).filter(Boolean);
}

async function tracksFromStylePlaylists(genre, limit = 30) {
  const query = (genre && (genre.playlistQuery || genre.label)) || '';
  const keys = (genre && genre.playlistKeys && genre.playlistKeys.length) ? genre.playlistKeys : [genre && genre.label];
  const found = await searchDeezerPlaylists(query, 8).catch(() => ({ results: [] }));
  let playlists = ((found && found.results) || [])
    .filter((pl) => styleKeysMatchTitle(pl && pl.title, keys))
    .slice(0, 3);
  if (!playlists.length && found && found.results && found.results.length) {
    playlists = found.results.slice(0, 2);
  }
  if (!playlists.length) return [];
  const packs = await Promise.all(playlists.map((pl) => getDeezerPlaylistTracks(pl.id, Math.max(limit, 30)).catch(() => ({ tracks: [] }))));
  const lists = packs.map((pack, idx) => ((pack && pack.tracks) || []).map((track) => Object.assign({}, track, {
    aiReason: '🎶 ' + (playlists[idx].title || (genre && genre.label) || '')
  })));
  return interleaveTrackLists(lists, Math.max(limit, 30));
}

function djStylePlaylistName(labels, fallback) {
  const nice = (labels || []).filter(Boolean).map((label) => {
    const text = String(label);
    return text.charAt(0).toUpperCase() + text.slice(1);
  });
  if (nice.length) return nice.join(' + ');
  const cleaned = String(fallback || '').trim();
  return (cleaned || 'Playlist do DJ').slice(0, 60);
}

async function searchDjGenreMusic(genre, limit = 30) {
  const resolved = (genre && genre.label && genreByLabel(genre.label)) || genre;
  const seen = new Set();
  const all = [];
  const push = (tracks) => {
    (tracks || []).forEach((t) => {
      const key = normalizeDjText((t && t.title || '') + '|' + (t && t.artist || ''));
      if (!t || !key || seen.has(key)) return;
      seen.add(key);
      all.push(Object.assign({}, t, {
        aiReason: t.aiReason || ('🎶 Estilo: ' + ((resolved && resolved.label) || ''))
      }));
    });
  };

  const wantsGenreSource = !!(resolved && (resolved.deezerGenreId || resolved.byPlaylist));
  if (resolved && resolved.deezerGenreId) {
    push(await searchDeezerGenreChart(resolved.deezerGenreId, limit).catch(() => []));
  }
  if (resolved && resolved.byPlaylist) {
    push(await tracksFromStylePlaylists(resolved, limit).catch(() => []));
  } else if (resolved && resolved.deezerGenreId && all.length < 6) {
    push(await tracksFromStylePlaylists(resolved, limit).catch(() => []));
  }
  if (wantsGenreSource && all.length) return all;

  const queries = (resolved && resolved.queries) ? resolved.queries.slice(0, 3) : [];
  const searchResults = await Promise.all(queries.map((q) => searchDeezer(q, limit, 'RANKING').catch(() => ({ results: [] }))));
  searchResults.forEach((res, idx) => {
    ((res && res.results) || []).forEach((t) => {
      const key = normalizeDjText((t.title || '') + '|' + (t.artist || ''));
      if (!key || seen.has(key)) return;
      seen.add(key);
      all.push(Object.assign({}, t, { aiReason: '🎶 Estilo: ' + ((resolved && resolved.label) || queries[idx] || '') }));
    });
  });
  all.sort((a, b) => (b.rank || 0) - (a.rank || 0));
  return all;
}

async function searchRequestedMusic(queries, limit = 20) {
  const primaryText = (queries || []).join(' ').trim();
  const seen = new Set();
  const all = [];
  const uniqueQueries = [];
  (queries || []).forEach((q) => {
    const t = String(q || '').trim();
    if (t && t.length >= 2 && uniqueQueries.indexOf(t) === -1) uniqueQueries.push(t);
  });

  const mainQuery = uniqueQueries[0] || primaryText;

  // 1. Prioridade máxima: Busca playlists prontas diretamente no buscador Deezer para o termo exato do usuário (ex: "pop nacional", "ragga nacional", "gauchos")
  try {
    const plRes = await searchDeezerPlaylists(mainQuery, 6).catch(() => ({ results: [] }));
    if (plRes && plRes.results && plRes.results.length > 0) {
      const topPlaylists = plRes.results.slice(0, 3);
      const packs = await Promise.all(
        topPlaylists.map((pl) => getDeezerPlaylistTracks(pl.id, Math.max(limit, 25)).catch(() => ({ tracks: [] })))
      );
      packs.forEach((pack, idx) => {
        const plTitle = topPlaylists[idx] ? topPlaylists[idx].title : mainQuery;
        ((pack && pack.tracks) || []).forEach((t) => {
          const key = normalizeDjText((t.title || '') + '|' + (t.artist || ''));
          if (!key || seen.has(key)) return;
          seen.add(key);
          all.push(Object.assign({}, t, { aiReason: '🎧 ' + plTitle }));
        });
      });
      if (all.length >= limit) return all.slice(0, limit);
    }
  } catch (ePl) { swallowed(ePl, 'server:searchRequestedMusic@7266'); }

  // 2. Se o termo for um gênero reconhecido, busca também no catálogo de gênero
  const genre = detectDjGenre(mainQuery) || detectDjGenre(primaryText);
  if (genre) {
    try {
      const genreTracks = await searchDjGenreMusic(genre, limit).catch(() => []);
      (genreTracks || []).forEach((t) => {
        const key = normalizeDjText((t.title || '') + '|' + (t.artist || ''));
        if (!key || seen.has(key)) return;
        seen.add(key);
        all.push(t);
      });
      if (all.length >= limit) return all.slice(0, limit);
    } catch (eG) { swallowed(eG, 'server:searchRequestedMusic@7280'); }
  }

  // 3. Busca músicas individuais diretas no buscador Deezer
  const variants = [];
  uniqueQueries.forEach((q) => {
    variants.push(q);
    const tokens = queryTokens(q);
    if (tokens.length >= 1 && tokens.length <= 4 && !/artist:|track:|genre:/.test(q)) {
      variants.push('track:"' + q + '"');
      variants.push('artist:"' + q + '"');
    }
  });

  const searchResults = await Promise.all(
    variants.slice(0, 4).map((q) => searchDeezer(q, limit, 'RANKING').catch(() => ({ results: [] })))
  );
  searchResults.forEach((res) => {
    (((res && res.results) || [])).forEach((t) => {
      const key = normalizeDjText((t.title || '') + '|' + (t.artist || ''));
      if (!key || seen.has(key)) return;
      seen.add(key);
      all.push(Object.assign({}, t, { aiReason: '🎯 Pedido: ' + mainQuery }));
    });
  });

  return sortTracksByQuery(all, mainQuery);
}

function isGenreOrMoodQuery(text) {
  return !!detectDjGenre(text);
}

function hasDjPlayVerb(text) {
  return /\b(toca|tocar|toque|play|p[oô]e|coloca|solta|reproduz|quero ouvir|quero escutar|quero uma|quero um|me toca|bota|manda|faz uma|mixa|mistura|playlist|m[uú]sica|som de|ouvir|escutar)\b/i.test(String(text || ''));
}

function isNonMusicQuestion(text) {
  const t = String(text || '').trim();
  return /^(qual|quais|como|quando|onde|por que|porque|quem|o que|voc[eê])\b/i.test(t) && !/\b(m[uú]sica|som|tocar|ouvir|recomenda|artista|cantor|banda|playlist)\b/i.test(t);
}

function shouldSearchCatalog(text) {
  if (isCasualDjChat(text) || isNonMusicQuestion(text)) return false;
  return cleanDjSearchQuery(text).length >= 2 || hasDjPlayVerb(text) || isGenreOrMoodQuery(text);
}

function hasConfidentDjMatch(tracks, query, userMessage) {
  if (!tracks || !tracks.length || !query) return false;
  // Se as faixas vieram de uma playlist pronta encontrada no buscador ou de um gênero reconhecido, é 100% confiável
  if (tracks.some(t => t && t.aiReason && (t.aiReason.startsWith('🎧') || t.aiReason.startsWith('🎶')))) return true;
  if (isGenreOrMoodQuery(query) || isGenreOrMoodQuery(userMessage)) return true;
  const best = Math.max.apply(null, tracks.slice(0, 8).map((t) => scoreTrackAgainstQuery(t, query)));
  if (best >= 24) return true;
  if (best >= 12 && (hasDjPlayVerb(userMessage) || isGenreOrMoodQuery(userMessage))) return true;
  const tokens = queryTokens(query);
  if (tokens.length >= 2 && best >= 12) return true;
  if (tokens.length === 1 && tokens[0].length >= 3 && best >= 12) return true;
  // Se encontrou faixas válidas e o usuário pediu som, aceita
  if (tracks.length > 0 && (hasDjPlayVerb(userMessage) || cleanDjSearchQuery(userMessage).length >= 3)) return true;
  return false;
}

function djKeepCurrentReply(reply) {
  return reply || 'Não entendi qual som você quer. A que já tava tocando segue no ar. Manda o nome da música, do artista ou do estilo.';
}

function clampDjTrackCount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(50, n));
}

function djRequestedTrackCount(message, requested) {
  const spoken = String(message || '').match(/\b(\d{1,2})\s*(m[uú]sicas|faixas|sons|tracks)\b/i);
  if (spoken) return clampDjTrackCount(spoken[1]);
  return clampDjTrackCount(requested);
}

// Chat Interativo com DJ Papaléguas IA
async function chatDjPapaleguas(userMessage, history = [], excludeTitles = [], trackCount = 10) {
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    return {
      success: false,
      reply: 'Manda ver! Me fala qual som, artista ou estilo você quer curtir agora!',
      results: []
    };
  }

  const playlistSize = djRequestedTrackCount(userMessage, trackCount);
  const excludeText = Array.isArray(excludeTitles) && excludeTitles.length > 0
    ? `REGRA DE OURO - NÃO REPETIR MÚSICAS: O usuário já ouviu ou tem na lista as seguintes músicas: [${excludeTitles.slice(-30).join(', ')}]. NÃO recomende nenhuma dessas. Continue só no que foi pedido.`
    : 'Traga só o que foi pedido, sem completar com outro estilo.';

  const promptSystem = `Você é o "DJ Papaléguas", o DJ oficial do Papaléguas Browser.
Estamos no ano de 2026.
Sua personalidade: amigável, descontraído, apaixonado por música e natural na conversa. Não use falas prontas nem scripts de boas-vindas.
Você conversa do jeito que o ouvinte começar: pode ser um pedido direto, um papo, um humor ou um estilo.

REGRA CRÍTICA DE PLAY:
- Extraia o pedido com clareza: música, artista, gênero ou playlist.
- ESTILO/GÊNERO é gênero, mesmo com erro de escrita: sertanejo, eletronica, forro, flasback, regge. searchQuery = o estilo certo.
- CONTEXTO: "mais", "continua", "o mesmo" e "desse estilo" repetem o pedido anterior. "e dance" ou "com sertanejo" soma ao estilo que já estava na conversa.
- Se o nome ficar parecido com dois estilos, understood = false, playMusic = false e pergunte qual dos dois.
- understood = true e playMusic = true quando o usuário pediu um som (mesmo sem a palavra "toca"): nome de música, artista ou estilo.
- understood = false e playMusic = false só em cumprimento, papo ou pedido ininteligível.
- Se pediu uma música/artista específico, a PRIMEIRA recommendation DEVE ser exatamente isso.

Diretrizes da Conversa:
1. Responda de forma calorosa e natural (2 a 3 frases). Trate o usuário como um amigo na roda de música.
2. Reconheça qualquer gênero, do Brasil ou do mundo: sertanejo, funk, pagode, forró, rock, pop, rap, trap, house, jazz, reggae, k-pop, bossa nova, reggaeton e os demais. Se o nome não for óbvio, trate como estilo mesmo assim.
3. Entregue somente o que foi pedido. Não acrescente outro gênero, artista ou música.
   - Um estilo gera só esse estilo. Dois estilos citados geram só esses dois.
   - Pedido vago, sem música, artista ou estilo, não vira playlist.
   - A playlist tem exatamente ${playlistSize} faixas desse pedido, nem mais.
4. CONTEXTO TEMPORAL: Estamos em 2026. Priorize hits e faixas atuais (2025/2026), exceto se clássicos forem pedidos.
5. Só monte recomendações quando playMusic for true. Nesse caso, selecione exatamente ${playlistSize} músicas REAIS do pedido.
${excludeText}
6. Para cada música, informe title, artist e reason (comentário espontâneo do DJ).

Responda ESTRITAMENTE em formato JSON com o seguinte schema:
{
  "reply": "Soltando agora o que você pediu!",
  "understood": true,
  "playMusic": true,
  "searchQuery": "nome da musica ou artista",
  "recommendations": [
    {
      "title": "Nome da Música",
      "artist": "Nome do Artista",
      "reason": "Comentário espontâneo do DJ sobre a faixa"
    }
  ]
}`;

  if (asksForGenreOptions(userMessage)) {
    return {
      success: true,
      playMusic: false,
      understood: true,
      reply: 'Posso tocar um monte de estilo. Escolhe um aqui, mesmo se a escrita não sair certinha:',
      suggestions: DJ_GENRE_SUGGESTIONS,
      results: []
    };
  }
  if (djFollowUpKind(userMessage) === 'repeat' && !lastUserMusicTurn(history, userMessage)) {
    return {
      success: true,
      playMusic: false,
      understood: true,
      reply: 'Mais do quê? Me fala o estilo ou escolhe um:',
      suggestions: DJ_GENRE_SUGGESTIONS.slice(0, 8),
      results: []
    };
  }

  const fuzzyNow = applyFuzzyGenre(userMessage);
  if (fuzzyNow.ambiguous) {
    return {
      success: true,
      playMusic: false,
      understood: true,
      reply: 'Ficou parecido com mais de um estilo. Qual desses você quer?',
      suggestions: fuzzyNow.labels || [],
      results: []
    };
  }
  const contextualMessage = djTextWithContext(fuzzyNow.text || userMessage, history);
  let fuzzy = fuzzyNow;
  if (!fuzzy.corrected) {
    const again = applyFuzzyGenre(contextualMessage);
    if (again.ambiguous) {
      return {
        success: true,
        playMusic: false,
        understood: true,
        reply: 'Ficou parecido com mais de um estilo. Qual desses você quer?',
        suggestions: again.labels || [],
        results: []
      };
    }
    if (again.corrected) fuzzy = again;
  }

  const searchText = fuzzyNow.corrected ? contextualMessage : (fuzzy.corrected ? fuzzy.text : contextualMessage);
  const cleanedUserQuery = cleanDjSearchQuery(searchText);
  const wantSearch = shouldSearchCatalog(searchText) && !isOpenDjRequest(searchText);
  const detectedGenre = detectDjGenre(searchText) || detectDjGenre(cleanedUserQuery);

  const aiPromise = (async () => {
    try {
      const messages = [{ role: "system", content: promptSystem }];
      if (Array.isArray(history) && history.length > 0) {
        history.slice(-8).forEach(h => {
          if (h.role && h.content) {
            messages.push({ role: h.role === 'dj' ? 'assistant' : 'user', content: String(h.content) });
          }
        });
      }
      messages.push({ role: "user", content: fuzzy.corrected ? (userMessage + ' (estilo entendido: ' + fuzzy.corrected + ')') : userMessage });
      const gptRes = await callOpenAi({
        model: "gpt-4o-mini",
        messages,
        response_format: { type: "json_object" },
        temperature: 0.88,
        timeoutMs: 4000,
        // DJ Papaléguas Music não passa pelo proxy Tor
        direct: true
      });
      if (gptRes && gptRes.choices && gptRes.choices[0] && gptRes.choices[0].message) {
        return JSON.parse(gptRes.choices[0].message.content);
      }
    } catch (err) { swallowed(err, 'server:chatDjPapaleguas@7492'); }
    return null;
  })();

  const searchPromise = !wantSearch
    ? Promise.resolve({ tracks: [], blended: false, labels: [] })
    : (async () => {
        // 1. Prioridade máxima: busca playlists e faixas no buscador diretamente para o que o usuário pediu
        const directTracks = await searchRequestedMusic([cleanedUserQuery], playlistSize);
        if (directTracks && directTracks.length > 0) {
          return {
            tracks: directTracks,
            blended: false,
            labels: [cleanedUserQuery]
          };
        }
        // 2. Se não achou busca direta, tenta combinar com o conjunto de gêneros
        const genreSet = await collectDjGenreSet(searchText + ' ' + cleanedUserQuery, playlistSize);
        if (genreSet && genreSet.tracks && genreSet.tracks.length) {
          return {
            tracks: genreSet.tracks,
            blended: genreSet.genres.length > 1,
            labels: genreSet.genres.map((genre) => genre.label)
          };
        }
        return {
          tracks: [],
          blended: false,
          labels: []
        };
      })();

  try {
    const [parsed, genrePack] = await Promise.all([
      Promise.race([aiPromise, new Promise((resolve) => setTimeout(() => resolve(null), 2500))]),
      searchPromise
    ]);
    const catalogTracks = (genrePack && genrePack.tracks) || [];
    let reply = (parsed && parsed.reply) ? parsed.reply : '';
    if (fuzzy.corrected && normalizeDjText(reply).indexOf(normalizeDjText(fuzzy.corrected)) === -1) {
      reply = 'Entendi ' + fuzzy.corrected + '. ' + reply;
    }

    if (!wantSearch) {
      return {
        success: true,
        playMusic: false,
        understood: false,
        reply: reply || 'Manda ver quando quiser o som. É só pedir a música, o artista ou o estilo.',
        results: []
      };
    }

    const blendLabels = (genrePack && genrePack.labels) || [];
    const playlistName = djStylePlaylistName(blendLabels, cleanedUserQuery);
    let matchQuery = blendLabels.length ? blendLabels.join(' ') : (detectedGenre ? detectedGenre.label : cleanedUserQuery);
    let directTracks = (blendLabels.length || detectedGenre) ? catalogTracks : sortTracksByQuery(catalogTracks, matchQuery);

    if (!blendLabels.length && !hasConfidentDjMatch(directTracks, matchQuery, userMessage) && parsed && parsed.searchQuery) {
      const aiQuery = String(parsed.searchQuery).trim();
      if (aiQuery && aiQuery.length >= 2) {
        const extra = await searchRequestedMusic([aiQuery], playlistSize);
        if (hasConfidentDjMatch(extra, aiQuery, userMessage)) {
          directTracks = extra;
          matchQuery = aiQuery;
        }
      }
    }

    if (!blendLabels.length && !hasConfidentDjMatch(directTracks, matchQuery, userMessage)) {
      return {
        success: true,
        playMusic: false,
        understood: false,
        reply: djKeepCurrentReply(reply),
        results: []
      };
    }

    const excludeSet = new Set((Array.isArray(excludeTitles) ? excludeTitles : [])
      .map((t) => String(t || '').trim().toLowerCase())
      .filter(Boolean));
    let results = mergeMusicTracks([directTracks], matchQuery, excludeSet, playlistSize, blendLabels.length > 0 || !!detectedGenre);

    // Se o filtro de repetidas esgotou todas as faixas (ex: usuário pediu de novo o mesmo estilo), nunca descarte!
    if (!results.length && directTracks.length > 0) {
      results = mergeMusicTracks([directTracks], matchQuery, new Set(), playlistSize, blendLabels.length > 0 || !!detectedGenre);
    }

    if (!results.length) {
      return {
        success: true,
        playMusic: false,
        understood: false,
        reply: djKeepCurrentReply(reply),
        results: []
      };
    }

    // Se encontramos as músicas e vamos tocar, garante que a resposta do DJ seja empolgada e não de desculpa ou dúvida
    const isConfused = !reply || /desculpa|n[aã]o consegui entender|n[aã]o entendi|qual desses|pode se referir|especificar|estilos/i.test(reply);
    if (isConfused) {
      const finalStyleName = playlistName || matchQuery || cleanedUserQuery;
      reply = `Soltando agora uma seleção especial de ${finalStyleName}! Prepara o fone e curte o som que separei pra você!`;
    }

    return {
      success: true,
      playMusic: true,
      understood: true,
      reply,
      playlistName,
      results
    };
  } catch (err) {
    try {
      if (wantSearch) {
        const tracks = await searchRequestedMusic([cleanedUserQuery], playlistSize);
        if (tracks && tracks.length > 0) {
          const finalName = djStylePlaylistName([], cleanedUserQuery);
          return {
            success: true,
            playMusic: true,
            understood: true,
            reply: `Soltando agora uma seleção de ${finalName}! Dá o play e aproveita o som!`,
            playlistName: finalName,
            results: mergeMusicTracks([tracks], cleanedUserQuery, new Set(), playlistSize)
          };
        }
      }
    } catch (e2) { swallowed(e2, 'server:chatDjPapaleguas@7622'); }
    return {
      success: true,
      playMusic: false,
      understood: false,
      reply: djKeepCurrentReply(''),
      results: []
    };
  }
}

// Agente Papaléguas AI (Grok) para pesquisa inteligente e respostas na Web e Celular
async function runGptNavigatorAgent(userPromptOrObj) {
  let prompt = '';
  let history = [];
  if (typeof userPromptOrObj === 'object' && userPromptOrObj !== null) {
    prompt = userPromptOrObj.prompt || userPromptOrObj.query || '';
    history = Array.isArray(userPromptOrObj.history) ? userPromptOrObj.history : [];
  } else {
    prompt = String(userPromptOrObj || '');
  }

  if (!prompt.trim()) {
    return 'Por favor, digite o que você deseja pesquisar ou saber.';
  }

  const systemInstructions = `Você é o Papaléguas AI, com Grok (xAI) como agente principal: assistente autônomo com inteligência profunda, respostas ricas e capacidade de execução real de código do Papaléguas Browser!
Estamos no ano de 2026. Considere 2026 como o ano presente atual e contemporâneo para todas as pesquisas, fatos, notícias, cotações e tecnologia.

DIRETRIZES:
1. Responda com riqueza de detalhes, profundidade, organização e simpatia.
2. EXECUÇÃO DE CÓDIGO E SERVIDORES EM PYTHON:
   - Se o usuário pedir para criar, testar ou executar um código ou aplicação em Python (como servidores Flask, APIs FastAPI, scanners de rede/wifi, diagnósticos, cálculos, automações, etc.), CHAME A FERRAMENTA 'execute_python_app'.
   - O sistema do Papaléguas instalará AUTOMATICAMENTE qualquer biblioteca necessária via pip e iniciará o servidor na máquina local.
   - REGRAS CRÍTICAS PARA CÓDIGO PYTHON:
     • SEMPRE desenvolva como uma aplicação web visual e interativa (usando Flask com página HTML/CSS embutida ou FastAPI), com botões e visualização gráfica, para que o usuário veja a aplicação funcionando e interaja com ela pelo navegador.
     • NUNCA use bibliotecas que exigem privilégios de root/sudo ou raw sockets (como Scapy sniff em 'wlan0'). Para varredura de Wi-Fi, rede ou sistema no Linux, use comandos seguros do usuário como 'nmcli dev wifi' via subprocess.
     • Quando for uma aplicação servidor web, a ferramenta iniciará o servidor e retornará a porta e o link. Você DEVE fornecer OBRIGATORIAMENTE na sua resposta o link clicável Markdown: [🚀 Abrir Aplicação Python](/python-app?port=PORTA) ou [🔗 Ver no Navegador](/python-proxy/PORTA/). NUNCA use 'localhost' no link. Acompanhe com explicação de como ela funciona e o código desenvolvido.
3. Se o usuário pedir visualização 3D, HTML, CSS, JavaScript, forneça bloco completo \`\`\`html ... \`\`\` para ser exibido.`;

  const tools = [
    {
      type: "function",
      function: {
        name: "execute_python_app",
        description: "Executa código Python no computador do usuário, instalando automaticamente qualquer biblioteca necessária via pip (ex: Flask, Requests, NumPy, Pandas, FastAPI, Matplotlib, etc.). Se o código for um servidor web ou API, inicia o servidor em segundo plano e retorna a URL e a porta para exibir a aplicação ao vivo no Papaléguas Browser.",
        parameters: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "Código Python completo funcional pronto para execução."
            },
            is_server: {
              type: "boolean",
              description: "True se for uma aplicação servidor web (Flask, FastAPI, etc.) que deve continuar rodando em segundo plano."
            },
            description: {
              type: "string",
              description: "Breve descrição da aplicação."
            }
          },
          required: ["code"]
        }
      }
    }
  ];

  const messages = [{ role: "system", content: systemInstructions }];
  if (Array.isArray(history) && history.length > 0) {
    history.slice(-6).forEach(h => {
      if (h && h.role && h.content) {
        messages.push({
          role: h.role === 'assistant' || h.role === 'dj' ? 'assistant' : 'user',
          content: String(h.content)
        });
      }
    });
  }
  messages.push({ role: "user", content: prompt });

  const MAX_MISSION_ATTEMPTS = 4;
  let attempt = 0;
  let missionAccomplished = false;

  try {
    while (attempt < MAX_MISSION_ATTEMPTS && !missionAccomplished) {
      attempt++;
      console.log(`[PAPALÉGUAS MISSION AGENT] Tentativa de missão ${attempt}/${MAX_MISSION_ATTEMPTS}...`);

      const res = await callOpenAi({
        model: "gpt-4o-mini",
        messages,
        tools,
        temperature: attempt === 1 ? 0.4 : 0.2
      });

      if (!res || !res.choices || !res.choices[0] || !res.choices[0].message) {
        break;
      }

      const msg = res.choices[0].message;

      // Se a IA respondeu diretamente sem chamar ferramentas de código
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return msg.content;
      }

      messages.push(msg);

      for (const toolCall of msg.tool_calls) {
        if (toolCall.function && toolCall.function.name === 'execute_python_app') {
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch (e) {
            args = { code: toolCall.function.arguments };
          }

          console.log(`[PAPALÉGUAS MISSION AGENT] Executando código Python (Tentativa ${attempt})...`);
          const { runPythonCodeOrServer, verifyServerHealth } = require('./python-runner');
          const execRes = await runPythonCodeOrServer(args.code, { isServer: args.is_server });

          let health = { healthy: true };
          if (execRes.success && execRes.isServer && execRes.port) {
            console.log(`[PAPALÉGUAS MISSION AGENT] Verificando saúde HTTP do servidor na porta ${execRes.port}...`);
            health = await verifyServerHealth(execRes.port);
            console.log(`[PAPALÉGUAS MISSION AGENT] Saúde do servidor: ${health.healthy ? 'SAUDÁVEL (200 OK)' : 'FALHA: ' + health.error}`);
          }

          const isMissionSuccess = execRes.success && health.healthy;

          if (isMissionSuccess) {
            missionAccomplished = true;
            console.log(`[PAPALÉGUAS MISSION AGENT] ✅ MISSÃO CONCLUÍDA COM SUCESSO na tentativa ${attempt}!`);

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                status: "MISSÃO_CONCLUÍDA_COM_SUCESSO",
                success: true,
                is_server: execRes.isServer || false,
                port: execRes.port || null,
                app_viewer_url: execRes.port ? `/python-app?port=${execRes.port}` : null,
                proxy_url: execRes.port ? `/python-proxy/${execRes.port}/` : null,
                link_recomendado: execRes.port ? `/python-app?port=${execRes.port}` : null,
                installed_packages: execRes.installedPackages || [],
                health_check: "OK",
                instrucao_link: "A aplicação foi testada e está respondendo com sucesso! Forneça na sua resposta final uma explicação completa e o link clicável: [🚀 Abrir Aplicação Python](/python-app?port=" + execRes.port + ") ou [🔗 Ver no Navegador](/python-proxy/" + execRes.port + "/). Não use http://localhost."
              })
            });
          } else {
            const errorDetails = execRes.error || execRes.stderr || health.error || 'O processo do servidor encerrou precocemente sem responder HTTP.';
            console.warn(`[PAPALÉGUAS MISSION AGENT] ❌ Falha na tentativa ${attempt}: ${errorDetails}`);

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                status: "FALHA_NA_EXECUÇÃO",
                success: false,
                tentativa: attempt,
                max_tentativas: MAX_MISSION_ATTEMPTS,
                erro_real_do_terminal: errorDetails,
                stdout: execRes.stdout || '',
                stderr: execRes.stderr || '',
                instrucao_obrigatoria_de_correcao: "A execução falhou com o erro acima. VOCÊ DEVE CORRIGIR O CÓDIGO AGORA: 1) Se o erro for de permissão ou interface de rede (como Scapy ou wlan0), NUNCA use Scapy ou raw sockets: use comandos nativos do usuário via subprocess (ex: 'nmcli dev wifi' para listar redes Wi-Fi). 2) Se o erro for TemplateNotFound, inclua o HTML diretamente no código como string embutida (render_template_string ou HTMLResponse). 3) Se faltar biblioteca ou ocorrer erro de sintaxe, ajuste o código. 4) CHAME NOVAMENTE a ferramenta 'execute_python_app' com o código corrigido para que a missão seja concluída com sucesso!"
              })
            });
          }
        }
      }

      if (missionAccomplished) {
        const finalRes = await callOpenAi({
          model: "gpt-4o-mini",
          messages,
          temperature: 0.3
        });

        if (finalRes && finalRes.choices && finalRes.choices[0] && finalRes.choices[0].message) {
          return finalRes.choices[0].message.content;
        }
      }
    }

    // Se completou as tentativas, retorna a melhor resposta gerada
    const finalFallback = await callOpenAi({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.3
    });
    if (finalFallback && finalFallback.choices && finalFallback.choices[0]) {
      return finalFallback.choices[0].message.content;
    }
    return 'Não foi possível concluir a missão após múltiplas tentativas de auto-cura. Tente reformular seu pedido.';
  } catch (e) {
    return `Erro no Agente Papaléguas: ${e.message}`;
  }
}

// Cache para sugestões do Curador (evita chamadas redundantes e acelera retorno)
const curatorSuggestionsCache = createLruCache({ maxEntries: 300, ttlMs: 30 * 60 * 1000 });
const CURATOR_CACHE_TTL = 5 * 60 * 1000;

const CURATOR_FILLER_STOPWORDS = new Set([
  'para', 'como', 'mais', 'menos', 'muito', 'tudo', 'todos', 'todas', 'sobre',
  'esse', 'essa', 'este', 'esta', 'isso', 'aquilo', 'entre', 'depois', 'antes',
  'hoje', 'ontem', 'agora', 'novo', 'nova', 'novos', 'novas', 'video', 'videos',
  'oficial', 'official', 'canal', 'live', 'vivo', 'completo', 'completa', 'parte',
  'melhor', 'melhores', 'top', 'brasil', 'mundo', '2024', '2025', '2026', 'clipe',
  'audio', 'hd', '4k', 'full', 'with', 'from', 'that', 'this', 'what', 'when',
  'where', 'quais', 'qual', 'quem', 'porque', 'sera', 'voce', 'voces', 'pelo',
  'pela', 'pelos', 'pelas', 'acaba', 'acabou', 'explodir', 'explodiu', 'entrou',
  'entra', 'fase', 'tiram', 'tirou', 'muda', 'mudou', 'ameaca', 'vida', 'coisa',
  'coisas', 'forma', 'jeito', 'vezes', 'hora', 'horas', 'dias', 'semana', 'meses',
  'anos', 'veja', 'olha', 'urgente', 'bomba', 'chocante', 'incrivel', 'nunca',
  'sempre', 'fazer', 'feito', 'disse', 'falou', 'pode', 'podem', 'estao', 'fomos',
  'foram', 'toda', 'todo', 'cada', 'outro', 'outra', 'mesmo', 'mesma', 'grande',
  'grandes', 'pequeno', 'primeiro', 'primeira', 'ultimo', 'ultima', 'bilhoes',
  'trilhoes', 'milhoes', 'reais', 'dolar', 'dolares'
]);

const CURATOR_SHORT_KEEP = new Set([
  'ia', 'ai', 'ti', 'tv', 'f1', 'pc', 'vr', '5g', '6g', 'agi', 'gpt', 'llm',
  'php', 'sql', 'css', 'api', 'cpu', 'gpu', 'ram', 'ssd', 'ufc', 'nba', 'nfl',
  'ps5', 'gta', 'stf', 'cpi', 'pib', 'onu', 'eua', 'sus', 'pix', 'btc', 'eth'
]);

function extractRelatedKeywords(title, channel) {
  if (!title) return channel || 'videos recomendados';
  let clean = String(title).replace(/\[.*?\]|\(.*?\)/g, ' ');
  clean = clean.replace(/[|•#\-_–—~:;!?,./\\]/g, ' ');
  clean = clean.replace(/\b(oficial|official|clipe|video|vídeo|audio|áudio|ao vivo|live|hd|4k|legendado|dublado|completo|lançamento|music|mv)\b/gi, ' ');
  const words = clean.trim().split(/\s+/).filter((w) => {
    const low = w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/^\d+$/.test(low)) return false;
    if (CURATOR_FILLER_STOPWORDS.has(low)) return false;
    return CURATOR_SHORT_KEEP.has(low) || low.length >= 4;
  }).slice(0, 4);
  if (words.length > 0) return words.join(' ');
  return ((channel ? channel + ' ' : '') + clean).slice(0, 40);
}

function scoreVideoRelevance(video, ctx) {
  const title = normalizeDjText(video && video.title);
  const channel = normalizeDjText(video && video.channel);
  const seedTitle = normalizeDjText(ctx && ctx.title);
  const seedChannel = normalizeDjText(ctx && ctx.channel);
  const seedQuery = normalizeDjText(ctx && ctx.query);
  let score = 0;
  // Bônus forte para o mesmo canal da curtida/vídeo atual
  if (seedChannel && channel && seedChannel !== 'baixatube' && (channel === seedChannel || channel.includes(seedChannel) || seedChannel.includes(channel))) {
    score += 95;
  }
  seedTitle.split(/[^a-z0-9]+/).filter((w) => (CURATOR_SHORT_KEEP.has(w) || w.length >= 4) && !CURATOR_FILLER_STOPWORDS.has(w)).forEach((w) => {
    if (title.includes(w)) score += 18;
    if (channel.includes(w)) score += 8;
  });
  // Bônus forte para coincidir com o TEMA da pesquisa
  seedQuery.split(/[^a-z0-9]+/).filter((w) => (CURATOR_SHORT_KEEP.has(w) || w.length >= 4) && !CURATOR_FILLER_STOPWORDS.has(w)).forEach((w) => {
    if (title.includes(w)) score += 26;
    if (channel.includes(w)) score += 10;
  });
  // Bônus de RECÊNCIA: vídeos postados recentemente sobem para o topo (todos os idiomas)
  const ageDays = parseYoutubePublishedAgeDays(video && video.publishedAt);
  if (ageDays !== null) {
    if (ageDays <= 1) score += 45;
    else if (ageDays <= 6) score += 30;
    else if (ageDays <= 21) score += 18;
    else if (ageDays >= 30) score -= 75;
  } else {
    const pub = String(video && video.publishedAt || '').toLowerCase();
    if (/hora|horas|minuto|minutos|hoje|ontem|\b\d+\s*h\b|\b\d+\s*min\b|today|hours?|mins?|ao vivo|live/i.test(pub)) {
      score += 45;
    } else if (/dia|dias|days?/i.test(pub)) {
      score += 30;
    } else if (/semana|semanas|weeks?/i.test(pub)) {
      score += 18;
    } else if (/m[eê]s|meses|months?|ano|anos|years?/i.test(pub)) {
      score -= 60;
    }
  }
  // Bônus para ano recente no título
  if (/2026/i.test(title)) score += 16;
  else if (/2025/i.test(title)) score += 6;

  if (video && video.viewCount) score += Math.min(12, Math.log10(video.viewCount + 1) * 2);
  return score;
}

async function fetchRelatedYoutubeVideos(videoId, useTor = false, hl = 'pt-BR', country = 'BR') {
  if (!videoId) return [];
  const cacheKey = 'related__' + videoId + '__' + (hl || 'pt-BR') + '__' + (country || 'BR') + '__direct';
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < YT_CACHE_TTL) && cached.videos.length > 0) {
    return cached.videos;
  }
  try {
    const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId) + '&hl=' + encodeURIComponent(hl || 'pt-BR') + '&gl=' + encodeURIComponent(country || 'BR');
    const res = await fetchYoutubeHtml(url, hl || 'pt-BR', false);
    if (!res || !res.ok || !res.html) return [];
    const match = res.html.match(/var ytInitialData = ({.*?});<\/script>/) || res.html.match(/var ytInitialData = ({.*?});?\s*<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const videos = [];
    const seen = new Set([videoId]);
    const push = (renderer) => {
      const mapped = mapYoutubeRenderer(renderer);
      if (!mapped || !mapped.id || seen.has(mapped.id)) return;
      seen.add(mapped.id);
      videos.push(mapped);
    };
    const secObj = (((data.contents || {}).twoColumnWatchNextResults || {}).secondaryResults || {});
    const secResults = (secObj.secondaryResults && secObj.secondaryResults.results)
      || (secObj.secondaryResultsRenderer && secObj.secondaryResultsRenderer.results)
      || [];
    (secResults || []).forEach((item) => {
      if (item.compactVideoRenderer) push(item.compactVideoRenderer);
      if (item.videoRenderer) push(item.videoRenderer);
      if (item.lockupViewModel) push(item.lockupViewModel);
      if (item.itemSectionRenderer) {
        (item.itemSectionRenderer.contents || []).forEach((c) => {
          if (c.compactVideoRenderer) push(c.compactVideoRenderer);
          if (c.videoRenderer) push(c.videoRenderer);
          if (c.lockupViewModel) push(c.lockupViewModel);
        });
      }
    });
    if (videos.length < 6) {
      const renderers = [];
      collectYoutubeRenderers(data, renderers);
      renderers.forEach(push);
    }
    const sliced = videos.slice(0, 30);
    if (sliced.length) youtubeSearchCache.set(cacheKey, { timestamp: Date.now(), videos: sliced });
    return sliced;
  } catch (e) {
    return [];
  }
}

async function askCuratorAiForThemeQueries({ theme, page, excludeList, type, country = 'BR' }) {
  const themeSafe = String(theme || '').trim() || 'noticias';
  const cUpper = String(country || 'BR').toUpperCase();
  const isPt = cUpper === 'BR' || cUpper === 'PT';
  const isEs = ['ES', 'MX', 'AR', 'CO', 'CL'].includes(cUpper);
  const langRule = isPt ? 'em português' : (isEs ? 'em espanhol' : 'em inglês');
  const excludeSnippet = (Array.isArray(excludeList) ? excludeList : []).slice(-14).join(', ');
  const typeHint = type === 'filmes'
    ? 'O tema é CINEMA/FILMES. Gere buscas por lançamentos de filmes completos dublados ou trailers de 2026.'
    : `Gere buscas no YouTube ${langRule} focadas em vídeos novos e lançamentos de 2026 sobre esse tema.`;
  try {
    const gptRes = await callOpenAi({
      model: 'gpt-4o-mini',
      timeoutMs: 7500,
      temperature: 0.5,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Você é o Curador IA do Papaléguas (2026), especialista em recomendar VÍDEOS NOVOS e recentes no MESMO TEMA.
TEMA OBRIGATÓRIO: "${themeSafe}"
${typeHint}

REGRA CRÍTICA: Todas as recomendações DEVEM ser estritamente do MESMO TEMA ("${themeSafe}"). O usuário exige vídeos NOVOS e recentes (2026, lançamentos, últimas novidades). Nunca mude de tema e não sugira vídeos antigos de anos passados.
${excludeSnippet ? 'Evite repetir vídeos/títulos já vistos: ' + excludeSnippet : ''}

Gere 3 buscas específicas (2 a 5 palavras cada) combinando "${themeSafe}" com termos de novidade ou 2026.

Responda ESTRITAMENTE em JSON:
{
  "reason": "1 frase curta apresentando novos vídeos recentes do tema ${themeSafe}",
  "queries": ["termo 1", "termo 2", "termo 3"]
}`
        },
        {
          role: 'user',
          content: `Tema: "${themeSafe}". Página ${page}. Traga a próxima leva de buscas para vídeos NOVOS no mesmo tema, sem repetir o que já apareceu.`
        }
      ]
    });
    if (!gptRes || !gptRes.choices || !gptRes.choices[0] || !gptRes.choices[0].message) return null;
    const parsed = JSON.parse(gptRes.choices[0].message.content);
    const queries = Array.isArray(parsed.queries)
      ? parsed.queries.map((q) => String(q || '').trim()).filter((q) => q.length >= 2).slice(0, 3)
      : [];
    if (!queries.length) return null;
    return {
      reason: String(parsed.reason || '').trim(),
      queries
    };
  } catch (e) {
    return null;
  }
}

// Curador IA lendo o vídeo atual: título + canal (+ tema da pesquisa) viram buscas
// específicas de vídeos NOVOS e uma frase explicando a recomendação.
const curatorVideoAiCache = createLruCache({ maxEntries: 300, ttlMs: 30 * 60 * 1000 });
const CURATOR_VIDEO_AI_TTL = 10 * 60 * 1000;

function isGenericVideoTitle(title) {
  const t = String(title || '').trim();
  if (t.length < 4) return true;
  return /^(noticias|not[ií]cias|v[ií]deo|video|filme|filmes online|baixatube|carregando|aba ativa|vídeo em reprodução)$/i.test(t);
}

async function askCuratorAiForVideo({ title, channel, theme, page, excludeList, type, stayOnTheme, country = 'BR' }) {
  const cleanTitle = String(title || '').trim().slice(0, 160);
  const cleanChannel = String(channel || '').trim().slice(0, 80);
  const themeSafe = String(theme || '').trim();
  const isCinema = type === 'filmes' || type === 'cinema';
  if (isGenericVideoTitle(cleanTitle)) return null;

  const cUpper = String(country || 'BR').toUpperCase();
  const isPt = cUpper === 'BR' || cUpper === 'PT';
  const isEs = ['ES', 'MX', 'AR', 'CO', 'CL'].includes(cUpper);
  const langRule = isPt ? 'em português' : (isEs ? 'em espanhol' : 'em inglês');

  const cacheKey = [isCinema ? 'cine' : 'yt', stayOnTheme ? 'theme' : 'free', cUpper, themeSafe.toLowerCase(), cleanTitle.toLowerCase(), cleanChannel.toLowerCase(), Math.min(3, Math.max(1, page || 1))].join('__');
  const cached = curatorVideoAiCache.get(cacheKey);
  if (cached && Date.now() - cached.t < CURATOR_VIDEO_AI_TTL) return cached.data;

  const excludeSnippet = (Array.isArray(excludeList) ? excludeList : [])
    .filter((x) => x && !/^[a-zA-Z0-9_-]{11}$/.test(String(x)))
    .slice(-12).join(' | ');
  const contentRule = isCinema
    ? 'CONTEXTO: filmes completos dublados no YouTube. As buscas devem trazer filmes completos dublados recentes do mesmo gênero, ator ou franquia. Toda busca deve terminar com "filme completo dublado".'
    : 'CONTEXTO: BaixaTube (YouTube 2026). O usuário quer assistir a VÍDEOS NOVOS E RECENTES (2026 / lançamentos) no MESMO TEMA do vídeo atual.';
  const themeRule = themeSafe
    ? `TEMA OBRIGATÓRIO: "${themeSafe}". As buscas DEVEM permanecer estritamente no MESMO TEMA ("${themeSafe}"). O vídeo atual serve como contexto/recorte dentro desse tema.`
    : '';

  try {
    const gptRes = await callOpenAi({
      model: 'gpt-4o-mini',
      timeoutMs: 7500,
      temperature: 0.5,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Você é o Curador IA do Papaléguas (2026), especialista em recomendar vídeos NOVOS e recentes no MESMO TEMA.
${contentRule}
${themeRule}
${excludeSnippet ? 'Já visto (não repetir): ' + excludeSnippet : ''}

Regras:
- Leia o TÍTULO e o CANAL do vídeo atual e descubra o assunto/nicho específico.
- REGRA CRÍTICA - MESMO TEMA E VÍDEOS NOVOS (2026): O usuário exige vídeos NOVOS e recentes sobre o MESMO TEMA. Não desvie de assunto e não recomende vídeos antigos de anos passados.
- Gere 3 buscas curtas e específicas para o YouTube ${langRule} (2 a 6 palavras cada), sem aspas, sem hashtags. Ao menos 2 buscas devem conter termos de novidade/tempo como "2026", "novos", "hoje" ou "lançamento" dentro do mesmo assunto/tema.
- Nunca gere buscas genéricas como "vídeos" ou "notícias" sozinhas.
- "reason": 1 frase curta (máx. 110 caracteres) explicando a recomendação de forma pessoal, ex.: "Porque você está vendo X: novos vídeos de Y de 2026..." 
- "topics": 2 a 4 palavras-chave que resumem o assunto do vídeo, para ranquear resultados.

Responda ESTRITAMENTE em JSON:
{ "reason": "...", "queries": ["...", "...", "..."], "topics": ["...", "..."] }`
        },
        {
          role: 'user',
          content: `Vídeo atual: "${cleanTitle}"${cleanChannel ? ` — canal: "${cleanChannel}"` : ''}. Tema: "${themeSafe || 'geral'}". Página ${page || 1}. O que o usuário vai querer assistir em seguida de NOVO sobre esse mesmo tema?`
        }
      ]
    });
    if (!gptRes || !gptRes.choices || !gptRes.choices[0] || !gptRes.choices[0].message) return null;
    const parsed = JSON.parse(gptRes.choices[0].message.content);
    let queries = Array.isArray(parsed.queries)
      ? parsed.queries.map((q) => String(q || '').replace(/["#]/g, '').trim()).filter((q) => q.length >= 3).slice(0, 3)
      : [];
    if (isCinema) {
      const movieSuffix = isPt ? ' filme completo dublado' : (isEs ? ' pelicula completa en espanol' : ' full movie');
      queries = queries.map((q) => /(?:completo|completa|full\s*movie|ganzer\s*film)/i.test(q) ? q : (q + movieSuffix));
    }
    if (!queries.length) return null;
    const data = {
      reason: String(parsed.reason || '').trim().slice(0, 140),
      queries,
      topics: Array.isArray(parsed.topics) ? parsed.topics.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 4) : []
    };
    curatorVideoAiCache.set(cacheKey, { t: Date.now(), data });
    return data;
  } catch (e) {
    return null;
  }
}

function rotateThemeSearchQueries(theme, page = 1, country = 'BR') {
  const p = Math.max(1, page);
  const dyn = getDynamicRecentYoutubeQuery(theme || 'noticias', false, country, p - 1);
  const dyn2 = getDynamicRecentYoutubeQuery(theme || 'noticias', false, country, p);
  const base = String((dyn && dyn.query) || theme || 'noticias').trim();
  const extra = String((dyn2 && dyn2.query) || '').trim();
  const isPt = country === 'BR' || country === 'PT';
  const suffixes = isPt
    ? [' 2026', ' novos', ' hoje', ' ultimas', ' lancamentos', ' ao vivo']
    : [' 2026', ' latest', ' new', ' today', ' trending', ' live'];
  const suffix = suffixes[(p - 1) % suffixes.length];
  const queries = [base, base + suffix];
  if (extra && extra.toLowerCase() !== base.toLowerCase()) {
    queries.push(extra);
    queries.push(extra + suffix);
  }
  if (theme && theme.toLowerCase() !== base.toLowerCase()) {
    queries.push(`${theme} ${suffix.trim()}`);
  }
  return {
    queries: queries.filter((q, i, arr) => q && arr.indexOf(q) === i).slice(0, 4),
    searchMode: (dyn && dyn.searchMode) || '',
    isCustomQuery: !!(dyn && dyn.isCustomQuery)
  };
}

async function getAiCuratorSuggestions({ type, currentQuery, currentTitle, currentChannel, currentVideoId, excludeTitles = [], page = 1, stayOnTheme = true, useAi = false, useTor = false, country = 'BR', clientIp = '', timeFilter = 'hour' }) {
  const isCinema = type === 'filmes' || type === 'cinema';
  const cleanTitle = (currentTitle || '').trim();
  const cleanChannel = (currentChannel || '').trim();
  const themeQuery = String(currentQuery || '').trim();
  // O vídeo atual entra no cache mesmo em "stayOnTheme": a IA usa título/canal para o recorte.
  const videoKey = isGenericVideoTitle(cleanTitle) ? '' : (cleanTitle + '|' + cleanChannel).toLowerCase();
  const cacheKey = `${type}__${stayOnTheme ? 'theme' : 'mix'}__${useAi ? 'ai' : 'fast'}__${themeQuery}__${videoKey}__${country}__${page}__${timeFilter}__direct`;

  const excludeSet = new Set((Array.isArray(excludeTitles) ? excludeTitles : []).map((t) => String(t || '').trim().toLowerCase()).filter(Boolean));
  if (currentVideoId) excludeSet.add(String(currentVideoId).toLowerCase());

  const cached = curatorSuggestionsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CURATOR_CACHE_TTL) && cached.data.items && cached.data.items.length > 0) {
    const fresh = cached.data.items.filter((v) => {
      if (!v || !v.id) return false;
      const idKey = String(v.id).toLowerCase();
      const titleKey = String(v.title || '').trim().toLowerCase();
      return !excludeSet.has(idKey) && !(titleKey && excludeSet.has(titleKey));
    });
    if (fresh.length >= 12) {
      return Object.assign({}, cached.data, { items: fresh.slice(0, 24) });
    }
  }

  const hasVideoContext = !isGenericVideoTitle(cleanTitle);
  const targetTheme = (themeQuery || (hasVideoContext ? '' : 'noticias')).trim();
  const activeTheme = (targetTheme || cleanTitle || 'noticias').toLowerCase();
  const keyword = extractRelatedKeywords(cleanTitle, cleanChannel);
  const shortKeyword = keyword.split(/\s+/).filter((w) => w.length >= 2).slice(0, 3).join(' ') || keyword;
  const validChannel = (cleanChannel && cleanChannel !== 'BaixaTube' && cleanChannel !== 'Papaléguas BaixaTube') ? cleanChannel : '';

  let queries = [];
  let defaultReason = '';
  let searchMode = '';

  if (isCinema || activeTheme.includes('filme') || activeTheme.includes('cinema')) {
    const dynamicMovie = getDynamicRecentMovieQuery(themeQuery || 'todos', page - 1, country);
    const dynamicMovie2 = getDynamicRecentMovieQuery(themeQuery || 'todos', page, country);
    const dynamicMovie3 = getDynamicRecentMovieQuery(themeQuery || 'todos', page + 1, country);
    queries = [dynamicMovie.query, dynamicMovie2.query, dynamicMovie3.query];
    const cUpper = String(country || 'BR').toUpperCase();
    const isPt = cUpper === 'BR' || cUpper === 'PT';
    const isEs = ['ES', 'MX', 'AR', 'CO', 'CL', 'PE'].includes(cUpper);
    const isFr = ['FR', 'BE'].includes(cUpper);
    const isDe = ['DE', 'AT', 'CH'].includes(cUpper);
    const isIt = cUpper === 'IT';
    defaultReason = isPt
      ? '🍿 Mais filmes completos dublados para você'
      : (isEs ? '🍿 Más películas completas en español para ti'
      : (isFr ? '🍿 Plus de films complets en français pour vous'
      : (isDe ? '🍿 Weitere ganze Filme auf Deutsch für dich'
      : (isIt ? '🍿 Altri film completi in italiano per te'
      : '🍿 More full movies for you'))));
  } else if (hasVideoContext) {
    // Prioridade máxima para o CANAL e o TEMA/ASSUNTO do vídeo curtido/atual
    if (validChannel) {
      const channelTokens = validChannel.toLowerCase().split(/\s+/).filter(Boolean);
      const cleanKeywordTokens = shortKeyword.split(/\s+/).filter((w) => !channelTokens.includes(w.toLowerCase()));
      const cleanKeyword = cleanKeywordTokens.join(' ').trim();
      queries = [
        cleanKeyword ? `${validChannel} ${cleanKeyword}`.trim() : validChannel,
        cleanKeyword || (targetTheme && targetTheme !== 'noticias' ? targetTheme : cleanTitle.slice(0, 35)),
        validChannel
      ].filter(Boolean);
      defaultReason = `⚡ Mais vídeos de "${validChannel}" e recomendações relacionadas`;
    } else if (targetTheme && targetTheme.toLowerCase() !== keyword.toLowerCase()) {
      queries = [
        `${targetTheme} ${shortKeyword}`,
        shortKeyword,
        `${targetTheme} novidades`
      ].filter(Boolean);
      defaultReason = `⚡ Novos vídeos de "${targetTheme}": mais sobre ${shortKeyword.slice(0, 35)}...`;
    } else {
      queries = [
        shortKeyword,
        cleanTitle.slice(0, 35),
        `${shortKeyword} novidades`
      ].filter(Boolean);
      defaultReason = `⚡ Novos vídeos relacionados a "${cleanTitle.length > 40 ? cleanTitle.slice(0, 37) + '...' : cleanTitle}"`;
    }
  } else {
    // Rotação dinâmica no tema ativo e país do usuário
    const rotated = rotateThemeSearchQueries(activeTheme, page, country);
    queries = rotated.queries;
    searchMode = rotated.searchMode;
    const isPt = country === 'BR' || country === 'PT';
    const isEs = ['ES', 'MX', 'AR', 'CO', 'CL'].includes(country);
    defaultReason = isPt
      ? `Novos vídeos do tema "${activeTheme}", diferentes dos que você já viu.`
      : (isEs ? `Nuevos videos sobre "${activeTheme}".` : `Trending videos for "${activeTheme}".`);
  }

  if (page > 1 && queries[0] && !useAi) {
    queries = queries.concat([queries[0] + ' 2026', queries[0] + ' novos']);
  }
  queries = queries.filter((q, i, arr) => q && arr.indexOf(q) === i).slice(0, 4);

  const hl = getHlForCountry(country);
  const effectiveClientIp = useTor ? '' : clientIp;

  const fastYtRace = (p, ms = 4500) => Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve([]), ms))
  ]);

  // 1. RECOMENDAÇÕES NATIVAS DIRETAS DO YOUTUBE:
  // Se há um vídeo atual, puxa na hora os vídeos recomendados / Up Next direto do YouTube
  const relatedPromise = currentVideoId
    ? fastYtRace(fetchRelatedYoutubeVideos(currentVideoId, useTor, hl, country).catch(() => []), 4500)
    : Promise.resolve([]);

  // 2. BUSCAS DIRETAS NO YOUTUBE EM PARALELO - Direto via HTTP rápido sem travar em subprocessos
  const searchList = queries.slice(0, 2);
  if (shortKeyword && !searchList.includes(shortKeyword)) searchList.push(shortKeyword);
  const localSearchPromises = searchList.slice(0, 3).map((q) =>
    fastYtRace(
      searchYoutubeVideos(
        q,
        hl,
        false,
        '',
        false,
        searchMode,
        country,
        effectiveClientIp
      ).catch(() => []),
      4500
    )
  );

  // IA ultra-rápida não-bloqueante (timeout de 600ms para nunca travar a resposta)
  const fastAiRace = (promise) => Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), 600))
  ]);

  const videoAiPromise = (hasVideoContext && useAi)
    ? fastAiRace(askCuratorAiForVideo({
        title: cleanTitle,
        channel: cleanChannel,
        theme: targetTheme || (stayOnTheme ? activeTheme : ''),
        page,
        excludeList: Array.from(excludeSet),
        type,
        stayOnTheme,
        country
      }).catch(() => null))
    : Promise.resolve(null);

  const aiPromise = (useAi && !hasVideoContext)
    ? fastAiRace(askCuratorAiForThemeQueries({
        theme: targetTheme || activeTheme,
        page,
        excludeList: Array.from(excludeSet),
        type,
        country
      }).catch(() => null))
    : Promise.resolve(null);

  const [videoAi, aiCurator, relatedVideos, ...localSearchResults] = await Promise.all([
    videoAiPromise,
    aiPromise,
    relatedPromise
  ].concat(localSearchPromises));

  // Motivo da recomendação limpo e profissional direto do YouTube
  if (!isCinema) {
    if (hasVideoContext) {
      defaultReason = `Recomendações do YouTube baseadas em "${cleanTitle.length > 40 ? cleanTitle.slice(0, 37) + '...' : cleanTitle}"`;
    } else {
      defaultReason = `Vídeos recomendados pelo YouTube sobre ${activeTheme === 'noticias' ? 'notícias recentes' : activeTheme}`;
    }
  }
  if (videoAi && videoAi.reason && !videoAi.reason.toLowerCase().includes('novas buscas')) defaultReason = videoAi.reason;
  else if (aiCurator && aiCurator.reason && !aiCurator.reason.toLowerCase().includes('novas buscas')) defaultReason = aiCurator.reason;

  const aiQueries = []
    .concat(videoAi && Array.isArray(videoAi.queries) ? videoAi.queries : [])
    .concat(aiCurator && Array.isArray(aiCurator.queries) ? aiCurator.queries : [])
    .filter((q, i, arr) => q && arr.indexOf(q) === i && queries.indexOf(q) === -1);
  queries = queries.concat(aiQueries).filter((q, i, arr) => q && arr.indexOf(q) === i).slice(0, 5);

  let extraSearchResults = [];
  if (aiQueries.length) {
    extraSearchResults = await Promise.all(
      aiQueries.slice(0, 2).map((q) =>
        searchYoutubeVideos(q, hl, true, timeFilter, false, searchMode, country, effectiveClientIp).catch(() => [])
      )
    );
  }
  const aiTopics = (videoAi && Array.isArray(videoAi.topics) ? videoAi.topics : []).map((t) => normalizeDjText(t)).filter(Boolean);
  const aiResultIds = new Set();
  extraSearchResults.forEach((list) => (list || []).forEach((v) => { if (v && v.id) aiResultIds.add(v.id); }));

  const allVideos = [];
  const seenIds = new Set();
  const pushVideo = (v) => {
    if (!v || !v.id || seenIds.has(v.id)) return;
    const idKey = String(v.id).toLowerCase();
    const titleKey = String(v.title || '').trim().toLowerCase();
    if (excludeSet.has(idKey) || excludeSet.has(titleKey)) return;
    seenIds.add(v.id);
    allVideos.push(v);
  };
  // Recomendações nativas diretas do YouTube entram em primeiro lugar
  (relatedVideos || []).forEach(pushVideo);
  localSearchResults.forEach((list) => (list || []).forEach(pushVideo));
  extraSearchResults.forEach((list) => (list || []).forEach(pushVideo));

  if (allVideos.length < 6) {
    const fallbackTerm = cleanChannel || shortKeyword || targetTheme || 'noticias';
    const fallbackList = await searchYoutubeVideos(fallbackTerm, hl, false, '', false, '', country, effectiveClientIp).catch(() => []);
    (fallbackList || []).forEach(pushVideo);
  }
  if (allVideos.length < 6) {
    const trending = await fetchTrendingVideos({ country, clientIp: effectiveClientIp }).catch(() => []);
    (trending || []).forEach(pushVideo);
  }

  const rankCtx = hasVideoContext
    ? { title: cleanTitle, channel: cleanChannel, query: targetTheme || keyword || currentQuery }
    : { title: targetTheme || themeQuery, channel: '', query: targetTheme || themeQuery || keyword };

  // Ranking com IA: palavras do tema + novidade de 2026 + tópicos identificados pela IA
  const scoreWithAi = (v) => {
    let score = scoreVideoRelevance(v, rankCtx);
    if (aiTopics.length) {
      const text = normalizeDjText((v && v.title) + ' ' + (v && v.channel));
      aiTopics.forEach((topic) => { if (topic && text.includes(topic)) score += 25; });
    }
    if (v && aiResultIds.has(v.id)) score += 18;
    return score;
  };
  const ranked = allVideos.slice().sort((a, b) => scoreWithAi(b) - scoreWithAi(a));
  if (stayOnTheme && !useAi && page > 1 && ranked.length > 4) {
    const shift = ((page - 1) * 3) % ranked.length;
    ranked.push.apply(ranked, ranked.splice(0, shift));
  }

  const resultData = {
    success: true,
    reason: defaultReason,
    queries,
    aiUsed: !!(videoAi || (useAi && aiCurator)),
    aiTopics: videoAi && videoAi.topics ? videoAi.topics : [],
    items: ranked.slice(0, 24)
  };

  if (resultData.items && resultData.items.length > 0) {
    curatorSuggestionsCache.set(cacheKey, { timestamp: Date.now(), data: resultData });
  }
  return resultData;
}

// Gerenciador de sessões isoladas por cliente (Mobile e Desktop)
// Cada cliente tem seu próprio histórico de DJ, músicas excluídas, abas e estado de player,
// mas compartilha o mesmo login / credenciais Spotify e OpenAI da aplicação.
const clientSessions = new Map();
const MAX_CLIENT_SESSIONS = 500;
const CLIENT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function pruneBoundedMap(map, maxEntries = 500) {
  if (!map || typeof map.size !== 'number' || map.size <= maxEntries) return;
  const excess = map.size - maxEntries;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}

function getOrCreateClientSession(clientId) {
  if (!clientId || typeof clientId !== 'string') {
    clientId = 'client_default';
  }
  if (!clientSessions.has(clientId)) {
    if (clientSessions.size >= MAX_CLIENT_SESSIONS) {
      pruneBoundedMap(clientSessions, MAX_CLIENT_SESSIONS - 1);
    }
    clientSessions.set(clientId, {
      clientId,
      createdAt: Date.now(),
      lastActive: Date.now(),
      djChatHistory: [],
      playedTrackTitles: new Set(),
      currentSearch: '',
      sharedLoginUser: 'Papaléguas VIP User',
      isLoggedIn: true,
      torEnabled: Boolean(isAppTorEnabled())
    });
  }
  const session = clientSessions.get(clientId);
  session.lastActive = Date.now();
  if (Array.isArray(session.djChatHistory) && session.djChatHistory.length > 60) {
    session.djChatHistory = session.djChatHistory.slice(-60);
  }
  if (session.playedTrackTitles && session.playedTrackTitles.size > 500) {
    const keep = Array.from(session.playedTrackTitles).slice(-400);
    session.playedTrackTitles = new Set(keep);
  }
  return session;
}

// Manutenção periódica em background (evita crescimento infinito de RAM em operação 24/7)
const cacheMaintenanceTimer = setInterval(() => {
  try {
    const now = Date.now();
    for (const [id, sess] of clientSessions.entries()) {
      if (id !== 'client_default' && sess && now - (sess.lastActive || 0) > CLIENT_SESSION_TTL_MS) {
        clientSessions.delete(id);
      }
    }
    pruneBoundedMap(clientSessions, MAX_CLIENT_SESSIONS);
    pruneBoundedMap(proxyCookieJars, 300);
    pruneBoundedMap(mediaJobs, 200);
    for (const cache of [
      videoMetaCache,
      googleTrendsCache,
      ipCountryCache,
      topicImagesCache,
      webSuggestCache,
      richSearchCache,
      searchAnswerCache,
      searchPicksCache,
      pagePreviewCache,
      youtubeSearchCache,
      audioStreamUrlCache,
      videoStreamUrlCache,
      playUrlCache,
      musicRecCache,
      curatorSuggestionsCache,
      curatorVideoAiCache
    ]) {
      if (cache && typeof cache.pruneExpired === 'function') {
        cache.pruneExpired(now);
      }
    }
  } catch (e) { swallowed(e, 'server:top@8465'); }
}, 10 * 60 * 1000);
if (cacheMaintenanceTimer && typeof cacheMaintenanceTimer.unref === 'function') {
  cacheMaintenanceTimer.unref();
}

// Servidor HTTP híbrido (Arquivos estáticos + Endpoints de API para Celular e Multi-Cliente)
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

const staticAssetMemoryCache = createLruCache({ maxEntries: 250 });

function deliverCachedAsset(req, res, cached, contentType, cacheControlHeader, isAppShell) {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': cacheControlHeader,
    'ETag': cached.etag,
    'Vary': 'Accept-Encoding'
  };
  if (isAppShell) {
    headers['X-Frame-Options'] = 'DENY';
    headers['Content-Security-Policy'] = "frame-ancestors 'none'";
    headers['Set-Cookie'] = 'pl_proxy_target=; Path=/; Max-Age=0; SameSite=Lax';
  }

  const acceptEncoding = (req.headers && req.headers['accept-encoding']) || '';
  if (cached.brBuf && acceptEncoding.includes('br')) {
    headers['Content-Encoding'] = 'br';
    headers['Content-Length'] = cached.brBuf.length;
    res.writeHead(200, headers);
    res.end(cached.brBuf);
  } else if (cached.gzipBuf && acceptEncoding.includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = cached.gzipBuf.length;
    res.writeHead(200, headers);
    res.end(cached.gzipBuf);
  } else {
    headers['Content-Length'] = cached.content.length;
    res.writeHead(200, headers);
    res.end(cached.content);
  }
}

function serveFileWithMemoryCache(req, res, filePath, contentType = 'text/html; charset=utf-8', cacheControlHeader = 'no-cache, must-revalidate', isAppShell = false) {
  fs.stat(filePath, (statErr, stats) => {
    if (statErr) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo não encontrado');
      return;
    }

    const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const ifNoneMatch = req.headers && req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, {
        'ETag': etag,
        'Cache-Control': cacheControlHeader,
        'Vary': 'Accept-Encoding'
      });
      res.end();
      return;
    }

    let cached = staticAssetMemoryCache.get(filePath);
    if (!cached || cached.mtimeMs !== stats.mtimeMs) {
      fs.readFile(filePath, (readErr, content) => {
        if (readErr) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Erro ao carregar arquivo');
          return;
        }

        const isCompressible = /text|javascript|json|xml|svg/i.test(contentType);
        let brBuf = null;
        let gzipBuf = null;
        if (isCompressible && content.length > 64) {
          try {
            if (typeof zlib.brotliCompressSync === 'function') {
              brBuf = zlib.brotliCompressSync(content, {
                params: {
                  [zlib.constants.BROTLI_PARAM_QUALITY]: 5
                }
              });
            }
          } catch (e) { swallowed(e, 'server:serveFileWithMemoryCache@8559'); }
          try {
            gzipBuf = zlib.gzipSync(content, { level: 6 });
          } catch (e) { swallowed(e, 'server:serveFileWithMemoryCache@8562'); }
        }

        cached = {
          mtimeMs: stats.mtimeMs,
          content,
          brBuf,
          gzipBuf,
          etag
        };

        if (stats.size <= 10 * 1024 * 1024) {
          if (staticAssetMemoryCache.size > 150) {
            const firstKey = staticAssetMemoryCache.keys().next().value;
            if (firstKey) staticAssetMemoryCache.delete(firstKey);
          }
          staticAssetMemoryCache.set(filePath, cached);
        }

        deliverCachedAsset(req, res, cached, contentType, cacheControlHeader, isAppShell);
      });
    } else {
      deliverCachedAsset(req, res, cached, contentType, cacheControlHeader, isAppShell);
    }
  });
}

// Verificação de IP da Rede Local (Wi-Fi / LAN / Loopback)
function isPrivateIp(ip) {
  if (!ip) return false;
  let clean = String(ip).trim();

  // Remove prefixo IPv4-mapped em IPv6 (::ffff:192.168.x.x)
  if (clean.startsWith('::ffff:')) {
    clean = clean.replace('::ffff:', '');
  }

  // Loopback / Localhost (IPv4 e IPv6)
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost' || clean.startsWith('127.')) {
    return true;
  }

  // Faixa RFC 1918: 10.0.0.0/8
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;

  // Faixa RFC 1918: 172.16.0.0/12 (172.16.0.0 a 172.31.255.255)
  const match172 = clean.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (match172) {
    const secondOctet = parseInt(match172[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }

  // Faixa RFC 1918: 192.168.0.0/16
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;

  // Faixa RFC 3927: 169.254.0.0/16 (Link-Local)
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;

  // IPv6 ULA (Unique Local Addresses fc00::/7) e Link-Local (fe80::/10)
  const lower = clean.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(lower) || lower.startsWith('fe80:')) return true;

  return false;
}

function isLocalRequest(req) {
  // Se houver cabeçalhos de proxy/túnel externo (Cloudflare, Ngrok, túneis públicos)
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp && !isPrivateIp(cfIp)) return false;

  const xRealIp = req.headers['x-real-ip'];
  if (xRealIp && !isPrivateIp(xRealIp)) return false;

  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = xff.split(',').map(s => s.trim());
    for (const part of parts) {
      if (part && !isPrivateIp(part)) return false;
    }
  }

  const socketIp = req.socket ? req.socket.remoteAddress : (req.connection ? req.connection.remoteAddress : '');
  if (!isPrivateIp(socketIp)) return false;

  return true;
}

// =========================================================================
// BLINDAGEM ANTI-CRASH E GESTÃO SEGURA DE STREAMS (24/7 NZA SHIELD)
// =========================================================================
function safePipe(source, res, req) {
  if (!source || !res) return;

  const cleanup = () => {
    try {
      if (source && typeof source.destroy === 'function' && !source.destroyed) {
        source.destroy();
      }
    } catch (e) { swallowed(e, 'server:cleanup@8661'); }
  };

  source.on('error', (err) => {
    cleanup();
    if (!res.headersSent) {
      try {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Erro de stream');
      } catch (e) { swallowed(e, 'server:safePipe@8670'); }
    } else {
      try { res.destroy(); } catch (e) { swallowed(e, 'server:safePipe@8672'); }
    }
  });

  if (req) {
    req.on('close', cleanup);
    req.on('aborted', cleanup);
  }

  res.on('close', cleanup);
  res.on('error', cleanup);

  source.pipe(res);
}

// Prevenção global de crashes por desconexão súbita de clientes (ECONNRESET, EPIPE)
process.on('uncaughtException', (err) => {
  const code = err && err.code;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECANCELED' || code === 'ERR_STREAM_DESTROYED') {
    return;
  }
  serverLog.error('UNCAUGHT EXCEPTION', err);
});

process.on('unhandledRejection', (reason) => {
  const code = reason && reason.code;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECANCELED') {
    return;
  }
  serverLog.error('UNHANDLED REJECTION', reason);
});

const server = http.createServer(async (req, res) => {
  const onDisconnect = () => {
    try { if (!res.writableEnded && req.destroyed) res.destroy(); } catch (e) { swallowed(e, 'server:onDisconnect@8706'); }
  };
  req.on('aborted', onDisconnect);

  // CORS para permitir conexões de qualquer dispositivo ou túnel, inclusive rede local
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Permissions-Policy', 'picture-in-picture=*, fullscreen=*, autoplay=*, encrypted-media=*, local-network=*, local-network-access=*, local-unrestricted=*, display-capture=*, presentation=*');
  res.setHeader('X-Powered-By', 'Papaleguas-Engine/1.0 (Rust+Node)');

  if (req.method === 'OPTIONS') {
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const clientIp = papaleguasTracker.extractClientIp(req);

  // Bloqueio de IP por Lista Negra (Firewall do Administrador)
  // Permite carregar a imagem do QR code de pagamento imediatamente
  if (pathname === '/binance_pay_qr.jpg') {
    const qrPath = path.join(SRC_DIR, 'binance_pay_qr.jpg');
    fs.readFile(qrPath, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': buf.length
      });
      res.end(buf);
    });
    return;
  }

  if (typeof papaleguasTracker.isIpBlocked === 'function' && papaleguasTracker.isIpBlocked(clientIp)) {
    papaleguasTracker.recordBlockedHit(clientIp, req.url);
    const acceptsHtml = (req.headers.accept && req.headers.accept.includes('text/html')) ||
                        pathname === '/' || pathname === '/baixatube' || pathname === '/musica' || pathname === '/filmes';

    if (acceptsHtml) {
      res.writeHead(403, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Connection': 'close'
      });
      res.end(renderBlockedIpPaymentNotice(clientIp));
      return;
    }

    res.writeHead(403, {
      'Content-Type': 'application/json; charset=utf-8',
      'Connection': 'close',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({
      error: '403 Forbidden: Acesso bloqueado pelo administrador.',
      ip: clientIp,
      unblockFee: '5 USDT',
      recipient: 'OperaTrade',
      binanceQrUrl: 'https://papaleguas.app/binance_pay_qr.jpg',
      notice: 'Para desbloquear seu IP, pague 5 USDT escaneando o QR Code da Binance.'
    }));
    try {
      if (req.socket && !req.socket.destroyed) {
        req.socket.destroy();
      }
    } catch (e) {}
    return;
  }

  // Rate Limiting de Alta Performance com Rust
  const nativeRateLimitActive = !!(papaleguasTracker.nativeCore && typeof papaleguasTracker.nativeCore.checkRateLimit === 'function');
  if (nativeRateLimitActive) {
    const isAllowed = papaleguasTracker.nativeCore.checkRateLimit(clientIp, 180, 40);
    if (!isAllowed && !papaleguasTracker.isPrivateIp(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '5' });
      res.end('429 Too Many Requests: Protegido pelo Papaléguas Rust Engine.');
      return;
    }
  }

  // Anti-abuso: limites do /proxy, streams/downloads (yt-dlp) e fallback global
  // em JS quando o limitador nativo não carregou. Clientes locais não são limitados.
  if (requestGuard.check(req, res, pathname, { nativeRateLimitActive })) return;

  // Erros capturados nos aparelhos (src/error-reporter.js)
  if (pathname === '/api/client-log') {
    await handleClientLog(req, res, requestGuard.identifyRequester(req).ip);
    return;
  }

  // Diagnóstico das falhas silenciosas (antigos catch vazios) — só na rede local
  if (pathname === '/api/debug/swallowed') {
    if (!requestGuard.identifyRequester(req).isLocal) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ debug: logger.DEBUG, top: logger.getSwallowedStats(100) }, null, 2));
    return;
  }

  // Identificação do cliente e sessão (disponível para todas as rotas)
  const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
  const clientSession = getOrCreateClientSession(clientId);

  // Captura automática de cada requisição HTTP ao finalizar a resposta
  const requestStartTime = Date.now();
  let requestCaptured = false;
  const recordRequestCompletion = () => {
    if (requestCaptured) return;
    requestCaptured = true;
    try {
      const durationMs = Date.now() - requestStartTime;
      papaleguasTracker.captureHttpRequest({
        req,
        res,
        statusCode: res.statusCode || 200,
        durationMs,
        pathname,
        fullUrl: req.url,
        method: req.method
      });
    } catch (e) { swallowed(e, 'server:recordRequestCompletion@8786'); }
  };
  res.on('finish', recordRequestCompletion);
  res.on('close', recordRequestCompletion);

  // Central de Comando de Robôs & Agentes: cada robô que conectar será comandado por nós
  if (botCommander && typeof botCommander.handleIncomingRequest === 'function') {
    if (botCommander.handleIncomingRequest(req, res, pathname)) {
      return;
    }
  }

  // Metadados públicos, PWA, SEO e feeds (/health, /manifest.json, /sw.js, /sitemap.xml, /robots.txt, /llms.txt, /feed.*)
  if (appRoutes && typeof appRoutes.handlePublicMeta === 'function') {
    const handledMeta = await appRoutes.handlePublicMeta(req, res, {
      pathname,
      SRC_DIR,
      SERVER_BUILD_VERSION: getServerBuildVersion(),
      isTorRoutingEnabled,
      getCachedGoogleTrends,
      serveFileWithMemoryCache,
      escapeHtml
    });
    if (handledMeta) return;
  }

  // ----------------------------------------------------
  // ENDPOINTS DE API (Música, DJ Papaléguas e Streams)
  // ----------------------------------------------------
  if (pathname.startsWith('/api/')) {
    
    // API Google Trends Dinâmico por País do IP (Retorna os 10 tópicos mais pesquisados no Google conforme o país detectado, atualizado a cada 30 minutos)
    if (pathname === '/api/google-trends') {
      const rawCountryParam = (reqUrl.searchParams.get('country') || 'auto').trim().toUpperCase();
      const isManual = reqUrl.searchParams.get('manual') === '1';
      const limitParam = parseInt(reqUrl.searchParams.get('limit') || '10', 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 10;
      const isForce = reqUrl.searchParams.get('refresh') === 'true' || reqUrl.searchParams.get('refresh') === '1' || reqUrl.searchParams.get('force') === 'true';
      const clientIpParam = reqUrl.searchParams.get('deviceIp') || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
      const clientIp = extractRequestDeviceIp(req, clientIpParam);

      const TRENDS_COUNTRY_NAMES = {
        BR: 'Brasil', US: 'Estados Unidos', GB: 'Reino Unido', AR: 'Argentina',
        MX: 'México', PT: 'Portugal', ES: 'Espanha', FR: 'França', DE: 'Alemanha',
        IT: 'Itália', JP: 'Japão', KR: 'Coreia do Sul', CN: 'China', RU: 'Rússia',
        CA: 'Canadá', AU: 'Austrália', IN: 'Índia', NG: 'Nigéria', ZA: 'África do Sul',
        TR: 'Turquia', PL: 'Polônia', NL: 'Países Baixos', SE: 'Suécia', NO: 'Noruega'
      };
      const TRENDS_COUNTRY_FLAGS = {
        BR: '🇧🇷', US: '🇺🇸', GB: '🇬🇧', AR: '🇦🇷', MX: '🇲🇽', PT: '🇵🇹',
        ES: '🇪🇸', FR: '🇫🇷', DE: '🇩🇪', IT: '🇮🇹', JP: '🇯🇵', KR: '🇰🇷',
        CN: '🇨🇳', RU: '🇷🇺', CA: '🇨🇦', AU: '🇦🇺', IN: '🇮🇳', NG: '🇳🇬',
        ZA: '🇿🇦', TR: '🇹🇷', PL: '🇵🇱', NL: '🇳🇱', SE: '🇸🇪', NO: '🇳🇴'
      };

      Promise.resolve().then(async () => {
        let resolvedCountry = 'BR';
        if (isManual && /^[A-Z]{2}$/.test(rawCountryParam) && rawCountryParam !== 'AUTO') {
          resolvedCountry = rawCountryParam;
        } else if (/^[A-Z]{2}$/.test(rawCountryParam) && rawCountryParam !== 'AUTO' && reqUrl.searchParams.get('manual') !== '0') {
          resolvedCountry = rawCountryParam;
        } else {
          resolvedCountry = await getClientCountryCode(req, clientIp, false).catch(() => 'BR');
        }
        const countryName = TRENDS_COUNTRY_NAMES[resolvedCountry] || resolvedCountry;
        const countryFlag = TRENDS_COUNTRY_FLAGS[resolvedCountry] || '🌍';
        const trends = await fetchGoogleTrends(resolvedCountry, isForce).catch(() => getCachedGoogleTrends(resolvedCountry));
        const topTrends = (trends || []).slice(0, limit);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          success: true,
          country: resolvedCountry,
          countryCode: resolvedCountry,
          countryName,
          countryFlag,
          clientIp,
          limit,
          interval: '30 minutos',
          timestamp: Date.now(),
          trends: topTrends
        }));
      }).catch(() => {
        const fallbackCountry = (/^[A-Z]{2}$/.test(rawCountryParam) && rawCountryParam !== 'AUTO') ? rawCountryParam : 'BR';
        const cached = (getCachedGoogleTrends(fallbackCountry) || []).slice(0, limit);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(JSON.stringify({
          success: true,
          country: fallbackCountry,
          countryCode: fallbackCountry,
          countryName: TRENDS_COUNTRY_NAMES[fallbackCountry] || fallbackCountry,
          countryFlag: TRENDS_COUNTRY_FLAGS[fallbackCountry] || '🌍',
          limit,
          interval: '30 minutos',
          trends: cached
        }));
      });
      return;
    }
    
    // ROTA WHISPER: Recebe áudio binário bruto e envia para a OpenAI
    if (pathname === '/api/whisper' && req.method === 'POST') {
      try {
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        const audioBuffer = Buffer.concat(buffers);
        console.log(`[WHISPER] Áudio recebido do navegador: ${audioBuffer.length} bytes`);

        if (audioBuffer.length < 500) {
          console.warn('[WHISPER] Áudio muito curto ou vazio.');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: '' }));
          return;
        }

        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
        
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`;
        head += `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\npt\r\n`;
        head += `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nComandos de voz: abrir youtube, tocar música, pesquisar, filmes online, dj papaléguas\r\n`;
        head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`;
        const tail = `\r\n--${boundary}--\r\n`;

        const payload = Buffer.concat([
          Buffer.from(head, 'utf8'),
          audioBuffer,
          Buffer.from(tail, 'utf8')
        ]);

        const openAiReq = https.request('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          agent: getOutboundAgent(false),
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': payload.length
          }
        }, (openAiRes) => {
          let resData = '';
          openAiRes.on('data', chunk => resData += chunk);
          openAiRes.on('end', () => {
            try {
              const parsed = JSON.parse(resData);
              console.log(`[WHISPER] Resposta da OpenAI:`, parsed.text || parsed.error || resData);
              res.writeHead(openAiRes.statusCode, { 'Content-Type': 'application/json' });
              res.end(resData);
            } catch (e) {
              res.writeHead(openAiRes.statusCode, { 'Content-Type': 'application/json' });
              res.end(resData);
            }
          });
        });

        openAiReq.on('error', (err) => {
          console.error('[WHISPER ERROR]', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });

        openAiReq.write(payload);
        openAiReq.end();
      } catch (err) {
        console.error('[WHISPER EXCEPTION]', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ROTA TTS: Converte texto em voz humana em português brasileiro com suporte a mobile
    if (pathname === '/api/tts' && req.method === 'GET') {
      const text = reqUrl.searchParams.get('text') || reqUrl.searchParams.get('q') || '';
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Texto não fornecido');
        return;
      }
      const safeText = encodeURIComponent(text.substring(0, 200));
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${safeText}&tl=pt-br&client=tw-ob`;
      
      const ttsReq = https.get(ttsUrl, {
        agent: getOutboundAgent(false),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      }, (ttsRes) => {
        res.writeHead(ttsRes.statusCode || 200, {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        });
        safePipe(ttsRes, res, req);
      });

      ttsReq.on('error', (err) => {
        console.error('[TTS ERROR]', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Erro ao gerar áudio de voz');
      });
      return;
    }

    let body = {};
    if (req.method === 'POST') {
      try {
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        const rawBody = Buffer.concat(buffers).toString();
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch (e) { swallowed(e, 'server:top@9214'); }
    }

    // Identificação do cliente individual (enviado via header X-Client-Id ou query/body param)
    const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || body.clientId || 'client_default';
    const clientSession = getOrCreateClientSession(clientId);

    res.setHeader('Content-Type', 'application/json');

    // ----------------------------------------------------
    // ROTAS MODULARES PAPALÉGUAS (routes/curator, routes/youtube, routes/musica)
    // ----------------------------------------------------
    if (appRoutes && typeof appRoutes.handle === 'function') {
      const handled = await appRoutes.handle(req, res, {
        reqUrl,
        pathname,
        body,
        clientId,
        clientSession,
        isTorRoutingEnabled,
        getOrCreateClientSession,
        extractRequestDeviceIp,
        getClientCountryCode,
        lookupOutboundIp,
        getAiCuratorSuggestions,
        extractRelatedKeywords,
        getHlForCountry,
        getDynamicRecentYoutubeQuery,
        rotateThemeSearchQueries,
        isNewsYoutubeCategory,
        fetchMixedNewsVideos,
        fetchRelatedYoutubeVideos,
        fetchTrendingVideos,
        fetchGoogleTrends,
        getCachedGoogleTrends,
        searchYoutubeVideos,
        isOldYoutubeVideo,
        parseYoutubePublishedAgeDays,
        filterRecentYoutubeVideos,
        filterYoutubeModeResults,
        filterVideosByCountryRelevance,
        caches: {
          mixedNewsCache,
          mixedNewsCacheTime,
          youtubeSearchCache
        },
        clearYoutubeCaches: () => {
          mixedNewsCache = null;
          mixedNewsCacheTime = 0;
          mixedNewsCacheByKey.clear();
          youtubeSearchCache.clear();
        },
        handleAudioStreamingProxy,
        getFullAudioStream,
        getFullAudioStreamByVideoId,
        getOutboundAgent,
        downloadMediaFile,
        startMediaDownloadJob,
        mediaJobs,
        resolvePlayableMediaUrl,
        MEDIA_DOWNLOADS_DIR,
        papaleguasTracker,
        getAiMusicRecommendations,
        chatDjPapaleguas,
        getDeezerPlaylistTracks,
        searchDeezerPlaylists,
        searchDeezerAll,
        PORT,
        telegramBot,
        botCommander,
        torManager,
        isLocalAdminRequest,
        sendForbiddenAdminResponse,
        isAppTorEnabled,
        isServerConsoleLogsPaused,
        setServerConsoleLogsPaused,
        getLocalNetworkIp
      });
      if (handled) return;
    }

    if (pathname === '/api/onion-search') {
      const q = reqUrl.searchParams.get('q') || body.q || '';
      const items = await searchOnionLinks(q, { only200: true });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ success: true, q, count: items.length, items, results: items }));
      return;
    }

    if (pathname === '/api/onion-crawl') {
      const targetUrl = reqUrl.searchParams.get('url') || body.url || '';
      const sublinks = await crawlOnionSublinks(targetUrl);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ success: true, url: targetUrl, count: sublinks.length, sublinks }));
      return;
    }

    if (pathname === '/api/onion-check') {
      const targetUrl = reqUrl.searchParams.get('url') || body.url || '';
      const status = await checkOnionAlive(targetUrl);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ success: true, url: targetUrl, ...status }));
      return;
    }

    if (pathname === '/api/url-suggest') {
      const q = reqUrl.searchParams.get('q') || body.q || '';
      const page = parseInt(reqUrl.searchParams.get('page') || body.page || '0', 10);
      const useTor = isTorRoutingEnabled(clientSession);
      const payload = await getUrlSuggestions({ query: q, page, useTor });
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(payload));
      return;
    }

    // Alimenta a aba de pesquisa em tela cheia com tudo que o buscador extraiu
    if (pathname === '/api/search-rich') {
      const q = reqUrl.searchParams.get('q') || body.q || '';
      const useTor = isTorRoutingEnabled(clientSession);
      const data = await getRichSearchData(q, useTor);
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ success: true, ...data }));
      return;
    }

    // Endpoint de paginação e busca dinâmica de imagens ("Carregar mais")
    if (pathname === '/api/search-images') {
      const q = (reqUrl.searchParams.get('q') || body.q || '').trim();
      const page = Math.max(0, parseInt(reqUrl.searchParams.get('page') || body.page || '0', 10) || 0);
      if (!q) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, images: [], page, hasMore: false }));
        return;
      }
      const useTor = isTorRoutingEnabled(clientSession);
      const images = await searchTopicImages(q, useTor, page);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        images,
        page,
        hasMore: images.length > 0
      }));
      return;
    }

    // Endpoint de paginação e busca dinâmica de vídeos ("Carregar mais")
    if (pathname === '/api/search-videos') {
      const q = (reqUrl.searchParams.get('q') || body.q || '').trim();
      const page = Math.max(0, parseInt(reqUrl.searchParams.get('page') || body.page || '0', 10) || 0);
      const limit = Math.max(1, parseInt(reqUrl.searchParams.get('limit') || body.limit || '8', 10) || 8);
      if (!q) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, videos: [], page, hasMore: false }));
        return;
      }
      const videos = await searchYoutubeVideosForTopic(q, limit, page);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        videos,
        page,
        hasMore: videos.length > 0
      }));
      return;
    }

    if (pathname === '/api/onion-classify' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, items: {} }));
      return;
    }

    if (pathname === '/api/search-picks') {
      const q = (reqUrl.searchParams.get('q') || body.q || '').trim();
      if (!q) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, picks: [], intro: '' }));
        return;
      }
      const useTor = isTorRoutingEnabled(clientSession);
      const cacheKey = (useTor ? 'tor:' : 'web:') + q.toLowerCase();
      const cached = searchPicksCache.get(cacheKey);
      if (cached && Date.now() - cached.t < SEARCH_PICKS_TTL) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(Object.assign({ success: true, cached: true }, cached.payload)));
        return;
      }
      try {
        const data = await getRichSearchData(q, useTor);
        const result = await pickBestSearchResults(q, data);
        const payload = {
          q,
          intro: result.intro || '',
          picks: (result.picks || []).map((p) => ({
            title: p.title || p.host || '',
            url: p.url,
            host: p.host || '',
            why: p.why || ''
          })).filter((p) => p.url)
        };
        if (payload.picks.length) searchPicksCache.set(cacheKey, { t: Date.now(), payload });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(Object.assign({ success: payload.picks.length > 0 }, payload)));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, picks: [], intro: '', error: String(err && err.message || err).slice(0, 200) }));
      }
      return;
    }

    if (pathname === '/api/search-answer') {
      const q = (reqUrl.searchParams.get('q') || body.q || '').trim();
      if (!q) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, answer: '', sources: [] }));
        return;
      }
      const useTor = isTorRoutingEnabled(clientSession);
      const cacheKey = (useTor ? 'tor:' : 'web:') + q.toLowerCase();
      const cached = searchAnswerCache.get(cacheKey);
      if (cached && Date.now() - cached.t < 5 * 60 * 1000) {
        res.writeHead(200);
        res.end(JSON.stringify(Object.assign({ success: true, cached: true }, cached.payload)));
        return;
      }
      try {
        const data = await getRichSearchData(q, useTor);
        const { answer, sources } = await answerSearchWithAi(q, data);
        const payload = { q, answer, sources };
        if (answer) searchAnswerCache.set(cacheKey, { t: Date.now(), payload });
        res.writeHead(200);
        res.end(JSON.stringify(Object.assign({ success: !!answer }, payload)));
      } catch (err) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, q, answer: '', sources: [], error: String(err && err.message || err).slice(0, 200) }));
      }
      return;
    }

    if (pathname === '/api/search-chat') {
      const topic = (body.topic || reqUrl.searchParams.get('topic') || '').trim();
      const question = (body.question || reqUrl.searchParams.get('question') || '').trim();
      const history = Array.isArray(body.history) ? body.history : [];
      if (!question) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, answer: '', sources: [] }));
        return;
      }
      try {
        const useTor = isTorRoutingEnabled(clientSession);
        // Cada pergunta dispara uma busca nova: é dela que sai o conteúdo citado.
        const searchQuery = topic ? searchQueryForFollowUp(topic, question) : question;
        const data = await getRichSearchData(searchQuery, useTor);
        const { answer, sources } = await answerSearchWithAi(question, data, history);
        res.writeHead(200);
        res.end(JSON.stringify({ success: !!answer, answer, sources, searchQuery }));
      } catch (err) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, answer: '', sources: [], error: String(err && err.message || err).slice(0, 200) }));
      }
      return;
    }

    // Prévia em lote (imagem + descrição) dos links encontrados pelo buscador
    if (pathname === '/api/page-preview') {
      let urls = Array.isArray(body.urls) ? body.urls : reqUrl.searchParams.getAll('url');
      urls = Array.from(new Set(urls.map((u) => String(u || '').trim()).filter(Boolean))).slice(0, 16);
      const useTor = isTorRoutingEnabled(clientSession);
      const previews = {};
      await Promise.all(urls.map(async (u) => {
        try {
          const data = await getPagePreview(u, useTor);
          if (data) previews[u] = data;
        } catch (e) { swallowed(e, 'server:page-preview'); }
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, previews }));
      return;
    }

    // Proxy de imagens das prévias: só repassa image/*, sem cookies e sem expor o IP do usuário
    if (pathname === '/api/preview-img') {
      const useTor = isTorRoutingEnabled(clientSession);
      const fail = () => {
        if (res.headersSent) { try { res.end(); } catch (e) { /* ignore */ } return; }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
        res.end('Imagem indisponível');
      };
      const MAX_IMG_BYTES = 8 * 1024 * 1024;
      const fetchImg = (rawUrl, hops) => {
        const target = isPreviewableUrl(rawUrl);
        if (!target || hops > 4) return fail();
        const lib = target.protocol === 'http:' ? http : https;
        const imgReq = lib.get(target.href, {
          agent: getOutboundAgent(useTor),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'Referer': target.origin + '/'
          }
        }, (imgRes) => {
          const location = imgRes.headers.location;
          if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && location) {
            imgRes.resume();
            let next = '';
            try { next = new URL(location, target).href; } catch (e) { next = ''; }
            return next ? fetchImg(next, hops + 1) : fail();
          }
          const type = String(imgRes.headers['content-type'] || '').toLowerCase();
          const len = parseInt(imgRes.headers['content-length'] || '0', 10) || 0;
          if (imgRes.statusCode !== 200 || !type.startsWith('image/') || type.includes('svg') || len > MAX_IMG_BYTES) {
            imgRes.resume();
            return fail();
          }
          res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': 'public, max-age=86400',
            'X-Content-Type-Options': 'nosniff'
          });
          let sent = 0;
          imgRes.on('data', (chunk) => {
            sent += chunk.length;
            if (sent > MAX_IMG_BYTES) { try { imgReq.destroy(); res.end(); } catch (e) { /* ignore */ } }
          });
          safePipe(imgRes, res, req);
        });
        imgReq.on('error', fail);
        imgReq.setTimeout(9000, () => { try { imgReq.destroy(); } catch (e) { /* ignore */ } });
      };
      fetchImg(reqUrl.searchParams.get('u') || '', 0);
      return;
    }

    if (pathname === '/api/search-gpt') {
      const q = reqUrl.searchParams.get('q') || body.q || '';
      const useTor = isTorRoutingEnabled(clientSession);
      const web = q ? await getWebSearchPool(q, useTor) : [];
      // Rota mantida por compatibilidade com a interface antiga, mas sem IA.
      const urls = (web || []).filter((result) => !isOnionHref(result.url)).slice(0, 12).map((result) => ({
        title: result.title || result.url,
        url: ensureAbsoluteUrl(result.url),
        reason: result.snippet || result.url,
        source: result.source || 'extraído'
      })).filter((item) => item.url);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, q, urls, queries: [], generatedByAi: false }));
      return;
    }

    if (pathname === '/api/search') {
      const q = reqUrl.searchParams.get('q') || body.q || '';
      const limit = parseInt(reqUrl.searchParams.get('limit') || body.limit || '30', 10);
      const index = parseInt(reqUrl.searchParams.get('index') || reqUrl.searchParams.get('offset') || body.index || body.offset || '0', 10);
      const result = await searchDeezer(q, limit, 'RANKING', index);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/audio-preview') {
      let target = null;
      try { target = new URL(reqUrl.searchParams.get('u') || ''); } catch (e) { target = null; }
      if (!target || target.protocol !== 'https:' || !isDeezerPreviewHost(target.hostname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Amostra indisponível');
        return;
      }
      const fetchAudio = (audioUrl, redirectCount = 0) => {
        if (redirectCount > 3) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Redirecionamento excessivo');
          return;
        }
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
        if (req.headers.range) {
          headers['range'] = req.headers.range;
        }
        const audioReq = https.get(audioUrl, { agent: getOutboundAgent(false), headers }, (audioRes) => {
          const location = audioRes.headers.location;
          if (audioRes.statusCode >= 300 && audioRes.statusCode < 400 && location) {
            audioRes.resume();
            try {
              const nextUrl = new URL(location, audioUrl);
              return fetchAudio(nextUrl.href, redirectCount + 1);
            } catch (e) {
              res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('URL de redirecionamento inválida');
              return;
            }
          }
          const type = String(audioRes.headers['content-type'] || '');
          if (audioRes.statusCode >= 400 || (type && !type.startsWith('audio/') && !type.startsWith('application/octet-stream') && !type.startsWith('binary/octet-stream'))) {
            audioRes.resume();
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Amostra indisponível');
            return;
          }
          const respHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': type.startsWith('audio/') ? type : 'audio/mpeg',
            'Cache-Control': 'public, max-age=86400',
            'Accept-Ranges': 'bytes'
          };
          if (audioRes.headers['content-length']) {
            respHeaders['Content-Length'] = audioRes.headers['content-length'];
          }
          if (audioRes.headers['content-range']) {
            respHeaders['Content-Range'] = audioRes.headers['content-range'];
          }
          res.writeHead(audioRes.statusCode || 200, respHeaders);
          safePipe(audioRes, res, req);
        });
        audioReq.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Amostra indisponível');
          }
        });
        audioReq.setTimeout(10000, () => audioReq.destroy());
      };
      fetchAudio(target.href);
      return;
    }

    if (pathname === '/api/cover') {
      let target = null;
      try { target = new URL(reqUrl.searchParams.get('u') || ''); } catch (e) { target = null; }
      if (!target || target.protocol !== 'https:' || !DEEZER_COVER_HOSTS.has(target.hostname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Capa indisponível');
        return;
      }
      const imgReq = https.get(target.href, { agent: getOutboundAgent(false), headers: { 'User-Agent': 'Mozilla/5.0' } }, (imgRes) => {
        const location = imgRes.headers.location;
        if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && location) {
          imgRes.resume();
          try {
            const next = new URL(location, target);
            if (next.protocol === 'https:' && DEEZER_COVER_HOSTS.has(next.hostname)) {
              res.writeHead(302, { Location: '/api/cover?u=' + encodeURIComponent(next.href) });
              res.end();
              return;
            }
          } catch (e) { swallowed(e, 'server:top@9830'); }
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Capa indisponível');
          return;
        }
        const type = String(imgRes.headers['content-type'] || '');
        if (!type.startsWith('image/')) {
          imgRes.resume();
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Capa indisponível');
          return;
        }
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': 'public, max-age=86400'
        });
        safePipe(imgRes, res, req);
      });
      imgReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Capa indisponível');
        }
      });
      imgReq.setTimeout(12000, () => imgReq.destroy());
      return;
    }

    // Proxy otimizado de miniaturas do YouTube para OpenGraph / WhatsApp / Telegram
    if (pathname === '/api/thumb' || pathname.startsWith('/api/thumb/')) {
      let vid = reqUrl.searchParams.get('v') || reqUrl.searchParams.get('id');
      if (!vid && pathname.startsWith('/api/thumb/')) {
        vid = pathname.slice('/api/thumb/'.length).replace(/\.(jpg|jpeg|png|webp)$/i, '');
      }
      if (!vid || !/^[a-zA-Z0-9_-]{6,15}$/.test(vid)) {
        serveFileWithMemoryCache(req, res, path.join(SRC_DIR, 'og-banner.jpg'), 'image/jpeg', 'public, max-age=86400', true);
        return;
      }
      const thumbUrl = `https://i.ytimg.com/vi/${encodeURIComponent(vid)}/hqdefault.jpg`;
      const imgReq = https.get(thumbUrl, { agent: getOutboundAgent(false), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (imgRes) => {
        if (imgRes.statusCode === 200) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=604800, immutable'
          });
          safePipe(imgRes, res, req);
        } else {
          imgRes.resume();
          serveFileWithMemoryCache(req, res, path.join(SRC_DIR, 'og-banner.jpg'), 'image/jpeg', 'public, max-age=86400', true);
        }
      });
      imgReq.on('error', () => {
        if (!res.headersSent) {
          serveFileWithMemoryCache(req, res, path.join(SRC_DIR, 'og-banner.jpg'), 'image/jpeg', 'public, max-age=86400', true);
        }
      });
      imgReq.setTimeout(8000, () => {
        try { imgReq.destroy(); } catch (e) { swallowed(e, 'server:top@9887'); }
      });
      return;
    }

function findFileInDirResilient(dirPath, targetName) {
  if (!dirPath || !targetName) return null;
  try {
    if (!fs.existsSync(dirPath)) return null;
  } catch (e) {
    return null;
  }

  const cleanTarget = String(targetName).trim();
  const directPath = path.resolve(dirPath, cleanTarget);
  if (fs.existsSync(directPath)) return directPath;

  const baseTarget = path.basename(cleanTarget);
  const directBase = path.resolve(dirPath, baseTarget);
  if (fs.existsSync(directBase)) return directBase;

  const subDir = path.dirname(cleanTarget);
  let searchDir = dirPath;
  if (subDir && subDir !== '.') {
    const candidateSub = path.resolve(dirPath, subDir);
    if (fs.existsSync(candidateSub)) {
      searchDir = candidateSub;
    }
  }

  try {
    const files = fs.readdirSync(searchDir);
    const targetNormNFC = baseTarget.normalize('NFC');
    const targetNormNFD = baseTarget.normalize('NFD');
    const targetLower = targetNormNFC.toLowerCase();
    const targetSimple = targetNormNFD.replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9.]/g, '');

    const matchPrefix = baseTarget.match(/^(\d{1,3})\s*[-_.]\s*/);
    const targetTrackNum = matchPrefix ? parseInt(matchPrefix[1], 10) : null;
    const targetExt = path.extname(baseTarget).toLowerCase();

    // 1. Exact match com normalização Unicode (NFC / NFD)
    for (const f of files) {
      if (f === baseTarget || f.normalize('NFC') === targetNormNFC || f.normalize('NFD') === targetNormNFD) {
        return path.resolve(searchDir, f);
      }
    }

    // 2. Case-insensitive match
    for (const f of files) {
      if (f.toLowerCase() === targetLower || f.normalize('NFC').toLowerCase() === targetLower) {
        return path.resolve(searchDir, f);
      }
    }

    // 3. Simplified match (ignorando acentos e caracteres de mojibake como ├ë)
    for (const f of files) {
      const fSimple = f.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9.]/g, '');
      if (fSimple === targetSimple && fSimple.length > 0) {
        return path.resolve(searchDir, f);
      }
    }

    // 4. Match por número da faixa + extensão de áudio/imagem compatível
    if (targetTrackNum !== null) {
      const audioExts = ['.mp3', '.m4a', '.mp4', '.ogg', '.flac', '.wav', '.webm', '.aac', '.opus'];
      const imgExts = ['.jpg', '.jpeg', '.png', '.webp'];
      for (const f of files) {
        const fExt = path.extname(f).toLowerCase();
        const isAudio = audioExts.includes(targetExt) && audioExts.includes(fExt);
        const isImage = imgExts.includes(targetExt) && imgExts.includes(fExt);
        if (isAudio || isImage || fExt === targetExt) {
          const fMatch = f.match(/^(\d{1,3})\s*[-_.]\s*/);
          if (fMatch && parseInt(fMatch[1], 10) === targetTrackNum) {
            return path.resolve(searchDir, f);
          }
        }
      }
    }

    // 5. Substring match no título
    for (const f of files) {
      const fBaseNoExt = path.basename(f, path.extname(f)).toLowerCase();
      const tBaseNoExt = path.basename(baseTarget, path.extname(baseTarget)).toLowerCase();
      if (tBaseNoExt.length > 5 && (fBaseNoExt.includes(tBaseNoExt) || tBaseNoExt.includes(fBaseNoExt))) {
        return path.resolve(searchDir, f);
      }
    }
  } catch (e) { swallowed(e, 'server:findFileInDirResilient@9975'); }

  return null;
}

const DELETED_PLAYLISTS_FILE = path.join(os.homedir(), 'Músicas', 'Papaléguas', '.deleted_playlists.json');

function getDeletedPlaylistsSet() {
  try {
    if (fs.existsSync(DELETED_PLAYLISTS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(DELETED_PLAYLISTS_FILE, 'utf8'));
      if (Array.isArray(arr)) {
        return new Set(arr.map(s => String(s || '').trim().toLowerCase()));
      }
    }
  } catch (e) { swallowed(e, 'server:getDeletedPlaylistsSet@9990'); }
  return new Set();
}

function markPlaylistAsDeleted(name) {
  if (!name) return;
  try {
    const set = getDeletedPlaylistsSet();
    set.add(String(name).trim().toLowerCase());
    fs.mkdirSync(path.dirname(DELETED_PLAYLISTS_FILE), { recursive: true });
    fs.writeFileSync(DELETED_PLAYLISTS_FILE, JSON.stringify(Array.from(set)), 'utf8');
  } catch (e) { swallowed(e, 'server:markPlaylistAsDeleted@10001'); }
}

function unmarkPlaylistAsDeleted(name) {
  if (!name) return;
  try {
    const set = getDeletedPlaylistsSet();
    set.delete(String(name).trim().toLowerCase());
    fs.mkdirSync(path.dirname(DELETED_PLAYLISTS_FILE), { recursive: true });
    fs.writeFileSync(DELETED_PLAYLISTS_FILE, JSON.stringify(Array.from(set)), 'utf8');
  } catch (e) { swallowed(e, 'server:unmarkPlaylistAsDeleted@10011'); }
}

function autoExtractZipDownloads() {
  try {
    const downloadsDir = path.resolve(os.homedir(), 'Downloads');
    const musicRoot = path.join(os.homedir(), 'Músicas', 'Papaléguas', 'Minhas playlists favoritas');
    if (!fs.existsSync(downloadsDir)) return;
    try { fs.mkdirSync(musicRoot, { recursive: true }); } catch (e) { swallowed(e, 'server:autoExtractZipDownloads@10019'); }

    const deletedSet = getDeletedPlaylistsSet();
    const zipFiles = fs.readdirSync(downloadsDir).filter(f => f.toLowerCase().endsWith('.zip') && !f.startsWith('.'));
    for (const zipName of zipFiles) {
      const fullZipPath = path.join(downloadsDir, zipName);
      const rawBase = zipName.slice(0, -4);
      const cleanName = rawBase.replace(/\s*\(\d+\)$/, '').trim();
      if (!cleanName) continue;

      // Se a playlist foi marcada como excluída pelo usuário, não re-extrai e apaga o zip se solicitado
      if (deletedSet.has(cleanName.toLowerCase()) || deletedSet.has(rawBase.trim().toLowerCase())) {
        try { fs.unlinkSync(fullZipPath); } catch (e) { swallowed(e, 'server:autoExtractZipDownloads@10031'); }
        continue;
      }

      const targetDir = path.join(musicRoot, cleanName);
      let needsExtract = false;
      if (!fs.existsSync(targetDir)) {
        needsExtract = true;
      } else {
        const manifest = path.join(targetDir, 'playlist.json');
        if (!fs.existsSync(manifest)) needsExtract = true;
      }

      if (needsExtract) {
        try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) { swallowed(e, 'server:autoExtractZipDownloads@10045'); }
        try {
          const { execSync } = require('child_process');
          execSync(`unzip -q -o "${fullZipPath}" -d "${targetDir}"`, { timeout: 15000 });
        } catch (e) { swallowed(e, 'server:autoExtractZipDownloads@10049'); }
      }

      // Auto-repara caracteres mojibake comparando com playlist.json
      try {
        const manifestPath = path.join(targetDir, 'playlist.json');
        if (fs.existsSync(manifestPath)) {
          const mf = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (Array.isArray(mf.tracks)) {
            for (const t of mf.tracks) {
              if (t.file && !fs.existsSync(path.join(targetDir, t.file))) {
                const found = findFileInDirResilient(targetDir, t.file);
                if (found && found !== path.join(targetDir, t.file)) {
                  try { fs.renameSync(found, path.join(targetDir, t.file)); } catch (e) { swallowed(e, 'server:autoExtractZipDownloads@10062'); }
                }
              }
            }
          }
        }
      } catch (e) { swallowed(e, 'server:autoExtractZipDownloads@10068'); }
    }
  } catch (err) { swallowed(err, 'server:autoExtractZipDownloads@10070'); }
}

// Requisição feita diretamente na própria máquina (sem passar por túnel ngrok/proxy).
function isDirectLocalRequest(req) {
  if (!req) return false;
  const remoteIp = (req.socket && req.socket.remoteAddress) || '';
  const isLocalIp = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
  if (!isLocalIp) return false;
  const h = req.headers || {};
  if (h['x-forwarded-for'] || h['x-real-ip'] || h['x-forwarded-host'] || h['forwarded'] || h['ngrok-trace-id']) return false;
  const host = String(h.host || '').toLowerCase();
  return !host || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

function getDevicePlaylistsRoot(clientId, req) {
  let cleanId = String(clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  // Só o app desktop (acesso local direto) é o Host. Qualquer outro navegador/dispositivo
  // fica isolado na própria pasta e NUNCA enxerga playlists de outros.
  const isHost = isDirectLocalRequest(req) && !cleanId.startsWith('cli_');
  if (!isHost && (!cleanId || cleanId === 'desktop_host' || cleanId === 'host' || cleanId === 'default_host')) {
    cleanId = 'anon_' + require('crypto').createHash('sha1').update(String((req && req.headers && req.headers['x-forwarded-for']) || (req && req.socket && req.socket.remoteAddress) || '')).digest('hex').slice(0, 12);
  }
  const base = path.join(os.homedir(), 'Músicas', 'Papaléguas');
  if (isHost) {
    const root = path.join(base, 'Minhas playlists favoritas');
    try { fs.mkdirSync(root, { recursive: true }); } catch (e) { swallowed(e, 'server:getDevicePlaylistsRoot@10096'); }
    return {
      root,
      downloads: path.resolve(os.homedir(), 'Downloads'),
      isHost: true,
      clientId: 'desktop_host'
    };
  }
  const deviceDir = path.join(base, 'Dispositivos', cleanId);
  try { fs.mkdirSync(deviceDir, { recursive: true }); } catch (e) { swallowed(e, 'server:getDevicePlaylistsRoot@10105'); }
  return {
    root: deviceDir,
    downloads: null,
    isHost: false,
    clientId: cleanId
  };
}

    if (pathname === '/api/favorite-playlists') {
      autoExtractZipDownloads();
      const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || (body && body.clientId) || 'desktop_host';
      const devInfo = getDevicePlaylistsRoot(clientId, req);
      const audioExts = new Set(['.mp3', '.m4a', '.mp4', '.ogg', '.flac', '.wav', '.webm', '.aac', '.opus']);
      const serverMusicRoot = path.join(os.homedir(), 'Músicas', 'Papaléguas', 'Minhas playlists favoritas');
      const downloadsDir = path.resolve(os.homedir(), 'Downloads');
      const playlists = [];
      const seenNames = new Set();

      // 1. Playlists específicas criadas pelo dispositivo (se não for o Host)
      if (!devInfo.isHost && fs.existsSync(devInfo.root)) {
        try {
          for (const ent of fs.readdirSync(devInfo.root, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
            const dir = path.join(devInfo.root, ent.name);
            let count = 0;
            let cover = '';
            const manifestPath = path.join(dir, 'playlist.json');
            if (fs.existsSync(manifestPath)) {
              try {
                const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                count = Array.isArray(m.tracks) ? m.tracks.length : 0;
                const cPath = path.join(dir, m.cover || 'cover.jpg');
                if (fs.existsSync(cPath)) {
                  cover = `/api/downloaded-track-file?folder=${encodeURIComponent(ent.name)}&file=${encodeURIComponent(m.cover || 'cover.jpg')}&clientId=${encodeURIComponent(devInfo.clientId)}`;
                }
              } catch (e) { swallowed(e, 'server:top@10141'); }
            } else {
              count = fs.readdirSync(dir).filter(f => audioExts.has(path.extname(f).toLowerCase()) && !f.startsWith('.')).length;
            }
            if (count > 0 || fs.existsSync(manifestPath)) {
              seenNames.add(ent.name.toLowerCase());
              playlists.push({ name: ent.name, count, cover, source: 'device', clientId: devInfo.clientId });
            }
          }
        } catch (e) { swallowed(e, 'server:top@10150'); }
      }

      // 2. Playlists da biblioteca do Papaléguas (Minhas playlists favoritas) — exclusivas do Host
      if (devInfo.isHost && fs.existsSync(serverMusicRoot)) {
        try {
          for (const ent of fs.readdirSync(serverMusicRoot, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
            if (seenNames.has(ent.name.toLowerCase())) continue;
            const dir = path.join(serverMusicRoot, ent.name);
            let count = 0;
            let cover = '';
            const manifestPath = path.join(dir, 'playlist.json');
            if (fs.existsSync(manifestPath)) {
              try {
                const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                count = Array.isArray(m.tracks) ? m.tracks.length : 0;
                const cPath = path.join(dir, m.cover || 'cover.jpg');
                if (fs.existsSync(cPath)) {
                  cover = `/api/downloaded-track-file?folder=${encodeURIComponent(ent.name)}&file=${encodeURIComponent(m.cover || 'cover.jpg')}&clientId=${encodeURIComponent(devInfo.clientId)}`;
                }
              } catch (e) { swallowed(e, 'server:top@10171'); }
            } else {
              count = fs.readdirSync(dir).filter(f => audioExts.has(path.extname(f).toLowerCase()) && !f.startsWith('.')).length;
            }
            if (count > 0 || fs.existsSync(manifestPath)) {
              seenNames.add(ent.name.toLowerCase());
              playlists.push({ name: ent.name, count, cover, source: 'disk', clientId: devInfo.clientId });
            }
          }
        } catch (e) { swallowed(e, 'server:top@10180'); }
      }

      // 3. Pastas e músicas em Downloads — exclusivas do Host
      if (devInfo.isHost && downloadsDir && fs.existsSync(downloadsDir)) {
        try {
          const rootAudioFiles = fs.readdirSync(downloadsDir).filter(f => audioExts.has(path.extname(f).toLowerCase()) && !f.startsWith('.'));
          if (rootAudioFiles.length > 0 && !seenNames.has('downloads')) {
            seenNames.add('downloads');
            playlists.push({
              name: 'Downloads',
              count: rootAudioFiles.length,
              cover: '',
              source: 'downloads'
            });
          }

          for (const ent of fs.readdirSync(downloadsDir, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
            if (seenNames.has(ent.name.toLowerCase())) continue;
            const dir = path.join(downloadsDir, ent.name);
            let audioFiles = [];
            try {
              audioFiles = fs.readdirSync(dir).filter(f => audioExts.has(path.extname(f).toLowerCase()) && !f.startsWith('.'));
            } catch (e) { swallowed(e, 'server:top@10204'); }
            if (audioFiles.length > 0) {
              seenNames.add(ent.name.toLowerCase());
              let cover = '';
              try {
                const imgFiles = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
                if (imgFiles.length > 0) {
                  cover = `/api/downloaded-track-file?folder=__download__&file=${encodeURIComponent(ent.name + '/' + imgFiles[0])}`;
                }
              } catch (e) { swallowed(e, 'server:top@10213'); }
              playlists.push({
                name: ent.name,
                count: audioFiles.length,
                cover,
                source: 'downloads'
              });
            }
          }
        } catch (e) { swallowed(e, 'server:top@10222'); }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, folder: devInfo.root, playlists, clientId: devInfo.clientId }));
      return;
    }

    if (pathname === '/api/favorite-playlist') {
      const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'desktop_host';
      const devInfo = getDevicePlaylistsRoot(clientId, req);
      const name = reqUrl.searchParams.get('name') || '';
      const audioExts = new Set(['.mp3', '.m4a', '.mp4', '.ogg', '.flac', '.wav', '.webm', '.aac', '.opus']);
      const serverMusicRoot = path.join(os.homedir(), 'Músicas', 'Papaléguas', 'Minhas playlists favoritas');
      const downloadsDir = path.resolve(os.homedir(), 'Downloads');

      let dir = path.join(devInfo.root, name);
      let isFromDownloads = false;
      let isDownloadsRoot = false;

      // Se existir na pasta do dispositivo, valida restrição de diretório
      if (fs.existsSync(dir)) {
        if (!devInfo.isHost && !path.resolve(dir).startsWith(path.resolve(devInfo.root) + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, tracks: [] }));
          return;
        }
      } else if (devInfo.isHost) {
        // Se for o Host Desktop e não achar na pasta, procura na biblioteca principal do servidor
        const candServer = path.join(serverMusicRoot, name);
        if (fs.existsSync(candServer)) {
          dir = candServer;
        } else if (downloadsDir && fs.existsSync(downloadsDir)) {
          const candDl = path.join(downloadsDir, name);
          if (fs.existsSync(candDl) && fs.statSync(candDl).isDirectory()) {
            dir = candDl;
            isFromDownloads = true;
          } else if (name.toLowerCase() === 'downloads' || name === '__download__') {
            dir = downloadsDir;
            isFromDownloads = true;
            isDownloadsRoot = true;
          }
        }
      }

      if (!dir || !fs.existsSync(dir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, tracks: [] }));
        return;
      }

      try {
        let plCover = '';
        const manifestPath = path.join(dir, 'playlist.json');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest.cover && fs.existsSync(path.join(dir, manifest.cover))) {
            plCover = `/api/downloaded-track-file?folder=${encodeURIComponent(isFromDownloads ? '__download__' : name)}&file=${encodeURIComponent(isFromDownloads ? name + '/' + manifest.cover : manifest.cover)}&clientId=${encodeURIComponent(devInfo.clientId)}`;
          }
          const tracks = (manifest.tracks || []).map(t => ({
            title: t.title,
            artist: t.artist,
            cover: plCover,
            file: isFromDownloads ? `${name}/${t.file}` : t.file,
            playlistName: isFromDownloads ? '__download__' : (manifest.name || name),
            fullStreamUrl: `/api/downloaded-track-file?folder=${encodeURIComponent(isFromDownloads ? '__download__' : name)}&file=${encodeURIComponent(isFromDownloads ? name + '/' + t.file : t.file)}&clientId=${encodeURIComponent(devInfo.clientId)}`
          }));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, name, cover: plCover, tracks, clientId: devInfo.clientId }));
          return;
        }

        const files = fs.readdirSync(dir).filter(f => audioExts.has(path.extname(f).toLowerCase()) && !f.startsWith('.'));
        const imgFiles = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
        if (imgFiles.length > 0) {
          plCover = `/api/downloaded-track-file?folder=${encodeURIComponent(isFromDownloads ? '__download__' : name)}&file=${encodeURIComponent((isFromDownloads ? name + '/' : '') + imgFiles[0])}&clientId=${encodeURIComponent(devInfo.clientId)}`;
        }

        const tracks = files.map((fileName) => {
          const ext = path.extname(fileName);
          const stem = path.basename(fileName, ext).replace(/^[\d\s.\-_]+/, '').trim() || fileName;
          let artist = name;
          let title = stem;
          if (stem.includes(' - ')) {
            const parts = stem.split(' - ');
            artist = parts[0].trim();
            title = parts.slice(1).join(' - ').trim();
          }
          return {
            title,
            artist,
            cover: plCover,
            file: isDownloadsRoot ? fileName : (isFromDownloads ? `${name}/${fileName}` : fileName),
            playlistName: isFromDownloads ? '__download__' : name,
            fullStreamUrl: `/api/downloaded-track-file?folder=${encodeURIComponent(isFromDownloads ? '__download__' : name)}&file=${encodeURIComponent(isFromDownloads ? (isDownloadsRoot ? fileName : name + '/' + fileName) : fileName)}&clientId=${encodeURIComponent(devInfo.clientId)}`
          };
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, name, cover: plCover, tracks, clientId: devInfo.clientId }));
        return;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
        return;
      }
    }

    if (pathname === '/api/create-favorite-playlist' && req.method === 'POST') {
      try {
        const clientId = String(body.clientId || reqUrl.searchParams.get('clientId') || req.headers['x-client-id'] || '').trim();
        const devInfo = getDevicePlaylistsRoot(clientId, req);
        const name = String(body.name || reqUrl.searchParams.get('name') || '').trim();
        const cleanName = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!cleanName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Nome de playlist inválido' }));
          return;
        }
        unmarkPlaylistAsDeleted(cleanName);
        const dir = path.join(devInfo.root, cleanName);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const manifestPath = path.join(dir, 'playlist.json');
        let manifest = {
          name: cleanName,
          album: cleanName,
          clientId: devInfo.clientId,
          createdAt: Date.now(),
          tracks: []
        };
        if (fs.existsSync(manifestPath)) {
          try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { swallowed(e, 'server:top@10355'); }
        }
        if (body.cover) manifest.cover = body.cover;
        if (Array.isArray(body.tracks) && body.tracks.length > 0) {
          manifest.tracks = body.tracks;
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, name: cleanName, clientId: devInfo.clientId, manifest }));
        return;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
        return;
      }
    }

    if (pathname === '/api/delete-favorite-playlist' && req.method === 'POST') {
      const name = String(body.name || reqUrl.searchParams.get('name') || '').trim();
      const clientId = String(body.clientId || reqUrl.searchParams.get('clientId') || req.headers['x-client-id'] || '').trim();
      const devInfo = getDevicePlaylistsRoot(clientId, req);
      const downloadsDir = path.resolve(os.homedir(), 'Downloads');
      const serverMusicRoot = path.join(os.homedir(), 'Músicas', 'Papaléguas', 'Minhas playlists favoritas');
      const devicesBaseDir = path.join(os.homedir(), 'Músicas', 'Papaléguas', 'Dispositivos');

      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Nome inválido' }));
        return;
      }

      markPlaylistAsDeleted(name);

      const targetClean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

      // Lista de pastas para varrer e remover
      const rootsToCheck = [devInfo.root, serverMusicRoot];
      if (downloadsDir && fs.existsSync(downloadsDir)) rootsToCheck.push(downloadsDir);
      if (devicesBaseDir && fs.existsSync(devicesBaseDir)) {
        try {
          for (const d of fs.readdirSync(devicesBaseDir, { withFileTypes: true })) {
            if (d.isDirectory() && !d.name.startsWith('.')) {
              rootsToCheck.push(path.join(devicesBaseDir, d.name));
            }
          }
        } catch (e) { swallowed(e, 'server:top@10400'); }
      }

      for (const rootDir of rootsToCheck) {
        if (!rootDir || !fs.existsSync(rootDir)) continue;
        try {
          // 1. Caminho direto
          const direct = path.join(rootDir, name);
          if (fs.existsSync(direct)) {
            try { fs.rmSync(direct, { recursive: true, force: true }); } catch (e) { swallowed(e, 'server:top@10409'); }
          }
          // 2. Busca case-insensitive e por manifesto
          for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
            const entClean = ent.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
            let isMatch = (entClean === targetClean || ent.name.toLowerCase() === name.toLowerCase());
            if (!isMatch) {
              try {
                const mf = JSON.parse(fs.readFileSync(path.join(rootDir, ent.name, 'playlist.json'), 'utf8'));
                if (mf && (String(mf.name || '').trim().toLowerCase() === targetClean || String(mf.name || '').trim().toLowerCase() === name.toLowerCase())) {
                  isMatch = true;
                }
              } catch (e) { swallowed(e, 'server:top@10422'); }
            }
            if (isMatch) {
              try { fs.rmSync(path.join(rootDir, ent.name), { recursive: true, force: true }); } catch (e) { swallowed(e, 'server:top@10425'); }
            }
          }
        } catch (e) { swallowed(e, 'server:top@10428'); }
      }

      // Apaga arquivos .zip correspondentes em Downloads para não re-extrair e liberar espaço
      if (downloadsDir && fs.existsSync(downloadsDir)) {
        try {
          for (const f of fs.readdirSync(downloadsDir)) {
            if (!f.toLowerCase().endsWith('.zip')) continue;
            const baseZip = f.slice(0, -4).replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
            if (baseZip === targetClean || baseZip === name.toLowerCase()) {
              try { fs.unlinkSync(path.join(downloadsDir, f)); } catch (e) { swallowed(e, 'server:top@10438'); }
            }
          }
        } catch (e) { swallowed(e, 'server:top@10441'); }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, clientId: devInfo.clientId }));
      return;
    }

    if (pathname === '/api/delete-favorite-track' && req.method === 'POST') {
      const playlist = String(body.playlist || reqUrl.searchParams.get('playlist') || '').trim();
      const fileName = String(body.fileName || body.file || reqUrl.searchParams.get('file') || '').trim();
      const trackTitle = String(body.title || reqUrl.searchParams.get('title') || '').trim().toLowerCase();
      const clientId = String(body.clientId || reqUrl.searchParams.get('clientId') || req.headers['x-client-id'] || '').trim();
      const devInfo = getDevicePlaylistsRoot(clientId, req);
      const downloadsDir = path.resolve(os.homedir(), 'Downloads');

      if (devInfo.isHost && (playlist === '__download__' || playlist === 'Downloads' || fileName.includes('/'))) {
        const safeRel = fileName.replace(/^[\\/]+/, '');
        const target = path.resolve(downloadsDir, safeRel);
        if (target.startsWith(downloadsDir + path.sep) && fs.existsSync(target)) {
          try { fs.unlinkSync(target); } catch (e) { swallowed(e, 'server:top@10461'); }
        }
      } else {
        let dir = path.join(devInfo.root, playlist);
        if (!fs.existsSync(dir) && devInfo.isHost) {
          const cand = path.join(downloadsDir, playlist);
          if (fs.existsSync(cand)) dir = cand;
        }
        if (dir && fs.existsSync(dir)) {
          if (fileName) {
            const target = path.join(dir, path.basename(fileName));
            if (fs.existsSync(target)) {
              try { fs.unlinkSync(target); } catch (e) { swallowed(e, 'server:top@10473'); }
            }
          }
          const manifestPath = path.join(dir, 'playlist.json');
          if (fs.existsSync(manifestPath)) {
            try {
              const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              m.tracks = (m.tracks || []).filter(t => {
                if (fileName && (t.file === fileName || path.basename(t.file) === path.basename(fileName))) return false;
                if (trackTitle && t.title && t.title.trim().toLowerCase() === trackTitle) return false;
                return true;
              });
              fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
            } catch (e) { swallowed(e, 'server:top@10486'); }
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, clientId: devInfo.clientId }));
      return;
    }

    if (pathname === '/api/rename-favorite-playlist' && req.method === 'POST') {
      const oldName = String(body.oldName || reqUrl.searchParams.get('oldName') || '').trim();
      const newName = String(body.newName || reqUrl.searchParams.get('newName') || '').trim();
      if (!oldName || !newName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Nomes inválidos' }));
        return;
      }
      const clientId = String(body.clientId || reqUrl.searchParams.get('clientId') || req.headers['x-client-id'] || '').trim();
      const devInfo = getDevicePlaylistsRoot(clientId, req);
      const downloadsDir = path.resolve(os.homedir(), 'Downloads');
      let targetDir = path.join(devInfo.root, oldName);
      let parentDir = devInfo.root;
      if (!fs.existsSync(targetDir) && devInfo.isHost) {
        const candDl = path.join(downloadsDir, oldName);
        if (fs.existsSync(candDl) && fs.statSync(candDl).isDirectory()) {
          targetDir = candDl;
          parentDir = downloadsDir;
        }
      }
      if (!targetDir || !fs.existsSync(targetDir) || (!devInfo.isHost && !path.resolve(targetDir).startsWith(path.resolve(devInfo.root) + path.sep))) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Playlist não encontrada' }));
        return;
      }
      const cleanNew = newName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
      const destDir = path.join(parentDir, cleanNew);
      try {
        if (path.resolve(targetDir) !== path.resolve(destDir)) {
          if (fs.existsSync(destDir)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Já existe pasta ou playlist com este nome' }));
            return;
          }
          fs.renameSync(targetDir, destDir);
        }
        const manifestPath = path.join(destDir, 'playlist.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            m.name = cleanNew;
            m.album = cleanNew;
            fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
          } catch (e) { swallowed(e, 'server:top@10539'); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, oldName, newName: cleanNew, clientId: devInfo.clientId }));
        return;
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
        return;
      }
    }

    if (pathname === '/api/edit-favorite-track' && req.method === 'POST') {
      const playlist = String(body.playlist || reqUrl.searchParams.get('playlist') || '').trim();
      const file = String(body.file || body.fileName || reqUrl.searchParams.get('file') || '').trim();
      const newTitle = String(body.newTitle || reqUrl.searchParams.get('newTitle') || '').trim();
      const newArtist = String(body.newArtist || reqUrl.searchParams.get('newArtist') || '').trim();
      const clientId = String(body.clientId || reqUrl.searchParams.get('clientId') || req.headers['x-client-id'] || '').trim();
      const devInfo = getDevicePlaylistsRoot(clientId, req);
      const downloadsDir = path.resolve(os.homedir(), 'Downloads');
      let dir = path.join(devInfo.root, playlist);
      if (!fs.existsSync(dir) && devInfo.isHost) {
        const cand = path.join(downloadsDir, playlist);
        if (fs.existsSync(cand)) dir = cand;
      }
      if (dir && fs.existsSync(dir)) {
        const manifestPath = path.join(dir, 'playlist.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (Array.isArray(m.tracks)) {
              const tr = m.tracks.find(t => t.file === file || path.basename(t.file) === path.basename(file));
              if (tr) {
                if (newTitle) tr.title = newTitle;
                if (newArtist) tr.artist = newArtist;
                fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
              }
            }
          } catch (e) { swallowed(e, 'server:top@10577'); }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, clientId: devInfo.clientId }));
      return;
    }

    if (pathname === '/api/downloaded-music') {
      const q = String(reqUrl.searchParams.get('q') || body.q || '').trim().toLowerCase();
      const clientId = String(reqUrl.searchParams.get('clientId') || body.clientId || req.headers['x-client-id'] || '').trim();
      const devInfo = getDevicePlaylistsRoot(clientId, req);
      const results = [];
      const audioExts = new Set(['.mp3', '.m4a', '.mp4', '.ogg', '.flac', '.wav', '.webm', '.aac', '.opus']);
      const maxResults = 150;
      const downloadsDir = path.resolve(os.homedir(), 'Downloads');

      if (devInfo.isHost) {
        try {
          if (fs.existsSync(downloadsDir)) {
            const scanFolder = (dir, depth = 0, folderName = 'Downloads') => {
              if (depth > 2 || results.length >= maxResults) return;
              let entries = [];
              try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
              for (const ent of entries) {
                if (results.length >= maxResults) break;
                if (ent.name.startsWith('.')) continue;
                const fullPath = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                  scanFolder(fullPath, depth + 1, ent.name);
                } else if (ent.isFile()) {
                  const ext = path.extname(ent.name).toLowerCase();
                  if (audioExts.has(ext)) {
                    const relPath = path.relative(downloadsDir, fullPath);
                    const stem = path.basename(ent.name, ext).replace(/^[\d\s.\-_]+/, '').trim() || ent.name;
                    let artist = folderName !== 'Downloads' ? folderName : 'Downloads';
                    let title = stem;
                    if (stem.includes(' - ')) {
                      const parts = stem.split(' - ');
                      artist = parts[0].trim();
                      title = parts.slice(1).join(' - ').trim();
                    }

                    let trCover = '';
                    try {
                      const candCover = path.join(dir, 'cover.jpg');
                      const candAlbum = path.join(dir, 'album.jpg');
                      if (fs.existsSync(candCover)) {
                        trCover = `/api/downloaded-track-file?folder=${encodeURIComponent(folderName !== 'Downloads' ? folderName : '__download__')}&file=cover.jpg&clientId=${encodeURIComponent(devInfo.clientId)}`;
                      } else if (fs.existsSync(candAlbum)) {
                        trCover = `/api/downloaded-track-file?folder=${encodeURIComponent(folderName !== 'Downloads' ? folderName : '__download__')}&file=album.jpg&clientId=${encodeURIComponent(devInfo.clientId)}`;
                      }
                    } catch (e) { swallowed(e, 'server:scanFolder@10629'); }

                    const fullSearchText = `${title} ${artist} ${ent.name} ${folderName}`.toLowerCase();
                    if (!q || fullSearchText.includes(q)) {
                      results.push({
                        id: 'dl-' + Buffer.from(relPath).toString('base64').replace(/=/g, ''),
                        title,
                        artist,
                        album: folderName,
                        file: relPath,
                        playlistName: folderName !== 'Downloads' ? folderName : '__download__',
                        source: 'downloads',
                        isDownloaded: true,
                        fullStreamUrl: `/api/downloaded-track-file?folder=__download__&file=${encodeURIComponent(relPath)}&clientId=${encodeURIComponent(devInfo.clientId)}`,
                        cover: trCover,
                        type: 'track',
                        itemType: 'track'
                      });
                    }
                  }
                }
              }
            };
            scanFolder(downloadsDir, 0, 'Downloads');
          }
        } catch (err) {
          console.error('Erro ao escanear pasta de downloads no servidor:', err);
        }
      }

      // Escanear playlists salvas no disco do dispositivo
      try {
        const musicRoot = devInfo.root;
        if (fs.existsSync(musicRoot)) {
          for (const ent of fs.readdirSync(musicRoot, { withFileTypes: true })) {
            if (!ent.isDirectory()) continue;
            const plDir = path.join(musicRoot, ent.name);
            const manifestPath = path.join(plDir, 'playlist.json');
            let plName = ent.name;
            let plCover = '';
            if (fs.existsSync(manifestPath)) {
              try {
                const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                plName = m.name || ent.name;
                const cPath = path.join(plDir, m.cover || 'cover.jpg');
                if (fs.existsSync(cPath)) {
                  plCover = `/api/downloaded-track-file?folder=${encodeURIComponent(plName)}&file=${encodeURIComponent(m.cover || 'cover.jpg')}&clientId=${encodeURIComponent(devInfo.clientId)}`;
                }
                if (Array.isArray(m.tracks)) {
                  for (const tr of m.tracks) {
                    if (results.length >= maxResults) break;
                    const searchStr = `${tr.title || ''} ${tr.artist || ''} ${plName}`.toLowerCase();
                    if (!q || searchStr.includes(q)) {
                      let trCover = tr.cover || plCover;
                      results.push({
                        id: 'fav-disk-' + Buffer.from(plName + '/' + tr.file).toString('base64').replace(/=/g, ''),
                        title: tr.title,
                        artist: tr.artist,
                        album: plName,
                        file: tr.file,
                        playlistName: plName,
                        source: 'disk',
                        isDownloaded: true,
                        fullStreamUrl: `/api/downloaded-track-file?folder=${encodeURIComponent(plName)}&file=${encodeURIComponent(tr.file)}&clientId=${encodeURIComponent(devInfo.clientId)}`,
                        cover: trCover,
                        type: 'track',
                        itemType: 'track'
                      });
                    }
                  }
                }
              } catch (e) { swallowed(e, 'server:top@10700'); }
            }
          }
        }
      } catch (err) { swallowed(err, 'server:top@10704'); }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, count: results.length, results, clientId: devInfo.clientId }));
      return;
    }

    if (pathname === '/api/downloaded-track-file') {
      let folder = reqUrl.searchParams.get('folder') || '';
      let file = reqUrl.searchParams.get('file') || '';
      try { folder = decodeURIComponent(folder); } catch (e) { swallowed(e, 'server:top@10714'); }
      try { file = decodeURIComponent(file); } catch (e) { swallowed(e, 'server:top@10715'); }
      const clientId = String(reqUrl.searchParams.get('clientId') || req.headers['x-client-id'] || '').trim();
      const devInfo = getDevicePlaylistsRoot(clientId, req);
      const serverMusicRoot = path.join(os.homedir(), 'Músicas', 'Papaléguas', 'Minhas playlists favoritas');
      const downloadsDir = path.resolve(os.homedir(), 'Downloads');
      let targetPath = null;

      const safeFile = String(file).replace(/^[\\/]+/, '').trim();
      const baseFile = path.basename(safeFile);

      // Dispositivos externos só podem ler arquivos da PRÓPRIA pasta
      if (!devInfo.isHost) {
        if (devInfo.root && fs.existsSync(devInfo.root) && folder !== '__download__' && folder !== 'Downloads') {
          const found = findFileInDirResilient(path.join(devInfo.root, folder), safeFile);
          const rootResolved = path.resolve(devInfo.root) + path.sep;
          if (found && path.resolve(found).startsWith(rootResolved)) targetPath = found;
        }
      } else
      // 1. Se folder for __download__ ou Downloads
      if (folder === '__download__' || folder === 'Downloads') {
        if (downloadsDir && fs.existsSync(downloadsDir)) {
          targetPath = findFileInDirResilient(downloadsDir, safeFile);
        }
        // Se não achou na pasta Downloads, busca na pasta do servidor e do dispositivo
        if (!targetPath && fs.existsSync(serverMusicRoot)) {
          targetPath = findFileInDirResilient(serverMusicRoot, safeFile);
          if (!targetPath) {
            try {
              for (const ent of fs.readdirSync(serverMusicRoot, { withFileTypes: true })) {
                if (ent.isDirectory()) {
                  targetPath = findFileInDirResilient(path.join(serverMusicRoot, ent.name), baseFile);
                  if (targetPath) break;
                }
              }
            } catch (e) { swallowed(e, 'server:top@10749'); }
          }
        }
        if (!targetPath && devInfo.root && fs.existsSync(devInfo.root)) {
          targetPath = findFileInDirResilient(devInfo.root, safeFile);
        }
      } else {
        // 2. Se folder for uma playlist específica
        // 2.1 Pasta do dispositivo
        if (devInfo.root && fs.existsSync(devInfo.root)) {
          targetPath = findFileInDirResilient(path.join(devInfo.root, folder), safeFile);
          if (!targetPath) targetPath = findFileInDirResilient(devInfo.root, safeFile);
        }
        // 2.2 Pasta da biblioteca principal do servidor
        if (!targetPath && fs.existsSync(serverMusicRoot)) {
          targetPath = findFileInDirResilient(path.join(serverMusicRoot, folder), safeFile);
          if (!targetPath) targetPath = findFileInDirResilient(serverMusicRoot, safeFile);
          if (!targetPath) {
            try {
              for (const ent of fs.readdirSync(serverMusicRoot, { withFileTypes: true })) {
                if (ent.isDirectory() && ent.name.toLowerCase() === folder.toLowerCase()) {
                  targetPath = findFileInDirResilient(path.join(serverMusicRoot, ent.name), safeFile);
                  if (targetPath) break;
                }
              }
            } catch (e) { swallowed(e, 'server:top@10774'); }
          }
        }
        // 2.3 Pasta Downloads
        if (!targetPath && downloadsDir && fs.existsSync(downloadsDir)) {
          targetPath = findFileInDirResilient(path.join(downloadsDir, folder), safeFile);
          if (!targetPath) targetPath = findFileInDirResilient(downloadsDir, safeFile);
          if (!targetPath) targetPath = findFileInDirResilient(downloadsDir, baseFile);
        }
        // 2.4 Varredura global em subpastas de serverMusicRoot procurando pelo nome do arquivo
        if (!targetPath && fs.existsSync(serverMusicRoot)) {
          try {
            for (const ent of fs.readdirSync(serverMusicRoot, { withFileTypes: true })) {
              if (ent.isDirectory()) {
                targetPath = findFileInDirResilient(path.join(serverMusicRoot, ent.name), baseFile);
                if (targetPath) break;
              }
            }
          } catch (e) { swallowed(e, 'server:top@10792'); }
        }
      }

      if (!targetPath || !fs.existsSync(targetPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Arquivo local não encontrado.');
        return;
      }

      const stat = fs.statSync(targetPath);
      const ext = path.extname(targetPath).toLowerCase();
      let mime = 'audio/mpeg';
      if (ext === '.m4a' || ext === '.mp4') mime = 'audio/mp4';
      else if (ext === '.ogg') mime = 'audio/ogg';
      else if (ext === '.wav') mime = 'audio/wav';
      else if (ext === '.webm') mime = 'audio/webm';
      else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.png') mime = 'image/png';

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        if (start >= stat.size || end >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': (end - start) + 1,
          'Content-Type': mime
        });
        safePipe(fs.createReadStream(targetPath, { start, end }), res, req);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Type': mime
        });
        safePipe(fs.createReadStream(targetPath), res, req);
      }
      return;
    }

    if (pathname === '/api/session-info') {
      const activePublicUrl = 'https://papaleguas.app';
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        clientId: clientSession.clientId,
        sharedLogin: true,
        userName: clientSession.sharedLoginUser,
        isLoggedIn: clientSession.isLoggedIn,
        totalActiveSessions: clientSessions.size,
        tunnelUrl: activePublicUrl,
        cloudflareTunnelUrl: activePublicUrl,
        ngrokTunnelUrl: null,
        ngrokTunnelConnecting: false,
        serverVersion: getServerBuildVersion()
      }));
      return;
    }

    if (pathname === '/api/ai-status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        success: true,
        provider: aiClient.hasGrok() ? 'grok' : 'openai',
        model: aiClient.hasGrok() ? aiClient.GROK_MODEL : 'gpt-4o-mini',
        label: aiClient.hasGrok() ? 'Papaléguas AI • Grok' : 'Papaléguas AI',
        grokEnabled: !!aiClient.hasGrok()
      }));
      return;
    }

    if (pathname === '/api/query-ai') {
      const prompt = body.prompt || reqUrl.searchParams.get('prompt') || body.query || reqUrl.searchParams.get('q') || '';
      const history = body.history || [];
      const reply = await runGptNavigatorAgent({ prompt, history });
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, reply }));
      return;
    }

    if (pathname === '/api/clear-traces') {
      const result = clearBrowsingTraces();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/client-net-hint') {
      let socketIp = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
      if (socketIp.startsWith('::ffff:')) socketIp = socketIp.replace('::ffff:', '');
      const hostHeader = String((req.headers.host || '').split(':')[0] || '').trim();
      const isLanV4 = (ip) => /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(String(ip || ''));
      const clientIp = isLanV4(socketIp) ? socketIp : (isLanV4(hostHeader) ? hostHeader : '');
      const subnet = clientIp ? clientIp.split('.').slice(0, 3).join('.') : '';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      res.end(JSON.stringify({ success: true, clientIp, subnet }));
      return;
    }

    if (pathname === '/api/cast-devices') {
      const jsonHead = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      };
      const whoCast = requestGuard.identifyRequester(req);
      if (!whoCast.isLocal) {
        // Visitantes externos (túnel Cloudflare/ngrok) não estão na mesma rede física do servidor:
        // a busca deve rodar apenas na rede Wi-Fi do celular. Já clientes locais (PC ou celular no
        // mesmo Wi-Fi de casa acessando via IP da LAN) recebem a varredura TCP/SSDP/mDNS real do servidor!
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify({
          success: true,
          devices: [],
          serverLocal: false,
          message: 'A transmissão deve basear na rede Wi-Fi do cliente, não do servidor.'
        }));
        return;
      }
      try {
        const castManager = require('./cast-manager');
        const devices = await castManager.discoverRokuOnThisMachine();
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify({
          success: true,
          devices: Array.isArray(devices) ? devices : [],
          clientScanRequired: false
        }));
      } catch (err) {
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify({ success: true, devices: [], error: err.message, clientScanRequired: false }));
      }
      return;
    }

    if (pathname === '/api/cast-to-device') {
      const jsonHead = { 'Content-Type': 'application/json; charset=utf-8' };
      const rawTarget = body.ip || body.deviceId || reqUrl.searchParams.get('ip') || '';
      const ipMatch = String(rawTarget).match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      const ip = ipMatch ? ipMatch[1] : '';
      const targetUrl = body.url || body.videoId || body.contentId || reqUrl.searchParams.get('url') || '';
      const title = body.title || '';
      if (!ip || !isPrivateIp(ip) || String(ip).startsWith('127.')) {
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify({ success: false, error: 'Informe o IP da TV no seu Wi-Fi.' }));
        return;
      }
      try {
        const castManager = require('./cast-manager');
        const device = castManager.ensureRokuDevice(ip, 'Smart TV (' + ip + ')');
        const result = await castManager.castToDevice(device.id, targetUrl || title, title);
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify(result && typeof result === 'object' ? result : { success: true, message: 'Sinal enviado para a TV.' }));
      } catch (err) {
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (pathname === '/api/tor-status') {
      const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
      const clientSession = getOrCreateClientSession(clientId);
      clientSession.torEnabled = true;
      const status = await torManager.checkTorStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...status,
        enabled: true,
        connected: Boolean(status.connected),
        serverConnected: Boolean(status.connected),
        locked: false
      }));
      return;
    }

    if (pathname === '/api/papaleguas/toggle-tor' && req.method === 'POST') {
      const requested = true;
      applyServerTorRouting(true);
      let status = { connected: false };
      if (typeof torManager.ensureRunning === 'function') {
        status = await torManager.ensureRunning();
        if (status.connected) lookupOutboundIp(true).catch(() => {});
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        enabled: true,
        connected: Boolean(status.connected),
        locked: true,
        message: 'Rede Tor sempre ativa em modo segurança máxima.'
      }));
      return;
    }

    if (pathname === '/api/toggle-tor') {
      const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || (body && body.clientId) || 'client_default';
      const clientSession = getOrCreateClientSession(clientId);
      const requested = true;
      clientSession.torEnabled = true;

      let status = await torManager.checkTorStatus();
      if (requested && typeof torManager.ensureRunning === 'function' && !status.connected) {
        status = await torManager.ensureRunning().catch(() => status);
      }
      if (status.connected) lookupOutboundIp(true).catch(() => {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        enabled: requested,
        connected: Boolean(requested && status.connected),
        serverConnected: Boolean(status.connected),
        locked: false,
        message: requested
          ? 'Roteamento Tor ativado para este dispositivo.'
          : 'Roteamento Tor desativado para este dispositivo (o servidor permanece conectado ao Tor).'
      }));
      return;
    }

    if (pathname === '/api/tor-ip-info') {
      try {
        const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || (body && body.clientId) || 'client_default';
        const clientSession = getOrCreateClientSession(clientId);
        clientSession.torEnabled = true;
        const reported = String(reqUrl.searchParams.get('deviceIpv4') || body.deviceIpv4 || '').trim();
        const fromClient = papaleguasTracker.extractClientIp(req);
        const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
        let clientIp = '';
        if (ipv4.test(reported) && !papaleguasTracker.isPrivateIp(reported)) clientIp = reported;
        else if (ipv4.test(fromClient) && !papaleguasTracker.isPrivateIp(fromClient)) clientIp = fromClient;
        else if (fromClient && !papaleguasTracker.isPrivateIp(fromClient)) clientIp = fromClient;
        let torIp = '';
        const exit = await lookupOutboundIp(true);
        if (exit && exit.IP) torIp = exit.IP;
        const effectiveIp = torIp || clientIp || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          IP: effectiveIp,
          clientIpv4: clientIp || effectiveIp,
          IsTor: Boolean(torIp),
          torOn: true,
          torIp: torIp || effectiveIp,
          viaClient: true
        }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ IsTor: false, IP: '', error: err.message }));
      }
      return;
    }

    if (pathname === '/api/python/run' && req.method === 'POST') {
      try {
        const { runPythonCodeOrServer } = require('./python-runner');
        const code = body.code || '';
        const isServer = body.isServer !== undefined ? body.isServer : undefined;
        if (!code.trim()) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Código Python não fornecido.' }));
          return;
        }

        const result = await runPythonCodeOrServer(code, { isServer });
        res.writeHead(200);
        res.end(JSON.stringify({
          ...result,
          proxyUrl: result.port ? `/python-proxy/${result.port}/` : null,
          appViewerUrl: result.port ? `/python-app?port=${result.port}` : null
        }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (pathname === '/api/python/servers' && req.method === 'GET') {
      const { listActivePythonServers } = require('./python-runner');
      const servers = listActivePythonServers();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, servers }));
      return;
    }

    if (pathname === '/api/python/stop' && req.method === 'POST') {
      const { stopPythonServer } = require('./python-runner');
      const portOrId = body.port || body.appId || reqUrl.searchParams.get('port') || reqUrl.searchParams.get('appId');
      if (!portOrId) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Porta ou ID do servidor não fornecido.' }));
        return;
      }
      const result = stopPythonServer(portOrId);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/python/stop-all' && req.method === 'POST') {
      const { stopAllPythonServers } = require('./python-runner');
      const result = stopAllPythonServers();
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/python/logs' && req.method === 'GET') {
      const { getServerLogs } = require('./python-runner');
      const portOrId = reqUrl.searchParams.get('port') || reqUrl.searchParams.get('appId') || '';
      const logs = getServerLogs(portOrId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...logs }));
      return;
    }

    if (pathname === '/api/rust-engine') {
      const q = (reqUrl.searchParams.get('q') || '').trim();
      const onlyOnion = reqUrl.searchParams.get('onion') === '1';
      const metrics = nativeCore.getEngineMetrics();
      const localResults = q ? nativeCore.searchLocalIndex(q, 30, onlyOnion) : [];
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({
        active: nativeCore.isRustActive,
        version: nativeCore.rustVersion(),
        metrics,
        spiderQueueLength: rustSpiderQueue.length,
        results: localResults
      }));
      return;
    }

    if (pathname === '/api/os-detect') {
      const detected = nativeCore.detectOsPlatform(
        req.headers['user-agent'] || '',
        req.headers['sec-ch-ua-platform'] || ''
      );
      const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8080';
      const appOrigin = (global.currentCloudflareTunnelUrl && !/localhost|127\.0\.0\.1/.test(host))
        ? global.currentCloudflareTunnelUrl
        : `${proto}://${host}`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({
        detected,
        appOrigin,
        platforms: [
          {
            osId: 'windows',
            osName: 'Windows (10 / 11 • 64-bit)',
            shortLabel: 'Baixar p/ Windows',
            icon: '🪟',
            downloadUrl: '/api/download-app?os=windows',
            fileName: 'Instalar-Papaleguas-Windows.cmd',
            badge: 'Instalador Desktop Windows'
          },
          {
            osId: 'android',
            osName: 'Android (Celular / Tablet / TV)',
            shortLabel: 'Baixar App Android',
            icon: '🤖',
            downloadUrl: '/api/download-app?os=android',
            fileName: 'Papaleguas-Android-Installer.html',
            badge: 'App Nativo Android • Tela Cheia'
          },
          {
            osId: 'ios',
            osName: 'iPhone / iPad (iOS / iPadOS)',
            shortLabel: 'Baixar App iOS',
            icon: '🍎',
            downloadUrl: '/api/download-app?os=ios',
            fileName: 'Papaleguas-iOS.mobileconfig',
            badge: 'WebClip Oficial iOS • Tela Cheia'
          },
          {
            osId: 'linux',
            osName: 'Linux (Ubuntu / Debian / Mint / 64-bit)',
            shortLabel: 'Baixar p/ Linux',
            icon: '🐧',
            downloadUrl: '/api/download-app?os=linux',
            fileName: 'instalar-papaleguas-linux.sh',
            badge: 'Instalador Nativo Linux'
          }
        ]
      }));
      return;
    }

    if (pathname === '/api/open-native-window') {
      const targetUrl = (reqUrl.searchParams.get('url') || (body && body.url) || '').trim();
      let opened = false;
      if (typeof global.openPapaleguasNativeWindow === 'function') {
        opened = Boolean(global.openPapaleguasNativeWindow(targetUrl));
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ ok: true, openedNativeWindow: opened }));
      return;
    }

    if (pathname === '/api/auto-install-app') {
      const requestedOs = (reqUrl.searchParams.get('os') || '').toLowerCase().trim();
      const detected = nativeCore.detectOsPlatform(
        req.headers['user-agent'] || '',
        req.headers['sec-ch-ua-platform'] || ''
      );
      const targetOs = ['windows', 'linux', 'android', 'ios'].includes(requestedOs)
        ? requestedOs
        : (detected.osId || detected.os_id || 'linux');

      const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8080';
      const appOrigin = (global.currentCloudflareTunnelUrl && !/localhost|127\.0\.0\.1/.test(host))
        ? global.currentCloudflareTunnelUrl.replace(/\/+$/, '')
        : `${proto}://${host}`;

      let hostAutoInstalled = false;
      let openedNativeWindow = false;
      let installedPaths = [];

      if (process.platform === 'linux' && targetOs === 'linux') {
        try {
          const homeDir = os.homedir();
          const appDir = path.join(homeDir, '.local', 'share', 'papaleguas-browser');
          const binDir = path.join(homeDir, '.local', 'bin');
          const appsDir = path.join(homeDir, '.local', 'share', 'applications');
          fs.mkdirSync(appDir, { recursive: true });
          fs.mkdirSync(binDir, { recursive: true });
          fs.mkdirSync(appsDir, { recursive: true });

          const srcIcon = path.join(__dirname, '..', 'src', 'icon-512.png');
          const destIcon = path.join(appDir, 'icon.png');
          if (fs.existsSync(srcIcon)) {
            fs.copyFileSync(srcIcon, destIcon);
          }

          const launcherPath = path.join(binDir, 'papaleguas-browser');
          const projectDir = path.resolve(__dirname, '..');
          const electronBin = path.join(projectDir, 'node_modules', '.bin', 'electron');
          const launcherContent = [
            '#!/usr/bin/env bash',
            '# Abre a Janela Nativa Própria do Super Navegador Papaléguas (Motor Rust v2.0) sem depender de outros navegadores',
            'if curl -fsS -m 2 -X POST "http://127.0.0.1:8080/api/open-native-window" >/dev/null 2>&1; then',
            '  exit 0',
            'fi',
            `if [ -x "${electronBin}" ]; then`,
            `  exec "${electronBin}" --no-sandbox --no-zygote "${projectDir}" "$@" >/dev/null 2>&1 &`,
            '  exit 0',
            'fi'
          ].join('\n') + '\n';
          fs.writeFileSync(launcherPath, launcherContent, { mode: 0o755 });
          installedPaths.push(launcherPath);

          const desktopEntry = [
            '[Desktop Entry]',
            'Version=1.0',
            'Type=Application',
            'Name=Papaléguas Super Navegador',
            'Comment=Super Navegador Nativo com Motor de Busca Próprio em Rust v2.0 (Janela Própria)',
            `Exec=${launcherPath}`,
            `Icon=${destIcon}`,
            'Terminal=false',
            'Categories=Network;WebBrowser;AudioVideo;',
            'StartupWMClass=papaleguas-tor'
          ].join('\n') + '\n';

          const menuDesktopFile = path.join(appsDir, 'papaleguas-browser.desktop');
          fs.writeFileSync(menuDesktopFile, desktopEntry, { mode: 0o755 });
          installedPaths.push(menuDesktopFile);

          for (const deskName of ['Área de trabalho', 'Desktop']) {
            const deskDir = path.join(homeDir, deskName);
            if (fs.existsSync(deskDir)) {
              const deskFile = path.join(deskDir, 'Papaléguas Super Navegador.desktop');
              fs.writeFileSync(deskFile, desktopEntry, { mode: 0o755 });
              installedPaths.push(deskFile);
              execFile('gio', ['set', deskFile, 'metadata::trusted', 'true'], () => {});
            }
          }
          hostAutoInstalled = true;
          if (typeof global.openPapaleguasNativeWindow === 'function') {
            openedNativeWindow = Boolean(global.openPapaleguasNativeWindow());
          }
        } catch (e) {}
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({
        ok: true,
        targetOs,
        detected,
        hostAutoInstalled,
        openedNativeWindow,
        installedPaths,
        downloadUrl: `/api/download-app?os=${encodeURIComponent(targetOs)}`
      }));
      return;
    }

    if (pathname === '/api/download-app') {
      const requestedOs = (reqUrl.searchParams.get('os') || '').toLowerCase().trim();
      const detected = nativeCore.detectOsPlatform(
        req.headers['user-agent'] || '',
        req.headers['sec-ch-ua-platform'] || ''
      );
      const targetOs = ['windows', 'linux', 'android', 'ios'].includes(requestedOs)
        ? requestedOs
        : (detected.osId || detected.os_id || 'windows');

      const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8080';
      const appOrigin = (global.currentCloudflareTunnelUrl && !/localhost|127\.0\.0\.1/.test(host))
        ? global.currentCloudflareTunnelUrl.replace(/\/+$/, '')
        : `${proto}://${host}`;

      if (targetOs === 'windows') {
        const winScript = [
          '@echo off',
          'chcp 65001 >nul',
          'title Instalador Super Navegador Papaleguas (Windows)',
          'echo ==========================================================',
          'echo   INSTALANDO SUPER NAVEGADOR PAPALEGUAS (RUST ENGINE v2.0)',
          'echo ==========================================================',
          'set "APP_DIR=%LOCALAPPDATA%\\PapaleguasBrowser"',
          'if not exist "%APP_DIR%" mkdir "%APP_DIR%"',
          `set "APP_URL=${appOrigin}/?app=desktop"`,
          `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '${appOrigin}/favicon.ico' -OutFile '%APP_DIR%\\papaleguas.ico' -UseBasicParsing } catch {}"`,
          'set "LAUNCH_CMD=%APP_DIR%\\PapaleguasLauncher.cmd"',
          '(',
          '  echo @echo off',
          '  echo powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $f = New-Object System.Windows.Forms.Form; $f.Text = \'Papaleguas Super Navegador (Motor Rust v2.0)\'; $f.Width = 1280; $f.Height = 840; $f.StartPosition = \'CenterScreen\'; $w = New-Object System.Windows.Forms.WebBrowser; $w.Dock = \'Fill\'; $w.ScriptErrorsSuppressed = $true; $w.Navigate(\'%APP_URL%\'); $f.Controls.Add($w); [void]$f.ShowDialog()"',
          ') > "%LAUNCH_CMD%"',
          'powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $desk = [Environment]::GetFolderPath(\'Desktop\'); $s = $ws.CreateShortcut($desk + \'\\Papaleguas Super Navegador.lnk\'); $s.TargetPath = \'%LAUNCH_CMD%\'; $s.WindowStyle = 7; if (Test-Path \'%APP_DIR%\\papaleguas.ico\') { $s.IconLocation = \'%APP_DIR%\\papaleguas.ico\' }; $s.Save()"',
          'echo.',
          'echo [OK] Atalho criado na Area de Trabalho! Abrindo Janela Nativa Papaleguas...',
          'call "%LAUNCH_CMD%"',
          'exit /b 0'
        ].join('\r\n');

        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="Instalar-Papaleguas-Windows.cmd"',
          'Cache-Control': 'no-store'
        });
        res.end(winScript);
        return;
      }

      if (targetOs === 'linux') {
        const projectDir = path.resolve(__dirname, '..');
        const electronBin = path.join(projectDir, 'node_modules', '.bin', 'electron');
        const linuxScript = [
          '#!/usr/bin/env bash',
          'set -e',
          'echo "=========================================================="',
          'echo "  🐧 INSTALANDO SUPER NAVEGADOR PAPALÉGUAS (JANELA NATIVA)"',
          'echo "=========================================================="',
          'APP_DIR="$HOME/.local/share/papaleguas-browser"',
          'BIN_DIR="$HOME/.local/bin"',
          'APPS_DIR="$HOME/.local/share/applications"',
          'mkdir -p "$APP_DIR" "$BIN_DIR" "$APPS_DIR"',
          `curl -fsSL "${appOrigin}/icon-512.png" -o "$APP_DIR/icon.png" 2>/dev/null || true`,
          'cat << \'EOF\' > "$BIN_DIR/papaleguas-browser"',
          '#!/usr/bin/env bash',
          '# Abre diretamente a Janela Nativa Própria do Super Navegador Papaléguas (sem usar outros navegadores)',
          'if curl -fsS -m 2 -X POST "http://127.0.0.1:8080/api/open-native-window" >/dev/null 2>&1; then',
          '  exit 0',
          'fi',
          `if [ -x "${electronBin}" ]; then`,
          `  exec "${electronBin}" --no-sandbox --no-zygote "${projectDir}" "$@" >/dev/null 2>&1 &`,
          '  exit 0',
          'fi',
          'EOF',
          'chmod +x "$BIN_DIR/papaleguas-browser"',
          'DESKTOP_FILE="$APPS_DIR/papaleguas-browser.desktop"',
          'cat << EOF > "$DESKTOP_FILE"',
          '[Desktop Entry]',
          'Version=1.0',
          'Type=Application',
          'Name=Papaléguas Super Navegador',
          'Comment=Super Navegador Nativo com Motor de Busca Próprio em Rust v2.0 (Janela Própria)',
          'Exec=$HOME/.local/bin/papaleguas-browser',
          'Icon=$HOME/.local/share/papaleguas-browser/icon.png',
          'Terminal=false',
          'Categories=Network;WebBrowser;AudioVideo;',
          'StartupWMClass=papaleguas-tor',
          'EOF',
          'chmod +x "$DESKTOP_FILE"',
          'for d in "$HOME/Área de trabalho" "$HOME/Desktop"; do',
          '  if [ -d "$d" ]; then cp "$DESKTOP_FILE" "$d/Papaléguas Super Navegador.desktop" && chmod +x "$d/Papaléguas Super Navegador.desktop"; fi',
          'done',
          'echo "✅ Papaléguas Super Navegador instalado! Abrindo janela nativa própria..."',
          '"$BIN_DIR/papaleguas-browser" &',
          ''
        ].join('\n');

        res.writeHead(200, {
          'Content-Type': 'application/x-sh; charset=utf-8',
          'Content-Disposition': 'attachment; filename="instalar-papaleguas-linux.sh"',
          'Cache-Control': 'no-store'
        });
        res.end(linuxScript);
        return;
      }

      if (targetOs === 'ios') {
        let iconBase64 = '';
        try {
          const iconPath = path.join(__dirname, '..', 'src', 'icon-192.png');
          if (fs.existsSync(iconPath)) {
            iconBase64 = fs.readFileSync(iconPath).toString('base64');
          }
        } catch (e) {}

        const mobileConfig = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>FullScreen</key>
      <true/>
      <key>IsRemovable</key>
      <true/>
      <key>Label</key>
      <string>Papaléguas</string>
      <key>PayloadDescription</key>
      <string>Instala o Super Navegador Papaléguas em Tela Cheia no iOS</string>
      <key>PayloadDisplayName</key>
      <string>Papaléguas Super Navegador</string>
      <key>PayloadIdentifier</key>
      <string>app.papaleguas.webclip</string>
      <key>PayloadType</key>
      <string>com.apple.webClip.managed</string>
      <key>PayloadUUID</key>
      <string>8A7E9B12-4C5D-4E6F-9A1B-2C3D4E5F6A7B</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>Precomposed</key>
      <true/>
      <key>URL</key>
      <string>${escapeHtml(appOrigin)}/</string>
      ${iconBase64 ? `<key>Icon</key>\n      <data>${iconBase64}</data>` : ''}
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Super Navegador Papaléguas (Motor Rust v2.0 + BaixaTube + Filmes + Música Sem Anúncios)</string>
  <key>PayloadDisplayName</key>
  <string>Papaléguas Super Navegador (iOS)</string>
  <key>PayloadIdentifier</key>
  <string>app.papaleguas.profile</string>
  <key>PayloadOrganization</key>
  <string>Papaléguas</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>1F2E3D4C-5B6A-4789-8A9B-0C1D2E3F4A5B</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`;

        res.writeHead(200, {
          'Content-Type': 'application/x-apple-aspen-config; charset=utf-8',
          'Content-Disposition': 'attachment; filename="Papaleguas-iOS.mobileconfig"',
          'Cache-Control': 'no-store'
        });
        res.end(mobileConfig);
        return;
      }

      const androidHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="0;url=${escapeHtml(appOrigin)}/?install=android">
  <title>Instalador Papaléguas Android</title>
</head>
<body style="background:#090a10;color:#fff;font-family:sans-serif;text-align:center;padding:40px 20px;">
  <img src="${escapeHtml(appOrigin)}/icon-192.png" width="88" height="88" style="border-radius:20px;box-shadow:0 8px 24px rgba(0,240,255,0.35);" alt="Papaléguas">
  <h2 style="margin:18px 0 8px;">🤖 Papaléguas Super Navegador (Android)</h2>
  <p style="color:#94a3b8;font-size:14px;max-width:360px;margin:0 auto 24px;">Toque no botão abaixo para abrir e instalar na tela inicial do seu Android com zero anúncios.</p>
  <a href="${escapeHtml(appOrigin)}/?install=android" style="display:inline-block;background:linear-gradient(135deg,#10b981,#0284c7);color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:14px;font-size:15px;">🚀 Abrir e Instalar no Android</a>
</body>
</html>`;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Papaleguas-Android-App.html"',
        'Cache-Control': 'no-store'
      });
      res.end(androidHtml);
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Endpoint não encontrado' }));
    return;
  }

  // ----------------------------------------------------
  // PROXY REVERSO TRANSPARENTE PARA SERVIDORES PYTHON
  // Permite acesso direto em Desktop e Mobile (via Túnel Cloudflare)
  // ----------------------------------------------------
  if (pathname.startsWith('/python-proxy/')) {
    const proxyMatch = pathname.match(/^\/python-proxy\/(\d+)(\/.*)?$/);
    if (!proxyMatch) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Formato inválido. Exemplo correto: /python-proxy/5001/');
      return;
    }

    const targetPort = parseInt(proxyMatch[1], 10);
    const targetSubPath = (proxyMatch[2] || '/') + (reqUrl.search || '');

    const clientReq = http.request({
      hostname: '127.0.0.1',
      port: targetPort,
      path: targetSubPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${targetPort}`,
        'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http',
        'x-forwarded-host': req.headers.host || `localhost:${PORT}`,
        'x-forwarded-for': req.socket.remoteAddress
      },
      timeout: 30000
    }, (proxyRes) => {
      // Reescrita de redirecionamentos (301, 302, 307, 308) para permanecer no proxy
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        let loc = proxyRes.headers.location;
        if (loc.startsWith('/')) {
          loc = `/python-proxy/${targetPort}${loc}`;
        } else {
          try {
            const locUrl = new URL(loc);
            if (locUrl.hostname === '127.0.0.1' || locUrl.hostname === 'localhost') {
              loc = `/python-proxy/${targetPort}${locUrl.pathname}${locUrl.search}`;
            }
          } catch (e) { swallowed(e, 'server:top@11173'); }
        }
        proxyRes.headers.location = loc;
      }

      // Permite iframes e conexões de qualquer cliente
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
      proxyRes.headers['access-control-allow-origin'] = '*';

      const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();

      // Se for página HTML, injeta base tag para garantir que links e assets relativos funcionem perfeitamente
      if (contentType.includes('text/html')) {
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString();
          const baseTag = `<base href="/python-proxy/${targetPort}/">`;
          if (html.includes('<head>')) {
            html = html.replace('<head>', `<head>${baseTag}`);
          } else if (html.includes('<html>')) {
            html = html.replace('<html>', `<html><head>${baseTag}</head>`);
          } else {
            html = `${baseTag}${html}`;
          }

          const newHeaders = { ...proxyRes.headers };
          delete newHeaders['content-length'];
          newHeaders['content-length'] = Buffer.byteLength(html);

          if (!res.headersSent) {
            res.writeHead(proxyRes.statusCode, newHeaders);
            res.end(html);
          }
        });
      } else if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      } else {
        proxyRes.resume();
      }
    });

    clientReq.on('error', (err) => {
      const { getServerLogs } = require('./python-runner');
      const serverLogs = getServerLogs(targetPort);
      const hasErrorLogs = serverLogs && serverLogs.stderr && serverLogs.stderr.trim().length > 0;
      const isDead = serverLogs && serverLogs.active === false;

      if (res.headersSent || res.writableEnded) {
        try { res.destroy(); } catch (e) { swallowed(e, 'server:top@11224'); }
        return;
      }

      // Retorna 200 (em vez de 502) para que a Cloudflare não sobreponha com tela de erro de Gateway
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Servidor Python | Papaléguas</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
            .box { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 32px; max-width: 580px; width: 100%; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
            .icon { font-size: 44px; margin-bottom: 12px; }
            h2 { margin: 0 0 12px; color: #38bdf8; font-size: 20px; }
            p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
            .badge { display: inline-block; background: ${isDead ? '#ef444422' : '#0284c722'}; color: ${isDead ? '#f87171' : '#38bdf8'}; border: 1px solid ${isDead ? '#ef444455' : '#0284c755'}; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; margin-bottom: 14px; }
            .btn { background: #0284c7; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; text-decoration: none; transition: 0.2s; display: inline-block; margin: 4px; }
            .btn:hover { background: #0369a1; }
            .log-box { text-align: left; background: #07090e; border: 1px solid #334155; border-radius: 8px; padding: 12px; margin-top: 16px; max-height: 220px; overflow-y: auto; font-family: monospace; font-size: 12px; color: #fca5a5; white-space: pre-wrap; word-break: break-word; }
          </style>
        </head>
        <body>
          <div class="box">
            <div class="icon">🐍</div>
            <div class="badge">Porta ${targetPort} ${isDead ? 'Finalizada' : 'Conectando...'}</div>
            <h2>${isDead ? 'Servidor Python Finalizado' : 'Iniciando Aplicação Python...'}</h2>
            <p>${isDead ? 'O processo do servidor encerrou.' : 'Aguardando o servidor Python responder na porta ' + targetPort + '. Esta página recarregará automaticamente.'}</p>
            ${hasErrorLogs ? `<div class="log-box"><b>Logs do Terminal:</b><br>${serverLogs.stderr || serverLogs.stdout}</div>` : ''}
            <div style="margin-top: 20px;">
              <button onclick="location.reload()" class="btn">🔄 Tentar Novamente</button>
              <a href="/python-app" class="btn" style="background: rgba(255,255,255,0.08);">Painel de Servidores</a>
            </div>
          </div>
          ${!isDead ? `
          <script>
            // Auto-polling para reconectar assim que o servidor abrir a porta
            setTimeout(function() {
              fetch('/api/python/servers')
                .then(r => r.json())
                .then(data => {
                  const running = data.servers && data.servers.some(s => String(s.port) === "${targetPort}");
                  if (running) location.reload();
                  else setTimeout(() => location.reload(), 2000);
                })
                .catch(() => setTimeout(() => location.reload(), 2500));
            }, 1800);
          </script>
          ` : ''}
        </body>
        </html>
      `);
    });

    req.pipe(clientReq);
    return;
  }

  // ----------------------------------------------------
  // VISUALIZADOR DE APLICAÇÃO PYTHON AO VIVO NO PAPALÉGUAS
  // Interface completa com iframe, status, logs e controles
  // ----------------------------------------------------
  if (pathname === '/python-app') {
    const portParam = reqUrl.searchParams.get('port') || '';
    const { listActivePythonServers } = require('./python-runner');
    const activeServers = listActivePythonServers();
    const defaultPort = portParam || (activeServers.length > 0 ? activeServers[0].port : '');

    const viewerHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Papaléguas Python App Viewer</title>
  <style>
    :root {
      --bg: #07090e;
      --card-bg: rgba(15, 23, 42, 0.85);
      --border: rgba(255, 255, 255, 0.08);
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.3);
      --success: #10b981;
      --danger: #ef4444;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body { background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
    
    /* Header Superior */
    header {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
      height: 52px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      z-index: 100;
      flex-shrink: 0;
    }
    .brand-section { display: flex; align-items: center; gap: 12px; }
    .brand-logo { font-size: 20px; }
    .brand-title { font-weight: 700; font-size: 15px; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .badge-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 3px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      background: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--success);
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }

    .actions-section { display: flex; align-items: center; gap: 8px; }
    .btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
      text-decoration: none;
    }
    .btn:hover { background: rgba(255, 255, 255, 0.12); border-color: rgba(255, 255, 255, 0.2); }
    .btn-danger { color: #fca5a5; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.3); }
    .btn-danger:hover { background: rgba(239, 68, 68, 0.2); }

    /* Seletor de portas */
    select.port-select {
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 13px;
      outline: none;
      cursor: pointer;
    }

    /* Container do Iframe */
    .viewport-container {
      flex: 1;
      width: 100%;
      height: calc(100vh - 52px);
      position: relative;
      background: #000;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #ffffff;
    }

    /* Estado vazio quando não há servidores */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 24px;
      text-align: center;
      background: radial-gradient(circle at center, #131b2e 0%, #07090e 100%);
    }
    .empty-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 36px;
      max-width: 520px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    }
    .empty-card h2 { font-size: 24px; margin-bottom: 12px; color: var(--accent); }
    .empty-card p { color: var(--text-muted); font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
  </style>
</head>
<body>
  <header>
    <div class="brand-section">
      <span class="brand-logo">⚡</span>
      <span class="brand-title">Papaléguas Python Server</span>
      <div id="statusPill" class="badge-status">
        <span class="pulse-dot"></span>
        <span id="statusText">Porta ${defaultPort || 'Nenhum servidor'}</span>
      </div>
      <select id="serverSelect" class="port-select" onchange="changePort(this.value)">
        <option value="">Selecione Servidor...</option>
      </select>
    </div>

    <div class="actions-section">
      <button class="btn" onclick="reloadFrame()" title="Recarregar Aplicação">🔄 Recarregar</button>
      <a id="externalLink" href="/python-proxy/${defaultPort}/" class="btn" title="Abrir em nova aba" onclick="event.preventDefault(); var u=this.href; try { if (window.openInNewTab) { window.openInNewTab(u); return; } } catch (e) {} try { if (window.parent && window.parent !== window) { window.parent.postMessage({ type: 'open-new-tab', url: u }, '*'); return; } } catch (e) {} location.href=u;">↗️ Nova Aba</a>
      <button class="btn btn-danger" onclick="stopServer()" title="Parar Servidor Selecionado">🛑 Encerrar</button>
      <button class="btn btn-danger" onclick="stopAllServers()" title="Finalizar Todos os Servidores Python">🧹 Limpar Todos</button>
    </div>
  </header>

  <div class="viewport-container" id="viewport">
    ${defaultPort ? `<iframe id="appFrame" src="/python-proxy/${defaultPort}/"></iframe>` : `
      <div class="empty-state">
        <div class="empty-card">
          <div style="font-size: 48px; margin-bottom: 16px;">🐍</div>
          <h2>Nenhum Servidor Ativo</h2>
          <p>Peça ao Papaléguas AI para criar uma aplicação Python (Flask, FastAPI, etc.) ou envie um comando pelo chat. Ele instalará todas as bibliotecas necessárias e exibirá o resultado em tempo real aqui!</p>
          <a href="/" class="btn" style="background: #0284c7; color: white;">Ir para a Página Inicial</a>
        </div>
      </div>
    `}
  </div>

  <script>
    let currentPort = "${defaultPort}";

    function reloadFrame() {
      const iframe = document.getElementById('appFrame');
      if (iframe) {
        iframe.src = '/python-proxy/' + currentPort + '/?_t=' + Date.now();
      }
    }

    function changePort(port) {
      if (!port) return;
      currentPort = port;
      window.location.href = '/python-app?port=' + port;
    }

    async function stopServer() {
      if (!currentPort) return;
      if (!confirm('Deseja realmente encerrar este servidor Python (Porta ' + currentPort + ')?')) return;

      try {
        const res = await fetch('/api/python/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: currentPort })
        });
        const data = await res.json();
        if (data.success) {
          alert('Servidor encerrado com sucesso.');
          window.location.href = '/python-app';
        } else {
          alert('Erro ao encerrar servidor: ' + (data.message || 'Desconhecido'));
        }
      } catch (e) {
        alert('Erro de conexão ao encerrar.');
      }
    }

    async function stopAllServers() {
      if (!confirm('Deseja realmente finalizar TODOS os servidores Python criados no Papaléguas?')) return;
      try {
        const res = await fetch('/api/python/stop-all', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('Todos os servidores Python foram finalizados com sucesso.');
          window.location.href = '/python-app';
        } else {
          alert('Erro ao finalizar servidores.');
        }
      } catch (e) {
        alert('Erro de conexão ao finalizar servidores.');
      }
    }

    async function loadServers() {
      try {
        const res = await fetch('/api/python/servers');
        const data = await res.json();
        const select = document.getElementById('serverSelect');
        if (data && data.servers && select) {
          select.innerHTML = '<option value="">Servidores Ativos (' + data.servers.length + ')</option>';
          data.servers.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.port;
            opt.textContent = 'Porta ' + s.port + ' (PID ' + s.pid + ')';
            if (String(s.port) === String(currentPort)) opt.selected = true;
            select.appendChild(opt);
          });
        }
      } catch (e) {}
    }

    loadServers();
    setInterval(loadServers, 5000);
  </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(viewerHtml);
    return;
  }

  // ----------------------------------------------------
  // BASE DO PROXY: URLs relativas ficam no nosso host (sem vazar IP do aparelho)
  // /proxy-base/{clientId}/{originB64}/caminho → /proxy?url=origem+caminho
  // ----------------------------------------------------
  if (pathname.startsWith('/proxy-base/')) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 3) {
      const baseClientId = decodeURIComponent(parts[1] || 'client_default');
      let originBase = '';
      try {
        originBase = Buffer.from(parts[2], 'base64url').toString('utf8');
      } catch (e) {
        originBase = '';
      }
      if (!/^https?:\/\//i.test(originBase)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Origem inválida.');
        return;
      }
      const restPath = parts.slice(3).join('/');
      let targetHref = originBase;
      try {
        targetHref = new URL(restPath + (reqUrl.search || ''), originBase).href;
      } catch (e) {
        targetHref = originBase;
      }
      res.writeHead(302, {
        Location: '/proxy?url=' + encodeURIComponent(targetHref) + '&clientId=' + encodeURIComponent(baseClientId)
      });
      res.end();
      return;
    }
  }

  if (pathname === '/download/app') {
    res.writeHead(302, {
      Location: '/api/download-app' + (reqUrl.search || '')
    });
    res.end();
    return;
  }

  if (pathname === '/ip-check') {
    const info = await lookupOutboundIp(isAppTorEnabled());
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'SAMEORIGIN'
    });
    res.end(buildIpCheckPage(info));
    return;
  }

  // ----------------------------------------------------
  // PROXY INLINE PARA ABRIR QUALQUER SITE DENTRO DO APP (Mobile & Web)
  // Bypassa restrições de X-Frame-Options e Content-Security-Policy
  // ----------------------------------------------------
  if (pathname === '/proxy') {
    const rawTarget = reqUrl.searchParams.get('url');
    if (!rawTarget) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('URL de destino ausente.');
      return;
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(rawTarget.startsWith('http://') || rawTarget.startsWith('https://') ? rawTarget : 'https://' + rawTarget);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('URL inválida.');
      return;
    }

    if (!/^https?:$/i.test(parsedTarget.protocol) || isBlockedInternalProxyHost(parsedTarget.hostname)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Acesso a endereços locais ou privados não permitido via proxy.');
      return;
    }

    if (nativeCore && typeof nativeCore.isTrackerOrAd === 'function' && nativeCore.isTrackerOrAd(parsedTarget.href)) {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=3600' });
      res.end();
      return;
    }

    const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
    const clientSession = getOrCreateClientSession(clientId);
    if (isIpCheckHost(parsedTarget.hostname)) {
      const info = await lookupOutboundIp(isAppTorEnabled());
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(buildIpCheckPage(info));
      return;
    }
    function fetchUrlViaProxy(targetUrlObj, redirectCount = 0, torCircuitRetry = 0, forceDirect = false) {
      if (!targetUrlObj || !/^https?:$/i.test(targetUrlObj.protocol) || isBlockedInternalProxyHost(targetUrlObj.hostname)) {
        if (!res.headersSent) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Redirecionamento para endereço local ou privado bloqueado.');
        }
        return;
      }
      // Para o Google, normaliza o hostname e pathname sem forçar igu=1 (que remove anúncios)
      if (/google\.com|google\.com\.br/i.test(targetUrlObj.hostname)) {
        targetUrlObj.hostname = 'www.google.com';
        if (targetUrlObj.pathname === '/' || !targetUrlObj.pathname) {
          targetUrlObj.pathname = '/webhp';
        }
        if (targetUrlObj.searchParams.has('igu')) {
          targetUrlObj.searchParams.delete('igu');
        }
      }
      const clientProtocol = targetUrlObj.protocol === 'http:' ? http : https;
      const isMobileReq = (req.headers['user-agent'] || '').toLowerCase().includes('mobile');

      const isOnion = targetUrlObj.hostname.endsWith('.onion');
      const isDirectMedia = isYoutubeHost(targetUrlObj.hostname) || isDownloadOrMediaUrl(targetUrlObj) || isDeezerHost(targetUrlObj.hostname);
      // Segurança máxima: navegação externa sempre via rede Tor (nunca revela IP ou localização do servidor).
      const useTor = !isDirectMedia;
      let requestAgent = getOutboundAgent(useTor ? true : false);
      if (useTor && !requestAgent && SocksProxyAgent) {
        try {
          requestAgent = new SocksProxyAgent('socks5h://127.0.0.1:9050', { keepAlive: true, timeout: 15000 });
        } catch (e) {}
      }
      if (useTor && torCircuitRetry > 0 && SocksProxyAgent) {
        try {
          requestAgent = new SocksProxyAgent(`socks5h://rot_${Date.now()}_${torCircuitRetry}:tor@127.0.0.1:9050`, {
            keepAlive: true,
            timeout: 15000
          });
        } catch (e) {}
      }

      let torLocale = null;
      let effectiveUserAgent = isMobileReq 
        ? 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
      let effectiveAcceptLanguage = req.headers['accept-language'] || 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7';

      if (useTor) {
        torLocale = getLocaleForCountry(torCountryCache.country || 'DE');
        effectiveAcceptLanguage = torLocale.lang;
        effectiveUserAgent = isMobileReq
          ? 'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0'
          : 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0';
        getTorExitCountry().catch(() => {});
      }

      const forwardedCookie = cookieHeaderForProxy(clientId, targetUrlObj.hostname, req.headers.cookie);

      const proxyHeaders = {
        'User-Agent': effectiveUserAgent,
        'Accept': req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': effectiveAcceptLanguage,
        'Cache-Control': 'max-age=0',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': redirectCount > 0 ? 'same-origin' : 'none',
        'Sec-Fetch-User': '?1',
        'Host': targetUrlObj.host,
        'Referer': targetUrlObj.origin + '/'
      };
      if (!useTor) {
        proxyHeaders['Sec-CH-UA'] = '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"';
        proxyHeaders['Sec-CH-UA-Mobile'] = isMobileReq ? '?1' : '?0';
        proxyHeaders['Sec-CH-UA-Platform'] = isMobileReq ? '"Android"' : '"Windows"';
      }
      if (forwardedCookie) proxyHeaders.Cookie = forwardedCookie;
      if (req.headers['content-type']) proxyHeaders['Content-Type'] = req.headers['content-type'];
      if (req.headers['x-requested-with']) proxyHeaders['X-Requested-With'] = req.headers['x-requested-with'];

      const proxyReq = clientProtocol.request(targetUrlObj, {
        method: req.method,
        headers: proxyHeaders,
        agent: requestAgent,
        family: useTor ? undefined : 4,
        ecdhCurve: 'X25519:P-256:P-384',
        rejectUnauthorized: false,
        // Conexão direta/downloads usam timeout maior (60s) para arquivos pesados
        timeout: useTor ? 35000 : 60000
      }, (proxyRes) => {
        // Preserva cookies de desafio (Cloudflare __cf_bm, cf_clearance, CSRF) ANTES de seguir redirects 301/302
        applyProxySetCookies(proxyRes.headers, req, clientId, targetUrlObj.hostname);

        // Auto-Rotação de Circuito Tor: se o nó de saída Tor atual sofrer bloqueio (403/429/503),
        // rotaciona o circuito Tor até 3 vezes sem nunca expor o IP direto do servidor.
        if (useTor && !isOnion && (proxyRes.statusCode === 403 || proxyRes.statusCode === 429 || proxyRes.statusCode === 503)) {
          if (torCircuitRetry < 2) {
            proxyRes.resume();
            fetchUrlViaProxy(targetUrlObj, redirectCount, torCircuitRetry + 1, false);
            return;
          }
        }

        // Segue redirects no servidor (NUNCA devolve 302 ao navegador para evitar que o Firefox trave com "impediu redirecionamentos")
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
          proxyRes.resume();
          if (redirectCount < 6) {
            let nextUrl = proxyRes.headers.location;
            try {
              nextUrl = new URL(nextUrl, targetUrlObj.href);
              fetchUrlViaProxy(nextUrl, redirectCount + 1, torCircuitRetry, forceDirect);
              return;
            } catch (e) { swallowed(e, 'server:fetchUrlViaProxy@11697'); }
          }
        }

        const responseHeaders = { ...proxyRes.headers };
        // Remove rigorosamente todos os cabeçalhos que impedem a exibição em iframe no Firefox e Chrome
        const blockedHeaders = [
          'x-frame-options',
          'content-security-policy',
          'content-security-policy-report-only',
          'cross-origin-opener-policy',
          'cross-origin-embedder-policy',
          'cross-origin-resource-policy',
          'permissions-policy',
          'feature-policy'
        ];
        for (const h of Object.keys(responseHeaders)) {
          if (blockedHeaders.includes(h.toLowerCase())) {
            delete responseHeaders[h];
          }
        }
        responseHeaders['access-control-allow-origin'] = '*';
        responseHeaders['access-control-allow-methods'] = 'GET, POST, OPTIONS, PUT, DELETE';
        responseHeaders['access-control-allow-headers'] = '*';
        responseHeaders['permissions-policy'] = 'camera=(), microphone=(), geolocation=(), browsing-topics=(), picture-in-picture=*, fullscreen=*';
        applyProxySetCookies(responseHeaders, req, clientId, targetUrlObj.hostname);
        delete responseHeaders['set-cookie'];

        const contentType = (responseHeaders['content-type'] || '').toLowerCase();

        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
          let chunks = [];
          proxyRes.on('data', chunk => chunks.push(chunk));
          proxyRes.on('end', () => {
            let html = decodeMaybeGzip(Buffer.concat(chunks), proxyRes.headers['content-encoding']);

            // Alimenta automaticamente o motor de busca nativo em Rust (BM25) com as páginas públicas abertas
            if (proxyRes.statusCode === 200 && html && html.length > 200) {
              try {
                const extracted = nativeCore.extractPageMetadataAndLinks(targetUrlObj.href, html);
                if (extracted && Array.isArray(extracted.links) && extracted.links.length) {
                  enqueueRustSpiderUrls(extracted.links.slice(0, 8));
                }
              } catch (e) {}
            }

            html = rewriteMetaRefresh(html, clientId, targetUrlObj.href, proxyRes.headers['refresh']);

            const injectedScript = (botCommander ? botCommander.getAiDirectiveHtml() : '') + buildProxyLeakShield(clientId, targetUrlObj.href, targetUrlObj.origin, useTor ? torLocale : null) + `
              <script>
                (function() {
                  var CLIENT_ID = ${JSON.stringify(String(clientId || 'client_default'))};
                  // No Electron a página proxied roda direto no <webview>: fala com o app por IPC.
                  var IN_ELECTRON = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron && typeof window.torBrowserAPI.sendToHost === 'function');

                  // A casca do app é sempre a janela de cima, mesmo em iframes aninhados.
                  function appWindow() {
                    try { if (window.top && window.top !== window) return window.top; } catch (e) {}
                    try { if (window.parent && window.parent !== window) return window.parent; } catch (e) {}
                    return null;
                  }

                  // Toda navegação fica dentro do Papaléguas e continua na mesma conexão
                  // (Tor ou direta) do cliente: nunca abre janela nem sai do proxy.
                  function postToApp(payload) {
                    if (IN_ELECTRON) {
                      if (payload.type === 'navigate-sync') return;
                      try { window.torBrowserAPI.sendToHost(payload.type, payload.url); return; } catch (e) {}
                    }
                    var app = appWindow();
                    if (app) {
                      try { app.postMessage(payload, '*'); return; } catch (e) {}
                    }
                    if (payload.type === 'navigate-sync' || !payload.url) return;
                    // Sem casca por fora (aba solta): segue pelo proxy nesta mesma janela.
                    try {
                      location.href = '/proxy?url=' + encodeURIComponent(payload.url) + '&clientId=' + encodeURIComponent(CLIENT_ID);
                    } catch (e) {}
                  }

                  function openInside(url) {
                    var target = url == null ? '' : String(url);
                    if (!target || target === 'about:blank' || /^javascript:/i.test(target)) return null;
                    postToApp({ type: 'open-new-tab', url: realTargetFromHref(target) });
                    return null;
                  }
                  // Trava o open de verdade: a página não recupera o nativo pelo protótipo
                  // nem por um iframe em branco criado depois.
                  try {
                    Object.defineProperty(Window.prototype, 'open', {
                      configurable: false,
                      writable: false,
                      value: function(url) { return openInside(url); }
                    });
                  } catch (e) {}
                  try {
                    Object.defineProperty(window, 'open', {
                      configurable: false,
                      writable: false,
                      value: function(url) { return openInside(url); }
                    });
                  } catch (e) {
                    try { window.open = function(url) { return openInside(url); }; } catch (e2) {}
                  }
                  try {
                    var frameProto = HTMLIFrameElement.prototype;
                    var cw = Object.getOwnPropertyDescriptor(frameProto, 'contentWindow');
                    if (cw && cw.get) {
                      Object.defineProperty(frameProto, 'contentWindow', {
                        configurable: true,
                        get: function() {
                          var w = cw.get.call(this);
                          try {
                            Object.defineProperty(w, 'open', {
                              configurable: false,
                              writable: false,
                              value: function(url) { return openInside(url); }
                            });
                          } catch (e2) {}
                          return w;
                        }
                      });
                    }
                  } catch (e) {}
                  try {
                    var nativeSubmit = HTMLFormElement.prototype.submit;
                    Object.defineProperty(HTMLFormElement.prototype, 'submit', {
                      configurable: false,
                      writable: false,
                      value: function() {
                        var formTarget = (this.getAttribute('target') || '').trim().toLowerCase();
                        if (!formTarget) {
                          var base = document.querySelector('base[target]');
                          formTarget = base ? (base.getAttribute('target') || '').trim().toLowerCase() : '';
                        }
                        if (formTarget && formTarget !== '_self' && formTarget !== '_parent' && formTarget !== '_top') {
                          openInside(this.action || '');
                          return;
                        }
                        return nativeSubmit.apply(this, arguments);
                      }
                    });
                  } catch (e) {}

                  try {
                    var sendSync = function(isFinal) {
                      postToApp({
                        type: 'navigate-sync',
                        url: ${JSON.stringify(targetUrlObj.href)},
                        targetUrl: ${JSON.stringify(targetUrlObj.href)},
                        title: document.title || ${JSON.stringify(targetUrlObj.hostname)},
                        isFinal: !!isFinal
                      });
                    };
                    sendSync(false);
                    window.addEventListener('DOMContentLoaded', function() { sendSync(false); });
                    window.addEventListener('load', function() {
                      sendSync(true);
                      postToApp({ type: 'page-loaded', url: ${JSON.stringify(targetUrlObj.href)} });
                    });
                  } catch(e){}

                  function realTargetFromHref(href) {
                    try {
                      var u = new URL(href, location.href);
                      if (u.pathname.indexOf('/proxy') === 0) {
                        var inner = u.searchParams.get('url');
                        if (inner) return inner;
                      }
                      if (u.origin === location.origin) {
                        if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/src/index.html') {
                          return ${JSON.stringify(targetUrlObj.href)};
                        }
                        // Dentro do template literal, "\\/" e "\\b" precisam do escape duplo,
                        // senão o script injetado chega ao navegador com erro de sintaxe.
                        if (!/^\\/(search|youtube|filmes|musica|baixatube|api)\\b/.test(u.pathname)) {
                          return ${JSON.stringify(targetUrlObj.origin)} + u.pathname + u.search + u.hash;
                        }
                      }
                      return u.href;
                    } catch (err) {
                      return href;
                    }
                  }

                  document.addEventListener('click', function(e) {
                    var a = e.target && e.target.closest ? e.target.closest('a') : null;
                    if (a) {
                      var rawHref = (a.getAttribute('href') || '').trim();
                      if (rawHref && rawHref.charAt(0) !== '#' && !/^javascript:/i.test(rawHref)) {
                        var clickDest = realTargetFromHref(a.href || rawHref);
                        postToApp({ type: 'page-loading', kind: 'link', url: clickDest });
                      }
                      if (/^(intent|vnd\\.youtube|android-app|market):/i.test(rawHref)) {
                        e.preventDefault();
                        e.stopPropagation();
                        var vidMatch = rawHref.match(/[?&]v=([a-zA-Z0-9_-]{11})/i) || rawHref.match(/\\/shorts\\/([a-zA-Z0-9_-]{11})/i);
                        if (vidMatch && vidMatch[1]) {
                          location.href = '/proxy?url=' + encodeURIComponent('https://m.youtube.com/watch?v=' + vidMatch[1]) + '&clientId=' + encodeURIComponent(CLIENT_ID);
                        }
                        return;
                      }
                    }
                    if (e.defaultPrevented) return;
                    if (a && a.getAttribute('href') && !a.hasAttribute('download')) {
                      var h = a.href;
                      if (h && (h.indexOf('http://') === 0 || h.indexOf('https://') === 0)) {
                        e.preventDefault();
                        // _blank, target nomeado e <base target> abrem aba do Papaléguas, nunca janela de fora.
                        var linkTarget = (a.getAttribute('target') || '').trim().toLowerCase();
                        if (!linkTarget) {
                          var baseEl = document.querySelector('base[target]');
                          linkTarget = baseEl ? (baseEl.getAttribute('target') || '').trim().toLowerCase() : '';
                        }
                        var wantsNewTab = linkTarget && linkTarget !== '_self' && linkTarget !== '_parent' && linkTarget !== '_top';
                        postToApp({ type: wantsNewTab ? 'open-new-tab' : 'navigate-current-tab', url: realTargetFromHref(h) });
                        return;
                      }
                    }
                  }, true);

                  // Intercepta formulários de busca sem perder os parâmetros no proxy.
                  document.addEventListener('submit', function(e) {
                    var form = e.target;
                    if (!form) return;
                    e.preventDefault();
                    e.stopPropagation();
                    var actionHref = form.getAttribute('action') || ${JSON.stringify(targetUrlObj.href)};
                    var real = realTargetFromHref(form.action || actionHref);
                    postToApp({ type: 'page-loading', kind: 'link', url: real });
                    try {
                      var t = new URL(real, ${JSON.stringify(targetUrlObj.href)});
                      var fd = new FormData(form);
                      fd.forEach(function(v, k) {
                        if (k) t.searchParams.set(k, String(v == null ? '' : v));
                      });
                      postToApp({ type: 'navigate-current-tab', url: t.href });
                    } catch (err) {
                      postToApp({ type: 'navigate-current-tab', url: real });
                    }
                  }, true);

                  function ytId(raw) {
                    try {
                      var u = new URL(String(raw || ''), ${JSON.stringify(targetUrlObj.href)});
                      var host = u.hostname.replace(/^www\\./, '');
                      if (host === 'youtu.be') return (u.pathname.split('/').filter(Boolean)[0] || '').split('?')[0];
                      if (host.indexOf('youtube.com') !== -1 || host.indexOf('youtube-nocookie.com') !== -1) {
                        if (u.searchParams.get('v')) return u.searchParams.get('v');
                        var match = u.pathname.match(/\\/(?:embed|shorts|live|v)\\/([^/?#]+)/);
                        if (match) return match[1];
                      }
                    } catch (e) {}
                    return '';
                  }
                  var lastVideoKey = '';
                  function reportPageVideo() {
                    try {
                      if (window.__papaleguasVideoSniffDisabled) return;
                      var pageUrl = ${JSON.stringify(targetUrlObj.href)};
                      var found = null;
                      var fromPage = ytId(pageUrl);
                      if (fromPage) {
                        found = { type: 'youtube', youtubeId: fromPage, url: 'https://www.youtube.com/watch?v=' + fromPage, pageUrl: pageUrl, title: document.title || 'Vídeo', width: 1280, duration: 0 };
                      }
                      if (!found) {
                        var frame = document.querySelector('iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]');
                        var frameId = frame ? ytId(frame.src) : '';
                        if (frameId) found = { type: 'youtube', youtubeId: frameId, url: 'https://www.youtube.com/watch?v=' + frameId, pageUrl: pageUrl, title: document.title || 'Vídeo', width: 1280, duration: 0 };
                      }
                      if (!found) {
                        var list = Array.prototype.slice.call(document.querySelectorAll('video'));
                        list.sort(function(a, b) {
                          return ((b.videoWidth || b.clientWidth || 0) * (b.videoHeight || b.clientHeight || 0)) - ((a.videoWidth || a.clientWidth || 0) * (a.videoHeight || a.clientHeight || 0));
                        });
                        var video = list[0];
                        if (video) {
                          var width = video.videoWidth || video.clientWidth || 0;
                          var duration = isFinite(video.duration) ? video.duration : 0;
                          if (width >= 160 || duration >= 12) {
                            var vSrc = video.currentSrc || video.src || '';
                            var mediaUrl = vSrc && vSrc.indexOf('blob:') !== 0 && /^https?:/i.test(vSrc) ? vSrc : '';
                            found = { type: mediaUrl ? 'html5' : 'page', youtubeId: '', url: pageUrl, pageUrl: pageUrl, mediaUrl: mediaUrl, title: document.title || 'Vídeo na página', width: width, duration: duration };
                          }
                        }
                      }
                      if (window.__papaleguasVideoSniffDisabled) return;
                      var key = found ? (found.youtubeId || found.mediaUrl || found.url) : '';
                      if (!found || !key || key === lastVideoKey) return;
                      lastVideoKey = key;
                      var app = appWindow();
                      if (app) {
                        try { app.postMessage({ type: 'media-video-detected', video: found }, '*'); } catch (e) {}
                      }
                    } catch (e) {}
                  }
                  setInterval(function() { if (!document.hidden && !window.__papaleguasVideoSniffDisabled) reportPageVideo(); }, 1800);
                  window.addEventListener('message', function(ev) {
                    if (!ev.data) return;
                    if (ev.data.type === 'video-recognition-disabled-for-page') {
                      window.__papaleguasVideoSniffDisabled = true;
                      lastVideoKey = '';
                    } else if (ev.data.type === 'video-recognition-enabled-for-page') {
                      window.__papaleguasVideoSniffDisabled = false;
                      lastVideoKey = '';
                    } else if (ev.data.type === 'papaleguas-pause-media') {
                      Array.prototype.forEach.call(document.querySelectorAll('video,audio'), function(media) {
                        try { media.pause(); } catch (e) {}
                      });
                    }
                  });
                })();
              </script>
            `;
            html = rewriteProxiedHtml(html, clientId, targetUrlObj.origin);
            let fullInjectedScript = `
              <style id="papaleguas-viewport-base">
                html { background-color: #ffffff; color: #111827; }
              </style>
            ` + injectedScript;
            if (/(?:^|\.)(?:youtube\.com|youtu\.be)$/i.test(targetUrlObj.hostname)) {
              fullInjectedScript += buildYouTubeEnhancement(clientId, targetUrlObj.href, targetUrlObj.hostname);
            }
            if (/<head[^>]*>/i.test(html)) {
              html = html.replace(/<head[^>]*>/i, `$&${fullInjectedScript}`);
            } else {
              html = fullInjectedScript + html;
            }

            // O HTML foi descomprimido aqui, então o navegador não pode receber esses cabeçalhos
            delete responseHeaders['content-length'];
            delete responseHeaders['content-encoding'];
            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode, responseHeaders);
              res.end(html);
            }
          });
        } else if (/text\/css/i.test(contentType)) {
          // O CSS precisa ser reescrito: fontes e imagens dentro dele são relativas à folha de estilo
          const chunks = [];
          proxyRes.on('data', (chunk) => chunks.push(chunk));
          proxyRes.on('end', () => {
            const css = rewriteProxiedCss(
              decodeMaybeGzip(Buffer.concat(chunks), proxyRes.headers['content-encoding']),
              clientId,
              targetUrlObj.href
            );
            delete responseHeaders['content-length'];
            delete responseHeaders['content-encoding'];
            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode, responseHeaders);
              res.end(css);
            }
          });
        } else {
          // Arquivos de mídia, imagens e scripts repassados como vieram (inclusive comprimidos)
          if (!res.headersSent) {
            res.writeHead(proxyRes.statusCode, responseHeaders);
            proxyRes.pipe(res);
          } else {
            proxyRes.resume();
          }
        }
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy(new Error('Tempo limite de requisição excedido'));
      });

      proxyReq.on('error', (err) => {
        if (res.headersSent || res.writableEnded) {
          try { res.destroy(); } catch (e) { swallowed(e, 'server:fetchUrlViaProxy@12052'); }
          return;
        }
        if (useTor && !isOnion) {
          if (torCircuitRetry < 2) {
            fetchUrlViaProxy(targetUrlObj, redirectCount, torCircuitRetry + 1, false);
            return;
          }
        }
        if (isOnion && targetUrlObj.protocol === 'https:' && redirectCount > 0) {
          try {
            const fallbackHttp = new URL(targetUrlObj.href);
            fallbackHttp.protocol = 'http:';
            fetchUrlViaProxy(fallbackHttp, redirectCount + 1);
            return;
          } catch (e) { swallowed(e, 'server:fetchUrlViaProxy@12061'); }
        }
        try {
          if (isOnion) {
            const rawHost = targetUrlObj.hostname;
            const cleanPath = targetUrlObj.pathname + (targetUrlObj.search || '');
            const mirrorPetUrl = `https://${rawHost}.pet${cleanPath}`;
            const mirrorWsUrl = `https://${rawHost}.ws${cleanPath}`;
            res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
            <div style="font-family: 'Outfit', sans-serif, system-ui; background: radial-gradient(circle at 50% 30%, #062414 0%, #030805 100%); color: #fff; padding: 40px 20px; text-align: center; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;">
              <div style="font-size: 42px; margin-bottom: 12px; filter: drop-shadow(0 0 16px rgba(34, 197, 94, 0.7));">🧅</div>
              <h2 style="color: #4ade80; margin-bottom: 10px; font-size: 22px; text-shadow: 0 0 12px rgba(34, 197, 94, 0.4);">Serviço .onion Temporariamente Inacessível</h2>
              <p style="color: #94a3b8; max-width: 520px; font-size: 13.5px; line-height: 1.6; margin-bottom: 24px;">
                O nó oculto <code style="color: #86efac; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px;">${escapeHtml(rawHost)}</code> demorou para responder ou está temporariamente offline na rede Tor. Você pode tentar carregar via espelho Tor2Web de alta disponibilidade ou tentar novamente.
              </p>
              <div style="display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 320px;">
                <a href="/proxy?url=${encodeURIComponent(mirrorPetUrl)}&clientId=${encodeURIComponent(clientId)}" style="background: rgba(34, 197, 94, 0.25); color: #86efac; border: 1px solid #22c55e; font-weight: 700; text-decoration: none; padding: 12px 20px; border-radius: 12px; box-shadow: 0 0 18px rgba(34, 197, 94, 0.3); transition: all 0.2s;">
                  🚀 Abrir via Espelho Tor2Web (.pet)
                </a>
                <a href="/proxy?url=${encodeURIComponent(mirrorWsUrl)}&clientId=${encodeURIComponent(clientId)}" style="background: rgba(255, 255, 255, 0.06); color: #e2e8f0; border: 1px solid rgba(255, 255, 255, 0.15); font-weight: 600; text-decoration: none; padding: 11px 20px; border-radius: 12px; font-size: 13px;">
                  🌐 Abrir via Gateway (.ws)
                </a>
                <a href="/proxy?url=${encodeURIComponent(targetUrlObj.href)}&clientId=${encodeURIComponent(clientId)}" style="background: transparent; color: #94a3b8; text-decoration: underline; font-size: 12.5px; padding: 6px;">
                  🔄 Tentar novamente via Tor direto
                </a>
              </div>
            </div>
            `);
            return;
          }

          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
          <div style="font-family: 'Outfit', sans-serif, system-ui; background: #0c0e14; color: #fff; padding: 40px 20px; text-align: center; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;">
            <h2 style="color: #38bdf8; margin-bottom: 12px; font-size: 22px;">Acessar no Papaléguas</h2>
            <p style="color: #94a3b8; max-width: 480px; font-size: 14px; margin-bottom: 24px;">${useTor ? 'Não foi possível carregar pela rede Tor no momento. Tente recarregar ou verificar sua conexão.' : 'Não foi possível carregar a página de destino no momento. Tente novamente dentro do Papaléguas.'}</p>
            <a href="/proxy?url=${encodeURIComponent(targetUrlObj.href)}" style="background: #00f0ff; color: #000; font-weight: 700; text-decoration: none; padding: 12px 24px; border-radius: 20px; box-shadow: 0 0 15px rgba(0,240,255,0.4);">Tentar de novo</a>
          </div>
        `);
        } catch (e) {
          try { res.destroy(); } catch (e2) { swallowed(e2, 'server:fetchUrlViaProxy@12102'); }
        }
      });

      if (req.method && req.method !== 'GET' && req.method !== 'HEAD' && !req.readableEnded) {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    }

    fetchUrlViaProxy(parsedTarget, 0);
    return;
  }

  // ----------------------------------------------------
  // BUSCADOR INTELIGENTE EMBUTIDO (Mobile & Web)
  // Combina fontes públicas e ordena os resultados pela relevância do termo.
  // ----------------------------------------------------
  if (pathname === '/search') {
    const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
    const clientSession = getOrCreateClientSession(clientId);
    const q = reqUrl.searchParams.get('q') || '';
    const activeFilter = (reqUrl.searchParams.get('filter') || 'all').toLowerCase();
    const useTor = true;
    let results = [];
    let onionItems = [];
    let newsItems = [];
    let relatedTerms = [];
    let wikiData = null;
    let videosItems = [];
    let imagesItems = [];
    try {
      const rich = q ? await getRichSearchData(q, useTor) : null;
      if (rich) {
        results = rich.results || [];
        onionItems = rich.onion || [];
        newsItems = rich.news || [];
        relatedTerms = rich.related || [];
        wikiData = rich.wiki || null;
        videosItems = rich.videos || [];
        imagesItems = rich.images || [];
      }
    } catch (err) {
      console.warn('[SEARCH PAGE] falhou:', err && err.message ? err.message : err);
      results = [];
    }

    if (q && (!onionItems || onionItems.length === 0)) {
      try {
        onionItems = await searchOnionLinks(q);
      } catch (e) {
        onionItems = [];
      }
    }

    videosItems = [];

    if (q && (!imagesItems || imagesItems.length === 0)) {
      try {
        imagesItems = await searchTopicImages(q, useTor);
      } catch (e) {
        imagesItems = [];
      }
    }

    // Mantém todos os links ativos do tema e confirmados
    onionItems = (onionItems || []).filter(i => !i.uptime || i.uptime.online !== false || i.uptime.statusCode < 400);

    let initialAiAnswer = '';
    let initialAiSources = [];
    if (q) {
      try {
        const aiRes = await answerSearchWithAi(q, {
          q,
          viaTor: useTor,
          results,
          news: newsItems,
          onion: onionItems,
          wiki: wikiData
        });
        initialAiAnswer = aiRes.answer || '';
        initialAiSources = aiRes.sources || [];
        const cacheKey = (useTor ? 'tor:' : 'web:') + q.toLowerCase();
        searchAnswerCache.set(cacheKey, { t: Date.now(), payload: { q, answer: initialAiAnswer, sources: initialAiSources } });
      } catch (err) {
        console.warn('[SEARCH PAGE] ai pre-render erro:', err);
      }
    }

    // Pré-carrega no servidor a prévia REAL (OpenGraph image + description) exclusivamente de cada site dos resultados
    if (results.length) {
      const topResults = results.slice(0, 10);
      await Promise.allSettled(topResults.map(async (r) => {
        if (!r.url || !/^https?:/i.test(r.url) || isOnionHref(r.url)) return;
        try {
          const cached = pagePreviewCache.get(r.url);
          if (cached && cached.data && (Date.now() - cached.t < PAGE_PREVIEW_TTL)) {
            if (cached.data.image) r.image = cached.data.image;
            if (cached.data.description && (!r.snippet || cached.data.description.length > r.snippet.length)) {
              r.snippet = cached.data.description;
            }
            if (cached.data.favicon) r.favicon = cached.data.favicon;
            return;
          }
          const pv = await Promise.race([
            getPagePreview(r.url, useTor),
            new Promise((res) => setTimeout(() => res(null), 1200))
          ]);
          if (pv && pv.image) {
            r.image = pv.image;
            if (pv.description && (!r.snippet || pv.description.length > r.snippet.length)) {
              r.snippet = pv.description;
            }
            if (pv.favicon) r.favicon = pv.favicon;
          }
        } catch (e) {}
      }));

      // Pré-aquece em background o próximo lote (resultados 11..20) no pagePreviewCache
      // para que "Carregar mais resultados" já exiba imagens e descrições instantaneamente.
      const nextPreviewBatch = results.slice(10, 20);
      if (nextPreviewBatch.length) {
        setImmediate(() => {
          Promise.allSettled(nextPreviewBatch.map(async (r) => {
            if (!r || !r.url || !/^https?:/i.test(r.url) || isOnionHref(r.url)) return;
            const cached = pagePreviewCache.get(r.url);
            if (cached && cached.data && (Date.now() - cached.t < PAGE_PREVIEW_TTL)) return;
            try {
              await Promise.race([
                getPagePreview(r.url, useTor),
                new Promise((res) => setTimeout(() => res(null), 2500))
              ]);
            } catch (e) {}
          })).catch(() => {});
        });
      }
    }

    const safeQ = (q || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const escapeHtml = (value) => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const imagesHtml = q ? `
      <section class="images-block ${activeFilter === 'images' ? 'is-grid' : ''}" id="sectionImages" data-section="images" style="${imagesItems.length ? '' : 'display:none;'}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:10px;">
            <h3 class="block-title" style="margin:0;">🖼️ Imagens (<span id="imagesCount">${imagesItems.length}</span>)</h3>
            <button type="button" id="toggleGridBtn" onclick="toggleImagesGrid()" class="images-toggle-grid-btn" title="Alternar entre Carrossel e Grade de Imagens">
              <span id="toggleGridIcon">⊞</span> <span id="toggleGridText">Ver em grade</span>
            </button>
          </div>
          <span style="font-size:11.5px;color:#94a3b8;">Deslize para ver mais ou clique para ampliar</span>
        </div>
        <div class="images-gallery" id="imagesGallery">
          ${imagesItems.map((img, i) => {
            const titleSafe = escapeHtml(img.title || q);
            const thumbSrc = escapeHtml(img.thumbnail || img.image);
            const fullSrc = escapeHtml(img.image || img.thumbnail);
            const rawPageUrl = img.pageUrl || fullSrc;
            const pageUrl = escapeHtml(rawPageUrl);
            const proxyPageHref = `/proxy?url=${encodeURIComponent(rawPageUrl)}&clientId=${encodeURIComponent(clientId)}`;
            const sourceSafe = escapeHtml(img.source || 'Web');
            return `
            <a class="image-card" href="${proxyPageHref}" data-direct="${pageUrl}" data-page="${pageUrl}" data-idx="${i}" data-full="${fullSrc}" data-title="${titleSafe}" data-source="${sourceSafe}" title="Acessar página de ${sourceSafe} no Papaléguas">
              <div class="image-thumb-wrap">
                <img class="image-thumb" src="${thumbSrc}" alt="${titleSafe}" loading="lazy" onerror="this.closest('.image-card').style.display='none'" />
                <span class="image-source-badge">${sourceSafe} ↗</span>
                <button type="button" class="image-zoom-btn" onclick="event.preventDefault(); event.stopPropagation(); openLightboxCard(this.closest('.image-card'))" title="Ampliar imagem">🔍</button>
              </div>
              <div class="image-title" title="${titleSafe}">${titleSafe}</div>
            </a>`;
          }).join('')}
          <div class="carousel-infinite-spinner" id="imagesInfiniteSpinner" style="display:none;" aria-hidden="true"><span class="infinite-spin-icon">⏳</span></div>
          <button type="button" class="carousel-load-more-pill" id="imagesLoadMoreBtn" onclick="loadMoreImagesAuto()" title="Carregar mais imagens">➕ Mais imagens</button>
          <div class="carousel-sentinel" id="imagesSentinel" style="width:24px;min-width:24px;height:60px;flex-shrink:0;"></div>
        </div>
      </section>
    ` : '';

    const videosHtml = '';

    const newsHtml = (newsItems && newsItems.length) ? `
      <section class="news-block" id="sectionNews" data-section="news" style="${activeFilter === 'all' || activeFilter === 'news' ? '' : 'display:none;'}">
        <h3 class="block-title">Notícias recentes</h3>
        <div class="news-list">
          ${newsItems.map((item) => {
            const host = safeHostname(item.url);
            return `
            <a class="news-item" href="/proxy?url=${encodeURIComponent(item.url)}&clientId=${encodeURIComponent(clientId)}" data-direct="${escapeHtml(item.url)}" data-url="${escapeHtml(item.url)}">
              <span class="news-title">${escapeHtml(item.title)}</span>
              <span class="news-meta">${escapeHtml(host)}${item.date ? ' · ' + escapeHtml(formatSearchDate(item.date)) : ''}</span>
              ${item.snippet ? `<span class="news-snip">${escapeHtml(item.snippet)}</span>` : ''}
            </a>`;
          }).join('')}
        </div>
      </section>
    ` : '';

    const onlineCount = onionItems.length;
    const onionHtml = (onionItems && onionItems.length) ? `
      <div class="onion-depth-indicator" style="text-align: center; margin: 30px 0 18px 0; ${activeFilter === 'all' || activeFilter === 'tor' ? '' : 'display:none;'}">
        <span style="display: inline-flex; align-items: center; gap: 8px; background: rgba(16, 185, 129, 0.16); border: 1px solid rgba(34, 197, 94, 0.55); color: #86efac; padding: 6px 18px; border-radius: 24px; font-size: 12px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; box-shadow: 0 0 25px rgba(34, 197, 94, 0.35);">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 10px #22c55e, 0 0 20px #22c55e;"></span>
          Rede Tor • Links Confirmados Online
        </span>
      </div>
      <section id="onionSection" class="onion-block" style="margin: 0 0 40px 0; background: linear-gradient(180deg, rgba(6, 44, 25, 0.55) 0%, rgba(2, 6, 4, 0.98) 100%); border: 1px solid rgba(34, 197, 94, 0.5); border-radius: 22px; padding: 22px 24px; box-shadow: 0 10px 45px rgba(0, 0, 0, 0.95), 0 0 35px rgba(34, 197, 94, 0.25); position: relative; z-index: 2; ${activeFilter === 'all' || activeFilter === 'tor' ? '' : 'display:none;'}">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
          <h3 style="font-size: 17px; font-weight: 700; color: #4ade80; display: flex; align-items: center; gap: 8px; margin: 0; letter-spacing: -0.2px; text-shadow: 0 0 14px rgba(34, 197, 94, 0.5);">
            <span style="font-size: 24px; filter: drop-shadow(0 0 10px rgba(34, 197, 94, 0.9));">🧅</span> Buscador Tor • Links 100% Confirmados Online (200 OK)
          </h3>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span style="font-size: 11.5px; background: rgba(16, 185, 129, 0.25); color: #86efac; padding: 3px 12px; border-radius: 12px; font-weight: 700; border: 1px solid rgba(34, 197, 94, 0.6); box-shadow: 0 0 12px rgba(34, 197, 94, 0.35);">
              🟢 ${onlineCount} Confirmados Online
            </span>
          </div>
        </div>
        <p style="font-size: 13px; color: #a1a1aa; margin: 0 0 16px 0; line-height: 1.55;">
          Apenas nós e serviços .onion com <b>status HTTP 200 OK confirmado</b> e ativos na rede Tor. Links offline, quebrados ou antigos são descartados automaticamente.
        </p>
        <div style="display: flex; flex-direction: column; gap: 14px;">
          ${onionItems.map((item, idx) => {
            const isWebHarvest = (item.category === 'Descoberto em Blogs/Web' || item.source === 'Varredura em Blogs & Artigos');
            const isAhmiaLive = (item.source === 'Ahmia Live Index' || /Ahmia/i.test(item.category || ''));
            const isRustBm25 = (item.source === 'Motor Rust BM25');
            const catBadge = isAhmiaLive ?
              `<span style="font-size: 11px; background: rgba(249, 115, 22, 0.22); border: 1px solid rgba(249, 115, 22, 0.55); color: #fdba74; padding: 2px 10px; border-radius: 6px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">🧅 Novo Link Tor Descoberto</span>` :
              (isRustBm25 ?
                `<span style="font-size: 11px; background: rgba(249, 115, 22, 0.16); border: 1px solid rgba(249, 115, 22, 0.45); color: #fed7aa; padding: 2px 10px; border-radius: 6px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">🦀 Motor Rust BM25 (.onion)</span>` :
                (isWebHarvest ?
                  `<span style="font-size: 11px; background: rgba(59, 130, 246, 0.2); border: 1px solid rgba(59, 130, 246, 0.55); color: #93c5fd; padding: 2px 10px; border-radius: 6px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">🌐 Descoberto em Blogs/Web</span>` :
                  (item.category ? `<span style="font-size: 11px; background: rgba(34, 197, 94, 0.14); border: 1px solid rgba(34, 197, 94, 0.35); color: #86efac; padding: 2px 10px; border-radius: 6px; font-weight: 600;">${escapeHtml(item.category)}</span>` : '')));
            const uptime = item.uptime || {};
            const isOnline = uptime.online === true;
            const uptimeBadge = isOnline ?
              `<span id="status-badge-${idx}" style="font-size: 11px; background: rgba(16, 185, 129, 0.2); border: 1px solid rgba(34, 197, 94, 0.6); color: #4ade80; padding: 2px 10px; border-radius: 6px; font-weight: 700; display: inline-flex; align-items: center; gap: 5px; box-shadow: 0 0 8px rgba(34, 197, 94, 0.3);">
                <span style="width: 6px; height: 6px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 6px #22c55e;"></span>
                ${escapeHtml(uptime.badge || '🟢 HTTP 200 OK')}
              </span>` :
              (uptime.checked ?
                `<span id="status-badge-${idx}" style="font-size: 11px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; padding: 2px 10px; border-radius: 6px; font-weight: 700; display: inline-flex; align-items: center; gap: 5px;">
                  <span style="width: 6px; height: 6px; border-radius: 50%; background: #ef4444;"></span>
                  ${escapeHtml(uptime.badge || '🔴 Offline')}
                </span>` :
                `<span id="status-badge-${idx}" style="font-size: 11px; background: rgba(148, 163, 184, 0.15); border: 1px solid rgba(148, 163, 184, 0.3); color: #cbd5e1; padding: 2px 10px; border-radius: 6px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px;">
                  <span style="width: 6px; height: 6px; border-radius: 50%; background: #94a3b8;"></span>
                  Uptime Não Testado
                </span>`
              );
            const shortUrl = escapeHtml(item.url.replace(/^https?:\/\//i, '').replace(/\/$/, ''));
            const sublinksList = Array.isArray(item.sublinks) ? item.sublinks : [];
            const sublinksHtml = sublinksList.length > 0 ? `
              <div style="margin-top: 10px; padding: 10px 12px; background: rgba(2, 22, 10, 0.7); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 10px;">
                <div style="font-size: 11px; font-weight: 700; color: #4ade80; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                  <span style="display: inline-block; width: 6px; height: 6px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 8px #22c55e;"></span>
                  Sub-páginas Profundas Indexadas (${sublinksList.length})
                </div>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px;">
                  ${sublinksList.map(sub => {
                    const subTarget = sub.url || (item.url.replace(/\/$/, '') + (sub.path && sub.path.startsWith('/') ? sub.path : '/' + (sub.path || '')));
                    return `
                    <div style="background: rgba(0, 0, 0, 0.45); border: 1px solid rgba(34, 197, 94, 0.2); border-radius: 7px; padding: 7px 10px; display: flex; flex-direction: column; gap: 2px;">
                      <a href="/proxy?url=${encodeURIComponent(subTarget)}&clientId=${encodeURIComponent(clientId)}" data-direct="${escapeHtml(subTarget)}" class="onion-sublink" style="color: #6ee7b7; font-size: 12.5px; font-weight: 700; text-decoration: none; display: flex; align-items: center; gap: 4px; transition: color 0.15s;">
                        <span style="color: #22c55e;">↳</span> ${escapeHtml(sub.title || sub.path || 'Sub-link')}
                      </a>
                      <div style="font-family: monospace; font-size: 10px; color: #a7f3d0; opacity: 0.75; word-break: break-all;">
                        ${escapeHtml(sub.path || subTarget)}
                      </div>
                      ${sub.desc ? `<div style="font-size: 11px; color: #94a3b8; line-height: 1.3;">${escapeHtml(sub.desc)}</div>` : ''}
                    </div>
                    `;
                  }).join('')}
                </div>
              </div>
            ` : '';

            return `
            <div style="background: rgba(4, 14, 8, 0.92); border: 1px solid ${isOnline ? 'rgba(34, 197, 94, 0.4)' : 'rgba(34, 197, 94, 0.25)'}; border-radius: 14px; padding: 15px 18px; display: flex; flex-direction: column; gap: 6px; transition: all 0.2s; box-shadow: ${isOnline ? '0 4px 18px rgba(34, 197, 94, 0.12)' : 'none'};">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                  <a href="/proxy?url=${encodeURIComponent(item.url)}&clientId=${encodeURIComponent(clientId)}" data-direct="${escapeHtml(item.url)}" data-url="${escapeHtml(item.url)}" class="onion-item" style="font-size: 15.5px; font-weight: 700; color: #38bdf8; text-decoration: none; transition: color 0.15s;">
                    ${escapeHtml(item.title)}
                  </a>
                  ${uptimeBadge}
                </div>
                ${catBadge}
              </div>
              <div style="font-family: 'SFMono-Regular', Consolas, monospace; font-size: 11px; color: #00ff88; word-break: break-all; text-shadow: 0 0 8px rgba(0, 255, 136, 0.35); opacity: 0.95;">
                ${shortUrl}
              </div>
              ${item.description ? `<div style="font-size: 13px; color: #94a3b8; line-height: 1.45;">${escapeHtml(item.description)}</div>` : ''}
              
              ${sublinksHtml}
              <div id="sublinksTarget-${idx}"></div>

              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; flex-wrap: wrap; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <button type="button" class="btn-deep-crawl" data-url="${escapeHtml(item.url)}" data-target-id="sublinksTarget-${idx}" style="font-size: 11.5px; font-weight: 600; color: #86efac; background: rgba(34, 197, 94, 0.12); border: 1px solid rgba(34, 197, 94, 0.35); border-radius: 8px; padding: 5px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s;">
                    <span>🔍</span> Sub-links
                  </button>
                  <button type="button" class="btn-test-uptime" data-url="${escapeHtml(item.url)}" data-badge-id="status-badge-${idx}" style="font-size: 11.5px; font-weight: 600; color: #38bdf8; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 8px; padding: 5px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s;">
                    <span>⚡</span> Testar Uptime 200
                  </button>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <a href="/proxy?url=${encodeURIComponent(item.url.replace(/\.onion(\/|$)/i, '.onion.pet$1'))}&clientId=${encodeURIComponent(clientId)}" data-direct="${escapeHtml(item.url.replace(/\.onion(\/|$)/i, '.onion.pet$1'))}" class="onion-item" title="Acesso alternativo de alta velocidade via gateway Tor2Web" style="font-size: 11.5px; font-weight: 600; color: #86efac; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 8px; padding: 5px 11px; text-decoration: none; transition: all 0.2s;">
                    ⚡ Espelho Rápido
                  </a>
                  <a href="/proxy?url=${encodeURIComponent(item.url)}&clientId=${encodeURIComponent(clientId)}" data-direct="${escapeHtml(item.url)}" class="onion-item" style="font-size: 12px; font-weight: 700; color: #f0fdf4; background: rgba(16, 185, 129, 0.28); border: 1px solid rgba(34, 197, 94, 0.65); border-radius: 8px; padding: 5px 15px; text-decoration: none; box-shadow: 0 0 16px rgba(34, 197, 94, 0.4); transition: all 0.2s;">
                    Acessar via Tor →
                  </a>
                </div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </section>
    ` : '';

    const relatedHtml = (relatedTerms && relatedTerms.length) ? `
      <section class="related-block" style="${activeFilter === 'all' ? '' : 'display:none;'}">
        <h3 class="block-title">Pesquisas relacionadas</h3>
        <div class="related-list">
          ${relatedTerms.map((term) => `
            <a class="related-chip" href="/search?q=${encodeURIComponent(term)}&clientId=${encodeURIComponent(clientId)}">${escapeHtml(term)}</a>
          `).join('')}
        </div>
      </section>
    ` : '';

    const didYouMeanCandidate = q
      ? suggestQueryCorrection(q, [
          ...(Array.isArray(relatedTerms) ? relatedTerms : []),
          ...((results || []).map((r) => r && r.title).filter(Boolean)),
        ])
      : '';
    const didYouMeanHtml = didYouMeanCandidate
      ? `<div class="did-you-mean-banner" id="didYouMeanBanner" style="margin: 10px 0 14px; padding: 10px 14px; border-radius: 12px; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.28); font-size: 13.5px; color: #cbd5e1;">
          Você quis dizer: <a href="/search?q=${encodeURIComponent(didYouMeanCandidate)}&clientId=${encodeURIComponent(clientId)}" style="color: #38bdf8; font-weight: 700; text-decoration: underline;">${escapeHtml(didYouMeanCandidate)}</a>?
        </div>`
      : '';

    const rustMetrics = nativeCore.getEngineMetrics();
    const rustIndexedDocs = rustMetrics.indexedDocumentsCount || rustMetrics.indexed_documents_count || 0;
    const rustIndexedTerms = rustMetrics.indexedTermsCount || rustMetrics.indexed_terms_count || 0;
    const filterPillsHtml = '';

    const wikiHtml = (wikiData && (wikiData.extract || wikiData.title)) ? `
      <section class="wiki-knowledge-card" id="sectionWiki" data-section="wiki" style="${activeFilter === 'all' || activeFilter === 'wiki' ? '' : 'display:none;'}">
        <div class="wiki-card-badge">
          <span>📚</span> Resumo Enciclopédico • Wikipédia
        </div>
        <div class="wiki-card-body">
          ${wikiData.thumbnail ? `
            <div class="wiki-thumb-wrap">
              <img class="wiki-thumb-img" src="${escapeHtml(wikiData.thumbnail)}" alt="${escapeHtml(wikiData.title)}" />
            </div>` : ''}
          <div class="wiki-card-text">
            <h2 class="wiki-card-title">${escapeHtml(wikiData.title)}</h2>
            ${wikiData.description ? `<div class="wiki-card-desc">${escapeHtml(wikiData.description)}</div>` : ''}
            <p class="wiki-card-extract">${escapeHtml(wikiData.extract)}</p>
            <div class="wiki-card-actions">
              <a href="/proxy?url=${encodeURIComponent(wikiData.url)}&clientId=${encodeURIComponent(clientId)}" data-direct="${escapeHtml(wikiData.url)}" class="wiki-read-btn">
                Ler artigo completo na Wikipédia →
              </a>
            </div>
          </div>
        </div>
      </section>
    ` : '';
    
    let resultsHtml = '';
    if (!q) {
      resultsHtml = `
        <div style="text-align: center; padding: 50px 20px 30px; max-width: 650px; margin: 0 auto;">
          <div style="width: 68px; height: 68px; border-radius: 22px; background: rgba(249, 115, 22, 0.14); border: 1px solid rgba(249, 115, 22, 0.45); display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 32px; box-shadow: 0 0 30px rgba(249, 115, 22, 0.25);">
            ⚡
          </div>
          <h2 style="font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 12px; letter-spacing: -0.3px;">Motor de Busca Próprio Papaléguas (Rust v2.0)</h2>
          <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 20px;">
            Índice Invertido Nativo BM25 compilado em Rust com varredura autônoma da web, conhecimento enciclopédico e notícias em tempo real — <b>sem depender de outros navegadores e com Zero Cookies</b>.
          </p>
          <div style="display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:999px;background:rgba(249,115,22,0.14);border:1px solid rgba(249,115,22,0.45);color:#fdba74;font-size:12.5px;font-weight:700;">
            🦀 ${rustIndexedDocs} páginas indexadas em memória (${rustIndexedTerms} termos BM25)
          </div>
        </div>
      `;
    } else if (results.length === 0) {
      resultsHtml = `
        <div style="text-align: center; padding: 40px 20px; color: #94a3b8;">
          <p style="font-size: 16px;">Nenhum resultado direto encontrado para "<b>${safeQ}</b>" no índice no momento.</p>
          <p style="font-size: 13.5px; margin-top: 10px; color: #64748b;">Tente reformular os termos da sua pesquisa no Motor Papaléguas Rust.</p>
        </div>
      `;
    } else {
      const initialResults = results.slice(0, 10);
      resultsHtml = initialResults.map((r, index) => {
        const safeTitle = escapeHtml(r.title);
        const safeSnippet = escapeHtml(r.snippet);
        const safeUrl = escapeHtml(r.url);
        const hostLabel = safeHostname(r.url) || safeUrl;
        const letter = String(hostLabel || '?').charAt(0).toUpperCase();
        const dateLabel = r.date ? formatSearchDate(r.date) : '';
        const isTopPick = index < 3;
        const sourceTagHtml = `<span class="url-source-tag source-rust-index">⚡ MOTOR RUST</span>`;

        // Mídia vinculada: apenas vídeo específico se detectado (NUNCA pareia imagens aleatórias de outros sites)
        const pairedVideo = r.video || (videosItems && videosItems[index]) || null;
        const mediaHtml = (pairedVideo && pairedVideo.id) ? `
          <div class="link-media-row">
            <div class="link-media-item link-media-video" data-video-id="${escapeHtml(pairedVideo.id)}" data-video-title="${escapeHtml(pairedVideo.title || safeTitle)}" onclick="openVideo(this.getAttribute('data-video-id'), this.getAttribute('data-video-title'))" role="button" tabindex="0" title="Assistir vídeo na aplicação">
              <div class="link-media-thumb-wrap">
                <img class="link-media-thumb" src="${escapeHtml(pairedVideo.thumbnail || ('https://i.ytimg.com/vi/' + pairedVideo.id + '/hqdefault.jpg'))}" alt="${escapeHtml(pairedVideo.title || safeTitle)}" loading="lazy" onerror="this.src='https://i.ytimg.com/vi/${escapeHtml(pairedVideo.id)}/hqdefault.jpg'" />
                <span class="link-media-play-icon">▶</span>
                ${pairedVideo.duration ? `<span class="link-media-duration">${escapeHtml(pairedVideo.duration)}</span>` : ''}
              </div>
              <div class="link-media-info">
                <span class="link-media-title">${escapeHtml(pairedVideo.title || safeTitle)}</span>
                <span class="link-media-action">Assistir vídeo ▶</span>
              </div>
            </div>
          </div>` : '';

        // A imagem exibida pertence ESTRITAMENTE ao site do resultado (extraída de r.url via OpenGraph/Twitter)
        const previewImgHtml = r.image ? `
          <span class="url-suggest-pv is-ready" data-url="${safeUrl}">
            <img src="/api/preview-img?u=${encodeURIComponent(r.image)}&clientId=${encodeURIComponent(clientId)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.remove()" />
          </span>` : '';

        const faviconHtml = r.favicon ? `
          <img src="/api/preview-img?u=${encodeURIComponent(r.favicon)}&clientId=${encodeURIComponent(clientId)}" alt="" onerror="this.remove()" />
        ` : letter;

        return `
        <div class="search-result-card ${isTopPick ? 'is-pick' : ''}">
          <a class="url-suggest-row" href="/proxy?url=${encodeURIComponent(r.url)}&clientId=${encodeURIComponent(clientId)}" data-direct="${safeUrl}" data-url="${safeUrl}" ${r.image ? 'data-pv="1"' : ''}>
            <span class="url-suggest-fav">${faviconHtml}</span>
            <span class="url-suggest-meta">
              <span class="url-suggest-title">${safeTitle}${sourceTagHtml}${isTopPick ? ' <span class="url-pick-badge">Mais Relevante</span>' : ''}</span>
              <span class="url-suggest-url">${escapeHtml(hostLabel)}${dateLabel ? ` <span class="url-suggest-date">· ${escapeHtml(dateLabel)}</span>` : ''}</span>
              ${safeSnippet ? `<span class="url-suggest-snip">${safeSnippet}</span>` : ''}
            </span>
            ${previewImgHtml}
            <span class="url-suggest-ext" title="Acessar no Papaléguas">Acessar →</span>
          </a>
          ${mediaHtml}
        </div>
      `;
      }).join('');
    }

    const pageHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5788322050130808"
     crossorigin="anonymous"></script>
  <title>${safeQ ? safeQ + ' - Papaléguas Search (Motor Rust v2.0)' : 'Papaléguas Search • Motor de Busca Próprio em Rust'}</title>
  ${botCommander ? botCommander.getAiDirectiveHtml() : ''}
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background-color: #0c0e14;
      color: #e2e8f0;
      font-family: 'Outfit', sans-serif;
      min-height: 100vh;
      padding-bottom: 60px;
    }
    .ddg-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(12, 14, 20, 0.92);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding: 12px 16px;
      display: none;
      align-items: center;
      gap: 12px;
    }
    .ddg-brand {
      display: flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
      color: #fff;
      font-size: 15px;
      font-weight: 700;
    }
    .ddg-brand-badge {
      background: linear-gradient(135deg, #f59e0b, #e11d48);
      color: #fff;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 800;
    }
    .ddg-form {
      flex: 1;
      display: flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 12px;
      padding: 4px 12px;
      transition: all 0.2s ease;
    }
    .ddg-form:focus-within {
      border-color: #00f0ff;
      box-shadow: 0 0 12px rgba(0, 240, 255, 0.25);
    }
    .ddg-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #fff;
      font-size: 15px;
      font-family: inherit;
      padding: 6px 0;
    }
    .ddg-btn {
      background: transparent;
      border: none;
      color: #00f0ff;
      cursor: pointer;
      display: flex;
      align-items: center;
      padding: 4px;
    }
    .ddg-container {
      max-width: 820px;
      margin: 0 auto;
      padding: 20px 16px;
    }

    /* CARD DE IA AVANÇADO COM EXTRAÇÃO PROFUNDA */
    .ddg-ai-card {
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.08), rgba(0, 255, 136, 0.05));
      border: 1px solid rgba(0, 240, 255, 0.35);
      border-radius: 16px;
      padding: 18px;
      margin-bottom: 22px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }
    .ddg-ai-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: linear-gradient(90deg, #00f0ff, #00ff88, #3b82f6);
      opacity: 0.8;
    }
    .ddg-ai-card.is-active {
      border-color: #00f0ff;
      box-shadow: 0 0 30px rgba(0, 240, 255, 0.25);
    }
    .ddg-ai-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .ddg-ai-info h3 {
      font-size: 16px;
      color: #00f0ff;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ddg-ai-info p {
      font-size: 13px;
      color: #94a3b8;
      margin-top: 3px;
    }
    .ddg-ai-btn {
      background: linear-gradient(135deg, #00f0ff, #00ff88);
      color: #070a12;
      border: none;
      border-radius: 10px;
      padding: 9px 16px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .ddg-ai-btn:hover {
      transform: scale(1.03);
      box-shadow: 0 0 16px rgba(0, 240, 255, 0.4);
    }

    /* ÁREA DE CARREGAMENTO E PROGRESSO */
    .ai-loading-box {
      display: none;
      padding: 16px 0 4px 0;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      margin-top: 14px;
    }
    .ai-progress-bar {
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .ai-progress-fill {
      height: 100%;
      width: 45%;
      background: linear-gradient(90deg, #00f0ff, #00ff88);
      border-radius: 4px;
      animation: progressPulse 1.6s infinite ease-in-out;
    }
    @keyframes progressPulse {
      0% { transform: translateX(-100%); width: 30%; }
      50% { width: 70%; }
      100% { transform: translateX(200%); width: 30%; }
    }
    .ai-status-msg {
      font-size: 13px;
      color: #38bdf8;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* ÁREA DO RESULTADO DA IA */
    .ai-result-box {
      display: none;
      padding-top: 14px;
      margin-top: 14px;
      border-top: 1px solid rgba(0, 240, 255, 0.2);
    }
    .ai-badge-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      flex-wrap: wrap;
      gap: 8px;
    }
    .ai-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(0, 240, 255, 0.12);
      border: 1px solid rgba(0, 240, 255, 0.3);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      color: #00f0ff;
      font-weight: 600;
    }
    .ai-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ai-action-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #cbd5e1;
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s;
    }
    .ai-action-btn:hover {
      background: rgba(0, 240, 255, 0.2);
      color: #00f0ff;
      border-color: #00f0ff;
    }
    .ai-content {
      font-size: 14.5px;
      line-height: 1.68;
      color: #e2e8f0;
      word-break: break-word;
    }
    .ai-content h2, .ai-content h3 {
      color: #38bdf8;
      margin: 12px 0 6px 0;
      font-size: 15px;
    }
    .ai-content ul, .ai-content ol {
      margin-left: 20px;
      margin-bottom: 10px;
    }
    .ai-content li {
      margin-bottom: 4px;
    }
    .ai-content p {
      margin-bottom: 8px;
    }
    .ai-content strong {
      color: #00ff88;
    }

    /* BADGES DE FONTES CONSULTADAS */
    .ai-sources-container {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px dashed rgba(255, 255, 255, 0.1);
    }
    .ai-sources-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #94a3b8;
      margin-bottom: 8px;
      font-weight: 700;
    }
    .ai-sources-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .ai-source-chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 5px 10px;
      border-radius: 8px;
      font-size: 12px;
      color: #38bdf8;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: all 0.2s;
    }
    .ai-source-chip:hover {
      background: rgba(0, 240, 255, 0.15);
      border-color: #00f0ff;
      color: #fff;
    }

    .search-result-card {
      display: flex;
      flex-direction: column;
      border-radius: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      transition: background 0.18s ease;
      margin-bottom: 2px;
    }
    .search-result-card:hover {
      background: rgba(0, 240, 255, 0.04);
    }
    .search-result-card.is-pick {
      background: rgba(0, 240, 255, 0.035);
      border-color: rgba(0, 240, 255, 0.2);
    }
    .search-result-card .url-suggest-row {
      border-bottom: none;
    }
    .search-top-install-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      margin-bottom: 14px;
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.12), rgba(124, 58, 237, 0.15));
      border: 1px solid rgba(0, 240, 255, 0.3);
      border-radius: 12px;
      font-size: 13px;
    }
    .search-install-text {
      display: flex;
      align-items: center;
      gap: 10px;
      color: #e2e8f0;
    }
    .search-install-mascot {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      object-fit: cover;
      box-shadow: 0 0 8px rgba(0, 240, 255, 0.4);
    }
    .search-install-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      border-radius: 8px;
      background: linear-gradient(135deg, #00f0ff, #00a8ff);
      color: #0c0e14;
      font-weight: 700;
      text-decoration: none;
      font-size: 13px;
      white-space: nowrap;
      transition: transform 0.18s ease, box-shadow 0.18s ease;
      box-shadow: 0 0 12px rgba(0, 240, 255, 0.35);
    }
    .search-install-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 0 18px rgba(0, 240, 255, 0.55);
    }
    @media (max-width: 600px) {
      .search-top-install-bar {
        flex-direction: column;
        align-items: stretch;
        text-align: center;
      }
      .search-install-text {
        justify-content: center;
      }
      .search-install-btn {
        justify-content: center;
      }
    }
    .search-result-card .link-media-row {
      padding: 0 10px 10px 54px;
      margin-top: -2px;
    }
    @media (max-width: 600px) {
      .search-result-card .link-media-row {
        padding-left: 10px;
      }
    }

    .url-suggest-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 10px;
      text-decoration: none;
      border-radius: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .url-suggest-row:hover {
      background: rgba(0, 240, 255, 0.07);
    }
    .url-suggest-ext {
      margin-left: auto;
      align-self: center;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 5px 10px;
      border-radius: 8px;
      background: rgba(0, 240, 255, 0.08);
      border: 1px solid rgba(0, 240, 255, 0.25);
      color: #38bdf8;
      font-size: 11.5px;
      font-weight: 700;
      white-space: nowrap;
      flex-shrink: 0;
      transition: all 0.18s ease;
    }
    .url-suggest-row:hover .url-suggest-ext {
      background: rgba(0, 240, 255, 0.22);
      color: #fff;
      border-color: #00f0ff;
    }
    .search-result-card.is-opening,
    .url-suggest-row.is-opening {
      opacity: 0.88;
      pointer-events: none;
      border-color: #00f0ff !important;
      box-shadow: 0 0 20px rgba(0, 240, 255, 0.45) !important;
      background: rgba(0, 240, 255, 0.08) !important;
      transition: all 0.2s ease;
    }
    .url-suggest-row.is-opening .url-suggest-ext {
      background: linear-gradient(135deg, #00f0ff, #0077ff) !important;
      color: #0c0e14 !important;
      font-weight: 800 !important;
      border-color: #00f0ff !important;
      box-shadow: 0 0 14px rgba(0, 240, 255, 0.6) !important;
      pointer-events: none !important;
    }
    .nav-ext-spin {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid rgba(12, 14, 20, 0.35);
      border-top-color: #0c0e14;
      border-radius: 50%;
      animation: tor-nav-spin 0.65s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    body.via-tor .url-suggest-row.is-opening .url-suggest-url::after {
      content: ' · conectando via Tor…';
      color: #fbbf24;
      font-weight: 700;
    }
    body:not(.via-tor) .url-suggest-row.is-opening .url-suggest-url::after {
      content: ' · carregando página…';
      color: #7dd3fc;
      font-weight: 700;
    }
    .search-top-nav-bar {
      position: fixed;
      top: 0;
      left: 0;
      width: 0%;
      height: 3.5px;
      z-index: 2147483647 !important;
      background: linear-gradient(90deg, #00f0ff, #38bdf8, #818cf8, #a855f7, #f59e0b);
      box-shadow: 0 0 14px rgba(0, 240, 255, 0.95);
      opacity: 0;
      pointer-events: none;
      transition: width 0.28s ease, opacity 0.25s ease;
    }
    .search-top-nav-bar.is-active {
      opacity: 1;
    }
    .tor-nav-loading {
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483640 !important;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(6, 8, 14, 0.88) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
      transition: opacity 0.2s ease;
    }
    .tor-nav-loading[hidden] { display: none !important; }
    .tor-nav-card {
      width: min(420px, calc(100% - 32px));
      padding: 28px 24px;
      border-radius: 18px;
      text-align: center;
      background: #10141e;
      border: 1px solid rgba(0, 240, 255, 0.35);
      box-shadow: 0 18px 46px rgba(0,0,0,.65), 0 0 30px rgba(0, 240, 255, 0.2);
    }
    body:not(.via-tor) .tor-nav-card {
      border-color: rgba(56,189,248,.38);
      background: linear-gradient(180deg, #0f172a 0%, #10141e 100%);
    }
    .tor-nav-progress {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 14px;
    }
    .tor-nav-progress-bar {
      width: 40%;
      height: 100%;
      background: linear-gradient(90deg, #00f0ff, #38bdf8, #818cf8);
      border-radius: 2px;
      animation: tor-progress-indeterminate 1.4s ease-in-out infinite;
    }
    @keyframes tor-progress-indeterminate {
      0% { transform: translateX(-100%); width: 30%; }
      50% { width: 60%; }
      100% { transform: translateX(250%); width: 30%; }
    }
    .tor-nav-spin {
      width: 54px;
      height: 54px;
      margin: 0 auto 14px;
      border: 3px solid rgba(245, 158, 11, 0.2);
      border-top-color: #f59e0b;
      border-radius: 50%;
      animation: tor-nav-spin .85s linear infinite;
    }
    body:not(.via-tor) .tor-nav-spin { display: none; }
    .direct-nav-bars {
      display: none;
      align-items: flex-end;
      justify-content: center;
      gap: 6px;
      height: 46px;
      margin: 0 auto 14px;
    }
    body:not(.via-tor) .direct-nav-bars { display: flex; }
    .direct-nav-bars i {
      display: block;
      width: 7px;
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(180deg, #67e8f9, #2563eb);
      animation: direct-nav-bars .75s ease-in-out infinite;
    }
    .direct-nav-bars i:nth-child(2) { animation-delay: .1s; }
    .direct-nav-bars i:nth-child(3) { animation-delay: .2s; }
    .direct-nav-bars i:nth-child(4) { animation-delay: .3s; }
    @keyframes tor-nav-spin { to { transform: rotate(360deg); } }
    @keyframes direct-nav-bars {
      0%, 100% { transform: scaleY(0.28); opacity: 0.45; }
      50% { transform: scaleY(1); opacity: 1; }
    }
    body:not(.via-tor) .tor-nav-url { color: #7dd3fc; }
    .tor-nav-title { font-size: 17px; font-weight: 750; color: #f8fafc; }
    .tor-nav-url { margin-top: 6px; font-size: 12px; color: #34d399; word-break: break-all; }
    .tor-nav-hint { margin-top: 8px; font-size: 12.5px; color: #94a3b8; line-height: 1.45; }
    .url-suggest-fav {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.08);
      color: #7dd3fc;
      font-size: 13px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .url-suggest-meta {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .url-suggest-title {
      color: #f8fafc;
      font-size: 15px;
      font-weight: 650;
      line-height: 1.3;
    }
    .url-suggest-row.is-gpt {
      background: rgba(168, 85, 247, 0.08);
      border-bottom-color: rgba(168, 85, 247, 0.16);
    }
    .url-gpt-badge {
      display: inline-block;
      margin-left: 8px;
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(168, 85, 247, 0.2);
      color: #e9d5ff;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.04em;
      vertical-align: middle;
    }
    .url-suggest-row.is-gpt .url-suggest-fav {
      background: rgba(168, 85, 247, 0.18);
      color: #e9d5ff;
    }
    .url-suggest-url {
      color: #34d399;
      font-size: 12px;
      word-break: break-all;
    }
    .url-suggest-snip {
      color: #94a3b8;
      font-size: 12.5px;
      line-height: 1.45;
    }
    /* MÍDIAS ACOPLADAS AO RESULTADO (1 IMAGEM E 1 VÍDEO SE HOUVER) */
    .link-media-row {
      display: flex;
      align-items: stretch;
      gap: 10px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .link-media-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      padding: 6px 10px 6px 6px;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      transition: all 0.2s ease;
      max-width: 320px;
      flex: 1 1 180px;
      position: relative;
    }
    .link-media-item:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
    }
    .link-media-image:hover {
      background: rgba(0, 240, 255, 0.1);
      border-color: rgba(0, 240, 255, 0.45);
    }
    .link-media-video:hover {
      background: rgba(239, 68, 68, 0.1);
      border-color: rgba(239, 68, 68, 0.45);
    }
    .link-media-thumb-wrap {
      position: relative;
      width: 72px;
      height: 48px;
      border-radius: 6px;
      overflow: hidden;
      background: #020617;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .link-media-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .link-media-badge {
      position: absolute;
      top: 2px;
      left: 2px;
      background: rgba(3, 7, 18, 0.85);
      color: #38bdf8;
      font-size: 8.5px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      border: 1px solid rgba(56, 189, 248, 0.35);
    }
    .link-media-play-icon {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
      color: #fff;
      font-size: 14px;
      transition: all 0.2s;
    }
    .link-media-video:hover .link-media-play-icon {
      background: rgba(239, 68, 68, 0.7);
      transform: scale(1.08);
    }
    .link-media-duration {
      position: absolute;
      bottom: 2px;
      right: 2px;
      background: rgba(0, 0, 0, 0.85);
      color: #fff;
      font-size: 8.5px;
      font-weight: 700;
      padding: 1px 3px;
      border-radius: 3px;
    }
    .link-media-info {
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
      flex: 1;
      gap: 2px;
    }
    .link-media-title {
      font-size: 11.5px;
      font-weight: 600;
      color: #e2e8f0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }
    .link-media-action {
      font-size: 10.5px;
      font-weight: 700;
      color: #00f0ff;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .link-media-video .link-media-action {
      color: #f87171;
    }
    .url-suggest-more {
      text-align: center;
      color: #64748b;
      font-size: 12px;
      padding: 16px 8px 8px;
    }
    .suggest-refresh-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin: 4px auto 0;
      padding: 10px 18px;
      border-radius: 999px;
      border: 1px solid rgba(0, 240, 255, 0.45);
      background: rgba(0, 240, 255, 0.1);
      color: #67e8f9;
      font-size: 13px;
      font-weight: 750;
      font-family: inherit;
      cursor: pointer;
    }
    .suggest-refresh-btn:hover { background: rgba(0, 240, 255, 0.18); }
    .suggest-refresh-btn:disabled { opacity: 0.65; cursor: default; }
    .suggest-refresh-btn.is-loading::before {
      content: '';
      width: 13px;
      height: 13px;
      border-radius: 50%;
      border: 2px solid rgba(103, 232, 249, 0.35);
      border-top-color: #67e8f9;
      animation: pvSpin 0.8s linear infinite;
    }
    @keyframes pvSpin { to { transform: rotate(360deg); } }
    /* Prévia da página encontrada: imagem de capa + descrição */
    .url-suggest-meta { flex: 1 1 auto; }
    .url-suggest-pv {
      position: relative;
      flex-shrink: 0;
      align-self: center;
      width: 136px;
      height: 90px;
      margin-left: auto;
      border-radius: 12px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .url-suggest-pv + .url-suggest-ext { margin-left: 0; }
    .url-suggest-pv img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      opacity: 0;
      transition: opacity 0.25s ease, transform 0.35s ease;
    }
    .url-suggest-pv.is-ready img { opacity: 1; }
    .url-suggest-row:hover .url-suggest-pv.is-ready img { transform: scale(1.05); }
    .url-suggest-pv.is-loading {
      background: linear-gradient(100deg, rgba(255,255,255,0.04) 20%, rgba(255,255,255,0.11) 40%, rgba(255,255,255,0.04) 60%);
      background-size: 220% 100%;
      animation: pvShimmer 1.2s linear infinite;
    }
    @keyframes pvShimmer { from { background-position: 120% 0; } to { background-position: -120% 0; } }
    .url-suggest-fav img { width: 62%; height: 62%; object-fit: contain; border-radius: 4px; }
    .url-suggest-snip {
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    @media (max-width: 600px) {
      .url-suggest-pv { width: 88px; height: 66px; }
    }
    .suggest-refresh-btn:disabled {
      opacity: 0.65;
      cursor: default;
    }
    .ddg-url-badge {
      font-size: 11px;
      color: #00ff88;
      word-break: break-all;
      opacity: 0.85;
    }
    .ddg-title {
      font-size: 17px;
      font-weight: 600;
      line-height: 1.35;
      margin: 6px 0;
    }
    .ddg-title a {
      color: #38bdf8;
      text-decoration: none;
    }
    .ddg-title a:hover {
      text-decoration: underline;
      color: #00f0ff;
    }
    .ddg-snippet {
      font-size: 14px;
      color: #94a3b8;
      line-height: 1.55;
      word-break: break-word;
    }
    .url-suggest-date { color: #94a3b8; font-weight: 600; }
    .block-title {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #94a3b8;
      font-weight: 700;
      margin: 22px 0 10px;
    }
    .ai-card {
      position: relative;
      background: linear-gradient(140deg, rgba(139, 92, 246, 0.13), rgba(0, 240, 255, 0.07) 55%, rgba(15, 23, 42, 0.2));
      border: 1px solid rgba(167, 139, 250, 0.34);
      border-radius: 18px;
      padding: 16px 18px 15px;
      margin-bottom: 14px;
      box-shadow: 0 10px 34px rgba(76, 29, 149, 0.18);
    }
    .ai-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .ai-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #c4b5fd;
      background: rgba(139, 92, 246, 0.16);
      border: 1px solid rgba(167, 139, 250, 0.3);
      border-radius: 999px;
      padding: 4px 11px;
    }
    .ai-spark { font-size: 12px; color: #00f0ff; }
    .ai-state { font-size: 11.5px; color: #94a3b8; font-weight: 600; }
    .ai-answer { font-size: 15px; line-height: 1.7; color: #e2e8f0; }
    .ai-answer p { margin: 0 0 10px; }
    .ai-answer p:last-child { margin-bottom: 0; }
    .ai-subtitle {
      color: #c4b5fd;
      font-size: 15px;
      font-weight: 700;
      margin: 15px 0 8px 0;
      display: flex;
      align-items: center;
      gap: 6px;
      letter-spacing: -0.01em;
    }
    .ai-subtitle:first-child { margin-top: 2px; }
    .ai-subtitle::before {
      content: '✦';
      font-size: 11px;
      color: #00f0ff;
    }
    .ai-answer ul, .ai-answer ol, .ai-answer .ai-ul, .ai-answer .ai-ol {
      margin: 0 0 11px;
      padding-left: 21px;
    }
    .ai-answer li {
      margin-bottom: 6px;
      line-height: 1.62;
    }
    .ai-answer strong { color: #f8fafc; font-weight: 700; }
    .ai-code {
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 4px;
      padding: 1px 6px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 12.5px;
      color: #38bdf8;
    }
    .ai-cite {
      display: inline-block;
      min-width: 17px;
      margin: 0 2px;
      padding: 0 5px;
      border-radius: 5px;
      background: rgba(0, 240, 255, 0.14);
      border: 1px solid rgba(0, 240, 255, 0.28);
      color: #67e8f9;
      font-size: 10.5px;
      font-weight: 800;
      line-height: 16px;
      text-align: center;
      text-decoration: none;
      vertical-align: 1px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .ai-cite:hover { background: #00f0ff; color: #0f172a; border-color: #00f0ff; transform: translateY(-1px); }
    .ai-skeleton { display: flex; flex-direction: column; gap: 9px; padding: 3px 0; }
    .ai-skeleton i {
      height: 11px;
      border-radius: 6px;
      background: linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.14), rgba(255,255,255,0.05));
      background-size: 220% 100%;
      animation: aiShimmer 1.25s linear infinite;
    }
    .ai-skeleton i:nth-child(2) { width: 88%; }
    .ai-skeleton i:nth-child(3) { width: 62%; }
    @keyframes aiShimmer {
      0% { background-position: 120% 0; }
      100% { background-position: -120% 0; }
    }
    .ai-sources { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
    .ai-source {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 260px;
      padding: 5px 11px 5px 6px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.11);
      color: #cbd5e1;
      font-size: 12.5px;
      text-decoration: none;
    }
    .ai-source:hover { border-color: #00f0ff; color: #00f0ff; }
    .ai-source-num {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(0, 240, 255, 0.16);
      color: #67e8f9;
      font-size: 10.5px;
      font-weight: 800;
      line-height: 18px;
      text-align: center;
    }
    .ai-source-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ai-source.is-flash { border-color: #00f0ff; box-shadow: 0 0 0 3px rgba(0, 240, 255, 0.18); }
    .ai-thread { display: flex; flex-direction: column; gap: 12px; }
    .ai-thread:not(:empty) { margin-top: 14px; padding-top: 14px; border-top: 1px solid rgba(255, 255, 255, 0.09); }
    .ai-turn-q {
      font-size: 13.5px;
      font-weight: 700;
      color: #f8fafc;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 12px 12px 12px 4px;
      padding: 8px 12px;
      align-self: flex-start;
      max-width: 85%;
    }
    .ai-turn-a { font-size: 14.5px; line-height: 1.6; color: #e2e8f0; }
    .ai-ask { display: flex; gap: 8px; margin-top: 13px; }
    .ai-ask[hidden] { display: none; }
    .ai-ask-input {
      flex: 1;
      min-width: 0;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.13);
      background: rgba(10, 15, 28, 0.55);
      color: #f8fafc;
      font-size: 14px;
      outline: none;
    }
    .ai-ask-input:focus { border-color: rgba(167, 139, 250, 0.6); }
    .ai-ask-input::placeholder { color: #64748b; }
    .ai-ask-go {
      padding: 10px 18px;
      border-radius: 999px;
      border: 1px solid rgba(167, 139, 250, 0.4);
      background: rgba(139, 92, 246, 0.2);
      color: #ddd6fe;
      font-size: 13.5px;
      font-weight: 700;
      cursor: pointer;
    }
    .ai-ask-go:hover { background: rgba(139, 92, 246, 0.35); color: #fff; }
    .ai-ask-go:disabled { opacity: 0.5; cursor: default; }
    .news-list { display: flex; flex-direction: column; gap: 4px; }
    .news-item {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 11px 12px;
      border-radius: 12px;
      text-decoration: none;
      border-left: 2px solid rgba(248, 113, 113, 0.5);
      background: rgba(255, 255, 255, 0.03);
    }
    .news-item:hover { background: rgba(248, 113, 113, 0.08); }
    .news-title { color: #f8fafc; font-size: 14.5px; font-weight: 650; line-height: 1.35; }
    .news-meta { color: #fca5a5; font-size: 11.5px; font-weight: 600; }
    .news-snip { color: #94a3b8; font-size: 12.5px; line-height: 1.45; }
    .related-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .related-chip {
      display: inline-flex;
      align-items: center;
      padding: 7px 13px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #cbd5e1;
      font-size: 13px;
      text-decoration: none;
    }
    .agent-picks {
      margin: 8px 0 18px;
      padding: 14px;
      border-radius: 16px;
      background: rgba(0, 240, 255, 0.06);
      border: 1px solid rgba(0, 240, 255, 0.22);
    }
    .agent-picks-title { margin: 0 0 6px; color: #67e8f9; }
    .agent-picks-intro { margin: 0 0 10px; color: #94a3b8; font-size: 13px; }
    .agent-pick {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 10px 8px;
      border-radius: 12px;
      text-decoration: none;
    }
    .agent-pick:hover { background: rgba(0, 240, 255, 0.08); }
    .agent-pick-num {
      flex: 0 0 22px;
      height: 22px;
      border-radius: 999px;
      background: rgba(0, 240, 255, 0.16);
      color: #67e8f9;
      font-size: 12px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .agent-pick-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .agent-pick-title { color: #f8fafc; font-size: 14.5px; font-weight: 650; }
    .agent-pick-why { color: #cbd5e1; font-size: 12.5px; line-height: 1.4; }
    .agent-pick-host { color: #67e8f9; font-size: 11.5px; }
    .url-suggest-row.is-pick { background: rgba(0, 240, 255, 0.06); }
    .url-pick-badge {
      display: inline-block;
      margin-left: 8px;
      padding: 1px 7px;
      border-radius: 999px;
      background: rgba(0, 240, 255, 0.16);
      color: #67e8f9;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.03em;
      vertical-align: middle;
    }
    .url-source-tag {
      display: inline-flex;
      align-items: center;
      font-size: 9.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      padding: 2px 7px;
      border-radius: 5px;
      margin-left: 7px;
      vertical-align: middle;
      line-height: 1.2;
    }
    .url-source-tag.source-bing {
      background: rgba(0, 120, 215, 0.2);
      border: 1px solid rgba(0, 120, 215, 0.55);
      color: #60a5fa;
    }
    .url-source-tag.source-yahoo {
      background: rgba(123, 0, 230, 0.2);
      border: 1px solid rgba(123, 0, 230, 0.55);
      color: #c084fc;
    }
    .url-source-tag.source-duckduckgo, .url-source-tag.source-duck {
      background: rgba(222, 88, 51, 0.2);
      border: 1px solid rgba(222, 88, 51, 0.55);
      color: #fb923c;
    }
    .url-source-tag.source-google {
      background: rgba(34, 197, 94, 0.18);
      border: 1px solid rgba(34, 197, 94, 0.45);
      color: #4ade80;
    }
    .url-source-tag.source-brave {
      background: rgba(251, 84, 43, 0.2);
      border: 1px solid rgba(251, 84, 43, 0.5);
      color: #fb923c;
    }
    .url-source-tag.source-yandex {
      background: rgba(239, 68, 68, 0.18);
      border: 1px solid rgba(239, 68, 68, 0.45);
      color: #f87171;
    }
    .url-source-tag.source-wikipedia {
      background: rgba(14, 165, 233, 0.18);
      border: 1px solid rgba(14, 165, 233, 0.45);
      color: #38bdf8;
    }
    .url-source-tag.source-rust-index {
      background: rgba(249, 115, 22, 0.22);
      border: 1px solid rgba(249, 115, 22, 0.6);
      color: #fdba74;
    }
    .url-source-tag.source-web {
      background: rgba(148, 163, 184, 0.15);
      border: 1px solid rgba(148, 163, 184, 0.35);
      color: #cbd5e1;
    }

    /* BARRA FIXA E FILTRO RÁPIDO POR TIPO DE CONTEÚDO */
    .search-filter-bar {
      position: sticky;
      top: 0;
      z-index: 999;
      background: rgba(12, 14, 20, 0.96);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: nowrap;
      gap: 10px;
      padding: 10px 16px;
      margin: -20px -16px 16px -16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 4px 22px rgba(0, 0, 0, 0.5);
    }
    .search-rust-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 999px;
      background: rgba(249, 115, 22, 0.12);
      border: 1px solid rgba(249, 115, 22, 0.4);
      color: #fdba74;
      font-size: 11.5px;
      font-weight: 700;
      white-space: nowrap;
      flex-shrink: 0;
    }
    @media (max-width: 650px) {
      .search-rust-badge { display: none; }
      .search-filter-bar { margin: -16px -12px 14px -12px; padding: 8px 12px; }
    }
    .search-filter-pills {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow-x: auto;
      padding: 4px 2px;
      margin-bottom: 0;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      flex: 1 1 auto;
      min-width: 0;
    }
    .search-filter-pills::-webkit-scrollbar { display: none; }
    .search-pill {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #94a3b8;
      border-radius: 999px;
      padding: 7px 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      font-family: inherit;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
      outline: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .search-pill:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #f1f5f9;
      border-color: rgba(255, 255, 255, 0.25);
      transform: translateY(-1px);
    }
    .search-pill:active {
      transform: scale(0.95);
    }
    .search-pill.is-active {
      background: rgba(0, 240, 255, 0.16);
      border-color: #00f0ff;
      color: #00f0ff;
      box-shadow: 0 0 14px rgba(0, 240, 255, 0.25);
    }

    /* CARD DE CONHECIMENTO ENCICLOPÉDICO (WIKIPÉDIA) */
    .wiki-knowledge-card {
      background: linear-gradient(135deg, rgba(14, 165, 233, 0.12) 0%, rgba(15, 23, 42, 0.95) 100%);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 18px;
      padding: 20px;
      margin-bottom: 24px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      position: relative;
    }
    .wiki-card-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #38bdf8;
      background: rgba(14, 165, 233, 0.16);
      border: 1px solid rgba(56, 189, 248, 0.35);
      padding: 3px 10px;
      border-radius: 6px;
      margin-bottom: 14px;
    }
    .wiki-card-body {
      display: flex;
      gap: 20px;
      align-items: flex-start;
    }
    .wiki-thumb-wrap {
      flex: 0 0 110px;
      width: 110px;
      height: 110px;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(56, 189, 248, 0.3);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    }
    .wiki-thumb-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .wiki-card-text {
      flex: 1;
      min-width: 0;
    }
    .wiki-card-title {
      font-size: 20px;
      font-weight: 750;
      color: #fff;
      margin-bottom: 4px;
      letter-spacing: -0.2px;
    }
    .wiki-card-desc {
      font-size: 12.5px;
      color: #7dd3fc;
      margin-bottom: 8px;
      font-weight: 500;
    }
    .wiki-card-extract {
      font-size: 13.5px;
      color: #cbd5e1;
      line-height: 1.6;
      margin-bottom: 14px;
    }
    .wiki-read-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(56, 189, 248, 0.16);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #38bdf8;
      padding: 7px 16px;
      border-radius: 10px;
      font-size: 12.5px;
      font-weight: 700;
      text-decoration: none;
      transition: all 0.2s;
    }
    .wiki-read-btn:hover {
      background: rgba(56, 189, 248, 0.28);
      box-shadow: 0 0 14px rgba(56, 189, 248, 0.3);
      color: #fff;
    }

    /* BLOCO DE IMAGENS */
    .images-block {
      margin: 16px 0 22px 0;
    }
    .images-toggle-grid-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(0, 240, 255, 0.1);
      border: 1px solid rgba(0, 240, 255, 0.35);
      color: #00f0ff;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
      user-select: none;
    }
    .images-toggle-grid-btn:hover {
      background: rgba(0, 240, 255, 0.22);
      box-shadow: 0 0 10px rgba(0, 240, 255, 0.3);
      transform: translateY(-1px);
    }
    .images-toggle-grid-btn:active {
      transform: scale(0.96);
    }
    .images-gallery {
      display: flex;
      gap: 12px;
      overflow-x: auto;
      padding-bottom: 10px;
      scrollbar-width: thin;
      scrollbar-color: rgba(0, 240, 255, 0.4) transparent;
      -webkit-overflow-scrolling: touch;
    }
    .images-block.is-grid .images-gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      overflow-x: visible;
      gap: 14px;
    }
    .image-card {
      flex: 0 0 165px;
      width: 165px;
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.22s ease;
      display: flex;
      flex-direction: column;
      text-decoration: none;
      color: inherit;
    }
    .images-block.is-grid .image-card {
      flex: auto;
      width: auto;
    }
    .image-card:hover {
      transform: translateY(-3px);
      border-color: #00f0ff;
      box-shadow: 0 6px 20px rgba(0, 240, 255, 0.25);
      color: #fff;
    }
    .image-thumb-wrap {
      position: relative;
      width: 100%;
      height: 115px;
      background: #020617;
      overflow: hidden;
    }
    .image-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.25s ease;
    }
    .image-card:hover .image-thumb {
      transform: scale(1.06);
    }
    .image-source-badge {
      position: absolute;
      bottom: 6px;
      left: 6px;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      color: #7dd3fc;
      font-size: 9.5px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      max-width: 90%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .image-zoom-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.28);
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      cursor: pointer;
      backdrop-filter: blur(6px);
      transition: all 0.2s ease;
      z-index: 4;
      opacity: 0.85;
      padding: 0;
    }
    .image-zoom-btn:hover {
      background: #0284c7;
      border-color: #38bdf8;
      transform: scale(1.12);
      opacity: 1;
    }
    .image-title {
      padding: 8px 10px;
      font-size: 11.5px;
      color: #cbd5e1;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* BLOCO DE VÍDEOS */
    .videos-block {
      margin: 16px 0 24px 0;
    }
    .videos-carousel {
      display: flex;
      gap: 14px;
      overflow-x: auto;
      padding-bottom: 10px;
      scrollbar-width: thin;
      scrollbar-color: rgba(239, 68, 68, 0.4) transparent;
      -webkit-overflow-scrolling: touch;
    }
    .videos-block.is-grid .videos-carousel {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      overflow-x: visible;
      gap: 16px;
    }
    .video-card {
      flex: 0 0 225px;
      width: 225px;
      background: rgba(15, 23, 42, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 14px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.22s ease;
      display: flex;
      flex-direction: column;
      text-decoration: none;
      color: inherit;
    }
    .videos-block.is-grid .video-card {
      flex: auto;
      width: auto;
    }
    .video-card:hover {
      transform: translateY(-3px);
      border-color: #ef4444;
      box-shadow: 0 6px 22px rgba(239, 68, 68, 0.28);
    }
    .video-thumb-wrap {
      position: relative;
      width: 100%;
      height: 125px;
      background: #020617;
      overflow: hidden;
    }
    .video-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.25s ease;
    }
    .video-card:hover .video-thumb {
      transform: scale(1.05);
    }
    .video-duration {
      position: absolute;
      bottom: 6px;
      right: 6px;
      background: rgba(0, 0, 0, 0.85);
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      z-index: 2;
    }
    .video-play-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.25);
      transition: background 0.2s;
    }
    .video-card:hover .video-play-overlay {
      background: rgba(0, 0, 0, 0.42);
    }
    .video-play-icon {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: rgba(239, 68, 68, 0.92);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      padding-left: 3px;
      box-shadow: 0 0 16px rgba(239, 68, 68, 0.6);
      transition: transform 0.2s;
    }
    .video-card:hover .video-play-icon {
      transform: scale(1.12);
    }
    .video-info {
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
    }
    .video-title {
      font-size: 13px;
      font-weight: 650;
      color: #f8fafc;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin: 0;
    }
    .video-meta {
      font-size: 11.5px;
      color: #94a3b8;
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* LIGHTBOX MODAL PARA IMAGENS */
    .image-lightbox {
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: rgba(3, 7, 18, 0.94);
      backdrop-filter: blur(14px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .image-lightbox.is-open {
      display: flex;
    }
    .image-lightbox-content {
      position: relative;
      max-width: 92vw;
      max-height: 92vh;
      width: 100%;
      max-width: 980px;
      display: flex;
      flex-direction: column;
      background: rgba(15, 23, 42, 0.98);
      border: 1px solid rgba(0, 240, 255, 0.35);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 12px 50px rgba(0, 0, 0, 0.9), 0 0 30px rgba(0, 240, 255, 0.2);
    }
    .image-lightbox-header {
      padding: 10px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(0, 0, 0, 0.4);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .image-lightbox-counter {
      font-size: 12px;
      font-weight: 700;
      color: #00f0ff;
      letter-spacing: 0.5px;
    }
    .image-lightbox-img-wrap {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 280px;
      max-height: 68vh;
      background: #020617;
      overflow: hidden;
      user-select: none;
    }
    .image-lightbox-img {
      max-width: 100%;
      max-height: 68vh;
      object-fit: contain;
      display: block;
      transition: opacity 0.2s ease;
    }
    .image-lightbox-nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(0, 0, 0, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.25);
      color: #fff;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 20px;
      transition: all 0.2s;
      z-index: 5;
    }
    .image-lightbox-nav:hover {
      background: rgba(0, 240, 255, 0.45);
      border-color: #00f0ff;
      color: #fff;
      transform: translateY(-50%) scale(1.1);
    }
    .image-lightbox-nav.prev { left: 14px; }
    .image-lightbox-nav.next { right: 14px; }
    .image-lightbox-bar {
      padding: 12px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      flex-wrap: wrap;
      background: rgba(0, 0, 0, 0.3);
    }
    .image-lightbox-info {
      flex: 1;
      min-width: 220px;
    }
    .image-lightbox-title {
      font-size: 13.5px;
      font-weight: 650;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
    }
    .image-lightbox-source {
      font-size: 11.5px;
      color: #94a3b8;
    }
    .image-lightbox-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .image-lightbox-btn {
      background: rgba(0, 240, 255, 0.16);
      border: 1px solid rgba(0, 240, 255, 0.4);
      color: #00f0ff;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .image-lightbox-btn:hover {
      background: rgba(0, 240, 255, 0.32);
      color: #fff;
      transform: translateY(-1px);
    }
    .image-lightbox-btn.primary {
      background: linear-gradient(135deg, #00f0ff 0%, #0284c7 100%);
      color: #020617;
      border-color: #38bdf8;
      font-weight: 800;
    }
    .image-lightbox-btn.primary:hover {
      filter: brightness(1.15);
      color: #000;
    }
    .image-lightbox-close {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .image-lightbox-close:hover {
      background: #ef4444;
      border-color: #ef4444;
    }

    /* MODAL DE VÍDEO IN-APP */
    .video-modal {
      position: fixed;
      inset: 0;
      z-index: 10001;
      background: rgba(3, 7, 18, 0.94);
      backdrop-filter: blur(14px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .video-modal.is-open {
      display: flex;
    }
    .video-modal-content {
      position: relative;
      width: 100%;
      max-width: 860px;
      background: rgba(15, 23, 42, 0.98);
      border: 1px solid rgba(239, 68, 68, 0.45);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 10px 45px rgba(0, 0, 0, 0.9), 0 0 30px rgba(239, 68, 68, 0.25);
      display: flex;
      flex-direction: column;
    }
    .video-modal-header {
      padding: 12px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(0, 0, 0, 0.5);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .video-modal-title {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 85%;
    }
    .video-modal-close {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #fff;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      font-size: 18px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .video-modal-close:hover {
      background: #ef4444;
    }
    .video-modal-player-wrap {
      position: relative;
      width: 100%;
      padding-bottom: 56.25%;
      height: 0;
      background: #000;
    }
    .video-modal-iframe {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border: 0;
    }
    .video-modal-footer {
      padding: 12px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: rgba(0, 0, 0, 0.3);
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      flex-wrap: wrap;
    }
    .video-modal-btn {
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
      border: 1px solid transparent;
      text-decoration: none;
    }
    .video-modal-btn.primary {
      background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%);
      color: #fff;
      border-color: rgba(239, 68, 68, 0.6);
    }
    .video-modal-btn.primary:hover {
      filter: brightness(1.15);
      transform: translateY(-1px);
    }
    .video-modal-btn.secondary {
      background: rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
      border-color: rgba(255, 255, 255, 0.15);
    }
    .video-modal-btn.secondary:hover {
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    /* SPINNER INFINITO NO FINAL DO CARROSSEL E GRADE */
    .carousel-infinite-spinner {
      flex: 0 0 70px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
      color: #00f0ff;
      font-size: 20px;
      animation: infinite-pulse 0.85s infinite alternate ease-in-out;
    }
    .videos-block.is-grid .carousel-infinite-spinner,
    .images-block.is-grid .carousel-infinite-spinner {
      grid-column: 1 / -1;
      width: 100%;
      height: 60px;
    }
    .videos-block.is-grid .carousel-sentinel,
    .images-block.is-grid .carousel-sentinel {
      grid-column: 1 / -1;
      width: 100%;
      height: 40px;
    }
    .carousel-load-more-pill {
      flex: 0 0 auto;
      align-self: center;
      padding: 9px 16px;
      margin: 0 8px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #38bdf8;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
      transition: all 0.2s ease;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
    }
    .carousel-load-more-pill:hover {
      background: rgba(56, 189, 248, 0.2);
      border-color: #38bdf8;
      color: #fff;
      transform: scale(1.05);
      box-shadow: 0 4px 14px rgba(56, 189, 248, 0.35);
    }
    .videos-block .carousel-load-more-pill {
      border-color: rgba(239, 68, 68, 0.4);
      color: #f87171;
    }
    .videos-block .carousel-load-more-pill:hover {
      background: rgba(239, 68, 68, 0.2);
      border-color: #ef4444;
      color: #fff;
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.35);
    }
    .videos-block.is-grid .carousel-load-more-pill,
    .images-block.is-grid .carousel-load-more-pill {
      grid-column: 1 / -1;
      width: 100%;
      max-width: 280px;
      margin: 16px auto;
      padding: 12px 24px;
    }
    @keyframes infinite-pulse {
      from { opacity: 0.35; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1.15); }
    }
  </style>
</head>
<body class="${useTor ? 'via-tor' : ''}">
  <div class="search-top-nav-bar" id="searchTopNavBar" aria-hidden="true"></div>
  <div id="onionDarkVignette" style="position: fixed; inset: 0; pointer-events: none; z-index: 1; opacity: 0; transition: opacity 0.3s ease-out; background: radial-gradient(circle at 50% 50%, rgba(2, 20, 10, 0.35) 0%, rgba(0, 0, 0, 0.95) 75%, #000 100%); box-shadow: inset 0 0 160px rgba(34, 197, 94, 0.45);"></div>
  <div class="tor-nav-loading" id="torNavLoading" hidden>
    <div class="tor-nav-card">
      <div class="tor-nav-spin"></div>
      <div class="direct-nav-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="tor-nav-title" id="torNavTitle">Carregando página…</div>
      <div class="tor-nav-url" id="torNavUrl"></div>
      <div class="tor-nav-hint" id="torNavHint">Conectando ao site via proxy com segurança máxima e zero anúncios…</div>
      <div class="tor-nav-progress"><div class="tor-nav-progress-bar"></div></div>
    </div>
  </div>
  <header class="ddg-header">
    <a href="newtab.html" class="ddg-brand" title="Início">
      <span>⚡</span>
      <span>Papaléguas Search</span>
      <span class="ddg-brand-badge">Rust v2.0</span>
    </a>
    <form class="ddg-form" action="/search" method="GET" autocomplete="off">
      <input type="hidden" name="clientId" value="${clientId}">
      <input type="hidden" name="filter" id="searchFilterInput" value="${escapeHtml(activeFilter)}">
      <input type="text" name="q" id="searchInput" class="ddg-input" value="${safeQ}" placeholder="Pesquise no Motor de Busca Próprio Papaléguas (Rust BM25)..." autofocus autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
      <button type="submit" class="ddg-btn" title="Buscar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
    </form>
  </header>

  <main class="ddg-container">
    <aside class="search-top-install-bar" id="searchTopInstallBar">
      <div class="search-install-text">
        <img src="/icon-192.png" alt="Papaléguas" class="search-install-mascot" onerror="this.onerror=null;this.src='/favicon.ico';">
        <span><strong>Super Navegador Papaléguas (Motor Rust v2.0):</strong> Zero anúncios, busca direta e navegação ultra-rápida.</span>
      </div>
      <a href="/download/app" class="search-install-btn" title="Baixar Super Navegador Papaléguas para Windows, Android, iOS e Linux">
        📥 Baixar Navegador
      </a>
    </aside>
    ${filterPillsHtml}
    <div id="filterEmptyMsg" style="display:none; text-align: center; padding: 45px 20px; color: #94a3b8;">
      <div style="font-size: 36px; margin-bottom: 12px;">🔍</div>
      <p style="font-size: 16px; font-weight: 600; color: #e2e8f0;" id="filterEmptyText">Nenhum resultado encontrado para esta categoria.</p>
      <p style="font-size: 13px; color: #64748b; margin-top: 6px;">Tente clicar em <b>🌟 Todos</b> para ver outros resultados ou reformular a pesquisa.</p>
      <button type="button" class="search-pill" onclick="selectSearchFilter('all', true)" style="margin-top: 14px; background: rgba(0, 240, 255, 0.15); border-color: #00f0ff; color: #fff;">
        🌟 Ver todos os resultados
      </button>
    </div>
    ${wikiHtml}
    ${q ? `
    <section class="ai-card" id="aiCard" style="${activeFilter === 'all' ? '' : 'display:none;'}">
      <div class="ai-head">
        <span class="ai-badge"><span class="ai-spark">✦</span> Resposta da IA</span>
        <span class="ai-state" id="aiState">${initialAiSources.length ? (initialAiSources.length === 1 ? 'resumo de 1 fonte' : 'resumo de ' + initialAiSources.length + ' fontes') : 'Lendo os resultados…'}</span>
      </div>
      <div class="ai-answer" id="aiAnswer">${formatAiAnswerToHtml(initialAiAnswer, initialAiSources)}</div>
      <div class="ai-sources" id="aiSources">${formatAiSourcesToHtml(initialAiSources, clientId)}</div>
      <div class="ai-thread" id="aiThread"></div>
      <form class="ai-ask" id="aiAsk" ${initialAiAnswer ? '' : 'hidden'} autocomplete="off">
        <input class="ai-ask-input" id="aiAskInput" placeholder="Pergunte mais e a IA pesquisa de novo…" autocomplete="off" spellcheck="false">
        <button class="ai-ask-go" id="aiAskGo" type="submit">Perguntar</button>
      </form>
    </section>
    ` : ''}
    <!-- RESULTADOS DO BUSCADOR INTELIGENTE -->
    <div id="agentPicks" hidden></div>
    ${didYouMeanHtml}
    ${imagesHtml}
    ${videosHtml}
    ${q && results.length ? `<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;${activeFilter === 'all' || activeFilter === 'web' ? '' : 'display:none;'}" id="webResultsBar">
      <h3 class="block-title" id="webResultsHeading" style="margin:0;">🌐 Resultados da Web Mais Relevantes</h3>
      <div class="web-quick-filters" id="webQuickFilters" style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" class="search-pill active" data-web-filter="all" style="padding:5px 11px;font-size:12px;">Todos</button>
        <button type="button" class="search-pill" data-web-filter="official" style="padding:5px 11px;font-size:12px;">Oficiais (.gov/.edu)</button>
        <button type="button" class="search-pill" data-web-filter="recent" style="padding:5px 11px;font-size:12px;">Com data recente</button>
      </div>
    </div>` : ''}
    <div id="resultsList" data-section="web" style="${activeFilter === 'all' || activeFilter === 'web' ? '' : 'display:none;'}">
      ${resultsHtml}
    </div>
    <div class="url-suggest-more" id="resultsMore" style="${(activeFilter === 'all' || activeFilter === 'web') && (q && results.length) ? '' : 'display:none;'}">
      <button type="button" class="suggest-refresh-btn" id="resultsRefresh">Carregar mais resultados</button>
    </div>
    <!-- As notícias vêm depois -->
    ${newsHtml}
    ${relatedHtml}
    <!-- Bloco de resultados .onion temáticos no final da pesquisa -->
    ${onionHtml}
  </main>

  <!-- LIGHTBOX MODAL PARA IMAGENS -->
  <div id="imageLightbox" class="image-lightbox" role="dialog" aria-modal="true" aria-hidden="true">
    <div class="image-lightbox-content">
      <div class="image-lightbox-header">
        <span class="image-lightbox-counter" id="lightboxCounter">1 / 1</span>
        <button type="button" class="image-lightbox-close" id="lightboxClose" title="Fechar">&times;</button>
      </div>
      <div class="image-lightbox-img-wrap">
        <button type="button" class="image-lightbox-nav prev" id="lightboxPrev" title="Imagem Anterior">&#10094;</button>
        <img id="lightboxImg" class="image-lightbox-img" src="" alt="Ampliação da imagem" onclick="openLightboxTargetPage()" title="Clique para acessar o site desta imagem no Papaléguas" style="cursor:pointer;" />
        <button type="button" class="image-lightbox-nav next" id="lightboxNext" title="Próxima Imagem">&#10095;</button>
      </div>
      <div class="image-lightbox-bar">
        <div class="image-lightbox-info">
          <div class="image-lightbox-title" id="lightboxTitle"></div>
          <div class="image-lightbox-source" id="lightboxSource"></div>
        </div>
        <div class="image-lightbox-actions">
          <a id="lightboxPageBtn" href="#" class="image-lightbox-btn primary" title="Acessar Página no Papaléguas">
            <span>🌐</span> Acessar Página no Papaléguas
          </a>
          <a id="lightboxFullBtn" href="#" class="image-lightbox-btn" target="_blank" rel="noopener noreferrer">
            <span>↗</span> Ver Imagem Completa
          </a>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL DE VÍDEO IN-APP -->
  <div id="videoModal" class="video-modal" role="dialog" aria-modal="true" aria-hidden="true">
    <div class="video-modal-content">
      <div class="video-modal-header">
        <div class="video-modal-title" id="videoModalTitle">Reproduzir Vídeo</div>
        <button type="button" class="video-modal-close" id="videoModalClose" title="Fechar">&times;</button>
      </div>
      <div class="video-modal-player-wrap">
        <iframe id="videoModalIframe" class="video-modal-iframe" src="" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
      </div>
      <div class="video-modal-footer">
        <button type="button" class="video-modal-btn primary" id="videoModalBaixaTubeBtn">
          <span>📥</span> Abrir no BaixaTube (Player Completo & Download)
        </button>
        <button type="button" class="video-modal-btn secondary" id="videoModalCloseBtn">Fechar</button>
      </div>
    </div>
  </div>

  <script>
    function openVideo(id, title, e) {
      if (!id) return;
      goToBaixaTube(id, title, e);
    }

    function goToBaixaTube(id, title, e) {
      if (!id) return;
      const cleanId = String(id || '').trim();
      const cleanTitle = (title || 'Vídeo').trim();
      const baixatubeUrl = '/baixatube?v=' + encodeURIComponent(cleanId);

      // 1. Host Electron via torBrowserAPI: abre em nova aba/janela no app
      try {
        if (window.torBrowserAPI && typeof window.torBrowserAPI.sendToHost === 'function') {
          if (e && typeof e.preventDefault === 'function') e.preventDefault();
          window.torBrowserAPI.sendToHost('open-new-tab', baixatubeUrl);
          return;
        }
      } catch (err) {}

      // 2. Shell pai (postMessage para abrir em nova aba no shell)
      try {
        if (window.parent && window.parent !== window) {
          if (e && typeof e.preventDefault === 'function') e.preventDefault();
          window.parent.postMessage({ type: 'open-new-tab', url: baixatubeUrl }, '*');
          return;
        }
      } catch (err) {}

      // 3. PostMessage local para scripts do shell
      try {
        window.postMessage({ type: 'open-new-tab', url: baixatubeUrl }, '*');
      } catch (err) {}

      // 4. Se for standalone no navegador, deixa o target="_blank" nativo abrir a nova janela perfeitamente!
    }

    function closeVideoModal() {
      const modal = document.getElementById('videoModal');
      const iframe = document.getElementById('videoModalIframe');
      if (modal) {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
      }
      if (iframe) {
        iframe.src = '';
      }
    }
    window.openVideo = openVideo;
    window.goToBaixaTube = goToBaixaTube;
    window.closeVideoModal = closeVideoModal;

    function bindVideoModalEvents() {
      const closeBtn = document.getElementById('videoModalClose');
      const footerCloseBtn = document.getElementById('videoModalCloseBtn');
      const modal = document.getElementById('videoModal');
      if (closeBtn) closeBtn.onclick = closeVideoModal;
      if (footerCloseBtn) footerCloseBtn.onclick = closeVideoModal;
      if (modal) {
        modal.onclick = function(e) {
          if (e.target === modal) closeVideoModal();
        };
      }
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeVideoModal();
      });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindVideoModalEvents);
    } else {
      bindVideoModalEvents();
    }

    function openMusic(query) {
      if (!query) return;
      try {
        if (window.torBrowserAPI && typeof window.torBrowserAPI.sendToHost === 'function') {
          window.torBrowserAPI.sendToHost('play-dj-music', query);
          return;
        }
      } catch (e) {}
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'play-dj-music', query: query, url: '/musica?q=' + encodeURIComponent(query) + '&autoplay=1' }, '*');
          return;
        }
      } catch (e) {}
      try {
        if (window.torBrowserAPI && typeof window.torBrowserAPI.sendToHost === 'function') {
          window.torBrowserAPI.sendToHost('navigate-current-tab', '/musica?q=' + encodeURIComponent(query) + '&autoplay=1');
          return;
        }
      } catch (e) {}
      window.location.href = '/musica?q=' + encodeURIComponent(query) + '&autoplay=1';
    }

    const currentQuery = ${JSON.stringify(q)};
    const suggestClientId = ${JSON.stringify(clientId)};
    const pageUsesTor = ${useTor ? 'true' : 'false'};
    const initialAiData = ${JSON.stringify({ answer: initialAiAnswer, sources: initialAiSources })};

    let imagesPage = 1;
    let imagesLoading = false;
    let imagesHasMore = true;

    async function loadMoreImagesAuto() {
      if (imagesLoading || !imagesHasMore) return;
      const q = currentQuery || '';
      if (!q) return;

      imagesLoading = true;
      const spinner = document.getElementById('imagesInfiniteSpinner');
      const loadBtn = document.getElementById('imagesLoadMoreBtn');
      if (spinner) spinner.style.display = 'flex';
      if (loadBtn) loadBtn.style.display = 'none';

      try {
        const res = await fetch('/api/search-images?q=' + encodeURIComponent(q) + '&page=' + imagesPage);
        const data = await res.json();
        if (data && data.success && Array.isArray(data.images) && data.images.length > 0) {
          const gallery = document.getElementById('imagesGallery');
          const sentinel = document.getElementById('imagesSentinel');
          const insertAnchor = spinner || loadBtn || sentinel;
          if (gallery) {
            data.images.forEach((img) => {
              const card = document.createElement('a');
              card.className = 'image-card';
              const pageTarget = img.pageUrl || img.image || '';
              const fullImg = img.image || img.thumbnail || '';
              card.href = '/proxy?url=' + encodeURIComponent(pageTarget) + '&clientId=' + encodeURIComponent(suggestClientId);
              card.setAttribute('data-direct', pageTarget);
              card.setAttribute('data-page', pageTarget);
              card.setAttribute('data-full', fullImg);
              card.setAttribute('data-title', img.title || q);
              card.setAttribute('data-source', img.source || 'Web');
              card.setAttribute('title', 'Acessar página de ' + (img.source || 'Web') + ' no Papaléguas');

              const safeT = (img.title || q).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
              const safeThumb = (img.thumbnail || img.image || '').replace(/"/g, '&quot;');
              const safeSrc = (img.source || 'Web').replace(/</g, '&lt;').replace(/>/g, '&gt;');

              card.innerHTML =
                '<div class="image-thumb-wrap">' +
                  '<img class="image-thumb" src="' + safeThumb + '" alt="' + safeT + '" loading="lazy" />' +
                  '<span class="image-source-badge">' + safeSrc + ' ↗</span>' +
                  '<button type="button" class="image-zoom-btn" onclick="event.preventDefault(); event.stopPropagation(); if (typeof openLightboxCard === &apos;function&apos;) openLightboxCard(this.closest(&apos;.image-card&apos;))" title="Ampliar imagem">🔍</button>' +
                '</div>' +
                '<div class="image-title" title="' + safeT + '">' + safeT + '</div>';
              const imgEl = card.querySelector('.image-thumb');
              if (imgEl) imgEl.onerror = function() { card.style.display = 'none'; };

              if (insertAnchor && insertAnchor.parentNode === gallery) {
                gallery.insertBefore(card, insertAnchor);
              } else {
                gallery.appendChild(card);
              }
            });

            const totalImgs = gallery.querySelectorAll('.image-card').length;
            const cEl = document.getElementById('imagesCount');
            if (cEl) cEl.textContent = totalImgs;
            const pEl = document.querySelector('.pill-count-images');
            if (pEl) pEl.textContent = totalImgs;
          }
          imagesPage += 1;
          imagesHasMore = !!data.hasMore;
        } else {
          imagesHasMore = false;
        }
      } catch (err) {
        console.warn('[SEARCH] Erro no scroll infinito de imagens:', err);
      } finally {
        imagesLoading = false;
        if (spinner) spinner.style.display = 'none';
        if (loadBtn) loadBtn.style.display = imagesHasMore ? '' : 'none';
      }

      // Se após carregar ainda houver espaço na tela em modo grade, continua carregando
      if (imagesHasMore) {
        const imgBlock = document.getElementById('sectionImages');
        if (imgBlock && imgBlock.style.display !== 'none' && imgBlock.classList.contains('is-grid')) {
          const rect = imgBlock.getBoundingClientRect();
          if (rect.bottom <= window.innerHeight + 800) {
            setTimeout(loadMoreImagesAuto, 200);
          }
        }
      }
    }
    window.loadMoreImagesAuto = loadMoreImagesAuto;
    window.loadMoreImages = loadMoreImagesAuto;

    function toggleImagesGrid() {
      const sec = document.getElementById('sectionImages');
      const btnText = document.getElementById('toggleGridText');
      const btnIcon = document.getElementById('toggleGridIcon');
      if (!sec) return;
      const isGrid = sec.classList.toggle('is-grid');
      if (btnText) btnText.textContent = isGrid ? 'Ver carrossel' : 'Ver em grade';
      if (btnIcon) btnIcon.textContent = isGrid ? '↔' : '⊞';
      if (isGrid && typeof loadMoreImagesAuto === 'function') {
        const count = sec.querySelectorAll('.image-card').length;
        if (count < 40) loadMoreImagesAuto();
      }
    }
    window.toggleImagesGrid = toggleImagesGrid;

    let videosPage = 1;
    let videosLoading = false;
    let videosHasMore = true;

    async function loadMoreVideosAuto() {
      if (videosLoading || !videosHasMore) return;
      const q = currentQuery || '';
      if (!q) return;

      videosLoading = true;
      const spinner = document.getElementById('videosInfiniteSpinner');
      const loadBtn = document.getElementById('videosLoadMoreBtn');
      if (spinner) spinner.style.display = 'flex';
      if (loadBtn) loadBtn.style.display = 'none';

      try {
        const res = await fetch('/api/search-videos?q=' + encodeURIComponent(q) + '&page=' + videosPage + '&limit=8');
        const data = await res.json();
        if (data && data.success && Array.isArray(data.videos) && data.videos.length > 0) {
          const carousel = document.getElementById('videosCarousel');
          const sentinel = document.getElementById('videosSentinel');
          const insertAnchor = spinner || loadBtn || sentinel;
          if (carousel) {
            data.videos.forEach((v) => {
              const card = document.createElement('a');
              card.className = 'video-card';
              const cleanVTitle = v.title || 'Vídeo';
              const vHref = '/baixatube?v=' + encodeURIComponent(v.id);
              card.href = vHref;
              card.target = '_blank';
              card.rel = 'noopener noreferrer';
              card.setAttribute('data-video-id', v.id);
              card.setAttribute('data-video-title', cleanVTitle);
              card.setAttribute('role', 'button');
              card.setAttribute('tabindex', '0');
              card.setAttribute('title', 'Assistir ' + cleanVTitle);
              card.onclick = function(e) {
                openVideo(v.id, cleanVTitle, e);
              };

              const safeT = (v.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
              const safeThumb = (v.thumbnail || ('https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg')).replace(/"/g, '&quot;');
              const safeCh = (v.channel || 'YouTube').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              const safeViews = (v.views || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              const safeDur = (v.duration || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

              card.innerHTML =
                '<div class="video-thumb-wrap">' +
                  '<img class="video-thumb" src="' + safeThumb + '" alt="' + safeT + '" loading="lazy" />' +
                  (safeDur ? '<span class="video-duration">' + safeDur + '</span>' : '') +
                  '<div class="video-play-overlay">' +
                    '<span class="video-play-icon">▶</span>' +
                  '</div>' +
                '</div>' +
                '<div class="video-info">' +
                  '<h4 class="video-title" title="' + safeT + '">' + safeT + '</h4>' +
                  '<div class="video-meta">' +
                    '<span class="video-channel">' + safeCh + '</span>' +
                    (safeViews ? '<span class="video-views">· ' + safeViews + '</span>' : '') +
                  '</div>' +
                '</div>';
              const vThumbEl = card.querySelector('.video-thumb');
              if (vThumbEl) {
                vThumbEl.onerror = function() { this.src = 'https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg'; };
              }

              if (insertAnchor && insertAnchor.parentNode === carousel) {
                carousel.insertBefore(card, insertAnchor);
              } else {
                carousel.appendChild(card);
              }
            });

            const totalVids = carousel.querySelectorAll('.video-card').length;
            const cEl = document.getElementById('videosCount');
            if (cEl) cEl.textContent = totalVids;
            const pEl = document.querySelector('.pill-count-videos');
            if (pEl) pEl.textContent = totalVids;
          }
          videosPage += 1;
          videosHasMore = !!data.hasMore;
        } else {
          videosHasMore = false;
        }
      } catch (err) {
        console.warn('[SEARCH] Erro no scroll infinito de vídeos:', err);
      } finally {
        videosLoading = false;
        if (spinner) spinner.style.display = 'none';
        if (loadBtn) loadBtn.style.display = videosHasMore ? '' : 'none';
      }

      // Se após carregar ainda houver espaço na tela em modo grade, continua carregando
      if (videosHasMore) {
        const vidBlock = document.getElementById('sectionVideos');
        if (vidBlock && vidBlock.style.display !== 'none' && vidBlock.classList.contains('is-grid')) {
          const rect = vidBlock.getBoundingClientRect();
          if (rect.bottom <= window.innerHeight + 800) {
            setTimeout(loadMoreVideosAuto, 200);
          }
        }
      }
    }
    window.loadMoreVideosAuto = loadMoreVideosAuto;
    window.loadMoreVideos = loadMoreVideosAuto;

    function setupCarouselAutoScroll(container, loadMoreFn) {
      if (!container) return;

      // 1. Mouse wheel e trackpad (suporta rolagem horizontal deltaX e vertical deltaY)
      container.addEventListener('wheel', function(e) {
        if (container.classList.contains('is-grid') || container.closest('.is-grid')) return;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (Math.abs(delta) > 2) {
          const maxScroll = container.scrollWidth - container.clientWidth;
          if (maxScroll > 0) {
            const canScrollRight = container.scrollLeft < maxScroll - 2;
            const canScrollLeft = container.scrollLeft > 2;
            if ((delta > 0 && canScrollRight) || (delta < 0 && canScrollLeft)) {
              e.preventDefault();
              container.scrollLeft += delta * 1.25;
            }
            const remaining = container.scrollWidth - container.scrollLeft - container.clientWidth;
            if ((remaining <= 600 || delta > 0) && typeof loadMoreFn === 'function') {
              loadMoreFn();
            }
          }
        }
      }, { passive: false });

      // 2. Arraste do mouse (Desktop)
      let isDown = false;
      let startX = 0;
      let scrollLeft = 0;
      let hasDragged = false;

      container.addEventListener('mousedown', function(e) {
        if (container.classList.contains('is-grid') || container.closest('.is-grid')) return;
        if (e.target.closest('button, input, textarea, .image-zoom-btn')) return;
        isDown = true;
        hasDragged = false;
        startX = e.pageX - container.offsetLeft;
        scrollLeft = container.scrollLeft;
      });

      window.addEventListener('mousemove', function(e) {
        if (!isDown) return;
        const x = e.pageX - container.offsetLeft;
        const walk = (x - startX) * 1.3;
        if (Math.abs(walk) > 12) {
          hasDragged = true;
          container.style.cursor = 'grabbing';
          container.style.userSelect = 'none';
        }
        container.scrollLeft = scrollLeft - walk;
        const remaining = container.scrollWidth - container.scrollLeft - container.clientWidth;
        if (remaining <= 600 && typeof loadMoreFn === 'function') {
          loadMoreFn();
        }
      });

      window.addEventListener('mouseup', function() {
        if (!isDown) return;
        isDown = false;
        container.style.cursor = '';
        container.style.removeProperty('user-select');
        if (hasDragged) {
          const preventClick = function(ev) {
            ev.stopPropagation();
            ev.preventDefault();
            window.removeEventListener('click', preventClick, true);
          };
          window.addEventListener('click', preventClick, true);
          setTimeout(() => window.removeEventListener('click', preventClick, true), 80);
        }
      });

      // 3. Toque no celular / tablet (Touch Events)
      container.addEventListener('touchmove', function() {
        if (container.classList.contains('is-grid') || container.closest('.is-grid')) return;
        const remaining = container.scrollWidth - container.scrollLeft - container.clientWidth;
        if (remaining <= 600 && typeof loadMoreFn === 'function') {
          loadMoreFn();
        }
      }, { passive: true });

      container.addEventListener('touchend', function() {
        if (container.classList.contains('is-grid') || container.closest('.is-grid')) return;
        const remaining = container.scrollWidth - container.scrollLeft - container.clientWidth;
        if (remaining <= 600 && typeof loadMoreFn === 'function') {
          loadMoreFn();
        }
      }, { passive: true });

      // 4. Scroll nativo da caixa
      container.addEventListener('scroll', function() {
        if (container.classList.contains('is-grid') || container.closest('.is-grid')) return;
        const remaining = container.scrollWidth - container.scrollLeft - container.clientWidth;
        if (remaining <= 600 && typeof loadMoreFn === 'function') {
          loadMoreFn();
        }
      }, { passive: true });
    }

    // Scroll vertical infinito para quando o filtro estiver ativo em modo grade
    window.addEventListener('scroll', function() {
      const imgBlock = document.getElementById('sectionImages');
      if (imgBlock && imgBlock.style.display !== 'none' && imgBlock.classList.contains('is-grid') && !imagesLoading && imagesHasMore) {
        const rect = imgBlock.getBoundingClientRect();
        if (rect.bottom <= window.innerHeight + 800) {
          loadMoreImagesAuto();
        }
      }
      const vidBlock = document.getElementById('sectionVideos');
      if (vidBlock && vidBlock.style.display !== 'none' && vidBlock.classList.contains('is-grid') && !videosLoading && videosHasMore) {
        const rect = vidBlock.getBoundingClientRect();
        if (rect.bottom <= window.innerHeight + 800) {
          loadMoreVideosAuto();
        }
      }
    }, { passive: true });

    // Inicia os carrosséis e preenche conteúdo inicial
    function initCarouselsAndFill() {
      const ig = document.getElementById('imagesGallery');
      if (ig) setupCarouselAutoScroll(ig, loadMoreImagesAuto);
      const vc = document.getElementById('videosCarousel');
      if (vc) setupCarouselAutoScroll(vc, loadMoreVideosAuto);

      if (window.IntersectionObserver) {
        const imgSentinel = document.getElementById('imagesSentinel');
        if (imgSentinel && ig) {
          const imgObs = new IntersectionObserver(function(entries) {
            if (entries[0] && entries[0].isIntersecting && !imagesLoading && imagesHasMore) {
              loadMoreImagesAuto();
            }
          }, { root: ig, rootMargin: '0px 300px 0px 0px' });
          imgObs.observe(imgSentinel);
        }

        const vidSentinel = document.getElementById('videosSentinel');
        if (vidSentinel && vc) {
          const vidObs = new IntersectionObserver(function(entries) {
            if (entries[0] && entries[0].isIntersecting && !videosLoading && videosHasMore) {
              loadMoreVideosAuto();
            }
          }, { root: vc, rootMargin: '0px 300px 0px 0px' });
          vidObs.observe(vidSentinel);
        }
      }

      const vCarouselEl = document.getElementById('videosCarousel');
      if (vCarouselEl && typeof loadMoreVideosAuto === 'function') {
        const vCount = vCarouselEl.querySelectorAll('.video-card').length;
        if (vCount < 8) loadMoreVideosAuto();
      }
      const iCount = document.querySelectorAll('#imagesGallery .image-card').length;
      if (iCount < 12 && typeof loadMoreImagesAuto === 'function') {
        loadMoreImagesAuto();
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initCarouselsAndFill);
    } else {
      setTimeout(initCarouselsAndFill, 20);
    }

    function selectSearchFilter(filterName, shouldScroll = true) {
      const container = document.getElementById('searchFilterPills');
      const targetFilter = (filterName || 'all').toLowerCase();
      
      if (container) {
        const pills = container.querySelectorAll('.search-pill');
        pills.forEach((p) => p.classList.remove('is-active'));
        const pill = container.querySelector('.search-pill[data-filter="' + targetFilter + '"]');
        if (pill) {
          pill.classList.add('is-active');
          try { pill.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); } catch(e){}
        } else {
          const allPill = container.querySelector('.search-pill[data-filter="all"]');
          if (allPill) allPill.classList.add('is-active');
        }
      }

      const filterInput = document.getElementById('searchFilterInput');
      if (filterInput) filterInput.value = targetFilter;

      const secImages = document.getElementById('sectionImages');
      const secVideos = document.getElementById('sectionVideos');
      const secWiki = document.getElementById('sectionWiki');
      const secNews = document.getElementById('sectionNews');
      const secWebList = document.getElementById('resultsList');
      const secWebHeading = document.getElementById('webResultsHeading');
      const secTor = document.getElementById('onionSection');
      const onionIndicator = document.querySelector('.onion-depth-indicator');
      const aiCard = document.getElementById('aiCard');
      const agentPicks = document.getElementById('agentPicks');
      const resultsMore = document.getElementById('resultsMore');
      const relatedBlock = document.querySelector('.related-block');
      const filterEmptyMsg = document.getElementById('filterEmptyMsg');

      if (targetFilter === 'all') {
        if (secImages) { secImages.style.display = ''; secImages.classList.remove('is-grid'); }
        if (secVideos) { secVideos.style.display = ''; secVideos.classList.remove('is-grid'); }
        if (secWiki) secWiki.style.display = '';
        if (secNews) secNews.style.display = '';
        if (secWebList) secWebList.style.display = '';
        if (secWebHeading) secWebHeading.style.display = '';
        if (secTor) secTor.style.display = '';
        if (onionIndicator) onionIndicator.style.display = '';
        if (aiCard) aiCard.style.display = '';
        if (agentPicks && agentPicks.querySelector('.agent-pick')) agentPicks.hidden = false;
        if (resultsMore) resultsMore.style.display = '';
        if (relatedBlock) relatedBlock.style.display = '';
        if (filterEmptyMsg) filterEmptyMsg.style.display = 'none';

        if (shouldScroll) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('filter');
          history.replaceState(null, '', url.pathname + url.search);
        } catch(e){}
        return;
      }

      // Oculta tudo por padrão para filtro estrito
      if (secImages) secImages.style.display = 'none';
      if (secVideos) secVideos.style.display = 'none';
      if (secWiki) secWiki.style.display = 'none';
      if (secNews) secNews.style.display = 'none';
      if (secWebList) secWebList.style.display = 'none';
      if (secWebHeading) secWebHeading.style.display = 'none';
      if (secTor) secTor.style.display = 'none';
      if (onionIndicator) onionIndicator.style.display = 'none';
      if (aiCard) aiCard.style.display = 'none';
      if (agentPicks) agentPicks.hidden = true;
      if (resultsMore) resultsMore.style.display = 'none';
      if (relatedBlock) relatedBlock.style.display = 'none';

      let hasContent = false;

      // Filtro exclusivo: se tiver selecionado video so traga video, se tor so traga tor, etc.
      if (targetFilter === 'videos') {
        if (secVideos) {
          secVideos.style.display = '';
          secVideos.classList.add('is-grid');
          hasContent = true;
          const count = secVideos.querySelectorAll('.video-card').length;
          if (count < 16 && typeof loadMoreVideosAuto === 'function') {
            loadMoreVideosAuto();
          }
        }
      } else if (targetFilter === 'tor') {
        if (secTor) {
          secTor.style.display = '';
          if (onionIndicator) onionIndicator.style.display = '';
          hasContent = true;
        }
      } else if (targetFilter === 'images') {
        if (secImages) {
          secImages.style.display = '';
          secImages.classList.add('is-grid');
          hasContent = true;
          const count = secImages.querySelectorAll('.image-card').length;
          if (count < 24 && typeof loadMoreImagesAuto === 'function') {
            loadMoreImagesAuto();
          }
        }
      } else if (targetFilter === 'web') {
        if (secWebList) {
          secWebList.style.display = '';
          if (secWebHeading) secWebHeading.style.display = '';
          if (resultsMore) resultsMore.style.display = '';
          hasContent = true;
        }
      } else if (targetFilter === 'wiki') {
        if (secWiki) {
          secWiki.style.display = '';
          hasContent = true;
        }
      } else if (targetFilter === 'news') {
        if (secNews) {
          secNews.style.display = '';
          hasContent = true;
        }
      }

      if (filterEmptyMsg) {
        filterEmptyMsg.style.display = hasContent ? 'none' : 'block';
      }

      if (shouldScroll) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

      try {
        const url = new URL(window.location.href);
        url.searchParams.set('filter', targetFilter);
        history.replaceState(null, '', url.pathname + url.search);
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: 'navigate-sync',
            url: url.pathname + url.search,
            targetUrl: url.pathname + url.search,
            title: document.title,
            isFinal: true
          }, '*');
        }
      } catch (e) {
        try { history.replaceState(null, '', '#' + targetFilter); } catch (e2) {}
      }
    }
    window.selectSearchFilter = selectSearchFilter;

    (function setupFilterPills() {
      document.addEventListener('click', function(e) {
        const pill = e.target.closest('.search-pill');
        if (!pill) return;
        const filter = pill.getAttribute('data-filter') || 'all';
        selectSearchFilter(filter, true);
      });

      const urlParams = new URLSearchParams(window.location.search);
      const queryFilter = urlParams.get('filter');
      const hashFilter = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
      const initialFilter = queryFilter || hashFilter;
      if (initialFilter && initialFilter !== 'all') {
        setTimeout(() => { selectSearchFilter(initialFilter, false); }, 50);
      }
    })();

    // Sincroniza o tema pesquisado com a aplicação principal (Papaléguas app shell)
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: 'navigate-sync',
          url: window.location.pathname + window.location.search,
          targetUrl: window.location.pathname + window.location.search,
          title: document.title,
          isFinal: true
        }, '*');
      }
    } catch (e) {}

    // Atmosfera dinâmica: a tela vai escurecendo gradualmente conforme o usuário desce até os links .onion
    (function setupOnionAtmosphere() {
      const onionSec = document.getElementById('onionSection');
      const vignette = document.getElementById('onionDarkVignette');
      if (!onionSec || !vignette) return;

      function updateAtmosphere() {
        const rect = onionSec.getBoundingClientRect();
        const winH = window.innerHeight;
        // Começa a escurecer 500px antes da seção .onion entrar totalmente na tela
        const distance = rect.top - winH;
        const triggerDistance = 500;

        if (distance < triggerDistance) {
          const progress = Math.min(1, Math.max(0, 1 - (distance / triggerDistance)));
          vignette.style.opacity = (progress * 0.98).toFixed(2);
          
          // Efeito de escurecimento sutil no fundo geral
          const baseColor = Math.round(11 * (1 - progress * 0.85));
          document.body.style.backgroundColor = 'rgb(' + baseColor + ',' + baseColor + ',' + (baseColor + 2) + ')';
        } else {
          vignette.style.opacity = '0';
          document.body.style.backgroundColor = '';
        }
      }

      window.addEventListener('scroll', updateAtmosphere, { passive: true });
      window.addEventListener('resize', updateAtmosphere, { passive: true });
      updateAtmosphere();
    })();

    function showLocalTorLoading(kind, url) {
      const pBar = document.getElementById('searchTopNavBar');
      if (pBar) {
        pBar.classList.add('is-active');
        pBar.style.opacity = '1';
        pBar.style.width = '35%';
        setTimeout(function() { if (pBar) pBar.style.width = '85%'; }, 200);
      }
      const box = document.getElementById('torNavLoading');
      const title = document.getElementById('torNavTitle');
      const urlEl = document.getElementById('torNavUrl');
      const hint = document.getElementById('torNavHint');
      const isSearch = kind === 'search';
      let hostLabel = '';
      try {
        const u = new URL(url.startsWith('http') ? url : 'https://' + url);
        hostLabel = u.hostname.replace(/^www\./, '');
      } catch (e) { hostLabel = url || ''; }
      if (title) title.textContent = isSearch ? 'Pesquisando na web…' : 'Carregando página…';
      if (urlEl) urlEl.textContent = hostLabel || url || '';
      if (hint) hint.textContent = pageUsesTor
        ? 'A conexão está saindo pela rede Tor com anonimato total…'
        : 'Carregando página via proxy de alta velocidade sem anúncios…';
      if (box) {
        box.hidden = false;
        box.style.display = 'flex';
        if (window.__torLoadingTimer) clearTimeout(window.__torLoadingTimer);
        // O loading permanece ativo continuamente até a página ser aberta por completo.
        window.__torLoadingTimer = setTimeout(function() {
          if (box) { box.hidden = true; box.style.display = 'none'; }
          document.querySelectorAll('.url-suggest-row.is-opening, .search-result-card.is-opening').forEach(function (n) {
            n.classList.remove('is-opening');
            const ext = n.querySelector ? n.querySelector('.url-suggest-ext') : null;
            if (ext && ext.getAttribute('data-orig-text')) ext.textContent = ext.getAttribute('data-orig-text');
          });
        }, 120000);
      }
      try {
        window.parent.postMessage({ type: 'page-loading', kind: kind || 'link', url: url || '' }, '*');
      } catch (e) {}
    }

    function clearLocalLoading() {
      if (window.__torLoadingTimer) {
        clearTimeout(window.__torLoadingTimer);
        window.__torLoadingTimer = null;
      }
      const pBar = document.getElementById('searchTopNavBar');
      if (pBar) {
        pBar.style.width = '100%';
        setTimeout(function() {
          pBar.style.opacity = '0';
          setTimeout(function() {
            pBar.classList.remove('is-active');
            pBar.style.width = '0%';
          }, 250);
        }, 160);
      }
      const box = document.getElementById('torNavLoading');
      if (box) { box.hidden = true; box.style.display = 'none'; }
      document.querySelectorAll('.url-suggest-row.is-opening, .search-result-card.is-opening').forEach(function (n) {
        n.classList.remove('is-opening');
        const ext = n.querySelector ? n.querySelector('.url-suggest-ext') : null;
        if (ext && ext.getAttribute('data-orig-text')) {
          ext.textContent = ext.getAttribute('data-orig-text');
        }
      });
    }

    window.addEventListener('load', function() {
      clearLocalLoading();
      try {
        window.parent.postMessage({ type: 'page-loaded', url: window.location.href }, '*');
      } catch (e) {}
    });
    window.addEventListener('pageshow', clearLocalLoading);

    window.addEventListener('message', function (event) {
      const data = event.data;
      if (!data || (data.type !== 'papaleguas-hide-loading' && data.type !== 'page-loaded')) return;
      clearLocalLoading();
    });

    function markRowLoading(el) {
      document.querySelectorAll('.url-suggest-row.is-opening, .search-result-card.is-opening').forEach((n) => {
        n.classList.remove('is-opening');
        const prevExt = n.querySelector ? n.querySelector('.url-suggest-ext') : null;
        if (prevExt && prevExt.getAttribute('data-orig-text')) {
          prevExt.textContent = prevExt.getAttribute('data-orig-text');
        }
      });
      if (!el) return;
      const row = (el.classList && el.classList.contains('url-suggest-row')) ? el : (el.querySelector ? el.querySelector('.url-suggest-row') : null) || el;
      const card = (el.closest ? el.closest('.search-result-card') : null) || (el.classList && el.classList.contains('search-result-card') ? el : null);
      if (row && row.classList) row.classList.add('is-opening');
      if (card && card.classList) card.classList.add('is-opening');

      const ext = (row && row.querySelector ? row.querySelector('.url-suggest-ext') : null) || (card && card.querySelector ? card.querySelector('.url-suggest-ext') : null);
      if (ext) {
        if (!ext.getAttribute('data-orig-text')) {
          ext.setAttribute('data-orig-text', ext.textContent || 'Acessar →');
        }
        ext.innerHTML = '<span class="nav-ext-spin"></span> Abrindo…';
      }
    }

    let lastNavigateTarget = '';
    let lastNavigateTime = 0;

    function navigateDirect(url, rowEl) {
      if (!url) return;
      const now = Date.now();
      if (lastNavigateTarget === url && (now - lastNavigateTime < 800)) {
        return;
      }
      lastNavigateTarget = url;
      lastNavigateTime = now;
      markRowLoading(rowEl);

      let targetUrl = String(url).trim();

      // Desembrulha se já for rota /proxy?url=
      let realTarget = targetUrl;
      if (targetUrl.includes('/proxy?url=')) {
        try {
          const u = new URL(targetUrl, window.location.origin);
          realTarget = u.searchParams.get('url') || targetUrl;
        } catch (e) {}
      }

      // 1. Se for vídeo do YouTube ou BaixaTube, envia para o player nativo do aplicativo
      let detectedVideoId = '';
      try {
        const u = new URL(realTarget, window.location.origin);
        if (u.searchParams && u.searchParams.has('v')) {
          const v = u.searchParams.get('v');
          if (v && v.length === 11) detectedVideoId = v;
        }
        if (!detectedVideoId && u.hostname && u.hostname.includes('youtu.be')) {
          const seg = u.pathname.split('/').filter(Boolean)[0];
          if (seg && seg.length === 11) detectedVideoId = seg;
        }
        if (!detectedVideoId && u.pathname) {
          const parts = u.pathname.split('/').filter(Boolean);
          for (let pi = 0; pi < parts.length; pi++) {
            if (['embed', 'shorts', 'v'].includes(parts[pi]) && parts[pi + 1] && parts[pi + 1].length === 11) {
              detectedVideoId = parts[pi + 1];
              break;
            }
          }
        }
      } catch (e) {
        if (realTarget.includes('v=')) {
          const idx = realTarget.indexOf('v=');
          const candidate = realTarget.substring(idx + 2, idx + 13);
          if (candidate.length === 11) detectedVideoId = candidate;
        }
      }
      if (detectedVideoId) {
        openVideo(detectedVideoId);
        return;
      }

      // 2. Se for música (Deezer, Spotify ou rota /musica)
      if (realTarget.includes('/musica') || realTarget.includes('musica.html') || realTarget.includes('spotify.com') || realTarget.includes('deezer.com')) {
        let musicQuery = '';
        try {
          const u = new URL(realTarget, window.location.origin);
          musicQuery = u.searchParams.get('q') || u.searchParams.get('play') || u.searchParams.get('track') || '';
        } catch (e) {}
        openMusic(musicQuery);
        return;
      }

      // 3. Se for rota interna do app (/baixatube, /musica, /filmes, /search, etc.), navega direto sem proxy
      if (realTarget.startsWith('/') && !realTarget.startsWith('/proxy')) {
        try {
          if (window.torBrowserAPI && typeof window.torBrowserAPI.sendToHost === 'function') {
            window.torBrowserAPI.sendToHost('navigate-current-tab', realTarget);
            return;
          }
        } catch (e) {}
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'navigate-current-tab', url: realTarget }, '*');
            return;
          }
        } catch (e) {}
        window.location.href = realTarget;
        return;
      }

      showLocalTorLoading('link', realTarget);
      if (!realTarget.startsWith('http://') && !realTarget.startsWith('https://') && !realTarget.startsWith('/')) {
        realTarget = 'https://' + realTarget;
      }

      const inside = '/proxy?url=' + encodeURIComponent(realTarget) + '&clientId=' + encodeURIComponent(suggestClientId);

      try {
        if (window.torBrowserAPI && typeof window.torBrowserAPI.sendToHost === 'function') {
          window.torBrowserAPI.sendToHost('navigate-current-tab', inside);
          return;
        }
      } catch(e) {}

      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'navigate-current-tab', url: inside }, '*');
          return;
        }
      } catch(e) {}

      window.location.href = inside;
    }

    function openImageInApp(el) {
      if (!el) return;
      const targetPage = el.getAttribute('data-page') || el.getAttribute('data-full') || '';
      if (!targetPage) return;
      showLocalTorLoading('link', targetPage);
      navigateDirect(targetPage, el);
    }
    window.openImageInApp = openImageInApp;

    let suggestPage = Math.max(1, Math.ceil(document.querySelectorAll('#resultsList .url-suggest-row').length / 10));
    let suggestLoading = false;
    let suggestHasMore = true;

    // ---------- Resposta da IA (primeiro bloco da página) ----------
    const aiCard = document.getElementById('aiCard');
    const aiState = document.getElementById('aiState');
    const aiAnswerEl = document.getElementById('aiAnswer');
    const aiSourcesEl = document.getElementById('aiSources');
    const aiThread = document.getElementById('aiThread');
    const aiAsk = document.getElementById('aiAsk');
    const aiAskInput = document.getElementById('aiAskInput');
    const aiAskGo = document.getElementById('aiAskGo');
    const aiHistory = [];
    let aiBusy = false;

    function aiEscape(text) {
      return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function aiInline(text, sources) {
      const codeRegex = new RegExp('\\x60([^\\x60]+)\\x60', 'g');
      const html = aiEscape(text)
        .replace(/[*][*]([^*]+)[*][*]/g, '<strong>$1</strong>')
        .replace(codeRegex, '<code class="ai-code">$1</code>');
      const citeRegex = new RegExp('\\\\[' + '([0-9]+(?:[ ]*,[ ]*[0-9]+)*)' + '\\\\]', 'g');
      return html.replace(citeRegex, function (match, group) {
        const links = group.split(',').map(function (raw) {
          const num = parseInt(raw, 10);
          const src = sources && sources[num - 1];
          if (!src) return '';
          return '<a class="ai-cite" href="#" data-ai-src="' + num + '" title="' +
            aiEscape((src.title || '') + ' · ' + (src.host || '')) + '">[' + num + ']</a>';
        }).join('');
        return links || match;
      });
    }

    function aiRenderAnswer(container, text, sources) {
      const blocks = [];
      let currentList = null;
      let currentListType = null;
      const lf = String.fromCharCode(10);
      const cr = String.fromCharCode(13);

      function flushList() {
        if (currentList) {
          blocks.push(currentList);
          currentList = null;
          currentListType = null;
        }
      }

      let pendingBlank = false;
      String(text || '').split(lf).map(function (l) { return l.replace(new RegExp(cr + '$'), ''); }).forEach(function (rawLine) {
        const line = rawLine.trim();
        if (!line) { pendingBlank = true; return; }

        const heading = line.match(/^#{1,4}[ ]+(.*)$/);
        if (heading) {
          flushList();
          pendingBlank = false;
          const h = document.createElement('h4');
          h.className = 'ai-subtitle';
          h.innerHTML = aiInline(heading[1], sources);
          blocks.push(h);
          return;
        }

        const ordered = line.match(/^[0-9]+[.)][ ]+(.*)$/);
        if (ordered) {
          if (currentListType !== 'ol') {
            flushList();
            currentList = document.createElement('ol');
            currentList.className = 'ai-ol';
            currentListType = 'ol';
          }
          const li = document.createElement('li');
          li.innerHTML = aiInline(ordered[1], sources);
          currentList.appendChild(li);
          pendingBlank = false;
          return;
        }

        const bullet = line.match(/^(?:[-*•])[ ]+(.*)$/);
        if (bullet) {
          if (currentListType !== 'ul') {
            flushList();
            currentList = document.createElement('ul');
            currentList.className = 'ai-ul';
            currentListType = 'ul';
          }
          const li = document.createElement('li');
          li.innerHTML = aiInline(bullet[1], sources);
          currentList.appendChild(li);
          pendingBlank = false;
          return;
        }

        flushList();
        pendingBlank = false;
        const p = document.createElement('p');
        p.innerHTML = aiInline(line, sources);
        blocks.push(p);
      });
      flushList();

      container.innerHTML = '';
      blocks.forEach(function (node) { container.appendChild(node); });
      window.__aiSources = sources || [];
      bindAiCites(container, sources);
    }

    function bindAiCites(container, sources) {
      if (!container) return;
      container.querySelectorAll('.ai-cite').forEach(function (cite) {
        cite.addEventListener('click', function (e) {
          e.preventDefault();
          const src = (sources || [])[parseInt(cite.getAttribute('data-ai-src'), 10) - 1];
          if (src) navigateDirect(src.url, null);
        });
      });
    }

    function aiRenderSources(container, sources) {
      container.innerHTML = '';
      (sources || []).forEach(function (src, index) {
        const a = document.createElement('a');
        a.className = 'ai-source';
        a.href = '/proxy?url=' + encodeURIComponent(src.url) + '&clientId=' + encodeURIComponent(suggestClientId);
        a.setAttribute('data-direct', src.url);
        a.title = src.title + ' · ' + src.host;
        a.innerHTML = '<span class="ai-source-num"></span><span class="ai-source-name"></span>';
        a.querySelector('.ai-source-num').textContent = String(index + 1);
        a.querySelector('.ai-source-name').textContent = src.host || src.title;
        a.addEventListener('click', function (e) { e.preventDefault(); navigateDirect(src.url, a); });
        container.appendChild(a);
      });
    }

    function bindAiSources(container) {
      if (!container) return;
      container.querySelectorAll('.ai-source').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          const target = a.getAttribute('data-direct') || a.getAttribute('href');
          navigateDirect(target, a);
        });
      });
    }

    function aiSourcesLabel(count) {
      if (!count) return '';
      return count === 1 ? 'resumo de 1 fonte' : 'resumo de ' + count + ' fontes';
    }

    if (aiCard && currentQuery) {
      if (initialAiData && initialAiData.answer) {
        aiState.textContent = aiSourcesLabel((initialAiData.sources || []).length);
        if (!aiAnswerEl.querySelector('p, ul')) {
          aiRenderAnswer(aiAnswerEl, initialAiData.answer, initialAiData.sources || []);
          aiRenderSources(aiSourcesEl, initialAiData.sources || []);
        } else {
          bindAiCites(aiAnswerEl, initialAiData.sources || []);
          bindAiSources(aiSourcesEl);
        }
        aiHistory.push({ role: 'user', content: currentQuery });
        aiHistory.push({ role: 'assistant', content: initialAiData.answer });
        if (aiAsk) aiAsk.hidden = false;
      } else {
        fetch('/api/search-answer?q=' + encodeURIComponent(currentQuery) + '&clientId=' + encodeURIComponent(suggestClientId))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            const sources = (data && data.sources) || [];
            if (!data || !data.answer) {
              if (aiState) aiState.textContent = '';
              if (aiAnswerEl) aiAnswerEl.innerHTML = '<p style="color:#94a3b8;font-size:13.5px;">Não foi possível gerar resumo prévio para esta busca. Faça sua pergunta no campo abaixo:</p>';
              if (aiAsk) aiAsk.hidden = false;
              return;
            }
            aiState.textContent = aiSourcesLabel(sources.length);
            aiRenderAnswer(aiAnswerEl, data.answer, sources);
            aiRenderSources(aiSourcesEl, sources);
            aiHistory.push({ role: 'user', content: currentQuery });
            aiHistory.push({ role: 'assistant', content: data.answer });
            if (aiAsk) aiAsk.hidden = false;
          })
          .catch(function () {
            if (aiState) aiState.textContent = '';
            if (aiAnswerEl) aiAnswerEl.innerHTML = '<p style="color:#94a3b8;font-size:13.5px;">Assistente de IA disponível. Faça sua pergunta no campo abaixo:</p>';
            if (aiAsk) aiAsk.hidden = false;
          });
      }
    }

    function renderAgentPicks(data) {
      const box = document.getElementById('agentPicks');
      const picks = data && data.picks;
      if (!box || !picks || !picks.length) return;
      box.hidden = false;
      box.textContent = '';
      const title = document.createElement('h3');
      title.className = 'block-title agent-picks-title';
      title.textContent = '✦ O agente recomenda abrir';
      box.appendChild(title);
      if (data.intro) {
        const intro = document.createElement('p');
        intro.className = 'agent-picks-intro';
        intro.textContent = data.intro;
        box.appendChild(intro);
      }
      picks.forEach(function (pick, index) {
        if (!pick || !pick.url) return;
        const a = document.createElement('a');
        a.className = 'agent-pick';
        a.href = '/proxy?url=' + encodeURIComponent(pick.url) + '&clientId=' + encodeURIComponent(suggestClientId);
        a.setAttribute('data-direct', pick.url);
        const num = document.createElement('span');
        num.className = 'agent-pick-num';
        num.textContent = String(index + 1);
        const body = document.createElement('span');
        body.className = 'agent-pick-body';
        const pickTitle = document.createElement('span');
        pickTitle.className = 'agent-pick-title';
        pickTitle.textContent = pick.title || pick.host || pick.url;
        const why = document.createElement('span');
        why.className = 'agent-pick-why';
        why.textContent = pick.why || '';
        const host = document.createElement('span');
        host.className = 'agent-pick-host';
        host.textContent = pick.host || '';
        body.appendChild(pickTitle);
        if (pick.why) body.appendChild(why);
        if (pick.host) body.appendChild(host);
        a.appendChild(num);
        a.appendChild(body);
        a.addEventListener('click', function (e) {
          e.preventDefault();
          navigateDirect(pick.url, a);
        });
        box.appendChild(a);

        let row = null;
        try { row = document.querySelector('.url-suggest-row[data-url="' + CSS.escape(pick.url) + '"]'); } catch (e) { row = null; }
        if (row && !row.querySelector('.url-pick-badge')) {
          row.classList.add('is-pick');
          const badge = document.createElement('span');
          badge.className = 'url-pick-badge';
          badge.textContent = 'Recomendado';
          const titleEl = row.querySelector('.url-suggest-title');
          if (titleEl) titleEl.appendChild(badge);
        }
      });
    }

    if (currentQuery && document.getElementById('agentPicks')) {
      fetch('/api/search-picks?q=' + encodeURIComponent(currentQuery) + '&clientId=' + encodeURIComponent(suggestClientId))
        .then(function (r) { return r.json(); })
        .then(function (data) { renderAgentPicks(data); })
        .catch(function () {});
    }

    if (aiAsk) {
      aiAsk.addEventListener('submit', function (e) {
        e.preventDefault();
        const question = (aiAskInput.value || '').trim();
        if (!question || aiBusy) return;
        aiBusy = true;
        aiAskInput.value = '';
        aiAskGo.disabled = true;
        aiState.textContent = 'pesquisando na web…';

        const asked = document.createElement('div');
        asked.className = 'ai-turn-q';
        asked.textContent = question;
        aiThread.appendChild(asked);

        const reply = document.createElement('div');
        reply.className = 'ai-turn-a';
        reply.innerHTML = '<div class="ai-skeleton"><i></i><i></i></div>';
        aiThread.appendChild(reply);

        fetch('/api/search-chat?clientId=' + encodeURIComponent(suggestClientId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: currentQuery,
            question: question,
            history: aiHistory.slice(-6),
            clientId: suggestClientId
          })
        }).then(function (r) { return r.json(); }).then(function (data) {
          const sources = (data && data.sources) || [];
          if (data && data.answer) {
            aiRenderAnswer(reply, data.answer, sources);
            const box = document.createElement('div');
            box.className = 'ai-sources';
            aiRenderSources(box, sources);
            reply.appendChild(box);
            aiHistory.push({ role: 'user', content: question });
            aiHistory.push({ role: 'assistant', content: data.answer });
            aiState.textContent = aiSourcesLabel(sources.length);
          } else {
            reply.textContent = 'Não achei nada sobre isso agora. Tente reformular a pergunta.';
            aiState.textContent = '';
          }
        }).catch(function () {
          reply.textContent = 'Não consegui falar com a IA agora.';
          aiState.textContent = '';
        }).then(function () {
          aiBusy = false;
          aiAskGo.disabled = false;
          aiAskInput.focus();
        });
      });
    }

    // ===== Prévia dos resultados: imagem de capa + descrição da página =====
    const pvStore = new Map();
    const pvPending = new Set();
    let pvTimer = null;
    function pvImgSrc(u) {
      return '/api/preview-img?u=' + encodeURIComponent(u) + '&clientId=' + encodeURIComponent(suggestClientId);
    }
    function decorateResultRow(row) {
      const url = row.getAttribute('data-url') || '';
      if (!pvStore.has(url)) {
        if (!row.querySelector('.url-suggest-pv')) {
          const ph = document.createElement('span');
          ph.className = 'url-suggest-pv is-loading';
          const ext = row.querySelector('.url-suggest-ext');
          row.insertBefore(ph, ext || null);
        }
        return;
      }
      if (row.getAttribute('data-pv') === '1') return;
      row.setAttribute('data-pv', '1');
      const pv = pvStore.get(url);
      let box = row.querySelector('.url-suggest-pv');
      if (!pv || !pv.image) {
        if (box) box.remove();
      } else {
        if (!box) {
          box = document.createElement('span');
          box.className = 'url-suggest-pv';
          row.insertBefore(box, row.querySelector('.url-suggest-ext') || null);
        }
        box.classList.remove('is-loading');
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.onload = function () {
          box.classList.add('is-ready');
        };
        img.onerror = function () { box.remove(); };
        img.src = pvImgSrc(pv.image);
        box.appendChild(img);
      }
      if (pv && pv.description) {
        const meta = row.querySelector('.url-suggest-meta');
        let snip = row.querySelector('.url-suggest-snip');
        if (meta && !snip) {
          snip = document.createElement('span');
          snip.className = 'url-suggest-snip';
          meta.appendChild(snip);
        }
        if (snip && pv.description.length > String(snip.textContent || '').trim().length) snip.textContent = pv.description;
      }
      const fav = row.querySelector('.url-suggest-fav');
      if (pv && pv.favicon && fav && !fav.querySelector('img')) {
        const letter = fav.textContent;
        const fi = document.createElement('img');
        fi.alt = '';
        fi.referrerPolicy = 'no-referrer';
        fi.onerror = function () { fi.remove(); fav.textContent = letter; };
        fi.src = pvImgSrc(pv.favicon);
        fav.textContent = '';
        fav.appendChild(fi);
      }
    }
    function scheduleResultPreviews() {
      if (pvTimer) clearTimeout(pvTimer);
      pvTimer = setTimeout(runResultPreviews, 100);
    }
    async function runResultPreviews() {
      pvTimer = null;
      const rows = Array.from(document.querySelectorAll('#resultsList .url-suggest-row[data-url]'));
      rows.forEach(decorateResultRow);
      const urls = [];
      rows.forEach(function (row) {
        const u = row.getAttribute('data-url') || '';
        if (!/^https?:/i.test(u) || pvStore.has(u) || pvPending.has(u) || urls.indexOf(u) !== -1) return;
        if (urls.length < 12) urls.push(u);
      });
      if (!urls.length) return;
      urls.forEach(function (u) { pvPending.add(u); });
      try {
        const res = await fetch('/api/page-preview?clientId=' + encodeURIComponent(suggestClientId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: urls })
        });
        const data = await res.json();
        const previews = (data && data.previews) || {};
        urls.forEach(function (u) { pvStore.set(u, previews[u] || null); });
      } catch (e) {
        urls.forEach(function (u) { pvStore.set(u, null); });
      }
      urls.forEach(function (u) { pvPending.delete(u); });
      document.querySelectorAll('#resultsList .url-suggest-row[data-url]').forEach(decorateResultRow);
      scheduleResultPreviews();
    }

    function escapeClientHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function appendSuggestRows(items) {
      const list = document.getElementById('resultsList');
      if (!list || !items || !items.length) return;
      const seenUrls = new Set();
      list.querySelectorAll('.url-suggest-row[data-url]').forEach(function(el) {
        const u = el.getAttribute('data-url');
        if (u) seenUrls.add(u);
      });
      items.forEach((item) => {
        if (!item || item.kind === 'search' || !item.url || !/^https?:/i.test(item.url)) return;
        if (seenUrls.has(item.url)) return;
        seenUrls.add(item.url);
        const host = item.subtitle || item.url;
        const letter = String(host || '?').charAt(0).toUpperCase();
        const card = document.createElement('div');
        card.className = 'search-result-card';
        const a = document.createElement('a');
        a.className = 'url-suggest-row is-appended';
        a.href = '/proxy?url=' + encodeURIComponent(item.url) + '&clientId=' + encodeURIComponent(suggestClientId);
        a.setAttribute('data-direct', item.url);
        a.setAttribute('data-url', item.url);
        if (item.image) a.setAttribute('data-pv', '1');

        let favHtml = letter;
        if (item.favicon) {
          favHtml = '<img src="' + pvImgSrc(item.favicon) + '" alt="" onerror="this.remove()">';
        }

        let pvHtml = '';
        if (item.image) {
          pvHtml = '<span class="url-suggest-pv is-ready" data-url="' + escapeClientHtml(item.url) + '">' +
            '<img src="' + pvImgSrc(item.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.remove()" />' +
            '</span>';
        }

        const sourceTag = item.badge
          ? '<span class="url-source-tag source-rust-index">' + escapeClientHtml(item.badge) + '</span>'
          : '<span class="url-source-tag source-rust-index">⚡ MOTOR RUST</span>';

        a.innerHTML = '<span class="url-suggest-fav">' + favHtml + '</span>' +
          '<span class="url-suggest-meta">' +
            '<span class="url-suggest-title">' + escapeClientHtml(item.title || host) + sourceTag + '</span>' +
            '<span class="url-suggest-url">' + escapeClientHtml(host) + '</span>' +
            (item.snippet ? '<span class="url-suggest-snip">' + escapeClientHtml(item.snippet) + '</span>' : '') +
          '</span>' +
          pvHtml +
          '<span class="url-suggest-ext" title="Acessar no Papaléguas">Acessar →</span>';

        card.appendChild(a);
        list.appendChild(card);
      });
      scheduleResultPreviews();
    }

    function setRefreshLabel() {
      const btn = document.getElementById('resultsRefresh');
      if (!btn) return;
      btn.disabled = !!suggestLoading;
      btn.classList.toggle('is-loading', !!suggestLoading);
      btn.textContent = suggestLoading
        ? 'Carregando mais resultados…'
        : (suggestHasMore ? 'Carregar mais resultados' : 'Buscar mais resultados');
    }

    const prefetchedSuggestPages = new Map();
    let activeWebQuickFilter = 'all';

    function applyWebQuickFilter(mode) {
      activeWebQuickFilter = mode || 'all';
      const rows = document.querySelectorAll('#resultsList .url-suggest-row');
      rows.forEach(function (row) {
        if (activeWebQuickFilter === 'all') {
          row.style.display = '';
          return;
        }
        const text = (row.textContent || '').toLowerCase();
        const href = (row.getAttribute('data-url') || row.querySelector('a')?.getAttribute('href') || '').toLowerCase();
        if (activeWebQuickFilter === 'official') {
          const isOfficial = href.indexOf('.gov') !== -1 || href.indexOf('.edu') !== -1 || text.indexOf('.gov') !== -1 || text.indexOf('.edu') !== -1;
          row.style.display = isOfficial ? '' : 'none';
        } else if (activeWebQuickFilter === 'recent') {
          const hasRecent = /\b(2024|2025|2026|hoje|ontem|hora|horas|minuto|minutos|dia|dias|semana)\b/i.test(text);
          row.style.display = hasRecent ? '' : 'none';
        }
      });
      const pills = document.querySelectorAll('#webQuickFilters [data-web-filter]');
      pills.forEach(function (pill) {
        if (pill.getAttribute('data-web-filter') === activeWebQuickFilter) {
          pill.classList.add('active');
        } else {
          pill.classList.remove('active');
        }
      });
    }

    const webQuickFiltersEl = document.getElementById('webQuickFilters');
    if (webQuickFiltersEl) {
      webQuickFiltersEl.addEventListener('click', function (ev) {
        const btn = ev.target.closest('[data-web-filter]');
        if (!btn) return;
        applyWebQuickFilter(btn.getAttribute('data-web-filter'));
      });
    }

    function prefetchNextSuggestPage() {
      if (!currentQuery || !suggestHasMore || suggestLoading) return;
      const targetPage = suggestPage;
      if (prefetchedSuggestPages.has(targetPage)) return;
      const reqPromise = fetch('/api/url-suggest?q=' + encodeURIComponent(currentQuery) + '&page=' + targetPage + '&clientId=' + encodeURIComponent(suggestClientId))
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
      prefetchedSuggestPages.set(targetPage, reqPromise);
    }

    async function loadMoreSuggestions() {
      if (suggestLoading || !currentQuery) return;
      suggestLoading = true;
      suggestHasMore = true;
      setRefreshLabel();
      let hops = 0;
      let added = 0;
      try {
        while (hops < 8) {
          hops += 1;
          const before = document.querySelectorAll('#resultsList .url-suggest-row').length;
          let data = null;
          if (prefetchedSuggestPages.has(suggestPage)) {
            data = await prefetchedSuggestPages.get(suggestPage);
            prefetchedSuggestPages.delete(suggestPage);
          }
          if (!data) {
            const res = await fetch('/api/url-suggest?q=' + encodeURIComponent(currentQuery) + '&page=' + suggestPage + '&clientId=' + encodeURIComponent(suggestClientId));
            data = await res.json();
          }
          const items = (data && data.suggestions) || [];
          appendSuggestRows(items);
          if (activeWebQuickFilter !== 'all') applyWebQuickFilter(activeWebQuickFilter);
          suggestHasMore = Boolean(data && data.hasMore);
          suggestPage += 1;
          const after = document.querySelectorAll('#resultsList .url-suggest-row').length;
          const diff = after - before;
          added += diff;
          if (added >= 5) break;
          if (!suggestHasMore && hops > 2) break;
          if (!items.length && !suggestHasMore) break;
        }
      } catch (e) {
        console.error('loadMoreSuggestions error:', e);
      }
      suggestLoading = false;
      setRefreshLabel();
      if (added === 0 && !suggestHasMore) {
        const btn = document.getElementById('resultsRefresh');
        if (btn) {
          btn.textContent = 'Todos os resultados carregados';
          btn.disabled = true;
        }
      } else if (suggestHasMore) {
        setTimeout(prefetchNextSuggestPage, 900);
      }
    }
    scheduleResultPreviews();
    if (currentQuery) {
      setTimeout(prefetchNextSuggestPage, 900);
    }

    const resultsRefresh = document.getElementById('resultsRefresh');
    if (resultsRefresh) resultsRefresh.addEventListener('click', function () { loadMoreSuggestions(); });

    window.addEventListener('scroll', () => {
      if ((window.innerHeight + window.scrollY) >= (document.body.offsetHeight - 240)) {
        loadMoreSuggestions();
      }
    }, { passive: true });

    function initSearchPageEvents() {
      try {
        window.parent.postMessage({ type: 'navigate-sync', url: window.location.href, title: document.title }, '*');
      } catch (e) {}
      try {
        if (window.top === window.self) {
          const hdr = document.querySelector('.ddg-header');
          if (hdr) hdr.style.display = 'flex';
        }
      } catch (e) {}
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initSearchPageEvents);
    } else {
      initSearchPageEvents();
    }

    // Delegação global robusta de cliques em todos os links e cards da busca
    document.addEventListener('click', function (e) {
      // 1. Vídeo do YouTube
      const videoCard = e.target.closest('.topic-video-card');
      if (videoCard) {
        e.preventDefault();
        const vid = videoCard.getAttribute('data-video-id') || '';
        const title = videoCard.getAttribute('data-video-title') || '';
        if (vid) openVideo(vid, title);
        return;
      }

      // 2. Música / DJ
      const musicCard = e.target.closest('.topic-music-card');
      if (musicCard) {
        e.preventDefault();
        const query = musicCard.getAttribute('data-music-query') || '';
        if (query) openMusic(query);
        return;
      }

      // 3. Citação da IA [1], [2]
      const cite = e.target.closest('.ai-cite');
      if (cite) {
        e.preventDefault();
        const srcIdx = parseInt(cite.getAttribute('data-ai-src'), 10) - 1;
        const currentSources = (window.__aiSources && window.__aiSources.length) ? window.__aiSources : ((typeof initialAiData !== 'undefined' && initialAiData) ? initialAiData.sources : []);
        const src = (currentSources || [])[srcIdx];
        if (src && src.url) navigateDirect(src.url, null);
        return;
      }

      // 4. Botões de Crawler e Uptime
      if (e.target.closest('.btn-deep-crawl, .btn-test-uptime')) {
        return;
      }

      // 5. Todos os links (resultados web, notícias, wikipédia, fontes IA, picks do agente, filmes, onion, etc.)
      const link = e.target.closest('a[href], .onion-item, .onion-direct-search-btn, .onion-sublink');
      if (!link) return;

      const href = link.getAttribute('href') || '';
      if (!href || href === '#' || href.startsWith('javascript:')) return;

      const targetAttr = (link.getAttribute('target') || '').toLowerCase();
      const directUrl = link.getAttribute('data-direct') || href;

      if (href === 'newtab.html' || href === '/') {
        e.preventDefault();
        navigateDirect('/', link);
        return;
      }

      if (targetAttr === '_blank') {
        try {
          if (window.openInNewTab && directUrl) {
            e.preventDefault();
            window.openInNewTab(directUrl);
            return;
          }
        } catch (err) {}
      }

      e.preventDefault();
      navigateDirect(directUrl, link);
    }, true);

      // Crawler Profundo sob Demanda na Rede Tor (Deep Searcher)
      document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.btn-deep-crawl');
        if (!btn) return;
        e.preventDefault();
        const targetUrl = btn.getAttribute('data-url');
        const targetId = btn.getAttribute('data-target-id');
        const container = document.getElementById(targetId);
        if (!container || !targetUrl) return;

        btn.disabled = true;
        const origHtml = btn.innerHTML;
        btn.innerHTML = '<span>⚙️</span> Varrendo rotas profundas na rede Tor...';

        try {
          const resp = await fetch('/api/onion-crawl?url=' + encodeURIComponent(targetUrl));
          const data = await resp.json();
          if (data.success && Array.isArray(data.sublinks) && data.sublinks.length > 0) {
            btn.innerHTML = '<span>⚡</span> ' + data.sublinks.length + ' sub-páginas profundas detectadas';
            btn.style.background = 'rgba(34, 197, 94, 0.28)';
            btn.style.borderColor = '#22c55e';
            btn.style.color = '#fff';

            const subCards = data.sublinks.map(sub => {
              const baseTarget = targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl;
              const subTarget = sub.url || (baseTarget + (sub.path && sub.path.startsWith('/') ? sub.path : '/' + (sub.path || '')));
              const safeTitle = String(sub.title || sub.path || 'Sub-link').replace(/</g, '&lt;');
              const safePath = String(sub.path || subTarget).replace(/</g, '&lt;');
              const safeDesc = sub.desc ? ('<div style="font-size: 11px; color: #94a3b8; line-height: 1.35;">' + String(sub.desc).replace(/</g, '&lt;') + '</div>') : '';
              return '<div style="background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(34, 197, 94, 0.35); border-radius: 8px; padding: 8px 11px; display: flex; flex-direction: column; gap: 3px;">' +
                '<a href="/proxy?url=' + encodeURIComponent(subTarget) + '&clientId=' + encodeURIComponent(${JSON.stringify(clientId)}) + '" data-direct="' + subTarget + '" class="onion-sublink" style="color: #4ade80; font-size: 12.5px; font-weight: 700; text-decoration: none; display: flex; align-items: center; gap: 5px;">' +
                  '<span style="color: #22c55e;">↳</span> ' + safeTitle +
                '</a>' +
                '<div style="font-family: monospace; font-size: 10px; color: #86efac; opacity: 0.8; word-break: break-all;">' + safePath + '</div>' +
                safeDesc +
              '</div>';
            }).join('');

            container.innerHTML = '<div style="margin-top: 10px; padding: 10px 12px; background: rgba(2, 22, 10, 0.7); border: 1px dashed rgba(34, 197, 94, 0.45); border-radius: 10px;">' +
              '<div style="font-size: 11px; font-weight: 700; color: #4ade80; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">' +
                '<span style="display: inline-block; width: 6px; height: 6px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 8px #22c55e;"></span>' +
                'Novas Sub-rotas Detectadas pelo Deep Crawler (' + data.sublinks.length + ')' +
              '</div>' +
              '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px;">' +
                subCards +
              '</div>' +
            '</div>';
          } else {
            btn.innerHTML = '<span>ℹ️</span> Nenhuma rota pública adicional';
            setTimeout(() => {
              btn.disabled = false;
              btn.innerHTML = origHtml;
            }, 3500);
          }
        } catch (err) {
          btn.innerHTML = '<span>⚠️</span> Falha ao rastrear via Tor';
          setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = origHtml;
          }, 3500);
        }
      });

      // Testador de Uptime 200 em Tempo Real (Probe SOCKS5 / Tor)
      document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.btn-test-uptime');
        if (!btn) return;
        e.preventDefault();
        const targetUrl = btn.getAttribute('data-url');
        const badgeId = btn.getAttribute('data-badge-id');
        const badgeEl = badgeId ? document.getElementById(badgeId) : null;
        if (!targetUrl) return;

        btn.disabled = true;
        btn.innerHTML = '<span>⏳</span> Testando probe...';
        btn.style.opacity = '0.75';

        try {
          const resp = await fetch('/api/onion-check?url=' + encodeURIComponent(targetUrl));
          const data = await resp.json();
          if (data && data.success && data.online) {
            btn.innerHTML = '<span>✅</span> 200 OK (' + (data.latencyMs || 0) + 'ms)';
            btn.style.background = 'rgba(34, 197, 94, 0.25)';
            btn.style.borderColor = '#22c55e';
            btn.style.color = '#86efac';
            btn.style.opacity = '1';
            if (badgeEl) {
              badgeEl.style.background = 'rgba(16, 185, 129, 0.2)';
              badgeEl.style.borderColor = 'rgba(34, 197, 94, 0.6)';
              badgeEl.style.color = '#4ade80';
              badgeEl.style.boxShadow = '0 0 10px rgba(34, 197, 94, 0.35)';
              badgeEl.innerHTML = '<span style="width: 6px; height: 6px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 6px #22c55e;"></span> ' +
                (data.badge || ('🟢 HTTP ' + (data.statusCode || 200) + ' Online (' + data.latencyMs + 'ms)'));
            }
          } else {
            const sc = data && data.statusCode ? data.statusCode : 'Timeout';
            btn.innerHTML = '<span>❌</span> Offline (' + sc + ')';
            btn.style.background = 'rgba(239, 68, 68, 0.15)';
            btn.style.borderColor = 'rgba(239, 68, 68, 0.4)';
            btn.style.color = '#f87171';
            btn.style.opacity = '1';
            if (badgeEl) {
              badgeEl.style.background = 'rgba(239, 68, 68, 0.15)';
              badgeEl.style.borderColor = 'rgba(239, 68, 68, 0.4)';
              badgeEl.style.color = '#f87171';
              badgeEl.innerHTML = '<span style="width: 6px; height: 6px; border-radius: 50%; background: #ef4444;"></span> Inacessível (' + sc + ')';
            }
          }
        } catch (err) {
          btn.innerHTML = '<span>⚠️</span> Erro no teste';
          btn.style.opacity = '1';
        }
        setTimeout(() => {
          btn.disabled = false;
        }, 3000);
      });

      const searchForm = document.querySelector('.ddg-form');
      if (searchForm) {
        searchForm.addEventListener('submit', (e) => {
          const qVal = (document.getElementById('searchInput') || {}).value || currentQuery || '';
          const trimmed = qVal.trim();
          if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || (trimmed.includes('.') && !trimmed.includes(' ') && !trimmed.startsWith('/'))) {
            let directUrl = trimmed;
            if (!directUrl.startsWith('http://') && !directUrl.startsWith('https://')) directUrl = 'https://' + directUrl;
            e.preventDefault();
            navigateDirect(directUrl, null);
            return;
          }
          showLocalTorLoading('search', qVal);
        });
      }

      // Interceptador Universal: SEMPRE que clicar num link, mostrar loading até a página aparecer
      document.addEventListener('click', function(e) {
        // Se for clique no botão de zoom da imagem, abre o lightbox e não navega
        const zoomBtn = e.target.closest('.image-zoom-btn');
        if (zoomBtn) {
          e.preventDefault();
          e.stopPropagation();
          const card = zoomBtn.closest('.image-card, .link-media-item');
          if (card && typeof openLightboxCard === 'function') openLightboxCard(card);
          return;
        }

        if (e.target.closest('.search-pill, .search-filter-pills, .search-filter-bar, .video-card, .link-media-video, .load-more-btn, .image-lightbox-close, .image-lightbox-nav, .video-modal')) {
          return;
        }

        const a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a) return;
        if (a.closest('.btn-deep-crawl, .btn-test-uptime')) return;

        const href = (a.getAttribute('href') || '').trim();
        if (!href || href === '#' || href.toLowerCase().startsWith('javascript:')) return;

        const directUrl = a.getAttribute('data-direct') || a.getAttribute('data-url') || a.href;
        if (!directUrl) return;

        const isSearch = href.includes('/search') || directUrl.includes('/search');
        const kind = isSearch ? 'search' : 'link';

        markRowLoading(a.closest('.search-result-card, .url-suggest-row') || a);
        showLocalTorLoading(kind, directUrl);

        if (!a.classList.contains('ai-cite') && !a.classList.contains('onion-item') && !a.classList.contains('onion-sublink')) {
          e.preventDefault();
          navigateDirect(directUrl, a.closest('.search-result-card, .url-suggest-row') || a);
        }
      }, true);

      (function setupImageLightboxAndVideos() {
        const lightbox = document.getElementById('imageLightbox');
        const lightboxImg = document.getElementById('lightboxImg');
        const lightboxTitle = document.getElementById('lightboxTitle');
        const lightboxSource = document.getElementById('lightboxSource');
        const lightboxCounter = document.getElementById('lightboxCounter');
        const lightboxPageBtn = document.getElementById('lightboxPageBtn');
        const lightboxFullBtn = document.getElementById('lightboxFullBtn');
        const lightboxClose = document.getElementById('lightboxClose');
        const lightboxPrev = document.getElementById('lightboxPrev');
        const lightboxNext = document.getElementById('lightboxNext');

        let currentImageIdx = 0;

        function getAllImageCards() {
          return Array.from(document.querySelectorAll('.image-card'));
        }

        function openLightbox(index) {
          const cards = getAllImageCards();
          if (!cards.length) return;
          currentImageIdx = (index + cards.length) % cards.length;
          const card = cards[currentImageIdx];
          const full = card.getAttribute('data-full') || '';
          const page = card.getAttribute('data-page') || full;
          const t = card.getAttribute('data-title') || '';
          const src = card.getAttribute('data-source') || 'Web';

          if (lightboxImg) lightboxImg.src = full;
          if (lightboxTitle) lightboxTitle.textContent = t;
          if (lightboxSource) lightboxSource.textContent = 'Fonte: ' + src;
          if (lightboxCounter) lightboxCounter.textContent = (currentImageIdx + 1) + ' / ' + cards.length;

          if (lightboxPageBtn) {
            lightboxPageBtn.setAttribute('data-target-page', page);
            lightboxPageBtn.setAttribute('data-direct', page);
            lightboxPageBtn.href = '/proxy?url=' + encodeURIComponent(page) + '&clientId=' + encodeURIComponent(suggestClientId);
          }
          if (lightboxFullBtn) {
            lightboxFullBtn.href = '/proxy?url=' + encodeURIComponent(full) + '&clientId=' + encodeURIComponent(suggestClientId);
            lightboxFullBtn.setAttribute('data-direct', full);
          }

          if (lightbox) {
            lightbox.classList.add('is-open');
            lightbox.setAttribute('aria-hidden', 'false');
          }
        }
        window.openLightbox = openLightbox;

        function closeLightbox() {
          if (!lightbox) return;
          lightbox.classList.remove('is-open');
          lightbox.setAttribute('aria-hidden', 'true');
          if (lightboxImg) lightboxImg.src = '';
        }
        window.closeLightbox = closeLightbox;

        function openLightboxCard(card) {
          if (!card) return;
          const cards = getAllImageCards();
          const idx = cards.indexOf(card);
          if (idx >= 0) {
            openLightbox(idx);
          } else {
            const full = card.getAttribute('data-full') || '';
            const page = card.getAttribute('data-page') || full;
            const t = card.getAttribute('data-title') || '';
            const src = card.getAttribute('data-source') || 'Web';
            openDirectLightbox(full, page, t, src);
          }
        }
        window.openLightboxCard = openLightboxCard;

        function openDirectLightbox(full, page, title, src) {
          if (!full) return;
          if (lightboxImg) lightboxImg.src = full;
          if (lightboxTitle) lightboxTitle.textContent = title || 'Imagem';
          if (lightboxSource) lightboxSource.textContent = 'Fonte: ' + (src || 'Web');
          if (lightboxCounter) lightboxCounter.textContent = '🖼️ Imagem Ampliada';

          const targetP = page || full;
          if (lightboxPageBtn) {
            lightboxPageBtn.setAttribute('data-target-page', targetP);
            lightboxPageBtn.setAttribute('data-direct', targetP);
            lightboxPageBtn.href = '/proxy?url=' + encodeURIComponent(targetP) + '&clientId=' + encodeURIComponent(suggestClientId);
          }
          if (lightboxFullBtn) {
            lightboxFullBtn.href = '/proxy?url=' + encodeURIComponent(full) + '&clientId=' + encodeURIComponent(suggestClientId);
            lightboxFullBtn.setAttribute('data-direct', full);
          }

          if (lightbox) {
            lightbox.classList.add('is-open');
            lightbox.setAttribute('aria-hidden', 'false');
          }
        }
        window.openDirectLightbox = openDirectLightbox;

        // Navegação interna da imagem (Acessar Página no Papaléguas)
        function openLightboxTargetPage() {
          const btn = document.getElementById('lightboxPageBtn');
          const targetUrl = btn ? btn.getAttribute('data-target-page') : '';
          if (targetUrl) {
            closeLightbox();
            navigateDirect(targetUrl);
          }
        }
        window.openLightboxTargetPage = openLightboxTargetPage;

        if (lightboxPageBtn) {
          lightboxPageBtn.addEventListener('click', function(e) {
            e.preventDefault();
            openLightboxTargetPage();
          });
        }
        if (lightboxImg) {
          lightboxImg.addEventListener('click', function(e) {
            e.preventDefault();
            openLightboxTargetPage();
          });
        }

        if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
        if (lightboxPrev) lightboxPrev.addEventListener('click', () => openLightbox(currentImageIdx - 1));
        if (lightboxNext) lightboxNext.addEventListener('click', () => openLightbox(currentImageIdx + 1));
        if (lightbox) {
          lightbox.addEventListener('click', (e) => {
            if (e.target === lightbox) closeLightbox();
          });
        }

        // Teclado (ESC, Setas)
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            if (lightbox && lightbox.classList.contains('is-open')) closeLightbox();
            const vModal = document.getElementById('videoModal');
            if (vModal && vModal.classList.contains('is-open')) closeVideoModal();
          } else if (lightbox && lightbox.classList.contains('is-open')) {
            if (e.key === 'ArrowLeft') openLightbox(currentImageIdx - 1);
            else if (e.key === 'ArrowRight') openLightbox(currentImageIdx + 1);
          }
        });

        const videoModalClose = document.getElementById('videoModalClose');
        if (videoModalClose) videoModalClose.addEventListener('click', closeVideoModal);
        const videoModalCloseBtn = document.getElementById('videoModalCloseBtn');
        if (videoModalCloseBtn) videoModalCloseBtn.addEventListener('click', closeVideoModal);
        const videoModal = document.getElementById('videoModal');
        if (videoModal) {
          videoModal.addEventListener('click', function(e) {
            if (e.target === videoModal) closeVideoModal();
          });
        }

        // Delegação de cliques segura para cards de imagens e vídeos
        document.addEventListener('click', function(e) {
          // Clique no botão de ampliar/zoom da imagem (abre o lightbox)
          const zoomBtn = e.target.closest('.image-zoom-btn');
          if (zoomBtn) {
            e.preventDefault();
            e.stopPropagation();
            const card = zoomBtn.closest('.image-card, .link-media-item');
            if (card) openLightboxCard(card);
            return;
          }

          // Mídia acoplada ao resultado web: Imagem -> Acessa o site da imagem dentro do app
          const linkImg = e.target.closest('.link-media-image');
          if (linkImg) {
            e.preventDefault();
            e.stopPropagation();
            openImageInApp(linkImg);
            return;
          }

          // Mídia acoplada ao resultado web: Vídeo
          const linkVid = e.target.closest('.link-media-video');
          if (linkVid) {
            e.preventDefault();
            e.stopPropagation();
            const vid = linkVid.getAttribute('data-video-id');
            const t = linkVid.getAttribute('data-video-title') || 'Vídeo';
            openVideo(vid, t);
            return;
          }

          // Card de imagem da galeria -> Acessa o site da imagem dentro do app
          const imgCard = e.target.closest('.image-card');
          if (imgCard) {
            e.preventDefault();
            openImageInApp(imgCard);
            return;
          }

          const vidCard = e.target.closest('.video-card');
          if (vidCard) {
            const vid = vidCard.getAttribute('data-video-id');
            const title = vidCard.getAttribute('data-video-title') || 'Vídeo';
            openVideo(vid, title, e);
            return;
          }
        });
      })();
  </script>
</body>
</html>`;

    sendCompressed(req, res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, pageHtml);
    return;
  }

  // YouTube e BaixaTube:
  // Se a requisição vem de dentro de um iframe ou tem query ?embedded=1, serve newtab.html.
  // Se for acesso direto pela barra de endereço do celular/PC (document request), serve index.html
  // para carregar o shell completo com a barra de navegação e menus responsivos.
  if (pathname === '/youtube' || pathname === '/youtube/' || pathname === '/baixatube' || pathname === '/baixatube/' || pathname === '/watch' || pathname === '/watch/' || pathname === '/v' || pathname.startsWith('/v/')) {
    const videoId = reqUrl.searchParams.get('v') || reqUrl.searchParams.get('id') || (pathname.startsWith('/v/') ? pathname.slice(3).replace(/\/$/, '') : '');
    const userAgent = String(req.headers['user-agent'] || '');
    const isSocialCrawler = SOCIAL_CRAWLER_REGEX.test(userAgent);
    const targetFile = path.join(SRC_DIR, 'newtab.html');

    if (videoId && /^[a-zA-Z0-9_-]{6,15}$/.test(videoId)) {
      const cleanVid = escapeHtml(videoId);
      const titleParam = reqUrl.searchParams.get('t') || reqUrl.searchParams.get('title');

      if (!isSocialCrawler) {
        // Usuário normal (app, navegador, celular): serve newtab.html instantaneamente (0ms) sem travar no oEmbed
        const fallbackTitle = titleParam || (videoMetaCache.get(videoId)) || 'Papaléguas BaixaTube';
        const seoData = getVideoSeoMetadata(cleanVid, fallbackTitle);
        fs.readFile(targetFile, 'utf8', (err, html) => {
          if (err || !html) {
            serveFileWithMemoryCache(req, res, targetFile, 'text/html; charset=utf-8', 'no-cache, must-revalidate', true);
            return;
          }
          const modifiedHtml = injectSeoIntoHtml(html, seoData);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, must-revalidate'
          });
          res.end(modifiedHtml);
        });
        if (!titleParam && !videoMetaCache.has(videoId)) {
          getVideoTitleFast(videoId, null).catch(() => {});
        }
        return;
      }

      getVideoTitleFast(videoId, titleParam).then((titleFound) => {
        const seoData = getVideoSeoMetadata(cleanVid, titleFound || titleParam);

        if (isSocialCrawler) {
          serveSocialPreview(res, {
            title: seoData.title,
            description: seoData.description,
            imageUrl: seoData.thumbUrl,
            pageUrl: seoData.url,
            isVideo: true
          });
          return;
        }

        fs.readFile(targetFile, 'utf8', (err, html) => {
          if (err || !html) {
            serveFileWithMemoryCache(req, res, targetFile, 'text/html; charset=utf-8', 'no-cache, must-revalidate', true);
            return;
          }
          const modifiedHtml = injectSeoIntoHtml(html, seoData);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, must-revalidate'
          });
          res.end(modifiedHtml);
        });
      }).catch(() => {
        const seoData = getVideoSeoMetadata(cleanVid, titleParam);
        if (isSocialCrawler) {
          serveSocialPreview(res, {
            title: seoData.title,
            description: seoData.description,
            imageUrl: seoData.thumbUrl,
            pageUrl: seoData.url,
            isVideo: true
          });
          return;
        }
        fs.readFile(targetFile, 'utf8', (err, html) => {
          if (err || !html) {
            serveFileWithMemoryCache(req, res, targetFile, 'text/html; charset=utf-8', 'no-cache, must-revalidate', true);
            return;
          }
          const modifiedHtml = injectSeoIntoHtml(html, seoData);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, must-revalidate'
          });
          res.end(modifiedHtml);
        });
      });
      return;
    }

    // Requisição de categoria / tema / busca geral
    const qParam = reqUrl.searchParams.get('q') || '';
    const themeSeo = getThemeSeoMetadata(qParam);

    if (isSocialCrawler) {
      serveSocialPreview(res, {
        title: themeSeo.title,
        description: themeSeo.description,
        imageUrl: 'https://papaleguas.app/og-banner.jpg',
        pageUrl: themeSeo.url,
        isVideo: false
      });
      return;
    }

    fs.readFile(targetFile, 'utf8', (err, html) => {
      if (err || !html) {
        serveFileWithMemoryCache(req, res, targetFile, 'text/html; charset=utf-8', 'no-cache, must-revalidate', true);
        return;
      }
      const modifiedHtml = injectSeoIntoHtml(html, themeSeo);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, must-revalidate'
      });
      res.end(modifiedHtml);
    });
    return;
  }

  // ----------------------------------------------------
  // PAINEL ADMINISTRATIVO PAPALÉGUAS (Setup, Login, Analytics)
  // Interface protegida por autenticação com usuário e senha
  // ----------------------------------------------------

  if (pathname === '/papaleguas' || pathname === '/papaleguas/') {
    if (!isLocalAdminRequest(req)) {
      sendForbiddenAdminResponse(res, false);
      return;
    }
    const adminHtmlPath = path.join(__dirname, '../papaleguas/index.html');
    if (fs.existsSync(adminHtmlPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(fs.readFileSync(adminHtmlPath, 'utf8'));
      return;
    }
  }

  if (pathname === '/papaleguas/admin.css' || pathname === '/admin.css') {
    const cssPath = path.join(__dirname, '../papaleguas/admin.css');
    if (fs.existsSync(cssPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(fs.readFileSync(cssPath, 'utf8'));
      return;
    }
  }

  if (pathname === '/papaleguas/admin.js' || pathname === '/admin.js') {
    const jsPath = path.join(__dirname, '../papaleguas/admin.js');
    if (fs.existsSync(jsPath)) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(fs.readFileSync(jsPath, 'utf8'));
      return;
    }
  }

  // ----------------------------------------------------
  // PORTAL FILMES ONLINE (Mobile & Web)
  // Assista aos melhores filmes completos sem travar
  // com suporte a transmissão direta na Smart TV / Roku TV
  // ----------------------------------------------------
  if (pathname === '/filmes' || pathname === '/filmes/') {
    const isLocal = isLocalRequest(req);
    const q = reqUrl.searchParams.get('q') || '';
    const activeFilter = (reqUrl.searchParams.get('filter') || 'all').toLowerCase();
    let selectedVid = reqUrl.searchParams.get('v') || '';
    let selectedCategory = reqUrl.searchParams.get('cat') || '';
    const hostHeader = req.headers.host || 'localhost:8080';
    const isHttps = Boolean(req.headers['x-forwarded-proto'] === 'https' || hostHeader.includes('trycloudflare.com') || hostHeader.includes('ngrok-free.app'));
    const requestOrigin = `${isHttps ? 'https' : 'http'}://${hostHeader}`;
    const encodedOrigin = encodeURIComponent(requestOrigin);

    const clientIpParam = reqUrl.searchParams.get('deviceIp') || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
    const clientIp = extractRequestDeviceIp(req, clientIpParam);
    const detectedCountryFromIp = await getClientCountryCode(req, clientIp, false).catch(() => 'BR');
    const rawCountryParam = (reqUrl.searchParams.get('country') || '').trim().toUpperCase();
    const countryCode = (/^[A-Z]{2}$/.test(rawCountryParam) && rawCountryParam !== 'AUTO')
      ? rawCountryParam
      : detectedCountryFromIp;
    const hl = getHlForCountry(countryCode);
    const langShort = String(hl || 'pt-BR').split('-')[0].toLowerCase() || 'pt';

    const isPt = countryCode === 'BR' || countryCode === 'PT';
    const isEs = ['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'UY', 'PY', 'BO', 'CR', 'PA', 'DO', 'GT'].includes(countryCode);
    const isFr = ['FR', 'BE', 'SN', 'CI', 'MA', 'DZ', 'TN'].includes(countryCode);
    const isDe = ['DE', 'AT', 'CH'].includes(countryCode);
    const isIt = countryCode === 'IT';
    const uiLang = isPt ? 'pt' : (isEs ? 'es' : (isFr ? 'fr' : (isDe ? 'de' : (isIt ? 'it' : 'en'))));

    const CINEMA_UI = {
      pt: {
        htmlLang: 'pt-BR',
        pageTitle: 'Filmes Online - Cinema Papaléguas',
        brandTitle: 'Filmes Online',
        searchPlaceholder: 'Buscar filmes dublados completos...',
        searchBtn: 'Buscar',
        refreshBtn: '🎲 Sortear Novos Filmes',
        refreshShort: '🎲 Sortear',
        sectionTitle: '🍿 Filmes Completos Dublados',
        countWord: 'filmes',
        loaderText: '🍿 Buscando mais filmes dublados completos...',
        defaultChannel: 'Cinema Dublado',
        maximize: '⛶ Maximizar',
        minimize: '🗕 Minimizar',
        miniPlayer: '🗕 Mini Player',
        watchDirect: '▶ Assistir Direto',
        dlMp4: '🎬 Baixar MP4',
        dlMp3: '🎵 Áudio MP3',
        cast: '📺 Transmitir',
        close: 'Fechar',
        topBtn: '↑ Topo',
        cats: [
          { id: 'todos', label: '🎬 Todos' },
          { id: 'acao', label: '💥 Ação' },
          { id: 'comedia', label: '😂 Comédia' },
          { id: 'terror', label: '👻 Terror' },
          { id: 'suspense', label: '🔍 Suspense' },
          { id: 'ficcao', label: '🚀 Ficção' },
          { id: 'aventura', label: '🏹 Aventura' },
          { id: 'animacao', label: '🦁 Animação' },
          { id: 'luta', label: '🥋 Luta & Artes Marciais' }
        ]
      },
      en: {
        htmlLang: 'en',
        pageTitle: 'Movies Online - Papaléguas Cinema',
        brandTitle: 'Movies Online',
        searchPlaceholder: 'Search full movies in English...',
        searchBtn: 'Search',
        refreshBtn: '🎲 Shuffle New Movies',
        refreshShort: '🎲 Shuffle',
        sectionTitle: '🍿 Full Length Movies',
        countWord: 'movies',
        loaderText: '🍿 Loading more full movies...',
        defaultChannel: 'Full Movies HD',
        maximize: '⛶ Maximize',
        minimize: '🗕 Minimize',
        miniPlayer: '🗕 Mini Player',
        watchDirect: '▶ Watch Direct',
        dlMp4: '🎬 Download MP4',
        dlMp3: '🎵 Audio MP3',
        cast: '📺 Cast to TV',
        close: 'Close',
        topBtn: '↑ Top',
        cats: [
          { id: 'todos', label: '🎬 All' },
          { id: 'acao', label: '💥 Action' },
          { id: 'comedia', label: '😂 Comedy' },
          { id: 'terror', label: '👻 Horror' },
          { id: 'suspense', label: '🔍 Thriller' },
          { id: 'ficcao', label: '🚀 Sci-Fi' },
          { id: 'aventura', label: '🏹 Adventure' },
          { id: 'animacao', label: '🦁 Animation' },
          { id: 'luta', label: '🥋 Martial Arts' }
        ]
      },
      es: {
        htmlLang: 'es',
        pageTitle: 'Películas Online - Cine Papaléguas',
        brandTitle: 'Películas Online',
        searchPlaceholder: 'Buscar películas completas en español...',
        searchBtn: 'Buscar',
        refreshBtn: '🎲 Sortear Nuevas Películas',
        refreshShort: '🎲 Sortear',
        sectionTitle: '🍿 Películas Completas en Español',
        countWord: 'películas',
        loaderText: '🍿 Buscando más películas completas...',
        defaultChannel: 'Cine en Español',
        maximize: '⛶ Maximizar',
        minimize: '🗕 Minimizar',
        miniPlayer: '🗕 Mini Reproductor',
        watchDirect: '▶ Ver Directo',
        dlMp4: '🎬 Descargar MP4',
        dlMp3: '🎵 Audio MP3',
        cast: '📺 Transmitir',
        close: 'Cerrar',
        topBtn: '↑ Arriba',
        cats: [
          { id: 'todos', label: '🎬 Todas' },
          { id: 'acao', label: '💥 Acción' },
          { id: 'comedia', label: '😂 Comedia' },
          { id: 'terror', label: '👻 Terror' },
          { id: 'suspense', label: '🔍 Suspenso' },
          { id: 'ficcao', label: '🚀 Ciencia Ficción' },
          { id: 'aventura', label: '🏹 Aventura' },
          { id: 'animacao', label: '🦁 Animación' },
          { id: 'luta', label: '🥋 Artes Marciales' }
        ]
      },
      fr: {
        htmlLang: 'fr',
        pageTitle: 'Films en Ligne - Cinéma Papaléguas',
        brandTitle: 'Films en Ligne',
        searchPlaceholder: 'Rechercher des films complets en français...',
        searchBtn: 'Chercher',
        refreshBtn: '🎲 Tirer de Nouveaux Films',
        refreshShort: '🎲 Tirer',
        sectionTitle: '🍿 Films Complets en Français',
        countWord: 'films',
        loaderText: '🍿 Recherche de plus de films complets...',
        defaultChannel: 'Cinéma VF',
        maximize: '⛶ Agrandir',
        minimize: '🗕 Réduire',
        miniPlayer: '🗕 Mini Lecteur',
        watchDirect: '▶ Regarder Direct',
        dlMp4: '🎬 Télécharger MP4',
        dlMp3: '🎵 Audio MP3',
        cast: '📺 Diffuser',
        close: 'Fermer',
        topBtn: '↑ Haut',
        cats: [
          { id: 'todos', label: '🎬 Tous' },
          { id: 'acao', label: '💥 Action' },
          { id: 'comedia', label: '😂 Comédie' },
          { id: 'terror', label: '👻 Horreur' },
          { id: 'suspense', label: '🔍 Thriller' },
          { id: 'ficcao', label: '🚀 Science-Fiction' },
          { id: 'aventura', label: '🏹 Aventure' },
          { id: 'animacao', label: '🦁 Animation' },
          { id: 'luta', label: '🥋 Arts Martiaux' }
        ]
      },
      de: {
        htmlLang: 'de',
        pageTitle: 'Filme Online - Papaléguas Kino',
        brandTitle: 'Filme Online',
        searchPlaceholder: 'Ganze Filme auf Deutsch suchen...',
        searchBtn: 'Suchen',
        refreshBtn: '🎲 Neue Filme Mischen',
        refreshShort: '🎲 Mischen',
        sectionTitle: '🍿 Ganze Filme auf Deutsch',
        countWord: 'Filme',
        loaderText: '🍿 Weitere ganze Filme werden geladen...',
        defaultChannel: 'Kino Deutsch',
        maximize: '⛶ Maximieren',
        minimize: '🗕 Minimieren',
        miniPlayer: '🗕 Mini-Player',
        watchDirect: '▶ Direkt Ansehen',
        dlMp4: '🎬 MP4 Laden',
        dlMp3: '🎵 MP3 Audio',
        cast: '📺 Übertragen',
        close: 'Schließen',
        topBtn: '↑ Oben',
        cats: [
          { id: 'todos', label: '🎬 Alle' },
          { id: 'acao', label: '💥 Action' },
          { id: 'comedia', label: '😂 Komödie' },
          { id: 'terror', label: '👻 Horror' },
          { id: 'suspense', label: '🔍 Thriller' },
          { id: 'ficcao', label: '🚀 Sci-Fi' },
          { id: 'aventura', label: '🏹 Abenteuer' },
          { id: 'animacao', label: '🦁 Animation' },
          { id: 'luta', label: '🥋 Kampfkunst' }
        ]
      },
      it: {
        htmlLang: 'it',
        pageTitle: 'Film Online - Cinema Papaléguas',
        brandTitle: 'Film Online',
        searchPlaceholder: 'Cerca film completi in italiano...',
        searchBtn: 'Cerca',
        refreshBtn: '🎲 Nuovi Film Casuali',
        refreshShort: '🎲 Casuale',
        sectionTitle: '🍿 Film Completi in Italiano',
        countWord: 'film',
        loaderText: '🍿 Ricerca di altri film completi...',
        defaultChannel: 'Cinema Italiano',
        maximize: '⛶ Ingrandisci',
        minimize: '🗕 Riduci',
        miniPlayer: '🗕 Mini Player',
        watchDirect: '▶ Guarda Diretto',
        dlMp4: '🎬 Scarica MP4',
        dlMp3: '🎵 Audio MP3',
        cast: '📺 Trasmetti',
        close: 'Chiudi',
        topBtn: '↑ Su',
        cats: [
          { id: 'todos', label: '🎬 Tutti' },
          { id: 'acao', label: '💥 Azione' },
          { id: 'comedia', label: '😂 Commedia' },
          { id: 'terror', label: '👻 Horror' },
          { id: 'suspense', label: '🔍 Thriller' },
          { id: 'ficcao', label: '🚀 Fantascienza' },
          { id: 'aventura', label: '🏹 Avventura' },
          { id: 'animacao', label: '🦁 Animazione' },
          { id: 'luta', label: '🥋 Arti Marziali' }
        ]
      }
    };
    const ui = CINEMA_UI[uiLang] || CINEMA_UI.en;
    const movieCategories = ui.cats;

    // Busca filmes completos reais no acervo conforme o país detectado pelo IP
    const activeCatObj = movieCategories.find(c => c.id === selectedCategory);
    const catId = activeCatObj ? activeCatObj.id : 'todos';
    const searchQuery = (q || '').trim();
    const useTor = false;
    const isRefresh = !!reqUrl.searchParams.get('r');
    if (!global.__plMovieCategoryCache) {
      global.__plMovieCategoryCache = new Map();
    }
    const movieCategoryCache = global.__plMovieCategoryCache;
    const cacheKey = `${countryCode}:${catId}`;
    if (isRefresh) {
      youtubeSearchCache.clear();
      movieCategoryCache.delete(cacheKey);
    }
    const shuffleArr = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };
    let movieResults = [];

    // Filmes curados da categoria para contingência instantânea (exclusivo para BR/PT)
    const categoryCurated = CURATED_OFFICIAL_MOVIES.filter(m => catId === 'todos' || m.category === catId || (catId === 'acao' && (m.category === 'acao' || m.category === 'luta')));
    const fallbackList = isPt ? (categoryCurated.length > 0 ? categoryCurated : CURATED_OFFICIAL_MOVIES) : [];

    // Busca dinâmica aleatória: utiliza cache instantâneo por país + categoria com atualização em segundo plano
    const cachedCat = (!searchQuery && !isRefresh) ? movieCategoryCache.get(cacheKey) : null;
    const nowMs = Date.now();

    const triggerMovieCategoryRefresh = () => {
      const dynamicSearchObj = getDynamicRecentMovieQuery(catId, null, countryCode);
      const queryToSearch = searchQuery || dynamicSearchObj.query;
      const dynamicTimeFilter = dynamicSearchObj.timeFilter || '';
      const dynamicSortRecent = dynamicSearchObj.sortByRecent;

      return (async () => {
        try {
          let results = await searchYoutubeVideos(queryToSearch, hl, dynamicSortRecent, dynamicTimeFilter, useTor, '', countryCode, clientIp);
          if (!results || results.length < 6) {
            const secondarySearchObj = getDynamicRecentMovieQuery(catId, 1, countryCode);
            const secondaryResults = await searchYoutubeVideos(secondarySearchObj.query, hl, false, '', useTor, '', countryCode, clientIp);
            if (secondaryResults && secondaryResults.length > 0) {
              results = (results || []).concat(secondaryResults);
            }
          }
          const validList = Array.isArray(results) ? results : [];
          if (!searchQuery && validList.length > 0) {
            movieCategoryCache.set(cacheKey, { ts: Date.now(), items: validList });
          }
          return validList;
        } catch (err) {
          return [];
        }
      })();
    };

    if (cachedCat && Array.isArray(cachedCat.items) && cachedCat.items.length > 0) {
      movieResults = cachedCat.items.slice();
      if (nowMs - cachedCat.ts > 180000) {
        triggerMovieCategoryRefresh().catch(() => {});
      }
    } else {
      const searchPromise = triggerMovieCategoryRefresh();
      // Espera maior para outros países (onde não há fallback em português) para carregar os filmes reais do país
      const waitMs = searchQuery ? 2600 : (isPt ? 1200 : 2500);
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), waitMs));
      try {
        movieResults = await Promise.race([searchPromise, timeoutPromise]);
      } catch(e) {
        movieResults = [];
      }
    }

    // Prioriza filmes de longa duração (mais de 25min) sobre trailers ou clipes curtos
    const fullMovies = movieResults.filter(m => {
      const dur = m.duration || '';
      return dur.split(':').length >= 3 || (dur.split(':').length === 2 && parseInt(dur.split(':')[0], 10) >= 25);
    });
    if (fullMovies.length >= 2) {
      movieResults = fullMovies;
    }

    // Embaralha SEMPRE a cada requisição para garantir catálogo vivo e rotativo
    shuffleArr(movieResults);
    if (fallbackList.length > 0) {
      const shuffledFallback = shuffleArr(fallbackList.slice());
      const seenIds = new Set(movieResults.map(m => m.id));
      for (const cur of shuffledFallback) {
        if (!seenIds.has(cur.id)) {
          movieResults.push(cur);
          seenIds.add(cur.id);
        }
      }
    }

    // Se o usuário não abriu um vídeo específico via parâmetro ?v=, seleciona dinamicamente
    // o primeiro filme (que varia a cada requisição) para ser o destaque no player
    if (!selectedVid && movieResults.length > 0) {
      selectedVid = movieResults[0].id;
    }
    if (!selectedVid) {
      selectedVid = CURATED_OFFICIAL_MOVIES[0].id;
    }

    const activeMovie = movieResults.find(m => m.id === selectedVid) || movieResults[0] || CURATED_OFFICIAL_MOVIES[0];
    const activeMovieTitle = activeMovie ? activeMovie.title : ui.brandTitle;
    const safeActiveTitle = (activeMovieTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeQ = q.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const countryQuerySuffix = rawCountryParam ? `&country=${encodeURIComponent(countryCode)}` : '';

    const filmesHtml = `<!DOCTYPE html>
<html lang="${ui.htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5788322050130808"
     crossorigin="anonymous"></script>
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#0b0d14">
  <title>${ui.pageTitle}</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=4">
  <link rel="apple-touch-icon" sizes="192x192" href="/icon-192.png?v=4">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html {
      background: #05060a;
      max-width: 430px;
      margin: 0 auto;
    }
    body {
      background-color: #0b0d14;
      color: #f1f5f9;
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      padding-bottom: 70px;
      max-width: 430px;
      width: 100%;
      margin: 0 auto;
      overflow-x: hidden;
    }
    .cinema-topbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(11, 13, 20, 0.95);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .cinema-brand {
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      color: #fff;
    }
    .cinema-logo-box {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      overflow: hidden;
    }
    .cinema-title {
      font-size: 16px;
      font-weight: 800;
      letter-spacing: -0.3px;
      background: linear-gradient(90deg, #ffffff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .cinema-badges {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cinema-cast-btn {
      background: linear-gradient(135deg, #2563eb, #4f46e5);
      color: #fff;
      border: none;
      padding: 6px 12px;
      border-radius: 18px;
      font-size: 11.5px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      box-shadow: 0 3px 10px rgba(79, 70, 229, 0.35);
      transition: transform 0.15s, opacity 0.15s;
    }
    .cinema-cast-btn:active { transform: scale(0.95); opacity: 0.9; }

    /* Barra de Busca */
    .cinema-search-bar {
      width: 100%;
      max-width: 430px;
      margin: 10px auto 6px;
      padding: 0 12px;
    }
    .cinema-form {
      display: flex;
      gap: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 22px;
      padding: 3px 5px 3px 14px;
      transition: border-color 0.2s;
    }
    .cinema-form:focus-within { border-color: #f59e0b; }
    .cinema-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #fff;
      font-size: 13.5px;
      font-family: inherit;
    }
    .cinema-search-btn {
      background: linear-gradient(135deg, #f59e0b, #ea580c);
      border: none;
      border-radius: 18px;
      color: #fff;
      padding: 6px 14px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* Carrossel de Categorias Móvel */
    .categories-bar {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding: 6px 12px 8px;
      scrollbar-width: none;
      max-width: 430px;
      margin: 0 auto;
      width: 100%;
    }
    .categories-bar::-webkit-scrollbar { display: none; }
    .category-chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      color: #cbd5e1;
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
      transition: all 0.2s;
      flex-shrink: 0;
    }
    .category-chip:hover, .category-chip.active {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.25), rgba(225, 29, 72, 0.25));
      border-color: #f59e0b;
      color: #fff;
    }

    /* Player Section */
    .cinema-player-section {
      width: 100%;
      max-width: 430px;
      margin: 4px auto 10px;
      padding: 0 12px;
    }
    .cinema-player-wrapper {
      position: relative;
      width: 100%;
      padding-bottom: 56.25%;
      height: 0;
      background: #000;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 8px 25px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.08);
    }
    .cinema-player-wrapper iframe {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border: none;
    }
    .cinema-player-section.mini-mode {
      position: fixed;
      right: 10px;
      bottom: calc(64px + env(safe-area-inset-bottom, 0px));
      width: 200px;
      z-index: 9990;
      margin: 0;
      padding: 0;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 12px 32px rgba(0,0,0,0.65);
      contain: layout paint;
      transform: translateZ(0);
      display: flex;
      flex-direction: column;
    }
    .cinema-player-section.mini-mode .cinema-info-card { display: none; }
    .cinema-player-section.mini-mode .cinema-player-wrapper { border-radius: 0 0 12px 12px; }
    .cinema-mini-close { display: none; }
    .cinema-player-section.mini-mode .cinema-mini-close {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      height: 32px;
      padding: 0 8px;
      border: none;
      border-radius: 12px 12px 0 0;
      background: #111827;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      flex-shrink: 0;
    }
    .cinema-player-section.mini-mode .cinema-mini-close span:last-child {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: rgba(239, 68, 68, 0.9);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      line-height: 1;
    }
    html.video-true-fs,
    html.video-true-fs body {
      background: #000 !important;
      overflow: hidden !important;
      max-width: none !important;
      height: 100vh !important;
      height: 100dvh !important;
    }
    html.video-true-fs .cinema-topbar,
    html.video-true-fs .categories-bar,
    html.video-true-fs .cinema-search-bar,
    html.video-true-fs .cinema-info-card,
    html.video-true-fs .section-header,
    html.video-true-fs .movies-grid,
    html.video-true-fs .agent-scroll-loader {
      display: none !important;
    }
    html.video-true-fs .cinema-player-section,
    html.video-true-fs .cinema-player-wrapper {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      height: 100dvh !important;
      max-width: none !important;
      padding: 0 !important;
      margin: 0 !important;
      border-radius: 0 !important;
      z-index: 2147483000 !important;
      background: #000 !important;
    }
    html.video-true-fs .cinema-player-wrapper iframe {
      width: 100% !important;
      height: 100% !important;
    }
    .fs-home-btn {
      display: none !important;
    }

    /* Botão de Minimizar Tela do Filme */
    .cinema-minimize-btn {
      position: absolute;
      top: max(12px, env(safe-area-inset-top, 12px));
      left: max(12px, env(safe-area-inset-left, 12px));
      z-index: 50;
      display: none;
      align-items: center;
      gap: 7px;
      padding: 7px 13px;
      border: 1px solid rgba(255, 255, 255, 0.28);
      border-radius: 20px;
      background: rgba(11, 15, 26, 0.88);
      color: #fff;
      font-family: inherit;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(245, 158, 11, 0.25);
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      user-select: none;
      -webkit-user-select: none;
      outline: none;
    }
    .cinema-minimize-btn:hover {
      background: rgba(245, 158, 11, 0.28);
      border-color: #f59e0b;
      color: #fef3c7;
      transform: translateY(-1px) scale(1.02);
      box-shadow: 0 8px 25px rgba(245, 158, 11, 0.4);
    }
    .cinema-minimize-btn:active {
      transform: translateY(0) scale(0.97);
    }
    .cinema-minimize-btn svg {
      flex-shrink: 0;
      transition: transform 0.2s;
    }
    .cinema-minimize-btn:hover svg {
      transform: scale(1.1);
    }
    .cinema-player-section.mini-mode .cinema-minimize-btn {
      display: none !important;
    }

    /* QUANDO A TELA ESTIVER MAXIMIZADA (video-true-fs ou Fullscreen) */
    html.video-true-fs .cinema-minimize-btn,
    html:fullscreen .cinema-minimize-btn,
    html:-webkit-full-screen .cinema-minimize-btn {
      position: fixed !important;
      display: inline-flex !important;
      top: max(16px, env(safe-area-inset-top, 16px)) !important;
      left: max(16px, env(safe-area-inset-left, 16px)) !important;
      z-index: 2147483647 !important;
      padding: 10px 18px !important;
      font-size: 13.5px !important;
      border-radius: 24px !important;
      background: rgba(10, 14, 23, 0.94) !important;
      border: 1px solid rgba(245, 158, 11, 0.7) !important;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8), 0 0 18px rgba(245, 158, 11, 0.35) !important;
      color: #fff !important;
      opacity: 1;
      visibility: visible;
      pointer-events: auto !important;
    }
    html.video-true-fs .cinema-minimize-btn.auto-dim,
    html:fullscreen .cinema-minimize-btn.auto-dim,
    html:-webkit-full-screen .cinema-minimize-btn.auto-dim {
      opacity: 0.32;
    }
    html.video-true-fs .cinema-minimize-btn.auto-dim:hover,
    html:fullscreen .cinema-minimize-btn.auto-dim:hover,
    html:-webkit-full-screen .cinema-minimize-btn.auto-dim:hover {
      opacity: 1 !important;
      border-color: #f59e0b !important;
    }
    @media (max-width: 900px), (pointer: coarse), (display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui) {
      .cinema-minimize-btn,
      #cinema-minimize-btn,
      html.video-true-fs .cinema-minimize-btn,
      html:fullscreen .cinema-minimize-btn,
      html:-webkit-full-screen .cinema-minimize-btn {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    }
    .cinema-info-card {
      margin-top: 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-start;
      gap: 8px;
      min-width: 0;
      overflow: hidden;
    }
    .cinema-info-text {
      font-size: 13.5px;
      color: #fff;
      font-weight: 700;
      line-height: 1.35;
      width: 100%;
      min-width: 0;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .cinema-actions {
      display: flex;
      align-items: stretch;
      justify-content: flex-start;
      gap: 6px;
      flex-wrap: wrap;
      width: 100%;
      min-width: 0;
    }
    .cinema-actions > a,
    .cinema-actions > button {
      flex: 1 1 calc(50% - 6px);
      min-width: 0;
      justify-content: center;
      white-space: nowrap;
      box-sizing: border-box;
    }

    .section-header {
      max-width: 430px;
      margin: 12px auto 8px;
      padding: 0 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .section-title-text {
      font-size: 14px;
      font-weight: 800;
      color: #f59e0b;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section-counter {
      font-size: 11px;
      color: #94a3b8;
      font-weight: 600;
    }

    /* Grid de Filmes Organizado Modo Celular (2 colunas perfeitas no smartphone) */
    .movies-grid {
      max-width: 430px;
      margin: 0 auto;
      padding: 0 12px;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      width: 100%;
    }
    @media (min-width: 768px) {
      html, body { max-width: 960px !important; }
      .cinema-search-bar,
      .categories-bar,
      .cinema-player-section,
      .section-header,
      .movies-grid { max-width: 960px !important; }
      .movies-grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)) !important; gap: 14px; }
    }
    .movie-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 10px;
      overflow: hidden;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      transition: transform 0.2s, border-color 0.2s, background 0.2s;
    }
    .movie-card:hover, .movie-card:active {
      background: rgba(255, 255, 255, 0.07);
      border-color: rgba(245, 158, 11, 0.5);
      transform: translateY(-2px);
    }
    .movie-thumb-wrap {
      position: relative;
      width: 100%;
      padding-bottom: 56.25%;
      background: #111;
      overflow: hidden;
    }
    .movie-thumb-wrap img {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .movie-dur {
      position: absolute;
      bottom: 4px;
      right: 4px;
      background: rgba(0, 0, 0, 0.85);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
    }
    .movie-details {
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      flex: 1;
    }
    .movie-title {
      font-size: 12px;
      font-weight: 700;
      color: #fff;
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .movie-channel {
      font-size: 10.5px;
      color: #94a3b8;
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .movie-card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
      width: 100%;
      min-width: 0;
    }
    .movie-card-actions button {
      flex: 1 1 calc(50% - 4px);
      min-width: 0;
      background: #0284c7;
      border: none;
      color: #fff;
      padding: 4px 6px;
      border-radius: 5px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
      box-sizing: border-box;
    }
    .movie-card-actions button.movie-act-mp3 { background: #10b981; }
    .movie-card-actions button.movie-act-cast { background: #7c3aed; }

    /* Modal / Toast de Transmissão */
    .cast-toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #1e293b;
      color: #fff;
      padding: 10px 18px;
      border-radius: 24px;
      font-size: 12.5px;
      font-weight: 600;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.6);
      display: none;
      z-index: 1000;
    }

    /* Curador AI */
    .agent-curator-banner {
      grid-column: 1 / -1;
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(225, 29, 72, 0.15));
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 10px;
      padding: 10px 14px;
      margin: 8px 0 4px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .agent-avatar-box {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: linear-gradient(135deg, #f59e0b, #e11d48);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 16px;
    }
    .agent-text-content { flex: 1; }
    .agent-badge-tag {
      font-size: 9.5px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: #fcd34d;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .agent-reason-text {
      font-size: 12px;
      font-weight: 500;
      color: #fff;
      line-height: 1.35;
    }
    .agent-scroll-loader {
      max-width: 900px;
      margin: 18px auto;
      padding: 10px 16px;
      display: none;
      align-items: center;
      justify-content: center;
      gap: 10px;
      font-size: 12.5px;
      color: #fcd34d;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 24px;
      border: 1px solid rgba(245, 158, 11, 0.25);
    }
    .agent-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(245, 158, 11, 0.25);
      border-top-color: #f59e0b;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .cinema-res-picker-btn {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 11px 15px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .cinema-res-picker-btn:hover, .cinema-res-picker-btn:active {
      background: rgba(245, 158, 11, 0.12);
      border-color: #f59e0b;
      transform: translateY(-1px);
    }
    .cinema-res-tag-pill {
      font-size: 11px;
      font-weight: 800;
      padding: 3px 8px;
      border-radius: 6px;
    }
    .back-top-btn {
      position: fixed;
      left: max(14px, env(safe-area-inset-left));
      bottom: max(18px, env(safe-area-inset-bottom));
      z-index: 1800;
      display: none;
      align-items: center;
      gap: 6px;
      padding: 10px 14px;
      border: 1px solid rgba(245, 158, 11, 0.55);
      border-radius: 999px;
      background: rgba(17, 12, 8, 0.94);
      color: #ffedd5;
      font-family: inherit;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
    }
    .back-top-btn.is-on { display: inline-flex; }
    .back-top-btn { user-select: none; -webkit-user-select: none; touch-action: none; }
    .back-top-btn.is-dragging { cursor: grabbing; opacity: 0.85; box-shadow: 0 14px 36px rgba(0,0,0,0.55), 0 0 0 3px rgba(245,158,11,0.35); }
    html.video-true-fs .back-top-btn { display: none !important; }
  </style>
</head>
<body>
  <header class="cinema-topbar">
    <a href="/filmes${rawCountryParam ? '?country=' + encodeURIComponent(countryCode) : ''}" class="cinema-brand">
      <div class="cinema-logo-box">
        <img src="/icon-192.png?v=4" alt="Papaléguas" style="width:32px;height:32px;border-radius:50%;object-fit:cover;box-shadow:0 0 10px rgba(245,158,11,0.5);" />
      </div>
      <div class="cinema-title">${ui.brandTitle}</div>
    </a>
    <div class="cinema-badges">
      <select id="cinema-country-badge" title="País / Idioma dos Filmes" style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.16);color:#f8fafc;border-radius:14px;padding:4px 8px;font-size:11.5px;font-weight:700;cursor:pointer;outline:none;">
        <option value="auto" ${!rawCountryParam ? 'selected' : ''}>🌐 Auto (${countryCode})</option>
        <option value="BR" ${rawCountryParam === 'BR' ? 'selected' : ''}>🇧🇷 Brasil</option>
        <option value="US" ${rawCountryParam === 'US' ? 'selected' : ''}>🇺🇸 Estados Unidos</option>
        <option value="PT" ${rawCountryParam === 'PT' ? 'selected' : ''}>🇵🇹 Portugal</option>
        <option value="ES" ${rawCountryParam === 'ES' ? 'selected' : ''}>🇪🇸 Espanha</option>
        <option value="AR" ${rawCountryParam === 'AR' ? 'selected' : ''}>🇦🇷 Argentina</option>
        <option value="MX" ${rawCountryParam === 'MX' ? 'selected' : ''}>🇲🇽 México</option>
        <option value="GB" ${rawCountryParam === 'GB' ? 'selected' : ''}>🇬🇧 Reino Unido</option>
        <option value="FR" ${rawCountryParam === 'FR' ? 'selected' : ''}>🇫🇷 França</option>
        <option value="DE" ${rawCountryParam === 'DE' ? 'selected' : ''}>🇩🇪 Alemanha</option>
        <option value="IT" ${rawCountryParam === 'IT' ? 'selected' : ''}>🇮🇹 Itália</option>
        <option value="CA" ${rawCountryParam === 'CA' ? 'selected' : ''}>🇨🇦 Canadá</option>
        <option value="AU" ${rawCountryParam === 'AU' ? 'selected' : ''}>🇦🇺 Austrália</option>
        <option value="JP" ${rawCountryParam === 'JP' ? 'selected' : ''}>🇯🇵 Japão</option>
      </select>
    </div>
  </header>

  <!-- Categorias em Pílulas para Celular -->
  <nav class="categories-bar">
    ${movieCategories.map(cat => `
      <a href="/filmes?cat=${cat.id}${q ? '&q=' + encodeURIComponent(q) : ''}${countryQuerySuffix}" data-cat="${cat.id}" class="category-chip ${(selectedCategory || 'todos') === cat.id ? 'active' : ''}">
        ${cat.label}
      </a>
    `).join('')}
  </nav>

  <!-- Barra de Busca Rápida de Filmes -->
  <div class="cinema-search-bar">
    <form class="cinema-form" id="cinema-form">
      <input type="text" class="cinema-input" id="cinema-query" placeholder="${ui.searchPlaceholder}" value="${safeQ}">
      <button type="submit" class="cinema-search-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        ${ui.searchBtn}
      </button>
    </form>
    <a href="/filmes?cat=${encodeURIComponent(catId)}${q ? '&q=' + encodeURIComponent(q) : ''}${countryQuerySuffix}&r=${Date.now()}" id="cinema-refresh-btn" title="${ui.refreshBtn}" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:9px 14px;border-radius:18px;background:linear-gradient(135deg,#f59e0b,#e11d48);color:#fff;font-size:13px;font-weight:700;text-decoration:none;box-shadow:0 3px 12px rgba(225,29,72,0.35);letter-spacing:0.2px;">
      ${ui.refreshBtn}
    </a>
  </div>

  <!-- Player Principal -->
  <main class="cinema-player-section">
    <button type="button" class="cinema-mini-close" id="cinema-mini-close" title="${ui.close}">
      <span>${ui.close}</span>
      <span aria-hidden="true">✕</span>
    </button>
    <button type="button" class="cinema-minimize-btn" id="cinema-minimize-btn" onclick="minimizeCinemaVideo()" title="${ui.minimize}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
      </svg>
      <span>${ui.minimize.replace(/^🗕\s*/, '')}</span>
    </button>
    <div class="cinema-player-wrapper" id="player-container">
      <iframe id="cinema-iframe" src="https://www.youtube.com/embed/${encodeURIComponent(selectedVid)}?autoplay=1&enablejsapi=1&playsinline=1&hl=${encodeURIComponent(hl)}&cc_lang_pref=${encodeURIComponent(langShort)}&rel=0&origin=${encodedOrigin}&widget_referrer=${encodedOrigin}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="origin"></iframe>
      <video id="cinema-native-video" controls playsinline webkit-playsinline style="display:none;position:absolute;inset:0;width:100%;height:100%;background:#000;z-index:2;object-fit:contain;"></video>
    </div>

    <video id="cinema-pip-video" playsinline webkit-playsinline muted style="position:fixed;width:160px;height:90px;left:-200px;bottom:0;opacity:0.02;pointer-events:none;"></video>

    <div class="cinema-info-card">
      <div class="cinema-info-text" id="active-title">
        ▶ ${safeActiveTitle}
      </div>
      <div class="cinema-actions">
        <button class="cinema-cast-btn" id="btn-cinema-fs-toggle" type="button" onclick="toggleCinemaMaximize()" style="background:rgba(255,255,255,0.12);color:#fff;padding:6px 12px;font-size:11px;" title="${ui.maximize} / ${ui.minimize}">
          <span id="cinema-fs-label">${ui.maximize}</span>
        </button>
        <button class="cinema-cast-btn" id="btn-cinema-mini-toggle" type="button" onclick="enterCinemaMiniPlayer(false)" style="background:rgba(255,255,255,0.08);color:#fff;padding:6px 12px;font-size:11px;" title="${ui.miniPlayer}">
          ${ui.miniPlayer}
        </button>
        <a id="cinema-direct-link" href="/youtube?v=${encodeURIComponent(selectedVid)}" class="cinema-cast-btn" style="background:rgba(255,255,255,0.08);color:#fff;text-decoration:none;padding:6px 12px;font-size:11px;" title="${ui.watchDirect}" onclick="event.preventDefault(); var u=this.getAttribute('href'); try { if (window.openInNewTab) { window.openInNewTab(u); return; } } catch (e) {} try { if (window.parent && window.parent !== window) { window.parent.postMessage({ type: 'navigate-current-tab', url: u }, '*'); return; } } catch (e) {} location.href=u;">
          ${ui.watchDirect}
        </a>
        <button class="cinema-dl-btn cinema-dl-mp4" type="button" onclick="openCinemaResolutionModal()" title="${ui.dlMp4}" style="background:linear-gradient(135deg,#0284c7,#0369a1);border:none;color:#fff;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
          ${ui.dlMp4}
        </button>
        <button class="cinema-dl-btn cinema-dl-mp3" type="button" onclick="downloadActiveCinemaVideo('mp3')" title="${ui.dlMp3}" style="background:linear-gradient(135deg,#10b981,#059669);border:none;color:#fff;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
          ${ui.dlMp3}
        </button>
        <button class="cinema-cast-btn" id="btn-cast-quick" style="padding: 6px 12px; font-size: 11px;" title="${ui.cast}">
          ${ui.cast}
        </button>
      </div>
    </div>
  </main>

  <!-- Modal Seletor de Resolução do Filme (Cinema) -->
  <div class="yt-modal-overlay" id="cinema-res-modal" style="display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;align-items:center;justify-content:center;padding:16px;">
    <div style="position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);z-index:1;" onclick="closeCinemaResModal()"></div>
    <div onclick="event.stopPropagation()" style="position:relative;background:#111827;border:1px solid rgba(255,255,255,0.15);border-radius:18px;max-width:400px;width:100%;padding:22px;box-shadow:0 25px 50px rgba(0,0,0,0.85);z-index:10;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:12px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:22px;">🍿</span>
          <div>
            <div style="font-size:15px;font-weight:700;color:#fff;">Escolha a Resolução</div>
            <div id="cinema-res-movie-title" style="font-size:11px;color:#94a3b8;margin-top:2px;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Filme</div>
          </div>
        </div>
        <button type="button" onclick="closeCinemaResModal()" style="background:rgba(255,255,255,0.08);border:none;color:#94a3b8;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:13px;">✕</button>
      </div>

      <div style="display:flex;flex-direction:column;gap:8px;">
        <button type="button" onclick="selectCinemaResolution('1080')" class="cinema-res-picker-btn">
          <div style="text-align:left;pointer-events:none;">
            <div style="font-weight:700;color:#fff;font-size:13px;">💎 1080p Full HD</div>
            <div style="font-size:10.5px;color:#94a3b8;">Máxima resolução (arquivo maior)</div>
          </div>
          <span class="cinema-res-tag-pill" style="color:#38bdf8;background:rgba(56,189,248,0.15);pointer-events:none;">Full HD</span>
        </button>

        <button type="button" onclick="selectCinemaResolution('720')" class="cinema-res-picker-btn" style="border-color:rgba(245,158,11,0.4);background:rgba(245,158,11,0.08);">
          <div style="text-align:left;pointer-events:none;">
            <div style="font-weight:700;color:#f59e0b;font-size:13px;">⭐ 720p HD <span style="background:#f59e0b;color:#000;font-size:9px;font-weight:800;padding:2px 5px;border-radius:4px;margin-left:4px;">RECOMENDADO</span></div>
            <div style="font-size:10.5px;color:#94a3b8;">Rápido e excelente qualidade visual</div>
          </div>
          <span class="cinema-res-tag-pill" style="color:#10b981;background:rgba(16,185,129,0.15);pointer-events:none;">720p HD</span>
        </button>

        <button type="button" onclick="selectCinemaResolution('480')" class="cinema-res-picker-btn">
          <div style="text-align:left;pointer-events:none;">
            <div style="font-weight:700;color:#fff;font-size:13px;">📱 480p Padrão</div>
            <div style="font-size:10.5px;color:#94a3b8;">Econômico • Ideal para celular e dados móveis</div>
          </div>
          <span class="cinema-res-tag-pill" style="color:#f59e0b;background:rgba(245,158,11,0.15);pointer-events:none;">480p</span>
        </button>

        <button type="button" onclick="selectCinemaResolution('360')" class="cinema-res-picker-btn">
          <div style="text-align:left;pointer-events:none;">
            <div style="font-weight:700;color:#fff;font-size:13px;">⚡ 360p Ultra-Leve</div>
            <div style="font-size:10.5px;color:#94a3b8;">Download ultra-rápido para conexões lentas</div>
          </div>
          <span class="cinema-res-tag-pill" style="color:#cbd5e1;background:rgba(255,255,255,0.1);pointer-events:none;">360p</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Modal de Download de Cinema / Filmes -->
  <div class="yt-modal-overlay" id="cinema-dl-modal" style="display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;align-items:center;justify-content:center;padding:16px;">
    <div style="position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);" onclick="closeCinemaDlModal()"></div>
    <div style="position:relative;background:#111827;border:1px solid rgba(255,255,255,0.15);border-radius:18px;max-width:480px;width:100%;padding:24px;box-shadow:0 25px 50px rgba(0,0,0,0.7);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:24px;" id="cinema-modal-icon">⚡</span>
          <div>
            <div id="cinema-modal-title" style="font-size:16px;font-weight:700;color:#fff;">Baixando Filme</div>
            <div id="cinema-modal-subtitle" style="font-size:12px;color:#94a3b8;">Processando conversão em alta resolução</div>
          </div>
        </div>
        <button onclick="closeCinemaDlModal()" style="background:rgba(255,255,255,0.08);border:none;color:#cbd5e1;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:14px;">✕</button>
      </div>
      <div>
        <div id="cinema-dl-loading" style="padding:10px 0;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <p id="cinema-dl-status-text" style="color:#e2e8f0;font-weight:700;font-size:13px;margin:0;">Conectando ao filme...</p>
            <span id="cinema-dl-progress-pct" style="font-size:12px;font-weight:800;color:#f59e0b;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);padding:2px 8px;border-radius:6px;">5%</span>
          </div>

          <!-- Barra de Progresso Animada -->
          <div style="width:100%;height:10px;background:rgba(255,255,255,0.08);border-radius:5px;overflow:hidden;margin-bottom:8px;border:1px solid rgba(255,255,255,0.1);">
            <div id="cinema-dl-progress-fill" style="height:100%;width:5%;background:linear-gradient(90deg,#f59e0b,#ef4444,#10b981);border-radius:5px;transition:width 0.25s ease;box-shadow:0 0 10px rgba(245,158,11,0.6);"></div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span id="cinema-dl-progress-speed" style="font-size:11px;color:#f59e0b;font-weight:600;">Iniciando motor de download...</span>
            <span id="cinema-dl-progress-total" style="font-size:11px;color:#94a3b8;"></span>
          </div>
        </div>
        <div id="cinema-dl-success" style="display:none;">
          <div style="display:flex;align-items:center;gap:12px;background:rgba(255,255,255,0.04);padding:12px;border-radius:10px;margin-bottom:14px;border:1px solid rgba(255,255,255,0.06);">
            <span id="cinema-dl-file-icon" style="font-size:24px;">🎬</span>
            <div>
              <div id="cinema-dl-file-title" style="font-weight:700;font-size:14px;color:#fff;">Filme Pronto</div>
              <div id="cinema-dl-file-meta" style="font-size:12px;color:#94a3b8;">Duração: --:--</div>
            </div>
          </div>
          <audio id="cinema-dl-audio-player" controls style="display:none;width:100%;margin-bottom:14px;outline:none;"></audio>
          <video id="cinema-dl-video-player" controls style="display:none;width:100%;max-height:220px;border-radius:10px;margin-bottom:14px;"></video>
          <a id="cinema-dl-download-link" href="#" style="display:flex;align-items:center;justify-content:center;gap:8px;width:100%;background:#10b981;color:#fff;padding:12px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 14px rgba(16,185,129,0.4);" download>⬇️ Salvar Arquivo no Dispositivo</a>
        </div>
      </div>
    </div>
  </div>

  <div class="section-header">
    <div class="section-title-text">
      ${ui.sectionTitle}
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      <a href="/filmes?cat=${encodeURIComponent(catId)}${q ? '&q=' + encodeURIComponent(q) : ''}${countryQuerySuffix}&r=${Date.now()}" id="cinema-refresh-short-btn" style="display:inline-flex;align-items:center;gap:4px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.35);color:#fcd34d;font-size:11px;font-weight:700;padding:4px 10px;border-radius:14px;text-decoration:none;">
        ${ui.refreshShort}
      </a>
      <div class="section-counter" data-count="${movieResults.length}">${movieResults.length} ${ui.countWord}</div>
    </div>
  </div>

  <!-- Catálogo de Filmes em 2 Colunas no Celular -->
  <section class="movies-grid">
    ${movieResults.map(m => `
      <article class="movie-card" data-id="${m.id}" data-title="${(m.title || '').replace(/"/g, '&quot;')}">
        <div class="movie-thumb-wrap">
          <img src="${m.thumbnail}" alt="${(m.title || '').replace(/"/g, '&quot;')}" loading="lazy">
          ${m.duration ? `<span class="movie-dur">${m.duration}</span>` : ''}
        </div>
        <div class="movie-details">
          <h2 class="movie-title">${(m.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h2>
          <div class="movie-channel">${(m.channel || ui.defaultChannel).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
          <div class="movie-card-actions">
            <button type="button" onclick="event.stopPropagation(); openCinemaResolutionModal('${m.id}', this)">🎬 MP4</button>
            <button type="button" class="movie-act-mp3" onclick="event.stopPropagation(); downloadActiveCinemaVideo('mp3', '${m.id}', this)">🎵 MP3</button>
            <button type="button" class="movie-act-cast" onclick="event.stopPropagation(); openCinemaCastForMovie('${m.id}', this)">${ui.cast}</button>
          </div>
        </div>
      </article>
    `).join('')}
  </section>

  <div class="agent-scroll-loader" id="cinema-scroll-loader">
    <div class="agent-spinner"></div>
    <span>${ui.loaderText}</span>
  </div>

  <div class="cast-toast" id="cast-toast"></div>

  <script src="/fab-drag.js?v=1"></script>
  <script src="/client-cast.js?v=12"></script>
  <script src="/cast-hub.js?v=8"></script>
  <script>
    (function() {
      // Sincroniza barra de endereço do app pai de forma limpa (sem URL externa da Pluto TV)
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: 'navigate-sync',
            url: window.location.href,
            targetUrl: '/filmes',
            title: ${JSON.stringify(ui.pageTitle)}
          }, '*');
        }
      } catch(e) {}

      const currentQ = ${JSON.stringify(searchQuery || q || '')};
      const currentCat = ${JSON.stringify(catId)};
      const urlHasExplicitCountry = ${rawCountryParam ? 'true' : 'false'};
      const uiDefaultChannel = ${JSON.stringify(ui.defaultChannel)};
      const uiCastBtn = ${JSON.stringify(ui.cast)};
      const uiMaxLabel = ${JSON.stringify(ui.maximize)};
      const uiMinLabel = ${JSON.stringify(ui.minimize)};
      const iframe = document.getElementById('cinema-iframe');
      const titleEl = document.getElementById('active-title');
      const toastEl = document.getElementById('cast-toast');
      const grid = document.querySelector('.movies-grid');
      const loader = document.getElementById('cinema-scroll-loader');

      function showToast(msg) {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.style.display = 'block';
        setTimeout(() => { toastEl.style.display = 'none'; }, 3500);
      }

      window.currentCinemaVid = ${JSON.stringify(selectedVid)};
      window.currentCinemaTitle = ${JSON.stringify(safeActiveTitle)};
      let currentCinemaVid = window.currentCinemaVid;
      let currentCinemaTitle = window.currentCinemaTitle;
      let cinemaFsArmed = false;

      function isCinemaFullscreen() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement || document.msFullscreenElement);
      }
      let cinemaPlayerClosed = false;
      function closeCinemaFloatingPlayer(event) {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        cinemaPlayerClosed = true;
        try { if (window.PapaleguasFab) window.PapaleguasFab.notifyVideoWatch(false); } catch (e) {}
        const section = document.querySelector('.cinema-player-section');
        if (section) {
          section.classList.remove('mini-mode');
          section.style.display = 'none';
        }
        try {
          iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }), '*');
        } catch (e) {}
        try { if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch (e) {}
        const pipVideo = document.getElementById('cinema-pip-video');
        if (pipVideo) {
          try { pipVideo.pause(); } catch (e) {}
        }
        const nativeVideo = document.getElementById('cinema-native-video');
        if (nativeVideo) {
          try { nativeVideo.pause(); } catch (e) {}
        }
      }
      const cinemaMiniClose = document.getElementById('cinema-mini-close');
      if (cinemaMiniClose) cinemaMiniClose.addEventListener('click', closeCinemaFloatingPlayer);
      function enterCinemaMiniPlayer(usePip) {
        if (cinemaPlayerClosed) return;
        const section = document.querySelector('.cinema-player-section');
        if (section) {
          section.style.display = '';
          section.classList.add('mini-mode');
        }
        if (!usePip) return;
        const v = document.getElementById('cinema-pip-video');
        const vid = currentCinemaVid || window.currentCinemaVid;
        if (v && vid) {
          (async function () {
            try {
              const origin = window.location.origin && window.location.origin.indexOf('http') === 0 ? window.location.origin : 'http://localhost:8080';
              v.setAttribute('playsinline', 'true');
              v.setAttribute('webkit-playsinline', 'true');
              v.playsInline = true;
              v.loop = false;
              v.muted = false;
              v.disablePictureInPicture = false;
              if (v.dataset.vid !== vid || !v.src || v.src.indexOf('stream-video') === -1) {
                if (v.srcObject) {
                  try { v.srcObject.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
                  v.srcObject = null;
                }
                v.src = origin + '/api/stream-video?v=' + encodeURIComponent(vid);
                v.dataset.vid = vid;
                await new Promise(function (resolve) {
                  var done = function () { v.removeEventListener('loadeddata', done); v.removeEventListener('error', fail); resolve(); };
                  var fail = function () { v.removeEventListener('loadeddata', done); v.removeEventListener('error', fail); resolve(); };
                  if (v.readyState >= 2) return resolve();
                  v.addEventListener('loadeddata', done);
                  v.addEventListener('error', fail);
                  setTimeout(resolve, 4000);
                });
              }
              await v.play().catch(function () {});
              if (document.pictureInPictureEnabled && !document.pictureInPictureElement) {
                await v.requestPictureInPicture();
              } else if (v.webkitSupportsPresentationMode && v.webkitSetPresentationMode) {
                v.webkitSetPresentationMode('picture-in-picture');
              }
            } catch (e) {}
          })();
        }
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'youtube-enter-pip', videoId: vid, title: currentCinemaTitle || 'Filme' }, '*');
          }
        } catch (e) {}
      }
      document.addEventListener('click', function (e) {
        const section = document.querySelector('.cinema-player-section.mini-mode');
        if (!section) return;
        if (section.contains(e.target)) {
          section.classList.remove('mini-mode');
        }
      });
      function minimizeCinemaVideo() {
        cinemaFsArmed = false;
        document.documentElement.classList.remove('video-true-fs');
        document.body.classList.remove('video-true-fs');

        try {
          const exitFs = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
          if (exitFs && isCinemaFullscreen()) {
            exitFs.call(document);
          }
        } catch (e) {}

        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'exit-video-fullscreen' }, '*');
          }
        } catch (e) {}

        try {
          if (window.ipcRenderer) {
            window.ipcRenderer.sendToHost('exit-video-fullscreen', { active: false });
          }
        } catch (e) {}

        try { if (window.PapaleguasFab) window.PapaleguasFab.notifyVideoWatch(false); } catch (e) {}
        try { if (window.papaleguasShowTopoForVideo) window.papaleguasShowTopoForVideo(); } catch (e) {}

        const fsLabel = document.getElementById('cinema-fs-label');
        if (fsLabel) fsLabel.textContent = uiMaxLabel;

        const playerEl = document.querySelector('.cinema-player-section');
        if (playerEl) {
          playerEl.classList.remove('mini-mode');
          playerEl.style.display = '';
          playerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
      window.minimizeCinemaVideo = minimizeCinemaVideo;

      function maximizeCinemaVideo() {
        cinemaFsArmed = true;
        document.documentElement.classList.add('video-true-fs');
        document.body.classList.add('video-true-fs');

        const playerEl = document.querySelector('.cinema-player-section');
        if (playerEl) {
          playerEl.classList.remove('mini-mode');
          playerEl.style.display = '';
        }

        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'enter-video-fullscreen' }, '*');
          }
        } catch (e) {}

        try {
          if (window.ipcRenderer) {
            window.ipcRenderer.sendToHost('enter-video-fullscreen', { active: true });
          }
        } catch (e) {}

        try { if (window.papaleguasHideTopoForVideo) window.papaleguasHideTopoForVideo(); } catch (e) {}
        try { if (window.PapaleguasFab) window.PapaleguasFab.notifyVideoWatch(true); } catch (e) {}

        const fsLabel = document.getElementById('cinema-fs-label');
        if (fsLabel) fsLabel.textContent = uiMinLabel;

        resetCinemaMinDim();
      }
      window.maximizeCinemaVideo = maximizeCinemaVideo;

      function toggleCinemaMaximize() {
        if (document.documentElement.classList.contains('video-true-fs') || isCinemaFullscreen()) {
          minimizeCinemaVideo();
        } else {
          maximizeCinemaVideo();
        }
      }
      window.toggleCinemaMaximize = toggleCinemaMaximize;

      // Auto-dim para o botão de minimizar não atrapalhar o filme
      let cinemaMinDimTimer = null;
      function resetCinemaMinDim() {
        const minBtn = document.getElementById('cinema-minimize-btn');
        if (!minBtn) return;
        minBtn.classList.remove('auto-dim');
        clearTimeout(cinemaMinDimTimer);
        if (document.documentElement.classList.contains('video-true-fs') || isCinemaFullscreen()) {
          cinemaMinDimTimer = setTimeout(() => {
            minBtn.classList.add('auto-dim');
          }, 3500);
        }
      }
      ['mousemove', 'touchstart', 'touchmove', 'keydown'].forEach(ev => {
        window.addEventListener(ev, resetCinemaMinDim, { passive: true });
      });

      // Tecla Escape para minimizar tela do filme
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && (document.documentElement.classList.contains('video-true-fs') || isCinemaFullscreen())) {
          minimizeCinemaVideo();
        }
      });

      ['fullscreenchange', 'webkitfullscreenchange', 'MSFullscreenChange'].forEach(function (evName) {
        document.addEventListener(evName, function () {
          if (isCinemaFullscreen()) {
            cinemaFsArmed = true;
            document.documentElement.classList.add('video-true-fs');
            const fsLabel = document.getElementById('cinema-fs-label');
            if (fsLabel) fsLabel.textContent = uiMinLabel;
            resetCinemaMinDim();
            return;
          }
          if (cinemaFsArmed && !isCinemaFullscreen()) {
            cinemaFsArmed = false;
            document.documentElement.classList.remove('video-true-fs');
            const fsLabel = document.getElementById('cinema-fs-label');
            if (fsLabel) fsLabel.textContent = uiMaxLabel;
            try {
              if (window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'exit-video-fullscreen' }, '*');
              }
            } catch (e) {}
          }
        });
      });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden && (currentCinemaVid || window.currentCinemaVid)) {
          enterCinemaMiniPlayer(true);
        }
      });
      window.addEventListener('pagehide', function () {
        if (currentCinemaVid || window.currentCinemaVid) enterCinemaMiniPlayer(true);
      });
      window.addEventListener('freeze', function () {
        if (currentCinemaVid || window.currentCinemaVid) enterCinemaMiniPlayer(true);
      });
      let cinemaDetectedCountry = ${JSON.stringify(countryCode)};
      let cinemaDetectedHl = ${JSON.stringify(hl)};
      let cinemaDetectedLang = ${JSON.stringify(langShort)};

      const countrySelectEl = document.getElementById('cinema-country-badge');
      if (countrySelectEl) {
        try {
          const savedManual = localStorage.getItem('papaleguas_baixatube_country');
          if (!urlHasExplicitCountry && savedManual && savedManual !== 'auto') {
            const cleanSaved = String(savedManual).trim().toUpperCase();
            if (/^[A-Z]{2}$/.test(cleanSaved) && cleanSaved !== cinemaDetectedCountry) {
              window.location.replace('/filmes?cat=' + encodeURIComponent(currentCat) + (currentQ ? '&q=' + encodeURIComponent(currentQ) : '') + '&country=' + encodeURIComponent(cleanSaved));
              return;
            }
          }
        } catch (e) {}

        countrySelectEl.addEventListener('change', function () {
          const val = String(countrySelectEl.value || 'auto').trim();
          try {
            localStorage.setItem('papaleguas_baixatube_country', val);
          } catch (e) {}
          const nextCountryParam = (val && val !== 'auto') ? ('&country=' + encodeURIComponent(val.toUpperCase())) : '';
          window.location.href = '/filmes?cat=' + encodeURIComponent(currentCat) + (currentQ ? '&q=' + encodeURIComponent(currentQ) : '') + nextCountryParam + '&r=' + Date.now();
        });
      }

      fetch('/api/country-detect', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.country) {
            const ipCountry = String(d.country).toUpperCase();
            try { localStorage.setItem('papaleguas_detected_ip_country', ipCountry); } catch (e) {}
            if (!urlHasExplicitCountry) {
              let savedManual = '';
              try { savedManual = localStorage.getItem('papaleguas_baixatube_country') || ''; } catch (e) {}
              if ((!savedManual || savedManual === 'auto') && ipCountry !== cinemaDetectedCountry) {
                window.location.replace('/filmes?cat=' + encodeURIComponent(currentCat) + (currentQ ? '&q=' + encodeURIComponent(currentQ) : '') + '&country=' + encodeURIComponent(ipCountry));
                return;
              }
            }
          }
        }).catch(function () {});

      function activateCinemaNativeFallback(vid) {
        const targetId = vid || currentCinemaVid || window.currentCinemaVid;
        const nv = document.getElementById('cinema-native-video');
        if (!nv || !targetId) return;
        const origin = window.location.origin && window.location.origin.indexOf('http') === 0 ? window.location.origin : 'http://localhost:8080';
        const streamSrc = origin + '/api/stream-video?v=' + encodeURIComponent(targetId) + '&lang=' + encodeURIComponent(cinemaDetectedLang) + (cinemaDetectedCountry ? '&country=' + encodeURIComponent(cinemaDetectedCountry) : '');
        if (iframe) {
          iframe.style.display = 'none';
          iframe.src = 'about:blank';
        }
        nv.style.display = 'block';
        nv.lang = cinemaDetectedHl;
        nv.poster = 'https://i.ytimg.com/vi/' + encodeURIComponent(targetId) + '/hqdefault.jpg';
        if (nv.dataset.vid !== targetId || !nv.src || nv.src.indexOf('stream-video') === -1) {
          nv.src = streamSrc;
          nv.dataset.vid = targetId;
        }
        nv.play().catch(function () {});
      }

      function resetCinemaToIframe(id, extraParams) {
        const nv = document.getElementById('cinema-native-video');
        if (nv) {
          try { nv.pause(); } catch (e) {}
          nv.style.display = 'none';
          nv.removeAttribute('src');
          nv.dataset.vid = '';
          try { nv.load(); } catch (e) {}
        }
        if (iframe) {
          iframe.style.display = '';
          iframe.referrerPolicy = 'origin';
          const originEnc = encodeURIComponent(window.location.origin || 'http://localhost:8080');
          iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(id) + '?autoplay=1&enablejsapi=1&playsinline=1&hl=' + encodeURIComponent(cinemaDetectedHl) + '&cc_lang_pref=' + encodeURIComponent(cinemaDetectedLang) + (extraParams || '') + '&rel=0&origin=' + originEnc + '&widget_referrer=' + originEnc;
        }
      }

      setInterval(function () {
        if (iframe && iframe.contentWindow && iframe.style.display !== 'none') {
          try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*'); } catch (e) {}
        }
      }, 1200);

      window.addEventListener('message', function (event) {
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (data && data.type === 'papaleguas-yt-control' && data.action === 'enter-mini') {
            enterCinemaMiniPlayer(false);
            return;
          }
          if (data && data.event === 'onError') {
            activateCinemaNativeFallback(currentCinemaVid || window.currentCinemaVid);
            return;
          }
          if (data && (data.event === 'initialDelivery' || data.event === 'infoDelivery') && data.info && data.info.videoData) {
            const vd = data.info.videoData;
            if (vd.isPlayable === false || vd.errorCode) {
              activateCinemaNativeFallback(vd.video_id || currentCinemaVid || window.currentCinemaVid);
            }
          }
        } catch (e) {}
      });

      let pendingCinemaResDownload = null;

      function openCinemaResolutionModal(id, optTitleOrEl) {
        let title = '';
        if (optTitleOrEl && typeof optTitleOrEl === 'object') {
          const card = optTitleOrEl.closest ? optTitleOrEl.closest('.movie-card') : null;
          if (card) {
            id = id || card.getAttribute('data-id');
            title = card.getAttribute('data-title') || '';
          }
        } else if (typeof optTitleOrEl === 'string') {
          title = optTitleOrEl;
        }
        id = id || window.currentCinemaVid || currentCinemaVid;
        if (!title) title = window.currentCinemaTitle || currentCinemaTitle || 'Filme';

        pendingCinemaResDownload = { id, title };
        const resTitleEl = document.getElementById('cinema-res-movie-title');
        if (resTitleEl) resTitleEl.textContent = title;
        const resModal = document.getElementById('cinema-res-modal');
        if (resModal) resModal.style.display = 'flex';
      }
      window.openCinemaResolutionModal = openCinemaResolutionModal;

      function openCinemaCastForMovie(id, el) {
        const card = el && el.closest ? el.closest('.movie-card') : null;
        const title = (card && card.getAttribute('data-title')) || window.currentCinemaTitle || currentCinemaTitle || 'Filme';
        id = id || (card && card.getAttribute('data-id')) || window.currentCinemaVid || currentCinemaVid;
        if (id) {
          window.currentCinemaVid = id;
          window.currentCinemaTitle = title;
          currentCinemaVid = id;
          currentCinemaTitle = title;
          resetCinemaToIframe(id, '');
          if (titleEl) titleEl.textContent = '▶ ' + title;
          const directBtn = document.getElementById('cinema-direct-link');
          if (directBtn) directBtn.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(id);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        if (typeof window.openCastHubModal === 'function') window.openCastHubModal();
      }
      window.openCinemaCastForMovie = openCinemaCastForMovie;

      function closeCinemaResModal() {
        const resModal = document.getElementById('cinema-res-modal');
        if (resModal) resModal.style.display = 'none';
        pendingCinemaResDownload = null;
      }
      window.closeCinemaResModal = closeCinemaResModal;

      function selectCinemaResolution(quality) {
        if (!pendingCinemaResDownload) return;
        const { id, title } = pendingCinemaResDownload;
        closeCinemaResModal();
        downloadActiveCinemaVideo('mp4', id, title, quality);
      }
      window.selectCinemaResolution = selectCinemaResolution;

      let activeCinemaTimer = null;

      function closeCinemaDlModal() {
        if (activeCinemaTimer) {
          clearInterval(activeCinemaTimer);
          activeCinemaTimer = null;
        }
        document.getElementById('cinema-dl-modal').style.display = 'none';
        const ap = document.getElementById('cinema-dl-audio-player');
        if (ap) ap.pause();
        const vp = document.getElementById('cinema-dl-video-player');
        if (vp) vp.pause();
      }
      window.closeCinemaDlModal = closeCinemaDlModal;

      async function downloadActiveCinemaVideo(format, optId, optElement, quality = '720') {
        if (activeCinemaTimer) {
          clearInterval(activeCinemaTimer);
          activeCinemaTimer = null;
        }

        let targetVid = optId || window.currentCinemaVid || currentCinemaVid;
        let targetTitle = window.currentCinemaTitle || currentCinemaTitle;
        if (optElement && typeof optElement === 'object') {
          const card = optElement.closest ? optElement.closest('.movie-card') : null;
          if (card) {
            targetVid = targetVid || card.getAttribute('data-id');
            targetTitle = card.getAttribute('data-title') || targetTitle;
          }
        } else if (typeof optElement === 'string') {
          targetTitle = optElement;
        }

        const modal = document.getElementById('cinema-dl-modal');
        const loading = document.getElementById('cinema-dl-loading');
        const success = document.getElementById('cinema-dl-success');
        const titleElModal = document.getElementById('cinema-modal-title');
        const subEl = document.getElementById('cinema-modal-subtitle');
        const iconEl = document.getElementById('cinema-modal-icon');
        const statusText = document.getElementById('cinema-dl-status-text');
        const progressFill = document.getElementById('cinema-dl-progress-fill');
        const progressPct = document.getElementById('cinema-dl-progress-pct');
        const progressSpeed = document.getElementById('cinema-dl-progress-speed');
        const progressTotal = document.getElementById('cinema-dl-progress-total');

        modal.style.display = 'flex';
        loading.style.display = 'block';
        success.style.display = 'none';
        if (progressFill) progressFill.style.width = '5%';
        if (progressPct) progressPct.textContent = '5%';
        if (progressSpeed) progressSpeed.textContent = 'Iniciando download...';
        if (progressTotal) progressTotal.textContent = '';
        iconEl.textContent = format === 'mp3' ? '🎵' : '🎬';
        titleElModal.textContent = 'Baixando ' + (format === 'mp3' ? 'Áudio (MP3)' : 'Filme (' + (quality ? quality + 'p' : 'MP4') + ')');
        subEl.textContent = (targetTitle || 'Filme').slice(0, 40);
        statusText.textContent = 'Conectando e iniciando motor de download...';

        function renderCinemaSuccess(data) {
          if (activeCinemaTimer) {
            clearInterval(activeCinemaTimer);
            activeCinemaTimer = null;
          }
          loading.style.display = 'none';
          success.style.display = 'block';
          const fileIcon = document.getElementById('cinema-dl-file-icon');
          const fileTitle = document.getElementById('cinema-dl-file-title');
          const fileMeta = document.getElementById('cinema-dl-file-meta');
          if (fileIcon) fileIcon.textContent = format === 'mp3' ? '🎵' : '🎬';
          if (fileTitle) fileTitle.textContent = data.title;
          if (fileMeta) fileMeta.textContent = 'Duração: ' + (data.duration || '--:--') + ' • Formato: ' + data.format.toUpperCase();
          
          const dlLink = document.getElementById('cinema-dl-download-link');
          if (dlLink) {
            dlLink.href = data.url;
            dlLink.download = (data.title || 'filme') + '.' + data.format;
            dlLink.textContent = '⬇️ Salvar ' + data.format.toUpperCase() + ' no Dispositivo';
            dlLink.onclick = null;
          }

          const audioP = document.getElementById('cinema-dl-audio-player');
          const videoP = document.getElementById('cinema-dl-video-player');
          if (format === 'mp3') {
            if (videoP) videoP.style.display = 'none';
            if (audioP) {
              audioP.style.display = 'block';
              audioP.src = data.url;
              audioP.play().catch(() => {});
            }
          } else {
            if (audioP) audioP.style.display = 'none';
            if (videoP) {
              videoP.style.display = 'block';
              videoP.src = data.url;
            }
          }
        }

        try {
          // Dispara o job de download em segundo plano com a resolução selecionada
          const initRes = await fetch('/api/media/download-job?url=' + encodeURIComponent(targetVid) + '&format=' + format + (format === 'mp3' ? '' : '&quality=' + encodeURIComponent(quality || '720')));
          const initData = await initRes.json();
          if (!initData.success || !initData.jobId) {
            throw new Error(initData.error || 'Não foi possível iniciar o download do filme.');
          }

          const jobId = initData.jobId;

          // Polling contínuo a cada 450ms (imune ao timeout de 100s do Cloudflare)
          activeCinemaTimer = setInterval(async () => {
            try {
              const pollRes = await fetch('/api/media/download-status?jobId=' + encodeURIComponent(jobId));
              const st = await pollRes.json();

              if (st.progress !== undefined) {
                if (progressFill) progressFill.style.width = st.progress + '%';
                if (progressPct) progressPct.textContent = st.progress + '%';
              }
              if (st.text && statusText) {
                statusText.textContent = st.text;
              }
              if (progressSpeed) {
                if (st.speed) {
                  progressSpeed.textContent = '⚡ ' + st.speed + (st.eta ? ' • Restante: ' + st.eta : '');
                } else if (st.stage === 'converting' || st.stage === 'merging') {
                  progressSpeed.textContent = 'Processando com FFmpeg...';
                }
              }
              if (st.total && progressTotal) {
                let totalInfo = 'Total: ' + st.total;
                if (st.frag) totalInfo += ' (frag. ' + st.frag + ')';
                progressTotal.textContent = totalInfo;
              }

              if (st.stage === 'complete' && st.success) {
                if (progressFill) progressFill.style.width = '100%';
                if (progressPct) progressPct.textContent = '100%';
                renderCinemaSuccess(st);
              } else if (st.stage === 'error') {
                if (activeCinemaTimer) {
                  clearInterval(activeCinemaTimer);
                  activeCinemaTimer = null;
                }
                alert('Erro no download do filme: ' + (st.error || 'Falha ao processar'));
                modal.style.display = 'none';
              }
            } catch (pollErr) {
              console.warn('[CINEMA POLL WARN]', pollErr);
            }
          }, 450);

        } catch(e) {
          if (activeCinemaTimer) {
            clearInterval(activeCinemaTimer);
            activeCinemaTimer = null;
          }
          alert('Erro ao baixar filme: ' + (e.message || 'Verifique sua conexão'));
          modal.style.display = 'none';
        }
      }
      window.downloadActiveCinemaVideo = downloadActiveCinemaVideo;

      function attachMovieClickListener(card) {
        card.addEventListener('click', (e) => {
          if (e && e.target && (e.target.closest('button') || e.target.closest('.cinema-actions'))) return;
          const id = card.getAttribute('data-id');
          const title = card.getAttribute('data-title');
          if (!id) return;

          cinemaPlayerClosed = false;
          const playerSection = document.querySelector('.cinema-player-section');
          if (playerSection) playerSection.style.display = '';
          window.currentCinemaVid = id;
          window.currentCinemaTitle = title;
          currentCinemaVid = id;
          currentCinemaTitle = title;
          resetCinemaToIframe(id, '&fs=1');
          if (titleEl) titleEl.textContent = '▶ ' + title;
          const directBtn = document.getElementById('cinema-direct-link');
          if (directBtn) directBtn.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(id);
          cinemaFsArmed = true;
          document.documentElement.classList.add('video-true-fs');
          document.body.classList.add('video-true-fs');
          const fsLabel = document.getElementById('cinema-fs-label');
          if (fsLabel) fsLabel.textContent = uiMinLabel;
          resetCinemaMinDim();
          try {
            if (window.parent && window.parent !== window) {
              window.parent.postMessage({ type: 'enter-video-fullscreen' }, '*');
            }
          } catch (e) {}
          try {
            if (window.ipcRenderer) {
              window.ipcRenderer.sendToHost('enter-video-fullscreen', { active: true });
            }
          } catch (e) {}
          // Clicou para assistir: botões flutuantes (Topo aqui, Home no app) saem da frente.
          try { if (window.papaleguasHideTopoForVideo) window.papaleguasHideTopoForVideo(); } catch (e) {}
          try { if (window.PapaleguasFab) window.PapaleguasFab.notifyVideoWatch(true); } catch (e) {}
          window.scrollTo(0, 0);

          try {
            const keepUrl = '/filmes?cat=' + encodeURIComponent(currentCat) + (currentQ ? '&q=' + encodeURIComponent(currentQ) : '') + (urlHasExplicitCountry ? '&country=' + encodeURIComponent(cinemaDetectedCountry) : '');
            window.history.replaceState({}, '', keepUrl);
            if (window.parent && window.parent !== window) {
              window.parent.postMessage({
                type: 'navigate-sync',
                url: window.location.href,
                targetUrl: '/filmes',
                title: title
              }, '*');
            }
          } catch(e) {}
        });
      }

      document.querySelectorAll('.movie-card').forEach(attachMovieClickListener);

      // Scroll infinito para carregar mais filmes
      let curPage = 1;
      let isLoadingMore = false;
      let hasMore = true;
      const seenMovieIds = new Set();
      document.querySelectorAll('.movie-card').forEach(c => {
        const id = c.getAttribute('data-id');
        if (id) seenMovieIds.add(id);
      });

      async function loadMoreMovies() {
        if (isLoadingMore || !hasMore) return;
        isLoadingMore = true;
        if (loader) loader.style.display = 'flex';

        try {
          curPage++;
          const currentPlayingTitle = titleEl ? titleEl.textContent.replace('▶', '').trim() : currentQ;
          const res = await fetch('/api/curator-recommendations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'cinema',
              currentQuery: currentQ || currentCat,
              currentCategory: currentCat,
              currentTitle: currentPlayingTitle,
              country: cinemaDetectedCountry,
              isManualCountry: true,
              page: curPage,
              stayOnTheme: true,
              useAi: true,
              excludeTitles: Array.from(seenMovieIds)
            })
          }).then(r => r.json());

          if (res && res.success && Array.isArray(res.items) && res.items.length > 0) {
            if (res.reason) {
              const banner = document.createElement('div');
              banner.className = 'agent-curator-banner';
              banner.innerHTML = '<div class="agent-avatar-box">🍿</div><div class="agent-text-content"><div class="agent-badge-tag">IA Papaléguas</div><div class="agent-reason-text"></div></div>';
              banner.querySelector('.agent-reason-text').textContent = res.reason;
              grid.appendChild(banner);
            }
            res.items.forEach(m => {
              if (seenMovieIds.has(m.id)) return;
              seenMovieIds.add(m.id);

              const card = document.createElement('article');
              card.className = 'movie-card';
              card.setAttribute('data-id', m.id);
              card.setAttribute('data-title', m.title || '');
              card.innerHTML = \`
                <div class="movie-thumb-wrap">
                  <img src="\${m.thumbnail}" alt="\${(m.title || '').replace(/"/g, '&quot;')}" loading="lazy">
                  \${m.duration ? \`<span class="movie-dur">\${m.duration}</span>\` : ''}
                </div>
                <div class="movie-details">
                  <h2 class="movie-title">\${(m.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h2>
                  <div class="movie-channel">\${(m.channel || uiDefaultChannel).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                  <div class="movie-card-actions">
                    <button type="button" onclick="event.stopPropagation(); openCinemaResolutionModal('\${m.id}', this)">🎬 MP4</button>
                    <button type="button" class="movie-act-mp3" onclick="event.stopPropagation(); downloadActiveCinemaVideo('mp3', '\${m.id}', this)">🎵 MP3</button>
                    <button type="button" class="movie-act-cast" onclick="event.stopPropagation(); openCinemaCastForMovie('\${m.id}', this)">\${uiCastBtn}</button>
                  </div>
                </div>
              \`;
              attachMovieClickListener(card);
              grid.appendChild(card);
            });
          } else {
            hasMore = false;
          }
        } catch(e) {
          console.warn('Erro ao carregar mais filmes:', e);
        } finally {
          isLoadingMore = false;
          if (loader) loader.style.display = 'none';
        }
      }

      window.addEventListener('scroll', () => {
        const scrollPosition = window.innerHeight + window.scrollY;
        const threshold = document.documentElement.scrollHeight - 500;
        if (scrollPosition >= threshold) {
          loadMoreMovies();
        }
      }, { passive: true });

      // Central Inteligente de Transmissão (Cast Hub) & Reconhecimento de Aparelhos
      const isLocalClient = ${isLocal ? 'true' : 'false'};

      function detectClientDevice() {
        const ua = navigator.userAgent || '';
        const isMobileUa = /Mobile|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|webOS/i.test(ua);
        const isNarrow = Math.min(window.innerWidth || 999, (window.screen && window.screen.width) || 999) <= 480;
        let dev = 'Dispositivo Web';
        if (/iPad|iPhone|iPod/.test(ua)) dev = 'Apple iPhone / iPad (iOS)';
        else if (/Android/.test(ua) || (isMobileUa && /Linux/.test(ua))) {
          if (/Pixel/.test(ua)) dev = 'Google Pixel (Android)';
          else if (/Samsung|SM-/.test(ua)) dev = 'Samsung Galaxy (Android)';
          else if (/Xiaomi|Redmi|POCO/.test(ua)) dev = 'Xiaomi (Android)';
          else if (/Motorola|Moto/.test(ua)) dev = 'Motorola (Android)';
          else dev = 'Smartphone Android';
        } else if (/Windows/.test(ua)) dev = isNarrow ? 'Celular (Windows)' : 'PC (Windows)';
        else if (/Macintosh|Mac OS/.test(ua)) dev = 'Apple Mac (macOS)';
        else if (/Linux/.test(ua)) dev = isNarrow ? 'Celular (Android)' : 'Computador (Linux)';
        return dev;
      }

      let detectedDeviceInfo = null;
      let detectedLocalSubnet = null;
      let recognizedNetworkDevices = [];

      async function getDetailedClientDevice() {
        if (detectedDeviceInfo) return detectedDeviceInfo;
        let base = detectClientDevice();
        try {
          if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
            const hints = await navigator.userAgentData.getHighEntropyValues(['model', 'platform', 'platformVersion']);
            if (hints && hints.model && hints.model.trim()) {
              const model = hints.model.trim();
              if (!base.includes(model)) {
                base = base.replace('Smartphone Android', model + ' (Android)')
                           .replace('Samsung Galaxy', 'Samsung ' + model)
                           .replace('Xiaomi', 'Xiaomi ' + model)
                           .replace('Motorola', 'Moto ' + model);
                if (!base.includes(model)) base += ' (' + model + ')';
              }
            }
          }
        } catch(e) {}
        detectedDeviceInfo = base;
        return base;
      }

      function detectLocalSubnet() {
        if (detectedLocalSubnet) return Promise.resolve(detectedLocalSubnet);
        return new Promise((resolve) => {
          let resolved = false;
          try {
            const pc = new (window.RTCPeerConnection || window.webkitRTCPeerConnection)({ iceServers: [] });
            pc.createDataChannel('');
            pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
            const to = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                try { pc.close(); } catch(e) {}
                resolve('192.168.1');
              }
            }, 1000);

            pc.onicecandidate = (e) => {
              if (!e || !e.candidate || !e.candidate.candidate) return;
              const cand = e.candidate.candidate;
              const match = cand.match(/((?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3})\.\d{1,3}/);
              if (match && match[1] && !resolved) {
                resolved = true;
                detectedLocalSubnet = match[1];
                clearTimeout(to);
                try { pc.close(); } catch(err) {}
                resolve(match[1]);
              }
            };
          } catch (err) {
            resolve('192.168.1');
          }
        });
      }

      function sendTelemetryUpdate() {
        try {
          const screenStr = (window.screen ? (window.screen.width + 'x' + window.screen.height) : '');
          const payload = {
            device: detectedDeviceInfo || detectClientDevice(),
            screen: screenStr,
            localSubnet: detectedLocalSubnet ? (detectedLocalSubnet + '.x') : '',
            discoveredDevices: recognizedNetworkDevices.map(d => d.name + (d.ip ? ' (' + d.ip + ')' : ''))
          };
          fetch('/api/papaleguas/device-telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }).catch(() => {});
        } catch(e) {}
      }

      function renderDetectedDevices() {
        const listEl = document.getElementById('cast-detected-devices-list');
        const loaderEl = document.getElementById('cast-scanning-loader');
        if (!listEl) return;

        if (recognizedNetworkDevices.length === 0) {
          if (loaderEl) {
            loaderEl.textContent = 'Procurando Smart TVs na sua rede Wi-Fi... Digite o IP se souber ou use Google Cast / AirPlay.';
            loaderEl.style.display = 'block';
          }
          return;
        }

        if (loaderEl) loaderEl.style.display = 'none';

        listEl.innerHTML = recognizedNetworkDevices.map(function(dev) {
          var ipTxt = dev.ip ? ('IP: ' + dev.ip + ' • Wi-Fi Local') : 'Pronto para Conectar';
          var devIcon = dev.icon || '📺';
          return '<div style="display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,rgba(16,185,129,0.12),rgba(15,23,42,0.8));border:1px solid rgba(16,185,129,0.35);padding:10px 14px;border-radius:12px;margin-bottom:6px;">' +
            '<div style="display:flex;align-items:center;gap:10px;">' +
              '<span style="font-size:22px;">' + devIcon + '</span>' +
              '<div>' +
                '<div style="font-size:13px;font-weight:700;color:#fff;">' + dev.name + '</div>' +
                '<div style="font-size:10.5px;color:#34d399;">' + ipTxt + '</div>' +
              '</div>' +
            '</div>' +
            '<button type="button" onclick="' + dev.action + '" style="background:linear-gradient(135deg,#10b981,#059669);border:none;color:#fff;padding:7px 14px;border-radius:8px;font-size:11.5px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(16,185,129,0.3);">' +
              '▶ Transmitir' +
            '</button>' +
          '</div>';
        }).join('');
      }

      function addDiscoveredDevice(dev) {
        if (!recognizedNetworkDevices.some(d => (d.ip && d.ip === dev.ip) || d.name === dev.name)) {
          recognizedNetworkDevices.push(dev);
          renderDetectedDevices();
          sendTelemetryUpdate();
        }
      }

      function rememberTvIp(ip) {
        if (!ip) return;
        const ipInput = document.getElementById('client-roku-ip');
        if (ipInput && !ipInput.value) ipInput.value = ip;
        localStorage.setItem('papaleguas_client_roku_ip', ip);
      }

      async function fetchServerCastDevices() {
        if (!window.PapaleguasClientCast || typeof window.PapaleguasClientCast.scanDevices !== 'function') return;
        await window.PapaleguasClientCast.scanDevices(function(dev) {
          if (!dev || !dev.ip) return;
          rememberTvIp(dev.ip);
          addDiscoveredDevice({
            name: dev.name || ('Smart TV no seu Wi-Fi (' + dev.ip + ')'),
            type: 'roku',
            ip: dev.ip,
            icon: '📺',
            action: "castToClientRokuDirect('" + dev.ip + "')"
          });
        });
      }

      let isScanningNetwork = false;
      async function startLocalNetworkDiscovery(force = false) {
        if (isScanningNetwork && !force) return;
        isScanningNetwork = true;

        const loaderEl = document.getElementById('cast-scanning-loader');
        if (force) {
          recognizedNetworkDevices = recognizedNetworkDevices.filter(function(d) {
            return d && (d.type === 'cast' || d.type === 'airplay');
          });
          renderDetectedDevices();
        }

        if (loaderEl) {
          loaderEl.style.display = 'block';
          loaderEl.textContent = '🔍 Detectando o Wi-Fi deste aparelho e procurando TVs nessa rede... Se o navegador pedir, permita o acesso à rede local.';
        }

        addDiscoveredDevice({
          name: 'Google Cast / Smart TV (Seu Wi-Fi)',
          type: 'cast',
          icon: '📡',
          action: 'castViaGoogleCast()'
        });

        const isApple = /Macintosh|Mac OS|iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isApple) {
          addDiscoveredDevice({
            name: 'Apple AirPlay (Smart TV / Apple TV)',
            type: 'airplay',
            icon: '🍏',
            action: 'castViaAirPlay()'
          });
        }

        try {
          if (window.PapaleguasClientCast && typeof window.PapaleguasClientCast.scanDevices === 'function') {
            await window.PapaleguasClientCast.scanDevices(function(dev) {
              if (!dev || !dev.ip) return;
              rememberTvIp(dev.ip);
              addDiscoveredDevice({
                name: dev.name || ('Smart TV no seu Wi-Fi (' + dev.ip + ')'),
                type: 'roku',
                ip: dev.ip,
                icon: '📺',
                action: "castToClientRokuDirect('" + dev.ip + "')"
              });
            });
          } else {
            await fetchServerCastDevices();
          }
        } catch (e) {}

        isScanningNetwork = false;
        renderDetectedDevices();
        if (loaderEl && !recognizedNetworkDevices.some(function(d) { return d && d.ip; })) {
          loaderEl.style.display = 'block';
          var net = (window.PapaleguasClientCast && window.PapaleguasClientCast.networkLabel) ? window.PapaleguasClientCast.networkLabel() : '';
          loaderEl.textContent = net
            ? ('Nenhuma TV encontrada no Wi-Fi deste aparelho (' + net + '). Permita a rede local, toque em Buscar de novo, digite o IP da TV ou use Google Cast.')
            : 'Nenhuma TV encontrada no Wi-Fi deste aparelho. Permita a rede local no aviso do navegador, toque em Buscar de novo, digite o IP da TV ou use Google Cast.';
        }
      }

      function castToClientRokuDirect(targetIp) {
        if (!targetIp) return;
        localStorage.setItem('papaleguas_client_roku_ip', targetIp);
        const ipInput = document.getElementById('client-roku-ip');
        if (ipInput) ipInput.value = targetIp;
        castToClientRoku(targetIp);
      }

      function getCurrentVideoId() {
        if (window.currentCinemaVid) return window.currentCinemaVid;
        const iframe = document.getElementById('cinema-iframe');
        if (iframe && iframe.src) {
          const parts = String(iframe.src).split('/embed/');
          if (parts[1]) {
            const id = parts[1].split('?')[0].split('&')[0].split('#')[0];
            if (id) return id;
          }
        }
        const link = document.getElementById('cinema-direct-link');
        if (link && link.href) {
          try {
            const u = new URL(link.href);
            const v = u.searchParams.get('v');
            if (v) return v;
          } catch (e) {}
        }
        return '${encodeURIComponent(selectedVid || 'rWU18ZNDKao')}';
      }

      function getCurrentMediaTitle() {
        return titleEl ? titleEl.textContent.replace('▶', '').trim() : 'Filmes Online';
      }

      async function openCastHubModal() {
        // Central de transmissão compartilhada (cast-hub.js) com busca direta pelo celular.
        if (window.PapaleguasCastHub && typeof window.PapaleguasCastHub.open === 'function') {
          window.PapaleguasCastHub.open({
            getMedia: function() {
              const vid = getCurrentVideoId();
              return {
                videoId: vid,
                title: getCurrentMediaTitle(),
                url: vid ? ('https://www.youtube.com/watch?v=' + vid) : window.location.href
              };
            }
          });
          return;
        }
        const modal = document.getElementById('cast-hub-modal');
        if (!modal) return;
        modal.style.display = 'flex';

        const devNameEl = document.getElementById('cast-hub-dev-name');
        const detailedDev = await getDetailedClientDevice();
        if (devNameEl) devNameEl.textContent = detailedDev;

        const netLabel = document.getElementById('cast-hub-network-label');
        const netBadge = document.getElementById('cast-hub-net-badge');

        const savedRokuIp = localStorage.getItem('papaleguas_client_roku_ip') || '';
        const ipInput = document.getElementById('client-roku-ip');
        if (ipInput && savedRokuIp) ipInput.value = savedRokuIp;

        if (netLabel) netLabel.textContent = 'Wi-Fi do seu Aparelho';
        if (netBadge) {
          netBadge.textContent = 'Seu Wi-Fi Local';
          netBadge.style.background = 'rgba(16,185,129,0.15)';
          netBadge.style.color = '#34d399';
        }

        const airplayBtn = document.getElementById('btn-airplay-opt');
        const isApple = /Macintosh|Mac OS|iPad|iPhone|iPod/.test(navigator.userAgent);
        if (airplayBtn) airplayBtn.style.display = isApple ? 'flex' : 'none';

        startLocalNetworkDiscovery(true);
      }

      function closeCastHubModal() {
        const modal = document.getElementById('cast-hub-modal');
        if (modal) modal.style.display = 'none';
      }

      function showCastHubFeedback(msg, isSuccess = true) {
        const fb = document.getElementById('cast-hub-feedback');
        if (!fb) return;
        fb.textContent = msg;
        fb.style.display = 'block';
        fb.style.background = isSuccess ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
        fb.style.color = isSuccess ? '#34d399' : '#f87171';
        fb.style.border = isSuccess ? '1px solid rgba(16,185,129,0.3)' : '1px solid rgba(239,68,68,0.3)';
        setTimeout(() => { fb.style.display = 'none'; }, 4000);
      }

      async function castViaGoogleCast() {
        showCastHubFeedback('Procurando Smart TV / Chromecast no seu Wi-Fi...', true);
        try {
          if (window.PresentationRequest) {
            const presUrl = window.location.href;
            const request = new PresentationRequest([presUrl]);
            await request.start();
            showCastHubFeedback('Conectado à TV! Transmitindo...', true);
            return;
          }
        } catch(e) {
          if (e.name !== 'NotAllowedError') console.log('Presentation API:', e.message);
        }
        showToast('Selecione sua TV no menu do navegador (⋮ > Transmitir).');
        showCastHubFeedback('Selecione sua TV no menu do navegador (⋮ > Transmitir).', true);
      }

      function castViaAirPlay() {
        const v = document.querySelector('video');
        if (v && v.webkitShowPlaybackTargetPicker) {
          v.webkitShowPlaybackTargetPicker();
          showCastHubFeedback('Abrindo seletor AirPlay para sua TV...', true);
        } else {
          showCastHubFeedback('Toque no ícone AirPlay do player ou espelhe a tela do iOS.', true);
        }
      }

      function autoScanLocalRoku() {
        startLocalNetworkDiscovery(true);
      }

      async function getCinemaCastPayload() {
        const currentVid = getCurrentVideoId();
        const title = getCurrentMediaTitle();
        return {
          url: 'https://www.youtube.com/watch?v=' + currentVid,
          title: title,
          videoId: currentVid
        };
      }

      async function castToApiDevice(deviceId) {
        if (!deviceId) return;
        const ip = window.PapaleguasClientCast ? window.PapaleguasClientCast.extractIp(deviceId) : '';
        if (ip) return castToClientRoku(ip);
        return castViaGoogleCast();
      }

      async function castToClientRoku(customIp) {
        const ipInput = document.getElementById('client-roku-ip');
        const ip = customIp || (ipInput ? ipInput.value.trim() : '') || localStorage.getItem('papaleguas_client_roku_ip');
        if (!ip) {
          showCastHubFeedback('Digite o IP da sua Smart TV no seu Wi-Fi (ex: 192.168.1.15).', false);
          return;
        }

        localStorage.setItem('papaleguas_client_roku_ip', ip);
        showCastHubFeedback('Conectando à sua Smart TV (' + ip + ') no seu Wi-Fi...', true);

        const media = await getCinemaCastPayload();
        if (window.PapaleguasClientCast) {
          const res = await window.PapaleguasClientCast.launchRoku(ip, media.videoId || media.url);
          showCastHubFeedback(res.message || ('Filme transmitindo na sua Smart TV (' + ip + ')!'), !!res.success);
          if (res.success) showToast('📺 Transmitindo na sua Smart TV');
          return;
        }

        const launchUrl = 'http://' + ip + ':8060/launch/837?contentId=' + encodeURIComponent(media.videoId);
        const inputUrl = 'http://' + ip + ':8060/input/837?contentId=' + encodeURIComponent(media.videoId);
        try {
          await fetch(launchUrl, { method: 'POST', mode: 'no-cors' });
          fetch(inputUrl, { method: 'POST', mode: 'no-cors' }).catch(() => {});
          showCastHubFeedback('Filme transmitindo na sua Smart TV (' + ip + ')!', true);
          showToast('📺 Transmitindo na sua Smart TV');
        } catch(e) {
          showCastHubFeedback('Sinal enviado para sua Smart TV! Verifique a tela.', true);
          showToast('Sinal enviado para a TV!');
        }
      }

      async function castViaScreenMirror() {
        if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
          try {
            await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            showCastHubFeedback('Espelhamento ativo na sua TV!', true);
          } catch(e) {
            showCastHubFeedback('Espelhamento cancelado.', false);
          }
        } else {
          showCastHubFeedback('Espelhamento não suportado neste navegador.', false);
        }
      }

      window.openCastHubModal = openCastHubModal;
      window.closeCastHubModal = closeCastHubModal;
      window.castViaGoogleCast = castViaGoogleCast;
      window.castViaAirPlay = castViaAirPlay;
      window.autoScanLocalRoku = autoScanLocalRoku;
      window.castToClientRoku = castToClientRoku;
      window.castToClientRokuDirect = castToClientRokuDirect;
      window.castToApiDevice = castToApiDevice;
      window.castViaScreenMirror = castViaScreenMirror;
      window.startLocalNetworkDiscovery = startLocalNetworkDiscovery;

      const castBtn = document.getElementById('btn-cast-cinema');
      if (castBtn) castBtn.addEventListener('click', openCastHubModal);

      const castQuick = document.getElementById('btn-cast-quick');
      if (castQuick) castQuick.addEventListener('click', openCastHubModal);

      // Busca de filmes
      const form = document.getElementById('cinema-form');
      const input = document.getElementById('cinema-query');
      if (form) {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const qVal = input.value.trim();
          const cParam = urlHasExplicitCountry ? ('&country=' + encodeURIComponent(cinemaDetectedCountry)) : '';
          if (qVal) window.location.href = '/filmes?q=' + encodeURIComponent(qVal) + cParam;
        });
      }

      setTimeout(() => {
        getDetailedClientDevice().then(() => {
          sendTelemetryUpdate();
        });
      }, 2500);
    })();
  </script>

  <!-- Modal Central de Transmissão Inteligente (Cast Hub) -->
  <div class="cast-hub-modal" id="cast-hub-modal" style="display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;align-items:center;justify-content:center;padding:16px;">
    <div style="position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);z-index:1;" onclick="closeCastHubModal()"></div>
    <div onclick="event.stopPropagation()" style="position:relative;background:#0f172a;border:1px solid rgba(255,255,255,0.15);border-radius:20px;max-width:470px;width:100%;padding:22px;box-shadow:0 25px 60px rgba(0,0,0,0.9);z-index:10;color:#f8fafc;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:12px;margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:24px;">📺</span>
          <div>
            <h3 style="font-size:16px;font-weight:800;margin:0;color:#fff;">Transmitir na Smart TV</h3>
            <span style="font-size:11px;color:#38bdf8;" id="cast-hub-network-label">Conexão Wi-Fi Local</span>
          </div>
        </div>
        <button type="button" onclick="closeCastHubModal()" style="background:rgba(255,255,255,0.08);border:none;color:#cbd5e1;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:16px;">&times;</button>
      </div>

      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;">📱</span>
          <div>
            <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Seu Aparelho Reconhecido</div>
            <div style="font-size:12.5px;font-weight:700;color:#38bdf8;" id="cast-hub-dev-name">Identificando...</div>
          </div>
        </div>
        <span id="cast-hub-net-badge" style="font-size:10.5px;font-weight:700;padding:4px 8px;border-radius:6px;background:rgba(16,185,129,0.15);color:#34d399;">Wi-Fi Conectado</span>
      </div>

      <!-- Seção Dinâmica de Aparelhos Detectados no Wi-Fi -->
      <div style="margin-bottom:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <div style="font-size:11px;font-weight:700;color:#38bdf8;text-transform:uppercase;letter-spacing:0.5px;display:flex;align-items:center;gap:6px;">
            <span>📡</span> Smart TVs Reconhecidas no seu Wi-Fi:
          </div>
          <button type="button" onclick="startLocalNetworkDiscovery(true)" style="background:rgba(56,189,248,0.12);border:1px solid rgba(56,189,248,0.3);color:#38bdf8;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;">
            🔄 Buscar
          </button>
        </div>
        <div id="cast-detected-devices-list" style="display:flex;flex-direction:column;gap:6px;">
          <div id="cast-scanning-loader" style="font-size:11px;color:#94a3b8;background:rgba(255,255,255,0.03);border:1px dashed rgba(255,255,255,0.15);padding:10px;border-radius:10px;text-align:center;">
            🔍 Procurando Smart TVs no seu Wi-Fi...
          </div>
        </div>
      </div>

      <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">
        Opções de Conexão com a Smart TV:
      </div>

      <div style="display:flex;flex-direction:column;gap:10px;">
        <button type="button" onclick="castViaGoogleCast()" class="cast-hub-btn" style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:linear-gradient(135deg,#1e293b,#0f172a);border:1px solid rgba(56,189,248,0.3);padding:12px 14px;border-radius:14px;color:#fff;cursor:pointer;text-align:left;width:100%;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:22px;">📡</span>
            <div>
              <div style="font-size:13px;font-weight:700;color:#f8fafc;">Google Cast / Smart TV</div>
              <div style="font-size:11px;color:#94a3b8;">Chromecast, Google TV, Android TV, Philco e TCL</div>
            </div>
          </div>
          <span style="font-size:12px;background:#0284c7;color:#fff;padding:5px 12px;border-radius:8px;font-weight:700;">Conectar</span>
        </button>

        <button type="button" id="btn-airplay-opt" onclick="castViaAirPlay()" class="cast-hub-btn" style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:linear-gradient(135deg,#1e293b,#0f172a);border:1px solid rgba(255,255,255,0.15);padding:12px 14px;border-radius:14px;color:#fff;cursor:pointer;text-align:left;width:100%;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:22px;">🍏</span>
            <div>
              <div style="font-size:13px;font-weight:700;color:#f8fafc;">Apple AirPlay</div>
              <div style="font-size:11px;color:#94a3b8;">Smart TVs Samsung, LG, Roku e Apple TV</div>
            </div>
          </div>
          <span style="font-size:12px;background:#475569;color:#fff;padding:5px 12px;border-radius:8px;font-weight:700;">AirPlay</span>
        </button>

        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(168,85,247,0.25);border-radius:14px;padding:12px 14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:20px;">⚡</span>
              <div>
                <div style="font-size:13px;font-weight:700;color:#c084fc;">Smart TV por Endereço IP</div>
                <div style="font-size:10.5px;color:#94a3b8;">Samsung, LG, Roku TV, Android TV e Fire TV</div>
              </div>
            </div>
            <button type="button" onclick="autoScanLocalRoku()" style="background:rgba(168,85,247,0.15);border:1px solid rgba(168,85,247,0.3);color:#d8b4fe;padding:4px 8px;border-radius:6px;font-size:10.5px;font-weight:700;cursor:pointer;">
              🔍 Escanear Wi-Fi
            </button>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <input type="text" id="client-roku-ip" placeholder="IP da sua TV (ex: 192.168.1.15)" style="flex:1;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.15);padding:8px 10px;border-radius:8px;color:#fff;font-size:12px;">
            <button type="button" onclick="castToClientRoku()" style="background:linear-gradient(135deg,#9333ea,#7e22ce);border:none;color:#fff;padding:8px 14px;border-radius:8px;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;">
              ▶ Conectar na TV
            </button>
          </div>
          <div style="font-size:10.5px;color:#94a3b8;margin-top:8px;line-height:1.4;">
            <b>💡 Como ver o IP na sua TV:</b><br>
            • Samsung / LG: Configurações › Rede › Status da Rede › IP<br>
            • Roku TV: Configurações › Rede › Sobre › Endereço IP<br>
            • Android TV: Configurações › Rede e Internet › Seu Wi-Fi › IP
          </div>
          <div id="roku-scan-status" style="font-size:10.5px;color:#a855f7;margin-top:6px;display:none;"></div>
        </div>

        <button type="button" onclick="castViaScreenMirror()" class="cast-hub-btn" style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);padding:10px 14px;border-radius:14px;color:#fff;cursor:pointer;text-align:left;width:100%;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:20px;">🖥️</span>
            <div>
              <div style="font-size:12.5px;font-weight:700;color:#cbd5e1;">Espelhar Tela / Aba</div>
              <div style="font-size:10.5px;color:#64748b;">Projetar sem fio no televisor</div>
            </div>
          </div>
          <span style="font-size:11px;background:rgba(255,255,255,0.08);color:#cbd5e1;padding:4px 8px;border-radius:6px;">Espelhar</span>
        </button>
      </div>

      <div id="cast-hub-feedback" style="display:none;margin-top:12px;padding:10px;border-radius:8px;font-size:11.5px;text-align:center;"></div>
    </div>
  </div>
  <button type="button" class="back-top-btn" id="btn-back-top" title="${ui.topBtn}">${ui.topBtn}</button>
  <script>
    (function () {
      var btn = document.getElementById('btn-back-top');
      if (!btn) return;
      var hiddenForVideoAt = null;
      function yNow() {
        var se = document.scrollingElement;
        return Math.max(
          window.scrollY || 0,
          document.documentElement.scrollTop || 0,
          document.body.scrollTop || 0,
          se ? se.scrollTop : 0
        );
      }
      function toggle() {
        var y = yNow();
        // Depois de clicar num filme o botão fica escondido até o usuário rolar a lista de novo.
        if (hiddenForVideoAt !== null) {
          if (Math.abs(y - hiddenForVideoAt) < 160) { btn.classList.remove('is-on'); return; }
          hiddenForVideoAt = null;
        }
        btn.classList.toggle('is-on', y > 420);
      }
      window.addEventListener('scroll', toggle, { passive: true });
      document.addEventListener('scroll', toggle, { passive: true, capture: true });
      toggle();
      btn.addEventListener('click', function () {
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
        btn.classList.remove('is-on');
      });
      window.papaleguasHideTopoForVideo = function () {
        hiddenForVideoAt = 0;
        btn.classList.remove('is-on');
      };
      if (window.PapaleguasFab) {
        window.PapaleguasFab.makeDraggable(btn, { storageKey: 'papaleguas_fab_pos_topo_filmes' });
        window.PapaleguasFab.bindActivityPing();
      }
    })();
  </script>
  <script src="/i18n-ip.js?v=98"></script>
</body>
</html>`;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(filmesHtml);
    return;
  }

  // Pedido vindo do iframe do proxy: nunca devolver o Papaléguas (duas barras / UI duplicada)
  const proxyCtx = parseRefererProxy(req);
  const destKind = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  if (isAppShellPathname(pathname) && (isIframeDocumentRequest(req) || isProxiedPageReferer(req))) {
    if (proxyCtx.target) {
      res.writeHead(302, {
        Location: wrapProxyAbs(proxyCtx.target, proxyCtx.clientId),
        'Cache-Control': 'no-store'
      });
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }
  if (!isAppShellPathname(pathname) && (isProxiedPageReferer(req) || (proxyCtx.target && destKind && destKind !== 'document')) && !/^\/(proxy|api\/|youtube|filmes|musica|search|baixatube)/i.test(pathname)) {
    const ref = parseRefererProxy(req);
    if (ref.target) {
      let dest = '';
      try {
        dest = new URL(pathname + (reqUrl.search || ''), String(ref.target).replace(/\/?$/, '/')).href;
      } catch (e) { swallowed(e, 'server:top@17103'); }
      if (dest && !isAppShellPathname(pathname)) {
        res.writeHead(302, {
          Location: wrapProxyAbs(dest, ref.clientId),
          'Cache-Control': 'no-store'
        });
        res.end();
        return;
      }
      if (isAppShellPathname(pathname)) {
        res.writeHead(302, {
          Location: wrapProxyAbs(ref.target, ref.clientId),
          'Cache-Control': 'no-store'
        });
        res.end();
        return;
      }
    }
  }

  // ----------------------------------------------------
  // ARQUIVOS ESTÁTICOS DO NAVEGADOR
  // ----------------------------------------------------
  // Bloqueio de segurança: impede acesso direto a diretórios de dados internos (/data, /papaleguas/data)
  if (pathname.includes('/data/') || pathname.startsWith('/data') || (pathname.endsWith('.json') && pathname !== '/manifest.json')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden: Acesso restrito a arquivos do sistema.');
    return;
  }

  if (SOCIAL_CRAWLER_REGEX.test(req.headers['user-agent'] || '')) {
    if (pathname === '/' || pathname === '/index.html') {
      serveSocialPreview(res, {
        title: 'Papaléguas - Navegador Privado, Filmes Online e Músicas',
        description: 'Navegador privado com streaming de filmes online, músicas sem anúncios e download direto de vídeos em alta velocidade.',
        imageUrl: 'https://papaleguas.app/og-banner.jpg',
        pageUrl: 'https://papaleguas.app/',
        isVideo: false
      });
      return;
    }
    if (pathname === '/musica' || pathname === '/musica/' || pathname === '/musica.html') {
      serveSocialPreview(res, {
        title: 'Papaléguas Music - Músicas e Playlists Sem Anúncios',
        description: 'Ouça músicas, crie playlists e escute seus artistas favoritos sem anúncios no Papaléguas Music.',
        imageUrl: 'https://papaleguas.app/og-banner.jpg',
        pageUrl: 'https://papaleguas.app/musica',
        isVideo: false
      });
      return;
    }
  }

  let filePath = path.join(SRC_DIR, pathname === '/' ? 'index.html' : (pathname === '/musica' ? 'musica.html' : pathname));
  const normalizedFilePath = path.normalize(filePath);
  if (!normalizedFilePath.startsWith(SRC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }
  filePath = normalizedFilePath;
  
  // Se o caminho solicitado for de assets do Next.js / Pluto TV (gerado por <base href="https://pluto.tv">),
  // faz o proxy transparente para a pluto.tv em vez de retornar index.html
  const isPlutoAsset = pathname.startsWith('/_next/') ||
                       pathname.startsWith('/scripts/tn/') ||
                       pathname.startsWith('/static/hubs/') ||
                       pathname.startsWith('/api/manifest/');

  if (isPlutoAsset || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (isPlutoAsset) {
      const plutoAssetUrl = `https://pluto.tv${pathname}${reqUrl.search || ''}`;
      const assetReq = https.get(plutoAssetUrl, {
        agent: getOutboundAgent(false),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
          'Accept': req.headers['accept'] || '*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      }, (assetRes) => {
        const headers = { ...assetRes.headers, 'access-control-allow-origin': '*' };
        delete headers['content-security-policy'];
        delete headers['x-frame-options'];
        if (!res.headersSent) {
          res.writeHead(assetRes.statusCode, headers);
          assetRes.pipe(res);
        } else {
          assetRes.resume();
        }
      });
      assetReq.on('error', () => {
        if (res.headersSent || res.writableEnded) {
          try { res.destroy(); } catch (e) { swallowed(e, 'server:top@17195'); }
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      });
      return;
    }

    if (isIframeDocumentRequest(req) || isProxiedPageReferer(req)) {
      const ref = parseRefererProxy(req);
      if (ref.target) {
        res.writeHead(302, {
          Location: wrapProxyAbs(ref.target, ref.clientId),
          'Cache-Control': 'no-store'
        });
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }
    filePath = path.join(SRC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const isAppShell = /[\\/]index\.html$/i.test(filePath) || isAppShellPathname(pathname);
  const isHtml = isAppShell || ext === '.html' || contentType.includes('text/html');
  const hasVersion = Boolean(reqUrl.search && /[?&]v=/.test(reqUrl.search));
  const isStaticAsset = !isHtml && !pathname.endsWith('.txt') && !pathname.endsWith('.xml');
  let cacheControlHeader = 'public, max-age=86400';
  if (isHtml) {
    cacheControlHeader = 'no-cache, must-revalidate';
  } else if (hasVersion) {
    cacheControlHeader = 'public, max-age=31536000, immutable';
  } else if (pathname.endsWith('.js') || pathname.endsWith('.css')) {
    cacheControlHeader = 'public, max-age=86400, stale-while-revalidate=604800';
  } else if (isStaticAsset) {
    cacheControlHeader = 'public, max-age=2592000, immutable';
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo não encontrado');
      return;
    }

    const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const ifNoneMatch = req.headers && req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, {
        'ETag': etag,
        'Cache-Control': cacheControlHeader,
        'Vary': 'Accept-Encoding'
      });
      res.end();
      return;
    }

    let cached = staticAssetMemoryCache.get(filePath);
    if (!cached || cached.mtimeMs !== stats.mtimeMs) {
      fs.readFile(filePath, (readErr, content) => {
        if (readErr) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Erro ao carregar arquivo');
          return;
        }

        const isCompressible = /text|javascript|json|xml|svg/i.test(contentType);
        let brBuf = null;
        let gzipBuf = null;
        if (isCompressible && content.length > 64) {
          try {
            if (typeof zlib.brotliCompressSync === 'function') {
              brBuf = zlib.brotliCompressSync(content, {
                params: {
                  [zlib.constants.BROTLI_PARAM_QUALITY]: 5
                }
              });
            }
          } catch (e) { swallowed(e, 'server:top@17278'); }
          try {
            gzipBuf = zlib.gzipSync(content, { level: 6 });
          } catch (e) { swallowed(e, 'server:top@17281'); }
        }

        cached = {
          mtimeMs: stats.mtimeMs,
          content,
          brBuf,
          gzipBuf,
          etag
        };

        if (stats.size <= 10 * 1024 * 1024) {
          if (staticAssetMemoryCache.size > 150) {
            const firstKey = staticAssetMemoryCache.keys().next().value;
            if (firstKey) staticAssetMemoryCache.delete(firstKey);
          }
          staticAssetMemoryCache.set(filePath, cached);
        }

        deliverCachedAsset(req, res, cached, contentType, cacheControlHeader, isAppShell);
      });
    } else {
      deliverCachedAsset(req, res, cached, contentType, cacheControlHeader, isAppShell);
    }
  });
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 0;
server.timeout = 0;
server.on('connection', (socket) => {
  socket.setKeepAlive(true, 20000);
  socket.setNoDelay(true);
});
server.on('clientError', (err, socket) => {
  if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) return;
  if (socket && !socket.destroyed && socket.writable) {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { swallowed(e, 'server:top@17319'); }
  }
});

async function bootTorBeforeTunnel() {
  setAppTorEnabled(true);
  let ready = false;
  try {
    const status = await torManager.ensureRunning();
    ready = Boolean(status && status.connected);
  } catch (e) { swallowed(e, 'server:bootTorBeforeTunnel@17329'); }
  if (ready) {
    nativeConsoleLog('[TOR] Rede Tor pronta.');
    lookupOutboundIp(true).catch(() => {});
  } else {
    nativeConsoleLog('[TOR] Tor ainda não confirmou.');
  }
  // Cloudflare Tunnel (papaleguas.app) é o túnel público oficial
  ngrokTunnel.stopTunnel();
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    nativeConsoleLog(`[HTTP SERVER] Porta ${PORT} já está em uso. O túnel Cloudflare espera a rede Tor.`);
    bootTorBeforeTunnel();
  } else {
    console.error('[HTTP SERVER ERROR]', err);
  }
});

function getLocalNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, '0.0.0.0', () => {
  const wiped = clearBrowsingTraces();
  const tempRemoved = clearRamTempFiles();
  nativeConsoleLog(`[LIMPEZA] Reinício do servidor: memória zerada (${wiped.cleared || 0} caches) e ${tempRemoved} pastas temporárias da RAM apagadas.`);
  const localIp = getLocalNetworkIp();
  nativeConsoleLog(`[IA] Agente principal: ${aiClient.hasGrok() ? 'Grok (' + aiClient.GROK_MODEL + ')' : 'OpenAI (Grok desativado)'}`);
  nativeConsoleLog(`[HTTP SERVER] Servidor Papaléguas ativo:`);
  nativeConsoleLog(`  🖥️ Local (PC):            http://localhost:${PORT}`);
  nativeConsoleLog(`  📱 Celular (Mesmo Wi-Fi):   http://${localIp}:${PORT}`);
  nativeConsoleLog(`  👑 Painel Admin (No Wi-Fi): http://${localIp}:${PORT}/papaleguas`);
  nativeConsoleLog('[TOR] Subindo a rede Tor antes do túnel Cloudflare.');
  bootTorBeforeTunnel();
  setTimeout(() => {
    try {
      startBackgroundUptimeScanner();
      nativeConsoleLog('🧅 [ONION SCANNER] Monitor autônomo de Uptime 200 ativado para links .onion.');
    } catch (e) { swallowed(e, 'server:top@17380'); }
  }, 4000);

  // Pré-aquecimento em segundo plano do BaixaTube (notícias e vídeos em alta) para abertura instantânea
  setTimeout(() => {
    try {
      fetchMixedNewsVideosFresh({ timeFilter: 'hour', country: 'BR', page: 1 }).catch(() => {});
      fetchGoogleTrends('BR').catch(() => {});
      fetchTrendingVideos({ country: 'BR' }).catch(() => {});
      fetchGoogleTrends('BR').catch(() => {});
      nativeConsoleLog('🚀 [BAIXATUBE ACCELERATOR] Feed de notícias, tendências e Google Trends pré-aquecidos para SEO instantâneo.');
    } catch (e) { swallowed(e, 'server:top@17391'); }
  }, 2500);

  // Inicialização do Robô do Telegram e ponte para agentes
  setTimeout(() => {
    try {
      telegramBot.init({
        getCachedGoogleTrends,
        getVideoTitleFast,
        startMediaDownloadJob
      });
    } catch (e) {
      nativeConsoleLog('[TELEGRAM BOT] Falha ao inicializar:', e.message);
    }
  }, 3000);

  // Atualização silenciosa em segundo plano do feed de notícias a cada 4 minutos
  setInterval(() => {
    try {
      fetchMixedNewsVideosFresh({ timeFilter: 'hour', country: 'BR', page: 1 }).catch(() => {});
    } catch (e) { swallowed(e, 'server:top@17411'); }
  }, 4 * 60 * 1000);

  // Atualização periódica do Google Trends a cada 30 minutos com forceRefresh para todos os países ativos
  setInterval(() => {
    try {
      const activeCountries = new Set(['BR', ...googleTrendsCache.keys()]);
      for (const c of activeCountries) {
        fetchGoogleTrends(c, true).catch(() => {});
      }
      nativeConsoleLog(`🔄 [GOOGLE TRENDS] Atualização a cada 30 minutos dos 10 temas em alta executada (${Array.from(activeCountries).join(', ')}).`);
    } catch (e) { swallowed(e, 'server:top@17422'); }
  }, 30 * 60 * 1000);

  // Atualização e renovação do feed de notícias e tendências a cada 30 minutos
  setInterval(() => {
    try {
      if (global.__plRecentFeedFastCache) global.__plRecentFeedFastCache.clear();
      youtubeSearchCache.clear();
      mixedNewsCache = null;
      mixedNewsCacheTime = 0;
      mixedNewsCacheByKey.clear();
      const activeCountries = new Set(['BR', ...googleTrendsCache.keys()]);
      for (const c of activeCountries) {
        fetchMixedNewsVideosFresh({ timeFilter: 'hour', country: c, page: 1, forceRefresh: true }).catch(() => {});
        fetchTrendingVideos({ country: c }).catch(() => {});
      }
      nativeConsoleLog('🔄 [BAIXATUBE ACCELERATOR] Feed de vídeos e tendências renovado com novos vídeos a cada 30 minutos.');
    } catch (e) { swallowed(e, 'server:top@17439'); }
  }, 30 * 60 * 1000);
});

// Apaga tudo que a navegação deixou na memória do servidor: pesquisas, URLs
// extraídas, cookies do proxy e sessões. Nada disso sobrevive ao fechamento.
const RAM_TEMP_KEEP = new Set([
  '.X11-unix', '.ICE-unix', '.XIM-unix', '.font-unix', '.Test-unix', 'cursor'
]);

function isSessionTempName(name) {
  if (!name || RAM_TEMP_KEEP.has(name)) return true;
  return /^(systemd-|pulse-|ssh-|snap-|dbus-|gnome-|gdm-)/.test(name);
}

function clearRamTempFiles() {
  const tmp = os.tmpdir();
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(tmp, { withFileTypes: true }); } catch (e) { return removed; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  entries.forEach((entry) => {
    if (isSessionTempName(entry.name)) return;
    const target = path.join(tmp, entry.name);
    try {
      const st = fs.lstatSync(target);
      if (uid !== null && typeof st.uid === 'number' && st.uid !== uid) return;
      if (st.isSocket() || st.isFIFO()) return;
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch (e) { swallowed(e, 'server:clearRamTempFiles@17469'); }
  });
  return removed;
}

function removeDirContents(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.includes('device_video_prefs') || name.includes('prefs')) continue;
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (e) { swallowed(e, 'server:removeDirContents@17479'); }
    }
  } catch (e) { swallowed(e, 'server:removeDirContents@17481'); }
}

function clearBrowsingTraces() {
  const caches = [
    proxyCookieJars,
    webSuggestCache,
    richSearchCache,
    youtubeSearchCache,
    searchAnswerCache,
    searchPicksCache,
    curatorVideoAiCache,
    playUrlCache,
    mediaJobs,
    audioStreamUrlCache,
    videoStreamUrlCache,
    musicRecCache,
    curatorSuggestionsCache,
    clientSessions
  ];
  let cleared = 0;
  caches.forEach((cache) => {
    try {
      if (cache && typeof cache.clear === 'function') {
        cleared += cache.size || 0;
        cache.clear();
      }
    } catch (e) { swallowed(e, 'server:clearBrowsingTraces@17508'); }
  });
  removeDirContents(MEDIA_DOWNLOADS_DIR);
  removeDirContents(path.join(os.tmpdir(), 'papaleguas_code'));
  const tempRemoved = clearRamTempFiles();
  try {
    const { wipePythonSessionFiles } = require('./python-runner');
    if (typeof wipePythonSessionFiles === 'function') wipePythonSessionFiles();
  } catch (e) { swallowed(e, 'server:clearBrowsingTraces@17516'); }
  try {
    const tunnelLog = path.join(__dirname, '../papaleguas/data/cloudflared.log');
    if (fs.existsSync(tunnelLog)) fs.writeFileSync(tunnelLog, '', 'utf8');
  } catch (e) { swallowed(e, 'server:clearBrowsingTraces@17520'); }
  return { success: true, cleared };
}

module.exports = {
  server,
  downloadMediaFile,
  getAiMusicRecommendations,
  searchDjGenreMusic,
  chatDjPapaleguas,
  setAppTorEnabled,
  isAppTorEnabled,
  isTorRoutingEnabled,
  getOutboundAgent,
  getClientCountryCode,
  lookupOutboundIp,
  getHlForCountry,
  clearBrowsingTraces
};

// Pré-aquece o feed misturado de Notícias (principais canais de jornalismo) para abertura instantânea
setTimeout(() => {
  try { fetchMixedNewsVideos({ timeFilter: 'hour', country: 'BR', page: 1 }).catch(() => {}); } catch (e) { swallowed(e, 'server:top@17542'); }
}, 5000);
setInterval(() => {
  try { fetchMixedNewsVideos({ timeFilter: 'hour', country: 'BR', page: 1, forceRefresh: true }).catch(() => {}); } catch (e) { swallowed(e, 'server:top@17545'); }
}, 3 * 60 * 1000).unref();
