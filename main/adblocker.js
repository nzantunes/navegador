// Módulo Adblocker nativo para Papaléguas Tor Browser
// Bloqueia anúncios, rastreadores, scripts invasivos e popups via WebRequest e injeção de CSS

const adBlockPatterns = [
  // Google Ads & DoubleClick
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://*.google-analytics.com/*',
  '*://pagead2.googlesyndication.com/*',
  '*://adservice.google.com/*',
  '*://adservice.google.com.*/*',
  '*://*.admob.com/*',
  '*://*.adsafeprotected.com/*',
  
  // Principais redes de anúncios mundiais e brasileiras
  '*://*.adnxs.com/*',
  '*://*.criteo.com/*',
  '*://*.criteo.net/*',
  '*://*.rubiconproject.com/*',
  '*://*.pubmatic.com/*',
  '*://*.taboola.com/*',
  '*://*.outbrain.com/*',
  '*://*.openx.net/*',
  '*://*.adroll.com/*',
  '*://*.zergnet.com/*',
  '*://*.revcontent.com/*',
  '*://*.smartadserver.com/*',
  '*://*.advertising.com/*',
  '*://*.adblade.com/*',
  '*://*.popads.net/*',
  '*://*.propellerads.com/*',
  '*://*.clickadu.com/*',
  '*://*.exoclick.com/*',
  '*://*.trafficjunky.net/*',
  '*://*.ad-delivery.net/*',
  '*://*.amazon-adsystem.com/*',
  '*://*.scorecardresearch.com/*',
  '*://*.hotjar.com/*',
  '*://*.quantserve.com/*',
  '*://*.moatads.com/*',
  '*://*.casalemedia.com/*',
  '*://*.adsystem.com/*',
  '*://*.adform.net/*',
  '*://*.adtrue.com/*',
  '*://*.mgid.com/*',
  '*://*.adsterra.com/*',
  '*://*.trafficfactory.biz/*',
  '*://*.infolinks.com/*',
  '*://*.media.net/*',
  '*://*.serving-sys.com/*',
  '*://*.lijit.com/*',
  '*://*.yieldmo.com/*',
  '*://*.bidswitch.net/*',
  '*://*.gumgum.com/*',
  '*://*.teads.tv/*',
  '*://*.unruly.co/*',
  '*://*.appnexus.com/*',
  '*://*.uncoverrumour.com/*',
  '*://*.syndication.exoclick.com/*',
  '*://*.monetag.com/*',
  '*://*.hilltopads.com/*',
  '*://*.adcash.com/*',
  '*://*.yandex.ru/ads/*',
  '*://*.alwingulla.com/*',
  '*://*.deloplen.com/*',
  '*://*.coinhive.com/*'
];

// Palavras-chave no caminho da URL que indicam publicidade/tracking
const adKeywords = [
  '/ads.js',
  '/ad.js',
  '/advert.js',
  '/ads/ad',
  '/ads_min.js',
  '/adserver',
  '/ad-banner',
  '/banner_ads',
  '/pagead/',
  '/wp-content/plugins/adrotate',
  '/wp-content/plugins/ad-inserter',
  '/gpt.js',
  '/prebid.js',
  '/analytics.js',
  'banner-ad',
  'popup-ad'
];

let adblockEnabled = false;
let blockedCount = 0;

// CSS para remover containers e espaços em branco de anúncios nas páginas
const adHideCSS = `
  /* Ocultar containers de anúncios comuns */
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

function setupAdblocker(sessionInstance) {
  if (!sessionInstance || !sessionInstance.webRequest) return;

  sessionInstance.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (!adblockEnabled) {
      callback({ cancel: false });
      return;
    }

    const url = details.url.toLowerCase();

    // Permite carregamento de arquivos locais (newtab, extensões, etc.)
    if (url.startsWith('file://')) {
      callback({ cancel: false });
      return;
    }

    // Bloqueia anúncios, métricas e páginas de configurações/conta do Spotify por segurança
    if (url.includes('spotify.com') || url.includes('scdn.co') || url.includes('spoti.fi')) {
      // Bloqueio de segurança: impede que clientes acessem configurações ou alterem conta
      if (
        url.includes('/account') ||
        url.includes('/preferences') ||
        url.includes('/settings') ||
        url.includes('accounts.spotify.com/status') ||
        url.includes('accounts.spotify.com/change-password')
      ) {
        blockedCount++;
        callback({ cancel: true });
        return;
      }

      if (
        url.includes('/ad-logic/') ||
        url.includes('/ads/') ||
        url.includes('/ad/') ||
        url.includes('audio-ak-spotify-com.akamaized.net') && url.includes('/ad/') ||
        url.includes('heads-fa.spotify.com') ||
        url.includes('spclient.wg.spotify.com/ads/') ||
        url.includes('spclient.wg.spotify.com/ad-logic/') ||
        url.includes('spclient.wg.spotify.com/commercial-video/')
      ) {
        blockedCount++;
        callback({ cancel: true });
        return;
      }
    }

    // Permite que o player de vídeo do YouTube e embeds funcionem sem travamentos ou falhas de rede
    if (url.includes('youtube.com') || url.includes('googlevideo.com') || url.includes('youtu.be') || url.includes('ytimg.com')) {
      callback({ cancel: false });
      return;
    }

    // Não bloqueia fluxos essenciais de autenticação Google, DRM, IPTV streams, Spotify, Netflix, YouTube e Players de Filmes
    if (
      url.includes('localhost') ||
      url.includes('127.0.0.1') ||
      url.includes('.m3u8') ||
      url.includes('.ts') ||
      url.includes('google.com') ||
      url.includes('gstatic.com') ||
      url.includes('googleapis.com') ||
      url.includes('googleusercontent.com') ||
      url.includes('spotify.com') ||
      url.includes('scdn.co') ||
      url.includes('spoti.fi') ||
      url.includes('widevine') ||
      url.includes('/license') ||
      url.includes('/drm/') ||
      url.includes('vidsrc') ||
      url.includes('vidlink') ||
      url.includes('autoembed') ||
      url.includes('123embed') ||
      url.includes('embedder') ||
      url.includes('embedplayer') ||
      url.includes('cloudorchestranova') ||
      url.includes('embed69') ||
      url.includes('superflix') ||
      url.includes('brasilstream') ||
      url.includes('jmvstream') ||
      url.includes('maistocadas.mus.br') ||
      url.includes('pluto.tv') ||
      url.includes('plex.tv') ||
      url.includes('plex.direct') ||
      url.includes('plex.services') ||
      url.includes('instagram.com') ||
      url.includes('cdninstagram.com') ||
      url.includes('facebook.com') ||
      url.includes('fbcdn.net') ||
      url.includes('tiktok.com') ||
      url.includes('twitter.com') ||
      url.includes('x.com') ||
      url.includes('threads.net') ||
      url.includes('whatsapp.com') ||
      ((details.initiator || '').toLowerCase().includes('plex.tv')) ||
      ((details.referrer || '').toLowerCase().includes('plex.tv')) ||
      ((details.initiator || '').toLowerCase().includes('pluto.tv')) ||
      ((details.referrer || '').toLowerCase().includes('pluto.tv'))
    ) {
      callback({ cancel: false });
      return;
    }

    // Verifica domínios de anúncios
    const isAdDomain = adBlockPatterns.some(pattern => {
      const clean = pattern.replace(/\*/g, '').replace('://', '');
      return url.includes(clean);
    });

    // Verifica keywords de publicidade
    const hasAdKeyword = adKeywords.some(kw => url.includes(kw));

    if (isAdDomain || hasAdKeyword) {
      blockedCount++;
      callback({ cancel: true });
      return;
    }

    callback({ cancel: false });
  });
}

function getAdblockStatus() {
  return {
    enabled: adblockEnabled,
    blockedCount
  };
}

function toggleAdblock(enabled) {
  if (typeof enabled === 'boolean') {
    adblockEnabled = enabled;
  } else {
    adblockEnabled = !adblockEnabled;
  }
  return getAdblockStatus();
}

module.exports = {
  setupAdblocker,
  getAdblockStatus,
  toggleAdblock,
  adHideCSS
};
