'use strict';
// =========================================================================
// PAPALÉGUAS - MÓDULO MODULAR DE ROTAS: ADMINISTRAÇÃO & TELEGRAM BOT & AGENT CHAT
// =========================================================================
// Responsável por /api/telegram-bot* e /api/papaleguas/*.

const { swallowed } = require('../logger');

async function handle(req, res, ctx) {
  const {
    pathname,
    body = {},
    PORT,
    telegramBot,
    papaleguasTracker,
    torManager,
    isLocalAdminRequest,
    sendForbiddenAdminResponse,
    isAppTorEnabled,
    isServerConsoleLogsPaused,
    setServerConsoleLogsPaused,
    getLocalNetworkIp
  } = ctx;

  // 1. Integração Telegram Bot & Webhook
  if (pathname === '/api/telegram-bot' && req.method === 'POST') {
    try {
      telegramBot.processIncomingUpdate(body).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }).catch((err) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  if (pathname === '/api/telegram-bot/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, status: telegramBot.getStatus() }));
    return true;
  }

  if (pathname === '/api/telegram-bot/set-token' && req.method === 'POST') {
    telegramBot.setToken(body.token).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return true;
  }

  // 2. Endpoints Administrativos Papaléguas
  if (!pathname.startsWith('/api/papaleguas')) return false;

  if (pathname !== '/api/papaleguas/device-telemetry' && pathname !== '/api/papaleguas/app-download') {
    if (!isLocalAdminRequest(req)) {
      sendForbiddenAdminResponse(res, true);
      return true;
    }
    const isPublicAdminRoute = pathname === '/api/papaleguas/status' || pathname === '/api/papaleguas/login' || pathname === '/api/papaleguas/setup';
    if (!isPublicAdminRoute && !papaleguasTracker.validateSession(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Acesso restrito. Faça login como administrador para continuar.' }));
      return true;
    }
  }

  if (pathname === '/api/papaleguas/status') {
    const clientIp = papaleguasTracker.extractClientIp(req);
    const isLocal = papaleguasTracker.isPrivateIp(clientIp);
    const authenticated = isLocal || papaleguasTracker.validateSession(req);
    const hasAdmin = papaleguasTracker.hasAdminAccount();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    const torOn = isAppTorEnabled();
    let torConnected = false;
    if (torOn) {
      try {
        const torStatus = await torManager.checkTorStatus();
        torConnected = Boolean(torStatus && torStatus.connected);
      } catch (e) { swallowed(e, 'admin:status@89'); }
    }
    const activePublicUrl = 'https://papaleguas.app';
    res.end(JSON.stringify({
      hasAdmin,
      authenticated,
      username: authenticated ? 'Administrador' : null,
      isTrackingEnabled: papaleguasTracker.isTrackingEnabled(),
      serverLogsPaused: isServerConsoleLogsPaused(),
      tunnelUrl: activePublicUrl,
      cloudflareTunnelUrl: activePublicUrl,
      ngrokTunnelUrl: null,
      ngrokTunnelConnecting: false,
      lanAccessUrl: `http://${getLocalNetworkIp()}:${PORT}`,
      torEnabled: torOn,
      torConnected
    }));
    return true;
  }

  if (pathname === '/api/papaleguas/tunnel-restart' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, url: 'https://papaleguas.app', connecting: false }));
    return true;
  }

  if (pathname === '/api/papaleguas/setup' && req.method === 'POST') {
    try {
      const { username, password } = body;
      const result = papaleguasTracker.createAdminAccount(username, password);
      if (result.success && result.token) {
        res.setHeader('Set-Cookie', `papaleguas_token=${result.token}; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/papaleguas/login' && req.method === 'POST') {
    try {
      const { username, password } = body;
      const result = papaleguasTracker.authenticateAdmin(username, password);
      if (result.success) {
        res.setHeader('Set-Cookie', `papaleguas_token=${result.token}; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/papaleguas/logout' && req.method === 'POST') {
    papaleguasTracker.logoutAdmin(req);
    res.setHeader('Set-Cookie', 'papaleguas_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return true;
  }

  if (pathname === '/api/papaleguas/metrics') {
    const metrics = papaleguasTracker.calculateAcceptanceAndEvolutionMetrics();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(JSON.stringify({
      success: true,
      tunnelUrl: 'https://papaleguas.app',
      cloudflareTunnelUrl: 'https://papaleguas.app',
      ngrokTunnelUrl: null,
      ngrokTunnelConnecting: false,
      lanAccessUrl: `http://${getLocalNetworkIp()}:${PORT}`,
      ...metrics
    }));
    return true;
  }

  if (pathname === '/api/papaleguas/device-telemetry' && req.method === 'POST') {
    try {
      const clientIp = papaleguasTracker.extractClientIp(req);
      const updated = papaleguasTracker.updateClientTelemetry(clientIp, body || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, clientIp, updated: Boolean(updated) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/papaleguas/app-download' && req.method === 'POST') {
    try {
      const clientIp = papaleguasTracker.extractClientIp(req);
      const actionType = (body && body.type) || 'app_download';
      papaleguasTracker.logConversion(clientIp, actionType, body || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, clientIp, actionType }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/papaleguas/clear-data' && req.method === 'POST') {
    const result = papaleguasTracker.clearAllAnalyticsData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  if (pathname === '/api/papaleguas/clear-requests' && req.method === 'POST') {
    const result = papaleguasTracker.clearCapturedRequests();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  if (pathname === '/api/papaleguas/requests') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(JSON.stringify({
      success: true,
      requests: papaleguasTracker.getCapturedRequests(150)
    }));
    return true;
  }

  if (pathname === '/api/papaleguas/toggle-tracking' && req.method === 'POST') {
    const current = papaleguasTracker.isTrackingEnabled();
    const newEnabled = body && typeof body.enabled === 'boolean' ? body.enabled : !current;
    const updated = papaleguasTracker.setTrackingEnabled(newEnabled);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      isTrackingEnabled: updated,
      message: updated ? 'Registro de logs e requisições ATIVADO.' : 'Registro de logs e requisições PAUSADO.'
    }));
    return true;
  }

  if (pathname === '/api/papaleguas/server-logs' && req.method === 'POST') {
    const isPaused = body && (body.paused === true || body.value === 'paused');
    const updatedPaused = setServerConsoleLogsPaused(isPaused);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      serverLogsPaused: updatedPaused,
      message: updatedPaused ? 'Logs do terminal pausados (modo silencioso).' : 'Logs do terminal ativados (visíveis).'
    }));
    return true;
  }

  // 3. Gerenciamento do Bloqueador de IPs (Firewall)
  if (pathname === '/api/papaleguas/blocked-ips') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(JSON.stringify({
      success: true,
      blockedIps: typeof papaleguasTracker.getBlockedIps === 'function' ? papaleguasTracker.getBlockedIps() : []
    }));
    return true;
  }

  if (pathname === '/api/papaleguas/block-ip' && req.method === 'POST') {
    const ip = body && body.ip ? String(body.ip).trim() : '';
    const reason = body && body.reason ? String(body.reason).trim() : 'Bloqueado manualmente no painel admin';
    if (!ip) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Endereço de IP obrigatório.' }));
      return true;
    }
    const result = typeof papaleguasTracker.blockIp === 'function' 
      ? papaleguasTracker.blockIp(ip, reason)
      : { success: false, error: 'Serviço de bloqueio indisponível' };
    res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  if (pathname === '/api/papaleguas/unblock-ip' && req.method === 'POST') {
    const ip = body && body.ip ? String(body.ip).trim() : '';
    if (!ip) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Endereço de IP obrigatório.' }));
      return true;
    }
    const result = typeof papaleguasTracker.unblockIp === 'function'
      ? papaleguasTracker.unblockIp(ip)
      : { success: false, error: 'Serviço de bloqueio indisponível' };
    res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // 4. Central de Comando de Robôs & Agentes (Bot Commander)
  const botCommander = ctx.botCommander || require('../bot-commander');
  if (pathname === '/api/papaleguas/bot-commander') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(JSON.stringify({
      success: true,
      config: botCommander.getConfig(),
      connectedBots: botCommander.getConnectedBots(100),
      stats: botCommander.getStats()
    }));
    return true;
  }

  if (pathname === '/api/papaleguas/bot-commander/set-command' && req.method === 'POST') {
    const updated = botCommander.setConfig(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      config: updated,
      message: 'Comando emitido com sucesso. Todos os robôs que conectarem executarão esta ordem.'
    }));
    return true;
  }

  if (pathname === '/api/papaleguas/bot-commander/clear-bots' && req.method === 'POST') {
    const resClear = botCommander.clearConnectedBots();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resClear));
    return true;
  }

  return false;
}

module.exports = { handle };
