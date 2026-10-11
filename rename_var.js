const fs = require('fs');
const path = require('path');
const rendererPath = path.join(__dirname, 'src', 'renderer.js');
let code = fs.readFileSync(rendererPath, 'utf8');
code = code.replace(/openSpotifyMiniPlayer\((.*?)\)/g, "openPapaleguasMusic($1)");
fs.writeFileSync(rendererPath, code, 'utf8');
console.log('Renomeado com sucesso.');
