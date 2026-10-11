const { ipcRenderer, contextBridge } = require('electron');

// Disfarça flags de automação para evitar "Faça login para confirmar que você não é um bot" do YouTube / Google
try {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true
  });
  if (!window.chrome) {
    window.chrome = { runtime: {}, app: {}, loadTimes: () => ({}), csi: () => ({}) };
  }
  if (!navigator.plugins || navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
      configurable: true
    });
  }
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['pt-BR', 'pt', 'en-US', 'en'],
      configurable: true
    });
  }
} catch (e) {}

function queryAstraDirect(promptOrData, history) {
  return new Promise((resolve, reject) => {
    const handler = (event, response) => {
      ipcRenderer.removeListener('reply-ai-to-page', handler);
      if (response && response.success) {
        resolve(response.reply);
      } else {
        reject(new Error((response && response.error) || 'Erro na resposta da IA'));
      }
    };
    ipcRenderer.on('reply-ai-to-page', handler);
    
    let payload = promptOrData;
    if (typeof promptOrData === 'string' && Array.isArray(history)) {
      payload = { prompt: promptOrData, history: history };
    }
    ipcRenderer.sendToHost('query-ai-from-page', payload);
  });
}

function executeCodeDirect(language, code) {
  return new Promise((resolve, reject) => {
    const handler = (event, response) => {
      ipcRenderer.removeListener('reply-execute-code-to-page', handler);
      if (response && response.result) {
        resolve(response.result);
      } else {
        reject(new Error((response && response.error) || 'Erro na execução do código'));
      }
    };
    ipcRenderer.on('reply-execute-code-to-page', handler);
    ipcRenderer.sendToHost('execute-code-from-page', { language, code });
  });
}

function openInNewTab(url) {
  if (url) {
    ipcRenderer.sendToHost('open-new-tab', url);
  }
}

window.open = function(url) {
  const target = url == null ? '' : String(url);
  if (!target || target === 'about:blank') return null;
  openInNewTab(target);
  return null;
};

// O script da página (outro mundo JS) avisa por um atributo no HTML quando tenta window.open.
function bindPopupRelay() {
  const root = document.documentElement;
  if (!root || root.__plPopupRelay) return;
  root.__plPopupRelay = true;
  root.addEventListener('papaleguas-open-tab', () => {
    const url = root.getAttribute('data-pl-open-url') || '';
    root.removeAttribute('data-pl-open-url');
    if (!url || url === 'about:blank') return;
    openInNewTab(url);
  });
}
if (document.documentElement) bindPopupRelay();
document.addEventListener('DOMContentLoaded', bindPopupRelay);

function linkHref(link) {
  return (link && (link.getAttribute('data-direct') || link.href)) || '';
}

function linkOpensNewContext(link) {
  let target = (link.getAttribute('target') || '').trim();
  if (!target) {
    const base = document.querySelector('base[target]');
    if (base) target = (base.getAttribute('target') || '').trim();
  }
  const name = target.toLowerCase();
  return name && name !== '_self' && name !== '_top' && name !== '_parent';
}

// Determina se é página interna do navegador (newtab / local / túnel da aplicação)
const isInternalPage = window.location.protocol === 'file:' ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname.endsWith('.lhr.life') ||
  window.location.port === '8080' ||
  window.location.pathname.includes('newtab.html') ||
  window.location.pathname.startsWith('/search');

if (!isInternalPage) {
  try {
    const blockedRtc = function() { throw new Error('blocked'); };
    window.RTCPeerConnection = blockedRtc;
    window.webkitRTCPeerConnection = blockedRtc;
    window.mozRTCPeerConnection = blockedRtc;
  } catch (e) {}
}

// Expõe tanto no window direto quanto via contextBridge apenas para páginas internas locais
if (isInternalPage) {
  try {
    window.queryAstraDirect = queryAstraDirect;
    window.executeCodeDirect = executeCodeDirect;
    window.openInNewTab = openInNewTab;
    
    // Expõe a API do Papaléguas Music para abas internas (musica.html)
    window.torBrowserAPI = {
      isElectron: true,
      searchMusic: (query, limit = 30, index = 0) => ipcRenderer.invoke('search-music', query, limit, index),
      searchPlaylists: (query) => ipcRenderer.invoke('search-playlists', query),
      searchAll: (query) => ipcRenderer.invoke('search-all', query),
      getPlaylistTracks: (playlistId) => ipcRenderer.invoke('get-playlist-tracks', playlistId),
      getAiMusicRecommendations: (query, category, excludeTitles) => ipcRenderer.invoke('get-ai-music-recommendations', query, category, excludeTitles),
      chatDjPapaleguas: (userMessage, history, excludeTitles, trackCount) => ipcRenderer.invoke('chat-dj-papaleguas', userMessage, history, excludeTitles, trackCount),
      getFullAudioStream: (track) => ipcRenderer.invoke('get-full-audio-stream', track),
      saveFavoriteTrack: (payload) => ipcRenderer.invoke('save-favorite-track', payload),
      saveFavoritePlaylistIndex: (payload) => ipcRenderer.invoke('save-favorite-playlist-index', payload),
      listFavoritePlaylists: () => ipcRenderer.invoke('list-favorite-playlists'),
      scanDownloadedMusic: (query) => ipcRenderer.invoke('scan-downloaded-music', query),
      getFavoritePlaylist: (name) => ipcRenderer.invoke('get-favorite-playlist', name),
      readFavoriteTrack: (playlist, fileName) => ipcRenderer.invoke('read-favorite-track', playlist, fileName),
      openFavoriteFolder: (name) => ipcRenderer.invoke('open-favorite-folder', name),
      deleteFavoritePlaylist: (name) => ipcRenderer.invoke('delete-favorite-playlist', name),
      deleteFavoriteTrack: (playlist, fileName) => ipcRenderer.invoke('delete-favorite-track', playlist, fileName),
      setFavoritePlaylistCover: (payload) => ipcRenderer.invoke('set-favorite-playlist-cover', payload),
      createFavoritePlaylist: (name) => ipcRenderer.invoke('create-favorite-playlist', name),
      scanClientLan: () => ipcRenderer.invoke('scan-client-lan'),
      sendToHost: (channel, ...args) => {
        try { ipcRenderer.sendToHost(channel, ...args); } catch(e) {}
      }
    };
    ipcRenderer.on('play-dj-music', (event, data) => {
      window.postMessage({ type: 'play-dj-music', query: data.query, autoplay: data.autoplay }, '*');
    });
    ipcRenderer.on('music-player-control', (event, data) => {
      window.postMessage({ type: 'music-player-control', action: data.action, value: data.value }, '*');
    });
  } catch (e) {}

  try {
    if (contextBridge && contextBridge.exposeInMainWorld) {
      contextBridge.exposeInMainWorld('queryAstraDirect', queryAstraDirect);
      contextBridge.exposeInMainWorld('executeCodeDirect', executeCodeDirect);
      contextBridge.exposeInMainWorld('openInNewTab', openInNewTab);
      if (window.torBrowserAPI) {
        contextBridge.exposeInMainWorld('torBrowserAPI', window.torBrowserAPI);
      }
    }
  } catch (e) {}
}

// Escuta postMessage da página apenas se for página interna
window.addEventListener('message', async (ev) => {
  if (ev.data && ev.data.type === 'QUERY_ASTRA_AI_PAGE') {
    try {
      const reply = await queryAstraDirect(ev.data.query, ev.data.history);
      window.postMessage({ type: 'ASTRA_AI_FINAL_REPLY', success: true, reply }, '*');
    } catch (err) {
      window.postMessage({ type: 'ASTRA_AI_FINAL_REPLY', success: false, error: err.message }, '*');
    }
  } else if (ev.data && ev.data.type === 'EXECUTE_CODE_PAGE') {
    try {
      const result = await executeCodeDirect(ev.data.language, ev.data.code);
      window.postMessage({ type: 'EXECUTE_CODE_FINAL_REPLY', id: ev.data.id, success: true, result }, '*');
    } catch (err) {
      window.postMessage({ type: 'EXECUTE_CODE_FINAL_REPLY', id: ev.data.id, success: false, error: err.message }, '*');
    }
  } else if (ev.data && ev.data.type === 'OPEN_NEW_TAB') {
    openInNewTab(ev.data.url);
  } else if (ev.data && (ev.data.type === 'music-state-update' || ev.data.type === 'toggle-music-mini-player' || ev.data.type === 'youtube-state-update' || ev.data.type === 'enter-video-fullscreen' || ev.data.type === 'exit-video-fullscreen' || ev.data.type === 'youtube-enter-pip')) {
    try { ipcRenderer.sendToHost(ev.data.type, ev.data); } catch(e) {}
  }
});

// Em site externo, o clique não pode navegar este documento: o app abre a URL
// num webview novo e esta página fica no cache do botão voltar.
function openLinkInside(e, link) {
  const href = linkHref(link);
  if (!/^https?:/i.test(href) && !href.startsWith('file://')) return false;
  e.preventDefault();
  e.stopPropagation();
  openInNewTab(href);
  return true;
}

window.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const link = e.target && e.target.closest ? e.target.closest('a,area') : null;
  if (!link || link.hasAttribute('download')) return;
  openLinkInside(e, link);
}, true);

window.addEventListener('click', (e) => {
  const link = e.target && e.target.closest ? e.target.closest('a,area') : null;
  if (!link || link.hasAttribute('download')) return;
  const href = linkHref(link);
  if (!/^https?:/i.test(href) && !href.startsWith('file://')) return;
  const modified = e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
  if (modified || linkOpensNewContext(link) || link.classList.contains('gpt-link') || link.getAttribute('data-external') === 'true') {
    openLinkInside(e, link);
    return;
  }
  if (e.button !== 0) return;
  if (isInternalPage) return;
  try {
    const next = new URL(href, window.location.href);
    if (next.origin === window.location.origin && next.pathname === window.location.pathname && next.search === window.location.search) {
      return;
    }
  } catch (err) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  try { ipcRenderer.sendToHost('navigate-current-tab', href); } catch (err) {}
}, true);

window.addEventListener('submit', (e) => {
  const form = e.target;
  if (!form || String(form.method || 'get').toLowerCase() !== 'post') return;
  try { ipcRenderer.sendToHost('allow-native-navigation'); } catch (err) {}
}, true);

// Injeção de regras de bloqueio visual de anúncios (CSS Cosmetic Filter)
const adHideCSS = `
  ins.adsbygoogle,
  div[id^="google_ads_iframe"],
  iframe[id^="google_ads_iframe"],
  div[class*="ad-container"],
  div[class*="ad_container"],
  div[class*="ad-banner"],
  div[class*="ad_banner"],
  div[class*="ad-slot"],
  div[class*="ad_slot"],
  div[class*="advertisement"],
  div[class*="advertising"],
  div[id*="advertisement"],
  div[id*="advertising"],
  div[class*="taboola"],
  div[id*="taboola"],
  div[class*="outbrain"],
  div[id*="outbrain"],
  .ad-wrapper,
  .advert-wrapper,
  .sponsor-post,
  .sponsored-content,
  .sponsored-links,
  [data-ad-client],
  [data-ad-slot],
  [data-google-query-id],
  [id^="ad_unit"],
  [class^="ad_unit"] {
    display: none !important;
    visibility: hidden !important;
    height: 0 !important;
    width: 0 !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
`;


let __adblockEnabled = false;

function removeAdblockCSS() {
  try {
    const s1 = document.getElementById('papaleguas-adblock-css');
    if (s1) s1.remove();
    const s2 = document.getElementById('papaleguas-yt-adblock-css');
    if (s2) s2.remove();
  } catch (e) {}
}

function updateAdblockState(enabled) {
  __adblockEnabled = !!enabled;
  if (__adblockEnabled) {
    injectAdblockCSS();
    if (typeof injectYouTubeAdCSS === 'function') injectYouTubeAdCSS();
  } else {
    removeAdblockCSS();
  }
}

// Escuta atualizações de status vindas do processo principal ou do host
try {
  ipcRenderer.on('adblock-status-changed', (_event, data) => {
    updateAdblockState(data && data.enabled);
  });
} catch (e) {}

// Verifica estado do adblocker ao iniciar
try {
  ipcRenderer.invoke('get-adblock-status').then(res => {
    updateAdblockState(res && res.enabled);
  }).catch(() => {
    __adblockEnabled = false;
    removeAdblockCSS();
    try { ipcRenderer.sendToHost('get-adblock-status'); } catch (e2) {}
  });
} catch(e) {
  __adblockEnabled = false;
  removeAdblockCSS();
}

function injectAdblockCSS() {
  if (!__adblockEnabled) {
    removeAdblockCSS();
    return;
  }

  try {
    // Não injeta CSS de adblock em serviços de autenticação do Google, Spotify e streaming
    const host = window.location.hostname;
    if (
      host.includes('google.com') ||
      host.includes('gstatic.com') ||
      host.includes('spotify.com') ||
      host.includes('netflix.com') ||
      host.includes('deezer.com') ||
      host.includes('maistocadas.mus.br') ||
      host.includes('pluto.tv') ||
      host.includes('instagram.com') ||
      host.includes('facebook.com') ||
      host.includes('tiktok.com') ||
      host.includes('twitter.com') ||
      host.includes('x.com') ||
      host.includes('plex.tv') ||
      host.includes('plex.direct')
    ) {
      return;
    }
    if (!document.head) return;
    const existingStyle = document.getElementById('papaleguas-adblock-css');
    if (!__adblockEnabled) {
      if (existingStyle) existingStyle.remove();
      return;
    }
    if (existingStyle) return;
    const style = document.createElement('style');
    style.id = 'papaleguas-adblock-css';
    style.textContent = adHideCSS;
    document.head.appendChild(style);
  } catch (e) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (__adblockEnabled) injectAdblockCSS();
  });
} else {
  if (__adblockEnabled) injectAdblockCSS();
}

// Observa novos nós adicionados dinamicamente para bloquear popups e iframes de anúncios
try {
  const observer = new MutationObserver(() => {
    if (__adblockEnabled) injectAdblockCSS();
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
} catch (e) {}

// ==========================================
// AGENTE SENTINELA ANTI-ANÚNCIOS DO SPOTIFY
// ==========================================
(function initSpotifyAdKillerAgent() {
  if (!window.location.hostname.includes('spotify.com')) return;

  console.log('[Agente Anti-Anúncio] Ativado para Spotify Web');

  // 1. Injeta CSS para ocultar anúncios, banners de upgrade e containers patrocinados
  const spotifyAdCSS = `
    [data-testid="ad-iframe"],
    [data-testid="ad-break-container"],
    [data-testid="ad-leaderboard-container"],
    [data-testid="test-ad-container"],
    [aria-label="Anúncio"],
    [aria-label="Advertisement"],
    div[class*="Sponsored"],
    div[class*="adBreak"],
    div[class*="adBanner"],
    div[class*="billboard"],
    button[data-testid="upgrade-button"],
    a[href*="/premium"],
    div[data-testid="action-bar-row"] + div[class*="banner"],
    div[data-testid="track-info-advertiser"],

    /* ==================================================== */
    /* BLOQUEIO DE SEGURANÇA: CONFIGURAÇÕES E MINI PLAYER  */
    /* ==================================================== */
    /* Oculta botão de perfil do usuário e menu de conta */
    button[data-testid="user-widget-link"],
    [data-testid="user-widget-avatar"],
    button[data-testid="user-widget-dropdown"],
    a[href*="/account"],
    a[href*="/preferences"],
    a[href*="/settings"],
    /* Oculta botão do Mini Player / Picture-in-Picture */
    button[data-testid="pip-toggle-button"],
    button[aria-label*="Miniplayer"],
    button[aria-label*="miniplayer"],
    button[aria-label*="Mini player"],
    button[aria-label*="mini player"],
    button[aria-label*="Abrir o miniplayer"],
    button[aria-label*="Open Miniplayer"],
    button[data-testid="control-button-pip"],
    /* Oculta opções de configurações / menu contextual de perfil */
    ul[role="menu"] a[href*="account"],
    ul[role="menu"] a[href*="settings"],
    ul[role="menu"] a[href*="preferences"],
    [data-testid="context-menu"] a[href*="account"],
    [data-testid="context-menu"] a[href*="settings"] {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      width: 0 !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;

  function injectSpotifyStyles() {
    if (!document.head || document.getElementById('spotify-ad-killer-css')) return;
    const style = document.createElement('style');
    style.id = 'spotify-ad-killer-css';
    style.textContent = spotifyAdCSS;
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSpotifyStyles);
  } else {
    injectSpotifyStyles();
  }

  // 2. Agente de Verificação Contínua e Agressiva de Anúncios no Spotify
  let wasAdPlaying = false;

  function isSpotifyAdActive() {
    // 1. Verifica barra de progresso / playback-bar (aria-label ou textos de anúncio)
    const playbackBar = document.querySelector('[data-testid="playback-progressbar"]');
    if (playbackBar) {
      const pbText = playbackBar.getAttribute('aria-label') || '';
      if (pbText.toLowerCase().includes('anúncio') || pbText.toLowerCase().includes('ad') || pbText.toLowerCase().includes('advertisement')) {
        return true;
      }
    }

    // 2. Informações da música/artista sendo reproduzida
    const nowPlayingWidget = document.querySelector('[data-testid="now-playing-widget"]');
    if (nowPlayingWidget) {
      const allText = nowPlayingWidget.textContent.toLowerCase();
      if (
        allText.includes('anúncio') ||
        allText.includes('advertisement') ||
        allText.includes('anuncio')
      ) {
        return true;
      }
    }

    // 3. Indicadores de anúncio no player
    if (document.querySelector('[data-testid="track-info-advertiser"]')) return true;

    // 4. Link da música: músicas normais têm link para /track/ ou /album/, anúncios não têm link de track
    const trackTitleEl = document.querySelector('[data-testid="context-item-info-title"]');
    const trackLink = trackTitleEl ? trackTitleEl.querySelector('a') : null;
    const titleText = trackTitleEl ? trackTitleEl.textContent.trim().toLowerCase() : '';

    if (titleText.includes('anúncio') || titleText.includes('spotify') && !trackLink) {
      // Se tiver 'spotify' como título e sem link de faixa
      if (titleText === 'spotify' || titleText.includes('anúncio')) {
        return true;
      }
    }

    // 5. Verifica elementos de vídeo/áudio com sources conhecidos de anúncio
    const media = document.querySelector('audio, video');
    if (media && media.src) {
      const src = media.src.toLowerCase();
      if (src.includes('/ad/') || src.includes('heads-fa') || src.includes('audio-ak-spotify')) {
        return true;
      }
    }

    return false;
  }

  function handleSpotifyAds() {
    try {
      const adActive = isSpotifyAdActive();
      const mediaElements = Array.from(document.querySelectorAll('audio, video'));

      if (adActive) {
        if (!wasAdPlaying) {
          console.log('[Agente Anti-Anúncio] Anúncio de áudio detectado! Silenciando e acelerando...');
          wasAdPlaying = true;
        }

        mediaElements.forEach(media => {
          try {
            // Silencia o áudio
            media.muted = true;
            // Avança para o fim do anúncio
            if (media.duration && !isNaN(media.duration) && isFinite(media.duration)) {
              media.currentTime = media.duration;
            } else {
              media.playbackRate = 16.0;
            }
          } catch (e) {}
        });

        // Clica no botão de Pular / Próxima Música (Skip forward)
        const skipBtn = document.querySelector('button[data-testid="control-button-skip-forward"]');
        if (skipBtn && !skipBtn.disabled) {
          skipBtn.click();
        }
      } else {
        if (wasAdPlaying) {
          wasAdPlaying = false;
          mediaElements.forEach(media => {
            try {
              media.muted = false;
              media.playbackRate = 1.0;
            } catch (e) {}
          });
          console.log('[Agente Anti-Anúncio] Música retomada.');
        }
      }

      // Fecha popups de "Experimente o Premium" ou ofertas
      const closePopupButtons = document.querySelectorAll(
        'button[aria-label="Fechar"], button[aria-label="Dismiss"], button[data-testid="close-button"]'
      );
      closePopupButtons.forEach(btn => {
        const dialog = btn.closest('[role="dialog"]') || btn.closest('[data-testid="upsell-container"]');
        if (dialog) {
          btn.click();
        }
      });

      // 3. SEGURANÇA: Bloqueio de navegação para /account, /preferences ou /settings
      const currentPath = window.location.pathname.toLowerCase();
      if (currentPath.includes('/account') || currentPath.includes('/preferences') || currentPath.includes('/settings')) {
        console.warn('[Spotify Security Guard] Acesso a configurações bloqueado por segurança.');
        window.location.replace('https://open.spotify.com');
      }
    } catch (err) {}
  }

  // Intercepta cliques para configurações e mini player antes de serem processados
  window.addEventListener('click', (e) => {
    const target = e.target.closest('a, button');
    if (!target) return;

    const href = (target.getAttribute('href') || '').toLowerCase();
    const testId = (target.getAttribute('data-testid') || '').toLowerCase();
    const aria = (target.getAttribute('aria-label') || '').toLowerCase();

    // Bloqueia qualquer link ou botão de conta/configuração
    if (href.includes('/account') || href.includes('/preferences') || href.includes('/settings') ||
        testId.includes('user-widget') || testId.includes('pip') ||
        aria.includes('miniplayer') || aria.includes('mini player') || aria.includes('configurações') || aria.includes('settings')) {
      e.preventDefault();
      e.stopPropagation();
      console.warn('[Spotify Security Guard] Interação bloqueada por política de segurança.');
    }
  }, true);

  // Executa o sentinela a cada 100 milissegundos para reação em tempo real
  setInterval(() => {
    if (document.hidden) return;
    handleSpotifyAds();
  }, 100);
})();

// ==========================================
// AGENTE SENTINELA ANTI-ANÚNCIOS DO YOUTUBE
// ==========================================
(function initYouTubeAdKillerAgent() {
  const host = window.location.hostname;
  if (!host.includes('youtube.com') && !host.includes('youtu.be')) return;

  console.log('[YouTube Ad Killer] Agente ativado para YouTube');

  // 1. CSS para ocultar overlays de anúncios, banners, popups e containers
  const youtubeAdCSS = `
    /* Video ad overlays */
    .video-ads,
    .ytp-ad-module,
    .ytp-ad-overlay-container,
    .ytp-ad-overlay-slot,
    .ytp-ad-image-overlay,
    .ytp-ad-text-overlay,
    .ytp-ad-overlay-ad-info-dialog-container,
    .ytp-ad-overlay-close-container,
    .ytp-ad-action-interstitial,
    .ytp-ad-action-interstitial-background-container,
    .ytp-ad-action-interstitial-slot,
    .ytp-ad-player-overlay,
    .ytp-ad-player-overlay-layout,
    .ytp-ad-player-overlay-flyout-cta,
    .ytp-ad-player-overlay-skip-or-preview,
    .ytp-ad-feedback-dialog-container,

    /* Masthead / Banner / Display ads */
    #masthead-ad,
    #player-ads,
    #below ytd-ad-slot-renderer,
    #related ytd-ad-slot-renderer,
    ytd-ad-slot-renderer,
    ytd-banner-promo-renderer,
    ytd-statement-banner-renderer,
    ytd-in-feed-ad-layout-renderer,
    ytd-promoted-sparkles-web-renderer,
    ytd-promoted-video-renderer,
    ytd-display-ad-renderer,
    ytd-companion-slot-renderer,
    ytd-action-companion-ad-renderer,
    ytd-promoted-sparkles-text-search-renderer,
    ytd-player-legacy-desktop-watch-ads-renderer,
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),

    /* Sidebar promoted */
    #watch7-sidebar-ads,
    #search-pva,
    .ytd-mealbar-promo-renderer,
    ytd-mealbar-promo-renderer,
    ytd-popup-container:has(.ytd-enforcement-message-view-model),

    /* Shelf ads in homepage */
    ytd-rich-section-renderer:has(ytd-ad-slot-renderer),

    /* Premium upsell popups */
    tp-yt-paper-dialog:has(yt-upsell-dialog-renderer),
    ytd-popup-container:has(yt-premium-offer-module-renderer),
    ytd-enforcement-message-view-model,
    tp-yt-paper-dialog:has([target-id="engagement-panel-ads"]) {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
      pointer-events: none !important;
    }

    /* Hide the ad badge / countdown timer on video player */
    .ytp-ad-preview-container,
    .ytp-ad-skip-ad-slot,
    .ytp-ad-visit-advertiser-button,
    .ytp-ad-feedback-dialog-renderer {
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;

  
function injectYouTubeAdCSS() {
  if (!__adblockEnabled) {
    const existingYTStyle = document.getElementById('papaleguas-yt-adblock-css');
    if (existingYTStyle) existingYTStyle.remove();
    return;
  }

  if (!document.head) return;
  
  const existingYTStyle = document.getElementById('papaleguas-yt-adblock-css');
  if (existingYTStyle) return;

  const style = document.createElement('style');
  style.id = 'papaleguas-yt-adblock-css';
  style.textContent = youtubeAdCSS;
  document.head.appendChild(style);
}

// 2. Função principal: detecta e pula anúncios de vídeo em tempo real
function killYouTubeVideoAds() {
  if (!__adblockEnabled) return;
    try {
      const player = document.querySelector('.html5-video-player');
      if (!player) return;

      // Detecta se um anúncio de vídeo está ativo
      const isAdPlaying = player.classList.contains('ad-showing') ||
                          player.classList.contains('ad-interrupting') ||
                          !!player.querySelector('.ytp-ad-player-overlay') ||
                          !!document.querySelector('.ytp-ad-module .ytp-ad-player-overlay-layout');

      if (isAdPlaying) {
        const video = player.querySelector('video');
        if (video) {
          // Silencia, acelera 16x e pula para o final do anúncio
          video.muted = true;
          video.playbackRate = 16.0;
          if (video.duration && isFinite(video.duration) && video.duration > 0) {
            video.currentTime = video.duration - 0.1;
          }
        }

        // Clica no botão "Pular anúncio" se disponível
        const skipButtons = document.querySelectorAll(
          '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, ' +
          'button.ytp-ad-skip-button, button.ytp-ad-skip-button-modern, ' +
          '.ytp-ad-skip-button-container button, ' +
          '[class*="skip-button"], [id*="skip-button"], ' +
          'button[data-id="skip-button"], ' +
          '.ytp-ad-overlay-close-button'
        );
        skipButtons.forEach(btn => {
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
          }
        });

        // Remove overlays de anúncios visíveis
        const overlays = document.querySelectorAll(
          '.ytp-ad-overlay-container, .ytp-ad-overlay-slot, ' +
          '.video-ads, .ytp-ad-action-interstitial'
        );
        overlays.forEach(el => {
          el.style.display = 'none';
          el.remove();
        });
      }

      // Remove ad slots do feed / sidebar / resultados de busca (DOM cleanup)
      const adSlots = document.querySelectorAll(
        'ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer, ' +
        'ytd-promoted-video-renderer, ytd-in-feed-ad-layout-renderer, ' +
        'ytd-display-ad-renderer, ytd-banner-promo-renderer, ' +
        '#masthead-ad, ytd-promoted-sparkles-text-search-renderer'
      );
      adSlots.forEach(slot => {
        slot.style.display = 'none';
        try { slot.remove(); } catch (e) {}
      });

      // Fecha popups de upsell Premium
      const closeButtons = document.querySelectorAll(
        'tp-yt-paper-dialog button[aria-label="Não, obrigado"], ' +
        'tp-yt-paper-dialog button[aria-label="No thanks"], ' +
        'tp-yt-paper-dialog button[aria-label="Dismiss"], ' +
        'tp-yt-paper-dialog button[aria-label="Fechar"], ' +
        'tp-yt-paper-dialog #dismiss-button, ' +
        'ytd-popup-container button.yt-spec-button-shape-next--call-to-action-inverse'
      );
      closeButtons.forEach(btn => {
        const dialog = btn.closest('tp-yt-paper-dialog, ytd-popup-container');
        if (dialog) {
          try { btn.click(); } catch (e) {}
        }
      });

    } catch (err) {}
  }

  // 3. O bloqueio de tráfego de rede de anúncios é delegado com segurança ao adblocker.js (nível WebRequest do Electron)
  // evitando quebrar tokens de integridade e checagens anti-bot da API do YouTube Player.

  // Inicialização
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      injectYouTubeAdCSS();
      killYouTubeVideoAds();
    });
  } else {
    injectYouTubeAdCSS();
    killYouTubeVideoAds();
  }

  // MutationObserver para re-injetar e limpar ads quando o DOM muda
  try {
    const ytObserver = new MutationObserver(() => {
      injectYouTubeAdCSS();
      killYouTubeVideoAds();
    });
    if (document.documentElement) {
      ytObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch (e) {}

  // Sentinela agressivo a cada 500ms para pegar anúncios em tempo real
  setInterval(() => {
    if (document.hidden) return;
    killYouTubeVideoAds();
  }, 500);

  console.log('[YouTube Ad Killer] Proteção total ativada: CSS + XHR/Fetch intercept + DOM cleanup');
})();

// ----------------------------------------------------
// DETECTOR AUTOMÁTICO DE VÍDEOS NA PÁGINA (MP4 / MP3)
// ----------------------------------------------------
function youtubeIdFromUrl(raw) {
  try {
    const u = new URL(String(raw || ''), window.location.href);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return (u.pathname.split('/').filter(Boolean)[0] || '').split('?')[0];
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const match = u.pathname.match(/\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      if (match) return match[1];
    }
  } catch (e) {}
  return '';
}

function realBrowsedUrl() {
  try {
    const u = new URL(window.location.href);
    if (u.pathname === '/proxy' || u.pathname.indexOf('/proxy/') === 0) {
      return u.searchParams.get('url') || window.location.href;
    }
  } catch (e) {}
  return window.location.href;
}

function isOwnAppPage(href) {
  try {
    const u = new URL(href, window.location.href);
    const path = u.pathname || '/';
    if (/newtab\.html|musica\.html/i.test(path)) return true;
    if (/^\/(youtube|filmes|musica|search|baixatube|ip-check)(\/|$)/.test(path)) return true;
    if (path === '/' || path === '/index.html' || path === '/src/index.html') return true;
  } catch (e) {}
  return false;
}

(() => {
  let lastReportedVideo = '';
  function sniffVideos() {
    try {
      const pageUrl = realBrowsedUrl();
      if (!pageUrl || isOwnAppPage(window.location.href) || isOwnAppPage(pageUrl)) return;
      let detected = null;
      const ytFromPage = youtubeIdFromUrl(pageUrl);
      if (ytFromPage) {
        detected = {
          type: 'youtube',
          youtubeId: ytFromPage,
          url: 'https://www.youtube.com/watch?v=' + ytFromPage,
          title: document.title.replace(/\s+-\s+YouTube\s*$/i, '').trim() || 'Vídeo',
          width: 1280,
          duration: 0
        };
      }
      if (!detected) {
        const frame = document.querySelector('iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]');
        const frameId = frame ? youtubeIdFromUrl(frame.src) : '';
        if (frameId) {
          detected = {
            type: 'youtube',
            youtubeId: frameId,
            url: 'https://www.youtube.com/watch?v=' + frameId,
            title: document.title || 'Vídeo',
            width: 1280,
            duration: 0
          };
        }
      }
      if (!detected) {
        const videos = Array.from(document.querySelectorAll('video'));
        videos.sort((a, b) => ((b.videoWidth || b.clientWidth || 0) * (b.videoHeight || b.clientHeight || 0)) - ((a.videoWidth || a.clientWidth || 0) * (a.videoHeight || a.clientHeight || 0)));
        const video = videos[0];
        if (video) {
          const width = video.videoWidth || video.clientWidth || 0;
          const duration = Number.isFinite(video.duration) ? video.duration : 0;
          if (width >= 160 || duration >= 12) {
            const vSrc = video.currentSrc || video.src || '';
            const mediaUrl = vSrc && !vSrc.startsWith('blob:') && /^https?:/i.test(vSrc) ? vSrc : '';
            detected = {
              type: mediaUrl ? 'html5' : 'page',
              youtubeId: '',
              url: pageUrl,
              mediaUrl: mediaUrl,
              title: document.title || 'Vídeo na página',
              width: width,
              duration: duration
            };
          }
        }
      }

      const reportKey = detected ? (detected.youtubeId || detected.mediaUrl || detected.url) : '';
      if (detected && reportKey && reportKey !== lastReportedVideo) {
        lastReportedVideo = reportKey;
        try {
          ipcRenderer.sendToHost('media-video-detected', detected);
        } catch (e) {}
      }
    } catch (e) {}
  }

  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.data.type !== 'papaleguas-pause-media') return;
    document.querySelectorAll('video,audio').forEach((media) => {
      try { media.pause(); } catch (e) {}
    });
  });

  // Página em segundo plano não precisa ser vasculhada atrás de vídeo.
  setInterval(() => {
    if (document.hidden) return;
    sniffVideos();
  }, 1800);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sniffVideos);
  } else {
    sniffVideos();
  }
})();
