const fs = require('fs');
let js = fs.readFileSync('src/musica.js', 'utf8');

const target = "const spMiniTrackInfo = document.getElementById('sp-mini-track-info');";
const replacement = `
const theBottomPlayer = document.getElementById('sp-bottom-player');
if (theBottomPlayer) {
  theBottomPlayer.addEventListener('click', (e) => {
    // Se clicar em um botão ou na barra de progresso, não expande
    if (e.target.closest('button') || e.target.closest('.sp-ctrl-btn') || e.target.closest('.sp-play-main-btn') || e.target.closest('#sp-player-progress-container') || e.target.closest('.sp-eq-panel') || e.target.closest('#sp-drag-handle')) {
      return;
    }
    if (theBottomPlayer.classList.contains('is-minimized')) return;
    if (spExpandedPlayer) spExpandedPlayer.classList.remove('hidden');
  });
}
const spMiniTrackInfo = document.getElementById('sp-mini-track-info');`;

js = js.replace(target, replacement);
fs.writeFileSync('src/musica.js', js);
console.log('patched');
