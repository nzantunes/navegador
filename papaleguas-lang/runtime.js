'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { compileFile } = require('./compiler');

const DEFAULT_MODULES_DIR = path.join(__dirname, 'modules');
const DEFAULT_ACTIVE_DIR = path.join(__dirname, 'active');

const inProcessCache = new Map();
const fastLookupCache = new Map();
const watchedDirs = new Set();
const STAT_CHECK_TTL_MS = 15000;
const runtimeStats = {
  fastHits: 0,
  statChecks: 0,
  dlopenCount: 0,
  napiCalls: 0,
  cliFallbacks: 0,
  dlopenErrors: 0,
  warmedModules: []
};

function ensureDirWatch(activeDir) {
  if (watchedDirs.has(activeDir)) return;
  watchedDirs.add(activeDir);
  try {
    if (!fs.existsSync(activeDir)) return;
    const watcher = fs.watch(activeDir, (eventType, filename) => {
      if (!filename || !filename.endsWith('.ppl.node')) return;
      const modName = filename.replace(/\.ppl\.node$/, '');
      fastLookupCache.delete(`${activeDir}:${modName}`);
    });
    if (watcher && typeof watcher.unref === 'function') watcher.unref();
  } catch (e) {}
}

/**
 * Runtime Nativo Papaléguas (.ppl)
 * Prioriza execução in-process via N-API (.ppl.node) direto na CPU com zero overhead,
 * mantendo fallback para binário CLI (.pplbin) em sandbox.
 */
function resolveModuleBinary(moduleName, activeDir = DEFAULT_ACTIVE_DIR, modulesDir = DEFAULT_MODULES_DIR) {
  const binPath = path.join(activeDir, `${moduleName}.pplbin`);
  const napiPath = path.join(activeDir, `${moduleName}.ppl.node`);
  const metaPath = path.join(activeDir, `${moduleName}.meta.json`);
  const hasNapi = fs.existsSync(napiPath);
  const hasBin = fs.existsSync(binPath);
  if (hasNapi || hasBin) {
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
    return {
      binPath: hasBin ? binPath : null,
      napiPath: hasNapi ? napiPath : null,
      meta
    };
  }
  const srcPath = path.join(modulesDir, `${moduleName}.ppl`);
  if (fs.existsSync(srcPath)) {
    const meta = compileFile(srcPath, { outDir: activeDir, name: moduleName });
    return { binPath: meta.binPath, napiPath: meta.napiPath || null, meta };
  }
  throw new Error(`[Papaléguas Runtime] Módulo '${moduleName}' não encontrado.`);
}

function loadNativeModule(moduleName, options = {}) {
  const activeDir = options.activeDir || DEFAULT_ACTIVE_DIR;
  const fastKey = `${activeDir}:${moduleName}`;
  const now = Date.now();
  const cachedFast = fastLookupCache.get(fastKey);
  if (cachedFast && (now - cachedFast.checkedAt < STAT_CHECK_TTL_MS)) {
    runtimeStats.fastHits++;
    return cachedFast.exports;
  }

  ensureDirWatch(activeDir);
  runtimeStats.statChecks++;
  const modulesDir = options.modulesDir || DEFAULT_MODULES_DIR;
  const napiCandidate = path.join(activeDir, `${moduleName}.ppl.node`);
  let napiPath = null;
  let stat = null;
  try {
    stat = fs.statSync(napiCandidate);
    napiPath = napiCandidate;
  } catch (e) {
    const resolved = resolveModuleBinary(moduleName, activeDir, modulesDir);
    napiPath = resolved.napiPath;
    if (napiPath) stat = fs.statSync(napiPath);
  }
  if (!napiPath || !stat) return null;

  const cacheKey = `${napiPath}:${stat.mtimeMs}`;
  if (inProcessCache.has(cacheKey)) {
    const exportsObj = inProcessCache.get(cacheKey);
    fastLookupCache.set(fastKey, { exports: exportsObj, checkedAt: now });
    return exportsObj;
  }
  try {
    const mod = { exports: {} };
    process.dlopen(mod, napiPath);
    runtimeStats.dlopenCount++;
    inProcessCache.set(cacheKey, mod.exports);
    fastLookupCache.set(fastKey, { exports: mod.exports, checkedAt: now });
    return mod.exports;
  } catch (err) {
    runtimeStats.dlopenErrors++;
    // Se o binário N-API falhou ao abrir, tenta recompilar do fonte .ppl uma vez
    const srcPath = path.join(modulesDir, `${moduleName}.ppl`);
    if (!options._retried && fs.existsSync(srcPath)) {
      try {
        compileFile(srcPath, { outDir: activeDir, name: moduleName, force: true });
        return loadNativeModule(moduleName, Object.assign({}, options, { _retried: true }));
      } catch (e2) {}
    }
    return null;
  }
}

function warmupNativeModules(moduleNames = [], options = {}) {
  const activeDir = options.activeDir || DEFAULT_ACTIVE_DIR;
  const modulesDir = options.modulesDir || DEFAULT_MODULES_DIR;
  const loaded = [];
  for (const name of moduleNames) {
    try {
      const mod = loadNativeModule(name, { activeDir, modulesDir });
      if (mod) loaded.push(name);
    } catch (e) {}
  }
  runtimeStats.warmedModules = loaded;
  return loaded;
}

function getRuntimeStats() {
  return {
    fastHits: runtimeStats.fastHits,
    statChecks: runtimeStats.statChecks,
    dlopenCount: runtimeStats.dlopenCount,
    napiCalls: runtimeStats.napiCalls,
    cliFallbacks: runtimeStats.cliFallbacks,
    dlopenErrors: runtimeStats.dlopenErrors,
    cachedModules: fastLookupCache.size,
    warmedModules: runtimeStats.warmedModules.slice()
  };
}

function invokeNative(moduleName, fnName, args = [], options = {}) {
  const activeDir = options.activeDir || DEFAULT_ACTIVE_DIR;
  const modulesDir = options.modulesDir || DEFAULT_MODULES_DIR;
  const addon = loadNativeModule(moduleName, { activeDir, modulesDir });
  if (addon && typeof addon[fnName] === 'function') {
    runtimeStats.napiCalls++;
    return addon[fnName](...args);
  }
  const { binPath } = resolveModuleBinary(moduleName, activeDir, modulesDir);
  if (!binPath) {
    throw new Error(`[Papaléguas Runtime] Função '${fnName}' indisponível no módulo '${moduleName}'.`);
  }
  runtimeStats.cliFallbacks++;
  const strArgs = [String(fnName), ...args.map((a) => String(a))];
  const stdout = execFileSync(binPath, strArgs, {
    encoding: 'utf8',
    timeout: options.timeoutMs || 3000
  });
  const parsed = JSON.parse(String(stdout || '').trim());
  if (!parsed || !parsed.ok) {
    throw new Error(`[Papaléguas Runtime] Erro ao executar ${moduleName}.${fnName}: ${(parsed && parsed.error) || 'unknown'}`);
  }
  return parsed.result;
}

function listActiveModules(activeDir = DEFAULT_ACTIVE_DIR) {
  if (!fs.existsSync(activeDir)) return [];
  const files = fs.readdirSync(activeDir).filter((f) => f.endsWith('.meta.json'));
  return files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(activeDir, f), 'utf8'));
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

module.exports = {
  resolveModuleBinary,
  loadNativeModule,
  warmupNativeModules,
  getRuntimeStats,
  invokeNative,
  listActiveModules
};
