const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('torBrowserAPI', {
  clearBrowsingTraces: () => ipcRenderer.invoke('clear-browsing-traces'),
  getSavedBookmarks: () => ipcRenderer.invoke('get-saved-bookmarks'),
  getTorStatus: () => ipcRenderer.invoke('get-tor-status'),
  toggleTor: (enabled) => ipcRenderer.invoke('toggle-tor', enabled),
  getTorIpInfo: () => ipcRenderer.invoke('get-tor-ip-info'),
  queryAstraAI: (prompt) => ipcRenderer.invoke('query-astra-ai', prompt),
  getNewTabUrl: () => ipcRenderer.invoke('get-newtab-url'),
  getAdblockStatus: () => ipcRenderer.invoke('get-adblock-status'),
  toggleAdblock: (enabled) => ipcRenderer.invoke('toggle-adblock', enabled),
  executeCode: (language, code) => ipcRenderer.invoke('execute-code-direct', { language, code }),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  offerYoutubePip: (state) => ipcRenderer.send('youtube-pip-offer', state),
  restoreMainFromPip: () => ipcRenderer.send('restore-main-from-pip'),
  closePipAndQuit: () => ipcRenderer.send('close-pip-and-quit'),
  onQueryYoutubePip: (cb) => {
    ipcRenderer.removeAllListeners('query-youtube-pip');
    ipcRenderer.on('query-youtube-pip', () => { if (typeof cb === 'function') cb(); });
  },
  getCastDevices: (opts = {}) => ipcRenderer.invoke('get-cast-devices', opts),
  scanClientLan: () => ipcRenderer.invoke('scan-client-lan'),
  castToDevice: (deviceId, url, title = '') => ipcRenderer.invoke('cast-to-device', { deviceId, url, title }),
  openScreenMirroring: () => ipcRenderer.invoke('open-screen-mirroring'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  onOpenUrlInApp: (cb) => {
    ipcRenderer.removeAllListeners('open-url-in-app');
    ipcRenderer.on('open-url-in-app', (_event, url) => {
      if (typeof cb === 'function') cb(url);
    });
  },
  searchMusic: (query, limit = 30, index = 0) => ipcRenderer.invoke('search-music', query, limit, index),
  searchPlaylists: (query) => ipcRenderer.invoke('search-playlists', query),
  searchAll: (query) => ipcRenderer.invoke('search-all', query),
  getPlaylistTracks: (playlistId) => ipcRenderer.invoke('get-playlist-tracks', playlistId),
  getAiMusicRecommendations: (query, category, excludeTitles) => ipcRenderer.invoke('get-ai-music-recommendations', query, category, excludeTitles),
  chatDjPapaleguas: (userMessage, history, excludeTitles, trackCount) => ipcRenderer.invoke('chat-dj-papaleguas', userMessage, history, excludeTitles, trackCount),
  getFullAudioStream: (track) => ipcRenderer.invoke('get-full-audio-stream', track),
  saveFavoriteTrack: (payload) => ipcRenderer.invoke('save-favorite-track', payload),
  saveFavoritePlaylistIndex: (payload) => ipcRenderer.invoke('save-favorite-playlist-index', payload),
  listFavoritePlaylists: () => ipcRenderer.invoke('list-favorite-playlists'),
  scanDownloadedMusic: (query) => ipcRenderer.invoke('scan-downloaded-music', query),
  getFavoritePlaylist: (name) => ipcRenderer.invoke('get-favorite-playlist', name),
  readFavoriteTrack: (playlist, fileName) => ipcRenderer.invoke('read-favorite-track', playlist, fileName),
  openFavoriteFolder: (name) => ipcRenderer.invoke('open-favorite-folder', name),
  deleteFavoritePlaylist: (name) => ipcRenderer.invoke('delete-favorite-playlist', name),
  deleteFavoriteTrack: (playlist, fileName) => ipcRenderer.invoke('delete-favorite-track', playlist, fileName),
  renameFavoritePlaylist: (payload) => ipcRenderer.invoke('rename-favorite-playlist', payload),
  editFavoriteTrack: (payload) => ipcRenderer.invoke('edit-favorite-track', payload),
  setFavoritePlaylistCover: (payload) => ipcRenderer.invoke('set-favorite-playlist-cover', payload),
  createFavoritePlaylist: (name) => ipcRenderer.invoke('create-favorite-playlist', name),
  updateMusicTrayState: (state) => ipcRenderer.send('update-music-tray-state', state),
  onMusicTrayCommand: (cb) => {
    ipcRenderer.removeAllListeners('music-tray-command');
    ipcRenderer.on('music-tray-command', (_ev, cmd) => {
      if (typeof cb === 'function') cb(cmd);
    });
  },
  isElectron: true
});
