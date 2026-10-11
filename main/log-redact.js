'use strict';

function redactSensitive(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value == null ? '' : value);
  return text
    .replace(/(?:https?|file|wss?|socks5?):\/\/[^\s'")\]}>]+/gi, '[url]')
    .replace(/\b[a-z2-7]{16,63}\.onion(?:\/[^\s'")\]}>]*)?/gi, '[onion]')
    .replace(/\b(authorization|proxy-authorization)\b\s*[:=]\s*(?:bearer|basic)\s+\S+/gi, '$1=[oculto]')
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\b\s*[:=]\s*\S+/gi, '$1=[oculto]')
    .replace(/\b(bearer|basic)\s+\S+/gi, '$1 [oculto]')
    .replace(/\bcli_[a-z0-9_]+/gi, '[cliente]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[chave]')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[email]');
}

function wrapStream(stream) {
  if (!stream || stream.__plRedacted) return;
  const orig = stream.write.bind(stream);
  stream.write = function (chunk, encoding, cb) {
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    let out = chunk;
    try {
      const clean = redactSensitive(chunk);
      const original = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (clean !== original) out = clean;
    } catch (e) {}
    if (encoding) return orig(out, encoding, cb);
    return orig(out, cb);
  };
  stream.__plRedacted = true;
}

function installLogRedaction() {
  if (global.__plLogRedactionInstalled) return;
  global.__plLogRedactionInstalled = true;
  wrapStream(process.stdout);
  wrapStream(process.stderr);
}

module.exports = { installLogRedaction, redactSensitive };
