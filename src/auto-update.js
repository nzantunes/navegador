// Papaléguas PWA Auto-Updater
// Detecta novas versões no servidor e atualiza o app imediatamente ao abrir no celular
(function () {
  'use strict';

  // 1. SE ESTIVER DENTRO DE UM IFRAME (como abas internas): NUNCA EXECUTAR.
  // Somente a janela principal (top-level / PWA shell) gerencia Service Worker e atualizações.
  try {
    if (window.parent && window.parent !== window) return;
    if (window.top && window.top !== window) return;
  } catch (e) {
    return;
  }

  if (!('serviceWorker' in navigator)) return;

  var refreshing = false;

  // Banner visual elegante e sutil para notificar atualização no celular
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
    } catch (e) {}
  }

  // 2. CONTROLLERCHANGE:
  // Dispara quando um novo Service Worker assume o controle da página
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (refreshing) return;
    var lastReload = parseInt(sessionStorage.getItem('pl_pwa_reload_ts') || '0', 10);
    if (Date.now() - lastReload < 15000) return;

    sessionStorage.setItem('pl_pwa_reload_ts', String(Date.now()));
    refreshing = true;
    showUpdateToast('Nova versão pronta! Atualizando...');
    setTimeout(function () {
      window.location.reload();
    }, 450);
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

  // Checa a versão do servidor e atualiza imediatamente no celular
  function checkServerVersion(isManual) {
    fetch('/api/session-info?_pl_upd=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.serverVersion) {
          var serverVer = data.serverVersion;
          var stored = localStorage.getItem('pl_app_version');
          var metaEl = document.querySelector('meta[name="papaleguas-version"]');
          var runningVer = metaEl ? metaEl.getAttribute('content') : null;

          // Atualiza também o badge do modal de instalação se estiver presente na tela
          var modalVerEl = document.getElementById('install-modal-app-version');
          if (modalVerEl) {
            modalVerEl.textContent = 'Versão ' + serverVer + ' (Atualizada)';
          }

          // Se a versão atual na página é antiga (ou ausente) ou o localStorage é diferente:
          var isOutdated = (runningVer && runningVer !== serverVer) || (!runningVer && stored !== serverVer) || (stored && stored !== serverVer);

          if (!stored && runningVer === serverVer) {
            // Primeiro acesso limpo e já está na versão certa
            localStorage.setItem('pl_app_version', serverVer);
            return;
          }

          if (isOutdated) {
            var lastReload = parseInt(sessionStorage.getItem('pl_pwa_reload_ts') || '0', 10);
            if (Date.now() - lastReload < 10000) return; // Cooldown contra loop

            console.log('[PWA AutoUpdate] Nova versão disponível:', serverVer, '(atual:', runningVer || stored || 'antiga', ')');
            showUpdateToast('Baixando atualizações da nova versão...');
            localStorage.setItem('pl_app_version', serverVer);
            sessionStorage.setItem('pl_pwa_reload_ts', String(Date.now()));

            // Invalida caches do Service Worker
            clearObsoleteCaches();

            navigator.serviceWorker.getRegistration().then(function (reg) {
              if (reg) {
                reg.update().then(function () {
                  if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                  if (reg.installing) reg.installing.postMessage({ type: 'SKIP_WAITING' });
                }).catch(function () {});
              }
              setTimeout(function () {
                showUpdateToast('Versão ' + serverVer + ' instalada! Recarregando...');
                setTimeout(function () {
                  window.location.reload();
                }, 400);
              }, 600);
            }).catch(function () {
              setTimeout(function () { window.location.reload(); }, 900);
            });
          }
        }
      })
      .catch(function () {});
  }

  function setupAutoUpdate(registration) {
    if (!registration) return;

    // Monitora novas instalações encontradas em segundo plano
    registration.addEventListener('updatefound', function () {
      var newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', function () {
        if (newWorker.state === 'installed') {
          showUpdateToast('Instalando atualização mais recente...');
          newWorker.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });

    // Se já houver um worker esperando, ativa imediatamente
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }

    // 1. Imediatamente ao abrir o aplicativo: checa e atualiza
    checkServerVersion(true);

    // 2. Ao voltar para o aplicativo no celular (resumo de tela / desbloqueio)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        try { registration.update(); } catch (e) {}
        checkServerVersion(false);
      }
    });

    window.addEventListener('focus', function () {
      try { registration.update(); } catch (e) {}
      checkServerVersion(false);
    });

    // 3. Ao reconectar a internet no celular
    window.addEventListener('online', function () {
      try { registration.update(); } catch (e) {}
      checkServerVersion(false);
    });

    // 4. Checagem periódica a cada 5 minutos
    setInterval(function () {
      try { registration.update(); } catch (e) {}
      checkServerVersion(false);
    }, 5 * 60 * 1000);
  }

  // Registra o Service Worker sempre checando o servidor diretamente (updateViaCache: 'none')
  navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none'
  })
    .then(function (reg) {
      setupAutoUpdate(reg);
      try { reg.update(); } catch (e) {}
    })
    .catch(function (err) {
      console.warn('[PWA AutoUpdate] Falha no registro do Service Worker:', err);
    });

  // Gatilho imediato independente do Service Worker
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { checkServerVersion(true); });
  } else {
    checkServerVersion(true);
  }
})();

