const fs = require('fs');
const path = require('path');

const rendererPath = path.join(__dirname, 'src', 'renderer.js');
const musicaPath = path.join(__dirname, 'src', 'musica.js');

let lines = fs.readFileSync(rendererPath, 'utf8').split('\n');

// Vamos encontrar o bloco de código do Spotify
let startIndex = -1;
let endIndex = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("const btnSpotify = document.getElementById('btn-spotify');") && startIndex === -1) {
    startIndex = i;
  }
  // Encontrar o fim. Provavelmente é antes de // Fim do arquivo ou das últimas chaves do DJ AI
  if (lines[i].includes("// ==========================================") && i > startIndex) {
    // Isso pode ser o fim, vamos verificar se tem
  }
}

console.log("Start Index:", startIndex);

