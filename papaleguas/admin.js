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
  const elIntervalSelect = document.getElementById('refresh-interval-select');
  const elCountdownBox = document.getElementById('refresh-countdown-box');
  const elCountdownText = document.getElementById('refresh-countdown-text');
  const elBtnManualRefresh = document.getElementById('btn-manual-refresh');
  const elServerLogsSelect = document.getElementById('server-logs-select');
  const elNgrokContainer = document.getElementById('ngrok-tunnel-container');
  const elNgrokLink = document.getElementById('ngrok-tunnel-link');
  const elNgrokUrlText = document.getElementById('ngrok-tunnel-url-text');
  let currentNgrokUrl = '';


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


  if (elNgrokLink) {
    elNgrokLink.addEventListener('click', (event) => {
      event.preventDefault();
      const url = elNgrokLink.getAttribute('href') || '';
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

  async function init() {
    setupMobileMenu();
    setupFilterListeners();
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
        if (typeof data.isTrackingEnabled === 'boolean') updateTrackingUi(data.isTrackingEnabled);
        if (typeof data.torEnabled === 'boolean') updateAdminTorUi(data.torEnabled, data.torConnected);
        if (typeof data.serverLogsPaused === 'boolean' && elServerLogsSelect) {
          elServerLogsSelect.value = data.serverLogsPaused ? 'paused' : 'enabled';
        }
        updateNgrokUi(data.ngrokTunnelUrl, data.ngrokTunnelConnecting, data.lanAccessUrl);
        if (!data.ngrokTunnelUrl) {
          setTimeout(() => loadMetrics(false), 2500);
          setTimeout(() => loadMetrics(false), 6500);
          setTimeout(() => loadMetrics(false), 12000);
        }
        loadMetrics();
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

      if (typeof data.isTrackingEnabled === 'boolean') {
        updateTrackingUi(data.isTrackingEnabled);
      }
      updateNgrokUi(data.ngrokTunnelUrl, data.ngrokTunnelConnecting, data.lanAccessUrl);
      if (!data.ngrokTunnelUrl) {
        setTimeout(() => loadMetrics(false), 4000);
      }

      renderOverview(data.overview);
      renderAcceptance(data.acceptance);
      renderEvolutionChart(data.evolutionChart);
      rawIpList = data.ipList || [];
      updateFilterCounts(rawIpList);
      applyIpFilterAndRender();
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
    const v4 = list.filter(item => (item.ipVersion || 'IPv4') === 'IPv4').length;
    const v6 = list.filter(item => item.ipVersion === 'IPv6').length;
    const ext = list.filter(item => !item.isLocal).length;
    const loc = list.filter(item => item.isLocal).length;

    const elCountAll = document.getElementById('count-all');
    const elCountOnline = document.getElementById('count-online');
    const elCountV4 = document.getElementById('count-ipv4');
    const elCountV6 = document.getElementById('count-ipv6');
    const elCountExt = document.getElementById('count-external');
    const elCountLoc = document.getElementById('count-local');

    if (elCountAll) elCountAll.textContent = total;
    if (elCountOnline) elCountOnline.textContent = online;
    if (elCountV4) elCountV4.textContent = v4;
    if (elCountV6) elCountV6.textContent = v6;
    if (elCountExt) elCountExt.textContent = ext;
    if (elCountLoc) elCountLoc.textContent = loc;
  }

  function applyIpFilterAndRender() {
    if (!elIpTableBody) return;

    const q = (currentSearch || '').trim().toLowerCase();

    const filtered = rawIpList.filter(item => {
      const ver = item.ipVersion || 'IPv4';

      // 1. Filtro por Categoria de IP
      if (currentFilter === 'online' && !item.isOnline) return false;
      if (currentFilter === 'ipv4' && ver !== 'IPv4') return false;
      if (currentFilter === 'ipv6' && ver !== 'IPv6') return false;
      if (currentFilter === 'external' && item.isLocal) return false;
      if (currentFilter === 'local' && !item.isLocal) return false;

      // 2. Filtro de Busca Textual (IP, Cidade, Provedor, Aparelho ou URL)
      if (q) {
        const ipMatch = (item.ip || '').toLowerCase().includes(q);
        const cityMatch = (item.geo?.city || '').toLowerCase().includes(q);
        const countryMatch = (item.geo?.country || '').toLowerCase().includes(q);
        const ispMatch = (item.geo?.isp || '').toLowerCase().includes(q);
        const deviceMatch = (item.device || '').toLowerCase().includes(q);
        const subnetMatch = (item.localSubnet || '').toLowerCase().includes(q);
        const discMatch = Array.isArray(item.discoveredDevices) && item.discoveredDevices.some(d => (d || '').toLowerCase().includes(q));

        if (!ipMatch && !cityMatch && !countryMatch && !ispMatch && !deviceMatch && !subnetMatch && !discMatch) {
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

  function renderIpTable(ipList) {
    if (!elIpTableBody || !Array.isArray(ipList)) return;
    if (ipList.length === 0) {
      elIpTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:26px;color:#94a3b8;font-size:13px;">🔍 Nenhum registro encontrado para o filtro selecionado.</td></tr>`;
      return;
    }

    elIpTableBody.innerHTML = ipList.map(item => {
      const geo = item.geo || {};
      const flag = geo.flag || (item.isLocal ? '🏠' : '🌐');
      const cityStr = geo.city ? `${geo.city} - ${geo.country}` : (geo.country || (item.isLocal ? 'Rede Local' : 'Desconhecido'));
      const timeStr = item.lastSeen ? new Date(item.lastSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--';
      const dateStr = item.lastSeen ? new Date(item.lastSeen).toLocaleDateString('pt-BR') : '';
      const ipVer = item.ipVersion || 'IPv4';
      const isOnline = !!item.isOnline;

      return `
        <tr class="ip-row-card ${isOnline ? 'ip-row-connected-now' : ''}">
          <td class="td-ip" data-label="IP / Conexão">
            <div class="ip-cell-col">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span class="ip-badge ${isOnline ? 'ip-badge-online' : ''}">${item.ip}</span>
                ${isOnline 
                  ? `<span class="ip-online-indicator" title="Ativo nos últimos 5 minutos"><span class="pulse-green-dot"></span> Conectado</span>` 
                  : `<span class="ip-offline-indicator" title="Desconectado">⚪ Offline</span>`}
              </div>
              ${item.deviceLanIpv4 ? `<div style="font-size:10.5px;color:#38bdf8;margin-top:2px;">Aparelho: ${escapeHtml(item.deviceLanIpv4)}</div>` : ''}
              <div class="ip-tags-row">
                <span class="ip-ver-badge ${ipVer === 'IPv6' ? 'ip-ver-v6' : 'ip-ver-v4'}">${ipVer}</span>
                ${item.isLocal ? `<span class="ip-ver-badge ip-ver-local">🏠 Local</span>` : `<span class="ip-ver-badge ip-ver-ext">🌍 Externa</span>`}
              </div>
            </div>
          </td>
          <td class="td-geo" data-label="Localização">
            <div class="location-chip">
              <span style="font-size:16px;">${flag}</span>
              <span>${escapeHtml(cityStr)}</span>
            </div>
            <div style="font-size:10.5px;color:#64748b;margin-top:2px;">${escapeHtml(geo.isp || 'Provedor')}</div>
          </td>
          <td class="td-device" data-label="Dispositivo">
            <span class="device-chip">${escapeHtml(item.device || 'Navegador')}</span>
            ${item.screen ? `<div style="font-size:10px;color:#94a3b8;margin-top:3px;">🖥️ Tela: ${escapeHtml(item.screen)}</div>` : ''}
            ${item.localSubnet ? `<div style="font-size:10px;color:#38bdf8;margin-top:2px;">📡 Wi-Fi Local: ${escapeHtml(item.localSubnet)}</div>` : ''}
            ${item.discoveredDevices && item.discoveredDevices.length > 0 ? `
              <div style="margin-top:5px;display:flex;flex-direction:column;gap:3px;">
                <span style="font-size:9.5px;color:#34d399;font-weight:700;text-transform:uppercase;">Aparelhos no Wi-Fi:</span>
                ${item.discoveredDevices.map(d => `<span style="background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.35);color:#34d399;font-size:10px;padding:2px 6px;border-radius:6px;font-weight:600;display:inline-block;max-width:max-content;">📺 ${escapeHtml(d)}</span>`).join('')}
              </div>
            ` : (item.device && item.device.includes('Rede Externa') ? `<div style="font-size:9.5px;color:#64748b;margin-top:3px;">Aguardando varredura da rede do cliente...</div>` : '')}
          </td>
          <td class="td-visits" data-label="Quantidade de Acessos"><span class="visit-count-badge">${item.visitsCount}x</span></td>
          <td class="td-downloads" data-label="Downloads"><span style="font-weight:700;color:${item.conversions > 0 ? '#10b981' : '#64748b'}">${item.conversions}</span></td>
          <td class="td-time" data-label="Último Visto" style="font-size:11.5px;color:#94a3b8;white-space:nowrap;">
            ${dateStr} <span style="color:${isOnline ? '#10b981' : '#f8fafc'};font-weight:${isOnline ? '700' : '600'};">${timeStr}</span>
            ${isOnline ? `<div style="font-size:10px;color:#34d399;font-weight:700;margin-top:2px;">⚡ Ativo agora</div>` : ''}
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



  function updateNgrokUi(ngUrl, connecting, lanUrl) {
    const fallbackNgrok = 'https://papaleguas.ngrok.app';
    const effectiveUrl = ngUrl || fallbackNgrok;
    const dashNgrokLink = document.getElementById('dash-ngrok-link');
    const dashNgrokBtnOpen = document.getElementById('dash-ngrok-btn-open');

    if (effectiveUrl && typeof effectiveUrl === 'string' && effectiveUrl.startsWith('http')) {
      currentNgrokUrl = effectiveUrl;
      if (elNgrokContainer) {
        elNgrokContainer.classList.remove('ngrok-connecting');
        elNgrokContainer.style.display = 'inline-flex';
      }
      if (elNgrokLink) {
        elNgrokLink.href = effectiveUrl;
        elNgrokLink.title = 'Link fixo permanente do ngrok: ' + effectiveUrl;
      }
      if (elNgrokUrlText) elNgrokUrlText.textContent = effectiveUrl.replace(/^https?:\/\//, '');

      if (dashNgrokLink) {
        dashNgrokLink.href = effectiveUrl;
        dashNgrokLink.textContent = effectiveUrl;
      }
      if (dashNgrokBtnOpen) {
        dashNgrokBtnOpen.href = effectiveUrl;
      }
    } else if (connecting) {
      currentNgrokUrl = '';
      if (elNgrokContainer) {
        elNgrokContainer.classList.add('ngrok-connecting');
        elNgrokContainer.style.display = 'inline-flex';
      }
      if (elNgrokLink) {
        elNgrokLink.href = '#';
        elNgrokLink.title = 'Conectando túnel ngrok...';
      }
      if (elNgrokUrlText) elNgrokUrlText.textContent = 'Conectando ngrok...';
      if (dashNgrokLink) dashNgrokLink.textContent = 'Conectando ngrok...';
    } else {
      if (elNgrokContainer) {
        elNgrokContainer.classList.remove('ngrok-connecting');
        elNgrokContainer.style.display = 'none';
      }
      if (dashNgrokLink) dashNgrokLink.textContent = 'ngrok Offline';
    }
  }

  window.copyNgrokUrl = async function(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    const fullUrl = currentNgrokUrl || 'https://papaleguas.ngrok.app';
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
      showToast('📋 Link permanente do ngrok copiado: ' + fullUrl, 3500);
    } catch (err) {
      showToast('⚠️ Falha ao copiar link.', 3000);
    }
  };

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

  init();
})();
