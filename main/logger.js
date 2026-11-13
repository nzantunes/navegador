'use strict';
// =========================================================================
// PAPALÉGUAS - LOGGER CENTRAL
// =========================================================================
// - Grava avisos/erros em data/logs/*.log com rotação por tamanho.
// - `swallowed(err, where)` substitui os antigos `catch (e) {}`: não muda o
//   comportamento (o erro continua sendo ignorado), mas conta cada ocorrência
//   por local e, com PAPALEGUAS_DEBUG=1, registra no log. Assim dá para
//   descobrir onde as falhas silenciosas estão acontecendo.

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.PAPALEGUAS_LOG_DIR || path.join(__dirname, '..', 'data', 'logs');
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED = 3;
const DEBUG = /^(1|true|yes)$/i.test(String(process.env.PAPALEGUAS_DEBUG || ''));

let redact = (s) => s;
try { redact = require('./log-redact').redactSensitive || redact; } catch (e) { /* opcional */ }

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* sem disco: só console */ }
}

function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_FILE_BYTES) return;
    for (let i = MAX_ROTATED - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch (e) { /* arquivo ainda não existe */ }
}

function formatError(err) {
  if (!err) return '';
  if (err instanceof Error) return `${err.name}: ${err.message}${err.stack ? `\n${err.stack.split('\n').slice(1, 6).join('\n')}` : ''}`;
  if (typeof err === 'object') {
    try { return JSON.stringify(err); } catch (e) { return String(err); }
  }
  return String(err);
}

function appendLine(fileName, line) {
  ensureDir();
  const file = path.join(LOG_DIR, fileName);
  rotateIfNeeded(file);
  try { fs.appendFileSync(file, redact(line) + '\n'); } catch (e) { /* sem disco: só console */ }
}

function write(level, scope, message, err) {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${message}${err ? ` | ${formatError(err)}` : ''}`;
  appendLine('server.log', line);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (DEBUG) console.log(line);
}

function createLogger(scope) {
  return {
    debug: (msg, err) => { if (DEBUG) write('debug', scope, msg, err); },
    info: (msg, err) => write('info', scope, msg, err),
    warn: (msg, err) => write('warn', scope, msg, err),
    error: (msg, err) => write('error', scope, msg, err)
  };
}

// ---- Falhas silenciosas (antigos catch vazios) ---------------------------
const swallowedCounts = new Map();
const swallowedLastLog = new Map();

function swallowed(err, where) {
  const key = where || 'desconhecido';
  const entry = swallowedCounts.get(key) || { count: 0, last: '', lastAt: 0 };
  entry.count++;
  entry.lastAt = Date.now();
  entry.last = err && err.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200);
  swallowedCounts.set(key, entry);
  if (!DEBUG) return;
  // No máximo 1 linha por local a cada 60 s para não inundar o log
  const prev = swallowedLastLog.get(key) || 0;
  if (Date.now() - prev < 60000) return;
  swallowedLastLog.set(key, Date.now());
  write('debug', 'swallowed', `${key} (x${entry.count})`, err);
}

function getSwallowedStats(limit = 50) {
  return Array.from(swallowedCounts.entries())
    .map(([where, v]) => ({ where, count: v.count, last: v.last, lastAt: new Date(v.lastAt).toISOString() }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

module.exports = {
  LOG_DIR,
  DEBUG,
  createLogger,
  appendLine,
  formatError,
  swallowed,
  getSwallowedStats
};
