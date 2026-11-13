# 🤖 Relatório de Melhorias Autônomas do Antigravity

*Gerado automaticamente em: 04/11/2026, 19:52:05*

## 📊 Resumo Executivo
- **Arquivos Analisados:** 51
- **Linhas de Código:** 69715
- **Oportunidades de Performance:** 101
- **Sugestões de Resiliência/Segurança:** 17
- **Sintaxe Íntegra:** ✅ Sim (100%)

## 📋 Detalhamento das Melhorias

### 1. [MÉDIA] src/auto-update.js:95
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch('/api/session-info?_pl_upd=' + Date.now(), { cache: 'no-store' })
```

### 2. [BAIXA] src/musica.js:1
- **Categoria:** Arquitetura
- **Problema:** Arquivo com 6769 linhas ultrapassa o limite de modularidade recomendado.
- **Ação Recomendada:** Extrair módulos de rotas e utilitários para pastas dedicadas (ex: main/routes/ ou src/modules/).
```javascript
// Polyfill de fetch para ambiente local Electron (file://) rotear requisições /api/ para http://localhost:8080
```

### 3. [MÉDIA] src/musica.js:2108
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img class="sp-track-thumb" src="${track.cover || 'papaleguas_logo.png'}" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src='papaleguas_logo.png';}" alt="" />
```

### 4. [MÉDIA] src/musica.js:2432
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
doc.body.innerHTML = '<img id="pip-cover" alt="Capa" src="papaleguas_logo.png">'
```

### 5. [MÉDIA] src/musica.js:2971
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img class="sp-track-thumb" src="${item.cover || 'papaleguas_logo.png'}" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src='papaleguas_logo.png';}" alt="" />
```

### 6. [MÉDIA] src/musica.js:3088
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img class="sp-track-thumb" src="${pl.cover || 'papaleguas_logo.png'}" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src='papaleguas_logo.png';}" alt="" />
```

### 7. [MÉDIA] src/musica.js:3844
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img src="${pl.cover || 'papaleguas_logo.png'}" onerror="this.src='papaleguas_logo.png';" style="width:38px;height:38px;border-radius:6px;object-fit:cover;flex-shrink:0;" alt="" />
```

### 8. [MÉDIA] src/musica.js:3976
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img class="sp-fav-thumb" src="${item.cover || 'papaleguas_logo.png'}" onerror="this.src='papaleguas_logo.png';" alt="" />
```

### 9. [MÉDIA] src/musica.js:4792
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img class="sp-related-thumb" src="${track.cover || 'papaleguas_logo.png'}" onerror="this.src='papaleguas_logo.png';" alt="" />
```

### 10. [MÉDIA] src/musica.js:5341
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img src="${coverSrc}" onerror="this.src='papaleguas_logo.png';" alt="" />
```

### 11. [BAIXA] src/newtab.html:1
- **Categoria:** Arquitetura
- **Problema:** Arquivo com 9339 linhas ultrapassa o limite de modularidade recomendado.
- **Ação Recomendada:** Extrair módulos de rotas e utilitários para pastas dedicadas (ex: main/routes/ ou src/modules/).
```javascript
<!DOCTYPE html>
```

### 12. [MÉDIA] src/newtab.html:4032
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img src="icon-192.png" alt="Papaléguas" style="width:16px;height:16px;border-radius:4px;object-fit:cover;vertical-align:middle;margin-right:5px;box-shadow:0 0 6px rgba(56,189,248,0.5);" onerror="this.onerror=null;this.src='papaleguas_icon.png';" />
```

### 13. [MÉDIA] src/newtab.html:5234
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch(`/api/youtube-liked-feed?country=${encodeURIComponent(countryParam)}${manualFlag}&deviceId=${encodeURIComponent(currentDeviceId)}`, {
```

### 14. [MÉDIA] src/newtab.html:5374
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
? fetch(`/api/youtube-recent?q=${encodeURIComponent(relatedKw)}&time=hour&country=${encodeURIComponent(countryParam)}${manualFlag}&includeLiked=0&_t=${Date.now()}`, {
```

### 15. [MÉDIA] src/newtab.html:5658
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
```

### 16. [MÉDIA] src/newtab.html:6485
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch('/api/youtube-oembed?v=' + encodeURIComponent(targetId))
```

### 17. [MÉDIA] src/newtab.html:7795
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch(`/api/youtube-recent?q=${encodeURIComponent(searchQuery)}&time=${encodeURIComponent(activeTime)}&country=${encodeURIComponent(countryParam)}${manualParam}${detectedClientDeviceIp ? `&deviceIp=${encodeURIComponent(detectedClientDeviceIp)}` : ''}&_t=${timestamp}`, {
```

### 18. [MÉDIA] src/newtab.html:8988
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch('/api/youtube-oembed?v=' + encodeURIComponent(bootV))
```

### 19. [BAIXA] src/renderer.js:1
- **Categoria:** Arquitetura
- **Problema:** Arquivo com 7186 linhas ultrapassa o limite de modularidade recomendado.
- **Ação Recomendada:** Extrair módulos de rotas e utilitários para pastas dedicadas (ex: main/routes/ ou src/modules/).
```javascript
// Blindagem anti-recursão: o shell do navegador (renderer.js) NUNCA deve rodar dentro de um iframe
```

### 20. [MÉDIA] src/renderer.js:233
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch('https://api4.ipify.org?format=json', { cache: 'no-store' })
```

### 21. [MÉDIA] src/renderer.js:1075
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img src="icon-192.png" alt="Papaléguas" style="width: 18px; height: 18px; object-fit: contain;" />
```

### 22. [BAIXA] src/styles.css:1
- **Categoria:** Arquitetura
- **Problema:** Arquivo com 6239 linhas ultrapassa o limite de modularidade recomendado.
- **Ação Recomendada:** Extrair módulos de rotas e utilitários para pastas dedicadas (ex: main/routes/ ou src/modules/).
```javascript
:root {
```

### 23. [MÉDIA] src/sw.js:205
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
event.respondWith(fetch(withAntiWarningHeaders(event.request)));
```

### 24. [MÉDIA] src/sw.js:212
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch(withAntiWarningHeaders(event.request))
```

### 25. [MÉDIA] src/sw.js:240
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
const fetchPromise = fetch(withAntiWarningHeaders(event.request)).then((networkResp) => {
```

### 26. [MÉDIA] src/yt-pip.html:96
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img class="pip-thumb" id="pip-thumb" alt="Miniatura do vídeo">
```

### 27. [ALTA] main/ai-client.js:9
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const raw = fs.readFileSync(filePath, 'utf8').trim...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const raw = fs.readFileSync(filePath, 'utf8').trim();
```

### 28. [ALTA] main/ai-client.js:24
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.readFileSync(filePath, 'utf8').split(/\r?\n/).f...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line) => {
```

### 29. [ALTA] main/code-runner.js:36
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(tempFilePath, code, 'utf8');...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(tempFilePath, code, 'utf8');
```

### 30. [ALTA] main/code-runner.js:40
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(tempFilePath, code, 'utf8');...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(tempFilePath, code, 'utf8');
```

### 31. [ALTA] main/logger.js:51
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (try { fs.appendFileSync(file, redact(line) + '\n')...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
try { fs.appendFileSync(file, redact(line) + '\n'); } catch (e) { /* sem disco: só console */ }
```

### 32. [ALTA] main/main.js:1647
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(target, bytes);...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(target, bytes);
```

### 33. [ALTA] main/main.js:1658
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(coverTarget, coverBytes);...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(coverTarget, coverBytes);
```

### 34. [ALTA] main/main.js:1670
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(playlistCoverTarget, coverBytes);...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(playlistCoverTarget, coverBytes);
```

### 35. [ALTA] main/main.js:1700
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(path.join(dir, 'cover.jpg'), cove...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(path.join(dir, 'cover.jpg'), coverBytes);
```

### 36. [ALTA] main/main.js:1711
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(path.join(dir, 'playlist.json'), ...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(path.join(dir, 'playlist.json'), JSON.stringify(manifest, null, 2));
```

### 37. [ALTA] main/main.js:1722
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(path.join(dir, 'cover.jpg'), byte...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(path.join(dir, 'cover.jpg'), bytes);
```

### 38. [ALTA] main/main.js:1725
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const manifest = JSON.parse(fs.readFileSync(manife...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 39. [ALTA] main/main.js:1728
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(manifestPath, JSON.stringify(mani...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
```

### 40. [ALTA] main/main.js:1758
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const manifest = JSON.parse(fs.readFileSync(path.j...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'playlist.json'), 'utf8'));
```

### 41. [ALTA] main/main.js:1767
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const b64 = fs.readFileSync(coverPath).toString('b...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const b64 = fs.readFileSync(coverPath).toString('base64');
```

### 42. [ALTA] main/main.js:1775
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const b64 = fs.readFileSync(trackCoverPath).toStri...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const b64 = fs.readFileSync(trackCoverPath).toString('base64');
```

### 43. [ALTA] main/main.js:1821
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (cover = `data:${mime};base64,${fs.readFileSync(img...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
cover = `data:${mime};base64,${fs.readFileSync(imgPath).toString('base64')}`;
```

### 44. [ALTA] main/main.js:1870
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const manifest = JSON.parse(fs.readFileSync(manife...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 45. [ALTA] main/main.js:1874
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (plCover = `data:${mime};base64,${fs.readFileSync(p...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
plCover = `data:${mime};base64,${fs.readFileSync(playlistCoverTarget).toString('base64')}`;
```

### 46. [ALTA] main/main.js:1885
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (cover = `data:${mime};base64,${fs.readFileSync(tra...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
cover = `data:${mime};base64,${fs.readFileSync(trackCoverPath).toString('base64')}`;
```

### 47. [ALTA] main/main.js:1914
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (plCover = `data:${mime};base64,${fs.readFileSync(i...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
plCover = `data:${mime};base64,${fs.readFileSync(imgPath).toString('base64')}`;
```

### 48. [ALTA] main/main.js:1960
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (data: fs.readFileSync(target)...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
data: fs.readFileSync(target)
```

### 49. [ALTA] main/main.js:1969
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (data: fs.readFileSync(target)...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
data: fs.readFileSync(target)
```

### 50. [ALTA] main/main.js:2010
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (trCover = `data:image/jpeg;base64,${fs.readFileSyn...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
trCover = `data:image/jpeg;base64,${fs.readFileSync(candCover).toString('base64')}`;
```

### 51. [ALTA] main/main.js:2012
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (trCover = `data:image/jpeg;base64,${fs.readFileSyn...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
trCover = `data:image/jpeg;base64,${fs.readFileSync(candAlbum).toString('base64')}`;
```

### 52. [ALTA] main/main.js:2054
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const m = JSON.parse(fs.readFileSync(manifestPath,...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 53. [ALTA] main/main.js:2059
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (plCover = `data:${mime};base64,${fs.readFileSync(c...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
plCover = `data:${mime};base64,${fs.readFileSync(cPath).toString('base64')}`;
```

### 54. [ALTA] main/main.js:2071
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (trCover = `data:${mime};base64,${fs.readFileSync(c...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
trCover = `data:${mime};base64,${fs.readFileSync(cTarget).toString('base64')}`;
```

### 55. [ALTA] main/main.js:2126
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(manifestPath, JSON.stringify(mani...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
```

### 56. [ALTA] main/main.js:2154
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const m = JSON.parse(fs.readFileSync(path.join(can...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const m = JSON.parse(fs.readFileSync(path.join(candidateDir, 'playlist.json'), 'utf8'));
```

### 57. [ALTA] main/main.js:2214
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const manifest = JSON.parse(fs.readFileSync(manife...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 58. [ALTA] main/main.js:2221
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(manifestPath, JSON.stringify(mani...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
```

### 59. [ALTA] main/main.js:2275
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const m = JSON.parse(fs.readFileSync(manifestPath,...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 60. [ALTA] main/main.js:2279
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(manifestPath, JSON.stringify(m, n...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
```

### 61. [ALTA] main/main.js:2309
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const manifest = JSON.parse(fs.readFileSync(manife...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 62. [ALTA] main/main.js:2316
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(manifestPath, JSON.stringify(mani...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
```

### 63. [ALTA] main/main.js:2387
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const parsed = JSON.parse(fs.readFileSync(file, 'u...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
```

### 64. [ALTA] main/main.js:2439
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(savedBookmarksFile(), JSON.string...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(savedBookmarksFile(), JSON.stringify(bookmarks), 'utf8');
```

### 65. [ALTA] main/python-runner.js:350
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(path.join(templatesDir, 'index.ht...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(path.join(templatesDir, 'index.html'), defaultIndexHtml, 'utf8');
```

### 66. [ALTA] main/python-runner.js:406
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(scriptPath, cleanCode, 'utf8');...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(scriptPath, cleanCode, 'utf8');
```

### 67. [ALTA] main/python-runner.js:536
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(scriptPath, cleanCode, 'utf8');...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(scriptPath, cleanCode, 'utf8');
```

### 68. [ALTA] main/python-runner.js:558
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (plotBase64 = 'data:image/png;base64,' + fs.readFil...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
plotBase64 = 'data:image/png;base64,' + fs.readFileSync(plotPath).toString('base64');
```

### 69. [ALTA] main/routes/curator.js:142
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const parsed = JSON.parse(fs.readFileSync(file, 'u...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
```

### 70. [ALTA] main/routes/curator.js:196
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(fd, dataStr, 'utf8');...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(fd, dataStr, 'utf8');
```

### 71. [MÉDIA] main/routes/curator.js:1505
- **Categoria:** Localização & Feed
- **Problema:** Possível país estático "BR" fixado no código.
- **Ação Recomendada:** Garantir uso de detecção por IP ou getEffectiveCountryParam() para suporte internacional.
```javascript
res.end(JSON.stringify({ success: false, country: 'BR', name: 'Brasil', flag: '🇧🇷', torActive: false }));
```

### 72. [ALTA] main/routes/seo-feeds.js:53
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(manifestPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(manifestPath, 'utf8'));
```

### 73. [ALTA] main/routes/seo-feeds.js:84
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(swPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(swPath, 'utf8'));
```

### 74. [ALTA] main/routes/seo-feeds.js:99
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(adsTxtPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(adsTxtPath, 'utf8'));
```

### 75. [ALTA] main/routes/seo-feeds.js:140
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(robotsPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(robotsPath, 'utf8'));
```

### 76. [ALTA] main/routes/seo-feeds.js:156
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(llmsPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(llmsPath, 'utf8'));
```

### 77. [ALTA] main/security/request-guard.js:88
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const existing = fs.readFileSync(secretFile, 'utf8...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const existing = fs.readFileSync(secretFile, 'utf8').trim();
```

### 78. [ALTA] main/security/request-guard.js:94
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(secretFile, secret, { mode: 0o600...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(secretFile, secret, { mode: 0o600 });
```

### 79. [BAIXA] main/server.js:1
- **Categoria:** Arquitetura
- **Problema:** Arquivo com 17341 linhas ultrapassa o limite de modularidade recomendado.
- **Ação Recomendada:** Extrair módulos de rotas e utilitários para pastas dedicadas (ex: main/routes/ ou src/modules/).
```javascript
require('./log-redact').installLogRedaction();
```

### 80. [ALTA] main/server.js:170
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const b64 = fs.readFileSync(qrImgPath).toString('b...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const b64 = fs.readFileSync(qrImgPath).toString('base64');
```

### 81. [MÉDIA] main/server.js:363
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img src="${BINANCE_PAY_QR_DATA_URI || '/binance_pay_qr.jpg'}" alt="Escaneie com Binance App para pagar 5 USDT" />
```

### 82. [ALTA] main/server.js:397
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const txt = fs.readFileSync(swPath, 'utf8');...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const txt = fs.readFileSync(swPath, 'utf8');
```

### 83. [MÉDIA] main/server.js:614
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img src="${cleanImg}" alt="${cleanTitle}" class="thumb">
```

### 84. [MÉDIA] main/server.js:2415
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch('/api/media/download-status?jobId=' + encodeURIComponent(jobId))
```

### 85. [ALTA] main/server.js:3540
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const raw = fs.readFileSync(path.join(__dirname, '...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const raw = fs.readFileSync(path.join(__dirname, '../gupifilm_movies.json'), 'utf8');
```

### 86. [ALTA] main/server.js:6107
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (info = JSON.parse(fs.readFileSync(infoPath, 'utf8'...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
```

### 87. [ALTA] main/server.js:9783
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const arr = JSON.parse(fs.readFileSync(DELETED_PLA...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const arr = JSON.parse(fs.readFileSync(DELETED_PLAYLISTS_FILE, 'utf8'));
```

### 88. [ALTA] main/server.js:9798
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(DELETED_PLAYLISTS_FILE, JSON.stri...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(DELETED_PLAYLISTS_FILE, JSON.stringify(Array.from(set)), 'utf8');
```

### 89. [ALTA] main/server.js:9808
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(DELETED_PLAYLISTS_FILE, JSON.stri...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(DELETED_PLAYLISTS_FILE, JSON.stringify(Array.from(set)), 'utf8');
```

### 90. [ALTA] main/server.js:9854
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const mf = JSON.parse(fs.readFileSync(manifestPath...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const mf = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 91. [ALTA] main/server.js:9933
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const m = JSON.parse(fs.readFileSync(manifestPath,...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 92. [ALTA] main/server.js:9963
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const m = JSON.parse(fs.readFileSync(manifestPath,...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 93. [ALTA] main/server.js:10075
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const manifest = JSON.parse(fs.readFileSync(manife...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 94. [ALTA] main/server.js:10153
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (try { manifest = JSON.parse(fs.readFileSync(manife...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { swallowed(e, 'server:top@10355'); }
```

### 95. [ALTA] main/server.js:10159
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(manifestPath, JSON.stringify(mani...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
```

### 96. [ALTA] main/server.js:10216
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const mf = JSON.parse(fs.readFileSync(path.join(ro...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const mf = JSON.parse(fs.readFileSync(path.join(rootDir, ent.name, 'playlist.json'), 'utf8'));
```

### 97. [ALTA] main/server.js:10277
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const m = JSON.parse(fs.readFileSync(manifestPath,...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 98. [ALTA] main/server.js:10283
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(manifestPath, JSON.stringify(m, n...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
```

### 99. [ALTA] main/server.js:10333
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const m = JSON.parse(fs.readFileSync(manifestPath,...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 100. [ALTA] main/server.js:10336
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(manifestPath, JSON.stringify(m, n...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
```

### 101. [ALTA] main/server.js:10366
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const m = JSON.parse(fs.readFileSync(manifestPath,...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 102. [ALTA] main/server.js:10372
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(manifestPath, JSON.stringify(m, n...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
```

### 103. [ALTA] main/server.js:10469
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const m = JSON.parse(fs.readFileSync(manifestPath,...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
```

### 104. [MÉDIA] main/server.js:11059
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch('/api/python/servers')
```

### 105. [MÉDIA] main/server.js:12138
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img class="wiki-thumb-img" src="${escapeHtml(wikiData.thumbnail)}" alt="${escapeHtml(wikiData.title)}" />
```

### 106. [MÉDIA] main/server.js:13667
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch('/api/search-answer?q=' + encodeURIComponent(currentQuery) + '&clientId=' + encodeURIComponent(suggestClientId))
```

### 107. [MÉDIA] main/server.js:13753
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch('/api/search-picks?q=' + encodeURIComponent(currentQuery) + '&clientId=' + encodeURIComponent(suggestClientId))
```

### 108. [MÉDIA] main/server.js:13779
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch('/api/search-chat?clientId=' + encodeURIComponent(suggestClientId), {
```

### 109. [ALTA] main/server.js:14240
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(adminHtmlPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(adminHtmlPath, 'utf8'));
```

### 110. [ALTA] main/server.js:14252
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(cssPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(cssPath, 'utf8'));
```

### 111. [ALTA] main/server.js:14264
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(jsPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(jsPath, 'utf8'));
```

### 112. [MÉDIA] main/server.js:15284
- **Categoria:** Mobile & Carregamento
- **Problema:** Elemento <img> sem atributo loading="lazy".
- **Ação Recomendada:** Adicionar loading="lazy" e decoding="async" para economizar 4G e acelerar o FCP no celular.
```javascript
<img src="/icon-192.png?v=4" alt="Papaléguas" style="width:32px;height:32px;border-radius:50%;object-fit:cover;box-shadow:0 0 10px rgba(245,158,11,0.5);" />
```

### 113. [MÉDIA] main/server.js:15813
- **Categoria:** Resiliência
- **Problema:** Chamada fetch() sem tratamento de erro (.catch).
- **Ação Recomendada:** Adicionar .catch(() => {}) ou envelopar em bloco try/catch para evitar falha silenciosa.
```javascript
fetch('/api/country-detect', { cache: 'no-store' })
```

### 114. [ALTA] main/server.js:17313
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (if (fs.existsSync(tunnelLog)) fs.writeFileSync(tun...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
if (fs.existsSync(tunnelLog)) fs.writeFileSync(tunnelLog, '', 'utf8');
```

### 115. [ALTA] main/telegram-bot.js:28
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const saved = JSON.parse(fs.readFileSync(CONFIG_PA...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
```

### 116. [ALTA] main/telegram-bot.js:38
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(CONFIG_PATH, JSON.stringify(botCo...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(CONFIG_PATH, JSON.stringify(botConfig, null, 2), 'utf8');
```

### 117. [ALTA] main/tor-manager.js:50
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(this.torrcPath, conf, { mode: 0o6...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(this.torrcPath, conf, { mode: 0o600 });
```

### 118. [ALTA] main/routes/curator.js:142
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (const parsed = JSON.parse(fs.readFileSync(file, 'u...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
```

### 119. [ALTA] main/routes/curator.js:196
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (fs.writeFileSync(fd, dataStr, 'utf8');...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
fs.writeFileSync(fd, dataStr, 'utf8');
```

### 120. [MÉDIA] main/routes/curator.js:1505
- **Categoria:** Localização & Feed
- **Problema:** Possível país estático "BR" fixado no código.
- **Ação Recomendada:** Garantir uso de detecção por IP ou getEffectiveCountryParam() para suporte internacional.
```javascript
res.end(JSON.stringify({ success: false, country: 'BR', name: 'Brasil', flag: '🇧🇷', torActive: false }));
```

### 121. [ALTA] main/routes/seo-feeds.js:53
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(manifestPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(manifestPath, 'utf8'));
```

### 122. [ALTA] main/routes/seo-feeds.js:84
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(swPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(swPath, 'utf8'));
```

### 123. [ALTA] main/routes/seo-feeds.js:99
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(adsTxtPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(adsTxtPath, 'utf8'));
```

### 124. [ALTA] main/routes/seo-feeds.js:140
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(robotsPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(robotsPath, 'utf8'));
```

### 125. [ALTA] main/routes/seo-feeds.js:156
- **Categoria:** Performance
- **Problema:** Chamada síncrona de I/O em tempo de execução (res.end(fs.readFileSync(llmsPath, 'utf8'));...).
- **Ação Recomendada:** Substituir por fs.promises ou streams assíncronas para não travar o event loop do Node.js.
```javascript
res.end(fs.readFileSync(llmsPath, 'utf8'));
```

