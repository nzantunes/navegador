require('./log-redact').installLogRedaction();
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
const { app, BrowserWindow, ipcMain, session, Menu, components, screen, dialog, shell, Tray, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const TorManager = require('./tor-manager');
const { runGptNavigator, callOpenAiChat } = require('./gpt-agent');
const { setupAdblocker, getAdblockStatus, toggleAdblock } = require('./adblocker');

const WEBRTC_LEAK_SHIELD = `(function(){
  var Blocked = function(){ throw new Error('WebRTC bloqueado'); };
  function wrap(Original){
    if (typeof Original !== 'function') return Blocked;
    var Wrapped = function(){
      return new Original({ iceServers: [], iceTransportPolicy: 'relay' });
    };
    Wrapped.prototype = Original.prototype;
    return Wrapped;
  }
  try { window.RTCPeerConnection = wrap(window.RTCPeerConnection); } catch (e) {}
  try { window.webkitRTCPeerConnection = wrap(window.webkitRTCPeerConnection); } catch (e) {}
  try { window.RTCIceCandidate = Blocked; } catch (e) {}
})();`;

function installWebRtcLeakShield(contents) {
  if (!contents || contents.__plWebRtcShield) return;
  contents.__plWebRtcShield = true;
  try {
    if (typeof contents.setWebRTCIPHandlingPolicy === 'function') {
      contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    }
  } catch (e) {}
  const arm = () => {
    try {
      if (contents.isDestroyed()) return;
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
      contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: WEBRTC_LEAK_SHIELD
      }).catch(() => {});
    } catch (e) {}
  };
  arm();
  contents.on('did-finish-load', () => {
    if (contents.isDestroyed()) return;
    contents.executeJavaScript(WEBRTC_LEAK_SHIELD, true).catch(() => {});
  });
}

// Roda no mundo da página, antes dos scripts do site. window.open de iframe em branco
// e Window.prototype.open.call não conseguem mais abrir janela fora do app.
const POPUP_GUARD = `(function(){
  if (window.__plPopupGuard) return;
  window.__plPopupGuard = true;
  function notify(url) {
    try {
      var raw = url == null ? '' : String(url);
      if (!raw || raw === 'about:blank' || /^javascript:/i.test(raw)) return;
      try { raw = new URL(raw, location.href).href; } catch (e) { return; }
      var root = document.documentElement;
      if (!root) return;
      root.setAttribute('data-pl-open-url', raw);
      root.dispatchEvent(new Event('papaleguas-open-tab'));
    } catch (e) {}
  }
  function guardOpen(fn) {
    return function(url) { notify(url); return null; };
  }
  try {
    Object.defineProperty(Window.prototype, 'open', {
      configurable: false,
      writable: false,
      value: guardOpen()
    });
  } catch (e) {}
  try {
    Object.defineProperty(window, 'open', {
      configurable: false,
      writable: false,
      value: guardOpen()
    });
  } catch (e) {
    try { window.open = guardOpen(); } catch (e2) {}
  }
  try {
    var frameProto = HTMLIFrameElement.prototype;
    var cw = Object.getOwnPropertyDescriptor(frameProto, 'contentWindow');
    if (cw && cw.get) {
      Object.defineProperty(frameProto, 'contentWindow', {
        configurable: true,
        get: function() {
          var w = cw.get.call(this);
          try {
            Object.defineProperty(w, 'open', {
              configurable: false,
              writable: false,
              value: guardOpen()
            });
          } catch (e2) {}
          return w;
        }
      });
    }
  } catch (e) {}
  try {
    var nativeSubmit = HTMLFormElement.prototype.submit;
    Object.defineProperty(HTMLFormElement.prototype, 'submit', {
      configurable: false,
      writable: false,
      value: function() {
        var target = (this.getAttribute('target') || '').trim().toLowerCase();
        if (!target) {
          var base = document.querySelector('base[target]');
          target = base ? (base.getAttribute('target') || '').trim().toLowerCase() : '';
        }
        if (target && target !== '_self' && target !== '_parent' && target !== '_top') {
          notify(this.action || '');
          return;
        }
        return nativeSubmit.apply(this, arguments);
      }
    });
  } catch (e) {}
})();`;

function installPopupGuard(contents) {
  if (!contents || contents.__plPopupGuard) return;
  let type = '';
  try { type = contents.getType(); } catch (e) {}
  if (type !== 'webview') return;
  contents.__plPopupGuard = true;
  const arm = () => {
    try {
      if (contents.isDestroyed()) return;
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
      contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: POPUP_GUARD
      }).catch(() => {});
    } catch (e) {}
  };
  arm();
  contents.on('did-finish-load', () => {
    if (contents.isDestroyed()) return;
    contents.executeJavaScript(POPUP_GUARD, true).catch(() => {});
  });
}

app.on('web-contents-created', (_event, contents) => {
  installWebRtcLeakShield(contents);
  installPopupGuard(contents);
  if (!contents || typeof contents.setWindowOpenHandler !== 'function') return;
  contents.setWindowOpenHandler(({ url }) => {
    openUrlInsideApp(url);
    return { action: 'deny' };
  });
});

app.setName('papaleguas-tor');
if (process.platform === 'linux') {
  app.setAppUserModelId('papaleguas-tor');
}

process.on('uncaughtException', (err) => {
  if (err && (err.code === 'ERR_HTTP_HEADERS_SENT' || err.code === 'EPIPE' || err.code === 'ECONNRESET')) {
    console.warn('[HTTP]', err.code, err.message);
    return;
  }
  console.error('[UNCAUGHT]', err);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason || '');
  if (/headers already sent|EPIPE|ECONNRESET/i.test(msg)) {
    console.warn('[HTTP]', msg);
    return;
  }
  console.error('[UNHANDLED REJECTION]', reason);
});

// Prevenção contra vazamento de WebRTC / IP (sites como meuip.com.br)
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'disable_non_proxied_udp');
// Impede que abas em segundo plano, janelas minimizadas ou Picture-in-Picture travem/congelem
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// BackForwardCache: voltar reusa a página que já estava carregada em vez de baixar de novo.
app.commandLine.appendSwitch('enable-features', 'WidevineCdm,AudioServiceOutOfProcess,BackForwardCache:enable_same_site/true,BackForwardCacheMemoryControls');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Permite aceleração gráfica por hardware para desafogar o processador
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// Google usa HTTP/3 (QUIC/UDP), que o SOCKS do Tor não encaminha — sem isso o site sai na internet normal.
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('disable-features', 'WebGPU,EnableQUIC,UseDnsHttpsSvcb,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessPermissionPrompt');
// Garante que todo webContents (inclusive webviews internas do player) nunca seja suspenso ao minimizar
app.on('web-contents-created', (event, contents) => {
  try {
    contents.setBackgroundThrottling(false);
  } catch (e) {}
});
// Só erros fatais do Chromium. O resto às vezes imprime o endereço da página.
app.commandLine.appendSwitch('log-level', '3');
// DNS local só para o app, túnel e domínios essenciais com bypass de proxy. O resto não resolve na máquina:
// o Chromium é obrigado a mandar o nome pelo SOCKS, senão o IP real vaza.
app.commandLine.appendSwitch(
  'host-resolver-rules',
  [
    'MAP *.trycloudflare.com 104.16.231.132',
    'MAP *.cfargotunnel.com 104.16.231.132',
    'EXCLUDE 127.0.0.1',
    'EXCLUDE localhost',
    'EXCLUDE *.local',
    'EXCLUDE googlevideo.com',
    'EXCLUDE *.googlevideo.com',
    'EXCLUDE ytimg.com',
    'EXCLUDE *.ytimg.com',
    'EXCLUDE ggpht.com',
    'EXCLUDE *.ggpht.com',
    'EXCLUDE gstatic.com',
    'EXCLUDE *.gstatic.com',
    'EXCLUDE gvt1.com',
    'EXCLUDE *.gvt1.com',
    'MAP * ~NOTFOUND'
  ].join(', ')
);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('[APP] Papaléguas já está em execução. Use a janela que já está aberta.');
  app.quit();
  process.exit(0);
}

let papaleguasServer = null;
try {
  papaleguasServer = require('./server');
} catch (e) {
  console.error('[APP] Falha ao iniciar o servidor local:', e && e.message ? e.message : e);
}

let mainWindow;
let ytPipWindow = null;
let forceQuitBrowser = false;
let pipQueryPending = false;
const torManager = new TorManager({ socksPort: 9050, socksHost: '127.0.0.1' });
let torEnabled = false;

function getAppSessions() {
  return [
    session.defaultSession,
    session.fromPartition('persist:tor-browser'),
    session.fromPartition('persist:papaleguas-tor')
  ];
}

// Catálogo do Papaléguas Music (Deezer) e DJ: saem direto, sem passar pelo proxy Tor.
// Só a pesquisa de URLs usa a rede Tor.
function getNodeTorAgent() {
  return undefined;
}

async function configureTorProxy(torSession) {
  if (torEnabled) {
    await torSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:9050',
      // Navegação do YouTube e Google sai pela rede Tor para garantir recomendações e IP do país conectado.
      // Apenas streaming pesado de chunks de vídeo do googlevideo tem opção de bypass de CDN.
      proxyBypassRules: 'localhost;127.0.0.1;[::1];192.168.0.0/16;10.0.0.0/8;172.16.0.0/12;*.local;239.255.255.250;*.trycloudflare.com;*.cfargotunnel.com;'
        + 'youtube.com;*.youtube.com;youtu.be;*.youtu.be;googlevideo.com;*.googlevideo.com;ytimg.com;*.ytimg.com;ggpht.com;*.ggpht.com;gstatic.com;*.gstatic.com;gvt1.com;*.gvt1.com'
    });
    if (typeof torSession.closeAllConnections === 'function') {
      await torSession.closeAllConnections().catch(() => {});
    }
  } else {
    await torSession.setProxy({
      mode: 'direct',
      proxyRules: 'direct://'
    });
  }
}

function applyTorDnsMode() {
  if (typeof app.configureHostResolver !== 'function') return;
  try {
    // O resolver embutido é quem obedece host-resolver-rules.
    // Desligá-lo manda o DNS para o sistema e a consulta sai com o IP real.
    app.configureHostResolver({
      enableBuiltInResolver: true,
      secureDnsMode: 'off'
    });
  } catch (e) {}
}

async function applyTorRouting() {
  if (typeof torManager.ensureRunning === 'function') {
    await torManager.ensureRunning().catch(() => {});
  }
  applyTorDnsMode();
  const sessions = getAppSessions();
  for (const s of sessions) {
    await configureTorProxy(s);
  }
}

function openUrlInsideApp(url) {
  const target = String(url || '');
  if (!target || target === 'about:blank') return;
  if (!/^https?:/i.test(target) && !target.startsWith('/') && !target.startsWith('file:')) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-url-in-app', target);
  }
}

function createWindow() {
  Menu.setApplicationMenu(null);
  // Sessão nova (ex.: voltar do mini player) merece nova limpeza ao sair.
  tracesCleared = false;

  mainWindow = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#090a10',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.removeMenu();

  const torPartitionSession = session.fromPartition('persist:tor-browser');
  applyTorRouting().finally(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(path.join(__dirname, '../src/index.html'));
    }
  });

  // Permissões automáticas para reprodução de mídia, DRM e MICROFONE (Agente de Voz)
  const handlePermissions = (webContents, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'protected-media-identifier', 'notifications', 'pointerLock', 'fullscreen', 'audioCapture', 'videoCapture', 'storage-access', 'clipboard-read', 'clipboard-sanitized-write', 'local-fonts', 'local-network', 'local-network-access', 'private-network'];
    if (allowed.includes(permission)) {
      return callback(true);
    }
    callback(false);
  };

  const handlePermissionCheck = (webContents, permission) => {
    const allowed = ['media', 'mediaKeySystem', 'protected-media-identifier', 'notifications', 'pointerLock', 'fullscreen', 'audioCapture', 'videoCapture', 'storage-access', 'clipboard-read', 'clipboard-sanitized-write', 'local-fonts', 'local-network', 'local-network-access', 'private-network'];
    return allowed.includes(permission);
  };

  torPartitionSession.setPermissionRequestHandler(handlePermissions);
  session.defaultSession.setPermissionRequestHandler(handlePermissions);

  torPartitionSession.setPermissionCheckHandler(handlePermissionCheck);
  session.defaultSession.setPermissionCheckHandler(handlePermissionCheck);

  // User-Agent padrão moderno e realista do Chrome para compatibilidade máxima (Google, Spotify, etc.)
  const modernChromeUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  torPartitionSession.setUserAgent(modernChromeUA);
  session.defaultSession.setUserAgent(modernChromeUA);

  // Garante que cabeçalhos HTTP reflitam um navegador Chrome desktop autêntico (evitando bloqueio anti-bot do YouTube/Google)
  const setDesktopHeaders = (details, callback) => {
    const headers = Object.assign({}, details.requestHeaders);
    headers['User-Agent'] = modernChromeUA;
    headers['Sec-Ch-Ua'] = '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"';
    headers['Sec-Ch-Ua-Mobile'] = '?0';
    headers['Sec-Ch-Ua-Platform'] = '"Linux"';
    headers['Upgrade-Insecure-Requests'] = '1';
    delete headers['X-Electron-Version'];
    delete headers['x-electron-version'];

    // Se for requisição para embed do YouTube ou streaming de vídeo, garante Referer e Origin válidos.
    // O YouTube bloqueia com Erro 152-4 se o Referer for 'https://www.youtube.com/' ou se for 'file://'/nulo.
    if (details.url && (details.url.includes('youtube.com') || details.url.includes('youtube-nocookie.com') || details.url.includes('googlevideo.com') || details.url.includes('youtu.be'))) {
      const currentRef = headers['Referer'] || headers['referer'] || '';
      if (!currentRef || currentRef.startsWith('file:') || currentRef.includes('youtube.com') || currentRef.includes('youtu.be')) {
        headers['Referer'] = 'http://localhost:8080/';
        headers['Origin'] = 'http://localhost:8080';
      }
    }

    callback({ requestHeaders: headers });
  };

  session.defaultSession.webRequest.onBeforeSendHeaders(setDesktopHeaders);
  torPartitionSession.webRequest.onBeforeSendHeaders(setDesktopHeaders);

  // Permite que players de filmes e transmissões embutidas carreguem sem restrições de X-Frame-Options
  const allowFrameHeaders = (details, callback) => {
    const responseHeaders = Object.assign({}, details.responseHeaders);
    // Remove cabeçalhos que impedem a exibição em iframe
    delete responseHeaders['x-frame-options'];
    delete responseHeaders['X-Frame-Options'];
    const cleanCsp = (cspList) => {
      if (!Array.isArray(cspList)) return [];
      return cspList
        .map(policy => policy.replace(/frame-ancestors\s+[^;]+(;|$)/gi, '').trim())
        .filter(policy => policy.length > 0);
    };

    if (responseHeaders['content-security-policy']) {
      const cleaned = cleanCsp(responseHeaders['content-security-policy']);
      if (cleaned.length > 0) responseHeaders['content-security-policy'] = cleaned;
      else delete responseHeaders['content-security-policy'];
    }
    if (responseHeaders['Content-Security-Policy']) {
      const cleaned = cleanCsp(responseHeaders['Content-Security-Policy']);
      if (cleaned.length > 0) responseHeaders['Content-Security-Policy'] = cleaned;
      else delete responseHeaders['Content-Security-Policy'];
    }
    callback({ responseHeaders });
  };

  session.defaultSession.webRequest.onHeadersReceived(allowFrameHeaders);
  torPartitionSession.webRequest.onHeadersReceived(allowFrameHeaders);

  // Inicializa o adblocker na sessão Tor persistente e na sessão padrão da janela
  setupAdblocker(torPartitionSession);
  setupAdblocker(session.defaultSession);

  // Nenhum link abre janela do sistema: a URL volta para uma aba do Papaléguas.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openUrlInsideApp(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
    if (!guestContents || typeof guestContents.setWindowOpenHandler !== 'function') return;
    guestContents.setWindowOpenHandler(({ url }) => {
      openUrlInsideApp(url);
      return { action: 'deny' };
    });
  });

  // Impede que a janela principal seja redirecionada por scripts invasivos de terceiros
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!navigationUrl.startsWith('file://') && !navigationUrl.includes('localhost') && !navigationUrl.includes('127.0.0.1')) {
      console.log('[Anti-Redirect] Redirecionamento da janela principal bloqueado.');
      event.preventDefault();
    }
  });

  mainWindow.on('close', (e) => {
    if (forceQuitBrowser) {
      // A janela ainda está viva aqui, então dá para perguntar sobre os
      // favoritos e apagar os rastros antes de ela sumir.
      if (tracesCleared) return;
      e.preventDefault();
      askAboutBookmarks()
        .catch(() => {})
        .then(() => clearAllBrowsingData())
        .catch(() => {})
        .finally(() => {
          tracesCleared = true;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
        });
      return;
    }
    e.preventDefault();
    requestYoutubePipOrClose();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers
ipcMain.handle('clear-browsing-traces', async () => {
  await clearAllBrowsingData();
  return { success: true };
});

ipcMain.handle('get-saved-bookmarks', async () => readSavedBookmarks());

ipcMain.handle('get-tor-status', async () => {
  const status = await torManager.checkTorStatus();
  return {
    ...status,
    enabled: Boolean(torEnabled),
    connected: Boolean(torEnabled && status.connected),
    serverConnected: Boolean(status.connected),
    locked: false
  };
});

ipcMain.handle('toggle-tor', async (event, enabled) => {
  if (typeof enabled === 'boolean') {
    torEnabled = enabled;
  } else {
    torEnabled = !torEnabled;
  }
  await applyTorRouting();
  const status = await torManager.checkTorStatus();
  return {
    ...status,
    enabled: Boolean(torEnabled),
    connected: Boolean(torEnabled && status.connected),
    serverConnected: Boolean(status.connected),
    locked: false
  };
});

ipcMain.handle('get-newtab-url', () => {
  return 'file://' + path.join(__dirname, '../src/newtab.html');
});

ipcMain.handle('get-adblock-status', () => {
  return getAdblockStatus();
});

ipcMain.handle('toggle-adblock', (event, enabled) => {
  const status = toggleAdblock(enabled);
  try {
    const { webContents } = require('electron');
    webContents.getAllWebContents().forEach(wc => {
      try { wc.send('adblock-status-changed', status); } catch (e) {}
    });
  } catch (e) {}
  return status;
});

ipcMain.handle('get-tor-ip-info', async () => {
  try {
    const torPartitionSession = session.fromPartition('persist:tor-browser');
    const { net } = require('electron');
    return new Promise((resolve) => {
      const request = net.request({
        url: 'https://check.torproject.org/api/ip',
        session: torPartitionSession
      });

      let responseData = '';
      request.on('response', (response) => {
        response.on('data', (chunk) => {
          responseData += chunk.toString();
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch (e) {
            resolve({ error: 'Falha ao processar resposta do Tor' });
          }
        });
      });

      request.on('error', (err) => {
        resolve({ error: err.message });
      });

      request.end();
    });
  } catch (err) {
    return { error: err.message };
  }
});

// IA GPT Astra: Agente Autônomo com Navegação Própria
ipcMain.handle('query-astra-ai', async (event, prompt) => {
  try {
    const torPartitionSession = session.fromPartition('persist:tor-browser');
    return await runGptNavigator(prompt, torPartitionSession);
  } catch (err) {
    return `Erro do Agente GPT Astra: ${err.message}`;
  }
});

// Execução direta de código Python / Node / Bash
ipcMain.handle('execute-code-direct', async (event, { language, code }) => {
  try {
    const { executeCode } = require('./code-runner');
    return await executeCode(language, code, 15000);
  } catch (err) {
    return { success: false, stdout: '', stderr: err.message, executionTimeMs: 0 };
  }
});

// Controles da Janela do Navegador (Minimizar, Maximizar/Restaurar, Fechar)
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

function requestYoutubePipOrClose() {
  if (!mainWindow || mainWindow.isDestroyed() || forceQuitBrowser) return;
  if (pipQueryPending) return;
  pipQueryPending = true;
  try {
    mainWindow.webContents.send('query-youtube-pip');
    setTimeout(() => {
      if (!pipQueryPending || forceQuitBrowser) return;
      pipQueryPending = false;
      if (ytPipWindow && !ytPipWindow.isDestroyed()) return;
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        forceQuitBrowser = true;
        mainWindow.close();
      }
    }, 2200);
  } catch (err) {
    pipQueryPending = false;
    forceQuitBrowser = true;
    mainWindow.close();
  }
}

ipcMain.on('window-close', () => {
  requestYoutubePipOrClose();
});

function closeYtPipWindow() {
  if (ytPipWindow && !ytPipWindow.isDestroyed()) {
    try { ytPipWindow.close(); } catch (e) {}
  }
  ytPipWindow = null;
}

function showYtPipWindow(state) {
  if (!state || !state.videoId) return;
  closeYtPipWindow();
  const title = String(state.title || 'BaixaTube').slice(0, 80);
  const start = Math.max(0, parseInt(state.currentTime || 0, 10) || 0);
  const query = 'v=' + encodeURIComponent(state.videoId) +
    '&t=' + encodeURIComponent(String(start)) +
    '&title=' + encodeURIComponent(title);
  const pipHttp = 'http://127.0.0.1:8080/yt-pip.html?' + query;
  const pipFile = path.join(__dirname, '../src/yt-pip.html');

  const width = 340;
  const height = 232;
  let x = 24;
  let y = 24;
  try {
    const area = screen.getPrimaryDisplay().workArea;
    x = Math.max(12, area.x + area.width - width - 18);
    y = Math.max(12, area.y + area.height - height - 18);
  } catch (e) {}

  ytPipWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 220,
    minHeight: 150,
    backgroundColor: '#0b1220',
    alwaysOnTop: true,
    skipTaskbar: true,
    frame: false,
    resizable: true,
    movable: true,
    hasShadow: true,
    show: false,
    focusable: true,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  try { ytPipWindow.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {
    try { ytPipWindow.setAlwaysOnTop(true); } catch (err) {}
  }
  try { ytPipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
  ytPipWindow.loadURL(pipHttp);
  ytPipWindow.webContents.once('did-fail-load', () => {
    try { ytPipWindow.loadFile(pipFile, { query: { v: state.videoId, t: String(start), title } }); } catch (e) {}
  });
  ytPipWindow.once('ready-to-show', () => {
    if (ytPipWindow && !ytPipWindow.isDestroyed()) {
      ytPipWindow.showInactive();
      ytPipWindow.moveTop();
    }
  });
  ytPipWindow.on('closed', () => {
    ytPipWindow = null;
    if (forceQuitBrowser) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      app.quit();
    }
  });
}

ipcMain.on('youtube-pip-offer', (event, state) => {
  const fromWindowClose = pipQueryPending;
  pipQueryPending = false;
  const videoId = state && (state.videoId || state.id);
  if (videoId) {
    showYtPipWindow(Object.assign({}, state, { videoId, isPlaying: true }));
    if (fromWindowClose && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
    return;
  }
  if (fromWindowClose) {
    forceQuitBrowser = true;
    closeYtPipWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  }
});

ipcMain.on('restore-main-from-pip', () => {
  closeYtPipWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    forceQuitBrowser = false;
    createWindow();
  }
});

ipcMain.on('close-pip-and-quit', () => {
  forceQuitBrowser = true;
  closeYtPipWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  } else {
    app.quit();
  }
});

// Transmissão para Smart TVs / Telas na Rede Local (Roku, DLNA, Cast)
ipcMain.handle('get-cast-devices', async () => {
  return [];
});

ipcMain.handle('scan-client-lan', async () => {
  try {
    const castManager = require('./cast-manager');
    if (typeof castManager.discoverRokuOnThisMachine === 'function') {
      return await castManager.discoverRokuOnThisMachine();
    }
  } catch (e) {}
  return [];
});

ipcMain.handle('cast-to-device', async () => {
  return {
    success: false,
    clientCastRequired: true,
    error: 'A transmissão deve sair do seu aparelho para a TV do seu Wi-Fi. O servidor não envia sinal para a rede dele.'
  };
});

ipcMain.handle('open-screen-mirroring', async () => {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    // Tenta abrir o painel de Wi-Fi / Rede / Displays do sistema para Miracast
    exec('gnome-control-center wifi || gnome-control-center display', (err) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true });
      }
    });
  });
});

ipcMain.handle('open-external-url', async (event, url) => {
  if (!url) return { success: false, error: 'URL inválida' };
  openUrlInsideApp(url);
  return { success: true };
});

function searchDeezer(query, limit = 30, order = 'RANKING', index = 0) {
  const trimmed = (query || '').trim();
  const isTrending = !trimmed || trimmed.toLowerCase().match(/^(bombando|atual|atuais|em alta|top|paradas|hits|sucessos|mais tocadas|2026|2025)$/);

  if (isTrending && index === 0) {
    return getDeezerChartTracks(limit);
  }

  const effectiveQuery = isTrending ? 'hits bombando 2026' : trimmed;

  const https = require('https');
  return new Promise((resolve) => {
    const url = 'https://api.deezer.com/search?q=' + encodeURIComponent(effectiveQuery) + '&limit=' + limit + '&order=' + order + '&index=' + index;
    const req = https.get(url, { agent: getNodeTorAgent(), headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.data || []).map(item => ({
            id: item.id,
            title: item.title,
            artist: item.artist ? item.artist.name : 'Desconhecido',
            album: item.album ? item.album.title : '',
            cover: item.album && item.album.cover_medium ? item.album.cover_medium : (item.artist ? item.artist.picture_medium : ''),
            duration: item.duration || 0,
            preview: item.preview || '',
            rank: item.rank || 0
          }));
          // Ordena por popularidade/relevância (mais ouvidas)
          results.sort((a, b) => (b.rank || 0) - (a.rank || 0));
          resolve({ success: true, results });
        } catch (e) {
          resolve({ success: false, error: e.message, results: [] });
        }
      });
    });
    req.on('error', (err) => {
      resolve({ success: false, error: err.message, results: [] });
    });
    req.setTimeout(6000, () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout', results: [] });
    });
  });
}

// Busca músicas bombando e mais tocadas do momento nas paradas oficiais
function getDeezerChartTracks(limit = 16) {
  const https = require('https');
  return new Promise((resolve) => {
    const url = `https://api.deezer.com/chart/0/tracks?limit=${limit}`;
    const req = https.get(url, { agent: getNodeTorAgent(), headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.data || []).map(item => ({
            id: item.id,
            title: item.title,
            artist: item.artist ? item.artist.name : 'Desconhecido',
            album: item.album ? item.album.title : '',
            cover: item.album && item.album.cover_medium ? item.album.cover_medium : (item.artist ? item.artist.picture_medium : ''),
            duration: item.duration || 0,
            preview: item.preview || '',
            rank: item.rank || 999999,
            aiReason: '🔥 Top 1 Paradas Mundiais / Brasil 2026'
          }));
          resolve({ success: true, results });
        } catch (e) {
          resolve({ success: false, error: e.message, results: [] });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message, results: [] }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ success: false, error: 'Timeout', results: [] }); });
  });
}

const { execFile } = require('child_process');

// Extrai a stream de áudio completa via yt-dlp (otimizado sem travar)
ipcMain.handle('get-full-audio-stream', async (event, { title, artist }) => {
  if (!title && !artist) return { success: false, error: 'Sem parâmetros de busca' };
  const query = `${title || ''} ${artist || ''} official audio`.trim();
  const fs = require('fs');
  const ytdlpPath = process.platform === 'win32' ? 'yt-dlp' : (fs.existsSync('/home/nain/.local/bin/yt-dlp') ? '/home/nain/.local/bin/yt-dlp' : 'yt-dlp');

  return new Promise((resolve) => {
    // Áudio do Papaléguas Music sai direto, sem proxy Tor
    execFile(ytdlpPath, [
      '--no-playlist',
      '-f', 'ba/b',
      '--no-warnings',
      '-g',
      `ytsearch1:${query}`
    ], { timeout: 12000 }, (error, stdout) => {
      if (error) {
        execFile(ytdlpPath, [
          '--no-playlist',
          '-f', 'ba/b',
          '--no-warnings',
          '-g',
          `ytsearch1:${title} ${artist}`
        ], { timeout: 10000 }, (err2, stdout2) => {
          if (err2) {
            console.warn('[AUDIO STREAM] Erro ao extrair áudio completo:', err2.message);
            resolve({ success: false, error: err2.message });
            return;
          }
          const streamUrl = (stdout2 || '').trim().split('\n')[0];
          if (streamUrl && streamUrl.startsWith('http')) {
            resolve({ success: true, streamUrl });
          } else {
            resolve({ success: false, error: 'URL de stream inválida' });
          }
        });
        return;
      }
      const streamUrl = (stdout || '').trim().split('\n')[0];
      if (streamUrl && streamUrl.startsWith('http')) {
        resolve({ success: true, streamUrl });
      } else {
        resolve({ success: false, error: 'URL de stream inválida' });
      }
    });
  });
});

// Busca playlists no acervo Deezer
function searchDeezerPlaylists(query, limit = 12) {
  const https = require('https');
  return new Promise((resolve) => {
    const url = 'https://api.deezer.com/search/playlist?q=' + encodeURIComponent(query.trim()) + '&limit=' + limit;
    const req = https.get(url, { agent: getNodeTorAgent(), headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.data || []).map(item => ({
            id: item.id,
            title: item.title,
            creator: item.user ? item.user.name : 'Spotify Curador',
            cover: item.picture_medium || item.picture_big || '',
            nb_tracks: item.nb_tracks || 0,
            type: 'playlist'
          }));
          resolve({ success: true, results });
        } catch (e) {
          resolve({ success: false, error: e.message, results: [] });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message, results: [] }));
    req.setTimeout(6000, () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout', results: [] });
    });
  });
}

// Carrega as músicas de dentro de uma playlist
function fetchDeezerPlaylistTracks(playlistId) {
  const https = require('https');
  return new Promise((resolve) => {
    const url = `https://api.deezer.com/playlist/${playlistId}`;
    const req = https.get(url, { agent: getNodeTorAgent(), headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => {
        if (data.length < 1500000) data += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const rawTracks = Array.isArray(json.data) ? json.data : ((json.tracks && json.tracks.data) ? json.tracks.data : []);
          const tracks = rawTracks.map(item => ({
            id: item.id,
            title: item.title,
            artist: item.artist ? item.artist.name : 'Desconhecido',
            album: item.album ? item.album.title : json.title,
            cover: item.album && item.album.cover_medium ? item.album.cover_medium : (json.picture_medium || ''),
            duration: item.duration || 0,
            preview: item.preview || '',
            rank: item.rank || 0
          }));
          resolve({
            success: tracks.length > 0,
            title: json.title,
            cover: json.picture_medium || '',
            creator: json.creator ? json.creator.name : '',
            tracks
          });
        } catch (e) {
          resolve({ success: false, error: e.message, tracks: [] });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message, tracks: [] }));
    req.setTimeout(6000, () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout', tracks: [] });
    });
  });
}

// Busca mista para o menu 'Tudo' (Músicas, Playlists, Artistas e Álbuns misturados)
async function searchDeezerAll(query) {
  const [tracksRes, playlistsRes] = await Promise.all([
    searchDeezer(query, 12, 'RANKING'),
    searchDeezerPlaylists(query, 6)
  ]);

  const tracks = (tracksRes.success && tracksRes.results) ? tracksRes.results : [];
  const playlists = (playlistsRes.success && playlistsRes.results) ? playlistsRes.results : [];

  // Intercala os resultados para criar uma lista rica e variada
  const mixed = [];
  const maxLen = Math.max(tracks.length, playlists.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < tracks.length) mixed.push({ ...tracks[i], itemType: 'track' });
    if (i < playlists.length) mixed.push({ ...playlists[i], itemType: 'playlist' });
  }

  return { success: true, results: mixed };
}

// Busca de músicas para o Mini Player (Deezer Public Music API com ordenação de mais tocadas e paginação)
ipcMain.handle('search-music', async (event, query, limit = 30, index = 0) => {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { success: false, results: [] };
  }
  return await searchDeezer(query, limit, 'RANKING', index);
});

// Busca de playlists dedicadas para a categoria Playlists
ipcMain.handle('search-playlists', async (event, query) => {
  if (!query || typeof query !== 'string' || !query.trim()) {
    query = 'top hits 2026';
  }
  return await searchDeezerPlaylists(query, 12);
});

// Busca mista para a categoria 'Tudo'
ipcMain.handle('search-all', async (event, query) => {
  if (!query || typeof query !== 'string') {
    query = '';
  }
  return await searchDeezerAll(query);
});

// Obtém as faixas de uma playlist selecionada
ipcMain.handle('get-playlist-tracks', async (event, playlistId) => {
  if (!playlistId) return { success: false, tracks: [] };
  return await fetchDeezerPlaylistTracks(playlistId);
});

ipcMain.handle('get-ai-music-recommendations', async (event, query, category = 'all', excludeTitles = []) => {
  if (!papaleguasServer || typeof papaleguasServer.getAiMusicRecommendations !== 'function') {
    return { tracks: [], source: 'error' };
  }
  return papaleguasServer.getAiMusicRecommendations(query, category, excludeTitles);
});

function normalizeDjText(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function isCasualDjChat(text) {
  const t = normalizeDjText(text);
  return /^(oi+|ola+|e ?ai+|eae+|fala+|hey+|hi+|hello+|bom dia|boa tarde|boa noite|tudo bem\??|td bem\??|blz\??|beleza+|obrigad[oa]|valeu+|tchau+)[\s!?.]*$/.test(t);
}

function cleanDjSearchQuery(text) {
  const cleaned = String(text || '')
    .replace(/^(dj papaleguas|dj papaléguas|papaleguas|dj)\s+/i, '')
    .replace(/^\s*(por favor|pfv|pf|please)\s+/i, '')
    .replace(/^\s*(toca|tocar|toque|play|põe|poe|coloca|solta|reproduz|quero ouvir|quero escutar|quero|me toca|bota pra tocar|põe pra tocar|poe pra tocar|bota|manda)\s+/i, '')
    .replace(/^\s*(pra|para)\s+(mim|gente|nós|nos)\s+/i, '')
    .replace(/^\s*(aquela|aquele|essa|esse|isto|uns|umas|uma|um)\s+((m[uú]sica|som|faixa)\s+)?(do|da|de|dos|das)?\s*/i, '')
    .replace(/^\s*(m[uú]sica|som|faixa)\s+(do|da|de|dos|das)\s+/i, '')
    .replace(/\s+(por favor|pfv|pf|please|pra mim|para mim|agora)\s*$/i, '')
    .trim();
  return cleaned || String(text || '').trim();
}

const DJ_QUERY_STOPWORDS = new Set([
  'toca', 'tocar', 'toque', 'play', 'poe', 'coloca', 'solta', 'reproduz', 'quero', 'ouvir', 'escutar',
  'musica', 'musicas', 'som', 'uma', 'um', 'uns', 'umas', 'pra', 'para', 'com', 'do', 'da', 'de',
  'o', 'a', 'os', 'as', 'me', 'mim', 'dj', 'papaleguas', 'por', 'favor', 'pfv', 'pf', 'bota', 'manda',
  'agora', 'ai', 'essa', 'esse', 'aquele', 'aquela', 'mais', 'bem', 'tipo', 'estilo', 'faz'
]);

function queryTokens(query) {
  return normalizeDjText(query).split(/[^a-z0-9]+/).filter((w) => w && !DJ_QUERY_STOPWORDS.has(w) && w.length >= 2);
}

function fuzzyWordMatch(word, text) {
  if (!word || !text) return false;
  if (text.includes(word)) return true;
  if (word.length < 4) return false;
  return text.split(/[^a-z0-9]+/).some((part) => {
    if (!part) return false;
    if (part.includes(word) || (word.includes(part) && part.length >= 4)) return true;
    return part.length >= 4 && word.slice(0, 4) === part.slice(0, 4);
  });
}

function scoreTrackAgainstQuery(track, query) {
  const q = normalizeDjText(query);
  const title = normalizeDjText(track && track.title);
  const artist = normalizeDjText(track && track.artist);
  if (!q || !title) return 0;
  let score = 0;
  if (title === q) score += 140;
  if ((title + ' ' + artist) === q || (artist + ' ' + title) === q) score += 130;
  if (title.includes(q)) score += 80;
  if (q.includes(title) && title.length > 3) score += 55;
  if (artist && (q === artist || q.includes(artist) || artist.includes(q))) score += 50;
  queryTokens(q).forEach((w) => {
    if (fuzzyWordMatch(w, title)) score += 18;
    if (fuzzyWordMatch(w, artist)) score += 16;
  });
  return score;
}

function sortTracksByQuery(tracks, query) {
  return (tracks || []).slice().sort((a, b) => scoreTrackAgainstQuery(b, query) - scoreTrackAgainstQuery(a, query));
}

const DJ_GENRE_CATALOG = [
  { label: 'pop nacional', keys: ['pop nacional', 'pop brasil', 'pop brasileiro', 'pop br'], byPlaylist: true, playlistQuery: 'pop nacional', playlistKeys: ['pop nacional', 'pop brasil', 'pop'], queries: ['pop nacional', 'pop brasil'] },
  { label: 'ragga nacional', keys: ['ragga nacional', 'ragga brasil', 'raggae nacional', 'ragga', 'raggae'], byPlaylist: true, playlistQuery: 'raggae nacional', playlistKeys: ['ragga', 'raggae', 'reggae'], queries: ['ragga nacional', 'raggae brasil', 'ragga hits'] },
  { label: 'gaúcha', keys: ['gaucho', 'gauchos', 'musica gaucha', 'musicas gauchas', 'gaucha', 'gauchas', 'tradicionalista', 'tradicionalismo gaucho', 'vanera', 'vanerao', 'tche'], byPlaylist: true, playlistQuery: 'musicas gauchas', playlistKeys: ['gaucho', 'gaucha', 'gauchas', 'vanera', 'tche'], queries: ['musicas gauchas', 'musica gaucha sucessos', 'tradicionalismo gaucho'] },
  { label: 'psytrance', keys: ['psy', 'psytrance', 'psy trance', 'psy-trance', 'psychedelic trance'], byPlaylist: true, playlistQuery: 'psytrance', playlistKeys: ['psy', 'psytrance', 'trance'], queries: ['psytrance hits', 'psy trance'] },
  { label: 'rock nacional', keys: ['rock nacional', 'rock brasil', 'rock brasileiro'], byPlaylist: true, playlistQuery: 'rock nacional', playlistKeys: ['rock nacional', 'rock brasil', 'rock'], queries: ['rock nacional hits', 'rock brasil'] },
  { label: 'reggae nacional', keys: ['reggae nacional', 'reggae brasil'], byPlaylist: true, playlistQuery: 'reggae nacional', playlistKeys: ['reggae nacional', 'reggae brasil', 'reggae'], queries: ['reggae nacional', 'reggae brasil'] },
  { label: 'rap nacional', keys: ['rap nacional', 'rap brasil', 'hip hop nacional', 'hiphop nacional'], byPlaylist: true, playlistQuery: 'rap nacional', playlistKeys: ['rap nacional', 'rap brasil', 'rap'], queries: ['rap nacional', 'rap brasil'] },
  { label: 'flashback nacional', keys: ['flashback nacional', 'flash back nacional'], byPlaylist: true, playlistQuery: 'flashback nacional', playlistKeys: ['flashback', 'flash back', 'anos 80', 'anos 90'], queries: ['flashback nacional', 'sucessos nacionais anos 80 90'] },
  { label: 'flashback', keys: ['flashback', 'flash back', 'flashbak', 'flash bak', 'retro', 'vintage'], queries: ['flashback hits', 'sucessos anos 80', 'sucessos anos 90', 'flashback'] },
  { label: 'anos 70', keys: ['anos 70', 'anos70'], queries: ['hits anos 70', 'sucessos anos 70'] },
  { label: 'anos 80', keys: ['anos 80', 'anos80'], queries: ['hits anos 80', 'sucessos anos 80'] },
  { label: 'anos 90', keys: ['anos 90', 'anos90'], queries: ['hits anos 90', 'sucessos anos 90'] },
  { label: 'anos 2000', keys: ['anos 2000', 'anos 2000s'], queries: ['hits anos 2000', 'sucessos anos 2000'] },
  { label: 'dance', keys: ['dance', 'danca', 'dancante'], queries: ['genre:"Dance"', 'dance hits', 'musica dance'] },
  { label: 'eurodance', keys: ['eurodance'], queries: ['eurodance hits', 'genre:"Dance"'] },
  { label: 'house', keys: ['house'], queries: ['genre:"House"', 'house music hits'] },
  { label: 'techno', keys: ['techno'], queries: ['genre:"Techno"', 'techno hits'] },
  { label: 'trance', keys: ['trance'], queries: ['trance hits'] },
  { label: 'disco', keys: ['disco'], queries: ['disco hits', 'genre:"Disco"'] },
  { label: 'eletrônica', keys: ['eletronica', 'eletronic', 'edm'], queries: ['genre:"Electro"', 'electronic dance hits'] },
  { label: 'sertanejo', keys: ['sertanejo', 'universitario', 'agronejo', 'modao'], queries: ['genre:"Sertanejo"', 'sertanejo sucessos'] },
  { label: 'pagode', keys: ['pagode'], queries: ['pagode sucessos', 'pagode hits'] },
  { label: 'samba', keys: ['samba'], queries: ['samba sucessos'] },
  { label: 'funk', keys: ['funk'], queries: ['funk hits brasil', 'funk sucessos'] },
  { label: 'gospel', keys: ['gospel', 'louvor'], queries: ['gospel sucessos', 'louvor hits'] },
  { label: 'forró', keys: ['forro', 'piseiro'], queries: ['forro sucessos', 'piseiro hits'] },
  { label: 'axé', keys: ['axe'], queries: ['axe sucessos'] },
  { label: 'rock', keys: ['rock'], queries: ['genre:"Rock"', 'rock hits'] },
  { label: 'pop', keys: ['pop'], queries: ['genre:"Pop"', 'pop hits'] },
  { label: 'rap', keys: ['rap', 'trap', 'hip hop', 'hiphop'], queries: ['rap hits'] },
  { label: 'mpb', keys: ['mpb'], queries: ['mpb sucessos'] },
  { label: 'jazz', keys: ['jazz'], queries: ['jazz hits'] },
  { label: 'blues', keys: ['blues'], queries: ['blues hits'] },
  { label: 'reggae', keys: ['reggae'], queries: ['reggae hits'] },
  { label: 'arrocha', keys: ['arrocha'], queries: ['arrocha sucessos'] },
  { label: 'brega', keys: ['brega'], queries: ['brega sucessos'] },
  { label: 'romântica', keys: ['romantica', 'romantico'], queries: ['musicas romanticas sucessos'] },
  { label: 'phonk', keys: ['phonk'], queries: ['phonk hits'] },
  { label: 'k-pop', keys: ['kpop', 'k-pop'], queries: ['kpop hits'] },
  { label: 'lo-fi', keys: ['lofi', 'lo-fi'], queries: ['lofi beats'] }
];

function detectDjGenre(text) {
  const t = normalizeDjText(text);
  if (!t) return null;
  let best = null;
  let bestLen = 0;
  DJ_GENRE_CATALOG.forEach((genre) => {
    (genre.keys || []).forEach((key) => {
      const nk = normalizeDjText(key);
      if (!nk) return;
      const re = new RegExp('(?:^|\\b)' + nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\b|$)');
      if (re.test(t) && nk.length >= bestLen) {
        best = genre;
        bestLen = nk.length;
      }
    });
  });
  return best;
}

function detectDjGenres(text) {
  const t = normalizeDjText(text);
  if (!t) return [];
  const found = [];
  DJ_GENRE_CATALOG.forEach((genre) => {
    let hitLen = 0;
    (genre.keys || []).forEach((key) => {
      const nk = normalizeDjText(key);
      if (!nk || nk.length < hitLen) return;
      const re = new RegExp('(?:^|\\b)' + nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\b|$)');
      if (re.test(t)) hitLen = nk.length;
    });
    if (hitLen) found.push({ genre, hitLen });
  });
  found.sort((a, b) => b.hitLen - a.hitLen);
  const genres = [];
  found.forEach((item) => {
    const label = normalizeDjText(item.genre.label);
    const covered = genres.some((other) => {
      const otherLabel = normalizeDjText(other.label);
      return otherLabel.length > label.length && otherLabel.indexOf(label) !== -1;
    });
    if (covered || genres.some((other) => other.label === item.genre.label)) return;
    genres.push(item.genre);
  });
  return genres;
}

function interleaveTrackLists(lists, limit) {
  const seen = new Set();
  const out = [];
  let index = 0;
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    (lists || []).forEach((list) => {
      if (!list || index >= list.length || out.length >= limit) return;
      const track = list[index];
      const key = normalizeDjText((track && track.title) + '|' + (track && track.artist));
      progressed = true;
      if (!track || !key || seen.has(key)) return;
      seen.add(key);
      out.push(track);
    });
    index += 1;
  }
  return out;
}

function djStylePlaylistName(labels, fallback) {
  const nice = (labels || []).filter(Boolean).map((label) => {
    const text = String(label);
    return text.charAt(0).toUpperCase() + text.slice(1);
  });
  if (nice.length) return nice.join(' + ');
  const cleaned = String(fallback || '').trim();
  return (cleaned || 'Playlist do DJ').slice(0, 60);
}

async function searchDjGenreMusic(genre, limit = 30) {
  if (papaleguasServer && typeof papaleguasServer.searchDjGenreMusic === 'function') {
    return papaleguasServer.searchDjGenreMusic(genre, limit);
  }
  const seen = new Set();
  const all = [];
  const queries = (genre && genre.queries) ? genre.queries : [];
  for (const q of queries) {
    try {
      const res = await searchDeezer(q, limit, 'RANKING');
      ((res && res.results) || []).forEach((t) => {
        const key = normalizeDjText((t.title || '') + '|' + (t.artist || ''));
        if (!key || seen.has(key)) return;
        seen.add(key);
        all.push(Object.assign({}, t, { aiReason: '🎶 Estilo: ' + ((genre && genre.label) || q) }));
      });
    } catch (e) {}
  }
  all.sort((a, b) => (b.rank || 0) - (a.rank || 0));
  return all;
}

async function searchRequestedMusic(queries, limit = 20) {
  const primaryText = (queries || []).join(' ').trim();
  const genre = detectDjGenre(primaryText);
  if (genre) return searchDjGenreMusic(genre, limit);

  const seen = new Set();
  const all = [];
  const uniqueQueries = [];
  (queries || []).forEach((q) => {
    const t = String(q || '').trim();
    if (t && t.length >= 2 && uniqueQueries.indexOf(t) === -1) uniqueQueries.push(t);
  });

  const mainQuery = uniqueQueries[0] || primaryText;

  // 1. Busca playlists prontas diretamente no buscador Deezer para o termo do usuário (ex: "pop nacional", "ragga nacional", "gauchos")
  try {
    const plRes = await searchDeezerPlaylists(mainQuery, 4).catch(() => ({ results: [] }));
    if (plRes && plRes.results && plRes.results.length > 0) {
      const topPlaylists = plRes.results.slice(0, 2);
      const packs = await Promise.all(
        topPlaylists.map((pl) => getDeezerPlaylistTracks(pl.id, Math.max(limit, 25)).catch(() => ({ tracks: [] })))
      );
      packs.forEach((pack, idx) => {
        const plTitle = topPlaylists[idx] ? topPlaylists[idx].title : mainQuery;
        ((pack && pack.tracks) || []).forEach((t) => {
          const key = normalizeDjText((t.title || '') + '|' + (t.artist || ''));
          if (!key || seen.has(key)) return;
          seen.add(key);
          all.push(Object.assign({}, t, { aiReason: '🎧 ' + plTitle }));
        });
      });
    }
  } catch (ePl) {}

  // 2. Busca músicas individuais diretas no buscador Deezer
  const variants = [];
  uniqueQueries.forEach((q) => {
    variants.push(q);
    const tokens = queryTokens(q);
    if (tokens.length >= 1 && tokens.length <= 4 && !/artist:|track:|genre:/.test(q)) {
      variants.push('track:"' + q + '"');
      variants.push('artist:"' + q + '"');
    }
  });

  for (const q of variants.slice(0, 4)) {
    try {
      const res = await searchDeezer(q, limit, 'RANKING');
      ((res && res.results) || []).forEach((t) => {
        const key = normalizeDjText((t.title || '') + '|' + (t.artist || ''));
        if (!key || seen.has(key)) return;
        seen.add(key);
        all.push(Object.assign({}, t, { aiReason: '🎯 Pedido: ' + mainQuery }));
      });
    } catch (e) {}
  }
  return sortTracksByQuery(all, mainQuery);
}

function isGenreOrMoodQuery(text) {
  return !!detectDjGenre(text);
}

function hasDjPlayVerb(text) {
  return /\b(toca|tocar|toque|play|p[oô]e|coloca|solta|reproduz|quero ouvir|quero escutar|quero uma|quero um|me toca|bota|manda|playlist|m[uú]sica|ouvir|escutar)\b/i.test(String(text || ''));
}

function isNonMusicQuestion(text) {
  const t = String(text || '').trim();
  return /^(qual|quais|como|quando|onde|por que|porque|quem|o que|voc[eê])\b/i.test(t) && !/\b(m[uú]sica|som|tocar|ouvir|recomenda|artista|cantor|banda)\b/i.test(t);
}

function shouldSearchCatalog(text) {
  if (isCasualDjChat(text) || isNonMusicQuestion(text)) return false;
  return cleanDjSearchQuery(text).length >= 2 || hasDjPlayVerb(text) || isGenreOrMoodQuery(text);
}

function hasConfidentDjMatch(tracks, query, userMessage) {
  if (!tracks || !tracks.length || !query) return false;
  if (tracks.some(t => t && t.aiReason && (t.aiReason.startsWith('🎧') || t.aiReason.startsWith('🎶')))) return true;
  if (isGenreOrMoodQuery(query) || isGenreOrMoodQuery(userMessage)) return true;
  const best = Math.max.apply(null, tracks.slice(0, 8).map((t) => scoreTrackAgainstQuery(t, query)));
  if (best >= 24) return true;
  if (best >= 12 && hasDjPlayVerb(userMessage)) return true;
  const tokens = queryTokens(query);
  if (tokens.length >= 2 && best >= 12) return true;
  if (tokens.length === 1 && tokens[0].length >= 3 && best >= 12) return true;
  if (tracks.length > 0 && (hasDjPlayVerb(userMessage) || cleanDjSearchQuery(userMessage).length >= 3)) return true;
  return false;
}

function djKeepCurrentReply(reply) {
  return reply || 'Não entendi qual som você quer. A que já tava tocando segue no ar. Manda o nome da música, do artista ou do estilo.';
}

function clampDjTrackCount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(50, n));
}

function djRequestedTrackCount(message, requested) {
  const spoken = String(message || '').match(/\b(\d{1,2})\s*(m[uú]sicas|faixas|sons|tracks)\b/i);
  if (spoken) return clampDjTrackCount(spoken[1]);
  return clampDjTrackCount(requested);
}

function isVagueDjRequest(text) {
  if (detectDjGenre(text)) return false;
  const cleaned = normalizeDjText(cleanDjSearchQuery(text));
  if (!cleaned && hasDjPlayVerb(text)) return true;
  return /^(musica|musicas|som|sons|algo|qualquer|surpresa|mistura|mix|playlist|hit|hits|sucessos)$/.test(cleaned);
}

// Chat Interativo com DJ Papaléguas IA
ipcMain.handle('chat-dj-papaleguas', async (event, userMessage, history = [], excludeTitles = [], trackCount = 10) => {
  if (papaleguasServer && typeof papaleguasServer.chatDjPapaleguas === 'function') {
    return papaleguasServer.chatDjPapaleguas(userMessage, history, excludeTitles, trackCount);
  }
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    return {
      success: false,
      reply: 'Manda ver! Me fala qual som, artista ou estilo você quer curtir agora!',
      results: []
    };
  }

  const playlistSize = djRequestedTrackCount(userMessage, trackCount);
  const excludeText = Array.isArray(excludeTitles) && excludeTitles.length > 0
    ? `REGRA DE OURO - NÃO REPETIR MÚSICAS: O usuário já ouviu ou tem na lista as seguintes músicas: [${excludeTitles.slice(-30).join(', ')}]. NÃO recomende nenhuma dessas. Continue só no que foi pedido.`
    : 'Traga só o que foi pedido, sem completar com outro estilo.';

  // Se o usuário pedir hits atuais ou sons bombando, consulta o Chart em tempo real
  let liveChartContext = '';
  const isTrending = userMessage.toLowerCase().match(/bombando|atual|atuais|em alta|top|parada|hoje|agora|2026|2025|sucessos|lançamentos|tocadas/);
  if (isTrending) {
    try {
      const chartRes = await getDeezerChartTracks(15);
      if (chartRes.success && chartRes.results && chartRes.results.length > 0) {
        liveChartContext = `\nHITS ATUAIS REAIS DO CHART OFICIAL DE 2026:\n` +
          chartRes.results.slice(0, 10).map((t, idx) => `${idx + 1}. "${t.title}" por ${t.artist}`).join('\n') +
          `\nPriorize essas músicas que estão no topo das paradas em 2026!\n`;
      }
    } catch (e) {}
  }

  const promptSystem = `Você é o "DJ Papaléguas", o DJ oficial do Papaléguas Browser, com Grok (xAI) como inteligência principal.
Estamos no ano de 2026.
Sua personalidade: amigável, natural e antenado. Sem falas prontas. Siga o rumo da conversa que o usuário começar.
O usuário está conversando com você no chat para pedir o que quiser ouvir.
${liveChartContext}

REGRA CRÍTICA DE PLAY:
- Primeiro ENTENDA o pedido. Só então toque.
- ESTILO/GÊNERO (dance, flashback, sertanejo, funk, pagode, anos 80, house...) é GÊNERO, não nome de música. searchQuery = o estilo, ex: "dance hits", "flashback".
- understood = true e playMusic = true SOMENTE se você identificou com clareza o que tocar: música, artista, gênero ou playlist.
- Se o pedido for vago, incompleto, mal entendido ou só conversa: understood = false, playMusic = false. Pergunte de novo. NÃO invente playlist.
- Se pediu uma música/artista específico, a PRIMEIRA recommendation DEVE ser exatamente isso.

Instruções:
1. Responda de forma curta e natural (1 a 2 frases).
2. Se for só cumprimento, converse e não force playlist.
3. Priorize 2025/2026 só quando o pedido for hits atuais. Se pediu uma música/artista específico, toque ISSO.
4. Entregue somente o que foi pedido. Não acrescente outro gênero, artista ou música.
5. Quando playMusic for true, monte exatamente ${playlistSize} faixas reais desse pedido, nem mais.
6. NUNCA repita as mesmas músicas a cada pedido.
${excludeText}
7. Para cada música, informe title, artist e reason.

Responda ESTRITAMENTE em formato JSON com o seguinte schema:
{
  "reply": "Soltando agora o que você pediu!",
  "understood": true,
  "playMusic": true,
  "searchQuery": "nome da musica ou artista",
  "recommendations": [
    {
      "title": "Nome da Música",
      "artist": "Nome do Artista",
      "reason": "Por que essa música foi escolhida"
    }
  ]
}`;

  const cleanedUserQuery = cleanDjSearchQuery(userMessage);
  const wantSearch = shouldSearchCatalog(userMessage) && !isVagueDjRequest(userMessage);

  const aiPromise = (async () => {
    try {
      const messages = [{ role: "system", content: promptSystem }];
      if (Array.isArray(history) && history.length > 0) {
        history.slice(-4).forEach(h => {
          if (h.role && h.content) {
            messages.push({ role: h.role === 'dj' ? 'assistant' : 'user', content: String(h.content) });
          }
        });
      }
      messages.push({ role: "user", content: userMessage });
      // DJ Papaléguas Music não passa pelo proxy Tor
      const gptRes = await callOpenAiChat({
        model: "gpt-4o-mini",
        messages,
        response_format: { type: "json_object" },
        temperature: 0.88,
        direct: true
      });
      if (gptRes && gptRes.choices && gptRes.choices[0] && gptRes.choices[0].message) {
        return JSON.parse(gptRes.choices[0].message.content);
      }
    } catch (err) {
      console.warn('Erro no chat do DJ Papaléguas (IA):', err);
    }
    return null;
  })();

  const genreList = detectDjGenres(userMessage + ' ' + cleanedUserQuery);
  const searchPromise = !wantSearch
    ? Promise.resolve({ tracks: [], labels: [] })
    : (async () => {
        if (genreList.length) {
          const lists = await Promise.all(genreList.map((genre) => searchDjGenreMusic(genre, playlistSize).catch(() => [])));
          return {
            tracks: interleaveTrackLists(lists, Math.max(playlistSize, 30)),
            labels: genreList.map((genre) => genre.label)
          };
        }
        return {
          tracks: await searchRequestedMusic([cleanedUserQuery], playlistSize),
          labels: []
        };
      })();

  try {
    const [parsed, genrePack] = await Promise.all([aiPromise, searchPromise]);
    const catalogTracks = (genrePack && genrePack.tracks) || [];
    const blendLabels = (genrePack && genrePack.labels) || [];
    const reply = (parsed && parsed.reply) ? parsed.reply : '';

    if (!wantSearch) {
      return {
        success: true,
        playMusic: false,
        understood: false,
        reply: reply || 'Manda ver quando quiser o som. É só pedir a música, o artista ou o estilo.',
        results: []
      };
    }

    const playlistName = djStylePlaylistName(blendLabels, cleanedUserQuery);
    let matchQuery = blendLabels.length ? blendLabels.join(' ') : cleanedUserQuery;
    let directTracks = blendLabels.length ? catalogTracks : sortTracksByQuery(catalogTracks, matchQuery);

    if (!blendLabels.length && !hasConfidentDjMatch(directTracks, matchQuery, userMessage) && parsed && parsed.searchQuery) {
      const aiQuery = String(parsed.searchQuery).trim();
      if (aiQuery.length >= 2) {
        const extra = await searchRequestedMusic([aiQuery], playlistSize);
        if (hasConfidentDjMatch(extra, aiQuery, userMessage)) {
          directTracks = extra;
          matchQuery = aiQuery;
        }
      }
    }

    if (!blendLabels.length && !hasConfidentDjMatch(directTracks, matchQuery, userMessage)) {
      return {
        success: true,
        playMusic: false,
        understood: false,
        reply: djKeepCurrentReply(reply),
        results: []
      };
    }

    const seen = new Set();
    const unique = (directTracks || []).filter((t) => {
      const key = normalizeDjText((t && t.title || '') + '|' + (t && t.artist || ''));
      if (!key || seen.has(key)) return false;
      seen.add(key);
      t.fullStreamUrl = t.fullStreamUrl || `/api/stream-audio?title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}`;
      return true;
    }).slice(0, playlistSize);

    return {
      success: true,
      playMusic: unique.length > 0,
      understood: unique.length > 0,
      reply: reply || ('Playlist com ' + unique.length + ' músicas de "' + matchQuery + '".'),
      playlistName,
      results: unique
    };
  } catch (err) {
    console.error('Erro no chat do DJ Papaléguas:', err);
    try {
      if (wantSearch) {
        const fb = await searchRequestedMusic([cleanedUserQuery], playlistSize);
        if (hasConfidentDjMatch(fb, cleanedUserQuery, userMessage)) {
          return { success: true, playMusic: true, understood: true, reply: 'Achei o som que você pediu. Tá no ar!', playlistName: djStylePlaylistName([], cleanedUserQuery), results: fb.slice(0, playlistSize) };
        }
      }
    } catch (e2) {}
    return {
      success: true,
      playMusic: false,
      understood: false,
      reply: djKeepCurrentReply(''),
      results: []
    };
  }
});

function favoritePlaylistsRoot() {
  return path.join(app.getPath('music'), 'Papaléguas', 'Minhas playlists favoritas');
}

function safeFavoriteName(value, fallback) {
  const clean = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || fallback || 'Playlist').slice(0, 80);
}

function favoritePlaylistDir(name) {
  const root = path.resolve(favoritePlaylistsRoot());
  const dir = path.resolve(root, safeFavoriteName(name, 'Playlist'));
  if (dir !== root && !dir.startsWith(root + path.sep)) return null;
  return dir;
}

function safeFavoriteFile(fileName) {
  const base = path.basename(String(fileName || 'faixa.mp3'));
  const ext = path.extname(base).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const stem = base.slice(0, base.length - path.extname(base).length)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return (stem || 'faixa') + (ext || '.mp3');
}

function favoriteTrackPath(playlist, fileName) {
  const dir = favoritePlaylistDir(playlist);
  if (!dir) return null;
  const base = path.basename(String(fileName || ''));
  if (!base || base === '.' || base === '..' || base === 'playlist.json' || base.startsWith('.')) return null;
  const target = path.resolve(dir, base);
  if (!target.startsWith(dir + path.sep)) return null;
  return target;
}

function favoriteAudioMime(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.webm') return 'audio/webm';
  return 'application/octet-stream';
}

function favoriteBytes(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (data && data.type === 'Buffer' && Array.isArray(data.data)) return Buffer.from(data.data);
  return null;
}

ipcMain.handle('save-favorite-track', async (_event, payload) => {
  const info = payload || {};
  const dir = favoritePlaylistDir(info.playlist);
  const file = safeFavoriteFile(info.fileName);
  const target = favoriteTrackPath(info.playlist, file);
  const bytes = favoriteBytes(info.data);
  if (!dir || !target || !bytes || bytes.length < 1000) return { success: false };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, bytes);

  // Salva capa da faixa se fornecida
  let savedCoverFile = '';
  if (info.coverData) {
    const coverBytes = favoriteBytes(info.coverData);
    if (coverBytes && coverBytes.length > 50) {
      const ext = info.coverMime === 'image/png' ? '.png' : '.jpg';
      const coverBase = file.replace(/\.[^.]+$/, '') + ext;
      const coverTarget = path.join(dir, coverBase);
      try {
        fs.writeFileSync(coverTarget, coverBytes);
        savedCoverFile = coverBase;
      } catch (e) {}
    }
  }

  // Se a playlist ainda não tem cover.jpg ou foi sinalizada como capa da playlist
  const playlistCoverTarget = path.join(dir, 'cover.jpg');
  if (info.coverData && (!fs.existsSync(playlistCoverTarget) || info.isPlaylistCover)) {
    const coverBytes = favoriteBytes(info.coverData);
    if (coverBytes && coverBytes.length > 50) {
      try {
        fs.writeFileSync(playlistCoverTarget, coverBytes);
      } catch (e) {}
    }
  }

  return { success: true, folder: dir, file: path.basename(target), coverFile: savedCoverFile };
});

ipcMain.handle('save-favorite-playlist-index', async (_event, payload) => {
  const info = payload || {};
  const dir = favoritePlaylistDir(info.name);
  if (!dir) return { success: false };
  fs.mkdirSync(dir, { recursive: true });
  const tracks = (Array.isArray(info.tracks) ? info.tracks : []).map((track) => {
    const file = path.basename(String(track && track.file || ''));
    const target = favoriteTrackPath(info.name, file);
    if (!file || !target || !fs.existsSync(target)) return null;
    return {
      title: String(track.title || 'Faixa').slice(0, 180),
      artist: String(track.artist || 'Artista').slice(0, 180),
      cover: String(track.cover || '').slice(0, 500),
      coverFile: track.coverFile ? path.basename(track.coverFile) : '',
      file
    };
  }).filter(Boolean);

  if (info.coverData) {
    const coverBytes = favoriteBytes(info.coverData);
    if (coverBytes && coverBytes.length > 50) {
      try {
        fs.writeFileSync(path.join(dir, 'cover.jpg'), coverBytes);
      } catch (e) {}
    }
  }

  const manifest = {
    name: safeFavoriteName(info.name, 'Playlist'),
    cover: info.cover || (fs.existsSync(path.join(dir, 'cover.jpg')) ? 'cover.jpg' : ''),
    savedAt: Date.now(),
    tracks
  };
  fs.writeFileSync(path.join(dir, 'playlist.json'), JSON.stringify(manifest, null, 2));
  return { success: true, folder: dir, count: tracks.length };
});

ipcMain.handle('set-favorite-playlist-cover', async (_event, payload) => {
  const info = payload || {};
  const dir = favoritePlaylistDir(info.name);
  if (!dir || !fs.existsSync(dir)) return { success: false, error: 'Pasta não encontrada' };
  const bytes = favoriteBytes(info.coverData);
  if (!bytes || bytes.length < 50) return { success: false, error: 'Imagem inválida' };
  try {
    fs.writeFileSync(path.join(dir, 'cover.jpg'), bytes);
    const manifestPath = path.join(dir, 'playlist.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.cover = 'cover.jpg';
      manifest.savedAt = Date.now();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    const mime = info.coverMime === 'image/png' ? 'image/png' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
    return { success: true, cover: dataUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('list-favorite-playlists', async () => {
  const root = favoritePlaylistsRoot();
  fs.mkdirSync(root, { recursive: true });
  const playlists = [];
  const audioExts = new Set(['.mp3', '.m4a', '.mp4', '.ogg', '.flac', '.wav', '.webm', '.aac', '.opus']);

  // 1. Minhas playlists salvas no diretório padrão de músicas
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    let count = 0;
    let savedAt = 0;
    let name = ent.name;
    let cover = '';
    let actualAudioCount = 0;
    try {
      actualAudioCount = fs.readdirSync(dir).filter(f => audioExts.has(path.extname(f).toLowerCase())).length;
    } catch (e) {}

    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'playlist.json'), 'utf8'));
      name = manifest.name || ent.name;
      savedAt = manifest.savedAt || 0;
      count = Array.isArray(manifest.tracks) ? manifest.tracks.length : 0;
      if (actualAudioCount > count) count = actualAudioCount;
      
      const coverPath = path.join(dir, manifest.cover || 'cover.jpg');
      if (fs.existsSync(coverPath)) {
        const mime = coverPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        const b64 = fs.readFileSync(coverPath).toString('base64');
        cover = `data:${mime};base64,${b64}`;
      } else if (Array.isArray(manifest.tracks) && manifest.tracks[0]) {
        const first = manifest.tracks[0];
        const trackCoverName = first.coverFile || first.file.replace(/\.[^.]+$/, '.jpg');
        const trackCoverPath = path.join(dir, trackCoverName);
        if (fs.existsSync(trackCoverPath)) {
          const mime = trackCoverPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
          const b64 = fs.readFileSync(trackCoverPath).toString('base64');
          cover = `data:${mime};base64,${b64}`;
        } else if (first.cover && first.cover.startsWith('http')) {
          cover = first.cover;
        }
      }
    } catch (e) {
      count = fs.readdirSync(dir).filter((file) => file !== 'playlist.json' && !file.startsWith('.')).length;
    }
    if (count > 0) playlists.push({ name, count, cover, savedAt, folder: dir, source: 'disk' });
  }

  // 2. Pastas de playlists inteiras baixadas em Downloads (ex: Downloads/Goa Trance 🔮 Psytrance)
  try {
    const downloadsDir = path.resolve(app.getPath('downloads'));
    if (fs.existsSync(downloadsDir)) {
      const rootAudioFiles = fs.readdirSync(downloadsDir).filter(f => audioExts.has(path.extname(f).toLowerCase()) && !f.startsWith('.'));
      if (rootAudioFiles.length > 0) {
        playlists.push({
          name: 'Downloads',
          count: rootAudioFiles.length,
          cover: '',
          savedAt: Date.now(),
          folder: downloadsDir,
          source: 'downloads'
        });
      }

      for (const ent of fs.readdirSync(downloadsDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const dir = path.join(downloadsDir, ent.name);
        let audioFiles = [];
        try {
          audioFiles = fs.readdirSync(dir).filter(f => audioExts.has(path.extname(f).toLowerCase()) && !f.startsWith('.'));
        } catch (e) {}
        if (audioFiles.length > 0) {
          // Verifica se já não foi listada
          const exists = playlists.some(p => p.name.toLowerCase() === ent.name.toLowerCase());
          if (!exists) {
            let cover = '';
            // Procura arquivo de imagem de capa na pasta
            try {
              const imgFiles = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
              if (imgFiles.length > 0) {
                const imgPath = path.join(dir, imgFiles[0]);
                const mime = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
                cover = `data:${mime};base64,${fs.readFileSync(imgPath).toString('base64')}`;
              }
            } catch (e) {}
            playlists.push({
              name: ent.name,
              count: audioFiles.length,
              cover,
              savedAt: Date.now(),
              folder: dir,
              source: 'downloads'
            });
          }
        }
      }
    }
  } catch (err) {}

  playlists.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return { success: true, folder: root, playlists };
});

ipcMain.handle('get-favorite-playlist', async (_event, name) => {
  const audioExts = new Set(['.mp3', '.m4a', '.mp4', '.ogg', '.flac', '.wav', '.webm', '.aac', '.opus']);
  let dir = favoritePlaylistDir(name);

  // Se não estiver em Minhas playlists favoritas, checa se é uma pasta dentro de Downloads
  let isFromDownloads = false;
  let isDownloadsRoot = false;
  if (!dir || !fs.existsSync(path.join(dir, 'playlist.json'))) {
    const downloadsDir = path.resolve(app.getPath('downloads'));
    const candidateDownloadsDir = path.join(downloadsDir, name);
    if (fs.existsSync(candidateDownloadsDir) && fs.statSync(candidateDownloadsDir).isDirectory()) {
      dir = candidateDownloadsDir;
      isFromDownloads = true;
    } else if (name.toLowerCase() === 'downloads' || name === '__download__') {
      dir = downloadsDir;
      isFromDownloads = true;
      isDownloadsRoot = true;
    }
  }

  if (!dir || !fs.existsSync(dir)) return { success: false, tracks: [] };

  try {
    let plCover = '';
    const manifestPath = path.join(dir, 'playlist.json');

    // Caso 1: Tem playlist.json
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const playlistCoverTarget = path.join(dir, manifest.cover || 'cover.jpg');
      if (fs.existsSync(playlistCoverTarget)) {
        const mime = playlistCoverTarget.endsWith('.png') ? 'image/png' : 'image/jpeg';
        plCover = `data:${mime};base64,${fs.readFileSync(playlistCoverTarget).toString('base64')}`;
      }

      const tracks = (manifest.tracks || []).map((track) => {
        const target = path.join(dir, track.file);
        if (!fs.existsSync(target)) return null;
        let cover = track.cover || '';
        const trackCoverName = track.coverFile || track.file.replace(/\.[^.]+$/, '.jpg');
        const trackCoverPath = path.join(dir, trackCoverName);
        if (fs.existsSync(trackCoverPath)) {
          const mime = trackCoverPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
          cover = `data:${mime};base64,${fs.readFileSync(trackCoverPath).toString('base64')}`;
        } else if (!cover && plCover) {
          cover = plCover;
        }
        return {
          title: track.title,
          artist: track.artist,
          cover,
          file: isFromDownloads ? `${name}/${track.file}` : track.file,
          playlistName: isFromDownloads ? '__download__' : (manifest.name || name)
        };
      }).filter(Boolean);

      return {
        success: true,
        folder: dir,
        name: manifest.name || safeFavoriteName(name, 'Playlist'),
        cover: plCover,
        tracks
      };
    }

    // Caso 2: Pasta de áudios em Downloads sem manifest (lê direto os arquivos de áudio)
    const files = fs.readdirSync(dir).filter(f => audioExts.has(path.extname(f).toLowerCase()) && !f.startsWith('.'));
    // Procura capa na pasta
    const imgFiles = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
    if (imgFiles.length > 0) {
      const imgPath = path.join(dir, imgFiles[0]);
      const mime = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
      plCover = `data:${mime};base64,${fs.readFileSync(imgPath).toString('base64')}`;
    }

    const tracks = files.map((fileName) => {
      const ext = path.extname(fileName);
      const stem = path.basename(fileName, ext).replace(/^[\d\s.\-_]+/, '').trim() || fileName;
      let artist = name;
      let title = stem;
      if (stem.includes(' - ')) {
        const parts = stem.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }
      return {
        title,
        artist,
        cover: plCover,
        file: isDownloadsRoot ? fileName : `${name}/${fileName}`,
        playlistName: '__download__'
      };
    });

    return {
      success: true,
      folder: dir,
      name,
      cover: plCover,
      tracks
    };
  } catch (e) {
    return { success: false, tracks: [] };
  }
});

ipcMain.handle('read-favorite-track', async (_event, playlist, fileName) => {
  // Se for track baixada diretamente de downloads
  if (playlist === '__download__' || playlist === 'Downloads') {
    const downloadsDir = path.resolve(app.getPath('downloads'));
    const safeRel = String(fileName || '').replace(/^[\\/]+/, '');
    const target = path.resolve(downloadsDir, safeRel);
    if (!target.startsWith(downloadsDir + path.sep) || !fs.existsSync(target)) {
      return { success: false };
    }
    return {
      success: true,
      mime: favoriteAudioMime(target),
      data: fs.readFileSync(target)
    };
  }

  const target = favoriteTrackPath(playlist, fileName);
  if (!target || !fs.existsSync(target)) return { success: false };
  return {
    success: true,
    mime: favoriteAudioMime(target),
    data: fs.readFileSync(target)
  };
});

ipcMain.handle('scan-downloaded-music', async (_event, query) => {
  const q = String(query || '').trim().toLowerCase();
  const results = [];
  const audioExts = new Set(['.mp3', '.m4a', '.mp4', '.ogg', '.flac', '.wav', '.webm', '.aac', '.opus']);
  const maxResults = 150;

  // 1. Escanear pasta Downloads e subpastas imediatas
  try {
    const downloadsDir = path.resolve(app.getPath('downloads'));
    if (fs.existsSync(downloadsDir)) {
      const scanFolder = (dir, depth = 0, folderName = 'Downloads') => {
        if (depth > 2 || results.length >= maxResults) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
          if (results.length >= maxResults) break;
          if (ent.name.startsWith('.')) continue;
          const fullPath = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            scanFolder(fullPath, depth + 1, ent.name);
          } else if (ent.isFile()) {
            const ext = path.extname(ent.name).toLowerCase();
            if (audioExts.has(ext)) {
              const relPath = path.relative(downloadsDir, fullPath);
              const stem = path.basename(ent.name, ext).replace(/^[\d\s.\-_]+/, '').trim() || ent.name;
              let artist = folderName !== 'Downloads' ? folderName : 'Downloads';
              let title = stem;
              if (stem.includes(' - ')) {
                const parts = stem.split(' - ');
                artist = parts[0].trim();
                title = parts.slice(1).join(' - ').trim();
              }
              let trCover = '';
              try {
                const candCover = path.join(dir, 'cover.jpg');
                const candAlbum = path.join(dir, 'album.jpg');
                if (fs.existsSync(candCover)) {
                  trCover = `data:image/jpeg;base64,${fs.readFileSync(candCover).toString('base64')}`;
                } else if (fs.existsSync(candAlbum)) {
                  trCover = `data:image/jpeg;base64,${fs.readFileSync(candAlbum).toString('base64')}`;
                }
              } catch (e) {}

              const fullSearchText = `${title} ${artist} ${ent.name} ${folderName}`.toLowerCase();
              if (!q || fullSearchText.includes(q)) {
                results.push({
                  id: 'dl-' + Buffer.from(relPath).toString('base64').replace(/=/g, ''),
                  title,
                  artist,
                  album: folderName,
                  file: relPath,
                  playlistName: folderName !== 'Downloads' ? folderName : '__download__',
                  source: 'downloads',
                  isDownloaded: true,
                  cover: trCover,
                  type: 'track',
                  itemType: 'track'
                });
              }
            }
          }
        }
      };
      scanFolder(downloadsDir, 0, 'Downloads');
    }
  } catch (err) {
    console.error('Erro ao escanear pasta de downloads:', err);
  }

  // 2. Escanear também Minhas Playlists Favoritas no disco
  try {
    const favRoot = path.resolve(favoritePlaylistsRoot());
    if (fs.existsSync(favRoot)) {
      for (const ent of fs.readdirSync(favRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const plDir = path.join(favRoot, ent.name);
        const manifestPath = path.join(plDir, 'playlist.json');
        let plName = ent.name;
        let plCover = '';
        if (fs.existsSync(manifestPath)) {
          try {
            const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            plName = m.name || ent.name;
            const cPath = path.join(plDir, m.cover || 'cover.jpg');
            if (fs.existsSync(cPath)) {
              const mime = cPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
              plCover = `data:${mime};base64,${fs.readFileSync(cPath).toString('base64')}`;
            }
            if (Array.isArray(m.tracks)) {
              for (const tr of m.tracks) {
                if (results.length >= maxResults) break;
                const searchStr = `${tr.title || ''} ${tr.artist || ''} ${plName}`.toLowerCase();
                if (!q || searchStr.includes(q)) {
                  let trCover = tr.cover || plCover;
                  const trackCoverName = tr.coverFile || (tr.file && tr.file.replace(/\.[^.]+$/, '.jpg'));
                  if (trackCoverName && fs.existsSync(path.join(plDir, trackCoverName))) {
                    const cTarget = path.join(plDir, trackCoverName);
                    const mime = cTarget.endsWith('.png') ? 'image/png' : 'image/jpeg';
                    trCover = `data:${mime};base64,${fs.readFileSync(cTarget).toString('base64')}`;
                  }
                  results.push({
                    id: 'fav-disk-' + Buffer.from(plName + '/' + tr.file).toString('base64').replace(/=/g, ''),
                    title: tr.title,
                    artist: tr.artist,
                    album: plName,
                    file: tr.file,
                    playlistName: plName,
                    source: 'disk',
                    isDownloaded: true,
                    cover: trCover,
                    type: 'track',
                    itemType: 'track'
                  });
                }
              }
            }
          } catch (e) {}
        }
      }
    }
  } catch (err) {
    console.error('Erro ao escanear playlists favoritas no disco:', err);
  }

  return { success: true, count: results.length, results };
});

ipcMain.handle('open-favorite-folder', async (_event, name) => {
  let dir = '';
  if (name === '__download__' || name === 'Downloads') {
    dir = path.resolve(app.getPath('downloads'));
  } else {
    dir = name ? favoritePlaylistDir(name) : favoritePlaylistsRoot();
  }
  if (!dir) return { success: false };
  fs.mkdirSync(dir, { recursive: true });
  const error = await shell.openPath(dir);
  return { success: !error, folder: dir, error: error || '' };
});

ipcMain.handle('create-favorite-playlist', async (_event, name) => {
  const dir = favoritePlaylistDir(name);
  if (!dir) return { success: false, error: 'Nome de playlist inválido' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, 'playlist.json');
    if (!fs.existsSync(manifestPath)) {
      const manifest = {
        name: safeFavoriteName(name, 'Playlist'),
        cover: '',
        savedAt: Date.now(),
        tracks: []
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    return { success: true, folder: dir, name: safeFavoriteName(name, 'Playlist') };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('delete-favorite-playlist', async (_event, name) => {
  const root = favoritePlaylistsRoot();
  const downloadsDir = path.resolve(app.getPath('downloads'));
  let dir = favoritePlaylistDir(name);

  if (!dir || !fs.existsSync(dir)) {
    // Checa se é uma pasta dentro de Downloads
    const candidateDownloadsDir = path.join(downloadsDir, name);
    if (fs.existsSync(candidateDownloadsDir) && fs.statSync(candidateDownloadsDir).isDirectory()) {
      dir = candidateDownloadsDir;
    } else if (fs.existsSync(root)) {
      const targetClean = safeFavoriteName(name, '').toLowerCase();
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const candidateDir = path.join(root, ent.name);
        if (ent.name.toLowerCase() === targetClean) {
          dir = candidateDir;
          break;
        }
        try {
          const m = JSON.parse(fs.readFileSync(path.join(candidateDir, 'playlist.json'), 'utf8'));
          if (m && String(m.name || '').trim().toLowerCase() === targetClean) {
            dir = candidateDir;
            break;
          }
        } catch (e) {}
      }
    }
  }

  try {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Remove também eventual .zip correspondente em Downloads para não auto-extrair novamente
    const targetClean = safeFavoriteName(name, '').toLowerCase();
    if (fs.existsSync(downloadsDir)) {
      for (const f of fs.readdirSync(downloadsDir)) {
        if (!f.toLowerCase().endsWith('.zip')) continue;
        const baseZip = f.slice(0, -4).replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
        if (baseZip === targetClean || baseZip === String(name || '').trim().toLowerCase()) {
          try { fs.unlinkSync(path.join(downloadsDir, f)); } catch (e) {}
        }
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('delete-favorite-track', async (_event, playlist, fileName) => {
  // Se for da pasta de downloads
  if (playlist === '__download__' || playlist === 'Downloads' || String(fileName).includes('/')) {
    const downloadsDir = path.resolve(app.getPath('downloads'));
    const safeRel = String(fileName || '').replace(/^[\\/]+/, '');
    const target = path.resolve(downloadsDir, safeRel);
    if (target.startsWith(downloadsDir + path.sep) && fs.existsSync(target)) {
      try { fs.unlinkSync(target); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
    }
  }

  let dir = favoritePlaylistDir(playlist);
  if (!dir || !fs.existsSync(dir)) {
    const downloadsDir = path.resolve(app.getPath('downloads'));
    const candidateDownloadsDir = path.join(downloadsDir, playlist);
    if (fs.existsSync(candidateDownloadsDir)) dir = candidateDownloadsDir;
  }

  if (!dir || !fs.existsSync(dir)) return { success: false, error: 'Playlist não encontrada' };
  const target = path.join(dir, path.basename(fileName));
  if (target && fs.existsSync(target)) {
    try { fs.unlinkSync(target); } catch (e) {}
  }
  const manifestPath = path.join(dir, 'playlist.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.tracks = (manifest.tracks || []).filter((t) => t.file !== fileName && path.basename(t.file) !== path.basename(fileName));
      manifest.savedAt = Date.now();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      return { success: true, count: manifest.tracks.length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: true };
});

ipcMain.handle('rename-favorite-playlist', async (_event, payload) => {
  const info = typeof payload === 'object' && payload !== null ? payload : {};
  const oldName = String(info.oldName || '').trim();
  const newName = String(info.newName || '').trim();
  if (!oldName || !newName) return { success: false, error: 'Nomes inválidos' };

  const root = favoritePlaylistsRoot();
  const downloadsDir = path.resolve(app.getPath('downloads'));
  let dir = favoritePlaylistDir(oldName);
  let parentDir = root;

  if (!dir || !fs.existsSync(dir)) {
    const candidateDl = path.join(downloadsDir, oldName);
    if (fs.existsSync(candidateDl) && fs.statSync(candidateDl).isDirectory()) {
      dir = candidateDl;
      parentDir = downloadsDir;
    } else if (fs.existsSync(root)) {
      const targetClean = safeFavoriteName(oldName, '').toLowerCase();
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const cand = path.join(root, ent.name);
        if (ent.name.toLowerCase() === targetClean) {
          dir = cand;
          parentDir = root;
          break;
        }
      }
    }
  }

  if (!dir || !fs.existsSync(dir)) return { success: false, error: 'Playlist não encontrada' };

  const safeNew = safeFavoriteName(newName, 'Playlist');
  const targetDir = path.join(parentDir, safeNew);

  try {
    if (path.resolve(dir) !== path.resolve(targetDir)) {
      if (fs.existsSync(targetDir)) {
        return { success: false, error: 'Já existe uma playlist ou pasta com esse nome' };
      }
      fs.renameSync(dir, targetDir);
    }
    const manifestPath = path.join(targetDir, 'playlist.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        m.name = safeNew;
        m.album = safeNew;
        m.updatedAt = Date.now();
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
      } catch (e) {}
    }
    return { success: true, oldName, newName: safeNew, folder: targetDir };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('edit-favorite-track', async (_event, payload) => {
  const info = payload || {};
  const playlist = String(info.playlist || '').trim();
  const file = String(info.file || '').trim();
  const newTitle = String(info.newTitle || '').trim();
  const newArtist = String(info.newArtist || '').trim();

  if (!playlist || !file) return { success: false, error: 'Dados incompletos' };

  let dir = favoritePlaylistDir(playlist);
  if (!dir || !fs.existsSync(dir)) {
    const downloadsDir = path.resolve(app.getPath('downloads'));
    const cand = path.join(downloadsDir, playlist);
    if (fs.existsSync(cand)) dir = cand;
  }

  if (!dir || !fs.existsSync(dir)) return { success: false, error: 'Playlist não encontrada' };

  const manifestPath = path.join(dir, 'playlist.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(manifest.tracks)) {
        const targetTrack = manifest.tracks.find(t => t.file === file || path.basename(t.file) === path.basename(file));
        if (targetTrack) {
          if (newTitle) targetTrack.title = newTitle;
          if (newArtist) targetTrack.artist = newArtist;
          manifest.savedAt = Date.now();
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
          return { success: true, track: targetTrack };
        }
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: true };
});

app.whenReady().then(async () => {
  try {
    if (typeof app.configureHostResolver === 'function') {
      app.configureHostResolver({
        secureDnsMode: 'secure',
        secureDnsServers: [
          'https://cloudflare-dns.com/dns-query',
          'https://dns.google/dns-query'
        ]
      });
    }
  } catch (e) {
    console.warn('[DNS] Não foi possível ativar DNS seguro:', e && e.message ? e.message : e);
  }

  if (components && typeof components.whenReady === 'function') {
    try {
      await components.whenReady();
      console.log('[DRM] Widevine components ready:', components.status());
    } catch (e) {
      console.warn('[DRM] Falha ao aguardar Widevine components:', e);
    }
  }

  createWindow();

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Ao fechar, nada do que foi pesquisado, aberto ou extraído pode continuar no disco.
const CLEARABLE_STORAGES = [
  'cookies',
  'localstorage',
  'sessionstorage',
  'indexdb',
  'websql',
  'serviceworkers',
  'cachestorage',
  'filesystem',
  'shadercache'
];

let tracesCleared = false;

function savedBookmarksFile() {
  return path.join(app.getPath('userData'), 'bookmarks.json');
}

function readSavedBookmarks() {
  try {
    const file = savedBookmarksFile();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Antes de apagar tudo, pergunta se os favoritos devem ser guardados.
// Se sim, eles saem do storage do navegador e vão para um arquivo próprio,
// que é o único dado que atravessa o fechamento.
async function askAboutBookmarks() {
  let bookmarks = [];
  let readOk = false;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const raw = await mainWindow.webContents.executeJavaScript(
        "localStorage.getItem('user_bookmarks')",
        true
      );
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        bookmarks = parsed;
        readOk = true;
      }
    }
  } catch (e) {}

  // Sem conseguir ler a janela não dá para perguntar nada: mantém o que já
  // estava guardado em vez de apagar por engano.
  if (!readOk) return;

  if (!bookmarks.length) {
    try { fs.rmSync(savedBookmarksFile(), { force: true }); } catch (e) {}
    return;
  }

  let keep = false;
  try {
    const answer = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
      type: 'question',
      buttons: ['Guardar favoritos', 'Apagar tudo'],
      defaultId: 0,
      cancelId: 1,
      title: 'Fechando o Papaléguas',
      message: `Guardar seus ${bookmarks.length} favorito(s)?`,
      detail: 'Pesquisas, URLs abertas, conteúdo extraído, cookies e cache serão apagados de qualquer forma. Só os favoritos podem continuar.'
    });
    keep = answer.response === 0;
  } catch (e) {}

  try {
    if (keep) {
      fs.writeFileSync(savedBookmarksFile(), JSON.stringify(bookmarks), 'utf8');
    } else {
      fs.rmSync(savedBookmarksFile(), { force: true });
    }
  } catch (e) {}
}

async function clearAllBrowsingData() {
  for (const s of getAppSessions()) {
    if (!s) continue;
    try { await s.clearStorageData({ storages: CLEARABLE_STORAGES }); } catch (e) {}
    try { await s.clearCache(); } catch (e) {}
    try { await s.clearAuthCache(); } catch (e) {}
    try { await s.clearHostResolverCache(); } catch (e) {}
    try { if (typeof s.clearCodeCaches === 'function') await s.clearCodeCaches({ urls: [] }); } catch (e) {}
  }
  try {
    if (papaleguasServer && typeof papaleguasServer.clearBrowsingTraces === 'function') {
      papaleguasServer.clearBrowsingTraces();
    }
  } catch (e) {}
  try {
    const partitionDir = path.join(app.getPath('userData'), 'Partitions', 'tor-browser');
    const leftovers = [
      'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
      'Session Storage', 'Local Storage', 'Shared Dictionary', 'Network',
      'blob_storage', 'databases', 'IndexedDB', 'Service Worker', 'File System',
      'SharedStorage', 'Cookies', 'Cookies-journal', 'Trust Tokens', 'Trust Tokens-journal'
    ];
    for (const name of leftovers) {
      try { fs.rmSync(path.join(partitionDir, name), { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {}
}

// ============================================================================
// ÁREA DE NOTIFICAÇÃO DO SISTEMA (TRAY & NOTIFICAÇÕES NATIVAS)
// ============================================================================
let appTray = null;
let currentTrayState = null;
let lastTrayNotificationTrackId = null;

function setupMusicTray() {
  if (appTray) return;
  const iconPath = path.join(__dirname, '../src/papaleguas_icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'linux' || process.platform === 'win32') {
      icon = icon.resize({ width: 22, height: 22 });
    }
  } catch (e) {
    icon = null;
  }
  if (!icon) return;

  try {
    appTray = new Tray(icon);
    appTray.setToolTip('Papaléguas Browser');

    appTray.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });

    updateMusicTray(null);
  } catch (e) {
    console.warn('Erro ao inicializar Tray:', e);
  }
}

function updateMusicTray(state) {
  if (!appTray) setupMusicTray();
  if (!appTray) return;
  currentTrayState = state;
  if (!state || !state.track) lastTrayNotificationTrackId = null;

  const isPlaying = state && state.isPlaying;
  const track = state && state.track;

  let tooltip = 'Papaléguas Browser';
  if (track && track.title) {
    tooltip = `Papaléguas Music: ${track.title} • ${track.artist || ''}`;
  }
  try {
    appTray.setToolTip(tooltip);
  } catch (e) {}

  const contextMenu = Menu.buildFromTemplate([
    {
      label: track && track.title ? `🎵 ${track.title}` : 'Papaléguas Music',
      enabled: false
    },
    {
      label: track && track.artist ? `👤 ${track.artist}` : 'Nenhuma faixa tocando',
      enabled: false
    },
    { type: 'separator' },
    {
      label: isPlaying ? '⏸️ Pausar Música' : '▶️ Continuar Música',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('music-tray-command', { action: 'toggle' });
        }
      }
    },
    {
      label: '⏭️ Próxima Faixa',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('music-tray-command', { action: 'next' });
        }
      }
    },
    {
      label: '⏮️ Faixa Anterior',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('music-tray-command', { action: 'prev' });
        }
      }
    },
    { type: 'separator' },
    {
      label: '🖥️ Abrir Papaléguas Music',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('music-tray-command', { action: 'focus-music-tab' });
        }
      }
    },
    {
      label: '❌ Fechar Navegador',
      click: () => {
        app.quit();
      }
    }
  ]);

  try {
    appTray.setContextMenu(contextMenu);
  } catch (e) {}

  // Notificação de desktop na área de notificação quando muda de faixa em segundo plano
  if (track && track.title && isPlaying && track.id && track.id !== lastTrayNotificationTrackId) {
    lastTrayNotificationTrackId = track.id;
    if (Notification.isSupported() && mainWindow && (!mainWindow.isFocused() || mainWindow.isMinimized())) {
      try {
        const notif = new Notification({
          title: 'Papaléguas Music 🎵',
          body: `${track.title}\n${track.artist || ''}`,
          icon: path.join(__dirname, '../src/papaleguas_icon.png'),
          silent: true
        });
        notif.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          }
        });
        notif.show();
      } catch (e) {}
    }
  }
}

ipcMain.on('update-music-tray-state', (_event, state) => {
  updateMusicTray(state);
});

app.on('before-quit', (event) => {
  if (appTray) {
    try { appTray.destroy(); } catch (e) {}
    appTray = null;
  }
  if (tracesCleared) return;
  event.preventDefault();
  askAboutBookmarks()
    .catch(() => {})
    .then(() => clearAllBrowsingData())
    .catch(() => {})
    .finally(() => {
      tracesCleared = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (ytPipWindow && !ytPipWindow.isDestroyed()) return;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
