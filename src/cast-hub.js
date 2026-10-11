// Central de transmissão inteligente para Smart TV.
// Conecta a TVs no Wi-Fi via Google Cast, AirPlay ou conexão direta por IP.
(function (root) {
  if (root.PapaleguasCastHub) return;

  const CSS = `
  .pch-overlay {
    position: fixed; inset: 0; z-index: 2147483000;
    display: none; align-items: flex-end; justify-content: center;
    padding: 0; background: rgba(2, 6, 14, 0.78); backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .pch-overlay.is-open { display: flex; }
  @media (min-width: 720px) { .pch-overlay { align-items: center; padding: 20px; } }
  .pch-card {
    position: relative; width: 100%; max-width: 480px; max-height: 92vh; max-height: 92dvh;
    overflow-y: auto; -webkit-overflow-scrolling: touch;
    background:
      radial-gradient(120% 70% at 100% 0%, rgba(56, 189, 248, 0.14), transparent 55%),
      radial-gradient(90% 60% at 0% 100%, rgba(16, 185, 129, 0.12), transparent 60%),
      linear-gradient(180deg, #0f1726, #080c15);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 24px 24px 0 0; padding: 14px 16px 18px;
    box-shadow: 0 -20px 60px rgba(0, 0, 0, 0.6);
    color: #f1f5f9; font-family: 'Outfit', 'Inter', system-ui, -apple-system, sans-serif;
    animation: pchUp 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
    scrollbar-width: none;
  }
  .pch-card::-webkit-scrollbar { display: none; }
  @media (min-width: 720px) { .pch-card { border-radius: 24px; } }
  @keyframes pchUp { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
  .pch-grip { width: 42px; height: 4px; border-radius: 4px; background: rgba(255,255,255,0.18); margin: 0 auto 10px; }
  @media (min-width: 720px) { .pch-grip { display: none; } }
  .pch-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
  .pch-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .pch-title-icon {
    width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; flex-shrink: 0;
    background: linear-gradient(135deg, #38bdf8, #6366f1); color: #06101c;
    box-shadow: 0 8px 20px rgba(56, 189, 248, 0.35);
  }
  .pch-title strong { display: block; font-size: 16px; font-weight: 800; letter-spacing: -0.2px; color: #fff; line-height: 1.1; }
  .pch-title small { display: block; font-size: 11px; color: #94a3b8; margin-top: 3px; }
  .pch-close {
    width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.06); color: #e2e8f0; font-size: 18px; line-height: 1; cursor: pointer; flex-shrink: 0;
  }
  .pch-net {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 14px; margin-bottom: 12px;
    border: 1px solid rgba(16, 185, 129, 0.35); background: rgba(16, 185, 129, 0.1);
  }
  .pch-net.is-remote { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.1); }
  .pch-net-dot { width: 10px; height: 10px; border-radius: 50%; background: #34d399; box-shadow: 0 0 10px #34d399; flex-shrink: 0; }
  .pch-net.is-remote .pch-net-dot { background: #fbbf24; box-shadow: 0 0 10px #fbbf24; }
  .pch-net-text { flex: 1; min-width: 0; }
  .pch-net-text b { display: block; font-size: 12.5px; color: #fff; }
  .pch-net-text span { display: block; font-size: 11px; color: #cbd5e1; line-height: 1.35; margin-top: 2px; }
  .pch-perm {
    display: none; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 14px; margin: 0 0 12px;
    border: 1px solid rgba(167, 139, 250, 0.4); background: rgba(139, 92, 246, 0.12);
  }
  .pch-perm.is-on { display: flex; }
  .pch-perm.is-granted { border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.1); }
  .pch-perm.is-denied { border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.1); }
  .pch-perm-icon { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: rgba(255,255,255,0.08); font-size: 17px; flex-shrink: 0; }
  .pch-perm-text { flex: 1; min-width: 0; }
  .pch-perm-text b { display: block; font-size: 12.5px; color: #fff; }
  .pch-perm-text span { display: block; font-size: 10.5px; color: #cbd5e1; line-height: 1.35; margin-top: 2px; }
  .pch-perm button {
    border: none; border-radius: 10px; padding: 9px 12px; font-size: 11.5px; font-weight: 800; color: #fff; cursor: pointer; white-space: nowrap; flex-shrink: 0;
    background: linear-gradient(135deg, #a855f7, #7c3aed); box-shadow: 0 6px 16px rgba(168,85,247,0.35);
  }
  .pch-perm.is-granted button { display: none; }
  .pch-device.is-cast { background: linear-gradient(135deg, rgba(14,165,233,0.16), rgba(15,23,42,0.85)); border-color: rgba(56,189,248,0.45); }
  .pch-device.is-cast .pch-device-icon { background: rgba(14,165,233,0.2); }
  .pch-device.is-cast .pch-device-text span { color: #7dd3fc; }
  .pch-device.is-cast button { background: linear-gradient(135deg, #0ea5e9, #2563eb); box-shadow: 0 6px 16px rgba(14,165,233,0.35); }
  .pch-media {
    display: flex; align-items: center; gap: 12px; padding: 10px; border-radius: 14px; margin-bottom: 14px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  }
  .pch-media img { width: 84px; height: 48px; object-fit: cover; border-radius: 8px; background: #000; flex-shrink: 0; }
  .pch-media-text { min-width: 0; }
  .pch-media-text small { display: block; font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 800; }
  .pch-media-text b { display: block; font-size: 13px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .pch-section { font-size: 10.5px; font-weight: 800; letter-spacing: 0.7px; text-transform: uppercase; color: #7dd3fc; margin: 14px 2px 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .pch-section .pch-mini-btn {
    border: 1px solid rgba(56,189,248,0.35); background: rgba(56,189,248,0.1); color: #7dd3fc;
    border-radius: 999px; padding: 4px 10px; font-size: 10.5px; font-weight: 800; cursor: pointer; letter-spacing: 0; text-transform: none;
    display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; flex-shrink: 0;
  }
  .pch-mini-btn .pch-spin { width: 10px; height: 10px; border: 2px solid rgba(125,211,252,0.3); border-top-color: #7dd3fc; border-radius: 50%; animation: pchSpin 0.8s linear infinite; display: none; }
  .pch-mini-btn.is-busy .pch-spin { display: inline-block; }
  @keyframes pchSpin { to { transform: rotate(360deg); } }
  .pch-tiles { display: grid; grid-template-columns: 1fr; gap: 8px; }
  .pch-tile {
    display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; cursor: pointer;
    padding: 12px; border-radius: 16px; color: #fff;
    background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(15, 23, 42, 0.9));
    border: 1px solid rgba(255,255,255,0.1); transition: transform 0.15s ease, border-color 0.15s ease;
  }
  .pch-tile:active { transform: scale(0.985); }
  .pch-tile.is-primary { border-color: rgba(56,189,248,0.5); box-shadow: 0 10px 30px rgba(56,189,248,0.15); }
  .pch-tile-icon {
    width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; flex-shrink: 0; font-size: 22px;
    background: rgba(255,255,255,0.06);
  }
  .pch-tile.is-primary .pch-tile-icon { background: linear-gradient(135deg, #0ea5e9, #2563eb); }
  .pch-tile-text { flex: 1; min-width: 0; }
  .pch-tile-text b { display: block; font-size: 13.5px; font-weight: 800; }
  .pch-tile-text span { display: block; font-size: 11px; color: #94a3b8; margin-top: 2px; line-height: 1.35; }
  .pch-tile-tag { font-size: 10.5px; font-weight: 800; padding: 5px 10px; border-radius: 8px; background: rgba(255,255,255,0.08); color: #e2e8f0; white-space: nowrap; }
  .pch-tile.is-primary .pch-tile-tag { background: #0ea5e9; color: #041423; }
  .pch-tile-tag.is-ok { background: rgba(16,185,129,0.25); color: #6ee7b7; }
  .pch-devices { display: flex; flex-direction: column; gap: 8px; }
  .pch-device {
    display: flex; align-items: center; gap: 12px; padding: 11px 12px; border-radius: 14px;
    background: linear-gradient(135deg, rgba(16,185,129,0.14), rgba(15,23,42,0.85)); border: 1px solid rgba(16,185,129,0.4);
  }
  .pch-device-icon { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; background: rgba(16,185,129,0.18); font-size: 20px; flex-shrink: 0; }
  .pch-device-text { flex: 1; min-width: 0; }
  .pch-device-text b { display: block; font-size: 13px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pch-device-text span { display: block; font-size: 10.5px; color: #6ee7b7; margin-top: 2px; }
  .pch-device button {
    border: none; border-radius: 10px; padding: 9px 14px; font-size: 12px; font-weight: 800; color: #fff; cursor: pointer;
    background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 6px 16px rgba(16,185,129,0.35);
  }
  .pch-empty {
    padding: 14px 12px; border-radius: 14px; text-align: center; font-size: 11.5px; color: #94a3b8; line-height: 1.45;
    background: rgba(255,255,255,0.03); border: 1px dashed rgba(255,255,255,0.16);
  }
  .pch-empty b { color: #e2e8f0; }
  .pch-empty-act {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    margin-top: 10px; padding: 10px 18px; border-radius: 12px; font-size: 13px; font-weight: 800;
    color: #fff; background: linear-gradient(135deg, #0ea5e9, #2563eb); border: none; cursor: pointer;
    box-shadow: 0 6px 20px rgba(14, 165, 233, 0.4);
  }
  .pch-empty-act:active { transform: scale(0.97); }
  .pch-progress { height: 4px; border-radius: 4px; background: rgba(255,255,255,0.08); overflow: hidden; margin: 8px 0 0; display: none; }
  .pch-progress.is-on { display: block; }
  .pch-progress i { display: block; height: 100%; width: 35%; border-radius: 4px; background: linear-gradient(90deg, #22d3ee, #34d399); animation: pchSweep 1.1s ease-in-out infinite; }
  @keyframes pchSweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
  .pch-scan-note { font-size: 10.5px; color: #64748b; margin-top: 6px; min-height: 14px; }
  .pch-ip { display: flex; gap: 8px; }
  .pch-ip input {
    flex: 1; min-width: 0; background: rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.14); color: #fff;
    padding: 11px 12px; border-radius: 12px; font-size: 14px; font-family: 'JetBrains Mono', ui-monospace, monospace; outline: none;
  }
  .pch-ip input:focus { border-color: #a78bfa; box-shadow: 0 0 0 3px rgba(167,139,250,0.2); }
  .pch-ip button {
    border: none; border-radius: 12px; padding: 0 16px; font-size: 12.5px; font-weight: 800; color: #fff; cursor: pointer; white-space: nowrap;
    background: linear-gradient(135deg, #a855f7, #7c3aed); box-shadow: 0 6px 16px rgba(168,85,247,0.35);
  }
  .pch-hint { font-size: 10.5px; color: #8b95a7; margin-top: 7px; line-height: 1.4; }
  .pch-hint b { color: #c4b5fd; }
  .pch-guide-card {
    margin-top: 12px; padding: 11px 13px; border-radius: 14px;
    background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.1);
  }
  .pch-guide-title {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font-size: 11.5px; color: #cbd5e1; cursor: pointer; user-select: none;
  }
  .pch-guide-title b { color: #f1f5f9; }
  .pch-guide-arrow { font-size: 11px; color: #94a3b8; transition: transform 0.2s ease; }
  .pch-guide-body { margin-top: 9px; font-size: 11px; color: #94a3b8; line-height: 1.5; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 9px; }
  .pch-guide-body p { margin: 0 0 6px; color: #cbd5e1; }
  .pch-guide-body ol { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
  .pch-guide-body li { color: #cbd5e1; }
  .pch-guide-body b { color: #38bdf8; }
  .pch-guide-body i { color: #e2e8f0; font-style: normal; }
  .pch-feedback {
    display: none; margin-top: 12px; padding: 10px 12px; border-radius: 12px; font-size: 12px; text-align: center; font-weight: 700;
  }
  .pch-feedback.is-ok { display: block; background: rgba(16,185,129,0.15); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.35); }
  .pch-feedback.is-err { display: block; background: rgba(239,68,68,0.14); color: #fca5a5; border: 1px solid rgba(239,68,68,0.35); }
  .pch-feedback.is-info { display: block; background: rgba(56,189,248,0.12); color: #bae6fd; border: 1px solid rgba(56,189,248,0.3); }
  .pch-feedback.is-busy {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    background: rgba(56,189,248,0.12); color: #bae6fd; border: 1px solid rgba(56,189,248,0.3);
  }
  .pch-feedback .pch-spin { width: 14px; height: 14px; border: 2px solid rgba(186,230,253,0.3); border-top-color: #bae6fd; border-radius: 50%; animation: pchSpin 0.8s linear infinite; display: inline-block; flex-shrink: 0; }
  .pch-device button.is-busy, .pch-ip button.is-busy {
    display: inline-flex; align-items: center; gap: 7px; opacity: 0.85; cursor: progress;
  }
  .pch-device button .pch-spin, .pch-ip button .pch-spin { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff; border-radius: 50%; animation: pchSpin 0.8s linear infinite; display: inline-block; }
  .pch-device.is-connecting { border-color: rgba(56,189,248,0.6); box-shadow: 0 0 0 2px rgba(56,189,248,0.15); }
  .pch-steps { margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
  .pch-steps li { display: flex; gap: 8px; font-size: 11.5px; color: #cbd5e1; line-height: 1.4; }
  .pch-steps li i { width: 18px; height: 18px; border-radius: 50%; background: rgba(56,189,248,0.2); color: #7dd3fc; font-size: 10px; font-weight: 800; display: grid; place-items: center; flex-shrink: 0; font-style: normal; }
  .pch-hidden-video { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; left: -10px; bottom: 0; }
  `;

  const state = {
    open: false,
    getMedia: null,
    scanning: false,
    devices: [],
    remote: false,
    castAvailable: null,
    availabilityWatch: null,
    permission: 'unknown',
    connectingIp: ''
  };

  const isApple = /Macintosh|Mac OS|iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cc() { return root.PapaleguasClientCast || null; }

  function isRemote() {
    const c = cc();
    if (c && typeof c.isRemotePublicOrigin === 'function') return c.isRemotePublicOrigin();
    const h = String(location.hostname || '');
    return !(h === 'localhost' || h === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h));
  }

  function ensureDom() {
    if (document.getElementById('pch-overlay')) return;
    const style = document.createElement('style');
    style.id = 'pch-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'pch-overlay';
    wrap.id = 'pch-overlay';
    wrap.innerHTML = `
      <div class="pch-card" role="dialog" aria-label="Transmitir na TV">
        <div class="pch-grip"></div>
        <div class="pch-head">
          <div class="pch-title">
            <span class="pch-title-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><circle cx="2" cy="20" r="1" fill="currentColor"/></svg>
            </span>
            <div>
              <strong>Transmitir na Smart TV</strong>
              <small id="pch-subtitle">Transmita vídeos, filmes e músicas direto para a sua TV</small>
            </div>
          </div>
          <button type="button" class="pch-close" id="pch-close" aria-label="Fechar">×</button>
        </div>

        <div class="pch-net" id="pch-net">
          <span class="pch-net-dot"></span>
          <div class="pch-net-text"><b id="pch-net-title">📶 Conexão Wi-Fi do seu Celular</b><span id="pch-net-desc">Certifique-se de que a Smart TV e o seu celular estão conectados na mesma rede Wi-Fi.</span></div>
        </div>

        <div class="pch-perm" id="pch-perm">
          <span class="pch-perm-icon">🔓</span>
          <div class="pch-perm-text"><b id="pch-perm-title">Acesso à Rede Local</b><span id="pch-perm-desc">Permita que o aplicativo encontre Smart TVs conectadas na rede Wi-Fi da sua casa.</span></div>
          <button type="button" id="pch-perm-btn">Permitir Acesso</button>
        </div>

        <div class="pch-media" id="pch-media">
          <img id="pch-media-thumb" alt="" />
          <div class="pch-media-text"><small>Vai para a TV</small><b id="pch-media-title">Nenhum vídeo em reprodução</b></div>
        </div>

        <div class="pch-section">Opções de Transmissão Direta</div>
        <div class="pch-tiles">
          <button type="button" class="pch-tile is-primary" id="pch-tile-cast">
            <span class="pch-tile-icon">📡</span>
            <span class="pch-tile-text"><b>Google Cast / Smart TV</b><span id="pch-cast-desc">Chromecast, Google TV, Android TV, Philco, TCL e Philips no seu Wi-Fi.</span></span>
            <span class="pch-tile-tag" id="pch-cast-tag">Conectar na TV</span>
          </button>
          <button type="button" class="pch-tile" id="pch-tile-pair">
            <span class="pch-tile-icon">🔗</span>
            <span class="pch-tile-text"><b>Vincular com Código da TV (YouTube)</b><span>Funciona em 100% das Smart TVs (Samsung, LG, Roku, Philco, TCL).</span></span>
            <span class="pch-tile-tag">Código TV</span>
          </button>
          <button type="button" class="pch-tile" id="pch-tile-airplay" style="display:none;">
            <span class="pch-tile-icon">🍏</span>
            <span class="pch-tile-text"><b>Apple AirPlay</b><span>Apple TV e Smart TVs Samsung e LG com suporte a AirPlay 2.</span></span>
            <span class="pch-tile-tag">AirPlay</span>
          </button>
          <button type="button" class="pch-tile" id="pch-tile-browser">
            <span class="pch-tile-icon">📱</span>
            <span class="pch-tile-text"><b>Espelhamento de Tela (Smart View / Miracast)</b><span id="pch-browser-desc">Ideal para espelhar a tela do celular na TV com som e imagem.</span></span>
            <span class="pch-tile-tag">Como Fazer</span>
          </button>
        </div>
        <div class="pch-guide-card" id="pch-pair-guide" style="display:none;margin-top:8px;border-color:rgba(56,189,248,0.4);background:rgba(14,165,233,0.08);">
          <div style="font-size:12.5px;font-weight:800;color:#38bdf8;margin-bottom:6px;">🔗 Conectar pelo Código da TV (Qualquer Marca):</div>
          <ol style="margin:0;padding-left:18px;display:grid;gap:6px;font-size:11px;color:#cbd5e1;">
            <li>Na sua Smart TV (Samsung, LG, Roku, Philco, TCL...), abra o aplicativo do <b>YouTube</b>.</li>
            <li>Acesse <b>Configurações ⚙️ › Vincular com código da TV</b> (será exibido um código de 12 números).</li>
            <li>Toque no botão abaixo para abrir a página oficial de vinculação do YouTube no celular e digite o código:</li>
          </ol>
          <div style="text-align:center;margin-top:10px;">
            <a href="https://www.youtube.com/pair" target="_blank" rel="noopener" class="pch-empty-act" style="text-decoration:none;">🔗 Abrir Vinculação no Celular (youtube.com/pair)</a>
          </div>
        </div>
        <ul class="pch-steps" id="pch-steps" style="display:none;">
          <li><i>1</i><span>Puxe a barra de notificações do seu celular (deslize de cima para baixo).</span></li>
          <li><i>2</i><span>Toque no botão <b>Smart View</b>, <b>Transmitir</b> ou <b>Espelhar Tela</b>.</span></li>
          <li><i>3</i><span>Selecione a sua Smart TV na lista para espelhar a tela instantaneamente.</span></li>
        </ul>

        <div class="pch-section"><span id="pch-devices-label">Smart TVs Reconhecidas no seu Wi-Fi</span>
          <button type="button" class="pch-mini-btn" id="pch-rescan"><i class="pch-spin"></i>Buscar Aparelhos</button>
        </div>
        <div class="pch-devices" id="pch-devices"></div>
        <div class="pch-progress" id="pch-progress"><i></i></div>
        <div class="pch-scan-note" id="pch-scan-note"></div>

        <div class="pch-section">Smart TV por Endereço IP (Samsung, LG, Roku, Fire TV)</div>
        <div class="pch-ip">
          <input type="text" id="pch-ip" inputmode="decimal" placeholder="Digite o IP da TV (Ex: 192.168.1.15)" autocomplete="off" />
          <button type="button" id="pch-ip-go">▶ Conectar na TV</button>
        </div>
        <div class="pch-hint" id="pch-ip-hint">
          <b>💡 Como encontrar o IP da sua Smart TV:</b><br>
          • <b>Samsung:</b> Configurações › Geral › Rede › Status da Rede › Configurações de IP<br>
          • <b>LG (webOS):</b> Configurações › Rede › Conexão Wi-Fi › Avançado › Endereço IP<br>
          • <b>Roku TV:</b> Configurações › Rede › Sobre › Endereço IP<br>
          • <b>Android TV / Chromecast:</b> Configurações › Rede e Internet › Seu Wi-Fi › Endereço IP
        </div>

        <div class="pch-guide-card" id="pch-perm-guide">
          <div class="pch-guide-title" id="pch-guide-toggle">
            <span>❓ <b>Por que no app baixado não aparece o cadeado 🔒 para dar permissão?</b></span>
            <span class="pch-guide-arrow" id="pch-guide-arrow">▼</span>
          </div>
          <div class="pch-guide-body" id="pch-guide-body" style="display:none;">
            <p>Quando você instala o aplicativo na tela inicial do celular, o Android remove a barra de endereço e o cadeado de propósito para que o app fique em tela cheia.</p>
            <ol>
              <li><b>Você NÃO precisa dar permissão pelo cadeado:</b> Toque no botão azul <b>📡 Google Cast / Smart TV</b> ou no botão <b>Escolher TV no Google Cast</b>. O próprio Android abre a lista de TVs do seu Wi-Fi direto pelo sistema do celular!</li>
              <li><b>Conectar Direto pelo IP da TV:</b> Digite o IP da sua TV (ex: 192.168.1.15) no campo acima e toque em <b>Conectar na TV</b>. O app salva o IP e conecta na hora.</li>
              <li><b>Permissões nas Configurações do Android (opcional):</b> Se quiser ver as permissões do app, vá em <i>Configurações do celular › Aplicativos › Papaléguas (ou Chrome) › Permissões › Dispositivos por perto</i>.</li>
            </ol>
          </div>
        </div>

        <div class="pch-feedback" id="pch-feedback"></div>
      </div>
      <video class="pch-hidden-video" id="pch-video" playsinline muted preload="none"></video>
    `;
    document.body.appendChild(wrap);

    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.getElementById('pch-close').addEventListener('click', close);
    document.getElementById('pch-rescan').addEventListener('click', () => scan(true));
    document.getElementById('pch-tile-cast').addEventListener('click', castViaPhone);
    document.getElementById('pch-tile-pair').addEventListener('click', () => {
      const g = document.getElementById('pch-pair-guide');
      if (g) g.style.display = g.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('pch-tile-airplay').addEventListener('click', castViaAirPlay);
    document.getElementById('pch-tile-browser').addEventListener('click', () => {
      const steps = document.getElementById('pch-steps');
      steps.style.display = steps.style.display === 'none' ? 'grid' : 'none';
    });
    document.getElementById('pch-guide-toggle').addEventListener('click', () => {
      const body = document.getElementById('pch-guide-body');
      const arrow = document.getElementById('pch-guide-arrow');
      const open = body.style.display === 'none';
      body.style.display = open ? 'block' : 'none';
      arrow.textContent = open ? '▲' : '▼';
    });
    document.getElementById('pch-perm-btn').addEventListener('click', grantLocalNetwork);
    document.getElementById('pch-ip-go').addEventListener('click', () => castToIp());
    document.getElementById('pch-ip').addEventListener('keydown', (e) => { if (e.key === 'Enter') castToIp(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) close(); });
  }

  function feedback(msg, kind) {
    const fb = document.getElementById('pch-feedback');
    if (!fb) return;
    clearTimeout(feedback._t);
    if (kind === 'busy') {
      // Estado "conectando": spinner + texto, fica visível até a próxima mensagem.
      fb.innerHTML = '<i class="pch-spin"></i><span></span>';
      fb.querySelector('span').textContent = msg;
      fb.className = 'pch-feedback is-busy';
      return;
    }
    fb.textContent = msg;
    fb.className = 'pch-feedback ' + (kind === 'err' ? 'is-err' : kind === 'info' ? 'is-info' : 'is-ok');
    feedback._t = setTimeout(() => { fb.className = 'pch-feedback'; }, 5000);
  }

  function setButtonBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.pchLabel) btn.dataset.pchLabel = btn.innerHTML;
      btn.innerHTML = '<i class="pch-spin"></i>' + esc(label || 'Conectando…');
      btn.classList.add('is-busy');
      btn.disabled = true;
    } else {
      if (btn.dataset.pchLabel) btn.innerHTML = btn.dataset.pchLabel;
      delete btn.dataset.pchLabel;
      btn.classList.remove('is-busy');
      btn.disabled = false;
    }
  }

  function media() {
    let m = {};
    try { m = (typeof state.getMedia === 'function' ? state.getMedia() : state.getMedia) || {}; } catch (e) {}
    const c = cc();
    const videoId = m.videoId || (c && c.extractVideoId ? c.extractVideoId(m.url || '') : '') || '';
    return {
      videoId,
      title: m.title || (videoId ? 'Vídeo' : ''),
      url: m.url || (videoId ? ('https://www.youtube.com/watch?v=' + videoId) : location.href),
      streamUrl: m.streamUrl || (videoId ? (location.origin + '/api/stream-video?v=' + encodeURIComponent(videoId)) : '')
    };
  }

  function renderMedia() {
    const m = media();
    const t = document.getElementById('pch-media-title');
    const img = document.getElementById('pch-media-thumb');
    if (t) t.textContent = m.title || 'Nenhum vídeo em reprodução';
    if (img) {
      if (m.videoId) {
        img.style.display = '';
        img.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(m.videoId) + '/mqdefault.jpg';
      } else {
        img.style.display = 'none';
      }
    }
  }

  function renderNetwork() {
    state.remote = isRemote();
    const box = document.getElementById('pch-net');
    const title = document.getElementById('pch-net-title');
    const desc = document.getElementById('pch-net-desc');
    const label = document.getElementById('pch-devices-label');
    const castDesc = document.getElementById('pch-cast-desc');
    if (!box) return;
    box.classList.toggle('is-remote', state.remote);
    title.textContent = '📶 Wi-Fi deste Aparelho (Rede do Celular)';
    desc.textContent = 'A transmissão conecta direto na Smart TV no Wi-Fi deste celular (não depende da rede do servidor).';
    if (label) label.textContent = 'Smart TVs no Wi-Fi deste Celular';
    if (castDesc) castDesc.textContent = 'Chromecast, Google TV, Android TV, Philco, TCL e Philips no seu Wi-Fi.';
    const air = document.getElementById('pch-tile-airplay');
    if (air) air.style.display = isApple ? 'flex' : 'none';
    const bdesc = document.getElementById('pch-browser-desc');
    if (bdesc) {
      bdesc.textContent = isAndroid
        ? 'Toque em ⋮ e depois em “Transmitir…” para espelhar esta aba na TV.'
        : (isApple ? 'Use o Espelhamento de Tela do iPhone/iPad para mandar a aba para a TV.' : 'No Chrome, clique em ⋮ › Transmitir… e escolha sua TV.');
    }
  }

  // Permissão de acesso à rede local no navegador em páginas HTTPS.
  async function refreshPermission() {
    const c = cc();
    if (!c || typeof c.localNetworkPermissionState !== 'function') { state.permission = 'unsupported'; return state.permission; }
    try { state.permission = await c.localNetworkPermissionState(); } catch (e) { state.permission = 'unsupported'; }
    return state.permission;
  }

  function renderPermission() {
    const box = document.getElementById('pch-perm');
    const title = document.getElementById('pch-perm-title');
    const desc = document.getElementById('pch-perm-desc');
    const btn = document.getElementById('pch-perm-btn');
    if (!box) return;
    const httpsPage = location.protocol === 'https:';
    if (!state.remote || !httpsPage) { box.className = 'pch-perm'; return; }

    const isStandalone = typeof window !== 'undefined' && (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://')
    );

    const p = state.permission;
    if (p === 'granted') {
      box.className = 'pch-perm is-on is-granted';
      title.textContent = 'Acesso à rede local liberado';
      desc.textContent = 'O aplicativo está autorizado a se comunicar com as Smart TVs no seu Wi-Fi.';
      if (btn) btn.style.display = 'none';
      return;
    }

    // No modo aplicativo baixado (PWA / WebAPK) ou sem varredura silenciosa:
    box.className = 'pch-perm is-on';
    box.classList.remove('is-denied');
    title.textContent = '📱 Transmissão Direta no Celular';
    desc.textContent = 'No aplicativo baixado, conecte na sua TV pelo botão azul Google Cast / Smart TV ou digite o IP da TV.';
    if (btn) {
      btn.textContent = '📡 Conectar na TV';
      btn.style.display = 'inline-block';
    }
  }

  async function grantLocalNetwork() {
    // No app instalado, aciona diretamente a gaveta nativa de Cast do sistema Android/iOS
    castViaPhone();
  }

  function renderDevices() {
    const list = document.getElementById('pch-devices');
    if (!list) return;
    let html = '';
    // Chromecast / Android TV que o próprio celular enxerga na rede atual.
    if (state.castAvailable) {
      html += '<div class="pch-device is-cast"><span class="pch-device-icon">📡</span>' +
        '<div class="pch-device-text"><b>TV com Chromecast disponível</b><span>Encontrada pelo celular neste Wi-Fi · toque para escolher</span></div>' +
        '<button type="button" data-cast="1">▶ Escolher</button></div>';
    }
    if (!state.devices.length && !html) {
      if (state.scanning) {
        list.innerHTML = '<div class="pch-empty">🔍 Buscando TVs no Wi-Fi…<br>' +
          '<button type="button" class="pch-empty-act" id="pch-empty-cast">📡 Abrir Lista de TVs (Google Cast)</button></div>';
      } else {
        const c = cc();
        const net = c && c.networkLabel ? c.networkLabel() : '';
        list.innerHTML = '<div class="pch-empty"><b>Conectar na sua Smart TV:</b><br>' +
          'No celular, conecte direto pelo transmissor nativo com 1 toque:<br>' +
          '<button type="button" class="pch-empty-act" id="pch-empty-cast">📡 Escolher TV no Google Cast</button>' +
          '<div style="margin-top:10px;font-size:11px;color:#94a3b8;">ou digite o IP da TV no campo abaixo</div></div>';
      }
      const emptyCastBtn = document.getElementById('pch-empty-cast');
      if (emptyCastBtn) emptyCastBtn.addEventListener('click', castViaPhone);
      return;
    }
    html += state.devices.map((d) => {
      const ip = String(d.ip || '').replace(/[^0-9.]/g, '');
      const isCast = d.type === 'chromecast';
      const name = d.name || (isCast ? 'Chromecast / Google TV' : ('Smart TV (' + ip + ')'));
      const connecting = !!ip && state.connectingIp === ip;
      const sub = connecting
        ? 'Conectando ao dispositivo…'
        : (ip ? 'IP ' + esc(ip) + ' · pronta para receber' : 'Pronta para conectar');
      const btn = isCast
        ? '<button type="button" data-cast="1">▶ Conectar</button>'
        : (connecting
          ? '<button type="button" class="is-busy" disabled data-ip="' + esc(ip) + '"><i class="pch-spin"></i>Conectando…</button>'
          : '<button type="button" data-ip="' + esc(ip) + '">▶ Transmitir</button>');
      return '<div class="pch-device' + (isCast ? ' is-cast' : '') + (connecting ? ' is-connecting' : '') + '"><span class="pch-device-icon">' + (isCast ? '📡' : '📺') + '</span>' +
        '<div class="pch-device-text"><b>' + esc(name) + '</b><span>' + sub + '</span></div>' + btn + '</div>';
    }).join('');
    if (state.scanning && !state.devices.length) {
      html += '<div class="pch-scan-note">🔍 Buscando aparelhos conectados no seu Wi-Fi…</div>';
    }
    list.innerHTML = html;
    list.querySelectorAll('button[data-ip]').forEach((b) => {
      b.addEventListener('click', () => castToIp(b.getAttribute('data-ip'), b));
    });
    list.querySelectorAll('button[data-cast]').forEach((b) => {
      b.addEventListener('click', castViaPhone);
    });
    const firstRoku = state.devices.find((d) => d.type === 'roku' && d.ip);
    if (firstRoku) {
      const ipInput = document.getElementById('pch-ip');
      if (ipInput && !ipInput.value) ipInput.value = firstRoku.ip;
    }
  }

  function setScanning(on, note) {
    state.scanning = on;
    const btn = document.getElementById('pch-rescan');
    const prog = document.getElementById('pch-progress');
    const noteEl = document.getElementById('pch-scan-note');
    if (btn) btn.classList.toggle('is-busy', on);
    if (prog) prog.classList.toggle('is-on', on);
    if (noteEl) noteEl.textContent = note || '';
  }

  let scanToken = 0;
  async function scan(force) {
    const c = cc();
    if (!c || typeof c.scanDevices !== 'function') return;
    if (state.scanning && !force) return;
    const token = ++scanToken;
    state.devices = [];
    setScanning(true, state.remote ? 'Descobrindo o Wi-Fi do celular e testando os endereços mais comuns…' : 'Consultando o servidor e o seu aparelho…');
    renderDevices();

    const started = Date.now();
    // Depois deste tempo a busca continua, mas avisamos que está demorando.
    // Só dizemos "nenhuma TV" quando a varredura realmente termina.
    const slowAfterMs = state.remote ? 25000 : 15000;
    const hardLimitMs = 90000;
    const noteTimer = setInterval(() => {
      if (token !== scanToken) return clearInterval(noteTimer);
      const info = c.lastScanInfo || {};
      const secs = Math.round((Date.now() - started) / 1000);
      let txt = '';
      if (info.subnets && info.subnets.length) txt = 'Testando ' + info.subnets[0] + '.x';
      if (info.localIps && info.localIps.length) txt += (txt ? ' · ' : '') + 'IP do celular: ' + info.localIps[0];
      const slow = (Date.now() - started) > slowAfterMs && !state.devices.length;
      setScanning(true, (slow ? 'Demorando mais que o normal, ainda procurando… ' : '') + (txt || 'Procurando…') + ' · ' + secs + 's');
    }, 700);

    const hardTimeout = new Promise((r) => setTimeout(r, hardLimitMs));
    try {
      await Promise.race([
        c.scanDevices((dev) => {
          if (token !== scanToken || !dev || !dev.ip) return;
          if (state.devices.some((d) => d.ip === dev.ip)) return;
          state.devices.push(dev);
          renderDevices();
          if (!state.scanning) setScanning(false, state.devices.length + ' TV(s) encontrada(s).');
          const ipInput = document.getElementById('pch-ip');
          if (ipInput && !ipInput.value) ipInput.value = dev.ip;
        }),
        hardTimeout
      ]);
    } catch (e) {}
    clearInterval(noteTimer);
    if (token !== scanToken) return;
    let endNote = '';
    if (state.devices.length) endNote = state.devices.length + ' TV(s) encontrada(s).';
    else if (state.remote && location.protocol === 'https:' && state.permission !== 'granted') endNote = 'Para busca automática, permita rede local ou use o botão Google Cast.';
    else if (c.networkLabel && c.networkLabel()) endNote = 'Nenhuma Smart TV respondeu em ' + c.networkLabel() + '. Use Google Cast ou IP direto.';
    setScanning(false, endNote);
    renderDevices();
  }

  function hiddenVideo() {
    return document.getElementById('pch-video');
  }

  async function watchCastAvailability() {
    const v = hiddenVideo();
    const tag = document.getElementById('pch-cast-tag');
    if (!v || !v.remote || typeof v.remote.watchAvailability !== 'function') return;
    try {
      if (state.availabilityWatch != null) {
        try { await v.remote.cancelWatchAvailability(state.availabilityWatch); } catch (e) {}
      }
      state.availabilityWatch = await v.remote.watchAvailability((avail) => {
        const changed = state.castAvailable !== !!avail;
        state.castAvailable = !!avail;
        if (tag) {
          tag.textContent = avail ? 'TV encontrada' : 'Conectar';
          tag.classList.toggle('is-ok', !!avail);
        }
        if (changed) renderDevices();
      });
    } catch (e) {}
  }

  function loadGoogleCastSdk() {
    if (window.cast && window.cast.framework) return;
    window['__onGCastApiAvailable'] = function (isAvailable) {
      if (isAvailable && window.cast && window.cast.framework) {
        try {
          const ctx = cast.framework.CastContext.getInstance();
          ctx.setOptions({
            receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
          });
          state.castAvailable = true;
          renderDevices();
        } catch (e) {}
      }
    };
    if (!document.getElementById('pch-gcast-sdk')) {
      const s = document.createElement('script');
      s.id = 'pch-gcast-sdk';
      s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
      s.async = true;
      document.head.appendChild(s);
    }
  }

  async function castViaPhone() {
    const m = media();
    feedback('Abrindo lista de TVs no Wi-Fi deste celular…', 'info');

    // 1. Google Cast SDK oficial (Chromecast / Google TV / Android TV)
    if (window.cast && window.cast.framework) {
      try {
        const ctx = cast.framework.CastContext.getInstance();
        await ctx.requestSession();
        const session = ctx.getCurrentSession();
        if (session) {
          const streamTarget = m.streamUrl || (location.origin + '/api/stream-video?v=' + (m.videoId || ''));
          const mediaInfo = new chrome.cast.media.MediaInfo(streamTarget, 'video/mp4');
          mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
          mediaInfo.metadata.title = m.title || 'Vídeo';
          const request = new chrome.cast.media.LoadRequest(mediaInfo);
          await session.loadMedia(request);
          feedback('Transmitindo na TV via Google Cast!', 'ok');
          return;
        }
      } catch (e) {
        if (e && e !== 'cancel') console.warn('Cast error:', e);
      }
    }

    // 2. Remote Playback API nativa no video
    const v = hiddenVideo();
    const streamTarget = m.streamUrl || (location.origin + '/api/stream-video?v=' + (m.videoId || 'dQw4w9WgXcQ'));
    if (v && v.remote && typeof v.remote.prompt === 'function') {
      try {
        if (v.getAttribute('src') !== streamTarget && streamTarget) {
          v.src = streamTarget;
          try { v.load(); } catch (e) {}
        }
        v.muted = false;
        v.onconnect = null;
        v.remote.onconnect = () => {
          feedback('Conectado! “' + (m.title || 'Vídeo') + '” está indo para a TV.', 'ok');
          try { v.play().catch(() => {}); } catch (e) {}
        };
        v.remote.ondisconnect = () => feedback('TV desconectada.', 'info');
        await v.remote.prompt();
        return;
      } catch (e) {
        if (e && e.name === 'NotFoundError') {
          feedback('Nenhuma TV com Chromecast foi encontrada no Wi-Fi deste celular.', 'err');
          return;
        }
        if (e && e.name === 'NotAllowedError') {
          feedback('Seleção cancelada.', 'info');
          return;
        }
      }
    }

    // 3. PresentationRequest com URLs
    try {
      if (root.PresentationRequest) {
        const targets = [];
        if (m.videoId) targets.push('https://www.youtube.com/watch?v=' + m.videoId);
        if (m.streamUrl) targets.push(m.streamUrl);
        targets.push(location.href);
        const req = new root.PresentationRequest(targets);
        await req.start();
        feedback('Conectado à TV!', 'ok');
        return;
      }
    } catch (e) {
      if (e && e.name === 'NotAllowedError') { feedback('Seleção cancelada.', 'info'); return; }
    }

    const steps = document.getElementById('pch-steps');
    if (steps) steps.style.display = 'grid';
    feedback('No navegador do celular, toque em ⋮ › Transmitir… e escolha sua TV.', 'info');
  }

  function castViaAirPlay() {
    const v = document.querySelector('video:not(.pch-hidden-video)') || hiddenVideo();
    const m = media();
    if (v && v.webkitShowPlaybackTargetPicker) {
      if (v === hiddenVideo() && m.streamUrl) v.src = m.streamUrl;
      v.webkitShowPlaybackTargetPicker();
      feedback('Escolha sua TV no AirPlay.', 'info');
      return;
    }
    feedback('Use o Espelhamento de Tela do iPhone para a TV.', 'info');
  }

  async function castToIp(customIp, sourceBtn) {
    const c = cc();
    const input = document.getElementById('pch-ip');
    let ip = (customIp || (input ? input.value : '') || '').trim();
    if (!ip) {
      try { ip = localStorage.getItem('papaleguas_client_roku_ip') || ''; } catch (e) {}
    }
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      feedback('Digite o IP da TV, por exemplo 192.168.1.15.', 'err');
      if (input) input.focus();
      return;
    }
    if (state.connectingIp) return; // já tem uma conexão em andamento
    if (input) input.value = ip;
    try { localStorage.setItem('papaleguas_client_roku_ip', ip); } catch (e) {}
    const m = media();
    if (!c || typeof c.launchRoku !== 'function') {
      feedback('Transmissão por IP indisponível neste navegador.', 'err');
      return;
    }

    // Loading: botão de origem, cartão da TV e faixa de feedback mostram "conectando".
    const ipGoBtn = document.getElementById('pch-ip-go');
    state.connectingIp = ip;
    setButtonBusy(sourceBtn || ipGoBtn, true, 'Conectando…');
    if (sourceBtn && sourceBtn !== ipGoBtn) setButtonBusy(ipGoBtn, true, 'Conectando…');
    renderDevices();
    feedback('Conectando ao dispositivo ' + ip + '… abrindo o YouTube na TV.', 'busy');

    let res = null;
    try {
      res = await c.launchRoku(ip, m.videoId || m.url, m.title);
    } catch (e) {
      res = { success: false, error: e && e.message };
    }

    state.connectingIp = '';
    setButtonBusy(ipGoBtn, false);
    if (sourceBtn && sourceBtn !== ipGoBtn) setButtonBusy(sourceBtn, false);

    if (res && res.success && res.reached) {
      feedback('Transmitindo na TV ' + ip + '!', 'ok');
      if (!state.devices.some((d) => d.ip === ip)) {
        state.devices.push({ id: 'roku-' + ip, name: 'Smart TV (' + ip + ')', ip, type: 'roku' });
      }
    } else if (res && res.success) {
      feedback(state.remote
        ? 'Sinal enviado para ' + ip + '. Se a TV não reagir, permita “rede local” quando o navegador pedir e tente de novo.'
        : 'Sinal enviado para a TV ' + ip + '. Confira a tela.', 'info');
    } else {
      feedback((res && res.error) || 'Não consegui falar com a TV ' + ip + '.', 'err');
    }
    renderDevices();
  }

  function open(opts) {
    ensureDom();
    state.getMedia = (opts && (opts.getMedia || opts.media)) || state.getMedia;
    state.open = true;
    const overlay = document.getElementById('pch-overlay');
    overlay.classList.add('is-open');
    document.getElementById('pch-steps').style.display = 'none';
    renderNetwork();
    renderMedia();
    renderPermission();
    const ipInput = document.getElementById('pch-ip');
    try {
      const saved = localStorage.getItem('papaleguas_client_roku_ip') || '';
      if (ipInput && saved && !ipInput.value) ipInput.value = saved;
    } catch (e) {}
    const m = media();
    const v = hiddenVideo();
    if (v && m.streamUrl && v.getAttribute('src') !== m.streamUrl) {
      v.src = m.streamUrl;
    }
    loadGoogleCastSdk();
    watchCastAvailability();
    // A busca começa já; o primeiro pedido de rede local ainda está dentro do toque
    // que abriu a janela, então o navegador pode mostrar o pedido de permissão.
    refreshPermission().then(renderPermission);
    scan(true).then(() => refreshPermission().then(renderPermission));
  }

  function close() {
    state.open = false;
    const overlay = document.getElementById('pch-overlay');
    if (overlay) overlay.classList.remove('is-open');
    scanToken++;
    setScanning(false, '');
  }

  root.PapaleguasCastHub = { open, close, castToIp, castViaPhone, scan, isRemote };
})(typeof window !== 'undefined' ? window : globalThis);
