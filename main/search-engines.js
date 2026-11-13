/**
 * Helpers modulares de parsing, filtragem e diversificação de fontes de busca.
 */

function parseSuggestPayload(text) {
  try {
    const data = JSON.parse(text);
    // Formato OpenSearch: ["termo", ["sugestão 1", "sugestão 2", ...]]
    const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : data;
    if (!Array.isArray(list)) return [];
    return list.map((item) => {
      if (typeof item === 'string') return item;
      return (item && (item.phrase || item.text)) || '';
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function filterOffTopic(items, tokens, normalizeForMatchFn) {
  if (!Array.isArray(items) || !Array.isArray(tokens) || tokens.length < 2) return items || [];
  const norm = typeof normalizeForMatchFn === 'function'
    ? normalizeForMatchFn
    : (s) => String(s || '').toLowerCase();
  const minimum = tokens.length >= 4 ? 2 : 1;
  const kept = items.filter((item) => {
    const text = norm((item.title || '') + ' ' + (item.snippet || ''));
    return tokens.filter((token) => text.includes(token)).length >= minimum;
  });
  return kept.length >= 3 ? kept : items;
}

function spreadResultsByHost(items, safeHostnameFn, maxPerHost = 2) {
  const counts = new Map();
  const top = [];
  const rest = [];
  const getHost = typeof safeHostnameFn === 'function' ? safeHostnameFn : () => '';
  (items || []).forEach((item) => {
    const host = item.host || getHost(item.url);
    const used = counts.get(host) || 0;
    if (used < maxPerHost) {
      counts.set(host, used + 1);
      top.push(item);
    } else {
      rest.push(item);
    }
  });
  return top.concat(rest);
}

module.exports = {
  parseSuggestPayload,
  filterOffTopic,
  spreadResultsByHost
};
