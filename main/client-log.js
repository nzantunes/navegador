'use strict';
// =========================================================================
// PAPALÉGUAS - RECEPTOR DE ERROS DOS APARELHOS (/api/client-log)
// =========================================================================
// Recebe os erros capturados por src/error-reporter.js (celulares, PWA,
// navegador) e grava em data/logs/client-errors.log. Corpo limitado a 16 KB,
// campos truncados e dados sensíveis mascarados pelo logger.

const { appendLine } = require('./logger');

const MAX_BODY_BYTES = 16 * 1024;

function clip(value, max) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').slice(0, max);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
  });
}

/**
 * Trata POST /api/client-log. Sempre responde 204 (o cliente não precisa saber
 * se o log foi aceito e não deve tentar de novo).
 */
async function handleClientLog(req, res, requesterIp) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  const raw = await readBody(req);
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
  if (!raw) return;

  let payload;
  try { payload = JSON.parse(raw); } catch (e) { return; }
  const entries = Array.isArray(payload && payload.errors) ? payload.errors.slice(0, 20) : [payload];
  const ua = clip(req.headers['user-agent'], 160);
  const ip = clip(requesterIp, 64);

  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const line = [
      new Date().toISOString(),
      `[${clip(item.kind || 'error', 20)}]`,
      `page=${clip(item.page, 80)}`,
      `v=${clip(item.version, 40)}`,
      `msg=${clip(item.message, 500)}`,
      item.source ? `at=${clip(item.source, 160)}:${clip(item.line, 8)}:${clip(item.col, 8)}` : '',
      item.stack ? `stack=${clip(item.stack, 1200)}` : '',
      item.count > 1 ? `x${clip(item.count, 6)}` : '',
      `ip=${ip}`,
      `ua=${ua}`
    ].filter(Boolean).join(' ');
    appendLine('client-errors.log', line);
  }
}

module.exports = { handleClientLog };
