/**
 * Helpers modulares de parsing, filtragem e diversificação de fontes de busca.
 */
let pplRuntime = null;
try { pplRuntime = require('../papaleguas-lang/runtime'); } catch (e) {}

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
  if (!Array.isArray(items) || !Array.isArray(tokens) || tokens.length === 0) return items || [];
  const norm = typeof normalizeForMatchFn === 'function'
    ? normalizeForMatchFn
    : (s) => String(s || '').toLowerCase();
  const minimum = tokens.length >= 4 ? 2 : 1;
  const kept = items.filter((item) => {
    const text = norm((item.title || '') + ' ' + (item.snippet || '') + ' ' + (item.url || ''));
    return tokens.filter((token) => {
      if (text.includes(token)) return true;
      if (token.length >= 5 && text.includes(token.slice(0, token.length - 1))) return true;
      return false;
    }).length >= minimum;
  });
  return kept.length > 0 ? kept : items;
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

function formatVideoDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function decodeBingAttrJson(raw) {
  return String(raw || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseBingVideosHtml(html, fallbackQuery, safeHostnameFn, maxLimit = 24) {
  if (!html) return [];
  const getHost = typeof safeHostnameFn === 'function' ? safeHostnameFn : () => '';
  const items = [];
  const seen = new Set();

  const regex = /(?:vrhm|m)="({[^"]+})"/g;
  let match;
  while ((match = regex.exec(html)) !== null && items.length < maxLimit) {
    try {
      const obj = JSON.parse(decodeBingAttrJson(match[1]));
      const videoUrl = String(obj.murl || obj.purl || obj.rurl || '').trim();
      if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) continue;
      if (seen.has(videoUrl)) continue;
      seen.add(videoUrl);

      const ytMatch = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/i);
      const ytId = ytMatch ? ytMatch[1] : '';
      const thumb = obj.turl
        || (obj.thid ? `https://www.bing.com/th?id=${encodeURIComponent(obj.thid)}&w=320&h=180&c=7` : '')
        || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : '');
      if (!thumb) continue;

      const host = getHost(videoUrl) || String(obj.surl || '').replace(/^www\./i, '') || 'Web';
      const captChannel = obj.capt && obj.capt.crtnamemore
        ? String(obj.capt.crtnamemore).replace(/^Mais\s+/i, '').replace(/\s+vídeos$/i, '').trim()
        : '';
      const rawTitle = String(obj.vt || obj.t || '').replace(/^"+|"+$/g, '').trim();
      if (!rawTitle) continue;
      items.push({
        id: ytId || '',
        isYoutube: Boolean(ytId),
        title: rawTitle,
        duration: String(obj.du || '').trim(),
        channel: String(obj.pub || captChannel || obj.surl || host).trim(),
        source: host,
        host,
        views: '',
        thumbnail: thumb,
        url: videoUrl,
      });
    } catch (e) {}
  }

  return items;
}

const VIDEO_QUERY_STOPWORDS = new Set([
  'que', 'qual', 'quais', 'quem', 'como', 'onde', 'quando', 'porque', 'por', 'para', 'pra',
  'com', 'sem', 'dos', 'das', 'uma', 'uns', 'umas', 'foi', 'era', 'sao', 'ser', 'esta', 'este',
  'isso', 'mais', 'menos', 'melhor', 'melhores', 'sobre', 'the', 'and', 'for', 'voce',
  'video', 'videos', 'assistir', 'canal', 'oficial', 'hd', 'completo'
]);

function normalizeVideoMatchText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractVideoQueryTokens(query) {
  const norm = normalizeVideoMatchText(query).trim();
  if (!norm) return [];
  const rawTokens = norm
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !VIDEO_QUERY_STOPWORDS.has(w));
  if (rawTokens.length > 0) return rawTokens;
  return norm.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
}

/**
 * Filtra e ordena vídeos garantindo que pertençam estritamente ao tema pesquisado.
 * Descarta vídeos genéricos/em alta (ex.: Bing Trending via Tor) que não têm relação com a busca.
 */
function filterAndRankTopicVideos(videos, query) {
  if (!Array.isArray(videos) || videos.length === 0) return [];
  const rawNorm = normalizeVideoMatchText(query).trim();
  if (!rawNorm) return videos;

  const compactQuery = rawNorm.replace(/[^a-z0-9]+/g, '');
  const tokens = extractVideoQueryTokens(query);
  if (tokens.length === 0 && !compactQuery) return videos;

  const rankMod = pplRuntime ? pplRuntime.loadNativeModule('search_rank') : null;
  const hasNativeVideoRank = Boolean(rankMod && typeof rankMod.score_topic_video === 'function');

  const scored = [];
  const partialYoutubeFallbacks = [];

  for (let idx = 0; idx < videos.length; idx++) {
    const v = videos[idx];
    if (!v || !v.url || !v.title) continue;

    const titleNorm = normalizeVideoMatchText(v.title).trim();
    const channelNorm = normalizeVideoMatchText(v.channel || '').trim();
    if (!titleNorm || titleNorm === 'video') continue;

    const compactTitle = titleNorm.replace(/[^a-z0-9]+/g, '');
    const compactChannel = channelNorm.replace(/[^a-z0-9]+/g, '');
    const hay = `${titleNorm} ${channelNorm}`;
    const compactHay = `${compactTitle} ${compactChannel}`;

    const exactPhraseInTitle = rawNorm.length >= 3 && titleNorm.includes(rawNorm);
    const exactPhraseInChannel = rawNorm.length >= 3 && channelNorm.includes(rawNorm);
    const compactPhraseInTitle = compactQuery.length >= 3 && compactTitle.includes(compactQuery);
    const compactPhraseInChannel = compactQuery.length >= 3 && compactChannel.includes(compactQuery);
    const hasPhraseMatch = exactPhraseInTitle || exactPhraseInChannel || compactPhraseInTitle || compactPhraseInChannel;

    let matchedTokens = 0;
    let titleTokenHits = 0;
    let channelTokenHits = 0;
    let exactWordHits = 0;

    for (const tok of tokens) {
      const escapedTok = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wordRe = new RegExp(`(?:^|[^a-z0-9])${escapedTok}(?:[^a-z0-9]|$)`, 'i');
      const inTitleWord = wordRe.test(titleNorm);
      const inChannelWord = wordRe.test(channelNorm);
      const inTitleSub = inTitleWord || titleNorm.includes(tok) || (tok.length >= 4 && compactTitle.includes(tok));
      const inChannelSub = inChannelWord || channelNorm.includes(tok) || (tok.length >= 4 && compactChannel.includes(tok));
      const inStem = !inTitleSub && !inChannelSub && tok.length >= 5 && hay.includes(tok.slice(0, tok.length - 1));

      if (inTitleWord || inChannelWord || (tok.length >= 4 && (compactTitle.includes(tok) || compactChannel.includes(tok)))) exactWordHits += 1;
      if (inTitleSub) titleTokenHits += 1;
      if (inChannelSub) channelTokenHits += 1;
      if (inTitleSub || inChannelSub || inStem || (tok.length >= 4 && compactHay.includes(tok))) {
        matchedTokens += 1;
      }
    }

    const minRequired = tokens.length <= 1
      ? 1
      : (tokens.length === 2 ? 2 : Math.max(2, Math.ceil(tokens.length * 0.6)));

    const isStrictMatch = hasPhraseMatch || (tokens.length > 0 && matchedTokens >= minRequired);

    let score = 0;
    const originCode = v._origin === 'youtube' ? 1 : (v._origin === 'dailymotion' ? 2 : 3);
    if (hasNativeVideoRank) {
      try {
        score += Number(rankMod.score_topic_video(
          compactTitle,
          compactChannel,
          rawNorm,
          compactQuery,
          originCode
        )) || 0;
      } catch (e) {}
    }

    if (exactPhraseInTitle || compactPhraseInTitle) score += 55;
    if (exactPhraseInChannel || compactPhraseInChannel) score += 50;

    score += exactWordHits * 18;
    score += titleTokenHits * 14;
    score += channelTokenHits * 12;
    if (tokens.length > 0) {
      score += (matchedTokens / tokens.length) * 25;
    }
    if (!hasNativeVideoRank) {
      if (v._origin === 'youtube') score += 20;
      else if (v._origin === 'dailymotion') score += 6;
    }
    if (v.views) score += 3;
    if (v.duration) score += 2;
    score += Math.max(0, 10 - idx * 0.4);

    if (isStrictMatch) {
      scored.push({ video: v, score });
    } else if (v._origin === 'youtube' && matchedTokens >= 1 && tokens.some((t) => t.length >= 4 && hay.includes(t))) {
      partialYoutubeFallbacks.push({ video: v, score: score - 30 });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored.length >= 4 || partialYoutubeFallbacks.length === 0) {
    return scored.map((entry) => entry.video);
  }
  partialYoutubeFallbacks.sort((a, b) => b.score - a.score);
  return [...scored, ...partialYoutubeFallbacks].map((entry) => entry.video);
}

function parseDailymotionVideosJson(text, maxLimit = 12) {
  if (!text) return [];
  try {
    const json = JSON.parse(text);
    const list = Array.isArray(json && json.list) ? json.list : [];
    return list.slice(0, maxLimit).map((v) => {
      const url = String(v.url || (v.id ? `https://www.dailymotion.com/video/${v.id}` : '')).trim();
      const thumb = String(v.thumbnail_480_url || v.thumbnail_url || '').trim();
      if (!url || !thumb) return null;
      return {
        id: '',
        isYoutube: false,
        title: String(v.title || 'Vídeo Dailymotion').trim(),
        duration: formatVideoDuration(v.duration),
        channel: String(v['owner.screenname'] || 'Dailymotion').trim(),
        source: 'dailymotion.com',
        host: 'dailymotion.com',
        views: v.views_total ? `${Number(v.views_total).toLocaleString('pt-BR')} views` : '',
        thumbnail: thumb,
        url,
      };
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

module.exports = {
  parseSuggestPayload,
  filterOffTopic,
  spreadResultsByHost,
  formatVideoDuration,
  parseBingVideosHtml,
  parseDailymotionVideosJson,
  filterAndRankTopicVideos,
};
