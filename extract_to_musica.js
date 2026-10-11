const fs = require('fs');
const path = require('path');

const rendererPath = path.join(__dirname, 'src', 'renderer.js');
const musicaPath = path.join(__dirname, 'src', 'musica.js');

let lines = fs.readFileSync(rendererPath, 'utf8').split('\n');

// Extrai do 1319 ao 2358
const start = 1319;
const end = 2358;

const musicaCode = lines.slice(start, end).join('\n');

// Cria o musica.js
const initCode = `
// ============================================================================
// INICIALIZAÇÃO - PAPALÉGUAS MUSIC
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  // Carrega as músicas recomendadas iniciais
  if (typeof performMusicSearch === 'function') {
    performMusicSearch('', 'all');
  }
});
`;

fs.writeFileSync(musicaPath, musicaCode + '\n' + initCode, 'utf8');
console.log('musica.js criado com sucesso com ' + musicaCode.split('\n').length + ' linhas.');
