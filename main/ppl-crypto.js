'use strict';

const crypto = require('crypto');
let pplRuntime = null;
try { pplRuntime = require('../papaleguas-lang/runtime'); } catch (e) {}

const MASK_64 = (1n << 64n) - 1n;

function jsKeystreamByte(nonce, idx) {
  const seed = (BigInt(nonce >>> 0) ^ 0x50504C5F32303236n) & MASK_64;
  let z = (seed + (((BigInt(idx) + 1n) * 0x9E3779B97F4A7C15n) & MASK_64)) & MASK_64;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK_64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK_64;
  z = (z ^ (z >> 31n)) & MASK_64;
  return Number(z & 0xFFn);
}

function getKeystreamFn() {
  const mod = pplRuntime ? pplRuntime.loadNativeModule('client_guard') : null;
  if (mod && typeof mod.ppl_keystream_byte === 'function') {
    return (nonce, idx) => Number(mod.ppl_keystream_byte(nonce, idx)) & 0xFF;
  }
  return jsKeystreamByte;
}

function computePplHash32(str) {
  try {
    const ceMod = pplRuntime ? pplRuntime.loadNativeModule('crypto_engine') : null;
    if (ceMod && typeof ceMod.derive_deterministic_nonce === 'function') {
      return Number(ceMod.derive_deterministic_nonce(String(str || ''))) >>> 0;
    }
    const idxMod = pplRuntime ? pplRuntime.loadNativeModule('search_index') : null;
    if (idxMod && typeof idxMod.url_hash_fnv1a === 'function') {
      const h = BigInt(idxMod.url_hash_fnv1a(String(str || '')));
      return Number((h ^ (h >> 32n)) & 0xFFFFFFFFn) >>> 0;
    }
  } catch (e) {}
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

const deterministicTokenCache = new Map();

function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
  const b64 = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return Buffer.from(b64 + pad, 'base64');
}

function encryptPplPayload(payload, options) {
  const jsonStr = JSON.stringify(payload || {});
  const useDeterministic = Boolean(
    (options && options.deterministic === true) ||
    ((!options || options.deterministic !== false) && payload && typeof payload === 'object' && payload.u && !payload._t)
  );
  if (useDeterministic) {
    const hit = deterministicTokenCache.get(jsonStr);
    if (hit) return hit;
  }
  const nonce = useDeterministic
    ? computePplHash32(jsonStr)
    : crypto.randomBytes(4).readUInt32BE(0);
  const plain = Buffer.from(jsonStr, 'utf8');
  const ksByte = getKeystreamFn();
  const out = Buffer.allocUnsafe(plain.length);
  for (let i = 0; i < plain.length; i++) {
    out[i] = plain[i] ^ ksByte(nonce, i);
  }
  const token = `${nonce.toString(16).padStart(8, '0')}.${toBase64Url(out)}`;
  if (useDeterministic) {
    if (deterministicTokenCache.size >= 1500) {
      const oldest = deterministicTokenCache.keys().next().value;
      deterministicTokenCache.delete(oldest);
    }
    deterministicTokenCache.set(jsonStr, token);
  }
  return token;
}

function decryptPplPayload(token) {
  try {
    const raw = String(token || '').trim();
    const ceMod = pplRuntime ? pplRuntime.loadNativeModule('crypto_engine') : null;
    if (ceMod && typeof ceMod.is_valid_ppl_token === 'function' && !ceMod.is_valid_ppl_token(raw)) {
      return null;
    }
    const dot = raw.indexOf('.');
    if (dot <= 0) return null;
    const nonceHex = raw.slice(0, dot);
    if (!/^[0-9a-fA-F]{1,8}$/.test(nonceHex)) return null;
    const nonce = parseInt(nonceHex, 16) >>> 0;
    const cipher = fromBase64Url(raw.slice(dot + 1));
    if (!cipher || cipher.length === 0 || cipher.length > 65536) return null;
    const ksByte = getKeystreamFn();
    const out = Buffer.allocUnsafe(cipher.length);
    for (let i = 0; i < cipher.length; i++) {
      out[i] = cipher[i] ^ ksByte(nonce, i);
    }
    const parsed = JSON.parse(out.toString('utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (e) {
    return null;
  }
}

function hydrateRequestWithPpl(reqUrl, body) {
  if (reqUrl && reqUrl.searchParams && reqUrl.searchParams.has('ppl')) {
    const token = reqUrl.searchParams.get('ppl');
    const data = decryptPplPayload(token);
    if (data) {
      reqUrl.searchParams.delete('ppl');
      for (const [k, v] of Object.entries(data)) {
        if (v !== undefined && v !== null) {
          reqUrl.searchParams.set(k, String(v));
        }
      }
    }
  }
  if (body && typeof body === 'object' && typeof body.ppl === 'string') {
    const data = decryptPplPayload(body.ppl);
    if (data) {
      delete body.ppl;
      Object.assign(body, data);
    }
  }
}

module.exports = {
  jsKeystreamByte,
  encryptPplPayload,
  decryptPplPayload,
  hydrateRequestWithPpl
};
