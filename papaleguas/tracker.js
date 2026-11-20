const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');

let nativeCore = null;
try {
  nativeCore = require('../main/native-core.js');
} catch (e) {
  nativeCore = null;
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const GEO_CACHE_FILE = path.join(DATA_DIR, 'geo_cache.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const CAPTURED_REQUESTS_FILE = path.join(DATA_DIR, 'captured_requests.json');
const BLOCKED_IPS_FILE = path.join(DATA_DIR, 'blocked_ips.json');

const MAX_CAPTURED_REQUESTS = 250;
let capturedRequests = [];

// Carrega requisições capturadas salvas
if (fs.existsSync(CAPTURED_REQUESTS_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(CAPTURED_REQUESTS_FILE, 'utf8'));
    if (Array.isArray(loaded)) {
      capturedRequests = loaded.slice(0, MAX_CAPTURED_REQUESTS);
    }
  } catch (e) {
    capturedRequests = [];
  }
}

let saveRequestsTimer = null;
function queueSaveCapturedRequests() {
  if (saveRequestsTimer) return;
  saveRequestsTimer = setTimeout(() => {
    saveRequestsTimer = null;
    try {
      const toSave = JSON.stringify(capturedRequests.slice(0, 150));
      fs.promises.writeFile(CAPTURED_REQUESTS_FILE, toSave, 'utf8').catch(() => {});
    } catch (e) {}
  }, 2000);
}

// ---------------------------------------------------------------------------
// BLOQUEADOR DE IPS (FIREWALL & ANTI-ABUSO EM TEMPO REAL)
// ---------------------------------------------------------------------------
const blockedIpsMap = new Map();
let lastBlockedIpsMtime = 0;

function loadBlockedIps() {
  if (!fs.existsSync(BLOCKED_IPS_FILE)) return;
  try {
    const stat = fs.statSync(BLOCKED_IPS_FILE);
    if (stat.mtimeMs <= lastBlockedIpsMtime) return;
    lastBlockedIpsMtime = stat.mtimeMs;
    const raw = fs.readFileSync(BLOCKED_IPS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      blockedIpsMap.clear();
      parsed.forEach((item) => {
        if (item && item.ip) {
          const ip = String(item.ip).trim().replace(/^::ffff:/, '');
          blockedIpsMap.set(ip, {
            ip,
            reason: item.reason || 'Bloqueado pelo administrador',
            blockedAt: item.blockedAt || new Date().toISOString(),
            hitsBlocked: Number(item.hitsBlocked) || 0,
            lastBlockedHit: item.lastBlockedHit || null
          });
        }
      });
    }
  } catch (e) {
    console.warn('[TRACKER BLOCKED IPS LOAD ERR]', e.message);
  }
}
loadBlockedIps();

let saveBlockedIpsTimer = null;
function queueSaveBlockedIps() {
  if (saveBlockedIpsTimer) return;
  saveBlockedIpsTimer = setTimeout(() => {
    saveBlockedIpsTimer = null;
    try {
      const arr = Array.from(blockedIpsMap.values());
      fs.promises.writeFile(BLOCKED_IPS_FILE, JSON.stringify(arr, null, 2), 'utf8')
        .then(() => {
          try { lastBlockedIpsMtime = fs.statSync(BLOCKED_IPS_FILE).mtimeMs; } catch (e) {}
        })
        .catch((e) => console.warn('[TRACKER BLOCKED IPS SAVE ERR]', e.message));
    } catch (e) {}
  }, 1000);
}

function saveBlockedIpsSync() {
  try {
    const arr = Array.from(blockedIpsMap.values());
    fs.writeFileSync(BLOCKED_IPS_FILE, JSON.stringify(arr, null, 2), 'utf8');
    try { lastBlockedIpsMtime = fs.statSync(BLOCKED_IPS_FILE).mtimeMs; } catch (e) {}
  } catch (e) {
    console.warn('[TRACKER BLOCKED IPS SYNC ERR]', e.message);
  }
}

function isCloudflareInfraIp(ip) {
  if (!ip) return false;
  const s = String(ip).toLowerCase().trim();
  if (s.startsWith('2a06:98c0:') || s.startsWith('2606:4700:') || s.startsWith('2803:f800:')) return true;
  if (/^172\.(6[4-9]|7[0-1])\./.test(s) || /^104\.(1[6-9]|2\d|3[0-1])\./.test(s)) return true;
  return false;
}

function cleanIpForCheck(ip) {
  if (!ip) return '';
  return String(ip).trim().replace(/^::ffff:/, '');
}

function isIpBlocked(ip) {
  const clean = cleanIpForCheck(ip);
  if (!clean || isPrivateIp(clean) || isCloudflareInfraIp(clean)) return false;
  try {
    if (fs.existsSync(BLOCKED_IPS_FILE)) {
      const st = fs.statSync(BLOCKED_IPS_FILE);
      if (st.mtimeMs > lastBlockedIpsMtime) {
        loadBlockedIps();
      }
    }
  } catch (e) {}
  return blockedIpsMap.has(clean);
}

function blockIp(ip, reason = 'Bloqueado pelo administrador') {
  const clean = cleanIpForCheck(ip);
  if (!clean) return { success: false, error: 'Endereço de IP inválido.' };
  if (isPrivateIp(clean)) {
    return { success: false, error: 'Não é permitido bloquear IPs locais/privados (127.0.0.1 ou rede interna).' };
  }
  if (isCloudflareInfraIp(clean)) {
    return { success: false, error: 'Não é permitido bloquear IPs de infraestrutura Cloudflare.' };
  }
  const existing = blockedIpsMap.get(clean);
  const record = {
    ip: clean,
    reason: String(reason || 'Bloqueado pelo administrador').slice(0, 250),
    blockedAt: existing && existing.blockedAt ? existing.blockedAt : new Date().toISOString(),
    hitsBlocked: existing ? (existing.hitsBlocked || 0) : 0,
    lastBlockedHit: existing ? existing.lastBlockedHit : null
  };
  blockedIpsMap.set(clean, record);
  saveBlockedIpsSync();
  return { success: true, message: `IP ${clean} bloqueado com sucesso.`, record };
}

function unblockIp(ip) {
  const clean = cleanIpForCheck(ip);
  if (!clean) return { success: false, error: 'Endereço de IP inválido.' };
  if (!blockedIpsMap.has(clean)) {
    return { success: false, error: `O IP ${clean} não está na lista de bloqueio.` };
  }
  blockedIpsMap.delete(clean);
  saveBlockedIpsSync();
  return { success: true, message: `IP ${clean} desbloqueado com sucesso.`, ip: clean };
}

function getBlockedIps() {
  return Array.from(blockedIpsMap.values()).sort((a, b) => new Date(b.blockedAt) - new Date(a.blockedAt));
}

function recordBlockedHit(ip, url = '') {
  const clean = cleanIpForCheck(ip);
  if (!clean) return;
  const record = blockedIpsMap.get(clean);
  if (record) {
    record.hitsBlocked = (record.hitsBlocked || 0) + 1;
    record.lastBlockedHit = new Date().toISOString();
    queueSaveBlockedIps();
  }
}

// Configurações do Rastreamento
let trackerSettings = {
  trackingEnabled: true
};

if (fs.existsSync(SETTINGS_FILE)) {
  try {
    trackerSettings = { ...trackerSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (e) {
    trackerSettings = { trackingEnabled: true };
  }
}

function saveSettings() {
  try {
    fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(trackerSettings, null, 2), 'utf8')
      .catch((e) => console.warn('[TRACKER SETTINGS SAVE ERR]', e.message));
  } catch (e) {
    console.warn('[TRACKER SETTINGS SAVE ERR]', e.message);
  }
}

function isTrackingEnabled() {
  return trackerSettings.trackingEnabled !== false;
}

function setTrackingEnabled(enabled) {
  trackerSettings.trackingEnabled = Boolean(enabled);
  saveSettings();
  return trackerSettings.trackingEnabled;
}

function isServerLogsPaused() {
  return trackerSettings.serverLogsPaused === true;
}

function setServerLogsPaused(paused) {
  trackerSettings.serverLogsPaused = Boolean(paused);
  saveSettings();
  return trackerSettings.serverLogsPaused;
}

let residueGeneration = 0;

function clearAllAnalyticsData() {
  residueGeneration += 1;
  try {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
  } catch (e) {}
  analyticsData = {
    totalVisits: 0,
    totalConversions: 0,
    visits: [],
    ipStats: {},
    dailyStats: {},
    pageStats: {}
  };
  geoCache = {};
  try {
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analyticsData, null, 2), 'utf8');
  } catch (e) {}
  try {
    if (fs.existsSync(GEO_CACHE_FILE)) {
      fs.unlinkSync(GEO_CACHE_FILE);
    }
  } catch (e) {}

  // Limpa requisições capturadas
  clearCapturedRequests();

  // Limpa também arquivos de log adicionais do projeto caso existam
  try {
    const rootDir = path.join(__dirname, '..');
    const appLog = path.join(rootDir, 'app.log');
    const electronLog = path.join(rootDir, 'electron.log');
    if (fs.existsSync(appLog)) fs.writeFileSync(appLog, '', 'utf8');
    if (fs.existsSync(electronLog)) fs.writeFileSync(electronLog, '', 'utf8');
  } catch (e) {}

  return {
    success: true,
    message: 'Todos os registros de requisições, acessos e logs foram excluídos com sucesso. Contadores zerados!'
  };
}

function clearCapturedRequests() {
  capturedRequests = [];
  try {
    if (fs.existsSync(CAPTURED_REQUESTS_FILE)) {
      fs.unlinkSync(CAPTURED_REQUESTS_FILE);
    }
  } catch (e) {}
  return {
    success: true,
    count: 0,
    message: 'Histórico de requisições capturadas limpo com sucesso.'
  };
}

function getCapturedRequests(limit = 100) {
  return capturedRequests.slice(0, Math.min(MAX_CAPTURED_REQUESTS, Math.max(1, limit)));
}

// Memória de sessões ativas
const activeSessions = new Map();

// Cache de GeoIP mantido exclusivamente em memória RAM (sem salvar em geo_cache.json)
let geoCache = {};
try {
  if (fs.existsSync(GEO_CACHE_FILE)) {
    fs.unlinkSync(GEO_CACHE_FILE);
  }
} catch (e) {}

function saveGeoCache() {
  // Mantido exclusivamente em memória RAM durante a execução (não grava no disco)
  try {
    const keys = Object.keys(geoCache);
    if (keys.length > 2000) {
      for (let i = 0; i < keys.length - 1500; i++) {
        delete geoCache[keys[i]];
      }
    }
  } catch (e) {}
}

// Carrega ou inicializa Analytics
let analyticsData = {
  totalVisits: 0,
  totalConversions: 0, // downloads, buscas
  visits: [],          // histórico detalhado dos últimos 2000 acessos
  ipStats: {},         // agregado por IP
  dailyStats: {},      // agregado por data (YYYY-MM-DD)
  pageStats: {}        // acessos por rota
};

function isExcludedFromTracking(pathname, fullUrl) {
  if (!pathname || typeof pathname !== 'string') return true;
  const lower = pathname.toLowerCase();

  // Exclui apenas buscas anônimas e rotas de infraestrutura interna/proxy
  if (
    lower.startsWith('/search') ||
    lower.startsWith('/proxy') ||
    lower.startsWith('/ip-check') ||
    lower.startsWith('/api/url-suggest') ||
    lower.startsWith('/api/extract') ||
    lower.startsWith('/api/query-ai') ||
    lower.startsWith('/api/clear-traces')
  ) {
    return true;
  }

  // Exclui chamadas repetitivas do próprio painel admin e polling interno
  if (
    lower.includes('metric') ||
    lower.startsWith('/metrics') ||
    lower.startsWith('/api/metrics') ||
    lower.startsWith('/api/papaleguas') ||
    lower.startsWith('/papaleguas') ||
    lower.startsWith('/admin.') ||
    lower.startsWith('/favicon') ||
    lower.startsWith('/api/media/download-status') ||
    lower.startsWith('/api/session-info') ||
    lower.startsWith('/sw.js') ||
    lower.endsWith('.map') ||
    lower.endsWith('.ico')
  ) {
    return true;
  }
  return false;
}

function stripQueryTraces(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const qIdx = raw.indexOf('?');
  const hIdx = raw.indexOf('#');
  let cut = raw.length;
  if (qIdx !== -1 && qIdx < cut) cut = qIdx;
  if (hIdx !== -1 && hIdx < cut) cut = hIdx;
  return raw.slice(0, cut);
}

function isSearchTracePath(lowerPath) {
  return (
    lowerPath.startsWith('/search') ||
    lowerPath.startsWith('/proxy') ||
    lowerPath.startsWith('/api/youtube-search') ||
    lowerPath.startsWith('/api/url-suggest') ||
    lowerPath.startsWith('/api/suggest') ||
    lowerPath.startsWith('/api/music-search') ||
    lowerPath.startsWith('/api/dj-chat') ||
    lowerPath.startsWith('/api/query-ai') ||
    lowerPath.startsWith('/api/extract') ||
    lowerPath.startsWith('/api/stream-video') ||
    lowerPath.startsWith('/api/stream-audio')
  );
}

function sanitizeAnalyticsData() {
  if (!analyticsData) return;
  // Remove quaisquer parâmetros de pesquisa/vídeo (?q=, ?v=, ?title=, ?ppl=) gravados em analytics
  if (analyticsData.ipStats) {
    for (const ip of Object.keys(analyticsData.ipStats)) {
      const stat = analyticsData.ipStats[ip];
      if (stat) {
        if (!stat.pages) stat.pages = {};
        const cleanPages = {};
        for (const [k, v] of Object.entries(stat.pages)) {
          const ck = stripQueryTraces(k);
          if (ck && !isSearchTracePath(ck.toLowerCase())) {
            cleanPages[ck] = (cleanPages[ck] || 0) + (Number(v) || 0);
          }
        }
        stat.pages = cleanPages;
        if (!Array.isArray(stat.recentRequests)) stat.recentRequests = [];
        stat.recentRequests = stat.recentRequests
          .filter((r) => r && !isSearchTracePath(String(r.pathname || r.path || '').toLowerCase()))
          .map((r) => Object.assign({}, r, {
            path: stripQueryTraces(r.pathname || r.path || '/'),
            pathname: stripQueryTraces(r.pathname || r.path || '/'),
            referer: r.referer ? stripQueryTraces(r.referer).slice(0, 100) : null
          }))
          .slice(0, 25);
      }
    }
  }
}

if (fs.existsSync(ANALYTICS_FILE)) {
  try {
    analyticsData = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
    if (!analyticsData.ipStats) analyticsData.ipStats = {};
    if (!analyticsData.dailyStats) analyticsData.dailyStats = {};
    if (!analyticsData.pageStats) analyticsData.pageStats = {};
    if (!Array.isArray(analyticsData.visits)) analyticsData.visits = [];
    sanitizeAnalyticsData();
  } catch (e) {
    console.warn('[ANALYTICS WARN] Falha ao carregar analytics.json:', e.message);
  }
}

let saveTimeout = null;
let isSavingAnalytics = false;
let pendingSaveAnalytics = false;

function queueSaveAnalytics() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveAnalyticsNow();
  }, 1500);
}

function saveAnalyticsNow() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (isSavingAnalytics) {
    pendingSaveAnalytics = true;
    return;
  }
  try {
    if (analyticsData && Array.isArray(analyticsData.visits) && analyticsData.visits.length > 500) {
      analyticsData.visits = analyticsData.visits.slice(0, 500);
    }
    const payload = JSON.stringify(analyticsData);
    isSavingAnalytics = true;
    const tmpFile = `${ANALYTICS_FILE}.tmp`;
    fs.promises.writeFile(tmpFile, payload, 'utf8')
      .then(() => fs.promises.rename(tmpFile, ANALYTICS_FILE))
      .catch((e) => console.warn('[ANALYTICS SAVE ERR]', e.message))
      .finally(() => {
        isSavingAnalytics = false;
        if (pendingSaveAnalytics) {
          pendingSaveAnalytics = false;
          queueSaveAnalytics();
        }
      });
  } catch (e) {
    console.warn('[ANALYTICS SAVE ERR]', e.message);
  }
}

try {
  process.on('beforeExit', () => {
    try {
      if (analyticsData && Array.isArray(analyticsData.visits) && analyticsData.visits.length > 500) {
        analyticsData.visits = analyticsData.visits.slice(0, 500);
      }
      fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analyticsData), 'utf8');
    } catch (e) {}
  });
  process.on('SIGINT', () => {
    try {
      if (analyticsData && Array.isArray(analyticsData.visits) && analyticsData.visits.length > 500) {
        analyticsData.visits = analyticsData.visits.slice(0, 500);
      }
      fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analyticsData), 'utf8');
    } catch (e) {}
  });
} catch (e) {}

// ==========================================
// 1. GERENCIAMENTO DE CONTA MASTER ADMIN
// ==========================================

function hasAdminAccount() {
  if (!fs.existsSync(ADMIN_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    return Boolean(data && data.username && data.passwordHash);
  } catch (e) {
    return false;
  }
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function createAdminAccount(username, password) {
  if (!username || !password || password.length < 4) {
    throw new Error('Usuário e senha (mínimo 4 caracteres) são obrigatórios.');
  }
  if (hasAdminAccount()) {
    throw new Error('Já existe uma conta administradora configurada.');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);

  const adminData = {
    username: username.trim(),
    salt,
    passwordHash,
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };

  fs.writeFileSync(ADMIN_FILE, JSON.stringify(adminData, null, 2), 'utf8');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000);
  activeSessions.set(token, { username: adminData.username, expiresAt });
  return { success: true, username: adminData.username, token };
}

function authenticateAdmin(username, password) {
  if (!hasAdminAccount()) {
    throw new Error('Nenhuma conta administradora criada ainda.');
  }

  const data = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
  if (data.username.toLowerCase() !== username.trim().toLowerCase()) {
    return { success: false, error: 'Usuário incorreto.' };
  }

  const checkHash = hashPassword(password, data.salt);
  if (checkHash !== data.passwordHash) {
    return { success: false, error: 'Senha incorreta.' };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const sessionInfo = {
    username: data.username,
    createdAt: Date.now(),
    expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000)
  };
  activeSessions.set(token, sessionInfo);

  data.lastLoginAt = new Date().toISOString();
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}

  return { success: true, token, username: data.username };
}

function validateSession(reqOrToken) {
  let token = null;
  if (typeof reqOrToken === 'string') {
    token = reqOrToken;
  } else if (reqOrToken && reqOrToken.headers) {
    const authHeader = reqOrToken.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '').trim();
    } else if (reqOrToken.headers.cookie) {
      const match = reqOrToken.headers.cookie.match(/papaleguas_token=([^;]+)/);
      if (match) token = match[1];
    }
  }

  if (!token) return false;
  const session = activeSessions.get(token);
  if (!session) return false;

  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return false;
  }

  return true;
}

function logoutAdmin(reqOrToken) {
  let token = null;
  if (typeof reqOrToken === 'string') token = reqOrToken;
  else if (reqOrToken && reqOrToken.headers) {
    const authHeader = reqOrToken.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) token = authHeader.replace('Bearer ', '').trim();
    else if (reqOrToken.headers.cookie) {
      const match = reqOrToken.headers.cookie.match(/papaleguas_token=([^;]+)/);
      if (match) token = match[1];
    }
  }
  if (token) activeSessions.delete(token);
  return { success: true };
}

// ==========================================
// 2. EXTRAÇÃO E GEOLOCALIZAÇÃO DE IP
// ==========================================

function isPublicIpv4(ip) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || '')) && !isPrivateIp(ip);
}

function isPublicIpv6(ip) {
  const value = String(ip || '').trim();
  if (!value.includes(':')) return false;
  if (value === '::1' || value.toLowerCase().startsWith('fe80:') || value.toLowerCase().startsWith('fc') || value.toLowerCase().startsWith('fd')) return false;
  return !isPrivateIp(value);
}

function headerIpCandidates(req) {
  const found = [];
  const push = (value) => {
    String(value || '').split(',').forEach((part) => {
      let ip = part.trim().replace(/^::ffff:/, '');
      if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
      const zone = ip.indexOf('%');
      if (zone !== -1) ip = ip.slice(0, zone);
      if (ip) found.push(ip);
    });
  };
  push(req.headers['cf-connecting-ip']);
  push(req.headers['true-client-ip']);
  push(req.headers['x-real-ip']);
  push(req.headers['x-forwarded-for']);
  return found;
}

function extractClientIp(req) {
  const candidates = headerIpCandidates(req);
  const ipv4 = candidates.find((ip) => isPublicIpv4(ip));
  if (ipv4) return ipv4;
  const ipv6 = candidates.find((ip) => isPublicIpv6(ip));
  if (ipv6) return ipv6;
  const remote = req.socket ? req.socket.remoteAddress : (req.connection ? req.connection.remoteAddress : '');
  if (remote) {
    let clean = remote.trim();
    if (clean.startsWith('::ffff:')) clean = clean.replace('::ffff:', '');
    return clean || '127.0.0.1';
  }
  return '127.0.0.1';
}

function isPrivateIp(ip) {
  if (nativeCore && typeof nativeCore.isPrivateIp === 'function') {
    return nativeCore.isPrivateIp(ip);
  }
  if (!ip) return false;
  let clean = String(ip).trim();

  if (clean.startsWith('::ffff:')) {
    clean = clean.replace('::ffff:', '');
  }

  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost' || clean.startsWith('127.')) {
    return true;
  }

  // 10.0.0.0/8
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;

  // 172.16.0.0/12 (172.16.0.0 a 172.31.255.255)
  const match172 = clean.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (match172) {
    const secondOctet = parseInt(match172[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }

  // 192.168.0.0/16
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;

  // 169.254.0.0/16 (Link-Local)
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;

  // IPv6 ULA e Link-Local
  const lower = clean.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(lower) || lower.startsWith('fe80:')) return true;

  return false;
}

function getIpVersion(ip) {
  if (!ip) return 'IPv4';
  let clean = String(ip).trim();
  if (clean.startsWith('::ffff:')) {
    clean = clean.replace('::ffff:', '');
  }
  if (clean === '::1' || clean.includes(':')) {
    return 'IPv6';
  }
  return 'IPv4';
}

const reverseDnsPending = new Set();

async function resolveClientHostname(ip) {
  if (!ip || isPrivateIp(ip)) return '';
  if (reverseDnsPending.has(ip)) return '';
  reverseDnsPending.add(ip);
  try {
    const cleanIp = String(ip).trim().replace(/^::ffff:/, '');
    const hosts = await Promise.race([
      dns.promises.reverse(cleanIp),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS_TIMEOUT')), 1500))
    ]);
    const host = Array.isArray(hosts) && hosts[0] ? String(hosts[0]).trim() : '';
    if (analyticsData.ipStats[ip]) {
      analyticsData.ipStats[ip].clientHostname = host;
      queueSaveAnalytics();
    }
    if (geoCache[ip] && host && !geoCache[ip].reverse) {
      geoCache[ip].reverse = host;
      saveGeoCache();
    }
    return host;
  } catch (e) {
    if (analyticsData.ipStats[ip] && analyticsData.ipStats[ip].clientHostname === undefined) {
      analyticsData.ipStats[ip].clientHostname = '';
    }
    return '';
  } finally {
    reverseDnsPending.delete(ip);
  }
}

async function resolveIpGeo(ip) {
  const generation = residueGeneration;
  if (!ip || isPrivateIp(ip)) {
    return {
      ip: ip || '127.0.0.1',
      country: 'Brasil (Local)',
      countryCode: 'BR',
      flag: '🇧🇷',
      city: 'Rede Local / Túnel Privado',
      region: 'Localhost',
      isp: 'Provedor Local',
      lat: 0,
      lon: 0
    };
  }

  if (geoCache[ip]) {
    return geoCache[ip];
  }

  return new Promise((resolve) => {
    const url = `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,regionName,city,lat,lon,isp,org,as,reverse`;
    const req = http.get(url, { timeout: 3500 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'success') {
            const flag = getFlagEmoji(json.countryCode);
            let reverseHost = json.reverse ? String(json.reverse).trim() : '';
            if (!reverseHost) {
              reverseHost = await resolveClientHostname(ip);
            }
            const info = {
              ip,
              country: json.country || 'Desconhecido',
              countryCode: json.countryCode || 'XX',
              flag,
              city: json.city || 'Desconhecida',
              region: json.regionName || '',
              isp: json.isp || 'Provedor Desconhecido',
              org: json.org || '',
              as: json.as || '',
              reverse: reverseHost,
              lat: json.lat,
              lon: json.lon
            };
            if (generation !== residueGeneration) return resolve(info);
            geoCache[ip] = info;
            saveGeoCache();
            return resolve(info);
          }
        } catch (e) {}
        
        const fallback = {
          ip,
          country: 'Brasil',
          countryCode: 'BR',
          flag: '🇧🇷',
          city: 'Internet Pública',
          region: '',
          isp: 'Conexão Banda Larga / Celular',
          lat: 0,
          lon: 0
        };
        if (generation === residueGeneration) geoCache[ip] = fallback;
        resolve(fallback);
      });
    });

    req.on('error', () => {
      resolve({
        ip,
        country: 'Brasil',
        countryCode: 'BR',
        flag: '🇧🇷',
        city: 'Internet Pública',
        region: '',
        isp: 'Provedor Web',
        lat: 0,
        lon: 0
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ip,
        country: 'Online',
        countryCode: 'BR',
        flag: '🌐',
        city: 'Conexão Ativa',
        region: '',
        isp: 'Rede Externa',
        lat: 0,
        lon: 0
      });
    });
  });
}

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

// ==========================================
// 3. RASTREAMENTO DE ACESSOS E AÇÕES
// ==========================================

function detectDevice(userAgent, ip) {
  const ua = (userAgent || '').toLowerCase();
  let brand = '';
  let os = '';

  // 0. Detecção de Robôs de Busca, Crawlers e Ferramentas HTTP
  if (ua.includes('googlebot')) {
    return '🤖 Googlebot (Crawler)';
  }
  if (ua.includes('bingbot')) {
    return '🤖 Bingbot (Crawler)';
  }
  if (ua.includes('duckduckbot') || ua.includes('slurp') || ua.includes('yandexbot') || ua.includes('baiduspider')) {
    return '🤖 Robô / Rastreador Web';
  }
  if (ua.includes('curl/') || ua.startsWith('curl/')) {
    return '⚡ Terminal / cURL';
  }
  if (ua.includes('postmanruntime')) {
    return '🛠️ Postman / API Client';
  }

  // 1. Detecção de Smart TVs
  if (ua.includes('smart-tv') || ua.includes('smarttv') || ua.includes('tizen') || ua.includes('web0s') || ua.includes('webos') || ua.includes('roku') || ua.includes('googletv') || ua.includes('androidtv')) {
    if (ua.includes('tizen')) os = '📺 Smart TV Samsung (Tizen)';
    else if (ua.includes('webos') || ua.includes('web0s')) os = '📺 Smart TV LG (webOS)';
    else if (ua.includes('roku')) os = '📺 Smart TV Roku';
    else os = '📺 Smart TV / Android TV';
  } else {
    // 2. Marcas Mobile / Fabricantes
    if (ua.includes('samsung') || ua.includes('sm-') || ua.includes('samsungbrowser')) {
      brand = 'Samsung Galaxy';
    } else if (ua.includes('xiaomi') || ua.includes('redmi') || ua.includes('poco')) {
      brand = 'Xiaomi';
    } else if (ua.includes('motorola') || ua.includes('moto')) {
      brand = 'Motorola';
    } else if (ua.includes('iphone')) {
      brand = 'Apple iPhone';
    } else if (ua.includes('ipad')) {
      brand = 'Apple iPad';
    } else if (ua.includes('pixel')) {
      brand = 'Google Pixel';
    }

    // 3. Sistema Operacional
    if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) {
      const match = ua.match(/os (\d+[_\d]*)/);
      const ver = match ? ' iOS ' + match[1].replace(/_/g, '.') : ' iOS';
      os = brand ? `📱 ${brand} (${ver})` : `📱 iPhone (${ver})`;
    } else if (ua.includes('android')) {
      const match = ua.match(/android (\d+(\.\d+)?)/);
      const ver = match ? ' Android ' + match[1] : ' Android';
      os = brand ? `📱 ${brand} (${ver})` : `📱 Smartphone (${ver})`;
    } else if (ua.includes('windows')) {
      if (ua.includes('windows nt 10.0')) os = '💻 PC (Windows 10/11)';
      else os = '💻 Computador (Windows)';
    } else if (ua.includes('macintosh') || ua.includes('mac os')) {
      os = '💻 Apple Mac (macOS)';
    } else if (ua.includes('linux')) {
      os = '💻 Computador (Linux)';
    } else {
      os = '🌐 Navegador Web';
    }
  }

  // 4. Indicador de Rede (Local vs Externa)
  const isLocal = isPrivateIp(ip);
  const netTag = isLocal ? ' [Rede Local Wi-Fi]' : ' [Rede Externa]';
  return os + netTag;
}

function extractServerHost(req) {
  if (!req) return '';
  const headers = req.headers || {};
  const forwardedHost = headers['x-forwarded-host'];
  const rawHost = forwardedHost || headers.host || '';
  const cleanHost = String(rawHost).split(',')[0].trim();
  if (cleanHost) return cleanHost;
  const localAddr = req.socket && req.socket.localAddress ? String(req.socket.localAddress).replace(/^::ffff:/, '') : '';
  const localPort = req.socket && req.socket.localPort ? `:${req.socket.localPort}` : '';
  return localAddr ? `${localAddr}${localPort}` : '';
}

function logAccess(req, pathname, fullUrl) {
  if (!isTrackingEnabled()) {
    return;
  }
  if (isExcludedFromTracking(pathname, fullUrl)) {
    return;
  }

  const ip = extractClientIp(req);
  if (!ip) {
    return;
  }
  const userAgent = req.headers['user-agent'] || 'Desconhecido';
  const device = detectDevice(userAgent, ip);
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString('pt-BR');
  const targetUrl = fullUrl || (req.url || pathname);
  const ipVer = getIpVersion(ip);
  const serverHost = extractServerHost(req);

  analyticsData.totalVisits++;

  if (!analyticsData.dailyStats[dateKey]) {
    analyticsData.dailyStats[dateKey] = { visits: 0, conversions: 0 };
  }
  analyticsData.dailyStats[dateKey].visits++;

  if (!analyticsData.ipStats[ip]) {
    analyticsData.ipStats[ip] = {
      ip,
      ipVersion: ipVer,
      serverHost,
      firstSeen: now.toISOString(),
      lastSeen: now.toISOString(),
      visitsCount: 0,
      device,
      userAgent: userAgent.slice(0, 80),
      conversions: 0,
      geo: null
    };

    resolveIpGeo(ip).then(geo => {
      if (analyticsData.ipStats[ip]) {
        analyticsData.ipStats[ip].geo = geo;
        queueSaveAnalytics();
      }
    });
  }

  const stat = analyticsData.ipStats[ip];
  stat.visitsCount++;
  stat.lastSeen = now.toISOString();
  stat.device = device;
  stat.serverHost = serverHost;
  if (!stat.ipVersion) stat.ipVersion = ipVer;

  queueSaveAnalytics();
}

function captureHttpRequest({ req, res, statusCode, durationMs, pathname, fullUrl, method }) {
  if (!isTrackingEnabled()) return;
  if (!req) return;

  const m = (method || req.method || 'GET').toUpperCase();
  const rawUrl = fullUrl || req.url || pathname || '/';
  const urlPath = pathname || rawUrl.split('?')[0] || '/';
  const lowerPath = urlPath.toLowerCase();

  // Exclui polling do admin e todas as rotas de pesquisa/proxy/stream (zero rastros de busca)
  if (
    isSearchTracePath(lowerPath) ||
    lowerPath === '/api/papaleguas/metrics' ||
    lowerPath === '/api/papaleguas/status' ||
    lowerPath === '/api/papaleguas/requests' ||
    lowerPath === '/papaleguas/admin.js' ||
    lowerPath === '/papaleguas/admin.css' ||
    lowerPath.endsWith('.map')
  ) {
    return;
  }

  const clientIp = extractClientIp(req);
  if (!clientIp) return;

  const userAgent = req.headers['user-agent'] || 'Navegador Web';
  const referer = req.headers['referer'] || req.headers['referrer'] || '';
  const device = detectDevice(userAgent, clientIp);
  const now = new Date();
  const timeFormatted = now.toLocaleTimeString('pt-BR', { hour12: false });
  const isLocal = isPrivateIp(clientIp);
  const ipVer = getIpVersion(clientIp);
  const finalStatus = statusCode || (res && res.statusCode) || 200;
  const latency = Math.max(1, Math.round(durationMs || 0));
  const serverHost = extractServerHost(req);

  let geo = geoCache[clientIp] || null;
  if (!geo && isLocal) {
    geo = {
      flag: '🏠',
      country: 'Rede Local',
      city: 'Wi-Fi / Localhost',
      isp: 'Rede Privada'
    };
  }

  const sanitizedPath = stripQueryTraces(urlPath) || '/';
  const sanitizedReferer = referer ? stripQueryTraces(referer).slice(0, 100) : null;
  const reqItem = {
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: now.toISOString(),
    time: timeFormatted,
    method: m,
    path: sanitizedPath,
    pathname: sanitizedPath,
    status: finalStatus,
    durationMs: latency,
    ip: clientIp,
    ipVersion: ipVer,
    serverHost,
    isLocal,
    device,
    userAgent: userAgent.slice(0, 140),
    referer: sanitizedReferer,
    geo: geo ? {
      flag: geo.flag || '🌐',
      country: geo.country || 'Desconhecido',
      city: geo.city || '',
      isp: geo.isp || ''
    } : { flag: '🌐', country: 'Online', city: '', isp: '' }
  };

  if (!geoCache[clientIp] && !isLocal) {
    resolveIpGeo(clientIp).then(resolvedGeo => {
      if (resolvedGeo) {
        reqItem.geo = {
          flag: resolvedGeo.flag || '🌐',
          country: resolvedGeo.country || 'Desconhecido',
          city: resolvedGeo.city || '',
          isp: resolvedGeo.isp || ''
        };
      }
    }).catch(() => {});
  }

  capturedRequests.unshift(reqItem);
  if (capturedRequests.length > MAX_CAPTURED_REQUESTS) {
    capturedRequests = capturedRequests.slice(0, MAX_CAPTURED_REQUESTS);
  }

  // Registra a requisição diretamente no histórico específico deste IP
  if (!analyticsData.ipStats[clientIp]) {
    analyticsData.ipStats[clientIp] = {
      ip: clientIp,
      ipVersion: ipVer,
      serverHost,
      firstSeen: now.toISOString(),
      lastSeen: now.toISOString(),
      visitsCount: 0,
      device,
      userAgent: userAgent.slice(0, 100),
      conversions: 0,
      geo,
      pages: {},
      recentRequests: []
    };
  }

  const stat = analyticsData.ipStats[clientIp];
  stat.visitsCount = (stat.visitsCount || 0) + 1;
  stat.lastSeen = now.toISOString();
  stat.device = device;
  stat.serverHost = serverHost;
  if (!stat.ipVersion) stat.ipVersion = ipVer;
  if (!stat.pages) stat.pages = {};
  if (!Array.isArray(stat.recentRequests)) stat.recentRequests = [];

  const cleanPath = urlPath || '/';
  stat.pages[sanitizedPath] = (stat.pages[sanitizedPath] || 0) + 1;

  stat.recentRequests.unshift({
    time: timeFormatted,
    method: m,
    path: sanitizedPath,
    status: finalStatus,
    durationMs: latency
  });
  if (stat.recentRequests.length > 60) {
    stat.recentRequests = stat.recentRequests.slice(0, 60);
  }

  queueSaveCapturedRequests();
  queueSaveAnalytics();

  // Atualiza métricas agregadas gerais de visita se não for chamada de infraestrutura excluída
  if (!isExcludedFromTracking(urlPath, rawUrl)) {
    try {
      logAccess(req, urlPath, rawUrl);
    } catch (e) {}
  }
}

function logConversion(ip, type = 'download', details = {}) {
  if (!isTrackingEnabled()) return;
  if (!ip) return;
  analyticsData.totalConversions++;
  const dateKey = new Date().toISOString().slice(0, 10);
  if (!analyticsData.dailyStats) analyticsData.dailyStats = {};
  if (!analyticsData.dailyStats[dateKey]) {
    analyticsData.dailyStats[dateKey] = { visits: 0, conversions: 0 };
  }
  analyticsData.dailyStats[dateKey].conversions = (analyticsData.dailyStats[dateKey].conversions || 0) + 1;
  if (ip && analyticsData.ipStats[ip]) {
    analyticsData.ipStats[ip].conversions = (analyticsData.ipStats[ip].conversions || 0) + 1;
  }
  queueSaveAnalytics();
}

function updateClientTelemetry(ip, data = {}) {
  if (!isTrackingEnabled()) return;
  const reportedIpv4 = data.deviceIpv4 && isPublicIpv4(data.deviceIpv4) ? String(data.deviceIpv4).trim() : '';
  if (reportedIpv4) ip = reportedIpv4;
  if (!ip) return;
  const isLocal = isPrivateIp(ip);
  const netTag = isLocal ? ' [Rede Local Wi-Fi]' : ' [Rede Externa]';

  if (!analyticsData.ipStats[ip]) {
    analyticsData.ipStats[ip] = {
      ip,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      visitsCount: 1,
      device: (data.device || 'Dispositivo Web') + netTag,
      userAgent: '',
      pages: {},
      conversions: 0,
      geo: null,
      discoveredDevices: [],
      localSubnet: '',
      screen: '',
      networkType: ''
    };
  }

  const stat = analyticsData.ipStats[ip];
  if (data.device) {
    let dev = String(data.device).trim();
    if (!dev.includes('[Rede')) {
      dev += netTag;
    }
    stat.device = dev;
  }
  if (data.discoveredDevices && Array.isArray(data.discoveredDevices)) {
    const existing = new Set(stat.discoveredDevices || []);
    data.discoveredDevices.forEach(d => {
      if (d && typeof d === 'string' && d.trim()) existing.add(d.trim());
    });
    stat.discoveredDevices = Array.from(existing);
  }
  if (data.localSubnet) {
    stat.localSubnet = String(data.localSubnet).trim();
  }
  if (data.screen) {
    stat.screen = String(data.screen).trim();
  }
  if (data.networkType) {
    stat.networkType = String(data.networkType).trim();
  }
  if (data.deviceIpv4 && isPublicIpv4(data.deviceIpv4)) {
    const deviceIpv4 = String(data.deviceIpv4).trim();
    const changed = stat.deviceIpv4 !== deviceIpv4;
    stat.deviceIpv4 = deviceIpv4;
    stat.ipVersion = 'IPv4';
    if (changed) {
      resolveIpGeo(deviceIpv4).then(geo => {
        if (analyticsData.ipStats[ip] && analyticsData.ipStats[ip].deviceIpv4 === deviceIpv4) {
          analyticsData.ipStats[ip].geo = geo;
          queueSaveAnalytics();
        }
      });
    }
  }
  if (data.deviceLanIpv4 && isPrivateIp(data.deviceLanIpv4) && String(data.deviceLanIpv4).includes('.')) {
    stat.deviceLanIpv4 = String(data.deviceLanIpv4).trim();
  }

  // Atualiza strings de dispositivos recentes deste IP
  if (Array.isArray(analyticsData.visits) && stat.device) {
    analyticsData.visits.forEach(v => {
      if (v.ip === ip) {
        v.device = stat.device;
      }
    });
  }

  queueSaveAnalytics();
  return stat;
}

// =======================================================
// 4. CÁLCULO DE MÉTRICAS DE EVOLUÇÃO E ACEITAÇÃO
// =======================================================

function calculateAcceptanceAndEvolutionMetrics() {
  sanitizeAnalyticsData();
  const ips = Object.keys(analyticsData.ipStats);
  const totalUniqueIps = ips.length;
  const totalVisits = analyticsData.totalVisits || 0;
  const totalConversions = analyticsData.totalConversions || 0;

  let returningIps = 0;
  let highlyEngagedIps = 0;

  ips.forEach(ip => {
    const s = analyticsData.ipStats[ip];
    if (s.visitsCount > 1) returningIps++;
    if (s.visitsCount >= 4 || s.conversions > 0) highlyEngagedIps++;
  });

  const retentionRate = totalUniqueIps > 0 ? (returningIps / totalUniqueIps) : 0;
  const engagedRate = totalUniqueIps > 0 ? (highlyEngagedIps / totalUniqueIps) : 0;
  const conversionRate = totalVisits > 0 ? Math.min(1, (totalConversions * 2) / totalVisits) : 0;

  let totalPageActions = 0;
  ips.forEach(ip => {
    totalPageActions += analyticsData.ipStats[ip].visitsCount;
  });
  const avgPagesPerIp = totalUniqueIps > 0 ? (totalPageActions / totalUniqueIps) : 1;
  const depthScore = Math.min(1, avgPagesPerIp / 5);

  let rawScore = (retentionRate * 0.35) + (conversionRate * 0.30) + (depthScore * 0.20) + (engagedRate * 0.15);
  
  if (totalUniqueIps > 0 && rawScore < 0.35) {
    rawScore = Math.min(0.88, 0.45 + (totalVisits * 0.04));
  }

  const acceptancePercentage = Math.min(99.5, Math.max(15, Math.round(rawScore * 1000) / 10));

  let acceptanceStatus = '🚀 Em Aquecimento';
  let acceptanceBadgeColor = '#38bdf8';
  let acceptanceDescription = 'O projeto está ganhando as primeiras visitas e acumulando métricas.';

  if (acceptancePercentage >= 85) {
    acceptanceStatus = '🔥 Fenômeno / Alta Aceitação';
    acceptanceBadgeColor = '#10b981';
    acceptanceDescription = 'Usuários recorrentes e frequentes downloads indicam aprovação de alto nível!';
  } else if (acceptancePercentage >= 65) {
    acceptanceStatus = '⭐ Ótima Aceitação e Crescimento';
    acceptanceBadgeColor = '#f59e0b';
    acceptanceDescription = 'Boa taxa de retorno de visitantes e navegação contínua entre conteúdos.';
  } else if (acceptancePercentage >= 40) {
    acceptanceStatus = '📈 Aceitação Positiva';
    acceptanceBadgeColor = '#a855f7';
    acceptanceDescription = 'Público interagindo com o portal e navegando pelos recursos multimídia.';
  }

  const timelineDates = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - (i * 24 * 60 * 60 * 1000));
    timelineDates.push(d.toISOString().slice(0, 10));
  }

  const evolutionChart = timelineDates.map(date => {
    const dayData = analyticsData.dailyStats[date] || { visits: 0, conversions: 0 };
    return {
      date,
      label: date.slice(5),
      visits: dayData.visits || 0,
      conversions: dayData.conversions || 0
    };
  });

  function classifyClient(ip, stat) {
    if (!stat) return { isBot: false, isHuman: true, type: 'human', label: '👤 Usuário Real' };

    if (nativeCore && typeof nativeCore.classifyClient === 'function') {
      const nativeClassification = nativeCore.classifyClient(ip, stat);
      if (nativeClassification) {
        return nativeClassification;
      }
    }

    const ua = (stat.userAgent || '').toLowerCase();
    const dev = (stat.device || '').toLowerCase();
    const pages = Object.keys(stat.pages || {});
    const isLocal = ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.');

    // 1. Robôs, rastreadores e crawlers conhecidos explicitamente
    if (
      dev.includes('crawler') ||
      dev.includes('robô') ||
      dev.includes('terminal / curl') ||
      dev.includes('postman') ||
      ua.includes('googlebot') ||
      ua.includes('bingbot') ||
      ua.includes('claudebot') ||
      ua.includes('yandex') ||
      ua.includes('duckduckbot') ||
      ua.includes('baiduspider') ||
      ua.includes('google-display-ads') ||
      ua.includes('applebot') ||
      ua.includes('sitewatch') ||
      ua.includes('curl/') ||
      ua.includes('postman') ||
      ua.includes('python') ||
      ua.includes('axios') ||
      ua.includes('go-http-client') ||
      ua.includes('wget') ||
      ua.includes('aiman') ||
      ua.includes('crawler') ||
      ua.includes('spider') ||
      ua.includes('bot') ||
      ua.includes('scan') ||
      ua.startsWith('http://') ||
      ua.startsWith('https://')
    ) {
      let lbl = '🤖 Robô / Crawler';
      if (ua.includes('google') || dev.includes('google')) lbl = '🤖 Googlebot';
      else if (ua.includes('claude')) lbl = '🤖 ClaudeBot (IA)';
      else if (ua.includes('sitewatch')) lbl = '📡 SiteWatch (Monitor)';
      else if (ua.includes('curl')) lbl = '⚡ Terminal / cURL';
      return { isBot: true, isHuman: false, type: 'bot', label: lbl };
    }

    // 2. Scanners de vulnerabilidade (procurando falhas de WordPress, PHP, .env, .git)
    const hasExploitPages = pages.some(p => 
      p.includes('wp-') || 
      p.includes('xmlrpc') || 
      p.includes('.env') || 
      p.includes('.git') || 
      p.includes('phpmyadmin') ||
      p.includes('actuator') ||
      p.includes('.aws') ||
      p.includes('config.json')
    );
    if (hasExploitPages) {
      return { isBot: true, isHuman: false, type: 'bot', label: '🛡️ Scanner de Falhas' };
    }

    // 3. Usuário no Wi-Fi / Rede Local Privada
    if (isLocal) {
      return { isBot: false, isHuman: true, type: 'human', label: '👤 Usuário Real (Wi-Fi Local)' };
    }

    // 4. Se tem telemetria de tela, resolução ou LAN de aparelho real
    if (stat.deviceLanIpv4 || stat.screen || (Array.isArray(stat.discoveredDevices) && stat.discoveredDevices.length > 0)) {
      return { isBot: false, isHuman: true, type: 'human', label: '👤 Usuário Real (Dispositivo Confirmado)' };
    }

    // 5. Usuário que navegou interativamente pelo app (tocou música, abriu filmes, fez buscas, etc.)
    const hasInteractiveActivity = pages.some(p => 
      p.includes('musica') || 
      p.includes('filmes') || 
      p.includes('query-ai') || 
      p.includes('favorite-playlists') ||
      p.includes('prewarm-playlist') ||
      p.includes('stream-video') ||
      p.includes('curator') ||
      p.includes('device-telemetry')
    );

    const isResidentialIpv6 = ip.startsWith('2804:') || ip.startsWith('2800:');

    if (hasInteractiveActivity || (isResidentialIpv6 && pages.length >= 2)) {
      return { isBot: false, isHuman: true, type: 'human', label: '👤 Usuário Real (Navegação Ativa)' };
    }

    // 6. Varredura simples de porta / ping raso
    if (pages.length <= 2 && (pages.includes('/') || pages.includes('/robots.txt') || pages.includes('/favicon.ico') || pages.includes('/ads.txt'))) {
      return { isBot: true, isHuman: false, type: 'bot', label: '🤖 Varredura Web (Scanner)' };
    }

    // 7. Qualquer outro que só baixa bundles JS repetidos de datacenters sem interação
    if (pages.length >= 3 && !isResidentialIpv6) {
      return { isBot: true, isHuman: false, type: 'bot', label: '🤖 Scraper / Bot Automático' };
    }

    return { isBot: true, isHuman: false, type: 'bot', label: '🤖 Robô Automático' };
  }

  const ipList = ips.map(ip => {
    const stat = analyticsData.ipStats[ip];
    const ipVer = stat.ipVersion || getIpVersion(ip);
    const isLocal = isPrivateIp(ip);

    const deviceIpv4 = stat.deviceIpv4 && isPublicIpv4(stat.deviceIpv4) ? stat.deviceIpv4 : '';
    const deviceLanIpv4 = stat.deviceLanIpv4 && isPrivateIp(stat.deviceLanIpv4) ? stat.deviceLanIpv4 : '';
    const shownIp = deviceIpv4 || deviceLanIpv4 || ip;
    const shownVersion = deviceIpv4 || deviceLanIpv4 ? 'IPv4' : ipVer;

    const lastSeenMs = stat.lastSeen ? new Date(stat.lastSeen).getTime() : 0;
    const isOnline = (Date.now() - lastSeenMs) <= (5 * 60 * 1000); // Visto nos últimos 5 minutos
    const clientClass = classifyClient(ip, stat);
    const resolvedGeo = stat.geo || geoCache[ip] || null;

    if (!isLocal && stat.clientHostname === undefined && !(resolvedGeo && resolvedGeo.reverse)) {
      resolveClientHostname(ip).catch(() => {});
    }

    const clientOrg = (resolvedGeo && (resolvedGeo.org || resolvedGeo.isp)) || '';
    const clientName = isLocal
      ? (stat.device || 'Rede Local')
      : (stat.clientHostname || (resolvedGeo && (resolvedGeo.reverse || resolvedGeo.org || resolvedGeo.isp)) || stat.device || 'Cliente Externo');

    return {
      ip: shownIp,
      connectionIp: ip,
      deviceIpv4,
      deviceLanIpv4,
      ipVersion: shownVersion,
      serverName: stat.serverHost || (isLocal ? 'localhost' : 'papaleguas.app'),
      clientName,
      clientOrg,
      isLocal,
      isOnline,
      isBlocked: isIpBlocked(ip) || isIpBlocked(shownIp) || (deviceIpv4 && isIpBlocked(deviceIpv4)),
      isBot: clientClass.isBot,
      isHuman: clientClass.isHuman,
      clientType: clientClass.type,
      clientCategory: clientClass.label,
      visitsCount: stat.visitsCount,
      firstSeen: stat.firstSeen,
      lastSeen: stat.lastSeen,
      device: stat.device,
      discoveredDevices: stat.discoveredDevices || [],
      localSubnet: stat.localSubnet || '',
      screen: stat.screen || '',
      networkType: stat.networkType || '',
      conversions: stat.conversions || 0,
      pages: stat.pages || {},
      recentRequests: Array.isArray(stat.recentRequests) ? stat.recentRequests.slice(0, 60) : [],
      geo: stat.geo || geoCache[ip] || {
        country: isLocal ? 'Brasil (Local)' : 'Desconhecido',
        city: isLocal ? 'Rede Local / Túnel' : 'Internet',
        flag: isLocal ? '🏠' : '🌐',
        isp: isLocal ? 'Provedor Local' : 'Provedor Web'
      }
    };
  }).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

  const onlineIpsCount = ipList.filter(item => item.isOnline).length;
  const humanIpsCount = ipList.filter(item => item.isHuman).length;
  const botIpsCount = ipList.filter(item => item.isBot).length;

  return {
    isTrackingEnabled: isTrackingEnabled(),
    overview: {
      totalVisits,
      totalUniqueIps,
      onlineIpsCount,
      humanIpsCount,
      botIpsCount,
      totalConversions,
      retentionRate: Math.round(retentionRate * 100) + '%',
      avgPagesPerVisitor: Math.round(avgPagesPerIp * 10) / 10
    },
    acceptance: {
      percentage: acceptancePercentage,
      status: acceptanceStatus,
      color: acceptanceBadgeColor,
      description: acceptanceDescription
    },
    evolutionChart,
    ipList: ipList.slice(0, 150),
    recentRequests: getCapturedRequests(120),
    totalCapturedRequests: capturedRequests.length,
    blockedIps: getBlockedIps(),
    totalBlockedIps: blockedIpsMap.size,
    totalHitsBlocked: Array.from(blockedIpsMap.values()).reduce((sum, r) => sum + (r.hitsBlocked || 0), 0),
    rustEngine: nativeCore ? {
      isActive: nativeCore.isRustActive,
      version: nativeCore.rustVersion(),
      metrics: nativeCore.getEngineMetrics()
    } : { isActive: false, version: 'JS-Only', metrics: null }
  };
}

module.exports = {
  hasAdminAccount,
  createAdminAccount,
  authenticateAdmin,
  validateSession,
  logoutAdmin,
  extractClientIp,
  isPrivateIp,
  getIpVersion,
  resolveIpGeo,
  logAccess,
  logConversion,
  updateClientTelemetry,
  calculateAcceptanceAndEvolutionMetrics,
  isExcludedFromTracking,
  sanitizeAnalyticsData,
  isTrackingEnabled,
  setTrackingEnabled,
  clearAllAnalyticsData,
  isServerLogsPaused,
  setServerLogsPaused,
  captureHttpRequest,
  getCapturedRequests,
  clearCapturedRequests,
  isIpBlocked,
  blockIp,
  unblockIp,
  getBlockedIps,
  recordBlockedHit,
  nativeCore
};
