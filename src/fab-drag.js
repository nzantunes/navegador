// Botões flutuantes do Papaléguas (Home, ↑ Topo): arrastáveis pelo usuário e
// escondidos enquanto um vídeo está sendo assistido.
//
//  PapaleguasFab.makeDraggable(el, { storageKey })  -> botão pode ser arrastado; posição salva.
//  PapaleguasFab.bindActivityPing()                 -> a página avisa o app pai a cada toque
//                                                      (inclusive toques dentro do player YouTube).
//  PapaleguasFab.notifyVideoWatch(active)           -> a página avisa o app pai que um vídeo
//                                                      começou (true) ou fechou (false).
(function (root) {
  if (root.PapaleguasFab) return;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function sendUp(payload) {
    try {
      if (root.parent && root.parent !== root) root.parent.postMessage(payload, '*');
    } catch (e) {}
    try {
      if (root.torBrowserAPI && typeof root.torBrowserAPI.sendToHost === 'function') {
        root.torBrowserAPI.sendToHost(payload.type, payload);
      }
    } catch (e) {}
  }

  function makeDraggable(el, opts) {
    if (!el || el.__pfabDrag) return el;
    el.__pfabDrag = true;
    opts = opts || {};
    var key = opts.storageKey || ('papaleguas_fab_pos_' + (el.id || 'btn'));
    var margin = typeof opts.margin === 'number' ? opts.margin : 6;
    var startX = 0, startY = 0, startLeft = 0, startTop = 0;
    var dragging = false, moved = false, pid = null, suppressClick = false;

    el.style.touchAction = 'none';

    function size() {
      var r = el.getBoundingClientRect();
      return { w: r.width || el.offsetWidth || 64, h: r.height || el.offsetHeight || 40 };
    }

    function apply(left, top) {
      var s = size();
      var maxL = Math.max(margin, root.innerWidth - s.w - margin);
      var maxT = Math.max(margin, root.innerHeight - s.h - margin);
      left = clamp(left, margin, maxL);
      top = clamp(top, margin, maxT);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.transform = 'none';
      el.style.margin = '0';
      return { left: left, top: top };
    }

    function stored() {
      try {
        var raw = localStorage.getItem(key);
        if (!raw) return null;
        var pos = JSON.parse(raw);
        if (!pos || typeof pos.xr !== 'number' || typeof pos.yr !== 'number') return null;
        return pos;
      } catch (e) { return null; }
    }

    function restore() {
      var pos = stored();
      if (!pos) return false;
      var s = size();
      apply(pos.xr * root.innerWidth - s.w / 2, pos.yr * root.innerHeight - s.h / 2);
      el.classList.add('is-moved');
      return true;
    }

    function save() {
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var xr = (r.left + r.width / 2) / Math.max(1, root.innerWidth);
      var yr = (r.top + r.height / 2) / Math.max(1, root.innerHeight);
      try { localStorage.setItem(key, JSON.stringify({ xr: xr, yr: yr })); } catch (e) {}
    }

    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      pid = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      var r = el.getBoundingClientRect();
      startLeft = r.left;
      startTop = r.top;
      dragging = true;
      moved = false;
      try { el.setPointerCapture(pid); } catch (err) {}
    }

    function onMove(e) {
      if (!dragging || e.pointerId !== pid) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 7) return;
      if (!moved) {
        moved = true;
        el.classList.add('is-dragging');
        if (typeof opts.onDragStart === 'function') opts.onDragStart();
      }
      if (e.cancelable) e.preventDefault();
      apply(startLeft + dx, startTop + dy);
    }

    function onEnd(e) {
      if (!dragging || (e && e.pointerId != null && e.pointerId !== pid)) return;
      dragging = false;
      try { el.releasePointerCapture(pid); } catch (err) {}
      if (!moved) return;
      el.classList.remove('is-dragging');
      el.classList.add('is-moved');
      save();
      // O soltar de um arraste não pode virar clique no botão.
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 400);
      if (typeof opts.onDragEnd === 'function') opts.onDragEnd();
    }

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onEnd);
    el.addEventListener('pointercancel', onEnd);
    el.addEventListener('click', function (e) {
      if (!suppressClick) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    el.addEventListener('dragstart', function (e) { e.preventDefault(); });

    // Mantém dentro da tela ao girar o celular / redimensionar e quando o botão
    // reaparece (display none -> visível) depois de ter sido movido.
    root.addEventListener('resize', function () { if (stored()) restore(); });
    try {
      if (root.ResizeObserver) {
        var ro = new ResizeObserver(function () {
          var r = el.getBoundingClientRect();
          if (r.width && r.height && stored()) restore();
        });
        ro.observe(el);
      }
    } catch (e) {}

    restore();
    el.__pfabReset = function () {
      try { localStorage.removeItem(key); } catch (e) {}
      el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.transform = el.style.margin = '';
      el.classList.remove('is-moved');
    };
    return el;
  }

  var lastPing = 0;
  function ping() {
    var now = Date.now();
    if (now - lastPing < 250) return;
    lastPing = now;
    sendUp({ type: 'user-activity' });
  }

  var activityBound = false;
  function bindActivityPing() {
    if (activityBound) return;
    activityBound = true;
    ['pointerdown', 'touchstart', 'mousedown', 'keydown'].forEach(function (ev) {
      root.addEventListener(ev, ping, { capture: true, passive: true });
    });
    // Toque dentro de um iframe (player do YouTube) não gera evento aqui, mas tira o
    // foco desta janela: usamos isso para avisar e devolvemos o foco para detectar o próximo.
    root.addEventListener('blur', function () {
      setTimeout(function () {
        var a = document.activeElement;
        if (a && a.tagName === 'IFRAME') {
          ping();
          setTimeout(function () { try { root.focus(); } catch (e) {} }, 350);
        }
      }, 0);
    });
  }

  function notifyVideoWatch(active) {
    sendUp({ type: 'video-watch', active: !!active });
  }

  root.PapaleguasFab = {
    makeDraggable: makeDraggable,
    bindActivityPing: bindActivityPing,
    notifyVideoWatch: notifyVideoWatch,
    ping: ping
  };
})(typeof window !== 'undefined' ? window : globalThis);
