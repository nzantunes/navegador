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

// =========================================================================
// CONTROLE DE ACESSO: PAINEL ADMINISTRATIVO RESTRITO À REDE LOCAL
// =========================================================================
function isLocalAdminRequest(req) {
  if (!req) return false;
  const headers = req.headers || {};
  // Se a requisição veio via Cloudflare Tunnel, Ngrok ou proxy externo
  if (headers['cf-connecting-ip'] || headers['cf-ray'] || headers['cf-visitor']) {
    return false;
  }
  const host = (headers.host || '').toLowerCase();
  if (host.includes('trycloudflare.com') || host.includes('ngrok') || host.includes('loca.lt') || host.includes('lhr.life')) {
    return false;
  }
  const clientIp = papaleguasTracker.extractClientIp(req);
  return papaleguasTracker.isPrivateIp(clientIp);
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

const MEDIA_DOWNLOADS_DIR = path.join(os.homedir(), '.papaleguas_downloads');
try { fs.mkdirSync(MEDIA_DOWNLOADS_DIR, { recursive: true }); } catch (e) {}

const SERVER_BUILD_VERSION = '2026.10.14-v29';
const querystring = require('querystring');
const zlib = require('zlib');
const http2 = require('http2');
const tls = require('tls');
let SocksProxyAgent;
try {
  SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
} catch (e) {}
// Usado para abrir a conexão HTTP/2 das buscas por dentro do Tor
let SocksClient;
try {
  SocksClient = require('socks').SocksClient;
} catch (e) {}

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
  } catch (e) {}
  return appTorEnabled;
}

function isAppTorEnabled() {
  return appTorEnabled;
}

function isTorRoutingEnabled(session) {
  if (session && typeof session.torEnabled === 'boolean') {
    return Boolean(session.torEnabled);
  }
  return Boolean(appTorEnabled);
}

function applyServerTorRouting(enabled) {
  const on = Boolean(enabled);
  setAppTorEnabled(on);
  try {
    clientSessions.forEach((session) => {
      session.torEnabled = on;
    });
  } catch (e) {}
  return on;
}

function getOutboundAgent(force) {
  if (force === true) return torAgent || undefined;
  if (!appTorEnabled || force === false) return undefined;
  return torAgent || undefined;
}

// YouTube e Google Video não passam pelo proxy Tor: saem direto na velocidade máxima da internet
function isYoutubeHost(hostname) {
  return /(?:^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com|ytimg\.com|ggpht\.com)$/i.test(String(hostname || ''));
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
  return /(?:^|\.)(ipleak\.net|browserleaks\.com|dnsleaktest\.com|whoer\.net|ifconfig\.me|icanhazip\.com|ipify\.org|check\.torproject\.org)$/i.test(String(hostname || ''));
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
  const result = {
    IP: (info && (info.IP || info.ip)) || '',
    IsTor: Boolean(info && (info.IsTor === true || info.IsTor === 'true')),
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
const ipCountryCache = new Map();

// Detecta o país do dispositivo cliente (padrão Brasil).
async function getClientCountryCode(req, explicitIp = '', useTor = false) {
  // 1. Cloudflare (quando rodando atrás de tunelamento público, indica o país de origem do visitante)
  const cfCountry = req && req.headers && req.headers['cf-ipcountry'];
  if (cfCountry && cfCountry.length === 2 && cfCountry !== 'XX') return cfCountry.toUpperCase();

  // 2. Lookup via ip-api.com usando o IP real do dispositivo cliente (se fornecido explicitamente)
  const deviceIp = extractRequestDeviceIp(req, explicitIp);
  if (deviceIp && !isPrivateIpAddress(deviceIp)) {
    const cached = ipCountryCache.get(deviceIp);
    if (cached && (Date.now() - cached.t) < 30 * 60 * 1000) return cached.country;
    try {
      const geoInfo = await fetchJsonViaAgent(
        'http://ip-api.com/json/' + encodeURIComponent(deviceIp) + '?fields=status,countryCode',
        null, 3500
      );
      if (geoInfo && geoInfo.status === 'success' && geoInfo.countryCode) {
        const country = String(geoInfo.countryCode).toUpperCase();
        ipCountryCache.set(deviceIp, { t: Date.now(), country });
        return country;
      }
    } catch (e) {}
  }

  // 3. Se for IP privado / rede Wi-Fi local, consulta a geolocalização da conexão pública real (direta, sem Tor)
  try {
    const cachedPublic = ipCountryCache.get('__public_egress__');
    if (cachedPublic && (Date.now() - cachedPublic.t) < 30 * 60 * 1000) return cachedPublic.country;
    const publicGeo = await fetchJsonViaAgent(
      'http://ip-api.com/json/?fields=status,countryCode',
      null, 3000
    );
    if (publicGeo && publicGeo.status === 'success' && publicGeo.countryCode) {
      const country = String(publicGeo.countryCode).toUpperCase();
      ipCountryCache.set('__public_egress__', { t: Date.now(), country });
      return country;
    }
  } catch (e) {}

  // 4. Fallback por Accept-Language do navegador do dispositivo cliente
  const lang = (req && req.headers && req.headers['accept-language']) || '';
  if (/pt-BR|pt-PT/i.test(lang)) return 'BR';
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
  return 'en';
}

function buildIpCheckPage(info) {
  const ip = info.IP || '—';
  const viaTor = Boolean(info.viaTor);
  const isTor = Boolean(info.IsTor);
  const statusLabel = !viaTor ? 'Internet direta' : (isTor ? 'Saída confirmada pela rede Tor' : 'Tor ligado, mas o destino não confirmou o circuito');
  const statusColor = !viaTor ? '#38bdf8' : (isTor ? '#00ff88' : '#f59e0b');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Meu IP — Papaléguas</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#07090e; color:#e2e8f0; font-family:system-ui,sans-serif; padding:24px; }
    .card { width:min(440px,100%); background:#111827; border:1px solid rgba(255,255,255,.08); border-radius:24px; padding:36px 28px; text-align:center; box-shadow:0 20px 50px rgba(0,0,0,.45); }
    .kicker { font-size:13px; letter-spacing:.08em; text-transform:uppercase; color:#94a3b8; margin-bottom:10px; }
    .ip { font-size:34px; font-weight:800; letter-spacing:-.04em; color:#fff; word-break:break-all; margin:8px 0 18px; }
    .badge { display:inline-block; padding:8px 14px; border-radius:999px; font-size:13px; font-weight:700; color:${statusColor}; background:rgba(255,255,255,.05); border:1px solid ${statusColor}55; }
    p { color:#94a3b8; font-size:14px; line-height:1.55; margin:18px 0 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="kicker">IP de saída desta conexão</div>
    <div class="ip">${ip}</div>
    <div class="badge">${statusLabel}</div>
    <p>${viaTor ? 'O meuip.com.br bloqueia nós Tor e trava na tela verde. Este resultado usa a mesma saída Tor do Papaléguas, sem o antibot do site.' : 'Tor desligado. Este é o IP da sua internet normal.'}</p>
  </div>
  <script>
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'navigate-sync', url: 'https://www.meuip.com.br/', targetUrl: 'https://www.meuip.com.br/', title: 'Meu IP' }, '*');
      }
    } catch (e) {}
  </script>
</body>
</html>`;
}

function ytdlpProxyArgs() {
  return ['--proxy', ''];
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

function rewriteMetaRefresh(html, clientId, pageUrl) {
  return String(html || '').replace(/<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*>/gi, (tag) => {
    const contentMatch = tag.match(/content=(["'])([\s\S]*?)\1/i) || tag.match(/content=([^\s>]+)/i);
    if (!contentMatch) return tag;
    const content = String(contentMatch[2] || contentMatch[1] || '');
    const parts = content.split(/url\s*=\s*/i);
    if (parts.length < 2) return tag;
    const delay = String(parts[0] || '0').replace(/;+\s*$/, '').trim() || '0';
    let next = String(parts[1] || '').replace(/^["']|["']$/g, '').trim();
    try {
      next = new URL(next, pageUrl).href;
    } catch (e) {
      return tag;
    }
    return '<meta http-equiv="refresh" content="' + delay + ';url=' + wrapProxyAbs(next, clientId) + '">';
  });
}

const proxyCookieJars = new Map();

function proxyCookieKey(clientId, hostname) {
  return String(clientId || 'client_default') + '\n' + String(hostname || '').toLowerCase();
}

function storeProxyCookies(clientId, hostname, setCookieHeaders) {
  if (!setCookieHeaders || !hostname) return;
  const key = proxyCookieKey(clientId, hostname);
  const jar = proxyCookieJars.get(key) || {};
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const raw of list) {
    if (!raw) continue;
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    if (!value || /max-age=0/i.test(String(raw)) || /expires=\s*tue,\s*01[\s-]+jan[\s-]+1970/i.test(String(raw))) {
      delete jar[name];
    } else {
      jar[name] = value;
    }
  }
  proxyCookieJars.set(key, jar);
}

function cookieHeaderForProxy(clientId, hostname, incomingCookie) {
  const jar = Object.assign({}, proxyCookieJars.get(proxyCookieKey(clientId, hostname)) || {});
  if (incomingCookie) {
    String(incomingCookie).split(';').forEach((part) => {
      const eq = part.indexOf('=');
      if (eq < 1) return;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name || name === 'papaleguas_token' || name === 'pl_proxy_target') return;
      jar[name] = value;
    });
  }
  return Object.keys(jar).map((k) => k + '=' + jar[k]).join('; ');
}

function rewriteSetCookieForProxy(raw, req) {
  const httpsOn = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https'
    || /https/i.test(String(req.headers['cf-visitor'] || ''));
  let out = String(raw || '')
    .replace(/;\s*Domain=[^;]*/ig, '')
    .replace(/;\s*Secure/ig, '');
  if (!httpsOn) out = out.replace(/;\s*SameSite=None/ig, '; SameSite=Lax');
  if (!/;\s*Path=/i.test(out)) out += '; Path=/';
  return out;
}

function applyProxySetCookies(responseHeaders, req, clientId, hostname) {
  const sc = responseHeaders['set-cookie'];
  if (!sc) return;
  storeProxyCookies(clientId, hostname, sc);
  const list = Array.isArray(sc) ? sc : [sc];
  responseHeaders['set-cookie'] = list.map((raw) => rewriteSetCookieForProxy(raw, req));
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
  const result = { target: '', clientId: 'client_default' };
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
    } catch (e) {}
  }
  if (!result.target) {
    const baked = readRequestCookie(req, 'pl_proxy_target');
    if (baked) {
      try {
        result.target = Buffer.from(baked, 'base64url').toString('utf8');
      } catch (e) {}
    }
  }
  result.clientId = req.headers['x-client-id'] || result.clientId;
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
  out = out.replace(/https?:\/\/(?:[a-z0-9-]+\.)*(?:google\.com(?:\.br)?|gstatic\.com|googleapis\.com|googleusercontent\.com|ggpht\.com)[^"'<\s]*/gi, (url) => {
    if (url.indexOf('/proxy?url=') !== -1) return url;
    return wrapAbs(url);
  });
  out = out.replace(/\s(src|href|action|poster|data-src)=(["'])(\/\/[^"']+)\2/gi, (all, attr, quote, url) => {
    if (url.indexOf('/proxy?url=') !== -1) return all;
    return ' ' + attr + '=' + quote + wrapAbs('https:' + url) + quote;
  });
  out = out.replace(/\s(src|href|action|poster|data-src)=(["'])(\/[^"']*)\2/gi, (all, attr, quote, path) => {
    if (path.indexOf('/proxy') === 0 || path.indexOf('/api/') === 0 || path.indexOf('/youtube') === 0 || path.indexOf('/baixatube') === 0) return all;
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

function buildProxyLeakShield(clientId, pageUrl, pageOrigin) {
  return `
              <script>
                (function() {
                  var CLIENT_ID = ${JSON.stringify(String(clientId || 'client_default'))};
                  var PAGE_URL = ${JSON.stringify(String(pageUrl || pageOrigin || ''))};
                  var PAGE_ORIGIN = ${JSON.stringify(String(pageOrigin || '').replace(/\/$/, ''))};

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

                  killWebRTC();
                })();
              </script>`;
}

// Finaliza todos os servidores e processos Python criados anteriormente a cada inicialização/reinício
try {
  const { stopAllPythonServers } = require('./python-runner');
  stopAllPythonServers();
} catch (e) {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
// Mantendo exclusivamente o ngrok como túnel público
ngrokTunnel.startTunnel(PORT);
const SRC_DIR = path.join(__dirname, '../src');
const aiClient = require('./ai-client');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
aiClient.setOpenAiFallbackKey(OPENAI_API_KEY);

// Busca no DuckDuckGo (HTML) para navegação web e celulares via Tor
function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return ' '; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return ' '; }
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
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
  } catch (e) {}
  return u;
}

function decodeMaybeGzip(buffer, encoding) {
  if (!buffer || !buffer.length) return '';
  try {
    if (/gzip/i.test(String(encoding || ''))) {
      return zlib.gunzipSync(buffer).toString('utf8');
    }
  } catch (e) {}
  return buffer.toString('utf8');
}

function fetchHttpsText(options, body, timeoutMs = 9000) {
  return new Promise((resolve) => {
    const lib = options.protocol === 'http:' ? http : https;
    const headers = Object.assign({ 'Accept-Encoding': 'gzip' }, options.headers || {});
    const req = lib.request({ ...options, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const next = new URL(res.headers.location, `${options.protocol === 'http:' ? 'http' : 'https'}://${options.hostname}${options.path || '/'}`);
          return fetchHttpsText({
            hostname: next.hostname,
            port: next.port || options.port,
            path: next.pathname + next.search,
            method: 'GET',
            protocol: next.protocol,
            agent: options.agent,
            headers: options.headers,
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
  const blocks = String(html || '').split(/class="(?:result(?:__body)?|web-result|result-link)"/i);
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const url = unwrapDuckUrl(m[1]);
    const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ''));
    if (!url || !title || !/^https?:\/\//i.test(url) || /duckduckgo\.com/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: '' });
  }
  const snipRe = /<(?:a|td|span)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|span)>/gi;
  const snips = [];
  while ((m = snipRe.exec(html)) !== null) {
    snips.push(decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '')));
  }
  for (let i = 0; i < results.length; i++) {
    if (snips[i]) results[i].snippet = snips[i];
  }
  if (results.length === 0 && blocks.length) {
    // fallback: any external result links
    const anyLink = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = anyLink.exec(html)) !== null) {
      const url = unwrapDuckUrl(m[1]);
      const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ''));
      if (!url || !title || title.length < 8 || !/^https?:\/\//i.test(url)) continue;
      if (/duckduckgo\.com|javascript:/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      results.push({ title, url, snippet: '' });
      if (results.length >= 12) break;
    }
  }
  return results;
}

// O Bing envolve cada resultado em bing.com/ck/a?...&u=a1<base64url do link real>
// e cada notícia em bing.com/news/apiclick.aspx?...&url=<link real codificado>
function unwrapBingUrl(raw) {
  const s = decodeHtmlEntities(raw);
  const b64 = s.match(/[?&]u=a1([A-Za-z0-9_\-]+)/);
  if (b64) {
    try {
      const decoded = Buffer.from(b64[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch (e) {}
  }
  const plain = s.match(/[?&]url=([^&]+)/i);
  if (plain) {
    try {
      const decoded = decodeURIComponent(plain[1]);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch (e) {}
  }
  return s;
}

function stripTags(html) {
  // O Bing marca os termos buscados com <strong>; trocar a tag por espaço deixaria
  // sobras como "Santos Dumont : biografia", então a pontuação volta a se encostar.
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' '))
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
    if (item.FirstURL && item.Text) {
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
    if (data.AbstractURL) {
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
// de cabeçalhos de um navegador, o Bing devolve a página real de resultados.
const BROWSER_H2_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'accept-encoding': 'gzip, deflate',
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
  try {
    if (/gzip/i.test(encoding || '')) return zlib.gunzipSync(buffer).toString('utf8');
    if (/deflate/i.test(encoding || '')) return zlib.inflateSync(buffer).toString('utf8');
  } catch (e) {}
  return buffer.toString('utf8');
}

async function openHttp2Session(targetUrl, useTor) {
  const options = { ALPNProtocols: ['h2'] };
  if (useTor && SocksClient) {
    const info = await SocksClient.createConnection({
      proxy: { host: '127.0.0.1', port: 9050, type: 5 },
      command: 'connect',
      destination: { host: targetUrl.hostname, port: Number(targetUrl.port) || 443 }
    });
    options.createConnection = () => tls.connect({
      socket: info.socket,
      servername: targetUrl.hostname,
      ALPNProtocols: ['h2']
    });
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

  // Se o HTTP/2 não subir (Tor fora do ar, rede bloqueada), ainda tenta pelo caminho antigo
  const viaHttp1 = () => fetchHttpsText({
    hostname: target.hostname,
    path: target.pathname + target.search,
    method: 'GET',
    agent: getOutboundAgent(useTor),
    headers: { ...webSourceHeaders(), ...headers }
  }, null, timeoutMs);

  // HTTP/2 pelo Tor costuma voltar vazio e a página de pesquisa fica sem resultado.
  if (useTor) return viaHttp1();

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
        ...headers,
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
    });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', () => { clearTimeout(timer); done(''); });
    stream.on('end', async () => {
      clearTimeout(timer);
      if (status >= 300 && status < 400 && location && hops < 3) {
        let next = '';
        try { next = new URL(location, url).href; } catch (e) {}
        done(next ? await fetchBrowserText(next, { headers, useTor, timeoutMs, hops: hops + 1 }) : '');
        return;
      }
      done(decodeCompressed(Buffer.concat(chunks), encoding));
    });
    stream.end();
  });

  try { session.close(); } catch (e) {}
  return text || viaHttp1();
}

// Atenção aos parâmetros: com "count" na URL, ou com "setlang" e "cc" juntos, o Bing
// troca a busca pela primeira palavra do termo e devolve resultados sem relação nenhuma.
function bingSearchUrl(path, query, extra = '') {
  return 'https://www.bing.com' + path + '?q=' + encodeURIComponent(query) + '&setlang=pt-BR' + extra;
}

// Sob rajada de requisições o Bing troca a busca pela primeira palavra do termo e
// devolve uma página sem relação nenhuma. Como ele responde 200, o jeito de perceber
// é olhar se os resultados cobrem mais de um termo da pesquisa.
function looksLikeDegradedSerp(results, query) {
  const tokens = searchQueryTokens(query);
  if (tokens.length < 2 || !results.length) return false;
  const matched = results.filter((item) => {
    const text = normalizeForMatch(item.title + ' ' + (item.snippet || ''));
    return tokens.filter((token) => text.includes(token)).length >= 2;
  });
  return (matched.length / results.length) < 0.3;
}

async function searchBingHtml(query, useTor = false) {
  // Qualquer parâmetro além de q e setlang (count, cc, first…) degrada a resposta,
  // então a busca fica restrita à primeira página mesmo.
  const url = bingSearchUrl('/search', query);
  const timeoutMs = useTor ? 12000 : 8000;
  let results = parseBingHtml(await fetchBrowserText(url, { useTor, timeoutMs }));
  if (looksLikeDegradedSerp(results, query)) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    const retry = parseBingHtml(await fetchBrowserText(url, { useTor, timeoutMs }));
    if (retry.length && !looksLikeDegradedSerp(retry, query)) return retry;
    if (looksLikeDegradedSerp(results, query)) return [];
  }
  return results;
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

async function searchBingNews(query, useTor = false) {
  const xml = await fetchBrowserText(bingSearchUrl('/news/search', query, '&format=rss'), {
    headers: { accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' },
    useTor,
    timeoutMs: useTor ? 9000 : 6000
  });
  return parseRssItems(xml)
    .filter((item) => !/(^|\.)bing\.com$/i.test(safeHostname(item.url)))
    .map((item) => ({ ...item, source: 'noticias' }))
    .slice(0, 4);
}


function parseDuckLiteHtml(html) {
  const results = [];
  const seen = new Set();
  const re = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = unwrapDuckUrl(m[1]);
    const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    if (!url || !title || title.length < 4 || !/^https?:\/\//i.test(url)) continue;
    if (/duckduckgo\.com|lite\.duckduckgo/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: '' });
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

// Junta todas as fontes públicas que ainda respondem e devolve resultados com descrição
async function searchWebSources(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return [];
  const viaTor = Boolean(useTor && isAppTorEnabled());
  const safe = (promise) => promise.catch(() => []);
  try {
    const [bingHtml, duck, instant, brave] = await Promise.all([
      safe(searchBingHtml(q, viaTor)),
      safe(searchDuckDuckGoHtml(q, viaTor)),
      safe(searchDuckInstantApi(q, viaTor)),
      safe(searchBraveHtml(q, viaTor))
    ]);

    const results = [];
    const seen = new Set();
    const pushAll = (list) => {
      (list || []).forEach((item) => {
        if (!item || !item.url || !/^https?:\/\//i.test(item.url)) return;
        const key = normalizeSearchUrl(item.url);
        if (seen.has(key)) {
          // mantém o resultado já salvo, mas aproveita a descrição de quem tiver uma melhor
          const previous = results.find((r) => normalizeSearchUrl(r.url) === key);
          if (previous && !previous.snippet && item.snippet) previous.snippet = item.snippet;
          if (previous && !previous.date && item.date) previous.date = item.date;
          return;
        }
        seen.add(key);
        results.push({
          title: item.title,
          url: item.url,
          snippet: item.snippet || '',
          date: item.date || '',
          source: item.source || 'web',
          host: safeHostname(item.url),
          rank: results.length
        });
      });
    };

    // Bing, DuckDuckGo e Brave entendem a frase inteira, então abrem a lista.
    pushAll(bingHtml);
    pushAll(duck);
    pushAll(instant.map((item) => ({ ...item, source: 'duckduckgo' })));
    pushAll(brave);

    if (results.length < 8) {
      pushAll(await safe(searchBingRss(q, viaTor)));
      pushAll(await safe(searchDuckDuckGoFallback(q, viaTor)));
    }

    return results.slice(0, 80);
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
    .filter((w) => w.length > 2 && !SEARCH_STOPWORDS.has(w));
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function scoreSearchResult(item, tokens, rawQuery = '') {
  const title = normalizeForMatch(item.title);
  const snippet = normalizeForMatch(item.snippet);
  const phrase = normalizeForMatch(rawQuery);
  let score = 0;
  let covered = 0;
  tokens.forEach((token) => {
    const inTitle = title.includes(token);
    const inSnippet = snippet.includes(token);
    if (inTitle) score += 4;
    if (inSnippet) score += 1;
    if (inTitle || inSnippet) covered += 1;
  });
  // Quem cobre mais termos distintos da busca vence quem repete só um deles
  if (tokens.length) score += (covered / tokens.length) * 8;
  if (phrase && phrase.length > 6 && (title.includes(phrase) || snippet.includes(phrase))) score += 6;
  if (item.snippet) score += 2;
  if (item.date) score += 1;
  // A ordem entregue pelo buscador já carrega relevância: só perde posição quem casa pouco com o termo
  if (typeof item.rank === 'number') score += Math.max(0, 6 - item.rank * 0.4);
  return score;
}

const webSuggestCache = new Map();

function parseSuggestPayload(text) {
  try {
    const data = JSON.parse(text);
    // Formato OpenSearch: ["termo", ["sugestão 1", "sugestão 2", ...]]
    const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : data;
    if (!Array.isArray(list)) return [];
    return list.map((item) => {
      if (typeof item === 'string') return item;
      return (item && (item.phrase || item.text)) || '';
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

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
    if (isOnionHref(item.url)) return;
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

// Alguns resultados chegam casando só uma palavra solta e não têm relação com o
// tema ("Lizzie Borden" para "como tirar mancha de café da roupa"): aqui eles caem fora.
function filterOffTopic(items, tokens) {
  if (tokens.length < 2) return items;
  const minimum = tokens.length >= 4 ? 2 : 1;
  const kept = items.filter((item) => {
    const text = normalizeForMatch(item.title + ' ' + (item.snippet || ''));
    return tokens.filter((token) => text.includes(token)).length >= minimum;
  });
  // Se o corte derrubar quase tudo, é sinal de que o termo é incomum: melhor devolver o que veio
  return kept.length >= 3 ? kept : items;
}

// Evita uma sequência longa do mesmo site logo no topo: o terceiro link de um domínio desce na lista
function spreadResultsByHost(items, maxPerHost = 2) {
  const counts = new Map();
  const top = [];
  const rest = [];
  items.forEach((item) => {
    const host = item.host || safeHostname(item.url);
    const used = counts.get(host) || 0;
    if (used < maxPerHost) {
      counts.set(host, used + 1);
      top.push(item);
    } else {
      rest.push(item);
    }
  });
  return top.concat(rest);
}

const richSearchCache = new Map();

// Reúne tudo que o buscador consegue extrair de uma pesquisa:
// resultados com descrição, resumo de contexto, notícias recentes e buscas relacionadas.
async function getRichSearchData(query, useTor = false) {
  const q = String(query || '').trim();
  if (!q) return { q, results: [], onion: [], news: [], related: [], sources: [] };
  const torOn = Boolean((useTor || isTorRoutingEnabled(null)) && isAppTorEnabled());
  const key = q.toLowerCase() + (torOn ? ':tor' : ':direct');
  const cached = richSearchCache.get(key);
  if (cached && (Date.now() - cached.t < 180000)) return cached.data;

  const safe = (promise, fallback) => promise.catch(() => fallback);
  const webPromise = Promise.race([
    safe(getWebSearchPool(q, torOn), []),
    new Promise((resolve) => setTimeout(() => resolve([]), torOn ? 6500 : 4500))
  ]);
  const newsPromise = Promise.race([
    safe(searchBingNews(q, torOn), []),
    new Promise((resolve) => setTimeout(() => resolve([]), 3500))
  ]);
  const [results, news, related] = await Promise.all([
    webPromise,
    newsPromise,
    safe(fetchSuggestPhrases(q, torOn), [])
  ]);

  const newsUrls = new Set((news || []).map((item) => normalizeSearchUrl(item.url)));
  const data = {
    q,
    viaTor: torOn,
    onion: [],
    news: news || [],
    related: (related || []).filter((phrase) => String(phrase).toLowerCase() !== q.toLowerCase()).slice(0, 10),
    results: (results || []).filter((item) => !newsUrls.has(normalizeSearchUrl(item.url))),
    sources: Array.from(new Set((results || []).map((item) => item.source).filter(Boolean)))
  };
  // Guardar uma busca vazia só faria a próxima tentativa falhar de novo por 3 minutos
  if (data.results.length) richSearchCache.set(key, { t: Date.now(), data });
  return data;
}

// ----------------------------------------------------
// RESPOSTA DA IA SOBRE A BUSCA
// A IA não navega sozinha: ela lê os resultados que o buscador já trouxe e
// responde citando de qual deles tirou cada informação.
// ----------------------------------------------------
const searchAnswerCache = new Map();

function buildAiSources(data, limit = 8) {
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
      snippet: String(item.snippet || '').slice(0, 700),
      date: item.date || ''
    });
  };
  ((data && data.results) || []).forEach(add);
  ((data && data.news) || []).forEach(add);
  return sources;
}

function buildAiContext(sources) {
  return sources.map((item, index) => {
    const head = '[' + (index + 1) + '] ' + item.title + ' — ' + item.host + (item.date ? ' — ' + item.date : '');
    return head + '\n' + (item.snippet || '(sem descrição disponível)');
  }).join('\n\n');
}

const SEARCH_ANSWER_SYSTEM = [
  'Você é o assistente de pesquisa do navegador Papaléguas.',
  'Responda sempre em português do Brasil, direto ao ponto, sem rodeios.',
  'Use apenas as fontes numeradas que receber. Se elas não responderem à pergunta, diga isso com franqueza em vez de inventar.',
  'Marque de onde veio cada informação com o número da fonte entre colchetes, como [1] ou [2][4].',
  'Nunca invente números, preços, datas ou nomes que não estejam nas fontes.',
  'No máximo 5 frases curtas, ou 4 itens se uma lista ficar mais clara.',
  'Não repita a pergunta nem comece com "de acordo com as fontes".'
].join(' ');

// ----------------------------------------------------
// AGENTE "MELHORES RESULTADOS": escolhe 2–3 links para abrir e explica o porquê.
// ----------------------------------------------------
const searchPicksCache = new Map();
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
  const sources = buildAiSources(data);

  const messages = [{ role: 'system', content: SEARCH_ANSWER_SYSTEM }];
  (history || []).slice(-6).forEach((turn) => {
    if (!turn || !turn.role || !turn.content) return;
    if (turn.role !== 'user' && turn.role !== 'assistant') return;
    messages.push({ role: turn.role, content: String(turn.content).slice(0, 1200) });
  });

  const promptContent = sources.length
    ? 'Pergunta: ' + question + '\n\nFontes encontradas na web:\n' + buildAiContext(sources)
    : 'Pergunta: ' + question + '\n\n(Nenhuma fonte externa encontrada no momento. Responda com base no seu conhecimento de forma completa, precisa e amigável em português do Brasil.)';

  messages.push({
    role: 'user',
    content: promptContent
  });

  try {
    const completion = await callOpenAi({
      messages,
      temperature: 0.2,
      max_tokens: 500,
      timeoutMs: 15000,
      direct: true
    });
    const choice = completion && completion.choices && completion.choices[0];
    const answer = (choice && choice.message && choice.message.content) || '';
    return { answer: String(answer).trim(), sources };
  } catch (err) {
    console.warn('[IA RESPOSTA] Falhou:', err && err.message ? err.message : err);
    return { answer: '', sources };
  }
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

  const safe = (promise, fallback) => promise.catch((err) => {
    console.warn('[URL-SUGGEST] etapa falhou:', err && err.message ? err.message : err);
    return fallback;
  });
  const poolPromise = safe(getWebSearchPool(q, useTor), []);
  const phrasesPromise = safe(fetchSuggestPhrases(q, useTor), []);

  if (p === 0) {
    if (isOnionHref(q)) {
      const url = /^https?:\/\//i.test(q) ? q.replace(/^https:/i, 'http:') : 'http://' + q.replace(/^\/+/, '');
      suggestions.push({
        kind: 'onion',
        title: q.replace(/^https?:\/\//i, ''),
        subtitle: 'Abrir endereço .onion',
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
        url: '/search?q=' + encodeURIComponent(q)
      });
    }
    suggestions.push({
      kind: 'search',
      title: q,
      subtitle: useTor && isAppTorEnabled() ? 'Pesquisar na web e na rede Tor' : 'Pesquisar na web',
      url: '/search?q=' + encodeURIComponent(q)
    });
  }

  const [pool, phrases] = await Promise.all([poolPromise, phrasesPromise]);
  const webPool = Array.isArray(pool) ? pool : [];
  const phraseList = Array.isArray(phrases) ? phrases : [];

  if (p === 0) {
    (phraseList || []).slice(0, 10).forEach((phrase) => {
      if (String(phrase).toLowerCase() === q.toLowerCase()) return;
      if (suggestions.some((s) => s.kind === 'search' && String(s.title).toLowerCase() === String(phrase).toLowerCase())) return;
      suggestions.push({
        kind: 'search',
        title: phrase,
        subtitle: 'Sugestão de pesquisa',
        url: '/search?q=' + encodeURIComponent(phrase)
      });
    });
  }

  const pageSize = 12;
  const start = p * pageSize;
  webPool.slice(start, start + pageSize).forEach((r) => {
    if (isOnionHref(r.url)) return;
    if (suggestions.some((s) => normalizeSearchUrl(s.url) === normalizeSearchUrl(r.url))) return;
    let host = r.url;
    try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (e) {}
    suggestions.push({
      kind: 'site',
      title: r.title || host,
      subtitle: host,
      url: r.url,
      snippet: r.snippet || ''
    });
  });

  let hasMore = (start + pageSize) < webPool.length;
  if (!hasMore) {
    // Tenta expandir com termos relacionados para gerar mais resultados
    const candidates = (phraseList || []).filter((ph) => String(ph).toLowerCase() !== q.toLowerCase());
    const extraQ = candidates[p] || candidates[0];
    if (extraQ) {
      const extra = await getWebSearchPool(extraQ, useTor).catch(() => []);
      const seenUrls = new Set(suggestions.map((s) => normalizeSearchUrl(s.url)));
      extra.slice(0, pageSize).forEach((r) => {
        const k = normalizeSearchUrl(r.url);
        if (!k || seenUrls.has(k)) return;
        seenUrls.add(k);
        let host = r.url;
        try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (e) {}
        suggestions.push({
          kind: 'site',
          title: r.title || host,
          subtitle: host,
          url: r.url,
          snippet: r.snippet || ''
        });
      });
      hasMore = candidates.length > p + 1;
    }
  }

  return { success: true, q, page: p, hasMore, suggestions, generatedByAi: false };
}

// Pools dinâmicos para alternar vídeos a cada requisição mantendo sempre os mais novos
function getDynamicRecentYoutubeQuery(categoryOrQuery, isForcedCustom = false, country = 'BR') {
  if (isForcedCustom) {
    return { query: categoryOrQuery, sortByRecent: false, isCustomQuery: true };
  }
  const c = (categoryOrQuery || 'noticias').toLowerCase().trim();
  const cUpper = String(country || 'BR').toUpperCase();
  const isPt = cUpper === 'BR' || cUpper === 'PT';
  const isEs = ['AR', 'MX', 'ES', 'CO', 'CL', 'PE', 'UY', 'VE', 'BO', 'EC', 'PY'].includes(cUpper);
  const isDe = ['DE', 'AT', 'CH'].includes(cUpper);
  const isFr = cUpper === 'FR';

  let newsPool, musicPool, sportsPool, podcastPool, trendingPool, gamesPool, moviePool, techPool, livePool, humorPool;

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
  }

  const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

  if (c === 'noticias' || c === 'noticia' || c === 'jornal' || c === 'urgente' || c === 'news') {
    return { query: pickRandom(newsPool), sortByRecent: true };
  }
  if (c === 'musicas' || c === 'musica' || c === 'som' || c === 'clipe' || c === 'music') {
    return { query: pickRandom(musicPool), sortByRecent: false };
  }
  if (c === 'esportes' || c === 'esporte' || c === 'futebol' || c === 'gol' || c === 'sports') {
    return { query: pickRandom(sportsPool), sortByRecent: true };
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
    return { query: pickRandom(livePool), sortByRecent: false, searchMode: 'live' };
  }
  if (c === 'humor' || c === 'comedia' || c === 'comedy') {
    return { query: pickRandom(humorPool), sortByRecent: false };
  }
  if (c === 'alta' || c === 'em alta' || c === 'trending' || c === 'viral' || c === 'tudo' || c === 'tudo / em alta') {
    return { query: pickRandom(trendingPool), sortByRecent: false, searchMode: 'trending' };
  }

  return { query: categoryOrQuery, sortByRecent: false, isCustomQuery: true };
}

const NEWS_OUTLET_QUERIES_BY_COUNTRY = {
  BR: [
    'jovem pan news ultimas noticias',
    'record news jornal hoje',
    'sbt news ultimas noticias',
    'g1 noticias agora brasil',
    'globo news jornal agora',
    'band jornalismo noticias hoje',
    'cnn brasil ultimas noticias'
  ],
  PT: [
    'rtp noticias direto ultimas',
    'sic noticias ultimas informacoes',
    'tvi noticias direto',
    'observador noticias hoje portugal'
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

async function fetchMixedNewsVideos({ timeFilter = 'hour', useTor = false, timeoutMs = 2600, perQuery = 8, country = 'BR', clientIp = '' } = {}) {
  const hl = getHlForCountry(country);
  const cacheKey = `mixed_news_${country}_${hl}_${clientIp || 'default'}_${timeFilter}_${useTor ? 'tor' : 'direct'}`;
  if (!useTor && mixedNewsCache && (Date.now() - mixedNewsCacheTime < MIXED_NEWS_CACHE_TTL) && mixedNewsCache.length >= 6) {
    return mixedNewsCache;
  }
  const waitMs = useTor ? Math.max(timeoutMs, 16000) : timeoutMs;
  const queries = pickNewsOutletQueries(useTor ? 2 : 3, country);
  const effectiveClientIp = useTor ? '' : clientIp;
  const results = await Promise.all(queries.map((q) => Promise.race([
    searchYoutubeVideos(q, hl, true, timeFilter, useTor, '', country, effectiveClientIp).catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), waitMs))
  ])));
  const mixed = interleaveVideoLists(results.map((list) => (list || []).slice(0, perQuery)), 30);
  if (mixed.length >= 6) {
    if (!useTor) {
      mixedNewsCache = mixed;
      mixedNewsCacheTime = Date.now();
    }
    return mixed;
  }

  const cUpper = String(country || 'BR').toUpperCase();
  const isBr = cUpper === 'BR' || cUpper === 'PT';
  const fallbackQuery = isBr
    ? 'noticias brasil hoje jovem pan record g1 globo news band sbt'
    : (cUpper === 'DE' ? 'nachrichten heute aktuell live welt zdf tagesschau' : 'breaking news today world latest headlines live stream');

  const fallback = await Promise.race([
    searchYoutubeVideos(fallbackQuery, hl, true, timeFilter, useTor, '', country, effectiveClientIp).catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), useTor ? 12000 : 1200))
  ]);
  const combined = interleaveVideoLists([mixed, fallback || []], 30);
  if (combined.length >= 6) {
    if (!useTor) {
      mixedNewsCache = combined;
      mixedNewsCacheTime = Date.now();
    }
    return combined;
  }

  if (timeFilter === 'hour') {
    const extraQuery = isBr ? 'noticias brasil ultimas horas ao vivo' : 'world news headlines live stream today';
    const extra = await searchYoutubeVideos(extraQuery, hl, true, 'day', useTor, '', country, effectiveClientIp).catch(() => []);
    const res = interleaveVideoLists([combined, extra || []], 30);
    if (!useTor && res.length >= 6) {
      mixedNewsCache = res;
      mixedNewsCacheTime = Date.now();
    }
    return res;
  }
  return combined;
}

function getDynamicRecentMovieQuery(categoryOrQuery) {
  const c = (categoryOrQuery || 'todos').toLowerCase().trim();

  const pools = {
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
  };

  const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
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
    const agent = getOutboundAgent(useTor);
    let glParam = 'BR';
    let hlParam = hl || 'pt-BR';
    try {
      const u = new URL(url);
      if (u.searchParams.get('gl')) glParam = u.searchParams.get('gl');
      if (u.searchParams.get('hl')) hlParam = u.searchParams.get('hl');
    } catch (e) {}

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
      res.on('data', chunk => {
        html += chunk;
        const start = html.indexOf('var ytInitialData = ');
        if (start !== -1 && html.indexOf(';</script>', start) !== -1) {
          try { req.destroy(); } catch (e) {}
          finish({ ok: true, html });
        } else if (html.length > 1800000) {
          try { req.destroy(); } catch (e) {}
          finish({ ok: true, html });
        }
      });
      res.on('end', () => finish({ ok: true, html }));
    });
    req.on('error', (err) => finish({ ok: false, error: err }));
    const timeout = useTor ? 18000 : 6500;
    req.setTimeout(timeout, () => { try { req.destroy(); } catch (e) {} finish({ ok: false, timeout: true }); });
  });
}

// Cache de alta performance para buscas do YouTube (TTL de 6 minutos)
const youtubeSearchCache = new Map();
const YT_CACHE_TTL = 6 * 60 * 1000;

function youtubeSearchSp(sortByRecent, timeFilter, searchMode) {
  if (searchMode === 'live') return '&sp=EgJAAQ%253D%253D';
  if (searchMode === 'trending' || searchMode === 'views') {
    if (timeFilter === 'hour') return '&sp=CAMSBggBEAE%253D';
    if (timeFilter === 'day') return '&sp=CAMSBggCEAE%253D';
    if (timeFilter === 'month') return '&sp=CAMSBggEEAE%253D';
    return '&sp=CAMSBggDEAE%253D';
  }
  if (!sortByRecent) return '';
  if (timeFilter === 'hour') return '&sp=CAISBAgBEAE%253D';
  if (timeFilter === 'day') return '&sp=CAISBAgCEAE%253D';
  if (timeFilter === 'week') return '&sp=CAISBAgDEAE%253D';
  if (timeFilter === 'month') return '&sp=CAISBAgEEAE%253D';
  return '&sp=CAI%253D';
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
  if (Array.isArray(node)) {
    node.forEach((item) => collectYoutubeRenderers(item, out));
    return;
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') collectYoutubeRenderers(val, out);
  }
}

function mapYoutubeRenderer(v) {
  if (!v || !v.videoId) return null;
  const thumbs = v.thumbnail?.thumbnails || [];
  const viewsText = v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || '';
  const duration = v.lengthText?.simpleText || '';
  return {
    id: v.videoId,
    title: v.title?.runs?.[0]?.text || v.title?.simpleText || '',
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : '',
    channel: v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '',
    duration,
    views: viewsText,
    viewCount: parseYoutubeViewCount(viewsText),
    durationMin: parseYoutubeDurationMinutes(duration),
    isLive: isYoutubeLiveRenderer(v),
    publishedAt: v.publishedTimeText?.simpleText || '',
    description: (
      v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r) => r.text).join('') ||
      v.descriptionSnippet?.runs?.map((r) => r.text).join('') ||
      ''
    ).trim()
  };
}

async function fetchTrendingVideos({ useTor = false, country = 'BR', clientIp = '' } = {}) {
  const shouldUseTor = Boolean(useTor);
  const hl = getHlForCountry(country);
  const cacheKey = `trending__${country}__${hl}__${shouldUseTor ? 'tor' : (clientIp || 'default')}`;
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
    const res = await fetchYoutubeHtml(url, hl, shouldUseTor, shouldUseTor ? '' : clientIp);
    if (res.ok && res.html) {
      const videos = (parseTrending(res.html) || []).filter((v) => !isEastAsianHeavyTitle((v && v.title) + ' ' + (v && v.channel)));
      if (videos.length) {
        youtubeSearchCache.set(cacheKey, { timestamp: Date.now(), videos });
        return videos;
      }
    }
  } catch (e) {}
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
  const shouldUseTor = Boolean(forceTor);
  const cacheKey = `${trimmed}__${hl}__${country || 'BR'}__${clientIp || 'default'}__${sortByRecent}__${timeFilter}__${searchMode || 'default'}__${shouldUseTor ? 'tor' : 'direct'}`;
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < YT_CACHE_TTL) && cached.videos.length > 0) {
    return cached.videos;
  }

  let url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(trimmed);
  url += '&hl=' + encodeURIComponent(hl || 'pt-BR') + '&gl=' + encodeURIComponent(country || 'BR') + '&persist_hl=1&persist_gl=1';
  url += youtubeSearchSp(sortByRecent, timeFilter, searchMode);

  const parseYoutubeHtml = (html) => {
    try {
      const match = html.match(/var ytInitialData = ({.*?});<\/script>/);
      if (!match) return [];
      const data = JSON.parse(match[1]);
      const sections = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
      const videos = [];
      const pushVideo = (v) => {
        if (!v || !v.videoId) return;
        const thumbs = v.thumbnail?.thumbnails || [];
        const bestThumb = (thumbs.length > 0) ? thumbs[thumbs.length - 1].url : '';
        const publishedAt = v.publishedTimeText?.simpleText || '';
        const description = (
          v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(r => r.text).join('') ||
          v.descriptionSnippet?.runs?.map(r => r.text).join('') ||
          ''
        ).trim();
        const viewsText = v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || '';
        const duration = v.lengthText?.simpleText || '';

        videos.push({
          id: v.videoId,
          title: v.title?.runs?.[0]?.text || v.title?.simpleText || '',
          thumbnail: bestThumb,
          channel: v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '',
          duration,
          views: viewsText,
          viewCount: parseYoutubeViewCount(viewsText),
          durationMin: parseYoutubeDurationMinutes(duration),
          isLive: isYoutubeLiveRenderer(v),
          publishedAt,
          description
        });
      };

      for (const s of sections) {
        const items = s.itemSectionRenderer?.contents || [];
        for (const it of items) {
          if (it.videoRenderer) {
            pushVideo(it.videoRenderer);
          }
          if (it.shelfRenderer) {
            const shelfItems = it.shelfRenderer?.content?.verticalListRenderer?.items || [];
            for (const sit of shelfItems) {
              if (sit.videoRenderer) pushVideo(sit.videoRenderer);
            }
          }
        }
      }
      return videos.slice(0, 30);
    } catch(e) {
      return [];
    }
  };

  // Se o Tor estiver ativado pelo usuário, a conexão DEVE passar obrigatoriamente pela rede Tor primeiro
  if (shouldUseTor && torAgent) {
    try {
      const torRes = await fetchYoutubeHtml(url, hl, true, clientIp);
      if (torRes.ok && torRes.html) {
        const torVideos = parseYoutubeHtml(torRes.html);
        if (torVideos && torVideos.length > 0) {
          const filtered = filterVideosByCountryRelevance(keepThemeVideos(filterYoutubeModeResults(torVideos, searchMode), trimmed), country);
          if (filtered.length) {
            youtubeSearchCache.set(cacheKey, { timestamp: Date.now(), videos: filtered });
            return filtered;
          }
        }
      }
    } catch (e) {}
    // Se o Tor falhou ou foi bloqueado pelo YouTube, recorre à conexão direta para garantir resposta rápida
  }

  // Sem Tor: tenta conexão direta
  try {
    const directRes = await fetchYoutubeHtml(url, hl, false, clientIp);
    if (directRes.ok && directRes.html) {
      const directVideos = parseYoutubeHtml(directRes.html);
      if (directVideos && directVideos.length > 0) {
        const filtered = filterVideosByCountryRelevance(keepThemeVideos(filterYoutubeModeResults(directVideos, searchMode), trimmed), country);
        if (filtered.length) {
          youtubeSearchCache.set(cacheKey, { timestamp: Date.now(), videos: filtered });
          return filtered;
        }
      }
    }
  } catch (e) {}

  return [];
}

// ----------------------------------------------------
// MOTOR DE RECONHECIMENTO E DOWNLOAD DE VÍDEOS (MP4 / MP3)
// ----------------------------------------------------
function downloadMediaFile(urlOrId, format = 'mp4', onProgress = null, quality = '720') {
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

    const args = [
      '-u',
      '-m', 'yt_dlp',
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=android,ios,web,mweb',
      '--no-playlist',
      '--newline',
      '--no-warnings',
      '--write-info-json',
      '-o', outputTemplate
    ].concat(ytdlpProxyArgs());

    if (isMp3) {
      args.push(
        '-f', 'ba/ba*',
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
        args.push('-f', 'bv*+ba/b', '--merge-output-format', 'mp4');
      } else {
        args.push('-f', `bv*[height<=${height}]+ba/b[height<=${height}]/b[height<=${height}]/bv*+ba/b`, '--merge-output-format', 'mp4');
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
        } catch (e) {}
      }

      const finalExt = isMp3 ? 'mp3' : 'mp4';
      let actualFilename = `${fileId}.${finalExt}`;
      try {
        const files = fs.readdirSync(MEDIA_DOWNLOADS_DIR);
        const match = files.find(f => f.startsWith(fileId) && f.endsWith('.' + finalExt));
        if (match) actualFilename = match;
      } catch (e) {}

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

function startMediaDownloadJob(urlOrId, format = 'mp4', quality = '720') {
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
  }, quality).then((res) => {
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
        } catch (e) {}
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
    } catch (e) {}
  }

  // 3. Se ainda faltar para o alvo, complementa com o Chart Geral oficial de 2026
  if (playlist.length < targetCount) {
    try {
      const chartRes = await getDeezerChartTracks(60);
      if (chartRes && chartRes.success && chartRes.results) {
        chartRes.results.forEach(t => addTrack(t, '⭐ Top Paradas 2026'));
      }
    } catch (e) {}
  }

  return playlist.slice(0, Math.max(targetCount, playlist.length));
}

// Cache em memória para URLs de stream de áudio (4 horas de retenção)
const audioStreamUrlCache = new Map();

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

const videoStreamUrlCache = new Map();
const playUrlCache = new Map();

function getFullVideoStreamByVideoId(videoId) {
  if (!videoId) return Promise.resolve({ success: false, error: 'ID ausente' });
  if (videoStreamUrlCache.has(videoId)) {
    const cached = videoStreamUrlCache.get(videoId);
    if (Date.now() - cached.timestamp < 4 * 60 * 60 * 1000) {
      return Promise.resolve({ success: true, streamUrl: cached.url });
    }
  }
  const ytdlpPath = process.platform === 'win32' ? 'yt-dlp' : (fs.existsSync('/home/nain/.local/bin/yt-dlp') ? '/home/nain/.local/bin/yt-dlp' : 'yt-dlp');
  return new Promise((resolve) => {
    execFile(ytdlpPath, [
      ...ytdlpProxyArgs(),
      '--no-playlist',
      '-f', 'b/bv*+ba/b/best[height<=1080]/best',
      '--no-warnings',
      '-g',
      'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId)
    ], { timeout: 15000 }, (error, stdout) => {
      if (error) return resolve({ success: false, error: error.message });
      const lines = (stdout || '').trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
      const streamUrl = lines[0] || '';
      if (streamUrl && streamUrl.startsWith('http')) {
        videoStreamUrlCache.set(videoId, { url: streamUrl, timestamp: Date.now() });
        resolve({ success: true, streamUrl });
      } else {
        resolve({ success: false, error: 'URL de vídeo inválida' });
      }
    });
  });
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

// Extrai áudio completo via yt-dlp por ID do vídeo com cache
function getFullAudioStreamByVideoId(videoId) {
  if (!videoId) return Promise.resolve({ success: false, error: 'ID ausente' });
  if (audioStreamUrlCache.has(videoId)) {
    const cached = audioStreamUrlCache.get(videoId);
    if (Date.now() - cached.timestamp < 4 * 60 * 60 * 1000) {
      return Promise.resolve({ success: true, streamUrl: cached.url });
    }
  }

  const ytdlpPath = process.platform === 'win32' ? 'yt-dlp' : (fs.existsSync('/home/nain/.local/bin/yt-dlp') ? '/home/nain/.local/bin/yt-dlp' : 'yt-dlp');

  return new Promise((resolve) => {
    execFile(ytdlpPath, [
      ...ytdlpProxyArgs(),
      '--no-playlist',
      '-f', 'ba[ext=m4a]/140/ba/b',
      '--no-warnings',
      '-g',
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    ], { timeout: 12000 }, (error, stdout) => {
      if (error) {
        return resolve({ success: false, error: error.message });
      }
      const streamUrl = (stdout || '').trim().split('\n')[0];
      if (streamUrl && streamUrl.startsWith('http')) {
        audioStreamUrlCache.set(videoId, { url: streamUrl, timestamp: Date.now() });
        resolve({ success: true, streamUrl });
      } else {
        resolve({ success: false, error: 'URL de stream inválida' });
      }
    });
  });
}

// Proxy de streaming de áudio/vídeo contínuo com suporte a Range, imune a bloqueios de IP do Google Video
function handleAudioStreamingProxy(req, res, { title, artist, videoId, preferVideo }) {
  const fetchPromise = preferVideo && videoId
    ? getFullVideoStreamByVideoId(videoId)
    : (videoId ? getFullAudioStreamByVideoId(videoId) : getFullAudioStream({ title, artist }));
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

const musicRecCache = new Map();
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
  } catch (ePl) {}

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
    } catch (eG) {}
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
    } catch (err) {}
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
    } catch (e2) {}
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
const curatorSuggestionsCache = new Map();
const CURATOR_CACHE_TTL = 5 * 60 * 1000;

function extractRelatedKeywords(title, channel) {
  if (!title) return channel || 'videos recomendados';
  let clean = String(title).replace(/\[.*?\]|\(.*?\)/g, ' ');
  clean = clean.replace(/[|•#\-_–—~:;!?,./\\]/g, ' ');
  clean = clean.replace(/\b(oficial|official|clipe|video|vídeo|audio|áudio|ao vivo|live|hd|4k|legendado|dublado|completo|lançamento|music|mv)\b/gi, ' ');
  const words = clean.trim().split(/\s+/).filter((w) => w.length > 2).slice(0, 5);
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
  // Bônus equilibrado para canal (evita prender apenas em vídeos velhos do mesmo canal)
  if (seedChannel && channel && (channel === seedChannel || channel.includes(seedChannel) || seedChannel.includes(channel))) score += 20;
  seedTitle.split(/[^a-z0-9]+/).filter((w) => w.length > 2).forEach((w) => {
    if (title.includes(w)) score += 12;
    if (channel.includes(w)) score += 4;
  });
  // Bônus forte para coincidir com o TEMA da pesquisa
  seedQuery.split(/[^a-z0-9]+/).filter((w) => w.length > 2).forEach((w) => {
    if (title.includes(w)) score += 22;
    if (channel.includes(w)) score += 6;
  });
  // Bônus de RECÊNCIA: vídeos postados recentemente sobem para o topo
  const pub = String(video && video.publishedAt || '').toLowerCase();
  if (/hora|horas|minuto|minutos|hoje|ontem|\b\d+\s*h\b|\b\d+\s*min\b|today|hours?|mins?|ao vivo|live/i.test(pub)) {
    score += 45;
  } else if (/dia|dias|days?/i.test(pub)) {
    score += 30;
  } else if (/semana|semanas|weeks?/i.test(pub)) {
    score += 18;
  } else if (/m[eê]s|meses|months?|ano|anos|years?/i.test(pub)) {
    // Penalidade para vídeos com meses ou anos de idade (afasta vídeos antigos)
    score -= 35;
  }
  // Bônus para ano recente no título
  if (/2026/i.test(title)) score += 16;
  else if (/2025/i.test(title)) score += 6;

  if (video && video.viewCount) score += Math.min(12, Math.log10(video.viewCount + 1) * 2);
  return score;
}

async function fetchRelatedYoutubeVideos(videoId, useTor = false, hl = 'pt-BR', country = 'BR') {
  if (!videoId) return [];
  const shouldUseTor = Boolean(useTor);
  const cacheKey = 'related__' + videoId + '__' + (hl || 'pt-BR') + '__' + (country || 'BR') + '__' + (shouldUseTor ? 'tor' : 'direct');
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < YT_CACHE_TTL) && cached.videos.length > 0) {
    return cached.videos;
  }
  try {
    const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId) + '&hl=' + encodeURIComponent(hl || 'pt-BR') + '&gl=' + encodeURIComponent(country || 'BR');
    const res = await fetchYoutubeHtml(url, hl || 'pt-BR', shouldUseTor);
    if (!res || !res.ok || !res.html) return [];
    const match = res.html.match(/var ytInitialData = ({.*?});<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const videos = [];
    const seen = new Set([videoId]);
    const push = (renderer) => {
      const mapped = mapYoutubeRenderer(renderer);
      if (!mapped || seen.has(mapped.id)) return;
      seen.add(mapped.id);
      videos.push(mapped);
    };
    const secondary = (((data.contents || {}).twoColumnWatchNextResults || {}).secondaryResults || {}).secondaryResultsRenderer || {};
    (secondary.results || []).forEach((item) => {
      if (item.compactVideoRenderer) push(item.compactVideoRenderer);
      if (item.videoRenderer) push(item.videoRenderer);
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
const curatorVideoAiCache = new Map();
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
      queries = queries.map((q) => /completo/i.test(q) ? q : (q + ' filme completo dublado'));
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
  const dyn = getDynamicRecentYoutubeQuery(theme || 'noticias', false, country);
  const dyn2 = getDynamicRecentYoutubeQuery(theme || 'noticias', false, country);
  const base = String((dyn && dyn.query) || theme || 'noticias').trim();
  const extra = String((dyn2 && dyn2.query) || '').trim();
  const isPt = country === 'BR' || country === 'PT';
  const suffixes = isPt
    ? [' 2026', ' novos', ' hoje', ' ultimas', ' lancamentos', ' ao vivo']
    : [' 2026', ' latest', ' new', ' today', ' trending', ' live'];
  const suffix = suffixes[(Math.max(1, page) - 1) % suffixes.length];
  const queries = [base + suffix, base];
  if (extra && extra.toLowerCase() !== base.toLowerCase()) queries.push(extra + suffix);
  if (theme && theme.toLowerCase() !== base.toLowerCase()) queries.push(`${theme} 2026`);
  return {
    queries: queries.filter((q, i, arr) => q && arr.indexOf(q) === i).slice(0, 3),
    searchMode: (dyn && dyn.searchMode) || '',
    isCustomQuery: !!(dyn && dyn.isCustomQuery)
  };
}

async function getAiCuratorSuggestions({ type, currentQuery, currentTitle, currentChannel, currentVideoId, excludeTitles = [], page = 1, stayOnTheme = true, useAi = false, useTor = false, country = 'BR', clientIp = '', timeFilter = 'month' }) {
  const isCinema = type === 'filmes' || type === 'cinema';
  const cleanTitle = (currentTitle || '').trim();
  const cleanChannel = (currentChannel || '').trim();
  const themeQuery = String(currentQuery || '').trim();
  // O vídeo atual entra no cache mesmo em "stayOnTheme": a IA usa título/canal para o recorte.
  const videoKey = isGenericVideoTitle(cleanTitle) ? '' : (cleanTitle + '|' + cleanChannel).toLowerCase();
  const cacheKey = `${type}__${stayOnTheme ? 'theme' : 'mix'}__${useAi ? 'ai' : 'fast'}__${themeQuery}__${videoKey}__${country}__${clientIp || 'default'}__${page}__${useTor ? 'tor' : 'direct'}`;

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
    if (fresh.length >= 6) {
      return Object.assign({}, cached.data, { items: fresh.slice(0, 16) });
    }
  }

  const hasVideoContext = !isGenericVideoTitle(cleanTitle);
  const targetTheme = (themeQuery || (hasVideoContext ? '' : 'noticias')).trim();
  const activeTheme = (targetTheme || cleanTitle || 'noticias').toLowerCase();
  const keyword = extractRelatedKeywords(cleanTitle, cleanChannel);

  let queries = [];
  let defaultReason = '';
  let searchMode = '';

  if (isCinema || activeTheme.includes('filme') || activeTheme.includes('cinema')) {
    const dynamicMovie = getDynamicRecentMovieQuery(themeQuery || 'todos');
    queries = [dynamicMovie.query, 'filmes completos dublados lancamentos 2026', 'filmes completos dublados 2026'];
    defaultReason = '🍿 Mais filmes completos dublados para você';
  } else if (hasVideoContext) {
    // Quando há um vídeo atual, combinamos o TEMA com o ASSUNTO DO VÍDEO + MARCADORES DE NOVIDADE
    const isPt = country === 'BR' || country === 'PT';
    const novSuffix = isPt ? ' 2026' : ' 2026 latest';
    const novSuffix2 = isPt ? ' novos' : ' new';

    if (targetTheme && targetTheme.toLowerCase() !== keyword.toLowerCase()) {
      queries = [
        `${targetTheme} ${keyword}${novSuffix}`,
        `${keyword}${novSuffix}`,
        `${targetTheme} ${keyword}${novSuffix2}`,
        `${cleanChannel ? cleanChannel + ' ' : ''}${keyword}`
      ].filter(Boolean);
      defaultReason = `⚡ Novos vídeos de "${targetTheme}": mais sobre ${keyword.slice(0, 35)}...`;
    } else {
      queries = [
        `${keyword}${novSuffix}`,
        `${keyword}${novSuffix2}`,
        `${cleanChannel ? cleanChannel + ' ' : ''}${keyword}`
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
  queries = queries.filter((q, i, arr) => q && arr.indexOf(q) === i).slice(0, 3);

  const hl = getHlForCountry(country);
  const effectiveClientIp = useTor ? '' : clientIp;

  // 1. RECOMENDAÇÕES NATIVAS DIRETAS DO YOUTUBE:
  // Se há um vídeo atual, puxa na hora os vídeos recomendados / Up Next direto do YouTube (~300ms)
  const relatedPromise = currentVideoId
    ? fetchRelatedYoutubeVideos(currentVideoId, useTor, hl, country).catch(() => [])
    : Promise.resolve([]);

  // 2. BUSCAS DIRETAS NO YOUTUBE EM PARALELO (~300ms)
  const localSearchPromises = queries.slice(0, 3).map((q) =>
    searchYoutubeVideos(q, hl, true, timeFilter, useTor, searchMode, country, effectiveClientIp).catch(() => [])
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
  if (hasVideoContext) {
    defaultReason = `Recomendações do YouTube baseadas em "${cleanTitle.length > 40 ? cleanTitle.slice(0, 37) + '...' : cleanTitle}"`;
  } else {
    defaultReason = `Vídeos recomendados pelo YouTube sobre ${activeTheme === 'noticias' ? 'notícias recentes' : activeTheme}`;
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
        searchYoutubeVideos(q, hl, true, timeFilter, useTor, searchMode, country, effectiveClientIp).catch(() => [])
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
    items: ranked.slice(0, 16)
  };

  if (stayOnTheme && resultData.items.length < 5 && page < 6) {
    return getAiCuratorSuggestions({
      type,
      currentQuery: targetTheme || currentQuery,
      currentTitle,
      currentChannel,
      currentVideoId,
      excludeTitles,
      page: page + 1,
      stayOnTheme,
      useAi,
      useTor,
      country,
      clientIp,
      timeFilter
    });
  }

  curatorSuggestionsCache.set(cacheKey, { timestamp: Date.now(), data: resultData });
  return resultData;
}

// Gerenciador de sessões isoladas por cliente (Mobile e Desktop)
// Cada cliente tem seu próprio histórico de DJ, músicas excluídas, abas e estado de player,
// mas compartilha o mesmo login / credenciais Spotify e OpenAI da aplicação.
const clientSessions = new Map();

function getOrCreateClientSession(clientId) {
  if (!clientId || typeof clientId !== 'string') {
    clientId = 'client_default';
  }
  if (!clientSessions.has(clientId)) {
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
  return session;
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

const server = http.createServer(async (req, res) => {
  req.on('aborted', () => {
    try { if (!res.writableEnded) res.destroy(); } catch (e) {}
  });

  // CORS para permitir conexões de qualquer dispositivo ou túnel, inclusive rede local
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Permissions-Policy', 'picture-in-picture=*, fullscreen=*, autoplay=*, encrypted-media=*, local-network=*, local-network-access=*, local-unrestricted=*, display-capture=*, presentation=*');
  res.setHeader('ngrok-skip-browser-warning', '1');
  try {
    res.setHeader('Set-Cookie', 'ngrok-skip-browser-warning=1; Path=/; Max-Age=31536000; SameSite=Lax');
  } catch (e) {}

  if (req.method === 'OPTIONS') {
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    res.writeHead(204);
    res.end();
    return;
  }


  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

  // Identificação do cliente e sessão (disponível para todas as rotas)
  const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
  const clientSession = getOrCreateClientSession(clientId);

  // Rastreamento de acessos de IP, dispositivo e geolocalização para o Painel Administrativo
  try {
    if (!pathname.includes('metric') && !pathname.startsWith('/api/papaleguas') && !pathname.startsWith('/papaleguas')) {
      papaleguasTracker.logAccess(req, pathname, req.url);
    }
  } catch (e) {}

  // Manifesto PWA para instalação no celular / desktop com ícone do Papaléguas
  if (pathname === '/manifest.json' || pathname === '/manifest.webmanifest') {
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    const manifestPath = path.join(SRC_DIR, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      res.end(fs.readFileSync(manifestPath, 'utf8'));
    } else {
      res.end(JSON.stringify({
        name: 'Papaléguas BaixaTube',
        short_name: 'Papaléguas',
        start_url: '/',
        id: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0b0d14',
        theme_color: '#0b0d14',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/papaleguas_icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
        ]
      }));
    }
    return;
  }

  // Service Worker para PWA (requisito obrigatório do Chrome no Android para habilitar "Instalar App")
  if (pathname === '/sw.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
      'Access-Control-Allow-Origin': '*'
    });
    const swPath = path.join(SRC_DIR, 'sw.js');
    if (fs.existsSync(swPath)) {
      res.end(fs.readFileSync(swPath, 'utf8'));
    } else {
      res.end(`
        self.addEventListener('install', (e) => self.skipWaiting());
        self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', (e) => {});
      `);
    }
    return;
  }

  // ----------------------------------------------------
  // ENDPOINTS DE API (Música, DJ Papaléguas e Streams)
  // ----------------------------------------------------
  if (pathname.startsWith('/api/')) {
    
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
        ttsRes.pipe(res);
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
      } catch (e) {}
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
        getHlForCountry,
        getDynamicRecentYoutubeQuery,
        rotateThemeSearchQueries,
        isNewsYoutubeCategory,
        fetchTrendingVideos,
        searchYoutubeVideos,
        filterYoutubeModeResults,
        filterVideosByCountryRelevance,
        caches: {
          mixedNewsCache,
          mixedNewsCacheTime,
          youtubeSearchCache
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
        searchDeezerPlaylists,
        searchDeezerAll
      });
      if (handled) return;
    }

    // ----------------------------------------------------
    // ENDPOINTS ADMINISTRATIVOS PAPALÉGUAS (Setup, Auth, Metrics)
    // ----------------------------------------------------
    if (pathname.startsWith('/api/papaleguas') && pathname !== '/api/papaleguas/device-telemetry') {
      if (!isLocalAdminRequest(req)) {
        sendForbiddenAdminResponse(res, true);
        return;
      }
      const isPublicAdminRoute = pathname === '/api/papaleguas/status' || pathname === '/api/papaleguas/login' || pathname === '/api/papaleguas/setup';
      if (!isPublicAdminRoute) {
        if (!papaleguasTracker.validateSession(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Acesso restrito. Faça login como administrador para continuar.' }));
          return;
        }
      }
    }

    if (pathname === '/api/papaleguas/status') {
      const clientIp = papaleguasTracker.extractClientIp(req);
      const isLocal = papaleguasTracker.isPrivateIp(clientIp);
      const authenticated = isLocal || papaleguasTracker.validateSession(req);
      const hasAdmin = papaleguasTracker.hasAdminAccount();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      const torOn = isAppTorEnabled();
      let torConnected = false;
      if (torOn) {
        try {
          const torStatus = await torManager.checkTorStatus();
          torConnected = Boolean(torStatus && torStatus.connected);
        } catch (e) {}
      }
      const ngStatus = ngrokTunnel.getTunnelStatus();
      const activePublicUrl = ngStatus.url || null;
      res.end(JSON.stringify({
        hasAdmin,
        authenticated,
        username: authenticated ? 'Administrador' : null,
        isTrackingEnabled: papaleguasTracker.isTrackingEnabled(),
        serverLogsPaused: isServerConsoleLogsPaused(),
        tunnelUrl: activePublicUrl,
        ngrokTunnelUrl: ngStatus.url || null,
        ngrokTunnelConnecting: Boolean(ngStatus.connecting),
        lanAccessUrl: `http://${getLocalNetworkIp()}:${PORT}`,
        torEnabled: torOn,
        torConnected
      }));
      return;
    }

    if (pathname === '/api/papaleguas/tunnel-restart' && req.method === 'POST') {
      ngrokTunnel.stopTunnel();
      ngrokTunnel.startTunnel(PORT);
      const ngStatus = ngrokTunnel.getTunnelStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        url: ngStatus.url || null,
        connecting: Boolean(ngStatus.connecting)
      }));
      return;
    }

    if (pathname === '/api/papaleguas/setup' && req.method === 'POST') {
      try {
        const { username, password } = body;
        const result = papaleguasTracker.createAdminAccount(username, password);
        if (result.success && result.token) {
          res.setHeader('Set-Cookie', `papaleguas_token=${result.token}; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (pathname === '/api/papaleguas/login' && req.method === 'POST') {
      try {
        const { username, password } = body;
        const result = papaleguasTracker.authenticateAdmin(username, password);
        if (result.success) {
          res.setHeader('Set-Cookie', `papaleguas_token=${result.token}; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (pathname === '/api/papaleguas/logout' && req.method === 'POST') {
      papaleguasTracker.logoutAdmin(req);
      res.setHeader('Set-Cookie', 'papaleguas_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (pathname === '/api/papaleguas/metrics') {
      const clientIp = papaleguasTracker.extractClientIp(req);
      const isLocal = papaleguasTracker.isPrivateIp(clientIp);
      if (!isLocal && !papaleguasTracker.validateSession(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Não autorizado. Faça login como administrador.' }));
        return;
      }
      const metrics = papaleguasTracker.calculateAcceptanceAndEvolutionMetrics();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      let ngStatus = ngrokTunnel.getTunnelStatus();
      if (!ngStatus.running && !ngStatus.connecting) {
        ngrokTunnel.startTunnel(PORT);
        ngStatus = ngrokTunnel.getTunnelStatus();
      }
      res.end(JSON.stringify({
        success: true,
        tunnelUrl: ngStatus.url || null,
        ngrokTunnelUrl: ngStatus.url || null,
        ngrokTunnelConnecting: Boolean(ngStatus.connecting),
        lanAccessUrl: `http://${getLocalNetworkIp()}:${PORT}`,
        ...metrics
      }));
      return;
    }

    if (pathname === '/api/papaleguas/device-telemetry' && req.method === 'POST') {
      try {
        const clientIp = papaleguasTracker.extractClientIp(req);
        const updated = papaleguasTracker.updateClientTelemetry(clientIp, body || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, clientIp, updated: Boolean(updated) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // Excluir todos os dados gravados de log e requisições (começando do zero)
    if (pathname === '/api/papaleguas/clear-data' && req.method === 'POST') {
      const clientIp = papaleguasTracker.extractClientIp(req);
      const isLocal = papaleguasTracker.isPrivateIp(clientIp);
      if (!isLocal && !papaleguasTracker.validateSession(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Não autorizado. Faça login como administrador.' }));
        return;
      }
      const result = papaleguasTracker.clearAllAnalyticsData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Parar / Retomar registro de logs e requisições
    if (pathname === '/api/papaleguas/toggle-tracking' && req.method === 'POST') {
      const clientIp = papaleguasTracker.extractClientIp(req);
      const isLocal = papaleguasTracker.isPrivateIp(clientIp);
      if (!isLocal && !papaleguasTracker.validateSession(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Não autorizado. Faça login como administrador.' }));
        return;
      }
      const current = papaleguasTracker.isTrackingEnabled();
      const newEnabled = body && typeof body.enabled === 'boolean' ? body.enabled : !current;
      const updated = papaleguasTracker.setTrackingEnabled(newEnabled);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        isTrackingEnabled: updated,
        message: updated ? 'Registro de logs e requisições ATIVADO.' : 'Registro de logs e requisições PAUSADO.'
      }));
      return;
    }

    // Parar / Retomar exibição de logs no terminal do servidor (Console Mute)
    if (pathname === '/api/papaleguas/server-logs' && req.method === 'POST') {
      const clientIp = papaleguasTracker.extractClientIp(req);
      const isLocal = papaleguasTracker.isPrivateIp(clientIp);
      if (!isLocal && !papaleguasTracker.validateSession(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Não autorizado. Faça login como administrador.' }));
        return;
      }
      const isPaused = body && (body.paused === true || body.value === 'paused');
      const updatedPaused = setServerConsoleLogsPaused(isPaused);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        serverLogsPaused: updatedPaused,
        message: updatedPaused ? 'Logs do terminal pausados (modo silencioso).' : 'Logs do terminal ativados (visíveis).'
      }));
      return;
    }

    if (pathname === '/api/onion-search') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, q: '', items: [] }));
      return;
    }

    if (pathname === '/api/url-suggest') {
      const q = reqUrl.searchParams.get('q') || body.q || '';
      const page = parseInt(reqUrl.searchParams.get('page') || body.page || '0', 10);
      const useTor = isTorRoutingEnabled(clientSession);
      const payload = await getUrlSuggestions({ query: q, page, useTor });
      res.writeHead(200);
      res.end(JSON.stringify(payload));
      return;
    }

    // Alimenta a aba de pesquisa em tela cheia com tudo que o buscador extraiu
    if (pathname === '/api/search-rich') {
      const q = reqUrl.searchParams.get('q') || body.q || '';
      const useTor = isTorRoutingEnabled(clientSession);
      const data = await getRichSearchData(q, useTor);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, ...data }));
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

    if (pathname === '/api/playlist-tracks') {
      const id = reqUrl.searchParams.get('id');
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'id param required' }));
      }
      try {
        const result = await getDeezerPlaylistTracks(id, 200);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/playlists') {
      const q = reqUrl.searchParams.get('q') || body.q || '';
      const result = await searchDeezerPlaylists(q);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/all') {
      const q = reqUrl.searchParams.get('q') || body.q || '';
      const result = await searchDeezerAll(q);
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
          audioRes.pipe(res);
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
          } catch (e) {}
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
        imgRes.pipe(res);
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
  } catch (e) {}

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
  } catch (e) {}
  return new Set();
}

function markPlaylistAsDeleted(name) {
  if (!name) return;
  try {
    const set = getDeletedPlaylistsSet();
    set.add(String(name).trim().toLowerCase());
    fs.mkdirSync(path.dirname(DELETED_PLAYLISTS_FILE), { recursive: true });
    fs.writeFileSync(DELETED_PLAYLISTS_FILE, JSON.stringify(Array.from(set)), 'utf8');
  } catch (e) {}
}

function unmarkPlaylistAsDeleted(name) {
  if (!name) return;
  try {
    const set = getDeletedPlaylistsSet();
    set.delete(String(name).trim().toLowerCase());
    fs.mkdirSync(path.dirname(DELETED_PLAYLISTS_FILE), { recursive: true });
    fs.writeFileSync(DELETED_PLAYLISTS_FILE, JSON.stringify(Array.from(set)), 'utf8');
  } catch (e) {}
}

function autoExtractZipDownloads() {
  try {
    const downloadsDir = path.resolve(os.homedir(), 'Downloads');
    const musicRoot = path.join(os.homedir(), 'Músicas', 'Papaléguas', 'Minhas playlists favoritas');
    if (!fs.existsSync(downloadsDir)) return;
    try { fs.mkdirSync(musicRoot, { recursive: true }); } catch (e) {}

    const deletedSet = getDeletedPlaylistsSet();
    const zipFiles = fs.readdirSync(downloadsDir).filter(f => f.toLowerCase().endsWith('.zip') && !f.startsWith('.'));
    for (const zipName of zipFiles) {
      const fullZipPath = path.join(downloadsDir, zipName);
      const rawBase = zipName.slice(0, -4);
      const cleanName = rawBase.replace(/\s*\(\d+\)$/, '').trim();
      if (!cleanName) continue;

      // Se a playlist foi marcada como excluída pelo usuário, não re-extrai e apaga o zip se solicitado
      if (deletedSet.has(cleanName.toLowerCase()) || deletedSet.has(rawBase.trim().toLowerCase())) {
        try { fs.unlinkSync(fullZipPath); } catch (e) {}
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
        try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
        try {
          const { execSync } = require('child_process');
          execSync(`unzip -q -o "${fullZipPath}" -d "${targetDir}"`, { timeout: 15000 });
        } catch (e) {}
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
                  try { fs.renameSync(found, path.join(targetDir, t.file)); } catch (e) {}
                }
              }
            }
          }
        }
      } catch (e) {}
    }
  } catch (err) {}
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
    try { fs.mkdirSync(root, { recursive: true }); } catch (e) {}
    return {
      root,
      downloads: path.resolve(os.homedir(), 'Downloads'),
      isHost: true,
      clientId: 'desktop_host'
    };
  }
  const deviceDir = path.join(base, 'Dispositivos', cleanId);
  try { fs.mkdirSync(deviceDir, { recursive: true }); } catch (e) {}
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
              } catch (e) {}
            } else {
              count = fs.readdirSync(dir).filter(f => audioExts.has(path.extname(f).toLowerCase()) && !f.startsWith('.')).length;
            }
            if (count > 0 || fs.existsSync(manifestPath)) {
              seenNames.add(ent.name.toLowerCase());
              playlists.push({ name: ent.name, count, cover, source: 'device', clientId: devInfo.clientId });
            }
          }
        } catch (e) {}
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
              } catch (e) {}
            } else {
              count = fs.readdirSync(dir).filter(f => audioExts.has(path.extname(f).toLowerCase()) && !f.startsWith('.')).length;
            }
            if (count > 0 || fs.existsSync(manifestPath)) {
              seenNames.add(ent.name.toLowerCase());
              playlists.push({ name: ent.name, count, cover, source: 'disk', clientId: devInfo.clientId });
            }
          }
        } catch (e) {}
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
            } catch (e) {}
            if (audioFiles.length > 0) {
              seenNames.add(ent.name.toLowerCase());
              let cover = '';
              try {
                const imgFiles = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
                if (imgFiles.length > 0) {
                  cover = `/api/downloaded-track-file?folder=__download__&file=${encodeURIComponent(ent.name + '/' + imgFiles[0])}`;
                }
              } catch (e) {}
              playlists.push({
                name: ent.name,
                count: audioFiles.length,
                cover,
                source: 'downloads'
              });
            }
          }
        } catch (e) {}
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
          try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {}
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
        } catch (e) {}
      }

      for (const rootDir of rootsToCheck) {
        if (!rootDir || !fs.existsSync(rootDir)) continue;
        try {
          // 1. Caminho direto
          const direct = path.join(rootDir, name);
          if (fs.existsSync(direct)) {
            try { fs.rmSync(direct, { recursive: true, force: true }); } catch (e) {}
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
              } catch (e) {}
            }
            if (isMatch) {
              try { fs.rmSync(path.join(rootDir, ent.name), { recursive: true, force: true }); } catch (e) {}
            }
          }
        } catch (e) {}
      }

      // Apaga arquivos .zip correspondentes em Downloads para não re-extrair e liberar espaço
      if (downloadsDir && fs.existsSync(downloadsDir)) {
        try {
          for (const f of fs.readdirSync(downloadsDir)) {
            if (!f.toLowerCase().endsWith('.zip')) continue;
            const baseZip = f.slice(0, -4).replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
            if (baseZip === targetClean || baseZip === name.toLowerCase()) {
              try { fs.unlinkSync(path.join(downloadsDir, f)); } catch (e) {}
            }
          }
        } catch (e) {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, clientId: devInfo.clientId }));
      return;
    }

    if (pathname === '/api/delete-favorite-track' && req.method === 'POST') {
      const playlist = String(body.playlist || reqUrl.searchParams.get('playlist') || '').trim();
      const fileName = String(body.fileName || body.file || reqUrl.searchParams.get('file') || '').trim();
      const clientId = String(body.clientId || reqUrl.searchParams.get('clientId') || req.headers['x-client-id'] || '').trim();
      const devInfo = getDevicePlaylistsRoot(clientId, req);
      const downloadsDir = path.resolve(os.homedir(), 'Downloads');

      if (devInfo.isHost && (playlist === '__download__' || playlist === 'Downloads' || fileName.includes('/'))) {
        const safeRel = fileName.replace(/^[\\/]+/, '');
        const target = path.resolve(downloadsDir, safeRel);
        if (target.startsWith(downloadsDir + path.sep) && fs.existsSync(target)) {
          try { fs.unlinkSync(target); } catch (e) {}
        }
      } else {
        let dir = path.join(devInfo.root, playlist);
        if (!fs.existsSync(dir) && devInfo.isHost) {
          const cand = path.join(downloadsDir, playlist);
          if (fs.existsSync(cand)) dir = cand;
        }
        if (dir && fs.existsSync(dir)) {
          const target = path.join(dir, path.basename(fileName));
          if (fs.existsSync(target)) {
            try { fs.unlinkSync(target); } catch (e) {}
          }
          const manifestPath = path.join(dir, 'playlist.json');
          if (fs.existsSync(manifestPath)) {
            try {
              const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              m.tracks = (m.tracks || []).filter(t => t.file !== fileName && path.basename(t.file) !== path.basename(fileName));
              fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
            } catch (e) {}
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
          } catch (e) {}
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
          } catch (e) {}
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
                    } catch (e) {}

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
              } catch (e) {}
            }
          }
        }
      } catch (err) {}

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, count: results.length, results, clientId: devInfo.clientId }));
      return;
    }

    if (pathname === '/api/downloaded-track-file') {
      let folder = reqUrl.searchParams.get('folder') || '';
      let file = reqUrl.searchParams.get('file') || '';
      try { folder = decodeURIComponent(folder); } catch (e) {}
      try { file = decodeURIComponent(file); } catch (e) {}
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
            } catch (e) {}
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
            } catch (e) {}
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
          } catch (e) {}
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
        fs.createReadStream(targetPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Type': mime
        });
        fs.createReadStream(targetPath).pipe(res);
      }
      return;
    }

    if (pathname === '/api/session-info') {
      let ngStatus = ngrokTunnel.getTunnelStatus();
      if (!ngStatus.running && !ngStatus.connecting) {
        ngrokTunnel.startTunnel(PORT);
        ngStatus = ngrokTunnel.getTunnelStatus();
      }
      const activePublicUrl = ngStatus.url || null;
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        clientId: clientSession.clientId,
        sharedLogin: true,
        userName: clientSession.sharedLoginUser,
        isLoggedIn: clientSession.isLoggedIn,
        totalActiveSessions: clientSessions.size,
        tunnelUrl: activePublicUrl,
        ngrokTunnelUrl: ngStatus.url || null,
        ngrokTunnelConnecting: Boolean(ngStatus.connecting),
        serverVersion: SERVER_BUILD_VERSION
      }));
      return;
    }

    if (pathname === '/api/recommendations') {
      const q = body.query || reqUrl.searchParams.get('q') || '';
      const cat = body.category || reqUrl.searchParams.get('cat') || 'all';
      // Mescla o histórico de exclusões exclusivo deste cliente
      const clientExclude = Array.from(clientSession.playedTrackTitles);
      const inputExclude = body.excludeTitles || [];
      const exclude = Array.from(new Set([...clientExclude, ...inputExclude]));

      const countryParam = body.country || reqUrl.searchParams.get('country') || 'BR';
      const result = await getAiMusicRecommendations(q, cat, exclude, countryParam);
      // Registra as faixas recomendadas na sessão deste cliente
      if (result && result.success && Array.isArray(result.results)) {
        result.results.forEach(tr => {
          if (tr.title) clientSession.playedTrackTitles.add(tr.title.trim().toLowerCase());
        });
      }

      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/dj-chat') {
      const message = body.userMessage || '';
      // Histórico específico do cliente
      const history = (body.history && body.history.length > 0) ? body.history : clientSession.djChatHistory;
      const clientExclude = Array.from(clientSession.playedTrackTitles);
      const inputExclude = body.excludeTitles || [];
      const exclude = Array.from(new Set([...clientExclude, ...inputExclude]));

      const result = await chatDjPapaleguas(message, history, exclude, body.trackCount);

      if (result && result.success) {
        clientSession.djChatHistory.push({ role: 'user', content: message });
        if (result.reply) clientSession.djChatHistory.push({ role: 'dj', content: result.reply });
        if (Array.isArray(result.results)) {
          result.results.forEach(tr => {
            if (tr.title) clientSession.playedTrackTitles.add(tr.title.trim().toLowerCase());
          });
        }
      }

      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/yt-thumb') {
      const videoId = String(reqUrl.searchParams.get('v') || reqUrl.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!videoId) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('v ausente');
        return;
      }
      https.get('https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/hqdefault.jpg', {
        agent: getOutboundAgent(false),
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, (imgRes) => {
        res.writeHead(imgRes.statusCode || 200, {
          'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        });
        imgRes.pipe(res);
      }).on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('thumb');
        }
      });
      return;
    }

    if (pathname === '/api/prewarm-playlist' && req.method === 'POST') {
      const list = Array.isArray(body.tracks) ? body.tracks.slice(0, 60) : [];
      let running = 0;
      const queue = list.filter((t) => t && t.title);
      const next = () => {
        while (running < 2 && queue.length) {
          const t = queue.shift();
          running += 1;
          getFullAudioStream({ title: String(t.title), artist: String(t.artist || '') })
            .catch(() => null)
            .then(() => { running -= 1; setTimeout(next, 300); });
        }
      };
      next();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, queued: list.length }));
      return;
    }

    if (pathname === '/api/stream-audio') {
      const title = reqUrl.searchParams.get('title') || body.title || '';
      const artist = reqUrl.searchParams.get('artist') || body.artist || '';
      const videoId = reqUrl.searchParams.get('v') || reqUrl.searchParams.get('id') || body.id || '';
      handleAudioStreamingProxy(req, res, { title, artist, videoId });
      return;
    }

    if (pathname === '/api/stream-video') {
      const videoId = reqUrl.searchParams.get('v') || reqUrl.searchParams.get('id') || body.id || body.v || '';
      handleAudioStreamingProxy(req, res, { videoId, preferVideo: true });
      return;
    }

    if (pathname === '/api/audio-stream') {
      const title = body.title || reqUrl.searchParams.get('title') || '';
      const artist = body.artist || reqUrl.searchParams.get('artist') || '';
      const result = await getFullAudioStream({ title, artist });
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/audio-stream-id') {
      const videoId = body.id || reqUrl.searchParams.get('id') || body.v || reqUrl.searchParams.get('v') || '';
      const result = await getFullAudioStreamByVideoId(videoId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
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
      let socketIp = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
      if (socketIp.startsWith('::ffff:')) socketIp = socketIp.replace('::ffff:', '');
      const host = String(req.headers.host || '').toLowerCase();
      const xForwarded = req.headers['x-forwarded-for'];
      const isLoopback = (socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '') &&
        (host.startsWith('localhost') || host.startsWith('127.0.0.1')) &&
        !xForwarded;
      if (!isLoopback) {
        // Dispositivos para transmitir devem estar na rede Wi-Fi do cliente (celular), não na rede do servidor!
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

    // ----------------------------------------------------
    // ENDPOINTS DE DOWNLOAD DE VÍDEOS E ÁUDIOS (MP4 / MP3)
    // ----------------------------------------------------
    if (pathname === '/api/media/download') {
      const url = body.url || reqUrl.searchParams.get('url') || '';
      const format = (body.format || reqUrl.searchParams.get('format') || 'mp4').toLowerCase();
      const isDirectDownload = reqUrl.searchParams.get('download') === '1';

      if (!url) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'URL ou ID do vídeo não fornecido' }));
        return;
      }

      try {
        const media = await downloadMediaFile(url, format);
        try {
          const clientIp = papaleguasTracker.extractClientIp(req);
          papaleguasTracker.logConversion(clientIp, 'download', { url, format });
        } catch (eConv) {}
        if (isDirectDownload) {
          res.writeHead(302, { 'Location': media.url });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, ...media }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (pathname === '/api/media/download-job') {
      const url = reqUrl.searchParams.get('url') || reqUrl.searchParams.get('videoId') || body.url || body.videoId || '';
      const format = (reqUrl.searchParams.get('format') || body.format || 'mp4').toLowerCase();
      const quality = reqUrl.searchParams.get('quality') || reqUrl.searchParams.get('resolution') || body.quality || body.resolution || '720';

      if (!url) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'URL ou ID do vídeo não fornecido' }));
        return;
      }

      const job = startMediaDownloadJob(url, format, quality);
      try {
        const clientIp = papaleguasTracker.extractClientIp(req);
        papaleguasTracker.logConversion(clientIp, 'download', { url, format, quality });
      } catch (e) {}
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ success: true, jobId: job.jobId }));
      return;
    }

    if (pathname === '/api/media/download-status') {
      const jobId = reqUrl.searchParams.get('jobId') || '';
      const job = mediaJobs.get(jobId);

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });

      if (!job) {
        res.end(JSON.stringify({ success: false, stage: 'not_found', error: 'Job de download não encontrado ou expirado' }));
        return;
      }

      if (job.stage === 'complete' && job.result) {
        res.end(JSON.stringify({
          success: true,
          stage: 'complete',
          progress: 100,
          text: 'Conversão e download concluídos!',
          ...job.result
        }));
      } else {
        res.end(JSON.stringify({
          success: job.stage !== 'error',
          stage: job.stage,
          progress: job.progress,
          speed: job.speed,
          eta: job.eta,
          total: job.total,
          frag: job.frag,
          text: job.text,
          error: job.error
        }));
      }
      return;
    }

    if (pathname === '/api/media/download-stream') {
      const url = reqUrl.searchParams.get('url') || '';
      const format = (reqUrl.searchParams.get('format') || 'mp4').toLowerCase();

      if (!url) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'URL ou ID do vídeo não fornecido' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*'
      });

      // Padding de 4KB para liberar buffer de proxies como Cloudflare Tunnel
      res.write(':\n' + ' '.repeat(4096) + '\n\n');

      function sendSSE(data) {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {}
      }

      sendSSE({ stage: 'init', progress: 3, text: 'Iniciando motor de download do Papaléguas...' });

      downloadMediaFile(url, format, (p) => {
        sendSSE(p);
      }).then((result) => {
        sendSSE({ stage: 'complete', progress: 100, success: true, ...result });
        res.end();
      }).catch((err) => {
        sendSSE({ stage: 'error', progress: 0, success: false, error: err.message });
        res.end();
      });

      req.on('close', () => {});
      return;
    }

    if (pathname === '/api/media/play-url') {
      const url = (reqUrl.searchParams.get('url') || body.url || '').trim();
      try {
        const data = await resolvePlayableMediaUrl(url);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: String(err && err.message || err).slice(0, 200) }));
      }
      return;
    }

    if (pathname === '/api/media/detect') {
      const url = body.url || reqUrl.searchParams.get('url') || '';
      if (!url) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'URL não fornecida' }));
        return;
      }
      const isYt = url.includes('youtube.com') || url.includes('youtu.be');
      const isDirectVideo = /\.(mp4|webm|m4v|mov|mkv)(\?|$)/i.test(url);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        detected: isYt || isDirectVideo,
        type: isYt ? 'youtube' : (isDirectVideo ? 'direct_video' : 'generic_media'),
        formats: ['mp4', 'mp3']
      }));
      return;
    }

    if (pathname.startsWith('/api/media/file/')) {
      const filename = path.basename(pathname.replace('/api/media/file/', ''));
      const filePath = path.join(MEDIA_DOWNLOADS_DIR, filename);

      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Arquivo de download não encontrado' }));
        return;
      }

      const stat = fs.statSync(filePath);
      const isMp3 = filename.endsWith('.mp3');
      const contentType = isMp3 ? 'audio/mpeg' : 'video/mp4';
      const customTitle = reqUrl.searchParams.get('title') || filename;
      const ext = isMp3 ? '.mp3' : '.mp4';
      let cleanTitle = customTitle.replace(/[\/\\?%*:|"<>]/g, '_').trim();
      if (cleanTitle.toLowerCase().endsWith(ext)) {
        cleanTitle = cleanTitle.slice(0, -ext.length).trim();
      }
      const asciiTitle = (cleanTitle.replace(/[^\x20-\x7E]/g, '_') || 'download').trim();
      const encodedTitle = encodeURIComponent(cleanTitle) + ext;

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${asciiTitle}${ext}"; filename*=UTF-8''${encodedTitle}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      });

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      return;
    }

    if (pathname === '/api/curator-recommendations') {
      const type = body.type || reqUrl.searchParams.get('type') || 'youtube';
      const currentQuery = body.currentQuery || reqUrl.searchParams.get('q') || '';
      const currentTitle = body.currentTitle || reqUrl.searchParams.get('title') || '';
      const currentChannel = body.currentChannel || reqUrl.searchParams.get('channel') || '';
      const currentVideoId = body.currentVideoId || reqUrl.searchParams.get('videoId') || '';
      const excludeTitles = (body && body.excludeTitles) || [];
      const page = parseInt((body && body.page) || reqUrl.searchParams.get('page') || '1', 10) || 1;
      const stayOnTheme = (body && body.stayOnTheme === true) || reqUrl.searchParams.get('stayOnTheme') === 'true';
      const useAi = (body && body.useAi === true) || reqUrl.searchParams.get('useAi') === 'true';
      const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || (body && body.clientId) || 'client_default';
      const clientSession = getOrCreateClientSession(clientId);
      // Recomendações e buscas do YouTube são sempre diretas para velocidade máxima
      const useTor = false;

      const clientIpParam = reqUrl.searchParams.get('deviceIp') || (body && body.deviceIp) || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
      const clientIp = extractRequestDeviceIp(req, clientIpParam);

      const clientCountryParam = (body && body.country) || reqUrl.searchParams.get('country') || '';
      let countryCode;
      if (clientCountryParam && /^[A-Z]{2}$/i.test(clientCountryParam)) {
        countryCode = clientCountryParam.toUpperCase();
      } else {
        countryCode = await getClientCountryCode(req, clientIp, false).catch(() => 'BR');
      }

      const result = await getAiCuratorSuggestions({
        type,
        currentQuery,
        currentTitle,
        currentChannel,
        currentVideoId,
        excludeTitles,
        page,
        stayOnTheme,
        useAi,
        useTor: false,
        country: countryCode,
        clientIp
      });

      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/country-detect') {
      try {
        const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
        const clientSession = getOrCreateClientSession(clientId);
        const useTor = isTorRoutingEnabled(clientSession);
        const clientIpParam = reqUrl.searchParams.get('deviceIp') || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
        const clientIp = extractRequestDeviceIp(req, clientIpParam);
        const country = await getClientCountryCode(req, clientIp, useTor);
        let effectiveIp = clientIp;
        if (useTor) {
          const torExit = await lookupOutboundIp(true).catch(() => null);
          if (torExit && torExit.IP) effectiveIp = torExit.IP;
        }
        const COUNTRY_NAMES = {
          BR: 'Brasil', US: 'Estados Unidos', GB: 'Reino Unido', AR: 'Argentina',
          MX: 'México', PT: 'Portugal', ES: 'Espanha', FR: 'França', DE: 'Alemanha',
          IT: 'Itália', JP: 'Japão', KR: 'Coreia do Sul', CN: 'China', RU: 'Rússia',
          CA: 'Canadá', AU: 'Austrália', IN: 'Índia', NG: 'Nigéria', ZA: 'África do Sul',
          TR: 'Turquia', PL: 'Polônia', NL: 'Países Baixos', SE: 'Suécia', NO: 'Noruega'
        };
        const COUNTRY_FLAGS = {
          BR: '🇧🇷', US: '🇺🇸', GB: '🇬🇧', AR: '🇦🇷', MX: '🇲🇽', PT: '🇵🇹',
          ES: '🇪🇸', FR: '🇫🇷', DE: '🇩🇪', IT: '🇮🇹', JP: '🇯🇵', KR: '🇰🇷',
          CN: '🇨🇳', RU: '🇷🇺', CA: '🇨🇦', AU: '🇦🇺', IN: '🇮🇳', NG: '🇳🇬',
          ZA: '🇿🇦', TR: '🇹🇷', PL: '🇵🇱', NL: '🇳🇱', SE: '🇸🇪', NO: '🇳🇴'
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          success: true,
          country,
          clientIp: effectiveIp,
          torActive: useTor,
          name: COUNTRY_NAMES[country] || country,
          flag: COUNTRY_FLAGS[country] || '🌍'
        }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, country: 'BR', name: 'Brasil', flag: '🇧🇷', torActive: false }));
      }
      return;
    }

    if (pathname === '/api/youtube-trending' || pathname === '/api/youtube-recent') {
      if (reqUrl.searchParams.get('refresh') === '1') {
        mixedNewsCache = null;
        mixedNewsCacheTime = 0;
        youtubeSearchCache.clear();
      }
      const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
      const clientSession = getOrCreateClientSession(clientId);
      // Buscas e recomendações do YouTube saem direto (sem Tor) na velocidade máxima da internet
      const useTor = false;
      const qParam = reqUrl.searchParams.get('q') || '';
      const clientCountryParam = reqUrl.searchParams.get('country') || '';
      const clientIpParam = reqUrl.searchParams.get('deviceIp') || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
      const clientIp = extractRequestDeviceIp(req, clientIpParam);

      // Se o cliente já detectou o país baseado no seu dispositivo, usa direto; senão detecta pelo IP do dispositivo/Tor.
      let countryCode;
      if (clientCountryParam && /^[A-Z]{2}$/i.test(clientCountryParam) && clientCountryParam.toUpperCase() !== 'AUTO') {
        countryCode = clientCountryParam.toUpperCase();
      } else {
        countryCode = await getClientCountryCode(req, clientIp, false).catch(() => 'BR');
      }

      const hl = getHlForCountry(countryCode);
      const effectiveClientIp = useTor ? '' : clientIp;

      // Obtém query dinâmica e fresca da piscina de novidades
      const forceCustom = reqUrl.searchParams.get('custom') === '1' || (qParam && qParam.trim().split(/\s+/).length > 2);
      const pageParam = parseInt(reqUrl.searchParams.get('page') || '1', 10);
      let { query: dynamicQuery, sortByRecent, isCustomQuery, searchMode } = getDynamicRecentYoutubeQuery(qParam || 'noticias', forceCustom, countryCode);
      if (pageParam > 1) {
        const rotated = rotateThemeSearchQueries(qParam || 'noticias', pageParam, countryCode);
        if (rotated.queries && rotated.queries[0]) dynamicQuery = rotated.queries[0];
        if (rotated.searchMode) searchMode = rotated.searchMode;
        sortByRecent = true;
      }
      let timeFilter = reqUrl.searchParams.get('time') || 'none';
      const isNews = isNewsYoutubeCategory(qParam || 'noticias');
      if (isNews) {
        if (!reqUrl.searchParams.has('time')) timeFilter = 'hour';
      } else {
        if (timeFilter === 'none') {
          sortByRecent = false;
        }
      }
      
      // If the user made a custom search, relax the time filter if it's set to 'hour' or 'day', to ensure they get results for any theme.
      if (isCustomQuery && (timeFilter === 'hour' || timeFilter === 'day')) {
        timeFilter = 'none'; // allow all time to ensure they get results for random themes
      }
      if (searchMode === 'trending' && (timeFilter === 'hour' || !timeFilter)) {
        timeFilter = 'week';
      }
      if (searchMode === 'podcast' && (timeFilter === 'hour' || timeFilter === 'day')) {
        timeFilter = 'week';
      }

      let videos = [];
      const feedWait = useTor ? 16000 : 7000;
      const extraWait = useTor ? 9000 : 3500;
      try {
        if (!isCustomQuery && searchMode === 'trending') {
          videos = await Promise.race([
            fetchTrendingVideos({ useTor, country: countryCode, clientIp: effectiveClientIp }).catch(() => []),
            new Promise((resolve) => setTimeout(() => resolve([]), feedWait))
          ]);
          if (!videos || videos.length < 12) {
            const extra = await searchYoutubeVideos(dynamicQuery, hl, false, timeFilter, useTor, 'trending', countryCode, effectiveClientIp).catch(() => []);
            const seen = new Set((videos || []).map((v) => v && v.id));
            for (const v of extra || []) {
              if (v && v.id && !seen.has(v.id)) {
                seen.add(v.id);
                videos.push(v);
              }
            }
            videos = filterYoutubeModeResults(videos, 'trending');
          }
        } else if (!isCustomQuery && isNewsYoutubeCategory(qParam || 'noticias')) {
          videos = await fetchMixedNewsVideos({ timeFilter, useTor, country: countryCode, clientIp: effectiveClientIp });
        } else {
          videos = await Promise.race([
            searchYoutubeVideos(dynamicQuery, hl, sortByRecent, timeFilter, useTor, searchMode, countryCode, effectiveClientIp).catch(() => []),
            new Promise((resolve) => setTimeout(() => resolve([]), feedWait))
          ]);
        }
      } catch (err) {
        videos = [];
      }

      videos = filterVideosByCountryRelevance(videos, countryCode);

      // AUTO-EXPANSÃO / AUTO-PREENCHIMENTO:
      if (!videos || videos.length < 12) {
        const seenIds = new Set((videos || []).map((v) => v && v.id));
        const widerFilters = [];
        if (timeFilter === 'hour') widerFilters.push('day', 'week', 'none');
        else if (timeFilter === 'day') widerFilters.push('week', 'none');
        else if (timeFilter === 'week') widerFilters.push('none');

        for (const wider of widerFilters) {
          if (videos.length >= 15) break;
          const extra = await Promise.race([
            searchYoutubeVideos(dynamicQuery, hl, wider !== 'none', wider, useTor, searchMode, countryCode, effectiveClientIp).catch(() => []),
            new Promise((resolve) => setTimeout(() => resolve([]), extraWait))
          ]);
          const filteredExtra = filterVideosByCountryRelevance(extra || [], countryCode);
          for (const v of filteredExtra) {
            if (v && v.id && !seenIds.has(v.id)) {
              seenIds.add(v.id);
              videos.push(v);
            }
          }
        }
      }

      if (!videos || videos.length < 12) {
        const seenIds = new Set((videos || []).map((v) => v && v.id));
        const countryKeyword = countryCode === 'BR' ? 'brasil' : (countryCode === 'PT' ? 'portugal' : countryCode);
        const fallbackQuery = `${qParam || 'noticias'} ${countryKeyword}`;
        const fallback = await Promise.race([
          searchYoutubeVideos(fallbackQuery, hl, false, 'none', useTor, searchMode, countryCode, effectiveClientIp).catch(() => []),
          new Promise((resolve) => setTimeout(() => resolve([]), extraWait))
        ]);
        const filteredFallback = filterVideosByCountryRelevance(fallback || [], countryCode);
        for (const f of filteredFallback) {
          if (f && f.id && !seenIds.has(f.id)) {
            seenIds.add(f.id);
            videos.push(f);
          }
        }
      }
      const headingQuery = searchMode === 'trending'
        ? (countryCode === 'BR' ? 'em alta' : 'trending')
        : (searchMode === 'live'
          ? (countryCode === 'BR' ? 'ao vivo' : 'live')
          : (searchMode === 'podcast'
            ? 'podcasts'
            : (isNewsYoutubeCategory(qParam || 'noticias') && !isCustomQuery ? (countryCode === 'BR' ? 'noticias emissoras' : 'news') : dynamicQuery)));

      let returnIp = clientIp;
      if (useTor) {
        const torExit = await lookupOutboundIp(true).catch(() => null);
        if (torExit && torExit.IP) returnIp = torExit.IP;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(JSON.stringify({
        success: true,
        countryCode,
        countryName: COUNTRY_NAMES[countryCode] || countryCode,
        countryFlag: COUNTRY_FLAGS[countryCode] || '🌍',
        clientIp: returnIp,
        query: headingQuery,
        videos: videos.slice(0, 30)
      }));
      return;
    }

    if (pathname === '/api/tor-status') {
      const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
      const clientSession = getOrCreateClientSession(clientId);
      const status = await torManager.checkTorStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...status,
        enabled: Boolean(clientSession.torEnabled),
        connected: Boolean(clientSession.torEnabled && status.connected),
        serverConnected: Boolean(status.connected),
        locked: false
      }));
      return;
    }

    if (pathname === '/api/papaleguas/toggle-tor' && req.method === 'POST') {
      const requested = body && typeof body.enabled === 'boolean' ? body.enabled : !isAppTorEnabled();
      applyServerTorRouting(requested);
      let status = { connected: false };
      if (requested && typeof torManager.ensureRunning === 'function') {
        status = await torManager.ensureRunning();
        if (status.connected) lookupOutboundIp(true).catch(() => {});
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        enabled: requested,
        connected: Boolean(requested && status.connected),
        message: requested
          ? 'Conectado à rede Tor.'
          : 'Tor desligado. A saída está na internet direta, sem proxy.'
      }));
      return;
    }

    if (pathname === '/api/toggle-tor') {
      const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || (body && body.clientId) || 'client_default';
      const clientSession = getOrCreateClientSession(clientId);
      const requested = body && body.enabled !== undefined ? Boolean(body.enabled) : !clientSession.torEnabled;
      clientSession.torEnabled = requested;

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
        const torOn = isTorRoutingEnabled(clientSession);
        const reported = String(reqUrl.searchParams.get('deviceIpv4') || body.deviceIpv4 || '').trim();
        const fromClient = papaleguasTracker.extractClientIp(req);
        const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
        let clientIp = '';
        if (ipv4.test(reported) && !papaleguasTracker.isPrivateIp(reported)) clientIp = reported;
        else if (ipv4.test(fromClient) && !papaleguasTracker.isPrivateIp(fromClient)) clientIp = fromClient;
        else if (fromClient && !papaleguasTracker.isPrivateIp(fromClient)) clientIp = fromClient;
        let torIp = '';
        if (torOn) {
          const exit = await lookupOutboundIp(true);
          if (exit && exit.IP && exit.viaTor) torIp = exit.IP;
        }
        const effectiveIp = (torOn && torIp) ? torIp : (clientIp || '');
        res.writeHead(200);
        res.end(JSON.stringify({
          IP: effectiveIp,
          clientIpv4: clientIp || effectiveIp,
          IsTor: Boolean(torOn && torIp),
          torOn: Boolean(torOn),
          torIp: torIp || effectiveIp,
          viaClient: true
        }));
      } catch (err) {
        res.writeHead(200);
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
          } catch (e) {}
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
        try { res.destroy(); } catch (e) {}
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
    function fetchUrlViaProxy(targetUrlObj, redirectCount = 0) {
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
      const forwardedCookie = cookieHeaderForProxy(clientId, targetUrlObj.hostname, req.headers.cookie);
      const proxyHeaders = {
        'User-Agent': isMobileReq 
          ? 'Mozilla/5.0 (Linux; Android 14; Mobile; rv:130.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip',
        'Accept-Language': req.headers['accept-language'] || 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Host': targetUrlObj.host,
        'Referer': targetUrlObj.origin
      };
      if (forwardedCookie) proxyHeaders.Cookie = forwardedCookie;
      if (req.headers['content-type']) proxyHeaders['Content-Type'] = req.headers['content-type'];
      if (req.headers['x-requested-with']) proxyHeaders['X-Requested-With'] = req.headers['x-requested-with'];

      const isOnion = targetUrlObj.hostname.endsWith('.onion');
      const isDownloadOrMedia = isDownloadOrMediaUrl(targetUrlObj);
      const torWanted = Boolean(isTorRoutingEnabled(clientSession) || isAppTorEnabled());
      // Downloads, vídeos, áudios e YouTube NUNCA passam pelo proxy Tor: saem direto na velocidade máxima
      const useTor = isOnion ? true : (isDownloadOrMedia ? false : torWanted);
      const requestAgent = getOutboundAgent(useTor);

      const proxyReq = clientProtocol.request(targetUrlObj, {
        method: req.method,
        headers: proxyHeaders,
        agent: requestAgent,
        // Conexão direta/downloads usam timeout maior (60s) para arquivos pesados
        timeout: useTor ? 30000 : 60000
      }, (proxyRes) => {
        // Segue redirects no servidor (NUNCA devolve 302 ao navegador para evitar que o Firefox trave com "impediu redirecionamentos")
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
          proxyRes.resume();
          if (redirectCount < 6) {
            let nextUrl = proxyRes.headers.location;
            try {
              nextUrl = new URL(nextUrl, targetUrlObj.href);
              fetchUrlViaProxy(nextUrl, redirectCount + 1);
              return;
            } catch (e) {}
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
        const existingCookies = responseHeaders['set-cookie']
          ? (Array.isArray(responseHeaders['set-cookie']) ? responseHeaders['set-cookie'] : [responseHeaders['set-cookie']])
          : [];
        existingCookies.push('pl_proxy_target=' + encodeProxyOriginB64(targetUrlObj.origin) + '; Path=/; SameSite=Lax; Max-Age=1800');
        responseHeaders['set-cookie'] = existingCookies;

        const contentType = responseHeaders['content-type'] || '';

        if (contentType.includes('text/html')) {
          let chunks = [];
          proxyRes.on('data', chunk => chunks.push(chunk));
          proxyRes.on('end', () => {
            let html = decodeMaybeGzip(Buffer.concat(chunks), proxyRes.headers['content-encoding']);

            html = rewriteMetaRefresh(html, clientId, targetUrlObj.href);

            const injectedScript = buildProxyLeakShield(clientId, targetUrlObj.href, targetUrlObj.origin) + `
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
                    var sendSync = function() {
                      postToApp({ type: 'navigate-sync', url: "${targetUrlObj.href}", targetUrl: "${targetUrlObj.href}", title: document.title || "${targetUrlObj.hostname}" });
                    };
                    sendSync();
                    window.addEventListener('DOMContentLoaded', sendSync);
                    window.addEventListener('load', sendSync);
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
                          return "${targetUrlObj.href}";
                        }
                        // Dentro do template literal, "\\/" e "\\b" precisam do escape duplo,
                        // senão o script injetado chega ao navegador com erro de sintaxe.
                        if (!/^\\/(search|youtube|filmes|musica|baixatube|api)\\b/.test(u.pathname)) {
                          return "${targetUrlObj.origin}" + u.pathname + u.search + u.hash;
                        }
                      }
                      return u.href;
                    } catch (err) {
                      return href;
                    }
                  }

                  document.addEventListener('click', function(e) {
                    if (e.defaultPrevented) return;
                    var a = e.target && e.target.closest ? e.target.closest('a') : null;
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
                    var actionHref = form.getAttribute('action') || "${targetUrlObj.href}";
                    var real = realTargetFromHref(form.action || actionHref);
                    try {
                      var t = new URL(real, "${targetUrlObj.href}");
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
                      var u = new URL(String(raw || ''), "${targetUrlObj.href}");
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
                      var pageUrl = "${targetUrlObj.href}";
                      var found = null;
                      var fromPage = ytId(pageUrl);
                      if (fromPage) {
                        found = { type: 'youtube', youtubeId: fromPage, url: 'https://www.youtube.com/watch?v=' + fromPage, title: document.title || 'Vídeo', width: 1280, duration: 0 };
                      }
                      if (!found) {
                        var frame = document.querySelector('iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]');
                        var frameId = frame ? ytId(frame.src) : '';
                        if (frameId) found = { type: 'youtube', youtubeId: frameId, url: 'https://www.youtube.com/watch?v=' + frameId, title: document.title || 'Vídeo', width: 1280, duration: 0 };
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
                            found = { type: mediaUrl ? 'html5' : 'page', youtubeId: '', url: pageUrl, mediaUrl: mediaUrl, title: document.title || 'Vídeo na página', width: width, duration: duration };
                          }
                        }
                      }
                      var key = found ? (found.youtubeId || found.mediaUrl || found.url) : '';
                      if (!found || !key || key === lastVideoKey) return;
                      lastVideoKey = key;
                      var app = appWindow();
                      if (app) {
                        try { app.postMessage({ type: 'media-video-detected', video: found }, '*'); } catch (e) {}
                      }
                    } catch (e) {}
                  }
                  setInterval(function() { if (!document.hidden) reportPageVideo(); }, 1800);
                  window.addEventListener('message', function(ev) {
                    if (!ev.data || ev.data.type !== 'papaleguas-pause-media') return;
                    Array.prototype.forEach.call(document.querySelectorAll('video,audio'), function(media) {
                      try { media.pause(); } catch (e) {}
                    });
                  });
                })();
              </script>
            `;
            if (/<head[^>]*>/i.test(html)) {
              html = html.replace(/<head[^>]*>/i, `$&${injectedScript}`);
            } else {
              html = injectedScript + html;
            }
            html = rewriteProxiedHtml(html, clientId, targetUrlObj.origin);

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
          try { res.destroy(); } catch (e) {}
          return;
        }
        try {
          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
          <div style="font-family: 'Outfit', sans-serif, system-ui; background: #0c0e14; color: #fff; padding: 40px 20px; text-align: center; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;">
            <h2 style="color: #38bdf8; margin-bottom: 12px; font-size: 22px;">Acessar no Papaléguas</h2>
            <p style="color: #94a3b8; max-width: 480px; font-size: 14px; margin-bottom: 24px;">${useTor ? 'Não foi possível carregar pela rede Tor no momento. Tente recarregar ou verificar sua conexão.' : 'Não foi possível carregar a página de destino no momento. Tente novamente dentro do Papaléguas.'}</p>
            <a href="/proxy?url=${encodeURIComponent(targetUrlObj.href)}" style="background: #00f0ff; color: #000; font-weight: 700; text-decoration: none; padding: 12px 24px; border-radius: 20px; box-shadow: 0 0 15px rgba(0,240,255,0.4);">Tentar de novo</a>
          </div>
        `);
        } catch (e) {
          try { res.destroy(); } catch (e2) {}
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
    const q = reqUrl.searchParams.get('q') || '';
    const useTor = isTorRoutingEnabled(clientSession) || isAppTorEnabled();
    let results = [];
    let onionItems = [];
    let newsItems = [];
    let relatedTerms = [];
    try {
      const rich = q ? await getRichSearchData(q, useTor) : null;
      if (rich) {
        results = rich.results || [];
        onionItems = rich.onion || [];
        newsItems = rich.news || [];
        relatedTerms = rich.related || [];
      }
    } catch (err) {
      console.warn('[SEARCH PAGE] falhou:', err && err.message ? err.message : err);
      results = [];
    }
    const safeQ = (q || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const escapeHtml = (value) => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const newsHtml = (newsItems && newsItems.length) ? `
      <section class="news-block">
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

    const onionHtml = '';

    const relatedHtml = (relatedTerms && relatedTerms.length) ? `
      <section class="related-block">
        <h3 class="block-title">Pesquisas relacionadas</h3>
        <div class="related-list">
          ${relatedTerms.map((term) => `
            <a class="related-chip" href="/search?q=${encodeURIComponent(term)}&clientId=${encodeURIComponent(clientId)}">${escapeHtml(term)}</a>
          `).join('')}
        </div>
      </section>
    ` : '';
    
    let resultsHtml = '';
    if (!q) {
      resultsHtml = `
        <div style="text-align: center; padding: 50px 20px 30px; max-width: 650px; margin: 0 auto;">
          <div style="width: 68px; height: 68px; border-radius: 22px; background: rgba(0, 240, 255, 0.1); border: 1px solid rgba(0, 240, 255, 0.3); display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 32px; box-shadow: 0 0 30px rgba(0, 240, 255, 0.25);">
            🔍
          </div>
          <h2 style="font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 12px; letter-spacing: -0.3px;">Pesquisa Web Papaléguas</h2>
          <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 28px;">
            Busca inteligente que combina resultados públicos e prioriza os mais relacionados ao que você digitou.
          </p>
          <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;">
            <a href="/proxy?url=https%3A%2F%2Fwww.google.com&clientId=${encodeURIComponent(clientId)}" data-direct="https://www.google.com" style="display: inline-flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); color: #fff; text-decoration: none; padding: 11px 22px; border-radius: 24px; font-size: 13.5px; font-weight: 600; transition: all 0.2s;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>
              Google Oficial
            </a>
            <a href="/proxy?url=https%3A%2F%2Fduckduckgo.com&clientId=${encodeURIComponent(clientId)}" data-direct="https://duckduckgo.com" style="display: inline-flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); color: #fff; text-decoration: none; padding: 11px 22px; border-radius: 24px; font-size: 13.5px; font-weight: 600; transition: all 0.2s;">
              DuckDuckGo Oficial
            </a>
          </div>
        </div>
      `;
    } else if (results.length === 0) {
      resultsHtml = `
        <div style="text-align: center; padding: 40px 20px; color: #94a3b8;">
          <p style="font-size: 16px;">Nenhum resultado direto encontrado para "<b>${safeQ}</b>".</p>
          <p style="font-size: 14px; margin-top: 10px;">Experimente pesquisar com outros termos ou <a href="/proxy?url=${encodeURIComponent('https://www.google.com/search?q=' + encodeURIComponent(q))}&clientId=${encodeURIComponent(clientId)}" style="color: #00f0ff; text-decoration: none; font-weight: bold;">buscar no Google</a>.</p>
        </div>
      `;
    } else {
      resultsHtml = results.map(r => {
        const safeTitle = escapeHtml(r.title);
        const safeSnippet = escapeHtml(r.snippet);
        const safeUrl = escapeHtml(r.url);
        const hostLabel = safeHostname(r.url) || safeUrl;
        const letter = String(hostLabel || '?').charAt(0).toUpperCase();
        const dateLabel = r.date ? formatSearchDate(r.date) : '';
        return `
        <a class="url-suggest-row" href="/proxy?url=${encodeURIComponent(r.url)}&clientId=${encodeURIComponent(clientId)}" data-direct="${safeUrl}" data-url="${safeUrl}">
          <span class="url-suggest-fav">${letter}</span>
          <span class="url-suggest-meta">
            <span class="url-suggest-title">${safeTitle}</span>
            <span class="url-suggest-url">${escapeHtml(hostLabel)}${dateLabel ? ` <span class="url-suggest-date">· ${escapeHtml(dateLabel)}</span>` : ''}</span>
            ${safeSnippet ? `<span class="url-suggest-snip">${safeSnippet}</span>` : ''}
          </span>
          <span class="url-suggest-ext" title="Acessar no Papaléguas">Acessar →</span>
        </a>
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
  <title>${safeQ ? safeQ + ' - DuckDuckGo Papaléguas' : 'Pesquisa DuckDuckGo'}</title>
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
    .url-suggest-row.is-opening {
      opacity: 0.72;
      pointer-events: none;
      background: rgba(245, 158, 11, 0.08);
    }
    body.via-tor .url-suggest-row.is-opening .url-suggest-url::after {
      content: ' · abrindo via Tor…';
      color: #fbbf24;
      font-weight: 700;
    }
    body:not(.via-tor) .url-suggest-row.is-opening {
      background: rgba(56, 189, 248, 0.08);
    }
    body:not(.via-tor) .url-suggest-row.is-opening .url-suggest-url::after {
      content: ' · conexão direta…';
      color: #7dd3fc;
      font-weight: 700;
    }
    .tor-nav-loading {
      position: fixed;
      inset: 0;
      z-index: 400;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(6, 8, 14, 0.78);
      backdrop-filter: blur(8px);
    }
    .tor-nav-loading[hidden] { display: none !important; }
    .tor-nav-card {
      width: min(400px, calc(100% - 32px));
      padding: 26px 22px;
      border-radius: 18px;
      text-align: center;
      background: #10141e;
      border: 1px solid rgba(245, 158, 11, 0.28);
      box-shadow: 0 18px 46px rgba(0,0,0,.45);
    }
    body:not(.via-tor) .tor-nav-card {
      border-color: rgba(56,189,248,.32);
      background: linear-gradient(180deg, #0f172a 0%, #10141e 100%);
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
    .ai-answer { font-size: 15px; line-height: 1.65; color: #e2e8f0; }
    .ai-answer p { margin: 0 0 9px; }
    .ai-answer p:last-child { margin-bottom: 0; }
    .ai-answer ul { margin: 0 0 9px; padding-left: 19px; }
    .ai-answer li { margin-bottom: 5px; }
    .ai-answer strong { color: #f8fafc; font-weight: 700; }
    .ai-cite {
      display: inline-block;
      min-width: 17px;
      margin: 0 1px;
      padding: 0 4px;
      border-radius: 5px;
      background: rgba(0, 240, 255, 0.14);
      border: 1px solid rgba(0, 240, 255, 0.28);
      color: #67e8f9;
      font-size: 10.5px;
      font-weight: 800;
      line-height: 15px;
      text-align: center;
      text-decoration: none;
      vertical-align: 2px;
      cursor: pointer;
    }
    .ai-cite:hover { background: rgba(0, 240, 255, 0.3); color: #0f172a; }
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
  </style>
</head>
<body class="${useTor ? 'via-tor' : ''}">
  <div class="tor-nav-loading" id="torNavLoading" hidden>
    <div class="tor-nav-card">
      <div class="tor-nav-spin"></div>
      <div class="direct-nav-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="tor-nav-title" id="torNavTitle">${useTor ? 'Carregando via Tor' : 'Abrindo em conexão direta'}</div>
      <div class="tor-nav-url" id="torNavUrl"></div>
      <div class="tor-nav-hint" id="torNavHint">${useTor ? 'A conexão está saindo pela rede Tor. Pode demorar alguns segundos.' : 'Tor desligado. A página está abrindo pela internet normal.'}</div>
    </div>
  </div>
  <header class="ddg-header">
    <a href="newtab.html" class="ddg-brand" title="Início">
      <span>🦆</span>
      <span>DuckDuckGo</span>
      <span class="ddg-brand-badge">Tor</span>
    </a>
    <form class="ddg-form" action="/search" method="GET">
      <input type="hidden" name="clientId" value="${clientId}">
      <input type="text" name="q" id="searchInput" class="ddg-input" value="${safeQ}" placeholder="Pesquise no buscador inteligente..." autofocus autocomplete="off" />
      <button type="submit" class="ddg-btn" title="Buscar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
    </form>
    <div style="display:flex;gap:8px;align-items:center;">
      <a href="https://www.google.com${safeQ ? '/search?q=' + encodeURIComponent(q) : ''}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#cbd5e1;text-decoration:none;padding:6px 12px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap;transition:all 0.2s;" title="Abrir busca no Google diretamente fora do frame">
        <span>Google ↗</span>
      </a>
      <a href="https://duckduckgo.com/${safeQ ? '?q=' + encodeURIComponent(q) : ''}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#cbd5e1;text-decoration:none;padding:6px 12px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap;transition:all 0.2s;" title="Abrir busca no DuckDuckGo diretamente fora do frame">
        <span>DuckDuckGo ↗</span>
      </a>
    </div>
  </header>

  <main class="ddg-container">
    ${q ? `
    <section class="ai-card" id="aiCard">
      <div class="ai-head">
        <span class="ai-badge"><span class="ai-spark">✦</span> Resposta da IA</span>
        <span class="ai-state" id="aiState">Lendo os resultados…</span>
      </div>
      <div class="ai-answer" id="aiAnswer"><div class="ai-skeleton"><i></i><i></i><i></i></div></div>
      <div class="ai-sources" id="aiSources"></div>
      <div class="ai-thread" id="aiThread"></div>
      <form class="ai-ask" id="aiAsk" hidden autocomplete="off">
        <input class="ai-ask-input" id="aiAskInput" placeholder="Pergunte mais e a IA pesquisa de novo…" autocomplete="off" spellcheck="false">
        <button class="ai-ask-go" id="aiAskGo" type="submit">Perguntar</button>
      </form>
    </section>
    ` : ''}
    <!-- RESULTADOS DO BUSCADOR INTELIGENTE -->
    <div id="agentPicks" hidden></div>
    ${q && results.length ? '<h3 class="block-title">Resultados da web</h3>' : ''}
    <div id="resultsList">
      ${resultsHtml}
    </div>
    <div class="url-suggest-more" id="resultsMore" style="${q && results.length ? '' : 'display:none;'}">
      <button type="button" class="suggest-refresh-btn" id="resultsRefresh">Atualizar sugestões</button>
    </div>
    <!-- As notícias vêm depois: quase toda busca é por explicação, não por manchete -->
    ${newsHtml}
    ${relatedHtml}
  </main>

  <script>
    const currentQuery = ${JSON.stringify(q)};
    const pageUsesTor = ${useTor ? 'true' : 'false'};

    function showLocalTorLoading(kind, url) {
      const box = document.getElementById('torNavLoading');
      const title = document.getElementById('torNavTitle');
      const urlEl = document.getElementById('torNavUrl');
      const hint = document.getElementById('torNavHint');
      const isSearch = kind === 'search';
      if (title) title.textContent = pageUsesTor
        ? (isSearch ? 'Pesquisando via Tor' : 'Abrindo via Tor')
        : (isSearch ? 'Pesquisando em conexão direta' : 'Abrindo em conexão direta');
      if (urlEl) urlEl.textContent = url || '';
      if (hint) hint.textContent = pageUsesTor
        ? 'A conexão está saindo pela rede Tor. Pode demorar alguns segundos.'
        : 'Tor desligado. A página está abrindo pela internet normal.';
      if (box) {
        box.hidden = false;
        if (window.__torLoadingTimer) clearTimeout(window.__torLoadingTimer);
        // O loading permanece ativo continuamente até a página ser aberta por completo.
        window.__torLoadingTimer = setTimeout(function() {
          if (box) box.hidden = true;
          document.querySelectorAll('.url-suggest-row.is-opening').forEach(function (n) { n.classList.remove('is-opening'); });
        }, 120000);
      }
      try {
        window.parent.postMessage({ type: 'page-loading', kind: kind || 'link', url: url || '' }, '*');
      } catch (e) {}
    }

    window.addEventListener('message', function (event) {
      const data = event.data;
      if (!data || data.type !== 'papaleguas-hide-loading') return;
      if (window.__torLoadingTimer) {
        clearTimeout(window.__torLoadingTimer);
        window.__torLoadingTimer = null;
      }
      const box = document.getElementById('torNavLoading');
      if (box) box.hidden = true;
      document.querySelectorAll('.url-suggest-row.is-opening').forEach(function (n) { n.classList.remove('is-opening'); });
    });

    function markRowLoading(el) {
      document.querySelectorAll('.url-suggest-row.is-opening').forEach((n) => n.classList.remove('is-opening'));
      if (el && el.classList) el.classList.add('is-opening');
    }

    function navigateDirect(url, rowEl) {
      if (!url) return;
      markRowLoading(rowEl);
      showLocalTorLoading('link', url);

      let targetUrl = url;
      if (!/^https?:\\/\\//i.test(targetUrl) && !targetUrl.startsWith('/')) {
        targetUrl = 'https://' + targetUrl;
      }

      const inside = targetUrl.startsWith('/proxy') ? targetUrl : ('/proxy?url=' + encodeURIComponent(targetUrl) + '&clientId=' + encodeURIComponent(suggestClientId));

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

    let suggestPage = 0;
    let suggestLoading = false;
    let suggestHasMore = ${q && results.length ? 'true' : 'false'};
    const suggestClientId = ${JSON.stringify(clientId)};

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
      const html = aiEscape(text).replace(/[*][*]([^*]+)[*][*]/g, '<strong>$1</strong>');
      return html.replace(/\\[([0-9]+(?:[ ]*,[ ]*[0-9]+)*)\\]/g, function (match, group) {
        const links = group.split(',').map(function (raw) {
          const num = parseInt(raw, 10);
          const src = sources[num - 1];
          if (!src) return '';
          return '<a class="ai-cite" href="#" data-ai-src="' + num + '" title="' +
            aiEscape(src.title + ' · ' + src.host) + '">' + num + '</a>';
        }).join('');
        return links || match;
      });
    }

    function aiRenderAnswer(container, text, sources) {
      const blocks = [];
      let list = null;
      String(text || '').split(/\\r?\\n/).forEach(function (rawLine) {
        const line = rawLine.trim();
        if (!line) { list = null; return; }
        const bullet = line.match(/^(?:[-*•]|[0-9]+[.)])[ ]+(.*)$/);
        if (bullet) {
          if (!list) { list = document.createElement('ul'); blocks.push(list); }
          const li = document.createElement('li');
          li.innerHTML = aiInline(bullet[1], sources);
          list.appendChild(li);
          return;
        }
        list = null;
        const p = document.createElement('p');
        p.innerHTML = aiInline(line, sources);
        blocks.push(p);
      });
      container.innerHTML = '';
      blocks.forEach(function (node) { container.appendChild(node); });
      container.querySelectorAll('.ai-cite').forEach(function (cite) {
        cite.addEventListener('click', function (e) {
          e.preventDefault();
          const src = sources[parseInt(cite.getAttribute('data-ai-src'), 10) - 1];
          if (src) navigateDirect(src.url, null);
        });
      });
    }

    function aiRenderSources(container, sources) {
      container.innerHTML = '';
        sources.forEach(function (src, index) {
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

    function aiSourcesLabel(count) {
      if (!count) return '';
      return count === 1 ? 'resumo de 1 fonte' : 'resumo de ' + count + ' fontes';
    }

    if (aiCard && currentQuery) {
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

    function appendSuggestRows(items) {
      const list = document.getElementById('resultsList');
      if (!list || !items) return;
      items.forEach((item) => {
        if (!item || item.kind === 'search' || !item.url || !/^https?:/i.test(item.url)) return;
        if (list.querySelector('[data-url="' + CSS.escape(item.url) + '"]')) return;
        const host = item.subtitle || item.url;
        const letter = String(host || '?').charAt(0).toUpperCase();
        const a = document.createElement('a');
        a.className = 'url-suggest-row';
        a.href = '/proxy?url=' + encodeURIComponent(item.url) + '&clientId=' + encodeURIComponent(suggestClientId);
        a.setAttribute('data-direct', item.url);
        a.setAttribute('data-url', item.url);
        a.innerHTML = '<span class="url-suggest-fav"></span><span class="url-suggest-meta"><span class="url-suggest-title"></span><span class="url-suggest-url"></span></span><span class="url-suggest-ext" title="Acessar no Papaléguas">Acessar →</span>';
        a.querySelector('.url-suggest-fav').textContent = letter;
        a.querySelector('.url-suggest-title').textContent = item.title || host;
        a.querySelector('.url-suggest-url').textContent = host;
        a.addEventListener('click', (e) => { e.preventDefault(); navigateDirect(item.url, a); });
        list.appendChild(a);
      });
    }

    function setRefreshLabel() {
      const btn = document.getElementById('resultsRefresh');
      if (!btn) return;
      btn.disabled = suggestLoading || !suggestHasMore;
      btn.textContent = suggestLoading
        ? 'Buscando novas sugestões…'
        : (suggestHasMore ? 'Atualizar sugestões' : 'Sugestões atualizadas');
    }

    async function loadMoreSuggestions() {
      if (suggestLoading || !suggestHasMore || !currentQuery) {
        setRefreshLabel();
        return;
      }
      suggestLoading = true;
      setRefreshLabel();
      let hops = 0;
      try {
        while (suggestHasMore && hops < 10) {
          hops += 1;
          const before = document.querySelectorAll('#resultsList .url-suggest-row').length;
          const res = await fetch('/api/url-suggest?q=' + encodeURIComponent(currentQuery) + '&page=' + suggestPage + '&clientId=' + encodeURIComponent(suggestClientId));
          const data = await res.json();
          appendSuggestRows(data && data.suggestions);
          suggestHasMore = !!(data && data.hasMore);
          suggestPage += 1;
          const after = document.querySelectorAll('#resultsList .url-suggest-row').length;
          if (after > before) break;
        }
      } catch (e) {
        suggestHasMore = false;
      }
      suggestLoading = false;
      setRefreshLabel();
    }

    const resultsRefresh = document.getElementById('resultsRefresh');
    if (resultsRefresh) resultsRefresh.addEventListener('click', function () { loadMoreSuggestions(); });

    window.addEventListener('scroll', () => {
      if ((window.innerHeight + window.scrollY) >= (document.body.offsetHeight - 240)) {
        loadMoreSuggestions();
      }
    }, { passive: true });

    document.addEventListener('DOMContentLoaded', () => {
      // Notifica o app pai da URL atual
      try {
        window.parent.postMessage({ type: 'navigate-sync', url: window.location.href, title: document.title }, '*');
      } catch(e){}
      // Intercepta links de resultados para sincronizar navegação
      document.querySelectorAll('.ddg-title a, .ddg-result-card, .url-suggest-row, .news-item').forEach(el => {
        el.addEventListener('click', (e) => {
          const a = el.tagName === 'A' ? el : el.querySelector('a');
          if (!a) return;
          const directUrl = a.getAttribute('data-direct') || a.href;
          e.preventDefault();
          navigateDirect(directUrl, el);
        });
      });
      // Delegação de cliques para links criados dinamicamente (incluindo serviços .onion e botões adicionados após o fetch)
      document.addEventListener('click', (e) => {
        const item = e.target.closest('.onion-item, .onion-direct-search-btn');
        if (item) {
          e.preventDefault();
          const directUrl = item.getAttribute('data-direct') || item.href;
          navigateDirect(directUrl, item);
          return;
        }
      });

      const searchForm = document.querySelector('.ddg-form');
      if (searchForm) {
        searchForm.addEventListener('submit', (e) => {
          const qVal = (document.getElementById('searchInput') || {}).value || currentQuery || '';
          const trimmed = qVal.trim();
          if (/^https?:\\/\\//i.test(trimmed) || (trimmed.includes('.') && !trimmed.includes(' ') && !trimmed.startsWith('/'))) {
            let directUrl = trimmed;
            if (!/^https?:\\/\\//i.test(directUrl)) directUrl = 'https://' + directUrl;
            e.preventDefault();
            navigateDirect(directUrl, null);
            return;
          }
          showLocalTorLoading('search', qVal);
        });
      }

      document.querySelectorAll('a[href*="/proxy"], a[href*="/search"]').forEach((a) => {
        if (a.classList.contains('url-suggest-row') || a.classList.contains('onion-item') || a.closest('.ddg-result-card')) return;
        a.addEventListener('click', () => {
          const dest = a.getAttribute('data-direct') || a.href;
          const kind = (a.getAttribute('href') || '').includes('/search') ? 'search' : 'link';
          showLocalTorLoading(kind, dest);
        });
      });

    });
  </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
    return;
  }

  // YouTube e BaixaTube:
  // Se a requisição vem de dentro de um iframe ou tem query ?embedded=1, serve newtab.html.
  // Se for acesso direto pela barra de endereço do celular/PC (document request), serve index.html
  // para carregar o shell completo com a barra de navegação e menus responsivos.
  if (pathname === '/youtube' || pathname === '/youtube/' || pathname === '/baixatube' || pathname === '/baixatube/') {
    const targetFile = path.join(SRC_DIR, 'newtab.html');
    if (fs.existsSync(targetFile)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(fs.readFileSync(targetFile, 'utf8'));
      return;
    }
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
  // Assista aos melhores filmes dublados completos sem travar
  // com suporte a transmissão direta na Smart TV / Roku TV
  // ----------------------------------------------------
  if (pathname === '/filmes' || pathname === '/filmes/') {
    const isLocal = isLocalRequest(req);
    const q = reqUrl.searchParams.get('q') || '';
    let selectedVid = reqUrl.searchParams.get('v') || '';
    let selectedCategory = reqUrl.searchParams.get('cat') || '';
    const hostHeader = req.headers.host || 'localhost:8080';
    const isHttps = Boolean(req.headers['x-forwarded-proto'] === 'https' || hostHeader.includes('trycloudflare.com') || hostHeader.includes('ngrok-free.app'));
    const requestOrigin = `${isHttps ? 'https' : 'http'}://${hostHeader}`;
    const encodedOrigin = encodeURIComponent(requestOrigin);


    // Categorias de Filmes para Navegação Rápida no Celular
    const movieCategories = [
      { id: 'todos', label: '🎬 Todos', q: 'filmes completos dublados' },
      { id: 'acao', label: '💥 Ação', q: 'filmes de acao completos dublados hd' },
      { id: 'comedia', label: '😂 Comédia', q: 'filmes de comedia completos dublados' },
      { id: 'terror', label: '👻 Terror', q: 'filmes de terror completos dublados' },
      { id: 'suspense', label: '🔍 Suspense', q: 'filmes de suspense dublados completos' },
      { id: 'ficcao', label: '🚀 Ficção', q: 'filmes de ficcao cientifica dublados' },
      { id: 'aventura', label: '🏹 Aventura', q: 'filmes de aventura completos dublados' },
      { id: 'animacao', label: '🦁 Animação', q: 'desenhos e animacoes filmes completos dublados' },
      { id: 'luta', label: '🥋 Luta & Artes Marciais', q: 'filmes de luta e artes marciais completos dublados' }
    ];

    // Busca filmes dublados completos reais no acervo
    const activeCatObj = movieCategories.find(c => c.id === selectedCategory);
    const catId = activeCatObj ? activeCatObj.id : 'todos';
    const searchQuery = (q || '').trim();
    const useTor = false;
    const isRefresh = !!reqUrl.searchParams.get('r');
    if (isRefresh) {
      youtubeSearchCache.clear();
    }
    const shuffleArr = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };
    let movieResults = [];

    // Filmes curados da categoria para contingência instantânea
    const categoryCurated = CURATED_OFFICIAL_MOVIES.filter(m => catId === 'todos' || m.category === catId || (catId === 'acao' && (m.category === 'acao' || m.category === 'luta')));
    const fallbackList = categoryCurated.length > 0 ? categoryCurated : CURATED_OFFICIAL_MOVIES;

    // Busca dinâmica aleatória: a cada requisição é gerada uma consulta diferente do acervo
    // para nunca exibir os mesmos filmes estáticos na home
    const dynamicSearchObj = getDynamicRecentMovieQuery(catId);
    const queryToSearch = searchQuery || dynamicSearchObj.query;
    const dynamicTimeFilter = dynamicSearchObj.timeFilter || 'month';
    const dynamicSortRecent = dynamicSearchObj.sortByRecent;

    // Timeout seguro de 4.2 segundos para garantir o retorno de novos filmes reais do YouTube
    const searchPromise = (async () => {
      try {
        let results = await searchYoutubeVideos(queryToSearch, 'pt-BR', dynamicSortRecent, dynamicTimeFilter, useTor);
        if (!results || results.length < 4) {
          const secondarySearchObj = getDynamicRecentMovieQuery(catId);
          const secondaryResults = await searchYoutubeVideos(secondarySearchObj.query, 'pt-BR', false, 'year', useTor);
          if (secondaryResults && secondaryResults.length > 0) {
            results = (results || []).concat(secondaryResults);
          }
        }
        return results || [];
      } catch (err) {
        return [];
      }
    })();

    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 4200));
    try {
      movieResults = await Promise.race([searchPromise, timeoutPromise]);
    } catch(e) {
      movieResults = [];
    }

    // Prioriza filmes de longa duração (mais de 30min) sobre trailers ou clipes curtos
    const fullMovies = movieResults.filter(m => {
      const dur = m.duration || '';
      return dur.split(':').length >= 3 || (dur.split(':').length === 2 && parseInt(dur.split(':')[0], 10) >= 30);
    });
    if (fullMovies.length >= 2) {
      movieResults = fullMovies;
    }

    // Embaralha SEMPRE a cada requisição para garantir catálogo vivo e rotativo
    shuffleArr(movieResults);
    const shuffledFallback = shuffleArr(fallbackList.slice());
    const seenIds = new Set(movieResults.map(m => m.id));
    for (const cur of shuffledFallback) {
      if (!seenIds.has(cur.id)) {
        movieResults.push(cur);
        seenIds.add(cur.id);
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

    const activeMovie = movieResults.find(m => m.id === selectedVid) || CURATED_OFFICIAL_MOVIES[0];
    const activeMovieTitle = activeMovie ? activeMovie.title : 'Filmes Online Dublados';
    const safeActiveTitle = (activeMovieTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeQ = q.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const filmesHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5788322050130808"
     crossorigin="anonymous"></script>
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#0b0d14">
  <title>Filmes Online - Cinema Papaléguas</title>
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
      display: inline-flex;
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
    <a href="/filmes" class="cinema-brand">
      <div class="cinema-logo-box">
        <img src="/icon-192.png?v=4" alt="Papaléguas" style="width:32px;height:32px;border-radius:50%;object-fit:cover;box-shadow:0 0 10px rgba(245,158,11,0.5);" />
      </div>
      <div class="cinema-title">Filmes Online</div>
    </a>
  </header>

  <!-- Categorias em Pílulas para Celular -->
  <nav class="categories-bar">
    ${movieCategories.map(cat => `
      <a href="/filmes?cat=${cat.id}${q ? '&q=' + encodeURIComponent(q) : ''}" class="category-chip ${selectedCategory === cat.id ? 'active' : ''}">
        ${cat.label}
      </a>
    `).join('')}
  </nav>

  <!-- Barra de Busca Rápida de Filmes -->
  <div class="cinema-search-bar">
    <form class="cinema-form" id="cinema-form">
      <input type="text" class="cinema-input" id="cinema-query" placeholder="Buscar filmes dublados completos..." value="${safeQ}">
      <button type="submit" class="cinema-search-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        Buscar
      </button>
    </form>
    <a href="/filmes?cat=${encodeURIComponent(catId)}${q ? '&q=' + encodeURIComponent(q) : ''}&r=${Date.now()}" id="cinema-refresh-btn" title="Buscar novos filmes" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:9px 14px;border-radius:18px;background:linear-gradient(135deg,#f59e0b,#e11d48);color:#fff;font-size:13px;font-weight:700;text-decoration:none;box-shadow:0 3px 12px rgba(225,29,72,0.35);letter-spacing:0.2px;">
      🎲 Sortear Novos Filmes
    </a>
  </div>

  <!-- Player Principal -->
  <main class="cinema-player-section">
    <button type="button" class="cinema-mini-close" id="cinema-mini-close" title="Fechar o player">
      <span>Fechar</span>
      <span aria-hidden="true">✕</span>
    </button>
    <button type="button" class="cinema-minimize-btn" id="cinema-minimize-btn" onclick="minimizeCinemaVideo()" title="Minimizar tela (Restaurar catálogo)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
      </svg>
      <span>Minimizar</span>
    </button>
    <div class="cinema-player-wrapper" id="player-container">
      <iframe id="cinema-iframe" src="https://www.youtube.com/embed/${encodeURIComponent(selectedVid)}?autoplay=1&enablejsapi=1&playsinline=1&rel=0&origin=${encodedOrigin}&widget_referrer=${encodedOrigin}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="origin"></iframe>
    </div>

    <video id="cinema-pip-video" playsinline webkit-playsinline muted style="position:fixed;width:160px;height:90px;left:-200px;bottom:0;opacity:0.02;pointer-events:none;"></video>

    <div class="cinema-info-card">
      <div class="cinema-info-text" id="active-title">
        ▶ ${safeActiveTitle}
      </div>
      <div class="cinema-actions">
        <button class="cinema-cast-btn" id="btn-cinema-fs-toggle" type="button" onclick="toggleCinemaMaximize()" style="background:rgba(255,255,255,0.12);color:#fff;padding:6px 12px;font-size:11px;" title="Maximizar / Minimizar tela">
          <span id="cinema-fs-label">⛶ Maximizar</span>
        </button>
        <button class="cinema-cast-btn" id="btn-cinema-mini-toggle" type="button" onclick="enterCinemaMiniPlayer(false)" style="background:rgba(255,255,255,0.08);color:#fff;padding:6px 12px;font-size:11px;" title="Minimizar player para o canto da tela">
          🗕 Mini Player
        </button>
        <a id="cinema-direct-link" href="/youtube?v=${encodeURIComponent(selectedVid)}" class="cinema-cast-btn" style="background:rgba(255,255,255,0.08);color:#fff;text-decoration:none;padding:6px 12px;font-size:11px;" title="Assistir no Papaléguas" onclick="event.preventDefault(); var u=this.getAttribute('href'); try { if (window.openInNewTab) { window.openInNewTab(u); return; } } catch (e) {} try { if (window.parent && window.parent !== window) { window.parent.postMessage({ type: 'navigate-current-tab', url: u }, '*'); return; } } catch (e) {} location.href=u;">
          ▶ Assistir Direto
        </a>
        <button class="cinema-dl-btn cinema-dl-mp4" type="button" onclick="openCinemaResolutionModal()" title="Baixar Filme em Vídeo MP4" style="background:linear-gradient(135deg,#0284c7,#0369a1);border:none;color:#fff;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
          🎬 Baixar MP4
        </button>
        <button class="cinema-dl-btn cinema-dl-mp3" type="button" onclick="downloadActiveCinemaVideo('mp3')" title="Baixar Áudio / Trilha MP3" style="background:linear-gradient(135deg,#10b981,#059669);border:none;color:#fff;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
          🎵 Áudio MP3
        </button>
        <button class="cinema-cast-btn" id="btn-cast-quick" style="padding: 6px 12px; font-size: 11px;" title="Transmitir para Smart TV">
          📺 Transmitir
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
      🍿 Filmes Completos Dublados
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      <a href="/filmes?cat=${encodeURIComponent(catId)}${q ? '&q=' + encodeURIComponent(q) : ''}&r=${Date.now()}" style="display:inline-flex;align-items:center;gap:4px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.35);color:#fcd34d;font-size:11px;font-weight:700;padding:4px 10px;border-radius:14px;text-decoration:none;">
        🎲 Sortear
      </a>
      <div class="section-counter">${movieResults.length} filmes</div>
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
          <div class="movie-channel">${(m.channel || 'Cinema Dublado').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
          <div class="movie-card-actions">
            <button type="button" onclick="event.stopPropagation(); openCinemaResolutionModal('${m.id}', this)">🎬 MP4</button>
            <button type="button" class="movie-act-mp3" onclick="event.stopPropagation(); downloadActiveCinemaVideo('mp3', '${m.id}', this)">🎵 MP3</button>
            <button type="button" class="movie-act-cast" onclick="event.stopPropagation(); openCinemaCastForMovie('${m.id}', this)">📺 Transmitir</button>
          </div>
        </div>
      </article>
    `).join('')}
  </section>

  <div class="agent-scroll-loader" id="cinema-scroll-loader">
    <div class="agent-spinner"></div>
    <span>🍿 Buscando mais filmes dublados completos...</span>
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
            title: 'Filmes Online'
          }, '*');
        }
      } catch(e) {}

      const currentQ = ${JSON.stringify(searchQuery || q || '')};
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
        if (fsLabel) fsLabel.textContent = '⛶ Maximizar';

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
        if (fsLabel) fsLabel.textContent = '🗕 Minimizar';

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
            if (fsLabel) fsLabel.textContent = '🗕 Minimizar';
            resetCinemaMinDim();
            return;
          }
          if (cinemaFsArmed && !isCinemaFullscreen()) {
            cinemaFsArmed = false;
            document.documentElement.classList.remove('video-true-fs');
            const fsLabel = document.getElementById('cinema-fs-label');
            if (fsLabel) fsLabel.textContent = '⛶ Maximizar';
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
      window.addEventListener('message', function (event) {
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (data && data.type === 'papaleguas-yt-control' && data.action === 'enter-mini') {
            enterCinemaMiniPlayer(false);
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
          if (iframe) {
            iframe.referrerPolicy = 'origin';
            iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(id) + '?autoplay=1&enablejsapi=1&playsinline=1&rel=0&origin=' + encodeURIComponent(window.location.origin || 'http://localhost:8080') + '&widget_referrer=' + encodeURIComponent(window.location.origin || 'http://localhost:8080');
          }
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
          iframe.referrerPolicy = 'origin';
          iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(id) + '?autoplay=1&enablejsapi=1&playsinline=1&fs=1&rel=0&origin=' + encodeURIComponent(window.location.origin || 'http://localhost:8080') + '&widget_referrer=' + encodeURIComponent(window.location.origin || 'http://localhost:8080');
          if (titleEl) titleEl.textContent = '▶ ' + title;
          const directBtn = document.getElementById('cinema-direct-link');
          if (directBtn) directBtn.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(id);
          cinemaFsArmed = true;
          document.documentElement.classList.add('video-true-fs');
          document.body.classList.add('video-true-fs');
          const fsLabel = document.getElementById('cinema-fs-label');
          if (fsLabel) fsLabel.textContent = '🗕 Minimizar';
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
            window.history.replaceState({}, '', '/filmes');
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
              currentQuery: currentQ,
              currentTitle: currentPlayingTitle,
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
                  <div class="movie-channel">\${(m.channel || 'Cinema Dublado').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                  <div class="movie-card-actions">
                    <button type="button" onclick="event.stopPropagation(); openCinemaResolutionModal('\${m.id}', this)">🎬 MP4</button>
                    <button type="button" class="movie-act-mp3" onclick="event.stopPropagation(); downloadActiveCinemaVideo('mp3', '\${m.id}', this)">🎵 MP3</button>
                    <button type="button" class="movie-act-cast" onclick="event.stopPropagation(); openCinemaCastForMovie('\${m.id}', this)">📺 Transmitir</button>
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
          if (qVal) window.location.href = '/filmes?q=' + encodeURIComponent(qVal);
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
  <button type="button" class="back-top-btn" id="btn-back-top" title="Voltar ao topo">↑ Topo</button>
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
      } catch (e) {}
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
          try { res.destroy(); } catch (e) {}
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

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end('Erro ao carregar arquivo');
    } else {
      const isHtml = /[\\/]index\.html$/i.test(filePath) || isAppShellPathname(pathname);
      const isCoreScript = pathname.endsWith('.js') || pathname.endsWith('.css') || pathname.endsWith('.json') || pathname.endsWith('.html');
      const isStaticAsset = !isHtml && !pathname.endsWith('.txt') && !pathname.endsWith('.xml') && !isCoreScript;
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': isStaticAsset ? 'public, max-age=86400' : 'no-cache, no-store, must-revalidate',
        'Vary': 'Accept-Encoding'
      };
      if (isHtml) {
        headers['X-Frame-Options'] = 'DENY';
        headers['Content-Security-Policy'] = "frame-ancestors 'none'";
        headers['Set-Cookie'] = 'pl_proxy_target=; Path=/; Max-Age=0; SameSite=Lax';
      }

      const acceptEncoding = (req.headers && req.headers['accept-encoding']) || '';
      const isCompressible = /text|javascript|json|xml|svg/i.test(contentType);

      if (isCompressible && acceptEncoding.includes('br') && typeof zlib.brotliCompress === 'function') {
        headers['Content-Encoding'] = 'br';
        zlib.brotliCompress(content, (brErr, compressed) => {
          if (!brErr && compressed) {
            headers['Content-Length'] = compressed.length;
            res.writeHead(200, headers);
            res.end(compressed);
          } else {
            headers['Content-Length'] = content.length;
            delete headers['Content-Encoding'];
            res.writeHead(200, headers);
            res.end(content);
          }
        });
      } else if (isCompressible && acceptEncoding.includes('gzip')) {
        headers['Content-Encoding'] = 'gzip';
        zlib.gzip(content, (gzipErr, compressed) => {
          if (!gzipErr && compressed) {
            headers['Content-Length'] = compressed.length;
            res.writeHead(200, headers);
            res.end(compressed);
          } else {
            res.writeHead(200, headers);
            res.end(content);
          }
        });
      } else {
        headers['Content-Length'] = content.length;
        res.writeHead(200, headers);
        res.end(content);
      }
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
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {}
  }
});

async function bootTorBeforeTunnel() {
  setAppTorEnabled(true);
  let ready = false;
  try {
    const status = await torManager.ensureRunning();
    ready = Boolean(status && status.connected);
  } catch (e) {}
  if (ready) {
    nativeConsoleLog('[TOR] Rede Tor pronta. Abrindo o túnel ngrok.');
    lookupOutboundIp(true).catch(() => {});
  } else {
    nativeConsoleLog('[TOR] Tor ainda não confirmou. O túnel ngrok será aberto mesmo assim.');
  }
  // Mantendo somente o ngrok como túnel público
  ngrokTunnel.startTunnel(PORT);
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
    } catch (e) {}
  });
  return removed;
}

function removeDirContents(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {}
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
    } catch (e) {}
  });
  removeDirContents(MEDIA_DOWNLOADS_DIR);
  removeDirContents(path.join(os.tmpdir(), 'papaleguas_code'));
  const tempRemoved = clearRamTempFiles();
  try {
    const { wipePythonSessionFiles } = require('./python-runner');
    if (typeof wipePythonSessionFiles === 'function') wipePythonSessionFiles();
  } catch (e) {}
  try {
    const tunnelLog = path.join(__dirname, '../papaleguas/data/cloudflared.log');
    if (fs.existsSync(tunnelLog)) fs.writeFileSync(tunnelLog, '', 'utf8');
  } catch (e) {}
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
