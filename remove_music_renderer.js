const fs = require('fs');
const path = require('path');

const rendererPath = path.join(__dirname, 'src', 'renderer.js');
let lines = fs.readFileSync(rendererPath, 'utf8').split('\n');

const start = 1319;
const end = 2358;

// Remove as linhas
lines.splice(start, end - start);

fs.writeFileSync(rendererPath, lines.join('\n'), 'utf8');
console.log('renderer.js atualizado.');
