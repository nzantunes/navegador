'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'papaleguas', 'data');
const DB_PATH = path.join(DATA_DIR, 'downloads.sqlite');
const FALLBACK_JSON_PATH = path.join(DATA_DIR, 'app_downloads.json');

let db = null;
let dbEngine = 'JSON';

function normalizeOs(rawOs, userAgent = '') {
  const s = String(rawOs || '').toLowerCase().trim();
  if (s === 'windows' || s === 'win' || s === 'win32' || s === 'win64') return 'windows';
  if (s === 'android') return 'android';
  if (s === 'ios' || s === 'iphone' || s === 'ipad') return 'ios';
  if (s === 'linux' || s === 'ubuntu' || s === 'debian') return 'linux';
  if (s === 'macos' || s === 'mac' || s === 'darwin' || s === 'osx') return 'macos';

  const ua = String(userAgent || '').toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os x') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'other';
}

function initDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        os TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'download_app',
        ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_downloads_os ON app_downloads(os);
      CREATE INDEX IF NOT EXISTS idx_app_downloads_created ON app_downloads(created_at DESC);
    `);
    dbEngine = 'SQLite (node:sqlite)';
    return db;
  } catch (err) {
    db = null;
    dbEngine = 'JSON-Fallback';
    return null;
  }
}

function readFallbackList() {
  try {
    if (fs.existsSync(FALLBACK_JSON_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(FALLBACK_JSON_PATH, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  return [];
}

function writeFallbackList(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FALLBACK_JSON_PATH, JSON.stringify(list.slice(-2000), null, 2), 'utf8');
  } catch (e) {}
}

function recordDownload({ os, source = 'download_app', ip = '', userAgent = '' } = {}) {
  const cleanOs = normalizeOs(os, userAgent);
  const cleanSource = String(source || 'download_app').slice(0, 48);
  const cleanIp = String(ip || '').replace(/^::ffff:/, '').slice(0, 64);
  const cleanUa = String(userAgent || '').slice(0, 240);
  const createdAt = new Date().toISOString();

  const conn = initDb();
  if (conn) {
    try {
      const stmt = conn.prepare(
        'INSERT INTO app_downloads (os, source, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?)'
      );
      const info = stmt.run(cleanOs, cleanSource, cleanIp, cleanUa, createdAt);
      return {
        ok: true,
        id: Number(info.lastInsertRowid || 0),
        os: cleanOs,
        source: cleanSource,
        ip: cleanIp,
        created_at: createdAt,
        dbEngine
      };
    } catch (e) {}
  }

  const list = readFallbackList();
  const entry = {
    id: list.length + 1,
    os: cleanOs,
    source: cleanSource,
    ip: cleanIp,
    user_agent: cleanUa,
    created_at: createdAt
  };
  list.push(entry);
  writeFallbackList(list);
  return { ok: true, ...entry, dbEngine };
}

function getStats(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const byOs = { windows: 0, android: 0, ios: 0, linux: 0, macos: 0, other: 0 };
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const conn = initDb();
  if (conn) {
    try {
      const totalRow = conn.prepare('SELECT COUNT(*) AS cnt FROM app_downloads').get();
      const last24Row = conn.prepare('SELECT COUNT(*) AS cnt FROM app_downloads WHERE created_at >= ?').get(since24h);
      const osRows = conn.prepare('SELECT os, COUNT(*) AS cnt FROM app_downloads GROUP BY os').all();
      for (const r of osRows) {
        const k = (r.os in byOs) ? r.os : 'other';
        byOs[k] += Number(r.cnt || 0);
      }
      const recent = conn.prepare(
        'SELECT id, os, source, ip, user_agent, created_at FROM app_downloads ORDER BY id DESC LIMIT ?'
      ).all(safeLimit);

      return {
        ok: true,
        total: Number((totalRow && totalRow.cnt) || 0),
        last24h: Number((last24Row && last24Row.cnt) || 0),
        byOs,
        recent,
        dbEngine,
        dbFile: 'papaleguas/data/downloads.sqlite'
      };
    } catch (e) {}
  }

  const list = readFallbackList();
  let last24h = 0;
  for (const item of list) {
    const k = (item && item.os in byOs) ? item.os : 'other';
    byOs[k] += 1;
    if (item && item.created_at >= since24h) last24h += 1;
  }
  return {
    ok: true,
    total: list.length,
    last24h,
    byOs,
    recent: list.slice(-safeLimit).reverse(),
    dbEngine,
    dbFile: 'papaleguas/data/app_downloads.json'
  };
}

function clearAll() {
  const conn = initDb();
  if (conn) {
    try {
      conn.exec('DELETE FROM app_downloads;');
      return { ok: true, cleared: true, dbEngine };
    } catch (e) {}
  }
  writeFallbackList([]);
  return { ok: true, cleared: true, dbEngine };
}

module.exports = {
  normalizeOs,
  recordDownload,
  getStats,
  clearAll,
  DB_PATH
};
