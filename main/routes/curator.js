// =========================================================================
// PAPALÉGUAS - MÓDULO MODULAR DE ROTAS: CURATOR & RECOMENDAÇÕES
// =========================================================================
// Responsável pelas rotas de curadoria inteligente de conteúdo,
// detecção de país e tendências (trending / recent) para o BaixaTube e Home.

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

/**
 * Manipulador principal do módulo de Curadoria.
 * Retorna true se a requisição foi tratada, ou false caso pertença a outro módulo.
 */
async function handle(req, res, ctx) {
  const { reqUrl, pathname, body = {} } = ctx;

  // -----------------------------------------------------------------------
  // 1. RECOMENDAÇÕES INTELIGENTES DO CURADOR (/api/curator-recommendations)
  // -----------------------------------------------------------------------
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
    const clientSession = ctx.getOrCreateClientSession(clientId);
    // YouTube scraping e recomendações utilizam conexão direta ultrarrápida (sem proxy Tor para evitar lentidão e bloqueios do YouTube)
    const useTor = false;

    const clientIpParam = reqUrl.searchParams.get('deviceIp') || (body && body.deviceIp) || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
    const clientIp = ctx.extractRequestDeviceIp(req, clientIpParam);

    const clientCountryParam = (body && body.country) || reqUrl.searchParams.get('country') || '';
    let countryCode;
    if (clientCountryParam && /^[A-Z]{2}$/i.test(clientCountryParam)) {
      countryCode = clientCountryParam.toUpperCase();
    } else {
      countryCode = await ctx.getClientCountryCode(req, clientIp, false).catch(() => 'BR');
    }

    const result = await ctx.getAiCuratorSuggestions({
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

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return true;
  }

  // -----------------------------------------------------------------------
  // 2. DETECÇÃO DE PAÍS DO CLIENTE (/api/country-detect)
  // -----------------------------------------------------------------------
  if (pathname === '/api/country-detect') {
    try {
      const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
      const clientSession = ctx.getOrCreateClientSession(clientId);
      const useTor = ctx.isTorRoutingEnabled(clientSession);
      const clientIpParam = reqUrl.searchParams.get('deviceIp') || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
      const clientIp = ctx.extractRequestDeviceIp(req, clientIpParam);
      const country = await ctx.getClientCountryCode(req, clientIp, false);
      let effectiveIp = clientIp;
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
    return true;
  }

  // -----------------------------------------------------------------------
  // 3. VÍDEOS EM ALTA & RECENTES (/api/youtube-trending, /api/youtube-recent)
  // -----------------------------------------------------------------------
  if (pathname === '/api/youtube-trending' || pathname === '/api/youtube-recent') {
    if (reqUrl.searchParams.get('refresh') === '1') {
      if (ctx.caches && ctx.caches.mixedNewsCache) {
        ctx.caches.mixedNewsCache = null;
        ctx.caches.mixedNewsCacheTime = 0;
      }
      if (ctx.caches && ctx.caches.youtubeSearchCache) {
        ctx.caches.youtubeSearchCache.clear();
      }
    }
    const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
    const clientSession = ctx.getOrCreateClientSession(clientId);
    // Buscas e recomendações do YouTube saem direto (sem Tor) na velocidade máxima da internet
    const useTor = false;
    const qParam = reqUrl.searchParams.get('q') || '';
    const clientCountryParam = reqUrl.searchParams.get('country') || '';
    const clientIpParam = reqUrl.searchParams.get('deviceIp') || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
    const clientIp = ctx.extractRequestDeviceIp(req, clientIpParam);

    let countryCode;
    if (clientCountryParam && /^[A-Z]{2}$/i.test(clientCountryParam) && clientCountryParam.toUpperCase() !== 'AUTO') {
      countryCode = clientCountryParam.toUpperCase();
    } else {
      countryCode = await ctx.getClientCountryCode(req, clientIp, false).catch(() => 'BR');
    }

    const hl = ctx.getHlForCountry(countryCode);
    const effectiveClientIp = useTor ? '' : clientIp;

    const forceCustom = reqUrl.searchParams.get('custom') === '1' || (qParam && qParam.trim().split(/\s+/).length > 2);
    const pageParam = parseInt(reqUrl.searchParams.get('page') || '1', 10);
    let { query: dynamicQuery, sortByRecent, isCustomQuery, searchMode } = ctx.getDynamicRecentYoutubeQuery(qParam || 'noticias', forceCustom, countryCode);
    if (pageParam > 1) {
      const rotated = ctx.rotateThemeSearchQueries(qParam || 'noticias', pageParam, countryCode);
      if (rotated.queries && rotated.queries[0]) dynamicQuery = rotated.queries[0];
      if (rotated.searchMode) searchMode = rotated.searchMode;
      sortByRecent = true;
    }
    let timeFilter = reqUrl.searchParams.get('time') || 'none';
    const isNews = ctx.isNewsYoutubeCategory(qParam || 'noticias');
    if (isNews) {
      if (!reqUrl.searchParams.has('time')) timeFilter = 'hour';
    }
    
    if (isCustomQuery && (timeFilter === 'hour' || timeFilter === 'day')) {
      timeFilter = 'none';
    }
    if (searchMode === 'trending' && (timeFilter === 'hour' || !timeFilter)) {
      timeFilter = 'week';
    }
    if (searchMode === 'podcast' && (timeFilter === 'hour' || timeFilter === 'day')) {
      timeFilter = 'week';
    }

    let videos = [];
    const feedWait = useTor ? 16000 : 7000;
    try {
      if (!isCustomQuery && searchMode === 'trending') {
        videos = await Promise.race([
          ctx.fetchTrendingVideos({ useTor, country: countryCode, clientIp: effectiveClientIp }).catch(() => []),
          new Promise((resolve) => setTimeout(() => resolve([]), feedWait))
        ]);
        if (!videos || videos.length < 6) {
          const extra = await ctx.searchYoutubeVideos(dynamicQuery, hl, false, timeFilter, useTor, 'trending', countryCode, effectiveClientIp).catch(() => []);
          const seen = new Set((videos || []).map((v) => v && v.id));
          for (const v of extra || []) {
            if (v && v.id && !seen.has(v.id)) {
              seen.add(v.id);
              videos.push(v);
            }
          }
          videos = ctx.filterYoutubeModeResults(videos, 'trending');
        }
      } else {
        videos = await ctx.searchYoutubeVideos(dynamicQuery, hl, sortByRecent, timeFilter, useTor, searchMode, countryCode, effectiveClientIp).catch(() => []);
      }
    } catch (errFeed) {
      videos = [];
    }

    if (!videos || videos.length === 0) {
      const fallbackQuery = `${qParam || 'noticias'} ${countryCode === 'BR' ? 'brasil' : countryCode}`;
      videos = await ctx.searchYoutubeVideos(fallbackQuery, hl, false, 'none', useTor, searchMode, countryCode, effectiveClientIp).catch(() => []);
    }

    const headingQuery = searchMode === 'trending'
      ? (countryCode === 'BR' ? 'em alta' : 'trending')
      : (searchMode === 'live'
        ? (countryCode === 'BR' ? 'ao vivo' : 'live')
        : (searchMode === 'podcast' ? 'podcast' : (qParam || 'noticias')));

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
      clientIp: effectiveClientIp,
      query: headingQuery,
      videos: (videos || []).slice(0, 30)
    }));
    return true;
  }

  return false;
}

module.exports = {
  handle,
  COUNTRY_NAMES,
  COUNTRY_FLAGS
};
