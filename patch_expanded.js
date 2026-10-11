const fs = require('fs');

// 1. Injetar HTML em src/musica.html
let html = fs.readFileSync('src/musica.html', 'utf8');

const expandedPlayerHtml = `
      <!-- Expanded Player Overlay -->
      <div class="sp-expanded-player hidden" id="sp-expanded-player">
        <div class="sp-expanded-bg" id="sp-expanded-bg"></div>
        <div class="sp-expanded-content">
          <div class="sp-expanded-top">
            <button class="sp-expanded-close" id="btn-sp-expanded-close" type="button" title="Minimizar">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="sp-expanded-header-title">Tocando Agora</div>
            <div style="width:28px"></div> <!-- spacer -->
          </div>
          
          <div class="sp-expanded-art-wrapper">
            <img class="sp-expanded-art" id="sp-expanded-art" src="papaleguas_logo.png" alt="Capa" onerror="this.src='/papaleguas_logo.png'" />
          </div>

          <div class="sp-expanded-info">
            <div class="sp-expanded-title" id="sp-expanded-title">--</div>
            <div class="sp-expanded-artist" id="sp-expanded-artist">--</div>
          </div>

          <div class="sp-expanded-progress">
            <div class="sp-expanded-progress-bar-container" id="sp-expanded-progress-bar-container">
              <div class="sp-expanded-progress-bg">
                <div class="sp-expanded-progress-fill" id="sp-expanded-progress-fill"></div>
                <div class="sp-expanded-progress-thumb" id="sp-expanded-progress-thumb"></div>
              </div>
            </div>
            <div class="sp-expanded-time-row">
              <span id="sp-expanded-time-cur">0:00</span>
              <span id="sp-expanded-time-dur">0:00</span>
            </div>
          </div>

          <div class="sp-expanded-controls">
            <button class="sp-ctrl-btn" id="btn-sp-expanded-shuffle">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
            </button>
            <button class="sp-ctrl-btn" id="btn-sp-expanded-prev">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2"/></svg>
            </button>
            <button class="sp-play-main-btn" id="btn-sp-expanded-play" style="width:72px; height:72px; background:#1ed760; color:#000; border-radius:50%; border:0; display:flex; align-items:center; justify-content:center; cursor:pointer;">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" id="sp-expanded-play-icon"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <button class="sp-ctrl-btn" id="btn-sp-expanded-next">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2"/></svg>
            </button>
            <button class="sp-ctrl-btn" id="btn-sp-expanded-repeat">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            </button>
          </div>
        </div>
      </div>
`;

if (!html.includes('sp-expanded-player')) {
  html = html.replace('      <!-- Modal: Editar Informações da Música -->', expandedPlayerHtml + '\n      <!-- Modal: Editar Informações da Música -->');
}

// 2. Injetar CSS em src/musica.html
const expandedPlayerCss = `
    /* EXPANDED PLAYER OVERLAY */
    .sp-expanded-player {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: 10000;
      background: #111;
      display: flex;
      flex-direction: column;
      transform: translateY(0);
      transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
      overflow: hidden;
    }
    .sp-expanded-player.hidden {
      transform: translateY(100%);
      pointer-events: none;
    }
    .sp-expanded-bg {
      position: absolute;
      top: -10%; left: -10%; right: -10%; bottom: -10%;
      background-size: cover;
      background-position: center;
      filter: blur(40px) brightness(0.4);
      z-index: 0;
      transition: background-image 0.5s ease;
    }
    .sp-expanded-content {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 24px;
      padding-top: max(24px, env(safe-area-inset-top));
      padding-bottom: max(32px, env(safe-area-inset-bottom));
      box-sizing: border-box;
    }
    .sp-expanded-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    .sp-expanded-close {
      background: none; border: none; color: #fff; cursor: pointer; padding: 8px; opacity: 0.8;
    }
    .sp-expanded-header-title {
      font-size: 13px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #fff; opacity: 0.8;
    }
    .sp-expanded-art-wrapper {
      flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; margin-bottom: 24px;
    }
    .sp-expanded-art {
      width: 100%; max-width: 400px; aspect-ratio: 1/1; object-fit: cover; border-radius: 12px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.5);
    }
    .sp-expanded-info {
      margin-bottom: 24px;
    }
    .sp-expanded-title {
      font-size: 24px; font-weight: 800; color: #fff; margin-bottom: 6px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sp-expanded-artist {
      font-size: 16px; color: #a1a1aa; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sp-expanded-progress {
      margin-bottom: 24px;
    }
    .sp-expanded-progress-bar-container {
      height: 24px; display: flex; align-items: center; cursor: pointer; margin-bottom: 8px;
    }
    .sp-expanded-progress-bg {
      flex: 1; height: 4px; background: rgba(255,255,255,0.2); border-radius: 2px; position: relative;
    }
    .sp-expanded-progress-fill {
      position: absolute; left: 0; top: 0; bottom: 0; background: #fff; border-radius: 2px; width: 0%;
      transition: width 0.1s linear;
    }
    .sp-expanded-progress-thumb {
      position: absolute; top: 50%; width: 12px; height: 12px; background: #fff; border-radius: 50%;
      transform: translate(-50%, -50%); left: 0%;
      transition: left 0.1s linear; opacity: 0;
    }
    .sp-expanded-progress-bar-container:active .sp-expanded-progress-thumb { opacity: 1; }
    .sp-expanded-time-row {
      display: flex; justify-content: space-between; font-size: 12px; color: #a1a1aa; font-weight: 500;
    }
    .sp-expanded-controls {
      display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px;
    }
    @media(min-width: 768px) {
      .sp-expanded-player { max-width: 480px; margin: 0 auto; right: 24px; bottom: 100px; left: auto; top: auto; height: 80vh; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.8); }
    }
`;

if (!html.includes('.sp-expanded-player')) {
  html = html.replace('  </style>', expandedPlayerCss + '\n  </style>');
}

fs.writeFileSync('src/musica.html', html);

// 3. Injetar JS em src/musica.js
let js = fs.readFileSync('src/musica.js', 'utf8');

const jsElements = `
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

if (spExpandedProgressContainer) {
  let isDraggingExpanded = false;
  const updateExpandedSeek = (e) => {
    if (!spotifyPreviewAudio || !spotifyPreviewAudio.duration) return;
    const rect = spExpandedProgressContainer.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const p = x / rect.width;
    const seekTime = p * spotifyPreviewAudio.duration;
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
  btnSpExpandedClose.addEventListener('click', () => {
    if (spExpandedPlayer) spExpandedPlayer.classList.add('hidden');
  });
}
const spMiniTrackInfo = document.getElementById('sp-mini-track-info');
if (spMiniTrackInfo) {
  spMiniTrackInfo.addEventListener('click', () => {
    if (spExpandedPlayer) spExpandedPlayer.classList.remove('hidden');
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
`;

if (!js.includes('spExpandedPlayer')) {
  js += '\n\n' + jsElements;
}

// 4. Update the expanded player UI on track change / progress
// inside playTrackAtIndex -> Update Art/Title/Artist
js = js.replace(
  'if (spMiniTitle) spMiniTitle.textContent = track.title;',
  'if (spMiniTitle) spMiniTitle.textContent = track.title;\n  if (spExpandedTitle) spExpandedTitle.textContent = track.title;'
);
js = js.replace(
  'if (spMiniArtist) spMiniArtist.textContent = window.playingPlaylistName ? track.artist + " • " + window.playingPlaylistName : track.artist;',
  'if (spMiniArtist) spMiniArtist.textContent = window.playingPlaylistName ? track.artist + " • " + window.playingPlaylistName : track.artist;\n  if (spExpandedArtist) spExpandedArtist.textContent = window.playingPlaylistName ? track.artist + " • " + window.playingPlaylistName : track.artist;'
);
js = js.replace(
  'spMiniThumb.src = track.cover || thumbFallback;',
  'spMiniThumb.src = track.cover || thumbFallback;\n    if (spExpandedArt) spExpandedArt.src = track.cover || thumbFallback;\n    if (spExpandedBg) spExpandedBg.style.backgroundImage = `url("${track.cover || thumbFallback}")`;'
);

// updateBottomPlayerState -> Update play/pause icon
const updateStateOld = `if (spMainPlayIcon) {
    if (isPlaying) {
      spMainPlayIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
      spMainPlayIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    }
  }`;
const updateStateNew = `if (spMainPlayIcon) {
    if (isPlaying) {
      spMainPlayIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
      if (spExpandedPlayIcon) spExpandedPlayIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
      spMainPlayIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
      if (spExpandedPlayIcon) spExpandedPlayIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    }
  }`;
js = js.replace(updateStateOld, updateStateNew);

// updateShuffleButton and updateRepeatButton
js = js.replace(
  'btnSpShuffle.classList.toggle(\'active\', isShuffle);',
  'btnSpShuffle.classList.toggle(\'active\', isShuffle);\n    if (btnSpExpandedShuffle) btnSpExpandedShuffle.style.color = isShuffle ? "#1ed760" : "currentColor";'
);
js = js.replace(
  'btnSpRepeat.classList.toggle(\'active\', isRepeat);',
  'btnSpRepeat.classList.toggle(\'active\', isRepeat);\n    if (btnSpExpandedRepeat) btnSpExpandedRepeat.style.color = isRepeat ? "#1ed760" : "currentColor";'
);

// progress bar update
const progOld = `if (spPlayerProgressBar) spPlayerProgressBar.style.width = pct + '%';
  if (spPlayerProgressThumb) spPlayerProgressThumb.style.left = pct + '%';`;
const progNew = `if (spPlayerProgressBar) spPlayerProgressBar.style.width = pct + '%';
  if (spPlayerProgressThumb) spPlayerProgressThumb.style.left = pct + '%';
  if (spExpandedFill) spExpandedFill.style.width = pct + '%';
  if (spExpandedThumb) spExpandedThumb.style.left = pct + '%';
  if (spExpandedTimeCur) spExpandedTimeCur.textContent = formatTime(cur);
  if (spExpandedTimeDur) spExpandedTimeDur.textContent = formatTime(dur);`;
js = js.replace(progOld, progNew);

fs.writeFileSync('src/musica.js', js);
console.log('Done!');
