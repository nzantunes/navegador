// Polyfill de fetch para ambiente local Electron (file://) rotear requisições /api/ para http://localhost:8080
if (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:') {
  const _origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && (input.startsWith('/api/') || input.startsWith('/youtube') || input.startsWith('/search') || input.startsWith('/filmes'))) {
      input = 'http://localhost:8080' + input;
    } else if (input instanceof URL && input.protocol === 'file:' && input.pathname.startsWith('/api/')) {
      input = new URL('http://localhost:8080' + input.pathname + input.search);
    }
    return _origFetch.call(this, input, init);
  };
}

function resolveMediaUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let trimmed = url.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) {
    if (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:') {
      trimmed = 'http://localhost:8080' + trimmed;
    }
  }
  // Garante bypass do aviso do ngrok no streaming direto de áudio nativo
  if (trimmed.includes('/api/stream-') || trimmed.includes('/api/audio-')) {
    if (!trimmed.includes('ngrok-skip-browser-warning')) {
      const sep = trimmed.includes('?') ? '&' : '?';
      trimmed = trimmed + sep + 'ngrok-skip-browser-warning=1';
    }
  }
  return trimmed;
}

// Identificador desta instância (celular ou Electron). Global: usado pelo polyfill,
// pelo pré-aquecimento de playlist, isolamento de playlists por dispositivo e histórico do DJ.
const CLIENT_ID = (() => {
  try {
    if (typeof window !== 'undefined' && window.torBrowserAPI && window.torBrowserAPI.isElectron) {
      return 'desktop_host';
    }
    if (typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent || '')) {
      return 'desktop_host';
    }
    // Outros navegadores (mesmo em localhost) recebem ID próprio: playlists exclusivas por dispositivo/navegador.
  } catch(e) {}
  let id = null;
  try { id = localStorage.getItem('papaleguas_client_id'); } catch(e) {}
  if (!id) {
    id = 'cli_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
    try { localStorage.setItem('papaleguas_client_id', id); } catch(e) {}
  }
  return id;
})();

// Polyfill de torBrowserAPI para funcionamento pleno no celular (mobile web / iframe)
if (!window.torBrowserAPI) {
  window.torBrowserAPI = {
    isElectron: false,
    searchMusic: async (query, limit = 30, index = 0) => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}&index=${index}&clientId=${encodeURIComponent(CLIENT_ID)}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        return await res.json();
      } catch (e) { return { success: false, results: [] }; }
    },
    searchPlaylists: async (query) => {
      try {
        const res = await fetch(`/api/playlists?q=${encodeURIComponent(query)}&clientId=${encodeURIComponent(CLIENT_ID)}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        return await res.json();
      } catch (e) { return { success: false, results: [] }; }
    },
    searchAll: async (query) => {
      try {
        const res = await fetch(`/api/all?q=${encodeURIComponent(query)}&clientId=${encodeURIComponent(CLIENT_ID)}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        return await res.json();
      } catch (e) { return { success: false, results: [] }; }
    },
    getPlaylistTracks: async (playlistId) => {
      try {
        const res = await fetch(`/api/playlist-tracks?id=${encodeURIComponent(playlistId)}&clientId=${encodeURIComponent(CLIENT_ID)}`, {
          headers: { 'X-Client-Id': CLIENT_ID }
        });
        return await res.json();
      } catch (e) { return { success: false, tracks: [] }; }
    },
    getAiMusicRecommendations: async (query, category, excludeTitles) => {
      try {
        const rawCountry = localStorage.getItem('papaleguas_music_country') || localStorage.getItem('papaleguas_selected_country') || 'BR';
        const country = (rawCountry && /^[A-Z]{2}$/i.test(rawCountry) && rawCountry.toUpperCase() !== 'AUTO') ? rawCountry.toUpperCase() : 'BR';
        const res = await fetch('/api/recommendations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': CLIENT_ID
          },
          body: JSON.stringify({ query, category, excludeTitles, clientId: CLIENT_ID, country })
        });
        return await res.json();
      } catch (e) { return { success: false, results: [] }; }
    },
    chatDjPapaleguas: async (userMessage, history, excludeTitles, trackCount) => {
      try {
        const rawCountry = localStorage.getItem('papaleguas_music_country') || localStorage.getItem('papaleguas_selected_country') || 'BR';
        const country = (rawCountry && /^[A-Z]{2}$/i.test(rawCountry) && rawCountry.toUpperCase() !== 'AUTO') ? rawCountry.toUpperCase() : 'BR';
        const res = await fetch('/api/dj-chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': CLIENT_ID
          },
          body: JSON.stringify({ userMessage, history, excludeTitles, trackCount, clientId: CLIENT_ID, country })
        });
        return await res.json();
      } catch (e) { return { success: false, reply: 'Erro de conexão no celular.', results: [] }; }
    },
    getFullAudioStream: async ({ title, artist }) => {
      try {
        const res = await fetch('/api/audio-stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': CLIENT_ID
          },
          body: JSON.stringify({ title, artist, clientId: CLIENT_ID })
        });
        return await res.json();
      } catch (e) { return { success: false }; }
    }
  };
}

const btnSpotify = document.getElementById('btn-spotify');
const spotifyModal = document.getElementById('spotify-modal');
const closeSpotifyModalBtn = document.getElementById('close-spotify-modal-btn');
const btnSpotifyOpenTab = document.getElementById('btn-spotify-open-tab');
const spotifySearchInput = document.getElementById('spotify-search-input');
const btnSpClear = document.getElementById('btn-sp-clear');
const spFilterChips = document.querySelectorAll('.sp-chip');
const spHeroCard = document.getElementById('sp-hero-card');
const spHeroImg = document.getElementById('sp-hero-img');
const spHeroTitle = document.getElementById('sp-hero-title');
const spHeroSub = document.getElementById('sp-hero-sub');
const spHeroPlayBtn = document.getElementById('sp-hero-play-btn');
const spTrackList = document.getElementById('sp-track-list');
const spScrollBody = document.getElementById('sp-scroll-body');
const spInfiniteLoader = document.getElementById('sp-infinite-loader');
const spInfiniteText = document.getElementById('sp-infinite-text');

// Barra inferior de reprodução
const spBottomPlayer = document.getElementById('sp-bottom-player');
const spMiniThumb = document.getElementById('sp-mini-thumb');
const spMiniTitle = document.getElementById('sp-mini-title');
const spMiniArtist = document.getElementById('sp-mini-artist');
const btnSpPlayPause = document.getElementById('btn-sp-play-pause');
const spMainPlayIcon = document.getElementById('sp-main-play-icon');
const btnSpPrev = document.getElementById('btn-sp-prev');
const btnSpNext = document.getElementById('btn-sp-next');
const btnSpShuffle = document.getElementById('btn-sp-shuffle');
const btnSpRepeat = document.getElementById('btn-sp-repeat');
const spotifyPreviewAudio = document.getElementById('spotify-preview-audio');

// Player Expandido (Tela Cheia / Tocando Agora)
const spExpandedPlayer = document.getElementById('sp-expanded-player');
const btnSpExpandedClose = document.getElementById('btn-sp-expanded-close');
const spExpandedBg = document.getElementById('sp-expanded-bg');
const spExpandedArt = document.getElementById('sp-expanded-art');
const spExpandedTitle = document.getElementById('sp-expanded-title');
const spExpandedArtist = document.getElementById('sp-expanded-artist');
const spExpandedFill = document.getElementById('sp-expanded-progress-fill');
const spExpandedThumb = document.getElementById('sp-expanded-progress-thumb');
const spExpandedTimeCur = document.getElementById('sp-expanded-time-cur');
const spExpandedTimeDur = document.getElementById('sp-expanded-time-dur');
const spExpandedProgressContainer = document.getElementById('sp-expanded-progress-bar-container');
const btnSpExpandedPlay = document.getElementById('btn-sp-expanded-play');
const spExpandedPlayIcon = document.getElementById('sp-expanded-play-icon');
const btnSpExpandedNext = document.getElementById('btn-sp-expanded-next');
const btnSpExpandedPrev = document.getElementById('btn-sp-expanded-prev');
const btnSpExpandedShuffle = document.getElementById('btn-sp-expanded-shuffle');
const btnSpExpandedRepeat = document.getElementById('btn-sp-expanded-repeat');

// ==========================================================================
// EQUALIZADOR PROFISSIONAL (4 bandas + curva de resposta ao vivo)
// ==========================================================================
const MUSIC_EQ_BANDS = [
  { key: 'bass', type: 'lowshelf', freq: 80, q: 0.9 },
  { key: 'mid', type: 'peaking', freq: 1000, q: 0.8 },
  { key: 'presence', type: 'peaking', freq: 3200, q: 1.0 },
  { key: 'treble', type: 'highshelf', freq: 9000, q: 0.9 }
];
const MUSIC_EQ_PRESETS = {
  flat: { label: 'Flat', bass: 0, mid: 0, presence: 0, treble: 0 },
  bass: { label: 'Grave', bass: 8, mid: -1, presence: 0, treble: -1 },
  deep: { label: 'Grave Profundo', bass: 11, mid: -2, presence: -1, treble: 1 },
  treble: { label: 'Agudo', bass: -2, mid: 0, presence: 3, treble: 7 },
  pop: { label: 'Pop', bass: 4, mid: 1, presence: 2, treble: 3 },
  rock: { label: 'Rock', bass: 5, mid: -2, presence: 3, treble: 4 },
  vocal: { label: 'Voz', bass: -3, mid: 3, presence: 4, treble: 1 },
  club: { label: 'Clube', bass: 9, mid: -1, presence: 1, treble: 3 }
};
let musicEqCtx = null;
let musicEqFilters = {};
let musicEqReady = false;
let musicEqState = { enabled: true, bass: 0, mid: 0, presence: 0, treble: 0 };

function clampEqGain(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.max(-12, Math.min(12, Math.round(n * 2) / 2));
}

function formatEqDb(value) {
  const n = clampEqGain(value);
  const text = (n > 0 ? '+' : '') + String(n).replace(/\.0$/, '');
  return text + ' dB';
}

function readSavedMusicEq() {
  try {
    const raw = JSON.parse(localStorage.getItem('papaleguas_music_eq') || '{}');
    const st = { enabled: raw.enabled !== false };
    MUSIC_EQ_BANDS.forEach((b) => { st[b.key] = clampEqGain(raw[b.key]); });
    return st;
  } catch (e) {
    return { enabled: true, bass: 0, mid: 0, presence: 0, treble: 0 };
  }
}

function buildEqChain(ctx) {
  const filters = {};
  let prev = null;
  MUSIC_EQ_BANDS.forEach((band) => {
    const f = ctx.createBiquadFilter();
    f.type = band.type;
    f.frequency.value = band.freq;
    f.Q.value = band.q;
    f.gain.value = 0;
    if (prev) prev.connect(f);
    prev = f;
    filters[band.key] = f;
  });
  return filters;
}

function ensureMusicEq() {
  if (musicEqReady || !spotifyPreviewAudio) return musicEqReady;
  // No celular o Web Audio API é suspenso em segundo plano, pausando a música.
  // Desativamos o EQ nativamente para mobiles manterem o áudio nativo rodando com a tela apagada.
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || ('ontouchstart' in window && window.innerWidth <= 768);
  if (isMobile) return false;
  
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return false;
  try {
    musicEqCtx = new AudioCtx();
    const source = musicEqCtx.createMediaElementSource(spotifyPreviewAudio);
    musicEqFilters = buildEqChain(musicEqCtx);
    source.connect(musicEqFilters[MUSIC_EQ_BANDS[0].key]);
    musicEqFilters[MUSIC_EQ_BANDS[MUSIC_EQ_BANDS.length - 1].key].connect(musicEqCtx.destination);
    musicEqReady = true;
    return true;
  } catch (e) {
    return false;
  }
}

function resumeMusicEqContext() {
  if (musicEqCtx && musicEqCtx.state === 'suspended') {
    musicEqCtx.resume().catch(() => {});
  }
}

function currentEqPresetKey() {
  const keys = Object.keys(MUSIC_EQ_PRESETS);
  for (let i = 0; i < keys.length; i++) {
    const p = MUSIC_EQ_PRESETS[keys[i]];
    if (MUSIC_EQ_BANDS.every((b) => clampEqGain(p[b.key]) === clampEqGain(musicEqState[b.key]))) return keys[i];
  }
  return '';
}

let eqCurveOffline = null;
let eqCurveFilters = null;
function drawMusicEqCurve() {
  const canvas = document.getElementById('sp-eq-curve');
  if (!canvas) return;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx2d.clearRect(0, 0, W, H);

  // Grade
  ctx2d.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx2d.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((f) => {
    ctx2d.beginPath();
    ctx2d.moveTo(0, Math.round(H * f) + 0.5);
    ctx2d.lineTo(W, Math.round(H * f) + 0.5);
    ctx2d.stroke();
  });
  ctx2d.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx2d.beginPath();
  ctx2d.moveTo(0, Math.round(H / 2) + 0.5);
  ctx2d.lineTo(W, Math.round(H / 2) + 0.5);
  ctx2d.stroke();

  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) return;
  try {
    if (!eqCurveOffline) {
      eqCurveOffline = new OfflineCtx(1, 128, 44100);
      eqCurveFilters = buildEqChain(eqCurveOffline);
    }
  } catch (e) {
    return;
  }
  const on = musicEqState.enabled;
  MUSIC_EQ_BANDS.forEach((b) => { eqCurveFilters[b.key].gain.value = on ? musicEqState[b.key] : 0; });

  const N = 160;
  const freqs = new Float32Array(N);
  const fMin = Math.log10(30);
  const fMax = Math.log10(20000);
  for (let i = 0; i < N; i++) freqs[i] = Math.pow(10, fMin + (fMax - fMin) * (i / (N - 1)));
  const total = new Float32Array(N);
  const mag = new Float32Array(N);
  const ph = new Float32Array(N);
  MUSIC_EQ_BANDS.forEach((b) => {
    eqCurveFilters[b.key].getFrequencyResponse(freqs, mag, ph);
    for (let i = 0; i < N; i++) total[i] += 20 * Math.log10(Math.max(mag[i], 1e-6));
  });

  const yOf = (db) => H / 2 - (Math.max(-14, Math.min(14, db)) / 14) * (H / 2 - 6);
  const pts = [];
  for (let i = 0; i < N; i++) pts.push([(i / (N - 1)) * W, yOf(total[i])]);

  const grad = ctx2d.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(30,215,96,0.45)');
  grad.addColorStop(0.5, 'rgba(30,215,96,0.08)');
  grad.addColorStop(1, 'rgba(56,189,248,0.35)');
  ctx2d.beginPath();
  ctx2d.moveTo(0, H / 2);
  pts.forEach((p) => ctx2d.lineTo(p[0], p[1]));
  ctx2d.lineTo(W, H / 2);
  ctx2d.closePath();
  ctx2d.fillStyle = grad;
  ctx2d.fill();

  ctx2d.beginPath();
  pts.forEach((p, i) => (i ? ctx2d.lineTo(p[0], p[1]) : ctx2d.moveTo(p[0], p[1])));
  ctx2d.lineWidth = 3;
  ctx2d.strokeStyle = on ? '#1ed760' : '#64748b';
  ctx2d.shadowColor = on ? 'rgba(30,215,96,0.7)' : 'transparent';
  ctx2d.shadowBlur = 10;
  ctx2d.stroke();
  ctx2d.shadowBlur = 0;

  // Marcadores das bandas
  MUSIC_EQ_BANDS.forEach((b) => {
    const x = ((Math.log10(b.freq) - fMin) / (fMax - fMin)) * W;
    const y = yOf(on ? musicEqState[b.key] : 0);
    ctx2d.beginPath();
    ctx2d.arc(x, y, 5, 0, Math.PI * 2);
    ctx2d.fillStyle = '#fff';
    ctx2d.fill();
    ctx2d.lineWidth = 2;
    ctx2d.strokeStyle = on ? '#1ed760' : '#94a3b8';
    ctx2d.stroke();
  });
}

function paintEqSlider(input, value) {
  const v = clampEqGain(value);
  const pct = ((v + 12) / 24) * 100;
  const a = Math.min(50, pct);
  const b = Math.max(50, pct);
  input.style.setProperty('--sp-fill-a', a + '%');
  input.style.setProperty('--sp-fill-b', b + '%');
}

function renderMusicEqUi() {
  const panel = document.getElementById('sp-eq-panel');
  const eqBtn = document.getElementById('btn-sp-eq');
  const power = document.getElementById('sp-eq-power');
  const status = document.getElementById('sp-eq-status');
  const on = musicEqState.enabled;
  MUSIC_EQ_BANDS.forEach((b) => {
    const input = document.getElementById('sp-eq-' + b.key);
    const label = document.getElementById('sp-eq-' + b.key + '-db');
    const v = musicEqState[b.key];
    if (input) {
      if (input.value !== String(v)) input.value = String(v);
      paintEqSlider(input, v);
    }
    if (label) {
      label.textContent = formatEqDb(v);
      label.classList.toggle('is-neg', v < 0);
      label.classList.toggle('is-zero', v === 0);
    }
  });
  const presetKey = currentEqPresetKey();
  document.querySelectorAll('#sp-eq-presets button').forEach((btn) => {
    btn.classList.toggle('is-on', on && btn.getAttribute('data-preset') === presetKey);
  });
  const anyGain = MUSIC_EQ_BANDS.some((b) => Math.abs(musicEqState[b.key]) > 0.01);
  if (status) {
    status.textContent = !on ? 'Desligado' : (presetKey ? MUSIC_EQ_PRESETS[presetKey].label : 'Personalizado');
  }
  if (power) {
    power.classList.toggle('is-on', on);
    power.innerHTML = '<span class="sp-eq-dot"></span>' + (on ? 'ON' : 'OFF');
  }
  if (panel) {
    panel.classList.toggle('is-off', !on);
    panel.dataset.ready = musicEqReady ? '1' : '0';
  }
  if (eqBtn) eqBtn.classList.toggle('is-active', on && anyGain);
  drawMusicEqCurve();
}

function applyMusicEq(next, persist) {
  if (next) {
    if (typeof next.enabled === 'boolean') musicEqState.enabled = next.enabled;
    MUSIC_EQ_BANDS.forEach((b) => {
      if (next[b.key] !== undefined) musicEqState[b.key] = clampEqGain(next[b.key]);
    });
  }
  const hasActiveEq = musicEqState.enabled && MUSIC_EQ_BANDS.some((b) => Math.abs(musicEqState[b.key]) > 0.1);
  if (hasActiveEq) {
    ensureMusicEq();
    resumeMusicEqContext();
  }
  if (musicEqReady && musicEqCtx) {
    const now = musicEqCtx.currentTime;
    MUSIC_EQ_BANDS.forEach((b) => {
      const f = musicEqFilters[b.key];
      if (!f) return;
      const target = musicEqState.enabled ? musicEqState[b.key] : 0;
      try { f.gain.setTargetAtTime(target, now, 0.03); } catch (e) { f.gain.value = target; }
    });
  }
  renderMusicEqUi();
  if (persist) {
    try { localStorage.setItem('papaleguas_music_eq', JSON.stringify(musicEqState)); } catch (e) {}
  }
}

function placeMusicEqPanel() {
  const panel = document.getElementById('sp-eq-panel');
  const player = document.getElementById('sp-bottom-player');
  if (!panel || !player) return;
  const pr = player.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 16);
  let left = pr.right - width;
  if (left < 8) left = 8;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
  const height = panel.offsetHeight || 330;
  const above = pr.top - 8 - height;
  panel.style.position = 'fixed';
  panel.style.width = width + 'px';
  panel.style.left = left + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  if (above >= 8) panel.style.top = above + 'px';
  else panel.style.top = Math.min(pr.bottom + 8, Math.max(8, window.innerHeight - height - 8)) + 'px';
}

function setMusicEqPanelOpen(open) {
  const btn = document.getElementById('btn-sp-eq');
  const player = document.getElementById('sp-bottom-player');
  const panel = document.getElementById('sp-eq-panel');
  if (!player || !panel) return;
  if (panel.parentElement !== document.body) document.body.appendChild(panel);
  player.classList.toggle('eq-open', open);
  panel.classList.toggle('is-open', open);
  if (btn) btn.classList.toggle('is-open', open);
  if (open) {
    placeMusicEqPanel();
    applyMusicEq(null, false);
    requestAnimationFrame(drawMusicEqCurve);
  }
}

function setupMusicEqualizer() {
  const btn = document.getElementById('btn-sp-eq');
  const player = document.getElementById('sp-bottom-player');
  const panel = document.getElementById('sp-eq-panel');
  if (!btn || !player || !panel) return;
  musicEqState = readSavedMusicEq();
  renderMusicEqUi();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMusicEqPanelOpen(!panel.classList.contains('is-open'));
  });
  window.addEventListener('resize', () => {
    if (panel.classList.contains('is-open')) placeMusicEqPanel();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!panel.classList.contains('is-open')) return;
    if (e.target.closest('#sp-eq-panel') || e.target.closest('#btn-sp-eq')) return;
    setMusicEqPanelOpen(false);
  });

  MUSIC_EQ_BANDS.forEach((b) => {
    const input = document.getElementById('sp-eq-' + b.key);
    if (!input) return;
    input.addEventListener('input', () => {
      const patch = {};
      patch[b.key] = input.value;
      if (!musicEqState.enabled) patch.enabled = true;
      applyMusicEq(patch, true);
    });
    input.addEventListener('dblclick', () => {
      const patch = {};
      patch[b.key] = 0;
      applyMusicEq(patch, true);
    });
  });

  const power = document.getElementById('sp-eq-power');
  if (power) {
    power.addEventListener('click', (e) => {
      e.stopPropagation();
      applyMusicEq({ enabled: !musicEqState.enabled }, true);
    });
  }
  const reset = document.getElementById('sp-eq-reset');
  if (reset) {
    reset.addEventListener('click', (e) => {
      e.stopPropagation();
      applyMusicEq({ enabled: true, bass: 0, mid: 0, presence: 0, treble: 0 }, true);
    });
  }
  document.querySelectorAll('#sp-eq-presets button').forEach((preset) => {
    preset.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = MUSIC_EQ_PRESETS[preset.getAttribute('data-preset')];
      if (!p) return;
      applyMusicEq({ enabled: true, bass: p.bass, mid: p.mid, presence: p.presence, treble: p.treble }, true);
    });
  });

  // Equalizador só é ativado se o usuário explicitamente abrir e ajustar o painel,
  // preservando a reprodução direta nativa de alta estabilidade e sem perda de pacotes.
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => {
    document.addEventListener(ev, resumeMusicEqContext, { passive: true });
  });
}

setupMusicEqualizer();

const spPlayerProgressBar = document.getElementById('sp-player-progress-bar');
const spPlayerProgressContainer = document.getElementById('sp-player-progress-container');
const spPlayerProgressThumb = document.getElementById('sp-player-progress-thumb');
const spPlayerProgressTooltip = document.getElementById('sp-player-progress-tooltip');
const spMiniCurTime = document.getElementById('sp-mini-cur-time');
const spMiniDurTime = document.getElementById('sp-mini-dur-time');
const spMiniProgressPill = document.getElementById('sp-mini-progress-pill');
const spMiniBubbleBadge = document.getElementById('sp-mini-bubble-badge');

function formatTime(seconds) {
  if (isNaN(seconds) || seconds === Infinity || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

let currentTracksList = [];
window.playingTracksList = null;
window.playingPlaylistName = "";
let currentTrackIndex = 0;
let isShuffle = false;
let isRepeat = false;
let isCrossfading = false;
let musicFadeInterval = null;
let currentPlaybackSessionId = 0;

// Estado de Paginação e Rolagem Infinita por Gênero
let currentInfiniteQuery = 'top brasil';
let currentInfiniteCategory = 'all';
let currentInfiniteOffset = 30;
let isInfiniteLoading = false;
let hasInfiniteMore = true;

// Histórico de músicas já tocadas ou listadas nesta sessão para evitar repetições
const allSessionPlayedTrackTitles = new Set();

function registerSessionTracks(tracks) {
  if (!tracks || !Array.isArray(tracks)) return;
  tracks.forEach(t => {
    if (t && t.title) {
      allSessionPlayedTrackTitles.add(t.title.trim().toLowerCase());
    }
  });
}

function getSessionExcludeTitles() {
  const actList = window.playingTracksList || currentTracksList || [];
  const currentTitles = actList.map(t => t.title).filter(Boolean);
  const historicTitles = Array.from(allSessionPlayedTrackTitles);
  const combined = Array.from(new Set([...historicTitles, ...currentTitles]));
  return combined.slice(-35);
}

let mediaSessionHandlersBound = false;
let lastMediaSessionTrackKey = '';

function bindMediaSessionHandlers() {
  if (mediaSessionHandlersBound || !('mediaSession' in navigator)) return;
  mediaSessionHandlersBound = true;
  const safeSet = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) {}
  };
  safeSet('play', () => {
    window.isUserIntentionallyPaused = false;
    if (spotifyPreviewAudio) {
      spotifyPreviewAudio.play().catch(() => {});
    }
  });
  safeSet('pause', () => {
    window.isUserIntentionallyPaused = true;
    if (spotifyPreviewAudio) spotifyPreviewAudio.pause();
  });
  safeSet('stop', () => {
    window.isUserIntentionallyPaused = true;
    if (spotifyPreviewAudio) spotifyPreviewAudio.pause();
  });
  safeSet('previoustrack', () => playPrevTrack());
  safeSet('nexttrack', () => playNextTrack());
  safeSet('seekto', (details) => {
    if (spotifyPreviewAudio && details && typeof details.seekTime === 'number' && isFinite(details.seekTime)) {
      spotifyPreviewAudio.currentTime = details.seekTime;
      syncMediaSessionPosition(true);
    }
  });
  safeSet('seekforward', (details) => {
    if (spotifyPreviewAudio) {
      spotifyPreviewAudio.currentTime = Math.min(spotifyPreviewAudio.duration || Infinity, spotifyPreviewAudio.currentTime + ((details && details.seekOffset) || 10));
      syncMediaSessionPosition(true);
    }
  });
  safeSet('seekbackward', (details) => {
    if (spotifyPreviewAudio) {
      spotifyPreviewAudio.currentTime = Math.max(0, spotifyPreviewAudio.currentTime - ((details && details.seekOffset) || 10));
      syncMediaSessionPosition(true);
    }
  });
}

try { bindMediaSessionHandlers(); } catch (e) {}

function parseDurationSeconds(raw) {
  if (typeof raw === 'number' && isFinite(raw) && raw > 0) {
    return raw > 100000 ? raw / 1000 : raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const clean = raw.trim();
    if (clean.includes(':')) {
      const parts = clean.split(':').map(Number);
      if (parts.every(n => !isNaN(n))) {
        return parts.reduce((acc, p) => acc * 60 + p, 0);
      }
    }
    const num = Number(clean);
    if (!isNaN(num) && num > 0) {
      return num > 100000 ? num / 1000 : num;
    }
  }
  return 0;
}

// Duração utilizável: a do <audio> quando válida; senão a da faixa (streams do
// YouTube costumam reportar NaN/Infinity, o que escondia a barra de progresso).
function getEffectiveDuration() {
  const d = spotifyPreviewAudio ? spotifyPreviewAudio.duration : 0;
  if (d && isFinite(d) && d > 0) return d;
  const list = window.playingTracksList || currentTracksList;
  const t = list && list[currentTrackIndex];
  if (t) {
    const parsed = parseDurationSeconds(t.duration || t.duration_string || t.length);
    if (parsed > 0) return parsed;
  }
  return 0;
}

const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

function syncMediaSessionPosition() {
  if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function' || !spotifyPreviewAudio) return;
  const dur = getEffectiveDuration();
  if (!dur || dur <= 0) return;
  const rate = spotifyPreviewAudio.playbackRate || 1;
  const pos = Math.min(dur, Math.max(0, spotifyPreviewAudio.currentTime || 0));
  try {
    navigator.mediaSession.setPositionState({
      duration: dur,
      playbackRate: rate,
      position: pos
    });
  } catch (e) {}
}

// Remove os controles da central de notificações (usado ao sair do app ou fechar o player)
function clearMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.metadata = null;
    lastMediaSessionTrackKey = '';
  } catch (e) {}
}

function updateMediaSession(track, isPlaying) {
  if (!('mediaSession' in navigator) || !track) return;
  try {
    bindMediaSessionHandlers();
    // Só recria os metadados quando a faixa muda; recriar a cada tick faz a
    // notificação do Android piscar/travar.
    const key = [track.id || '', track.title || '', track.artist || '', track.cover || ''].join('|');
    if (key !== lastMediaSessionTrackKey) {
      lastMediaSessionTrackKey = key;
      const art = track.cover || 'papaleguas_logo.png';
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'Papaléguas Music',
        artist: track.artist || 'Papaléguas',
        album: 'Papaléguas Player',
        artwork: [
          { src: art, sizes: '96x96', type: 'image/png' },
          { src: art, sizes: '128x128', type: 'image/png' },
          { src: art, sizes: '192x192', type: 'image/png' },
          { src: art, sizes: '256x256', type: 'image/png' },
          { src: art, sizes: '512x512', type: 'image/png' }
        ]
      });
    }
    if (navigator.mediaSession.playbackState !== (isPlaying ? 'playing' : 'paused')) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
    syncMediaSessionPosition(true);
  } catch (e) {
    console.warn('MediaSession error:', e);
  }
}

function updateBottomPlayerState(isPlaying) {
  const actList = window.playingTracksList || currentTracksList;
    const track = actList && actList[currentTrackIndex];
  if (spMainPlayIcon) {
    if (isPlaying) {
      spMainPlayIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
      if (spExpandedPlayIcon) spExpandedPlayIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
      spMainPlayIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
      if (spExpandedPlayIcon) spExpandedPlayIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    }
  }
  if (spHeroPlayBtn) {
    if (isPlaying) {
      spHeroPlayBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    } else {
      spHeroPlayBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }
  }
  if (spHeroSub && track) {
    spHeroSub.innerHTML = isPlaying 
      ? `<span>▶ Tocando agora • ${track.artist || ''}</span>`
      : `<span>⏸ Pausado • ${track.artist || ''}</span>`;
  }
  if (spBottomPlayer) {
    if (isPlaying) {
      spBottomPlayer.classList.remove('is-paused');
    } else {
      spBottomPlayer.classList.add('is-paused');
    }
  }
  if (isPlaying) {
    setMusicLoading(false);
    document.querySelectorAll('.sp-track-row.is-loading').forEach(r => r.classList.remove('is-loading'));
  }
  updateMediaSession(track, isPlaying);
  syncDjPictureInPicture();
  if (typeof broadcastMusicState === 'function') {
    broadcastMusicState();
  }
}

async function playTrackAtIndex(index, fromUserClick = true) {
  window.isUserIntentionallyPaused = false;
  if (typeof stopModalPreview === 'function') { stopModalPreview(); }
  document.body.classList.remove('is-editing-playlist');
  
  if (fromUserClick) {
    window.playingTracksList = [...(currentTracksList || [])];
    const spInput = document.getElementById('spotify-search-input');
    window.playingPlaylistName = selectedPlaylistName || (spInput && spInput.value ? spInput.value : 'Sua Busca');
  }

  const actList = window.playingTracksList || currentTracksList;
  if (!actList || actList.length === 0) return;
  if (index < 0) index = 0;
  if (index >= actList.length) {
    if (isCurrentListFromDj) {
      index = isRepeat ? 0 : actList.length - 1;
    } else {
      const moreTracks = await fetchMoreAiRecommendations();
      if (!moreTracks || moreTracks.length === 0) {
        index = actList.length - 1;
      }
    }
  }

  currentTrackIndex = index;
  const track = actList[currentTrackIndex];
  if (!track) return;
  const sessionId = ++currentPlaybackSessionId;
  isCrossfading = false;
  if (musicFadeInterval) {
    clearInterval(musicFadeInterval);
    musicFadeInterval = null;
  }

  if (spMiniThumb) {
    const thumbFallback = spMiniThumb.getAttribute('data-fallback') || '';
    spMiniThumb.onerror = () => {
      if (!thumbFallback || String(spMiniThumb.src).indexOf('data:image/svg') === 0) return;
      spMiniThumb.src = thumbFallback;
    };
    spMiniThumb.src = track.cover || thumbFallback;
    if (spExpandedArt) spExpandedArt.src = track.cover || thumbFallback;
    if (spExpandedBg) spExpandedBg.style.backgroundImage = `url("${track.cover || thumbFallback}")`;
  }
  if (spMiniTitle) spMiniTitle.textContent = track.title;
  if (spExpandedTitle) spExpandedTitle.textContent = track.title;
  if (spMiniArtist) spMiniArtist.textContent = window.playingPlaylistName ? track.artist + " • " + window.playingPlaylistName : track.artist;
  if (spExpandedArtist) spExpandedArtist.textContent = window.playingPlaylistName ? track.artist + " • " + window.playingPlaylistName : track.artist;

  // Reseta barra de progresso e indicadores de tempo para a nova faixa
  const initTrackSec = parseDurationSeconds(track.duration || track.duration_string || track.length);
  const durFormatted = initTrackSec > 0 ? formatTime(initTrackSec) : '--:--';
  if (spPlayerProgressBar) spPlayerProgressBar.style.width = '0%';
  if (spBottomPlayer) spBottomPlayer.style.setProperty('--sp-progress-pct', '0%');
  if (spMiniCurTime) spMiniCurTime.textContent = '0:00';
  if (spMiniDurTime) spMiniDurTime.textContent = durFormatted;
  if (spMiniBubbleBadge) spMiniBubbleBadge.textContent = '0:00';
  if (spExpandedFill) spExpandedFill.style.width = '0%';
  if (spExpandedThumb) spExpandedThumb.style.left = '0%';
  if (spExpandedTimeCur) spExpandedTimeCur.textContent = '0:00';
  if (spExpandedTimeDur) spExpandedTimeDur.textContent = durFormatted;

  // Sincroniza o Mini Player de Destaque no topo da tela
  if (spHeroImg && track.cover) spHeroImg.src = track.cover;
  if (spHeroTitle && track.title) spHeroTitle.textContent = track.title;
  if (spHeroSub && track.artist) spHeroSub.innerHTML = `<span>▶ Tocando agora • ${track.artist}</span>`;
  if (spHeroPlayBtn) {
    spHeroPlayBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  }

  // Destaque visual na lista com loading imediato
  document.querySelectorAll('.sp-track-row').forEach(row => {
    if (row.getAttribute('data-id') == track.id) {
      row.classList.add('playing');
      row.classList.add('is-loading');
    } else {
      row.classList.remove('playing');
      row.classList.remove('is-loading');
    }
  });

  // Sincroniza automaticamente a nova música com a Smart TV se estiver conectada
  if (typeof syncPlaybackWithConnectedTv === 'function') {
    syncPlaybackWithConnectedTv(`${track.title} ${track.artist}`);
  }

  if (!spotifyPreviewAudio) return;

  // Restaura o volume normal caso estivesse em fade
  spotifyPreviewAudio.volume = 1.0;

  // Garante que a barra do Mini Player apareça imediatamente
  if (spBottomPlayer) spBottomPlayer.classList.add('visible');

  // Garante a URL da stream de áudio completa via servidor
  const fullUrl = resolveMediaUrl(track.fullStreamUrl || `/api/stream-audio?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist)}`);
  track.fullStreamUrl = fullUrl;

  if (spMiniBubbleBadge) spMiniBubbleBadge.textContent = 'Carregando música...';
  setMusicLoading(true);

  const stopLoadingIfCurrent = () => {
    if (sessionId !== currentPlaybackSessionId) return;
    setMusicLoading(false);
  };

  // 1. Tenta carregar URL de áudio offline do cache síncrono imediatamente
  const key = offlineTrackKey(track);
  const syncOffline = key && offlineUrlCache.get(key);
  const initialSrc = resolveMediaUrl(syncOffline || fullUrl);

  spotifyPreviewAudio.src = initialSrc;
  spotifyPreviewAudio.currentTime = 0;

  // Inicia reprodução síncrona dentro do evento de toque/clique do usuário (essencial no celular)
  const p = spotifyPreviewAudio.play();
  if (p !== undefined) {
    p.then(() => {
      if (sessionId !== currentPlaybackSessionId) return;
      stopLoadingIfCurrent();
      updateBottomPlayerState(true);
    }).catch((err) => {
      console.warn('Início de reprodução aguardando buffer:', err);
    });
  }

  const onReady = () => {
    if (sessionId !== currentPlaybackSessionId) return;
    stopLoadingIfCurrent();
    updateBottomPlayerState(true);
    preloadNextTrackStream(currentTrackIndex + 1);
  };

  if (spotifyPreviewAudio.readyState >= 2) onReady();
  else spotifyPreviewAudio.addEventListener('canplay', onReady, { once: true });

  // 2. Em paralelo, se não estava no cache síncrono, checa se tem no disco ou indexedDB
  if (!syncOffline) {
    getOfflineTrackUrl(track).then((asyncOffline) => {
      if (sessionId !== currentPlaybackSessionId) return;
      if (asyncOffline && asyncOffline !== spotifyPreviewAudio.src) {
        // Só substitui a URL do player se for um Blob local (offline puro) ou se a URL atual falhou
        if (asyncOffline.startsWith('blob:') || !spotifyPreviewAudio.src || spotifyPreviewAudio.error) {
          const curTime = spotifyPreviewAudio.currentTime || 0;
          spotifyPreviewAudio.src = asyncOffline;
          spotifyPreviewAudio.currentTime = curTime;
          spotifyPreviewAudio.play().catch(() => {});
        }
      }
    }).catch(() => {});
    prewarmPlaylistOnServer(currentTracksList.slice(currentTrackIndex, currentTrackIndex + 8));
  }
}

// ----------------------------------------------------
// PLAYLIST BAIXADA NO APARELHO (ouvir sem esperar a busca)
// ----------------------------------------------------
const OFFLINE_DB_NAME = 'papaleguas_music_offline';
const OFFLINE_STORE = 'tracks';
const FAVORITE_STORE = 'playlists';

function offlineTrackKey(track) {
  if (!track) return '';
  const title = String(track.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const artist = String(track.artist || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${title} - ${artist}`;
}

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('sem IndexedDB'));
    const req = indexedDB.open(OFFLINE_DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) db.createObjectStore(OFFLINE_STORE);
      if (!db.objectStoreNames.contains(FAVORITE_STORE)) db.createObjectStore(FAVORITE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('falha ao abrir base local'));
  });
}

async function readOfflineTrack(track) {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(OFFLINE_STORE, 'readonly');
      const get = tx.objectStore(OFFLINE_STORE).get(offlineTrackKey(track));
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function blobToDataUrl(blob) {
  if (!blob) return '';
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result || '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(blob);
  });
}

async function fetchCoverAsBlobAndDataUrl(coverUrl) {
  if (!coverUrl || coverUrl.includes('papaleguas_logo')) return null;
  try {
    const fetchUrl = (coverUrl.startsWith('http://') || coverUrl.startsWith('https://'))
      ? (coverUrl.includes('dzcdn.net') ? `/api/cover?u=${encodeURIComponent(coverUrl)}` : coverUrl)
      : coverUrl;
    let res = await fetch(fetchUrl).catch(() => null);
    if (!res || !res.ok) {
      if (fetchUrl !== coverUrl) res = await fetch(coverUrl).catch(() => null);
    }
    if (!res || !res.ok) return null;
    const blob = await res.blob();
    if (!blob || blob.size < 80) return null;
    const dataUrl = await blobToDataUrl(blob);
    const data = new Uint8Array(await blob.arrayBuffer());
    return { blob, dataUrl, data, mime: blob.type || 'image/jpeg' };
  } catch (e) {
    return null;
  }
}

async function saveOfflineTrack(track, blob) {
  try {
    const db = await openOfflineDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).put({
        title: track.title,
        artist: track.artist,
        cover: track.coverDataUrl || track.cover || '',
        blob,
        savedAt: Date.now()
      }, offlineTrackKey(track));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (e) {
    return false;
  }
}

const offlineUrlCache = new Map();

async function getOfflineTrackUrl(track) {
  if (!track) return '';
  const key = offlineTrackKey(track);
  if (key && offlineUrlCache.has(key)) return offlineUrlCache.get(key);
  if (track.blob instanceof Blob) {
    const url = URL.createObjectURL(track.blob);
    if (key) offlineUrlCache.set(key, url);
    return url;
  }
  const saved = await readOfflineTrack(track);
  if (saved && saved.blob) {
    const url = URL.createObjectURL(saved.blob);
    if (key) offlineUrlCache.set(key, url);
    return url;
  }
  const playlistName = track && (track.playlistName || track.playlistFolder);
  const fileName = track && track.file;
  if (playlistName && fileName && window.torBrowserAPI && typeof window.torBrowserAPI.readFavoriteTrack === 'function') {
    try {
      const res = await window.torBrowserAPI.readFavoriteTrack(playlistName, fileName);
      let bytes = res && res.data;
      if (bytes && bytes.type === 'Buffer' && Array.isArray(bytes.data)) bytes = new Uint8Array(bytes.data);
      if (res && res.success && bytes) {
        const blob = new Blob([bytes], { type: res.mime || 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        if (key) offlineUrlCache.set(key, url);
        return url;
      }
    } catch (e) {}
  }

  // Suporte a streaming local de músicas baixadas via servidor HTTP
  if (track && track.fullStreamUrl && track.fullStreamUrl.includes('/api/downloaded-track-file')) {
    return resolveMediaUrl(track.fullStreamUrl);
  }
  if (playlistName && fileName) {
    return resolveMediaUrl(`/api/downloaded-track-file?folder=${encodeURIComponent(playlistName)}&file=${encodeURIComponent(fileName)}&clientId=${encodeURIComponent(CLIENT_ID)}`);
  }

  return '';
}

function favoritePlaylistKey(name) {
  return CLIENT_ID + '::' + String(name || '').trim().toLowerCase();
}

async function saveFavoritePlaylistRecord(name, tracks, cover = '') {
  try {
    const db = await openOfflineDb();
    const resolvedCover = cover || (tracks && tracks[0] && (tracks[0].coverDataUrl || tracks[0].cover)) || '';
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FAVORITE_STORE, 'readwrite');
      tx.objectStore(FAVORITE_STORE).put({
        name: String(name || 'Playlist').trim(),
        cover: resolvedCover,
        savedAt: Date.now(),
        clientId: CLIENT_ID,
        tracks: (tracks || []).map((track) => ({
          title: track.title,
          artist: track.artist,
          cover: track.coverDataUrl || track.cover || '',
          file: track.file || '',
          blob: track.blob || null
        }))
      }, favoritePlaylistKey(name));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function listFavoritePlaylistRecords() {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(FAVORITE_STORE, 'readonly');
      const get = tx.objectStore(FAVORITE_STORE).getAll();
      get.onsuccess = () => {
        const all = get.result || [];
        const filtered = all.filter(item => {
          if (!item) return false;
          return item.clientId === CLIENT_ID || (!item.clientId && CLIENT_ID === 'desktop_host');
        });
        resolve(filtered);
      };
      get.onerror = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
}

async function readFavoritePlaylistRecord(name) {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(FAVORITE_STORE, 'readonly');
      const get = tx.objectStore(FAVORITE_STORE).get(favoritePlaylistKey(name));
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function deleteFavoritePlaylistRecord(name) {
  try {
    const db = await openOfflineDb();
    const targetName = String(name || '').trim().toLowerCase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FAVORITE_STORE, 'readwrite');
      const store = tx.objectStore(FAVORITE_STORE);
      // Deleta pela chave direta
      store.delete(favoritePlaylistKey(name));
      store.delete(name);
      // Percorre o store para garantir remoção de qualquer chave antiga/legada
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const val = cursor.value;
          const k = String(cursor.key || '').toLowerCase();
          const n = String((val && val.name) || '').trim().toLowerCase();
          if (n === targetName || k.endsWith('::' + targetName) || k === targetName) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function removeOfflineTracksForPlaylist(name) {
  try {
    const db = await openOfflineDb();
    const tracks = await listAllOfflineTracks();
    if (!tracks || !tracks.length) return true;
    const targetName = String(name || '').trim().toLowerCase();
    const toDelete = tracks.filter(t => {
      const pl = String((t && (t.playlistName || t.playlistFolder)) || '').trim().toLowerCase();
      return pl === targetName || targetName === 'músicas baixadas' || targetName === 'musicas baixadas';
    });
    if (!toDelete.length) return true;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(OFFLINE_STORE, 'readwrite');
      const store = tx.objectStore(OFFLINE_STORE);
      toDelete.forEach(t => {
        try { store.delete(offlineTrackKey(t)); } catch (e) {}
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function restoreAndSyncPlaylistsOnStartup() {
  try {
    // 1. Reconcilia e carrega todas as playlists e músicas salvas no disco/Downloads e no IndexedDB
    const data = await collectFavoritePlaylists();
    const btnFav = document.getElementById('btn-sp-favorites');
    const count = (data && data.playlists) ? data.playlists.length : 0;
    if (btnFav) {
      btnFav.textContent = count > 0 ? `📁 Playlists (${count}) ▾` : '📁 Playlists ▾';
    }

    // 2. Se o disco/servidor retornou playlists com tracks e ainda não estão no IndexedDB,
    // sincroniza os manifestos para que continuem disponíveis e prontas para tocar
    if (data && Array.isArray(data.playlists)) {
      for (const pl of data.playlists) {
        if (!pl || !pl.name) continue;
        const localRec = await readFavoritePlaylistRecord(pl.name);
        if (!localRec) {
          await saveFavoritePlaylistRecord(pl.name, [], pl.cover || '');
        }
      }
    }
  } catch (err) {
    console.warn('Erro ao restaurar playlists e downloads na inicialização:', err);
  }
}

async function deleteFavoriteTrackFromRecord(playlistName, trackTitle, trackArtist, trackFile) {
  try {
    const rec = await readFavoritePlaylistRecord(playlistName);
    if (!rec || !Array.isArray(rec.tracks)) return false;
    rec.tracks = rec.tracks.filter(t => {
      if (trackFile && t.file && t.file === trackFile) return false;
      if (t.title === trackTitle && (!trackArtist || t.artist === trackArtist)) return false;
      return true;
    });
    rec.savedAt = Date.now();
    const db = await openOfflineDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FAVORITE_STORE, 'readwrite');
      tx.objectStore(FAVORITE_STORE).put(rec, favoritePlaylistKey(playlistName));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (e) {
    return false;
  }
}

let selectedPlaylistName = '';
let isCurrentPlaylistFavorite = false;
let selectedPlaylistSource = 'device';

function showSelectedPlaylist(name, isFavorite = false, source = 'device') {
  selectedPlaylistName = String(name || '').trim();
  isCurrentPlaylistFavorite = !!isFavorite;
  selectedPlaylistSource = source || 'device';
  const bar = document.getElementById('sp-offline-bar');
  const plBar = document.getElementById('sp-selected-playlist-bar');
  const nameEl = document.getElementById('sp-selected-playlist-name');
  const btn = document.getElementById('btn-sp-download-playlist');
  const btnAddRelated = document.getElementById('btn-sp-add-related');
  const btnDeletePl = document.getElementById('btn-sp-delete-current-pl');
  const btnRenamePl = document.getElementById('btn-sp-rename-current-pl');
  const btnCoverPl = document.getElementById('btn-sp-cover-current-pl');
  if (bar) bar.hidden = true;
  if (!selectedPlaylistName) {
    if (plBar) plBar.hidden = true;
    if (nameEl) {
      nameEl.hidden = true;
      nameEl.textContent = '';
    }
    if (btn) btn.hidden = true;
    if (btnAddRelated) btnAddRelated.hidden = true;
    if (btnDeletePl) btnDeletePl.hidden = true;
    if (btnRenamePl) btnRenamePl.hidden = true;
    if (btnCoverPl) btnCoverPl.hidden = true;
    return;
  }
  if (plBar) plBar.hidden = false;
  if (nameEl) {
    nameEl.hidden = false;
    nameEl.textContent = selectedPlaylistName + (isFavorite ? ' (Favorita)' : '');
  }
  if (btn) {
    btn.hidden = false;
    btn.textContent = downloadButtonLabel();
    btn.title = selectedPlaylistName ? `Baixar todas as músicas da playlist "${selectedPlaylistName}" no aparelho com o álbum` : 'Baixar todas as músicas desta playlist no aparelho';
  }
  if (btnAddRelated) {
    btnAddRelated.hidden = !isFavorite;
  }
  if (btnDeletePl) {
    btnDeletePl.hidden = !isFavorite;
  }
  if (btnRenamePl) {
    btnRenamePl.hidden = !isFavorite;
  }
  if (btnCoverPl) {
    btnCoverPl.hidden = !isFavorite;
  }
}

let musicLoadingSpinToken = 0;

function setMusicLoading(active) {
  const runner = document.getElementById('sp-runner');
  musicLoadingSpinToken++;
  const token = musicLoadingSpinToken;
  if (runner) {
    if (active) runner.classList.add('is-loading');
    else runner.classList.remove('is-loading');
  }
  if (spMiniBubbleBadge && active) spMiniBubbleBadge.textContent = 'Carregando música...';

  if (btnSpPlayPause) {
    if (active) btnSpPlayPause.classList.add('is-loading');
    else btnSpPlayPause.classList.remove('is-loading');
  }
  if (spHeroPlayBtn) {
    if (active) spHeroPlayBtn.classList.add('is-loading');
    else spHeroPlayBtn.classList.remove('is-loading');
  }

  if (!active) {
    document.querySelectorAll('.sp-track-row.is-loading').forEach(r => r.classList.remove('is-loading'));
  }
}

let downloadNoticeTimer = null;
function showDownloadNotice(text) {
  const el = document.getElementById('sp-download-notice');
  if (!el) return;
  if (downloadNoticeTimer) {
    clearTimeout(downloadNoticeTimer);
    downloadNoticeTimer = null;
  }
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
  downloadNoticeTimer = setTimeout(() => {
    el.hidden = true;
    el.textContent = '';
  }, 3200);
}

const downloadQueue = [];
let downloadBusy = false;

function queuePlaylistDownload() {
  const source = djPlaylistCap > 0 ? (currentTracksList || []).slice(0, djPlaylistCap) : (currentTracksList || []);
  const list = source.filter((t) => t && t.title);
  if (list.length === 0) return;
  const name = selectedPlaylistName || 'Playlist';
  downloadQueue.push({ name, list });
  if (downloadBusy) {
    showDownloadNotice('Já tem uma playlist sendo baixada. "' + name + '" entrou na fila, posição ' + downloadQueue.length + '.');
    return;
  }
  runDownloadQueue();
}

async function runDownloadQueue() {
  downloadBusy = true;
  while (downloadQueue.length) {
    const job = downloadQueue.shift();
    const waiting = downloadQueue.map((item) => item.name);
    showDownloadNotice(waiting.length
      ? 'Baixando "' + job.name + '". Na fila: ' + waiting.join(', ') + '.'
      : '');
    await downloadOnePlaylist(job.name, job.list);
  }
  downloadBusy = false;
  showDownloadNotice('');
}

function safeDownloadName(value, fallback) {
  const clean = String(value || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || fallback).slice(0, 80);
}

function audioExtension(blob) {
  const type = String(blob && blob.type || '').toLowerCase();
  if (type.indexOf('mpeg') !== -1 || type.indexOf('mp3') !== -1) return 'mp3';
  if (type.indexOf('mp4') !== -1 || type.indexOf('m4a') !== -1) return 'm4a';
  if (type.indexOf('ogg') !== -1) return 'ogg';
  if (type.indexOf('wav') !== -1) return 'wav';
  return 'webm';
}

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function zipCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoredZip(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = zipCrc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, data);
    const head = new Uint8Array(46 + nameBytes.length);
    const headView = new DataView(head.buffer);
    headView.setUint32(0, 0x02014b50, true);
    headView.setUint16(4, 20, true);
    headView.setUint16(6, 20, true);
    headView.setUint32(16, crc, true);
    headView.setUint32(20, data.length, true);
    headView.setUint32(24, data.length, true);
    headView.setUint16(28, nameBytes.length, true);
    headView.setUint32(42, offset, true);
    head.set(nameBytes, 46);
    central.push(head);
    offset += local.length + data.length;
  });
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const blobParts = parts.concat(central, [end]);
  return new Blob(blobParts, { type: 'application/zip' });
}

function saveFileForUser(blob, filename) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 2500);
}

function canSaveFavoriteOnDisk() {
  return !!(window.torBrowserAPI && window.torBrowserAPI.isElectron && typeof window.torBrowserAPI.saveFavoriteTrack === 'function');
}

let lastDownloadedPlaylistName = '';
let vibrateClearTimer = null;

async function triggerPlaylistDownloadedVibration(name) {
  lastDownloadedPlaylistName = name || '';

  // 1. Vibração física háptica no dispositivo móvel
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([70, 50, 90, 50, 140]);
    } catch (e) {}
  }

  // 2. Atualiza imediatamente o botão de Playlists no topo e faz vibrar com pulso verde
  try {
    const data = await collectFavoritePlaylists().catch(() => ({ playlists: [] }));
    const btnFav = document.getElementById('btn-sp-favorites');
    if (btnFav) {
      const count = (data && data.playlists) ? data.playlists.length : 0;
      btnFav.textContent = count > 0 ? `📁 Playlists (${count}) ▾` : '📁 Playlists ▾';
      btnFav.classList.remove('sp-vibrate-pulse');
      void btnFav.offsetWidth;
      btnFav.classList.add('sp-vibrate-pulse');
      setTimeout(() => {
        btnFav.classList.remove('sp-vibrate-pulse');
      }, 2500);
    }
  } catch (e) {}

  // 3. Atualiza o painel de favoritos
  await refreshFavoritesPanel(false);

  // 4. Faz o card da playlist tremer/vibrar na tela em destaque
  const favItems = document.querySelectorAll('.sp-fav-item');
  favItems.forEach((item) => {
    const itemName = item.getAttribute('data-fav-item-name');
    if (itemName && itemName.toLowerCase() === String(name || '').toLowerCase()) {
      item.classList.remove('just-downloaded');
      void item.offsetWidth;
      item.classList.add('just-downloaded');
      setTimeout(() => {
        item.classList.remove('just-downloaded');
      }, 3200);
    }
  });

  if (vibrateClearTimer) clearTimeout(vibrateClearTimer);
  vibrateClearTimer = setTimeout(() => {
    lastDownloadedPlaylistName = '';
  }, 6000);
}

async function downloadOnePlaylist(name, list) {
  const btn = document.getElementById('btn-sp-download-playlist');
  const setLabel = (text) => { if (btn) btn.textContent = text; };
  if (btn) btn.disabled = true;
  setDownloadProgress(0, list.length);

  const files = [];
  const savedTracks = [];
  const usedNames = new Set();
  const saveOnDisk = canSaveFavoriteOnDisk();
  let diskFolder = '';
  for (let i = 0; i < list.length; i++) {
    const track = list[i];
    setLabel('Baixando "' + name + '" ' + (i + 1) + '/' + list.length);
    const url = track.fullStreamUrl || `/api/stream-audio?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('sem audio');
      const blob = await res.blob();
      if (!blob || blob.size < 40000) throw new Error('audio curto');
      const ext = audioExtension(blob);
      let fileName = String(i + 1).padStart(2, '0') + ' - ' + safeDownloadName(track.artist, 'Artista') + ' - ' + safeDownloadName(track.title, 'Faixa') + '.' + ext;
      while (usedNames.has(fileName.toLowerCase())) fileName = String(i + 1) + '-' + fileName;
      usedNames.add(fileName.toLowerCase());
      const data = new Uint8Array(await blob.arrayBuffer());

      // Baixa também a capa da música para reprodução offline
      const coverObj = await fetchCoverAsBlobAndDataUrl(track.cover);
      const coverData = coverObj ? coverObj.data : null;
      const coverDataUrl = coverObj ? coverObj.dataUrl : '';
      const coverMime = coverObj ? coverObj.mime : 'image/jpeg';

      const saved = {
        title: track.title,
        artist: track.artist,
        cover: coverDataUrl || track.cover || '',
        coverDataUrl,
        coverData,
        file: fileName,
        blob
      };
      await saveOfflineTrack(saved, blob);
      if (saveOnDisk) {
        const written = await window.torBrowserAPI.saveFavoriteTrack({
          playlist: name,
          fileName,
          title: track.title,
          artist: track.artist,
          cover: track.cover || '',
          coverData,
          coverMime,
          isPlaylistCover: (i === 0),
          data
        });
        if (written && written.success) {
          diskFolder = written.folder || diskFolder;
          saved.file = written.file || fileName;
        }
      }
      savedTracks.push(saved);
      files.push({ name: saved.file, data });
      if (coverData && coverData.length > 50) {
        files.push({ name: saved.file.replace(/\.[^.]+$/, '.jpg'), data: coverData });
      }
    } catch (e) {}
    setDownloadProgress(i + 1, list.length);
  }

  if (!savedTracks.length) {
    setLabel('Não consegui preparar o download');
    showDownloadNotice('Nenhuma música ficou pronta para baixar.');
  } else {
    const plCover = (savedTracks[0] && (savedTracks[0].coverDataUrl || savedTracks[0].cover)) || '';
    const plCoverBytes = (savedTracks[0] && savedTracks[0].coverData) || null;

    // Adiciona a capa do álbum na raiz do ZIP
    if (plCoverBytes && plCoverBytes.length > 50) {
      files.push({ name: 'cover.jpg', data: plCoverBytes });
      files.push({ name: 'album.jpg', data: plCoverBytes });
    }

    // Adiciona manifesto completo do álbum e playlist dentro do ZIP
    const manifestJson = {
      name,
      album: name,
      cover: 'cover.jpg',
      downloadedAt: new Date().toISOString(),
      tracks: savedTracks.map((track, idx) => ({
        trackNumber: idx + 1,
        title: track.title,
        artist: track.artist,
        album: name,
        file: track.file
      }))
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestJson, null, 2));
    files.push({ name: 'playlist.json', data: manifestBytes });
    files.push({ name: 'album.json', data: manifestBytes });

    await saveFavoritePlaylistRecord(name, savedTracks, plCover);
    if (saveOnDisk && typeof window.torBrowserAPI.saveFavoritePlaylistIndex === 'function') {
      const indexed = await window.torBrowserAPI.saveFavoritePlaylistIndex({
        name,
        cover: plCover,
        coverData: plCoverBytes,
        tracks: savedTracks.map((track) => ({
          title: track.title,
          artist: track.artist,
          album: name,
          cover: track.cover,
          coverFile: track.file.replace(/\.[^.]+$/, '.jpg'),
          file: track.file
        }))
      });
      if (indexed && indexed.folder) diskFolder = indexed.folder;
    } else {
      try {
        fetch('/api/create-favorite-playlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body: JSON.stringify({
            name,
            cover: plCover,
            clientId: CLIENT_ID,
            tracks: savedTracks.map((track) => ({
              title: track.title,
              artist: track.artist,
              album: name,
              cover: track.cover || plCover,
              file: track.file
            }))
          })
        }).catch(() => null);
      } catch(e) {}
    }

    // Sempre baixa o ZIP com o álbum completo para a pasta Downloads
    const zipName = safeDownloadName(name, 'Playlist') + '.zip';
    saveFileForUser(buildStoredZip(files), zipName);

    if (diskFolder) {
      setLabel('✓ Salva com álbum no aparelho');
      showDownloadNotice(`Playlist e Álbum "${name}" baixados com sucesso! O arquivo ${zipName} foi para Downloads e as músicas também estão salvas para ouvir offline.`);
    } else {
      setLabel('✓ "' + name + '" enviado com álbum para downloads');
      showDownloadNotice('O arquivo ' + zipName + ' (com álbum e capa) foi para a pasta Downloads. Também ficou disponível para ouvir sem internet!');
    }
    triggerPlaylistDownloadedVibration(name);
  }
  if (btn && downloadQueue.length === 0) btn.disabled = false;
  if (downloadQueue.length === 0) {
    setTimeout(() => {
      setLabel(downloadButtonLabel());
      setDownloadProgress(0, 0);
    }, 8000);
  }
}

function setDownloadProgress(done, total) {
  const wrap = document.getElementById('sp-download-progress');
  const bar = document.getElementById('sp-download-progress-bar');
  if (!wrap || !bar) return;
  if (!total) {
    wrap.hidden = true;
    bar.style.width = '0%';
    return;
  }
  wrap.hidden = false;
  bar.style.width = Math.round((done / total) * 100) + '%';
}

function downloadButtonLabel() {
  return selectedPlaylistName ? '⬇ Baixar "' + selectedPlaylistName + '"' : '⬇ Baixar playlist';
}

async function downloadPlaylistToDevice() {
  queuePlaylistDownload();
}

// Pré-carrega em segundo plano a URL da próxima música para tocar instantaneamente na transição
function preloadNextTrackStream(nextIndex) {
  const actList = window.playingTracksList || currentTracksList;
  if (!actList || nextIndex >= actList.length) return;
  const nextTrack = actList[nextIndex];
  if (!nextTrack) return;
  getOfflineTrackUrl(nextTrack).then((offline) => {
    if (offline) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (!nextTrack.fullStreamUrl) {
      nextTrack.fullStreamUrl = `/api/stream-audio?title=${encodeURIComponent(nextTrack.title)}&artist=${encodeURIComponent(nextTrack.artist)}`;
    }
    fetch(nextTrack.fullStreamUrl, { headers: { 'Range': 'bytes=0-1024' } }).catch(() => {});
  }).catch(() => {});
}

// Manda o servidor resolver a lista inteira em lote, antes do usuário clicar.
// Uma chamada do yt-dlp para várias músicas corta quase metade do tempo.
const prewarmedTracks = new Set();
function prewarmPlaylistOnServer(tracks) {
  const fresh = (tracks || [])
    .filter((t) => t && t.title)
    .map((t) => ({ title: t.title, artist: t.artist || '' }))
    .filter((t) => {
      const key = `${t.title}|${t.artist}`.toLowerCase();
      if (prewarmedTracks.has(key)) return false;
      prewarmedTracks.add(key);
      return true;
    })
    .slice(0, 60);
  if (fresh.length === 0) return;

  try {
    fetch('/api/prewarm-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
      body: JSON.stringify({ clientId: CLIENT_ID, tracks: fresh })
    }).catch(() => {});
  } catch (e) { /* pré-aquecimento é opcional; nunca deve travar a lista */ }
}

if (btnSpPlayPause && spotifyPreviewAudio) {
  btnSpPlayPause.addEventListener('click', () => {
    if (!spotifyPreviewAudio.src && currentTracksList.length > 0) {
      window.isUserIntentionallyPaused = false;
      playTrackAtIndex(currentTrackIndex);
      return;
    }
    if (spotifyPreviewAudio.paused) {
      window.isUserIntentionallyPaused = false;
      spotifyPreviewAudio.play();
      updateBottomPlayerState(true);
    } else {
      window.isUserIntentionallyPaused = true;
      spotifyPreviewAudio.pause();
      updateBottomPlayerState(false);
    }
  });

  // Sincronização dos metadados de áudio (Duração total)
  spotifyPreviewAudio.addEventListener('loadedmetadata', () => {
    const dur = getEffectiveDuration();
    if (dur && dur > 0) {
      const durStr = formatTime(dur);
      if (spMiniDurTime) spMiniDurTime.textContent = durStr;
      if (spExpandedTimeDur) spExpandedTimeDur.textContent = durStr;
    }
  });

  // Atualização em tempo real do progresso no mini player e no player expandido
  spotifyPreviewAudio.addEventListener('timeupdate', () => {
    // Se a aba estiver oculta / minimizada, não gasta processamento alterando nós do DOM
    if (document.hidden || window.__papaIsHidden) return;

    const dur = getEffectiveDuration();
    const cur = spotifyPreviewAudio.currentTime || 0;
    const curStr = formatTime(cur);

    if (spMiniCurTime) spMiniCurTime.textContent = curStr;
    if (spExpandedTimeCur) spExpandedTimeCur.textContent = curStr;
    if (spMiniBubbleBadge) spMiniBubbleBadge.textContent = curStr;

    if (dur && dur > 0) {
      const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
      if (spPlayerProgressBar) spPlayerProgressBar.style.width = `${pct}%`;
      if (spBottomPlayer) spBottomPlayer.style.setProperty('--sp-progress-pct', `${pct.toFixed(1)}%`);

      // Sincroniza barra e thumb do player maior (expandido)
      if (spExpandedFill) spExpandedFill.style.width = `${pct}%`;
      if (spExpandedThumb) spExpandedThumb.style.left = `${pct}%`;

      const durStr = formatTime(dur);
      if (spMiniDurTime) spMiniDurTime.textContent = durStr;
      if (spExpandedTimeDur) spExpandedTimeDur.textContent = durStr;

      syncDjPictureInPicture(curStr + ' / ' + durStr);

      const realDur = spotifyPreviewAudio.duration;
      const timeLeft = (realDur && isFinite(realDur)) ? (realDur - cur) : Infinity;
      // Quando faltar 3 segundos para o final da música, faz transição suave (fade out)
      const onPreview = String(spotifyPreviewAudio.src || '').includes('/api/audio-preview');
      if (timeLeft <= 3.0 && timeLeft > 0 && !isCrossfading && !isRepeat && !onPreview) {
        isCrossfading = true;
        let fadeStep = 0;
        if (musicFadeInterval) clearInterval(musicFadeInterval);
        musicFadeInterval = setInterval(() => {
          fadeStep++;
          const newVol = Math.max(0, 1.0 - (fadeStep * 0.1));
          spotifyPreviewAudio.volume = newVol;
          if (newVol <= 0.05 || fadeStep >= 10) {
            clearInterval(musicFadeInterval);
            musicFadeInterval = null;
          }
        }, 250);
      }
    }
  });

  // Transição ao término da música
  spotifyPreviewAudio.addEventListener('ended', () => {
    spotifyPreviewAudio.volume = 1.0;
    isCrossfading = false;
    if (musicFadeInterval) {
      clearInterval(musicFadeInterval);
      musicFadeInterval = null;
    }
    if (isRepeat) {
      spotifyPreviewAudio.currentTime = 0;
      spotifyPreviewAudio.play().catch(() => {});
    } else {
      playNextTrack();
    }
  });

  spotifyPreviewAudio.addEventListener('playing', () => {
    setMusicLoading(false);
    updateBottomPlayerState(true);
  });

  spotifyPreviewAudio.addEventListener('error', (e) => {
    console.warn('Alerta no elemento de áudio:', e);
    const track = currentTracksList[currentTrackIndex];
    const src = String(spotifyPreviewAudio.src || '');
    // Se o áudio completo falhou, tenta amostra somente se online e não for arquivo local
    const isOnline = typeof navigator === 'undefined' || navigator.onLine;
    if (isOnline && !src.startsWith('blob:') && track && track.preview && !src.includes('/api/audio-preview') && !src.includes(track.preview)) {
      spotifyPreviewAudio.src = resolveMediaUrl(track.preview);
      spotifyPreviewAudio.currentTime = 0;
      spotifyPreviewAudio.play().catch(() => {});
      return;
    }
    setMusicLoading(false);
  });
}

// Interação com a barra de progresso (Clique, Arrasto/Seek e Tooltip de Tempo)
if (spPlayerProgressContainer && spotifyPreviewAudio) {
  let isSeekingProgress = false;

  const seekToClientX = (clientX) => {
    const rect = spPlayerProgressContainer.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const dur = getEffectiveDuration();
    if (dur && rect.width > 0) {
      const targetTime = (clickX / rect.width) * dur;
      spotifyPreviewAudio.currentTime = targetTime;
      spotifyPreviewAudio.volume = 1.0;
      isCrossfading = false;

      const pct = (targetTime / dur) * 100;
      if (spPlayerProgressBar) spPlayerProgressBar.style.width = `${pct}%`;
      if (spBottomPlayer) spBottomPlayer.style.setProperty('--sp-progress-pct', `${pct.toFixed(1)}%`);
      if (spMiniCurTime) spMiniCurTime.textContent = formatTime(targetTime);
      if (spMiniBubbleBadge) spMiniBubbleBadge.textContent = formatTime(targetTime);
    }
  };

  const updateProgressTooltip = (clientX) => {
    if (!spPlayerProgressTooltip) return;
    const rect = spPlayerProgressContainer.getBoundingClientRect();
    const hoverX = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const dur = getEffectiveDuration();
    if (dur && rect.width > 0) {
      const hoverTime = (hoverX / rect.width) * dur;
      spPlayerProgressTooltip.style.display = 'block';
      spPlayerProgressTooltip.style.left = `${hoverX}px`;
      spPlayerProgressTooltip.textContent = formatTime(hoverTime);
    }
  };

  spPlayerProgressContainer.addEventListener('mousedown', (e) => {
    isSeekingProgress = true;
    seekToClientX(e.clientX);
    updateProgressTooltip(e.clientX);
  });

  spPlayerProgressContainer.addEventListener('mousemove', (e) => {
    updateProgressTooltip(e.clientX);
  });

  window.addEventListener('mousemove', (e) => {
    if (isSeekingProgress) {
      seekToClientX(e.clientX);
      updateProgressTooltip(e.clientX);
    }
  });

  window.addEventListener('mouseup', () => {
    if (isSeekingProgress) {
      isSeekingProgress = false;
      if (spPlayerProgressTooltip) spPlayerProgressTooltip.style.display = 'none';
    }
  });

  spPlayerProgressContainer.addEventListener('mouseleave', () => {
    if (!isSeekingProgress && spPlayerProgressTooltip) {
      spPlayerProgressTooltip.style.display = 'none';
    }
  });

  // Suporte a toque para celulares e tablets
  spPlayerProgressContainer.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches[0]) {
      isSeekingProgress = true;
      seekToClientX(e.touches[0].clientX);
    }
  }, { passive: true });

  spPlayerProgressContainer.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches[0]) {
      seekToClientX(e.touches[0].clientX);
    }
  }, { passive: true });

  spPlayerProgressContainer.addEventListener('touchend', () => {
    isSeekingProgress = false;
  });
}

let isFetchingMoreRecommendations = false;

// Adiciona novas faixas ao final da lista existente sem interromper a reprodução atual
function appendNewTracksToList(newTracks) {
  if (!newTracks || newTracks.length === 0 || !spTrackList) return;
  const startIndex = currentTracksList.length;
  currentTracksList = currentTracksList.concat(newTracks);

  newTracks.forEach((track, offset) => {
    const idx = startIndex + offset;
    const row = document.createElement('div');
    row.className = 'sp-track-row';
    row.setAttribute('data-id', track.id);
    const titleText = track.title || 'Sem título';
    const isAlreadyInTarget = targetPlaylistTitlesSet.has(titleText.trim().toLowerCase());

    row.innerHTML = `
      <img class="sp-track-thumb" src="${track.cover || 'papaleguas_logo.png'}" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src='papaleguas_logo.png';}" alt="" />
      <div class="sp-track-meta">
        <span class="sp-track-name" title="${titleText}">${titleText}</span>
        <span class="sp-track-artist" title="${[track.artist, track.album].filter(Boolean).join(' • ')}">${[track.artist, track.album].filter(Boolean).join(' • ')}</span>
        ${track.aiReason ? `<span class="sp-track-ai-reason" title="${track.aiReason}">✨ ${track.aiReason}</span>` : ''}
      </div>
      <div class="sp-track-actions">
        <button class="sp-quick-add-btn${isAlreadyInTarget ? ' is-added' : ''}" type="button" title="${isAlreadyInTarget ? '✓ Já na playlist' : 'Adicionar à playlist favorita'}">
          ${isAlreadyInTarget
            ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1ed760" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
            : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
          }
        </button>
      </div>
    `;

    const quickAddBtn = row.querySelector('.sp-quick-add-btn');
    if (quickAddBtn) {
      quickAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleQuickAddTrackToPlaylist(track, quickAddBtn);
      });
    }

    row.addEventListener('click', () => {
      playTrackAtIndex(idx);
    });

    spTrackList.appendChild(row);
  });
}

// Busca mais recomendações com a IA excluindo as que já foram tocadas/listadas
async function fetchMoreAiRecommendations() {
  if (isFetchingMoreRecommendations) return [];
  isFetchingMoreRecommendations = true;

  const q = spotifySearchInput ? spotifySearchInput.value.trim() : 'eletronicas';
  const cat = getActiveCategory();
  const excludeTitles = getSessionExcludeTitles();

  if (spAiBannerStatus) spAiBannerStatus.textContent = 'Buscando novas faixas inéditas...';

  try {
    const res = await window.torBrowserAPI.getAiMusicRecommendations(q, cat, excludeTitles);
    if (res && res.success && res.results && res.results.length > 0) {
      registerSessionTracks(res.results);
      appendNewTracksToList(res.results);
      if (spAiBannerStatus) spAiBannerStatus.textContent = '✨ Novas Músicas Adicionadas';
      return res.results;
    }
  } catch (err) {
    console.warn('Erro ao expandir recomendações:', err);
  } finally {
    isFetchingMoreRecommendations = false;
  }
  return [];
}

let isCurrentListFromDj = false;
let djPlaylistCap = 0;

// Carrega o próximo lote de músicas para o gênero/busca atual ao rolar a página (Rolagem Infinita)
async function loadMoreGenreTracks() {
  if (isInfiniteLoading || !hasInfiniteMore) return;

  // A playlist do DJ fica no tamanho pedido. Rolagem não acrescenta outras faixas.
  if (isCurrentListFromDj) {
    hasInfiniteMore = false;
    if (spInfiniteLoader) spInfiniteLoader.style.display = 'none';
    return;
  }

  // Identifica a consulta ou gênero musical ativo
  let effectiveQuery = currentInfiniteQuery && currentInfiniteQuery.trim() ? currentInfiniteQuery.trim() : '';
  if (!effectiveQuery) {
    const activeGenreBtn = document.querySelector('.sp-genre-btn.active');
    if (activeGenreBtn) {
      effectiveQuery = activeGenreBtn.getAttribute('data-query') || activeGenreBtn.getAttribute('data-genre') || 'top brasil';
    } else {
      effectiveQuery = 'top brasil';
    }
    currentInfiniteQuery = effectiveQuery;
  }

  isInfiniteLoading = true;
  if (spInfiniteLoader) spInfiniteLoader.style.display = 'flex';
  if (spInfiniteText) spInfiniteText.textContent = 'Carregando mais faixas...';

  try {
    const limit = 30;
    const cat = getActiveCategory();
    let searchParam = effectiveQuery;
    if (cat && cat !== 'all') {
      if (cat === 'artist') searchParam += ' dj';
      else if (cat === 'album') searchParam += ' album';
    }

    const res = await window.torBrowserAPI.searchMusic(searchParam, limit, currentInfiniteOffset);
    if (res && res.success && res.results && res.results.length > 0) {
      const existingIds = new Set(currentTracksList.map(t => String(t.id)));
      const newUniqueTracks = res.results.filter(t => !existingIds.has(String(t.id)));

      if (newUniqueTracks.length > 0) {
        appendNewTracksToList(newUniqueTracks);
        currentInfiniteOffset += res.results.length;
      } else {
        currentInfiniteOffset += res.results.length;
        if (res.results.length < 5) {
          hasInfiniteMore = false;
        }
      }
    } else {
      hasInfiniteMore = false;
      if (spInfiniteText) spInfiniteText.textContent = 'Você chegou ao final desta seleção.';
      setTimeout(() => {
        if (spInfiniteLoader) spInfiniteLoader.style.display = 'none';
      }, 1800);
      return;
    }
  } catch (err) {
    console.warn('Erro na rolagem infinita por gênero:', err);
  } finally {
    isInfiniteLoading = false;
    if (hasInfiniteMore && spInfiniteLoader) {
      spInfiniteLoader.style.display = 'none';
    }
  }
}

// Configura o ouvinte de rolagem infinita no container de músicas
function setupInfiniteScroll() {
  const container = spScrollBody || document.getElementById('sp-scroll-body');
  if (!container) return;

  container.addEventListener('scroll', () => {
    // Dispara quando estiver a 350px de atingir o final da rolagem
    const scrollBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
    if (scrollBottom < 350 && !isInfiniteLoading && hasInfiniteMore) {
      loadMoreGenreTracks();
    }
  }, { passive: true });
}

async function playNextTrack() {
  const actList = window.playingTracksList || currentTracksList;
  if (!actList || actList.length === 0) return;
  if (isShuffle) {
    const randIndex = Math.floor(Math.random() * actList.length);
    playTrackAtIndex(randIndex, false);
    return;
  }
  const nextIdx = currentTrackIndex + 1;
  if (isCurrentListFromDj && nextIdx >= actList.length) {
    if (isRepeat) playTrackAtIndex(0, false);
    return;
  }
  if (nextIdx >= actList.length) {
    if (isRepeat) {
      playTrackAtIndex(0, false);
    } else {
      const moreTracks = await fetchMoreAiRecommendations();
      if (moreTracks && moreTracks.length > 0) {
        playTrackAtIndex(currentTrackIndex + 1, false);
      } else {
        playTrackAtIndex(0, false);
      }
    }
    return;
  }
  playTrackAtIndex(nextIdx, false);
}

function playPrevTrack() {
  if (spotifyPreviewAudio && spotifyPreviewAudio.currentTime > 3) {
    spotifyPreviewAudio.currentTime = 0;
    syncMediaSessionPosition(true);
    syncDjPictureInPicture();
    return;
  }
  const actList = window.playingTracksList || currentTracksList;
  if (!actList || actList.length === 0) return;
  const prevIdx = currentTrackIndex <= 0 ? (actList.length - 1) : (currentTrackIndex - 1);
  playTrackAtIndex(prevIdx, false);
}

function playPreviousTrack() {
  playPrevTrack();
}

if (btnSpNext) btnSpNext.addEventListener('click', playNextTrack);
if (btnSpPrev) btnSpPrev.addEventListener('click', playPrevTrack);

// Picture-in-Picture do player: janela flutuante com capa e controles interativos de troca de música.
// No Chromium abre a janela de documento; nos outros navegadores, desenha a capa e controles num vídeo com MediaStream.
const btnSpPip = document.getElementById('btn-sp-pip');
const btnSpExpandedPip = document.getElementById('btn-sp-expanded-pip');
let djPipCanvas = null;
let djPipVideo = null;
let djPipCoverImg = null;
let djPipCoverSrc = '';
let djPipSyncing = false;
let djPipLastDraw = 0;
let djPipLoopTimer = null;

function setDjPipButton(on) {
  if (btnSpPip) btnSpPip.classList.toggle('active', !!on);
  if (btnSpExpandedPip) btnSpExpandedPip.classList.toggle('active', !!on);
}

function djPipTrack() {
  const actList = window.playingTracksList || currentTracksList;
  return (actList && actList[currentTrackIndex]) || null;
}

function djPipNextTrack() {
  const actList = window.playingTracksList || currentTracksList;
  if (!actList || actList.length === 0) return null;
  if (isShuffle) return null;
  const nextIdx = currentTrackIndex + 1;
  if (nextIdx >= actList.length) {
    return isRepeat ? actList[0] : null;
  }
  return actList[nextIdx] || null;
}

function djPipTimeLabel(explicit) {
  if (explicit) return explicit;
  const dur = getEffectiveDuration();
  const cur = spotifyPreviewAudio ? (spotifyPreviewAudio.currentTime || 0) : 0;
  return formatTime(cur) + (dur > 0 ? (' / ' + formatTime(dur)) : '');
}

function fillDjPipDocument(pipWin, timeLabel) {
  if (!pipWin || pipWin.closed) return;
  const doc = pipWin.document;
  if (!doc) return;
  const track = djPipTrack();
  const nextTrack = djPipNextTrack();
  const titleEl = doc.getElementById('pip-title');
  const artistEl = doc.getElementById('pip-artist');
  const timeEl = doc.getElementById('pip-time');
  const coverEl = doc.getElementById('pip-cover');
  const playEl = doc.getElementById('pip-play');
  const nextEl = doc.getElementById('pip-next-title');
  const progBar = doc.getElementById('pip-progress-bar');

  if (titleEl) titleEl.textContent = (track && track.title) || '--';
  if (artistEl) artistEl.textContent = (track && track.artist) || 'Escolha uma música';
  if (timeEl) timeEl.textContent = timeLabel || djPipTimeLabel();
  if (nextEl) {
    nextEl.textContent = (nextTrack && nextTrack.title) ? ('A seguir: ' + nextTrack.title) : '';
  }
  if (coverEl) {
    const src = (track && track.cover) || (spMiniThumb && spMiniThumb.src) || 'papaleguas_logo.png';
    if (src && coverEl.src !== src) {
      try { coverEl.src = new URL(src, location.href).href; } catch (e) { coverEl.src = src; }
    }
  }
  if (playEl) {
    const playing = spotifyPreviewAudio && spotifyPreviewAudio.src && !spotifyPreviewAudio.paused;
    playEl.textContent = playing ? '❚❚' : '▶';
  }
  if (progBar) {
    const dur = getEffectiveDuration();
    const cur = spotifyPreviewAudio ? (spotifyPreviewAudio.currentTime || 0) : 0;
    if (dur > 0) {
      const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
      progBar.style.width = pct.toFixed(1) + '%';
    } else {
      progBar.style.width = '0%';
    }
  }
}

function openDjPipDocument(pipWin) {
  const doc = pipWin.document;
  doc.documentElement.lang = 'pt-BR';
  doc.head.innerHTML = '<meta charset="utf-8"><title>Player</title><style>'
    + 'html,body{margin:0;height:100%;background:#070b14;color:#f8fafc;font-family:Outfit,system-ui,sans-serif;-webkit-user-select:none;user-select:none;}'
    + 'body{display:flex;align-items:center;gap:14px;padding:12px 16px;box-sizing:border-box;overflow:hidden;}'
    + 'img{width:92px;height:92px;border-radius:12px;object-fit:cover;background:#111827;flex-shrink:0;box-shadow:0 6px 18px rgba(0,0,0,.6);}'
    + '.meta{min-width:0;flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:center;}'
    + '.title{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;}'
    + '.artist{margin-top:2px;font-size:12px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.time-row{display:flex;align-items:center;justify-content:space-between;margin-top:4px;font-size:11px;color:#1ed760;font-family:monospace;font-weight:600;}'
    + '.progress-wrap{width:100%;height:5px;background:rgba(255,255,255,0.1);border-radius:3px;margin-top:5px;cursor:pointer;position:relative;overflow:hidden;}'
    + '.progress-bar{height:100%;background:#1ed760;border-radius:3px;width:0%;transition:width 0.15s linear;}'
    + '.progress-wrap:hover{height:7px;}'
    + '.ctrls{display:flex;align-items:center;gap:10px;margin-top:8px;}'
    + 'button{width:36px;height:36px;border:none;border-radius:50%;background:rgba(255,255,255,.08);color:#e2e8f0;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;}'
    + 'button:hover{background:rgba(255,255,255,.2);transform:scale(1.06);}'
    + 'button:active{transform:scale(0.92);}'
    + '#pip-play{width:40px;height:40px;background:#1ed760;color:#04140c;font-weight:700;font-size:17px;box-shadow:0 3px 10px rgba(30,215,96,0.3);}'
    + '#pip-play:hover{background:#22e366;}'
    + '.next-info{margin-top:4px;font-size:10px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '</style>';
  doc.body.innerHTML = '<img id="pip-cover" alt="Capa" src="papaleguas_logo.png">'
    + '<div class="meta">'
    + '<div class="title" id="pip-title">--</div>'
    + '<div class="artist" id="pip-artist">Escolha uma música</div>'
    + '<div class="time-row"><span id="pip-time">0:00</span></div>'
    + '<div class="progress-wrap" id="pip-progress-wrap" title="Clique para avançar/retroceder"><div class="progress-bar" id="pip-progress-bar"></div></div>'
    + '<div class="ctrls">'
    + '<button id="pip-prev" type="button" title="Música Anterior (⏮ ou P / Seta Esquerda)">⏮</button>'
    + '<button id="pip-play" type="button" title="Reproduzir / Pausar (Espaço)">▶</button>'
    + '<button id="pip-next" type="button" title="Próxima Música (⏭ ou N / Seta Direita)">⏭</button>'
    + '</div>'
    + '<div class="next-info" id="pip-next-title"></div>'
    + '</div>';

  const click = (id, fn) => {
    const el = doc.getElementById(id);
    if (el && typeof fn === 'function') el.addEventListener('click', fn);
  };
  click('pip-prev', (e) => {
    e.stopPropagation();
    playPrevTrack();
  });
  click('pip-play', (e) => {
    e.stopPropagation();
    if (btnSpPlayPause) btnSpPlayPause.click();
  });
  click('pip-next', (e) => {
    e.stopPropagation();
    playNextTrack();
  });

  const progWrap = doc.getElementById('pip-progress-wrap');
  if (progWrap) {
    progWrap.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const rect = progWrap.getBoundingClientRect();
      const clickX = ev.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      const dur = getEffectiveDuration();
      if (dur > 0 && spotifyPreviewAudio) {
        spotifyPreviewAudio.currentTime = dur * ratio;
        syncMediaSessionPosition(true);
      }
    });
  }

  // Atalhos de teclado quando a janela PiP flutuante estiver em foco
  pipWin.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (btnSpPlayPause) btnSpPlayPause.click();
    } else if (e.key === 'ArrowRight' || e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      playNextTrack();
    } else if (e.key === 'ArrowLeft' || e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      playPrevTrack();
    }
  });

  fillDjPipDocument(pipWin);
  pipWin.addEventListener('pagehide', () => setDjPipButton(false));
}

function drawCoverPlaceholder(ctx, x, y, size) {
  ctx.save();
  const grad = ctx.createLinearGradient(x, y, x + size, y + size);
  grad.addColorStop(0, '#1e293b');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, size, size, 16);
  else ctx.rect(x, y, size, size);
  ctx.fill();
  ctx.fillStyle = '#1ed760';
  ctx.font = '700 56px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🎵', x + size / 2, y + size / 2);
  ctx.restore();
}

function drawDjPipCanvas() {
  if (!djPipCanvas) return;
  const ctx = djPipCanvas.getContext('2d');
  const w = djPipCanvas.width;
  const h = djPipCanvas.height;

  // Fundo moderno com gradiente sutil
  const bgGrad = ctx.createLinearGradient(0, 0, w, h);
  bgGrad.addColorStop(0, '#070b14');
  bgGrad.addColorStop(1, '#0f172a');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  const track = djPipTrack();
  const nextTrack = djPipNextTrack();
  const isPlaying = spotifyPreviewAudio && spotifyPreviewAudio.src && !spotifyPreviewAudio.paused;

  // Capa do álbum
  const size = 168;
  const x = 28;
  const y = 36;
  let drewImg = false;
  if (djPipCoverImg && djPipCoverImg.complete && djPipCoverImg.naturalWidth) {
    try {
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, size, size, 16);
      else ctx.rect(x, y, size, size);
      ctx.clip();
      ctx.drawImage(djPipCoverImg, x, y, size, size);
      ctx.restore();
      drewImg = true;
    } catch (e) {
      drewImg = false;
    }
  }
  if (!drewImg) {
    drawCoverPlaceholder(ctx, x, y, size);
  }

  // Título e Artista
  const textX = 224;
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 26px sans-serif';
  const title = (track && track.title) || '--';
  ctx.fillText(title.slice(0, 26), textX, 70);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '18px sans-serif';
  const artist = ((track && track.artist) || 'Selecione uma faixa').slice(0, 32);
  ctx.fillText(artist, textX, 104);

  // Tempo decorrido / total
  ctx.fillStyle = '#1ed760';
  ctx.font = '700 16px monospace';
  ctx.fillText(djPipTimeLabel(), textX, 134);

  // Barra de progresso visual no PiP
  const dur = getEffectiveDuration();
  const cur = spotifyPreviewAudio ? (spotifyPreviewAudio.currentTime || 0) : 0;
  const barW = 386;
  const barY = 152;

  ctx.fillStyle = '#1e293b';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(textX, barY, barW, 6, 3);
  else ctx.rect(textX, barY, barW, 6);
  ctx.fill();

  if (dur > 0) {
    const p = Math.min(1, Math.max(0, cur / dur));
    ctx.fillStyle = '#1ed760';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(textX, barY, Math.max(10, barW * p), 6, 3);
    else ctx.rect(textX, barY, Math.max(0, barW * p), 6);
    ctx.fill();
  }

  // Botões e Badges Visuais de Controle no PiP
  // [ ⏮ Anterior ]   [ ❚❚ Pausar / ▶ Tocar ]   [ Próxima ⏭ ]
  const drawButtonPill = (bx, by, bw, bh, text, icon, isMain) => {
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, bh / 2);
    else ctx.rect(bx, by, bw, bh);
    ctx.fillStyle = isMain ? '#1ed760' : 'rgba(255, 255, 255, 0.08)';
    ctx.fill();
    ctx.strokeStyle = isMain ? '#1ed760' : 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = isMain ? '#04140c' : '#f1f5f9';
    ctx.font = isMain ? '700 15px sans-serif' : '600 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((icon ? icon + ' ' : '') + text, bx + bw / 2, by + bh / 2);
    ctx.restore();
  };

  const btnY = 178;
  drawButtonPill(textX, btnY, 115, 36, 'Anterior', '⏮', false);
  drawButtonPill(textX + 125, btnY, 125, 36, isPlaying ? 'Pausar' : 'Tocar', isPlaying ? '❚❚' : '▶', true);
  drawButtonPill(textX + 260, btnY, 115, 36, 'Próxima', '⏭', false);

  // A seguir: Próxima música
  ctx.save();
  ctx.fillStyle = '#64748b';
  ctx.font = '500 14px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (nextTrack && nextTrack.title) {
    const nextLabel = '⏭ A seguir: ' + nextTrack.title.slice(0, 32) + (nextTrack.artist ? ' • ' + nextTrack.artist.slice(0, 18) : '');
    ctx.fillText(nextLabel, textX, 238);
  } else if (isShuffle) {
    ctx.fillText('🔀 Modo Aleatório ativado', textX, 238);
  } else {
    ctx.fillText('Player Ativo', textX, 238);
  }
  ctx.restore();

  // Rodapé decorativo
  ctx.save();
  ctx.fillStyle = '#334155';
  ctx.font = '500 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('⏮ Anterior | ❚❚ Pausar | ⏭ Próxima', 28, 336);
  ctx.restore();
}

function ensureDjPipCanvas() {
  try { bindMediaSessionHandlers(); } catch (e) {}

  if (!djPipCanvas) {
    djPipCanvas = document.createElement('canvas');
    djPipCanvas.width = 640;
    djPipCanvas.height = 360;
    drawDjPipCanvas();
  }
  if (!djPipVideo) {
    djPipVideo = document.createElement('video');
    djPipVideo.muted = true;
    djPipVideo.playsInline = true;
    djPipVideo.setAttribute('playsinline', 'true');
    djPipVideo.setAttribute('webkit-playsinline', 'true');
    djPipVideo.setAttribute('disableRemotePlayback', 'false');
    djPipVideo.width = 320;
    djPipVideo.height = 180;
    djPipVideo.style.cssText = 'position:fixed;width:320px;height:180px;opacity:0.0001;pointer-events:none;bottom:0;right:0;z-index:-10;';
    document.body.appendChild(djPipVideo);

    const stream = (djPipCanvas.captureStream && djPipCanvas.captureStream(15)) ||
                   (djPipCanvas.mozCaptureStream && djPipCanvas.mozCaptureStream(15)) ||
                   null;
    if (stream) {
      // Adiciona uma trilha de áudio silenciosa para que o Chromium habilite os botões nativos ⏮ e ⏭ no overlay de PiP
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          if (!window._djPipAudioCtx) {
            window._djPipAudioCtx = new AudioCtx();
          }
          if (window._djPipAudioCtx.state === 'suspended') {
            window._djPipAudioCtx.resume().catch(() => {});
          }
          const dest = window._djPipAudioCtx.createMediaStreamDestination();
          const audioTrack = dest && dest.stream && dest.stream.getAudioTracks()[0];
          if (audioTrack && typeof stream.addTrack === 'function') {
            stream.addTrack(audioTrack);
          }
        }
      } catch (e) {}

      djPipVideo.srcObject = stream;
      const playPromise = djPipVideo.play();
      if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
    }

    djPipVideo.addEventListener('enterpictureinpicture', () => {
      setDjPipButton(true);
      try { bindMediaSessionHandlers(); } catch (e) {}
      if (djPipLoopTimer) clearInterval(djPipLoopTimer);
      djPipLoopTimer = setInterval(() => {
        if (document.pictureInPictureElement === djPipVideo) drawDjPipCanvas();
        else clearInterval(djPipLoopTimer);
      }, 500);
    });
    djPipVideo.addEventListener('leavepictureinpicture', () => {
      setDjPipButton(false);
      if (djPipLoopTimer) clearInterval(djPipLoopTimer);
    });
    djPipVideo.addEventListener('pause', () => {
      if (djPipSyncing || document.pictureInPictureElement !== djPipVideo) return;
      if (spotifyPreviewAudio && !spotifyPreviewAudio.paused) {
        window.isUserIntentionallyPaused = true;
        spotifyPreviewAudio.pause();
        updateBottomPlayerState(false);
      }
    });
    djPipVideo.addEventListener('play', () => {
      if (djPipSyncing || document.pictureInPictureElement !== djPipVideo) return;
      if (spotifyPreviewAudio && spotifyPreviewAudio.paused && spotifyPreviewAudio.src) {
        spotifyPreviewAudio.play().catch(() => {});
        updateBottomPlayerState(true);
      }
    });
  }
  const track = djPipTrack();
  const src = (track && track.cover) || '';
  if (src && src !== djPipCoverSrc) {
    djPipCoverSrc = src;
    djPipCoverImg = new Image();
    djPipCoverImg.crossOrigin = 'anonymous';
    djPipCoverImg.onload = () => drawDjPipCanvas();
    djPipCoverImg.onerror = () => drawDjPipCanvas();
    try { djPipCoverImg.src = new URL(src, location.href).href; } catch (e) { djPipCoverImg.src = src; }
  }
  drawDjPipCanvas();
}

function syncDjPictureInPicture(timeLabel) {
  const pipWin = (window.documentPictureInPicture && window.documentPictureInPicture.window);
  if (pipWin && !pipWin.closed) {
    fillDjPipDocument(pipWin, timeLabel);
    return;
  }
  if (djPipVideo && document.pictureInPictureElement === djPipVideo) {
    const now = Date.now();
    if (timeLabel && now - djPipLastDraw < 450) return;
    djPipLastDraw = now;
    const track = djPipTrack();
    const src = (track && track.cover) || '';
    if (src && src !== djPipCoverSrc) {
      djPipCoverSrc = src;
      djPipCoverImg = new Image();
      djPipCoverImg.crossOrigin = 'anonymous';
      djPipCoverImg.onload = () => drawDjPipCanvas();
      djPipCoverImg.onerror = () => drawDjPipCanvas();
      try { djPipCoverImg.src = new URL(src, location.href).href; } catch (e) { djPipCoverImg.src = src; }
    }
    drawDjPipCanvas();
  }
}

async function toggleDjPictureInPicture() {
  // 1. Tenta Document Picture-in-Picture SOMENTE se for top-level (não em iframe)
  // No Chromium, iframes não têm permissão para chamar documentPictureInPicture diretamente.
  const isTopLevel = window.self === window.top;
  const docPip = isTopLevel && window.documentPictureInPicture;
  if (docPip && typeof docPip.requestWindow === 'function') {
    if (docPip.window && !docPip.window.closed) {
      docPip.window.close();
      setDjPipButton(false);
      return;
    }
    try {
      const pipWin = await docPip.requestWindow({ width: 420, height: 160 });
      openDjPipDocument(pipWin);
      setDjPipButton(true);
      if (spExpandedPlayer) spExpandedPlayer.classList.add('hidden');
      return;
    } catch (e) {
      // Se a janela de documento foi recusada, avança diretamente para vídeo PiP
    }
  }

  // 2. Se já estiver com Video PiP ativo, fecha
  if (document.pictureInPictureElement && djPipVideo && document.pictureInPictureElement === djPipVideo) {
    try { await document.exitPictureInPicture(); } catch (e) {}
    setDjPipButton(false);
    return;
  }

  // 3. Tenta Video Picture-in-Picture nativo via canvas
  // Funciona perfeitamente tanto no top-level quanto dentro de iframes com allow="picture-in-picture"
  ensureDjPipCanvas();
  if (djPipVideo && (document.pictureInPictureEnabled || typeof djPipVideo.requestPictureInPicture === 'function')) {
    try {
      djPipSyncing = true;
      drawDjPipCanvas();
      const started = djPipVideo.play();
      if (started && typeof started.catch === 'function') started.catch(() => {});
      await djPipVideo.requestPictureInPicture();
      setDjPipButton(true);
      if (spExpandedPlayer) spExpandedPlayer.classList.add('hidden');
      return;
    } catch (e) {
      console.warn('Video PiP recusado pelo sistema ou navegador:', e);
    } finally {
      djPipSyncing = false;
    }
  }

  // 4. Fallback universal (quando PiP nativo por canvas é rejeitado pelo OS, ex: mobile):
  // Ativa o Mini Player flutuante interativo e esconde o player expandido
  if (spExpandedPlayer) spExpandedPlayer.classList.add('hidden');
  if (typeof togglePlayerMinimize === 'function') {
    togglePlayerMinimize(true);
  }
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'toggle-music-mini-player' }, '*');
    }
  } catch (e) {}
  setDjPipButton(true);
}

// Inicializa o canvas/vídeo do PiP antecipadamente para que já esteja pronto quando o usuário clicar
try { ensureDjPipCanvas(); } catch (e) {}

if (btnSpPip) btnSpPip.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleDjPictureInPicture();
});
if (btnSpExpandedPip) btnSpExpandedPip.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleDjPictureInPicture();
});


if (btnSpShuffle) {
  btnSpShuffle.addEventListener('click', () => {
    isShuffle = !isShuffle;
    btnSpShuffle.classList.toggle('active', isShuffle);
    if (btnSpExpandedShuffle) btnSpExpandedShuffle.style.color = isShuffle ? "#1ed760" : "currentColor";
  });
}

if (btnSpRepeat) {
  btnSpRepeat.addEventListener('click', () => {
    isRepeat = !isRepeat;
    btnSpRepeat.classList.toggle('active', isRepeat);
    if (btnSpExpandedRepeat) btnSpExpandedRepeat.style.color = isRepeat ? "#1ed760" : "currentColor";
  });
}

const spAiBanner = document.getElementById('sp-ai-banner');
const spAiBannerStatus = document.getElementById('sp-ai-banner-status');
const spAiBannerDesc = document.getElementById('sp-ai-banner-desc');

// Renderiza a lista de resultados e o Hero Card de acordo com o design
function renderSpotifySearchResults(tracks, query, aiSummary = null, playlistName, isFavorite = null, favSource = null) {
  currentTracksList = tracks || [];
  isCurrentListFromDj = !!aiSummary;
  djPlaylistCap = isCurrentListFromDj ? currentTracksList.length : 0;
  const songsOnly = currentTracksList.length > 0 && currentTracksList.every((item) => item && item.title && item.itemType !== 'playlist' && item.type !== 'playlist');
  if (playlistName !== undefined) {
    const isFav = isFavorite !== null ? isFavorite : isCurrentPlaylistFavorite;
    const src = favSource !== null ? favSource : selectedPlaylistSource;
    showSelectedPlaylist(songsOnly ? playlistName : '', isFav, src);
  } else if (selectedPlaylistName && selectedPlaylistName !== String(query || '').trim()) {
    showSelectedPlaylist('');
  }
  if (!spTrackList) return;

  // Atualiza estado do Infinite Scroll para a nova consulta/gênero
  currentInfiniteQuery = query || '';
  currentInfiniteOffset = currentTracksList.length;
  isInfiniteLoading = false;
  hasInfiniteMore = !isCurrentListFromDj && currentTracksList.length >= 8;
  if (spInfiniteLoader) spInfiniteLoader.style.display = 'none';

  if (aiSummary && spAiBanner && spAiBannerDesc) {
    spAiBanner.classList.remove('hidden');
    spAiBannerDesc.textContent = aiSummary;
    if (spAiBannerStatus) spAiBannerStatus.textContent = '🔥 Top Hits Mais Ouvidos';
  } else if (!aiSummary && spAiBanner) {
    spAiBanner.classList.add('hidden');
  }

  if (currentTracksList.length === 0) {
    spTrackList.innerHTML = `<div class="sp-search-placeholder">Nenhum resultado encontrado para "${query}".</div>`;
    if (spHeroCard) spHeroCard.style.display = 'none';
    return;
  }

  // Define o Hero Card com o primeiro resultado / destaque
  const hero = currentTracksList[0];
  const isHeroPl = (hero.itemType === 'playlist' || hero.type === 'playlist');
  prewarmPlaylistOnServer(currentTracksList);
  if (spHeroCard) {
    spHeroCard.style.display = 'flex';
    if (spHeroImg) {
      spHeroImg.onerror = () => { spHeroImg.src = 'papaleguas_logo.png'; };
      spHeroImg.src = hero.cover || 'papaleguas_logo.png';
    }
    if (spHeroTitle) spHeroTitle.textContent = isHeroPl ? `${hero.title.toUpperCase()} 💿` : `${hero.title.toUpperCase()} 🔥`;
    if (spHeroSub) spHeroSub.textContent = isHeroPl
      ? `Playlist Online • ${hero.nb_tracks || 0} músicas • ${hero.creator || 'Papaléguas Music'}`
      : (hero.aiReason ? `Mais Tocada • ${hero.artist}` : `Música • ${hero.artist}`);
    
    if (spHeroPlayBtn) {
      spHeroPlayBtn.onclick = (e) => {
        e.stopPropagation();
        if (isHeroPl) {
          openAndPlayPlaylist(hero.id, hero.title);
        } else if (spotifyPreviewAudio && spotifyPreviewAudio.src && !spotifyPreviewAudio.paused) {
          spotifyPreviewAudio.pause();
          updateBottomPlayerState(false);
        } else if (spotifyPreviewAudio && spotifyPreviewAudio.src) {
          spotifyPreviewAudio.play();
          updateBottomPlayerState(true);
        } else {
          playTrackAtIndex(0);
        }
      };
    }
    spHeroCard.onclick = () => {
      if (isHeroPl) {
        openAndPlayPlaylist(hero.id, hero.title);
      } else if (spotifyPreviewAudio && spotifyPreviewAudio.src && !spotifyPreviewAudio.paused) {
        spotifyPreviewAudio.pause();
        updateBottomPlayerState(false);
      } else if (spotifyPreviewAudio && spotifyPreviewAudio.src) {
        spotifyPreviewAudio.play();
        updateBottomPlayerState(true);
      } else {
        playTrackAtIndex(0);
      }
    };
  }

  // Preenche a lista com os demais resultados
  spTrackList.innerHTML = '';
  currentTracksList.forEach((item, idx) => {
    const isPl = (item.itemType === 'playlist' || item.type === 'playlist');
    const row = document.createElement('div');
    row.className = 'sp-track-row' + (!isPl && idx === currentTrackIndex && !spotifyPreviewAudio.paused ? ' playing' : '');
    if (isPl) {
      row.classList.add('sp-playlist-row');
      row.setAttribute('data-pl-id', item.id);
    } else {
      row.setAttribute('data-id', item.id);
    }

    const titleText = item.title || 'Sem título';
    const subtitleText = isPl
      ? `Playlist • ${item.nb_tracks || 0} músicas • ${item.creator || 'Papaléguas Music'}`
      : [item.artist, item.album].filter(Boolean).join(' • ');

    const isAlreadyInTarget = !isPl && targetPlaylistTitlesSet.has(titleText.trim().toLowerCase());

    row.innerHTML = `
      <img class="sp-track-thumb" src="${item.cover || 'papaleguas_logo.png'}" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src='papaleguas_logo.png';}" alt="" />
      <div class="sp-track-meta">
        <span class="sp-track-name" title="${titleText}">${titleText}</span>
        <span class="sp-track-artist" title="${subtitleText}">${subtitleText}</span>
        ${item.isDownloaded ? `<span class="sp-track-ai-reason" style="background: rgba(30,215,96,0.18); border-color: rgba(30,215,96,0.4); color: #1ed760;" title="Arquivo de áudio no aparelho">📥 Baixada no aparelho</span>` : ''}
        ${item.aiReason ? `<span class="sp-track-ai-reason" title="${item.aiReason}">✨ ${item.aiReason}</span>` : ''}
      </div>
      <div class="sp-track-actions">
        ${!isPl ? `
        <button class="sp-quick-add-btn${isAlreadyInTarget ? ' is-added' : ''}" type="button" title="${isAlreadyInTarget ? '✓ Já na playlist' : 'Adicionar à playlist favorita'}">
          ${isAlreadyInTarget
            ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1ed760" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
            : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
          }
        </button>
        ` : `
        <button class="sp-add-btn" title="Abrir playlist" type="button">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        `}
        ${isCurrentPlaylistFavorite && !isPl ? `
        <button class="sp-track-edit-btn" title="Editar informações da música" type="button">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="sp-track-del-btn" title="Excluir música desta playlist" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
        ` : ''}
      </div>
    `;

    const quickAddBtn = row.querySelector('.sp-quick-add-btn');
    if (quickAddBtn) {
      quickAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleQuickAddTrackToPlaylist(item, quickAddBtn);
      });
    }

    const openPlBtn = row.querySelector('.sp-add-btn');
    if (openPlBtn && isPl) {
      openPlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAndPlayPlaylist(item.id, titleText);
      });
    }

    const editBtn = row.querySelector('.sp-track-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditTrackModal(item, row, selectedPlaylistName, selectedPlaylistSource);
      });
    }

    const delBtn = row.querySelector('.sp-track-del-btn');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTrackFromFavoritePlaylist(selectedPlaylistName, item, row, selectedPlaylistSource);
      });
    }

    row.addEventListener('click', () => {
      if (isPl) {
        openAndPlayPlaylist(item.id, titleText);
      } else {
        playTrackAtIndex(idx);
      }
    });

    spTrackList.appendChild(row);
  });
}

// Renderiza a lista de Playlists quando a categoria Playlists estiver ativa
function renderSpotifyPlaylists(playlists, query) {
  showSelectedPlaylist('');
  if (!spTrackList) return;
  if (!playlists || playlists.length === 0) {
    spTrackList.innerHTML = `<div class="sp-search-placeholder">Nenhuma playlist encontrada para "${query}".</div>`;
    if (spHeroCard) spHeroCard.style.display = 'none';
    return;
  }

  // Hero Card como a primeira Playlist
  const heroPl = playlists[0];
  if (spHeroCard) {
    spHeroCard.style.display = 'flex';
    if (spHeroImg) {
      spHeroImg.onerror = () => { spHeroImg.src = 'papaleguas_logo.png'; };
      spHeroImg.src = heroPl.cover || 'papaleguas_logo.png';
    }
    if (spHeroTitle) spHeroTitle.textContent = `${heroPl.title.toUpperCase()} 💿`;
    if (spHeroSub) spHeroSub.textContent = `Playlist • ${heroPl.nb_tracks} músicas • ${heroPl.creator}`;

    if (spHeroPlayBtn) {
      spHeroPlayBtn.onclick = (e) => {
        e.stopPropagation();
        openAndPlayPlaylist(heroPl.id, heroPl.title);
      };
    }
    spHeroCard.onclick = () => openAndPlayPlaylist(heroPl.id, heroPl.title);
  }

  spTrackList.innerHTML = '';
  playlists.forEach((pl) => {
    const row = document.createElement('div');
    row.className = 'sp-track-row sp-playlist-row';
    row.setAttribute('data-pl-id', pl.id);
    row.innerHTML = `
      <img class="sp-track-thumb" src="${pl.cover || 'papaleguas_logo.png'}" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src='papaleguas_logo.png';}" alt="" />
      <div class="sp-track-meta">
        <span class="sp-track-name" title="${pl.title}">${pl.title}</span>
        <span class="sp-track-artist">Playlist • ${pl.nb_tracks} músicas • ${pl.creator}</span>
      </div>
      <div class="sp-track-actions">
        <button class="sp-add-btn" title="Reproduzir Playlist">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>
    `;

    const addBtn = row.querySelector('.sp-add-btn');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAndPlayPlaylist(pl.id, pl.title);
    });

    row.addEventListener('click', () => {
      openAndPlayPlaylist(pl.id, pl.title);
    });

    spTrackList.appendChild(row);
  });
}

// Carrega as músicas da playlist e inicia a reprodução
async function openAndPlayPlaylist(playlistId, playlistTitle) {
  const name = String(playlistTitle || playlistId || 'Playlist').trim();
  const isAlreadyPlayingThisPlaylist = (window.playingPlaylistName && window.playingPlaylistName.toLowerCase() === name.toLowerCase());

  // Verifica se é uma playlist salva/baixada localmente
  const allFavs = await collectFavoritePlaylists().catch(() => ({ playlists: [] }));
  const matchingLocal = (allFavs.playlists || []).find(p => p.name.toLowerCase() === name.toLowerCase() || p.name === playlistId);
  if (matchingLocal) {
    await loadSavedFavorite(matchingLocal.name, matchingLocal.source || 'disk', !isAlreadyPlayingThisPlaylist);
    return;
  }

  showSelectedPlaylist(name);
  if (spTrackList) {
    spTrackList.innerHTML = `<div class="sp-search-placeholder">Carregando playlist "${name}"...</div>`;
  }
  try {
    const res = await window.torBrowserAPI.getPlaylistTracks(playlistId);
    if (res && res.success && res.tracks && res.tracks.length > 0) {
      renderSpotifySearchResults(res.tracks, name);
      if (spHeroTitle) spHeroTitle.textContent = name;
      if (spHeroSub) spHeroSub.textContent = `Playlist • ${res.tracks.length} músicas`;
      if (!isAlreadyPlayingThisPlaylist) playTrackAtIndex(0);
      return;
    }
    const fallback = await window.torBrowserAPI.searchMusic(name);
    if (fallback && fallback.success && fallback.results && fallback.results.length > 0) {
      renderSpotifySearchResults(fallback.results, name);
      if (spHeroTitle) spHeroTitle.textContent = name;
      if (spHeroSub) spHeroSub.textContent = `Playlist • ${fallback.results.length} músicas`;
      if (!isAlreadyPlayingThisPlaylist) playTrackAtIndex(0);
      return;
    }
    if (spTrackList) {
      spTrackList.innerHTML = `<div class="sp-search-placeholder">Não achei músicas em "${name}".</div>`;
    }
  } catch (err) {
    console.error('Erro ao abrir playlist:', err);
  }
}

// Executa a busca comum direta (sem IA, definida pelo que o usuário quer ouvir)
let searchDebounce = null;
async function fetchMusicTracks(query, category = 'all') {
  const q = (query || '').trim();
  if (spAiBanner && q) spAiBanner.classList.add('hidden');

  try {
    // 0. Se a categoria for 'downloaded' ou 'playlist', abre diretamente o menu de playlists organizadas
    if (category === 'downloaded' || category === 'playlist') {
      openPlaylistsMenuModal();
      return;
    }
    // Se o filtro for 'all' (Tudo), busca e exibe Playlists Online em destaque + Músicas de Sucesso
    if (category === 'all') {
      const plQuery = q || 'top playlists brasil';
      const trQuery = q || 'top brasil';

      const [plRes, trRes] = await Promise.all([
        window.torBrowserAPI.searchPlaylists ? window.torBrowserAPI.searchPlaylists(plQuery) : Promise.resolve({ success: false, results: [] }),
        window.torBrowserAPI.searchMusic ? window.torBrowserAPI.searchMusic(trQuery, 24) : Promise.resolve({ success: false, results: [] })
      ]);

      const onlinePlaylists = (plRes && plRes.success && Array.isArray(plRes.results))
        ? plRes.results.map(p => ({ ...p, itemType: 'playlist' }))
        : [];
      const tracks = (trRes && trRes.success && Array.isArray(trRes.results))
        ? trRes.results.map(t => ({ ...t, itemType: 'track' }))
        : [];

      const combined = [...onlinePlaylists, ...tracks];
      if (combined.length > 0) {
        renderSpotifySearchResults(combined, q, q ? `Resultados em Tudo para "${q}"` : 'Playlists Online & Maiores Sucessos');
        return;
      }
    }

    if (!q) {
      if (category === 'playlist') {
        const allFavs = await collectFavoritePlaylists().catch(() => ({ playlists: [] }));
        const localPls = (allFavs.playlists || []).map(p => ({
          id: p.name,
          title: p.name,
          creator: p.source === 'downloads' ? 'Pasta Downloads' : 'Minhas Playlists',
          nb_tracks: p.count,
          cover: p.cover || 'papaleguas_logo.png',
          isDownloaded: true,
          source: p.source,
          itemType: 'playlist',
          type: 'playlist'
        }));

        let onlinePls = [];
        try {
          const plRes = await window.torBrowserAPI.searchPlaylists('top playlists brasil');
          if (plRes && plRes.success && plRes.results) onlinePls = plRes.results;
        } catch (e) {}

        const combined = [...localPls, ...onlinePls];
        if (combined.length > 0) {
          renderSpotifyPlaylists(combined, 'playlists');
          return;
        }
      }
      const excludeTitles = typeof getSessionExcludeTitles === 'function' ? getSessionExcludeTitles() : [];
      const res = await window.torBrowserAPI.getAiMusicRecommendations('', category, excludeTitles);
      if (res && res.success && res.results && res.results.length > 0) {
        if (typeof registerSessionTracks === 'function') registerSessionTracks(res.results);
        renderSpotifySearchResults(res.results, '', res.summary || 'Hits bombando agora');
      }
      return;
    }

    // Se o filtro for 'playlist', busca playlists reais em vez de faixas soltas!
    if (category === 'playlist') {
      const allFavs = await collectFavoritePlaylists().catch(() => ({ playlists: [] }));
      const matchingLocal = (allFavs.playlists || []).filter(p => p.name.toLowerCase().includes(q.toLowerCase())).map(p => ({
        id: p.name,
        title: p.name,
        creator: p.source === 'downloads' ? 'Pasta Downloads' : 'Minhas Playlists',
        nb_tracks: p.count,
        cover: p.cover || 'papaleguas_logo.png',
        isDownloaded: true,
        source: p.source,
        itemType: 'playlist',
        type: 'playlist'
      }));

      let onlinePls = [];
      try {
        const plRes = await window.torBrowserAPI.searchPlaylists(q);
        if (plRes && plRes.success && plRes.results) onlinePls = plRes.results;
      } catch (e) {}

      const combined = [...matchingLocal, ...onlinePls];
      if (combined.length > 0) {
        renderSpotifyPlaylists(combined, q);
        return;
      }
    }

    let searchParam = q;
    if (category && category !== 'all') {
      if (category === 'artist') searchParam += ' dj';
      else if (category === 'album') searchParam += ' album';
    }
    const res = await window.torBrowserAPI.searchMusic(searchParam);
    if (res && res.success && res.results) {
      renderSpotifySearchResults(res.results, query);
    }
  } catch (e) {
    console.error('Erro na busca de músicas:', e);
  }
}

function getActiveCategory() {
  const activeChip = document.querySelector('.sp-chip.active');
  return activeChip ? activeChip.getAttribute('data-type') : 'all';
}

function isAiDjEnabled() {
  return false;
}

// Executa a busca de músicas (modo direto pelo catálogo para menus e barra de busca)
function performMusicSearch(query, category = null) {
  const cat = category || getActiveCategory();
  fetchMusicTracks(query, cat);
}

// Executa o Agente de IA para Recomendações e Busca Inteligente conforme Pesquisa e Categoria
async function fetchAiRecommendations(query, category = null) {
  const q = (query && query.trim()) ? query.trim() : (spotifySearchInput && spotifySearchInput.value.trim() ? spotifySearchInput.value.trim() : '');
  const cat = category || getActiveCategory();
  const catLabels = {
    'all': 'Geral',
    'downloaded': 'Músicas Baixadas',
    'playlist': 'Playlists',
    'track': 'Músicas',
    'artist': 'Artistas',
    'album': 'Álbuns',
    'podcast': 'Podcasts'
  };
  const catName = catLabels[cat] || cat;

  if (spAiBanner && spAiBannerStatus && spAiBannerDesc) {
    spAiBanner.classList.remove('hidden');
    spAiBannerStatus.textContent = `DJ IA • Recomendações em ${catName}`;
    spAiBannerDesc.textContent = q ? `Buscando os maiores sucessos de "${q}" em ${catName}...` : `Selecionando os maiores hits em ${catName}...`;
  }
  if (spTrackList) {
    spTrackList.innerHTML = `<div class="sp-search-placeholder">🔥 DJ IA selecionando os melhores sucessos de ${catName}...</div>`;
  }

  try {
    const excludeTitles = getSessionExcludeTitles();
    const res = await window.torBrowserAPI.getAiMusicRecommendations(q, cat, excludeTitles);
    if (res && res.success && res.results) {
      registerSessionTracks(res.results);
      renderSpotifySearchResults(res.results, q, res.summary, q || 'Hits');
    } else {
      fetchMusicTracks(q, cat);
    }
  } catch (err) {
    console.error('Erro no agente IA de música:', err);
    fetchMusicTracks(q, cat);
  }
}

if (spotifySearchInput) {
  spotifySearchInput.addEventListener('input', () => {
    // Desmarca chips de gênero ao digitar busca livre
    document.querySelectorAll('.sp-genre-btn').forEach(b => b.classList.remove('active'));
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      performMusicSearch(spotifySearchInput.value);
    }, 450);
  });

  spotifySearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.querySelectorAll('.sp-genre-btn').forEach(b => b.classList.remove('active'));
      clearTimeout(searchDebounce);
      performMusicSearch(spotifySearchInput.value);
    }
  });
}

if (btnSpClear && spotifySearchInput) {
  btnSpClear.addEventListener('click', () => {
    document.querySelectorAll('.sp-genre-btn').forEach(b => b.classList.remove('active'));
    spotifySearchInput.value = '';
    spotifySearchInput.placeholder = 'O que você quer ouvir?';
    spotifySearchInput.focus();
    performMusicSearch('');
  });
}

// Menu de Estilos Musicais (Gospel, Pop Hit, Eletrônica, Sertanejo, Funk, etc.)
const spGenreBtns = document.querySelectorAll('.sp-genre-btn');
spGenreBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const genre = btn.getAttribute('data-genre');
    const query = btn.getAttribute('data-query') || genre;
    const genreName = btn.querySelector('.sp-genre-text')?.textContent || genre;

    // Alterna o botão ativo
    const wasActive = btn.classList.contains('active');
    spGenreBtns.forEach(b => b.classList.remove('active'));

    if (wasActive) {
      currentInfiniteQuery = '';
      currentInfiniteOffset = 0;
      hasInfiniteMore = true;
      if (spotifySearchInput) {
        spotifySearchInput.value = '';
        spotifySearchInput.placeholder = 'O que você quer ouvir?';
      }
      performMusicSearch('', getActiveCategory());
      return;
    }

    btn.classList.add('active');
    currentInfiniteQuery = query;
    currentInfiniteOffset = 0;
    hasInfiniteMore = true;

    if (spotifySearchInput) {
      spotifySearchInput.value = '';
      spotifySearchInput.placeholder = `Tocando estilo: ${genreName}...`;
    }

    if (spHeroTitle && spHeroSub) {
      spHeroTitle.textContent = `${genreName.toUpperCase()} • MAIS OUVIDAS 🔥`;
      spHeroSub.textContent = `Seleção com os maiores sucessos e hits de ${genreName}`;
    }

    // Se o usuário estiver no modo de adicionar músicas, ou se a categoria for 'playlist', ajusta para 'track'
    let cat = getActiveCategory();
    if (getActiveTargetPlaylist() && cat === 'playlist') {
      cat = 'track';
      setMusicCategory('track');
    }

    // Realiza a busca no Deezer / IA com o estilo selecionado
    performMusicSearch(query, cat);
  });
});

// Controles e comportamento do Carrossel de Gêneros Musicais
const genresChipsContainer = document.getElementById('sp-genres-chips');
const btnGenresPrev = document.getElementById('btn-sp-genres-prev');
const btnGenresNext = document.getElementById('btn-sp-genres-next');

if (genresChipsContainer) {
  if (btnGenresPrev) {
    btnGenresPrev.addEventListener('click', () => {
      genresChipsContainer.scrollBy({ left: -240, behavior: 'smooth' });
    });
  }
  if (btnGenresNext) {
    btnGenresNext.addEventListener('click', () => {
      genresChipsContainer.scrollBy({ left: 240, behavior: 'smooth' });
    });
  }

  // Suporte a arrastar com o mouse (Drag to Scroll) no Carrossel no PC e Laptop
  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;
  let hasMoved = false;

  genresChipsContainer.addEventListener('mousedown', (e) => {
    isDown = true;
    hasMoved = false;
    startX = e.pageX - genresChipsContainer.offsetLeft;
    scrollLeft = genresChipsContainer.scrollLeft;
    genresChipsContainer.classList.add('is-dragging');
  });

  window.addEventListener('mouseup', () => {
    if (isDown) {
      isDown = false;
      genresChipsContainer.classList.remove('is-dragging');
    }
  });

  genresChipsContainer.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - genresChipsContainer.offsetLeft;
    const walk = (x - startX) * 1.5;
    if (Math.abs(walk) > 4) hasMoved = true;
    genresChipsContainer.scrollLeft = scrollLeft - walk;
  });

  // Previne clique acidental quando o usuário estiver arrastando o carrossel
  genresChipsContainer.addEventListener('click', (e) => {
    if (hasMoved) {
      e.stopPropagation();
      e.preventDefault();
      hasMoved = false;
    }
  }, true);
}

function escapeFavoriteText(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

async function listAllOfflineTracks() {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(OFFLINE_STORE, 'readonly');
      const get = tx.objectStore(OFFLINE_STORE).getAll();
      get.onsuccess = () => resolve(get.result || []);
      get.onerror = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
}

async function searchDownloadedAndOfflineMusic(query = '') {
  const q = String(query || '').trim().toLowerCase();
  const mergedMap = new Map();

  // 1. Busca via IPC Electron se disponível
  if (window.torBrowserAPI && typeof window.torBrowserAPI.scanDownloadedMusic === 'function') {
    try {
      const res = await window.torBrowserAPI.scanDownloadedMusic(q);
      if (res && res.success && Array.isArray(res.results)) {
        res.results.forEach(tr => {
          const k = `${String(tr.title).toLowerCase().trim()}-${String(tr.artist).toLowerCase().trim()}`;
          mergedMap.set(k, tr);
        });
      }
    } catch (e) {}
  } else {
    // 2. Fallback via rota HTTP /api/downloaded-music isolada por dispositivo
    try {
      const res = await fetch(`/api/downloaded-music?q=${encodeURIComponent(q)}&clientId=${encodeURIComponent(CLIENT_ID)}`, {
        headers: { 'X-Client-Id': CLIENT_ID }
      }).then(r => r.json()).catch(() => null);
      if (res && res.success && Array.isArray(res.results)) {
        res.results.forEach(tr => {
          const k = `${String(tr.title).toLowerCase().trim()}-${String(tr.artist).toLowerCase().trim()}`;
          mergedMap.set(k, tr);
        });
      }
    } catch (e) {}
  }

  // 3. Mescla com IndexedDB offline (faixas baixadas localmente no navegador)
  try {
    const offTracks = await listAllOfflineTracks();
    offTracks.forEach(tr => {
      const title = tr.title || 'Faixa salva';
      const artist = tr.artist || 'Papaléguas';
      const searchStr = `${title} ${artist}`.toLowerCase();
      if (!q || searchStr.includes(q)) {
        const k = `${title.toLowerCase().trim()}-${artist.toLowerCase().trim()}`;
        if (!mergedMap.has(k)) {
          if (tr.blob) {
            offlineUrlCache.set(offlineTrackKey(tr), URL.createObjectURL(tr.blob));
          }
          mergedMap.set(k, {
            id: 'idb-' + k,
            title,
            artist,
            album: 'Músicas Salvas',
            cover: tr.cover || '',
            blob: tr.blob || null,
            playlistName: '__offline__',
            source: 'device',
            isDownloaded: true,
            type: 'track',
            itemType: 'track'
          });
        }
      }
    });
  } catch (e) {}

  return Array.from(mergedMap.values());
}

async function collectFavoritePlaylists() {
  const merged = new Map();
  let diskFolder = '';

  // 1. PRIMEIRO: Lê todas as playlists salvas NO PRÓPRIO DISPOSITIVO (IndexedDB local do aparelho que baixou)
  const local = await listFavoritePlaylistRecords();
  const assignedTrackKeys = new Set();
  local.forEach((item) => {
    const key = favoritePlaylistKey(item.name);
    if (!key) return;
    const defaultCover = item.cover || (item.tracks && item.tracks[0] && (item.tracks[0].coverDataUrl || item.tracks[0].cover)) || '';
    (item.tracks || []).forEach(t => assignedTrackKeys.add(offlineTrackKey(t)));
    merged.set(key, {
      name: item.name,
      count: Array.isArray(item.tracks) ? item.tracks.length : 0,
      cover: defaultCover,
      folder: '',
      source: 'device',
      savedAt: item.savedAt || 0
    });
  });

  // 2. Se houver músicas avulsas baixadas no IndexedDB que não pertencem a nenhuma playlist,
  // agrupa-as automaticamente na playlist organizada "Músicas Baixadas"
  try {
    const allOffline = await listAllOfflineTracks();
    if (allOffline && allOffline.length > 0) {
      const unassigned = allOffline.filter(t => !assignedTrackKeys.has(offlineTrackKey(t)));
      if (unassigned.length > 0) {
        const autoKey = favoritePlaylistKey('Músicas Baixadas');
        if (!merged.has(autoKey)) {
          merged.set(autoKey, {
            name: 'Músicas Baixadas',
            count: unassigned.length,
            cover: unassigned[0].cover || 'papaleguas_logo.png',
            folder: '',
            source: 'device',
            savedAt: Date.now()
          });
        }
      }
    }
  } catch (e) {}

  // 3. Se for Desktop Host nativo (Electron com acesso ao disco local), lista as pastas do computador
  if (canSaveFavoriteOnDisk() && typeof window.torBrowserAPI.listFavoritePlaylists === 'function') {
    try {
      const disk = await window.torBrowserAPI.listFavoritePlaylists();
      if (disk && disk.folder) diskFolder = disk.folder;
      (disk && disk.playlists || []).forEach((item) => {
        const key = favoritePlaylistKey(item.name);
        if (!key) return;
        if (!merged.has(key)) {
          merged.set(key, {
            name: item.name,
            count: item.count || 0,
            cover: item.cover || '',
            folder: item.folder || disk.folder || '',
            source: item.source || 'disk',
            savedAt: item.savedAt || 0
          });
        } else {
          const existing = merged.get(key);
          if (item.count > existing.count) {
            existing.count = item.count;
          }
        }
      });
    } catch (e) {}
  }

  return { folder: diskFolder, playlists: Array.from(merged.values()) };
}

// ============================================================================
// GERENCIAMENTO DA PLAYLIST ATIVA PARA ADIÇÃO RÁPIDA DE MÚSICAS
// ============================================================================
let activeTargetPlaylist = '';
try {
  activeTargetPlaylist = localStorage.getItem('papaleguas_target_add_playlist') || '';
} catch (e) {}
const targetPlaylistTitlesSet = new Set();

function getActiveTargetPlaylist() {
  if (!activeTargetPlaylist) {
    try { activeTargetPlaylist = localStorage.getItem('papaleguas_target_add_playlist') || ''; } catch (e) {}
  }
  return activeTargetPlaylist;
}

async function updateTargetPlaylistTitlesSet() {
  const target = getActiveTargetPlaylist();
  targetPlaylistTitlesSet.clear();
  if (!target) return;
  try {
    const rec = await readFavoritePlaylistRecord(target);
    if (rec && rec.tracks) {
      rec.tracks.forEach(t => {
        if (t && t.title) targetPlaylistTitlesSet.add(t.title.trim().toLowerCase());
      });
    }
  } catch (e) {}
}

async function updateActiveTargetPlaylistBanner() {
  const banner = document.getElementById('sp-target-pl-banner');
  if (!banner) return;
  const target = getActiveTargetPlaylist();
  if (!target) {
    banner.hidden = true;
    return;
  }
  await updateTargetPlaylistTitlesSet();
  let count = 0;
  try {
    const rec = await readFavoritePlaylistRecord(target);
    count = (rec && rec.tracks) ? rec.tracks.length : 0;
  } catch (e) {}
  const titleEl = document.getElementById('sp-target-pl-title');
  if (titleEl) {
    titleEl.innerHTML = `Adicionando músicas em: <b>${escapeFavoriteText(target)}</b> (${count} música${count === 1 ? '' : 's'})`;
  }
  const dlBtn = document.getElementById('btn-sp-target-download');
  if (dlBtn) {
    dlBtn.textContent = target ? `⬇ Baixar "${target}"` : '⬇ Baixar';
    dlBtn.title = target ? `Baixar todas as músicas da playlist "${target}" no aparelho` : 'Baixar todas as músicas desta playlist no aparelho';
  }
  banner.hidden = false;
}

function setActiveTargetPlaylist(name) {
  activeTargetPlaylist = String(name || '').trim();
  try {
    if (activeTargetPlaylist) {
      localStorage.setItem('papaleguas_target_add_playlist', activeTargetPlaylist);
    } else {
      localStorage.removeItem('papaleguas_target_add_playlist');
    }
  } catch (e) {}
  updateActiveTargetPlaylistBanner();
}

function setMusicCategory(type) {
  const chips = document.querySelectorAll('.sp-chip');
  chips.forEach(c => {
    if (c.getAttribute('data-type') !== 'ai') {
      c.classList.toggle('active', c.getAttribute('data-type') === type);
    }
  });
}

let pendingTrackToQuickAdd = null;
let pendingBtnElToQuickAdd = null;

function openAddToPlaylistModal(track, btnEl) {
  pendingTrackToQuickAdd = track;
  pendingBtnElToQuickAdd = btnEl;

  const overlay = document.getElementById('sp-add-to-playlist-modal-overlay');
  if (!overlay) return;

  const thumbEl = document.getElementById('sp-add-modal-track-thumb');
  const titleEl = document.getElementById('sp-add-modal-track-title');
  const artistEl = document.getElementById('sp-add-modal-track-artist');
  const inputEl = document.getElementById('sp-add-modal-new-input');

  if (thumbEl) thumbEl.src = track.cover || 'papaleguas_logo.png';
  if (titleEl) titleEl.textContent = track.title || 'Música';
  if (artistEl) artistEl.textContent = track.artist || 'Artista';
  if (inputEl) inputEl.value = '';

  overlay.hidden = false;
  renderAddToPlaylistModalList();
  if (inputEl) setTimeout(() => inputEl.focus(), 150);
}

function closeAddToPlaylistModal() {
  const overlay = document.getElementById('sp-add-to-playlist-modal-overlay');
  if (overlay) overlay.hidden = true;
  pendingTrackToQuickAdd = null;
  pendingBtnElToQuickAdd = null;
}

async function renderAddToPlaylistModalList() {
  const listEl = document.getElementById('sp-add-modal-pl-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="color:#94a3b8;font-size:13px;padding:12px;text-align:center;">Verificando suas pastas...</div>';

  const track = pendingTrackToQuickAdd;
  if (!track) return;
  const trackKey = (track.title || '').trim().toLowerCase();

  const data = await collectFavoritePlaylists();
  const playlists = (data && data.playlists) || [];

  if (playlists.length === 0) {
    listEl.innerHTML = `
      <div style="color:#94a3b8;font-size:13px;padding:16px 12px;text-align:center;background:rgba(255,255,255,0.02);border-radius:10px;line-height:1.5;">
        Nenhuma pasta encontrada ainda.<br>Digite um nome acima para criar sua primeira pasta e salvar a música!
      </div>
    `;
    return;
  }

  // Para cada pasta salva, verifica se a música já existe nela
  const plWithStatus = await Promise.all(playlists.map(async (pl) => {
    let alreadyHas = false;
    try {
      const rec = await readFavoritePlaylistRecord(pl.name);
      if (rec && rec.tracks && Array.isArray(rec.tracks)) {
        alreadyHas = rec.tracks.some(t => {
          if (!t) return false;
          if (track.id && t.id && String(t.id) === String(track.id)) return true;
          if (t.title && t.title.trim().toLowerCase() === trackKey) return true;
          return false;
        });
      }
    } catch(e) {}
    return { ...pl, alreadyHas };
  }));

  listEl.innerHTML = plWithStatus.map(pl => `
    <div class="sp-add-pl-item ${pl.alreadyHas ? 'is-already-in' : ''}" data-pl-name="${escapeFavoriteText(pl.name)}" title="${pl.alreadyHas ? 'Esta música já está nesta pasta' : 'Clique para salvar nesta pasta'}">
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        <img src="${pl.cover || 'papaleguas_logo.png'}" onerror="this.src='papaleguas_logo.png';" style="width:38px;height:38px;border-radius:6px;object-fit:cover;flex-shrink:0;" alt="" />
        <div style="display:flex;flex-direction:column;min-width:0;">
          <span style="font-size:13.5px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeFavoriteText(pl.name)}</span>
          <span style="font-size:11.5px;color:#94a3b8;">${pl.count || 0} músicas</span>
        </div>
      </div>
      <div>
        ${pl.alreadyHas
          ? '<span class="sp-add-pl-badge-added">✓ Já nesta pasta</span>'
          : `<button type="button" class="sp-add-pl-save-btn" data-pl-save="${escapeFavoriteText(pl.name)}">Salvar Aqui ➔</button>`
        }
      </div>
    </div>
  `).join('');
}

async function executeAddTrackToSpecificPlaylist(targetPlName) {
  const track = pendingTrackToQuickAdd;
  const btnEl = pendingBtnElToQuickAdd;
  if (!track || !targetPlName) return;

  const target = targetPlName.trim();
  setActiveTargetPlaylist(target);

  const trackKey = (track.title || '').trim().toLowerCase();
  await updateTargetPlaylistTitlesSet();

  // Verifica se já existe na playlist
  if (targetPlaylistTitlesSet.has(trackKey)) {
    showDownloadNotice(`A música "${track.title}" já está na pasta "${target}".`);
    closeAddToPlaylistModal();
    if (btnEl) {
      btnEl.classList.add('is-added');
      btnEl.title = `✓ Já está na playlist "${target}"`;
      btnEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1ed760" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    }
    return;
  }

  showDownloadNotice(`Salvando "${track.title}" na pasta "${target}"...`);
  closeAddToPlaylistModal();

  if (btnEl) {
    btnEl.disabled = true;
    btnEl.classList.add('is-loading');
    btnEl.innerHTML = `<span style="font-size:14px;display:inline-block;animation:spSpin 1s infinite linear;">⏳</span>`;
    btnEl.title = `Salvando "${track.title}" em "${target}"...`;
  }

  const success = await addTrackToFavoritePlaylist(target, track, 'disk');
  if (success) {
    targetPlaylistTitlesSet.add(trackKey);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('is-loading');
      btnEl.classList.add('is-added');
      btnEl.title = `✓ Adicionada à pasta "${target}"`;
      btnEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1ed760" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    }
    showDownloadNotice(`✓ "${track.title}" adicionada em "${target}" com sucesso!`);
    await updateActiveTargetPlaylistBanner();
    updateFavoritesBtnCount();
  } else {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('is-loading');
      btnEl.title = `Tentar adicionar novamente à "${target}"`;
      btnEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    }
    showDownloadNotice(`Erro ao salvar "${track.title}". Verifique a conexão.`);
  }
}

async function executeCreateNewPlaylistAndAddTrack(newPlName) {
  const name = (newPlName || '').trim();
  if (!name) {
    showDownloadNotice('Por favor, digite o nome da nova pasta.');
    return;
  }
  const track = pendingTrackToQuickAdd;
  if (!track) return;

  try {
    if (window.torBrowserAPI && typeof window.torBrowserAPI.createFavoritePlaylist === 'function') {
      await window.torBrowserAPI.createFavoritePlaylist({ name });
    } else {
      try {
        await fetch('/api/create-favorite-playlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body: JSON.stringify({ name, clientId: CLIENT_ID })
        });
      } catch(e) {}
    }
    await saveFavoritePlaylistRecord(name, [], '');
    try { localStorage.setItem('papaleguas_last_fav_playlist', name); } catch(e) {}
    await refreshFavoritesPanel(false);
  } catch(e) {}

  await executeAddTrackToSpecificPlaylist(name);
}

async function handleQuickAddTrackToPlaylist(track, btnEl) {
  if (!track || !track.title) return;
  openAddToPlaylistModal(track, btnEl);
}

async function refreshFavoritesPanel(forceOpen) {
  const panel = document.getElementById('sp-favorites-panel');
  if (!panel) return;
  if (forceOpen) panel.hidden = false;
  if (panel.hidden) return;
  panel.innerHTML = '<div class="sp-fav-path">Lendo as playlists salvas no navegador...</div>';
  const data = await collectFavoritePlaylists();

  if (!data.playlists.length) {
    panel.innerHTML = '<div class="sp-fav-count" style="padding:24px 12px;text-align:center;color:#94a3b8;font-size:14px;">Nenhuma playlist salva no aparelho.<br><span style="font-size:12px;color:#64748b;margin-top:6px;display:inline-block;">Clique em "➕ Nova Playlist" no topo para criar sua primeira pasta.</span></div>';
    return;
  }
  panel.innerHTML = data.playlists.map((item) => {
    const isJustDl = lastDownloadedPlaylistName && (item.name.toLowerCase() === lastDownloadedPlaylistName.toLowerCase());
    return `
    <div class="sp-fav-item ${isJustDl ? 'just-downloaded' : ''}" data-fav-item-name="${escapeFavoriteText(item.name)}">
      <div class="sp-fav-main-row">
        <div class="sp-fav-thumb-wrap" title="Clique para alterar a capa desta playlist" data-fav-cover-edit="${escapeFavoriteText(item.name)}" data-fav-source="${item.source}">
          <img class="sp-fav-thumb" src="${item.cover || 'papaleguas_logo.png'}" onerror="this.src='papaleguas_logo.png';" alt="" />
          <span class="sp-fav-thumb-overlay">📷</span>
        </div>
        <div class="sp-fav-meta">
          <span class="sp-fav-name" title="${escapeFavoriteText(item.name)}">${escapeFavoriteText(item.name)}</span>
          <span class="sp-fav-count">${item.count} músicas</span>
        </div>
        <button class="sp-fav-play" type="button" data-fav-play="${escapeFavoriteText(item.name)}" data-fav-source="${item.source}" title="Tocar playlist agora">
          ▶ Ouvir
        </button>
      </div>
      <div class="sp-fav-actions">
        <button class="sp-fav-add" type="button" data-fav-add="${escapeFavoriteText(item.name)}" title="Adicionar músicas nesta playlist">➕ Add Músicas</button>
        <button class="sp-fav-download" type="button" data-fav-download="${escapeFavoriteText(item.name)}" title="Baixar todas as músicas desta playlist no aparelho com o álbum">⬇ Baixar</button>
        <button class="sp-fav-edit" type="button" data-fav-edit="${escapeFavoriteText(item.name)}" data-fav-source="${item.source}" title="Ver faixas desta playlist">👁️ Ver</button>
        <button class="sp-fav-rename-btn" type="button" data-fav-rename-btn="${escapeFavoriteText(item.name)}" data-fav-source="${item.source}" title="Renomear playlist">✏️ Renomear</button>
        <button class="sp-fav-cover-btn" type="button" data-fav-cover-btn="${escapeFavoriteText(item.name)}" data-fav-source="${item.source}" title="Alterar foto de capa / álbum">🖼️ Capa</button>
        ${item.source === 'disk' ? '<button class="sp-fav-open" type="button" data-fav-open="' + escapeFavoriteText(item.name) + '" title="Abrir pasta no computador">📁</button>' : ''}
        <button class="sp-fav-del" type="button" data-fav-del="${escapeFavoriteText(item.name)}" data-fav-source="${item.source}" title="Excluir playlist do aparelho">🗑️</button>
      </div>
    </div>
  `; }).join('');
}

async function loadSavedFavorite(name, source, autoPlay = true) {
  const panel = document.getElementById('sp-favorites-panel');
  let tracks = [];
  let playlistCover = '';

  // 1. TENTA PRIMEIRO NO DISPOSITIVO LOCAL (IndexedDB do próprio aparelho que baixou)
  const rec = await readFavoritePlaylistRecord(name);
  if (rec && Array.isArray(rec.tracks) && rec.tracks.length > 0) {
    playlistCover = rec.cover || '';
    tracks = await Promise.all(rec.tracks.map(async (track, index) => {
      let blobUrl = '';
      if (track.blob instanceof Blob) {
        blobUrl = URL.createObjectURL(track.blob);
      } else {
        const off = await readOfflineTrack(track);
        if (off && off.blob instanceof Blob) {
          blobUrl = URL.createObjectURL(off.blob);
        }
      }
      if (blobUrl) {
        offlineUrlCache.set(offlineTrackKey(track), blobUrl);
      }
      return {
        id: 'fav-device-' + index,
        title: track.title,
        artist: track.artist,
        cover: track.cover || playlistCover || '',
        file: track.file || '',
        playlistName: name,
        isDownloaded: true,
        fullStreamUrl: blobUrl || track.fullStreamUrl || '',
        blob: track.blob || null,
        preview: ''
      };
    }));
  } else if (name.toLowerCase() === 'músicas baixadas' || name.toLowerCase() === 'musicas baixadas') {
    // Carrega todas as faixas baixadas avulsas no aparelho com capas e nomes
    const allOffline = await listAllOfflineTracks();
    if (allOffline && allOffline.length > 0) {
      playlistCover = allOffline[0].cover || 'papaleguas_logo.png';
      tracks = allOffline.map((track, index) => {
        let blobUrl = '';
        if (track.blob instanceof Blob) {
          blobUrl = URL.createObjectURL(track.blob);
          offlineUrlCache.set(offlineTrackKey(track), blobUrl);
        }
        return {
          id: 'fav-auto-' + index,
          title: track.title || 'Faixa ' + (index + 1),
          artist: track.artist || 'Artista',
          cover: track.cover || playlistCover || '',
          file: track.file || '',
          playlistName: 'Músicas Baixadas',
          isDownloaded: true,
          fullStreamUrl: blobUrl || '',
          blob: track.blob || null,
          preview: ''
        };
      });
    }
  }

  // 2. Se for Desktop Host (Electron) e não encontrou no IndexedDB, lê do disco local do PC
  if (!tracks.length && window.torBrowserAPI && typeof window.torBrowserAPI.getFavoritePlaylist === 'function') {
    const res = await window.torBrowserAPI.getFavoritePlaylist(name);
    playlistCover = (res && res.cover) || '';
    tracks = (res && res.tracks || []).map((track, index) => ({
      id: 'fav-' + index + '-' + track.file,
      title: track.title,
      artist: track.artist,
      cover: track.cover || playlistCover || '',
      file: track.file,
      playlistName: track.playlistName || (res && res.name) || name,
      isDownloaded: true,
      fullStreamUrl: track.fullStreamUrl || '',
      preview: ''
    }));
  }

  if (!tracks.length) {
    if (autoPlay) showDownloadNotice('Não encontrei as músicas dessa playlist no aparelho.');
    return false;
  }
  try { localStorage.setItem('papaleguas_last_fav_playlist', name); } catch(e) {}
  if (panel) panel.hidden = true;
  closePlaylistsMenuModal();
  showSelectedPlaylist(name, true, source);
  renderSpotifySearchResults(tracks, name, null, name, true, source);
  if (spHeroTitle) spHeroTitle.textContent = name;
  if (spHeroSub) spHeroSub.textContent = 'Minhas playlists favoritas • ' + tracks.length + ' músicas no aparelho';
  if (spHeroImg) {
    spHeroImg.src = playlistCover || (tracks[0] && tracks[0].cover) || 'papaleguas_logo.png';
  }
  
  if (autoPlay) {
    document.body.classList.remove('is-editing-playlist');
    playTrackAtIndex(0);
  } else {
    document.body.classList.add('is-editing-playlist');
    currentTrackIndex = 0;
    const first = tracks[0];
    if (first) {
      if (spMiniThumb) {
        const thumbFallback = spMiniThumb.getAttribute('data-fallback') || '';
        spMiniThumb.src = first.cover || thumbFallback;
      }
      if (spMiniTitle) spMiniTitle.textContent = first.title;
      if (spMiniArtist) spMiniArtist.textContent = first.artist;
      if (spHeroImg && first.cover) spHeroImg.src = first.cover;
      if (spHeroTitle && first.title) spHeroTitle.textContent = first.title;
      if (spHeroSub && first.artist) spHeroSub.innerHTML = `<span>▶ Pronta para tocar • ${first.artist}</span>`;
      if (spBottomPlayer) spBottomPlayer.classList.add('visible');
    }
  }
  return true;
}

async function playSavedFavorite(name, source) {
  const isAlreadyPlayingThisPlaylist = (window.playingPlaylistName && window.playingPlaylistName.toLowerCase() === String(name || '').trim().toLowerCase());
  return loadSavedFavorite(name, source, !isAlreadyPlayingThisPlaylist);
}

async function checkAndLoadDownloadedOnStartup() {
  try {
    const data = await collectFavoritePlaylists();
    const btnFav = document.getElementById('btn-sp-favorites');
    if (data && data.playlists && data.playlists.length > 0) {
      if (btnFav) {
        btnFav.textContent = `📁 Playlists (${data.playlists.length}) ▾`;
      }
      return;
    }

    const allOffline = await listAllOfflineTracks();
    if (allOffline && allOffline.length > 0 && btnFav) {
      btnFav.textContent = `📁 Playlists (${allOffline.length}) ▾`;
    }
  } catch (e) {}
}

async function updateFavoritesBtnCount() {
  try {
    const data = await collectFavoritePlaylists();
    const btnFav = document.getElementById('btn-sp-favorites');
    if (btnFav) {
      const count = (data && data.playlists) ? data.playlists.length : 0;
      btnFav.textContent = count > 0 ? `📁 Playlists (${count}) ▾` : '📁 Playlists ▾';
    }
  } catch(e) {}
}

let isCreatingPlaylist = false;
async function createNewFavoritePlaylist() {
  if (isCreatingPlaylist) return;
  isCreatingPlaylist = true;
  try {
    const name = prompt('Digite o nome da nova playlist / pasta:');
    if (!name) return;
    const cleanName = name.trim();
    if (!cleanName) return;

    if (window.torBrowserAPI && typeof window.torBrowserAPI.createFavoritePlaylist === 'function') {
      const res = await window.torBrowserAPI.createFavoritePlaylist({ name: cleanName });
      if (res && res.error) {
        showDownloadNotice('Aviso: ' + res.error);
      }
    } else {
      try {
        await fetch('/api/create-favorite-playlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body: JSON.stringify({ name: cleanName, clientId: CLIENT_ID })
        });
      } catch (e) {}
    }

    await saveFavoritePlaylistRecord(cleanName, [], '');
    try { localStorage.setItem('papaleguas_last_fav_playlist', cleanName); } catch(e) {}

    // Define a nova playlist como alvo ativo para adicionar músicas
    setActiveTargetPlaylist(cleanName);

    // Fecha o modal de menu de playlists e o painel de favoritos
    closePlaylistsMenuModal();
    const favPanel = document.getElementById('sp-favorites-panel');
    if (favPanel) favPanel.hidden = true;

    // Fecha modal de relacionadas se estiver aberto e sai do modo de edição
    stopModalPreview();
    const relModal = document.getElementById('sp-related-modal-overlay');
    if (relModal) relModal.hidden = true;
    document.body.classList.remove('is-editing-playlist');

    // Volta para a tela inicial do Papaléguas Music com todos os gêneros e músicas
    showSelectedPlaylist('');
    isCurrentPlaylistFavorite = false;
    selectedPlaylistName = '';
    selectedPlaylistSource = '';

    // Ativa a categoria 'track' (Músicas) para exibir faixas soltas com o botão [+]
    setMusicCategory('track');

    await refreshFavoritesPanel(false);
    updateFavoritesBtnCount();
    await updateActiveTargetPlaylistBanner();

    showDownloadNotice(`Playlist "${cleanName}" criada com sucesso! Toque no [+] para adicionar músicas.`);

    // Carrega músicas da tela principal imediatamente
    performMusicSearch('', 'track');

    // Rola suavemente para a barra de gêneros musicais para facilitar a navegação por estilos
    const genresBar = document.getElementById('sp-genres-bar');
    if (genresBar) {
      genresBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch (err) {
    console.error('Erro ao criar nova playlist:', err);
    showDownloadNotice('Erro ao criar playlist: ' + (err.message || 'desconhecido'));
  } finally {
    setTimeout(() => { isCreatingPlaylist = false; }, 400);
  }
}

async function deleteEntireFavoritePlaylist(name, source) {
  if (!name) return;
  const ok = confirm(`Tem certeza que deseja excluir a playlist "${name}" e todas as suas músicas salvas no aparelho?`);
  if (!ok) return;

  try {
    // 1. Notifica o servidor para apagar pastas no disco, Minhas playlists favoritas, Downloads e zips
    try {
      await fetch('/api/delete-favorite-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
        body: JSON.stringify({ name, clientId: CLIENT_ID, source })
      });
    } catch (e) {}

    // 2. Se rodando no Electron, executa também a API IPC nativa
    if (window.torBrowserAPI && typeof window.torBrowserAPI.deleteFavoritePlaylist === 'function') {
      try {
        await window.torBrowserAPI.deleteFavoritePlaylist(name);
      } catch (errDisk) {
        console.warn('Erro ao deletar playlist do disco via Electron:', errDisk);
      }
    }

    // 3. Deleta registros do banco local IndexedDB
    await deleteFavoritePlaylistRecord(name);
    try {
      await removeOfflineTracksForPlaylist(name);
    } catch (e) {}
    
    // 4. Remove imediatamente do DOM do painel Minhas Playlists se ele estiver aberto
    const panel = document.getElementById('sp-favorites-panel');
    if (panel) {
      const itemEl = panel.querySelector(`[data-fav-item-name="${escapeFavoriteText(name)}"]`);
      if (itemEl) itemEl.remove();
    }

    // 5. Se a playlist excluída era a atualmente exibida na tela
    if (selectedPlaylistName && selectedPlaylistName.toLowerCase() === name.toLowerCase()) {
      showSelectedPlaylist('');
      if (spTrackList) spTrackList.innerHTML = '<div class="sp-search-placeholder">Playlist excluída com sucesso. Escolha outra playlist ou crie uma nova.</div>';
      if (spHeroCard) spHeroCard.style.display = 'none';
      currentTracksList = [];
      selectedPlaylistName = '';
      selectedPlaylistSource = '';
      document.body.classList.remove('is-editing-playlist');
    }

    await refreshFavoritesPanel(false);
    updateFavoritesBtnCount();
    showDownloadNotice(`Playlist "${name}" excluída com sucesso.`);
  } catch (e) {
    console.error('Erro ao excluir playlist:', e);
    showDownloadNotice('Erro ao excluir playlist: ' + (e.message || 'desconhecido'));
  }
}

async function deleteTrackFromFavoritePlaylist(playlistName, track, rowEl, source) {
  if (!playlistName || !track) return;
  const trackTitle = track.title || 'esta música';
  const ok = confirm(`Deseja remover "${trackTitle}" desta playlist favorita?`);
  if (!ok) return;

  try {
    if ((source === 'disk' || source === 'downloads' || window.torBrowserAPI) && track.file && window.torBrowserAPI && typeof window.torBrowserAPI.deleteFavoriteTrack === 'function') {
      await window.torBrowserAPI.deleteFavoriteTrack(playlistName, track.file);
    } else if (track.file) {
      try {
        await fetch('/api/delete-favorite-track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body: JSON.stringify({ playlist: playlistName, file: track.file, clientId: CLIENT_ID })
        });
      } catch (e) {}
    }
    await deleteFavoriteTrackFromRecord(playlistName, track.title, track.artist, track.file);

    // Remove do array local
    currentTracksList = currentTracksList.filter(t => t !== track && t.id !== track.id && (track.file ? t.file !== track.file : true));
    
    if (rowEl) {
      rowEl.style.transition = 'all 0.3s ease';
      rowEl.style.opacity = '0';
      rowEl.style.transform = 'translateX(20px)';
      setTimeout(() => { if (rowEl && rowEl.parentNode) rowEl.remove(); }, 300);
    }
    if (spHeroSub) {
      spHeroSub.textContent = 'Minhas playlists favoritas • ' + currentTracksList.length + ' músicas no aparelho';
    }
    showDownloadNotice(`"${trackTitle}" removida da playlist.`);
    updateFavoritesBtnCount();
    refreshFavoritesPanel(false);
  } catch (e) {
    console.error('Erro ao excluir faixa:', e);
    showDownloadNotice('Erro ao remover faixa: ' + (e.message || 'desconhecido'));
  }
}

async function renameFavoritePlaylist(oldName, source) {
  if (!oldName) return;
  const modal = document.getElementById('sp-rename-modal-overlay');
  const input = document.getElementById('sp-rename-input');
  const form = document.getElementById('sp-rename-form');
  const btnClose = document.getElementById('btn-sp-rename-modal-close');
  const btnCancel = document.getElementById('btn-sp-rename-cancel');

  const doRename = async (newName) => {
    const trimmed = String(newName || '').trim();
    if (!trimmed || trimmed === oldName) return;

    try {
      if (window.torBrowserAPI && typeof window.torBrowserAPI.renameFavoritePlaylist === 'function') {
        const res = await window.torBrowserAPI.renameFavoritePlaylist({ oldName, newName: trimmed });
        if (res && !res.success && res.error) {
          showDownloadNotice('Aviso: ' + res.error);
          return;
        }
      } else {
        await fetch('/api/rename-favorite-playlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body: JSON.stringify({ oldName, newName: trimmed, clientId: CLIENT_ID })
        }).catch(() => null);
      }

      // Atualiza no IndexedDB
      const rec = await readFavoritePlaylistRecord(oldName);
      if (rec) {
        await deleteFavoritePlaylistRecord(oldName);
        await saveFavoritePlaylistRecord(trimmed, rec.tracks || [], rec.cover || '');
      }

      // Se a playlist ativa for a que foi renomeada, atualiza interface
      if (selectedPlaylistName && selectedPlaylistName.toLowerCase() === oldName.toLowerCase()) {
        selectedPlaylistName = trimmed;
        const nameEl = document.getElementById('sp-selected-playlist-name');
        if (nameEl) nameEl.textContent = trimmed + (isCurrentPlaylistFavorite ? ' (Favorita)' : '');
        if (spHeroTitle) spHeroTitle.textContent = trimmed;
      }

      await refreshFavoritesPanel(false);
      showDownloadNotice(`Playlist renomeada para "${trimmed}" com sucesso!`);
    } catch (err) {
      console.error('Erro ao renomear playlist:', err);
      showDownloadNotice('Erro ao renomear playlist: ' + (err.message || 'desconhecido'));
    }
  };

  if (modal && input) {
    input.value = oldName;
    modal.hidden = false;
    input.focus();
    input.select();

    const closeModal = () => { modal.hidden = true; };
    if (btnClose) btnClose.onclick = closeModal;
    if (btnCancel) btnCancel.onclick = closeModal;
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const val = input.value;
        closeModal();
        await doRename(val);
      };
    }
  } else {
    const newName = prompt(`Digite o novo nome para "${oldName}":`, oldName);
    if (newName) await doRename(newName);
  }
}

async function openEditTrackModal(track, rowEl, playlistName, source) {
  if (!track) return;
  const modal = document.getElementById('sp-edit-track-modal-overlay');
  const titleInput = document.getElementById('sp-edit-track-title-input');
  const artistInput = document.getElementById('sp-edit-track-artist-input');
  const form = document.getElementById('sp-edit-track-form');
  const btnClose = document.getElementById('btn-sp-edit-track-close');
  const btnCancel = document.getElementById('btn-sp-edit-track-cancel');

  const currentTitle = track.title || '';
  const currentArtist = track.artist || '';

  const doSave = async (newTitle, newArtist) => {
    const t = String(newTitle || '').trim();
    const a = String(newArtist || '').trim();
    if (!t) {
      showDownloadNotice('O título da música não pode ficar vazio.');
      return;
    }

    try {
      track.title = t;
      track.artist = a || 'Artista';

      if (window.torBrowserAPI && typeof window.torBrowserAPI.editFavoriteTrack === 'function') {
        await window.torBrowserAPI.editFavoriteTrack({
          playlist: playlistName,
          file: track.file,
          newTitle: t,
          newArtist: a
        });
      } else {
        await fetch('/api/edit-favorite-track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body: JSON.stringify({ playlist: playlistName, file: track.file, newTitle: t, newArtist: a, clientId: CLIENT_ID })
        }).catch(() => null);
      }

      // Atualiza no IndexedDB
      const rec = await readFavoritePlaylistRecord(playlistName);
      if (rec && Array.isArray(rec.tracks)) {
        const item = rec.tracks.find(x => x.file === track.file || (x.title === currentTitle && x.artist === currentArtist));
        if (item) {
          item.title = t;
          item.artist = a;
          await saveFavoritePlaylistRecord(playlistName, rec.tracks, rec.cover);
        }
      }

      // Atualiza no DOM da linha
      if (rowEl) {
        const nameEl = rowEl.querySelector('.sp-track-name');
        const artistEl = rowEl.querySelector('.sp-track-artist');
        if (nameEl) nameEl.textContent = t;
        if (artistEl) artistEl.textContent = a;
      }

      // Se estiver tocando essa música no player ativo agora
      if (currentTracksList[currentTrackIndex] === track || (currentTracksList[currentTrackIndex] && currentTracksList[currentTrackIndex].file === track.file)) {
        if (spMiniTitle) spMiniTitle.textContent = t;
        if (spMiniArtist) spMiniArtist.textContent = a;
        if (spHeroTitle) spHeroTitle.textContent = t;
        if (spHeroSub) spHeroSub.textContent = a;
      }

      showDownloadNotice(`Música atualizada para "${t}" - ${a}!`);
    } catch (err) {
      console.error('Erro ao editar música:', err);
      showDownloadNotice('Erro ao salvar edição: ' + (err.message || 'desconhecido'));
    }
  };

  if (modal && titleInput && artistInput) {
    titleInput.value = currentTitle;
    artistInput.value = currentArtist;
    modal.hidden = false;
    titleInput.focus();

    const closeModal = () => { modal.hidden = true; };
    if (btnClose) btnClose.onclick = closeModal;
    if (btnCancel) btnCancel.onclick = closeModal;
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const tVal = titleInput.value;
        const aVal = artistInput.value;
        closeModal();
        await doSave(tVal, aVal);
      };
    }
  } else {
    const newT = prompt('Título da música:', currentTitle);
    if (newT !== null) {
      const newA = prompt('Artista:', currentArtist);
      await doSave(newT, newA);
    }
  }
}

let modalPreviewAudio = null;
let currentPreviewBtn = null;
let previewTimeoutTimer = null;

function stopModalPreview() {
  if (modalPreviewAudio) {
    try {
      modalPreviewAudio.pause();
      modalPreviewAudio.currentTime = 0;
      modalPreviewAudio.src = '';
    } catch (e) {}
  }
  if (previewTimeoutTimer) {
    clearTimeout(previewTimeoutTimer);
    previewTimeoutTimer = null;
  }
  if (currentPreviewBtn) {
    currentPreviewBtn.classList.remove('playing');
    currentPreviewBtn.classList.remove('is-loading');
    currentPreviewBtn.innerHTML = '▶ Prévia 30s';
    currentPreviewBtn = null;
  }
  document.querySelectorAll('.sp-related-item.is-previewing, .sp-related-item.is-loading').forEach(el => {
    el.classList.remove('is-previewing', 'is-loading');
  });
}

function playTrackPreview30s(track, btnEl) {
  if (!track || !btnEl) return;

  if (currentPreviewBtn === btnEl && modalPreviewAudio && !modalPreviewAudio.paused) {
    stopModalPreview();
    return;
  }

  stopModalPreview();

  if (spotifyPreviewAudio && !spotifyPreviewAudio.paused) {
    try { spotifyPreviewAudio.pause(); } catch(e) {}
    updateBottomPlayerState(false);
  }

  if (!modalPreviewAudio) {
    modalPreviewAudio = new Audio();
  }

  currentPreviewBtn = btnEl;
  btnEl.classList.remove('playing');
  btnEl.classList.add('is-loading');
  btnEl.innerHTML = '<span class="sp-preview-spinner"></span> Carregando...';

  const parentItem = btnEl.closest('.sp-related-item');
  if (parentItem) {
    parentItem.classList.remove('is-previewing');
    parentItem.classList.add('is-loading');
  }

  const rawPreview = (track.preview || '').trim();
  const fallbackStream = track.fullStreamUrl || `/api/stream-audio?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist)}`;
  const previewSrc = resolveMediaUrl(rawPreview || fallbackStream);
  let triedFallback = !rawPreview || rawPreview === fallbackStream;

  modalPreviewAudio.src = previewSrc;

  modalPreviewAudio.onplaying = () => {
    if (currentPreviewBtn !== btnEl) return;
    btnEl.classList.remove('is-loading');
    btnEl.classList.add('playing');
    btnEl.innerHTML = '⏸ Pausar 30s';
    if (parentItem) {
      parentItem.classList.remove('is-loading');
      parentItem.classList.add('is-previewing');
    }
  };

  modalPreviewAudio.ontimeupdate = () => {
    if (modalPreviewAudio && modalPreviewAudio.currentTime >= 30) {
      stopModalPreview();
    }
  };

  modalPreviewAudio.onended = () => {
    stopModalPreview();
  };

  const handlePreviewError = () => {
    if (!triedFallback) {
      triedFallback = true;
      console.warn('[PREVIEW] Deezer preview indisponível, usando stream alternativo:', track.title);
      modalPreviewAudio.src = resolveMediaUrl(fallbackStream);
      modalPreviewAudio.play().catch(() => {
        stopModalPreview();
        showDownloadNotice('Prévia não disponível para esta música.');
      });
      return;
    }
    stopModalPreview();
    showDownloadNotice('Prévia não disponível para esta música.');
  };

  modalPreviewAudio.onerror = handlePreviewError;

  modalPreviewAudio.play().catch(err => {
    console.warn('[PREVIEW] Falha ou atraso no início da prévia:', err);
    if (!triedFallback) {
      handlePreviewError();
    } else {
      stopModalPreview();
    }
  });

  previewTimeoutTimer = setTimeout(() => {
    stopModalPreview();
  }, 32000);
}

function openAddRelatedModal() {
  document.body.classList.add('is-editing-playlist');
  stopModalPreview();
  const modal = document.getElementById('sp-related-modal-overlay');
  const titleEl = document.getElementById('sp-related-modal-title');
  const subtitleEl = document.getElementById('sp-related-modal-subtitle');
  const inputEl = document.getElementById('sp-related-search-input');
  if (!modal) return;
  modal.hidden = false;

  const plName = selectedPlaylistName || 'Playlist';
  if (titleEl) {
    titleEl.textContent = `✨ Músicas para "${plName}"`;
  }
  if (subtitleEl) {
    subtitleEl.textContent = 'Ouça a prévia de 30s e adicione novas faixas ao seu aparelho';
  }

  // Define um termo de busca inteligente baseado no estilo da playlist ou artistas
  let queryTerm = plName;
  const artists = currentTracksList
    .map(t => (t.artist || '').trim())
    .filter(a => a && a !== 'Artista' && a !== 'Desconhecido' && a !== 'Deezer' && a !== 'Spotify');
  
  if (artists.length > 0) {
    const sampleArtist = artists[Math.floor(Math.random() * Math.min(artists.length, 4))];
    if (queryTerm.toLowerCase().includes('playlist') || queryTerm.length < 3) {
      queryTerm = sampleArtist;
    } else if (!queryTerm.toLowerCase().includes(sampleArtist.toLowerCase())) {
      queryTerm = `${queryTerm} ${sampleArtist}`;
    }
  }

  if (inputEl) {
    inputEl.value = queryTerm;
  }
  searchAndRenderRelatedTracks(queryTerm);
}

async function searchAndRenderRelatedTracks(query) {
  const listEl = document.getElementById('sp-related-tracks-list');
  if (!listEl) return;
  const cleanQ = String(query || '').trim();
  if (!cleanQ) {
    listEl.innerHTML = '<div class="sp-related-loading">Digite o nome de uma música, cantor ou estilo para buscar...</div>';
    return;
  }

  listEl.innerHTML = `<div class="sp-related-loading">Buscando músicas para "${escapeFavoriteText(cleanQ)}"...</div>`;

  try {
    let tracks = [];
    if (window.torBrowserAPI && typeof window.torBrowserAPI.getAiMusicRecommendations === 'function') {
      const res = await window.torBrowserAPI.getAiMusicRecommendations(cleanQ, 'all', []);
      tracks = (res && res.results) || [];
    } else {
      const res = await fetch(`/api/recommendations?q=${encodeURIComponent(cleanQ)}&cat=all&clientId=${encodeURIComponent(CLIENT_ID)}`);
      const data = await res.json();
      tracks = (data && data.results) || [];
    }

    const existingTitles = new Set(
      currentTracksList.map(t => (t.title || '').toLowerCase().trim())
    );

    if (!tracks || tracks.length === 0) {
      listEl.innerHTML = `<div class="sp-related-loading">Nenhuma música encontrada para "${escapeFavoriteText(cleanQ)}". Tente outros termos.</div>`;
      return;
    }

    listEl.innerHTML = tracks.map((track, i) => {
      const alreadyIn = existingTitles.has((track.title || '').toLowerCase().trim());
      return `
        <div class="sp-related-item" data-index="${i}">
          <img class="sp-related-thumb" src="${track.cover || 'papaleguas_logo.png'}" onerror="this.src='papaleguas_logo.png';" alt="" />
          <div class="sp-related-meta">
            <span class="sp-related-name" title="${escapeFavoriteText(track.title)}">${escapeFavoriteText(track.title)}</span>
            <span class="sp-related-artist" title="${escapeFavoriteText(track.artist)}">${escapeFavoriteText(track.artist)}</span>
          </div>
          <div class="sp-related-actions">
            <button class="sp-related-preview-btn" type="button" title="Ouvir 30 segundos de amostra antes de adicionar">
              ▶ Prévia 30s
            </button>
            <button class="sp-related-add-btn" type="button" ${alreadyIn ? 'disabled' : ''}>
              ${alreadyIn ? '✓ Já na playlist' : '+ Adicionar'}
            </button>
          </div>
        </div>
      `;
    }).join('');

    const items = listEl.querySelectorAll('.sp-related-item');
    items.forEach((itemEl) => {
      const idx = parseInt(itemEl.getAttribute('data-index'), 10);
      const track = tracks[idx];
      const previewBtn = itemEl.querySelector('.sp-related-preview-btn');
      const addBtn = itemEl.querySelector('.sp-related-add-btn');

      if (previewBtn && track) {
        previewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          playTrackPreview30s(track, previewBtn);
        });
      }

      itemEl.addEventListener('click', (e) => {
        if (e.target.closest('.sp-related-add-btn') || e.target.closest('.sp-related-preview-btn')) return;
        if (previewBtn && track) {
          playTrackPreview30s(track, previewBtn);
        }
      });

      if (addBtn && track && !addBtn.disabled) {
        addBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          stopModalPreview();
          addBtn.disabled = true;
          addBtn.textContent = '⏳ Baixando...';
          const success = await addTrackToFavoritePlaylist(selectedPlaylistName, track, selectedPlaylistSource);
          if (success) {
            addBtn.textContent = '✓ Adicionada!';
            addBtn.style.background = 'rgba(30, 215, 96, 0.2)';
            addBtn.style.color = '#1ed760';
          } else {
            addBtn.disabled = false;
            addBtn.textContent = 'Erro ao baixar';
          }
        });
      }
    });
  } catch (err) {
    console.error('Erro ao buscar músicas relacionadas:', err);
    listEl.innerHTML = `<div class="sp-related-loading">Erro na busca: ${escapeFavoriteText(err.message || 'Falha de conexão')}</div>`;
  }
}

async function addTrackToFavoritePlaylist(playlistName, track, source) {
  if (!playlistName || !track) return false;
  try {
    const url = track.fullStreamUrl || `/api/stream-audio?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Não foi possível obter áudio');
    const blob = await res.blob();
    if (!blob || blob.size < 40000) throw new Error('Áudio incompleto');
    
    const ext = audioExtension(blob);
    const fileName = String(currentTracksList.length + 1).padStart(2, '0') + ' - ' + safeDownloadName(track.artist, 'Artista') + ' - ' + safeDownloadName(track.title, 'Faixa') + '.' + ext;
    const data = new Uint8Array(await blob.arrayBuffer());
    
    const saveOnDisk = canSaveFavoriteOnDisk() && (source === 'disk' || window.torBrowserAPI);
    let savedFile = fileName;

    // Baixa também a capa da música
    const coverObj = await fetchCoverAsBlobAndDataUrl(track.cover);
    const coverData = coverObj ? coverObj.data : null;
    const coverDataUrl = coverObj ? coverObj.dataUrl : '';
    const coverMime = coverObj ? coverObj.mime : 'image/jpeg';

    const saved = {
      title: track.title,
      artist: track.artist,
      cover: coverDataUrl || track.cover || '',
      coverDataUrl,
      file: fileName,
      blob
    };
    await saveOfflineTrack(saved, blob);
    
    if (saveOnDisk && window.torBrowserAPI && typeof window.torBrowserAPI.saveFavoriteTrack === 'function') {
      const written = await window.torBrowserAPI.saveFavoriteTrack({
        playlist: playlistName,
        fileName,
        title: track.title,
        artist: track.artist,
        cover: track.cover || '',
        coverData,
        coverMime,
        data
      });
      if (written && written.success && written.file) {
        savedFile = written.file;
      }
    }
    
    // Atualiza IndexedDB
    const existingRec = (await readFavoritePlaylistRecord(playlistName)) || { name: playlistName, tracks: [] };
    const newTrackRecord = {
      title: track.title,
      artist: track.artist,
      cover: coverDataUrl || track.cover || '',
      file: savedFile,
      blob
    };
    existingRec.tracks.push(newTrackRecord);
    if (!existingRec.cover) {
      existingRec.cover = coverDataUrl || track.cover || '';
    }
    existingRec.savedAt = Date.now();
    await saveFavoritePlaylistRecord(playlistName, existingRec.tracks, existingRec.cover);
    
    // Atualiza índice no disco se Electron
    if (saveOnDisk && window.torBrowserAPI && typeof window.torBrowserAPI.saveFavoritePlaylistIndex === 'function') {
      await window.torBrowserAPI.saveFavoritePlaylistIndex({
        name: playlistName,
        cover: existingRec.cover,
        tracks: existingRec.tracks.map(t => ({
          title: t.title,
          artist: t.artist,
          cover: t.cover,
          coverFile: t.file.replace(/\.[^.]+$/, '.jpg'),
          file: t.file
        }))
      });
    } else {
      try {
        fetch('/api/create-favorite-playlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body: JSON.stringify({
            name: playlistName,
            cover: existingRec.cover,
            clientId: CLIENT_ID,
            tracks: existingRec.tracks.map(t => ({
              title: t.title,
              artist: t.artist,
              album: playlistName,
              cover: t.cover || existingRec.cover,
              file: t.file
            }))
          })
        }).catch(() => null);
      } catch(e) {}
    }
    
    // Adiciona ao cache offline em memória para reprodução instantânea sem internet
    const memTrack = {
      id: 'fav-added-' + Date.now(),
      title: track.title,
      artist: track.artist,
      cover: coverDataUrl || track.cover || '',
      file: savedFile,
      playlistName: playlistName,
      preview: ''
    };
    offlineUrlCache.set(offlineTrackKey(memTrack), URL.createObjectURL(blob));
    
    // Adiciona na lista atual de faixas em exibição APENAS se a tela estiver exibindo esta playlist favorita
    if (isCurrentPlaylistFavorite && selectedPlaylistName === playlistName && spTrackList) {
      currentTracksList.push(memTrack);
      const newIdx = currentTracksList.length - 1;
      const row = document.createElement('div');
      row.className = 'sp-track-row';
      row.setAttribute('data-id', memTrack.id);
      row.innerHTML = `
        <img class="sp-track-thumb" src="${memTrack.cover || 'papaleguas_logo.png'}" onerror="this.src='papaleguas_logo.png';" alt="" />
        <div class="sp-track-meta">
          <span class="sp-track-name" title="${escapeFavoriteText(memTrack.title)}">${escapeFavoriteText(memTrack.title)}</span>
          <span class="sp-track-artist" title="${escapeFavoriteText(memTrack.artist)}">${escapeFavoriteText(memTrack.artist)}</span>
        </div>
        <div class="sp-track-actions">
          <button class="sp-track-del-btn" title="Excluir música desta playlist" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      `;
      row.querySelector('.sp-track-del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTrackFromFavoritePlaylist(playlistName, memTrack, row, source);
      });
      row.addEventListener('click', () => {
        playTrackAtIndex(newIdx);
      });
      spTrackList.appendChild(row);
      if (spHeroSub) {
        spHeroSub.textContent = 'Minhas playlists favoritas • ' + currentTracksList.length + ' músicas no aparelho';
      }
    }
    showDownloadNotice(`"${track.title}" adicionada com sucesso!`);
    updateFavoritesBtnCount();
    triggerPlaylistDownloadedVibration(playlistName);
    return true;
  } catch (err) {
    console.error('Erro ao adicionar música à playlist favorita:', err);
    return false;
  }
}

// Filtros de Categoria (Tudo, Playlists, Músicas, Artistas, Álbuns, Podcasts) e Botão IA Recomenda
const btnDownloadPlaylist = document.getElementById('btn-sp-download-playlist');
if (btnDownloadPlaylist) {
  btnDownloadPlaylist.addEventListener('click', () => { downloadPlaylistToDevice(); });
}

function openPlaylistsMenuModal() {
  const overlay = document.getElementById('sp-playlists-modal-overlay');
  if (overlay) {
    overlay.hidden = false;
    refreshFavoritesPanel(true);
  }
}

function closePlaylistsMenuModal() {
  const overlay = document.getElementById('sp-playlists-modal-overlay');
  if (overlay) overlay.hidden = true;
}

const btnPlaylistsModalClose = document.getElementById('btn-sp-playlists-modal-close');
if (btnPlaylistsModalClose) {
  btnPlaylistsModalClose.addEventListener('click', closePlaylistsMenuModal);
}

const playlistsModalOverlay = document.getElementById('sp-playlists-modal-overlay');
if (playlistsModalOverlay) {
  playlistsModalOverlay.addEventListener('click', (e) => {
    if (e.target === playlistsModalOverlay) closePlaylistsMenuModal();
  });
}

const btnMenuExplorePl = document.getElementById('btn-sp-menu-explore-pl');
if (btnMenuExplorePl) {
  btnMenuExplorePl.addEventListener('click', () => {
    closePlaylistsMenuModal();
    setMusicCategory('playlist');
    const q = (spotifySearchInput && spotifySearchInput.value.trim()) || '';
    performMusicSearch(q, 'playlist');
  });
}

const btnBackFromPlaylist = document.getElementById('btn-sp-back-from-playlist');
if (btnBackFromPlaylist) {
  btnBackFromPlaylist.addEventListener('click', () => {
    showSelectedPlaylist('');
    document.body.classList.remove('is-editing-playlist');
    setMusicCategory('all');
    performMusicSearch('', 'all');
  });
}

const btnHeaderAddMore = document.getElementById('btn-sp-header-add-more');
if (btnHeaderAddMore) {
  btnHeaderAddMore.addEventListener('click', () => {
    if (selectedPlaylistName) {
      setActiveTargetPlaylist(selectedPlaylistName);
      setMusicCategory('track');
      showDownloadNotice(`Adicionando músicas em "${selectedPlaylistName}". Toque no [+] abaixo.`);
      performMusicSearch('', 'track');
      const genresBar = document.getElementById('sp-genres-bar');
      if (genresBar) genresBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

const btnFavorites = document.getElementById('btn-sp-favorites');
const favoritesPanel = document.getElementById('sp-favorites-panel');
if (btnFavorites) {
  btnFavorites.addEventListener('click', () => {
    const overlay = document.getElementById('sp-playlists-modal-overlay');
    if (overlay && !overlay.hidden) {
      closePlaylistsMenuModal();
    } else {
      openPlaylistsMenuModal();
    }
  });
}

const allCreatePlBtns = document.querySelectorAll('.sp-create-pl-btn, #btn-sp-create-playlist');
allCreatePlBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    createNewFavoritePlaylist();
  });
});

async function downloadTargetPlaylist(name) {
  const plName = name || getActiveTargetPlaylist() || selectedPlaylistName;
  if (!plName) {
    showDownloadNotice('Nenhuma playlist selecionada para baixar.');
    return;
  }
  let tracks = [];
  const rec = await readFavoritePlaylistRecord(plName);
  if (rec && rec.tracks && rec.tracks.length > 0) {
    tracks = rec.tracks;
  } else if (selectedPlaylistName === plName && currentTracksList && currentTracksList.length > 0) {
    tracks = currentTracksList;
  }
  if (!tracks.length) {
    showDownloadNotice(`A playlist "${plName}" ainda não possui músicas. Adicione músicas pelo [+] antes de baixar.`);
    return;
  }
  showDownloadNotice(`Iniciando download da playlist "${plName}" (${tracks.length} músicas)...`);
  downloadQueue.push({ name: plName, list: tracks });
  if (!downloadBusy) {
    runDownloadQueue();
  }
}

const btnTargetDownload = document.getElementById('btn-sp-target-download');
if (btnTargetDownload) {
  btnTargetDownload.addEventListener('click', (e) => {
    e.stopPropagation();
    downloadTargetPlaylist();
  });
}

if (favoritesPanel) {
  favoritesPanel.addEventListener('click', (event) => {
    const createBtn = event.target.closest('[data-action="create-new-pl"]');
    if (createBtn) {
      createNewFavoritePlaylist();
      return;
    }
    const dlBtn = event.target.closest('[data-fav-download]');
    if (dlBtn) {
      const plName = dlBtn.getAttribute('data-fav-download');
      if (plName) {
        closePlaylistsMenuModal();
        downloadTargetPlaylist(plName);
      }
      return;
    }
    const addBtn = event.target.closest('[data-fav-add]');
    if (addBtn) {
      const plName = addBtn.getAttribute('data-fav-add');
      if (plName) {
        setActiveTargetPlaylist(plName);
        closePlaylistsMenuModal();
        setMusicCategory('track');
        showDownloadNotice(`Adicionando músicas em "${plName}". Toque no [+] em qualquer música ou gênero.`);
        performMusicSearch('', 'track');
        const genresBar = document.getElementById('sp-genres-bar');
        if (genresBar) genresBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }
    const renameBtn = event.target.closest('[data-fav-rename-btn]');
    if (renameBtn) {
      const plName = renameBtn.getAttribute('data-fav-rename-btn');
      const plSrc = renameBtn.getAttribute('data-fav-source');
      renameFavoritePlaylist(plName, plSrc);
      return;
    }
    const playBtn = event.target.closest('[data-fav-play]');
    const editBtn = event.target.closest('[data-fav-edit]');
    const coverBtn = event.target.closest('[data-fav-cover-btn]') || event.target.closest('[data-fav-cover-edit]');
    const openBtn = event.target.closest('[data-fav-open]');
    const delBtn = event.target.closest('[data-fav-del]');
    if (playBtn) {
      closePlaylistsMenuModal();
      playSavedFavorite(playBtn.getAttribute('data-fav-play'), playBtn.getAttribute('data-fav-source'));
      return;
    }
    if (editBtn) {
      closePlaylistsMenuModal();
      loadSavedFavorite(editBtn.getAttribute('data-fav-edit'), editBtn.getAttribute('data-fav-source'), false);
      return;
    }
    if (coverBtn) {
      const plName = coverBtn.getAttribute('data-fav-cover-btn') || coverBtn.getAttribute('data-fav-cover-edit');
      const plSrc = coverBtn.getAttribute('data-fav-source');
      openSetPlaylistCoverModal(plName, plSrc);
      return;
    }
    if (delBtn) {
      deleteEntireFavoritePlaylist(delBtn.getAttribute('data-fav-del'), delBtn.getAttribute('data-fav-source'));
      return;
    }
    if (openBtn && window.torBrowserAPI && typeof window.torBrowserAPI.openFavoriteFolder === 'function') {
      window.torBrowserAPI.openFavoriteFolder(openBtn.getAttribute('data-fav-open'));
    }
  });
}

let coverModalTargetPlaylist = '';
let coverModalTargetSource = 'device';

async function setFavoritePlaylistCover(playlistName, blob, dataUrl, source) {
  if (!playlistName) return false;
  try {
    let resolvedDataUrl = dataUrl || '';
    if (!resolvedDataUrl && blob) {
      resolvedDataUrl = await blobToDataUrl(blob);
    }

    // Atualiza IndexedDB
    const existingRec = (await readFavoritePlaylistRecord(playlistName)) || { name: playlistName, tracks: [] };
    existingRec.cover = resolvedDataUrl;
    existingRec.savedAt = Date.now();
    await saveFavoritePlaylistRecord(playlistName, existingRec.tracks, existingRec.cover);

    // Atualiza no disco se Electron
    if (canSaveFavoriteOnDisk() && (source === 'disk' || window.torBrowserAPI) && window.torBrowserAPI && typeof window.torBrowserAPI.setFavoritePlaylistCover === 'function') {
      let coverData = null;
      if (blob) {
        coverData = new Uint8Array(await blob.arrayBuffer());
      } else if (resolvedDataUrl && resolvedDataUrl.startsWith('data:')) {
        const parts = resolvedDataUrl.split(',');
        const b64 = parts[1];
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        coverData = bytes;
      }
      if (coverData) {
        await window.torBrowserAPI.setFavoritePlaylistCover({
          name: playlistName,
          coverData,
          coverMime: (blob && blob.type) || 'image/jpeg'
        });
      }
    }

    // Se a playlist for a que está aberta no player, atualiza a imagem no Hero
    if (selectedPlaylistName && selectedPlaylistName.toLowerCase() === playlistName.toLowerCase()) {
      if (spHeroImg) spHeroImg.src = resolvedDataUrl || 'papaleguas_logo.png';
    }

    const previewEl = document.getElementById('sp-cover-modal-preview');
    if (previewEl) previewEl.src = resolvedDataUrl || 'papaleguas_logo.png';

    await refreshFavoritesPanel(false);
    showDownloadNotice(`Capa da playlist "${playlistName}" atualizada com sucesso!`);
    return true;
  } catch (err) {
    console.error('Erro ao definir capa:', err);
    showDownloadNotice('Erro ao definir capa: ' + (err.message || 'desconhecido'));
    return false;
  }
}

async function openSetPlaylistCoverModal(playlistName, source) {
  document.body.classList.add('is-editing-playlist');
  coverModalTargetPlaylist = playlistName;
  coverModalTargetSource = source || 'device';

  const modal = document.getElementById('sp-cover-modal-overlay');
  const titleEl = document.getElementById('sp-cover-modal-title');
  const previewEl = document.getElementById('sp-cover-modal-preview');
  const gridEl = document.getElementById('sp-cover-tracks-grid');
  if (!modal) return;
  modal.hidden = false;

  if (titleEl) titleEl.textContent = `🖼️ Capa de "${playlistName}"`;

  let currentCover = '';
  let tracks = [];
  if (source === 'disk' && window.torBrowserAPI && typeof window.torBrowserAPI.getFavoritePlaylist === 'function') {
    const res = await window.torBrowserAPI.getFavoritePlaylist(playlistName);
    currentCover = (res && res.cover) || '';
    tracks = (res && res.tracks) || [];
  } else {
    const rec = await readFavoritePlaylistRecord(playlistName);
    currentCover = (rec && rec.cover) || '';
    tracks = (rec && rec.tracks) || [];
  }

  if (previewEl) {
    previewEl.src = currentCover || (tracks[0] && tracks[0].cover) || 'papaleguas_logo.png';
  }

  if (gridEl) {
    if (!tracks || tracks.length === 0) {
      gridEl.innerHTML = '<div style="color:#7a8698;font-size:12px;grid-column:1/-1;">Nenhuma música salva nesta playlist. Escolha uma imagem acima.</div>';
    } else {
      gridEl.innerHTML = tracks.map((t, idx) => {
        const coverSrc = t.cover || 'papaleguas_logo.png';
        return `
          <div class="sp-cover-track-card" data-idx="${idx}" title="Definir a capa de '${escapeFavoriteText(t.title)}' como capa da playlist">
            <img src="${coverSrc}" onerror="this.src='papaleguas_logo.png';" alt="" />
            <span>${escapeFavoriteText(t.title)}</span>
          </div>
        `;
      }).join('');

      const cards = gridEl.querySelectorAll('.sp-cover-track-card');
      cards.forEach((card) => {
        card.addEventListener('click', async () => {
          const idx = parseInt(card.getAttribute('data-idx'), 10);
          const trk = tracks[idx];
          if (trk && trk.cover) {
            const res = await setFavoritePlaylistCover(coverModalTargetPlaylist, null, trk.cover, coverModalTargetSource);
            if (res) {
              modal.hidden = true;
            }
          }
        });
      });
    }
  }
}

const btnChooseCoverFile = document.getElementById('btn-sp-cover-choose-file');
const coverFileInput = document.getElementById('sp-cover-file-input');
const coverModalClose = document.getElementById('btn-sp-cover-modal-close');
const coverModalOverlay = document.getElementById('sp-cover-modal-overlay');

if (btnChooseCoverFile && coverFileInput) {
  btnChooseCoverFile.addEventListener('click', () => {
    coverFileInput.click();
  });
  coverFileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await blobToDataUrl(file);
      await setFavoritePlaylistCover(coverModalTargetPlaylist, file, dataUrl, coverModalTargetSource);
      coverFileInput.value = '';
      if (coverModalOverlay) coverModalOverlay.hidden = true;
    } catch(err) {
      console.error('Erro ao ler imagem selecionada:', err);
    }
  });
}

if (coverModalClose) {
  coverModalClose.addEventListener('click', () => {
    if (coverModalOverlay) coverModalOverlay.hidden = true;
  });
}

if (coverModalOverlay) {
  coverModalOverlay.addEventListener('click', (e) => {
    if (e.target === coverModalOverlay) coverModalOverlay.hidden = true;
  });
}

const addModalOverlay = document.getElementById('sp-add-to-playlist-modal-overlay');
const addModalClose = document.getElementById('btn-sp-add-modal-close');
const addModalCreateForm = document.getElementById('sp-add-modal-create-form');
const addModalNewInput = document.getElementById('sp-add-modal-new-input');
const addModalPlList = document.getElementById('sp-add-modal-pl-list');

if (addModalClose) {
  addModalClose.addEventListener('click', () => {
    closeAddToPlaylistModal();
  });
}

if (addModalOverlay) {
  addModalOverlay.addEventListener('click', (e) => {
    if (e.target === addModalOverlay) closeAddToPlaylistModal();
  });
}

if (addModalCreateForm) {
  addModalCreateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (addModalNewInput) {
      executeCreateNewPlaylistAndAddTrack(addModalNewInput.value);
    }
  });
}

if (addModalPlList) {
  addModalPlList.addEventListener('click', (e) => {
    const saveBtn = e.target.closest('[data-pl-save]');
    if (saveBtn) {
      const plName = saveBtn.getAttribute('data-pl-save');
      if (plName) executeAddTrackToSpecificPlaylist(plName);
      return;
    }
    const item = e.target.closest('.sp-add-pl-item');
    if (item && !item.classList.contains('is-already-in')) {
      const plName = item.getAttribute('data-pl-name');
      if (plName) executeAddTrackToSpecificPlaylist(plName);
    }
  });
}


const btnAddRelated = document.getElementById('btn-sp-add-related');
const btnDeleteCurrentPl = document.getElementById('btn-sp-delete-current-pl');
const relatedModal = document.getElementById('sp-related-modal-overlay');
const relatedModalClose = document.getElementById('btn-sp-related-modal-close');
const relatedSearchInput = document.getElementById('sp-related-search-input');
const btnRelatedSearch = document.getElementById('btn-sp-related-search');

if (btnAddRelated) {
  btnAddRelated.addEventListener('click', () => {
    openAddRelatedModal();
  });
}

const btnRenameCurrentPl = document.getElementById('btn-sp-rename-current-pl');
const btnCoverCurrentPl = document.getElementById('btn-sp-cover-current-pl');

if (btnRenameCurrentPl) {
  btnRenameCurrentPl.addEventListener('click', () => {
    if (selectedPlaylistName) {
      renameFavoritePlaylist(selectedPlaylistName, selectedPlaylistSource);
    }
  });
}

if (btnCoverCurrentPl) {
  btnCoverCurrentPl.addEventListener('click', () => {
    if (selectedPlaylistName) {
      openSetPlaylistCoverModal(selectedPlaylistName, selectedPlaylistSource);
    }
  });
}

if (btnDeleteCurrentPl) {
  btnDeleteCurrentPl.addEventListener('click', () => {
    if (selectedPlaylistName) {
      deleteEntireFavoritePlaylist(selectedPlaylistName, selectedPlaylistSource);
    }
  });
}

if (relatedModalClose) {
  relatedModalClose.addEventListener('click', () => {
    stopModalPreview();
    if (relatedModal) relatedModal.hidden = true;
  });
}

if (relatedModal) {
  relatedModal.addEventListener('click', (e) => {
    if (e.target === relatedModal) {
      stopModalPreview();
      relatedModal.hidden = true;
    }
  });
}

if (btnRelatedSearch) {
  btnRelatedSearch.addEventListener('click', () => {
    if (relatedSearchInput) searchAndRenderRelatedTracks(relatedSearchInput.value);
  });
}

if (relatedSearchInput) {
  relatedSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchAndRenderRelatedTracks(relatedSearchInput.value);
    }
  });
}

spFilterChips.forEach(chip => {
  chip.addEventListener('click', () => {
    const type = chip.getAttribute('data-type');

    if (type === 'ai') {
      toggleDjChat(); // Alterna: se fechado abre com azul neon; se aberto fecha com borda vermelha!
      return;
    }

    if (type === 'playlist') {
      openPlaylistsMenuModal();
      return;
    }

    const q = spotifySearchInput && spotifySearchInput.value.trim() ? spotifySearchInput.value.trim() : '';

    // Marca o chip de categoria selecionado (sem desmarcar o chip IA)
    spFilterChips.forEach(c => {
      if (c.getAttribute('data-type') !== 'ai') c.classList.remove('active');
    });
    chip.classList.add('active');

    // Executa a busca direta de catálogo
    performMusicSearch(q, type);
  });
});

// Abertura e Fechamento do Modal
if (btnSpotify) {
  btnSpotify.addEventListener('click', () => {
    if (spotifyModal) {
      spotifyModal.classList.toggle('hidden');
      if (!spotifyModal.classList.contains('hidden')) {
        if (castModal) castModal.classList.add('hidden');
        if (circuitModal) circuitModal.classList.add('hidden');
        if (currentTracksList.length === 0 && spotifySearchInput) {
          performMusicSearch(spotifySearchInput.value || '', 'playlist');
        }
      }
    }
  });
}

if (closeSpotifyModalBtn) {
  closeSpotifyModalBtn.addEventListener('click', () => {
    if (spotifyModal) spotifyModal.classList.add('hidden');
  });
}

const allSpotifyOpenTabBtns = document.querySelectorAll('#btn-spotify-open-tab, .btn-spotify-open-tab');
allSpotifyOpenTabBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Em vez de abrir o Spotify Web externamente, expande / maximiza o Mini Player Seguro
    if (spotifyModal) {
      spotifyModal.classList.remove('minimized');
      const isExpanded = spotifyModal.classList.toggle('expanded');
      btn.title = isExpanded ? 'Restaurar Tamanho Padrão' : 'Expandir Mini Player';
    }
  });
});

// Gerenciador de Tamanhos Pré-definidos do Mini Player (P, M, G)
const spSizeBtns = document.querySelectorAll('.sp-size-btn');
const SIZE_PRESETS = {
  small: { width: '340px', height: '480px' },
  medium: { width: '430px', height: '620px' },
  large: { width: '560px', height: '740px' }
};

function applySpotifyModalSize(sizeKey) {
  if (!spotifyModal) return;
  const config = SIZE_PRESETS[sizeKey] || SIZE_PRESETS.medium;

  spotifyModal.classList.remove('expanded');
  spotifyModal.style.width = config.width;
  spotifyModal.style.height = config.height;

  // Atualiza botões visuais
  spSizeBtns.forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-size') === sizeKey);
  });

  // Salva a preferência do usuário
  try {
    localStorage.setItem('sp_player_size', sizeKey);
  } catch (e) {}
}

spSizeBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const size = btn.getAttribute('data-size');
    applySpotifyModalSize(size);
  });
});

// Restaura o tamanho salvo ao iniciar
try {
  const savedSize = localStorage.getItem('sp_player_size');
  if (savedSize && SIZE_PRESETS[savedSize]) {
    applySpotifyModalSize(savedSize);
  }
} catch (e) {}

// Minimizar Mini Player para o Modo Barra Flutuante (apenas o player)
const btnSpotifyMinimize = document.getElementById('btn-spotify-minimize');
const btnSpRestoreFromMini = document.getElementById('btn-sp-restore-from-mini');

if (btnSpotifyMinimize && spotifyModal) {
  btnSpotifyMinimize.addEventListener('click', () => {
    spotifyModal.classList.remove('expanded');
    spotifyModal.classList.add('minimized');
  });
}

if (btnSpRestoreFromMini && spotifyModal) {
  btnSpRestoreFromMini.addEventListener('click', (e) => {
    e.stopPropagation();
    spotifyModal.classList.remove('minimized');
    const savedSize = localStorage.getItem('sp_player_size') || 'medium';
    applySpotifyModalSize(savedSize);
  });
}

// Expandir / Restaurar Mini Player
const btnSpotifyExpand = document.getElementById('btn-spotify-expand');
if (btnSpotifyExpand && spotifyModal) {
  btnSpotifyExpand.addEventListener('click', () => {
    spotifyModal.classList.remove('minimized');
    const isExpanded = spotifyModal.classList.toggle('expanded');
    btnSpotifyExpand.title = isExpanded ? 'Restaurar Tamanho Original' : 'Expandir';
    btnSpotifyExpand.innerHTML = isExpanded 
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  });
}

// Arrastar da janela/página removido conforme solicitação: a página permanece fixa em tela cheia/estática




// ----------------------------------------------------
// Chat com DJ Papaléguas IA (Ocultado/Removido da interface principal)
// ----------------------------------------------------
const spDjChatContainer = document.getElementById('sp-dj-chat-container');
const spDjChatToggle = document.getElementById('sp-dj-chat-toggle');
const spDjToggleBtn = document.getElementById('btn-sp-dj-toggle');
const btnSpDjFab = document.getElementById('btn-sp-dj-fab');
const spDjChatBody = document.getElementById('sp-dj-chat-body');
const spDjChatMessages = document.getElementById('sp-dj-chat-messages');
const spDjChatForm = document.getElementById('sp-dj-chat-form');
const spDjChatInput = document.getElementById('sp-dj-chat-input');
const btnSpDjSend = document.getElementById('btn-sp-dj-send');
const btnSpDjMic = document.getElementById('btn-sp-dj-mic');
const btnSpSearchMic = document.getElementById('btn-sp-search-mic');

// Histórico de chat do DJ isolado para este cliente
const djChatHistory = (() => {
  try {
    const raw = localStorage.getItem('papaleguas_dj_history_' + CLIENT_ID);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
})();

function saveClientDjHistory() {
  try {
    localStorage.setItem('papaleguas_dj_history_' + CLIENT_ID, JSON.stringify(djChatHistory.slice(-40)));
  } catch (e) {}
}

function setIaRecomendaVisualState(isOpen) {
  const fab = document.getElementById('btn-sp-dj-fab');
  const chip = document.getElementById('btn-sp-ai-dj');

  [fab, chip].forEach(btn => {
    if (!btn) return;
    if (isOpen) {
      btn.classList.add('active');
      btn.classList.remove('closed');
      btn.title = 'Fechar Chat do IA Recomenda (Clique para fechar)';
    } else {
      btn.classList.remove('active');
      btn.classList.add('closed');
      btn.title = 'Ativar Chat do IA Recomenda (Clique para abrir)';
    }
  });
}

const toggleDjChat = (forceOpen, shouldFocus = true) => {
  if (!spDjChatContainer) return;
  const isCurrentlyClosed = spDjChatContainer.classList.contains('collapsed');
  const shouldOpen = forceOpen !== undefined ? forceOpen : isCurrentlyClosed;

  if (shouldOpen) {
    spDjChatContainer.classList.remove('collapsed');
    setIaRecomendaVisualState(true); // Muda para AZUL NEON!

    // No celular ou quando especificado shouldFocus === false, não foca para não subir o teclado virtual
    const isMobile = window.innerWidth <= 768 || ('ontouchstart' in window);
    if (shouldFocus && !isMobile && spDjChatInput) {
      setTimeout(() => spDjChatInput.focus(), 150);
    }
  } else {
    spDjChatContainer.classList.add('collapsed');
    setIaRecomendaVisualState(false); // Muda para BORDA VERMELHA!
    if (spDjChatInput) spDjChatInput.blur();
  }
};

if (btnSpDjFab) {
  btnSpDjFab.addEventListener('click', (e) => {
    e.preventDefault();
    toggleDjChat(); // Alterna: abre e fica azul neon / fecha e fica com borda vermelha!
  });
}

if (spDjChatToggle) {
  spDjChatToggle.addEventListener('click', (e) => {
    if (e.target.closest('#btn-sp-dj-toggle') || e.target === spDjChatToggle || e.target.closest('.sp-dj-chat-title')) {
      toggleDjChat(false); // Fecha e fica com borda vermelha!
    }
  });
}

// Inicializa com borda vermelha (chat fechado)
setIaRecomendaVisualState(false);

function appendDjChatMessage(role, text, options) {
  if (!spDjChatMessages) return;
  const msgEl = document.createElement('div');
  msgEl.className = `sp-dj-msg ${role}`;

  const avatarEl = document.createElement('span');
  avatarEl.className = 'sp-dj-msg-avatar';
  avatarEl.textContent = role === 'dj' ? '🎧' : '👤';

  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'sp-dj-msg-bubble';
  bubbleEl.textContent = text;
  if (role === 'dj' && Array.isArray(options) && options.length) {
    const row = document.createElement('div');
    row.className = 'sp-dj-options';
    options.forEach((label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sp-dj-option';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (!spDjChatInput || !spDjChatForm) return;
        spDjChatInput.value = label;
        if (typeof spDjChatForm.requestSubmit === 'function') spDjChatForm.requestSubmit();
      });
      row.appendChild(btn);
    });
    bubbleEl.appendChild(row);
  }

  msgEl.appendChild(avatarEl);
  msgEl.appendChild(bubbleEl);
  spDjChatMessages.appendChild(msgEl);

  // Auto scroll para a última mensagem
  spDjChatMessages.scrollTop = spDjChatMessages.scrollHeight;
}

function djPlaylistCount() {
  const input = document.getElementById('sp-dj-track-count');
  const n = parseInt(input && input.value, 10);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(50, n));
}

if (spDjChatForm && spDjChatInput) {
  spDjChatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = spDjChatInput.value.trim();
    if (!message) return;

    // Adiciona a mensagem do usuário no chat
    appendDjChatMessage('user', message);
    djChatHistory.push({ role: 'user', content: message });
    saveClientDjHistory();
    spDjChatInput.value = '';
    spDjChatInput.disabled = true;
    if (btnSpDjSend) btnSpDjSend.disabled = true;

    // Placeholder de carregamento do DJ
    const loadingMsgEl = document.createElement('div');
    loadingMsgEl.className = 'sp-dj-msg dj loading';
    loadingMsgEl.innerHTML = `
      <span class="sp-dj-msg-avatar">🎧</span>
      <div class="sp-dj-msg-bubble" style="opacity: 0.8; font-style: italic;">
        O DJ está respondendo...
      </div>
    `;
    spDjChatMessages.appendChild(loadingMsgEl);
    spDjChatMessages.scrollTop = spDjChatMessages.scrollHeight;

    try {
      const excludeTitles = getSessionExcludeTitles();
      const response = await window.torBrowserAPI.chatDjPapaleguas(message, djChatHistory, excludeTitles, djPlaylistCount());
      if (loadingMsgEl.parentNode) {
        loadingMsgEl.remove();
      }

      if (response && response.success) {
        const reply = response.reply || 'Aqui está o que preparei para você!';
        appendDjChatMessage('dj', reply, response.suggestions);
        djChatHistory.push({ role: 'dj', content: reply });
        saveClientDjHistory();

        let tracksToPlay = (response.results && response.results.length > 0) ? response.results : [];
        let finalPlaylistName = response.playlistName || 'Playlist do DJ';

        // Se o DJ IA não trouxe faixas prontas mas o usuário pediu um som, busca diretamente no buscador por playlists prontas e faixas
        if (!tracksToPlay.length) {
          try {
            const cleanQuery = message
              .replace(/^(dj papaleguas|dj papaléguas|papaleguas|dj)\s+/i, '')
              .replace(/^(toca|tocar|toque|play|põe|poe|coloca|solta|reproduz|quero ouvir|quero escutar|quero|me toca|bota)\s+/i, '')
              .replace(/^\s*(pra|para)\s+(mim|gente|nós|nos)\s+/i, '')
              .replace(/^\s*(uma|um|umas|uns)\s+(música|musica|som|playlist)\s+(de|do|da)?\s*/i, '')
              .trim();
            if (cleanQuery && cleanQuery.length >= 2) {
              const [plRes, trRes] = await Promise.all([
                window.torBrowserAPI.searchPlaylists ? window.torBrowserAPI.searchPlaylists(cleanQuery) : Promise.resolve({ results: [] }),
                window.torBrowserAPI.searchMusic ? window.torBrowserAPI.searchMusic(cleanQuery, 24) : Promise.resolve({ results: [] })
              ]);
              if (plRes && plRes.results && plRes.results.length > 0) {
                const topPl = plRes.results[0];
                const plData = await window.torBrowserAPI.getPlaylistTracks(topPl.id);
                if (plData && plData.tracks && plData.tracks.length > 0) {
                  tracksToPlay = plData.tracks.map(t => ({ ...t, aiReason: '🎧 Playlist: ' + (topPl.title || cleanQuery) }));
                  finalPlaylistName = topPl.title || cleanQuery;
                }
              }
              if (!tracksToPlay.length && trRes && trRes.results && trRes.results.length > 0) {
                tracksToPlay = trRes.results.map(t => ({ ...t, aiReason: '🎯 Pedido: ' + cleanQuery }));
              }
            }
          } catch (eFallback) {
            console.warn('Fallback no buscador do DJ:', eFallback);
          }
        }

        const shouldPlay = tracksToPlay.length > 0;
        if (shouldPlay) {
          musicPausedForVoice = false;
          registerSessionTracks(tracksToPlay);
          renderSpotifySearchResults(tracksToPlay, message, `🎧 DJ Papaléguas: ${reply}`, finalPlaylistName);
          playTrackAtIndex(0);
          if (spTrackList) {
            spTrackList.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        } else {
          resumeMusicAfterVoice();
        }
      } else {
        appendDjChatMessage('dj', 'Opa, deu uma interferência na sintonia! Tente mandar o pedido novamente.');
        resumeMusicAfterVoice();
      }
    } catch (err) {
      console.error('Erro ao enviar pedido para o DJ Papaléguas:', err);
      if (loadingMsgEl.parentNode) {
        loadingMsgEl.remove();
      }
      appendDjChatMessage('dj', 'Opa, não consegui conectar ao mixer agora! Tente de novo em instantes.');
      resumeMusicAfterVoice();
    } finally {
      spDjChatInput.disabled = false;
      if (btnSpDjSend) btnSpDjSend.disabled = false;
      const isMobile = window.innerWidth <= 768 || ('ontouchstart' in window);
      if (!isMobile) {
        spDjChatInput.focus();
      } else {
        spDjChatInput.blur();
      }
    }
  });
}

// ============================================================================
// RECONHECIMENTO DE VOZ (MICROFONE) PARA PEDIR MÚSICAS AO DJ E BUSCA
// ============================================================================
// ============================================================================
// RECONHECIMENTO DE VOZ (MICROFONE) COM OPENAI WHISPER & DETECÇÃO DE SILÊNCIO
// ============================================================================
let activeVoiceSession = null;
let musicPausedForVoice = false;

function pauseMusicForVoice() {
  musicPausedForVoice = false;
  try {
    if (spotifyPreviewAudio && !spotifyPreviewAudio.paused && !spotifyPreviewAudio.ended) {
      spotifyPreviewAudio.pause();
      if (typeof updateBottomPlayerState === 'function') updateBottomPlayerState(false);
      musicPausedForVoice = true;
    }
  } catch (e) {}
}

function resumeMusicAfterVoice() {
  if (!musicPausedForVoice) return;
  musicPausedForVoice = false;
  try {
    if (spotifyPreviewAudio && spotifyPreviewAudio.src && spotifyPreviewAudio.paused) {
      const playp = spotifyPreviewAudio.play();
      if (playp && typeof playp.catch === 'function') playp.catch(() => {});
      if (typeof updateBottomPlayerState === 'function') updateBottomPlayerState(true);
    }
  } catch (e) {}
}

async function startVoiceInput({ buttonEl, inputEl, onResultSubmit, placeholderMsg }) {
  // Se o usuário clicar no botão enquanto já está gravando, finaliza imediatamente e transcreve o que falou!
  if (activeVoiceSession) {
    if (activeVoiceSession.buttonEl === buttonEl) {
      activeVoiceSession.stop();
      return;
    } else {
      activeVoiceSession.cancel();
    }
  }

  pauseMusicForVoice();

  // Desfoca qualquer campo ativo para garantir que o teclado do celular NÃO apareça durante a fala
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
  if (inputEl && typeof inputEl.blur === 'function') {
    inputEl.blur();
  }

  const prevPlaceholder = inputEl ? inputEl.placeholder : '';
  const originalTitle = buttonEl ? buttonEl.title : '';

  // 1. Tenta captura de áudio de alta fidelidade com MediaRecorder + Whisper API (Padrão no Electron e navegadores modernos)
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined') {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false, // evita cortar voz mansa ou inicial
          autoGainControl: true
        },
        video: false
      });

      let mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported('audio/webm')) {
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
          mimeType = 'audio/ogg';
        } else {
          mimeType = '';
        }
      }

      const mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
      const audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      };

      let audioCtx = null;
      let analyser = null;
      let animFrameId = null;
      let silenceTimer = null;
      let maxTimer = null;
      let isStopping = false;
      let hasSpoken = false;

      // Medidor de áudio para detecção automática de silêncio
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          audioCtx = new AudioContextClass();
          const source = audioCtx.createMediaStreamSource(mediaStream);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
        }
      } catch (e) {
        console.warn('[VOICE] AudioContext não inicializado:', e);
      }

      const cleanup = () => {
        if (animFrameId) cancelAnimationFrame(animFrameId);
        if (silenceTimer) clearTimeout(silenceTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (mediaStream) {
          mediaStream.getTracks().forEach(track => track.stop());
        }
        if (audioCtx && audioCtx.state !== 'closed') {
          try { audioCtx.close(); } catch(e) {}
        }
        if (buttonEl) {
          buttonEl.classList.remove('listening');
          buttonEl.title = originalTitle;
        }
        activeVoiceSession = null;
      };

      const finishAndTranscribe = () => {
        if (isStopping) return;
        isStopping = true;

        if (inputEl) {
          inputEl.placeholder = '⏳ Transcrevendo sua voz com IA...';
        }

        mediaRecorder.onstop = async () => {
          cleanup();

          if (audioChunks.length === 0) {
            if (inputEl) inputEl.placeholder = prevPlaceholder;
            resumeMusicAfterVoice();
            return;
          }

          const audioBlob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
          console.log(`[VOICE] Enviando áudio para Whisper: ${audioBlob.size} bytes`);

          if (audioBlob.size < 900) {
            if (inputEl) {
              inputEl.placeholder = '⚠️ Áudio muito curto. Fale novamente.';
              setTimeout(() => { if (inputEl.placeholder.includes('muito curto')) inputEl.placeholder = prevPlaceholder; }, 2500);
            }
            resumeMusicAfterVoice();
            return;
          }

          try {
            const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
            const baseUrl = (isElectron && window.location.protocol === 'file:') ? 'http://localhost:8080' : '';
            const res = await fetch(baseUrl + '/api/whisper', {
              method: 'POST',
              body: audioBlob
            });

            const data = await res.json();
            console.log('[VOICE] Transcrição recebida:', data);

            if (data && data.text && data.text.trim().length > 0) {
              const spokenText = data.text.trim();
              if (inputEl) {
                inputEl.value = spokenText;
                inputEl.placeholder = prevPlaceholder;
              }
              if (typeof onResultSubmit === 'function') {
                onResultSubmit(spokenText);
              } else {
                resumeMusicAfterVoice();
              }
            } else {
              if (inputEl) {
                inputEl.placeholder = '⚠️ Não consegui entender. Tente falar mais perto.';
                setTimeout(() => { if (inputEl.placeholder.includes('Não consegui')) inputEl.placeholder = prevPlaceholder; }, 3000);
              }
              resumeMusicAfterVoice();
            }
          } catch (err) {
            console.error('[VOICE] Erro na transcrição Whisper:', err);
            if (inputEl) {
              inputEl.placeholder = '⚠️ Falha ao conectar ao serviço de voz.';
              setTimeout(() => { if (inputEl.placeholder.includes('Falha ao')) inputEl.placeholder = prevPlaceholder; }, 3000);
            }
            resumeMusicAfterVoice();
          }
        };

        try {
          mediaRecorder.stop();
        } catch (e) {
          console.warn('[VOICE] Erro ao parar mediaRecorder:', e);
          cleanup();
          if (inputEl) inputEl.placeholder = prevPlaceholder;
        }
      };

      activeVoiceSession = {
        buttonEl,
        inputEl,
        stop: () => finishAndTranscribe(),
        cancel: () => {
          isStopping = true;
          try { mediaRecorder.stop(); } catch(e) {}
          cleanup();
          if (inputEl) inputEl.placeholder = prevPlaceholder;
          resumeMusicAfterVoice();
        }
      };

      if (buttonEl) {
        buttonEl.classList.add('listening');
        buttonEl.title = '🎙️ Gravando voz... Clique para parar e enviar!';
      }
      if (inputEl) {
        inputEl.placeholder = placeholderMsg || '🎙️ Ouvindo... Fale agora! (Clique no mic para parar)';
      }

      mediaRecorder.start(100);

      // Detecção de atividade de voz e parada por silêncio após a fala
      if (analyser) {
        const dataArray = new Uint8Array(analyser.fftSize);
        const checkVolume = () => {
          if (isStopping) return;
          analyser.getByteTimeDomainData(dataArray);

          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += Math.abs(dataArray[i] - 128);
          }
          const volume = sum / dataArray.length;

          if (volume > 1.8) {
            hasSpoken = true;
            if (silenceTimer) {
              clearTimeout(silenceTimer);
              silenceTimer = null;
            }
          } else if (hasSpoken) {
            if (!silenceTimer) {
              silenceTimer = setTimeout(() => {
                finishAndTranscribe();
              }, 1400); // 1.4s de silêncio após ter começado a falar conclui automaticamente
            }
          }

          animFrameId = requestAnimationFrame(checkVolume);
        };
        animFrameId = requestAnimationFrame(checkVolume);
      }

      // Timeout máximo de gravação (8 segundos)
      maxTimer = setTimeout(() => {
        if (!isStopping) {
          console.log('[VOICE] Tempo limite de gravação atingido.');
          finishAndTranscribe();
        }
      }, 8000);

      return;

    } catch (micErr) {
      console.warn('[VOICE] getUserMedia falhou, tentando fallback nativo:', micErr);
    }
  }

  // 2. Fallback: Web Speech API nativo (caso getUserMedia não esteja acessível)
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRec) {
    try {
      const rec = new SpeechRec();
      rec.lang = 'pt-BR';
      rec.continuous = false;
      rec.interimResults = false;

      if (buttonEl) buttonEl.classList.add('listening');
      if (inputEl) inputEl.placeholder = '🎙️ Ouvindo... Fale agora!';

      rec.onresult = (e) => {
        if (!e.results || e.results.length === 0) return;
        const transcript = e.results[0][0].transcript;
        if (inputEl) {
          inputEl.value = transcript;
          inputEl.placeholder = prevPlaceholder;
        }
        if (typeof onResultSubmit === 'function' && transcript.trim()) {
          rec._djSubmitted = true;
          onResultSubmit(transcript.trim());
        } else {
          resumeMusicAfterVoice();
        }
      };

      rec.onerror = (e) => {
        console.warn('[VOICE] Erro no SpeechRecognition fallback:', e.error);
        if (buttonEl) buttonEl.classList.remove('listening');
        if (inputEl) inputEl.placeholder = prevPlaceholder;
        activeVoiceSession = null;
        if (!rec._djSubmitted) resumeMusicAfterVoice();
      };

      rec.onend = () => {
        if (buttonEl) buttonEl.classList.remove('listening');
        if (inputEl) inputEl.placeholder = prevPlaceholder;
        activeVoiceSession = null;
        if (!rec._djSubmitted) resumeMusicAfterVoice();
      };

      activeVoiceSession = {
        buttonEl,
        inputEl,
        stop: () => { try { rec.stop(); } catch(e) {} },
        cancel: () => {
          try { rec.abort(); } catch(e) {}
          resumeMusicAfterVoice();
        }
      };

      rec.start();
      return;
    } catch(err) {
      console.warn('[VOICE] Erro ao iniciar SpeechRec:', err);
    }
  }

  resumeMusicAfterVoice();
  alert("Não foi possível acessar o microfone. Verifique as permissões de áudio no sistema ou navegador.");
  if (buttonEl) buttonEl.classList.remove('listening');
  if (inputEl) inputEl.placeholder = prevPlaceholder;
}

// Microfone do Chat do DJ Papaléguas
if (btnSpDjMic) {
  btnSpDjMic.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Garante que o input perca o foco imediatamente para o teclado do celular não subir
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    if (spDjChatInput) spDjChatInput.blur();

    // Garante que o painel de chat do DJ esteja visível ao pedir por voz SEM focar o input para não abrir o teclado
    toggleDjChat(true, false);
    startVoiceInput({
      buttonEl: btnSpDjMic,
      inputEl: spDjChatInput,
      placeholderMsg: '🎙️ Ouvindo... Diga os ritmos ou artistas para misturar!',
      onResultSubmit: (spokenText) => {
        if (spDjChatInput) spDjChatInput.blur();
        if (spDjChatForm) {
          spDjChatForm.dispatchEvent(new Event('submit', { cancelable: true }));
        }
      }
    });
  });
}

// Microfone da Barra de Busca Superior
if (btnSpSearchMic) {
  btnSpSearchMic.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    if (spotifySearchInput) spotifySearchInput.blur();
    startVoiceInput({
      buttonEl: btnSpSearchMic,
      inputEl: spotifySearchInput,
      placeholderMsg: '🎙️ Ouvindo... Fale a música, cantor ou gênero!',
      onResultSubmit: (spokenText) => {
        if (spotifySearchInput) spotifySearchInput.blur();
        if (typeof performMusicSearch === 'function') {
          performMusicSearch(spokenText);
        }
      }
    });
  });
}


// Restaura mensagens do histórico isolado deste cliente no chat do DJ
if (Array.isArray(djChatHistory) && djChatHistory.length > 0) {
  djChatHistory.forEach(msg => {
    if (msg.role && msg.content) {
      appendDjChatMessage(msg.role, msg.content);
    }
  });
}


// ============================================================================
// EXECUÇÃO DE COMANDOS DE MÚSICA / DJ PAPALÉGUAS
// ============================================================================
async function executeMusicQuery(query, autoplay = true) {
  if (!query || !query.trim()) {
    performMusicSearch('', 'all');
    return;
  }

  let cleanQuery = query.trim();
  // Normaliza termos comuns de pedidos gospel
  if (cleanQuery.toLowerCase() === 'gospel' || cleanQuery.toLowerCase() === 'louvor') {
    cleanQuery = 'musica gospel';
  }

  console.log("[DJ PAPALÉGUAS] Executando som:", cleanQuery, "Autoplay:", autoplay);

  if (spotifySearchInput) {
    spotifySearchInput.value = cleanQuery;
    spotifySearchInput.placeholder = `Tocando no DJ Papaléguas: ${cleanQuery}...`;
  }

  // Notificação no chat do DJ Papaléguas
  appendDjChatMessage('dj', `🎧 DJ Papaléguas na área! Soltando os melhores sucessos de "${cleanQuery}" para você agora! 🔥`);

  if (spAiBanner && spAiBannerStatus && spAiBannerDesc) {
    spAiBanner.classList.remove('hidden');
    spAiBannerStatus.textContent = `DJ Papaléguas • Ao Vivo`;
    spAiBannerDesc.textContent = `Tocando agora os melhores sucessos de "${cleanQuery}"...`;
  }

  if (spTrackList) {
    spTrackList.innerHTML = `<div class="sp-search-placeholder">🎧 DJ Papaléguas mixando "${cleanQuery}"...</div>`;
  }

  try {
    let tracks = [];
    
    // 1. Recomendações inteligentes da IA
    if (window.torBrowserAPI && window.torBrowserAPI.getAiMusicRecommendations) {
      const excludeTitles = typeof getSessionExcludeTitles === 'function' ? getSessionExcludeTitles() : [];
      const res = await window.torBrowserAPI.getAiMusicRecommendations(cleanQuery, 'all', excludeTitles);
      if (res && res.success && res.results && res.results.length > 0) {
        tracks = res.results;
      }
    }

    // 2. Busca abrangente (SearchAll)
    if (tracks.length === 0 && window.torBrowserAPI && window.torBrowserAPI.searchAll) {
      const allRes = await window.torBrowserAPI.searchAll(cleanQuery);
      if (allRes && allRes.success && allRes.results && allRes.results.length > 0) {
        tracks = allRes.results;
      }
    }

    // 3. Busca de músicas (SearchMusic)
    if (tracks.length === 0 && window.torBrowserAPI && window.torBrowserAPI.searchMusic) {
      const musicRes = await window.torBrowserAPI.searchMusic(cleanQuery);
      if (musicRes && musicRes.success && musicRes.results && musicRes.results.length > 0) {
        tracks = musicRes.results;
      }
    }

    if (tracks.length > 0) {
      if (typeof registerSessionTracks === 'function') registerSessionTracks(tracks);
      renderSpotifySearchResults(tracks, cleanQuery, `🎧 DJ Papaléguas: Tocando ${cleanQuery}`, cleanQuery);

      if (autoplay) {
        setTimeout(() => {
          playTrackAtIndex(0);
        }, 150);
      }
    } else {
      performMusicSearch(cleanQuery, 'all');
    }
  } catch (err) {
    console.error("Erro ao executar busca no DJ Papaléguas:", err);
    performMusicSearch(cleanQuery, 'all');
  }
}

// Escuta mensagens recebidas do navegador
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'play-dj-music') {
    executeMusicQuery(ev.data.query, ev.data.autoplay !== false);
  }
});

// ============================================================================
// INICIALIZAÇÃO - PAPALÉGUAS MUSIC
// ============================================================================
window.addEventListener('DOMContentLoaded', async () => {
  // Reconcilia e restaura playlists e músicas salvas no aparelho / downloads
  await restoreAndSyncPlaylistsOnStartup();

  // Em telas menores (smartphones/celulares), recolhe o chat do DJ por padrão
  // para que o mini player e a lista de músicas fiquem imediatamente visíveis
  if (window.innerWidth <= 768 && spDjChatContainer) {
    spDjChatContainer.classList.add('collapsed');
  }

  // Verifica se a URL trouxe um comando de música (?q=gospel&autoplay=1)
  const params = new URLSearchParams(window.location.search);
  const q = params.get('q') || params.get('dj') || params.get('search') || '';
  const autoplay = params.get('autoplay') !== '0';
  try {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') || (window.innerWidth <= 768);
    if (!isMobile) {
      window.history.replaceState({}, '', '/musica');
    } else {
      window.history.replaceState({}, '', '/');
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        type: 'navigate-sync',
        url: '/musica',
        targetUrl: '/musica',
        title: 'Papaléguas Music'
      }, '*');
    }
  } catch (e) {}

  if (q && q.trim()) {
    executeMusicQuery(q.trim(), autoplay);
  } else {
    // Atualiza contadores das playlists salvas no botão sem desviar da tela principal
    checkAndLoadDownloadedOnStartup();
    // Sempre abre o Papaléguas Music com a aba 'Tudo' selecionada e com playlists online + sucessos
    setMusicCategory('all');
    if (typeof performMusicSearch === 'function') {
      performMusicSearch('', 'all');
    }
  }

  // Ativa a rolagem infinita por gênero musical / busca
  if (typeof setupInfiniteScroll === 'function') {
    setupInfiniteScroll();
  }

  // Inicializa botões do banner de playlist ativa
  const btnTargetView = document.getElementById('btn-sp-target-view');
  const btnTargetDone = document.getElementById('btn-sp-target-done');
  if (btnTargetView) {
    btnTargetView.addEventListener('click', () => {
      const target = getActiveTargetPlaylist();
      if (target) loadSavedFavorite(target, 'disk');
    });
  }
  if (btnTargetDone) {
    btnTargetDone.addEventListener('click', () => {
      const target = getActiveTargetPlaylist();
      setActiveTargetPlaylist('');
      showDownloadNotice(target ? `Playlist "${target}" concluída!` : 'Modo de adição concluído.');
    });
  }
  updateActiveTargetPlaylistBanner();

  // ==========================================================================
  // MINI PLAYER FLUTUANTE, ARRASTÁVEL E MINIMIZÁVEL
  // ==========================================================================
  const dragHandle = document.getElementById('sp-drag-handle');
  const btnMiniToggle = document.getElementById('btn-sp-mini-toggle');
  const miniTrackInfo = document.getElementById('sp-mini-track-info');

  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  function togglePlayerMinimize(forceState) {
    if (!spBottomPlayer) return;
    const shouldMinimize = forceState !== undefined ? forceState : !spBottomPlayer.classList.contains('is-minimized');
    if (shouldMinimize) {
      if (typeof setMusicEqPanelOpen === 'function') setMusicEqPanelOpen(false);
      spBottomPlayer.classList.add('is-minimized');
      if (btnMiniToggle) {
        btnMiniToggle.title = 'Restaurar tamanho normal';
        btnMiniToggle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
      }
    } else {
      // Restaura o tamanho normal original no cabeçalho
      spBottomPlayer.classList.remove('is-minimized', 'is-floating');
      spBottomPlayer.style.removeProperty('position');
      spBottomPlayer.style.removeProperty('left');
      spBottomPlayer.style.removeProperty('top');
      spBottomPlayer.style.removeProperty('bottom');
      spBottomPlayer.style.removeProperty('right');
      spBottomPlayer.style.removeProperty('width');
      spBottomPlayer.style.removeProperty('height');
      spBottomPlayer.style.removeProperty('transition');
      if (btnMiniToggle) {
        btnMiniToggle.title = 'Minimizar';
        btnMiniToggle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/></svg>';
      }
    }
  }

  window.togglePlayerMinimize = togglePlayerMinimize;

  if (btnMiniToggle) {
    btnMiniToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlayerMinimize();
    });
  }

  // Mini player fixo no cabeçalho - Oculta alça de arraste
  if (dragHandle) {
    dragHandle.style.display = 'none';
  }

  // Clique no player: se estiver minimizado restaura para o tamanho normal; senão abre tela cheia
  if (spBottomPlayer) {
    spBottomPlayer.addEventListener('click', (e) => {
      // Não age se clicou nos botões de controle, play, seekbar ou equalizador
      if (e.target.closest('button') || e.target.closest('.sp-ctrl-btn') || e.target.closest('.sp-play-main-btn') || e.target.closest('#sp-player-progress-container') || e.target.closest('.sp-eq-panel')) {
        return;
      }

      // Se estiver minimizado (em bolha), restaura o tamanho normal imediatamente!
      if (spBottomPlayer.classList.contains('is-minimized')) {
        e.stopPropagation();
        togglePlayerMinimize(false);
        return;
      }

      // Se já está normal e clicou na barra livre, expande o player
      const spExpandedPlayer = document.getElementById('sp-expanded-player');
      if (spExpandedPlayer) spExpandedPlayer.classList.remove('hidden');
    });
  }

  // ============================================================================
  // SINCRONIZAÇÃO COM O MINI PLAYER GLOBAL ARRASTÁVEL DO NAVEGADOR
  // ============================================================================
  let lastBroadcastTime = 0;

  window.broadcastMusicState = function() {
    const bcList = window.playingTracksList || currentTracksList;
    const track = bcList && bcList[currentTrackIndex];
    const cur = spotifyPreviewAudio ? (spotifyPreviewAudio.currentTime || 0) : 0;
    const dur = spotifyPreviewAudio ? (spotifyPreviewAudio.duration || 0) : 0;
    const isPlaying = spotifyPreviewAudio ? (!spotifyPreviewAudio.paused && !spotifyPreviewAudio.ended) : false;

    const state = {
      type: 'music-state-update',
      isPlaying: isPlaying,
      track: track ? {
        id: track.id,
        title: track.title || 'Música Desconhecida',
        artist: track.artist || 'Papaléguas Music',
        cover: track.cover || 'papaleguas_logo.png',
        duration: dur || parseDurationSeconds(track.duration) || 0
      } : null,
      currentTime: cur,
      duration: dur || (track ? parseDurationSeconds(track.duration) : 0) || 0
    };

    try {
      localStorage.setItem('papaleguas_last_music_state', JSON.stringify(state));
    } catch(e) {}
    if (window.torBrowserAPI && window.torBrowserAPI.sendToHost) {
      window.torBrowserAPI.sendToHost('music-state-update', state);
    }
    try {
      window.postMessage(state, '*');
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(state, '*');
      }
    } catch(e) {}
  };

  if (spotifyPreviewAudio) {
    const currentTrackForSession = () => {
      const list = window.playingTracksList || currentTracksList;
      return list && list[currentTrackIndex];
    };

    spotifyPreviewAudio.addEventListener('timeupdate', () => {
      // Quando a tela está oculta/minimizada, não envia broadcast desnecessário
      if (document.hidden || window.__papaIsHidden) return;
      const now = Date.now();
      if (now - lastBroadcastTime > 500) {
        lastBroadcastTime = now;
        window.broadcastMusicState();
      }
    });

    spotifyPreviewAudio.addEventListener('play', () => {
      const t = currentTrackForSession();
      if (t) updateMediaSession(t, true);
      window.broadcastMusicState();
      try {
        if (!isMobileDevice) {
          ensureDjPipCanvas();
          if (djPipVideo && djPipVideo.paused) djPipVideo.play().catch(() => {});
        }
      } catch (e) {}
    });

    spotifyPreviewAudio.addEventListener('pause', () => {
      if (window.__papaLeavingPage) return;
      const t = currentTrackForSession();
      if (t) {
        updateMediaSession(t, false);
      }
      window.broadcastMusicState();
    });

    spotifyPreviewAudio.addEventListener('ended', () => {
      window.broadcastMusicState();
    });

    spotifyPreviewAudio.addEventListener('ratechange', () => syncMediaSessionPosition());
    spotifyPreviewAudio.addEventListener('seeked', () => syncMediaSessionPosition());
    spotifyPreviewAudio.addEventListener('loadedmetadata', () => syncMediaSessionPosition());
    spotifyPreviewAudio.addEventListener('durationchange', () => syncMediaSessionPosition());
  }

  function refreshVisualProgressInstant() {
    if (!spotifyPreviewAudio) return;
    const dur = getEffectiveDuration();
    const cur = spotifyPreviewAudio.currentTime || 0;
    const curStr = formatTime(cur);
    if (spMiniCurTime) spMiniCurTime.textContent = curStr;
    if (spExpandedTimeCur) spExpandedTimeCur.textContent = curStr;
    if (spMiniBubbleBadge) spMiniBubbleBadge.textContent = curStr;
    if (dur > 0) {
      const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
      if (spPlayerProgressBar) spPlayerProgressBar.style.width = `${pct}%`;
      if (spBottomPlayer) spBottomPlayer.style.setProperty('--sp-progress-pct', `${pct.toFixed(1)}%`);
      if (spExpandedFill) spExpandedFill.style.width = `${pct}%`;
      if (spExpandedThumb) spExpandedThumb.style.left = `${pct}%`;
      const durStr = formatTime(dur);
      if (spMiniDurTime) spMiniDurTime.textContent = durStr;
      if (spExpandedTimeDur) spExpandedTimeDur.textContent = durStr;
    }
  }

  // Ao voltar para o app (ou minimizar), mantém o estado consistente sem resetar o scrubber nativo
  document.addEventListener('visibilitychange', () => {
    if (!spotifyPreviewAudio) return;
    const isPlaying = !spotifyPreviewAudio.paused && !spotifyPreviewAudio.ended;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
    if (!document.hidden) {
      refreshVisualProgressInstant();
      window.broadcastMusicState();
    }
  });

  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'parent-visibility-change') {
      window.__papaIsHidden = !!ev.data.hidden;
      if (!window.__papaIsHidden && spotifyPreviewAudio) {
        refreshVisualProgressInstant();
        window.broadcastMusicState();
      }
    }
  });

  // Saindo de verdade do app: remove o cartão de mídia para não ficar travado na notificação.
  window.addEventListener('beforeunload', () => {
    window.__papaLeavingPage = true;
    try { if (spotifyPreviewAudio) spotifyPreviewAudio.pause(); } catch (e) {}
    clearMediaSession();
    try {
      localStorage.removeItem('papaleguas_last_music_state');
    } catch (e) {}
  });

  // Escuta comandos enviados pelo Mini Player Global do navegador
  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.data.type !== 'music-player-control') return;
    const { action, value } = ev.data;

    if (action === 'toggle' || action === 'play-pause') {
      if (btnSpPlayPause) btnSpPlayPause.click();
    } else if (action === 'play') {
      if (spotifyPreviewAudio && spotifyPreviewAudio.paused) {
        spotifyPreviewAudio.play();
        updateBottomPlayerState(true);
      }
    } else if (action === 'pause') {
      if (spotifyPreviewAudio && !spotifyPreviewAudio.paused) {
        spotifyPreviewAudio.pause();
        updateBottomPlayerState(false);
      }
    } else if (action === 'next') {
      playNextTrack();
    } else if (action === 'prev') {
      playPreviousTrack();
    } else if (action === 'seek' && typeof value === 'number') {
      if (spotifyPreviewAudio && isFinite(value)) {
        spotifyPreviewAudio.currentTime = value;
        window.broadcastMusicState();
      }
    }
  });

  // Botão Mini Player no cabeçalho ao lado do título
  const btnSpMiniPip = document.getElementById('btn-sp-mini-pip');
  if (btnSpMiniPip) {
    btnSpMiniPip.addEventListener('click', () => {
      const isElectron = !!(window.torBrowserAPI && window.torBrowserAPI.isElectron);
      if (isElectron && window.torBrowserAPI.sendToHost) {
        window.torBrowserAPI.sendToHost('toggle-music-mini-player');
      }
      try {
        window.postMessage({ type: 'toggle-music-mini-player' }, '*');
      } catch(e) {}

      btnSpMiniPip.classList.toggle('active');
    });
  }
});



if (spExpandedProgressContainer) {
  let isDraggingExpanded = false;
  const updateExpandedSeek = (e) => {
    const expDur = getEffectiveDuration();
    if (!spotifyPreviewAudio || !expDur) return;
    const rect = spExpandedProgressContainer.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const p = x / rect.width;
    const seekTime = p * expDur;
    spotifyPreviewAudio.currentTime = seekTime;
  };
  spExpandedProgressContainer.addEventListener('mousedown', (e) => { isDraggingExpanded = true; updateExpandedSeek(e); });
  spExpandedProgressContainer.addEventListener('touchstart', (e) => { isDraggingExpanded = true; updateExpandedSeek(e.touches[0]); }, {passive:true});
  document.addEventListener('mousemove', (e) => { if (isDraggingExpanded) updateExpandedSeek(e); });
  document.addEventListener('touchmove', (e) => { if (isDraggingExpanded) updateExpandedSeek(e.touches[0]); }, {passive:true});
  document.addEventListener('mouseup', () => { isDraggingExpanded = false; });
  document.addEventListener('touchend', () => { isDraggingExpanded = false; });
}

if (btnSpExpandedClose) {
  btnSpExpandedClose.addEventListener('click', (e) => {
    e.stopPropagation();
    if (spExpandedPlayer) spExpandedPlayer.classList.add('hidden');
    // Garante que o mini player esteja visível e desminimizado caso estivesse minimizado
    if (typeof togglePlayerMinimize === 'function') {
      togglePlayerMinimize(false);
    }
  });
}


const btnSpExpandedBubble = document.getElementById('btn-sp-expanded-bubble');
if (btnSpExpandedBubble) {
  btnSpExpandedBubble.addEventListener('click', (e) => {
    e.stopPropagation();
    if (spExpandedPlayer) spExpandedPlayer.classList.add('hidden');
    if (typeof togglePlayerMinimize === 'function') {
      togglePlayerMinimize(true);
    }
  });
}



if (btnSpExpandedPlay) {
  btnSpExpandedPlay.addEventListener('click', () => {
    if (btnSpPlayPause) btnSpPlayPause.click();
  });
}
if (btnSpExpandedNext) btnSpExpandedNext.addEventListener('click', playNextTrack);
if (btnSpExpandedPrev) btnSpExpandedPrev.addEventListener('click', playPrevTrack);
if (btnSpExpandedShuffle) {
  btnSpExpandedShuffle.addEventListener('click', () => {
    if (btnSpShuffle) btnSpShuffle.click();
  });
}
if (btnSpExpandedRepeat) {
  btnSpExpandedRepeat.addEventListener('click', () => {
    if (btnSpRepeat) btnSpRepeat.click();
  });
}
