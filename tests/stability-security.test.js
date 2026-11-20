'use strict';
// =========================================================================
// PAPALÉGUAS - SUÍTE DE TESTES AUTOMATIZADOS (Estabilidade & Segurança)
// =========================================================================
// Usa o runner nativo `node --test` (zero dependências extras).
// Cobre:
//   1. RateLimiter (janela deslizante e poda sob pressão de memória)
//   2. ConcurrencyLimiter (vagas simultâneas e liberação idempotente)
//   3. RequestGuard (bypass local, cookie de sessão assinado, /proxy anônimo
//      vs autenticado, limite de concorrência em streams de mídia)
//   4. Logger + swallowed() + receptor /api/client-log
//   5. Proteções de regressão da sessão de mídia em segundo plano (musica.js
//      e renderer.js)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { RateLimiter, ConcurrencyLimiter } = require('../main/security/rate-limit');
const { createRequestGuard, identifyRequester } = require('../main/security/request-guard');
const logger = require('../main/logger');
const { handleClientLog } = require('../main/client-log');

function mockReq({ ip = '203.0.113.50', cfIp = '', method = 'GET', headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { ...headers };
  if (cfIp) req.headers['cf-connecting-ip'] = cfIp;
  req.socket = { remoteAddress: ip };
  req.destroy = () => {};
  return req;
}

function mockRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  res.body = '';
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.writeHead = (code, hdrs = {}) => {
    res.statusCode = code;
    res.headersSent = true;
    for (const [k, v] of Object.entries(hdrs)) res.headers[k.toLowerCase()] = v;
  };
  res.end = (chunk = '') => {
    res.body = String(chunk);
    res.emit('finish');
  };
  return res;
}

test('RateLimiter bloqueia ao atingir o limite e libera após a janela', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 3 });
  const t0 = 100000;
  assert.equal(rl.hit('ip1', t0).allowed, true);
  assert.equal(rl.hit('ip1', t0 + 10).allowed, true);
  assert.equal(rl.hit('ip1', t0 + 20).allowed, true);
  const fourth = rl.hit('ip1', t0 + 30);
  assert.equal(fourth.allowed, false);
  assert.ok(fourth.retryAfterSec >= 1);

  // Após 2 janelas completas volta a permitir normalmente
  assert.equal(rl.hit('ip1', t0 + 2100).allowed, true);
});

test('ConcurrencyLimiter controla conexões simultâneas e tem release idempotente', () => {
  const cl = new ConcurrencyLimiter({ max: 2 });
  const r1 = cl.acquire('ip1');
  const r2 = cl.acquire('ip1');
  assert.equal(typeof r1, 'function');
  assert.equal(typeof r2, 'function');
  assert.equal(cl.acquire('ip1'), null);

  r1();
  r1(); // idempotente: chamar duas vezes não pode liberar a vaga de r2
  assert.equal(cl.count('ip1'), 1);

  const r3 = cl.acquire('ip1');
  assert.equal(typeof r3, 'function');
  r2();
  r3();
  assert.equal(cl.count('ip1'), 0);
});

test('RequestGuard nunca limita clientes locais (Electron / LAN)', () => {
  const guard = createRequestGuard({ secret: 'a'.repeat(64) });
  try {
    for (let i = 0; i < 100; i++) {
      const req = mockReq({ ip: '127.0.0.1' });
      const res = mockRes();
      assert.equal(guard.check(req, res, '/proxy', { nativeRateLimitActive: true }), false);
    }
  } finally {
    guard.stop();
  }
});

test('RequestGuard diferencia /proxy anônimo de usuário com sessão válida do app', () => {
  const guard = createRequestGuard({ secret: 'b'.repeat(64) });
  try {
    // 1. Ao abrir a Home como documento HTML, recebe cookie pl_sid assinado
    const docReq = mockReq({ cfIp: '198.51.100.10', headers: { accept: 'text/html' } });
    const docRes = mockRes();
    assert.equal(guard.check(docReq, docRes, '/', { nativeRateLimitActive: true }), false);
    const setCookie = docRes.headers['set-cookie'];
    assert.ok(setCookie && setCookie.startsWith('pl_sid='), 'deve emitir cookie pl_sid');
    const cookiePair = setCookie.split(';')[0];

    // 2. Chamadas /proxy anônimas (ex.: script externo) batem no limite baixo (40/min)
    let blockedAnon = false;
    for (let i = 0; i < 55; i++) {
      const req = mockReq({ cfIp: '198.51.100.99' });
      const res = mockRes();
      if (guard.check(req, res, '/proxy', { nativeRateLimitActive: true })) {
        blockedAnon = true;
        assert.equal(res.statusCode, 429);
        break;
      }
    }
    assert.equal(blockedAnon, true, 'chamadas /proxy sem sessão devem ser bloqueadas em ~40 req/min');

    // 3. Usuário com cookie pl_sid passa de 55 chamadas sem bloqueio
    for (let i = 0; i < 55; i++) {
      const req = mockReq({ cfIp: '198.51.100.10', headers: { cookie: cookiePair } });
      const res = mockRes();
      assert.equal(guard.check(req, res, '/proxy', { nativeRateLimitActive: true }), false);
    }
  } finally {
    guard.stop();
  }
});

test('RequestGuard limita streams pesados simultâneos e libera ao fechar a resposta', () => {
  const guard = createRequestGuard({ secret: 'c'.repeat(64) });
  try {
    const activeRes = [];
    for (let i = 0; i < 8; i++) {
      const req = mockReq({ cfIp: '203.0.113.77' });
      const res = mockRes();
      assert.equal(guard.check(req, res, '/api/stream-audio', { nativeRateLimitActive: true }), false);
      activeRes.push(res);
    }
    // 9ª conexão simultânea do mesmo IP deve receber 429
    const extraReq = mockReq({ cfIp: '203.0.113.77' });
    const extraRes = mockRes();
    assert.equal(guard.check(extraReq, extraRes, '/api/stream-audio', { nativeRateLimitActive: true }), true);
    assert.equal(extraRes.statusCode, 429);

    // Ao encerrar uma das conexões, uma nova vaga abre imediatamente
    activeRes[0].emit('close');
    const nextReq = mockReq({ cfIp: '203.0.113.77' });
    const nextRes = mockRes();
    assert.equal(guard.check(nextReq, nextRes, '/api/stream-audio', { nativeRateLimitActive: true }), false);
  } finally {
    guard.stop();
  }
});

test('logger.swallowed contabiliza falhas silenciosas e /api/client-log grava erros com redaction', async () => {
  logger.swallowed(new Error('falha de teste'), 'unit:test@1');
  logger.swallowed(new Error('falha de teste'), 'unit:test@1');
  const stats = logger.getSwallowedStats(20);
  const found = stats.find((s) => s.where === 'unit:test@1');
  assert.ok(found && found.count >= 2);

  const req = mockReq({ method: 'POST', headers: { 'user-agent': 'UnitTestAgent/1.0' } });
  const res = mockRes();
  const p = handleClientLog(req, res, '203.0.113.5');
  req.emit('data', Buffer.from(JSON.stringify({
    errors: [{ kind: 'onerror', page: '/musica', version: 'v100', message: 'token secret=123456 falhou' }]
  })));
  req.emit('end');
  await p;
  assert.equal(res.statusCode, 204);
});

test('Proteção de regressão: segundo plano e keep-alive da notificação continuam presentes', () => {
  const root = path.resolve(__dirname, '..');
  const bridge = fs.readFileSync(path.join(root, 'src', 'hybrid-bridge.js'), 'utf8');
  const musica = fs.readFileSync(path.join(root, 'src', 'musica.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

  assert.match(bridge, /__papaCreateKeepAlive/, 'hybrid-bridge deve expor __papaCreateKeepAlive');
  assert.match(musica, /startMediaKeepAlive/, 'musica.js deve acionar startMediaKeepAlive na transição');
  assert.match(musica, /mediaKeepAliveActive/, 'musica.js não deve marcar sessão como pausada durante keep-alive');
  assert.match(renderer, /shellOwnsBgAudio/, 'renderer.js deve ignorar pausa espúria do iframe em segundo plano');
  assert.match(renderer, /startYtKeepAlive/, 'renderer.js deve cobrir intervalo entre vídeos em segundo plano');
});

test('Transmissão para Smart TV: menu home e página música limpos e descoberta multi-protocolo presentes', () => {
  const root = path.resolve(__dirname, '..');
  const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  const newtabHtml = fs.readFileSync(path.join(root, 'src', 'newtab.html'), 'utf8');
  const musicaHtml = fs.readFileSync(path.join(root, 'src', 'musica.html'), 'utf8');
  const clientCast = fs.readFileSync(path.join(root, 'src', 'client-cast.js'), 'utf8');

  assert.doesNotMatch(newtabHtml, /id="btn-home-top-cast"/, 'newtab.html não deve ter botão de transmissão nos chips do topo');
  assert.doesNotMatch(musicaHtml, /id="btn-sp-cast"/, 'musica.html não deve ter botão de transmissão no player');
  assert.doesNotMatch(musicaHtml, /id="btn-sp-chip-cast"/, 'musica.html não deve ter botão de transmissão nos chips');
  assert.match(clientCast, /await apiDiscover\(report\)/, 'client-cast.js deve consultar /api/cast-devices na LAN');
});

test('Bloqueador de IPs (Firewall): bloqueia, protege IP local e rejeita com 403 Forbidden', () => {
  const papaleguasTracker = require('../papaleguas/tracker.js');
  const badIp = '45.160.20.10';

  // 1. Impede bloqueio de IP local / privado
  const localRes = papaleguasTracker.blockIp('127.0.0.1');
  assert.equal(localRes.success, false, 'Não deve permitir bloquear 127.0.0.1');
  assert.equal(papaleguasTracker.isIpBlocked('127.0.0.1'), false);

  // 2. Bloqueia IP externo com sucesso
  const blockRes = papaleguasTracker.blockIp(badIp, 'Bot malicioso');
  assert.equal(blockRes.success, true);
  assert.equal(papaleguasTracker.isIpBlocked(badIp), true);

  // 3. Incrementa tentativas barradas
  papaleguasTracker.recordBlockedHit(badIp);
  const list = papaleguasTracker.getBlockedIps();
  const found = list.find((b) => b.ip === badIp);
  assert.ok(found, 'IP deve estar na lista de bloqueados');
  assert.ok(found.hitsBlocked >= 1, 'hitsBlocked deve ser contabilizado');

  // 4. RequestGuard rejeita com 403 Forbidden
  const guard = createRequestGuard({
    isIpBlocked: (ip) => papaleguasTracker.isIpBlocked(ip)
  });
  const req = mockReq({ cfIp: badIp });
  const res = mockRes();
  const blocked = guard.check(req, res, '/');
  assert.equal(blocked, true, 'RequestGuard deve bloquear o IP da lista negra');
  assert.equal(res.statusCode, 403, 'Deve retornar HTTP 403 Forbidden');
  guard.stop();

  // 5. Desbloqueia com sucesso
  const unblockRes = papaleguasTracker.unblockIp(badIp);
  assert.equal(unblockRes.success, true);
  assert.equal(papaleguasTracker.isIpBlocked(badIp), false);

  // 6. Confere presença do QR Code da taxa de 5 USDT (Binance Pay)
  const root = path.resolve(__dirname, '..');
  assert.ok(fs.existsSync(path.join(root, 'src', 'binance_pay_qr.jpg')), 'binance_pay_qr.jpg deve existir em src/');
  assert.ok(fs.existsSync(path.join(root, 'papaleguas', 'binance_pay_qr.jpg')), 'binance_pay_qr.jpg deve existir em papaleguas/');
});

test('Super Navegador Rust v2.0: Índice BM25 próprio, extrator de links e limpeza de rastreadores sem cookies', () => {
  const nativeCore = require('../main/native-core');
  assert.equal(nativeCore.isRustActive, true, 'Motor Rust deve estar ativo');
  assert.match(nativeCore.rustVersion(), /v2\.0\.0/, 'Versão do motor Rust deve ser v2.0.0');

  // 1. Limpeza de parâmetros de rastreamento em URLs
  const dirtyUrl = 'https://portal.exemplo.com.br/noticia?id=99&utm_source=instagram&fbclid=IwAR12345&gclid=abc#secao';
  const cleanedUrl = nativeCore.stripTrackingParams(dirtyUrl);
  assert.equal(cleanedUrl, 'https://portal.exemplo.com.br/noticia?id=99#secao');

  // 2. Extração nativa de metadados, decodificação de acentos HTML e auto-indexação BM25
  const sampleHtml = `
    <html>
      <head>
        <title>Computa&ccedil;&atilde;o Qu&acirc;ntica no Brasil &mdash; Portal Ci&ecirc;ncia</title>
        <meta name="description" content="Avan&ccedil;os brasileiros em qubits supercondutores e criptografia p&oacute;s-qu&acirc;ntica.">
      </head>
      <body>
        <a href="https://pesquisa.exemplo.org/artigo?utm_campaign=teste">Artigo</a>
      </body>
    </html>
  `;
  const extracted = nativeCore.extractPageMetadataAndLinks('https://ciencia.exemplo.com.br/quantica', sampleHtml);
  assert.equal(extracted.title, 'Computação Quântica no Brasil — Portal Ciência');
  assert.ok(extracted.description.includes('Avanços brasileiros em qubits'));
  assert.ok(extracted.links.includes('https://pesquisa.exemplo.org/artigo'));

  // 3. Pesquisa no índice próprio BM25 em Rust (sem depender de buscador externo)
  const hits = nativeCore.searchLocalIndex('computacao quantica qubits brasil', 5, false);
  assert.ok(hits.length >= 1, 'Índice BM25 em Rust deve encontrar o documento recém-indexado');
  assert.equal(hits[0].url, 'https://ciencia.exemplo.com.br/quantica');
  assert.equal(hits[0].source, 'rust-index');

  // 4. Reconhecimento nativo em Rust dos sistemas operacionais (iOS, Windows, Android, Linux)
  const ios = nativeCore.detectOsPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15', '');
  assert.equal(ios.osId || ios.os_id, 'ios');
  assert.equal(ios.downloadUrl || ios.download_url, '/download/app?os=ios');

  const android = nativeCore.detectOsPlatform('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/134.0.0.0 Mobile', '"Android"');
  assert.equal(android.osId || android.os_id, 'android');
  assert.equal(android.downloadUrl || android.download_url, '/download/app?os=android');

  const windows = nativeCore.detectOsPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0', '"Windows"');
  assert.equal(windows.osId || windows.os_id, 'windows');
  assert.equal(windows.downloadUrl || windows.download_url, '/download/app?os=windows');

  const linux = nativeCore.detectOsPlatform('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', '"Linux"');
  assert.equal(linux.osId || linux.os_id, 'linux');
  assert.equal(linux.downloadUrl || linux.download_url, '/download/app?os=linux');
});

test('createLruCache: respeita limite maxEntries, promove no get e expira por TTL', () => {
  const { createLruCache } = require('../main/lru-cache');
  const cache = createLruCache({ maxEntries: 2, ttlMs: 100 });
  const now = Date.now();

  cache.set('a', { t: now, v: 1 });
  cache.set('b', { t: now, v: 2 });
  // Acessar 'a' promove para mais recente; 'b' passa a ser o mais antigo
  assert.equal(cache.get('a').v, 1);
  cache.set('c', { t: now, v: 3 });

  assert.equal(cache.size, 2);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a').v, 1);
  assert.equal(cache.get('c').v, 3);

  // Testa expiração por TTL e pruneExpired usando timestamp futuro
  const future = now + 200;
  const pruned = cache.pruneExpired(future);
  assert.equal(pruned, 2);
  assert.equal(cache.size, 0);
});

test('search-utils: limpa fragmentos HTML vazados e pontua relevância corretamente', () => {
  const { sanitizeSearchText, scoreSearchRelevance } = require('../main/search-utils');

  const dirty = 'result-title" data-ved="abc"> Casa dos Contos &amp;quot;História&amp;quot;';
  const clean = sanitizeSearchText(dirty, (s) =>
    s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  );
  assert.equal(clean, 'Casa dos Contos "História"');

  const exact = scoreSearchRelevance(
    {
      title: 'Casa dos Contos - Ouro Preto',
      url: 'https://casadoscontos.mg.gov.br/',
      snippet: 'Museu e centro cultural Casa dos Contos'
    },
    'casadoscontos'
  );
  const offTopic = scoreSearchRelevance(
    {
      title: 'Receita de bolo de cenoura',
      url: 'https://culinaria.exemplo.com/bolo',
      snippet: 'Como fazer bolo simples'
    },
    'casadoscontos'
  );
  assert.ok(exact > offTopic, `Esperado exact (${exact}) > offTopic (${offTopic})`);
  assert.equal(offTopic, 0);

  const { computeAntiSpamPenalty } = require('../main/search-utils');
  const cleanOfficial = computeAntiSpamPenalty({
    title: 'G1 - Portal de Notícias da Globo',
    url: 'https://g1.globo.com/'
  });
  const punyPhishing = computeAntiSpamPenalty({
    title: 'BANCO OFICIAL ACESSO URGENTE',
    url: 'https://xn--bnco-8oa.seguro.login.verify.exemplo.com/acesso-conta-corrente-atualizacao-cadastral-obrigatoria-2026-urgente-agora-mesmo-clique-aqui'
  });
  const clickbaitFarm = computeAntiSpamPenalty({
    title: 'TOP 10 MELHORES CELULARES 2026 VOCÊ NÃO VAI ACREDITAR',
    url: 'https://a.b.c.d.spamfarm.com/artigo-top-10-melhores-celulares-para-comprar-barato-hoje-mesmo-em-2026'
  });
  assert.ok(cleanOfficial > 0, 'Site oficial limpo deve receber bônus');
  assert.ok(punyPhishing < -15, 'Domínio punycode/phishing deve ser fortemente penalizado');
  assert.ok(clickbaitFarm < -10, 'Fazenda SEO/clickbait deve ser penalizada');
});

test('compression: sendCompressed comprime com gzip/br e ignora payloads pequenos', async () => {
  const zlib = require('zlib');
  const { sendCompressed } = require('../main/compression');

  function runCompressed(reqHeaders, body) {
    return new Promise((resolve) => {
      const state = { statusCode: 0, headers: {}, body: null };
      const res = {
        writeHead(code, hdrs) {
          state.statusCode = code;
          state.headers = { ...hdrs };
        },
        end(buf) {
          state.body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
          resolve(state);
        },
      };
      sendCompressed({ headers: reqHeaders }, res, 200, { 'Content-Type': 'application/json' }, body);
    });
  }

  const bigPayload = JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => `resultado-${i}-papaleguas`) });

  // 1. Brotli quando suportado
  const brRes = await runCompressed({ 'accept-encoding': 'gzip, deflate, br' }, bigPayload);
  assert.equal(brRes.statusCode, 200);
  assert.equal(brRes.headers['Content-Encoding'], 'br');
  assert.equal(zlib.brotliDecompressSync(brRes.body).toString('utf8'), bigPayload);

  // 2. Gzip quando só gzip é aceito
  const gzRes = await runCompressed({ 'accept-encoding': 'gzip' }, bigPayload);
  assert.equal(gzRes.headers['Content-Encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gzRes.body).toString('utf8'), bigPayload);

  // 3. Payload abaixo de minBytes não é comprimido
  const smallRes = await runCompressed({ 'accept-encoding': 'br, gzip' }, 'ok');
  assert.equal(smallRes.headers['Content-Encoding'], undefined);
  assert.equal(smallRes.body.toString('utf8'), 'ok');
});

test('search-utils: suggestQueryCorrection corrige erro de digitação e ignora URLs', () => {
  const { suggestQueryCorrection } = require('../main/search-utils');
  assert.equal(
    suggestQueryCorrection('tecnolgia', ['tecnologia', 'esportes', 'receitas']),
    'tecnologia'
  );
  assert.equal(suggestQueryCorrection('https://g1.globo.com', ['globo.com']), '');
  assert.equal(suggestQueryCorrection('tecnologia', ['tecnologia']), '');
});

test('segurança & privacidade: Adblocker ligado por padrão e /proxy sem fallback direto', () => {
  const { getAdblockStatus } = require('../main/adblocker');
  const status = getAdblockStatus();
  assert.equal(status.enabled, true, 'Adblocker deve iniciar ativado por padrão');

  const root = path.resolve(__dirname, '..');
  const serverCode = fs.readFileSync(path.join(root, 'main', 'server.js'), 'utf8');
  assert.doesNotMatch(
    serverCode,
    /fetchUrlViaProxy\([^)]*,\s*true\s*\)/,
    'Não deve existir fallback direto (forceDirect = true) em fetchUrlViaProxy'
  );
});

test('search-engines: parseBingVideosHtml e parseDailymotionVideosJson extraem vídeos de vários sites', () => {
  const { parseBingVideosHtml, parseDailymotionVideosJson, spreadResultsByHost } = require('../main/search-engines');
  const safeHost = (u) => {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  };

  const sampleBingHtml = `
    <div vrhm="{&quot;purl&quot;:&quot;https://vimeo.com/123456&quot;,&quot;t&quot;:&quot;Documentário Oceano&quot;,&quot;du&quot;:&quot;05:12&quot;,&quot;thid&quot;:&quot;OVP.abc123&quot;,&quot;surl&quot;:&quot;vimeo.com&quot;}"></div>
    <div vrhm="{&quot;purl&quot;:&quot;https://www.youtube.com/watch?v=dQw4w9WgXcQ&quot;,&quot;t&quot;:&quot;Clipe Musical&quot;,&quot;du&quot;:&quot;03:33&quot;,&quot;turl&quot;:&quot;https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg&quot;}"></div>
  `;
  const bingVids = parseBingVideosHtml(sampleBingHtml, 'oceano', safeHost, 10);
  assert.equal(bingVids.length, 2);
  assert.equal(bingVids[0].source, 'vimeo.com');
  assert.equal(bingVids[0].isYoutube, false);
  assert.equal(bingVids[0].duration, '05:12');
  assert.equal(bingVids[1].isYoutube, true);
  assert.equal(bingVids[1].id, 'dQw4w9WgXcQ');

  const dmJson = JSON.stringify({
    list: [
      { id: 'x8abcde', title: 'Ciência Hoje', url: 'https://www.dailymotion.com/video/x8abcde', thumbnail_480_url: 'https://s2.dmcdn.net/v/1/x480', duration: 125, 'owner.screenname': 'Canal Ciência', views_total: 4200 }
    ]
  });
  const dmVids = parseDailymotionVideosJson(dmJson, 10);
  assert.equal(dmVids.length, 1);
  assert.equal(dmVids[0].source, 'dailymotion.com');
  assert.equal(dmVids[0].duration, '2:05');

  const spread = spreadResultsByHost([...bingVids, ...dmVids], safeHost, 1);
  assert.equal(spread.length, 3);

  const { filterAndRankTopicVideos } = require('../main/search-engines');
  const mixedCandidates = [
    { id: 'QCZjNqtnGmM', title: 'The Dark Age - Animator vs. Animation 14', channel: 'Alan Becker', url: 'https://www.youtube.com/watch?v=QCZjNqtnGmM', _origin: 'bing' },
    { id: 'Hkjp36hjzqo', title: '$1 vs $500,000,000 Futuristic Tech!', channel: 'Stokes Twins', url: 'https://www.youtube.com/watch?v=Hkjp36hjzqo', _origin: 'bing' },
    { id: '', title: 'ELECCIONES BRASIL | Cierran las casillas | ElPaís', channel: 'EL PAÍS', url: 'https://www.dailymotion.com/video/x8e5dtc', _origin: 'dailymotion' },
    { id: '8ET-Vk0Gn6g', title: 'DIRECTO | Diputación Permanente del Congreso | EL PAÍS', channel: 'EL PAÍS', url: 'https://www.youtube.com/watch?v=8ET-Vk0Gn6g', _origin: 'youtube' },
  ];
  const filteredElPais = filterAndRankTopicVideos(mixedCandidates, 'elpais');
  assert.equal(filteredElPais.length, 2, 'Deve descartar vídeos aleatórios em alta do Bing que não pertencem ao tema');
  assert.equal(filteredElPais[0].id, '8ET-Vk0Gn6g', 'Deve priorizar vídeo do YouTube do próprio tema no topo');

  const { encryptPplPayload, decryptPplPayload } = require('../main/ppl-crypto');
  const tok1 = encryptPplPayload({ u: 'https://example.com/img.jpg', clientId: 'c1' });
  const tok2 = encryptPplPayload({ u: 'https://example.com/img.jpg', clientId: 'c1' });
  assert.equal(tok1, tok2, 'Token PPL de imagem estática deve ser determinístico via FNV-1a para aproveitar cache HTTP');
  assert.deepEqual(decryptPplPayload(tok1), { u: 'https://example.com/img.jpg', clientId: 'c1' });

  const pplRuntime = require('../papaleguas-lang/runtime');
  const vsMod = pplRuntime.loadNativeModule('video_stream');
  const srMod = pplRuntime.loadNativeModule('search_rank');
  assert.equal(typeof vsMod.optimal_search_timeout_ms, 'function');
  assert.equal(typeof vsMod.optimal_thumb_width, 'function');
  assert.equal(typeof vsMod.optimal_ssr_card_limit, 'function');
  assert.equal(typeof vsMod.should_eager_load_card, 'function');
  assert.equal(typeof srMod.score_topic_video, 'function');
  assert.ok(Number(vsMod.optimal_search_timeout_ms(0, true)) <= 6000);
  assert.equal(Number(vsMod.optimal_ssr_card_limit(true)), 6);
  assert.equal(Boolean(vsMod.should_eager_load_card(0)), true);
  assert.equal(Boolean(vsMod.should_eager_load_card(3)), false);
});

test('abertura de links do proxy em nova aba: openInNewTab e auxclick definidos no server.js e preload', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, '../main/server.js'), 'utf8');
  const preloadCode = fs.readFileSync(path.join(__dirname, '../main/preload-webview.js'), 'utf8');
  const newtabCode = fs.readFileSync(path.join(__dirname, '../src/newtab.html'), 'utf8');

  // Verifica que openInNewTab está definido na página de busca do servidor
  assert.ok(serverCode.includes('function openInNewTab('), 'server.js deve definir openInNewTab');
  assert.ok(serverCode.includes('window.openInNewTab = openInNewTab'), 'server.js deve expor window.openInNewTab');
  assert.ok(serverCode.includes("type: 'open-new-tab'"), 'server.js deve disparar open-new-tab');
  assert.ok(serverCode.includes("addEventListener('auxclick'"), 'server.js deve tratar clique com o botão do meio (auxclick)');

  // Verifica que o script injetado do proxy propaga OPEN_NEW_TAB e papaleguas-open-tab
  assert.ok(serverCode.includes("window.postMessage({ type: 'OPEN_NEW_TAB'"), 'script do proxy deve notificar OPEN_NEW_TAB');
  assert.ok(serverCode.includes("'papaleguas-open-tab'"), 'script do proxy deve disparar evento papaleguas-open-tab');

  // Verifica que preload-webview trata URLs /proxy
  assert.ok(preloadCode.includes("href.startsWith('/proxy')"), 'preload-webview deve aceitar URLs relativas /proxy');
  assert.ok(preloadCode.includes('/proxy?url='), 'preload-webview deve extrair destino de rotas /proxy');

  // Verifica que newtab.html possui suporte a auxclick e cliques modificados
  assert.ok(newtabCode.includes("addEventListener('auxclick'"), 'newtab.html deve tratar auxclick');

  // Verifica que botão de assistir câmera IP abre em nova aba e não redireciona para home
  const rendererCode = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  assert.ok(rendererCode.includes('ipcam-live'), 'renderer.js deve conter ipcam-live nas rotas internas');
  assert.ok(serverCode.includes("btn.classList.contains('btn-open-ipcam')"), 'server.js deve tratar clique em btn-open-ipcam');
  assert.ok(serverCode.includes("openInNewTab(fullPlayerHref)"), 'btn-open-ipcam deve chamar openInNewTab diretamente');
  assert.ok(serverCode.includes('target="_blank"'), 'server.js deve possuir target="_blank" para links externos/câmeras');
});

test('alternância instantânea de categorias na busca (Todos, Vídeos, Imagens, Web Rust, PDF, Câmera IP, .onion)', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, '../main/server.js'), 'utf8');
  assert.ok(serverCode.includes('function selectSearchFilter('), 'server.js deve definir selectSearchFilter');
  assert.ok(serverCode.includes('async function switchResultsListMode('), 'server.js deve definir switchResultsListMode para troca dinâmica entre web, pdf e ipcam');
  assert.ok(serverCode.includes('async function loadOnionSectionDynamic('), 'server.js deve definir loadOnionSectionDynamic para carregar .onion sob demanda');
  assert.ok(serverCode.includes("e.target.closest('.search-pill[data-filter]')"), 'setupFilterPills deve interceptar cliques nos botões de filtro com data-filter');
  const pageHtmlStart = serverCode.indexOf('const pageHtml = `<!DOCTYPE html>');
  const pageHtmlEnd = serverCode.indexOf('</html>`;', pageHtmlStart);
  assert.ok(pageHtmlStart > 0 && pageHtmlEnd > pageHtmlStart, 'pageHtml deve existir em server.js');
  const pageHtmlSlice = serverCode.slice(pageHtmlStart, pageHtmlEnd);
  assert.doesNotMatch(
    pageHtmlSlice,
    /\/\^https\?:\\\/\\\//,
    'pageHtml não deve conter regex literal /^https?:\\/\\// sem escape de template literal (causa comentário // no navegador)'
  );
});

test('ipcam-search: busca por palavra-chave não cai em bynew genérico e filtra corretamente', () => {
  const { buildInsecamSearchPlan, parseInsecamCards } = require('../main/ipcam-search');

  const quartoPlan = buildInsecamSearchPlan('quarto', 0);
  assert.equal(quartoPlan.hasExplicitCategory, true);
  assert.ok(quartoPlan.urls.some((u) => u.includes('/bytag/House/')), 'quarto deve mapear para tag House');
  assert.ok(quartoPlan.urls.some((u) => u.includes('/bytag/Hotel/')), 'quarto deve incluir tag Hotel');
  assert.ok(!quartoPlan.urls.some((u) => u.includes('/bynew/')), 'quarto não deve usar /bynew/');

  const praiaBrasilPlan = buildInsecamSearchPlan('praia brasil', 0);
  assert.ok(praiaBrasilPlan.urls.some((u) => u.includes('/bytag/Beach/')), 'praia deve mapear para Beach');
  assert.ok(praiaBrasilPlan.urls.some((u) => u.includes('/bycountry/BR/')), 'brasil deve mapear para BR');

  const unknownPlan = buildInsecamSearchPlan('palavra_aleatoria_xyz', 0);
  assert.equal(unknownPlan.isGenericCamQuery, false);
  assert.ok(!unknownPlan.urls.some((u) => u.includes('/bynew/')), 'termo específico desconhecido não deve incluir /bynew/ diretamente');

  const genericPlan = buildInsecamSearchPlan('camera', 0);
  assert.equal(genericPlan.isGenericCamQuery, true);
  assert.ok(genericPlan.urls.some((u) => u.includes('/bynew/')), 'busca genérica deve usar /bynew/');

  const sampleHtml = `
    <a class="thumbnail-item__wrap" href="/en/view/1012199/" title="Live camera in Brazil, Nova Granada">
      <img src="http://187.103.87.253:3000/mjpg/video.mjpg" />
    </a>
    <a class="thumbnail-item__wrap" href="/en/view/1012198/" title="Live camera in Brazil, Marilia">
      <img src="http://189.90.106.231:8085/mjpg/video.mjpg" />
    </a>
  `;
  const filtered = parseInsecamCards([sampleHtml], 10, ['marilia']);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].host, '189.90.106.231:8085');
});

test('voltar preserva página em cache e posição de rolagem sem recarregar', () => {
  const rendererCode = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const serverCode = fs.readFileSync(path.join(__dirname, '../main/server.js'), 'utf8');

  assert.ok(rendererCode.includes('const VIEW_CACHE_DISTANCE = 4;'), 'VIEW_CACHE_DISTANCE deve manter múltiplas views em cache');
  assert.ok(rendererCode.includes('const FRAME_CACHE_DISTANCE = 5;'), 'FRAME_CACHE_DISTANCE deve manter múltiplos iframes em cache');
  assert.ok(rendererCode.includes('webview.goToCachedUrl ='), 'webview deve expor goToCachedUrl para restaurar sem recarregar');
  assert.ok(rendererCode.includes('__plInFrameSteps'), 'navegação interna em iframe deve usar histórico nativo (bfcache)');
  assert.ok(rendererCode.includes('saveFrameScroll') && rendererCode.includes('restoreFrameScroll'), 'showFrame deve salvar e restaurar rolagem');
  assert.ok(rendererCode.includes("data.type === 'papaleguas-go-back'"), 'renderer deve tratar papaleguas-go-back');
  assert.ok(rendererCode.includes('saveViewScroll') && rendererCode.includes('restoreViewScroll'), 'showView (Electron) deve salvar e restaurar rolagem');
  assert.ok(serverCode.includes("postMessage({ type: 'papaleguas-go-back' }") || fs.readFileSync(path.join(__dirname, '../main/routes/ipcam-live.js'), 'utf8').includes("postMessage({ type: 'papaleguas-go-back' }"), 'botões Voltar de /video-watch e /ipcam-live devem acionar histórico da aba pai');
});

test('routes/ipcam-live.js e AbortController em ipcam-search.js', () => {
  const { buildIpCamLiveHtml } = require('../main/routes/ipcam-live');
  const html = buildIpCamLiveHtml({
    camUrl: 'http://189.90.106.231:8085/mjpg/video.mjpg',
    camTitle: 'Marilia Cam',
    clientId: 'cli_1',
    escapeHtml: (s) => String(s).replace(/</g, '&lt;')
  });
  assert.ok(html.includes('Marilia Cam') && html.includes('/api/ipcam-frame') && html.includes('papaleguas-go-back'));

  const ipcamSearchCode = fs.readFileSync(path.join(__dirname, '../main/ipcam-search.js'), 'utf8');
  assert.ok(ipcamSearchCode.includes('AbortController'), 'ipcam-search.js deve abortar sockets pendentes via AbortController');
});
