'use strict';
// =========================================================================
// PAPALÉGUAS - GUARDA DE REQUISIÇÕES (anti-abuso do /proxy e dos streams)
// =========================================================================
// Regras:
// - Clientes locais (Electron, rede de casa) nunca são limitados.
// - Visitantes públicos (via túnel Cloudflare) são identificados pelo
//   cf-connecting-ip, que o Cloudflare sobrescreve e não pode ser forjado.
// - /proxy: limite generoso para quem está usando o app (cookie de sessão ou
//   requisição same-origin do navegador) e bem menor para chamadas "soltas"
//   (scripts/curl usando o servidor como proxy gratuito).
// - Streams/downloads (yt-dlp, pesados): limite por minuto + conexões
//   simultâneas por IP.
// Os limites são altos de propósito: no Brasil muitos celulares saem pelo
// mesmo IP (CGNAT da operadora).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { RateLimiter, ConcurrencyLimiter } = require('./rate-limit');

const COOKIE_NAME = 'pl_sid';
const COOKIE_MAX_AGE_SEC = 30 * 24 * 3600;

const HEAVY_MEDIA_PATHS = new Set([
  '/api/stream-audio',
  '/api/stream-video',
  '/api/audio-stream',
  '/api/audio-stream-id',
  '/api/media/download',
  '/api/media/download-job',
  '/api/media/download-stream',
  '/api/media/detect',
  '/api/media/play-url'
]);

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  const clean = String(ip).trim().replace(/^::ffff:/, '').toLowerCase();
  if (clean === '::1' || clean === 'localhost' || clean.startsWith('127.')) return true;
  if (/^10\./.test(clean) || /^192\.168\./.test(clean) || /^169\.254\./.test(clean)) return true;
  const m = clean.match(/^172\.(\d{1,3})\./);
  if (m) {
    const o = parseInt(m[1], 10);
    if (o >= 16 && o <= 31) return true;
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(clean)) return true; // Tailscale/CGNAT local
  return clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80:');
}

const FORWARD_HEADERS = ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-forwarded-for'];

/**
 * Identifica quem fez a requisição.
 * @returns {{ ip: string, isLocal: boolean }}
 */
function identifyRequester(req) {
  const headers = (req && req.headers) || {};
  const socketIp = String((req && req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  const cf = headers['cf-connecting-ip'];
  if (cf) return { ip: String(cf).trim(), isLocal: false };

  const hasForwarding = FORWARD_HEADERS.some((h) => headers[h]);
  if (isPrivateIp(socketIp) && !hasForwarding) {
    return { ip: socketIp || '127.0.0.1', isLocal: true };
  }
  if (isPrivateIp(socketIp) && hasForwarding) {
    // Atrás de um proxy local (ngrok etc.): usa o primeiro IP público informado
    const candidates = [headers['true-client-ip'], headers['x-real-ip']]
      .concat(String(headers['x-forwarded-for'] || '').split(','))
      .map((v) => String(v || '').trim())
      .filter(Boolean);
    const pub = candidates.find((ip) => !isPrivateIp(ip));
    if (pub) return { ip: pub, isLocal: false };
    return { ip: socketIp || '127.0.0.1', isLocal: true };
  }
  return { ip: socketIp, isLocal: isPrivateIp(socketIp) };
}

function loadOrCreateSecret(secretFile) {
  if (process.env.PAPALEGUAS_SESSION_SECRET) return process.env.PAPALEGUAS_SESSION_SECRET;
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (e) { /* ainda não existe */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  } catch (e) { /* sem disco: segredo só em memória até reiniciar */ }
  return secret;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

function sendTooMany(res, retryAfterSec, message) {
  if (res.headersSent) return;
  res.writeHead(429, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Retry-After': String(retryAfterSec || 5),
    'Cache-Control': 'no-store'
  });
  res.end(message || '429 Muitas requisições. Aguarde alguns segundos e tente de novo.');
}

/**
 * @param {{ secretFile?: string, logger?: { warn: Function } }} [opts]
 */
function createRequestGuard(opts = {}) {
  const secretFile = opts.secretFile || path.join(__dirname, '..', '..', 'data', '.guard-secret');
  const secret = opts.secret || loadOrCreateSecret(secretFile);
  const logger = opts.logger || null;

  const limits = {
    proxyTrusted: new RateLimiter({ windowMs: 60000, max: envInt('PL_LIMIT_PROXY_PER_MIN', 900) }),
    proxyAnonymous: new RateLimiter({ windowMs: 60000, max: envInt('PL_LIMIT_PROXY_ANON_PER_MIN', 40) }),
    heavyMedia: new RateLimiter({ windowMs: 60000, max: envInt('PL_LIMIT_MEDIA_PER_MIN', 90) }),
    clientLog: new RateLimiter({ windowMs: 60000, max: 30 }),
    global: new RateLimiter({ windowMs: 10000, max: envInt('PL_LIMIT_GLOBAL_PER_10S', 600) })
  };
  const mediaConcurrency = new ConcurrencyLimiter({ max: envInt('PL_LIMIT_MEDIA_CONCURRENT', 8) });

  const pruneTimer = setInterval(() => {
    Object.values(limits).forEach((l) => l.prune());
  }, 5 * 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  const blockedLog = new Map();
  function logBlock(kind, ip) {
    if (!logger) return;
    const key = kind + '|' + ip;
    const last = blockedLog.get(key) || 0;
    if (Date.now() - last < 60000) return;
    blockedLog.set(key, Date.now());
    if (blockedLog.size > 5000) blockedLog.clear();
    logger.warn(`limite atingido: ${kind} (ip=${ip})`);
  }

  function sign(issuedAt) {
    return crypto.createHmac('sha256', secret).update(String(issuedAt)).digest('base64url').slice(0, 32);
  }

  function makeSessionCookieValue(now = Date.now()) {
    const issued = Math.floor(now / 1000);
    return `${issued}.${sign(issued)}`;
  }

  function hasValidSession(req) {
    const value = parseCookies(req.headers && req.headers.cookie)[COOKIE_NAME];
    if (!value) return false;
    const [issued, sig] = value.split('.');
    if (!issued || !sig) return false;
    const age = Date.now() / 1000 - Number(issued);
    if (!(age >= -60 && age <= COOKIE_MAX_AGE_SEC)) return false;
    const expected = sign(issued);
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  const BOT_UA_REGEX = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|twitterbot|discordbot|slackbot|applebot|bingbot|googlebot|yandex|duckduckbot|baiduspider|gptbot|chatgpt|claude|perplexity|anthropic/i;

  function isTrustedAppRequest(req) {
    if (hasValidSession(req)) return true;
    const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
    if (site === 'same-origin') return true;
    const ua = String((req && req.headers && req.headers['user-agent']) || '');
    if (BOT_UA_REGEX.test(ua)) return true;
    return false;
  }

  // Marca o navegador como "usuário do app" ao abrir qualquer página HTML.
  function maybeIssueSessionCookie(req, res, pathname) {
    if (req.method !== 'GET' || pathname.startsWith('/proxy') || pathname.startsWith('/api/')) return;
    const dest = String(req.headers['sec-fetch-dest'] || '');
    const accept = String(req.headers.accept || '');
    if (dest !== 'document' && dest !== 'iframe' && !accept.includes('text/html')) return;
    if (hasValidSession(req)) return;
    const secure = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${makeSessionCookieValue()}; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  }

  /**
   * Aplica as regras. Retorna true se a requisição foi BLOQUEADA (429 já enviado).
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   * @param {string} pathname
   * @param {{ nativeRateLimitActive?: boolean }} [ctx]
   */
  function check(req, res, pathname, ctx = {}) {
    if (pathname === '/binance_pay_qr.jpg') return false;
    const who = identifyRequester(req);
    if (who.isLocal) return false;

    if (typeof opts.isIpBlocked === 'function' && opts.isIpBlocked(who.ip)) {
      if (!res.headersSent) {
        res.writeHead(403, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Connection': 'close',
          'Cache-Control': 'no-store'
        });
        res.end('403 Forbidden: Acesso bloqueado pelo administrador.');
      }
      try { if (req.socket && !req.socket.destroyed) req.socket.destroy(); } catch (e) {}
      return true;
    }

    maybeIssueSessionCookie(req, res, pathname);

    if (!ctx.nativeRateLimitActive) {
      const g = limits.global.hit(who.ip);
      if (!g.allowed) {
        logBlock('global', who.ip);
        sendTooMany(res, g.retryAfterSec);
        return true;
      }
    }

    if (pathname === '/proxy' || pathname === '/proxy/') {
      const trusted = isTrustedAppRequest(req);
      const r = (trusted ? limits.proxyTrusted : limits.proxyAnonymous).hit(who.ip);
      if (!r.allowed) {
        logBlock(trusted ? 'proxy' : 'proxy-anonimo', who.ip);
        sendTooMany(res, r.retryAfterSec, '429 Limite do proxy atingido. Abra o Papaléguas pelo app para navegar.');
        return true;
      }
      return false;
    }

    if (HEAVY_MEDIA_PATHS.has(pathname)) {
      const r = limits.heavyMedia.hit(who.ip);
      if (!r.allowed) {
        logBlock('midia', who.ip);
        sendTooMany(res, r.retryAfterSec);
        return true;
      }
      const release = mediaConcurrency.acquire(who.ip);
      if (!release) {
        logBlock('midia-simultanea', who.ip);
        sendTooMany(res, 3, '429 Muitas mídias abertas ao mesmo tempo neste IP.');
        return true;
      }
      res.on('close', release);
      res.on('finish', release);
      return false;
    }

    if (pathname === '/api/client-log') {
      const r = limits.clientLog.hit(who.ip);
      if (!r.allowed) {
        res.writeHead(204);
        res.end();
        return true;
      }
    }
    return false;
  }

  return {
    check,
    identifyRequester,
    hasValidSession,
    makeSessionCookieValue,
    stop: () => clearInterval(pruneTimer),
    _limits: limits,
    _mediaConcurrency: mediaConcurrency
  };
}

module.exports = { createRequestGuard, identifyRequester, isPrivateIp, HEAVY_MEDIA_PATHS, COOKIE_NAME };
