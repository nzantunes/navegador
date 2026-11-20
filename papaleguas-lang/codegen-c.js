'use strict';

/**
 * Gerador de Código Nativo C11 (Direct-to-Hardware) da Linguagem Papaléguas (.ppl)
 * Emite C11 seguro com proteção de divisão por zero, limite de iterações e
 * intrínsecas diretas de hardware Linux (CPU, RAM, CLOCK_MONOTONIC, FNV-1a).
 */

function parseArrayType(t) {
  const m = typeof t === 'string' && t.match(/^\[(\d+)\](.+)$/);
  return m ? { size: Number(m[1]), elemType: m[2] } : null;
}

function sanitizeArrayTypedefName(t) {
  return 'ppl_arr_' + String(t).replace(/[^a-zA-Z0-9]/g, '_');
}

function mapType(pplType, structSet) {
  const arr = parseArrayType(pplType);
  if (arr) return sanitizeArrayTypedefName(pplType);
  if (structSet && structSet.has(pplType)) return `ppl_s_${pplType}`;
  switch (pplType) {
    case 'u64': return 'uint64_t';
    case 'i64': return 'int64_t';
    case 'f64': return 'double';
    case 'bool': return 'bool';
    case 'str': return 'const char*';
    case 'void': return 'void';
    default: return 'uint64_t';
  }
}

function escapeCString(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function generateC(ast, verificationResult, options = {}) {
  const mode = options.mode === 'napi' ? 'napi' : 'cli';
  const lines = [];
  const modulePolicy = (verificationResult && verificationResult.policy) || {};
  const defaultMaxLoops = Number(modulePolicy.max_loops) > 0 ? Number(modulePolicy.max_loops) : 1000000;
  const structSet = new Set((ast.structs || []).map((s) => s.name));
  const enumSet = new Set((ast.enums || []).map((e) => e.name));
  const arrayTypeDefs = new Map();

  function registerArrayType(t) {
    const arr = parseArrayType(t);
    if (!arr) return;
    registerArrayType(arr.elemType);
    if (!arrayTypeDefs.has(t)) arrayTypeDefs.set(t, arr);
  }
  function scanStmtTypes(stmt) {
    if (!stmt) return;
    if (stmt.varType) registerArrayType(stmt.varType);
    if (stmt.init && stmt.init.type === 'ArrayLiteral') {
      // also registered via varType or inferred length
    }
    if (stmt.consequent) (stmt.consequent.stmts || []).forEach(scanStmtTypes);
    if (stmt.alternate) {
      if (stmt.alternate.type === 'Block') (stmt.alternate.stmts || []).forEach(scanStmtTypes);
      else scanStmtTypes(stmt.alternate);
    }
    if (stmt.body && stmt.body.stmts) stmt.body.stmts.forEach(scanStmtTypes);
  }
  for (const s of ast.structs || []) {
    for (const f of s.fields || []) registerArrayType(f.fieldType);
  }
  for (const c of ast.consts || []) registerArrayType(c.varType);
  for (const fn of ast.functions || []) {
    registerArrayType(fn.returnType);
    for (const p of fn.params || []) registerArrayType(p.paramType);
    if (fn.body && fn.body.stmts) fn.body.stmts.forEach(scanStmtTypes);
  }

  lines.push('/* Código nativo gerado automaticamente pelo Compilador Papaléguas (.ppl) */');
  lines.push('#define _POSIX_C_SOURCE 200809L');
  lines.push('#include <stdint.h>');
  lines.push('#include <stdbool.h>');
  lines.push('#include <stdio.h>');
  lines.push('#include <stdlib.h>');
  lines.push('#include <string.h>');
  lines.push('#include <time.h>');
  lines.push('#include <unistd.h>');
  lines.push('#ifdef __linux__');
  lines.push('#include <sys/sysinfo.h>');
  lines.push('#endif');
  lines.push('#include <sys/socket.h>');
  lines.push('#include <netinet/in.h>');
  lines.push('#include <arpa/inet.h>');
  lines.push('#include <signal.h>');
  lines.push('#include <pthread.h>');
  lines.push('#include <stdatomic.h>');
  lines.push('#include <limits.h>');
  lines.push('#include <netdb.h>');
  lines.push('#include <sys/time.h>');
  const usesTorFetch = JSON.stringify(ast).includes('"net.tor_fetch"');
  const usesTorAlive = JSON.stringify(ast).includes('"net.tor_alive"');
  const usesClientIpBlocked = JSON.stringify(ast).includes('"net.client_ip_blocked"');
  const usesRelayImage = JSON.stringify(ast).includes('"net.relay_image"');
  const usesFetchMeta = JSON.stringify(ast).includes('"net.fetch_meta"');
  if (usesTorFetch || usesRelayImage || usesFetchMeta) {
    lines.push('#include <openssl/ssl.h>');
    lines.push('#include <openssl/err.h>');
  }
  if (mode === 'napi') {
    lines.push('#define NAPI_VERSION 8');
    lines.push('#include <node_api.h>');
  }
  lines.push('');

  // Intrínsecas diretas de hardware
  lines.push('static inline uint64_t ppl_hw_cpu_cores(void) {');
  lines.push('  long n = sysconf(_SC_NPROCESSORS_ONLN);');
  lines.push('  return n > 0 ? (uint64_t)n : 1ULL;');
  lines.push('}');
  lines.push('');
  lines.push('static inline uint64_t ppl_hw_ram_total_mb(void) {');
  lines.push('#ifdef __linux__');
  lines.push('  struct sysinfo si;');
  lines.push('  if (sysinfo(&si) == 0) {');
  lines.push('    return ((uint64_t)si.totalram * (uint64_t)si.mem_unit) / (1024ULL * 1024ULL);');
  lines.push('  }');
  lines.push('#endif');
  lines.push('  return 0ULL;');
  lines.push('}');
  lines.push('');
  lines.push('static inline uint64_t ppl_hw_ram_free_mb(void) {');
  lines.push('#ifdef __linux__');
  lines.push('  struct sysinfo si;');
  lines.push('  if (sysinfo(&si) == 0) {');
  lines.push('    return ((uint64_t)si.freeram * (uint64_t)si.mem_unit) / (1024ULL * 1024ULL);');
  lines.push('  }');
  lines.push('#endif');
  lines.push('  return 0ULL;');
  lines.push('}');
  lines.push('');
  lines.push('static inline uint64_t ppl_hw_uptime_sec(void) {');
  lines.push('#ifdef __linux__');
  lines.push('  struct sysinfo si;');
  lines.push('  if (sysinfo(&si) == 0) return (uint64_t)si.uptime;');
  lines.push('#endif');
  lines.push('  return 0ULL;');
  lines.push('}');
  lines.push('');
  lines.push('static inline uint64_t ppl_hw_monotonic_ns(void) {');
  lines.push('  struct timespec ts;');
  lines.push('  if (clock_gettime(CLOCK_MONOTONIC, &ts) == 0) {');
  lines.push('    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;');
  lines.push('  }');
  lines.push('  return 0ULL;');
  lines.push('}');
  lines.push('');
  lines.push('static inline uint64_t ppl_hw_hash_fnv1a(const char* s) {');
  lines.push('  if (!s) return 0ULL;');
  lines.push('  uint64_t hash = 14695981039346656037ULL;');
  lines.push('  while (*s) {');
  lines.push('    hash ^= (uint8_t)(*s++);');
  lines.push('    hash *= 1099511628211ULL;');
  lines.push('  }');
  lines.push('  return hash;');
  lines.push('}');
  lines.push('');
  lines.push('static inline uint64_t ppl_clamp_u64(uint64_t v, uint64_t lo, uint64_t hi) {');
  lines.push('  return v < lo ? lo : (v > hi ? hi : v);');
  lines.push('}');
  lines.push('static inline int64_t ppl_clamp_i64(int64_t v, int64_t lo, int64_t hi) {');
  lines.push('  return v < lo ? lo : (v > hi ? hi : v);');
  lines.push('}');
  lines.push('static inline uint64_t ppl_abs_i64(int64_t v) {');
  lines.push('  return v < 0 ? (uint64_t)(-(v + 1)) + 1ULL : (uint64_t)v;');
  lines.push('}');
  lines.push('static inline uint64_t ppl_min_u64(uint64_t a, uint64_t b) { return a < b ? a : b; }');
  lines.push('static inline uint64_t ppl_max_u64(uint64_t a, uint64_t b) { return a > b ? a : b; }');
  lines.push('static inline int64_t ppl_min_i64(int64_t a, int64_t b) { return a < b ? a : b; }');
  lines.push('static inline int64_t ppl_max_i64(int64_t a, int64_t b) { return a > b ? a : b; }');
  lines.push('');
  lines.push('static inline uint64_t ppl_safe_div_u64(uint64_t a, uint64_t b) { return b == 0 ? 0 : a / b; }');
  lines.push('static inline double ppl_safe_div_f64(double a, double b) { return b == 0.0 ? 0.0 : a / b; }');
  lines.push('static inline uint64_t ppl_safe_mod_u64(uint64_t a, uint64_t b) { return b == 0 ? 0 : a % b; }');
  lines.push('static inline uint64_t ppl_math_pct_u64(uint64_t part, uint64_t total) { return total == 0 ? 0ULL : (part * 100ULL) / total; }');
  lines.push('static inline uint64_t ppl_math_pow_u64(uint64_t base, uint64_t exp) {');
  lines.push('  uint64_t r = 1ULL;');
  lines.push('  uint64_t b = base;');
  lines.push('  uint64_t e = exp > 63ULL ? 63ULL : exp;');
  lines.push('  while (e > 0ULL) { if (e & 1ULL) r *= b; b *= b; e >>= 1ULL; }');
  lines.push('  return r;');
  lines.push('}');
  lines.push('static inline uint64_t ppl_str_len(const char* s) { return s ? (uint64_t)strlen(s) : 0ULL; }');
  lines.push('static inline bool ppl_str_is_empty(const char* s) { return (!s || !*s); }');
  lines.push('static inline bool ppl_str_contains(const char* h, const char* n) { return (h && n && *n) ? strstr(h, n) != NULL : false; }');
  lines.push('static inline bool ppl_str_starts_with(const char* s, const char* p) { return (s && p) ? strncmp(s, p, strlen(p)) == 0 : false; }');
  lines.push('static inline bool ppl_str_starts_with_ci(const char* s, const char* p) {');
  lines.push('  if (!s || !p) return false;');
  lines.push('  for (size_t i = 0; p[i]; i++) {');
  lines.push('    unsigned char a = (unsigned char)s[i], b = (unsigned char)p[i];');
  lines.push('    if (!a) return false;');
  lines.push('    if (a >= \'A\' && a <= \'Z\') a = (unsigned char)(a + 32);');
  lines.push('    if (b >= \'A\' && b <= \'Z\') b = (unsigned char)(b + 32);');
  lines.push('    if (a != b) return false;');
  lines.push('  }');
  lines.push('  return true;');
  lines.push('}');
  lines.push('static inline bool ppl_str_ends_with(const char* s, const char* suf) {');
  lines.push('  if (!s || !suf) return false;');
  lines.push('  size_t ls = strlen(s), lsf = strlen(suf);');
  lines.push('  return ls >= lsf && memcmp(s + ls - lsf, suf, lsf) == 0;');
  lines.push('}');
  lines.push('static inline bool ppl_str_ends_with_ci(const char* s, const char* suf) {');
  lines.push('  if (!s || !suf) return false;');
  lines.push('  size_t ls = strlen(s), lsf = strlen(suf);');
  lines.push('  if (ls < lsf) return false;');
  lines.push('  const char* tail = s + (ls - lsf);');
  lines.push('  for (size_t i = 0; i < lsf; i++) {');
  lines.push('    unsigned char a = (unsigned char)tail[i], b = (unsigned char)suf[i];');
  lines.push('    if (a >= \'A\' && a <= \'Z\') a = (unsigned char)(a + 32);');
  lines.push('    if (b >= \'A\' && b <= \'Z\') b = (unsigned char)(b + 32);');
  lines.push('    if (a != b) return false;');
  lines.push('  }');
  lines.push('  return true;');
  lines.push('}');
  lines.push('static inline bool ppl_str_equals_ci(const char* a, const char* b) {');
  lines.push('  if (!a || !b) return a == b;');
  lines.push('  size_t i = 0;');
  lines.push('  for (; a[i] && b[i]; i++) {');
  lines.push('    unsigned char ca = (unsigned char)a[i], cb = (unsigned char)b[i];');
  lines.push('    if (ca >= \'A\' && ca <= \'Z\') ca = (unsigned char)(ca + 32);');
  lines.push('    if (cb >= \'A\' && cb <= \'Z\') cb = (unsigned char)(cb + 32);');
  lines.push('    if (ca != cb) return false;');
  lines.push('  }');
  lines.push('  return a[i] == \'\\0\' && b[i] == \'\\0\';');
  lines.push('}');
  lines.push('static inline uint64_t ppl_str_hash_fnv1a_ci(const char* s) {');
  lines.push('  uint64_t h = 14695981039346656037ULL;');
  lines.push('  if (!s) return h;');
  lines.push('  for (const unsigned char* p = (const unsigned char*)s; *p; p++) {');
  lines.push('    unsigned char c = *p;');
  lines.push('    if (c >= \'A\' && c <= \'Z\') c = (unsigned char)(c + 32);');
  lines.push('    h ^= (uint64_t)c;');
  lines.push('    h *= 1099511628211ULL;');
  lines.push('  }');
  lines.push('  return h;');
  lines.push('}');
  lines.push('static inline int64_t ppl_str_index_of(const char* h, const char* n) {');
  lines.push('  if (!h || !n) return -1LL;');
  lines.push('  if (!*n) return 0LL;');
  lines.push('  const char* p = strstr(h, n);');
  lines.push('  return p ? (int64_t)(p - h) : -1LL;');
  lines.push('}');
  lines.push('static inline uint64_t ppl_str_count(const char* h, const char* n) {');
  lines.push('  if (!h || !n || !*n) return 0ULL;');
  lines.push('  size_t nl = strlen(n);');
  lines.push('  uint64_t c = 0;');
  lines.push('  const char* p = h;');
  lines.push('  while ((p = strstr(p, n)) != NULL) { c++; p += nl; }');
  lines.push('  return c;');
  lines.push('}');
  lines.push('static inline bool ppl_str_is_ascii_alnum(const char* s) {');
  lines.push('  if (!s || !*s) return false;');
  lines.push('  for (size_t i = 0; s[i]; i++) {');
  lines.push('    unsigned char c = (unsigned char)s[i];');
  lines.push('    bool ok = (c >= \'0\' && c <= \'9\') || (c >= \'A\' && c <= \'Z\') || (c >= \'a\' && c <= \'z\') || c == \'_\' || c == \'-\';');
  lines.push('    if (!ok) return false;');
  lines.push('  }');
  lines.push('  return true;');
  lines.push('}');
  lines.push('static inline bool ppl_str_contains_ci(const char* h, const char* n) {');
  lines.push('  if (!h || !n || !*n) return false;');
  lines.push('  size_t nl = strlen(n);');
  lines.push('  for (size_t i = 0; h[i]; i++) {');
  lines.push('    size_t j = 0;');
  lines.push('    while (j < nl && h[i + j]) {');
  lines.push('      unsigned char a = (unsigned char)h[i + j];');
  lines.push('      unsigned char b = (unsigned char)n[j];');
  lines.push('      if (a >= \'A\' && a <= \'Z\') a = (unsigned char)(a + 32);');
  lines.push('      if (b >= \'A\' && b <= \'Z\') b = (unsigned char)(b + 32);');
  lines.push('      if (a != b) break;');
  lines.push('      j++;');
  lines.push('    }');
  lines.push('    if (j == nl) return true;');
  lines.push('  }');
  lines.push('  return false;');
  lines.push('}');
  lines.push('static const char* ppl_str_to_upper(const char* s) {');
  lines.push('  static _Thread_local char bufs[8][8192];');
  lines.push('  static _Thread_local int slot = 0;');
  lines.push('  char* out = bufs[slot]; slot = (slot + 1) & 7;');
  lines.push('  if (!s) { out[0] = \'\\0\'; return out; }');
  lines.push('  size_t i = 0;');
  lines.push('  for (; s[i] && i < 8191; i++) {');
  lines.push('    unsigned char c = (unsigned char)s[i];');
  lines.push('    out[i] = (char)(c >= \'a\' && c <= \'z\' ? (c - 32) : c);');
  lines.push('  }');
  lines.push('  out[i] = \'\\0\';');
  lines.push('  return out;');
  lines.push('}');
  lines.push('static const char* ppl_str_to_lower(const char* s) {');
  lines.push('  static _Thread_local char bufs[8][8192];');
  lines.push('  static _Thread_local int slot = 0;');
  lines.push('  char* out = bufs[slot]; slot = (slot + 1) & 7;');
  lines.push('  if (!s) { out[0] = \'\\0\'; return out; }');
  lines.push('  size_t i = 0;');
  lines.push('  for (; s[i] && i < 8191; i++) {');
  lines.push('    unsigned char c = (unsigned char)s[i];');
  lines.push('    out[i] = (char)(c >= \'A\' && c <= \'Z\' ? (c + 32) : c);');
  lines.push('  }');
  lines.push('  out[i] = \'\\0\';');
  lines.push('  return out;');
  lines.push('}');
  lines.push('static const char* ppl_str_trim(const char* s) {');
  lines.push('  static _Thread_local char bufs[8][8192];');
  lines.push('  static _Thread_local int slot = 0;');
  lines.push('  char* out = bufs[slot]; slot = (slot + 1) & 7;');
  lines.push('  if (!s) { out[0] = \'\\0\'; return out; }');
  lines.push('  size_t len = strlen(s);');
  lines.push('  size_t start = 0;');
  lines.push('  while (start < len && (s[start] == \' \' || s[start] == \'\\t\' || s[start] == \'\\r\' || s[start] == \'\\n\')) start++;');
  lines.push('  size_t end = len;');
  lines.push('  while (end > start && (s[end - 1] == \' \' || s[end - 1] == \'\\t\' || s[end - 1] == \'\\r\' || s[end - 1] == \'\\n\')) end--;');
  lines.push('  size_t n = end - start;');
  lines.push('  if (n > 8191) n = 8191;');
  lines.push('  if (n > 0) memcpy(out, s + start, n);');
  lines.push('  out[n] = \'\\0\';');
  lines.push('  return out;');
  lines.push('}');
  lines.push('static const char* ppl_str_slice(const char* s, uint64_t start, uint64_t end) {');
  lines.push('  static _Thread_local char bufs[8][8192];');
  lines.push('  static _Thread_local int slot = 0;');
  lines.push('  char* out = bufs[slot]; slot = (slot + 1) & 7;');
  lines.push('  if (!s) { out[0] = \'\\0\'; return out; }');
  lines.push('  uint64_t len = (uint64_t)strlen(s);');
  lines.push('  if (start > len) start = len;');
  lines.push('  if (end > len) end = len;');
  lines.push('  if (start >= end) { out[0] = \'\\0\'; return out; }');
  lines.push('  uint64_t n = end - start;');
  lines.push('  if (n > 8191) n = 8191;');
  lines.push('  memcpy(out, s + start, (size_t)n);');
  lines.push('  out[n] = \'\\0\';');
  lines.push('  return out;');
  lines.push('}');
  lines.push('static const char* ppl_str_replace(const char* s, const char* from, const char* to) {');
  lines.push('  static _Thread_local char bufs[8][8192];');
  lines.push('  static _Thread_local int slot = 0;');
  lines.push('  char* out = bufs[slot]; slot = (slot + 1) & 7;');
  lines.push('  if (!s) { out[0] = \'\\0\'; return out; }');
  lines.push('  if (!from || !*from) { size_t l = strlen(s); if (l > 8191) l = 8191; memcpy(out, s, l); out[l] = \'\\0\'; return out; }');
  lines.push('  const char* rep = to ? to : "";');
  lines.push('  size_t flen = strlen(from), rlen = strlen(rep), w = 0;');
  lines.push('  const char* cur = s;');
  lines.push('  while (*cur && w < 8191) {');
  lines.push('    const char* hit = strstr(cur, from);');
  lines.push('    if (!hit) {');
  lines.push('      size_t rem = strlen(cur);');
  lines.push('      if (w + rem > 8191) rem = 8191 - w;');
  lines.push('      memcpy(out + w, cur, rem); w += rem; break;');
  lines.push('    }');
  lines.push('    size_t pre = (size_t)(hit - cur);');
  lines.push('    if (w + pre > 8191) pre = 8191 - w;');
  lines.push('    if (pre > 0) { memcpy(out + w, cur, pre); w += pre; }');
  lines.push('    size_t cp = rlen;');
  lines.push('    if (w + cp > 8191) cp = 8191 - w;');
  lines.push('    if (cp > 0) { memcpy(out + w, rep, cp); w += cp; }');
  lines.push('    cur = hit + flen;');
  lines.push('  }');
  lines.push('  out[w] = \'\\0\';');
  lines.push('  return out;');
  lines.push('}');
  lines.push('static inline bool ppl_str_eq(const char* a, const char* b) { return (a && b) ? strcmp(a, b) == 0 : (a == b); }');
  lines.push('static const char* ppl_str_concat(const char* a, const char* b) {');
  lines.push('  static _Thread_local char bufs[16][8192];');
  lines.push('  static _Thread_local int slot = 0;');
  lines.push('  char* out = bufs[slot]; slot = (slot + 1) & 15;');
  lines.push('  size_t la = a ? strlen(a) : 0;');
  lines.push('  if (la >= 8191) la = 8191;');
  lines.push('  if (a && la > 0) memcpy(out, a, la);');
  lines.push('  size_t lb = b ? strlen(b) : 0;');
  lines.push('  if (la + lb >= 8191) lb = 8191 - la;');
  lines.push('  if (b && lb > 0) memcpy(out + la, b, lb);');
  lines.push('  out[la + lb] = \'\\0\';');
  lines.push('  return out;');
  lines.push('}');
  lines.push('static void ppl_print_json_str(const char* s) {');
  lines.push('  putchar(\'"\');');
  lines.push('  if (s) {');
  lines.push('    for (const char* p = s; *p; p++) {');
  lines.push('      if (*p == \'"\' || *p == \'\\\\\') { putchar(\'\\\\\'); putchar(*p); }');
  lines.push('      else if (*p == \'\\n\') { fputs("\\\\n", stdout); }');
  lines.push('      else if (*p == \'\\r\') { fputs("\\\\r", stdout); }');
  lines.push('      else putchar(*p);');
  lines.push('    }');
  lines.push('  }');
  lines.push('  putchar(\'"\');');
  lines.push('}');
  lines.push('static const char* ppl_str_from_u64(uint64_t v) {');
  lines.push('  static _Thread_local char bufs[4][32];');
  lines.push('  static _Thread_local int slot = 0;');
  lines.push('  char* out = bufs[slot]; slot = (slot + 1) & 3;');
  lines.push('  snprintf(out, 32, "%llu", (unsigned long long)v);');
  lines.push('  return out;');
  lines.push('}');
  lines.push('static uint64_t ppl_str_levenshtein(const char* a, const char* b) {');
  lines.push('  if (!a) a = "";');
  lines.push('  if (!b) b = "";');
  lines.push('  size_t la = strlen(a), lb = strlen(b);');
  lines.push('  if (la == 0) return (uint64_t)lb;');
  lines.push('  if (lb == 0) return (uint64_t)la;');
  lines.push('  if (la > 255) la = 255;');
  lines.push('  if (lb > 255) lb = 255;');
  lines.push('  uint16_t dp[256];');
  lines.push('  for (size_t j = 0; j <= lb; j++) dp[j] = (uint16_t)j;');
  lines.push('  for (size_t i = 1; i <= la; i++) {');
  lines.push('    uint16_t prev = dp[0];');
  lines.push('    dp[0] = (uint16_t)i;');
  lines.push('    for (size_t j = 1; j <= lb; j++) {');
  lines.push('      uint16_t tmp = dp[j];');
  lines.push('      uint16_t cost = (a[i - 1] == b[j - 1]) ? 0 : 1;');
  lines.push('      uint16_t del = (uint16_t)(dp[j] + 1);');
  lines.push('      uint16_t ins = (uint16_t)(dp[j - 1] + 1);');
  lines.push('      uint16_t sub = (uint16_t)(prev + cost);');
  lines.push('      uint16_t m = del < ins ? del : ins;');
  lines.push('      dp[j] = sub < m ? sub : m;');
  lines.push('      prev = tmp;');
  lines.push('    }');
  lines.push('  }');
  lines.push('  return (uint64_t)dp[lb];');
  lines.push('}');
  lines.push('static uint64_t ppl_str_upper_ratio_pct(const char* s) {');
  lines.push('  if (!s) return 0;');
  lines.push('  uint64_t letters = 0, upper = 0;');
  lines.push('  for (size_t i = 0; s[i]; i++) {');
  lines.push('    unsigned char c = (unsigned char)s[i];');
  lines.push('    if (c >= \'A\' && c <= \'Z\') { letters++; upper++; }');
  lines.push('    else if (c >= \'a\' && c <= \'z\') { letters++; }');
  lines.push('  }');
  lines.push('  if (letters < 12) return 0;');
  lines.push('  return (upper * 100ULL) / letters;');
  lines.push('}');
  lines.push('static const char* ppl_str_strip_html(const char* s) {');
  lines.push('  static _Thread_local char bufs[2][4096];');
  lines.push('  static _Thread_local int slot = 0;');
  lines.push('  char* out = bufs[slot]; slot = (slot + 1) & 1;');
  lines.push('  out[0] = \'\\0\';');
  lines.push('  if (!s || !*s) return out;');
  lines.push('  const char* start = s;');
  lines.push('  const char* end = s + strlen(s);');
  lines.push('  const char* last_leak = NULL;');
  lines.push('  for (const char* p = s; p + 1 < end; p++) {');
  lines.push('    if (p[0] == \'"\' && p[1] == \'>\') last_leak = p;');
  lines.push('  }');
  lines.push('  if (last_leak) {');
  lines.push('    const char* after = last_leak + 2;');
  lines.push('    while (after < end && (*after == \' \' || *after == \'\\t\' || *after == \'\\n\' || *after == \'\\r\')) after++;');
  lines.push('    size_t alen = (size_t)(end - after);');
  lines.push('    while (alen > 0 && (after[alen - 1] == \' \' || after[alen - 1] == \'\\t\' || after[alen - 1] == \'\\n\' || after[alen - 1] == \'\\r\')) alen--;');
  lines.push('    if (alen >= 3) start = after;');
  lines.push('    else end = last_leak;');
  lines.push('  }');
  lines.push('  size_t oi = 0;');
  lines.push('  int in_tag = 0;');
  lines.push('  int prev_space = 1;');
  lines.push('  for (const char* p = start; p < end && oi < 4094; p++) {');
  lines.push('    unsigned char c = (unsigned char)*p;');
  lines.push('    if (c == \'<\') { in_tag = 1; continue; }');
  lines.push('    if (in_tag) { if (c == \'>\') { in_tag = 0; if (!prev_space && oi > 0 && oi < 4094) { out[oi++] = \' \'; prev_space = 1; } } continue; }');
  lines.push('    if (c == \' \' || c == \'\\t\' || c == \'\\n\' || c == \'\\r\') {');
  lines.push('      if (!prev_space && oi > 0) { out[oi++] = \' \'; prev_space = 1; }');
  lines.push('      continue;');
  lines.push('    }');
  lines.push('    if (oi == 0 && (c == \'"\' || c == \'\\\'\' || c == \'`\' || c == \'>\' || c == \'|\' || c == \'-\')) continue;');
  lines.push('    out[oi++] = (char)c;');
  lines.push('    prev_space = 0;');
  lines.push('  }');
  lines.push('  while (oi > 0 && out[oi - 1] == \' \') oi--;');
  lines.push('  out[oi] = \'\\0\';');
  lines.push('  return out;');
  lines.push('}');
  lines.push('static char* ppl_str_fold_diacritics(const char* s) {');
  lines.push('  if (!s) { char* e = (char*)malloc(1); e[0] = \'\\0\'; return e; }');
  lines.push('  size_t n = strlen(s);');
  lines.push('  char* out = (char*)malloc(n + 1);');
  lines.push('  size_t oi = 0;');
  lines.push('  for (size_t i = 0; i < n; ) {');
  lines.push('    unsigned char b = (unsigned char)s[i];');
  lines.push('    if (b < 0x80) {');
  lines.push('      if (b >= \'A\' && b <= \'Z\') b = (unsigned char)(b + 32);');
  lines.push('      out[oi++] = (char)b;');
  lines.push('      i++;');
  lines.push('    } else if (b == 0xC3 && i + 1 < n) {');
  lines.push('      unsigned char b2 = (unsigned char)s[i + 1];');
  lines.push('      char rep = 0;');
  lines.push('      if ((b2 >= 0x80 && b2 <= 0x85) || (b2 >= 0xA0 && b2 <= 0xA5)) rep = \'a\';');
  lines.push('      else if ((b2 >= 0x88 && b2 <= 0x8B) || (b2 >= 0xA8 && b2 <= 0xAB)) rep = \'e\';');
  lines.push('      else if ((b2 >= 0x8C && b2 <= 0x8F) || (b2 >= 0xAC && b2 <= 0xAF)) rep = \'i\';');
  lines.push('      else if ((b2 >= 0x92 && b2 <= 0x96) || (b2 >= 0xB2 && b2 <= 0xB6) || b2 == 0x98 || b2 == 0xB8) rep = \'o\';');
  lines.push('      else if ((b2 >= 0x99 && b2 <= 0x9C) || (b2 >= 0xB9 && b2 <= 0xBC)) rep = \'u\';');
  lines.push('      else if (b2 == 0x87 || b2 == 0xA7) rep = \'c\';');
  lines.push('      else if (b2 == 0x91 || b2 == 0xB1) rep = \'n\';');
  lines.push('      else if (b2 == 0x9D || b2 == 0xBD || b2 == 0xBF) rep = \'y\';');
  lines.push('      if (rep) { out[oi++] = rep; i += 2; }');
  lines.push('      else { out[oi++] = (char)b; out[oi++] = (char)b2; i += 2; }');
  lines.push('    } else {');
  lines.push('      out[oi++] = (char)b;');
  lines.push('      i++;');
  lines.push('    }');
  lines.push('  }');
  lines.push('  out[oi] = \'\\0\';');
  lines.push('  return out;');
  lines.push('}');
  lines.push('static int64_t ppl_net_listen(uint64_t port) {');
  lines.push('  signal(SIGPIPE, SIG_IGN);');
  lines.push('  int fd = socket(AF_INET, SOCK_STREAM, 0);');
  lines.push('  if (fd < 0) return -1;');
  lines.push('  int opt = 1;');
  lines.push('  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));');
  lines.push('  struct sockaddr_in addr;');
  lines.push('  memset(&addr, 0, sizeof(addr));');
  lines.push('  addr.sin_family = AF_INET;');
  lines.push('  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);');
  lines.push('  addr.sin_port = htons((uint16_t)port);');
  lines.push('  if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) { close(fd); return -1; }');
  lines.push('  if (listen(fd, 128) < 0) { close(fd); return -1; }');
  lines.push('  return (int64_t)fd;');
  lines.push('}');
  lines.push('static int64_t ppl_net_accept(int64_t srv_fd) {');
  lines.push('  if (srv_fd < 0) return -1;');
  lines.push('  return (int64_t)accept((int)srv_fd, NULL, NULL);');
  lines.push('}');
  lines.push('static const char* ppl_net_read_req(int64_t cli_fd) {');
  lines.push('  static _Thread_local char req_buf[8192];');
  lines.push('  req_buf[0] = \'\\0\';');
  lines.push('  if (cli_fd < 0) return req_buf;');
  lines.push('  ssize_t n = recv((int)cli_fd, req_buf, sizeof(req_buf) - 1, 0);');
  lines.push('  if (n > 0) req_buf[n] = \'\\0\';');
  lines.push('  return req_buf;');
  lines.push('}');
  lines.push('static const char* ppl_net_req_method(const char* raw) {');
  lines.push('  static _Thread_local char m_buf[16];');
  lines.push('  m_buf[0] = \'\\0\';');
  lines.push('  if (!raw) return m_buf;');
  lines.push('  size_t i = 0;');
  lines.push('  while (raw[i] && raw[i] != \' \' && i < sizeof(m_buf) - 1) { m_buf[i] = raw[i]; i++; }');
  lines.push('  m_buf[i] = \'\\0\';');
  lines.push('  return m_buf;');
  lines.push('}');
  lines.push('static const char* ppl_net_req_path(const char* raw) {');
  lines.push('  static _Thread_local char p_buf[2048];');
  lines.push('  p_buf[0] = \'/\'; p_buf[1] = \'\\0\';');
  lines.push('  if (!raw) return p_buf;');
  lines.push('  const char* sp1 = strchr(raw, \' \');');
  lines.push('  if (!sp1) return p_buf;');
  lines.push('  sp1++;');
  lines.push('  size_t i = 0;');
  lines.push('  while (sp1[i] && sp1[i] != \' \' && sp1[i] != \'\\r\' && sp1[i] != \'\\n\' && i < sizeof(p_buf) - 1) { p_buf[i] = sp1[i]; i++; }');
  lines.push('  if (i > 0) p_buf[i] = \'\\0\';');
  lines.push('  return p_buf;');
  lines.push('}');
  lines.push('static const char* ppl_net_req_body(const char* raw) {');
  lines.push('  if (!raw) return "";');
  lines.push('  const char* b = strstr(raw, "\\r\\n\\r\\n");');
  lines.push('  return b ? (b + 4) : "";');
  lines.push('}');
  lines.push('static const char* ppl_net_req_query(const char* raw, const char* key) {');
  lines.push('  static _Thread_local char q_buf[2048];');
  lines.push('  q_buf[0] = \'\\0\';');
  lines.push('  if (!raw || !key || !*key) return q_buf;');
  lines.push('  const char* path = ppl_net_req_path(raw);');
  lines.push('  const char* q = strchr(path, \'?\');');
  lines.push('  if (!q) return q_buf;');
  lines.push('  q++;');
  lines.push('  size_t klen = strlen(key);');
  lines.push('  while (*q) {');
  lines.push('    const char* amp = strchr(q, \'&\');');
  lines.push('    size_t plen = amp ? (size_t)(amp - q) : strlen(q);');
  lines.push('    if (plen > klen && strncmp(q, key, klen) == 0 && q[klen] == \'=\') {');
  lines.push('      const char* val = q + klen + 1;');
  lines.push('      size_t vlen = plen - klen - 1;');
  lines.push('      size_t out = 0;');
  lines.push('      for (size_t i = 0; i < vlen && out < sizeof(q_buf) - 1; i++) {');
  lines.push('        if (val[i] == \'+\') q_buf[out++] = \' \';');
  lines.push('        else if (val[i] == \'%\' && i + 2 < vlen) {');
  lines.push('          char hex[3] = { val[i + 1], val[i + 2], \'\\0\' };');
  lines.push('          q_buf[out++] = (char)strtol(hex, NULL, 16);');
  lines.push('          i += 2;');
  lines.push('        } else q_buf[out++] = val[i];');
  lines.push('      }');
  lines.push('      q_buf[out] = \'\\0\';');
  lines.push('      return q_buf;');
  lines.push('    }');
  lines.push('    if (!amp) break;');
  lines.push('    q = amp + 1;');
  lines.push('  }');
  lines.push('  return q_buf;');
  lines.push('}');
  lines.push('static _Atomic uint64_t ppl_hits_native = 0;');
  lines.push('static _Atomic uint64_t ppl_hits_proxy = 0;');
  lines.push('static bool ppl_net_send_http(int64_t cli_fd, uint64_t status, const char* ctype, const char* body) {');
  lines.push('  if (cli_fd < 0) return false;');
  lines.push('  ppl_hits_native++;');
  lines.push('  const char* b = body ? body : "";');
  lines.push('  size_t blen = strlen(b);');
  lines.push('  const char* msg = (status == 404) ? "Not Found" : ((status == 403) ? "Forbidden" : "OK");');
  lines.push('  char hdr[512];');
  lines.push('  int hlen = snprintf(hdr, sizeof(hdr), "HTTP/1.1 %llu %s\\r\\nContent-Type: %s\\r\\nContent-Length: %zu\\r\\nConnection: close\\r\\nX-Powered-By: Papaleguas-Native-PPL\\r\\n\\r\\n", (unsigned long long)status, msg, ctype ? ctype : "text/plain", blen);');
  lines.push('  if (hlen > 0) send((int)cli_fd, hdr, (size_t)hlen, 0);');
  lines.push('  if (blen > 0) send((int)cli_fd, b, blen, 0);');
  lines.push('  return true;');
  lines.push('}');
  lines.push('static const char* ppl_net_metrics_json(void) {');
  lines.push('  static _Thread_local char m_buf[512];');
  lines.push('  snprintf(m_buf, sizeof(m_buf), "{\\"ok\\":true,\\"engine\\":\\"Papaleguas-Native-PPL\\",\\"hitsNative\\":%llu,\\"hitsProxy\\":%llu,\\"cpuCores\\":%llu,\\"ramFreeMb\\":%llu,\\"ramTotalMb\\":%llu,\\"uptimeSec\\":%llu}", (unsigned long long)ppl_hits_native, (unsigned long long)ppl_hits_proxy, (unsigned long long)ppl_hw_cpu_cores(), (unsigned long long)ppl_hw_ram_free_mb(), (unsigned long long)ppl_hw_ram_total_mb(), (unsigned long long)ppl_hw_uptime_sec());');
  lines.push('  return m_buf;');
  lines.push('}');
  lines.push('static inline void ppl_net_close(int64_t fd) { if (fd >= 0) close((int)fd); }');
  lines.push('static const char* ppl_fs_read_safe(const char* root_dir, const char* rel_path) {');
  lines.push('  static _Thread_local char fs_buf[65536];');
  lines.push('  fs_buf[0] = \'\\0\';');
  lines.push('  if (!root_dir || !rel_path || !*rel_path) return fs_buf;');
  lines.push('  if (rel_path[0] == \'/\' || rel_path[0] == \'\\\\\' || strstr(rel_path, "..") != NULL) return fs_buf;');
  lines.push('  char real_root[PATH_MAX];');
  lines.push('  if (!realpath(root_dir, real_root)) return fs_buf;');
  lines.push('  char joined[PATH_MAX];');
  lines.push('  snprintf(joined, sizeof(joined), "%s/%s", real_root, rel_path);');
  lines.push('  char real_target[PATH_MAX];');
  lines.push('  if (!realpath(joined, real_target)) return fs_buf;');
  lines.push('  size_t rlen = strlen(real_root);');
  lines.push('  if (strncmp(real_target, real_root, rlen) != 0 || real_target[rlen] != \'/\') return fs_buf;');
  lines.push('  FILE* f = fopen(real_target, "rb");');
  lines.push('  if (!f) return fs_buf;');
  lines.push('  size_t nr = fread(fs_buf, 1, sizeof(fs_buf) - 1, f);');
  lines.push('  fs_buf[nr] = \'\\0\';');
  lines.push('  fclose(f);');
  lines.push('  return fs_buf;');
  lines.push('}');
  lines.push('static bool ppl_net_send_file_safe(int64_t cli_fd, const char* root_dir, const char* rel_path, const char* ctype) {');
  lines.push('  if (cli_fd < 0 || !root_dir || !rel_path || !*rel_path) return false;');
  lines.push('  if (rel_path[0] == \'/\' || rel_path[0] == \'\\\\\' || strstr(rel_path, "..") != NULL) return false;');
  lines.push('  char clean_rel[2048];');
  lines.push('  size_t ri = 0;');
  lines.push('  while (rel_path[ri] && rel_path[ri] != \'?\' && rel_path[ri] != \'#\' && ri < sizeof(clean_rel) - 1) { clean_rel[ri] = rel_path[ri]; ri++; }');
  lines.push('  clean_rel[ri] = \'\\0\';');
  lines.push('  if (ri == 0 || strstr(clean_rel, "..") != NULL) return false;');
  lines.push('  char real_root[PATH_MAX];');
  lines.push('  if (!realpath(root_dir, real_root)) return false;');
  lines.push('  char joined[PATH_MAX];');
  lines.push('  if (snprintf(joined, sizeof(joined), "%s/%s", real_root, clean_rel) >= (int)sizeof(joined)) return false;');
  lines.push('  char real_target[PATH_MAX];');
  lines.push('  if (!realpath(joined, real_target)) return false;');
  lines.push('  size_t rlen = strlen(real_root);');
  lines.push('  if (strncmp(real_target, real_root, rlen) != 0 || real_target[rlen] != \'/\') return false;');
  lines.push('  FILE* f = fopen(real_target, "rb");');
  lines.push('  if (!f) return false;');
  lines.push('  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return false; }');
  lines.push('  long fsize = ftell(f);');
  lines.push('  if (fsize < 0) { fclose(f); return false; }');
  lines.push('  rewind(f);');
  lines.push('  char hdr[512];');
  lines.push('  int hlen = snprintf(hdr, sizeof(hdr), "HTTP/1.1 200 OK\\r\\nContent-Type: %s\\r\\nContent-Length: %ld\\r\\nCache-Control: public, max-age=3600\\r\\nConnection: close\\r\\nX-Powered-By: Papaleguas-Native-PPL\\r\\n\\r\\n", ctype ? ctype : "application/octet-stream", fsize);');
  lines.push('  ppl_hits_native++;');
  lines.push('  if (hlen > 0) send((int)cli_fd, hdr, (size_t)hlen, 0);');
  lines.push('  char chunk[16384];');
  lines.push('  size_t n = 0;');
  lines.push('  while ((n = fread(chunk, 1, sizeof(chunk), f)) > 0) {');
  lines.push('    size_t off = 0;');
  lines.push('    while (off < n) {');
  lines.push('      ssize_t sent = send((int)cli_fd, chunk + off, n - off, 0);');
  lines.push('      if (sent <= 0) { fclose(f); return true; }');
  lines.push('      off += (size_t)sent;');
  lines.push('    }');
  lines.push('  }');
  lines.push('  fclose(f);');
  lines.push('  return true;');
  lines.push('}');
  lines.push('static bool ppl_net_serve_static(int64_t cli_fd, const char* root_dir, const char* url_path) {');
  lines.push('  if (!url_path) return false;');
  lines.push('  const char* p = url_path;');
  lines.push('  if (p[0] == \'/\') p++;');
  lines.push('  char rel[2048];');
  lines.push('  size_t i = 0;');
  lines.push('  while (p[i] && p[i] != \'?\' && p[i] != \'#\' && i < sizeof(rel) - 1) { rel[i] = p[i]; i++; }');
  lines.push('  rel[i] = \'\\0\';');
  lines.push('  if (rel[0] == \'\\0\') snprintf(rel, sizeof(rel), "index.html");');
  lines.push('  const char* ext = strrchr(rel, \'.\');');
  lines.push('  const char* ctype = "application/octet-stream";');
  lines.push('  if (ext) {');
  lines.push('    if (strcmp(ext, ".html") == 0) ctype = "text/html; charset=utf-8";');
  lines.push('    else if (strcmp(ext, ".css") == 0) ctype = "text/css; charset=utf-8";');
  lines.push('    else if (strcmp(ext, ".js") == 0) ctype = "application/javascript; charset=utf-8";');
  lines.push('    else if (strcmp(ext, ".json") == 0) ctype = "application/json; charset=utf-8";');
  lines.push('    else if (strcmp(ext, ".wasm") == 0) ctype = "application/wasm";');
  lines.push('    else if (strcmp(ext, ".svg") == 0) ctype = "image/svg+xml";');
  lines.push('    else if (strcmp(ext, ".png") == 0) ctype = "image/png";');
  lines.push('    else if (strcmp(ext, ".ico") == 0) ctype = "image/x-icon";');
  lines.push('    else if (strcmp(ext, ".webp") == 0) ctype = "image/webp";');
  lines.push('    else if (strcmp(ext, ".jpg") == 0 || strcmp(ext, ".jpeg") == 0) ctype = "image/jpeg";');
  lines.push('    else if (strcmp(ext, ".woff2") == 0) ctype = "font/woff2";');
  lines.push('    else if (strcmp(ext, ".txt") == 0) ctype = "text/plain; charset=utf-8";');
  lines.push('    else if (strcmp(ext, ".xml") == 0) ctype = "application/xml; charset=utf-8";');
  lines.push('  }');
  lines.push('  return ppl_net_send_file_safe(cli_fd, root_dir, rel, ctype);');
  lines.push('}');
  lines.push('static const char* ppl_net_http_get(const char* host, uint64_t port, const char* req_path) {');
  lines.push('  static _Thread_local char http_res[16384];');
  lines.push('  http_res[0] = \'\\0\';');
  lines.push('  if (!host || !*host || port == 0 || port > 65535) return http_res;');
  lines.push('  char port_str[16];');
  lines.push('  snprintf(port_str, sizeof(port_str), "%llu", (unsigned long long)port);');
  lines.push('  struct addrinfo hints, *res = NULL;');
  lines.push('  memset(&hints, 0, sizeof(hints));');
  lines.push('  hints.ai_family = AF_INET;');
  lines.push('  hints.ai_socktype = SOCK_STREAM;');
  lines.push('  if (getaddrinfo(host, port_str, &hints, &res) != 0 || !res) return http_res;');
  lines.push('  int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);');
  lines.push('  if (fd < 0) { freeaddrinfo(res); return http_res; }');
  lines.push('  struct timeval tv; tv.tv_sec = 2; tv.tv_usec = 0;');
  lines.push('  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));');
  lines.push('  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));');
  lines.push('  if (connect(fd, res->ai_addr, res->ai_addrlen) < 0) { close(fd); freeaddrinfo(res); return http_res; }');
  lines.push('  freeaddrinfo(res);');
  lines.push('  char req[2048];');
  lines.push('  const char* p = (req_path && *req_path) ? req_path : "/";');
  lines.push('  int rlen = snprintf(req, sizeof(req), "GET %s HTTP/1.0\\r\\nHost: %s\\r\\nUser-Agent: Papaleguas-PPL/1.0\\r\\nConnection: close\\r\\n\\r\\n", p, host);');
  lines.push('  if (rlen > 0) send(fd, req, (size_t)rlen, 0);');
  lines.push('  size_t total = 0;');
  lines.push('  while (total < sizeof(http_res) - 1) {');
  lines.push('    ssize_t n = recv(fd, http_res + total, sizeof(http_res) - 1 - total, 0);');
  lines.push('    if (n <= 0) break;');
  lines.push('    total += (size_t)n;');
  lines.push('  }');
  lines.push('  http_res[total] = \'\\0\';');
  lines.push('  close(fd);');
  lines.push('  const char* body = strstr(http_res, "\\r\\n\\r\\n");');
  lines.push('  return body ? (body + 4) : http_res;');
  lines.push('}');
  lines.push('static bool ppl_net_write_all(int fd, const char* data, size_t len) {');
  lines.push('  size_t off = 0;');
  lines.push('  while (off < len) {');
  lines.push('    ssize_t w = send(fd, data + off, len - off, 0);');
  lines.push('    if (w <= 0) return false;');
  lines.push('    off += (size_t)w;');
  lines.push('  }');
  lines.push('  return true;');
  lines.push('}');
  lines.push('static bool ppl_ci_prefix(const char* s, size_t slen, const char* pfx, size_t plen) {');
  lines.push('  if (slen < plen) return false;');
  lines.push('  for (size_t i = 0; i < plen; i++) {');
  lines.push('    char a = s[i]; if (a >= \'A\' && a <= \'Z\') a = (char)(a + 32);');
  lines.push('    char b = pfx[i]; if (b >= \'A\' && b <= \'Z\') b = (char)(b + 32);');
  lines.push('    if (a != b) return false;');
  lines.push('  }');
  lines.push('  return true;');
  lines.push('}');
  lines.push('static bool ppl_net_proxy_pass(int64_t cli_fd, const char* host, uint64_t port, const char* raw_req) {');
  lines.push('  if (cli_fd < 0 || !host || !*host || port == 0 || port > 65535 || !raw_req || !*raw_req) return false;');
  lines.push('  ppl_hits_proxy++;');
  lines.push('  char port_str[16];');
  lines.push('  snprintf(port_str, sizeof(port_str), "%llu", (unsigned long long)port);');
  lines.push('  struct addrinfo hints, *res = NULL;');
  lines.push('  memset(&hints, 0, sizeof(hints));');
  lines.push('  hints.ai_family = AF_INET;');
  lines.push('  hints.ai_socktype = SOCK_STREAM;');
  lines.push('  if (getaddrinfo(host, port_str, &hints, &res) != 0 || !res) return false;');
  lines.push('  int up_fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);');
  lines.push('  if (up_fd < 0) { freeaddrinfo(res); return false; }');
  lines.push('  struct timeval tv; tv.tv_sec = 5; tv.tv_usec = 0;');
  lines.push('  setsockopt(up_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));');
  lines.push('  setsockopt(up_fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));');
  lines.push('  if (connect(up_fd, res->ai_addr, res->ai_addrlen) < 0) { close(up_fd); freeaddrinfo(res); return false; }');
  lines.push('  freeaddrinfo(res);');
  lines.push('  const char* hdr_end = strstr(raw_req, "\\r\\n\\r\\n");');
  lines.push('  if (!hdr_end) {');
  lines.push('    size_t rlen = strlen(raw_req);');
  lines.push('    if (!ppl_net_write_all(up_fd, raw_req, rlen)) { close(up_fd); return false; }');
  lines.push('  } else {');
  lines.push('    const char* p = raw_req;');
  lines.push('    while (p < hdr_end) {');
  lines.push('      const char* nl = strstr(p, "\\r\\n");');
  lines.push('      if (!nl || nl > hdr_end) nl = hdr_end;');
  lines.push('      size_t llen = (size_t)(nl - p);');
  lines.push('      if (!ppl_ci_prefix(p, llen, "connection:", 11)) {');
  lines.push('        if (!ppl_net_write_all(up_fd, p, llen) || !ppl_net_write_all(up_fd, "\\r\\n", 2)) { close(up_fd); return false; }');
  lines.push('      }');
  lines.push('      p = (nl < hdr_end) ? (nl + 2) : hdr_end;');
  lines.push('    }');
  lines.push('    if (!ppl_net_write_all(up_fd, "Connection: close\\r\\n\\r\\n", 21)) { close(up_fd); return false; }');
  lines.push('    const char* body = hdr_end + 4;');
  lines.push('    size_t blen = strlen(body);');
  lines.push('    if (blen > 0 && !ppl_net_write_all(up_fd, body, blen)) { close(up_fd); return false; }');
  lines.push('  }');
  lines.push('  char buf[8192];');
  lines.push('  size_t total_sent = 0;');
  lines.push('  while (1) {');
  lines.push('    ssize_t n = recv(up_fd, buf, sizeof(buf), 0);');
  lines.push('    if (n <= 0) break;');
  lines.push('    if (!ppl_net_write_all((int)cli_fd, buf, (size_t)n)) { close(up_fd); return total_sent > 0; }');
  lines.push('    total_sent += (size_t)n;');
  lines.push('  }');
  lines.push('  close(up_fd);');
  lines.push('  return total_sent > 0;');
  lines.push('}');
  if (usesRelayImage || usesFetchMeta) {
    lines.push('static bool ppl_is_public_ipv4(uint32_t ip_host_order) {');
    lines.push('  uint8_t a = (ip_host_order >> 24) & 0xff, b = (ip_host_order >> 16) & 0xff;');
    lines.push('  if (a == 0 || a == 10 || a == 127) return false;');
    lines.push('  if (a == 100 && b >= 64 && b <= 127) return false;');
    lines.push('  if (a == 169 && b == 254) return false;');
    lines.push('  if (a == 172 && b >= 16 && b <= 31) return false;');
    lines.push('  if (a == 192 && b == 168) return false;');
    lines.push('  if (a >= 224) return false;');
    lines.push('  return true;');
    lines.push('}');
  }
  if (usesRelayImage) {
    lines.push('static bool ppl_net_relay_image_hop(int64_t cli_fd, const char* raw_url, int depth) {');
    lines.push('  if (depth > 2 || cli_fd < 0 || !raw_url || !*raw_url) return false;');
    lines.push('  bool is_https = false;');
    lines.push('  const char* p = raw_url;');
    lines.push('  if (strncmp(p, "https://", 8) == 0) { is_https = true; p += 8; }');
    lines.push('  else if (strncmp(p, "http://", 7) == 0) { is_https = false; p += 7; }');
    lines.push('  else return false;');
    lines.push('  const char* slash = strchr(p, \'/\');');
    lines.push('  const char* qm = strchr(p, \'?\');');
    lines.push('  const char* host_end = slash ? slash : (qm ? qm : p + strlen(p));');
    lines.push('  if (qm && qm < host_end) host_end = qm;');
    lines.push('  size_t hostport_len = (size_t)(host_end - p);');
    lines.push('  if (hostport_len == 0 || hostport_len > 250) return false;');
    lines.push('  char host[256]; memcpy(host, p, hostport_len); host[hostport_len] = \'\\0\';');
    lines.push('  if (strchr(host, \'@\') || strchr(host, \'[\') || strstr(host, ".onion")) return false;');
    lines.push('  uint16_t port = is_https ? 443 : 80;');
    lines.push('  char* colon = strchr(host, \':\');');
    lines.push('  if (colon) { *colon = \'\\0\'; long pv = strtol(colon + 1, NULL, 10); if (pv <= 0 || pv > 65535) return false; port = (uint16_t)pv; }');
    lines.push('  if (strcmp(host, "localhost") == 0) return false;');
    lines.push('  const char* req_path = (*host_end == \'/\') ? host_end : "/";');
    lines.push('  char port_str[16]; snprintf(port_str, sizeof(port_str), "%u", (unsigned)port);');
    lines.push('  struct addrinfo hints, *res = NULL; memset(&hints, 0, sizeof(hints));');
    lines.push('  hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM;');
    lines.push('  if (getaddrinfo(host, port_str, &hints, &res) != 0 || !res) return false;');
    lines.push('  struct sockaddr_in* sin = (struct sockaddr_in*)res->ai_addr;');
    lines.push('  if (!ppl_is_public_ipv4(ntohl(sin->sin_addr.s_addr))) { freeaddrinfo(res); return false; }');
    lines.push('  int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);');
    lines.push('  if (fd < 0) { freeaddrinfo(res); return false; }');
    lines.push('  struct timeval tv; tv.tv_sec = 3; tv.tv_usec = 500000;');
    lines.push('  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));');
    lines.push('  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));');
    lines.push('  if (connect(fd, res->ai_addr, res->ai_addrlen) < 0) { close(fd); freeaddrinfo(res); return false; }');
    lines.push('  freeaddrinfo(res);');
    lines.push('  SSL_CTX* ctx = NULL; SSL* ssl = NULL;');
    lines.push('  if (is_https) {');
    lines.push('    ctx = SSL_CTX_new(TLS_client_method());');
    lines.push('    if (!ctx) { close(fd); return false; }');
    lines.push('    ssl = SSL_new(ctx);');
    lines.push('    if (!ssl) { SSL_CTX_free(ctx); close(fd); return false; }');
    lines.push('    SSL_set_tlsext_host_name(ssl, host);');
    lines.push('    SSL_set_fd(ssl, fd);');
    lines.push('    if (SSL_connect(ssl) <= 0) { SSL_free(ssl); SSL_CTX_free(ctx); close(fd); return false; }');
    lines.push('  }');
    lines.push('  char req_buf[2048];');
    lines.push('  int rlen = snprintf(req_buf, sizeof(req_buf), "GET %s HTTP/1.0\\r\\nHost: %s\\r\\nUser-Agent: Mozilla/5.0\\r\\nAccept: image/avif,image/webp,image/*,*/*;q=0.8\\r\\nConnection: close\\r\\n\\r\\n", req_path, host);');
    lines.push('  if (rlen <= 0 || rlen >= (int)sizeof(req_buf)) { if (ssl) { SSL_free(ssl); SSL_CTX_free(ctx); } close(fd); return false; }');
    lines.push('  bool sent = is_https ? (SSL_write(ssl, req_buf, rlen) == rlen) : ppl_net_write_all(fd, req_buf, (size_t)rlen);');
    lines.push('  if (!sent) { if (ssl) { SSL_free(ssl); SSL_CTX_free(ctx); } close(fd); return false; }');
    lines.push('  char hbuf[8192]; size_t hlen = 0; char* hend = NULL;');
    lines.push('  while (hlen < sizeof(hbuf) - 1) {');
    lines.push('    int n = is_https ? SSL_read(ssl, hbuf + hlen, (int)(sizeof(hbuf) - 1 - hlen)) : (int)recv(fd, hbuf + hlen, sizeof(hbuf) - 1 - hlen, 0);');
    lines.push('    if (n <= 0) break;');
    lines.push('    hlen += (size_t)n; hbuf[hlen] = \'\\0\';');
    lines.push('    hend = strstr(hbuf, "\\r\\n\\r\\n");');
    lines.push('    if (hend) break;');
    lines.push('  }');
    lines.push('  if (!hend || strncmp(hbuf, "HTTP/", 5) != 0) { if (ssl) { SSL_free(ssl); SSL_CTX_free(ctx); } close(fd); return false; }');
    lines.push('  const char* sp = strchr(hbuf, \' \');');
    lines.push('  int status_code = sp ? atoi(sp + 1) : 0;');
    lines.push('  *hend = \'\\0\';');
    lines.push('  if ((status_code == 301 || status_code == 302 || status_code == 307 || status_code == 308) && depth < 2) {');
    lines.push('    char loc[1024] = {0};');
    lines.push('    for (char* line = strstr(hbuf, "\\r\\n"); line; line = strstr(line + 2, "\\r\\n")) {');
    lines.push('      char* ls = line + 2;');
    lines.push('      if (ppl_ci_prefix(ls, strlen(ls), "location:", 9)) {');
    lines.push('        const char* v = ls + 9; while (*v == \' \' || *v == \'\\t\') v++;');
    lines.push('        size_t k = 0; while (v[k] && v[k] != \'\\r\' && v[k] != \'\\n\' && k < sizeof(loc) - 1) { loc[k] = v[k]; k++; }');
    lines.push('        loc[k] = \'\\0\'; break;');
    lines.push('      }');
    lines.push('    }');
    lines.push('    if (ssl) { SSL_free(ssl); SSL_CTX_free(ctx); } close(fd);');
    lines.push('    if (strncmp(loc, "http://", 7) == 0 || strncmp(loc, "https://", 8) == 0) return ppl_net_relay_image_hop(cli_fd, loc, depth + 1);');
    lines.push('    return false;');
    lines.push('  }');
    lines.push('  if (status_code != 200) { if (ssl) { SSL_free(ssl); SSL_CTX_free(ctx); } close(fd); return false; }');
    lines.push('  char ctype[128] = {0};');
    lines.push('  for (char* line = strstr(hbuf, "\\r\\n"); line; line = strstr(line + 2, "\\r\\n")) {');
    lines.push('    char* ls = line + 2;');
    lines.push('    if (ppl_ci_prefix(ls, strlen(ls), "content-type:", 13)) {');
    lines.push('      const char* v = ls + 13; while (*v == \' \' || *v == \'\\t\') v++;');
    lines.push('      size_t k = 0; while (v[k] && v[k] != \'\\r\' && v[k] != \'\\n\' && v[k] != \';\' && k < sizeof(ctype) - 1) { ctype[k] = v[k]; k++; }');
    lines.push('      ctype[k] = \'\\0\'; break;');
    lines.push('    }');
    lines.push('  }');
    lines.push('  if (!ppl_ci_prefix(ctype, strlen(ctype), "image/", 6) || strstr(ctype, "svg")) { if (ssl) { SSL_free(ssl); SSL_CTX_free(ctx); } close(fd); return false; }');
    lines.push('  char out_hdr[512];');
    lines.push('  int ohlen = snprintf(out_hdr, sizeof(out_hdr), "HTTP/1.1 200 OK\\r\\nContent-Type: %s\\r\\nCache-Control: public, max-age=86400\\r\\nX-Content-Type-Options: nosniff\\r\\nX-Powered-By: Papaleguas-Native-PPL\\r\\nConnection: close\\r\\n\\r\\n", ctype);');
    lines.push('  if (!ppl_net_write_all((int)cli_fd, out_hdr, (size_t)ohlen)) { if (ssl) { SSL_free(ssl); SSL_CTX_free(ctx); } close(fd); return false; }');
    lines.push('  const char* body_start = hend + 4; size_t body_init = hlen - (size_t)(body_start - hbuf);');
    lines.push('  size_t total = 0;');
    lines.push('  if (body_init > 0) { if (!ppl_net_write_all((int)cli_fd, body_start, body_init)) { if (ssl) { SSL_free(ssl); SSL_CTX_free(ctx); } close(fd); return false; } total += body_init; }');
    lines.push('  char bbuf[16384];');
    lines.push('  while (total < 4 * 1024 * 1024) {');
    lines.push('    int n = is_https ? SSL_read(ssl, bbuf, sizeof(bbuf)) : (int)recv(fd, bbuf, sizeof(bbuf), 0);');
    lines.push('    if (n <= 0) break;');
    lines.push('    if (!ppl_net_write_all((int)cli_fd, bbuf, (size_t)n)) break;');
    lines.push('    total += (size_t)n;');
    lines.push('  }');
    lines.push('  if (ssl) { SSL_free(ssl); SSL_CTX_free(ctx); }');
    lines.push('  close(fd);');
    lines.push('  return total > 0;');
    lines.push('}');
    lines.push('static bool ppl_net_relay_image(int64_t cli_fd, const char* raw_url) {');
    lines.push('  return ppl_net_relay_image_hop(cli_fd, raw_url, 0);');
    lines.push('}');
  }
  if (usesFetchMeta) {
    lines.push('static void ppl_json_escape_into(char* dst, size_t dst_sz, const char* src) {');
    lines.push('  size_t di = 0;');
    lines.push('  for (size_t i = 0; src && src[i] && di + 3 < dst_sz; i++) {');
    lines.push('    unsigned char c = (unsigned char)src[i];');
    lines.push('    if (c == \'"\' || c == \'\\\\\') { dst[di++] = \'\\\\\'; dst[di++] = (char)c; }');
    lines.push('    else if (c < 0x20) { dst[di++] = \' \'; }');
    lines.push('    else { dst[di++] = (char)c; }');
    lines.push('  }');
    lines.push('  dst[di] = \'\\0\';');
    lines.push('}');
    lines.push('static void ppl_extract_meta_attr(const char* html, const char* key, char* out, size_t out_sz) {');
    lines.push('  out[0] = \'\\0\';');
    lines.push('  if (!html || !key) return;');
    lines.push('  const char* pos = strstr(html, key);');
    lines.push('  if (!pos) return;');
    lines.push('  const char* tag_end = strchr(pos, \'>\');');
    lines.push('  const char* ct = strstr(pos, "content=");');
    lines.push('  if (!ct || (tag_end && ct > tag_end)) {');
    lines.push('    const char* tag_start = pos; while (tag_start > html && *tag_start != \'<\') tag_start--;');
    lines.push('    ct = strstr(tag_start, "content=");');
    lines.push('    if (!ct || (tag_end && ct > tag_end)) return;');
    lines.push('  }');
    lines.push('  ct += 8;');
    lines.push('  char q = (*ct == \'"\' || *ct == \'\\\'\') ? *ct++ : 0;');
    lines.push('  size_t i = 0;');
    lines.push('  while (ct[i] && i + 1 < out_sz) {');
    lines.push('    if (q ? (ct[i] == q) : (ct[i] == \' \' || ct[i] == \'>\')) break;');
    lines.push('    out[i] = ct[i]; i++;');
    lines.push('  }');
    lines.push('  out[i] = \'\\0\';');
    lines.push('}');
    lines.push('#define PPL_META_CACHE_SZ 64');
    lines.push('typedef struct { char url[512]; char json[4096]; time_t ts; } ppl_meta_entry_t;');
    lines.push('static ppl_meta_entry_t ppl_meta_cache[PPL_META_CACHE_SZ];');
    lines.push('static size_t ppl_meta_next = 0;');
    lines.push('static pthread_mutex_t ppl_meta_mtx = PTHREAD_MUTEX_INITIALIZER;');
    lines.push('static const char* ppl_net_fetch_meta(const char* raw_url) {');
    lines.push('  static _Thread_local char meta_json[4096];');
    lines.push('  strcpy(meta_json, "{\\"ok\\":false,\\"title\\":\\"\\",\\"image\\":\\"\\",\\"description\\":\\"\\"}");');
    lines.push('  if (!raw_url || !*raw_url) return meta_json;');
    lines.push('  time_t now_ts = time(NULL);');
    lines.push('  pthread_mutex_lock(&ppl_meta_mtx);');
    lines.push('  for (size_t ci = 0; ci < PPL_META_CACHE_SZ; ci++) {');
    lines.push('    if (ppl_meta_cache[ci].ts > 0 && (now_ts - ppl_meta_cache[ci].ts) < 300 && strcmp(ppl_meta_cache[ci].url, raw_url) == 0) {');
    lines.push('      snprintf(meta_json, sizeof(meta_json), "%s", ppl_meta_cache[ci].json);');
    lines.push('      pthread_mutex_unlock(&ppl_meta_mtx);');
    lines.push('      return meta_json;');
    lines.push('    }');
    lines.push('  }');
    lines.push('  pthread_mutex_unlock(&ppl_meta_mtx);');
    lines.push('  bool is_https = false; const char* p = raw_url;');
    lines.push('  if (strncmp(p, "https://", 8) == 0) { is_https = true; p += 8; }');
    lines.push('  else if (strncmp(p, "http://", 7) == 0) { is_https = false; p += 7; }');
    lines.push('  else return meta_json;');
    lines.push('  const char* slash = strchr(p, \'/\'); const char* qm = strchr(p, \'?\');');
    lines.push('  const char* host_end = slash ? slash : (qm ? qm : p + strlen(p));');
    lines.push('  if (qm && qm < host_end) host_end = qm;');
    lines.push('  size_t hlen = (size_t)(host_end - p); if (hlen == 0 || hlen > 250) return meta_json;');
    lines.push('  char host[256]; memcpy(host, p, hlen); host[hlen] = \'\\0\';');
    lines.push('  if (strchr(host, \'@\') || strchr(host, \'[\') || strstr(host, ".onion") || strcmp(host, "localhost") == 0) return meta_json;');
    lines.push('  uint16_t port = is_https ? 443 : 80; char* colon = strchr(host, \':\');');
    lines.push('  if (colon) { *colon = \'\\0\'; long pv = strtol(colon + 1, NULL, 10); if (pv <= 0 || pv > 65535) return meta_json; port = (uint16_t)pv; }');
    lines.push('  const char* req_path = (*host_end == \'/\') ? host_end : "/";');
    lines.push('  char port_str[16]; snprintf(port_str, sizeof(port_str), "%u", (unsigned)port);');
    lines.push('  struct addrinfo hints, *res = NULL; memset(&hints, 0, sizeof(hints));');
    lines.push('  hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM;');
    lines.push('  if (getaddrinfo(host, port_str, &hints, &res) != 0 || !res) return meta_json;');
    lines.push('  struct sockaddr_in* sin = (struct sockaddr_in*)res->ai_addr;');
    lines.push('  if (!ppl_is_public_ipv4(ntohl(sin->sin_addr.s_addr))) { freeaddrinfo(res); return meta_json; }');
    lines.push('  int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);');
    lines.push('  if (fd < 0) { freeaddrinfo(res); return meta_json; }');
    lines.push('  struct timeval tv; tv.tv_sec = 2; tv.tv_usec = 800000;');
    lines.push('  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));');
    lines.push('  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));');
    lines.push('  if (connect(fd, res->ai_addr, res->ai_addrlen) < 0) { close(fd); freeaddrinfo(res); return meta_json; }');
    lines.push('  freeaddrinfo(res);');
    lines.push('  SSL_CTX* ctx = NULL; SSL* ssl = NULL;');
    lines.push('  if (is_https) {');
    lines.push('    ctx = SSL_CTX_new(TLS_client_method()); if (!ctx) { close(fd); return meta_json; }');
    lines.push('    ssl = SSL_new(ctx); if (!ssl) { SSL_CTX_free(ctx); close(fd); return meta_json; }');
    lines.push('    SSL_set_tlsext_host_name(ssl, host); SSL_set_fd(ssl, fd);');
    lines.push('    if (SSL_connect(ssl) <= 0) { SSL_free(ssl); SSL_CTX_free(ctx); close(fd); return meta_json; }');
    lines.push('  }');
    lines.push('  char req_buf[2048];');
    lines.push('  int rlen = snprintf(req_buf, sizeof(req_buf), "GET %s HTTP/1.0\\r\\nHost: %s\\r\\nUser-Agent: Mozilla/5.0\\r\\nAccept: text/html\\r\\nConnection: close\\r\\n\\r\\n", req_path, host);');
    lines.push('  bool sent = (rlen > 0 && rlen < (int)sizeof(req_buf)) && (is_https ? (SSL_write(ssl, req_buf, rlen) == rlen) : ppl_net_write_all(fd, req_buf, (size_t)rlen));');
    lines.push('  char* raw_html = (char*)malloc(32768); size_t rtot = 0;');
    lines.push('  if (sent && raw_html) {');
    lines.push('    while (rtot < 32767) {');
    lines.push('      int n = is_https ? SSL_read(ssl, raw_html + rtot, (int)(32767 - rtot)) : (int)recv(fd, raw_html + rtot, 32767 - rtot, 0);');
    lines.push('      if (n <= 0) break;');
    lines.push('      rtot += (size_t)n;');
    lines.push('    }');
    lines.push('    raw_html[rtot] = \'\\0\';');
    lines.push('  }');
    lines.push('  if (ssl) { SSL_free(ssl); SSL_CTX_free(ctx); } close(fd);');
    lines.push('  if (!raw_html || rtot == 0) { if (raw_html) free(raw_html); return meta_json; }');
    lines.push('  const char* body = strstr(raw_html, "\\r\\n\\r\\n"); body = body ? (body + 4) : raw_html;');
    lines.push('  char title_raw[256] = {0}, img_raw[512] = {0}, desc_raw[512] = {0};');
    lines.push('  const char* t1 = strstr(body, "<title");');
    lines.push('  if (t1) { const char* gt = strchr(t1, \'>\'); const char* t2 = gt ? strstr(gt + 1, "</title>") : NULL; if (gt && t2 && t2 > gt + 1) { size_t tl = (size_t)(t2 - gt - 1); if (tl >= sizeof(title_raw)) tl = sizeof(title_raw) - 1; memcpy(title_raw, gt + 1, tl); title_raw[tl] = \'\\0\'; } }');
    lines.push('  ppl_extract_meta_attr(body, "og:image", img_raw, sizeof(img_raw));');
    lines.push('  if (!img_raw[0]) ppl_extract_meta_attr(body, "twitter:image", img_raw, sizeof(img_raw));');
    lines.push('  ppl_extract_meta_attr(body, "og:description", desc_raw, sizeof(desc_raw));');
    lines.push('  if (!desc_raw[0]) ppl_extract_meta_attr(body, "name=\\"description\\"", desc_raw, sizeof(desc_raw));');
    lines.push('  free(raw_html);');
    lines.push('  char t_esc[512], i_esc[1024], d_esc[1024];');
    lines.push('  ppl_json_escape_into(t_esc, sizeof(t_esc), title_raw);');
    lines.push('  ppl_json_escape_into(i_esc, sizeof(i_esc), img_raw);');
    lines.push('  ppl_json_escape_into(d_esc, sizeof(d_esc), desc_raw);');
    lines.push('  snprintf(meta_json, sizeof(meta_json), "{\\"ok\\":true,\\"title\\":\\"%s\\",\\"image\\":\\"%s\\",\\"description\\":\\"%s\\",\\"engine\\":\\"Papaleguas-Native-PPL\\"}", t_esc, i_esc, d_esc);');
    lines.push('  if (strlen(raw_url) < 512) {');
    lines.push('    pthread_mutex_lock(&ppl_meta_mtx);');
    lines.push('    size_t slot = ppl_meta_next % PPL_META_CACHE_SZ; ppl_meta_next++;');
    lines.push('    snprintf(ppl_meta_cache[slot].url, sizeof(ppl_meta_cache[slot].url), "%s", raw_url);');
    lines.push('    snprintf(ppl_meta_cache[slot].json, sizeof(ppl_meta_cache[slot].json), "%s", meta_json);');
    lines.push('    ppl_meta_cache[slot].ts = time(NULL);');
    lines.push('    pthread_mutex_unlock(&ppl_meta_mtx);');
    lines.push('  }');
    lines.push('  return meta_json;');
    lines.push('}');
  }
  if (usesClientIpBlocked) {
    lines.push('static char ppl_blk_buf[65536];');
    lines.push('static time_t ppl_blk_loaded_at = 0;');
    lines.push('static pthread_mutex_t ppl_blk_mtx = PTHREAD_MUTEX_INITIALIZER;');
    lines.push('static bool ppl_net_client_ip_blocked(int64_t cli_fd, const char* raw_req) {');
    lines.push('  char ip[64] = {0};');
    lines.push('  if (raw_req) {');
    lines.push('    const char* hdrs[] = { "cf-connecting-ip:", "x-forwarded-for:" };');
    lines.push('    for (int hi = 0; hi < 2 && !ip[0]; hi++) {');
    lines.push('      size_t hlen = strlen(hdrs[hi]);');
    lines.push('      for (const char* p = raw_req; *p; p++) {');
    lines.push('        if ((p == raw_req || p[-1] == \'\\n\') && ppl_ci_prefix(p, strlen(p), hdrs[hi], hlen)) {');
    lines.push('          const char* v = p + hlen; while (*v == \' \' || *v == \'\\t\') v++;');
    lines.push('          size_t k = 0; while (v[k] && v[k] != \'\\r\' && v[k] != \'\\n\' && v[k] != \',\' && k < sizeof(ip) - 1) { ip[k] = v[k]; k++; }');
    lines.push('          ip[k] = \'\\0\'; break;');
    lines.push('        }');
    lines.push('      }');
    lines.push('    }');
    lines.push('  }');
    lines.push('  if (!ip[0] && cli_fd >= 0) {');
    lines.push('    struct sockaddr_storage ss; socklen_t sl = sizeof(ss);');
    lines.push('    if (getpeername((int)cli_fd, (struct sockaddr*)&ss, &sl) == 0 && ss.ss_family == AF_INET) {');
    lines.push('      struct sockaddr_in* s4 = (struct sockaddr_in*)&ss;');
    lines.push('      inet_ntop(AF_INET, &s4->sin_addr, ip, sizeof(ip));');
    lines.push('    }');
    lines.push('  }');
    lines.push('  if (!ip[0]) return false;');
    lines.push('  if (strcmp(ip, "127.0.0.1") == 0 || strcmp(ip, "::1") == 0 || strncmp(ip, "10.", 3) == 0 || strncmp(ip, "192.168.", 8) == 0) return false;');
    lines.push('  time_t now = time(NULL);');
    lines.push('  pthread_mutex_lock(&ppl_blk_mtx);');
    lines.push('  if (now - ppl_blk_loaded_at >= 2) {');
    lines.push('    ppl_blk_buf[0] = \'\\0\';');
    lines.push('    FILE* f = fopen("papaleguas/data/blocked_ips.json", "rb");');
    lines.push('    if (f) { size_t n = fread(ppl_blk_buf, 1, sizeof(ppl_blk_buf) - 1, f); ppl_blk_buf[n] = \'\\0\'; fclose(f); }');
    lines.push('    ppl_blk_loaded_at = now;');
    lines.push('  }');
    lines.push('  char needle[72]; snprintf(needle, sizeof(needle), "\\"%s\\"", ip);');
    lines.push('  bool blocked = (ppl_blk_buf[0] && strstr(ppl_blk_buf, needle) != NULL);');
    lines.push('  pthread_mutex_unlock(&ppl_blk_mtx);');
    lines.push('  return blocked;');
    lines.push('}');
  }
  if (usesTorAlive) {
    lines.push('static bool ppl_net_tor_alive(const char* proxy_host, uint64_t proxy_port) {');
    lines.push('  if (!proxy_host || !*proxy_host || proxy_port == 0 || proxy_port > 65535) return false;');
    lines.push('  char port_str[16]; snprintf(port_str, sizeof(port_str), "%llu", (unsigned long long)proxy_port);');
    lines.push('  struct addrinfo hints, *res = NULL; memset(&hints, 0, sizeof(hints));');
    lines.push('  hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM;');
    lines.push('  if (getaddrinfo(proxy_host, port_str, &hints, &res) != 0 || !res) return false;');
    lines.push('  int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);');
    lines.push('  if (fd < 0) { freeaddrinfo(res); return false; }');
    lines.push('  struct timeval tv; tv.tv_sec = 0; tv.tv_usec = 500000;');
    lines.push('  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));');
    lines.push('  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));');
    lines.push('  if (connect(fd, res->ai_addr, res->ai_addrlen) < 0) { close(fd); freeaddrinfo(res); return false; }');
    lines.push('  freeaddrinfo(res);');
    lines.push('  uint8_t greet[3] = { 0x05, 0x01, 0x00 };');
    lines.push('  uint8_t rep[2] = { 0, 0 };');
    lines.push('  bool ok = ppl_net_write_all(fd, (const char*)greet, 3) && (recv(fd, rep, 2, MSG_WAITALL) == 2) && rep[0] == 0x05 && rep[1] == 0x00;');
    lines.push('  close(fd);');
    lines.push('  return ok;');
    lines.push('}');
  }
  if (usesTorFetch) {
    lines.push('static const char* ppl_net_tor_fetch(const char* proxy_host, uint64_t proxy_port, const char* target_host, uint64_t target_port, const char* req_path, bool use_tls) {');
    lines.push('  static _Thread_local char tor_res[65536];');
    lines.push('  tor_res[0] = \'\\0\';');
    lines.push('  if (!proxy_host || !*proxy_host || proxy_port == 0 || proxy_port > 65535) return tor_res;');
    lines.push('  if (!target_host || !*target_host || target_port == 0 || target_port > 65535) return tor_res;');
    lines.push('  size_t hlen = strlen(target_host);');
    lines.push('  if (hlen == 0 || hlen > 255) return tor_res;');
    lines.push('  char port_str[16];');
    lines.push('  snprintf(port_str, sizeof(port_str), "%llu", (unsigned long long)proxy_port);');
    lines.push('  struct addrinfo hints, *res = NULL;');
    lines.push('  memset(&hints, 0, sizeof(hints));');
    lines.push('  hints.ai_family = AF_INET;');
    lines.push('  hints.ai_socktype = SOCK_STREAM;');
    lines.push('  if (getaddrinfo(proxy_host, port_str, &hints, &res) != 0 || !res) return tor_res;');
    lines.push('  int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);');
    lines.push('  if (fd < 0) { freeaddrinfo(res); return tor_res; }');
    lines.push('  struct timeval tv; tv.tv_sec = 8; tv.tv_usec = 0;');
    lines.push('  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));');
    lines.push('  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));');
    lines.push('  if (connect(fd, res->ai_addr, res->ai_addrlen) < 0) { close(fd); freeaddrinfo(res); return tor_res; }');
    lines.push('  freeaddrinfo(res);');
    lines.push('  uint8_t greet[3] = { 0x05, 0x01, 0x00 };');
    lines.push('  if (!ppl_net_write_all(fd, (const char*)greet, 3)) { close(fd); return tor_res; }');
    lines.push('  uint8_t g_rep[2] = { 0, 0 };');
    lines.push('  if (recv(fd, g_rep, 2, MSG_WAITALL) != 2 || g_rep[0] != 0x05 || g_rep[1] != 0x00) { close(fd); return tor_res; }');
    lines.push('  uint8_t req_pkt[270];');
    lines.push('  req_pkt[0] = 0x05; req_pkt[1] = 0x01; req_pkt[2] = 0x00; req_pkt[3] = 0x03;');
    lines.push('  req_pkt[4] = (uint8_t)hlen;');
    lines.push('  memcpy(req_pkt + 5, target_host, hlen);');
    lines.push('  req_pkt[5 + hlen] = (uint8_t)((target_port >> 8) & 0xff);');
    lines.push('  req_pkt[6 + hlen] = (uint8_t)(target_port & 0xff);');
    lines.push('  if (!ppl_net_write_all(fd, (const char*)req_pkt, 7 + hlen)) { close(fd); return tor_res; }');
    lines.push('  uint8_t c_rep[4] = { 0, 0, 0, 0 };');
    lines.push('  if (recv(fd, c_rep, 4, MSG_WAITALL) != 4 || c_rep[0] != 0x05 || c_rep[1] != 0x00) { close(fd); return tor_res; }');
    lines.push('  size_t extra = 0;');
    lines.push('  if (c_rep[3] == 0x01) extra = 6;');
    lines.push('  else if (c_rep[3] == 0x04) extra = 18;');
    lines.push('  else if (c_rep[3] == 0x03) { uint8_t alen = 0; if (recv(fd, &alen, 1, MSG_WAITALL) != 1) { close(fd); return tor_res; } extra = (size_t)alen + 2; }');
    lines.push('  if (extra > 0) { uint8_t drain[260]; if (extra > sizeof(drain) || recv(fd, drain, extra, MSG_WAITALL) != (ssize_t)extra) { close(fd); return tor_res; } }');
    lines.push('  char http_req[2048];');
    lines.push('  const char* p = (req_path && *req_path) ? req_path : "/";');
    lines.push('  int rlen = snprintf(http_req, sizeof(http_req), "GET %s HTTP/1.0\\r\\nHost: %s\\r\\nUser-Agent: Mozilla/5.0\\r\\nConnection: close\\r\\n\\r\\n", p, target_host);');
    lines.push('  if (rlen <= 0) { close(fd); return tor_res; }');
    lines.push('  size_t total = 0;');
    lines.push('  if (use_tls) {');
    lines.push('    SSL_CTX* ctx = SSL_CTX_new(TLS_client_method());');
    lines.push('    if (!ctx) { close(fd); return tor_res; }');
    lines.push('    SSL* ssl = SSL_new(ctx);');
    lines.push('    if (!ssl) { SSL_CTX_free(ctx); close(fd); return tor_res; }');
    lines.push('    SSL_set_tlsext_host_name(ssl, target_host);');
    lines.push('    SSL_set_fd(ssl, fd);');
    lines.push('    if (SSL_connect(ssl) <= 0) { SSL_free(ssl); SSL_CTX_free(ctx); close(fd); return tor_res; }');
    lines.push('    if (SSL_write(ssl, http_req, rlen) > 0) {');
    lines.push('      while (total < sizeof(tor_res) - 1) {');
    lines.push('        int n = SSL_read(ssl, tor_res + total, (int)(sizeof(tor_res) - 1 - total));');
    lines.push('        if (n <= 0) break;');
    lines.push('        total += (size_t)n;');
    lines.push('      }');
    lines.push('    }');
    lines.push('    SSL_shutdown(ssl); SSL_free(ssl); SSL_CTX_free(ctx);');
    lines.push('  } else {');
    lines.push('    if (ppl_net_write_all(fd, http_req, (size_t)rlen)) {');
    lines.push('      while (total < sizeof(tor_res) - 1) {');
    lines.push('        ssize_t n = recv(fd, tor_res + total, sizeof(tor_res) - 1 - total, 0);');
    lines.push('        if (n <= 0) break;');
    lines.push('        total += (size_t)n;');
    lines.push('      }');
    lines.push('    }');
    lines.push('  }');
    lines.push('  tor_res[total] = \'\\0\';');
    lines.push('  close(fd);');
    lines.push('  const char* body = strstr(tor_res, "\\r\\n\\r\\n");');
    lines.push('  return body ? (body + 4) : tor_res;');
    lines.push('}');
  }
  lines.push('');

  const fnReturnTypeMap = new Map();
  for (const fn of ast.functions || []) {
    fnReturnTypeMap.set(fn.name, fn.returnType || 'void');
  }

  function isFloatExpr(node, scopeTypes) {
    if (!node) return false;
    if (node.type === 'FloatLiteral') return true;
    if (node.type === 'IdentExpr') return Boolean(scopeTypes && scopeTypes.get(node.name) === 'f64');
    if (node.type === 'UnaryExpr') return isFloatExpr(node.operand, scopeTypes);
    if (node.type === 'BinaryExpr') {
      if (['==', '!=', '<', '<=', '>', '>=', 'and', 'or'].includes(node.op)) return false;
      return isFloatExpr(node.left, scopeTypes) || isFloatExpr(node.right, scopeTypes);
    }
    if (node.type === 'CallExpr') return fnReturnTypeMap.get(node.callee) === 'f64';
    return false;
  }

  function emitExpr(node, scopeTypes) {
    switch (node.type) {
      case 'IntLiteral':
        return BigInt(node.value) <= 9223372036854775807n ? `${node.value}LL` : `${node.value}ULL`;
      case 'FloatLiteral':
        return `${Number(node.value)}`;
      case 'BoolLiteral':
        return node.value ? 'true' : 'false';
      case 'StringLiteral':
        return `"${escapeCString(node.value)}"`;
      case 'IdentExpr':
        return `ppl_v_${node.name}`;
      case 'UnaryExpr': {
        const inner = emitExpr(node.operand, scopeTypes);
        if (node.op === 'not' || node.op === '!') return `(!(${inner}))`;
        if (node.op === '~') return `(~(${inner}))`;
        return `(-(${inner}))`;
      }
      case 'BinaryExpr': {
        const l = emitExpr(node.left, scopeTypes);
        const r = emitExpr(node.right, scopeTypes);
        if (node.op === 'and') return `((${l}) && (${r}))`;
        if (node.op === 'or') return `((${l}) || (${r}))`;
        if (node.op === '/') {
          if (isFloatExpr(node.left, scopeTypes) || isFloatExpr(node.right, scopeTypes)) {
            return `ppl_safe_div_f64((double)(${l}), (double)(${r}))`;
          }
          return `ppl_safe_div_u64((uint64_t)(${l}), (uint64_t)(${r}))`;
        }
        if (node.op === '%') return `ppl_safe_mod_u64((uint64_t)(${l}), (uint64_t)(${r}))`;
        return `((${l}) ${node.op} (${r}))`;
      }
      case 'CallExpr': {
        const args = node.args.map((a) => emitExpr(a, scopeTypes)).join(', ');
        if (node.callee === 'hw.cpu_cores') return `ppl_hw_cpu_cores()`;
        if (node.callee === 'hw.ram_total_mb') return `ppl_hw_ram_total_mb()`;
        if (node.callee === 'hw.ram_free_mb') return `ppl_hw_ram_free_mb()`;
        if (node.callee === 'hw.uptime_sec') return `ppl_hw_uptime_sec()`;
        if (node.callee === 'hw.monotonic_ns') return `ppl_hw_monotonic_ns()`;
        if (node.callee === 'hw.hash_fnv1a') return `ppl_hw_hash_fnv1a(${args})`;
        if (node.callee === 'str.len') return `ppl_str_len(${args})`;
        if (node.callee === 'str.is_empty') return `ppl_str_is_empty(${args})`;
        if (node.callee === 'str.contains') return `ppl_str_contains(${args})`;
        if (node.callee === 'str.starts_with') return `ppl_str_starts_with(${args})`;
        if (node.callee === 'str.starts_with_ci') return `ppl_str_starts_with_ci(${args})`;
        if (node.callee === 'str.ends_with') return `ppl_str_ends_with(${args})`;
        if (node.callee === 'str.ends_with_ci') return `ppl_str_ends_with_ci(${args})`;
        if (node.callee === 'str.equals_ci') return `ppl_str_equals_ci(${args})`;
        if (node.callee === 'str.hash_fnv1a_ci') return `ppl_str_hash_fnv1a_ci(${args})`;
        if (node.callee === 'math.pow_u64') return `ppl_math_pow_u64(${args})`;
        if (node.callee === 'math.pct_u64') return `ppl_math_pct_u64(${args})`;
        if (node.callee === 'str.index_of') return `ppl_str_index_of(${args})`;
        if (node.callee === 'str.count') return `ppl_str_count(${args})`;
        if (node.callee === 'str.is_ascii_alnum') return `ppl_str_is_ascii_alnum(${args})`;
        if (node.callee === 'str.contains_ci') return `ppl_str_contains_ci(${args})`;
        if (node.callee === 'str.to_lower') return `ppl_str_to_lower(${args})`;
        if (node.callee === 'str.to_upper') return `ppl_str_to_upper(${args})`;
        if (node.callee === 'str.trim') return `ppl_str_trim(${args})`;
        if (node.callee === 'str.slice') return `ppl_str_slice(${args})`;
        if (node.callee === 'str.replace') return `ppl_str_replace(${args})`;
        if (node.callee === 'str.eq') return `ppl_str_eq(${args})`;
        if (node.callee === 'str.concat') return `ppl_str_concat(${args})`;
        if (node.callee === 'str.from_u64') return `ppl_str_from_u64(${args})`;
        if (node.callee === 'str.levenshtein') return `ppl_str_levenshtein(${args})`;
        if (node.callee === 'str.upper_ratio_pct') return `ppl_str_upper_ratio_pct(${args})`;
        if (node.callee === 'str.strip_html') return `ppl_str_strip_html(${args})`;
        if (node.callee === 'str.fold_diacritics') return `ppl_str_fold_diacritics(${args})`;
        if (node.callee === 'net.listen') return `ppl_net_listen(${args})`;
        if (node.callee === 'net.accept') return `ppl_net_accept(${args})`;
        if (node.callee === 'net.read_req') return `ppl_net_read_req(${args})`;
        if (node.callee === 'net.req_path') return `ppl_net_req_path(${args})`;
        if (node.callee === 'net.req_method') return `ppl_net_req_method(${args})`;
        if (node.callee === 'net.req_query') return `ppl_net_req_query(${args})`;
        if (node.callee === 'net.req_body') return `ppl_net_req_body(${args})`;
        if (node.callee === 'net.send_http') return `ppl_net_send_http(${args})`;
        if (node.callee === 'net.close') return `ppl_net_close(${args})`;
        if (node.callee === 'net.spawn_handle_client') return `ppl_net_spawn_handle_client(${args})`;
        if (node.callee === 'net.send_file_safe') return `ppl_net_send_file_safe(${args})`;
        if (node.callee === 'net.serve_static') return `ppl_net_serve_static(${args})`;
        if (node.callee === 'net.http_get') return `ppl_net_http_get(${args})`;
        if (node.callee === 'net.proxy_pass') return `ppl_net_proxy_pass(${args})`;
        if (node.callee === 'net.relay_image') return `ppl_net_relay_image(${args})`;
        if (node.callee === 'net.fetch_meta') return `ppl_net_fetch_meta(${args})`;
        if (node.callee === 'net.metrics_json') return `ppl_net_metrics_json()`;
        if (node.callee === 'net.tor_fetch') return `ppl_net_tor_fetch(${args})`;
        if (node.callee === 'net.tor_alive') return `ppl_net_tor_alive(${args})`;
        if (node.callee === 'net.client_ip_blocked') return `ppl_net_client_ip_blocked(${args})`;
        if (node.callee === 'fs.read_safe') return `ppl_fs_read_safe(${args})`;
        if (node.callee === 'clamp_u64') return `ppl_clamp_u64(${args})`;
        if (node.callee === 'clamp_i64') return `ppl_clamp_i64(${args})`;
        if (node.callee === 'min_i64') return `ppl_min_i64(${args})`;
        if (node.callee === 'max_i64') return `ppl_max_i64(${args})`;
        if (node.callee === 'abs_i64') return `ppl_abs_i64(${args})`;
        if (node.callee === 'min_u64') return `ppl_min_u64(${args})`;
        if (node.callee === 'max_u64') return `ppl_max_u64(${args})`;
        return `ppl_fn_${node.callee}(${args})`;
      }
      case 'ArrayLiteral': {
        const elems = (node.elements || []).map((el) => emitExpr(el, scopeTypes)).join(', ');
        return `{ .data = { ${elems} } }`;
      }
      case 'StructLiteral': {
        const fields = (node.fields || []).map((f) => `.${f.name} = ${emitExpr(f.value, scopeTypes)}`).join(', ');
        return `(ppl_s_${node.structName}){ ${fields} }`;
      }
      case 'IndexExpr': {
        const targetCode = emitExpr(node.target, scopeTypes);
        const idxCode = emitExpr(node.index, scopeTypes);
        const targetType = node.target.type === 'IdentExpr' && scopeTypes ? scopeTypes.get(node.target.name) : null;
        const arrInfo = parseArrayType(targetType);
        const sizeExpr = arrInfo ? `${arrInfo.size}ULL` : `(sizeof((${targetCode}).data) / sizeof((${targetCode}).data[0]))`;
        return `((uint64_t)(${idxCode}) < ${sizeExpr} ? (${targetCode}).data[(uint64_t)(${idxCode})] : 0)`;
      }
      case 'MemberExpr': {
        if (node.target && node.target.type === 'IdentExpr' && enumSet.has(node.target.name)) {
          return `ppl_e_${node.target.name}_${node.field}`;
        }
        return `(${emitExpr(node.target, scopeTypes)}).${node.field}`;
      }
      default:
        return '0ULL';
    }
  }

  let loopId = 0;

  function emitBlock(block, indent, maxLoops, scopeTypes) {
    const localTypes = new Map(scopeTypes);
    for (const stmt of block.stmts || []) {
      emitStmt(stmt, indent, maxLoops, localTypes);
    }
  }

  function inferQuickType(node, scopeTypes) {
    if (!node) return 'u64';
    if (node.type === 'IntLiteral') return 'u64';
    if (node.type === 'FloatLiteral') return 'f64';
    if (node.type === 'BoolLiteral') return 'bool';
    if (node.type === 'StringLiteral') return 'str';
    if (node.type === 'StructLiteral') return node.structName;
    if (node.type === 'ArrayLiteral') {
      const el = node.elements && node.elements[0] ? inferQuickType(node.elements[0], scopeTypes) : 'u64';
      const arrType = `[${(node.elements || []).length}]${el}`;
      registerArrayType(arrType);
      return arrType;
    }
    if (node.type === 'IdentExpr' && scopeTypes && scopeTypes.has(node.name)) return scopeTypes.get(node.name);
    return 'u64';
  }

  function emitStmt(stmt, indent, maxLoops, scopeTypes) {
    const pad = '  '.repeat(indent);
    switch (stmt.type) {
      case 'LetStmt': {
        const resolvedType = stmt.varType || inferQuickType(stmt.init, scopeTypes);
        registerArrayType(resolvedType);
        scopeTypes.set(stmt.name, resolvedType);
        const cType = mapType(resolvedType, structSet);
        lines.push(`${pad}${cType} ppl_v_${stmt.name} = ${emitExpr(stmt.init, scopeTypes)};`);
        break;
      }
      case 'AssignStmt': {
        lines.push(`${pad}ppl_v_${stmt.name} = ${emitExpr(stmt.value, scopeTypes)};`);
        break;
      }
      case 'IndexAssignStmt': {
        const arrType = scopeTypes.get(stmt.name);
        const arrInfo = parseArrayType(arrType);
        const sizeExpr = arrInfo ? `${arrInfo.size}ULL` : `(sizeof(ppl_v_${stmt.name}.data) / sizeof(ppl_v_${stmt.name}.data[0]))`;
        const idxExpr = emitExpr(stmt.index, scopeTypes);
        const valExpr = emitExpr(stmt.value, scopeTypes);
        lines.push(`${pad}if ((uint64_t)(${idxExpr}) < ${sizeExpr}) { ppl_v_${stmt.name}.data[(uint64_t)(${idxExpr})] = ${valExpr}; }`);
        break;
      }
      case 'MemberAssignStmt': {
        lines.push(`${pad}ppl_v_${stmt.name}.${stmt.field} = ${emitExpr(stmt.value, scopeTypes)};`);
        break;
      }
      case 'ReturnStmt': {
        if (stmt.value) lines.push(`${pad}return ${emitExpr(stmt.value, scopeTypes)};`);
        else lines.push(`${pad}return;`);
        break;
      }
      case 'ExprStmt': {
        lines.push(`${pad}${emitExpr(stmt.expr, scopeTypes)};`);
        break;
      }
      case 'IfStmt': {
        lines.push(`${pad}if (${emitExpr(stmt.test, scopeTypes)}) {`);
        emitBlock(stmt.consequent, indent + 1, maxLoops, scopeTypes);
        if (stmt.alternate) {
          if (stmt.alternate.type === 'Block') {
            lines.push(`${pad}} else {`);
            emitBlock(stmt.alternate, indent + 1, maxLoops, scopeTypes);
            lines.push(`${pad}}`);
          } else {
            lines.push(`${pad}} else {`);
            emitStmt(stmt.alternate, indent + 1, maxLoops, scopeTypes);
            lines.push(`${pad}}`);
          }
        } else {
          lines.push(`${pad}}`);
        }
        break;
      }
      case 'WhileStmt': {
        const lid = ++loopId;
        if (maxLoops === 0) {
          lines.push(`${pad}while (${emitExpr(stmt.test, scopeTypes)}) {`);
          emitBlock(stmt.body, indent + 1, maxLoops, scopeTypes);
          lines.push(`${pad}}`);
        } else {
          lines.push(`${pad}uint64_t ppl_guard_${lid} = 0;`);
          lines.push(`${pad}while (${emitExpr(stmt.test, scopeTypes)}) {`);
          lines.push(`${pad}  if (++ppl_guard_${lid} > ${maxLoops}ULL) break;`);
          emitBlock(stmt.body, indent + 1, maxLoops, scopeTypes);
          lines.push(`${pad}}`);
        }
        break;
      }
      case 'ForStmt': {
        const lid = ++loopId;
        const loopTypes = new Map(scopeTypes);
        loopTypes.set(stmt.iter, 'u64');
        lines.push(`${pad}uint64_t ppl_end_${lid} = (uint64_t)(${emitExpr(stmt.end, scopeTypes)});`);
        lines.push(`${pad}uint64_t ppl_guard_${lid} = 0;`);
        const cmpOp = stmt.inclusive ? '<=' : '<';
        lines.push(`${pad}for (uint64_t ppl_v_${stmt.iter} = (uint64_t)(${emitExpr(stmt.start, scopeTypes)}); ppl_v_${stmt.iter} ${cmpOp} ppl_end_${lid}; ppl_v_${stmt.iter}++) {`);
        lines.push(`${pad}  if (++ppl_guard_${lid} > ${maxLoops}ULL) break;`);
        emitBlock(stmt.body, indent + 1, maxLoops, loopTypes);
        lines.push(`${pad}}`);
        break;
      }
      case 'MatchStmt': {
        const lid = ++loopId;
        const subjType = inferQuickType(stmt.subject, scopeTypes);
        const isStr = subjType === 'str';
        const cSubjType = mapType(subjType, structSet);
        lines.push(`${pad}${cSubjType} ppl_match_${lid} = ${emitExpr(stmt.subject, scopeTypes)};`);
        const arms = stmt.arms || [];
        let openedIf = false;
        let wildcardArm = null;
        for (const arm of arms) {
          if (arm.isWildcard && (!arm.patterns || arm.patterns.length === 0)) {
            wildcardArm = arm;
            continue;
          }
          const conds = (arm.patterns || []).map((pat) => {
            const pExpr = emitExpr(pat, scopeTypes);
            return isStr ? `ppl_str_eq(ppl_match_${lid}, ${pExpr})` : `(ppl_match_${lid} == (${pExpr}))`;
          });
          if (arm.isWildcard) wildcardArm = arm;
          if (conds.length > 0) {
            lines.push(`${pad}${openedIf ? '} else if' : 'if'} (${conds.join(' || ')}) {`);
            openedIf = true;
            emitBlock(arm.body, indent + 1, maxLoops, scopeTypes);
          }
        }
        if (wildcardArm) {
          if (openedIf) {
            lines.push(`${pad}} else {`);
            emitBlock(wildcardArm.body, indent + 1, maxLoops, scopeTypes);
            lines.push(`${pad}}`);
          } else {
            emitBlock(wildcardArm.body, indent, maxLoops, scopeTypes);
          }
        } else if (openedIf) {
          lines.push(`${pad}}`);
        }
        break;
      }
      case 'BreakStmt':
        lines.push(`${pad}break;`);
        break;
      case 'ContinueStmt':
        lines.push(`${pad}continue;`);
        break;
      default:
        break;
    }
  }

  // Typedefs de Structs
  for (const s of ast.structs || []) {
    lines.push('typedef struct {');
    for (const f of s.fields || []) {
      lines.push(`  ${mapType(f.fieldType, structSet)} ${f.name};`);
    }
    lines.push(`} ppl_s_${s.name};`);
    lines.push('');
  }

  // Typedefs de Arrays seguros com tamanho fixo
  for (const [arrType, info] of arrayTypeDefs.entries()) {
    lines.push(`typedef struct { ${mapType(info.elemType, structSet)} data[${info.size}]; } ${sanitizeArrayTypedefName(arrType)};`);
  }
  if (arrayTypeDefs.size) lines.push('');

  // Enums
  for (const en of ast.enums || []) {
    for (const v of en.variants || []) {
      lines.push(`__attribute__((unused)) static const uint64_t ppl_e_${en.name}_${v.name} = ${v.value}ULL;`);
    }
  }
  if ((ast.enums || []).length) lines.push('');

  // Constantes globais
  for (const c of ast.consts || []) {
    lines.push(`__attribute__((unused)) static const ${mapType(c.varType, structSet)} ppl_v_${c.name} = ${emitExpr(c.init, new Map())};`);
  }
  if ((ast.consts || []).length) lines.push('');

  // Protótipos
  for (const fn of ast.functions || []) {
    const paramsSig = fn.params.length
      ? fn.params.map((p) => `${mapType(p.paramType, structSet)} ppl_v_${p.name}`).join(', ')
      : 'void';
    lines.push(`${mapType(fn.returnType, structSet)} ppl_fn_${fn.name}(${paramsSig});`);
  }
  const hasHandleClient = (ast.functions || []).some((f) => f.name === 'handle_client' && f.params.length === 1 && f.params[0].paramType === 'i64');
  if (hasHandleClient) {
    lines.push('#define PPL_POOL_THREADS 8');
    lines.push('#define PPL_QUEUE_CAP 1024');
    lines.push('static int64_t ppl_fd_queue[PPL_QUEUE_CAP];');
    lines.push('static int ppl_q_head = 0, ppl_q_tail = 0, ppl_q_count = 0;');
    lines.push('static bool ppl_pool_started = false;');
    lines.push('static pthread_mutex_t ppl_q_mtx = PTHREAD_MUTEX_INITIALIZER;');
    lines.push('static pthread_cond_t ppl_q_cond = PTHREAD_COND_INITIALIZER;');
    lines.push('static void* ppl_pool_worker(void* arg) {');
    lines.push('  (void)arg;');
    lines.push('  while (1) {');
    lines.push('    pthread_mutex_lock(&ppl_q_mtx);');
    lines.push('    while (ppl_q_count == 0) pthread_cond_wait(&ppl_q_cond, &ppl_q_mtx);');
    lines.push('    int64_t cli = ppl_fd_queue[ppl_q_head];');
    lines.push('    ppl_q_head = (ppl_q_head + 1) % PPL_QUEUE_CAP;');
    lines.push('    ppl_q_count--;');
    lines.push('    pthread_mutex_unlock(&ppl_q_mtx);');
    lines.push('    ppl_fn_handle_client(cli);');
    lines.push('  }');
    lines.push('  return NULL;');
    lines.push('}');
    lines.push('static bool ppl_net_spawn_handle_client(int64_t cli_fd) {');
    lines.push('  if (cli_fd < 0) return false;');
    lines.push('  pthread_mutex_lock(&ppl_q_mtx);');
    lines.push('  if (!ppl_pool_started) {');
    lines.push('    ppl_pool_started = true;');
    lines.push('    pthread_attr_t attr;');
    lines.push('    pthread_attr_init(&attr);');
    lines.push('    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);');
    lines.push('    for (int i = 0; i < PPL_POOL_THREADS; i++) {');
    lines.push('      pthread_t tid;');
    lines.push('      pthread_create(&tid, &attr, ppl_pool_worker, NULL);');
    lines.push('    }');
    lines.push('    pthread_attr_destroy(&attr);');
    lines.push('  }');
    lines.push('  if (ppl_q_count >= PPL_QUEUE_CAP) {');
    lines.push('    pthread_mutex_unlock(&ppl_q_mtx);');
    lines.push('    ppl_fn_handle_client(cli_fd);');
    lines.push('    return true;');
    lines.push('  }');
    lines.push('  ppl_fd_queue[ppl_q_tail] = cli_fd;');
    lines.push('  ppl_q_tail = (ppl_q_tail + 1) % PPL_QUEUE_CAP;');
    lines.push('  ppl_q_count++;');
    lines.push('  pthread_cond_signal(&ppl_q_cond);');
    lines.push('  pthread_mutex_unlock(&ppl_q_mtx);');
    lines.push('  return true;');
    lines.push('}');
  }
  lines.push('');

  // Implementações
  for (const fn of ast.functions || []) {
    const paramsSig = fn.params.length
      ? fn.params.map((p) => `${mapType(p.paramType, structSet)} ppl_v_${p.name}`).join(', ')
      : 'void';
    const isDaemonNet = Boolean((fn.policy && fn.policy.daemon && fn.policy.allow_network) || (modulePolicy.daemon && modulePolicy.allow_network));
    const fnMaxLoops = isDaemonNet
      ? 0
      : ((fn.policy && Number(fn.policy.max_loops) > 0) ? Number(fn.policy.max_loops) : defaultMaxLoops);
    const fnTypes = new Map();
    for (const p of fn.params || []) fnTypes.set(p.name, p.paramType);
    lines.push(`${mapType(fn.returnType, structSet)} ppl_fn_${fn.name}(${paramsSig}) {`);
    emitBlock(fn.body, 1, fnMaxLoops, fnTypes);
    lines.push('}');
    lines.push('');
  }

  if (mode === 'napi') {
    for (const fn of ast.functions || []) {
      if (!fn.isExport && fn.name !== 'main') continue;
      lines.push(`static napi_value ppl_napi_${fn.name}(napi_env env, napi_callback_info info) {`);
      const pLen = fn.params.length;
      if (pLen > 0) {
        lines.push(`  size_t argc = ${pLen};`);
        lines.push(`  napi_value argv[${pLen}];`);
        lines.push('  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);');
      }
      const callArgs = [];
      for (let idx = 0; idx < pLen; idx++) {
        const p = fn.params[idx];
        if (p.paramType === 'str') {
          lines.push(`  size_t len_${idx} = 0;`);
          lines.push(`  char buf_${idx}[4096];`);
          lines.push(`  buf_${idx}[0] = '\\0';`);
          lines.push(`  if (argc > ${idx}) napi_get_value_string_utf8(env, argv[${idx}], buf_${idx}, sizeof(buf_${idx}), &len_${idx});`);
          callArgs.push(`buf_${idx}`);
        } else if (p.paramType === 'bool') {
          lines.push(`  bool arg_${idx} = false;`);
          lines.push(`  if (argc > ${idx}) napi_get_value_bool(env, argv[${idx}], &arg_${idx});`);
          callArgs.push(`arg_${idx}`);
        } else if (p.paramType === 'f64') {
          lines.push(`  double arg_${idx} = 0.0;`);
          lines.push(`  if (argc > ${idx}) napi_get_value_double(env, argv[${idx}], &arg_${idx});`);
          callArgs.push(`arg_${idx}`);
        } else if (p.paramType === 'i64') {
          lines.push(`  int64_t arg_${idx} = 0;`);
          lines.push(`  if (argc > ${idx}) napi_get_value_int64(env, argv[${idx}], &arg_${idx});`);
          callArgs.push(`arg_${idx}`);
        } else {
          lines.push(`  int64_t tmp_${idx} = 0;`);
          lines.push(`  if (argc > ${idx}) napi_get_value_int64(env, argv[${idx}], &tmp_${idx});`);
          lines.push(`  uint64_t arg_${idx} = tmp_${idx} > 0 ? (uint64_t)tmp_${idx} : 0ULL;`);
          callArgs.push(`arg_${idx}`);
        }
      }
      const callStr = `ppl_fn_${fn.name}(${callArgs.join(', ')})`;
      lines.push('  napi_value out = NULL;');
      if (fn.returnType === 'void') {
        lines.push(`  ${callStr};`);
        lines.push('  napi_get_undefined(env, &out);');
      } else if (fn.returnType === 'f64') {
        lines.push(`  double res = ${callStr};`);
        lines.push('  napi_create_double(env, res, &out);');
      } else if (fn.returnType === 'i64') {
        lines.push(`  int64_t res = ${callStr};`);
        lines.push('  napi_create_int64(env, res, &out);');
      } else if (fn.returnType === 'bool') {
        lines.push(`  bool res = ${callStr};`);
        lines.push('  napi_get_boolean(env, res, &out);');
      } else if (fn.returnType === 'str') {
        lines.push(`  const char* res = ${callStr};`);
        lines.push('  napi_create_string_utf8(env, res ? res : "", NAPI_AUTO_LENGTH, &out);');
      } else {
        lines.push(`  uint64_t res = ${callStr};`);
        lines.push('  if (res <= 9007199254740991ULL) {');
        lines.push('    napi_create_double(env, (double)res, &out);');
        lines.push('  } else {');
        lines.push('    napi_create_bigint_uint64(env, res, &out);');
        lines.push('  }');
      }
      lines.push('  return out;');
      lines.push('}');
      lines.push('');
    }

    lines.push('static napi_value ppl_napi_init(napi_env env, napi_value exports) {');
    lines.push('  napi_value fn_val;');
    for (const fn of ast.functions || []) {
      if (!fn.isExport && fn.name !== 'main') continue;
      lines.push(`  napi_create_function(env, "${fn.name}", NAPI_AUTO_LENGTH, ppl_napi_${fn.name}, NULL, &fn_val);`);
      lines.push(`  napi_set_named_property(env, exports, "${fn.name}", fn_val);`);
    }
    lines.push('  return exports;');
    lines.push('}');
    lines.push('NAPI_MODULE(NODE_GYP_MODULE_NAME, ppl_napi_init)');
    return lines.join('\n');
  }

  // Dispatcher CLI nativo para execução direta pelo runtime/agente
  lines.push('int main(int argc, char** argv) {');
  lines.push('  if (argc < 2) {');
  lines.push('    printf("{\\"ok\\":false,\\"error\\":\\"missing_fn\\"}\\n");');
  lines.push('    return 1;');
  lines.push('  }');
  lines.push('  const char* fn = argv[1];');
  for (const fn of ast.functions || []) {
    if (!fn.isExport && fn.name !== 'main') continue;
    lines.push(`  if (strcmp(fn, "${fn.name}") == 0) {`);
    const callArgs = [];
    for (let idx = 0; idx < fn.params.length; idx++) {
      const p = fn.params[idx];
      const argExpr = `(argc > ${idx + 2} ? argv[${idx + 2}] : "0")`;
      if (p.paramType === 'str') {
        callArgs.push(`(argc > ${idx + 2} ? argv[${idx + 2}] : "")`);
      } else if (p.paramType === 'f64') {
        callArgs.push(`strtod(${argExpr}, NULL)`);
      } else if (p.paramType === 'i64') {
        callArgs.push(`(int64_t)strtoll(${argExpr}, NULL, 10)`);
      } else if (p.paramType === 'bool') {
        callArgs.push(`(strcmp(${argExpr}, "true") == 0 || strcmp(${argExpr}, "1") == 0)`);
      } else {
        callArgs.push(`(uint64_t)strtoull(${argExpr}, NULL, 10)`);
      }
    }
    const callStr = `ppl_fn_${fn.name}(${callArgs.join(', ')})`;
    if (fn.returnType === 'void') {
      lines.push(`    ${callStr};`);
      lines.push('    printf("{\\"ok\\":true,\\"result\\":null}\\n");');
    } else if (fn.returnType === 'f64') {
      lines.push(`    double res = ${callStr};`);
      lines.push('    printf("{\\"ok\\":true,\\"result\\":%.6f}\\n", res);');
    } else if (fn.returnType === 'i64') {
      lines.push(`    int64_t res = ${callStr};`);
      lines.push('    printf("{\\"ok\\":true,\\"result\\":%lld}\\n", (long long)res);');
    } else if (fn.returnType === 'bool') {
      lines.push(`    bool res = ${callStr};`);
      lines.push('    printf("{\\"ok\\":true,\\"result\\":%s}\\n", res ? "true" : "false");');
    } else if (fn.returnType === 'str') {
      lines.push(`    const char* res = ${callStr};`);
      lines.push('    fputs("{\\"ok\\":true,\\"result\\":", stdout);');
      lines.push('    ppl_print_json_str(res);');
      lines.push('    fputs("}\\n", stdout);');
    } else {
      lines.push(`    uint64_t res = ${callStr};`);
      lines.push('    printf("{\\"ok\\":true,\\"result\\":%llu}\\n", (unsigned long long)res);');
    }
    lines.push('    return 0;');
    lines.push('  }');
  }
  lines.push('  printf("{\\"ok\\":false,\\"error\\":\\"unknown_fn\\"}\\n");');
  lines.push('  return 2;');
  lines.push('}');

  return lines.join('\n');
}

module.exports = { generateC };
