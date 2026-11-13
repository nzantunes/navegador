const zlib = require('zlib');

/**
 * Envia respostas dinâmicas (HTML/JSON/JS) com compressão Brotli ou Gzip
 * quando suportado pelo cliente e acima de minBytes, preservando cabeçalhos.
 */
function sendCompressed(req, res, statusCode, headers, body, { minBytes = 1024 } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
  const outHeaders = { ...(headers || {}), 'Vary': 'Accept-Encoding' };
  const acceptEncoding = String((req && req.headers && req.headers['accept-encoding']) || '').toLowerCase();

  if (buf.length < minBytes || outHeaders['Content-Encoding'] || outHeaders['content-encoding']) {
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
    zlib.brotliCompress(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4
      }
    }, (err, out) => finish(err, out, 'br'));
    return;
  }

  if (acceptEncoding.includes('gzip')) {
    zlib.gzip(buf, { level: 6 }, (err, out) => finish(err, out, 'gzip'));
    return;
  }

  outHeaders['Content-Length'] = buf.length;
  res.writeHead(statusCode, outHeaders);
  res.end(buf);
}

module.exports = { sendCompressed };
