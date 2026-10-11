const fs = require('fs');
let js = fs.readFileSync('src/musica.js', 'utf8');

// Adiciona a variável hasMovedPointer junto com as outras vars de drag
js = js.replace('let isDragging = false;', 'let isDragging = false;\n  let hasMovedPointer = false;');

js = js.replace('isDragging = true;\n    dragStartX', 'isDragging = true;\n    hasMovedPointer = false;\n    dragStartX');

js = js.replace('const deltaX = clientX - dragStartX;', 'const deltaX = clientX - dragStartX;\n    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) hasMovedPointer = true;');

fs.writeFileSync('src/musica.js', js);
console.log('fixed');
