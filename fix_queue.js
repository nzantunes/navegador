const fs = require('fs');
let code = fs.readFileSync('src/musica.js', 'utf8');

// 1. Declare variables
code = code.replace(
  'let currentTracksList = [];',
  'let currentTracksList = [];\nwindow.playingTracksList = null;\nwindow.playingPlaylistName = "";'
);

// 2. Modify playTrackAtIndex signature and start
const playTrackOld = `async function playTrackAtIndex(index) {
  window.isUserIntentionallyPaused = false;
  if (typeof stopModalPreview === 'function') {
    stopModalPreview();
  }
  document.body.classList.remove('is-editing-playlist');
  if (!currentTracksList || currentTracksList.length === 0) return;`;

const playTrackNew = `async function playTrackAtIndex(index, fromUserClick = true) {
  window.isUserIntentionallyPaused = false;
  if (typeof stopModalPreview === 'function') { stopModalPreview(); }
  document.body.classList.remove('is-editing-playlist');
  
  if (fromUserClick) {
    window.playingTracksList = [...(currentTracksList || [])];
    const spInput = document.getElementById('spotify-search-input');
    window.playingPlaylistName = selectedPlaylistName || (spInput && spInput.value ? spInput.value : 'Sua Busca');
  }

  const actList = window.playingTracksList || currentTracksList;
  if (!actList || actList.length === 0) return;`;

code = code.replace(playTrackOld, playTrackNew);

// 3. Replace currentTracksList with actList inside playTrackAtIndex logic
// The logic is roughly from "if (index >= currentTracksList.length)" until the end of playTrackAtIndex (or up to "const track =").
code = code.replace(
  'if (index >= currentTracksList.length) {',
  'if (index >= actList.length) {'
);
code = code.replace(
  'index = isRepeat ? 0 : currentTracksList.length - 1;',
  'index = isRepeat ? 0 : actList.length - 1;'
);
code = code.replace(
  'index = currentTracksList.length - 1;',
  'index = actList.length - 1;'
);
code = code.replace(
  'const track = currentTracksList[currentTrackIndex];',
  'const track = actList[currentTrackIndex];'
);

// 4. Update spMiniArtist to show playlist name
code = code.replace(
  'if (spMiniArtist) spMiniArtist.textContent = track.artist;',
  'if (spMiniArtist) spMiniArtist.textContent = window.playingPlaylistName ? track.artist + " • " + window.playingPlaylistName : track.artist;'
);

// 5. Update playNextTrack
const nextOld = `async function playNextTrack() {
  if (isShuffle) {
    const randIndex = Math.floor(Math.random() * currentTracksList.length);
    playTrackAtIndex(randIndex);
    return;
  }

  const nextIdx = currentTrackIndex + 1;

  if (isCurrentListFromDj && nextIdx >= currentTracksList.length) {
    if (isRepeat) playTrackAtIndex(0);
    return;
  }

  // Se chegou ao final da lista, encerra ou volta ao começo
  if (nextIdx >= currentTracksList.length) {
    if (isRepeat) {
      playTrackAtIndex(0);
    }
    return;
  }

  playTrackAtIndex(nextIdx);
}`;

const nextNew = `async function playNextTrack() {
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
    if (isRepeat) { playTrackAtIndex(0, false); }
    return;
  }
  playTrackAtIndex(nextIdx, false);
}`;
code = code.replace(nextOld, nextNew);

// 6. Update playPrevTrack
code = code.replace(
  'function playPrevTrack() {\n  playTrackAtIndex(currentTrackIndex - 1);\n}',
  'function playPrevTrack() {\n  playTrackAtIndex(currentTrackIndex - 1, false);\n}'
);

// 7. Update updateMediaSession
code = code.replace(
  'const track = currentTracksList && currentTracksList[currentTrackIndex];',
  'const actList = window.playingTracksList || currentTracksList;\n    const track = actList && actList[currentTrackIndex];'
);

// 8. Update preloadNextTrackAudio
code = code.replace(
  'if (!currentTracksList || nextIndex >= currentTracksList.length) return;\n  const nextTrack = currentTracksList[nextIndex];',
  'const actList = window.playingTracksList || currentTracksList;\n  if (!actList || nextIndex >= actList.length) return;\n  const nextTrack = actList[nextIndex];'
);

// 9. Update getCurrentTrack
code = code.replace(
  'return (currentTracksList && currentTracksList[currentTrackIndex]) || null;',
  'const actList = window.playingTracksList || currentTracksList;\n  return (actList && actList[currentTrackIndex]) || null;'
);

// 10. Update getSessionExcludeTitles
code = code.replace(
  'const currentTitles = (currentTracksList || []).map(t => t.title).filter(Boolean);',
  'const actList = window.playingTracksList || currentTracksList || [];\n  const currentTitles = actList.map(t => t.title).filter(Boolean);'
);

fs.writeFileSync('src/musica.js', code);
console.log('Done!');
