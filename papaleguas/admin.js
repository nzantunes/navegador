// papaleguas/admin.js - Lógica interativa do painel administrativo

(function() {
  let authToken = localStorage.getItem('papaleguas_token') || '';
  let autoRefreshTimer = null;
  let currentFilter = 'all';
  let currentSearch = '';
  let rawIpList = [];
  const expandedIps = new Set();
  let filterListenersBound = false;

  // Elementos das telas
  const screenSetup = document.getElementById('screen-setup');
  const screenLogin = document.getElementById('screen-login');
  const screenDashboard = document.getElementById('screen-dashboard');
  const alertSetup = document.getElementById('alert-setup');
  const alertLogin = document.getElementById('alert-login');

  // Elementos do Dashboard
  const elTotalVisits = document.getElementById('kpi-total-visits');
  const elUniqueIps = document.getElementById('kpi-unique-ips');
  const elConversions = document.getElementById('kpi-conversions');
  const elRetention = document.getElementById('kpi-retention');
  const elAcceptanceGauge = document.getElementById('acceptance-gauge');
  const elAcceptancePercent = document.getElementById('acceptance-percent');
  const elAcceptanceBadge = document.getElementById('acceptance-badge');
  const elAcceptanceDesc = document.getElementById('acceptance-desc');
  const elEvolutionChart = document.getElementById('evolution-chart');
  const elIpTableBody = document.getElementById('ip-table-body');
  const elRecentFeed = document.getElementById('recent-feed');
  const elAdminUser = document.getElementById('admin-username-display');
  const elAdminServerName = document.getElementById('admin-server-name');
  let currentServerName = window.location.host || 'Papaléguas';

  // Elementos do Monitor de Requisições HTTP em Tempo Real
  let rawRequestsList = [];
  let currentReqFilter = 'all';
  let currentReqSearch = '';
  let reqFilterListenersBound = false;
  const elRequestsTableBody = document.getElementById('requests-table-body');
  const elBadgeTotalRequests = document.getElementById('badge-total-requests');
  const elCountReqAll = document.getElementById('count-req-all');
  const elCountReq2xx = document.getElementById('count-req-2xx');
  const elCountReqErr = document.getElementById('count-req-err');
  const elCountReqGet = document.getElementById('count-req-get');
  const elCountReqPost = document.getElementById('count-req-post');
  const elReqSearchInput = document.getElementById('req-search-input');
  const elReqSearchClear = document.getElementById('req-search-clear');
  const elReqFilterChips = document.getElementById('requests-filter-chips');
  const elIntervalSelect = document.getElementById('refresh-interval-select');
  const elCountdownBox = document.getElementById('refresh-countdown-box');
  const elCountdownText = document.getElementById('refresh-countdown-text');
  const elBtnManualRefresh = document.getElementById('btn-manual-refresh');
  const elServerLogsSelect = document.getElementById('server-logs-select');
  const elCfContainer = document.getElementById('cf-tunnel-container');
  const elCfLink = document.getElementById('cf-tunnel-link');


  // Intervalo de atualização (Padrão: 3 segundos para Tempo Real, podendo ser configurado até 24 horas)
  let savedInterval = localStorage.getItem('papaleguas_refresh_interval');
  if (savedInterval === '300000') {
    savedInterval = '3000';
    localStorage.setItem('papaleguas_refresh_interval', '3000');
  }
  let refreshIntervalMs = parseInt(savedInterval ?? '3000', 10);
  if (isNaN(refreshIntervalMs)) refreshIntervalMs = 3000;
  let countdownSeconds = Math.floor(refreshIntervalMs / 1000);
  let countdownTimer = null;

  // Estado e elementos do Rastreamento e Limpeza
  let isTrackingActive = true;
  let adminTorEnabled = true;
  const elBtnToggleAdminTor = document.getElementById('btn-toggle-admin-tor');
  const elAdminTorText = document.getElementById('admin-tor-text');
  const elBtnToggleTracking = document.getElementById('btn-toggle-tracking');
  const elTrackingDot = document.getElementById('tracking-status-dot');
  const elTrackingText = document.getElementById('tracking-status-text');
  const elPausedBanner = document.getElementById('tracking-paused-banner');
  const elModalClear = document.getElementById('modal-clear-data');
  const elBtnConfirmClear = document.getElementById('btn-confirm-clear');
  const elToast = document.getElementById('admin-toast');
  let toastTimeout = null;

  // Inicialização: Verifica estado do servidor


  if (elCfLink) {
    elCfLink.addEventListener('click', (event) => {
      event.preventDefault();
      const url = elCfLink.getAttribute('href') || 'https://papaleguas.app';
      if (!url || url === '#') return;
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'navigate-current-tab', url: url }, '*');
          return;
        }
      } catch (e) {}
      window.open(url, '_blank');
    });
  }

  function detectIsMobileDevice() {
    const narrowViewport = window.innerWidth <= 960;
    const uaMobile = Boolean(
      (navigator.userAgentData && navigator.userAgentData.mobile) ||
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent || '')
    );
    const coarsePointer = Boolean(
      window.matchMedia &&
      window.matchMedia('(pointer: coarse)').matches &&
      window.innerWidth <= 1180
    );
    return narrowViewport || uaMobile || coarsePointer;
  }

  function getAdminViewModePref() {
    const saved = localStorage.getItem('papaleguas_admin_view_mode');
    return (saved === 'mobile' || saved === 'pc' || saved === 'auto') ? saved : 'auto';
  }

  function applyAdminViewMode() {
    const pref = getAdminViewModePref();
    const detectedMobile = detectIsMobileDevice();
    const isMobile = pref === 'mobile' ? true : (pref === 'pc' ? false : detectedMobile);

    document.body.classList.toggle('mode-mobile', isMobile);
    document.body.classList.toggle('mode-pc', !isMobile);
    document.body.classList.toggle('force-mobile', pref === 'mobile');
    document.body.classList.toggle('force-pc', pref === 'pc');
    document.documentElement.setAttribute('data-admin-mode', isMobile ? 'mobile' : 'pc');

    if (!isMobile) {
      const actionsDrawer = document.getElementById('admin-header-actions');
      const btnMenu = document.getElementById('btn-mobile-menu');
      if (actionsDrawer) actionsDrawer.classList.remove('mobile-open');
      if (btnMenu) btnMenu.classList.remove('active');
    }

    const badge = document.getElementById('admin-device-mode-badge');
    if (badge) {
      if (pref === 'auto') {
        badge.textContent = isMobile ? '📱 Modo Mobile (Auto)' : '💻 Modo PC (Auto)';
      } else if (pref === 'mobile') {
        badge.textContent = '📱 Modo Mobile (Manual)';
      } else {
        badge.textContent = '💻 Modo PC (Manual)';
      }
    }
  }

  window.cycleAdminViewMode = function() {
    const current = getAdminViewModePref();
    const next = current === 'auto' ? 'mobile' : (current === 'mobile' ? 'pc' : 'auto');
    localStorage.setItem('papaleguas_admin_view_mode', next);
    applyAdminViewMode();
    const label = next === 'auto'
      ? `Automático (${detectIsMobileDevice() ? 'Mobile' : 'PC'} detectado)`
      : (next === 'mobile' ? 'Modo Mobile ativado' : 'Modo PC ativado');
    if (typeof showToast === 'function') {
      showToast(`🖥️ Visualização: ${label}`, 'info');
    }
  };

  async function init() {
    applyAdminViewMode();
    window.addEventListener('resize', applyAdminViewMode);
    window.addEventListener('orientationchange', applyAdminViewMode);
    setupMobileMenu();
    setupFilterListeners();
    setupRequestFilterListeners();
    setupIntervalSelector();
    startAutoRefresh();

    // Se aberto direto como arquivo no navegador (file://)
    if (window.location.protocol === 'file:') {
      showScreen('dashboard');
      if (elAdminUser) elAdminUser.textContent = 'Modo Arquivo Local';
      renderLocalPreview();
      return;
    }

    try {
      const res = await fetch('/api/papaleguas/status', {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      const data = await res.json();

      if (!data.hasAdmin) {
        showScreen('setup');
      } else if (!data.authenticated) {
        // Se ainda não estiver autenticado, exibe tela de login mas carrega os dados locais como fallback
        showScreen('login');
      } else {
        showScreen('dashboard');
        if (elAdminUser) elAdminUser.textContent = data.username || 'Administrador';
        if (data.serverName) {
          currentServerName = data.serverName;
          if (elAdminServerName) elAdminServerName.textContent = currentServerName;
        } else if (elAdminServerName) {
          elAdminServerName.textContent = currentServerName;
        }
        if (typeof data.isTrackingEnabled === 'boolean') updateTrackingUi(data.isTrackingEnabled);
        if (typeof data.torEnabled === 'boolean') updateAdminTorUi(data.torEnabled, data.torConnected);
        if (typeof data.serverLogsPaused === 'boolean' && elServerLogsSelect) {
          elServerLogsSelect.value = data.serverLogsPaused ? 'paused' : 'enabled';
        }
        updateTunnelUi(data.cloudflareTunnelUrl || 'https://papaleguas.app', data.lanAccessUrl);
        loadMetrics();
        loadTelegramBotStatus();
      }
    } catch (e) {
      console.warn('[ADMIN INIT WARN]', e);
      // Se não conectou na API, abre o dashboard para visualização
      showScreen('dashboard');
      if (elAdminUser) elAdminUser.textContent = 'Painel Local';
      renderLocalPreview();
    }
  }

  function renderLocalPreview() {
    renderOverview({
      totalVisits: 28,
      totalUniqueIps: 6,
      totalConversions: 4,
      retentionRate: '85%'
    });
    renderAcceptance({
      percentage: 88,
      status: '🚀 Alta Aceitação & Retenção',
      color: '#10b981',
      description: 'Visitantes navegando continuamente e executando downloads.'
    });
    renderEvolutionChart([
      { date: '2026-09-08', label: '08/09', visits: 12, conversions: 2 },
      { date: '2026-09-09', label: '09/09', visits: 18, conversions: 3 },
      { date: '2026-09-10', label: '10/09', visits: 15, conversions: 1 },
      { date: '2026-09-11', label: '11/09', visits: 24, conversions: 4 },
      { date: '2026-09-12', label: '12/09', visits: 31, conversions: 6 },
      { date: '2026-09-13', label: '13/09', visits: 28, conversions: 4 },
      { date: '2026-09-14', label: 'Hoje', visits: 35, conversions: 5 }
    ]);
    rawIpList = [
      {
        ip: '192.168.1.15',
        ipVersion: 'IPv4',
        isLocal: true,
        visitsCount: 14,
        conversions: 3,
        firstSeen: new Date(Date.now() - 3600000).toISOString(),
        lastSeen: new Date().toISOString(),
        device: '📱 Samsung Galaxy S23 (Android 14) [Rede Local Wi-Fi]',
        screen: '1080x2340',
        localSubnet: '192.168.1.0/24',
        discoveredDevices: ['Smart TV Roku (192.168.1.50)', 'TV Sala Living (192.168.1.55)'],
        geo: { country: 'Brasil (Local)', city: 'Rede Local Wi-Fi', flag: '🏠', isp: 'Wi-Fi Doméstico' }
      },
      {
        ip: '189.40.50.60',
        ipVersion: 'IPv4',
        isLocal: false,
        visitsCount: 8,
        conversions: 1,
        firstSeen: new Date(Date.now() - 7200000).toISOString(),
        lastSeen: new Date(Date.now() - 600000).toISOString(),
        device: '💻 Computador (Windows 11) [Rede Externa]',
        screen: '1920x1080',
        discoveredDevices: [],
        geo: { country: 'Brasil', city: 'São Paulo - SP', flag: '🇧🇷', isp: 'Claro Brasil' }
      },
      {
        ip: '2804:14d:5494:834b::1',
        ipVersion: 'IPv6',
        isLocal: false,
        visitsCount: 6,
        conversions: 2,
        firstSeen: new Date(Date.now() - 5400000).toISOString(),
        lastSeen: new Date(Date.now() - 300000).toISOString(),
        device: '📱 Apple iPhone (iOS 17) [Rede Externa]',
        screen: '1170x2532',
        discoveredDevices: [],
        geo: { country: 'Brasil', city: 'Rio de Janeiro - RJ', flag: '🇧🇷', isp: 'Vivo Fibra' }
      }
    ];
    updateFilterCounts(rawIpList);
    applyIpFilterAndRender();
  }

  function showScreen(screen) {
    const header = document.getElementById('admin-header');
    if (header) {
      header.style.display = screen === 'dashboard' ? 'flex' : 'none';
    }
    if (screenSetup) screenSetup.style.display = screen === 'setup' ? 'flex' : 'none';
    if (screenLogin) screenLogin.style.display = screen === 'login' ? 'flex' : 'none';
    if (screenDashboard) screenDashboard.style.display = screen === 'dashboard' ? 'flex' : 'none';
  }

  // Setup de Conta Master
  const formSetup = document.getElementById('form-setup');
  if (formSetup) {
    formSetup.addEventListener('submit', async (e) => {
      e.preventDefault();
      const user = document.getElementById('setup-user').value.trim();
      const pass = document.getElementById('setup-pass').value;
      const passConf = document.getElementById('setup-pass-confirm').value;

      if (pass !== passConf) {
        showAlert(alertSetup, 'As senhas não coincidem. Digite novamente.', 'error');
        return;
      }

      try {
        const res = await fetch('/api/papaleguas/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass })
        });
        const data = await res.json();
        if (data.success) {
          showAlert(alertSetup, 'Conta criada com sucesso! Redirecionando para login...', 'success');
          setTimeout(() => {
            showScreen('login');
          }, 1200);
        } else {
          showAlert(alertSetup, data.error || 'Erro ao criar conta.', 'error');
        }
      } catch (err) {
        showAlert(alertSetup, 'Falha de conexão com o servidor.', 'error');
      }
    });
  }

  // Login de Administrador
  const formLogin = document.getElementById('form-login');
  if (formLogin) {
    formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const user = document.getElementById('login-user').value.trim();
      const pass = document.getElementById('login-pass').value;

      try {
        const res = await fetch('/api/papaleguas/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass })
        });
        const data = await res.json();
        if (data.success && data.token) {
          authToken = data.token;
          localStorage.setItem('papaleguas_token', authToken);
          // Grava cookie para fallback
          document.cookie = `papaleguas_token=${authToken}; path=/; max-age=604800; SameSite=Lax`;
          showScreen('dashboard');
          if (elAdminUser) elAdminUser.textContent = data.username || 'Administrador';
          refreshAdminTorStatus();
          loadMetrics();
          startAutoRefresh();
        } else {
          showAlert(alertLogin, data.error || 'Credenciais inválidas.', 'error');
        }
      } catch (err) {
        showAlert(alertLogin, 'Erro de conexão com o servidor.', 'error');
      }
    });
  }

  // Logout
  window.handleLogout = async function() {
    try {
      await fetch('/api/papaleguas/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
    } catch(e) {}
    authToken = '';
    localStorage.removeItem('papaleguas_token');
    document.cookie = 'papaleguas_token=; path=/; max-age=0';
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    showScreen('login');
  };

  // Carrega e renderiza métricas
  window.loadMetrics = async function(isManual = false) {
    if (isManual) {
      if (elBtnManualRefresh) {
        elBtnManualRefresh.style.opacity = '0.6';
        elBtnManualRefresh.textContent = '🔄 Atualizando...';
      }
    }

    try {
      const res = await fetch('/api/papaleguas/metrics', {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      if (res.status === 401) {
        handleLogout();
        return;
      }
      const data = await res.json();
      if (!data.success) return;

      if (data.serverName) {
        currentServerName = data.serverName;
        if (elAdminServerName) elAdminServerName.textContent = currentServerName;
      }
      if (typeof data.isTrackingEnabled === 'boolean') {
        updateTrackingUi(data.isTrackingEnabled);
      }
      updateTunnelUi(data.cloudflareTunnelUrl || 'https://papaleguas.app', data.lanAccessUrl);

      renderOverview(data.overview);
      if (data.rustEngine && data.rustEngine.isActive) {
        const elRust = document.getElementById('rust-engine-badge');
        if (elRust) {
          const m = data.rustEngine.metrics || {};
          const docs = m.indexedDocumentsCount || m.indexed_documents_count || 0;
          elRust.style.display = 'inline-flex';
          elRust.textContent = `⚡ Rust v2.0 BM25 Ativo (${docs} págs)`;
        }
      }
      renderAcceptance(data.acceptance);
      renderEvolutionChart(data.evolutionChart);
      rawIpList = data.ipList || [];
      updateFilterCounts(rawIpList);
      applyIpFilterAndRender();
      rawRequestsList = data.recentRequests || [];
      updateRequestFilterCounts(rawRequestsList);
      applyRequestFilterAndRender();
      renderBlockedIpsUi(data.blockedIps || [], data.totalBlockedIps, data.totalHitsBlocked);
      loadBotCommanderUi();
      if (activeWindowIpKey) {
        if (!isWindowMinimized) {
          renderIpWindow();
        } else {
          updateMinimizedDock();
        }
      }
      renderRecentFeed(data.recentVisits);
    } catch (e) {
      console.warn('[METRICS LOAD ERR]', e);
    } finally {
      if (isManual && elBtnManualRefresh) {
        setTimeout(() => {
          elBtnManualRefresh.style.opacity = '1';
          elBtnManualRefresh.textContent = '🔄 Atualizar';
        }, 500);
      }
    }
  };

  function renderOverview(overview) {
    if (!overview) return;
    if (elTotalVisits) elTotalVisits.textContent = Number(overview.totalVisits || 0).toLocaleString('pt-BR');
    if (elUniqueIps) elUniqueIps.textContent = Number(overview.totalUniqueIps || 0).toLocaleString('pt-BR');
    const elOnlineIps = document.getElementById('kpi-online-ips');
    if (elOnlineIps) elOnlineIps.textContent = Number(overview.onlineIpsCount || 0).toLocaleString('pt-BR');
    if (elConversions) elConversions.textContent = Number(overview.totalConversions || 0).toLocaleString('pt-BR');
    if (elRetention) elRetention.textContent = overview.retentionRate || '0%';
  }

  function renderAcceptance(acceptance) {
    if (!acceptance) return;
    const pct = acceptance.percentage || 0;
    if (elAcceptancePercent) elAcceptancePercent.textContent = pct + '%';
    if (elAcceptanceBadge) {
      elAcceptanceBadge.textContent = acceptance.status || 'Em Aquecimento';
      elAcceptanceBadge.style.color = acceptance.color || '#38bdf8';
      elAcceptanceBadge.style.borderColor = acceptance.color || '#38bdf8';
      elAcceptanceBadge.style.background = (acceptance.color || '#38bdf8') + '22';
    }
    if (elAcceptanceDesc) elAcceptanceDesc.textContent = acceptance.description || '';

    // Atualiza o gradiente cônico do gauge
    if (elAcceptanceGauge) {
      elAcceptanceGauge.style.background = `conic-gradient(${acceptance.color || '#10b981'} 0% ${pct}%, rgba(255, 255, 255, 0.08) ${pct}% 100%)`;
      elAcceptanceGauge.style.boxShadow = `0 0 25px ${(acceptance.color || '#10b981')}44`;
    }
  }

  function renderEvolutionChart(chartData) {
    if (!elEvolutionChart || !Array.isArray(chartData) || chartData.length === 0) return;
    const maxVisits = Math.max(...chartData.map(d => d.visits), 5);

    elEvolutionChart.innerHTML = chartData.map(d => {
      const heightPct = Math.max(6, Math.round((d.visits / maxVisits) * 100));
      return `
        <div class="chart-bar-group" title="${d.date}: ${d.visits} acessos, ${d.conversions} downloads/ações">
          <div style="font-size:10px;font-weight:700;color:#00f0ff;margin-bottom:4px;">${d.visits}</div>
          <div class="chart-bar" style="height: ${heightPct}%;"></div>
          <span class="chart-bar-label">${d.label}</span>
        </div>
      `;
    }).join('');
  }

  function updateFilterCounts(list) {
    if (!Array.isArray(list)) return;
    const total = list.length;
    const online = list.filter(item => item.isOnline).length;
    const humans = list.filter(item => item.isHuman).length;
    const bots = list.filter(item => item.isBot).length;
    const v4 = list.filter(item => (item.ipVersion || 'IPv4') === 'IPv4').length;
    const v6 = list.filter(item => item.ipVersion === 'IPv6').length;
    const ext = list.filter(item => !item.isLocal).length;
    const loc = list.filter(item => item.isLocal).length;
    const blocked = list.filter(item => item.isBlocked).length;

    const elCountAll = document.getElementById('count-all');
    const elCountHuman = document.getElementById('count-human');
    const elCountBot = document.getElementById('count-bot');
    const elCountOnline = document.getElementById('count-online');
    const elCountV4 = document.getElementById('count-ipv4');
    const elCountV6 = document.getElementById('count-ipv6');
    const elCountExt = document.getElementById('count-external');
    const elCountLoc = document.getElementById('count-local');
    const elCountBlocked = document.getElementById('count-blocked');

    if (elCountAll) elCountAll.textContent = total;
    if (elCountHuman) elCountHuman.textContent = humans;
    if (elCountBot) elCountBot.textContent = bots;
    if (elCountOnline) elCountOnline.textContent = online;
    if (elCountV4) elCountV4.textContent = v4;
    if (elCountV6) elCountV6.textContent = v6;
    if (elCountExt) elCountExt.textContent = ext;
    if (elCountLoc) elCountLoc.textContent = loc;
    if (elCountBlocked) elCountBlocked.textContent = blocked;
  }

  function applyIpFilterAndRender() {
    if (!elIpTableBody) return;

    const q = (currentSearch || '').trim().toLowerCase();

    const filtered = rawIpList.filter(item => {
      const ver = item.ipVersion || 'IPv4';

      // 1. Filtro por Categoria de IP
      if (currentFilter === 'human' && !item.isHuman) return false;
      if (currentFilter === 'bot' && !item.isBot) return false;
      if (currentFilter === 'online' && !item.isOnline) return false;
      if (currentFilter === 'ipv4' && ver !== 'IPv4') return false;
      if (currentFilter === 'ipv6' && ver !== 'IPv6') return false;
      if (currentFilter === 'external' && item.isLocal) return false;
      if (currentFilter === 'local' && !item.isLocal) return false;
      if (currentFilter === 'blocked' && !item.isBlocked) return false;

      // 2. Filtro de Busca Textual (IP, Cidade, Provedor, Aparelho ou URL)
      if (q) {
        const ipMatch = (item.ip || '').toLowerCase().includes(q);
        const cityMatch = (item.geo?.city || '').toLowerCase().includes(q);
        const countryMatch = (item.geo?.country || '').toLowerCase().includes(q);
        const ispMatch = (item.geo?.isp || '').toLowerCase().includes(q);
        const deviceMatch = (item.device || '').toLowerCase().includes(q);
        const subnetMatch = (item.localSubnet || '').toLowerCase().includes(q);
        const clientMatch = (item.clientName || item.geo?.reverse || item.geo?.org || '').toLowerCase().includes(q);
        const serverMatch = (item.serverName || currentServerName || '').toLowerCase().includes(q);
        const timeStr = item.lastSeen ? new Date(item.lastSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).toLowerCase() : '';
        const dateStr = item.lastSeen ? new Date(item.lastSeen).toLocaleDateString('pt-BR').toLowerCase() : '';
        const timeMatch = timeStr.includes(q) || dateStr.includes(q);
        const discMatch = Array.isArray(item.discoveredDevices) && item.discoveredDevices.some(d => (d || '').toLowerCase().includes(q));

        if (!ipMatch && !cityMatch && !countryMatch && !ispMatch && !deviceMatch && !subnetMatch && !clientMatch && !serverMatch && !timeMatch && !discMatch) {
          return false;
        }
      }

      return true;
    });

    renderIpTable(filtered);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatClickableUrl(rawPath) {
    const p = String(rawPath || '/').trim();
    if (/^https?:\/\//i.test(p)) return p;
    const origin = window.location.origin;
    if (p.startsWith('/')) return origin + p;
    return origin + '/' + p;
  }

  function getRequestsForIp(item) {
    if (!item) return [];
    const ip = item.ip;
    const connectionIp = item.connectionIp;
    const seen = new Set();
    const list = [];

    const add = (r) => {
      if (!r || !r.path) return;
      const path = String(r.path || '').trim();
      const key = (r.time || '') + '|' + (r.method || 'GET') + '|' + path + '|' + (r.status || 200);
      if (seen.has(key)) return;
      seen.add(key);
      list.push({
        time: r.time || (item.lastSeen ? new Date(item.lastSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--'),
        method: (r.method || 'GET').toUpperCase(),
        path: path,
        status: Number(r.status) || 200,
        durationMs: Number(r.durationMs) || 1
      });
    };

    // 1. Prioridade para requisições capturadas em tempo real deste IP
    (rawRequestsList || []).filter(r => r.ip === ip || (connectionIp && r.ip === connectionIp)).forEach(add);

    // 2. Histórico salvo no tracker deste IP
    (item.recentRequests || []).forEach(add);

    // 3. Fallback para rotas agregadas em pages
    if (list.length === 0 && item.pages) {
      Object.entries(item.pages).forEach(([path, count]) => {
        add({
          time: item.lastSeen ? new Date(item.lastSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--',
          method: 'GET',
          path,
          status: 200,
          durationMs: 1
        });
      });
    }

    return list;
  }

  let activeWindowIpKey = null;
  let isWindowMinimized = false;
  let windowReqFilter = 'all';
  let windowReqSearch = '';

  function findIpItemByKey(ipKey) {
    if (!ipKey) return null;
    return (rawIpList || []).find(it => String(it.ip || 'ip').replace(/[^a-zA-Z0-9]/g, '_') === ipKey);
  }

  function renderIpUrlsCell(item, ipKey, isExpanded, allReqs) {
    const pages = item.pages || {};
    const pageEntries = Object.entries(pages).sort((a, b) => b[1] - a[1]);
    const reqsCount = allReqs.length || pageEntries.length;

    if (pageEntries.length === 0 && allReqs.length === 0) {
      return `<span style="font-size:11px;color:#64748b;font-style:italic;">Aguardando requisições...</span>`;
    }

    const topPages = pageEntries.slice(0, 2);

    let html = `<div class="urls-cell-wrap">`;
    if (topPages.length > 0) {
      html += `<div class="urls-preview-chips">`;
      topPages.forEach(([path, count]) => {
        const fullUrl = formatClickableUrl(path);
        html += `
          <a href="${escapeHtml(fullUrl)}" target="_blank" rel="noopener noreferrer" class="url-chip linkable" title="Clique para abrir ${escapeHtml(path)} no navegador">
            <span class="url-chip-icon">🔗</span>
            <span class="url-chip-path">${escapeHtml(path)}</span>
            <span class="url-chip-count">${count}x</span>
            <span class="url-chip-ext">↗</span>
          </a>
        `;
      });
      html += `</div>`;
    }

    html += `
      <button type="button" class="btn-open-ip-window" onclick="window.openIpWindow('${ipKey}')" title="Clique para expandir relatório completo e requisições">
        <span>🗖 Expandir Janela (${reqsCount} reqs)</span>
      </button>
    `;

    html += `</div>`;
    return html;
  }

  window.openIpWindow = function(ipKey) {
    if (!ipKey) return;
    activeWindowIpKey = ipKey;
    isWindowMinimized = false;
    const dock = document.getElementById('ip-minimized-dock');
    if (dock) dock.style.display = 'none';
    const modal = document.getElementById('modal-ip-window');
    if (modal) modal.style.display = 'flex';
    renderIpWindow();
  };

  window.minimizeIpWindow = function() {
    isWindowMinimized = true;
    const modal = document.getElementById('modal-ip-window');
    if (modal) modal.style.display = 'none';
    updateMinimizedDock();
    if (typeof showToast === 'function') {
      showToast('🗕 Janela minimizada no canto inferior. Clique para restaurar.');
    }
  };

  window.restoreIpWindow = function() {
    isWindowMinimized = false;
    const dock = document.getElementById('ip-minimized-dock');
    if (dock) dock.style.display = 'none';
    const modal = document.getElementById('modal-ip-window');
    if (modal) modal.style.display = 'flex';
    renderIpWindow();
  };

  window.closeIpWindow = function() {
    activeWindowIpKey = null;
    isWindowMinimized = false;
    const modal = document.getElementById('modal-ip-window');
    if (modal) modal.style.display = 'none';
    const dock = document.getElementById('ip-minimized-dock');
    if (dock) dock.style.display = 'none';
  };

  window.handleIpWindowBackdropClick = function(event) {
    if (event && event.target && event.target.id === 'modal-ip-window') {
      window.minimizeIpWindow();
    }
  };

  window.setIpWindowFilter = function(filter) {
    windowReqFilter = filter;
    renderIpWindow();
  };

  window.setIpWindowSearch = function(val) {
    windowReqSearch = val || '';
    renderIpWindow();
  };

  window.clearIpWindowSearch = function() {
    windowReqSearch = '';
    renderIpWindow();
  };

  function updateMinimizedDock() {
    const dock = document.getElementById('ip-minimized-dock');
    if (!dock || !activeWindowIpKey) return;
    const item = findIpItemByKey(activeWindowIpKey);
    if (!item) return;
    const allReqs = getRequestsForIp(item);
    const titleEl = document.getElementById('ip-min-title');
    const subEl = document.getElementById('ip-min-subtitle');
    if (titleEl) titleEl.textContent = `IP: ${item.ip}`;
    if (subEl) {
      const city = item.geo?.city ? `${item.geo.city}` : (item.geo?.country || (item.isLocal ? 'Local' : ''));
      subEl.textContent = `${allReqs.length} requisições • ${city || 'Ativo'}`;
    }
    dock.style.display = 'flex';
  }

  function renderIpWindow() {
    const dialog = document.getElementById('modal-ip-window-dialog');
    if (!dialog || !activeWindowIpKey) return;

    const item = findIpItemByKey(activeWindowIpKey);
    if (!item) {
      dialog.innerHTML = `
        <div style="padding: 34px; text-align: center; color: #94a3b8;">
          <p style="font-size: 14px; margin-bottom: 12px;">IP não localizado no histórico atual do servidor.</p>
          <button type="button" class="btn-win-ctrl btn-window-close" onclick="window.closeIpWindow()">✕ Fechar</button>
        </div>
      `;
      return;
    }

    const allReqs = getRequestsForIp(item);
    const geo = item.geo || {};
    const flag = geo.flag || (item.isLocal ? '🏠' : '🌐');
    const cityStr = geo.city ? `${geo.city} - ${geo.country}` : (geo.country || (item.isLocal ? 'Rede Local' : 'Desconhecido'));
    const isOnline = !!item.isOnline;
    const timeStr = item.lastSeen ? new Date(item.lastSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--';
    const dateStr = item.lastSeen ? new Date(item.lastSeen).toLocaleDateString('pt-BR') : '';
    const ipVer = item.ipVersion || 'IPv4';
    const networkType = item.isLocal ? 'Rede Wi-Fi / Local' : 'Rede Externa / WAN';

    // Contadores para chips de filtro
    const countAll = allReqs.length;
    const count2xx = allReqs.filter(r => (Number(r.status) >= 200 && Number(r.status) < 300)).length;
    const countErr = allReqs.filter(r => Number(r.status) >= 400).length;
    const countGet = allReqs.filter(r => (r.method || 'GET').toUpperCase() === 'GET').length;
    const countPost = allReqs.filter(r => (r.method || 'GET').toUpperCase() === 'POST').length;

    // Filtros por método/status
    let filteredReqs = allReqs.slice();
    if (windowReqFilter === '2xx') {
      filteredReqs = filteredReqs.filter(r => (Number(r.status) >= 200 && Number(r.status) < 300));
    } else if (windowReqFilter === 'error') {
      filteredReqs = filteredReqs.filter(r => Number(r.status) >= 400);
    } else if (windowReqFilter === 'get') {
      filteredReqs = filteredReqs.filter(r => (r.method || 'GET').toUpperCase() === 'GET');
    } else if (windowReqFilter === 'post') {
      filteredReqs = filteredReqs.filter(r => (r.method || 'GET').toUpperCase() === 'POST');
    }

    // Busca textual na janela
    const q = (windowReqSearch || '').trim().toLowerCase();
    if (q) {
      filteredReqs = filteredReqs.filter(r => {
        const p = (r.path || '').toLowerCase();
        const m = (r.method || '').toLowerCase();
        const s = String(r.status || '');
        return p.includes(q) || m.includes(q) || s.includes(q);
      });
    }

    dialog.innerHTML = `
      <!-- Cabeçalho Superior da Janela Expandida -->
      <div class="ip-window-header">
        <div class="ip-window-title-group">
          <div class="ip-window-title-main">
            <span class="ip-win-main-text">📡 Relatório do IP</span>
            <span class="ip-win-badge-ip">${escapeHtml(item.ip)}</span>
            <span class="ip-win-client-badge ${item.isHuman ? 'human' : 'bot'}">
              ${escapeHtml(item.clientCategory || (item.isHuman ? '👤 Usuário Real' : '🤖 Robô / Scanner'))}
            </span>
            <span class="ip-win-status-pill ${isOnline ? 'online' : 'offline'}">
              ${isOnline ? '<span class="pulse-green-dot"></span> Conectado Agora' : '⚪ Offline'}
            </span>
          </div>
          <div class="ip-window-title-meta">
            <span>${flag} ${escapeHtml(cityStr)}</span>
            <span>•</span>
            <span>🏢 ${escapeHtml(geo.isp || 'Provedor')}</span>
            <span>•</span>
            <span>🏷️ Cliente: ${escapeHtml(item.clientName || geo.reverse || geo.org || geo.isp || item.device || 'Cliente')}</span>
            <span>•</span>
            <span>🕒 Acesso: ${escapeHtml(dateStr ? `${dateStr} ${timeStr}` : timeStr)}</span>
            <span>•</span>
            <span>📱 ${escapeHtml(item.device || 'Navegador')}</span>
          </div>
        </div>

        <div class="ip-window-controls">
          ${item.isBlocked ? `
            <button type="button" class="btn-win-ctrl" onclick="window.unblockIpPrompt('${escapeHtml(item.ip)}')" style="background:rgba(16,185,129,0.2);color:#34d399;border:1px solid rgba(16,185,129,0.4);" title="Desbloquear este IP no servidor">
              🟢 Desbloquear IP
            </button>
          ` : (!item.isLocal ? `
            <button type="button" class="btn-win-ctrl" onclick="window.blockIpPrompt('${escapeHtml(item.ip)}')" style="background:rgba(239,68,68,0.2);color:#fca5a5;border:1px solid rgba(239,68,68,0.4);" title="Bloquear requisições deste IP">
              🚫 Bloquear IP
            </button>
          ` : '')}
          <button type="button" class="btn-win-ctrl btn-window-action" onclick="window.copyAllIpUrls('${activeWindowIpKey}')" title="Copiar todas as URLs solicitadas por este IP">
            📋 Copiar URLs (${allReqs.length})
          </button>
          <button type="button" class="btn-win-ctrl btn-window-minimize" onclick="window.minimizeIpWindow()" title="Minimizar janela para continuar navegando no painel">
            🗕 Minimizar
          </button>
          <button type="button" class="btn-win-ctrl btn-window-close" onclick="window.closeIpWindow()" title="Fechar janela">
            ✕ Fechar
          </button>
        </div>
      </div>

      <!-- Corpo da Janela com Scroll Interno Limpo -->
      <div class="ip-window-body">
        <!-- 4 Cards Informativos do IP -->
        <div class="ip-window-cards">
          <div class="ip-win-card">
            <div class="ip-win-card-label"><span>📍 Localização & Provedor</span></div>
            <div class="ip-win-card-val">${flag} ${escapeHtml(cityStr)}</div>
            <div class="ip-win-card-sub">${escapeHtml(geo.isp || 'Provedor não identificado')}</div>
          </div>

          <div class="ip-win-card">
            <div class="ip-win-card-label"><span>💻 Aparelho & Classificação</span></div>
            <div class="ip-win-card-val">${escapeHtml(item.device || 'Navegador')}</div>
            <div class="ip-win-card-sub"><b style="color:${item.isHuman ? '#34d399' : '#fbbf24'};">${escapeHtml(item.clientCategory || (item.isHuman ? '👤 Usuário Real' : '🤖 Robô'))}</b> • ${ipVer} • ${networkType}${item.screen ? ` • ${escapeHtml(item.screen)}` : ''}</div>
          </div>

          <div class="ip-win-card">
            <div class="ip-win-card-label"><span>📊 Estatísticas de Acesso</span></div>
            <div class="ip-win-card-val" style="color:#00f0ff;">${countAll} requisições gravadas</div>
            <div class="ip-win-card-sub">${item.visitsCount || 1} visitas • ${item.conversions || 0} downloads</div>
          </div>

          <div class="ip-win-card">
            <div class="ip-win-card-label"><span>⏱️ Última Atividade</span></div>
            <div class="ip-win-card-val">${timeStr}</div>
            <div class="ip-win-card-sub">${dateStr} ${isOnline ? '<b style="color:#34d399;">(Tempo Real)</b>' : ''}</div>
          </div>
        </div>

        <!-- Barra de Filtros e Busca de Requisições -->
        <div class="ip-window-toolbar">
          <div class="ip-win-filters">
            <button type="button" class="btn-win-filter ${windowReqFilter === 'all' ? 'active' : ''}" onclick="window.setIpWindowFilter('all')">
              <span>Todas</span>
              <span class="win-filter-count">${countAll}</span>
            </button>
            <button type="button" class="btn-win-filter ${windowReqFilter === '2xx' ? 'active' : ''}" onclick="window.setIpWindowFilter('2xx')">
              <span>🟢 2xx Sucesso</span>
              <span class="win-filter-count">${count2xx}</span>
            </button>
            <button type="button" class="btn-win-filter ${windowReqFilter === 'error' ? 'active' : ''}" onclick="window.setIpWindowFilter('error')">
              <span>🔴 4xx / 5xx</span>
              <span class="win-filter-count">${countErr}</span>
            </button>
            <button type="button" class="btn-win-filter ${windowReqFilter === 'get' ? 'active' : ''}" onclick="window.setIpWindowFilter('get')">
              <span>GET</span>
              <span class="win-filter-count">${countGet}</span>
            </button>
            <button type="button" class="btn-win-filter ${windowReqFilter === 'post' ? 'active' : ''}" onclick="window.setIpWindowFilter('post')">
              <span>POST</span>
              <span class="win-filter-count">${countPost}</span>
            </button>
          </div>

          <div class="ip-win-search-wrap">
            <span class="ip-win-search-icon">🔍</span>
            <input type="text" class="ip-win-search-input" placeholder="Buscar rota, status (ex: 200), link..." value="${escapeHtml(windowReqSearch)}" oninput="window.setIpWindowSearch(this.value)">
            ${windowReqSearch ? `<button type="button" class="ip-win-search-clear" onclick="window.clearIpWindowSearch()" title="Limpar">✕</button>` : ''}
          </div>
        </div>

        <!-- Tabela Organizada com Largura Fixa e Zero Sobreposição -->
        <div class="ip-window-table-wrap">
          <table class="ip-window-table">
            <thead>
              <tr>
                <th class="col-time">Hora</th>
                <th class="col-method">Método</th>
                <th class="col-status">Status</th>
                <th class="col-path">Link / Rota Solicitada (Clique no link para abrir)</th>
                <th class="col-duration">Latência</th>
                <th class="col-action">Ações</th>
              </tr>
            </thead>
            <tbody>
              ${filteredReqs.length === 0 ? `
                <tr>
                  <td colspan="6" style="text-align:center;padding:34px 16px;color:#94a3b8;font-size:13px;">
                    ${q ? `🔍 Nenhuma requisição encontrada com o termo "<b>${escapeHtml(q)}</b>".` : 'Nenhuma requisição registrada nesta categoria.'}
                  </td>
                </tr>
              ` : filteredReqs.map(r => {
                const st = Number(r.status) || 200;
                const statusClass = st >= 500 ? 'status-5xx' : (st >= 400 ? 'status-4xx' : (st >= 300 ? 'status-3xx' : 'status-2xx'));
                const method = (r.method || 'GET').toUpperCase();
                const methodClass = 'method-' + method.toLowerCase();
                const fullUrl = formatClickableUrl(r.path || '/');
                const isProxy = (r.path || '').startsWith('/proxy?url=');
                let proxyTarget = '';
                if (isProxy) {
                  try {
                    const parsed = new URL(fullUrl);
                    proxyTarget = parsed.searchParams.get('url') || '';
                  } catch(e) {}
                }

                return `
                  <tr>
                    <td class="col-time">${escapeHtml(r.time || timeStr)}</td>
                    <td class="col-method"><span class="req-method-badge ${methodClass}">${escapeHtml(method)}</span></td>
                    <td class="col-status"><span class="req-status-badge ${statusClass}"><span>${st}</span></span></td>
                    <td class="col-path">
                      <div class="ip-win-req-container">
                        <a href="${escapeHtml(fullUrl)}" target="_blank" rel="noopener noreferrer" class="ip-win-req-link" title="Clique para abrir ${escapeHtml(r.path || '/')} em nova aba">
                          <span class="ip-win-link-icon">🔗</span>
                          <span class="ip-win-link-text">${escapeHtml(r.path || '/')}</span>
                          <span class="ip-win-ext-badge">Abrir ↗</span>
                        </a>
                        ${proxyTarget ? `
                          <div class="ip-win-proxy-block">
                            <span class="proxy-lbl">Destino original:</span>
                            <a href="${escapeHtml(proxyTarget)}" target="_blank" rel="noopener noreferrer" class="ip-win-proxy-link" title="Abrir URL externa de destino: ${escapeHtml(proxyTarget)}">
                              <span>${escapeHtml(proxyTarget)}</span>
                              <span style="font-weight:700;">↗</span>
                            </a>
                          </div>
                        ` : ''}
                      </div>
                    </td>
                    <td class="col-duration"><span class="req-latency">${r.durationMs || 1}ms</span></td>
                    <td class="col-action">
                      <button type="button" class="btn-win-copy-req" onclick="window.copyToClipboard('${escapeHtml(fullUrl)}', this)">
                        📋 Copiar
                      </button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  window.toggleIpUrls = function(ipKey) {
    window.openIpWindow(ipKey);
  };

  window.copyToClipboard = function(text, btn) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      if (btn) {
        const old = btn.textContent;
        btn.textContent = '✅ Copiado!';
        btn.style.color = '#34d399';
        setTimeout(() => {
          btn.textContent = old;
          btn.style.color = '';
        }, 1800);
      }
      if (typeof showToast === 'function') showToast('📋 URL copiada para a área de transferência!');
    }).catch(() => {
      if (typeof showToast === 'function') showToast('Não foi possível copiar automaticamente.');
    });
  };

  window.copyAllIpUrls = function(ipKey) {
    const item = findIpItemByKey(ipKey);
    if (!item) return;
    const reqs = getRequestsForIp(item);
    const urls = Array.from(new Set(reqs.map(r => formatClickableUrl(r.path || '/'))));
    if (urls.length === 0) {
      if (typeof showToast === 'function') showToast('Nenhuma URL encontrada para copiar.');
      return;
    }
    navigator.clipboard.writeText(urls.join('\n')).then(() => {
      if (typeof showToast === 'function') showToast(`📋 ${urls.length} URLs copiadas para a área de transferência!`);
    }).catch(() => {
      if (typeof showToast === 'function') showToast('Falha ao copiar URLs.');
    });
  };

  window.filterGlobalRequestsByIp = function(ip) {
    if (!ip) return;
    const item = (rawIpList || []).find(it => it.ip === ip);
    if (item) {
      const ipKey = String(item.ip || 'ip').replace(/[^a-zA-Z0-9]/g, '_');
      window.openIpWindow(ipKey);
    }
  };

  function renderIpTable(ipList) {
    if (!elIpTableBody || !Array.isArray(ipList)) return;
    if (ipList.length === 0) {
      elIpTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:26px;color:#94a3b8;font-size:13px;">🔍 Nenhum registro encontrado para o filtro selecionado.</td></tr>`;
      return;
    }

    elIpTableBody.innerHTML = ipList.map(item => {
      const geo = item.geo || {};
      const flag = geo.flag || (item.isLocal ? '🏠' : '🌐');
      const countryStr = geo.country || (item.isLocal ? 'Rede Local' : 'Desconhecido');
      const clientNameStr = item.clientName || geo.reverse || geo.org || geo.isp || item.device || (item.isLocal ? 'Rede Local' : 'Cliente Externo');
      const clientOrgStr = item.clientOrg || geo.org || geo.isp || '';
      const showSubOrg = clientOrgStr && clientOrgStr !== clientNameStr;
      const timeStr = item.lastSeen
        ? new Date(item.lastSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '--:--:--';
      const dateStr = item.lastSeen
        ? new Date(item.lastSeen).toLocaleDateString('pt-BR')
        : '';
      const isOnline = !!item.isOnline;
      const ipKey = String(item.ip || 'ip').replace(/[^a-zA-Z0-9]/g, '_');
      const allReqs = getRequestsForIp(item);

      return `
        <tr class="ip-row-card ${isOnline ? 'ip-row-connected-now' : ''}">
          <td class="td-ip" data-label="IP">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <span class="ip-badge clickable ${isOnline ? 'ip-badge-online' : ''}" onclick="window.openIpWindow('${ipKey}')" title="Clique para ver requests deste IP">${escapeHtml(item.ip)}</span>
              ${isOnline
                ? `<span class="ip-online-indicator" title="Conectado agora"><span class="pulse-green-dot"></span> Conectado</span>`
                : `<span class="ip-offline-indicator" title="Desconectado">⚪ Offline</span>`}
              ${item.isBlocked ? `<span class="ip-ver-badge" style="background:rgba(239,68,68,0.25);color:#fca5a5;border:1px solid #ef4444;font-weight:800;">🚫 BLOQUEADO</span>` : ''}
              ${item.isBlocked ? `
                <button type="button" onclick="event.stopPropagation(); window.unblockIpPrompt('${escapeHtml(item.ip)}')" style="background:rgba(16,185,129,0.18);border:1px solid rgba(16,185,129,0.4);color:#34d399;font-size:10px;font-weight:700;padding:2px 7px;border-radius:6px;cursor:pointer;" title="Desbloquear este IP">
                  🟢 Desbloquear
                </button>
              ` : (!item.isLocal ? `
                <button type="button" onclick="event.stopPropagation(); window.blockIpPrompt('${escapeHtml(item.ip)}')" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.35);color:#fca5a5;font-size:10px;font-weight:700;padding:2px 7px;border-radius:6px;cursor:pointer;" title="Bloquear requisições deste IP">
                  🚫 Bloquear
                </button>
              ` : '')}
            </div>
          </td>
          <td class="td-geo" data-label="País">
            <div class="location-chip">
              <span style="font-size:16px;">${flag}</span>
              <span>${escapeHtml(countryStr)}</span>
            </div>
          </td>
          <td class="td-server" data-label="Cliente (IP Externo)">
            <div style="display:flex;flex-direction:column;gap:2px;">
              <span class="server-name-badge" title="Nome / Hostname do cliente IP">${escapeHtml(clientNameStr)}</span>
              ${showSubOrg ? `<span style="font-size:11px;color:#94a3b8;">${escapeHtml(clientOrgStr)}</span>` : ''}
            </div>
          </td>
          <td class="td-time" data-label="Horário de Acesso">
            <div class="access-time-cell">
              <span class="access-time-hour">🕒 ${escapeHtml(timeStr)}</span>
              ${dateStr ? `<span class="access-time-date">${escapeHtml(dateStr)}</span>` : ''}
            </div>
          </td>
          <td class="td-urls" data-label="Request">
            ${renderIpUrlsCell(item, ipKey, false, allReqs)}
          </td>
        </tr>
      `;
    }).join('');
  }

  window.toggleMobileMenu = function(e) {
    if (e) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    const btnMenu = document.getElementById('btn-mobile-menu');
    const actionsDrawer = document.getElementById('admin-header-actions');
    if (!actionsDrawer) return;

    const isOpen = actionsDrawer.classList.toggle('mobile-open');
    if (btnMenu) btnMenu.classList.toggle('active', isOpen);
  };

  function setupMobileMenu() {
    const btnMenu = document.getElementById('btn-mobile-menu');
    const actionsDrawer = document.getElementById('admin-header-actions');
    if (!actionsDrawer) return;

    if (btnMenu) {
      btnMenu.onclick = window.toggleMobileMenu;
    }

    // Fechar ao clicar fora do cabeçalho
    document.addEventListener('click', (e) => {
      const header = document.getElementById('admin-header');
      if (!actionsDrawer.classList.contains('mobile-open')) return;
      if (header && !header.contains(e.target)) {
        actionsDrawer.classList.remove('mobile-open');
        if (btnMenu) btnMenu.classList.remove('active');
      }
    });

    // Fechar ao pressionar Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && actionsDrawer.classList.contains('mobile-open')) {
        actionsDrawer.classList.remove('mobile-open');
        if (btnMenu) btnMenu.classList.remove('active');
      }
    });

    // Fechar ao clicar em ações dentro da gaveta no mobile
    actionsDrawer.querySelectorAll('button:not(#btn-toggle-tracking)').forEach(btn => {
      btn.addEventListener('click', () => {
        actionsDrawer.classList.remove('mobile-open');
        if (btnMenu) btnMenu.classList.remove('active');
      });
    });
  }

  function setupFilterListeners() {
    if (filterListenersBound) return;
    filterListenersBound = true;

    // Filtros por Categoria/Versão (Todos, IPv4, IPv6, Externa, Local)
    const filterBtnsContainer = document.getElementById('ip-filter-buttons');
    if (filterBtnsContainer) {
      filterBtnsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.ip-filter-btn');
        if (!btn) return;
        const f = btn.getAttribute('data-filter') || 'all';
        currentFilter = f;
        filterBtnsContainer.querySelectorAll('.ip-filter-btn').forEach(b => {
          b.classList.toggle('active', b === btn);
        });
        applyIpFilterAndRender();
      });
    }

    // Busca Textual
    const searchInput = document.getElementById('ip-search-input');
    const clearBtn = document.getElementById('ip-search-clear');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        currentSearch = e.target.value;
        if (clearBtn) clearBtn.style.display = currentSearch ? 'block' : 'none';
        applyIpFilterAndRender();
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (searchInput) {
          searchInput.value = '';
          searchInput.focus();
        }
        currentSearch = '';
        clearBtn.style.display = 'none';
        applyIpFilterAndRender();
      });
    }
  }

  function setupRequestFilterListeners() {
    if (reqFilterListenersBound) return;
    reqFilterListenersBound = true;

    if (elReqFilterChips) {
      elReqFilterChips.addEventListener('click', (e) => {
        const btn = e.target.closest('.req-chip');
        if (!btn) return;
        const f = btn.getAttribute('data-filter') || 'all';
        currentReqFilter = f;
        elReqFilterChips.querySelectorAll('.req-chip').forEach(b => {
          b.classList.toggle('active', b === btn);
        });
        applyRequestFilterAndRender();
      });
    }

    if (elReqSearchInput) {
      elReqSearchInput.addEventListener('input', (e) => {
        currentReqSearch = (e.target.value || '').trim().toLowerCase();
        if (elReqSearchClear) elReqSearchClear.style.display = currentReqSearch ? 'block' : 'none';
        applyRequestFilterAndRender();
      });
    }

    if (elReqSearchClear) {
      elReqSearchClear.addEventListener('click', () => {
        if (elReqSearchInput) {
          elReqSearchInput.value = '';
          elReqSearchInput.focus();
        }
        currentReqSearch = '';
        elReqSearchClear.style.display = 'none';
        applyRequestFilterAndRender();
      });
    }
  }

  function updateRequestFilterCounts(requests) {
    if (!Array.isArray(requests)) requests = [];
    const total = requests.length;
    let count2xx = 0;
    let countErr = 0;
    let countGet = 0;
    let countPost = 0;

    requests.forEach(r => {
      const st = Number(r.status) || 200;
      const m = (r.method || 'GET').toUpperCase();
      if (st >= 200 && st < 300) count2xx++;
      if (st >= 400) countErr++;
      if (m === 'GET') countGet++;
      if (m === 'POST') countPost++;
    });

    if (elBadgeTotalRequests) elBadgeTotalRequests.textContent = `${total} capturadas`;
    if (elCountReqAll) elCountReqAll.textContent = String(total);
    if (elCountReq2xx) elCountReq2xx.textContent = String(count2xx);
    if (elCountReqErr) elCountReqErr.textContent = String(countErr);
    if (elCountReqGet) elCountReqGet.textContent = String(countGet);
    if (elCountReqPost) elCountReqPost.textContent = String(countPost);
  }

  function applyRequestFilterAndRender() {
    if (!elRequestsTableBody) return;
    if (!Array.isArray(rawRequestsList) || rawRequestsList.length === 0) {
      elRequestsTableBody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-state" style="text-align:center;padding:32px;color:var(--text-muted);font-size:12.5px;">
            Aguardando primeiras requisições chegarem ao servidor...
          </td>
        </tr>
      `;
      return;
    }

    let filtered = rawRequestsList.slice();

    if (currentReqFilter === '2xx') {
      filtered = filtered.filter(r => (Number(r.status) >= 200 && Number(r.status) < 300));
    } else if (currentReqFilter === 'error') {
      filtered = filtered.filter(r => Number(r.status) >= 400);
    } else if (currentReqFilter === 'get') {
      filtered = filtered.filter(r => (r.method || 'GET').toUpperCase() === 'GET');
    } else if (currentReqFilter === 'post') {
      filtered = filtered.filter(r => (r.method || 'GET').toUpperCase() === 'POST');
    }

    if (currentReqSearch) {
      const term = currentReqSearch.toLowerCase();
      filtered = filtered.filter(r => {
        const p = (r.path || '').toLowerCase();
        const m = (r.method || '').toLowerCase();
        const s = String(r.status || '');
        const ip = (r.ip || '').toLowerCase();
        const dev = (r.device || '').toLowerCase();
        const country = ((r.geo && r.geo.country) || '').toLowerCase();
        const city = ((r.geo && r.geo.city) || '').toLowerCase();
        return p.includes(term) || m.includes(term) || s.includes(term) || ip.includes(term) || dev.includes(term) || country.includes(term) || city.includes(term);
      });
    }

    if (filtered.length === 0) {
      elRequestsTableBody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-state" style="text-align:center;padding:26px;color:var(--text-muted);font-size:12.5px;">
            Nenhuma requisição encontrada para o filtro ou termo pesquisado.
          </td>
        </tr>
      `;
      return;
    }

    elRequestsTableBody.innerHTML = filtered.map(r => {
      const st = Number(r.status) || 200;
      let statusClass = 'status-2xx';
      if (st >= 500) statusClass = 'status-5xx';
      else if (st >= 400) statusClass = 'status-4xx';
      else if (st >= 300) statusClass = 'status-3xx';

      const method = (r.method || 'GET').toUpperCase();
      let methodClass = 'method-' + method.toLowerCase();

      const duration = Number(r.durationMs) || 1;
      let latencyClass = '';
      if (duration > 350) latencyClass = 'latency-slow';
      else if (duration > 120) latencyClass = 'latency-med';

      const geo = r.geo || {};
      const flag = geo.flag || (r.isLocal ? '🏠' : '🌐');
      const originSub = geo.city || (r.isLocal ? 'Wi-Fi / Local' : geo.country || 'Internet');

      return `
        <tr>
          <td class="td-req-top">
            <span class="req-time">${escapeHtml(r.time || '')}</span>
          </td>
          <td>
            <span class="req-method-badge ${methodClass}">${escapeHtml(method)}</span>
          </td>
          <td>
            <span class="req-status-badge ${statusClass}">
              <span>${st}</span>
            </span>
          </td>
          <td class="td-req-path">
            <div class="req-path-wrap">
              <a href="${escapeHtml(formatClickableUrl(r.path || '/'))}" target="_blank" rel="noopener noreferrer" class="req-path linkable" title="Clique para abrir ${escapeHtml(r.path || '/')} em nova aba">
                <span class="link-icon">🔗</span>
                <span class="link-text">${escapeHtml(r.path || '/')}</span>
                <span class="link-ext-pill">Abrir ↗</span>
              </a>
            </div>
          </td>
          <td>
            <span class="req-latency ${latencyClass}">${duration}ms</span>
          </td>
          <td>
            <div class="req-ip-cell" onclick="window.filterGlobalRequestsByIp('${escapeHtml(r.ip || '')}')" style="cursor:pointer;" title="Clique para filtrar apenas este IP">
              <span>${flag}</span>
              <span class="req-ip-text" style="text-decoration:underline;text-underline-offset:2px;">${escapeHtml(r.ip || '')}</span>
              <span class="req-geo-sub">(${escapeHtml(originSub)})</span>
            </div>
          </td>
          <td>
            <div class="req-device-cell" title="${escapeHtml(r.device || '')}">
              ${escapeHtml(r.device || 'Navegador')}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  window.clearLiveRequests = async function() {
    if (!confirm('Deseja limpar a lista de requisições capturadas?')) return;
    try {
      const res = await fetch('/api/papaleguas/clear-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        }
      });
      const data = await res.json();
      if (data.success) {
        rawRequestsList = [];
        updateRequestFilterCounts([]);
        applyRequestFilterAndRender();
        if (typeof showToast === 'function') showToast('🗑️ Requisições capturadas limpas com sucesso!');
      } else {
        if (typeof showToast === 'function') showToast(data.error || 'Erro ao limpar requisições.');
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('Falha ao comunicar com o servidor.');
    }
  };

  // ---------------------------------------------------------------------------
  // GERENCIAMENTO DO BLOQUEADOR DE IPS (FIREWALL & ANTI-ABUSO)
  // ---------------------------------------------------------------------------
  function renderBlockedIpsUi(blockedIps, totalBlocked, totalHits) {
    const elBadgeBlocked = document.getElementById('badge-total-blocked');
    const elBadgeBlockedHits = document.getElementById('badge-total-blocked-hits');
    const elTbody = document.getElementById('blocked-ips-table-body');

    const total = totalBlocked != null ? totalBlocked : (Array.isArray(blockedIps) ? blockedIps.length : 0);
    const hits = totalHits != null ? totalHits : (Array.isArray(blockedIps) ? blockedIps.reduce((s, b) => s + (b.hitsBlocked || 0), 0) : 0);

    if (elBadgeBlocked) elBadgeBlocked.textContent = `${total} ${total === 1 ? 'IP Bloqueado' : 'IPs Bloqueados'}`;
    if (elBadgeBlockedHits) elBadgeBlockedHits.textContent = `${hits} ${hits === 1 ? 'Tentativa Barrada' : 'Requisições Barradas'}`;

    if (!elTbody) return;
    if (!Array.isArray(blockedIps) || blockedIps.length === 0) {
      elTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:22px;color:#94a3b8;font-size:13px;">Nenhum IP bloqueado no momento.</td></tr>`;
      return;
    }

    elTbody.innerHTML = blockedIps.map((b) => {
      const dateStr = b.blockedAt ? new Date(b.blockedAt).toLocaleString('pt-BR') : '--';
      const hitsCount = Number(b.hitsBlocked) || 0;
      return `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-family:monospace;font-size:13px;font-weight:700;color:#f87171;">${escapeHtml(b.ip)}</span>
              <span style="background:rgba(239,68,68,0.2);color:#fca5a5;border:1px solid rgba(239,68,68,0.4);font-size:10px;padding:2px 6px;border-radius:4px;font-weight:700;">BLOQUEADO</span>
            </div>
          </td>
          <td style="color:#cbd5e1;font-size:12px;">${escapeHtml(b.reason || 'Sem motivo')}</td>
          <td style="color:#94a3b8;font-size:11.5px;">${dateStr}</td>
          <td>
            <span style="background:rgba(245,158,11,0.18);border:1px solid rgba(245,158,11,0.35);color:#fbbf24;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;">
              🛑 ${hitsCount} barradas
            </span>
          </td>
          <td style="text-align:center;">
            <button type="button" onclick="window.unblockIpPrompt('${escapeHtml(b.ip)}')" style="background:rgba(16,185,129,0.18);border:1px solid rgba(16,185,129,0.4);color:#34d399;font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;cursor:pointer;transition:0.2s;" title="Desbloquear este IP">
              🟢 Desbloquear
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  window.toggleBinanceQrPreview = function() {
    const box = document.getElementById('binance-qr-preview-box');
    const btn = document.getElementById('btn-toggle-binance-qr');
    if (!box) return;
    const isHidden = box.style.display === 'none' || !box.style.display;
    box.style.display = isHidden ? 'block' : 'none';
    if (btn) btn.textContent = isHidden ? '🙈 Ocultar QR Code' : '👁️ Ver QR Code Binance Pay';
  };

  window.blockIpPrompt = async function(ip) {
    if (!ip) return;
    const cleanIp = String(ip).trim();
    const reason = prompt(`🚫 Bloquear IP: ${cleanIp}\n\nDigite o motivo do bloqueio (opcional):\n(O infrator verá aviso para pagar 5 USDT via Binance Pay para liberar):`, 'Acesso abusivo / Desbloqueio: 5 USDT');
    if (reason === null) return;

    try {
      const res = await fetch('/api/papaleguas/block-ip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({ ip: cleanIp, reason })
      });
      const data = await res.json();
      if (data && data.success) {
        if (typeof showToast === 'function') showToast(`🚫 IP ${cleanIp} foi bloqueado com sucesso!`);
        if (typeof window.loadMetrics === 'function') window.loadMetrics();
      } else {
        alert((data && data.error) || 'Não foi possível bloquear este IP.');
      }
    } catch (err) {
      alert('Erro de conexão ao tentar bloquear o IP: ' + err.message);
    }
  };

  window.unblockIpPrompt = async function(ip) {
    if (!ip) return;
    const cleanIp = String(ip).trim();
    if (!confirm(`Deseja desbloquear o IP ${cleanIp}? Ele voltará a ter permissão para acessar o servidor.`)) {
      return;
    }

    try {
      const res = await fetch('/api/papaleguas/unblock-ip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({ ip: cleanIp })
      });
      const data = await res.json();
      if (data && data.success) {
        if (typeof showToast === 'function') showToast(`🟢 IP ${cleanIp} desbloqueado com sucesso!`);
        if (typeof window.loadMetrics === 'function') window.loadMetrics();
      } else {
        alert((data && data.error) || 'Não foi possível desbloquear este IP.');
      }
    } catch (err) {
      alert('Erro de conexão ao tentar desbloquear o IP: ' + err.message);
    }
  };

  window.handleManualBlockIp = async function() {
    const inputIp = document.getElementById('input-block-ip');
    const inputReason = document.getElementById('input-block-reason');
    if (!inputIp) return;
    const ip = (inputIp.value || '').trim();
    const reason = (inputReason ? inputReason.value : '').trim() || 'Bloqueado manualmente no painel admin';

    if (!ip) {
      alert('Por favor, informe um endereço de IP válido para bloquear.');
      inputIp.focus();
      return;
    }

    try {
      const res = await fetch('/api/papaleguas/block-ip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({ ip, reason })
      });
      const data = await res.json();
      if (data && data.success) {
        if (typeof showToast === 'function') showToast(`🚫 IP ${ip} bloqueado com sucesso!`);
        inputIp.value = '';
        if (inputReason) inputReason.value = '';
        if (typeof window.loadMetrics === 'function') window.loadMetrics();
      } else {
        alert((data && data.error) || 'Não foi possível bloquear o IP.');
      }
    } catch (err) {
      alert('Erro ao tentar bloquear o IP: ' + err.message);
    }
  };

  function renderRecentFeed(visits) {
    if (elRecentFeed) elRecentFeed.innerHTML = '';
  }

  function formatCountdown(sec) {
    if (sec <= 0) return '0:00';
    if (sec >= 3600) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return `${h}h ${m}m`;
    }
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function updateCountdownDisplay() {
    if (!elCountdownText) return;
    if (refreshIntervalMs <= 0) {
      if (elCountdownBox) elCountdownBox.classList.add('paused');
      elCountdownText.textContent = 'Manual';
      return;
    }
    if (elCountdownBox) elCountdownBox.classList.remove('paused');
    elCountdownText.textContent = formatCountdown(countdownSeconds);
  }

  function getNextRefreshTimestamp() {
    const stored = parseInt(localStorage.getItem('papaleguas_next_refresh_time'), 10);
    return isNaN(stored) ? null : stored;
  }

  function setNextRefreshTimestamp(ts) {
    localStorage.setItem('papaleguas_next_refresh_time', String(ts));
  }

  function startAutoRefresh(isIntervalChange = false) {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    if (countdownTimer) clearInterval(countdownTimer);

    if (refreshIntervalMs <= 0) {
      localStorage.removeItem('papaleguas_next_refresh_time');
      updateCountdownDisplay();
      return;
    }

    let nextTime = getNextRefreshTimestamp();
    const now = Date.now();

    // Se o usuário mudou o intervalo, ou se não há timestamp, ou se já passou ou está inconsistente:
    if (isIntervalChange || !nextTime || nextTime <= now || nextTime > (now + refreshIntervalMs + 5000)) {
      nextTime = now + refreshIntervalMs;
      setNextRefreshTimestamp(nextTime);
    }

    countdownSeconds = Math.max(0, Math.round((nextTime - now) / 1000));
    updateCountdownDisplay();

    // Contagem regressiva a cada 1 segundo sincronizada com o timestamp alvo
    countdownTimer = setInterval(() => {
      if (refreshIntervalMs <= 0) {
        updateCountdownDisplay();
        return;
      }
      const currentNow = Date.now();
      let targetTime = getNextRefreshTimestamp();
      if (!targetTime) {
        targetTime = currentNow + refreshIntervalMs;
        setNextRefreshTimestamp(targetTime);
      }

      const diffSec = Math.round((targetTime - currentNow) / 1000);
      if (diffSec <= 0) {
        // Dispara atualização automática e agenda a próxima
        targetTime = Date.now() + refreshIntervalMs;
        setNextRefreshTimestamp(targetTime);
        countdownSeconds = Math.floor(refreshIntervalMs / 1000);
        updateCountdownDisplay();
        loadMetrics(false);
      } else {
        countdownSeconds = diffSec;
        updateCountdownDisplay();
      }
    }, 1000);
  }

  function setupIntervalSelector() {
    if (!elIntervalSelect) return;
    elIntervalSelect.value = String(refreshIntervalMs);

    elIntervalSelect.addEventListener('change', (e) => {
      const newInterval = parseInt(e.target.value, 10);
      refreshIntervalMs = isNaN(newInterval) ? 3000 : newInterval;
      localStorage.setItem('papaleguas_refresh_interval', String(refreshIntervalMs));
      startAutoRefresh(true);
    });
  }

  function showAlert(el, msg, type) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'auth-alert ' + (type === 'error' ? 'auth-alert-error' : 'auth-alert-success');
    el.style.display = 'block';
  }

  function showToast(msg, duration = 3500) {
    if (!elToast) return;
    elToast.textContent = msg;
    elToast.style.display = 'block';
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      elToast.style.display = 'none';
    }, duration);
  }

  function updateTrackingUi(enabled) {
    isTrackingActive = enabled !== false;
    if (elBtnToggleTracking) {
      elBtnToggleTracking.classList.toggle('active', isTrackingActive);
      elBtnToggleTracking.classList.toggle('paused', !isTrackingActive);
      elBtnToggleTracking.title = isTrackingActive
        ? 'Clique para pausar o registro de logs e requisições'
        : 'Clique para retomar o registro de logs e requisições';
    }
    if (elTrackingText) {
      elTrackingText.textContent = isTrackingActive ? 'Registro Ativo' : 'Registro Pausado';
    }
    if (elPausedBanner) {
      elPausedBanner.style.display = isTrackingActive ? 'none' : 'flex';
    }
  }



  function updateTunnelUi(cfUrl, lanUrl) {
    const dashCfLink = document.getElementById('dash-cf-link');
    const dashCfBtnOpen = document.getElementById('dash-cf-btn-open');
    const dashLanLink = document.getElementById('dash-lan-link');
    const dashLanBtnOpen = document.getElementById('dash-lan-btn-open');
    const cfText = document.getElementById('cf-tunnel-url-text');

    const effectiveCf = cfUrl || 'https://papaleguas.app';
    if (elCfContainer) elCfContainer.style.display = 'inline-flex';
    if (elCfLink) elCfLink.href = effectiveCf;
    if (cfText) cfText.textContent = effectiveCf;
    if (dashCfLink) {
      dashCfLink.href = effectiveCf;
      dashCfLink.textContent = effectiveCf;
    }
    if (dashCfBtnOpen) dashCfBtnOpen.href = effectiveCf;

    if (lanUrl) {
      if (dashLanLink) {
        dashLanLink.href = lanUrl;
        dashLanLink.textContent = lanUrl;
      }
      if (dashLanBtnOpen) dashLanBtnOpen.href = lanUrl;
    }
  }

  function updateNgrokUi(ngUrl, connecting, lanUrl) {
    updateTunnelUi('https://papaleguas.app', lanUrl);
  }

  window.copyOfficialUrl = async function(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    const fullUrl = 'https://papaleguas.app';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(fullUrl);
      } else {
        const temp = document.createElement('textarea');
        temp.value = fullUrl;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
      }
      showToast('📋 Domínio oficial copiado: ' + fullUrl, 3000);
    } catch (err) {
      showToast('⚠️ Falha ao copiar link.', 3000);
    }
  };

  window.copyNgrokUrl = window.copyOfficialUrl;

  window.copyLanUrl = async function(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    const url = 'http://192.168.1.35:8080';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      }
      showToast('📋 Link local Wi-Fi copiado: ' + url, 3500);
    } catch (err) {}
  };



  window.handleServerLogsSelect = async function(val) {
    const isPaused = val === 'paused';
    try {
      if (elServerLogsSelect) elServerLogsSelect.style.opacity = '0.6';
      const res = await fetch('/api/papaleguas/server-logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({ paused: isPaused })
      });
      const data = await res.json();
      if (data.success) {
        if (data.serverLogsPaused) {
          showToast('⏸️ Logs do terminal do servidor PAUSADOS (modo silencioso).', 4000);
        } else {
          showToast('🟢 Logs do terminal do servidor ATIVADOS (visíveis).', 4000);
        }
      } else {
        showToast(data.error || '⚠️ Erro ao alterar logs do servidor.');
        if (elServerLogsSelect) elServerLogsSelect.value = isPaused ? 'enabled' : 'paused';
      }
    } catch (e) {
      showToast('⚠️ Falha ao comunicar com o servidor.');
      if (elServerLogsSelect) elServerLogsSelect.value = isPaused ? 'enabled' : 'paused';
    } finally {
      if (elServerLogsSelect) elServerLogsSelect.style.opacity = '1';
    }
  };

  function updateAdminTorUi(enabled, connected) {
    adminTorEnabled = Boolean(enabled);
    if (!elBtnToggleAdminTor) return;
    const on = adminTorEnabled && connected !== false;
    elBtnToggleAdminTor.classList.toggle('connected', on);
    elBtnToggleAdminTor.classList.toggle('disconnected', !on);
    elBtnToggleAdminTor.title = on
      ? 'Desconecta a saída da rede Tor e volta para a internet direta'
      : 'Volta a sair pela rede Tor';
    if (elAdminTorText) {
      elAdminTorText.textContent = on ? 'Desconectar Tor' : 'Conectar Tor';
    }
  }

  async function refreshAdminTorStatus() {
    try {
      const res = await fetch('/api/papaleguas/status', {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      const data = await res.json();
      if (typeof data.torEnabled === 'boolean') updateAdminTorUi(data.torEnabled, data.torConnected);
    } catch (e) {}
  }

  window.toggleAdminTor = async function() {
    const turningOff = adminTorEnabled;
    if (turningOff) {
      const ok = confirm('Desconectar da rede Tor? A saída deste servidor passa a usar a internet direta.');
      if (!ok) return;
    }
    try {
      if (elBtnToggleAdminTor) elBtnToggleAdminTor.style.opacity = '0.6';
      if (elAdminTorText) elAdminTorText.textContent = turningOff ? 'Desconectando...' : 'Conectando...';
      const res = await fetch('/api/papaleguas/toggle-tor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({ enabled: !turningOff })
      });
      const data = await res.json();
      if (data.success) {
        updateAdminTorUi(data.enabled, data.connected);
        try {
          if (window.torBrowserAPI && typeof window.torBrowserAPI.toggleTor === 'function') {
            await window.torBrowserAPI.toggleTor(Boolean(data.enabled));
          }
        } catch (e) {}
        showToast(data.message || (data.enabled ? 'Conectado à rede Tor.' : 'Desconectado da rede Tor.'));
      } else {
        updateAdminTorUi(false, false);
        showToast(data.error || 'Não foi possível alterar o Tor.');
      }
    } catch (e) {
      showToast('Falha ao comunicar com o servidor.');
      refreshAdminTorStatus();
    } finally {
      if (elBtnToggleAdminTor) elBtnToggleAdminTor.style.opacity = '1';
    }
  };

  window.toggleTracking = async function() {
    try {
      if (elBtnToggleTracking) elBtnToggleTracking.style.opacity = '0.6';
      const res = await fetch('/api/papaleguas/toggle-tracking', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({ enabled: !isTrackingActive })
      });
      const data = await res.json();
      if (data.success) {
        updateTrackingUi(data.isTrackingEnabled);
        showToast(data.message || (data.isTrackingEnabled ? '🟢 Registro de requisições ATIVADO.' : '⏸️ Registro de requisições PAUSADO.'));
      } else {
        showToast(data.error || '⚠️ Erro ao alterar estado de registro.');
      }
    } catch (e) {
      showToast('⚠️ Falha ao comunicar com o servidor.');
    } finally {
      if (elBtnToggleTracking) elBtnToggleTracking.style.opacity = '1';
    }
  };

  window.promptClearAllData = function() {
    if (elModalClear) {
      elModalClear.style.display = 'flex';
    } else {
      if (confirm('ATENÇÃO: Deseja realmente excluir permanentemente todos os registros de requisições, acessos e logs? Todos os dados voltarão para ZERO (0).')) {
        window.executeClearAllData();
      }
    }
  };

  window.closeClearModal = function() {
    if (elModalClear) {
      elModalClear.style.display = 'none';
    }
  };

  window.executeClearAllData = async function() {
    try {
      if (elBtnConfirmClear) {
        elBtnConfirmClear.disabled = true;
        elBtnConfirmClear.textContent = '⏳ Zerando Tudo...';
      }

      const res = await fetch('/api/papaleguas/clear-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        }
      });
      const data = await res.json();
      if (data.success) {
        window.closeClearModal();
        showToast('🗑️ Todos os dados e logs foram excluídos! Começando do zero (0).', 5000);
        // Atualiza dashboard imediatamente
        window.loadMetrics(true);
      } else {
        alert(data.error || 'Erro ao excluir dados.');
      }
    } catch (e) {
      alert('Falha ao comunicar com o servidor para zerar os dados.');
    } finally {
      if (elBtnConfirmClear) {
        elBtnConfirmClear.disabled = false;
        elBtnConfirmClear.textContent = '🗑️ Sim, Zerar Tudo (Começar do 0)';
      }
    }
  };

  window.exportDataJson = async function() {
    try {
      const res = await fetch('/api/papaleguas/metrics', {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `papaleguas_relatorio_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch(e) {
      alert('Erro ao exportar dados.');
    }
  };

  async function loadTelegramBotStatus() {
    try {
      const res = await fetch('/api/telegram-bot/status');
      if (!res.ok) return;
      const data = await res.json();
      const st = data && data.status;
      const badge = document.getElementById('admin-tg-status');
      if (badge && st) {
        if (st.enabled && st.username) {
          badge.textContent = `🟢 @${st.username}`;
          badge.style.color = '#34d399';
        } else if (st.hasToken) {
          badge.textContent = '🟡 Conectando...';
          badge.style.color = '#f59e0b';
        } else {
          badge.textContent = '💬 Não configurado';
          badge.style.color = '#94a3b8';
        }
      }
    } catch (e) {}
  }
  window.loadTelegramBotStatus = loadTelegramBotStatus;

  async function saveTelegramBotToken() {
    const input = document.getElementById('admin-tg-token');
    const token = (input ? input.value : '').trim();
    try {
      const res = await fetch('/api/telegram-bot/set-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (data && data.success) {
        if (typeof showToast === 'function') {
          showToast(token ? `✅ Bot conectado com sucesso${data.result && data.result.username ? ' como @' + data.result.username : ''}!` : 'Token do bot removido.');
        } else {
          alert(token ? `Bot conectado como @${data.result.username}!` : 'Token removido.');
        }
        loadTelegramBotStatus();
        if (input) input.value = '';
      } else {
        const err = (data && data.error) ? data.error : 'Falha ao salvar token';
        if (typeof showToast === 'function') showToast(`❌ Erro: ${err}`);
        else alert(`Erro: ${err}`);
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast(`❌ Falha de rede: ${e.message}`);
      else alert(`Falha de rede: ${e.message}`);
    }
  }
  window.saveTelegramBotToken = saveTelegramBotToken;

  // =========================================================================
  // CENTRAL DE COMANDO DE ROBÔS (BOT COMMANDER)
  // "Cada robô que conectar, será comandado por nós"
  // =========================================================================
  async function loadBotCommanderUi() {
    try {
      const res = await fetch('/api/papaleguas/bot-commander', {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.success) return;

      const config = data.config || {};
      const bots = data.connectedBots || [];
      const stats = data.stats || {};

      const elCount = document.getElementById('badge-bots-count');
      if (elCount) elCount.textContent = `${stats.totalBots || bots.length} Robôs Conectados`;

      const elExec = document.getElementById('badge-bots-executed');
      if (elExec) elExec.textContent = `${stats.totalCommandsExecuted || 0} Ordens Executadas`;

      const elSelect = document.getElementById('select-bot-mode');
      if (elSelect && !elSelect.dataset.userEditing) {
        elSelect.value = config.activeMode || 'INSTRUCT_AI';
      }

      const elText = document.getElementById('input-bot-instruction');
      if (elText && !elText.dataset.userEditing) {
        elText.value = config.aiInstruction || '';
      }

      // Previne que a digitação do usuário seja sobrescrita pelo polling de atualização
      if (elText && !elText.dataset.boundEvents) {
        elText.dataset.boundEvents = 'true';
        elText.addEventListener('focus', () => { elText.dataset.userEditing = 'true'; });
        elText.addEventListener('blur', () => { setTimeout(() => { delete elText.dataset.userEditing; }, 4000); });
      }
      if (elSelect && !elSelect.dataset.boundEvents) {
        elSelect.dataset.boundEvents = 'true';
        elSelect.addEventListener('focus', () => { elSelect.dataset.userEditing = 'true'; });
        elSelect.addEventListener('blur', () => { setTimeout(() => { delete elSelect.dataset.userEditing; }, 4000); });
      }

      const tbody = document.getElementById('bots-table-body');
      if (!tbody) return;

      if (!bots.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:22px;color:#94a3b8;">Nenhum robô conectado ainda. Quando um robô, crawler ou IA conectar, ele aparecerá aqui sob comando.</td></tr>';
        return;
      }

      tbody.innerHTML = bots.map((b) => {
        const pathsStr = Array.isArray(b.paths) && b.paths.length ? b.paths.slice(0, 3).join(', ') : '/';
        const timeStr = b.lastSeen ? new Date(b.lastSeen).toLocaleTimeString('pt-BR', { hour12: false }) : '--';
        return `
          <tr>
            <td>
              <div style="font-weight:700;color:#00f0ff;display:flex;align-items:center;gap:6px;">
                <span>🤖</span> <span>${escapeHtml(b.name)}</span>
              </div>
              <div style="font-size:10px;color:#64748b;margin-top:2px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(b.userAgent)}">${escapeHtml(b.userAgent)}</div>
            </td>
            <td>
              <span style="font-family:monospace;font-weight:600;color:#cbd5e1;">${escapeHtml(b.ip)}</span>
              <div style="font-size:10.5px;color:#94a3b8;">${b.visitsCount || 1} requisições</div>
            </td>
            <td style="font-size:11px;color:#38bdf8;word-break:break-all;">
              ${escapeHtml(pathsStr)}
            </td>
            <td>
              <span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;background:rgba(16,185,129,0.18);border:1px solid rgba(16,185,129,0.4);color:#34d399;font-size:11px;font-weight:700;">
                👑 ${escapeHtml(b.currentCommand || 'INSTRUCT_AI')}
              </span>
            </td>
            <td style="text-align:center;font-size:11.5px;color:#94a3b8;">
              ${escapeHtml(timeStr)}
            </td>
          </tr>
        `;
      }).join('');
    } catch (e) {
      console.warn('[BOT COMMANDER LOAD ERR]', e);
    }
  }

  window.saveBotCommandSettings = async function() {
    const elSelect = document.getElementById('select-bot-mode');
    const elText = document.getElementById('input-bot-instruction');
    const activeMode = elSelect ? elSelect.value : 'INSTRUCT_AI';
    const aiInstruction = elText ? elText.value : '';

    try {
      const res = await fetch('/api/papaleguas/bot-commander/set-command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({ activeMode, aiInstruction })
      });
      const data = await res.json();
      if (data && data.success) {
        showToast('👑 Comando emitido com sucesso! Todos os robôs que conectarem executarão esta ordem.');
        if (elSelect) delete elSelect.dataset.userEditing;
        if (elText) delete elText.dataset.userEditing;
        loadBotCommanderUi();
      } else {
        showToast('❌ Erro ao emitir comando: ' + (data.error || 'Falha'));
      }
    } catch (err) {
      showToast('❌ Falha de comunicação ao emitir comando aos robôs.');
    }
  };

  window.clearBotHistory = async function() {
    if (!confirm('Deseja limpar a lista de robôs conectados?')) return;
    try {
      const res = await fetch('/api/papaleguas/bot-commander/clear-bots', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      const data = await res.json();
      if (data && data.success) {
        showToast('🗑️ Histórico de robôs zerado com sucesso.');
        loadBotCommanderUi();
      }
    } catch (e) {}
  };

  let pplActiveModulesCache = [];

  window.syncPplRunnerFunctions = function(modName) {
    const fnSel = document.getElementById('ppl-runner-fn');
    if (!fnSel) return;
    const mod = pplActiveModulesCache.find(function(m) { return m.name === modName; });
    const fns = (mod && Array.isArray(mod.exportedFunctions)) ? mod.exportedFunctions : [];
    fnSel.innerHTML = fns.length
      ? fns.map(function(f) {
          const sig = (f.params || []).map(function(p) { return p.name + ':' + p.paramType; }).join(', ');
          return '<option value="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '(' + escapeHtml(sig) + ') -> ' + escapeHtml(f.returnType) + '</option>';
        }).join('')
      : '<option value="">(nenhuma função)</option>';
  };

  window.loadPplLangPanel = async function() {
    if (!authToken) return;
    try {
      const res = await fetch('/api/papaleguas/lang-status', {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      const data = await res.json();
      if (!data || !data.success) return;
      pplActiveModulesCache = data.activeModules || [];

      const tunerBadge = document.getElementById('ppl-tuner-badge');
      if (tunerBadge && data.autoTuner) {
        const ct = data.autoTuner.cacheTuner;
        const cacheInfo = ct ? (' • LRU Gerenciados: ' + ct.cachesCount + ' (' + ct.entriesAfter + ' itens' + (ct.shedLoad ? ', Shedding ativo' : '') + ')') : '';
        tunerBadge.textContent = 'AutoTuner ativo: Limiar Bloqueio ' + data.autoTuner.adaptiveThreshold + ' | Cache Recomendado ' + data.autoTuner.recommendedCacheLimit + cacheInfo;
      }

      const histEl = document.getElementById('ppl-agent-history');
      if (histEl) {
        const hist = (data.agent && Array.isArray(data.agent.history)) ? data.agent.history : [];
        histEl.innerHTML = hist.length
          ? hist.map(function(h) {
              const dt = h.at ? h.at.slice(11, 19) : '--:--:--';
              const ops = Number(h.benchmarkOpsPerSec || 0).toLocaleString('pt-BR');
              return '<div style="padding:6px 10px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);font-size:11.5px;">' +
                '<div style="color:#94a3b8;">' + escapeHtml(dt) + ' • <strong>' + escapeHtml(h.profile || '') + '</strong></div>' +
                '<div style="color:#34d399;">RAM ' + (h.memoryPressurePct || 0) + '% • ' + ops + ' ops/s</div>' +
                '</div>';
            }).join('')
          : '<span style="font-size:12px;color:#94a3b8;">Sem histórico ainda — execute um ciclo do agente.</span>';
      }

      const editorSel = document.getElementById('ppl-editor-module');
      if (editorSel && editorSel.value) window.syncPplRunnerFunctions(editorSel.value);

      const hwEl = document.getElementById('ppl-hw-summary');
      if (hwEl && data.hardware) {
        const hw = data.hardware;
        const sh = data.shieldStats || { pplScored: 0, pplBlocked: 0 };
        const uf = data.urlFilterStats || { checked: 0, blockedTracker: 0, blockedUnsafe: 0 };
        const prof = (data.agent && data.agent.adaptiveProfile && data.agent.adaptiveProfile.name) || 'auto';
        const httpdOnline = data.nativeHttpd && data.nativeHttpd.online;
        const httpdInfo = httpdOnline
          ? ('🟢 Online (' + (data.nativeHttpd.latencyMs || 0) + ' ms • in-process)')
          : '⚪ Standby';
        hwEl.innerHTML =
          '<div style="padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;">CPU Hardware</div><div style="font-size:16px;font-weight:700;color:#38bdf8;">' + hw.cpuCores + ' núcleos</div></div>' +
          '<div style="padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;">RAM Livre / Total</div><div style="font-size:16px;font-weight:700;color:#34d399;">' + hw.ramFreeMb + ' / ' + hw.ramTotalMb + ' MB</div></div>' +
          '<div style="padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;">Pressão Memória</div><div style="font-size:16px;font-weight:700;color:#fbbf24;">' + hw.memoryPressurePct + '% (' + escapeHtml(prof) + ')</div></div>' +
          '<div style="padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;">Escudo .ppl (Req/Bloq)</div><div style="font-size:16px;font-weight:700;color:#c084fc;">' + sh.pplScored + ' / ' + sh.pplBlocked + '</div></div>' +
          '<div style="padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;">Filtro Proxy .ppl (Chk/Bloq)</div><div style="font-size:16px;font-weight:700;color:#f472b6;">' + uf.checked + ' / ' + (uf.blockedTracker + uf.blockedUnsafe) + '</div></div>' +
          '<div style="padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;">Motor PPL Nativo (:8080)</div><div style="font-size:16px;font-weight:700;color:' + (httpdOnline ? '#34d399' : '#94a3b8') + ';">' + httpdInfo + '</div></div>';
      }

      const tbody = document.getElementById('ppl-modules-table-body');
      if (tbody) {
        const mods = data.activeModules || [];
        const agentResults = (data.agent && data.agent.results) || [];
        if (!mods.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:18px;color:#94a3b8;">Nenhum módulo .ppl ativo.</td></tr>';
        } else {
          tbody.innerHTML = mods.map(function(m) {
            const ag = agentResults.find(function(r) { return r.module === m.name; }) || {};
            const modeBadge = m.napiPath ? '⚡ N-API In-Process' : '🖥️ CLI Nativo';
            const policyStr = JSON.stringify(m.policy || {});
            const st = ag.status || 'active';
            return '<tr>' +
              '<td><strong>' + escapeHtml(m.name) + '.ppl</strong></td>' +
              '<td>' + modeBadge + '</td>' +
              '<td style="font-family:monospace;font-size:11px;color:#94a3b8;">' + escapeHtml(policyStr) + '</td>' +
              '<td>' + (m.compileMs || 0) + ' ms</td>' +
              '<td style="color:#34d399;font-weight:600;">✅ ' + escapeHtml(st) + '</td>' +
              '</tr>';
          }).join('');
        }
      }
    } catch (e) {}
  };

  window.runPplAgentNow = async function() {
    if (!authToken) return;
    try {
      const res = await fetch('/api/papaleguas/lang-agent-run', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      const data = await res.json();
      if (data && data.success) {
        showToast('⚡ Ciclo do Agente Papaléguas concluído!');
        window.loadPplLangPanel();
      }
    } catch (e) {
      showToast('❌ Erro ao executar ciclo do Agente Papaléguas.');
    }
  };

  window.runPplBenchmarkNow = async function() {
    if (!authToken) return;
    try {
      const res = await fetch('/api/papaleguas/lang-benchmark', {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      const data = await res.json();
      const out = document.getElementById('ppl-benchmark-out');
      if (data && data.success && out) {
        out.style.display = 'block';
        out.textContent = '⚡ Benchmark Nativo (.ppl.node): ' + data.iterations + ' chamadas em ' + data.elapsedMs + ' ms (' + data.opsPerSec.toLocaleString('pt-BR') + ' ops/s) • Tracker bloqueado: ' + (data.trackerBlocked ? 'SIM' : 'NÃO');
      }
    } catch (e) {}
  };

  window.loadPplEditorSource = async function(modName) {
    if (!authToken) return;
    try {
      const q = modName ? ('?module=' + encodeURIComponent(modName)) : '';
      const res = await fetch('/api/papaleguas/lang-source' + q, {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      const data = await res.json();
      if (!data || !data.success) return;
      const sel = document.getElementById('ppl-editor-module');
      const ta = document.getElementById('ppl-editor-source');
      if (sel && Array.isArray(data.modules)) {
        sel.innerHTML = data.modules.map(function(m) {
          return '<option value="' + escapeHtml(m) + '"' + (m === data.module ? ' selected' : '') + '>' + escapeHtml(m) + '.ppl</option>';
        }).join('');
      }
      if (ta) ta.value = data.source || '';
      window.syncPplRunnerFunctions(data.module || (sel && sel.value) || '');
    } catch (e) {}
  };

  window.createNewPplModule = function() {
    const raw = window.prompt('Nome do novo módulo .ppl (apenas letras, números e _):', 'meu_modulo');
    if (!raw) return;
    const modName = raw.trim().replace(/\.ppl$/i, '');
    if (!/^[a-zA-Z0-9_]+$/.test(modName)) {
      showPplEditorMsg(false, '❌ Nome inválido. Use apenas letras, números e underscore (_).');
      return;
    }
    const sel = document.getElementById('ppl-editor-module');
    const ta = document.getElementById('ppl-editor-source');
    if (sel) {
      const opt = document.createElement('option');
      opt.value = modName;
      opt.textContent = modName + '.ppl';
      sel.appendChild(opt);
      sel.value = modName;
    }
    if (ta) {
      ta.value = '@policy(max_loops=100, no_network=true, zero_traces=true)\n\nexport fn calcular(x: u64) -> u64 {\n  return x * 2 + 1;\n}\n';
    }
    showPplEditorMsg(true, '📝 Novo rascunho "' + modName + '.ppl" pronto. Clique em Verificar ou Compilar & Promover.');
  };

  window.runPplFunctionNow = async function() {
    if (!authToken) return;
    const sel = document.getElementById('ppl-editor-module');
    const fnSel = document.getElementById('ppl-runner-fn');
    const argsEl = document.getElementById('ppl-runner-args');
    const out = document.getElementById('ppl-runner-out');
    if (!sel || !fnSel || !sel.value || !fnSel.value) return;
    let parsedArgs = [];
    const rawArgs = (argsEl && argsEl.value.trim()) || '[]';
    try {
      parsedArgs = JSON.parse(rawArgs);
      if (!Array.isArray(parsedArgs)) parsedArgs = [parsedArgs];
    } catch (e) {
      if (out) { out.style.display = 'block'; out.textContent = '❌ Args JSON inválido (ex: [100, 2, false, true])'; }
      return;
    }
    try {
      const res = await fetch('/api/papaleguas/lang-invoke', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: sel.value, fn: fnSel.value, args: parsedArgs })
      });
      const data = await res.json();
      if (out) {
        out.style.display = 'block';
        out.textContent = data && data.success
          ? ('⚡ ' + data.module + '.' + data.fn + ' => ' + JSON.stringify(data.result) + ' (' + data.elapsedUs + ' µs)')
          : ('❌ ' + ((data && data.error) || 'erro'));
      }
    } catch (e) {
      if (out) { out.style.display = 'block'; out.textContent = '❌ Falha de comunicação ao invocar função.'; }
    }
  };

  function showPplEditorMsg(ok, text) {
    const out = document.getElementById('ppl-editor-output');
    if (!out) return;
    out.style.display = 'block';
    out.style.background = ok ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.14)';
    out.style.border = ok ? '1px solid rgba(16,185,129,0.35)' : '1px solid rgba(239,68,68,0.4)';
    out.style.color = ok ? '#a7f3d0' : '#fca5a5';
    out.textContent = text;
  }

  window.verifyPplSourceNow = async function() {
    if (!authToken) return;
    const ta = document.getElementById('ppl-editor-source');
    if (!ta) return;
    try {
      const res = await fetch('/api/papaleguas/lang-verify', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: ta.value })
      });
      const data = await res.json();
      if (data && data.success) {
        showPplEditorMsg(true, '✅ Verificação estática aprovada! Funções: ' + data.functionsCount + ' | Structs: ' + data.structsCount + ' | Política: ' + JSON.stringify(data.policy || {}));
      } else {
        showPplEditorMsg(false, '❌ ' + ((data && data.error) || 'Falha na verificação'));
      }
    } catch (e) {
      showPplEditorMsg(false, '❌ Erro de comunicação ao verificar .ppl.');
    }
  };

  window.compilePplSourceNow = async function() {
    if (!authToken) return;
    const sel = document.getElementById('ppl-editor-module');
    const ta = document.getElementById('ppl-editor-source');
    if (!sel || !ta || !sel.value) return;
    try {
      const res = await fetch('/api/papaleguas/lang-compile', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: sel.value, source: ta.value })
      });
      const data = await res.json();
      if (data && data.success) {
        const r = data.result || {};
        showPplEditorMsg(true, '⚡ Compilado & promovido para hardware (.ppl.node) em ' + (r.compileMs || 0) + ' ms! Status: ' + (r.status || 'ok'));
        window.loadPplLangPanel();
      } else {
        showPplEditorMsg(false, '❌ Rejeitado com rollback automático: ' + ((data && (data.error || (data.result && data.result.error))) || 'erro desconhecido'));
      }
    } catch (e) {
      showPplEditorMsg(false, '❌ Erro de comunicação ao compilar .ppl.');
    }
  };

  // =========================================================================
  // FEEDBACKS DO AGENTE PAPALÉGUAS IA (HUMANOS & ROBÔS)
  // =========================================================================
  let agentFeedbacksCache = [];
  let agentFeedbackFilter = 'all';

  function renderAgentFeedbacksTable() {
    const tbody = document.getElementById('agent-feedbacks-table-body');
    if (!tbody) return;
    const list = agentFeedbacksCache.filter(function(item) {
      if (!item) return false;
      if (agentFeedbackFilter === 'bot') return item.senderType === 'bot';
      if (agentFeedbackFilter === 'human') return item.senderType !== 'bot';
      return true;
    });
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:18px;">Nenhum feedback registrado nesta categoria ainda.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function(fb) {
      const isBot = fb.senderType === 'bot';
      const badge = isBot
        ? '<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;background:rgba(168,85,247,0.2);color:#e9d5ff;border:1px solid rgba(168,85,247,0.5);">🤖 Robô</span>'
        : '<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;background:rgba(56,189,248,0.18);color:#bae6fd;border:1px solid rgba(56,189,248,0.45);">👤 Humano</span>';
      let when = fb.at || '';
      try { when = fb.at ? new Date(fb.at).toLocaleString('pt-BR') : '--'; } catch (e) {}
      return '<tr>' +
        '<td>' + badge + '</td>' +
        '<td style="font-weight:600;color:#e2e8f0;">' + escapeHtml(fb.senderName || (isBot ? 'Robô' : 'Visitante')) + '</td>' +
        '<td style="font-size:12px;color:#94a3b8;white-space:nowrap;">' + escapeHtml(when) + '</td>' +
        '<td style="color:#f8fafc;line-height:1.45;white-space:pre-line;max-width:340px;">' + escapeHtml(fb.message || '') + '</td>' +
        '<td style="color:#cbd5e1;font-size:12.5px;line-height:1.45;white-space:pre-line;max-width:340px;">' + escapeHtml(fb.reply || '') + '</td>' +
      '</tr>';
    }).join('');
  }

  window.setAgentFeedbackFilter = function(mode) {
    agentFeedbackFilter = mode || 'all';
    ['all', 'human', 'bot'].forEach(function(k) {
      const btn = document.getElementById('fb-filter-' + k);
      if (btn) btn.classList.toggle('active', k === agentFeedbackFilter);
    });
    renderAgentFeedbacksTable();
  };

  window.loadAgentFeedbacks = async function() {
    try {
      const res = await fetch('/api/site-agent/feedbacks', { cache: 'no-store' });
      const data = await res.json();
      if (!data || !data.ok) return;
      agentFeedbacksCache = Array.isArray(data.feedbacks) ? data.feedbacks : [];
      const elTotal = document.getElementById('fb-count-total');
      const elHuman = document.getElementById('fb-count-human');
      const elBot = document.getElementById('fb-count-bot');
      if (elTotal) elTotal.textContent = String(data.total || agentFeedbacksCache.length);
      if (elHuman) elHuman.textContent = String(typeof data.humanCount === 'number' ? data.humanCount : agentFeedbacksCache.filter(function(f){ return f && f.senderType !== 'bot'; }).length);
      if (elBot) elBot.textContent = String(typeof data.botCount === 'number' ? data.botCount : agentFeedbacksCache.filter(function(f){ return f && f.senderType === 'bot'; }).length);
      renderAgentFeedbacksTable();
    } catch (e) {}
  };

  window.clearAgentFeedbacks = async function() {
    if (!window.confirm('Deseja limpar todos os feedbacks do Agente Papaléguas?')) return;
    try {
      await fetch('/api/site-agent/feedbacks/clear', {
        method: 'POST',
        headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {}
      });
      await window.loadAgentFeedbacks();
    } catch (e) {}
  };

  // =========================================================================
  // DOWNLOADS DA APLICAÇÃO POR SISTEMA (BANCO DE DADOS SQLITE)
  // =========================================================================
  let appDownloadsRecentCache = [];
  let appDownloadsOsFilter = 'all';

  function formatOsBadge(osId) {
    const map = {
      windows: { label: '🪟 Windows', bg: 'rgba(56,189,248,0.18)', color: '#7dd3fc', bd: 'rgba(56,189,248,0.45)' },
      android: { label: '🤖 Android', bg: 'rgba(34,197,94,0.18)', color: '#86efac', bd: 'rgba(34,197,94,0.45)' },
      ios: { label: '🍎 iOS', bg: 'rgba(226,232,240,0.14)', color: '#f1f5f9', bd: 'rgba(226,232,240,0.35)' },
      linux: { label: '🐧 Linux', bg: 'rgba(245,158,11,0.18)', color: '#fde68a', bd: 'rgba(245,158,11,0.45)' },
      macos: { label: '🍏 macOS', bg: 'rgba(168,85,247,0.2)', color: '#e9d5ff', bd: 'rgba(168,85,247,0.5)' }
    };
    const info = map[osId] || { label: '💻 Outro', bg: 'rgba(148,163,184,0.16)', color: '#cbd5e1', bd: 'rgba(148,163,184,0.35)' };
    return '<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;background:' + info.bg + ';color:' + info.color + ';border:1px solid ' + info.bd + ';">' + info.label + '</span>';
  }

  function renderAppDownloadsTable() {
    const tbody = document.getElementById('app-downloads-table-body');
    if (!tbody) return;
    const list = appDownloadsRecentCache.filter(function(item) {
      if (!item) return false;
      if (appDownloadsOsFilter === 'all') return true;
      if (appDownloadsOsFilter === 'macos') return item.os === 'macos' || item.os === 'other';
      return item.os === appDownloadsOsFilter;
    });
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:16px;">Nenhum download registrado para este sistema ainda.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function(dl) {
      let when = dl.created_at || '';
      try { when = dl.created_at ? new Date(dl.created_at).toLocaleString('pt-BR') : '--'; } catch (e) {}
      const srcLabel = dl.source === 'download_app' ? 'Download Instalador' : (dl.source === 'pwa_install' ? 'Instalação PWA' : String(dl.source || 'App'));
      return '<tr>' +
        '<td>' + formatOsBadge(dl.os) + '</td>' +
        '<td style="font-weight:600;color:#e2e8f0;font-size:12px;">' + escapeHtml(srcLabel) + '</td>' +
        '<td style="font-family:monospace;font-size:12px;color:#7dd3fc;">' + escapeHtml(dl.ip || '--') + '</td>' +
        '<td style="font-size:12px;color:#94a3b8;white-space:nowrap;">' + escapeHtml(when) + '</td>' +
        '<td style="font-size:11.5px;color:#94a3b8;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(dl.user_agent || '') + '">' + escapeHtml(dl.user_agent || '--') + '</td>' +
      '</tr>';
    }).join('');
  }

  window.setAppDownloadOsFilter = function(osId) {
    appDownloadsOsFilter = osId || 'all';
    ['all', 'windows', 'android', 'ios', 'linux', 'macos'].forEach(function(k) {
      const btn = document.getElementById('dl-filter-' + k);
      if (btn) btn.classList.toggle('active', k === appDownloadsOsFilter);
    });
    renderAppDownloadsTable();
  };

  window.loadAppDownloadsStats = async function() {
    try {
      const headers = authToken ? { 'Authorization': 'Bearer ' + authToken } : {};
      const res = await fetch('/api/papaleguas/app-downloads-stats', { cache: 'no-store', headers });
      const data = await res.json();
      if (!data || !data.success) return;
      const byOs = data.byOs || {};
      const total = Number(data.total || 0);
      const last24h = Number(data.last24h || 0);
      const win = Number(byOs.windows || 0);
      const andr = Number(byOs.android || 0);
      const ios = Number(byOs.ios || 0);
      const lin = Number(byOs.linux || 0);
      const mac = Number(byOs.macos || 0) + Number(byOs.other || 0);

      const setTxt = function(id, val) { const el = document.getElementById(id); if (el) el.textContent = String(val); };
      setTxt('dl-count-total', total);
      setTxt('dl-count-windows', win);
      setTxt('dl-count-android', andr);
      setTxt('dl-count-ios', ios);
      setTxt('dl-count-linux', lin);
      setTxt('dl-count-macos', mac);
      setTxt('dl-kpi-total', total);
      setTxt('dl-kpi-24h', last24h + ' nas últimas 24h');
      setTxt('dl-kpi-windows', win);
      setTxt('dl-kpi-android', andr);
      setTxt('dl-kpi-ios', ios);
      setTxt('dl-kpi-linux', lin);
      setTxt('dl-kpi-macos', mac);
      if (data.dbEngine) setTxt('dl-db-badge', data.dbEngine);

      appDownloadsRecentCache = Array.isArray(data.recent) ? data.recent : [];
      renderAppDownloadsTable();
    } catch (e) {}
  };

  window.clearAppDownloadsStats = async function() {
    if (!window.confirm('Deseja zerar todos os registros de downloads da aplicação no banco SQLite?')) return;
    try {
      const headers = authToken ? { 'Authorization': 'Bearer ' + authToken } : {};
      await fetch('/api/papaleguas/app-downloads-clear', { method: 'POST', headers });
      await window.loadAppDownloadsStats();
      if (typeof showToast === 'function') showToast('🗑️ Registros de downloads zerados no banco SQLite.', 'info');
    } catch (e) {}
  };

  setTimeout(function() {
    window.loadAppDownloadsStats();
    window.loadAgentFeedbacks();
    if (authToken) { window.loadPplLangPanel(); window.loadPplEditorSource(); }
  }, 900);
  setInterval(function() {
    window.loadAppDownloadsStats();
    window.loadAgentFeedbacks();
    if (authToken) window.loadPplLangPanel();
  }, 15000);

  init();
})();
