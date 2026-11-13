/**
 * Papaléguas Native Engine Bridge v2.0 (Rust + Node-API)
 * Fornece aceleração nativa em Rust para:
 * - Motor de Busca e Indexador Próprio (BM25 + Inverted Index em memória + persistência)
 * - Extrator ultrarrápido de metadados HTML e links Web / .onion (Spider/Crawler)
 * - Sanitizador de URLs anti-rastreamento (remove utm_*, fbclid, gclid, etc.)
 * - Bloqueador de domínios de anúncios e trackers em nanossegundos
 * - Classificador Bot vs Humano e Token Bucket Rate Limiter
 */

const path = require('path');
const fs = require('fs');

let rustCore = null;
let isRustActive = false;

const INDEX_FILE_PATH = path.join(__dirname, '..', 'papaleguas', 'data', 'rust_search_index.json');

try {
  const binaryPath = path.join(__dirname, '..', 'papaleguas-core', 'papaleguas_core.node');
  if (fs.existsSync(binaryPath)) {
    rustCore = require(binaryPath);
    isRustActive = true;
    console.log('[RUST ENGINE] ⚡ Motor nativo Papaléguas Core ativo e operacional:', rustCore.rustVersion());
    if (typeof rustCore.loadSearchIndex === 'function') {
      try {
        const dir = path.dirname(INDEX_FILE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(INDEX_FILE_PATH)) {
          const loaded = rustCore.loadSearchIndex(INDEX_FILE_PATH);
          if (loaded > 0) {
            console.log(`[RUST ENGINE] 📚 Índice de busca próprio carregado: ${loaded} páginas prontas em memória.`);
          }
        }
      } catch (err) {}
    }
  } else {
    console.warn('[RUST ENGINE] Binário nativo não encontrado em:', binaryPath, '- operando com fallback JS.');
  }
} catch (e) {
  console.warn('[RUST ENGINE] Falha ao inicializar módulo nativo Rust:', e.message, '- operando com fallback JS.');
  rustCore = null;
  isRustActive = false;
}

// -------------------------------------------------------------
// Fallback JavaScript puro se o Rust não estiver disponível
// -------------------------------------------------------------
function jsIsPrivateIp(ip) {
  if (!ip) return false;
  let clean = String(ip).trim().replace(/^::ffff:/, '');
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost' || clean.startsWith('127.')) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  const match172 = clean.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (match172) {
    const s = parseInt(match172[1], 10);
    if (s >= 16 && s <= 31) return true;
  }
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  const lower = clean.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;
  return false;
}

const jsTokenBucket = new Map();
function jsCheckRateLimit(ip, maxBurst = 120, refillPerSec = 20) {
  const now = Date.now();
  if (jsTokenBucket.size > 2000) {
    jsTokenBucket.clear();
  }
  let bucket = jsTokenBucket.get(ip);
  if (!bucket) {
    bucket = { tokens: maxBurst, last: now };
    jsTokenBucket.set(ip, bucket);
  }
  const elapsedSec = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(maxBurst, bucket.tokens + elapsedSec * refillPerSec);
  bucket.last = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

let pendingSaveTimer = null;
function scheduleIndexSave() {
  if (!isRustActive || !rustCore || typeof rustCore.saveSearchIndex !== 'function') return;
  if (pendingSaveTimer) return;
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    try {
      const dir = path.dirname(INDEX_FILE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      rustCore.saveSearchIndex(INDEX_FILE_PATH);
    } catch (e) {}
  }, 5000);
  if (typeof pendingSaveTimer.unref === 'function') pendingSaveTimer.unref();
}

// -------------------------------------------------------------
// API Exportada com Aceleração Rust v2.0
// -------------------------------------------------------------
module.exports = {
  isRustActive,
  INDEX_FILE_PATH,

  rustVersion() {
    return isRustActive && rustCore ? rustCore.rustVersion() : 'Papaleguas JS Core (Fallback)';
  },

  getEngineMetrics() {
    if (isRustActive && rustCore) {
      try {
        return rustCore.getEngineMetrics();
      } catch (e) {}
    }
    return {
      version: 'JS-Fallback',
      active_rate_limit_entries: jsTokenBucket.size,
      blocked_tracker_domains_count: 0,
      rust_uptime_secs: 0,
      indexed_documents_count: 0,
      indexed_terms_count: 0,
      cleaned_urls_count: 0,
      queries_served_count: 0
    };
  },

  isPrivateIp(ip) {
    if (isRustActive && rustCore) {
      try {
        return Boolean(rustCore.isPrivateIp(String(ip || '')));
      } catch (e) {}
    }
    return jsIsPrivateIp(ip);
  },

  isSafeProxyHost(host) {
    if (isRustActive && rustCore) {
      try {
        return Boolean(rustCore.isSafeProxyHost(String(host || '')));
      } catch (e) {}
    }
    const clean = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!clean || clean === 'localhost' || clean === '0.0.0.0' || clean === '::1' || clean === '169.254.169.254') return false;
    return !jsIsPrivateIp(clean);
  },

  isTrackerOrAd(url) {
    if (isRustActive && rustCore) {
      try {
        return Boolean(rustCore.isTrackerOrAd(String(url || '')));
      } catch (e) {}
    }
    const lower = String(url || '').toLowerCase();
    return lower.includes('doubleclick.net') || lower.includes('google-analytics.com') || lower.includes('adnxs.com') || lower.includes('criteo.com');
  },

  stripTrackingParams(url) {
    if (isRustActive && rustCore && typeof rustCore.stripTrackingParams === 'function') {
      try {
        return rustCore.stripTrackingParams(String(url || ''));
      } catch (e) {}
    }
    return String(url || '');
  },

  cleanHtmlText(html) {
    if (isRustActive && rustCore && typeof rustCore.cleanHtmlText === 'function') {
      try {
        return rustCore.cleanHtmlText(String(html || ''));
      } catch (e) {}
    }
    return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  },

  extractPageMetadataAndLinks(baseUrl, html) {
    if (isRustActive && rustCore && typeof rustCore.extractPageMetadataAndLinks === 'function') {
      try {
        const res = rustCore.extractPageMetadataAndLinks(String(baseUrl || ''), String(html || ''));
        scheduleIndexSave();
        return res;
      } catch (e) {}
    }
    return { title: '', description: '', textExcerpt: '', links: [], onionLinks: [] };
  },

  indexDocument(url, title, snippet = '', extraBody = '', category = 'web') {
    if (isRustActive && rustCore && typeof rustCore.indexDocument === 'function') {
      try {
        const ok = Boolean(rustCore.indexDocument(
          String(url || ''),
          String(title || ''),
          String(snippet || ''),
          String(extraBody || ''),
          String(category || 'web')
        ));
        if (ok) scheduleIndexSave();
        return ok;
      } catch (e) {}
    }
    return false;
  },

  indexDocumentsBatch(docs) {
    if (isRustActive && rustCore && typeof rustCore.indexDocumentsBatch === 'function' && Array.isArray(docs) && docs.length > 0) {
      try {
        const payload = JSON.stringify(docs.map((d) => ({
          url: String(d.url || ''),
          title: String(d.title || ''),
          snippet: String(d.snippet || ''),
          source: String(d.source || 'web')
        })));
        const count = rustCore.indexDocumentsBatch(payload);
        if (count > 0) scheduleIndexSave();
        return count;
      } catch (e) {}
    }
    return 0;
  },

  searchLocalIndex(query, limit = 25, onlyOnion = false) {
    if (isRustActive && rustCore && typeof rustCore.searchLocalIndex === 'function') {
      try {
        return rustCore.searchLocalIndex(String(query || ''), Number(limit) || 25, Boolean(onlyOnion)) || [];
      } catch (e) {}
    }
    return [];
  },

  saveSearchIndexNow() {
    if (isRustActive && rustCore && typeof rustCore.saveSearchIndex === 'function') {
      try {
        const dir = path.dirname(INDEX_FILE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return Boolean(rustCore.saveSearchIndex(INDEX_FILE_PATH));
      } catch (e) {}
    }
    return false;
  },

  detectOsPlatform(userAgent = '', secChPlatform = '') {
    if (isRustActive && rustCore && typeof rustCore.detectOsPlatform === 'function') {
      try {
        return rustCore.detectOsPlatform(String(userAgent || ''), String(secChPlatform || ''));
      } catch (e) {}
    }
    const ua = String(userAgent || '').toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) {
      return { osId: 'ios', osName: 'iPhone / iPad (iOS)', shortLabel: 'Baixar App iOS', icon: '🍎', downloadUrl: '/download/app?os=ios', fileName: 'Papaleguas-iOS.mobileconfig', badge: 'WebClip Nativo iOS • Tela Cheia', isMobile: true };
    }
    if (/android/.test(ua)) {
      return { osId: 'android', osName: 'Android (Smartphone / Tablet / TV)', shortLabel: 'Baixar App Android', icon: '🤖', downloadUrl: '/download/app?os=android', fileName: 'Papaleguas-Android-Installer.html', badge: 'App Nativo Android • Sem Anúncios', isMobile: true };
    }
    if (/linux|x11|ubuntu/.test(ua)) {
      return { osId: 'linux', osName: 'Linux (Ubuntu / Debian / Mint / 64-bit)', shortLabel: 'Baixar p/ Linux', icon: '🐧', downloadUrl: '/download/app?os=linux', fileName: 'instalar-papaleguas-linux.sh', badge: 'Instalador Nativo Linux', isMobile: false };
    }
    return { osId: 'windows', osName: 'Windows 10 / 11 (64-bit)', shortLabel: 'Baixar p/ Windows', icon: '🪟', downloadUrl: '/download/app?os=windows', fileName: 'Instalar-Papaleguas-Windows.cmd', badge: 'Instalador Desktop Windows', isMobile: false };
  },

  checkRateLimit(ip, maxBurst = 120, refillPerSec = 20) {
    if (isRustActive && rustCore) {
      try {
        return Boolean(rustCore.checkRateLimit(String(ip || ''), maxBurst, refillPerSec));
      } catch (e) {}
    }
    return jsCheckRateLimit(ip, maxBurst, refillPerSec);
  },

  classifyClient(ip, stat) {
    if (isRustActive && rustCore && stat) {
      try {
        const pagesJson = JSON.stringify(Object.keys(stat.pages || {}));
        const hasLanOrScreen = Boolean(
          stat.deviceLanIpv4 ||
          stat.screen ||
          (Array.isArray(stat.discoveredDevices) && stat.discoveredDevices.length > 0)
        );
        const isLocal = isRustActive ? rustCore.isPrivateIp(String(ip || '')) : jsIsPrivateIp(ip);
        
        const res = rustCore.classifyClient(
          String(ip || ''),
          String(stat.userAgent || ''),
          String(stat.device || ''),
          pagesJson,
          isLocal,
          hasLanOrScreen
        );

        return {
          isBot: Boolean(res.isBot),
          isHuman: Boolean(res.isHuman),
          type: res.clientType,
          label: res.label,
          riskScore: res.riskScore || 0
        };
      } catch (e) {
        // Fallback para lógica JS em caso de erro de serialização
      }
    }

    return null;
  }
};
