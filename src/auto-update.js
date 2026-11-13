// Papaléguas PWA Auto-Updater (Blindado Anti-Loop para Celular & Desktop)
// Detecta novas versões reais no servidor sem recarregar em loop a mesma versão
(function () {
  'use strict';

  // 1. SE ESTIVER DENTRO DE UM IFRAME: NUNCA EXECUTAR.
  try {
    if (window.parent && window.parent !== window) return;
    if (window.top && window.top !== window) return;
  } catch (e) {
    return;
  }

  if (!('serviceWorker' in navigator)) return;

  var refreshing = false;

  // Banner visual sutil para notificar atualização real no celular
  function showUpdateToast(msg) {
    try {
      var id = 'pl-update-toast-banner';
      var el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);'
          + 'background:rgba(10,15,26,0.96);color:#00f0ff;border:1px solid rgba(0,240,255,0.7);'
          + 'border-radius:30px;padding:9px 20px;font-size:13px;font-weight:700;'
          + 'box-shadow:0 10px 30px rgba(0,0,0,0.85),0 0 18px rgba(0,240,255,0.45);'
          + 'z-index:9999999;display:flex;align-items:center;gap:8px;'
          + 'font-family:Outfit,system-ui,sans-serif;pointer-events:none;transition:all 0.3s ease;';
        if (document.body) {
          document.body.appendChild(el);
        } else {
          document.addEventListener('DOMContentLoaded', function () {
            if (!document.getElementById(id)) document.body.appendChild(el);
          });
        }
      }
      el.innerHTML = '<span style="font-size:15px">⚡</span> ' + msg;
      setTimeout(function () {
        try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
      }, 4000);
    } catch (e) {}
  }

  // 2. CONTROLLERCHANGE:
  // Só deve recarregar a página se uma NOVA versão foi explicitamente instalada e aguarda ativação.
  // NUNCA recarrega no carregamento inicial normal da página!
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (refreshing) return;

    // Trava de segurança: só recarrega se o update foi sinalizado como necessário
    var isUpdatePending = sessionStorage.getItem('pl_pwa_update_pending');
    if (!isUpdatePending) {
      return; // Apenas o Service Worker assumindo controle normal na abertura do app
    }

    sessionStorage.removeItem('pl_pwa_update_pending');
    var lastReload = parseInt(sessionStorage.getItem('pl_pwa_reload_ts') || '0', 10);
    if (Date.now() - lastReload < 25000) return;

    sessionStorage.setItem('pl_pwa_reload_ts', String(Date.now()));
    refreshing = true;
    showUpdateToast('Nova versão aplicada com sucesso!');
    setTimeout(function () {
      window.location.reload();
    }, 500);
  });

  // Limpa caches antigos do PWA
  function clearObsoleteCaches() {
    if (window.caches && typeof window.caches.keys === 'function') {
      window.caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return window.caches.delete(k);
        }));
      }).catch(function () {});
    }
  }

  // Obtém a versão que a página atual está rodando
  function getRunningVersion() {
    var metaEl = document.querySelector('meta[name="papaleguas-version"]');
    if (metaEl && metaEl.getAttribute('content')) {
      return String(metaEl.getAttribute('content')).trim();
    }
    return localStorage.getItem('pl_app_version') || null;
  }

  // Checa a versão do servidor e atualiza APENAS se houver uma versão REALMENTE diferente
  function checkServerVersion() {
    if (refreshing) return;

    fetch('/api/session-info?_pl_upd=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.serverVersion) return;
        var serverVer = String(data.serverVersion).trim();
        var runningVer = getRunningVersion();
        var storedVer = localStorage.getItem('pl_app_version');

        // Atualiza o badge do modal de instalação se estiver na tela
        var modalVerEl = document.getElementById('install-modal-app-version');
        if (modalVerEl) {
          modalVerEl.textContent = 'Versão ' + serverVer + ' (Atualizada)';
        }

        // REGRA DE OURO 1: Se a versão em execução já é igual à do servidor, NUNCA ATUALIZA!
        if (runningVer === serverVer || storedVer === serverVer) {
          localStorage.setItem('pl_app_version', serverVer);
          return;
        }

        // REGRA DE OURO 2: Trava anti-loop permanente por versão
        var lastAttemptedVer = localStorage.getItem('pl_last_attempted_ver');
        var lastAttemptTime = parseInt(localStorage.getItem('pl_last_attempt_ts') || '0', 10);
        
        // Se já tentamos atualizar para ESTA mesma versão nos últimos 60 segundos, NÃO tenta de novo
        if (lastAttemptedVer === serverVer && (Date.now() - lastAttemptTime < 60000)) {
          console.log('[PWA AutoUpdate] Versão ' + serverVer + ' já verificada recentemente. Sem loop.');
          localStorage.setItem('pl_app_version', serverVer);
          return;
        }

        // Registra a tentativa para impedir repetição
        localStorage.setItem('pl_last_attempted_ver', serverVer);
        localStorage.setItem('pl_last_attempt_ts', String(Date.now()));
        localStorage.setItem('pl_app_version', serverVer);
        sessionStorage.setItem('pl_pwa_update_pending', 'true');
        refreshing = true;

        console.log('[PWA AutoUpdate] Atualizando para nova versão:', serverVer, '(anterior:', runningVer || 'desconhecida', ')');
        showUpdateToast('Atualizando para versão ' + serverVer + '...');

        clearObsoleteCaches();

        navigator.serviceWorker.getRegistration().then(function (reg) {
          if (reg) {
            reg.update().then(function () {
              if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
              if (reg.installing) reg.installing.postMessage({ type: 'SKIP_WAITING' });
            }).catch(function () {});
          }
          setTimeout(function () {
            window.location.reload();
          }, 700);
        }).catch(function () {
          setTimeout(function () { window.location.reload(); }, 700);
        });
      })
      .catch(function () {});
  }

  function setupAutoUpdate(registration) {
    if (!registration) return;

    // Monitora novas versões em segundo plano
    registration.addEventListener('updatefound', function () {
      var newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', function () {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          sessionStorage.setItem('pl_pwa_update_pending', 'true');
          newWorker.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });

    if (registration.waiting) {
      sessionStorage.setItem('pl_pwa_update_pending', 'true');
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }

    // Checagem segura ao abrir o app
    checkServerVersion();

    // Ao voltar ao app após desbloquear tela (sem reload forçado, apenas checagem silenciosa)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        var lastCheck = parseInt(sessionStorage.getItem('pl_last_focus_check') || '0', 10);
        if (Date.now() - lastCheck > 60000) {
          sessionStorage.setItem('pl_last_focus_check', String(Date.now()));
          checkServerVersion();
        }
      }
    });

    // Checagem periódica a cada 10 minutos (espaçado para economizar bateria no celular)
    setInterval(function () {
      checkServerVersion();
    }, 10 * 60 * 1000);
  }

  // Registra o Service Worker
  navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none'
  })
    .then(function (reg) {
      setupAutoUpdate(reg);
    })
    .catch(function (err) {
      console.warn('[PWA AutoUpdate] Falha no registro do Service Worker:', err);
    });

  function triggerManualUpdate() {
    showUpdateToast('Verificando e atualizando app...');
    try { clearObsoleteCaches(); } catch (e) {}
    try {
      localStorage.removeItem('pl_last_attempted_ver');
      localStorage.removeItem('pl_last_attempt_ts');
      localStorage.removeItem('pl_app_version');
      sessionStorage.setItem('pl_pwa_update_pending', 'true');
    } catch (e) {}
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg) {
          reg.update().then(function () {
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            if (reg.installing) reg.installing.postMessage({ type: 'SKIP_WAITING' });
          }).catch(function () {});
        }
        setTimeout(function () {
          window.location.reload();
        }, 600);
      }).catch(function () {
        setTimeout(function () { window.location.reload(); }, 600);
      });
    } else {
      setTimeout(function () { window.location.reload(); }, 600);
    }
  }

  window.papaleguasCheckUpdate = checkServerVersion;
  window.papaleguasForceUpdate = triggerManualUpdate;

  // Gatilho inicial
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkServerVersion);
  } else {
    setTimeout(checkServerVersion, 300);
  }
})();
