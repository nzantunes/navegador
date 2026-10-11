// =========================================================================
// PAPALÉGUAS - MÓDULO MODULAR DE ROTAS: MÚSICA & DJ PAPALÉGUAS
// =========================================================================
// Responsável pelas rotas da Central de Música, DJ de IA, Playlists
// e recomendações musicais personalizadas por cliente e país.

/**
 * Manipulador principal do módulo de Música.
 * Retorna true se a requisição foi tratada, ou false caso pertença a outro módulo.
 */
async function handle(req, res, ctx) {
  const { reqUrl, pathname, body = {} } = ctx;

  // -----------------------------------------------------------------------
  // 1. RECOMENDAÇÕES MUSICAIS POR IA (/api/recommendations)
  // -----------------------------------------------------------------------
  if (pathname === '/api/recommendations') {
    const q = body.query || reqUrl.searchParams.get('q') || '';
    const cat = body.category || reqUrl.searchParams.get('cat') || 'all';
    const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || body.clientId || 'client_default';
    const clientSession = ctx.getOrCreateClientSession(clientId);

    const clientExclude = clientSession && clientSession.playedTrackTitles ? Array.from(clientSession.playedTrackTitles) : [];
    const inputExclude = body.excludeTitles || [];
    const exclude = Array.from(new Set([...clientExclude, ...inputExclude]));

    const countryParam = body.country || reqUrl.searchParams.get('country') || 'BR';
    const result = await ctx.getAiMusicRecommendations(q, cat, exclude, countryParam);

    if (result && result.success && Array.isArray(result.results) && clientSession && clientSession.playedTrackTitles) {
      result.results.forEach(tr => {
        if (tr.title) clientSession.playedTrackTitles.add(tr.title.trim().toLowerCase());
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return true;
  }

  // -----------------------------------------------------------------------
  // 2. CHAT COM O DJ PAPALÉGUAS (/api/dj-chat)
  // -----------------------------------------------------------------------
  if (pathname === '/api/dj-chat') {
    const message = body.userMessage || '';
    const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || body.clientId || 'client_default';
    const clientSession = ctx.getOrCreateClientSession(clientId);

    const history = (body.history && body.history.length > 0) ? body.history : (clientSession ? clientSession.djChatHistory : []);
    const clientExclude = clientSession && clientSession.playedTrackTitles ? Array.from(clientSession.playedTrackTitles) : [];
    const inputExclude = body.excludeTitles || [];
    const exclude = Array.from(new Set([...clientExclude, ...inputExclude]));

    const result = await ctx.chatDjPapaleguas(message, history, exclude, body.trackCount);

    if (result && result.success && clientSession) {
      if (Array.isArray(clientSession.djChatHistory)) {
        clientSession.djChatHistory.push({ role: 'user', content: message });
        if (result.reply) clientSession.djChatHistory.push({ role: 'dj', content: result.reply });
      }
      if (Array.isArray(result.results) && clientSession.playedTrackTitles) {
        result.results.forEach(tr => {
          if (tr.title) clientSession.playedTrackTitles.add(tr.title.trim().toLowerCase());
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return true;
  }

  // -----------------------------------------------------------------------
  // 3. PRÉ-AQUECIMENTO DE PLAYLIST (/api/prewarm-playlist)
  // -----------------------------------------------------------------------
  if (pathname === '/api/prewarm-playlist' && req.method === 'POST') {
    const list = Array.isArray(body.tracks) ? body.tracks.slice(0, 12) : [];
    let running = 0;
    const queue = list.filter((t) => t && t.title);
    const next = () => {
      while (running < 2 && queue.length) {
        const t = queue.shift();
        running += 1;
        if (typeof ctx.getFullAudioStream === 'function') {
          ctx.getFullAudioStream({ title: String(t.title), artist: String(t.artist || '') })
            .catch(() => null)
            .then(() => { running -= 1; next(); });
        } else {
          running -= 1;
        }
      }
    };
    next();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, queued: list.length }));
    return true;
  }

  // -----------------------------------------------------------------------
  // 4. PESQUISA DE PLAYLISTS E BUSCA GERAL DEEZER (/api/playlists, /api/all)
  // -----------------------------------------------------------------------
  if (pathname === '/api/playlists') {
    const q = reqUrl.searchParams.get('q') || body.q || '';
    if (typeof ctx.searchDeezerPlaylists === 'function') {
      const result = await ctx.searchDeezerPlaylists(q);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
      return true;
    }
  }

  if (pathname === '/api/all') {
    const q = reqUrl.searchParams.get('q') || body.q || '';
    if (typeof ctx.searchDeezerAll === 'function') {
      const result = await ctx.searchDeezerAll(q);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
      return true;
    }
  }

  return false;
}

module.exports = {
  handle
};
