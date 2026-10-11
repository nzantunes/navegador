// =========================================================================
// PAPALÉGUAS - REGISTRO E DESPACHANTE CENTRAL DE ROTAS MODULARES
// =========================================================================
// Encaminha requisições HTTP para os submódulos específicos:
// - routes/curator.js (Curador, recomendações da Home, detecção de país, trending)
// - routes/youtube.js (Streaming BaixaTube, downloads MP4/MP3, jobs yt-dlp)
// - routes/musica.js  (Central de Música, DJ de IA, playlists e Deezer)

const curatorRoutes = require('./curator');
const youtubeRoutes = require('./youtube');
const musicaRoutes = require('./musica');

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

  return false;
}

module.exports = {
  handle,
  curator: curatorRoutes,
  youtube: youtubeRoutes,
  musica: musicaRoutes
};
