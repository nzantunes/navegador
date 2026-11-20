'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { checkSource, compileSource } = require('../papaleguas-lang/compiler');
const { invokeNative, loadNativeModule } = require('../papaleguas-lang/runtime');
const { runCycle } = require('../bin/papaleguas-agent');
const { createLruCache, applyHardwareTunerToCaches } = require('../main/lru-cache');
const { scoreSearchRelevance, computeAntiSpamPenalty } = require('../main/search-utils');

test('Papaléguas Lang: verificador estático rejeita código inseguro, divisão por zero e loop sem política', () => {
  assert.throws(() => {
    checkSource(`
      export fn bad() -> u64 {
        return system("ls");
      }
    `);
  }, /proibida pela política Papaléguas/);

  assert.throws(() => {
    checkSource(`
      export fn div_zero() -> u64 {
        return 10 / 0;
      }
    `);
  }, /Divisão ou módulo por zero/);

  assert.throws(() => {
    checkSource(`
      export fn mismatch() -> u64 {
        let x: u64 = true;
        return x;
      }
    `);
  }, /espera 'u64', recebeu 'bool'/);
});

test('Papaléguas Lang: compila para binário nativo de hardware e executa intrínsecas e lógica', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-test-'));
  try {
    const src = `
      @policy(max_loops=500, no_network=true)
      export fn sum_to(n: u64) -> u64 {
        let total: u64 = 0;
        for i in 1..n {
          total = total + i;
        }
        return total;
      }
      export fn cores() -> u64 {
        return hw.cpu_cores();
      }
    `;
    const meta = compileSource(src, { outDir: tmpDir, name: 'math_hw' });
    assert.ok(fs.existsSync(meta.binPath), 'binário nativo deve ser gerado');

    const sumRes = invokeNative('math_hw', 'sum_to', [5], { activeDir: tmpDir, modulesDir: tmpDir });
    assert.equal(sumRes, 10);

    const coresRes = invokeNative('math_hw', 'cores', [], { activeDir: tmpDir, modulesDir: tmpDir });
    assert.ok(coresRes >= 1, 'cpu_cores() deve retornar >= 1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Agente Independente Papaléguas: verifica, compila em sandbox, testa e promove módulos .ppl', () => {
  const report = runCycle();
  assert.equal(report.agent, 'Papaléguas Independent Agent');
  assert.ok(report.modulesCount >= 2, 'deve processar hw_probe e shield_guard');

  for (const r of report.results) {
    assert.ok(r.status === 'compiled_and_promoted' || r.status === 'up_to_date', `módulo ${r.module} falhou: ${r.error}`);
  }

  const cores = invokeNative('hw_probe', 'cpu_cores');
  const ramTotal = invokeNative('hw_probe', 'ram_total_mb');
  assert.ok(cores >= 1);
  assert.ok(ramTotal > 0);

  const localScore = invokeNative('shield_guard', 'score_request', [500, 50, true, false]);
  assert.equal(localScore, 0);

  const blocked = invokeNative('shield_guard', 'should_block', [180, 25, false, false]);
  assert.equal(blocked, true);

  const fp1 = invokeNative('shield_guard', 'fingerprint_fnv1a', ['papaleguas-tor']);
  const fp2 = invokeNative('shield_guard', 'fingerprint_fnv1a', ['papaleguas-tor']);
  assert.equal(fp1, fp2);
  assert.ok(fp1 > 0);

  // Valida execução in-process via N-API (.ppl.node) sem spawn de subprocesso
  const hwAddon = loadNativeModule('hw_probe');
  const shieldAddon = loadNativeModule('shield_guard');
  const urlAddon = loadNativeModule('url_filter');
  assert.ok(hwAddon && typeof hwAddon.cpu_cores === 'function', 'hw_probe.ppl.node deve carregar in-process');
  assert.ok(shieldAddon && typeof shieldAddon.score_request === 'function', 'shield_guard.ppl.node deve carregar in-process');
  assert.ok(urlAddon && typeof urlAddon.is_blocked_tracker === 'function', 'url_filter.ppl.node deve carregar in-process');
  assert.equal(hwAddon.cpu_cores(), cores);
  assert.equal(shieldAddon.should_block(180, 25, false, false), true);
  assert.equal(urlAddon.is_blocked_tracker('https://doubleclick.net/pixel.js'), true);
  assert.equal(urlAddon.is_blocked_tracker('https://papaleguas.app/search?q=tor'), false);
  assert.equal(urlAddon.is_unsafe_scheme('javascript:alert(1)'), true);
  assert.equal(urlAddon.is_unsafe_scheme('https://papaleguas.app'), false);
});

test('Papaléguas Lang: suporta arrays seguros com checagem estática de limites e structs', () => {
  assert.throws(() => {
    checkSource(`
      export fn oob() -> u64 {
        let arr: [3]u64 = [10, 20, 30];
        return arr[5];
      }
    `);
  }, /fora dos limites/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-struct-'));
  try {
    const src = `
      @policy(max_loops=100, no_network=true)
      struct Metrics {
        weight: u64,
        bonus: u64
      }

      export fn compute_score(idx: u64) -> u64 {
        let weights: [4]u64 = [10, 25, 50, 100];
        weights[0] = 15;
        let m: Metrics = Metrics { weight: weights[idx], bonus: 7 };
        m.bonus = m.bonus + 3;
        return m.weight + m.bonus;
      }
    `;
    const meta = compileSource(src, { outDir: tmpDir, name: 'struct_arr' });
    assert.ok(fs.existsSync(meta.napiPath));
    const mod = loadNativeModule('struct_arr', { activeDir: tmpDir, modulesDir: tmpDir });
    assert.equal(mod.compute_score(0), 25); // 15 + 10
    assert.equal(mod.compute_score(2), 60); // 50 + 10
    assert.equal(mod.compute_score(99), 10); // bounds-safe runtime fallback -> 0 + 10
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Papaléguas Lang Fase 6: search_rank, search_index, auto_tuner e LRU hardware tuner', () => {
  const report = runCycle();
  for (const r of report.results) {
    assert.ok(r.status === 'compiled_and_promoted' || r.status === 'up_to_date', `módulo ${r.module} falhou: ${r.error}`);
  }

  const rankMod = loadNativeModule('search_rank');
  const indexMod = loadNativeModule('search_index');
  const tunerMod = loadNativeModule('auto_tuner');
  assert.ok(rankMod && typeof rankMod.score_relevance_signals === 'function');
  assert.ok(indexMod && typeof indexMod.batch_slot_score === 'function');
  assert.ok(tunerMod && typeof tunerMod.recommended_cache_limit === 'function');

  assert.equal(rankMod.score_relevance_signals(true, true, false, 2, 1, 1), 31); // 10+8+0 + 8+3+2
  assert.equal(rankMod.compute_tier_bonus(0), 20);

  const rel = scoreSearchRelevance(
    { title: 'Papaleguas Navegador', url: 'https://papaleguas.app/', snippet: 'Busca privada e rapida' },
    'papaleguas'
  );
  assert.ok(rel >= 18);
  const cleanAdj = computeAntiSpamPenalty({ url: 'https://papaleguas.app/' });
  assert.equal(cleanAdj, 4);

  const h1 = indexMod.url_hash_fnv1a('https://papaleguas.app');
  const h2 = indexMod.url_hash_fnv1a('https://papaleguas.app');
  assert.equal(h1, h2);
  assert.ok(indexMod.url_bucket('https://papaleguas.app', 8) < 8);
  assert.ok(indexMod.batch_slot_score('https://papaleguas.app', 10, 12) >= 41);

  assert.equal(tunerMod.should_shed_load(90), true);
  assert.equal(tunerMod.should_shed_load(30), false);

  const c = createLruCache({ maxEntries: 20 });
  for (let i = 0; i < 20; i++) c.set('k' + i, i);
  assert.equal(c.size, 20);
  const tuneRes = applyHardwareTunerToCaches(2000, true);
  assert.ok(tuneRes.cachesCount >= 1);
  assert.equal(c.size, 10);

  // Valida que todos os 6 módulos oficiais carregam in-process via .ppl.node
  for (const modName of ['hw_probe', 'shield_guard', 'url_filter', 'auto_tuner', 'search_rank', 'search_index']) {
    const m = loadNativeModule(modName);
    assert.ok(m && Object.keys(m).length > 0, `módulo ${modName}.ppl.node deve exportar funções nativas`);
  }
});

test('Papaléguas Lang Nativo (Zero Node.js): servidor HTTP papaleguas_httpd.pplbin atende requisições TCP reais', async () => {
  assert.throws(() => {
    checkSource(`
      @policy(no_network=true)
      export fn unauthorized_net() -> i64 {
        return net.listen(9999);
      }
    `);
  }, /exige @policy\(allow_network=true\)/);

  const report = runCycle();
  const httpdRes = report.results.find((r) => r.module === 'papaleguas_httpd');
  assert.ok(httpdRes && (httpdRes.status === 'compiled_and_promoted' || httpdRes.status === 'up_to_date'), 'papaleguas_httpd.ppl deve compilar e promover');

  const { spawn } = require('node:child_process');
  const http = require('node:http');
  const binPath = path.join(__dirname, '..', 'papaleguas-lang', 'active', 'papaleguas_httpd.pplbin');
  const testPort = 18943;

  const child = spawn(binPath, ['serve_once', String(testPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 150));

  const body = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${testPort}/health`, (res) => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-powered-by'], 'Papaleguas-Native-PPL');
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });

  const parsed = JSON.parse(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.engine, 'Papaleguas-Native-PPL');
  assert.ok(parsed.cpuCores >= 1);
  assert.ok(parsed.ramTotalMb > 0);
  child.kill();
});

test('Papaléguas Lang: fs.read_safe exige política e compila .ppl para WebAssembly (.wasm)', async () => {
  assert.throws(() => {
    checkSource(`
      @policy(no_network=true)
      export fn bad_fs() -> str {
        return fs.read_safe("src", "manifest.json");
      }
    `);
  }, /exige @policy\(allow_fs=true\)/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-wasm-'));
  try {
    const src = `
      @policy(max_loops=200, no_network=true)
      export fn fib_sum(n: u64) -> u64 {
        let total: u64 = 0;
        for i in 1..n {
          total = total + i;
        }
        return total;
      }
    `;
    const meta = compileSource(src, { outDir: tmpDir, name: 'wasm_math' });
    assert.ok(meta.wasmPath && fs.existsSync(meta.wasmPath), 'arquivo .ppl.wasm deve ser gerado');
    const wasmBytes = fs.readFileSync(meta.wasmPath);
    const { instance } = await WebAssembly.instantiate(wasmBytes);
    assert.equal(instance.exports.fib_sum(6n), 15n);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Papaléguas Lang Fase 8: streaming estático (>64KB) em papaleguas_httpd.pplbin e client_guard.ppl.wasm', async () => {
  assert.throws(() => {
    checkSource(`
      @policy(allow_network=true)
      export fn bad_static(fd: i64) -> bool {
        return net.serve_static(fd, "src", "/styles.css");
      }
    `);
  }, /exige @policy\(allow_fs=true\)/);

  const report = runCycle();
  const clientRes = report.results.find((r) => r.module === 'client_guard');
  assert.ok(clientRes && (clientRes.status === 'compiled_and_promoted' || clientRes.status === 'up_to_date'));

  const wasmPath = path.join(__dirname, '..', 'papaleguas-lang', 'active', 'client_guard.ppl.wasm');
  assert.ok(fs.existsSync(wasmPath), 'client_guard.ppl.wasm deve existir em active/');
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath));
  assert.equal(instance.exports.sanitize_zoom_pct(10n), 50n);
  assert.equal(instance.exports.sanitize_zoom_pct(500n), 250n);
  assert.equal(instance.exports.score_client_nav(true, false, 1n), 90n);
  assert.equal(instance.exports.score_client_nav(false, false, 0n), 75n);

  // Testa streaming de styles.css (> 64KB) e bloqueio de path traversal no papaleguas_httpd.pplbin
  const { spawn } = require('node:child_process');
  const http = require('node:http');
  const binPath = path.join(__dirname, '..', 'papaleguas-lang', 'active', 'papaleguas_httpd.pplbin');
  const port = 18944;

  const child1 = spawn(binPath, ['serve_once', String(port)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const cssRes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/styles.css`, (res) => {
      let len = 0;
      res.on('data', (c) => { len += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, ctype: res.headers['content-type'], len }));
    }).on('error', reject);
  });
  child1.kill();
  assert.equal(cssRes.status, 200);
  assert.equal(cssRes.ctype, 'text/css; charset=utf-8');
  assert.ok(cssRes.len > 65536, `styles.css (${cssRes.len} bytes) deve ser entregue completo > 64KB`);

  const child2 = spawn(binPath, ['serve_once', String(port)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const travStatus = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/../package.json`, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  child2.kill();
  assert.equal(travStatus, 404, 'path traversal ../package.json deve ser bloqueado');
});

test('Papaléguas Lang Fase 9: cliente HTTP nativo net.http_get e método HEAD em .pplbin', async () => {
  assert.throws(() => {
    checkSource(`
      @policy(no_network=true)
      export fn bad_client() -> str {
        return net.http_get("127.0.0.1", 8081, "/health");
      }
    `);
  }, /exige @policy\(allow_network=true\)/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-httpclient-'));
  const { spawn } = require('node:child_process');
  const binPath = path.join(__dirname, '..', 'papaleguas-lang', 'active', 'papaleguas_httpd.pplbin');
  const port = 18945;
  const srv = spawn(binPath, ['serve_once', String(port)], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 150));
    const clientSrc = `
      @policy(allow_network=true, max_loops=100)
      const HTTP_CLIENT_V: u64 = 1;
      export fn fetch_local(p: u64) -> str {
        return net.http_get("127.0.0.1", p, "/health");
      }
    `;
    compileSource(clientSrc, { outDir: tmpDir, name: 'ppl_client', wasm: false });
    const body = invokeNative('ppl_client', 'fetch_local', [port], { activeDir: tmpDir, modulesDir: tmpDir });
    const parsed = JSON.parse(body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.engine, 'Papaleguas-Native-PPL');
  } finally {
    srv.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Papaléguas Lang Fase 10: net.req_query (/api/native-hash) e watchdog_probe.ppl.node', async () => {
  const report = runCycle();
  const wp = report.results.find((r) => r.module === 'watchdog_probe');
  assert.ok(wp && (wp.status === 'compiled_and_promoted' || wp.status === 'up_to_date'));

  const { spawn } = require('node:child_process');
  const http = require('node:http');
  const binPath = path.join(__dirname, '..', 'papaleguas-lang', 'active', 'papaleguas_httpd.pplbin');
  const port = 18946;

  const srv1 = spawn(binPath, ['serve_once', String(port)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const hashJson = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/native-hash?url=https%3A%2F%2Fpapaleguas.app`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  srv1.kill();
  assert.equal(hashJson.ok, true);
  assert.equal(hashJson.engine, 'Papaleguas-Native-PPL');
  assert.ok(String(hashJson.hash).length > 5);

  const srv2 = spawn(binPath, ['serve_once', String(port)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const probeMod = loadNativeModule('watchdog_probe');
  assert.equal(probeMod.probe_native_httpd(port), true);
  srv2.kill();
});

test('Electron para PPL: url_filter.ppl.node filtra adblock, Spotify e popups inseguros para main.js/adblocker.js', () => {
  const urlFilter = loadNativeModule('url_filter');
  assert.equal(urlFilter.is_spotify_restricted_url('https://open.spotify.com/account'), true);
  assert.equal(urlFilter.is_spotify_restricted_url('https://open.spotify.com/track/123'), false);
  assert.equal(urlFilter.is_ad_domain_or_keyword('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'), true);
  assert.equal(urlFilter.is_ad_domain_or_keyword('https://papaleguas.app/styles.css'), false);
  assert.equal(urlFilter.should_allow_popup_url('javascript:alert(1)'), false);
  assert.equal(urlFilter.should_allow_popup_url('https://doubleclick.net/pixel'), false);
  assert.equal(urlFilter.should_allow_popup_url('https://papaleguas.app/watch'), true);

  const adblocker = require('../main/adblocker');
  assert.equal(adblocker.getAdblockStatus().pplActive, true);
});

test('Papaléguas Lang Fase 12: net.proxy_pass exige política e encaminha requisições TCP/HTTP para upstream', async () => {
  assert.throws(() => {
    checkSource(`
      @policy(no_network=true)
      export fn bad_proxy(fd: i64, raw: str) -> bool {
        return net.proxy_pass(fd, "127.0.0.1", 8080, raw);
      }
    `);
  }, /exige @policy\(allow_network=true\)/);

  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-proxy-'));
  let upstream = null;
  try {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Upstream': 'node-worker' });
      res.end(JSON.stringify({ ok: true, proxiedPath: req.url }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upPort = upstream.address().port;

    const src = `
      @policy(allow_network=true)
      export fn gw_once(listen_port: u64) -> u64 {
        let srv: i64 = net.listen(listen_port);
        if srv < 0 { return 0; }
        let cli: i64 = net.accept(srv);
        if cli >= 0 {
          let raw: str = net.read_req(cli);
          if not net.proxy_pass(cli, "127.0.0.1", ${upPort}, raw) {
            net.send_http(cli, 502, "text/plain", "bad_gateway");
          }
          net.close(cli);
        }
        net.close(srv);
        return 1;
      }
    `;
    const meta = compileSource(src, { outDir: tmpDir, name: 'ppl_gateway' });
    const gwPort = 18947;
    const gw = spawn(meta.binPath, ['gw_once', String(gwPort)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));

    const resData = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${gwPort}/api/test-proxy?x=1`, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, hdr: res.headers['x-upstream'], body: JSON.parse(body) }));
      }).on('error', reject);
    });
    gw.kill();
    assert.equal(resData.status, 200);
    assert.equal(resData.hdr, 'node-worker');
    assert.equal(resData.body.ok, true);
    assert.equal(resData.body.proxiedPath, '/api/test-proxy?x=1');
  } finally {
    if (upstream) await new Promise((r) => upstream.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Hot-path PPL: shield_guard.is_private_ip valida IPs privados/CGNAT/loopback em C nativo', () => {
  const shield = loadNativeModule('shield_guard');
  assert.equal(shield.is_private_ip('127.0.0.1'), true);
  assert.equal(shield.is_private_ip('10.0.0.5'), true);
  assert.equal(shield.is_private_ip('172.16.0.1'), true);
  assert.equal(shield.is_private_ip('172.31.255.1'), true);
  assert.equal(shield.is_private_ip('172.32.0.1'), false);
  assert.equal(shield.is_private_ip('192.168.1.50'), true);
  assert.equal(shield.is_private_ip('100.64.0.1'), true);
  assert.equal(shield.is_private_ip('100.128.0.1'), false);
  assert.equal(shield.is_private_ip('fe80::1'), true);
  assert.equal(shield.is_private_ip('8.8.8.8'), false);
  assert.equal(shield.rate_allow(10, 5, 500, 1000, 15), true);
  assert.equal(shield.rate_allow(10, 10, 500, 1000, 15), false);

  const searchRank = loadNativeModule('search_rank');
  assert.equal(searchRank.levenshtein_dist('papaleguas', 'papaleguaz'), 1);
  assert.equal(searchRank.score_title_signals('ASSISTA AGORA GRATIS INCRIVEL'), -5);
  assert.equal(searchRank.sanitize_text('class="x"> <b>Papaleguas</b>   Search  '), 'Papaleguas Search');
});

test('Papaléguas Lang Fase 13: net.tor_fetch exige política e executa handshake SOCKS5h + HTTP via tor_proxy.ppl.node', async () => {
  assert.throws(() => {
    checkSource(`
      @policy(no_network=true)
      export fn bad_tor(h: str) -> str {
        return net.tor_fetch("127.0.0.1", 9050, h, 80, "/", false);
      }
    `);
  }, /exige @policy\(allow_network=true\)/);

  const net = require('node:net');
  const http = require('node:http');
  let upstream = null;
  let socksSrv = null;
  let seenDomain = '';
  let seenPort = 0;

  try {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('TOR_OK:' + req.url);
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    socksSrv = net.createServer((cli) => {
      let stage = 0;
      let upSock = null;
      cli.on('data', (chunk) => {
        if (stage === 0) {
          stage = 1;
          cli.write(Buffer.from([0x05, 0x00]));
        } else if (stage === 1) {
          const atyp = chunk[3];
          if (atyp === 0x03) {
            const hlen = chunk[4];
            seenDomain = chunk.slice(5, 5 + hlen).toString('utf8');
            seenPort = chunk.readUInt16BE(5 + hlen);
          }
          stage = 2;
          upSock = net.connect(upPort, '127.0.0.1', () => {
            cli.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          });
          upSock.on('data', (d) => cli.write(d));
          upSock.on('end', () => cli.end());
          upSock.on('error', () => cli.destroy());
        } else if (upSock) {
          upSock.write(chunk);
        }
      });
      cli.on('close', () => { if (upSock) upSock.destroy(); });
    });
    await new Promise((r) => socksSrv.listen(0, '127.0.0.1', r));
    const socksPort = socksSrv.address().port;

    const { execFile } = require('node:child_process');
    const torBin = path.join(__dirname, '..', 'papaleguas-lang', 'active', 'tor_proxy.pplbin');
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        torBin,
        ['socks5_get', '127.0.0.1', String(socksPort), 'papaleguas.onion', String(upPort), '/tor-check', '0'],
        { encoding: 'utf8', timeout: 5000 },
        (err, out) => (err ? reject(err) : resolve(String(out || '').trim()))
      );
    });
    assert.equal(seenDomain, 'papaleguas.onion');
    assert.equal(seenPort, upPort);
    assert.equal(JSON.parse(stdout).result, 'TOR_OK:/tor-check');

    const urlFilter = loadNativeModule('url_filter');
    assert.equal(urlFilter.detect_os('mozilla/5.0 (x11; linux x86_64)', ''), 'linux');
    assert.equal(urlFilter.detect_os('mozilla/5.0 (iphone; cpu iphone os 17_0)', ''), 'ios');
    const nativeCore = require('../main/native-core');
    assert.equal(nativeCore.isSafeProxyHost('169.254.169.254'), false);
    assert.equal(nativeCore.isSafeProxyHost('8.8.8.8'), true);
    assert.equal(nativeCore.detectOsPlatform('Mozilla/5.0 (Linux; Android 14)').osId, 'android');
  } finally {
    if (socksSrv) await new Promise((r) => socksSrv.close(r));
    if (upstream) await new Promise((r) => upstream.close(r));
  }
});

test('Motor PPL Buscador: fold_text, normalizeSearchTokens e batch_slot_score integrados', () => {
  const rankMod = loadNativeModule('search_rank');
  assert.ok(rankMod && typeof rankMod.fold_text === 'function', 'search_rank.fold_text deve existir');
  assert.equal(rankMod.fold_text('Ação, Programação & Café NAÇÃO'), 'acao, programacao & cafe nacao');

  const idxMod = loadNativeModule('search_index');
  assert.ok(idxMod && typeof idxMod.batch_slot_score === 'function', 'search_index.batch_slot_score deve existir');
  const freshPopular = Number(idxMod.batch_slot_score('https://exemplo.com.br/artigo', 50, 1));
  const staleCold = Number(idxMod.batch_slot_score('https://exemplo.com.br/antigo', 0, 500));
  assert.ok(freshPopular > staleCold, 'URL recente e popular deve ter batch_slot_score maior');

  const searchUtils = require('../main/search-utils');
  assert.equal(searchUtils.foldSearchText('São Paulo — Coração'), 'sao paulo — coracao');
  assert.deepEqual(searchUtils.normalizeSearchTokens('Programação em C++ e Café'), ['programacao', 'cafe']);
  const boost = searchUtils.computePplBatchBoost({ url: 'https://papaleguas.app/docs', clicks: 40, freshnessHours: 2 });
  assert.ok(boost >= 1 && boost <= 10, `boost PPL esperado entre 1 e 10, obtido: ${boost}`);
});

test('papaleguas_httpd.pplbin: /api/status e escudo anti-scanner em C nativo', async () => {
  const { spawn } = require('node:child_process');
  const http = require('node:http');
  const binPath = path.join(__dirname, '..', 'papaleguas-lang', 'active', 'papaleguas_httpd.pplbin');
  const port = 18949;
  const getPath = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });

  const c1 = spawn(binPath, ['serve_once', String(port)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const statusRes = await getPath('/api/status');
  c1.kill();
  assert.equal(statusRes.status, 200);
  const statusJson = JSON.parse(statusRes.body);
  assert.equal(statusJson.ok, true);
  assert.equal(statusJson.engine, 'Papaleguas-Native-PPL');

  const c2 = spawn(binPath, ['serve_once', String(port + 1)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const shieldRes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port + 1}/.env`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
  c2.kill();
  assert.equal(shieldRes.status, 404);
  assert.equal(JSON.parse(shieldRes.body).shield, 'papaleguas-ppl');

  const c3 = spawn(binPath, ['serve_once', String(port + 2)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const unsafeRes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port + 2}/api/url-check?u=javascript:alert(1)`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
  c3.kill();
  assert.equal(unsafeRes.status, 200);
  assert.equal(JSON.parse(unsafeRes.body).safe, false);

  const c4 = spawn(binPath, ['serve_once', String(port + 3)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const traceRes = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: port + 3, path: '/', method: 'TRACE' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
  c4.kill();
  assert.equal(traceRes.status, 405);

  const c5 = spawn(binPath, ['serve_once', String(port + 4)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const metricsRes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port + 4}/api/ppl-metrics`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
  c5.kill();
  assert.equal(metricsRes.status, 200);
  const mj = JSON.parse(metricsRes.body);
  assert.equal(mj.ok, true);
  assert.equal(typeof mj.hitsNative, 'number');
  assert.equal(typeof mj.hitsProxy, 'number');
});

test('tor_proxy.tor_alive e net.tor_alive validam SOCKS5 nativo em C', async () => {
  const net = require('node:net');
  const torMod = loadNativeModule('tor_proxy');
  assert.ok(torMod && typeof torMod.tor_alive === 'function');
  assert.equal(typeof torMod.tor_alive(), 'boolean');

  const srv = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write(Buffer.from([0x05, 0x00]));
      sock.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const okPort = srv.address().port;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-toralive-'));
  try {
    const src = `
      @policy(allow_network=true, zero_traces=true)
      export fn check_port(p: u64) -> bool {
        return net.tor_alive("127.0.0.1", p);
      }
    `;
    const meta = compileSource(src, { outDir: tmpDir, name: 'tor_alive_test' });
    const { execFile } = require('node:child_process');
    const runBin = (p) => new Promise((resolve, reject) => {
      execFile(meta.binPath, ['check_port', String(p)], { encoding: 'utf8', timeout: 4000 }, (err, out) => (err ? reject(err) : resolve(JSON.parse(String(out || '').trim()).result)));
    });
    assert.equal(await runBin(okPort), true);
    assert.equal(await runBin(okPort + 9), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await new Promise((r) => srv.close(r));
  }
});

test('Papaléguas Lang: break/continue, atribuição composta (+=,-=,*=,/=,%=), hex/binário e operadores bitwise', async () => {
  // 1. Verificador deve rejeitar break/continue fora de loop e bitwise em f64
  assert.throws(
    () => checkSource('export fn bad_break() -> u64 { break; return 0; }'),
    /dentro de um loop/i
  );
  assert.throws(
    () => checkSource('export fn bad_continue() -> u64 { continue; return 0; }'),
    /dentro de um loop/i
  );
  assert.throws(
    () => checkSource('export fn bad_bit(a: f64, b: u64) -> u64 { return a & b; }'),
    /bitwise/i
  );

  // 2. Compila e executa nativo + WASM com todas as novas construções
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-lang-ext-'));
  try {
    const src = `
      const UNUSED_CONST_CHECK: u64 = 42;
      struct Acc { total: u64, mask: u64 }

      @policy(max_loops=100)
      export fn loop_sum(limit: u64) -> u64 {
        let sum: u64 = 0;
        for i in 0..20 {
          if (i % 2) == 0 {
            continue;
          }
          if i > limit {
            break;
          }
          sum += i;
        }
        return sum;
      }

      @policy(max_loops=100)
      export fn bitwise_and_compound(x: u64) -> u64 {
        let a: u64 = 0x00_FF;
        let b: u64 = 0b1010_0101;
        let c: u64 = (a & b) | (1 << 8);
        c ^= 0x0F;
        c -= 1;
        c *= 2;
        c /= 2;
        return (c >> 1) + (x & (~0 & 0xFF));
      }

      export fn struct_and_array_compound() -> u64 {
        let acc = Acc { total: 10, mask: 0x0F };
        acc.total += 15;
        acc.total -= 5;
        let arr: [3]u64 = [2, 4, 6];
        arr[1] *= 3;
        arr[2] %= 4;
        return acc.total + arr[1] + arr[2];
      }
    `;
    const meta = compileSource(src, { outDir: tmpDir, name: 'lang_ext_test' });
    // loop_sum(7): 1 + 3 + 5 + 7 = 16
    assert.equal(invokeNative('lang_ext_test', 'loop_sum', [7], { activeDir: tmpDir, modulesDir: tmpDir }), 16);
    // bitwise_and_compound(0x12):
    // a=255, b=165 -> a&b=165 (0xA5), |256 = 421 (0x1A5), ^15 = 426 (0x1AA), -1=425, *2/2=425, >>1 = 212, + (0x12 & 0xFF = 18) = 230
    assert.equal(invokeNative('lang_ext_test', 'bitwise_and_compound', [0x12], { activeDir: tmpDir, modulesDir: tmpDir }), 230);
    // struct_and_array_compound(): acc.total=20, arr[1]=12, arr[2]=2 => 34
    assert.equal(invokeNative('lang_ext_test', 'struct_and_array_compound', [], { activeDir: tmpDir, modulesDir: tmpDir }), 34);

    if (meta.wasmPath && fs.existsSync(meta.wasmPath)) {
      const wasmBytes = fs.readFileSync(meta.wasmPath);
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      assert.equal(Number(instance.exports.loop_sum(7n)), 16);
      assert.equal(Number(instance.exports.bitwise_and_compound(0x12n)), 230);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Papaléguas Lang: análise de retorno obrigatório e novos builtins (str.ends_with, str.to_lower, str.index_of, abs_i64, clamp_i64)', async () => {
  assert.throws(
    () => checkSource('export fn missing_ret(x: u64) -> u64 { if x > 1 { return 1; } }'),
    /nem sempre retorna um valor/i
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-builtins-'));
  try {
    const src = `
      export fn check_str(s: str) -> bool {
        let low: str = str.to_lower(s);
        return str.ends_with(low, ".ppl") and str.index_of(low, "lang") >= 0;
      }

      export fn check_math(x: i64, v: u64) -> u64 {
        let a: u64 = abs_i64(x);
        let c: i64 = clamp_i64(x, -10, 10);
        let u: u64 = clamp_u64(v, 5, 50);
        return a + abs_i64(c) + u;
      }
    `;
    const meta = compileSource(src, { outDir: tmpDir, name: 'builtins_ext_test' });
    assert.equal(invokeNative('builtins_ext_test', 'check_str', ['PapaleguasLANG.PPL'], { activeDir: tmpDir, modulesDir: tmpDir }), true);
    assert.equal(invokeNative('builtins_ext_test', 'check_str', ['Papaleguas.JS'], { activeDir: tmpDir, modulesDir: tmpDir }), false);
    // x = -25 => abs=25, clamp(-25,-10,10)=-10 (abs=10); v=100 => clamp(100,5,50)=50 => 25 + 10 + 50 = 85
    assert.equal(invokeNative('builtins_ext_test', 'check_math', [-25, 100], { activeDir: tmpDir, modulesDir: tmpDir }), 85);

    if (meta.wasmPath && fs.existsSync(meta.wasmPath)) {
      const wasmBytes = fs.readFileSync(meta.wasmPath);
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      assert.equal(Number(instance.exports.check_math(-25n, 100n)), 85);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Papaléguas Lang: range inclusivo (..=), str.trim/str.slice e diagnóstico com contexto de linha', async () => {
  // Diagnóstico deve exibir linha do código e ponteiro ^
  let diagMsg = '';
  try {
    checkSource('export fn bad() -> u64 {\n  let x: u64 = "abc";\n  return x;\n}');
  } catch (e) {
    diagMsg = e.message;
  }
  assert.ok(diagMsg.includes('2 |') && diagMsg.includes('^'), 'diagnóstico deve apontar linha e coluna do erro');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-range-str-'));
  try {
    const src = `
      @policy(max_loops=100)
      export fn sum_inclusive(n: u64) -> u64 {
        let total: u64 = 0;
        for i in 1..=n {
          total += i;
        }
        return total;
      }

      export fn clean_slice(s: str) -> str {
        let t: str = str.trim(s);
        return str.slice(t, 0, 5);
      }
    `;
    const meta = compileSource(src, { outDir: tmpDir, name: 'range_str_test' });
    // 1 + 2 + 3 + 4 + 5 = 15
    assert.equal(invokeNative('range_str_test', 'sum_inclusive', [5], { activeDir: tmpDir, modulesDir: tmpDir }), 15);
    assert.equal(invokeNative('range_str_test', 'clean_slice', ['   Papaleguas!  '], { activeDir: tmpDir, modulesDir: tmpDir }), 'Papal');
    assert.equal(invokeNative('range_str_test', 'clean_slice', ['  ok  '], { activeDir: tmpDir, modulesDir: tmpDir }), 'ok');

    if (meta.wasmPath && fs.existsSync(meta.wasmPath)) {
      const wasmBytes = fs.readFileSync(meta.wasmPath);
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      assert.equal(Number(instance.exports.sum_inclusive(5n)), 15);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Papaléguas Lang: enum, match (com verificação exaustiva e WASM) e str.replace', async () => {
  // Verificador deve exigir exaustividade quando match usa enum sem '_'
  assert.throws(
    () => checkSource(`
      enum Role { Admin, Guest, Bot }
      export fn score(r: Role) -> u64 {
        match r {
          Role.Admin => { return 100; }
        }
        return 0;
      }
    `),
    /não é exaustivo/i
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-enum-match-'));
  try {
    const src = `
      enum Action {
        Allow = 0,
        Challenge = 1,
        Block = 2
      }

      export fn classify(code: u64) -> Action {
        match code {
          200 | 201 => { return Action.Allow; }
          403 | 429 => { return Action.Challenge; }
          _ => { return Action.Block; }
        }
      }

      export fn action_weight(a: Action) -> u64 {
        match a {
          Action.Allow => { return 1; }
          Action.Challenge => { return 5; }
          Action.Block => { return 10; }
          _ => { return 0; }
        }
      }

      export fn rewrite_url(u: str) -> str {
        return str.replace(u, "http://", "https://");
      }
    `;
    const meta = compileSource(src, { outDir: tmpDir, name: 'enum_match_test' });
    assert.equal(invokeNative('enum_match_test', 'classify', [200], { activeDir: tmpDir, modulesDir: tmpDir }), 0);
    assert.equal(invokeNative('enum_match_test', 'classify', [429], { activeDir: tmpDir, modulesDir: tmpDir }), 1);
    assert.equal(invokeNative('enum_match_test', 'classify', [500], { activeDir: tmpDir, modulesDir: tmpDir }), 2);
    assert.equal(invokeNative('enum_match_test', 'action_weight', [2], { activeDir: tmpDir, modulesDir: tmpDir }), 10);
    assert.equal(invokeNative('enum_match_test', 'rewrite_url', ['http://papaleguas.local/a'], { activeDir: tmpDir, modulesDir: tmpDir }), 'https://papaleguas.local/a');

    if (meta.wasmPath && fs.existsSync(meta.wasmPath)) {
      const wasmBytes = fs.readFileSync(meta.wasmPath);
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      assert.equal(Number(instance.exports.classify(201n)), 0);
      assert.equal(Number(instance.exports.classify(403n)), 1);
      assert.equal(Number(instance.exports.action_weight(2n)), 10);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('BaixaTube Recomendações em PPL: search_rank.score_baixatube_video pontua canal, tema, recência e anti-spam', () => {
  const rankMod = loadNativeModule('search_rank');
  assert.ok(rankMod && typeof rankMod.score_baixatube_video === 'function', 'search_rank.score_baixatube_video deve existir');

  const highScore = Number(rankMod.score_baixatube_video(
    'Programação em Rust na Prática',
    'Canal Tech Brasil',
    'Curso de Rust',
    'Canal Tech Brasil',
    'programacao',
    1
  ));
  const oldSpamScore = Number(rankMod.score_baixatube_video(
    'CLICKBAIT ALEATÓRIO AQUI!!!',
    'Outro Canal',
    'Curso de Rust',
    'Canal Tech Brasil',
    'programacao',
    60
  ));
  assert.ok(highScore > 150, `vídeo do mesmo canal, tema e recente deve pontuar alto (${highScore})`);
  assert.ok(oldSpamScore < 0, `vídeo antigo em caixa alta fora do tema deve ser penalizado (${oldSpamScore})`);

  const serverCode = fs.readFileSync(path.join(__dirname, '../main/server.js'), 'utf8');
  assert.ok(serverCode.includes('rankMod.score_baixatube_video('), 'scoreVideoRelevance em server.js deve usar search_rank.score_baixatube_video');
});

test('Filmes Recomendações em PPL: search_rank.score_filme_candidate prioriza filmes completos e penaliza trailers', () => {
  const rankMod = loadNativeModule('search_rank');
  assert.ok(rankMod && typeof rankMod.score_filme_candidate === 'function', 'search_rank.score_filme_candidate deve existir');

  const fullMovieScore = Number(rankMod.score_filme_candidate(
    'Missão Resgate - Filme Completo Dublado HD',
    'NetMovies',
    'acao',
    'resgate',
    105,
    10
  ));
  const trailerScore = Number(rankMod.score_filme_candidate(
    'TRAILER OFICIAL TEASER',
    'Canal Aleatorio',
    'acao',
    'resgate',
    2,
    200
  ));
  assert.ok(fullMovieScore > 120, `filme completo dublado deve pontuar alto (${fullMovieScore})`);
  assert.ok(trailerScore < 0, `trailer curto em caixa alta deve ser penalizado (${trailerScore})`);

  const serverCode = fs.readFileSync(path.join(__dirname, '../main/server.js'), 'utf8');
  assert.ok(serverCode.includes('score_filme_candidate('), 'server.js deve usar search_rank.score_filme_candidate em /filmes e searchLocalMovies');
});

test('Campos de Pesquisa em PPL: sanitize_search_query e score_search_phrase ativos no buscador', () => {
  const rankMod = loadNativeModule('search_rank');
  assert.ok(rankMod && typeof rankMod.sanitize_search_query === 'function', 'search_rank.sanitize_search_query deve existir');
  assert.ok(rankMod && typeof rankMod.score_search_phrase === 'function', 'search_rank.score_search_phrase deve existir');

  const cleaned = rankMod.sanitize_search_query('  <b>navegador</b> papaleguas  ');
  assert.equal(cleaned, 'navegador papaleguas');

  const prefixScore = Number(rankMod.score_search_phrase('papaleguas navegador seguro', 'papaleguas'));
  const spamScore = Number(rankMod.score_search_phrase('http://spam-site.com CLIQUE AQUI', 'papaleguas'));
  assert.ok(prefixScore > spamScore && prefixScore >= 80, `sugestão com prefixo deve pontuar mais (${prefixScore} vs ${spamScore})`);

  const serverCode = fs.readFileSync(path.join(__dirname, '../main/server.js'), 'utf8');
  assert.ok(serverCode.includes('sanitizeSearchFieldInput('), 'server.js deve sanitizar campos de pesquisa via PPL');
  assert.ok(serverCode.includes('score_search_phrase('), 'fetchSuggestPhrases deve pontuar sugestões via PPL');
});

test('Página Inicial em PPL: client_guard.ppl.wasm (score_home_feed_item) e curator.js integrados', async () => {
  const wasmPath = path.join(__dirname, '../papaleguas-lang/active/client_guard.ppl.wasm');
  assert.ok(fs.existsSync(wasmPath), 'client_guard.ppl.wasm deve existir em active/');
  const wasmBytes = fs.readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  assert.equal(typeof instance.exports.score_home_feed_item, 'function', 'score_home_feed_item deve ser exportado no WASM');

  const liveTrendScore = Number(instance.exports.score_home_feed_item(1, 1, 1, 2n, 1));
  const staleScore = Number(instance.exports.score_home_feed_item(0, 0, 0, 800n, 1));
  assert.ok(liveTrendScore > staleScore && liveTrendScore >= 150, `feed ao vivo/tendência deve pontuar mais (${liveTrendScore} vs ${staleScore})`);

  const newtabCode = fs.readFileSync(path.join(__dirname, '../src/newtab.html'), 'utf8');
  assert.ok(newtabCode.includes('/api/ppl-wasm?module=client_guard'), 'newtab.html deve carregar client_guard.ppl.wasm');
  assert.ok(newtabCode.includes('sortHomeVideosWithPplWasm'), 'newtab.html deve ranquear o feed com PPL WASM');

  const curatorCode = fs.readFileSync(path.join(__dirname, '../main/routes/curator.js'), 'utf8');
  assert.ok(curatorCode.includes('sanitize_search_query') && curatorCode.includes('score_search_phrase'), 'curator.js deve usar PPL no autocomplete da página inicial');
  assert.ok(curatorCode.includes('Papaleguas-PPL/2.0 (Native C11)') && curatorCode.includes('PPL-Native'), 'curator-recommendations deve declarar engine PPL nos headers');
  assert.ok(curatorCode.includes('score_baixatube_video(') && curatorCode.includes('score_filme_candidate('), 'curator-recommendations deve ranquear vídeos e filmes via PPL');
});

test('Criptografia PPL na URL e Body: ppl-crypto.js, client_guard.ppl.wasm e newtab.html/renderer.js', async () => {
  const { encryptPplPayload, decryptPplPayload, hydrateRequestWithPpl } = require('../main/ppl-crypto');
  const wasmPath = path.join(__dirname, '../papaleguas-lang/active/client_guard.ppl.wasm');
  const wasmBytes = fs.readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  assert.equal(typeof instance.exports.ppl_keystream_byte, 'function', 'client_guard.ppl.wasm deve exportar ppl_keystream_byte');

  const mod = loadNativeModule('client_guard');
  assert.equal(
    Number(mod.ppl_keystream_byte(0x12345678, 5)),
    Number(instance.exports.ppl_keystream_byte(0x12345678n, 5n)),
    'C11 N-API e WASM devem gerar exatamente o mesmo keystream'
  );

  const secretParams = {
    q: 'casa casa',
    time: 'hour',
    country: 'auto',
    manual: '0',
    deviceIp: '2804:30c:3a6c:1c00:97ac:1454:f7c8:b492',
    deviceId: 'dev_fp_s8cqg4_4_0_mwgi9y9u_5bvwlg7',
    deviceFp: 'fp_s8cqg4_4_0'
  };
  const token = encryptPplPayload(secretParams);
  assert.ok(!token.includes('casa') && !token.includes('2804:') && !token.includes('dev_fp'), 'token PPL não deve expor texto claro');

  const reqUrl = new URL(`http://192.168.1.35:8080/api/youtube-recent?ppl=${encodeURIComponent(token)}`);
  const postBody = { ppl: encryptPplPayload({ currentQuery: 'noticias', deviceId: 'dev_1' }) };
  hydrateRequestWithPpl(reqUrl, postBody);

  assert.equal(reqUrl.searchParams.has('ppl'), false, 'parâmetro ppl deve ser removido após descriptografia');
  assert.equal(reqUrl.searchParams.get('q'), 'casa casa');
  assert.equal(reqUrl.searchParams.get('deviceIp'), '2804:30c:3a6c:1c00:97ac:1454:f7c8:b492');
  assert.equal(postBody.currentQuery, 'noticias');
  assert.equal(postBody.deviceId, 'dev_1');
  assert.deepEqual(decryptPplPayload(token), secretParams);

  const newtabCode = fs.readFileSync(path.join(__dirname, '../src/newtab.html'), 'utf8');
  const rendererCode = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const serverCode = fs.readFileSync(path.join(__dirname, '../main/server.js'), 'utf8');
  assert.ok(newtabCode.includes('installPplFetchCrypto') && newtabCode.includes('search-picks'), 'newtab.html deve criptografar requisições incluindo search-picks e /search');
  assert.ok(rendererCode.includes('installRendererPplCrypto') && rendererCode.includes("u.pathname === '/proxy'"), 'renderer.js deve criptografar /search e /proxy com PPL');
  assert.ok(serverCode.includes('hydrateRequestWithPpl(') && serverCode.includes('installPplSearchPageCrypto'), 'server.js deve descriptografar ?ppl= e criptografar chamadas da página /search');

  const proxyUrl = new URL(`http://192.168.1.35:8080/proxy?ppl=${encodeURIComponent(encryptPplPayload({ url: 'https://exemplo.com/busca?q=casa', clientId: 'cli_1' }))}`);
  hydrateRequestWithPpl(proxyUrl, null);
  assert.equal(proxyUrl.searchParams.get('url'), 'https://exemplo.com/busca?q=casa');
  assert.equal(proxyUrl.searchParams.get('clientId'), 'cli_1');

  const pplNetCrypto = fs.readFileSync(path.join(__dirname, '../src/ppl-net-crypto.js'), 'utf8');
  assert.ok(pplNetCrypto.includes('XMLHttpRequest.prototype.open') && pplNetCrypto.includes('window.fetch'), 'ppl-net-crypto.js deve interceptar todos GET/POST via fetch e XHR');
  for (const rel of ['../src/index.html', '../src/newtab.html', '../src/musica.html', '../src/yt-pip.html']) {
    const html = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(html.includes('ppl-net-crypto.js'), `${rel} deve carregar ppl-net-crypto.js`);
  }
  const musicaJs = fs.readFileSync(path.join(__dirname, '../src/musica.js'), 'utf8');
  assert.ok(musicaJs.includes('window.__pplEncryptUrl('), 'musica.js deve criptografar URLs de streaming com PPL');
});

test('Melhoria nas Recomendações PPL: score_curator_candidate com multi-tópico, diversidade de canal e filtro anti-clickbait', () => {
  const rankMod = loadNativeModule('search_rank');
  assert.ok(rankMod && typeof rankMod.score_curator_candidate === 'function', 'search_rank.score_curator_candidate deve existir');

  const idealScore = Number(rankMod.score_curator_candidate(
    'Tutorial Rust e Linux na Prática',
    'Canal Dev',
    'Canal Dev',
    'rust',
    'linux',
    'programacao',
    'fofoca',
    1,
    1,
    true
  ));
  const saturatedChannelScore = Number(rankMod.score_curator_candidate(
    'Tutorial Rust e Linux na Prática',
    'Canal Dev',
    'Canal Dev',
    'rust',
    'linux',
    'programacao',
    'fofoca',
    1,
    4,
    false
  ));
  const badShortsScore = Number(rankMod.score_curator_candidate(
    'FOFOCA CHOCANTE!!! #shorts',
    'Canal Ruim',
    'Canal Dev',
    'rust',
    'linux',
    'programacao',
    'fofoca',
    45,
    1,
    false
  ));

  assert.ok(idealScore > saturatedChannelScore, `diversidade deve reduzir score de canal repetido (${idealScore} vs ${saturatedChannelScore})`);
  assert.ok(badShortsScore < -100, `shorts + clickbait + tópico descurtido deve ser fortemente penalizado (${badShortsScore})`);

  const curatorCode = fs.readFileSync(path.join(__dirname, '../main/routes/curator.js'), 'utf8');
  assert.ok(curatorCode.includes('score_curator_candidate('), 'curator.js deve usar score_curator_candidate em filterAndRankVideosForDevice');
});

test('Carregamento de Vídeo em PPL: video_stream.ppl.node controla cache, Range, retry e prioridade de pré-aquecimento', () => {
  const vsMod = loadNativeModule('video_stream');
  assert.ok(vsMod && typeof vsMod.stream_cache_key === 'function', 'video_stream.ppl.node deve carregar in-process');

  assert.equal(vsMod.stream_cache_key(' dQw4w9WgXcQ ', 'PT-BR'), 'dQw4w9WgXcQ:pt');
  assert.equal(vsMod.is_valid_stream_url('https://rr1---sn.googlevideo.com/videoplayback?id=1'), true);
  assert.equal(vsMod.is_valid_stream_url('javascript:alert(1)'), false);
  assert.equal(vsMod.should_retry_stream_status(403), true);
  assert.equal(vsMod.should_retry_stream_status(503), true);
  assert.equal(vsMod.should_retry_stream_status(206), false);
  assert.equal(vsMod.normalize_range_header(''), 'bytes=0-');
  assert.equal(vsMod.normalize_range_header('bytes=1024-2048'), 'bytes=1024-2048');
  assert.ok(Number(vsMod.score_prewarm_priority(true, true, 0)) > Number(vsMod.score_prewarm_priority(false, false, 3)));

  const serverCode = fs.readFileSync(path.join(__dirname, '../main/server.js'), 'utf8');
  assert.ok(serverCode.includes('getPplVideoStreamMod') && serverCode.includes('X-Stream-Engine'), 'server.js deve usar video_stream.ppl.node no streaming de vídeo');
});

test('Conexão Cliente-Servidor em PPL: client_guard.wasm, auto_tuner, tor_proxy e video_stream', async () => {
  const cgMod = loadNativeModule('client_guard');
  const tunerMod = loadNativeModule('auto_tuner');
  const torMod = loadNativeModule('tor_proxy');
  const vsMod = loadNativeModule('video_stream');

  assert.equal(Number(cgMod.select_best_endpoint(12, 180, 0)), 1);
  assert.equal(Number(cgMod.select_best_endpoint(12, 180, 3)), 2);
  assert.ok(Number(cgMod.compute_adaptive_backoff_ms(2, 200, true)) >= 250);

  const wasmBuf = fs.readFileSync(path.join(__dirname, '../papaleguas-lang/active/client_guard.ppl.wasm'));
  const wasmInst = await WebAssembly.instantiate(wasmBuf, {});
  assert.equal(Number(wasmInst.instance.exports.select_best_endpoint(10n, 200n, 0n)), 1);
  assert.ok(Number(wasmInst.instance.exports.compute_adaptive_backoff_ms(3n, 400n, 1)) >= 1000);

  assert.equal(Number(tunerMod.choose_compression_level(512, false, 20)), 0);
  assert.equal(Number(tunerMod.choose_compression_level(8192, true, 20)), 1);
  assert.equal(Number(tunerMod.choose_compression_level(65536, false, 20)), 5);

  assert.equal(Number(torMod.optimal_proxy_timeout_ms(false, 0)), 16000);
  assert.equal(Number(torMod.optimal_proxy_timeout_ms(true, 0)), 28000);
  assert.ok(Number(torMod.score_tor_circuit(300, 200, 0)) > Number(torMod.score_tor_circuit(2500, 429, 1)));

  assert.equal(Number(vsMod.optimal_frame_interval_ms(220, 0)), 220);
  assert.equal(Number(vsMod.optimal_frame_interval_ms(220, 3)), 2500);
  assert.equal(Number(vsMod.optimal_chunk_kb(10000, false)), 1024);

  const shieldMod = loadNativeModule('shield_guard');
  const ufMod = loadNativeModule('url_filter');
  const hwMod = loadNativeModule('hw_probe');
  const idxMod = loadNativeModule('search_index');

  assert.equal(shieldMod.is_scanner_path('/.env'), true);
  assert.equal(shieldMod.is_scanner_path('/wp-admin/install.php'), true);
  assert.equal(shieldMod.is_scanner_path('/search'), false);
  assert.equal(Number(shieldMod.classify_threat_level(300, 10, 2, false)), 3);
  assert.equal(Number(shieldMod.classify_threat_level(300, 10, 2, true)), 0);

  assert.equal(ufMod.is_ip_leak_or_stun_url('stun:stun.l.google.com:19302'), true);
  assert.equal(ufMod.is_ip_leak_or_stun_url('https://cloudflare.com/cdn-cgi/trace'), true);
  assert.equal(ufMod.is_ip_leak_or_stun_url('https://pt.wikipedia.org/wiki/Brasil'), false);

  assert.ok(Number(hwMod.optimal_worker_threads()) >= 2);
  assert.ok(Number(hwMod.health_score()) >= 10);

  assert.equal(idxMod.should_index_url('https://pt.wikipedia.org/wiki/Rust', 15), true);
  assert.equal(idxMod.should_index_url('https://doubleclick.net/ad', 15), false);
  assert.equal(idxMod.canonical_url_hash('  HTTPS://EXAMPLE.COM '), idxMod.canonical_url_hash('https://example.com'));
});

test('Linguagem PPL v2: novos builtins str.to_upper, str.count, str.is_ascii_alnum, str.contains_ci, min_i64/max_i64 e cache SHA-256 + WASM const', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-v2-'));
  const src = `
@policy(max_loops=100, no_network=true, zero_traces=true)

export fn upper_code(s: str) -> str {
  return str.to_upper(str.trim(s));
}

export fn count_dots(s: str) -> u64 {
  return str.count(s, ".");
}

export fn is_valid_vid(s: str) -> bool {
  return str.len(s) == 11 and str.is_ascii_alnum(s);
}

export fn has_word_ci(h: str, n: str) -> bool {
  return str.contains_ci(h, n);
}

export fn bound_signed(a: i64, b: i64) -> i64 {
  return max_i64(min_i64(a, b), -10);
}
`;
  const m1 = compileSource(src, { outDir, name: 'ppl_v2_test' });
  const m2 = compileSource(src, { outDir, name: 'ppl_v2_test' });
  assert.equal(m1.cached, false);
  assert.equal(m2.cached, true);
  assert.ok(m2.compileMs <= 20, `Cache SHA-256 deveria ser instantâneo, levou ${m2.compileMs}ms`);

  const mod = loadNativeModule('ppl_v2_test', { activeDir: outDir });
  assert.ok(mod);
  assert.equal(mod.upper_code('  br  '), 'BR');
  assert.equal(Number(mod.count_dots('a.b.c.d')), 3);
  assert.equal(mod.is_valid_vid('dQw4w9WgXcQ'), true);
  assert.equal(mod.is_valid_vid('bad/id?x=1!'), false);
  assert.equal(mod.has_word_ci('Papaleguas Super Browser', 'super'), true);
  assert.equal(mod.has_word_ci('Papaleguas Super Browser', 'chrome'), false);
  assert.equal(Number(mod.bound_signed(-25, 5)), -10);
  assert.equal(Number(mod.bound_signed(-3, 8)), -3);

  // Testa WASM com const bool/f64 e min_i64/max_i64/clamp_i64
  const wasmSrc = `
@policy(max_loops=50, no_network=true, zero_traces=true)
const ENABLED: bool = true;
const SCALE: f64 = 2.5;
export fn eval_signed(x: i64, y: i64) -> i64 {
  if ENABLED {
    return clamp_i64(min_i64(x, y), -5, 50);
  }
  return max_i64(x, y);
}
export fn scale_val(v: f64) -> f64 {
  return v * SCALE;
}
`;
  const wm = compileSource(wasmSrc, { outDir, name: 'ppl_v2_wasm' });
  assert.ok(wm.wasmPath && fs.existsSync(wm.wasmPath), 'Deveria gerar módulo .ppl.wasm válido com const bool/f64');
});

test('Módulos nativos PPL independentes: privacy_shield, media_guard e net_router', () => {
  const ps = loadNativeModule('privacy_shield');
  const mg = loadNativeModule('media_guard');
  const nr = loadNativeModule('net_router');
  assert.ok(ps && mg && nr);

  assert.equal(ps.is_private_or_lan_ip('127.0.0.1'), true);
  assert.equal(ps.is_private_or_lan_ip('192.168.0.10'), true);
  assert.equal(ps.is_private_or_lan_ip('8.8.8.8'), false);
  assert.equal(ps.has_sensitive_log_pattern('Servidor iniciado na porta 8080'), false);
  assert.equal(ps.has_sensitive_log_pattern('Authorization: Bearer secret123'), true);
  assert.equal(ps.normalize_country_code(' pt ', 'BR'), 'PT');
  assert.equal(ps.normalize_country_code('auto', 'BR'), 'BR');

  assert.equal(mg.is_valid_youtube_id('dQw4w9WgXcQ'), true);
  assert.equal(mg.is_valid_youtube_id('short'), false);
  assert.equal(mg.normalize_stream_mime('video/mp4', false), 'audio/mp4');
  assert.equal(mg.normalize_stream_mime('video/webm', false), 'audio/webm');
  assert.equal(mg.normalize_stream_mime('video/mp4', true), 'video/mp4');
  assert.equal(Number(mg.compute_feed_rotation_page(1, true, 4)), 6);

  assert.equal(nr.is_forbidden_static_path('/../.env'), true);
  assert.equal(nr.is_forbidden_static_path('/styles.css'), false);
  assert.equal(Number(nr.classify_route_kind('/styles.css')), 1);
  assert.equal(Number(nr.classify_route_kind('/musica')), 2);
  assert.equal(Number(nr.classify_route_kind('/api/dj-chat')), 3);
  assert.equal(Number(nr.classify_route_kind('/api/stream-audio')), 4);
  assert.equal(Number(nr.cache_ttl_seconds(1, true)), 31536000);
});

test('Módulos nativos PPL avançados: rate_guard (N-API + WASM), bm25_engine, adblock_engine e crypto_engine', () => {
  const rg = loadNativeModule('rate_guard');
  const bm = loadNativeModule('bm25_engine');
  const ab = loadNativeModule('adblock_engine');
  const ce = loadNativeModule('crypto_engine');
  assert.ok(rg && bm && ab && ce);

  assert.equal(rg.allow_rate_window(5, 10, false), true);
  assert.equal(rg.allow_rate_window(10, 10, false), false);
  assert.equal(rg.allow_rate_window(999, 10, true), true);
  assert.equal(Number(rg.retry_after_sec(60000, 12500)), 48);
  assert.equal(rg.allow_concurrency(4, 10, 92), true);
  assert.equal(rg.allow_concurrency(6, 10, 92), false);
  assert.equal(Number(rg.compute_backoff_ms(3, 250, 5000)), 1000);

  assert.ok(bm.bm25_term_score(3, 120, 100, 5, 1000) > bm.bm25_term_score(1, 300, 100, 500, 1000));
  assert.ok(Number(bm.score_document_match('El Pais Brasil', 'https://elpais.com', 'noticias hoje', 'elpais')) >= 30);
  assert.equal(bm.clean_search_snippet('  <b>Notícia</b> <i>Urgente</i>  '), 'Notícia Urgente');

  assert.equal(ab.should_block_ad_url('https://googleads.g.doubleclick.net/pagead/ads'), true);
  assert.equal(ab.should_block_ad_url('https://pt.wikipedia.org/wiki/Brasil'), false);
  assert.equal(ab.has_tracking_query('https://site.com/p?utm_source=ads'), true);
  assert.equal(ab.is_safe_redirect_url('javascript:alert(1)'), false);
  assert.equal(ab.is_safe_redirect_url('https://papaleguas.app/musica'), true);

  assert.equal(ce.is_valid_ppl_token('a1b2c3d4.xyz123'), true);
  assert.equal(ce.is_valid_ppl_token('invalid_token_without_dot'), false);
  assert.ok(Number(ce.derive_deterministic_nonce('{"u":"https://papaleguas.app"}')) > 0);
  assert.ok(BigInt(ce.mix_entropy_u64(100, 200)) > 0n);
});

test('Compilador Multi-Target PPL: detectToolchains e compileTarget(all -> linux-x64 + wasm)', () => {
  const { detectToolchains, compileTarget } = require('../papaleguas-lang/compiler');
  const tc = detectToolchains();
  assert.equal(tc['linux-x64'].available, true);
  assert.equal(tc['wasm'].available, true);
  assert.ok('windows-x64' in tc && 'linux-arm64' in tc && 'android-arm64' in tc);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-multi-'));
  const src = `
@policy(max_loops=50, no_network=true, zero_traces=true)
export fn calc_score(a: u64, b: u64) -> u64 {
  return clamp_u64(a + b, 0, 100);
}
`;
  const allRes = compileTarget(src, 'all', { outDir, name: 'multi_demo' });
  assert.equal(allRes.ok, true);
  assert.equal(allRes.results['linux-x64'].ok, true);
  assert.equal(allRes.results['wasm'].ok, true);
  assert.ok(fs.existsSync(allRes.results['linux-x64'].artifact));
  assert.ok(fs.existsSync(allRes.results['wasm'].artifact));
});

test('PPL AST Optimizer: constant folding, simplificação algébrica, dead-branch pruning e dead-code elimination', () => {
  const { optimizeAst } = require('../papaleguas-lang/optimizer');
  const src = `
    @policy(max_loops=50, no_network=true, zero_traces=true)
    export fn opt_demo(x: u64) -> u64 {
      let c: u64 = (10 + 20) * 2;
      let a: u64 = (x + 0) * 1;
      if false {
        return 999;
      }
      if true {
        return c + a;
        let dead_after_ret: u64 = 123;
      }
      return 0;
    }
  `;
  const { ast } = checkSource(src, 'opt_demo.ppl');
  const { ast: optAst, stats } = optimizeAst(ast);
  assert.ok(stats.foldedConstants >= 2, `esperava foldedConstants >= 2, obtido ${stats.foldedConstants}`);
  assert.ok(stats.algebraicSimplifications >= 2, `esperava algebraicSimplifications >= 2, obtido ${stats.algebraicSimplifications}`);
  assert.ok(stats.eliminatedDeadBranches >= 2, `esperava eliminatedDeadBranches >= 2, obtido ${stats.eliminatedDeadBranches}`);
  assert.ok(stats.eliminatedDeadStmts >= 1, `esperava eliminatedDeadStmts >= 1, obtido ${stats.eliminatedDeadStmts}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-opt-'));
  try {
    const meta = compileSource(src, { outDir: tmpDir, name: 'opt_demo' });
    assert.ok(meta.optimizerStats && meta.optimizerStats.foldedConstants >= 2);
    assert.equal(invokeNative('opt_demo', 'opt_demo', [7], { activeDir: tmpDir, modulesDir: tmpDir }), 67);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PPL Zero-Alloc Builtins: str.is_empty, *_ci, str.hash_fnv1a_ci, math.pow_u64 e math.pct_u64', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-zeroalloc-'));
  try {
    const src = `
      @policy(max_loops=50, no_network=true, zero_traces=true)
      export fn test_str_ci(s: str) -> bool {
        if str.is_empty(s) {
          return false;
        }
        return str.starts_with_ci(s, "HTTPS://") and str.ends_with_ci(s, ".APP");
      }

      export fn test_eq_ci(a: str, b: str) -> bool {
        return str.equals_ci(a, b);
      }

      export fn test_hash_ci_match(a: str, b: str) -> bool {
        return str.hash_fnv1a_ci(a) == str.hash_fnv1a_ci(b);
      }

      export fn test_math_ext(base: u64, exp: u64, part: u64, total: u64) -> u64 {
        return math.pow_u64(base, exp) + math.pct_u64(part, total);
      }
    `;
    const meta = compileSource(src, { outDir: tmpDir, name: 'zeroalloc_test' });
    assert.equal(invokeNative('zeroalloc_test', 'test_str_ci', [''], { activeDir: tmpDir, modulesDir: tmpDir }), false);
    assert.equal(invokeNative('zeroalloc_test', 'test_str_ci', ['https://Papaleguas.app'], { activeDir: tmpDir, modulesDir: tmpDir }), true);
    assert.equal(invokeNative('zeroalloc_test', 'test_str_ci', ['http://Papaleguas.app'], { activeDir: tmpDir, modulesDir: tmpDir }), false);
    assert.equal(invokeNative('zeroalloc_test', 'test_eq_ci', ['PaPaLeGuAs', 'papaleguas'], { activeDir: tmpDir, modulesDir: tmpDir }), true);
    assert.equal(invokeNative('zeroalloc_test', 'test_eq_ci', ['abc', 'abcd'], { activeDir: tmpDir, modulesDir: tmpDir }), false);
    assert.equal(invokeNative('zeroalloc_test', 'test_hash_ci_match', ['HTTPS://PAPALEGUAS.APP', 'https://papaleguas.app'], { activeDir: tmpDir, modulesDir: tmpDir }), true);
    // 2^10 = 1024, pct(3, 4) = 75 => 1099
    assert.equal(invokeNative('zeroalloc_test', 'test_math_ext', [2, 10, 3, 4], { activeDir: tmpDir, modulesDir: tmpDir }), 1099);
    // pct(5, 0) = 0, 3^0 = 1 => 1
    assert.equal(invokeNative('zeroalloc_test', 'test_math_ext', [3, 0, 5, 0], { activeDir: tmpDir, modulesDir: tmpDir }), 1);

    // Compilação seletiva WASM: mesmo com funções str no módulo, test_math_ext deve existir em .ppl.wasm!
    assert.ok(meta.wasmPath && fs.existsSync(meta.wasmPath), 'Deveria gerar .ppl.wasm seletivo para test_math_ext');
    assert.ok(Array.isArray(meta.wasmFunctions) && meta.wasmFunctions.includes('test_math_ext'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PPL Selective WebAssembly Compilation: bm25_engine.ppl.wasm executa nativamente via WebAssembly.instantiate', async () => {
  const bmWasmPath = path.join(__dirname, '..', 'papaleguas-lang', 'dist', 'wasm', 'bm25_engine.ppl.wasm');
  assert.ok(fs.existsSync(bmWasmPath), 'bm25_engine.ppl.wasm deve existir após compilação seletiva');
  const wasmBytes = fs.readFileSync(bmWasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  assert.equal(typeof instance.exports.bm25_tf_component, 'function');
  assert.equal(typeof instance.exports.bm25_idf_approx, 'function');
  assert.equal(typeof instance.exports.bm25_term_score, 'function');

  const highScore = instance.exports.bm25_term_score(3n, 120n, 100n, 5n, 1000n);
  const lowScore = instance.exports.bm25_term_score(1n, 300n, 100n, 500n, 1000n);
  assert.ok(highScore > lowScore && highScore > 2.0, `WASM BM25 score inesperado: high=${highScore}, low=${lowScore}`);

  // Compara precisão entre N-API C11 e WebAssembly
  const bmNative = loadNativeModule('bm25_engine');
  const nativeScore = bmNative.bm25_term_score(3, 120, 100, 5, 1000);
  assert.ok(Math.abs(highScore - nativeScore) < 1e-9, `Divergência WASM (${highScore}) vs N-API (${nativeScore})`);
});
