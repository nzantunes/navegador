const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const GEO_CACHE_FILE = path.join(DATA_DIR, 'geo_cache.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

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

function sanitizeAnalyticsData() {
  if (!analyticsData) return;
  let changed = false;

  // 1. Privacidade total: remove qualquer rastreamento de páginas / URLs
  if (analyticsData.pageStats && Object.keys(analyticsData.pageStats).length > 0) {
    analyticsData.pageStats = {};
    changed = true;
  }

  // 2. Limpa histórico de requisições de URLs
  if (Array.isArray(analyticsData.visits) && analyticsData.visits.length > 0) {
    analyticsData.visits = [];
    changed = true;
  }

  // 3. Limpa ipStats removendo páginas, urls e recentUrls
  if (analyticsData.ipStats) {
    for (const ip of Object.keys(analyticsData.ipStats)) {
      const stat = analyticsData.ipStats[ip];
      if (stat) {
        if (stat.pages) {
          delete stat.pages;
          changed = true;
        }
        if (stat.urls) {
          delete stat.urls;
          changed = true;
        }
        if (stat.recentUrls) {
          delete stat.recentUrls;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    try {
      fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analyticsData, null, 2), 'utf8');
      console.log(`[ANALYTICS SANITIZE] Privacidade total aplicada: URLs expurgadas com sucesso.`);
    } catch (e) {
      console.warn('[ANALYTICS SANITIZE ERR]', e.message);
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
    fs.promises.writeFile(ANALYTICS_FILE, payload, 'utf8')
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
    const url = `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,regionName,city,lat,lon,isp`;
    const req = http.get(url, { timeout: 3500 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'success') {
            const flag = getFlagEmoji(json.countryCode);
            const info = {
              ip,
              country: json.country || 'Desconhecido',
              countryCode: json.countryCode || 'XX',
              flag,
              city: json.city || 'Desconhecida',
              region: json.regionName || '',
              isp: json.isp || 'Provedor Desconhecido',
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

  analyticsData.totalVisits++;

  if (!analyticsData.dailyStats[dateKey]) {
    analyticsData.dailyStats[dateKey] = { visits: 0, conversions: 0 };
  }
  analyticsData.dailyStats[dateKey].visits++;

  if (!analyticsData.ipStats[ip]) {
    analyticsData.ipStats[ip] = {
      ip,
      ipVersion: ipVer,
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
  if (!stat.ipVersion) stat.ipVersion = ipVer;

  queueSaveAnalytics();
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

    return {
      ip: shownIp,
      connectionIp: ip,
      deviceIpv4,
      deviceLanIpv4,
      ipVersion: shownVersion,
      isLocal,
      isOnline,
      visitsCount: stat.visitsCount,
      firstSeen: stat.firstSeen,
      lastSeen: stat.lastSeen,
      device: stat.device,
      discoveredDevices: stat.discoveredDevices || [],
      localSubnet: stat.localSubnet || '',
      screen: stat.screen || '',
      networkType: stat.networkType || '',
      conversions: stat.conversions || 0,
      geo: stat.geo || geoCache[ip] || {
        country: isLocal ? 'Brasil (Local)' : 'Desconhecido',
        city: isLocal ? 'Rede Local / Túnel' : 'Internet',
        flag: isLocal ? '🏠' : '🌐',
        isp: isLocal ? 'Provedor Local' : 'Provedor Web'
      }
    };
  }).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

  const onlineIpsCount = ipList.filter(item => item.isOnline).length;

  return {
    isTrackingEnabled: isTrackingEnabled(),
    overview: {
      totalVisits,
      totalUniqueIps,
      onlineIpsCount,
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
    ipList: ipList.slice(0, 150)
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
  setServerLogsPaused
};
