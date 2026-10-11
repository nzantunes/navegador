const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

let tunnelProcess = null;
let currentTunnelUrl = null;
let urlReady = false;
let isStarting = false;
let isExplicitlyStopped = false;
let activePort = 8080;
let reconnectTimer = null;
let pollTimer = null;
let lastError = null;

const NGROK_INFO_FILE = path.join(__dirname, '../papaleguas/data/ngrok_tunnel.json');
const NGROK_TOKEN_FILE = path.join(__dirname, '../papaleguas/data/ngrok_token.txt');
const NGROK_DOMAIN_FILE = path.join(__dirname, '../papaleguas/data/ngrok_domain.txt');
const NGROK_LOG_FILE = path.join(__dirname, '../papaleguas/data/ngrok.log');

const DEFAULT_TOKEN = '31VztvSOLZFjYqhrIl6lofps6AW_2oFjMCs3eFBropWS9Rppk';

function resolveNgrokBin() {
  const localBin = path.join(__dirname, '../bin/ngrok');
  if (fs.existsSync(localBin)) {
    try {
      fs.accessSync(localBin, fs.constants.X_OK);
      return localBin;
    } catch (e) {
      try {
        fs.chmodSync(localBin, 0o755);
        return localBin;
      } catch (err) {}
    }
  }
  return 'ngrok';
}

function getStoredToken() {
  if (fs.existsSync(NGROK_TOKEN_FILE)) {
    try {
      const t = fs.readFileSync(NGROK_TOKEN_FILE, 'utf8').trim();
      if (t) return t;
    } catch (e) {}
  }
  return process.env.NGROK_AUTHTOKEN || DEFAULT_TOKEN;
}

function getStoredDomain() {
  if (fs.existsSync(NGROK_DOMAIN_FILE)) {
    try {
      const d = fs.readFileSync(NGROK_DOMAIN_FILE, 'utf8').trim();
      if (d) return d;
    } catch (e) {}
  }
  return process.env.NGROK_DOMAIN || null;
}

function appendLog(text) {
  try {
    const dir = path.dirname(NGROK_LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${String(text).trimEnd()}\n`;
    fs.appendFile(NGROK_LOG_FILE, line, () => {});
  } catch (e) {}
}

function logAlways(text) {
  const msg = String(text);
  appendLog(msg);
  try { process.stdout.write(msg.endsWith('\n') ? msg : msg + '\n'); } catch (e) {}
}

function persistTunnelUrl(url) {
  try {
    const dir = path.dirname(NGROK_INFO_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(NGROK_INFO_FILE, JSON.stringify({
      url: url || null,
      updatedAt: new Date().toISOString(),
      active: Boolean(url)
    }, null, 2), 'utf8');
  } catch (e) {}
}

function ensureAuthTokenConfigured(bin) {
  const token = getStoredToken();
  if (!token) return;
  try {
    execFileSync(bin, ['config', 'add-authtoken', token], { stdio: 'ignore', timeout: 5000 });
  } catch (e) {}
}

function checkNgrokApi(callback) {
  const req = http.get('http://127.0.0.1:4040/api/tunnels', { timeout: 1500 }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (Array.isArray(json.tunnels) && json.tunnels.length > 0) {
          const httpsTunnel = json.tunnels.find((t) => t.proto === 'https' || (t.public_url && t.public_url.startsWith('https')));
          const url = (httpsTunnel || json.tunnels[0]).public_url;
          return callback(null, url);
        }
      } catch (err) {}
      callback(new Error('Nenhum túnel ativo ainda'));
    });
  });
  req.on('error', (err) => callback(err));
}

function pollForTunnelUrl(attemptsLeft = 30) {
  if (pollTimer) clearTimeout(pollTimer);
  if (attemptsLeft <= 0 || !tunnelProcess || tunnelProcess.killed) return;

  checkNgrokApi((err, url) => {
    if (url) {
      currentTunnelUrl = url;
      urlReady = true;
      isStarting = false;
      logAlways(`[NGROK] Túnel ativo com sucesso: ${url}`);
      persistTunnelUrl(url);
      return;
    }
    pollTimer = setTimeout(() => pollForTunnelUrl(attemptsLeft - 1), 1000);
  });
}

function killStrayNgrok() {
  try {
    execFileSync('pkill', ['-f', 'ngrok http'], { stdio: 'ignore', timeout: 3000 });
  } catch (e) {}
}

function startTunnel(port = 8080) {
  activePort = port;
  isExplicitlyStopped = false;

  if (tunnelProcess && !tunnelProcess.killed && urlReady && currentTunnelUrl) {
    return currentTunnelUrl;
  }
  if (isStarting && tunnelProcess && !tunnelProcess.killed) {
    return currentTunnelUrl;
  }

  isStarting = true;
  urlReady = false;
  lastError = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);

  if (tunnelProcess) {
    try { tunnelProcess.kill('SIGTERM'); } catch (e) {}
    tunnelProcess = null;
  }
  killStrayNgrok();

  const bin = resolveNgrokBin();
  ensureAuthTokenConfigured(bin);

  const domain = getStoredDomain();
  const args = ['http', String(port), '--log=stdout'];
  if (domain) {
    const formattedUrl = (domain.startsWith('http://') || domain.startsWith('https://'))
      ? domain
      : `https://${domain}`;
    args.push(`--url=${formattedUrl}`);
  }

  const policyFile = path.join(__dirname, '../papaleguas/data/ngrok_policy.yml');
  if (fs.existsSync(policyFile)) {
    args.push(`--traffic-policy-file=${policyFile}`);
  }

  try {
    logAlways(`[NGROK] Iniciando ngrok na porta ${port}... (${bin})`);
    tunnelProcess = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });

    const handleOutput = (data) => {
      const text = data.toString();
      appendLog(text);

      const urlMatch = text.match(/url=(https:\/\/[a-z0-9.-]+\.ngrok(?:-free)?\.app)/i) ||
                        text.match(/(https:\/\/[a-z0-9.-]+\.ngrok(?:-free)?\.app)/i);
      if (urlMatch) {
        const u = urlMatch[1];
        if (currentTunnelUrl !== u || !urlReady) {
          currentTunnelUrl = u;
          urlReady = true;
          isStarting = false;
          logAlways(`[NGROK] URL capturada: ${u}`);
          persistTunnelUrl(u);
        }
      }

      if (/ERR_NGROK/i.test(text)) {
        lastError = text.trim().slice(0, 300);
        logAlways(`[NGROK AVISO] ${lastError}`);
      }
    };

    tunnelProcess.stdout.on('data', handleOutput);
    tunnelProcess.stderr.on('data', handleOutput);

    tunnelProcess.on('error', (err) => {
      logAlways(`[NGROK ERRO] Falha ao executar ngrok: ${err.message}`);
      lastError = err.message;
      scheduleReconnect();
    });

    tunnelProcess.on('exit', (code) => {
      logAlways(`[NGROK] Processo finalizado (código ${code})`);
      urlReady = false;
      isStarting = false;
      tunnelProcess = null;
      if (!isExplicitlyStopped) {
        scheduleReconnect();
      }
    });

    // Inicia verificação rápida pela API interna do ngrok
    setTimeout(() => pollForTunnelUrl(25), 800);

    return currentTunnelUrl;
  } catch (err) {
    logAlways(`[NGROK ERRO] Erro ao iniciar: ${err.message}`);
    isStarting = false;
    scheduleReconnect();
    return null;
  }
}

function stopTunnel() {
  isExplicitlyStopped = true;
  urlReady = false;
  isStarting = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pollTimer) clearTimeout(pollTimer);
  if (tunnelProcess) {
    try { tunnelProcess.kill('SIGTERM'); } catch (e) {}
    tunnelProcess = null;
  }
  persistTunnelUrl(null);
}

function scheduleReconnect(delay = 5000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (isExplicitlyStopped) return;
  reconnectTimer = setTimeout(() => {
    if (!isExplicitlyStopped && (!tunnelProcess || tunnelProcess.killed)) {
      logAlways('[NGROK] Reconectando túnel ngrok automaticamente...');
      startTunnel(activePort);
    }
  }, delay);
}

function readPersistedUrl() {
  try {
    if (fs.existsSync(NGROK_INFO_FILE)) {
      const data = JSON.parse(fs.readFileSync(NGROK_INFO_FILE, 'utf8'));
      if (data && data.url && data.active) return data.url;
    }
  } catch (e) {}
  return null;
}

function getTunnelUrl() {
  if (urlReady && currentTunnelUrl) return currentTunnelUrl;
  return readPersistedUrl();
}

function getTunnelStatus() {
  const persisted = readPersistedUrl();
  const effectiveUrl = (urlReady && currentTunnelUrl) ? currentTunnelUrl : persisted;
  const running = Boolean((tunnelProcess && tunnelProcess.pid && !tunnelProcess.killed) || persisted);
  return {
    running,
    connecting: Boolean(!effectiveUrl && (isStarting || (tunnelProcess && !tunnelProcess.killed))),
    url: effectiveUrl,
    pendingUrl: currentTunnelUrl || persisted,
    error: lastError
  };
}

process.on('exit', () => {
  if (tunnelProcess) {
    try { tunnelProcess.kill('SIGTERM'); } catch (e) {}
  }
});

module.exports = {
  startTunnel,
  stopTunnel,
  getTunnelUrl,
  getTunnelStatus
};
