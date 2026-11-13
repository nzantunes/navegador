// =========================================================================
// PAPALÉGUAS - REGISTRO E DESPACHANTE CENTRAL DE ROTAS MODULARES
// =========================================================================
// Encaminha requisições HTTP para os submódulos específicos:
// - routes/curator.js (Curador, recomendações da Home, detecção de país, trending)
// - routes/youtube.js (Streaming BaixaTube, downloads MP4/MP3, jobs yt-dlp)
// - routes/musica.js  (Central de Música, DJ de IA, playlists e Deezer)

const fs = require('fs');
const path = require('path');
const { swallowed } = require('../logger');

let curatorRoutes = require('./curator');
let youtubeRoutes = require('./youtube');
let musicaRoutes = require('./musica');
let seoFeedsRoutes = require('./seo-feeds');
let adminRoutes = require('./admin');

const routeFiles = {
  curator: { path: path.join(__dirname, 'curator.js'), mtime: 0 },
  youtube: { path: path.join(__dirname, 'youtube.js'), mtime: 0 },
  musica: { path: path.join(__dirname, 'musica.js'), mtime: 0 },
  seoFeeds: { path: path.join(__dirname, 'seo-feeds.js'), mtime: 0 },
  admin: { path: path.join(__dirname, 'admin.js'), mtime: 0 }
};

function getFreshModule(key, currentMod) {
  try {
    const info = routeFiles[key];
    const stat = fs.statSync(info.path);
    if (info.mtime && stat.mtimeMs > info.mtime) {
      delete require.cache[require.resolve(info.path)];
      info.mtime = stat.mtimeMs;
      return require(info.path);
    }
    info.mtime = stat.mtimeMs;
  } catch (e) { swallowed(e, 'index:getFreshModule@33'); }
  return currentMod;
}

/**
 * Despacha a requisição HTTP para o primeiro módulo que corresponder ao pathname.
 * Retorna true se a requisição foi tratada e finalizada por algum módulo,
 * ou false caso nenhuma rota modular coincida (permitindo ao servidor continuar).
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Object} ctx Contexto de execução com dependências e helpers
 * @returns {Promise<boolean>}
 */
async function handle(req, res, ctx) {
  curatorRoutes = getFreshModule('curator', curatorRoutes);
  youtubeRoutes = getFreshModule('youtube', youtubeRoutes);
  musicaRoutes = getFreshModule('musica', musicaRoutes);

  // 0. Checagem de Saúde e Monitoramento Operacional (/health, /api/health)
  if (ctx.pathname === '/health' || ctx.pathname === '/api/health') {
    const mem = process.memoryUsage();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    res.end(JSON.stringify({
      status: 'ok',
      version: '2026.11.04-v103',
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024)
      },
      torActive: typeof ctx.isTorRoutingEnabled === 'function' ? ctx.isTorRoutingEnabled() : false,
      app: 'Papaleguas Browser & BaixaTube',
      officialDomain: 'https://papaleguas.app'
    }));
    return true;
  }

  // 1. Rotas do Curador & Feed da Home
  if (await curatorRoutes.handle(req, res, ctx)) {
    return true;
  }

  // 2. Rotas do YouTube & BaixaTube Streaming/Downloads
  if (await youtubeRoutes.handle(req, res, ctx)) {
    return true;
  }

  // 3. Rotas da Central de Música & DJ Papaléguas
  if (await musicaRoutes.handle(req, res, ctx)) {
    return true;
  }

  // 4. Rotas Administrativas & Telegram Bot
  adminRoutes = getFreshModule('admin', adminRoutes);
  if (await adminRoutes.handle(req, res, ctx)) {
    return true;
  }

  return false;
}

async function handlePublicMeta(req, res, ctx) {
  seoFeedsRoutes = getFreshModule('seoFeeds', seoFeedsRoutes);
  return seoFeedsRoutes.handlePublicMeta(req, res, ctx);
}

module.exports = {
  handle,
  handlePublicMeta,
  curator: curatorRoutes,
  youtube: youtubeRoutes,
  musica: musicaRoutes,
  seoFeeds: seoFeedsRoutes,
  admin: adminRoutes
};
