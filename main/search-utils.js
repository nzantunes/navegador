/**
 * Utilitários de limpeza de texto e relevância do buscador Papaléguas.
 */

function normalizeSearchTokens(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !['de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'para', 'com', 'por', 'the', 'and', 'for', 'with'].includes(t));
}

/**
 * Remove restos de atributos HTML vazados (ex: `abc"> Título Real`) e entidades duplicadas.
 */
function sanitizeSearchText(raw, decodeEntitiesFn) {
  let text = String(raw || '');
  if (typeof decodeEntitiesFn === 'function') {
    text = decodeEntitiesFn(text);
    // Segunda passada para entidades duplamente codificadas (ex: &amp;amp;)
    if (/&[a-z0-9#]+;/i.test(text)) {
      text = decodeEntitiesFn(text);
    }
  }
  // Remove fragmentos de atributos HTML vazados antes de `">`
  const attrLeakIdx = text.lastIndexOf('">');
  if (attrLeakIdx !== -1) {
    const after = text.slice(attrLeakIdx + 2).trim();
    if (after.length >= 3) {
      text = after;
    } else {
      text = text.slice(0, attrLeakIdx).trim();
    }
  }
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[\s"'`<>|•·-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pontua a aderência de um resultado à consulta original do usuário.
 */
function scoreSearchRelevance(item, originalQuery) {
  if (!item || !originalQuery) return 0;
  const qNorm = String(originalQuery || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '');
  const tokens = normalizeSearchTokens(originalQuery);

  const titleNorm = String(item.title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const urlNorm = String(item.url || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const snipNorm = String(item.snippet || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  let score = 0;
  if (qNorm.length >= 4) {
    if (urlNorm.replace(/[^a-z0-9]/g, '').includes(qNorm)) score += 10;
    if (titleNorm.replace(/[^a-z0-9]/g, '').includes(qNorm)) score += 8;
    if (snipNorm.replace(/[^a-z0-9]/g, '').includes(qNorm)) score += 4;
  }

  for (const tok of tokens) {
    if (titleNorm.includes(tok)) score += 4;
    if (urlNorm.includes(tok)) score += 3;
    if (snipNorm.includes(tok)) score += 2;
  }

  return score;
}

/**
 * Calcula ajuste anti-spam/anti-SEO-farm/anti-phishing com base em relatos reais de usuários:
 * penaliza homógrafos punycode (xn--), URLs excessivamente longas/fragmentadas e clickbait,
 * e recompensa URLs raiz/oficiais limpas.
 */
function computeAntiSpamPenalty(item) {
  if (!item || !item.url) return 0;
  let adjustment = 0;
  const rawUrl = String(item.url || '');
  const rawTitle = String(item.title || '');

  try {
    const parsed = new URL(rawUrl);
    const host = (parsed.hostname || '').toLowerCase();
    const path = parsed.pathname || '/';

    // 1. Homógrafos punycode (phishing) ou IP direto na URL
    if (host.includes('xn--') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      adjustment -= 20;
    }

    // 2. Excesso de subdomínios (ex.: a.b.c.d.spam.com)
    const dotCount = (host.match(/\./g) || []).length;
    if (dotCount >= 4) adjustment -= 8;

    // 3. URLs muito longas ou com slug recheado de palavras-chave (SEO farm)
    const hyphenCount = (path.match(/-/g) || []).length;
    if (rawUrl.length > 140 || hyphenCount >= 8) {
      adjustment -= 6;
    }

    // 4. Recompensa página oficial/raiz limpa (ex.: https://site.com/ ou 1 nível)
    const segments = path.split('/').filter(Boolean);
    if (segments.length <= 1 && !parsed.search) {
      adjustment += 4;
    }
  } catch (e) {
    adjustment -= 5;
  }

  // 5. Padrões típicos de clickbait / fazenda de conteúdo SEO
  if (/(?:voc[eê]\s+n[aã]o\s+vai\s+acreditar|clique\s+aqui\s+para\s+ver|top\s+\d+\s+melhores.*\b202[4-9]\b)/i.test(rawTitle)) {
    adjustment -= 7;
  }
  const letters = rawTitle.replace(/[^a-zA-ZÀ-ÿ]/g, '');
  if (letters.length >= 12) {
    const upper = letters.replace(/[^A-ZÀ-Ý]/g, '').length;
    if (upper / letters.length > 0.75) adjustment -= 5;
  }

  return adjustment;
}

function levenshteinDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const prev = new Array(t.length + 1);
  const curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j++) prev[j] = curr[j];
  }
  return prev[t.length];
}

/**
 * Sugere correção ortográfica ("Você quis dizer...") comparando a consulta
 * com frases sugeridas e títulos do índice local sem latência extra.
 */
function suggestQueryCorrection(query, candidates) {
  const rawQ = String(query || '').trim();
  if (rawQ.length < 4 || /https?:\/\/|\.(com|org|net|gov|edu|onion)\b/i.test(rawQ)) return '';
  const norm = (s) => String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const qNorm = norm(rawQ);
  if (!qNorm || qNorm.length < 4) return '';

  let bestCandidate = '';
  let bestDist = Infinity;
  const maxAllowed = Math.max(1, Math.min(3, Math.floor(qNorm.length / 4)));

  (candidates || []).forEach((cand) => {
    const clean = String(cand || '').trim();
    if (!clean) return;
    const cNorm = norm(clean);
    if (!cNorm || cNorm === qNorm) return;
    if (Math.abs(cNorm.length - qNorm.length) > maxAllowed) return;
    const d = levenshteinDistance(qNorm, cNorm);
    if (d > 0 && d <= maxAllowed && d < bestDist) {
      bestDist = d;
      bestCandidate = clean;
    }
  });

  return bestCandidate;
}

module.exports = {
  normalizeSearchTokens,
  sanitizeSearchText,
  scoreSearchRelevance,
  computeAntiSpamPenalty,
  levenshteinDistance,
  suggestQueryCorrection
};
