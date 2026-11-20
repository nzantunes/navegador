'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { tokenize } = require('./lexer');
const { parse } = require('./parser');
const { verify } = require('./verifier');
const { optimizeAst } = require('./optimizer');
const { generateC } = require('./codegen-c');
const { generateWat, selectWasmEligibleFunctions } = require('./codegen-wasm');

function formatSourceContext(source, message) {
  const m = String(message || '').match(/(\d+):(\d+)/);
  if (!m) return '';
  const lineNo = parseInt(m[1], 10);
  const colNo = parseInt(m[2], 10);
  const srcLines = String(source || '').split(/\r?\n/);
  if (lineNo < 1 || lineNo > srcLines.length) return '';
  const codeLine = srcLines[lineNo - 1];
  const caret = ' '.repeat(Math.max(0, colNo - 1)) + '^';
  return `\n  ${lineNo} | ${codeLine}\n  ${' '.repeat(String(lineNo).length)} | ${caret}`;
}

/**
 * Compila código-fonte Papaléguas (.ppl) -> AST verificada -> C11 seguro -> Binário Nativo de Hardware.
 */
function checkSource(source, filePath = '<memory>') {
  let tokens;
  let ast;
  try {
    tokens = tokenize(source);
    ast = parse(tokens);
  } catch (err) {
    const ctx = formatSourceContext(source, err && err.message);
    if (ctx && err) err.message += ctx;
    throw err;
  }
  const verification = verify(ast);
  if (!verification.ok) {
    const firstCtx = formatSourceContext(source, verification.errors[0]);
    const err = new Error(
      `[Papaléguas Verifier] Falha de segurança/tipagem em ${filePath}:\n  - ` + verification.errors.join('\n  - ') + firstCtx
    );
    err.errors = verification.errors;
    throw err;
  }
  return { tokens, ast, verification };
}

function findNodeIncludeDir() {
  const candidates = ['/usr/include/node', '/usr/include/nodejs/src', '/usr/local/include/node'];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node_api.h'))) return dir;
  }
  return null;
}

const COMPILER_ABI_VERSION = 'ppl-c11-lto-v3';

function compileSource(source, options = {}) {
  const filePath = options.filePath || '<memory>';
  const outDir = options.outDir || path.join(__dirname, 'build');
  const moduleName = options.name || path.basename(filePath, '.ppl') || 'module';
  const startMs = Date.now();
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');

  const metaPath = path.join(outDir, `${moduleName}.meta.json`);
  const binPath = path.join(outDir, `${moduleName}.pplbin`);
  const napiCandidate = path.join(outDir, `${moduleName}.ppl.node`);
  if (!options.force && fs.existsSync(metaPath) && fs.existsSync(binPath)) {
    try {
      const prevMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const nodeIncPresent = Boolean(findNodeIncludeDir());
      const napiOk = !nodeIncPresent || (prevMeta.napiPath && fs.existsSync(prevMeta.napiPath)) || fs.existsSync(napiCandidate);
      if (prevMeta && prevMeta.sourceHash === sourceHash && prevMeta.compilerVersion === COMPILER_ABI_VERSION && napiOk) {
        return Object.assign({}, prevMeta, { cached: true, compileMs: Date.now() - startMs });
      }
    } catch (e) {}
  }

  const { ast: rawAst, verification } = checkSource(source, filePath);
  const { ast, stats: optimizerStats } = options.optimize === false
    ? { ast: rawAst, stats: { foldedConstants: 0, algebraicSimplifications: 0, eliminatedDeadBranches: 0, eliminatedDeadStmts: 0 } }
    : optimizeAst(rawAst);
  const cCode = generateC(ast, verification, { mode: 'cli' });

  fs.mkdirSync(outDir, { recursive: true });
  const cPath = path.join(outDir, `${moduleName}.c`);

  fs.writeFileSync(cPath, cCode, 'utf8');

  const commonFlags = [
    '-std=c11',
    '-O3',
    '-march=native',
    '-flto=auto',
    '-fomit-frame-pointer',
    '-pthread',
    '-fstack-protector-strong',
    '-D_FORTIFY_SOURCE=2',
    '-Wall',
    '-Wextra',
    '-Wno-unused-parameter',
    '-Wno-unused-function'
  ];

  const sslFlags = (cCode.includes('SSL_CTX_new') && fs.existsSync('/usr/include/openssl/ssl.h'))
    ? ['-lssl', '-lcrypto']
    : [];

  execFileSync('gcc', [...commonFlags, cPath, '-o', binPath, ...sslFlags], { encoding: 'utf8', timeout: 15000 });

  let napiPath = null;
  const nodeInc = findNodeIncludeDir();
  if (nodeInc) {
    const napiCPath = path.join(outDir, `${moduleName}.napi.c`);
    napiPath = path.join(outDir, `${moduleName}.ppl.node`);
    const napiCode = generateC(ast, verification, { mode: 'napi' });
    fs.writeFileSync(napiCPath, napiCode, 'utf8');
    execFileSync(
      'gcc',
      [...commonFlags, '-shared', '-fPIC', `-I${nodeInc}`, napiCPath, '-o', napiPath, ...sslFlags],
      { encoding: 'utf8', timeout: 15000 }
    );
  }

  let wasmPath = null;
  let wasmFunctions = [];
  if (options.wasm !== false && fs.existsSync('/usr/bin/wat2wasm')) {
    try {
      const eligible = selectWasmEligibleFunctions(ast);
      const watCode = generateWat(ast);
      if (watCode) {
        const watPath = path.join(outDir, `${moduleName}.wat`);
        const outWasm = path.join(outDir, `${moduleName}.ppl.wasm`);
        fs.writeFileSync(watPath, watCode, 'utf8');
        execFileSync('/usr/bin/wat2wasm', [watPath, '-o', outWasm], { encoding: 'utf8', timeout: 10000 });
        wasmPath = outWasm;
        wasmFunctions = eligible.filter((f) => f.isExport || f.name === 'main').map((f) => f.name);
      }
    } catch (e) {
      wasmPath = null;
      wasmFunctions = [];
    }
  }

  const exportedFunctions = (ast.functions || [])
    .filter((f) => f.isExport || f.name === 'main')
    .map((f) => ({
      name: f.name,
      params: f.params,
      returnType: f.returnType,
      policy: f.policy
    }));

  const meta = {
    name: moduleName,
    compilerVersion: COMPILER_ABI_VERSION,
    sourcePath: filePath,
    sourceHash,
    binPath,
    napiPath,
    wasmPath,
    wasmFunctions,
    cPath,
    policy: verification.policy,
    optimizerStats,
    exportedFunctions,
    compiledAt: new Date().toISOString(),
    compileMs: Date.now() - startMs,
    cached: false
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  return meta;
}

function whichBinary(name) {
  try {
    const out = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

function findAndroidNdkClang() {
  const ndkRoot = process.env.ANDROID_NDK_HOME || process.env.ANDROID_NDK_ROOT || '';
  if (!ndkRoot) return null;
  const binDir = path.join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin');
  const candidates = ['aarch64-linux-android24-clang', 'aarch64-linux-android26-clang', 'aarch64-linux-android21-clang'];
  for (const c of candidates) {
    const full = path.join(binDir, c);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function detectToolchains() {
  const gccPath = whichBinary('gcc');
  const watPath = whichBinary('wat2wasm') || (fs.existsSync('/usr/bin/wat2wasm') ? '/usr/bin/wat2wasm' : null);
  const mingwPath = whichBinary('x86_64-w64-mingw32-gcc');
  const arm64Path = whichBinary('aarch64-linux-gnu-gcc');
  const androidClang = findAndroidNdkClang();

  return {
    'linux-x64': {
      available: Boolean(gccPath),
      compiler: gccPath,
      os: 'Linux x86_64',
      outputs: ['.pplbin', '.ppl.node'],
      hint: 'sudo apt install gcc'
    },
    'wasm': {
      available: Boolean(watPath),
      compiler: watPath,
      os: 'Universal (Windows, macOS, Linux, Android, iOS)',
      outputs: ['.ppl.wasm'],
      hint: 'sudo apt install wabt'
    },
    'windows-x64': {
      available: Boolean(mingwPath),
      compiler: mingwPath,
      os: 'Windows 64-bit',
      outputs: ['.exe', '.dll'],
      hint: 'sudo apt install mingw-w64'
    },
    'linux-arm64': {
      available: Boolean(arm64Path),
      compiler: arm64Path,
      os: 'Linux ARM64 (Raspberry Pi / TV Box / Server ARM)',
      outputs: ['.arm64.pplbin', '.arm64.so'],
      hint: 'sudo apt install gcc-aarch64-linux-gnu'
    },
    'android-arm64': {
      available: Boolean(androidClang),
      compiler: androidClang,
      os: 'Android ARM64 (Celular / Tablet / TV)',
      outputs: ['.so'],
      hint: 'Instalar Android NDK e definir ANDROID_NDK_HOME'
    }
  };
}

function compileTarget(source, target, options = {}) {
  const t = String(target || 'linux-x64').trim().toLowerCase();
  const filePath = options.filePath || '<memory>';
  const outDir = options.outDir || path.join(__dirname, 'dist', t);
  const moduleName = options.name || path.basename(filePath, '.ppl') || 'module';
  const startMs = Date.now();
  const toolchains = detectToolchains();

  if (t === 'all') {
    const results = {};
    for (const [k, info] of Object.entries(toolchains)) {
      if (!info.available) continue;
      results[k] = compileTarget(source, k, Object.assign({}, options, { outDir: path.join(outDir, k) }));
    }
    return { ok: true, target: 'all', results, compileMs: Date.now() - startMs };
  }

  if (!toolchains[t]) {
    throw new Error(`[Papaléguas Compiler] Alvo desconhecido: '${t}'. Alvos suportados: ${Object.keys(toolchains).join(', ')}`);
  }
  if (!toolchains[t].available) {
    return { ok: false, skipped: true, target: t, reason: `Toolchain indisponível (${toolchains[t].hint})` };
  }

  if (t === 'linux-x64') {
    const meta = compileSource(source, Object.assign({}, options, { outDir, name: moduleName, wasm: false }));
    const bytes = fs.existsSync(meta.binPath) ? fs.statSync(meta.binPath).size : 0;
    return {
      ok: true,
      target: t,
      artifact: meta.binPath,
      extraArtifact: meta.napiPath || null,
      bytes,
      compileMs: meta.compileMs,
      cached: Boolean(meta.cached)
    };
  }

  const { ast: rawAst, verification } = checkSource(source, filePath);
  const { ast } = options.optimize === false ? { ast: rawAst } : optimizeAst(rawAst);
  fs.mkdirSync(outDir, { recursive: true });

  if (t === 'wasm') {
    const eligible = selectWasmEligibleFunctions(ast);
    const watCode = generateWat(ast);
    if (!watCode) {
      return { ok: true, skipped: true, target: t, reason: 'Módulo usa apenas APIs de string/sistema (compilado em C11 nativo)' };
    }
    const watPath = path.join(outDir, `${moduleName}.wat`);
    const wasmPath = path.join(outDir, `${moduleName}.ppl.wasm`);
    fs.writeFileSync(watPath, watCode, 'utf8');
    execFileSync(toolchains.wasm.compiler, [watPath, '-o', wasmPath], { encoding: 'utf8', timeout: 10000 });
    return {
      ok: true,
      target: t,
      artifact: wasmPath,
      wasmFunctions: eligible.filter((f) => f.isExport || f.name === 'main').map((f) => f.name),
      bytes: fs.statSync(wasmPath).size,
      compileMs: Date.now() - startMs,
      cached: false
    };
  }

  // Cross-compilation C11 (windows-x64, linux-arm64, android-arm64)
  const cCode = generateC(ast, verification, { mode: 'cli' });
  const cPath = path.join(outDir, `${moduleName}.c`);
  fs.writeFileSync(cPath, cCode, 'utf8');
  const cc = toolchains[t].compiler;
  const baseFlags = ['-std=c11', '-O3', '-Wall', '-Wextra', '-Wno-unused-parameter', '-Wno-unused-function'];

  if (t === 'windows-x64') {
    const exePath = path.join(outDir, `${moduleName}.exe`);
    execFileSync(cc, [...baseFlags, cPath, '-o', exePath], { encoding: 'utf8', timeout: 20000 });
    return { ok: true, target: t, artifact: exePath, bytes: fs.statSync(exePath).size, compileMs: Date.now() - startMs, cached: false };
  }
  if (t === 'linux-arm64') {
    const binPath = path.join(outDir, `${moduleName}.arm64.pplbin`);
    execFileSync(cc, [...baseFlags, '-pthread', cPath, '-o', binPath], { encoding: 'utf8', timeout: 20000 });
    return { ok: true, target: t, artifact: binPath, bytes: fs.statSync(binPath).size, compileMs: Date.now() - startMs, cached: false };
  }
  if (t === 'android-arm64') {
    const soPath = path.join(outDir, `lib${moduleName}.so`);
    execFileSync(cc, [...baseFlags, '-shared', '-fPIC', cPath, '-o', soPath], { encoding: 'utf8', timeout: 20000 });
    return { ok: true, target: t, artifact: soPath, bytes: fs.statSync(soPath).size, compileMs: Date.now() - startMs, cached: false };
  }
  return { ok: false, target: t, reason: 'target_unhandled' };
}

function compileFile(pplFilePath, options = {}) {
  const absPath = path.resolve(pplFilePath);
  const source = fs.readFileSync(absPath, 'utf8');
  return compileSource(source, Object.assign({}, options, {
    filePath: absPath,
    name: options.name || path.basename(absPath, '.ppl')
  }));
}

module.exports = { checkSource, compileSource, compileFile, compileTarget, detectToolchains };
