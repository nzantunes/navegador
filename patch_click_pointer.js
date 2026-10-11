const fs = require('fs');
let js = fs.readFileSync('src/musica.js', 'utf8');

const oldStr = `  function onPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    if (spBottomPlayer) {
      spBottomPlayer.style.setProperty('transition', '', '');`;

const newStr = `  function onPointerUp(e) {
    if (!isDragging) return;
    const moved = hasMovedPointer;
    isDragging = false;
    hasMovedPointer = false;
    
    // Se não arrastou e não é minimizado, expande!
    if (!moved && spBottomPlayer && !spBottomPlayer.classList.contains('is-minimized')) {
       if (e && !e.target.closest('button') && !e.target.closest('.sp-ctrl-btn') && !e.target.closest('.sp-play-main-btn') && !e.target.closest('#sp-player-progress-container') && !e.target.closest('.sp-eq-panel') && !e.target.closest('#sp-drag-handle')) {
           const spExpandedPlayer = document.getElementById('sp-expanded-player');
           if (spExpandedPlayer) spExpandedPlayer.classList.remove('hidden');
       }
    }
    
    if (spBottomPlayer) {
      spBottomPlayer.style.setProperty('transition', '', '');`;

js = js.replace(oldStr, newStr);

fs.writeFileSync('src/musica.js', js);
console.log('patched');
