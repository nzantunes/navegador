const zlib = require('zlib');

let autoTunerPpl = null;
let privacyShieldPpl = null;
try {
  const pplRuntime = require('../papaleguas-lang/runtime');
  autoTunerPpl = pplRuntime.loadNativeModule('auto_tuner');
  privacyShieldPpl = pplRuntime.loadNativeModule('privacy_shield');
} catch (e) {
  autoTunerPpl = null;
  privacyShieldPpl = null;
}

function isLocalLanRequest(req) {
  if (!req) return false;
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return false;
  const addr = String((req.socket && req.socket.remoteAddress) || '');
  if (privacyShieldPpl && typeof privacyShieldPpl.is_private_or_lan_ip === 'function') {
    try { return Boolean(privacyShieldPpl.is_private_or_lan_ip(addr)); } catch (e) {}
  }
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr.startsWith('::ffff:127.') ||
    addr.startsWith('192.168.') ||
    addr.startsWith('::ffff:192.168.') ||
    addr.startsWith('10.') ||
    addr.startsWith('::ffff:10.')
  );
}

/**
 * Envia respostas dinâmicas (HTML/JSON/JS) com compressão Brotli ou Gzip
 * ajustada dinamicamente em PPL (auto_tuner.choose_compression_level).
 */
function sendCompressed(req, res, statusCode, headers, body, { minBytes = 1024 } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
  const outHeaders = { ...(headers || {}), 'Vary': 'Accept-Encoding' };
  const acceptEncoding = String((req && req.headers && req.headers['accept-encoding']) || '').toLowerCase();

  const isLocal = isLocalLanRequest(req);
  let pplLevel = 4;
  if (autoTunerPpl && typeof autoTunerPpl.choose_compression_level === 'function') {
    try {
      pplLevel = Number(autoTunerPpl.choose_compression_level(buf.length, isLocal, 20));
    } catch (e) {
      pplLevel = 4;
    }
  }

  if (buf.length < minBytes || pplLevel === 0 || outHeaders['Content-Encoding'] || outHeaders['content-encoding']) {
    outHeaders['Content-Length'] = buf.length;
    res.writeHead(statusCode, outHeaders);
    res.end(buf);
    return;
  }

  const finish = (err, encodedBuf, encodingName) => {
    if (err || !encodedBuf || encodedBuf.length >= buf.length) {
      outHeaders['Content-Length'] = buf.length;
      res.writeHead(statusCode, outHeaders);
      res.end(buf);
      return;
    }
    outHeaders['Content-Encoding'] = encodingName;
    outHeaders['Content-Length'] = encodedBuf.length;
    res.writeHead(statusCode, outHeaders);
    res.end(encodedBuf);
  };

  if (acceptEncoding.includes('br') && typeof zlib.brotliCompress === 'function') {
    const brQuality = Math.min(6, Math.max(1, pplLevel || 4));
    zlib.brotliCompress(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: brQuality
      }
    }, (err, out) => finish(err, out, 'br'));
    return;
  }

  if (acceptEncoding.includes('gzip')) {
    const gzLevel = Math.min(6, Math.max(1, pplLevel || 6));
    zlib.gzip(buf, { level: gzLevel }, (err, out) => finish(err, out, 'gzip'));
    return;
  }

  outHeaders['Content-Length'] = buf.length;
  res.writeHead(statusCode, outHeaders);
  res.end(buf);
}

module.exports = { sendCompressed };
